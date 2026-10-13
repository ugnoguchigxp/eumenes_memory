import { afterEach, describe, expect, test } from "bun:test";
import {
	STATE_EVENT_ACTIONS,
	STATE_ITEM_STATUSES,
	STATE_KINDS,
	STATE_CAUSE_TYPES,
	STATE_ORIGINS,
} from "../contracts/index.ts";
import { POLARITIES } from "../../../contracts/common.ts";
import { sql as state } from "../migrations/0003-state.ts";
import { sql as agentOrigin } from "../migrations/0007-state-agent-origin.ts";
import { migrations } from "../../../infrastructure/sqlite/migrations/index.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

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
		// 0003 の origin はそのまま固定。`agent_inferred` を加えた現在の列挙は 0007（下のテスト）。
		expect(checkList(state, "origin", "memory_state_item")).toEqual([
			"user_confirmed",
			"user_edited",
			"admitted_extraction",
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

describe("0007 agent_inferred origin", () => {
	test("the origin CHECK equals the current contract tuple; the other CHECKs are unchanged", () => {
		expect(checkList(agentOrigin, "origin", "memory_state_item_v7")).toEqual([
			...STATE_ORIGINS,
		]);
		for (const column of ["kind", "status", "polarity"] as const) {
			expect(checkList(agentOrigin, column, "memory_state_item_v7")).toEqual(
				checkList(state, column, "memory_state_item"),
			);
		}
		expect(checkList(agentOrigin, "action", "memory_state_event_v7")).toEqual(
			checkList(state, "action", "memory_state_event"),
		);
	});

	test("upgrading a version-6 database keeps every row and foreign key, and accepts agent_inferred afterwards", () => {
		store = openTestStore({ migrations: migrations.slice(0, 6) });
		const db = store.writer;
		const insertItem = (id: string, origin: string, status = "active") =>
			db
				.query(
					`INSERT INTO memory_state_item
						(item_id, principal, scope_key, subject, kind, semantic_key, status, revision,
						 value_text, polarity, origin, evidence_ordinal, created_seq, updated_seq,
						 valid_from_text, valid_until_text, valid_basis)
					VALUES (?, 'p', 's', 'self', 'preference', ?, ?, 3, 'v', 'affirmed', ?, 4, 1, 2, '2026-09', NULL, 'stated')`,
				)
				.run(id, `key-${id}`, status, origin);
		insertItem("a", "user_confirmed");
		insertItem("b", "admitted_extraction", "superseded");
		db.query(
			"INSERT INTO memory_state_attribute (item_id, attr_key, attr_value) VALUES ('a', 'k', 'v')",
		).run();
		db.query(
			`INSERT INTO memory_state_evidence
				(item_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, start_byte, end_byte)
			VALUES ('a', 0, 'sk', 'conversation', 'message', 'm1', 'text', 'r', 'd', 0, 4)`,
		).run();
		db.query(
			`INSERT INTO memory_state_event
				(event_seq, item_id, principal, scope_key, action, from_revision, to_revision, cause_type, cause_id, at_ms)
			VALUES (7, 'a', 'p', 's', 'assert', NULL, 1, 'user', 'c', 10)`,
		).run();
		const dump = () =>
			["item", "attribute", "evidence", "event"].map((name) =>
				db.query(`SELECT * FROM memory_state_${name} ORDER BY 1, 2`).all(),
			);
		const before = dump();

		// ホストと同じ形: foreign_keys=ON の transaction の中で、1 本の exec として適用する。
		db.transaction(() => db.exec(migrations[6] as string))();

		expect(dump()).toEqual(before);
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		for (const child of ["attribute", "evidence", "event"]) {
			expect(
				db.query(`PRAGMA foreign_key_list(memory_state_${child})`).all(),
			).toMatchObject([{ table: "memory_state_item", to: "item_id" }]);
		}
		expect(
			db
				.query(
					"SELECT value FROM memory_schema_info WHERE key = 'db_schema_version'",
				)
				.get(),
		).toEqual({ value: "7" });
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE tbl_name LIKE 'memory_state_%' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "memory_state_event_by_item" },
			{ name: "memory_state_event_by_scope" },
			{ name: "memory_state_item_by_key" },
			{ name: "memory_state_item_by_scope" },
			{ name: "memory_state_item_no_resurrection" },
			{ name: "memory_state_item_one_active_per_key" },
		]);

		insertItem("c", "agent_inferred", "inactive");
		expect(() => insertItem("d", "unknown_origin")).toThrow();
		// 参照整合性と「key ごとに active は 1 件」は作り直し後も効く。
		expect(() =>
			db
				.query(
					"INSERT INTO memory_state_attribute (item_id, attr_key, attr_value) VALUES ('nope', 'k', 'v')",
				)
				.run(),
		).toThrow();
		expect(() =>
			db
				.query(
					`UPDATE memory_state_item SET status = 'active', semantic_key = 'key-a' WHERE item_id = 'b'`,
				)
				.run(),
		).toThrow();
		expect(() =>
			db.query("DELETE FROM memory_state_item WHERE item_id = 'a'").run(),
		).toThrow();
	});
});
