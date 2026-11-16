/** S7: 全文検索の索引のホスト側（既存の DB への 0009 の適用、戻し方、SQLite の機能の検査、復元後の漏れ、起動時の検査）。 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { checkSchemaAgainst } from "../../../src/infrastructure/sqlite/schema-check.ts";
import { MIGRATION_BODIES } from "../../../src/infrastructure/sqlite/migrations/index.ts";
import { rollback0009 } from "../scripts/rollback-0009.ts";
import { initialize, openStandalone } from "../src/storage.ts";
import { restoreStore } from "../src/transport.ts";
import {
	fixture,
	forget,
	items,
	leakedTrigrams,
	remember,
	type Fixture,
} from "./support.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const SECRET = "ZQXWVU秘密の合言葉です";

function inspect(dir: string, sql: string): unknown[] {
	const db = new Database(join(dir, "memory.db"), { readonly: true });
	try {
		return db.query(sql).all();
	} finally {
		db.close();
	}
}
function searchObjects(dir: string): string[] {
	return (
		inspect(
			dir,
			"SELECT name FROM sqlite_master WHERE name LIKE 'memory_state_search%' OR name LIKE 'memory_state_fts%' ORDER BY name",
		) as { name: string }[]
	).map((x) => x.name);
}
function match(h: Fixture, term: string) {
	return h.owner.port.read((db) =>
		(db as unknown as Database)
			.query(
				"SELECT rowid FROM memory_state_fts WHERE memory_state_fts MATCH ?",
			)
			.all(`"${term}"`),
	);
}

test("T-MIG-2 the rollback script restores v8, an old binary accepts it, and the host re-applies 0009", async () => {
	const h = await fixture();
	await remember(h, "抹茶ラテが好きです");
	await h.close();
	expect(searchObjects(h.dir).length).toBeGreaterThan(0);
	expect(rollback0009(h.dir)).toEqual({ status: "completed" });
	expect(searchObjects(h.dir)).toEqual([]);
	expect(
		inspect(
			h.dir,
			"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_state_search%'",
		),
	).toEqual([]);
	// 版 8 の本体相当（0001〜0008 の body）で検査が通る。
	const db = new Database(join(h.dir, "memory.db"), { readonly: true });
	try {
		expect(() =>
			checkSchemaAgainst(db as never, MIGRATION_BODIES.slice(0, 8)),
		).not.toThrow();
		expect(() => checkSchemaAgainst(db as never, MIGRATION_BODIES)).toThrow(
			/SCHEMA_OUTDATED/,
		);
	} finally {
		db.close();
	}
	expect(rollback0009(h.dir)).toEqual({ status: "unchanged" });
	// 今の本体で開くと、0009 を適用し、既存の active な item を索引に入れる。
	await h.reopen();
	expect((await items(h)).length).toBe(1);
	expect(match(h, "抹茶ラテ").length).toBe(1);
});

test("rollback refuses while the owner is running", async () => {
	const h = await fixture();
	expect(() => rollback0009(h.dir)).toThrow("OWNER_ALREADY_RUNNING");
});

test("T-MIG-3 missing fts5 fails closed at startup", () => {
	const dir = mkdtempSync(join(tmpdir(), "emh-"));
	initialize(dir);
	expect(() =>
		openStandalone(dir, {
			features: () => ({ fts5: false, version: "3.53.4" }),
		}),
	).toThrow("SQLITE_FEATURE_MISSING");
	expect(() =>
		openStandalone(dir, {
			features: () => ({ fts5: true, version: "3.43.2" }),
		}),
	).toThrow("SQLITE_FEATURE_MISSING");
	// 失敗した後も lock は残らず、正しい環境なら開ける。
	const owner = openStandalone(dir);
	void owner.close();
});

test("T-LEAK-2 forget via journal reconcile on a restored DB", async () => {
	const h = await fixture();
	const saved = await remember(h, SECRET);
	const target = (await items(h))[0]!;
	const backup = await h.call("backup");
	const path = backup["path"] as string;
	expect(leakedTrigrams(SECRET, [path]).length).toBeGreaterThan(0);
	// 原文（出典）も一緒に消す。
	await forget(h, target.itemId, [saved.source["sourceHandle"]]);
	await h.host.backupIdle();
	await h.close();
	expect((await restoreStore(path, h.dir, () => h.clock.now)).status).toBe(
		"completed",
	);
	await h.reopen();
	expect(match(h, "ZQXWVU").length).toBe(0);
	expect(
		leakedTrigrams(
			SECRET,
			["memory.db", "memory.db-wal"].map((n) => join(h.dir, n)),
		),
	).toEqual([]);
});

test("startup rebuilds an inconsistent index; context and plan keep working", async () => {
	const h = await fixture();
	await remember(h, "抹茶ラテが好きです");
	await h.owner.port.write((db) => {
		(db as unknown as Database).query("DELETE FROM memory_state_fts").run();
	});
	expect(match(h, "抹茶ラテ").length).toBe(0);
	await h.restart();
	expect(h.host.searchIndexUnavailable).toBe(false);
	expect(match(h, "抹茶ラテ").length).toBe(1);
	expect((await items(h)).length).toBe(1);
});
