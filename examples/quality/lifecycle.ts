/** Live proposed plans go through the real existing host/executor, then replay after restoration. */
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StandaloneHost } from "../standalone/host.ts";
import { planMemory, planningInstructions } from "../standalone/planning.ts";
import { applyMemoryPlan } from "../standalone/execution.ts";
import {
	recallMemory,
	groundingInstructions,
} from "../standalone/retrieval.ts";
import { sourceHash } from "../../scripts/verify.ts";
import { apiComplete, type Provider } from "./api.ts";
import { Budget, liability } from "./budget.ts";
const root = resolve(import.meta.dir, "../.."),
	base = join(root, "verification-reports/quality-80");
export async function lifecycle(directory: string): Promise<void> {
	const source = sourceHash(root);
	mkdirSync(directory, { recursive: true });
	const budget = new Budget(join(base, "cost-ledger.json"));
	const results = [];
	for (const provider of ["openai", "claude"] as Provider[]) {
		const dir = mkdtempSync(join(tmpdir(), "memory-live-lifecycle-"));
		let host: StandaloneHost | null = null;
		const operations = [];
		try {
			host = new StandaloneHost(dir);
			const complete = apiComplete({
				provider,
				budget,
				logPath: join(base, "calls.jsonl"),
				maxOutput: 2048,
				instructions: {
					decide: planningInstructions,
					recall: groundingInstructions,
				},
			});
			for (const [operationId, message] of [
				["remember", "私は紅茶が好きです。覚えてください。"],
				[
					"correct",
					"飲み物の好みを訂正します。今は紅茶ではなくコーヒーが好きです。",
				],
				["forget", "飲み物の好みを、その過去の版も含めて忘れてください。"],
			] as const) {
				const plan = await planMemory(host, message, complete);
				const before = host.list(true).length;
				if (operationId === "forget")
					host.snapshot(join(dir, "before-forget.db"));
				const result = applyMemoryPlan(host, operationId, plan);
				if (result.status !== "completed")
					throw Error(`Uncompleted ${operationId}: ${result.status}`);
				const after = host.list(true);
				const journal = readFileSync(host.journalPath, "utf8");
				const retry = applyMemoryPlan(host, operationId, plan);
				if (
					retry.status !== "completed" ||
					host.list(true).length !== after.length ||
					readFileSync(host.journalPath, "utf8") !== journal
				)
					throw Error("Retry changed committed state");
				if (
					operationId === "remember" &&
					after.filter((i) => i.status === "active").length !== 1
				)
					throw Error("Remember did not create exactly one active fact");
				if (
					operationId === "correct" &&
					(after.filter((i) => i.status === "active").length !== 1 ||
						after.length <= before)
				)
					throw Error("Correction did not supersede old fact");
				if (operationId === "forget" && after.length !== 0)
					throw Error("Forget left visible history");
				operations.push({ operationId, plan, result, retry, stored: after });
			}
			host.close();
			host = null;
			copyFileSync(join(dir, "before-forget.db"), join(dir, "memory.db"));
			host = new StandaloneHost(dir);
			if (host.list(true).length !== 0)
				throw Error("Restoration resurrected forgotten facts");
			const recalled = await recallMemory(
				host,
				"私の飲み物の好みは？",
				complete,
			);
			if (
				recalled.parts.some(
					(p) => p.status !== "unknown" || p.evidenceIds.length,
				)
			)
				throw Error("Forgotten preference returned");
			results.push({
				provider,
				status: "passed",
				operations,
				startup: host.startup,
				recalled,
				scope:
					"Synthetic state transitions, exact source/CAS checks and durable replay; no general Japanese accuracy claim",
			});
		} catch (e) {
			results.push({
				provider,
				status: "failed",
				operations,
				error: String(e),
			});
		} finally {
			host?.close();
			rmSync(dir, { recursive: true, force: true });
		}
		writeFileSync(
			join(directory, "lifecycle.json"),
			JSON.stringify(results, null, 2),
		);
	}
	if (sourceHash(root) !== source)
		throw Error("Source changed during live lifecycle");
	console.log(
		JSON.stringify(
			{
				results: results.map((r) => ({
					provider: r.provider,
					status: r.status,
					...("error" in r ? { error: r.error } : {}),
				})),
				costLiabilityUsd: liability(budget.snapshot()),
			},
			null,
			2,
		),
	);
	if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
}
if (import.meta.main)
	await lifecycle(
		process.argv[2] ? resolve(process.argv[2]) : join(base, "live"),
	);
