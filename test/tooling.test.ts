import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkBoundaries, moduleReferences } from "../scripts/boundaries.ts";
import { dependencyClosure, domainName } from "../scripts/domains.ts";
import { domainTests } from "../scripts/test-domain.ts";
import { parseVerifyArgs, sourceHash, verify } from "../scripts/verify.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function put(root: string, name: string, content: string): void {
	const path = join(root, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "memory-boundaries-"));
	roots.push(root);
	put(
		root,
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				moduleResolution: "Bundler",
				module: "ESNext",
				baseUrl: ".",
				paths: { "@memory/*": ["src/*"] },
			},
		}),
	);
	put(
		root,
		"src/domains/records/service/identity.ts",
		"export const identity = 1;",
	);
	put(
		root,
		"src/domains/records/index.ts",
		'export * from "./service/identity.ts";',
	);
	put(
		root,
		"src/domains/records/contracts/index.ts",
		"export type RecordId = string;",
	);
	put(
		root,
		"src/domains/state/contracts/index.ts",
		"export type StateId = string;",
	);
	return root;
}

describe("domain boundary enforcement", () => {
	test.each([
		'import {identity} from "../../records/service/identity.ts";',
		'export * from "../../records/service/identity.ts";',
		'const identity = import("../../records/service/identity.ts");',
		'const identity = require("../../records/service/identity.ts");',
		'import identity = require("../../records/service/identity.ts");',
		'type Identity = import("../../records/service/identity.ts").Identity;',
		'export * from "@memory/domains/records/service/identity.ts";',
	])(
		"rejects internal dependency through every module syntax: %s",
		(source) => {
			const root = scratch();
			put(root, "src/domains/state/service/check.ts", source);
			expect(
				checkBoundaries(root).some((problem) =>
					problem.includes("Cross-domain internal import"),
				),
			).toBe(true);
		},
	);

	test("allows public ports and contracts with declared dependencies", () => {
		const root = scratch();
		put(
			root,
			"src/domains/state/service/check.ts",
			'import {identity} from "../../records/index.ts";\nimport type {RecordId} from "../../records/contracts/index.ts";',
		);
		expect(checkBoundaries(root)).toEqual([]);
	});

	test("rejects undeclared dependencies even through a public port", () => {
		const root = scratch();
		put(
			root,
			"src/domains/extraction/service/check.ts",
			'export * from "../../projection/index.ts";',
		);
		put(root, "src/domains/projection/index.ts", "export const project = 1;");
		expect(
			checkBoundaries(root).some((problem) =>
				problem.includes("Undeclared domain dependency"),
			),
		).toBe(true);
	});

	test("a shared contract cannot hide an undeclared domain dependency", () => {
		const root = scratch();
		put(
			root,
			"src/domains/projection/contracts/index.ts",
			"export type Project = string;",
		);
		put(
			root,
			"src/contracts/bridge.ts",
			'export type {Project} from "../domains/projection/contracts/index.ts";',
		);
		put(
			root,
			"src/domains/extraction/service/check.ts",
			'export * from "../../../contracts/bridge.ts";',
		);
		expect(
			checkBoundaries(root).some((problem) =>
				problem.includes("Shared protocol hides undeclared domain dependency"),
			),
		).toBe(true);
	});

	test("new production folders require an explicit owner", () => {
		const root = scratch();
		put(
			root,
			"src/unowned/bridge.ts",
			'export * from "../domains/records/service/identity.ts";',
		);
		expect(
			checkBoundaries(root).some((problem) =>
				problem.includes("Source has no declared domain or shared owner"),
			),
		).toBe(true);
	});

	test("rejects indirect SQLite dependencies through contracts and aliases", () => {
		const root = scratch();
		put(
			root,
			"src/infrastructure/sqlite/db.ts",
			"export const connection = 1;",
		);
		put(
			root,
			"src/contracts/leak.ts",
			'export * from "@memory/infrastructure/sqlite/db.ts";',
		);
		put(
			root,
			"src/domains/state/service/check.ts",
			'export * from "../../../contracts/leak.ts";',
		);
		const problems = checkBoundaries(root);
		expect(
			problems.some((problem) =>
				problem.includes("Pure code depends on persistence"),
			),
		).toBe(true);
		expect(
			problems.some((problem) =>
				problem.includes("check.ts: Pure entry transitively"),
			),
		).toBe(true);
	});

	test("does not mistake comments and string contents for module imports", () => {
		expect(
			moduleReferences(
				'// import("./no.ts")\nconst s = `export * from "./no.ts"`;',
			),
		).toEqual([]);
	});

	test("rejects computed production loading and unresolved relative targets", () => {
		const root = scratch();
		put(
			root,
			"src/domains/state/service/check.ts",
			'const x = import(path);\nexport * from "./absent.ts";',
		);
		const problems = checkBoundaries(root);
		expect(
			problems.some((problem) => problem.includes("Computed module loading")),
		).toBe(true);
		expect(
			problems.some((problem) => problem.includes("Unresolved module")),
		).toBe(true);
	});

	test("rejects real module cycles and domain configuration cycles", () => {
		const root = scratch();
		put(root, "src/domains/state/service/a.ts", 'export * from "./b.ts";');
		put(root, "src/domains/state/service/b.ts", 'export * from "./a.ts";');
		expect(
			checkBoundaries(root).some((problem) =>
				problem.includes("Module dependency cycle"),
			),
		).toBe(true);
		expect(() =>
			dependencyClosure(["a"], {
				a: { dependencies: ["b"] },
				b: { dependencies: ["a"] },
			}),
		).toThrow("cycle");
	});
});

