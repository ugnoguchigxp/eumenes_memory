import { afterEach, describe, expect, test } from "bun:test";
import type { AccessContext } from "../../contracts/types.ts";
import type { ForgetJournalEntry } from "../../contracts/lifecycle.ts";
import { recordSourceKey } from "../../evidence/record.ts";
import { GENESIS_JOURNAL_HASH } from "../../contracts/lifecycle.ts";
import {
	buildJournalEntry,
	computeEntryHash,
	computeForgetId,
} from "../../lifecycle/journal.ts";
import { addDependency } from "../dependency.ts";
import { isMemoryStoreError } from "../errors.ts";
import {
	applyForget,
	getForgetReceipt,
	planForget,
	reconcileForgetJournal,
	recordExternalDeletion,
	registerExternalDependents,
} from "../lifecycle.ts";
import { captureRecord, readRecord } from "../records.ts";
import { openTestStore } from "../../../test/support/store.ts";
import type { TestStore } from "../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(): TestStore {
	store = openTestStore();
	return store;
}

const ACCESS: AccessContext = {
	principal: "local:owner",
	scopeKeys: ["scope:a", "scope:b"],
	purpose: "test",
	policyRevision: "1",
};
const CLOCK = { atMs: 10 } as const;

function put(
	s: TestStore,
	origin: string,
	scopeKey = "scope:a",
	providerRef?: string,
) {
	const result = s.write((db) =>
		captureRecord(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey,
			clock: CLOCK,
			origin: { namespace: "web", kind: "page", id: origin },
			mediaType: "text/plain",
			content: `body of ${origin}`,
			captureState: "complete",
			...(providerRef === undefined ? {} : { providerRef }),
		}),
	);
	if (result.status !== "captured") throw new Error("capture blocked");
	return result;
}

function plan(
	s: TestStore,
	target: Parameters<typeof planForget>[1]["target"],
	access = ACCESS,
) {
	return s.read((db) =>
		planForget(db, { contractVersion: 1, access, target, clock: CLOCK }),
	);
}

function apply(s: TestStore, entry: ForgetJournalEntry) {
	return s.write((db) =>
		applyForget(db, { contractVersion: 1, entry, clock: CLOCK }),
	);
}

function edge(
	s: TestStore,
	dependentType: "state_item" | "candidate" | "extraction_run" | "external",
	dependentId: string,
	dependencyType: "source" | "state_item" | "candidate" | "extraction_run",
	dependencyId: string,
	role: "primary" | "support" | "input" | "derived_from" = "support",
	scopeKey = "scope:a",
	principal = "local:owner",
) {
	s.write((db) =>
		addDependency(db, {
			principal,
			scopeKey,
			dependentType,
			dependentId,
			dependencyType,
			dependencyId,
			role,
		}),
	);
}

