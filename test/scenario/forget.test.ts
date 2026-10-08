/**
 * F03 受入と忘却シナリオ（Records 分）: FG1 / FG6 / FG7 / FG8（full-system-design §2.5, §6.1）。
 * 使い捨ての実 SQLite（ファイル + WAL）。「忘却前に複製した DB」を復元して最新ジャーナルで reconcile する。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	applyForget,
	captureRecord,
	deactivateRecord,
	getForgetReceipt,
	isMemoryStoreError,
	listMemoryChanges,
	planForget,
	reactivateRecord,
	readRecordRange,
	recordSourceStates,
	searchRecords,
} from "eumenes-memory/sqlite";
import type { ForgetJournalEntry, MemoryDb } from "eumenes-memory/sqlite";
import { searchRecordsWithStrategy } from "../../src/store/recall.ts";
import {
	buildJournalEntry,
	isSelfConsistent,
} from "../../src/lifecycle/journal.ts";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";
import {
	accessFor,
	capture,
	dumpTables,
	forgetRecord,
	readOf,
	reconcile,
	tablesContain,
} from "../runners/records-support.ts";

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function open(options?: Parameters<typeof openTestStore>[0]): TestStore {
	const store = openTestStore(options);
	stores.push(store);
	return store;
}

const SECRET = "SECRET-BODY-1f9c 食べ物の記録 😀";

function searchAll(store: TestStore, query: string, scopeKeys = ["scope:a"]) {
	return store.read((db) =>
		searchRecords(db, {
			contractVersion: 1,
			access: accessFor(),
			scopeKeys,
			query,
			limit: 50,
		}),
	);
}

function visible(
	store: TestStore,
	recordId: string,
	ref: ReturnType<typeof capture>,
) {
	return {
		read: store.read((db) => readOf(db, recordId)).status,
		range: store.read((db) =>
			readRecordRange(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKey: "scope:a",
				recordId,
				revision: ref.revision,
				range: { startByte: 0, endByte: 3 },
			}),
		).status,
		search: (() => {
			const result = searchAll(store, "SECRET-BODY");
			return result.status === "ok" ? result.hits.length : -1;
		})(),
		states: store.read((db) =>
			recordSourceStates(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKey: "scope:a",
				refs: [ref.ref],
			}),
		)[0]?.status,
	};
}

describe("FG1: forgetting a record", () => {
	test("read / range / search / sourceStates no longer show it; body, index and revisions are gone", () => {
		const store = open();
		const target = capture(store, { origin: "o1", content: SECRET });
		const other = capture(store, {
			origin: "o2",
			content: "unrelated body",
			scopeKey: "scope:b",
		});
		const second = capture(store, { origin: "o1", content: `${SECRET} v2` });
		expect(second.recordId).toBe(target.recordId);
		expect(visible(store, target.recordId, target)).toMatchObject({
			read: "available",
			range: "available",
			search: 1,
		});
		expect(tablesContain(store, "SECRET-BODY")).toBe(true);

		const { plan, receipt } = forgetRecord(store, {
			type: "record",
			recordId: target.recordId,
			scopeKey: "scope:a",
		});
		expect(plan.entry.seq).toBe(1);
		expect(plan.closure.counts).toEqual({
			record: 1,
			state_item: 0,
			candidate: 0,
			extraction_run: 0,
			external: 0,
		});
		expect(receipt).toMatchObject({
			local: "applied",
			external: "none",
			completed: true,
			externalDeletions: [],
		});

		expect(visible(store, target.recordId, target)).toEqual({
			read: "forgotten",
			range: "forgotten",
			search: 0,
			states: "forgotten",
		});
		// 全 revision の本文・索引が消えている
		expect(tablesContain(store, "SECRET-BODY")).toBe(false);
		expect(
			store.writer
				.query(
					"SELECT COUNT(*) AS n FROM memory_record_revision WHERE record_id = ?",
				)
				.get(target.recordId),
		).toEqual({ n: 0 });
		expect(
			store.writer
				.query(
					"SELECT COUNT(*) AS n FROM memory_record_fts WHERE memory_record_fts MATCH '\"SEC\"'",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(
			store.writer.query("SELECT COUNT(*) AS n FROM memory_record_fts").get(),
		).toEqual({ n: 1 }); // other の分
		// 墓標 (record と source)、journal head、receipt
		expect(
			store.writer
				.query("SELECT target_type FROM memory_tombstone ORDER BY target_type")
				.all(),
		).toEqual([{ target_type: "record" }, { target_type: "source" }]);
		expect(
			store.writer
				.query(
					"SELECT applied_head_seq AS s, applied_head_hash AS h FROM memory_journal_state",
				)
				.get(),
		).toEqual({
			s: 1,
			h: plan.entry.hash,
		});
		const got = store.read((db) =>
			getForgetReceipt(db, {
				contractVersion: 1,
				access: accessFor(),
				forgetId: plan.entry.forgetId,
			}),
		);
		expect(got).toEqual({ status: "found", receipt });
		// 無関係な record は影響を受けない
		expect(
			store.read((db) => readOf(db, other.recordId, "scope:b")),
		).toMatchObject({ status: "available", content: "unrelated body" });
		// 変更フィードに forgotten が載る（本文なし）
		const feed = store.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKeys: ["scope:a"],
				afterSeq: 0,
				limit: 50,
			}),
		);
		if (feed.status !== "ok") throw new Error("unreachable");
		expect(feed.changes.at(-1)).toMatchObject({
			targetType: "record",
			status: "forgotten",
			forgetId: plan.entry.forgetId,
			revision: null,
		});
		expect(JSON.stringify(feed)).not.toContain("SECRET");
	});

	test.each([
		["both tombstones", []],
		["only the record tombstone", ["source"]],
		["only the source tombstone", ["record"]],
	] as const)(
		"status, revision, body and index restored by hand cannot bring the record back (%s)",
		(_name, dropped) => {
			const store = open();
			const target = capture(store, { origin: "o1", content: SECRET });
			forgetRecord(store, {
				type: "record",
				recordId: target.recordId,
				scopeKey: "scope:a",
			});
			// 古い DB の行を書き戻す（trigger は手作業の復元を想定しないので外す）
			store.writer.exec("DROP TRIGGER memory_record_body_no_resurrection");
			store.writer.exec("DROP TRIGGER memory_record_revision_no_resurrection");
			store.writer.exec(`
				UPDATE memory_record SET status = 'active', current_revision = '${target.revision}',
					origin_namespace = 'web', origin_kind = 'page', origin_id = 'o1' WHERE record_id = '${target.recordId}';
			`);
			store.writer
				.query(
					"INSERT INTO memory_record_body (rowid, record_id, revision, representation, content) VALUES (1, ?, ?, 'text', ?)",
				)
				.run(target.recordId, target.revision, SECRET);
			store.writer
				.query("INSERT INTO memory_record_revision VALUES (?, ?, ?, 1, 1, 1)")
				.run(target.recordId, target.revision, target.digest);
			store.writer
				.query("INSERT INTO memory_record_fts (rowid, body) VALUES (1, ?)")
				.run(SECRET.toLowerCase());
			for (const type of dropped) {
				store.writer
					.query("DELETE FROM memory_tombstone WHERE target_type = ?")
					.run(type);
			}
			expect(visible(store, target.recordId, target)).toMatchObject({
				read: "forgotten",
				search: 0,
				states: "forgotten",
			});
			// 索引に戻した行があっても、どちらの戦略でも検索に出ない
			for (const strategy of ["like", "fts"] as const) {
				expect(
					store.read((db) =>
						searchRecordsWithStrategy(
							db,
							{
								contractVersion: 1,
								access: accessFor(),
								scopeKeys: ["scope:a"],
								query: "SECRET-BODY",
								limit: 5,
							},
							strategy,
						),
					),
				).toMatchObject({ status: "ok", hits: [] });
			}
		},
	);

	test("forgetting a record this DB never had still blocks a later capture of it", () => {
		const origin = open();
		const ghost = capture(origin, { origin: "ghost", content: "ghost body" });
		const { entry } = forgetRecord(origin, {
			type: "record",
			recordId: ghost.recordId,
			scopeKey: "scope:a",
		});
		const fresh = open();
		expect(reconcile(fresh, [entry])).toEqual({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		const blocked = fresh.write((db) =>
			captureRecord(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKey: "scope:a",
				clock: { atMs: 5 },
				origin: { namespace: "web", kind: "page", id: "ghost" },
				mediaType: "text/plain",
				content: "ghost body",
				captureState: "complete",
			}),
		);
		expect(blocked).toEqual({ status: "blocked", reasonCode: "TOMBSTONED" });
	});

	test("the source tombstone alone is enough to hide the record", () => {
		const store = open();
		const target = capture(store, { origin: "o1", content: SECRET });
		forgetRecord(store, {
			type: "record",
			recordId: target.recordId,
			scopeKey: "scope:a",
		});
		store.writer.exec(
			"DELETE FROM memory_tombstone WHERE target_type = 'record'",
		);
		store.writer.exec("UPDATE memory_record SET status = 'active'");
		expect(store.read((db) => readOf(db, target.recordId)).status).toBe(
			"forgotten",
		);
		expect(searchAll(store, "SECRET")).toMatchObject({ hits: [] });
	});
});

describe("FG6: deactivate is reversible and is not forgetting", () => {
	test("body kept, no tombstone, no receipt, reactivate brings it back", () => {
		const store = open();
		const target = capture(store, { origin: "o1", content: SECRET });
		const change = {
			contractVersion: 1,
			access: accessFor(),
			scopeKey: "scope:a",
			clock: { atMs: 5 },
			recordId: target.recordId,
		} as const;
		store.write((db) => deactivateRecord(db, change));
		expect(searchAll(store, "SECRET-BODY")).toMatchObject({ hits: [] });
		expect(store.read((db) => readOf(db, target.recordId))).toMatchObject({
			status: "available",
			content: SECRET,
		});
		expect(tablesContain(store, "SECRET-BODY")).toBe(true);
		for (const table of [
			"memory_tombstone",
			"memory_forget",
			"memory_forget_external",
		]) {
			expect(
				store.writer.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
			).toEqual({ n: 0 });
		}
		store.write((db) => reactivateRecord(db, change));
		expect(searchAll(store, "SECRET-BODY")).toMatchObject({ hits: [{}] });
	});
});

describe("FG8: a tombstoned record cannot be captured again", () => {
	test("captureRecord is blocked; a raw insert is stopped by the trigger", () => {
		const store = open();
		const target = capture(store, { origin: "o1", content: SECRET });
		forgetRecord(store, {
			type: "record",
			recordId: target.recordId,
			scopeKey: "scope:a",
		});
		const again = store.write((db) =>
			captureRecord(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKey: "scope:a",
				clock: { atMs: 300 },
				origin: { namespace: "web", kind: "page", id: "o1" },
				mediaType: "text/plain",
				content: "new content for the forgotten origin",
				captureState: "complete",
			}),
		);
		expect(again).toEqual({ status: "blocked", reasonCode: "TOMBSTONED" });
		expect(tablesContain(store, "new content for the forgotten")).toBe(false);
		// trigger の最終防衛線
		try {
			store.writer
				.query(
					`INSERT INTO memory_record_body (record_id, revision, representation, content) VALUES (?, 'sha256:x', 'text', 'x')`,
				)
				.run(target.recordId);
			throw new Error("insert should have been rejected");
		} catch (error) {
			expect(String(error)).toContain("memory_tombstoned");
		}
		void isMemoryStoreError;
	});
});

describe("FG7 / F03: restore an old DB, reconcile with the latest journal", () => {
	function scenario() {
		const live = open();
		const keep = capture(live, { origin: "keep", content: "kept body text" });
		const gone = capture(live, {
			origin: "gone",
			content: SECRET,
			providerRef: "larm",
		});
		const goneB = capture(live, {
			origin: "gone-b",
			content: `${SECRET} B`,
			scopeKey: "scope:b",
		});
		const oldDbPath = live.snapshotTo("before-forget");
		const journal: ForgetJournalEntry[] = [];
		journal.push(
			forgetRecord(live, {
				type: "record",
				recordId: gone.recordId,
				scopeKey: "scope:a",
			}).entry,
		);
		journal.push(
			forgetRecord(live, { type: "scope", scopeKey: "scope:b" }).entry,
		);
		return { live, keep, gone, goneB, oldDbPath, journal };
	}

	test("the old DB shows the forgotten record; after reconcile it is invisible everywhere, and reconcile is idempotent", () => {
		const { keep, gone, goneB, oldDbPath, journal } = scenario();
		const restored = open({ fromFile: oldDbPath });
		// 復元直後（reconcile 前）は古い状態がそのまま見える。これを防ぐのがホストの起動手順。
		expect(restored.read((db) => readOf(db, gone.recordId)).status).toBe(
			"available",
		);
		expect(searchAll(restored, "SECRET-BODY").status).toBe("ok");

		expect(reconcile(restored, journal)).toEqual({
			status: "ok",
			reapplied: 2,
			feedResyncRequired: true,
		});
		expect(visible(restored, gone.recordId, gone)).toEqual({
			read: "forgotten",
			range: "forgotten",
			search: 0,
			states: "forgotten",
		});
		expect(
			restored.read((db) => readOf(db, goneB.recordId, "scope:b")).status,
		).toBe("forgotten");
		expect(restored.read((db) => readOf(db, keep.recordId))).toMatchObject({
			status: "available",
			content: "kept body text",
		});
		expect(tablesContain(restored, "SECRET-BODY")).toBe(false);
		expect(
			restored.writer
				.query(
					"SELECT COUNT(*) AS n FROM memory_record_fts WHERE memory_record_fts MATCH '\"SECRET\"'",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(
			restored.writer
				.query(
					"SELECT applied_head_seq AS s, applied_head_hash AS h FROM memory_journal_state",
				)
				.get(),
		).toEqual({
			s: 2,
			h: journal[1]?.hash,
		});
		// 外部へ送った record の外部削除が pending で復元される
		const receipt = restored.read((db) =>
			getForgetReceipt(db, {
				contractVersion: 1,
				access: accessFor(),
				forgetId: journal[0]?.forgetId ?? "",
			}),
		);
		expect(receipt).toMatchObject({
			status: "found",
			receipt: {
				external: "pending",
				completed: false,
				externalDeletions: [
					{ providerRef: "larm", externalId: null, state: "pending" },
				],
			},
		});

		const dump = dumpTables(restored);
		expect(reconcile(restored, journal)).toEqual({
			status: "ok",
			reapplied: 0,
		});
		expect(dumpTables(restored)).toBe(dump);
		// 再適用（applyForget の直接再実行）も結果は同じ
		const again = restored.write((db) =>
			applyAgain(db, journal[0] as ForgetJournalEntry),
		);
		expect(again).toMatchObject({
			forgetId: journal[0]?.forgetId,
			local: "applied",
			external: "pending",
		});
		expect(visible(restored, gone.recordId, gone).read).toBe("forgotten");
	});

	test("a partially restored DB (journal head ahead of records) is still fixed by replaying every entry", () => {
		const { oldDbPath, journal, gone } = scenario();
		const restored = open({ fromFile: oldDbPath });
		// 1 つ目だけ適用済みの DB を作る
		expect(reconcile(restored, journal.slice(0, 1))).toEqual({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		expect(reconcile(restored, journal)).toEqual({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		expect(restored.read((db) => readOf(db, gone.recordId)).status).toBe(
			"forgotten",
		);
	});

	test("a DB restored from an old snapshot has a rewound change feed: reconcile flags feedResyncRequired, and a stale cursor misses the forgotten notice", () => {
		const live = open();
		const target = capture(live, { origin: "one", content: SECRET });
		const oldDbPath = live.snapshotTo("rewound");
		// 古いスナップショットに残らなかった活動（変更フィードの番号を進める）
		for (let index = 0; index < 5; index += 1) {
			capture(live, { origin: `more-${index}`, content: `more ${index}` });
		}
		const entry = forgetRecord(live, {
			type: "record",
			recordId: target.recordId,
			scopeKey: "scope:a",
		}).entry;
		const feed = (store: TestStore, afterSeq: number) => {
			const result = store.read((db) =>
				listMemoryChanges(db, {
					contractVersion: 1,
					access: accessFor(),
					scopeKeys: ["scope:a"],
					afterSeq,
					limit: 500,
				}),
			);
			if (result.status !== "ok") throw new Error("feed blocked");
			return result;
		};
		const liveChanges = feed(live, 0).changes;
		const cursor = liveChanges[liveChanges.length - 1]?.seq ?? 0;
		expect(cursor).toBeGreaterThan(0);

		const restored = open({ fromFile: oldDbPath });
		const result = reconcile(restored, [entry]);
		expect(result).toEqual({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		// 復元後の番号は巻き戻っているので、巻き戻り前のカーソルでは忘却通知が見えない。
		expect(
			feed(restored, cursor).changes.filter((c) => c.status === "forgotten"),
		).toEqual([]);
		// 全再同期（カーソルなし）なら忘却通知が見える。
		expect(
			feed(restored, 0).changes.filter(
				(c) => c.status === "forgotten" && c.targetId === target.recordId,
			),
		).toHaveLength(1);
	});

	test("journal loss or damage stops Memory (inconsistent) and writes nothing", () => {
		const { live, oldDbPath, journal } = scenario();
		const restored = open({ fromFile: oldDbPath });
		const dumpBefore = dumpTables(restored);

		// 空のジャーナル: 墓標のある DB では JOURNAL_MISSING
		expect(reconcile(live, [])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_MISSING",
		});
		// 末尾切り詰め: DB の head より短い
		expect(reconcile(live, journal.slice(0, 1))).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_TRUNCATED",
		});
		// 1 entry 改ざん
		const tampered = journal.map((entry, index) =>
			index === 0
				? {
						...entry,
						targets: [
							{ ...(entry.targets[0] as object), id: `rec:${"0".repeat(64)}` },
						],
					}
				: entry,
		);
		expect(reconcile(live, tampered)).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		expect(reconcile(restored, tampered)).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		// 鎖の入れ替え・先頭欠落
		expect(reconcile(restored, [journal[1]])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		expect(reconcile(restored, [journal[1], journal[0]])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		// 別のジャーナル（DB の記録と forgetId が合わない）
		const foreign = open();
		const other = capture(foreign, { origin: "x", content: "x" });
		const foreignEntry = forgetRecord(foreign, {
			type: "record",
			recordId: other.recordId,
			scopeKey: "scope:a",
		}).entry;
		expect(reconcile(live, [foreignEntry, journal[1]])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		// 壊れた要素
		expect(reconcile(restored, [journal[0], { seq: 2 }])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		expect(reconcile(restored, [null])).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});

		expect(dumpTables(restored)).toBe(dumpBefore);
	});

	test("a journal shorter than the DB head is TRUNCATED even when the tombstones of the lost entries are gone; DB rows disagreeing with the journal are CHAIN_BROKEN", () => {
		const { live, journal } = scenario();
		live.writer.exec("DELETE FROM memory_tombstone WHERE journal_seq = 2");
		expect(reconcile(live, journal.slice(0, 1))).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_TRUNCATED",
		});
		expect(reconcile(live, journal)).toEqual({ status: "ok", reapplied: 0 });
		// DB の head（memory_journal_state）がジャーナルの同じ位置の entry と食い違う
		live.writer.exec(
			`UPDATE memory_journal_state SET applied_head_hash = '${"c".repeat(64)}' WHERE id = 1`,
		);
		expect(reconcile(live, journal)).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		live.writer.exec(
			`UPDATE memory_journal_state SET applied_head_hash = '${journal[1]?.hash ?? ""}' WHERE id = 1`,
		);
		live.writer.exec(
			"UPDATE memory_forget SET forget_id = 'forget:other' WHERE journal_seq = 1",
		);
		expect(reconcile(live, journal)).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
	});

	test("applyForget rejects entries that do not continue the DB's chain", () => {
		const { live, journal } = scenario();
		const entry = journal[0] as ForgetJournalEntry;
		// 適用済みの seq で hash が違う
		const codeOf = (candidate: ForgetJournalEntry): string => {
			try {
				live.write((db) => applyAgain(db, candidate));
			} catch (error) {
				return isMemoryStoreError(error) ? error.code : String(error);
			}
			return "no error";
		};
		expect(codeOf({ ...entry, hash: "0".repeat(64) })).toBe(
			"JOURNAL_ENTRY_INVALID",
		);
		const planned = live.read((db) =>
			planForget(db, {
				contractVersion: 1,
				access: accessFor(),
				target: { type: "scope", scopeKey: "scope:c" },
				clock: { atMs: 1 },
			}),
		);
		if (planned.status !== "planned") throw new Error("unreachable");
		expect(planned.plan.entry.seq).toBe(3);
		expect(planned.plan.entry.prevHash).toBe(journal[1]?.hash ?? "");
		// 2 つ先の entry は、hash・forgetId を再計算した自己整合なものでも拒否される（seq ギャップ）。
		const skipped = buildJournalEntry({
			seq: 4,
			prevHash: planned.plan.entry.hash,
			principal: planned.plan.entry.principal,
			targets: planned.plan.entry.targets,
		});
		expect(isSelfConsistent(skipped)).toBe(true);
		const dumpBefore = dumpTables(live);
		expect(codeOf(skipped)).toBe("JOURNAL_ENTRY_INVALID");
		expect(dumpTables(live)).toBe(dumpBefore);
		// 対照: 連続した seq 3 は適用できる（上の拒否は連続性だけが理由）
		expect(
			live.write((db) => applyAgain(db, planned.plan.entry)).completed,
		).toBe(true);
	});
});

function applyAgain(db: MemoryDb, entry: ForgetJournalEntry) {
	return applyForget(db, { contractVersion: 1, entry, clock: { atMs: 999 } });
}
