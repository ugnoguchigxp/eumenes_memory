/**
 * 実モデル評価（E 段階）の実行。verify・`bun test` から呼ばない。手順は `eval/README.md`。
 *
 *   bun eval/run.ts --adapter <module path> --name <run name> [--split dev|test|all]
 *                   [--repeats N] [--thresholds <json>] [--timeout-ms N] [--out-dir <dir>]
 *
 * 結果は `<out-dir>/<name>.json`（既定 `eval/results/`）。時刻を使わないので、実行名は引数で決める。
 * 閾値ファイルを渡して不合格なら exit code 2（結果は書く）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadAdapter } from "./lib/adapter.ts";
import { DATASET_PATH, loadDataset } from "./lib/dataset.ts";
import { runEval, sha256Text } from "./lib/runner.ts";
import { loadThresholds } from "./lib/thresholds.ts";
import { SPLITS } from "./lib/types.ts";
import type { Split } from "./lib/types.ts";
import { readFileSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");

function usage(message: string): never {
	console.error(message);
	console.error(
		"usage: bun eval/run.ts --adapter <path> --name <name> [--split dev|test|all] [--repeats N] [--thresholds <json>] [--timeout-ms N] [--out-dir <dir>]",
	);
	process.exit(64);
}

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		adapter: { type: "string" },
		name: { type: "string" },
		split: { type: "string", default: "all" },
		repeats: { type: "string", default: "1" },
		thresholds: { type: "string" },
		"timeout-ms": { type: "string", default: "120000" },
		"out-dir": { type: "string", default: join(ROOT, "eval", "results") },
	},
	strict: true,
});

const adapterArg = values.adapter;
const name = values.name;
if (adapterArg === undefined) usage("--adapter is required");
if (name === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u.test(name)) {
	usage(
		"--name is required (letters, digits, '.', '_', '-'; no path separators)",
	);
}
const splitArg = values.split;
if (splitArg !== "all" && !(SPLITS as readonly string[]).includes(splitArg)) {
	usage("--split must be dev, test or all");
}
const repeats = Number(values.repeats);
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isInteger(repeats) || repeats < 1)
	usage("--repeats must be a positive integer");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
	usage("--timeout-ms must be a positive integer");

const adapterPath = resolve(adapterArg);
const adapter = await loadAdapter(adapterPath);
const datasetText = readFileSync(DATASET_PATH, "utf8");
const cases = loadDataset(DATASET_PATH);
const thresholdsLoaded =
	values.thresholds === undefined
		? undefined
		: loadThresholds(resolve(values.thresholds));

const report = await runEval({
	name,
	cases,
	datasetSha256: sha256Text(datasetText),
	datasetPath: relative(ROOT, DATASET_PATH),
	adapter,
	adapterPath: relative(ROOT, adapterPath),
	repeats,
	split: splitArg as Split | "all",
	timeoutMs,
	...(thresholdsLoaded === undefined || values.thresholds === undefined
		? {}
		: {
				thresholds: thresholdsLoaded.thresholds,
				thresholdsPath: relative(ROOT, resolve(values.thresholds)),
				thresholdsSha256: sha256Text(thresholdsLoaded.text),
			}),
});

const outDir = resolve(values["out-dir"]);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${name}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, "\t")}\n`);
// 書式をリポジトリの oxfmt に合わせる（無ければそのまま）。結果の内容は変えない。
const formatter = join(ROOT, "node_modules", ".bin", "oxfmt");
if (await Bun.file(formatter).exists()) {
	const child = Bun.spawn([formatter, "--write", outPath], {
		cwd: ROOT,
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	await child.exited;
}

const overall = report.overall.worst;
console.log(
	`eval ${name}: ${report.dataset.cases} cases x ${repeats} repeat(s)`,
);
console.log(
	`  recall=${overall.candidateRecall} fullMatch=${overall.fullMatchRate} polarityErrors=${overall.polarityErrors} ` +
		`modalityErrors=${overall.modalityErrors} subjectErrors=${overall.subjectErrors} overExtracted=${overall.overExtracted} ` +
		`quoteMismatchRate=${overall.quoteMismatchRate} noChangeAccuracy=${overall.noChangeAccuracy} falseAdmissions=${overall.falseAdmissions}`,
);
console.log(`  eStageEligible=${report.claims.eStageEligible}`);
console.log(`  wrote ${relative(ROOT, outPath)}`);
if (report.thresholds !== null && !report.thresholds.pass) {
	console.error(`  thresholds FAILED (${report.thresholds.failures.length})`);
	process.exit(2);
}
