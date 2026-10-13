import { guarded, readRow, readText } from "./db.ts";
import type { MemoryDb } from "./db.ts";
import { MemoryStoreError } from "./errors.ts";
import {
	composeMigration,
	MIGRATION_BODIES,
	migrationHash,
} from "./migrations/index.ts";

/**
 * DB の `memory_schema_info` を、期待する migration body の列と照合する（1 回の SELECT）。
 * - テーブルが無い → `SCHEMA_MISSING`
 * - 版（`db_schema_version`）が欠落・不正、既知範囲の hash が欠落／不一致 → `SCHEMA_MISMATCH`
 * - 版が期待より新しい → `SCHEMA_TOO_NEW`（古い本体が新しい DB に接続した）
 * - 版が期待より古い → `SCHEMA_OUTDATED`（ホストが最新の migration を適用していない）
 * `assertMemorySchema` はこれに登録済みの body を渡すだけ。テストが複数 migration の状況を作るために公開している。
 */
export function checkSchemaAgainst(
	db: MemoryDb,
	bodies: readonly string[],
): void {
	checkSchemaAgainstHashes(db, bodies.map(migrationHash));
}

/** `checkSchemaAgainst` の本体。期待する hash の列（添字 + 1 が migration 番号）を直接受け取る。 */
function checkSchemaAgainstHashes(
	db: MemoryDb,
	hashes: readonly string[],
): void {
	const rows = guarded(() =>
		db.query("SELECT key, value FROM memory_schema_info").all(),
	);
	const info = new Map<string, string>();
	for (const row of rows) {
		const record = readRow(row);
		info.set(readText(record, "key"), readText(record, "value"));
	}
	const versionText = info.get("db_schema_version");
	if (versionText === undefined || !/^[1-9][0-9]{0,8}$/.test(versionText)) {
		throw new MemoryStoreError("SCHEMA_MISMATCH");
	}
	const version = Number(versionText);
	if (version > hashes.length) throw new MemoryStoreError("SCHEMA_TOO_NEW");
	for (let n = 1; n <= version; n += 1) {
		const expected = hashes[n - 1];
		if (expected === undefined) throw new MemoryStoreError("SCHEMA_MISMATCH");
		if (info.get(`migration_${n}_sha256`) !== expected) {
			throw new MemoryStoreError("SCHEMA_MISMATCH");
		}
	}
	if (version < hashes.length) throw new MemoryStoreError("SCHEMA_OUTDATED");
}

/**
 * 登録済み migration body の SHA-256。モジュール読み込み時に 1 回だけ計算する（`MIGRATION_BODIES` は凍結済みで、
 * 状態を持たない定数）。公開操作ごとに全 body を再ハッシュしない。
 */
const MIGRATION_HASHES: readonly string[] = Object.freeze(
	MIGRATION_BODIES.map(migrationHash),
);

/**
 * 全公開操作の入口で呼ぶ。DB の版が本体の既知の版と一致し、既知の各 migration の hash が
 * 本体の SQL と一致することを確認する。不一致は `MemoryStoreError`（SCHEMA_*）。
 */
export function assertMemorySchema(db: MemoryDb): void {
	checkSchemaAgainstHashes(db, MIGRATION_HASHES);
}

/**
 * ホストの migration 配列（`[...hostMigrations, ...migrations]` の形で本体を追記したもの）を検査する。
 * 本体の各 migration が、順序を保ち、各 1 本ずつ、中身が一致して含まれていなければ問題を返す。空なら正しい。
 * ホストは自分のテストで `expect(checkHostMigrations(hostMigrations)).toEqual([])` を呼ぶ。
 */
export function checkHostMigrations(
	hostMigrations: readonly string[],
): string[] {
	const problems: string[] = [];
	let from = 0;
	MIGRATION_BODIES.forEach((body, index) => {
		const expected = composeMigration(index + 1, body);
		const matches: number[] = [];
		hostMigrations.forEach((candidate, position) => {
			if (candidate === expected) matches.push(position);
		});
		const label = `memory migration ${String(index + 1).padStart(4, "0")}`;
		const first = matches[0];
		if (first === undefined) problems.push(`${label} is missing`);
		else if (matches.length > 1)
			problems.push(`${label} appears ${matches.length} times`);
		else if (first < from) problems.push(`${label} is out of order`);
		else from = first;
	});
	return problems;
}
