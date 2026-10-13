import { afterEach, describe, expect, test } from "bun:test";
import { MemoryContractError } from "../../../contracts/errors.ts";
import type { StateItem, StateWriteResult } from "../contracts/index.ts";
import { sourceKey } from "../../../contracts/source-key.ts";
import {
	assertUserState,
	deactivateState,
	listState,
	reactivateState,
	readStateFact,
	retractState,
	scrubStateItem,
} from "../repository/index.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { listMemoryChanges } from "../../../infrastructure/sqlite/changes.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import {
	ACCESS,
	COFFEE,
	OTHER_SCOPE,
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

function count(db: MemoryDb, sql: string): number {
	return (db.query(sql).get() as { n: number }).n;
}

describe("assertUserState", () => {
	test("creates an active item with evidence, dependency edge, event and change feed", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, assertInput())));
		expect(item.itemId).toMatch(/^state:[0-9a-f]{64}$/);
		expect(item).toMatchObject({
			scopeKey: SCOPE,
			subject: "self",
			kind: "preference",
			semanticKey: "drink",
			status: "active",
			revision: 1,
			origin: "user_confirmed",
			evidenceOrdinal: 5,
			validFromMs: null,
			validUntilMs: null,
		});
		expect(item.value).toEqual({
			text: "コーヒーが好き",
			polarity: "affirmed",
		});
		expect(item.evidence).toHaveLength(1);
		expect(item.evidence[0]?.range).toEqual({ startByte: 6, endByte: 27 });
		expect(item.createdSeq).toBe(item.updatedSeq);

		const deps = s.writer
			.query(
				"SELECT dependency_type, dependency_id, role FROM memory_dependency WHERE dependent_type = 'state_item' AND dependent_id = ?",
			)
			.all(item.itemId);
		expect(deps).toEqual([
			{
				dependency_type: "source",
				dependency_id: sourceKey(COFFEE),
				role: "primary",
			},
		]);
		expect(
			s.writer
				.query(
					"SELECT action, from_revision, to_revision, cause_type, cause_id, at_ms FROM memory_state_event WHERE item_id = ?",
				)
				.all(item.itemId),
		).toEqual([
			{
				action: "assert",
				from_revision: null,
				to_revision: 1,
				cause_type: "user",
				cause_id: "local:owner",
				at_ms: 1000,
			},
		]);
		const feed = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 10,
			}),
		);
		expect(feed.status === "ok" && feed.changes).toMatchObject([
			{
				targetType: "state_item",
				targetId: item.itemId,
				revision: "1",
				status: "active",
			},
		]);
	});

	test("stores attributes, validity window and several evidence spans; primary is the first", () => {
		const s = open();
		const item = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						value: value("コーヒーが好き", "affirmed", {
							strength: "high",
							when: "morning",
						}),
						evidence: [
							makeSpan(COFFEE, "コーヒーが好き"),
							makeSpan(COFFEE, "私は"),
						],
						validFromMs: 10,
						validUntilMs: 99,
					}),
				),
			),
		);
		expect(item.value.attributes).toEqual({
			strength: "high",
			when: "morning",
		});
		expect(item.validFromMs).toBe(10);
		expect(item.validUntilMs).toBe(99);
		expect(item.evidence.map((e) => e.range?.startByte)).toEqual([6, 0]);
		const roles = s.writer
			.query(
				"SELECT role FROM memory_dependency WHERE dependent_id = ? ORDER BY role",
			)
			.all(item.itemId);
		expect(roles).toEqual([{ role: "primary" }, { role: "support" }]);
	});

	test("is idempotent: the same assert returns unchanged and writes nothing", () => {
		const s = open();
		const first = applied(s.write((db) => assertUserState(db, assertInput())));
		const eventsBefore = count(
			s.writer,
			"SELECT count(*) AS n FROM memory_state_event",
		);
		const again = s.write((db) =>
			assertUserState(db, assertInput({ clock: { atMs: 9999 } })),
		);
		expect(again.status).toBe("unchanged");
		expect(again.status === "unchanged" && again.item.itemId).toBe(
			first.itemId,
		);
		expect(
			count(s.writer, "SELECT count(*) AS n FROM memory_state_event"),
		).toBe(eventsBefore);
		expect(count(s.writer, "SELECT count(*) AS n FROM memory_state_item")).toBe(
			1,
		);
	});

	test("a different value for an existing key is ACTIVE_EXISTS and writes nothing", () => {
		const s = open();
		applied(s.write((db) => assertUserState(db, assertInput())));
		const result = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					value: value("紅茶が好き"),
					evidence: [makeSpan(TEA, "紅茶が好き")],
					sources: [TEA],
				}),
			),
		);
		expect(result).toEqual({ status: "rejected", reasonCode: "ACTIVE_EXISTS" });
		expect(count(s.writer, "SELECT count(*) AS n FROM memory_state_item")).toBe(
			1,
		);
	});

	test("replaces supersedes the active item with CAS; the old item keeps its value", () => {
		const s = open();
		const old = applied(s.write((db) => assertUserState(db, assertInput())));
		const next = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						clock: { atMs: 2000 },
						value: value("紅茶が好き"),
						evidence: [makeSpan(TEA, "紅茶が好き")],
						sources: [TEA],
						origin: "user_edited",
						replaces: { itemId: old.itemId, revision: 1 },
					}),
				),
			),
		);
		expect(next).toMatchObject({
			status: "active",
			revision: 1,
			origin: "user_edited",
		});
		expect(next.itemId).not.toBe(old.itemId);
		const listed = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: true,
			}),
		);
		expect(
			listed.status === "ok" &&
				listed.items.map((i) => [i.status, i.value.text]),
		).toEqual(
			expect.arrayContaining([
				["superseded", "コーヒーが好き"],
				["active", "紅茶が好き"],
			]),
		);
		expect(
			s.writer
				.query(
					"SELECT item_id, action, from_revision, to_revision FROM memory_state_event ORDER BY event_seq",
				)
				.all(),
		).toEqual([
			{
				item_id: old.itemId,
				action: "assert",
				from_revision: null,
				to_revision: 1,
			},
			{
				item_id: old.itemId,
				action: "supersede",
				from_revision: 1,
				to_revision: 2,
			},
			{
				item_id: next.itemId,
				action: "assert",
				from_revision: null,
				to_revision: 1,
			},
		]);
	});

	test("replaces guards: stale revision, wrong key, missing target", () => {
		const s = open();
		const old = applied(s.write((db) => assertUserState(db, assertInput())));
		const other = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ semanticKey: "food" })),
			),
		);
		const tea = {
			value: value("紅茶が好き"),
			evidence: [makeSpan(TEA, "紅茶が好き")],
			sources: [TEA],
		};
		expect(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						...tea,
						replaces: { itemId: old.itemId, revision: 7 },
					}),
				),
			),
		).toEqual({ status: "rejected", reasonCode: "STALE_REVISION" });
		expect(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						...tea,
						replaces: { itemId: other.itemId, revision: 1 },
					}),
				),
			),
		).toEqual({ status: "rejected", reasonCode: "REPLACES_MISMATCH" });
		expect(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						...tea,
						replaces: { itemId: "state:nope", revision: 1 },
					}),
				),
			),
		).toEqual({ status: "missing" });
	});

	test("subject other requires other_person_note, and other subjects have independent keys", () => {
		const s = open();
		expect(
			s.write((db) =>
				assertUserState(db, assertInput({ subject: "other:mother" })),
			),
		).toEqual({ status: "rejected", reasonCode: "SUBJECT_KIND_MISMATCH" });
		expect(
			s.write((db) =>
				assertUserState(db, assertInput({ kind: "other_person_note" })),
			),
		).toEqual({ status: "rejected", reasonCode: "SUBJECT_KIND_MISMATCH" });
		const note = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({ kind: "other_person_note", subject: "other:mother" }),
				),
			),
		);
		const mine = applied(s.write((db) => assertUserState(db, assertInput())));
		expect(note.subject).toBe("other:mother");
		expect(mine.itemId).not.toBe(note.itemId);
	});

	test("an unknown subject is a contract error, not a ledger entry", () => {
		const s = open();
		expect(() =>
			s.write((db) =>
				assertUserState(
					db,
					assertInput({ subject: "unknown" as unknown as "self" }),
				),
			),
		).toThrow(MemoryContractError);
	});

	test("evidence rejections write nothing", () => {
		const s = open();
		const cases: [string, Parameters<typeof assertInput>[0]][] = [
			[
				"QUOTE_MISMATCH",
				{ evidence: [makeSpan(COFFEE, "紅茶が好き", "コーヒーが好き")] },
			],
			[
				"EVIDENCE_NOT_IN_INPUT",
				{ evidence: [makeSpan(TEA, "紅茶が好き")], sources: [COFFEE] },
			],
			[
				"SOURCE_STALE",
				{ sources: [{ ...COFFEE, status: "forgotten" as const }] },
			],
		];
		for (const [reasonCode, overrides] of cases) {
			expect(
				s.write((db) => assertUserState(db, assertInput(overrides))),
			).toEqual({
				status: "rejected",
				reasonCode: reasonCode as "QUOTE_MISMATCH",
			});
		}
		expect(count(s.writer, "SELECT count(*) AS n FROM memory_state_item")).toBe(
			0,
		);
	});

	test("a source with a tombstone cannot be used as evidence (source key, and Memory records by id)", () => {
		const s = open();
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('source', ?, ?, ?, 'f1', 1, 1)",
			)
			.run(sourceKey(COFFEE), ACCESS.principal, SCOPE);
		expect(s.write((db) => assertUserState(db, assertInput()))).toEqual({
			status: "rejected",
			reasonCode: "SOURCE_TOMBSTONED",
		});
		const record = makeSource("rec:1", "メモ: 水が好き", 3, {
			namespace: "memory",
			kind: "record",
		});
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('record', 'rec:1', ?, ?, 'f2', 2, 2)",
			)
			.run(ACCESS.principal, SCOPE);
		expect(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						semanticKey: "water",
						value: value("水が好き"),
						evidence: [makeSpan(record, "水が好き")],
						sources: [record],
					}),
				),
			),
		).toEqual({ status: "rejected", reasonCode: "SOURCE_TOMBSTONED" });
	});

	test("a scope outside access.scopeKeys is blocked without writing", () => {
		const s = open();
		const result = s.write((db) =>
			assertUserState(db, assertInput({ scopeKey: "conversation:zzz" })),
		);
		expect(result).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
		expect(count(s.writer, "SELECT count(*) AS n FROM memory_state_item")).toBe(
			0,
		);
	});

	test("garbage input is a contract error before anything is touched", () => {
		const s = open();
		for (const bad of [
			{},
			assertInput({ evidence: [] }),
			assertInput({
				origin: "admitted_extraction" as unknown as "user_edited",
			}),
			{ ...assertInput(), extra: 1 },
			assertInput({ validFromMs: 5, validUntilMs: 5 }),
			assertInput({
				evidence: [
					{
						source: {
							...makeSpan(COFFEE, "私は").source,
							range: undefined,
						} as never,
						quote: "私は",
					},
				],
			}),
		]) {
			expect(() => s.write((db) => assertUserState(db, bad as never))).toThrow(
				MemoryContractError,
			);
		}
		expect(count(s.writer, "SELECT count(*) AS n FROM memory_state_item")).toBe(
			0,
		);
	});
});

