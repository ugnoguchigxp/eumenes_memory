import { afterEach, describe, expect, test } from "bun:test";
import { sha256Hex } from "../../canonical/sha256.ts";
import { MemoryContractError } from "../../contracts/errors.ts";
import type { StateItem } from "../../contracts/state.ts";
import { sourceKey } from "../../contracts/source-key.ts";
import { candidateIdOf } from "../../extraction/ids.ts";
import {
	confirmCandidate,
	listCandidates,
	prepareExtraction,
} from "../extraction.ts";
import {
	assertUserState,
	deactivateState,
	editState,
	listState,
} from "../state.ts";
import { listMemoryChanges } from "../changes.ts";
import { openTestStore } from "../../../test/support/store.ts";
import type { TestStore } from "../../../test/support/store.ts";
import {
	assertInput,
	editInput,
	makeSpan,
	TEA,
	value,
} from "./state-support.ts";
import {
	ACCESS,
	AUTO,
	DEFAULT_POLICY,
	SCOPE,
	candidateOf,
	count,
	current,
	evidenceOf,
	extSource,
	makeSource,
	prepareInput,
	readyInput,
	settle,
	settleInput,
} from "./extraction-support.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});

function open(): TestStore {
	store = openTestStore();
	return store;
}

const M1 = makeSource("m1", "私はコーヒーが好きです。毎朝飲みます。", 5);
const M2 = makeSource("m2", "最近は紅茶が好きになった🍵。", 8);

function dependencyEdges(s: TestStore): string[] {
	return (
		s.writer
			.query(
				`SELECT dependent_type, dependent_id, dependency_type, dependency_id, role
				FROM memory_dependency ORDER BY dependent_type, dependent_id, dependency_type, dependency_id`,
			)
			.all() as Record<string, string>[]
	).map(
		(row) =>
			`${row["dependent_type"]}>${row["dependency_type"]}:${row["role"]}`,
	);
}

describe("prepareExtraction", () => {
	test("returns a frozen, JSON-able input and records run, inputs and dependency edges (no source text is stored)", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1), extSource(M2)]);
		expect(input.runId).toBe("job1:1");
		expect(input.inputDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(input.sources.map((source) => source.ref.id)).toEqual(["m1", "m2"]);
		expect(input.sources[0]?.role).toBe("user");
		expect(input.sources[0]?.content).toBe(M1.content);
		expect(input.sources[0]?.ref).not.toHaveProperty("range");
		expect(input.instructions.promptVersion).toBe("p1");
		expect(Object.isFrozen(input)).toBe(true);
		expect(Object.isFrozen(input.sources[0])).toBe(true);
		expect(JSON.parse(JSON.stringify(input))).toEqual(input);
		const run = s.writer
			.query("SELECT * FROM memory_extraction_run")
			.get() as Record<string, unknown>;
		expect(run).toMatchObject({
			run_id: "job1:1",
			stage: "prepared",
			input_digest: input.inputDigest,
			extractor_id: "stub",
			prompt_version: "p1",
			provider_ref: "provider-a",
		});
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_extraction_input")).toBe(
			2,
		);
		expect(dependencyEdges(s)).toEqual([
			"extraction_run>source:input",
			"extraction_run>source:input",
		]);
		// 本文は保存しない。
		const dump = JSON.stringify(
			s.writer.query("SELECT * FROM memory_extraction_input").all(),
		);
		expect(dump).not.toContain("コーヒー");
	});

	test("the input digest is deterministic for the same sources and differs for another revision", () => {
		const s1 = open();
		const a = readyInput(s1, "job1", [extSource(M1)]);
		s1.close();
		const s2 = openTestStore();
		store = s2;
		const b = readyInput(s2, "job2", [extSource(M1)]);
		expect(b.inputDigest).toBe(a.inputDigest);
		const changed = makeSource("m1", "私はコーヒーが嫌いです。", 5);
		const c = readyInput(s2, "job3", [extSource(changed)]);
		expect(c.inputDigest).not.toBe(a.inputDigest);
	});

	test("skips: disabled, no new input after processing, tombstoned source, too large", () => {
		const s = open();
		expect(
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("j", [extSource(M1)], { enabled: false }),
				),
			),
		).toEqual({ status: "skip", reasonCode: "MEMORY_DISABLED" });
		expect(
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("j", [extSource(M1)], { maxInputBytes: 10 }),
				),
			),
		).toEqual({ status: "skip", reasonCode: "INPUT_TOO_LARGE" });
		expect(
			s.write((db) => prepareExtraction(db, prepareInput("j", []))),
		).toEqual({ status: "skip", reasonCode: "NO_NEW_INPUT" });

		const input = readyInput(s, "job1", [extSource(M1)]);
		settle(
			s,
			settleInput("job1", { noChange: true, candidates: [] }, [current(M1)]),
		);
		expect(input.runId).toBe("job1:1");
		expect(
			s.write((db) =>
				prepareExtraction(db, prepareInput("job2", [extSource(M1)])),
			),
		).toEqual({ status: "skip", reasonCode: "NO_NEW_INPUT" });
		// 新しい版は新しい入力。
		const next = makeSource("m1", "私は紅茶が好きです。", 6);
		expect(
			s.write((db) =>
				prepareExtraction(db, prepareInput("job3", [extSource(next)])),
			).status,
		).toBe("ready");

		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('source', ?, 'p', 's', 'f', 1, 1)",
			)
			.run(sourceKey(M2));
		expect(
			s.write((db) =>
				prepareExtraction(db, prepareInput("job4", [extSource(M2)])),
			),
		).toEqual({ status: "skip", reasonCode: "SOURCE_TOMBSTONED" });
		expect(
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("job5", [
						extSource(makeSource("m9", "x", 1, { status: "forgotten" })),
					]),
				),
			),
		).toEqual({ status: "skip", reasonCode: "SOURCE_TOMBSTONED" });
	});

	test("a source outside the scope or principal is blocked; a content that does not match its digest is a contract error", () => {
		const s = open();
		expect(
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("j", [
						extSource(makeSource("m1", "a", 1, {}, "conversation:other")),
					]),
				),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
		expect(
			s.write((db) =>
				prepareExtraction(db, {
					...prepareInput("j", [extSource(M1)]),
					scopeKey: "conversation:nope",
				}),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
		expect(() =>
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("j", [extSource({ ...M1, content: "tampered" })]),
				),
			),
		).toThrow(MemoryContractError);
	});

	test("re-preparing a prepared run replaces its inputs; a finished run is not prepared again", () => {
		const s = open();
		readyInput(s, "job1", [extSource(M1)]);
		const again = readyInput(s, "job1", [extSource(M1), extSource(M2)]);
		expect(again.sources.length).toBe(2);
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_extraction_run")).toBe(1);
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_extraction_input")).toBe(
			2,
		);
		settle(
			s,
			settleInput("job1", { noChange: true, candidates: [] }, [
				current(M1),
				current(M2),
			]),
		);
		expect(
			s.write((db) =>
				prepareExtraction(db, prepareInput("job1", [extSource(M1)])),
			),
		).toEqual({ status: "skip", reasonCode: "NO_NEW_INPUT" });
	});

	test("shows active self items (not other-person notes) with their revision and links the run to them", () => {
		const s = open();
		const item = s.write((db) => assertUserState(db, assertInput()));
		if (item.status !== "applied") throw new Error("setup");
		const input = readyInput(s, "job1", [extSource(M2)]);
		expect(input.shownState).toEqual([
			{
				itemId: item.item.itemId,
				revision: 1,
				kind: "preference",
				semanticKey: "drink",
				value: { text: "コーヒーが好き", polarity: "affirmed" },
			},
		]);
		expect(dependencyEdges(s)).toContain("extraction_run>state_item:input");
	});
});

