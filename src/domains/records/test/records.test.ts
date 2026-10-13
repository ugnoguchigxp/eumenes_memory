import { afterEach, describe, expect, test } from "bun:test";
import { isMemoryContractError } from "../../../contracts/errors.ts";
import type { AccessContext } from "../../../contracts/types.ts";
import { recordIdOf, recordSourceRef } from "../service/identity.ts";
import { captureRecord, readRecord } from "../repository/index.ts";
import { listMemoryChanges } from "../../../infrastructure/sqlite/changes.ts";
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

	test("appends to the change feed (no body)", () => {
		const s = open();
		s.write((db) => captureRecord(db, capture()));
		s.write((db) => captureRecord(db, capture())); // 変化なし
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

describe("readRecord", () => {
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
});
