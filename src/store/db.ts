/**
 * MemoryDb ポートと、書き込み／読み取りの共通部品（full-system-design §2.2）。
 * `bun:sqlite` を import しない。`MemoryDb` は構造的型付けで満たす（bun:sqlite の Database は
 * そのまま渡せる。互換性は `test/support/store.ts` の型検査で保証する）。
 * 本体は BEGIN / COMMIT / SAVEPOINT / `db.transaction()` を呼ばず、接続を開かず、グローバル状態を持たない。
 */
import { MemoryStoreError } from "./errors.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface MemoryStatement {
	all(...params: SqlValue[]): unknown[];
	/** 行なしは null（bun:sqlite）／undefined のどちらも許容する。 */
	get(...params: SqlValue[]): unknown;
	run(...params: SqlValue[]): unknown;
}

export interface MemoryDb {
	exec(sql: string): void;
	query(sql: string): MemoryStatement;
	/** bun:sqlite の Database は持つ。無い実装では transaction 外の検査を省略する。 */
	readonly inTransaction?: boolean;
}

/** SQLite の例外を MemoryStoreError に変換する。変換できないものはそのまま返す。 */
export function translateSqliteError(error: unknown): unknown {
	if (error instanceof MemoryStoreError) return error;
	if (!(error instanceof Error)) return error;
	const code: unknown = (error as unknown as Record<string, unknown>)["code"];
	if (typeof code === "string" && code.startsWith("SQLITE_READONLY")) {
		return new MemoryStoreError("READONLY_CONNECTION");
	}
	if (error.message.includes("attempt to write a readonly database")) {
		return new MemoryStoreError("READONLY_CONNECTION");
	}
	if (error.message.includes("memory_tombstoned")) {
		return new MemoryStoreError("TOMBSTONED");
	}
	if (error.message.includes("no such table: memory_")) {
		return new MemoryStoreError("SCHEMA_MISSING");
	}
	return error;
}

/** 文を実行し、SQLite の例外を変換して投げ直す。 */
export function guarded<T>(operation: () => T): T {
	try {
		return operation();
	} catch (error) {
		throw translateSqliteError(error);
	}
}

/** 書き込み系の入口の検査 1: transaction の中であること（`inTransaction === false` なら拒否）。 */
export function assertWritable(db: MemoryDb): void {
	if (db.inTransaction === false) {
		throw new MemoryStoreError("NOT_IN_TRANSACTION");
	}
}

/**
 * 単調な seq を 1 つ発行する（時計の代替）。書き込みの実体を伴う最初の文なので、
 * 読み取り専用接続はここで `READONLY_CONNECTION` になる。
 */
export function issueSeq(db: MemoryDb): number {
	const row = guarded(() =>
		db
			.query(
				"UPDATE memory_seq SET value = value + 1 WHERE id = 1 RETURNING value",
			)
			.get(),
	);
	if (row === null || row === undefined) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	return readInteger(row, "value");
}

// ---- 行の読み取り（行は unknown として受け、列を検査する）----

export function readRow(row: unknown): Readonly<Record<string, unknown>> {
	if (typeof row !== "object" || row === null || Array.isArray(row)) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	return row as Readonly<Record<string, unknown>>;
}

function column(row: unknown, name: string): unknown {
	const record = readRow(row);
	if (!Object.hasOwn(record, name)) throw new MemoryStoreError("CORRUPT_ROW");
	return record[name];
}

export function readInteger(row: unknown, name: string): number {
	const value = column(row, name);
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (
		typeof value === "bigint" &&
		value >= BigInt(Number.MIN_SAFE_INTEGER) &&
		value <= BigInt(Number.MAX_SAFE_INTEGER)
	) {
		return Number(value);
	}
	throw new MemoryStoreError("CORRUPT_ROW");
}

export function readText(row: unknown, name: string): string {
	const value = column(row, name);
	if (typeof value !== "string") throw new MemoryStoreError("CORRUPT_ROW");
	return value;
}

export function readNullableText(row: unknown, name: string): string | null {
	const value = column(row, name);
	if (value === null) return null;
	if (typeof value !== "string") throw new MemoryStoreError("CORRUPT_ROW");
	return value;
}

export function readNullableInteger(row: unknown, name: string): number | null {
	const value = column(row, name);
	if (value === null) return null;
	return readInteger(row, name);
}
