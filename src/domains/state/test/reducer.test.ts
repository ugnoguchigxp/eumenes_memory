import { describe, expect, test } from "bun:test";
import type {
	StateItemView,
	StateKind,
	StateOrigin,
	StateTransitionAction,
} from "../contracts/index.ts";
import { applyStateTransition } from "../service/reducer.ts";
import type { StateTransitionRequest } from "../service/reducer.ts";
import { stateItemId } from "../service/ids.ts";
import { stateValueEquals } from "../service/value.ts";

const CAUSE = { type: "user", id: "owner" } as const;

describe("stateItemId", () => {
	test("is deterministic, namespaced and depends on every input", () => {
		const id = stateItemId("p", "s", 1);
		expect(id).toBe(stateItemId("p", "s", 1));
		expect(id).toMatch(/^state:[0-9a-f]{64}$/);
		expect(
			new Set([
				id,
				stateItemId("q", "s", 1),
				stateItemId("p", "t", 1),
				stateItemId("p", "s", 2),
			]).size,
		).toBe(4);
	});
});

describe("stateValueEquals", () => {
	test("compares text, polarity and attributes; absent equals empty", () => {
		const base = { text: "a", polarity: "affirmed" } as const;
		expect(stateValueEquals(base, { ...base })).toBe(true);
		expect(stateValueEquals(base, { ...base, attributes: {} })).toBe(true);
		expect(stateValueEquals(base, { ...base, polarity: "negated" })).toBe(
			false,
		);
		expect(stateValueEquals(base, { ...base, text: "b" })).toBe(false);
		expect(
			stateValueEquals(
				{ ...base, attributes: { x: "1", y: "2" } },
				{ ...base, attributes: { y: "2", x: "1" } },
			),
		).toBe(true);
		expect(
			stateValueEquals(
				{ ...base, attributes: { x: "1" } },
				{ ...base, attributes: { x: "2" } },
			),
		).toBe(false);
		expect(stateValueEquals({ ...base, attributes: { x: "1" } }, base)).toBe(
			false,
		);
	});
});

// ---- 乱数なしの決定的な疑似乱数（LCG）で遷移列を流し、不変条件を検査する ----

