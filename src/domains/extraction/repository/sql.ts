/** extraction repository の薄い SQL 補助（SQLite 例外を `MemoryStoreError` に変換する）。 */
import { guarded } from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";

export function run(db: MemoryDb, sql: string, params: SqlValue[]): void {
	guarded(() => db.query(sql).run(...params));
}

export function all(db: MemoryDb, sql: string, params: SqlValue[]): unknown[] {
	return guarded(() => db.query(sql).all(...params));
}

export function first(db: MemoryDb, sql: string, params: SqlValue[]): unknown {
	const row = guarded(() => db.query(sql).get(...params));
	return row === undefined ? null : row;
}

export function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}
