/**
 * 評価の実行本体。`prepareExtraction` → アダプター → `settleExtraction` を使い捨ての実 SQLite 上で回し、
 * カテゴリ別の指標を集計する。時刻・乱数・ネットワークを使わない（同じ入力・同じアダプターなら同じ結果）。
 * 結果の形は `eval/results/SCHEMA.md`。
 */
import { createHash } from "node:crypto";
import { candidateIdOf, parseExtractionOutput, runIdOf } from "eumenes-memory";
import type {
	AdmissionPolicy,
	ExtractionInput,
	SourceState,
} from "eumenes-memory";
import {
	listCandidates,
	prepareExtraction,
	settleExtraction,
} from "eumenes-memory/sqlite";
import { openTestStore } from "../../test/support/store.ts";
import { DATASET_ID } from "./dataset.ts";
import {
	addCounts,
	scoreCase,
	toMetrics,
	worstMetrics,
	zeroCounts,
} from "./score.ts";
import type { CaseRun, Decision } from "./score.ts";
import { CATEGORIES } from "./types.ts";
import type {
	Category,
	EvalAdapter,
	EvalCase,
	Metrics,
	Split,
	ThresholdsFile,
} from "./types.ts";

export const RESULT_SCHEMA_VERSION = 1;
/** 設計書 §6.4(b): 各カテゴリ dev / test それぞれ 15 件以上。 */
export const DESIGN_TARGET_PER_SPLIT = 15;
const PRINCIPAL = "eval:principal";

/**
 * 評価時の採用方針。全 self kind を `auto_admit` にした最悪ケース（誤採用を測るため）。
 * `other_person_note` は parse の制約で `auto_admit` にできない。
 */
export const EVAL_POLICY: AdmissionPolicy = Object.freeze({
	preference: "auto_admit",
	personal_fact: "auto_admit",
	constraint: "auto_admit",
	habit: "auto_admit",
	other_person_note: "user_confirm",
});

export interface RunOptions {
	readonly name: string;
	readonly cases: readonly EvalCase[];
	readonly datasetSha256: string;
	readonly datasetPath: string;
	readonly adapter: EvalAdapter;
	readonly adapterPath: string;
	readonly repeats: number;
	readonly split: Split | "all";
	readonly timeoutMs: number;
	readonly thresholds?: ThresholdsFile;
	readonly thresholdsPath?: string;
	readonly thresholdsSha256?: string;
}

export interface MetricsSummary {
	readonly worst: Metrics;
	readonly perRepeat: readonly Metrics[];
}

export interface CaseReportRun {
	readonly outcome: "applied" | "adapter_failed" | "rejected_output";
	readonly emitted: number;
	readonly flags: readonly string[];
}

export interface CaseReport {
	readonly id: string;
	readonly category: Category;
	readonly split: Split;
	readonly runs: readonly CaseReportRun[];
}

export interface ThresholdFailure {
	readonly scope: string;
	readonly metric: string;
	readonly value: number;
	readonly bound: { readonly min?: number; readonly max?: number };
}

