/**
 * 記憶の候補（L1）。使い捨ての実 SQLite。忘却の閉包との結合は `test/scenario/forget-closure.test.ts`。
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
import { listState } from "../repository/index.ts";
import {
	listCandidates,
	readCandidate,
	recordCandidate,
} from "../repository/candidates.ts";
import { ACCESS, SCOPE, makeSource, makeSpan, value } from "./state-support.ts";

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

describe("listCandidates / readCandidate", () => {
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
		expect(candidates(s)).toHaveLength(2);
	});
});
