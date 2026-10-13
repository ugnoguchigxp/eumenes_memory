/** S0 で確定した family 契約（定数・タプル・上限）の固定。実装本体は持たない。 */
import { describe, expect, test } from "bun:test";
import * as api from "../../index.ts";

describe("family contracts (S0)", () => {
	test("every exported SCREAMING_CASE constant is deeply frozen", () => {
		const names = Object.keys(api).filter((name) =>
			/^[A-Z][A-Z0-9_]*$/.test(name),
		);
		expect(names.length).toBeGreaterThan(40);
		for (const name of names) {
			const value = (api as Record<string, unknown>)[name];
			if (typeof value === "object" && value !== null) {
				expect({ name, frozen: Object.isFrozen(value) }).toEqual({
					name,
					frozen: true,
				});
			}
		}
	});

	test("CONTRACT_VERSIONS has exactly the in-repo families (no world / consolidation)", () => {
		expect(api.CONTRACT_VERSIONS).toEqual({
			records: 1,
			recall: 1,
			state: 1,
			extraction: 1,
			lifecycle: 1,
			external: 1,
		});
		expect([...api.VIEW_SCHEMA_VERSIONS]).toEqual([1, 2]);
		expect(api.SCHEMA_VERSION).toBe(1);
		for (const name of Object.keys(api)) {
			expect(name).not.toMatch(/WORLD|CONSOLIDAT/i);
		}
	});

	test("v1 view contract values are untouched; v2 reason codes start with all v1 codes in order", () => {
		expect(
			[...api.BUILD_V2_REASON_CODES].slice(0, api.BUILD_REASON_CODES.length),
		).toEqual([...api.BUILD_REASON_CODES]);
		expect(
			[...api.VALIDATION_V2_REASON_CODES].slice(
				0,
				api.VALIDATION_REASON_CODES.length,
			),
		).toEqual([...api.VALIDATION_REASON_CODES]);
		expect([...api.ITEM_KINDS_V2]).toEqual([
			...api.ITEM_KINDS,
			"preference",
			"personal_fact",
			"constraint",
			"habit",
		]);
		expect([...api.ITEM_ORIGINS_V2]).toEqual([
			...api.ITEM_ORIGINS,
			"admitted_extraction",
			"agent_inferred",
		]);
	});

	test("limits match the design", () => {
		expect<number>(api.LIMITS_RECORDS.maxContentBytes).toBe(1024 * 1024);
		expect<number>(api.LIMITS_RECORDS.maxRangeBytes).toBe(64 * 1024);
		expect<number>(api.LIMITS_RECALL.minLimit).toBe(1);
		expect<number>(api.LIMITS_RECALL.maxLimit).toBe(50);
		expect<number>(api.LIMITS_RECALL.maxSnippetBytes).toBe(256);
		expect<number>(api.LIMITS_RECALL.maxScopeKeys).toBe(
			api.LIMITS.maxScopeKeys,
		);
		expect<number>(api.LIMITS_EXTRACTION.maxCandidates).toBe(10);
		expect<number>(api.LIMITS_EXTRACTION.maxOutputBytes).toBe(16 * 1024);
		expect<number>(api.LIMITS_EXTERNAL.maxDependenciesPerDependent).toBe(
			api.LIMITS.maxDependenciesPerItem,
		);
		expect<number>(api.LIMITS_VIEW_V2.maxEvidenceHits).toBe(
			api.LIMITS_RECALL.maxLimit,
		);
	});

	test("State / Admission vocabulary", () => {
		expect([...api.STATE_KINDS]).toEqual([
			"preference",
			"personal_fact",
			"constraint",
			"habit",
			"other_person_note",
		]);
		expect([...api.STATE_ITEM_STATUSES]).toEqual([
			"active",
			"inactive",
			"superseded",
			"disputed",
			"retracted",
			"invalidated",
			"forgotten",
		]);
		expect([...api.STATE_ORIGINS]).toEqual([
			"user_confirmed",
			"user_edited",
			"admitted_extraction",
			"agent_inferred",
		]);
		expect([...api.USER_STATE_ORIGINS]).toEqual([
			"user_confirmed",
			"user_edited",
		]);
		expect([...api.HOST_STATE_ORIGINS]).toEqual([
			"user_confirmed",
			"user_edited",
			"agent_inferred",
		]);
		expect([...api.ADMISSION_MODES]).toEqual([
			"never",
			"user_confirm",
			"auto_admit",
		]);
		expect([...api.ADMISSION_REASON_CODES]).toEqual([
			"INVALID_CANDIDATE",
			"QUOTE_MISMATCH",
			"EVIDENCE_NOT_IN_INPUT",
			"SOURCE_STALE",
			"HOST_OWNED_KIND",
			"MODALITY_QUOTED",
			"MODALITY_NOT_ASSERTED",
			"SUBJECT_OTHER",
			"SUBJECT_UNKNOWN",
			"TEMPORAL_NOT_CURRENT",
			"NOT_USER_SOURCE",
			"OLDER_EVIDENCE",
			"POLICY_NEVER",
			"POLICY_REQUIRES_USER",
		]);
		expect([...api.MODALITIES]).toEqual([
			"asserted",
			"hypothetical",
			"quoted",
			"reported",
			"question",
		]);
		for (const kind of api.STATE_KINDS) {
			expect(api.DEFAULT_ADMISSION_POLICY[kind]).toBe("user_confirm");
		}
		expect([...api.HOST_OWNED_KINDS]).toEqual([
			"goal",
			"decision",
			"open_question",
		]);
		for (const hostKind of api.HOST_OWNED_KINDS) {
			expect((api.STATE_KINDS as readonly string[]).includes(hostKind)).toBe(
				false,
			);
		}
	});

	test("Extraction / Lifecycle / external vocabulary", () => {
		expect([...api.EXTRACTION_SKIP_REASON_CODES]).toEqual([
			"MEMORY_DISABLED",
			"NO_NEW_INPUT",
			"SOURCE_TOMBSTONED",
			"INPUT_TOO_LARGE",
		]);
		expect([...api.EXTRACTION_STALE_REASON_CODES]).toEqual([
			"SOURCE_CHANGED",
			"SOURCE_TOMBSTONED",
			"STATE_CHANGED",
			"RUN_UNKNOWN",
			"RUN_ALREADY_SETTLED_DIFFERENT",
		]);
		expect([...api.EXTRACTION_REJECTED_OUTPUT_REASON_CODES]).toEqual([
			"OUTPUT_SCHEMA",
			"OUTPUT_TOO_LARGE",
			"TOO_MANY_CANDIDATES",
		]);
		expect([...api.JOURNAL_REASON_CODES]).toEqual([
			"JOURNAL_TRUNCATED",
			"JOURNAL_CHAIN_BROKEN",
			"JOURNAL_MISSING",
		]);
		expect([...api.FORGET_EXTERNAL_STATES]).toEqual([
			"none",
			"pending",
			"unverified",
			"confirmed",
			"failed",
		]);
		expect([...api.FORGET_TARGET_TYPES]).toEqual([
			"record",
			"host_source",
			"state_item",
			"scope",
		]);
		expect(api.JOURNAL_FORMAT).toBe(1);
		expect<string>(api.GENESIS_JOURNAL_HASH).toBe("0".repeat(64));
		expect([...api.MEMORY_CHANGE_TARGET_TYPES]).toEqual([
			"record",
			"state_item",
			"source",
		]);
		expect([...api.EXTERNAL_DEPENDENCY_TYPES]).toEqual([
			"source",
			"state_item",
		]);
		// 外部派生物は閉包の dependent 側にだけ現れる
		expect(
			(api.DEPENDENT_NODE_TYPES as readonly string[]).includes("external"),
		).toBe(true);
		expect(
			(api.DEPENDENCY_NODE_TYPES as readonly string[]).includes("external"),
		).toBe(false);
	});

	test("Records / Recall vocabulary", () => {
		expect([...api.RECORD_MEDIA_TYPES]).toEqual([
			"text/plain",
			"text/markdown",
			"application/json",
		]);
		expect([...api.RECORD_STATUSES]).toEqual(["active", "inactive"]);
		expect([...api.RECORD_BLOCKED_REASON_CODES]).toEqual([
			"SCOPE_NOT_PERMITTED",
			"TOMBSTONED",
		]);
		expect([...api.RECORD_RANGE_REASON_CODES]).toEqual([
			"SOURCE_RANGE_OUT_OF_BOUNDS",
			"SOURCE_RANGE_NOT_CHAR_BOUNDARY",
			"RANGE_TOO_LARGE",
		]);
		expect([...api.RECALL_STRATEGIES]).toEqual(["like", "fts"]);
		expect(api.MEMORY_SOURCE_NAMESPACE).toBe("memory");
		expect(api.MEMORY_RECORD_SOURCE_KIND).toBe("record");
		expect(api.MEMORY_RECORD_REPRESENTATION).toBe("text");
	});
});
