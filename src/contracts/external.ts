/**
 * 外部ドメインとの接続部の契約（ユーザー決定 2026-10-08: World 等は別ドメイン・別 repo）。
 * 本体は外部ドメインの型・表を持たず、次の 2 つの薄い接続だけを提供する。
 *
 * (a) ExternalDependent: 外部派生物が忘却閉包に参加する。memory の依存辺に node 種別 `external` で
 *     登録し、forget の閉包に入ると `pending` / `unverified` の外部削除として ForgetReceipt に返る。
 *     外部派生物の識別は `(providerRef, externalId)`。依存辺の dependent_id は
 *     `providerRef + ":" + externalId`（providerRef は `:` を含まない名前トークンなので一意に分解できる）。
 *     役割（role）は常に `derived_from`。登録は置き換え（同じ dependent を再登録すると dependsOn が置換される）。
 * (b) 変更フィード: 外部ドメインが本体の変化を取り込む読み取り専用フィード `listMemoryChanges`。
 *     外部は ID と版だけを受け取り、本文は別 API（readRecord / listState など）で読む。
 *     フィードに本文・value は載らない。forgotten も ID と状態だけで通知する。
 *
 * 実装: フィードの書き込み側 `appendMemoryChange` と `listMemoryChanges` は S0（0001 foundation）。
 * 各 family（records / state / lifecycle）は自分の変更のたびに `appendMemoryChange` を呼ぶ。
 * ExternalDependent の登録 API（register / unregister）と外部削除の記録（`recordExternalDeletion`）は S6。
 */
import type { AccessContext } from "./types.ts";
import type {
	ContractVersion,
	ScopedWrite,
	StoreAccessReasonCode,
} from "./common.ts";

export const LIMITS_EXTERNAL = Object.freeze({
	maxProviderRefBytes: 64,
	maxExternalIdBytes: 256,
	/** 1 つの dependent が持てる依存先の数（M0 の LIMITS.maxDependenciesPerItem と同じ）。 */
	maxDependenciesPerDependent: 32,
	maxDependentsPerCall: 256,
	minChangesPerPage: 1,
	maxChangesPerPage: 500,
});

/** 外部派生物が依存できる本体の対象。`source` の id は SourceKey（Records の出典も会話の出典も同じ形）。 */
export const EXTERNAL_DEPENDENCY_TYPES = Object.freeze([
	"source",
	"state_item",
] as const);
export type ExternalDependencyType = (typeof EXTERNAL_DEPENDENCY_TYPES)[number];

export interface ExternalDependencyRef {
	readonly type: ExternalDependencyType;
	readonly id: string;
}

export interface ExternalDependent {
	/** 外部ドメインの識別子（名前トークン、`:` を含まない）。忘却の外部削除確認の単位でもある。 */
	readonly providerRef: string;
	/** 外部ドメイン内の派生物 ID（不透明）。 */
	readonly externalId: string;
	readonly dependsOn: readonly ExternalDependencyRef[];
}

export interface ExternalDependentKey {
	readonly providerRef: string;
	readonly externalId: string;
}

export const EXTERNAL_REJECTED_REASON_CODES = Object.freeze([
	/** 依存先が忘却済み（墓標あり）。忘却済みのものから新たに派生させない。 */
	"TOMBSTONED",
	/** `state_item` の依存先が存在しない（この principal / scope のものでない場合を含む）。 */
	"DEPENDENCY_MISSING",
	/** 同じ `(providerRef, externalId)` が別の principal / scope で登録済み（置き換えは同じ scope の中だけ）。 */
	"EXTERNAL_ID_IN_USE",
] as const);
export type ExternalRejectedReasonCode =
	(typeof EXTERNAL_REJECTED_REASON_CODES)[number];

export interface RegisterExternalDependentsInput extends ScopedWrite {
	readonly dependents: readonly ExternalDependent[];
}

export type RegisterExternalDependentsResult =
	| {
			readonly status: "registered";
			readonly registered: number;
			readonly unchanged: number;
	  }
	| {
			readonly status: "rejected";
			readonly reasonCode: ExternalRejectedReasonCode;
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

/** 外部が自分で派生物を削除・再構築した場合の登録解除（忘却ではない。墓標・ジャーナルを作らない）。 */
export interface UnregisterExternalDependentsInput extends ScopedWrite {
	readonly dependents: readonly ExternalDependentKey[];
}

export type UnregisterExternalDependentsResult =
	| { readonly status: "unregistered"; readonly removed: number }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

// ---- 変更フィード ----

/** フィードに載る対象。`source` は忘却された host_source（SourceKey）の通知専用。 */
export const MEMORY_CHANGE_TARGET_TYPES = Object.freeze([
	"record",
	"state_item",
	"source",
] as const);
export type MemoryChangeTargetType =
	(typeof MEMORY_CHANGE_TARGET_TYPES)[number];

/**
 * 変更後の状態。record は active / inactive / forgotten、state_item は state の全 status、
 * source は forgotten のみ。
 */
export const MEMORY_CHANGE_STATUSES = Object.freeze([
	"active",
	"inactive",
	"superseded",
	"disputed",
	"retracted",
	"invalidated",
	"forgotten",
] as const);
export type MemoryChangeStatus = (typeof MEMORY_CHANGE_STATUSES)[number];

export interface MemoryChange {
	/** 単調増加で一意（`memory_seq` 由来）。連続とは限らない。 */
	readonly seq: number;
	readonly atMs: number;
	readonly scopeKey: string;
	readonly targetType: MemoryChangeTargetType;
	readonly targetId: string;
	/** record: `sha256:<hex>`、state_item: `String(revision)`。forgotten・source は null。 */
	readonly revision: string | null;
	readonly status: MemoryChangeStatus;
	/** status が forgotten のときの `forgetId`、それ以外は null。 */
	readonly forgetId: string | null;
}

/** 書き込み側（`appendMemoryChange`）が受ける変更。seq は appendMemoryChange が発行する。 */
export type MemoryChangeDraft = Omit<MemoryChange, "seq"> & {
	readonly principal: string;
};

export interface ListMemoryChangesInput {
	readonly contractVersion: ContractVersion;
	readonly access: AccessContext;
	/** `access.scopeKeys` の部分集合でなければ `blocked`。 */
	readonly scopeKeys: readonly string[];
	/** この seq より大きい変更を seq 昇順で返す（0 で先頭から）。 */
	readonly afterSeq: number;
	readonly limit: number;
}

/**
 * `nextAfterSeq` = 返した最後の変更の seq（なければ入力の afterSeq）。`hasMore` が true なら
 * 続きがある（同じ条件で `afterSeq = nextAfterSeq` として再呼び出し）。
 * 複数の読み取りにまたがる一貫性はホストの read transaction に依存する。
 */
export type ListMemoryChangesResult =
	| {
			readonly status: "ok";
			readonly changes: readonly MemoryChange[];
			readonly nextAfterSeq: number;
			readonly hasMore: boolean;
	  }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };
