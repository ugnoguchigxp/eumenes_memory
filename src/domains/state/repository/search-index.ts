/**
 * State の全文検索の索引の保守（設計 `spec/state-search-design.md` §3.3〜3.4、migration 0009）。
 *
 * - 削除は migration 0009 の trigger が必ず行う。追加は書き込み関数の最後に `syncStateSearch` が行う。
 * - 索引は候補の ID を出すだけで、本文の正本ではない。返す item は必ず `memory_state_item` から読み直す。
 * - どの関数もホストの transaction の中で呼ぶ（transaction の制御はしない）。
 */
import {
	assertWritable,
	guarded,
	readInteger,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { assertMemorySchema } from "../../../infrastructure/sqlite/schema-check.ts";

/** 索引を作り直すときの FTS 表の定義（migration 0009 と同じ）。 */
const FTS_TABLE_SQL =
	"CREATE VIRTUAL TABLE memory_state_fts USING fts5(doc, tokenize = 'trigram case_sensitive 0')";
const FTS_SECURE_DELETE_SQL =
	"INSERT INTO memory_state_fts (memory_state_fts, rank) VALUES ('secure-delete', 1)";

/**
 * 渡した item の索引の行を、正本から登録し直す。active でない item は登録しない（対応表は trigger が消す）。
 * 書き込み関数の中から呼ぶ内部の関数（公開面には出さない）。
 */
export function syncStateSearch(
	db: MemoryDb,
	itemIds: readonly string[],
): void {
	for (const itemId of new Set(itemIds)) {
		guarded(() => {
			db.query(
				`INSERT INTO memory_state_search_row (item_id)
				SELECT item_id FROM memory_state_item WHERE item_id = ? AND status = 'active'
				ON CONFLICT (item_id) DO NOTHING`,
			).run(itemId);
			db.query(
				`DELETE FROM memory_state_fts WHERE rowid =
					(SELECT search_rowid FROM memory_state_search_row WHERE item_id = ?)`,
			).run(itemId);
			db.query(
				`INSERT INTO memory_state_fts (rowid, doc)
				SELECT r.search_rowid, d.doc FROM memory_state_search_doc d
				JOIN memory_state_search_row r ON r.item_id = d.item_id
				WHERE d.item_id = ?`,
			).run(itemId);
		});
	}
}

export interface StateSearchIndexReport {
	readonly status: "ok";
	/** 索引が active な item の集合と一致し、FTS5 の integrity-check も通った。 */
	readonly consistent: boolean;
	readonly activeItems: number;
	readonly mappedRows: number;
	readonly indexedRows: number;
	/** 対応表にあるのに索引に行が無い（再登録の漏れ）、または active でない item の行。 */
	readonly missingRows: number;
	readonly integrity: boolean;
}

function count(db: MemoryDb, sql: string): number {
	const row = guarded(() => db.query(sql).get());
	return readInteger(row, "n");
}

/**
 * 索引を検査する（読み取りのみ）。active な item の数、対応表の数、索引の行の数が一致し、
 * 対応表のすべての行が active な item と索引の行を指し、FTS5 の integrity-check が通れば一致とする。
 */
export function verifyStateSearchIndex(db: MemoryDb): StateSearchIndexReport {
	assertMemorySchema(db);
	const activeItems = count(
		db,
		"SELECT count(*) AS n FROM memory_state_item WHERE status = 'active'",
	);
	const mappedRows = count(
		db,
		"SELECT count(*) AS n FROM memory_state_search_row",
	);
	const indexedRows = count(db, "SELECT count(*) AS n FROM memory_state_fts");
	const missingRows = count(
		db,
		`SELECT count(*) AS n FROM memory_state_search_row r
		LEFT JOIN memory_state_item i ON i.item_id = r.item_id
		WHERE i.status IS NOT 'active'
			OR NOT EXISTS (SELECT 1 FROM memory_state_fts f WHERE f.rowid = r.search_rowid)`,
	);
	let integrity = true;
	try {
		db.query(
			"INSERT INTO memory_state_fts (memory_state_fts, rank) VALUES ('integrity-check', 1)",
		).run();
	} catch {
		integrity = false;
	}
	return {
		status: "ok",
		consistent:
			integrity &&
			missingRows === 0 &&
			activeItems === mappedRows &&
			mappedRows === indexedRows,
		activeItems,
		mappedRows,
		indexedRows,
		missingRows,
		integrity,
	};
}

/**
 * 索引を作り直す（FTS 表を DROP → CREATE → `secure-delete` → 対応表を空にして、正本から全件を登録）。
 * ホストの write transaction の中で呼ぶ。trigger は表の名前で索引を参照するので、そのまま働く。
 */
export function rebuildStateSearchIndex(db: MemoryDb): StateSearchIndexReport {
	assertWritable(db);
	assertMemorySchema(db);
	guarded(() => {
		db.query("DROP TABLE IF EXISTS memory_state_fts").run();
		db.query(FTS_TABLE_SQL).run();
		db.query(FTS_SECURE_DELETE_SQL).run();
		db.query("DELETE FROM memory_state_search_row").run();
		db.query(
			"INSERT INTO memory_state_search_row (item_id) SELECT item_id FROM memory_state_search_doc",
		).run();
		db.query(
			`INSERT INTO memory_state_fts (rowid, doc)
			SELECT r.search_rowid, d.doc FROM memory_state_search_doc d
			JOIN memory_state_search_row r ON r.item_id = d.item_id`,
		).run();
	});
	return verifyStateSearchIndex(db);
}
