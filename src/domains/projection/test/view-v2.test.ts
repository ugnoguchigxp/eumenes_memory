import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMemoryContractError } from "../../../contracts/errors.ts";
import {
	buildMemoryView,
	buildMemoryViewV2,
	composeSnapshotV2,
	parseBuildMemoryViewInput,
	parseBuildMemoryViewInputV2,
	parseMemoryViewV2,
	validateMemoryView,
	validateMemoryViewV2,
} from "../index.ts";
import type { MemoryItemV2, ReadyMemoryViewV2, SourceState } from "../index.ts";

const BUILD_V2 = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"fixtures",
	"build-v2",
);

/** B265: item 2 件（R1 / R3）+ evidence 2 件（R2 / R1）。毎回新しく読み込む。 */
function baseInput(): any {
	return JSON.parse(
		readFileSync(join(BUILD_V2, "B265-evidence-basic.json"), "utf8"),
	).input;
}

const currentOf = (input: any) => ({
	schemaVersion: 2 as const,
	access: input.access,
	snapshot: input.snapshot,
});

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return isMemoryContractError(error)
			? `${error.code}@${error.path}`
			: "OTHER";
	}
	return undefined;
}

function ready(input: any): ReadyMemoryViewV2 {
	const view = buildMemoryViewV2(input);
	if (view.status !== "ready") throw new Error(`not ready: ${view.status}`);
	return view;
}

describe("v1 and v2 are separate entry points", () => {
	test("the v1 functions reject a v2 input, the v2 functions reject a v1 input", () => {
		expect(codeOf(() => buildMemoryView(baseInput()))).toBe(
			"UNSUPPORTED_SCHEMA_VERSION@$.schemaVersion",
		);
		const v1 = JSON.parse(
			readFileSync(
				join(BUILD_V2, "..", "build", "B01-ready-basic.json"),
				"utf8",
			),
		).input;
		expect(codeOf(() => buildMemoryViewV2(v1))).toBe(
			"UNSUPPORTED_SCHEMA_VERSION@$.schemaVersion",
		);
		expect(codeOf(() => parseBuildMemoryViewInput(baseInput()))).toBe(
			"UNSUPPORTED_SCHEMA_VERSION@$.schemaVersion",
		);
		expect(codeOf(() => parseBuildMemoryViewInputV2(v1))).toBe(
			"UNSUPPORTED_SCHEMA_VERSION@$.schemaVersion",
		);
		const view = ready(baseInput());
		expect(codeOf(() => validateMemoryView(view as never, baseInput()))).toBe(
			"UNSUPPORTED_SCHEMA_VERSION@$.schemaVersion",
		);
	});

	test("the same v1-shaped input builds a v2 view with the same items and no evidence", () => {
		const v1 = JSON.parse(
			readFileSync(
				join(BUILD_V2, "..", "build", "B01-ready-basic.json"),
				"utf8",
			),
		).input;
		const old: any = buildMemoryView(v1);
		const next: any = buildMemoryViewV2({ ...v1, schemaVersion: 2 });
		expect(next.status).toBe("ready");
		expect(next.items).toEqual(old.items);
		expect(next.dependencies).toEqual(old.dependencies);
		expect(next.evidence).toEqual([]);
		expect(next.coverage).toEqual({ complete: true, omitted: [] });
		expect(next.viewDigest).not.toBe(old.viewDigest);
	});
});

describe("order independence", () => {
	test("items, sources and dependencies in any order give an identical view", () => {
		const expected = JSON.stringify(buildMemoryViewV2(baseInput()));
		const reversed = baseInput();
		reversed.snapshot.items.reverse();
		reversed.snapshot.sources.reverse();
		for (const item of reversed.snapshot.items) item.dependencies.reverse();
		expect(JSON.stringify(buildMemoryViewV2(reversed))).toBe(expected);
	});

	test("evidence order is the search rank and does change the view", () => {
		const first = ready(baseInput());
		const swapped = baseInput();
		swapped.evidence.hits.reverse();
		const second = ready(swapped);
		expect(second.evidence.map((e) => e.ref.id)).toEqual(
			[...first.evidence].reverse().map((e) => e.ref.id),
		);
		expect(second.viewDigest).not.toBe(first.viewDigest);
		// dependencies は並びに依存しない
		expect(second.dependencies).toEqual(first.dependencies);
	});
});

