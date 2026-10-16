import { createHash } from "node:crypto";
import type { StateSubject } from "eumenes-memory";
import type { ModelItem } from "./model-input.ts";
import { modelItems } from "./model-input.ts";
import {
	decisionOutputSchema,
	instructionsFor,
	parseDecision,
} from "./protocol.ts";
import type { Action, Complete } from "./protocol.ts";
import type { StandaloneHost } from "./host.ts";

export const relations = [
	"new",
	"same",
	"supersedes",
	"coexists",
	"conflicts",
	"forget",
] as const;
export type Relation = (typeof relations)[number];
export const planningInstructions = `${instructionsFor("decide")}
Return decision, relations and groups. Give a relations entry for every proposed action, using its zero-based actionIndex.
Groups are arrays of action indexes. Include each action exactly once. Put mutually dependent
changes in one group, and independent changes in separate groups. Remember-only groups are atomic;
forget-only groups are resumable durable deletion intents. A group mixing remember and forget is
unsupported. If such operations must succeed together, withhold those proposals and ask for
clarification rather than silently splitting a dependent change. Same/conflict proposals still
belong to a group even though they have no executable action. No actions means groups: [].
For each durable assertion identify its relation to existing memory before choosing a key:
new: no related existing assertion; same: the same proposition already exists; supersedes: an
explicit correction replaces that assertion; coexists: a distinct assertion must remain alongside
related facts; conflicts: incompatible claims with no justified correction or precedence.
For same and conflicts still propose a remember action so the relation can be recorded; the host
will withhold that action. Do not strengthen relatedness into identity. Different preferences,
owners, periods, conditions and exceptions may coexist. A new preference does not revoke others.
Use relatedItemIds to cite existing facts supporting this relation. For new use []; for same,
coexists or conflicts cite at least one existing fact. For supersedes cite exactly replacesItemId
and reuse that item's subject, kind and semanticKey. For same use replacesItemId:null. For new or
coexists choose a distinct state-oriented key not already active for that subject and kind.
Unresolved conflicts require clarification and no overwrite. Independent unambiguous changes may
proceed. For a forget action use relation forget and list ALL active facts matching the requested
meaning and scope, including equivalent facts under different keys, but exclude related facts
outside the request and explicit exceptions. Include the action's itemId in that list. Never infer
semantic equivalence from key spelling alone. Return no relations for absent actions.`;
export const snapshotHash = (items: readonly ModelItem[]) =>
	createHash("sha256")
		.update(
			JSON.stringify(
				[...items].sort((a, b) => a.itemId.localeCompare(b.itemId)),
			),
		)
		.digest("hex");