export interface EvalReport {
	readonly schemaVersion: typeof RESULT_SCHEMA_VERSION;
	readonly name: string;
	readonly dataset: {
		readonly id: string;
		readonly path: string;
		readonly sha256: string;
		readonly split: Split | "all";
		readonly cases: number;
		readonly casesPerCategory: Readonly<Record<string, number>>;
		readonly humanReviewed: boolean;
	};
	readonly adapter: {
		readonly path: string;
		readonly extractorId: string;
		readonly promptVersion: string;
		readonly providerRef: string;
		readonly modelId: string | null;
		readonly stub: boolean;
	};
	readonly run: {
		readonly repeats: number;
		readonly timeoutMs: number;
		readonly policy: AdmissionPolicy;
	};
	readonly claims: {
		/** 常に false になりうる。true は、実モデル・人手確認済み・承認済み閾値・3 回以上・設計の件数をすべて満たす場合のみ。 */
		readonly eStageEligible: boolean;
		readonly reasons: readonly string[];
	};
	readonly thresholds: null | {
		readonly path: string;
		readonly sha256: string;
		readonly version: string;
		readonly status: "proposal" | "approved";
		readonly decidedBy: string | null;
		readonly decidedAt: string | null;
		readonly pass: boolean;
		readonly failures: readonly ThresholdFailure[];
	};
	readonly overall: MetricsSummary;
	readonly categories: Readonly<Record<string, MetricsSummary>>;
	readonly cases: readonly CaseReport[];
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function sourceState(
	evalCase: EvalCase,
	index: number,
	scopeKey: string,
): SourceState & { readonly content: string } {
	const content = evalCase.sources[index]?.content ?? "";
	const digest = sha256Text(content);
	return {
		namespace: "conversation",
		kind: "message",
		id: `${evalCase.id}:m${index}`,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: PRINCIPAL,
		scopeKey,
		status: "available",
		content,
	};
}

async function callAdapter(
	adapter: EvalAdapter,
	input: ExtractionInput,
	timeoutMs: number,
): Promise<
	{ readonly ok: true; readonly value: unknown } | { readonly ok: false }
> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("adapter timeout"));
		}, timeoutMs);
	});
	try {
		const value = await Promise.race([
			adapter.extract(input, controller.signal),
			timeout,
		]);
		return { ok: true, value };
	} catch {
		return { ok: false };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

type Store = ReturnType<typeof openTestStore>;

async function runOne(
	store: Store,
	options: RunOptions,
	evalCase: EvalCase,
	repeat: number,
): Promise<CaseRun> {
	const scopeKey = `scope:${evalCase.id}:r${repeat}`;
	const access = {
		principal: PRINCIPAL,
		scopeKeys: [scopeKey],
		purpose: "eval",
		policyRevision: "1",
	};
	const run = { jobId: `eval:${evalCase.id}`, attempt: repeat + 1 };
	const states = evalCase.sources.map((_, index) =>
		sourceState(evalCase, index, scopeKey),
	);
	const prepared = store.write((db) =>
		prepareExtraction(db, {
			contractVersion: 1,
			access,
			scopeKey,
			clock: { atMs: 10 },
			run,
			enabled: true,
			sources: states.map((state, index) => ({
				...state,
				ordinal: index,
				role: evalCase.sources[index]?.role ?? "user",
			})),
			profile: {
				extractorId: options.adapter.extractorId,
				promptVersion: options.adapter.promptVersion,
				providerRef: options.adapter.providerRef,
			},
			maxInputBytes: 65536,
		}),
	);
	if (prepared.status !== "ready") {
		throw new Error(
			`prepare did not return ready for ${evalCase.id}: ${prepared.status}`,
		);
	}
	const called = await callAdapter(
		options.adapter,
		prepared.input,
		options.timeoutMs,
	);
	if (!called.ok) return { kind: "adapter_failed" };
	const settled = store.write((db) =>
		settleExtraction(db, {
			contractVersion: 1,
			access,
			scopeKey,
			clock: { atMs: 20 },
			run,
			output: called.value,
			currentSources: states,
			policy: EVAL_POLICY,
		}),
	);
	if (settled.status === "rejected_output") return { kind: "rejected_output" };
	if (settled.status !== "applied") {
		throw new Error(
			`settle returned ${settled.status} for ${evalCase.id} (evaluation bug)`,
		);
	}
	const parsed = parseExtractionOutput(called.value);
	if (!parsed.ok)
		throw new Error(`settled output failed to parse: ${evalCase.id}`);
	const output = parsed.output;
	const runId = runIdOf(run);
	const idToIndex = new Map<string, number>();
	for (const index of output.candidates.keys()) {
		idToIndex.set(candidateIdOf(runId, index), index);
	}
	const decisions = new Map<number, Decision>();
	for (const decision of ["admitted", "pending_user", "rejected"] as const) {
		const listed = store.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access,
				scopeKey,
				decision,
				limit: 100,
			}),
		);
		if (listed.status !== "ok") throw new Error("listCandidates blocked");
		for (const candidate of listed.candidates) {
			const index = idToIndex.get(candidate.candidateId);
			if (index !== undefined) decisions.set(index, decision);
		}
	}
	return {
		kind: "applied",
		output,
		counts: {
			admitted: settled.admitted,
			pendingUser: settled.pendingUser,
			rejected: settled.rejected,
		},
		decisions,
	};
}

function summarize(perRepeat: readonly Metrics[]): MetricsSummary {
	return { worst: worstMetrics(perRepeat), perRepeat };
}

function evaluateThresholds(
	thresholds: ThresholdsFile,
	overall: Metrics,
	categories: Readonly<Record<string, Metrics>>,
): readonly ThresholdFailure[] {
	const failures: ThresholdFailure[] = [];
	const check = (
		scope: string,
		metrics: Metrics,
		bounds: ThresholdsFile["overall"],
	) => {
		for (const [metric, bound] of Object.entries(bounds)) {
			if (bound === undefined) continue;
			const value = (metrics as unknown as Record<string, number | null>)[
				metric
			];
			if (value === null || value === undefined) continue;
			if (
				(bound.min !== undefined && value < bound.min) ||
				(bound.max !== undefined && value > bound.max)
			) {
				failures.push({ scope, metric, value, bound });
			}
		}
	};
	check("overall", overall, thresholds.overall);
	for (const category of CATEGORIES) {
		const bounds = thresholds.categories[category];
		const metrics = categories[category];
		if (bounds !== undefined && metrics !== undefined) {
			check(category, metrics, bounds);
		}
	}
	return failures;
}

