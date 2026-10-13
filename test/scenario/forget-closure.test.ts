/**
 * 忘却の閉包シナリオ: host_source / state_item の forget、外部削除の確認、ジャーナルの検査、辺の不変条件。
 * 使い捨ての実 SQLite。State は `assertUserState` で作る。
 * 公開面（"eumenes-memory" / "eumenes-memory/sqlite"）の関数と、テスト用 Writer だけを使う。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { HostSourceState } from "eumenes-memory";
import {
	applyForget,
	assertUserState,
	getForgetReceipt,
	listState,
	recordExternalDeletion,
	registerExternalDependents,
} from "eumenes-memory/sqlite";
import type { ForgetJournalEntry, ForgetReceipt } from "eumenes-memory/sqlite";
import {
	accessFor,
	capture,
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
	readonly word: string;
	readonly ordinal: number;
}
const M1: Message = {
	id: "m1",
	content: "私はコーヒーが好き。",
	word: "コーヒー",
	ordinal: 1,
};
const M2: Message = {
	id: "m2",
	content: "私は紅茶が好き。",
	word: "紅茶",
	ordinal: 2,
};
const M3: Message = {
	id: "m3",
	content: "私は水が好き。",
	word: "水",
	ordinal: 3,
};

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
function sourceOf(message: Message): HostSourceState {
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
		status: "available",
		content: message.content,
		ordinal: message.ordinal,
	};
}

/** message の全文を根拠に、ユーザーの明示操作で State を書く。 */
function assertFact(store: TestStore, message: Message): string {
	const source = sourceOf(message);
	const result = store.write((db) =>
		assertUserState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: 10 },
			kind: "preference",
			subject: "self",
			semanticKey: `topic.${message.word}`,
			value: { text: message.word, polarity: "affirmed" },
			evidence: [
				{
					source: {
						namespace: source.namespace,
						kind: source.kind,
						id: source.id,
						representation: "text",
						revision: source.revision,
						digest: source.digest,
						range: {
							startByte: 0,
							endByte: Buffer.byteLength(message.content, "utf8"),
						},
					},
					quote: message.content,
				},
			],
			sources: [source],
			origin: "user_confirmed",
		}),
	);
	if (result.status !== "applied") throw new Error(JSON.stringify(result));
	return result.item.itemId;
}

interface Scene {
	readonly store: TestStore;
	readonly itemId: ReadonlyMap<string, string>;
	readonly before: string;
}

/** m1 コーヒー、m2 紅茶、m3 水 のそれぞれが別の item の根拠。 */
function scene(): Scene {
	const store = open();
	const itemId = new Map<string, string>();
	for (const message of [M1, M2, M3]) {
		itemId.set(message.word, assertFact(store, message));
	}
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

describe("forgetting a host source reaches the state items and external derivatives that cite it", () => {
	test("cited source (m1): its item and derivative close over; the others are untouched", () => {
		const { store, itemId } = scene();
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
		expect(tablesContain(store, "コーヒー")).toBe(true);

		const { plan, receipt } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		expect(plan.closure.counts).toEqual({
			record: 0,
			state_item: 1,
			external: 1,
		});
		expect(plan.externalProviders).toEqual([]);
		expect(plan.externalDependents).toEqual([
			{ providerRef: "world", externalId: "n1" },
		]);
		expect(receipt).toMatchObject({
			local: "applied",
			external: "pending",
			completed: false,
			externalDeletions: [
				{ providerRef: "world", externalId: "n1", state: "pending" },
			],
		});

		expect(tablesContain(store, "コーヒー")).toBe(false);
		expect(tablesContain(store, "紅茶")).toBe(true);
		expect(tablesContain(store, "水")).toBe(true);
		expect(activeItems(store)).toEqual(["水", "紅茶"]);
		expect(
			store.writer
				.query(
					`SELECT status, semantic_key, value_text, polarity, valid_from_ms FROM memory_state_item
					WHERE item_id = ?`,
				)
				.all(idOf(itemId, "コーヒー")),
		).toEqual([
			{
				status: "forgotten",
				semantic_key: "",
				value_text: null,
				polarity: null,
				valid_from_ms: null,
			},
		]);
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
		expect(closureViolations(store)).toEqual([]);
		expect(
			store.writer
				.query(
					"SELECT target_type FROM memory_tombstone ORDER BY target_type, target_id",
				)
				.all(),
		).toEqual([
			{ target_type: "external" },
			{ target_type: "source" },
			{ target_type: "state_item" },
		]);
	});

	test("an item that cites two sources is forgotten through either of them", () => {
		const store = open();
		const first = sourceOf(M1);
		const second = sourceOf(M2);
		const span = (source: HostSourceState, message: Message) => ({
			source: {
				namespace: source.namespace,
				kind: source.kind,
				id: source.id,
				representation: "text",
				revision: source.revision,
				digest: source.digest,
				range: {
					startByte: 0,
					endByte: Buffer.byteLength(message.content, "utf8"),
				},
			},
			quote: message.content,
		});
		store.write((db) =>
			assertUserState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 10 },
				kind: "preference",
				subject: "self",
				semanticKey: "topic.both",
				value: { text: "両方", polarity: "affirmed" },
				evidence: [span(first, M1), span(second, M2)],
				sources: [first, second],
				origin: "user_confirmed",
			}),
		);
		forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m2"),
			scopeKey: SCOPE,
		});
		expect(tablesContain(store, "両方")).toBe(false);
		expect(closureViolations(store)).toEqual([]);
	});
});

