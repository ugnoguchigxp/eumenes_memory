import { expect, test } from "bun:test";
import {
	parsePlan,
	planMemory,
	snapshotHash,
} from "../../examples/standalone/planning.ts";
import { item } from "../../examples/experiments/cases.ts";
import { modelItems } from "../../examples/standalone/model-input.ts";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "../../examples/standalone/protocol.ts";
const remember = (key: string): Action => ({
	type: "remember",
	kind: "preference",
	subject: "self",
	semanticKey: key,
	value: { text: "紅茶が好き", polarity: "affirmed" },
	quote: "紅茶が好き",
	replacesItemId: null,
});
const raw = (
	action: Action,
	relation: string,
	relatedItemIds: string[],
	clarification: string | null = null,
) =>
	JSON.stringify({
		decision: { actions: [action], clarification },
		groups: [[0]],
		relations: [{ actionIndex: 0, relation, relatedItemIds }],
	});

test("same propositions are withheld; coexistence must use a distinct identity", () => {
	const facts = [item("a", "紅茶が好き")];
	expect(
		parsePlan(raw(remember("tea"), "same", ["a"]), facts, "紅茶が好き")
			.changes[0]!.actions,
	).toEqual([]);
	expect(() =>
		parsePlan(
			raw(remember("interest"), "coexists", ["a"]),
			facts,
			"紅茶が好き",
		),
	).toThrow("Existing identity");
	expect(
		parsePlan(
			raw(remember("other-interest"), "coexists", ["a"]),
			facts,
			"紅茶が好き",
		).changes[0]!.actions,
	).toHaveLength(1);
});
test("corrections preserve exact identity; unresolved conflicts require clarification", () => {
	const facts = [item("a", "紅茶が好き")];
	expect(() =>
		parsePlan(
			raw(
				{ ...remember("wrong"), replacesItemId: "a" } as Action,
				"supersedes",
				["a"],
			),
			facts,
			"紅茶が好き",
		),
	).toThrow("Invalid correction identity");
	expect(() =>
		parsePlan(
			raw(remember("interest"), "conflicts", ["a"]),
			facts,
			"紅茶が好き",
		),
	).toThrow("clarification");
	expect(
		parsePlan(
			raw(remember("interest"), "conflicts", ["a"], "どちらですか"),
			facts,
			"紅茶が好き",
		).changes[0]!.actions,
	).toEqual([]);
});
test("semantic forget selections can span keys but never inaccessible IDs", () => {
	const facts = [
		item("a", "陶芸が趣味"),
		{ ...item("b", "陶芸が趣味"), semanticKey: "leisure" },
	];
	expect(
		parsePlan(
			raw({ type: "forget", itemId: "a" }, "forget", ["a", "b"]),
			facts,
			"忘れて",
		).changes[0]!.actions,
	).toEqual([
		{ type: "forget", itemId: "a" },
		{ type: "forget", itemId: "b" },
	]);
	expect(() =>
		parsePlan(
			raw({ type: "forget", itemId: "a" }, "forget", ["a", "foreign"]),
			facts,
			"忘れて",
		),
	).toThrow("Invalid action relation");
});
test("every proposed action needs exactly one resolution", () => {
	const value = JSON.parse(raw(remember("tea"), "new", []));
	value.relations = [];
	expect(() => parsePlan(JSON.stringify(value), [], "紅茶が好き")).toThrow(
		"Missing action relations",
	);
});
test("planning is read-only and binds to the snapshot observed before the model call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "planning-"));
	const host = new StandaloneHost(dir);
	try {
		const before = snapshotHash(modelItems(host.list()));
		const plan = await planMemory(host, "紅茶が好き", async () => {
			host.remember(
				remember("tea") as Extract<Action, { type: "remember" }>,
				"紅茶が好き",
			);
			return {
				raw: JSON.stringify({
					decision: { actions: [], clarification: null },
					groups: [],
					relations: [],
				}),
				usage: null,
				threadId: null,
			};
		});
		expect(plan.snapshotHash).toBe(before);
		expect(plan.snapshotHash).not.toBe(snapshotHash(modelItems(host.list())));
	} finally {
		host.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
