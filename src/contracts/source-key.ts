import { ownValue } from "./own.ts";

/**
 * 出典キー = (namespace, kind, id, representation)。依存辺・墓標の ID として使う。
 */
export function sourceKey(ref: {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
}): string {
	return JSON.stringify([
		ref.namespace,
		ref.kind,
		ref.id,
		ownValue(ref, "representation") ?? null,
	]);
}
