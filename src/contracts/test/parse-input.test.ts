import { describe, expect, test } from "bun:test";
import { utf8ByteLength } from "../../canonical/utf8.ts";
import { LIMITS } from "../constants.ts";
import { MemoryContractError, isMemoryContractError } from "../errors.ts";
import {
	parseBuildMemoryViewInput,
	parseValidationCurrent,
} from "../parse-input.ts";
import { baseInput, exactBytes } from "./base.ts";

function codeAndPath(run: () => unknown): { code: string; path: string } {
	try {
		run();
	} catch (error) {
		if (isMemoryContractError(error)) {
			return { code: error.code, path: error.path };
		}
		throw error;
	}
	throw new Error("expected MemoryContractError");
}

const parse = (input: unknown) => parseBuildMemoryViewInput(input);

describe("parseBuildMemoryViewInput: success", () => {
	test("accepts the base input and returns a deep-frozen copy", () => {
		const input = baseInput();
		const parsed = parse(input);
		expect(parsed).toEqual(input);
		expect(parsed).not.toBe(input);
		expect(parsed.snapshot).not.toBe(input.snapshot);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.snapshot.items[0]?.primarySource)).toBe(true);
		// 入力は変更されず、frozen にもならない
		expect(Object.isFrozen(input)).toBe(false);
	});

	test("accepts already deep-frozen input", () => {
		const input = baseInput();
		const freeze = (value: any): void => {
			if (typeof value === "object" && value !== null) {
				Object.values(value).forEach(freeze);
				Object.freeze(value);
			}
		};
		freeze(input);
		expect(() => parse(input)).not.toThrow();
	});

	test("accepts Object.create(null) objects", () => {
		const input = baseInput();
		const bare = Object.assign(Object.create(null), input.access);
		input.access = bare;
		expect(() => parse(input)).not.toThrow();
	});

	test("normalizes -0 to 0", () => {
		const input = baseInput();
		input.maxBytes = -0;
		expect(Object.is(parse(input).maxBytes, 0)).toBe(true);
	});

	test("accepts empty scopeKeys / items / sources", () => {
		const input = baseInput();
		input.access.scopeKeys = [];
		input.snapshot.items = [];
		input.snapshot.sources = [];
		expect(() => parse(input)).not.toThrow();
	});

	test("accepts maxBytes = Number.MAX_SAFE_INTEGER and 0", () => {
		const input = baseInput();
		input.maxBytes = Number.MAX_SAFE_INTEGER;
		expect(() => parse(input)).not.toThrow();
		input.maxBytes = 0;
		expect(() => parse(input)).not.toThrow();
	});
});

