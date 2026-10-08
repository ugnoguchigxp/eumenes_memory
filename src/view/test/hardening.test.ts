import { describe, expect, test } from "bun:test";
import { baseInput, baseView } from "../../contracts/test/base.ts";
import { LIMITS } from "../../contracts/constants.ts";
import { isMemoryContractError } from "../../contracts/errors.ts";
import { parseBuildMemoryViewInput } from "../../contracts/parse-input.ts";
import { sourceKey } from "../../contracts/source-key.ts";
import { buildMemoryView, validateMemoryView } from "../../index.ts";
import { composeReadyBody } from "../compose.ts";
import { finalizeReadyView } from "../digest.ts";
import { compareSourceRef } from "../source-ref.ts";

const currentOf = (input: any = baseInput()) => ({
	schemaVersion: 1 as const,
	access: input.access,
	snapshot: input.snapshot,
});

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return isMemoryContractError(error) ? error.code : "OTHER";
	}
	return undefined;
}

/** 汚染の前後で比較できるよう、入力を JSON 往復で複製して build する。 */
function buildCopy(input: any) {
	return buildMemoryView(JSON.parse(JSON.stringify(input)));
}

describe("prototype pollution does not leak into optional keys", () => {
	test("build/validate results are unchanged when Object.prototype carries range/content/representation", () => {
		const expected = buildMemoryView(baseInput());
		const proto = Object.prototype as any;
		proto.range = { startByte: 0, endByte: 1 };
		proto.content = "zzz";
		proto.representation = "polluted";
		try {
			expect(buildMemoryView(baseInput())).toEqual(expected);
			expect(validateMemoryView(baseView(), currentOf())).toEqual({
				schemaVersion: 1,
				status: "valid",
				viewDigest: baseView().viewDigest,
			});
		} finally {
			delete proto.range;
			delete proto.content;
			delete proto.representation;
		}
	});

	test("sourceKey ignores an inherited representation", () => {
		const ref = {
			namespace: "n",
			kind: "k",
			id: "i",
			revision: "1",
			digest: "d",
		};
		const before = sourceKey(ref);
		const proto = Object.prototype as any;
		proto.representation = "polluted";
		try {
			expect(sourceKey(ref)).toBe(before);
			expect(sourceKey(ref)).toBe(JSON.stringify(["n", "k", "i", null]));
		} finally {
			delete proto.representation;
		}
	});

	test("compareSourceRef reads representation/range as own properties only", () => {
		const base = {
			namespace: "n",
			kind: "k",
			id: "i",
			revision: "1",
			digest: "d",
		};
		const withRepresentation = { ...base, representation: "zzz" };
		const withRange = { ...base, range: { startByte: 0, endByte: 1 } };
		expect(compareSourceRef(withRepresentation, base)).toBe(1);
		expect(compareSourceRef(withRange, base)).toBe(1);
		const proto = Object.prototype as any;
		proto.representation = "zzzz";
		proto.range = { startByte: 5, endByte: 5 };
		try {
			expect(compareSourceRef(withRepresentation, base)).toBe(1);
			expect(compareSourceRef(withRange, base)).toBe(1);
		} finally {
			delete proto.representation;
			delete proto.range;
		}
	});

	test("refs without a representation do not pick one up from the prototype", () => {
		const strip = (value: any): any => {
			if (Array.isArray(value)) return value.map(strip);
			if (value !== null && typeof value === "object") {
				return Object.fromEntries(
					Object.entries(value)
						.filter(([key]) => key !== "representation")
						.map(([key, v]) => [key, strip(v)]),
				);
			}
			return value;
		};
		const input = strip(baseInput());
		const expected = buildCopy(input);
		const proto = Object.prototype as any;
		proto.representation = "polluted";
		try {
			const polluted = buildCopy(input);
			expect(polluted).toEqual(expected);
			expect(JSON.stringify(polluted)).not.toContain("polluted");
		} finally {
			delete proto.representation;
		}
	});

	test("dependency identity ignores an inherited range", () => {
		const input = baseInput();
		const item = input.snapshot.items.find(
			(i: any) => i.primarySource.range !== undefined,
		);
		const { range, ...withoutRange } = item.primarySource;
		item.dependencies.push(withoutRange);
		expect(() => parseBuildMemoryViewInput(input)).not.toThrow();
		const proto = Object.prototype as any;
		proto.range = range;
		try {
			expect(() => parseBuildMemoryViewInput(input)).not.toThrow();
		} finally {
			delete proto.range;
		}
	});

	test("an inherited content larger than the total limit does not count", () => {
		const input = baseInput();
		const template = input.snapshot.sources.find(
			(source: any) => source.content === undefined,
		);
		// 継承された 1 MiB の content を拾う content なし source を、合計上限を超える数だけ足す。
		const extra =
			Math.ceil(
				LIMITS.maxTotalSourceContentBytes / LIMITS.maxSourceContentBytes,
			) + 1;
		for (let i = 0; i < extra; i++) {
			input.snapshot.sources.push({ ...template, id: `extra-${i}` });
		}
		const expected = buildCopy(input);
		const proto = Object.prototype as any;
		proto.content = "x".repeat(LIMITS.maxSourceContentBytes);
		try {
			expect(buildCopy(input)).toEqual(expected);
		} finally {
			delete proto.content;
		}
	});

	test("an accessor is still rejected when Object.prototype carries `value`", () => {
		const input = baseInput();
		Object.defineProperty(input, "enabled", {
			get: () => true,
			enumerable: true,
		});
		const proto = Object.prototype as any;
		proto.value = false;
		try {
			expect(codeOf(() => buildMemoryView(input))).toBe("INVALID_PROPERTY");
		} finally {
			delete proto.value;
		}
	});

	test("an inherited `get` on Object.prototype does not leak a TypeError", () => {
		const expected = buildCopy(baseInput());
		const proto = Object.prototype as any;
		proto.get = () => 1;
		try {
			expect(buildCopy(baseInput())).toEqual(expected);
		} finally {
			delete proto.get;
		}
	});
});

