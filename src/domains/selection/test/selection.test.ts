import { describe, expect, test } from "bun:test";
import { MemoryContractError } from "../../../contracts/errors.ts";
import {
	anyScopeTruncated,
	buildPublicVersion,
	candidateFromStateItem,
	grantFromScope,
	decidePublication,
	requiredDigestOf,
	revalidateUsage,
	selectContext,
	validateCheckpoint,
} from "../index.ts";
import type {
	Checkpoint,
	CurrentBasis,
	ScopeGrant,
	SelectionCandidate,
	SelectionInput,
} from "../index.ts";

const COMMON: ScopeGrant = {
	scopeKey: "user:common",
	kind: "user_common",
	revision: "1",
};
const PROJ_A: ScopeGrant = {
	scopeKey: "project:a",
	kind: "project",
	revision: "3",
};
const PROJ_B: ScopeGrant = {
	scopeKey: "project:b",
	kind: "project",
	revision: "1",
};
const NOW = 1_800_000_000_000;

function cand(
	id: string,
	over: Partial<SelectionCandidate> = {},
): SelectionCandidate {
	return {
		id,
		revision: "1",
		scopeKey: COMMON.scopeKey,
		text: `text-${id}`,
		duration: "ongoing",
		recordedAtMs: NOW - 1000,
		signals: { explicitRef: false, termMatches: 0, subjectMatch: false },
		...over,
	};
}

function input(
	candidates: SelectionCandidate[],
	over: Partial<SelectionInput> = {},
): SelectionInput {
	return {
		principal: "p",
		grants: [COMMON, PROJ_A, PROJ_B],
		context: { requestId: "r1", projectScopeKey: PROJ_A.scopeKey },
		query: { mode: "current", atMs: NOW },
		candidates,
		maxBytes: 1000,
		maxOptionalItems: 10,
		policyRevision: "pol1",
		selectionPolicyRevision: "sel1",
		retrieval: {
			searchedScopeKeys: [COMMON.scopeKey, PROJ_A.scopeKey],
			truncated: false,
			processedSeq: 10,
			headSeq: 10,
			pendingCorrections: 0,
		},
		...over,
	};
}

function ready(result: ReturnType<typeof selectContext>) {
	if (result.status !== "ready") throw new Error(JSON.stringify(result));
	return result;
}

describe("selectContext: applicability comes before ranking", () => {
	test("project A info never reaches project B and unauthorized scopes are excluded and counted", () => {
		const r = ready(
			selectContext(
				input(
					[
						cand("a", { scopeKey: PROJ_A.scopeKey }),
						cand("b", { scopeKey: PROJ_B.scopeKey }),
						cand("x", { scopeKey: "project:secret" }),
						cand("common"),
					],
					{ context: { requestId: "r1", projectScopeKey: PROJ_B.scopeKey } },
				),
			),
		);
		expect(r.optional.map((i) => i.id)).toEqual(["b", "common"].sort());
		expect(r.coverage.omitted).toContainEqual({
			id: "a",
			reason: "SCOPE_NOT_ACTIVE",
		});
		expect(r.coverage.omitted).toContainEqual({
			id: "x",
			reason: "SCOPE_NOT_AUTHORIZED",
		});
		expect(r.coverage.unauthorizedCandidates).toBe(1);
	});

	test("'this time' applies only to its own request; 'from now on' persists", () => {
		const short = cand("short", {
			duration: "this_request",
			requestId: "r0",
			requiredReason: "constraint",
		});
		const now = cand("now", {
			duration: "this_request",
			requestId: "r1",
			requiredReason: "constraint",
		});
		const always = cand("always", { requiredReason: "constraint" });
		const r = ready(selectContext(input([short, now, always])));
		expect(r.required.map((i) => i.id)).toEqual(["always", "now"]);
		expect(r.coverage.omitted).toContainEqual({
			id: "short",
			reason: "NOT_THIS_REQUEST",
		});
	});

	test("expired and future items are excluded from the current view", () => {
		const past = cand("past", {
			period: { until: { precision: "year", year: 2020 }, basis: "stated" },
		});
		const future = cand("future", {
			period: { from: { precision: "year", year: 2999 }, basis: "stated" },
		});
		const r = ready(selectContext(input([past, future, cand("ok")])));
		expect(r.optional.map((i) => i.id)).toEqual(["ok"]);
		expect(r.coverage.omitted.map((o) => o.reason)).toEqual([
			"NOT_CURRENT",
			"NOT_CURRENT",
		]);
	});

	test("past queries do not include things recorded after the target", () => {
		const later = cand("later", { recordedAtMs: NOW });
		const r = ready(
			selectContext(
				input([later, cand("early", { recordedAtMs: 10 })], {
					query: { mode: "at", atMs: NOW, targetMs: 500 },
					// undated entries are not answers to past questions
				}),
			),
		);
		expect(r.optional).toEqual([]);
		expect(r.coverage.omitted).toContainEqual({
			id: "later",
			reason: "NOT_KNOWN_AT_TARGET",
		});
	});
});

