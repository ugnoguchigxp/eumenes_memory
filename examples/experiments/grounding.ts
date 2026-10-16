import { Experiment, variants, parallel } from "./experiment.ts";
import { item } from "./cases.ts";
import { sameIds } from "./factorial.ts";
import { withLuna } from "../standalone/luna.ts";
import {
	recallSnapshot,
	candidateInstructions,
	groundingInstructions,
} from "./frozen-retrieval.ts";
import type { Complete } from "../standalone/protocol.ts";

const cases = [
	{
		id: "linked",
		message: "私のお気に入りの喫茶店がある街は？",
		items: [
			item("a", "お気に入りの喫茶店は白波堂"),
			item("b", "白波堂がある街は港町"),
		],
		status: "supported",
		ids: ["a", "b"],
	},
	{
		id: "different",
		message: "私のお気に入りの喫茶店がある街は？",
		items: [
			item("a", "お気に入りの喫茶店は南風亭"),
			item("b", "白波堂がある街は港町"),
		],
		status: "unknown",
		ids: [],
	},
	{
		id: "transfer",
		message: "私が所属する読書会の開催日は？",
		items: [
			item("a", "所属する読書会は月舟会"),
			item("b", "月舟会は毎月第二土曜日に開催される"),
			item("c", "星灯会は毎週火曜日に開催される"),
		],
		status: "supported",
		ids: ["a", "b"],
	},
];
export async function checkGrounding(directory: string) {
	const exp = new Experiment(directory, "joint-grounding", {
		cases,
		repetitions: 2,
		candidateInstructions,
		groundingInstructions,
	});
	const instructions = (recall: string) => ({
		...variants.v10.instructions,
		recall,
	});
	const wrap =
		(
			complete: Complete,
			stage: string,
			instruction: string,
			prefix: string,
		): Complete =>
		async (input, schema, task) => ({
			raw: await exp.call(
				complete,
				stage,
				instructions(instruction),
				`${prefix}/${stage}`,
				JSON.parse(input),
				schema,
				task,
			),
			usage: null,
			threadId: null,
		});
	try {
		await withLuna(
			(candidates) =>
				withLuna(async (grounding) => {
					const jobs: (() => Promise<void>)[] = [];
					for (let repetition = 1; repetition <= 2; repetition++)
						for (const c of cases)
							jobs.push(async () => {
								const result = await recallSnapshot(
									c.items,
									c.message,
									{
										candidates: wrap(
											candidates,
											"candidate",
											candidateInstructions,
											`${c.id}/${repetition}`,
										),
										grounding: wrap(
											grounding,
											"grounding",
											groundingInstructions,
											`${c.id}/${repetition}`,
										),
									},
									{ pageSize: 1 },
								);
								const passed =
									result.coverage.complete &&
									result.parts.length === 1 &&
									result.parts[0]!.status === c.status &&
									sameIds(result.parts[0]!.evidenceIds, c.ids);
								exp.result({ case: c.id, repetition, passed, result });
							});
					await parallel(jobs, 2);
				}, instructions(groundingInstructions)),
			instructions(candidateInstructions),
		);
		exp.save("completed");
		if (exp.results.some((x) => !x["passed"]))
			throw Error("Grounding checks failed");
	} catch (error) {
		exp.save("failed", String(error));
		throw error;
	}
}
if (import.meta.main) {
	if (process.argv[2] !== "--live" || !process.argv[3])
		throw Error(
			"Usage: bun examples/experiments/grounding.ts --live <new-output-directory>",
		);
	await checkGrounding(process.argv[3]);
}
