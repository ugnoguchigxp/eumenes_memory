import { afterEach, describe, expect, test } from "bun:test";
import {
	MODALITIES,
	POLARITIES,
	SOURCE_ROLES,
	TEMPORALS,
} from "../../../contracts/common.ts";
import {
	CANDIDATE_DECISIONS,
	EXTRACTION_RUN_STAGES,
	SOURCE_PROGRESS_STAGES,
} from "../contracts/index.ts";
import {
	ADMISSION_REASON_CODES,
	STATE_KINDS,
} from "../../state/contracts/index.ts";
import { sql as state } from "../../state/migrations/0003-state.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function checkList(column: string, table: string): string[] {
	const tableBody = new RegExp(
		`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`,
	).exec(state)?.[1];
	if (tableBody === undefined) throw new Error(`table ${table} not found`);
	const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(tableBody);
	if (match?.[1] === undefined) throw new Error(`${column} CHECK not found`);
	return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

describe("0003 extraction part", () => {
	test("CHECK enumerations equal the contract tuples", () => {
		expect(checkList("stage", "memory_extraction_run")).toEqual([
			...EXTRACTION_RUN_STAGES,
		]);
		expect(checkList("role", "memory_extraction_input")).toEqual([
			...SOURCE_ROLES,
		]);
		expect(checkList("kind", "memory_candidate")).toEqual([...STATE_KINDS]);
		expect(checkList("polarity", "memory_candidate")).toEqual([...POLARITIES]);
		expect(checkList("modality", "memory_candidate")).toEqual([...MODALITIES]);
		expect(checkList("temporal", "memory_candidate")).toEqual([...TEMPORALS]);
		expect(checkList("decision", "memory_candidate")).toEqual([
			...CANDIDATE_DECISIONS,
		]);
		expect(checkList("reason_code", "memory_candidate")).toEqual([
			...ADMISSION_REASON_CODES,
		]);
		expect(checkList("stage", "memory_source_progress")).toEqual([
			...SOURCE_PROGRESS_STAGES,
		]);
	});

	test("every extraction table, index and trigger is memory_-prefixed; scope indexes lead with principal, scope_key", () => {
		store = openTestStore();
		const rows = store.writer
			.query(
				`SELECT type, name, sql FROM sqlite_master
				WHERE (tbl_name LIKE 'memory_extraction_%' OR tbl_name LIKE 'memory_candidate%'
					OR tbl_name = 'memory_source_progress') AND name NOT LIKE 'sqlite_%'`,
			)
			.all() as { type: string; name: string; sql: string | null }[];
		expect(
			rows
				.filter((row) => row.type === "table")
				.map((row) => row.name)
				.sort(),
		).toEqual([
			"memory_candidate",
			"memory_candidate_evidence",
			"memory_extraction_input",
			"memory_extraction_run",
			"memory_extraction_shown",
			"memory_source_progress",
		]);
		for (const row of rows) expect(row.name.startsWith("memory_")).toBe(true);
		for (const name of [
			"memory_extraction_run_by_scope",
			"memory_candidate_by_scope",
		]) {
			expect(rows.find((row) => row.name === name)?.sql).toContain(
				"(principal, scope_key,",
			);
		}
		expect(
			rows
				.filter((row) => row.type === "trigger")
				.map((row) => row.name)
				.sort(),
		).toEqual([
			"memory_candidate_no_resurrection",
			"memory_extraction_run_no_resurrection",
			"memory_source_progress_no_resurrection",
		]);
	});

	test("a candidate needs a state kind and a decision/value pairing", () => {
		store = openTestStore();
		const run = store.writer.query(
			"INSERT INTO memory_extraction_run (run_id, principal, scope_key, stage, input_digest, extractor_id, prompt_version, provider_ref, prepared_seq) VALUES ('j:1', 'p', 's', 'prepared', 'd', 'e', 'v', 'r', 1)",
		);
		run.run();
		let counter = 0;
		const insert = (kind: string, decision: string, text: string | null) =>
			store!.writer
				.query(
					`INSERT INTO memory_candidate (candidate_id, run_id, idx, principal, scope_key, kind, subject, semantic_key,
					 value_text, polarity, modality, temporal, decision, evidence_ordinal, created_seq)
					VALUES (?, 'j:1', ?, 'p', 's', ?, 'self', 'k', ?, 'affirmed', 'asserted', 'current', ?, 0, 1)`,
				)
				.run(
					`cand:${kind}-${decision}-${text}`,
					counter++,
					kind,
					text,
					decision,
				);
		insert("preference", "pending_user", "v");
		expect(() => insert("goal", "rejected", "v")).toThrow();
		expect(() => insert("preference", "pending_user", null)).toThrow();
		insert("preference", "forgotten", null);
	});
});
