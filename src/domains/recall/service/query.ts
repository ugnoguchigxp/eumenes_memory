/**
 * 検索クエリの正規化（純粋）。規則は `src/domains/recall/contracts/index.ts` の JSDoc:
 * 空白（U+0020, U+3000, \t, \n）で語に分け、全語を含む本文だけを返す（AND、部分文字列一致）。
 * ASCII の大文字小文字は区別しない。それ以外の正規化（全角半角、NFKC）はしない。
 */
import { LIMITS_RECALL } from "../contracts/index.ts";

export interface ParsedQuery {
	/** 重複を除いた語（入力順、元の表記）。 */
	readonly terms: readonly string[];
	/** `terms` の ASCII 小文字化（比較・索引用）。 */
	readonly folded: readonly string[];
	/** 最短の語のコードポイント数。 */
	readonly minTermChars: number;
}

/** A-Z だけを小文字にする（コード単位数を変えない。locale に依存しない）。 */
export function foldAscii(text: string): string {
	let out = "";
	let changed = false;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code >= 0x41 && code <= 0x5a) {
			changed = true;
			out += String.fromCharCode(code + 0x20);
		} else {
			out += text[index];
		}
	}
	return changed ? out : text;
}

export function countCodePoints(text: string): number {
	let count = 0;
	for (const _ of text) count += 1;
	return count;
}

function isQuerySeparator(char: string): boolean {
	return char === " " || char === "　" || char === "\t" || char === "\n";
}

export type QueryParseResult =
	| { readonly status: "ok"; readonly query: ParsedQuery }
	| {
			readonly status: "invalid";
			readonly code: "EMPTY_STRING" | "ARRAY_TOO_LONG" | "INVALID_STRING";
	  };

/** 語の数が上限を超える／語がない／制御文字を含むクエリは `invalid`。 */
export function parseQueryTerms(text: string): QueryParseResult {
	const terms: string[] = [];
	const folded: string[] = [];
	let current = "";
	const flush = (): void => {
		if (current.length === 0) return;
		const key = foldAscii(current);
		if (!folded.includes(key)) {
			terms.push(current);
			folded.push(key);
		}
		current = "";
	};
	for (const char of text) {
		if (isQuerySeparator(char)) {
			flush();
			continue;
		}
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) {
			return { status: "invalid", code: "INVALID_STRING" };
		}
		current += char;
	}
	flush();
	if (terms.length === 0) return { status: "invalid", code: "EMPTY_STRING" };
	if (terms.length > LIMITS_RECALL.maxTerms) {
		return { status: "invalid", code: "ARRAY_TOO_LONG" };
	}
	return {
		status: "ok",
		query: {
			terms,
			folded,
			minTermChars: Math.min(...terms.map(countCodePoints)),
		},
	};
}
