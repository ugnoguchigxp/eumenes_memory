/**
 * 即時の除外（journal format 3）。使い捨ての実 SQLite。復旧（DB の復元と journal の再適用）を含む結合は
 * `test/scenario/forget-closure.test.ts`。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { listMemoryChanges } from "../../../infrastructure/sqlite/changes.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import {
	ACCESS,
	COFFEE,
	SCOPE,
	TEA,
	assertInput,
	makeSpan,
	value,
} from "../../state/testing.ts";
import {
	assertUserState,
	listCandidates,
	listState,
	listStateByTime,
	readCandidate,
	readStateFact,
	recordCandidate,
	searchState,
	suppressState,
} from "../../state/sqlite.ts";
import type {
	ExclusionOp,
	ExclusionTarget,
	ForgetJournalEntry,
} from "../contracts/index.ts";
import { JOURNAL_FORMAT_EXCLUSION } from "../contracts/index.ts";
import {
	applyExclusion,
	applyForget,
	getForgetReceipt,
	listExclusions,
	planExclusion,
	planForget,
} from "../repository/index.ts";
import {
	buildJournalEntry,
	isSelfConsistent,
	verifyForgetJournal,
} from "../service/journal.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(): TestStore {
	store = openTestStore();
	return store;
}

const CLOCK = { atMs: 7000 } as const;

function item(s: TestStore, extra: Record<string, unknown> = {}) {
	const result = s.write((db) => assertUserState(db, assertInput(extra)));
	if (result.status !== "applied") throw new Error("setup");
	return result.item;
}

function plan(
	s: TestStore,
	op: ExclusionOp,
	targets: readonly ExclusionTarget[],
) {
	const planned = s.read((db) =>
		planExclusion(db, {
			contractVersion: 2,
			access: ACCESS,
			op,
			targets,
			clock: CLOCK,
		}),
	);
	if (planned.status !== "planned") throw new Error("plan blocked");
	return planned.plan;
}

function exclude(
	s: TestStore,
	op: ExclusionOp,
	targets: readonly ExclusionTarget[],
	sourceRunId?: string,
) {
	const entry = plan(s, op, targets).entry;
	const receipt = s.write((db) =>
		applyExclusion(db, {
			contractVersion: 2,
			entry,
			clock: CLOCK,
			...(sourceRunId === undefined ? {} : { sourceRunId }),
		}),
	);
	return { entry, receipt };
}

const itemTarget = (itemId: string): ExclusionTarget => ({
	type: "state_item",
	itemId,
	scopeKey: SCOPE,
});

function visible(s: TestStore, extra: Record<string, unknown> = {}) {
	const result = s.read((db) =>
		listState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			includeInactive: true,
			...extra,
		}),
	);
	if (result.status !== "ok") throw new Error("blocked");
	return result.items.map((entry) => entry.itemId);
}

function found(s: TestStore, word: string) {
	const result = s.read((db) =>
		searchState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKeys: [SCOPE],
			terms: { indexed: [word], scanned: [] },
			limit: 20,
		}),
	);
	if (result.status !== "ok") throw new Error("blocked");
	return result.items.map((entry) => entry.itemId);
}

describe("planExclusion / applyExclusion", () => {
	test("an excluded item leaves list, search and the time queries at once; the fact reader still sees it", () => {
		const s = open();
		const a = item(s);
		const b = item(s, {
			semanticKey: "tea",
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
		});
		const { entry, receipt } = exclude(
			s,
			"exclude",
			[itemTarget(a.itemId)],
			"run-x",
		);
		expect(entry.journalFormat).toBe(JOURNAL_FORMAT_EXCLUSION);
		expect(entry).toMatchObject({ seq: 1, exclusionOp: "exclude" });
		expect(isSelfConsistent(entry)).toBe(true);
		expect(receipt).toMatchObject({
			forgetId: entry.forgetId,
			completed: true,
		});
		expect(visible(s)).toEqual([b.itemId]);
		expect(found(s, "コーヒー")).toEqual([]);
		expect(found(s, "紅茶が")).toEqual([b.itemId]);
		const timed = s.read((db) =>
			listStateByTime(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(
			timed.status === "ok" ? timed.items.map((i) => i.itemId) : [],
		).toEqual([b.itemId]);
		// 忘却の処理は、除外された item も明示して読める（全版の収集・根拠の収集）。
		expect(visible(s, { includeExcluded: true }).sort()).toEqual(
			[a.itemId, b.itemId].sort(),
		);
		const withMark = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				itemIds: [a.itemId],
				includeExcluded: true,
			}),
		);
		expect(withMark.status === "ok" ? withMark.items[0] : null).toMatchObject({
			itemId: a.itemId,
			excluded: true,
		});
		expect(
			s.read((db) =>
				readStateFact(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					itemId: a.itemId,
				}),
			),
		).toMatchObject({ status: "ok", itemIds: [a.itemId] });
		expect(
			s.read((db) =>
				listExclusions(db, {
					contractVersion: 2,
					access: ACCESS,
					scopeKey: SCOPE,
				}),
			),
		).toEqual({ status: "ok", targets: [itemTarget(a.itemId)] });
		// 変更フィード: item の status は変わらず、種類が `excluded`、run が残る。
		const feed = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 100,
			}),
		);
		expect((feed.status === "ok" ? feed.changes : []).at(-1)).toMatchObject({
			targetId: a.itemId,
			status: "active",
			changeKind: "excluded",
			sourceRunId: "run-x",
		});
		// 本文・semantic key は除外の表にも journal にも出ない。
		expect(JSON.stringify(entry)).not.toContain("drink");
		expect(
			JSON.stringify(s.writer.query("SELECT * FROM memory_exclusion").all()),
		).not.toContain("drink");
	});

	test("release brings it back and says so in the feed; releasing what is not excluded changes nothing", () => {
		const s = open();
		const a = item(s);
		expect(plan(s, "release", [itemTarget(a.itemId)]).affected).toBe(0);
		expect(plan(s, "exclude", [itemTarget(a.itemId)]).affected).toBe(1);
		exclude(s, "exclude", [itemTarget(a.itemId)]);
		exclude(s, "exclude", [itemTarget(a.itemId)]);
		expect(plan(s, "release", [itemTarget(a.itemId)]).affected).toBe(1);
		exclude(s, "release", [itemTarget(a.itemId)]);
		expect(visible(s)).toEqual([a.itemId]);
		expect(found(s, "コーヒー")).toEqual([a.itemId]);
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
			(feed.status === "ok" ? feed.changes : []).map((row) => row.changeKind),
		).toEqual([undefined, "excluded", "exclusion_released"]);
	});

	test("the entries chain with forget entries, and a stale or repeated entry is not applied twice", () => {
		const s = open();
		const a = item(s);
		const b = item(s, {
			semanticKey: "tea",
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
		});
		const first = exclude(s, "exclude", [itemTarget(a.itemId)]);
		const stale = plan(s, "release", [itemTarget(a.itemId)]);
		// 間に別の entry が入ると、古い plan は適用できない。
		const second = exclude(s, "exclude", [itemTarget(b.itemId)]);
		expect(second.entry.seq).toBe(stale.entry.seq);
		expect(() =>
			s.write((db) =>
				applyExclusion(db, {
					contractVersion: 2,
					entry: stale.entry,
					clock: CLOCK,
				}),
			),
		).toThrow();
		expect(visible(s)).toEqual([]);
		// 適用済みの entry の再送は何もしない（後の解除を打ち消さない）。
		const release = exclude(s, "release", [itemTarget(a.itemId)]);
		s.write((db) =>
			applyExclusion(db, {
				contractVersion: 2,
				entry: first.entry,
				clock: CLOCK,
			}),
		);
		expect(visible(s)).toEqual([a.itemId]);
		// 忘却の entry と除外の entry は同じ鎖に並ぶ。
		const chained = buildJournalEntry({
			journalFormat: 1,
			seq: 4,
			prevHash: release.entry.hash,
			principal: ACCESS.principal,
			targets: [{ type: "state_item", id: b.itemId, scopeKey: SCOPE }],
		});
		expect(
			verifyForgetJournal([first.entry, second.entry, release.entry, chained])
				.status,
		).toBe("ok");
		expect(
			getForgetReceipt(s.writer, {
				contractVersion: 2,
				access: ACCESS,
				forgetId: first.entry.forgetId,
			}),
		).toMatchObject({ status: "found", receipt: { completed: true } });
	});

	test("a tampered, mistyped or foreign exclusion entry is refused", () => {
		const s = open();
		const a = item(s);
		const { entry } = exclude(s, "exclude", [itemTarget(a.itemId)]);
		const flipped = { ...entry, exclusionOp: "release" as const };
		expect(isSelfConsistent(flipped)).toBe(false);
		expect(isSelfConsistent({ ...entry, exclusionOp: undefined })).toBe(false);
		expect(isSelfConsistent({ ...entry, hostIntent: { k: ["v"] } })).toBe(
			false,
		);
		expect(verifyForgetJournal([flipped as ForgetJournalEntry]).status).toBe(
			"inconsistent",
		);
		// record などの忘却の対象は除外できない。
		const bad = buildJournalEntry({
			journalFormat: 3,
			seq: 2,
			prevHash: entry.hash,
			principal: ACCESS.principal,
			targets: [{ type: "scope", id: SCOPE, scopeKey: SCOPE }],
			exclusionOp: "exclude",
		});
		expect(isSelfConsistent(bad)).toBe(false);
		expect(() =>
			s.write((db) =>
				applyExclusion(db, { contractVersion: 2, entry: bad, clock: CLOCK }),
			),
		).toThrow();
		// 別の principal の item は除外できない。
		const other = {
			...ACCESS,
			principal: "local:other",
		};
		expect(
			s.read((db) =>
				planExclusion(db, {
					contractVersion: 2,
					access: other,
					op: "exclude",
					targets: [itemTarget(a.itemId)],
					clock: CLOCK,
				}),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
		expect(
			s.read((db) =>
				planExclusion(db, {
					contractVersion: 2,
					access: { ...ACCESS, scopeKeys: [] },
					op: "exclude",
					targets: [itemTarget(a.itemId)],
					clock: CLOCK,
				}),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
	});

	test("a candidate can be excluded too and disappears from every candidate query", () => {
		const s = open();
		const recorded = s.write((db) =>
			recordCandidate(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 10 },
				kind: "habit",
				subject: "self",
				semanticKey: "walk",
				value: value("夜に散歩する"),
				evidence: [makeSpan(COFFEE, "コーヒーが好き")],
				sources: [COFFEE],
				conversationId: "c1",
			}),
		);
		if (recorded.status !== "recorded") throw new Error("setup");
		const target: ExclusionTarget = {
			type: "candidate",
			candidateId: recorded.candidate.candidateId,
			scopeKey: SCOPE,
		};
		exclude(s, "exclude", [target]);
		const listed = s.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(listed).toMatchObject({ status: "ok", candidates: [] });
		expect(
			s.read((db) =>
				readCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					candidateId: recorded.candidate.candidateId,
				}),
			),
		).toEqual({ status: "missing" });
		exclude(s, "release", [target]);
		expect(
			s.read((db) =>
				listCandidates(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
				}),
			),
		).toMatchObject({
			status: "ok",
			candidates: [{ candidateId: target.candidateId }],
		});
	});
});

describe("the closure deletion ends the marks", () => {
	test("forgetting an excluded and suppressed item removes both marks and leaves no key behind", () => {
		const s = open();
		const a = item(s);
		const keep = item(s, {
			semanticKey: "tea",
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
		});
		s.write((db) =>
			suppressState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: CLOCK,
				target: {
					type: "state_fact",
					subject: "self",
					kind: "preference",
					semanticKey: "drink",
				},
			}),
		);
		s.write((db) =>
			suppressState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: CLOCK,
				target: { type: "state_item", itemId: keep.itemId },
			}),
		);
		exclude(s, "exclude", [itemTarget(a.itemId), itemTarget(keep.itemId)]);
		const planned = s.read((db) =>
			planForget(db, {
				contractVersion: 2,
				access: ACCESS,
				targets: [{ type: "state_item", itemId: a.itemId, scopeKey: SCOPE }],
				clock: CLOCK,
			}),
		);
		if (planned.status !== "planned") throw new Error("plan");
		s.write((db) =>
			applyForget(db, {
				contractVersion: 2,
				entry: planned.plan.entry,
				clock: CLOCK,
			}),
		);
		const exclusions = s.writer
			.query("SELECT target_id FROM memory_exclusion")
			.all();
		expect(exclusions).toEqual([{ target_id: keep.itemId }]);
		const suppressions = s.writer
			.query("SELECT target_type, target_id FROM memory_suppression")
			.all();
		expect(suppressions).toEqual([
			{ target_type: "state_item", target_id: keep.itemId },
		]);
		expect(
			JSON.stringify(s.writer.query("SELECT * FROM memory_suppression").all()),
		).not.toContain("drink");
	});
});
