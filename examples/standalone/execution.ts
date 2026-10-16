import { createHash } from "node:crypto";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { readStateFact } from "eumenes-memory/sqlite";
import { ACCESS, SCOPE, type StandaloneHost } from "./host.ts";
import { modelItems } from "./model-input.ts";
import { snapshotHash, validateGroups, type MemoryPlan } from "./planning.ts";

type Fingerprints = Record<string, string>;
type Outcome = "applied" | "skipped" | "blocked";
interface Receipt {
	requestHash: string;
	expected: Fingerprints;
	targets: string[][];
	outcomes: (Outcome | null)[];
}
export interface ExecutionResult {
	status: "completed" | "needs_clarification" | "partial" | "failed";
	groups: (Outcome | "failed" | "not_run")[];
	error?: string;
}
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprints = (host: StandaloneHost): Fingerprints =>
	Object.fromEntries(modelItems(host.list()).map((x) => [x.itemId, digest(x)]));
const fact = (host: StandaloneHost, itemId: string) =>
	host.read((db) =>
		readStateFact(db, {
			contractVersion: CONTRACT_VERSIONS.state,
			access: ACCESS,
			scopeKey: SCOPE,
			itemId,
		}),
	);
function readReceipt(row: unknown): Receipt {
	if (
		!row ||
		typeof row !== "object" ||
		!("payload" in row) ||
		typeof row.payload !== "string"
	)
		throw Error("Invalid operation receipt");
	return JSON.parse(row.payload) as Receipt;
}
function save(host: StandaloneHost, id: string, receipt: Receipt): void {
	host.write((db) =>
		db
			.query(
				"INSERT OR REPLACE INTO example_memory_operation (operation_id, payload) VALUES (?, ?)",
			)
			.run(id, JSON.stringify(receipt)),
	);
}
function assertExpected(
	host: StandaloneHost,
	expected: Fingerprints,
	disappearing: readonly string[] = [],
): void {
	const current = fingerprints(host);
	if (
		Object.entries(current).some(([id, hash]) => expected[id] !== hash) ||
		Object.keys(expected).some(
			(id) => !(id in current) && !disappearing.includes(id),
		)
	)
		throw Error("Memory changed outside this operation; replan required");
}

/** Single-process example executor. Receipts contain IDs and hashes, never assertion/source text. */
export function applyMemoryPlan(
	host: StandaloneHost,
	operationId: string,
	plan: MemoryPlan,
): ExecutionResult {
	if (!operationId.trim() || operationId.length > 200)
		throw Error("Invalid operation ID");
	validateGroups(plan.groups, plan.changes.length);
	if (plan.changes.some((c, i) => c.actionIndex !== i))
		throw Error("Invalid change indexes");
	const groups = plan.groups.map((indexes) => {
		const changes = indexes.map((i) => plan.changes[i]!);
		const actions = changes.flatMap((c) => c.actions);
		if (new Set(actions.map((a) => a.type)).size > 1)
			throw Error("Mixed remember/forget group is unsupported");
		return {
			actions,
			blocked: changes.some((c) => c.relation === "conflicts"),
		};
	});
	host.write((db) =>
		db.exec(
			"CREATE TABLE IF NOT EXISTS example_memory_operation (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
		),
	);
	const row = host.read((db) =>
		db
			.query(
				"SELECT payload FROM example_memory_operation WHERE operation_id = ?",
			)
			.get(operationId),
	);
	const requestHash = digest(plan);
	let receipt: Receipt;
	if (row) {
		receipt = readReceipt(row);
		if (receipt.requestHash !== requestHash)
			throw Error("Operation ID reused for a different plan");
	} else {
		if (snapshotHash(modelItems(host.list())) !== plan.snapshotHash)
			throw Error("Stale memory plan");
		// Validate all executable transitions before any source/journal append or memory change.
		host.preview(
			groups.filter((g) => !g.blocked).flatMap((g) => g.actions),
			plan.message,
		);
		const targets = groups.map((g) => [
			...new Set(
				g.actions.flatMap((a) => {
					if (a.type !== "forget" || g.blocked) return [];
					const result = fact(host, a.itemId);
					if (result.status !== "ok")
						throw Error(`readStateFact: ${result.status}`);
					return result.itemIds;
				}),
			),
		]);
		receipt = {
			requestHash,
			expected: fingerprints(host),
			targets,
			outcomes: groups.map(() => null),
		};
		save(host, operationId, receipt);
	}
	for (let index = 0; index < groups.length; index++) {
		if (receipt.outcomes[index] !== null) continue;
		const group = groups[index]!;
		try {
			assertExpected(host, receipt.expected, receipt.targets[index]);
			if (group.blocked || group.actions.length === 0) {
				receipt.outcomes[index] = group.blocked ? "blocked" : "skipped";
				save(host, operationId, receipt);
				continue;
			}
			if (group.actions[0]!.type === "remember") {
				host.preview(group.actions, plan.message);
				host.write(() => {
					for (const action of group.actions) {
						if (action.type !== "remember")
							throw Error("Invalid remember group");
						host.remember(action, plan.message);
					}
					const committed: Receipt = {
						...receipt,
						outcomes: [...receipt.outcomes],
						expected: fingerprints(host),
					};
					committed.outcomes[index] = "applied";
					save(host, operationId, committed);
				});
			} else {
				// Intent and the full version set were persisted before the first deletion.
				for (const itemId of receipt.targets[index]!) {
					const state = fact(host, itemId);
					if (state.status === "forgotten") continue;
					if (state.status !== "ok")
						throw Error(`readStateFact: ${state.status}`);
					host.forget({ type: "state_item", scopeKey: SCOPE, itemId });
				}
				const committed: Receipt = {
					...receipt,
					outcomes: [...receipt.outcomes],
					expected: fingerprints(host),
				};
				committed.outcomes[index] = "applied";
				save(host, operationId, committed);
			}
			// Reload only after both the state transition and its receipt have committed.
			receipt = readReceipt(
				host.read((db) =>
					db
						.query(
							"SELECT payload FROM example_memory_operation WHERE operation_id = ?",
						)
						.get(operationId),
				),
			);
		} catch (error) {
			return {
				status:
					receipt.outcomes.includes("applied") ||
					group.actions[0]?.type === "forget"
						? "partial"
						: "failed",
				groups: receipt.outcomes.map(
					(o, i) => o ?? (i === index ? "failed" : "not_run"),
				),
				error: String(error),
			};
		}
	}
	return {
		status:
			plan.clarification || receipt.outcomes.includes("blocked")
				? "needs_clarification"
				: "completed",
		groups: receipt.outcomes.map((o) => o ?? "not_run"),
	};
}
