import { ownValue } from "../../../contracts/own.ts";
import type { StateValue } from "../contracts/index.ts";

function attributeEntries(
	value: StateValue,
): readonly (readonly [string, string])[] {
	const attributes = ownValue(value, "attributes");
	if (attributes === undefined) return [];
	return Object.keys(attributes)
		.sort()
		.map((key) => [key, attributes[key] as string] as const);
}

/**
 * 値の等価。text・polarity・attributes（キーの集合と各値）がすべて同じなら true。
 * `attributes` の省略と空オブジェクトは同じとみなす。冪等判定（`unchanged`）と、
 * 同 key の別値判定（supersede / dispute）に使う。
 */
export function stateValueEquals(a: StateValue, b: StateValue): boolean {
	if (a.text !== b.text || a.polarity !== b.polarity) return false;
	const left = attributeEntries(a);
	const right = attributeEntries(b);
	if (left.length !== right.length) return false;
	return left.every(
		(entry, index) =>
			entry[0] === right[index]?.[0] && entry[1] === right[index]?.[1],
	);
}