describe("write entry checks", () => {
	test("outside a transaction and on a read-only connection are refused", () => {
		const s = open();
		expect(() => assertUserState(s.writer, assertInput())).toThrow(
			expect.objectContaining({ code: "NOT_IN_TRANSACTION" }),
		);
		expect(() => assertUserState(s.reader, assertInput())).toThrow(
			expect.objectContaining({ code: "NOT_IN_TRANSACTION" }),
		);
		expect(() =>
			s.reader.transaction(() => assertUserState(s.reader, assertInput()))(),
		).toThrow(expect.objectContaining({ code: "READONLY_CONNECTION" }));
	});
});

describe("deactivate / reactivate / retract", () => {
	function seeded(s: TestStore): StateItem {
		return applied(s.write((db) => assertUserState(db, assertInput())));
	}

	test("deactivate then reactivate is reversible and never touches tombstone / forget tables", () => {
		const s = open();
		const item = seeded(s);
		const off = s.write((db) =>
			deactivateState(db, targetInput(item.itemId, 1)),
		);
		expect(off.status === "applied" && off.item).toMatchObject({
			status: "inactive",
			revision: 2,
			value: { text: "コーヒーが好き" },
		});
		expect(
			s.write((db) => deactivateState(db, targetInput(item.itemId, 2))).status,
		).toBe("unchanged");
		const on = s.write((db) =>
			reactivateState(db, targetInput(item.itemId, 2)),
		);
		expect(on.status === "applied" && on.item).toMatchObject({
			status: "active",
			revision: 3,
		});
		for (const table of [
			"memory_tombstone",
			"memory_forget",
			"memory_forget_external",
		]) {
			expect(count(s.writer, `SELECT count(*) AS n FROM ${table}`)).toBe(0);
		}
		const feed = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 10,
			}),
		);
		expect(
			feed.status === "ok" && feed.changes.map((c) => [c.status, c.revision]),
		).toEqual([
			["active", "1"],
			["inactive", "2"],
			["active", "3"],
		]);
	});

	test("inactive items are hidden by default; reactivate conflicts with a newer active", () => {
		const s = open();
		const item = seeded(s);
		s.write((db) => deactivateState(db, targetInput(item.itemId, 1)));
		const hidden = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		expect(hidden.status === "ok" && hidden.items).toEqual([]);
		applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						value: value("紅茶が好き"),
						evidence: [makeSpan(TEA, "紅茶が好き")],
						sources: [TEA],
					}),
				),
			),
		);
		expect(
			s.write((db) => reactivateState(db, targetInput(item.itemId, 2))),
		).toEqual({
			status: "rejected",
			reasonCode: "ACTIVE_EXISTS",
		});
	});

	test("retract is terminal; value stays (retract is not forget)", () => {
		const s = open();
		const item = seeded(s);
		const retracted = s.write((db) =>
			retractState(db, targetInput(item.itemId, 1)),
		);
		expect(retracted.status === "applied" && retracted.item).toMatchObject({
			status: "retracted",
			value: { text: "コーヒーが好き" },
		});
		expect(
			s.write((db) => retractState(db, targetInput(item.itemId, 2))).status,
		).toBe("unchanged");
		expect(
			s.write((db) => reactivateState(db, targetInput(item.itemId, 2))),
		).toEqual({
			status: "rejected",
			reasonCode: "INVALID_TRANSITION",
		});
		expect(
			s.write((db) => deactivateState(db, targetInput(item.itemId, 2))),
		).toEqual({
			status: "rejected",
			reasonCode: "INVALID_TRANSITION",
		});
	});

	test("CAS: a stale revision is rejected for every state operation", () => {
		const s = open();
		const item = seeded(s);
		for (const op of [deactivateState, reactivateState, retractState]) {
			expect(s.write((db) => op(db, targetInput(item.itemId, 9)))).toEqual({
				status: "rejected",
				reasonCode: "STALE_REVISION",
			});
		}
	});

	test("items are scoped: another scope or principal sees missing, and unpermitted scopes are blocked", () => {
		const s = open();
		const item = seeded(s);
		expect(
			s.write((db) =>
				deactivateState(
					db,
					targetInput(item.itemId, 1, { scopeKey: OTHER_SCOPE }),
				),
			),
		).toEqual({ status: "missing" });
		expect(
			s.write((db) =>
				deactivateState(
					db,
					targetInput(item.itemId, 1, {
						access: { ...ACCESS, principal: "local:other" },
					}),
				),
			),
		).toEqual({ status: "missing" });
		expect(
			s.write((db) =>
				deactivateState(
					db,
					targetInput(item.itemId, 1, {
						access: { ...ACCESS, scopeKeys: [OTHER_SCOPE] },
					}),
				),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
	});

	test("a tombstoned item reports forgotten and cannot be changed, even if its status was restored to active", () => {
		const s = open();
		const item = seeded(s);
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('state_item', ?, ?, ?, 'f1', 99, 1)",
			)
			.run(item.itemId, ACCESS.principal, SCOPE);
		expect(
			s.write((db) => deactivateState(db, targetInput(item.itemId, 1))),
		).toEqual({
			status: "forgotten",
		});
	});
});

