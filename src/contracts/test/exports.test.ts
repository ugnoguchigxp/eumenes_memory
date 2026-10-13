import { describe, expect, test } from "bun:test";

const EXPECTED_EXPORTS = [
	"ADMISSION_DECISIONS",
	"ADMISSION_MODES",
	"ADMISSION_REASON_CODES",
	"BUILD_REASON_CODES",
	"BUILD_V2_REASON_CODES",
	"CANDIDATE_DECISIONS",
	"CONFIRM_ACTIONS",
	"CONTRACT_ERROR_CODES",
	"CONTRACT_VERSIONS",
	"DATE_PRECISIONS",
	"DEFAULT_ADMISSION_POLICY",
	"DEPENDENCY_NODE_TYPES",
	"DEPENDENCY_ROLES",
	"DEPENDENT_NODE_TYPES",
	"EXTERNAL_DELETION_STATES",
	"EXTERNAL_DEPENDENCY_TYPES",
	"EXTERNAL_REJECTED_REASON_CODES",
	"EXTRACTION_REJECTED_OUTPUT_REASON_CODES",
	"EXTRACTION_RUN_STAGES",
	"EXTRACTION_SKIP_REASON_CODES",
	"EXTRACTION_STALE_REASON_CODES",
	"FORGET_EXTERNAL_STATES",
	"FORGET_TARGET_TYPES",
	"GENESIS_JOURNAL_HASH",
	"HOST_OWNED_KINDS",
	"HOST_STATE_ORIGINS",
	"ITEM_KINDS",
	"ITEM_KINDS_V2",
	"ITEM_ORIGINS",
	"ITEM_ORIGINS_V2",
	"ITEM_STATUSES",
	"JOURNAL_FORMAT",
	"JOURNAL_REASON_CODES",
	"LIMITS",
	"LIMITS_EXTERNAL",
	"LIMITS_EXTRACTION",
	"LIMITS_LIFECYCLE",
	"LIMITS_RECALL",
	"LIMITS_RECORDS",
	"LIMITS_STATE",
	"LIMITS_VIEW_V2",
	"MEMORY_CHANGE_STATUSES",
	"MEMORY_CHANGE_TARGET_TYPES",
	"MEMORY_RECORD_REPRESENTATION",
	"MEMORY_RECORD_SOURCE_KIND",
	"MEMORY_SOURCE_NAMESPACE",
	"MODALITIES",
	"MemoryContractError",
	"OMIT_REASONS",
	"POLARITIES",
	"RECALL_BLOCKED_REASON_CODES",
	"RECALL_STRATEGIES",
	"RECORD_BLOCKED_REASON_CODES",
	"RECORD_CAPTURE_STATES",
	"RECORD_MEDIA_TYPES",
	"RECORD_RANGE_REASON_CODES",
	"RECORD_STATUSES",
	"REQUIRED_REASONS",
	"RETRIEVAL_FLAGS",
	"REVALIDATION_REASONS",
	"SCHEMA_VERSION",
	"SCOPE_KINDS",
	"SOURCE_PROGRESS_STAGES",
	"SOURCE_ROLES",
	"SOURCE_STATUSES",
	"STATE_CAUSE_TYPES",
	"STATE_EVENT_ACTIONS",
	"STATE_ITEM_STATUSES",
	"STATE_KINDS",
	"STATE_ORIGINS",
	"STATE_REASON_CODES",
	"STORE_ACCESS_REASON_CODES",
	"TEMPORALS",
	"TOMBSTONE_TARGET_TYPES",
	"TemporalError",
	"USER_STATE_ORIGINS",
	"VALIDATION_REASON_CODES",
	"VALIDATION_V2_REASON_CODES",
	"VALIDITY_BASES",
	"VALIDITY_CLASSES",
	"VIEW_SCHEMA_VERSIONS",
	"answersQuery",
	"anyScopeTruncated",
	"applyStateTransition",
	"assertPartialDate",
	"buildExtractionPromptMaterial",
	"buildMemoryView",
	"buildMemoryViewV2",
	"buildPublicVersion",
	"candidateFromStateItem",
	"candidateIdOf",
	"candidateValue",
	"checkEvidence",
	"classifyValidity",
	"composeSnapshotV2",
	"decidePublication",
	"effectiveCandidateKind",
	"endExclusiveMs",
	"evaluateAdmission",
	"evaluateTime",
	"evidenceOrdinalOf",
	"formatPartialDate",
	"grantFromScope",
	"isMemoryContractError",
	"isQuotedSpan",
	"isSubjectKindConsistent",
	"parseBuildMemoryViewInput",
	"parseBuildMemoryViewInputV2",
	"parseExtractionOutput",
	"parseMemoryView",
	"parseMemoryViewV2",
	"parsePartialDate",
	"parseValidationCurrent",
	"parseValidationCurrentV2",
	"periodBoundsMs",
	"periodFromStateMs",
	"queryTargetMs",
	"quoteMatches",
	"requiredDigestOf",
	"revalidateUsage",
	"runIdOf",
	"selectContext",
	"sliceUtf8Range",
	"startOfMs",
	"stateItemId",
	"stateValueEquals",
	"validateCheckpoint",
	"validateMemoryView",
	"validateMemoryViewV2",
	"verifyForgetJournal",
];

