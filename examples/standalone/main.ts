import { join } from "node:path";
import { withLuna } from "./luna.ts";
import { newRunDirectory, runChecks } from "./runner.ts";
import { scenarios } from "./scenarios.ts";
import { conversationScenarios } from "./conversations.ts";
import { holdoutScenarios } from "./holdout.ts";

export function parseArgs(args: string[]): {
	mode: "offline" | "live";
	suite: "basic" | "conversation" | "holdout" | "all";
	scenario?: string;
} {
	let mode: "offline" | "live" = "offline";
	let suite: "basic" | "conversation" | "holdout" | "all" = "basic";
	let scenario: string | undefined;
	let modeSet = false;
	let suiteSet = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if ((arg === "--live" || arg === "--offline") && !modeSet) {
			mode = arg === "--live" ? "live" : "offline";
			modeSet = true;
		} else if (
			arg === "--suite" &&
			!suiteSet &&
			["basic", "conversation", "holdout", "all"].includes(args[i + 1] ?? "")
		) {
			suite = args[++i] as typeof suite;
			suiteSet = true;
		} else if (
			arg === "--scenario" &&
			scenario === undefined &&
			args[i + 1] !== undefined &&
			!args[i + 1]!.startsWith("--")
		) {
			scenario = args[++i];
		} else
			throw new Error(
				"Usage: bun run check:memory [--offline | --live] [--suite basic|conversation|holdout|all] [--scenario <id>]",
			);
	}
	return { mode, suite, ...(scenario === undefined ? {} : { scenario }) };
}

if (import.meta.main) {
	try {
		const args = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
		const { mode } = args;
		const suite =
			args.suite === "basic"
				? scenarios
				: args.suite === "conversation"
					? conversationScenarios
					: args.suite === "holdout"
						? holdoutScenarios
						: [...scenarios, ...conversationScenarios, ...holdoutScenarios];
		const cases =
			args.scenario === undefined
				? suite
				: suite.filter((scenario) => scenario.id === args.scenario);
		if (cases.length === 0)
			throw new Error("No matching scenario in selected suite");
		const directory = newRunDirectory(join(import.meta.dir, "../.."));
		console.log(
			`Memory check: ${mode}; report: ${join(directory, "report.json")}`,
		);
		const result = await runChecks({
			directory,
			mode,
			cases,
			withModel: withLuna,
			log: console.log,
		});
		console.log(
			`${result.status}: ${result.checks.filter((check) => check.status === "passed").length}/${result.plannedChecks} planned checks; scenarios: ${result.scenarios.filter((scenario) => scenario.status === "passed").length}/${result.scenarios.length}; model calls: ${mode === "live" ? result.turns.length : 0}`,
		);
		if (result.error) console.error(result.error);
		process.exitCode = result.status === "passed" ? 0 : 1;
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
