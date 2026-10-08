/**
 * 1 ケース（1 回の実行）の採点と、ケースをまたぐ集計。純粋で決定的。
 *
 * 突き合わせの規則（`eval/README.md` に同じ説明）:
 * - モデルの候補のうち、根拠（evidence）が全部「quote が byte 範囲と一致」するものだけを比較対象にする。
 *   1 つでも不一致・範囲外・空なら `candidatesWithBadEvidence`（引用不一致）に数え、他の指標には入れない。
 * - gold ごとに、根拠の byte 範囲が gold の span と重なる未割り当ての候補から、属性の一致数が多い順
 *   （同点は重なりの大きい順、次に出力の順）で 1 件を割り当てる。割り当てられた gold は「候補の一致」(`matched`)。
 * - 割り当てられた対の属性（kind / subject / polarity / modality / temporal）を比べる。
 *   subject は種別（self / other / unknown）で比べる。subject が other の gold は kind を比べない
 *   （Admission が other_person_note に矯正するため）。許容は gold の `acceptable` に列挙された値。
 * - どの gold にも割り当てられない候補は `overExtracted`（過剰抽出）。ただし `tolerated` の範囲と重なるものは
 *   `tolerated` に数え、過剰にも誤採用にも数えない。gold と重なるが先に別の候補が割り当てられていたものは
 *   `duplicates`（`overExtracted` にも含む）。
 * - `falseAdmissions`: Admission が `admitted` にした候補のうち、属性がすべて正しく gold に割り当てられていないもの
 *   （tolerated を除く）。評価では全 self kind を `auto_admit` にした最悪ケースの方針で settle する。
 */
import { sliceUtf8Range } from "eumenes-memory";
import type {
	ExtractionOutput,
	ExtractionOutputCandidate,
} from "eumenes-memory";
import { spanToBytes } from "./dataset.ts";
import type { ByteSpan } from "./dataset.ts";
import { ATTRIBUTES, COUNT_KEYS } from "./types.ts";
import type {
	Attribute,
	CountKey,
	Counts,
	EvalCase,
	GoldCandidate,
	Metrics,
	RateKey,
} from "./types.ts";

export type Decision = "admitted" | "pending_user" | "rejected";

export type CaseRun =
	| { readonly kind: "adapter_failed" }
	| { readonly kind: "rejected_output" }
	| {
			readonly kind: "applied";
			readonly output: ExtractionOutput;
			readonly counts: {
				readonly admitted: number;
				readonly pendingUser: number;
				readonly rejected: number;
			};
			/** 候補の添字 → decision。行が作られなかった候補（検査で落ちたもの）は無い。 */
			readonly decisions: ReadonlyMap<number, Decision>;
	  };

export interface CaseScore {
	readonly counts: Counts;
	/** 人が読むための短い所見（"polarity:ラーメン" ではなく、属性名と gold の添字だけ。本文を含めない）。 */
	readonly flags: readonly string[];
}

export function zeroCounts(): Counts {
	return Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as Counts;
}

export function addCounts(a: Counts, b: Counts): Counts {
	return Object.fromEntries(
		COUNT_KEYS.map((key) => [key, a[key] + b[key]]),
	) as Counts;
}

function bump(counts: Record<CountKey, number>, key: CountKey, by = 1): void {
	counts[key] += by;
}

function mutableCounts(): Record<CountKey, number> {
	return { ...zeroCounts() };
}

function subjectClassOf(subject: string): string {
	if (subject === "self") return "self";
	if (subject === "unknown") return "unknown";
	return subject.startsWith("other:") && subject.length > "other:".length
		? "other"
		: "invalid";
}

interface Emitted {
	readonly index: number;
	readonly candidate: ExtractionOutputCandidate;
	/** 検査済みの根拠の範囲（候補が比較対象のときだけ）。 */
	readonly spans: readonly ByteSpan[];
}