describe("settleExtraction: applying outputs", () => {
	test("default policy only creates pending candidates; nothing becomes a state item", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [candidateOf(input, "コーヒーが好き")],
				},
				[current(M1)],
			),
		);
		expect(result).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 1,
			rejected: 0,
		});
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(0);
		const listed = s.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		if (listed.status !== "ok") throw new Error("list");
		expect(listed.candidates).toHaveLength(1);
		const candidate = listed.candidates[0];
		expect(candidate).toMatchObject({
			candidateId: candidateIdOf("job1:1", 0),
			runId: "job1:1",
			kind: "preference",
			subject: "self",
			semanticKey: "drink",
			value: { text: "コーヒー", polarity: "affirmed" },
			decision: "pending_user",
			reasonCode: "POLICY_REQUIRES_USER",
		});
		expect(candidate?.evidence).toHaveLength(1);
		expect(candidate?.evidence[0]?.quoteDigest).toBe(
			sha256Hex("コーヒーが好き"),
		);
		expect(candidate?.evidence[0]?.source.range).toEqual({
			startByte: 6,
			endByte: 6 + Buffer.byteLength("コーヒーが好き", "utf8"),
		});
		const run = s.writer
			.query("SELECT stage, pending_count FROM memory_extraction_run")
			.get();
		expect(run).toEqual({ stage: "settled", pending_count: 1 });
		const progress = s.writer
			.query(
				"SELECT processed_revision, stage, run_id FROM memory_source_progress",
			)
			.get();
		expect(progress).toEqual({
			processed_revision: M1.revision,
			stage: "extracted",
			run_id: "job1:1",
		});
		expect(dependencyEdges(s).sort()).toEqual(
			[
				"candidate>extraction_run:derived_from",
				"candidate>source:primary",
				"extraction_run>source:input",
			].sort(),
		);
	});

	test("auto_admit (explicit policy) creates an admitted_extraction item with the full dependency chain", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [candidateOf(input, "コーヒーが好き")],
				},
				[current(M1)],
				AUTO,
			),
		);
		expect(result).toEqual({
			status: "applied",
			admitted: 1,
			pendingUser: 0,
			rejected: 0,
		});
		const items = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		if (items.status !== "ok") throw new Error("list");
		expect(items.items).toHaveLength(1);
		const item = items.items[0] as StateItem;
		expect(item).toMatchObject({
			origin: "admitted_extraction",
			status: "active",
			kind: "preference",
			semanticKey: "drink",
			evidenceOrdinal: 5,
		});
		expect(dependencyEdges(s).sort()).toEqual(
			[
				"candidate>extraction_run:derived_from",
				"candidate>source:primary",
				"extraction_run>source:input",
				"state_item>candidate:derived_from",
				"state_item>source:primary",
			].sort(),
		);
		const changes = s.read((db) =>
			listMemoryChanges(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: [SCOPE],
				afterSeq: 0,
				limit: 10,
			}),
		);
		if (changes.status !== "ok") throw new Error("changes");
		expect(changes.changes.map((change) => change.targetType)).toEqual([
			"state_item",
		]);
	});

	test("two admitted candidates in one settle get different item ids", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1), extSource(M2)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "コーヒーが好き", { semanticKey: "drink" }),
						candidateOf(input, "紅茶が好き", { semanticKey: "tea" }, 1),
					],
				},
				[current(M1), current(M2)],
				AUTO,
			),
		);
		expect(result).toMatchObject({ status: "applied", admitted: 2 });
		expect(
			count(s, "SELECT COUNT(DISTINCT item_id) AS n FROM memory_state_item"),
		).toBe(2);
	});

	test("rejected candidates keep their row when well-formed; invalid ones are only counted", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "コーヒーが好き", { modality: "hypothetical" }),
						candidateOf(input, "コーヒーが好き", { kind: "goal" }),
						candidateOf(input, "コーヒーが好き", { modality: "maybe" }),
						candidateOf(input, "コーヒーが好き", {
							evidence: [
								{ ...evidenceOf(input, 0, "コーヒーが好き"), quote: "紅茶" },
							],
						}),
					],
				},
				[current(M1)],
				AUTO,
			),
		);
		expect(result).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 0,
			rejected: 4,
		});
		const rows = s.writer
			.query(
				"SELECT idx, decision, reason_code FROM memory_candidate ORDER BY idx",
			)
			.all();
		expect(rows).toEqual([
			{ idx: 0, decision: "rejected", reason_code: "MODALITY_NOT_ASSERTED" },
			{ idx: 3, decision: "rejected", reason_code: "QUOTE_MISMATCH" },
		]);
		// 検査を通らなかった evidence は保存しない。
		expect(
			count(s, "SELECT COUNT(*) AS n FROM memory_candidate_evidence"),
		).toBe(1);
	});

	test("noChange records no_change progress", () => {
		const s = open();
		readyInput(s, "job1", [extSource(M1)]);
		const result = settle(
			s,
			settleInput("job1", { noChange: true, candidates: [] }, [current(M1)]),
		);
		expect(result).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 0,
			rejected: 0,
		});
		expect(
			s.writer.query("SELECT stage FROM memory_source_progress").get(),
		).toEqual({ stage: "no_change" });
	});

	test("a candidate citing a source without content cannot be verified (QUOTE_MISMATCH)", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const { content: _content, ...withoutContent } = current(M1);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [candidateOf(input, "コーヒーが好き")],
				},
				[withoutContent],
				AUTO,
			),
		);
		expect(result).toMatchObject({ status: "applied", rejected: 1 });
		expect(
			s.writer.query("SELECT reason_code FROM memory_candidate").get(),
		).toEqual({ reason_code: "QUOTE_MISMATCH" });
	});

	test("replaces must name a shown item for the same key", () => {
		const s = open();
		const asserted = s.write((db) => assertUserState(db, assertInput()));
		if (asserted.status !== "applied") throw new Error("setup");
		const input = readyInput(s, "job1", [extSource(TEA)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "紅茶が好き", {
							value: { text: "紅茶", polarity: "affirmed" },
							replaces: "state:unknown",
						}),
					],
				},
				[current(TEA)],
				AUTO,
			),
		);
		expect(result).toMatchObject({ status: "applied", rejected: 1 });
	});
});

