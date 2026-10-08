import { afterEach, describe, expect, test } from "bun:test";
import { MemoryContractError } from "../../contracts/errors.ts";
import { appendMemoryChange, listMemoryChanges } from "../changes.ts";
import { addDependency } from "../dependency.ts";
import type { MemoryStoreError } from "../errors.ts";
import { bumpScopeRevision, readScopeRevision } from "../scope-state.ts";
import { enterWrite } from "../session.ts";
import { isTombstoned } from "../tombstone.ts";
import { openTestStore } from "../../../test/support/store.ts";
import type { TestStore } from "../../../test/support/store.ts";
import type {
	ListMemoryChangesInput,
	MemoryChangeDraft,
} from "../../contracts/external.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function open(): TestStore {
	store = openTestStore();
	return store;
}

const ACCESS = {
	principal: "local:owner",
	scopeKeys: ["conversation:a", "conversation:b"],
	purpose: "feed",
	policyRevision: "1",
} as const;

function draft(overrides: Partial<MemoryChangeDraft> = {}): MemoryChangeDraft {
	return {
		principal: "local:owner",
		scopeKey: "conversation:a",
		atMs: 1000,
		targetType: "record",
		targetId: "rec:1",
		revision: "sha256:aa",
		status: "active",
		forgetId: null,
		...overrides,
	};
}

function listInput(
	overrides: Partial<ListMemoryChangesInput> = {},
): ListMemoryChangesInput {
	return {
		contractVersion: 1,
		access: ACCESS,
		scopeKeys: ["conversation:a"],
		afterSeq: 0,
		limit: 10,
		...overrides,
	};
}

describe("scope revision", () => {
	test("starts at 0 and increments per bump, per (principal, scope)", () => {
		const s = open();
		expect(readScopeRevision(s.writer, "p", "s")).toBe(0);
		expect(
			s.write((db) => [
				bumpScopeRevision(db, "p", "s"),
				bumpScopeRevision(db, "p", "s"),
			]),
		).toEqual([1, 2]);
		expect(s.write((db) => bumpScopeRevision(db, "p", "other"))).toBe(1);
		expect(s.write((db) => bumpScopeRevision(db, "q", "s"))).toBe(1);
		expect(s.read((db) => readScopeRevision(db, "p", "s"))).toBe(2);
	});
});

describe("dependency and tombstone helpers", () => {
	test("addDependency is idempotent and validates enumerations via CHECK", () => {
		const s = open();
		const edge = {
			principal: "p",
			scopeKey: "s",
			dependentType: "state_item",
			dependentId: "state:1",
			dependencyType: "source",
			dependencyId: '["conversation","message","m1","text"]',
			role: "primary",
		} as const;
		s.write((db) => {
			addDependency(db, edge);
			addDependency(db, edge);
		});
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_dependency").get(),
		).toEqual({ n: 1 });
		expect(() =>
			s.write((db) => addDependency(db, { ...edge, role: "bogus" as never })),
		).toThrow();
	});

	test("isTombstoned reflects memory_tombstone rows", () => {
		const s = open();
		expect(isTombstoned(s.writer, "record", "rec:1")).toBe(false);
		s.writer.exec(
			"INSERT INTO memory_tombstone VALUES ('record','rec:1','p','s','forget:1',1,1)",
		);
		expect(isTombstoned(s.writer, "record", "rec:1")).toBe(true);
		expect(isTombstoned(s.writer, "source", "rec:1")).toBe(false);
	});
});

