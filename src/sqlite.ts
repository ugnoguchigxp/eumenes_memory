/**
 * `eumenes-memory/sqlite`: 永続 API の公開面。ロジックを置かない（再 export のみ）。
 * `bun:sqlite` を import しない。接続・transaction・PRAGMA・flock はホストの責任で、ここの関数は
 * ホストが渡す `MemoryDb` に対する同期関数と、スキーマ定義（migrations）だけを提供する。
 * 起動手順と運用規則は `src/infrastructure/sqlite/README.md`、migration の追加手順は `src/infrastructure/sqlite/migrations/README.md`。
 *
 * 提供する関数: `listMemoryChanges` / `latestMemoryChangeSeq`、`assertMemorySchema`、`migrations`、`MemoryStoreError`、
 * Records（`captureRecord` / `readRecord` と、再生成可能な資料の `retainRecord` ほか）、State（`assertUserState` / `listState` / `readStateFact` と状態遷移）、
 * Lifecycle（`planForget` / `applyForget` / `reconcileForgetJournal` / `getForgetReceipt` / `recordExternalDeletion`）、
 * ExternalDependent の登録・解除。World / Consolidation は別ドメイン・別リポジトリ（接続部は ExternalDependent と変更フィードだけ）。
 */
export type {
	MemoryDb,
	MemoryStatement,
	SqlValue,
} from "./infrastructure/sqlite/db.ts";
export {
	MemoryStoreError,
	STORE_ERROR_CODES,
	isMemoryStoreError,
} from "./infrastructure/sqlite/errors.ts";
export type { StoreErrorCode } from "./infrastructure/sqlite/errors.ts";
export {
	assertMemorySchema,
	checkHostMigrations,
} from "./infrastructure/sqlite/schema-check.ts";
export {
	MEMORY_DB_SCHEMA_VERSION,
	migrations,
} from "./infrastructure/sqlite/migrations/index.ts";

export {
	assertUserState,
	deactivateState,
	listState,
	reactivateState,
	readStateFact,
	retractState,
} from "./domains/state/sqlite.ts";
export {
	applyForget,
	getForgetReceipt,
	planForget,
	reconcileForgetJournal,
	recordExternalDeletion,
	registerExternalDependents,
	unregisterExternalDependents,
} from "./domains/lifecycle/sqlite.ts";
export {
	latestMemoryChangeSeq,
	listMemoryChanges,
} from "./infrastructure/sqlite/changes.ts";

// 入出力の型（値の定数は "eumenes-memory" から import する）。
export type * from "./contracts/common.ts";
export type * from "./domains/records/contracts/index.ts";
export type * from "./domains/records/contracts/retention.ts";
export {
	captureRecord,
	readRecord,
	retainRecord,
	readRetainedRecord,
	useRetainedRecord,
	retainedRecordStats,
	evictRetainedRecords,
} from "./domains/records/sqlite.ts";
export type * from "./domains/state/contracts/index.ts";
export type * from "./domains/lifecycle/contracts/index.ts";
export type * from "./contracts/external.ts";
