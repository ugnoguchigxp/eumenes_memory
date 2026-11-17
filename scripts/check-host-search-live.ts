/** Bounded, subscription-backed acceptance of the real partial-recall path. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLuna, MODEL } from "../examples/standalone/luna.ts";
import { initialize } from "../packages/host/src/storage.ts";
import { request, startStandalone } from "../packages/host/src/transport.ts";
import { natural } from "../packages/host/src/natural.ts";
import { assertUserState, captureRecord } from "../src/sqlite.ts";
import {
	makeSource,
	makeSpan,
	value,
} from "../src/domains/state/test/state-support.ts";

if (!process.argv.includes("--run"))
	throw Error("Use --run for up to four subscription-backed turns");
if (process.env["CODEX_API_KEY"] || process.env["OPENAI_API_KEY"])
	throw Error("File-backed Codex login required; direct API spend is disabled");

const cases = [
	{ name: "authorized", message: "味噌汁の味付けにはどの味噌を使いますか？" },
	{ name: "other-scope", message: "柚子胡椒はどこの銘柄を使いますか？" },
] as const;
const directory = mkdtempSync(join(tmpdir(), "em-live-search-"));
try {
	const profile = initialize(directory, ["personal", "work"]);
	const owner = await startStandalone(directory);
	try {
		const host = owner.host;
		const access = host.access(host.grant(profile.credential));
		const expected = await host.options.port.write((db) => {
			let target = "";
			for (let index = 0; index < 1002; index++) {
				const scope = index === 1001 ? "work" : "personal";
				const text =
					index === 0
						? "味噌汁の味付けに西京味噌を使う"
						: index === 1001
							? "柚子胡椒は青川商店の銘柄を使う"
							: "合成記録の整理と会議準備に使う資料です。".repeat(6);
				const origin = {
					namespace: "acceptance",
					kind: "message",
					id: `live-search-${index}`,
				};
				const record = captureRecord(db, {
					contractVersion: 1,
					access,
					scopeKey: scope,
					clock: { atMs: Date.now() },
					origin,
					mediaType: "text/plain",
					content: text,
					captureState: "complete",
				});
				if (record.status !== "captured")
					throw Error("Synthetic source failed");
				const source = makeSource(
					`live-search-${index}`,
					text,
					index + 1,
					record.ref,
					scope,
				);
				const result = assertUserState(db, {
					contractVersion: 1,
					access,
					scopeKey: scope,
					clock: { atMs: Date.now() },
					kind: "preference",
					subject: "self",
					semanticKey: `live-search-${index}`,
					value: value(text),
					origin: "user_confirmed",
					evidence: [makeSpan(source, text)],
					sources: [source],
				});
				if (result.status !== "applied") throw Error("Synthetic seed failed");
				if (index === 0) target = result.item.itemId;
			}
			return target;
		});
		const seeded = await request(profile, "search", {
			scopeKeys: ["personal"],
			query: "西京味噌",
		});
		const candidate = (
			seeded["items"] as
				| { itemId: string; evidenceStatus: string }[]
				| undefined
		)?.[0];
		if (
			candidate?.itemId !== expected ||
			candidate.evidenceStatus !== "current"
		)
			throw Error("Synthetic answer does not have verifiable evidence");
		const measurement = await natural(profile, "recall-size", {
			scopeKey: "personal",
			message: cases[0].message,
		});
		const size = measurement["measurement"] as
			| { itemCount?: number; fitsModelInput?: boolean }
			| undefined;
		if (size?.itemCount !== 1001 || size.fitsModelInput !== false)
			throw Error(
				"Expected 1001 authorized items above the full recall budget",
			);
		let attempts = 0;
		await withLuna(async (complete) => {
			for (const entry of cases) {
				const calls: { usage: unknown; ms: number }[] = [];
				const start = performance.now();
				const result = await natural(
					profile,
					"recall",
					{
						scopeKey: "personal",
						message: entry.message,
					},
					async (prompt, schema, task, instruction) => {
						if (++attempts > 4) throw Error("Model call cap exceeded");
						const began = performance.now();
						const result = await complete(prompt, schema, task, instruction);
						calls.push({
							usage: result.usage,
							ms: Math.round(performance.now() - began),
						});
						return result;
					},
				);
				const items = result["items"] as { itemId: string }[] | undefined;
				const coverage = result["coverage"] as
					| { complete: boolean }
					| undefined;
				const passed =
					entry.name === "authorized"
						? result.status === "found" &&
							coverage?.complete === false &&
							items?.length === 1 &&
							items[0]?.itemId === expected &&
							calls.length === 2
						: result.status === "blocked" && !result["parts"] && !items;
				console.log(
					JSON.stringify({
						model: MODEL,
						case: entry.name,
						passed,
						status: result.status,
						code: result["code"],
						elapsedMs: Math.round(performance.now() - start),
						calls,
					}),
				);
				if (!passed) process.exitCode = 1;
			}
		});
	} finally {
		await owner.close();
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
