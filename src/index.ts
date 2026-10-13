export { LIMITS } from "./contracts/constants.ts";
export { SOURCE_STATUSES } from "./contracts/constants.ts";
export {
	CONTRACT_ERROR_CODES,
	MemoryContractError,
	isMemoryContractError,
} from "./contracts/errors.ts";
export type { ContractErrorCode } from "./contracts/errors.ts";
export type {
	AccessContext,
	ByteRange,
	SourceRef,
	SourceState,
	SourceStatus,
} from "./contracts/types.ts";

// ---- family 契約（型・定数・上限。実行ロジックは持たない）----
export * from "./contracts/common.ts";
export * from "./contracts/versions.ts";
export * from "./domains/records/contracts/index.ts";
export type * from "./domains/records/contracts/retention.ts";
export * from "./domains/state/contracts/index.ts";
export * from "./domains/lifecycle/contracts/index.ts";
export * from "./contracts/external.ts";

// ---- 純粋部品 ----
export { sliceUtf8Range } from "./domains/records/index.ts";
export { verifyForgetJournal } from "./domains/lifecycle/index.ts";

// ---- 時間 ----
export * from "./domains/temporal/contracts/index.ts";
export {
	TemporalError,
	classifyValidity,
	periodFromStateMs,
} from "./domains/temporal/index.ts";
