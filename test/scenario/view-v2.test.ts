/**
 * View v2 の結合シナリオ（S4）: 使い捨ての実 SQLite（ファイル + WAL）で
 * Records と State を作り、`readMemorySnapshotPart` + `recordSourceStates` + 検索 → `composeSnapshotV2` →
 * `buildMemoryViewV2` → 忘却 → `validateMemoryViewV2`。DB を読むのはこのテスト（ホスト役）で、build / validate は純粋。
 * 公開面（"eumenes-memory" / "eumenes-memory/sqlite"）だけを使う。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	assertUserState,
	deactivateState,
	readMemorySnapshotPart,
	recordSourceStates,
	retractState,
	searchRecords,
} from "eumenes-memory/sqlite";
import type { MemoryDb } from "eumenes-memory/sqlite";
import {
	buildMemoryViewV2,
	composeSnapshotV2,
	validateMemoryViewV2,
} from "eumenes-memory";
import type {
	AccessContext,
	BuildMemoryViewInputV2,
	EvidenceSpan,
	HostSourceState,
	MemoryViewV2,
	ReadyMemoryViewV2,
	RecallHit,
	SnapshotV2,
} from "eumenes-memory";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";
import {
	accessFor,
	capture,
	forgetRecord,
	reconcile,
} from "../runners/records-support.ts";
import type { Captured } from "../runners/records-support.ts";

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function open(): TestStore {
	const store = openTestStore();
	stores.push(store);
	return store;
}

const SCOPE = "scope:a";
const OWNER = "local:owner";
const COFFEE = "私はコーヒーが好きです。毎朝一杯だけ飲みます。";
const TEA = "Tea is fine too. 紅茶も好き。コーヒーほどではない。";
const RUN = "朝は走らない。体が重いから。";

const ACCESS: AccessContext = {
	principal: OWNER,
	scopeKeys: [SCOPE],
	purpose: "dialogue.generate",
	policyRevision: "1",
};

function hostSource(
	record: Captured,
	content: string,
	ordinal: number,
): HostSourceState {
	return {
		namespace: record.ref.namespace,
		kind: record.ref.kind,
		id: record.ref.id,
		...(record.ref.representation === undefined
			? {}
			: { representation: record.ref.representation }),
		revision: record.revision,
		digest: record.digest,
		principal: OWNER,
		scopeKey: SCOPE,
		status: "available",
		content,
		ordinal,
	};
}

function span(record: Captured, content: string, quote: string): EvidenceSpan {
	const index = content.indexOf(quote);
	const start = Buffer.byteLength(content.slice(0, index), "utf8");
	return {
		source: {
			...record.ref,
			range: {
				startByte: start,
				endByte: start + Buffer.byteLength(quote, "utf8"),
			},
		},
		quote,
	};
}

interface World {
	readonly store: TestStore;
	readonly coffee: Captured;
	readonly tea: Captured;
	readonly run: Captured;
}

/** Records 3 件 + State 2 件（preference は coffee の記録、habit の否定は run の記録）。 */
function seed(): World {
	const store = open();
	const coffee = capture(store, { origin: "coffee", content: COFFEE });
	const tea = capture(store, { origin: "tea", content: TEA });
	const run = capture(store, { origin: "run", content: RUN });
	const assert = (
		record: Captured,
		content: string,
		kind: "preference" | "habit",
		semanticKey: string,
		text: string,
		polarity: "affirmed" | "negated",
		quote: string,
		ordinal: number,
	) =>
		store.write((db) =>
			assertUserState(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKey: SCOPE,
				clock: { atMs: 10 },
				kind,
				subject: "self",
				semanticKey,
				value: { text, polarity },
				evidence: [span(record, content, quote)],
				sources: [hostSource(record, content, ordinal)],
				origin: "user_confirmed",
			}),
		);
	const first = assert(
		coffee,
		COFFEE,
		"preference",
		"drink",
		"コーヒーが好き",
		"affirmed",
		"コーヒーが好き",
		1,
	);
	const second = assert(
		run,
		RUN,
		"habit",
		"morning",
		"朝は走る",
		"negated",
		"朝は走らない",
		2,
	);
	const third = store.write((db) =>
		assertUserState(db, {
			contractVersion: 1,
			access: accessFor(),
			scopeKey: SCOPE,
			clock: { atMs: 11 },
			kind: "other_person_note",
			subject: "other:mother",
			semanticKey: "drink",
			value: { text: "紅茶が好き", polarity: "affirmed" },
			evidence: [span(tea, TEA, "紅茶も好き")],
			sources: [hostSource(tea, TEA, 3)],
			origin: "user_confirmed",
		}),
	);
	for (const result of [first, second, third]) {
		expect(result.status).toBe("applied");
	}
	return { store, coffee, tea, run };
}

