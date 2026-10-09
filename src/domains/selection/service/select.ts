import { MemoryContractError } from "../../../contracts/errors.ts";
import { canonicalJson } from "../../../canonical/json.ts";
import { compareCodeUnits } from "../../../canonical/compare.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { utf8ByteLength } from "../../../canonical/utf8.ts";
import {
	TemporalError,
	answersQuery,
	classifyValidity,
	evaluateTime,
	periodBoundsMs,
} from "../../temporal/index.ts";
import { REQUIRED_REASONS, SCOPE_KINDS } from "../contracts/index.ts";
import type {
	ActiveContext,
	OmitReason,
	OmittedItem,
	RetrievalFlag,
	ScopeGrant,
	ScopeKind,
	SelectedItem,
	SelectionCandidate,
	SelectionCoverage,
	SelectionInput,
	SelectionResult,
	UnresolvedConflict,
} from "../contracts/index.ts";

/** 数値が大きいほど具体的（矛盾の優先と追加集合の順位に使う）。 */
const SPECIFICITY: Readonly<Record<ScopeKind, number>> = {
	user_common: 0,
	project: 1,
	topic: 2,
	task: 3,
	request: 4,
};

export function requiredDigestOf(
	items: readonly { readonly id: string; readonly revision: string }[],
): string {
	const sorted = [...items]
		.map((item) => [item.id, item.revision] as const)
		.sort((a, b) => compareCodeUnits(a[0], b[0]));
	return sha256Hex(canonicalJson(sorted));
}

function toSelected(candidate: SelectionCandidate): SelectedItem {
	return {
		id: candidate.id,
		revision: candidate.revision,
		scopeKey: candidate.scopeKey,
		bytes: utf8ByteLength(candidate.text),
		...(candidate.requiredReason === undefined
			? {}
			: { requiredReason: candidate.requiredReason }),
	};
}

function scopeApplies(grant: ScopeGrant, context: ActiveContext): boolean {
	switch (grant.kind) {
		case "user_common":
			return true;
		case "project":
			return grant.scopeKey === context.projectScopeKey;
		case "task":
			return grant.scopeKey === context.taskScopeKey;
		case "topic":
			return grant.scopeKey === context.topicScopeKey;
		case "request":
			return true; // 個々の候補の requestId で絞る。
	}
}

function rank(
	a: SelectionCandidate,
	b: SelectionCandidate,
	spec: ReadonlyMap<string, number>,
): number {
	// 明示参照 → scope の具体性 → 語句一致 → 対象一致 → ID。時間の適合は適用条件の段階で済ませているので順位には使わない。
	if (a.signals.explicitRef !== b.signals.explicitRef)
		return a.signals.explicitRef ? -1 : 1;
	const sa = spec.get(a.scopeKey) ?? 0;
	const sb = spec.get(b.scopeKey) ?? 0;
	if (sa !== sb) return sb - sa;
	if (a.signals.termMatches !== b.signals.termMatches)
		return b.signals.termMatches - a.signals.termMatches;
	if (a.signals.subjectMatch !== b.signals.subjectMatch)
		return a.signals.subjectMatch ? -1 : 1;
	return compareCodeUnits(a.id, b.id);
}