describe("parseBuildMemoryViewInput: JS-specific shapes", () => {
	test("rejects non-objects and arrays at the top level", () => {
		for (const value of [null, undefined, 1, "x", true, []]) {
			expect(codeAndPath(() => parse(value))).toEqual({
				code: "INVALID_TYPE",
				path: "$",
			});
		}
	});

	test("object literal with __proto__ changes the prototype -> INVALID_PROPERTY", () => {
		const input = baseInput();
		input.snapshot = { __proto__: { evil: 1 }, ...input.snapshot };
		expect(Object.getPrototypeOf(input.snapshot)).not.toBe(Object.prototype);
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "INVALID_PROPERTY",
			path: "$.snapshot",
		});
	});

	test("rejects class instances, Map and Date as plain objects", () => {
		for (const value of [new Map(), new Date(0), new (class X {})()]) {
			const input = baseInput();
			input.access = value;
			expect(codeAndPath(() => parse(input)).code).toBe("INVALID_PROPERTY");
		}
	});

	test("rejects accessor properties without invoking them", () => {
		const input = baseInput();
		let called = false;
		Object.defineProperty(input.access, "purpose", {
			enumerable: true,
			get() {
				called = true;
				return "dialogue.generate";
			},
		});
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "INVALID_PROPERTY",
			path: "$.access",
		});
		expect(called).toBe(false);
	});

	test("rejects symbol keys", () => {
		const input = baseInput();
		input.access[Symbol("x")] = 1;
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "INVALID_PROPERTY",
			path: "$.access",
		});
	});

	test("rejects array holes and extra array properties", () => {
		const holes = baseInput();
		holes.snapshot.items = [];
		holes.snapshot.items.length = 2;
		expect(codeAndPath(() => parse(holes))).toEqual({
			code: "INVALID_PROPERTY",
			path: "$.snapshot.items",
		});
		const extra = baseInput();
		(extra.access.scopeKeys as any).extra = 1;
		expect(codeAndPath(() => parse(extra))).toEqual({
			code: "INVALID_PROPERTY",
			path: "$.access.scopeKeys",
		});
	});

	test("rejects undefined values as INVALID_TYPE", () => {
		const input = baseInput();
		input.snapshot.items[0].primarySource.representation = undefined;
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "INVALID_TYPE",
			path: "$.snapshot.items[0].primarySource.representation",
		});
	});

	test("error message never contains input values or key names", () => {
		const input = baseInput();
		input.secretKeyName = "secret-value";
		try {
			parse(input);
			throw new Error("unreachable");
		} catch (error) {
			expect(error).toBeInstanceOf(MemoryContractError);
			const typed = error as MemoryContractError;
			expect(typed.message).toBe("UNKNOWN_KEY at $");
			expect(typed.message).not.toContain("secret");
			expect(typed.name).toBe("MemoryContractError");
		}
	});

	test("parseValidationCurrent rejects the build-only keys", () => {
		const input = baseInput();
		expect(codeAndPath(() => parseValidationCurrent(input))).toEqual({
			code: "UNKNOWN_KEY",
			path: "$",
		});
		delete input.maxBytes;
		delete input.enabled;
		expect(() => parseValidationCurrent(input)).not.toThrow();
	});

	test("schemaVersion is checked before unknown keys; non-integers differ", () => {
		const input = baseInput();
		input.schemaVersion = 1.5;
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "INVALID_INTEGER",
			path: "$.schemaVersion",
		});
		input.schemaVersion = 0;
		input.unknown = 1;
		expect(codeAndPath(() => parse(input)).code).toBe(
			"UNSUPPORTED_SCHEMA_VERSION",
		);
		delete input.schemaVersion;
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "MISSING_KEY",
			path: "$.schemaVersion",
		});
	});
});

type Setter = (input: any, value: any) => void;
interface BoundaryCase {
	readonly name: string;
	readonly limit: number;
	readonly set: Setter;
	readonly path: string;
	readonly make?: (bytes: number) => string;
}

const ascii = (bytes: number) => "a".repeat(bytes);
const item = (input: any, index = 0) => input.snapshot.items[index];
/** primarySource と、完全一致が必須の dependencies[0] を同時に変更する。 */
const setPrimary = (input: any, field: string, value: string) => {
	const target = item(input);
	target.primarySource[field] = value;
	target.dependencies = [target.primarySource];
};

