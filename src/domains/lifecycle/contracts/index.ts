/**
 * Lifecycle / Forget の契約。
 *
 * 規則（S1 / S6 実装者はこの JSDoc を契約として扱う）:
 * - 忘却は 2 相。`planForget`（read のみ）→ ホストがジャーナルへ追記して fsync → `applyForget`（write）。
 *   順序はジャーナル先行。`applyForget` は entry を要求するので「DB にあるがジャーナルにない」は起きない。
 * - ジャーナル entry の hash 規則:
 *   `hash = sha256Hex(canonicalJson({ journalFormat, seq, prevHash, forgetId, principal, targets }))`、
 *   `forgetId = "forget:" + sha256Hex(canonicalJson({ principal, seq, targets }))`。
 *   最初の entry の `prevHash` は `GENESIS_JOURNAL_HASH`。`seq` は 1 始まりで連続。
 *   `targets` は (type, scopeKey, id) の UTF-16 コード単位順に整列し重複を除く。entry は本文・digest を含まない。
 * - `planForget` が付ける `seq` / `prevHash` は DB の `memory_journal_state` の head の次。ホストは
 *   plan → 追記 → apply を直列化し、起動時に必ず `reconcileForgetJournal` を済ませる。
 * - `applyForget` は冪等で、墓標の有無に関係なく本文削除・閉包の無効化を毎回行う。
 *   閉包は apply 時点で再計算する（plan 後に増えた派生物も漏らさない）。`enabled` に依存しない。
 *   `seq <= head` の entry は、DB に同じ `forgetId` / `hash` があれば再適用（結果は同一）、
 *   無い／異なるなら `MemoryStoreError("JOURNAL_ENTRY_INVALID")`。head の次でない新規 entry も同じ。
 * - 閉包は `memory_dependency` を dependency → dependent 方向に推移的に辿る。閉包内の各行は本文 / value / payload を NULL にし
 *   status を `forgotten`、墓標を挿入、関係 scope の revision を +1、変更フィードに `forgotten` を追記する。
 * - `record` の forget は tombstone を `("record", recordId)` と `("source", sourceKey)` の 2 つ書く。
 * - 閉包の起点: `host_source` はその SourceKey、`state_item` はその item、
 *   `scope` は scope の record の出典キーと scope の state_item / external。
 *   `host_source` の SourceKey が Records の record のものなら、その record も忘れる。
 * - 閉包内の値の消去: state_item は value / polarity / 有効期間を NULL・semantic_key を ''・attribute と evidence の行を削除・
 *   event は action と seq だけ残す。依存辺は残す（再適用の入力）。
 * - 外部削除の確認: 外部へ送った record の `providerRef` と閉包内の外部派生物を
 *   `memory_forget_external` に `pending` で載せる。`recordExternalDeletion` は最後に記録した状態が有効。
 *   scope の forget は、他の scope も引用している出典には墓標を付けない。
 * - deactivate は forget ではない（墓標・ジャーナル・ForgetReceipt を作らない）。API 名・reason・文言で
 *   「忘却」「削除」と呼ばない。
 */
import type { AccessContext } from "../../../contracts/types.ts";
import type {
	ContractVersion,
	HostClock,
	SourceKey,
	StoreAccessReasonCode,
} from "../../../contracts/common.ts";

export const LIMITS_LIFECYCLE = Object.freeze({
	/** ジャーナル entry の targets 件数上限。 */
	maxJournalTargets: 64,
	/** reconcile / verify に渡せる entry 数。 */
	maxJournalEntries: 100000,
	maxProviderRefBytes: 64,
	maxExternalIdBytes: 256,
});

export const JOURNAL_FORMAT = 1 as const;
/** ジャーナルの先頭 entry の `prevHash`、および DB の初期 head hash（SHA-256 hex 長の 0 埋め）。 */
export const GENESIS_JOURNAL_HASH =
	"0000000000000000000000000000000000000000000000000000000000000000" as const;

export const FORGET_TARGET_TYPES = Object.freeze([
	"record",
	"host_source",
	"state_item",
	"scope",
] as const);
export type ForgetTargetType = (typeof FORGET_TARGET_TYPES)[number];

