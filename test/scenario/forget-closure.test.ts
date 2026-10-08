/**
 * 忘却の閉包シナリオ（S6）: FG2 / FG3 / FG4 / FG5 / FG9 と state_item の forget、変更フィード、辺の不変条件。
 * 使い捨ての実 SQLite。抽出は決定的な stub ExtractorPort（意味精度は主張しない）で prepare → settle を通す。
 * 公開面（"eumenes-memory" / "eumenes-memory/sqlite"）の関数と、テスト用 Writer だけを使う。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	composeSnapshotV2,
	buildMemoryViewV2,
	validateMemoryViewV2,
} from "eumenes-memory";
import type {
	ExtractionInput,
	MemoryViewV2,
	ReadyMemoryViewV2,
	SnapshotV2,
	SourceState,
} from "eumenes-memory";
import {
	applyForget,
	getForgetReceipt,
	listCandidates,
	listMemoryChanges,
	listState,
	planForget,
	prepareExtraction,
	readMemorySnapshotPart,
	recordExternalDeletion,
	registerExternalDependents,
	settleExtraction,
} from "eumenes-memory/sqlite";
import type { ForgetJournalEntry, ForgetReceipt } from "eumenes-memory/sqlite";
import { ruleExtractor } from "../runners/extraction-stubs.ts";
import {
	accessFor,
	dumpTables,
	forgetRecord,
	reconcile,
	tablesContain,
} from "../runners/records-support.ts";
import { closureViolations, messageKey } from "../runners/forget-support.ts";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";

const SCOPE = "scope:a";
const ACCESS = accessFor();
const AUTO = {
	preference: "auto_admit",
	personal_fact: "auto_admit",
	constraint: "auto_admit",
	habit: "auto_admit",
	other_person_note: "user_confirm",
} as const;
const PROFILE = {
	extractorId: "stub-rule",
	promptVersion: "stub-1",
	providerRef: "stub-provider",
};

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function open(): TestStore {
	const store = openTestStore();
	stores.push(store);
	return store;
}

interface Message {
	readonly id: string;
	readonly content: string;
	readonly ordinal: number;
}
const M1: Message = { id: "m1", content: "私はコーヒーが好き。", ordinal: 1 };
const M2: Message = { id: "m2", content: "私は紅茶が好き。", ordinal: 2 };
const M3: Message = { id: "m3", content: "今日は天気がいい。", ordinal: 3 };
const M4: Message = { id: "m4", content: "私は水が好き。", ordinal: 4 };

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
function stateOf(message: Message, status = "available") {
	const digest = sha256(message.content);
	return {
		namespace: "conversation",
		kind: "message",
		id: message.id,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: ACCESS.principal,
		scopeKey: SCOPE,
		status,
		content: message.content,
	};
}
function sourceOf(message: Message) {
	return { ...stateOf(message), ordinal: message.ordinal, role: "user" };
}

function prepare(
	store: TestStore,
	jobId: string,
	messages: readonly Message[],
	enabled = true,
) {
	return store.write((db) =>
		prepareExtraction(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: 10 },
			run: { jobId, attempt: 1 },
			enabled,
			sources: messages.map(sourceOf) as never,
			profile: PROFILE,
			maxInputBytes: 65536,
		}),
	);
}

function readyInput(result: ReturnType<typeof prepare>): ExtractionInput {
	if (result.status !== "ready") throw new Error(JSON.stringify(result));
	return result.input;
}

async function settleJob(
	store: TestStore,
	jobId: string,
	input: ExtractionInput,
	messages: readonly Message[],
	statuses: Readonly<Record<string, string>> = {},
) {
	const output = await ruleExtractor()(input, new AbortController().signal);
	return store.write((db) =>
		settleExtraction(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: 20 },
			run: { jobId, attempt: 1 },
			output,
			currentSources: messages.map((m) =>
				stateOf(m, statuses[m.id] ?? "available"),
			) as never,
			policy: AUTO,
		}),
	);
}

interface Scene {
	readonly store: TestStore;
	readonly itemId: ReadonlyMap<string, string>;
	readonly before: string;
}

/** A = (m1 コーヒー, m2 紅茶, m3 無関係) の 1 run、B = (m4 水) の独立した 1 run。両方 prepare してから settle する。 */
async function scene(): Promise<Scene> {
	const store = open();
	const inputA = readyInput(prepare(store, "A", [M1, M2, M3]));
	const inputB = readyInput(prepare(store, "B", [M4]));
	expect(await settleJob(store, "A", inputA, [M1, M2, M3])).toMatchObject({
		status: "applied",
		admitted: 2,
	});
	expect(await settleJob(store, "B", inputB, [M4])).toMatchObject({
		status: "applied",
		admitted: 1,
	});
	const itemId = new Map<string, string>();
	for (const row of store.writer
		.query("SELECT item_id, semantic_key FROM memory_state_item")
		.all() as { item_id: string; semantic_key: string }[]) {
		itemId.set(row.semantic_key.replace("topic.", ""), row.item_id);
	}
	expect([...itemId.keys()].sort()).toEqual(["コーヒー", "水", "紅茶"].sort());
	return { store, itemId, before: store.snapshotTo("before-forget") };
}

