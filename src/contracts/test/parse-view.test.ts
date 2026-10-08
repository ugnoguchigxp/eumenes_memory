import { describe, expect, test } from "bun:test";
import { isMemoryContractError } from "../errors.ts";
import { parseMemoryView } from "../parse-view.ts";
import { baseView } from "./base.ts";

function codeAndPath(run: () => unknown): { code: string; path: string } {
	try {
		run();
	} catch (error) {
		if (isMemoryContractError(error)) {
			return { code: error.code, path: error.path };
		}
		throw error;
	}
	throw new Error("expected MemoryContractError");
}

const header = () => {
	const {
		items: _i,
		dependencies: _d,
		coverage: _c,
		viewDigest: _v,
		...rest
	} = baseView();
	return rest;
};

describe("parseMemoryView", () => {
	test("accepts a ready view and returns a deep-frozen copy", () => {
		const view = baseView();
		const parsed = parseMemoryView(view);
		expect(parsed).toEqual(view);
		expect(parsed).not.toBe(view);
		expect(Object.isFrozen(parsed)).toBe(true);
	});

	test.each([
		["blocked", "SOURCE_MISSING"],
		["blocked", "PRINCIPAL_MISMATCH"],
		["overflow", "BUDGET_EXCEEDED"],
		["disabled", "MEMORY_DISABLED"],
	])("accepts %s / %s", (status, reasonCode) => {
		const view = { ...header(), status, reasonCode };
		expect(parseMemoryView(view)).toEqual(view);
	});

	test.each([
		["blocked", "BUDGET_EXCEEDED"],
		["blocked", "MEMORY_DISABLED"],
		["overflow", "SOURCE_MISSING"],
		["disabled", "BUDGET_EXCEEDED"],
	])(
		"rejects inconsistent %s / %s with INVALID_VALUE",
		(status, reasonCode) => {
			const view = { ...header(), status, reasonCode };
			expect(codeAndPath(() => parseMemoryView(view))).toEqual({
				code: "INVALID_VALUE",
				path: "$.reasonCode",
			});
		},
	);

	test("reasonCode outside every enum is INVALID_ENUM", () => {
		const view = { ...header(), status: "blocked", reasonCode: "NOPE" };
		expect(codeAndPath(() => parseMemoryView(view)).code).toBe("INVALID_ENUM");
	});

	test("validation-only codes are not valid view reasonCodes", () => {
		const view = { ...header(), status: "blocked", reasonCode: "ITEM_MISSING" };
		expect(codeAndPath(() => parseMemoryView(view)).code).toBe("INVALID_ENUM");
	});

	test("allowed keys depend on status", () => {
		const readyWithReason = { ...baseView(), reasonCode: "SOURCE_MISSING" };
		expect(codeAndPath(() => parseMemoryView(readyWithReason))).toEqual({
			code: "UNKNOWN_KEY",
			path: "$",
		});
		const blockedWithItems = {
			...header(),
			status: "blocked",
			reasonCode: "SOURCE_MISSING",
			items: [],
		};
		expect(codeAndPath(() => parseMemoryView(blockedWithItems)).code).toBe(
			"UNKNOWN_KEY",
		);
		const blockedMissing = { ...header(), status: "blocked" };
		expect(codeAndPath(() => parseMemoryView(blockedMissing))).toEqual({
			code: "MISSING_KEY",
			path: "$.reasonCode",
		});
	});

	test("status is read before unknown keys", () => {
		const view = { ...baseView(), status: "weird" };
		expect(codeAndPath(() => parseMemoryView(view))).toEqual({
			code: "INVALID_ENUM",
			path: "$.status",
		});
		const missing = baseView();
		delete missing.status;
		expect(codeAndPath(() => parseMemoryView(missing))).toEqual({
			code: "MISSING_KEY",
			path: "$.status",
		});
	});

	test("coverage must be exactly { complete: true, omitted: [] }", () => {
		for (const coverage of [
			{ complete: false, omitted: [] },
			{ complete: true, omitted: [1] },
		]) {
			const view = { ...baseView(), coverage };
			expect(codeAndPath(() => parseMemoryView(view))).toEqual({
				code: "INVALID_VALUE",
				path: "$.coverage",
			});
		}
		const wrongType = {
			...baseView(),
			coverage: { complete: "yes", omitted: [] },
		};
		expect(codeAndPath(() => parseMemoryView(wrongType)).code).toBe(
			"INVALID_TYPE",
		);
		const extra = {
			...baseView(),
			coverage: { complete: true, omitted: [], x: 1 },
		};
		expect(codeAndPath(() => parseMemoryView(extra)).code).toBe("UNKNOWN_KEY");
	});

	test("instructionAuthority must be 'none'", () => {
		const view = { ...baseView(), instructionAuthority: "system" };
		expect(codeAndPath(() => parseMemoryView(view))).toEqual({
			code: "INVALID_ENUM",
			path: "$.instructionAuthority",
		});
	});

	test("rejects duplicate item ids and duplicate dependencies", () => {
		const dupItems = baseView();
		dupItems.items[1].id = dupItems.items[0].id;
		expect(codeAndPath(() => parseMemoryView(dupItems))).toEqual({
			code: "DUPLICATE_ITEM_ID",
			path: "$.items[1]",
		});
		const dupDeps = baseView();
		dupDeps.dependencies.push({ ...dupDeps.dependencies[0] });
		expect(codeAndPath(() => parseMemoryView(dupDeps))).toEqual({
			code: "DUPLICATE_SOURCE",
			path: "$.dependencies[3]",
		});
	});

	test("view items must be active and carry a consistent primarySource", () => {
		const inactive = baseView();
		inactive.items[0].status = "inactive";
		expect(codeAndPath(() => parseMemoryView(inactive))).toEqual({
			code: "INVALID_ENUM",
			path: "$.items[0].status",
		});
		const orphan = baseView();
		orphan.items[0].dependencies = [];
		expect(codeAndPath(() => parseMemoryView(orphan)).code).toBe(
			"PRIMARY_SOURCE_NOT_IN_DEPENDENCIES",
		);
	});

	test("dependencies carry no range", () => {
		const view = baseView();
		view.dependencies[0].range = { startByte: 0, endByte: 1 };
		expect(codeAndPath(() => parseMemoryView(view))).toEqual({
			code: "UNKNOWN_KEY",
			path: "$.dependencies[0]",
		});
	});

	test("rejects non-hex viewDigest and non-objects", () => {
		const view = baseView();
		view.viewDigest = "XYZ";
		expect(codeAndPath(() => parseMemoryView(view)).code).toBe(
			"INVALID_DIGEST",
		);
		expect(codeAndPath(() => parseMemoryView(null)).code).toBe("INVALID_TYPE");
	});
});
