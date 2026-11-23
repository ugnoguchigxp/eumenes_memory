/**
 * State 台帳の永続 API（契約は `src/domains/state/contracts/index.ts`）。
 *
 * - 書き込み（assertUserState / deactivateState / reactivateState / retractState）は
 *   ホストの write transaction の中で 1 回呼ぶ。入口は `enterWrite`。遷移の妥当性は純粋な
 *   `src/domains/state/service/reducer.ts` が決め、このファイルは「読む → reducer → 書く」だけをする。
 *   拒否（`rejected` / `blocked` / `missing` / `forgotten`）と冪等（`unchanged`）では何も書かない。
 * - 読み取り（listState / readStateFact）は `enterRead`。読み出しは scope index（先頭が
 *   principal, scope_key）を使い、status に加えて墓標の不在を必須条件にする。
 * - deactivate / reactivate は可逆で、墓標・ジャーナル・ForgetReceipt を作らない（忘却ではない）。
 *   `forget` は reducer を通さず lifecycle が閉包で適用する。
 * - 1 回の書き込みは、変更した item ごとに変更フィードへ 1 行追記する。
 * - 派生行の規則: item の evidence の出典（SourceKey）に必ず依存辺を張る（先頭が primary、残りは support）。
 */
import type { StateSubject } from "../../../contracts/common.ts";
import {
	MEMORY_RECORD_SOURCE_KIND,
	MEMORY_SOURCE_NAMESPACE,
} from "../../../contracts/common.ts";

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
	ListStateInput,
	ListStateResult,
	ReadStateFactInput,
	ReadStateFactResult,
	SearchStateInput,
	SearchStateResult,
	StateCause,
	StateChangeKind,
	StateEventDraft,
	StateItem,
	StateItemStatus,
	StateItemView,
	StateKind,
	StateReasonCode,
	StateTargetInput,
	StateTransitionAction,
	StateTransitionResult,
	StateValue,
	StateWriteResult,
} from "../contracts/index.ts";
import type { EvidenceSpan } from "../../../contracts/common.ts";
import type { AccessContext, SourceRef } from "../../../contracts/types.ts";
import { ownValue } from "../../../contracts/own.ts";
import {
	VALIDITY_BASES,
	formatPartialDate,
	parsePartialDate,
	periodBoundsMs,
} from "../../temporal/index.ts";
import type { ValidityPeriod } from "../../temporal/index.ts";
import { checkEvidence, evidenceOrdinalOf } from "../service/evidence.ts";

import { stateItemId } from "../service/ids.ts";
import {
	parseAssertUserStateInput,
	parseListStateInput,
	parseReadStateFactInput,
	parseSearchStateInput,
	parseStateTargetInput,
	STATE_SEARCH_LIMITS,
} from "../service/parse.ts";
import {
	applyStateTransition,
	isSubjectKindConsistent,
} from "../service/reducer.ts";
import type { StateTransitionRequest } from "../service/reducer.ts";
import { appendMemoryChange } from "../../../infrastructure/sqlite/changes.ts";
import {
	excludedSql,
	stateFactKey,
	suppressedSql,
	USER_ORIGIN_SQL,
} from "../../../infrastructure/sqlite/marks.ts";
import { stateValueEquals } from "../service/value.ts";
import { addDependency } from "../../../infrastructure/sqlite/dependency.ts";
import {
	guarded,
	issueSeq,
	readInteger,
	readNullableInteger,
	readNullableText,
	readRow,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";

import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import { isTombstoned } from "../../../infrastructure/sqlite/tombstone.ts";
import { syncStateSearch } from "./search-index.ts";

// ---- 行の読み取り ----

export interface ItemRow {
	readonly view: StateItemView;
	readonly validFromMs: number | null;
	readonly validUntilMs: number | null;
	readonly validity?: ValidityPeriod;
	readonly createdSeq: number;
	readonly updatedSeq: number;
	readonly strength: number;
	readonly suppressed: boolean;
	readonly excluded: boolean;
}

export const ITEM_COLUMNS = `i.item_id, i.subject, i.kind, i.semantic_key, i.status, i.revision,
	i.value_text, i.polarity, i.origin, i.evidence_ordinal, i.valid_from_ms,
	i.valid_until_ms, i.valid_from_text, i.valid_until_text, i.valid_basis,
	i.created_seq, i.updated_seq, i.strength,
	${suppressedSql("i")} AS suppressed, ${excludedSql("i")} AS excluded`;

export const NO_TOMBSTONE = `NOT EXISTS (SELECT 1 FROM memory_tombstone t
	WHERE t.target_type = 'state_item' AND t.target_id = i.item_id)`;

function readStrength(row: unknown): number {
	const value = readRow(row)["strength"];
	if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	return value;
}

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
		strength: readStrength(row),
		suppressed: readInteger(row, "suppressed") === 1,
		excluded: readInteger(row, "excluded") === 1,
	};
}