describe("settleExtraction: rejected output and stale", () => {
	test("schema violations reject the whole run, record failed_output progress, and are idempotent", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const bad = {
			noChange: false,
			candidates: [candidateOf(input, "コーヒーが好き", { scope: "x" })],
		};
		const first = settle(s, settleInput("job1", bad, [current(M1)], AUTO));
		expect(first).toEqual({
			status: "rejected_output",
			reasonCode: "OUTPUT_SCHEMA",
		});
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);
		expect(
			s.writer.query("SELECT stage FROM memory_source_progress").get(),
		).toEqual({ stage: "failed_output" });
		expect(settle(s, settleInput("job1", bad, [current(M1)], AUTO))).toEqual(
			first,
		);
		expect(
			settle(
				s,
				settleInput("job1", { noChange: true, candidates: [] }, [current(M1)]),
			),
		).toEqual({ status: "stale", reasonCode: "RUN_ALREADY_SETTLED_DIFFERENT" });
		// failed_output の出典は次の prepare で再び入力になる。
		expect(
			s.write((db) =>
				prepareExtraction(db, prepareInput("job2", [extSource(M1)])),
			).status,
		).toBe("ready");
	});

	test("too many candidates and too large outputs are rejected", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const many = Array.from({ length: 11 }, (_, i) =>
			candidateOf(input, "コーヒーが好き", { semanticKey: `k${i}` }),
		);
		expect(
			settle(
				s,
				settleInput("job1", { noChange: false, candidates: many }, [
					current(M1),
				]),
			),
		).toEqual({ status: "rejected_output", reasonCode: "TOO_MANY_CANDIDATES" });
		const input2 = readyInput(s, "job2", [extSource(M2)]);
		expect(
			settle(
				s,
				settleInput(
					"job2",
					{
						noChange: false,
						candidates: [
							candidateOf(input2, "紅茶が好き", {
								value: { text: "あ".repeat(6000), polarity: "affirmed" },
								evidence: [evidenceOf(input2, 0, "紅茶が好き")],
							}),
						],
					},
					[current(M2)],
				),
			),
		).toEqual({ status: "rejected_output", reasonCode: "OUTPUT_TOO_LARGE" });
	});

	test("a changed source, a forgotten source, a tombstoned source and an unknown run are stale and write nothing", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const output = {
			noChange: false,
			candidates: [candidateOf(input, "コーヒーが好き")],
		};
		const changed = makeSource("m1", "私は紅茶が好きです。", 5);
		expect(
			settle(s, settleInput("job1", output, [current(changed)], AUTO)),
		).toEqual({ status: "stale", reasonCode: "SOURCE_CHANGED" });
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_source_progress")).toBe(
			0,
		);
		expect(
			s.writer
				.query("SELECT stage, outcome_code FROM memory_extraction_run")
				.get(),
		).toEqual({ stage: "stale", outcome_code: "SOURCE_CHANGED" });
		// stale は確定。同じ output の再 settle は同じ結果。
		expect(settle(s, settleInput("job1", output, [current(M1)], AUTO))).toEqual(
			{ status: "stale", reasonCode: "SOURCE_CHANGED" },
		);

		const input2 = readyInput(s, "job2", [extSource(M2)]);
		const output2 = {
			noChange: false,
			candidates: [
				candidateOf(input2, "紅茶が好き", {
					evidence: [evidenceOf(input2, 0, "紅茶が好き")],
				}),
			],
		};
		expect(
			settle(
				s,
				settleInput(
					"job2",
					output2,
					[{ ...current(M2), status: "forgotten" }],
					AUTO,
				),
			),
		).toEqual({ status: "stale", reasonCode: "SOURCE_TOMBSTONED" });

		const input3 = readyInput(s, "job3", [extSource(M1)], {
			run: { jobId: "job3", attempt: 7 },
		});
		void input3;
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('source', ?, 'p', 's', 'f', 1, 1)",
			)
			.run(sourceKey(M1));
		expect(
			settle(
				s,
				settleInput("job3", output, [current(M1)], AUTO, {
					run: { jobId: "job3", attempt: 7 },
				}),
			),
		).toEqual({ status: "stale", reasonCode: "SOURCE_TOMBSTONED" });
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);

		expect(settle(s, settleInput("nope", output, [current(M1)], AUTO))).toEqual(
			{ status: "stale", reasonCode: "RUN_UNKNOWN" },
		);
	});

	test("a changed shown item makes the whole run stale (STATE_CHANGED)", () => {
		const s = open();
		const asserted = s.write((db) => assertUserState(db, assertInput()));
		if (asserted.status !== "applied") throw new Error("setup");
		const input = readyInput(s, "job1", [extSource(TEA)]);
		const edited = s.write((db) =>
			editState(db, editInput(asserted.item.itemId, 1)),
		);
		expect(edited.status).toBe("applied");
		expect(
			settle(
				s,
				settleInput(
					"job1",
					{
						noChange: false,
						candidates: [candidateOf(input, "紅茶が好き")],
					},
					[current(TEA)],
					AUTO,
				),
			),
		).toEqual({ status: "stale", reasonCode: "STATE_CHANGED" });
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);
	});

	test("a shown item that was deactivated also stales the run", () => {
		const s = open();
		const asserted = s.write((db) => assertUserState(db, assertInput()));
		if (asserted.status !== "applied") throw new Error("setup");
		readyInput(s, "job1", [extSource(TEA)]);
		s.write((db) =>
			deactivateState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 5 },
				itemId: asserted.item.itemId,
				expectedRevision: 1,
			}),
		);
		expect(
			settle(
				s,
				settleInput("job1", { noChange: true, candidates: [] }, [current(TEA)]),
			),
		).toEqual({ status: "stale", reasonCode: "STATE_CHANGED" });
	});

	test("blocked scope and a different principal's run", () => {
		const s = open();
		readyInput(s, "job1", [extSource(M1)]);
		expect(
			settle(
				s,
				settleInput(
					"job1",
					{ noChange: true, candidates: [] },
					[current(M1)],
					DEFAULT_POLICY,
					{
						scopeKey: "conversation:nope",
					},
				),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
		expect(
			settle(
				s,
				settleInput(
					"job1",
					{ noChange: true, candidates: [] },
					[current(M1)],
					DEFAULT_POLICY,
					{
						access: { ...ACCESS, principal: "local:other" },
					},
				),
			),
		).toEqual({ status: "stale", reasonCode: "RUN_UNKNOWN" });
	});
});

