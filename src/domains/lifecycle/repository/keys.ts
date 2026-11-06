import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";

/** 閉包と依存辺で node を一意に指す内部キー。 */
export function nodeKey(type: string, id: string): string {
	return `${type}\u0000${id}`;
}

/** `memory_dependency.dependent_id` に保存する external node。 */
export function externalNodeId(
	providerRef: string,
	externalId: string,
): string {
	return `${providerRef}:${externalId}`;
}

/** `externalNodeId` の逆。区切りが無ければ行が壊れている。 */
export function splitExternalNodeId(id: string): {
	readonly providerRef: string;
	readonly externalId: string;
} {
	const colon = id.indexOf(":");
	if (colon <= 0) throw new MemoryStoreError("CORRUPT_ROW");
	return { providerRef: id.slice(0, colon), externalId: id.slice(colon + 1) };
}