describe("planForget", () => {
	test("is read-only, deterministic and works on the readonly connection", () => {
		const s = open();
		const record = put(s, "o1");
		const before = JSON.stringify(
			s.writer.query("SELECT * FROM memory_record").all(),
		);
		const target = {
			type: "record",
			recordId: record.recordId,
			scopeKey: "scope:a",
		} as const;
		const first = plan(s, target);
		const second = plan(s, target);
		expect(first).toEqual(second);
		if (first.status !== "planned") throw new Error("unreachable");
		expect(first.plan.entry).toMatchObject({
			journalFormat: 1,
			seq: 1,
			principal: "local:owner",
		});
		expect(first.plan.entry.prevHash).toBe("0".repeat(64));
		expect(first.plan.entry.targets).toEqual([
			{ type: "record", id: record.recordId, scopeKey: "scope:a" },
		]);
		expect(JSON.stringify(first.plan)).not.toContain("body of");
		expect(
			JSON.stringify(s.writer.query("SELECT * FROM memory_record").all()),
		).toBe(before);
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_forget").get(),
		).toEqual({ n: 0 });
	});

	test("blocks scopes outside the access for every target type", () => {
		const s = open();
		for (const target of [
			{ type: "scope", scopeKey: "scope:z" },
			{
				type: "host_source",
				sourceKey: '["conversation","message","m1","text"]',
				scopeKey: "scope:z",
			},
			{ type: "state_item", itemId: "item:1", scopeKey: "scope:z" },
		] as const) {
			expect(plan(s, target)).toEqual({
				status: "blocked",
				reasonCode: "SCOPE_NOT_PERMITTED",
			});
		}
	});

	test("a plan made before the DB advanced cannot be applied out of order", () => {
		const s = open();
		const a = put(s, "a");
		const b = put(s, "b");
		const planA = plan(s, {
			type: "record",
			recordId: a.recordId,
			scopeKey: "scope:a",
		});
		const planB = plan(s, {
			type: "record",
			recordId: b.recordId,
			scopeKey: "scope:a",
		});
		if (planA.status !== "planned" || planB.status !== "planned")
			throw new Error("unreachable");
		expect(planA.plan.entry.seq).toBe(1);
		expect(planB.plan.entry.seq).toBe(1);
		apply(s, planA.plan.entry);
		// B の plan は seq 1 のまま（head が進んだので適用できない）
		expect(() => apply(s, planB.plan.entry)).toThrow();
		const replan = plan(s, {
			type: "record",
			recordId: b.recordId,
			scopeKey: "scope:a",
		});
		if (replan.status !== "planned") throw new Error("unreachable");
		expect(replan.plan.entry.seq).toBe(2);
		expect(replan.plan.entry.prevHash).toBe(planA.plan.entry.hash);
		apply(s, replan.plan.entry);
	});
});

describe("applyForget", () => {
	test("requires a write transaction and a writable connection", () => {
		const s = open();
		const record = put(s, "o1");
		const planned = plan(s, {
			type: "record",
			recordId: record.recordId,
			scopeKey: "scope:a",
		});
		if (planned.status !== "planned") throw new Error("unreachable");
		const input = {
			contractVersion: 1,
			entry: planned.plan.entry,
			clock: CLOCK,
		} as const;
		try {
			applyForget(s.writer, input);
			throw new Error("expected NOT_IN_TRANSACTION");
		} catch (error) {
			expect(isMemoryStoreError(error) && error.code).toBe(
				"NOT_IN_TRANSACTION",
			);
		}
		try {
			s.read((db) => applyForget(db, input));
			throw new Error("expected READONLY_CONNECTION");
		} catch (error) {
			expect(isMemoryStoreError(error) && error.code).toBe(
				"READONLY_CONNECTION",
			);
		}
	});

	test("rejects a tampered entry without writing", () => {
		const s = open();
		const record = put(s, "o1");
		const planned = plan(s, {
			type: "record",
			recordId: record.recordId,
			scopeKey: "scope:a",
		});
		if (planned.status !== "planned") throw new Error("unreachable");
		const entry = planned.plan.entry;
		for (const bad of [
			{ ...entry, principal: "local:other" },
			{ ...entry, hash: "1".repeat(64) },
			{ ...entry, forgetId: `forget:${"2".repeat(64)}` },
			{
				...entry,
				targets: [{ type: "scope", id: "scope:x", scopeKey: "scope:a" }],
			},
		] as ForgetJournalEntry[]) {
			try {
				apply(s, bad);
				throw new Error("expected rejection");
			} catch (error) {
				expect(isMemoryStoreError(error) && error.code).toBe(
					"JOURNAL_ENTRY_INVALID",
				);
			}
		}
		expect(
			s.read((db) =>
				readRecord(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: "scope:a",
					recordId: record.recordId,
				}),
			).status,
		).toBe("available");
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_tombstone").get(),
		).toEqual({ n: 0 });
	});

	test("scope forget: replaying an applied entry does not touch records captured afterwards", () => {
		const s = open();
		put(s, "a1");
		put(s, "a2");
		put(s, "b1", "scope:b");
		const planned = plan(s, { type: "scope", scopeKey: "scope:a" });
		if (planned.status !== "planned") throw new Error("unreachable");
		expect(planned.plan.closure.counts["record"]).toBe(2);
		const receipt = apply(s, planned.plan.entry);
		expect(receipt.completed).toBe(true);
		const later = put(s, "a3");
		const again = apply(s, planned.plan.entry);
		expect(again).toEqual(receipt);
		const read = (recordId: string, scopeKey: string) =>
			s.read((db) =>
				readRecord(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey,
					recordId,
				}),
			).status;
		expect(read(later.recordId, "scope:a")).toBe("available");
		expect(
			s.writer
				.query(
					"SELECT COUNT(*) AS n FROM memory_tombstone WHERE target_type = 'record'",
				)
				.get(),
		).toEqual({ n: 2 });
		// head の次の journal を reconcile しても、適用済みの entry は再適用しない
		expect(
			s.write((db) =>
				reconcileForgetJournal(db, {
					contractVersion: 1,
					entries: [planned.plan.entry],
					clock: CLOCK,
				}),
			),
		).toEqual({ status: "ok", reapplied: 0 });
		expect(read(later.recordId, "scope:a")).toBe("available");
	});

	test("every apply bumps the scope revision of the targets", () => {
		const s = open();
		const record = put(s, "o1");
		const revision = () =>
			s.writer
				.query(
					"SELECT revision FROM memory_scope_state WHERE scope_key = 'scope:a'",
				)
				.get();
		expect(revision()).toEqual({ revision: 1 });
		const planned = plan(s, {
			type: "record",
			recordId: record.recordId,
			scopeKey: "scope:a",
		});
		if (planned.status !== "planned") throw new Error("unreachable");
		apply(s, planned.plan.entry);
		expect(revision()).toEqual({ revision: 2 });
		apply(s, planned.plan.entry);
		expect(revision()).toEqual({ revision: 3 });
	});
});

