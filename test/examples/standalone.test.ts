import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateItem } from "eumenes-memory";
import { runControls } from "../../examples/standalone/controls.ts";
import { semanticControls } from "../../examples/standalone/control-cases.ts";
import { regressionControls } from "../../examples/standalone/regression-controls.ts";
import { StandaloneHost } from "../../examples/standalone/host.ts";
import {
	assertNoTool,
	codexOptions,
	MODEL,
	threadOptions,
} from "../../examples/standalone/luna.ts";
import { parseArgs } from "../../examples/standalone/main.ts";
import {
	INSTRUCTIONS,
	decisionOutputSchema,
	recallOutputSchema,
	parseActions,
	parseJudgment,
	parseRecall,
	parseCoveredDecision,
	coveredDecisionSchema,
	judgeOutputSchema,
} from "../../examples/standalone/protocol.ts";
import {
	evaluationGroups,
	modelItems,
	semanticJudgeGroups,
	comparisonGroups,
} from "../../examples/standalone/model-input.ts";
import { replay, runChecks } from "../../examples/standalone/runner.ts";
import { scenarios } from "../../examples/standalone/scenarios.ts";
import { conversationScenarios } from "../../examples/standalone/conversations.ts";
import { holdoutScenarios } from "../../examples/standalone/holdout.ts";
import { transferScenarios } from "../../examples/standalone/transfer.ts";

import type { Complete } from "../../examples/standalone/protocol.ts";

function judgment(prompt: string, passed: boolean, reason: string): string {
	const input = JSON.parse(prompt) as {
		groups: ReturnType<typeof comparisonGroups>;
	};
	return JSON.stringify({
		groups: input.groups.map((group) => ({
			groupId: group.groupId,
			matches: group.actual.map((actual, index) => {
				const expected = group.expected[index]!;
				return {
					actualId: actual.id,
					expectedId: expected.id,
					actual: {
						quote: actual.text,
						relation: "test relation",
						relationType: "other",
						relationBasis: "text",
						notAsserted: [],
						qualifications: [],
					},
					expected: {
						quote: expected.text,
						relation: "test relation",
						relationType: "other",
						relationBasis: "text",
						notAsserted: [],
						qualifications: [],
					},
					missingFromActual: passed
						? []
						: [{ quote: expected.text, meaning: reason }],
					missingFromExpected: passed
						? []
						: [{ quote: actual.text, meaning: reason }],
					reason,
				};
			}),
		})),
	});
}

/** Adapt replay transports to the live coverage wire contract; never used by real model calls. */
async function coveredOperation(
	operation: (complete: Complete) => Promise<void>,
	complete: Complete,
) {
	return operation(async (prompt, schema, task) => {
		const result = await complete(prompt, schema, task);
		if (task !== "decide") return result;
		let output: Record<string, unknown>;
		try {
			output = JSON.parse(result.raw);
		} catch {
			return result;
		}
		if (!Array.isArray(output["actions"]) || "coverage" in output)
			return result;
		const ids = (JSON.parse(prompt).items as { itemId: string }[]).map(
			(item) => item.itemId,
		);
		const indexes = output["actions"].map((_, index) => index);
		return {
			...result,
			raw: JSON.stringify({
				coverage: [
					{
						request: "fixture request",
						basis: "fixture disposition",
						disposition: indexes.length
							? "change"
							: output["clarification"]
								? "clarify"
								: ids.length
									? "retain"
									: "ignore",
						itemIds: ids,
						actionIndexes: indexes,
					},
				],
				...output,
			}),
		};
	});
}

const directories: string[] = [];
function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "memory-example-test-"));
	directories.push(path);
	return path;
}
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

test("offline checks exercise real public APIs, restart, crash recovery and restore without a model", async () => {
	const report = await runChecks({
		directory: directory(),
		mode: "offline",
		withModel: () => {
			throw new Error("must not initialize live model");
		},
	});
	expect(report.status).toBe("passed");
	expect(report.checks).toHaveLength(17);
	expect(report.turns).toHaveLength(9);
	expect(report.model).toBeNull();
	expect(
		report.turns.every(
			(turn) =>
				turn.response?.usage === null && turn.response.threadId === null,
		),
	).toBe(true);
});

