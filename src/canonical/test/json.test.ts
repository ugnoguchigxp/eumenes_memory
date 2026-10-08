import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../json.ts";

describe("canonicalJson", () => {
	test("sorts keys by UTF-16 code unit, not code point", () => {
		expect(canonicalJson({ "～": 1, "\u{1F600}": 2 })).toBe(
			'{"\u{1F600}":2,"～":1}',
		);
	});

	test("normalizes negative zero", () => {
		expect(canonicalJson(-0)).toBe("0");
		expect(canonicalJson([-0])).toBe("[0]");
	});

	test("accepts objects with null prototype", () => {
		const value = Object.create(null) as Record<string, unknown>;
		value["a"] = 1;
		expect(canonicalJson(value)).toBe('{"a":1}');
	});

	test.each([
		["null", null],
		["undefined", undefined],
		["fraction", 1.5],
		["unsafe integer", 9007199254740992],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["bigint", 1n],
		["function", () => 1],
		["symbol", Symbol("x")],
		["Date", new Date(0)],
		["Map", new Map()],
		["undefined member", { a: undefined }],
		["nested null", { a: [null] }],
	])("rejects %s", (_name, value) => {
		expect(() => canonicalJson(value)).toThrow(TypeError);
	});
});
