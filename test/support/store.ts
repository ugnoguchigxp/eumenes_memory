/**
 * テスト用 Writer（ホストの `store.write` / `store.read` 相当）。`bun:sqlite` を import してよいのは
 * このディレクトリだけ。本体の公開面（"eumenes-memory/sqlite"）だけを import する。
 *
 * Eumenes の `openStore` と同じ形にする:
 * - 書き込み接続 1 本 + 読み取り専用接続 1 本（WAL、ファイル DB）。
 * - `write(op)` は同期関数 `op` を 1 つの transaction 内で実行する（Eumenes は直列化された非同期キューだが、
 *   テストでは同期で十分）。`op` が例外を投げたら rollback。
 * - `read(op)` は読み取り専用接続の read transaction で実行する。
 * - migration はホストの配列に各要素を 1 本ずつ追記する形で適用する（1 要素 1 exec）。
 * DB は使い捨て。テストごとに作り、`close()` で一時ディレクトリごと消す。
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryMigrations } from "eumenes-memory/sqlite";
import type { MemoryDb } from "eumenes-memory/sqlite";

export interface TestStoreOptions {
	/** 適用する migration（既定: 本体の `migrations`）。`[]` で未適用の DB。 */
	readonly migrations?: readonly string[];
	/** true なら ":memory:"（読み取り専用接続なし。`read` は書き込み接続を使う）。 */
	readonly inMemory?: boolean;
	/** 既存の DB ファイル（`snapshotTo` で複製したもの）を開く。migration は適用しない。 */
	readonly fromFile?: string;
}

export interface TestStore {
	/** ファイル DB のパス（inMemory は ":memory:"）。 */
	readonly path: string;
	/** 型の互換性検査を兼ねる: bun:sqlite の Database は MemoryDb として渡せる。 */
	readonly writer: Database & MemoryDb;
	readonly reader: Database & MemoryDb;
	write<T>(op: (db: MemoryDb) => T): T;
	read<T>(op: (db: MemoryDb) => T): T;
	/**
	 * checkpoint(TRUNCATE) して DB ファイルを `label` つきの別ファイルへ複製し、そのパスを返す。
	 * 「忘却前に複製した DB を復元する」シナリオ（F03）用。
	 */
	snapshotTo(label: string): string;
	close(): void;
}

export function openTestStore(options: TestStoreOptions = {}): TestStore {
	const directory = mkdtempSync(join(tmpdir(), "memory-store-"));
	const inMemory = options.inMemory === true;
	const path = inMemory ? ":memory:" : join(directory, "memory.db");
	if (options.fromFile !== undefined) {
		copyFileSync(options.fromFile, path);
	}
	const writer = new Database(path, { create: true });
	if (!inMemory) writer.exec("PRAGMA journal_mode = WAL");
	writer.exec("PRAGMA foreign_keys = ON");
	if (options.fromFile === undefined) {
		for (const migration of options.migrations ?? memoryMigrations) {
			writer.exec(migration);
		}
	}
	const reader = inMemory ? writer : new Database(path, { readonly: true });
	if (!inMemory) reader.exec("PRAGMA foreign_keys = ON");
	let copies = 0;
	return {
		path,
		writer,
		reader,
		write: (op) => writer.transaction(() => op(writer))(),
		read: (op) =>
			inMemory ? op(writer) : reader.transaction(() => op(reader))(),
		snapshotTo(label) {
			if (inMemory) throw new Error("snapshotTo needs a file database");
			writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			copies += 1;
			const target = join(directory, `snapshot-${copies}-${label}.db`);
			copyFileSync(path, target);
			return target;
		},
		close() {
			if (reader !== writer) reader.close();
			writer.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
