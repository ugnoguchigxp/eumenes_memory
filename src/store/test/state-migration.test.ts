import { afterEach, describe, expect, test } from "bun:test";
import {
	STATE_EVENT_ACTIONS,
	STATE_ITEM_STATUSES,
	STATE_KINDS,
	STATE_CAUSE_TYPES,
	STATE_ORIGINS,
} from "../../contracts/state.ts";
import { POLARITIES } from "../../contracts/common.ts";
import { sql as state } from "../migrations/0003-state.ts";
import { openTestStore } from "../../../test/support/store.ts";
import type { TestStore } from "../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function checkList(sql: string, column: string, table: string): string[] {
	const tableBody = new RegExp(
		`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`,
	).exec(sql)?.[1];
	if (tableBody === undefined) throw new Error(`table ${table} not found`);
	const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(tableBody);
	if (match?.[1] === undefined) throw new Error(`${column} CHECK not found`);
	return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

describe("0003 state part", () => {
	test("CHECK enumerations equal the contract tuples", () => {
		expect(checkList(state, "kind", "memory_state_item")).toEqual([
			...STATE_KINDS,
		]);
		expect(checkList(state, "status", "memory_state_item")).toEqual([
			...STATE_ITEM_STATUSES,
		]);
		expect(checkList(state, "origin", "memory_state_item")).toEqual([
			...STATE_ORIGINS,
		]);
		expect(checkList(state, "polarity", "memory_state_item")).toEqual([
			...POLARITIES,
		]);
		expect(checkList(state, "action", "memory_state_event")).toEqual([
			...STATE_EVENT_ACTIONS,
		]);
		expect(checkList(state, "cause_type", "memory_state_event")).toEqual([
			...STATE_CAUSE_TYPES,
		]);
	});

	test("every index and trigger is memory_-prefixed, and scope indexes lead with principal, scope_key", () => {
		store = openTestStore();
		const rows = store.writer
			.query(
				"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name LIKE 'memory_state_%' AND name NOT LIKE 'sqlite_%'",
			)
			.all() as { type: string; name: string; sql: string | null }[];
		for (const row of rows) expect(row.name.startsWith("memory_")).toBe(true);
		const scopeIndex = rows.find(
			(r) => r.name === "memory_state_item_by_scope",
		);
		expect(scopeIndex?.sql).toContain("(principal, scope_key,");
		const keyIndex = rows.find((r) => r.name === "memory_state_item_by_key");
		expect(keyIndex?.sql).toContain("(principal, scope_key,");
		expect(rows.some((r) => r.type === "trigger")).toBe(true);
	});

	test("the database enforces one active item per (scope, subject, kind, key) and the subject-kind pairing", () => {
		store = openTestStore();
		const insert = (
			id: string,
			subject: string,
			kind: string,
			status = "active",
		) =>
			store!.writer
				.query(
					`INSERT INTO memory_state_item
						(item_id, principal, scope_key, subject, kind, semantic_key, status, revision,
						 value_text, polarity, origin, evidence_ordinal, created_seq, updated_seq)
					VALUES (?, 'p', 's', ?, ?, 'k', ?, 1, 'v', 'affirmed', 'user_confirmed', 0, 1, 1)`,
				)
				.run(id, subject, kind, status);
		insert("a", "self", "preference");
		expect(() => insert("b", "self", "preference")).toThrow();
		insert("c", "self", "preference", "superseded");
		insert("d", "other:x", "other_person_note");
		expect(() => insert("e", "other:x", "preference", "inactive")).toThrow();
		expect(() =>
			insert("f", "self", "other_person_note", "inactive"),
		).toThrow();
	});

	test("a tombstoned state item id cannot be inserted again", () => {
		store = openTestStore();
		store.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('state_item', 'state:x', 'p', 's', 'f', 1, 1)",
			)
			.run();
		expect(() =>
			store!.writer
				.query(
					`INSERT INTO memory_state_item
						(item_id, principal, scope_key, subject, kind, semantic_key, status, revision,
						 value_text, polarity, origin, evidence_ordinal, created_seq, updated_seq)
					VALUES ('state:x', 'p', 's', 'self', 'preference', 'k', 'active', 1, 'v', 'affirmed', 'user_confirmed', 0, 1, 1)`,
				)
				.run(),
		).toThrow(/memory_tombstoned/);
	});
});
