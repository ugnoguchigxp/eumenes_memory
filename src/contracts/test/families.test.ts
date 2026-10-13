/** family 契約（定数・タプル・上限）の固定。実装本体は持たない。 */
import { describe, expect, test } from "bun:test";
import * as api from "../../index.ts";

describe("family contracts", () => {
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
			state: 1,
			lifecycle: 1,
			external: 1,
		});
		for (const name of Object.keys(api)) {
			expect(name).not.toMatch(/WORLD|CONSOLIDAT/i);
		}
	});

	test("limits match the design", () => {
		expect<number>(api.LIMITS_RECORDS.maxContentBytes).toBe(1024 * 1024);
		expect<number>(api.LIMITS_RECORDS.maxRangeBytes).toBe(64 * 1024);
		expect<number>(api.LIMITS_EXTERNAL.maxDependenciesPerDependent).toBe(32);
	});

	test("State vocabulary", () => {
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
	});

	test("Lifecycle / external vocabulary", () => {
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
		expect([...api.DEPENDENT_NODE_TYPES]).toEqual(["state_item", "external"]);
		expect([...api.DEPENDENCY_NODE_TYPES]).toEqual(["source", "state_item"]);
	});

	test("Records vocabulary", () => {
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
		expect(api.MEMORY_SOURCE_NAMESPACE).toBe("memory");
		expect(api.MEMORY_RECORD_SOURCE_KIND).toBe("record");
		expect(api.MEMORY_RECORD_REPRESENTATION).toBe("text");
	});
});
