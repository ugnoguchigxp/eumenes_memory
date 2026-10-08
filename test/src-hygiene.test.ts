/** src の静的な不変条件（時計・乱数・locale・外部依存を使わない）。 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSpecifiers } from "../scripts/public-surface.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return name === "test" ? [] : sourceFiles(path);
		}
		return path.endsWith(".ts") ? [path] : [];
	});
}

const FILES = sourceFiles(SRC).map((path) => ({
	name: relative(ROOT, path),
	text: readFileSync(path, "utf8"),
}));

describe("src hygiene", () => {
	test("finds source files", () => {
		expect(FILES.length).toBeGreaterThan(10);
	});

	test.each([
		["Date", /\bDate\b/],
		["Math.random", /Math\.random/],
		["randomUUID", /randomUUID/],
		["localeCompare", /localeCompare/],
		["Intl", /\bIntl\b/],
		["process / env", /\bprocess\b/],
		["fetch / network", /\bfetch\s*\(/],
		["Bun global", /\bBun\./],
		["JSON.parse of external text", /JSON\.parse/],
		["eval", /\beval\s*\(/],
		["getRandomValues", /getRandomValues/],
		["performance clock", /\bperformance\./],
		["globalThis", /\bglobalThis\b/],
	])("does not use %s", (_name, pattern) => {
		for (const file of FILES) {
			expect({ file: file.name, hit: pattern.test(file.text) }).toEqual({
				file: file.name,
				hit: false,
			});
		}
	});

	test("only node:crypto is imported from outside the package, and only in sha256.ts", () => {
		for (const file of FILES) {
			for (const specifier of extractSpecifiers(file.text)) {
				if (specifier.startsWith(".")) {
					expect(specifier.endsWith(".ts")).toBe(true);
				} else {
					expect({ file: file.name, specifier }).toEqual({
						file: "src/canonical/sha256.ts",
						specifier: "node:crypto",
					});
				}
			}
		}
	});

	test("dependency direction between layers (full-system-design §1.2)", () => {
		// 層 -> import してよい層。store は全部品を使ってよい唯一の層。
		const PURE_BASE = ["canonical", "contracts"];
		const ALLOWED: Readonly<Record<string, readonly string[]>> = {
			canonical: ["canonical"],
			contracts: ["canonical", "contracts"],
			evidence: [...PURE_BASE, "evidence"],
			state: [...PURE_BASE, "evidence", "state"],
			recall: [...PURE_BASE, "evidence", "recall"],
			lifecycle: [...PURE_BASE, "evidence", "lifecycle"],
			extraction: [
				...PURE_BASE,
				"evidence",
				"state",
				"recall",
				"lifecycle",
				"extraction",
			],
			view: [...PURE_BASE, "state", "view"],
			validation: [...PURE_BASE, "view", "validation"],
			store: [
				...PURE_BASE,
				"evidence",
				"state",
				"recall",
				"lifecycle",
				"extraction",
				"store",
			],
		};
		const layerOf = (name: string): string | undefined => {
			const match = /^src\/([^/]+)\//.exec(name);
			return match?.[1];
		};
		for (const file of FILES) {
			const own = layerOf(file.name);
			if (own === undefined) continue; // src/index.ts, src/sqlite.ts は別のテスト
			expect(Object.keys(ALLOWED)).toContain(own);
			for (const specifier of extractSpecifiers(file.text)) {
				if (!specifier.startsWith(".")) continue;
				const target = join(dirname(file.name), specifier);
				const targetLayer = layerOf(target);
				if (targetLayer === undefined) {
					// src 直下のファイル（index.ts / sqlite.ts）への依存は禁止
					expect({ file: file.name, target, ok: false }).toEqual({
						file: file.name,
						target,
						ok: true,
					});
					continue;
				}
				expect({
					file: file.name,
					target,
					ok: (ALLOWED[own] ?? []).includes(targetLayer),
				}).toEqual({ file: file.name, target, ok: true });
			}
		}
	});

	test("public entry files: index.ts is pure, sqlite.ts only re-exports store and contracts", () => {
		const entry = (name: string) =>
			FILES.find((file) => file.name === name)?.text ?? "";
		const targets = (name: string) =>
			extractSpecifiers(entry(name)).map((specifier) => join("src", specifier));
		for (const target of targets("src/index.ts")) {
			expect(target).not.toMatch(/^src\/(store\/|sqlite\.ts)/);
		}
		for (const target of targets("src/sqlite.ts")) {
			expect(target).toMatch(/^src\/(store|contracts)\//);
		}
		expect(targets("src/sqlite.ts").length).toBeGreaterThan(5);
	});

	test("store and sqlite.ts: no bun:*, no transaction control, no async", () => {
		const stripComments = (text: string) =>
			text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const storeFiles = FILES.filter(
			(file) =>
				file.name.startsWith("src/store/") || file.name === "src/sqlite.ts",
		);
		expect(storeFiles.length).toBeGreaterThan(8);
		for (const file of storeFiles) {
			for (const specifier of extractSpecifiers(file.text)) {
				expect({ file: file.name, bun: specifier.startsWith("bun:") }).toEqual({
					file: file.name,
					bun: false,
				});
			}
			// trigger 本体の BEGIN ... END は SQL の構文（migration の文字列）で、transaction 制御ではない。
			const code = stripComments(file.text).replace(
				/CREATE\s+TRIGGER[\s\S]*?\bEND\s*;/gi,
				"",
			);
			for (const [name, pattern] of [
				[
					"transaction control",
					/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b|\.transaction\s*\(/,
				],
				["async / await", /\b(async|await)\b/],
			] as const) {
				expect({ file: file.name, name, hit: pattern.test(code) }).toEqual({
					file: file.name,
					name,
					hit: false,
				});
			}
		}
	});

	test("bun:sqlite is imported only by test/support", () => {
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((name) => {
				const path = join(dir, name);
				if (name === "node_modules") return [];
				if (statSync(path).isDirectory()) return walk(path);
				return path.endsWith(".ts") ? [path] : [];
			});
		const files = [
			...walk(SRC),
			...walk(join(ROOT, "test")),
			...walk(join(ROOT, "scripts")),
		];
		const importers = files
			.filter((path) =>
				extractSpecifiers(readFileSync(path, "utf8")).includes("bun:sqlite"),
			)
			.map((path) => relative(ROOT, path));
		expect(importers).toEqual(["test/support/store.ts"]);
	});

	test("package.json has no runtime dependencies", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.peerDependencies).toBeUndefined();
		expect(pkg.exports["."]).toBe("./src/index.ts");
		expect(pkg.exports["./sqlite"]).toBe("./src/sqlite.ts");
	});
});
