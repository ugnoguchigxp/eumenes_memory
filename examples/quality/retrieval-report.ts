/** Reanalyze preserved outputs without model calls, rerolls, or edits to the original reports. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RecallCase } from "../experiments/one-shot-holdout/cases.ts";
import { parseEvidence } from "../standalone/support.ts";
import { score } from "../experiments/one-shot-holdout/score.ts";
import { measureRecallInput } from "../../packages/host/src/model.ts";
import { retrievalMetrics } from "./retrieval-metrics.ts";
import { sourceHash } from "../../scripts/verify.ts";

export interface EvaluationCase {
	suite: string;
	value: RecallCase;
}
export interface EvaluationResult {
	provider: string;
	suite: string;
	id: string;
	repetition: number;
	status: "passed" | "failed" | "unavailable";
	details?: unknown;
	raw?: string;
	pending?: true;
}
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Validate the executable gold, never infer or repair its meaning. */
export function validateEvaluationCases(
	cases: readonly EvaluationCase[],
): void {
	if (!Array.isArray(cases) || cases.length === 0)
		throw Error("Invalid evaluation cases");
	const keys = new Set<string>();
	for (const c of cases as readonly EvaluationCase[]) {
		const value = c?.value;
		if (
			!c ||
			typeof c.suite !== "string" ||
			!c.suite.trim() ||
			!value ||
			typeof value.id !== "string" ||
			!value.id.trim() ||
			typeof value.message !== "string" ||
			!value.message.trim() ||
			typeof value.family !== "string" ||
			!value.family.trim() ||
			!Array.isArray(value.items) ||
			!Array.isArray(value.parts) ||
			value.parts.length === 0
		)
			throw Error("Invalid evaluation case or empty gold");
		const key = JSON.stringify([c.suite, value.id]);
		if (keys.has(key)) throw Error("Duplicate evaluation case");
		keys.add(key);
		const ids = value.items.map((item) => {
			if (
				!item ||
				typeof item.itemId !== "string" ||
				!item.itemId.trim() ||
				!item.value ||
				typeof item.value.text !== "string" ||
				!["affirmed", "negated"].includes(item.value.polarity)
			)
				throw Error("Invalid evaluation item");
			return item.itemId;
		});
		if (new Set(ids).size !== ids.length)
			throw Error("Duplicate evaluation item ID");
		for (const part of value.parts) {
			if (
				!part ||
				!Array.isArray(part.requiredIds) ||
				!Array.isArray(part.allowedIds) ||
				new Set(part.allowedIds).size !== part.allowedIds.length ||
				part.allowedIds.some(
					(id) => typeof id !== "string" || !ids.includes(id),
				) ||
				part.requiredIds.some((id) => !part.allowedIds.includes(id)) ||
				(part.status === "unknown" && part.allowedIds.length !== 0)
			)
				throw Error("Invalid evaluation gold evidence");
		}
		parseEvidence(
			JSON.stringify({
				parts: value.parts.map((part) => ({
					request: value.message,
					status: part.status,
					evidenceIds: part.requiredIds,
				})),
			}),
			ids,
		);
	}
}

