import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneHost } from "../standalone/host.ts";
import { modelItems } from "../standalone/model-input.ts";
import type { ModelItem } from "../standalone/model-input.ts";
import {
	parseDecision,
	parseRecall,
	parseJudgment,
} from "./frozen-protocol.ts";
import { decisionCases, recallCases, judgeCases } from "./cases.ts";
import {
	Experiment,
	parallel,
	variants,
	withVariants,
	hash,
} from "./experiment.ts";

export function sameIds(actual: string[], expected: string[]): boolean {
	return (
		JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
	);
}
export function judgeInput(
	items: readonly ModelItem[],
	expected: readonly ModelItem[],
	criterion: string,
	message?: string,
) {
	const fact = (x: ModelItem) => ({
		subject: x.subject,
		kind: x.kind,
		semanticKey: x.semanticKey,
		text: x.value.text,
		polarity: x.value.polarity,
	});
	return {
		task: "judge",
		actual: items.map(fact),
		expected: expected.map((x) => {
			const { semanticKey: _key, ...expectedFact } = fact(x);
			return expectedFact;
		}),
		criterion,
		...(message === undefined ? {} : { message }),
	};
}
/** Fixed inputs: generation changes cannot change what either judge sees. */
export async function factorial(directory: string) {
	const exp = new Experiment(directory, "factorial", {
		repetitions: 3,
		decisionCases,
		recallCases,
		judgeCases,
		variants,
		policy:
			"Cross-grade the same generated output; no judge feedback to generation. v10 judge includes message, v9 does not. Disputed gold excluded from accuracy.",
	});
	try {
		await withVariants(async (clients) => {
			const jobs: (() => Promise<void>)[] = [];
			for (let repetition = 1; repetition <= 3; repetition++)
				for (const generator of ["v9", "v10"] as const) {
					for (const c of recallCases)
						jobs.push(async () => {
							const raw = await exp.call(
								clients[generator],
								generator,
								variants[generator].instructions,
								`${c.id}/${repetition}`,
								{ task: "recall", message: c.message, items: c.items },
								variants[generator].recallSchema,
								"recall",
							);
							let passed = false;
							let error: string | undefined;
							try {
								passed = sameIds(parseRecall(raw), c.expectedIds);
							} catch (e) {
								error = String(e);
							}
							exp.result({
								type: "recall",
								case: c.id,
								repetition,
								generator,
								passed,
								...(error ? { error } : {}),
							});
						});
					for (const c of decisionCases)
						jobs.push(async () => {
							const raw = await exp.call(
								clients[generator],
								generator,
								variants[generator].instructions,
								`${c.id}/${repetition}`,
								{
									task: "decide",
									message: c.message,
									items: [],
									subjects: c.subjects,
								},
								variants[generator].decisionSchema,
								"decide",
							);
							const dir = mkdtempSync(join(tmpdir(), "memory-factorial-"));
							const host = new StandaloneHost(dir);
							let actual: ModelItem[] = [];
							let contractError: string | undefined;
							try {
								const decision = parseDecision(raw);
								for (const action of decision.actions) {
									if (action.type !== "remember")
										throw Error("Unexpected forget");
									host.remember(action, c.message);
								}
								actual = modelItems(host.list());
							} catch (e) {
								contractError = String(e);
							} finally {
								host.close();
								rmSync(dir, { recursive: true, force: true });
							}
							if (contractError) {
								exp.result({
									type: "decide",
									case: c.id,
									repetition,
									generator,
									contractPassed: false,
									error: contractError,
								});
								return;
							}
							const structure = (items: readonly ModelItem[]) =>
								items
									.map((x) =>
										JSON.stringify([x.subject, x.kind, x.value.polarity]),
									)
									.sort();
							const structurePassed =
								JSON.stringify(structure(actual)) ===
								JSON.stringify(structure(c.expected));
							for (const judge of ["v9", "v10"] as const) {
								const input = judgeInput(
									actual,
									c.expected,
									c.criterion,
									judge === "v10" ? c.message : undefined,
								);
								const judged = await exp.call(
									clients[judge],
									judge,
									variants[judge].instructions,
									`${generator}/${c.id}/${repetition}/judge`,
									input,
									variants[judge].judgeSchema,
									"judge",
								);
								const judgment = parseJudgment(judged);
								exp.result({
									type: "decide",
									case: c.id,
									repetition,
									generator,
									judge,
									actualHash: hash(actual),
									contractPassed: true,
									structurePassed,
									semanticPassed: judgment.passed,
									passed: structurePassed && judgment.passed,
									reason: judgment.reason,
								});
							}
						});
					for (const c of judgeCases)
						jobs.push(async () => {
							const raw = await exp.call(
								clients[generator],
								generator,
								variants[generator].instructions,
								`${c.id}/${repetition}/calibration`,
								judgeInput(
									c.actual,
									c.expected,
									c.criterion,
									generator === "v10" ? c.message : undefined,
								),
								variants[generator].judgeSchema,
								"judge",
							);
							const judgment = parseJudgment(raw);
							exp.result({
								type: "judge-calibration",
								case: c.id,
								repetition,
								judge: generator,
								verdict: judgment.passed,
								expected: c.expectedPassed,
								correct:
									c.expectedPassed === null
										? null
										: judgment.passed === c.expectedPassed,
								reason: judgment.reason,
							});
						});
				}
			await parallel(jobs);
		});
		exp.save("completed");
	} catch (error) {
		exp.save("failed", String(error));
		throw error;
	}
}
if (import.meta.main) {
	if (process.argv[2] !== "--live" || !process.argv[3])
		throw Error(
			"Usage: bun examples/experiments/factorial.ts --live <output-directory>",
		);
	await factorial(process.argv[3]);
}
