import { afterEach, describe, expect, test } from "bun:test";
import { isMemoryContractError } from "../../../contracts/errors.ts";
import type { AccessContext } from "../../../contracts/types.ts";
import { recordIdOf, recordSourceRef } from "../service/identity.ts";
import {
	captureRecord,
	deactivateRecord,
	reactivateRecord,
	readRecord,
	readRecordRange,
	recordSourceStates,
} from "../repository/index.ts";
import { listMemoryChanges } from "../../../infrastructure/sqlite/changes.ts";
import { readScopeRevision } from "../../../infrastructure/sqlite/scope-state.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(): TestStore {
	store = openTestStore();
	return store;
}

const ACCESS: AccessContext = {
	principal: "local:owner",
	scopeKeys: ["conversation:a", "conversation:b"],
	purpose: "test",
	policyRevision: "1",
};
const CLOCK = { atMs: 1000 } as const;

function capture(
	overrides: Record<string, unknown> = {},
): Parameters<typeof captureRecord>[1] {
	return {
		contractVersion: 1,
		access: ACCESS,
		scopeKey: "conversation:a",
		clock: CLOCK,
		origin: { namespace: "web", kind: "page", id: "https://example.test/a" },
		mediaType: "text/plain",
		content: "hello world",
		captureState: "complete",
		...overrides,
	} as Parameters<typeof captureRecord>[1];
}

function id(
	origin = "https://example.test/a",
	scope = "conversation:a",
): string {
	return recordIdOf("local:owner", scope, {
		namespace: "web",
		kind: "page",
		id: origin,
	});
}

describe("captureRecord", () => {
	test("creates a record, is idempotent for identical content, and versions changed content", () => {
		const s = open();
		const first = s.write((db) => captureRecord(db, capture()));
		expect(first).toMatchObject({ status: "captured", created: true });
		if (first.status !== "captured") throw new Error("unreachable");
		expect(first.recordId).toBe(id());
		expect(first.revision).toBe(`sha256:${first.digest}`);
		expect(first.ref).toEqual(
			recordSourceRef(first.recordId, first.revision, first.digest),
		);

		const again = s.write((db) => captureRecord(db, capture()));
		expect(again).toMatchObject({
			status: "captured",
			created: false,
			revision: first.revision,
		});

		const next = s.write((db) =>
			captureRecord(db, capture({ content: "hello again" })),
		);
		expect(next).toMatchObject({ status: "captured", created: true });
		if (next.status !== "captured") throw new Error("unreachable");
		expect(next.recordId).toBe(first.recordId);
		expect(next.revision).not.toBe(first.revision);

		// 旧 revision の本文も読める。省略時は current。
		const read = (revision?: string) =>
			s.read((db) =>
				readRecord(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: "conversation:a",
					recordId: first.recordId,
					...(revision === undefined ? {} : { revision }),
				}),
			);
		expect(read()).toMatchObject({
			status: "available",
			content: "hello again",
			revision: next.revision,
		});
		expect(read(first.revision)).toMatchObject({
			status: "available",
			content: "hello world",
		});
		expect(read("sha256:nope")).toEqual({ status: "missing" });
		// 旧 revision に戻すと current が戻る
		const back = s.write((db) => captureRecord(db, capture()));
		expect(back).toMatchObject({ created: true, revision: first.revision });
		expect(read()).toMatchObject({ content: "hello world" });
	});

	test("same origin in another scope is another record; blocked outside access", () => {
		const s = open();
		const a = s.write((db) => captureRecord(db, capture()));
		const b = s.write((db) =>
			captureRecord(db, capture({ scopeKey: "conversation:b" })),
		);
		if (a.status !== "captured" || b.status !== "captured")
			throw new Error("unreachable");
		expect(a.recordId).not.toBe(b.recordId);
		expect(
			s.write((db) =>
				captureRecord(db, capture({ scopeKey: "conversation:z" })),
			),
		).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
	});

	test("input validation throws contract errors before touching the database", () => {
		const s = open();
		const bad = (overrides: Record<string, unknown>) => {
			try {
				s.write((db) => captureRecord(db, capture(overrides)));
			} catch (error) {
				if (isMemoryContractError(error)) return `${error.code}@${error.path}`;
				throw error;
			}
			return "no error";
		};
		expect(bad({ content: "a\u0000b" })).toBe("INVALID_STRING@$.content");
		expect(bad({ content: "\ud800" })).toBe("INVALID_STRING@$.content");
		expect(bad({ mediaType: "image/png" })).toBe("INVALID_ENUM@$.mediaType");
		expect(bad({ extra: 1 })).toBe("UNKNOWN_KEY@$");
		expect(bad({ contractVersion: 2 })).toBe(
			"UNSUPPORTED_SCHEMA_VERSION@$.contractVersion",
		);
		expect(bad({ providerRef: "Bad:Ref" })).toBe(
			"INVALID_ID_FORMAT@$.providerRef",
		);
		expect(bad({ content: "x".repeat(1048577) })).toBe(
			"STRING_TOO_LONG@$.content",
		);
	});

	test("requires a write transaction and a writable connection", () => {
		const s = open();
		expect(() => captureRecord(s.writer, capture())).toThrow();
		expect(() => s.read((db) => captureRecord(db, capture()))).toThrow();
	});

	test("bumps the scope revision and appends to the change feed (no body)", () => {
		const s = open();
		s.write((db) => captureRecord(db, capture()));
		s.write((db) => captureRecord(db, capture())); // 変化なし
		expect(readScopeRevision(s.writer, "local:owner", "conversation:a")).toBe(
			1,
		);
		const feed = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: ["conversation:a"],
				afterSeq: 0,
				limit: 10,
			}),
		);
		if (feed.status !== "ok") throw new Error("unreachable");
		expect(feed.changes).toHaveLength(1);
		expect(feed.changes[0]).toMatchObject({
			targetType: "record",
			status: "active",
			targetId: id(),
		});
		expect(JSON.stringify(feed)).not.toContain("hello");
	});
});

