import type {
	DependencyNodeType,
	DependencyRole,
	DependentNodeType,
} from "../../contracts/dependency.ts";
import { guarded } from "./db.ts";
import type { MemoryDb } from "./db.ts";

export interface DependencyEdgeRow {
	readonly principal: string;
	readonly scopeKey: string;
	readonly dependentType: DependentNodeType;
	readonly dependentId: string;
	readonly dependencyType: DependencyNodeType;
	readonly dependencyId: string;
	readonly role: DependencyRole;
}

/**
 * 依存辺を張る（同じ辺は無視）。派生行（state_item / external）は必ず依存辺を持つ
 * （辺のない派生行を作らない）。`source` の id は SourceKey。
 */
export function addDependency(db: MemoryDb, edge: DependencyEdgeRow): void {
	guarded(() =>
		db
			.query(
				`INSERT INTO memory_dependency
					(principal, scope_key, dependent_type, dependent_id, dependency_type, dependency_id, role)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT DO NOTHING`,
			)
			.run(
				edge.principal,
				edge.scopeKey,
				edge.dependentType,
				edge.dependentId,
				edge.dependencyType,
				edge.dependencyId,
				edge.role,
			),
	);
}
