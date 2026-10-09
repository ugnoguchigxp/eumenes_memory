/**
 * 選択の結合シナリオ: 実 SQLite の State（共通Profile と 2 つの Project）を `listStateScopes` で読み、
 * `candidateFromStateItem` → `selectContext` → `revalidateUsage`。公開面だけを使う。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	candidateFromStateItem,
	grantFromScope,
	requiredDigestOf,
	revalidateUsage,
	selectContext,
} from "eumenes-memory";
import type {
	CurrentBasis,
	ScopeGrant,
	SelectionCandidate,
	SelectionInput,
	StateItem,
} from "eumenes-memory";
import {
	assertUserState,
	listStateScopes,
	retractState,
} from "eumenes-memory/sqlite";
import { openTestStore } from "./../support/store.ts";
import type { TestStore } from "./../support/store.ts";
import {
	ACCESS,
	makeSource,
	makeSpan,
	value,
} from "../../src/domains/state/testing.ts";

const COMMON = "user:common";
const PROJ_A = "project:a";
const PROJ_B = "project:b";
const access = { ...ACCESS, scopeKeys: [COMMON, PROJ_A, PROJ_B] };
const NOW = 1_800_000_000_000;

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function put(
	s: TestStore,
	scopeKey: string,
	kind: "preference" | "constraint",
	key: string,
	text: string,
	extra: Record<string, unknown> = {},
): StateItem {
	const source = makeSource(
		`m-${scopeKey}-${key}`,
		`${text}です。`,
		5,
		{},
		scopeKey,
	);
	const result = s.write((db) =>
		assertUserState(db, {
			contractVersion: 1,
			access,
			scopeKey,
			clock: { atMs: 10 },
			kind,
			subject: "self",
			semanticKey: key,
			value: value(text),
			evidence: [makeSpan(source, text)],
			sources: [source],
			origin: "user_confirmed",
			...extra,
		}),
	);
	if (result.status !== "applied") throw new Error(JSON.stringify(result));
	return result.item;
}

function read(s: TestStore, scopeKeys: string[]) {
	const result = s.read((db) =>
		listStateScopes(db, { contractVersion: 1, access, scopeKeys }),
	);
	if (result.status !== "ok") throw new Error("blocked");
	return result.scopes;
}

function inputFor(
	scopes: ReturnType<typeof read>,
	kinds: Record<string, "user_common" | "project">,
	over: Partial<SelectionInput> = {},
): SelectionInput {
	const grants: ScopeGrant[] = scopes.map((s) =>
		grantFromScope(s, kinds[s.scopeKey] ?? "project", "auth-1"),
	);
	const candidates: SelectionCandidate[] = [];
	for (const scope of scopes) {
		for (const item of scope.items) {
			const candidate = candidateFromStateItem(item, {
				recordedAtMs: NOW - 1000,
				...(item.kind === "constraint"
					? { requiredReason: "constraint" as const }
					: {}),
			});
			if (candidate !== null) candidates.push(candidate);
		}
	}
	return {
		principal: access.principal,
		grants,
		context: { requestId: "r1", projectScopeKey: PROJ_A },
		query: { mode: "current", atMs: NOW },
		candidates,
		maxBytes: 2000,
		maxOptionalItems: 10,
		policyRevision: "1",
		selectionPolicyRevision: "s1",
		retrieval: {
			searchedScopeKeys: scopes.map((s) => s.scopeKey),
			truncated: false,
			processedSeq: 1,
			headSeq: 1,
			pendingCorrections: 0,
		},
		...over,
	};
}
const KINDS = {
	[COMMON]: "user_common",
	[PROJ_A]: "project",
	[PROJ_B]: "project",
} as const;

describe("multi-scope selection over real State", () => {
	test("common profile is used with the active project, other projects stay out, without copying", () => {
		const s = (store = openTestStore());
		put(s, COMMON, "preference", "drink", "コーヒーが好き");
		put(s, PROJ_A, "preference", "ide", "Zedを使う");
		put(s, PROJ_B, "preference", "ide", "Vimを使う");
		const scopes = read(s, [COMMON, PROJ_A, PROJ_B]);
		const result = selectContext(inputFor(scopes, KINDS));
		if (result.status !== "ready") throw new Error(JSON.stringify(result));
		const scopesUsed = result.optional.map((i) => i.scopeKey).sort();
		expect(scopesUsed).toEqual([COMMON, PROJ_A].sort());
		expect(result.coverage.omitted).toContainEqual(
			expect.objectContaining({ reason: "SCOPE_NOT_ACTIVE" }),
		);
		expect(result.usage.grants.map((g) => g.scopeKey).sort()).toEqual(
			[COMMON, PROJ_A].sort(),
		);
	});

	test("an expired period is not part of the current understanding but is the answer to a past question", () => {
		const s = (store = openTestStore());
		const old = put(s, COMMON, "preference", "editor", "Vimを使う", {
			validity: {
				until: { precision: "month", year: 2026, month: 8 },
				basis: "stated",
			},
		});
		const scopes = read(s, [COMMON]);
		const base = inputFor(scopes, KINDS);
		const now = selectContext(base);
		expect(now.status === "ready" && now.optional).toEqual([]);
		const past = selectContext({
			...base,
			candidates: scopes[0]!.items.flatMap((item) => {
				const candidate = candidateFromStateItem(item, { recordedAtMs: 5 });
				return candidate === null ? [] : [candidate];
			}),
			query: {
				mode: "at",
				atMs: NOW,
				targetMs: Date.UTC(2026, 2, 1),
				basis: "valid_then",
			},
		});
		expect(past.status === "ready" && past.optional.map((i) => i.id)).toEqual([
			old.itemId,
		]);
	});

	test("conflicting required constraints across scopes hold unless the project one is a marked exception", () => {
		const s = (store = openTestStore());
		put(s, COMMON, "constraint", "length", "短く答える");
		put(s, PROJ_A, "constraint", "length", "詳しく答える");
		const scopes = read(s, [COMMON, PROJ_A]);
		expect(selectContext(inputFor(scopes, KINDS)).status).toBe("hold");
		const withException = inputFor(scopes, KINDS);
		const marked = {
			...withException,
			candidates: withException.candidates.map((c) =>
				c.scopeKey === PROJ_A ? { ...c, exception: true } : c,
			),
		};
		const result = selectContext(marked);
		expect(
			result.status === "ready" && result.required.map((r) => r.scopeKey),
		).toEqual([PROJ_A]);
	});

	test("revalidation: an unrelated project change keeps the answer, a retracted used item or a new constraint does not", () => {
		const s = (store = openTestStore());
		const used = put(s, COMMON, "constraint", "tone", "丁寧に答える");
		put(s, PROJ_B, "preference", "ide", "Vimを使う");
		const scopes = read(s, [COMMON, PROJ_A, PROJ_B]);
		const input = inputFor(scopes, KINDS);
		const result = selectContext(input);
		if (result.status !== "ready") throw new Error("not ready");

		const currentFor = (): { current: CurrentBasis; input: SelectionInput } => {
			const now = read(s, [COMMON, PROJ_A, PROJ_B]);
			const again = inputFor(now, KINDS);
			const next = selectContext(again);
			if (next.status !== "ready") throw new Error("not ready");
			return {
				input: again,
				current: {
					principal: access.principal,
					policyRevision: "1",
					selectionPolicyRevision: "s1",
					grants: again.grants,
					itemRevisions: Object.fromEntries(
						now.flatMap((sc) =>
							sc.items.map((i) => [i.itemId, String(i.revision)]),
						),
					),
					requiredDigest: requiredDigestOf(next.required),
					correctedScopeKeys: [],
				},
			};
		};

		// unrelated: another project's preference changes
		put(s, PROJ_B, "preference", "shell", "zshを使う");
		expect(revalidateUsage(result.usage, currentFor().current)).toEqual({
			status: "valid",
		});

		// an unrelated write in a scope that was used (content revision moved, nothing used changed)
		put(s, COMMON, "preference", "pet", "猫が好き");
		expect(revalidateUsage(result.usage, currentFor().current)).toEqual({
			status: "valid",
		});

		// a new required constraint in a used scope
		put(s, COMMON, "constraint", "format", "箇条書きにしない");
		const added = revalidateUsage(result.usage, currentFor().current);
		expect(added.status).toBe("invalid");
		expect(added.status === "invalid" && added.reasons).toContain(
			"REQUIRED_SET_CHANGED",
		);

		// retracting a used item
		s.write((db) =>
			retractState(db, {
				contractVersion: 1,
				access,
				scopeKey: COMMON,
				clock: { atMs: 20 },
				itemId: used.itemId,
				expectedRevision: used.revision,
			}),
		);
		const retracted = revalidateUsage(result.usage, currentFor().current);
		expect(retracted.status === "invalid" && retracted.reasons).toEqual(
			expect.arrayContaining(["ITEM_CHANGED"]),
		);
	});
});
