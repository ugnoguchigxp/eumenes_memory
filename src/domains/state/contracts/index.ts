/**
 * State 台帳の契約。純粋 reducer は `src/domains/state/service/`、永続は `src/domains/state/repository/index.ts`。
 *
 * 規則（この JSDoc を契約として扱う）:
 * - itemId = `"state:" + sha256Hex(canonicalJson([principal, scopeKey, createdSeq]))`。
 *   同じ (subject, kind, semanticKey) の `active` は 1 件。置き換えは別 item（旧は `superseded`）。
 * - `revision` は item ごとの 1 始まりの整数。変更のたびに +1。
 * - `kind === "other_person_note"` ⇔ `subject` が `other:*`。不一致は `SUBJECT_KIND_MISMATCH`。
 *   `unknown` subject は台帳に載らない。
 * - 書き込みはホストの明示操作（`user_confirmed` / `user_edited` / `agent_inferred`）だけで、根拠の新旧比較を受けず、
 *   CAS（expectedRevision / replaces）だけで決まる。
 * - `agent_inferred`（ホストのエージェントが依頼なしに推定した内容）はユーザー由来ではない。ユーザー由来の保護は受けない。
 *   ユーザー本人が止めた（retract / deactivate）ものとして残る保護は、origin ではなく停止操作そのものに効く。
 * - 根拠の quote は state 側に本文を残さない（SourceRef + range だけ。本文は出典を読む）。
 * - 同値の明示確認は origin を昇格する: active が `agent_inferred`（または既存 DB の行に残る抽出由来の `admitted_extraction`）で、
 *   `assertUserState` が同じ値を `user_confirmed` / `user_edited` で書いたとき、値は変えず origin だけを user 由来へ上げる
 *   （revision を +1、event は `edit`、結果は `applied`）。逆（user 由来 → 推定由来）の降格はしない。
 * - 期限（`validFromMs` / `validUntilMs`）は保存するだけで、本体は評価しない。評価はホストか `classifyValidity`。
 * - 永続した語彙（`disputed` / `invalidated` の status、`admitted_extraction` の origin、`dispute` / `invalidate` の event、
 *   `candidate` の cause）は、DB の CHECK 制約と既存の行を表す。API はこれらを書かない（読み取りだけ）。
 * - 本体は `forget` を reducer に通さない（lifecycle が閉包で value を消し status を `forgotten` にする）。
 */
import type {
	AccessContext,
	SourceRef,
	SourceState,
} from "../../../contracts/types.ts";
import type {
	EvidenceSpan,
	MissingStatus,
	Polarity,
	ScopedRead,
	ScopedWrite,
	StateSubject,
	StoreAccessReasonCode,
} from "../../../contracts/common.ts";
import type { ValidityPeriod } from "../../temporal/contracts/index.ts";

export const LIMITS_STATE = Object.freeze({
	maxSemanticKeyBytes: 128,
	maxSubjectBytes: 128,
	maxValueTextBytes: 4096,
	maxAttributes: 16,
	maxAttributeKeyBytes: 64,
	maxAttributeValueBytes: 256,
	maxEvidencePerItem: 8,
	maxQuoteBytes: 1024,
	/** 1 回の呼び出しで渡せる出典（本文つき）の件数。 */
	maxSources: 64,
	maxListItems: 1000,
});

export const STATE_KINDS = Object.freeze([
	"preference",
	"personal_fact",
	"constraint",
	"habit",
	"other_person_note",
] as const);
export type StateKind = (typeof STATE_KINDS)[number];

export const STATE_ITEM_STATUSES = Object.freeze([
	"active",
	"inactive",
	"superseded",
	"disputed",
	"retracted",
	"invalidated",
	"forgotten",
] as const);
export type StateItemStatus = (typeof STATE_ITEM_STATUSES)[number];

/**
 * ユーザー本人の明示操作で付く origin。「確認済み項目の保護」（抽出由来に黙って上書きされない）と
 * 「ユーザーが消したものの保護」は、この origin の item にだけ効く。
 */
