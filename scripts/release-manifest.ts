/** Bound source identity and distributed contents. No timestamps or machine paths in artifact. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceHash } from "./verify.ts";
const root = resolve(import.meta.dir, "..");
const walk = (dir: string): string[] =>
	readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
const files = [
	...walk("dist"),
	...walk("docs"),
	"README.md",
	"LICENSE",
	"THIRD_PARTY_NOTICES.md",
	"package.json",
]
	.filter((f) => f !== "dist/release-manifest.json")
	.sort();
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
if (head.exitCode) throw Error("Cannot identify source commit");
writeFileSync(
	join(root, "dist/release-manifest.json"),
	JSON.stringify(
		{
			version: 1,
			packageVersion: JSON.parse(
				readFileSync(join(root, "package.json"), "utf8"),
			).version,
			baseCommit: head.stdout.toString().trim(),
			sourceHash: sourceHash(root),
			files: Object.fromEntries(
				files.map((f) => [
					f,
					createHash("sha256")
						.update(readFileSync(join(root, f)))
						.digest("hex"),
				]),
			),
		},
		null,
		2,
	) + "\n",
);