export function placeholders(count: number): string {
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
export function hydrate(
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
			...(parsed.strength === 1 ? {} : { strength: parsed.strength }),
			...(parsed.suppressed ? { suppressed: true as const } : {}),
			...(parsed.excluded ? { excluded: true as const } : {}),
		};
	});
}

export type LoadedItem =
	| { readonly status: "found"; readonly row: ItemRow }
	| { readonly status: "missing" | "forgotten" };

/** scope 内の item を 1 件読む（reducer 用）。他 scope・存在しない → missing、墓標あり／forgotten → forgotten。 */
export function loadItem(
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

export function loadActiveForKey(
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

export function readFullItem(
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

export interface WriteContext {
	readonly principal: string;
	readonly scopeKey: string;
	readonly seq: number;
	readonly atMs: number;
	/** 変更フィードの行に残す、変更を起こした run の ID。 */
	readonly sourceRunId?: string;
	/** `supersede` の旧版の行に付ける種類（既定 `correction`）。 */
	readonly change?: StateChangeKind;
}

export interface NewItemExtras {
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

export function run(db: MemoryDb, sql: string, params: SqlValue[]): void {
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

/** 保存済みの属性が value の属性と同じか（鍵の集合と値が一致）。 */
function sameAttributes(
	db: MemoryDb,
	itemId: string,
	value: StateValue,
): boolean {
	const wanted = ownValue(value, "attributes") ?? {};
	const rows = guarded(() =>
		db
			.query(
				"SELECT attr_key, attr_value FROM memory_state_attribute WHERE item_id = ?",
			)
			.all(itemId),
	);
	if (rows.length !== Object.keys(wanted).length) return false;
	return rows.every((row) => {
		const key = readText(row, "attr_key");
		return (
			Object.hasOwn(wanted, key) && wanted[key] === readText(row, "attr_value")
		);
	});
}

export function insertEvidence(
	db: MemoryDb,
	ctx: WriteContext,
	itemId: string,
	evidence: readonly Pick<EvidenceSpan, "source">[],
	firstIdx = 0,
): void {
	for (const [offset, span] of evidence.entries()) {
		const index = firstIdx + offset;
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

/**
 * 既存の evidence の後ろに追記する（同じ出典・同じ範囲は足さない）。origin の格上げで、確認に使った出典を
 * 根拠と依存辺に残すため（その出典の忘却が item に届くように）。格上げは item ごとに一度なので件数は有界。
 */
export function appendEvidence(
	db: MemoryDb,
	ctx: WriteContext,
	itemId: string,
	evidence: readonly Pick<EvidenceSpan, "source">[],
): void {
	const existing = selectAll(
		db,
		"SELECT idx, source_key, start_byte, end_byte FROM memory_state_evidence WHERE item_id = ?",
		[itemId],
	);
	const seen = new Set(
		existing.map(
			(row) =>
				`${readText(row, "source_key")}\u0001${readInteger(row, "start_byte")}\u0001${readInteger(row, "end_byte")}`,
		),
	);
	const fresh = evidence.filter((span) => {
		const range = ownValue(span.source, "range");
		if (range === undefined) throw new MemoryStoreError("CORRUPT_ROW");
		const key = `${sourceKey(span.source)}\u0001${range.startByte}\u0001${range.endByte}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const next = existing.reduce<number>(
		(max, row) => Math.max(max, readInteger(row, "idx") + 1),
		0,
	);
	insertEvidence(db, ctx, itemId, fresh, next);
}

function writeItem(
	db: MemoryDb,
	ctx: WriteContext,
	view: StateItemView,
	result: Extract<StateTransitionResult, { ok: true }>,
	extras: NewItemExtras | null,
	replacedEvidence: readonly Pick<EvidenceSpan, "source">[] | null,
	appendedEvidence: readonly Pick<EvidenceSpan, "source">[] | null = null,
): void {
	if (itemExists(db, view.itemId)) {
		run(
			db,
			`UPDATE memory_state_item
			SET revision = ?, polarity = ?, origin = ?, evidence_ordinal = ?, updated_seq = ?
			WHERE item_id = ? AND principal = ? AND scope_key = ?`,
			[
				view.revision,
				view.value.polarity,
				view.origin,
				view.evidenceOrdinal,
				ctx.seq,
				view.itemId,
				ctx.principal,
				ctx.scopeKey,
			],
		);
		// 索引に入る列（status、value_text）は、値が変わるときだけ書く。migration 0009 の trigger は
		// SET に列が現れるだけで発火し、secure-delete の消去を伴うので、確認や根拠の追加で索引を作り直さない。
		run(
			db,
			`UPDATE memory_state_item SET status = ?, value_text = ?
			WHERE item_id = ? AND principal = ? AND scope_key = ?
				AND (status IS NOT ? OR value_text IS NOT ?)`,
			[
				view.status,
				view.value.text,
				view.itemId,
				ctx.principal,
				ctx.scopeKey,
				view.status,
				view.value.text,
			],
		);
		const edited = result.events.some(
			(event) => event.itemId === view.itemId && event.action === "edit",
		);
		if (edited) {
			// 属性が同じなら書き直さない（属性の trigger が索引の行を消し、作り直しになるため）。
			if (!sameAttributes(db, view.itemId, view.value)) {
				run(db, "DELETE FROM memory_state_attribute WHERE item_id = ?", [
					view.itemId,
				]);
				insertAttributes(db, view.itemId, view.value);
			}
			if (replacedEvidence !== null) {
				run(db, "DELETE FROM memory_state_evidence WHERE item_id = ?", [
					view.itemId,
				]);
				insertEvidence(db, ctx, view.itemId, replacedEvidence);
			} else if (appendedEvidence !== null) {
				appendEvidence(db, ctx, view.itemId, appendedEvidence);
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
 * 変更があれば item ごとに変更フィードへ追記する。
 */
export function persist(
	db: MemoryDb,
	ctx: WriteContext,
	result: Extract<StateTransitionResult, { ok: true }>,
	extras: NewItemExtras | null,
	replacedEvidence: readonly Pick<EvidenceSpan, "source">[] | null,
	appendedEvidence: readonly Pick<EvidenceSpan, "source">[] | null = null,
): void {
	for (const view of result.items) {
		writeItem(
			db,
			ctx,
			view,
			result,
			extras,
			replacedEvidence,
			appendedEvidence,
		);
	}
	for (const draft of result.events) writeEvent(db, ctx, draft);
	// 全文検索の索引へ、変更した item を正本から登録し直す（削除は migration 0009 の trigger が行う）。
	syncStateSearch(
		db,
		result.items.map((view) => view.itemId),
	);
	const created = result.events.find((event) => event.action === "assert");
	for (const view of result.items) {
		const replaced = result.events.some(
			(event) => event.itemId === view.itemId && event.action === "supersede",
		);
		const changeKind = replaced ? (ctx.change ?? "correction") : undefined;
		appendMemoryChange(db, {
			principal: ctx.principal,
			scopeKey: ctx.scopeKey,
			atMs: ctx.atMs,
			targetType: "state_item",
			targetId: view.itemId,
			revision: String(view.revision),
			status: view.status,
			forgetId: null,
			...(ctx.sourceRunId === undefined
				? {}
				: { sourceRunId: ctx.sourceRunId }),
			...(changeKind === undefined ? {} : { changeKind }),
			...(replaced && created !== undefined
				? { successorId: created.itemId }
				: {}),
		});
	}
}

export function isPermitted(access: AccessContext, scopeKey: string): boolean {
	return access.scopeKeys.includes(scopeKey);
}

/** 墓標のある出典（SourceKey、または Memory の record）を根拠にできない。 */
export function hasTombstonedSource(
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
export function checkUserEvidence(
	db: MemoryDb,
	input: Pick<
		AssertUserStateInput,
		"access" | "scopeKey" | "evidence" | "sources"
	>,
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
	let seq = enterWrite(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = parsed.access.principal;
	const scopeKey = parsed.scopeKey;
	// 古い DB を復元すると seq が巻き戻り、新しい item の ID が reconcile の付け直した墓標とぶつかりうる。
	// 墓標の無い ID になるまで seq を取り直す（ID の式は変えない。衝突の回数は state_item の墓標の数を超えない）。
	while (
		isTombstoned(db, "state_item", stateItemId(principal, scopeKey, seq))
	) {
		seq = issueSeq(db);
	}
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
	const change = ownValue(parsed, "change");
	if (
		change === "consolidation" &&
		target !== null &&
		isUserOrigin(target.view.origin) &&
		!stateValueEquals(target.view.value, parsed.value)
	) {
		return { status: "rejected", reasonCode: "USER_TEXT_PROTECTED" };
	}
	const sourceRunId = ownValue(parsed, "sourceRunId");
	const ctx: WriteContext = {
		principal,
		scopeKey,
		seq,
		atMs: parsed.clock.atMs,
		...(sourceRunId === undefined ? {} : { sourceRunId }),
		...(change === undefined ? {} : { change }),
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
		// origin の格上げ（既存 item の edit）では、確認に使った出典を根拠に追記する。
		parsed.evidence,
	);
	return {
		status: "applied",
		item: readFullItem(db, principal, scopeKey, subjectItemOf(result).itemId),
	};
}

function isUserOrigin(origin: string): boolean {
	return (USER_STATE_ORIGINS as readonly string[]).includes(origin);
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
	const sourceRunId = ownValue(parsed, "sourceRunId");
	const ctx: WriteContext = {
		principal,
		scopeKey,
		seq,
		atMs: parsed.clock.atMs,
		...(sourceRunId === undefined ? {} : { sourceRunId }),
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

// ---- 読み取り ----

/** FTS5 の phrase として引用する（`"` は `""`）。利用者の入力を FTS5 の構文として解釈させない。 */
function quotePhrase(term: string): string {
	return `"${term.replaceAll('"', '""')}"`;
}

/**
 * 全文検索（設計 §3.5〜3.8）。絞り込み（principal、scope、active、kind、subject、短い語）は WHERE の中、
 * 順位は ORDER BY、件数は LIMIT で、全体の上位を取ってから権限で間引くことはしない。
 * 索引は候補の ID を出すだけで、返す item は正本（`memory_state_item`）から読み直す（active で墓標の無いものだけ）。
 * 読み取り専用。複数の SQL の一貫性はホストの read transaction で守る。
 */
export function searchState(
	db: MemoryDb,
	input: SearchStateInput,
): SearchStateResult {
	const parsed = parseSearchStateInput(input);
	enterRead(db);
	if (
		!parsed.scopeKeys.every((scopeKey) => isPermitted(parsed.access, scopeKey))
	) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const kinds = ownValue(parsed, "kinds");
	const subject = ownValue(parsed, "subject");
	const filterParams: SqlValue[] = [
		parsed.access.principal,
		...parsed.scopeKeys,
	];
	let filter = `i.principal = ? AND i.scope_key IN (${placeholders(parsed.scopeKeys.length)})
		AND i.status = 'active' AND ${NO_TOMBSTONE}`;
	if (kinds !== undefined) {
		filter += ` AND i.kind IN (${placeholders(kinds.length)})`;
		filterParams.push(...kinds);
	}
	if (subject !== undefined) {
		filter += " AND i.subject = ?";
		filterParams.push(subject);
	}
	// 除外された item は常に外す。推定由来だけ、強度の閾値で外す（本人由来は常に残す）。
	filter += ` AND NOT ${excludedSql("i")}`;
	const minStrength = ownValue(parsed, "minStrength");
	if (minStrength !== undefined) {
		filter += ` AND (i.origin IN ${USER_ORIGIN_SQL} OR i.strength >= ?)`;
		filterParams.push(minStrength);
	}
	const { indexed, scanned } = parsed.terms;
	const fetch = parsed.limit + 1;
	let rows: unknown[];
	let mode: "fts" | "scan";
	if (indexed.length > 0) {
		mode = "fts";
		const short = scanned
			.map(() => " AND instr(lower(f.doc), lower(?)) > 0")
			.join("");
		rows = guarded(() =>
			db
				.query(
					`SELECT ${ITEM_COLUMNS}, i.scope_key AS scope_key
					FROM memory_state_fts f
					JOIN memory_state_search_row r ON r.search_rowid = f.rowid
					JOIN memory_state_item i ON i.item_id = r.item_id
					WHERE memory_state_fts MATCH ? AND ${filter}${short}
					ORDER BY bm25(memory_state_fts) * i.strength, i.updated_seq DESC, i.item_id ASC
					LIMIT ?`,
				)
				.all(
					indexed.map(quotePhrase).join(" AND "),
					...filterParams,
					...scanned,
					fetch,
				),
		);
	} else {
		mode = "scan";
		const scanMax =
			ownValue(parsed, "scanMax") ?? STATE_SEARCH_LIMITS.defaultScanMax;
		const total = guarded(() =>
			db
				.query(`SELECT count(*) AS n FROM memory_state_item i WHERE ${filter}`)
				.get(...filterParams),
		);
		if (readInteger(total, "n") > scanMax) {
			return { status: "blocked", reasonCode: "SCAN_LIMIT_EXCEEDED" };
		}
		const short = scanned
			.map(() => " AND instr(lower(d.doc), lower(?)) > 0")
			.join("");
		rows = guarded(() =>
			db
				.query(
					`SELECT ${ITEM_COLUMNS}, i.scope_key AS scope_key
					FROM memory_state_item i
					JOIN memory_state_search_doc d ON d.item_id = i.item_id
					WHERE ${filter}${short}
					ORDER BY i.strength DESC, i.updated_seq DESC, i.item_id ASC
					LIMIT ?`,
				)
				.all(...filterParams, ...scanned, fetch),
		);
	}
	const items = rows
		.slice(0, parsed.limit)
		.flatMap((row) => hydrate(db, readText(row, "scope_key"), [row]));
	return { status: "ok", items, more: rows.length > parsed.limit, mode };
}

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
	let filterClause = "";
	if (kinds !== undefined) {
		filterClause = ` AND i.kind IN (${placeholders(kinds.length)})`;
		params.push(...kinds);
	}
	const itemIds = ownValue(parsed, "itemIds");
	if (itemIds !== undefined) {
		filterClause += ` AND i.item_id IN (${placeholders(itemIds.length)})`;
		params.push(...itemIds);
	}
	const after = ownValue(parsed, "after");
	let cursorClause = "";
	if (after !== undefined) {
		cursorClause =
			" AND (i.updated_seq < ? OR (i.updated_seq = ? AND i.item_id > ?))";
		params.push(after.updatedSeq, after.updatedSeq, after.itemId);
	}
	if (ownValue(parsed, "includeExcluded") !== true) {
		cursorClause += ` AND NOT ${excludedSql("i")}`;
	}
	if (ownValue(parsed, "suppressed") === "omit") {
		cursorClause += ` AND NOT ${suppressedSql("i")}`;
	}
	const minStrength = ownValue(parsed, "minStrength");
	if (minStrength !== undefined) {
		cursorClause += ` AND (i.origin IN ${USER_ORIGIN_SQL} OR i.strength >= ?)`;
		params.push(minStrength);
	}
	const pageSize = limit ?? LIMITS_STATE.maxListItems;
	params.push(pageSize + 1);
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${ITEM_COLUMNS} FROM memory_state_item i
				WHERE i.principal = ? AND i.scope_key = ?
					AND i.status IN (${placeholders(statuses.length)})${filterClause}${cursorClause}
					AND ${NO_TOMBSTONE}
				ORDER BY i.updated_seq DESC, i.item_id ASC
				LIMIT ?`,
			)
			.all(...params),
	);
	const items = hydrate(db, parsed.scopeKey, rows.slice(0, pageSize));
	const last = items.at(-1);
	return {
		status: "ok",
		items,
		...(rows.length > pageSize && last !== undefined
			? {
					nextCursor: { updatedSeq: last.updatedSeq, itemId: last.itemId },
				}
			: {}),
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

// ---- 忘却（lifecycle の閉包適用が呼ぶ。reducer を通さない）----

export function selectFirst(
	db: MemoryDb,
	sql: string,
	params: SqlValue[],
): unknown {
	const row = guarded(() => db.query(sql).get(...params));
	return row === undefined ? null : row;
}

export function selectAll(
	db: MemoryDb,
	sql: string,
	params: SqlValue[],
): unknown[] {
	return guarded(() => db.query(sql).all(...params));
}

export interface ScrubbedStateItem {
	/** 行が principal のものなら scope。行がない／他 principal の行なら null（何も書かない）。 */
	readonly scopeKey: string | null;
	/** 消す前の事実キー（抑制の印の後始末用）。初めて forgotten になるときだけ。 */
	readonly factKey: string | null;
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
		"SELECT principal, scope_key, status, subject, kind, semantic_key FROM memory_state_item WHERE item_id = ?",
		[itemId],
	);
	if (row === null || readText(row, "principal") !== principal) {
		return { scopeKey: null, factKey: null, transitioned: false };
	}
	const scopeKey = readText(row, "scope_key");
	const transitioned = readText(row, "status") !== "forgotten";
	const factKey = transitioned
		? stateFactKey(
				readText(row, "subject"),
				readText(row, "kind"),
				readText(row, "semantic_key"),
			)
		: null;
	run(db, "DELETE FROM memory_state_attribute WHERE item_id = ?", [itemId]);
	run(db, "DELETE FROM memory_state_evidence WHERE item_id = ?", [itemId]);
	run(
		db,
		`UPDATE memory_state_item SET status = 'forgotten', semantic_key = '', value_text = NULL,
			subject = CASE WHEN subject = 'self' THEN 'self' ELSE 'other:' END,
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
	return { scopeKey, factKey, transitioned };
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

/**
 * item の principal、scope、status（forget の target 検査と、忘却済み依存の拒否用）。
 * 行がなければ null。status の語彙はここでは絞らない。
 */
export function stateItemScope(
	db: MemoryDb,
	itemId: string,
): {
	readonly principal: string;
	readonly scopeKey: string;
	readonly status: string;
} | null {
	const row = selectFirst(
		db,
		"SELECT principal, scope_key, status FROM memory_state_item WHERE item_id = ?",
		[itemId],
	);
	return row === null
		? null
		: {
				principal: readText(row, "principal"),
				scopeKey: readText(row, "scope_key"),
				status: readText(row, "status"),
			};
}
