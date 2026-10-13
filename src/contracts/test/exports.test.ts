import { describe, expect, test } from "bun:test";

const EXPECTED_EXPORTS = [
	"CONTRACT_ERROR_CODES",
	"CONTRACT_VERSIONS",
	"DATE_PRECISIONS",
	"DEPENDENCY_NODE_TYPES",
	"DEPENDENCY_ROLES",
	"DEPENDENT_NODE_TYPES",
	"EXTERNAL_DELETION_STATES",
	"EXTERNAL_DEPENDENCY_TYPES",
	"EXTERNAL_REJECTED_REASON_CODES",
	"FORGET_EXTERNAL_STATES",
	"FORGET_TARGET_TYPES",
	"GENESIS_JOURNAL_HASH",
	"HOST_STATE_ORIGINS",
	"JOURNAL_FORMAT",
	"JOURNAL_REASON_CODES",
	"LIMITS",
	"LIMITS_EXTERNAL",
	"LIMITS_LIFECYCLE",
	"LIMITS_RECORDS",
	"LIMITS_STATE",
	"MEMORY_CHANGE_STATUSES",
	"MEMORY_CHANGE_TARGET_TYPES",
	"MEMORY_RECORD_REPRESENTATION",
	"MEMORY_RECORD_SOURCE_KIND",
	"MEMORY_SOURCE_NAMESPACE",
	"MemoryContractError",
	"POLARITIES",
	"RECORD_BLOCKED_REASON_CODES",
	"RECORD_CAPTURE_STATES",
	"RECORD_MEDIA_TYPES",
	"RECORD_RANGE_REASON_CODES",
	"RECORD_STATUSES",
	"SOURCE_STATUSES",
	"STATE_CAUSE_TYPES",
	"STATE_EVENT_ACTIONS",
	"STATE_ITEM_STATUSES",
	"STATE_KINDS",
	"STATE_ORIGINS",
	"STATE_REASON_CODES",
	"STORE_ACCESS_REASON_CODES",
	"TOMBSTONE_TARGET_TYPES",
	"TemporalError",
	"USER_STATE_ORIGINS",
	"VALIDITY_BASES",
	"VALIDITY_CLASSES",
	"classifyValidity",
	"isMemoryContractError",
	"periodFromStateMs",
	"sliceUtf8Range",
	"verifyForgetJournal",
];

describe("public runtime exports", () => {
	test("export list is exactly the documented surface", async () => {
		const exported = Object.keys(await import("../../index.ts")).sort();
		expect(exported).toEqual(EXPECTED_EXPORTS);
	});

	test("constants are frozen and have the documented values", async () => {
		const api = await import("../../index.ts");
		for (const frozen of [
			api.LIMITS,
			api.SOURCE_STATUSES,
			api.CONTRACT_ERROR_CODES,
			api.CONTRACT_VERSIONS,
		]) {
			expect(Object.isFrozen(frozen)).toBe(true);
		}
		expect([...api.SOURCE_STATUSES]).toEqual([
			"available",
			"missing",
			"changed",
			"forgotten",
		]);
		expect(api.CONTRACT_VERSIONS).toEqual({
			records: 1,
			state: 1,
			lifecycle: 1,
			external: 1,
		});
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
