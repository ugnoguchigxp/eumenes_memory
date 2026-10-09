import { compareCodeUnits } from "../../../canonical/compare.ts";
import { canonicalJson } from "../../../canonical/json.ts";
import { utf8ByteLength } from "../../../canonical/utf8.ts";
import { ownValue } from "../../../contracts/own.ts";
import type {
	AccessContext,
	SourceDependency,
	SourceRef,
} from "../../../contracts/types.ts";
import type {
	MemoryItemV2,
	ReadyMemoryViewV2,
	SnapshotV2,
	ViewCoverageV2,
	ViewEvidence,
	ViewItemV2,
} from "../../../contracts/view-v2.ts";
import { compareSourceRef, sourceKey } from "./source-ref.ts";

export type ReadyBodyV2 = Omit<ReadyMemoryViewV2, "viewDigest">;

/** 全結果共通の header（schemaVersion 2）。値の出所は v1 と同じ。 */
export function composeHeaderV2(access: AccessContext, snapshot: SnapshotV2) {
	return {
		schemaVersion: 2 as const,
		principal: access.principal,
		scopeKey: snapshot.scopeKey,
		purpose: access.purpose,
		stateRevision: snapshot.stateRevision,
		policyRevision: access.policyRevision,
		instructionAuthority: "none" as const,
	};
}

/**
 * view に入る item の集合: status が active で、subject が self（省略は self）のもの。id 昇順。
 * `other:*` / `unknown` は build が除外し、coverage にも数えない。
 */
export function eligibleItemsV2(snapshot: SnapshotV2): MemoryItemV2[] {
	return snapshot.items
		.filter(
			(item) =>
				item.status === "active" &&
				(ownValue(item, "subject") ?? "self") === "self",
		)
		.sort((a, b) => compareCodeUnits(a.id, b.id));
}

export function cloneRef(ref: SourceRef): SourceRef {
	const representation = ownValue(ref, "representation");
	const range = ownValue(ref, "range");
	return {
		namespace: ref.namespace,
		kind: ref.kind,
		id: ref.id,
		...(representation === undefined ? {} : { representation }),
		revision: ref.revision,
		digest: ref.digest,
		...(range === undefined
			? {}
			: { range: { startByte: range.startByte, endByte: range.endByte } }),
	};
}

function toDependency(ref: SourceRef): SourceDependency {
	const representation = ownValue(ref, "representation");
	return {
		namespace: ref.namespace,
		kind: ref.kind,
		id: ref.id,
		...(representation === undefined ? {} : { representation }),
		revision: ref.revision,
		digest: ref.digest,
	};
}

export function cloneEvidence(entry: ViewEvidence): ViewEvidence {
	return {
		ref: cloneRef(entry.ref),
		snippet: entry.snippet,
		authority: "evidence_candidate",
	};
}

/** evidence 予算の単位: 1 件の canonical JSON の UTF-8 byte 長。 */
export function evidenceEntryBytes(entry: ViewEvidence): number {
	return utf8ByteLength(canonicalJson(entry));
}

/**
 * ready 本体（viewDigest を除く）を新規構築する。items は検査済みの eligible item（id 昇順）、
 * evidence と coverage は呼び出し側が決めたもの。依存検査・予算判定はしない。
 * dependencies は item の依存と evidence の出典を range なしで出典単位に重複排除したもの。
 */
export function composeReadyBodyV2(
	access: AccessContext,
	snapshot: SnapshotV2,
	eligible: readonly MemoryItemV2[],
	evidence: readonly ViewEvidence[],
	coverage: ViewCoverageV2,
): ReadyBodyV2 {
	const items: ViewItemV2[] = eligible.map((item) => ({
		id: item.id,
		revision: item.revision,
		kind: item.kind,
		status: "active",
		origin: item.origin,
		text: item.text,
		primarySource: cloneRef(item.primarySource),
		dependencies: [...item.dependencies].sort(compareSourceRef).map(cloneRef),
	}));
	const evidenceEntries = evidence.map(cloneEvidence);

	const unique = new Map<string, SourceDependency>();
	const refs: SourceRef[] = [
		...items.flatMap((item) => item.dependencies),
		...evidenceEntries.map((entry) => entry.ref),
	];
	for (const ref of refs) {
		const entry = toDependency(ref);
		const key = JSON.stringify([
			sourceKey(entry),
			entry.revision,
			entry.digest,
		]);
		if (!unique.has(key)) unique.set(key, entry);
	}
	const dependencies = [...unique.values()].sort(compareSourceRef);

	return {
		...composeHeaderV2(access, snapshot),
		status: "ready",
		items,
		evidence: evidenceEntries,
		dependencies,
		coverage: {
			complete: coverage.complete,
			omitted: coverage.omitted.map((entry) => ({
				type: entry.type,
				count: entry.count,
			})),
		},
	};
}
