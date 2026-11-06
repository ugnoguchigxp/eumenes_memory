/**
 * Lifecycle 契約版 2: 複数 target の `planForget`、ホストの忘却意図（`hostIntent`）、journal format 2。
 * 設計: spec/improvement-design.md の A1・A2。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isMemoryContractError } from "../../../contracts/errors.ts";
import {
	GENESIS_JOURNAL_HASH,
	JOURNAL_FORMAT,
	JOURNAL_FORMAT_HOST_INTENT,
	LIMITS_LIFECYCLE,
} from "../contracts/index.ts";
import type {
	ForgetJournalEntry,
	ForgetTarget,
	HostForgetIntent,
	PlanForgetInput,
} from "../contracts/index.ts";
import {
	buildJournalEntry,
	computeForgetId,
	isSelfConsistent,
	verifyForgetJournal,
} from "../service/journal.ts";
import {
	applyForget,
	planForget,
	reconcileForgetJournal,
} from "../repository/index.ts";
import {
	assertUserState,
	listState,
	readStateFact,
} from "../../state/sqlite.ts";
import {
	ACCESS,
	OTHER_SCOPE,
	SCOPE,
	assertInput,
} from "../../state/testing.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

const stores: TestStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});
function open(fromFile?: string): TestStore {
	const s = openTestStore(fromFile === undefined ? {} : { fromFile });
	stores.push(s);
	return s;
}

const CLOCK = { atMs: 2000 } as const;
const INTENT: HostForgetIntent = {
	messageIds: ["m:2", "m:1", "m:2"],
	conversationId: ["c1"],
	empty: [],
};
const CANONICAL_INTENT = {
	conversationId: ["c1"],
	messageIds: ["m:1", "m:2"],
};

function item(s: TestStore, semanticKey: string): string {
	const result = s.write((db) =>
		assertUserState(db, assertInput({ semanticKey })),
	);
	if (result.status !== "applied") throw new Error(result.status);
	return result.item.itemId;
}

function stateTarget(itemId: string, scopeKey = SCOPE): ForgetTarget {
	return { type: "state_item", itemId, scopeKey };
}

function plan(s: TestStore, input: Omit<PlanForgetInput, "access" | "clock">) {
	const result = s.read((db) =>
		planForget(db, { access: ACCESS, clock: CLOCK, ...input }),
	);
	if (result.status !== "planned") throw new Error(result.reasonCode);
	return result.plan.entry;
}

function apply(s: TestStore, entry: ForgetJournalEntry) {
	return s.write((db) =>
		applyForget(db, { contractVersion: 2, entry, clock: CLOCK }),
	);
}

function reconcile(s: TestStore, entries: readonly ForgetJournalEntry[]) {
	return s.write((db) =>
		reconcileForgetJournal(db, { contractVersion: 2, entries, clock: CLOCK }),
	);
}

function factStatus(s: TestStore, itemId: string): string {
	return s.read(
		(db) =>
			readStateFact(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				itemId,
			}).status,
	);
}

/** ジャーナルの JSON 行として書いて読み戻した形（ホストが実際に渡す値）。 */
function viaJson(entry: ForgetJournalEntry): ForgetJournalEntry {
	return JSON.parse(JSON.stringify(entry)) as ForgetJournalEntry;
}

function contractCode(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isMemoryContractError(error)) return error.code;
		throw error;
	}
	throw new Error("expected a contract error");
}