function register(
	store: TestStore,
	providerRef: string,
	externalId: string,
	dependsOn: readonly { type: "source" | "state_item"; id: string }[],
) {
	return store.write((db) =>
		registerExternalDependents(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: 15 },
			dependents: [{ providerRef, externalId, dependsOn }],
		}),
	);
}

function activeItems(store: TestStore): string[] {
	const result = store.read((db) =>
		listState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			includeInactive: true,
		}),
	);
	if (result.status !== "ok") throw new Error("listState");
	return result.items.map((item) => item.semanticKey.replace("topic.", ""));
}

function receiptOf(store: TestStore, forgetId: string): ForgetReceipt {
	const got = store.read((db) =>
		getForgetReceipt(db, { contractVersion: 1, access: ACCESS, forgetId }),
	);
	if (got.status !== "found") throw new Error("receipt");
	return got.receipt;
}

function idOf(ids: ReadonlyMap<string, string>, word: string): string {
	const id = ids.get(word);
	if (id === undefined) throw new Error(`no item for ${word}`);
	return id;
}

function count(store: TestStore, sql: string, ...params: string[]): number {
	return (store.writer.query(sql).get(...params) as { n: number }).n;
}

describe("FG2: forgetting a host source reaches candidates, state items, the run and external derivatives", () => {
	test("cited input (m1): the whole run closes over; the independent run, its item and its external derivative are untouched", async () => {
		const { store, itemId, before } = await scene();
		expect(
			register(store, "world", "n1", [
				{ type: "state_item", id: idOf(itemId, "コーヒー") },
			]),
		).toMatchObject({ status: "registered" });
		expect(
			register(store, "world", "n2", [
				{ type: "state_item", id: idOf(itemId, "水") },
			]),
		).toMatchObject({ status: "registered" });
		const preSnapshot = store.snapshotTo("with-externals");
		const untouchedBefore = JSON.stringify(
			store.writer
				.query(
					"SELECT * FROM memory_state_item WHERE item_id = ? UNION ALL SELECT * FROM memory_state_item WHERE 0",
				)
				.all(idOf(itemId, "水")),
		);
		expect(tablesContain(store, "コーヒー")).toBe(true);

		const { plan, entry, receipt } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		expect(plan.closure.counts).toEqual({
			record: 0,
			state_item: 2,
			candidate: 2,
			extraction_run: 1,
			external: 1,
		});
		expect(plan.externalProviders).toEqual(["stub-provider"]);
		expect(plan.externalDependents).toEqual([
			{ providerRef: "world", externalId: "n1" },
		]);
		expect(receipt).toMatchObject({
			local: "applied",
			external: "pending",
			completed: false,
			externalDeletions: [
				{ providerRef: "stub-provider", externalId: null, state: "pending" },
				{ providerRef: "world", externalId: "n1", state: "pending" },
			],
		});

		// 値が表のどこにも残らない。独立した run の値は残る。
		for (const word of ["コーヒー", "紅茶"]) {
			expect(tablesContain(store, word)).toBe(false);
		}
		expect(tablesContain(store, "水")).toBe(true);
		expect(activeItems(store)).toEqual(["水"]);
		// 行の規約: state_item / candidate / run
		expect(
			store.writer
				.query(
					`SELECT status, semantic_key, value_text, polarity, valid_from_ms FROM memory_state_item
					WHERE item_id IN (?, ?) ORDER BY item_id`,
				)
				.all(...[idOf(itemId, "コーヒー"), idOf(itemId, "紅茶")].sort()),
		).toEqual([
			{
				status: "forgotten",
				semantic_key: "",
				value_text: null,
				polarity: null,
				valid_from_ms: null,
			},
			{
				status: "forgotten",
				semantic_key: "",
				value_text: null,
				polarity: null,
				valid_from_ms: null,
			},
		]);
		expect(
			count(
				store,
				"SELECT COUNT(*) AS n FROM memory_state_attribute WHERE item_id IN (SELECT item_id FROM memory_state_item WHERE status = 'forgotten')",
			),
		).toBe(0);
		expect(
			count(
				store,
				"SELECT COUNT(*) AS n FROM memory_state_evidence WHERE item_id IN (SELECT item_id FROM memory_state_item WHERE status = 'forgotten')",
			),
		).toBe(0);
		expect(
			store.writer
				.query(
					`SELECT action, from_revision, to_revision, cause_id, at_ms FROM memory_state_event
					WHERE item_id = ? ORDER BY event_seq`,
				)
				.all(idOf(itemId, "コーヒー")),
		).toEqual([
			{
				action: "assert",
				from_revision: null,
				to_revision: null,
				cause_id: "",
				at_ms: 0,
			},
			{
				action: "forget",
				from_revision: null,
				to_revision: null,
				cause_id: "",
				at_ms: 0,
			},
		]);
		expect(
			store.writer
				.query(
					"SELECT decision, value_text, polarity, semantic_key FROM memory_candidate WHERE run_id = 'A:1'",
				)
				.all(),
		).toEqual([
			{
				decision: "forgotten",
				value_text: null,
				polarity: null,
				semantic_key: "",
			},
			{
				decision: "forgotten",
				value_text: null,
				polarity: null,
				semantic_key: "",
			},
		]);
		expect(
			count(
				store,
				"SELECT COUNT(*) AS n FROM memory_candidate_evidence WHERE candidate_id IN (SELECT candidate_id FROM memory_candidate WHERE run_id = 'A:1')",
			),
		).toBe(0);
		expect(
			store.writer
				.query(
					"SELECT stage, provider_ref, input_digest, output_digest FROM memory_extraction_run WHERE run_id = 'A:1'",
				)
				.get(),
		).toEqual({
			stage: "settled",
			provider_ref: "",
			input_digest: "",
			output_digest: null,
		});
		expect(
			count(
				store,
				"SELECT COUNT(*) AS n FROM memory_extraction_input WHERE run_id = 'A:1'",
			),
		).toBe(0);
		// 進捗行: A が処理済みにした m1〜m3 はどれも消え、独立した B の進捗 m4 は残る。
		expect(
			store.writer.query("SELECT source_key FROM memory_source_progress").all(),
		).toEqual([{ source_key: messageKey("m4") }]);
		// 墓標
		const tombstones = store.writer
			.query(
				"SELECT target_type, COUNT(*) AS n FROM memory_tombstone GROUP BY target_type ORDER BY target_type",
			)
			.all();
		expect(tombstones).toEqual([
			{ target_type: "candidate", n: 2 },
			{ target_type: "external", n: 1 },
			{ target_type: "extraction_run", n: 1 },
			{ target_type: "source", n: 1 },
			{ target_type: "state_item", n: 2 },
		]);
		// 独立した行は一切変わらない
		expect(
			JSON.stringify(
				store.writer
					.query(
						"SELECT * FROM memory_state_item WHERE item_id = ? UNION ALL SELECT * FROM memory_state_item WHERE 0",
					)
					.all(idOf(itemId, "水")),
			),
		).toBe(untouchedBefore);
		expect(closureViolations(store)).toEqual([]);

		// 変更フィード: source と state_item の forgotten が ID だけで出る（本文なし）
		const feed = store.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 100,
			}),
		);
		if (feed.status !== "ok") throw new Error("feed");
		const forgotten = feed.changes.filter((c) => c.status === "forgotten");
		expect(
			forgotten.map((c) => [c.targetType, c.forgetId, c.revision]).sort(),
		).toEqual(
			[
				["source", plan.entry.forgetId, null],
				["state_item", plan.entry.forgetId, null],
				["state_item", plan.entry.forgetId, null],
			].sort(),
		);
		expect(forgotten.find((c) => c.targetType === "source")?.targetId).toBe(
			messageKey("m1"),
		);
		expect(JSON.stringify(feed)).not.toContain("コーヒー");

		// 再抽出は拒否（FG8 の host_source 版）。
		expect(prepare(store, "C", [M1])).toEqual({
			status: "skip",
			reasonCode: "SOURCE_TOMBSTONED",
		});
		// 削除確認: プロバイダー + 外部派生物の両方が confirmed になって初めて completed。
		const confirm = (providerRef: string, externalId?: string) =>
			store.write((db) =>
				recordExternalDeletion(db, {
					contractVersion: 1,
					access: ACCESS,
					clock: { atMs: 40 },
					forgetId: entry.forgetId,
					providerRef,
					...(externalId === undefined ? {} : { externalId }),
					state: "confirmed",
				}),
			);
		const afterProvider = confirm("stub-provider");
		expect(afterProvider).toMatchObject({
			status: "recorded",
			receipt: { external: "pending", completed: false },
		});
		expect(confirm("world", "n1")).toMatchObject({
			status: "recorded",
			receipt: { external: "confirmed", completed: true },
		});
		expect(receiptOf(store, entry.forgetId).completed).toBe(true);

		// 復元: 忘却（と登録）の前に複製した DB + 最新ジャーナルで、値は戻らず外部削除は pending に戻る。
		const restoredWithExternals = openTestStore({ fromFile: preSnapshot });
		stores.push(restoredWithExternals);
		expect(reconcile(restoredWithExternals, [entry])).toEqual({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		for (const word of ["コーヒー", "紅茶"]) {
			expect(tablesContain(restoredWithExternals, word)).toBe(false);
		}
		expect(activeItems(restoredWithExternals)).toEqual(["水"]);
		expect(receiptOf(restoredWithExternals, entry.forgetId)).toMatchObject({
			external: "pending",
			completed: false,
		});
		const restoredDump = dumpTables(restoredWithExternals);
		expect(reconcile(restoredWithExternals, [entry])).toEqual({
			status: "ok",
			reapplied: 0,
		});
		expect(dumpTables(restoredWithExternals)).toBe(restoredDump);

		const restoredOld = openTestStore({ fromFile: before });
		stores.push(restoredOld);
		reconcile(restoredOld, [entry]);
		expect(closureViolations(restoredOld)).toEqual([]);
		expect(tablesContain(restoredOld, "コーヒー")).toBe(false);
		expect(activeItems(restoredOld)).toEqual(["水"]);
	});

	test("view v2: a view built before the forget is invalid afterwards, and the rebuilt view has no trace of the forgotten items", async () => {
		const { store } = await scene();
		const snapshotOf = (): SnapshotV2 =>
			store.read((db) => {
				const part = readMemorySnapshotPart(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
				});
				if (part.status !== "ok") throw new Error("part");
				return composeSnapshotV2({
					principal: ACCESS.principal,
					scopeKey: SCOPE,
					policyRevision: ACCESS.policyRevision,
					complete: true,
					memory: part,
					// ホストの会話 message の現在状態（m1 は忘却済みならホストが forgotten と言う）
					evidenceSources: [M1, M2, M3, M4].map((message) => {
						const forgotten =
							count(
								store,
								"SELECT COUNT(*) AS n FROM memory_tombstone WHERE target_type = 'source' AND target_id = ?",
								messageKey(message.id),
							) > 0;
						const state = stateOf(
							message,
							forgotten ? "forgotten" : "available",
						);
						return state as SourceState;
					}),
				});
			});
		const input = (snapshot: SnapshotV2) => ({
			schemaVersion: 2 as const,
			access: ACCESS,
			snapshot,
			maxBytes: 100_000,
			enabled: true,
		});
		const first = snapshotOf();
		const view = buildMemoryViewV2(input(first));
		if (view.status !== "ready") throw new Error(JSON.stringify(view));
		const ready: ReadyMemoryViewV2 = view;
		expect(ready.items.map((item) => item.text).sort()).toEqual(
			["コーヒー", "水", "紅茶"].sort(),
		);
		expect(
			validateMemoryViewV2(ready as MemoryViewV2, {
				schemaVersion: 2,
				access: ACCESS,
				snapshot: first,
			}),
		).toMatchObject({ status: "valid" });

		forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		const after = snapshotOf();
		expect(
			validateMemoryViewV2(ready as MemoryViewV2, {
				schemaVersion: 2,
				access: ACCESS,
				snapshot: after,
			}),
		).toMatchObject({
			status: "invalid",
			reasonCode: "STATE_REVISION_MISMATCH",
		});
		// revision を据え置いても invalid（忘却された item は snapshot にない）
		expect(
			validateMemoryViewV2(ready as MemoryViewV2, {
				schemaVersion: 2,
				access: ACCESS,
				snapshot: { ...after, stateRevision: first.stateRevision },
			}),
		).toMatchObject({ status: "invalid" });
		const rebuilt = buildMemoryViewV2(input(after));
		expect(JSON.stringify(rebuilt)).not.toContain("コーヒー");
		expect(JSON.stringify(rebuilt)).not.toContain("紅茶");
		expect(JSON.stringify(rebuilt)).toContain("水");
	});
});

