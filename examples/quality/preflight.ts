import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiComplete, MODELS, type Provider } from "./api.ts";
import { Budget, liability } from "./budget.ts";
const directory = join(
	import.meta.dir,
	"../../verification-reports/quality-80",
);
mkdirSync(directory, { recursive: true });
const budget = new Budget(join(directory, "cost-ledger.json"));
const results = [];
for (const provider of ["openai", "claude"] as Provider[]) {
	try {
		const result = await apiComplete({
			provider,
			budget,
			logPath: join(directory, "calls.jsonl"),
			maxOutput: 256,
			instructions: { recall: 'Return {"ok":true} as JSON.' },
		})(
			"Synthetic connectivity check. No user data.",
			{
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			},
			"recall",
		);
		results.push({
			provider,
			model: MODELS[provider],
			status: "passed",
			value: JSON.parse(result.raw),
			usage: result.usage,
		});
	} catch (e) {
		results.push({
			provider,
			model: MODELS[provider],
			status: "failed",
			error: String(e),
		});
	}
}
writeFileSync(
	join(directory, "preflight.json"),
	JSON.stringify(
		{ results, costLiabilityUsd: liability(budget.snapshot()) },
		null,
		2,
	),
);
console.log(
	JSON.stringify(
		{ results, costLiabilityUsd: liability(budget.snapshot()) },
		null,
		2,
	),
);
if (results.some((x) => x.status !== "passed")) process.exitCode = 1;
