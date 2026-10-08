import type {
	BlockedReasonCode,
	ValidationReasonCode,
} from "./reason-codes.ts";

export type SchemaVersion = 1;
export type ItemKind = "goal" | "decision" | "open_question";
export type ItemStatus = "active" | "inactive";
export type ItemOrigin = "user_confirmed" | "user_edited";
export type SourceStatus = "available" | "missing" | "changed" | "forgotten";
export type InstructionAuthority = "none";

export interface AccessContext {
	readonly principal: string;
	readonly scopeKeys: readonly string[];
	readonly purpose: string;
	readonly policyRevision: string;
}

/** 半開区間 [startByte, endByte)。startByte < endByte。 */
export interface ByteRange {
	readonly startByte: number;
	readonly endByte: number;
}

/** item が参照する出典（期待する版・digest・任意の引用範囲）。 */
export interface SourceRef {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
	readonly revision: string;
	readonly digest: string;
	readonly range?: ByteRange;
}

/** snapshot が持つ出典の現在状態（range は持たない）。 */
export interface SourceState {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
	readonly revision: string;
	readonly digest: string;
	readonly principal: string;
	readonly scopeKey: string;
	readonly status: SourceStatus;
	readonly content?: string;
}

export interface MemoryItem {
	readonly id: string;
	readonly revision: string;
	readonly kind: ItemKind;
	readonly text: string;
	readonly status: ItemStatus;
	readonly origin: ItemOrigin;
	readonly primarySource: SourceRef;
	readonly dependencies: readonly SourceRef[];
}

export interface Snapshot {
	readonly principal: string;
	readonly scopeKey: string;
	readonly stateRevision: string;
	readonly policyRevision: string;
	readonly complete: boolean;
	readonly sources: readonly SourceState[];
	readonly items: readonly MemoryItem[];
}

export interface BuildMemoryViewInput {
	readonly schemaVersion: SchemaVersion;
	readonly access: AccessContext;
	readonly snapshot: Snapshot;
	readonly maxBytes: number;
	readonly enabled: boolean;
}

export interface ValidationCurrent {
	readonly schemaVersion: SchemaVersion;
	readonly access: AccessContext;
	readonly snapshot: Snapshot;
}

// ---- 出力 ----

/** view 全体の依存一覧（range なし、出典単位で重複排除）。 */
export interface SourceDependency {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
	readonly revision: string;
	readonly digest: string;
}

export interface ViewItem {
	readonly id: string;
	readonly revision: string;
	readonly kind: ItemKind;
	readonly status: "active";
	readonly origin: ItemOrigin;
	readonly text: string;
	readonly primarySource: SourceRef;
	readonly dependencies: readonly SourceRef[];
}

export interface ViewCoverage {
	readonly complete: true;
	readonly omitted: readonly never[];
}

interface ViewHeader {
	readonly schemaVersion: SchemaVersion;
	readonly principal: string;
	readonly scopeKey: string;
	readonly purpose: string;
	readonly stateRevision: string;
	readonly policyRevision: string;
	readonly instructionAuthority: InstructionAuthority;
}

export interface ReadyMemoryView extends ViewHeader {
	readonly status: "ready";
	readonly items: readonly ViewItem[];
	readonly dependencies: readonly SourceDependency[];
	readonly coverage: ViewCoverage;
	readonly viewDigest: string;
}

export interface BlockedMemoryView extends ViewHeader {
	readonly status: "blocked";
	readonly reasonCode: BlockedReasonCode;
}

export interface OverflowMemoryView extends ViewHeader {
	readonly status: "overflow";
	readonly reasonCode: "BUDGET_EXCEEDED";
}

export interface DisabledMemoryView extends ViewHeader {
	readonly status: "disabled";
	readonly reasonCode: "MEMORY_DISABLED";
}

export type MemoryView =
	| ReadyMemoryView
	| BlockedMemoryView
	| OverflowMemoryView
	| DisabledMemoryView;

export type MemoryViewValidation =
	| {
			readonly schemaVersion: SchemaVersion;
			readonly status: "valid";
			readonly viewDigest: string;
	  }
	| {
			readonly schemaVersion: SchemaVersion;
			readonly status: "invalid";
			readonly reasonCode: ValidationReasonCode;
	  };
