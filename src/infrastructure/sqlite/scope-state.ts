import { guarded, readInteger } from "./db.ts";
import type { MemoryDb } from "./db.ts";

/**
 * scope の Memory 状態版を +1 する（Memory 所有データが変わるたび、忘却を含む）。
 * 戻り値は更新後の版。view の stateRevision の Memory 側（`memoryRevision`）になる。
 * 書き込み系の操作の中（enterWrite 済み）で呼ぶ。
 */
export function bumpScopeRevision(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
): number {
	const row = guarded(() =>
		db
			.query(
				`INSERT INTO memory_scope_state (principal, scope_key, revision) VALUES (?, ?, 1)
				ON CONFLICT (principal, scope_key) DO UPDATE SET revision = revision + 1
				RETURNING revision`,
			)
			.get(principal, scopeKey),
	);
	return readInteger(row, "revision");
}

/** scope の現在の Memory 状態版。一度も変更されていない scope は 0。 */
export function readScopeRevision(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
): number {
	const row = db
		.query(
			"SELECT revision FROM memory_scope_state WHERE principal = ? AND scope_key = ?",
		)
		.get(principal, scopeKey);
	return row === null || row === undefined ? 0 : readInteger(row, "revision");
}
