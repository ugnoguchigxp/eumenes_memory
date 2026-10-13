export type SourceStatus = "available" | "missing" | "changed" | "forgotten";

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

/** 参照する出典（期待する版・digest・任意の引用範囲）。 */
export interface SourceRef {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
	readonly revision: string;
	readonly digest: string;
	readonly range?: ByteRange;
}

/** 出典の現在状態（range は持たない）。 */
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