describe("hardening", () => {
	test("an inherited subject / range / content on Object.prototype changes nothing", () => {
		const expected = buildMemoryViewV2(baseInput());
		const proto = Object.prototype as any;
		proto.subject = "other:x";
		proto.range = { startByte: 0, endByte: 1 };
		proto.content = "zzz";
		proto.representation = "polluted";
		try {
			expect(buildMemoryViewV2(baseInput())).toEqual(expected);
			expect(
				validateMemoryViewV2(expected, currentOf(baseInput())),
			).toMatchObject({ status: "valid" });
		} finally {
			delete proto.subject;
			delete proto.range;
			delete proto.content;
			delete proto.representation;
		}
	});

	test("an accessor or a prototype other than Object.prototype in evidence is rejected", () => {
		const input = baseInput();
		Object.defineProperty(input.evidence, "maxEvidenceBytes", {
			get: () => 1,
			enumerable: true,
		});
		expect(codeOf(() => buildMemoryViewV2(input))).toBe(
			"INVALID_PROPERTY@$.evidence",
		);
		const hit = baseInput();
		Object.setPrototypeOf(hit.evidence.hits[0], { inherited: true });
		expect(codeOf(() => buildMemoryViewV2(hit))).toBe(
			"INVALID_PROPERTY@$.evidence.hits[0]",
		);
	});

	test("the result is a new deep-frozen object that shares nothing with the input", () => {
		const input = baseInput();
		const view = ready(input);
		expect(Object.isFrozen(view)).toBe(true);
		expect(Object.isFrozen(view.evidence[0])).toBe(true);
		expect(Object.isFrozen(view.evidence[0]?.ref)).toBe(true);
		expect(view.evidence[0]?.ref).not.toBe(input.evidence.hits[0].ref);
		expect(Object.isFrozen(view.coverage.omitted)).toBe(true);
	});

	test("a view parse keeps a ready view's evidence and rejects extra keys on an evidence entry", () => {
		const view = JSON.parse(JSON.stringify(ready(baseInput())));
		expect(parseMemoryViewV2(view).status).toBe("ready");
		view.evidence[0].scopeKey = "conversation:c1";
		expect(codeOf(() => parseMemoryViewV2(view))).toBe(
			"UNKNOWN_KEY@$.evidence[0]",
		);
	});

	test("coverage count must be positive and at most one omitted entry", () => {
		const view = JSON.parse(JSON.stringify(ready(baseInput())));
		view.coverage = {
			complete: false,
			omitted: [{ type: "evidence", count: 0 }],
		};
		expect(codeOf(() => parseMemoryViewV2(view))).toBe(
			"INVALID_INTEGER@$.coverage.omitted[0].count",
		);
		view.coverage = {
			complete: false,
			omitted: [
				{ type: "evidence", count: 1 },
				{ type: "evidence", count: 1 },
			],
		};
		expect(codeOf(() => parseMemoryViewV2(view))).toBe(
			"INVALID_VALUE@$.coverage",
		);
	});
});

describe("evidence rules", () => {
	test("evidence never causes overflow: with only the required part fitting, all hits are omitted", () => {
		const input = baseInput();
		const unlimited = ready(input);
		expect(unlimited.evidence).toHaveLength(2);
		input.evidence.maxEvidenceBytes = 0;
		const none = ready(input);
		expect(none.evidence).toEqual([]);
		expect(none.coverage).toEqual({
			complete: false,
			omitted: [{ type: "evidence", count: 2 }],
		});
	});

	test("a larger budget never drops evidence that a smaller budget kept (monotone, prefix)", () => {
		const input = baseInput();
		const sizes: number[] = [];
		for (let budget = 0; budget <= 1200; budget += 40) {
			input.evidence.maxEvidenceBytes = budget;
			const view = ready(input);
			sizes.push(view.evidence.length);
			const unlimited = ready({ ...baseInput() });
			expect(view.evidence).toEqual(
				unlimited.evidence.slice(0, view.evidence.length),
			);
			expect(view.coverage.complete).toBe(
				view.evidence.length === unlimited.evidence.length,
			);
		}
		expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
		expect(sizes[0]).toBe(0);
		expect(sizes[sizes.length - 1]).toBe(2);
	});

	test("validate ignores which hits a later search would return, but not the view's own sources", () => {
		const input = baseInput();
		const view = ready(input);
		expect(validateMemoryViewV2(view, currentOf(input))).toEqual({
			schemaVersion: 2,
			status: "valid",
			viewDigest: view.viewDigest,
		});
		const forgotten = baseInput();
		forgotten.snapshot.sources[1].status = "forgotten";
		expect(validateMemoryViewV2(view, currentOf(forgotten))).toEqual({
			schemaVersion: 2,
			status: "invalid",
			reasonCode: "SOURCE_FORGOTTEN",
		});
	});

	test("a forgotten evidence source is invalid even when the item set is otherwise unchanged", () => {
		const input = baseInput();
		const view = ready(input);
		const changed = baseInput();
		// evidence だけの出典（R2）を取り除く
		changed.snapshot.sources.splice(1, 1);
		expect(validateMemoryViewV2(view, currentOf(changed))).toMatchObject({
			status: "invalid",
			reasonCode: "SOURCE_NOT_IN_SNAPSHOT",
		});
	});
});