function flagsOf(
	input: SelectionInput,
	selected: readonly SelectionCandidate[],
): RetrievalFlag[] {
	const flags: RetrievalFlag[] = [];
	const { retrieval } = input;
	if (selected.length === 0) flags.push("not_found_in_searched_scopes");
	if (retrieval.truncated) flags.push("search_truncated");
	if (selected.some((candidate) => candidate.stale === true))
		flags.push("evidence_stale");
	if (retrieval.pendingCorrections > 0) flags.push("correction_pending");
	if (retrieval.headSeq > retrieval.processedSeq) flags.push("raw_unprocessed");
	return flags;
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** 数値はすべてここで検査する。壊れた入力は「見つからなかった」ではなく例外にする。 */
function assertSelectionInput(input: SelectionInput): void {
	const numbers: [string, unknown][] = [
		["maxBytes", input.maxBytes],
		["maxOptionalItems", input.maxOptionalItems],
		["retrieval.processedSeq", input.retrieval.processedSeq],
		["retrieval.headSeq", input.retrieval.headSeq],
		["retrieval.pendingCorrections", input.retrieval.pendingCorrections],
		["query.atMs", input.query.atMs],
	];
	for (const [path, value] of numbers) {
		if (!isCount(value)) throw new MemoryContractError("INVALID_INTEGER", path);
	}
	if (input.query.mode === "at" && !Number.isSafeInteger(input.query.targetMs))
		throw new MemoryContractError("INVALID_INTEGER", "query.targetMs");
	if (input.query.mode !== "current" && input.query.mode !== "at")
		throw new MemoryContractError("INVALID_ENUM", "query.mode");
	const kinds: readonly string[] = SCOPE_KINDS;
	const grantKeys = new Set<string>();
	for (const [i, grant] of input.grants.entries()) {
		if (!kinds.includes(grant.kind))
			throw new MemoryContractError("INVALID_ENUM", `grants[${i}].kind`);
		// 同じ scope に 2 つの認可があると、適用が順序に依存し、利用根拠も曖昧になる。
		if (grantKeys.has(grant.scopeKey))
			throw new MemoryContractError(
				"DUPLICATE_SCOPE_KEY",
				`grants[${i}].scopeKey`,
			);
		grantKeys.add(grant.scopeKey);
	}
	const reasons: readonly string[] = REQUIRED_REASONS;
	const seen = new Set<string>();
	for (const [i, c] of input.candidates.entries()) {
		if (seen.has(c.id))
			throw new MemoryContractError("DUPLICATE_ITEM_ID", `candidates[${i}].id`);
		seen.add(c.id);
		if (c.requiredReason !== undefined && !reasons.includes(c.requiredReason))
			throw new MemoryContractError(
				"INVALID_ENUM",
				`candidates[${i}].requiredReason`,
			);
		if (c.duration !== "ongoing" && c.duration !== "this_request")
			throw new MemoryContractError(
				"INVALID_ENUM",
				`candidates[${i}].duration`,
			);
		if (
			c.period === null ||
			(c.period !== undefined && typeof c.period !== "object")
		)
			throw new MemoryContractError("INVALID_TYPE", `candidates[${i}].period`);
		for (const edge of ["from", "until"] as const) {
			const date: unknown = c.period?.[edge];
			if (date !== undefined && (date === null || typeof date !== "object"))
				throw new MemoryContractError(
					"INVALID_TYPE",
					`candidates[${i}].period.${edge}`,
				);
		}
		if (typeof c.signals !== "object" || c.signals === null)
			throw new MemoryContractError("INVALID_TYPE", `candidates[${i}].signals`);
		if (!isCount(c.recordedAtMs))
			throw new MemoryContractError(
				"INVALID_INTEGER",
				`candidates[${i}].recordedAtMs`,
			);
		if (!isCount(c.signals.termMatches))
			throw new MemoryContractError(
				"INVALID_INTEGER",
				`candidates[${i}].signals.termMatches`,
			);
	}
}

/**
 * 適用条件を先に検査し（認可 → scope 適用 → 今回/今後 → 時間）、必須集合を確定してから、残りの予算で追加集合を順位付けする。
 * 必須の矛盾は、今回の依頼で本人が述べた指示（`explicit`）が優先し、次に明示された例外（`exception`）が、より一般の制約に対して
 * 優先する。scope が具体的だというだけでは上書きしない。解けなければ `hold`。
 */
export function selectContext(input: SelectionInput): SelectionResult {
	assertSelectionInput(input);
	const grantByScope = new Map(input.grants.map((g) => [g.scopeKey, g]));
	const omitted: OmittedItem[] = [];
	const omit = (id: string, reason: OmitReason) => omitted.push({ id, reason });
	let unauthorizedCandidates = 0;
	const invalidRequired: string[] = [];

	const applicable: SelectionCandidate[] = [];
	for (const candidate of [...input.candidates].sort((a, b) =>
		compareCodeUnits(a.id, b.id),
	)) {
		const grant = grantByScope.get(candidate.scopeKey);
		if (grant === undefined) {
			unauthorizedCandidates += 1;
			omit(candidate.id, "SCOPE_NOT_AUTHORIZED");
			continue;
		}
		if (!scopeApplies(grant, input.context)) {
			omit(candidate.id, "SCOPE_NOT_ACTIVE");
			continue;
		}
		if (
			(candidate.duration === "this_request" || grant.kind === "request") &&
			candidate.requestId !== input.context.requestId
		) {
			omit(candidate.id, "NOT_THIS_REQUEST");
			continue;
		}
		const timed = {
			recordedAtMs: candidate.recordedAtMs,
			...(candidate.period === undefined ? {} : { period: candidate.period }),
		};
		let answers: boolean;
		let recordedAfterTarget = false;
		try {
			answers = answersQuery(
				timed,
				input.query,
				// 期間の無い必須の制約・禁止は、過去の照会でも黙って落とさない（当時すでに記録されていたものに限る）。
				{ includeUnknownInAt: candidate.requiredReason !== undefined },
			);
			if (!answers)
				recordedAfterTarget = evaluateTime(
					timed,
					input.query,
				).recordedAfterTarget;
		} catch (error) {
			if (!(error instanceof TemporalError)) throw error;
			// 不正な期間は黙って通さない: 追加集合は除外、必須集合は解決不能（hold）。
			omit(candidate.id, "INVALID_PERIOD");
			if (candidate.requiredReason !== undefined)
				invalidRequired.push(candidate.id);
			continue;
		}
		if (!answers) {
			omit(
				candidate.id,
				recordedAfterTarget ? "NOT_KNOWN_AT_TARGET" : "NOT_CURRENT",
			);
			continue;
		}
		applicable.push(candidate);
	}

	const specificity = new Map<string, number>();
	for (const grant of input.grants)
		specificity.set(grant.scopeKey, SPECIFICITY[grant.kind]);

	// 必須集合の矛盾解決。
	const requiredAll = applicable.filter((c) => c.requiredReason !== undefined);
	const optionalAll = applicable.filter((c) => c.requiredReason === undefined);
	const unresolved: UnresolvedConflict[] = [];
	const required: SelectionCandidate[] = [];
	const groups = new Map<string, SelectionCandidate[]>();
	for (const candidate of requiredAll) {
		if (candidate.conflictKey === undefined) {
			required.push(candidate);
			continue;
		}
		const group = groups.get(candidate.conflictKey) ?? [];
		group.push(candidate);
		groups.set(candidate.conflictKey, group);
	}
	const spec = (c: SelectionCandidate): number =>
		specificity.get(c.scopeKey) ?? 0;
	const thisRequestExplicit = (c: SelectionCandidate): boolean =>
		c.explicit === true;
	/** a が b を上書きできるか。今回の依頼で述べた明示指示（今回限り・今後のどちらでも）、または明示された例外（同じ範囲か、より一般の制約に対して）。範囲が具体的だというだけでは上書きしない。 */
	const beats = (a: SelectionCandidate, b: SelectionCandidate): boolean => {
		if (thisRequestExplicit(a) !== thisRequestExplicit(b))
			return thisRequestExplicit(a);
		if (thisRequestExplicit(a)) return spec(a) > spec(b);
		if (a.exception === true && b.exception !== true) return spec(a) >= spec(b);
		if (a.exception === true && b.exception === true) return spec(a) > spec(b);
		return false;
	};
	for (const [key, group] of [...groups].sort((a, b) =>
		compareCodeUnits(a[0], b[0]),
	)) {
		const distinct = new Set(group.map((c) => c.valueKey ?? c.id));
		if (distinct.size === 1) {
			const [first, ...dupes] = group.sort((a, b) =>
				compareCodeUnits(a.id, b.id),
			);
			required.push(first as SelectionCandidate);
			for (const dupe of dupes) omit(dupe.id, "DUPLICATE");
			continue;
		}
		const winners = group.filter(
			(c) => !group.some((other) => other !== c && beats(other, c)),
		);
		const winnerValues = new Set(winners.map((c) => c.valueKey ?? c.id));
		if (winnerValues.size !== 1) {
			unresolved.push({
				conflictKey: key,
				ids: group.map((c) => c.id).sort(compareCodeUnits),
			});
			continue;
		}
		const sorted = winners.sort((a, b) => compareCodeUnits(a.id, b.id));
		required.push(sorted[0] as SelectionCandidate);
		for (const dupe of sorted.slice(1)) omit(dupe.id, "DUPLICATE");
		for (const loser of group.filter((c) => !winners.includes(c)))
			omit(loser.id, "SUPERSEDED_BY_CONFLICT");
	}

	const coverage = (
		selected: readonly SelectionCandidate[],
		found: readonly SelectionCandidate[] = selected,
	): SelectionCoverage => ({
		searchedScopeKeys: [...input.retrieval.searchedScopeKeys].sort(
			compareCodeUnits,
		),
		selectedCount: selected.length,
		omitted: [...omitted].sort(
			(a, b) =>
				compareCodeUnits(a.id, b.id) || compareCodeUnits(a.reason, b.reason),
		),
		unresolved,
		flags: flagsOf(input, found),
		unauthorizedCandidates,
	});

	for (const id of invalidRequired.sort(compareCodeUnits))
		unresolved.push({ conflictKey: `invalid_period:${id}`, ids: [id] });
	if (unresolved.length > 0)
		return { status: "hold", coverage: coverage(required, applicable) };

	required.sort((a, b) => compareCodeUnits(a.id, b.id));
	const requiredBytes = required.reduce(
		(n, c) => n + utf8ByteLength(c.text),
		0,
	);
	if (requiredBytes > input.maxBytes) {
		const withoutTail = required
			.filter((c) => c.requiredReason !== "recent_turn")
			.reduce((n, c) => n + utf8ByteLength(c.text), 0);
		const fitsEach = required.every(
			(c) => utf8ByteLength(c.text) <= input.maxBytes,
		);
		const action =
			withoutTail <= input.maxBytes && withoutTail < requiredBytes
				? "replan"
				: required.length >= 2 && fitsEach
					? "split"
					: "hold";
		return {
			status: "required_overflow",
			action,
			requiredBytes,
			coverage: coverage(required),
		};
	}

	let used = requiredBytes;
	const optional: SelectionCandidate[] = [];
	const ranked = optionalAll.sort((a, b) => rank(a, b, specificity));
	for (const candidate of ranked) {
		const bytes = utf8ByteLength(candidate.text);
		if (optional.length >= input.maxOptionalItems) {
			omit(candidate.id, "ITEM_LIMIT");
		} else if (used + bytes > input.maxBytes) {
			omit(candidate.id, "BUDGET");
		} else {
			optional.push(candidate);
			used += bytes;
		}
	}

	const selected = [...required, ...optional];
	const usedScopes = new Set(selected.map((c) => c.scopeKey));
	return {
		status: "ready",
		required: required.map((c) => toSelected(c)),
		optional: optional.map((c) => toSelected(c)),
		usedBytes: used,
		coverage: coverage(selected),
		usage: {
			principal: input.principal,
			policyRevision: input.policyRevision,
			selectionPolicyRevision: input.selectionPolicyRevision,
			grants: input.grants
				.filter((g) => usedScopes.has(g.scopeKey))
				.sort((a, b) => compareCodeUnits(a.scopeKey, b.scopeKey)),
			items: selected
				.map((c) => ({
					id: c.id,
					revision: c.revision,
					// 現在の照会で「現在有効」と判定した期間の終わりだけ（時点不明の期間は期限として扱わない）。
					expiresAtMs:
						input.query.mode === "current" &&
						c.period !== undefined &&
						classifyValidity(c.period, input.query.atMs) === "current"
							? periodBoundsMs(c.period).endMs
							: null,
				}))
				.sort((a, b) => compareCodeUnits(a.id, b.id)),
			requiredDigest: requiredDigestOf(required),
			processedSeq: input.retrieval.processedSeq,
		},
	};
}