function lcg(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const ACTIONS: readonly StateTransitionAction[] = [
	"assert",
	"supersede",
	"edit",
	"deactivate",
	"reactivate",
	"activate",
	"dispute",
	"retract",
	"invalidate",
];
const TERMINAL = new Set(["retracted", "invalidated"]);

describe("reducer invariants over random transition sequences", () => {
	for (const seed of [1, 7, 42, 2026, 99991]) {
		test(`seed ${seed}`, () => {
			const next = lcg(seed);
			const pick = <T>(list: readonly T[]): T =>
				list[Math.floor(next() * list.length)] as T;
			const ledger = new Map<string, StateItemView>();
			const kinds: readonly [string, StateKind][] = [
				["self", "preference"],
				["self", "habit"],
				["other:a", "other_person_note"],
			];
			let counter = 0;
			for (let step = 0; step < 1500; step += 1) {
				const [subject, kind] = pick(kinds);
				const semanticKey = pick(["k1", "k2"]);
				const keyMatches = (item: StateItemView) =>
					item.subject === subject &&
					item.kind === kind &&
					item.semanticKey === semanticKey;
				const items = [...ledger.values()];
				const active =
					items.find((item) => item.status === "active" && keyMatches(item)) ??
					null;
				const action = pick(ACTIONS);
				const target =
					action === "assert"
						? null
						: pick(items.length === 0 ? [null] : [...items, null]);
				const identity =
					target === null
						? {
								itemId: `item:${(counter += 1)}`,
								subject: subject as "self",
								kind,
								semanticKey,
							}
						: {
								itemId: `item:${(counter += 1)}`,
								subject: target.subject,
								kind: target.kind,
								semanticKey: target.semanticKey,
							};
				const origin: StateOrigin = pick([
					"user_confirmed",
					"user_edited",
					"admitted_extraction",
				]);
				const expectedRevision =
					action === "assert"
						? null
						: target === null
							? 1
							: next() < 0.8
								? target.revision
								: target.revision + 1;
				const transition: StateTransitionRequest = {
					action,
					expectedRevision,
					identity,
					value: {
						text: pick(["x", "y", "z"]),
						polarity: pick(["affirmed", "negated"] as const),
					},
					origin,
					evidenceOrdinal: Math.floor(next() * 4),
					cause: CAUSE,
				};
				const activeForKey =
					target === null
						? active
						: (items.find(
								(item) =>
									item.status === "active" &&
									item.subject === target.subject &&
									item.kind === target.kind &&
									item.semanticKey === target.semanticKey,
							) ?? null);
				const before = new Map(ledger);
				const result = applyStateTransition(target, transition, {
					atMs: step,
					activeForKey,
				});
				if (!result.ok) {
					expect(ledger).toEqual(before);
					continue;
				}
				expect(result.items.length === 0).toBe(result.events.length === 0);
				for (const view of result.items) {
					const previous = ledger.get(view.itemId);
					if (previous !== undefined) {
						expect(TERMINAL.has(previous.status)).toBe(false);
						expect(view.revision).toBeGreaterThanOrEqual(previous.revision + 1);
					} else {
						expect(view.revision).toBeGreaterThanOrEqual(1);
					}
					ledger.set(view.itemId, view);
				}
				// 各 event は変更前の revision から始まり、item ごとに連続している。
				const lastRevision = new Map<string, number | null>();
				for (const event of result.events) {
					const known = lastRevision.has(event.itemId)
						? lastRevision.get(event.itemId)
						: (before.get(event.itemId)?.revision ?? null);
					expect(event.fromRevision).toBe(known ?? null);
					expect(event.toRevision).toBe((event.fromRevision ?? 0) + 1);
					lastRevision.set(event.itemId, event.toRevision);
				}
				const seen = new Set<string>();
				for (const item of ledger.values()) {
					if (item.status !== "active") continue;
					const key = JSON.stringify([
						item.subject,
						item.kind,
						item.semanticKey,
					]);
					expect(seen.has(key)).toBe(false);
					seen.add(key);
				}
			}
		});
	}
});

// ---- レビュー B: supersede の guard、origin の昇格、同 key の履歴 ----

function view(overrides: Partial<StateItemView> = {}): StateItemView {
	return {
		itemId: "item:a",
		subject: "self",
		kind: "preference",
		semanticKey: "drink",
		status: "active",
		revision: 1,
		value: { text: "コーヒー", polarity: "affirmed" },
		origin: "admitted_extraction",
		evidenceOrdinal: 5,
		...overrides,
	};
}

const IDENTITY = {
	itemId: "item:new",
	subject: "self",
	kind: "preference",
	semanticKey: "drink",
} as const;

function request(
	overrides: Partial<StateTransitionRequest> = {},
): StateTransitionRequest {
	return {
		action: "assert",
		expectedRevision: null,
		identity: IDENTITY,
		value: { text: "紅茶", polarity: "affirmed" },
		origin: "admitted_extraction",
		evidenceOrdinal: 9,
		cause: CAUSE,
		...overrides,
	};
}

describe("supersede guards", () => {
	test("a different key is REPLACES_MISMATCH even when the context has no active item for the new key", () => {
		const current = view();
		for (const identity of [
			{ ...IDENTITY, semanticKey: "other" },
			{ ...IDENTITY, kind: "habit" },
			{ ...IDENTITY, subject: "other:mother", kind: "other_person_note" },
		] as const) {
			expect(
				applyStateTransition(
					current,
					request({ action: "supersede", expectedRevision: 1, identity }),
					{ atMs: 1, activeForKey: null },
				),
			).toEqual({ ok: false, reasonCode: "REPLACES_MISMATCH" });
		}
	});

	test("a context whose active item for the key is another item is REPLACES_MISMATCH (inconsistent host input)", () => {
		const current = view();
		const other = view({ itemId: "item:other" });
		expect(
			applyStateTransition(
				current,
				request({ action: "supersede", expectedRevision: 1 }),
				{ atMs: 1, activeForKey: other },
			),
		).toEqual({ ok: false, reasonCode: "REPLACES_MISMATCH" });
		// 対照: 一致していれば置き換わる
		expect(
			applyStateTransition(
				current,
				request({ action: "supersede", expectedRevision: 1 }),
				{ atMs: 1, activeForKey: current },
			),
		).toMatchObject({ ok: true });
	});
});

describe("origin promotion", () => {
	const confirm = (origin: "user_confirmed" | "user_edited") =>
		request({
			origin,
			evidenceOrdinal: 1,
			value: { text: "コーヒー", polarity: "affirmed" },
		});

	test("assert / supersede / edit with the same value raise an extraction item to the user origin, once", () => {
		const current = view();
		const context = { atMs: 7, activeForKey: current };
		const promoted = applyStateTransition(
			null,
			confirm("user_confirmed"),
			context,
		);
		expect(promoted).toEqual({
			ok: true,
			items: [{ ...current, revision: 2, origin: "user_confirmed" }],
			events: [
				{
					itemId: "item:a",
					action: "edit",
					fromRevision: 1,
					toRevision: 2,
					cause: CAUSE,
					atMs: 7,
				},
			],
		});
		expect(
			applyStateTransition(
				current,
				{ ...confirm("user_edited"), action: "supersede", expectedRevision: 1 },
				context,
			),
		).toMatchObject({
			ok: true,
			items: [{ origin: "user_edited", revision: 2 }],
		});
		expect(
			applyStateTransition(
				current,
				{
					action: "edit",
					expectedRevision: 1,
					value: { text: "コーヒー", polarity: "affirmed" },
					origin: "user_edited",
					cause: CAUSE,
				},
				context,
			),
		).toMatchObject({
			ok: true,
			items: [{ origin: "user_edited", revision: 2, evidenceOrdinal: 5 }],
		});
		// 既に user 由来なら変化なし／抽出由来の同値は変化なし
		const userItem = view({ origin: "user_confirmed" });
		for (const origin of [
			"user_confirmed",
			"user_edited",
			"admitted_extraction",
		] as const) {
			expect(
				applyStateTransition(null, confirm(origin as "user_confirmed"), {
					atMs: 7,
					activeForKey: userItem,
				}),
			).toEqual({ ok: true, items: [], events: [] });
		}
		expect(
			applyStateTransition(
				null,
				request({ value: { text: "コーヒー", polarity: "affirmed" } }),
				context,
			),
		).toEqual({ ok: true, items: [], events: [] });
	});

	test("an inactive / disputed item is not promoted by assert (no active item is involved)", () => {
		const inactive = view({ status: "inactive" });
		expect(
			applyStateTransition(null, confirm("user_confirmed"), {
				atMs: 1,
				activeForKey: inactive,
			}),
		).toEqual({ ok: false, reasonCode: "INVALID_TRANSITION" });
	});
});

describe("key history", () => {
	const extraction = (ordinal: number) =>
		request({ origin: "admitted_extraction", evidenceOrdinal: ordinal });
	const history = (disputedMaxOrdinal: number | null, userRemoved = false) => ({
		disputedMaxOrdinal,
		userRemoved,
	});

	test("without an active item: older than the disputed maximum is OLDER_EVIDENCE; equal or newer joins the dispute", () => {
		const context = (h: ReturnType<typeof history>) => ({
			atMs: 3,
			activeForKey: null,
			keyHistory: h,
		});
		expect(
			applyStateTransition(null, extraction(4), context(history(5))),
		).toEqual({
			ok: false,
			reasonCode: "OLDER_EVIDENCE",
		});
		const joined = applyStateTransition(
			null,
			extraction(5),
			context(history(5)),
		);
		expect(joined).toMatchObject({
			ok: true,
			items: [{ itemId: "item:new", status: "disputed", revision: 2 }],
			events: [
				{
					itemId: "item:new",
					action: "assert",
					fromRevision: null,
					toRevision: 1,
				},
				{
					itemId: "item:new",
					action: "dispute",
					fromRevision: 1,
					toRevision: 2,
				},
			],
		});
		expect(
			applyStateTransition(null, extraction(9), context(history(5))),
		).toMatchObject({
			ok: true,
			items: [{ status: "disputed" }],
		});
		// 履歴なし（省略 / disputed なし）は従来どおり active
		expect(
			applyStateTransition(null, extraction(1), {
				atMs: 3,
				activeForKey: null,
			}),
		).toMatchObject({
			ok: true,
			items: [{ status: "active" }],
		});
		expect(
			applyStateTransition(null, extraction(1), context(history(null))),
		).toMatchObject({
			ok: true,
			items: [{ status: "active" }],
		});
	});

	test("explicit (user) writes ignore the history", () => {
		const context = {
			atMs: 3,
			activeForKey: null,
			keyHistory: history(5, true),
		};
		expect(
			applyStateTransition(
				null,
				request({ origin: "user_confirmed", evidenceOrdinal: 1 }),
				context,
			),
		).toMatchObject({ ok: true, items: [{ status: "active" }] });
	});

	test("a user-removed key is not revived by an extraction write, with or without an active item", () => {
		const removed = history(null, true);
		expect(
			applyStateTransition(null, extraction(9), {
				atMs: 3,
				activeForKey: null,
				keyHistory: removed,
			}),
		).toEqual({ ok: false, reasonCode: "INVALID_TRANSITION" });
		const current = view({ origin: "user_confirmed" });
		expect(
			applyStateTransition(
				current,
				request({
					action: "supersede",
					expectedRevision: 1,
					origin: "admitted_extraction",
					evidenceOrdinal: 9,
				}),
				{ atMs: 3, activeForKey: current, keyHistory: removed },
			),
		).toEqual({ ok: false, reasonCode: "INVALID_TRANSITION" });
	});

	test("with an active item: older than the disputed maximum is OLDER_EVIDENCE even if newer than the active item", () => {
		const active = view({ evidenceOrdinal: 3 });
		expect(
			applyStateTransition(null, extraction(6), {
				atMs: 3,
				activeForKey: active,
				keyHistory: history(8),
			}),
		).toEqual({ ok: false, reasonCode: "OLDER_EVIDENCE" });
		expect(
			applyStateTransition(null, extraction(9), {
				atMs: 3,
				activeForKey: active,
				keyHistory: history(8),
			}),
		).toMatchObject({
			ok: true,
			items: [{ status: "superseded" }, { status: "active" }],
		});
	});
});
