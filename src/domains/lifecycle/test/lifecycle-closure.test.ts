/**
 * Lifecycle（target host_source / state_item / scope の全閉包、ExternalDependent の登録、外部削除の記録）の
 * 単体試験。グラフは `test/runners/forget-support.ts` が実 SQLite に組み立てる。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isMemoryContractError } from "../../../contracts/errors.ts";
import type { AccessContext } from "../../../contracts/types.ts";
import {
	ACCESS,
	OTHER_SCOPE,
	SCOPE,
	buildGraph,
	closureViolations,
	messageKey,
	nextSeq,
	tombstoneSet,
} from "../../../../test/runners/forget-support.ts";
import {
	forgetRecord,
	tablesContain,
} from "../../../../test/runners/records-support.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import { GENESIS_JOURNAL_HASH } from "../contracts/index.ts";
import { buildJournalEntry } from "../service/journal.ts";
import { addDependency } from "../../../infrastructure/sqlite/dependency.ts";
import {
	applyForget,
	planForget,
	recordExternalDeletion,
	registerExternalDependents,
	unregisterExternalDependents,
} from "../repository/index.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(): TestStore {
	store = openTestStore();
	return store;
}

const CLOCK = { atMs: 5 } as const;

function register(
	s: TestStore,
	dependents: readonly {
		providerRef: string;
		externalId: string;
		dependsOn: readonly { type: "source" | "state_item"; id: string }[];
	}[],
	scopeKey = SCOPE,
	access: AccessContext = ACCESS,
) {
	return s.write((db) =>
		registerExternalDependents(db, {
			contractVersion: 1,
			access,
			scopeKey,
			clock: CLOCK,
			dependents,
		}),
	);
}

function unregister(
	s: TestStore,
	keys: readonly { providerRef: string; externalId: string }[],
	scopeKey = SCOPE,
) {
	return s.write((db) =>
		unregisterExternalDependents(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey,
			clock: CLOCK,
			dependents: keys,
		}),
	);
}

function edgeCount(s: TestStore, dependentId: string): number {
	return (
		s.writer
			.query(
				"SELECT COUNT(*) AS n FROM memory_dependency WHERE dependent_type = 'external' AND dependent_id = ?",
			)
			.get(dependentId) as { n: number }
	).n;
}

describe("registerExternalDependents", () => {
	const SIMPLE = {
		items: [{ id: "i1", evidence: ["m:m1"] }],
	} as const;

	test("registers, is idempotent, replaces the dependency set, and does not touch the change feed", () => {
		const s = open();
		buildGraph(s, SIMPLE);
		const feed = () => s.writer.query("SELECT * FROM memory_change").all();
		const before = JSON.stringify(feed());
		expect(
			register(s, [
				{
					providerRef: "world",
					externalId: "n1",
					dependsOn: [
						{ type: "state_item", id: "i1" },
						{ type: "source", id: messageKey("m1") },
					],
				},
			]),
		).toEqual({ status: "registered", registered: 1, unchanged: 0 });
		expect(edgeCount(s, "world:n1")).toBe(2);
		expect(
			s.writer
				.query(
					"SELECT DISTINCT role FROM memory_dependency WHERE dependent_type = 'external'",
				)
				.all(),
		).toEqual([{ role: "derived_from" }]);
		// 同じ内容は unchanged（順序が違っても）
		expect(
			register(s, [
				{
					providerRef: "world",
					externalId: "n1",
					dependsOn: [
						{ type: "source", id: messageKey("m1") },
						{ type: "state_item", id: "i1" },
					],
				},
			]),
		).toEqual({ status: "registered", registered: 0, unchanged: 1 });
		// 依存先が変わると置き換え（古い辺は残らない）
		expect(
			register(s, [
				{
					providerRef: "world",
					externalId: "n1",
					dependsOn: [{ type: "source", id: messageKey("m2") }],
				},
			]),
		).toEqual({ status: "registered", registered: 1, unchanged: 0 });
		expect(
			s.writer
				.query(
					"SELECT dependency_type, dependency_id FROM memory_dependency WHERE dependent_id = 'world:n1'",
				)
				.all(),
		).toEqual([{ dependency_type: "source", dependency_id: messageKey("m2") }]);
		expect(JSON.stringify(feed())).toBe(before);
	});

	test("rejects tombstoned and missing dependencies without writing anything (all or nothing)", () => {
		const s = open();
		buildGraph(s, {
			items: [
				{ id: "i1", evidence: ["m:m1"] },
				{ id: "i2", evidence: ["m:m2"] },
				{ id: "ib", scope: OTHER_SCOPE, evidence: ["m:m2"] },
			],
		});
		forgetRecord(s, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		const good = {
			providerRef: "world",
			externalId: "ok",
			dependsOn: [{ type: "state_item" as const, id: "i2" }],
		};
		const attempt = (
			dependsOn: readonly { type: "source" | "state_item"; id: string }[],
		) =>
			register(s, [
				good,
				{ providerRef: "world", externalId: "bad", dependsOn },
			]);
		expect(attempt([{ type: "source", id: messageKey("m1") }])).toEqual({
			status: "rejected",
			reasonCode: "TOMBSTONED",
		});
		expect(attempt([{ type: "state_item", id: "i1" }])).toEqual({
			status: "rejected",
			reasonCode: "TOMBSTONED",
		});
		expect(attempt([{ type: "state_item", id: "nope" }])).toEqual({
			status: "rejected",
			reasonCode: "DEPENDENCY_MISSING",
		});
		// 別 scope の item
		expect(attempt([{ type: "state_item", id: "ib" }])).toEqual({
			status: "rejected",
			reasonCode: "DEPENDENCY_MISSING",
		});
		expect(edgeCount(s, "world:ok")).toBe(0);
		expect(edgeCount(s, "world:bad")).toBe(0);
	});

	test("blocks unpermitted scopes, refuses to take over an id registered in another scope, and refuses to re-register a forgotten derivative", () => {
		const s = open();
		buildGraph(s, { items: [{ id: "i1", evidence: ["m:m1"] }] });
		const dep = {
			providerRef: "world",
			externalId: "n1",
			dependsOn: [{ type: "source" as const, id: messageKey("m9") }],
		};
		expect(register(s, [dep], "scope:z")).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
		expect(register(s, [dep])).toMatchObject({ status: "registered" });
		expect(register(s, [dep], OTHER_SCOPE)).toEqual({
			status: "rejected",
			reasonCode: "EXTERNAL_ID_IN_USE",
		});
		forgetRecord(s, {
			type: "host_source",
			sourceKey: messageKey("m9"),
			scopeKey: SCOPE,
		});
		expect(tombstoneSet(s, "external")).toEqual(new Set(["world:n1"]));
		expect(
			register(s, [
				{ ...dep, dependsOn: [{ type: "source", id: messageKey("m8") }] },
			]),
		).toEqual({ status: "rejected", reasonCode: "TOMBSTONED" });
	});

	test("input violations are contract errors", () => {
		const s = open();
		const bad = (dependents: unknown) => {
			try {
				s.write((db) =>
					registerExternalDependents(db, {
						contractVersion: 1,
						access: ACCESS,
						scopeKey: SCOPE,
						clock: CLOCK,
						dependents,
					} as never),
				);
				return "no error";
			} catch (error) {
				return isMemoryContractError(error) ? error.code : "other";
			}
		};
		const ref = { type: "source", id: "x" };
		expect(
			bad([{ providerRef: "a:b", externalId: "n", dependsOn: [ref] }]),
		).toBe("INVALID_ID_FORMAT");
		expect(
			bad([{ providerRef: "world", externalId: "n", dependsOn: [] }]),
		).toBe("INVALID_VALUE");
		expect(
			bad([{ providerRef: "world", externalId: "n", dependsOn: [ref, ref] }]),
		).toBe("DUPLICATE_DEPENDENCY");
		expect(
			bad([
				{ providerRef: "world", externalId: "n", dependsOn: [ref] },
				{ providerRef: "world", externalId: "n", dependsOn: [ref] },
			]),
		).toBe("DUPLICATE_ITEM_ID");
		expect(
			bad([
				{
					providerRef: "world",
					externalId: "n",
					dependsOn: [{ type: "candidate", id: "x" }],
				},
			]),
		).toBe("INVALID_ENUM");
	});
});

describe("unregisterExternalDependents", () => {
	test("removes only this scope's registration, leaves no tombstone or receipt, and the derivative is no longer in any closure", () => {
		const s = open();
		buildGraph(s, { items: [{ id: "i1", evidence: ["m:m1"] }] });
		register(s, [
			{
				providerRef: "world",
				externalId: "n1",
				dependsOn: [{ type: "state_item", id: "i1" }],
			},
			{
				providerRef: "world",
				externalId: "n2",
				dependsOn: [{ type: "state_item", id: "i1" }],
			},
		]);
		expect(
			unregister(s, [{ providerRef: "world", externalId: "n1" }], OTHER_SCOPE),
		).toEqual({ status: "unregistered", removed: 0 });
		expect(
			unregister(s, [
				{ providerRef: "world", externalId: "n1" },
				{ providerRef: "world", externalId: "never" },
			]),
		).toEqual({ status: "unregistered", removed: 1 });
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_tombstone").get(),
		).toEqual({ n: 0 });
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_forget").get(),
		).toEqual({ n: 0 });
		const { plan } = forgetRecord(s, {
			type: "state_item",
			itemId: "i1",
			scopeKey: SCOPE,
		});
		expect(plan.externalDependents).toEqual([
			{ providerRef: "world", externalId: "n2" },
		]);
		expect(
			unregister(s, [{ providerRef: "world", externalId: "n9" }], "scope:z"),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
	});
});

describe("planForget / applyForget for host_source, state_item and scope", () => {
	test("plan is read-only for every target type and works on the readonly connection", () => {
		const s = open();
		const g = buildGraph(s, {
			records: ["r1"],
			items: [{ id: "i1", evidence: ["m:m1"] }],
			externals: [{ id: "world:n1", dependsOn: ["i:i1"] }],
		});
		const dump = () =>
			JSON.stringify(
				s.writer
					.query(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory\\_%' ESCAPE '\\' ORDER BY name",
					)
					.all()
					.map((row) =>
						s.writer
							.query(`SELECT * FROM ${(row as { name: string }).name}`)
							.all(),
					),
			);
		const before = dump();
		for (const target of [
			{ type: "host_source", sourceKey: messageKey("m1"), scopeKey: SCOPE },
			{ type: "state_item", itemId: "i1", scopeKey: SCOPE },
			{ type: "scope", scopeKey: SCOPE },
			{
				type: "record",
				recordId: g.recordIds.get("r1") as string,
				scopeKey: SCOPE,
			},
		] as const) {
			const planned = s.read((db) =>
				planForget(db, {
					contractVersion: 1,
					access: ACCESS,
					target,
					clock: CLOCK,
				}),
			);
			expect(planned.status).toBe("planned");
		}
		expect(dump()).toBe(before);
	});

	test("host_source: counts and external derivatives are reported before apply; a source nothing depends on is still tombstoned", () => {
		const s = open();
		buildGraph(s, {
			items: [{ id: "i1", evidence: ["m:m1"] }],
			externals: [{ id: "world:n1", dependsOn: ["i:i1"] }],
		});
		const planned = s.read((db) =>
			planForget(db, {
				contractVersion: 1,
				access: ACCESS,
				target: {
					type: "host_source",
					sourceKey: messageKey("m1"),
					scopeKey: SCOPE,
				},
				clock: CLOCK,
			}),
		);
		if (planned.status !== "planned") throw new Error("plan");
		expect(planned.plan.closure.counts).toEqual({
			record: 0,
			state_item: 1,
			external: 1,
		});
		expect(planned.plan.externalProviders).toEqual([]);
		expect(planned.plan.externalDependents).toEqual([
			{ providerRef: "world", externalId: "n1" },
		]);
		forgetRecord(s, {
			type: "host_source",
			sourceKey: messageKey("lonely"),
			scopeKey: SCOPE,
		});
		expect(tombstoneSet(s, "source")).toEqual(new Set([messageKey("lonely")]));
		// 空振りの forget は変更フィードに source の forgotten を 1 件だけ出す
		expect(
			s.writer
				.query("SELECT target_type, status FROM memory_change")
				.all()
				.filter(
					(row) => (row as { target_type: string }).target_type === "source",
				),
		).toEqual([{ target_type: "source", status: "forgotten" }]);
	});

	test("a host_source target whose key is a record's source key forgets the record too", () => {
		const s = open();
		const g = buildGraph(s, {
			records: ["r1"],
			items: [{ id: "i1", evidence: ["r:r1"] }],
		});
		forgetRecord(s, {
			type: "host_source",
			sourceKey: g.sourceKeyOf("r:r1"),
			scopeKey: SCOPE,
		});
		expect(tablesContain(s, "SECRET-rec-r1")).toBe(false);
		expect(tablesContain(s, "SECRET-item-i1")).toBe(false);
		expect(tombstoneSet(s, "record")).toEqual(
			new Set([g.recordIds.get("r1") as string]),
		);
		expect(closureViolations(s)).toEqual([]);
	});

	test("state_item: a nonexistent id still gets a tombstone, and the trigger stops it from being created later", () => {
		const s = open();
		forgetRecord(s, {
			type: "state_item",
			itemId: "state:never-existed",
			scopeKey: SCOPE,
		});
		expect(tombstoneSet(s, "state_item")).toEqual(
			new Set(["state:never-existed"]),
		);
		expect(() =>
			s.writer
				.query(
					`INSERT INTO memory_state_item
						(item_id, principal, scope_key, subject, kind, semantic_key, status, revision, value_text,
						 polarity, origin, evidence_ordinal, created_seq, updated_seq)
					VALUES ('state:never-existed', 'local:owner', 'scope:a', 'self', 'preference', 'k', 'active', 1,
						'v', 'affirmed', 'user_confirmed', 1, 1, 1)`,
				)
				.run(),
		).toThrow();
	});

	test("scope: removes every kind of owned data in the scope, leaves the other scope, and tombstones only sources no other scope cites", () => {
		const s = open();
		buildGraph(s, {
			records: ["r1"],
			items: [
				{ id: "ia", evidence: ["m:only-a", "m:shared"] },
				{
					id: "ib",
					scope: OTHER_SCOPE,
					evidence: ["m:shared", "m:only-b"],
				},
			],
			externals: [
				{ id: "world:na", dependsOn: ["i:ia"] },
				{ id: "world:nb", scope: OTHER_SCOPE, dependsOn: ["i:ib"] },
			],
		});
		const { plan, receipt } = forgetRecord(s, {
			type: "scope",
			scopeKey: SCOPE,
		});
		expect(plan.closure.counts).toEqual({
			record: 1,
			state_item: 1,
			external: 1,
		});
		expect(receipt.external).toBe("pending");
		for (const secret of ["SECRET-rec-r1", "SECRET-item-ia"]) {
			expect(tablesContain(s, secret)).toBe(false);
		}
		expect(tablesContain(s, "SECRET-item-ib")).toBe(true);
		expect(tombstoneSet(s, "source")).toEqual(
			new Set([
				messageKey("only-a"),
				JSON.stringify([
					"memory",
					"record",
					[...tombstoneSet(s, "record")][0],
					"text",
				]),
			]),
		);
		expect(tombstoneSet(s, "external")).toEqual(new Set(["world:na"]));
		expect(closureViolations(s)).toEqual([]);
	});

	test("re-applying an old scope entry does not erase data created in the scope after the first application", () => {
		const s = open();
		buildGraph(s, { items: [{ id: "old", evidence: ["m:m1"] }] });
		const { entry } = forgetRecord(s, { type: "scope", scopeKey: SCOPE });
		// 忘却の後に同じ scope で作られた行
		s.write((db) => {
			const seq = nextSeq(db);
			db.query(
				`INSERT INTO memory_state_item
					(item_id, principal, scope_key, subject, kind, semantic_key, status, revision, value_text,
					 polarity, origin, evidence_ordinal, created_seq, updated_seq)
				VALUES ('newer', 'local:owner', 'scope:a', 'self', 'preference', 'k', 'active', 1,
					'SECRET-newer', 'affirmed', 'user_confirmed', 1, ?, ?)`,
			).run(seq, seq);
			addDependency(db, {
				principal: "local:owner",
				scopeKey: SCOPE,
				dependentType: "state_item",
				dependentId: "newer",
				dependencyType: "source",
				dependencyId: messageKey("fresh"),
				role: "primary",
			});
		});
		s.write((db) =>
			applyForget(db, { contractVersion: 1, entry, clock: { atMs: 99 } }),
		);
		expect(tablesContain(s, "SECRET-newer")).toBe(true);
		expect(tablesContain(s, "SECRET-item-old")).toBe(false);
		expect(tombstoneSet(s, "state_item")).toEqual(new Set(["old"]));
	});
});

describe("recordExternalDeletion on a forget without external deletions", () => {
	test("reports unknown_provider (nothing to confirm)", () => {
		const s = open();
		const { entry } = forgetRecord(s, {
			type: "host_source",
			sourceKey: messageKey("m1"),
			scopeKey: SCOPE,
		});
		expect(
			s.write((db) =>
				recordExternalDeletion(db, {
					contractVersion: 1,
					access: ACCESS,
					clock: CLOCK,
					forgetId: entry.forgetId,
					providerRef: "world",
					state: "confirmed",
				}),
			),
		).toEqual({ status: "unknown_provider" });
	});
});

describe("review findings", () => {
	test("a source shared by two scopes is tombstoned by the second scope forget once the first scope's rows are gone", () => {
		const s = open();
		buildGraph(s, {
			items: [
				{ id: "ia", evidence: ["m:shared"] },
				{ id: "ib", scope: OTHER_SCOPE, evidence: ["m:shared"] },
			],
		});
		forgetRecord(s, { type: "scope", scopeKey: SCOPE });
		expect(tombstoneSet(s, "source")).toEqual(new Set());
		forgetRecord(s, { type: "scope", scopeKey: OTHER_SCOPE });
		expect(tombstoneSet(s, "source")).toEqual(new Set([messageKey("shared")]));
	});

	test("record / host_source / state_item targets that point at another principal's or scope's rows are blocked, and a forged entry is refused", () => {
		const s = open();
		const g = buildGraph(s, {
			records: ["r1"],
			items: [{ id: "i1", evidence: ["m:m1"] }],
		});
		const recordId = g.recordIds.get("r1") as string;
		const plan = (target: Parameters<typeof planForget>[1]["target"]) =>
			s.read((db) =>
				planForget(db, {
					contractVersion: 1,
					access: ACCESS,
					target,
					clock: CLOCK,
				}),
			);
		const blocked = {
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		} as const;
		// r1 は SCOPE の record。OTHER_SCOPE の record として指定しても、他人の行は消せない。
		expect(plan({ type: "record", recordId, scopeKey: OTHER_SCOPE })).toEqual(
			blocked,
		);
		expect(
			plan({
				type: "host_source",
				sourceKey: g.sourceKeyOf("r:r1"),
				scopeKey: OTHER_SCOPE,
			}),
		).toEqual(blocked);
		expect(
			plan({ type: "state_item", itemId: "i1", scopeKey: OTHER_SCOPE }),
		).toEqual(blocked);
		// plan を通さずに作った entry も apply が拒否する（何も書かない）。
		const forged = buildJournalEntry({
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [{ type: "record", id: recordId, scopeKey: OTHER_SCOPE }],
		});
		expect(() =>
			s.write((db) =>
				applyForget(db, { contractVersion: 1, entry: forged, clock: CLOCK }),
			),
		).toThrow();
		expect(tablesContain(s, "SECRET-rec-r1")).toBe(true);
		expect(tombstoneSet(s, "record")).toEqual(new Set());
	});

	test("forgetting a record nulls the body digest kept in earlier change-feed rows", () => {
		const s = open();
		const g = buildGraph(s, { records: ["r1"] });
		const recordId = g.recordIds.get("r1") as string;
		const revisions = () =>
			s.writer
				.query(
					"SELECT revision FROM memory_change WHERE target_type = 'record' AND target_id = ?",
				)
				.all(recordId) as { revision: string | null }[];
		expect(revisions().some((row) => row.revision?.startsWith("sha256:"))).toBe(
			true,
		);
		forgetRecord(s, { type: "record", recordId, scopeKey: SCOPE });
		expect(revisions().every((row) => row.revision === null)).toBe(true);
		expect(revisions().length).toBeGreaterThan(1);
	});
});
