/**
 * 記憶の作り直しの部品（State 側）: sourceRunId と変更の種類、時間軸の照会、抑制、強度、根拠必須の検査。
 * 使い捨ての実 SQLite。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { listMemoryChanges } from "../../../infrastructure/sqlite/changes.ts";
import { hasMemoryChangesExcludingRun } from "../../../infrastructure/sqlite/changes.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import type { StateItem, StateWriteResult } from "../contracts/index.ts";
import {
	assertUserState,
	listState,
	retractState,
	searchState,
} from "../repository/index.ts";
import {
	decayStateStrength,
	listStateByTime,
	listSuppressions,
	reinforceStateStrength,
	releaseStateSuppression,
	suppressState,
} from "../repository/marks.ts";
import { checkGroundedClaim } from "../service/grounded.ts";
import {
	ACCESS,
	COFFEE,
	SCOPE,
	TEA,
	assertInput,
	makeSource,
	makeSpan,
	targetInput,
	value,
} from "./state-support.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(): TestStore {
	store = openTestStore();
	return store;
}

function applied(result: StateWriteResult): StateItem {
	if (result.status !== "applied") {
		throw new Error(`expected applied, got ${JSON.stringify(result)}`);
	}
	return result.item;
}

function changes(s: TestStore) {
	const result = s.read((db) =>
		listMemoryChanges(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKeys: [SCOPE],
			afterSeq: 0,
			limit: 500,
		}),
	);
	if (result.status !== "ok") throw new Error("feed blocked");
	return result.changes;
}

function list(s: TestStore, extra: Record<string, unknown> = {}) {
	const result = s.read((db) =>
		listState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			includeInactive: true,
			...extra,
		}),
	);
	if (result.status !== "ok") throw new Error("list blocked");
	return result.items;
}

function search(
	s: TestStore,
	word: string,
	extra: Record<string, unknown> = {},
) {
	const result = s.read((db) =>
		searchState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKeys: [SCOPE],
			terms: { indexed: [word], scanned: [] },
			limit: 20,
			...extra,
		}),
	);
	if (result.status !== "ok") throw new Error(`search ${result.reasonCode}`);
	return result.items;
}

const write = (s: TestStore, extra: Record<string, unknown> = {}) =>
	applied(s.write((db) => assertUserState(db, assertInput(extra))));

describe("sourceRunId and the kind of change", () => {
	test("a write without sourceRunId behaves as before: no run, replaced rows are labelled a correction", () => {
		const s = open();
		const first = write(s);
		const second = write(s, {
			clock: { atMs: 2000 },
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
			replaces: { itemId: first.itemId, revision: first.revision },
		});
		const rows = changes(s);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ targetId: first.itemId, status: "active" });
		expect(rows[0]).not.toHaveProperty("sourceRunId");
		expect(rows[1]).toMatchObject({
			targetId: first.itemId,
			status: "superseded",
			changeKind: "correction",
			successorId: second.itemId,
		});
		expect(rows[2]).toMatchObject({
			targetId: second.itemId,
			status: "active",
		});
		expect(rows[2]).not.toHaveProperty("changeKind");
	});

	test("sourceRunId is recorded on every change of the write, and the kind of replacement is explicit", () => {
		const s = open();
		const first = write(s, { origin: "agent_inferred", sourceRunId: "run-1" });
		const second = write(s, {
			origin: "agent_inferred",
			clock: { atMs: 2000 },
			value: value("コーヒーが大好き"),
			evidence: [makeSpan(COFFEE, "コーヒーが好き")],
			replaces: { itemId: first.itemId, revision: first.revision },
			change: "consolidation",
			sourceRunId: "run-2",
		});
		const rows = changes(s);
		expect(rows.map((row) => row.sourceRunId)).toEqual([
			"run-1",
			"run-2",
			"run-2",
		]);
		expect(rows[1]).toMatchObject({
			status: "superseded",
			changeKind: "consolidation",
			successorId: second.itemId,
		});
		const retracted = s.write((db) =>
			retractState(
				db,
				targetInput(second.itemId, second.revision, { sourceRunId: "run-3" }),
			),
		);
		expect(retracted.status).toBe("applied");
		expect(changes(s).at(-1)).toMatchObject({
			targetId: second.itemId,
			status: "retracted",
			sourceRunId: "run-3",
		});
	});

	test("change needs replaces; a consolidation never rewrites the text of a user-confirmed item", () => {
		const s = open();
		const first = write(s);
		expect(() =>
			s.write((db) =>
				assertUserState(db, assertInput({ change: "consolidation" })),
			),
		).toThrow();
		const protectedWrite = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					origin: "agent_inferred",
					clock: { atMs: 2000 },
					value: value("コーヒーを好む"),
					replaces: { itemId: first.itemId, revision: first.revision },
					change: "consolidation",
				}),
			),
		);
		expect(protectedWrite).toEqual({
			status: "rejected",
			reasonCode: "USER_TEXT_PROTECTED",
		});
		// 同じ本文なら冪等（何も変わらない）。
		const same = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					origin: "agent_inferred",
					clock: { atMs: 2000 },
					replaces: { itemId: first.itemId, revision: first.revision },
					change: "consolidation",
				}),
			),
		);
		expect(same.status).toBe("unchanged");
		// 訂正（既定）は本人が自分の言葉で直す操作なので通る。
		const correction = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					clock: { atMs: 3000 },
					value: value("コーヒーはブラック"),
					replaces: { itemId: first.itemId, revision: first.revision },
				}),
			),
		);
		expect(correction.status).toBe("applied");
	});

	test("hasMemoryChangesExcludingRun ignores the run's own changes and counts everything else", () => {
		const s = open();
		const ask = (afterSeq: number, sourceRunId: string) =>
			s.read((db) =>
				hasMemoryChangesExcludingRun(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKeys: [SCOPE],
					afterSeq,
					sourceRunId,
				}),
			);
		expect(ask(0, "r1")).toEqual({
			status: "ok",
			changed: false,
			firstSeq: null,
			latestSeq: 0,
		});
		const own = write(s, { sourceRunId: "r1" });
		const afterOwn = ask(0, "r1");
		expect(afterOwn).toMatchObject({ status: "ok", changed: false });
		const cursor = afterOwn.status === "ok" ? afterOwn.latestSeq : 0;
		expect(cursor).toBeGreaterThan(0);
		// run を渡さなかった変更は、他の変更として数える。
		const other = write(s, {
			clock: { atMs: 2000 },
			semanticKey: "tea",
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
		});
		const foreign = ask(cursor, "r1");
		expect(foreign).toMatchObject({ status: "ok", changed: true });
		expect(foreign.status === "ok" ? foreign.firstSeq : 0).toBeGreaterThan(
			cursor,
		);
		expect(ask(0, "r2")).toMatchObject({ changed: true });
		expect(own.itemId).not.toBe(other.itemId);
		// 他の run の変更だけの場合。
		const next = ask(0, "r1");
		const latest = next.status === "ok" ? next.latestSeq : 0;
		write(s, {
			clock: { atMs: 3000 },
			semanticKey: "tea2",
			value: value("紅茶がもっと好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
			sourceRunId: "r2",
		});
		expect(ask(latest, "r2")).toMatchObject({ changed: false });
		expect(ask(latest, "r1")).toMatchObject({ changed: true });
		expect(
			s.read((db) =>
				hasMemoryChangesExcludingRun(db, {
					contractVersion: 1,
					access: { ...ACCESS, scopeKeys: [] },
					scopeKeys: [SCOPE],
					afterSeq: 0,
					sourceRunId: "r1",
				}),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
	});
});

describe("listStateByTime (valid time and recorded time)", () => {
	function twoVersions(s: TestStore) {
		const first = write(s, {
			clock: { atMs: 1000 },
			validFromMs: 100,
			validUntilMs: 200,
		});
		const second = write(s, {
			clock: { atMs: 2000 },
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
			validFromMs: 200,
			replaces: { itemId: first.itemId, revision: first.revision },
		});
		return { first, second };
	}
	function query(s: TestStore, extra: Record<string, unknown>) {
		const result = s.read((db) =>
			listStateByTime(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				...extra,
			}),
		);
		if (result.status !== "ok") throw new Error("blocked");
		return result.items;
	}

	test("history lists every version oldest first with the recorded and superseded times", () => {
		const s = open();
		const { first, second } = twoVersions(s);
		const items = query(s, {});
		expect(items.map((item) => item.itemId)).toEqual([
			first.itemId,
			second.itemId,
		]);
		expect(items[0]).toMatchObject({
			status: "superseded",
			recordedAtMs: 1000,
			supersededAtMs: 2000,
		});
		expect(items[1]).toMatchObject({
			status: "active",
			recordedAtMs: 2000,
			supersededAtMs: null,
		});
	});

	test("current keeps only what is valid now (active)", () => {
		const s = open();
		const { second } = twoVersions(s);
		expect(query(s, { current: true }).map((item) => item.itemId)).toEqual([
			second.itemId,
		]);
	});

	test("recordedAt answers 'what did we hold at that time'", () => {
		const s = open();
		const { first, second } = twoVersions(s);
		const ids = (at: number) =>
			query(s, { recordedAt: at }).map((item) => item.itemId);
		expect(ids(500)).toEqual([]);
		expect(ids(1000)).toEqual([first.itemId]);
		expect(ids(1999)).toEqual([first.itemId]);
		expect(ids(2000)).toEqual([second.itemId]);
		expect(ids(9999)).toEqual([second.itemId]);
	});

	test("validAt answers 'what was true at that time', independent of when it was recorded", () => {
		const s = open();
		const { first, second } = twoVersions(s);
		const ids = (at: number) =>
			query(s, { validAt: at }).map((item) => item.itemId);
		expect(ids(50)).toEqual([]);
		expect(ids(150)).toEqual([first.itemId]);
		expect(ids(200)).toEqual([second.itemId]);
		expect(ids(5000)).toEqual([second.itemId]);
		// 二つの軸は AND: 記録した時点が 1500 でも、真だった時点が 250 の版は（その時点では）無い。
		expect(query(s, { recordedAt: 1500, validAt: 250 })).toEqual([]);
		expect(
			query(s, { recordedAt: 1500, validAt: 150 }).map((item) => item.itemId),
		).toEqual([first.itemId]);
	});

	test("pages with a cursor, and a retraction counts as superseding", () => {
		const s = open();
		const { first, second } = twoVersions(s);
		s.write((db) =>
			retractState(
				db,
				targetInput(second.itemId, second.revision, { clock: { atMs: 3000 } }),
			),
		);
		const page = s.read((db) =>
			listStateByTime(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				limit: 1,
			}),
		);
		if (page.status !== "ok") throw new Error("blocked");
		expect(page.items.map((item) => item.itemId)).toEqual([first.itemId]);
		expect(page.nextCursor).toBeDefined();
		expect(query(s, { recordedAt: 2500 }).map((item) => item.itemId)).toEqual([
			second.itemId,
		]);
		expect(query(s, { recordedAt: 3000 })).toEqual([]);
	});
});

describe("suppression", () => {
	test("the record stays; list can omit it, search returns it marked, and a release undoes it", () => {
		const s = open();
		const item = write(s);
		const target = { type: "state_item" as const, itemId: item.itemId };
		const suppress = (extra: Record<string, unknown> = {}) =>
			s.write((db) =>
				suppressState(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 5000 },
					target,
					...extra,
				}),
			);
		expect(suppress({ sourceRunId: "run-s" })).toEqual({ status: "applied" });
		expect(suppress()).toEqual({ status: "unchanged" });
		expect(list(s, { suppressed: "omit" })).toEqual([]);
		expect(list(s)[0]).toMatchObject({ itemId: item.itemId, suppressed: true });
		expect(search(s, "コーヒー")[0]).toMatchObject({
			itemId: item.itemId,
			suppressed: true,
		});
		expect(changes(s).at(-1)).toMatchObject({
			targetId: item.itemId,
			changeKind: "suppressed",
			sourceRunId: "run-s",
			status: "active",
		});
		const targets = s.read((db) =>
			listSuppressions(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(targets).toEqual({ status: "ok", targets: [target] });
		const release = s.write((db) =>
			releaseStateSuppression(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 6000 },
				target,
			}),
		);
		expect(release).toEqual({ status: "applied" });
		expect(list(s, { suppressed: "omit" })).toHaveLength(1);
		expect(list(s)[0]).not.toHaveProperty("suppressed");
		expect(changes(s).at(-1)).toMatchObject({
			changeKind: "suppression_released",
		});
	});

	test("a fact suppression also covers the versions written later", () => {
		const s = open();
		const first = write(s);
		const target = {
			type: "state_fact" as const,
			subject: "self" as const,
			kind: "preference" as const,
			semanticKey: "drink",
		};
		expect(
			s.write((db) =>
				suppressState(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 5000 },
					target,
				}),
			),
		).toEqual({ status: "applied" });
		const second = write(s, {
			clock: { atMs: 6000 },
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
			replaces: { itemId: first.itemId, revision: first.revision },
		});
		expect(list(s, { suppressed: "omit", includeInactive: true })).toEqual([]);
		expect(list(s).every((item) => item.suppressed === true)).toBe(true);
		expect(list(s).map((item) => item.itemId)).toContain(second.itemId);
		// 事実が無ければ付けられない。
		expect(
			s.write((db) =>
				suppressState(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 7000 },
					target: { ...target, semanticKey: "unknown" },
				}),
			),
		).toEqual({ status: "missing" });
	});
});

describe("strength", () => {
	function twoCoffee(
		s: TestStore,
		aOrigin: "user_confirmed" | "agent_inferred",
	) {
		const a = write(s, { origin: aOrigin });
		const b = write(s, {
			origin: "agent_inferred",
			semanticKey: "beans",
			value: value("コーヒーが嫌い"),
			evidence: [makeSpan(COFFEE, "コーヒーが好き")],
		});
		return { a, b };
	}
	const decay = (s: TestStore, factor: number, floor?: number) =>
		s.write((db) =>
			decayStateStrength(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 9000 },
				factor,
				...(floor === undefined ? {} : { floor }),
			}),
		);
	const reinforce = (s: TestStore, itemIds: string[], amount: number) =>
		s.write((db) =>
			reinforceStateStrength(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 9500 },
				itemIds,
				amount,
			}),
		);

	test("decay lowers every active item a little and never below the floor; items and the feed are unchanged", () => {
		const s = open();
		const { a, b } = twoCoffee(s, "agent_inferred");
		const feedBefore = changes(s).length;
		expect(decay(s, 0.5)).toEqual({ status: "ok", updated: 2 });
		const strengths = Object.fromEntries(
			list(s).map((item) => [item.itemId, item.strength]),
		);
		expect(strengths[a.itemId]).toBe(0.5);
		expect(strengths[b.itemId]).toBe(0.5);
		for (let n = 0; n < 12; n += 1) decay(s, 0.5, 0.1);
		expect(list(s).map((item) => item.strength)).toEqual([0.1, 0.1]);
		expect(decay(s, 0.5, 0.1)).toEqual({ status: "ok", updated: 0 });
		expect(changes(s)).toHaveLength(feedBefore);
		expect(list(s)[0]).toMatchObject({ revision: 1, status: "active" });
		expect(() => decay(s, 1)).toThrow();
		expect(() => decay(s, 0)).toThrow();
	});

	test("reinforce raises used items up to 1 and ignores unknown ids", () => {
		const s = open();
		const { a, b } = twoCoffee(s, "agent_inferred");
		decay(s, 0.5);
		expect(reinforce(s, [a.itemId, "state:unknown"], 0.25)).toEqual({
			status: "ok",
			updated: 1,
		});
		const byId = () =>
			Object.fromEntries(list(s).map((item) => [item.itemId, item.strength]));
		expect(byId()[a.itemId]).toBe(0.75);
		reinforce(s, [a.itemId, b.itemId], 1);
		expect(list(s).every((item) => item.strength === undefined)).toBe(true);
	});

	test("minStrength drops weak inferred items but never user-confirmed ones; direct search is not narrowed unless asked", () => {
		const s = open();
		const { a, b } = twoCoffee(s, "user_confirmed");
		decay(s, 0.1);
		const ids = (items: readonly StateItem[]) =>
			items.map((item) => item.itemId);
		expect(ids(list(s, { minStrength: 0.2 }))).toEqual([a.itemId]);
		expect(ids(search(s, "コーヒー", { minStrength: 0.2 }))).toEqual([
			a.itemId,
		]);
		expect(ids(search(s, "コーヒー")).sort()).toEqual(
			[a.itemId, b.itemId].sort(),
		);
		expect(ids(list(s)).sort()).toEqual([a.itemId, b.itemId].sort());
	});

	test("search ranks by strength: a reinforced item comes before a weakened one", () => {
		const s = open();
		const { a, b } = twoCoffee(s, "agent_inferred");
		decay(s, 0.5);
		reinforce(s, [b.itemId], 0.5);
		expect(search(s, "コーヒー").map((item) => item.itemId)).toEqual([
			b.itemId,
			a.itemId,
		]);
		reinforce(s, [a.itemId], 0.5);
		decay(s, 0.5);
		reinforce(s, [a.itemId], 0.25);
		expect(search(s, "コーヒー")[0]?.itemId).toBe(a.itemId);
	});
});

describe("checkGroundedClaim", () => {
	const scope = { principal: ACCESS.principal, scopeKey: SCOPE };
	test("a claim with a matching quote is grounded; a missing, wrong or stale basis is refused", () => {
		const span = makeSpan(COFFEE, "コーヒーが好き");
		expect(
			checkGroundedClaim({ evidence: [span], sources: [COFFEE] }, {}, scope),
		).toEqual({ ok: true, basis: "quote" });
		expect(checkGroundedClaim({}, {}, scope)).toEqual({
			ok: false,
			reasonCode: "NO_GROUNDING",
		});
		expect(
			checkGroundedClaim(
				{ evidence: [{ ...span, quote: "紅茶が好き" }], sources: [COFFEE] },
				{},
				scope,
			),
		).toEqual({ ok: false, reasonCode: "QUOTE_MISMATCH" });
		expect(
			checkGroundedClaim({ evidence: [span], sources: [] }, {}, scope),
		).toEqual({ ok: false, reasonCode: "EVIDENCE_NOT_IN_INPUT" });
		const changed = makeSource("m1", "私はコーヒーが好きです。", 5);
		expect(
			checkGroundedClaim(
				{ evidence: [span], sources: [{ ...changed, status: "changed" }] },
				{},
				scope,
			),
		).toEqual({ ok: false, reasonCode: "SOURCE_STALE" });
	});

	test("a promotion record needs evidence and enough distinct conversations; a run id can be required", () => {
		const promotion = {
			candidateId: "cand:1",
			evidenceCount: 2,
			conversationIds: ["c1", "c1", "c2"],
		};
		expect(
			checkGroundedClaim({ promotion }, { minConversations: 2 }, scope),
		).toEqual({ ok: true, basis: "promotion" });
		expect(
			checkGroundedClaim({ promotion }, { minConversations: 3 }, scope),
		).toEqual({ ok: false, reasonCode: "NOT_ENOUGH_CONVERSATIONS" });
		expect(
			checkGroundedClaim(
				{ promotion: { ...promotion, evidenceCount: 0 } },
				{},
				scope,
			),
		).toEqual({ ok: false, reasonCode: "NO_GROUNDING" });
		expect(
			checkGroundedClaim({ promotion }, { requireRunId: true }, scope),
		).toEqual({ ok: false, reasonCode: "RUN_ID_REQUIRED" });
		expect(
			checkGroundedClaim(
				{ promotion, sourceRunId: "run-1" },
				{ requireRunId: true },
				scope,
			),
		).toEqual({ ok: true, basis: "promotion" });
	});
});
