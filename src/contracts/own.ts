/**
 * own-property だけを読む。parse 済みの plain object は Object.prototype を継承するため、
 * 省略可能キーの有無を `=== undefined` で判定すると、プロトタイプ汚染された値を拾ってしまう。
 */
export function ownValue<T extends object, K extends keyof T>(
	object: T,
	key: K,
): T[K] | undefined {
	return Object.hasOwn(object, key) ? object[key] : undefined;
}