describe("settleExtraction: user-confirmed items are protected", () => {
	test("an extraction candidate that differs from a user_confirmed active goes to pending_user even with auto_admit; confirming supersedes it", () => {
		const s = open();
		const asserted = s.write((db) => assertUserState(db, assertInput()));
		if (asserted.status !== "applied") throw new Error("setup");
		const input = readyInput(s, "job1", [extSource(TEA)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "紅茶が好き", {
							value: { text: "紅茶が好き", polarity: "affirmed" },
							replaces: asserted.item.itemId,
						}),
					],
				},
				[current(TEA)],
				AUTO,
			),
		);
		expect(result).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 1,
			rejected: 0,
		});
		const active = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		if (active.status !== "ok") throw new Error("list");
		expect(active.items.map((item) => item.value.text)).toEqual([
			"コーヒーが好き",
		]);

		const confirmed = s.write((db) =>
			confirmCandidate(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 3000 },
				candidateId: candidateIdOf("job1:1", 0),
				action: "admit",
				currentSources: [current(TEA)],
			}),
		);
		if (confirmed.status !== "admitted")
			throw new Error(JSON.stringify(confirmed));
		expect(confirmed.item).toMatchObject({
			origin: "user_confirmed",
			status: "active",
			value: { text: "紅茶が好き", polarity: "affirmed" },
		});
		const all = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: true,
			}),
		);
		if (all.status !== "ok") throw new Error("list");
		expect(
			all.items.map((item) => `${item.value.text}:${item.status}`).sort(),
		).toEqual(["コーヒーが好き:superseded", "紅茶が好き:active"]);
		expect(
			s.writer.query("SELECT decision, resolution FROM memory_candidate").get(),
		).toEqual({ decision: "admitted", resolution: "user_admitted" });
		expect(dependencyEdges(s)).toContain("state_item>candidate:derived_from");
	});

	test("an extraction candidate with a newer source supersedes an admitted_extraction active, and equal ordinals dispute", () => {
		const s = open();
		const first = readyInput(s, "job1", [extSource(M1)]);
		settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [candidateOf(first, "コーヒーが好き")],
				},
				[current(M1)],
				AUTO,
			),
		);
		const second = readyInput(s, "job2", [extSource(M2)]);
		const result = settle(
			s,
			settleInput(
				"job2",
				{
					noChange: false,
					candidates: [
						candidateOf(second, "紅茶が好き", {
							value: { text: "紅茶", polarity: "affirmed" },
						}),
					],
				},
				[current(M2)],
				AUTO,
			),
		);
		expect(result).toMatchObject({ status: "applied", admitted: 1 });
		const all = s.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: true,
			}),
		);
		if (all.status !== "ok") throw new Error("list");
		expect(
			all.items.map((item) => `${item.value.text}:${item.status}`).sort(),
		).toEqual(["コーヒー:superseded", "紅茶:active"]);

		// 同順位で値が違う → 双方 disputed。
		const m3 = makeSource("m3", "うどんが好き。そばが好き。", 8);
		const third = readyInput(s, "job3", [extSource(m3)]);
		settle(
			s,
			settleInput(
				"job3",
				{
					noChange: false,
					candidates: [
						candidateOf(third, "うどんが好き", {
							semanticKey: "noodle",
							value: { text: "うどん", polarity: "affirmed" },
						}),
					],
				},
				[current(m3)],
				AUTO,
			),
		);
		const m4 = makeSource("m4", "やっぱりそばが好き。", 8);
		const fourth = readyInput(s, "job4", [extSource(m4)]);
		settle(
			s,
			settleInput(
				"job4",
				{
					noChange: false,
					candidates: [
						candidateOf(fourth, "そばが好き", {
							semanticKey: "noodle",
							value: { text: "そば", polarity: "affirmed" },
						}),
					],
				},
				[current(m4)],
				AUTO,
			),
		);
		expect(
			s.writer
				.query(
					"SELECT status FROM memory_state_item WHERE semantic_key = 'noodle' ORDER BY created_seq",
				)
				.all(),
		).toEqual([{ status: "disputed" }, { status: "disputed" }]);
	});
});

