import { describe, expect, test } from "bun:test";
import { MemoryContractError } from "../../src/contracts/errors.ts";
import { parseConfirmCandidateInput } from "../../src/domains/extraction/index.ts";
import {
	ACCESS,
	SCOPE,
	assertInput,
	COFFEE,
	editInput,
	makeSpan,
	targetInput,
	value,
} from "../../src/domains/state/testing.ts";
import {
	parseAssertUserStateInput,
	parseEditStateInput,
	parseListStateInput,
	parseReadSnapshotPartInput,
	parseStateTargetInput,
} from "../../src/domains/state/index.ts";

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof MemoryContractError) return error.code;
		throw error;
	}
	return "NO_ERROR";
}

describe("state input parse", () => {
	test("accepts a valid assert and returns a frozen copy", () => {
		const parsed = parseAssertUserStateInput(assertInput());
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parsed.value.text).toBe("コーヒーが好き");
	});

	test.each([
		["unknown top-level key", { ...assertInput(), extra: 1 }, "UNKNOWN_KEY"],
		[
			"version",
			{ ...assertInput(), contractVersion: 2 },
			"UNSUPPORTED_SCHEMA_VERSION",
		],
		[
			"unknown subject",
			assertInput({ subject: "unknown" as never }),
			"INVALID_VALUE",
		],
		[
			"empty other subject",
			assertInput({ subject: "other:" as never }),
			"INVALID_VALUE",
		],
		["bad kind", assertInput({ kind: "goal" as never }), "INVALID_ENUM"],
		[
			"extraction origin",
			assertInput({ origin: "admitted_extraction" as never }),
			"INVALID_ENUM",
		],
		["no evidence", assertInput({ evidence: [] }), "INVALID_VALUE"],
		[
			"nine evidence spans",
			assertInput({
				evidence: Array.from({ length: 9 }, () =>
					makeSpan(COFFEE, "私は", "私は"),
				).map((span, i) => ({
					...span,
					source: { ...span.source, range: { startByte: 0, endByte: 6 + i } },
				})),
			}),
			"ARRAY_TOO_LONG",
		],
		[
			"duplicate evidence",
			assertInput({
				evidence: [makeSpan(COFFEE, "私は"), makeSpan(COFFEE, "私は")],
			}),
			"DUPLICATE_DEPENDENCY",
		],
		[
			"conflicting versions of one source",
			assertInput({
				evidence: [
					makeSpan(COFFEE, "私は"),
					{
						...makeSpan(COFFEE, "コーヒー"),
						source: {
							...makeSpan(COFFEE, "コーヒー").source,
							digest: "0".repeat(64),
						},
					},
				],
			}),
			"CONFLICTING_DEPENDENCY",
		],
		[
			"too many attributes",
			assertInput({
				value: value(
					"x",
					"affirmed",
					Object.fromEntries(
						Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]),
					),
				),
			}),
			"ARRAY_TOO_LONG",
		],
		["empty value", assertInput({ value: value("") }), "EMPTY_STRING"],
		[
			"duplicate sources",
			assertInput({ sources: [COFFEE, COFFEE] }),
			"DUPLICATE_SOURCE",
		],
		[
			"negative ordinal",
			assertInput({ sources: [{ ...COFFEE, ordinal: -1 }] }),
			"INVALID_INTEGER",
		],
		[
			"validUntil before validFrom",
			assertInput({ validFromMs: 9, validUntilMs: 3 }),
			"INVALID_VALUE",
		],
	])("assert rejects %s", (_name, input, code) => {
		expect(codeOf(() => parseAssertUserStateInput(input))).toBe(code);
	});

	test("edit / target / list / snapshot inputs", () => {
		expect(parseEditStateInput(editInput("state:a", 1)).expectedRevision).toBe(
			1,
		);
		expect(codeOf(() => parseEditStateInput(editInput("state:a", 0)))).toBe(
			"INVALID_INTEGER",
		);
		expect(parseStateTargetInput(targetInput("state:a", 3)).itemId).toBe(
			"state:a",
		);
		expect(
			codeOf(() =>
				parseStateTargetInput({ ...targetInput("state:a", 3), clock: {} }),
			),
		).toBe("MISSING_KEY");
		const header = {
			contractVersion: 1,
			access: assertInput().access,
			scopeKey: "conversation:c1",
		};
		expect(
			parseListStateInput({
				...header,
				kinds: ["habit"],
				includeInactive: true,
				limit: 5,
			}).limit,
		).toBe(5);
		expect(codeOf(() => parseListStateInput({ ...header, limit: 1001 }))).toBe(
			"INVALID_INTEGER",
		);
		expect(
			codeOf(() =>
				parseListStateInput({ ...header, kinds: ["habit", "habit"] }),
			),
		).toBe("INVALID_VALUE");
		expect(
			codeOf(() => parseListStateInput({ ...header, includeInactive: "yes" })),
		).toBe("INVALID_TYPE");
		expect(parseReadSnapshotPartInput(header).scopeKey).toBe("conversation:c1");
		expect(
			codeOf(() =>
				parseReadSnapshotPartInput({ ...header, clock: { atMs: 1 } }),
			),
		).toBe("UNKNOWN_KEY");
	});
});

describe("error paths never contain attribute key names (M0: key names stay out of paths)", () => {
	function errorOf(run: () => unknown): MemoryContractError {
		try {
			run();
		} catch (error) {
			if (error instanceof MemoryContractError) return error;
			throw error;
		}
		throw new Error("expected a contract error");
	}

	test("an attribute value that is too long or ill-formed reports the attributes path, not the key", () => {
		const secretKey = "secret-attribute-name";
		for (const attributes of [
			{ [secretKey]: "x".repeat(300) },
			{ [secretKey]: "\ud800" },
			{ [secretKey]: 1 },
		]) {
			const error = errorOf(() =>
				parseAssertUserStateInput(
					assertInput({
						value: { text: "x", polarity: "affirmed", attributes } as never,
					}),
				),
			);
			expect(error.path).toBe("$.value.attributes");
			expect(error.path).not.toContain(secretKey);
			expect(error.message).not.toContain(secretKey);
		}
	});

	test("the same holds for the editedValue of a candidate confirmation", () => {
		const secretKey = "secret-attribute-name";
		const error = errorOf(() =>
			parseConfirmCandidateInput({
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 1 },
				candidateId: "cand:x",
				action: "admit",
				editedValue: {
					text: "x",
					polarity: "affirmed",
					attributes: { [secretKey]: "x".repeat(300) },
				},
				currentSources: [],
			}),
		);
		expect(error.path).toBe("$.editedValue.attributes");
		expect(error.path).not.toContain(secretKey);
	});
});
