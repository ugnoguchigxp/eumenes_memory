import { assertWritable, issueSeq } from "./db.ts";
import type { MemoryDb } from "./db.ts";
import { assertMemorySchema } from "./schema-check.ts";

/**
 * 書き込み系の公開操作の入口。transaction 内であること → スキーマ版 → seq 発行（書き込み接続でなければ
 * ここで READONLY_CONNECTION）の順で検査し、この操作の seq を返す。
 * 設計書 §2.2 は seq 発行を最初の文としているが、migration 未適用の DB を SCHEMA_MISSING として報告するため
 * スキーマ検査（読み取りのみ）を seq 発行の前に置く。
 */
export function enterWrite(db: MemoryDb): number {
	assertWritable(db);
	assertMemorySchema(db);
	return issueSeq(db);
}

/**
 * 読み取り系の公開操作の入口。transaction は要求しない（複数文にまたがる一貫性は、ホストが
 * read transaction で囲むことに依存する。そのような関数は JSDoc に明記する）。
 */
export function enterRead(db: MemoryDb): void {
	assertMemorySchema(db);
}