test("live path uses injected transport, with no expected answers or history in its prompts", async () => {
	const steps = scenarios.flatMap((scenario) => scenario.steps);
	let calls = 0;
	let evaluations = 0;
	const report = await runChecks({
		directory: directory(),
		mode: "live",
		withModel: async (operation) => {
			await coveredOperation(operation, async (prompt, _schema, task) => {
				const request = JSON.parse(prompt) as {
					task: string;
					message: string;
					items: StateItem[];
				};
				expect(request.task).toBe(task);
				if (request.task === "judge") {
					const judgmentInput = JSON.parse(prompt);
					expect(Object.keys(judgmentInput).sort()).toEqual(["groups", "task"]);
					expect(
						judgmentInput.groups.every(
							(group: { relationContext?: string }) =>
								group.relationContext === steps[calls - 1]!.criterion,
						),
					).toBe(true);
					expect(
						judgmentInput.groups.every(
							(group: { actual: string[]; expected: string[] }) =>
								group.actual.length === group.expected.length &&
								!("polarity" in group),
						),
					).toBe(true);
					evaluations += 1;
					return {
						raw: judgment(prompt, true, "test transport"),
						threadId: `judge-${evaluations}`,
						usage: null,
					};
				}
				expect(Object.keys(request).sort()).toEqual([
					"items",
					"message",
					"task",
				]);
				const step = steps[calls++]!;
				expect(request.message).toBe(step.message);
				if (task === "decide") {
					const schema = _schema as {
						properties: {
							actions: {
								items: {
									anyOf: { properties: { quote?: { enum: string[] } } }[];
								};
							};
						};
					};
					expect(
						schema.properties.actions.items.anyOf[0]!.properties.quote!.enum,
					).toEqual([request.message]);
				}
				if (request.task === "recall" && request.items.length === 0)
					expect(prompt).not.toContain("コーヒー");
				const replayed = replay(step, request.items);
				const output = JSON.parse(replayed.raw);
				// The basic fixtures use bare preference objects. Exercise genuine semantic routing.
				for (const action of output.actions ?? [])
					if (action.type === "remember") action.value.text += "が好き";
				return {
					...replayed,
					raw: JSON.stringify(output),
					threadId: `test-${calls}`,
					usage: { input_tokens: 10, output_tokens: 5 },
				};
			});
		},
	});
	expect(report.status).toBe("passed");
	expect(calls).toBe(9);
	expect(evaluations).toBe(7);
	expect(report.model).toBe(MODEL);
});

test("semantic judgment can fail the run; subject and polarity errors fail before judging", async () => {
	const step = scenarios[0]!.steps[0]!;
	for (const changeSubject of [false, true]) {
		const report = await runChecks({
			directory: directory(),
			mode: "live",
			cases: [{ id: "negative-judge", steps: [step] }],
			withModel: async (operation) => {
				await coveredOperation(operation, async (prompt) => {
					const request = JSON.parse(prompt);
					if (request.task === "judge")
						return {
							raw: judgment(prompt, false, "Different preference"),
							threadId: "judge",
							usage: null,
						};
					const result = replay(step, []);
					const paraphrase = JSON.parse(result.raw);
					paraphrase.actions[0].value.text += "が好き";
					result.raw = JSON.stringify(paraphrase);
					if (changeSubject) {
						const response = JSON.parse(result.raw);
						response.actions[0].subject = "other:person";
						response.actions[0].kind = "other_person_note";
						result.raw = JSON.stringify(response);
					}
					return result;
				});
			},
		});
		expect(report.status).toBe("failed");
		if (changeSubject) expect(report.turns).toHaveLength(1);
		else expect(report.error).toContain("Different preference");
	}
});

test("a provider failure is recorded, stops checks and cannot silently pass through replay", async () => {
	const path = directory();
	const report = await runChecks({
		directory: path,
		mode: "live",
		withModel: async (operation) => {
			await coveredOperation(operation, async () => {
				throw new Error("provider unavailable");
			});
		},
	});
	expect(report.status).toBe("failed");
	expect(report.turns).toHaveLength(1);
	expect(report.turns[0]?.error).toContain("provider unavailable");
	expect(report.checks.at(-1)?.status).toBe("failed");
	expect(
		JSON.parse(readFileSync(join(path, "report.json"), "utf8")).status,
	).toBe("failed");
});

test("model startup/auth failure still produces a failed report", async () => {
	const path = directory();
	const report = await runChecks({
		directory: path,
		mode: "live",
		withModel: async () => {
			throw new Error("login unavailable");
		},
	});
	expect(report.status).toBe("failed");
	expect(report.error).toContain("login unavailable");
	expect(report.turns).toHaveLength(0);
	expect(
		JSON.parse(readFileSync(join(path, "report.json"), "utf8")).error,
	).toContain("login unavailable");
});

