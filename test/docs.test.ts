import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const root = join(import.meta.dir, "..");
// Living docs only: design/verification records keep the paths of their time.
const DOCS = [
	"docs/host-guide.md",
	"docs/quality-validation.md",
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

describe("state search design (S0, decision 1)", () => {
	test("full-system-design no longer lists full-text search as a non-goal and points to the design", () => {
		const text = readFileSync(join(root, "spec/full-system-design.md"), "utf8");
		const nonGoals = text.split("\n非ゴール\n")[1]?.split("\n禁止\n")[0] ?? "";
		expect(nonGoals).not.toContain("embedding / ベクトル検索、全文検索");
		expect(nonGoals).toContain("state-search-design.md");
		expect(existsSync(join(root, "spec/state-search-design.md"))).toBe(true);
	});
	test("the design records all twelve approved decisions", () => {
		const text = readFileSync(
			join(root, "spec/state-search-design.md"),
			"utf8",
		);
		const decisions = text.split("### 10.1 決定事項")[1]?.split("### 10.2")[0];
		for (let n = 1; n <= 12; n += 1)
			expect(decisions).toMatch(new RegExp(`\\n\\| ${n} \\|`));
	});
});
