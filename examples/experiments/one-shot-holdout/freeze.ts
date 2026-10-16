import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { holdoutCases } from "./cases.ts";
import { groundingInstructions as before } from "../frozen-retrieval.ts";
import { groundingInstructions as after } from "../../standalone/retrieval.ts";
import { evidenceSchema } from "../../standalone/support.ts";
const [priorPath, output] = process.argv.slice(2);
if (!priorPath || !output || existsSync(output))
	throw Error(
		"Usage: freeze.ts <prior-corrected-design.json> <new-design.json>",
	);
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const prior = JSON.parse(readFileSync(priorPath, "utf8"));
if (
	hash(prior) !==
	"c8daea8ed9d430b1fe1b263741ed59f2f010bf78f183c60e9ade7504f47530b5"
)
	throw Error("Unexpected prior dataset");
const oldQuestions = new Set(
	prior.retrieval.map((c: { message: string }) => c.message),
);
if (holdoutCases.some((c) => oldQuestions.has(c.message)))
	throw Error("Question reused");
const regressionIds = [
	"R039",
	"R040",
	"R056",
	"R060",
	"R082",
	"R083",
	"R084",
	"R086",
	"R087",
	"R088",
	"R090",
	"R001",
	"R006",
	"R011",
	"R016",
	"R021",
	"R046",
	"R051",
	"R066",
	"R071",
];
const regression = regressionIds.map((id) => {
	const c = prior.retrieval.find((x: { id: string }) => x.id === id);
	if (!c) throw Error("Missing regression");
	return {
		...c,
		id: `regression-${id}`,
		parts: c.parts.map((p: { status: string; ids: string[] }) => ({
			status: p.status,
			requiredIds: p.ids,
			allowedIds: p.ids,
		})),
	};
});
const design = {
	version: 1,
	createdAt: new Date().toISOString(),
	model: "gpt-6-luna",
	reasoning: "medium",
	concurrency: 4,
	repetitions: 1,
	criteria: {
		minNetGain: 5,
		maxTokenRatio: 1.5,
		maxMedianLatencyRatio: 1.5,
		familySignP: 0.05,
		maxNetRegressionLoss: 0,
	},
	provenance:
		"100 separately authored synthetic cases in 25 related families; not independent human-authored conversations. 20 prior regressions reported separately.",
	scoring:
		"Ordered part status and required evidence must match; optional context predeclared per part, all other IDs forbidden. Request wording ignored. No LLM grader; no semantic rerolls. Errors fail and are reported separately.",
	instructions: { before, after },
	schema: evidenceSchema,
	holdout: holdoutCases,
	regression,
	sourceHashes: Object.fromEntries(
		["cases.ts", "score.ts", "run.ts", "freeze.ts"].map((p) => [
			p,
			createHash("sha256")
				.update(readFileSync(new URL(p, import.meta.url)))
				.digest("hex"),
		]),
	),
	runtimeHash: createHash("sha256")
		.update(
			readFileSync(new URL("../../standalone/retrieval.ts", import.meta.url)),
		)
		.digest("hex"),
	priorDesignHash: hash(prior),
};
if (String(before) === String(after))
	throw Error("Candidate instruction has not changed");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(design, null, 2) + "\n");
writeFileSync(
	output + ".manifest.json",
	JSON.stringify(
		{
			hash: hash(design),
			runtimeHash: design.runtimeHash,
			sourceHashes: design.sourceHashes,
			counts: [100, 20],
			createdAt: design.createdAt,
		},
		null,
		2,
	) + "\n",
);
console.log(JSON.stringify({ hash: hash(design), counts: [100, 20] }));
