/** fixtures/recall（Recall）を実 SQLite で実行する。LIKE と FTS の結果同値を各検索で照合する。 */
import { sliceUtf8Range } from "../../src/evidence/range.ts";
import { searchRecordsWithStrategy } from "../../src/store/recall.ts";
import { describeRecallFixtures } from "../runners/recall.ts";

describeRecallFixtures({
	sliceUtf8Range,
	searchWithStrategy: searchRecordsWithStrategy,
});
