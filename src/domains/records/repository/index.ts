/**
 * Records の永続 API（S1）。契約は `src/domains/records/contracts/index.ts`。
 *
 * 規則:
 * - 読み出しは status 列に加えて墓標の不存在を必須条件にする（`record` と `source` の両方。二重化、設計書 §2.5-1）。
 *   status を `active` に戻した（古い行を復元した）DB でも、墓標があれば forgotten として扱う。
 * - 他の principal / scope の record は `missing`（forgotten かどうかも漏らさない）。scope が許可外なら
 *   読み出しは `not_permitted`、作成系は `blocked`。
 * - 全文索引 `memory_record_fts` は現在 revision の本文だけをアプリが維持する（ASCII を小文字へ畳んだ本文）。
 *   FTS5 が使えない環境では capture が `FTS_UNAVAILABLE` になる（検索は LIKE にフォールバックする）。
 * - 書き込みは `enterWrite` 済みの write transaction 内、変更ごとに scope revision と変更フィードを更新する。
 */
import { utf8ByteLength } from "../../../canonical/utf8.ts";
import type { MissingStatus } from "../../../contracts/common.ts";
import { ownValue } from "../../../contracts/own.ts";
import { RECORD_MEDIA_TYPES } from "../contracts/index.ts";
import type {
	CaptureRecordInput,
	CaptureRecordResult,
	ReadRecordInput,
	ReadRecordRangeInput,
	ReadRecordRangeResult,
	ReadRecordResult,
	RecordCaptureState,
	RecordMeta,
	RecordMediaType,
	RecordSourceStatesInput,
	RecordSourceStatesResult,
	RecordStatus,
	RecordStatusChangeInput,
	RecordStatusChangeResult,
} from "../contracts/index.ts";
import type { SourceState, SourceStatus } from "../../../contracts/types.ts";
import { parseCaptureRecordInput } from "../service/parse.ts";
import {
	parseReadRecordInput,
	parseReadRecordRangeInput,
	parseRecordSourceStatesInput,
	parseRecordStatusChangeInput,
} from "../service/parse.ts";
import {
	contentRevision,
	recordIdOf,
	recordSourceKey,
	recordSourceRef,
} from "../service/identity.ts";
import { sliceUtf8Range } from "../service/range.ts";
import { appendMemoryChange } from "../../../infrastructure/sqlite/changes.ts";
import {
	guarded,
	readInteger,
	readRow,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";
import { bumpScopeRevision } from "../../../infrastructure/sqlite/scope-state.ts";
import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import { isTombstoned } from "../../../infrastructure/sqlite/tombstone.ts";

// ---- 行 ----

interface RecordRow {
	readonly recordId: string;
	readonly principal: string;
	readonly scopeKey: string;
	readonly origin: {
		readonly namespace: string;
		readonly kind: string;
		readonly id: string;
	};
	readonly mediaType: RecordMediaType;
	readonly captureState: RecordCaptureState;
	readonly status: RecordStatus | "forgotten";
	readonly currentRevision: string;
	readonly createdSeq: number;
	readonly updatedSeq: number;
}

const RECORD_COLUMNS = `record_id, principal, scope_key, origin_namespace, origin_kind, origin_id,
	media_type, capture_state, status, current_revision, created_seq, updated_seq`;

function rowToRecord(row: unknown): RecordRow {
	const mediaType = readText(row, "media_type");
	const captureState = readText(row, "capture_state");
	const status = readText(row, "status");
	if (
		!(RECORD_MEDIA_TYPES as readonly string[]).includes(mediaType) ||
		(captureState !== "complete" && captureState !== "partial") ||
		(status !== "active" && status !== "inactive" && status !== "forgotten")
	) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	return {
		recordId: readText(row, "record_id"),
		principal: readText(row, "principal"),
		scopeKey: readText(row, "scope_key"),
		origin: {
			namespace: readText(row, "origin_namespace"),
			kind: readText(row, "origin_kind"),
			id: readText(row, "origin_id"),
		},
		mediaType: mediaType as RecordMediaType,
		captureState,
		status,
		currentRevision: readText(row, "current_revision"),
		createdSeq: readInteger(row, "created_seq"),
		updatedSeq: readInteger(row, "updated_seq"),
	};
}

function selectRecordRow(db: MemoryDb, recordId: string): RecordRow | null {
	const row = guarded(() =>
		db
			.query(`SELECT ${RECORD_COLUMNS} FROM memory_record WHERE record_id = ?`)
			.get(recordId),
	);
	return row === null || row === undefined ? null : rowToRecord(row);
}

interface RevisionRow {
	readonly revision: string;
	readonly digest: string;
	readonly byteLength: number;
	readonly bodyRowid: number;
}

function selectRevisionRow(
	db: MemoryDb,
	recordId: string,
	revision: string,
): RevisionRow | null {
	const row = guarded(() =>
		db
			.query(
				`SELECT revision, digest, byte_length, body_rowid FROM memory_record_revision
				WHERE record_id = ? AND revision = ?`,
			)
			.get(recordId, revision),
	);
	if (row === null || row === undefined) return null;
	return {
		revision: readText(row, "revision"),
		digest: readText(row, "digest"),
		byteLength: readInteger(row, "byte_length"),
		bodyRowid: readInteger(row, "body_rowid"),
	};
}

function selectBodyContent(db: MemoryDb, bodyRowid: number): string | null {
	const row = guarded(() =>
		db
			.query("SELECT content FROM memory_record_body WHERE rowid = ?")
			.get(bodyRowid),
	);
	return row === null || row === undefined ? null : readText(row, "content");
}

/** 墓標の有無を、その墓標の principal / scope が一致する場合だけ true とする（他者の墓標は見えない）。 */
function isTombstonedFor(
	db: MemoryDb,
	targetType: "record" | "source",
	targetId: string,
	principal: string,
	scopeKey: string,
): boolean {
	const row = guarded(() =>
		db
			.query(
				`SELECT 1 AS found FROM memory_tombstone
				WHERE target_type = ? AND target_id = ? AND principal = ? AND scope_key = ?`,
			)
			.get(targetType, targetId, principal, scopeKey),
	);
	return row !== null && row !== undefined;
}

type Lookup =
	| { readonly found: true; readonly row: RecordRow }
	| { readonly found: false; readonly status: MissingStatus };

/**
 * record の参照規則（read / range / sourceStates / deactivate で共通）。
 * scope 許可外 → not_permitted、墓標あり（record / source のどちらでも）→ forgotten、
 * 他 principal・他 scope・無し → missing、行が forgotten → forgotten。
 */
function lookupRecord(
	db: MemoryDb,
	principal: string,
	permittedScopeKeys: readonly string[],
	scopeKey: string,
	recordId: string,
): Lookup {
	if (!permittedScopeKeys.includes(scopeKey)) {
		return { found: false, status: "not_permitted" };
	}
	if (
		isTombstonedFor(db, "record", recordId, principal, scopeKey) ||
		isTombstonedFor(
			db,
			"source",
			recordSourceKey(recordId),
			principal,
			scopeKey,
		)
	) {
		return { found: false, status: "forgotten" };
	}
	const row = selectRecordRow(db, recordId);
	if (
		row === null ||
		row.principal !== principal ||
		row.scopeKey !== scopeKey
	) {
		return { found: false, status: "missing" };
	}
	if (row.status === "forgotten") return { found: false, status: "forgotten" };
	return { found: true, row };
}

// ---- 全文索引（現在 revision のみ。ASCII を小文字へ畳んだ本文）----

function isFtsMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("memory_record_fts") ||
			error.message.includes("fts5"))
	);
}

