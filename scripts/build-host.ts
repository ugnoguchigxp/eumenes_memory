import ts from "typescript";
/** Ship the dependency-free core as versioned runtime files, without a filesystem dependency on this checkout. */
import {
	cpSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const host = join(root, "packages/host");
rmSync(join(host, "dist"), { recursive: true, force: true });
const tsc = Bun.spawn(
	[
		join(root, "node_modules/.bin/tsc"),
		"-p",
		join(host, "tsconfig.build.json"),
	],
	{ stdout: "inherit", stderr: "inherit" },
);
if (await tsc.exited) throw Error("Host compilation failed");
const vendor = join(host, "dist/core");
mkdirSync(vendor, { recursive: true });
cpSync(join(root, "dist"), vendor, { recursive: true });
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
	cpSync(join(root, name), join(vendor, name));
rmSync(join(vendor, "release-manifest.json"), { force: true });
const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() && e.name !== "core"
			? walk(join(dir, e.name))
			: e.isFile()
				? [join(dir, e.name)]
				: [],
	);
for (const file of walk(join(host, "dist")).filter(
	(f) => f.endsWith(".js") || f.endsWith(".d.ts"),
)) {
	const content = readFileSync(file, "utf8");
	const parsed = ts.createSourceFile(
		file,
		content,
		ts.ScriptTarget.Latest,
		true,
	);
	const edits: { start: number; end: number; text: string }[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isStringLiteral(node) &&
			["eumenes-memory", "eumenes-memory/sqlite"].includes(node.text)
		) {
			const parent = node.parent;
			const moduleSpecifier =
				((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
					parent.moduleSpecifier === node) ||
				(ts.isLiteralTypeNode(parent) &&
					ts.isImportTypeNode(parent.parent) &&
					parent.parent.argument === parent) ||
				(ts.isCallExpression(parent) &&
					parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
					parent.arguments[0] === node);
			if (moduleSpecifier) {
				let target = relative(
					dirname(file),
					join(
						vendor,
						node.text.endsWith("/sqlite") ? "sqlite.js" : "index.js",
					),
				);
				if (!target.startsWith(".")) target = "./" + target;
				edits.push({
					start: node.getStart(parsed),
					end: node.end,
					text: JSON.stringify(target),
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	let rewritten = content;
	for (const edit of edits.sort((a, b) => b.start - a.start))
		rewritten =
			rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
	writeFileSync(file, rewritten);
}