test("malformed output and fabricated recall IDs fail without applying guessed actions", async () => {
	for (const raw of ["not json", '{"actions":[{"type":"invent"}]}']) {
		const report = await runChecks({
			directory: directory(),
			mode: "live",
			cases: [scenarios[0]!],
			withModel: async (operation) => {
				await coveredOperation(operation, async () => ({
					raw,
					threadId: "bad",
					usage: null,
				}));
			},
		});
		expect(report.status).toBe("failed");
		expect(report.turns).toHaveLength(1);
	}
	const report = await runChecks({
		directory: directory(),
		mode: "live",
		cases: [
			{
				id: "unknown",
				steps: [
					{
						task: "recall",
						message: "知っていますか？",
						expected: [],
						replay: { itemIds: [] },
					},
				],
			},
		],
		withModel: async (operation) => {
			await coveredOperation(operation, async () => ({
				raw: '{"answers":[{"request":"unknown","itemIds":["unknown"]}]}',
				threadId: "bad",
				usage: null,
			}));
		},
	});
	expect(report.status).toBe("failed");
	expect(report.error).toContain("unknown or inaccessible ID");
});

test("Japanese quote boundaries are computed from original UTF-8; ambiguous quotes are rejected", () => {
	const host = new StandaloneHost(directory());
	try {
		const action = {
			type: "remember" as const,
			kind: "preference" as const,
			subject: "self" as const,
			semanticKey: "drink",
			value: { text: "緑茶", polarity: "affirmed" as const },
			quote: "私は緑茶が好きです。",
			replacesItemId: null,
		};
		const item = host.remember(action, "🍵補足：私は緑茶が好きです。");
		expect(item.evidence[0]?.range).toEqual({
			startByte: Buffer.byteLength("🍵補足："),
			endByte: Buffer.byteLength("🍵補足：私は緑茶が好きです。"),
		});
		expect(() =>
			host.remember(action, "私は緑茶が好きです。私は緑茶が好きです。"),
		).toThrow("exactly once");
		expect(() =>
			host.remember(
				{ ...action, quote: "存在しない引用" },
				"私は緑茶が好きです。",
			),
		).toThrow("exactly once");
	} finally {
		host.close();
	}
});

test("SDK configuration preserves Luna and isolates tools, permissions and web access", () => {
	const env = { CODEX_HOME: "/isolated" };
	expect(codexOptions(env).env).toEqual(env);
	for (const task of ["decide", "recall", "judge"] as const) {
		expect(
			codexOptions(env, undefined, task).config?.["developer_instructions"],
		).toBe(INSTRUCTIONS[task]);
	}
	expect(new Set(Object.values(INSTRUCTIONS)).size).toBe(3);
	expect(codexOptions(env).config?.["features"]).toEqual({
		shell_tool: false,
		multi_agent: false,
		skill_search: false,
	});
	expect(threadOptions("/work")).toMatchObject({
		model: "gpt-6-luna",
		workingDirectory: "/work",
		sandboxMode: "read-only",
		approvalPolicy: "never",
		networkAccessEnabled: false,
		webSearchMode: "disabled",
	});
	expect(() =>
		assertNoTool({
			type: "item.completed",
			item: { type: "agent_message", id: "a", text: "{}" },
		}),
	).not.toThrow();
	expect(() =>
		assertNoTool({
			type: "item.started",
			item: {
				type: "command_execution",
				id: "a",
				command: "unexpected",
				aggregated_output: "",
				status: "in_progress",
			},
		}),
	).toThrow("Unexpected model activity");
});

test("model input preserves facts and identity labels without storage evidence or audit metadata", () => {
	const host = new StandaloneHost(directory());
	try {
		const step = scenarios[0]!.steps[0]!;
		const action = parseActions(replay(step, []).raw)[0]!;
		if (action.type !== "remember") throw new Error("Invalid fixture");
		const item = host.remember(action, step.message);
		const [projected] = modelItems(
			[item],
			[
				{ id: "self", label: "話し手本人" },
				{ id: "other:unrelated", label: "別の人物" },
			],
		);
		expect(projected).toEqual({
			itemId: item.itemId,
			revision: item.revision,
			subject: item.subject,
			subjectLabel: "話し手本人",
			kind: item.kind,
			semanticKey: item.semanticKey,
			value: item.value,
		});
		expect(Object.hasOwn(projected!, "evidence")).toBe(false);
		const validity = { fromMs: 1000, untilMs: 2000, basis: "stated" as const };
		expect(
			modelItems([
				{ ...item, validFromMs: 1000, validUntilMs: 2000, validity },
			])[0],
		).toMatchObject({ validFromMs: 1000, validUntilMs: 2000, validity });
		expect(
			modelItems([item], [{ id: "other:unrelated", label: "話し手本人" }])[0]
				?.subjectLabel,
		).toBeUndefined();
	} finally {
		host.close();
	}
});

