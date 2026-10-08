/**
 * 全 family 共通の契約（full-system-design §3.1）。型と定数だけで実行ロジックを持たない。
 * このファイルを含む `src/contracts/**` の型・reasonCode・LIMITS は親担当だけが編集する。
 */
import type { AccessContext, SourceRef } from "./types.ts";

/** M0 の `sourceKey(ref)` が返す文字列（JSON 配列表現）。依存辺・墓標・進捗の ID に使う。 */
export type SourceKey = string;

/** 文字列を複製せずに family 入力で「契約版 1」を表す。値は `CONTRACT_VERSIONS` と一致する。 */
export type ContractVersion = 1;

/** 引用つきの根拠。`quote` は `source.range` の bytes を UTF-8 decode した文字列と完全一致する。 */
export interface EvidenceSpan {
	readonly source: SourceRef;
	readonly quote: string;
}

/** ホストが渡す時刻。安全な整数のミリ秒。順序判定には使わず、表示・期限判定だけに使う。 */
export interface HostClock {
	readonly atMs: number;
}

/** ホスト queue の値。Memory は lease を見ず、attempt の大小も比較しない。 */
export interface RunRef {
	readonly jobId: string;
	readonly attempt: number;
}

export type Subject = "self" | `other:${string}` | "unknown";
/** 台帳に載る subject。`unknown` は台帳に載らない。 */
export type StateSubject = "self" | `other:${string}`;

export const POLARITIES = Object.freeze(["affirmed", "negated"] as const);
export type Polarity = (typeof POLARITIES)[number];

export const MODALITIES = Object.freeze([
	"asserted",
	"hypothetical",
	"quoted",
	"reported",
	"question",
] as const);
export type Modality = (typeof MODALITIES)[number];

export const TEMPORALS = Object.freeze([
	"current",
	"past",
	"future",
	"unspecified",
] as const);
export type Temporal = (typeof TEMPORALS)[number];

/** 出典となる発言・取得物の役割。ホストが付与する。 */
export const SOURCE_ROLES = Object.freeze([
	"user",
	"assistant",
	"tool",
] as const);
export type SourceRole = (typeof SOURCE_ROLES)[number];

/**
 * scope に紐づく永続 API の共通入力ヘッダー。`access.scopeKeys` に `scopeKey` が
 * 含まれなければ、その API は例外ではなく `blocked` 系の結果を返す。
 */
export interface ScopedRead {
	readonly contractVersion: ContractVersion;
	readonly access: AccessContext;
	readonly scopeKey: string;
}

/** 書き込み系は `clock` を必須とする（ホストの transaction 内で呼ぶ）。 */
export interface ScopedWrite extends ScopedRead {
	readonly clock: HostClock;
}

/** 永続 API が access 検査で返す reasonCode（family 共通）。 */
export const STORE_ACCESS_REASON_CODES = Object.freeze([
	"SCOPE_NOT_PERMITTED",
] as const);
export type StoreAccessReasonCode = (typeof STORE_ACCESS_REASON_CODES)[number];

/** 永続 API が対象を見つけられない／権限がない場合の共通状態（本文・ID を含めない）。 */
export type MissingStatus = "missing" | "forgotten" | "not_permitted";

/** JSON 化できる値（モデル向け素材・schema の型）。 */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/**
 * 本体が host の中立な出典として扱う、Memory 所有出典の SourceRef の固定値
 * （Records: namespace `memory`, kind `record`, id = recordId, representation `text`）。
 */
export const MEMORY_SOURCE_NAMESPACE = "memory" as const;
export const MEMORY_RECORD_SOURCE_KIND = "record" as const;
export const MEMORY_RECORD_REPRESENTATION = "text" as const;