function claims(
	options: RunOptions,
	cases: readonly EvalCase[],
): EvalReport["claims"] {
	const reasons: string[] = [];
	if (options.adapter.stub === true) {
		reasons.push("stub adapter: pipeline self-check only, no model was used");
	}
	if (!cases.every((evalCase) => evalCase.humanReviewed)) {
		reasons.push("gold is not human reviewed (results are provisional)");
	}
	if (options.thresholds?.status !== "approved") {
		reasons.push("no approved thresholds were recorded with this run");
	}
	if (options.repeats < 3) {
		reasons.push("fewer than 3 repeats (design asks for the worst of 3)");
	}
	if (options.split !== "test") {
		reasons.push(
			"split is not test (adoption evidence must use the test split)",
		);
	}
	const short: string[] = [];
	for (const category of CATEGORIES) {
		for (const split of ["dev", "test"] as const) {
			const count = options.cases.filter(
				(evalCase) =>
					evalCase.category === category && evalCase.split === split,
			).length;
			if (count < DESIGN_TARGET_PER_SPLIT)
				short.push(`${category}/${split}=${count}`);
		}
	}
	if (short.length > 0) {
		reasons.push(
			`dataset below the design target (${DESIGN_TARGET_PER_SPLIT} per category per split) in ${short.length} category/split pairs, e.g. ${short.slice(0, 3).join(", ")}`,
		);
	}
	return { eStageEligible: reasons.length === 0, reasons };
}

export async function runEval(options: RunOptions): Promise<EvalReport> {
	const selected = options.cases.filter(
		(evalCase) => options.split === "all" || evalCase.split === options.split,
	);
	if (selected.length === 0) throw new Error("no cases selected");
	if (!Number.isInteger(options.repeats) || options.repeats < 1) {
		throw new Error("repeats must be a positive integer");
	}
	const store = openTestStore();
	const caseReports: CaseReport[] = [];
	const countsByRepeat: Record<string, ReturnType<typeof zeroCounts>[]> = {};
	const overallByRepeat: ReturnType<typeof zeroCounts>[] = Array.from(
		{ length: options.repeats },
		() => zeroCounts(),
	);
	try {
		for (const evalCase of selected) {
			const runs: CaseReportRun[] = [];
			const perCategory = (countsByRepeat[evalCase.category] ??= Array.from(
				{ length: options.repeats },
				() => zeroCounts(),
			));
			for (let repeat = 0; repeat < options.repeats; repeat += 1) {
				const caseRun = await runOne(store, options, evalCase, repeat);
				const score = scoreCase(evalCase, caseRun);
				perCategory[repeat] = addCounts(
					perCategory[repeat] ?? zeroCounts(),
					score.counts,
				);
				overallByRepeat[repeat] = addCounts(
					overallByRepeat[repeat] ?? zeroCounts(),
					score.counts,
				);
				runs.push({
					outcome: caseRun.kind,
					emitted:
						caseRun.kind === "applied" ? caseRun.output.candidates.length : 0,
					flags: score.flags,
				});
			}
			caseReports.push({
				id: evalCase.id,
				category: evalCase.category,
				split: evalCase.split,
				runs,
			});
		}
	} finally {
		store.close();
	}

	const overall = summarize(overallByRepeat.map(toMetrics));
	const categories: Record<string, MetricsSummary> = {};
	for (const category of CATEGORIES) {
		const list = countsByRepeat[category];
		if (list !== undefined)
			categories[category] = summarize(list.map(toMetrics));
	}
	const casesPerCategory: Record<string, number> = {};
	for (const evalCase of selected) {
		casesPerCategory[evalCase.category] =
			(casesPerCategory[evalCase.category] ?? 0) + 1;
	}
	let thresholds: EvalReport["thresholds"] = null;
	if (options.thresholds !== undefined) {
		const failures = evaluateThresholds(
			options.thresholds,
			overall.worst,
			Object.fromEntries(
				Object.entries(categories).map(([key, value]) => [key, value.worst]),
			),
		);
		thresholds = {
			path: options.thresholdsPath ?? "",
			sha256: options.thresholdsSha256 ?? "",
			version: options.thresholds.thresholdsVersion,
			status: options.thresholds.status,
			decidedBy: options.thresholds.decidedBy,
			decidedAt: options.thresholds.decidedAt,
			pass: failures.length === 0,
			failures,
		};
	}
	return {
		schemaVersion: RESULT_SCHEMA_VERSION,
		name: options.name,
		dataset: {
			id: DATASET_ID,
			path: options.datasetPath,
			sha256: options.datasetSha256,
			split: options.split,
			cases: selected.length,
			casesPerCategory,
			humanReviewed: selected.every((evalCase) => evalCase.humanReviewed),
		},
		adapter: {
			path: options.adapterPath,
			extractorId: options.adapter.extractorId,
			promptVersion: options.adapter.promptVersion,
			providerRef: options.adapter.providerRef,
			modelId: options.adapter.modelId ?? null,
			stub: options.adapter.stub === true,
		},
		run: {
			repeats: options.repeats,
			timeoutMs: options.timeoutMs,
			policy: EVAL_POLICY,
		},
		claims: claims(options, selected),
		thresholds,
		overall,
		categories,
		cases: caseReports,
	};
}
