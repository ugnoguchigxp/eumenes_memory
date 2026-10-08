import { compareCodeUnits } from "../canonical/compare.ts";
import { ownValue } from "../contracts/own.ts";
import type { SourceRef } from "../contracts/types.ts";

export { sourceKey } from "../contracts/source-key.ts";

function compareOptionalString(
	a: string | undefined,
	b: string | undefined,
): number {
	if (a === undefined) return b === undefined ? 0 : -1;
	if (b === undefined) return 1;
	return compareCodeUnits(a, b);
}

function compareNumber(a: number, b: number): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * namespace → kind → id → representation（不在 < 存在）→ revision → digest →
 * range（不在 < 存在、startByte → endByte）。range を持たない SourceDependency も可。
 */
export function compareSourceRef(
	a: Omit<SourceRef, "range"> & { readonly range?: SourceRef["range"] },
	b: Omit<SourceRef, "range"> & { readonly range?: SourceRef["range"] },
): number {
	return (
		compareCodeUnits(a.namespace, b.namespace) ||
		compareCodeUnits(a.kind, b.kind) ||
		compareCodeUnits(a.id, b.id) ||
		compareOptionalString(
			ownValue(a, "representation"),
			ownValue(b, "representation"),
		) ||
		compareCodeUnits(a.revision, b.revision) ||
		compareCodeUnits(a.digest, b.digest) ||
		compareRange(ownValue(a, "range"), ownValue(b, "range"))
	);
}

function compareRange(a: SourceRef["range"], b: SourceRef["range"]): number {
	if (a === undefined) return b === undefined ? 0 : -1;
	if (b === undefined) return 1;
	return (
		compareNumber(a.startByte, b.startByte) ||
		compareNumber(a.endByte, b.endByte)
	);
}
