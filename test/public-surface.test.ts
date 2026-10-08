import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPublicSurface,
	extractSpecifiers,
} from "../scripts/public-surface.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function scratch(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "memory-surface-"));
	mkdirSync(join(root, "test", "consumer"), { recursive: true });
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(root, name), text);
	}
	return root;
}

describe("public-surface check", () => {
	test("the real repository passes", () => {
		expect(checkPublicSurface(ROOT)).toEqual([]);
	});

	test("extracts static, side-effect, dynamic and require specifiers", () => {
		const text = `
			import { a } from "x";
			import type { B } from 'y';
			export { c } from "z";
			import "side";
			const d = await import("dyn");
			const e = require("req");
		`;
		expect(extractSpecifiers(text).sort()).toEqual(
			["dyn", "req", "side", "x", "y", "z"].sort(),
		);
	});

	test("flags relative imports into src from a consumer test", () => {
		const root = scratch({
			"test/fixture-runner.ts": 'import { test } from "bun:test";\n',
			"test/consumer/bad.test.ts":
				'import { buildMemoryView } from "../../src/index.ts";\nimport { x } from "eumenes-memory";\n',
		});
		try {
			expect(checkPublicSurface(root)).toEqual([
				'test/consumer/bad.test.ts: disallowed import "../../src/index.ts"',
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("flags dynamic imports and any non-allowlisted package", () => {
		const root = scratch({
			"test/fixture-runner.ts": "export {};\n",
			"test/consumer/bad.test.ts":
				'const m = await import("../../src/view/build.ts");\nimport "lodash";\nimport { readFileSync } from "node:fs";\n',
		});
		try {
			expect(checkPublicSurface(root).sort()).toEqual([
				'test/consumer/bad.test.ts: disallowed import "../../src/view/build.ts"',
				'test/consumer/bad.test.ts: disallowed import "lodash"',
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("flags fixture-runner importing src", () => {
		const root = scratch({
			"test/fixture-runner.ts": 'import { x } from "../src/index.ts";\n',
			"test/consumer/ok.test.ts": 'import { test } from "bun:test";\n',
		});
		try {
			expect(checkPublicSurface(root)).toEqual([
				'test/fixture-runner.ts: imports src via "../src/index.ts"',
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("allows the sqlite subpath and the support Writer from consumer tests", () => {
		const root = scratch({
			"test/fixture-runner.ts": "export {};\n",
			"test/consumer/ok.test.ts":
				'import { migrations } from "eumenes-memory/sqlite";\nimport { openTestStore } from "../support/store.ts";\n',
		});
		try {
			expect(checkPublicSurface(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("flags test/support importing src or unexpected packages", () => {
		const root = scratch({
			"test/fixture-runner.ts": "export {};\n",
			"test/consumer/ok.test.ts": 'import { test } from "bun:test";\n',
		});
		mkdirSync(join(root, "test", "support"), { recursive: true });
		writeFileSync(
			join(root, "test", "support", "store.ts"),
			'import { x } from "../../src/sqlite.ts";\nimport "lodash";\nimport { mkdtempSync } from "node:fs";\n',
		);
		try {
			expect(checkPublicSurface(root).sort()).toEqual([
				'test/support/store.ts: disallowed import "../../src/sqlite.ts"',
				'test/support/store.ts: disallowed import "lodash"',
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
