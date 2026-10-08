/**
 * Records（外部取得物）の契約（full-system-design §3.2）。実装は S1（`src/store/records.ts`）。
 *
 * 規則（S1 実装者はこの JSDoc を契約として扱う）:
 * - recordId = `"rec:" + sha256Hex(canonicalJson([principal, scopeKey, origin.namespace, origin.kind, origin.id]))`。
 *   同じ origin は常に同じ record を指し、内容が変わると revision が増える（新しい record にならない）。
 * - revision = `"sha256:" + <本文 UTF-8 の SHA-256 hex>`、digest = 同じ hex（`sha256:` なし）。
 * - Records の SourceRef: namespace `memory`, kind `record`, id = recordId, representation `text`。
 * - 本文は `memory_record_body` に revision ごとに保持する。forget で全 revision の本文・FTS 行を消す。
 */
import type { ByteRange, SourceRef, SourceState } from "./types.ts";
import type {
	MissingStatus,
	RunRef,
	ScopedRead,
	ScopedWrite,
} from "./common.ts";

export const LIMITS_RECORDS = Object.freeze({
	/** 1 回の capture の本文上限（UTF-8 byte）。M0 の maxSourceContentBytes と同じ。 */
	maxContentBytes: 1048576,
	/** readRecordRange の上限（UTF-8 byte）。 */
	maxRangeBytes: 65536,
	maxOriginNamespaceBytes: 64,
	maxOriginKindBytes: 64,
	maxOriginIdBytes: 256,
	maxProviderRefBytes: 64,
	/** recordSourceStates 1 回の refs 件数。 */
	maxSourceStateRefs: 256,
});

export const RECORD_MEDIA_TYPES = Object.freeze([
	"text/plain",
	"text/markdown",
	"application/json",
] as const);
export type RecordMediaType = (typeof RECORD_MEDIA_TYPES)[number];

export const RECORD_CAPTURE_STATES = Object.freeze([
	"complete",
	"partial",
] as const);
export type RecordCaptureState = (typeof RECORD_CAPTURE_STATES)[number];

/** 現存する record の状態。`forgotten` の record は本文もメタも返さないので含めない。 */
export const RECORD_STATUSES = Object.freeze(["active", "inactive"] as const);
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** capture が拒否される理由。 */
export const RECORD_BLOCKED_REASON_CODES = Object.freeze([
	"SCOPE_NOT_PERMITTED",
	"TOMBSTONED",
] as const);
export type RecordBlockedReasonCode =
	(typeof RECORD_BLOCKED_REASON_CODES)[number];

/** readRecordRange の範囲異常（M0 の SourceReasonCode と同名、+ 上限超過）。 */
export const RECORD_RANGE_REASON_CODES = Object.freeze([
	"SOURCE_RANGE_OUT_OF_BOUNDS",
	"SOURCE_RANGE_NOT_CHAR_BOUNDARY",
	"RANGE_TOO_LARGE",
] as const);
export type RecordRangeReasonCode = (typeof RECORD_RANGE_REASON_CODES)[number];

export interface RecordOrigin {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
}

export interface RecordMeta {
	readonly recordId: string;
	readonly scopeKey: string;
	readonly origin: RecordOrigin;
	readonly mediaType: RecordMediaType;
	readonly captureState: RecordCaptureState;
	readonly status: RecordStatus;
	readonly currentRevision: string;
	readonly digest: string;
	readonly byteLength: number;
	readonly createdSeq: number;
	readonly updatedSeq: number;
}

export interface CaptureRecordInput extends ScopedWrite {
	readonly origin: RecordOrigin;
	readonly mediaType: RecordMediaType;
	/** ≤ `LIMITS_RECORDS.maxContentBytes`。lone surrogate は `INVALID_STRING`。 */
	readonly content: string;
	readonly captureState: RecordCaptureState;
	readonly runRef?: RunRef;
	/** 外部プロバイダーに送った取得物なら、その識別子（忘却時の外部削除確認に使う）。 */
	readonly providerRef?: string;
}

/**
 * `created` は「この呼び出しで current revision が変わった」（新規 record または新 revision）。
 * 同一 origin かつ現在の revision と同一内容なら `created: false`（冪等。captureState だけは最新入力に更新）。
 */
export type CaptureRecordResult =
	| {
			readonly status: "captured";
			readonly recordId: string;
			readonly revision: string;
			readonly digest: string;
			readonly created: boolean;
			/** range なしの SourceRef（`revision` / `digest` 付き）。 */
			readonly ref: SourceRef;
	  }
	| {
			readonly status: "blocked";
			readonly reasonCode: RecordBlockedReasonCode;
	  };

export interface ReadRecordInput extends ScopedRead {
	readonly recordId: string;
	/** 省略時は current revision。過去 revision も読める（forget されていない限り）。 */
	readonly revision?: string;
}

export type ReadRecordResult =
	| {
			readonly status: "available";
			readonly record: RecordMeta;
			readonly revision: string;
			readonly content: string;
			readonly ref: SourceRef;
	  }
	| { readonly status: MissingStatus };

export interface ReadRecordRangeInput extends ScopedRead {
	readonly recordId: string;
	readonly revision: string;
	/** 半開区間 [startByte, endByte)。start < end でなければ MemoryContractError(INVALID_RANGE)。 */
	readonly range: ByteRange;
}

export type ReadRecordRangeResult =
	| {
			readonly status: "available";
			readonly text: string;
			/** range の bytes の SHA-256 hex（quote digest）。 */
			readonly digest: string;
	  }
	| { readonly status: MissingStatus }
	| {
			readonly status: "invalid_range";
			readonly reasonCode: RecordRangeReasonCode;
	  };

export interface RecordSourceStatesInput extends ScopedRead {
	/** namespace `memory` / kind `record` の ref だけ。それ以外は MemoryContractError(INVALID_VALUE)。 */
	readonly refs: readonly SourceRef[];
	/** true なら各 SourceState に `content`（ref の revision の本文）を載せる。 */
	readonly withContent?: boolean;
}

/**
 * `refs` と同じ順序・同じ件数で返す（重複 ref も重複して返す）。status 規則:
 * forgotten（tombstone あり）→ `forgotten`、record が無い／他 principal・scope → `missing`、
 * inactive → `missing`（evidence として使えない）、revision/digest が current と異なる → `changed`、
 * それ以外 → `available`。
 */
export type RecordSourceStatesResult = readonly SourceState[];

export interface RecordStatusChangeInput extends ScopedWrite {
	readonly recordId: string;
}

/** deactivate / reactivate は可逆。墓標・ジャーナル・ForgetReceipt を作らない。 */
export type RecordStatusChangeResult =
	| {
			readonly status: "changed" | "unchanged";
			readonly recordStatus: RecordStatus;
	  }
	| { readonly status: MissingStatus };
