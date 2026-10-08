/**
 * Extraction の契約（full-system-design §3.6, §4）。実装は S5（`src/extraction/`, `src/store/extraction.ts`）。
 * ホスト queue handler の `prepareInTransaction` / `execute` / `settleInTransaction` に対応する。
 * Memory はモデルを呼ばず、job の status / attempt / lease / retry を保存しない。
 *
 * 規則（S5 実装者はこの JSDoc を契約として扱う）:
 * - runId = `jobId + ":" + attempt`（`RunRef` から決定的に作る。attempt の大小は比較しない）。
 * - candidateId = `"cand:" + sha256Hex(canonicalJson([runId, index]))`（index は出力内の 0 始まり位置）。
 * - ExtractorPort が失敗（例外・タイムアウト）した場合、ホストは settle を呼ばない（run は `prepared` のまま、
 *   再試行はホスト）。settle は「モデルが返した値」だけを受け取る。
 * - 出力トップレベルの形の違反、および候補内の権限系フィールド（scope / confidence / status / origin 等）は
 *   run 全体を `rejected_output` / `OUTPUT_SCHEMA` にする。個々の候補の値の不正（未知の kind、範囲外 quote 等）は
 *   その候補だけ `rejected`（`ADMISSION_REASON_CODES`）にする。
 * - 候補行（`memory_candidate`）の方針: kind の方針が `never` の候補（`POLICY_NEVER`）は候補行を作らず、run の
 *   `rejected` 件数にだけ数える（値を残さない）。台帳に載らない値（INVALID_CANDIDATE・HOST_OWNED_KIND・kind を決められない
 *   候補）も行を作らない。それ以外の `rejected`（仮定文・疑問文・QUOTE_MISMATCH・OLDER_EVIDENCE・SUBJECT_UNKNOWN など）は
 *   監査用に行を残す。行は `value`（モデルが出した text / polarity）と semanticKey を持つ（検査を通った evidence の
 *   行だけ持ち、quote 本文は持たない）。これらは forget の閉包の対象（run → candidate の辺で届き、値は消える）で、
 *   `listCandidates({ decision: "rejected" })` で値つきで返る。`pending_user` が既定の一覧。
 * - settle の `admitted` 件数には、同順位で値が違い `disputed` になった書き込み（reducer の dispute）も数える。
 *   disputed の item は active ではなく view に入らない。件数は「採用の書き込みが拒否されなかった」意味であり、
 *   active になったことではない。
 * - 抽出の候補には `attributes` が無い（`StateValue.attributes` は明示操作だけ）。candidate の値と、attributes を持つ
 *   既存 item の値は `stateValueEquals` では別の値として扱う（候補が attributes の差だけで衝突する）。
 * - `semanticKey` と `subject`（モデル由来の文字列）は、明示操作の識別子と同じ規則（空でない、制御文字なし、
 *   lone surrogate なし、byte 上限）。破る候補は `INVALID_CANDIDATE`。`value.text` は本文の規則（改行・タブ可）。
 * - 限界: `value.text` はモデルの任意の文字列で、evidence の quote とは検証上結ばれない（quote が出典の range と一致する
 *   ことしか検査しない）。意味の一致は規則では検出できない（E 段階の評価で測る）。
 */
import type { SourceRef, SourceState } from "./types.ts";
import type {
	JsonValue,
	Modality,
	Polarity,
	RunRef,
	ScopedRead,
	ScopedWrite,
	SourceRole,
	StoreAccessReasonCode,
	Subject,
	Temporal,
	MissingStatus,
} from "./common.ts";
import type {
	AdmissionPolicy,
	AdmissionReasonCode,
	ExtractionSource,
	StateItem,
	StateKind,
	StateReasonCode,
	StateValue,
} from "./state.ts";

export const LIMITS_EXTRACTION = Object.freeze({
	maxCandidates: 10,
	maxOutputBytes: 16384,
	maxEvidencePerCandidate: 4,
	maxSources: 64,
	/** `PrepareExtractionInput.maxInputBytes` に指定できる上限（出典本文の合計 UTF-8 byte）。 */
	maxInputBytesCap: 262144,
	maxShownState: 50,
	maxExtractorIdBytes: 64,
	maxPromptVersionBytes: 64,
	maxProviderRefBytes: 64,
	maxListedCandidates: 100,
});

