/** fixtures/recall（Recall）を実 SQLite で実行する。LIKE と FTS の結果同値を各検索で照合する。 */
import { sliceUtf8Range } from "../../src/domains/records/index.ts";
import { searchRecordsWithStrategy } from "../../src/domains/recall/sqlite.ts";
import { describeRecallFixtures } from "../runners/recall.ts";

describeRecallFixtures({
	sliceUtf8Range,
	searchWithStrategy: searchRecordsWithStrategy,
});
