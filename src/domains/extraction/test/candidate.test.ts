import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../canonical/json.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { LIMITS_EXTRACTION } from "../contracts/index.ts";
import { digestOutput, parseExtractionOutput } from "../service/candidate.ts";
import { candidateIdOf, runIdOf } from "../service/ids.ts";
import {
	EXTRACTION_OUTPUT_SCHEMA,
	buildExtractionPromptMaterial,
} from "../service/prompt.ts";

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		kind: "preference",
		subject: "self",
		semanticKey: "drink",
		value: { text: "コーヒー", polarity: "affirmed" },
		modality: "asserted",
		temporal: "current",
		evidence: [{ sourceIndex: 0, startByte: 0, endByte: 3, quote: "私" }],
		...overrides,
	};
}

function bytesOf(output: unknown): number {
	return digestOutput(output)?.bytes ?? Number.POSITIVE_INFINITY;
}

function reasonOf(output: unknown): string | null {
	const parsed = parseExtractionOutput(output);
	return parsed.ok ? null : parsed.reasonCode;
}

describe("parseExtractionOutput", () => {
	test("accepts a well-formed output and returns the canonical digest", () => {
		const output = {
			noChange: false,
			candidates: [candidate({ replaces: "state:x" })],
		};
		const parsed = parseExtractionOutput(output);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.output.candidates[0]?.replaces).toBe("state:x");
		expect(parsed.digest).toBe(sha256Hex(canonicalJson(output)));
		// キーの順序に依存しない。
		const reordered = {
			candidates: [{ ...candidate({ replaces: "state:x" }) }].map((c) =>
				Object.fromEntries(Object.entries(c).reverse()),
			),
			noChange: false,
		};
		expect(parseExtractionOutput(reordered)).toEqual(parsed);
		expect(digestOutput(output)?.digest).toBe(parsed.digest);
	});

	test("noChange is equivalent to an empty candidate list", () => {
		expect(parseExtractionOutput({ noChange: true, candidates: [] }).ok).toBe(
			true,
		);
		expect(reasonOf({ noChange: false, candidates: [] })).toBe("OUTPUT_SCHEMA");
		expect(reasonOf({ noChange: true, candidates: [candidate()] })).toBe(
			"OUTPUT_SCHEMA",
		);
	});

	test("more than the maximum number of candidates is TOO_MANY_CANDIDATES (even when small)", () => {
		const candidates = Array.from(
			{ length: LIMITS_EXTRACTION.maxCandidates + 1 },
			() => candidate({ evidence: [] }),
		);
		expect(reasonOf({ noChange: false, candidates })).toBe(
			"TOO_MANY_CANDIDATES",
		);
		expect(
			reasonOf({
				noChange: false,
				candidates: candidates.slice(0, LIMITS_EXTRACTION.maxCandidates),
			}),
		).toBe(null);
	});

	test("the 16 KiB canonical limit is exact", () => {
		const sizeFor = (padding: number) => ({
			noChange: false,
			candidates: [
				candidate({
					value: { text: "あ".repeat(padding), polarity: "affirmed" },
				}),
			],
		});
		let low = 1;
		while (bytesOf(sizeFor(low + 1)) <= LIMITS_EXTRACTION.maxOutputBytes) {
			low += 1;
			if (low > 6000) throw new Error("runaway");
		}
		expect(digestOutput(sizeFor(low))?.bytes).toBeLessThanOrEqual(
			LIMITS_EXTRACTION.maxOutputBytes,
		);
		expect(reasonOf(sizeFor(low))).toBe(null);
		expect(reasonOf(sizeFor(low + 1))).toBe("OUTPUT_TOO_LARGE");
	});

	test.each([
		["scope", { scope: "conversation:c1" }],
		["confidence", { confidence: 0.9 }],
		["status", { status: "active" }],
		["origin", { origin: "user_confirmed" }],
		["any unknown key", { note: "x" }],
	])("a candidate carrying %s rejects the whole output", (_name, extra) => {
		expect(reasonOf({ noChange: false, candidates: [candidate(extra)] })).toBe(
			"OUTPUT_SCHEMA",
		);
	});

	test.each([
		["not an object", "text"],
		["null", null],
		["array", []],
		["missing candidates", { noChange: true }],
		["unknown top-level key", { noChange: true, candidates: [], extra: 1 }],
		["noChange not boolean", { noChange: "true", candidates: [] }],
		["candidates not array", { noChange: true, candidates: {} }],
		[
			"non-integer number",
			{
				noChange: false,
				candidates: [
					candidate({ value: { text: "a", polarity: "affirmed", n: 1.5 } }),
				],
			},
		],
		["undefined member", { noChange: true, candidates: [], extra: undefined }],
		[
			"kind not a string",
			{ noChange: false, candidates: [candidate({ kind: 1 })] },
		],
		[
			"value missing polarity",
			{ noChange: false, candidates: [candidate({ value: { text: "a" } })] },
		],
		[
			"evidence element with unknown key",
			{
				noChange: false,
				candidates: [
					candidate({
						evidence: [
							{ sourceIndex: 0, startByte: 0, endByte: 1, quote: "a", x: 1 },
						],
					}),
				],
			},
		],
		[
			"evidence start not a number",
			{
				noChange: false,
				candidates: [
					candidate({
						evidence: [
							{ sourceIndex: 0, startByte: "0", endByte: 1, quote: "a" },
						],
					}),
				],
			},
		],
		[
			"replaces null",
			{ noChange: false, candidates: [candidate({ replaces: null })] },
		],
		["candidate not an object", { noChange: false, candidates: ["x"] }],
	])("a malformed output (%s) is OUTPUT_SCHEMA", (_name, output) => {
		expect(reasonOf(output)).toBe("OUTPUT_SCHEMA");
	});

	test("getters, symbols, prototypes, cycles and deep nesting are OUTPUT_SCHEMA", () => {
		const withGetter = { noChange: true };
		Object.defineProperty(withGetter, "candidates", {
			enumerable: true,
			get: () => [],
		});
		expect(reasonOf(withGetter)).toBe("OUTPUT_SCHEMA");
		expect(reasonOf(Object.create({ noChange: true, candidates: [] }))).toBe(
			"OUTPUT_SCHEMA",
		);
		const cyclic: Record<string, unknown> = { noChange: true, candidates: [] };
		cyclic["self"] = cyclic;
		expect(reasonOf(cyclic)).toBe("OUTPUT_SCHEMA");
		let deep: unknown = "x";
		for (let i = 0; i < 100; i += 1) deep = { a: deep };
		expect(reasonOf({ noChange: true, candidates: [], deep })).toBe(
			"OUTPUT_SCHEMA",
		);
		expect(reasonOf({ noChange: true, candidates: [], [Symbol("s")]: 1 })).toBe(
			"OUTPUT_SCHEMA",
		);
		expect(parseExtractionOutput(cyclic)).toMatchObject({ digest: null });
	});

	test("accessors, exotic prototypes and array oddities are rejected at every depth, not only at the top level", () => {
		const ok = { noChange: false, candidates: [candidate()] };
		expect(reasonOf(ok)).toBeNull();

		// 入れ子の getter（候補・value・evidence の要素）
		const nestedGetter = candidate();
		Object.defineProperty(nestedGetter, "kind", {
			enumerable: true,
			get: () => "preference",
		});
		expect(reasonOf({ noChange: false, candidates: [nestedGetter] })).toBe(
			"OUTPUT_SCHEMA",
		);
		const valueGetter = { polarity: "affirmed" };
		Object.defineProperty(valueGetter, "text", {
			enumerable: true,
			get: () => "x",
		});
		expect(
			reasonOf({
				noChange: false,
				candidates: [candidate({ value: valueGetter })],
			}),
		).toBe("OUTPUT_SCHEMA");
		const evidenceGetter = { sourceIndex: 0, startByte: 0, endByte: 3 };
		Object.defineProperty(evidenceGetter, "quote", {
			enumerable: true,
			get: () => "私",
		});
		expect(
			reasonOf({
				noChange: false,
				candidates: [candidate({ evidence: [evidenceGetter] })],
			}),
		).toBe("OUTPUT_SCHEMA");

		// 非 plain な prototype（クラスのインスタンス・Map・Date）
		class Candidate {
			kind = "preference";
		}
		for (const exotic of [
			Object.assign(new Candidate(), candidate()),
			new Map([["kind", "preference"]]),
			new Date(0),
			Object.create({ inherited: 1 }),
		]) {
			expect(reasonOf({ noChange: false, candidates: [exotic] })).toBe(
				"OUTPUT_SCHEMA",
			);
		}
		expect(
			reasonOf({
				noChange: false,
				candidates: [candidate({ value: new Candidate() })],
			}),
		).toBe("OUTPUT_SCHEMA");
		// prototype が null の plain なオブジェクトは JSON の値として扱える
		const nullProto = Object.assign(Object.create(null), candidate());
		expect(reasonOf({ noChange: false, candidates: [nullProto] })).toBeNull();

		// 配列: getter の要素・index 以外のプロパティ・穴・symbol
		const arrayWithGetter = [candidate()];
		Object.defineProperty(arrayWithGetter, "0", {
			enumerable: true,
			get: () => candidate(),
		});
		expect(reasonOf({ noChange: false, candidates: arrayWithGetter })).toBe(
			"OUTPUT_SCHEMA",
		);
		const arrayWithExtra = Object.assign([candidate()], { extra: 1 });
		expect(reasonOf({ noChange: false, candidates: arrayWithExtra })).toBe(
			"OUTPUT_SCHEMA",
		);
		// eslint-disable-next-line no-sparse-arrays
		const sparse = [candidate(), , candidate()];
		expect(reasonOf({ noChange: false, candidates: sparse })).toBe(
			"OUTPUT_SCHEMA",
		);
		const arrayWithSymbol = Object.assign([candidate()], {
			[Symbol("s")]: 1,
		});
		expect(reasonOf({ noChange: false, candidates: arrayWithSymbol })).toBe(
			"OUTPUT_SCHEMA",
		);
		const evidenceArrayWithGetter = [
			{ sourceIndex: 0, startByte: 0, endByte: 3, quote: "私" },
		];
		Object.defineProperty(evidenceArrayWithGetter, "0", {
			enumerable: true,
			get: () => ({ sourceIndex: 0, startByte: 0, endByte: 3, quote: "私" }),
		});
		expect(
			reasonOf({
				noChange: false,
				candidates: [candidate({ evidence: evidenceArrayWithGetter })],
			}),
		).toBe("OUTPUT_SCHEMA");

		// JSON でない値
		for (const bad of [
			undefined,
			null,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			10n,
			() => 1,
			Symbol("x"),
		]) {
			expect(
				reasonOf({
					noChange: false,
					candidates: [candidate({ semanticKey: bad })],
				}),
			).toBe("OUTPUT_SCHEMA");
		}
		// digest も同じ入力から作れない（null）
		expect(
			digestOutput({ noChange: false, candidates: [nestedGetter] }),
		).toBeNull();
	});

	test("a huge flat array is rejected as too large without canonicalising it", () => {
		const output = {
			noChange: false,
			candidates: Array.from({ length: 100000 }, () => 1),
		};
		expect(reasonOf(output)).toBe("OUTPUT_TOO_LARGE");
	});

	test("value problems are left to Admission: unknown kind / modality / empty evidence still parse", () => {
		const parsed = parseExtractionOutput({
			noChange: false,
			candidates: [
				candidate({
					kind: "mood",
					modality: "maybe",
					subject: "x",
					evidence: [],
				}),
			],
		});
		expect(parsed.ok).toBe(true);
	});

	test("lone surrogates are kept (and have a stable digest)", () => {
		const output = {
			noChange: false,
			candidates: [candidate({ semanticKey: "k\ud800" })],
		};
		const parsed = parseExtractionOutput(output);
		expect(parsed.ok).toBe(true);
		expect(parsed.digest).toBe(parseExtractionOutput(output).digest);
	});
});

