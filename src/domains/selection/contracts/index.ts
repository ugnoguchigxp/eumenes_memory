/**
 * 今必要な記憶の選択（evolution-proposal「今必要な記憶の選択」「公開Snapshotと回答採用」）。
 * View v1 / v2 は変えず、選択の入出力を別契約として足す。すべて純粋: 時計・DB・モデルを使わず、
 * 認可済みの参照集合・時刻・検索結果はホストが渡す。
 *
 * - 必須集合: 現在の依頼、適用される禁止・制約、進行中の目的・決定・未解決事項、必要な直近会話、未完了Toolの対応関係。
 *   単純な関連度順位に任せず、適用条件（scope・期間・今回/今後）だけで決める。入らなければ黙って落とさず、
 *   `required_overflow`（split / replan / hold）または `hold`（解決できない矛盾）を返す。
 * - 追加集合: 関連する好み・背景・過去の出来事等。順位付けして予算に入る分だけ採り、省略理由を残す。
 * - 認可と選択は別: 認可された scope の外の候補は順位付けせず `SCOPE_NOT_AUTHORIZED` として除外し、数える。
 * - 検索結果の無さは「存在しない」の根拠にしない（`RetrievalFlag`）。
 */
import type {
	TimeQuery,
	ValidityPeriod,
} from "../../temporal/contracts/index.ts";

export const SCOPE_KINDS = Object.freeze([
	"user_common",
	"project",
	"task",
	"topic",
	"request",
] as const);
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** 「今回は短く」(this_request) と「今後は短く」(ongoing)。範囲不明の発言は共通Profileに昇格させない。 */
export type Duration = "this_request" | "ongoing";

export const REQUIRED_REASONS = Object.freeze([
	"current_request",
	"prohibition",
	"constraint",
	"goal",
	"decision",
	"open_question",
	"recent_turn",
	"tool_pairing",
] as const);
export type RequiredReason = (typeof REQUIRED_REASONS)[number];

/**
 * ホストが認可した参照scopeと、認可の版。`revision` は認可（誰がどの scope を参照してよいか）の版で、scope の内容の版
 * （書き込みのたびに進む）ではない。内容の変化は利用した item ごとの版と必須集合の digest で見る。
 */
export interface ScopeGrant {
	readonly scopeKey: string;
	readonly kind: ScopeKind;
	readonly revision: string;
}

/** 今回の依頼が解決するscope。共通Profileは常に適用、他は一致したものだけ。 */
export interface ActiveContext {
	readonly requestId: string;
	readonly projectScopeKey?: string;
	readonly taskScopeKey?: string;
	readonly topicScopeKey?: string;
}

export interface SelectionSignals {
	/** 依頼が明示的にIDで参照した。 */
	readonly explicitRef: boolean;
	/** 語句一致の数（ホストが Recall 等から計算）。 */
	readonly termMatches: number;
	/** 対象（人物・対象ID）が一致した。 */
	readonly subjectMatch: boolean;
}

export interface SelectionCandidate {
	readonly id: string;
	readonly revision: string;
	readonly scopeKey: string;
	readonly text: string;
	/** 設定すれば必須集合の候補。省略は追加集合。 */
	readonly requiredReason?: RequiredReason;
	readonly duration: Duration;
	/** `this_request` のとき、どの依頼に属するか。現在の依頼と一致しなければ適用しない。 */
	readonly requestId?: string;
	/** 同じ keyで値が異なる必須制約は矛盾。 */
	readonly conflictKey?: string;
	/** conflictKey が同じで内容が同じなら重複として1つに畳む。 */
	readonly valueKey?: string;
	/** 今回の依頼で本人が述べた指示（今回限り・今後のどちらでも）。矛盾では保存済みの制約より優先する。 */
	readonly explicit?: boolean;
	/** 明示された例外（より一般の制約より優先）。 */
	readonly exception?: boolean;
	readonly recordedAtMs: number;
	readonly period?: ValidityPeriod;
	readonly signals: SelectionSignals;
	/** 出典が古い／失効世代が変わった等。結果の `evidence_stale` に反映する。 */
	readonly stale?: boolean;
}

