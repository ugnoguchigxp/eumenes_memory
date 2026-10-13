import { afterEach, describe, expect, test } from "bun:test";
import {
	applyForget,
	assertMemorySchema,
	getForgetReceipt,
	listState,
	planForget,
	reconcileForgetJournal,
	registerExternalDependents,
} from "../../../sqlite.ts";
import { migrations } from "../migrations/index.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { buildJournalEntry } from "../../../domains/lifecycle/service/journal.ts";
import { GENESIS_JOURNAL_HASH } from "../../../domains/lifecycle/contracts/index.ts";

/** schema 7 の DB に、抽出由来の行を含むデータを入れて 0008 を適用する。 */

const PRINCIPAL = "local:owner";
const SCOPE = "conversation:c1";
const ACCESS = {
	principal: PRINCIPAL,
	scopeKeys: [SCOPE],
	purpose: "test",
	policyRevision: "1",
};
const SOURCE = JSON.stringify(["conversation", "message", "m1", "text"]);
const SOURCE2 = JSON.stringify(["conversation", "message", "m2", "text"]);
/** 抽出の run が読んだだけで、どの item も根拠として引用していない出典。 */
const SOURCE_READ_ONLY = JSON.stringify([
	"conversation",
	"message",
	"m3",
	"text",
]);
const DIGEST = sha256Hex("x");
/** schema 7 の DB で適用済みだった過去の忘却（ジャーナル 1 番）。 */
const OLD_ENTRY = buildJournalEntry({
	seq: 1,
	prevHash: GENESIS_JOURNAL_HASH,
	principal: PRINCIPAL,
	targets: [{ type: "state_item", id: "state:gone", scopeKey: SCOPE }],
});

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function names(s: TestStore, type: string): string[] {
	return (
		s.writer
			.query(
				"SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'memory\\_%' ESCAPE '\\' ORDER BY name",
			)
			.all(type) as { name: string }[]
	).map((row) => row.name);
}

function count(s: TestStore, sql: string): number {
	return (s.writer.query(sql).get() as { n: number }).n;
}

