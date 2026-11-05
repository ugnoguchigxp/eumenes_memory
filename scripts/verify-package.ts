/** Build/extract/verify the real deliverable, including meaningful negative controls. */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sourceHash } from "./verify.ts";
export function packageFiles(root: string, prefix = ""): string[] {
	return readdirSync(join(root, prefix), { withFileTypes: true })
		.flatMap((e) =>
			e.isDirectory()
				? packageFiles(root, join(prefix, e.name))
				: [join(prefix, e.name)],
		)
		.sort();
}
export function validateManifest(root: string): string[] {
	const file = join(root, "dist/release-manifest.json");
	if (!existsSync(file)) return ["Missing release manifest"];
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sourceHash))
		return ["Invalid release manifest"];
	const problems: string[] = [];
	for (const [path, digest] of Object.entries(
		manifest.files as Record<string, string>,
	)) {
		const target = resolve(root, path);
		if (
			!target.startsWith(root + "/") ||
			!existsSync(target) ||
			createHash("sha256").update(readFileSync(target)).digest("hex") !== digest
		)
			problems.push(`Artifact content mismatch: ${path}`);
	}
	const expected = packageFiles(root).filter(
		(f) => f !== "dist/release-manifest.json",
	);
	if (
		JSON.stringify(expected) !==
		JSON.stringify(Object.keys(manifest.files).sort())
	)
		problems.push("Artifact file set mismatch");
	return problems;
}
export function validatePackage(root: string): string[] {
	const problems: string[] = [];
	const files = packageFiles(root);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	for (const key of [".", "./sqlite"])
		for (const k of ["types", "default"]) {
			const target = pkg.exports?.[key]?.[k];
			if (typeof target !== "string" || !existsSync(resolve(root, target)))
				problems.push(`Missing export ${key}:${k}`);
		}
	for (const file of files.filter((f) => f.endsWith(".md"))) {
		const text = readFileSync(join(root, file), "utf8");
		for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = m[1]!.split("#")[0]!;
			if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
			const path = resolve(root, dirname(file), target);
			if (!path.startsWith(root + "/") || !existsSync(path))
				problems.push(`${file}: missing link ${target}`);
		}
	}
	for (const required of [
		"LICENSE",
		"THIRD_PARTY_NOTICES.md",
		"docs/host-guide.md",
	])
		if (!files.includes(required))
			problems.push(`Missing guide/license ${required}`);
	if (
		files.some((f) =>
			/(?:^|\/)(?:\.env|auth\.json|sources\.jsonl|node_modules)(?:\/|$)/.test(
				f,
			),
		)
	)
		problems.push("Private or dependency material in archive");
	return problems;
}
async function run(command: string[], cwd: string): Promise<string> {
	const child = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw Error(`${command[0]} failed (${code}): ${stderr}\n${stdout}`);
	return stdout;
}
export async function verifyPackage(root: string): Promise<unknown> {
	const scratch = mkdtempSync(join(tmpdir(), "memory-deliverable-"));
	const reportDir = join(root, "verification-reports/quality-80");
	mkdirSync(reportDir, { recursive: true });
	const hash = sourceHash(root);
	try {
		await run([process.execPath, "pm", "pack", "--destination", scratch], root);
		const artifact = readdirSync(scratch).find((f) => f.endsWith(".tgz"));
		if (!artifact) throw Error("Missing archive");
		const packageDir = join(scratch, "consumer/node_modules/eumenes-memory");
		mkdirSync(packageDir, { recursive: true });
		await run(
			[
				"tar",
				"-xzf",
				join(scratch, artifact),
				"--strip-components=1",
				"-C",
				packageDir,
			],
			scratch,
		);
		const problems = [
			...validatePackage(packageDir),
			...validateManifest(packageDir),
		];
		if (problems.length) throw Error(problems.join("\n"));
		const consumer = join(scratch, "consumer");
		copyFileSync(
			join(root, "scripts/package-consumer.mjs"),
			join(consumer, "check.mjs"),
		);
		const results = [];
		for (const runtime of [process.execPath, "node"])
			results.push(
				JSON.parse((await run([runtime, "check.mjs"], consumer)).trim()),
			);
		// This fixture is outside the checkout; corrupt exports and docs in turn and prove the gate detects both.
		const pkgPath = join(packageDir, "package.json"),
			original = readFileSync(pkgPath, "utf8"),
			pkg = JSON.parse(original);
		pkg.exports["."].default = "./dist/missing.js";
		writeFileSync(pkgPath, JSON.stringify(pkg));
		if (!validatePackage(packageDir).some((s) => s.includes("Missing export")))
			throw Error("Export negative control escaped");
		writeFileSync(pkgPath, original);
		const guidePath = join(packageDir, "docs/host-guide.md"),
			guide = readFileSync(guidePath, "utf8");
		rmSync(guidePath);
		if (!validatePackage(packageDir).some((s) => s.includes("guide")))
			throw Error("Guide negative control escaped");
		writeFileSync(guidePath, guide);
		const codeFile = join(packageDir, "dist/index.js"),
			originalCode = readFileSync(codeFile, "utf8");
		writeFileSync(codeFile, originalCode + "\n// synthetic tamper\n");
		if (!validateManifest(packageDir).length)
			throw Error("Tamper negative control escaped");
		writeFileSync(codeFile, originalCode);
		const contents = Object.fromEntries(
			packageFiles(packageDir).map((f) => [
				f,
				createHash("sha256")
					.update(readFileSync(join(packageDir, f)))
					.digest("hex"),
			]),
		);
		if (sourceHash(root) !== hash)
			throw Error("Source changed during package verification");
		const report = {
			status: "passed",
			sourceHash: hash,
			artifact,
			artifactSha256: createHash("sha256")
				.update(readFileSync(join(scratch, artifact)))
				.digest("hex"),
			files: contents,
			consumers: results,
			negativeControls: [
				"missing export rejected",
				"missing guide rejected",
				"modified artifact rejected",
			],
			nodeModulesResolvedOutsideSource: relative(root, consumer).startsWith(
				"..",
			),
		};
		writeFileSync(
			join(reportDir, "package.json"),
			JSON.stringify(report, null, 2) + "\n",
		);
		console.log(JSON.stringify(report, null, 2));
		return report;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
if (import.meta.main) await verifyPackage(resolve(import.meta.dir, ".."));