describe("readRecord / readRecordRange / recordSourceStates", () => {
	test("scope isolation: other scope is not_permitted, other principal and unknown id are missing", () => {
		const s = open();
		s.write((db) => captureRecord(db, capture()));
		const base = { contractVersion: 1, recordId: id() } as const;
		expect(
			s.read((db) =>
				readRecord(db, {
					...base,
					access: { ...ACCESS, scopeKeys: ["conversation:b"] },
					scopeKey: "conversation:a",
				}),
			),
		).toEqual({ status: "not_permitted" });
		expect(
			s.read((db) =>
				readRecord(db, { ...base, access: ACCESS, scopeKey: "conversation:b" }),
			),
		).toEqual({ status: "missing" });
		expect(
			s.read((db) =>
				readRecord(db, {
					...base,
					access: { ...ACCESS, principal: "local:other" },
					scopeKey: "conversation:a",
				}),
			),
		).toEqual({ status: "missing" });
		expect(
			s.read((db) =>
				readRecord(db, {
					...base,
					recordId: id("nothing"),
					access: ACCESS,
					scopeKey: "conversation:a",
				}),
			),
		).toEqual({ status: "missing" });
	});

	test("range reads: char boundary, digest and limits", () => {
		const s = open();
		s.write((db) => captureRecord(db, capture({ content: "ab食😀c" })));
		const result = s.write((db) =>
			captureRecord(db, capture({ content: "ab食😀c" })),
		);
		if (result.status !== "captured") throw new Error("unreachable");
		const range = (startByte: number, endByte: number) =>
			s.read((db) =>
				readRecordRange(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: "conversation:a",
					recordId: result.recordId,
					revision: result.revision,
					range: { startByte, endByte },
				}),
			);
		// a(1) b(1) 食(3) 😀(4) c(1) = 10 bytes
		expect(range(2, 5)).toMatchObject({ status: "available", text: "食" });
		expect(range(5, 9)).toMatchObject({ status: "available", text: "😀" });
		expect(range(2, 4)).toEqual({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		});
		expect(range(5, 7)).toEqual({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		});
		expect(range(0, 11)).toEqual({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
		});
		expect(range(0, 10)).toMatchObject({
			status: "available",
			text: "ab食😀c",
		});
	});

	test("recordSourceStates: available / changed / missing / inactive, same order and count", () => {
		const s = open();
		const first = s.write((db) => captureRecord(db, capture()));
		if (first.status !== "captured") throw new Error("unreachable");
		const states = (
			refs: ReturnType<typeof recordSourceRef>[],
			withContent = false,
		) =>
			s.read((db) =>
				recordSourceStates(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: "conversation:a",
					refs,
					withContent,
				}),
			);
		const ref = first.ref;
		const missingRef = recordSourceRef(id("none"), "sha256:x", "0".repeat(64));
		const out = states([ref, missingRef, ref], true);
		expect(out.map((state) => state.status)).toEqual([
			"available",
			"missing",
			"available",
		]);
		expect(out[0]).toMatchObject({
			content: "hello world",
			principal: "local:owner",
			scopeKey: "conversation:a",
		});
		expect(out[1]?.content).toBeUndefined();
		// 内容が変わると changed（current の revision / digest を返す）
		const next = s.write((db) =>
			captureRecord(db, capture({ content: "changed" })),
		);
		if (next.status !== "captured") throw new Error("unreachable");
		expect(states([ref])[0]).toMatchObject({
			status: "changed",
			revision: next.revision,
			digest: next.digest,
		});
		// inactive は missing
		s.write((db) =>
			deactivateRecord(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: "conversation:a",
				clock: CLOCK,
				recordId: first.recordId,
			}),
		);
		expect(states([next.ref])[0]?.status).toBe("missing");
	});

	test("refs outside Records are rejected", () => {
		const s = open();
		expect(() =>
			s.read((db) =>
				recordSourceStates(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: "conversation:a",
					refs: [
						{
							namespace: "conversation",
							kind: "message",
							id: "m1",
							representation: "text",
							revision: "1",
							digest: "0".repeat(64),
						},
					],
				}),
			),
		).toThrow();
	});
});

describe("deactivate / reactivate (reversible, not forgetting)", () => {
	test("keeps content, creates no tombstone, and reverses", () => {
		const s = open();
		const first = s.write((db) => captureRecord(db, capture()));
		if (first.status !== "captured") throw new Error("unreachable");
		const change = {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: "conversation:a",
			clock: CLOCK,
			recordId: first.recordId,
		} as const;
		expect(s.write((db) => deactivateRecord(db, change))).toEqual({
			status: "changed",
			recordStatus: "inactive",
		});
		expect(s.write((db) => deactivateRecord(db, change))).toEqual({
			status: "unchanged",
			recordStatus: "inactive",
		});
		const read = () =>
			s.read((db) =>
				readRecord(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: "conversation:a",
					recordId: first.recordId,
				}),
			);
		expect(read()).toMatchObject({
			status: "available",
			content: "hello world",
			record: { status: "inactive" },
		});
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_tombstone").get(),
		).toEqual({ n: 0 });
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_forget").get(),
		).toEqual({ n: 0 });
		expect(s.write((db) => reactivateRecord(db, change))).toEqual({
			status: "changed",
			recordStatus: "active",
		});
		expect(read()).toMatchObject({ record: { status: "active" } });
		expect(
			s.write((db) =>
				reactivateRecord(db, { ...change, recordId: id("nothing") }),
			),
		).toEqual({ status: "missing" });
	});
});