describe("verification selection and evidence", () => {
	test("keeps plain verify as all, rejects malformed arguments and includes dependency closure", () => {
		expect(parseVerifyArgs([])).toEqual({ mode: "all" });
		expect(parseVerifyArgs(["--all"])).toEqual({ mode: "all" });
		expect(parseVerifyArgs(["--", "--domain", "state"])).toEqual({
			mode: "domain",
			domain: "state",
		});
		expect(dependencyClosure(["lifecycle"])).toEqual([
			"records",
			"recall",
			"temporal",
			"state",
			"extraction",
			"lifecycle",
		]);
		for (const args of [
			["--domain"],
			["--domain", "wrong"],
			["--all", "--domain", "state"],
		])
			expect(() => parseVerifyArgs(args)).toThrow();
		expect(() => domainName("toString")).toThrow();
	});

	test("selected tests are owned by the domain and are nonempty", () => {
		const root = join(import.meta.dir, "..");
		const tests = domainTests(root, ["state"]);
		expect(tests.length).toBeGreaterThan(0);
		expect(tests.some((path) => path.includes("/domains/extraction/"))).toBe(
			false,
		);
		expect(
			tests.some((path) => path.endsWith("/admission-fixtures.test.ts")),
		).toBe(true);
	});

	test("source evidence changes with fixture bytes and paths, not generated reports", () => {
		const root = scratch();
		put(root, "fixtures/state/a.json", "{}");
		const before = sourceHash(root);
		put(root, "verification-reports/latest.json", "{}");
		expect(sourceHash(root)).toBe(before);
		put(root, "fixtures/state/a.json", '{"changed":true}');
		expect(sourceHash(root)).not.toBe(before);
		const changed = sourceHash(root);
		renameSync(
			join(root, "fixtures/state/a.json"),
			join(root, "fixtures/state/b.json"),
		);
		expect(sourceHash(root)).not.toBe(changed);
	});

	function fakeTool(root: string, name: string, body: string): void {
		put(
			root,
			`node_modules/.bin/${name}`,
			`#!/bin/sh\nif [ "$1" = "--version" ]; then echo test-version; exit 0; fi\n${body}\n`,
		);
		chmodSync(join(root, "node_modules/.bin", name), 0o755);
	}

	test("failed stage produces a failure report and stops subsequent checks", async () => {
		const root = scratch();
		fakeTool(root, "oxfmt", "exit 7");
		fakeTool(root, "oxlint", "exit 0");
		expect(await verify(root, { mode: "all" })).toBe(7);
		const report = JSON.parse(
			readFileSync(join(root, "verification-reports/latest.json"), "utf8"),
		);
		expect(report.status).toBe("failed");
		expect(report.stages.map((step: { name: string }) => step.name)).toEqual([
			"format",
		]);
		expect(report.sourceUnchanged).toBe(true);
		expect(report.tools.oxfmt).toBe("test-version");
	});

	test("source mutation during a check invalidates its report", async () => {
		const root = scratch();
		fakeTool(
			root,
			"oxfmt",
			'echo "export const changed = 2;" > src/domains/records/service/identity.ts\nexit 0',
		);
		fakeTool(root, "oxlint", "exit 7");
		expect(await verify(root, { mode: "all" })).toBe(1);
		const report = JSON.parse(
			readFileSync(join(root, "verification-reports/latest.json"), "utf8"),
		);
		expect(report.sourceUnchanged).toBe(false);
		expect(report.error).toContain("Source changed");
	});
});

describe("extractSpecifiers", () => {
	test("finds real module specifiers and ignores quoted words named from", async () => {
		const { extractSpecifiers } = await import("../scripts/public-surface.ts");
		const source = [
			'import a from "./a.ts";',
			"import { b,",
			'} from "./b.ts";',
			'export * from "./c.ts";',
			'const keys = ["from", "until"];',
			"const r = obj['from'] ?? 'x';",
		].join("\n");
		expect(extractSpecifiers(source)).toEqual(["./a.ts", "./b.ts", "./c.ts"]);
	});
});
