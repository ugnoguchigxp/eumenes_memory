/**
 * migration の登録配列。順序を一元管理し、各ドメインがSQL本文を所有する。
 * 登録手順は同じディレクトリの README.md。
 *
 * 各 `NNNN-<name>.ts` は SQL 本文（body）を 1 本 `export const sql` する。version / hash の記録は
 * ここで末尾に付ける（SQL は自分自身の hash を書けないため）。ホストに渡す `migrations` は
 * body + 記録文で、DB に保存される hash は body の SHA-256 hex。
 */
import { sha256Hex } from "../../../canonical/sha256.ts";
import { sql as foundation } from "./0001-foundation.ts";
import { sql as records } from "../../../domains/records/migrations/0002-records.ts";
import { sql as state } from "../../../domains/state/migrations/0003-state.ts";
import { sql as stateValidity } from "../../../domains/state/migrations/0004-state-validity.ts";
import { sql as stateAgentOrigin } from "../../../domains/state/migrations/0007-state-agent-origin.ts";
import { sql as retentionForget } from "../../../domains/records/migrations/0006-retention-forget.ts";
import { sql as recordRetention } from "../../../domains/records/migrations/0005-record-retention.ts";
import { sql as removeExtractionAndRecall } from "./0008-remove-extraction-and-recall.ts";

/** 登録済み migration の body。添字 + 1 が migration 番号（DB の版）。順序は変えない・途中に挿入しない。 */
export const MIGRATION_BODIES: readonly string[] = Object.freeze([
	foundation,
	records,
	state,
	stateValidity,
	recordRetention,
	retentionForget,
	stateAgentOrigin,
	removeExtractionAndRecall,
]);

/** body の SHA-256 hex（`memory_schema_info.migration_<n>_sha256` に保存される値）。 */
export function migrationHash(body: string): string {
	return sha256Hex(body);
}

/** body の末尾に版と hash の記録を付ける。n は 1 始まりの migration 番号。 */
export function composeMigration(n: number, body: string): string {
	return `${body.trimEnd()}
INSERT OR REPLACE INTO memory_schema_info (key, value) VALUES
	('migration_${n}_sha256', '${migrationHash(body)}'),
	('db_schema_version', '${n}');
`;
}

/** ホストに渡す migration（各要素を 1 本ずつホストの配列の末尾へ追記する）。 */
export const migrations: readonly string[] = Object.freeze(
	MIGRATION_BODIES.map((body, index) => composeMigration(index + 1, body)),
);

/** 本体が知る DB スキーマ版 = 登録済み migration の本数。契約版とは独立。 */
export const MEMORY_DB_SCHEMA_VERSION: number = MIGRATION_BODIES.length;
