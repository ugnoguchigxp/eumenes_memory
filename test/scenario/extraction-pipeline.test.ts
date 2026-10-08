/**
 * Extraction のパイプライン試験（S 段階）: stub の ExtractorPort を使い、実 SQLite で
 * prepare → (execute) → (source 変更・忘却) → settle を通す。FG9（忘却と抽出の競合）を含む。
 * モデルを使わないので意味精度は主張しない（ruleExtractor は正規表現だけ）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	ExtractionInput,
	ExtractorPort,
	SourceState,
} from "eumenes-memory";
import {
	confirmCandidate,
	listCandidates,
	listState,
	prepareExtraction,
	readRecord,
	recordSourceStates,
	settleExtraction,
} from "eumenes-memory/sqlite";
import type { MemoryDb } from "eumenes-memory/sqlite";
import {
	accessFor,
	capture,
	forgetRecord,
	reconcile,
} from "../runners/records-support.ts";
import type { Captured } from "../runners/records-support.ts";
import {
	cannedExtractor,
	evidenceFor,
	faultyExtractor,
	ruleExtractor,
} from "../runners/extraction-stubs.ts";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";

const SCOPE = "scope:a";
const ACCESS = accessFor();
const AUTO = {
	preference: "auto_admit",
	personal_fact: "auto_admit",
	constraint: "auto_admit",
	habit: "auto_admit",
	other_person_note: "user_confirm",
} as const;
const DEFAULT = {
	preference: "user_confirm",
	personal_fact: "user_confirm",
	constraint: "user_confirm",
	habit: "user_confirm",
	other_person_note: "user_confirm",
} as const;

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function open(): TestStore {
	const store = openTestStore();
	stores.push(store);
	return store;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Message {
	id: string;
	content: string;
	role: "user" | "assistant";
	ordinal: number;
}

/** ホスト所有の会話 message を SourceState（本文つき）にする。 */
function messageState(message: Message, status = "available") {
	const digest = sha256(message.content);
	return {
		namespace: "conversation",
		kind: "message",
		id: message.id,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: ACCESS.principal,
		scopeKey: SCOPE,
		status,
		content: message.content,
	};
}

function messageSource(message: Message) {
	return {
		...messageState(message),
		ordinal: message.ordinal,
		role: message.role,
	};
}

/** Memory の Records を抽出入力にする（ホストが同 transaction で本文を読む）。 */
function recordSource(db: MemoryDb, captured: Captured, ordinal: number) {
	const read = readRecord(db, {
		contractVersion: 1,
		access: ACCESS,
		scopeKey: SCOPE,
		recordId: captured.recordId,
	});
	if (read.status !== "available") throw new Error("record not readable");
	return {
		...read.ref,
		principal: ACCESS.principal,
		scopeKey: SCOPE,
		status: "available",
		content: read.content,
		ordinal,
		role: "user",
	};
}

function recordStates(db: MemoryDb, captured: Captured): SourceState[] {
	return [
		...recordSourceStates(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			refs: [captured.ref],
		}),
	];
}

const PROFILE = {
	extractorId: "stub-rule",
	promptVersion: "stub-1",
	providerRef: "stub-provider",
};

function prepare(
	store: TestStore,
	jobId: string,
	sources: readonly object[],
	attempt = 1,
) {
	return store.write((db) =>
		prepareExtraction(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: 10 },
			run: { jobId, attempt },
			enabled: true,
			sources: sources as never,
			profile: PROFILE,
			maxInputBytes: 65536,
		}),
	);
}

function settle(
	store: TestStore,
	jobId: string,
	output: unknown,
	currentSources: readonly object[],
	policy: object = DEFAULT,
	attempt = 1,
) {
	return store.write((db) =>
		settleExtraction(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			clock: { atMs: 20 },
			run: { jobId, attempt },
			output,
			currentSources: currentSources as never,
			policy: policy as never,
		}),
	);
}

