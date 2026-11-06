import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { readInteger, readText } from "../../../infrastructure/sqlite/db.ts";
import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import { appendMemoryChange } from "../../../infrastructure/sqlite/changes.ts";
import {
	parseEvictRetainedRecordsInput,
	parseRetainRecordInput,
	parseRetainedRecordRead,
	parseRetainedRecordStatsInput,
	parseRetainedRecordUse,
} from "../service/parse.ts";
import {
	recordIdOf,
	recordSourceKey,
	recordSourceKeyAffixes,
} from "../service/identity.ts";
import { captureRecord, readRecord } from "./index.ts";
import { fail } from "../../../contracts/reader.ts";
import type {
	RetainRecordInput,
	RetainRecordResult,
	RetainedRecordRead,
	RetainedRecordResult,
	RetainedRecordUse,
	EvictRetainedInput,
	RetainedRecordStats,
} from "../contracts/retention.ts";

/** 依存辺の出典キー、または外部送付の記録がある資料。 */
function protectedSourceSql(
	dependencyIdSql: string,
	recordIdSql: string,
): string {
	return `(EXISTS(SELECT 1 FROM memory_dependency d WHERE d.dependency_type='source' AND d.dependency_id=${dependencyIdSql}) OR EXISTS(SELECT 1 FROM memory_record_provider p WHERE p.record_id=${recordIdSql}))`;
}

function protectedSource(db: MemoryDb, recordId: string): boolean {
	const row = db
		.query(`SELECT ${protectedSourceSql("?", "?")} AS protected_source`)
		.get(recordSourceKey(recordId), recordId);
	return readInteger(row, "protected_source") !== 0;
}

/** Host transaction required. Retained records cannot be external-provider exports or State dependencies. */
export function retainRecord(
	db: MemoryDb,
	raw: RetainRecordInput,
): RetainRecordResult {
	const { record, freshUntilMs, idleTtlMs } = parseRetainRecordInput(raw);
	enterWrite(db);
	if (!record.access.scopeKeys.includes(record.scopeKey))
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	const recordId = recordIdOf(
		record.access.principal,
		record.scopeKey,
		record.origin,
	);
	const existing = db
		.query(
			"SELECT 1 FROM memory_record WHERE record_id = ? AND status != 'forgotten'",
		)
		.get(recordId);
	if (
		existing &&
		!db
			.query("SELECT 1 FROM memory_record_retention WHERE record_id = ?")
			.get(recordId)
	)
		fail("INVALID_VALUE", "$.record.origin");
	if (existing && protectedSource(db, recordId))
		fail("INVALID_VALUE", "$.record.origin");
	const captured = captureRecord(db, record);
	if (captured.status !== "captured") return captured;
	const revision = enterWrite(db);
	db.query(`INSERT INTO memory_record_retention VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(record_id) DO UPDATE SET fresh_until_ms=excluded.fresh_until_ms,
		record_revision=excluded.record_revision,
		last_used_at_ms=excluded.last_used_at_ms, idle_ttl_ms=excluded.idle_ttl_ms,
		idle_expires_at_ms=excluded.idle_expires_at_ms, retention_revision=excluded.retention_revision`).run(
		recordId,
		captured.revision,
		freshUntilMs,
		record.clock.atMs,
		idleTtlMs,
		record.clock.atMs + idleTtlMs,
		revision,
	);
	// Regenerable records keep only the current body, unlike durable Records.
	db.query(
		"DELETE FROM memory_record_body WHERE record_id=? AND revision!=?",
	).run(recordId, captured.revision);
	db.query(
		"DELETE FROM memory_record_revision WHERE record_id=? AND revision!=?",
	).run(recordId, captured.revision);
	return { ...captured, retentionRevision: revision };
}

/** Read-only: looking at an entry never extends either deadline. */
export function readRetainedRecord(
	db: MemoryDb,
	raw: RetainedRecordRead,
): RetainedRecordResult {
	const input = parseRetainedRecordRead(raw);
	enterRead(db);
	const row = db
		.query("SELECT * FROM memory_record_retention WHERE record_id=?")
		.get(input.recordId);
	if (
		!row ||
		readInteger(row, "fresh_until_ms") <= input.clock.atMs ||
		readInteger(row, "idle_expires_at_ms") <= input.clock.atMs
	)
		return { status: "miss" };
	const record = readRecord(db, {
		contractVersion: input.contractVersion,
		access: input.access,
		scopeKey: input.scopeKey,
		recordId: input.recordId,
	});
	if (record.status !== "available") return { status: "miss" };
	if (record.revision !== readText(row, "record_revision"))
		return { status: "miss" };
	return {
		status: "available",
		record,
		freshUntilMs: readInteger(row, "fresh_until_ms"),
		idleExpiresAtMs: readInteger(row, "idle_expires_at_ms"),
		retentionRevision: readInteger(row, "retention_revision"),
	};
}