describe("closure over memory_dependency and external pending/unverified (FG5, record part)", () => {
	test("derived rows get tombstones; external derivatives and providers return as pending until confirmed", () => {
		const s = open();
		const record = put(s, "o1", "scope:a", "larm");
		const source = recordSourceKey(record.recordId);
		const unrelated = put(s, "o2");
		edge(s, "state_item", "item:1", "source", source, "primary");
		edge(s, "candidate", "cand:1", "source", source, "support");
		edge(s, "extraction_run", "run:1", "source", source, "input");
		edge(s, "candidate", "cand:2", "extraction_run", "run:1", "derived_from");
		edge(s, "state_item", "item:2", "candidate", "cand:2", "primary");
		edge(s, "external", "world:n1", "source", source, "derived_from");
		edge(s, "external", "world:n2", "state_item", "item:2", "derived_from");
		// 他の principal の辺は辿らない
		edge(
			s,
			"state_item",
			"item:other",
			"source",
			source,
			"primary",
			"scope:a",
			"local:other",
		);
		// 無関係な record の派生物
		edge(
			s,
			"state_item",
			"item:3",
			"source",
			recordSourceKey(unrelated.recordId),
			"primary",
		);

		const planned = plan(s, {
			type: "record",
			recordId: record.recordId,
			scopeKey: "scope:a",
		});
		if (planned.status !== "planned") throw new Error("unreachable");
		expect(planned.plan.closure.counts).toEqual({
			record: 1,
			state_item: 2,
			candidate: 2,
			extraction_run: 1,
			external: 2,
		});
		expect(planned.plan.externalProviders).toEqual(["larm"]);
		expect(planned.plan.externalDependents).toEqual([
			{ providerRef: "world", externalId: "n1" },
			{ providerRef: "world", externalId: "n2" },
		]);

		const receipt = apply(s, planned.plan.entry);
		expect(receipt).toMatchObject({
			local: "applied",
			external: "pending",
			completed: false,
		});
		expect(receipt.externalDeletions).toEqual([
			{ providerRef: "larm", externalId: null, state: "pending" },
			{ providerRef: "world", externalId: "n1", state: "pending" },
			{ providerRef: "world", externalId: "n2", state: "pending" },
		]);
		const tombstones = s.writer
			.query(
				"SELECT target_type AS t, target_id AS i FROM memory_tombstone ORDER BY t, i",
			)
			.all() as { t: string; i: string }[];
		expect(tombstones.map((row) => `${row.t}:${row.i}`)).toEqual(
			[
				"candidate:cand:1",
				"candidate:cand:2",
				"external:world:n1",
				"external:world:n2",
				`record:${record.recordId}`,
				"extraction_run:run:1",
				`source:${source}`,
				"state_item:item:1",
				"state_item:item:2",
			].sort(),
		);
		// 変更フィードに state_item の forgotten が載る
		expect(
			s.writer
				.query(
					"SELECT target_id FROM memory_change WHERE target_type = 'state_item' ORDER BY target_id",
				)
				.all(),
		).toEqual([{ target_id: "item:1" }, { target_id: "item:2" }]);

		// 確認状況の集約（recordExternalDeletion は S6。ここでは表を直接更新して集約規則だけを確認する）
		const receiptOf = () =>
			s.read((db) =>
				getForgetReceipt(db, {
					contractVersion: 1,
					access: ACCESS,
					forgetId: planned.plan.entry.forgetId,
				}),
			);
		const setState = (providerRef: string, externalId: string, state: string) =>
			s.writer
				.query(
					"UPDATE memory_forget_external SET state = ? WHERE provider_ref = ? AND external_id = ?",
				)
				.run(state, providerRef, externalId);
		setState("larm", "", "confirmed");
		setState("world", "n1", "confirmed");
		expect(receiptOf()).toMatchObject({
			status: "found",
			receipt: { external: "pending", completed: false },
		});
		setState("world", "n2", "unverified");
		expect(receiptOf()).toMatchObject({
			receipt: { external: "unverified", completed: false },
		});
		setState("world", "n2", "failed");
		expect(receiptOf()).toMatchObject({
			receipt: { external: "failed", completed: false },
		});
		setState("world", "n2", "confirmed");
		expect(receiptOf()).toMatchObject({
			receipt: { external: "confirmed", completed: true },
		});
		// 再適用は確認済みの状態を pending に戻さない
		apply(s, planned.plan.entry);
		expect(receiptOf()).toMatchObject({
			receipt: { external: "confirmed", completed: true },
		});
	});

	test("getForgetReceipt authorisation", () => {
		const s = open();
		const record = put(s, "o1");
		const planned = plan(s, {
			type: "record",
			recordId: record.recordId,
			scopeKey: "scope:a",
		});
		if (planned.status !== "planned") throw new Error("unreachable");
		apply(s, planned.plan.entry);
		const get = (
			access: AccessContext,
			forgetId = planned.plan.entry.forgetId,
		) =>
			s.read((db) =>
				getForgetReceipt(db, { contractVersion: 1, access, forgetId }),
			);
		expect(get(ACCESS).status).toBe("found");
		expect(get({ ...ACCESS, principal: "local:other" })).toEqual({
			status: "missing",
		});
		expect(get({ ...ACCESS, scopeKeys: ["scope:b"] })).toEqual({
			status: "not_permitted",
		});
		expect(get(ACCESS, `forget:${"0".repeat(64)}`)).toEqual({
			status: "missing",
		});
	});
});