/** ホスト（Continuity）が所有する kind。モデルが出しても候補にならない（HOST_OWNED_KIND）。 */
export const HOST_OWNED_KINDS = Object.freeze([
	"goal",
	"decision",
	"open_question",
] as const);

export const EXTRACTION_RUN_STAGES = Object.freeze([
	"prepared",
	"settled",
	"stale",
	"rejected_output",
] as const);
export type ExtractionRunStage = (typeof EXTRACTION_RUN_STAGES)[number];

export const SOURCE_PROGRESS_STAGES = Object.freeze([
	"extracted",
	"no_change",
	"failed_output",
] as const);
export type SourceProgressStage = (typeof SOURCE_PROGRESS_STAGES)[number];

export const CANDIDATE_DECISIONS = Object.freeze([
	"admitted",
	"pending_user",
	"rejected",
	"invalidated",
	"forgotten",
] as const);
export type CandidateDecision = (typeof CANDIDATE_DECISIONS)[number];

export const EXTRACTION_SKIP_REASON_CODES = Object.freeze([
	"MEMORY_DISABLED",
	"NO_NEW_INPUT",
	"SOURCE_TOMBSTONED",
	"INPUT_TOO_LARGE",
] as const);
export type ExtractionSkipReasonCode =
	(typeof EXTRACTION_SKIP_REASON_CODES)[number];

export const EXTRACTION_STALE_REASON_CODES = Object.freeze([
	"SOURCE_CHANGED",
	"SOURCE_TOMBSTONED",
	"STATE_CHANGED",
	"RUN_UNKNOWN",
	"RUN_ALREADY_SETTLED_DIFFERENT",
] as const);
export type ExtractionStaleReasonCode =
	(typeof EXTRACTION_STALE_REASON_CODES)[number];

export const EXTRACTION_REJECTED_OUTPUT_REASON_CODES = Object.freeze([
	"OUTPUT_SCHEMA",
	"OUTPUT_TOO_LARGE",
	"TOO_MANY_CANDIDATES",
] as const);
export type ExtractionRejectedOutputReasonCode =
	(typeof EXTRACTION_REJECTED_OUTPUT_REASON_CODES)[number];

export const CONFIRM_ACTIONS = Object.freeze(["admit", "reject"] as const);
export type ConfirmAction = (typeof CONFIRM_ACTIONS)[number];

// ---- prepare ----

export interface ExtractionProfile {
	readonly extractorId: string;
	readonly promptVersion: string;
	/** 出典本文を送る外部プロバイダーの識別子。忘却時の外部削除確認（pending / unverified）に使う。 */
	readonly providerRef: string;
}

export interface PrepareExtractionInput extends ScopedWrite {
	readonly run: RunRef;
	readonly enabled: boolean;
	/** ホストが同一 transaction で読んだ本文つきの出典。 */
	readonly sources: readonly ExtractionSource[];
	readonly profile: ExtractionProfile;
	/** ≤ `LIMITS_EXTRACTION.maxInputBytesCap`。出典本文の合計がこれを超えると `INPUT_TOO_LARGE`。 */
	readonly maxInputBytes: number;
}

/** モデル向け素材（固定文言 + 出力 JSON schema）。モデル固有の request 形式への変換はホスト。 */
export interface ExtractionPromptMaterial {
	readonly promptVersion: string;
	readonly instructions: string;
	readonly outputSchema: JsonValue;
}

/** replaces の対象としてモデルに見せた既存 state item。settle で revision を CAS 照合する。 */
export interface ShownStateItem {
	readonly itemId: string;
	readonly revision: number;
	readonly kind: StateKind;
	readonly semanticKey: string;
	readonly value: StateValue;
}

/** deep-frozen・JSON 化可能。ホストはこれだけをモデル層へ渡す。 */
export interface ExtractionInput {
	readonly runId: string;
	readonly inputDigest: string;
	readonly sources: readonly {
		readonly ref: SourceRef;
		readonly role: SourceRole;
		readonly content: string;
	}[];
	readonly shownState: readonly ShownStateItem[];
	readonly instructions: ExtractionPromptMaterial;
}

