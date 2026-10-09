/**
 * Recall の永続 API（S2）。契約は `src/domains/recall/contracts/index.ts`。
 *
 * - 対象は active かつ墓標なし（`record` / `source` の両方）の record の current revision の本文だけ。
 * - 戦略: scope 内の件数が `LIKE_SCAN_MAX` 以下、または最短語が 3 文字未満 → `like`（scope index + LIKE）。
 *   それ以外 → `fts`（`rowid IN (SELECT rowid FROM memory_record_fts WHERE ... MATCH ?)` + scope 条件）。
 *   FTS が使えない環境（索引表が無い・fts5 が無い）では `like` に落ちる。結果集合・順序は戦略によらず同一。
 * - 順序は `(updated_seq DESC, record_id ASC)`、cursor は最後に返した位置（keyset）。bm25 は使わない。
 * - 一貫性（複数ページ）はホストの read transaction に依存する。
 */
import { LIMITS_RECALL } from "../contracts/index.ts";
import type {
	RecallHit,
	RecallStrategy,
	SearchRecordsInput,
	SearchRecordsResult,
} from "../contracts/index.ts";
import { MemoryContractError } from "../../../contracts/errors.ts";
import { ownValue } from "../../../contracts/own.ts";
import {
	decodeCursor,
	cursorBinding,
	encodeCursor,
} from "../service/cursor.ts";
import { findFirstMatch, makeSnippet } from "../service/match.ts";
import { parseSearchRecordsInput } from "../service/parse.ts";
import type { ParsedQuery } from "../service/query.ts";
import { chooseStrategy, FTS_MIN_TERM_CHARS } from "../service/strategy.ts";
import { recordSourceRef } from "../../records/index.ts";
import {
	guarded,
	readInteger,
	readRow,
	readText,
	translateSqliteError,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";
import { enterRead } from "../../../infrastructure/sqlite/session.ts";

/** 墓標の二重化（status に加えて `record` と `source` の両方の墓標が無いこと）。 */
const NOT_FORGOTTEN = `NOT EXISTS (
		SELECT 1 FROM memory_tombstone t
		WHERE t.target_type = 'record' AND t.target_id = r.record_id)
	AND NOT EXISTS (
		SELECT 1 FROM memory_tombstone s
		WHERE s.target_type = 'source'
			AND s.target_id = json_array('memory', 'record', r.record_id, 'text'))`;

function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function ftsPhrase(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
}

function isFtsFailure(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("memory_record_fts") ||
			error.message.includes("fts5"))
	);
}

interface CandidateRow {
	readonly recordId: string;
	readonly scopeKey: string;
	readonly updatedSeq: number;
	readonly revision: string;
	readonly digest: string;
	readonly content: string;
}

export interface SearchQueryArgs {
	readonly principal: string;
	readonly scopeKeys: readonly string[];
	readonly query: ParsedQuery;
	readonly strategy: RecallStrategy;
	readonly after: {
		readonly updatedSeq: number;
		readonly recordId: string;
	} | null;
	readonly fetch: number;
}

/** 検索の SQL と引数（`EXPLAIN QUERY PLAN` を取るテスト・bench 用に公開。`./sqlite` からは公開しない）。 */
export function buildSearchQuery(args: SearchQueryArgs): {
	readonly sql: string;
	readonly params: SqlValue[];
} {
	const scopePlaceholders = args.scopeKeys.map(() => "?").join(", ");
	const params: SqlValue[] = [args.principal, ...args.scopeKeys];
	let conditions = "";
	if (args.after !== null) {
		conditions +=
			" AND (r.updated_seq < ? OR (r.updated_seq = ? AND r.record_id > ?))";
		params.push(
			args.after.updatedSeq,
			args.after.updatedSeq,
			args.after.recordId,
		);
	}
	if (args.strategy === "like") {
		for (const term of args.query.folded) {
			conditions += " AND b.content LIKE ? ESCAPE '\\'";
			params.push(`%${escapeLike(term)}%`);
		}
	} else {
		conditions +=
			" AND v.body_rowid IN (SELECT rowid FROM memory_record_fts WHERE memory_record_fts MATCH ?)";
		params.push(args.query.folded.map(ftsPhrase).join(" "));
	}
	params.push(args.fetch);
	const sql = `SELECT r.record_id AS record_id, r.scope_key AS scope_key, r.updated_seq AS updated_seq,
					v.revision AS revision, v.digest AS digest, b.content AS content
				FROM memory_record r
				JOIN memory_record_revision v
					ON v.record_id = r.record_id AND v.revision = r.current_revision
				JOIN memory_record_body b ON b.rowid = v.body_rowid
				WHERE r.principal = ? AND r.scope_key IN (${scopePlaceholders}) AND r.status = 'active'
					AND ${NOT_FORGOTTEN}${conditions}
				ORDER BY r.updated_seq DESC, r.record_id ASC
				LIMIT ?`;
	return { sql, params };
}