describe("listState", () => {
	function seed(s: TestStore): {
		coffee: StateItem;
		note: StateItem;
		habit: StateItem;
	} {
		const coffee = applied(s.write((db) => assertUserState(db, assertInput())));
		const note = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						kind: "other_person_note",
						subject: "other:mother",
						semanticKey: "drink",
						value: value("紅茶"),
					}),
				),
			),
		);
		const habit = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						kind: "habit",
						semanticKey: "morning",
						value: value("朝は走らない", "negated"),
						evidence: [makeSpan(COFFEE, "私は")],
					}),
				),
			),
		);
		return { coffee, note, habit };
	}

	test("lists active items of the scope only, newest update first, with kind filter and limit", () => {
		const s = open();
		const { coffee, note, habit } = seed(s);
		applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						scopeKey: OTHER_SCOPE,
						sources: [
							makeSource("m1", "私はコーヒーが好きです。", 5, {}, OTHER_SCOPE),
						],
						evidence: [
							makeSpan(
								makeSource(
									"m1",
									"私はコーヒーが好きです。",
									5,
									{},
									OTHER_SCOPE,
								),
								"コーヒーが好き",
							),
						],
					}),
				),
			),
		);
		const all = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		expect(all.status === "ok" && all.items.map((i) => i.itemId)).toEqual([
			habit.itemId,
			note.itemId,
			coffee.itemId,
		]);
		const kinds = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				kinds: ["habit", "other_person_note"],
				limit: 1,
			}),
		);
		expect(kinds.status === "ok" && kinds.items.map((i) => i.itemId)).toEqual([
			habit.itemId,
		]);
		const blocked = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: { ...ACCESS, scopeKeys: [OTHER_SCOPE] },
				scopeKey: SCOPE,
			}),
		);
		expect(blocked).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
		const otherPrincipal = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: { ...ACCESS, principal: "local:other" },
				scopeKey: SCOPE,
			}),
		);
		expect(otherPrincipal.status === "ok" && otherPrincipal.items).toEqual([]);
	});

	test("rows with a tombstone or forgotten status are not listed, even if status was restored", () => {
		const s = open();
		const { coffee, habit } = seed(s);
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('state_item', ?, ?, ?, 'f1', 99, 1)",
			)
			.run(coffee.itemId, ACCESS.principal, SCOPE);
		s.writer
			.query(
				"UPDATE memory_state_item SET status = 'forgotten', value_text = NULL, polarity = NULL WHERE item_id = ?",
			)
			.run(habit.itemId);
		const listed = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: true,
			}),
		);
		expect(
			listed.status === "ok" && listed.items.map((i) => i.semanticKey),
		).toEqual(["drink"]); // note のみ
	});

	test("the list query uses the scope index (no table scan)", () => {
		const s = open();
		const plan = s.writer
			.query(
				`EXPLAIN QUERY PLAN SELECT i.item_id FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.status IN ('active')
				ORDER BY i.updated_seq DESC, i.item_id ASC LIMIT 10`,
			)
			.all("p", "s") as { detail: string }[];
		const text = plan.map((row) => row.detail).join("\n");
		expect(text).toContain("memory_state_item_by_scope");
		expect(text).not.toMatch(/SCAN memory_state_item/);
	});
});

