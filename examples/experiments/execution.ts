import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneHost } from "../standalone/host.ts";
import { planMemory, planningInstructions } from "../standalone/planning.ts";
import { applyMemoryPlan } from "../standalone/execution.ts";
import { withLuna } from "../standalone/luna.ts";
import { Experiment, variants, parallel } from "./experiment.ts";

const cases = [
	{
		id: "dependent",
		message:
			"住所も勤務地も現在は大阪です。両方の東京の記録を一組として訂正してください。片方だけの訂正はしないでください。",
		seed: [
			{ key: "home", text: "住所は東京" },
			{ key: "workplace", text: "勤務地は東京" },
		],
	},
	{
		id: "independent",
		message:
			"陶芸が趣味という記憶は忘れてください。これとは独立した依頼として、紅茶が好きという好みを新たに覚えてください。どちらかができなくても、もう一方は進めて構いません。",
		seed: [{ key: "hobby", text: "陶芸が趣味" }],
	},
];
export async function checkExecution(directory: string) {
	const instructions = {
		...variants.v10.instructions,
		decide: planningInstructions,
	};
	const exp = new Experiment(directory, "grouped-execution", {
		cases,
		repetitions: 2,
		instructions,
	});
	try {
		await withLuna(async (complete) => {
			const jobs: (() => Promise<void>)[] = [];
			for (let repetition = 1; repetition <= 2; repetition++)
				for (const c of cases)
					jobs.push(async () => {
						const dir = mkdtempSync(join(tmpdir(), "execution-live-"));
						const host = new StandaloneHost(dir);
						try {
							for (const x of c.seed)
								host.remember(
									{
										type: "remember",
										subject: "self",
										kind: "personal_fact",
										semanticKey: x.key,
										value: { text: x.text, polarity: "affirmed" },
										quote: x.text,
										replacesItemId: null,
									},
									x.text,
								);
							const before = host.list();
							const plan = await planMemory(
								host,
								c.message,
								async (input, schema, task) => ({
									raw: await exp.call(
										complete,
										"execution",
										instructions,
										`${c.id}/${repetition}`,
										JSON.parse(input),
										schema,
										task,
									),
									usage: null,
									threadId: null,
								}),
							);
							const result = applyMemoryPlan(
								host,
								`${c.id}/${repetition}`,
								plan,
							);
							const after = host.list();
							const committed = JSON.stringify(host.list(true));
							const journal = await Bun.file(host.journalPath).text();
							const retry = applyMemoryPlan(
								host,
								`${c.id}/${repetition}`,
								plan,
							);
							const unchanged =
								committed === JSON.stringify(host.list(true)) &&
								journal === (await Bun.file(host.journalPath).text());
							const passed =
								result.status === "completed" &&
								retry.status === "completed" &&
								unchanged &&
								(c.id === "dependent"
									? plan.groups.length === 1 &&
										plan.groups[0]!.length === 2 &&
										after.length === 2 &&
										before.every((old) =>
											after.some(
												(x) =>
													x.semanticKey === old.semanticKey &&
													x.value.text.includes("大阪"),
											),
										)
									: plan.groups.length === 2 &&
										after.length === 1 &&
										after[0]!.kind === "preference" &&
										after[0]!.value.text.includes("紅茶") &&
										!after.some((x) => x.itemId === before[0]!.itemId));
							exp.result({
								case: c.id,
								repetition,
								passed,
								plan,
								result,
								retry,
								after,
							});
						} finally {
							host.close();
							rmSync(dir, { recursive: true, force: true });
						}
					});
			await parallel(jobs, 2);
		}, instructions);
		if (exp.results.some((x) => !x["passed"]))
			throw Error("Grouped execution checks failed");
		exp.save("completed");
	} catch (error) {
		exp.save("failed", String(error));
		throw error;
	}
}
if (import.meta.main) {
	if (process.argv[2] !== "--live" || !process.argv[3])
		throw Error(
			"Usage: bun examples/experiments/execution.ts --live <new-output-directory>",
		);
	await checkExecution(process.argv[3]);
}