const STRING_CASES: readonly BoundaryCase[] = [
	{
		name: "maxPrincipalBytes (access)",
		limit: LIMITS.maxPrincipalBytes,
		set: (i, v) => (i.access.principal = v),
		path: "$.access.principal",
	},
	{
		name: "maxPrincipalBytes (snapshot)",
		limit: LIMITS.maxPrincipalBytes,
		set: (i, v) => (i.snapshot.principal = v),
		path: "$.snapshot.principal",
	},
	{
		name: "maxPrincipalBytes (source)",
		limit: LIMITS.maxPrincipalBytes,
		set: (i, v) => (i.snapshot.sources[0].principal = v),
		path: "$.snapshot.sources[0].principal",
	},
	{
		name: "maxScopeKeyBytes (snapshot)",
		limit: LIMITS.maxScopeKeyBytes,
		set: (i, v) => (i.snapshot.scopeKey = v),
		path: "$.snapshot.scopeKey",
	},
	{
		name: "maxScopeKeyBytes (access)",
		limit: LIMITS.maxScopeKeyBytes,
		set: (i, v) => (i.access.scopeKeys[0] = v),
		path: "$.access.scopeKeys[0]",
	},
	{
		name: "maxScopeKeyBytes (source)",
		limit: LIMITS.maxScopeKeyBytes,
		set: (i, v) => (i.snapshot.sources[0].scopeKey = v),
		path: "$.snapshot.sources[0].scopeKey",
	},
	{
		name: "maxPurposeBytes",
		limit: LIMITS.maxPurposeBytes,
		set: (i, v) => (i.access.purpose = v),
		path: "$.access.purpose",
	},
	{
		name: "maxRevisionBytes (stateRevision)",
		limit: LIMITS.maxRevisionBytes,
		set: (i, v) => (i.snapshot.stateRevision = v),
		path: "$.snapshot.stateRevision",
	},
	{
		name: "maxRevisionBytes (snapshot policy)",
		limit: LIMITS.maxRevisionBytes,
		set: (i, v) => (i.snapshot.policyRevision = v),
		path: "$.snapshot.policyRevision",
	},
	{
		name: "maxRevisionBytes (access policy)",
		limit: LIMITS.maxRevisionBytes,
		set: (i, v) => (i.access.policyRevision = v),
		path: "$.access.policyRevision",
	},
	{
		name: "maxRevisionBytes (item)",
		limit: LIMITS.maxRevisionBytes,
		set: (i, v) => (item(i).revision = v),
		path: "$.snapshot.items[0].revision",
	},
	{
		name: "maxRevisionBytes (source)",
		limit: LIMITS.maxRevisionBytes,
		set: (i, v) => (i.snapshot.sources[0].revision = v),
		path: "$.snapshot.sources[0].revision",
	},
	{
		name: "maxRevisionBytes (source ref)",
		limit: LIMITS.maxRevisionBytes,
		set: (i, v) => setPrimary(i, "revision", v),
		path: "$.snapshot.items[0].primarySource.revision",
	},
	{
		name: "maxNamespaceBytes (source)",
		limit: LIMITS.maxNamespaceBytes,
		set: (i, v) => (i.snapshot.sources[0].namespace = v),
		path: "$.snapshot.sources[0].namespace",
		make: ascii,
	},
	{
		name: "maxNamespaceBytes (source ref)",
		limit: LIMITS.maxNamespaceBytes,
		set: (i, v) => setPrimary(i, "namespace", v),
		path: "$.snapshot.items[0].primarySource.namespace",
		make: ascii,
	},
	{
		name: "maxSourceKindBytes",
		limit: LIMITS.maxSourceKindBytes,
		set: (i, v) => (i.snapshot.sources[0].kind = v),
		path: "$.snapshot.sources[0].kind",
		make: ascii,
	},
	{
		name: "maxSourceIdBytes",
		limit: LIMITS.maxSourceIdBytes,
		set: (i, v) => (i.snapshot.sources[0].id = v),
		path: "$.snapshot.sources[0].id",
	},
	{
		name: "maxRepresentationBytes",
		limit: LIMITS.maxRepresentationBytes,
		set: (i, v) => (i.snapshot.sources[0].representation = v),
		path: "$.snapshot.sources[0].representation",
	},
	{
		name: "maxItemIdBytes",
		limit: LIMITS.maxItemIdBytes,
		set: (i, v) => (item(i).id = v),
		path: "$.snapshot.items[0].id",
		make: (n) => `a:${ascii(n - 2)}`,
	},
	{
		name: "maxItemTextBytes",
		limit: LIMITS.maxItemTextBytes,
		set: (i, v) => (item(i).text = v),
		path: "$.snapshot.items[0].text",
	},
	{
		name: "maxSourceContentBytes",
		limit: LIMITS.maxSourceContentBytes,
		set: (i, v) => (i.snapshot.sources[0].content = v),
		path: "$.snapshot.sources[0].content",
		make: ascii,
	},
];

describe("limits: strings (exact limit passes, limit+1 fails)", () => {
	test.each(STRING_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const make = c.make ?? exactBytes;
		const atLimit = make(c.limit);
		expect(utf8ByteLength(atLimit)).toBe(c.limit);
		const ok = baseInput();
		c.set(ok, atLimit);
		expect(() => parse(ok)).not.toThrow();

		const over = baseInput();
		c.set(over, `${atLimit}a`);
		expect(codeAndPath(() => parse(over))).toEqual({
			code: "STRING_TOO_LONG",
			path: c.path,
		});
	});

	test("maxItemTextBytes: 5461 wide chars + 'a' = 16384 passes; +1 'a' fails", () => {
		const ok = baseInput();
		item(ok).text = `${"あ".repeat(5461)}a`;
		expect(utf8ByteLength(item(ok).text)).toBe(16384);
		expect(() => parse(ok)).not.toThrow();
		item(ok).text += "a";
		expect(codeAndPath(() => parse(ok)).code).toBe("STRING_TOO_LONG");
	});

	test("length is measured in UTF-8 bytes, not UTF-16 units", () => {
		const input = baseInput();
		// 86 chars * 3 bytes = 258 bytes > 256 but only 86 UTF-16 units
		input.access.principal = "あ".repeat(86);
		expect(codeAndPath(() => parse(input)).code).toBe("STRING_TOO_LONG");
	});

	test("namespace segment of an item id is bounded by maxNamespaceBytes", () => {
		const input = baseInput();
		item(input).id = `${ascii(LIMITS.maxNamespaceBytes)}:x`;
		expect(() => parse(input)).not.toThrow();
		item(input).id = `${ascii(LIMITS.maxNamespaceBytes + 1)}:x`;
		expect(codeAndPath(() => parse(input)).code).toBe("INVALID_ID_FORMAT");
	});

	test("maxBytes of range endpoints is maxSourceContentBytes", () => {
		const input = baseInput();
		const range = item(input, 1).primarySource.range;
		range.endByte = LIMITS.maxSourceContentBytes;
		item(input, 1).dependencies[1].range.endByte = LIMITS.maxSourceContentBytes;
		expect(() => parse(input)).not.toThrow();
		range.endByte = LIMITS.maxSourceContentBytes + 1;
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "INVALID_INTEGER",
			path: "$.snapshot.items[1].primarySource.range.endByte",
		});
	});
});