describe("persistence", () => {
	test("state survives a copy of the database file and reads the same", () => {
		const s = open();
		const item = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						value: value("コーヒーが好き", "affirmed", { x: "1" }),
					}),
				),
			),
		);
		const copy = s.snapshotTo("after-assert");
		const restored = openTestStore({ fromFile: copy });
		try {
			const listed = restored.read((db) =>
				listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
			);
			expect(listed.status === "ok" && listed.items).toEqual([item]);
		} finally {
			restored.close();
		}
	});
});

// ---- origin の昇格 ----

/** 抽出が書いた item（origin `admitted_extraction`）を、既存 DB の行として作る。 */
function seedLegacyExtracted(s: TestStore): string {
	const item = applied(
		s.write((db) =>
			assertUserState(db, assertInput({ origin: "agent_inferred" })),
		),
	);
	s.writer
		.query(
			"UPDATE memory_state_item SET origin = 'admitted_extraction' WHERE item_id = ?",
		)
		.run(item.itemId);
	return item.itemId;
}

function eventActions(s: TestStore, itemId: string): string[] {
	return (
		s.writer
			.query(
				"SELECT action FROM memory_state_event WHERE item_id = ? ORDER BY event_seq",
			)
			.all(itemId) as { action: string }[]
	).map((row) => row.action);
}