describe("listMemoryChanges", () => {
	test("returns ids, revisions and states only, ordered by seq, with paging", () => {
		const s = open();
		const seqs = s.write((db) => {
			enterWrite(db);
			return [
				appendMemoryChange(db, draft({ targetId: "rec:1" })),
				appendMemoryChange(
					db,
					draft({ targetId: "rec:2", status: "inactive" }),
				),
				appendMemoryChange(
					db,
					draft({ targetId: "rec:3", scopeKey: "conversation:b" }),
				),
				appendMemoryChange(
					db,
					draft({
						targetType: "state_item",
						targetId: "state:1",
						revision: "3",
						status: "superseded",
					}),
				),
				appendMemoryChange(
					db,
					draft({
						targetId: "rec:1",
						revision: null,
						status: "forgotten",
						forgetId: "forget:x",
					}),
				),
			];
		});
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		expect(new Set(seqs).size).toBe(seqs.length);

		const page1 = s.read((db) =>
			listMemoryChanges(db, listInput({ limit: 2 })),
		);
		expect(page1.status).toBe("ok");
		if (page1.status !== "ok") return;
		expect(page1.changes.map((c) => c.targetId)).toEqual(["rec:1", "rec:2"]);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextAfterSeq).toBe(seqs[1] as number);
		expect(page1.changes[0]).toEqual({
			seq: seqs[0] as number,
			atMs: 1000,
			scopeKey: "conversation:a",
			targetType: "record",
			targetId: "rec:1",
			revision: "sha256:aa",
			status: "active",
			forgetId: null,
		});

		const page2 = s.read((db) =>
			listMemoryChanges(
				db,
				listInput({ limit: 10, afterSeq: page1.nextAfterSeq }),
			),
		);
		if (page2.status !== "ok") throw new Error("expected ok");
		expect(
			page2.changes.map((c) => [
				c.targetType,
				c.targetId,
				c.status,
				c.revision,
				c.forgetId,
			]),
		).toEqual([
			["state_item", "state:1", "superseded", "3", null],
			["record", "rec:1", "forgotten", null, "forget:x"],
		]);
		expect(page2.hasMore).toBe(false);
		expect(page2.nextAfterSeq).toBe(seqs[4] as number);

		const empty = s.read((db) =>
			listMemoryChanges(db, listInput({ afterSeq: seqs[4] as number })),
		);
		expect(empty).toEqual({
			status: "ok",
			changes: [],
			nextAfterSeq: seqs[4] as number,
			hasMore: false,
		});
	});

	test("filters by principal and scope; scopes outside access are blocked", () => {
		const s = open();
		s.write((db) => {
			enterWrite(db);
			appendMemoryChange(db, draft({ targetId: "rec:a" }));
			appendMemoryChange(
				db,
				draft({ targetId: "rec:b", scopeKey: "conversation:b" }),
			);
			appendMemoryChange(
				db,
				draft({ targetId: "rec:other", principal: "someone:else" }),
			);
		});
		const both = s.read((db) =>
			listMemoryChanges(
				db,
				listInput({ scopeKeys: ["conversation:a", "conversation:b"] }),
			),
		);
		if (both.status !== "ok") throw new Error("expected ok");
		expect(both.changes.map((c) => c.targetId)).toEqual(["rec:a", "rec:b"]);
		expect(
			s.read((db) =>
				listMemoryChanges(db, listInput({ scopeKeys: ["conversation:zzz"] })),
			),
		).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
	});

	test("rejects malformed input with MemoryContractError", () => {
		const s = open();
		const code = (input: unknown): string | undefined => {
			try {
				listMemoryChanges(s.writer, input as ListMemoryChangesInput);
			} catch (error) {
				expect(error).toBeInstanceOf(MemoryContractError);
				return (error as MemoryContractError).code;
			}
			return undefined;
		};
		expect(code({ ...listInput(), contractVersion: 2 })).toBe(
			"UNSUPPORTED_SCHEMA_VERSION",
		);
		expect(code({ ...listInput(), limit: 0 })).toBe("INVALID_INTEGER");
		expect(code({ ...listInput(), limit: 501 })).toBe("INVALID_INTEGER");
		expect(code({ ...listInput(), afterSeq: -1 })).toBe("INVALID_INTEGER");
		expect(code({ ...listInput(), scopeKeys: [] })).toBe("INVALID_VALUE");
		expect(code({ ...listInput(), scopeKeys: ["x", "x"] })).toBe(
			"DUPLICATE_SCOPE_KEY",
		);
		expect(code({ ...listInput(), extra: 1 })).toBe("UNKNOWN_KEY");
		expect(code(null)).toBe("INVALID_TYPE");
	});

	test("works on the readonly connection and never needs a transaction", () => {
		const s = open();
		s.write((db) => {
			enterWrite(db);
			appendMemoryChange(db, draft());
		});
		const result = listMemoryChanges(s.reader, listInput());
		expect(result.status).toBe("ok");
	});

	test("appendMemoryChange needs a write connection", () => {
		const s = open();
		try {
			s.read((db) => appendMemoryChange(db, draft()));
			throw new Error("expected failure");
		} catch (error) {
			expect((error as MemoryStoreError).code).toBe("READONLY_CONNECTION");
		}
	});
});
