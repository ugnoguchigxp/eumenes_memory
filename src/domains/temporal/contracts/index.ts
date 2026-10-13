/**
 * 時間の扱い。知った時点（recordedAtMs）、成立した期間（ValidityPeriod）、
 * 記録順序（seq。ここでは扱わない）は別の軸。時刻はすべてホストが渡す（本体は現在時刻を持たない）。
 *
 * - 精度つきの日付: 「9月から」は `{ precision: "month", year, month: 9 }`。日が不明なら 9 月 1 日という確定日を作らない。
 *   区間への展開は UTC の暦で行い、`from` は精度の最初の瞬間、`until` は精度の最後の瞬間を含む（排他的な終端は次の単位の最初）。
 * - 「時点不明」は期間を持たない、または basis が `unknown`。期限切れは本文削除を意味しない。
 */
export const DATE_PRECISIONS = Object.freeze(["year", "month", "day"] as const);
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

export interface PartialDate {
	readonly precision: DatePrecision;
	readonly year: number;
	readonly month?: number;
	readonly day?: number;
}

/** 期間の根拠。`stated` は本人の明示、`inferred` は文脈からの推定、`unknown` は期間を特定できない。 */
export const VALIDITY_BASES = Object.freeze([
	"stated",
	"inferred",
	"unknown",
] as const);
export type ValidityBasis = (typeof VALIDITY_BASES)[number];

export interface ValidityPeriod {
	readonly from?: PartialDate;
	readonly until?: PartialDate;
	/** State が保存する厳密なミリ秒の境界（`from` / `until` とは併用しない。untilMs は含まない）。 */
	readonly fromMs?: number;
	readonly untilMs?: number;
	readonly basis: ValidityBasis;
}

export const VALIDITY_CLASSES = Object.freeze([
	"current",
	"past",
	"future",
	"unknown",
] as const);
export type ValidityClass = (typeof VALIDITY_CLASSES)[number];

export type TemporalReason = "INVALID_DATE" | "INVALID_PERIOD" | "INVALID_TIME";