export const USER_STATE_ORIGINS = Object.freeze([
	"user_confirmed",
	"user_edited",
] as const);

/**
 * `assertUserState` が受け付ける origin。ユーザー本人の明示操作に加え、ホストのエージェントが
 * ユーザーの依頼なしに推定した内容を書くための `agent_inferred` を持つ。
 * `agent_inferred` の item は、新旧比較を受けない明示書き込み（CAS だけ）で書かれるが、ユーザー由来の保護は受けない:
 * 同値の `user_confirmed` / `user_edited` は値を変えずに origin を昇格し、
 * 値が違う `user_confirmed` / `user_edited` は `replaces` で置き換える。
 * 逆向き（user 由来 → `agent_inferred`）の降格は、同値のときは行わない（値が違う書き込みは、その値を書いた者を origin に残す）。
 */
export const HOST_STATE_ORIGINS = Object.freeze([
	...USER_STATE_ORIGINS,
	"agent_inferred",
] as const);
export type HostStateOrigin = (typeof HOST_STATE_ORIGINS)[number];

export const STATE_ORIGINS = Object.freeze([
	...USER_STATE_ORIGINS,
	"admitted_extraction",
	"agent_inferred",
] as const);
export type StateOrigin = (typeof STATE_ORIGINS)[number];

export const STATE_EVENT_ACTIONS = Object.freeze([
	"assert",
	"activate",
	"edit",
	"supersede",
	"dispute",
	"retract",
	"deactivate",
	"reactivate",
	"invalidate",
	"forget",
] as const);
export type StateEventAction = (typeof STATE_EVENT_ACTIONS)[number];
/** reducer が扱う遷移。`forget` は lifecycle の閉包適用が行うので含めない。同値の確認による origin の昇格は event `edit` として残る。 */
export type StateTransitionAction = Extract<
	StateEventAction,
	"assert" | "supersede" | "activate" | "deactivate" | "reactivate" | "retract"
>;

export const STATE_CAUSE_TYPES = Object.freeze([
	"user",
	"candidate",
	"lifecycle",
] as const);
export type StateCauseType = (typeof STATE_CAUSE_TYPES)[number];

/** State 書き込みの rejected 理由（reducer + 根拠検査）。 */
export const STATE_REASON_CODES = Object.freeze([
	"STALE_REVISION",
	"ACTIVE_EXISTS",
	"INVALID_TRANSITION",
	"SUBJECT_KIND_MISMATCH",
	"REPLACES_MISMATCH",
	"QUOTE_MISMATCH",
	"EVIDENCE_NOT_IN_INPUT",
	"SOURCE_STALE",
	"SOURCE_TOMBSTONED",
	/** `change: "consolidation"` で、本人由来（`user_confirmed` / `user_edited`）の item の本文を書き換えようとした。 */
	"USER_TEXT_PROTECTED",
] as const);
export type StateReasonCode = (typeof STATE_REASON_CODES)[number];

// ---- 値・item ----

export interface StateValue {
	readonly text: string;
	readonly polarity: Polarity;
	readonly attributes?: Readonly<Record<string, string>>;
}

/** ホストが同一 transaction で読んだ出典（本文つき）。evidence の quote 検査に使う。 */
export interface HostSourceState extends SourceState {
	readonly content: string;
	/**
	 * 出典の時系列順位（同一 scope の全出典で比較可能な非負整数。会話 message の通し番号など）。
	 * Records の出典もホストが付与する。item の `evidenceOrdinal` として保存するだけで、本体は新旧の判定に使わない。
	 */
	readonly ordinal: number;
}

