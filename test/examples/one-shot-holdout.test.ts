import { expect, test } from "bun:test";
import { holdoutCases } from "../../examples/experiments/one-shot-holdout/cases.ts";
import { score } from "../../examples/experiments/one-shot-holdout/score.ts";

test("new holdout has 100 unique questions, 25 families and valid explicit evidence contracts", () => {
	expect(holdoutCases.length).toBe(100);
	expect(new Set(holdoutCases.map((c) => c.message)).size).toBe(100);
	const families = new Map<string, number>();
	for (const c of holdoutCases) {
		families.set(c.family, (families.get(c.family) ?? 0) + 1);
		expect(new Set(c.items.map((x) => x.itemId)).size).toBe(c.items.length);
		for (const item of c.items) {
			expect(item.kind).toBe(
				item.subject === "self" ? "personal_fact" : "other_person_note",
			);
			expect(Boolean(item.subjectLabel)).toBe(true);
		}
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
	}
	expect(families.size).toBe(25);
	expect([...families.values()].every((n) => n === 4)).toBe(true);
	for (const size of [8, 24, 64, 256, 1001])
		expect(holdoutCases.filter((c) => c.items.length === size).length).toBe(20);
});
test("scorer accepts predeclared context but rejects wrong owner evidence, missing links and false conflicts", () => {
	const gold = [
		{
			status: "supported" as const,
			requiredIds: ["exception"],
			allowedIds: ["exception", "general"],
		},
	];
	const p = (
		status: "supported" | "unknown" | "conflict",
		...evidenceIds: string[]
	) => [{ request: "任意の言い換え", status, evidenceIds }];
	expect(score(p("supported", "exception"), gold).passed).toBe(true);
	expect(score(p("supported", "general", "exception"), gold).passed).toBe(true);
	expect(score(p("supported", "other-owner", "exception"), gold).passed).toBe(
		false,
	);
	expect(score(p("conflict", "general", "exception"), gold).passed).toBe(false);
	expect(score(p("supported", "general"), gold).passed).toBe(false);
	expect(score([], gold).passed).toBe(false);
	expect(
		score([...p("supported", "exception"), ...p("unknown")], gold).passed,
	).toBe(false);
	expect(
		score(p("supported", "last-link"), [
			{
				status: "supported",
				requiredIds: ["first-link", "last-link"],
				allowedIds: ["first-link", "last-link"],
			},
		]).passed,
	).toBe(false);
});
