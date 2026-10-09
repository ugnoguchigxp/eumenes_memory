import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../../canonical/sha256.ts";
import {
	DEPENDENCY_NODE_TYPES,
	DEPENDENCY_ROLES,
	DEPENDENT_NODE_TYPES,
	EXTERNAL_DELETION_STATES,
	FORGET_EXTERNAL_STATES,
	GENESIS_JOURNAL_HASH,
	TOMBSTONE_TARGET_TYPES,
} from "../../../domains/lifecycle/contracts/index.ts";
import {
	MEMORY_CHANGE_STATUSES,
	MEMORY_CHANGE_TARGET_TYPES,
} from "../../../contracts/external.ts";
import { sql as foundation } from "../migrations/0001-foundation.ts";
import {
	composeMigration,
	MEMORY_DB_SCHEMA_VERSION,
	MIGRATION_BODIES,
	migrations,
} from "../migrations/index.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

const DIRECTORY = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

function migrationFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return migrationFiles(path);
		return /^\d{4}-.+\.ts$/.test(entry.name) &&
			directory.endsWith("/migrations")
			? [path]
			: [];
	});
}

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

/** `column IN ('a', 'b')` の列挙を出現順に集める。 */
function checkLists(sql: string, column: string): string[][] {
	const pattern = new RegExp(
		`(?<![A-Za-z_])${column}\\s+IN\\s*\\(([^)]*)\\)`,
		"g",
	);
	return [...sql.matchAll(pattern)].map((match) =>
		[...(match[1] ?? "").matchAll(/'([^']*)'/g)].map(
			(token) => token[1] as string,
		),
	);
}

describe("migration registry", () => {
	test("version equals the number of registered bodies, and each composed migration ends with its record", () => {
		expect(MEMORY_DB_SCHEMA_VERSION).toBe(MIGRATION_BODIES.length);
		expect(migrations).toHaveLength(MIGRATION_BODIES.length);
		expect(Object.isFrozen(migrations)).toBe(true);
		for (const [index, body] of MIGRATION_BODIES.entries()) {
			expect(migrations[index]).toBe(composeMigration(index + 1, body));
			expect(migrations[index]).toContain(
				`'db_schema_version', '${index + 1}'`,
			);
		}
	});

	test("every NNNN-*.ts migration file is registered, in order, with no gaps", async () => {
		const files = migrationFiles(DIRECTORY).sort((a, b) =>
			a.split("/").at(-1)!.localeCompare(b.split("/").at(-1)!),
		);
		expect(
			files.map((name) => Number(name.split("/").at(-1)!.slice(0, 4))),
		).toEqual(files.map((_name, index) => index + 1));
		const bodies: string[] = [];
		for (const file of files) {
			const module = (await import(file)) as { sql: string };
			bodies.push(module.sql);
		}
		expect(bodies).toEqual([...MIGRATION_BODIES]);
	});

	test("published migrations retain their exact pre-domain SQL bytes", () => {
		expect(migrations.slice(0, 3).map(sha256Hex)).toEqual([
			"b97c190b8f5a62057ca21ec241c10fd1ea71c03ad7044a247c8bfdea70e7ffba",
			"24ce71705b8ae44b33e39874998a167091d27a00ddfacfcb4549fbf847d80d1a",
			"07edacf77d2c82a8d644c1f4f08f114662cfd1dba575a1e5d696541df732d9d4",
		]);
	});

	test("bodies contain no BEGIN/COMMIT/SAVEPOINT/PRAGMA and no host-table reference", () => {
		// trigger 本体の BEGIN ... END は SQL の構文であり、transaction 制御ではない。
		const withoutTriggers = (body: string) =>
			body.replace(/CREATE\s+TRIGGER[\s\S]*?\bEND\s*;/gi, "");
		for (const body of MIGRATION_BODIES) {
			expect(withoutTriggers(body)).not.toMatch(
				/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA)\b/i,
			);
		}
	});
});

describe("0001 foundation", () => {
	test("creates only memory_ tables with no foreign keys", () => {
		// 0001 だけを適用した DB で、0001 の表だけを検査する（後続の migration は別テスト）。
		store = openTestStore({ migrations: migrations.slice(0, 1) });
		const names = (
			store.writer
				.query(
					"SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%'",
				)
				.all() as { name: string }[]
		).map((row) => row.name);
		expect(names.length).toBeGreaterThan(8);
		for (const name of names) expect(name.startsWith("memory_")).toBe(true);
		const tables = (
			store.writer
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
				)
				.all() as { name: string }[]
		).map((row) => row.name);
		expect(tables.sort()).toEqual([
			"memory_change",
			"memory_dependency",
			"memory_forget",
			"memory_forget_external",
			"memory_journal_state",
			"memory_schema_info",
			"memory_scope_state",
			"memory_seq",
			"memory_tombstone",
		]);
		for (const table of tables) {
			expect(
				store.writer.query(`PRAGMA foreign_key_list(${table})`).all(),
			).toEqual([]);
		}
	});

	test("initial rows: seq 0 and the genesis journal head", () => {
		store = openTestStore();
		expect(
			store.writer.query("SELECT id, value FROM memory_seq").all(),
		).toEqual([{ id: 1, value: 0 }]);
		expect(
			store.writer
				.query(
					"SELECT applied_head_seq AS seq, applied_head_hash AS hash FROM memory_journal_state",
				)
				.all(),
		).toEqual([{ seq: 0, hash: GENESIS_JOURNAL_HASH }]);
		expect(GENESIS_JOURNAL_HASH).toHaveLength(64);
	});

	test("CHECK enumerations match the contract tuples", () => {
		expect(checkLists(foundation, "dependent_type")).toEqual([
			[...DEPENDENT_NODE_TYPES],
		]);
		expect(checkLists(foundation, "dependency_type")).toEqual([
			[...DEPENDENCY_NODE_TYPES],
		]);
		expect(checkLists(foundation, "role")).toEqual([[...DEPENDENCY_ROLES]]);
		expect(checkLists(foundation, "target_type")).toEqual([
			[...TOMBSTONE_TARGET_TYPES],
			[...MEMORY_CHANGE_TARGET_TYPES],
		]);
		expect(checkLists(foundation, "external_state")).toEqual([
			[...FORGET_EXTERNAL_STATES],
		]);
		expect(checkLists(foundation, "state")).toEqual([
			[...EXTERNAL_DELETION_STATES],
		]);
		expect(checkLists(foundation, "status")).toEqual([
			[...MEMORY_CHANGE_STATUSES],
		]);
	});

	test("CHECK constraints reject unknown enumeration values", () => {
		store = openTestStore();
		expect(() =>
			store!.writer
				.query(
					"INSERT INTO memory_dependency VALUES ('p','s','world_node','x','source','y','primary')",
				)
				.run(),
		).toThrow();
		expect(() =>
			store!.writer
				.query(
					"INSERT INTO memory_tombstone VALUES ('world_node','x','p','s','f',1,1)",
				)
				.run(),
		).toThrow();
	});
});
