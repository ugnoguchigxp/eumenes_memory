/**
 * 抑制（話題に出さない）・強度（順位の重み）・時間軸の照会。契約は `src/domains/state/contracts/index.ts`。
 * 書き込みはホストの write transaction の中で 1 回呼ぶ（入口は `enterWrite`）。除外の印は Lifecycle が journal 経由で書く
 * （`memory_exclusion`）ので、ここは読み出しでだけ外す。
 */
import { ownValue } from "../../../contracts/own.ts";
import { appendMemoryChange } from "../../../infrastructure/sqlite/changes.ts";
import {
	guarded,
	readInteger,
	readNullableInteger,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import {
	excludedSql,
	stateFactKey,
	stateFactSql,
} from "../../../infrastructure/sqlite/marks.ts";
import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import { LIMITS_STATE, STATE_KINDS } from "../contracts/index.ts";
import type {
	DecayStateStrengthInput,
	ListStateByTimeInput,
	ListStateByTimeResult,
	ListSuppressionsInput,
	ListSuppressionsResult,
	ReinforceStateStrengthInput,
	StateMarkTarget,
	StateStrengthResult,
	SuppressStateInput,
	SuppressStateResult,
	TimedStateItem,
} from "../contracts/index.ts";
import {
	parseDecayStateStrengthInput,
	parseListStateByTimeInput,
	parseListSuppressionsInput,
	parseReinforceStateStrengthInput,
	parseSuppressStateInput,
} from "../service/parse-recall.ts";
import {
	ITEM_COLUMNS,
	NO_TOMBSTONE,
	hydrate,
	isPermitted,
	loadItem,
	placeholders,
	run,
	selectAll,
	selectFirst,
} from "./index.ts";

// ---- 抑制 ----

interface FactVersion {
	readonly itemId: string;
	readonly revision: number;
	readonly status: string;
}

function factVersions(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	key: string,
): FactVersion[] {
	return selectAll(
		db,
		`SELECT i.item_id, i.revision, i.status FROM memory_state_item i
		WHERE i.principal = ? AND i.scope_key = ? AND ${stateFactSql("i")} = ?
			AND i.status <> 'forgotten' AND ${NO_TOMBSTONE}
		ORDER BY i.created_seq ASC`,
		[principal, scopeKey, key],
	).map((row) => ({
		itemId: readText(row, "item_id"),
		revision: readInteger(row, "revision"),
		status: readText(row, "status"),
	}));
}

function setSuppression(
	db: MemoryDb,
	rawInput: SuppressStateInput,
	on: boolean,
): SuppressStateResult {
	const input = parseSuppressStateInput(rawInput);
	const seq = enterWrite(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = input.access.principal;
	const scopeKey = input.scopeKey;
	let targetType: "state_item" | "state_fact";
	let targetId: string;
	let versions: FactVersion[];
	if (input.target.type === "state_item") {
		const loaded = loadItem(db, principal, scopeKey, input.target.itemId);
		if (loaded.status !== "found") return { status: loaded.status };
		targetType = "state_item";
		targetId = input.target.itemId;
		versions = [
			{
				itemId: targetId,
				revision: loaded.row.view.revision,
				status: loaded.row.view.status,
			},
		];
	} else {
		targetType = "state_fact";
		targetId = stateFactKey(
			input.target.subject,
			input.target.kind,
			input.target.semanticKey,
		);
		versions = factVersions(db, principal, scopeKey, targetId);
		if (versions.length === 0) return { status: "missing" };
	}
	const present =
		selectFirst(
			db,
			`SELECT 1 AS found FROM memory_suppression
			WHERE principal = ? AND scope_key = ? AND target_type = ? AND target_id = ?`,
			[principal, scopeKey, targetType, targetId],
		) !== null;
	if (present === on) return { status: "unchanged" };
	if (on) {
		run(
			db,
			`INSERT INTO memory_suppression (principal, scope_key, target_type, target_id, seq, at_ms)
			VALUES (?, ?, ?, ?, ?, ?)`,
			[principal, scopeKey, targetType, targetId, seq, input.clock.atMs],
		);
	} else {
		run(
			db,
			`DELETE FROM memory_suppression
			WHERE principal = ? AND scope_key = ? AND target_type = ? AND target_id = ?`,
			[principal, scopeKey, targetType, targetId],
		);
	}
	const sourceRunId = ownValue(input, "sourceRunId");
	for (const version of versions) {
		appendMemoryChange(db, {
			principal,
			scopeKey,
			atMs: input.clock.atMs,
			targetType: "state_item",
			targetId: version.itemId,
			revision: String(version.revision),
			status: version.status as "active",
			forgetId: null,
			changeKind: on ? "suppressed" : "suppression_released",
			...(sourceRunId === undefined ? {} : { sourceRunId }),
		});
	}
	return { status: "applied" };
}

/**
 * 抑制を付ける（「その話はもう出さないで」）。記録は残る。`listState` は `suppressed: "omit"` で外し、`searchState` は
 * `suppressed: true` を付けて返す。対象が事実（`state_fact`）なら全版と以後の新しい版に効く。変更フィードに `suppressed` の行が出る。
 */
export function suppressState(
	db: MemoryDb,
	input: SuppressStateInput,
): SuppressStateResult {
	return setSuppression(db, input, true);
}

/** 抑制を解く。 */
export function releaseStateSuppression(
	db: MemoryDb,
	input: SuppressStateInput,
): SuppressStateResult {
	return setSuppression(db, input, false);
}

/** scope で抑制されている対象の一覧（item の ID、または事実）。 */
export function listSuppressions(
	db: MemoryDb,
	rawInput: ListSuppressionsInput,
): ListSuppressionsResult {
	const input = parseListSuppressionsInput(rawInput);
	enterRead(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const rows = selectAll(
		db,
		`SELECT target_type, target_id FROM memory_suppression
		WHERE principal = ? AND scope_key = ? ORDER BY seq ASC, target_id ASC`,
		[input.access.principal, input.scopeKey],
	);
	const targets: StateMarkTarget[] = [];
	for (const row of rows) {
		const targetId = readText(row, "target_id");
		if (readText(row, "target_type") === "state_item") {
			targets.push({ type: "state_item", itemId: targetId });
			continue;
		}
		const [subject, kind, semanticKey] = targetId.split("\u001f");
		const found = STATE_KINDS.find((candidate) => candidate === kind);
		if (
			subject === undefined ||
			found === undefined ||
			semanticKey === undefined ||
			!(subject === "self" || subject.startsWith("other:"))
		) {
			continue;
		}
		targets.push({
			type: "state_fact",
			subject: subject as "self",
			kind: found,
			semanticKey,
		});
	}
	return { status: "ok", targets };
}

/** 忘却で消えた item の印を消す（忘却の閉包の適用が呼ぶ）。事実の全版が無くなったら事実への抑制も消す。 */
export function clearStateMarks(
	db: MemoryDb,
	principal: string,
	items: readonly {
		readonly itemId: string;
		readonly scopeKey: string | null;
		readonly factKey: string | null;
	}[],
): void {
	const facts = new Map<string, { scopeKey: string; factKey: string }>();
	for (const item of items) {
		run(
			db,
			`DELETE FROM memory_exclusion WHERE principal = ? AND target_type = 'state_item' AND target_id = ?`,
			[principal, item.itemId],
		);
		run(
			db,
			`DELETE FROM memory_suppression WHERE principal = ? AND target_type = 'state_item' AND target_id = ?`,
			[principal, item.itemId],
		);
		if (item.scopeKey !== null && item.factKey !== null) {
			facts.set(`${item.scopeKey}\u0000${item.factKey}`, {
				scopeKey: item.scopeKey,
				factKey: item.factKey,
			});
		}
	}
	for (const { scopeKey, factKey } of facts.values()) {
		if (factVersions(db, principal, scopeKey, factKey).length === 0) {
			run(
				db,
				`DELETE FROM memory_suppression
				WHERE principal = ? AND scope_key = ? AND target_type = 'state_fact' AND target_id = ?`,
				[principal, scopeKey, factKey],
			);
		}
	}
}

// ---- 強度 ----

/**
 * 減衰: scope の active な item の強度に `factor` を掛ける（`floor` を下回らない）。順位の重みだけを変え、item の値・
 * status・revision・変更フィードは変えない。冪等ではない（呼ぶたびに掛ける）。呼ぶ頻度はホストが決める。
 */
export function decayStateStrength(
	db: MemoryDb,
	rawInput: DecayStateStrengthInput,
): StateStrengthResult {
	const input = parseDecayStateStrengthInput(rawInput);
	enterWrite(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const floor = ownValue(input, "floor") ?? 0;
	const rows = guarded(() =>
		db
			.query(
				`UPDATE memory_state_item
				SET strength = MAX(strength * ?, ?)
				WHERE principal = ? AND scope_key = ? AND status = 'active' AND strength > ?
				RETURNING item_id`,
			)
			.all(input.factor, floor, input.access.principal, input.scopeKey, floor),
	);
	return { status: "ok", updated: rows.length };
}

/** 強化: 使われた item の強度を `amount` だけ上げる（上限 1）。 */
export function reinforceStateStrength(
	db: MemoryDb,
	rawInput: ReinforceStateStrengthInput,
): StateStrengthResult {
	const input = parseReinforceStateStrengthInput(rawInput);
	enterWrite(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const params: SqlValue[] = [
		input.amount,
		input.access.principal,
		input.scopeKey,
		...input.itemIds,
	];
	const rows = guarded(() =>
		db
			.query(
				`UPDATE memory_state_item AS i
				SET strength = MIN(1.0, strength + ?)
				WHERE i.principal = ? AND i.scope_key = ? AND i.status <> 'forgotten'
					AND i.strength < 1.0 AND i.item_id IN (${placeholders(input.itemIds.length)})
					AND ${NO_TOMBSTONE}
				RETURNING item_id`,
			)
			.all(...params),
	);
	return { status: "ok", updated: rows.length };
}

// ---- 時間軸の照会 ----

/**
 * 二重の時間軸の照会（契約は `ListStateByTimeInput`）。記録した時点・失効させた時点は、State の版の履歴
 * （`memory_state_event`）に残る書き込み時の時計から導く。除外された item は返さない。
 */
export function listStateByTime(
	db: MemoryDb,
	rawInput: ListStateByTimeInput,
): ListStateByTimeResult {
	const input = parseListStateByTimeInput(rawInput);
	enterRead(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const recorded = `COALESCE((SELECT MIN(e.at_ms) FROM memory_state_event e
		WHERE e.item_id = i.item_id AND e.action = 'assert'), 0)`;
	const superseded = `(CASE WHEN i.status IN ('superseded', 'retracted', 'invalidated')
		THEN (SELECT MAX(e.at_ms) FROM memory_state_event e
			WHERE e.item_id = i.item_id AND e.action IN ('supersede', 'retract', 'invalidate'))
		END)`;
	const params: SqlValue[] = [input.access.principal, input.scopeKey];
	let filter = `i.principal = ? AND i.scope_key = ? AND i.status <> 'forgotten'
		AND ${NO_TOMBSTONE} AND NOT ${excludedSql("i")}`;
	const kinds = ownValue(input, "kinds");
	if (kinds !== undefined) {
		filter += ` AND i.kind IN (${placeholders(kinds.length)})`;
		params.push(...kinds);
	}
	if (ownValue(input, "current") === true) filter += " AND i.status = 'active'";
	const recordedAt = ownValue(input, "recordedAt");
	if (recordedAt !== undefined) {
		filter += ` AND ${recorded} <= ? AND (${superseded} IS NULL OR ${superseded} > ?)`;
		params.push(recordedAt, recordedAt);
	}
	const validAt = ownValue(input, "validAt");
	if (validAt !== undefined) {
		filter += ` AND (i.valid_from_ms IS NULL OR i.valid_from_ms <= ?)
			AND (i.valid_until_ms IS NULL OR ? < i.valid_until_ms)`;
		params.push(validAt, validAt);
	}
	const after = ownValue(input, "after");
	if (after !== undefined) {
		filter +=
			" AND (i.created_seq > ? OR (i.created_seq = ? AND i.item_id > ?))";
		params.push(after.createdSeq, after.createdSeq, after.itemId);
	}
	const pageSize = ownValue(input, "limit") ?? LIMITS_STATE.maxListItems;
	params.push(pageSize + 1);
	const rows = guarded(() =>
		db
			.query(
				`SELECT ${ITEM_COLUMNS}, ${recorded} AS recorded_at, ${superseded} AS superseded_at
				FROM memory_state_item i
				WHERE ${filter}
				ORDER BY i.created_seq ASC, i.item_id ASC
				LIMIT ?`,
			)
			.all(...params),
	);
	const page = rows.slice(0, pageSize);
	const hydrated = hydrate(db, input.scopeKey, page);
	const items: TimedStateItem[] = hydrated.map((item, index) => ({
		...item,
		recordedAtMs: readInteger(page[index], "recorded_at"),
		supersededAtMs: readNullableInteger(page[index], "superseded_at"),
	}));
	const last = items.at(-1);
	return {
		status: "ok",
		items,
		...(rows.length > pageSize && last !== undefined
			? { nextCursor: { createdSeq: last.createdSeq, itemId: last.itemId } }
			: {}),
	};
}