describe("selectContext: required set", () => {
	test("all required items are kept regardless of relevance, optional ones are ranked and budgeted", () => {
		const r = ready(
			selectContext(
				input(
					[
						cand("r-no-signal", { requiredReason: "prohibition", text: "NO" }),
						cand("o-weak", { text: "weak" }),
						cand("o-strong", {
							text: "strong",
							signals: {
								explicitRef: false,
								termMatches: 3,
								subjectMatch: true,
							},
						}),
						cand("o-ref", {
							text: "ref",
							signals: {
								explicitRef: true,
								termMatches: 0,
								subjectMatch: false,
							},
						}),
					],
					{ maxBytes: 8, maxOptionalItems: 5 },
				),
			),
		);
		expect(r.required.map((i) => i.id)).toEqual(["r-no-signal"]);
		expect(r.optional.map((i) => i.id)).toEqual(["o-ref"]);
		expect(r.coverage.omitted).toContainEqual({
			id: "o-strong",
			reason: "BUDGET",
		});
		expect(r.usedBytes).toBe(5);
	});

	test("ranking: explicit ref, scope specificity, term matches, subject, then id", () => {
		const r = ready(
			selectContext(
				input([
					cand("e", { scopeKey: PROJ_A.scopeKey }),
					cand("d", {
						signals: { explicitRef: false, termMatches: 0, subjectMatch: true },
					}),
					cand("c", {
						signals: {
							explicitRef: false,
							termMatches: 2,
							subjectMatch: false,
						},
					}),
					cand("b", {
						signals: { explicitRef: true, termMatches: 0, subjectMatch: false },
					}),
					cand("a"),
				]),
			),
		);
		expect(r.optional.map((i) => i.id)).toEqual(["b", "e", "c", "d", "a"]);
	});

	test("required overflow is explicit, never silently truncated", () => {
		const big = (
			id: string,
			reason: NonNullable<SelectionCandidate["requiredReason"]>,
		) => cand(id, { requiredReason: reason, text: "x".repeat(60) });
		const split = selectContext(
			input([big("a", "goal"), big("b", "decision")], { maxBytes: 100 }),
		);
		expect(split).toMatchObject({
			status: "required_overflow",
			action: "split",
			requiredBytes: 120,
		});
		const replan = selectContext(
			input([big("a", "goal"), big("t", "recent_turn")], { maxBytes: 100 }),
		);
		expect(replan).toMatchObject({
			status: "required_overflow",
			action: "replan",
		});
		const hold = selectContext(
			input([cand("a", { requiredReason: "goal", text: "x".repeat(200) })], {
				maxBytes: 100,
			}),
		);
		expect(hold).toMatchObject({ status: "required_overflow", action: "hold" });
	});

	test("conflicts: an explicit instruction given now wins; scope specificity alone never overrides; ties hold", () => {
		const concise = cand("concise", {
			requiredReason: "constraint",
			conflictKey: "len",
			valueKey: "short",
		});
		const long = cand("long", {
			requiredReason: "constraint",
			conflictKey: "len",
			valueKey: "long",
			duration: "this_request",
			requestId: "r1",
			explicit: true,
		});
		const r1 = ready(selectContext(input([concise, long])));
		expect(r1.required.map((i) => i.id)).toEqual(["long"]);
		expect(r1.coverage.omitted).toContainEqual({
			id: "concise",
			reason: "SUPERSEDED_BY_CONFLICT",
		});

		const common = cand("common", {
			requiredReason: "constraint",
			conflictKey: "ide",
			valueKey: "vim",
		});
		const proj = cand("proj", {
			requiredReason: "constraint",
			conflictKey: "ide",
			valueKey: "zed",
			scopeKey: PROJ_A.scopeKey,
		});
		// 具体的なscopeだというだけでは一般の制約を上書きしない。
		expect(selectContext(input([common, proj])).status).toBe("hold");
		const exception = { ...proj, exception: true };
		expect(
			ready(selectContext(input([common, exception]))).required.map(
				(i) => i.id,
			),
		).toEqual(["proj"]);
		// 一般scopeの例外は、より具体的な非例外の制約を上書きしない。
		expect(
			selectContext(input([{ ...common, exception: true }, proj])).status,
		).toBe("hold");

		const a = cand("a", {
			requiredReason: "constraint",
			conflictKey: "k",
			valueKey: "x",
		});
		const b = cand("b", {
			requiredReason: "constraint",
			conflictKey: "k",
			valueKey: "y",
		});
		const held = selectContext(input([a, b]));
		expect(held.status).toBe("hold");
		expect(held.coverage.unresolved).toEqual([
			{ conflictKey: "k", ids: ["a", "b"] },
		]);
	});

	test("same conflict key and value collapses to one", () => {
		const a = cand("a", {
			requiredReason: "constraint",
			conflictKey: "k",
			valueKey: "x",
		});
		const b = cand("b", {
			requiredReason: "constraint",
			conflictKey: "k",
			valueKey: "x",
		});
		const r = ready(selectContext(input([b, a])));
		expect(r.required.map((i) => i.id)).toEqual(["a"]);
		expect(r.coverage.omitted).toEqual([{ id: "b", reason: "DUPLICATE" }]);
	});
});

