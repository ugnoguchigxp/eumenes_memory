import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RecallCase } from "./cases.ts";
import { score } from "./score.ts";
const [designPath, directory, output, frozenGenerator, recoveryDirectory] =
	process.argv.slice(2);
if (!designPath || !directory || !output)
	throw Error(
		"Usage: analyze.ts <design> <completed-directory> <summary.json> [original-freeze.ts] [recovery-directory]",
	);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const design = read(designPath),
	designHash = hash(design);
const median = (xs: number[]) => {
	const a = [...xs].sort((x, y) => x - y);
	return a.length % 2
		? a[Math.floor(a.length / 2)]!
		: (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
};
const signP = (w: number, l: number) => {
	let sum = 0;
	const n = w + l;
	for (let k = w; k <= n; k++) {
		let c = 1;
		for (let i = 1; i <= k; i++) c = (c * (n - i + 1)) / i;
		sum += c;
	}
	return sum / 2 ** n;
};
for (const [file, expected] of Object.entries(design.sourceHashes))
	if (
		createHash("sha256")
			.update(
				readFileSync(
					file === "freeze.ts" && frozenGenerator
						? frozenGenerator
						: new URL(file, import.meta.url),
				),
			)
			.digest("hex") !== expected
	)
		throw Error(`Frozen source changed: ${file}`);
if (
	createHash("sha256")
		.update(
			readFileSync(new URL("../../standalone/retrieval.ts", import.meta.url)),
		)
		.digest("hex") !== design.runtimeHash
)
	throw Error("Runtime changed");
const files = readdirSync(directory).filter((f) =>
	/^(?:H\d{3}|regression-R\d{3})\.json$/.test(f),
);
if (files.length !== 120) throw Error("Expected all 120 case reports");
const reports = files.map((f) => {
	const report = read(join(directory, f));
	if (recoveryDirectory)
		report.rows = report.rows.map(
			(prior: {
				arm: string;
				transport: boolean;
				response?: unknown;
				inputHash: string;
				schemaHash: string;
			}) => {
				const path = join(recoveryDirectory, `${report.id}-${prior.arm}.json`);
				if (!existsSync(path)) return prior;
				const recovered = read(path);
				if (
					!prior.transport ||
					prior.response ||
					recovered.designHash !== designHash ||
					recovered.id !== report.id ||
					recovered.row.recovery.originalRowHash !== hash(prior) ||
					recovered.row.inputHash !== prior.inputHash ||
					recovered.row.schemaHash !== prior.schemaHash
				)
					throw Error("Invalid recovery overlay");
				return recovered.row;
			},
		);
	return report;
});
if (new Set(reports.map((r) => r.id)).size !== 120)
	throw Error("Duplicate case reports");
const summary: Record<string, unknown> = {
	designHash,
	model: design.model,
	reasoning: design.reasoning,
	criteria: design.criteria,
	instructions: design.instructions,
	sourceHashes: design.sourceHashes,
	runtimeHash: design.runtimeHash,
};
let allComplete = true;
for (const cohort of ["holdout", "regression"]) {
	const definitions = design[cohort] as RecallCase[];
	const cases = definitions.map((c) => {
		const r = reports.find((r) => r.id === c.id);
		if (
			!r ||
			r.status !== "completed" ||
			r.designHash !== designHash ||
			r.rows.length !== 2 ||
			new Set(r.rows.map((x: { arm: string }) => x.arm)).size !== 2
		)
			throw Error(`Incomplete ${c.id}`);
		if (r.rows[0].inputHash !== r.rows[1].inputHash)
			throw Error(`Inputs differ ${c.id}`);
		const inputHash = hash(
			JSON.stringify({ message: c.message, items: c.items }),
		);
		for (const row of r.rows) {
			if (row.inputHash !== inputHash || row.schemaHash !== hash(design.schema))
				throw Error(`Input/schema differs from frozen design ${c.id}`);
			if (row.passed !== score(row.result?.parts ?? [], c.parts).passed)
				throw Error(`Score changed ${c.id}`);
			if (row.transport) allComplete = false;
		}
		const referenced = new Set([
			...c.parts.flatMap((p) => p.allowedIds),
			...r.rows.flatMap(
				(x: { result?: { parts: { evidenceIds: string[] }[] } }) =>
					x.result?.parts.flatMap((p) => p.evidenceIds) ?? [],
			),
		]);
		return {
			id: c.id,
			family: c.family,
			message: c.message,
			size: c.items.length,
			expected: c.parts,
			evidence: c.items.filter((x) => referenced.has(x.itemId)),
			rows: r.rows,
		};
	});
	const metrics: Record<string, Record<string, number>> = {};
	for (const arm of ["before", "after"]) {
		const rows = cases.map((c) =>
			c.rows.find((r: { arm: string }) => r.arm === arm)!,
		);
		const total = (key: string) =>
			rows.reduce(
				(n: number, r: { response?: { usage?: Record<string, number> } }) =>
					n + (r.response?.usage?.[key] ?? 0),
				0,
			);
		metrics[arm] = {
			passed: rows.filter((r) => r.passed).length,
			total: rows.length,
			inputTokens: total("input_tokens"),
			outputTokens: total("output_tokens"),
			cachedInputTokens: total("cached_input_tokens"),
			totalTokens: total("input_tokens") + total("output_tokens"),
			medianMs: median(rows.map((r) => r.ms)),
			p95Ms: rows.map((r) => r.ms).sort((a, b) => a - b)[
				Math.ceil(rows.length * 0.95) - 1
			]!,
			transportFailures: rows.filter((r) => r.transport).length,
			outputErrors: rows.filter((r) => r.error && !r.transport).length,
			recoveredResponses: rows.filter((r) => r.recovery).length,
			modelAttempts: rows.length + rows.filter((r) => r.recovery).length,
			missingUsage:
				rows.filter((r) => !r.response?.usage).length +
				rows.filter((r) => r.recovery?.missingOriginalUsage).length,
		};
	}
	const wins: string[] = [],
		losses: string[] = [];
	const byFamily: Record<
		string,
		{ before: number; after: number; total: number }
	> = {};
	const bySize: Record<
		string,
		{ before: number; after: number; total: number }
	> = {};
	for (const c of cases) {
		const before = c.rows.find(
				(x: { arm: string }) => x.arm === "before",
			)!.passed,
			after = c.rows.find((x: { arm: string }) => x.arm === "after")!.passed;
		if (after && !before) wins.push(c.id);
		if (before && !after) losses.push(c.id);
		for (const group of [
			(byFamily[c.family] ??= { before: 0, after: 0, total: 0 }),
			(bySize[c.size] ??= { before: 0, after: 0, total: 0 }),
		]) {
			group.before += Number(before);
			group.after += Number(after);
			group.total++;
		}
	}
	const fw = Object.values(byFamily).filter((x) => x.after > x.before).length,
		fl = Object.values(byFamily).filter((x) => x.after < x.before).length;
	summary[cohort] = {
		metrics,
		wins,
		losses,
		net: wins.length - losses.length,
		familyWins: fw,
		familyLosses: fl,
		familyP: signP(fw, fl),
		tokenRatio:
			metrics["after"]!["totalTokens"]! / metrics["before"]!["totalTokens"]!,
		latencyRatio:
			metrics["after"]!["medianMs"]! / metrics["before"]!["medianMs"]!,
		byFamily,
		bySize,
		cases,
	};
}
const h = summary["holdout"] as {
		net: number;
		familyP: number;
		tokenRatio: number;
		latencyRatio: number;
	},
	r = summary["regression"] as { net: number };
summary["meetsPreregistered"] =
	allComplete &&
	h.net >= design.criteria.minNetGain &&
	h.familyP <= design.criteria.familySignP &&
	h.tokenRatio <= design.criteria.maxTokenRatio &&
	h.latencyRatio <= design.criteria.maxMedianLatencyRatio &&
	r.net >= -design.criteria.maxNetRegressionLoss;
summary["allResponsesObtained"] = allComplete;
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(
	JSON.stringify({
		...summary,
		holdout: { ...h, cases: undefined },
		regression: { ...r, cases: undefined },
		instructions: undefined,
	}),
);