export function planningSchema(ids: readonly string[]) {
	return {
		type: "object",
		additionalProperties: false,
		required: ["decision", "relations", "groups"],
		properties: {
			decision: decisionOutputSchema(ids),
			groups: {
				type: "array",
				maxItems: 8,
				items: {
					type: "array",
					minItems: 1,
					maxItems: 8,
					items: { type: "integer", minimum: 0, maximum: 7 },
				},
			},
			relations: {
				type: "array",
				maxItems: 8,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["actionIndex", "relation", "relatedItemIds"],
					properties: {
						actionIndex: { type: "integer", minimum: 0, maximum: 7 },
						relation: { type: "string", enum: [...relations] },
						relatedItemIds: {
							type: "array",
							items: ids.length
								? { type: "string", enum: [...ids] }
								: { type: "string" },
							...(ids.length ? {} : { maxItems: 0 }),
						},
					},
				},
			},
		},
	};
}
export interface ResolvedChange {
	actionIndex: number;
	relation: Relation;
	relatedItemIds: string[];
	actions: Action[];
}
export interface MemoryPlan {
	snapshotHash: string;
	message: string;
	clarification: string | null;
	changes: ResolvedChange[];
	groups: number[][];
}
export function parsePlan(
	raw: string,
	items: readonly ModelItem[],
	message: string,
): MemoryPlan {
	const root = JSON.parse(raw);
	if (
		!root ||
		Object.keys(root).sort().join() !== "decision,groups,relations" ||
		!Array.isArray(root.relations)
	)
		throw Error("Invalid memory plan");
	const decision = parseDecision(JSON.stringify(root.decision));
	validateGroups(root.groups, decision.actions.length);
	if (root.relations.length !== decision.actions.length)
		throw Error("Missing action relations");
	const seen = new Set<number>();
	const scheduledForget = new Set<string>();
	const newKeys = new Set<string>();
	const changes: ResolvedChange[] = root.relations.map(
		(r: {
			actionIndex: number;
			relation: Relation;
			relatedItemIds: string[];
		}) => {
			if (
				!r ||
				Object.keys(r).sort().join() !==
					"actionIndex,relatedItemIds,relation" ||
				!Number.isSafeInteger(r.actionIndex) ||
				r.actionIndex < 0 ||
				r.actionIndex >= decision.actions.length ||
				seen.has(r.actionIndex) ||
				!relations.includes(r.relation) ||
				!Array.isArray(r.relatedItemIds) ||
				new Set(r.relatedItemIds).size !== r.relatedItemIds.length ||
				r.relatedItemIds.some(
					(id) => typeof id !== "string" || !items.some((x) => x.itemId === id),
				)
			)
				throw Error("Invalid action relation");
			seen.add(r.actionIndex);
			const action = decision.actions[r.actionIndex]!;
			const related = r.relatedItemIds.map((id) =>
				items.find((x) => x.itemId === id)!,
			);
			let actions: Action[] = [];
			if (action.type === "forget") {
				if (
					r.relation !== "forget" ||
					!r.relatedItemIds.includes(action.itemId)
				)
					throw Error("Invalid forget relation");
				actions = r.relatedItemIds
					.filter((id) => !scheduledForget.has(id))
					.map((id) => {
						scheduledForget.add(id);
						return { type: "forget", itemId: id };
					});
			} else {
				if (
					(action.subject !== "self" && action.kind !== "other_person_note") ||
					(action.subject === "self" && action.kind === "other_person_note")
				)
					throw Error("Subject/kind mismatch");
				if (
					r.relation === "forget" ||
					related.some((x) => x.subject !== action.subject)
				)
					throw Error("Invalid remember relation");
				if ((r.relation === "new") !== (related.length === 0))
					throw Error("Missing or unexpected related facts");
				if (r.relation === "supersedes") {
					if (
						related.length !== 1 ||
						action.replacesItemId !== related[0]!.itemId ||
						action.kind !== related[0]!.kind ||
						action.semanticKey !== related[0]!.semanticKey
					)
						throw Error("Invalid correction identity");
				} else if (action.replacesItemId !== null)
					throw Error("Unexpected replacement");
				if (
					r.relation === "same" &&
					related.some((x) => x.kind !== action.kind)
				)
					throw Error("Invalid same-fact identity");
				if (r.relation === "conflicts" && !decision.clarification?.trim())
					throw Error("Conflict requires clarification");
				if (r.relation === "new" || r.relation === "coexists") {
					const key = JSON.stringify([
						action.subject,
						action.kind,
						action.semanticKey,
					]);
					if (
						items.some(
							(x) =>
								x.subject === action.subject &&
								x.kind === action.kind &&
								x.semanticKey === action.semanticKey,
						) ||
						newKeys.has(key)
					)
						throw Error("Existing identity needs explicit resolution");
					newKeys.add(key);
				}
				if (!["same", "conflicts"].includes(r.relation)) actions = [action];
			}
			return { ...r, actions };
		},
	);
	return {
		snapshotHash: snapshotHash(items),
		message,
		clarification: decision.clarification,
		changes: changes.sort((a, b) => a.actionIndex - b.actionIndex),
		groups: root.groups,
	};
}
/** Semantic resolution is performed once by the LLM; this function does not mutate memory. */
export async function planMemory(
	host: StandaloneHost,
	message: string,
	complete: Complete,
	subjects: readonly { id: StateSubject; label: string }[] = [],
): Promise<MemoryPlan> {
	const stored = host.list();
	const items = modelItems(stored, subjects);
	const response = await complete(
		JSON.stringify({ task: "decide", message, items, subjects }),
		planningSchema(items.map((x) => x.itemId)),
		"decide",
	);
	// Labels are presentation metadata, not a dependency for applying the stored snapshot.
	return {
		...parsePlan(response.raw, items, message),
		snapshotHash: snapshotHash(modelItems(stored)),
	};
}

/** Structural grouping only; dependence itself is chosen by the LLM/caller. */
export function validateGroups(
	groups: unknown,
	count: number,
): asserts groups is number[][] {
	if (
		!Array.isArray(groups) ||
		groups.length > 8 ||
		groups.some(
			(g) =>
				!Array.isArray(g) ||
				g.length === 0 ||
				g.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= count),
		)
	)
		throw Error("Invalid operation groups");
	const indexes = groups.flat();
	if (indexes.length !== count || new Set(indexes).size !== count)
		throw Error("Incomplete or duplicate operation groups");
}
