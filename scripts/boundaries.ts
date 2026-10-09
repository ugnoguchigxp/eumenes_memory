/** TypeScript AST + resolver: applies equally to imports, re-exports, aliases and lazy imports. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
	dependencyClosure,
	DOMAIN_NAMES,
	DOMAINS,
	ownerOf,
} from "./domains.ts";

export function walkFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (
			[
				"node_modules",
				".git",
				".serena",
				"verification-reports",
				"results",
			].includes(entry.name)
		)
			return [];
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walkFiles(path) : [path];
	});
}

export interface ModuleReference {
	readonly specifier: string | null;
	readonly line: number;
}

/** Nonliteral loading is reported too: a computed path must not bypass the boundary. */
export function moduleReferences(
	source: string,
	filename = "source.ts",
): ModuleReference[] {
	const file = ts.createSourceFile(
		filename,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const references: ModuleReference[] = [];
	const add = (node: ts.Node, value: ts.Node | undefined) =>
		references.push({
			specifier:
				value !== undefined && ts.isStringLiteralLike(value)
					? value.text
					: null,
			line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
		});
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier !== undefined) add(node, node.moduleSpecifier);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			add(node, node.moduleReference.expression);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument)
		) {
			add(node, node.argument.literal);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		)
			add(node, node.arguments[0]);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return references;
}

export function isTestFile(path: string): boolean {
	return (
		path.startsWith("test/") ||
		path.includes("/test/") ||
		path.endsWith("/testing.ts")
	);
}

function isSql(path: string): boolean {
	return (
		path === "src/sqlite.ts" ||
		path.startsWith("src/infrastructure/sqlite/") ||
		path.includes("/repository/") ||
		path.includes("/migrations/") ||
		path.endsWith("/sqlite.ts")
	);
}

const COMPATIBILITY = new Set(
	["records", "recall", "state", "extraction", "lifecycle", "parse-v2"].map(
		(name) => `src/contracts/${name}.ts`,
	),
);