describe("journal format 2 (pure)", () => {
	const targets = [{ type: "state_item", id: "i1", scopeKey: SCOPE }] as const;

	test("hostIntent is canonicalized and covered by the hash; forgetId is the format-1 rule", () => {
		const entry = buildJournalEntry({
			journalFormat: JOURNAL_FORMAT_HOST_INTENT,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets,
			hostIntent: INTENT,
		});
		expect(entry.journalFormat).toBe(2);
		expect({ ...entry.hostIntent }).toEqual(CANONICAL_INTENT);
		expect(entry.forgetId).toBe(computeForgetId("local:owner", 1, targets));
		expect(isSelfConsistent(viaJson(entry))).toBe(true);
		const other = buildJournalEntry({
			journalFormat: JOURNAL_FORMAT_HOST_INTENT,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets,
			hostIntent: { messageIds: ["m:1"] },
		});
		expect(other.hash).not.toBe(entry.hash);
		expect(other.forgetId).toBe(entry.forgetId);
	});

	test("a format-2 entry without hostIntent hashes like format 1 except for the format number", () => {
		const one = buildJournalEntry({
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets,
		});
		const two = buildJournalEntry({
			journalFormat: JOURNAL_FORMAT_HOST_INTENT,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets,
			hostIntent: { empty: [] },
		});
		expect(one.journalFormat).toBe(JOURNAL_FORMAT);
		expect(Object.hasOwn(two, "hostIntent")).toBe(false);
		expect(two.hash).not.toBe(one.hash);
		expect(isSelfConsistent(two)).toBe(true);
		expect(() =>
			buildJournalEntry({
				seq: 1,
				prevHash: GENESIS_JOURNAL_HASH,
				principal: "local:owner",
				targets,
				hostIntent: { messageIds: ["m:1"] },
			}),
		).toThrow(TypeError);
	});

	test("tampered, non-canonical or misplaced hostIntent breaks self-consistency", () => {
		const entry = viaJson(
			buildJournalEntry({
				journalFormat: JOURNAL_FORMAT_HOST_INTENT,
				seq: 1,
				prevHash: GENESIS_JOURNAL_HASH,
				principal: "local:owner",
				targets: [],
				hostIntent: INTENT,
			}),
		);
		expect(isSelfConsistent(entry)).toBe(true);
		const tampered = {
			...entry,
			hostIntent: { ...CANONICAL_INTENT, messageIds: ["m:1"] },
		};
		expect(isSelfConsistent(tampered)).toBe(false);
		const unsorted = {
			...entry,
			hostIntent: { ...CANONICAL_INTENT, messageIds: ["m:2", "m:1"] },
		};
		expect(isSelfConsistent(unsorted)).toBe(false);
		const { hostIntent: _dropped, ...withoutIntent } = entry;
		expect(isSelfConsistent(withoutIntent)).toBe(false);
		const format1 = viaJson(
			buildJournalEntry({
				seq: 1,
				prevHash: GENESIS_JOURNAL_HASH,
				principal: "local:owner",
				targets,
			}),
		);
		// format 1 の hash は hostIntent を覆わないので、format 1 の entry に足された hostIntent は受けない。
		expect(isSelfConsistent({ ...format1, hostIntent: CANONICAL_INTENT })).toBe(
			false,
		);
		expect(isSelfConsistent({ ...format1, note: "x" })).toBe(false);
		expect(isSelfConsistent({ ...entry, journalFormat: 3 })).toBe(false);
	});

	test("hostIntent limits are enforced by the verifier", () => {
		const make = (hostIntent: Record<string, readonly string[]>) => {
			const entry = buildJournalEntry({
				journalFormat: JOURNAL_FORMAT_HOST_INTENT,
				seq: 1,
				prevHash: GENESIS_JOURNAL_HASH,
				principal: "local:owner",
				targets,
				hostIntent,
			});
			return isSelfConsistent(viaJson(entry));
		};
		const keys = (n: number) =>
			Object.fromEntries(
				Array.from({ length: n }, (_, i) => [
					`k${String(i).padStart(2, "0")}`,
					["x"],
				]),
			);
		expect(make(keys(LIMITS_LIFECYCLE.maxHostIntentKeys))).toBe(true);
		expect(make(keys(LIMITS_LIFECYCLE.maxHostIntentKeys + 1))).toBe(false);
		const ids = (n: number) =>
			Array.from({ length: n }, (_, i) => `id-${String(i).padStart(5, "0")}`);
		expect(make({ a: ids(LIMITS_LIFECYCLE.maxHostIntentIds) })).toBe(true);
		expect(make({ a: ids(LIMITS_LIFECYCLE.maxHostIntentIds + 1) })).toBe(false);
		expect(
			make({ a: ["x".repeat(LIMITS_LIFECYCLE.maxHostIntentIdBytes)] }),
		).toBe(true);
		expect(
			make({ a: ["x".repeat(LIMITS_LIFECYCLE.maxHostIntentIdBytes + 1)] }),
		).toBe(false);
		expect(make({ a: ["line\nbreak"] })).toBe(false);
		expect(
			make({ ["k".repeat(LIMITS_LIFECYCLE.maxHostIntentKeyBytes + 1)]: ["x"] }),
		).toBe(false);
	});

	test("a chain may mix format 1 and format 2; a hostIntent change anywhere breaks it", () => {
		const first = buildJournalEntry({
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets,
		});
		const second = buildJournalEntry({
			journalFormat: JOURNAL_FORMAT_HOST_INTENT,
			seq: 2,
			prevHash: first.hash,
			principal: "local:owner",
			targets: [],
			hostIntent: INTENT,
		});
		const third = buildJournalEntry({
			seq: 3,
			prevHash: second.hash,
			principal: "local:owner",
			targets: [{ type: "state_item", id: "i2", scopeKey: SCOPE }],
		});
		const chain = [first, second, third].map(viaJson);
		expect(verifyForgetJournal(chain)).toEqual({
			status: "ok",
			head: { seq: 3, hash: third.hash },
		});
		const broken = [
			chain[0] as ForgetJournalEntry,
			{
				...(chain[1] as ForgetJournalEntry),
				hostIntent: { messageIds: ["m:9"] },
			},
			chain[2] as ForgetJournalEntry,
		];
		expect(verifyForgetJournal(broken)).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
	});
});

