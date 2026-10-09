/** fixtures/evidence（Records）を実 SQLite で実行する。登録は親が test/fixtures.test.ts へ行う。 */
import { sliceUtf8Range } from "../../src/domains/records/index.ts";
import { searchRecordsWithStrategy } from "../../src/domains/recall/sqlite.ts";
import { describeRecordsFixtures } from "../runners/records.ts";

describeRecordsFixtures({
	sliceUtf8Range,
	searchWithStrategy: searchRecordsWithStrategy,
});