describe("validateMemoryView reports source failures", () => {
	function mutatedCurrent(mutate: (source: any) => void) {
		const input = baseInput();
		// range を持つ依存が指す source（m1）を書き換える。
		mutate(input.snapshot.sources.find((s: any) => s.id === "m1"));
		return currentOf(input);
	}

	test("SOURCE_CONTENT_DIGEST_MISMATCH when content no longer hashes to the digest", () => {
		const result = validateMemoryView(
			baseView(),
			mutatedCurrent((s) => (s.content = `${s.content}x`)),
		);
		expect(result).toMatchObject({
			status: "invalid",
			reasonCode: "SOURCE_CONTENT_DIGEST_MISMATCH",
		});
	});

	test("SOURCE_CONTENT_REQUIRED when content is withdrawn but the range remains", () => {
		const result = validateMemoryView(
			baseView(),
			mutatedCurrent((s) => delete s.content),
		);
		expect(result).toMatchObject({
			status: "invalid",
			reasonCode: "SOURCE_CONTENT_REQUIRED",
		});
	});
});

describe("validateMemoryView re-checks ranges", () => {
	/** range の検査を迂回して view を作り、current と一緒に validate へ渡す。 */
	function viewWithRange(startByte: number, endByte: number) {
		const input = baseInput();
		const item = input.snapshot.items.find(
			(i: any) => i.primarySource.range !== undefined,
		);
		const original = item.primarySource.range;
		for (const ref of [item.primarySource, ...item.dependencies]) {
			if (
				ref.range !== undefined &&
				ref.range.startByte === original.startByte &&
				ref.range.endByte === original.endByte
			) {
				ref.range = { startByte, endByte };
			}
		}
		const parsed = parseBuildMemoryViewInput(input);
		const body = composeReadyBody(parsed.access, parsed.snapshot);
		return { view: finalizeReadyView(body).view, current: currentOf(input) };
	}

	test("SOURCE_RANGE_OUT_OF_BOUNDS", () => {
		const { view, current } = viewWithRange(0, 9999);
		expect(validateMemoryView(view, current)).toMatchObject({
			status: "invalid",
			reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
		});
	});

	test("SOURCE_RANGE_NOT_CHAR_BOUNDARY (inside a 3-byte character)", () => {
		const { view, current } = viewWithRange(1, 3);
		expect(validateMemoryView(view, current)).toMatchObject({
			status: "invalid",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		});
	});
});