describe("planForget contract version 2", () => {
	test("several targets of one scope become one sorted format-2 entry", () => {
		const s = open();
		const a = item(s, "drink");
		const b = item(s, "food");
		const entry = plan(s, {
			contractVersion: 2,
			targets: [stateTarget(b), stateTarget(a), stateTarget(b)],
			hostIntent: INTENT,
		});
		expect(entry.journalFormat).toBe(2);
		expect(entry.targets.map((t) => t.id)).toEqual([a, b].sort());
		expect({ ...entry.hostIntent }).toEqual(CANONICAL_INTENT);
		const receipt = apply(s, viaJson(entry));
		expect(receipt.completed).toBe(true);
		expect(factStatus(s, a)).toBe("forgotten");
		expect(factStatus(s, b)).toBe("forgotten");
	});

	test("one multi-target entry forgets the same rows as single-target entries applied in turn", () => {
		const together = open();
		const apart = open();
		const ids = ["drink", "food", "music"].map((key) => [
			item(together, key),
			item(apart, key),
		]);
		for (const [left, right] of ids) expect(left).toBe(right as string);
		apply(
			together,
			plan(together, {
				contractVersion: 2,
				targets: ids.map(([id]) => stateTarget(id as string)),
			}),
		);
		for (const [, id] of ids) {
			apply(
				apart,
				plan(apart, { contractVersion: 1, target: stateTarget(id as string) }),
			);
		}
		const rows = (s: TestStore) =>
			s.read((db) =>
				db
					.query(
						`SELECT item_id, status, value_text, semantic_key FROM memory_state_item ORDER BY item_id`,
					)
					.all(),
			);
		expect(rows(together)).toEqual(rows(apart));
		const tombstones = (s: TestStore) =>
			s.read((db) =>
				db
					.query(
						`SELECT target_type, target_id FROM memory_tombstone ORDER BY target_type, target_id`,
					)
					.all(),
			);
		expect(tombstones(together)).toEqual(tombstones(apart));
	});

	test("a hostIntent-only entry advances the journal without touching State", () => {
		const s = open();
		const kept = item(s, "drink");
		const entry = plan(s, { contractVersion: 2, hostIntent: INTENT });
		expect(entry.targets).toEqual([]);
		const receipt = apply(s, viaJson(entry));
		expect(receipt).toMatchObject({ local: "applied", completed: true });
		expect(factStatus(s, kept)).toBe("ok");
		const next = plan(s, { contractVersion: 2, targets: [stateTarget(kept)] });
		expect(next.seq).toBe(2);
		expect(next.prevHash).toBe(entry.hash);
	});

	test("version 1 keeps producing format 1 and rejects the version-2 fields", () => {
		const s = open();
		const a = item(s, "drink");
		expect(
			plan(s, { contractVersion: 1, target: stateTarget(a) }).journalFormat,
		).toBe(1);
		const base = { access: ACCESS, clock: CLOCK };
		expect(
			contractCode(() =>
				s.read((db) =>
					planForget(db, {
						...base,
						contractVersion: 1,
						targets: [stateTarget(a)],
					} as never),
				),
			),
		).toBe("UNKNOWN_KEY");
		expect(
			contractCode(() =>
				s.read((db) =>
					planForget(db, {
						...base,
						contractVersion: 1,
						target: stateTarget(a),
						hostIntent: INTENT,
					} as never),
				),
			),
		).toBe("UNKNOWN_KEY");
		expect(
			contractCode(() =>
				s.read((db) =>
					planForget(db, {
						...base,
						contractVersion: 3,
						target: stateTarget(a),
					} as never),
				),
			),
		).toBe("UNSUPPORTED_SCHEMA_VERSION");
	});

	test("malformed version-2 inputs are contract errors", () => {
		const s = open();
		const a = item(s, "drink");
		// scope の混在は入力の検査で拒否するので、DB に無い ID でよい。
		const b = `state:${"0".repeat(64)}`;
		const run = (input: Record<string, unknown>) =>
			contractCode(() =>
				s.read((db) =>
					planForget(db, {
						contractVersion: 2,
						access: ACCESS,
						clock: CLOCK,
						...input,
					} as never),
				),
			);
		expect(
			run({ targets: [stateTarget(a), stateTarget(b, OTHER_SCOPE)] }),
		).toBe("INVALID_VALUE");
		expect(run({ target: stateTarget(a), targets: [stateTarget(a)] })).toBe(
			"INVALID_VALUE",
		);
		expect(run({ targets: [] })).toBe("INVALID_VALUE");
		expect(run({})).toBe("INVALID_VALUE");
		expect(run({ hostIntent: { empty: [] } })).toBe("INVALID_VALUE");
		expect(
			run({
				targets: Array.from(
					{ length: LIMITS_LIFECYCLE.maxJournalTargets + 1 },
					(_, i) => stateTarget(`state:${String(i).padStart(64, "0")}`),
				),
			}),
		).toBe("ARRAY_TOO_LONG");
		expect(run({ hostIntent: { a: [""] } })).toBe("EMPTY_STRING");
		expect(run({ hostIntent: { a: "m:1" } })).toBe("INVALID_TYPE");
		expect(
			run({
				hostIntent: Object.fromEntries(
					Array.from(
						{ length: LIMITS_LIFECYCLE.maxHostIntentKeys + 1 },
						(_, i) => [`k${i}`, ["x"]],
					),
				),
			}),
		).toBe("ARRAY_TOO_LONG");
	});

	test("a scope outside the access context is blocked", () => {
		const s = open();
		const a = item(s, "drink");
		const result = s.read((db) =>
			planForget(db, {
				contractVersion: 2,
				access: { ...ACCESS, scopeKeys: [OTHER_SCOPE] },
				clock: CLOCK,
				targets: [stateTarget(a)],
			}),
		);
		expect(result).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
	});
});

