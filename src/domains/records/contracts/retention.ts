import type {
	CaptureRecordInput,
	CaptureRecordResult,
	ReadRecordResult,
} from "./index.ts";
import type { ScopedWrite } from "../../../contracts/common.ts";

/** Optional, regenerable Records. Ordinary Records never acquire a retention policy implicitly. */
export interface RetainRecordInput {
	readonly record: CaptureRecordInput;
	readonly freshUntilMs: number;
	readonly idleTtlMs: number;
}
export interface RetainedRecordRead extends ScopedWrite {
	readonly recordId: string;
}
export type RetainRecordResult = CaptureRecordResult & {
	readonly retentionRevision?: number;
};
export type RetainedRecordResult =
	| { readonly status: "miss" }
	| {
			readonly status: "available";
			readonly record: Extract<ReadRecordResult, { status: "available" }>;
			readonly freshUntilMs: number;
			readonly idleExpiresAtMs: number;
			readonly retentionRevision: number;
	  };
export interface RetainedRecordUse extends RetainedRecordRead {
	readonly retentionRevision: number;
}
export interface EvictRetainedInput extends ScopedWrite {
	readonly limit: number;
	/** Restrict eviction to one owned record (e.g. a now-uncacheable response). */
	readonly recordId?: string;
	/** Evict oldest entries even before their idle expiry (capacity control / explicit cache clear). */
	readonly oldest?: boolean;
}
export interface RetainedRecordStats {
	readonly entries: number;
	readonly bytes: number;
}