function ready(result: ReturnType<typeof prepare>): ExtractionInput {
	if (result.status !== "ready") throw new Error(JSON.stringify(result));
	return result.input;
}

function states(store: TestStore) {
	return store.read((db) =>
		listState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey: SCOPE,
			includeInactive: true,
		}),
	);
}

function pendingCandidates(store: TestStore) {
	return store.read((db) =>
		listCandidates(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
	);
}

async function execute(
	port: ExtractorPort,
	input: ExtractionInput,
): Promise<unknown> {
	return await port(input, new AbortController().signal);
}

const M1: Message = {
	id: "m1",
	content: "私はコーヒーが好きです。辛いものは好きじゃない。",
	role: "user",
	ordinal: 3,
};
const A1: Message = {
	id: "m2",
	content: "紅茶が好きなんですね。",
	role: "assistant",
	ordinal: 4,
};

describe("prepare → execute → settle with a deterministic stub port", () => {
	test("ruleExtractor over a conversation message and a Records source (auto_admit only because the policy says so)", async () => {
		const s = open();
		const captured = capture(s, {
			origin: "note-1",
			content: "🍵紅茶が好き。",
		});
		const input = ready(
			s.write((db) =>
				prepareExtraction(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 10 },
					run: { jobId: "job1", attempt: 1 },
					enabled: true,
					sources: [
						messageSource(M1),
						messageSource(A1),
						recordSource(db, captured, 5),
					] as never,
					profile: PROFILE,
					maxInputBytes: 65536,
				}),
			),
		);
		expect(input.sources.map((source) => source.ref.namespace)).toEqual([
			"conversation",
			"conversation",
			"memory",
		]);
		const output = await execute(ruleExtractor(), input);
		const currentSources = [
			messageState(M1),
			messageState(A1),
			...s.read((db) => [
				{
					...recordStates(db, captured)[0],
					content: "🍵紅茶が好き。",
				},
			]),
		];
		// 既定の方針: 候補だけ。
		const result = settle(s, "job1", output, currentSources);
		expect(result).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 3,
			rejected: 0,
		});
		const listed = pendingCandidates(s);
		if (listed.status !== "ok") throw new Error("list");
		expect(
			listed.candidates
				.map((c) => `${c.semanticKey}:${c.value.polarity}`)
				.sort(),
		).toEqual([
			"topic.コーヒー:affirmed",
			"topic.辛いもの:negated",
			"topic.🍵紅茶:affirmed",
		]);
		expect(states(s)).toEqual({ status: "ok", items: [] });
	});

	test("the same pipeline with an explicit auto_admit policy admits, and the ledger depends on run, candidate and source", async () => {
		const s = open();
		const input = ready(prepare(s, "job1", [messageSource(M1)]));
		const output = await execute(ruleExtractor(), input);
		expect(settle(s, "job1", output, [messageState(M1)], AUTO)).toEqual({
			status: "applied",
			admitted: 2,
			pendingUser: 0,
			rejected: 0,
		});
		const items = states(s);
		if (items.status !== "ok") throw new Error("list");
		expect(
			items.items
				.map((i) => `${i.semanticKey}:${i.value.polarity}:${i.origin}`)
				.sort(),
		).toEqual([
			"topic.コーヒー:affirmed:admitted_extraction",
			"topic.辛いもの:negated:admitted_extraction",
		]);
		const edges = s.writer
			.query(
				"SELECT dependent_type, dependency_type, COUNT(*) AS n FROM memory_dependency GROUP BY 1, 2 ORDER BY 1, 2",
			)
			.all();
		expect(edges).toEqual([
			{ dependent_type: "candidate", dependency_type: "extraction_run", n: 2 },
			{ dependent_type: "candidate", dependency_type: "source", n: 2 },
			{ dependent_type: "extraction_run", dependency_type: "source", n: 1 },
			{ dependent_type: "state_item", dependency_type: "candidate", n: 2 },
			{ dependent_type: "state_item", dependency_type: "source", n: 2 },
		]);
	});

	test("a source changed while the model was running makes the run stale; the retry succeeds", async () => {
		const s = open();
		let host = M1;
		const port = faultyExtractor({
			kind: "side-effect",
			run: () => {
				host = { ...M1, content: "私は紅茶が好きです。" };
			},
			continueWith: ruleExtractor(),
		});
		const input = ready(prepare(s, "job1", [messageSource(M1)]));
		const output = await execute(port, input);
		expect(settle(s, "job1", output, [messageState(host)], AUTO)).toEqual({
			status: "stale",
			reasonCode: "SOURCE_CHANGED",
		});
		expect(states(s)).toEqual({ status: "ok", items: [] });
		expect(pendingCandidates(s)).toEqual({ status: "ok", candidates: [] });
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_source_progress").get(),
		).toEqual({ n: 0 });
		// ホストの再試行（attempt 2、新しい本文）。
		const retryInput = ready(prepare(s, "job1", [messageSource(host)], 2));
		const retryOutput = await execute(ruleExtractor(), retryInput);
		expect(
			settle(s, "job1", retryOutput, [messageState(host)], AUTO, 2),
		).toMatchObject({ status: "applied", admitted: 1 });
	});

	test("canned outputs are keyed by the input digest, and outputs reach settle unchanged", async () => {
		const s = open();
		const input = ready(prepare(s, "job1", [messageSource(M1)]));
		const canned = {
			noChange: false,
			candidates: [
				{
					kind: "preference",
					subject: "self",
					semanticKey: "drink",
					value: { text: "コーヒー", polarity: "affirmed" },
					modality: "asserted",
					temporal: "current",
					evidence: [evidenceFor(input, 0, "コーヒーが好き")],
				},
			],
		};
		const output = await execute(
			cannedExtractor({ [input.inputDigest]: canned }),
			input,
		);
		expect(output).toBe(canned);
		expect(settle(s, "job1", output, [messageState(M1)], AUTO)).toMatchObject({
			status: "applied",
			admitted: 1,
		});
		await expect(execute(cannedExtractor({}), input)).rejects.toThrow(
			"no canned output",
		);
	});

	test.each([
		["schema", "rejected_output", "OUTPUT_SCHEMA"],
		["too-many", "rejected_output", "TOO_MANY_CANDIDATES"],
		["too-large", "rejected_output", "OUTPUT_TOO_LARGE"],
		["authority-field", "rejected_output", "OUTPUT_SCHEMA"],
	] as const)("faulty output %s", async (kind, status, reasonCode) => {
		const s = open();
		const input = ready(prepare(s, "job1", [messageSource(M1)]));
		const output = await execute(faultyExtractor({ kind }), input);
		expect(settle(s, "job1", output, [messageState(M1)], AUTO)).toEqual({
			status,
			reasonCode,
		});
		expect(
			s.writer.query("SELECT stage FROM memory_source_progress").get(),
		).toEqual({ stage: "failed_output" });
		expect(states(s)).toEqual({ status: "ok", items: [] });
	});

	test("an out-of-range quote rejects only that candidate", async () => {
		const s = open();
		const input = ready(prepare(s, "job1", [messageSource(M1)]));
		const output = await execute(
			faultyExtractor({ kind: "out-of-range-quote" }),
			input,
		);
		expect(settle(s, "job1", output, [messageState(M1)], AUTO)).toEqual({
			status: "applied",
			admitted: 0,
			pendingUser: 0,
			rejected: 1,
		});
		expect(
			s.writer
				.query("SELECT decision, reason_code FROM memory_candidate")
				.get(),
		).toEqual({ decision: "rejected", reason_code: "QUOTE_MISMATCH" });
	});

	test("an assistant-only source yields no auto-admitted state even with auto_admit", async () => {
		const s = open();
		const input = ready(prepare(s, "job1", [messageSource(A1)]));
		const output = await execute(
			cannedExtractor({
				[input.inputDigest]: {
					noChange: false,
					candidates: [
						{
							kind: "preference",
							subject: "self",
							semanticKey: "drink",
							value: { text: "紅茶", polarity: "affirmed" },
							modality: "asserted",
							temporal: "current",
							evidence: [evidenceFor(input, 0, "紅茶が好き")],
						},
					],
				},
			}),
			input,
		);
		expect(settle(s, "job1", output, [messageState(A1)], AUTO)).toMatchObject({
			status: "applied",
			admitted: 0,
			pendingUser: 1,
		});
	});
});

