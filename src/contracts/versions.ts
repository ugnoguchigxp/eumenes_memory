/**
 * 契約版の一覧。
 * - family 入力の `contractVersion` は family ごとの版。未知版は `UNSUPPORTED_SCHEMA_VERSION`。
 * - DB スキーマ版 `MEMORY_DB_SCHEMA_VERSION`（`./sqlite`）は契約版と独立。
 *
 * world / consolidation はこの repo では作らない（別ドメイン・別 repo）。
 */
export const CONTRACT_VERSIONS = Object.freeze({
	records: 1,
	state: 1,
	lifecycle: 1,
	/** ExternalDependent の登録と変更フィード（`listMemoryChanges`）。 */
	external: 1,
} as const);
