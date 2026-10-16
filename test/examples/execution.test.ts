import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { applyMemoryPlan } from "../../examples/standalone/execution.ts";
import {
	snapshotHash,
	planMemory,
	type MemoryPlan,
} from "../../examples/standalone/planning.ts";
import { recallMemory } from "../../examples/standalone/retrieval.ts";
import { modelItems } from "../../examples/standalone/model-input.ts";
import type {
	Action,
	RememberAction,
} from "../../examples/standalone/protocol.ts";

const remember = (key: string): RememberAction => ({
	type: "remember",
	subject: "self",
	kind: "preference",
	semanticKey: key,
	value: { text: key, polarity: "affirmed" },
	quote: key,
	replacesItemId: null,
});
function plan(
	host: StandaloneHost,
	actions: Action[],
	groups = actions.map((_, i) => [i]),
): MemoryPlan {
	return {
		snapshotHash: snapshotHash(modelItems(host.list())),
		message: "tea coffee",
		clarification: null,
		groups,
		changes: actions.map((a, actionIndex) => ({
			actionIndex,
			relation: a.type === "forget" ? "forget" : "new",
			relatedItemIds: [],
			actions: [a],
		})),
	};
}
function fixture(operation: (host: StandaloneHost, dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "memory-execution-"));
	const host = new StandaloneHost(dir);
	try {
		operation(host, dir);
	} finally {
		host.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
// Arm the failure only after previews. This simulates an execution-time storage failure.
function failActualCoffee(host: StandaloneHost): () => void {
	const preview = host.preview.bind(host);
	const write = host.remember.bind(host);
	let previewing = false;
	host.preview = (...args) => {
		previewing = true;
		try {
			preview(...args);
		} finally {
			previewing = false;
		}
	};
	host.remember = (action, message) => {
		if (!previewing && action.semanticKey === "coffee")
			throw Error("injected storage failure");
		return write(action, message);
	};
	return () => {
		host.preview = preview;
		host.remember = write;
	};
}

test("preflight checks all actions without state or host-log side effects", () =>
	fixture((host, dir) => {
		const good = remember("tea");
		host.preview([good], "tea");
		expect(host.list()).toEqual([]);
		expect(existsSync(join(dir, "sources.jsonl"))).toBe(false);
		const invalid = { ...remember("coffee"), quote: "absent" };
		expect(() =>
			applyMemoryPlan(host, "invalid", plan(host, [good, invalid])),
		).toThrow("Quote");
		expect(host.list()).toEqual([]);
		expect(existsSync(join(dir, "sources.jsonl"))).toBe(false);
		expect(readFileSync(host.journalPath, "utf8")).toBe("");
	}));

test("dependent remember group rolls back fully and can retry without duplicate state", () =>
	fixture((host) => {
		const p = plan(host, [remember("tea"), remember("coffee")], [[0, 1]]);
		const restore = failActualCoffee(host);
		expect(applyMemoryPlan(host, "atomic", p).status).toBe("failed");
		expect(host.list()).toHaveLength(0);
		restore();
		expect(applyMemoryPlan(host, "atomic", p).status).toBe("completed");
		const committed = host.list(true);
		expect(committed).toHaveLength(2);
		expect(applyMemoryPlan(host, "atomic", p).status).toBe("completed");
		expect(host.list(true)).toEqual(committed);
	}));

test("independent completed group survives restart and is not repeated on retry", () =>
	fixture((host, dir) => {
		const p = plan(host, [remember("tea"), remember("coffee")]);
		failActualCoffee(host);
		expect(applyMemoryPlan(host, "partial", p)).toMatchObject({
			status: "partial",
			groups: ["applied", "failed"],
		});
		const first = host.list()[0]!;
		host.close();
		const reopened = new StandaloneHost(dir);
		try {
			expect(applyMemoryPlan(reopened, "partial", p).status).toBe("completed");
			expect(reopened.list(true)).toHaveLength(2);
			expect(reopened.list().find((x) => x.itemId === first.itemId)).toEqual(
				first,
			);
		} finally {
			reopened.close();
		}
	}));

test("operation IDs bind exact plans and stale plans cannot mutate state", () =>
	fixture((host) => {
		const p = plan(host, [remember("tea")]);
		const stale = plan(host, [remember("coffee")]);
		applyMemoryPlan(host, "one", p);
		expect(() => applyMemoryPlan(host, "one", stale)).toThrow("different plan");
		expect(() => applyMemoryPlan(host, "two", stale)).toThrow("Stale");
		expect(host.list(true)).toHaveLength(1);
	}));

test("forget intent resumes all versions and aliases after a durable-journal crash", () =>
	fixture((host, dir) => {
		const old = host.remember(remember("tea"), "tea");
		const current = host.remember(
			{
				...remember("tea"),
				value: { text: "new tea", polarity: "affirmed" },
				replacesItemId: old.itemId,
			},
			"tea",
		);
		const alias = host.remember(remember("coffee"), "coffee");
		const retained = host.remember(remember("water"), "water");
		const p = plan(
			host,
			[
				{ type: "forget", itemId: current.itemId },
				{ type: "forget", itemId: alias.itemId },
			],
			[[0, 1]],
		);
		const forget = host.forget.bind(host);
		const preview = host.preview.bind(host);
		let previewing = false;
		host.preview = (...args) => {
			previewing = true;
			try {
				preview(...args);
			} finally {
				previewing = false;
			}
		};
		host.forget = (target) => forget(target, !previewing);
		expect(applyMemoryPlan(host, "forget", p).status).toBe("partial");
		expect(
			readFileSync(host.journalPath, "utf8").trim().split("\n"),
		).toHaveLength(1);
		host.close();
		const reopened = new StandaloneHost(dir);
		try {
			expect(applyMemoryPlan(reopened, "forget", p).status).toBe("completed");
			expect(reopened.list().map((x) => x.itemId)).toEqual([retained.itemId]);
			const journal = readFileSync(reopened.journalPath, "utf8");
			expect(journal.trim().split("\n")).toHaveLength(3);
			expect(applyMemoryPlan(reopened, "forget", p).status).toBe("completed");
			expect(readFileSync(reopened.journalPath, "utf8")).toBe(journal);
		} finally {
			reopened.close();
		}
	}));

test("external writes between attempts require replanning rather than accepting a new snapshot", () =>
	fixture((host) => {
		const p = plan(host, [remember("tea"), remember("coffee")]);
		const restore = failActualCoffee(host);
		applyMemoryPlan(host, "partial", p);
		restore();
		host.remember(remember("water"), "water");
		expect(applyMemoryPlan(host, "partial", p)).toMatchObject({
			status: "partial",
			groups: ["applied", "failed"],
		});
		expect(
			host
				.list()
				.map((x) => x.semanticKey)
				.sort(),
		).toEqual(["tea", "water"]);
	}));

test("mixed groups and malformed grouping fail before effects", () =>
	fixture((host) => {
		const tea = host.remember(remember("tea"), "tea");
		const p = plan(
			host,
			[{ type: "forget", itemId: tea.itemId }, remember("coffee")],
			[[0, 1]],
		);
		expect(() => applyMemoryPlan(host, "mixed", p)).toThrow("Mixed");
		expect(() =>
			applyMemoryPlan(host, "duplicate", { ...p, groups: [[0], [0]] }),
		).toThrow("duplicate");
		expect(host.list()).toHaveLength(1);
		expect(readFileSync(host.journalPath, "utf8")).toBe("");
	}));

test("conflict blocks its entire dependent group while independent changes proceed", () =>
	fixture((host) => {
		const p = plan(
			host,
			[remember("tea"), remember("coffee"), remember("tea")],
			[[0, 1], [2]],
		);
		p.changes[0]!.relation = "conflicts";
		p.changes[0]!.actions = [];
		p.clarification = "which?";
		expect(applyMemoryPlan(host, "blocked", p)).toEqual({
			status: "needs_clarification",
			groups: ["blocked", "applied"],
		});
		expect(host.list().map((x) => x.semanticKey)).toEqual(["tea"]);
	}));

test("receipts store no assertion, source or clarification text", () =>
	fixture((host) => {
		const p = plan(host, [remember("tea")]);
		p.clarification = "private question";
		applyMemoryPlan(host, "opaque-id", p);
		const rows = JSON.stringify(
			host.read((db) =>
				db.query("SELECT * FROM example_memory_operation").all(),
			),
		);
		expect(rows).not.toContain("tea");
		expect(rows).not.toContain("coffee");
		expect(rows).not.toContain("private question");
	}));

test("model plan, execution and grounded retrieval compose through the real host", async () => {
	const dir = mkdtempSync(join(tmpdir(), "memory-through-"));
	const host = new StandaloneHost(dir);
	const response = (value: unknown) => ({
		raw: JSON.stringify(value),
		usage: null,
		threadId: null,
	});
	try {
		const p = await planMemory(host, "tea", async () =>
			response({
				decision: { actions: [remember("tea")], clarification: null },
				relations: [{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
				groups: [[0]],
			}),
		);
		expect(applyMemoryPlan(host, "through", p).status).toBe("completed");
		const result = await recallMemory(host, "preference?", async (input) =>
			response({
				parts: [
					{
						request: "preference",
						status: "supported",
						evidenceIds: JSON.parse(input).items.map(
							(x: { itemId: string }) => x.itemId,
						),
					},
				],
			}),
		);
		expect(result.parts[0]!.evidenceIds).toEqual([host.list()[0]!.itemId]);
		expect(result.coverage.complete).toBe(true);
	} finally {
		host.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
