import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allControls } from "./context-controls.ts";
import type { SemanticControl } from "./control-cases.ts";
import { withLuna, MODEL, SDK_VERSION } from "./luna.ts";
import { comparisonGroups } from "./model-input.ts";
import {
	INSTRUCTIONS,
	judgeOutputSchema,
	parseJudgment,
	PROMPT_VERSION,
} from "./protocol.ts";
import type { Complete, ModelResult } from "./protocol.ts";
import { newRunDirectory } from "./runner.ts";

interface ControlTrial {
	name: string;
	repetition: number;
	expectedPassed: boolean;
	prompt: string;
	outputSchema: unknown;
	response?: ModelResult;
	judgment?: ReturnType<typeof parseJudgment>;
	matched?: boolean;
	error?: string;
	phase: "provider" | "contract" | "complete";
}

/** Fixed verdict controls exercise the real judge without a writer changing its input. */
export async function runControls(
	directory: string,
	complete: Complete,
	repetitions = 3,
	cases: readonly SemanticControl[] = allControls,
) {
	if (!Number.isSafeInteger(repetitions) || repetitions < 1)
		throw new Error("Repetitions must be a positive integer");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const configuration = {
		instructions: INSTRUCTIONS.judge,
		cases,
		repetitions,
	};
	const report: {
		status: "running" | "passed" | "failed";
		model: string;
		sdkVersion: string;
		promptVersion: string;
		inputHash: string;
		configuration: typeof configuration;
		plannedTrials: number;
		trials: ControlTrial[];
		error?: string;
	} = {
		status: "running",
		model: MODEL,
		sdkVersion: SDK_VERSION,
		promptVersion: PROMPT_VERSION,
		inputHash: createHash("sha256")
			.update(JSON.stringify(configuration))
			.digest("hex"),
		configuration,
		plannedTrials: cases.length * repetitions,
		trials: [],
	};
	const save = () =>
		writeFileSync(
			join(directory, "controls.json"),
			JSON.stringify(report, null, 2) + "\n",
			{ mode: 0o600 },
		);
	save();
	for (let repetition = 1; repetition <= repetitions; repetition++) {
		for (const control of cases) {
			const groups = comparisonGroups(
				control.groups,
				"criterion" in control && typeof control.criterion === "string"
					? control.criterion
					: undefined,
			);
			const trial: ControlTrial = {
				name: control.name,
				repetition,
				expectedPassed: control.expectedPassed,
				prompt: JSON.stringify({
					task: "judge",
					groups,
				}),
				outputSchema: judgeOutputSchema(groups),
				phase: "provider",
			};
			report.trials.push(trial);
			save();
			try {
				trial.response = await complete(
					trial.prompt,
					trial.outputSchema,
					"judge",
				);
				trial.phase = "contract";
				trial.judgment = parseJudgment(trial.response.raw, groups);
				trial.matched = trial.judgment.passed === control.expectedPassed;
				trial.phase = "complete";
				save();
			} catch (error) {
				trial.error = String(error);
				if (trial.phase === "contract") {
					trial.matched = false;
					// A malformed verdict fails this trial; independent trials still run.
					save();
					continue;
				}
				report.error = String(error);
				report.status = "failed";
				save();
				return report;
			}
		}
	}
	report.status = report.trials.every((trial) => trial.matched)
		? "passed"
		: "failed";
	save();
	return report;
}

if (import.meta.main) {
	const directory =
		process.argv[2] ?? newRunDirectory(join(import.meta.dir, "../.."));
	console.log(
		`Semantic controls: live; report: ${join(directory, "controls.json")}`,
	);
	try {
		const report = await withLuna((complete) =>
			runControls(directory, complete),
		);
		console.log(
			`${report.status}: ${report.trials.filter((trial) => trial.matched).length}/${report.plannedTrials} planned verdicts matched`,
		);
		process.exitCode = report.status === "passed" ? 0 : 1;
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