import {
	DEPENDENCY_ROLES,
	type DependencyRole,
	DEPENDENT_NODE_TYPES,
	type DependentNodeType,
	DEPENDENCY_NODE_TYPES,
	type DependencyNodeType,
	TOMBSTONE_TARGET_TYPES,
	type TombstoneTargetType,
} from "../../../contracts/dependency.ts";
export {
	DEPENDENCY_ROLES,
	type DependencyRole,
	DEPENDENT_NODE_TYPES,
	type DependentNodeType,
	DEPENDENCY_NODE_TYPES,
	type DependencyNodeType,
	TOMBSTONE_TARGET_TYPES,
	type TombstoneTargetType,
};
/**
 * 外部削除の確認状況。外部に送った／外部が派生させたデータの削除は Memory からは確認できない。
 * 確認手段がなければホストが `unverified` を記録する（完了とは言わない）。
 */
export const EXTERNAL_DELETION_STATES = Object.freeze([
	"pending",
	"unverified",
	"confirmed",
	"failed",
] as const);
export type ExternalDeletionState = (typeof EXTERNAL_DELETION_STATES)[number];

/**
 * ForgetReceipt.external の集約値: 外部削除が無ければ `none`。あれば
 * any failed → `failed`、any pending → `pending`、any unverified → `unverified`、全 confirmed → `confirmed`。
 */
export const FORGET_EXTERNAL_STATES = Object.freeze([
	"none",
	...EXTERNAL_DELETION_STATES,
] as const);
export type ForgetExternalState = (typeof FORGET_EXTERNAL_STATES)[number];

export const JOURNAL_REASON_CODES = Object.freeze([
	"JOURNAL_TRUNCATED",
	"JOURNAL_CHAIN_BROKEN",
	"JOURNAL_MISSING",
] as const);
export type JournalReasonCode = (typeof JOURNAL_REASON_CODES)[number];

/** 環境依存なし（entry 単体では判定できない切り詰め・欠落は reconcile だけが返す）。 */
export type JournalVerificationReasonCode = "JOURNAL_CHAIN_BROKEN";

export type ForgetTarget =
	| {
			readonly type: "record";
			readonly recordId: string;
			readonly scopeKey: string;
	  }
	| {
			readonly type: "host_source";
			readonly sourceKey: SourceKey;
			readonly scopeKey: string;
	  }
	| {
			readonly type: "state_item";
			readonly itemId: string;
			readonly scopeKey: string;
	  }
	| { readonly type: "scope"; readonly scopeKey: string };

export interface ForgetJournalTarget {
	readonly type: ForgetTargetType;
	/** record: recordId、host_source: SourceKey、state_item: itemId、scope: scopeKey。 */
	readonly id: string;
	readonly scopeKey: string;
}

export interface ForgetJournalEntry {
	readonly journalFormat: typeof JOURNAL_FORMAT;
	readonly seq: number;
	readonly prevHash: string;
	readonly forgetId: string;
	readonly principal: string;
	readonly targets: readonly ForgetJournalTarget[];
	readonly hash: string;
}

export interface ExternalDeletion {
	readonly providerRef: string;
	/** 外部派生物（`ExternalDependent`）単位なら externalId、プロバイダー単位（外部へ送った record の送付先）なら null。 */
	readonly externalId: string | null;
	readonly state: ExternalDeletionState;
}

/** completed = local が applied かつ external ∈ {none, confirmed}。 */
export interface ForgetReceipt {
	readonly forgetId: string;
	readonly local: "applied";
	readonly external: ForgetExternalState;
	readonly externalDeletions: readonly ExternalDeletion[];
	readonly completed: boolean;
}

export interface ForgetPlan {
	readonly entry: ForgetJournalEntry;
	/** 閉包に入る行数（node type 別）。本文・ID を含めない。 */
	readonly closure: { readonly counts: Readonly<Record<string, number>> };
	/** 閉包内の record を外部へ送ったプロバイダー（`providerRef`）。 */
	readonly externalProviders: readonly string[];
	/** 閉包に入る外部派生物（ExternalDependent）。apply 後に `pending` として返る。 */
	readonly externalDependents: readonly {
		readonly providerRef: string;
		readonly externalId: string;
	}[];
}

