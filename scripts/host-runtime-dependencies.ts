import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

interface Package {
	name: string;
	version: string;
	license?: string;
	dependencies?: Record<string, string>;
}

function manifest(path: string): Package {
	return JSON.parse(readFileSync(path, "utf8")) as Package;
}

function findPackage(name: string, from: string): string {
	const resolve = createRequire(from).resolve;
	for (const base of resolve.paths(name) ?? []) {
		const path = join(base, name, "package.json");
		if (existsSync(path)) return realpathSync(path);
	}
	throw Error(`Missing host runtime dependency: ${name}`);
}

export function hostRuntimeDependencies(hostManifest: string) {
	const seen = new Set<string>();
	const notices = new Map<string, Buffer>();
	const packages: {
		name: string;
		version: string;
		license: string;
		notice: string;
		sha256: string;
	}[] = [];
	function visit(path: string): void {
		if (seen.has(path)) return;
		seen.add(path);
		const pkg = manifest(path);
		for (const name of Object.keys(pkg.dependencies ?? {})) {
			const child = findPackage(name, path);
			visit(child);
		}
		if (path === hostManifest) return;
		const license = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]
			.map((name) => join(dirname(path), name))
			.find(existsSync);
		if (!license || !pkg.license)
			throw Error(`Missing runtime license: ${pkg.name}`);
		const notice = `${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}.txt`;
		const body = readFileSync(license);
		notices.set(notice, body);
		packages.push({
			name: pkg.name,
			version: pkg.version,
			license: pkg.license,
			notice,
			sha256: createHash("sha256").update(body).digest("hex"),
		});
	}
	visit(hostManifest);
	packages.sort((a, b) => a.notice.localeCompare(b.notice));
	return { packages, notices };
}
