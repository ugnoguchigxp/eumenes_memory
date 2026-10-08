import type { TombstoneTargetType } from "../contracts/lifecycle.ts";
import type { MemoryDb } from "./db.ts";

/**
 * 墓標の有無。読み出し SQL は status 列に加えて墓標の不存在を必須条件にする（二重化、§2.5-1）。
 * この関数は単発の事前検査用で、一覧系の SQL は `NOT EXISTS (SELECT 1 FROM memory_tombstone ...)` を直接書く。
 */
export function isTombstoned(
	db: MemoryDb,
	targetType: TombstoneTargetType,
	targetId: string,
): boolean {
	const row = db
		.query(
			"SELECT 1 AS found FROM memory_tombstone WHERE target_type = ? AND target_id = ?",
		)
		.get(targetType, targetId);
	return row !== null && row !== undefined;
}
