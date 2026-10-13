import { describe, expect, test } from "bun:test";
import * as sqlite from "../../src/sqlite.ts";

/** 不正入力の検査では扱わない公開関数（接続の検査と変更フィードの読み取り）。 */
const OTHER_EXPORTS = new Set([
	"assertMemorySchema",
	"isMemoryStoreError",
	"listMemoryChanges",
]);

/** 公開の永続操作と migration 検査。不正な入力では成功を返さず例外を投げる。 */
const PERSISTENCE_OPERATIONS = [
	"captureRecord",
	"checkHostMigrations",
	"readRecord",
	"assertUserState",
	"deactivateState",
	"reactivateState",
	"retractState",
	"listState",
	"readStateFact",
	"latestMemoryChangeSeq",
	"planForget",
	"applyForget",
	"reconcileForgetJournal",
	"recordExternalDeletion",
	"getForgetReceipt",
	"registerExternalDependents",
	"unregisterExternalDependents",
	"retainRecord",
	"readRetainedRecord",
	"useRetainedRecord",
	"retainedRecordStats",
	"evictRetainedRecords",
] as const;

describe("./sqlite public surface", () => {
	test("export list is exactly the documented surface", () => {
		expect(Object.keys(sqlite).sort()).toEqual(
			[
				"MEMORY_DB_SCHEMA_VERSION",
				"MemoryStoreError",
				"STORE_ERROR_CODES",
				...OTHER_EXPORTS,
				...PERSISTENCE_OPERATIONS,
				"migrations",
			].sort(),
		);
	});

	test.each([...PERSISTENCE_OPERATIONS])(
		"%s throws on garbage input and never returns a success",
		(name) => {
			const fn = (
				sqlite as unknown as Record<string, (...args: unknown[]) => unknown>
			)[name];
			expect(typeof fn).toBe("function");
			// 空の db と入力は、入力検査の例外になる（成功を返さない）。
			expect(() => fn?.({}, {})).toThrow();
		},
	);

	test("no async function is exported", () => {
		for (const value of Object.values(sqlite)) {
			if (typeof value === "function") {
				expect(value.constructor.name).not.toBe("AsyncFunction");
			}
		}
	});
});
