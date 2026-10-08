/**
 * State / Admission の契約（full-system-design §3.5）。純粋 reducer / admission 表は S3
 * （`src/state/`）、永続は S3（`src/store/state.ts`）。モデルを使わない明示操作と、
 * Extraction（`extraction.ts`）が共有する語彙をここで固定する。
 *
 * 規則（S3 実装者はこの JSDoc を契約として扱う）:
 * - itemId = `"state:" + sha256Hex(canonicalJson([principal, scopeKey, createdSeq]))`。
 *   同じ (subject, kind, semanticKey) の `active` は 1 件。置き換えは別 item（旧は `superseded`）。
 * - `revision` は item ごとの 1 始まりの整数。変更のたびに +1。view の item.revision は `String(revision)`。
 * - `kind === "other_person_note"` ⇔ `subject` が `other:*`。不一致は `SUBJECT_KIND_MISMATCH`。
 *   `unknown` subject は台帳に載らない。
 * - 根拠の新旧は `evidenceOrdinal`（ホストが付与する出典の順位）で比べる。`user_confirmed` /
 *   `user_edited` の明示操作は新旧比較を受けず、CAS（expectedRevision / replaces）だけで決まる。
 * - 抽出の根拠 quote は state 側に本文を残さない（SourceRef + range だけ。本文は出典を読む）。
 * - 同値の明示確認は origin を昇格する: active が `admitted_extraction` で、明示操作（`assertUserState` /
 *   `confirmCandidate` / 同値の `editState`）が同じ値を `user_confirmed` / `user_edited` で書いたとき、値は変えず
 *   origin だけを user 由来へ上げる（revision を +1、event は `edit`、結果は `applied`）。逆（user 由来 → 抽出由来）の
 *   降格はしない。昇格後は「確認済み項目の保護」（抽出由来は黙って上書きしない）が効く。
 * - 抽出由来の書き込みは、同 key の active 以外の履歴も見る（`StateKeyHistory`）: (a) disputed の item があり、
 *   新しい書き込みの根拠順位が disputed 群の最新より古ければ `OLDER_EVIDENCE`、同順位以上でも dispute を黙って
 *   解消しない（active にはせず、ユーザー確認 `pending_user`／reducer では disputed のまま加わる）。(b) ユーザー由来の
 *   item を `retract` / `deactivate` した key への抽出由来の書き込みは、`auto_admit` でも自動採用しない（`pending_user`）。
 *   ユーザーが明示的に消したものを自動で復活させない。抽出由来の item をユーザーが消した場合は対象外（限界）。
 * - 期限（`validFromMs` / `validUntilMs`）は保存するだけで、本体は評価しない（`readMemorySnapshotPart` が現在時刻を
 *   持たない）。期限の評価はホストの責任（Eumenes 側の手順）。
 * - `StateValue.attributes` は明示操作だけが持つ。抽出の候補（モデルの出力）には attributes が無いので、
 *   同値比較（`stateValueEquals`）で「attributes の差だけ違う値」が候補と既存 item の間で衝突することはあるが、
 *   比較は attributes を含めたまま変えない（候補は常に attributes なし）。
 * - 本体は `forget` を reducer に通さない（lifecycle が閉包で value を消し status を `forgotten` にする）。
 */
import type { SourceRef, SourceState } from "./types.ts";
import type {
	EvidenceSpan,
	MissingStatus,
	Polarity,
	ScopedRead,
	ScopedWrite,
	SourceRole,
	StateSubject,
	StoreAccessReasonCode,
} from "./common.ts";
import type { MemoryItemV2 } from "./view-v2.ts";

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

/** 明示操作（モデルなし）で付く origin。 */
export const USER_STATE_ORIGINS = Object.freeze([
	"user_confirmed",
	"user_edited",
] as const);
export type UserStateOrigin = (typeof USER_STATE_ORIGINS)[number];