describe("public runtime exports", () => {
	test("export list is exactly the documented surface", async () => {
		const exported = Object.keys(await import("../../index.ts")).sort();
		expect(exported).toEqual(EXPECTED_EXPORTS);
	});

	test("constants are frozen and have the documented values", async () => {
		const api = await import("../../index.ts");
		expect(api.SCHEMA_VERSION).toBe(1);
		for (const frozen of [
			api.LIMITS,
			api.ITEM_KINDS,
			api.ITEM_STATUSES,
			api.ITEM_ORIGINS,
			api.SOURCE_STATUSES,
			api.BUILD_REASON_CODES,
			api.VALIDATION_REASON_CODES,
			api.CONTRACT_ERROR_CODES,
		]) {
			expect(Object.isFrozen(frozen)).toBe(true);
		}
		expect([...api.ITEM_KINDS]).toEqual(["goal", "decision", "open_question"]);
		expect([...api.ITEM_STATUSES]).toEqual(["active", "inactive"]);
		expect([...api.ITEM_ORIGINS]).toEqual(["user_confirmed", "user_edited"]);
		expect([...api.SOURCE_STATUSES]).toEqual([
			"available",
			"missing",
			"changed",
			"forgotten",
		]);
		expect(api.LIMITS.maxItemTextBytes).toBe(16384);
	});

	test("reason code catalogues match the design (order included)", async () => {
		const api = await import("../../index.ts");
		expect([...api.BUILD_REASON_CODES]).toEqual([
			"MEMORY_DISABLED",
			"PRINCIPAL_MISMATCH",
			"SCOPE_NOT_PERMITTED",
			"POLICY_REVISION_MISMATCH",
			"SNAPSHOT_INCOMPLETE",
			"SOURCE_NOT_IN_SNAPSHOT",
			"SOURCE_NOT_PERMITTED",
			"SOURCE_MISSING",
			"SOURCE_CHANGED",
			"SOURCE_FORGOTTEN",
			"SOURCE_REVISION_MISMATCH",
			"SOURCE_DIGEST_MISMATCH",
			"SOURCE_CONTENT_DIGEST_MISMATCH",
			"SOURCE_CONTENT_REQUIRED",
			"SOURCE_RANGE_OUT_OF_BOUNDS",
			"SOURCE_RANGE_NOT_CHAR_BOUNDARY",
			"BUDGET_EXCEEDED",
		]);
		expect([...api.VALIDATION_REASON_CODES]).toEqual([
			"VIEW_NOT_READY",
			"VIEW_DIGEST_MISMATCH",
			"PRINCIPAL_MISMATCH",
			"SCOPE_NOT_PERMITTED",
			"POLICY_REVISION_MISMATCH",
			"SNAPSHOT_INCOMPLETE",
			"SCOPE_MISMATCH",
			"PURPOSE_MISMATCH",
			"STATE_REVISION_MISMATCH",
			"ITEM_MISSING",
			"ITEM_INACTIVE",
			"ITEM_REVISION_CHANGED",
			"ITEM_CONTENT_CHANGED",
			"ITEM_SET_CHANGED",
			"SOURCE_NOT_IN_SNAPSHOT",
			"SOURCE_NOT_PERMITTED",
			"SOURCE_MISSING",
			"SOURCE_CHANGED",
			"SOURCE_FORGOTTEN",
			"SOURCE_REVISION_MISMATCH",
			"SOURCE_DIGEST_MISMATCH",
			"SOURCE_CONTENT_DIGEST_MISMATCH",
			"SOURCE_CONTENT_REQUIRED",
			"SOURCE_RANGE_OUT_OF_BOUNDS",
			"SOURCE_RANGE_NOT_CHAR_BOUNDARY",
			"VIEW_REBUILD_MISMATCH",
		]);
	});

	test("isMemoryContractError recognizes structural copies and rejects look-alikes", async () => {
		const api = await import("../../index.ts");
		const real = new api.MemoryContractError("INVALID_TYPE", "$");
		expect(api.isMemoryContractError(real)).toBe(true);
		expect(real.message).toBe("INVALID_TYPE at $");
		const copy = Object.assign(new Error("x"), {
			name: "MemoryContractError",
			code: "INVALID_TYPE",
			path: "$",
		});
		expect(api.isMemoryContractError(copy)).toBe(true);
		expect(
			api.isMemoryContractError(
				Object.assign(new Error("x"), {
					name: "MemoryContractError",
					code: "NOPE",
					path: "$",
				}),
			),
		).toBe(false);
		expect(
			api.isMemoryContractError({
				name: "MemoryContractError",
				code: "INVALID_TYPE",
				path: "$",
			}),
		).toBe(false);
		expect(api.isMemoryContractError(null)).toBe(false);
		expect(api.isMemoryContractError(new Error("x"))).toBe(false);
	});
});
