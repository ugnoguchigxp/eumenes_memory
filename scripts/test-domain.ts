import { join } from "node:path";
import { domainName, testOwnedBy } from "./domains.ts";
import { walkFiles } from "./boundaries.ts";

export function domainTests(root: string, names: readonly string[]): string[] {
	const domains = names.map(domainName);
	return [
		...walkFiles(join(root, "src", "domains")),
		...walkFiles(join(root, "test", "scenario")),
	]
		.filter((path) => path.endsWith(".test.ts"))
		.filter((path) =>
			domains.some((domain) =>
				testOwnedBy(path.slice(root.length + 1), domain),
			),
		)
		.sort();
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2).filter((arg) => arg !== "--");
		if (args.length !== 1)
			throw new Error("Usage: bun run test:domain -- <domain>");
		const domain = domainName(args[0]);
		const root = join(import.meta.dir, "..");
		const tests = domainTests(root, [domain]);
		if (!tests.length) throw new Error(`No tests owned by ${domain}`);
		process.exitCode = await Bun.spawn([process.execPath, "test", ...tests], {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
		}).exited;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
