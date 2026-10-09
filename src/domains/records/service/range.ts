/**
 * 本文の UTF-8 byte 範囲の読み出し（純粋）。Records の `readRecordRange` と、将来の quote 検査が共有する。
 * 範囲は半開区間 [startByte, endByte)。両端が UTF-8 のコードポイント境界でなければならない（書記素は見ない）。
 */
import { sha256Hex } from "../../../canonical/sha256.ts";
import { encodeUtf8, isUtf8CharBoundary } from "../../../canonical/utf8.ts";
import { LIMITS_RECORDS } from "../contracts/index.ts";
import type { RecordRangeReasonCode } from "../contracts/index.ts";
import type { ByteRange } from "../../../contracts/types.ts";

export type RangeSlice =
	| {
			readonly status: "ok";
			readonly text: string;
			/** 範囲の bytes の SHA-256 hex（quote digest）。 */
			readonly digest: string;
	  }
	| {
			readonly status: "invalid_range";
			readonly reasonCode: RecordRangeReasonCode;
	  };

/**
 * 判定順: 範囲が上限超過 → `RANGE_TOO_LARGE`（本文の長さに依存しない）、本文の外 →
 * `SOURCE_RANGE_OUT_OF_BOUNDS`、端がコードポイント境界でない → `SOURCE_RANGE_NOT_CHAR_BOUNDARY`。
 */
export function sliceUtf8Range(
	content: string,
	range: ByteRange,
	maxBytes: number = LIMITS_RECORDS.maxRangeBytes,
): RangeSlice {
	if (range.endByte - range.startByte > maxBytes) {
		return { status: "invalid_range", reasonCode: "RANGE_TOO_LARGE" };
	}
	const bytes = encodeUtf8(content);
	if (range.startByte < 0 || range.endByte > bytes.length) {
		return {
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
		};
	}
	if (
		!isUtf8CharBoundary(bytes, range.startByte) ||
		!isUtf8CharBoundary(bytes, range.endByte)
	) {
		return {
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		};
	}
	const slice = bytes.subarray(range.startByte, range.endByte);
	return {
		status: "ok",
		text: new TextDecoder("utf-8", { fatal: true }).decode(slice),
		digest: sha256Hex(slice),
	};
}
