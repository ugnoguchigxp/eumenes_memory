import { describe, expect, test } from "bun:test";
import {
	assertPredicateDictionary,
	canonicalSemanticKey,
	resolveSemanticKey,
	sameSemanticKey,
} from "../index.ts";
import type { PredicateDictionary } from "../index.ts";

const DICT: PredicateDictionary = {
	version: "d1",
	predicates: [
		{ id: "tool.editor", aliases: ["メインIDE", "普段のエディタ", "ide"] },
		{ id: "tool.shell", aliases: ["ide-shell", "ide"] },
		{ id: "food.spicy", aliases: [] },
	],
};

describe("resolveSemanticKey", () => {
	test("exact and alias matches resolve after NFKC / case / space normalization", () => {
		expect(resolveSemanticKey("Tool.Editor", DICT)).toEqual({
			status: "resolved",
			key: "tool.editor",
			predicate: "tool.editor",
			via: "exact",
		});
		expect(resolveSemanticKey("普段のエディタ", DICT)).toMatchObject({
			status: "resolved",
			key: "tool.editor",
			via: "alias",
		});
		const main: PredicateDictionary = {
			version: "x",
			predicates: [{ id: "main", aliases: [] }],
		};
		expect(resolveSemanticKey("ＭＡＩＮ", main).status).toBe("resolved");
		expect(resolveSemanticKey("普段 のエディタ", DICT).status).toBe("unknown");
	});

	test("an alias that fits two predicates is ambiguous and is never merged", () => {
		expect(resolveSemanticKey("IDE", DICT)).toEqual({
			status: "ambiguous",
			candidates: ["tool.editor", "tool.shell"],
		});
		expect(canonicalSemanticKey("IDE", DICT)).toBe("IDE");
	});

	test("unknown keys are kept as they are; targets are preserved after @", () => {
		expect(canonicalSemanticKey("meal.favorite", DICT)).toBe("meal.favorite");
		expect(canonicalSemanticKey("メインIDE@Zed Editor", DICT)).toBe(
			"tool.editor@zededitor",
		);
		expect(resolveSemanticKey("メインIDE@", DICT).status).toBe("unknown");
		expect(canonicalSemanticKey("x", undefined)).toBe("x");
	});

	test("sameSemanticKey needs both sides resolved to the same predicate and target", () => {
		expect(sameSemanticKey("メインIDE", "tool.editor", DICT)).toBe(true);
		expect(sameSemanticKey("メインIDE@a", "tool.editor@b", DICT)).toBe(false);
		expect(sameSemanticKey("IDE", "IDE", DICT)).toBe(false);
		expect(sameSemanticKey("foo", "foo", DICT)).toBe(false);
	});

	test("invalid dictionaries are rejected", () => {
		for (const bad of [
			{ version: "", predicates: [] },
			{
				version: "v",
				predicates: [
					{ id: "a", aliases: [] },
					{ id: "A", aliases: [] },
				],
			},
			{ version: "v", predicates: [{ id: "a@b", aliases: [] }] },
			{ version: "v", predicates: [{ id: "a", aliases: [" "] }] },
		]) {
			expect(() => assertPredicateDictionary(bad)).toThrow(TypeError);
		}
	});
});