describe("ids and prompt material", () => {
	test("runId and candidateId follow the contract", () => {
		expect(runIdOf({ jobId: "job:a", attempt: 3 })).toBe("job:a:3");
		expect(candidateIdOf("job:a:3", 0)).toBe(
			`cand:${sha256Hex(canonicalJson(["job:a:3", 0]))}`,
		);
		expect(candidateIdOf("job:a:3", 0)).not.toBe(candidateIdOf("job:a:3", 1));
	});

	test("prompt material is pure, versioned, JSON-able, and forbids authority fields", () => {
		const a = buildExtractionPromptMaterial("p1");
		const b = buildExtractionPromptMaterial("p1");
		expect(a).toEqual(b);
		expect(buildExtractionPromptMaterial("p2").promptVersion).toBe("p2");
		expect(JSON.parse(JSON.stringify(a))).toEqual(a);
		const schema = EXTRACTION_OUTPUT_SCHEMA as {
			properties: {
				candidates: {
					items: { properties: object; additionalProperties: boolean };
				};
			};
		};
		const properties = Object.keys(
			schema.properties.candidates.items.properties,
		);
		for (const forbidden of ["scope", "confidence", "status", "origin"]) {
			expect(properties).not.toContain(forbidden);
		}
		expect(schema.properties.candidates.items.additionalProperties).toBe(false);
		expect(a.instructions).toContain("negated");
	});
});
