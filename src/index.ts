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
export { validateMemoryView } from "./validation/validate.ts";
export { buildMemoryView } from "./view/build.ts";

// ---- View v2（schemaVersion 2。v1 の関数・型・挙動は上のまま変わらない）----
export {
	parseBuildMemoryViewInputV2,
	parseMemoryViewV2,
	parseValidationCurrentV2,
} from "./contracts/parse-v2.ts";
export { validateMemoryViewV2 } from "./validation/validate-v2.ts";
export { buildMemoryViewV2 } from "./view/build-v2.ts";
export { composeSnapshotV2 } from "./view/snapshot-v2.ts";
export type {
	ComposeSnapshotV2Input,
	ContinuityPartV2,
	MemoryPartV2,
} from "./view/snapshot-v2.ts";

// ---- 全体設計（S0 で確定した family 契約。型・定数のみで実行ロジックは持たない）----
export * from "./contracts/common.ts";
export * from "./contracts/versions.ts";
export * from "./contracts/records.ts";
export * from "./contracts/recall.ts";
export * from "./contracts/view-v2.ts";
export * from "./contracts/state.ts";
export * from "./contracts/extraction.ts";
export * from "./contracts/lifecycle.ts";
export * from "./contracts/external.ts";

// ---- 純粋部品（S1〜S5）----
export { sliceUtf8Range } from "./evidence/range.ts";
export { verifyForgetJournal } from "./lifecycle/journal.ts";
export {
	candidateValue,
	effectiveCandidateKind,
	evaluateAdmission,
} from "./state/admission.ts";
export type { AdmissionCandidate, AdmissionInput } from "./state/admission.ts";
export {
	checkEvidence,
	evidenceOrdinalOf,
	isQuotedSpan,
	quoteMatches,
} from "./state/evidence.ts";
export { stateItemId } from "./state/ids.ts";
export {
	applyStateTransition,
	isSubjectKindConsistent,
} from "./state/reducer.ts";
export type {
	StateItemIdentity,
	StateTransitionRequest,
} from "./state/reducer.ts";
export { stateValueEquals } from "./state/value.ts";
export { parseExtractionOutput } from "./extraction/candidate.ts";
export type { ParsedExtractionOutput } from "./extraction/candidate.ts";
export { candidateIdOf, runIdOf } from "./extraction/ids.ts";
export { buildExtractionPromptMaterial } from "./extraction/prompt.ts";