export interface StateItem {
	readonly itemId: string;
	readonly scopeKey: string;
	readonly subject: StateSubject;
	readonly kind: StateKind;
	readonly semanticKey: string;
	readonly status: StateItemStatus;
	readonly revision: number;
	readonly value: StateValue;
	readonly origin: StateOrigin;
	/** range つきの根拠（quote 本文は持たない）。 */
	readonly evidence: readonly SourceRef[];
	readonly evidenceOrdinal: number;
	readonly validFromMs: number | null;
	readonly validUntilMs: number | null;
	/** 精度つきで保存した成立期間（保存していなければ省略）。 */
	readonly validity?: ValidityPeriod;
	readonly createdSeq: number;
	readonly updatedSeq: number;
	/** 検索の順位の重み（0〜1）。1 のときは省略する。 */
	readonly strength?: number;
	/** 抑制（話題に出さない）されているとき `true`。されていなければ省略する。 */
	readonly suppressed?: true;
	/** 除外されているとき `true`。`includeExcluded` で読んだ場合だけ現れる（既定の照会は除外された item を返さない）。 */
	readonly excluded?: true;
}

export interface StateCause {
	readonly type: StateCauseType;
	readonly id: string;
}

// ---- reducer（純粋、S3 が `src/domains/state/service/reducer.ts` に実装）----

/** reducer が見る item の現在像（`StateItem` から evidence と seq を除いたもの）。 */
export interface StateItemView {
	readonly itemId: string;
	readonly subject: StateSubject;
	readonly kind: StateKind;
	readonly semanticKey: string;
	readonly status: StateItemStatus;
	readonly revision: number;
	readonly value: StateValue;
	readonly origin: StateOrigin;
	readonly evidenceOrdinal: number;
}

export interface StateTransition {
	readonly action: StateTransitionAction;
	/** 既存 item への遷移は現在 revision。新規 `assert` は null。不一致は `STALE_REVISION`。 */
	readonly expectedRevision: number | null;
	readonly value?: StateValue;
	readonly origin?: StateOrigin;
	readonly evidenceOrdinal?: number;
	readonly cause: StateCause;
}

export interface StateTransitionContext {
	readonly atMs: number;
	/** 同 (subject, kind, semanticKey) の現在の `active` item（なければ null）。supersede 判定用。 */
	readonly activeForKey: StateItemView | null;
}

export interface StateEventDraft {
	readonly itemId: string;
	readonly action: StateEventAction;
	readonly fromRevision: number | null;
	readonly toRevision: number | null;
	readonly cause: StateCause;
	readonly atMs: number;
}

export type StateTransitionResult =
	| {
			readonly ok: true;
			/** 状態が変わった item の変更後の像（supersede / dispute は 2 件になりうる）。 */
			readonly items: readonly StateItemView[];
			readonly events: readonly StateEventDraft[];
	  }
	| { readonly ok: false; readonly reasonCode: StateReasonCode };

// ---- 永続 API（`./sqlite`）----

export interface AssertUserStateInput extends ScopedWrite {
	readonly kind: StateKind;
	readonly subject: StateSubject;
	readonly semanticKey: string;
	readonly value: StateValue;
	/** 1 件以上 `LIMITS_STATE.maxEvidencePerItem` 件以下。各 source は `sources` に含まれること。 */
	readonly evidence: readonly EvidenceSpan[];
	readonly sources: readonly HostSourceState[];
	readonly origin: HostStateOrigin;
	/** 保存するだけで本体は評価しない（期限の評価はホスト）。 */
	readonly validFromMs?: number;
	/** 保存するだけで本体は評価しない（期限の評価はホスト）。 */
	readonly validUntilMs?: number;
	/**
	 * 精度つきの成立期間（`validFromMs` / `validUntilMs` とは併用しない）。日が不明な「9月から」は月の精度で保存し、
	 * 境界（ms）は UTC の暦から導く。評価は `temporal` の純粋関数。
	 */
	readonly validity?: ValidityPeriod;
	/** 既存 active を置き換える場合は必須。無いのに active が存在すれば `ACTIVE_EXISTS`。 */
	readonly replaces?: { readonly itemId: string; readonly revision: number };
	/**
	 * この変更を起こした run の ID。変更フィードの行に残る。省略した変更は run 不明。挙動は省略時と変わらない。
	 */
	readonly sourceRunId?: string;
	/**
	 * `replaces` で置き換えるときの種類。`correction`（既定）は値の訂正、`consolidation` は意味の変わらない版の更新
	 * （統合など）。変更フィードの旧版の行の `changeKind` に出る。`consolidation` は `replaces` が要り、置き換え対象が
	 * 本人由来（`user_confirmed` / `user_edited`）で値が変わるなら `USER_TEXT_PROTECTED` で拒否する。
	 */
	readonly change?: StateChangeKind;
}

