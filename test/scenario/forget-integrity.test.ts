/**
 * 忘却の完全性（spec/improvement-design.md の R-1・R-2・R-3・R-5）。
 * 使い捨ての実 SQLite（ファイル + WAL）で、復元・本人確認・出典の書き方・他人の記憶にかかわらず、忘却が派生先に届き、
 * 正常な書き込みが例外で落ちないことを確かめる。
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { assertUserState, isMemoryStoreError } from "eumenes-memory/sqlite";
import type { SourceRef } from "eumenes-memory";
import type {
	ForgetJournalEntry,
	HostSourceState,
	StateWriteResult,
} from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";
import {
	OWNER,
	accessFor,
	capture,
	forgetRecord,
	reconcile,
	tablesContain,
} from "../runners/records-support.ts";

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function open(options?: Parameters<typeof openTestStore>[0]): TestStore {
	const store = openTestStore(options);
	stores.push(store);
	return store;
}

const SCOPE = "scope:a";

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function message(id: string, content: string, ordinal = 1): HostSourceState {
	const digest = sha256(content);
	return {
		namespace: "conversation",
		kind: "message",
		id,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: OWNER,
		scopeKey: SCOPE,
		status: "available",
		content,
		ordinal,
	};
}

function rangeOf(content: string, quote: string) {
	const index = content.indexOf(quote);
	if (index < 0) throw new Error("quote not found");
	const startByte = Buffer.byteLength(content.slice(0, index), "utf8");
	return { startByte, endByte: startByte + Buffer.byteLength(quote, "utf8") };
}

interface FactSpec {
	readonly semanticKey: string;
	readonly text: string;
	readonly source: HostSourceState;
	/** 出典の SourceRef（range なし。既定は source から作る）。 */
	readonly ref?: SourceRef;
	readonly origin?: "user_confirmed" | "agent_inferred";
	readonly subject?: "self" | `other:${string}`;
}

function assertFact(store: TestStore, spec: FactSpec): StateWriteResult {
	const {
		principal: _p,
		scopeKey: _s,
		status: _st,
		content,
		ordinal: _o,
		...core
	} = spec.source;
	const subject = spec.subject ?? "self";
	return store.write((db) =>
		assertUserState(db, {
			contractVersion: 1,
			access: accessFor([SCOPE], OWNER),
			scopeKey: SCOPE,
			clock: { atMs: 5 },
			kind: subject === "self" ? "preference" : "other_person_note",
			subject,
			semanticKey: spec.semanticKey,
			value: { text: spec.text, polarity: "affirmed" },
			evidence: [
				{
					source: {
						...(spec.ref ?? core),
						range: rangeOf(content, spec.text),
					} as SourceRef,
					quote: spec.text,
				},
			],
			sources: [spec.source],
			origin: spec.origin ?? "user_confirmed",
		}),
	);
}

function appliedId(result: StateWriteResult): {
	itemId: string;
	revision: number;
} {
	if (result.status !== "applied") {
		throw new Error(`expected applied, got ${JSON.stringify(result)}`);
	}
	return { itemId: result.item.itemId, revision: result.item.revision };
}

/** record を出典にした State（本文の source は record の本文つき状態）。 */
function recordSource(
	captured: ReturnType<typeof capture>,
	content: string,
): HostSourceState {
	return {
		...captured.ref,
		principal: OWNER,
		scopeKey: captured.scopeKey,
		status: "available",
		content,
		ordinal: 1,
	};
}

function itemRow(store: TestStore, itemId: string) {
	return store.writer
		.query("SELECT status, value_text FROM memory_state_item WHERE item_id = ?")
		.get(itemId);
}

function evidenceCount(store: TestStore, itemId: string): number {
	return (
		store.writer
			.query(
				"SELECT COUNT(*) AS n FROM memory_state_evidence WHERE item_id = ?",
			)
			.get(itemId) as { n: number }
	).n;
}

function forgetItem(store: TestStore, itemId: string): ForgetJournalEntry {
	return forgetRecord(store, { type: "state_item", itemId, scopeKey: SCOPE })
		.entry;
}

function forgetMessage(store: TestStore, source: HostSourceState): void {
	forgetRecord(store, {
		type: "host_source",
		sourceKey: JSON.stringify([
			source.namespace,
			source.kind,
			source.id,
			"text",
		]),
		scopeKey: SCOPE,
	});
}

describe("R-3: a memory record source must name its representation", () => {
	const CONTENT = "the secret is hunter2 ok";

	test("an omitted representation is a contract error and nothing is stored", () => {
		const store = open();
		const record = capture(store, { origin: "o1", content: CONTENT });
		const { representation: _omit, ...ref } = record.ref;
		expect(() =>
			assertFact(store, {
				semanticKey: "k",
				text: "hunter2",
				source: recordSource(record, CONTENT),
				ref,
			}),
		).toThrow(
			expect.objectContaining({
				code: "MISSING_KEY",
				path: "$.evidence[0].source.representation",
			}),
		);
		expect(
			store.writer.query("SELECT COUNT(*) AS n FROM memory_state_item").get(),
		).toEqual({ n: 0 });
	});

	test("a representation other than text is a contract error; text reaches the closure", () => {
		const store = open();
		const record = capture(store, { origin: "o1", content: CONTENT });
		expect(() =>
			assertFact(store, {
				semanticKey: "k",
				text: "hunter2",
				source: recordSource(record, CONTENT),
				ref: { ...record.ref, representation: "html" },
			}),
		).toThrow(
			expect.objectContaining({
				code: "INVALID_VALUE",
				path: "$.evidence[0].source.representation",
			}),
		);
		const item = appliedId(
			assertFact(store, {
				semanticKey: "k",
				text: "hunter2",
				source: recordSource(record, CONTENT),
			}),
		);
		forgetRecord(store, {
			type: "record",
			recordId: record.recordId,
			scopeKey: SCOPE,
		});
		expect(itemRow(store, item.itemId)).toEqual({
			status: "forgotten",
			value_text: null,
		});
		expect(tablesContain(store, "hunter2")).toBe(false);
	});
});