function search(db: MemoryDb, query: string): RecallHit[] {
	const result = searchRecords(db, {
		contractVersion: 1,
		access: accessFor(),
		scopeKeys: [SCOPE],
		query,
		limit: 10,
	});
	if (result.status !== "ok") throw new Error("search blocked");
	return [...result.hits];
}

/** ホスト役: 1 つの read transaction で Memory 部品・hit の出典の状態を読み、snapshot に合成する。 */
function readSnapshot(
	store: TestStore,
	hits: readonly RecallHit[],
	complete = true,
): SnapshotV2 {
	return store.read((db) => {
		const part = readMemorySnapshotPart(db, {
			contractVersion: 1,
			access: accessFor(),
			scopeKey: SCOPE,
		});
		if (part.status !== "ok") throw new Error("snapshot part blocked");
		const evidenceSources = recordSourceStates(db, {
			contractVersion: 1,
			access: accessFor(),
			scopeKey: SCOPE,
			refs: hits.map((hit) => hit.ref),
		});
		return composeSnapshotV2({
			principal: OWNER,
			scopeKey: SCOPE,
			policyRevision: "1",
			complete,
			memory: part,
			evidenceSources,
		});
	});
}

function inputOf(
	snapshot: SnapshotV2,
	hits: readonly RecallHit[],
	overrides: Partial<BuildMemoryViewInputV2> = {},
): BuildMemoryViewInputV2 {
	return {
		schemaVersion: 2,
		access: ACCESS,
		snapshot,
		maxBytes: 100_000,
		enabled: true,
		evidence: { hits, maxEvidenceBytes: 4096 },
		...overrides,
	};
}

function validateAgainst(view: MemoryViewV2, snapshot: SnapshotV2) {
	return validateMemoryViewV2(view, {
		schemaVersion: 2,
		access: ACCESS,
		snapshot,
	});
}

function asReady(view: MemoryViewV2): ReadyMemoryViewV2 {
	if (view.status !== "ready") throw new Error(`not ready: ${view.status}`);
	return view;
}

