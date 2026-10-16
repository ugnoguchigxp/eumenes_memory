import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { holdoutCases } from "./cases.ts";
import { suites } from "../evidence-followup/cases.ts";
import { groundingInstructions as before } from "./baseline.ts";
import { groundingInstructions as after } from "./candidate.ts";
import { groundingInstructions } from "../../standalone/retrieval.ts";
import { evidenceSchema } from "../../standalone/support.ts";
const [priorPath, output] = process.argv.slice(2);
if (!priorPath || !output || existsSync(output))
	throw Error("Usage: freeze.ts prior.json new-design.json");
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const source = (p: string) =>
	createHash("sha256")
		.update(readFileSync(new URL(p, import.meta.url)))
		.digest("hex");
const prior = JSON.parse(readFileSync(priorPath, "utf8"));
if (
	hash(prior) !==
	"7aa925f309da5286a80ea57539560677e90bd05c6ff65ddab90ec63cc1ed7219"
)
	throw Error("Prior design changed");
if (before !== groundingInstructions || after.length >= before.length)
	throw Error("Unexpected instruction baseline/expansion");
const previous = [
	...prior.holdout,
	...prior.regression,
	...suites["A"]!,
	...suites["B"]!,
];
const questions = new Set(previous.map((x) => x.message));
for (const c of holdoutCases) {
	if (questions.has(c.message)) throw Error(`Reused question ${c.id}`);
	questions.add(c.message);
}
const files = [
	"cases.ts",
	"baseline.ts",
	"candidate.ts",
	"run.ts",
	"freeze.ts",
	"analyze.ts",
	"recover.ts",
	"PREREGISTRATION.md",
	"../evidence-followup/cases.ts",
	"../evidence-followup/score.ts",
	"../experiment.ts",
	"../../standalone/luna.ts",
	"../../standalone/support.ts",
	"../../standalone/model-input.ts",
	"../../standalone/protocol.ts",
];
const design = {
	version: 3,
	stage: "representation",
	createdAt: new Date().toISOString(),
	model: "gpt-6-luna",
	reasoning: "medium",
	concurrency: 4,
	repetitions: 1,
	criteria: {
		minNetGain: 5,
		maxTokenRatio: 1.1,
		maxMedianLatencyRatio: 1.25,
		familySignP: 0.05,
		maxNetRegressionLoss: 0,
	},
	instructions: { before, after },
	schema: evidenceSchema,
	holdout: holdoutCases,
	regression: previous.map((c, index) => ({
		...c,
		id: `regression-R${String(index + 1).padStart(3, "0")}`,
	})),
	priorDesignHash: hash(prior),
	priorIdMapping:
		"R001-100 = original H001-100; R101-120 = original regression order; R121-220 = A H001-100; R221-320 = B H001-100. Facts, order and gold unchanged.",
	sourceHashes: Object.fromEntries(files.map((p) => [p, source(p)])),
	runtimeHash: source("../../standalone/retrieval.ts"),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(design, null, 2) + "\n");
writeFileSync(
	output + ".manifest.json",
	JSON.stringify(
		{
			hash: hash(design),
			counts: [design.holdout.length, design.regression.length],
			sourceHashes: design.sourceHashes,
			runtimeHash: design.runtimeHash,
		},
		null,
		2,
	) + "\n",
);
console.log(
	JSON.stringify({
		hash: hash(design),
		counts: [design.holdout.length, design.regression.length],
	}),
);
