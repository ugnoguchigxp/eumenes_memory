import { readFileSync } from "node:fs";
import {
	Experiment,
	hash,
	parallel,
	variants,
	withVariants,
} from "./experiment.ts";
import type { Observation } from "./experiment.ts";
import { parseJudgment } from "./frozen-protocol.ts";

export function correctJudgeInput(input: unknown): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		!("expected" in input) ||
		!Array.isArray(input.expected)
	)
		throw Error("Missing expected facts");
	return {
		...input,
		expected: input.expected.map((fact: Record<string, unknown>) => {
			const { semanticKey: _removed, ...rest } = fact;
			return rest;
		}),
	};
}
export async function regrade(source: string, directory: string) {
	const original = JSON.parse(readFileSync(source, "utf8")) as {
		status: string;
		observations: Observation[];
		results: Record<string, unknown>[];
	};
	if (original.status === "running")
		throw Error("Generation experiment must finish first");
	const generated = original.observations.filter((o) => o.task !== "judge");
	if (generated.length !== 54 || generated.some((o) => !o.response))
		throw Error("All 54 generation observations must be available");
	const rows = original.observations.filter((o) => o.task === "judge");
	const exp = new Experiment(directory, "factorial-corrected-judge", {
		source,
		sourceHash: hash(original),
		sourceStatus: original.status,
		missingOriginalJudgeResponses: original.observations.filter(
			(o) => o.task === "judge" && !o.response,
		).length,
		correction:
			"Remove synthetic semanticKey from expected facts, restoring standalone runner's original expected contract. All actual generated outputs, gold text, schemas and instructions stay fixed; earlier semantic grades are invalid for comparison and retained as diagnostics.",
		calls: rows.map((o) => ({
			id: o.id,
			variant: o.variant,
			input: correctJudgeInput(o.input),
		})),
	});
	try {
		await withVariants(async (clients) => {
			await parallel(
				rows.map((o) => async () => {
					if (o.variant !== "v9" && o.variant !== "v10")
						throw Error("Unknown judge variant");
					const raw = await exp.call(
						clients[o.variant],
						o.variant,
						variants[o.variant].instructions,
						o.id,
						correctJudgeInput(o.input),
						o.schema,
						"judge",
					);
					exp.result({ id: o.id, judge: o.variant, ...parseJudgment(raw) });
				}),
				2,
			);
		});
		exp.save("completed");
	} catch (error) {
		exp.save("failed", String(error));
		throw error;
	}
}
if (import.meta.main) {
	if (!process.argv[2] || !process.argv[3])
		throw Error(
			"Usage: bun examples/experiments/regrade.ts <original-report> <output-directory>",
		);
	await regrade(process.argv[2], process.argv[3]);
}
