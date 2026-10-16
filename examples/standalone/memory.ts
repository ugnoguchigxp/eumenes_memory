import { readFileSync } from "node:fs";
import { StandaloneHost } from "./host.ts";
import { withLuna } from "./luna.ts";
import {
	planMemory,
	planningInstructions,
	type MemoryPlan,
} from "./planning.ts";
import { applyMemoryPlan } from "./execution.ts";

/** Application entry: planning is read-only; applying an explicit saved plan uses durable execution. */
export async function memoryCommand(
	args: string[],
	withModel: typeof withLuna = withLuna,
) {
	const [directory, command, value, planPath] = args;
	if (
		!directory ||
		!value ||
		!(
			(command === "plan" && args.length === 3) ||
			(command === "apply" && args.length === 4)
		)
	)
		throw Error(
			"Usage: bun run memory <directory> plan <message> | <directory> apply <operation-id> <saved-plan.json>",
		);
	const host = new StandaloneHost(directory);
	try {
		if (command === "plan")
			return await withModel((complete) => planMemory(host, value, complete), {
				decide: planningInstructions,
			});
		const plan = JSON.parse(readFileSync(planPath!, "utf8")) as MemoryPlan;
		return applyMemoryPlan(host, value, plan);
	} finally {
		host.close();
	}
}

if (import.meta.main) {
	try {
		const result = await memoryCommand(process.argv.slice(2));
		console.log(JSON.stringify(result, null, 2));
		if ("status" in result && ["partial", "failed"].includes(result.status))
			process.exitCode = 1;
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