/** Adoption receipt: compare the fixed retention revision, then extend only idle expiry. */
export function useRetainedRecord(
	db: MemoryDb,
	raw: RetainedRecordUse,
): boolean {
	const parsed = parseRetainedRecordUse(raw);
	enterWrite(db);
	const current = readRetainedRecord(db, {
		contractVersion: parsed.contractVersion,
		access: parsed.access,
		scopeKey: parsed.scopeKey,
		clock: parsed.clock,
		recordId: parsed.recordId,
	});
	if (
		current.status !== "available" ||
		current.retentionRevision !== parsed.retentionRevision
	)
		return false;
	const row = db
		.query("SELECT idle_ttl_ms FROM memory_record_retention WHERE record_id=?")
		.get(parsed.recordId);
	const expires = parsed.clock.atMs + readInteger(row, "idle_ttl_ms");
	if (!Number.isSafeInteger(expires)) fail("INVALID_VALUE", "$.clock");
	db.query(
		"UPDATE memory_record_retention SET last_used_at_ms=?, idle_expires_at_ms=? WHERE record_id=?",
	).run(parsed.clock.atMs, expires, parsed.recordId);
	return true;
}

export function retainedRecordStats(
	db: MemoryDb,
	raw: Omit<RetainedRecordRead, "recordId">,
): RetainedRecordStats {
	// Validate the common header without exposing any entry outside the authorized scope.
	const input = parseRetainedRecordStatsInput(raw);
	enterRead(db);
	if (!input.access.scopeKeys.includes(input.scopeKey))
		return { entries: 0, bytes: 0 };
	const row = db
		.query(`SELECT count(DISTINCT r.record_id) AS entries, coalesce(sum(v.byte_length),0) AS bytes
		FROM memory_record r JOIN memory_record_retention t USING(record_id)
		LEFT JOIN memory_record_revision v USING(record_id) WHERE r.principal=? AND r.scope_key=?`)
		.get(input.access.principal, input.scopeKey);
	return {
		entries: readInteger(row, "entries"),
		bytes: readInteger(row, "bytes"),
	};
}

/** Cache eviction is not user forget: it does not remove tombstones or permit forgotten captures. */
export function evictRetainedRecords(
	db: MemoryDb,
	raw: EvictRetainedInput,
): { deleted: string[]; blocked: string[] } {
	const input = parseEvictRetainedRecordsInput(raw);
	enterWrite(db);
	if (!input.access.scopeKeys.includes(input.scopeKey))
		return { deleted: [], blocked: [] };
	const { prefix, suffix } = recordSourceKeyAffixes();
	const rows = db
		.query(`SELECT r.record_id,
		${protectedSourceSql("? || r.record_id || ?", "r.record_id")} AS protected_source
		FROM memory_record r JOIN memory_record_retention t USING(record_id)
		WHERE r.principal=? AND r.scope_key=? AND (?=1 OR t.idle_expires_at_ms<=?) AND (? IS NULL OR r.record_id=?)
		ORDER BY protected_source, t.last_used_at_ms, t.retention_revision, r.record_id LIMIT ?`)
		.all(
			prefix,
			suffix,
			input.access.principal,
			input.scopeKey,
			input.oldest ? 1 : 0,
			input.clock.atMs,
			input.recordId,
			input.recordId,
			input.limit,
		);
	const deleted: string[] = [],
		blocked: string[] = [];
	for (const row of rows) {
		const id = readText(row, "record_id");
		// Durable State may not silently lose its source. The host must invalidate dependencies first.
		if (readInteger(row, "protected_source")) {
			blocked.push(id);
			continue;
		}
		for (const table of [
			"memory_record_body",
			"memory_record_revision",
			"memory_record_provider",
			"memory_record_retention",
			"memory_record",
		])
			db.query(`DELETE FROM ${table} WHERE record_id=?`).run(id);
		appendMemoryChange(db, {
			principal: input.access.principal,
			scopeKey: input.scopeKey,
			targetType: "record",
			targetId: id,
			revision: null,
			status: "inactive",
			forgetId: null,
			atMs: input.clock.atMs,
		});
		deleted.push(id);
	}
	return { deleted, blocked };
}