/** 根拠がすべて有効なら範囲を返す。1 つでも無効なら null。 */
function validSpans(
	evalCase: EvalCase,
	candidate: ExtractionOutputCandidate,
): readonly ByteSpan[] | null {
	if (candidate.evidence.length === 0) return null;
	const spans: ByteSpan[] = [];
	for (const evidence of candidate.evidence) {
		const source = evalCase.sources[evidence.sourceIndex];
		if (
			source === undefined ||
			!Number.isInteger(evidence.sourceIndex) ||
			evidence.startByte >= evidence.endByte
		) {
			return null;
		}
		const slice = sliceUtf8Range(source.content, {
			startByte: evidence.startByte,
			endByte: evidence.endByte,
		});
		if (slice.status !== "ok" || slice.text !== evidence.quote) return null;
		spans.push({
			source: evidence.sourceIndex,
			startByte: evidence.startByte,
			endByte: evidence.endByte,
			quote: evidence.quote,
		});
	}
	return spans;
}

function overlap(a: ByteSpan, b: ByteSpan): number {
	if (a.source !== b.source) return 0;
	return Math.max(
		0,
		Math.min(a.endByte, b.endByte) - Math.max(a.startByte, b.startByte),
	);
}

function overlapBetween(
	left: readonly ByteSpan[],
	right: readonly ByteSpan[],
): number {
	let total = 0;
	for (const a of left) for (const b of right) total += overlap(a, b);
	return total;
}

function attributeOk(
	gold: GoldCandidate,
	attribute: Attribute,
	candidate: ExtractionOutputCandidate,
): boolean {
	const allowed = (primary: string): readonly string[] => [
		primary,
		...(gold.acceptable?.[attribute] ?? []),
	];
	switch (attribute) {
		case "kind":
			return (
				gold.subject === "other" || allowed(gold.kind).includes(candidate.kind)
			);
		case "subject":
			return allowed(gold.subject).includes(subjectClassOf(candidate.subject));
		case "polarity":
			return allowed(gold.polarity).includes(candidate.value.polarity);
		case "modality":
			return allowed(gold.modality).includes(candidate.modality);
		case "temporal":
			return allowed(gold.temporal).includes(candidate.temporal);
	}
}

function attributeErrors(
	gold: GoldCandidate,
	candidate: ExtractionOutputCandidate,
): readonly Attribute[] {
	return ATTRIBUTES.filter(
		(attribute) => !attributeOk(gold, attribute, candidate),
	);
}

const ERROR_KEY: Readonly<Record<Attribute, CountKey>> = {
	kind: "kindErrors",
	subject: "subjectErrors",
	polarity: "polarityErrors",
	modality: "modalityErrors",
	temporal: "temporalErrors",
};

