/** Fixed-case provider evaluation. Outputs never change gold; failures are not regenerated. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceHash } from "../../scripts/verify.ts";
import { freshCases, regressionCases } from "./cases.ts";
import { Budget, liability } from "./budget.ts";
import { apiComplete, ApiFailure, MODELS, type Provider } from "./api.ts";
import {
	groundingInstructions,
	recallSnapshot,
} from "../standalone/retrieval.ts";
import { score } from "../experiments/one-shot-holdout/score.ts";
import type { RecallCase } from "../experiments/one-shot-holdout/cases.ts";
import {
	retrievalReport,
	validateEvaluationCases,
} from "./retrieval-report.ts";
import { acquireRunLock, saveCheckpoint } from "./checkpoint.ts";
import type { Complete } from "../standalone/protocol.ts";
const root = resolve(import.meta.dir, "../..");
const base = join(root, "verification-reports/quality-80");
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
interface Manifest {
	datasetProvenance?: string;
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
	raw?: string;
	pending?: true;
	error?: string;
}
export function freeze(directory: string): Manifest {
	mkdirSync(directory, { recursive: true });
	const release = acquireRunLock(directory, "retrieval-run.lock");
	try {
		if (
			["manifest.json", "results.json", "pilot.json"].some((name) =>
				existsSync(join(directory, name)),
			)
		)
			throw Error(
				"Frozen manifest or results already exist; use a new directory",
			);
		const cases = [
			...freshCases.map((value) => ({ suite: "fresh", value })),
			...regressionCases.map((value) => ({ suite: "regression", value })),
		];
		validateEvaluationCases(cases);
		const manifest = {
			datasetProvenance:
				"Previously evaluated synthetic cases; fresh is a historical suite name, not an unseen holdout.",
			sourceHash: sourceHash(root),
			instructionsHash: hash(groundingInstructions),
			models: MODELS,
			repetitions: 3,
			cases,
			casesHash: hash(cases),
			budgetUsd: 10,
			frozenAt: new Date().toISOString(),
		};
		saveCheckpoint(join(directory, "manifest.json"), manifest);
		return manifest;
	} finally {
		release();
	}
}
interface RunOptions {
	budgetDirectory?: string;
	completeFor?: (provider: Provider) => Complete;
}
export async function evaluate(
	directory: string,
	pilot = false,
	options: RunOptions = {},
) {
	const release = acquireRunLock(directory, "retrieval-run.lock");
	try {
		return await evaluateLocked(directory, pilot, options);
	} finally {
		release();
	}
}
async function evaluateLocked(
	directory: string,
	pilot: boolean,
	options: RunOptions,
) {
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
	const resultsPath = join(directory, pilot ? "pilot.json" : "results.json");
	const results: Result[] = existsSync(resultsPath)
		? JSON.parse(readFileSync(resultsPath, "utf8"))
		: [];
	let stopped = false,
		persistenceFailed = false;
	const save = () => {
		if (persistenceFailed) throw Error("Retrieval checkpoint failed");
		try {
			saveCheckpoint(resultsPath, results);
		} catch (error) {
			stopped = true;
			persistenceFailed = true;
			throw error;
		}
	};
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
	retrievalReport(selected, results, repetitions);
	if (results.some((row) => row.pending))
		throw Error(
			"Unconfirmed pending retrieval request; inspect ledger and API log before resuming",
		);
	if (
		results.some(
			(row) => !Number.isFinite(row.durationMs) || row.durationMs < 0,
		)
	)
		throw Error("Invalid result duration");
	const budgetDirectory = options.budgetDirectory ?? base;
	const budget = new Budget(join(budgetDirectory, "cost-ledger.json"));
	const ledger = budget.snapshot();
	if (
		ledger.blocked ||
		ledger.charges.some((charge) => charge.status === "reserved")
	)
		throw Error("API_BUDGET_EXHAUSTED_OR_UNCERTAIN");
	const providers: Provider[] = ["openai", "claude"];
	// Configuration errors must fail before another provider can start a billable request.
	const completes = new Map(
		providers.map(
			(provider) =>
				[
					provider,
					options.completeFor?.(provider) ??
						apiComplete({
							provider,
							budget,
							logPath: join(budgetDirectory, "calls.jsonl"),
							instructions: { recall: groundingInstructions },
						}),
				] as const,
		),
	);
	// Independent providers may complete in parallel; each provider's cost is reserved synchronously first.
	const workers = await Promise.allSettled(
		providers.map(async (provider) => {
			const complete = completes.get(provider)!;
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
					const row: Result = {
						provider,
						suite: c.suite,
						id: c.value.id,
						repetition,
						status: "unavailable",
						durationMs: 0,
						pending: true,
					};
					results.push(row);
					save();
					try {
						const output = await recallSnapshot(
							c.value.items,
							c.value.message,
							async (prompt, schema, task) => {
								const response = await complete(prompt, schema, task);
								row.raw = response.raw;
								save();
								return response;
							},
						);
						const grade = score(output.parts, c.value.parts);
						Object.assign(row, {
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
						if (persistenceFailed) throw e;
						const error = String(e);
						Object.assign(row, {
							status: "unavailable",
							durationMs: performance.now() - started,
							error,
						});
						if (error.includes("transport") || error.includes("HTTP"))
							transports++;
						if (
							(e instanceof ApiFailure &&
								["configuration", "persistence"].includes(e.kind)) ||
							error.includes("BUDGET") ||
							error.includes("HTTP 401") ||
							error.includes("HTTP 403") ||
							error.includes("HTTP 404") ||
							transports >= 3
						)
							stopped = true;
					}
					if (persistenceFailed) throw Error("Retrieval checkpoint failed");
					delete row.pending;
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
	const failedWorker = workers.find((worker) => worker.status === "rejected");
	if (failedWorker?.status === "rejected") throw failedWorker.reason;
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
		retrievalDiagnostics: retrievalReport(selected, results, repetitions),
		qualityPassed: !stopped && groups.every((g) => g.passed === g.planned),
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
	saveCheckpoint(
		join(directory, pilot ? "pilot-summary.json" : "summary.json"),
		report,
	);
	return report;
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
	else if (command === "pilot" || command === "run") {
		const report = await evaluate(directory, command === "pilot");
		console.log(JSON.stringify(report, null, 2));
		if (report.status !== "completed") process.exitCode = 1;
	} else
		throw Error(
			"Usage: bun examples/quality/evaluate.ts freeze|pilot|run [directory]",
		);
}