describe("retrieval flags never claim absence", () => {
	test("not found / truncated / stale / pending correction / unprocessed raw are distinct", () => {
		const empty = ready(selectContext(input([])));
		expect(empty.coverage.flags).toEqual(["not_found_in_searched_scopes"]);
		const all = ready(
			selectContext(
				input([cand("s", { stale: true })], {
					retrieval: {
						searchedScopeKeys: ["z", "a"],
						truncated: true,
						processedSeq: 5,
						headSeq: 9,
						pendingCorrections: 2,
					},
				}),
			),
		);
		expect(all.coverage.flags).toEqual([
			"search_truncated",
			"evidence_stale",
			"correction_pending",
			"raw_unprocessed",
		]);
		expect(all.coverage.searchedScopeKeys).toEqual(["a", "z"]);
	});
});

describe("selectContext is deterministic", () => {
	test("input order does not change the result", () => {
		const items = [
			cand("a"),
			cand("b", { requiredReason: "goal" }),
			cand("c"),
			cand("d", { requiredReason: "decision" }),
		];
		const one = selectContext(input(items));
		const two = selectContext(input([...items].reverse()));
		expect(two).toEqual(one);
	});
});

describe("revalidateUsage: unrelated updates stay valid, new constraints do not", () => {
	const items = [
		cand("req", { requiredReason: "constraint", scopeKey: PROJ_A.scopeKey }),
		cand("opt"),
	];
	const selected = ready(selectContext(input(items)));
	const current = (over: Partial<CurrentBasis> = {}): CurrentBasis => ({
		principal: "p",
		policyRevision: "pol1",
		selectionPolicyRevision: "sel1",
		grants: [COMMON, PROJ_A, PROJ_B],
		itemRevisions: { req: "1", opt: "1" },
		requiredDigest: requiredDigestOf([{ id: "req", revision: "1" }]),
		correctedScopeKeys: [],
		...over,
	});

	test("unchanged and unrelated changes (other scope, unused item, other project's grant) are valid", () => {
		expect(revalidateUsage(selected.usage, current())).toEqual({
			status: "valid",
		});
		expect(
			revalidateUsage(
				selected.usage,
				current({
					itemRevisions: { req: "1", opt: "1", unused: "9" },
					grants: [COMMON, PROJ_A, { ...PROJ_B, revision: "99" }],
					correctedScopeKeys: [PROJ_B.scopeKey],
				}),
			),
		).toEqual({ status: "valid" });
	});

	test("a new required constraint invalidates even though no used item changed", () => {
		const digest = requiredDigestOf([
			{ id: "req", revision: "1" },
			{ id: "new-rule", revision: "1" },
		]);
		expect(
			revalidateUsage(selected.usage, current({ requiredDigest: digest })),
		).toEqual({
			status: "invalid",
			reasons: ["REQUIRED_SET_CHANGED"],
		});
	});

	test("used item change/disappearance, grant change, policy change, related or unknown corrections invalidate", () => {
		expect(
			revalidateUsage(
				selected.usage,
				current({ itemRevisions: { req: "2", opt: "1" } }),
			),
		).toMatchObject({ reasons: ["ITEM_CHANGED"] });
		expect(
			revalidateUsage(selected.usage, current({ itemRevisions: { req: "1" } })),
		).toMatchObject({ reasons: ["ITEM_CHANGED"] });
		expect(
			revalidateUsage(selected.usage, current({ grants: [COMMON] })),
		).toMatchObject({ reasons: ["SCOPE_GRANT_CHANGED"] });
		expect(
			revalidateUsage(selected.usage, current({ policyRevision: "pol2" })),
		).toMatchObject({ reasons: ["POLICY_CHANGED"] });
		expect(
			revalidateUsage(
				selected.usage,
				current({ selectionPolicyRevision: "sel2" }),
			),
		).toMatchObject({ reasons: ["SELECTION_POLICY_CHANGED"] });
		expect(
			revalidateUsage(
				selected.usage,
				current({ correctedScopeKeys: [PROJ_A.scopeKey] }),
			),
		).toMatchObject({ reasons: ["CORRECTION_PENDING"] });
		expect(
			revalidateUsage(selected.usage, current({ correctedScopeKeys: ["*"] })),
		).toMatchObject({ reasons: ["CORRECTION_PENDING"] });
		expect(
			revalidateUsage(selected.usage, current({ principal: "q" })),
		).toMatchObject({ reasons: ["PRINCIPAL_CHANGED"] });
	});

	test("requiredDigestOf ignores order", () => {
		const a = { id: "a", revision: "1" };
		const b = { id: "b", revision: "2" };
		expect(requiredDigestOf([a, b])).toBe(requiredDigestOf([b, a]));
		expect(requiredDigestOf([a, b])).not.toBe(
			requiredDigestOf([a, { id: "b", revision: "3" }]),
		);
	});
});

