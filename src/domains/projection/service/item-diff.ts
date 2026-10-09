import { canonicalJson } from "../../../canonical/json.ts";
import type { ValidationReasonCode } from "../../../contracts/reason-codes.ts";
import type {
	MemoryItem,
	Snapshot,
	SourceRef,
	ViewItem,
} from "../../../contracts/types.ts";
import { compareSourceRef } from "./source-ref.ts";

function normalizedRefs(refs: readonly SourceRef[]): readonly SourceRef[] {
	return [...refs].sort(compareSourceRef);
}

/** kind / text / origin / primarySource / 正規化済み dependencies の比較用 JSON。 */
export function contentFingerprint(item: {
	readonly kind: string;
	readonly text: string;
	readonly origin: string;
	readonly primarySource: SourceRef;
	readonly dependencies: readonly SourceRef[];
}): string {
	return canonicalJson({
		kind: item.kind,
		text: item.text,
		origin: item.origin,
		primarySource: item.primarySource,
		dependencies: normalizedRefs(item.dependencies),
	});
}

/**
 * V5（view の item を並び順に current と照合）と V6（current の active item が
 * view にあるか）。最初の差分の reasonCode を返す。
 */
export function diffItems(
	viewItems: readonly ViewItem[],
	snapshot: Snapshot,
): ValidationReasonCode | null {
	const currentById = new Map<string, MemoryItem>();
	for (const item of snapshot.items) currentById.set(item.id, item);

	for (const viewItem of viewItems) {
		const current = currentById.get(viewItem.id);
		if (current === undefined) return "ITEM_MISSING";
		if (current.status !== "active") return "ITEM_INACTIVE";
		if (current.revision !== viewItem.revision) return "ITEM_REVISION_CHANGED";
		if (contentFingerprint(current) !== contentFingerprint(viewItem)) {
			return "ITEM_CONTENT_CHANGED";
		}
	}

	const viewIds = new Set(viewItems.map((item) => item.id));
	for (const item of snapshot.items) {
		if (item.status === "active" && !viewIds.has(item.id)) {
			return "ITEM_SET_CHANGED";
		}
	}
	return null;
}
