import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const root = join(import.meta.dir, "..");
// Living docs only: design/verification records keep the paths of their time.
const DOCS = [
	"README.md",
	"src/domains/README.md",
	"src/infrastructure/sqlite/README.md",
	"src/infrastructure/sqlite/migrations/README.md",
];

describe("living docs", () => {
	for (const doc of DOCS) {
		test(`${doc}: relative links resolve inside the repository`, () => {
			const text = readFileSync(join(root, doc), "utf8");
			const missing: string[] = [];
			for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				const target = (match[1] ?? "").split("#")[0] ?? "";
				if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
				const resolved = resolve(dirname(join(root, doc)), target);
				// Neighbouring checkouts (e.g. ../eumenes) are reference material.
				if (!resolved.startsWith(root + sep)) continue;
				if (!existsSync(resolved)) missing.push(target);
			}
			expect(missing).toEqual([]);
		});

		test(`${doc}: src/ paths named in code spans exist`, () => {
			const text = readFileSync(join(root, doc), "utf8");
			const missing: string[] = [];
			for (const match of text.matchAll(/`(src\/[A-Za-z0-9_./-]+)`/g)) {
				const path = (match[1] ?? "").replace(/[.,:]+$/, "");
				if (path.includes("*") || path.endsWith("/")) continue;
				if (!existsSync(join(root, path))) missing.push(path);
			}
			expect(missing).toEqual([]);
		});
	}
});