export function checkBoundaries(root: string): string[] {
	dependencyClosure(DOMAIN_NAMES); // Configuration itself must be acyclic.
	const problems: string[] = [];
	const configPath = join(root, "tsconfig.json");
	const read = ts.readConfigFile(configPath, ts.sys.readFile);
	if (read.error !== undefined)
		throw new Error(
			ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
		);
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
	if (parsed.errors.length)
		throw new Error(
			parsed.errors
				.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))
				.join("\n"),
		);
	const graph = new Map<string, string[]>();
	const files = walkFiles(join(root, "src")).filter((path) =>
		path.endsWith(".ts"),
	);
	for (const file of files) {
		const name = relative(root, file);
		const own = ownerOf(name);
		const test = isTestFile(name);
		if (
			own === undefined &&
			name !== "src/index.ts" &&
			name !== "src/sqlite.ts" &&
			!name.startsWith("src/canonical/") &&
			!name.startsWith("src/contracts/") &&
			!name.startsWith("src/infrastructure/sqlite/")
		) {
			problems.push(`${name}: Source has no declared domain or shared owner`);
		}
		const targets: string[] = [];
		for (const reference of moduleReferences(
			readFileSync(file, "utf8"),
			file,
		)) {
			const fail = (reason: string) =>
				problems.push(`${name}:${reference.line}: ${reason}`);
			const specifier = reference.specifier;
			if (specifier === null) {
				if (!test) fail("Computed module loading is forbidden in src");
				continue;
			}
			const resolved = ts.resolveModuleName(
				specifier,
				file,
				parsed.options,
				ts.sys,
			).resolvedModule;
			if (resolved === undefined) {
				if (specifier.startsWith(".") || specifier.startsWith("eumenes-memory"))
					fail(`Unresolved module ${specifier}`);
				continue;
			}
			const target = relative(root, resolve(resolved.resolvedFileName));
			if (!target.startsWith("src/")) continue;
			if (!test) targets.push(target);
			if (!test && isTestFile(target))
				fail(`Production code imports test helper ${target}`);
			if (!test && !isSql(name) && isSql(target))
				fail(`Pure code depends on persistence ${target}`);
			if (own !== undefined && COMPATIBILITY.has(target))
				fail(`Use the domain contract directly: ${target}`);
			const targetOwner = ownerOf(target);
			if (
				own !== undefined &&
				targetOwner !== undefined &&
				own !== targetOwner
			) {
				const allowed = test
					? dependencyClosure([own])
					: [...DOMAINS[own].dependencies];
				if (!allowed.includes(targetOwner))
					fail(`Undeclared domain dependency ${own} -> ${targetOwner}`);
				const publicPort =
					target === `src/domains/${targetOwner}/index.ts` ||
					target === `src/domains/${targetOwner}/sqlite.ts` ||
					target.startsWith(`src/domains/${targetOwner}/contracts/`) ||
					(test && target === `src/domains/${targetOwner}/testing.ts`);
				const migrationTest =
					test && target.startsWith(`src/domains/${targetOwner}/migrations/`);
				if (!publicPort && !migrationTest)
					fail(`Cross-domain internal import ${target}`);
			}
			if (
				own !== undefined &&
				(target === "src/index.ts" || target === "src/sqlite.ts")
			)
				fail(`Domain imports package facade ${target}`);
			if (
				!test &&
				name.startsWith("src/contracts/") &&
				targetOwner !== undefined &&
				!target.includes("/contracts/")
			)
				fail(`Shared contract imports domain implementation ${target}`);
			if (
				!test &&
				name.startsWith("src/infrastructure/") &&
				targetOwner !== undefined &&
				!(
					name === "src/infrastructure/sqlite/migrations/index.ts" &&
					target.includes("/migrations/")
				)
			)
				fail(`Infrastructure imports business domain ${target}`);
			if (
				!test &&
				name.startsWith("src/canonical/") &&
				!target.startsWith("src/canonical/")
			)
				fail(`Canonical code imports another layer ${target}`);
		}
		if (!test) graph.set(name, targets);
	}
	// A shared protocol must not hide an undeclared domain edge behind a re-export.
	for (const [name, targets] of graph) {
		const own = ownerOf(name);
		if (own === undefined) continue;
		const seen = new Set<string>();
		const followShared = (target: string) => {
			if (seen.has(target)) return;
			seen.add(target);
			const targetOwner = ownerOf(target);
			if (targetOwner !== undefined) {
				if (
					targetOwner !== own &&
					!([...DOMAINS[own].dependencies] as readonly string[]).includes(
						targetOwner,
					)
				) {
					problems.push(
						`${name}: Shared protocol hides undeclared domain dependency ${own} -> ${targetOwner}`,
					);
				}
				return;
			}
			if (
				!target.startsWith("src/contracts/") &&
				!target.startsWith("src/canonical/")
			)
				return;
			for (const next of graph.get(target) ?? []) followShared(next);
		};
		for (const target of targets) followShared(target);
	}
	// Catch indirect SQL leaks through shared contracts and facades, and actual source cycles.
	const done = new Set<string>();
	const stack = new Set<string>();
	const sqlReach = new Map<string, boolean>();
	const visit = (name: string): boolean => {
		if (stack.has(name)) {
			problems.push(`Module dependency cycle at ${name}`);
			return false;
		}
		if (done.has(name)) return sqlReach.get(name) ?? false;
		stack.add(name);
		let reaches = isSql(name);
		for (const target of graph.get(name) ?? [])
			reaches = visit(target) || reaches;
		stack.delete(name);
		done.add(name);
		sqlReach.set(name, reaches);
		return reaches;
	};
	for (const name of graph.keys()) {
		if (visit(name) && !isSql(name))
			problems.push(`${name}: Pure entry transitively depends on persistence`);
	}
	return [...new Set(problems)];
}

if (import.meta.main) {
	const problems = checkBoundaries(resolve(dirname(import.meta.path), ".."));
	for (const problem of problems) console.error(problem);
	if (problems.length) process.exitCode = 1;
	else console.log("Domain boundaries ok");
}
