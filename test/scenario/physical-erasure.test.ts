/**
 * 物理消去の確認（改善計画 T21）。推奨運用（`PRAGMA secure_delete=ON` + 忘却後の `wal_checkpoint(TRUNCATE)`）の下で、
 * 忘却した本文が DB ファイルと WAL のバイト列に残らないことを実 SQLite で確かめる。
 * 保証範囲はここまで。OS のスナップショット、ファイルシステムの残存、バックアップは保証しない。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { openTestStore } from "./../support/store.ts";
import type { TestStore } from "./../support/store.ts";
import { capture, forgetRecord } from "../runners/records-support.ts";

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

const NEEDLE = "ERASE-NEEDLE-7c41 検索語 😀";

function bytesOf(path: string): Buffer {
	return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
}

function filesContain(store: TestStore, needle: string): boolean {
	const probe = Buffer.from(needle, "utf8");
	return [store.path, `${store.path}-wal`].some((file) =>
		bytesOf(file).includes(probe),
	);
}

function prepare(secureDelete: boolean): {
	store: TestStore;
	recordId: string;
} {
	const store = openTestStore();
	stores.push(store);
	store.writer.exec(`PRAGMA secure_delete = ${secureDelete ? "ON" : "OFF"}`);
	const target = capture(store, { origin: "o1", content: NEEDLE });
	capture(store, { origin: "o2", content: "別の記録 unrelated body" });
	store.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	return { store, recordId: target.recordId };
}

describe("physical erasure after forget", () => {
	test("sanity: the needle is in the files before forgetting", () => {
		const { store } = prepare(true);
		expect(filesContain(store, NEEDLE)).toBe(true);
	});

	test("secure_delete=ON + checkpoint(TRUNCATE): the body is gone from the db and wal files", () => {
		const { store, recordId } = prepare(true);
		forgetRecord(store, { type: "record", recordId, scopeKey: "scope:a" });
		store.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(filesContain(store, NEEDLE)).toBe(false);
		expect(filesContain(store, "SECRET")).toBe(false);
	});

	test("control: without secure_delete the body stays in free pages (why the pragma is required)", () => {
		const { store, recordId } = prepare(false);
		forgetRecord(store, { type: "record", recordId, scopeKey: "scope:a" });
		store.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(filesContain(store, NEEDLE)).toBe(true);
	});

	test("the unrelated record survives the forget in the files", () => {
		const { store, recordId } = prepare(true);
		forgetRecord(store, { type: "record", recordId, scopeKey: "scope:a" });
		store.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(filesContain(store, "unrelated body")).toBe(true);
	});
});