export function retrievalReport(
	cases: readonly EvaluationCase[],
	results: readonly EvaluationResult[],
	repetitions: number,
) {
	if (!Number.isSafeInteger(repetitions) || repetitions < 1)
		throw Error("Invalid repetitions");
	validateEvaluationCases(cases);
	if (!Array.isArray(results)) throw Error("Invalid evaluation results");
	const byKey = new Map(
		cases.map((c) => [JSON.stringify([c.suite, c.value.id]), c]),
	);
	const seen = new Set<string>();
	const observations = results.map((row) => {
		if (!row || typeof row !== "object")
			throw Error("Invalid evaluation result");
		const c = byKey.get(JSON.stringify([row.suite, row.id]));
		const key = JSON.stringify([
			row.provider,
			row.suite,
			row.id,
			row.repetition,
		]);
		if (
			!c ||
			!["openai", "claude"].includes(row.provider) ||
			seen.has(key) ||
			!Number.isSafeInteger(row.repetition) ||
			row.repetition < 0 ||
			row.repetition >= repetitions ||
			!["passed", "failed", "unavailable"].includes(row.status) ||
			(row.raw !== undefined && typeof row.raw !== "string") ||
			(row.pending !== undefined &&
				(row.pending !== true ||
					row.status !== "unavailable" ||
					row.details !== undefined))
		)
			throw Error("Invalid or duplicate result");
		seen.add(key);
		if (row.status === "unavailable") return { row, expected: c.value.parts };
		const details = row.details as { parts?: unknown } | undefined;
		const actual = parseEvidence(
			JSON.stringify({ parts: details?.parts }),
			c.value.items.map((x) => x.itemId),
		);
		const passed = score(actual, c.value.parts).passed;
		if (actual.length === 0)
			throw Error("Empty recall response violates the contract");
		if (
			row.raw !== undefined &&
			JSON.stringify(actual) !==
				JSON.stringify(
					parseEvidence(
						row.raw,
						c.value.items.map((x) => x.itemId),
					),
				)
		)
			throw Error("Saved parts disagree with raw response");
		if ((row.status === "passed") !== passed)
			throw Error("Saved status disagrees with frozen gold");
		return { row, expected: c.value.parts, actual };
	});
	const groups = ["openai", "claude"].flatMap((provider) =>
		[...new Set(cases.map((c) => c.suite))].map((suite) => {
			const rows = observations.filter(
				(o) => o.row.provider === provider && o.row.suite === suite,
			);
			return {
				provider,
				suite,
				planned: cases.filter((c) => c.suite === suite).length * repetitions,
				observed: rows.length,
				pendingCases: rows.filter((o) => o.row.pending).length,
				metrics: retrievalMetrics(rows),
			};
		}),
	);
	return {
		qualityPassed:
			groups.every((g) => g.observed === g.planned) &&
			observations.every((o) => o.row.status === "passed"),
		status: groups.every(
			(g) => g.observed === g.planned && g.metrics.unavailableCases === 0,
		)
			? "completed"
			: "incomplete",
		groups,
		casesRequiringReview: observations
			.filter((o) => o.row.status !== "passed")
			.map((o) => ({
				provider: o.row.provider,
				suite: o.row.suite,
				id: o.row.id,
				repetition: o.row.repetition,
				metrics: retrievalMetrics([o]),
			})),
		// These are archived fixtures, not a measurement of any user's store or the historical adapter.
		currentHostInputCapacity: cases.map((c) => ({
			suite: c.suite,
			id: c.value.id,
			measurement: measureRecallInput(c.value.items, c.value.message),
		})),
		repeatedTrialsAreIndependentCases: false,
		reanalysisIsNotAnUnseenHoldout: true,
	};
}

export function analyzeRetrieval(directory: string, output: string) {
	const manifestBytes = readFileSync(join(directory, "manifest.json"));
	const resultBytes = readFileSync(join(directory, "results.json"));
	const manifest = JSON.parse(manifestBytes.toString()) as {
		cases: EvaluationCase[];
		casesHash: string;
		repetitions: number;
		sourceHash: string;
	};
	if (hash(manifest.cases) !== manifest.casesHash)
		throw Error("Frozen cases changed");
	const report = {
		...retrievalReport(
			manifest.cases,
			JSON.parse(resultBytes.toString()),
			manifest.repetitions,
		),
		originalSourceHash: manifest.sourceHash,
		analysisSourceHash: sourceHash(resolve(import.meta.dir, "../..")),
		inputHashes: {
			manifest: createHash("sha256").update(manifestBytes).digest("hex"),
			results: createHash("sha256").update(resultBytes).digest("hex"),
		},
	};
	writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
	return report;
}
if (import.meta.main) {
	const [directory, output] = process.argv.slice(2);
	if (!directory || !output)
		throw Error(
			"Usage: retrieval-report.ts <frozen-run-directory> <new-report.json>",
		);
	const report = analyzeRetrieval(resolve(directory), resolve(output));
	console.log(
		JSON.stringify({ status: report.status, groups: report.groups }, null, 2),
	);
}
