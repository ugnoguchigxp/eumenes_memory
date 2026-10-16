import { expect, test } from "bun:test";
import { codexOptions } from "../../examples/standalone/luna.ts";
import { judgeInput, sameIds } from "../../examples/experiments/factorial.ts";
import { item } from "../../examples/experiments/cases.ts";
import { parallel, variants } from "../../examples/experiments/experiment.ts";

test("standalone snapshot reaches old facts beyond 1000 and can replace and forget them", async () => {
	const { StandaloneHost } = await import("../../examples/standalone/host.ts");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = mkdtempSync(join(tmpdir(), "host-pagination-"));
	const host = new StandaloneHost(directory);
	try {
		let oldest = "";
		for (let i = 0; i < 1001; i++) {
			const text = `展示品${i}が好き`;
			const saved = host.remember(
				{
					type: "remember",
					subject: "self",
					kind: "preference",
					semanticKey: `fact-${i}`,
					value: { text, polarity: "affirmed" },
					quote: text,
					replacesItemId: null,
				},
				text,
			);
			if (i === 0) oldest = saved.itemId;
		}
		expect(host.list().length).toBe(1001);
		expect(host.list().some((x) => x.itemId === oldest)).toBe(true);
		const text = "展示品0が大好き";
		const replacement = host.remember(
			{
				type: "remember",
				subject: "self",
				kind: "preference",
				semanticKey: "fact-0",
				value: { text, polarity: "affirmed" },
				quote: text,
				replacesItemId: oldest,
			},
			text,
		);
		expect(host.list().length).toBe(1001);
		expect(host.list(true).length).toBe(1002);
		expect(host.forgetFact(oldest)).toContain(replacement.itemId);
		expect(host.list(true).length).toBe(1000);
	} finally {
		host.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("instruction overrides retain isolation and exact frozen instructions", () => {
	const config = codexOptions(
		{},
		undefined,
		"judge",
		variants.v9.instructions.judge,
	).config!;
	expect(config["developer_instructions"]).toBe(variants.v9.instructions.judge);
	expect(config["web_search"]).toBe("disabled");
	expect(config["features"]).toEqual({
		shell_tool: false,
		multi_agent: false,
		skill_search: false,
	});
});
test("cross judges receive identical facts, v10 additionally receives the declared message", () => {
	const actual = [item("a", "版画が好き")];
	const expected = [item("b", "版画を好む")];
	const a = judgeInput(actual, expected, "同義");
	const b = judgeInput(actual, expected, "同義", "版画が好き");
	expect(a.actual).toEqual(b.actual);
	expect(a.expected).toEqual(b.expected);
	expect(a.expected[0]).not.toHaveProperty("semanticKey");
	expect(a.actual[0]).toHaveProperty("semanticKey");
	expect("message" in a).toBe(false);
	expect(b.message).toBe("版画が好き");
	expect(sameIds(["a", "b"], ["b", "a"])).toBe(true);
	expect(sameIds(["a"], [])).toBe(false);
});

test("directory selection returns only authorized original facts, never summary text", async () => {
	const { directoryCandidates } =
		await import("../../examples/experiments/directory.ts");
	const fact = item("a", "毎朝走る");
	const pages = [{ pageId: "p", summary: "routing hint only", items: [fact] }];
	expect(directoryCandidates('{"pageIds":["p"]}', pages)).toEqual([fact]);
	expect(directoryCandidates('{"pageIds":[]}', pages)).toEqual([]);
	expect(() => directoryCandidates('{"pageIds":["foreign"]}', pages)).toThrow();
	expect(() => directoryCandidates('{"pageIds":["p","p"]}', pages)).toThrow();
});

test("page scan reaches a later page and rejects evidence from another page", async () => {
	const { scanRecall } =
		await import("../../examples/experiments/retrieval.ts");
	const { Experiment } =
		await import("../../examples/experiments/experiment.ts");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = mkdtempSync(join(tmpdir(), "scan-test-"));
	try {
		const exp = new Experiment(directory, "test", {});
		let count = 0;
		const items = [item("a", "陶芸が趣味"), item("b", "毎朝走る")];
		const result = await scanRecall(
			exp,
			async () => ({
				raw: JSON.stringify({ itemIds: ++count === 1 ? [] : ["b"] }),
				usage: null,
				threadId: null,
			}),
			"later",
			"運動は？",
			items,
			1,
		);
		expect(result).toEqual(["b"]);
		expect(count).toBe(2);
		await expect(
			scanRecall(
				exp,
				async () => ({ raw: '{"itemIds":["b"]}', usage: null, threadId: null }),
				"foreign",
				"運動は？",
				items,
				1,
			),
		).rejects.toThrow("Out-of-page ID");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
test("provider failure drains in-flight calls but does not start further work", async () => {
	let completed = false;
	let third = false;
	await expect(
		parallel(
			[
				async () => {
					throw Error("provider");
				},
				async () => {
					await new Promise((r) => setTimeout(r, 10));
					completed = true;
				},
				async () => {
					third = true;
				},
			],
			2,
		),
	).rejects.toThrow("provider");
	expect(completed).toBe(true);
	expect(third).toBe(false);
});

test("evidence contract rejects inaccessible IDs and unsupported status/evidence pairs", async () => {
	const { parseEvidence, sameParts } =
		await import("../../examples/experiments/answers.ts");
	const raw = (status: string, evidenceIds: string[]) =>
		JSON.stringify({ parts: [{ request: "頻度", status, evidenceIds }] });
	expect(parseEvidence(raw("unknown", []), ["a"])[0]!.status).toBe("unknown");
	for (const [status, ids] of [
		["unknown", ["a"]],
		["supported", []],
		["supported", ["foreign"]],
		["conflict", ["a"]],
	] as [string, string[]][])
		expect(() => parseEvidence(raw(status, ids), ["a"])).toThrow();
	expect(() =>
		parseEvidence(
			JSON.stringify({
				parts: [{ request: "x", status: "supported", evidenceIds: ["a", "a"] }],
			}),
			["a"],
		),
	).toThrow();
	expect(
		sameParts(parseEvidence(raw("unknown", []), []), [
			{ status: "supported", evidenceIds: ["a"] },
		]),
	).toBe(false);
});

test("regrading removes only the erroneous expected semantic key and preserves actual output", async () => {
	const { correctJudgeInput } =
		await import("../../examples/experiments/regrade.ts");
	const input = {
		actual: [{ text: "週3回走る", semanticKey: "running" }],
		expected: [{ text: "週3回走る", semanticKey: "interest" }],
		criterion: "頻度保持",
	};
	const corrected = correctJudgeInput(input);
	expect(corrected["actual"]).toEqual(input.actual);
	expect(corrected["expected"]).toEqual([{ text: "週3回走る" }]);
	expect(input.expected[0]!.semanticKey).toBe("interest");
});