/** `replaces` による置き換えの種類（変更フィードの `changeKind` と対応）。 */
export const STATE_CHANGE_KINDS = Object.freeze([
	"correction",
	"consolidation",
] as const);
export type StateChangeKind = (typeof STATE_CHANGE_KINDS)[number];

/** deactivate / reactivate / retract 共通。 */
export interface StateTargetInput extends ScopedWrite {
	readonly itemId: string;
	readonly expectedRevision: number;
	/** 変更を起こした run の ID（`AssertUserStateInput.sourceRunId` と同じ）。 */
	readonly sourceRunId?: string;
}

/** `unchanged` = 冪等（すでに同じ状態／同じ値）。item の revision は変わらない。 */
export type StateWriteResult =
	| { readonly status: "applied" | "unchanged"; readonly item: StateItem }
	| { readonly status: "rejected"; readonly reasonCode: StateReasonCode }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode }
	| { readonly status: MissingStatus };

export interface ListStateInput extends ScopedRead {
	readonly kinds?: readonly StateKind[];
	/** true なら active 以外（inactive / superseded / disputed / retracted / invalidated）も返す。forgotten は常に返さない。 */
	readonly includeInactive?: boolean;
	readonly limit?: number;
	/** Continue the same scope/filter in updated-seq descending, item-ID ascending order.
	 * Read all pages in one host read transaction for a consistent snapshot. */
	readonly after?: { readonly updatedSeq: number; readonly itemId: string };
	/** 指定した item だけに絞る（1〜1000 件、重複なし）。scope と状態の条件はそのまま効き、無い ID は黙って除く。 */
	readonly itemIds?: readonly string[];
	/**
	 * 除外（忘却の依頼の直後の即時の印）された item も返す（各 item に `excluded: true`）。既定は返さない。
	 * 忘却の処理（対象の全版・根拠の収集）にだけ使う。回答・文脈の材料には使わない。
	 */
	readonly includeExcluded?: boolean;
	/**
	 * 抑制された item の扱い。`mark`（既定）は返して `suppressed: true` を付ける。`omit` は返さない
	 * （`## Memory` など、話題に出す文脈の材料を作るとき）。忘却の処理は `mark` のまま使う。
	 */
	readonly suppressed?: "mark" | "omit";
	/**
	 * 推定由来（`agent_inferred` と既存 DB の `admitted_extraction`）の item のうち、強度がこの値未満のものを返さない。
	 * 本人由来（`user_confirmed` / `user_edited`）は強度に関わらず返す。省略は絞らない。
	 */
	readonly minStrength?: number;
}

