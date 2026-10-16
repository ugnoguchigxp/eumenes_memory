import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MEMORY_DB_SCHEMA_VERSION } from "eumenes-memory/sqlite";
import type { StateItem } from "eumenes-memory";
import { coreChecks } from "./checks.ts";
import type { Check, CheckResult } from "./checks.ts";
import { StandaloneHost } from "./host.ts";
import { MODEL, SDK_VERSION } from "./luna.ts";
import { evaluationGroups, modelItems } from "./model-input.ts";
import {
	decisionSchema,
	decisionOutputSchema,
	INSTRUCTIONS,
	judgeSchema,
	judgeOutputSchema,
	parseDecision,
	parseJudgment,
	parseRecall,
	PROMPT_VERSION,
	recallSchema,
	recallOutputSchema,
} from "./protocol.ts";
import type { Complete, ModelResult, ModelTask } from "./protocol.ts";
import { scenarios } from "./scenarios.ts";
import type { ExpectedFact, Scenario, Step } from "./scenarios.ts";

function facts(items: readonly StateItem[]): ExpectedFact[] {
	return items
		.map((item) => ({
			text: item.value.text,
			polarity: item.value.polarity,
			kind: item.kind,
			subject: item.subject,
		}))
		.sort(compareFacts);
}

function compareFacts(a: ExpectedFact, b: ExpectedFact): number {
	const left = JSON.stringify([a.subject, a.kind, a.text, a.polarity]);
	const right = JSON.stringify([b.subject, b.kind, b.text, b.polarity]);
	return left < right ? -1 : left > right ? 1 : 0;
}

/** A transport replay, not a substitute for LLM interpretation. References are fixture notation. */
export function replay(
	step: Step,
	items: readonly Pick<StateItem, "itemId" | "semanticKey">[],
): ModelResult {
	const resolve = (id: string) => {
		if (id.startsWith("$key:")) {
			const matches = items.filter((item) => item.semanticKey === id.slice(5));
			if (matches.length !== 1) throw new Error(`Unresolved replay key: ${id}`);
			return matches[0]!.itemId;
		}
		if (!id.startsWith("$active:")) return id;
		const item = items[Number(id.slice("$active:".length))];
		if (item === undefined)
			throw new Error(`Unresolved replay reference: ${id}`);
		return item.itemId;
	};
	const output =
		"actions" in step.replay
			? {
					clarification: step.replay.clarification ?? null,
					actions: step.replay.actions.map((action) =>
						action.type === "forget"
							? { ...action, itemId: resolve(action.itemId) }
							: {
									...action,
									replacesItemId:
										action.replacesItemId === null
											? null
											: resolve(action.replacesItemId),
								},
					),
				}
			: {
					answers: [
						{
							request: step.message,
							itemIds: step.replay.itemIds.map(resolve),
						},
					],
				};
	return { raw: JSON.stringify(output), threadId: null, usage: null };
}

class ProviderError extends Error {}

interface TurnTrace {
	purpose: "decision" | "evaluation";
	scenario: string;
	step: number;
	prompt: string;
	task: ModelTask;
	outputSchema: unknown;
	audit?: unknown;
	response?: ModelResult;
	error?: string;
	phase?: string;
	before?: readonly StateItem[];
	after?: readonly StateItem[];
	decision?: ReturnType<typeof parseDecision>;
}
export interface ScenarioResult {
	id: string;
	description: string;
	status: "not_run" | "running" | "passed" | "failed";
	totalSteps: number;
	passedSteps: number;
	failedStep?: number;
	error?: string;
}
export interface Report {
	status: "running" | "passed" | "failed";
	mode: "offline" | "live";
	model: string | null;
	sdkVersion: string;
	promptVersion: string;
	inputHash: string;
	dbSchemaVersion: number;
	startedAt: string;
	durationMs: number;
	checks: CheckResult[];
	turns: TurnTrace[];
	scenarios: ScenarioResult[];
	plannedChecks: number;
	configuration: {
		instructions: Readonly<Record<ModelTask, string>>;
		decisionSchema: unknown;
		recallSchema: unknown;
		judgeSchema: unknown;
		cases: Scenario[];
	};
	error?: string;
}

export interface RunOptions {
	directory: string;
	mode: "offline" | "live";
	/** Live client lifecycle is inside the runner so startup failures also produce reports. */
	withModel?: (
		operation: (complete: Complete) => Promise<void>,
	) => Promise<void>;
	cases?: Scenario[];
	log?: (message: string) => void;
}

