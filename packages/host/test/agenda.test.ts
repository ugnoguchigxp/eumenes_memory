import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollback0009 } from "../scripts/rollback-0009.ts";
import { initialize, request, startStandalone } from "../src/index.ts";
import { natural } from "../src/natural.ts";
import type { AgendaItem } from "../src/agenda-contract.ts";
import type { Complete } from "../src/meaning/protocol.ts";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of dispose.splice(0).reverse()) await close();
});

/**
 * 版 9 の DB を作る。ホストは常に最新の `migrations` を適用するので、開いた後で migration 0010 を取り消す
 * （0010 の表・列・版の記録を除く）。rollback-0009 は版 9 の DB だけを扱う。
 */
function downgradeToVersion9(dir: string): void {
	const db = new Database(join(dir, "memory.db"));
	try {
		db.exec(`
			DROP TABLE memory_inferred_candidate_evidence;
			DROP TABLE memory_inferred_candidate;
			DROP TABLE memory_suppression;
			DROP TABLE memory_exclusion;
			ALTER TABLE memory_state_item DROP COLUMN strength;
			ALTER TABLE memory_change DROP COLUMN successor_id;
			ALTER TABLE memory_change DROP COLUMN change_kind;
			ALTER TABLE memory_change DROP COLUMN source_run_id;
			DELETE FROM memory_schema_info WHERE key = 'migration_10_sha256';
			UPDATE memory_schema_info SET value = '9' WHERE key = 'db_schema_version';
		`);
	} finally {
		db.close();
	}
}