describe("FG3: a source the run read but no candidate cited still closes the whole run", () => {
	test("forgetting m3 (cited by nothing) forgets A's candidates and admitted items; B stays", async () => {
		const { store } = await scene();
		// m3 を引用した候補はない。
		expect(
			count(
				store,
				"SELECT COUNT(*) AS n FROM memory_candidate_evidence WHERE source_id = 'm3'",
			),
		).toBe(0);
		expect(
			count(
				store,
				"SELECT COUNT(*) AS n FROM memory_extraction_input WHERE source_id = 'm3'",
			),
		).toBe(1);
		const { plan } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m3"),
			scopeKey: SCOPE,
		});
		expect(plan.closure.counts).toMatchObject({
			state_item: 2,
			candidate: 2,
			extraction_run: 1,
		});
		expect(activeItems(store)).toEqual(["水"]);
		expect(tablesContain(store, "コーヒー")).toBe(false);
		expect(tablesContain(store, "紅茶")).toBe(false);
		expect(
			store.writer
				.query(
					"SELECT run_id, stage FROM memory_extraction_run ORDER BY run_id",
				)
				.all(),
		).toEqual([
			{ run_id: "A:1", stage: "settled" },
			{ run_id: "B:1", stage: "settled" },
		]);
		expect(
			count(
				store,
				"SELECT COUNT(*) AS n FROM memory_tombstone WHERE target_type = 'source'",
			),
		).toBe(1);
		// m1 / m2 はそれ自体は忘れていない。A の進捗は消えるので、新しい run で抽出し直せる。
		const again = prepare(store, "A2", [M1, M2]);
		expect(again.status).toBe("ready");
	});
});

