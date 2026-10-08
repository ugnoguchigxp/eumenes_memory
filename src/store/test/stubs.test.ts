import { describe, expect, test } from "bun:test";
import * as sqlite from "../../sqlite.ts";

/** 実装済みの公開関数。これら以外の関数は S0 時点では最終シグネチャの stub。 */
const IMPLEMENTED = new Set([
	"assertMemorySchema",
	"isMemoryStoreError",
	"listMemoryChanges",
]);

const STUBS = [
	"captureRecord",
	"readRecord",
	"readRecordRange",
	"recordSourceStates",
	"deactivateRecord",
	"reactivateRecord",
	"searchRecords",
	"assertUserState",
	"editState",
	"deactivateState",
	"reactivateState",
	"retractState",
	"listState",
	"readMemorySnapshotPart",
	"prepareExtraction",
	"settleExtraction",
	"listCandidates",
	"confirmCandidate",
	"planForget",
	"applyForget",
	"reconcileForgetJournal",
	"recordExternalDeletion",
	"getForgetReceipt",
	"registerExternalDependents",
	"unregisterExternalDependents",
] as const;

describe("./sqlite public surface", () => {
	test("export list is exactly the documented surface", () => {
		expect(Object.keys(sqlite).sort()).toEqual(
			[
				"MEMORY_DB_SCHEMA_VERSION",
				"MemoryStoreError",
				"STORE_ERROR_CODES",
				...IMPLEMENTED,
				...STUBS,
				"migrations",
			].sort(),
		);
	});

	test.each([...STUBS])(
		"%s throws on garbage input and never returns a success",
		(name) => {
			const fn = (
				sqlite as unknown as Record<string, (...args: unknown[]) => unknown>
			)[name];
			expect(typeof fn).toBe("function");
			// S0 の stub は NOT_IMPLEMENTED、実装後は入力検査の例外。どちらでも「成功を返さない」。
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
