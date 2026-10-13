/**
 * 公開パッケージ名 "eumenes-memory"（package self-reference）だけを使う利用テスト。
 * src 内部への相対 import はしない。
 */
import { describe, expect, test } from "bun:test";
import {
	CONTRACT_VERSIONS,
	GENESIS_JOURNAL_HASH,
	LIMITS,
	MemoryContractError,
	TemporalError,
	classifyValidity,
	isMemoryContractError,
	periodFromStateMs,
	sliceUtf8Range,
	verifyForgetJournal,
} from "eumenes-memory";
import type {
	AccessContext,
	ContractErrorCode,
	SourceRef,
	ValidityPeriod,
} from "eumenes-memory";

describe("public API: pure runtime", () => {
	test("sliceUtf8Range cuts on UTF-8 byte ranges and rejects a range inside a character", () => {
		expect(sliceUtf8Range("ab食c", { startByte: 2, endByte: 5 })).toMatchObject(
			{
				status: "ok",
				text: "食",
			},
		);
		expect(sliceUtf8Range("ab食c", { startByte: 2, endByte: 4 })).toEqual({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		});
		expect(sliceUtf8Range("ab", { startByte: 0, endByte: 9 })).toEqual({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
		});
	});

	test("verifyForgetJournal accepts an empty journal", () => {
		expect(verifyForgetJournal([])).toEqual({ status: "ok", head: null });
		expect(GENESIS_JOURNAL_HASH).toHaveLength(64);
	});

	test("classifyValidity and periodFromStateMs read the host's clock value only", () => {
		const period = periodFromStateMs(1_000, 2_000) as ValidityPeriod;
		expect(classifyValidity(period, 1_500)).toBe("current");
		expect(classifyValidity(period, 500)).toBe("future");
		expect(classifyValidity(period, 2_000)).toBe("past");
		expect(classifyValidity(undefined, 0)).toBe("unknown");
		expect(() => classifyValidity(period, 1.5)).toThrow(TemporalError);
	});

	test("contract versions and limits are frozen", () => {
		expect(CONTRACT_VERSIONS).toEqual({
			records: 1,
			state: 1,
			lifecycle: 1,
			external: 1,
		});
		expect(Object.isFrozen(CONTRACT_VERSIONS)).toBe(true);
		expect(Object.isFrozen(LIMITS)).toBe(true);
	});

	test("MemoryContractError carries a code and a path, and is recognised structurally", () => {
		const error = new MemoryContractError("INVALID_TYPE", "$.x");
		expect(isMemoryContractError(error)).toBe(true);
		expect(error.message).toBe("INVALID_TYPE at $.x");
		expect(isMemoryContractError(new Error("INVALID_TYPE"))).toBe(false);
	});
});

describe("public API: types", () => {
	test("exported types compose", () => {
		const access: AccessContext = {
			principal: "local:owner",
			scopeKeys: ["conversation:c1"],
			purpose: "dialogue.generate",
			policyRevision: "1",
		};
		const ref: SourceRef = {
			namespace: "conversation",
			kind: "message",
			id: "m1",
			revision: "1",
			digest: "a".repeat(64),
		};
		const code: ContractErrorCode = "INVALID_TYPE";
		expect([access.principal, ref.id, code]).toEqual([
			"local:owner",
			"m1",
			"INVALID_TYPE",
		]);
		expect(() => {
			// @ts-expect-error CONTRACT_VERSIONS is read-only
			CONTRACT_VERSIONS.records = 2;
		}).toThrow();
	});
});