function foldForIndex(content: string): string {
	return content.replace(/[A-Z]/g, (char) =>
		String.fromCharCode(char.charCodeAt(0) + 0x20),
	);
}

/** 既存の行を消してから入れる（rowid の重複を作らない）。FTS が使えなければ `FTS_UNAVAILABLE`。 */
function ftsReplace(db: MemoryDb, rowid: number, content: string): void {
	try {
		db.query("DELETE FROM memory_record_fts WHERE rowid = ?").run(rowid);
		db.query("INSERT INTO memory_record_fts (rowid, body) VALUES (?, ?)").run(
			rowid,
			foldForIndex(content),
		);
	} catch (error) {
		if (isFtsMissing(error)) throw new MemoryStoreError("FTS_UNAVAILABLE");
		throw error;
	}
}

function ftsDelete(db: MemoryDb, rowid: number): void {
	try {
		db.query("DELETE FROM memory_record_fts WHERE rowid = ?").run(rowid);
	} catch (error) {
		if (isFtsMissing(error)) throw new MemoryStoreError("FTS_UNAVAILABLE");
		throw error;
	}
}

/** 忘却では索引表が無くても進める（索引に残るものが無い）。 */
function ftsDeleteForForget(db: MemoryDb, rowid: number): void {
	try {
		db.query("DELETE FROM memory_record_fts WHERE rowid = ?").run(rowid);
	} catch (error) {
		if (!isFtsMissing(error)) throw error;
	}
}

