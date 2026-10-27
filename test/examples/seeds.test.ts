import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseSeedData,
	seedSummary,
	type MemorySeed,
} from "../../examples/seeds/data.ts";
import { importSeedData } from "../../examples/seeds/import.ts";
import { seedCommand } from "../../examples/seeds/main.ts";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import { recallMemory } from "../../examples/standalone/retrieval.ts";

// Synthetic input only: personal history is example data, never a regression oracle.
function seed(id: string, overrides: Partial<MemorySeed> = {}): MemorySeed {
	const quote = "夕食のときには黒豆茶が好きです。";
	return {
		schema_version: 1,
		id,
		status: "candidate",
		category: "synthetic",
		subject: "self",
		semantic_key: `drink.${id}`,
		memory: "黒豆茶が好き",
		scope: "activity:dinner",
		evidence_basis: "explicit",
		confidence: "high",
		proposed_target: "state",
		proposed_state_kind: "preference",
		proposed_state_origin: "agent_inferred",
		use_when: "夕食の飲み物を選ぶとき",
		limitations: "朝食や外出先まで一般化しない。",
		review: { after_days: 90, on: "本人が訂正したとき" },
		evidence: [
			{
				evidence_id: `e-${id}`,
				thread_id: "synthetic-thread",
				message_id: `synthetic-${id}`,
				timestamp: "2026-01-01T00:00:00.000Z",
				speaker: "user",
				source_path: "synthetic:unavailable",
				source_line: 1,
				source_text_sha256: createHash("sha256").update(quote).digest("hex"),
				range_utf8: { start: 0, end: Buffer.byteLength(quote) },
				quote,
			},
		],
		...overrides,
	};
}
const encode = (seeds: readonly MemorySeed[]) =>
	seeds.map((s) => JSON.stringify(s)).join("\n") + "\n";

test("seed reader preserves all routes and provenance, rejects invalid/duplicate contracts", () => {
	const values = [
		seed("a"),
		seed("b", {
			proposed_target: "host_procedure",
			proposed_state_kind: null,
			proposed_state_origin: null,
		}),
		seed("c", {
			proposed_target: "continuity",
			proposed_state_kind: null,
			proposed_state_origin: null,
		}),
	];
	expect(parseSeedData(encode(values))).toEqual(values);
	expect(seedSummary(values)).toEqual({
		total: 3,
		state: 1,
		host_procedure: 1,
		continuity: 1,
	});
	expect(() => parseSeedData(encode([values[0]!, values[0]!]))).toThrow(
		"Duplicate",
	);
	expect(() =>
		parseSeedData(
			encode([
				seed("z", { semantic_key: values[0]!.semantic_key }),
				values[0]!,
			]),
		),
	).toThrow("Duplicate");
	for (const patch of [
		{ schema_version: 2 },
		{ status: "confirmed" },
		{ proposed_state_origin: "user_confirmed" },
		{ proposed_target: "host_procedure" },
		{ evidence: [] },
		{ limitations: "" },
	])
		expect(() =>
			parseSeedData(JSON.stringify({ ...seed("x"), ...patch })),
		).toThrow();
	const badRange = seed("range");
	badRange.evidence[0]!.range_utf8.end--;
	expect(() => parseSeedData(encode([badRange]))).toThrow("evidence");
});

