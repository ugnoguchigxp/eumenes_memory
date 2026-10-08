/**
 * `eumenes-memory/sqlite`: 永続 API の公開面。ロジックを置かない（再 export のみ）。
 * `bun:sqlite` を import しない。接続・transaction・PRAGMA・flock はホストの責任で、ここの関数は
 * ホストが渡す `MemoryDb` に対する同期関数と、スキーマ定義（migrations）だけを提供する。
 * 起動手順と運用規則は `src/store/README.md`、migration の追加手順は `src/store/migrations/README.md`。
 *
 * 実装済み（S0〜S6）: `listMemoryChanges`、`assertMemorySchema`、`migrations`、`MemoryStoreError`、Records / Recall / State /
 * Extraction / Lifecycle（`planForget` / `applyForget` / `reconcileForgetJournal` / `getForgetReceipt` / `recordExternalDeletion`）、
 * ExternalDependent の登録・解除。World / Consolidation は別ドメイン・別リポジトリ（接続部は ExternalDependent と変更フィードだけ）。
 * 到達段階は `spec/verification-status.md`。
 */
export type { MemoryDb, MemoryStatement, SqlValue } from "./store/db.ts";
export {
	MemoryStoreError,
	STORE_ERROR_CODES,
	isMemoryStoreError,
} from "./store/errors.ts";
export type { StoreErrorCode } from "./store/errors.ts";
export { assertMemorySchema } from "./store/schema-check.ts";
export {
	MEMORY_DB_SCHEMA_VERSION,
	migrations,
} from "./store/migrations/index.ts";

export {
	captureRecord,
	deactivateRecord,
	reactivateRecord,
	readRecord,
	readRecordRange,
	recordSourceStates,
} from "./store/records.ts";
export { searchRecords } from "./store/recall.ts";
export {
	assertUserState,
	deactivateState,
	editState,
	listState,
	reactivateState,
	readMemorySnapshotPart,
	retractState,
} from "./store/state.ts";
export {
	confirmCandidate,
	listCandidates,
	prepareExtraction,
	settleExtraction,
} from "./store/extraction.ts";
export {
	applyForget,
	getForgetReceipt,
	planForget,
	reconcileForgetJournal,
	recordExternalDeletion,
	registerExternalDependents,
	unregisterExternalDependents,
} from "./store/lifecycle.ts";
export { listMemoryChanges } from "./store/changes.ts";

// 入出力の型（値の定数は "eumenes-memory" から import する）。
export type * from "./contracts/common.ts";
export type * from "./contracts/records.ts";
export type * from "./contracts/recall.ts";
export type * from "./contracts/state.ts";
export type * from "./contracts/extraction.ts";
export type * from "./contracts/lifecycle.ts";
export type * from "./contracts/external.ts";