describe("same-value confirmation promotes a legacy extraction or inferred item to a user origin", () => {
	const seedExtracted = seedLegacyExtracted;

	test("assertUserState with the same value: applied, value unchanged, origin user_confirmed, revision + 1, an edit event, one feed row", () => {
		const s = open();
		const itemId = seedExtracted(s);
		const feedBefore = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 500,
			}),
		);
		const result = s.write((db) => assertUserState(db, assertInput()));
		const item = applied(result);
		expect(item.itemId).toBe(itemId);
		expect(item).toMatchObject({
			origin: "user_confirmed",
			revision: 2,
			status: "active",
			evidenceOrdinal: 5,
		});
		expect(item.value).toEqual(value("コーヒーが好き"));
		expect(eventActions(s, itemId)).toEqual(["assert", "edit"]);
		const feedAfter = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 500,
			}),
		);
		const rows = (r: unknown) => (r as { changes: unknown[] }).changes.length;
		expect(rows(feedAfter)).toBe(rows(feedBefore) + 1);
		expect(count_(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(1);
		// 昇格後は冪等
		const again = s.write((db) => assertUserState(db, assertInput()));
		expect(again.status).toBe("unchanged");
		expect(eventActions(s, itemId)).toEqual(["assert", "edit"]);
	});

	test("user_edited counts too; a later inferred write of the same value never demotes", () => {
		const s = open();
		const itemId = seedExtracted(s);
		const edited = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ origin: "user_edited" })),
			),
		);
		expect(edited).toMatchObject({
			itemId,
			origin: "user_edited",
			revision: 2,
		});
		const again = s.write((db) =>
			assertUserState(db, assertInput({ origin: "agent_inferred" })),
		);
		expect(again).toMatchObject({ status: "unchanged" });
		expect(
			s.writer
				.query(
					"SELECT origin, revision FROM memory_state_item WHERE item_id = ?",
				)
				.get(itemId),
		).toEqual({ origin: "user_edited", revision: 2 });
		// user_confirmed → user_edited の同値は横移動しない（変化なし）
		expect(
			s.write((db) =>
				assertUserState(db, assertInput({ origin: "user_confirmed" })),
			).status,
		).toBe("unchanged");
	});

	test("replaces with the same value promotes the replaced active item (CAS still applies)", () => {
		const s = open();
		const itemId = seedExtracted(s);
		const stale = s.write((db) =>
			assertUserState(db, assertInput({ replaces: { itemId, revision: 7 } })),
		);
		expect(stale).toEqual({ status: "rejected", reasonCode: "STALE_REVISION" });
		const item = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ replaces: { itemId, revision: 1 } })),
			),
		);
		expect(item).toMatchObject({
			itemId,
			origin: "user_confirmed",
			revision: 2,
		});
		expect(count_(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(1);
	});
});

