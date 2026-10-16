import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { expect, test } from "bun:test";
import {
	recallMemory,
	recallSnapshot,
	recallItems,
	groundingInstructions,
} from "../../examples/experiments/representation/candidate.ts";
import { groundingInstructions as baseline } from "../../examples/experiments/representation/baseline.ts";
import { holdoutCases } from "../../examples/experiments/representation/cases.ts";
import { suites } from "../../examples/experiments/evidence-followup/cases.ts";
import { score } from "../../examples/experiments/evidence-followup/score.ts";
import { item } from "../../examples/experiments/cases.ts";
import { createHash } from "node:crypto";
const response = (ids: string[], status = "supported") => ({
	raw: JSON.stringify({
		parts: [{ request: "質問", status, evidenceIds: ids }],
	}),
	usage: null,
	threadId: null,
});
test("representation holdout has 100 unique questions, 25 families, five sizes and valid fixed gold", () => {
	expect(holdoutCases).toHaveLength(100);
	const old = new Set(
		Object.values(suites)
			.flat()
			.map((c) => c.message),
	);
	expect(new Set(holdoutCases.map((c) => c.message)).size).toBe(100);
	const families = new Map<string, number>(),
		sizes = new Map<number, number>();
	for (const c of holdoutCases) {
		expect(old.has(c.message)).toBe(false);
		families.set(c.family, (families.get(c.family) ?? 0) + 1);
		sizes.set(c.items.length, (sizes.get(c.items.length) ?? 0) + 1);
		expect(new Set(c.items.map((x) => x.itemId)).size).toBe(c.items.length);
		for (const p of c.parts) {
			expect(p.requiredIds.every((id) => p.allowedIds.includes(id))).toBe(true);
			expect(
				p.allowedIds.every((id) => c.items.some((x) => x.itemId === id)),
			).toBe(true);
			expect(
				p.status === "unknown"
					? p.allowedIds.length === 0
					: p.requiredIds.length >= (p.status === "conflict" ? 2 : 1),
			).toBe(true);
		}
		const correct = c.parts.map((p) => ({
			request: "質問",
			status: p.status,
			evidenceIds: p.requiredIds,
		}));
		expect(score(correct, c.parts).passed).toBe(true);
		expect(score(correct.slice(0, -1), c.parts).passed).toBe(false);
	}
	expect(families.size).toBe(25);
	expect([...families.values()].every((n) => n === 4)).toBe(true);
	expect([...sizes.entries()].sort((a, b) => a[0] - b[0])).toEqual(
		[8, 24, 64, 256, 1001].map((n) => [n, 20]),
	);
	expect(groundingInstructions.length).toBeLessThan(baseline.length);
});
test("all 1001 statements remain visible and exact local evidence maps back to original ID", async () => {
	const input = Array.from({ length: 1001 }, (_, i) =>
		item(`original-${i}`, `記録${i}`),
	);
	let calls = 0;
	const result = await recallSnapshot(input, "最後の記録", async (prompt) => {
		calls++;
		const view = JSON.parse(prompt).items;
		expect(view).toHaveLength(1001);
		expect(view[1000].statement).toEqual({ affirmed: "記録1000" });
		return response([view[1000].itemId]);
	});
	expect(calls).toBe(1);
	expect(result.parts[0]!.evidenceIds).toEqual(["original-1000"]);
	expect(result.snapshotHash).toBe(
		createHash("sha256").update(JSON.stringify(input)).digest("hex"),
	);
	expect(result.coverage).toEqual({ complete: true, itemCount: 1001 });
});
test("negation text, identity, label, kind and temporal metadata survive without interpretation", () => {
	const fact = {
		...item("x", "参加しないと決めた"),
		subject: "other:unique" as const,
		subjectLabel: "担当の渚",
		value: { text: "参加しないと決めた", polarity: "negated" as const },
		validity: {
			basis: "stated" as const,
			from: { precision: "month" as const, year: 2026, month: 5 },
		},
		validFromMs: 100,
		validUntilMs: 200,
	};
	const view = recallItems([fact])[0]!;
	expect(view).toMatchObject({
		subject: fact.subject,
		subjectLabel: fact.subjectLabel,
		kind: fact.kind,
		statement: { negated: fact.value.text },
		validFromMs: 100,
		validUntilMs: 200,
	});
	expect(view.validity).toEqual(fact.validity);
	expect("semanticKey" in view).toBe(false);
	expect("revision" in view).toBe(false);
	expect(fact.itemId).toBe("x");
});
test("refs are exact and snapshot-scoped; original numeric IDs do not collide", async () => {
	const input = [item("2", "a"), item("1", "b")];
	expect(
		(await recallSnapshot(input, "q", async () => response(["1"]))).parts[0]!
			.evidenceIds,
	).toEqual(["2"]);
	expect(
		(
			await recallSnapshot([...input].reverse(), "q", async () =>
				response(["1"]),
			)
		).parts[0]!.evidenceIds,
	).toEqual(["1"]);
	for (const ids of [["0"], ["3"], ["01"], ["1", "1"], ["original-1"]])
		await expect(
			recallSnapshot(input, "q", async () => response(ids)),
		).rejects.toThrow();
	await expect(
		recallSnapshot(input, "q", async () => response(["1"], "unknown")),
	).rejects.toThrow();
	await expect(
		recallSnapshot(input, "q", async () => response(["1"], "conflict")),
	).rejects.toThrow();
	await expect(
		recallSnapshot([input[0]!, input[0]!], "q", async () => response([])),
	).rejects.toThrow("Duplicate");
});
test("valid wrong evidence is not repaired, unknown is empty and failures propagate", async () => {
	const input = [item("a", "質問の答え"), item("b", "別の事実")];
	const wrong = await recallSnapshot(input, "q", async () => response(["2"]));
	expect(wrong.parts[0]!.evidenceIds).toEqual(["b"]);
	expect(
		score(wrong.parts, [
			{ status: "supported", requiredIds: ["a"], allowedIds: ["a"] },
		]).passed,
	).toBe(false);
	expect(
		(await recallSnapshot([], "q", async () => response([], "unknown")))
			.parts[0]!.evidenceIds,
	).toEqual([]);
	await expect(
		recallSnapshot(input, "q", async () => {
			throw Error("provider limit");
		}),
	).rejects.toThrow("provider limit");
});

test("compact recall joins real host identities and never leaks forgotten facts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compact-host-"));
	const host = new StandaloneHost(directory);
	try {
		const saved = host.remember(
			{
				type: "remember",
				subject: "other:p",
				kind: "other_person_note",
				semanticKey: "permit",
				value: { text: "入館許可を持つ", polarity: "negated" },
				quote: "入館許可を持たない",
				replacesItemId: null,
			},
			"入館許可を持たない",
		);
		const result = await recallMemory(
			host,
			"担当者の許可は？",
			async (input) => {
				const items = JSON.parse(input).items;
				expect(items).toHaveLength(1);
				expect(items[0]).toMatchObject({
					subject: "other:p",
					subjectLabel: "担当者の千帆",
					statement: { negated: "入館許可を持つ" },
				});
				return response([items[0].itemId]);
			},
			{ subjects: [{ id: "other:p", label: "担当者の千帆" }] },
		);
		expect(result.parts[0]!.evidenceIds).toEqual([saved.itemId]);
		host.forgetFact(saved.itemId);
		await recallMemory(host, "担当者の許可は？", async (input) => {
			expect(JSON.parse(input).items).toEqual([]);
			return response([], "unknown");
		});
	} finally {
		host.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
