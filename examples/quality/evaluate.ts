/** Fixed-case provider evaluation. Outputs never change gold; failures are not regenerated. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceHash } from "../../scripts/verify.ts";
import { freshCases, regressionCases } from "./cases.ts";
import { Budget, liability } from "./budget.ts";
import { apiComplete, MODELS, type Provider } from "./api.ts";
import {
	groundingInstructions,
	recallSnapshot,
} from "../standalone/retrieval.ts";
import { score } from "../experiments/one-shot-holdout/score.ts";
import type { RecallCase } from "../experiments/one-shot-holdout/cases.ts";
const root = resolve(import.meta.dir, "../..");
const base = join(root, "verification-reports/quality-80");
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
interface Manifest {
	sourceHash: string;
	instructionsHash: string;
	models: typeof MODELS;
	repetitions: number;
	cases: { suite: string; value: RecallCase }[];
	casesHash: string;
	budgetUsd: number;
	frozenAt: string;
}
interface Result {
	provider: Provider;
	suite: string;
	id: string;
	repetition: number;
	status: "passed" | "failed" | "unavailable";
	durationMs: number;
	details?: unknown;
	error?: string;
}
export function freeze(directory: string): Manifest {
	mkdirSync(directory, { recursive: true });
	if (existsSync(join(directory, "manifest.json")))
		throw Error("Frozen manifest already exists");
	const cases = [
		...freshCases.map((value) => ({ suite: "fresh", value })),
		...regressionCases.map((value) => ({ suite: "regression", value })),
	];
	const manifest = {
		sourceHash: sourceHash(root),
		instructionsHash: hash(groundingInstructions),
		models: MODELS,
		repetitions: 3,
		cases,
		casesHash: hash(cases),
		budgetUsd: 10,
		frozenAt: new Date().toISOString(),
	};
	writeFileSync(
		join(directory, "manifest.json"),
		JSON.stringify(manifest, null, 2),
	);
	return manifest;
}
export async function evaluate(
	directory: string,
	pilot = false,
): Promise<void> {
	const manifest: Manifest = JSON.parse(
		readFileSync(join(directory, "manifest.json"), "utf8"),
	);
	if (
		manifest.sourceHash !== sourceHash(root) ||
		manifest.instructionsHash !== hash(groundingInstructions) ||
		manifest.casesHash !== hash(manifest.cases) ||
		JSON.stringify(manifest.models) !== JSON.stringify(MODELS)
	)
		throw Error("Runtime or frozen case manifest changed");
	const budget = new Budget(join(base, "cost-ledger.json"));
	const resultsPath = join(directory, pilot ? "pilot.json" : "results.json");
	const results: Result[] = existsSync(resultsPath)
		? JSON.parse(readFileSync(resultsPath, "utf8"))
		: [];
	const save = () =>
		writeFileSync(resultsPath, JSON.stringify(results, null, 2));
	const selectedUnsorted = pilot
		? manifest.cases
				.filter((c) => c.suite === "regression" && c.value.items.length <= 24)
				.slice(0, 12)
		: manifest.cases;
	const selected = [...selectedUnsorted].sort(
		(a, b) =>
			JSON.stringify(b.value.items).length -
			JSON.stringify(a.value.items).length,
	);
	const repetitions = pilot ? 1 : manifest.repetitions;
	let stopped = false;
	// Independent providers may complete in parallel; each provider's cost is reserved synchronously first.
	await Promise.all(
		(["openai", "claude"] as Provider[]).map(async (provider) => {
			const complete = apiComplete({
				provider,
				budget,
				logPath: join(base, "calls.jsonl"),
				instructions: { recall: groundingInstructions },
			});
			let transports = 0;
			for (const c of selected)
				for (let repetition = 0; repetition < repetitions; repetition++) {
					if (stopped) return;
					if (
						results.some(
							(r) =>
								r.provider === provider &&
								r.id === c.value.id &&
								r.suite === c.suite &&
								r.repetition === repetition,
						)
					)
						continue;
					const started = performance.now();
					try {
						const output = await recallSnapshot(
							c.value.items,
							c.value.message,
							complete,
						);
						const grade = score(output.parts, c.value.parts);
						results.push({
							provider,
							suite: c.suite,
							id: c.value.id,
							repetition,
							status: grade.passed ? "passed" : "failed",
							durationMs: performance.now() - started,
							details: {
								grade,
								parts: output.parts,
								coverage: output.coverage,
							},
						});
						transports = 0;
					} catch (e) {
						const error = String(e);
						results.push({
							provider,
							suite: c.suite,
							id: c.value.id,
							repetition,
							status: "unavailable",
							durationMs: performance.now() - started,
							error,
						});
						if (error.includes("transport") || error.includes("HTTP"))
							transports++;
						if (
							error.includes("BUDGET") ||
							error.includes("HTTP 401") ||
							error.includes("HTTP 403") ||
							error.includes("HTTP 404") ||
							transports >= 3
						)
							stopped = true;
					}
					save();
					if (results.length % 20 === 0)
						console.log(
							JSON.stringify({
								completed: results.length,
								planned: selected.length * repetitions * 2,
								costLiabilityUsd: liability(budget.snapshot()),
							}),
						);
				}
		}),
	);
	if (sourceHash(root) !== manifest.sourceHash)
		throw Error("Source changed during evaluation");
	const groups = [];
	for (const provider of ["openai", "claude"] as Provider[])
		for (const suite of new Set(selected.map((c) => c.suite))) {
			const rows = results.filter(
				(r) => r.provider === provider && r.suite === suite,
			);
			const times = rows.map((r) => r.durationMs).sort((a, b) => a - b);
			groups.push({
				provider,
				suite,
				completed: rows.length,
				planned: selected.filter((c) => c.suite === suite).length * repetitions,
				passed: rows.filter((r) => r.status === "passed").length,
				failed: rows.filter((r) => r.status === "failed").length,
				unavailable: rows.filter((r) => r.status === "unavailable").length,
				p50Ms: times[Math.ceil(times.length * 0.5) - 1] ?? null,
				p95Ms: times[Math.ceil(times.length * 0.95) - 1] ?? null,
			});
		}
	const report = {
		status:
			stopped || groups.some((g) => g.completed !== g.planned || g.unavailable)
				? "incomplete"
				: "completed",
		sourceHash: manifest.sourceHash,
		casesHash: manifest.casesHash,
		groups,
		costLiabilityUsd: liability(budget.snapshot()),
		repetitionsAreIndependentCases: false,
		unchangedPromptsNotPairedAsDifferentArms: true,
		semanticFailuresAreNotSuccess: true,
	};
	writeFileSync(
		join(directory, pilot ? "pilot-summary.json" : "summary.json"),
		JSON.stringify(report, null, 2),
	);
	console.log(JSON.stringify(report, null, 2));
	if (report.status !== "completed") process.exitCode = 1;
}
if (import.meta.main) {
	const [command, output] = process.argv.slice(2),
		directory = output ? resolve(output) : join(base, "live");
	if (command === "freeze")
		console.log(
			JSON.stringify(
				{ ...freeze(directory), cases: "saved to manifest" },
				null,
				2,
			),
		);
	else if (command === "pilot" || command === "run")
		await evaluate(directory, command === "pilot");
	else
		throw Error(
			"Usage: bun examples/quality/evaluate.ts freeze|pilot|run [directory]",
		);
}
