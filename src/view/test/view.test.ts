import { describe, expect, test } from "bun:test";
import { baseInput } from "../../contracts/test/base.ts";
import { sha256Hex } from "../../canonical/sha256.ts";
import { encodeUtf8 } from "../../canonical/utf8.ts";
import type {
	BuildMemoryViewInput,
	MemoryView,
	SourceRef,
	Snapshot,
} from "../../contracts/types.ts";
import { checkAccess } from "../access-check.ts";
import { buildMemoryView } from "../build.ts";
import { composeReadyBody } from "../compose.ts";
import { checkDependencies, indexSources } from "../dependency-check.ts";
import { computeViewDigest, finalizeReadyView } from "../digest.ts";
import { compareSourceRef, sourceKey } from "../source-ref.ts";

function ref(over: Partial<SourceRef> = {}): SourceRef {
	return {
		namespace: "conversation",
		kind: "message",
		id: "m1",
		representation: "text",
		revision: "r1",
		digest: "a".repeat(64),
		...over,
	};
}

describe("compareSourceRef", () => {
	const sorted: SourceRef[] = [
		ref({ namespace: "a" }),
		ref({ kind: "a" }),
		ref({ id: "m0" }),
		ref({ id: "m1" }),
		ref({ id: "m1", revision: "r2" }),
		ref({ id: "m1", revision: "r2", digest: "b".repeat(64) }),
		ref({
			id: "m1",
			revision: "r2",
			digest: "b".repeat(64),
			range: { startByte: 0, endByte: 9 },
		}),
		ref({
			id: "m1",
			revision: "r2",
			digest: "b".repeat(64),
			range: { startByte: 2, endByte: 3 },
		}),
		ref({
			id: "m1",
			revision: "r2",
			digest: "b".repeat(64),
			range: { startByte: 2, endByte: 10 },
		}),
		ref({
			id: "m1",
			revision: "r2",
			digest: "b".repeat(64),
			range: { startByte: 10, endByte: 11 },
		}),
	];
	test("absent representation sorts before present; range compares numerically", () => {
		const { representation: _r, ...noRep } = ref();
		expect(compareSourceRef(noRep, ref())).toBe(-1);
		expect(compareSourceRef(ref(), noRep)).toBe(1);
		expect(compareSourceRef(noRep, { ...noRep })).toBe(0);
		for (let i = 0; i + 1 < sorted.length; i += 1) {
			const a = sorted[i] as SourceRef;
			const b = sorted[i + 1] as SourceRef;
			// namespace "a" < "conversation"; skip the first two cross-field pairs
			if (i >= 2) {
				expect(compareSourceRef(a, b)).toBe(-1);
				expect(compareSourceRef(b, a)).toBe(1);
			}
		}
		// absent range < present range
		expect(
			compareSourceRef(ref(), ref({ range: { startByte: 0, endByte: 1 } })),
		).toBe(-1);
	});

	test("compares by UTF-16 code unit (astral before U+FF5E)", () => {
		expect(compareSourceRef(ref({ id: "\u{1F600}" }), ref({ id: "～" }))).toBe(
			-1,
		);
	});

	test("sourceKey distinguishes absent representation from any string", () => {
		const { representation: _r, ...noRep } = ref();
		expect(sourceKey(noRep)).not.toBe(sourceKey(ref({ representation: "" })));
		expect(sourceKey(noRep)).not.toBe(sourceKey(ref()));
		expect(sourceKey(ref())).toBe(sourceKey(ref({ revision: "other" })));
	});
});

describe("checkAccess", () => {
	const input = baseInput();
	const access = input.access;
	const snapshot: Snapshot = input.snapshot;
	test("passes for matching access", () => {
		expect(checkAccess(access, snapshot)).toBeNull();
	});
	test("priority: principal > scope > policy > complete", () => {
		const all = {
			...snapshot,
			principal: "x",
			scopeKey: "y",
			policyRevision: "z",
			complete: false,
		};
		expect(checkAccess(access, all)).toBe("PRINCIPAL_MISMATCH");
		expect(checkAccess(access, { ...all, principal: access.principal })).toBe(
			"SCOPE_NOT_PERMITTED",
		);
		expect(
			checkAccess(access, {
				...all,
				principal: access.principal,
				scopeKey: snapshot.scopeKey,
			}),
		).toBe("POLICY_REVISION_MISMATCH");
		expect(checkAccess(access, { ...snapshot, complete: false })).toBe(
			"SNAPSHOT_INCOMPLETE",
		);
	});
});

