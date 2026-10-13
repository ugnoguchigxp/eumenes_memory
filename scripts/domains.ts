/** Domain ownership and permitted direct dependencies. Shared wire contracts stay in src/contracts. */
export const DOMAINS = {
	temporal: { dependencies: [], scenarios: [], fixtures: [] },
	records: { dependencies: [], scenarios: ["records"], fixtures: ["evidence"] },
	state: {
		dependencies: ["records", "temporal"],
		scenarios: ["state-fixtures", "state-input"],
		fixtures: ["state"],
	},
	lifecycle: {
		dependencies: ["records", "state"],
		scenarios: ["lifecycle", "forget"],
		fixtures: ["lifecycle", "scenario"],
	},
} as const;

export type Domain = keyof typeof DOMAINS;
export const DOMAIN_NAMES = Object.keys(DOMAINS) as Domain[];

export function domainName(value: string | undefined): Domain {
	if (value === undefined || !Object.hasOwn(DOMAINS, value)) {
		throw new Error(
			`Unknown domain: ${value ?? "(missing)"}. Choose ${DOMAIN_NAMES.join(", ")}`,
		);
	}
	return value as Domain;
}

/** Dependency-first closure; invalid names and cycles are errors, never silently truncated. */
export function dependencyClosure(
	names: readonly string[],
	graph: Readonly<
		Record<string, { readonly dependencies: readonly string[] }>
	> = DOMAINS,
): string[] {
	const result: string[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (name: string) => {
		if (visiting.has(name))
			throw new Error(`Domain dependency cycle at ${name}`);
		if (visited.has(name)) return;
		const entry = graph[name];
		if (entry === undefined) throw new Error(`Unknown domain: ${name}`);
		visiting.add(name);
		for (const dependency of entry.dependencies) visit(dependency);
		visiting.delete(name);
		visited.add(name);
		result.push(name);
	};
	for (const name of names) visit(name);
	return result;
}

export function ownerOf(path: string): Domain | undefined {
	const match = /^src\/domains\/([^/]+)\//.exec(path);
	if (match?.[1] !== undefined && Object.hasOwn(DOMAINS, match[1]))
		return match[1] as Domain;
	return undefined;
}

export function testOwnedBy(path: string, domain: Domain): boolean {
	if (path.startsWith(`src/domains/${domain}/test/`)) return true;
	return DOMAINS[domain].scenarios.some(
		(prefix) =>
			path.startsWith(`test/scenario/${prefix}.`) ||
			path.startsWith(`test/scenario/${prefix}-`),
	);
}