export type PrepareExtractionResult =
	| { readonly status: "ready"; readonly input: ExtractionInput }
	| {
			readonly status: "skip";
			readonly reasonCode: ExtractionSkipReasonCode;
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

// ---- execute（ホスト、async。Memory は型だけ）----

/** 戻り値はホストが JSON として読み込み済みの値（`unknown`）。Memory は文字列の JSON を読まない。 */
export type ExtractorPort = (
	input: ExtractionInput,
	signal: AbortSignal,
) => Promise<unknown>;

// ---- モデル出力の形（settle が parse する）----

export interface ExtractionOutputEvidence {
	/** `ExtractionInput.sources` の添字。 */
	readonly sourceIndex: number;
	readonly startByte: number;
	readonly endByte: number;
	readonly quote: string;
}

export interface ExtractionOutputCandidate {
	/** モデルが出した文字列。未知の kind や host 所有 kind は候補単位で rejected。 */
	readonly kind: string;
	readonly subject: Subject;
	readonly semanticKey: string;
	readonly value: { readonly text: string; readonly polarity: Polarity };
	readonly modality: Modality;
	readonly temporal: Temporal;
	readonly evidence: readonly ExtractionOutputEvidence[];
	readonly replaces?: string;
}

/** `noChange === true` ⇔ `candidates` が空。最大 `LIMITS_EXTRACTION.maxCandidates` 件、canonical JSON ≤ 16 KiB。 */
export interface ExtractionOutput {
	readonly noChange: boolean;
	readonly candidates: readonly ExtractionOutputCandidate[];
}

// ---- settle ----

export interface SettleExtractionInput extends ScopedWrite {
	readonly run: RunRef;
	readonly output: unknown;
	/** ホストが同 transaction で読み直した run 入力の出典の現在状態。 */
	readonly currentSources: readonly SourceState[];
	readonly policy: AdmissionPolicy;
}

export type SettleExtractionResult =
	| {
			readonly status: "applied";
			readonly admitted: number;
			readonly pendingUser: number;
			readonly rejected: number;
	  }
	| {
			readonly status: "stale";
			readonly reasonCode: ExtractionStaleReasonCode;
	  }
	| {
			readonly status: "rejected_output";
			readonly reasonCode: ExtractionRejectedOutputReasonCode;
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

// ---- 候補の参照・確認 ----

export interface CandidateEvidenceRecord {
	/** range つき。quote 本文は保存せず、`quoteDigest`（range の bytes の SHA-256 hex）だけ持つ。 */
	readonly source: SourceRef;
	readonly quoteDigest: string;
}

export interface CandidateRecord {
	readonly candidateId: string;
	readonly runId: string;
	readonly scopeKey: string;
	readonly kind: StateKind;
	readonly subject: Subject;
	readonly semanticKey: string;
	readonly value: StateValue;
	readonly modality: Modality;
	readonly temporal: Temporal;
	readonly decision: CandidateDecision;
	readonly reasonCode: AdmissionReasonCode | null;
	readonly evidence: readonly CandidateEvidenceRecord[];
	readonly createdSeq: number;
}

export interface ListCandidatesInput extends ScopedRead {
	/**
	 * 省略時は `pending_user`。forgotten は常に返さない。`rejected` は監査用の行（値つき。方針 `never` の候補は
	 * 行がない）で、forget の対象。詳細はファイル先頭の「候補行の方針」。
	 */
	readonly decision?: Exclude<CandidateDecision, "forgotten">;
	readonly limit?: number;
}

export type ListCandidatesResult =
	| { readonly status: "ok"; readonly candidates: readonly CandidateRecord[] }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

export interface ConfirmCandidateInput extends ScopedWrite {
	readonly candidateId: string;
	readonly action: ConfirmAction;
	/** `admit` で値を編集する場合（origin は `user_edited`）。省略時は候補の値（origin `user_confirmed`）。 */
	readonly editedValue?: StateValue;
	/** `admit` 時に evidence の出典を再検査するための現在状態。`reject` では無視。 */
	readonly currentSources: readonly SourceState[];
}

export type ConfirmCandidateResult =
	| { readonly status: "admitted"; readonly item: StateItem }
	| { readonly status: "rejected" }
	| {
			readonly status: "not_pending";
			readonly decision: CandidateDecision;
	  }
	| { readonly status: "refused"; readonly reasonCode: StateReasonCode }
	| { readonly status: MissingStatus };
