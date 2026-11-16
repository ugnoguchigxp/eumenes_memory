#!/usr/bin/env bun
/**
 * 核の migration 0009（State の全文検索の索引）を戻す（設計 `spec/state-search-design.md` §5）。
 * サーバーを止めてから実行する（所有者の lock が取れなければ止める）。trigger・FTS 表・view・対応表を DROP し、
 * `memory_schema_info` から `migration_9_sha256` を消して版を 8 に戻し、その後 VACUUM する。
 * 索引は派生物なので、消しても情報は失われない。忘却のジャーナルと受領記録には触らない。
 *
 * 使い方: bun packages/host/scripts/rollback-0009.ts <directory>
 * 注意: 今の本体で開き直すと、0009 はまた適用される。戻すのは古い本体へ戻すときだけ。
 */
import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const ROLLBACK_0009_SQL = `
DROP TRIGGER IF EXISTS memory_state_search_item_update;
DROP TRIGGER IF EXISTS memory_state_search_attribute_insert;
DROP TRIGGER IF EXISTS memory_state_search_attribute_delete;
DROP TRIGGER IF EXISTS memory_state_search_item_delete;
DROP TABLE IF EXISTS memory_state_fts;
DROP VIEW IF EXISTS memory_state_search_doc;
DROP TABLE IF EXISTS memory_state_search_row;
DELETE FROM memory_schema_info WHERE key = 'migration_9_sha256';
UPDATE memory_schema_info SET value = '8' WHERE key = 'db_schema_version';
`;

export function rollback0009(directory: string): {
	status: "completed" | "unchanged";
} {
	const root = realpathSync(directory);
	const path = join(root, "memory.db");
	if (!existsSync(path)) throw new Error("STORE_MISSING");
	const lock = new Database(join(root, "owner.lock"));
	try {
		try {
			lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
		} catch {
			throw new Error("OWNER_ALREADY_RUNNING");
		}
		const db = new Database(path);
		try {
			db.exec("PRAGMA secure_delete=ON");
			const row = db
				.query(
					"SELECT value FROM memory_schema_info WHERE key='db_schema_version'",
				)
				.get() as { value: string } | null;
			if (row?.value === "8") return { status: "unchanged" };
			if (row?.value !== "9") throw new Error("SCHEMA_VERSION_NOT_9");
			db.transaction(() => db.exec(ROLLBACK_0009_SQL))();
			// FTS の写しのページを確実に消す。
			db.exec("VACUUM");
			db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
			return { status: "completed" };
		} finally {
			db.close();
		}
	} finally {
		lock.close();
	}
}

if (import.meta.main) {
	const directory = process.argv[2];
	if (!directory || process.argv.length !== 3) {
		console.error(
			"Usage: bun packages/host/scripts/rollback-0009.ts <directory>",
		);
		process.exitCode = 2;
	} else {
		try {
			console.log(JSON.stringify(rollback0009(directory)));
		} catch (error) {
			console.error(
				JSON.stringify({ status: "failed", code: (error as Error).message }),
			);
			process.exitCode = 1;
		}
	}
}