describe("publication", () => {
	const v = buildPublicVersion({
		manifest: [
			{ itemId: "b", revision: "1" },
			{ itemId: "a", revision: "1" },
		],
		policyRevision: "pol1",
		publishedSeq: 10,
	});
	const base = {
		current: v,
		policyRevision: "pol1",
		additionThreshold: 3,
		boundary: false,
	};

	test("version ids are stable and order-independent; appended raw text does not change them", () => {
		const same = buildPublicVersion({
			manifest: [
				{ itemId: "a", revision: "1" },
				{ itemId: "b", revision: "1" },
			],
			policyRevision: "pol1",
			publishedSeq: 99,
		});
		expect(same.versionId).toBe(v.versionId);
		expect(v.manifest.map((m) => m.itemId)).toEqual(["a", "b"]);
	});

	test("additions wait for the threshold or a boundary; nothing new keeps the version", () => {
		expect(decidePublication({ ...base, changes: [] })).toEqual({
			action: "keep",
			pendingAdditions: 0,
		});
		const adds = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				itemId: `n${i}`,
				revision: "1",
				kind: "add" as const,
				seq: 11 + i,
			}));
		expect(decidePublication({ ...base, changes: adds(2) })).toEqual({
			action: "keep",
			pendingAdditions: 2,
		});
		expect(decidePublication({ ...base, changes: adds(3) })).toEqual({
			action: "publish",
			immediate: false,
			reasons: ["ADDITION_THRESHOLD"],
		});
		expect(
			decidePublication({ ...base, changes: adds(1), boundary: true }),
		).toEqual({ action: "publish", immediate: false, reasons: ["BOUNDARY"] });
		// changes already inside the published version are ignored
		expect(
			decidePublication({
				...base,
				changes: [{ itemId: "a", revision: "1", kind: "add", seq: 10 }],
			}),
		).toEqual({ action: "keep", pendingAdditions: 0 });
	});

	test("corrections, forgetting, auth and policy changes publish immediately, even among pending additions", () => {
		const one = (kind: "negate" | "retract" | "forget" | "auth_change") =>
			decidePublication({
				...base,
				changes: [{ itemId: "a", revision: "2", kind, seq: 11 }],
			});
		expect(one("negate")).toEqual({
			action: "publish",
			immediate: true,
			reasons: ["CORRECTION"],
		});
		expect(one("retract")).toMatchObject({ immediate: true });
		expect(one("forget")).toEqual({
			action: "publish",
			immediate: true,
			reasons: ["CORRECTION", "FORGET"],
		});
		expect(one("auth_change")).toEqual({
			action: "publish",
			immediate: true,
			reasons: ["CORRECTION", "AUTH_CHANGE"],
		});
		expect(
			decidePublication({ ...base, policyRevision: "pol2", changes: [] }),
		).toEqual({
			action: "publish",
			immediate: true,
			reasons: ["POLICY_CHANGED"],
		});
		expect(decidePublication({ ...base, current: null, changes: [] })).toEqual({
			action: "publish",
			immediate: false,
			reasons: ["NO_VERSION"],
		});
	});
});

