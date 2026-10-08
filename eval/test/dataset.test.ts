/** 評価データの整合検査。`bun test eval/test`（`bun run verify` には入れていない）。 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	LIMITS_EXTRACTION,
	parseExtractionOutput,
	STATE_KINDS,
} from "eumenes-memory";
import {
	DATASET_PATH,
	goldToOutput,
	loadDataset,
	parseCase,
	parseDataset,
	sourcesSignature,
	spanToBytes,
} from "../lib/dataset.ts";
import { CATEGORIES } from "../lib/types.ts";

const cases = loadDataset();

describe("dataset shape", () => {
	test("every category has at least 8 cases and no unknown category exists", () => {
		const counts = new Map<string, number>();
		for (const evalCase of cases) {
			counts.set(evalCase.category, (counts.get(evalCase.category) ?? 0) + 1);
		}
		for (const category of CATEGORIES) {
			expect(counts.get(category) ?? 0).toBeGreaterThanOrEqual(8);
		}
		expect([...counts.keys()].sort()).toEqual([...CATEGORIES].sort());
	});

	test("ids are unique and carry the category prefix; source texts are unique", () => {
		const ids = new Set<string>();
		const signatures = new Set<string>();
		for (const evalCase of cases) {
			expect(ids.has(evalCase.id)).toBe(false);
			ids.add(evalCase.id);
			expect(evalCase.id).toMatch(/^[a-z]+-\d{2}$/u);
			const signature = sourcesSignature(evalCase.sources);
			expect(signatures.has(signature)).toBe(false);
			signatures.add(signature);
		}
	});

	test("every category has both dev and test cases", () => {
		for (const category of CATEGORIES) {
			for (const split of ["dev", "test"] as const) {
				expect(
					cases.filter((c) => c.category === category && c.split === split)
						.length,
				).toBeGreaterThanOrEqual(3);
			}
		}
	});

	test("the dataset is marked as not human reviewed (results stay provisional)", () => {
		expect(cases.every((evalCase) => !evalCase.humanReviewed)).toBe(true);
	});

	test("all text is synthetic: no URL, e-mail address, phone number or long digit run", () => {
		for (const evalCase of cases) {
			for (const source of evalCase.sources) {
				expect(source.content).not.toMatch(/https?:\/\/|www\./u);
				expect(source.content).not.toMatch(/\S+@\S+\.\S+/u);
				expect(source.content).not.toMatch(/\d{3}-\d{3,4}-\d{4}|\d{7,}/u);
			}
		}
	});

	test("the file ends with a newline and every line parses on its own", () => {
		const text = readFileSync(DATASET_PATH, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(parseDataset(text).length).toBe(cases.length);
	});
});

describe("gold is consistent with the extraction contract", () => {
	test("every gold converts to an output that the strict parser accepts", () => {
		for (const evalCase of cases) {
			const output = goldToOutput(evalCase);
			const parsed = parseExtractionOutput(output);
			expect(parsed.ok).toBe(true);
			expect(output.noChange).toBe(evalCase.expect.noChange);
			expect(output.candidates.length).toBeLessThanOrEqual(
				LIMITS_EXTRACTION.maxCandidates,
			);
		}
	});

	test("kind, subject and modality combinations are those Admission can reason about", () => {
		for (const evalCase of cases) {
			for (const gold of evalCase.expect.candidates) {
				expect(STATE_KINDS).toContain(gold.kind);
				// other_person_note と other の subject は対（SUBJECT_KIND_MISMATCH を避ける）。
				expect(gold.kind === "other_person_note").toBe(
					gold.subject === "other",
				);
				expect(gold.spans.length).toBeLessThanOrEqual(
					LIMITS_EXTRACTION.maxEvidencePerCandidate,
				);
				for (const span of gold.spans) {
					// 根拠は user の発言（assistant / tool を根拠にした候補は NOT_USER_SOURCE になる）。
					expect(evalCase.sources[span.source]?.role).toBe("user");
				}
			}
		}
	});

	test("gold spans: quote is exact, spans of different candidates and tolerated spans do not overlap", () => {
		for (const evalCase of cases) {
			const ranges = evalCase.expect.candidates.map((gold) =>
				gold.spans.map((span) => spanToBytes(evalCase.sources, span)),
			);
			const tolerated = (evalCase.tolerated ?? []).map((span) =>
				spanToBytes(evalCase.sources, span),
			);
			const overlaps = (
				a: ReturnType<typeof spanToBytes>,
				b: ReturnType<typeof spanToBytes>,
			) =>
				a.source === b.source &&
				a.startByte < b.endByte &&
				b.startByte < a.endByte;
			for (const [i, left] of ranges.entries()) {
				for (const span of left) {
					const bytes = new TextEncoder().encode(
						evalCase.sources[span.source]?.content ?? "",
					);
					expect(
						new TextDecoder().decode(bytes.slice(span.startByte, span.endByte)),
					).toBe(span.quote);
					for (const other of tolerated) {
						expect(overlaps(span, other)).toBe(false);
					}
				}
				for (const right of ranges.slice(i + 1)) {
					for (const a of left) {
						for (const b of right) expect(overlaps(a, b)).toBe(false);
					}
				}
			}
		}
	});

	test("acceptNoChange and tolerated are only used where they make sense", () => {
		for (const evalCase of cases) {
			if (evalCase.acceptNoChange === true) {
				expect(evalCase.expect.noChange).toBe(false);
			}
			if (evalCase.tolerated !== undefined) {
				expect(evalCase.tolerated.length).toBeGreaterThan(0);
				expect(evalCase.expect.noChange).toBe(false);
			}
		}
	});

	test("the categories carry the expectations their name promises", () => {
		const of = (category: string) =>
			cases.filter((evalCase) => evalCase.category === category);
		expect(of("no_change").every((c) => c.expect.noChange)).toBe(true);
		for (const evalCase of of("hypothetical")) {
			expect(
				evalCase.expect.candidates.every((c) => c.modality === "hypothetical"),
			).toBe(true);
		}
		for (const evalCase of of("hearsay")) {
			expect(
				evalCase.expect.candidates.every((c) => c.modality === "reported"),
			).toBe(true);
		}
		for (const evalCase of of("quote")) {
			expect(
				evalCase.expect.candidates.every((c) => c.modality === "quoted"),
			).toBe(true);
		}
		for (const evalCase of of("past_future")) {
			expect(
				evalCase.expect.candidates.every((c) => c.temporal !== "current"),
			).toBe(true);
		}
		expect(
			of("negation").some((c) =>
				c.expect.candidates.some((g) => g.polarity === "negated"),
			),
		).toBe(true);
		expect(
			of("other_person").every((c) =>
				c.expect.candidates.some((g) => g.subject === "other"),
			),
		).toBe(true);
	});
});

describe("parseCase rejects malformed cases", () => {
	const base = cases[0];
	test("unknown key, wrong category, quote not in source, noChange mismatch", () => {
		if (base === undefined) throw new Error("dataset is empty");
		expect(() => parseCase({ ...base, extra: 1 })).toThrow();
		expect(() => parseCase({ ...base, category: "nope" })).toThrow();
		expect(() =>
			parseCase({
				...base,
				expect: {
					noChange: false,
					candidates: [
						{
							...base.expect.candidates[0],
							spans: [{ source: 0, quote: "存在しない文字列" }],
						},
					],
				},
			}),
		).toThrow();
		expect(() =>
			parseCase({ ...base, expect: { ...base.expect, noChange: true } }),
		).toThrow();
	});

	test("duplicate ids are rejected", () => {
		const line = JSON.stringify(cases[0]);
		expect(() => parseDataset(`${line}\n${line}\n`)).toThrow(/duplicate id/u);
	});
});
