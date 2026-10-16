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

test("corrected retrieval inputs keep every question/gold while resolving explicit owner and polarity defects", async () => {
	const dir = mkdtempSync(join(tmpdir(), "holdout-metadata-"));
	try {
		const original = { retrieval: retrievalCases() };
		await Bun.write(join(dir, "in.json"), JSON.stringify(original));
		const subprocess = Bun.spawn(
			[
				process.execPath,
				"examples/experiments/holdout-100/prepare-retrieval-v2.ts",
				join(dir, "in.json"),
				join(dir, "out.json"),
				join(dir, "runner.ts"),
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		expect(await subprocess.exited).toBe(0);
		const corrected = await Bun.file(join(dir, "out.json")).json();
		for (const [i, c] of original.retrieval.entries()) {
			expect(corrected.retrieval[i].message).toBe(c.message);
			expect(corrected.retrieval[i].parts).toEqual(c.parts);
			expect(
				corrected.retrieval[i].items.map((x: { itemId: string }) => x.itemId),
			).toEqual(c.items.map((x) => x.itemId));
		}
		const facts = (id: string) =>
			corrected.retrieval.find((x: { id: string }) => x.id === id).items;
		expect(
			facts("R021").find(
				(x: { semanticKey: string }) => x.semanticKey === "field-0",
			).subject,
		).toBe("other:actor");
		const negative = facts("R036").find(
			(x: { semanticKey: string }) => x.semanticKey === "field-0",
		);
		expect(negative.value.polarity).toBe("negated");
		expect(negative.value.text).toBe("私はチェロが好き");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
