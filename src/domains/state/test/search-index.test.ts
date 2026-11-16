/**
 * S7: State の全文検索の索引（migration 0009、設計 `spec/state-search-design.md` §3.3〜3.4、§7）。
 * 索引は候補を出すだけで、本文の正本ではない。ここでは索引そのもの（対応表、FTS 表、trigger、作り直し）を確かめる。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	assertUserState,
	deactivateState,
	reactivateState,
	scrubStateItem,
} from "../repository/index.ts";
import {
	rebuildStateSearchIndex,
	verifyStateSearchIndex,
} from "../repository/search-index.ts";
import type { StateItem, StateWriteResult } from "../contracts/index.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { migrations } from "../../../infrastructure/sqlite/migrations/index.ts";
import { assertMemorySchema } from "../../../infrastructure/sqlite/schema-check.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import {
	ACCESS,
	SCOPE,
	assertInput,
	makeSource,
	makeSpan,
	targetInput,
	value,
} from "./state-support.ts";

let store: TestStore | undefined;
afterEach(() => {
	store?.close();
	store = undefined;
});
function open(options: Parameters<typeof openTestStore>[0] = {}): TestStore {
	store = openTestStore(options);
	store.writer.exec("PRAGMA secure_delete=ON");
	return store;
}
function applied(result: StateWriteResult): StateItem {
	if (result.status !== "applied")
		throw new Error(`expected applied, got ${JSON.stringify(result)}`);
	return result.item;
}
/** 索引だけで引いた item の ID（phrase として引用する）。 */
function match(db: MemoryDb, term: string): string[] {
	return (
		db
			.query(
				`SELECT r.item_id FROM memory_state_fts f
				JOIN memory_state_search_row r ON r.search_rowid = f.rowid
				WHERE memory_state_fts MATCH ? ORDER BY r.item_id`,
			)
			.all(`"${term.replaceAll('"', '""')}"`) as { item_id: string }[]
	).map((row) => row.item_id);
}
let sourceCounter = 0;
function remember(
	s: TestStore,
	text: string,
	options: {
		semanticKey?: string;
		attributes?: Record<string, string>;
		replaces?: StateItem;
		origin?: "user_confirmed" | "agent_inferred";
	} = {},
): StateItem {
	sourceCounter += 1;
	const source = makeSource(
		`s${sourceCounter}`,
		`発言: ${text}`,
		sourceCounter,
	);
	return applied(
		s.write((db) =>
			assertUserState(
				db,
				assertInput({
					clock: { atMs: 1000 + sourceCounter },
					semanticKey: options.semanticKey ?? "drink",
					value: value(text, "affirmed", options.attributes),
					evidence: [makeSpan(source, text)],
					sources: [source],
					origin: options.origin ?? "user_confirmed",
					...(options.replaces
						? {
								replaces: {
									itemId: options.replaces.itemId,
									revision: options.replaces.revision,
								},
							}
						: {}),
				}),
			),
		),
	);
}
function verify(s: TestStore) {
	return s.write((db) => verifyStateSearchIndex(db));
}

describe("migration 0009", () => {
	test("T-MIG-1 0009 builds the index for an existing v8 DB", () => {
		const s = open({ migrations: migrations.slice(0, 8) });
		// 版 8 の DB は核の書き込み関数を受け付けないので、行を直接入れる（active・superseded・forgotten）。
		const insert = s.writer.query(
			`INSERT INTO memory_state_item (item_id, principal, scope_key, subject, kind, semantic_key, status, revision,
				value_text, polarity, origin, evidence_ordinal, created_seq, updated_seq)
			VALUES (?, ?, ?, 'self', 'preference', ?, ?, 1, ?, ?, 'user_confirmed', 0, 1, 1)`,
		);
		insert.run(
			"state:a",
			ACCESS.principal,
			SCOPE,
			"drink",
			"active",
			"抹茶ラテが好き",
			"affirmed",
		);
		insert.run(
			"state:b",
			ACCESS.principal,
			SCOPE,
			"drink-old",
			"superseded",
			"ほうじ茶が好き",
			"affirmed",
		);
		insert.run("state:c", ACCESS.principal, SCOPE, "", "forgotten", null, null);
		insert.run(
			"state:d",
			ACCESS.principal,
			SCOPE,
			"hobby",
			"active",
			"陶芸を楽しむ",
			"affirmed",
		);
		s.writer
			.query(
				"INSERT INTO memory_state_attribute (item_id, attr_key, attr_value) VALUES (?, ?, ?)",
			)
			.run("state:d", "place", "京都の工房");
		s.writer.exec(migrations[8] as string);
		assertMemorySchema(s.writer);
		const report = verify(s);
		expect(report).toMatchObject({
			consistent: true,
			activeItems: 2,
			indexedRows: 2,
		});
		expect(match(s.writer, "抹茶ラテ")).toEqual(["state:a"]);
		expect(match(s.writer, "ほうじ茶")).toEqual([]);
		expect(match(s.writer, "京都の工房")).toEqual(["state:d"]);
		expect(match(s.writer, "hobby")).toEqual(["state:d"]);
	});
});

