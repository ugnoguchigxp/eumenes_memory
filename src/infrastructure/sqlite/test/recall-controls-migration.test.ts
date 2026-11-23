/**
 * migration 0010（除外・抑制・記憶の候補・強度・変更フィードの列）。既存の版 9 の DB を壊さず、追記だけで足す。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { MEMORY_CHANGE_KINDS } from "../../../contracts/external.ts";
import {
	CANDIDATE_STATUSES,
	STATE_KINDS,
} from "../../../domains/state/contracts/index.ts";
import { EXCLUSION_TARGET_TYPES } from "../../../domains/lifecycle/contracts/index.ts";
import { sql as recallControls } from "../migrations/0010-recall-controls.ts";
import { MEMORY_DB_SCHEMA_VERSION, migrations } from "../migrations/index.ts";
import { listMemoryChanges } from "../changes.ts";
import { assertMemorySchema, checkHostMigrations } from "../schema-check.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function checkLists(sql: string, column: string): string[][] {
	const pattern = new RegExp(
		`(?<![A-Za-z_])${column}\\s+IN\\s*\\(([^)]*)\\)`,
		"g",
	);
	return [...sql.matchAll(pattern)].map((match) =>
		[...(match[1] ?? "").matchAll(/'([^']*)'/g)].map(
			(token) => token[1] as string,
		),
	);
}

describe("migration 0010", () => {
	test("migrations 0001-0009 are byte-for-byte what was published (append-only)", () => {
		expect(migrations.slice(0, 9).map(sha256Hex)).toEqual([
			"b97c190b8f5a62057ca21ec241c10fd1ea71c03ad7044a247c8bfdea70e7ffba",
			"24ce71705b8ae44b33e39874998a167091d27a00ddfacfcb4549fbf847d80d1a",
			"07edacf77d2c82a8d644c1f4f08f114662cfd1dba575a1e5d696541df732d9d4",
			"1567136edbc14b1c6f9fd4f0be280c6ff4a9cc9deb3a7a17eb438ed6e7f469dd",
			"71a6ad7ee8bbf814a5f64a2f0eede0313df01aa65cd602ed39bf7ceb83a3176e",
			"895af28299939bde218e74b068ddb7decb2ad31cf79288de1903a3137e696b54",
			"77015baa703ce3b47687830b59bfb2f3539317d1621556fb4cbe36d146b9c9c6",
			"4de95e86d4c10ab3bc02f171b6fcc09d26a086ce5b53ffbcbd0d0f8f9ecac8e1",
			"fceb23bb7b0653716a9b6792079c363308ee65399e3ab994e1962c2adbd6bf8c",
		]);
		expect(MEMORY_DB_SCHEMA_VERSION).toBe(10);
		expect(checkHostMigrations([...migrations])).toEqual([]);
		// 版 9 の DB の末尾へ追記するホストの配列（0001-0009 + 0010）。
		expect(checkHostMigrations(["host 1", ...migrations])).toEqual([]);
	});

	test("CHECK enumerations equal the contract tuples", () => {
		expect(checkLists(recallControls, "target_type")).toEqual([
			[...EXCLUSION_TARGET_TYPES],
			["state_item", "state_fact"],
		]);
		expect(checkLists(recallControls, "change_kind")).toEqual([
			[...MEMORY_CHANGE_KINDS],
		]);
		expect(checkLists(recallControls, "kind")[0]).toEqual([...STATE_KINDS]);
		expect(checkLists(recallControls, "status")).toEqual([
			[...CANDIDATE_STATUSES],
		]);
	});

	test("upgrading a version 9 database keeps every row and adds the new columns with neutral values", () => {
		store = openTestStore({ migrations: migrations.slice(0, 9) });
		store.writer
			.query(
				`INSERT INTO memory_state_item (item_id, principal, scope_key, subject, kind, semantic_key, status, revision,
					value_text, polarity, origin, evidence_ordinal, created_seq, updated_seq)
				VALUES ('state:old', 'local:owner', 'scope:a', 'self', 'preference', 'drink', 'active', 1,
					'コーヒーが好き', 'affirmed', 'user_confirmed', 0, 1, 1)`,
			)
			.run();
		store.writer
			.query(
				`INSERT INTO memory_change (seq, principal, scope_key, target_type, target_id, revision, status, forget_id, at_ms)
				VALUES (1, 'local:owner', 'scope:a', 'state_item', 'state:old', '1', 'active', NULL, 100)`,
			)
			.run();
		store.writer.exec(migrations[9] as string);
		assertMemorySchema(store.writer);
		expect(
			store.writer
				.query("SELECT item_id, strength, value_text FROM memory_state_item")
				.all(),
		).toEqual([
			{ item_id: "state:old", strength: 1, value_text: "コーヒーが好き" },
		]);
		const feed = store.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: {
					principal: "local:owner",
					scopeKeys: ["scope:a"],
					purpose: "t",
					policyRevision: "1",
				},
				scopeKeys: ["scope:a"],
				afterSeq: 0,
				limit: 10,
			}),
		);
		expect(feed).toEqual({
			status: "ok",
			changes: [
				{
					seq: 1,
					atMs: 100,
					scopeKey: "scope:a",
					targetType: "state_item",
					targetId: "state:old",
					revision: "1",
					status: "active",
					forgetId: null,
				},
			],
			nextAfterSeq: 1,
			hasMore: false,
		});
		for (const table of [
			"memory_exclusion",
			"memory_suppression",
			"memory_inferred_candidate",
			"memory_inferred_candidate_evidence",
		]) {
			expect(
				store.writer.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
			).toEqual({ n: 0 });
		}
		// 範囲外の強度・種類は CHECK が止める。
		expect(() =>
			store?.writer.exec("UPDATE memory_state_item SET strength = 1.5"),
		).toThrow();
		expect(() =>
			store?.writer.exec("UPDATE memory_change SET change_kind = 'other'"),
		).toThrow();
	});

	test("candidates cannot carry another origin and one open candidate per key is enforced", () => {
		store = openTestStore();
		const insert = (id: string, origin: string, status = "open") =>
			store?.writer
				.query(
					`INSERT INTO memory_inferred_candidate (candidate_id, principal, scope_key, kind, subject, semantic_key,
						status, value_text, polarity, origin, evidence_ordinal, created_seq, updated_seq)
					VALUES (?, 'p', 's', 'habit', 'self', 'k', ?, 'v', 'affirmed', ?, 0, 1, 1)`,
				)
				.run(id, status, origin);
		expect(() => insert("cand:1", "user_confirmed")).toThrow();
		insert("cand:1", "agent_inferred");
		expect(() => insert("cand:2", "agent_inferred")).toThrow();
		insert("cand:2", "agent_inferred", "dismissed");
		expect(() => insert("cand:3", "agent_inferred", "promoted")).toThrow();
		store.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('candidate', 'cand:9', 'p', 's', 'f', 1, 1)",
			)
			.run();
		expect(() => insert("cand:9", "agent_inferred", "dismissed")).toThrow();
	});
});