describe("checkpoint", () => {
	const prev: Checkpoint = {
		topicId: "t",
		unresolved: ["q1"],
		decisions: ["d1"],
		refs: [],
		processedSeq: 10,
		origin: "deterministic",
		ranges: [],
	};
	test("model summaries need source ranges inside the processed boundary", () => {
		const next: Checkpoint = { ...prev, origin: "model_summary", ranges: [] };
		expect(validateCheckpoint(next, null)).toEqual([
			"MODEL_SUMMARY_WITHOUT_RANGES",
		]);
		expect(
			validateCheckpoint(
				{ ...next, ranges: [{ sourceId: "s", startSeq: 1, endSeq: 99 }] },
				null,
			),
		).toEqual(["BAD_RANGE"]);
		expect(
			validateCheckpoint(
				{ ...next, ranges: [{ sourceId: "s", startSeq: 1, endSeq: 10 }] },
				null,
			),
		).toEqual([]);
	});
	test("unresolved items and decisions cannot vanish unless explicitly resolved; boundary cannot regress", () => {
		const dropped: Checkpoint = {
			...prev,
			unresolved: [],
			decisions: [],
			processedSeq: 5,
		};
		expect(validateCheckpoint(dropped, prev)).toEqual([
			"LOST_UNRESOLVED",
			"LOST_DECISION",
			"BOUNDARY_REGRESSED",
		]);
		expect(
			validateCheckpoint({ ...dropped, processedSeq: 12 }, prev, ["q1", "d1"]),
		).toEqual([]);
	});
});

describe("review regressions", () => {
	test("hold does not claim 'not found' and invalid budgets are rejected", () => {
		const a = cand("a", {
			requiredReason: "constraint",
			conflictKey: "k",
			valueKey: "x",
		});
		const b = cand("b", {
			requiredReason: "constraint",
			conflictKey: "k",
			valueKey: "y",
		});
		expect(selectContext(input([a, b])).coverage.flags).toEqual([]);
		for (const bad of [Number.NaN, -1, 1.5])
			expect(() => selectContext(input([], { maxBytes: bad }))).toThrow();
		expect(() =>
			selectContext(input([], { maxOptionalItems: Number.NaN })),
		).toThrow();
	});
	test("request-kind scopes only apply to their own request; __proto__ scope keys are plain keys", () => {
		const req: ScopeGrant = {
			scopeKey: "request:r0",
			kind: "request",
			revision: "1",
		};
		const r = ready(
			selectContext(
				input([cand("old", { scopeKey: "request:r0", requestId: "r0" })], {
					grants: [COMMON, req],
				}),
			),
		);
		expect(r.optional).toEqual([]);
		const proto: ScopeGrant = {
			scopeKey: "__proto__",
			kind: "task",
			revision: "1",
		};
		const out = selectContext(
			input(
				[
					cand("t", {
						requiredReason: "constraint",
						conflictKey: "k",
						valueKey: "x",
						scopeKey: "__proto__",
						exception: true,
					}),
					cand("p", {
						requiredReason: "constraint",
						conflictKey: "k",
						valueKey: "y",
						scopeKey: PROJ_A.scopeKey,
					}),
				],
				{
					grants: [COMMON, PROJ_A, proto],
					context: {
						requestId: "r1",
						projectScopeKey: PROJ_A.scopeKey,
						taskScopeKey: "__proto__",
					},
				},
			),
		);
		expect(ready(out).required.map((i) => i.id)).toEqual(["t"]);
	});
	test("an updated published item publishes immediately; checkpoint rejects bad numbers", () => {
		const v = buildPublicVersion({
			manifest: [{ itemId: "i", revision: "1" }],
			policyRevision: "p",
			publishedSeq: 5,
		});
		expect(
			decidePublication({
				current: v,
				policyRevision: "p",
				additionThreshold: 9,
				boundary: false,
				changes: [{ itemId: "i", revision: "2", kind: "update", seq: 6 }],
			}),
		).toEqual({ action: "publish", immediate: true, reasons: ["CORRECTION"] });
		const cp: Checkpoint = {
			topicId: "t",
			unresolved: [],
			decisions: [],
			refs: [],
			processedSeq: Number.NaN,
			origin: "deterministic",
			ranges: [],
		};
		expect(validateCheckpoint(cp, null)).toContain("BAD_RANGE");
	});
});

