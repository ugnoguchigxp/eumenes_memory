import { MemoryContractError } from "../../../contracts/errors.ts";
import { canonicalJson } from "../../../canonical/json.ts";
import { compareCodeUnits } from "../../../canonical/compare.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import type {
	Checkpoint,
	LedgerChange,
	PublicVersion,
	PublicationDecision,
	PublicationInput,
} from "../contracts/index.ts";

/** 公開版を作る。manifest は ID の順に整列し、同じ内容は同じ versionId になる（原文の追記で作り直さない）。 */
export function buildPublicVersion(input: {
	readonly manifest: readonly {
		readonly itemId: string;
		readonly revision: string;
	}[];
	readonly policyRevision: string;
	readonly publishedSeq: number;
}): PublicVersion {
	if (!Number.isSafeInteger(input.publishedSeq) || input.publishedSeq < 0)
		throw new MemoryContractError("INVALID_INTEGER", "publishedSeq");
	const manifest = [...input.manifest].sort((a, b) =>
		compareCodeUnits(a.itemId, b.itemId),
	);
	for (let i = 1; i < manifest.length; i++) {
		// 同じ項目が複数の版で載る manifest は、何を公開したのか決まらない。
		if (manifest[i]?.itemId === manifest[i - 1]?.itemId)
			throw new MemoryContractError("DUPLICATE_ITEM_ID", `manifest[${i}]`);
	}
	const versionId = `pv:${sha256Hex(
		canonicalJson([
			manifest.map((m) => [m.itemId, m.revision]),
			input.policyRevision,
		]),
	)}`;
	return {
		versionId,
		manifest,
		policyRevision: input.policyRevision,
		publishedSeq: input.publishedSeq,
	};
}

const IMMEDIATE_KINDS: ReadonlySet<LedgerChange["kind"]> = new Set([
	"negate",
	"retract",
	"forget",
	"auth_change",
]);

/**
 * 公開の安定性より、訂正・否定・忘却・認可変更を優先する。肯定的な追加は閾値か区切りまで待てる。
 * 公開済みの版より新しい変更（seq）だけを見る。
 */
export function decidePublication(
	input: PublicationInput,
): PublicationDecision {
	if (
		!Number.isSafeInteger(input.additionThreshold) ||
		input.additionThreshold < 1
	)
		throw new MemoryContractError("INVALID_INTEGER", "additionThreshold");
	for (const [i, change] of input.changes.entries()) {
		if (!Number.isSafeInteger(change.seq) || change.seq < 0)
			throw new MemoryContractError("INVALID_INTEGER", `changes[${i}].seq`);
	}
	const current = input.current;
	if (current === null)
		return { action: "publish", immediate: false, reasons: ["NO_VERSION"] };
	const fresh = input.changes.filter((c) => c.seq > current.publishedSeq);
	const reasons: Extract<
		PublicationDecision,
		{ action: "publish" }
	>["reasons"][number][] = [];
	if (input.policyRevision !== current.policyRevision)
		reasons.push("POLICY_CHANGED");
	const published = new Map(
		current.manifest.map((m) => [m.itemId, m.revision]),
	);
	// 公開済みの項目の否定・撤回・版の変更は訂正として待たせない。
	if (
		fresh.some(
			(c) =>
				c.kind === "negate" ||
				c.kind === "retract" ||
				(published.has(c.itemId) && published.get(c.itemId) !== c.revision),
		)
	)
		reasons.push("CORRECTION");
	if (fresh.some((c) => c.kind === "forget")) reasons.push("FORGET");
	if (fresh.some((c) => c.kind === "auth_change")) reasons.push("AUTH_CHANGE");
	if (reasons.length > 0)
		return { action: "publish", immediate: true, reasons };
	// 同じ項目への複数の変更は 1 件として数える。
	const additions = new Set(
		fresh.filter((c) => !IMMEDIATE_KINDS.has(c.kind)).map((c) => c.itemId),
	).size;
	if (additions === 0) return { action: "keep", pendingAdditions: 0 };
	if (input.boundary)
		return { action: "publish", immediate: false, reasons: ["BOUNDARY"] };
	if (additions >= input.additionThreshold)
		return {
			action: "publish",
			immediate: false,
			reasons: ["ADDITION_THRESHOLD"],
		};
	return { action: "keep", pendingAdditions: additions };
}

export type CheckpointProblem =
	| "MODEL_SUMMARY_WITHOUT_RANGES"
	| "BAD_RANGE"
	| "LOST_UNRESOLVED"
	| "LOST_DECISION"
	| "BOUNDARY_REGRESSED"
	| "TOPIC_MISMATCH"
	| "BAD_ORIGIN";

/**
 * 継続情報の検査。モデル要約は原典範囲が必須。更新後は未解決事項・決定を失わず（解決・撤回は `resolved` で明示）、
 * 処理境界を戻さない。
 */
export function validateCheckpoint(
	next: Checkpoint,
	previous: Checkpoint | null,
	resolved: readonly string[] = [],
): CheckpointProblem[] {
	const problems: CheckpointProblem[] = [];
	const validSeq = (n: number) => Number.isSafeInteger(n) && n >= 0;
	if (next.origin !== "deterministic" && next.origin !== "model_summary")
		problems.push("BAD_ORIGIN");
	if (previous !== null && !validSeq(previous.processedSeq))
		problems.push("BAD_RANGE");
	if (!validSeq(next.processedSeq)) problems.push("BAD_RANGE");
	if (next.origin === "model_summary" && next.ranges.length === 0)
		problems.push("MODEL_SUMMARY_WITHOUT_RANGES");
	if (
		next.ranges.some(
			(r) =>
				!validSeq(r.startSeq) ||
				!validSeq(r.endSeq) ||
				r.startSeq > r.endSeq ||
				r.endSeq > next.processedSeq,
		)
	)
		problems.push("BAD_RANGE");
	if (previous !== null) {
		if (previous.topicId !== next.topicId) problems.push("TOPIC_MISMATCH");
		const done = new Set(resolved);
		if (
			previous.unresolved.some(
				(u) => !done.has(u) && !next.unresolved.includes(u),
			)
		)
			problems.push("LOST_UNRESOLVED");
		if (
			previous.decisions.some(
				(d) => !done.has(d) && !next.decisions.includes(d),
			)
		)
			problems.push("LOST_DECISION");
		if (
			validSeq(next.processedSeq) &&
			next.processedSeq < previous.processedSeq
		)
			problems.push("BOUNDARY_REGRESSED");
	}
	return problems;
}