describe("S4: View v2 over a real SQLite store", () => {
	test("state items + search evidence build a ready view; other-person notes stay out; the view validates", () => {
		const { store, coffee, tea } = seed();
		const hits = store.read((db) => search(db, "コーヒー"));
		expect(hits.map((hit) => hit.ref.id).sort()).toEqual(
			[coffee.recordId, tea.recordId].sort(),
		);
		const snapshot = readSnapshot(store, hits);
		const view = asReady(buildMemoryViewV2(inputOf(snapshot, hits)));

		expect(view.items.map((item) => item.kind).sort()).toEqual([
			"habit",
			"preference",
		]);
		expect(view.items.find((item) => item.kind === "habit")?.text).toBe(
			"NOT: 朝は走る",
		);
		expect(view.evidence).toHaveLength(2);
		expect(
			view.evidence.every((entry) => entry.authority === "evidence_candidate"),
		).toBe(true);
		expect(view.coverage).toEqual({ complete: true, omitted: [] });
		// 出典（state の根拠 2 件 + hit 2 件、coffee は共通）が一覧に 1 回ずつ
		const habitSource = view.items.find((item) => item.kind === "habit")
			?.primarySource.id;
		expect(view.dependencies.map((d) => d.id).sort()).toEqual(
			[coffee.recordId, tea.recordId, habitSource ?? ""].sort(),
		);
		// other_person_note（tea の記録に根拠）は state としては view に入らないが、tea は evidence として載る
		expect(view.items.some((item) => item.text.includes("紅茶"))).toBe(false);
		expect(validateAgainst(view, snapshot)).toEqual({
			schemaVersion: 2,
			status: "valid",
			viewDigest: view.viewDigest,
		});
		// 再読み込みしても同じ（同じ DB 状態 -> 同じ view）
		const again = readSnapshot(store, hits);
		expect(buildMemoryViewV2(inputOf(again, hits))).toEqual(view);
	});

	test("a state change makes the view stale (state revision first; item revision when the host revision is frozen)", () => {
		const { store, coffee } = seed();
		const hits = store.read((db) => search(db, "コーヒー"));
		const snapshot = readSnapshot(store, hits);
		const view = asReady(buildMemoryViewV2(inputOf(snapshot, hits)));
		const pref = view.items.find((item) => item.kind === "preference");
		expect(pref).toBeDefined();
		store.write((db) =>
			deactivateState(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKey: SCOPE,
				clock: { atMs: 20 },
				itemId: pref!.id,
				expectedRevision: Number(pref!.revision),
			}),
		);
		const after = readSnapshot(store, hits);
		expect(validateAgainst(view, after)).toEqual({
			schemaVersion: 2,
			status: "invalid",
			reasonCode: "STATE_REVISION_MISMATCH",
		});
		// ホストが stateRevision を据え置いても、item の集合の変化で invalid（防御の二重化）
		expect(
			validateAgainst(view, {
				...after,
				stateRevision: snapshot.stateRevision,
			}),
		).toEqual({
			schemaVersion: 2,
			status: "invalid",
			reasonCode: "ITEM_MISSING",
		});
		expect(coffee.recordId).toBeDefined();
	});

	test("retracting (tombstoning) a state item removes it from the snapshot part", () => {
		const { store } = seed();
		const hits: RecallHit[] = [];
		const snapshot = readSnapshot(store, hits);
		const view = asReady(buildMemoryViewV2(inputOf(snapshot, hits)));
		const target = view.items[0]!;
		store.write((db) =>
			retractState(db, {
				contractVersion: 1,
				access: accessFor(),
				scopeKey: SCOPE,
				clock: { atMs: 30 },
				itemId: target.id,
				expectedRevision: Number(target.revision),
			}),
		);
		const after = readSnapshot(store, hits);
		expect(after.items.some((item) => item.id === target.id)).toBe(false);
		expect(
			validateAgainst(view, {
				...after,
				stateRevision: snapshot.stateRevision,
			}),
		).toMatchObject({ status: "invalid", reasonCode: "ITEM_MISSING" });
	});

	test("forgetting an evidence record: stale hits block a new build; the old view is invalid; a fresh search drops it", () => {
		const { store, coffee, tea } = seed();
		const hits = store.read((db) => search(db, "コーヒー"));
		const snapshot = readSnapshot(store, hits);
		const view = asReady(buildMemoryViewV2(inputOf(snapshot, hits)));
		expect(view.evidence.map((entry) => entry.ref.id)).toContain(tea.recordId);

		forgetRecord(store, {
			type: "record",
			recordId: tea.recordId,
			scopeKey: SCOPE,
		});

		// (1) 古い hit のまま build すると blocked（hit の出典は forgotten）
		const stale = readSnapshot(store, hits);
		expect(stale.sources.find((s) => s.id === tea.recordId)?.status).toBe(
			"forgotten",
		);
		expect(buildMemoryViewV2(inputOf(stale, hits))).toMatchObject({
			status: "blocked",
			reasonCode: "SOURCE_FORGOTTEN",
		});
		// (2) 作成済みの view の再検証: scope の revision が進むので現実の流れでは STATE_REVISION_MISMATCH
		expect(validateAgainst(view, stale)).toMatchObject({
			status: "invalid",
			reasonCode: "STATE_REVISION_MISMATCH",
		});
		// (3) revision を据え置いても出典の検査で invalid（evidence の忘却を単独で検出する）
		expect(
			validateAgainst(view, {
				...stale,
				stateRevision: snapshot.stateRevision,
			}),
		).toEqual({
			schemaVersion: 2,
			status: "invalid",
			reasonCode: "SOURCE_FORGOTTEN",
		});
		// (4) 検索し直すと forgotten の記録は出ず、新しい view は ready で、忘れた記録を含まない
		const fresh = store.read((db) => search(db, "コーヒー"));
		expect(fresh.map((hit) => hit.ref.id)).toEqual([coffee.recordId]);
		const next = readSnapshot(store, fresh);
		const rebuilt = asReady(buildMemoryViewV2(inputOf(next, fresh)));
		expect(JSON.stringify(rebuilt)).not.toContain(tea.recordId);
		expect(JSON.stringify(rebuilt)).not.toContain("紅茶");
		expect(validateAgainst(rebuilt, next)).toMatchObject({ status: "valid" });
	});

	test("forgetting a record that a state item cites removes the item through the closure; the old view is invalid", () => {
		const { store, coffee } = seed();
		const hits: RecallHit[] = [];
		const snapshot = readSnapshot(store, hits);
		const view = asReady(buildMemoryViewV2(inputOf(snapshot, hits)));
		expect(view.items.map((item) => item.kind).sort()).toEqual([
			"habit",
			"preference",
		]);

		forgetRecord(store, {
			type: "record",
			recordId: coffee.recordId,
			scopeKey: SCOPE,
		});

		const after = readSnapshot(store, hits);
		// 閉包の墓標で、coffee を根拠にした preference は snapshot に出ない（S1 の閉包は record -> state_item の辺を辿る）
		expect(after.items.map((item) => item.kind)).toEqual(["habit"]);
		expect(validateAgainst(view, after)).toMatchObject({
			status: "invalid",
			reasonCode: "STATE_REVISION_MISMATCH",
		});
		expect(
			validateAgainst(view, {
				...after,
				stateRevision: snapshot.stateRevision,
			}),
		).toEqual({
			schemaVersion: 2,
			status: "invalid",
			reasonCode: "ITEM_MISSING",
		});
		const rebuilt = asReady(buildMemoryViewV2(inputOf(after, hits)));
		expect(rebuilt.items.map((item) => item.kind)).toEqual(["habit"]);
		expect(JSON.stringify(rebuilt)).not.toContain("コーヒー");
	});

	test("a database restored from before the forget + journal reconcile still blocks and invalidates (F03)", () => {
		const { store, tea } = seed();
		const hits = store.read((db) => search(db, "コーヒー"));
		const snapshot = readSnapshot(store, hits);
		const view = asReady(buildMemoryViewV2(inputOf(snapshot, hits)));
		const before = store.snapshotTo("before-forget");

		const { entry } = forgetRecord(store, {
			type: "record",
			recordId: tea.recordId,
			scopeKey: SCOPE,
		});

		const restored = openTestStore({ fromFile: before });
		stores.push(restored);
		// 復元直後（ジャーナルを当てる前）は古い状態: ホストは reconcile してから view を作る
		const result = reconcile(restored, [entry]);
		expect(result).toBeDefined();
		const after = readSnapshot(restored, hits);
		expect(after.sources.find((s) => s.id === tea.recordId)?.status).toBe(
			"forgotten",
		);
		expect(buildMemoryViewV2(inputOf(after, hits))).toMatchObject({
			status: "blocked",
			reasonCode: "SOURCE_FORGOTTEN",
		});
		expect(
			validateAgainst(view, {
				...after,
				stateRevision: snapshot.stateRevision,
			}),
		).toMatchObject({
			status: "invalid",
			reasonCode: "SOURCE_FORGOTTEN",
		});
	});

	test("a scope outside the access is never read: snapshot part is blocked and a view for it would need the host to stop", () => {
		const { store } = seed();
		const part = store.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: { ...ACCESS, scopeKeys: ["scope:b"] },
				scopeKey: SCOPE,
			}),
		);
		expect(part).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
	});

	test("an empty scope builds a ready empty view; disabled wins; an incomplete snapshot blocks", () => {
		const store = open();
		const snapshot = readSnapshot(store, []);
		expect(snapshot.stateRevision).toBe("c:|m:0");
		const view = asReady(buildMemoryViewV2(inputOf(snapshot, [])));
		expect(view.items).toEqual([]);
		expect(view.evidence).toEqual([]);
		expect(view.coverage).toEqual({ complete: true, omitted: [] });
		expect(validateAgainst(view, snapshot)).toMatchObject({ status: "valid" });
		expect(
			buildMemoryViewV2(inputOf(snapshot, [], { enabled: false })),
		).toMatchObject({
			status: "disabled",
			reasonCode: "MEMORY_DISABLED",
		});
		expect(
			buildMemoryViewV2(inputOf(readSnapshot(store, [], false), [])),
		).toMatchObject({
			status: "blocked",
			reasonCode: "SNAPSHOT_INCOMPLETE",
		});
	});

	test("evidence over budget is omitted and recorded, while the state items stay (required vs optional)", () => {
		const { store } = seed();
		const hits = store.read((db) => search(db, "コーヒー"));
		const snapshot = readSnapshot(store, hits);
		const tight = asReady(
			buildMemoryViewV2(
				inputOf(snapshot, hits, { evidence: { hits, maxEvidenceBytes: 0 } }),
			),
		);
		expect(tight.items).toHaveLength(2);
		expect(tight.evidence).toEqual([]);
		expect(tight.coverage).toEqual({
			complete: false,
			omitted: [{ type: "evidence", count: hits.length }],
		});
		expect(validateAgainst(tight, snapshot)).toMatchObject({ status: "valid" });
		// 必須部分が入らない予算は overflow（evidence の有無に関係なく）
		expect(
			buildMemoryViewV2(inputOf(snapshot, hits, { maxBytes: 100 })),
		).toMatchObject({ status: "overflow", reasonCode: "BUDGET_EXCEEDED" });
	});
	test("a scope with more active items than the view can hold is an overflow, not an exception (and disabled / blocked still win)", () => {
		const store = open();
		const coffee = capture(store, { origin: "coffee", content: COFFEE });
		store.write((db) => {
			for (let index = 0; index < 1001; index += 1) {
				const result = assertUserState(db, {
					contractVersion: 1,
					access: accessFor(),
					scopeKey: SCOPE,
					clock: { atMs: 10 },
					kind: "preference",
					subject: "self",
					semanticKey: `key-${index}`,
					value: { text: `好み ${index}`, polarity: "affirmed" },
					evidence: [span(coffee, COFFEE, "コーヒーが好き")],
					sources: [hostSource(coffee, COFFEE, 1)],
					origin: "user_confirmed",
				});
				if (result.status !== "applied") throw new Error("seed failed");
			}
		});
		const snapshot = readSnapshot(store, []);
		expect(snapshot.items).toHaveLength(1001);
		expect(buildMemoryViewV2(inputOf(snapshot, []))).toMatchObject({
			status: "overflow",
			reasonCode: "BUDGET_EXCEEDED",
		});
		expect(
			buildMemoryViewV2(inputOf(snapshot, [], { enabled: false })),
		).toMatchObject({ status: "disabled" });
		expect(
			buildMemoryViewV2(
				inputOf(snapshot, [], {
					access: { ...ACCESS, policyRevision: "2" },
				}),
			),
		).toMatchObject({
			status: "blocked",
			reasonCode: "POLICY_REVISION_MISMATCH",
		});
		// 件数が上限内なら通常どおり（上限の境界は LIMITS.maxItems = 1000）
		const within = { ...snapshot, items: snapshot.items.slice(0, 5) };
		expect(buildMemoryViewV2(inputOf(within, []))).toMatchObject({
			status: "ready",
		});
	});

	test("more sources than the snapshot limit is an overflow too, and a malformed input still throws", () => {
		const store = open();
		const base = readSnapshot(store, []);
		const sources = Array.from({ length: 4097 }, (_, index) => ({
			namespace: "conversation",
			kind: "message",
			id: `m${index}`,
			revision: `sha256:${"a".repeat(64)}`,
			digest: "a".repeat(64),
			principal: OWNER,
			scopeKey: SCOPE,
			status: "available" as const,
		}));
		expect(buildMemoryViewV2(inputOf({ ...base, sources }, []))).toMatchObject({
			status: "overflow",
			reasonCode: "BUDGET_EXCEEDED",
		});
		expect(() =>
			buildMemoryViewV2(
				inputOf({ ...base, sources, items: "x" } as unknown as SnapshotV2, []),
			),
		).toThrow();
	});
});