export type ListStateResult =
	| {
			readonly status: "ok";
			readonly items: readonly StateItem[];
			/** Present only when another visible page exists. */
			readonly nextCursor?: {
				readonly updatedSeq: number;
				readonly itemId: string;
			};
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

/**
 * 1 つの item が属する「同じ事実」の全版を引く（`itemId` が forgotten・墓標つき・他 scope・存在しない場合は
 * `forgotten` / `missing` / `not_permitted` を返す）。同じ事実 = 同 (principal, scope, subject, kind, semanticKey)。
 * `itemIds` は forgotten・墓標つきを除く全 status の版を、古い順（createdSeq 昇順）に返し、`itemId` 自身を含む。
 * `listState` の上限（`LIMITS_STATE.maxListItems`）に左右されない。ホストが忘却の対象（置き換え前の旧版も同じ値を
 * 持つ）を決めるために使う。
 */
export interface ReadStateFactInput extends ScopedRead {
	readonly itemId: string;
}

export type ReadStateFactResult =
	| {
			readonly status: "ok";
			readonly subject: StateSubject;
			readonly kind: StateKind;
			readonly semanticKey: string;
			readonly itemIds: readonly string[];
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode }
	| { readonly status: MissingStatus };

// ---- 全文検索（`searchState`、設計 `spec/state-search-design.md` §4.1）----

/**
 * 許可された scope の active な item を全文検索する。語の無害化（分割、長さ、制御文字）はホストが行い、
 * 核は受け取った語を phrase として引用し、束縛変数で渡すだけにする。
 * - `terms.indexed`: 3 文字（コードポイント）以上の語。FTS5 trigram の MATCH に使う（AND）。
 * - `terms.scanned`: 3 文字未満の語。`instr(lower(文書), lower(語))` で絞る（AND）。
 * - 語がすべて `scanned` のときは、許可 scope の active な item を走査する。対象が `scanMax` を超えたら blocked。
 * 並びは bm25（走査の経路では使わない）、`updatedSeq` の降順、itemId の昇順。スコアの数値は返さない。
 */
export interface SearchStateInput {
	readonly contractVersion: 1;
	readonly access: AccessContext;
	readonly scopeKeys: readonly string[];
	readonly terms: {
		readonly indexed: readonly string[];
		readonly scanned: readonly string[];
	};
	readonly kinds?: readonly StateKind[];
	readonly subject?: StateSubject;
	/** 返す件数（1〜21）。核は limit + 1 件を読み、続きがあれば `more: true`。 */
	readonly limit: number;
	/** 走査の経路の対象の上限（既定 20000）。 */
	readonly scanMax?: number;
	/**
	 * 推定由来の item のうち、強度がこの値未満のものを返さない（本人由来は常に返す）。省略は絞らない
	 * （利用者が語を指定した直接の検索は、強度の低い推定も引ける）。順位は強度で重み付けされる。
	 * 除外された item は常に返さない。抑制された item は返し、`suppressed: true` を付ける。
	 */
	readonly minStrength?: number;
}

export type SearchStateReasonCode =
	| StoreAccessReasonCode
	| "SCAN_LIMIT_EXCEEDED";

export type SearchStateResult =
	| {
			readonly status: "ok";
			readonly items: readonly StateItem[];
			readonly more: boolean;
			readonly mode: "fts" | "scan";
	  }
	| { readonly status: "blocked"; readonly reasonCode: SearchStateReasonCode };

// ---- 二重の時間軸の照会（`listStateByTime`）----

/**
 * 記録の二重の時間軸。真だった期間（`validFromMs` / `validUntilMs`）に加え、記録した時点（`recordedAtMs`）と失効させた時点
 * （`supersededAtMs`）を、既存の版の履歴（`memory_state_event` の `at_ms` ＝ 書き込み時にホストが渡した時計）から導く。
 * - `recordedAtMs`: その版（item）を作った書き込みの時計。
 * - `supersededAtMs`: 置き換え（`supersede`）・撤回（`retract`）・無効化（`invalidate`）で失効させた書き込みの時計。
 *   今も有効な版、停止中（inactive）・紛争中（disputed）の版は null。
 */
export interface TimedStateItem extends StateItem {
	readonly recordedAtMs: number;
	readonly supersededAtMs: number | null;
}

/**
 * 時間軸での照会。条件はすべて AND。何も指定しなければ、忘却されていない全版（履歴）を古い順に返す。
 * 除外された item は返さない。抑制された item は `suppressed: true` を付けて返す。
 * - `current`: 今有効な記録だけ（status が `active`）。
 * - `recordedAt`: その時点で記録済みで、まだ失効していなかった版（`recordedAtMs <= T` かつ `supersededAtMs` が無いか `> T`）。
 * - `validAt`: その時点で真だった版（`validFromMs <= V` かつ `V < validUntilMs`。境界が無い側は無限）。
 */
export interface ListStateByTimeInput extends ScopedRead {
	readonly kinds?: readonly StateKind[];
	readonly current?: boolean;
	readonly recordedAt?: number;
	readonly validAt?: number;
	readonly limit?: number;
	/** 古い順（createdSeq 昇順、同じなら itemId 昇順）の続き。 */
	readonly after?: { readonly createdSeq: number; readonly itemId: string };
}

export type ListStateByTimeResult =
	| {
			readonly status: "ok";
			readonly items: readonly TimedStateItem[];
			readonly nextCursor?: {
				readonly createdSeq: number;
				readonly itemId: string;
			};
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

// ---- 抑制（話題に出さない）----

/**
 * 印の対象。`state_item` はその版だけ、`state_fact` は同じ事実（subject・kind・semanticKey）の全版と、以後の新しい版。
 */
export type StateMarkTarget =
	| { readonly type: "state_item"; readonly itemId: string }
	| {
			readonly type: "state_fact";
			readonly subject: StateSubject;
			readonly kind: StateKind;
			readonly semanticKey: string;
	  };

/**
 * 抑制の付与・解除。記録は残る。`listState` は `suppressed: "omit"` で外し、`searchState` は印を付けて返す。
 * journal には載らない（忘却ではない。DB を復元で失えば付け直す）。対象の事実・item が忘却されると印も消える。
 * 同じ状態への操作は `unchanged`。`state_item` が無ければ `missing`、忘却済みなら `forgotten`。
 */
export interface SuppressStateInput extends ScopedWrite {
	readonly target: StateMarkTarget;
	readonly sourceRunId?: string;
}

export type SuppressStateResult =
	| { readonly status: "applied" | "unchanged" }
	| { readonly status: MissingStatus }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

export type ListSuppressionsInput = ScopedRead;

export type ListSuppressionsResult =
	| { readonly status: "ok"; readonly targets: readonly StateMarkTarget[] }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

// ---- 順位の重み（強度）----

/** 推定由来の記録を既定の検索・文脈から外す強度の目安（`minStrength` に渡す。本体は自動では適用しない）。 */
export const DEFAULT_WEAK_STRENGTH = 0.2;

// ---- 根拠必須の検査（純粋）----

export const GROUNDED_REASON_CODES = Object.freeze([
	/** 引用つきの根拠も、候補からの昇格の記録も無い。 */
	"NO_GROUNDING",
	"QUOTE_MISMATCH",
	"EVIDENCE_NOT_IN_INPUT",
	"SOURCE_STALE",
	/** `requireRunId` なのに `sourceRunId` が無い。 */
	"RUN_ID_REQUIRED",
	/** 昇格の記録の、独立した会話の数が `minConversations` に足りない。 */
	"NOT_ENOUGH_CONVERSATIONS",
] as const);
export type GroundedReasonCode = (typeof GROUNDED_REASON_CODES)[number];

/** 長期記憶（State）・傾向の主張の根拠。引用つきの根拠（発言 ID と引用）か、候補からの昇格の記録のどちらか。 */
export interface GroundedClaim {
	readonly evidence?: readonly EvidenceSpan[];
	/** `evidence` の引用を照合する本文つきの出典。 */
	readonly sources?: readonly HostSourceState[];
	/** 候補（L1）からの昇格の記録。根拠の件数と、観測した会話の ID（重複は数えない）。 */
	readonly promotion?: {
		readonly candidateId: string;
		readonly evidenceCount: number;
		readonly conversationIds: readonly string[];
	};
	readonly sourceRunId?: string;
}

export interface GroundedPolicy {
	/** true なら `sourceRunId`（整理の run の ID）を必須にする。 */
	readonly requireRunId?: boolean;
	/** 昇格の記録の、独立した会話の数の下限（既定 1）。 */
	readonly minConversations?: number;
}

export type GroundedCheckResult =
	| { readonly ok: true; readonly basis: "quote" | "promotion" }
	| { readonly ok: false; readonly reasonCode: GroundedReasonCode };

// ---- 記憶の候補（L1）----

/**
 * 推定・観測の候補（設計 §4.5）。`origin` は `agent_inferred` だけ。根拠（出典の範囲。発言、または外部のメモの参照）は
 * 1 件以上必須で、観測の回数は distinct な根拠の件数、観測した会話は根拠に付いた会話 ID の distinct な一覧。
 * 候補は `context`・`searchState`・`listState` に現れない。忘却の閉包の対象で、根拠の出典を忘れると消える。
 */
export const CANDIDATE_STATUSES = Object.freeze([
	"open",
	"dismissed",
	"promoted",
	"forgotten",
] as const);
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const LIMITS_CANDIDATE = Object.freeze({
	/** 1 つの候補が持てる根拠の件数。 */
	maxEvidencePerCandidate: 256,
	maxConversationIdBytes: 256,
	maxListCandidates: 200,
});

export interface InferredCandidate {
	readonly candidateId: string;
	readonly scopeKey: string;
	readonly status: Exclude<CandidateStatus, "forgotten">;
	readonly kind: StateKind;
	readonly subject: StateSubject;
	readonly semanticKey: string;
	readonly value: StateValue;
	readonly origin: "agent_inferred";
	/** 根拠の件数（distinct な出典の範囲）。 */
	readonly observationCount: number;
	/** 観測した会話の ID（distinct、初出の順）。会話 ID を渡さなかった観測（外部のメモなど）は含まない。 */
	readonly conversationIds: readonly string[];
	readonly evidence: readonly SourceRef[];
	readonly firstObservedMs: number;
	readonly lastObservedMs: number;
	/** 昇格済みのとき、昇格先の itemId。 */
	readonly promotedItemId?: string;
	readonly createdSeq: number;
	readonly updatedSeq: number;
}

export const CANDIDATE_REASON_CODES = Object.freeze([
	"SUBJECT_KIND_MISMATCH",
	"QUOTE_MISMATCH",
	"EVIDENCE_NOT_IN_INPUT",
	"SOURCE_STALE",
	"SOURCE_TOMBSTONED",
	"EVIDENCE_LIMIT_EXCEEDED",
] as const);
export type CandidateReasonCode = (typeof CANDIDATE_REASON_CODES)[number];

/**
 * 候補の記録（観測の追加）。同じ (subject, kind, semanticKey, polarity, text) の open な候補があればそこへ観測を足し、
 * 無ければ作る。同じ出典の同じ範囲を再び渡しても数えない（冪等。再試行で観測の回数が増えない）。
 * 根拠は State と同じ検査（引用・出典の現在状態・墓標）に通る。外部のメモを根拠にするときは、そのメモの出典
 * （別の namespace・kind でよい）を同じ形で渡す。`value.attributes` は持てない。
 */
export interface RecordCandidateInput extends ScopedWrite {
	readonly kind: StateKind;
	readonly subject: StateSubject;
	readonly semanticKey: string;
	readonly value: StateValue;
	readonly evidence: readonly EvidenceSpan[];
	readonly sources: readonly HostSourceState[];
	/** 観測した会話の ID（観測の回数と「複数の会話」の判定に使う）。 */
	readonly conversationId?: string;
	readonly sourceRunId?: string;
}

export type RecordCandidateResult =
	| {
			readonly status: "recorded";
			readonly created: boolean;
			/** 今回新しく数えた観測（根拠）の件数。0 なら冪等の再送。 */
			readonly newObservations: number;
			readonly candidate: InferredCandidate;
	  }
	| { readonly status: "rejected"; readonly reasonCode: CandidateReasonCode }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

export interface ListCandidatesInput extends ScopedRead {
	/** 既定は `open`。 */
	readonly status?: Exclude<CandidateStatus, "forgotten">;
	readonly kinds?: readonly StateKind[];
	/** 観測の回数の下限。 */
	readonly minObservations?: number;
	readonly limit?: number;
	/** updatedSeq の降順、同じなら candidateId の昇順の続き。 */
	readonly after?: {
		readonly updatedSeq: number;
		readonly candidateId: string;
	};
}

export type ListCandidatesResult =
	| {
			readonly status: "ok";
			readonly candidates: readonly InferredCandidate[];
			readonly nextCursor?: {
				readonly updatedSeq: number;
				readonly candidateId: string;
			};
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

export interface ReadCandidateInput extends ScopedRead {
	readonly candidateId: string;
}

export type ReadCandidateResult =
	| { readonly status: "ok"; readonly candidate: InferredCandidate }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode }
	| { readonly status: MissingStatus };