test("protocol rejects unknown fields, invalid polarity, duplicate IDs; CLI defaults to offline", () => {
	expect(() =>
		parseActions('{"actions":[],"clarification":null,"extra":true}'),
	).toThrow();
	expect(() =>
		parseRecall('{"answers":[{"request":"duplicate","itemIds":["a","a"]}]}'),
	).toThrow();
	expect(() =>
		parseActions(
			'{"clarification":null,"actions":[{"type":"remember","kind":"preference","subject":"self","semanticKey":"x","quote":"x","replacesItemId":null,"value":{"text":"x","polarity":"maybe"}}]}',
		),
	).toThrow();
	expect(parseArgs([])).toEqual({ mode: "offline", suite: "basic" });
	expect(parseArgs(["--live"])).toEqual({ mode: "live", suite: "basic" });
	expect(
		parseArgs([
			"--suite",
			"conversation",
			"--scenario",
			"mixed-people-topics",
			"--live",
		]),
	).toEqual({
		mode: "live",
		suite: "conversation",
		scenario: "mixed-people-topics",
	});
	expect(() => parseArgs(["--live", "--offline"])).toThrow("Usage");
});

test("conversation fixtures preserve people, topics and unaffected histories through selective forget and restore", async () => {
	const report = await runChecks({
		directory: directory(),
		mode: "offline",
		cases: conversationScenarios,
	});
	expect(
		report.scenarios.map((scenario) => [scenario.id, scenario.error]),
	).toEqual(conversationScenarios.map((scenario) => [scenario.id, undefined]));
	expect(report.status).toBe("passed");
	expect(report.scenarios).toHaveLength(13);
	expect(report.checks).toHaveLength(report.plannedChecks);
});

test("a scenario failure skips its dependent steps but does not prevent independent experiments", async () => {
	const first = scenarios[0]!.steps[0]!;
	const second = scenarios[1]!.steps[0]!;
	const report = await runChecks({
		directory: directory(),
		mode: "live",
		cases: [
			{ id: "fails", steps: [first, first] },
			{ id: "independent", steps: [second] },
		],
		withModel: async (operation) => {
			let calls = 0;
			await coveredOperation(operation, async (prompt) => {
				if (JSON.parse(prompt).task === "judge")
					return {
						raw: judgment(prompt, true, "fixture"),
						threadId: null,
						usage: null,
					};
				calls += 1;
				return calls === 1
					? {
							raw: '{"actions":[],"clarification":null}',
							threadId: null,
							usage: null,
						}
					: replay(second, []);
			});
		},
	});
	expect(report.status).toBe("failed");
	expect(report.scenarios[0]).toMatchObject({
		status: "failed",
		failedStep: 1,
		passedSteps: 0,
		totalSteps: 2,
	});
	expect(report.scenarios[1]).toMatchObject({
		status: "passed",
		passedSteps: 1,
	});
	expect(report.checks).toHaveLength(10);
	expect(report.plannedChecks).toBe(11);
});

test("ambiguous requests must actually ask for clarification and perform no writes", async () => {
	const step = {
		task: "decide" as const,
		message: "誰の話か分からないので確認して",
		expected: [],
		expectClarification: true,
		expectedActions: { remember: 0, forget: 0 },
		replay: { actions: [] },
	};
	const report = await runChecks({
		directory: directory(),
		mode: "live",
		cases: [{ id: "clarification", steps: [step] }],
		withModel: async (operation) => {
			await coveredOperation(operation, async () => ({
				raw: '{"actions":[],"clarification":null}',
				threadId: null,
				usage: null,
			}));
		},
	});
	expect(report.status).toBe("failed");
	expect(report.error).toContain("Clarification expectation");
});

test("unseen holdout fixtures exercise unchanged host contracts and selective recovery", async () => {
	const cases = [...scenarios, ...conversationScenarios, ...holdoutScenarios];
	expect(new Set(cases.map((scenario) => scenario.id)).size).toBe(cases.length);
	expect(parseArgs(["--suite", "holdout", "--live"])).toEqual({
		mode: "live",
		suite: "holdout",
	});
	const report = await runChecks({
		directory: directory(),
		mode: "offline",
		cases: holdoutScenarios,
	});
	expect(
		report.scenarios.map((scenario) => [scenario.id, scenario.error]),
	).toEqual(holdoutScenarios.map((scenario) => [scenario.id, undefined]));
	expect(report.status).toBe("passed");
	expect(report.checks).toHaveLength(report.plannedChecks);
});

