import { afterEach, describe, expect, test } from "bun:test";
import { isMemoryStoreError, MemoryStoreError } from "../errors.ts";
import { assertWritable, issueSeq } from "../db.ts";
import type { MemoryDb } from "../db.ts";
import { enterRead, enterWrite } from "../session.ts";
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

function catchError(operation: () => unknown): unknown {
	try {
		operation();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("MemoryDb port", () => {
	test("bun:sqlite Database is structurally a MemoryDb (compile-time + runtime)", () => {
		const s = open();
		const asPort: MemoryDb = s.writer;
		const reader: MemoryDb = s.reader;
		expect(typeof asPort.exec).toBe("function");
		expect(typeof reader.query).toBe("function");
		expect(asPort.inTransaction).toBe(false);
		s.write((db) => {
			expect(db.inTransaction).toBe(true);
		});
	});

	test("a db without inTransaction skips the transaction check", () => {
		const s = open();
		const bare: MemoryDb = {
			exec: (sql) => s.writer.exec(sql),
			query: (sql) => s.writer.query(sql),
		};
		expect(() => assertWritable(bare)).not.toThrow();
		expect(issueSeq(bare)).toBe(1);
	});
});

describe("write entry checks", () => {
	test("rejects calls outside a transaction", () => {
		const s = open();
		const error = catchError(() => enterWrite(s.writer));
		expect(isMemoryStoreError(error)).toBe(true);
		expect((error as MemoryStoreError).code).toBe("NOT_IN_TRANSACTION");
		expect((error as MemoryStoreError).message).toBe("NOT_IN_TRANSACTION");
		// transaction 外の拒否では seq を消費しない
		expect(s.write((db) => enterWrite(db))).toBe(1);
	});

	test("rejects a readonly connection (even inside a read transaction)", () => {
		const s = open();
		const error = catchError(() => s.read((db) => enterWrite(db)));
		expect((error as MemoryStoreError).code).toBe("READONLY_CONNECTION");
		expect(s.write((db) => enterWrite(db))).toBe(1);
	});

	test("rejects a database without migrations as SCHEMA_MISSING", () => {
		const s = (store = openTestStore({ migrations: [] }));
		const error = catchError(() => s.write((db) => enterWrite(db)));
		expect((error as MemoryStoreError).code).toBe("SCHEMA_MISSING");
		expect(
			(catchError(() => enterRead(s.writer)) as MemoryStoreError).code,
		).toBe("SCHEMA_MISSING");
	});

	test("seq is strictly monotonic across operations and rolls back with the transaction", () => {
		const s = open();
		const first = s.write((db) => [enterWrite(db), issueSeq(db), issueSeq(db)]);
		expect(first).toEqual([1, 2, 3]);
		const failed = catchError(() =>
			s.write((db) => {
				enterWrite(db);
				throw new Error("boom");
			}),
		);
		expect((failed as Error).message).toBe("boom");
		expect(s.write((db) => enterWrite(db))).toBe(4);
	});

	test("reads do not need a transaction and work on the readonly connection", () => {
		const s = open();
		expect(() => enterRead(s.writer)).not.toThrow();
		expect(() => s.read((db) => enterRead(db))).not.toThrow();
	});
});

describe("MemoryStoreError", () => {
	test("message is the code only; structural copies are recognized; look-alikes are not", () => {
		const real = new MemoryStoreError("CORRUPT_ROW");
		expect(real.message).toBe("CORRUPT_ROW");
		expect(isMemoryStoreError(real)).toBe(true);
		const copy = Object.assign(new Error("x"), {
			name: "MemoryStoreError",
			code: "SCHEMA_MISMATCH",
		});
		expect(isMemoryStoreError(copy)).toBe(true);
		expect(
			isMemoryStoreError(
				Object.assign(new Error("x"), {
					name: "MemoryStoreError",
					code: "NOPE",
				}),
			),
		).toBe(false);
		expect(
			isMemoryStoreError({ name: "MemoryStoreError", code: "CORRUPT_ROW" }),
		).toBe(false);
		expect(isMemoryStoreError(null)).toBe(false);
	});
});
