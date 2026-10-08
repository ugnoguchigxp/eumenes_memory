/**
 * View v2（schemaVersion 2）の契約（full-system-design §3.4）。実装は S4（`src/view` / `src/validation`）。
 *
 * - schemaVersion 1 の型・挙動は一切変えない（`types.ts` が正本）。v2 は別の型・別の関数として並べる:
 *   `buildMemoryViewV2` / `validateMemoryViewV2` / `parseBuildMemoryViewInputV2` / `parseValidationCurrentV2` /
 *   `parseMemoryViewV2`。v1 の関数は `schemaVersion: 2` を従来どおり `UNSUPPORTED_SCHEMA_VERSION` で拒否する
 *   （既存 fixture E04 / V41 が固定している。設計書 §1.3 の「同一関数で版分岐」から意図的に逸脱）。
 * - state items は全部必須（超過は overflow）。evidence は任意で、予算に入らない分は
 *   `coverage.omitted: [{ type: "evidence", count }]` と `coverage.complete: false` で表す。
 *   evidence は検索順位の先頭から、evidence 予算（`maxEvidenceBytes`、1 件 = canonical JSON の UTF-8 byte 長の合計）と
 *   全体予算（`maxBytes`）の両方に入る限りの先頭 prefix だけを載せる（途中で入らなければ以降は小さくても載せない）。
 *   必須だけの view（evidence 0 件、省略の記録 `coverage.omitted` を含む）が `maxBytes` に入らなければ overflow。
 * - `subject` が `self` 以外（`other:*` / `unknown`）の item は build が除外し coverage に数えない。
 * - 依存検査（build 3a–3k / validate）の対象に evidence の出典も含める（evidence の出典が
 *   forgotten なら view は blocked / invalid）。evidence 専用の reasonCode は作らない。
 *   build は渡された hit を（重複を除いて）すべて検査する: 予算で省く hit の出典が forgotten でも blocked。
 *   validate は view に載っている evidence だけを検査し、検索結果の集合が変わっても invalid にしない。
 * - range の検査は v1 と同じ規則だが、Memory 所有の出典（namespace `memory`。Records）は content が無くても
 *   range を理由に `SOURCE_CONTENT_REQUIRED` にしない（版・digest が本文を固定し、範囲は書き込み時に検証済み）。
 *   content があれば範囲・文字境界は検査する。ホスト所有の出典は v1 と同じく range に content 必須。
 * - stateRevision はホストが `"c:" + continuityRevision + "|m:" + memoryRevision` のように合成する
 *   （本体は不透明に比較するだけ。参照実装は `composeSnapshotV2`）。
 * - viewDigest: `viewDigest` を除く ready 本体（schemaVersion 2、items / evidence / dependencies / coverage を含む）の
 *   canonical JSON（キーを UTF-16 コード単位順に整列、空白なし）の SHA-256 小文字 hex。v1 と同一規則。
 */
import type {
	AccessContext,
	InstructionAuthority,
	ItemStatus,
	SourceDependency,
	SourceRef,
	SourceState,
} from "./types.ts";
import type { RecallHit } from "./recall.ts";
import type { Subject } from "./common.ts";
import { BUILD_REASON_CODES, VALIDATION_REASON_CODES } from "./reason-codes.ts";
import type {
	BlockedReasonCode,
	ValidationReasonCode,
} from "./reason-codes.ts";

export const LIMITS_VIEW_V2 = Object.freeze({
	/** `evidence.hits` の件数上限（`LIMITS_RECALL.maxLimit` と同じ）。 */
	maxEvidenceHits: 50,
	/** `evidence.maxEvidenceBytes` の上限。 */
	maxEvidenceBytes: 65536,
	/** 1 件の evidence snippet の上限（byte）。 */
	maxEvidenceSnippetBytes: 256,
	/** coverage.omitted の要素数上限（v2 は kind 別 1 要素ずつなので小さい）。 */
	maxCoverageOmitted: 16,
});

/** v1 の kind（goal / decision / open_question）+ State 由来 4 種。`other_person_note` は view に入らない。 */
export const ITEM_KINDS_V2 = Object.freeze([
	"goal",
	"decision",
	"open_question",
	"preference",
	"personal_fact",
	"constraint",
	"habit",
] as const);
export type ItemKindV2 = (typeof ITEM_KINDS_V2)[number];

export const ITEM_ORIGINS_V2 = Object.freeze([
	"user_confirmed",
	"user_edited",
	"admitted_extraction",
] as const);
export type ItemOriginV2 = (typeof ITEM_ORIGINS_V2)[number];

/**
 * v2 の build / validate reasonCode。v1 の全要素を同順で含み、v2 で追加する要素は S0 時点で無い
 * （evidence は既存の SOURCE_* / BUDGET_EXCEEDED で表す）。追加が必要になったら末尾に足す
 * （v1 のタプルは変更しない）。v1 結果に v2 専用コードは出ない。
 */
