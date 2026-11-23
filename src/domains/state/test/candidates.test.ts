/**
 * 記憶の候補（L1）と昇格。使い捨ての実 SQLite。忘却の閉包との結合は `test/scenario/forget-closure.test.ts`。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { listMemoryChanges } from "../../../infrastructure/sqlite/changes.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import type {
	HostSourceState,
	InferredCandidate,
	RecordCandidateResult,
} from "../contracts/index.ts";
import { assertUserState, listState } from "../repository/index.ts";
import {
	dismissCandidate,
	listCandidates,
	promoteCandidate,
	readCandidate,
	recordCandidate,
} from "../repository/candidates.ts";
import {
	ACCESS,
	SCOPE,
	assertInput,
	makeSource,
	makeSpan,
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

const WALK_1 = makeSource("w1", "夜はよく散歩しています。", 10);
const WALK_2 = makeSource("w2", "今夜も散歩に出た。", 20);
const WALK_3 = makeSource("w3", "散歩は夜が気持ちいい。", 30);

interface Observation {
	readonly source: HostSourceState;
	readonly quote: string;
	readonly conversationId?: string;
	readonly text?: string;
	readonly semanticKey?: string;
	readonly sourceRunId?: string;
	readonly atMs?: number;
}

function observe(s: TestStore, o: Observation): RecordCandidateResult {
	return s.write((db) =>
		recordCandidate(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: o.atMs ?? 1000 },
			kind: "habit",
			subject: "self",
			semanticKey: o.semanticKey ?? "evening.walk",
			value: value(o.text ?? "夜に散歩する"),
			evidence: [makeSpan(o.source, o.quote)],
			sources: [o.source],
			...(o.conversationId === undefined
				? {}
				: { conversationId: o.conversationId }),
			...(o.sourceRunId === undefined ? {} : { sourceRunId: o.sourceRunId }),
		}),
	);
}

function recorded(result: RecordCandidateResult): InferredCandidate {
	if (result.status !== "recorded") {
		throw new Error(`expected recorded, got ${JSON.stringify(result)}`);
	}
	return result.candidate;
}

function promote(
	s: TestStore,
	candidateId: string,
	extra: Record<string, unknown> = {},
) {
	return s.write((db) =>
		promoteCandidate(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: 5000 },
			candidateId,
			sourceRunId: "deep-1",
			...extra,
		}),
	);
}

function candidates(s: TestStore, extra: Record<string, unknown> = {}) {
	const result = s.read((db) =>
		listCandidates(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			...extra,
		}),
	);
	if (result.status !== "ok") throw new Error("blocked");
	return result.candidates;
}

describe("recordCandidate", () => {
	test("creates an agent_inferred candidate with its evidence, conversation and no State item", () => {
		const s = open();
		const result = observe(s, {
			source: WALK_1,
			quote: "夜はよく散歩",
			conversationId: "c1",
		});
		expect(result).toMatchObject({
			status: "recorded",
			created: true,
			newObservations: 1,
		});
		const candidate = recorded(result);
		expect(candidate).toMatchObject({
			scopeKey: SCOPE,
			status: "open",
			kind: "habit",
			subject: "self",
			semanticKey: "evening.walk",
			value: { text: "夜に散歩する", polarity: "affirmed" },
			origin: "agent_inferred",
			observationCount: 1,
			conversationIds: ["c1"],
			firstObservedMs: 1000,
			lastObservedMs: 1000,
		});
		expect(candidate.candidateId).toMatch(/^cand:[0-9a-f]{64}$/);
		expect(candidate.evidence).toHaveLength(1);
		expect(candidate.evidence[0]).toMatchObject({ id: "w1" });
		expect(
			s.read((db) =>
				listState(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					includeInactive: true,
				}),
			),
		).toMatchObject({ status: "ok", items: [] });
		// 候補は変更フィードに出ない（睡眠の層の入力）。
		expect(
			s.read((db) =>
				listMemoryChanges(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKeys: [SCOPE],
					afterSeq: 0,
					limit: 100,
				}),
			),
		).toMatchObject({ status: "ok", changes: [] });
	});

	test("re-sending the same evidence does not count again; a new source in a new conversation does", () => {
		const s = open();
		const first = recorded(
			observe(s, {
				source: WALK_1,
				quote: "夜はよく散歩",
				conversationId: "c1",
			}),
		);
		const again = observe(s, {
			source: WALK_1,
			quote: "夜はよく散歩",
			conversationId: "c1",
			atMs: 2000,
		});
		expect(again).toMatchObject({
			status: "recorded",
			created: false,
			newObservations: 0,
		});
		expect(recorded(again)).toMatchObject({
			candidateId: first.candidateId,
			observationCount: 1,
		});
		const second = observe(s, {
			source: WALK_2,
			quote: "散歩に出た",
			conversationId: "c2",
			atMs: 3000,
		});
		expect(recorded(second)).toMatchObject({
			candidateId: first.candidateId,
			observationCount: 2,
			conversationIds: ["c1", "c2"],
			firstObservedMs: 1000,
			lastObservedMs: 3000,
		});
		// 同じ会話の別の発言は観測の回数を増やすが、会話は増えない。
		const third = observe(s, {
			source: WALK_3,
			quote: "散歩は夜",
			conversationId: "c2",
			atMs: 4000,
		});
		expect(recorded(third)).toMatchObject({
			observationCount: 3,
			conversationIds: ["c1", "c2"],
		});
		expect(candidates(s)).toHaveLength(1);
	});

	test("a different value, key or polarity is a different candidate", () => {
		const s = open();
		const a = recorded(
			observe(s, {
				source: WALK_1,
				quote: "夜はよく散歩",
				conversationId: "c1",
			}),
		);
		const b = recorded(
			observe(s, {
				source: WALK_2,
				quote: "散歩に出た",
				conversationId: "c2",
				text: "朝に散歩する",
			}),
		);
		expect(b.candidateId).not.toBe(a.candidateId);
		expect(candidates(s)).toHaveLength(2);
	});

	test("rejects a quote that is not in the source, a missing source, a subject/kind mismatch and attributes", () => {
		const s = open();
		expect(
			s.write((db) =>
				recordCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 1 },
					kind: "habit",
					subject: "self",
					semanticKey: "k",
					value: value("x"),
					evidence: [{ ...makeSpan(WALK_1, "夜はよく散歩"), quote: "朝" }],
					sources: [WALK_1],
				}),
			),
		).toEqual({ status: "rejected", reasonCode: "QUOTE_MISMATCH" });
		expect(
			s.write((db) =>
				recordCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 1 },
					kind: "habit",
					subject: "self",
					semanticKey: "k",
					value: value("x"),
					evidence: [makeSpan(WALK_1, "夜はよく散歩")],
					sources: [],
				}),
			),
		).toEqual({ status: "rejected", reasonCode: "EVIDENCE_NOT_IN_INPUT" });
		expect(
			s.write((db) =>
				recordCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 1 },
					kind: "other_person_note",
					subject: "self",
					semanticKey: "k",
					value: value("x"),
					evidence: [makeSpan(WALK_1, "夜はよく散歩")],
					sources: [WALK_1],
				}),
			),
		).toEqual({ status: "rejected", reasonCode: "SUBJECT_KIND_MISMATCH" });
		expect(() =>
			s.write((db) =>
				recordCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 1 },
					kind: "habit",
					subject: "self",
					semanticKey: "k",
					value: value("x", "affirmed", { a: "b" }),
					evidence: [makeSpan(WALK_1, "夜はよく散歩")],
					sources: [WALK_1],
				}),
			),
		).toThrow();
		expect(candidates(s)).toEqual([]);
	});
});

describe("listCandidates / readCandidate / dismissCandidate", () => {
	test("filters by observations, status and kind, and pages", () => {
		const s = open();
		const a = recorded(
			observe(s, {
				source: WALK_1,
				quote: "夜はよく散歩",
				conversationId: "c1",
			}),
		);
		observe(s, { source: WALK_2, quote: "散歩に出た", conversationId: "c2" });
		recorded(
			observe(s, {
				source: WALK_3,
				quote: "散歩は夜",
				conversationId: "c3",
				text: "夜は静かな所が好き",
				semanticKey: "quiet",
			}),
		);
		expect(candidates(s)).toHaveLength(2);
		expect(
			candidates(s, { minObservations: 2 }).map((c) => c.candidateId),
		).toEqual([a.candidateId]);
		expect(candidates(s, { kinds: ["preference"] })).toEqual([]);
		const page = s.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				limit: 1,
			}),
		);
		expect(page).toMatchObject({ status: "ok" });
		expect(page.status === "ok" ? page.nextCursor : undefined).toBeDefined();
		expect(
			s.read((db) =>
				readCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					candidateId: a.candidateId,
				}),
			),
		).toMatchObject({
			status: "ok",
			candidate: { candidateId: a.candidateId },
		});
		expect(
			s.read((db) =>
				readCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					candidateId: "cand:none",
				}),
			),
		).toEqual({ status: "missing" });
		const dismiss = () =>
			s.write((db) =>
				dismissCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 9 },
					candidateId: a.candidateId,
				}),
			);
		expect(dismiss()).toMatchObject({
			status: "applied",
			candidate: { status: "dismissed" },
		});
		expect(dismiss()).toMatchObject({ status: "unchanged" });
		expect(candidates(s)).toHaveLength(1);
		expect(candidates(s, { status: "dismissed" })).toHaveLength(1);
	});
});

describe("promoteCandidate", () => {
	function threeObservations(s: TestStore): InferredCandidate {
		observe(s, { source: WALK_1, quote: "夜はよく散歩", conversationId: "c1" });
		observe(s, { source: WALK_2, quote: "散歩に出た", conversationId: "c2" });
		return recorded(
			observe(s, { source: WALK_3, quote: "散歩は夜", conversationId: "c2" }),
		);
	}
	function items(s: TestStore) {
		const result = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: true,
			}),
		);
		if (result.status !== "ok") throw new Error("blocked");
		return result.items;
	}

	test("a candidate seen in several conversations becomes an agent_inferred item that keeps every evidence", () => {
		const s = open();
		const candidate = threeObservations(s);
		const result = promote(s, candidate.candidateId, { minConversations: 2 });
		expect(result).toMatchObject({
			status: "promoted",
			item: {
				kind: "habit",
				semanticKey: "evening.walk",
				status: "active",
				origin: "agent_inferred",
				value: { text: "夜に散歩する", polarity: "affirmed" },
			},
			candidate: { status: "promoted" },
		});
		if (result.status !== "promoted") throw new Error("not promoted");
		expect(result.item.evidence.map((ref) => ref.id)).toEqual([
			"w1",
			"w2",
			"w3",
		]);
		expect(result.candidate.promotedItemId).toBe(result.item.itemId);
		// 昇格した item は変更フィードで `promoted` と分かり、run が残る。
		const feed = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 100,
			}),
		);
		expect(feed.status === "ok" ? feed.changes : []).toMatchObject([
			{
				targetId: result.item.itemId,
				status: "active",
				changeKind: "promoted",
				sourceRunId: "deep-1",
			},
		]);
		// 候補は open の一覧から外れ、もう一度は昇格できない。
		expect(candidates(s)).toEqual([]);
		expect(promote(s, candidate.candidateId)).toEqual({
			status: "rejected",
			reasonCode: "CANDIDATE_NOT_OPEN",
		});
		expect(items(s)).toHaveLength(1);
	});

	test("refuses a candidate seen in too few conversations, or without a run id", () => {
		const s = open();
		observe(s, { source: WALK_1, quote: "夜はよく散歩", conversationId: "c1" });
		const only = recorded(
			observe(s, { source: WALK_2, quote: "散歩に出た", conversationId: "c1" }),
		);
		expect(only.observationCount).toBe(2);
		expect(promote(s, only.candidateId)).toEqual({
			status: "rejected",
			reasonCode: "NOT_ENOUGH_CONVERSATIONS",
		});
		expect(promote(s, only.candidateId, { minConversations: 1 })).toMatchObject(
			{ status: "promoted" },
		);
		expect(() =>
			s.write((db) =>
				promoteCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 1 },
					candidateId: only.candidateId,
				} as never),
			),
		).toThrow();
		expect(items(s)).toHaveLength(1);
	});

	test("a user-confirmed item with another value is never overwritten by an inference", () => {
		const s = open();
		const mine = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					kind: "habit",
					semanticKey: "evening.walk",
					value: value("夜は走る"),
					evidence: [makeSpan(WALK_1, "夜はよく散歩")],
					sources: [WALK_1],
				}),
			),
		);
		if (mine.status !== "applied") throw new Error("setup");
		const candidate = threeObservations(s);
		expect(promote(s, candidate.candidateId)).toEqual({
			status: "rejected",
			reasonCode: "ACTIVE_EXISTS",
		});
		expect(
			promote(s, candidate.candidateId, {
				replaces: { itemId: mine.item.itemId, revision: mine.item.revision },
			}),
		).toEqual({ status: "rejected", reasonCode: "USER_TEXT_PROTECTED" });
		expect(items(s)).toHaveLength(1);
		expect(candidates(s)).toHaveLength(1);
	});

	test("an inferred item with another value is replaced; with the same value it only gains the evidence", () => {
		const s = open();
		const old = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					origin: "agent_inferred",
					kind: "habit",
					semanticKey: "evening.walk",
					value: value("朝に散歩する"),
					evidence: [makeSpan(WALK_1, "夜はよく散歩")],
					sources: [WALK_1],
				}),
			),
		);
		if (old.status !== "applied") throw new Error("setup");
		const candidate = threeObservations(s);
		const replaced = promote(s, candidate.candidateId, {
			replaces: { itemId: old.item.itemId, revision: old.item.revision },
			change: "consolidation",
		});
		expect(replaced).toMatchObject({
			status: "promoted",
			item: { value: { text: "夜に散歩する" } },
		});
		const feed = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 100,
			}),
		);
		expect(
			(feed.status === "ok" ? feed.changes : []).find(
				(row) =>
					row.targetId === old.item.itemId && row.status === "superseded",
			),
		).toMatchObject({ changeKind: "consolidation", sourceRunId: "deep-1" });

		// 同じ値の active があるとき: item は変えず、根拠だけ足す。
		const s2 = open2();
		const existing = s2.write((db) =>
			assertUserState(
				db,
				assertInput({
					origin: "agent_inferred",
					kind: "habit",
					semanticKey: "evening.walk",
					value: value("夜に散歩する"),
					evidence: [makeSpan(WALK_1, "夜はよく散歩")],
					sources: [WALK_1],
				}),
			),
		);
		if (existing.status !== "applied") throw new Error("setup");
		const cand2 = threeObservations(s2);
		const unchanged = promote(s2, cand2.candidateId);
		expect(unchanged).toMatchObject({
			status: "unchanged",
			item: { itemId: existing.item.itemId, revision: 1 },
			candidate: { status: "promoted", promotedItemId: existing.item.itemId },
		});
		if (unchanged.status !== "unchanged") throw new Error("setup");
		expect(unchanged.item.evidence.map((ref) => ref.id)).toEqual([
			"w1",
			"w2",
			"w3",
		]);
	});
});

let second: TestStore | undefined;
function open2(): TestStore {
	second?.close();
	second = openTestStore();
	return second;
}
afterEach(() => {
	second?.close();
	second = undefined;
});
