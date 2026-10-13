/**
 * State 台帳の永続 API（契約は `src/domains/state/contracts/index.ts`、設計は full-system-design §3.5）。
 *
 * - 書き込み（assertUserState / editState / deactivateState / reactivateState / retractState）は
 *   ホストの write transaction の中で 1 回呼ぶ。入口は `enterWrite`。遷移の妥当性は純粋な
 *   `src/domains/state/service/reducer.ts` が決め、このファイルは「読む → reducer → 書く」だけをする。
 *   拒否（`rejected` / `blocked` / `missing` / `forgotten`）と冪等（`unchanged`）では何も書かない。
 * - 読み取り（listState / readMemorySnapshotPart）は `enterRead`。読み出しは scope index（先頭が
 *   principal, scope_key）を使い、status に加えて墓標の不在を必須条件にする（§2.5-1、F02）。
 *   readMemorySnapshotPart は複数文を読むので、一貫した snapshot はホストの read transaction に依存する。
 * - deactivate / reactivate は可逆で、墓標・ジャーナル・ForgetReceipt を作らない（忘却ではない、§6.2）。
 *   `forget` は reducer を通さず lifecycle（S6）が閉包で適用する。
 * - 1 回の書き込みは scope revision を +1 し、変更した item ごとに変更フィードへ 1 行追記する。
 * - 派生行の規則: item の evidence の出典（SourceKey）に必ず依存辺を張る（先頭が primary、残りは support）。
 *   edit で evidence を差し替えても古い辺は残す（forget の取りこぼしを避ける保守側の扱い）。
 */
