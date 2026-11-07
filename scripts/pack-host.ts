import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sourceHash } from "./verify.ts";
export async function runHostCommand(
	args: string[],
	cwd: string,
): Promise<string> {
	const child = Bun.spawn(args, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code) throw Error(`${args[0]} failed (${code}):\n${stdout}\n${stderr}`);
	return stdout + stderr;
}
export async function packHost(
	root: string,
	destination: string,
): Promise<string> {
	const host = join(root, "packages/host");
	const stage = mkdtempSync(join(tmpdir(), "em-pack-"));
	mkdirSync(destination, { recursive: true });
	try {
		const vendor = join(stage, "vendor");
		mkdirSync(vendor);
		await runHostCommand(
			[process.execPath, "pm", "pack", "--destination", vendor],
			root,
		);
		await runHostCommand([process.execPath, "run", "build"], host);
		cpSync(join(host, "dist"), join(stage, "dist"), { recursive: true });
		for (const file of ["README.md", "LICENSE"])
			cpSync(join(host, file), join(stage, file));
		const pkg = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));

		delete pkg.devDependencies;
		delete pkg.scripts;
		rmSync(vendor, { recursive: true, force: true });
		writeFileSync(
			join(stage, "package.json"),
			JSON.stringify(pkg, null, 2) + "\n",
		);
		const walk = (base: string, prefix = ""): string[] =>
			readdirSync(join(base, prefix), { withFileTypes: true })
				.flatMap((e) =>
					e.isDirectory()
						? walk(base, join(prefix, e.name))
						: [join(prefix, e.name)],
				)
				.sort();
		writeFileSync(
			join(stage, "dist/release-manifest.json"),
			JSON.stringify(
				{
					version: 1,
					sourceHash: sourceHash(root),
					files: Object.fromEntries(
						walk(stage).map((f) => [
							f,
							createHash("sha256")
								.update(readFileSync(join(stage, f)))
								.digest("hex"),
						]),
					),
				},
				null,
				2,
			) + "\n",
		);
		await runHostCommand(
			[process.execPath, "pm", "pack", "--destination", destination],
			stage,
		);
		return join(destination, `${pkg.name}-${pkg.version}.tgz`);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}
if (import.meta.main)
	console.log(
		await packHost(
			resolve(import.meta.dir, ".."),
			resolve(process.argv[2] ?? "artifacts/host"),
		),
	);
