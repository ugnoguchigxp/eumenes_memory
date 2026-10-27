import { StandaloneHost } from "../standalone/host.ts";
import { loadSeedData, seedSummary } from "./data.ts";
import { importSeedData } from "./import.ts";

export function seedCommand(args: readonly string[]) {
	const [command, directory, path] = args;
	if (command === "inspect" && args.length <= 2) {
		const seeds = loadSeedData(directory);
		return { summary: seedSummary(seeds), seeds };
	}
	if (command !== "load" || !directory || args.length < 2 || args.length > 3)
		throw Error(
			"Usage: bun run memory:seed inspect [seed.jsonl] | load <directory> [seed.jsonl]",
		);
	const seeds = loadSeedData(path);
	const host = new StandaloneHost(directory);
	try {
		return importSeedData(host, seeds);
	} finally {
		host.close();
	}
}

if (import.meta.main) {
	try {
		console.log(JSON.stringify(seedCommand(process.argv.slice(2)), null, 2));
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
