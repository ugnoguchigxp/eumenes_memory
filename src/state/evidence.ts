/**
 * 根拠（EvidenceSpan）の検査。純粋。Admission（Extraction）と State の明示操作が共有する。
 *
 * 検査の順（Admission 規則表の上から評価に合わせる。`ADMISSION_REASON_CODES` の順序）:
 * 1. QUOTE_MISMATCH: run 入力（本文つき出典）に見つかった evidence について、range が文字境界内に収まり、
 *    range の bytes が quote の UTF-8 と完全に一致すること。入力に無い出典の quote は検査できないので次へ送る。
 * 2. EVIDENCE_NOT_IN_INPUT: evidence の出典が入力にない（SourceKey・revision・digest・principal・scope が一致しない）。
 * 3. SOURCE_STALE: 出典の現在状態が available でない、または revision / digest が入力と違う（forgotten・版変更）。
 *    入力の本文が自分の digest（SHA-256 hex）と一致しない場合も SOURCE_STALE（入力が壊れている）。
 */
import { sha256Hex } from "../canonical/sha256.ts";
import { encodeUtf8, isUtf8CharBoundary } from "../canonical/utf8.ts";
import type { EvidenceSpan } from "../contracts/common.ts";
import { ownValue } from "../contracts/own.ts";
import { sourceKey } from "../contracts/source-key.ts";
import type { HostSourceState } from "../contracts/state.ts";
import type { SourceRef, SourceState } from "../contracts/types.ts";

export type EvidenceFailure =
	| "QUOTE_MISMATCH"
	| "EVIDENCE_NOT_IN_INPUT"
	| "SOURCE_STALE";

/** 本文つきの入力出典（`HostSourceState` / `ExtractionSource` の共通部分）。 */
export type EvidenceInputSource = HostSourceState;