async function fixture(legacy = false) {
	const dir = mkdtempSync(join(tmpdir(), "em-agenda-"));
	const profile = initialize(dir, ["personal", "work"]);
	const dbPath = join(dir, "memory.db");
	const backup = join(dir, "old.db");
	if (legacy) {
		const db = new Database(dbPath);
		// Restore the exact v1 host shape while preserving a pre-existing registered source.
		db.exec(`
			DROP TABLE host_agenda;
			DROP TABLE host_item_use;
			DROP TABLE host_operation_horizon;
			ALTER TABLE host_source DROP COLUMN provenance;
			UPDATE host_schema SET version=1;
		`);
		db.query("INSERT INTO host_source VALUES (?,?,?,?,?,?,?,?,?,?)").run(
			"legacy",
			"owner",
			"legacy",
			"personal",
			"text",
			"緑茶が好き",
			JSON.stringify({
				namespace: "eumenes-host",
				kind: "message",
				id: "legacy",
				representation: "text",
				revision: "sha256:7d",
			}),
			"agent_inferred",
			Date.now(),
			0,
		);
		db.close();
	}
	let owner = await startStandalone(dir);
	dispose.push(async () => {
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const call = (method: string, params: unknown = {}) =>
		request(profile, method, params);
	const context = (scopeKey = "personal") =>
		call("context", { scopeKeys: [scopeKey], agenda: true });
	const source = (
		content: string,
		kind = "text",
		submissionId: string = crypto.randomUUID(),
	) => call("source", { submissionId, scopeKey: "personal", content, kind });
	const apply = (plan: Awaited<ReturnType<typeof call>>) => {
		expect(plan.status === "planned" ? plan.status : plan).toBe("planned");
		return call("apply", {
			planId: plan["planId"],
			epoch: plan["epoch"],
			operationId: crypto.randomUUID(),
		});
	};
	const restart = async (action?: "backup" | "restore" | "legacy-agenda") => {
		await owner.close();
		if (action === "backup") copyFileSync(dbPath, backup);
		if (action === "restore") copyFileSync(backup, dbPath);
		if (action === "legacy-agenda") {
			downgradeToVersion9(dir);
			rollback0009(dir);
			const db = new Database(dbPath);
			try {
				db.exec(`
					DROP TABLE host_item_use;
					DROP TABLE host_operation_horizon;
					ALTER TABLE host_source DROP COLUMN provenance;
					UPDATE host_schema SET version=2;
				`);
			} finally {
				db.close();
			}
		}
		owner = await startStandalone(dir);
	};
	const items = async () => (await context())["agendaItems"] as AgendaItem[];
	return { dir, profile, call, context, source, apply, restart, items };
}

const month = {
	original: "来月",
	scheduledFor: "2026-12",
	deadline: null,
	validUntil: null,
};
function proposal(
	action: unknown,
	relation = "new",
	relatedItemIds: string[] = [],
) {
	return {
		decision: { actions: [action], clarification: null },
		relations: [{ actionIndex: 0, relation, relatedItemIds }],
		groups: [[0]],
	};
}
const remember = (
	quote: string,
	overrides: Partial<AgendaItem> = {},
	replacesItemId: string | null = null,
) => ({
	type: "remember_agenda",
	kind: "plan",
	text: quote,
	quote,
	replacesItemId,
	certainty: "tentative",
	time: null,
	trigger: null,
	...overrides,
});
const evidence = (sourceHandle: unknown, quote: string) => [
	{
		actionIndex: 0,
		sourceHandle,
		startByte: 0,
		endByte: Buffer.byteLength(quote),
	},
];
const reply = "京都の朝の天気を調べておきますね";
function commitment(sourceHandle: unknown, quote = reply) {
	return {
		agenda: {
			type: "record_commitment",
			scopeKey: "personal",
			sourceHandle,
			startByte: 0,
			endByte: Buffer.byteLength(reply),
			quote,
			text: reply,
			time: null,
			trigger: null,
		},
	};
}

test("one decision per utterance, with tentative month and atomic replacement", async () => {
	const h = await fixture(true);
	expect(
		(await h.source("緑茶が好き", "text", "legacy"))["source"],
	).toMatchObject({ id: "legacy" });
	const hakone = "来月、箱根に一泊で温泉旅行に行こうと思ってる";
	const atami = "箱根はやめて熱海にした";
	const maybe = "近所の美術館にも行こうかな";
	let calls = 0;
	async function plan(
		quote: string,
		choose: (input: { agendaItems: AgendaItem[] }) => unknown,
	) {
		const src = await h.source(quote);
		const complete: Complete = async (prompt, schema, task) => {
			calls++;
			expect(task).toBe("decide");
			expect(JSON.stringify(schema)).toContain("remember_agenda");
			const input = JSON.parse(prompt);
			expect(input.message).toStartWith("今: 2026-11-10T09:00:00+09:00");
			expect(input.source).toBe(quote);
			return {
				raw: JSON.stringify({
					proposal: choose(input),
					evidence: [{ actionIndex: 0, occurrence: 0 }],
				}),
				threadId: null,
				usage: null,
			};
		};
		return natural(
			h.profile,
			"plan",
			{
				scopeKey: "personal",
				message: `今: 2026-11-10T09:00:00+09:00\n利用者の発言: ${quote}`,
				sourceHandle: src["sourceHandle"],
			},
			complete,
		);
	}
	expect(
		await h.apply(
			await plan(hakone, () => proposal(remember(hakone, { time: month }))),
		),
	).toMatchObject({ status: "completed", groups: ["applied"] });
	const [old] = await h.items();
	expect(old).toMatchObject({
		kind: "plan",
		sourceRole: "user",
		certainty: "tentative",
		time: month,
		quote: hakone,
		status: "pending",
	});
	expect(
		await h.apply(
			await plan(atami, (input) => {
				expect(input.agendaItems[0]?.itemId).toBe(old!.itemId);
				return proposal(
					remember(
						atami,
						{
							text: "熱海に一泊で温泉旅行に行くことにした",
							certainty: "confirmed",
						},
						old!.itemId,
					),
					"supersedes",
					[old!.itemId],
				);
			}),
		),
	).toMatchObject({ status: "completed", groups: ["applied"] });
	expect(
		await h.apply(await plan(maybe, () => proposal(remember(maybe)))),
	).toMatchObject({ status: "completed", groups: ["applied"] });
	expect(calls).toBe(3);
	expect(await h.items()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ itemId: old!.itemId, status: "cancelled" }),
			expect.objectContaining({
				status: "pending",
				quote: atami,
				certainty: "confirmed",
			}),
			expect.objectContaining({
				status: "pending",
				quote: maybe,
				certainty: "tentative",
			}),
		]),
	);
	expect((await h.context())["items"]).toEqual([]);
});

