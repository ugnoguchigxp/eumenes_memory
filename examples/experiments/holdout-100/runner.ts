import { parseRecall } from "../frozen-protocol.ts";
import { createHash } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLuna } from "../../standalone/luna.ts";
import { StandaloneHost } from "../../standalone/host.ts";
import { modelItems } from "../../standalone/model-input.ts";
import {
	parseDecision,
	decisionOutputSchema,
} from "../../standalone/protocol.ts";
import type {
	Action,
	Complete,
	ModelResult,
} from "../../standalone/protocol.ts";
import {
	planMemory,
	parsePlan,
	snapshotHash,
} from "../../standalone/planning.ts";
import type { MemoryPlan } from "../../standalone/planning.ts";
import { applyMemoryPlan } from "../../standalone/execution.ts";
import { recallSnapshot } from "../frozen-retrieval.ts";
import { parseEvidence } from "../../standalone/support.ts";
import { subjectsFor } from "./cases.ts";
import type { MutationCase, Fact, RetrievalCase } from "./cases.ts";
import { parallel } from "../experiment.ts";
export const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const designPath = process.argv[2]!,
	output = process.argv[3]!,
	phase = process.argv[4]!;
if (
	!designPath ||
	!output ||
	!["retrieval", "identity", "execution"].includes(phase)
)
	throw Error(
		"Usage: runner.ts <frozen.json> <output> retrieval|identity|execution",
	);
const design = JSON.parse(readFileSync(designPath, "utf8"));
const designHash = hash(design);
mkdirSync(output, { recursive: true });
interface Call {
	stage: string;
	input: string;
	schema: unknown;
	raw?: string;
	usage?: ModelResult["usage"];
	ms: number;
	error?: string;
}
const clients: Record<string, Complete> = {};
let providerFailures = 0;
const instructions = design.instructions as Record<string, string>;
function traced(client: Complete, calls: Call[], stage: string): Complete {
	return async (input, schema, task) => {
		const row: Call = { stage, input, schema, ms: 0 };
		calls.push(row);
		const start = performance.now();
		try {
			const r = await client(input, schema, task);
			providerFailures = 0;
			row.raw = r.raw;
			row.usage = r.usage;
			return r;
		} catch (error) {
			providerFailures++;
			row.error = String(error);
			throw error;
		} finally {
			row.ms = performance.now() - start;
		}
	};
}
function write(id: string, value: unknown) {
	writeFileSync(
		join(output, id + ".json"),
		JSON.stringify(value, null, 2) + "\n",
	);
}
const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);
const idsEqual = (a: readonly string[], b: readonly string[]) =>
	same([...new Set(a)].sort(), [...new Set(b)].sort());
const facts = (host: StandaloneHost): Fact[] =>
	host.list().map((x) => ({
		key: x.semanticKey,
		text: x.value.text,
		subject: x.subject,
		kind: x.kind,
		polarity: x.value.polarity,
	}));
