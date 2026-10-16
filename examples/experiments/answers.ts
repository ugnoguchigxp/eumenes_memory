import { withLuna } from "../standalone/luna.ts";
import { parseRecall } from "./frozen-protocol.ts";
import { answerCases } from "./cases.ts";
import type { RecallCase } from "./cases.ts";
import { Experiment, parallel, variants } from "./experiment.ts";
import { sameIds } from "./factorial.ts";

import {
	evidenceInstructions,
	evidenceSchema,
	parseEvidence,
} from "../standalone/support.ts";
import type { EvidencePart } from "../standalone/support.ts";
export {
	evidenceInstructions,
	evidenceSchema,
	parseEvidence,
} from "../standalone/support.ts";
export function sameParts(
	parts: EvidencePart[],
	expected: RecallCase["parts"],
): boolean {
	return (
		parts.length === expected.length &&
		parts.every(
			(p, i) =>
				p.status === expected[i]!.status &&
				sameIds(p.evidenceIds, expected[i]!.evidenceIds),
		)
	);
}
export async function answers(directory: string) {
	const instructions = {
		...variants.v10.instructions,
		recall: evidenceInstructions,
	};
	const exp = new Experiment(directory, "answers", {
		repetitions: 3,
		cases: answerCases,
		baseline: variants.v10.instructions.recall,
		evidenceInstructions,
		evidenceSchema,
		policy:
			"Compare ID union on both arms; additionally score ordered status/evidence parts only for structured arm. Gold never supplied. This evaluates support selection, not generated prose correctness.",
	});
	try {
		await withLuna(
			async (plain) =>
				withLuna(async (structured) => {
					const jobs: (() => Promise<void>)[] = [];
					for (let repetition = 1; repetition <= 3; repetition++)
						for (const c of answerCases)
							for (const mode of ["ids", "evidence"] as const)
								jobs.push(async () => {
									const raw = await exp.call(
										mode === "ids" ? plain : structured,
										mode,
										mode === "ids" ? variants.v10.instructions : instructions,
										`${c.id}/${repetition}`,
										{ task: "recall", message: c.message, items: c.items },
										mode === "ids" ? variants.v10.recallSchema : evidenceSchema,
										"recall",
									);
									try {
										const parts =
											mode === "ids"
												? null
												: parseEvidence(
														raw,
														c.items.map((x) => x.itemId),
													);
										const ids =
											parts === null
												? parseRecall(raw)
												: [...new Set(parts.flatMap((p) => p.evidenceIds))];
										if (ids.some((id) => !c.items.some((x) => x.itemId === id)))
											throw Error("Unknown ID");
										exp.result({
											case: c.id,
											mode,
											repetition,
											idsPassed: sameIds(ids, c.expectedIds),
											partsPassed:
												parts === null ? null : sameParts(parts, c.parts),
											parts,
										});
									} catch (error) {
										exp.result({
											case: c.id,
											mode,
											repetition,
											idsPassed: false,
											partsPassed: false,
											error: String(error),
										});
									}
								});
					await parallel(jobs);
				}, instructions),
			variants.v10.instructions,
		);
		exp.save("completed");
	} catch (error) {
		exp.save("failed", String(error));
		throw error;
	}
}
if (import.meta.main) {
	if (process.argv[2] !== "--live" || !process.argv[3])
		throw Error(
			"Usage: bun examples/experiments/answers.ts --live <output-directory>",
		);
	await answers(process.argv[3]);
}