test("evaluator evidence survives restart, rejects forgotten items and detects altered sources", () => {
	const path = directory();
	let host = new StandaloneHost(path);
	try {
		const step = scenarios[0]!.steps[0]!;
		const action = parseActions(replay(step, []).raw)[0]!;
		if (action.type !== "remember") throw new Error("Invalid fixture");
		const item = host.remember(action, "🍵補足：" + step.message);
		expect(host.evidenceQuotes(item.itemId)).toEqual([action.quote]);
		host.close();
		host = new StandaloneHost(path);
		expect(host.evidenceQuotes(item.itemId)).toEqual([action.quote]);
		expect(() => host.evidenceQuotes("missing")).toThrow("No active item");
		const sourcesPath = join(path, "sources.jsonl");
		const original = readFileSync(sourcesPath, "utf8");
		const source = JSON.parse(original.trim());
		source.content += "changed";
		writeFileSync(sourcesPath, JSON.stringify(source) + "\n");
		expect(() => host.evidenceQuotes(item.itemId)).toThrow("digest mismatch");
		writeFileSync(sourcesPath, original);
		host.forgetFact(item.itemId);
		expect(() => host.evidenceQuotes(item.itemId)).toThrow("No active item");
	} finally {
		host.close();
	}
});

test("recall parts combine independent known answers and reject incomplete output contracts", () => {
	expect(
		parseRecall(
			JSON.stringify({
				answers: [
					{ request: "known", itemIds: ["a"] },
					{ request: "unknown", itemIds: [] },
					{ request: "another aspect", itemIds: ["a", "b"] },
				],
			}),
		),
	).toEqual(["a", "b"]);
	expect(() => parseRecall('{"answers":[]}')).toThrow();
	expect(() =>
		parseRecall('{"answers":[{"request":"","itemIds":[]}]}'),
	).toThrow();
	expect(() => parseRecall('{"itemIds":[]}')).toThrow();
});

test("snapshot schemas allow only supplied technical references without choosing their meanings", () => {
	const withIds = JSON.stringify(decisionOutputSchema(["id-a", "id-b"]));
	expect(withIds).toContain('"enum":["id-a","id-b"]');
	expect(withIds).toContain('"remember"');
	expect(JSON.stringify(decisionOutputSchema([]))).not.toContain('"forget"');
	expect(JSON.stringify(recallOutputSchema([]))).toContain('"maxItems":0');
	expect(JSON.stringify(recallOutputSchema(["id-a"]))).toContain(
		'"enum":["id-a"]',
	);
});

test("evaluation groups use structural identity, retain all meanings and require every verdict", () => {
	const a = {
		subject: "other:a" as const,
		kind: "other_person_note" as const,
		polarity: "affirmed" as const,
		text: "A",
	};
	const b = { ...a, subject: "other:b" as const, text: "B" };
	const groups = evaluationGroups([b, a], [a, b]);
	expect(groups.every((group) => group.actual[0] === group.expected[0])).toBe(
		true,
	);
	expect(
		evaluationGroups(
			[a, b],
			[
				{ ...a, text: "B" },
				{ ...b, text: "A" },
			],
		).every((group) => group.actual[0] !== group.expected[0]),
	).toBe(true);
	const input = comparisonGroups(groups);
	const raw = (values: boolean[]) => {
		const result = JSON.parse(
			judgment(JSON.stringify({ groups: input }), true, "verdict"),
		);
		result.groups = result.groups.slice(0, values.length);
		for (const [index, passed] of values.entries()) {
			const match = result.groups[index].matches[0];
			match.missingFromActual = passed
				? []
				: [{ quote: input[index]!.expected[0]!.text, meaning: "difference" }];
			match.missingFromExpected = passed
				? []
				: [{ quote: input[index]!.actual[0]!.text, meaning: "difference" }];
		}
		return JSON.stringify(result);
	};
	expect(parseJudgment(raw([true, true]), input).passed).toBe(true);
	expect(parseJudgment(raw([true, false]), input).passed).toBe(false);
	expect(() => parseJudgment(raw([true]), input)).toThrow("coverage");
	const duplicate = JSON.parse(raw([true, true]));
	duplicate.groups[1] = duplicate.groups[0];
	expect(() => parseJudgment(JSON.stringify(duplicate), input)).toThrow(
		"Invalid judgment group",
	);
});