describe("FG4: Memory OFF does not stop forgetting", () => {
	test("prepare with enabled=false is skipped, while plan / apply / reconcile still work", async () => {
		const { store, before } = await scene();
		expect(prepare(store, "OFF", [M1], false)).toEqual({
			status: "skip",
			reasonCode: "MEMORY_DISABLED",
		});
		const { entry } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		expect(activeItems(store)).toEqual(["水"]);
		// 抽出は OFF のままでも reconcile（復元）が効く。
		const restored = openTestStore({ fromFile: before });
		stores.push(restored);
		expect(reconcile(restored, [entry])).toEqual({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		expect(activeItems(restored)).toEqual(["水"]);
		expect(prepare(restored, "OFF2", [M4], false)).toEqual({
			status: "skip",
			reasonCode: "MEMORY_DISABLED",
		});
	});
});

describe("FG5: external deletion is never reported complete until confirmed", () => {
	async function forgotten() {
		const { store, itemId } = await scene();
		register(store, "world", "n1", [
			{ type: "state_item", id: idOf(itemId, "コーヒー") },
		]);
		register(store, "world", "n2", [{ type: "source", id: messageKey("m1") }]);
		const { entry } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		return { store, entry };
	}
	function record(
		store: TestStore,
		entry: ForgetJournalEntry,
		providerRef: string,
		state: "confirmed" | "unverified" | "failed",
		externalId?: string,
	) {
		return store.write((db) =>
			recordExternalDeletion(db, {
				contractVersion: 1,
				access: ACCESS,
				clock: { atMs: 50 },
				forgetId: entry.forgetId,
				providerRef,
				...(externalId === undefined ? {} : { externalId }),
				state,
			}),
		);
	}

	test("three pending deletions (provider + two derivatives): aggregation is failed > pending > unverified > confirmed; only all-confirmed completes", async () => {
		const { store, entry } = await forgotten();
		expect(receiptOf(store, entry.forgetId)).toMatchObject({
			external: "pending",
			completed: false,
		});
		const states = (r: unknown) =>
			(r as { receipt: ForgetReceipt }).receipt.externalDeletions.map(
				(d) => `${d.providerRef}/${d.externalId}/${d.state}`,
			);
		// failed は pending が残っていても最優先。
		expect(record(store, entry, "stub-provider", "failed")).toMatchObject({
			receipt: { external: "failed", completed: false },
		});
		expect(states(record(store, entry, "stub-provider", "unverified"))).toEqual(
			["stub-provider/null/unverified", "world/n1/pending", "world/n2/pending"],
		);
		expect(record(store, entry, "world", "unverified", "n1")).toMatchObject({
			receipt: { external: "pending", completed: false },
		});
		// 最後の 1 件が unverified になると、pending が消えて unverified に集約（完了ではない）。
		expect(record(store, entry, "world", "unverified", "n2")).toMatchObject({
			receipt: { external: "unverified", completed: false },
		});
		// failed は最優先。
		expect(record(store, entry, "world", "failed", "n1")).toMatchObject({
			receipt: { external: "failed", completed: false },
		});
		// 外部派生物の全行を providerRef だけで更新（externalId 省略）。
		expect(record(store, entry, "world", "confirmed")).toMatchObject({
			receipt: { external: "unverified", completed: false },
		});
		expect(record(store, entry, "stub-provider", "confirmed")).toMatchObject({
			receipt: { external: "confirmed", completed: true },
		});
		// 最後に記録した状態が有効（確認済みの後の失敗報告は completed を取り消す）。
		expect(record(store, entry, "world", "failed", "n2")).toMatchObject({
			receipt: { external: "failed", completed: false },
		});
		expect(
			store.writer
				.query("SELECT external_state FROM memory_forget WHERE forget_id = ?")
				.get(entry.forgetId),
		).toEqual({ external_state: "failed" });
	});

	test("unknown provider / unknown forget / another principal / unpermitted scope", async () => {
		const { store, entry } = await forgotten();
		expect(record(store, entry, "nobody", "confirmed")).toEqual({
			status: "unknown_provider",
		});
		expect(record(store, entry, "world", "confirmed", "n9")).toEqual({
			status: "unknown_provider",
		});
		const missing = store.write((db) =>
			recordExternalDeletion(db, {
				contractVersion: 1,
				access: ACCESS,
				clock: { atMs: 50 },
				forgetId: "forget:none",
				providerRef: "world",
				state: "confirmed",
			}),
		);
		expect(missing).toEqual({ status: "missing" });
		const other = store.write((db) =>
			recordExternalDeletion(db, {
				contractVersion: 1,
				access: accessFor([SCOPE], "local:other"),
				clock: { atMs: 50 },
				forgetId: entry.forgetId,
				providerRef: "world",
				state: "confirmed",
			}),
		);
		expect(other).toEqual({ status: "missing" });
		const narrow = store.write((db) =>
			recordExternalDeletion(db, {
				contractVersion: 1,
				access: accessFor(["scope:other"]),
				clock: { atMs: 50 },
				forgetId: entry.forgetId,
				providerRef: "world",
				state: "confirmed",
			}),
		);
		expect(narrow).toEqual({ status: "not_permitted" });
		// 何も変わっていない
		expect(receiptOf(store, entry.forgetId)).toMatchObject({
			external: "pending",
			completed: false,
		});
		// pending への「戻し」は契約違反（入力 parse が拒否）。
		expect(() =>
			store.write((db) =>
				recordExternalDeletion(db, {
					contractVersion: 1,
					access: ACCESS,
					clock: { atMs: 50 },
					forgetId: entry.forgetId,
					providerRef: "world",
					state: "pending",
				} as never),
			),
		).toThrow();
	});

	test("a forget with no provider and no external derivative is complete immediately; a Records provider is pending until confirmed", () => {
		const store = open();
		const { receipt } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("nothing-here"),
			scopeKey: SCOPE,
		});
		expect(receipt).toMatchObject({ external: "none", completed: true });
	});
});

