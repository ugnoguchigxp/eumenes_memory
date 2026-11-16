/** S8: 核の全文検索（`searchState`、設計 §3.5〜3.8、§4.1）。 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	assertUserState,
	scrubStateItem,
	searchState,
} from "../repository/index.ts";
import type {
	SearchStateInput,
	StateItem,
	StateWriteResult,
} from "../contracts/index.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import {
	ACCESS,
	OTHER_SCOPE,
	SCOPE,
	assertInput,
	makeSource,
	makeSpan,
	value,
} from "./state-support.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(): TestStore {
	store = openTestStore({ inMemory: true });
	return store;
}
function applied(result: StateWriteResult): StateItem {
	if (result.status !== "applied")
		throw new Error(`expected applied, got ${JSON.stringify(result)}`);
	return result.item;
}
let counter = 0;
function remember(
	s: TestStore,
	text: string,
	options: {
		semanticKey?: string;
		scopeKey?: string;
		kind?: "preference" | "habit";
		attributes?: Record<string, string>;
	} = {},
): StateItem {
	counter += 1;
	const scopeKey = options.scopeKey ?? SCOPE;
	const source = makeSource(
		`q${counter}`,
		`発言: ${text}`,
		counter,
		{},
		scopeKey,
	);
	return applied(
		s.write((db) =>
			assertUserState(
				db,
				assertInput({
					scopeKey,
					clock: { atMs: 1000 + counter },
					kind: options.kind ?? "preference",
					semanticKey: options.semanticKey ?? `key-${counter}`,
					value: value(text, "affirmed", options.attributes),
					evidence: [makeSpan(source, text)],
					sources: [source],
				}),
			),
		),
	);
}
function search(
	s: TestStore,
	indexed: string[],
	scanned: string[] = [],
	extra: Partial<SearchStateInput> = {},
) {
	return s.read((db: MemoryDb) =>
		searchState(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKeys: [SCOPE],
			terms: { indexed, scanned },
			limit: 20,
			...extra,
		}),
	);
}
function ids(result: ReturnType<typeof search>): string[] {
	if (result.status !== "ok") throw new Error(JSON.stringify(result));
	return result.items.map((x) => x.itemId);
}

describe("searchState", () => {
	test("T-SCOPE-1 filtering happens before ranking", () => {
		const s = open();
		for (let i = 0; i < 100; i++)
			remember(s, `抹茶が抹茶が抹茶が抹茶が ${i}`, {
				scopeKey: OTHER_SCOPE,
				semanticKey: `strong-${i}`,
			});
		const weak: string[] = [];
		for (let i = 0; i < 20; i++)
			weak.push(
				remember(
					s,
					`長い文の中に一度だけ抹茶が出てくる弱い一致の記憶その${i}`,
					{ semanticKey: `weak-${i}` },
				).itemId,
			);
		const result = search(s, ["抹茶が"]);
		expect(result).toMatchObject({ status: "ok", more: false, mode: "fts" });
		expect(ids(result).sort()).toEqual(weak.sort());
		const both = search(s, ["抹茶が抹"], [], {
			scopeKeys: [SCOPE, OTHER_SCOPE],
			limit: 21,
		});
		expect(
			both.status === "ok" &&
				both.items.every((x) => x.scopeKey === OTHER_SCOPE),
		).toBe(true);
		expect(both.status === "ok" && both.more).toBe(true);
	});

	test("T-SCOPE-2 a scope outside access is blocked", () => {
		const s = open();
		expect(
			search(s, ["抹茶ラテ"], [], {
				access: { ...ACCESS, scopeKeys: [SCOPE] },
				scopeKeys: [SCOPE, OTHER_SCOPE],
			}),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
	});

	test("T-SCOPE-3 items carry no score", () => {
		const s = open();
		remember(s, "抹茶ラテが好き");
		const result = search(s, ["抹茶ラテ"]);
		expect(JSON.stringify(result)).not.toMatch(/bm25|score|rank/);
	});

	test("T-Q-3 short terms use the scan path, long terms FTS, mixed both", () => {
		const s = open();
		const commute = remember(s, "通勤は電車通勤です", {
			semanticKey: "commute",
		});
		const coffee = remember(s, "通勤の前にコーヒーを飲む", {
			semanticKey: "coffee",
		});
		remember(s, "休日は散歩", { semanticKey: "walk" });
		const short = search(s, [], ["通勤"]);
		expect(short).toMatchObject({ status: "ok", mode: "scan" });
		expect(ids(short).sort()).toEqual([commute.itemId, coffee.itemId].sort());
		expect(ids(search(s, ["電車通勤"]))).toEqual([commute.itemId]);
		const mixed = search(s, ["コーヒー"], ["通勤"]);
		expect(mixed).toMatchObject({ mode: "fts" });
		expect(ids(mixed)).toEqual([coffee.itemId]);
		expect(ids(search(s, ["コーヒー"], ["散歩"]))).toEqual([]);
	});

	test("T-Q-4 a short-only query over scanMax is blocked", () => {
		const s = open();
		for (let i = 0; i < 5; i++) remember(s, `通勤の記憶${i}`);
		expect(search(s, [], ["通勤"], { scanMax: 4 })).toEqual({
			status: "blocked",
			reasonCode: "SCAN_LIMIT_EXCEEDED",
		});
		expect(ids(search(s, [], ["通勤"], { scanMax: 5 }))).toHaveLength(5);
		// 3 文字以上の語を足せば、上限に関係なく引ける。
		expect(ids(search(s, ["の記憶"], ["通勤"], { scanMax: 0 }))).toHaveLength(
			5,
		);
	});

	test("T-Q-5 emoji and case", () => {
		const s = open();
		const emoji = remember(s, "好きな絵文字は🍵🍰🍓です", {
			semanticKey: "emoji",
		});
		const ascii = remember(s, "I like Coffee Beans", { semanticKey: "ascii" });
		const wide = remember(s, "ＡＢＣの記号", { semanticKey: "wide" });
		expect(ids(search(s, ["🍵🍰🍓"]))).toEqual([emoji.itemId]);
		expect(ids(search(s, [], ["🍰🍓"]))).toEqual([emoji.itemId]);
		expect(ids(search(s, ["COFFEE"]))).toEqual([ascii.itemId]);
		expect(ids(search(s, [], ["BE"]))).toEqual([ascii.itemId]);
		// 全角と半角は別の文字（NFKC の正規化はしない。決定 3）。
		expect(ids(search(s, ["ABC"]))).toEqual([]);
		expect(ids(search(s, [], ["AB"]))).toEqual([]);
		expect(ids(search(s, ["ＡＢＣ"]))).toEqual([wide.itemId]);
	});

	test("FTS syntax in terms is literal", () => {
		const s = open();
		const odd = remember(s, 'a "quoted" OR NOT NEAR( x* col:y )', {
			semanticKey: "odd",
		});
		remember(s, "plain text", { semanticKey: "plain" });
		for (const term of ['"quoted"', "OR NOT", "NEAR(", "x* col:y", "col:y )"])
			expect(ids(search(s, [term]))).toEqual([odd.itemId]);
	});

	test("limit + 1 decides more; kinds and subject filter before the limit", () => {
		const s = open();
		for (let i = 0; i < 21; i++)
			remember(s, `散歩の記憶その${i}`, {
				kind: i < 3 ? "habit" : "preference",
			});
		const twenty = search(s, ["散歩の"]);
		expect(
			twenty.status === "ok" && [twenty.items.length, twenty.more],
		).toEqual([20, true]);
		const all = search(s, ["散歩の"], [], { limit: 21 });
		expect(all.status === "ok" && [all.items.length, all.more]).toEqual([
			21,
			false,
		]);
		const habits = search(s, ["散歩の"], [], { kinds: ["habit"] });
		expect(
			habits.status === "ok" && [habits.items.length, habits.more],
		).toEqual([3, false]);
		expect(ids(search(s, ["散歩の"], [], { subject: "other:friend" }))).toEqual(
			[],
		);
	});

	test("ranking: bm25 first, then newer first", () => {
		const s = open();
		const older = remember(s, "抹茶", { semanticKey: "matcha-a" });
		const newer = remember(s, "抹茶", { semanticKey: "matcha-b" });
		// 同じ bm25（同じ文書の長さと一致数）なら、新しいものが先。
		const result = ids(search(s, ["matcha"]));
		expect(result).toEqual([newer.itemId, older.itemId]);
	});

	test("invalid term shapes are contract errors", () => {
		const s = open();
		expect(() => search(s, ["ab"])).toThrow();
		expect(() => search(s, [], ["abc"])).toThrow();
		expect(() => search(s, [], [])).toThrow();
		expect(() => search(s, ["a".repeat(65)])).toThrow();
		expect(() => search(s, ["abc\u0000"])).toThrow();
		expect(() => search(s, ["abc"], [], { limit: 22 })).toThrow();
		expect(() =>
			search(
				s,
				Array.from({ length: 9 }, (_, i) => `term${i}`),
			),
		).toThrow();
	});

	test("T-LEAK-5 search never returns forgotten text even with a stale index", () => {
		const s = open();
		const secret = remember(s, "ZQXWVU秘密の合言葉", { semanticKey: "secret" });
		const kept = remember(s, "ZQXWVU以外の記憶", { semanticKey: "kept" });
		// 索引の削除を止める（trigger を消す）。忘れても索引に古い行が残る。
		for (const name of [
			"item_update",
			"attribute_insert",
			"attribute_delete",
			"item_delete",
		])
			s.writer.exec(`DROP TRIGGER memory_state_search_${name}`);
		s.write((db) => scrubStateItem(db, ACCESS.principal, secret.itemId, 999));
		expect(
			s.writer
				.query(
					"SELECT count(*) AS n FROM memory_state_fts WHERE memory_state_fts MATCH '\"秘密の\"'",
				)
				.get(),
		).toEqual({ n: 1 });
		const result = search(s, ["ZQXWVU"]);
		expect(ids(result)).toEqual([kept.itemId]);
		expect(JSON.stringify(result)).not.toContain("秘密");
		expect(ids(search(s, ["秘密の"]))).toEqual([]);
		expect(ids(search(s, [], ["秘密"]))).toEqual([]);
	});

	test("property: results equal a brute-force filter of the active set", () => {
		const s = open();
		let seed = 42;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return (seed >>> 8) % n;
		};
		const alphabet = ["あ", "い", "う", "a", "B", "c"];
		const word = (n: number) =>
			Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join(
				"",
			);
		const docs = new Map<string, string>();
		for (let i = 0; i < 60; i++) {
			const text = word(6 + random(6));
			const item = remember(s, text, {
				semanticKey: `p${i}`,
				attributes: { tag: word(4) },
			});
			docs.set(
				item.itemId,
				`p${i}\n${text}\ntag ${item.value.attributes?.["tag"]}`,
			);
		}
		for (let i = 0; i < 10; i++) {
			const victim = [...docs.keys()][random(docs.size)]!;
			s.write((db) => scrubStateItem(db, ACCESS.principal, victim, 5000 + i));
			docs.delete(victim);
		}
		const lower = (x: string) => x.replace(/[A-Z]/g, (c) => c.toLowerCase());
		for (let q = 0; q < 200; q++) {
			const indexed = random(2) ? [word(3)] : [];
			const scanned = indexed.length && random(2) ? [] : [word(1 + random(2))];
			const expected = [...docs.entries()]
				.filter(([, doc]) =>
					[...indexed, ...scanned].every((t) => lower(doc).includes(lower(t))),
				)
				.map(([id]) => id)
				.sort();
			const result = search(s, indexed, scanned, { limit: 21 });
			if (result.status !== "ok") throw new Error("blocked");
			if (expected.length <= 21) {
				expect(result.items.map((x) => x.itemId).sort()).toEqual(expected);
				expect(result.more).toBe(false);
			} else {
				expect(result.items).toHaveLength(21);
				expect(result.more).toBe(true);
				for (const item of result.items)
					expect(expected).toContain(item.itemId);
			}
		}
	});
});
