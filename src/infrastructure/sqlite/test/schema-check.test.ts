import { afterEach, describe, expect, test } from "bun:test";
import type { MemoryStoreError } from "../errors.ts";
import {
	assertMemorySchema,
	checkHostMigrations,
	checkSchemaAgainst,
} from "../schema-check.ts";
import {
	composeMigration,
	MEMORY_DB_SCHEMA_VERSION,
	MIGRATION_BODIES,
	migrationHash,
} from "../migrations/index.ts";
import { listMemoryChanges } from "../changes.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function open(): TestStore {
	store = openTestStore();
	return store;
}

function codeOf(operation: () => unknown): string | undefined {
	try {
		operation();
	} catch (error) {
		return (error as MemoryStoreError).code;
	}
	return undefined;
}

describe("checkHostMigrations", () => {
	const memory = MIGRATION_BODIES.map((body, index) =>
		composeMigration(index + 1, body),
	);

	test("accepts the memory migrations appended after host migrations, in order", () => {
		expect(checkHostMigrations(memory)).toEqual([]);
		expect(checkHostMigrations(["CREATE TABLE host(a);", ...memory])).toEqual(
			[],
		);
		const interleaved = memory.flatMap((sql, i) => [
			`CREATE TABLE h${i}(a);`,
			sql,
		]);
		expect(checkHostMigrations(interleaved)).toEqual([]);
	});

	test("reports missing, duplicated, reordered and edited migrations", () => {
		expect(checkHostMigrations([])).toHaveLength(memory.length);
		expect(checkHostMigrations([...memory, memory[0] as string])).toEqual([
			"memory migration 0001 appears 2 times",
		]);
		const swapped = [...memory];
		[swapped[1], swapped[2]] = [swapped[2] as string, swapped[1] as string];
		expect(checkHostMigrations(swapped)).toEqual([
			"memory migration 0003 is out of order",
		]);
		const edited = [...memory];
		edited[0] = `${edited[0]}\n-- edited`;
		expect(checkHostMigrations(edited)).toEqual([
			"memory migration 0001 is missing",
		]);
	});
});

describe("assertMemorySchema", () => {
	test("accepts a freshly migrated database and records version and hashes", () => {
		const s = open();
		expect(() => assertMemorySchema(s.writer)).not.toThrow();
		const rows = s.writer
			.query("SELECT key, value FROM memory_schema_info ORDER BY key")
			.all() as { key: string; value: string }[];
		expect(rows).toEqual([
			{ key: "db_schema_version", value: String(MEMORY_DB_SCHEMA_VERSION) },
			...MIGRATION_BODIES.map((body, index) => ({
				key: `migration_${index + 1}_sha256`,
				value: migrationHash(body),
			})),
		]);
	});

	test("detects a migration hash mismatch", () => {
		const s = open();
		s.writer.exec(
			"UPDATE memory_schema_info SET value = 'deadbeef' WHERE key = 'migration_1_sha256'",
		);
		expect(codeOf(() => assertMemorySchema(s.writer))).toBe("SCHEMA_MISMATCH");
	});

	test("detects a missing hash row and a missing or malformed version", () => {
		const s = open();
		s.writer.exec(
			"DELETE FROM memory_schema_info WHERE key = 'migration_1_sha256'",
		);
		expect(codeOf(() => assertMemorySchema(s.writer))).toBe("SCHEMA_MISMATCH");
		const t = openTestStore();
		try {
			t.writer.exec(
				"UPDATE memory_schema_info SET value = '01' WHERE key = 'db_schema_version'",
			);
			expect(codeOf(() => assertMemorySchema(t.writer))).toBe(
				"SCHEMA_MISMATCH",
			);
			t.writer.exec(
				"DELETE FROM memory_schema_info WHERE key = 'db_schema_version'",
			);
			expect(codeOf(() => assertMemorySchema(t.writer))).toBe(
				"SCHEMA_MISMATCH",
			);
		} finally {
			t.close();
		}
	});

	test("rejects a database whose version is newer than this package knows", () => {
		const s = open();
		s.writer.exec(
			`UPDATE memory_schema_info SET value = '${MEMORY_DB_SCHEMA_VERSION + 1}' WHERE key = 'db_schema_version'`,
		);
		expect(codeOf(() => assertMemorySchema(s.writer))).toBe("SCHEMA_TOO_NEW");
	});

	test("rejects a database without the memory tables", () => {
		store = openTestStore({ migrations: [] });
		expect(codeOf(() => assertMemorySchema(store!.writer))).toBe(
			"SCHEMA_MISSING",
		);
	});

	test("public operations check the schema on entry (too-new database is refused)", () => {
		const s = open();
		s.writer.exec(
			`UPDATE memory_schema_info SET value = '${MEMORY_DB_SCHEMA_VERSION + 1}' WHERE key = 'db_schema_version'`,
		);
		const input = {
			contractVersion: 1,
			access: {
				principal: "p",
				scopeKeys: ["s"],
				purpose: "x",
				policyRevision: "1",
			},
			scopeKeys: ["s"],
			afterSeq: 0,
			limit: 10,
		} as const;
		expect(codeOf(() => listMemoryChanges(s.writer, input))).toBe(
			"SCHEMA_TOO_NEW",
		);
	});
});

describe("checkSchemaAgainst (multi-migration situations)", () => {
	const extra = "CREATE TABLE memory_extra (id INTEGER PRIMARY KEY);";

	test("an older database than the expected bodies is OUTDATED", () => {
		const s = open();
		expect(
			codeOf(() => checkSchemaAgainst(s.writer, [...MIGRATION_BODIES, extra])),
		).toBe("SCHEMA_OUTDATED");
	});

	test("applying the next migration (body + record) makes the check pass", () => {
		const s = open();
		const bodies = [...MIGRATION_BODIES, extra];
		s.writer.exec(composeMigration(bodies.length, extra));
		expect(() => checkSchemaAgainst(s.writer, bodies)).not.toThrow();
		// 古い本体（既知が 1 本少ない）から見ると新しい DB
		expect(codeOf(() => checkSchemaAgainst(s.writer, MIGRATION_BODIES))).toBe(
			"SCHEMA_TOO_NEW",
		);
		// 途中の body を書き換えた本体は hash 不一致
		expect(
			codeOf(() =>
				checkSchemaAgainst(s.writer, [
					`${MIGRATION_BODIES[0]}\n-- edited`,
					...MIGRATION_BODIES.slice(1),
					extra,
				]),
			),
		).toBe("SCHEMA_MISMATCH");
	});
});