export const BUILD_V2_REASON_CODES = Object.freeze([
	...BUILD_REASON_CODES,
] as const);
export const VALIDATION_V2_REASON_CODES = Object.freeze([
	...VALIDATION_REASON_CODES,
] as const);
export type BuildV2ReasonCode = (typeof BUILD_V2_REASON_CODES)[number];
export type ValidationV2ReasonCode =
	(typeof VALIDATION_V2_REASON_CODES)[number];

export interface MemoryItemV2 {
	readonly id: string;
	readonly revision: string;
	readonly kind: ItemKindV2;
	/**
	 * view にそのまま載る本文。State 由来の否定値（polarity negated）は `readMemorySnapshotPart` が
	 * `NOT: ` を前置して表す（view の item は polarity を持たないため）。肯定値が偶然 `NOT: ` で始まっても
	 * 意味は同じ否定になるので曖昧さによる害はない。
	 */
	readonly text: string;
	readonly status: ItemStatus;
	readonly origin: ItemOriginV2;
	readonly primarySource: SourceRef;
	readonly dependencies: readonly SourceRef[];
	/** 省略時は `self` 扱い。`self` 以外は view に入らない。 */
	readonly subject?: Subject;
}

export interface SnapshotV2 {
	readonly principal: string;
	readonly scopeKey: string;
	readonly stateRevision: string;
	readonly policyRevision: string;
	readonly complete: boolean;
	readonly sources: readonly SourceState[];
	readonly items: readonly MemoryItemV2[];
}

export interface ViewEvidenceInput {
	/** すべて `snapshot.scopeKey` のヒット。別 scope のヒットは MemoryContractError(INVALID_VALUE)。 */
	readonly hits: readonly RecallHit[];
	/** evidence 全体の予算（UTF-8 byte、`LIMITS_VIEW_V2.maxEvidenceBytes` 以下）。 */
	readonly maxEvidenceBytes: number;
}

export interface BuildMemoryViewInputV2 {
	readonly schemaVersion: 2;
	readonly access: AccessContext;
	readonly snapshot: SnapshotV2;
	readonly maxBytes: number;
	readonly enabled: boolean;
	readonly evidence?: ViewEvidenceInput;
}

export interface ValidationCurrentV2 {
	readonly schemaVersion: 2;
	readonly access: AccessContext;
	readonly snapshot: SnapshotV2;
}

export interface ViewItemV2 {
	readonly id: string;
	readonly revision: string;
	readonly kind: ItemKindV2;
	readonly status: "active";
	readonly origin: ItemOriginV2;
	readonly text: string;
	readonly primarySource: SourceRef;
	readonly dependencies: readonly SourceRef[];
}

/** view に載る根拠候補。事実ではない（`authority` は常に `evidence_candidate`）。 */
export interface ViewEvidence {
	readonly ref: SourceRef;
	readonly snippet: string;
	readonly authority: "evidence_candidate";
}

export interface ViewCoverageOmittedV2 {
	readonly type: "evidence";
	readonly count: number;
}

export interface ViewCoverageV2 {
	readonly complete: boolean;
	readonly omitted: readonly ViewCoverageOmittedV2[];
}

interface ViewHeaderV2 {
	readonly schemaVersion: 2;
	readonly principal: string;
	readonly scopeKey: string;
	readonly purpose: string;
	readonly stateRevision: string;
	readonly policyRevision: string;
	readonly instructionAuthority: InstructionAuthority;
}

export interface ReadyMemoryViewV2 extends ViewHeaderV2 {
	readonly status: "ready";
	readonly items: readonly ViewItemV2[];
	readonly evidence: readonly ViewEvidence[];
	readonly dependencies: readonly SourceDependency[];
	readonly coverage: ViewCoverageV2;
	readonly viewDigest: string;
}

export interface BlockedMemoryViewV2 extends ViewHeaderV2 {
	readonly status: "blocked";
	readonly reasonCode: BlockedReasonCode;
}

export interface OverflowMemoryViewV2 extends ViewHeaderV2 {
	readonly status: "overflow";
	readonly reasonCode: "BUDGET_EXCEEDED";
}

export interface DisabledMemoryViewV2 extends ViewHeaderV2 {
	readonly status: "disabled";
	readonly reasonCode: "MEMORY_DISABLED";
}

export type MemoryViewV2 =
	| ReadyMemoryViewV2
	| BlockedMemoryViewV2
	| OverflowMemoryViewV2
	| DisabledMemoryViewV2;

export type MemoryViewValidationV2 =
	| {
			readonly schemaVersion: 2;
			readonly status: "valid";
			readonly viewDigest: string;
	  }
	| {
			readonly schemaVersion: 2;
			readonly status: "invalid";
			readonly reasonCode: ValidationReasonCode;
	  };