describe("lone surrogates are rejected everywhere", () => {
	test("in a view passed to validateMemoryView", () => {
		for (const mutate of [
			(v: any) => (v.principal = "a\ud800"),
			(v: any) => (v.items[0].text = "\udc00"),
			(v: any) => (v.items[0].id = "x\ud800y"),
			(v: any) => (v.dependencies[0].id = "\udc00x"),
		]) {
			const view = baseView();
			mutate(view);
			expect(codeOf(() => validateMemoryView(view, currentOf()))).toBe(
				"INVALID_STRING",
			);
		}
	});

	test("in access.scopeKeys elements and source id/revision/representation", () => {
		for (const mutate of [
			(i: any) => (i.access.scopeKeys[0] = "\ud800"),
			(i: any) => (i.snapshot.sources[0].id = "m\udc00"),
			(i: any) => (i.snapshot.sources[0].revision = "\ud800"),
			(i: any) => (i.snapshot.sources[0].representation = "t\ud800"),
		]) {
			const input = baseInput();
			mutate(input);
			expect(codeOf(() => buildMemoryView(input))).toBe("INVALID_STRING");
		}
	});
});

describe("coverage.omitted is bounded", () => {
	test("maxCoverageOmitted entries -> INVALID_VALUE, one more -> ARRAY_TOO_LONG", () => {
		for (const [length, code] of [
			[LIMITS.maxCoverageOmitted, "INVALID_VALUE"],
			[LIMITS.maxCoverageOmitted + 1, "ARRAY_TOO_LONG"],
		] as const) {
			const view = baseView();
			view.coverage.omitted = Array.from({ length }, () => 0);
			expect(codeOf(() => validateMemoryView(view, currentOf()))).toBe(code);
		}
	});

	test("a huge omitted array is rejected without being scanned", () => {
		const view = baseView();
		view.coverage.omitted = Array.from({ length: 5_000_000 }, () => 0);
		const started = performance.now();
		expect(codeOf(() => validateMemoryView(view, currentOf()))).toBe(
			"ARRAY_TOO_LONG",
		);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe("v1 never relaxes range checks for Memory-owned sources", () => {
	test("a memory-namespace source with a range but no content is SOURCE_CONTENT_REQUIRED in v1 (only v2 pins ranges by revision and digest)", () => {
		const input = baseInput();
		const retarget = (ref: any) => {
			if (ref.id === "m1") ref.namespace = "memory";
		};
		for (const item of input.snapshot.items) {
			retarget(item.primarySource);
			for (const dependency of item.dependencies) retarget(dependency);
		}
		for (const source of input.snapshot.sources) {
			if (source.id === "m1") {
				source.namespace = "memory";
				delete source.content;
			}
		}
		// 対照: 本文が付いていれば範囲は検査されて通る
		const withContent = JSON.parse(JSON.stringify(input));
		withContent.snapshot.sources.find((s: any) => s.id === "m1").content =
			"目的は来週までにM0を完成させる。😀";
		expect(buildMemoryView(withContent)).toMatchObject({ status: "ready" });
		expect(buildMemoryView(input)).toMatchObject({
			status: "blocked",
			reasonCode: "SOURCE_CONTENT_REQUIRED",
		});
	});
});