test("agent replies are range-checked, cannot prove user facts, and support idempotent status changes", async () => {
	const h = await fixture();
	const src = await h.source(reply, "agent_reply");
	const handle = src["sourceHandle"];
	const bad = await h.call("apply", commitment(handle, "天気を調べます"));
	expect(bad).toMatchObject({ code: "QUOTE_MISMATCH" });
	const context = await h.context();
	const fact = {
		type: "remember",
		subject: "self",
		kind: "personal_fact",
		semanticKey: "weather",
		value: { text: reply, polarity: "affirmed" },
		quote: reply,
		replacesItemId: null,
	};
	for (const action of [fact, remember(reply)]) {
		expect(
			await h.call("plan", {
				scopeKey: "personal",
				snapshotId: context["snapshotId"],
				proposal: proposal(action),
				evidence: evidence(handle, reply),
			}),
		).toMatchObject({ code: "SOURCE_ROLE_MISMATCH" });
	}
	const user = await h.source(reply);
	expect(await h.call("apply", commitment(user["sourceHandle"]))).toMatchObject(
		{ code: "SOURCE_ROLE_MISMATCH" },
	);
	const saved = await h.call("apply", commitment(handle));
	expect(saved.status).toBe("completed");
	expect(typeof saved["itemId"]).toBe("string");
	expect(await h.call("apply", commitment(handle))).toEqual(saved);
	expect((await h.context())["items"]).toEqual([]);
	expect((await h.context("work"))["agendaItems"]).toEqual([]);
	const [item] = await h.items();
	expect(item).toMatchObject({
		kind: "commitment",
		sourceRole: "agent",
		quote: reply,
		status: "pending",
	});
	const done = {
		type: "set_agenda_status",
		itemId: saved["itemId"],
		status: "done",
		scopeKey: "personal",
	};
	expect(
		await h.call("apply", { agenda: { ...done, scopeKey: "work" } }),
	).toMatchObject({ code: "ITEM_NOT_AVAILABLE" });
	expect(await h.call("apply", { agenda: done })).toEqual(saved);
	const after = (await h.items())[0]!;
	expect(after.status).toBe("done");
	expect(after.updatedAtMs).toBeGreaterThanOrEqual(item!.updatedAtMs);
	expect(await h.call("apply", { agenda: done })).toEqual(saved);
	expect(await h.call("apply", commitment(handle))).toEqual(saved);
	expect(await h.items()).toEqual([after]);
	expect(
		await h.call("apply", { agenda: { ...done, status: "cancelled" } }),
	).toMatchObject({ code: "AGENDA_STATUS_CONFLICT" });
});

test("pending items survive reopening and forgetting either source survives backup restore", async () => {
	const h = await fixture();
	const quote = "来月、箱根に一泊で温泉旅行に行こうと思ってる";
	const src = await h.source(quote);
	const agent = await h.source(reply, "agent_reply");
	const initial = await h.context();
	const requestPlan = await h.call("plan", {
		scopeKey: "personal",
		snapshotId: initial["snapshotId"],
		proposal: proposal(remember(quote, { time: month })),
		evidence: evidence(src["sourceHandle"], quote),
	});
	expect(await h.apply(requestPlan)).toMatchObject({ status: "completed" });
	expect(
		await h.call("apply", commitment(agent["sourceHandle"])),
	).toMatchObject({ status: "completed" });
	const before = await h.items();
	expect(before).toHaveLength(2);
	await h.restart("backup");
	expect(await h.items()).toEqual(before);
	for (const item of before) {
		const context = await h.context();
		const read = await h.call("read", {
			snapshotId: context["snapshotId"],
			itemId: item.itemId,
		});
		expect(read).toMatchObject({
			status: "found",
			item,
			sources: [{ quote: { text: item.quote } }],
		});
		const sources = read["sources"] as { sourceHandle: string }[];
		const plan = await h.call("plan", {
			scopeKey: "personal",
			snapshotId: context["snapshotId"],
			proposal: {
				decision: { actions: [], clarification: null },
				relations: [],
				groups: [],
			},
			sourceHandles: [sources[0]!.sourceHandle],
		});
		expect(await h.apply(plan)).toMatchObject({ status: "completed" });
		expect((await h.items()).some((a) => a.itemId === item.itemId)).toBe(false);
	}
	await h.restart("restore");
	expect(await h.items()).toEqual([]);
});

