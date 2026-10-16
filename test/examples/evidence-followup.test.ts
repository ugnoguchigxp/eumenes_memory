import { test, expect } from "bun:test";
import { suites } from "../../examples/experiments/evidence-followup/cases.ts";
import {
	baseline,
	semantic,
	output,
} from "../../examples/experiments/evidence-followup/prompts.ts";
import { holdoutCases } from "../../examples/experiments/one-shot-holdout/cases.ts";
import { score } from "../../examples/experiments/evidence-followup/score.ts";
import { parseEvidence } from "../../examples/standalone/support.ts";
test("two unused authored suites preserve strict status, owner and evidence scoring", () => {
	const questions = new Set(holdoutCases.map((c) => c.message));
	for (const cases of Object.values(suites)) {
		expect(cases).toHaveLength(100);
		expect(new Set(cases.map((c) => c.family)).size).toBe(25);
		for (const size of [8, 24, 64, 256, 1001])
			expect(cases.filter((c) => c.items.length === size)).toHaveLength(20);
		for (const c of cases) {
			expect(questions.has(c.message)).toBe(false);
			questions.add(c.message);
			const ids = c.items.map((i) => i.itemId);
			expect(new Set(ids).size).toBe(ids.length);
			for (const p of c.parts) {
				expect(new Set(p.allowedIds).size).toBe(p.allowedIds.length);
				for (const id of p.requiredIds)
					expect(p.allowedIds.includes(id)).toBe(true);
				for (const id of p.allowedIds) expect(ids.includes(id)).toBe(true);
			}
			const correct = c.parts.map((p, i) => ({
				request: `part${i}`,
				status: p.status,
				evidenceIds: p.requiredIds,
			}));
			expect(() =>
				parseEvidence(JSON.stringify({ parts: correct }), ids),
			).not.toThrow();
			expect(score(correct, c.parts).passed).toBe(true);
			expect(score(correct.slice(1), c.parts).passed).toBe(false);
			for (let i = 0; i < correct.length; i++) {
				const wrong = structuredClone(correct);
				wrong[i]!.evidenceIds.push("unauthorized");
				expect(score(wrong, c.parts).passed).toBe(false);
				expect(() =>
					parseEvidence(JSON.stringify({ parts: wrong }), ids),
				).toThrow();
			}
		}
	}
});
test("two fixed prompt changes remain independent and composable", () => {
	expect(semantic(baseline)).not.toBe(baseline);
	expect(output(baseline)).not.toBe(baseline);
	expect(output(semantic(baseline))).toBe(semantic(output(baseline)));
	expect(semantic(baseline).length).toBeLessThan(baseline.length * 1.2);
	expect(output(baseline).length).toBeLessThan(baseline.length * 1.2);
});