describe("R-2: confirming an inferred fact keeps the confirmation as evidence", () => {
	const inferred = message("m1", "コーヒーが好きらしい", 1);
	const confirmed = message("m2", "そう、コーヒーが好き", 2);
	const again = message("m3", "やっぱりコーヒーが好き", 3);

	function promote(store: TestStore): string {
		const item = appliedId(
			assertFact(store, {
				semanticKey: "drink",
				text: "コーヒーが好き",
				source: inferred,
				origin: "agent_inferred",
			}),
		);
		const result = assertFact(store, {
			semanticKey: "drink",
			text: "コーヒーが好き",
			source: confirmed,
		});
		expect(result).toMatchObject({
			status: "applied",
			item: { itemId: item.itemId, origin: "user_confirmed" },
		});
		expect(evidenceCount(store, item.itemId)).toBe(2);
		return item.itemId;
	}

	test("forgetting the confirming message reaches the item", () => {
		const store = open();
		const itemId = promote(store);
		forgetMessage(store, confirmed);
		expect(itemRow(store, itemId)).toEqual({
			status: "forgotten",
			value_text: null,
		});
	});

	test("forgetting the original inferred source still reaches the item", () => {
		const store = open();
		const itemId = promote(store);
		forgetMessage(store, inferred);
		expect(itemRow(store, itemId)).toEqual({
			status: "forgotten",
			value_text: null,
		});
	});

	test("a further confirmation with the same origin is unchanged and adds no evidence", () => {
		const store = open();
		const itemId = promote(store);
		const result = assertFact(store, {
			semanticKey: "drink",
			text: "コーヒーが好き",
			source: again,
		});
		expect(result.status).toBe("unchanged");
		expect(evidenceCount(store, itemId)).toBe(2);
	});
});

describe("R-5: a forgotten note about another person keeps no name", () => {
	test("the subject is reduced to other: and the name is in no memory table", () => {
		const store = open();
		const item = appliedId(
			assertFact(store, {
				semanticKey: "alice.drink",
				text: "Aliceは紅茶が好き",
				source: message("m1", "Aliceは紅茶が好き"),
				subject: "other:Alice",
			}),
		);
		forgetItem(store, item.itemId);
		expect(
			store.writer
				.query("SELECT subject FROM memory_state_item WHERE item_id = ?")
				.get(item.itemId),
		).toEqual({ subject: "other:" });
		expect(tablesContain(store, "Alice")).toBe(false);
	});
});

describe("R-1: restoring an old DB rewinds seq without making writes throw", () => {
	test("a new fact whose seq meets an item ID tombstoned during the lost period is written under the next seq", () => {
		const live = open();
		const snapshot = live.snapshotTo("before-lost-period");
		const lost: { itemId: string; createdSeq: number }[] = [];
		for (const [index, text] of ["コーヒー", "紅茶", "緑茶"].entries()) {
			const { itemId } = appliedId(
				assertFact(live, {
					semanticKey: `drink-${index}`,
					text,
					source: message(`m${index}`, `${text}が好き`),
				}),
			);
			const row = live.writer
				.query("SELECT created_seq FROM memory_state_item WHERE item_id = ?")
				.get(itemId) as { created_seq: number };
			lost.push({ itemId, createdSeq: row.created_seq });
		}
		const journal = lost.map(({ itemId }) => forgetItem(live, itemId));

		const restored = open({ fromFile: snapshot });
		expect(reconcile(restored, journal)).toMatchObject({
			status: "ok",
			reapplied: journal.length,
		});
		// どの操作が何個の seq を使うかは操作の組み合わせで変わる（State の書き込みは item と event で 2 個）。
		// 復元後の seq が、失われた期間の item の seq の直前にある状態を直接作る。
		const collision = lost[1];
		if (collision === undefined) throw new Error("missing lost item");
		restored.writer
			.query("UPDATE memory_seq SET value = ? WHERE id = 1")
			.run(collision.createdSeq - 1);
		let result: StateWriteResult;
		try {
			result = assertFact(restored, {
				semanticKey: "new",
				text: "水",
				source: message("n1", "水が好き"),
			});
		} catch (error) {
			// 修正前: 墓標付きの ID と衝突して MemoryStoreError(TOMBSTONED) が投げられる。
			throw new Error(
				`write threw ${isMemoryStoreError(error) ? error.code : String(error)}`,
			);
		}
		const written = appliedId(result).itemId;
		expect(lost.map(({ itemId }) => itemId)).not.toContain(written);
		const row = restored.writer
			.query("SELECT created_seq FROM memory_state_item WHERE item_id = ?")
			.get(written) as { created_seq: number };
		expect(row.created_seq).toBeGreaterThan(collision.createdSeq);
		const tombstoned = restored.writer
			.query(
				"SELECT target_id FROM memory_tombstone WHERE target_type = 'state_item' ORDER BY target_id",
			)
			.all()
			.map((r) => (r as { target_id: string }).target_id);
		expect(tombstoned).toEqual(lost.map(({ itemId }) => itemId).sort());
	});
});
