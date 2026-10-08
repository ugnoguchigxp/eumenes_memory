/**
 * 検索戦略の選択（純粋）。設計書 §2.6: scope 内の件数が小さい間は scope index + LIKE、大きい場合は
 * FTS（trigram）。最短語が 3 文字未満なら trigram で検索できないので常に LIKE。
 * 結果順序は戦略によらず `(updated_seq DESC, record_id ASC)` で、結果集合は同一（property test で固定）。
 */
import type { RecallStrategy } from "../contracts/recall.ts";

/**
 * scope 内（検索対象の scope 合計）の active な record がこの件数以下なら LIKE。
 * 値は `spec/bench-scope-results.md`（`bench/bench-scope.ts`）の計測で確定した。
 */
export const LIKE_SCAN_MAX = 5000;

/** trigram が検索できる最短の語（コードポイント数）。 */
export const FTS_MIN_TERM_CHARS = 3;

export interface StrategyInput {
	readonly minTermChars: number;
	/** 検索対象 scope の active な record の件数。 */
	readonly scopeRowCount: number;
	/** FTS5 の表が使えるか。 */
	readonly ftsAvailable: boolean;
}

export function chooseStrategy(input: StrategyInput): RecallStrategy {
	if (!input.ftsAvailable) return "like";
	if (input.minTermChars < FTS_MIN_TERM_CHARS) return "like";
	return input.scopeRowCount <= LIKE_SCAN_MAX ? "like" : "fts";
}