describe("confirmCandidate", () => {
	function pending(s: TestStore, jobId = "job1") {
		const input = readyInput(s, jobId, [extSource(M1)]);
		settle(
			s,
			settleInput(
				jobId,
				{
					noChange: false,
					candidates: [candidateOf(input, "コーヒーが好き")],
				},
				[current(M1)],
			),
		);
		return candidateIdOf(`${jobId}:1`, 0);
	}
	function confirm(
		s: TestStore,
		candidateId: string,
		action: "admit" | "reject",
		extra: Record<string, unknown> = {},
		sources = [current(M1)],
	) {
		return s.write((db) =>
			confirmCandidate(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 3000 },
				candidateId,
				action,
				currentSources: sources,
				...extra,
			}),
		);
	}

	test("admit creates a user_confirmed item; a second confirmation reports not_pending", () => {
		const s = open();
		const id = pending(s);
		const result = confirm(s, id, "admit");
		if (result.status !== "admitted") throw new Error(JSON.stringify(result));
		expect(result.item).toMatchObject({
			origin: "user_confirmed",
			value: { text: "コーヒー", polarity: "affirmed" },
			evidenceOrdinal: 5,
		});
		expect(confirm(s, id, "admit")).toEqual({
			status: "not_pending",
			decision: "admitted",
		});
		const listed = s.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(listed).toEqual({ status: "ok", candidates: [] });
	});

	test("an edited value makes the item user_edited", () => {
		const s = open();
		const id = pending(s);
		const result = confirm(s, id, "admit", {
			editedValue: value("ブラックコーヒー", "affirmed", { roast: "dark" }),
		});
		if (result.status !== "admitted") throw new Error(JSON.stringify(result));
		expect(result.item).toMatchObject({
			origin: "user_edited",
			value: {
				text: "ブラックコーヒー",
				attributes: { roast: "dark" },
			},
		});
	});

	test("reject keeps the candidate as rejected without touching state", () => {
		const s = open();
		const id = pending(s);
		expect(confirm(s, id, "reject")).toEqual({ status: "rejected" });
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(0);
		expect(
			s.writer.query("SELECT decision, resolution FROM memory_candidate").get(),
		).toEqual({ decision: "rejected", resolution: "user_rejected" });
		const rejected = s.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				decision: "rejected",
			}),
		);
		if (rejected.status !== "ok") throw new Error("list");
		expect(rejected.candidates).toHaveLength(1);
	});

	test("admit is refused when the evidence source changed or was forgotten, and nothing is written", () => {
		const s = open();
		const id = pending(s);
		const changed = makeSource("m1", "別の内容", 5);
		expect(confirm(s, id, "admit", {}, [current(changed)])).toEqual({
			status: "refused",
			reasonCode: "SOURCE_STALE",
		});
		expect(confirm(s, id, "admit", {}, [])).toEqual({
			status: "refused",
			reasonCode: "SOURCE_STALE",
		});
		expect(
			confirm(s, id, "admit", {}, [{ ...current(M1), status: "forgotten" }]),
		).toEqual({ status: "refused", reasonCode: "SOURCE_TOMBSTONED" });
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('source', ?, 'p', 's', 'f', 1, 1)",
			)
			.run(sourceKey(M1));
		expect(confirm(s, id, "admit")).toEqual({
			status: "refused",
			reasonCode: "SOURCE_TOMBSTONED",
		});
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(0);
	});

	test("admit is refused (ACTIVE_EXISTS) when a different active appeared after the candidate was made", () => {
		const s = open();
		const id = pending(s);
		s.write((db) =>
			assertUserState(
				db,
				assertInput({
					value: value("紅茶が好き"),
					evidence: [makeSpan(TEA, "紅茶が好き")],
					sources: [TEA],
				}),
			),
		);
		expect(confirm(s, id, "admit")).toEqual({
			status: "refused",
			reasonCode: "ACTIVE_EXISTS",
		});
	});

	test("unknown, other-scope and tombstoned candidates", () => {
		const s = open();
		const id = pending(s);
		expect(confirm(s, "cand:none", "admit")).toEqual({ status: "missing" });
		expect(
			s.write((db) =>
				confirmCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: "conversation:nope",
					clock: { atMs: 1 },
					candidateId: id,
					action: "reject",
					currentSources: [],
				}),
			),
		).toEqual({ status: "not_permitted" });
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('candidate', ?, 'p', 's', 'f', 1, 1)",
			)
			.run(id);
		expect(confirm(s, id, "admit")).toEqual({ status: "forgotten" });
		const listed = s.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(listed).toEqual({ status: "ok", candidates: [] });
	});

	test("rejects an edited value together with reject", () => {
		const s = open();
		const id = pending(s);
		expect(() => confirm(s, id, "reject", { editedValue: value("x") })).toThrow(
			MemoryContractError,
		);
	});
});