describe("invalid periods and boundary regression", () => {
	const bad = {
		from: { precision: "month", year: 2026, month: 13 },
		basis: "stated",
	} as const;
	test("a malformed period excludes an optional item but holds on a required one", () => {
		const optional = ready(
			selectContext(input([cand("o", { period: bad as never }), cand("ok")])),
		);
		expect(optional.optional.map((i) => i.id)).toEqual(["ok"]);
		expect(optional.coverage.omitted).toContainEqual({
			id: "o",
			reason: "INVALID_PERIOD",
		});
		const required = selectContext(
			input([
				cand("r", { requiredReason: "constraint", period: bad as never }),
			]),
		);
		expect(required.status).toBe("hold");
		expect(required.coverage.unresolved).toEqual([
			{ conflictKey: "invalid_period:r", ids: ["r"] },
		]);
	});
	test("a processed position older than the one used means the database went backwards", () => {
		const selected = ready(selectContext(input([cand("a")])));
		const base: CurrentBasis = {
			principal: "p",
			policyRevision: "pol1",
			selectionPolicyRevision: "sel1",
			grants: [COMMON],
			itemRevisions: { a: "1" },
			requiredDigest: requiredDigestOf([]),
			correctedScopeKeys: [],
		};
		expect(
			revalidateUsage(selected.usage, { ...base, processedSeq: 10 }),
		).toEqual({ status: "valid" });
		expect(
			revalidateUsage(selected.usage, { ...base, processedSeq: 3 }),
		).toEqual({
			status: "invalid",
			reasons: ["BOUNDARY_REGRESSED"],
		});
	});
});

describe("review round 2", () => {
	const stateItem = (over: Record<string, unknown>) =>
		({
			itemId: "state:x",
			scopeKey: COMMON.scopeKey,
			subject: "self",
			kind: "constraint",
			semanticKey: "tone",
			status: "active",
			revision: 1,
			value: { text: "丁寧に", polarity: "affirmed" },
			origin: "user_confirmed",
			evidence: [],
			evidenceOrdinal: 0,
			validFromMs: null,
			validUntilMs: null,
			createdSeq: 1,
			updatedSeq: 1,
			...over,
		}) as never;

	test("the adapter never turns retracted / superseded / other-person items into live candidates", () => {
		const opts = { recordedAtMs: 1, requiredReason: "constraint" as const };
		expect(candidateFromStateItem(stateItem({}), opts)).not.toBeNull();
		for (const status of [
			"retracted",
			"invalidated",
			"disputed",
			"superseded",
			"inactive",
		])
			expect(candidateFromStateItem(stateItem({ status }), opts)).toBeNull();
		for (const status of ["superseded", "inactive"]) {
			// Without the time it stopped applying, an ended item is not offered at all.
			expect(
				candidateFromStateItem(stateItem({ status }), {
					...opts,
					historical: true,
				}),
			).toBeNull();
			const closed = candidateFromStateItem(stateItem({ status }), {
				...opts,
				historical: true,
				endedAtMs: 500,
			});
			expect(closed?.period).toEqual({ untilMs: 500, basis: "stated" });
		}
		for (const status of ["retracted", "invalidated", "disputed"])
			expect(
				candidateFromStateItem(stateItem({ status }), {
					...opts,
					historical: true,
				}),
			).toBeNull();
		expect(
			candidateFromStateItem(
				stateItem({ subject: "other:p1", kind: "other_person_note" }),
				opts,
			),
		).toBeNull();
		expect(candidateFromStateItem(stateItem({}), opts)?.conflictKey).toBe(
			"self:constraint:tone",
		);
	});

	test("grants carry the host's authorization revision, not the scope's content revision", () => {
		expect(grantFromScope({ scopeKey: "s" }, "project", "auth-7")).toEqual({
			scopeKey: "s",
			kind: "project",
			revision: "auth-7",
		});
	});

	test("broken numeric input throws instead of looking like 'nothing found'", () => {
		expect(() =>
			selectContext(
				input([cand("a")], { query: { mode: "current", atMs: Number.NaN } }),
			),
		).toThrow();
		expect(() =>
			selectContext(input([cand("a", { recordedAtMs: Number.NaN })])),
		).toThrow();
		expect(() =>
			selectContext(
				input([cand("a")], {
					query: { mode: "at", atMs: NOW, targetMs: Number.NaN },
				}),
			),
		).toThrow();
	});

	test("a required constraint without a period still applies to a past question; an undated optional item does not", () => {
		const query = { mode: "at", atMs: NOW, targetMs: NOW - 500 } as const;
		const r = ready(
			selectContext(
				input(
					[
						cand("rule", { requiredReason: "prohibition", recordedAtMs: 10 }),
						cand("later", { requiredReason: "prohibition", recordedAtMs: NOW }),
						cand("opt", { recordedAtMs: 10 }),
					],
					{ query },
				),
			),
		);
		expect(r.required.map((i) => i.id)).toEqual(["rule"]);
		expect(r.optional).toEqual([]);
	});

	test("an explicit instruction given now overrides a stored constraint even when it is 'from now on'", () => {
		const stored = cand("stored", {
			requiredReason: "constraint",
			conflictKey: "len",
			valueKey: "short",
		});
		const stated = cand("stated", {
			requiredReason: "constraint",
			conflictKey: "len",
			valueKey: "long",
			explicit: true,
			duration: "ongoing",
		});
		expect(
			ready(selectContext(input([stored, stated]))).required.map((i) => i.id),
		).toEqual(["stated"]);
	});

	test("revalidation notices a used item whose period ended after selection, but only when the host supplies the time", () => {
		const until = Date.UTC(2026, 11, 1);
		const selected = ready(
			selectContext(
				input(
					[
						cand("t", {
							period: {
								until: { precision: "month", year: 2026, month: 11 },
								basis: "stated",
							},
						}),
					],
					{
						query: { mode: "current", atMs: until - 1000 },
					},
				),
			),
		);
		expect(selected.usage.items[0]?.expiresAtMs).toBe(until);
		const base: CurrentBasis = {
			principal: "p",
			policyRevision: "pol1",
			selectionPolicyRevision: "sel1",
			grants: [COMMON],
			itemRevisions: { t: "1" },
			requiredDigest: requiredDigestOf([]),
			correctedScopeKeys: [],
		};
		expect(revalidateUsage(selected.usage, base)).toEqual({ status: "valid" });
		expect(
			revalidateUsage(selected.usage, { ...base, nowMs: until - 1 }),
		).toEqual({ status: "valid" });
		expect(revalidateUsage(selected.usage, { ...base, nowMs: until })).toEqual({
			status: "invalid",
			reasons: ["ITEM_EXPIRED"],
		});
	});

	test("publication and checkpoint reject malformed input and mismatched topics", () => {
		expect(() =>
			buildPublicVersion({
				manifest: [
					{ itemId: "a", revision: "1" },
					{ itemId: "a", revision: "2" },
				],
				policyRevision: "p",
				publishedSeq: 1,
			}),
		).toThrow();
		const v = buildPublicVersion({
			manifest: [],
			policyRevision: "p",
			publishedSeq: 1,
		});
		expect(() =>
			decidePublication({
				current: v,
				policyRevision: "p",
				additionThreshold: 0,
				boundary: false,
				changes: [],
			}),
		).toThrow();
		expect(() =>
			decidePublication({
				current: v,
				policyRevision: "p",
				additionThreshold: 2,
				boundary: false,
				changes: [
					{ itemId: "a", revision: "1", kind: "forget", seq: Number.NaN },
				],
			}),
		).toThrow();
		const a: Checkpoint = {
			topicId: "t1",
			unresolved: [],
			decisions: [],
			refs: [],
			processedSeq: 1,
			origin: "deterministic",
			ranges: [],
		};
		expect(validateCheckpoint({ ...a, topicId: "t2" }, a)).toEqual([
			"TOPIC_MISMATCH",
		]);
	});
});

