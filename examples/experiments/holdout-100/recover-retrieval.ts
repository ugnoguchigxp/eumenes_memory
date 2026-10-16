import {
	readFileSync,
	writeFileSync,
	readdirSync,
	mkdirSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withLuna } from "../../standalone/luna.ts";
import { recallSnapshot } from "../../standalone/retrieval.ts";
import { parseEvidence } from "../../standalone/support.ts";
import { parseRecall } from "../frozen-protocol.ts";
import type { Complete, ModelResult } from "../../standalone/protocol.ts";
import type { RetrievalCase } from "./cases.ts";
const design = JSON.parse(readFileSync(process.argv[2]!, "utf8")),
	source = process.argv[3]!,
	destination = process.argv[4]!;
if (!source || !destination || source === destination)
	throw Error("Use separate source and recovery directories");
mkdirSync(destination, { recursive: true });
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const designHash = hash(design);
interface Call {
	stage: string;
	input: string;
	schema: unknown;
	raw?: string;
	usage?: ModelResult["usage"];
	ms: number;
	error?: string;
}
interface Row {
	arm: string;
	calls: Call[];
	ms: number;
	[key: string]: unknown;
}
const clients: Record<string, Complete> = {};
function wrapped(
	client: Complete,
	stage: string,
	prior: Call[],
	fresh: Call[],
): Complete {
	return async (input, schema, task) => {
		const key = hash({ stage, input, schema });
		const saved = prior.find(
			(c) =>
				c.raw &&
				!c.error &&
				hash({ stage: c.stage, input: c.input, schema: c.schema }) === key,
		);
		if (saved)
			return { raw: saved.raw!, usage: saved.usage ?? null, threadId: null };
		const c: Call = { stage, input, schema, ms: 0 };
		fresh.push(c);
		const start = performance.now();
		try {
			const r = await client(input, schema, task);
			c.raw = r.raw;
			c.usage = r.usage;
			return r;
		} catch (error) {
			c.error = String(error);
			throw error;
		} finally {
			c.ms = performance.now() - start;
		}
	};
}
const equal = (a: string[], b: string[]) =>
	JSON.stringify([...new Set(a)].sort()) ===
	JSON.stringify([...new Set(b)].sort());
async function recover(c: RetrievalCase, row: Row) {
	const fresh: Call[] = [];
	const start = performance.now();
	let ids: string[] = [],
		parts: ReturnType<typeof parseEvidence> | undefined,
		result: unknown,
		error: string | undefined;
	const call = (name: string, stage = name) =>
		wrapped(clients[name]!, stage, row.calls, fresh);
	try {
		if (row.arm === "new") {
			const r = await recallSnapshot(
				c.items,
				c.message,
				{ candidates: call("candidate"), grounding: call("grounding") },
				{ pageSize: c.pageSize },
			);
			result = r;
			parts = r.parts as ReturnType<typeof parseEvidence>;
			ids = parts.flatMap((x) => x.evidenceIds);
		} else if (row.arm === "all" || row.arm === "all-grounded") {
			const input = {
				message: c.message,
				items: c.items,
				...(row.arm === "all-grounded"
					? {
							coverage: {
								complete: true,
								scannedPages: 1,
								totalPages: 1,
								candidateCount: c.items.length,
								candidateLimit: false,
							},
						}
					: {}),
			};
			const r = await call(
				row.arm === "all-grounded" ? "grounding" : "all",
				row.arm,
			)(JSON.stringify(input), design.schemas.evidence, "recall");
			parts = parseEvidence(
				r.raw,
				c.items.map((x) => x.itemId),
			);
			ids = parts.flatMap((x) => x.evidenceIds);
		} else
			for (let offset = 0; offset < c.items.length; offset += c.pageSize) {
				const page = c.items.slice(offset, offset + c.pageSize);
				const r = await call("page")(
					JSON.stringify({ task: "recall", message: c.message, items: page }),
					design.schemas.recall,
					"recall",
				);
				const selected = parseRecall(r.raw);
				if (selected.some((id) => !page.some((x) => x.itemId === id)))
					throw Error("Out-of-page ID");
				ids.push(...selected);
			}
	} catch (e) {
		error = String(e);
	}
	const expected = c.parts.flatMap((x) => x.ids);
	return {
		...row,
		calls: [...row.calls, ...fresh],
		ids,
		parts,
		result,
		error: error ?? null,
		passed: !error && equal(ids, expected),
		partPassed: parts
			? parts.length === c.parts.length &&
				parts.every(
					(p, i) =>
						p.status === c.parts[i]!.status &&
						equal(p.evidenceIds, c.parts[i]!.ids),
				)
			: null,
		falsePositive: ids.some((id) => !expected.includes(id)),
		ms: row.ms + performance.now() - start,
		recovery: {
			originalError: row["error"],
			originalMs: row.ms,
			newCalls: fresh.length,
			reusedCalls: row.calls.filter((x) => x.raw && !x.error).length,
			reason:
				"Only missing transport responses; successful responses replayed exactly; sequential recovery after original batch completed",
			originalRowHash: hash(row),
		},
	};
}
async function run() {
	const files = readdirSync(source)
		.filter((f) => /^R\d{3}\.json$/.test(f))
		.sort();
	if (files.length !== 100) throw Error("Original batch must complete first");
	for (const file of files) {
		const report = JSON.parse(readFileSync(join(source, file), "utf8"));
		if (report.status !== "completed" || report.designHash !== designHash)
			throw Error("Incomplete/mixed original batch");
		const rows = report.rows as Row[];
		if (!rows.some((r) => r.calls.some((c) => c.error))) continue;
		if (
			rows.some((r) =>
				r.calls.some((c) => c.error && !c.error.includes("403 Forbidden")),
			)
		)
			throw Error(
				"Recovery is limited to the observed HTTP 403 transport failures",
			);
		const path = join(destination, file);
		if (existsSync(path)) {
			const saved = JSON.parse(readFileSync(path, "utf8"));
			if (saved.designHash !== designHash)
				throw Error("Recovery design mismatch");
			continue;
		}
		const c = design.retrieval.find(
			(x: RetrievalCase) => x.id === report.id,
		) as RetrievalCase;
		const updated: Row[] = [];
		for (const row of rows) {
			if (!row.calls.some((c) => c.error)) {
				updated.push(row);
				continue;
			}
			const r = await recover(c, row);
			updated.push(r);
			if (r.error && r.calls.slice(row.calls.length).some((x) => x.error)) {
				writeFileSync(
					path,
					JSON.stringify(
						{
							...report,
							status: "transport-unresolved",
							rows: updated,
							originalReportHash: hash(report),
						},
						null,
						2,
					) + "\n",
				);
				throw Error(`Recovery failed: ${report.id}/${row.arm}: ${r.error}`);
			}
		}
		writeFileSync(
			path,
			JSON.stringify(
				{ ...report, rows: updated, originalReportHash: hash(report) },
				null,
				2,
			) + "\n",
		);
		console.log(
			JSON.stringify({
				id: report.id,
				recovered: updated
					.filter((r) => r["recovery"])
					.map((r) => [r.arm, r["passed"]]),
			}),
		);
	}
}
async function connect(names: string[]): Promise<void> {
	if (!names.length) return run();
	const name = names[0]!;
	await withLuna(
		async (complete) => {
			clients[name] = complete;
			await connect(names.slice(1));
		},
		{ recall: design.instructions[name] },
	);
}
await connect(["candidate", "grounding", "page", "all"]);
