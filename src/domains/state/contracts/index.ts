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
import type { SourceRef, SourceState } from "../../../contracts/types.ts";
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
}

/** deactivate / reactivate / retract 共通。 */
export interface StateTargetInput extends ScopedWrite {
	readonly itemId: string;
	readonly expectedRevision: number;
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
}

export type ListStateResult =
	| { readonly status: "ok"; readonly items: readonly StateItem[] }
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