describe("candidate and run tables", () => {
	test("a tombstoned run or candidate id cannot be inserted again; a tombstoned source cannot gain progress", () => {
		const s = open();
		const tombstone = (type: string, id: string) =>
			s.writer
				.query(
					"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES (?, ?, 'p', 's', 'f', 1, 1)",
				)
				.run(type, id);
		tombstone("extraction_run", "j:1");
		tombstone("candidate", "cand:x");
		tombstone("source", "src-key");
		expect(() =>
			s.writer
				.query(
					"INSERT INTO memory_extraction_run (run_id, principal, scope_key, stage, input_digest, extractor_id, prompt_version, provider_ref, prepared_seq) VALUES ('j:1', 'p', 's', 'prepared', 'd', 'e', 'v', 'r', 1)",
				)
				.run(),
		).toThrow(/memory_tombstoned/);
		expect(() =>
			s.writer
				.query(
					"INSERT INTO memory_source_progress (principal, scope_key, source_key, processed_revision, stage, run_id, seq) VALUES ('p', 's', 'src-key', 'r', 'extracted', 'j:1', 1)",
				)
				.run(),
		).toThrow(/memory_tombstoned/);
		s.writer
			.query(
				"INSERT INTO memory_extraction_run (run_id, principal, scope_key, stage, input_digest, extractor_id, prompt_version, provider_ref, prepared_seq) VALUES ('j:2', 'p', 's', 'prepared', 'd', 'e', 'v', 'r', 1)",
			)
			.run();
		expect(() =>
			s.writer
				.query(
					`INSERT INTO memory_candidate (candidate_id, run_id, idx, principal, scope_key, kind, subject, semantic_key,
					 value_text, polarity, modality, temporal, decision, evidence_ordinal, created_seq)
					VALUES ('cand:x', 'j:2', 0, 'p', 's', 'preference', 'self', 'k', 'v', 'affirmed', 'asserted', 'current', 'pending_user', 0, 1)`,
				)
				.run(),
		).toThrow(/memory_tombstoned/);
	});
});