describe("checkDependencies", () => {
	const snapshot: Snapshot = baseInput().snapshot;
	const itemsOf = (...refs: SourceRef[]) => [{ dependencies: refs }];
	const m1 = snapshot.items.find((i) => i.id === "continuity:g1")
		?.primarySource as SourceRef;

	test("passes the base snapshot", () => {
		expect(checkDependencies(snapshot.items, snapshot)).toBeNull();
	});

	test("empty item list passes", () => {
		expect(checkDependencies([], snapshot)).toBeNull();
	});

	test("range endpoints: end of content ok, +1 out of bounds, mid-char rejected", () => {
		const ok = { ...m1, range: { startByte: 0, endByte: 51 } };
		expect(checkDependencies(itemsOf(ok), snapshot)).toBeNull();
		const oob = { ...m1, range: { startByte: 0, endByte: 52 } };
		expect(checkDependencies(itemsOf(oob), snapshot)).toBe(
			"SOURCE_RANGE_OUT_OF_BOUNDS",
		);
		const mid = { ...m1, range: { startByte: 1, endByte: 3 } };
		expect(checkDependencies(itemsOf(mid), snapshot)).toBe(
			"SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		);
		const midEnd = { ...m1, range: { startByte: 0, endByte: 2 } };
		expect(checkDependencies(itemsOf(midEnd), snapshot)).toBe(
			"SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		);
	});

	test("same-input repeated calls are independent (no shared memo)", () => {
		const bad = {
			...snapshot,
			sources: snapshot.sources.map((s) =>
				s.id === "m1" && s.content !== undefined
					? { ...s, content: `${s.content}x` }
					: s,
			),
		};
		const deps = itemsOf(m1);
		expect(checkDependencies(deps, bad)).toBe("SOURCE_CONTENT_DIGEST_MISMATCH");
		expect(checkDependencies(deps, snapshot)).toBeNull();
		expect(checkDependencies(deps, bad)).toBe("SOURCE_CONTENT_DIGEST_MISMATCH");
	});

	test("content digest is checked even without a range", () => {
		const bad = {
			...snapshot,
			sources: snapshot.sources.map((s) =>
				s.id === "m1" && s.content !== undefined
					? { ...s, content: "changed" }
					: s,
			),
		};
		expect(checkDependencies(itemsOf({ ...m1 }), bad)).toBe(
			"SOURCE_CONTENT_DIGEST_MISMATCH",
		);
	});

	test("state principal mismatch is SOURCE_NOT_PERMITTED", () => {
		const bad = {
			...snapshot,
			sources: snapshot.sources.map((s) =>
				s.id === "m1" ? { ...s, principal: "other" } : s,
			),
		};
		expect(checkDependencies(itemsOf(m1), bad)).toBe("SOURCE_NOT_PERMITTED");
	});

	test("indexSources keys by (namespace, kind, id, representation)", () => {
		const index = indexSources(snapshot.sources);
		expect(index.size).toBe(snapshot.sources.length);
		expect(index.get(sourceKey(m1))?.id).toBe("m1");
	});

	test("content digest equals sha256 of the UTF-8 bytes", () => {
		const state = snapshot.sources.find((s) => s.id === "m1");
		expect(sha256Hex(encodeUtf8(state?.content ?? ""))).toBe(
			state?.digest ?? "",
		);
	});
});

describe("compose / digest", () => {
	const input: BuildMemoryViewInput = baseInput();

	test("composeReadyBody shares no object with the input", () => {
		const body = composeReadyBody(input.access, input.snapshot);
		const inputObjects = new Set<unknown>();
		const collect = (value: unknown): void => {
			if (typeof value === "object" && value !== null) {
				inputObjects.add(value);
				Object.values(value).forEach(collect);
			}
		};
		collect(input);
		const check = (value: unknown): void => {
			if (typeof value === "object" && value !== null) {
				expect(inputObjects.has(value)).toBe(false);
				Object.values(value).forEach(check);
			}
		};
		check(body);
	});

	test("finalizeReadyView: digest covers the body and byte length covers the digest", () => {
		const body = composeReadyBody(input.access, input.snapshot);
		const { view, byteLength } = finalizeReadyView(body);
		expect(view.viewDigest).toBe(computeViewDigest(body));
		expect(byteLength).toBe(Buffer.byteLength(JSON.stringify(view), "utf8"));
	});

	test("digest changes with every body field (spot checks)", () => {
		const body = composeReadyBody(input.access, input.snapshot);
		const base = computeViewDigest(body);
		for (const changed of [
			{ ...body, purpose: "other" },
			{ ...body, stateRevision: "8" },
			{ ...body, policyRevision: "2" },
			{ ...body, principal: "p" },
			{ ...body, scopeKey: "s" },
			{ ...body, items: body.items.slice(1) },
		]) {
			expect(computeViewDigest(changed)).not.toBe(base);
		}
	});
});

describe("buildMemoryView", () => {
	test("output shares no object with the input and is frozen", () => {
		const input = baseInput();
		const view = buildMemoryView(input);
		expect(view.status).toBe("ready");
		const inputObjects = new Set<unknown>();
		const collect = (value: unknown): void => {
			if (typeof value === "object" && value !== null) {
				inputObjects.add(value);
				Object.values(value).forEach(collect);
			}
		};
		collect(input);
		const check = (value: unknown): void => {
			if (typeof value === "object" && value !== null) {
				expect(inputObjects.has(value)).toBe(false);
				expect(Object.isFrozen(value)).toBe(true);
				Object.values(value).forEach(check);
			}
		};
		check(view);
	});

	test("mutating the input afterwards does not change an earlier result", () => {
		const input = baseInput();
		const view = buildMemoryView(input);
		const snapshot = JSON.stringify(view);
		input.snapshot.items[0].text = "changed";
		input.snapshot.items[1].dependencies[0].id = "zzz";
		expect(JSON.stringify(view)).toBe(snapshot);
	});

	test("non-ready views never include item text", () => {
		const input = baseInput();
		input.snapshot.sources[1].status = "missing";
		const view: MemoryView = buildMemoryView(input);
		expect(view.status).toBe("blocked");
		expect(JSON.stringify(view)).not.toContain(input.snapshot.items[0].text);
		expect(Object.keys(view).sort()).toEqual(
			[
				"instructionAuthority",
				"policyRevision",
				"principal",
				"purpose",
				"reasonCode",
				"schemaVersion",
				"scopeKey",
				"stateRevision",
				"status",
			].sort(),
		);
	});

	test("header values come from access (principal/purpose/policy) and snapshot (scope/state)", () => {
		const input = baseInput();
		input.enabled = false;
		input.access.principal = "p:access";
		input.snapshot.principal = "p:snapshot";
		input.access.policyRevision = "pa";
		input.snapshot.policyRevision = "ps";
		input.snapshot.scopeKey = "conversation:zzz";
		input.snapshot.stateRevision = "99";
		const view = buildMemoryView(input);
		expect(view).toMatchObject({
			status: "disabled",
			principal: "p:access",
			policyRevision: "pa",
			purpose: "dialogue.generate",
			scopeKey: "conversation:zzz",
			stateRevision: "99",
			instructionAuthority: "none",
		});
	});

	test("budget is judged on the whole final JSON including viewDigest", () => {
		const input = baseInput();
		const ready = buildMemoryView(input);
		const exact = Buffer.byteLength(JSON.stringify(ready), "utf8");
		input.maxBytes = exact;
		expect(buildMemoryView(input).status).toBe("ready");
		input.maxBytes = exact - 1;
		expect(buildMemoryView(input).status).toBe("overflow");
		// 本文だけの大きさでは通らない: viewDigest(64) + キー分が必要
		const textBytes =
			ready.status === "ready"
				? ready.items.reduce((n, i) => n + Buffer.byteLength(i.text), 0)
				: 0;
		input.maxBytes = textBytes;
		expect(buildMemoryView(input).status).toBe("overflow");
	});

	test("inactive items are neither emitted nor dependency-checked", () => {
		const input = baseInput();
		input.snapshot.items[0].status = "inactive";
		input.snapshot.sources = input.snapshot.sources.filter(
			(s: any) => s.id !== "m3",
		);
		// g1 still depends on m3 -> blocked; deactivate g1 as well
		input.snapshot.items[1].status = "inactive";
		const view = buildMemoryView(input);
		expect(view.status).toBe("ready");
		if (view.status === "ready") {
			expect(view.items.map((i) => i.id)).toEqual(["continuity:d1"]);
			expect(view.dependencies.map((d) => d.id)).toEqual(["m2"]);
		}
	});
});