export interface RetrievalReport {
	/** 実際に検索したscope。 */
	readonly searchedScopeKeys: readonly string[];
	/** 検索が件数・時間・tokenの上限で打ち切られた。 */
	readonly truncated: boolean;
	/** 未処理の原文境界（処理済み位置と先頭位置）。 */
	readonly processedSeq: number;
	readonly headSeq: number;
	/** 関連する訂正のうち未処理の件数。 */
	readonly pendingCorrections: number;
}

export interface SelectionInput {
	readonly principal: string;
	readonly grants: readonly ScopeGrant[];
	readonly context: ActiveContext;
	readonly query: TimeQuery;
	readonly candidates: readonly SelectionCandidate[];
	/** 必須＋追加の合計予算（UTF-8 byte）。 */
	readonly maxBytes: number;
	/** 追加集合の件数上限。 */
	readonly maxOptionalItems: number;
	readonly policyRevision: string;
	/** 選択規則の版。変えると既存の利用根拠は失効する。 */
	readonly selectionPolicyRevision: string;
	readonly retrieval: RetrievalReport;
}

export const OMIT_REASONS = Object.freeze([
	"SCOPE_NOT_AUTHORIZED",
	"SCOPE_NOT_ACTIVE",
	"NOT_THIS_REQUEST",
	"NOT_CURRENT",
	"NOT_KNOWN_AT_TARGET",
	/** 期間の記述が不正（暦として成立しない・逆転）。追加集合では除外、必須集合では解決不能として hold。 */
	"INVALID_PERIOD",
	"SUPERSEDED_BY_CONFLICT",
	"DUPLICATE",
	"BUDGET",
	"ITEM_LIMIT",
] as const);
export type OmitReason = (typeof OMIT_REASONS)[number];

export interface OmittedItem {
	readonly id: string;
	readonly reason: OmitReason;
}

export interface UnresolvedConflict {
	readonly conflictKey: string;
	readonly ids: readonly string[];
}

export const RETRIEVAL_FLAGS = Object.freeze([
	"not_found_in_searched_scopes",
	"search_truncated",
	"evidence_stale",
	"correction_pending",
	"raw_unprocessed",
] as const);
export type RetrievalFlag = (typeof RETRIEVAL_FLAGS)[number];

export interface SelectedItem {
	readonly id: string;
	readonly revision: string;
	readonly scopeKey: string;
	readonly bytes: number;
	readonly requiredReason?: RequiredReason;
}

/** 回答採用時に再検証する、利用した根拠。 */
export interface UsageBasis {
	readonly principal: string;
	readonly policyRevision: string;
	readonly selectionPolicyRevision: string;
	/** 利用したitemが属するscopeの認可と版。 */
	readonly grants: readonly ScopeGrant[];
	readonly items: readonly {
		readonly id: string;
		readonly revision: string;
		/** 現在の照会で使った期間の終わり（含まない）。null は期限なし。 */
		readonly expiresAtMs: number | null;
	}[];
	/** 必須集合のID・版から作る決定的digest。 */
	readonly requiredDigest: string;
	/** 選択時に処理済みだった原文位置。 */
	readonly processedSeq: number;
}

export interface SelectionCoverage {
	readonly searchedScopeKeys: readonly string[];
	readonly selectedCount: number;
	readonly omitted: readonly OmittedItem[];
	readonly unresolved: readonly UnresolvedConflict[];
	readonly flags: readonly RetrievalFlag[];
	/** 認可外のscopeから渡された候補の数（ホストの取得不具合の検知用）。 */
	readonly unauthorizedCandidates: number;
}

export type SelectionResult =
	| {
			readonly status: "ready";
			readonly required: readonly SelectedItem[];
			readonly optional: readonly SelectedItem[];
			readonly usedBytes: number;
			readonly coverage: SelectionCoverage;
			readonly usage: UsageBasis;
	  }
	| {
			/** 必須集合が予算に入らない。回答に使えない。 */
			readonly status: "required_overflow";
			readonly action: "split" | "replan" | "hold";
			readonly requiredBytes: number;
			readonly coverage: SelectionCoverage;
	  }
	| {
			/** 解決できない必須制約の矛盾がある。回答に使えない。 */
			readonly status: "hold";
			readonly coverage: SelectionCoverage;
	  };

