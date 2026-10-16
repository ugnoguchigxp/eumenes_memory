import { expect, test } from "bun:test";
import {
	retrievalCases,
	identityCases,
	executionCases,
} from "../../examples/experiments/holdout-100/cases.ts";
import { parseRecall } from "../../examples/experiments/frozen-protocol.ts";
import { parsePlan } from "../../examples/standalone/planning.ts";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("holdout has 100 unique complete cases in each arm, with explicit authorized evidence", () => {
	for (const cases of [retrievalCases(), identityCases(), executionCases()]) {
		expect(cases.length).toBe(100);
		expect(new Set(cases.map((c) => c.id)).size).toBe(100);
		expect(new Set(cases.map((c) => c.family)).size).toBe(20);
	}
	for (const c of retrievalCases()) {
		const ids = c.items.map((x) => x.itemId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(c.parts.every((p) => p.ids.every((id) => ids.includes(id)))).toBe(
			true,
		);
		expect(
			c.parts.every((p) => p.status !== "unknown" || p.ids.length === 0),
		).toBe(true);
	}
});
test("baseline legacy recall parser matches its actual schema; pre-group planning adapts without semantic changes", () => {
	expect(parseRecall('{"itemIds":["a"]}')).toEqual(["a"]);
	expect(() =>
		parseRecall('{"answers":[{"request":"x","itemIds":["a"]}]}'),
	).toThrow();
	const old = { decision: { actions: [], clarification: null }, relations: [] };
	expect(
		parsePlan(JSON.stringify({ ...old, groups: [] }), [], "read only").changes,
	).toEqual([]);
});
test("every mutation seed can be persisted through real public host contracts", () => {
	for (const c of [...identityCases(), ...executionCases()]) {
		const dir = mkdtempSync(join(tmpdir(), "holdout-seed-"));
		const host = new StandaloneHost(dir);
		try {
			for (const f of c.seed)
				host.remember(
					{
						type: "remember",
						subject: f.subject,
						kind: f.kind,
						semanticKey: f.key,
						value: { text: f.text, polarity: f.polarity },
						quote: f.text,
						replacesItemId: null,
					},
					f.text,
				);
			expect(host.list().length).toBe(c.seed.length);
			expect(c.preserve.every((key) => c.seed.some((x) => x.key === key))).toBe(
				true,
			);
		} finally {
			host.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