export interface EvidenceCheckInput {
	readonly principal: string;
	readonly scopeKey: string;
	readonly evidence: readonly EvidenceSpan[];
	/** モデル／ホストが実際に見た本文つきの出典。 */
	readonly inputSources: readonly EvidenceInputSource[];
	/** 検査時点の出典の現在状態。明示操作では `inputSources` と同じ。 */
	readonly currentSources: readonly SourceState[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** evidence の出典に対応する入力出典。SourceKey・revision・digest・principal・scope が全部一致するものだけ。 */
export function findInputSource<T extends EvidenceInputSource>(
	ref: SourceRef,
	principal: string,
	scopeKey: string,
	inputSources: readonly T[],
): T | undefined {
	const key = sourceKey(ref);
	return inputSources.find(
		(source) =>
			sourceKey(source) === key &&
			source.revision === ref.revision &&
			source.digest === ref.digest &&
			source.principal === principal &&
			source.scopeKey === scopeKey,
	);
}

/** range の bytes が quote と完全に一致するか（range 必須・文字境界・範囲内）。 */
export function quoteMatches(content: string, span: EvidenceSpan): boolean {
	const range = ownValue(span.source, "range");
	if (range === undefined || span.quote.length === 0) return false;
	const bytes = encodeUtf8(content);
	if (
		range.startByte >= range.endByte ||
		range.endByte > bytes.length ||
		!isUtf8CharBoundary(bytes, range.startByte) ||
		!isUtf8CharBoundary(bytes, range.endByte)
	) {
		return false;
	}
	return bytesEqual(
		bytes.subarray(range.startByte, range.endByte),
		encodeUtf8(span.quote),
	);
}

function isStale(
	ref: SourceRef,
	input: EvidenceInputSource,
	currentSources: readonly SourceState[],
): boolean {
	if (sha256Hex(input.content) !== input.digest) return true;
	const key = sourceKey(ref);
	const current = currentSources.find(
		(source) =>
			sourceKey(source) === key &&
			source.principal === input.principal &&
			source.scopeKey === input.scopeKey,
	);
	return (
		current === undefined ||
		current.status !== "available" ||
		current.revision !== ref.revision ||
		current.digest !== ref.digest
	);
}

/** 失敗しなければ null。最初に当たったものを返す（上記の順）。 */
export function checkEvidence(
	input: EvidenceCheckInput,
): EvidenceFailure | null {
	const matched = input.evidence.map((span) =>
		findInputSource(
			span.source,
			input.principal,
			input.scopeKey,
			input.inputSources,
		),
	);
	for (const [index, span] of input.evidence.entries()) {
		const source = matched[index];
		if (source !== undefined && !quoteMatches(source.content, span)) {
			return "QUOTE_MISMATCH";
		}
	}
	if (matched.some((source) => source === undefined)) {
		return "EVIDENCE_NOT_IN_INPUT";
	}
	for (const [index, span] of input.evidence.entries()) {
		const source = matched[index];
		if (
			source !== undefined &&
			isStale(span.source, source, input.currentSources)
		) {
			return "SOURCE_STALE";
		}
	}
	return null;
}

/**
 * evidence の根拠順位 = 対応する入力出典の `ordinal` の最大。入力に対応する出典がなければ null。
 * 新旧比較（OLDER_EVIDENCE / supersede / dispute）に使う。
 */
export function evidenceOrdinalOf(
	input: Pick<
		EvidenceCheckInput,
		"principal" | "scopeKey" | "evidence" | "inputSources"
	>,
): number | null {
	let best: number | null = null;
	for (const span of input.evidence) {
		const source = findInputSource(
			span.source,
			input.principal,
			input.scopeKey,
			input.inputSources,
		);
		if (source === undefined) return null;
		if (best === null || source.ordinal > best) best = source.ordinal;
	}
	return best;
}

// ---- 括弧内の引用（MODALITY_QUOTED の判定）----

/** 開き括弧の UTF-8 と、対応する閉じ括弧。 */
const QUOTATION_PAIRS: readonly {
	readonly open: readonly number[];
	readonly close: readonly number[];
}[] = [
	{ open: [0xe3, 0x80, 0x8c], close: [0xe3, 0x80, 0x8d] }, // 「 」
	{ open: [0xe3, 0x80, 0x8e], close: [0xe3, 0x80, 0x8f] }, // 『 』
	{ open: [0xe2, 0x80, 0x9c], close: [0xe2, 0x80, 0x9d] }, // “ ”
];
const ASCII_DOUBLE_QUOTE = 0x22;

function startsWithBytes(
	bytes: Uint8Array,
	at: number,
	pattern: readonly number[],
): boolean {
	return pattern.every((byte, offset) => bytes[at + offset] === byte);
}

/**
 * quote が括弧（「」『』“” と ASCII の二重引用符）の中にあるか。次のどちらかなら true（保守的に pending_user へ送る側）:
 * (a) quote 自身が開き括弧で始まり対応する閉じ括弧で終わる、(b) 出典本文で range の開始位置が未閉じの開き括弧の内側
 * （ASCII の二重引用符は出現回数の偶奇）。本文の bytes を走査するだけで、文字列にデコードしない。
 */
export function isQuotedSpan(content: string, span: EvidenceSpan): boolean {
	const quote = encodeUtf8(span.quote);
	for (const pair of QUOTATION_PAIRS) {
		if (
			quote.length >= pair.open.length + pair.close.length &&
			startsWithBytes(quote, 0, pair.open) &&
			startsWithBytes(quote, quote.length - pair.close.length, pair.close)
		) {
			return true;
		}
	}
	if (
		quote.length >= 2 &&
		quote[0] === ASCII_DOUBLE_QUOTE &&
		quote[quote.length - 1] === ASCII_DOUBLE_QUOTE
	) {
		return true;
	}
	const range = ownValue(span.source, "range");
	if (range === undefined) return false;
	const bytes = encodeUtf8(content);
	let depth = 0;
	let asciiOpen = false;
	let at = 0;
	while (at < range.startByte && at < bytes.length) {
		if (bytes[at] === ASCII_DOUBLE_QUOTE) {
			asciiOpen = !asciiOpen;
			at += 1;
			continue;
		}
		const opened = QUOTATION_PAIRS.find((pair) =>
			startsWithBytes(bytes, at, pair.open),
		);
		if (opened !== undefined) {
			depth += 1;
			at += opened.open.length;
			continue;
		}
		const closed = QUOTATION_PAIRS.find((pair) =>
			startsWithBytes(bytes, at, pair.close),
		);
		if (closed !== undefined) {
			depth = Math.max(0, depth - 1);
			at += closed.close.length;
			continue;
		}
		at += 1;
	}
	return depth > 0 || asciiOpen;
}