function runStrategy(db: MemoryDb, args: SearchQueryArgs): CandidateRow[] {
	const { sql, params } = buildSearchQuery(args);
	// ここは guarded を使わない（FTS 表の欠落を呼び出し側が判別してフォールバックするため）。
	const rows = db.query(sql).all(...params);
	return rows.map((row) => {
		const record = readRow(row);
		return {
			recordId: readText(record, "record_id"),
			scopeKey: readText(record, "scope_key"),
			updatedSeq: readInteger(record, "updated_seq"),
			revision: readText(record, "revision"),
			digest: readText(record, "digest"),
			content: readText(record, "content"),
		};
	});
}

function countScopeRows(
	db: MemoryDb,
	principal: string,
	scopeKeys: readonly string[],
): number {
	const placeholders = scopeKeys.map(() => "?").join(", ");
	const row = guarded(() =>
		db
			.query(
				`SELECT COUNT(*) AS n FROM memory_record
				WHERE principal = ? AND scope_key IN (${placeholders}) AND status = 'active'`,
			)
			.get(principal, ...scopeKeys),
	);
	return readInteger(row, "n");
}

/**
 * 戦略を指定して検索する内部関数（テスト・bench 用。`./sqlite` からは公開しない）。
 * `forced` が `fts` でも、最短語が 3 文字未満なら `like` で検索する（trigram は検索できないため）。
 * 公開の `searchRecords` は `forced` なしで呼ぶ。
 */
export function searchRecordsWithStrategy(
	db: MemoryDb,
	rawInput: SearchRecordsInput,
	forced: RecallStrategy | undefined,
): SearchRecordsResult {
	const { input, query } = parseSearchRecordsInput(rawInput);
	enterRead(db);
	const permitted = new Set(input.access.scopeKeys);
	if (!input.scopeKeys.every((scopeKey) => permitted.has(scopeKey))) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = input.access.principal;
	const binding = cursorBinding(principal, input.scopeKeys, query.folded);
	let after: { updatedSeq: number; recordId: string } | null = null;
	const cursor = ownValue(input, "cursor");
	if (cursor !== undefined) {
		after = decodeCursor(cursor, binding);
		if (after === null)
			throw new MemoryContractError("INVALID_VALUE", "$.cursor");
	}
	let strategy: RecallStrategy;
	if (forced === undefined) {
		strategy = chooseStrategy({
			minTermChars: query.minTermChars,
			scopeRowCount: countScopeRows(db, principal, input.scopeKeys),
			ftsAvailable: true,
		});
	} else {
		strategy =
			forced === "fts" && query.minTermChars >= FTS_MIN_TERM_CHARS
				? "fts"
				: "like";
	}
	const fetch = input.limit + 1;
	const base = { principal, scopeKeys: input.scopeKeys, query, after, fetch };
	let rows: CandidateRow[];
	try {
		rows = runStrategy(db, { ...base, strategy });
	} catch (error) {
		// 索引表が無い・fts5 が無い環境では LIKE に落とす（結果は同一）。
		if (strategy !== "fts" || !isFtsFailure(error)) {
			throw translateSqliteError(error);
		}
		strategy = "like";
		rows = guarded(() => runStrategy(db, { ...base, strategy }));
	}
	const page = rows.slice(0, input.limit);
	const hits: RecallHit[] = page.map((row) => {
		const range = findFirstMatch(row.content, query.folded);
		if (range === null) throw new MemoryStoreError("CORRUPT_ROW");
		return {
			ref: recordSourceRef(row.recordId, row.revision, row.digest, range),
			scopeKey: row.scopeKey,
			snippet: makeSnippet(row.content, range, LIMITS_RECALL.maxSnippetBytes),
			authority: "evidence_candidate",
		};
	});
	const last = page[page.length - 1];
	if (rows.length > input.limit && last !== undefined) {
		return {
			status: "ok",
			hits,
			nextCursor: encodeCursor(
				{ updatedSeq: last.updatedSeq, recordId: last.recordId },
				binding,
			),
			strategy,
		};
	}
	return { status: "ok", hits, strategy };
}

/**
 * 読み取り。scope 限定で、全語を含む active な record を `(updated_seq DESC, record_id ASC)` で返す。
 * ヒットは根拠候補（`authority: "evidence_candidate"`）であり事実ではない。
 */
export function searchRecords(
	db: MemoryDb,
	input: SearchRecordsInput,
): SearchRecordsResult {
	return searchRecordsWithStrategy(db, input, undefined);
}
