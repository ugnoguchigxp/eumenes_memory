/** fixtures/evidence（Records と `sliceUtf8Range`）を実 SQLite で実行する。 */
import { sliceUtf8Range } from "../../src/domains/records/index.ts";
import { describeRecordsFixtures } from "../runners/records.ts";

describeRecordsFixtures({ sliceUtf8Range });
