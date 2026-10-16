import { expect, test } from "bun:test";
import {
	recallSnapshot,
	recallMemory,
} from "../../examples/standalone/retrieval.ts";
import { item } from "../../examples/experiments/cases.ts";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const response = (parts: unknown[]) => ({
	raw: JSON.stringify({ parts }),
	usage: null,
	threadId: null,
});
const unknown = () =>
	response([{ request: "質問", status: "unknown", evidenceIds: [] }]);

test("one-shot recall sends all 1001 authorized facts exactly once with no selection stage", async () => {
	const items = Array.from({ length: 1001 }, (_, i) =>
		item(`i${i}`, `記録${i}`),
	);
	let calls = 0;
	const result = await recallSnapshot(
		items,
		"最後の記録",
		async (input, _schema, task) => {
			calls++;
			expect(task).toBe("recall");
			expect(JSON.parse(input)).toEqual({ message: "最後の記録", items });
			return response([
				{ request: "最後の記録", status: "supported", evidenceIds: ["i1000"] },
			]);
		},
	);
	expect(calls).toBe(1);
	expect(result.parts[0]!.evidenceIds).toEqual(["i1000"]);
	expect(result.coverage).toEqual({ complete: true, itemCount: 1001 });
});
test("one-shot recall preserves labels, normalized negation and only surviving host facts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "one-shot-host-"));
	const host = new StandaloneHost(directory);
	try {
		const text = "会員である";
		const saved = host.remember(
			{
				type: "remember",
				subject: "other:p",
				kind: "other_person_note",
				semanticKey: "member",
				value: { text, polarity: "negated" },
				quote: "会員ではない",
				replacesItemId: null,
			},
			"会員ではない",
		);
		await recallMemory(
			host,
			"担当者は会員か",
			async (input) => {
				expect(JSON.parse(input).items[0]).toMatchObject({
					subject: "other:p",
					subjectLabel: "担当者の理央",
					value: { text, polarity: "negated" },
				});
				return unknown();
			},
			{ subjects: [{ id: "other:p", label: "担当者の理央" }] },
		);
		host.forgetFact(saved.itemId);
		const result = await recallMemory(host, "担当者は会員か", async (input) => {
			expect(JSON.parse(input).items).toEqual([]);
			return unknown();
		});
		expect(result.coverage.itemCount).toBe(0);
	} finally {
		host.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
test("unknown IDs, duplicate snapshot IDs, missing parts and malformed polarity evidence fail closed", async () => {
	const facts = [item("a", "a")];
	for (const parts of [
		[],
		[{ request: "q", status: "supported", evidenceIds: ["outside"] }],
		[{ request: "q", status: "conflict", evidenceIds: ["a"] }],
	])
		await expect(
			recallSnapshot(facts, "q", async () => response(parts)),
		).rejects.toThrow();
	await expect(
		recallSnapshot([...facts, ...facts], "q", async () => unknown()),
	).rejects.toThrow("Duplicate");
});
test("provider/context-limit failure is not converted to a successful unknown result", async () => {
	await expect(
		recallSnapshot([item("a", "a")], "q", async () => {
			throw Error("context limit");
		}),
	).rejects.toThrow("context limit");
});