describe("state_item target", () => {
	test("forgetting an item forgets what is derived from it and nothing else", () => {
		const { store, itemId } = scene();
		register(store, "world", "n1", [
			{ type: "state_item", id: idOf(itemId, "紅茶") },
		]);
		const { plan } = forgetRecord(store, {
			type: "state_item",
			itemId: idOf(itemId, "紅茶"),
			scopeKey: SCOPE,
		});
		expect(plan.closure.counts).toMatchObject({ state_item: 1, external: 1 });
		expect(tablesContain(store, "紅茶")).toBe(false);
		expect(tablesContain(store, "コーヒー")).toBe(true);
		expect(closureViolations(store)).toEqual([]);
		// 根拠の出典は忘れない。
		expect(
			store.writer
				.query(
					"SELECT COUNT(*) AS n FROM memory_tombstone WHERE target_type = 'source'",
				)
				.get(),
		).toEqual({ n: 0 });
	});
});

describe("external deletion is never reported complete until confirmed", () => {
	function forgotten() {
		const store = open();
		const record = capture(store, {
			origin: "r1",
			content: "page body",
			providerRef: "stub-provider",
		});
		const recordKey = JSON.stringify([
			"memory",
			"record",
			record.recordId,
			"text",
		]);
		register(store, "world", "n1", [{ type: "source", id: recordKey }]);
		register(store, "world", "n2", [{ type: "source", id: recordKey }]);
		const { entry } = forgetRecord(store, {
			type: "record",
			recordId: record.recordId,
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

	test("three pending deletions (provider + two derivatives): aggregation is failed > pending > unverified > confirmed; only all-confirmed completes", () => {
		const { store, entry } = forgotten();
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

	test("unknown provider / unknown forget / another principal / unpermitted scope", () => {
		const { store, entry } = forgotten();
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

	test("a forget with no provider and no external derivative is complete immediately", () => {
		const store = open();
		const { receipt } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("nothing-here"),
			scopeKey: SCOPE,
		});
		expect(receipt).toMatchObject({ external: "none", completed: true });
	});
});

describe("invariants over a real pipeline", () => {
	test("every state item has at least one dependency edge (no derived row without an edge)", () => {
		const { store, itemId } = scene();
		register(store, "world", "n1", [
			{ type: "state_item", id: idOf(itemId, "水") },
		]);
		expect(
			store.writer
				.query(
					`SELECT COUNT(*) AS n FROM memory_state_item t WHERE NOT EXISTS (
						SELECT 1 FROM memory_dependency d WHERE d.dependent_type = 'state_item' AND d.dependent_id = t.item_id)`,
				)
				.get(),
		).toEqual({ n: 0 });
	});

	test("replaying every journal entry directly is a no-op on the data (idempotent apply)", () => {
		const { store } = scene();
		const { entry } = forgetRecord(store, {
			type: "host_source",
			sourceKey: messageKey("m2"),
			scopeKey: SCOPE,
		});
		const dump = dumpTables(store);
		store.write((db) =>
			applyForget(db, { contractVersion: 1, entry, clock: { atMs: 99 } }),
		);
		expect(dumpTables(store)).toBe(dump);
	});
});

describe("a damaged journal stops Memory and writes nothing", () => {
	test("empty, truncated and tampered journals are inconsistent; the intact journal is accepted and idempotent", () => {
		const { store, itemId, before } = scene();
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
		expect(activeItems(restored)).toEqual(["紅茶"]);
		expect(tablesContain(restored, "水")).toBe(false);
		// 古い DB + 空のジャーナルは JOURNAL_MISSING にならない（DB に墓標がないため）。これは本体だけでは
		// 検出できない限界で、ホストの起動手順（ジャーナルの存在確認）に責任がある。
		const stale = openTestStore({ fromFile: before });
		stores.push(stale);
		expect(reconcile(stale, [])).toEqual({ status: "ok", reapplied: 0 });
		expect(activeItems(stale)).toContain("コーヒー");
	});
});
