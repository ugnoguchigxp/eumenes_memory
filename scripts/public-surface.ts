/**
 * 公開面の静的検査（verify の public-surface ステップ）。
 * - test/consumer 配下は "eumenes-memory"・"eumenes-memory/sqlite"・"bun:test"・
 *   "../fixture-runner.ts"・"../support/store.ts"・node: 組み込みだけを import してよい
 *   （src への相対 import 禁止）。
 * - test/fixture-runner.ts は src を import してはならない。
 * - test/support 配下（テスト用 Writer）は "bun:sqlite"・"eumenes-memory"・
 *   "eumenes-memory/sqlite"・node: 組み込みだけを import してよい（相対 import 禁止）。
 *   bun:sqlite を import してよいのはここだけ（src とテスト本体は import しない）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_CONSUMER_SPECIFIERS = new Set([
	"eumenes-memory",
	"eumenes-memory/sqlite",
	"bun:test",
	"../fixture-runner.ts",
	"../support/store.ts",
]);

const ALLOWED_SUPPORT_SPECIFIERS = new Set([
	"bun:sqlite",
	"eumenes-memory",
	"eumenes-memory/sqlite",
]);

/** from "x" / import "x" / import("x") / require("x") の指定子を取り出す。 */
export function extractSpecifiers(source: string): string[] {
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	return patterns.flatMap((pattern) =>
		[...source.matchAll(pattern)].map((match) => match[1] as string),
	);
}

function pointsIntoSrc(specifier: string): boolean {
	return (
		specifier.startsWith(".") &&
		(/(^|\/)src(\/|$)/.test(specifier) || specifier.includes("eumenes_memory"))
	);
}

/** 違反の説明を返す。空配列なら合格。 */
export function checkPublicSurface(root: string): string[] {
	const problems: string[] = [];
	const consumerDir = join(root, "test", "consumer");
	for (const name of readdirSync(consumerDir)) {
		if (!name.endsWith(".ts")) continue;
		const text = readFileSync(join(consumerDir, name), "utf8");
		for (const specifier of extractSpecifiers(text)) {
			if (
				ALLOWED_CONSUMER_SPECIFIERS.has(specifier) ||
				specifier.startsWith("node:")
			) {
				continue;
			}
			problems.push(`test/consumer/${name}: disallowed import "${specifier}"`);
		}
	}
	const runner = readFileSync(join(root, "test", "fixture-runner.ts"), "utf8");
	for (const specifier of extractSpecifiers(runner)) {
		if (pointsIntoSrc(specifier)) {
			problems.push(`test/fixture-runner.ts: imports src via "${specifier}"`);
		}
	}
	const supportDir = join(root, "test", "support");
	if (existsSync(supportDir)) {
		for (const name of readdirSync(supportDir)) {
			if (!name.endsWith(".ts")) continue;
			const text = readFileSync(join(supportDir, name), "utf8");
			for (const specifier of extractSpecifiers(text)) {
				if (
					ALLOWED_SUPPORT_SPECIFIERS.has(specifier) ||
					specifier.startsWith("node:")
				) {
					continue;
				}
				problems.push(`test/support/${name}: disallowed import "${specifier}"`);
			}
		}
	}
	return problems;
}