describe("review round 3", () => {
	test("a superseded required constraint no longer conflicts with its replacement after the replacement started", () => {
		const old = {
			id: "old",
			revision: "1",
			scopeKey: COMMON.scopeKey,
			text: "短く",
			requiredReason: "constraint" as const,
			duration: "ongoing" as const,
			conflictKey: "self:constraint:len",
			valueKey: "affirmed:短く",
			recordedAtMs: 10,
			period: { untilMs: 1000, basis: "stated" as const },
			signals: { explicitRef: false, termMatches: 0, subjectMatch: false },
		};
		const next = {
			...old,
			id: "new",
			text: "詳しく",
			valueKey: "affirmed:詳しく",
			period: { fromMs: 1000, basis: "stated" as const },
		};
		const at = (targetMs: number) =>
			selectContext(
				input([old, next], {
					query: { mode: "at", atMs: NOW, targetMs, basis: "valid_then" },
				}),
			);
		expect(ready(at(1500)).required.map((i) => i.id)).toEqual(["new"]);
		expect(ready(at(500)).required.map((i) => i.id)).toEqual(["old"]);
	});

	test("an unknown-basis period is still validated, never a thrown error out of selection, and is not an expiry", () => {
		const bad = {
			basis: "unknown",
			from: { precision: "year", year: 2030 },
			until: { precision: "year", year: 2027 },
		} as never;
		const r = ready(
			selectContext(input([cand("a", { period: bad }), cand("b")])),
		);
		expect(r.coverage.omitted).toContainEqual({
			id: "a",
			reason: "INVALID_PERIOD",
		});
		const unknownWithEnd = {
			basis: "unknown",
			until: { precision: "year", year: 2999 },
		} as never;
		const s = ready(
			selectContext(input([cand("c", { period: unknownWithEnd })])),
		);
		expect(s.usage.items[0]?.expiresAtMs).toBeNull();
	});

	test("duplicate ids and unknown enums are rejected up front", () => {
		expect(() => selectContext(input([cand("a"), cand("a")]))).toThrow();
		expect(() =>
			selectContext(input([cand("a", { period: null as never })])),
		).toThrow();
		expect(() =>
			selectContext(
				input([cand("a")], {
					grants: [{ ...COMMON, kind: "galaxy" as never }],
				}),
			),
		).toThrow();
	});

	test("checkpoint origin is validated; repeated edits of one item count once toward the publication threshold", () => {
		const cp: Checkpoint = {
			topicId: "t",
			unresolved: [],
			decisions: [],
			refs: [],
			processedSeq: 1,
			origin: "Model_Summary" as never,
			ranges: [],
		};
		expect(validateCheckpoint(cp, null)).toContain("BAD_ORIGIN");
		const v = buildPublicVersion({
			manifest: [],
			policyRevision: "p",
			publishedSeq: 0,
		});
		const edits = [1, 2, 3].map((seq) => ({
			itemId: "same",
			revision: String(seq),
			kind: "add" as const,
			seq,
		}));
		expect(
			decidePublication({
				current: v,
				policyRevision: "p",
				additionThreshold: 2,
				boundary: false,
				changes: edits,
			}),
		).toEqual({ action: "keep", pendingAdditions: 1 });
	});

	test("anyScopeTruncated carries the per-scope truncation into retrieval", () => {
		expect(anyScopeTruncated([{ truncated: false }, { truncated: true }])).toBe(
			true,
		);
		expect(anyScopeTruncated([])).toBe(false);
	});
});

