import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { retrievalMetrics } from "../../examples/quality/retrieval-metrics.ts";
import {
	analyzeRetrieval,
	retrievalReport,
} from "../../examples/quality/retrieval-report.ts";
import { freshCases } from "../../examples/quality/cases.ts";

test("empty or internally inconsistent gold cannot produce a quality pass", () => {
	const value = structuredClone(freshCases[0]!);
	const rows = ["openai", "claude"].map((provider) => ({
		provider,
		suite: "review",
		id: value.id,
		repetition: 0,
		status: "passed" as const,
		details: { parts: [] },
	}));
	expect(() =>
		retrievalReport(
			[{ suite: "review", value: { ...value, parts: [] } }],
			rows,
			1,
		),
	).toThrow();
	for (const gold of [
		{ status: "supported" as const, requiredIds: [], allowedIds: [] },
		{
			status: "unknown" as const,
			requiredIds: [],
			allowedIds: [value.items[0]!.itemId],
		},
		{
			status: "supported" as const,
			requiredIds: ["missing"],
			allowedIds: ["missing"],
		},
		{
			status: "supported" as const,
			requiredIds: [value.items[0]!.itemId],
			allowedIds: [],
		},
	])
		expect(() =>
			retrievalReport(
				[{ suite: "review", value: { ...value, parts: [gold] } }],
				[],
				1,
			),
		).toThrow();
});

test("false support and unsupported evidence remain separate from unnecessary unknown", () => {
	const metrics = retrievalMetrics([
		{
			expected: [
				{ status: "unknown", requiredIds: [], allowedIds: [] },
				{ status: "conflict", requiredIds: ["a", "b"], allowedIds: ["a", "b"] },
				{ status: "supported", requiredIds: ["a"], allowedIds: ["a"] },
				{ status: "supported", requiredIds: ["b"], allowedIds: ["b"] },
				{
					status: "supported",
					requiredIds: ["negative"],
					allowedIds: ["negative"],
				},
			],
			actual: [
				{ request: "condition", status: "supported", evidenceIds: ["a"] },
				{ request: "conflict", status: "supported", evidenceIds: ["a"] },
				{ request: "owner", status: "supported", evidenceIds: ["b"] },
				{ request: "known", status: "unknown", evidenceIds: [] },
				{
					request: "explicit negative",
					status: "supported",
					evidenceIds: ["negative"],
				},
			],
		},
	]);
	expect(metrics.falseSupported).toEqual({
		numerator: 2,
		denominator: 2,
		rate: 1,
	});
	expect(metrics.supportedEvidenceMismatch.numerator).toBe(1);
	expect(metrics.unsupportedAmongSupportedByGold).toEqual({
		numerator: 3,
		denominator: 4,
		rate: 0.75,
	});
	expect(metrics.unnecessaryUnknown).toEqual({
		numerator: 1,
		denominator: 3,
		rate: 1 / 3,
	});
});

test("missing and split outputs cannot dilute slot-rate denominators or count as successes", () => {
	const expected = freshCases[0]!.parts;
	const metrics = retrievalMetrics([{ expected }, { expected, actual: [] }]);
	expect(metrics.unavailableCases).toBe(1);
	expect(metrics.unalignedCases).toBe(1);
	expect(metrics.alignedParts).toBe(0);
	expect(metrics.falseSupported.rate).toBeNull();
	expect(metrics.unsupportedAmongSupportedByGold.rate).toBeNull();
});

test("archived reanalysis verifies gold, retains missing trials, and never overwrites evidence", () => {
	const directory = mkdtempSync(join(tmpdir(), "retrieval-report-"));
	try {
		const cases = [{ suite: "archived", value: freshCases[0]! }];
		const manifest = {
			cases,
			repetitions: 1,
			sourceHash: "historical",
			casesHash: createHash("sha256")
				.update(JSON.stringify(cases))
				.digest("hex"),
		};
		const results = [
			{
				provider: "openai",
				suite: "archived",
				id: freshCases[0]!.id,
				repetition: 0,
				status: "passed" as const,
				details: {
					parts: [
						{
							request: "交通機関",
							status: "supported",
							evidenceIds: freshCases[0]!.parts[0]!.requiredIds,
						},
					],
				},
			},
		];
		const manifestPath = join(directory, "manifest.json"),
			resultsPath = join(directory, "results.json");
		writeFileSync(manifestPath, JSON.stringify(manifest));
		writeFileSync(resultsPath, JSON.stringify(results));
		const before = readFileSync(resultsPath, "utf8");
		const output = join(directory, "diagnostics.json");
		const report = analyzeRetrieval(directory, output);
		expect(report.status).toBe("incomplete"); // The second provider has no response.
		expect(report.qualityPassed).toBe(false);
		expect(report.groups[0]!.metrics.unsupportedAmongSupportedByGold.rate).toBe(
			0,
		);
		expect(report.reanalysisIsNotAnUnseenHoldout).toBe(true);
		expect(report.analysisSourceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(
			report.currentHostInputCapacity[0]!.measurement.inputFormatSha256,
		).toMatch(/^[a-f0-9]{64}$/);
		expect(() => analyzeRetrieval(directory, output)).toThrow();
		expect(() => analyzeRetrieval(directory, resultsPath)).toThrow();
		expect(readFileSync(resultsPath, "utf8")).toBe(before);
		expect(() => retrievalReport(cases, [...results, ...results], 1)).toThrow(
			"duplicate result",
		);
		expect(() =>
			retrievalReport(cases, [{ ...results[0]!, status: "failed" }], 1),
		).toThrow("disagrees");
		const complete = retrievalReport(
			cases,
			[...results, { ...results[0]!, provider: "claude" }],
			1,
		);
		expect(complete.status).toBe("completed");
		expect(complete.qualityPassed).toBe(true);
		expect(() =>
			retrievalReport(
				cases,
				[
					{
						...results[0]!,
						raw: '{"parts":[{"request":"別の質問","status":"unknown","evidenceIds":[]}]}',
					},
				],
				1,
			),
		).toThrow("disagree");
		manifest.casesHash = "tampered";
		writeFileSync(manifestPath, JSON.stringify(manifest));
		expect(() =>
			analyzeRetrieval(directory, join(directory, "bad.json")),
		).toThrow("Frozen cases changed");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