test("existing agenda v2 and State v8 upgrade together without losing data", async () => {
	const h = await fixture();
	const src = await h.source(reply, "agent_reply");
	const saved = await h.call("apply", commitment(src["sourceHandle"]));
	expect(saved.status).toBe("completed");
	const before = await h.items();
	expect(before).toHaveLength(1);

	const text = "京都の抹茶が好きです";
	const fact = await h.source(text);
	const context = await h.context();
	const plan = await h.call("plan", {
		scopeKey: "personal",
		snapshotId: context["snapshotId"],
		proposal: proposal({
			type: "remember",
			kind: "preference",
			subject: "self",
			semanticKey: "matcha",
			quote: text,
			replacesItemId: null,
			value: { text, polarity: "affirmed" },
		}),
		evidence: evidence(fact["sourceHandle"], text),
	});
	expect(await h.apply(plan)).toMatchObject({ status: "completed" });
	await h.restart("legacy-agenda");
	expect(await h.items()).toEqual(before);
	const result = await h.call("search", {
		query: "京都",
		scopeKeys: ["personal"],
	});
	expect(result).toMatchObject({
		status: "found",
		returned: 1,
		items: [{ value: { text } }],
	});
	await h.restart();
	expect(await h.items()).toEqual(before);
});

test("agenda item erasure prevents replay of a commitment without deleting the reply", async () => {
	const h = await fixture();
	const src = await h.source(reply, "agent_reply");
	const input = commitment(src["sourceHandle"]);
	const saved = await h.call("apply", input);
	const id = saved["itemId"] as string;
	const context = await h.context();
	const plan = await h.call("plan", {
		scopeKey: "personal",
		snapshotId: context["snapshotId"],
		proposal: proposal({ type: "forget", itemId: id }, "forget", [id]),
	});
	expect(await h.apply(plan)).toMatchObject({ status: "completed" });
	expect(await h.items()).toEqual([]);
	expect(
		await h.call("read", { sourceHandle: src["sourceHandle"] }),
	).toMatchObject({ status: "found" });
	expect(await h.call("apply", input)).toMatchObject({
		code: "AGENDA_DEPENDENCY_REJECTED",
	});
	expect(await h.items()).toEqual([]);
});

test("agenda validates time structure and binds a conversational cancellation to a user quote", async () => {
	const h = await fixture();
	const quote = "次に京都の話になったら、紅葉の名所を教えて";
	const src = await h.source(quote);
	const view = await h.context();
	const trigger = {
		type: "event",
		condition: "次に京都の話になったとき",
	} as const;
	const plan = (action: unknown) =>
		h.call("plan", {
			scopeKey: "personal",
			snapshotId: view["snapshotId"],
			proposal: proposal(action),
			evidence: evidence(src["sourceHandle"], quote),
		});
	expect(
		await plan(
			remember(quote, { time: { ...month, scheduledFor: "2026-13" } }),
		),
	).toMatchObject({ code: "INVALID_PROPOSAL" });
	expect(
		await h.apply(
			await plan(remember(quote, { kind: "conditional_request", trigger })),
		),
	).toMatchObject({ status: "completed" });
	const [item] = await h.items();
	expect(item?.trigger).toEqual(trigger);
	const latest = await h.context();
	const cancellation = "京都の紅葉の話はもういいよ";
	const end = await h.source(cancellation);
	expect(
		await h.apply(
			await h.call("plan", {
				scopeKey: "personal",
				snapshotId: latest["snapshotId"],
				proposal: proposal(
					{
						type: "set_agenda_status",
						itemId: item!.itemId,
						quote: cancellation,
						status: "cancelled",
					},
					"supersedes",
					[item!.itemId],
				),
				evidence: evidence(end["sourceHandle"], cancellation),
			}),
		),
	).toMatchObject({ status: "completed" });
	expect((await h.items())[0]).toMatchObject({
		itemId: item!.itemId,
		status: "cancelled",
	});
});
