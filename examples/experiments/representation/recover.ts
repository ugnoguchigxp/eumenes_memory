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
import { recallSnapshot } from "./baseline.ts";
import { recallSnapshot as candidate } from "./candidate.ts";
import type { ModelResult } from "../../standalone/protocol.ts";
import type { RecallCase } from "../evidence-followup/cases.ts";
import { score } from "../evidence-followup/score.ts";
const [designPath, source, destination] = process.argv.slice(2);
if (!designPath || !source || !destination || existsSync(destination))
	throw Error(
		"Usage: recover.ts <design> <completed-original> <new-recovery-directory>",
	);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const design = read(designPath),
	designHash = hash(design);
if (
	createHash("sha256")
		.update(
			readFileSync(new URL("../../standalone/retrieval.ts", import.meta.url)),
		)
		.digest("hex") !== design.runtimeHash
)
	throw Error("Runtime changed");
for (const [file, expected] of Object.entries(design.sourceHashes))
	if (
		createHash("sha256")
			.update(readFileSync(new URL(file, import.meta.url)))
			.digest("hex") !== expected
	)
		throw Error(`Frozen source changed: ${file}`);
const reports = readdirSync(source)
	.filter((f) => /^(?:H\d{3}|regression-R\d{3})\.json$/.test(f))
	.sort()
	.map((f) => read(join(source, f)));
if (
	reports.length !== design.holdout.length + design.regression.length ||
	reports.some(
		(r) =>
			r.status !== "completed" ||
			r.rows.length !== 2 ||
			r.designHash !== designHash,
	)
)
	throw Error("Original batch must complete first");
mkdirSync(destination, { recursive: true });
for (const r of reports)
	for (const prior of r.rows) {
		if (!prior.transport) continue;
		if (prior.response || !prior.error?.includes("403 Forbidden"))
			throw Error("Recovery restricted to missing HTTP 403 response");
		const c = ([...design.holdout, ...design.regression] as RecallCase[]).find(
			(c) => c.id === r.id,
		)!;
		let response: ModelResult | undefined,
			result: Awaited<ReturnType<typeof recallSnapshot>> | undefined,
			error: string | undefined,
			transport = false;
		const start = performance.now();
		try {
			await withLuna(
				async (complete) => {
					result = await (prior.arm === "before" ? recallSnapshot : candidate)(
						c.items,
						c.message,
						async (input, schema, task) => {
							if (
								hash(input) !== prior.inputHash ||
								hash(schema) !== prior.schemaHash
							)
								throw Error("Recovery input/schema changed");
							try {
								response = await complete(input, schema, task);
								return response;
							} catch (e) {
								transport = true;
								throw e;
							}
						},
					);
				},
				{ recall: design.instructions[prior.arm] },
			);
		} catch (e) {
			error = String(e);
		}
		const recovered = {
			...prior,
			response,
			result,
			error: error ?? null,
			transport,
			ms: prior.ms + performance.now() - start,
			...score(result?.parts ?? [], c.parts),
			recovery: {
				originalRowHash: hash(prior),
				originalError: prior.error,
				originalMs: prior.ms,
				missingOriginalUsage: true,
				attempts: 1,
			},
		};
		writeFileSync(
			join(destination, `${r.id}-${prior.arm}.json`),
			JSON.stringify({ designHash, id: r.id, row: recovered }, null, 2) + "\n",
		);
		console.log(
			JSON.stringify({
				id: r.id,
				arm: prior.arm,
				passed: recovered.passed,
				transport,
			}),
		);
		if (transport) throw Error("Recovery transport failed; no further retries");
	}
