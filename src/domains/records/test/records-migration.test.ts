import { afterEach, describe, expect, test } from "bun:test";
import {
	RECORD_CAPTURE_STATES,
	RECORD_MEDIA_TYPES,
	RECORD_STATUSES,
} from "../contracts/index.ts";
import { sql } from "../migrations/0002-records.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function checkList(column: string): string[] {
	const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(sql);
	return [...(match?.[1] ?? "").matchAll(/'([^']*)'/g)].map(
		(m) => m[1] as string,
	);
}

describe("migration 0002 records", () => {
	test("CHECK lists match the contract tuples (forgotten is the extra, row-only status)", () => {
		expect(checkList("media_type")).toEqual([...RECORD_MEDIA_TYPES]);
		expect(checkList("capture_state")).toEqual([...RECORD_CAPTURE_STATES]);
		expect(checkList("status")).toEqual([...RECORD_STATUSES, "forgotten"]);
	});

	test("creates the tables and the no-resurrection triggers; the full-text index is gone", () => {
		store = openTestStore();
		const db = (store as TestStore).writer;
		const names = (type: string) =>
			(
				db
					.query(
						"SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'memory\\_record%' ESCAPE '\\' ORDER BY name",
					)
					.all(type) as { name: string }[]
			).map((row) => row.name);
		expect(names("table")).toEqual(
			expect.arrayContaining([
				"memory_record",
				"memory_record_body",
				"memory_record_provider",
				"memory_record_revision",
			]),
		);
		expect(names("trigger")).toEqual([
			"memory_record_body_no_resurrection",
			"memory_record_no_resurrection",
			"memory_record_revision_no_resurrection",
		]);
		expect(names("table")).not.toContain("memory_record_fts");
	});

	test("the SQL body avoids transaction-control keywords the store hygiene check looks for", () => {
		expect(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/.test(sql)).toBe(false);
		expect(/INSERT OR IGNORE/i.test(sql)).toBe(false);
	});

	test("the trigger really refuses a tombstoned record_id on the record, revision and body tables", () => {
		store = openTestStore();
		store.writer.exec(
			"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('record', 'rec:x', 'p', 's', 'f', 1, 1)",
		);
		const attempts = [
			"INSERT INTO memory_record VALUES ('rec:x','p','s','a','b','c','text/plain','complete','active','r',1,1)",
			"INSERT INTO memory_record_body (record_id, revision, representation, content) VALUES ('rec:x','r','text','c')",
			"INSERT INTO memory_record_revision VALUES ('rec:x','r','d',1,1,1)",
		];
		for (const attempt of attempts) {
			expect(() => store?.writer.exec(attempt)).toThrow(/memory_tombstoned/);
		}
	});
});