describe("limits: counts", () => {
	const sourceWith = (index: number, content?: string) => ({
		namespace: "conversation",
		kind: "message",
		id: `n${index}`,
		revision: "r",
		digest: "a".repeat(64),
		principal: "local:owner",
		scopeKey: "conversation:c1",
		status: "available",
		...(content === undefined ? {} : { content }),
	});

	test("maxScopeKeys", () => {
		const input = baseInput();
		input.access.scopeKeys = Array.from(
			{ length: LIMITS.maxScopeKeys },
			(_, i) => `k${i}`,
		);
		expect(() => parse(input)).not.toThrow();
		input.access.scopeKeys.push("extra");
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "ARRAY_TOO_LONG",
			path: "$.access.scopeKeys",
		});
	});

	test("maxSources", () => {
		const input = baseInput();
		input.snapshot.items = [];
		input.snapshot.sources = Array.from({ length: LIMITS.maxSources }, (_, i) =>
			sourceWith(i),
		);
		expect(() => parse(input)).not.toThrow();
		input.snapshot.sources.push(sourceWith(LIMITS.maxSources));
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "ARRAY_TOO_LONG",
			path: "$.snapshot.sources",
		});
	});

	test("maxItems", () => {
		const input = baseInput();
		const template = item(input);
		const make = (i: number) => ({ ...template, id: `a:${i}` });
		input.snapshot.items = Array.from({ length: LIMITS.maxItems }, (_, i) =>
			make(i),
		);
		expect(() => parse(input)).not.toThrow();
		input.snapshot.items.push(make(LIMITS.maxItems));
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "ARRAY_TOO_LONG",
			path: "$.snapshot.items",
		});
	});

	test("maxDependenciesPerItem", () => {
		const input = baseInput();
		const ref = (i: number) => ({ ...item(input).primarySource, id: `d${i}` });
		const deps = Array.from({ length: LIMITS.maxDependenciesPerItem }, (_, i) =>
			ref(i),
		);
		item(input).primarySource = deps[0];
		item(input).dependencies = deps;
		expect(() => parse(input)).not.toThrow();
		deps.push(ref(LIMITS.maxDependenciesPerItem));
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "ARRAY_TOO_LONG",
			path: "$.snapshot.items[0].dependencies",
		});
	});

	test("maxTotalSourceContentBytes (sum of content bytes)", () => {
		const input = baseInput();
		input.snapshot.items = [];
		const mib = "a".repeat(LIMITS.maxSourceContentBytes);
		const count =
			LIMITS.maxTotalSourceContentBytes / LIMITS.maxSourceContentBytes;
		input.snapshot.sources = Array.from({ length: count }, (_, i) =>
			sourceWith(i, mib),
		);
		expect(() => parse(input)).not.toThrow();
		input.snapshot.sources.push(sourceWith(count, "a"));
		expect(codeAndPath(() => parse(input))).toEqual({
			code: "TOTAL_CONTENT_TOO_LARGE",
			path: "$.snapshot.sources",
		});
	});

	test("array length is checked before element validation", () => {
		const input = baseInput();
		input.access.scopeKeys = Array.from(
			{ length: LIMITS.maxScopeKeys + 1 },
			() => 1,
		);
		expect(codeAndPath(() => parse(input)).code).toBe("ARRAY_TOO_LONG");
	});
});