// ---- レビュー B: prepare の非 available な出典、never の候補、subject unknown、stale の分岐、shown ----

describe("prepareExtraction with sources that are not available", () => {
	const original = makeSource("mx", "私は辛いものが苦手。", 5);

	/** ホストが本文を読めない出典: 本文は空だが digest / revision は元のまま。 */
	function unreadable(status: "forgotten" | "missing" | "changed") {
		return makeSource("mx", "", 5, {
			status,
			digest: original.digest,
			revision: original.revision,
		});
	}

	test("a forgotten source with an empty body is SOURCE_TOMBSTONED, not a digest error (reviewer repro t5)", () => {
		const s = open();
		expect(
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("j1", [extSource(unreadable("forgotten"))]),
				),
			),
		).toEqual({ status: "skip", reasonCode: "SOURCE_TOMBSTONED" });
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_extraction_run")).toBe(0);
	});

	test("missing / changed sources with an empty body are skipped without a digest check; the available one is still processed", () => {
		const s = open();
		for (const status of ["missing", "changed"] as const) {
			expect(
				s.write((db) =>
					prepareExtraction(
						db,
						prepareInput(`j-${status}`, [extSource(unreadable(status))]),
					),
				),
			).toEqual({ status: "skip", reasonCode: "NO_NEW_INPUT" });
		}
		const ready = s.write((db) =>
			prepareExtraction(
				db,
				prepareInput("j-mixed", [
					extSource(unreadable("missing")),
					extSource(M1),
				]),
			),
		);
		expect(ready.status).toBe("ready");
		expect(
			ready.status === "ready" && ready.input.sources.map((x) => x.ref.id),
		).toEqual(["m1"]);
	});

	test("an available source whose body does not match its digest is still a contract error", () => {
		const s = open();
		expect(() =>
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("j1", [
						extSource(
							makeSource("mx", "", 5, {
								digest: original.digest,
								revision: original.revision,
							}),
						),
					]),
				),
			),
		).toThrow(MemoryContractError);
		// 他の出典が壊れていても、forgotten の出典があれば先に検査で落ちるのは available の方（順序に依存しない）
		expect(() =>
			s.write((db) =>
				prepareExtraction(
					db,
					prepareInput("j2", [
						extSource(unreadable("forgotten")),
						extSource({ ...M1, content: "tampered" }),
					]),
				),
			),
		).toThrow(MemoryContractError);
	});

	test("the shown state never includes other-person notes, and the run has no edge to them", () => {
		const s = open();
		const self = s.write((db) => assertUserState(db, assertInput()));
		const note = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					kind: "other_person_note",
					subject: "other:mother",
					semanticKey: "drink",
					value: value("紅茶が好き"),
					evidence: [makeSpan(TEA, "紅茶が好き")],
					sources: [TEA],
				}),
			),
		);
		if (self.status !== "applied" || note.status !== "applied")
			throw new Error("setup");
		const input = readyInput(s, "job1", [extSource(M2)]);
		expect(input.shownState.map((item) => item.itemId)).toEqual([
			self.item.itemId,
		]);
		const edges = s.writer
			.query(
				"SELECT dependency_id FROM memory_dependency WHERE dependent_type = 'extraction_run' AND dependency_type = 'state_item'",
			)
			.all();
		expect(edges).toEqual([{ dependency_id: self.item.itemId }]);
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_extraction_shown")).toBe(
			1,
		);
	});
});