test("CLI seeds SQLite from an external file, retaining scope and candidate status in recall", async () => {
	const directory = mkdtempSync(join(tmpdir(), "memory-seed-"));
	const input = join(directory, "seed.jsonl");
	const storage = join(directory, "host");
	const values = [
		seed("a"),
		seed("b", {
			proposed_target: "host_procedure",
			proposed_state_kind: null,
			proposed_state_origin: null,
		}),
		seed("c", {
			proposed_target: "continuity",
			proposed_state_kind: null,
			proposed_state_origin: null,
		}),
	];
	try {
		writeFileSync(input, encode(values));
		expect(seedCommand(["inspect", input])).toEqual({
			summary: seedSummary(values),
			seeds: values,
		});
		expect(seedCommand(["load", storage, input])).toMatchObject({
			status: "completed",
			imported: 1,
			deferred: [
				{ id: "b", target: "host_procedure" },
				{ id: "c", target: "continuity" },
			],
		});
		const host = new StandaloneHost(storage);
		try {
			const [item] = host.list();
			expect(host.list()).toHaveLength(1);
			expect(item!.origin).toBe("agent_inferred");
			expect(host.evidenceQuotes(item!.itemId)).toEqual([values[0]!.memory]);
			const sources = readFileSync(join(storage, "sources.jsonl"), "utf8");
			expect(JSON.parse(sources).namespace).toBe("example-seed");
			expect(JSON.parse(sources).content).toContain("synthetic:unavailable");
			const result = await recallMemory(
				host,
				"夕食の飲み物の好みは？",
				async (input, _schema, task) => {
					expect(task).toBe("recall");
					const payload = JSON.parse(input);
					expect(payload.items).toHaveLength(1);
					const text = payload.items[0].value.text;
					expect(text).toContain(values[0]!.scope);
					expect(text).toContain(values[0]!.limitations);
					expect(text).toContain("本人未確認");
					return {
						raw: JSON.stringify({
							parts: [
								{
									request: "夕食の好み",
									status: "supported",
									evidenceIds: [item!.itemId],
								},
							],
						}),
						usage: null,
						threadId: null,
					};
				},
			);
			expect(result.coverage).toEqual({ complete: true, itemCount: 1 });
			expect(importSeedData(host, values)).toMatchObject({
				status: "unchanged",
				imported: 0,
			});
			expect(readFileSync(join(storage, "sources.jsonl"), "utf8")).toBe(
				sources,
			);
		} finally {
			host.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("reloading a seed does not undo corrections or resurrect forgotten facts after restart", () => {
	const directory = mkdtempSync(join(tmpdir(), "memory-seed-repeat-"));
	const values = [seed("a"), seed("b", { memory: "夕食はほうじ茶が好き" })];
	let host = new StandaloneHost(directory);
	try {
		importSeedData(host, values);
		const items = host.list();
		const a = items.find(
			(item) => item.semanticKey === values[0]!.semantic_key,
		)!;
		const b = items.find(
			(item) => item.semanticKey === values[1]!.semantic_key,
		)!;
		host.remember(
			{
				type: "remember",
				subject: "self",
				kind: "preference",
				semanticKey: a.semanticKey,
				value: { text: "麦茶が好き", polarity: "affirmed" },
				quote: "麦茶が好き",
				replacesItemId: a.itemId,
			},
			"麦茶が好き",
		);
		host.forgetFact(b.itemId);
		const before = host.list(true);
		const archive = readFileSync(join(directory, "sources.jsonl"), "utf8");
		host.close();
		host = new StandaloneHost(directory);
		expect(importSeedData(host, values)).toMatchObject({
			status: "unchanged",
			imported: 0,
		});
		expect(host.list(true)).toEqual(before);
		expect(host.list()).toHaveLength(1);
		expect(host.list()[0]!.value.text).toBe("麦茶が好き");
		expect(readFileSync(join(directory, "sources.jsonl"), "utf8")).toBe(
			archive,
		);
		expect(() => importSeedData(host, [seed("different")])).toThrow(
			"Different seed",
		);
		expect(host.list(true)).toEqual(before);
	} finally {
		host.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("initialization is atomic and refuses an existing host without a seed receipt", () => {
	const directory = mkdtempSync(join(tmpdir(), "memory-seed-atomic-"));
	const host = new StandaloneHost(directory);
	try {
		expect(() =>
			importSeedData(host, [
				seed("valid"),
				seed("oversize", { memory: "長".repeat(2000) }),
			]),
		).toThrow();
		expect(host.list(true)).toEqual([]);
		expect(existsSync(join(directory, "sources.jsonl"))).toBe(false);
		expect(importSeedData(host, [seed("valid")])).toMatchObject({
			status: "completed",
			imported: 1,
		});
	} finally {
		host.close();
		rmSync(directory, { recursive: true, force: true });
	}
	const existing = mkdtempSync(join(tmpdir(), "memory-seed-existing-"));
	const other = new StandaloneHost(existing);
	try {
		other.remember(
			{
				type: "remember",
				subject: "self",
				kind: "preference",
				semanticKey: "existing",
				value: { text: "水が好き", polarity: "affirmed" },
				quote: "水が好き",
				replacesItemId: null,
			},
			"水が好き",
		);
		const before = other.list(true);
		expect(() => importSeedData(other, [seed("new")])).toThrow("empty");
		expect(other.list(true)).toEqual(before);
	} finally {
		other.close();
		rmSync(existing, { recursive: true, force: true });
	}
});