describe("FG9: a source forgotten between prepare and settle", () => {
	test("settle returns stale SOURCE_TOMBSTONED even if the host still says 'available'; nothing is written", async () => {
		const store = open();
		const input = readyInput(prepare(store, "J", [M1, M2]));
		const { plan } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m2"),
			scopeKey: SCOPE,
		});
		expect(plan.closure.counts).toMatchObject({
			extraction_run: 1,
			candidate: 0,
		});
		// run は prepared のまま忘れられるが、stale で閉じる（settled にはならない）。
		expect(
			store.writer
				.query(
					"SELECT stage, outcome_code, provider_ref FROM memory_extraction_run WHERE run_id = 'J:1'",
				)
				.get(),
		).toEqual({
			stage: "stale",
			outcome_code: "SOURCE_TOMBSTONED",
			provider_ref: "",
		});
		expect(await settleJob(store, "J", input, [M1, M2])).toEqual({
			status: "stale",
			reasonCode: "SOURCE_TOMBSTONED",
		});
		expect(count(store, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);
		expect(count(store, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(0);
		// プロバイダーに送った可能性があるので、prepared でも外部削除は pending。
		expect(
			store.writer
				.query("SELECT provider_ref, state FROM memory_forget_external")
				.all(),
		).toEqual([{ provider_ref: "stub-provider", state: "pending" }]);
		// 同じ run の再 prepare も拒否。
		expect(prepare(store, "J", [M1])).toEqual({
			status: "skip",
			reasonCode: "SOURCE_TOMBSTONED",
		});
	});

	test("a run that does not read the forgotten source is not affected", async () => {
		const store = open();
		const input = readyInput(prepare(store, "J", [M1]));
		forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m2"),
			scopeKey: SCOPE,
		});
		expect(await settleJob(store, "J", input, [M1])).toMatchObject({
			status: "applied",
			admitted: 1,
		});
	});
});