describe("settleExtraction: policy never leaves no candidate row", () => {
	const NEVER = { ...DEFAULT_POLICY, preference: "never" as const };

	test("a never-kind candidate is only counted: no candidate, no evidence, no value anywhere", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "コーヒーが好き"),
						candidateOf(input, "コーヒーが好き", {
							modality: "quoted",
							semanticKey: "d2",
						}),
						candidateOf(input, "コーヒーが好き", {
							temporal: "past",
							semanticKey: "d3",
						}),
					],
				},
				[current(M1)],
				NEVER,
			),
		);
		expect(result).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 0,
			rejected: 3,
		});
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);
		expect(
			count(s, "SELECT COUNT(*) AS n FROM memory_candidate_evidence"),
		).toBe(0);
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(0);
		expect(
			s.read((db) =>
				listCandidates(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					decision: "rejected",
				}),
			),
		).toEqual({ status: "ok", candidates: [] });
		expect(
			dependencyEdges(s).filter((edge) => edge.startsWith("candidate")),
		).toEqual([]);
	});

	test("other rejections keep an audit row with the value (hypothetical, quote mismatch, older evidence); listCandidates returns them with their value", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "コーヒーが好き", { modality: "hypothetical" }),
					],
				},
				[current(M1)],
				AUTO,
			),
		);
		const listed = s.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				decision: "rejected",
			}),
		);
		expect(listed.status === "ok" && listed.candidates).toMatchObject([
			{
				decision: "rejected",
				reasonCode: "MODALITY_NOT_ASSERTED",
				value: { text: "コーヒー" },
			},
		]);
	});
});

describe("settleExtraction: subject unknown", () => {
	test("a quoted candidate about an unknown subject is rejected (SUBJECT_UNKNOWN), never left pending", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const result = settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "コーヒーが好き", {
							subject: "unknown",
							modality: "quoted",
						}),
						candidateOf(input, "コーヒーが好き", {
							subject: "unknown",
							semanticKey: "d2",
						}),
					],
				},
				[current(M1)],
				AUTO,
			),
		);
		expect(result).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 0,
			rejected: 2,
		});
		expect(
			s.writer
				.query(
					"SELECT decision, reason_code, subject FROM memory_candidate ORDER BY idx",
				)
				.all(),
		).toEqual([
			{
				decision: "rejected",
				reason_code: "SUBJECT_UNKNOWN",
				subject: "unknown",
			},
			{
				decision: "rejected",
				reason_code: "SUBJECT_UNKNOWN",
				subject: "unknown",
			},
		]);
	});

	test("confirmCandidate refuses a pending candidate whose subject is unknown (even if a row was forced)", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		settle(
			s,
			settleInput(
				"job1",
				{
					noChange: false,
					candidates: [
						candidateOf(input, "コーヒーが好き", { subject: "unknown" }),
					],
				},
				[current(M1)],
				AUTO,
			),
		);
		const candidateId = candidateIdOf("job1:1", 0);
		s.writer
			.query(
				"UPDATE memory_candidate SET decision = 'pending_user' WHERE candidate_id = ?",
			)
			.run(candidateId);
		const result = s.write((db) =>
			confirmCandidate(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 3000 },
				candidateId,
				action: "admit",
				currentSources: [current(M1)],
			}),
		);
		expect(result).toEqual({
			status: "refused",
			reasonCode: "SUBJECT_KIND_MISMATCH",
		});
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_state_item")).toBe(0);
	});
});

describe("settleExtraction: staleness branches", () => {
	function prepared() {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const output = {
			noChange: false,
			candidates: [candidateOf(input, "コーヒーが好き")],
		};
		return { s, output };
	}
	const alt = "b".repeat(64);

	test("every way the current state can differ from the prepared input is SOURCE_CHANGED and writes nothing", () => {
		const variants: Record<
			string,
			(m: ReturnType<typeof current>) => ReturnType<typeof current>
		> = {
			"status changed": (m) => ({ ...m, status: "changed" }),
			"status missing": (m) => ({ ...m, status: "missing" }),
			"revision only": (m) => ({ ...m, revision: "sha256:other-revision" }),
			"digest only": (m) => ({ ...m, digest: alt }),
			"absent from current": (m) => ({ ...m, id: "someone-else" }),
		};
		for (const [label, change] of Object.entries(variants)) {
			const { s, output } = prepared();
			const result = settle(
				s,
				settleInput("job1", output, [change(current(M1))], AUTO),
			);
			expect({ label, result }).toEqual({
				label,
				result: { status: "stale", reasonCode: "SOURCE_CHANGED" },
			});
			expect(count(s, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);
			s.close();
			store = undefined;
		}
		// 対照: 何も変わっていなければ適用される
		const { s, output } = prepared();
		expect(
			settle(s, settleInput("job1", output, [current(M1)], AUTO)),
		).toMatchObject({ status: "applied" });
	});
});

describe("settleExtraction: policy parse", () => {
	test("other_person_note cannot be auto_admit (INVALID_ENUM at the policy path), other kinds can", () => {
		const s = open();
		const input = readyInput(s, "job1", [extSource(M1)]);
		const output = {
			noChange: false,
			candidates: [candidateOf(input, "コーヒーが好き")],
		};
		let error: unknown;
		try {
			settle(
				s,
				settleInput("job1", output, [current(M1)], {
					...AUTO,
					other_person_note: "auto_admit",
				}),
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(MemoryContractError);
		expect(error).toMatchObject({
			code: "INVALID_ENUM",
			path: "$.policy.other_person_note",
		});
		expect(count(s, "SELECT COUNT(*) AS n FROM memory_candidate")).toBe(0);
	});
});