export interface PlanForgetInput {
	readonly contractVersion: ContractVersion;
	readonly access: AccessContext;
	readonly target: ForgetTarget;
	readonly clock: HostClock;
}

export type PlanForgetResult =
	| { readonly status: "planned"; readonly plan: ForgetPlan }
	| { readonly status: "blocked"; readonly reasonCode: StoreAccessReasonCode };

export interface ApplyForgetInput {
	readonly contractVersion: ContractVersion;
	readonly entry: ForgetJournalEntry;
	readonly clock: HostClock;
}

export interface ReconcileForgetJournalInput {
	readonly contractVersion: ContractVersion;
	readonly entries: readonly ForgetJournalEntry[];
	readonly clock: HostClock;
}

/**
 * `inconsistent` を受けたホストは Memory の読み出し・抽出を止める（fail closed）。
 *
 * `reapplied > 0` は、DB がジャーナルより古かった（バックアップからの復元など）ことを意味する。復元で失われた期間の
 * `memory_seq` と変更フィード（`listMemoryChanges`）の番号は巻き戻り、再適用した忘却の通知は「古い番号」に並び直される
 * ため、巻き戻り前のカーソル（`afterSeq`）を持つ購読者は忘却通知を取りこぼす。そのため `reapplied > 0` のとき
 * `feedResyncRequired: true` を返す。購読者（外部ドメイン）は保存済みのカーソルを破棄し、`afterSeq` なしで全再同期する。
 * 限界: `reapplied === 0` でも、ジャーナルに forget が無いまま DB だけを過去へ戻した場合は番号が巻き戻りうる（本体は検出できない）。
 * DB を復元したホストは、この値に関わらず購読者のカーソルを破棄する。
 */
export type ReconcileForgetJournalResult =
	| {
			readonly status: "ok";
			readonly reapplied: number;
			/** `reapplied > 0` のときだけ `true`（それ以外は省略）。変更フィードの購読者は全再同期する。 */
			readonly feedResyncRequired?: true;
	  }
	| {
			readonly status: "inconsistent";
			readonly reasonCode: JournalReasonCode;
	  };

/** 純粋関数 `verifyForgetJournal(entries)` の結果（S1 が `src/domains/lifecycle/service/` に実装し `.` から export する）。 */
export type VerifyForgetJournalResult =
	| {
			readonly status: "ok";
			readonly head: { readonly seq: number; readonly hash: string } | null;
	  }
	| {
			readonly status: "inconsistent";
			readonly reasonCode: JournalVerificationReasonCode;
	  };

export interface RecordExternalDeletionInput {
	readonly contractVersion: ContractVersion;
	readonly access: AccessContext;
	readonly clock: HostClock;
	readonly forgetId: string;
	readonly providerRef: string;
	/** 省略時は、その forget に登録された `providerRef` の全行が対象。 */
	readonly externalId?: string;
	readonly state: Exclude<ExternalDeletionState, "pending">;
}

export type RecordExternalDeletionResult =
	| { readonly status: "recorded"; readonly receipt: ForgetReceipt }
	| {
			readonly status: "missing" | "not_permitted" | "unknown_provider";
	  };

export interface GetForgetReceiptInput {
	readonly contractVersion: ContractVersion;
	readonly access: AccessContext;
	readonly forgetId: string;
}

export type GetForgetReceiptResult =
	| { readonly status: "found"; readonly receipt: ForgetReceipt }
	| { readonly status: "missing" | "not_permitted" };

// ---- 閉包（純粋、S1 が `src/domains/lifecycle/service/closure.ts` に実装）----

export interface ClosureEdge {
	readonly dependentType: DependentNodeType;
	readonly dependentId: string;
	readonly dependencyType: DependencyNodeType;
	readonly dependencyId: string;
	readonly role: DependencyRole;
}

export interface ClosureNodeRef {
	readonly type: DependencyNodeType | DependentNodeType;
	readonly id: string;
}
