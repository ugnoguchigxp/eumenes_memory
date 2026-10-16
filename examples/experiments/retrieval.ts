import { CONTRACT_VERSIONS } from "eumenes-memory";
import type { AccessContext, StateItem } from "eumenes-memory";
import { listState } from "eumenes-memory/sqlite";
import type { MemoryDb } from "eumenes-memory/sqlite";
import type { ModelItem } from "../standalone/model-input.ts";
import type { Complete } from "./frozen-protocol.ts";
import { parseRecall } from "./frozen-protocol.ts";
import { Experiment, variants } from "./experiment.ts";

export const retrievalInstructions = {
	...variants.v10.instructions,
	recall: variants.v10.instructions.recall.replace(
		"The supplied items are the complete authorized active snapshot.",
		"The supplied items are an authorized candidate set, possibly only one page. Other memory may exist outside it; select answer-supporting IDs only within this supplied set.",
	),
};

/** The caller holds one read transaction over this entire enumeration. No internal-table reads. */
export function allState(
	db: MemoryDb,
	access: AccessContext,
	scopeKey: string,
	pageSize = 250,
): StateItem[] {
	const items: StateItem[] = [];
	let after: { updatedSeq: number; itemId: string } | undefined;
	do {
		const page = listState(db, {
			contractVersion: CONTRACT_VERSIONS.state,
			access,
			scopeKey,
			limit: pageSize,
			...(after ? { after } : {}),
		});
		if (page.status !== "ok") throw Error(`listState: ${page.status}`);
		items.push(...page.items);
		after = page.nextCursor;
	} while (after !== undefined);
	return items;
}
/** Exhaustive bounded-context selection; semantics remain with the LLM. No lexical rules or index. */
export async function scanRecall(
	exp: Experiment,
	complete: Complete,
	id: string,
	message: string,
	items: ModelItem[],
	pageSize = 250,
): Promise<string[]> {
	const selected: string[] = [];
	for (let offset = 0; offset < items.length; offset += pageSize) {
		const page = items.slice(offset, offset + pageSize);
		const raw = await exp.call(
			complete,
			"v10-page-scan",
			retrievalInstructions,
			`${id}/page-${offset / pageSize}`,
			{ task: "recall", message, items: page },
			variants.v10.recallSchema,
			"recall",
		);
		const ids = parseRecall(raw);
		if (ids.some((x) => !page.some((y) => y.itemId === x)))
			throw Error("Out-of-page ID");
		selected.push(...ids);
	}
	return selected;
}