function count_(s: TestStore, sql: string): number {
	return (s.writer.query(sql).get() as { n: number }).n;
}

describe("validity precision", () => {
	const since = {
		from: { precision: "month", year: 2026, month: 9 },
		basis: "stated",
	} as const;

	test("a month-precision period is stored as such, with bounds derived from the calendar and no invented day", () => {
		const s = open();
		const item = applied(
			s.write((db) => assertUserState(db, assertInput({ validity: since }))),
		);
		expect(item.validity).toEqual(since);
		expect(item.validFromMs).toBe(Date.UTC(2026, 8, 1));
		expect(item.validUntilMs).toBeNull();
		const listed = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		expect(listed.status === "ok" && listed.items[0]?.validity).toEqual(since);
	});

	test("closed periods use an exclusive end at the next unit; an explicit unknown basis is kept", () => {
		const s = open();
		const item = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						validity: {
							from: { precision: "year", year: 2020 },
							until: { precision: "month", year: 2026, month: 8 },
							basis: "inferred",
						},
					}),
				),
			),
		);
		expect(item.validUntilMs).toBe(Date.UTC(2026, 8, 1));
		expect(item.validity?.basis).toBe("inferred");
		const unknown = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						kind: "habit",
						semanticKey: "other",
						validity: { basis: "unknown" },
					}),
				),
			),
		);
		expect(unknown.validity).toEqual({ basis: "unknown" });
		expect(unknown.validFromMs).toBeNull();
	});

	test("impossible dates, reversed periods and mixing with raw ms bounds are rejected", () => {
		const s = open();
		const bad = [
			{
				validity: {
					from: { precision: "day", year: 2026, month: 2, day: 30 },
					basis: "stated",
				},
			},
			{
				validity: {
					from: { precision: "month", year: 2026, month: 9 },
					until: { precision: "month", year: 2026, month: 8 },
					basis: "stated",
				},
			},
			{ validity: since, validFromMs: 5 },
			{ validity: { basis: "guess" } },
		];
		for (const extra of bad) {
			expect(() =>
				s.write((db) =>
					assertUserState(db, assertInput(extra as Partial<never>)),
				),
			).toThrow(MemoryContractError);
		}
		expect(count_(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(0);
	});

	test("re-asserting the same value with a different period is rejected, not silently dropped; the same period is unchanged", () => {
		const s = open();
		applied(s.write((db) => assertUserState(db, assertInput())));
		const different = s.write((db) =>
			assertUserState(db, assertInput({ validity: since })),
		);
		expect(different).toEqual({
			status: "rejected",
			reasonCode: "INVALID_TRANSITION",
		});
		const withPeriod = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({ semanticKey: "other", validity: since }),
				),
			),
		);
		expect(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({ semanticKey: "other", validity: since }),
				),
			).status,
		).toBe("unchanged");
		expect(withPeriod.validity).toEqual(since);
	});

	test("forgetting clears the stored precision with the value", () => {
		const s = open();
		const item = applied(
			s.write((db) => assertUserState(db, assertInput({ validity: since }))),
		);
		s.write((db) => scrubStateItem(db, ACCESS.principal, item.itemId, 99));
		expect(
			s.writer
				.query(
					"SELECT valid_from_text, valid_until_text, valid_basis, valid_from_ms FROM memory_state_item",
				)
				.get(),
		).toEqual({
			valid_from_text: null,
			valid_until_text: null,
			valid_basis: null,
			valid_from_ms: null,
		});
	});
});