describe("index maintenance", () => {
	test("T-IDX-1 index equals active set after random operations", () => {
		const s = open({ inMemory: true });
		let seed = 12345;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return (seed >>> 8) % n;
		};
		const keys = Array.from({ length: 20 }, (_, i) => `topic-key-${i}`);
		const counts: Record<string, number> = {};
		for (let step = 0; step < 500; step++) {
			const items = s.write(
				(db) =>
					db
						.query(
							"SELECT item_id, status, revision, semantic_key FROM memory_state_item WHERE status <> 'forgotten'",
						)
						.all() as {
						item_id: string;
						status: string;
						revision: number;
						semantic_key: string;
					}[],
			);
			const active = items.filter((x) => x.status === "active");
			const inactive = items.filter((x) => x.status === "inactive");
			const op = random(6);
			const key = keys[random(keys.length)]!;
			const hasKey = active.find((x) => x.semantic_key === key);
			const name = [
				"assert",
				"supersede",
				"deactivate",
				"reactivate",
				"edit",
				"forget",
			][op]!;
			if (op === 0 && !hasKey) {
				remember(s, `値その${step}の記憶`, {
					semanticKey: key,
					attributes: { note: `属性${step}番` },
				});
			} else if (op === 1 && hasKey) {
				const current = s.write((db) =>
					db
						.query("SELECT revision FROM memory_state_item WHERE item_id = ?")
						.get(hasKey.item_id),
				) as { revision: number };
				remember(s, `訂正その${step}の記憶`, {
					semanticKey: key,
					replaces: {
						itemId: hasKey.item_id,
						revision: current.revision,
					} as StateItem,
				});
			} else if (op === 2 && active.length) {
				const target = active[random(active.length)]!;
				s.write((db) =>
					deactivateState(db, targetInput(target.item_id, target.revision)),
				);
			} else if (op === 3 && inactive.length) {
				const target = inactive[random(inactive.length)]!;
				s.write((db) =>
					reactivateState(db, targetInput(target.item_id, target.revision)),
				);
			} else if (op === 4 && !hasKey) {
				// 推定で保存してから、同じ値を本人が確認する（edit: origin の格上げ）。
				const text = `確認その${step}の記憶`;
				remember(s, text, { semanticKey: key, origin: "agent_inferred" });
				remember(s, text, { semanticKey: key });
			} else if (op === 5 && items.length) {
				const target = items[random(items.length)]!;
				s.write((db) =>
					scrubStateItem(db, ACCESS.principal, target.item_id, 1000000 + step),
				);
			} else continue;
			counts[name] = (counts[name] ?? 0) + 1;
		}
		for (const name of [
			"assert",
			"supersede",
			"deactivate",
			"reactivate",
			"edit",
			"forget",
		])
			expect(counts[name] ?? 0).toBeGreaterThan(5);
		expect(verify(s).consistent).toBe(true);
		const active = s.write(
			(db) =>
				db
					.query(
						"SELECT item_id, semantic_key FROM memory_state_item WHERE status = 'active'",
					)
					.all() as { item_id: string; semantic_key: string }[],
		);
		expect(active.length).toBeGreaterThan(0);
		for (const item of active)
			expect(match(s.writer, item.semantic_key)).toContain(item.item_id);
		const gone = s.write(
			(db) =>
				db
					.query(
						"SELECT item_id FROM memory_state_item WHERE status <> 'active'",
					)
					.all() as {
					item_id: string;
				}[],
		);
		const indexed = new Set(keys.flatMap((k) => match(s.writer, k)));
		for (const item of gone) expect(indexed.has(item.item_id)).toBe(false);
	});

	test("T-IDX-2 a correction removes the old text from the index", () => {
		const s = open();
		const tea = remember(s, "紅茶が好き");
		expect(match(s.writer, "紅茶が")).toEqual([tea.itemId]);
		const coffee = remember(s, "コーヒーが好き", { replaces: tea });
		expect(match(s.writer, "紅茶が")).toEqual([]);
		expect(match(s.writer, "コーヒー")).toEqual([coffee.itemId]);
	});

	test("T-IDX-3 an attribute change reindexes", () => {
		const s = open();
		const first = remember(s, "旅行が好き", {
			attributes: { place: "北海道の温泉" },
		});
		expect(match(s.writer, "北海道")).toEqual([first.itemId]);
		const next = remember(s, "旅行が好き", {
			attributes: { place: "沖縄の海辺" },
			replaces: first,
		});
		expect(match(s.writer, "北海道")).toEqual([]);
		expect(match(s.writer, "沖縄の")).toEqual([next.itemId]);
	});

	test("T-IDX-4 a missed app reinsert fails safe and the rebuild restores it", () => {
		const s = open();
		const tea = remember(s, "紅茶が好き");
		// アプリの再登録が漏れた状態を作る: 置き換えの後、新しい item の対応表と索引の行を消す（trigger は古い方を消す）。
		const coffee = remember(s, "コーヒーが好き", { replaces: tea });
		s.write((db) => {
			db.query(
				"DELETE FROM memory_state_fts WHERE rowid = (SELECT search_rowid FROM memory_state_search_row WHERE item_id = ?)",
			).run(coffee.itemId);
			db.query("DELETE FROM memory_state_search_row WHERE item_id = ?").run(
				coffee.itemId,
			);
		});
		expect(match(s.writer, "紅茶が")).toEqual([]);
		expect(match(s.writer, "コーヒー")).toEqual([]);
		expect(verify(s).consistent).toBe(false);
		// 対応表は残ったまま索引の行だけが無い場合も、不一致として見つける。
		const rebuilt = s.write((db) => rebuildStateSearchIndex(db));
		expect(rebuilt.consistent).toBe(true);
		expect(match(s.writer, "コーヒー")).toEqual([coffee.itemId]);
		s.write((db) => db.query("DELETE FROM memory_state_fts").run());
		expect(verify(s)).toMatchObject({ consistent: false, missingRows: 1 });
		expect(s.write((db) => rebuildStateSearchIndex(db)).consistent).toBe(true);
	});

	test("T-IDX-5 a stale indexed document is found and the rebuild replaces it", () => {
		const s = open();
		const tea = remember(s, "紅茶が好き", { attributes: { when: "朝の食後" } });
		// 索引の文書だけを古い本文にする（正本は変えない）。
		s.write((db) =>
			db
				.query(
					"UPDATE memory_state_fts SET doc = 'drink\n昔の古い本文' WHERE rowid = (SELECT search_rowid FROM memory_state_search_row WHERE item_id = ?)",
				)
				.run(tea.itemId),
		);
		expect(match(s.writer, "昔の古")).toEqual([tea.itemId]);
		expect(verify(s)).toMatchObject({
			consistent: false,
			missingRows: 0,
			staleRows: 1,
		});
		expect(s.write((db) => rebuildStateSearchIndex(db))).toMatchObject({
			consistent: true,
			staleRows: 0,
		});
		expect(match(s.writer, "昔の古")).toEqual([]);
		expect(match(s.writer, "朝の食")).toEqual([tea.itemId]);
	});

	test("T-IDX-6 confirming the same value does not rewrite the index", () => {
		const s = open();
		// FTS5 の構造の記録（id 10）は、索引の行を足すか消すたびに変わる。
		const structure = () =>
			s.writer
				.query("SELECT block FROM memory_state_fts_data WHERE id = 10")
				.get() as { block: Uint8Array };
		for (const attributes of [undefined, { when: "朝の食後" }]) {
			const key = attributes ? "with-attr" : "no-attr";
			const inferred = remember(s, "紅茶が好き", {
				semanticKey: key,
				origin: "agent_inferred",
				...(attributes ? { attributes } : {}),
			});
			const before = structure();
			const confirmed = remember(s, "紅茶が好き", {
				semanticKey: key,
				...(attributes ? { attributes } : {}),
			});
			expect(confirmed.itemId).toBe(inferred.itemId);
			expect(confirmed.origin).not.toBe("agent_inferred");
			expect(structure()).toEqual(before);
		}
		expect(verify(s).consistent).toBe(true);
	});

	test("rebuild and verify require a migrated store; rebuild needs a write transaction", () => {
		const s = open();
		expect(() => rebuildStateSearchIndex(s.writer)).toThrow();
		expect(() => verifyStateSearchIndex({} as MemoryDb)).toThrow();
	});
});

