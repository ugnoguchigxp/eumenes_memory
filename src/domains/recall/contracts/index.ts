/**
 * Recall（Records のスコープ限定検索）の契約（full-system-design §3.3）。実装は S2（`src/domains/recall/repository/index.ts`）。
 *
 * 検索規則（S2 実装者はこの JSDoc を契約として扱う）:
 * - query は空白（U+0020, U+3000, \t, \n）で語に分け、全語を含む本文だけを返す（AND）。語は部分文字列一致。
 * - ASCII の大文字小文字は区別しない。それ以外の正規化（全角半角、NFKC）はしない。
 * - 結果順序は `(updated_seq DESC, record_id ASC)`。bm25 は使わない（戦略間で結果集合を同一にするため）。
 * - 対象は active かつ墓標なしの record の current revision のみ。
 * - ヒットの `ref.range` は最初の一致の UTF-8 byte 範囲、最短語が 3 文字未満なら `like`、それ以外は規模で選ぶ。
 */
import type { AccessContext, SourceRef } from "../../../contracts/types.ts";
import type { ContractVersion } from "../../../contracts/common.ts";

export const LIMITS_RECALL = Object.freeze({
	maxQueryBytes: 256,
	maxTerms: 8,
	minLimit: 1,
	maxLimit: 50,
	maxSnippetBytes: 256,
	maxCursorBytes: 512,
	/** M0 の LIMITS.maxScopeKeys と同じ。 */
	maxScopeKeys: 64,
});

export const RECALL_STRATEGIES = Object.freeze(["like", "fts"] as const);
export type RecallStrategy = (typeof RECALL_STRATEGIES)[number];

export const RECALL_BLOCKED_REASON_CODES = Object.freeze([
	"SCOPE_NOT_PERMITTED",
] as const);
export type RecallBlockedReasonCode =
	(typeof RECALL_BLOCKED_REASON_CODES)[number];

/** 検索ヒットは根拠候補であり事実ではない。`authority` は常に `evidence_candidate`。 */
export interface RecallHit {
	/** 出典（revision / digest 付き）。range は最初の一致箇所。 */
	readonly ref: SourceRef;
	/** どの scope のヒットか（`scopeKeys` を複数指定した場合の判別用）。 */
	readonly scopeKey: string;
	/** range の前後を文字境界で切った本文。≤ `LIMITS_RECALL.maxSnippetBytes`。 */
	readonly snippet: string;
	readonly authority: "evidence_candidate";
}

export interface SearchRecordsInput {
	readonly contractVersion: ContractVersion;
	readonly access: AccessContext;
	/** `access.scopeKeys` の部分集合でなければ `blocked`。重複は DUPLICATE_SCOPE_KEY。 */
	readonly scopeKeys: readonly string[];
	readonly query: string;
	readonly limit: number;
	/** 前回結果の `nextCursor`（不透明）。形式は S2 が決める。不正なら MemoryContractError(INVALID_VALUE)。 */
	readonly cursor?: string;
}

export type SearchRecordsResult =
	| {
			readonly status: "ok";
			readonly hits: readonly RecallHit[];
			readonly nextCursor?: string;
			readonly strategy: RecallStrategy;
	  }
	| {
			readonly status: "blocked";
			readonly reasonCode: RecallBlockedReasonCode;
	  };