describe("state_item target", () => {
	test("forgetting an item also forgets the candidate it came from (same value), runs that were shown it, and everything derived", async () => {
		const store = open();
		// 1 回目: m1 → コーヒー。2 回目の run は shown として コーヒー を見る。
		const inputA = readyInput(prepare(store, "A", [M1]));
		await settleJob(store, "A", inputA, [M1]);
		const inputB = readyInput(prepare(store, "B", [M4]));
		expect(inputB.shownState).toHaveLength(1);
		await settleJob(store, "B", inputB, [M4]);
		const coffee = (
			store.writer
				.query(
					"SELECT item_id FROM memory_state_item WHERE semantic_key = 'topic.コーヒー'",
				)
				.get() as { item_id: string }
		).item_id;
		const { plan, receipt } = forgetRecord(store, {
			type: "state_item",
			itemId: coffee,
			scopeKey: SCOPE,
		});
		// item + その元の候補 + shown を見た run B + B の候補と item（水）
		expect(plan.closure.counts).toEqual({
			record: 0,
			state_item: 2,
			candidate: 2,
			extraction_run: 1,
			external: 0,
		});
		expect(receipt.external).toBe("pending");
		expect(tablesContain(store, "コーヒー")).toBe(false);
		expect(tablesContain(store, "水")).toBe(false);
		// run A は忘れない（item より上流）。m1 の進捗は残り、同じ m1 は再抽出されない。
		expect(
			store.writer
				.query(
					"SELECT run_id, stage FROM memory_extraction_run ORDER BY run_id",
				)
				.all(),
		).toEqual([
			{ run_id: "A:1", stage: "settled" },
			{ run_id: "B:1", stage: "settled" },
		]);
		expect(
			store.writer
				.query(
					"SELECT target_type FROM memory_tombstone ORDER BY target_type, target_id",
				)
				.all()
				.map((row) => (row as { target_type: string }).target_type),
		).toEqual([
			"candidate",
			"candidate",
			"extraction_run",
			"state_item",
			"state_item",
		]);
		// B の進捗（m4）は消え、A の進捗（m1）は残る。
		expect(
			store.writer.query("SELECT source_key FROM memory_source_progress").all(),
		).toEqual([{ source_key: messageKey("m1") }]);
		// 他人の/他 scope の item は ID を知っていても指定できない。
		const planOther = store.read((db) =>
			// scope が違う item を指す target
			planForget(db, {
				contractVersion: 1,
				access: accessFor([SCOPE, "scope:b"]),
				target: { type: "state_item", itemId: coffee, scopeKey: "scope:b" },
				clock: { atMs: 1 },
			}),
		);
		expect(planOther).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
	});
});

