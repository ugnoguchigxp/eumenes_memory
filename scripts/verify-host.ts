import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { packHost, runHostCommand } from "./pack-host.ts";
import { sourceHash } from "./verify.ts";
import { validateManifest } from "./verify-package.ts";
export async function verifyHost(root: string) {
	const hash = sourceHash(root);
	const scratch = mkdtempSync(join(tmpdir(), "em-consumer-"));
	const reportDir = join(root, "verification-reports/host");
	mkdirSync(reportDir, { recursive: true });
	try {
		await runHostCommand([process.execPath, "run", "build:host"], root);
		await runHostCommand(
			[
				join(root, "node_modules/.bin/tsc"),
				"--noEmit",
				"-p",
				"packages/host/tsconfig.json",
			],
			root,
		);
		const tests = await runHostCommand(
			[process.execPath, "test", "packages/host/test"],
			root,
		);
		const artifact = await packHost(root, join(root, "artifacts/host"));
		writeFileSync(
			join(scratch, "package.json"),
			JSON.stringify({
				private: true,
				type: "module",
				dependencies: {
					"eumenes-memory-host": `file:${artifact}`,
					"@modelcontextprotocol/client": "2.4.0",
					"@modelcontextprotocol/sdk": "1.32.2",
					"@types/bun": "1.3.14",
				},
			}),
		);
		await runHostCommand(
			[process.execPath, "install", "--ignore-scripts"],
			scratch,
		);
		writeFileSync(
			join(scratch, "consumer.ts"),
			`import {MemoryHost,type AppPort,type HostConfig} from "eumenes-memory-host";
import {hostPlanningInstructions} from "eumenes-memory-host/meaning/planning";
export function check(port:AppPort,configuration:()=>HostConfig){const host=new MemoryHost({port,configuration});
// @ts-expect-error the credential is a string
host.dispatch(3,"status",{});
port.read(db=>{
// @ts-expect-error a public MemoryDb has no arbitrary field
return db.no_such_driver_field;
});return hostPlanningInstructions+host.epoch;}`,
		);
		await runHostCommand(
			[
				join(root, "node_modules/.bin/tsc"),
				"--noEmit",
				"--strict",
				"--skipLibCheck",
				"--moduleResolution",
				"Bundler",
				"--module",
				"ESNext",
				"--target",
				"ES2022",
				"--types",
				"bun",
				"consumer.ts",
			],
			scratch,
		);

		const unpack = join(scratch, "archive");
		mkdirSync(unpack);
		await runHostCommand(["tar", "-xzf", artifact, "-C", unpack], scratch);
		const archived = join(unpack, "package");
		const problems = validateManifest(archived);
		if (problems.length) throw Error(problems.join("\n"));
		const installed = join(scratch, "node_modules/eumenes-memory-host");
		const manifest = JSON.parse(
			readFileSync(join(archived, "dist/release-manifest.json"), "utf8"),
		) as { files: Record<string, string> };
		const installedMatches = () =>
			Object.entries(manifest.files).every(
				([file, digest]) =>
					createHash("sha256")
						.update(readFileSync(join(installed, file)))
						.digest("hex") === digest,
			);
		if (!installedMatches())
			throw Error("Installed code differs from the verified archive");
		const entry = join(installed, "dist/cli.js");
		const check = join(scratch, "consumer.test.ts");
		cpSync(join(root, "packages/host/test/process.test.ts"), check);
		const text = readFileSync(check, "utf8").replace(
			'import type { HostResult } from "../src/contracts.ts";',
			"type HostResult = {status:string;code?:string;[key:string]:unknown};",
		);
		writeFileSync(check, text);
		const legacy = join(scratch, "consumer-legacy.test.ts");
		writeFileSync(
			legacy,
			text
				.replace(
					'"@modelcontextprotocol/client"',
					'"@modelcontextprotocol/sdk/client/index.js"',
				)
				.replace(
					'"@modelcontextprotocol/client/stdio"',
					'"@modelcontextprotocol/sdk/client/stdio.js"',
				),
		);
		const child = Bun.spawn([process.execPath, "test", check, legacy], {
			cwd: scratch,
			env: { ...process.env, MEMORY_HOST_CLI: entry },
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [output, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code) throw Error(output + error);
		await runHostCommand([process.execPath, entry, "--help"], scratch);
		await runHostCommand(
			[process.execPath, "x", "--no-install", "eumenes-memory", "--help"],
			scratch,
		);
		const source = join(installed, "dist/cli.js"),
			original = readFileSync(source, "utf8");
		writeFileSync(source, original + "\n// verification tamper\n");
		if (installedMatches()) throw Error("Tamper negative control failed");
		writeFileSync(source, original);
		if (sourceHash(root) !== hash)
			throw Error("Source changed during host verification");
		const report = {
			status: "passed",
			sourceHash: hash,
			artifact,
			artifactSha256: createHash("sha256")
				.update(readFileSync(artifact))
				.digest("hex"),
			runtime: Bun.version,
			mcpSdk: "2.4.0",
			legacyClient: "1.32.2",
			isolatedInstall: true,
			typedConsumer: true,
			tests: tests.trim(),
			consumer: (output + error).trim(),
			negativeControls: ["modified artifact rejected"],
			application: process.env["EUMENES_CHECKOUT"]
				? "actual checkout fixture tested"
				: "separate opt-in EUMENES_CHECKOUT test required",
		};
		writeFileSync(
			join(reportDir, "package.json"),
			JSON.stringify(report, null, 2) + "\n",
		);
		console.log(JSON.stringify(report, null, 2));
		return report;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
if (import.meta.main) await verifyHost(resolve(import.meta.dir, ".."));
