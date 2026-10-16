import { createHash } from "node:crypto";
import type { StateSubject } from "eumenes-memory";
import type { Complete } from "./protocol.ts";
import { modelItems, type ModelItem } from "./model-input.ts";
import type { StandaloneHost } from "./host.ts";
import {
	evidenceInstructions,
	evidenceSchema,
	parseEvidence,
} from "./support.ts";

export const groundingInstructions = `${evidenceInstructions}
Judge the supplied candidates jointly, not independently. Resolve every requested owner, relation,
condition and time from this combined evidence. A place or attribute without evidence linking it
to the requested entity is insufficient. Cite all facts needed for that link, including intermediate
relations. Reject a candidate that joint evidence shows belongs to a different entity. Unknown
means not established by this evidence, never proof that the entire memory contains no such fact.`;
/** Supply the entire authorized snapshot once. Provider limits/failures are surfaced, never truncated. */
export async function recallSnapshot(
	input: readonly ModelItem[],
	message: string,
	complete: Complete,
) {
	const items = structuredClone(input);
	const ids = items.map((x) => x.itemId);
	if (new Set(ids).size !== ids.length) throw Error("Duplicate snapshot IDs");
	const response = await complete(
		JSON.stringify({ message, items }),
		evidenceSchema,
		"recall",
	);
	const parts = parseEvidence(response.raw, ids);
	if (parts.length === 0) throw Error("Missing requested parts");
	return {
		snapshotHash: createHash("sha256")
			.update(JSON.stringify(items))
			.digest("hex"),
		coverage: { complete: true, itemCount: items.length },
		parts,
	};
}
export function recallMemory(
	host: StandaloneHost,
	message: string,
	complete: Complete,
	options?: { subjects?: readonly { id: StateSubject; label: string }[] },
) {
	return recallSnapshot(
		modelItems(host.list(), options?.subjects),
		message,
		complete,
	);
}