export async function runChecks(options: RunOptions): Promise<Report> {
	mkdirSync(options.directory, { recursive: true, mode: 0o700 });
	const reportPath = join(options.directory, "report.json");
	const cases = options.cases ?? scenarios;
	const configuration = {
		instructions: INSTRUCTIONS,
		decisionSchema,
		recallSchema,
		judgeSchema,
		cases,
	};
	const started = performance.now();
	const report: Report = {
		status: "running",
		mode: options.mode,
		model: options.mode === "live" ? MODEL : null,
		sdkVersion: SDK_VERSION,
		promptVersion: PROMPT_VERSION,
		inputHash: createHash("sha256")
			.update(JSON.stringify(configuration))
			.digest("hex"),
		dbSchemaVersion: MEMORY_DB_SCHEMA_VERSION,
		startedAt: new Date().toISOString(),
		durationMs: 0,
		checks: [],
		turns: [],
		configuration,
		plannedChecks:
			8 + cases.reduce((sum, scenario) => sum + scenario.steps.length, 0),
		scenarios: cases.map((scenario) => ({
			id: scenario.id,
			description: scenario.description ?? scenario.id,
			status: "not_run",
			totalSteps: scenario.steps.length,
			passedSteps: 0,
		})),
	};
	const save = () => {
		report.durationMs = Math.round(performance.now() - started);
		writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
			mode: 0o600,
		});
	};
	const check: Check = async (name, operation) => {
		options.log?.(`CHECK ${name}`);
		const start = performance.now();
		try {
			await operation();
			report.checks.push({
				name,
				status: "passed",
				durationMs: Math.round(performance.now() - start),
			});
			options.log?.(`PASS  ${name}`);
		} catch (error) {
			report.checks.push({
				name,
				status: "failed",
				durationMs: Math.round(performance.now() - start),
				error: String(error),
			});
			throw error;
		} finally {
			save();
		}
	};
	save();
	try {
		await coreChecks(join(options.directory, "core"), check);
		const execute = async (complete?: Complete) => {
			for (const [caseIndex, scenario] of cases.entries()) {
				const outcome = report.scenarios[caseIndex]!;
				outcome.status = "running";
				const directory = join(options.directory, `scenario-${caseIndex}`);
				let host = new StandaloneHost(directory);
				try {
					for (const [stepIndex, step] of scenario.steps.entries()) {
						await check(
							`${scenario.id}/${stepIndex + 1}: ${step.task}`,
							async () => {
								if (step.restart) {
									host.close();
									host = new StandaloneHost(directory);
								}
								const items = host.list();
								const ids = items.map((item) => item.itemId);
								const outputSchema =
									step.task === "decide"
										? decisionOutputSchema(ids)
										: recallOutputSchema(ids);
								// Expected outcomes and replay decisions are deliberately absent from model input.
								const prompt = JSON.stringify({
									task: step.task,
									message: step.message,
									items: modelItems(items, scenario.subjects),
									...(scenario.subjects === undefined
										? {}
										: { subjects: scenario.subjects }),
								});
								const trace: TurnTrace = {
									purpose: "decision",
									outputSchema,
									task: step.task,
									scenario: scenario.id,
									step: stepIndex + 1,
									prompt,
									before: host.list(true),
									phase: "provider",
								};
								report.turns.push(trace);
								save();
								let result: ModelResult;
								try {
									result =
										complete === undefined
											? replay(step, items)
											: await complete(prompt, outputSchema, step.task);
									trace.response = result;
									save();
								} catch (error) {
									trace.error = String(error);
									throw new ProviderError(String(error));
								}
								const evaluate = async (actual: readonly StateItem[]) => {
									if (complete === undefined) {
										assert.deepEqual(
											facts(actual),
											[...step.expected].sort(compareFacts),
										);
										return;
									}
									trace.phase = "structure";
									// Cardinality, polarity, kind and subject remain deterministic checks.
									const structure = (values: ExpectedFact[]) =>
										values
											.map(({ kind, subject, polarity }) =>
												JSON.stringify([kind, subject, polarity]),
											)
											.sort();
									assert.deepEqual(
										structure(facts(actual)),
										structure(step.expected),
									);
									if (actual.length === 0) return;
									const allGroups = evaluationGroups(
										facts(actual),
										step.expected,
										scenario.subjects,
									);
									const exactGroups = allGroups.filter((group) =>
										isDeepStrictEqual(
											[...group.actual].sort(),
											[...group.expected].sort(),
										),
									);
									const exactIds = new Set(
										exactGroups.map((group) => group.groupId),
									);
									const groups = allGroups.filter(
										(group) => !exactIds.has(group.groupId),
									);
									trace.audit = {
										groups: allGroups,
										exactGroupIds: [...exactIds],
										semanticGroupIds: groups.map((group) => group.groupId),
										message: step.message,
										criterion: step.criterion ?? null,
										items: actual.map(({ itemId, semanticKey }) => ({
											itemId,
											semanticKey,
											sourceQuotes: host.evidenceQuotes(itemId),
										})),
									};
									if (groups.length === 0) {
										save();
										return;
									}

									const groupIds = groups.map((group) => group.groupId);
									const evaluationSchema = judgeOutputSchema(groupIds);
									const evaluation: TurnTrace = {
										purpose: "evaluation",
										outputSchema: evaluationSchema,
										task: "judge",
										scenario: scenario.id,
										step: stepIndex + 1,
										prompt: JSON.stringify({ task: "judge", groups }),
									};
									report.turns.push(evaluation);
									save();
									try {
										trace.phase = "semantic";
										try {
											evaluation.response = await complete(
												evaluation.prompt,
												evaluationSchema,
												"judge",
											);
										} catch (error) {
											throw new ProviderError(String(error));
										}
										save();
										const judgment = parseJudgment(
											evaluation.response.raw,
											groupIds,
										);
										assert.equal(
											judgment.passed,
											true,
											`Semantic evaluation: ${judgment.reason}`,
										);
									} catch (error) {
										evaluation.error = String(error);
										throw error;
									}
								};
								trace.phase = "protocol";
								if (step.task === "recall") {
									const selected = parseRecall(result.raw).map((id) => {
										const item = items.find((entry) => entry.itemId === id);
										if (item === undefined)
											throw new Error(
												`Recall returned unknown or inaccessible ID: ${id}`,
											);
										return item;
									});
									trace.after = host.list(true);
									await evaluate(selected);
								} else {
									const snapshot = join(directory, "before-forget.db");
									if (step.restoreBeforeForget) host.snapshot(snapshot);
									const decision = parseDecision(result.raw);
									trace.decision = decision;
									if (step.expectClarification !== undefined)
										assert.equal(
											Boolean(decision.clarification?.trim()),
											step.expectClarification,
											"Clarification expectation",
										);
									if (step.expectedActions !== undefined)
										assert.deepEqual(
											{
												remember: decision.actions.filter(
													(a) => a.type === "remember",
												).length,
												forget: decision.actions.filter(
													(a) => a.type === "forget",
												).length,
											},
											step.expectedActions,
											"Action count expectation",
										);
									const beforeHistory = host.list(true);
									const forgottenIds = new Set<string>();
									trace.phase = "effect";
									for (const action of decision.actions) {
										if (action.type === "remember")
											host.remember(action, step.message);
										else {
											assert.ok(
												items.some((item) => item.itemId === action.itemId),
												"Unknown forget target",
											);
											for (const id of host.forgetFact(action.itemId))
												forgottenIds.add(id);
										}
									}
									trace.after = host.list(true);
									const afterHistory = host.list(true);
									assert.ok(
										afterHistory.every(
											(item) => !forgottenIds.has(item.itemId),
										),
										"All versions of the selected facts must be forgotten",
									);
									if (
										decision.actions.length > 0 &&
										decision.actions.every((action) => action.type === "forget")
									)
										assert.deepEqual(
											afterHistory,
											beforeHistory.filter(
												(item) => !forgottenIds.has(item.itemId),
											),
											"Selective forget must preserve unrelated history",
										);
									await evaluate(host.list());
									if (step.restoreBeforeForget) {
										trace.phase = "recovery";
										assert.ok(
											forgottenIds.size > 0,
											"Restore probe requires a forget action",
										);
										host.close();
										rmSync(`${host.path}-wal`, { force: true });
										rmSync(`${host.path}-shm`, { force: true });
										copyFileSync(snapshot, host.path);
										host = new StandaloneHost(directory);
										assert.ok(
											host.startup.reapplied > 0,
											"Restore must replay the latest journal",
										);
										assert.deepEqual(
											host.list(true),
											afterHistory,
											"Restore must preserve survivors and not resurrect forgotten facts",
										);
									}
								}
								for (const item of host.list())
									assert.equal(item.origin, "agent_inferred");
							},
						);
						outcome.passedSteps += 1;
					}
					outcome.status = "passed";
				} catch (error) {
					outcome.status = "failed";
					outcome.failedStep = outcome.passedSteps + 1;
					outcome.error = String(error);
					options.log?.(
						`FAIL  ${scenario.id}: ${String(error)} (remaining steps skipped)`,
					);
					if (error instanceof ProviderError) throw error;
				} finally {
					host.close();
				}
			}
		};
		if (options.mode === "live") {
			if (options.withModel === undefined)
				throw new Error("Live mode requires a model client");
			await options.withModel(execute);
		} else await execute();
		report.status = report.scenarios.every(
			(scenario) => scenario.status === "passed",
		)
			? "passed"
			: "failed";
		const failedScenario = report.scenarios.find(
			(scenario) => scenario.status === "failed",
		);
		if (failedScenario?.error !== undefined)
			report.error = failedScenario.error;
	} catch (error) {
		report.status = "failed";
		report.error = String(error);
	} finally {
		save();
	}
	return report;
}

export function newRunDirectory(root: string): string {
	return join(
		root,
		"verification-reports",
		"memory-check",
		`${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
	);
}
