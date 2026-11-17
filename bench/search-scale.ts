#!/usr/bin/env bun
/**
 * State の全文検索の規模の測定（設計 `spec/state-search-design.md` §6.3、S8）。verify の対象外で、記録だけを取る。
 * 本物の `assertUserState` で合成の item を入れ、核の `searchState`、書き込み、忘却（`scrubStateItem`）、
 * 初回の索引の構築（migration 0009 の再適用）、DB と WAL と索引の大きさ、`EXPLAIN QUERY PLAN` を測る。
 *
 * 使い方: bun bench/search-scale.ts [--sizes 1000,10000,100000] [--host-mmap] [--dir /tmp/x] [--json out.json]
 * 合成のデータだけを使い、実行の後に一時ファイルを消す。
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertUserState,
	migrations,
	searchState,
	verifyStateSearchIndex,
	type MemoryDb,
	type SearchStateInput,
} from "../src/sqlite.ts";
import { scrubStateItem } from "../src/domains/state/repository/index.ts";
import { syncStateSearch } from "../src/domains/state/repository/search-index.ts";
import { ROLLBACK_0009_SQL } from "../packages/host/scripts/rollback-0009.ts";
import { SQLITE_MMAP_BYTES } from "../packages/host/src/storage.ts";
import {
	makeSource,
	makeSpan,
	value,
} from "../src/domains/state/test/state-support.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const SIZES = (arg("--sizes") ?? "1000,10000,100000").split(",").map(Number);
const mmapBytes = args.includes("--host-mmap") ? SQLITE_MMAP_BYTES : 0;
const ROOT = arg("--dir") ?? mkdtempSync(join(tmpdir(), "search-bench-"));
mkdirSync(ROOT, { recursive: true });

const PRINCIPAL = "local:owner";
const SCOPES = Array.from({ length: 10 }, (_, i) => `scope-${i}`);
const ALLOWED = SCOPES.slice(0, 3);
const ACCESS = {
	principal: PRINCIPAL,
	scopeKeys: SCOPES,
	purpose: "bench",
	policyRevision: "1",
};

let seed = 20261116;
function random(n: number): number {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return (seed >>> 8) % n;
}
const FILLER = [
	"今日は天気が良いので散歩に出かけた",
	"the quick brown fox jumps over the lazy dog",
	"週末は家族と過ごすことが多い",
	"I usually read technical books before sleeping",
	"駅前の喫茶店で本を読むのが好きだ",
	"meeting notes and project planning for next quarter",
	"新しいプログラミング言語を学んでいる",
];
/** 文書の長さ（短い 50 B、中くらい 500 B、最大 4 KiB ＋属性 16 個）。 */
type Shape = "short" | "medium" | "max";
function makeText(bytes: number, i: number): string {
	const parts: string[] = [];
	// よく出る語（約 4 割）、珍しい語（1%）、2 語目（2 割）、2 文字の語（3 割）。
	if (i % 100 === 7) parts.push("珍味トリュフ");
	if (i % 10 < 3) parts.push("会議");
	if (i % 5 < 2) parts.push("コーヒー");
	if (i % 5 === 3) parts.push("ミルクティー");
	parts.push(`記録${i}`);
	while (Buffer.byteLength(parts.join(" ")) < bytes)
		parts.push(FILLER[random(FILLER.length)]!);
	let text = parts.join(" ");
	while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1);
	return text;
}
function shapeOf(i: number, mix: "mixed" | Shape): Shape {
	if (mix !== "mixed") return mix;
	const r = i % 20;
	return r === 0 ? "max" : r < 6 ? "medium" : "short";
}
function insertItem(
	db: MemoryDb,
	i: number,
	scopeKey: string,
	shape: Shape,
	atMs: number,
) {
	const bytes = shape === "short" ? 50 : shape === "medium" ? 500 : 4000;
	const text = makeText(bytes, i);
	const source = makeSource(
		`m${i}`,
		text,
		i,
		{ principal: PRINCIPAL },
		scopeKey,
	);
	const attributes =
		shape === "max"
			? Object.fromEntries(
					Array.from({ length: 16 }, (_, k) => [
						`attr${k}`,
						makeText(200, i * 16 + k),
					]),
				)
			: undefined;
	const result = assertUserState(db, {
		contractVersion: 1,
		access: ACCESS,
		scopeKey,
		clock: { atMs },
		subject: "self",
		kind: "preference",
		semanticKey: `key-${i}`,
		value: value(text, "affirmed", attributes),
		origin: "user_confirmed",
		evidence: [makeSpan(source, `記録${i}`)],
		sources: [source],
	});
	if (result.status !== "applied") throw new Error(JSON.stringify(result));
	return result.item;
}
function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
	]!;
}
function time<T>(fn: () => T): [T, number] {
	const start = performance.now();
	const value = fn();
	return [value, performance.now() - start];
}
function measure(fn: () => unknown, runs = 30, warmup = 3) {
	for (let i = 0; i < warmup; i++) fn();
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) samples.push(time(fn)[1]);
	return {
		p50: Number(percentile(samples, 50).toFixed(3)),
		p95: Number(percentile(samples, 95).toFixed(3)),
	};
}
function open(path: string): Database & MemoryDb {
	const db = new Database(path, { create: true }) as Database & MemoryDb;
	if (path !== ":memory:")
		db.exec(`PRAGMA journal_mode=WAL; PRAGMA mmap_size=${mmapBytes}`);
	db.exec("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON");
	for (const m of migrations) db.exec(m);
	return db;
}
function reopen(db: Database & MemoryDb, path: string): Database & MemoryDb {
	if (path !== ":memory:") {
		db.close();
		const next = new Database(path) as Database & MemoryDb;
		next.exec(`PRAGMA mmap_size=${mmapBytes}`);
		next.exec("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON");
		return next;
	}
	const bytes = db.serialize();
	db.close();
	const next = Database.deserialize(bytes) as Database & MemoryDb;
	next.exec("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON");
	return next;
}
function sizes(db: Database, path: string) {
	const rows = db
		.query(
			"SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC",
		)
		.all() as { name: string; bytes: number }[];
	const sum = (re: RegExp) =>
		rows.filter((r) => re.test(r.name)).reduce((a, r) => a + r.bytes, 0);
	const fileSize = (p: string) => {
		try {
			return statSync(p).size;
		} catch {
			return 0;
		}
	};
	return {
		itemTablesBytes: sum(/^memory_state_(item|attribute|evidence|event)/),
		ftsBytes: sum(/^memory_state_fts/),
		searchRowBytes: sum(
			/^memory_state_search_row|sqlite_autoindex_memory_state_search_row/,
		),
		totalPagesBytes: rows.reduce((a, r) => a + r.bytes, 0),
		dbFileBytes: path === ":memory:" ? null : fileSize(path),
		walFileBytes: path === ":memory:" ? null : fileSize(`${path}-wal`),
	};
}
/** searchState が発行する最後の SELECT を記録し、EXPLAIN QUERY PLAN を取る。 */
function explain(db: Database & MemoryDb, input: SearchStateInput): string[] {
	let captured: { sql: string; params: unknown[] } | undefined;
	const proxy = new Proxy(db, {
		get(target, key) {
			if (key === "query")
				return (sql: string) => {
					const statement = target.query(sql);
					return new Proxy(statement, {
						get(st, k) {
							if (k === "all")
								return (...params: unknown[]) => {
									if (
										/^\s*SELECT .*FROM memory_state_(fts|item) [fi]\b/s.test(
											sql,
										)
									)
										captured = { sql, params };
									return (st.all as (...p: unknown[]) => unknown)(...params);
								};
							const v = Reflect.get(st, k);
							return typeof v === "function" ? v.bind(st) : v;
						},
					});
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Database & MemoryDb;
	db.transaction(() => searchState(proxy, input))();
	if (!captured) return [];
	return (
		db
			.query(`EXPLAIN QUERY PLAN ${captured.sql}`)
			.all(...(captured.params as never[])) as { detail: string }[]
	).map((r) => r.detail);
}

interface CaseResult {
	label: string;
	items: number;
	storage: "file" | "memory";
	shape: string;
	skew: "uniform" | "concentrated" | "allowedOnly";
	populateSeconds: number;
	initialBuildMs: number;
	sizes: ReturnType<typeof sizes>;
	search: Record<
		string,
		| {
				p50: number;
				p95: number;
				returned: number;
				more: boolean;
				mode: string;
		  }
		| { blocked: string }
	>;
	write: { p50: number; p95: number };
	syncOnly: { p50: number; p95: number };
	edit: { p50: number; p95: number };
	forget: { p50: number; p95: number };
	checkpointMs: number | null;
	explain: Record<string, string[]>;
	verifyMs: number;
}

const QUERIES: Record<string, { indexed: string[]; scanned: string[] }> = {
	frequent: { indexed: ["コーヒー"], scanned: [] },
	rare: { indexed: ["珍味トリュフ"], scanned: [] },
	twoTerms: { indexed: ["コーヒー", "ミルクティー"], scanned: [] },
	shortOnly: { indexed: [], scanned: ["会議"] },
	mixed: { indexed: ["コーヒー"], scanned: ["会議"] },
	shortRare: { indexed: [], scanned: ["珍味"] },
};

function runCase(
	n: number,
	storage: "file" | "memory",
	shape: "mixed" | Shape,
	skew: "uniform" | "concentrated" | "allowedOnly",
): CaseResult {
	const label = `${n}-${storage}-${shape}-${skew}`;
	const path = storage === "memory" ? ":memory:" : join(ROOT, `${label}.db`);
	let db = open(path);
	const scopeOf = (i: number) =>
		skew === "allowedOnly"
			? ALLOWED[i % ALLOWED.length]!
			: skew === "uniform"
				? SCOPES[i % 10]!
				: i % 10 === 0
					? SCOPES[1 + random(9)]!
					: SCOPES[0]!;
	const [, populateMs] = time(() => {
		for (let start = 0; start < n; start += 1000)
			db.transaction(() => {
				for (let i = start; i < Math.min(n, start + 1000); i++)
					insertItem(db, i, scopeOf(i), shapeOf(i, shape), 1000 + i);
			})();
	});
	if (storage === "file") db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
	// 核の文はキャッシュされて表を掴むので、接続を開き直してから索引を消す。
	db = reopen(db, path);
	// 初回の構築: 索引を消して版 8 に戻し、0009 を再適用する（既存の DB への migration と同じ）。
	db.transaction(() => db.exec(ROLLBACK_0009_SQL))();
	const [, initialBuildMs] = time(() =>
		db.transaction(() => db.exec(migrations[8]!))(),
	);
	if (storage === "file") db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
	const [report, verifyMs] = time(() =>
		db.transaction(() => verifyStateSearchIndex(db))(),
	);
	if (!report.consistent)
		throw new Error(`index inconsistent ${JSON.stringify(report)}`);
	const storageSizes = sizes(db, path);
	const search: CaseResult["search"] = {};
	const plans: Record<string, string[]> = {};
	for (const [name, terms] of Object.entries(QUERIES)) {
		const input: SearchStateInput = {
			contractVersion: 1,
			access: ACCESS,
			scopeKeys: ALLOWED,
			terms,
			limit: 20,
			scanMax: 1000000,
		};
		const first = db.transaction(() => searchState(db, input))();
		if (first.status !== "ok") {
			search[name] = { blocked: first.reasonCode };
			continue;
		}
		const stats = measure(() => db.transaction(() => searchState(db, input))());
		search[name] = {
			...stats,
			returned: first.items.length,
			more: first.more,
			mode: first.mode,
		};
		plans[name] = explain(db, input);
	}
	let next = n;
	const write = measure(() => {
		db.transaction(() =>
			insertItem(db, next, SCOPES[0]!, "short", 10_000_000 + next),
		)();
		next++;
	});
	const recent = db
		.query(
			"SELECT item_id FROM memory_state_item WHERE status='active' ORDER BY updated_seq DESC LIMIT 40",
		)
		.all() as { item_id: string }[];
	let k = 0;
	const syncOnly = measure(() => {
		db.transaction(() =>
			syncStateSearch(db, [recent[k++ % recent.length]!.item_id]),
		)();
	});
	// 編集の索引の部分: 本文を変える（trigger が古い行を消す）→ 再登録。核の書き込みの残り（event など）は含まない。
	const edit = measure(() => {
		const id = recent[k++ % recent.length]!.item_id;
		db.transaction(() => {
			db.query(
				"UPDATE memory_state_item SET value_text = value_text || '改' WHERE item_id = ?",
			).run(id);
			syncStateSearch(db, [id]);
		})();
	});
	const victims = db
		.query(
			"SELECT item_id FROM memory_state_item WHERE status='active' ORDER BY item_id LIMIT 40",
		)
		.all() as { item_id: string }[];
	let v = 0;
	const forget = measure(
		() => {
			const id = victims[v++]!.item_id;
			db.transaction(() => scrubStateItem(db, PRINCIPAL, id, 50_000_000 + v))();
		},
		30,
		3,
	);
	let checkpointMs: number | null = null;
	db = reopen(db, path);
	if (storage === "file")
		checkpointMs = Number(
			time(() => db.query("PRAGMA wal_checkpoint(TRUNCATE)").get())[1].toFixed(
				3,
			),
		);
	db.close();
	if (storage === "file")
		for (const suffix of ["", "-wal", "-shm"])
			rmSync(`${path}${suffix}`, { force: true });
	return {
		label,
		items: n,
		storage,
		shape,
		skew,
		populateSeconds: Number((populateMs / 1000).toFixed(1)),
		initialBuildMs: Number(initialBuildMs.toFixed(1)),
		sizes: storageSizes,
		search,
		write,
		syncOnly,
		edit,
		forget,
		checkpointMs,
		explain: plans,
		verifyMs: Number(verifyMs.toFixed(1)),
	};
}

const results: CaseResult[] = [];
// 走査の上限の確認: 許可した scope だけに n 件を置き、走査の対象をちょうど n 件にする（--scan-max-case n）。
const scanCase = arg("--scan-max-case");
const sqliteVersion = (
	new Database(":memory:").query("SELECT sqlite_version() AS v").get() as {
		v: string;
	}
).v;
if (scanCase)
	results.push(runCase(Number(scanCase), "file", "mixed", "allowedOnly"));
else
	for (const n of SIZES) {
		results.push(runCase(n, "file", "mixed", "uniform"));
		console.error(`done ${n} file mixed uniform`);
		if (n <= 10000) {
			results.push(runCase(n, "memory", "mixed", "uniform"));
			results.push(runCase(n, "file", "mixed", "concentrated"));
			for (const shape of ["short", "medium", "max"] as const)
				results.push(runCase(n, "file", shape, "uniform"));
			console.error(`done ${n} variants`);
		}
	}
const output = {
	sqliteVersion,
	bun: Bun.version,
	mmapBytes,
	scopes: SCOPES.length,
	allowed: ALLOWED.length,
	results,
};
const json = arg("--json");
if (json) await Bun.write(json, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
if (!arg("--dir")) rmSync(ROOT, { recursive: true, force: true });
