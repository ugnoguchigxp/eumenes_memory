import { expect, test } from "bun:test";
import { freshCases, regressionCases } from "../../examples/quality/cases.ts";
import { score } from "../../examples/experiments/one-shot-holdout/score.ts";
test("new authored cases have24 families,120distinct questions and predeclared executable gold", () => {
	expect(freshCases).toHaveLength(120);
	expect(new Set(freshCases.map((c) => c.family)).size).toBe(24);
	expect(new Set(freshCases.map((c) => c.message)).size).toBe(120);
	for (const c of freshCases) {
		const ids = new Set(c.items.map((i) => i.itemId));
		expect(ids.size).toBe(c.items.length);
		for (const p of c.parts)
			for (const id of p.allowedIds) expect(ids.has(id)).toBe(true);
		expect(
			score(
				c.parts.map((p) => ({
					request: c.message,
					status: p.status,
					evidenceIds: p.requiredIds,
				})),
				c.parts,
			).passed,
		).toBe(true);
		expect(
			score(
				[
					{
						request: c.message,
						status: "supported",
						evidenceIds: ["invented"],
					},
				],
				c.parts,
			).passed,
		).toBe(false);
	}
});
test("fixed regressions retain original content and all five input volumes", () => {
	expect(regressionCases).toHaveLength(80);
	expect(new Set(regressionCases.map((c) => c.items.length))).toEqual(
		new Set([8, 24, 64, 256, 1001]),
	);
	expect(regressionCases.every((c) => c.id.startsWith("R-"))).toBe(true);
});