test("literal fact equality reuses strict comparison without asking a model to reinterpret it", async () => {
	const step = scenarios[0]!.steps[0]!;
	let calls = 0;
	const report = await runChecks({
		directory: directory(),
		mode: "live",
		cases: [{ id: "exact-identity", steps: [step] }],
		withModel: async (operation) => {
			await coveredOperation(operation, async (prompt) => {
				calls++;
				if (JSON.parse(prompt).task === "judge")
					throw new Error("Identical facts need no semantic interpretation");
				return replay(step, []);
			});
		},
	});
	expect(report.status).toBe("passed");
	expect(calls).toBe(1);
	expect(report.turns).toHaveLength(1);
});

test("judge metadata projection factors out only common outer polarity without changing predicate text", () => {
	const a = {
		subject: "self" as const,
		kind: "preference" as const,
		polarity: "negated" as const,
		text: "この味が好きではない",
	};
	const groups = evaluationGroups([a], [{ ...a, text: "別の味が好き" }]);
	const projected = semanticJudgeGroups(groups);
	expect(projected[0]).not.toHaveProperty("polarity");
	expect(projected[0]!.actual).toEqual([a.text]);
	expect(projected[0]!.expected).toEqual(["別の味が好き"]);
	expect(groups[0]!.polarity).toBe("negated");
	for (const [forward, reverse] of [
		[false, true],
		[true, false],
		[false, false],
		[true, true],
	] as const) {
		const input = comparisonGroups(groups);
		const output = JSON.parse(
			judgment(
				JSON.stringify({ groups: input }),
				true,
				"a concrete comparison",
			),
		);
		const match = output.groups[0].matches[0];
		match.missingFromActual = forward
			? []
			: [{ quote: input[0]!.expected[0]!.text, meaning: "required meaning" }];
		match.missingFromExpected = reverse
			? []
			: [{ quote: input[0]!.actual[0]!.text, meaning: "extra meaning" }];
		expect(parseJudgment(JSON.stringify(output), input).passed).toBe(
			forward && reverse,
		);
	}
});

test("full-message evidence is one authorized literal span even when assertion parts are separated", () => {
	const message =
		"🍃対象甲と対象乙のどちらも、同じ制約を持ちます。記録してください。";
	const schema = JSON.parse(
		JSON.stringify(decisionOutputSchema([], message)),
	) as {
		properties: {
			actions: {
				items: { anyOf: { properties: { quote: { enum: string[] } } }[] };
			};
		};
	};
	const remember = schema.properties.actions.items.anyOf[0]!;
	expect(remember.properties.quote.enum).toEqual([message]);
	const host = new StandaloneHost(directory());
	try {
		const item = host.remember(
			{
				type: "remember",
				subject: "self",
				kind: "constraint",
				semanticKey: "source-span",
				value: { text: "制約がある", polarity: "affirmed" },
				quote: message,
				replacesItemId: null,
			},
			message,
		);
		expect(item.evidence[0]!.range).toEqual({
			startByte: 0,
			endByte: Buffer.byteLength(message),
		});
		expect(host.evidenceQuotes(item.itemId)).toEqual([message]);
		expect(() =>
			host.remember(
				{
					type: "remember",
					subject: "self",
					kind: "constraint",
					semanticKey: "bad-span",
					value: { text: "制約がある", polarity: "affirmed" },
					quote: "対象甲も…同じ制約を持ちます",
					replacesItemId: null,
				},
				message,
			),
		).toThrow("Quote");
	} finally {
		host.close();
	}
});

test("semantic controls retain all six prior inputs and fixed expected verdicts", () => {
	const baseline = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				"../../examples/standalone/results/2026-10-16-followup-improvement.json",
			),
			"utf8",
		),
	) as {
		diagnostics: {
			data: {
				probes: {
					name: string;
					expectedPassed: boolean;
					groups: (typeof semanticControls)[number]["groups"];
				}[];
			};
		}[];
	};
	const previous = baseline.diagnostics.flatMap((d) =>
		d.data.probes.map(({ name, expectedPassed, groups }) => ({
			name,
			expectedPassed,
			groups,
		})),
	);
	expect(semanticControls.slice(0, 6)).toEqual(previous);
});

test("fixed judge control mismatches remain failures across every planned repetition", async () => {
	let calls = 0;
	const result = await runControls(
		directory(),
		async (prompt) => {
			calls++;
			expect(JSON.stringify(JSON.parse(prompt).groups)).not.toContain(
				'"polarity"',
			);
			return {
				raw: judgment(prompt, true, "fixed test response"),
				threadId: `control-${calls}`,
				usage: null,
			};
		},
		3,
		semanticControls.slice(0, 2),
	);
	expect(result.status).toBe("failed");
	expect(result.plannedTrials).toBe(6);
	expect(calls).toBe(6);
	expect(result.trials.filter((t) => t.matched)).toHaveLength(3);
	expect(result.trials.filter((t) => !t.matched)).toHaveLength(3);
	expect(result.trials.every((t) => t.phase === "complete")).toBe(true);
});

