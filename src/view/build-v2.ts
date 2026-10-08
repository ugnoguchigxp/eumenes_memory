import { deepFreeze } from "../canonical/freeze.ts";
import { LIMITS } from "../contracts/constants.ts";
import { ownValue } from "../contracts/own.ts";
import { parseBuildMemoryViewInputV2 } from "../contracts/parse-v2.ts";
import { readRecord } from "../contracts/reader.ts";
import type { RecallHit } from "../contracts/recall.ts";
import type {
	BlockedMemoryViewV2,
	BuildMemoryViewInputV2,
	DisabledMemoryViewV2,
	MemoryViewV2,
	OverflowMemoryViewV2,
	ViewCoverageV2,
	ViewEvidence,
} from "../contracts/view-v2.ts";
import { checkAccess } from "./access-check.ts";
import {
	composeHeaderV2,
	composeReadyBodyV2,
	eligibleItemsV2,
	evidenceEntryBytes,
} from "./compose-v2.ts";
import { checkItemsAndEvidence } from "./dependency-check.ts";
import { finalizeReadyViewV2 } from "./digest-v2.ts";
import { sourceKey } from "./source-ref.ts";

/**
 * snapshot の items / sources が parse の上限（`LIMITS.maxItems` / `maxSources`）を超えているとき、その配列を空にした
 * 入力を返す（超えていなければ null）。必須構成（active な item・その依存）が入り切らないのは予算超過と同じ扱いで、
 * parse の `ARRAY_TOO_LONG` 例外ではなく `overflow` で返すため。入力の形が不正（読めない）ときは null を返し、
 * 通常の parse に任せて例外にする。
 */
function trimOversizedSnapshot(input: unknown): unknown {
	try {
		const record = readRecord(input, "$");
		if (!Object.hasOwn(record, "snapshot")) return null;
		const snapshot = readRecord(record["snapshot"], "$.snapshot");
		const tooMany = (value: unknown, max: number): boolean =>
			Array.isArray(value) && value.length > max;
		const itemsOver = tooMany(snapshot["items"], LIMITS.maxItems);
		const sourcesOver = tooMany(snapshot["sources"], LIMITS.maxSources);
		if (!itemsOver && !sourcesOver) return null;
		return {
			...record,
			snapshot: {
				...snapshot,
				...(itemsOver ? { items: [] } : {}),
				...(sourcesOver ? { sources: [] } : {}),
			},
		};
	} catch {
		return null;
	}
}

/** 同じ出典・版・範囲の hit は先頭だけを残す（順序は検索の順位のまま）。 */
function dedupeHits(hits: readonly RecallHit[]): ViewEvidence[] {
	const seen = new Set<string>();
	const out: ViewEvidence[] = [];
	for (const hit of hits) {
		const range = ownValue(hit.ref, "range");
		const identity = JSON.stringify([
			sourceKey(hit.ref),
			hit.ref.revision,
			hit.ref.digest,
			range === undefined ? null : [range.startByte, range.endByte],
		]);
		if (seen.has(identity)) continue;
		seen.add(identity);
		out.push({
			ref: hit.ref,
			snippet: hit.snippet,
			authority: "evidence_candidate",
		});
	}
	return out;
}

/**
 * View v2 の build（full-system-design §3.4）。判定順: parse → disabled → access → 依存検査
 * （eligible item → evidence の出典）→ 必須構成の予算（超過は overflow）→ evidence の充填。
 * snapshot の items が `LIMITS.maxItems`、sources が `LIMITS.maxSources` を超えるときは（例外にせず）`overflow`
 * （`BUDGET_EXCEEDED`）。disabled / blocked の判定は先に行う。
 * evidence は検索順位の先頭から、evidence 予算（`maxEvidenceBytes`）と全体予算（`maxBytes`）に入る
 * 限りの先頭 prefix だけを載せ、残りは `coverage.omitted` に数える（必須超過とは別）。
 * 入力は変更せず、戻り値は新規構築の deep-frozen。DB は読まない。
 */
export function buildMemoryViewV2(input: BuildMemoryViewInputV2): MemoryViewV2 {
	const trimmed = trimOversizedSnapshot(input);
	const { access, snapshot, maxBytes, enabled, evidence } =
		parseBuildMemoryViewInputV2(trimmed ?? input);
	const header = composeHeaderV2(access, snapshot);

	if (!enabled) {
		const view: DisabledMemoryViewV2 = {
			...header,
			status: "disabled",
			reasonCode: "MEMORY_DISABLED",
		};
		return deepFreeze(view);
	}

	const accessReason = checkAccess(access, snapshot);
	if (accessReason !== null) {
		const view: BlockedMemoryViewV2 = {
			...header,
			status: "blocked",
			reasonCode: accessReason,
		};
		return deepFreeze(view);
	}

	// snapshot の件数が parse の上限を超える: 必須構成が入らない（例外にせず overflow）。
	if (trimmed !== null) {
		const view: OverflowMemoryViewV2 = {
			...header,
			status: "overflow",
			reasonCode: "BUDGET_EXCEEDED",
		};
		return deepFreeze(view);
	}

	const eligible = eligibleItemsV2(snapshot);
	const candidates = dedupeHits(evidence?.hits ?? []);
	const sourceReason = checkItemsAndEvidence(
		eligible,
		candidates.map((entry) => entry.ref),
		snapshot,
	);
	if (sourceReason !== null) {
		const view: BlockedMemoryViewV2 = {
			...header,
			status: "blocked",
			reasonCode: sourceReason,
		};
		return deepFreeze(view);
	}

	const coverageFor = (included: number): ViewCoverageV2 => {
		const omitted = candidates.length - included;
		return omitted === 0
			? { complete: true, omitted: [] }
			: { complete: false, omitted: [{ type: "evidence", count: omitted }] };
	};
	const attempt = (included: number) =>
		finalizeReadyViewV2(
			composeReadyBodyV2(
				access,
				snapshot,
				eligible,
				candidates.slice(0, included),
				coverageFor(included),
			),
		);

	// 必須だけの view（evidence は 0 件、省略は coverage に記録）が入らなければ overflow。
	let best = attempt(0);
	if (best.byteLength > maxBytes) {
		const view: OverflowMemoryViewV2 = {
			...header,
			status: "overflow",
			reasonCode: "BUDGET_EXCEEDED",
		};
		return deepFreeze(view);
	}

	const evidenceBudget = evidence?.maxEvidenceBytes ?? 0;
	let evidenceBytes = 0;
	for (let included = 1; included <= candidates.length; included += 1) {
		const entry = candidates[included - 1];
		if (entry === undefined) break;
		evidenceBytes += evidenceEntryBytes(entry);
		if (evidenceBytes > evidenceBudget) break;
		const next = attempt(included);
		if (next.byteLength > maxBytes) break;
		best = next;
	}
	return deepFreeze(best.view);
}
