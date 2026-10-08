/**
 * 公開パッケージ名 "eumenes-memory"（package self-reference）だけを使う利用テスト。
 * src 内部への相対 import はしない。
 */
import { describe, expect, test } from "bun:test";
import {
	buildMemoryView,
	buildMemoryViewV2,
	isMemoryContractError,
	LIMITS,
	MemoryContractError,
	parseBuildMemoryViewInput,
	SCHEMA_VERSION,
	validateMemoryView,
	validateMemoryViewV2,
} from "eumenes-memory";
import type {
	BuildMemoryViewInput,
	MemoryView,
	ValidationCurrent,
} from "eumenes-memory";
import {
	describePublicFixtures,
	describePublicFixturesV2,
} from "../fixture-runner.ts";

describePublicFixtures("public", { buildMemoryView, validateMemoryView });
describePublicFixturesV2("public", { buildMemoryViewV2, validateMemoryViewV2 });

const DIGEST = "a".repeat(64);

function makeInput(): BuildMemoryViewInput {
	const source = {
		namespace: "conversation",
		kind: "message",
		id: "m1",
		representation: "text",
		revision: "1",
		digest: DIGEST,
	};
	return {
		schemaVersion: SCHEMA_VERSION,
		access: {
			principal: "local:owner",
			scopeKeys: ["conversation:c1"],
			purpose: "dialogue.generate",
			policyRevision: "1",
		},
		snapshot: {
			principal: "local:owner",
			scopeKey: "conversation:c1",
			stateRevision: "1",
			policyRevision: "1",
			complete: true,
			sources: [
				{
					...source,
					principal: "local:owner",
					scopeKey: "conversation:c1",
					status: "available",
				},
			],
			items: [
				{
					id: "continuity:g1",
					revision: "1",
					kind: "goal",
					text: "M0 を完成させる",
					status: "active",
					origin: "user_confirmed",
					primarySource: source,
					dependencies: [source],
				},
			],
		},
		maxBytes: 100000,
		enabled: true,
	};
}

describe("public API: runtime", () => {
	test("build -> ready, frozen, validate -> valid", () => {
		const input = makeInput();
		const view = buildMemoryView(input);
		expect(view.status).toBe("ready");
		expect(Object.isFrozen(view)).toBe(true);
		if (view.status !== "ready") throw new Error("unreachable");
		expect(view.items).toHaveLength(1);
		expect(view.instructionAuthority).toBe("none");
		expect(view.coverage).toEqual({ complete: true, omitted: [] });

		const current: ValidationCurrent = {
			schemaVersion: SCHEMA_VERSION,
			access: input.access,
			snapshot: input.snapshot,
		};
		const result = validateMemoryView(view, current);
		expect(result).toEqual({
			schemaVersion: 1,
			status: "valid",
			viewDigest: view.viewDigest,
		});
	});

	test("a JSON round trip of the view validates the same way", () => {
		const input = makeInput();
		const view = buildMemoryView(input);
		const wire = JSON.parse(JSON.stringify(view)) as MemoryView;
		const result = validateMemoryView(wire, {
			schemaVersion: SCHEMA_VERSION,
			access: input.access,
			snapshot: input.snapshot,
		});
		expect(result.status).toBe("valid");
	});

	test("invalid input throws MemoryContractError", () => {
		const bad = {
			...makeInput(),
			schemaVersion: 2,
		} as unknown as BuildMemoryViewInput;
		try {
			buildMemoryView(bad);
			throw new Error("unreachable");
		} catch (error) {
			expect(isMemoryContractError(error)).toBe(true);
			expect(error).toBeInstanceOf(MemoryContractError);
			expect((error as MemoryContractError).code).toBe(
				"UNSUPPORTED_SCHEMA_VERSION",
			);
		}
		expect(() => parseBuildMemoryViewInput(null)).toThrow(MemoryContractError);
	});

	test("JSON-derived values cast to the input type are still validated", () => {
		const json = JSON.parse(
			JSON.stringify(makeInput()),
		) as BuildMemoryViewInput;
		(json.snapshot.items[0] as unknown as { kind: string }).kind = "fact";
		expect(() => buildMemoryView(json)).toThrow(MemoryContractError);
	});

	test("limits are exposed read-only", () => {
		expect(LIMITS.maxItems).toBe(1000);
		expect(Object.isFrozen(LIMITS)).toBe(true);
	});
});

describe("public API: types", () => {
	test("status narrows the MemoryView union", () => {
		const view: MemoryView = buildMemoryView(makeInput());
		// @ts-expect-error items exists only on ready views
		void view.items;
		// @ts-expect-error viewDigest exists only on ready views
		void view.viewDigest;
		if (view.status === "ready") {
			const digest: string = view.viewDigest;
			expect(digest).toHaveLength(64);
			// @ts-expect-error ready views have no reasonCode
			void view.reasonCode;
		} else {
			const code: string = view.reasonCode;
			expect(code.length).toBeGreaterThan(0);
		}
	});

	test("input enums are checked at compile time", () => {
		const input = makeInput();
		const badKind: BuildMemoryViewInput = {
			...input,
			snapshot: {
				...input.snapshot,
				items: [
					{
						...(input.snapshot
							.items[0] as (typeof input.snapshot.items)[number]),
						// @ts-expect-error "fact" is not an ItemKind
						kind: "fact",
					},
				],
			},
		};
		void badKind;
		// @ts-expect-error schemaVersion must be 1
		const badVersion: BuildMemoryViewInput = { ...input, schemaVersion: 2 };
		void badVersion;
		expect(true).toBe(true);
	});
});