export function scoreCase(evalCase: EvalCase, run: CaseRun): CaseScore {
	const counts = mutableCounts();
	const flags: string[] = [];
	const gold = evalCase.expect.candidates;
	bump(counts, "cases");
	if (evalCase.expect.noChange) bump(counts, "noChangeCases");

	if (run.kind !== "applied") {
		bump(
			counts,
			run.kind === "adapter_failed" ? "adapterFailures" : "rejectedOutputs",
		);
		bump(counts, "goldCandidates", gold.length);
		bump(counts, "missed", gold.length);
		flags.push(run.kind);
		return { counts, flags };
	}

	const candidates = run.output.candidates;
	bump(counts, "emittedCandidates", candidates.length);
	bump(counts, "admitted", run.counts.admitted);
	bump(counts, "pendingUser", run.counts.pendingUser);
	bump(counts, "rejected", run.counts.rejected);

	if (candidates.length === 0) {
		if (evalCase.expect.noChange) bump(counts, "noChangeCorrect");
		if (!evalCase.expect.noChange && evalCase.acceptNoChange === true) {
			bump(counts, "acceptedNoChangeCases");
			flags.push("accepted_no_change");
			return { counts, flags };
		}
		bump(counts, "goldCandidates", gold.length);
		bump(counts, "missed", gold.length);
		if (gold.length > 0) flags.push("missed_all");
		return { counts, flags };
	}

	bump(counts, "goldCandidates", gold.length);
	const emitted: Emitted[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const spans = validSpans(evalCase, candidate);
		if (spans === null) {
			bump(counts, "candidatesWithBadEvidence");
			flags.push(`bad_evidence:${index}`);
		} else {
			emitted.push({ index, candidate, spans });
		}
	}

	const assigned = new Map<number, number>();
	const fullMatches = new Set<number>();
	for (const [goldIndex, expected] of gold.entries()) {
		const goldSpans = expected.spans.map((span) =>
			spanToBytes(evalCase.sources, span),
		);
		let best: {
			readonly emitted: Emitted;
			readonly score: number;
			readonly overlap: number;
		} | null = null;
		for (const entry of emitted) {
			if (assigned.has(entry.index)) continue;
			const shared = overlapBetween(entry.spans, goldSpans);
			if (shared === 0) continue;
			const score =
				ATTRIBUTES.length - attributeErrors(expected, entry.candidate).length;
			if (
				best === null ||
				score > best.score ||
				(score === best.score && shared > best.overlap)
			) {
				best = { emitted: entry, score, overlap: shared };
			}
		}
		if (best === null) {
			bump(counts, "missed");
			flags.push(`missed:${goldIndex}`);
			continue;
		}
		assigned.set(best.emitted.index, goldIndex);
		bump(counts, "matched");
		const errors = attributeErrors(expected, best.emitted.candidate);
		for (const attribute of errors) {
			bump(counts, ERROR_KEY[attribute]);
			flags.push(`${attribute}:${goldIndex}`);
		}
		if (errors.length === 0) {
			bump(counts, "fullMatch");
			fullMatches.add(best.emitted.index);
		}
	}

	const goldAll = gold.flatMap((expected) =>
		expected.spans.map((span) => spanToBytes(evalCase.sources, span)),
	);
	const toleratedSpans = (evalCase.tolerated ?? []).map((span) =>
		spanToBytes(evalCase.sources, span),
	);
	const toleratedIndexes = new Set<number>();
	for (const entry of emitted) {
		if (assigned.has(entry.index)) continue;
		if (overlapBetween(entry.spans, toleratedSpans) > 0) {
			bump(counts, "tolerated");
			toleratedIndexes.add(entry.index);
			continue;
		}
		bump(counts, "overExtracted");
		flags.push(`over:${entry.index}`);
		if (overlapBetween(entry.spans, goldAll) > 0) bump(counts, "duplicates");
	}

	if (evalCase.expect.noChange) {
		// 候補が 1 件でもあれば noChange は不正解（上で noChangeCorrect を数えていない）。
		flags.push("expected_no_change");
	}
	for (const [index, decision] of run.decisions) {
		if (decision !== "admitted") continue;
		if (fullMatches.has(index) || toleratedIndexes.has(index)) continue;
		bump(counts, "falseAdmissions");
		flags.push(`false_admission:${index}`);
	}
	return { counts, flags };
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

export function toMetrics(counts: Counts): Metrics {
	const rates: Record<RateKey, number | null> = {
		candidateRecall: ratio(counts.matched, counts.goldCandidates),
		fullMatchRate: ratio(counts.fullMatch, counts.goldCandidates),
		overExtractionRate: ratio(counts.overExtracted, counts.emittedCandidates),
		quoteMismatchRate: ratio(
			counts.candidatesWithBadEvidence,
			counts.emittedCandidates,
		),
		noChangeAccuracy: ratio(counts.noChangeCorrect, counts.noChangeCases),
		falseAdmissionRate: ratio(counts.falseAdmissions, counts.admitted),
	};
	return { ...counts, ...rates };
}

/** 良い方向（true = 大きいほど良い）。指標の「最悪値」の選択に使う。 */
const HIGHER_IS_BETTER: ReadonlySet<string> = new Set([
	"matched",
	"fullMatch",
	"noChangeCorrect",
	"candidateRecall",
	"fullMatchRate",
	"noChangeAccuracy",
]);
/** 反復ごとの指標から、指標ごとの最悪値（悪い方）を取る。null は他方があればそれを採る。 */
export function worstMetrics(list: readonly Metrics[]): Metrics {
	const first = list[0];
	if (first === undefined) throw new Error("no metrics to aggregate");
	const result: Record<string, number | null> = { ...first };
	for (const metrics of list.slice(1)) {
		for (const [key, value] of Object.entries(metrics)) {
			const current = result[key] ?? null;
			if (value === null) continue;
			if (current === null) {
				result[key] = value;
			} else if (HIGHER_IS_BETTER.has(key)) {
				result[key] = Math.min(current, value);
			} else {
				result[key] = Math.max(current, value);
			}
		}
	}
	return result as unknown as Metrics;
}
