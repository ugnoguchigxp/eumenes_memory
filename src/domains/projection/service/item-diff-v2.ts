import { ownValue } from "../../../contracts/own.ts";
import type { ValidationReasonCode } from "../../../contracts/reason-codes.ts";
import type {
	MemoryItemV2,
	SnapshotV2,
	ViewItemV2,
} from "../../../contracts/view-v2.ts";
import { contentFingerprint } from "./item-diff.ts";

/**
 * V5（view の item を並び順に current と照合）と V6（current で view に入るはずの item が view にあるか）。
 * v1 との差: current 側の「view に入る item」は active かつ subject が self（省略は self）。
 * view にある item が current で `other:*` / `unknown` になっていたら、view に入れない状態なので
 * `ITEM_INACTIVE` とする。subject が self 以外の active item は ITEM_SET_CHANGED の対象にしない。
 */
export function diffItemsV2(
	viewItems: readonly ViewItemV2[],
	snapshot: SnapshotV2,
): ValidationReasonCode | null {
	const currentById = new Map<string, MemoryItemV2>();
	for (const item of snapshot.items) currentById.set(item.id, item);
	const isSelf = (item: MemoryItemV2): boolean =>
		(ownValue(item, "subject") ?? "self") === "self";

	for (const viewItem of viewItems) {
		const current = currentById.get(viewItem.id);
		if (current === undefined) return "ITEM_MISSING";
		if (current.status !== "active" || !isSelf(current)) {
			return "ITEM_INACTIVE";
		}
		if (current.revision !== viewItem.revision) return "ITEM_REVISION_CHANGED";
		if (contentFingerprint(current) !== contentFingerprint(viewItem)) {
			return "ITEM_CONTENT_CHANGED";
		}
	}

	const viewIds = new Set(viewItems.map((item) => item.id));
	for (const item of snapshot.items) {
		if (item.status === "active" && isSelf(item) && !viewIds.has(item.id)) {
			return "ITEM_SET_CHANGED";
		}
	}
	return null;
}