describe("physical leaks", () => {
	const SECRET = "ZQXWVU秘密の合言葉";
	function trigrams(text: string): string[] {
		const chars = [...text];
		const out: string[] = [];
		for (let i = 0; i + 3 <= chars.length; i++)
			out.push(chars.slice(i, i + 3).join(""));
		return out;
	}
	function leaked(paths: string[], text: string): string[] {
		const found: string[] = [];
		for (const path of paths) {
			let bytes: Buffer;
			try {
				bytes = readFileSync(path);
			} catch {
				continue;
			}
			for (const gram of trigrams(text))
				if (bytes.includes(Buffer.from(gram))) found.push(gram);
		}
		return found;
	}

	test("T-LEAK-1 forget removes trigrams from the db file and WAL", () => {
		const s = open();
		remember(s, "普通の記憶です", { semanticKey: "keep" });
		const secret = remember(s, SECRET, {
			semanticKey: "secret",
			attributes: { hint: `${SECRET}の補足` },
		});
		s.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(leaked([s.path], SECRET).length).toBeGreaterThan(0);
		s.write((db) => scrubStateItem(db, ACCESS.principal, secret.itemId, 999));
		s.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(leaked([s.path, `${s.path}-wal`], SECRET)).toEqual([]);
		expect(match(s.writer, "ZQXWVU")).toEqual([]);
		expect(verify(s).consistent).toBe(true);
	});

	test("T-LEAK-3 fts5vocab has no forgotten terms", () => {
		const s = open();
		const kept = remember(s, "ありふれた記憶", { semanticKey: "keep" });
		const secret = remember(s, SECRET, { semanticKey: "secret" });
		s.writer.exec(
			"CREATE VIRTUAL TABLE temp.memory_vocab USING fts5vocab(main, memory_state_fts, row)",
		);
		const terms = () =>
			new Set(
				(
					s.writer.query("SELECT term FROM temp.memory_vocab").all() as {
						term: string;
					}[]
				).map((x) => x.term),
			);
		expect(terms().has("zqx")).toBe(true);
		s.write((db) => scrubStateItem(db, ACCESS.principal, secret.itemId, 999));
		const after = terms();
		for (const gram of trigrams(SECRET.toLowerCase()))
			expect(after.has(gram)).toBe(false);
		for (const gram of trigrams("ありふれた記憶"))
			expect(after.has(gram)).toBe(true);
		expect(match(s.writer, "ありふれた")).toEqual([kept.itemId]);
	});

	test("T-LEAK-4 contentless_delete regression guard", () => {
		const s = open();
		const sql = (
			s.writer
				.query("SELECT sql FROM sqlite_master WHERE name = 'memory_state_fts'")
				.get() as { sql: string }
		).sql;
		expect(sql).toContain("trigram");
		expect(sql).not.toMatch(/contentless_delete|content\s*=/);
		expect(
			s.writer
				.query(
					"SELECT v FROM memory_state_fts_config WHERE k = 'secure-delete'",
				)
				.get(),
		).toEqual({ v: 1 });
		// 作り直しても同じ定義と設定になる（作り直しの SQL は migration 0009 の写し）。
		s.write((db) => rebuildStateSearchIndex(db));
		expect(
			(
				s.writer
					.query(
						"SELECT sql FROM sqlite_master WHERE name = 'memory_state_fts'",
					)
					.get() as { sql: string }
			).sql,
		).toBe(sql);
		expect(
			s.writer
				.query(
					"SELECT v FROM memory_state_fts_config WHERE k = 'secure-delete'",
				)
				.get(),
		).toEqual({ v: 1 });
	});
});
