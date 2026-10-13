/** Read-only checks with dependency closure, fixed-source evidence and timings. */
import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { checkBoundaries, walkFiles } from "./boundaries.ts";
import { dependencyClosure, domainName, DOMAIN_NAMES } from "./domains.ts";
import { checkPublicSurface } from "./public-surface.ts";
import { domainTests } from "./test-domain.ts";

export type VerifyMode =
	| { readonly mode: "all" }
	| { readonly mode: "domain"; readonly domain: string };

export function parseVerifyArgs(raw: readonly string[]): VerifyMode {
	const args = raw.filter((arg) => arg !== "--");
	if (args.length === 0 || (args.length === 1 && args[0] === "--all"))
		return { mode: "all" };
	if (args.length === 2 && args[0] === "--domain")
		return { mode: "domain", domain: domainName(args[1]) };
	throw new Error("Usage: bun run verify [--all | --domain <domain>]");
}

/** Includes fixtures and configuration; ignores generated reports and outputs. Paths are hashed too. */
export function sourceHash(root: string): string {
	const hash = createHash("sha256");
	const generated =
		/^(?:node_modules|\.git|\.serena|\.claude|dist|artifacts|coverage|verification-reports)\//;
	const files = walkFiles(root)
		.filter((path) => !generated.test(relative(root, path)))
		.filter(
			(path) =>
				/\.(?:ts|tsx|js|json|jsonc|sql)$/.test(path) ||
				["bun.lock", "package.json", ".gitignore"].includes(
					relative(root, path),
				),
		)
		.sort();
	for (const file of files) {
		const path = relative(root, file);
		const content = readFileSync(file);
		hash.update(`${Buffer.byteLength(path)}:${path}:${content.byteLength}:`);
		hash.update(content);
	}
	return hash.digest("hex");
}

/** Keeps the newest `keep` run reports (names start with an ISO timestamp) and `latest.json`. */
export function pruneReports(dir: string, keep = REPORTS_KEPT): string[] {
	const runs = readdirSync(dir)
		.filter((name) => /^\d{4}-.*\.json$/.test(name))
		.sort();
	const removed = runs.slice(0, Math.max(0, runs.length - keep));
	for (const name of removed) rmSync(join(dir, name), { force: true });
	return removed;
}

const REPORTS_KEPT = 50;

interface StageResult {
	name: string;
	code: number;
	durationMs: number;
}

export async function verify(root: string, mode: VerifyMode): Promise<number> {
	const start = performance.now();
	const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
	const reportDir = join(root, "verification-reports");
	mkdirSync(reportDir, { recursive: true });
	const domains = dependencyClosure(
		mode.mode === "all" ? DOMAIN_NAMES : [mode.domain],
	);
	const before = sourceHash(root);
	const bin = (name: string) => join(root, "node_modules", ".bin", name);
	const results: StageResult[] = [];
	const spawn = async (command: string[]) =>
		await Bun.spawn(command, {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
		}).exited;
	const check = (problems: string[]) => {
		for (const problem of problems) console.error(problem);
		return problems.length === 0 ? 0 : 1;
	};
	const version = async (name: string) => {
		const child = Bun.spawn([bin(name), "--version"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0)
			throw new Error(`Cannot read ${name} version: ${error.trim()}`);
		return output.trim();
	};
	let code = 0;
	let errorMessage: string | undefined;
	let tools: Record<string, string> = {
		bun: Bun.version,
		typescript: ts.version,
	};
	try {
		const [oxfmt, oxlint] = await Promise.all([
			version("oxfmt"),
			version("oxlint"),
		]);
		tools = { ...tools, oxfmt, oxlint };
		const tests = mode.mode === "all" ? [] : domainTests(root, domains);
		if (mode.mode === "domain" && tests.length === 0)
			throw new Error(`No tests selected for ${mode.domain}`);
		// Whole-source formatting and typing also catch integration breakage in domain mode.
		const stages: { name: string; run: () => number | Promise<number> }[] = [
			{ name: "format", run: () => spawn([bin("oxfmt"), "--check"]) },
			{ name: "lint", run: () => spawn([bin("oxlint"), "--deny-warnings"]) },
			{ name: "boundaries", run: () => check(checkBoundaries(root)) },
			{
				name: "typecheck",
				run: () => spawn([bin("tsc"), "--noEmit", "-p", "tsconfig.json"]),
			},
			{
				name: "typecheck:eumenes-compat",
				run: () =>
					spawn([bin("tsc"), "--noEmit", "-p", "tsconfig.compat.json"]),
			},
			{ name: "test", run: () => spawn([process.execPath, "test", ...tests]) },
			...(mode.mode === "domain"
				? [
						{
							name: "test:shared",
							run: () =>
								spawn([
									process.execPath,
									"test",
									"src/canonical/test",
									"src/contracts/test",
									"src/infrastructure/sqlite/test",
									"test/consumer",
									"test/src-hygiene.test.ts",
									"test/public-surface.test.ts",
									"test/tooling.test.ts",
									"test/fixtures.test.ts",
									"test/scenario/sqlite-surface.test.ts",
									"test/scenario/prototype-pollution.test.ts",
								]),
						},
					]
				: []),
			{ name: "public-surface", run: () => check(checkPublicSurface(root)) },
		];
		console.log(`verify ${mode.mode}: ${domains.join(", ")}`);
		for (const stage of stages) {
			console.log(`\n==> ${stage.name}`);
			const started = performance.now();
			try {
				code = await stage.run();
			} catch (error) {
				code = 1;
				errorMessage = error instanceof Error ? error.message : String(error);
			}
			results.push({
				name: stage.name,
				code,
				durationMs: Math.round(performance.now() - started),
			});
			console.log(
				`<== ${stage.name}: ${code === 0 ? "ok" : `FAILED (exit ${code})`}`,
			);
			if (code !== 0) break;
		}
	} catch (error) {
		code = 1;
		errorMessage = error instanceof Error ? error.message : String(error);
	}
	const after = sourceHash(root);
	const unchanged = before === after;
	if (!unchanged) {
		code = 1;
		errorMessage = "Source changed during verification; rerun on stable source";
	}
	if (errorMessage !== undefined) console.error(errorMessage);
	const report = {
		runId,
		...mode,
		domains,
		status: code === 0 ? "passed" : "failed",
		code,
		sourceHashBefore: before,
		sourceHashAfter: after,
		sourceUnchanged: unchanged,
		tools,
		stages: results,
		durationMs: Math.round(performance.now() - start),
		...(errorMessage === undefined ? {} : { error: errorMessage }),
	};
	const json = JSON.stringify(report, null, 2) + "\n";
	writeFileSync(join(reportDir, `${runId}.json`), json);
	const latestTemp = join(reportDir, `${runId}.latest.tmp`);
	writeFileSync(latestTemp, json);
	renameSync(latestTemp, join(reportDir, "latest.json"));
	pruneReports(reportDir);
	console.log(
		`\nverify ${report.status}; report: verification-reports/${runId}.json`,
	);
	return code;
}

if (import.meta.main) {
	try {
		process.exitCode = await verify(
			join(import.meta.dir, ".."),
			parseVerifyArgs(process.argv.slice(2)),
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