function edge(
	s: TestStore,
	dependentType: string,
	dependentId: string,
	dependencyType: string,
	dependencyId: string,
	role: string,
): void {
	s.writer
		.query(
			`INSERT INTO memory_dependency
				(principal, scope_key, dependent_type, dependent_id, dependency_type, dependency_id, role)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			PRINCIPAL,
			SCOPE,
			dependentType,
			dependentId,
			dependencyType,
			dependencyId,
			role,
		);
}

function item(
	s: TestStore,
	itemId: string,
	origin: string,
	seq: number,
	semanticKey: string,
	source: string,
): void {
	s.writer
		.query(
			`INSERT INTO memory_state_item
				(item_id, principal, scope_key, subject, kind, semantic_key, status, revision, value_text,
				 polarity, origin, evidence_ordinal, created_seq, updated_seq)
			VALUES (?, ?, ?, 'self', 'preference', ?, 'active', 1, ?, 'affirmed', ?, 1, ?, ?)`,
		)
		.run(
			itemId,
			PRINCIPAL,
			SCOPE,
			semanticKey,
			`SECRET-${itemId}`,
			origin,
			seq,
			seq,
		);
	s.writer
		.query(
			`INSERT INTO memory_state_evidence
				(item_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, start_byte, end_byte)
			VALUES (?, 0, ?, 'conversation', 'message', ?, 'text', ?, ?, 0, 3)`,
		)
		.run(itemId, source, JSON.parse(source)[2], `sha256:${DIGEST}`, DIGEST);
	s.writer
		.query(
			`INSERT INTO memory_state_event
				(event_seq, item_id, principal, scope_key, action, from_revision, to_revision, cause_type, cause_id, at_ms)
			VALUES (?, ?, ?, ?, 'assert', NULL, 1, ?, ?, 1)`,
		)
		.run(
			seq + 100,
			itemId,
			PRINCIPAL,
			SCOPE,
			origin === "admitted_extraction" ? "candidate" : "user",
			origin === "admitted_extraction" ? "cand:1" : PRINCIPAL,
		);
	edge(s, "state_item", itemId, "source", source, "primary");
}

/** schema 7 の DB: 抽出の run / 候補 / 進捗、候補由来の item、ユーザーの item、外部派生物、過去の忘却の記録。 */
function seedSchema7(): TestStore {
	const s = openTestStore({ migrations: migrations.slice(0, 7) });
	const w = s.writer;
	w.query(
		`INSERT INTO memory_extraction_run
			(run_id, principal, scope_key, stage, input_digest, extractor_id, prompt_version, provider_ref,
			 prepared_seq, settled_seq, outcome_code, output_digest)
		VALUES ('run:1', ?, ?, 'settled', ?, 'x', 'v1', 'larm', 1, 2, NULL, ?)`,
	).run(PRINCIPAL, SCOPE, DIGEST, DIGEST);
	w.query(
		`INSERT INTO memory_extraction_input
			(run_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, role, ordinal)
		VALUES ('run:1', 0, ?, 'conversation', 'message', 'm1', 'text', ?, ?, 'user', 0)`,
	).run(SOURCE, `sha256:${DIGEST}`, DIGEST);
	w.query(
		"INSERT INTO memory_extraction_shown (run_id, item_id, revision) VALUES ('run:1', 'state:user', 1)",
	).run();
	w.query(
		`INSERT INTO memory_candidate
			(candidate_id, run_id, idx, principal, scope_key, kind, subject, semantic_key, value_text, polarity,
			 modality, temporal, decision, reason_code, evidence_ordinal, created_seq)
		VALUES ('cand:1', 'run:1', 0, ?, ?, 'preference', 'self', 'drink', 'SECRET-cand', 'affirmed',
			'asserted', 'current', 'admitted', NULL, 1, 3)`,
	).run(PRINCIPAL, SCOPE);
	w.query(
		`INSERT INTO memory_candidate_evidence
			(candidate_id, idx, source_key, namespace, kind, source_id, representation, revision, digest,
			 start_byte, end_byte, quote_digest)
		VALUES ('cand:1', 0, ?, 'conversation', 'message', 'm1', 'text', ?, ?, 0, 3, ?)`,
	).run(SOURCE, `sha256:${DIGEST}`, DIGEST, DIGEST);
	w.query(
		`INSERT INTO memory_source_progress (principal, scope_key, source_key, processed_revision, stage, run_id, seq)
		VALUES (?, ?, ?, 'sha256:x', 'extracted', 'run:1', 4)`,
	).run(PRINCIPAL, SCOPE, SOURCE);
	// 同じ SQL を 0007 の DB で: candidate 由来の item とユーザーの item。
	item(s, "state:extracted", "admitted_extraction", 5, "drink", SOURCE);
	item(s, "state:user", "user_confirmed", 6, "food", SOURCE2);
	edge(s, "extraction_run", "run:1", "source", SOURCE, "input");
	edge(s, "extraction_run", "run:1", "source", SOURCE_READ_ONLY, "input");
	edge(s, "extraction_run", "run:1", "state_item", "state:user", "input");
	edge(s, "candidate", "cand:1", "extraction_run", "run:1", "derived_from");
	edge(s, "candidate", "cand:1", "source", SOURCE, "primary");
	edge(
		s,
		"state_item",
		"state:extracted",
		"candidate",
		"cand:1",
		"derived_from",
	);
	edge(s, "external", "world:n1", "state_item", "state:user", "derived_from");
	// 過去の忘却: 抽出の run / candidate の墓標、forget の記録と外部削除の確認待ち。
	for (const [type, id] of [
		["candidate", "cand:old"],
		["extraction_run", "run:old"],
		["state_item", "state:gone"],
		["source", SOURCE2.replace("m2", "gone")],
	] as const) {
		w.query(
			"INSERT INTO memory_tombstone VALUES (?, ?, ?, ?, 'forget:old', 10, 1)",
		).run(type, id, PRINCIPAL, SCOPE);
	}
	w.query(
		`INSERT INTO memory_forget (forget_id, principal, request_json, local_state, external_state, journal_seq, entry_hash, seq, at_ms)
		VALUES (?, ?, '{"targets":[]}', 'applied', 'pending', 1, ?, 10, 1)`,
	).run(OLD_ENTRY.forgetId, PRINCIPAL, OLD_ENTRY.hash);
	w.query(
		`INSERT INTO memory_forget_external (forget_id, provider_ref, external_id, state, updated_seq)
		VALUES (?, 'larm', '', 'pending', 10)`,
	).run(OLD_ENTRY.forgetId);
	w.query(
		"UPDATE memory_journal_state SET applied_head_seq = 1, applied_head_hash = ?",
	).run(OLD_ENTRY.hash);
	return s;
}

describe("migration 0008: removing Extraction and Recall", () => {
	test("is the 8th migration; 0008 alone upgrades a schema 7 database that holds extraction data", () => {
		store = seedSchema7();
		expect(count(store, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(1);
		expect(() => assertMemorySchema(store!.writer)).toThrow(/SCHEMA_OUTDATED/);
		expect(migrations).toHaveLength(8);
		store.writer.exec(migrations[7] as string);
		assertMemorySchema(store.writer);
		expect(
			store.writer
				.query(
					"SELECT value FROM memory_schema_info WHERE key = 'db_schema_version'",
				)
				.get(),
		).toEqual({ value: "8" });
		expect(store.writer.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("drops the extraction tables, their indexes and triggers, and the full-text index", () => {
		store = seedSchema7();
		store.writer.exec(migrations[7] as string);
		const tables = names(store, "table");
		for (const gone of [
			"memory_extraction_run",
			"memory_extraction_input",
			"memory_extraction_shown",
			"memory_candidate",
			"memory_candidate_evidence",
			"memory_source_progress",
			"memory_record_fts",
			"memory_scope_state",
		]) {
			expect(tables).not.toContain(gone);
		}
		expect(names(store, "index").join(" ")).not.toMatch(/candidate|extraction/);
		expect(names(store, "trigger").join(" ")).not.toMatch(
			/candidate|extraction|progress/,
		);
		expect(tables).toEqual(
			expect.arrayContaining([
				"memory_state_item",
				"memory_record",
				"memory_dependency",
				"memory_tombstone",
				"memory_forget",
				"memory_forget_external",
			]),
		);
	});

	test("removes the edges and tombstones of the removed node types and keeps the rest", () => {
		store = seedSchema7();
		store.writer.exec(migrations[7] as string);
		expect(
			store.writer
				.query(
					"SELECT dependent_type, dependent_id, dependency_type, dependency_id, role FROM memory_dependency ORDER BY dependent_id, dependency_id",
				)
				.all(),
		).toEqual([
			{
				dependent_type: "state_item",
				dependent_id: "state:extracted",
				dependency_type: "source",
				dependency_id: SOURCE,
				role: "primary",
			},
			{
				dependent_type: "state_item",
				dependent_id: "state:user",
				dependency_type: "source",
				dependency_id: SOURCE2,
				role: "primary",
			},
			{
				dependent_type: "external",
				dependent_id: "world:n1",
				dependency_type: "state_item",
				dependency_id: "state:user",
				role: "derived_from",
			},
		]);
		expect(
			store.writer
				.query("SELECT target_type FROM memory_tombstone ORDER BY target_type")
				.all(),
		).toEqual([{ target_type: "source" }, { target_type: "state_item" }]);
		// 過去の忘却の記録と外部削除の確認待ちは残る。
		expect(
			getForgetReceipt(store.writer, {
				contractVersion: 1,
				access: ACCESS,
				forgetId: OLD_ENTRY.forgetId,
			}),
		).toMatchObject({
			status: "found",
			receipt: {
				external: "pending",
				externalDeletions: [
					{ providerRef: "larm", externalId: null, state: "pending" },
				],
			},
		});
	});

	test("State rows from extraction stay readable with their origin", () => {
		store = seedSchema7();
		store.writer.exec(migrations[7] as string);
		const listed = listState(store.writer, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
		});
		expect(listed.status).toBe("ok");
		if (listed.status !== "ok") return;
		expect(
			listed.items.map((entry) => [entry.itemId, entry.origin]).sort(),
		).toEqual([
			["state:extracted", "admitted_extraction"],
			["state:user", "user_confirmed"],
		]);
	});

	test("forget keeps working after the upgrade: a source reaches the extraction-derived item, external dependents, and the journal reconciles", () => {
		store = seedSchema7();
		store.writer.exec(migrations[7] as string);
		const s = store;
		const planned = planForget(s.writer, {
			contractVersion: 1,
			access: ACCESS,
			target: { type: "host_source", sourceKey: SOURCE, scopeKey: SCOPE },
			clock: { atMs: 5 },
		});
		if (planned.status !== "planned") throw new Error("plan");
		expect(planned.plan.closure.counts).toEqual({
			record: 0,
			state_item: 1,
			external: 0,
		});
		const entry = planned;
		const receipt = s.write((db) =>
			applyForget(db, {
				contractVersion: 1,
				entry: entry.plan.entry,
				clock: { atMs: 6 },
			}),
		);
		expect(receipt).toMatchObject({ local: "applied", completed: true });
		expect(
			s.writer
				.query(
					"SELECT status, value_text FROM memory_state_item ORDER BY item_id",
				)
				.all(),
		).toEqual([
			{ status: "forgotten", value_text: null },
			{ status: "active", value_text: "SECRET-state:user" },
		]);
		const reconciled = s.write((db) =>
			reconcileForgetJournal(db, {
				contractVersion: 1,
				entries: [OLD_ENTRY, entry.plan.entry],
				clock: { atMs: 7 },
			}),
		);
		expect(reconciled).toEqual({ status: "ok", reapplied: 0 });
		// 外部派生物の登録は新しい DB でも通り、忘却の閉包に入る。
		expect(
			s.write((db) =>
				registerExternalDependents(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 8 },
					dependents: [
						{
							providerRef: "world",
							externalId: "n2",
							dependsOn: [{ type: "state_item", id: "state:user" }],
						},
					],
				}),
			),
		).toMatchObject({ status: "registered", registered: 1 });
	});

	test("a source that an old run only read no longer reaches the item that run produced (accepted narrowing); the cited source still does", () => {
		store = seedSchema7();
		store.writer.exec(migrations[7] as string);
		const closureOf = (sourceKey: string) => {
			const planned = planForget(store!.writer, {
				contractVersion: 1,
				access: ACCESS,
				target: { type: "host_source", sourceKey, scopeKey: SCOPE },
				clock: { atMs: 5 },
			});
			if (planned.status !== "planned") throw new Error("plan");
			return planned.plan.closure.counts;
		};
		expect(closureOf(SOURCE_READ_ONLY)).toEqual({
			record: 0,
			state_item: 0,
			external: 0,
		});
		expect(closureOf(SOURCE)).toEqual({
			record: 0,
			state_item: 1,
			external: 0,
		});
	});
});