describe("applyForget reads the journal entry as written", () => {
	test("a non-canonical hostIntent on disk is refused even when its canonical form hashes right", () => {
		const s = open();
		const entry = viaJson(plan(s, { contractVersion: 2, hostIntent: INTENT }));
		const unsorted = {
			...entry,
			hostIntent: { ...CANONICAL_INTENT, messageIds: ["m:2", "m:1"] },
		};
		const withEmpty = {
			...entry,
			hostIntent: { ...CANONICAL_INTENT, empty: [] },
		};
		for (const bad of [unsorted, withEmpty]) {
			expect(
				contractCode(() =>
					s.write((db) =>
						applyForget(db, { contractVersion: 2, entry: bad, clock: CLOCK }),
					),
				),
			).toBe("INVALID_VALUE");
		}
		expect(apply(s, entry).completed).toBe(true);
	});
});

describe("reconcileForgetJournal returns the host intents it re-applied", () => {
	test("only entries after the restored head are returned, once", () => {
		const live = open();
		const a = item(live, "drink");
		const b = item(live, "food");
		const first = plan(live, { contractVersion: 1, target: stateTarget(a) });
		apply(live, first);
		const snapshot = live.snapshotTo("before-intent");
		const second = plan(live, {
			contractVersion: 2,
			targets: [stateTarget(b)],
			hostIntent: INTENT,
		});
		apply(live, second);
		const third = plan(live, {
			contractVersion: 2,
			hostIntent: { messageIds: ["m:3"] },
		});
		apply(live, third);
		const journal = [first, second, third].map(viaJson);
		expect(reconcile(live, journal)).toEqual({ status: "ok", reapplied: 0 });

		const restored = open(snapshot);
		expect(factStatus(restored, b)).toBe("ok");
		const result = reconcile(restored, journal);
		expect(result).toEqual({
			status: "ok",
			reapplied: 2,
			feedResyncRequired: true,
			hostIntentsToReapply: [
				{ forgetId: second.forgetId, hostIntent: CANONICAL_INTENT },
				{ forgetId: third.forgetId, hostIntent: { messageIds: ["m:3"] } },
			],
		});
		expect(factStatus(restored, b)).toBe("forgotten");
		expect(reconcile(restored, journal)).toEqual({
			status: "ok",
			reapplied: 0,
		});
	});

	test("a tampered or truncated hostIntent entry makes the journal inconsistent", () => {
		const live = open();
		const a = item(live, "drink");
		const first = plan(live, {
			contractVersion: 2,
			targets: [stateTarget(a)],
			hostIntent: INTENT,
		});
		apply(live, first);
		const second = plan(live, {
			contractVersion: 2,
			hostIntent: { messageIds: ["m:3"] },
		});
		apply(live, second);
		const journal = [first, second].map(viaJson);
		const tampered = [
			journal[0] as ForgetJournalEntry,
			{
				...(journal[1] as ForgetJournalEntry),
				hostIntent: { messageIds: ["m:4"] },
			},
		];
		expect(reconcile(live, tampered)).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		});
		expect(reconcile(live, journal.slice(0, 1))).toEqual({
			status: "inconsistent",
			reasonCode: "JOURNAL_TRUNCATED",
		});
	});

	test("listState stays scoped after a hostIntent-only re-application", () => {
		const live = open();
		const kept = item(live, "drink");
		const snapshot = live.snapshotTo("before");
		const entry = plan(live, { contractVersion: 2, hostIntent: INTENT });
		apply(live, entry);
		const restored = open(snapshot);
		const result = reconcile(restored, [viaJson(entry)]);
		expect(result).toMatchObject({ status: "ok", reapplied: 1 });
		const listed = restored.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		if (listed.status !== "ok") throw new Error(listed.status);
		expect(listed.items.map((i) => i.itemId)).toEqual([kept]);
	});
});