/**
 * 鎖の連結検査。entry は buildJournalEntry / computeEntryHash で hash を再計算した「自己整合な」別系統で、
 * hash の不一致では弾かれない。弾く責任は applyEntry の連結検査（seq 連続・prevHash == head.hash）と reconcile の鎖検証にある。
 */
describe("journal chain continuity (self-consistent foreign entries)", () => {
	const PRINCIPAL = "local:owner";

	function twoRecordsOneForgotten() {
		const s = open();
		const r1 = put(s, "c1");
		const r2 = put(s, "c2");
		const planned = plan(s, {
			type: "record",
			recordId: r1.recordId,
			scopeKey: "scope:a",
		});
		if (planned.status !== "planned") throw new Error("unreachable");
		apply(s, planned.plan.entry);
		return { s, r1, r2, first: planned.plan.entry };
	}

	function forgetEntryFor(
		recordId: string,
		fields: { seq: number; prevHash: string },
	): ForgetJournalEntry {
		return buildJournalEntry({
			...fields,
			principal: PRINCIPAL,
			targets: [{ type: "record", id: recordId, scopeKey: "scope:a" }],
		});
	}

	function counts(s: TestStore) {
		return {
			tombstones: s.writer
				.query("SELECT COUNT(*) AS n FROM memory_tombstone")
				.get(),
			forgets: s.writer.query("SELECT COUNT(*) AS n FROM memory_forget").get(),
			head: s.writer
				.query(
					"SELECT applied_head_seq, applied_head_hash FROM memory_journal_state",
				)
				.get(),
		};
	}

	function codeOf(fn: () => unknown): string {
		try {
			fn();
		} catch (error) {
			return isMemoryStoreError(error) ? error.code : String(error);
		}
		return "no error";
	}

	function recordStatus(s: TestStore, recordId: string): string {
		return s.read((db) =>
			readRecord(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: "scope:a",
				recordId,
			}),
		).status;
	}

	function reconcileWith(s: TestStore, entries: readonly ForgetJournalEntry[]) {
		return s.write((db) =>
			reconcileForgetJournal(db, {
				contractVersion: 1,
				entries,
				clock: CLOCK,
			}),
		);
	}

	test("applyForget rejects a self-consistent next entry whose prevHash is not the DB head", () => {
		const { s, r2, first } = twoRecordsOneForgotten();
		const before = counts(s);
		const wrongPrev = forgetEntryFor(r2.recordId, {
			seq: 2,
			prevHash: "f".repeat(64),
		});
		const toGenesis = forgetEntryFor(r2.recordId, {
			seq: 2,
			prevHash: GENESIS_JOURNAL_HASH,
		});
		for (const entry of [wrongPrev, toGenesis]) {
			expect(codeOf(() => apply(s, entry))).toBe("JOURNAL_ENTRY_INVALID");
		}
		expect(recordStatus(s, r2.recordId)).toBe("available");
		expect(counts(s)).toEqual(before);
		// 対照: 正しい prevHash なら適用される
		const good = forgetEntryFor(r2.recordId, { seq: 2, prevHash: first.hash });
		expect(apply(s, good).completed).toBe(true);
		expect(recordStatus(s, r2.recordId)).toBe("forgotten");
	});

	test("applyForget rejects a seq gap and a first entry that does not start at genesis", () => {
		const { s, r2, first } = twoRecordsOneForgotten();
		const before = counts(s);
		const gap = forgetEntryFor(r2.recordId, { seq: 3, prevHash: first.hash });
		expect(codeOf(() => apply(s, gap))).toBe("JOURNAL_ENTRY_INVALID");
		expect(counts(s)).toEqual(before);
		expect(recordStatus(s, r2.recordId)).toBe("available");

		const fresh = open();
		const rec = put(fresh, "c3");
		const badStart = forgetEntryFor(rec.recordId, {
			seq: 1,
			prevHash: "e".repeat(64),
		});
		expect(codeOf(() => apply(fresh, badStart))).toBe("JOURNAL_ENTRY_INVALID");
		expect(
			codeOf(() =>
				apply(
					fresh,
					forgetEntryFor(rec.recordId, {
						seq: 2,
						prevHash: GENESIS_JOURNAL_HASH,
					}),
				),
			),
		).toBe("JOURNAL_ENTRY_INVALID");
		expect(recordStatus(fresh, rec.recordId)).toBe("available");
	});

	test("applyForget rejects a different self-consistent entry at an already applied seq", () => {
		const { s, r2 } = twoRecordsOneForgotten();
		const before = counts(s);
		const rival = forgetEntryFor(r2.recordId, {
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
		});
		expect(codeOf(() => apply(s, rival))).toBe("JOURNAL_ENTRY_INVALID");
		expect(recordStatus(s, r2.recordId)).toBe("available");
		expect(counts(s)).toEqual(before);
	});

	test("reconcile refuses journals that are valid per entry but not one chain with the DB", () => {
		const { s, r1, r2, first } = twoRecordsOneForgotten();
		const before = counts(s);
		const broken = {
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		} as const;
		// 分岐: 先頭が別系統（DB の head と hash が合わない）
		const rivalFirst = forgetEntryFor(r2.recordId, {
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
		});
		const rivalSecond = forgetEntryFor(r1.recordId, {
			seq: 2,
			prevHash: rivalFirst.hash,
		});
		expect(reconcileWith(s, [rivalFirst, rivalSecond])).toEqual(broken);
		// 継ぎ接ぎ: 先頭は DB と同じ、2 件目が別系統の先頭に連なる
		expect(
			reconcileWith(s, [
				first,
				forgetEntryFor(r2.recordId, { seq: 2, prevHash: rivalFirst.hash }),
			]),
		).toEqual(broken);
		// seq 飛び
		expect(
			reconcileWith(s, [
				first,
				forgetEntryFor(r2.recordId, { seq: 3, prevHash: first.hash }),
			]),
		).toEqual(broken);
		// targets 非整列・重複 / forgetId 不一致（hash は再計算済み）
		type Targets = readonly ForgetJournalEntry["targets"][number][];
		const sorted: Targets = [
			{ type: "record", id: r2.recordId, scopeKey: "scope:a" },
			{ type: "record", id: r1.recordId, scopeKey: "scope:a" },
		].sort((a, b) => (a.id < b.id ? -1 : 1)) as Targets;
		const unsortedTargets: Targets = [
			sorted[1],
			sorted[0],
		] as unknown as Targets;
		const duplicated: Targets = [sorted[0], sorted[0]] as unknown as Targets;
		const mk = (t: Targets, forgetId = computeForgetId(PRINCIPAL, 2, t)) => {
			const body = {
				journalFormat: 1 as const,
				seq: 2,
				prevHash: first.hash,
				forgetId,
				principal: PRINCIPAL,
				targets: t,
			};
			return { ...body, hash: computeEntryHash(body) } as ForgetJournalEntry;
		};
		expect(reconcileWith(s, [first, mk(unsortedTargets)])).toEqual(broken);
		expect(reconcileWith(s, [first, mk(duplicated)])).toEqual(broken);
		expect(
			reconcileWith(s, [first, mk(sorted, `forget:${"4".repeat(64)}`)]),
		).toEqual(broken);
		expect(counts(s)).toEqual(before);
		expect(recordStatus(s, r2.recordId)).toBe("available");
		// 対照: 整列済み・正しい forgetId・連続した entry は再適用される
		const ok = reconcileWith(s, [first, mk(sorted)]);
		expect(ok).toEqual({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
		expect(recordStatus(s, r2.recordId)).toBe("forgotten");
		expect(recordStatus(s, r1.recordId)).toBe("forgotten");
	});

	test("reconcile reports feedResyncRequired only when it reapplied something", () => {
		const live = open();
		const r1 = put(live, "d1");
		const snapshot = live.snapshotTo("before-forget");
		const planned = plan(live, {
			type: "record",
			recordId: r1.recordId,
			scopeKey: "scope:a",
		});
		if (planned.status !== "planned") throw new Error("unreachable");
		apply(live, planned.plan.entry);
		expect(reconcileWith(live, [planned.plan.entry])).toEqual({
			status: "ok",
			reapplied: 0,
		});
		const restored = openTestStore({ fromFile: snapshot });
		try {
			expect(reconcileWith(restored, [planned.plan.entry])).toEqual({
				status: "ok",
				reapplied: 1,
				feedResyncRequired: true,
			});
			expect(reconcileWith(restored, [planned.plan.entry])).toEqual({
				status: "ok",
				reapplied: 0,
			});
		} finally {
			restored.close();
		}
	});
});

describe("S6 surface stays a stub", () => {
	test("recordExternalDeletion and registerExternalDependents are not implemented here", () => {
		const s = open();
		expect(() => recordExternalDeletion(s.writer, {} as never)).toThrow();
		expect(() => registerExternalDependents(s.writer, {} as never)).toThrow();
	});
});
