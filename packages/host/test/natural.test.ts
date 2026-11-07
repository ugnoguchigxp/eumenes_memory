import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialize } from "../src/storage.ts";
import { request, startStandalone } from "../src/transport.ts";
import { natural } from "../src/natural.ts";
import { commandComplete } from "../src/model.ts";
import type { StateItem } from "eumenes-memory";
import { measureRecallInput, encodeModelInput } from "../src/model.ts";
import { modelItems } from "../src/meaning/model-input.ts";
import { evidenceSchema } from "../src/meaning/support.ts";
import { recallPrompt } from "../src/meaning/retrieval.ts";

test("natural CLI bridge uses shared proposals, explicit repeated occurrence, grounding and durable model admission", async () => {
	const dir = mkdtempSync(join(tmpdir(), "emn-"));
	const profile = initialize(dir);
	const owner = await startStandalone(dir);
	try {
		const text = "夜だけお茶を飲みます";
		const source = await request(profile, "source", {
			submissionId: "natural",
			scopeKey: "personal",
			content: `${text}。引用です。${text}`,
		});
		const proposal = {
			decision: {
				clarification: null,
				actions: [
					{
						type: "remember",
						subject: "self",
						kind: "habit",
						semanticKey: "night-drink",
						value: { text, polarity: "affirmed" },
						quote: text,
						replacesItemId: null,
					},
				],
			},
			relations: [{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
			groups: [[0]],
		};
		const adapter = join(dir, "adapter.ts");
		const capture = join(dir, "capture.json");
		writeFileSync(
			adapter,
			`const input=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(capture)},JSON.stringify(input));console.log(JSON.stringify({raw:JSON.stringify(${JSON.stringify({ proposal, evidence: [{ actionIndex: 0, occurrence: 1 }] })})}));`,
		);
		const configured = {
			...profile,
			modelCommand: [process.execPath, adapter],
			modelDailyCalls: 2,
		};
		const plan = await natural(configured, "plan", {
			scopeKey: "personal",
			message: "この習慣を記憶してください",
			sourceHandle: source["sourceHandle"],
		});
		expect(plan.status).toBe("planned");
		expect((await request(profile, "context", {}))["items"]).toEqual([]);
		expect(readFileSync(capture, "utf8")).not.toContain(profile.credential);
		expect(
			(
				await request(profile, "apply", {
					planId: plan["planId"],
					epoch: plan["epoch"],
					operationId: "natural-save",
				})
			).status,
		).toBe("completed");
		const items = (await request(profile, "context", {}))[
			"items"
		] as StateItem[];
		expect(items[0]!.evidence[0]!.range!.startByte).toBeGreaterThan(0);
		const parts = [
			{
				request: "飲む時間",
				status: "supported",
				evidenceIds: [items[0]!.itemId],
			},
			{ request: "一回の量", status: "unknown", evidenceIds: [] },
		];
		writeFileSync(
			adapter,
			`const input=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(capture)},JSON.stringify(input));console.log(JSON.stringify({raw:JSON.stringify({parts:${JSON.stringify(parts)}})}));`,
		);
		const answer = await natural(configured, "recall", {
			scopeKey: "personal",
			message: "いつ、どのくらい飲みますか",
		});
		expect(answer.status).toBe("found");
		expect(answer["parts"]).toEqual(parts);
		const measured = await natural(
			profile,
			"recall-size",
			{
				scopeKey: "personal",
				message: "いつ、どのくらい飲みますか",
			},
			async () => {
				throw Error("measurement must not call a model");
			},
		);
		expect(measured.status).toBe("found");
		const sent = JSON.parse(readFileSync(capture, "utf8"));
		expect(measured["measurement"]).toMatchObject({
			itemCount: 1,
			modelInputBytes: Buffer.byteLength(JSON.stringify(sent)),
			fitsModelInput: true,
		});
		expect(readFileSync(capture, "utf8")).toContain("agent_inferred");
		await expect(
			commandComplete(configured)("{}", {}, "recall"),
		).rejects.toMatchObject({ code: "MODEL_BUDGET_EXHAUSTED" });
		await expect(
			commandComplete(profile)("{}", {}, "recall"),
		).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
	} finally {
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recall size measures UTF-8, escaped JSON and instructions even when no facts fit", () => {
	const empty = measureRecallInput([], "");
	expect(empty.itemCount).toBe(0);
	expect(empty.averageTextCharacters).toBe(0);
	expect(empty.modelInputBytes).toBeGreaterThan(0);
	const items = modelItems([]);
	const message = 'あ😀"\\\n'.repeat(20000);
	const measured = measureRecallInput(items, message);
	expect(measured.questionBytes).toBe(Buffer.byteLength(message));
	expect(measured.modelInputBytes).toBe(
		Buffer.byteLength(
			encodeModelInput(recallPrompt(items, message), evidenceSchema, "recall"),
		),
	);
	expect(measured.fitsModelInput).toBe(false);
	expect(measured.remainingBytes).toBeLessThan(0);
});
test("recall cannot return model output from a snapshot forgotten during model latency", async () => {
	const dir = mkdtempSync(join(tmpdir(), "emr-"));
	const profile = initialize(dir);
	const owner = await startStandalone(dir);
	try {
		const result = await natural(
			profile,
			"recall",
			{ scopeKey: "personal", message: "何を覚えていますか" },
			async () => {
				const source = await request(profile, "source", {
					submissionId: "during",
					scopeKey: "personal",
					content: "私はパンが好きです",
				});
				const c = await request(profile, "context", {});
				const text = "私はパンが好きです";
				const p = await request(profile, "plan", {
					snapshotId: c["snapshotId"],
					scopeKey: "personal",
					proposal: {
						decision: {
							clarification: null,
							actions: [
								{
									type: "remember",
									subject: "self",
									kind: "preference",
									semanticKey: "bread",
									value: { text, polarity: "affirmed" },
									quote: text,
									replacesItemId: null,
								},
							],
						},
						relations: [
							{ actionIndex: 0, relation: "new", relatedItemIds: [] },
						],
						groups: [[0]],
					},
					evidence: [
						{
							actionIndex: 0,
							sourceHandle: source["sourceHandle"],
							startByte: 0,
							endByte: Buffer.byteLength(text),
						},
					],
				});
				await request(profile, "apply", {
					planId: p["planId"],
					epoch: p["epoch"],
					operationId: "during-model",
				});
				return {
					raw: JSON.stringify({
						parts: [{ request: "記憶", status: "unknown", evidenceIds: [] }],
					}),
					threadId: null,
					usage: null,
				};
			},
		);
		expect(result).toMatchObject({ code: "SNAPSHOT_STALE" });
		expect(result["parts"]).toBeUndefined();
	} finally {
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
