/**
 * 評価パイプラインの自己検査。oracle は満点、echo-noop は再現率 0 / noChange 満点、
 * 意図的に壊した出力では対応する指標が悪化することを確かめる（指標が本当に誤りを数えるか）。
 */
import { describe, expect, test } from "bun:test";
import type { ExtractionInput, ExtractionOutput } from "eumenes-memory";
import oracle from "../adapters/oracle.ts";
import echoNoop from "../adapters/echo-noop.ts";
import { toAdapter } from "../lib/adapter.ts";
import { DATASET_PATH, loadDataset } from "../lib/dataset.ts";
import { runEval, sha256Text } from "../lib/runner.ts";
import type { EvalReport } from "../lib/runner.ts";
import { loadThresholds } from "../lib/thresholds.ts";
import { CATEGORIES } from "../lib/types.ts";
import type { EvalAdapter } from "../lib/types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cases = loadDataset();
const datasetSha256 = sha256Text(readFileSync(DATASET_PATH, "utf8"));

function run(
	adapter: EvalAdapter,
	extra: { repeats?: number; split?: "dev" | "test" | "all" } = {},
): Promise<EvalReport> {
	return runEval({
		name: "test",
		cases,
		datasetSha256,
		datasetPath: "eval/datasets/ja-memory-v1.jsonl",
		adapter,
		adapterPath: "test",
		repeats: extra.repeats ?? 1,
		split: extra.split ?? "all",
		timeoutMs: 20000,
	});
}

/** oracle の出力を加工するアダプター。 */
function derived(
	id: string,
	transform: (output: ExtractionOutput, input: ExtractionInput) => unknown,
): EvalAdapter {
	return {
		extractorId: id,
		promptVersion: "test-1",
		providerRef: "none",
		stub: true,
		extract: async (input, signal) =>
			transform(
				(await oracle.extract(input, signal)) as ExtractionOutput,
				input,
			),
	};
}

describe("oracle self-check", () => {
	test("scores perfectly on every category, with nothing over-extracted or falsely admitted", async () => {
		const report = await run(oracle);
		const worst = report.overall.worst;
		expect(worst.cases).toBe(cases.length);
		expect(worst.candidateRecall).toBe(1);
		expect(worst.fullMatchRate).toBe(1);
		expect(worst.noChangeAccuracy).toBe(1);
		expect(worst.overExtracted).toBe(0);
		expect(worst.missed).toBe(0);
		expect(worst.polarityErrors).toBe(0);
		expect(worst.modalityErrors).toBe(0);
		expect(worst.subjectErrors).toBe(0);
		expect(worst.kindErrors).toBe(0);
		expect(worst.temporalErrors).toBe(0);
		expect(worst.quoteMismatchRate).toBe(0);
		expect(worst.falseAdmissions).toBe(0);
		expect(worst.adapterFailures + worst.rejectedOutputs).toBe(0);
		for (const category of CATEGORIES) {
			const summary = report.categories[category];
			expect(summary).toBeDefined();
			expect(summary?.worst.fullMatch).toBe(summary?.worst.goldCandidates);
		}
		for (const entry of report.cases) {
			expect(entry.runs[0]?.outcome).toBe("applied");
			expect(entry.runs[0]?.flags).toEqual([]);
		}
	});

	test("never claims the E stage: stub adapter, unreviewed gold, no approved thresholds", async () => {
		const report = await run(oracle);
		expect(report.claims.eStageEligible).toBe(false);
		expect(report.adapter.stub).toBe(true);
		expect(report.claims.reasons.join("\n")).toContain("stub adapter");
		expect(report.claims.reasons.join("\n")).toContain("human reviewed");
	});

	test("is deterministic: two runs give byte-identical reports", async () => {
		const first = JSON.stringify(await run(oracle));
		const second = JSON.stringify(await run(oracle));
		expect(second).toBe(first);
	});

	test("repeats record per-repeat metrics and the worst value", async () => {
		const report = await run(oracle, { repeats: 2, split: "dev" });
		expect(report.overall.perRepeat.length).toBe(2);
		expect(report.overall.worst.cases).toBe(
			cases.filter((c) => c.split === "dev").length,
		);
		expect(report.dataset.split).toBe("dev");
	});

	test("passes the proposed thresholds, which are recorded as a proposal", async () => {
		const loaded = loadThresholds(
			join(import.meta.dir, "..", "thresholds", "proposal-1.json"),
		);
		expect(loaded.thresholds.status).toBe("proposal");
		const report = await runEval({
			name: "test",
			cases,
			datasetSha256,
			datasetPath: "x",
			adapter: oracle,
			adapterPath: "x",
			repeats: 1,
			split: "all",
			timeoutMs: 20000,
			thresholds: loaded.thresholds,
			thresholdsPath: "x",
			thresholdsSha256: sha256Text(loaded.text),
		});
		expect(report.thresholds?.pass).toBe(true);
		expect(report.thresholds?.status).toBe("proposal");
	});
});

