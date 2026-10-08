/**
 * F02 の bench（記録のみ。verify 対象外）: scope 限定検索の LIKE / FTS の応答時間。
 *   bun bench/bench-scope.ts            # 全部（数分）
 *   bun bench/bench-scope.ts --quick    # 1k / 10k だけ
 * 使い捨ての `:memory:` DB に `captureRecord` で実際に投入し、`searchRecordsWithStrategy` を戦略指定で計測する。
 * 結果は標準出力に markdown で出す（`spec/bench-scope-results.md` に貼る）。時刻は performance.now（src ではないので可）。
 */
import { captureRecord } from "../src/store/records.ts";
import {
	buildSearchQuery,
	searchRecordsWithStrategy,
} from "../src/store/recall.ts";
import { parseQueryTerms } from "../src/recall/query.ts";
import { openTestStore } from "../test/support/store.ts";
import type { TestStore } from "../test/support/store.ts";
import type { RecallStrategy } from "../src/contracts/recall.ts";

const quick = process.argv.includes("--quick");
const ITERATIONS = 30;
const PRINCIPAL = "local:owner";

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS: string[] = [];
{
	const random = mulberry32(7);
	const syllables = [
		"ka",
		"to",
		"mi",
		"re",
		"so",
		"lu",
		"ne",
		"pa",
		"xo",
		"vi",
	];
	for (let index = 0; index < 3000; index += 1) {
		let word = "";
		for (let part = 0; part < 3; part += 1) {
			word += syllables[Math.floor(random() * syllables.length)];
		}
		WORDS.push(`${word}${index}`);
	}
}

/** 1 record の本文: 語 24 個。`rare`（約 1%）と `common`（約 20%）の目印を混ぜる。 */
function body(random: () => number): string {
	const parts: string[] = [];
	for (let index = 0; index < 24; index += 1) {
		parts.push(WORDS[Math.floor(random() * WORDS.length)] as string);
	}
	if (random() < 0.01) parts.splice(Math.floor(random() * 24), 0, "rarezzq");
	if (random() < 0.2) parts.splice(Math.floor(random() * 24), 0, "commonwq");
	return parts.join(" ");
}

function fill(store: TestStore, scopeSizes: ReadonlyMap<string, number>): void {
	const random = mulberry32(42);
	store.write((db) => {
		for (const [scopeKey, size] of scopeSizes) {
			const access = {
				principal: PRINCIPAL,
				scopeKeys: [scopeKey],
				purpose: "bench",
				policyRevision: "1",
			};
			for (let index = 0; index < size; index += 1) {
				const result = captureRecord(db, {
					contractVersion: 1,
					access,
					scopeKey,
					clock: { atMs: 1 },
					origin: { namespace: "bench", kind: "row", id: String(index) },
					mediaType: "text/plain",
					content: body(random),
					captureState: "complete",
				});
				if (result.status !== "captured") throw new Error("blocked");
			}
		}
	});
}

function percentile(sorted: number[], p: number): number {
	return sorted[
		Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
	] as number;
}

interface Measure {
	readonly p50: number;
	readonly p95: number;
	readonly hits: number;
}

function measure(
	store: TestStore,
	scopeKey: string,
	query: string,
	strategy: RecallStrategy,
): Measure {
	const access = {
		principal: PRINCIPAL,
		scopeKeys: [scopeKey],
		purpose: "bench",
		policyRevision: "1",
	};
	const input = {
		contractVersion: 1,
		access,
		scopeKeys: [scopeKey],
		query,
		limit: 20,
	} as const;
	let hits = 0;
	// ウォームアップ
	for (let index = 0; index < 3; index += 1) {
		searchRecordsWithStrategy(store.writer, input, strategy);
	}
	const times: number[] = [];
	for (let index = 0; index < ITERATIONS; index += 1) {
		const start = performance.now();
		const result = searchRecordsWithStrategy(store.writer, input, strategy);
		times.push(performance.now() - start);
		if (result.status === "ok") hits = result.hits.length;
	}
	times.sort((a, b) => a - b);
	return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), hits };
}