describe("string kinds", () => {
	test.each([
		[
			"control char in identifier",
			(i: any) => (i.access.principal = "a\u0001b"),
			"INVALID_STRING",
		],
		[
			"DEL in identifier",
			(i: any) => (i.access.purpose = "a\u007fb"),
			"INVALID_STRING",
		],
		[
			"newline in identifier",
			(i: any) => (i.snapshot.stateRevision = "1\n"),
			"INVALID_STRING",
		],
		[
			"lone surrogate in identifier",
			(i: any) => (i.access.principal = "a\ud800"),
			"INVALID_STRING",
		],
		[
			"lone low surrogate in text",
			(i: any) => (item(i).text = "a\udc00b"),
			"INVALID_STRING",
		],
		[
			"lone surrogate in content",
			(i: any) => (i.snapshot.sources[0].content = "\ud800"),
			"INVALID_STRING",
		],
		["empty identifier", (i: any) => (i.access.principal = ""), "EMPTY_STRING"],
		["empty item text", (i: any) => (item(i).text = ""), "EMPTY_STRING"],
		[
			"uppercase namespace",
			(i: any) => (i.snapshot.sources[0].namespace = "Conversation"),
			"INVALID_ID_FORMAT",
		],
		[
			"digit-leading kind",
			(i: any) => (i.snapshot.sources[0].kind = "1msg"),
			"INVALID_ID_FORMAT",
		],
		[
			"item id with empty local part",
			(i: any) => (item(i).id = "continuity:"),
			"INVALID_ID_FORMAT",
		],
		[
			"item id starting with colon",
			(i: any) => (item(i).id = ":x"),
			"INVALID_ID_FORMAT",
		],
		[
			"item id with uppercase namespace",
			(i: any) => (item(i).id = "Continuity:x"),
			"INVALID_ID_FORMAT",
		],
		[
			"short digest",
			(i: any) => (i.snapshot.sources[0].digest = "abc"),
			"INVALID_DIGEST",
		],
		[
			"non-hex digest",
			(i: any) => (i.snapshot.sources[0].digest = "g".repeat(64)),
			"INVALID_DIGEST",
		],
		[
			"number as identifier",
			(i: any) => (i.access.principal = 1),
			"INVALID_TYPE",
		],
		[
			"numeric revision",
			(i: any) => (i.snapshot.stateRevision = 7),
			"INVALID_TYPE",
		],
		["string as boolean", (i: any) => (i.enabled = "true"), "INVALID_TYPE"],
		[
			"non-boolean complete",
			(i: any) => (i.snapshot.complete = 1),
			"INVALID_TYPE",
		],
		["boolean as number", (i: any) => (i.maxBytes = true), "INVALID_TYPE"],
		["NaN maxBytes", (i: any) => (i.maxBytes = Number.NaN), "INVALID_INTEGER"],
		[
			"Infinity maxBytes",
			(i: any) => (i.maxBytes = Number.POSITIVE_INFINITY),
			"INVALID_INTEGER",
		],
		[
			"inactive-only enum for status",
			(i: any) => (item(i).status = "deleted"),
			"INVALID_ENUM",
		],
		[
			"source status enum",
			(i: any) => (i.snapshot.sources[0].status = "ok"),
			"INVALID_ENUM",
		],
		[
			"text may contain newline and tab (control chars allowed)",
			(i: any) => (item(i).text = "a\nb\tc"),
			"OK",
		],
		[
			"empty content is allowed",
			(i: any) => (i.snapshot.sources[0].content = ""),
			"OK",
		],
	])("%s", (_name, mutate, expected) => {
		const input = baseInput();
		mutate(input);
		if (expected === "OK") {
			expect(() => parse(input)).not.toThrow();
		} else {
			expect(codeAndPath(() => parse(input)).code).toBe(expected);
		}
	});

	test("reversed range and negative range values", () => {
		const input = baseInput();
		const range = item(input, 1).primarySource.range;
		range.startByte = 9;
		range.endByte = 3;
		expect(codeAndPath(() => parse(input)).code).toBe("INVALID_RANGE");
		range.startByte = -1;
		expect(codeAndPath(() => parse(input)).code).toBe("INVALID_INTEGER");
	});

	test("same source key with different range is not a duplicate dependency", () => {
		const input = baseInput();
		const primary = item(input, 1).primarySource;
		item(input, 1).dependencies = [
			primary,
			{ ...primary, range: { startByte: 3, endByte: 6 } },
		];
		expect(() => parse(input)).not.toThrow();
	});

	test("inactive items are still schema-checked", () => {
		const input = baseInput();
		item(input).status = "inactive";
		item(input).kind = "fact";
		expect(codeAndPath(() => parse(input)).code).toBe("INVALID_ENUM");
	});
});