describe("randomized invariants (seeded)", () => {
	function rng(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 0x1_0000_0000;
		};
	}

	test("build -> validate is valid; excluded subjects never appear; budgets hold", () => {
		for (let seed = 1; seed <= 60; seed += 1) {
			const next = rng(seed);
			const input = baseInput();
			const base = input.snapshot.items[0];
			const extra: any[] = [];
			const count = Math.floor(next() * 6);
			for (let n = 0; n < count; n += 1) {
				const roll = next();
				extra.push({
					...base,
					id: `state:r${n}`,
					text: `項目${n}`,
					status: roll < 0.2 ? "inactive" : "active",
					subject:
						roll < 0.4 ? "other:mother" : roll < 0.5 ? "unknown" : "self",
				});
			}
			input.snapshot.items.push(...extra);
			input.evidence.maxEvidenceBytes = Math.floor(next() * 1200);
			input.maxBytes = 1500 + Math.floor(next() * 4000);
			const view: any = buildMemoryViewV2(input);
			if (view.status === "overflow") {
				const minimal = ready({
					...input,
					maxBytes: 1_000_000,
					evidence: { hits: input.evidence.hits, maxEvidenceBytes: 0 },
				});
				expect(
					new TextEncoder().encode(JSON.stringify(minimal)).length,
				).toBeGreaterThan(input.maxBytes);
				continue;
			}
			expect(view.status).toBe("ready");
			const ids = new Set(view.items.map((item: any) => item.id));
			for (const item of extra) {
				const expected = item.status === "active" && item.subject === "self";
				expect(ids.has(item.id)).toBe(expected);
			}
			expect(
				new TextEncoder().encode(JSON.stringify(view)).length,
			).toBeLessThanOrEqual(input.maxBytes);
			const used = view.evidence.reduce(
				(sum: number, entry: unknown) =>
					sum +
					new TextEncoder().encode(JSON.stringify(sortKeys(entry))).length,
				0,
			);
			expect(used).toBeLessThanOrEqual(input.evidence.maxEvidenceBytes);
			expect(validateMemoryViewV2(view, currentOf(input))).toMatchObject({
				status: "valid",
				viewDigest: view.viewDigest,
			});
			// 同じ入力は同じ view
			expect(JSON.stringify(buildMemoryViewV2(input))).toBe(
				JSON.stringify(view),
			);
		}
	});
});

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, inner]) => [key, sortKeys(inner)]),
		);
	}
	return value;
}

describe("composeSnapshotV2", () => {
	const state = (
		id: string,
		status: SourceState["status"],
		extra: Partial<SourceState> = {},
	): SourceState => ({
		namespace: "memory",
		kind: "record",
		id,
		representation: "text",
		revision: "sha256:aa",
		digest: "a".repeat(64),
		principal: "local:owner",
		scopeKey: "scope:a",
		status,
		...extra,
	});
	const item = (id: string): MemoryItemV2 => {
		const ref = {
			namespace: "memory",
			kind: "record",
			id: "rec:1",
			representation: "text",
			revision: "sha256:aa",
			digest: "a".repeat(64),
		};
		return {
			id,
			revision: "1",
			kind: "preference",
			text: "x",
			status: "active",
			origin: "user_confirmed",
			primarySource: ref,
			dependencies: [ref],
			subject: "self",
		};
	};
	const header = {
		principal: "local:owner",
		scopeKey: "scope:a",
		policyRevision: "1",
		complete: true,
	};

	test("composes the state revision and concatenates items", () => {
		const snapshot = composeSnapshotV2({
			...header,
			continuity: {
				revision: "12",
				items: [item("continuity:a")],
				sources: [],
			},
			memory: { memoryRevision: "3", items: [item("state:a")], sources: [] },
		});
		expect(snapshot.stateRevision).toBe("c:12|m:3");
		expect(snapshot.items.map((i) => i.id)).toEqual([
			"continuity:a",
			"state:a",
		]);
		expect(snapshot.complete).toBe(true);
		expect(
			composeSnapshotV2({
				...header,
				memory: { memoryRevision: "0", items: [], sources: [] },
			}).stateRevision,
		).toBe("c:|m:0");
	});

	test("one entry per source; the worse state wins regardless of order", () => {
		const parts = [
			[state("rec:1", "available")],
			[state("rec:1", "changed")],
			[state("rec:1", "forgotten", { revision: "sha256:bb" })],
			[state("rec:1", "missing")],
		];
		for (const order of [
			parts,
			[...parts].reverse(),
			[parts[2]!, parts[0]!, parts[3]!, parts[1]!],
		]) {
			const snapshot = composeSnapshotV2({
				...header,
				continuity: { revision: "1", items: [], sources: order[0]! },
				memory: { memoryRevision: "1", items: [], sources: order[1]! },
				evidenceSources: [...order[2]!, ...order[3]!],
			});
			expect(snapshot.sources).toHaveLength(1);
			expect(snapshot.sources[0]?.status).toBe("forgotten");
		}
	});

	test("does not mutate its input and the result builds", () => {
		const memory = {
			memoryRevision: "3",
			items: [item("state:a")],
			sources: [state("rec:1", "available")],
		};
		const before = JSON.stringify(memory);
		const snapshot = composeSnapshotV2({ ...header, memory });
		expect(JSON.stringify(memory)).toBe(before);
		const view = buildMemoryViewV2({
			schemaVersion: 2,
			access: {
				principal: "local:owner",
				scopeKeys: ["scope:a"],
				purpose: "test",
				policyRevision: "1",
			},
			snapshot,
			maxBytes: 100000,
			enabled: true,
		});
		expect(view.status).toBe("ready");
	});
});
