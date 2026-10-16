import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const root = process.argv[2]!;
if (!root) throw Error("Usage: analyze.ts <report-root>");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const design = read(join(root, "design-v1.json"));
const retrievalDesign = read(join(root, "design-retrieval-v2.json"));
const adjudications = existsSync(join(root, "adjudications.json"))
	? read(join(root, "adjudications.json")).overrides
	: [];
const canonicalState = (xs: Record<string, unknown>[]) =>
	JSON.stringify(
		xs
			.map((x) =>
				JSON.stringify([x["subject"], x["kind"], x["polarity"], x["text"]]),
			)
			.sort(),
	);
const stateShape = (xs: Record<string, unknown>[]) =>
	JSON.stringify(
		xs
			.map((x) => JSON.stringify([x["subject"], x["kind"], x["polarity"]]))
			.sort(),
	);
const median = (xs: number[]) => {
	const a = [...xs].sort((x, y) => x - y);
	return a.length % 2
		? a[Math.floor(a.length / 2)]!
		: (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
};
const choose = (n: number, k: number) => {
	let x = 1;
	for (let i = 1; i <= k; i++) x = (x * (n - i + 1)) / i;
	return x;
};
const signP = (wins: number, losses: number) => {
	const n = wins + losses;
	return n === 0
		? 1
		: Array.from({ length: n - wins + 1 }, (_, i) =>
				choose(n, wins + i),
			).reduce((a, b) => a + b, 0) /
				2 ** n;
};
const summary: Record<string, unknown> = {
	designHash:
		"1a630122926558578adaa96795e4086b231ce85906581309221c2b13be8a4d69",
	sourceCommit: design.sourceCommit,
	retrievalDesignHash: read(
		join(root, "design-retrieval-v2.json.manifest.json"),
	).designHash,
	criteria: design.adoption,
};
for (const phase of ["retrieval", "identity", "execution"]) {
	const directory = join(root, phase === "retrieval" ? "retrieval-v2" : phase),
		prefix = phase === "retrieval" ? "R" : phase === "identity" ? "I" : "E";
	const reports = readdirSync(directory)
		.filter((x) => new RegExp(`^${prefix}\\d{3}\\.json$`).test(x))
		.sort()
		.map((x) => {
			const original = read(join(directory, x));
			const recoveredPath = join(root, "retrieval-v2-recovery", x);
			if (phase !== "retrieval" || !existsSync(recoveredPath)) return original;
			const recovered = read(recoveredPath);
			if (recovered.originalReportHash !== hash(original))
				throw Error("Recovery source mismatch");
			for (const row of recovered.rows) {
				const prior = original.rows.find(
					(r: { arm: string }) => r.arm === row.arm,
				);
				if (!prior) throw Error("Unexpected recovery arm");
				if (row.recovery) {
					if (
						row.recovery.originalRowHash !== hash(prior) ||
						hash(row.calls.slice(0, prior.calls.length)) !== hash(prior.calls)
					)
						throw Error("Recovery changed saved calls");
				} else if (hash(row) !== hash(prior))
					throw Error("Recovery changed completed arm");
			}
			return recovered;
		});
	if (
		reports.length !== 100 ||
		reports.some(
			(x) =>
				x.status !== "completed" ||
				x.designHash !==
					(phase === "retrieval"
						? summary["retrievalDesignHash"]
						: summary["designHash"]),
		)
	)
		throw Error(`Incomplete ${phase}`);
	const verdicts: Record<string, { passed: boolean; reason: string }> = {};
	let calibration: unknown = null;
	let judgeCalls = 0,
		judgeInput = 0,
		judgeOutput = 0;
	if (phase !== "retrieval") {
		const gradingDirectory = join(directory, "grade-v2");
		const mapping = read(join(gradingDirectory, "judge-mapping.json"));
		const calibrated = read(join(gradingDirectory, "judge-calibration.json"));
		const matched = calibrated.verdicts.filter(
			(v: { id: string; passed: boolean }) =>
				v.passed === calibrated.truth[v.id],
		).length;
		if (matched !== 30 || calibrated.verdicts.length !== 30)
			throw Error("Calibration failed");
		calibration = { matched, total: 30, usage: calibrated.response.usage };
		for (const v of read(join(gradingDirectory, "exact.json")).verdicts) {
			const m = mapping.mapping[v.id];
			verdicts[`${m.file.slice(0, -5)}/${m.arm}`] = v;
		}
		for (const file of readdirSync(gradingDirectory).filter((x) =>
			/^judge-\d{3}\.json$/.test(x),
		)) {
			const batch = read(join(gradingDirectory, file));
			if (batch.designHash !== summary["designHash"])
				throw Error("Mixed judge design");
			judgeCalls++;
			judgeInput += batch.response.usage?.input_tokens ?? 0;
			judgeOutput += batch.response.usage?.output_tokens ?? 0;
			for (const v of batch.verdicts) {
				const m = mapping.mapping[v.id];
				if (!m) throw Error("Missing mapping");
				verdicts[`${m.file.slice(0, -5)}/${m.arm}`] = v;
			}
		}
	}
	const cases = reports.map((r) => ({
		id: r.id,
		family: r.family,
		message:
			phase === "retrieval"
				? retrievalDesign.retrieval.find((c: { id: string }) => c.id === r.id)
						.message
				: r.case.message,
		expectedParts:
			phase === "retrieval"
				? retrievalDesign.retrieval.find((c: { id: string }) => c.id === r.id)
						.parts
				: null,
		size: r.caseSize ?? null,
		fault: r.case?.fault ?? null,
		rows: r.rows.map((x: Record<string, unknown>) => {
			const retrievalCase =
				phase === "retrieval"
					? retrievalDesign.retrieval.find((c: { id: string }) => c.id === r.id)
					: null;
			const goldIds: string[] =
				retrievalCase?.parts.flatMap((p: { ids: string[] }) => p.ids) ?? [];
			const groundingCall = [
				...(x["calls"] as { stage: string; input: string }[]),
			]
				.reverse()
				.find((c) => c.stage === "grounding");
			const candidateIds: string[] | null = groundingCall
				? JSON.parse(groundingCall.input).items.map(
						(i: { itemId: string }) => i.itemId,
					)
				: null;
			const automaticVerdict = verdicts[`${r.id}/${x["arm"]}`];
			const review = adjudications.find(
				(a: { phase: string; id: string; arm: string }) =>
					a.phase === phase && a.id === r.id && a.arm === x["arm"],
			);
			const v = review
				? { ...automaticVerdict, passed: review.passed, reason: review.reason }
				: automaticVerdict;
			if (phase !== "retrieval" && x["structure"] && !v)
				throw Error(`Missing verdict ${r.id}/${x["arm"]}`);
			return {
				...x,
				missingEvidence:
					phase === "retrieval"
						? goldIds.some((id) => !(x["ids"] as string[]).includes(id))
						: null,
				candidateLostEvidence: candidateIds
					? goldIds.some((id) => !candidateIds.includes(id))
					: null,
				groundingFailedWithAllGold: candidateIds
					? goldIds.every((id) => candidateIds.includes(id)) && !x["passed"]
					: null,
				pass:
					phase === "retrieval"
						? Boolean(x["passed"])
						: Boolean(x["structure"] && v?.passed),
				automaticPass:
					phase === "retrieval"
						? Boolean(x["passed"])
						: Boolean(x["structure"] && automaticVerdict?.passed),
				automaticVerdict: automaticVerdict ?? null,
				adjudicated: Boolean(review),
				statePass:
					phase === "retrieval"
						? null
						: canonicalState(x["actual"] as Record<string, unknown>[]) ===
									canonicalState(x["expected"] as Record<string, unknown>[]) ||
							  v?.passed === true
							? true
							: stateShape(x["actual"] as Record<string, unknown>[]) !==
										stateShape(x["expected"] as Record<string, unknown>[]) ||
								  v?.passed === false
								? false
								: null,
				clarificationMismatch:
					phase !== "retrieval" &&
					Boolean(
						(
							x["plan"] as { clarification?: string } | undefined
						)?.clarification?.trim(),
					) !== r.case.clarify,
				semantic: v ?? null,
			};
		}),
	}));
	const names =
		phase === "retrieval"
			? ["old", "new", "all", "all-grounded"]
			: phase === "identity"
				? ["old", "new"]
				: ["old", "new", "minimal"];
	const metrics: Record<string, Record<string, number>> = {};
	for (const arm of names) {
		const rows = cases.map((c) =>
			c.rows.find((x: { arm: string }) => x.arm === arm)!,
		);
		const calls = rows.flatMap((x) => x.calls);
		const input = calls.reduce(
			(n: number, x: { usage?: { input_tokens: number } }) =>
				n + (x.usage?.input_tokens ?? 0),
			0,
		);
		const output = calls.reduce(
			(n: number, x: { usage?: { output_tokens: number } }) =>
				n + (x.usage?.output_tokens ?? 0),
			0,
		);
		metrics[arm] = {
			passed: rows.filter((x) => x.pass).length,
			automaticPassed: rows.filter((x) => x.automaticPass).length,
			stateCorrect: rows.filter((x) => x.statePass === true).length,
			stateUnknown: rows.filter((x) => x.statePass === null).length,
			clarificationMismatch: rows.filter((x) => x.clarificationMismatch).length,
			total: 100,
			inputTokens: input,
			outputTokens: output,
			totalTokens: input + output,
			cachedInputTokens: calls.reduce(
				(n: number, x: { usage?: { cached_input_tokens?: number } }) =>
					n + (x.usage?.cached_input_tokens ?? 0),
				0,
			),
			calls: calls.length,
			actualModelCalls: arm === "minimal" ? 0 : calls.length,
			transportFailures: calls.filter((x: { error?: string }) => x.error)
				.length,
			recoveredRows: rows.filter((x) => x.recovery).length,
			missingUsage: calls.filter((x: { usage?: unknown }) => !x.usage).length,
			medianMs: median(rows.map((x) => x.ms)),
			p95Ms: rows.map((x) => x.ms).sort((a, b) => a - b)[94]!,
			medianExecutionMs: median(rows.map((x) => x.executionMs ?? 0)),
			errors: rows.filter((x) => x.error).length,
			critical: rows.filter((x) => x.forgottenProtected).length,
			missingEvidence: rows.filter((x) => x.missingEvidence).length,
			candidateLostEvidence: rows.filter((x) => x.candidateLostEvidence).length,
			groundingFailedWithAllGold: rows.filter(
				(x) => x.groundingFailedWithAllGold,
			).length,
			falsePositive: rows.filter((x) => x.falsePositive).length,
			partPassed: rows.filter((x) => x.partPassed === true).length,
		};
	}
	const comparisons = [];
	for (const [baseline, candidate] of phase === "retrieval"
		? [
				["old", "new"],
				["old", "all"],
				["all", "new"],
				["old", "all-grounded"],
				["all-grounded", "new"],
				["all", "all-grounded"],
			]
		: phase === "identity"
			? [["old", "new"]]
			: [
					["old", "new"],
					["old", "minimal"],
					["minimal", "new"],
				]) {
		const a = baseline!,
			b = candidate!;
		let wins = 0,
			losses = 0,
			bothPass = 0,
			bothFail = 0,
			newCritical = 0;
		const byFamily: Record<string, { wins: number; losses: number }> = {};
		for (const c of cases) {
			const old = c.rows.find((x: { arm: string }) => x.arm === a)!,
				now = c.rows.find((x: { arm: string }) => x.arm === b)!;
			const group = (byFamily[c.family] ??= { wins: 0, losses: 0 });
			if (now.pass && !old.pass) {
				wins++;
				group.wins++;
			} else if (old.pass && !now.pass) {
				losses++;
				group.losses++;
			} else if (old.pass) bothPass++;
			else bothFail++;
			if (now.forgottenProtected && !old.forgottenProtected) newCritical++;
		}
		const familyWins = Object.values(byFamily).filter(
				(x) => x.wins > x.losses,
			).length,
			familyLosses = Object.values(byFamily).filter(
				(x) => x.losses > x.wins,
			).length;
		const p = signP(familyWins, familyLosses),
			tokenRatio = metrics[b]!["totalTokens"]! / metrics[a]!["totalTokens"]!,
			latencyRatio = metrics[b]!["medianMs"]! / metrics[a]!["medianMs"]!;
		comparisons.push({
			baseline: a,
			candidate: b,
			wins,
			losses,
			bothPass,
			bothFail,
			net: wins - losses,
			familyWins,
			familyLosses,
			familyP: p,
			newCritical,
			tokenRatio,
			latencyRatio,
			meetsPreregistered:
				wins - losses >= design.adoption.minNetGain &&
				p <= design.adoption.familySignP &&
				newCritical === 0 &&
				tokenRatio <= design.adoption.maxTokenRatio &&
				latencyRatio <= design.adoption.maxMedianLatencyRatio,
			byFamily,
		});
	}
	const bySize: Record<string, unknown> = {};
	if (phase === "retrieval")
		for (const size of [8, 24, 64, 256, 1001])
			bySize[String(size)] = Object.fromEntries(
				names.map((arm) => [
					arm,
					cases
						.filter((c) => c.size === size)
						.filter(
							(c) => c.rows.find((x: { arm: string }) => x.arm === arm)!.pass,
						).length,
				]),
			);
	const sizeCosts: Record<string, unknown> = {};
	if (phase === "retrieval")
		for (const size of [8, 24, 64, 256, 1001]) {
			sizeCosts[String(size)] = Object.fromEntries(
				names.map((arm) => {
					const rows = cases
						.filter((c) => c.size === size)
						.map((c) => c.rows.find((x: { arm: string }) => x.arm === arm)!);
					return [
						arm,
						{
							medianMs: median(rows.map((x) => x.ms)),
							totalTokens: rows
								.flatMap((x) => x.calls)
								.reduce(
									(
										n: number,
										c: {
											usage?: { input_tokens: number; output_tokens: number };
										},
									) =>
										n +
										(c.usage?.input_tokens ?? 0) +
										(c.usage?.output_tokens ?? 0),
									0,
								),
							calls: rows.reduce((n, x) => n + x.calls.length, 0),
						},
					];
				}),
			);
		}
	const compact = cases.map((c) => ({
		...c,
		rows: c.rows.map((x: Record<string, unknown>) => ({
			arm: x["arm"],
			ms: x["ms"],
			executionMs: x["executionMs"],
			recovery: x["recovery"] ?? null,
			callCount: (x["calls"] as unknown[]).length,
			parts: x["parts"],
			missingEvidence: x["missingEvidence"],
			candidateLostEvidence: x["candidateLostEvidence"],
			groundingFailedWithAllGold: x["groundingFailedWithAllGold"],
			pass: x["pass"],
			structure: x["structure"],
			semantic: x["semantic"],
			automaticPass: x["automaticPass"],
			automaticVerdict: x["automaticVerdict"],
			adjudicated: x["adjudicated"],
			statePass: x["statePass"],
			clarificationMismatch: x["clarificationMismatch"],
			error: x["error"],
			preserved: x["preserved"],
			forgottenProtected: x["forgottenProtected"],
			retryStable: x["retryStable"],
			ids: x["ids"],
			partPassed: x["partPassed"],
			actual: x["actual"],
			expected: x["expected"],
		})),
	}));
	summary[phase] = {
		metrics,
		comparisons,
		bySize,
		sizeCosts,
		judge: {
			calls: judgeCalls,
			calibration,
			inputTokens: judgeInput,
			outputTokens: judgeOutput,
		},
		cases: compact,
	};
}
const accumulate = (
	calls: {
		usage?: {
			input_tokens: number;
			output_tokens: number;
			cached_input_tokens?: number;
		};
	}[],
) => ({
	calls: calls.length,
	knownInputTokens: calls.reduce((n, c) => n + (c.usage?.input_tokens ?? 0), 0),
	knownOutputTokens: calls.reduce(
		(n, c) => n + (c.usage?.output_tokens ?? 0),
		0,
	),
	knownCachedInputTokens: calls.reduce(
		(n, c) => n + (c.usage?.cached_input_tokens ?? 0),
		0,
	),
	missingUsage: calls.filter((c) => !c.usage).length,
});
const invalidRetrievalCalls = readdirSync(join(root, "retrieval"))
	.filter((x) => /^R\d{3}\.json$/.test(x))
	.flatMap((f) =>
		read(join(root, "retrieval", f)).rows.flatMap(
			(r: { calls: unknown[] }) => r.calls,
		),
	);
const invalidJudgeCalls = readdirSync(join(root, "identity"))
	.filter((x) => /^judge-(?:\d{3}|calibration)\.json$/.test(x))
	.map((f) => read(join(root, "identity", f)).response);
summary["excludedRunCosts"] = {
	invalidRetrieval: accumulate(invalidRetrievalCalls),
	invalidGradingIncludingCalibration: accumulate(invalidJudgeCalls),
};
summary["notes"] = [
	"Synthetic 20 families x 5 domains per phase, one sample per arm; not 100 independent human conversations.",
	"Generation source frozen at 357f820; before-planning source ebbaff5. Product not tuned during evaluation.",
	"Execution minimal reuses old generation: allocated costs are equal to old, actualModelCalls is zero.",
	"Retrieval measures evidence selection, not final natural-language answer quality.",
	"HTTP 403 missing responses recovered once sequentially; existing successful responses unchanged. Failed-call usage is unknown.",
	"V1 grading and original retrieval excluded after documented measurement defects. Acceptance criteria and gold unchanged.",
	"Per-phase judge costs exclude calibration; calibration usage is included separately. Excluded-run costs are evaluation overhead, not deployment costs.",
	"Primary-agent adjudication is not independent human review. Two temporal paraphrase grading errors corrected with original verdicts retained.",
];
writeFileSync(
	join(root, "summary.json"),
	JSON.stringify(summary, null, 2) + "\n",
);
for (const phase of ["retrieval", "identity", "execution"]) {
	const s = summary[phase] as { metrics: unknown; comparisons: unknown };
	console.log(
		JSON.stringify({ phase, metrics: s.metrics, comparisons: s.comparisons }),
	);
}