describe("rows written by older versions stay readable and follow the remaining transitions", () => {
	/** 現在の API が書かない status を、既存 DB の行として直接作る。 */
	function setStatus(s: TestStore, itemId: string, status: string): void {
		s.writer
			.query("UPDATE memory_state_item SET status = ? WHERE item_id = ?")
			.run(status, itemId);
	}
	function seed(s: TestStore, status: string): StateItem {
		const item = applied(s.write((db) => assertUserState(db, assertInput())));
		setStatus(s, item.itemId, status);
		return item;
	}
	function statusOf(s: TestStore, itemId: string): unknown {
		return s.writer
			.query("SELECT status, revision FROM memory_state_item WHERE item_id = ?")
			.get(itemId);
	}

	test("reactivateState turns a disputed item into the active one (event `activate`)", () => {
		const s = open();
		const item = seed(s, "disputed");
		const result = s.write((db) =>
			reactivateState(db, targetInput(item.itemId, 1)),
		);
		expect(applied(result)).toMatchObject({ status: "active", revision: 2 });
		expect(
			s.writer
				.query(
					"SELECT action FROM memory_state_event WHERE item_id = ? ORDER BY event_seq",
				)
				.all(item.itemId),
		).toEqual([{ action: "assert" }, { action: "activate" }]);
	});

	test("reactivateState on a disputed item is ACTIVE_EXISTS while another item holds the key", () => {
		const s = open();
		const item = seed(s, "disputed");
		applied(s.write((db) => assertUserState(db, assertInput())));
		const result = s.write((db) =>
			reactivateState(db, targetInput(item.itemId, 1)),
		);
		expect(result).toEqual({ status: "rejected", reasonCode: "ACTIVE_EXISTS" });
		expect(statusOf(s, item.itemId)).toEqual({
			status: "disputed",
			revision: 1,
		});
	});

	test("retractState retracts a disputed item", () => {
		const s = open();
		const item = seed(s, "disputed");
		const result = s.write((db) =>
			retractState(db, targetInput(item.itemId, 1)),
		);
		expect(applied(result)).toMatchObject({ status: "retracted", revision: 2 });
	});

	test.each([
		["deactivateState", deactivateState],
		["reactivateState", reactivateState],
		["retractState", retractState],
	] as const)(
		"%s on an invalidated item is INVALID_TRANSITION and writes nothing",
		(_name, operation) => {
			const s = open();
			const item = seed(s, "invalidated");
			const events = count(
				s.writer,
				"SELECT count(*) AS n FROM memory_state_event",
			);
			const result = s.write((db) =>
				operation(db, targetInput(item.itemId, 1)),
			);
			expect(result).toEqual({
				status: "rejected",
				reasonCode: "INVALID_TRANSITION",
			});
			expect(statusOf(s, item.itemId)).toEqual({
				status: "invalidated",
				revision: 1,
			});
			expect(
				count(s.writer, "SELECT count(*) AS n FROM memory_state_event"),
			).toBe(events);
		},
	);

	test("listState(includeInactive) and readStateFact read admitted_extraction, disputed and invalidated rows", () => {
		const s = open();
		const first = seed(s, "invalidated");
		const second = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ origin: "agent_inferred" })),
			),
		);
		s.writer
			.query(
				"UPDATE memory_state_item SET origin = 'admitted_extraction' WHERE item_id = ?",
			)
			.run(second.itemId);
		const third = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						value: value("紅茶が好き"),
						evidence: [makeSpan(TEA, "紅茶が好き")],
						sources: [TEA],
						replaces: { itemId: second.itemId, revision: 1 },
					}),
				),
			),
		);
		setStatus(s, second.itemId, "disputed");

		const listed = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: true,
			}),
		);
		expect(listed.status).toBe("ok");
		if (listed.status !== "ok") return;
		const byId = new Map(listed.items.map((item) => [item.itemId, item]));
		expect(byId.get(first.itemId)).toMatchObject({ status: "invalidated" });
		expect(byId.get(second.itemId)).toMatchObject({
			status: "disputed",
			origin: "admitted_extraction",
		});
		expect(byId.get(third.itemId)).toMatchObject({ status: "active" });
		// 既定（active のみ）の一覧には出ない。
		const activeOnly = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		expect(
			activeOnly.status === "ok" && activeOnly.items.map((i) => i.itemId),
		).toEqual([third.itemId]);

		const fact = s.read((db) =>
			readStateFact(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				itemId: third.itemId,
			}),
		);
		expect(fact).toMatchObject({
			status: "ok",
			itemIds: [first.itemId, second.itemId, third.itemId],
		});
	});
});
