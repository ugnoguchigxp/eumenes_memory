/**
 * 公開サブパス "eumenes-memory/sqlite"（package self-reference）だけを使う利用テスト。
 * src 内部への相対 import はしない。ホストと同じ形（migration を 1 要素ずつ追記し、同期 op を
 * 1 transaction で実行する Writer）で、S0 の土台が使えることを確認する。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import type { AccessContext, MemoryChange } from "eumenes-memory";
import {
	assertMemorySchema,
	isMemoryStoreError,
	listMemoryChanges,
	MEMORY_DB_SCHEMA_VERSION,
	MemoryStoreError,
	migrations,
} from "eumenes-memory/sqlite";
import type { MemoryDb } from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

const ACCESS: AccessContext = {
	principal: "local:owner",
	scopeKeys: ["conversation:c1"],
	purpose: "dialogue.generate",
	policyRevision: "1",
};

describe("eumenes-memory/sqlite", () => {
	test("migrations are plain SQL strings the host appends one by one after its own", () => {
		expect(migrations.length).toBe(MEMORY_DB_SCHEMA_VERSION);
		for (const migration of migrations) expect(typeof migration).toBe("string");
		const hostMigrations = [
			"CREATE TABLE host_things (id INTEGER PRIMARY KEY);",
		];
		store = openTestStore({ migrations: [...hostMigrations, ...migrations] });
		const asPort: MemoryDb = store.writer;
		expect(() => assertMemorySchema(asPort)).not.toThrow();
		expect(
			store.writer
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'host_%'",
				)
				.get(),
		).toEqual({ n: 1 });
	});

	test("assertMemorySchema refuses a database that was not migrated or has been tampered with", () => {
		store = openTestStore({ migrations: [] });
		try {
			assertMemorySchema(store.writer);
			throw new Error("expected failure");
		} catch (error) {
			expect(isMemoryStoreError(error)).toBe(true);
			expect(error).toBeInstanceOf(MemoryStoreError);
			expect((error as MemoryStoreError).code).toBe("SCHEMA_MISSING");
		}
	});

	test("the change feed is empty on a fresh database and readable from the readonly connection", () => {
		store = openTestStore();
		const result = store.read((db) =>
			listMemoryChanges(db, {
				contractVersion: CONTRACT_VERSIONS.external,
				access: ACCESS,
				scopeKeys: ["conversation:c1"],
				afterSeq: 0,
				limit: 100,
			}),
		);
		const changes: readonly MemoryChange[] =
			result.status === "ok" ? result.changes : [];
		expect(result).toEqual({
			status: "ok",
			changes,
			nextAfterSeq: 0,
			hasMore: false,
		});
		expect(changes).toEqual([]);
	});
});
