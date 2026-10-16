// Frozen v9/v10 response contracts. Keep independent of evolving standalone prompts.
import { POLARITIES, STATE_KINDS } from "eumenes-memory";
import type { Polarity, StateKind, StateSubject } from "eumenes-memory";

export type ModelTask = "decide" | "recall" | "judge";

export function parseJudgment(raw: string): {
	passed: boolean;
	reason: string;
} {
	const root = record(JSON.parse(raw));
	keys(root, ["passed", "reason"]);
	if (typeof root["passed"] !== "boolean" || typeof root["reason"] !== "string")
		throw new Error("Invalid judgment");
	return { passed: root["passed"], reason: root["reason"] };
}

export interface RememberAction {
	type: "remember";
	kind: StateKind;
	subject: StateSubject;
	semanticKey: string;
	value: { text: string; polarity: Polarity };
	quote: string;
	replacesItemId: string | null;
}
export type Action = RememberAction | { type: "forget"; itemId: string };

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[]): void {
	if (Object.keys(value).sort().join(",") !== expected.sort().join(","))
		throw new Error("Unexpected output fields");
}

export function parseDecision(raw: string): {
	actions: Action[];
	clarification: string | null;
} {
	const root = record(JSON.parse(raw));
	keys(root, ["actions", "clarification"]);
	if (
		root["clarification"] !== null &&
		typeof root["clarification"] !== "string"
	)
		throw new Error("Invalid clarification");
	if (!Array.isArray(root["actions"]) || root["actions"].length > 8)
		throw new Error("Invalid actions array");
	const actions: Action[] = root["actions"].map((input: unknown) => {
		const action = record(input);
		if (action["type"] === "forget") {
			keys(action, ["type", "itemId"]);
			if (typeof action["itemId"] !== "string")
				throw new Error("Invalid forget target");
			return { type: "forget", itemId: action["itemId"] };
		}
		keys(action, [
			"type",
			"kind",
			"subject",
			"semanticKey",
			"value",
			"quote",
			"replacesItemId",
		]);
		const value = record(action["value"]);
		keys(value, ["text", "polarity"]);
		if (
			action["type"] !== "remember" ||
			!STATE_KINDS.some((kind) => kind === action["kind"]) ||
			typeof action["subject"] !== "string" ||
			!(
				action["subject"] === "self" || action["subject"].startsWith("other:")
			) ||
			typeof action["semanticKey"] !== "string" ||
			typeof action["quote"] !== "string" ||
			!(
				action["replacesItemId"] === null ||
				typeof action["replacesItemId"] === "string"
			) ||
			typeof value["text"] !== "string" ||
			!POLARITIES.some((polarity) => polarity === value["polarity"])
		)
			throw new Error("Invalid remember action");
		return action as unknown as RememberAction;
	});
	return { actions, clarification: root["clarification"] };
}

export function parseActions(raw: string): Action[] {
	return parseDecision(raw).actions;
}

export function parseRecall(raw: string): string[] {
	const root = record(JSON.parse(raw));
	keys(root, ["itemIds"]);
	const ids = root["itemIds"];
	if (
		!Array.isArray(ids) ||
		!ids.every((id) => typeof id === "string") ||
		new Set(ids).size !== ids.length
	)
		throw new Error("Invalid recall IDs");
	return ids;
}

export interface ModelResult {
	raw: string;
	threadId: string | null;
	usage: { input_tokens: number; output_tokens: number } | null;
}
export type Complete = (
	prompt: string,
	schema: unknown,
	task: ModelTask,
) => Promise<ModelResult>;
