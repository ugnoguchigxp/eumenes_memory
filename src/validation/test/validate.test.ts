import { describe, expect, test } from "bun:test";
import { computeViewDigest } from "../../view/digest.ts";
import { baseInput, baseView } from "../../contracts/test/base.ts";
import { isMemoryContractError } from "../../contracts/errors.ts";
import { VALIDATION_REASON_CODES } from "../../contracts/reason-codes.ts";
import type { ReadyBody } from "../../view/compose.ts";
import { validateMemoryView } from "../validate.ts";

const currentOf = (input: any = baseInput()) => ({
	schemaVersion: 1 as const,
	access: input.access,
	snapshot: input.snapshot,
});

/** view を加工し、正しい viewDigest を付け直す。 */
function resigned(mutate: (view: any) => void): any {
	const view = baseView();
	mutate(view);
	const { viewDigest: _drop, ...body } = view;
	view.viewDigest = computeViewDigest(body as ReadyBody);
	return view;
}

describe("validateMemoryView", () => {
	test("valid for an unchanged state; result is frozen", () => {
		const result = validateMemoryView(baseView(), currentOf());
		expect(result).toEqual({
			schemaVersion: 1,
			status: "valid",
			viewDigest: baseView().viewDigest,
		});
		expect(Object.isFrozen(result)).toBe(true);
	});

	test("V8 VIEW_REBUILD_MISMATCH fires for a re-signed view with reordered items", () => {
		const view = resigned((v) => v.items.reverse());
		expect(validateMemoryView(view, currentOf())).toEqual({
			schemaVersion: 1,
			status: "invalid",
			reasonCode: "VIEW_REBUILD_MISMATCH",
		});
	});

	test("V8 also fires when the dependency list was tampered and re-signed", () => {
		const view = resigned((v) => v.dependencies.pop());
		expect(validateMemoryView(view, currentOf())).toMatchObject({
			status: "invalid",
			reasonCode: "VIEW_REBUILD_MISMATCH",
		});
	});

	test("a re-signed view with unsorted item dependencies is rejected, not accepted", () => {
		const view = resigned((v) => v.items[1].dependencies.reverse());
		expect(validateMemoryView(view, currentOf())).toMatchObject({
			status: "invalid",
			reasonCode: "VIEW_REBUILD_MISMATCH",
		});
	});

	test("item dependency order alone does not count as a content change", () => {
		const input = baseInput();
		input.snapshot.items[1].dependencies.reverse();
		expect(validateMemoryView(baseView(), currentOf(input))).toMatchObject({
			status: "valid",
		});
	});

	test("changed primarySource range is ITEM_CONTENT_CHANGED", () => {
		const input = baseInput();
		const g1 = input.snapshot.items[1];
		g1.primarySource.range = { startByte: 0, endByte: 3 };
		g1.dependencies[1].range = { startByte: 0, endByte: 3 };
		expect(validateMemoryView(baseView(), currentOf(input))).toMatchObject({
			status: "invalid",
			reasonCode: "ITEM_CONTENT_CHANGED",
		});
	});

	test("kind change is ITEM_CONTENT_CHANGED", () => {
		const input = baseInput();
		input.snapshot.items[2].kind = "goal";
		expect(validateMemoryView(baseView(), currentOf(input))).toMatchObject({
			reasonCode: "ITEM_CONTENT_CHANGED",
		});
	});

	test("non-ready view is VIEW_NOT_READY even when current is incomplete", () => {
		const blocked = {
			...baseView(),
			status: "blocked",
			reasonCode: "SOURCE_MISSING",
		};
		delete (blocked as any).items;
		delete (blocked as any).dependencies;
		delete (blocked as any).coverage;
		delete (blocked as any).viewDigest;
		const current = currentOf();
		current.snapshot.complete = false;
		expect(validateMemoryView(blocked, current)).toMatchObject({
			reasonCode: "VIEW_NOT_READY",
		});
	});

	test("view is parsed before current (view error wins)", () => {
		const view = baseView();
		view.extra = 1;
		const current = currentOf();
		current.snapshot.items[0].kind = "fact";
		try {
			validateMemoryView(view, current);
			throw new Error("unreachable");
		} catch (error) {
			expect(isMemoryContractError(error)).toBe(true);
			expect((error as any).code).toBe("UNKNOWN_KEY");
			expect((error as any).path).toBe("$");
		}
	});

	test("does not mutate and shares nothing with its inputs; frozen inputs are fine", () => {
		const view = baseView();
		const current = currentOf();
		const before = JSON.stringify([view, current]);
		const freeze = (value: any): void => {
			if (typeof value === "object" && value !== null) {
				Object.values(value).forEach(freeze);
				Object.freeze(value);
			}
		};
		freeze(view);
		freeze(current);
		const first = validateMemoryView(view, current);
		const second = validateMemoryView(view, current);
		expect(JSON.stringify([view, current])).toBe(before);
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
	});

	test("an invalid-state call between two identical calls does not change the result", () => {
		const a = validateMemoryView(baseView(), currentOf());
		const broken = currentOf();
		broken.snapshot.sources[1].status = "forgotten";
		expect(validateMemoryView(baseView(), broken)).toMatchObject({
			reasonCode: "SOURCE_FORGOTTEN",
		});
		expect(validateMemoryView(baseView(), currentOf())).toEqual(a);
	});

	test("reason code catalogue has no duplicates and ends with the defensive code", () => {
		expect(new Set(VALIDATION_REASON_CODES).size).toBe(
			VALIDATION_REASON_CODES.length,
		);
		expect(VALIDATION_REASON_CODES.at(-1)).toBe("VIEW_REBUILD_MISMATCH");
	});
});
