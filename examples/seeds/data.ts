import { readFileSync } from "node:fs";
import { STATE_KINDS, type StateKind } from "eumenes-memory";

export const DEFAULT_SEED_PATH = new URL(
	"./data/codex-user-50.jsonl",
	import.meta.url,
);

export interface MemorySeed {
	schema_version: 1;
	id: string;
	status: "candidate";
	category: string;
	subject: "self";
	semantic_key: string;
	memory: string;
	scope: string;
	evidence_basis: "explicit" | "inferred";
	confidence: "high" | "medium";
	proposed_target: "state" | "host_procedure" | "continuity";
	proposed_state_kind: StateKind | null;
	proposed_state_origin: "agent_inferred" | null;
	use_when: string;
	limitations: string;
	review: { after_days: number; on: string };
	evidence: {
		evidence_id: string;
		thread_id: string;
		message_id: string;
		timestamp: string;
		speaker: "user";
		source_path: string;
		source_line: number;
		source_text_sha256: string;
		range_utf8: { start: number; end: number };
		quote: string;
	}[];
}

const object = (value: unknown): Record<string, unknown> => {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw Error("Expected seed object");
	return value as Record<string, unknown>;
};
const text = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Validate the file contract only. Targets and meanings were chosen during extraction. */
export function parseSeedData(content: string): readonly MemorySeed[] {
	const ids = new Set<string>();
	const keys = new Set<string>();
	const seeds: MemorySeed[] = [];
	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			const seed = object(JSON.parse(line));
			if (
				seed["schema_version"] !== 1 ||
				seed["status"] !== "candidate" ||
				seed["subject"] !== "self" ||
				![
					"id",
					"category",
					"semantic_key",
					"memory",
					"scope",
					"use_when",
					"limitations",
				].every((key) => text(seed[key])) ||
				!["explicit", "inferred"].includes(String(seed["evidence_basis"])) ||
				!["high", "medium"].includes(String(seed["confidence"])) ||
				!["state", "host_procedure", "continuity"].includes(
					String(seed["proposed_target"]),
				)
			)
				throw Error("Invalid seed fields");
			if (
				seed["proposed_target"] === "state"
					? seed["proposed_state_origin"] !== "agent_inferred" ||
						!STATE_KINDS.some((kind) => kind === seed["proposed_state_kind"])
					: seed["proposed_state_origin"] !== null ||
						seed["proposed_state_kind"] !== null
			)
				throw Error("Invalid seed target/origin");
			const review = object(seed["review"]);
			if (!integer(review["after_days"]) || !text(review["on"]))
				throw Error("Invalid seed review");
			const evidence = seed["evidence"];
			if (!Array.isArray(evidence) || evidence.length === 0)
				throw Error("Missing seed evidence");
			for (const value of evidence) {
				const ref = object(value);
				const range = object(ref["range_utf8"]);
				if (
					![
						"evidence_id",
						"thread_id",
						"message_id",
						"timestamp",
						"source_path",
						"quote",
					].every((key) => text(ref[key])) ||
					ref["speaker"] !== "user" ||
					!integer(ref["source_line"]) ||
					ref["source_line"] === 0 ||
					typeof ref["source_text_sha256"] !== "string" ||
					!/^[a-f0-9]{64}$/.test(ref["source_text_sha256"]) ||
					!integer(range["start"]) ||
					!integer(range["end"]) ||
					range["end"] - range["start"] !==
						Buffer.byteLength(String(ref["quote"]))
				)
					throw Error("Invalid seed evidence reference");
			}
			const typed = seed as unknown as MemorySeed;
			if (ids.has(typed.id) || keys.has(typed.semantic_key))
				throw Error("Duplicate seed identity");
			ids.add(typed.id);
			keys.add(typed.semantic_key);
			seeds.push(typed);
		} catch (error) {
			throw Error(`Invalid seed line ${index + 1}: ${String(error)}`);
		}
	}
	if (seeds.length === 0) throw Error("Empty seed dataset");
	return seeds;
}

export function loadSeedData(path: string | URL = DEFAULT_SEED_PATH) {
	return parseSeedData(readFileSync(path, "utf8"));
}

export function seedSummary(seeds: readonly MemorySeed[]) {
	return {
		total: seeds.length,
		state: seeds.filter((seed) => seed.proposed_target === "state").length,
		host_procedure: seeds.filter(
			(seed) => seed.proposed_target === "host_procedure",
		).length,
		continuity: seeds.filter((seed) => seed.proposed_target === "continuity")
			.length,
	};
}