export const STATE_ORIGINS = Object.freeze([
	...USER_STATE_ORIGINS,
	"admitted_extraction",
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
/** reducer が扱う遷移。`forget` は lifecycle の閉包適用が行うので含めない。 */
export type StateTransitionAction = Exclude<StateEventAction, "forget">;

export const STATE_CAUSE_TYPES = Object.freeze([
	"user",
	"candidate",
	"lifecycle",
] as const);
export type StateCauseType = (typeof STATE_CAUSE_TYPES)[number];

/**
 * State 書き込みの rejected 理由（reducer + 根拠検査）。Admission の理由は
 * `ADMISSION_REASON_CODES`。両者は別タプルで、同名のコード（`OLDER_EVIDENCE` など）は同じ意味。
 */
export const STATE_REASON_CODES = Object.freeze([
	"STALE_REVISION",
	"OLDER_EVIDENCE",
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

// ---- Admission ----

export const ADMISSION_DECISIONS = Object.freeze([
	"admitted",
	"pending_user",
	"rejected",
] as const);
export type AdmissionDecisionKind = (typeof ADMISSION_DECISIONS)[number];

/** kind ごとの採用方針。`never` = 候補も作らず rejected、`user_confirm` = 候補（pending_user）まで。 */
export const ADMISSION_MODES = Object.freeze([
	"never",
	"user_confirm",
	"auto_admit",
] as const);
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

/**
 * Admission 規則表（design §3.5）を上から評価したときの reasonCode。評価順はこのタプルの順序と
 * 同じ。ただし kind の方針が `never` のときは、`pending_user` になるはずの規則（MODALITY_QUOTED /
 * SUBJECT_OTHER / TEMPORAL_NOT_CURRENT / NOT_USER_SOURCE / 確認済み項目の保護）が当たっても候補を作らず
 * `rejected` / `POLICY_NEVER` にする（`never` が `pending_user` より優先）。`admitted` は reasonCode なし。
 * `TEMPORAL_NOT_CURRENT`（S5 で追加、§6.4(a) 過去の状態）: temporal が past / future の候補は現在の状態にしない。
 */
export const ADMISSION_REASON_CODES = Object.freeze([
	"INVALID_CANDIDATE",
	"QUOTE_MISMATCH",
	"EVIDENCE_NOT_IN_INPUT",
	"SOURCE_STALE",
	"HOST_OWNED_KIND",
	"MODALITY_QUOTED",
	"MODALITY_NOT_ASSERTED",
	"SUBJECT_OTHER",
	"SUBJECT_UNKNOWN",
	"TEMPORAL_NOT_CURRENT",
	"NOT_USER_SOURCE",
	"OLDER_EVIDENCE",
	"POLICY_NEVER",
	"POLICY_REQUIRES_USER",
] as const);
export type AdmissionReasonCode = (typeof ADMISSION_REASON_CODES)[number];

export type AdmissionDecision =
	| { readonly decision: "admitted" }
	| {
			readonly decision: "pending_user";
			readonly reasonCode: AdmissionReasonCode;
	  }
	| {
			readonly decision: "rejected";
			readonly reasonCode: AdmissionReasonCode;
	  };

/** kind ごとの方針。`other_person_note` に `auto_admit` は指定できない（parse で INVALID_ENUM）。 */
export type AdmissionPolicy = Readonly<Record<StateKind, AdmissionMode>>;

/** 既定は全 kind `user_confirm`（候補生成のみ）。`auto_admit` は E 段階の合格記録がある kind だけに設定する運用。 */
export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = Object.freeze({
	preference: "user_confirm",
	personal_fact: "user_confirm",
	constraint: "user_confirm",
	habit: "user_confirm",
	other_person_note: "user_confirm",
});

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
	 * Records の出典もホストが付与する。根拠の新旧（`OLDER_EVIDENCE`）の判定にだけ使う。
	 */
	readonly ordinal: number;
}

/** 抽出入力の出典。`role` は NOT_USER_SOURCE の判定に使う。 */
export interface ExtractionSource extends HostSourceState {
	readonly role: SourceRole;
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
	readonly createdSeq: number;
	readonly updatedSeq: number;
}

export interface StateCause {
	readonly type: StateCauseType;
	readonly id: string;
}

// ---- reducer（純粋、S3 が `src/state/reducer.ts` に実装）----

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

/**
 * 同 (subject, kind, semanticKey) の active 以外の履歴のうち、新しい書き込みの判定に効く要約。
 * ホスト（store）が forgotten・墓標つきを除いて計算する。
 */
export interface StateKeyHistory {
	/** `disputed` の item の根拠順位（`evidenceOrdinal`）の最大。disputed が無ければ null。 */
	readonly disputedMaxOrdinal: number | null;
	/** origin が `user_confirmed` / `user_edited` の item が `retracted` または `inactive` で残っている。 */
	readonly userRemoved: boolean;
}

export interface StateTransitionContext {
	readonly atMs: number;
	/** 同 (subject, kind, semanticKey) の現在の `active` item（なければ null）。supersede / dispute 判定用。 */
	readonly activeForKey: StateItemView | null;
	/** 省略は履歴なし（`disputedMaxOrdinal: null`、`userRemoved: false`）と同じ。 */
	readonly keyHistory?: StateKeyHistory;
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
	readonly origin: UserStateOrigin;
	/** 保存するだけで本体は評価しない（期限の評価はホスト）。 */
	readonly validFromMs?: number;
	/** 保存するだけで本体は評価しない（期限の評価はホスト）。 */
	readonly validUntilMs?: number;
	/** 既存 active を置き換える場合は必須。無いのに active が存在すれば `ACTIVE_EXISTS`。 */
	readonly replaces?: { readonly itemId: string; readonly revision: number };
}

export interface EditStateInput extends ScopedWrite {
	readonly itemId: string;
	readonly expectedRevision: number;
	readonly value: StateValue;
	readonly evidence: readonly EvidenceSpan[];
	readonly sources: readonly HostSourceState[];
	readonly origin: UserStateOrigin;
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

export type ReadMemorySnapshotPartInput = ScopedRead;

/**
 * View v2 の Snapshot に合成する Memory 側の部品。`items` は対象 scope の active かつ
 * `subject: self` の state item（`other_person_note` は含めない）。`sources` は items の
 * 依存のうち Memory 所有の出典（Records）の現在状態で、会話 source はホストが入れる。
 * `memoryRevision` = `String(memory_scope_state.revision)`。
 *
 * 件数は上限なしで返す。active な self item が `LIMITS.maxItems`（1000）、出典が `LIMITS.maxSources`（4096）を
 * 超える snapshot は、`composeSnapshotV2` → `buildMemoryViewV2` で（例外ではなく）`overflow` / `BUDGET_EXCEEDED` になる
 * （必須の構成が入り切らない = 予算超過）。期限（`validFromMs` / `validUntilMs`）は評価しない: この関数は現在時刻を
 * 持たないので、期限切れの item も `active` として返す。期限の評価はホストの責任。
 */
export type ReadMemorySnapshotPartResult =
	| {
			readonly status: "ok";
			readonly memoryRevision: string;
			readonly items: readonly MemoryItemV2[];
			readonly sources: readonly SourceState[];
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };
