import { afterEach, describe, expect, test } from "bun:test";
import { isMemoryContractError } from "../../../contracts/errors.ts";
import type { AccessContext } from "../../../contracts/types.ts";
import { foldAscii } from "../service/query.ts";
import { LIKE_SCAN_MAX } from "../service/strategy.ts";
import { captureRecord, deactivateRecord } from "../../records/sqlite.ts";
import {
	buildSearchQuery,
	searchRecords,
	searchRecordsWithStrategy,
} from "../repository/index.ts";
import { parseQueryTerms } from "../service/query.ts";
import { isMemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(): TestStore {
	store = openTestStore();
	return store;
}

const ACCESS: AccessContext = {
	principal: "local:owner",
	scopeKeys: ["scope:a", "scope:b", "scope:c"],
	purpose: "test",
	policyRevision: "1",
};

function put(
	s: TestStore,
	scopeKey: string,
	origin: string,
	content: string,
	atMs = 1,
): string {
	const result = s.write((db) =>
		captureRecord(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKey,
			clock: { atMs },
			origin: { namespace: "web", kind: "page", id: origin },
			mediaType: "text/plain",
			content,
			captureState: "complete",
		}),
	);
	if (result.status !== "captured") throw new Error("capture failed");
	return result.recordId;
}

function search(
	s: TestStore,
	query: string,
	options: {
		scopeKeys?: string[];
		limit?: number;
		cursor?: string;
		strategy?: "like" | "fts";
	} = {},
) {
	return s.read((db) =>
		searchRecordsWithStrategy(
			db,
			{
				contractVersion: 1,
				access: ACCESS,
				scopeKeys: options.scopeKeys ?? ["scope:a"],
				query,
				limit: options.limit ?? 50,
				...(options.cursor === undefined ? {} : { cursor: options.cursor }),
			},
			options.strategy,
		),
	);
}

describe("searchRecords", () => {
	test("2-char Japanese query uses LIKE; hit carries range, snippet and authority", () => {
		const s = open();
		const id = put(s, "scope:a", "o1", "私は辛いものが好きで、食べ歩きもする");
		const result = search(s, "食べ");
		if (result.status !== "ok") throw new Error("unreachable");
		expect(result.strategy).toBe("like");
		expect(result.hits).toHaveLength(1);
		const hit = result.hits[0];
		expect(hit?.authority).toBe("evidence_candidate");
		expect(hit?.scopeKey).toBe("scope:a");
		expect(hit?.ref).toMatchObject({
			namespace: "memory",
			kind: "record",
			id,
			representation: "text",
		});
		// 私(3)は(3)辛(3)い(3)も(3)の(3)が(3)好(3)き(3)で(3)、(3) = 33 bytes 前に、食べ = 6 bytes
		expect(hit?.ref.range).toEqual({ startByte: 33, endByte: 39 });
		expect(hit?.snippet).toContain("食べ");
	});

	test("emoji and ASCII case-insensitivity", () => {
		const s = open();
		put(s, "scope:a", "o1", "Release 😀😀😀 notes");
		for (const strategy of ["like", "fts"] as const) {
			expect(search(s, "RELEASE", { strategy })).toMatchObject({
				status: "ok",
				hits: [{}],
			});
			expect(search(s, "😀😀😀", { strategy })).toMatchObject({ hits: [{}] });
			expect(search(s, "notes release", { strategy })).toMatchObject({
				hits: [{}],
			});
			expect(search(s, "notes missing", { strategy })).toMatchObject({
				hits: [],
			});
		}
		// ASCII 以外は畳まない
		put(s, "scope:a", "o2", "ÉCOLE ABC");
		expect(
			(search(s, "école").status === "ok" ? search(s, "école") : null)
				?.status === "ok",
		).toBe(true);
		const e = search(s, "école", { strategy: "like" });
		if (e.status !== "ok") throw new Error("unreachable");
		expect(e.hits).toHaveLength(0);
		const f = search(s, "école", { strategy: "fts" });
		if (f.status !== "ok") throw new Error("unreachable");
		expect(f.hits).toHaveLength(0);
	});

	test("LIKE metacharacters are literals", () => {
		const s = open();
		put(s, "scope:a", "o1", "100% sure_thing");
		put(s, "scope:a", "o2", "100x surexthing");
		const result = search(s, "100% sure_thing");
		if (result.status !== "ok") throw new Error("unreachable");
		expect(result.hits).toHaveLength(1);
		expect(search(s, "\\")).toMatchObject({ status: "ok", hits: [] });
		expect(search(s, '"quoted" -x', { strategy: "fts" })).toMatchObject({
			status: "ok",
			hits: [],
		});
	});

	test("scope isolation: other scopes never appear; non-permitted scopes are blocked", () => {
		const s = open();
		put(s, "scope:a", "o1", "alpha secret");
		put(s, "scope:b", "o1", "alpha secret");
		const only = search(s, "secret", { scopeKeys: ["scope:a"] });
		if (only.status !== "ok") throw new Error("unreachable");
		expect(only.hits.map((hit) => hit.scopeKey)).toEqual(["scope:a"]);
		const both = search(s, "secret", { scopeKeys: ["scope:a", "scope:b"] });
		if (both.status !== "ok") throw new Error("unreachable");
		expect(both.hits.map((hit) => hit.scopeKey).sort()).toEqual([
			"scope:a",
			"scope:b",
		]);
		expect(search(s, "secret", { scopeKeys: ["scope:z"] })).toEqual({
			status: "blocked",
			reasonCode: "SCOPE_NOT_PERMITTED",
		});
		const other = s.read((db) =>
			searchRecords(db, {
				contractVersion: 1,
				access: { ...ACCESS, principal: "local:other" },
				scopeKeys: ["scope:a"],
				query: "secret",
				limit: 5,
			}),
		);
		expect(other).toMatchObject({ status: "ok", hits: [] });
	});

	test("deactivated records are not searched; recapture of new content replaces the indexed revision", () => {
		const s = open();
		const id = put(s, "scope:a", "o1", "first version text");
		put(s, "scope:a", "o1", "second edition body");
		// 古い revision の索引行は残さない（現在 revision だけを索引する）
		expect(
			s.writer
				.query(
					"SELECT COUNT(*) AS n FROM memory_record_fts WHERE memory_record_fts MATCH '\"first\"'",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(
			s.writer.query("SELECT COUNT(*) AS n FROM memory_record_fts").get(),
		).toEqual({ n: 1 });
		for (const strategy of ["like", "fts"] as const) {
			expect(search(s, "first version", { strategy })).toMatchObject({
				hits: [],
			});
			expect(search(s, "second edition", { strategy })).toMatchObject({
				hits: [{}],
			});
		}
		s.write((db) =>
			deactivateRecord(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: "scope:a",
				clock: { atMs: 2 },
				recordId: id,
			}),
		);
		for (const strategy of ["like", "fts"] as const) {
			expect(search(s, "second edition", { strategy })).toMatchObject({
				hits: [],
			});
		}
	});

	test("order is (updated_seq DESC, record_id ASC) and cursors page without gaps or repeats", () => {
		const s = open();
		const ids: string[] = [];
		for (let index = 0; index < 7; index += 1)
			ids.push(put(s, "scope:a", `o${index}`, `common phrase number ${index}`));
		const collected: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page += 1) {
			const result = search(s, "common phrase", {
				limit: 3,
				...(cursor === undefined ? {} : { cursor }),
			});
			if (result.status !== "ok") throw new Error("unreachable");
			collected.push(...result.hits.map((hit) => hit.ref.id));
			cursor = result.nextCursor;
			if (cursor === undefined) break;
		}
		expect(collected).toEqual([...ids].reverse());
		// cursor は検索条件に束縛される
		const first = search(s, "common phrase", { limit: 2 });
		if (first.status !== "ok" || first.nextCursor === undefined)
			throw new Error("unreachable");
		expect(() =>
			search(s, "number", { limit: 2, cursor: first.nextCursor as string }),
		).toThrow();
		expect(() => search(s, "common phrase", { cursor: "garbage" })).toThrow();
	});

	test("query validation", () => {
		const s = open();
		const code = (query: string) => {
			try {
				search(s, query);
			} catch (error) {
				if (isMemoryContractError(error)) return `${error.code}@${error.path}`;
				throw error;
			}
			return "ok";
		};
		expect(code("   ")).toBe("EMPTY_STRING@$.query");
		expect(code("a\u0000b")).toBe("INVALID_STRING@$.query");
		expect(code("a b c d e f g h i")).toBe("ARRAY_TOO_LONG@$.query");
		expect(code("x".repeat(257))).toBe("STRING_TOO_LONG@$.query");
		expect(code("ok")).toBe("ok");
	});

	test("strategy selection: small scope uses like, large scope with long terms uses fts", () => {
		const s = open();
		put(s, "scope:a", "o1", "needle in a haystack");
		const small = search(s, "needle");
		if (small.status !== "ok") throw new Error("unreachable");
		expect(small.strategy).toBe("like");
		expect(LIKE_SCAN_MAX).toBe(5000);
		s.writer.exec("BEGIN");
		try {
			// 件数を LIKE_SCAN_MAX 超にするため行を直接足す（検索の戦略選択だけを見る）
			for (let index = 0; index < LIKE_SCAN_MAX + 1; index += 1) {
				s.writer
					.query(
						`INSERT INTO memory_record (record_id, principal, scope_key, origin_namespace, origin_kind, origin_id,
							media_type, capture_state, status, current_revision, created_seq, updated_seq)
						VALUES (?, 'local:owner', 'scope:c', 'x', 'y', ?, 'text/plain', 'complete', 'active', 'r', 1, 1)`,
					)
					.run(`rec:${index.toString(16).padStart(64, "0")}`, String(index));
			}
			s.writer.exec("COMMIT");
		} catch (error) {
			s.writer.exec("ROLLBACK");
			throw error;
		}
		const large = search(s, "needle", { scopeKeys: ["scope:a", "scope:c"] });
		if (large.status !== "ok") throw new Error("unreachable");
		expect(large.strategy).toBe("fts");
		expect(large.hits).toHaveLength(1);
		const shortTerm = search(s, "ne", { scopeKeys: ["scope:a", "scope:c"] });
		if (shortTerm.status !== "ok") throw new Error("unreachable");
		expect(shortTerm.strategy).toBe("like");
	});

	test("without FTS: capture fails with FTS_UNAVAILABLE, search falls back to LIKE", () => {
		const s = open();
		put(s, "scope:a", "o1", "needle in a haystack");
		s.writer.exec("DROP TABLE memory_record_fts");
		expect(() => put(s, "scope:a", "o2", "another one")).toThrow();
		try {
			put(s, "scope:a", "o3", "another two");
		} catch (error) {
			expect(
				isMemoryStoreError(error) && error.code === "FTS_UNAVAILABLE",
			).toBe(true);
		}
		const forcedFts = search(s, "needle", { strategy: "fts" });
		if (forcedFts.status !== "ok") throw new Error("unreachable");
		expect(forcedFts.strategy).toBe("like");
		expect(forcedFts.hits).toHaveLength(1);
	});
});

