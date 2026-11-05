/** Offline provenance inventory; advisory triage is a separately captured network check. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
export function dependencyInventory(root: string) {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (pkg.dependencies && Object.keys(pkg.dependencies).length)
		throw Error("Unexpected runtime dependency");
	const packages = Object.entries(
		pkg.devDependencies as Record<string, string>,
	).map(([name, version]) => {
		if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
			throw Error(`Unpinned version: ${name}`);
		const installed = JSON.parse(
			readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
		);
		if (installed.version !== version || !installed.license)
			throw Error(`Dependency provenance missing: ${name}`);
		const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]
			.map((n) => join(root, "node_modules", name, n))
			.find(existsSync);
		return {
			name,
			version,
			license: installed.license,
			repository: installed.repository ?? null,
			licenseSha256: licenseFile
				? createHash("sha256").update(readFileSync(licenseFile)).digest("hex")
				: null,
			reachability: "development-only; not in packed runtime",
			update:
				"Pin exact version, frozen install, full gate and extracted consumer before release",
		};
	});
	return {
		runtimeDependencies: [],
		lockSha256: createHash("sha256")
			.update(readFileSync(join(root, "bun.lock")))
			.digest("hex"),
		minimumReleaseAgeSeconds: 604800,
		packages,
	};
}
if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const directory = join(root, "verification-reports/quality-80");
	mkdirSync(directory, { recursive: true });
	const result = dependencyInventory(root);
	writeFileSync(
		join(directory, "dependencies.json"),
		JSON.stringify(result, null, 2),
	);
	console.log(JSON.stringify(result, null, 2));
}