import type { StateSubject } from "../../../contracts/common.ts";
import {
	MEMORY_RECORD_SOURCE_KIND,
	MEMORY_SOURCE_NAMESPACE,
} from "../../../contracts/common.ts";
import { LIMITS_RECORDS } from "../../records/contracts/index.ts";
import { sourceKey } from "../../../contracts/source-key.ts";
import {
	LIMITS_STATE,
	STATE_ITEM_STATUSES,
	STATE_KINDS,
	STATE_ORIGINS,
	USER_STATE_ORIGINS,
} from "../contracts/index.ts";
import type {
	AssertUserStateInput,
	EditStateInput,
	ListStateInput,
	ListStateResult,
	ListStateScopesInput,
	ListStateScopesResult,
	ReadMemorySnapshotPartInput,
	ReadStateFactInput,
	ReadStateFactResult,
	ReadMemorySnapshotPartResult,
	StateCause,
	StateEventDraft,
	StateItem,
	StateItemStatus,
	StateItemView,
	StateKeyHistory,
	StateKind,
	StateOrigin,
	StateReasonCode,
	StateTargetInput,
	StateTransitionAction,
	StateTransitionResult,
	StateValue,
	StateWriteResult,
} from "../contracts/index.ts";
import type { MemoryItemV2, ItemKindV2 } from "../../../contracts/view-v2.ts";
import { ITEM_KINDS_V2 } from "../../../contracts/view-v2.ts";
import type { EvidenceSpan } from "../../../contracts/common.ts";
import type {
	AccessContext,
	SourceRef,
	SourceState,
} from "../../../contracts/types.ts";
import { ownValue } from "../../../contracts/own.ts";
import {
	VALIDITY_BASES,
	formatPartialDate,
	parsePartialDate,
	periodBoundsMs,
} from "../../temporal/index.ts";
import type { ValidityPeriod } from "../../temporal/index.ts";
import { checkEvidence, evidenceOrdinalOf } from "../service/evidence.ts";
import { stateValueEquals } from "../service/value.ts";
import { stateItemId } from "../service/ids.ts";
import {
	parseAssertUserStateInput,
	parseEditStateInput,
	parseListStateInput,
	parseListStateScopesInput,
	parseReadSnapshotPartInput,
	parseReadStateFactInput,
	parseStateTargetInput,
} from "../service/parse.ts";
import {
	applyStateTransition,
	isSubjectKindConsistent,
} from "../service/reducer.ts";
import type { StateTransitionRequest } from "../service/reducer.ts";
import { appendMemoryChange } from "../../../infrastructure/sqlite/changes.ts";
import { addDependency } from "../../../infrastructure/sqlite/dependency.ts";
import {
	guarded,
	issueSeq,
	readInteger,
	readNullableInteger,
	readNullableText,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";
import { recordSourceStates } from "../../records/sqlite.ts";
import {
	bumpScopeRevision,
	readScopeRevision,
} from "../../../infrastructure/sqlite/scope-state.ts";
import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import { isTombstoned } from "../../../infrastructure/sqlite/tombstone.ts";

/** 否定の値を view の `text`（1 本の文字列）へ載せるときの接頭辞。 */
const NEGATED_TEXT_PREFIX = "NOT: ";

// ---- 行の読み取り ----

interface ItemRow {
	readonly view: StateItemView;
	readonly validFromMs: number | null;
	readonly validUntilMs: number | null;
	readonly validity?: ValidityPeriod;
	readonly createdSeq: number;
	readonly updatedSeq: number;
}

const ITEM_COLUMNS = `i.item_id, i.subject, i.kind, i.semantic_key, i.status, i.revision,
	i.value_text, i.polarity, i.origin, i.evidence_ordinal, i.valid_from_ms,
	i.valid_until_ms, i.valid_from_text, i.valid_until_text, i.valid_basis,
	i.created_seq, i.updated_seq`;

const NO_TOMBSTONE = `NOT EXISTS (SELECT 1 FROM memory_tombstone t
	WHERE t.target_type = 'state_item' AND t.target_id = i.item_id)`;

function readEnumText<T extends string>(
	row: unknown,
	column: string,
	allowed: readonly T[],
): T {
	const value = readText(row, column);
	const found = allowed.find((candidate) => candidate === value);
	if (found === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return found;
}

function readSubject(row: unknown): StateSubject {
	const subject = readText(row, "subject");
	if (subject === "self") return "self";
	if (subject.startsWith("other:")) return subject as StateSubject;
	throw new MemoryStoreError("CORRUPT_ROW");
}

function readItemRow(
	row: unknown,
	attributes: StateValue["attributes"],
): ItemRow {
	const status = readEnumText(row, "status", STATE_ITEM_STATUSES);
	const polarity = readNullableText(row, "polarity");
	const text = readNullableText(row, "value_text");
	if (status !== "forgotten" && (polarity === null || text === null)) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	if (polarity !== null && polarity !== "affirmed" && polarity !== "negated") {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	const value: StateValue = {
		text: text ?? "",
		polarity: polarity ?? "affirmed",
		...(attributes === undefined ? {} : { attributes }),
	};
	return {
		view: {
			itemId: readText(row, "item_id"),
			subject: readSubject(row),
			kind: readEnumText(row, "kind", STATE_KINDS),
			semanticKey: readText(row, "semantic_key"),
			status,
			revision: readInteger(row, "revision"),
			value,
			origin: readEnumText(row, "origin", STATE_ORIGINS),
			evidenceOrdinal: readInteger(row, "evidence_ordinal"),
		},
		validFromMs: readNullableInteger(row, "valid_from_ms"),
		validUntilMs: readNullableInteger(row, "valid_until_ms"),
		...readValidityColumns(row),
		createdSeq: readInteger(row, "created_seq"),
		updatedSeq: readInteger(row, "updated_seq"),
	};
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

type AttributeMap = Map<string, Record<string, string>>;

function loadAttributes(
	db: MemoryDb,
	itemIds: readonly string[],
): AttributeMap {
	const byItem: AttributeMap = new Map();
	if (itemIds.length === 0) return byItem;
	const rows = guarded(() =>
		db
			.query(
				`SELECT item_id, attr_key, attr_value FROM memory_state_attribute
				WHERE item_id IN (${placeholders(itemIds.length)})
				ORDER BY item_id, attr_key`,
			)
			.all(...itemIds),
	);
	for (const row of rows) {
		const itemId = readText(row, "item_id");
		const bag = byItem.get(itemId) ?? Object.create(null);
		bag[readText(row, "attr_key")] = readText(row, "attr_value");
		byItem.set(itemId, bag);
	}
	return byItem;
}

function loadEvidence(
	db: MemoryDb,
	itemIds: readonly string[],
): Map<string, SourceRef[]> {
	const byItem = new Map<string, SourceRef[]>();
	if (itemIds.length === 0) return byItem;
	const rows = guarded(() =>
		db
			.query(
				`SELECT item_id, namespace, kind, source_id, representation, revision, digest,
					start_byte, end_byte
				FROM memory_state_evidence
				WHERE item_id IN (${placeholders(itemIds.length)})
				ORDER BY item_id, idx`,
			)
			.all(...itemIds),
	);
	for (const row of rows) {
		const itemId = readText(row, "item_id");
		const representation = readNullableText(row, "representation");
		const ref: SourceRef = {
			namespace: readText(row, "namespace"),
			kind: readText(row, "kind"),
			id: readText(row, "source_id"),
			...(representation === null ? {} : { representation }),
			revision: readText(row, "revision"),
			digest: readText(row, "digest"),
			range: {
				startByte: readInteger(row, "start_byte"),
				endByte: readInteger(row, "end_byte"),
			},
		};
		const list = byItem.get(itemId) ?? [];
		list.push(ref);
		byItem.set(itemId, list);
	}
	return byItem;
}

/** 行を `StateItem`（evidence・attributes つき）にまとめる。 */
function hydrate(
	db: MemoryDb,
	scopeKey: string,
	rows: readonly unknown[],
): StateItem[] {
	const ids = rows.map((row) => readText(row, "item_id"));
	const attributes = loadAttributes(db, ids);
	const evidence = loadEvidence(db, ids);
	return rows.map((row) => {
		const id = readText(row, "item_id");
		const parsed = readItemRow(row, attributes.get(id));
		return {
			...parsed.view,
			scopeKey,
			evidence: evidence.get(id) ?? [],
			validFromMs: parsed.validFromMs,
			validUntilMs: parsed.validUntilMs,
			...(parsed.validity === undefined ? {} : { validity: parsed.validity }),
			createdSeq: parsed.createdSeq,
			updatedSeq: parsed.updatedSeq,
		};
	});
}

type LoadedItem =
	| { readonly status: "found"; readonly row: ItemRow }
	| { readonly status: "missing" | "forgotten" };

/** scope 内の item を 1 件読む（reducer 用）。他 scope・存在しない → missing、墓標あり／forgotten → forgotten。 */
function loadItem(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	itemId: string,
): LoadedItem {
	const row = guarded(() =>
		db
			.query(
				`SELECT ${ITEM_COLUMNS} FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.item_id = ?`,
			)
			.get(principal, scopeKey, itemId),
	);
	if (row === null || row === undefined) return { status: "missing" };
	if (isTombstoned(db, "state_item", itemId)) return { status: "forgotten" };
	const attributes = loadAttributes(db, [itemId]).get(itemId);
	const parsed = readItemRow(row, attributes);
	if (parsed.view.status === "forgotten") return { status: "forgotten" };
	return { status: "found", row: parsed };
}

function loadActiveForKey(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	subject: StateSubject,
	kind: StateKind,
	semanticKey: string,
): ItemRow | null {
	const row = guarded(() =>
		db
			.query(
				`SELECT ${ITEM_COLUMNS} FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.subject = ? AND i.kind = ?
					AND i.semantic_key = ? AND i.status = 'active' AND ${NO_TOMBSTONE}`,
			)
			.get(principal, scopeKey, subject, kind, semanticKey),
	);
	if (row === null || row === undefined) return null;
	const id = readText(row, "item_id");
	return readItemRow(row, loadAttributes(db, [id]).get(id));
}

/**
 * 同 key の active 以外の履歴の要約（reducer / Admission の判定用）。`disputed` の根拠順位の最大と、
 * ユーザー由来（user_confirmed / user_edited）、またはユーザーの操作で停止（retract / deactivate）された item が
 * `retracted` / `inactive` で残っているか。
 * forgotten・墓標のある item は含めない（forgotten は semantic_key が空になる）。
 */
function loadKeyHistory(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	subject: StateSubject,
	kind: StateKind,
	semanticKey: string,
): StateKeyHistory {
	const rows = guarded(() =>
		db
			.query(
				`SELECT i.status, i.origin, i.evidence_ordinal,
					EXISTS (SELECT 1 FROM memory_state_event e
						WHERE e.item_id = i.item_id AND e.cause_type = 'user'
							AND e.action IN ('retract', 'deactivate')) AS user_stopped
				FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.subject = ? AND i.kind = ?
					AND i.semantic_key = ? AND i.status IN ('disputed', 'retracted', 'inactive')
					AND ${NO_TOMBSTONE}`,
			)
			.all(principal, scopeKey, subject, kind, semanticKey),
	);
	let disputedMaxOrdinal: number | null = null;
	let userRemoved = false;
	for (const row of rows) {
		const status = readText(row, "status");
		if (status === "disputed") {
			const ordinal = readInteger(row, "evidence_ordinal");
			if (disputedMaxOrdinal === null || ordinal > disputedMaxOrdinal) {
				disputedMaxOrdinal = ordinal;
			}
		} else if (
			(USER_STATE_ORIGINS as readonly string[]).includes(
				readText(row, "origin"),
			) ||
			readInteger(row, "user_stopped") === 1
		) {
			// 由来ではなく、ユーザーが行った停止（cause_type = 'user'）を保護する。
			userRemoved = true;
		}
	}
	return { disputedMaxOrdinal, userRemoved };
}

/** 明示操作の期間。精度つきの `validity` は境界（ms）を UTC の暦から導いて一緒に保存する。 */
function assertedValidity(parsed: {
	readonly validFromMs?: number;
	readonly validUntilMs?: number;
	readonly validity?: ValidityPeriod;
}): Pick<NewItemExtras, "validFromMs" | "validUntilMs" | "validity"> {
	if (ownValue(parsed, "validity") === undefined) {
		return {
			validFromMs: ownValue(parsed, "validFromMs") ?? null,
			validUntilMs: ownValue(parsed, "validUntilMs") ?? null,
		};
	}
	const validity = parsed.validity as ValidityPeriod;
	const bounds = periodBoundsMs(validity);
	return {
		validFromMs: bounds.startMs,
		validUntilMs: bounds.endMs,
		validity,
	};
}

/**
 * 書き込みが期間（`validity` または ms の境界）を指定していて、既に保存されている同じ item の期間と違うか。
 * 保存されていない item（これから作る）は衝突しない。期間を指定しない書き込みは常に衝突しない。
 */
function periodConflictsWithStored(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	itemId: string,
	parsed: {
		readonly validFromMs?: number;
		readonly validUntilMs?: number;
		readonly validity?: ValidityPeriod;
	},
): boolean {
	const validity = ownValue(parsed, "validity");
	const from = ownValue(parsed, "validFromMs");
	const until = ownValue(parsed, "validUntilMs");
	if (validity === undefined && from === undefined && until === undefined) {
		return false;
	}
	const row = selectFirst(
		db,
		`SELECT ${ITEM_COLUMNS} FROM memory_state_item i
		WHERE i.principal = ? AND i.scope_key = ? AND i.item_id = ?`,
		[principal, scopeKey, itemId],
	);
	if (row === null) return false;
	const stored = readItemRow(row, undefined);
	const wanted = assertedValidity(parsed);
	if (
		wanted.validFromMs !== stored.validFromMs ||
		wanted.validUntilMs !== stored.validUntilMs
	) {
		return true;
	}
	return (
		validityColumns(wanted.validity).join("\u0000") !==
		validityColumns(stored.validity).join("\u0000")
	);
}

/** reducer の結果のうち、この書き込みの対象になった item（supersede / dispute は新しい側、昇格・edit は更新した 1 件）。 */
function subjectItemOf(
	result: Extract<StateTransitionResult, { ok: true }>,
): StateItemView {
	const view = result.items[result.items.length - 1];
	if (view === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return view;
}

function readFullItem(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	itemId: string,
): StateItem {
	const row = guarded(() =>
		db
			.query(
				`SELECT ${ITEM_COLUMNS} FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.item_id = ?`,
			)
			.get(principal, scopeKey, itemId),
	);
	if (row === null || row === undefined) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	const [item] = hydrate(db, scopeKey, [row]);
	if (item === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return item;
}

// ---- 書き込み ----

interface WriteContext {
	readonly principal: string;
	readonly scopeKey: string;
	readonly seq: number;
	readonly atMs: number;
}

interface NewItemExtras {
	readonly evidence: readonly Pick<EvidenceSpan, "source">[];
	readonly validFromMs: number | null;
	readonly validUntilMs: number | null;
	readonly validity?: ValidityPeriod;
}

/** 精度つきの期間を保存用の 3 列へ。 */
function validityColumns(
	validity: ValidityPeriod | undefined,
): [string | null, string | null, string | null] {
	if (validity === undefined) return [null, null, null];
	return [
		validity.from === undefined ? null : formatPartialDate(validity.from),
		validity.until === undefined ? null : formatPartialDate(validity.until),
		validity.basis,
	];
}

function readValidityColumns(row: unknown): { validity?: ValidityPeriod } {
	const basis = readNullableText(row, "valid_basis");
	if (basis === null) return {};
	if (!(VALIDITY_BASES as readonly string[]).includes(basis)) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	const from = readNullableText(row, "valid_from_text");
	const until = readNullableText(row, "valid_until_text");
	try {
		return {
			validity: {
				...(from === null ? {} : { from: parsePartialDate(from) }),
				...(until === null ? {} : { until: parsePartialDate(until) }),
				basis: basis as ValidityPeriod["basis"],
			},
		};
	} catch {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
}

function run(db: MemoryDb, sql: string, params: SqlValue[]): void {
	guarded(() => db.query(sql).run(...params));
}

function insertAttributes(
	db: MemoryDb,
	itemId: string,
	value: StateValue,
): void {
	const attributes = ownValue(value, "attributes");
	if (attributes === undefined) return;
	for (const key of Object.keys(attributes).sort()) {
		run(
			db,
			"INSERT INTO memory_state_attribute (item_id, attr_key, attr_value) VALUES (?, ?, ?)",
			[itemId, key, attributes[key] as string],
		);
	}
}

function insertEvidence(
	db: MemoryDb,
	ctx: WriteContext,
	itemId: string,
	evidence: readonly Pick<EvidenceSpan, "source">[],
): void {
	for (const [index, span] of evidence.entries()) {
		const ref = span.source;
		const range = ownValue(ref, "range");
		if (range === undefined) throw new MemoryStoreError("CORRUPT_ROW");
		const key = sourceKey(ref);
		run(
			db,
			`INSERT INTO memory_state_evidence
				(item_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, start_byte, end_byte)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				itemId,
				index,
				key,
				ref.namespace,
				ref.kind,
				ref.id,
				ownValue(ref, "representation") ?? null,
				ref.revision,
				ref.digest,
				range.startByte,
				range.endByte,
			],
		);
		addDependency(db, {
			principal: ctx.principal,
			scopeKey: ctx.scopeKey,
			dependentType: "state_item",
			dependentId: itemId,
			dependencyType: "source",
			dependencyId: key,
			role: index === 0 ? "primary" : "support",
		});
	}
}

function itemExists(db: MemoryDb, itemId: string): boolean {
	const row = guarded(() =>
		db
			.query("SELECT 1 AS found FROM memory_state_item WHERE item_id = ?")
			.get(itemId),
	);
	return row !== null && row !== undefined;
}

function writeItem(
	db: MemoryDb,
	ctx: WriteContext,
	view: StateItemView,
	result: Extract<StateTransitionResult, { ok: true }>,
	extras: NewItemExtras | null,
	replacedEvidence: readonly Pick<EvidenceSpan, "source">[] | null,
): void {
	if (itemExists(db, view.itemId)) {
		run(
			db,
			`UPDATE memory_state_item
			SET status = ?, revision = ?, value_text = ?, polarity = ?, origin = ?,
				evidence_ordinal = ?, updated_seq = ?
			WHERE item_id = ? AND principal = ? AND scope_key = ?`,
			[
				view.status,
				view.revision,
				view.value.text,
				view.value.polarity,
				view.origin,
				view.evidenceOrdinal,
				ctx.seq,
				view.itemId,
				ctx.principal,
				ctx.scopeKey,
			],
		);
		const edited = result.events.some(
			(event) => event.itemId === view.itemId && event.action === "edit",
		);
		if (edited) {
			run(db, "DELETE FROM memory_state_attribute WHERE item_id = ?", [
				view.itemId,
			]);
			insertAttributes(db, view.itemId, view.value);
			if (replacedEvidence !== null) {
				run(db, "DELETE FROM memory_state_evidence WHERE item_id = ?", [
					view.itemId,
				]);
				insertEvidence(db, ctx, view.itemId, replacedEvidence);
			}
		}
		return;
	}
	if (extras === null) throw new MemoryStoreError("CORRUPT_ROW");
	run(
		db,
		`INSERT INTO memory_state_item
			(item_id, principal, scope_key, subject, kind, semantic_key, status, revision,
			 value_text, polarity, origin, evidence_ordinal, valid_from_ms, valid_until_ms,
			 valid_from_text, valid_until_text, valid_basis, created_seq, updated_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			view.itemId,
			ctx.principal,
			ctx.scopeKey,
			view.subject,
			view.kind,
			view.semanticKey,
			view.status,
			view.revision,
			view.value.text,
			view.value.polarity,
			view.origin,
			view.evidenceOrdinal,
			extras.validFromMs,
			extras.validUntilMs,
			...validityColumns(extras.validity),
			ctx.seq,
			ctx.seq,
		],
	);
	insertAttributes(db, view.itemId, view.value);
	insertEvidence(db, ctx, view.itemId, extras.evidence);
}

function writeEvent(
	db: MemoryDb,
	ctx: WriteContext,
	draft: StateEventDraft,
): void {
	run(
		db,
		`INSERT INTO memory_state_event
			(event_seq, item_id, principal, scope_key, action, from_revision, to_revision,
			 cause_type, cause_id, at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			issueSeq(db),
			draft.itemId,
			ctx.principal,
			ctx.scopeKey,
			draft.action,
			draft.fromRevision,
			draft.toRevision,
			draft.cause.type,
			draft.cause.id,
			draft.atMs,
		],
	);
}

/**
 * reducer の結果を書く。items の順（旧 → 新）に書くので、同 key の active 一意 index を壊さない。
 * 変更があれば scope revision を +1 し、item ごとに変更フィードへ追記する。
 */
function persist(
	db: MemoryDb,
	ctx: WriteContext,
	result: Extract<StateTransitionResult, { ok: true }>,
	extras: NewItemExtras | null,
	replacedEvidence: readonly Pick<EvidenceSpan, "source">[] | null,
): void {
	for (const view of result.items) {
		writeItem(db, ctx, view, result, extras, replacedEvidence);
	}
	for (const draft of result.events) writeEvent(db, ctx, draft);
	bumpScopeRevision(db, ctx.principal, ctx.scopeKey);
	for (const view of result.items) {
		appendMemoryChange(db, {
			principal: ctx.principal,
			scopeKey: ctx.scopeKey,
			atMs: ctx.atMs,
			targetType: "state_item",
			targetId: view.itemId,
			revision: String(view.revision),
			status: view.status,
			forgetId: null,
		});
	}
}

function isPermitted(access: AccessContext, scopeKey: string): boolean {
	return access.scopeKeys.includes(scopeKey);
}

/** 墓標のある出典（SourceKey、または Memory の record）を根拠にできない。 */
function hasTombstonedSource(
	db: MemoryDb,
	evidence: readonly EvidenceSpan[],
): boolean {
	return evidence.some((span) => {
		const ref = span.source;
		if (isTombstoned(db, "source", sourceKey(ref))) return true;
		return (
			ref.namespace === MEMORY_SOURCE_NAMESPACE &&
			ref.kind === MEMORY_RECORD_SOURCE_KIND &&
			isTombstoned(db, "record", ref.id)
		);
	});
}

/** 明示操作の根拠検査。本文つきの `sources` が入力であり現在状態でもある。 */
function checkUserEvidence(
	db: MemoryDb,
	input: EditStateInput | AssertUserStateInput,
):
	| { readonly ok: false; readonly reasonCode: StateReasonCode }
	| { readonly ok: true; readonly ordinal: number } {
	if (hasTombstonedSource(db, input.evidence)) {
		return { ok: false, reasonCode: "SOURCE_TOMBSTONED" };
	}
	const scope = {
		principal: input.access.principal,
		scopeKey: input.scopeKey,
		evidence: input.evidence,
		inputSources: input.sources,
	};
	const failure = checkEvidence({ ...scope, currentSources: input.sources });
	if (failure !== null) return { ok: false, reasonCode: failure };
	const ordinal = evidenceOrdinalOf(scope);
	if (ordinal === null) {
		return { ok: false, reasonCode: "EVIDENCE_NOT_IN_INPUT" };
	}
	return { ok: true, ordinal };
}

const USER_CAUSE = (access: AccessContext): StateCause => ({
	type: "user",
	id: access.principal,
});

/**
 * 明示操作でユーザーが主張する state を作る（モデルなし）。
 * `replaces` なし: 同 (subject, kind, semanticKey) の active が無ければ新規 active、同値なら冪等
 * （`unchanged`、既存 item を返す）、値が違えば `ACTIVE_EXISTS`。
 * `replaces` あり: その active を CAS で置き換える（旧は `superseded`、新は別 item の active）。
 * 明示操作は根拠の新旧比較を受けない。
 */
export function assertUserState(
	db: MemoryDb,
	input: AssertUserStateInput,
): StateWriteResult {
	const parsed = parseAssertUserStateInput(input);
	const seq = enterWrite(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = parsed.access.principal;
	const scopeKey = parsed.scopeKey;
	if (!isSubjectKindConsistent(parsed.subject, parsed.kind)) {
		return { status: "rejected", reasonCode: "SUBJECT_KIND_MISMATCH" };
	}
	const evidence = checkUserEvidence(db, parsed);
	if (!evidence.ok) {
		return { status: "rejected", reasonCode: evidence.reasonCode };
	}
	const active = loadActiveForKey(
		db,
		principal,
		scopeKey,
		parsed.subject,
		parsed.kind,
		parsed.semanticKey,
	);
	const replaces = ownValue(parsed, "replaces");
	let target: ItemRow | null = null;
	if (replaces !== undefined) {
		const loaded = loadItem(db, principal, scopeKey, replaces.itemId);
		if (loaded.status !== "found") return { status: loaded.status };
		target = loaded.row;
	}
	const ctx: WriteContext = {
		principal,
		scopeKey,
		seq,
		atMs: parsed.clock.atMs,
	};
	const identity = {
		itemId: stateItemId(principal, scopeKey, seq),
		subject: parsed.subject,
		kind: parsed.kind,
		semanticKey: parsed.semanticKey,
	};
	const transition: StateTransitionRequest = {
		action: target === null ? "assert" : "supersede",
		expectedRevision: replaces?.revision ?? null,
		identity,
		value: parsed.value,
		origin: parsed.origin,
		evidenceOrdinal: evidence.ordinal,
		cause: USER_CAUSE(parsed.access),
	};
	const result = applyStateTransition(target?.view ?? null, transition, {
		atMs: ctx.atMs,
		// 明示操作は同 key の履歴（disputed・ユーザーが消したもの）を見ない（CAS だけ）ので keyHistory は渡さない。
		activeForKey: active?.view ?? null,
	});
	if (!result.ok) {
		return { status: "rejected", reasonCode: result.reasonCode };
	}
	// 同値の既存 item に別の期間を指定した書き込みは、期間を黙って捨てずに拒否する。期間を変えるには、値の違う
	// 書き込みで置き換えるか、忘却して登録し直す（期間だけを書き換える操作はまだ無い）。
	const touched =
		result.items.length === 0
			? (target?.view.itemId ?? active?.view.itemId)
			: subjectItemOf(result).itemId;
	if (
		touched !== undefined &&
		periodConflictsWithStored(db, principal, scopeKey, touched, parsed)
	) {
		return { status: "rejected", reasonCode: "INVALID_TRANSITION" };
	}
	if (result.items.length === 0) {
		const existing = target?.view.itemId ?? active?.view.itemId;
		if (existing === undefined) throw new MemoryStoreError("CORRUPT_ROW");
		return {
			status: "unchanged",
			item: readFullItem(db, principal, scopeKey, existing),
		};
	}
	persist(
		db,
		ctx,
		result,
		{
			evidence: parsed.evidence,
			...assertedValidity(parsed),
		},
		null,
	);
	return {
		status: "applied",
		item: readFullItem(db, principal, scopeKey, subjectItemOf(result).itemId),
	};
}

/**
 * 値と根拠を明示操作で書き換える（active / inactive / disputed の item。status は変わらない）。
 * 同値は `unchanged`（根拠だけの差し替えは行わない）。
 */
export function editState(
	db: MemoryDb,
	input: EditStateInput,
): StateWriteResult {
	const parsed = parseEditStateInput(input);
	const seq = enterWrite(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = parsed.access.principal;
	const scopeKey = parsed.scopeKey;
	const loaded = loadItem(db, principal, scopeKey, parsed.itemId);
	if (loaded.status !== "found") return { status: loaded.status };
	const evidence = checkUserEvidence(db, parsed);
	if (!evidence.ok) {
		return { status: "rejected", reasonCode: evidence.reasonCode };
	}
	const ctx: WriteContext = {
		principal,
		scopeKey,
		seq,
		atMs: parsed.clock.atMs,
	};
	const result = applyStateTransition(
		loaded.row.view,
		{
			action: "edit",
			expectedRevision: parsed.expectedRevision,
			value: parsed.value,
			origin: parsed.origin,
			evidenceOrdinal: evidence.ordinal,
			cause: USER_CAUSE(parsed.access),
		},
		{ atMs: ctx.atMs, activeForKey: null },
	);
	if (!result.ok) {
		return { status: "rejected", reasonCode: result.reasonCode };
	}
	if (result.items.length === 0) {
		return {
			status: "unchanged",
			item: readFullItem(db, principal, scopeKey, parsed.itemId),
		};
	}
	// 同値の昇格（origin だけが変わる）では根拠を差し替えない。値が変わるときだけユーザーの根拠に置き換える。
	persist(
		db,
		ctx,
		result,
		null,
		stateValueEquals(loaded.row.view.value, parsed.value)
			? null
			: parsed.evidence,
	);
	return {
		status: "applied",
		item: readFullItem(db, principal, scopeKey, parsed.itemId),
	};
}

function changeStatus(
	db: MemoryDb,
	input: StateTargetInput,
	chooseAction: (status: StateItemStatus) => StateTransitionAction,
): StateWriteResult {
	const parsed = parseStateTargetInput(input);
	const seq = enterWrite(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = parsed.access.principal;
	const scopeKey = parsed.scopeKey;
	const loaded = loadItem(db, principal, scopeKey, parsed.itemId);
	if (loaded.status !== "found") return { status: loaded.status };
	const view = loaded.row.view;
	const active = loadActiveForKey(
		db,
		principal,
		scopeKey,
		view.subject,
		view.kind,
		view.semanticKey,
	);
	const ctx: WriteContext = {
		principal,
		scopeKey,
		seq,
		atMs: parsed.clock.atMs,
	};
	const result = applyStateTransition(
		view,
		{
			action: chooseAction(view.status),
			expectedRevision: parsed.expectedRevision,
			cause: USER_CAUSE(parsed.access),
		},
		{ atMs: ctx.atMs, activeForKey: active?.view ?? null },
	);
	if (!result.ok) {
		return { status: "rejected", reasonCode: result.reasonCode };
	}
	if (result.items.length > 0) persist(db, ctx, result, null, null);
	return {
		status: result.items.length === 0 ? "unchanged" : "applied",
		item: readFullItem(db, principal, scopeKey, parsed.itemId),
	};
}

/** active → inactive。可逆で、墓標・ジャーナル・ForgetReceipt を作らない（忘却ではない）。 */
export function deactivateState(
	db: MemoryDb,
	input: StateTargetInput,
): StateWriteResult {
	return changeStatus(db, input, () => "deactivate");
}

/** inactive → active（同 key に別の active があれば `ACTIVE_EXISTS`）。disputed は `activate`（紛争の解決）になる。 */
export function reactivateState(
	db: MemoryDb,
	input: StateTargetInput,
): StateWriteResult {
	return changeStatus(db, input, (status) =>
		status === "disputed" ? "activate" : "reactivate",
	);
}

/** ユーザーによる撤回。retracted は終端（復帰しない）。value は残る（忘却は lifecycle の forget）。 */
export function retractState(
	db: MemoryDb,
	input: StateTargetInput,
): StateWriteResult {
	return changeStatus(db, input, () => "retract");
}

// ---- Extraction（src/domains/extraction/repository/index.ts）向けの内部操作（`./sqlite` からは公開しない）----

/** 同 (subject, kind, semanticKey) の現在の active（なければ null）。墓標のあるものは除く。 */
export function findActiveStateView(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	subject: StateSubject,
	kind: StateKind,
	semanticKey: string,
): StateItemView | null {
	return (
		loadActiveForKey(db, principal, scopeKey, subject, kind, semanticKey)
			?.view ?? null
	);
}

/** scope 内の item の現在像。他 scope・存在しない → missing、墓標あり／forgotten → forgotten。 */
export function readStateItemView(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	itemId: string,
):
	| { readonly status: "found"; readonly view: StateItemView }
	| { readonly status: "missing" | "forgotten" } {
	const loaded = loadItem(db, principal, scopeKey, itemId);
	return loaded.status === "found"
		? { status: "found", view: loaded.row.view }
		: { status: loaded.status };
}

/** 同 (subject, kind, semanticKey) の active 以外の履歴の要約（`StateKeyHistory`）。墓標のある item は除く。 */
export function findStateKeyHistory(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	subject: StateSubject,
	kind: StateKind,
	semanticKey: string,
): StateKeyHistory {
	return loadKeyHistory(db, principal, scopeKey, subject, kind, semanticKey);
}

/** scope 内の (subject, kind) で使われている意味 key（forgotten を除く、重複なし、昇順）。辞書による同値の key を探すのに使う。 */
export function listStateKeys(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	subject: StateSubject,
	kind: StateKind,
): string[] {
	return guarded(() =>
		db
			.query(
				`SELECT DISTINCT i.semantic_key AS semantic_key FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.subject = ? AND i.kind = ?
					AND i.status != 'forgotten' AND i.semantic_key != '' AND ${NO_TOMBSTONE}
				ORDER BY i.semantic_key ASC`,
			)
			.all(principal, scopeKey, subject, kind),
	).map((row) => readText(row, "semantic_key"));
}

export interface CandidateStateWrite {
	readonly principal: string;
	readonly scopeKey: string;
	readonly atMs: number;
	readonly subject: StateSubject;
	readonly kind: StateKind;
	readonly semanticKey: string;
	readonly value: StateValue;
	/** range つきの根拠（先頭が primary）。 */
	readonly evidence: readonly { readonly source: SourceRef }[];
	readonly evidenceOrdinal: number;
	readonly origin: StateOrigin;
	readonly candidateId: string;
	/** 既存 active を CAS で置き換える（確認操作）。null なら assert（同 key の active があれば reducer が決める）。 */
	readonly replaces: {
		readonly itemId: string;
		readonly revision: number;
	} | null;
}

export type CandidateStateWriteResult =
	| {
			readonly status: "applied" | "unchanged";
			/** applied: 作った item。unchanged: 同値の既存 item。 */
			readonly itemId: string;
	  }
	| { readonly status: "rejected"; readonly reasonCode: StateReasonCode }
	| { readonly status: "missing" | "forgotten" };

/**
 * 候補から state item を作る（抽出の自動採用 `admitted_extraction`、または確認操作 `user_confirmed` /
 * `user_edited`）。呼び出しごとに seq を 1 つ発行するので、1 回の settle で複数 item を作れる。
 * 出典の墓標・版の検査は呼び出し側。item は候補への依存辺（derived_from）を持つ。
 * 書き込み系の入口（`enterWrite`）の中で呼ぶこと。
 */
export function writeStateForCandidate(
	db: MemoryDb,
	input: CandidateStateWrite,
): CandidateStateWriteResult {
	const { principal, scopeKey } = input;
	const seq = issueSeq(db);
	const active = loadActiveForKey(
		db,
		principal,
		scopeKey,
		input.subject,
		input.kind,
		input.semanticKey,
	);
	let target: ItemRow | null = null;
	if (input.replaces !== null) {
		const loaded = loadItem(db, principal, scopeKey, input.replaces.itemId);
		if (loaded.status !== "found") return { status: loaded.status };
		target = loaded.row;
	}
	const ctx: WriteContext = { principal, scopeKey, seq, atMs: input.atMs };
	const identity = {
		itemId: stateItemId(principal, scopeKey, seq),
		subject: input.subject,
		kind: input.kind,
		semanticKey: input.semanticKey,
	};
	const result = applyStateTransition(
		target?.view ?? null,
		{
			action: target === null ? "assert" : "supersede",
			expectedRevision: input.replaces?.revision ?? null,
			identity,
			value: input.value,
			origin: input.origin,
			evidenceOrdinal: input.evidenceOrdinal,
			cause: { type: "candidate", id: input.candidateId },
		},
		{
			atMs: ctx.atMs,
			activeForKey: active?.view ?? null,
			keyHistory: loadKeyHistory(
				db,
				principal,
				scopeKey,
				input.subject,
				input.kind,
				input.semanticKey,
			),
		},
	);
	if (!result.ok) return { status: "rejected", reasonCode: result.reasonCode };
	if (result.items.length === 0) {
		const existing = target?.view.itemId ?? active?.view.itemId;
		if (existing === undefined) throw new MemoryStoreError("CORRUPT_ROW");
		return { status: "unchanged", itemId: existing };
	}
	persist(
		db,
		ctx,
		result,
		{ evidence: input.evidence, validFromMs: null, validUntilMs: null },
		null,
	);
	const written = subjectItemOf(result);
	addDependency(db, {
		principal,
		scopeKey,
		dependentType: "state_item",
		dependentId: written.itemId,
		dependencyType: "candidate",
		dependencyId: input.candidateId,
		role: "derived_from",
	});
	return { status: "applied", itemId: written.itemId };
}

/** 読み取り用: item 全体（evidence・attributes つき）。他 scope・墓標あり → null。 */
export function readStateItem(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	itemId: string,
): StateItem | null {
	const loaded = loadItem(db, principal, scopeKey, itemId);
	return loaded.status === "found"
		? readFullItem(db, principal, scopeKey, itemId)
		: null;
}

// ---- 読み取り ----

/** scope 内の state item を返す（`forgotten` は常に除く）。順序は updated_seq の降順、同じなら itemId。 */
export function listState(
	db: MemoryDb,
	input: ListStateInput,
): ListStateResult {
	const parsed = parseListStateInput(input);
	enterRead(db);
	const includeInactive = ownValue(parsed, "includeInactive");
	const kinds = ownValue(parsed, "kinds");
	const limit = ownValue(parsed, "limit");
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const statuses =
		includeInactive === true
			? STATE_ITEM_STATUSES.filter((status) => status !== "forgotten")
			: (["active"] as const);
	const params: SqlValue[] = [
		parsed.access.principal,
		parsed.scopeKey,
		...statuses,
	];
	let kindClause = "";
	if (kinds !== undefined) {
		kindClause = ` AND i.kind IN (${placeholders(kinds.length)})`;
		params.push(...kinds);
	}
	params.push(limit ?? LIMITS_STATE.maxListItems);
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${ITEM_COLUMNS} FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ?
					AND i.status IN (${placeholders(statuses.length)})${kindClause}
					AND ${NO_TOMBSTONE}
				ORDER BY i.updated_seq DESC, i.item_id ASC
				LIMIT ?`,
			)
			.all(...params),
	);
	return {
		status: "ok",
		items: hydrate(db, parsed.scopeKey, rows),
	};
}

/** item と同じ事実（同 subject・kind・semanticKey）の、forgotten・墓標つきを除く全版の ID を古い順に返す。 */
export function readStateFact(
	db: MemoryDb,
	input: ReadStateFactInput,
): ReadStateFactResult {
	const parsed = parseReadStateFactInput(input);
	enterRead(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = parsed.access.principal;
	const loaded = loadItem(db, principal, parsed.scopeKey, parsed.itemId);
	if (loaded.status !== "found") return { status: loaded.status };
	const { subject, kind, semanticKey } = loaded.row.view;
	const rows = guarded(() =>
		db
			.query(
				`SELECT i.item_id FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.subject = ? AND i.kind = ?
					AND i.semantic_key = ? AND i.status != 'forgotten' AND ${NO_TOMBSTONE}
				ORDER BY i.created_seq ASC, i.item_id ASC`,
			)
			.all(principal, parsed.scopeKey, subject, kind, semanticKey),
	);
	return {
		status: "ok",
		subject,
		kind,
		semanticKey,
		itemIds: rows.map((row) => readText(row, "item_id")),
	};
}

function hasMoreItems(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	includeInactive: boolean,
): boolean {
	const statuses = includeInactive
		? STATE_ITEM_STATUSES.filter((status) => status !== "forgotten")
		: (["active"] as const);
	const row = guarded(() =>
		db
			.query(
				`SELECT COUNT(*) AS n FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ?
					AND i.status IN (${placeholders(statuses.length)}) AND ${NO_TOMBSTONE}`,
			)
			.get(principal, scopeKey, ...statuses),
	);
	return readInteger(row, "n") > LIMITS_STATE.maxListItems;
}

/** 複数 scope の state item と各 scope の版を 1 回で読む。許可外の scope が 1 つでもあれば全体を blocked にする。 */
export function listStateScopes(
	db: MemoryDb,
	input: ListStateScopesInput,
): ListStateScopesResult {
	const parsed = parseListStateScopesInput(input);
	enterRead(db);
	if (
		!parsed.scopeKeys.every((scopeKey) => isPermitted(parsed.access, scopeKey))
	) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const scopes = parsed.scopeKeys.map((scopeKey) => {
		const listed = listState(db, {
			contractVersion: parsed.contractVersion,
			access: parsed.access,
			scopeKey,
			limit: LIMITS_STATE.maxListItems,
			...(parsed.includeInactive === undefined
				? {}
				: { includeInactive: parsed.includeInactive }),
		});
		if (listed.status !== "ok") throw new MemoryStoreError("CORRUPT_ROW");
		// 上限ちょうどのときは、次の 1 件があるかを別に確かめる。
		const truncated =
			listed.items.length >= LIMITS_STATE.maxListItems &&
			hasMoreItems(
				db,
				parsed.access.principal,
				scopeKey,
				parsed.includeInactive === true,
			);
		return {
			scopeKey,
			revision: String(
				readScopeRevision(db, parsed.access.principal, scopeKey),
			),
			items: listed.items,
			truncated,
		};
	});
	return { status: "ok", scopes };
}

function isItemKindV2(kind: string): kind is ItemKindV2 {
	return (ITEM_KINDS_V2 as readonly string[]).includes(kind);
}

/**
 * View v2 の Snapshot に合成する Memory 側の部品の state 部分（records 部分の本文は S4 が合成する）。
 * items = scope の active かつ `subject: self` の state item（`other_person_note` は含めない）。
 * 否定（polarity negated）の値は `text` を `NOT: ` で始める。`primarySource` は先頭の evidence、
 * `dependencies` は evidence 全部。`sources` = items の依存のうち Memory 所有の出典（Records）の現在状態。
 * 複数文を読むので、一貫した snapshot はホストの read transaction に依存する。
 */
export function readMemorySnapshotPart(
	db: MemoryDb,
	input: ReadMemorySnapshotPartInput,
): ReadMemorySnapshotPartResult {
	const parsed = parseReadSnapshotPartInput(input);
	enterRead(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${ITEM_COLUMNS} FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ? AND i.status = 'active'
					AND i.subject = 'self' AND ${NO_TOMBSTONE}
				ORDER BY i.created_seq ASC, i.item_id ASC`,
			)
			.all(parsed.access.principal, parsed.scopeKey),
	);
	const items: MemoryItemV2[] = [];
	const recordRefs = new Map<string, SourceRef>();
	for (const stateItem of hydrate(db, parsed.scopeKey, rows)) {
		const primary = stateItem.evidence[0];
		if (primary === undefined || !isItemKindV2(stateItem.kind)) {
			throw new MemoryStoreError("CORRUPT_ROW");
		}
		for (const ref of stateItem.evidence) {
			if (
				ref.namespace === MEMORY_SOURCE_NAMESPACE &&
				ref.kind === MEMORY_RECORD_SOURCE_KIND
			) {
				const { range: _range, ...whole } = ref;
				recordRefs.set(
					`${sourceKey(ref)}|${ref.revision}|${ref.digest}`,
					whole,
				);
			}
		}
		items.push({
			id: stateItem.itemId,
			revision: String(stateItem.revision),
			kind: stateItem.kind,
			text:
				stateItem.value.polarity === "negated"
					? `${NEGATED_TEXT_PREFIX}${stateItem.value.text}`
					: stateItem.value.text,
			status: "active",
			origin: stateItem.origin,
			primarySource: primary,
			dependencies: stateItem.evidence,
			subject: "self",
		});
	}
	const sources: SourceState[] = [];
	const refs = [...recordRefs.values()];
	for (
		let start = 0;
		start < refs.length;
		start += LIMITS_RECORDS.maxSourceStateRefs
	) {
		sources.push(
			...recordSourceStates(db, {
				contractVersion: parsed.contractVersion,
				access: parsed.access,
				scopeKey: parsed.scopeKey,
				refs: refs.slice(start, start + LIMITS_RECORDS.maxSourceStateRefs),
			}),
		);
	}
	return {
		status: "ok",
		memoryRevision: String(
			readScopeRevision(db, parsed.access.principal, parsed.scopeKey),
		),
		items,
		sources,
	};
}

// ---- 忘却（lifecycle の閉包適用が呼ぶ。reducer を通さない）----

function selectFirst(db: MemoryDb, sql: string, params: SqlValue[]): unknown {
	const row = guarded(() => db.query(sql).get(...params));
	return row === undefined ? null : row;
}

function selectAll(db: MemoryDb, sql: string, params: SqlValue[]): unknown[] {
	return guarded(() => db.query(sql).all(...params));
}

export interface ScrubbedStateItem {
	/** 行が principal のものなら scope。行がない／他 principal の行なら null（何も書かない）。 */
	readonly scopeKey: string | null;
	/** 今回 `forgotten` に遷移したか（既に forgotten なら false）。 */
	readonly transitioned: boolean;
}

/**
 * state item の値を消す（冪等）。規約（0003 の JSDoc）: value_text / polarity / 有効期間を NULL、semantic_key を ''、
 * status を `forgotten`、attribute / evidence の行を削除、event は action と seq（と item・scope の ID）だけ残す。
 * 初めて forgotten になるときだけ revision を +1 し、`forget` event を足す。墓標は呼び出し側が書く。
 */
export function scrubStateItem(
	db: MemoryDb,
	principal: string,
	itemId: string,
	opSeq: number,
): ScrubbedStateItem {
	const row = selectFirst(
		db,
		"SELECT principal, scope_key, status FROM memory_state_item WHERE item_id = ?",
		[itemId],
	);
	if (row === null || readText(row, "principal") !== principal) {
		return { scopeKey: null, transitioned: false };
	}
	const scopeKey = readText(row, "scope_key");
	const transitioned = readText(row, "status") !== "forgotten";
	run(db, "DELETE FROM memory_state_attribute WHERE item_id = ?", [itemId]);
	run(db, "DELETE FROM memory_state_evidence WHERE item_id = ?", [itemId]);
	run(
		db,
		`UPDATE memory_state_item SET status = 'forgotten', semantic_key = '', value_text = NULL,
			polarity = NULL, valid_from_ms = NULL, valid_until_ms = NULL,
			valid_from_text = NULL, valid_until_text = NULL, valid_basis = NULL,
			revision = CASE WHEN status = 'forgotten' THEN revision ELSE revision + 1 END,
			updated_seq = CASE WHEN status = 'forgotten' THEN updated_seq ELSE ? END
		WHERE item_id = ?`,
		[opSeq, itemId],
	);
	run(
		db,
		`UPDATE memory_state_event SET from_revision = NULL, to_revision = NULL, cause_id = '', at_ms = 0
		WHERE item_id = ?`,
		[itemId],
	);
	if (transitioned) {
		run(
			db,
			`INSERT INTO memory_state_event
				(event_seq, item_id, principal, scope_key, action, from_revision, to_revision,
				 cause_type, cause_id, at_ms)
			VALUES (?, ?, ?, ?, 'forget', NULL, NULL, 'lifecycle', '', 0)`,
			[issueSeq(db), itemId, principal, scopeKey],
		);
	}
	return { scopeKey, transitioned };
}

/** scope の state item の ID（`createdBefore` が非 null ならその seq より前に作られたものだけ）。 */
export function listStateItemIdsInScope(
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
	return selectAll(
		db,
		`SELECT item_id FROM memory_state_item WHERE principal = ? AND scope_key = ?${extra}
		ORDER BY item_id ASC`,
		params,
	).map((entry) => readText(entry, "item_id"));
}

/** item が principal と scope のものとして存在するか（forget の target 検査用）。 */
export function stateItemScope(
	db: MemoryDb,
	itemId: string,
): { readonly principal: string; readonly scopeKey: string } | null {
	const row = selectFirst(
		db,
		"SELECT principal, scope_key FROM memory_state_item WHERE item_id = ?",
		[itemId],
	);
	return row === null
		? null
		: {
				principal: readText(row, "principal"),
				scopeKey: readText(row, "scope_key"),
			};
}