// ---- capture ----

/**
 * 外部取得物を保存する。ホストの write transaction 内で呼ぶ。同一 origin で内容が同じなら冪等
 * （`created: false`）。内容が変われば同じ record の新しい revision になる（旧 revision の本文も残る）。
 * 墓標のある record は `blocked: TOMBSTONED`（trigger は最終防衛線）。
 */
export function captureRecord(
	db: MemoryDb,
	rawInput: CaptureRecordInput,
): CaptureRecordResult {
	const input = parseCaptureRecordInput(rawInput);
	const seq = enterWrite(db);
	if (!input.access.scopeKeys.includes(input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = input.access.principal;
	const recordId = recordIdOf(principal, input.scopeKey, input.origin);
	if (
		isTombstoned(db, "record", recordId) ||
		isTombstoned(db, "source", recordSourceKey(recordId))
	) {
		return { status: "blocked", reasonCode: "TOMBSTONED" };
	}
	const { revision, digest } = contentRevision(input.content);
	const existing = selectRecordRow(db, recordId);
	if (existing !== null && existing.status === "forgotten") {
		return { status: "blocked", reasonCode: "TOMBSTONED" };
	}

	const providerRef = ownValue(input, "providerRef");
	if (providerRef !== undefined) {
		guarded(() =>
			db
				.query(
					`INSERT INTO memory_record_provider (record_id, provider_ref) VALUES (?, ?)
					ON CONFLICT DO NOTHING`,
				)
				.run(recordId, providerRef),
		);
	}

	let created = false;
	let changedStatus: RecordStatus = "active";
	let metaChanged = false;
	if (existing === null) {
		created = true;
		insertRevision(db, recordId, revision, digest, input.content, seq);
		guarded(() =>
			db
				.query(
					`INSERT INTO memory_record (${RECORD_COLUMNS})
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
				)
				.run(
					recordId,
					principal,
					input.scopeKey,
					input.origin.namespace,
					input.origin.kind,
					input.origin.id,
					input.mediaType,
					input.captureState,
					revision,
					seq,
					seq,
				),
		);
	} else {
		changedStatus = existing.status === "inactive" ? "inactive" : "active";
		if (existing.currentRevision !== revision) {
			created = true;
			const previous = selectRevisionRow(
				db,
				recordId,
				existing.currentRevision,
			);
			if (previous !== null) ftsDelete(db, previous.bodyRowid);
			const known = selectRevisionRow(db, recordId, revision);
			if (known === null) {
				insertRevision(db, recordId, revision, digest, input.content, seq);
			} else {
				ftsReplace(db, known.bodyRowid, input.content);
			}
			guarded(() =>
				db
					.query(
						`UPDATE memory_record SET current_revision = ?, media_type = ?, capture_state = ?,
							updated_seq = ? WHERE record_id = ?`,
					)
					.run(revision, input.mediaType, input.captureState, seq, recordId),
			);
		} else if (
			existing.captureState !== input.captureState ||
			existing.mediaType !== input.mediaType
		) {
			metaChanged = true;
			guarded(() =>
				db
					.query(
						`UPDATE memory_record SET media_type = ?, capture_state = ?, updated_seq = ?
						WHERE record_id = ?`,
					)
					.run(input.mediaType, input.captureState, seq, recordId),
			);
		}
	}

	if (created || metaChanged) {
		bumpScopeRevision(db, principal, input.scopeKey);
		appendMemoryChange(db, {
			principal,
			scopeKey: input.scopeKey,
			atMs: input.clock.atMs,
			targetType: "record",
			targetId: recordId,
			revision,
			status: changedStatus,
			forgetId: null,
		});
	}
	return {
		status: "captured",
		recordId,
		revision,
		digest,
		created,
		ref: recordSourceRef(recordId, revision, digest),
	};
}

/** 本文・revision 行・索引を追加する（現在 revision として索引する）。 */
function insertRevision(
	db: MemoryDb,
	recordId: string,
	revision: string,
	digest: string,
	content: string,
	seq: number,
): void {
	const body = guarded(() =>
		db
			.query(
				`INSERT INTO memory_record_body (record_id, revision, representation, content)
				VALUES (?, ?, 'text', ?) RETURNING rowid`,
			)
			.get(recordId, revision, content),
	);
	const bodyRowid = readInteger(body, "rowid");
	guarded(() =>
		db
			.query(
				`INSERT INTO memory_record_revision
					(record_id, revision, digest, byte_length, body_rowid, seq)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(recordId, revision, digest, utf8ByteLength(content), bodyRowid, seq),
	);
	ftsReplace(db, bodyRowid, content);
}

// ---- 読み出し ----

function toMeta(db: MemoryDb, row: RecordRow): RecordMeta | null {
	const revision = selectRevisionRow(db, row.recordId, row.currentRevision);
	if (revision === null) return null;
	return {
		recordId: row.recordId,
		scopeKey: row.scopeKey,
		origin: row.origin,
		mediaType: row.mediaType,
		captureState: row.captureState,
		status: row.status === "inactive" ? "inactive" : "active",
		currentRevision: row.currentRevision,
		digest: revision.digest,
		byteLength: revision.byteLength,
		createdSeq: row.createdSeq,
		updatedSeq: row.updatedSeq,
	};
}

/**
 * 読み取り。inactive の record も読める（deactivate は可逆で本文を保持する）。
 * 複数文の読み出しの一貫性はホストの read transaction に依存する。
 */
export function readRecord(
	db: MemoryDb,
	rawInput: ReadRecordInput,
): ReadRecordResult {
	const input = parseReadRecordInput(rawInput);
	enterRead(db);
	const found = lookupRecord(
		db,
		input.access.principal,
		input.access.scopeKeys,
		input.scopeKey,
		input.recordId,
	);
	if (!found.found) return { status: found.status };
	const meta = toMeta(db, found.row);
	if (meta === null) throw new MemoryStoreError("CORRUPT_ROW");
	const revision = ownValue(input, "revision") ?? found.row.currentRevision;
	const revisionRow = selectRevisionRow(db, found.row.recordId, revision);
	if (revisionRow === null) return { status: "missing" };
	const content = selectBodyContent(db, revisionRow.bodyRowid);
	if (content === null) throw new MemoryStoreError("CORRUPT_ROW");
	return {
		status: "available",
		record: meta,
		revision,
		content,
		ref: recordSourceRef(found.row.recordId, revision, revisionRow.digest),
	};
}

/** 読み取り。範囲は最大 64 KiB、両端は UTF-8 のコードポイント境界。 */
export function readRecordRange(
	db: MemoryDb,
	rawInput: ReadRecordRangeInput,
): ReadRecordRangeResult {
	const input = parseReadRecordRangeInput(rawInput);
	enterRead(db);
	const found = lookupRecord(
		db,
		input.access.principal,
		input.access.scopeKeys,
		input.scopeKey,
		input.recordId,
	);
	if (!found.found) return { status: found.status };
	const revisionRow = selectRevisionRow(db, found.row.recordId, input.revision);
	if (revisionRow === null) return { status: "missing" };
	const content = selectBodyContent(db, revisionRow.bodyRowid);
	if (content === null) throw new MemoryStoreError("CORRUPT_ROW");
	const slice = sliceUtf8Range(content, input.range);
	if (slice.status === "invalid_range") {
		return { status: "invalid_range", reasonCode: slice.reasonCode };
	}
	return { status: "available", text: slice.text, digest: slice.digest };
}

/**
 * 読み取り（View 用の出典状態）。`refs` と同じ順序・同じ件数で返す。
 * forgotten → `forgotten`、無い／他 principal・scope／inactive／scope 許可外 → `missing`、
 * revision か digest が current と異なる → `changed`、それ以外 → `available`。
 * `available` / `changed` は current の revision・digest を、それ以外は ref の値をそのまま返す。
 */
export function recordSourceStates(
	db: MemoryDb,
	rawInput: RecordSourceStatesInput,
): RecordSourceStatesResult {
	const input = parseRecordSourceStatesInput(rawInput);
	enterRead(db);
	const principal = input.access.principal;
	const states: SourceState[] = [];
	for (const ref of input.refs) {
		const representation = ownValue(ref, "representation");
		const echo = (status: SourceStatus): SourceState => ({
			namespace: ref.namespace,
			kind: ref.kind,
			id: ref.id,
			...(representation === undefined ? {} : { representation }),
			revision: ref.revision,
			digest: ref.digest,
			principal,
			scopeKey: input.scopeKey,
			status,
		});
		if (
			representation !== "text" ||
			!input.access.scopeKeys.includes(input.scopeKey)
		) {
			states.push(echo("missing"));
			continue;
		}
		const found = lookupRecord(
			db,
			principal,
			input.access.scopeKeys,
			input.scopeKey,
			ref.id,
		);
		if (!found.found) {
			states.push(echo(found.status === "forgotten" ? "forgotten" : "missing"));
			continue;
		}
		if (found.row.status !== "active") {
			states.push(echo("missing"));
			continue;
		}
		const current = selectRevisionRow(db, ref.id, found.row.currentRevision);
		if (current === null) throw new MemoryStoreError("CORRUPT_ROW");
		const available =
			current.revision === ref.revision && current.digest === ref.digest;
		const content =
			available && ownValue(input, "withContent") === true
				? selectBodyContent(db, current.bodyRowid)
				: null;
		states.push({
			...echo(available ? "available" : "changed"),
			revision: current.revision,
			digest: current.digest,
			...(content === null ? {} : { content }),
		});
	}
	return states;
}

// ---- deactivate / reactivate（可逆。墓標・ジャーナル・ForgetReceipt を作らない）----

function changeStatus(
	db: MemoryDb,
	rawInput: RecordStatusChangeInput,
	target: RecordStatus,
): RecordStatusChangeResult {
	const input = parseRecordStatusChangeInput(rawInput);
	const seq = enterWrite(db);
	const principal = input.access.principal;
	const found = lookupRecord(
		db,
		principal,
		input.access.scopeKeys,
		input.scopeKey,
		input.recordId,
	);
	if (!found.found) return { status: found.status };
	if (found.row.status === target) {
		return { status: "unchanged", recordStatus: target };
	}
	guarded(() =>
		db
			.query(
				"UPDATE memory_record SET status = ?, updated_seq = ? WHERE record_id = ?",
			)
			.run(target, seq, input.recordId),
	);
	bumpScopeRevision(db, principal, input.scopeKey);
	appendMemoryChange(db, {
		principal,
		scopeKey: input.scopeKey,
		atMs: input.clock.atMs,
		targetType: "record",
		targetId: input.recordId,
		revision: found.row.currentRevision,
		status: target,
		forgetId: null,
	});
	return { status: "changed", recordStatus: target };
}

/** 書き込み。可逆（本文を保持する）。 */
export function deactivateRecord(
	db: MemoryDb,
	input: RecordStatusChangeInput,
): RecordStatusChangeResult {
	return changeStatus(db, input, "inactive");
}

/** 書き込み。 */
export function reactivateRecord(
	db: MemoryDb,
	input: RecordStatusChangeInput,
): RecordStatusChangeResult {
	return changeStatus(db, input, "active");
}

// ---- 忘却の実体（lifecycle.ts が呼ぶ内部部品。`./sqlite` からは公開しない）----

/** scope 内の record_id（昇順）。`createdBefore` を渡すとその seq より前に作られたものだけ。 */
export function listRecordIdsInScope(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	createdBefore: number | null,
): string[] {
	const params: SqlValue[] = [principal, scopeKey];
	let extra = "";
	if (createdBefore !== null) {
		extra = " AND created_seq < ?";
		params.push(createdBefore);
	}
	return guarded(() =>
		db
			.query(
				`SELECT record_id FROM memory_record WHERE principal = ? AND scope_key = ?${extra}
				ORDER BY record_id ASC`,
			)
			.all(...params),
	).map((row) => readText(readRow(row), "record_id"));
}

export interface ForgottenRecordInfo {
	/** 行が存在し、forgotten でなかった（今回の適用で状態が変わった）。 */
	readonly transitioned: boolean;
	/** この record が外部プロバイダーへ送られていた場合のその識別子（昇順）。 */
	readonly providerRefs: readonly string[];
}

/** 外部プロバイダーに送られた record の識別子（昇順、重複なし）。読み取りのみ。 */
export function listRecordProviders(
	db: MemoryDb,
	recordId: string,
): readonly string[] {
	return guarded(() =>
		db
			.query(
				"SELECT provider_ref FROM memory_record_provider WHERE record_id = ? ORDER BY provider_ref ASC",
			)
			.all(recordId),
	).map((row) => readText(readRow(row), "provider_ref"));
}

/** record の行が存在し forgotten でない（plan の閉包 counts 用）。読み取りのみ。 */
export function recordIsLive(db: MemoryDb, recordId: string): boolean {
	const row = selectRecordRow(db, recordId);
	return row !== null && row.status !== "forgotten";
}

/**
 * record の本文（全 revision）・revision 行・索引行・外部送付記録を消し、行を殻（status forgotten、
 * origin と revision を空）にする。冪等で、行が無い・既に forgotten でも何度でも呼べる。
 * 墓標・変更フィード・scope revision は呼び出し側が書く。
 */
export function scrubRecord(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	recordId: string,
): ForgottenRecordInfo {
	const row = selectRecordRow(db, recordId);
	const owned =
		row !== null && row.principal === principal && row.scopeKey === scopeKey;
	const providerRefs = listRecordProviders(db, recordId);
	const bodyRows = guarded(() =>
		db
			.query("SELECT rowid FROM memory_record_body WHERE record_id = ?")
			.all(recordId),
	);
	for (const bodyRow of bodyRows) {
		ftsDeleteForForget(db, readInteger(readRow(bodyRow), "rowid"));
	}
	guarded(() => {
		db.query("DELETE FROM memory_record_body WHERE record_id = ?").run(
			recordId,
		);
		db.query("DELETE FROM memory_record_revision WHERE record_id = ?").run(
			recordId,
		);
		db.query("DELETE FROM memory_record_provider WHERE record_id = ?").run(
			recordId,
		);
	});
	if (owned) {
		guarded(() =>
			db
				.query(
					`UPDATE memory_record SET status = 'forgotten', origin_namespace = '', origin_kind = '',
						origin_id = '', current_revision = '' WHERE record_id = ?`,
				)
				.run(recordId),
		);
	}
	return {
		transitioned: owned && row.status !== "forgotten",
		providerRefs,
	};
}

/**
 * record の持ち主の検査（forget の target 用）。行がなければ `none`、この principal と scope のものなら `owned`、
 * 他の principal / scope のものなら `foreign`（forget してはならない）。
 */
export function recordOwnership(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	recordId: string,
): "none" | "owned" | "foreign" {
	const row = selectRecordRow(db, recordId);
	if (row === null) return "none";
	return row.principal === principal && row.scopeKey === scopeKey
		? "owned"
		: "foreign";
}
