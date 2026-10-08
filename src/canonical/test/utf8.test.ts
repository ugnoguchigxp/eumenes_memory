import { describe, expect, test } from "bun:test";
import {
	encodeUtf8,
	isUtf8CharBoundary,
	isWellFormedUtf16,
	utf8ByteLength,
} from "../utf8.ts";
import { compareCodeUnits } from "../compare.ts";
import { sha256Hex } from "../sha256.ts";

describe("utf8ByteLength", () => {
	test.each([
		["", 0],
		["a", 1],
		["\u007f", 1],
		["\u0080", 2],
		["߿", 2],
		["ࠀ", 3],
		["￿", 3],
		["\u{10000}", 4],
		["\u{1F600}", 4],
		["あ😀", 7],
	])("%j", (text, bytes) => {
		expect(utf8ByteLength(text)).toBe(bytes);
		expect(encodeUtf8(text).length).toBe(bytes);
	});

	test("matches TextEncoder for every BMP scalar and sampled astral", () => {
		for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x10000 ? 1 : 97) {
			if (cp >= 0xd800 && cp <= 0xdfff) continue;
			const text = String.fromCodePoint(cp);
			expect(utf8ByteLength(text)).toBe(encodeUtf8(text).length);
		}
	});
});

describe("isWellFormedUtf16", () => {
	test.each([
		["", true],
		["abc", true],
		["\u{1F600}", true],
		["\ud800", false],
		["\udc00", false],
		["a\ud800", false],
		["\ud800a", false],
		["\udc00\ud800", false],
		["\ud800𐀀", false],
	])("%j", (text, expected) => {
		expect(isWellFormedUtf16(text)).toBe(expected);
	});
});

describe("isUtf8CharBoundary", () => {
	const bytes = encodeUtf8("あ😀");
	test("boundaries of あ😀 are 0, 3, 7", () => {
		const found: number[] = [];
		for (let i = 0; i <= bytes.length; i += 1) {
			if (isUtf8CharBoundary(bytes, i)) found.push(i);
		}
		expect(found).toEqual([0, 3, 7]);
	});

	test("rejects out-of-range and non-integer indexes", () => {
		expect(isUtf8CharBoundary(bytes, 8)).toBe(false);
		expect(isUtf8CharBoundary(bytes, -1)).toBe(false);
		expect(isUtf8CharBoundary(bytes, 1.5)).toBe(false);
	});

	test("empty input has only boundary 0", () => {
		expect(isUtf8CharBoundary(new Uint8Array(0), 0)).toBe(true);
		expect(isUtf8CharBoundary(new Uint8Array(0), 1)).toBe(false);
	});
});

describe("compareCodeUnits", () => {
	test("orders by UTF-16 code unit", () => {
		expect(compareCodeUnits("a", "b")).toBe(-1);
		expect(compareCodeUnits("b", "a")).toBe(1);
		expect(compareCodeUnits("a", "a")).toBe(0);
		expect(compareCodeUnits("\u{1F600}", "～")).toBe(-1);
		expect(compareCodeUnits("B", "a")).toBe(-1);
	});
});

describe("sha256Hex", () => {
	test("known vectors", () => {
		expect(sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(sha256Hex(encodeUtf8("abc"))).toBe(sha256Hex("abc"));
	});
});