describe("review round 4", () => {
	test("an ended item with an unknown basis stays unknown after its period is closed", () => {
		const item = {
			itemId: "state:u",
			scopeKey: "s",
			subject: "self",
			kind: "constraint",
			semanticKey: "k",
			status: "superseded",
			revision: 1,
			value: { text: "x", polarity: "affirmed" },
			origin: "user_confirmed",
			evidence: [],
			evidenceOrdinal: 0,
			validFromMs: null,
			validUntilMs: null,
			validity: { from: { precision: "year", year: 1960 }, basis: "unknown" },
			createdSeq: 1,
			updatedSeq: 1,
		} as never;
		const c = candidateFromStateItem(item, {
			recordedAtMs: 1,
			historical: true,
			endedAtMs: 5000,
		});
		expect(c?.period?.basis).toBe("unknown");
	});
	test("duplicate scope grants, null dates and missing signals are rejected up front with a path", () => {
		const path = (run: () => unknown) => {
			try {
				run();
			} catch (error) {
				return error instanceof MemoryContractError
					? error.path
					: `raw:${String(error)}`;
			}
			return "no error";
		};
		expect(
			path(() =>
				selectContext(
					input([cand("a")], {
						grants: [COMMON, { ...COMMON, revision: "2" }],
					}),
				),
			),
		).toBe("grants[1].scopeKey");
		expect(
			path(() =>
				selectContext(
					input([
						cand("a", { period: { from: null, basis: "stated" } as never }),
					]),
				),
			),
		).toBe("candidates[0].period.from");
		expect(
			path(() =>
				selectContext(
					input([
						cand("a", { period: { until: null, basis: "stated" } as never }),
					]),
				),
			),
		).toBe("candidates[0].period.until");
		expect(
			path(() =>
				selectContext(input([cand("a", { signals: undefined as never })])),
			),
		).toBe("candidates[0].signals");
	});
	test("a past question before 1970 is accepted by selection", () => {
		const r = ready(
			selectContext(
				input(
					[
						cand("old", {
							recordedAtMs: 0,
							period: {
								from: { precision: "year", year: 1960 },
								until: { precision: "year", year: 1969 },
								basis: "stated",
							},
						}),
					],
					{
						query: {
							mode: "at",
							atMs: NOW,
							targetMs: -157_766_400_000,
							basis: "valid_then",
						},
					},
				),
			),
		);
		expect(r.optional.map((i) => i.id)).toEqual(["old"]);
	});
});
