export { SCHEMA_VERSION, LIMITS } from "./contracts/constants.ts";
export {
	ITEM_KINDS,
	ITEM_STATUSES,
	ITEM_ORIGINS,
	SOURCE_STATUSES,
} from "./contracts/constants.ts";
export {
	CONTRACT_ERROR_CODES,
	MemoryContractError,
	isMemoryContractError,
} from "./contracts/errors.ts";
export { parseBuildMemoryViewInput } from "./contracts/parse-input.ts";
export { parseValidationCurrent } from "./contracts/parse-input.ts";
export { parseMemoryView } from "./contracts/parse-view.ts";
export {
	BUILD_REASON_CODES,
	VALIDATION_REASON_CODES,
} from "./contracts/reason-codes.ts";
export type {
	AccessReasonCode,
	BlockedReasonCode,
	BuildReasonCode,
	SourceReasonCode,
	ValidationReasonCode,
} from "./contracts/reason-codes.ts";
export type { ContractErrorCode } from "./contracts/errors.ts";
export type {
	AccessContext,
	BlockedMemoryView,
	BuildMemoryViewInput,
	ByteRange,
	DisabledMemoryView,
	InstructionAuthority,
	ItemKind,
	ItemOrigin,
	ItemStatus,
	MemoryItem,
	MemoryView,
	MemoryViewValidation,
	OverflowMemoryView,
	ReadyMemoryView,
	SchemaVersion,
	Snapshot,
	SourceDependency,
	SourceRef,
	SourceState,
	SourceStatus,
	ValidationCurrent,
	ViewCoverage,
	ViewItem,
} from "./contracts/types.ts";
export { validateMemoryView } from "./domains/projection/index.ts";
export { buildMemoryView } from "./domains/projection/index.ts";

// ---- View v2（schemaVersion 2。v1 の関数・型・挙動は上のまま変わらない）----
export {
	parseBuildMemoryViewInputV2,
	parseMemoryViewV2,
	parseValidationCurrentV2,
} from "./domains/projection/contracts/parse-v2.ts";
export { validateMemoryViewV2 } from "./domains/projection/index.ts";
export { buildMemoryViewV2 } from "./domains/projection/index.ts";
export { composeSnapshotV2 } from "./domains/projection/index.ts";
export type {
	ComposeSnapshotV2Input,
	ContinuityPartV2,
	MemoryPartV2,
} from "./domains/projection/index.ts";

// ---- 全体設計（S0 で確定した family 契約。型・定数のみで実行ロジックは持たない）----
export * from "./contracts/common.ts";
export * from "./contracts/versions.ts";
export * from "./domains/records/contracts/index.ts";
export type * from "./domains/records/contracts/retention.ts";
export * from "./domains/recall/contracts/index.ts";
export * from "./contracts/view-v2.ts";
export * from "./domains/state/contracts/index.ts";
export * from "./domains/extraction/contracts/index.ts";
export * from "./domains/lifecycle/contracts/index.ts";
export * from "./contracts/external.ts";

// ---- 純粋部品（S1〜S5）----
export { sliceUtf8Range } from "./domains/records/index.ts";
export { verifyForgetJournal } from "./domains/lifecycle/index.ts";
export {
	candidateValue,
	effectiveCandidateKind,
	evaluateAdmission,
} from "./domains/state/index.ts";
export type {
	AdmissionCandidate,
	AdmissionInput,
} from "./domains/state/index.ts";
export {
	checkEvidence,
	evidenceOrdinalOf,
	isQuotedSpan,
	quoteMatches,
} from "./domains/state/index.ts";
export { stateItemId } from "./domains/state/index.ts";
export {
	applyStateTransition,
	isSubjectKindConsistent,
} from "./domains/state/index.ts";
export type {
	StateItemIdentity,
	StateTransitionRequest,
} from "./domains/state/index.ts";
export { stateValueEquals } from "./domains/state/index.ts";
export { parseExtractionOutput } from "./domains/extraction/index.ts";
export type { ParsedExtractionOutput } from "./domains/extraction/index.ts";
export { candidateIdOf, runIdOf } from "./domains/extraction/index.ts";
export { buildExtractionPromptMaterial } from "./domains/extraction/index.ts";

// ---- 時間と選択（evolution-proposal 段階2〜3の純粋部品）----
export * from "./domains/temporal/index.ts";
export * from "./domains/selection/index.ts";