describe("FG9: a source forgotten while extraction was in flight", () => {
	test("forget during execute → stale SOURCE_TOMBSTONED, no candidate is written, even if the host passes a stale 'available' state", async () => {
		const s = open();
		const captured = capture(s, {
			origin: "note-1",
			content: "私はコーヒーが好き。",
		});
		const staleStates = s.read((db) => [
			{ ...recordStates(db, captured)[0], content: "私はコーヒーが好き。" },
		]);
		const input = ready(
			s.write((db) =>
				prepareExtraction(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 10 },
					run: { jobId: "job1", attempt: 1 },
					enabled: true,
					sources: [recordSource(db, captured, 1)] as never,
					profile: PROFILE,
					maxInputBytes: 65536,
				}),
			),
		);
		const port = faultyExtractor({
			kind: "side-effect",
			run: () => {
				forgetRecord(s, {
					type: "record",
					recordId: captured.recordId,
					scopeKey: SCOPE,
				});
			},
			continueWith: ruleExtractor(),
		});
		const output = await execute(port, input);
		expect(settle(s, "job1", output, staleStates, AUTO)).toEqual({
			status: "stale",
			reasonCode: "SOURCE_TOMBSTONED",
		});
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_candidate").get(),
		).toEqual({ n: 0 });
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_state_item").get(),
		).toEqual({ n: 0 });
		// 以後の抽出もこの出典では始められない。
		const again = s.write((db) =>
			prepareExtraction(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 11 },
				run: { jobId: "job2", attempt: 1 },
				enabled: true,
				sources: [
					{
						...staleStates[0],
						ordinal: 1,
						role: "user",
					},
				] as never,
				profile: PROFILE,
				maxInputBytes: 65536,
			}),
		);
		expect(again).toEqual({ status: "skip", reasonCode: "SOURCE_TOMBSTONED" });
	});

	/** record を capture して run を prepare する（run の入力は record 1 件）。 */
	function prepareFromRecord(
		s: TestStore,
		jobId: string,
		captured: Captured,
		ordinal: number,
	): ExtractionInput {
		return ready(
			s.write((db) =>
				prepareExtraction(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 10 },
					run: { jobId, attempt: 1 },
					enabled: true,
					sources: [recordSource(db, captured, ordinal)] as never,
					profile: PROFILE,
					maxInputBytes: 65536,
				}),
			),
		);
	}

	function currentOf(s: TestStore, captured: Captured, content: string) {
		return s.read((db) => [{ ...recordStates(db, captured)[0], content }]);
	}

	test("forget after settle: the forgotten source's run, candidates and admitted item disappear from reads; an independent run stays; a restored copy is fixed by reconcile (F03)", async () => {
		const s = open();
		const keep = capture(s, { origin: "note-keep", content: "紅茶が好き。" });
		const keepInput = prepareFromRecord(s, "job-keep", keep, 2);
		const keepOutput = await execute(ruleExtractor(), keepInput);
		expect(
			settle(
				s,
				"job-keep",
				keepOutput,
				currentOf(s, keep, "紅茶が好き。"),
				DEFAULT,
			),
		).toMatchObject({ pendingUser: 1 });

		const gone = capture(s, {
			origin: "note-gone",
			content: "私はコーヒーが好き。",
		});
		const goneInput = prepareFromRecord(s, "job-gone", gone, 1);
		const goneOutput = await execute(ruleExtractor(), goneInput);
		const goneCurrent = currentOf(s, gone, "私はコーヒーが好き。");
		expect(settle(s, "job-gone", goneOutput, goneCurrent, AUTO)).toMatchObject({
			admitted: 1,
		});
		const before = s.snapshotTo("before-forget");

		const { entry } = forgetRecord(s, {
			type: "record",
			recordId: gone.recordId,
			scopeKey: SCOPE,
		});
		expect(states(s)).toEqual({ status: "ok", items: [] });
		const remaining = pendingCandidates(s);
		if (remaining.status !== "ok") throw new Error("list");
		expect(remaining.candidates.map((c) => c.runId)).toEqual(["job-keep:1"]);
		// 忘却した出典の run の settle のやり直し（冪等再実行）は stale。
		expect(settle(s, "job-gone", goneOutput, goneCurrent, AUTO)).toEqual({
			status: "stale",
			reasonCode: "SOURCE_TOMBSTONED",
		});
		// 忘却された候補の確認操作は forgotten。
		const goneCandidate = s.writer
			.query(
				"SELECT candidate_id FROM memory_candidate WHERE run_id = 'job-gone:1'",
			)
			.get() as { candidate_id: string };
		expect(
			s.write((db) =>
				confirmCandidate(db, {
					contractVersion: 1,
					access: ACCESS,
					scopeKey: SCOPE,
					clock: { atMs: 30 },
					candidateId: goneCandidate.candidate_id,
					action: "admit",
					currentSources: goneCurrent as never,
				}),
			),
		).toEqual({ status: "forgotten" });

		// 忘却前に複製した DB を復元 → 最新ジャーナルで reconcile → 同じく見えない。
		const restored = openTestStore({ fromFile: before });
		stores.push(restored);
		expect(states(restored)).toMatchObject({ items: [{ status: "active" }] });
		reconcile(restored, [entry]);
		expect(states(restored)).toEqual({ status: "ok", items: [] });
		const restoredCandidates = pendingCandidates(restored);
		if (restoredCandidates.status !== "ok") throw new Error("list");
		expect(restoredCandidates.candidates.map((c) => c.runId)).toEqual([
			"job-keep:1",
		]);
	});

	test("a run that was shown a state item derived from a forgotten source is forgotten with it (the model saw that item)", async () => {
		const s = open();
		const gone = capture(s, {
			origin: "note-gone",
			content: "私はコーヒーが好き。",
		});
		const first = prepareFromRecord(s, "job-first", gone, 1);
		const firstOutput = await execute(ruleExtractor(), first);
		settle(
			s,
			"job-first",
			firstOutput,
			currentOf(s, gone, "私はコーヒーが好き。"),
			AUTO,
		);
		// 2 つ目の run には、採用済みの item が shownState として見える。
		const other = capture(s, { origin: "note-other", content: "紅茶が好き。" });
		const second = prepareFromRecord(s, "job-second", other, 2);
		expect(second.shownState.map((item) => item.semanticKey)).toEqual([
			"topic.コーヒー",
		]);
		const secondOutput = await execute(ruleExtractor(), second);
		// 見せた item は変わっていない（revision 同じ）ので、settle は成功する。
		expect(
			settle(
				s,
				"job-second",
				secondOutput,
				currentOf(s, other, "紅茶が好き。"),
				DEFAULT,
			),
		).toMatchObject({ pendingUser: 1 });
		forgetRecord(s, {
			type: "record",
			recordId: gone.recordId,
			scopeKey: SCOPE,
		});
		expect(pendingCandidates(s)).toEqual({ status: "ok", candidates: [] });
	});
});
