/**
 * 言語非依存 JSON fixture の実行器。src を import せず、API を引数で受け取る。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InternalApi {
	canonicalJson(value: unknown): string;
	sha256Hex(data: string | Uint8Array): string;
	utf8ByteLength(s: string): number;
	encodeUtf8(s: string): Uint8Array;
	isUtf8CharBoundary(bytes: Uint8Array, index: number): boolean;
}

type Obj = Record<string, unknown>;

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);

export function loadFixtures(kind: string): Obj[] {
	const dir = join(FIXTURES_DIR, kind);
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const fixture = JSON.parse(readFileSync(join(dir, name), "utf8")) as Obj;
			expect(`${String(fixture["id"])}.json`).toBe(name);
			expect(fixture["fixtureFormat"]).toBe(1);
			expect(Array.isArray(fixture["covers"])).toBe(true);
			return fixture;
		});
}

export function describeInternalFixtures(api: InternalApi): void {
	describe("canonical fixtures", () => {
		for (const fixture of loadFixtures("canonical")) {
			test(String(fixture["id"]), () => {
				const canonical = api.canonicalJson(fixture["value"]);
				expect(canonical).toBe(fixture["canonical"] as string);
				expect(api.sha256Hex(canonical)).toBe(fixture["sha256"] as string);
				expect(api.utf8ByteLength(canonical)).toBe(
					fixture["utf8ByteLength"] as number,
				);
				expect(api.encodeUtf8(canonical).length).toBe(
					fixture["utf8ByteLength"] as number,
				);
			});
		}
	});

	describe("utf8 fixtures", () => {
		for (const fixture of loadFixtures("utf8")) {
			test(String(fixture["id"]), () => {
				const text = fixture["text"] as string;
				const bytes = api.encodeUtf8(text);
				expect(api.utf8ByteLength(text)).toBe(
					fixture["utf8ByteLength"] as number,
				);
				expect(bytes.length).toBe(fixture["utf8ByteLength"] as number);
				const boundaries: number[] = [];
				for (let index = 0; index <= bytes.length; index += 1) {
					if (api.isUtf8CharBoundary(bytes, index)) boundaries.push(index);
				}
				expect(boundaries).toEqual(fixture["boundaries"] as number[]);
				expect(api.isUtf8CharBoundary(bytes, bytes.length + 1)).toBe(false);
			});
		}
	});
}
