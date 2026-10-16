import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCommand } from "../../examples/standalone/memory.ts";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { planningInstructions } from "../../examples/standalone/planning.ts";

test("standard entry plans without mutation and applies the same saved operation once across restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "memory-entry-"));
	let modelCalls = 0;
	try {
		const message = "和紙作りが好き";
		const plan = await memoryCommand(
			[directory, "plan", message],
			async (operation, instructions) => {
				expect(instructions?.decide).toBe(planningInstructions);
				return operation(async (input, _schema, task) => {
					modelCalls++;
					expect(task).toBe("decide");
					expect(JSON.parse(input)).toEqual({
						task: "decide",
						message,
						items: [],
						subjects: [],
					});
					return {
						raw: JSON.stringify({
							decision: {
								clarification: null,
								actions: [
									{
										type: "remember",
										subject: "self",
										kind: "preference",
										semanticKey: "washi",
										value: { text: message, polarity: "affirmed" },
										quote: message,
										replacesItemId: null,
									},
								],
							},
							relations: [
								{ actionIndex: 0, relation: "new", relatedItemIds: [] },
							],
							groups: [[0]],
						}),
						usage: null,
						threadId: null,
					};
				});
			},
		);
		const host = new StandaloneHost(directory);
		expect(host.list()).toEqual([]);
		host.close();
		const path = join(directory, "saved-plan.json");
		writeFileSync(path, JSON.stringify(plan));
		const noModel = async (): Promise<never> => {
			throw Error("apply must not replan");
		};
		expect(
			await memoryCommand([directory, "apply", "request-1", path], noModel),
		).toMatchObject({ status: "completed" });
		const before = new StandaloneHost(directory);
		const history = before.list(true);
		const sources = readFileSync(join(directory, "sources.jsonl"), "utf8");
		before.close();
		expect(
			await memoryCommand([directory, "apply", "request-1", path], noModel),
		).toMatchObject({ status: "completed" });
		const after = new StandaloneHost(directory);
		expect(after.list(true)).toEqual(history);
		expect(after.list()).toHaveLength(1);
		after.close();
		expect(readFileSync(join(directory, "sources.jsonl"), "utf8")).toBe(
			sources,
		);
		expect(modelCalls).toBe(1);
		await expect(
			memoryCommand([directory, "apply", "request-2", path], noModel),
		).rejects.toThrow("Stale");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