test("paired failure controls vary only criterion and keep every planned verdict observable", async () => {
	const pair = regressionControls.slice(0, 2);
	expect(pair[0]!.groups).toEqual(pair[1]!.groups);
	expect(pair[0]!.criterion).toBeUndefined();
	expect(pair[1]!.criterion).toBeString();
	const prompts: Record<string, unknown>[] = [];
	const report = await runControls(
		directory(),
		async (prompt) => {
			prompts.push(JSON.parse(prompt));
			return {
				raw: judgment(prompt, false, "retained mismatch"),
				threadId: null,
				usage: null,
			};
		},
		3,
		pair,
	);
	expect(report.status).toBe("failed");
	expect(report.trials).toHaveLength(6);
	expect(prompts[0]).not.toHaveProperty("criterion");
	expect(
		(prompts[1]!["groups"] as { relationContext?: string }[])[0]!
			.relationContext,
	).toBe(pair[1]!.criterion ?? undefined);
	for (const prompt of prompts) {
		expect(prompt).not.toHaveProperty("expectedPassed");
		expect(prompt).not.toHaveProperty("source");
	}
});

test("a changed outer polarity is rejected before projecting semantic judge inputs", async () => {
	const step = scenarios[0]!.steps[0]!;
	let calls = 0;
	const report = await runChecks({
		directory: directory(),
		mode: "live",
		cases: [{ id: "outer-polarity-contract", steps: [step] }],
		withModel: async (operation) => {
			await coveredOperation(operation, async () => {
				calls++;
				const output = JSON.parse(replay(step, []).raw);
				output.actions[0].value.polarity = "negated";
				return {
					raw: JSON.stringify(output),
					threadId: "contract",
					usage: null,
				};
			});
		},
	});
	expect(report.status).toBe("failed");
	expect(calls).toBe(1);
	expect(report.turns[0]!.phase).toBe("structure");
	expect(report.turns.some((t) => t.purpose === "evaluation")).toBe(false);
});

test("new transfer gold exercises leisure, degree, unknown attributes and selective recovery", async () => {
	const report = await runChecks({
		directory: directory(),
		mode: "offline",
		cases: transferScenarios,
		withModel: async () => {
			throw new Error("offline only");
		},
	});
	expect(report.status).toBe("passed");
	expect(report.scenarios).toHaveLength(3);
	expect(report.checks).toHaveLength(19);
	expect(parseArgs(["--suite", "transfer"]).suite).toBe("transfer");
});

test("request coverage rejects silent contract gaps without manufacturing memory actions", () => {
	const decision = JSON.parse(replay(scenarios[0]!.steps[0]!, []).raw);
	const entry = {
		request: "新しい事実",
		basis: "現在の発話",
		disposition: "change",
		itemIds: [],
		actionIndexes: [0],
	};
	expect(
		parseCoveredDecision(JSON.stringify({ coverage: [entry], ...decision }), [])
			.actions,
	).toHaveLength(1);
	for (const coverage of [
		[],
		[{ ...entry, actionIndexes: [] }],
		[{ ...entry, disposition: "retain", actionIndexes: [] }],
		[{ ...entry, actionIndexes: [2] }],
	])
		expect(() =>
			parseCoveredDecision(JSON.stringify({ coverage, ...decision }), []),
		).toThrow();
	expect(() =>
		parseCoveredDecision(
			JSON.stringify({
				coverage: [{ ...entry, disposition: "ignore", actionIndexes: [] }],
				...decision,
			}),
			[],
		),
	).toThrow("Uncovered");
	const empty = { clarification: null, actions: [] };
	for (const disposition of [["ignore"], ["constraint"]])
		expect(() =>
			parseCoveredDecision(
				JSON.stringify({
					coverage: [{ ...entry, disposition, actionIndexes: [] }],
					...empty,
				}),
				[],
			),
		).toThrow("Inconsistent");
	expect(() =>
		parseCoveredDecision(JSON.stringify({ coverage: [entry], ...empty }), []),
	).toThrow();
	expect(() => parseCoveredDecision(JSON.stringify(empty), [])).toThrow();
	const ignored = parseCoveredDecision(
		JSON.stringify({
			coverage: [{ ...entry, disposition: "ignore", actionIndexes: [] }],
			...empty,
		}),
		[],
	);
	expect(ignored.actions).toEqual([]);
	expect(coveredDecisionSchema([], "原文").required).toContain("coverage");
	const constraint = {
		...entry,
		disposition: "constraint",
		itemIds: [],
		actionIndexes: [0],
	};
	expect(
		parseCoveredDecision(
			JSON.stringify({ coverage: [entry, constraint], ...decision }),
			[],
		).actions,
	).toHaveLength(1);
	expect(
		parseCoveredDecision(
			JSON.stringify({
				coverage: [{ ...constraint, actionIndexes: [] }],
				...empty,
			}),
			[],
		).actions,
	).toEqual([]);
});

