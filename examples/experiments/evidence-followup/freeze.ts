import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { suites } from "./cases.ts";
import { baseline, semantic, output as outputPrompt } from "./prompts.ts";
import { groundingInstructions } from "../../standalone/retrieval.ts";
import { evidenceSchema } from "../../standalone/support.ts";
const [stage, priorPath, output] = process.argv.slice(2);
if (
	!stage ||
	!["A", "B"].includes(stage) ||
	!priorPath ||
	!output ||
	existsSync(output)
)
	throw Error("Usage: freeze.ts A|B prior.json new-design.json");
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const source = (p: string) =>
	createHash("sha256")
		.update(readFileSync(new URL(p, import.meta.url)))
		.digest("hex");
const registration = JSON.parse(
	readFileSync(new URL("registration.json", import.meta.url), "utf8"),
);
for (const [file, h] of Object.entries(registration.sourceHashes))
	if (source(file) !== h) throw Error(`Registration changed: ${file}`);
const prior = JSON.parse(readFileSync(priorPath, "utf8"));
if (
	hash(prior) !==
	"7aa925f309da5286a80ea57539560677e90bd05c6ff65ddab90ec63cc1ed7219"
)
	throw Error("Unexpected prior design");
const questions = new Set(
	[...prior.holdout, ...prior.regression].map(
		(x: { message: string }) => x.message,
	),
);
for (const c of [...suites["A"]!, ...suites["B"]!]) {
	if (questions.has(c.message)) throw Error(`Reused question ${c.message}`);
	questions.add(c.message);
}
if (stage === "A" && groundingInstructions !== baseline)
	throw Error("Unexpected initial instruction");
if (
	stage === "B" &&
	groundingInstructions !== baseline &&
	groundingInstructions !== semantic(baseline)
)
	throw Error("Unexpected second-stage baseline");
const before = groundingInstructions;
const after = stage === "A" ? semantic(before) : outputPrompt(before);
if (before === after) throw Error("No instruction change");
const design = {
	version: 2,
	stage,
	createdAt: new Date().toISOString(),
	model: "gpt-6-luna",
	reasoning: "medium",
	concurrency: 4,
	repetitions: 1,
	criteria: {
		minNetGain: 5,
		maxTokenRatio: 1.1,
		maxMedianLatencyRatio: 1.25,
		familySignP: 0.025,
		maxNetRegressionLoss: 0,
	},
	instructions: { before, after },
	schema: evidenceSchema,
	holdout: suites[stage],
	regression: prior.holdout.map((c: { id: string }) => ({
		...c,
		id: `regression-R${c.id.slice(1)}`,
	})),
	priorDesignHash: hash(prior),
	priorIdMapping: "regression-RNNN = original HNNN; input and gold unchanged",
	sourceHashes: registration.sourceHashes,
	runtimeHash: source("../../standalone/retrieval.ts"),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(design, null, 2) + "\n");
const manifest = {
	hash: hash(design),
	stage,
	createdAt: design.createdAt,
	counts: [100, 100],
	sourceHashes: design.sourceHashes,
	runtimeHash: design.runtimeHash,
};
writeFileSync(
	output + ".manifest.json",
	JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest));
