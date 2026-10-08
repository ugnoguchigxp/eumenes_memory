import { compareCodeUnits } from "./compare.ts";

/**
 * RFC 8785 (JCS) のサブセット。受理する値は plain object / array / string /
 * boolean / 安全な整数のみ。それ以外はコアのバグとして TypeError を投げる。
 */
export function canonicalJson(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) {
			throw new TypeError("canonicalJson: non-safe-integer number");
		}
		return String(value === 0 ? 0 : value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			throw new TypeError("canonicalJson: non-plain object");
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort(compareCodeUnits);
		const parts: string[] = [];
		for (const key of keys) {
			const member = record[key];
			if (member === undefined) {
				throw new TypeError("canonicalJson: undefined member");
			}
			parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
		}
		return `{${parts.join(",")}}`;
	}
	throw new TypeError("canonicalJson: unsupported value");
}