test("pair readings retain full predicates, exact identities and grounded directional differences", () => {
	const a = {
		subject: "self" as const,
		kind: "habit" as const,
		polarity: "affirmed" as const,
		text: "平日だけ、朝に8分歩く",
	};
	const b = { ...a, text: "毎晩、図書を2冊読む" };
	const groups = comparisonGroups(evaluationGroups([a, b], [b, a]));
	expect(judgeOutputSchema(groups).required).toEqual(["groups"]);
	const raw = JSON.parse(judgment(JSON.stringify({ groups }), true, "paired"));
	// Reorder the expected side and its corresponding readings; pairing is by IDs, never positions.
	for (const match of raw.groups[0].matches) {
		const expected = groups[0]!.expected.find(
			(fact) => fact.text === match.actual.quote,
		)!;
		match.expectedId = expected.id;
		match.expected.quote = expected.text;
	}
	expect(parseJudgment(JSON.stringify(raw), groups).passed).toBe(true);
	const altered = structuredClone(raw);
	altered.groups[0].matches[0].expected.quote = "歩く";
	expect(() => parseJudgment(JSON.stringify(altered), groups)).toThrow(
		"reading",
	);
	const duplicated = structuredClone(raw);
	duplicated.groups[0].matches[1] = duplicated.groups[0].matches[0];
	expect(() => parseJudgment(JSON.stringify(duplicated), groups)).toThrow(
		"pairing",
	);
	const unsupported = structuredClone(raw);
	unsupported.groups[0].matches[0].actual.qualifications = [
		{ quote: "週末だけ", meaning: "除外" },
	];
	expect(() => parseJudgment(JSON.stringify(unsupported), groups)).toThrow(
		"citation",
	);
	const inconsistent = structuredClone(raw);
	inconsistent.groups[0].matches[0].actualEntailsExpected = false;
	expect(() => parseJudgment(JSON.stringify(inconsistent), groups)).toThrow(
		"Unexpected",
	);
});

test("live decisions cannot omit the new coverage contract or fall back to replay", async () => {
	const step = scenarios[0]!.steps[0]!;
	const result = await runChecks({
		directory: directory(),
		mode: "live",
		cases: [{ id: "coverage-contract", steps: [step] }],
		withModel: async (operation) => {
			await operation(async () => replay(step, []));
		},
	});
	expect(result.status).toBe("failed");
	expect(result.turns[0]!.phase).toBe("protocol");
	expect(result.turns[0]!.after).toBeUndefined();
});

test("malformed judge output fails each control trial while independent repetitions remain observable", async () => {
	let calls = 0;
	const report = await runControls(
		directory(),
		async () => {
			calls++;
			return {
				raw: '{"groups":[]}',
				usage: null,
				threadId: `invalid-${calls}`,
			};
		},
		3,
		semanticControls.slice(0, 1),
	);
	expect(calls).toBe(3);
	expect(report.status).toBe("failed");
	expect(
		report.trials.every(
			(trial) =>
				trial.phase === "contract" &&
				trial.matched === false &&
				trial.error !== undefined,
		),
	).toBe(true);
});

test("ellipsis context is copied without rewriting facts and cannot be fabricated by a reading", () => {
	const fact = {
		subject: "self" as const,
		kind: "preference" as const,
		polarity: "affirmed" as const,
		text: "明朝体が好き",
	};
	const groups = comparisonGroups(
		evaluationGroups([fact], [{ ...fact, text: "明朝体" }]),
		"好む書体の関係",
	);
	expect(groups[0]!.actual[0]!.text).toBe(fact.text);
	expect(groups[0]!.relationContext).toBe("好む書体の関係");
	const output = JSON.parse(
		judgment(JSON.stringify({ groups }), true, "ellipsis"),
	);
	output.groups[0].matches[0].expected.relationBasis = "contextual_ellipsis";
	expect(parseJudgment(JSON.stringify(output), groups).passed).toBe(true);
	delete groups[0]!.relationContext;
	expect(() => parseJudgment(JSON.stringify(output), groups)).toThrow(
		"reading",
	);
});