function structural(actual: Fact[], expected: Fact[]) {
	const shape = (xs: Fact[]) =>
		xs.map((x) => [x.subject, x.kind, x.polarity].join("/")).sort();
	return same(shape(actual), shape(expected));
}
const remember = (x: Fact) => ({
	type: "remember" as const,
	subject: x.subject,
	kind: x.kind,
	semanticKey: x.key,
	value: { text: x.text, polarity: x.polarity },
	quote: x.text,
	replacesItemId: null,
});
function initialize(c: MutationCase) {
	const dir = mkdtempSync(join(tmpdir(), "holdout-host-"));
	const host = new StandaloneHost(dir);
	for (const x of c.seed) host.remember(remember(x), x.text);
	return { host, dir };
}
function sequential(host: StandaloneHost, actions: Action[], message: string) {
	for (const a of actions)
		if (a.type === "remember") host.remember(a, message);
		else host.forgetFact(a.itemId);
}
/** Minimal control: contract preflight and one transaction for remember-only requests; no new planner/groups/receipts. */
function minimal(host: StandaloneHost, actions: Action[], message: string) {
	host.preview(actions, message);
	if (actions.every((a) => a.type === "remember"))
		host.write(() => sequential(host, actions, message));
	else sequential(host, actions, message);
}
async function getPlan(
	c: MutationCase,
	host: StandaloneHost,
	arm: string,
	calls: Call[],
): Promise<MemoryPlan> {
	if (arm === "new" && phase === "execution")
		return planMemory(
			host,
			c.message,
			traced(clients["planning"]!, calls, "planning"),
			subjectsFor(c),
		);
	const items = modelItems(host.list(), subjectsFor(c));
	const client = traced(
		clients[
			phase === "identity" && arm === "old" ? "baseline" : "beforePlanning"
		]!,
		calls,
		"planning",
	);
	let schema: unknown;
	if (phase === "identity" && arm === "old")
		schema = decisionOutputSchema(items.map((x) => x.itemId));
	else {
		const { planningSchema } = await import("../../standalone/planning.ts");
		const current = planningSchema(items.map((x) => x.itemId));
		const { groups: _groups, ...properties } = current.properties;
		schema = { ...current, required: ["decision", "relations"], properties };
	}
	const result = await client(
		JSON.stringify({
			task: "decide",
			message: c.message,
			items,
			subjects: subjectsFor(c),
		}),
		schema,
		"decide",
	);
	if (phase === "identity" && arm === "old") {
		const p = parseDecision(result.raw);
		return {
			snapshotHash: snapshotHash(modelItems(host.list())),
			message: c.message,
			clarification: p.clarification,
			groups: p.actions.map((_, i) => [i]),
			changes: p.actions.map((a, i) => ({
				actionIndex: i,
				relation: a.type === "forget" ? "forget" : "new",
				relatedItemIds: [],
				actions: [a],
			})),
		};
	}
	const root = JSON.parse(result.raw);
	return {
		...parsePlan(
			JSON.stringify({
				...root,
				groups: root.decision.actions.map((_: unknown, i: number) => [i]),
			}),
			items,
			c.message,
		),
		snapshotHash: snapshotHash(modelItems(host.list())),
	};
}
async function runMutation(
	c: MutationCase,
	arm: string,
	provided?: { plan: MemoryPlan; calls: Call[] },
) {
	const state = initialize(c);
	let host = state.host;
	const calls: Call[] = provided ? structuredClone(provided.calls) : [];
	const start = performance.now();
	const before = host.list();
	let plan: MemoryPlan | undefined;
	let error: string | undefined,
		result: unknown,
		retryStable = true,
		executionMs = 0,
		proposed = 0;
	try {
		plan = provided
			? structuredClone(provided.plan)
			: await getPlan(c, host, arm, calls);
		const actions = plan.changes.flatMap((x) => x.actions);
		proposed = actions.length;
		if (c.fault === "invalid-second") {
			const a = actions.filter((a) => a.type === "remember")[1];
			if (a) a.quote = "[injected missing evidence span]";
		}
		if (c.fault === "stale")
			host.remember(
				remember({
					key: "external",
					text: "新しい連絡先は連絡番号482",
					kind: "personal_fact",
					subject: "self",
					polarity: "affirmed",
				}),
				"新しい連絡先は連絡番号482",
			);
		if (c.fault === "missing-target")
			host.forgetFact(before.find((x) => x.semanticKey === "home")!.itemId);
		const originalPreview = host.preview.bind(host),
			originalRemember = host.remember.bind(host),
			originalForget = host.forget.bind(host);
		let previewing = false,
			writes = 0,
			crashed = false;
		host.preview = (...args) => {
			previewing = true;
			try {
				originalPreview(...args);
			} finally {
				previewing = false;
			}
		};
		host.remember = (a, m) => {
			if (!previewing && c.fault === "runtime-second" && ++writes === 2)
				throw Error("injected runtime write failure");
			return originalRemember(a, m);
		};
		host.forget = (target) => {
			originalForget(target);
			if (!previewing && c.fault === "crash-forget" && !crashed) {
				crashed = true;
				throw Error("injected interruption after committed deletion");
			}
		};
		const apply = () =>
			arm === "new" && phase === "execution"
				? applyMemoryPlan(host, c.id, plan!)
				: arm === "minimal"
					? minimal(host, actions, c.message)
					: sequential(host, actions, c.message);
		const execStart = performance.now();
		try {
			result = apply();
		} catch (e) {
			error = String(e);
		}
		if (c.fault === "retry" || c.fault === "crash-forget") {
			const history = JSON.stringify(host.list(true));
			const sources = existsSync(join(state.dir, "sources.jsonl"))
				? readFileSync(join(state.dir, "sources.jsonl"), "utf8")
				: "";
			host.close();
			host = new StandaloneHost(state.dir);
			try {
				result = apply();
				error = undefined;
			} catch (e) {
				error = String(e);
			}
			if (c.fault === "retry")
				retryStable =
					history === JSON.stringify(host.list(true)) &&
					sources ===
						(existsSync(join(state.dir, "sources.jsonl"))
							? readFileSync(join(state.dir, "sources.jsonl"), "utf8")
							: "");
		}
		executionMs = performance.now() - execStart;
	} catch (e) {
		error = String(e);
	}
	const actual = facts(host),
		after = host.list();
	const preserved = c.preserve.every((key) => {
		const old = before.find((x) => x.semanticKey === key)!;
		return after.some(
			(x) => x.itemId === old.itemId && x.revision === old.revision,
		);
	});
	const permittedError = [
		"invalid-second",
		"runtime-second",
		"stale",
		"missing-target",
	].includes(c.fault);
	const outcomeFailure =
		typeof result === "object" &&
		result !== null &&
		"status" in result &&
		["failed", "partial"].includes(String(result.status));
	const proposalValid =
		(!permittedError && c.fault !== "crash-forget") || proposed >= 2;
	const structure =
		structural(actual, c.expected) &&
		preserved &&
		Boolean(plan?.clarification?.trim()) === c.clarify &&
		retryStable &&
		proposalValid &&
		(permittedError || (!error && !outcomeFailure));
	const protectedIds = before
		.filter((x) => c.preserve.includes(x.semanticKey))
		.map((x) => x.itemId);
	const forgottenProtected =
		plan?.changes
			.flatMap((x) => x.actions)
			.some(
				(a) =>
					a.type === "forget" &&
					protectedIds.includes(a.itemId) &&
					!after.some((x) => x.itemId === a.itemId),
			) ?? false;
	const row = {
		arm,
		plan,
		calls,
		actual,
		expected: c.expected,
		structure,
		preserved,
		forgottenProtected,
		proposed,
		retryStable,
		result,
		error: error ?? null,
		ms:
			performance.now() -
			start +
			(provided ? provided.calls.reduce((n, x) => n + x.ms, 0) : 0),
		executionMs,
	};
	host.close();
	rmSync(state.dir, { recursive: true, force: true });
	return row;
}
async function mutationJob(c: MutationCase) {
	if (providerFailures >= 3)
		throw Error("Repeated provider failure; stop dispatch");
	const path = join(output, c.id + ".json");
	if (existsSync(path)) {
		const saved = JSON.parse(readFileSync(path, "utf8"));
		if (saved.designHash !== designHash) throw Error("Design changed");
		if (saved.status !== "completed")
			throw Error(
				"Interrupted case requires explicit recovery; no automatic rerun",
			);
		return;
	}
	// Interleave arm order by case; minimal shares the exact baseline plan as an execution ablation.
	const order = Number(c.id.slice(1)) % 2 ? ["old", "new"] : ["new", "old"];
	const rows = [];
	for (const arm of order) {
		const row = await runMutation(c, arm);
		rows.push(row);
		write(c.id, {
			designHash,
			phase,
			id: c.id,
			family: c.family,
			status: "running",
			case: c,
			rows,
		});
	}
	if (phase === "execution") {
		const old = rows.find((x) => x.arm === "old")!;
		if (old.plan)
			rows.push(
				await runMutation(c, "minimal", { plan: old.plan, calls: old.calls }),
			);
		else rows.push({ ...old, arm: "minimal" });
	}
	write(c.id, {
		designHash,
		phase,
		id: c.id,
		family: c.family,
		status: "completed",
		case: c,
		rows,
	});
	console.log(
		JSON.stringify({
			id: c.id,
			structure: rows.map((x) => [x.arm, x.structure]),
			errors: rows.filter((x) => x.error).map((x) => [x.arm, x.error]),
		}),
	);
}
async function retrievalJob(c: RetrievalCase) {
	if (providerFailures >= 3)
		throw Error("Repeated provider failure; stop dispatch");
	const path = join(output, c.id + ".json");
	if (existsSync(path)) {
		const saved = JSON.parse(readFileSync(path, "utf8"));
		if (saved.designHash !== designHash) throw Error("Design changed");
		if (saved.status !== "completed")
			throw Error(
				"Interrupted case requires explicit recovery; no automatic rerun",
			);
		return;
	}
	const rows = [];
	const order =
		Number(c.id.slice(1)) % 2 ? ["old", "new", "all"] : ["all", "new", "old"];
	for (const arm of order) {
		const calls: Call[] = [];
		const start = performance.now();
		let ids: string[] = [],
			parts: ReturnType<typeof parseEvidence> | undefined,
			result: unknown,
			error: string | undefined;
		try {
			if (arm === "new") {
				const r = await recallSnapshot(
					c.items,
					c.message,
					{
						candidates: traced(clients["candidate"]!, calls, "candidate"),
						grounding: traced(clients["grounding"]!, calls, "grounding"),
					},
					{ pageSize: c.pageSize },
				);
				result = r;
				parts = r.parts as ReturnType<typeof parseEvidence>;
				ids = parts.flatMap((x) => x.evidenceIds);
			} else if (arm === "all") {
				const r = await traced(clients["all"]!, calls, "all")(
					JSON.stringify({ message: c.message, items: c.items }),
					design.schemas.evidence,
					"recall",
				);
				parts = parseEvidence(
					r.raw,
					c.items.map((x) => x.itemId),
				);
				ids = parts.flatMap((x) => x.evidenceIds);
			} else
				for (let offset = 0; offset < c.items.length; offset += c.pageSize) {
					const page = c.items.slice(offset, offset + c.pageSize);
					const r = await traced(clients["page"]!, calls, "page")(
						JSON.stringify({ task: "recall", message: c.message, items: page }),
						design.schemas.recall,
						"recall",
					);
					const selected = parseRecall(r.raw);
					if (selected.some((id) => !page.some((x) => x.itemId === id)))
						throw Error("Out-of-page ID");
					ids.push(...selected);
				}
		} catch (e) {
			error = String(e);
		}
		const expected = c.parts.flatMap((x) => x.ids);
		rows.push({
			arm,
			calls,
			ids,
			parts,
			result,
			error: error ?? null,
			passed: !error && idsEqual(ids, expected),
			partPassed: parts
				? parts.length === c.parts.length &&
					parts.every(
						(x, i) =>
							x.status === c.parts[i]!.status &&
							idsEqual(x.evidenceIds, c.parts[i]!.ids),
					)
				: null,
			falsePositive: ids.some((id) => !expected.includes(id)),
			ms: performance.now() - start,
		});
		write(c.id, {
			designHash,
			phase,
			id: c.id,
			family: c.family,
			status: "running",
			caseSize: c.items.length,
			rows,
		});
	}
	write(c.id, {
		designHash,
		phase,
		id: c.id,
		family: c.family,
		status: "completed",
		caseSize: c.items.length,
		rows,
	});
	console.log(
		JSON.stringify({ id: c.id, passed: rows.map((x) => [x.arm, x.passed]) }),
	);
}
async function openClients(
	names: string[],
	operation: () => Promise<void>,
): Promise<void> {
	if (names.length === 0) return operation();
	const name = names[0]!;
	await withLuna(
		async (complete) => {
			clients[name] = complete;
			await openClients(names.slice(1), operation);
		},
		{ decide: instructions[name]!, recall: instructions[name]! },
	);
}
await openClients(
	phase === "retrieval"
		? ["candidate", "grounding", "all", "page"]
		: ["baseline", "beforePlanning", "planning"],
	async () => {
		const cases = design[phase] as (MutationCase | RetrievalCase)[];
		await parallel(
			cases.map(
				(c) => () =>
					phase === "retrieval"
						? retrievalJob(c as RetrievalCase)
						: mutationJob(c as MutationCase),
			),
			design.concurrency,
		);
	},
);
