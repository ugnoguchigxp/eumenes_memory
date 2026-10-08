/**
 * 一致箇所の特定と snippet の切り出し（純粋）。`searchRecords` が SQL で絞った後の本文に対して使う。
 */
import {
	encodeUtf8,
	isUtf8CharBoundary,
	utf8ByteLength,
} from "../canonical/utf8.ts";
import { LIMITS_RECALL } from "../contracts/recall.ts";
import type { ByteRange } from "../contracts/types.ts";
import { foldAscii } from "./query.ts";

/**
 * 最初の一致箇所の UTF-8 byte 範囲。全語（`folded`、ASCII 小文字済み）のうち、本文中の最初の出現位置が
 * 最も前の語を選ぶ（同位置なら長い語）。どれかの語が本文に無ければ null（AND を満たさない）。
 */
export function findFirstMatch(
	content: string,
	folded: readonly string[],
): ByteRange | null {
	const haystack = foldAscii(content);
	let bestIndex = -1;
	let bestLength = 0;
	for (const term of folded) {
		const index = haystack.indexOf(term);
		if (index < 0) return null;
		if (
			bestIndex < 0 ||
			index < bestIndex ||
			(index === bestIndex && term.length > bestLength)
		) {
			bestIndex = index;
			bestLength = term.length;
		}
	}
	if (bestIndex < 0) return null;
	const startByte = utf8ByteLength(content.slice(0, bestIndex));
	const endByte =
		startByte +
		utf8ByteLength(content.slice(bestIndex, bestIndex + bestLength));
	return { startByte, endByte };
}

/**
 * range の前後を文字境界で切った本文（≤ maxBytes）。range が上限以上なら range の先頭から切る。
 * 余白は前後に均等に割り、片側が足りなければ反対側へ回す。
 */
export function makeSnippet(
	content: string,
	range: ByteRange,
	maxBytes: number = LIMITS_RECALL.maxSnippetBytes,
): string {
	const bytes = encodeUtf8(content);
	const rangeLength = range.endByte - range.startByte;
	let start = range.startByte;
	let end = range.endByte;
	if (rangeLength >= maxBytes) {
		end = start + maxBytes;
	} else {
		const spare = maxBytes - rangeLength;
		let before = Math.min(range.startByte, Math.floor(spare / 2));
		let after = Math.min(bytes.length - range.endByte, spare - before);
		before = Math.min(range.startByte, spare - after);
		start = range.startByte - before;
		end = range.endByte + after;
	}
	end = Math.min(end, bytes.length);
	while (start < end && !isUtf8CharBoundary(bytes, start)) start += 1;
	while (end > start && !isUtf8CharBoundary(bytes, end)) end -= 1;
	return new TextDecoder("utf-8", { fatal: true }).decode(
		bytes.subarray(start, end),
	);
}
