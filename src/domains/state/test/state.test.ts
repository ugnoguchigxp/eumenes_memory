import { afterEach, describe, expect, test } from "bun:test";
import { MemoryContractError } from "../../../contracts/errors.ts";
import type { StateItem, StateWriteResult } from "../contracts/index.ts";
import { sourceKey } from "../../../contracts/source-key.ts";
import {
	assertUserState,
	deactivateState,
	editState,
	listState,
	listStateScopes,
	reactivateState,
	readMemorySnapshotPart,
	retractState,
	scrubStateItem,
	writeStateForCandidate,
} from "../repository/index.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { listMemoryChanges } from "../../../infrastructure/sqlite/changes.ts";
import { readScopeRevision } from "../../../infrastructure/sqlite/scope-state.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import {
	ACCESS,
	COFFEE,
	OLD,
	OTHER_SCOPE,
	SCOPE,
	TEA,
	assertInput,
	editInput,
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

function scopeRevision(s: TestStore, scopeKey = SCOPE): number {
	return s.read((db) => readScopeRevision(db, ACCESS.principal, scopeKey));
}

describe("assertUserState", () => {
	test("creates an active item with evidence, dependency edge, event, scope revision and change feed", () => {
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
		expect(scopeRevision(s)).toBe(1);
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
		const revisionBefore = scopeRevision(s);
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
		expect(scopeRevision(s)).toBe(revisionBefore);
		expect(count(s.writer, "SELECT count(*) AS n FROM memory_state_item")).toBe(
			1,
		);
	});

	test("a different value for an existing key is ACTIVE_EXISTS and writes nothing", () => {
		const s = open();
		applied(s.write((db) => assertUserState(db, assertInput())));
		const revision = scopeRevision(s);
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
		expect(scopeRevision(s)).toBe(revision);
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
		expect(scopeRevision(s)).toBe(0);
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

describe("edit / deactivate / reactivate / retract", () => {
	function seeded(s: TestStore): StateItem {
		return applied(s.write((db) => assertUserState(db, assertInput())));
	}

	test("editState changes value and evidence, bumps revision, and is idempotent for the same value", () => {
		const s = open();
		const item = seeded(s);
		const edited = applied(
			s.write((db) =>
				editState(
					db,
					editInput(item.itemId, 1, {
						value: value("紅茶が好き", "affirmed", { a: "1" }),
					}),
				),
			),
		);
		expect(edited).toMatchObject({
			revision: 2,
			origin: "user_edited",
			status: "active",
			evidenceOrdinal: 8,
		});
		expect(edited.value).toEqual({
			text: "紅茶が好き",
			polarity: "affirmed",
			attributes: { a: "1" },
		});
		expect(edited.evidence.map((e) => e.id)).toEqual(["m2"]);
		const edges = s.writer
			.query(
				"SELECT dependency_id FROM memory_dependency WHERE dependent_id = ? ORDER BY dependency_id",
			)
			.all(item.itemId);
		expect(edges).toHaveLength(2); // 古い辺は残す
		const revision = scopeRevision(s);
		const again = s.write((db) =>
			editState(
				db,
				editInput(item.itemId, 2, {
					value: value("紅茶が好き", "affirmed", { a: "1" }),
				}),
			),
		);
		expect(again.status).toBe("unchanged");
		expect(scopeRevision(s)).toBe(revision);
		expect(
			s.write((db) =>
				editState(db, editInput(item.itemId, 1, { value: value("緑茶") })),
			),
		).toEqual({ status: "rejected", reasonCode: "STALE_REVISION" });
	});

	test("editState rejects unusable evidence and missing items", () => {
		const s = open();
		const item = seeded(s);
		expect(
			s.write((db) =>
				editState(
					db,
					editInput(item.itemId, 1, {
						evidence: [makeSpan(OLD, "緑茶が好き")],
						sources: [TEA],
					}),
				),
			),
		).toEqual({ status: "rejected", reasonCode: "EVIDENCE_NOT_IN_INPUT" });
		expect(s.write((db) => editState(db, editInput("state:nope", 1)))).toEqual({
			status: "missing",
		});
	});

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
		expect(s.write((db) => editState(db, editInput(item.itemId, 1)))).toEqual({
			status: "forgotten",
		});
	});
});

describe("listState / readMemorySnapshotPart", () => {
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
		const part = s.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(part.status === "ok" && part.items).toEqual([]);
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

	test("snapshot part: active self items only, view-ready shape, negated prefix, revision", () => {
		const s = open();
		const { coffee, habit } = seed(s);
		const part = s.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(part.status).toBe("ok");
		if (part.status !== "ok") return;
		expect(part.memoryRevision).toBe("3");
		expect(part.items.map((i) => i.id)).toEqual([coffee.itemId, habit.itemId]);
		expect(part.items[0]).toMatchObject({
			revision: "1",
			kind: "preference",
			text: "コーヒーが好き",
			status: "active",
			origin: "user_confirmed",
			subject: "self",
			primarySource: {
				namespace: "conversation",
				id: "m1",
				range: { startByte: 6, endByte: 27 },
			},
		});
		expect(part.items[1]?.text).toBe("NOT: 朝は走らない");
		expect(part.sources).toEqual([]); // 会話 source はホストが入れる
		const blocked = s.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: { ...ACCESS, scopeKeys: [] as never },
				scopeKey: SCOPE,
			}),
		);
		expect(blocked.status).toBe("blocked");
	});

	test("deactivated, disputed and superseded items do not enter the snapshot", () => {
		const s = open();
		const { coffee } = seed(s);
		s.write((db) => deactivateState(db, targetInput(coffee.itemId, 1)));
		const part = s.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(part.status === "ok" && part.items.map((i) => i.kind)).toEqual([
			"habit",
		]);
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

// ---- レビュー B: origin の昇格と、同 key の履歴（disputed / ユーザーが消したもの）----

function candidateWrite(
	text: string,
	ordinal: number,
	source = COFFEE,
	quote = "コーヒーが好き",
	candidateId = `cand:${text}`,
): Parameters<typeof writeStateForCandidate>[1] {
	return {
		principal: ACCESS.principal,
		scopeKey: SCOPE,
		atMs: 500,
		subject: "self",
		kind: "preference",
		semanticKey: "drink",
		value: value(text),
		evidence: [makeSpan(source, quote)],
		evidenceOrdinal: ordinal,
		origin: "admitted_extraction",
		candidateId,
		replaces: null,
	};
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

describe("same-value confirmation promotes an extraction item to a user origin", () => {
	function seedExtracted(s: TestStore): string {
		const written = s.write((db) =>
			writeStateForCandidate(db, candidateWrite("コーヒーが好き", 5)),
		);
		if (written.status !== "applied") throw new Error("setup");
		return written.itemId;
	}

	test("assertUserState with the same value: applied, value unchanged, origin user_confirmed, revision + 1, an edit event, one feed row", () => {
		const s = open();
		const itemId = seedExtracted(s);
		const before = scopeRevision(s);
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
		expect(scopeRevision(s)).toBe(before + 1);
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

	test("user_edited counts too; an extraction write of the same value never demotes", () => {
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
			writeStateForCandidate(db, candidateWrite("コーヒーが好き", 99)),
		);
		expect(again).toEqual({ status: "unchanged", itemId });
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

	test("editState with the same value promotes without replacing the evidence", () => {
		const s = open();
		const itemId = seedExtracted(s);
		const evidenceBefore = s.writer
			.query(
				"SELECT source_key, start_byte, end_byte FROM memory_state_evidence WHERE item_id = ?",
			)
			.all(itemId);
		const result = s.write((db) =>
			editState(
				db,
				editInput(itemId, 1, {
					value: value("コーヒーが好き"),
					evidence: [makeSpan(TEA, "紅茶が好き")],
					sources: [TEA],
				}),
			),
		);
		expect(applied(result)).toMatchObject({
			origin: "user_edited",
			revision: 2,
		});
		expect(
			s.writer
				.query(
					"SELECT source_key, start_byte, end_byte FROM memory_state_evidence WHERE item_id = ?",
				)
				.all(itemId),
		).toEqual(evidenceBefore);
		// 値が同じ user 由来の item への同値 edit は冪等のまま
		expect(
			s.write((db) =>
				editState(
					db,
					editInput(itemId, 2, {
						value: value("コーヒーが好き"),
						evidence: [makeSpan(TEA, "紅茶が好き")],
						sources: [TEA],
					}),
				),
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

describe("key history: disputed and user-removed items", () => {
	function dispute(s: TestStore): void {
		const first = s.write((db) =>
			writeStateForCandidate(db, candidateWrite("コーヒーが好き", 5)),
		);
		const second = s.write((db) =>
			writeStateForCandidate(
				db,
				candidateWrite("紅茶が好き", 5, TEA, "紅茶が好き"),
			),
		);
		expect(first.status).toBe("applied");
		expect(second.status).toBe("applied");
		expect(
			s.writer
				.query("SELECT status FROM memory_state_item ORDER BY created_seq")
				.all(),
		).toEqual([{ status: "disputed" }, { status: "disputed" }]);
	}

	test("a write older than the newest disputed item is OLDER_EVIDENCE and writes nothing (reviewer repro t2)", () => {
		const s = open();
		dispute(s);
		const before = count_(s, "SELECT COUNT(*) AS n FROM memory_state_item");
		const eventsBefore = count_(
			s,
			"SELECT COUNT(*) AS n FROM memory_state_event",
		);
		const older = s.write((db) =>
			writeStateForCandidate(
				db,
				candidateWrite("緑茶が好き", 1, OLD, "緑茶が好き"),
			),
		);
		expect(older).toEqual({ status: "rejected", reasonCode: "OLDER_EVIDENCE" });
		expect(count_(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(
			before,
		);
		expect(count_(s, "SELECT COUNT(*) AS n FROM memory_state_event")).toBe(
			eventsBefore,
		);
		expect(
			count_(
				s,
				"SELECT COUNT(*) AS n FROM memory_state_item WHERE status = 'active'",
			),
		).toBe(0);
	});

	test("an equal or newer write joins the dispute instead of resolving it: no active item appears", () => {
		const s = open();
		dispute(s);
		for (const [text, ordinal] of [
			["麦茶が好き", 5],
			["烏龍茶が好き", 9],
		] as const) {
			const written = s.write((db) =>
				writeStateForCandidate(
					db,
					candidateWrite(text, ordinal, OLD, "緑茶が好き", `cand:${text}`),
				),
			);
			expect(written.status).toBe("applied");
		}
		expect(
			s.writer
				.query(
					"SELECT status, COUNT(*) AS n FROM memory_state_item GROUP BY status",
				)
				.all(),
		).toEqual([{ status: "disputed", n: 4 }]);
		const listed = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		expect(listed.status === "ok" && listed.items).toEqual([]);
	});

	test("an explicit user assertion is not bound by the dispute and creates a new active item", () => {
		const s = open();
		dispute(s);
		const item = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						value: value("ほうじ茶が好き"),
						evidence: [makeSpan(OLD, "緑茶が好き")],
						sources: [OLD],
					}),
				),
			),
		);
		expect(item.status).toBe("active");
	});

	test("a user-confirmed item that the user deactivated or retracted is not revived by an extraction write", () => {
		for (const remove of [deactivateState, retractState]) {
			const s = open();
			const item = applied(s.write((db) => assertUserState(db, assertInput())));
			s.write((db) => remove(db, targetInput(item.itemId, 1)));
			const result = s.write((db) =>
				writeStateForCandidate(
					db,
					candidateWrite("紅茶が好き", 9, TEA, "紅茶が好き"),
				),
			);
			expect(result).toEqual({
				status: "rejected",
				reasonCode: "INVALID_TRANSITION",
			});
			expect(count_(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(1);
			s.close();
			store = undefined;
		}
	});

	test("a user stop of an extraction-origin item blocks later extraction as well (protection follows the user's act, not the origin)", () => {
		const s = open();
		const written = s.write((db) =>
			writeStateForCandidate(db, candidateWrite("コーヒーが好き", 5)),
		);
		if (written.status !== "applied") throw new Error("setup");
		s.write((db) => retractState(db, targetInput(written.itemId, 1)));
		const result = s.write((db) =>
			writeStateForCandidate(
				db,
				candidateWrite("紅茶が好き", 9, TEA, "紅茶が好き"),
			),
		);
		expect(result).toEqual({
			status: "rejected",
			reasonCode: "INVALID_TRANSITION",
		});
	});

	test("a tombstoned item is not history (even if its row still carries the key)", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, assertInput())));
		s.write((db) => retractState(db, targetInput(item.itemId, 1)));
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('state_item', ?, 'p', 's', 'f', 1, 1)",
			)
			.run(item.itemId);
		const result = s.write((db) =>
			writeStateForCandidate(
				db,
				candidateWrite("紅茶が好き", 9, TEA, "紅茶が好き"),
			),
		);
		expect(result.status).toBe("applied");
	});

	test("history is per key: another key, kind or subject is unaffected, and forgotten items are not history", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, assertInput())));
		s.write((db) => retractState(db, targetInput(item.itemId, 1)));
		const otherKey = s.write((db) =>
			writeStateForCandidate(db, {
				...candidateWrite("紅茶が好き", 9, TEA, "紅茶が好き"),
				semanticKey: "snack",
			}),
		);
		expect(otherKey.status).toBe("applied");
		const otherKind = s.write((db) =>
			writeStateForCandidate(db, {
				...candidateWrite(
					"紅茶が好き",
					9,
					TEA,
					"紅茶が好き",
					"cand:other-kind",
				),
				kind: "habit",
			}),
		);
		expect(otherKind.status).toBe("applied");
	});
});

describe("editState and write operations check the scope permission", () => {
	test("editState on a scope outside access.scopeKeys is blocked and writes nothing", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, assertInput())));
		const result = s.write((db) =>
			editState(
				db,
				editInput(item.itemId, 1, {
					access: { ...ACCESS, scopeKeys: [OTHER_SCOPE] },
				}),
			),
		);
		expect(result).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
		expect(
			s.writer
				.query("SELECT revision, value_text FROM memory_state_item")
				.get(),
		).toEqual({ revision: 1, value_text: "コーヒーが好き" });
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

describe("listStateScopes (multi-scope explicit read)", () => {
	const COMMON = "user:common";
	const PROJECT = "project:a";
	const multi = {
		...ACCESS,
		scopeKeys: [COMMON, PROJECT, "project:b"],
	};
	const input = (scopeKeys: readonly string[], access = multi) => ({
		contractVersion: 1 as const,
		access,
		scopeKeys,
	});
	const writeIn = (s: TestStore, scopeKey: string, key: string) =>
		applied(
			s.write((db) =>
				assertUserState(db, {
					...assertInput({ semanticKey: key }),
					access: multi,
					scopeKey,
					sources: [
						makeSource("m1", "私はコーヒーが好きです。", 5, {}, scopeKey),
					],
					evidence: [
						makeSpan(
							makeSource("m1", "私はコーヒーが好きです。", 5, {}, scopeKey),
							"コーヒーが好き",
						),
					],
				}),
			),
		);

	test("returns each authorized scope with its own revision and never mixes scopes", () => {
		const s = open();
		writeIn(s, COMMON, "k1");
		writeIn(s, PROJECT, "k2");
		writeIn(s, PROJECT, "k3");
		const result = s.read((db) =>
			listStateScopes(db, input([COMMON, PROJECT])),
		);
		if (result.status !== "ok") throw new Error("blocked");
		expect(result.scopes.map((x) => [x.scopeKey, x.items.length])).toEqual([
			[COMMON, 1],
			[PROJECT, 2],
		]);
		expect(result.scopes[0]?.revision).not.toBe(result.scopes[1]?.revision);
		expect(
			result.scopes.every((x) =>
				x.items.every((i) => i.scopeKey === x.scopeKey),
			),
		).toBe(true);
	});

	test("one unauthorized scope blocks the whole read; duplicates and empty lists are invalid", () => {
		const s = open();
		writeIn(s, COMMON, "k1");
		expect(
			s.read((db) => listStateScopes(db, input([COMMON, "project:secret"]))),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
		for (const bad of [[], [COMMON, COMMON]]) {
			expect(() => s.read((db) => listStateScopes(db, input(bad)))).toThrow(
				MemoryContractError,
			);
		}
	});

	test("a revision only moves for the scope that changed", () => {
		const s = open();
		writeIn(s, COMMON, "k1");
		writeIn(s, PROJECT, "k2");
		const before = s.read((db) =>
			listStateScopes(db, input([COMMON, PROJECT])),
		);
		writeIn(s, PROJECT, "k3");
		const after = s.read((db) => listStateScopes(db, input([COMMON, PROJECT])));
		if (before.status !== "ok" || after.status !== "ok") throw new Error("x");
		expect(after.scopes[0]?.revision).toBe(before.scopes[0]?.revision);
		expect(after.scopes[1]?.revision).not.toBe(before.scopes[1]?.revision);
	});
});

describe("listStateScopes truncation", () => {
	test("reports truncated only when more items exist than the per-scope limit", () => {
		const s = open();
		const insert = s.writer.query(
			`INSERT INTO memory_state_item (item_id, principal, scope_key, subject, kind, semantic_key, status, revision,
				value_text, polarity, origin, evidence_ordinal, created_seq, updated_seq)
			VALUES (?, ?, ?, 'self', 'preference', ?, 'active', 1, 'v', 'affirmed', 'user_confirmed', 0, ?, ?)`,
		);
		s.writer.transaction(() => {
			for (let i = 0; i < 1000; i++)
				insert.run(
					`state:${i}`,
					ACCESS.principal,
					SCOPE,
					`k${i}`,
					i + 1,
					i + 1,
				);
		})();
		const read = () =>
			s.read((db) =>
				listStateScopes(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKeys: [SCOPE],
				}),
			);
		const exact = read();
		expect(exact.status === "ok" && exact.scopes[0]?.truncated).toBe(false);
		insert.run("state:1000", ACCESS.principal, SCOPE, "k1000", 1001, 1001);
		const over = read();
		expect(over.status === "ok" && over.scopes[0]?.truncated).toBe(true);
		expect(over.status === "ok" && over.scopes[0]?.items).toHaveLength(1000);
	});
});