describe("invariants over a real pipeline", () => {
	test("every candidate, state item and run has at least one dependency edge (no derived row without an edge)", async () => {
		const { store, itemId } = await scene();
		register(store, "world", "n1", [
			{ type: "state_item", id: idOf(itemId, "水") },
		]);
		const orphans = (table: string, idColumn: string, type: string) =>
			count(
				store,
				`SELECT COUNT(*) AS n FROM ${table} t WHERE NOT EXISTS (
					SELECT 1 FROM memory_dependency d WHERE d.dependent_type = '${type}' AND d.dependent_id = t.${idColumn})`,
			);
		expect(orphans("memory_candidate", "candidate_id", "candidate")).toBe(0);
		expect(orphans("memory_state_item", "item_id", "state_item")).toBe(0);
		expect(orphans("memory_extraction_run", "run_id", "extraction_run")).toBe(
			0,
		);
	});

	test("replaying every journal entry directly is a no-op on the data (idempotent apply)", async () => {
		const { store } = await scene();
		const { entry } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m2"),
			scopeKey: SCOPE,
		});
		const dump = dumpTables(store).replace(
			/"memory_scope_state":\[[^\]]*\]/,
			"",
		);
		store.write((db) =>
			applyForget(db, { contractVersion: 1, entry, clock: { atMs: 99 } }),
		);
		expect(
			dumpTables(store).replace(/"memory_scope_state":\[[^\]]*\]/, ""),
		).toBe(dump);
		expect(
			store.read((db) =>
				listCandidates(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
				}),
			),
		).toEqual({ status: "ok", candidates: [] });
	});
});

