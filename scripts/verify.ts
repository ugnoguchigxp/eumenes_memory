/**
 * `bun run verify` の本体。format → lint → typecheck → Eumenes 互換 typecheck →
 * eval の typecheck → test → public-surface を順に実行し、失敗したステップ名を表示して非 0 で終了する。
 * 自分自身や `bun run verify` は呼ばない。レポートファイルは書かない。
 */
import { join } from "node:path";
import { checkPublicSurface } from "./public-surface.ts";

const ROOT = join(import.meta.dir, "..");
const bin = (name: string) => join(ROOT, "node_modules", ".bin", name);

interface Step {
	readonly name: string;
	readonly run: () => Promise<number> | number;
}

async function spawn(command: readonly string[]): Promise<number> {
	const child = Bun.spawn([...command], {
		cwd: ROOT,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	return await child.exited;
}

const STEPS: readonly Step[] = [
	{ name: "format", run: () => spawn([bin("oxfmt"), "--check"]) },
	{ name: "lint", run: () => spawn([bin("oxlint"), "--deny-warnings"]) },
	{
		name: "typecheck",
		run: () => spawn([bin("tsc"), "--noEmit", "-p", "tsconfig.json"]),
	},
	{
		name: "typecheck:eumenes-compat",
		run: () => spawn([bin("tsc"), "--noEmit", "-p", "tsconfig.compat.json"]),
	},
	{
		name: "typecheck:eval",
		run: () => spawn([bin("tsc"), "--noEmit", "-p", "eval/tsconfig.json"]),
	},
	{ name: "test", run: () => spawn([process.execPath, "test"]) },
	{
		name: "public-surface",
		run: () => {
			const problems = checkPublicSurface(ROOT);
			for (const problem of problems) console.error(problem);
			return problems.length === 0 ? 0 : 1;
		},
	},
];

const results: { name: string; code: number }[] = [];
for (const step of STEPS) {
	console.log(`\n==> ${step.name}`);
	const code = await step.run();
	results.push({ name: step.name, code });
	console.log(
		`<== ${step.name}: ${code === 0 ? "ok" : `FAILED (exit ${code})`}`,
	);
	if (code !== 0) {
		console.error(`\nverify failed at step: ${step.name}`);
		process.exit(code);
	}
}
console.log(`\nverify ok: ${results.map((r) => r.name).join(", ")}`);
