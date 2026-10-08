import { compareCodeUnits } from "../canonical/compare.ts";
import type {
	AccessContext,
	ReadyMemoryView,
	Snapshot,
	SourceDependency,
	SourceRef,
	ViewItem,
} from "../contracts/types.ts";
import { ownValue } from "../contracts/own.ts";
import { compareSourceRef, sourceKey } from "./source-ref.ts";

export type ReadyBody = Omit<ReadyMemoryView, "viewDigest">;

/** 全結果共通の header。値の出所は設計書 §1.3 / D4。 */
export function composeHeader(access: AccessContext, snapshot: Snapshot) {
	return {
		schemaVersion: 1 as const,
		principal: access.principal,
		scopeKey: snapshot.scopeKey,
		purpose: access.purpose,
		stateRevision: snapshot.stateRevision,
		policyRevision: access.policyRevision,
		instructionAuthority: "none" as const,
	};
}

function cloneRef(ref: SourceRef): SourceRef {
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

/**
 * active item だけで ready 本体（viewDigest を除く）を新規構築する。
 * 依存検査済みの入力を前提とし、予算判定はしない。入力とは参照を共有しない。
 */
export function composeReadyBody(
	access: AccessContext,
	snapshot: Snapshot,
): ReadyBody {
	const active = snapshot.items
		.filter((item) => item.status === "active")
		.sort((a, b) => compareCodeUnits(a.id, b.id));

	const items: ViewItem[] = active.map((item) => ({
		id: item.id,
		revision: item.revision,
		kind: item.kind,
		status: "active",
		origin: item.origin,
		text: item.text,
		primarySource: cloneRef(item.primarySource),
		dependencies: [...item.dependencies].sort(compareSourceRef).map(cloneRef),
	}));

	const unique = new Map<string, SourceDependency>();
	for (const item of items) {
		for (const dependency of item.dependencies) {
			const entry = toDependency(dependency);
			const key = JSON.stringify([
				sourceKey(entry),
				entry.revision,
				entry.digest,
			]);
			if (!unique.has(key)) unique.set(key, entry);
		}
	}
	const dependencies = [...unique.values()].sort(compareSourceRef);

	return {
		...composeHeader(access, snapshot),
		status: "ready",
		items,
		dependencies,
		coverage: { complete: true, omitted: [] },
	};
}
