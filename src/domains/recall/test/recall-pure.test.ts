import { describe, expect, test } from "bun:test";
import { utf8ByteLength } from "../../../canonical/utf8.ts";
import {
	cursorBinding,
	decodeCursor,
	encodeCursor,
} from "../service/cursor.ts";
import { findFirstMatch, makeSnippet } from "../service/match.ts";
import { foldAscii, parseQueryTerms } from "../service/query.ts";
import { chooseStrategy, LIKE_SCAN_MAX } from "../service/strategy.ts";

describe("parseQueryTerms", () => {
	test("splits on the four separators, drops duplicates, folds ASCII only", () => {
		const parsed = parseQueryTerms("  Coffee　ＣＯＦＦＥＥ\tcoffee\nÉcole  ");
		if (parsed.status !== "ok") throw new Error("unreachable");
		expect(parsed.query.terms).toEqual(["Coffee", "ＣＯＦＦＥＥ", "École"]);
		expect(parsed.query.folded).toEqual(["coffee", "ＣＯＦＦＥＥ", "École"]);
		expect(parsed.query.minTermChars).toBe(5);
	});

	test("counts code points, not UTF-16 units", () => {
		const parsed = parseQueryTerms("😀😀 abc");
		if (parsed.status !== "ok") throw new Error("unreachable");
		expect(parsed.query.minTermChars).toBe(2);
	});

	test("rejects empty, too many terms, control characters", () => {
		expect(parseQueryTerms(" 　 ")).toEqual({
			status: "invalid",
			code: "EMPTY_STRING",
		});
		expect(parseQueryTerms("1 2 3 4 5 6 7 8 9")).toEqual({
			status: "invalid",
			code: "ARRAY_TOO_LONG",
		});
		expect(parseQueryTerms("a\u0001b")).toEqual({
			status: "invalid",
			code: "INVALID_STRING",
		});
	});
});

describe("foldAscii", () => {
	test("keeps length and leaves non-ASCII untouched", () => {
		expect(foldAscii("ABC xyz ÀÉ ＡＢＣ")).toBe("abc xyz ÀÉ ＡＢＣ");
		expect(foldAscii("😀A").length).toBe(3);
	});
});

describe("strategy", () => {
	test("short terms always use like; large scopes use fts", () => {
		expect(
			chooseStrategy({
				minTermChars: 2,
				scopeRowCount: 10 ** 6,
				ftsAvailable: true,
			}),
		).toBe("like");
		expect(
			chooseStrategy({
				minTermChars: 3,
				scopeRowCount: LIKE_SCAN_MAX,
				ftsAvailable: true,
			}),
		).toBe("like");
		expect(
			chooseStrategy({
				minTermChars: 3,
				scopeRowCount: LIKE_SCAN_MAX + 1,
				ftsAvailable: true,
			}),
		).toBe("fts");
		expect(
			chooseStrategy({
				minTermChars: 3,
				scopeRowCount: 10 ** 6,
				ftsAvailable: false,
			}),
		).toBe("like");
	});
});

describe("findFirstMatch / makeSnippet", () => {
	test("byte range of the earliest term occurrence (UTF-8 bytes)", () => {
		expect(findFirstMatch("ab食😀cd", ["cd"])).toEqual({
			startByte: 9,
			endByte: 11,
		});
		expect(findFirstMatch("ab食😀cd", ["😀", "ab"])).toEqual({
			startByte: 0,
			endByte: 2,
		});
		expect(findFirstMatch("ABC", ["b"])).toEqual({ startByte: 1, endByte: 2 });
		expect(findFirstMatch("ab", ["abc"])).toBeNull();
		expect(findFirstMatch("ab", ["a", "z"])).toBeNull();
	});

	test("snippet stays within 256 bytes, on character boundaries, and contains the match", () => {
		const content = `${"あ".repeat(200)}目的語${"い".repeat(200)}😀`;
		const range = findFirstMatch(content, ["目的語"]);
		if (range === null) throw new Error("unreachable");
		const snippet = makeSnippet(content, range);
		expect(utf8ByteLength(snippet)).toBeLessThanOrEqual(256);
		expect(snippet).toContain("目的語");
		expect(makeSnippet("short", { startByte: 1, endByte: 3 })).toBe("short");
		const huge = makeSnippet("x".repeat(1000), { startByte: 10, endByte: 900 });
		expect(utf8ByteLength(huge)).toBe(256);
		const emoji = makeSnippet("😀".repeat(100), { startByte: 40, endByte: 44 });
		expect(utf8ByteLength(emoji)).toBeLessThanOrEqual(256);
		expect(emoji).not.toContain("�");
	});
});

describe("cursor", () => {
	const binding = cursorBinding("p", ["b", "a"], ["x", "y"]);
	const position = { updatedSeq: 42, recordId: `rec:${"b".repeat(64)}` };
	test("round trips and is bound to the query", () => {
		expect(binding).toBe(cursorBinding("p", ["a", "b"], ["y", "x"]));
		expect(binding).not.toBe(cursorBinding("p", ["a"], ["x", "y"]));
		expect(decodeCursor(encodeCursor(position, binding), binding)).toEqual(
			position,
		);
		expect(
			decodeCursor(encodeCursor(position, binding), "0".repeat(16)),
		).toBeNull();
		expect(decodeCursor("c1.01.xx.rec:zz", binding)).toBeNull();
		expect(decodeCursor("", binding)).toBeNull();
	});
});