function planOf(
	store: TestStore,
	scopeKey: string,
	query: string,
	strategy: RecallStrategy,
): string[] {
	const parsed = parseQueryTerms(query);
	if (parsed.status !== "ok") throw new Error("query");
	const { sql, params } = buildSearchQuery({
		principal: PRINCIPAL,
		scopeKeys: [scopeKey],
		query: parsed.query,
		strategy,
		after: null,
		fetch: 21,
	});
	return (
		store.writer.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
			detail: string;
		}[]
	).map((row) => row.detail);
}

function globalMatches(store: TestStore, term: string): number {
	const row = store.writer
		.query(
			"SELECT COUNT(*) AS n FROM memory_record_fts WHERE memory_record_fts MATCH ?",
		)
		.get(`"${term}"`) as { n: number };
	return row.n;
}

const QUERIES = [
	{ label: "rare(~1%)", query: "rarezzq" },
	{ label: "common(~20%)", query: "commonwq" },
	{ label: "two-terms", query: "commonwq rarezzq" },
] as const;

function fmt(n: number): string {
	return n < 10 ? n.toFixed(3) : n.toFixed(1);
}

const out = (line = "") => {
	console.log(line);
};

out("## Matrix: even distribution, target = scope:0 (total rows x scopes)");
out();
out(
	"| total rows | scopes | target rows | query | like p50 / p95 (ms) | fts p50 / p95 (ms) | hits | fts global matches |",
);
out("|---|---|---|---|---|---|---|---|");
const totals = quick ? [1000, 10000] : [1000, 10000, 100000];
for (const total of totals) {
	for (const scopes of [10, 100]) {
		const store = openTestStore({ inMemory: true });
		try {
			const sizes = new Map<string, number>();
			for (let index = 0; index < scopes; index += 1)
				sizes.set(`scope:${index}`, Math.floor(total / scopes));
			fill(store, sizes);
			for (const { label, query } of QUERIES) {
				const like = measure(store, "scope:0", query, "like");
				const fts = measure(store, "scope:0", query, "fts");
				const term = query.split(" ")[0] as string;
				out(
					`| ${total} | ${scopes} | ${Math.floor(total / scopes)} | ${label} | ${fmt(like.p50)} / ${fmt(like.p95)} | ${fmt(fts.p50)} / ${fmt(fts.p95)} | ${like.hits}/${fts.hits} | ${globalMatches(store, term)} |`,
				);
			}
		} finally {
			store.close();
		}
	}
}

if (!quick) {
	out();
	out(
		"## Sweep: total ~100k rows, target scope size K (the rest in other scopes)",
	);
	out();
	out(
		"| K (target rows) | query | like p50 / p95 (ms) | fts p50 / p95 (ms) | fts/like p50 |",
	);
	out("|---|---|---|---|---|");
	const store = openTestStore({ inMemory: true });
	try {
		const sizes = new Map<string, number>();
		const targets = [500, 1000, 2000, 5000, 10000, 20000, 50000];
		for (const size of targets) sizes.set(`k:${size}`, size);
		for (let index = 0; index < 5; index += 1)
			sizes.set(`filler:${index}`, 2300);
		fill(store, sizes);
		for (const size of targets) {
			for (const { label, query } of QUERIES.slice(0, 2)) {
				const like = measure(store, `k:${size}`, query, "like");
				const fts = measure(store, `k:${size}`, query, "fts");
				out(
					`| ${size} | ${label} | ${fmt(like.p50)} / ${fmt(like.p95)} | ${fmt(fts.p50)} / ${fmt(fts.p95)} | ${(fts.p50 / like.p50).toFixed(2)} |`,
				);
			}
		}
		out();
		out("### EXPLAIN QUERY PLAN (scope k:5000, query rarezzq)");
		for (const strategy of ["like", "fts"] as const) {
			out();
			out(`${strategy}:`);
			for (const detail of planOf(store, "k:5000", "rarezzq", strategy))
				out(`    ${detail}`);
		}
	} finally {
		store.close();
	}
}
