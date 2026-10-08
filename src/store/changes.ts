import {
	MEMORY_CHANGE_STATUSES,
	MEMORY_CHANGE_TARGET_TYPES,
} from "../contracts/external.ts";
import type {
	ListMemoryChangesInput,
	ListMemoryChangesResult,
	MemoryChange,
	MemoryChangeDraft,
} from "../contracts/external.ts";
import { parseListMemoryChangesInput } from "../contracts/parse-store.ts";
import {
	guarded,
	issueSeq,
	readInteger,
	readNullableText,
	readText,
} from "./db.ts";
import type { MemoryDb, SqlValue } from "./db.ts";
import { MemoryStoreError } from "./errors.ts";
import { enterRead } from "./session.ts";

/**
 * 変更フィードへ 1 行追記し、その行の seq を返す（変更ごとに seq を 1 つ発行する）。
 * records / state / lifecycle の各書き込みが、自分の変更のたびに呼ぶ（enterWrite 済みの操作内）。
 * 内部用で `./sqlite` からは公開しない。
 */
export function appendMemoryChange(
	db: MemoryDb,
	draft: MemoryChangeDraft,
): number {
	const seq = issueSeq(db);
	guarded(() =>
		db
			.query(
				`INSERT INTO memory_change
					(seq, principal, scope_key, target_type, target_id, revision, status, forget_id, at_ms)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				seq,
				draft.principal,
				draft.scopeKey,
				draft.targetType,
				draft.targetId,
				draft.revision,
				draft.status,
				draft.forgetId,
				draft.atMs,
			),
	);
	return seq;
}

function rowToChange(row: unknown): MemoryChange {
	const targetType = readText(row, "target_type");
	const status = readText(row, "status");
	if (
		!(MEMORY_CHANGE_TARGET_TYPES as readonly string[]).includes(targetType) ||
		!(MEMORY_CHANGE_STATUSES as readonly string[]).includes(status)
	) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	return {
		seq: readInteger(row, "seq"),
		atMs: readInteger(row, "at_ms"),
		scopeKey: readText(row, "scope_key"),
		targetType: targetType as MemoryChange["targetType"],
		targetId: readText(row, "target_id"),
		revision: readNullableText(row, "revision"),
		status: status as MemoryChange["status"],
		forgetId: readNullableText(row, "forget_id"),
	};
}

/**
 * 外部ドメイン向けの読み取り専用フィード。`afterSeq` より新しい変更を seq 昇順で最大 `limit` 件返す。
 * ID と版・状態だけを返し、本文は含まない。読み取り専用接続で呼べる。
 * 複数ページにまたがる一貫性はホストの read transaction に依存する。
 */
export function listMemoryChanges(
	db: MemoryDb,
	input: ListMemoryChangesInput,
): ListMemoryChangesResult {
	const parsed = parseListMemoryChangesInput(input);
	enterRead(db);
	const permitted = new Set(parsed.access.scopeKeys);
	if (!parsed.scopeKeys.every((scopeKey) => permitted.has(scopeKey))) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const placeholders = parsed.scopeKeys.map(() => "?").join(", ");
	const params: SqlValue[] = [
		parsed.access.principal,
		...parsed.scopeKeys,
		parsed.afterSeq,
		parsed.limit + 1,
	];
	const rows = db
		.query(
			`SELECT seq, scope_key, target_type, target_id, revision, status, forget_id, at_ms
			FROM memory_change
			WHERE principal = ? AND scope_key IN (${placeholders}) AND seq > ?
			ORDER BY seq ASC
			LIMIT ?`,
		)
		.all(...params);
	const hasMore = rows.length > parsed.limit;
	const changes = rows.slice(0, parsed.limit).map(rowToChange);
	const last = changes[changes.length - 1];
	return {
		status: "ok",
		changes,
		nextAfterSeq: last === undefined ? parsed.afterSeq : last.seq,
		hasMore,
	};
}
