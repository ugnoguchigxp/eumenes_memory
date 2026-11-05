import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePackage } from "../scripts/verify-package.ts";
import { dependencyInventory } from "../scripts/dependencies.ts";
test("archive validator detects export, missing local docs and accidental credentials", () => {
	const d = mkdtempSync(join(tmpdir(), "package-negative-"));
	try {
		mkdirSync(join(d, "dist"));
		mkdirSync(join(d, "docs"));
		for (const f of [
			"LICENSE",
			"THIRD_PARTY_NOTICES.md",
			"docs/host-guide.md",
			"dist/index.js",
			"dist/sqlite.js",
			"dist/index.d.ts",
			"dist/sqlite.d.ts",
		])
			writeFileSync(join(d, f), "");
		const p = {
			exports: {
				".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
				"./sqlite": {
					default: "./dist/sqlite.js",
					types: "./dist/sqlite.d.ts",
				},
			},
		};
		writeFileSync(join(d, "package.json"), JSON.stringify(p));
		writeFileSync(join(d, "README.md"), "[guide](docs/host-guide.md)");
		expect(validatePackage(d)).toEqual([]);
		writeFileSync(join(d, "README.md"), "[guide](docs/not-there.md)");
		expect(validatePackage(d).some((x) => x.includes("missing link"))).toBe(
			true,
		);
		writeFileSync(join(d, ".env"), "SYNTHETIC_TEST_ONLY");
		expect(validatePackage(d).some((x) => x.includes("Private"))).toBe(true);
		rmSync(join(d, "dist/index.js"));
		expect(validatePackage(d).some((x) => x.includes("Missing export"))).toBe(
			true,
		);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});
test("runtime archive has no dependencies and dev dependencies have pinned installed provenance", () => {
	const x = dependencyInventory(join(import.meta.dir, ".."));
	expect(x.runtimeDependencies).toEqual([]);
	expect(x.packages.length).toBeGreaterThan(0);
	for (const p of x.packages) expect(p.license).toBeString();
});
