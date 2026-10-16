import { expect, test } from "bun:test";
import { recallSnapshot } from "../../examples/standalone/retrieval.ts";
import { item } from "../../examples/experiments/cases.ts";
import type { Complete } from "../../examples/standalone/protocol.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { recallMemory } from "../../examples/standalone/retrieval.ts";

const response = (value: unknown) => ({
	raw: JSON.stringify(value),
	usage: null,
	threadId: null,
});
const selectAll: Complete = async (input) =>
	response({
		itemIds: JSON.parse(input).items.map((x: { itemId: string }) => x.itemId),
	});
const unknown: Complete = async () =>
	response({
		parts: [{ request: "所在地", status: "unknown", evidenceIds: [] }],
	});

test("host retrieval supplies surviving facts and catalog labels through public APIs", async () => {
	const directory = mkdtempSync(join(tmpdir(), "retrieval-host-"));
	const host = new StandaloneHost(directory);
	try {
		const text = "版画が好き";
		const saved = host.remember(
			{
				type: "remember",
				kind: "other_person_note",
				subject: "other:p1",
				semanticKey: "printmaking",
				value: { text, polarity: "affirmed" },
				quote: text,
				replacesItemId: null,
			},
			text,
		);
		let supplied: unknown[] = [];
		const candidates: Complete = async (input) => {
			supplied = JSON.parse(input).items;
			return selectAll(input, {}, "recall");
		};
		await recallMemory(
			host,
			"ミナの好み",
			{ candidates, grounding: unknown },
			{ subjects: [{ id: "other:p1", label: "ミナ" }] },
		);
		expect(supplied).toHaveLength(1);
		expect(supplied[0]).toHaveProperty("subjectLabel", "ミナ");
		host.forgetFact(saved.itemId);
		const result = await recallMemory(host, "ミナの好み", {
			candidates,
			grounding: unknown,
		});
		expect(result.coverage.candidateCount).toBe(0);
	} finally {
		host.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("joint grounding sees both pages and can reject their locally plausible candidates", async () => {
	const seen: string[][] = [];
	const result = await recallSnapshot(
		[item("a", "お気に入りは南風亭"), item("b", "白波堂は港町にある")],
		"お気に入りの所在地は？",
		{
			candidates: selectAll,
			grounding: async (input) => {
				seen.push(
					JSON.parse(input).items.map((x: { itemId: string }) => x.itemId),
				);
				return unknown(input, {}, "recall");
			},
		},
		{ pageSize: 1 },
	);
	expect(seen).toEqual([["a", "b"]]);
	expect(result.parts[0]!.evidenceIds).toEqual([]);
	expect(result.coverage.complete).toBe(true);
});
test("page and candidate budgets expose incomplete search instead of definitive absence", async () => {
	for (const options of [
		{ pageSize: 1, maxPages: 1 },
		{ pageSize: 1, maxCandidates: 1 },
	]) {
		const result = await recallSnapshot(
			[item("a", "a"), item("b", "b")],
			"質問",
			{ candidates: selectAll, grounding: unknown },
			options,
		);
		expect(result.coverage.complete).toBe(false);
		expect(result.parts[0]!.status).toBe("unresolved");
	}
});
test("candidate and grounding IDs must belong to their supplied authorized sets", async () => {
	await expect(
		recallSnapshot([item("a", "a")], "質問", {
			candidates: async () => response({ itemIds: ["foreign"] }),
			grounding: unknown,
		}),
	).rejects.toThrow("Invalid candidate IDs");
	await expect(
		recallSnapshot([item("a", "a")], "質問", {
			candidates: selectAll,
			grounding: async () =>
				response({
					parts: [
						{ request: "質問", status: "supported", evidenceIds: ["foreign"] },
					],
				}),
		}),
	).rejects.toThrow("Invalid evidence part");
});
test("a failed page is an execution failure, not an empty successful answer", async () => {
	await expect(
		recallSnapshot([item("a", "a")], "質問", {
			candidates: async () => {
				throw Error("provider unavailable");
			},
			grounding: unknown,
		}),
	).rejects.toThrow("provider unavailable");
});