// ---- property: like と fts の結果集合が一致（3 文字以上）----

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

const ALPHABET = [..."abcABC xyz  食べ物辛いコーヒー😀🍣É.%_\"'-"];

describe("property: like and fts agree (fixed seed)", () => {
	test("random bodies and queries give identical hit sets, order and ranges, and match a brute-force oracle", () => {
		const s = open();
		const random = mulberry32(20261008);
		const pick = <T>(items: readonly T[]): T =>
			items[Math.floor(random() * items.length)] as T;
		const randomText = (length: number): string => {
			let out = "";
			for (let index = 0; index < length; index += 1) out += pick(ALPHABET);
			return out;
		};
		const scopes = ["scope:a", "scope:b"];
		const bodies = new Map<string, { scope: string; content: string }>();
		for (let index = 0; index < 120; index += 1) {
			const scope = pick(scopes);
			const content = randomText(5 + Math.floor(random() * 40));
			const id = put(s, scope, `o${index}`, content);
			bodies.set(id, { scope, content });
		}
		let checked = 0;
		let nonEmpty = 0;
		for (let round = 0; round < 300; round += 1) {
			const termCount = 1 + Math.floor(random() * 2);
			const terms: string[] = [];
			for (let t = 0; t < termCount; t += 1) {
				const source = [...pick([...bodies.values()]).content].filter(
					(c) => c !== " " && c !== "　",
				);
				const length = 3 + Math.floor(random() * 3);
				const from = Math.floor(random() * Math.max(1, source.length - length));
				const fragment =
					random() < 0.7
						? source.slice(from, from + length).join("")
						: randomText(length).replaceAll(" ", "z");
				terms.push(random() < 0.3 ? fragment.toUpperCase() : fragment);
			}
			const query = terms.join(" ");
			const parsedTerms = query.split(" ").filter((term) => term.length > 0);
			if (parsedTerms.some((term) => [...term].length < 3)) continue;
			const scopeKeys = random() < 0.5 ? ["scope:a"] : ["scope:a", "scope:b"];
			const like = search(s, query, { scopeKeys, strategy: "like" });
			const fts = search(s, query, { scopeKeys, strategy: "fts" });
			if (like.status !== "ok" || fts.status !== "ok")
				throw new Error("unreachable");
			expect(like.strategy).toBe("like");
			expect(fts.strategy).toBe("fts");
			expect(fts.hits).toEqual(like.hits);
			const folded = parsedTerms.map(foldAscii);
			const oracle = [...bodies.entries()]
				.filter(([, body]) => scopeKeys.includes(body.scope))
				.filter(([, body]) =>
					folded.every((term) => foldAscii(body.content).includes(term)),
				)
				.map(([id]) => id)
				.sort();
			expect(like.hits.map((hit) => hit.ref.id).sort()).toEqual(oracle);
			checked += 1;
			if (oracle.length > 0) nonEmpty += 1;
		}
		expect(checked).toBeGreaterThan(100);
		expect(nonEmpty).toBeGreaterThan(30);
	});
});

describe("query plans use the scope index", () => {
	test("neither strategy scans memory_record; tombstone lookups are primary-key searches", () => {
		const s = open();
		put(s, "scope:a", "o1", "needle in a haystack");
		const parsed = parseQueryTerms("needle");
		if (parsed.status !== "ok") throw new Error("unreachable");
		for (const strategy of ["like", "fts"] as const) {
			const { sql, params } = buildSearchQuery({
				principal: "local:owner",
				scopeKeys: ["scope:a"],
				query: parsed.query,
				strategy,
				after: null,
				fetch: 11,
			});
			const plan = (
				s.writer.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
					detail: string;
				}[]
			).map((row) => row.detail);
			expect(
				plan.some((detail) => detail.includes("memory_record_by_scope")),
			).toBe(true);
			expect(
				plan.filter((detail) => /^SCAN (r|memory_record)\b/.test(detail)),
			).toEqual([]);
			expect(
				plan.filter(
					(detail) =>
						detail.includes("memory_tombstone") && !detail.startsWith("SEARCH"),
				),
			).toEqual([]);
		}
	});
});