describe("echo-noop baseline", () => {
	test("misses everything it must find and is right on every no-change case", async () => {
		const report = await run(echoNoop);
		const worst = report.overall.worst;
		expect(worst.noChangeAccuracy).toBe(1);
		expect(worst.candidateRecall).toBe(0);
		expect(worst.emittedCandidates).toBe(0);
		expect(worst.overExtracted).toBe(0);
		expect(worst.acceptedNoChangeCases).toBeGreaterThan(0);
		expect(worst.admitted).toBe(0);
	});
});

describe("metrics notice injected mistakes", () => {
	test("flipping polarity is counted as polarity errors and, when admitted, as false admissions", async () => {
		const report = await run(
			derived("flip-polarity", (output) => ({
				...output,
				candidates: output.candidates.map((candidate) => ({
					...candidate,
					value: {
						...candidate.value,
						polarity:
							candidate.value.polarity === "negated" ? "affirmed" : "negated",
					},
				})),
			})),
		);
		const worst = report.overall.worst;
		expect(worst.polarityErrors).toBeGreaterThan(20);
		expect(worst.fullMatch).toBeLessThan(worst.matched);
		expect(worst.falseAdmissions).toBeGreaterThan(10);
		expect(report.categories["negation"]?.worst.polarityErrors).toBeGreaterThan(
			0,
		);
	});

	test("relabeling modality to asserted on non-asserted gold is a modality error, and a false admission where no other rule stops it", async () => {
		const report = await run(
			derived("assert-everything", (output) => ({
				...output,
				candidates: output.candidates.map((candidate) => ({
					...candidate,
					modality: "asserted",
				})),
			})),
		);
		expect(report.categories["hypothetical"]?.worst.modalityErrors).toBe(8);
		// 仮定（temporal future）は Admission の TEMPORAL_NOT_CURRENT で止まる。疑問（current）は止まらない。
		expect(report.categories["hypothetical"]?.worst.falseAdmissions).toBe(0);
		expect(
			report.categories["question"]?.worst.falseAdmissions,
		).toBeGreaterThan(0);
		expect(report.categories["hearsay"]?.worst.modalityErrors).toBeGreaterThan(
			0,
		);
		expect(report.categories["negation"]?.worst.modalityErrors).toBe(0);
	});

	test("relabeling other-person subjects as self is a subject error", async () => {
		const report = await run(
			derived("self-everything", (output) => ({
				...output,
				candidates: output.candidates.map((candidate) => ({
					...candidate,
					subject: "self",
					kind:
						candidate.kind === "other_person_note"
							? "preference"
							: candidate.kind,
				})),
			})),
		);
		expect(
			report.categories["other_person"]?.worst.subjectErrors,
		).toBeGreaterThan(5);
		expect(
			report.categories["other_person"]?.worst.falseAdmissions,
		).toBeGreaterThan(5);
		expect(report.categories["negation"]?.worst.subjectErrors).toBe(0);
	});

	test("an extra candidate on a no-change case is over-extraction and breaks no-change accuracy", async () => {
		const report = await run(
			derived("always-extra", (output, input) => {
				if (!output.noChange) return output;
				const content = input.sources[0]?.content ?? "";
				const quote = [...content].slice(0, 2).join("");
				return {
					noChange: false,
					candidates: [
						{
							kind: "preference",
							subject: "self",
							semanticKey: "x",
							value: { text: "x", polarity: "affirmed" },
							modality: "asserted",
							temporal: "current",
							evidence: [
								{
									sourceIndex: 0,
									startByte: 0,
									endByte: new TextEncoder().encode(quote).length,
									quote,
								},
							],
						},
					],
				};
			}),
		);
		const chat = report.categories["no_change"]?.worst;
		expect(chat?.overExtracted).toBe(9);
		expect(chat?.noChangeAccuracy).toBe(0);
		expect(chat?.falseAdmissions).toBe(9);
	});

	test("a duplicated candidate counts as a duplicate over-extraction, not as a recall gain", async () => {
		const report = await run(
			derived("duplicate", (output) => ({
				noChange: output.noChange,
				candidates: output.candidates.flatMap((candidate, index) => [
					candidate,
					{ ...candidate, semanticKey: `${candidate.semanticKey}.dup${index}` },
				]),
			})),
		);
		const worst = report.overall.worst;
		expect(worst.candidateRecall).toBe(1);
		expect(worst.duplicates).toBe(worst.goldCandidates);
		expect(worst.overExtracted).toBe(worst.goldCandidates);
	});

	test("quotes that do not match the byte range are counted by rate and excluded from matching", async () => {
		const report = await run(
			derived("bad-quote", (output) => ({
				...output,
				candidates: output.candidates.map((candidate) => ({
					...candidate,
					evidence: candidate.evidence.map((evidence) => ({
						...evidence,
						quote: `${evidence.quote}。`,
					})),
				})),
			})),
		);
		const worst = report.overall.worst;
		expect(worst.quoteMismatchRate).toBe(1);
		expect(worst.matched).toBe(0);
		expect(worst.overExtracted).toBe(0);
	});

	test("adapter errors and schema-violating outputs are counted, and settle is not trusted with them", async () => {
		const failing = await run({
			...echoNoop,
			extractorId: "throws",
			extract: () => Promise.reject(new Error("boom")),
		});
		expect(failing.overall.worst.adapterFailures).toBe(cases.length);
		expect(failing.overall.worst.noChangeAccuracy).toBe(0);
		const invalid = await run({
			...echoNoop,
			extractorId: "bad-schema",
			extract: () => Promise.resolve({ candidates: "none" }),
		});
		expect(invalid.overall.worst.rejectedOutputs).toBe(cases.length);
	});

	test("thresholds fail when an injected mistake crosses them", async () => {
		const loaded = loadThresholds(
			join(import.meta.dir, "..", "thresholds", "proposal-1.json"),
		);
		const report = await runEval({
			name: "test",
			cases,
			datasetSha256,
			datasetPath: "x",
			adapter: derived("flip", (output) => ({
				...output,
				candidates: output.candidates.map((candidate) => ({
					...candidate,
					value: { ...candidate.value, polarity: "negated" },
				})),
			})),
			adapterPath: "x",
			repeats: 1,
			split: "all",
			timeoutMs: 20000,
			thresholds: loaded.thresholds,
			thresholdsPath: "x",
			thresholdsSha256: "x",
		});
		expect(report.thresholds?.pass).toBe(false);
		expect(
			report.thresholds?.failures.some((f) => f.metric === "polarityErrors"),
		).toBe(true);
	});
});

describe("adapter loading", () => {
	test("accepts an EvalAdapter or a bare port and rejects anything else", () => {
		expect(toAdapter(oracle, "x.ts").extractorId).toBe("eval-oracle");
		const bare = toAdapter(() => Promise.resolve({}), "/a/b/my-model.ts");
		expect(bare.extractorId).toBe("my-model");
		expect(() => toAdapter({ extract: 1 }, "x.ts")).toThrow();
		expect(() => toAdapter({ ...oracle, extractorId: "" }, "x.ts")).toThrow();
	});
});