describe("F03 with host_source / state_item targets: a damaged journal stops Memory and writes nothing", () => {
	test("empty, truncated and tampered journals are inconsistent; the intact journal is accepted and idempotent", async () => {
		const { store, itemId, before } = await scene();
		const first = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		const second = forgetRecord(store, {
			type: "state_item",
			itemId: idOf(itemId, "水"),
			scopeKey: SCOPE,
		});
		const journal = [first.entry, second.entry];
		const dump = dumpTables(store);
		expect(reconcile(store, [])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_MISSING",
		});
		expect(reconcile(store, [first.entry])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_TRUNCATED",
		});
		const tampered = {
			...first.entry,
			targets: [
				{
					type: "host_source" as const,
					id: messageKey("m2"),
					scopeKey: SCOPE,
				},
			],
		};
		expect(reconcile(store, [tampered, second.entry])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		expect(dumpTables(store)).toBe(dump);
		expect(reconcile(store, journal)).toEqual({ status: "ok", reapplied: 0 });
		expect(dumpTables(store)).toBe(dump);

		// 古い DB + 完全なジャーナルは、新しい target 型でも同じ状態になる。
		const restored = openTestStore({ fromFile: before });
		stores.push(restored);
		expect(reconcile(restored, journal)).toEqual({
			status: "ok",
			reapplied: 2,
			feedResyncRequired: true,
		});
		expect(activeItems(restored)).toEqual([]);
		expect(tablesContain(restored, "水")).toBe(false);
		// 古い DB + 空のジャーナルは JOURNAL_MISSING にならない（DB に墓標がないため）。これは本体だけでは
		// 検出できない限界で、ホストの起動手順（ジャーナルの存在確認）に責任がある。
		const stale = openTestStore({ fromFile: before });
		stores.push(stale);
		expect(reconcile(stale, [])).toEqual({ status: "ok", reapplied: 0 });
		expect(activeItems(stale)).toContain("コーヒー");
	});
});
