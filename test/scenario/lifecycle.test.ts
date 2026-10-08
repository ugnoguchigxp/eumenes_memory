/** fixtures/lifecycle（ジャーナル entry の hash 鎖、閉包計算）を純粋関数に対して実行する。 */
import { computeClosure } from "../../src/lifecycle/closure.ts";
import {
	buildJournalEntry,
	verifyForgetJournal,
} from "../../src/lifecycle/journal.ts";
import { describeLifecycleFixtures } from "../runners/lifecycle.ts";

describeLifecycleFixtures({
	buildJournalEntry: (args) => buildJournalEntry(args as never),
	verifyForgetJournal: (entries) => verifyForgetJournal(entries as never),
	computeClosure: (edges, starts) =>
		computeClosure(edges as never, starts as never),
});