// ---- 利用根拠の再検証 ----

export interface CurrentBasis {
	readonly principal: string;
	readonly policyRevision: string;
	readonly selectionPolicyRevision: string;
	readonly grants: readonly ScopeGrant[];
	/** 利用したitemの現在の版。存在しない（消えた）itemは含めない。 */
	readonly itemRevisions: Readonly<Record<string, string>>;
	/** 同じ選択入力で必須集合を再計算したdigest（`requiredDigestOf`）。 */
	readonly requiredDigest: string;
	/** 現在時刻（ホスト時計）。選択時に使った項目の期限が過ぎていれば失効にする。省略は検査しない。 */
	readonly nowMs?: number;
	/** 現在の処理済み原文位置。選択時より小さければ DB が巻き戻っている（古い DB の復元など）。省略は検査しない。 */
	readonly processedSeq?: number;
	/** 選択後に新しく届いた訂正の影響scope。関係が不明なら `"*"`。 */
	readonly correctedScopeKeys: readonly string[];
}

export const REVALIDATION_REASONS = Object.freeze([
	"PRINCIPAL_CHANGED",
	"POLICY_CHANGED",
	"SELECTION_POLICY_CHANGED",
	"SCOPE_GRANT_CHANGED",
	"ITEM_CHANGED",
	"REQUIRED_SET_CHANGED",
	"CORRECTION_PENDING",
	"BOUNDARY_REGRESSED",
	"ITEM_EXPIRED",
] as const);
export type RevalidationReason = (typeof REVALIDATION_REASONS)[number];

export type RevalidationResult =
	| { readonly status: "valid" }
	| {
			readonly status: "invalid";
			readonly reasons: readonly RevalidationReason[];
	  };

// ---- 公開版（Profile / Project / Topic） ----

export type LedgerChangeKind =
	| "add"
	| "update"
	| "negate"
	| "retract"
	| "forget"
	| "auth_change";

export interface LedgerChange {
	readonly itemId: string;
	readonly revision: string;
	readonly kind: LedgerChangeKind;
	readonly seq: number;
}

export interface PublicVersion {
	readonly versionId: string;
	/** 公開した根拠manifest（item ID と版）。 */
	readonly manifest: readonly {
		readonly itemId: string;
		readonly revision: string;
	}[];
	readonly policyRevision: string;
	readonly publishedSeq: number;
}

export interface PublicationInput {
	readonly current: PublicVersion | null;
	readonly changes: readonly LedgerChange[];
	readonly policyRevision: string;
	/** 追加を待たせる数。これ以上たまったら公開する。 */
	readonly additionThreshold: number;
	/** 公開区切り（Topic切替・セッション境界等）。ホストが指定。 */
	readonly boundary: boolean;
}

export type PublicationDecision =
	| { readonly action: "keep"; readonly pendingAdditions: number }
	| {
			readonly action: "publish";
			readonly immediate: boolean;
			readonly reasons: readonly (
				| "NO_VERSION"
				| "POLICY_CHANGED"
				| "CORRECTION"
				| "FORGET"
				| "AUTH_CHANGE"
				| "ADDITION_THRESHOLD"
				| "BOUNDARY"
			)[];
	  };

// ---- Checkpoint ----

export interface CheckpointRange {
	readonly sourceId: string;
	readonly startSeq: number;
	readonly endSeq: number;
}

export interface Checkpoint {
	readonly topicId: string;
	readonly unresolved: readonly string[];
	readonly decisions: readonly string[];
	readonly refs: readonly string[];
	/** 処理境界。ここまでの原文を反映した。 */
	readonly processedSeq: number;
	/** `deterministic` は台帳から決定的に作った状態、`model_summary` はモデルの要約。 */
	readonly origin: "deterministic" | "model_summary";
	/** model_summary は原典範囲を必須とする。 */
	readonly ranges: readonly CheckpointRange[];
}
