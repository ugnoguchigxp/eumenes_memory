import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneHost } from "../standalone/host.ts";
import { planMemory, planningInstructions } from "../standalone/planning.ts";
import { withLuna } from "../standalone/luna.ts";
import { Experiment, variants, parallel } from "./experiment.ts";
import type { StateKind } from "eumenes-memory";

const cases = [
	{
		id: "same",
		message: "紅茶が好きです。覚えてください。",
		seed: [{ key: "tea", text: "紅茶が好き" }],
	},
	{
		id: "coexists",
		message: "紅茶に加えてコーヒーも好きです。両方の好みを残して。",
		seed: [{ key: "beverage", text: "紅茶が好き" }],
	},
	{
		id: "correction",
		message: "今は紅茶が好きではありません。前の紅茶の好みを訂正して。",
		seed: [{ key: "tea", text: "紅茶が好き" }],
	},
	{
		id: "conflict",
		message:
			"現在の勤務先は山川社です。ただし、青空社という現在の記録との食い違いは未解決です。確認するまで上書きしないで。",
		seed: [
			{ key: "employer", text: "現在の勤務先は青空社", kind: "personal_fact" },
		],
	},
	{
		id: "forget-aliases",
		message:
			"陶芸が趣味という記憶だけ忘れてください。陶芸の粉塵を避ける制約は残してください。",
		seed: [
			{ key: "hobby", text: "陶芸が趣味" },
			{ key: "leisure", text: "陶芸が趣味" },
			{ key: "dust", text: "陶芸の粉塵を避ける", kind: "constraint" },
		],
	},
];
export async function checkIdentity(directory: string) {
	const instructions = {
		...variants.v10.instructions,
		decide: planningInstructions,
	};
	const exp = new Experiment(directory, "memory-identity", {
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
						const dir = mkdtempSync(join(tmpdir(), "identity-live-"));
						const host = new StandaloneHost(dir);
						try {
							for (const x of c.seed)
								host.remember(
									{
										type: "remember",
										subject: "self",
										kind: ("kind" in x ? x.kind : "preference") as StateKind,
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
										"identity",
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
							const actions = plan.changes.flatMap((x) => x.actions);
							for (const action of actions) {
								if (action.type === "remember")
									host.remember(action, c.message);
								else host.forgetFact(action.itemId);
							}
							const after = host.list();
							const passed =
								c.id === "same"
									? actions.length === 0 && after.length === 1
									: c.id === "coexists"
										? after.length === 2 &&
											after.some((x) => x.itemId === before[0]!.itemId)
										: c.id === "correction"
											? after.length === 1 &&
												after[0]!.semanticKey === "tea" &&
												after[0]!.value.polarity === "negated" &&
												after[0]!.itemId !== before[0]!.itemId
											: c.id === "conflict"
												? actions.length === 0 &&
													Boolean(plan.clarification?.trim()) &&
													after[0]!.itemId === before[0]!.itemId
												: after.length === 1 &&
													after[0]!.semanticKey === "dust";
							exp.result({ case: c.id, repetition, passed, plan, after });
						} finally {
							host.close();
							rmSync(dir, { recursive: true, force: true });
						}
					});
			await parallel(jobs, 2);
		}, instructions);
		if (exp.results.some((x) => !x["passed"]))
			throw Error("Identity checks failed");
		exp.save("completed");
	} catch (error) {
		exp.save("failed", String(error));
		throw error;
	}
}
if (import.meta.main) {
	if (process.argv[2] !== "--live" || !process.argv[3])
		throw Error(
			"Usage: bun examples/experiments/identity.ts --live <new-output-directory>",
		);
	await checkIdentity(process.argv[3]);
}
