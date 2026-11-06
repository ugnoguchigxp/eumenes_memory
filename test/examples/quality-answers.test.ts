import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	calibrationCases,
	calibrate,
	parseAnswerJudge,
	parseAnswer,
	freezeAnswerRun,
	loadAnswerRun,
	answerTrials,
	answerTrialSpecs,
	resumeTransientStages,
	type AnswerTrial,
} from "../../examples/quality/answers.ts";
import { ApiFailure } from "../../examples/quality/api.ts";
import { Budget } from "../../examples/quality/budget.ts";
test("calibration retains40 controls and adds24 balanced structured boundary controls", () => {
	expect(calibrationCases).toHaveLength(64);
	expect(calibrationCases.filter((x) => x.expected)).toHaveLength(32);
	expect(new Set(calibrationCases.map((x) => x.id)).size).toBe(64);
	for (const x of calibrationCases) {
		expect(x.question).not.toBe("");
		expect(x.answer).not.toBe("");
	}
});
test("fixed80 trials remain intact alongside generalization and repeated regressions", () => {
	const trials = answerTrialSpecs();
	expect(trials.filter((t) => t.suite === "fixed")).toHaveLength(80);
	expect(trials.filter((t) => t.suite === "generalization")).toHaveLength(24);
	expect(trials.filter((t) => t.suite === "regression")).toHaveLength(16);
	expect(new Set(trials.map((t) => t.key)).size).toBe(120);
});
test("answer contract rejects unknown or duplicate references without repairing output", () => {
	const items = answerTrialSpecs()[0]!.value.items;
	const id = items[0]!.itemId;
	expect(
		parseAnswer(JSON.stringify({ answer: "answer", evidenceIds: [id] }), items)
			.evidenceIds,
	).toEqual([id]);
	for (const value of [
		{ answer: "", evidenceIds: [] },
		{ answer: "answer", evidenceIds: [id, id] },
		{ answer: "answer", evidenceIds: [id.slice(0, -1)] },
		{ answer: "answer", evidenceIds: [], extra: true },
	])
		expect(() => parseAnswer(JSON.stringify(value), items)).toThrow();
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "answer-checkpoint-"));
	const manifest = freezeAnswerRun(directory, join(directory, "budget"));
	writeFileSync(
		join(directory, "calibration.json"),
		JSON.stringify(
			(["openai", "claude"] as const).flatMap((provider) =>
				calibrationCases.map((c) => ({
					provider,
					id: c.id,
					expected: c.expected,
					actual: c.expected,
					passed: true,
				})),
			),
		),
	);
	writeFileSync(
		join(directory, "calibration-summary.json"),
		JSON.stringify({
			fingerprint: manifest.fingerprint,
			groups: ["openai", "claude"].map((provider) => ({
				provider,
				eligible: true,
				completed: 64,
				planned: 64,
				passed: 64,
				falsePasses: 0,
			})),
		}),
	);
	return {
		directory,
		manifest,
		close: () => rmSync(directory, { recursive: true, force: true }),
	};
}
test("one run directory rejects concurrent paid stages and records calibration in-flight state", async () => {
	const s = fixture();
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	try {
		rmSync(join(s.directory, "calibration.json"));
		const first = calibrate(s.directory, {
			completeFor: () => async () => {
				calls++;
				await waiting;
				throw new ApiFailure("configuration", "fixture stop");
			},
		});
		// Both provider workers are now waiting on their first response.
		const second = calibrate(s.directory, {
			completeFor: () => async () => {
				calls++;
				throw Error("duplicate dispatch");
			},
		});
		try {
			await expect(second).rejects.toThrow("already active");
			expect(calls).toBe(2);
			const pending = JSON.parse(
				readFileSync(join(s.directory, "calibration.json"), "utf8"),
			);
			expect(pending).toHaveLength(2);
			expect(
				pending.every((r: { pending?: boolean }) => r.pending === true),
			).toBe(true);
		} finally {
			release();
			await first;
		}
	} finally {
		release();
		s.close();
	}
});
test("persisted invalid verdicts and evidence cannot be counted as quality passes", async () => {
	const s = fixture();
	let calls = 0;
	try {
		const rows = s.manifest.trials.map((t) => ({
			key: t.key,
			id: t.value.id,
			suite: t.suite,
			provider: t.provider,
			repetition: t.repetition,
			answer: { answer: "fixture", evidenceIds: [] },
			judges: (["openai", "claude"] as const).map((provider) => ({
				provider,
				eligible: true,
				faithful: true,
				violations: [],
				reason: "fixture",
			})),
		}));
		const invalidVariants = [
			{
				...rows[0],
				answer: { answer: "fixture", evidenceIds: ["missing-id"] },
			},
			{ ...rows[0], id: "different-trial" },
			{ ...rows[0], recoveryAttempts: -1 },
			{
				...rows[0],
				judges: rows[0]!.judges.map((j) => ({ ...j, faithful: "false" })),
			},
			{ ...rows[0], judges: [rows[0]!.judges[0], rows[0]!.judges[0]] },
		];
		for (const invalid of invalidVariants) {
			writeFileSync(
				join(s.directory, "answers.json"),
				JSON.stringify([invalid, ...rows.slice(1)]),
			);
			await expect(
				answerTrials(s.directory, {
					onProgress: () => {},
					completeFor: () => async () => {
						calls++;
						throw Error("must reject before dispatch");
					},
				}),
			).rejects.toThrow();
		}
		expect(calls).toBe(0);
	} finally {
		s.close();
	}
});
test("duplicate calibration controls cannot substitute for missing boundary controls", async () => {
	const s = fixture();
	try {
		const path = join(s.directory, "calibration.json");
		const rows = JSON.parse(readFileSync(path, "utf8"));
		rows[63] = { ...rows[0] };
		writeFileSync(path, JSON.stringify(rows));
		await expect(
			answerTrials(s.directory, {
				onProgress: () => {},
				completeFor: () => async () => {
					throw Error("must reject before dispatch");
				},
			}),
		).rejects.toThrow("calibration checkpoint");
	} finally {
		s.close();
	}
});
test("calibration needs an observed verdict for every control, even within error tolerance", async () => {
	const s = fixture();
	let calls = 0;
	try {
		const file = join(s.directory, "calibration.json");
		const rows = JSON.parse(readFileSync(file, "utf8"));
		for (const provider of ["openai", "claude"]) {
			const row = rows.find(
				(r: { provider: string }) => r.provider === provider,
			);
			Object.assign(row, {
				actual: null,
				passed: false,
				error: "Error: output unavailable",
			});
		}
		writeFileSync(file, JSON.stringify(rows));
		const summary = join(s.directory, "calibration-summary.json");
		const saved = JSON.parse(readFileSync(summary, "utf8"));
		for (const group of saved.groups) group.passed = 63;
		writeFileSync(summary, JSON.stringify(saved));
		await expect(
			answerTrials(s.directory, {
				onProgress: () => {},
				completeFor: () => async () => {
					calls++;
					return {
						raw: '{"answer":"fixture","evidenceIds":[]}',
						threadId: null,
						usage: null,
					};
				},
			}),
		).rejects.toThrow("Both frozen judges");
		expect(calls).toBe(0);
	} finally {
		s.close();
	}
});
test("checkpoint failure retains the run lock until all dispatched workers settle", async () => {
	const s = fixture();
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const first = answerTrials(s.directory, {
		onProgress: () => {},
		completeFor: (provider) => async () => {
			calls++;
			if (provider === "claude") await waiting;
			else {
				await Promise.resolve(); // Let the other worker dispatch before making persistence fail.
				mkdirSync(join(s.directory, "answers.json.tmp"));
			}
			return {
				raw: '{"answer":"fixture","evidenceIds":[]}',
				threadId: null,
				usage: null,
			};
		},
	});
	const observed = first.then(
		() => ({ failed: false }),
		() => ({ failed: true }),
	);
	try {
		await setImmediate();
		await expect(answerTrials(s.directory)).rejects.toThrow("already active");
		expect(calls).toBe(2);
	} finally {
		release();
		expect((await observed).failed).toBe(true);
		s.close();
	}
});
test("unconfirmed calibration checkpoints stop without repeating a request", async () => {
	const s = fixture();
	let calls = 0;
	try {
		const file = join(s.directory, "calibration.json");
		const rows = JSON.parse(readFileSync(file, "utf8"));
		Object.assign(rows[0], { actual: null, passed: false, pending: true });
		writeFileSync(file, JSON.stringify(rows));
		await expect(
			calibrate(s.directory, {
				completeFor: () => async () => {
					calls++;
					throw Error("not dispatched");
				},
			}),
		).rejects.toThrow("Unconfirmed pending calibration");
		expect(calls).toBe(0);
	} finally {
		s.close();
	}
});
test("permanent API failures stop calibration after requests already in flight", async () => {
	const s = fixture();
	let calls = 0;
	try {
		rmSync(join(s.directory, "calibration.json"));
		await calibrate(s.directory, {
			completeFor: () => async () => {
				calls++;
				throw new ApiFailure("http", "HTTP 401: unauthorized");
			},
		});
		expect(calls).toBe(2);
	} finally {
		s.close();
	}
});
test("blocked accounting prevents new trials without altering evidence", async () => {
	const s = fixture();
	let calls = 0;
	try {
		const budget = new Budget(join(s.directory, "budget", "cost-ledger.json"));
		budget.settle(budget.reserve(0.01), null);
		await expect(
			answerTrials(s.directory, {
				onProgress: () => {},
				completeFor: () => async () => {
					calls++;
					throw Error("not dispatched");
				},
			}),
		).rejects.toThrow("API_BUDGET");
		expect(calls).toBe(0);
		expect(() => readFileSync(join(s.directory, "answers.json"))).toThrow();
	} finally {
		s.close();
	}
});
test("reviewed HTTP recovery respects Retry-After and the two-attempt limit", () => {
	const s = fixture();
	try {
		const t = s.manifest.trials[0]!;
		const row: AnswerTrial = {
			key: t.key,
			id: t.value.id,
			suite: t.suite,
			provider: t.provider,
			repetition: t.repetition,
			answer: { answer: "fixture", evidenceIds: [] },
			judges: [],
			error: {
				stage: "judge:openai",
				message: "Error: HTTP 503: busy",
				kind: "http",
				httpStatus: 503,
				retryNotBefore: new Date(Date.now() + 120000).toISOString(),
			},
		};
		const file = join(s.directory, "answers.json");
		writeFileSync(file, JSON.stringify([row]));
		expect(() =>
			resumeTransientStages(s.directory, [row.key], "reviewed"),
		).toThrow("Retry-After");
		row.error!.retryNotBefore = new Date(Date.now() - 1000).toISOString();
		for (let attempt = 0; attempt < 2; attempt++) {
			writeFileSync(file, JSON.stringify([row]));
			resumeTransientStages(
				s.directory,
				[row.key],
				"reviewed missing judgment",
			);
			const resumed: AnswerTrial = JSON.parse(readFileSync(file, "utf8"))[0];
			expect(resumed.recoveryAttempts).toBe(attempt + 1);
			row.recoveryAttempts = resumed.recoveryAttempts!;
			row.recoveredFailures = resumed.recoveredFailures!;
		}
		writeFileSync(file, JSON.stringify([row]));
		expect(() =>
			resumeTransientStages(s.directory, [row.key], "third retry"),
		).toThrow("Only reviewed");
	} finally {
		s.close();
	}
});
test("frozen cases reject tampering and existing results cannot be overwritten", () => {
	const s = fixture();
	try {
		expect(() => freezeAnswerRun(s.directory)).toThrow("new directory");
		const file = join(s.directory, "answer-manifest.json");
		const value = JSON.parse(readFileSync(file, "utf8"));
		value.trials[0].value.message = "changed";
		writeFileSync(file, JSON.stringify(value));
		expect(() => loadAnswerRun(s.directory)).toThrow("Frozen answer");
	} finally {
		s.close();
	}
});
test("judge failure retains generated answer and prior verdict, with no reroll on resume", async () => {
	const s = fixture();
	let generated = 0,
		fail = true;
	try {
		const report = await answerTrials(s.directory, {
			onProgress: () => {},
			completeFor: (provider, task) => async (prompt) => {
				if (task === "recall") {
					generated++;
					return {
						raw: '{"answer":"fixture","evidenceIds":[]}',
						threadId: null,
						usage: null,
					};
				}
				if (provider === "claude" && fail) {
					fail = false;
					throw Error("simulated judge failure");
				}
				expect(Array.isArray(JSON.parse(prompt).parts)).toBe(true);
				return {
					raw: '{"faithful":true,"violations":[],"reason":"fixture"}',
					threadId: null,
					usage: null,
				};
			},
		});
		const rows: AnswerTrial[] = JSON.parse(
			readFileSync(join(s.directory, "answers.json"), "utf8"),
		);
		const failed = rows.find((r) => r.error)!;
		expect(failed.answer?.answer).toBe("fixture");
		expect(failed.judges).toHaveLength(1);
		expect(failed.judges[0]!.provider).toBe("openai");
		expect(generated).toBe(120);
		expect(report.status).toBe("incomplete");
		await answerTrials(s.directory, {
			onProgress: () => {},
			completeFor: () => async () => {
				throw Error("must not dispatch again");
			},
		});
		expect(
			JSON.parse(readFileSync(join(s.directory, "answers.json"), "utf8")),
		).toEqual(rows);
	} finally {
		s.close();
	}
});
test("unconfirmed in-flight state and uncalibrated judges block dispatch", async () => {
	const s = fixture();
	let calls = 0;
	const options = {
		onProgress: () => {},
		completeFor: () => async () => {
			calls++;
			throw Error("unexpected request");
		},
	};
	try {
		const t = s.manifest.trials[0]!;
		const row = {
			key: t.key,
			id: t.value.id,
			suite: t.suite,
			provider: t.provider,
			repetition: 0,
			judges: [],
			pending: "answer:openai",
		};
		writeFileSync(join(s.directory, "answers.json"), JSON.stringify([row]));
		await expect(answerTrials(s.directory, options)).rejects.toThrow(
			"Unconfirmed pending",
		);
		rmSync(join(s.directory, "answers.json"));
		writeFileSync(
			join(s.directory, "calibration-summary.json"),
			JSON.stringify({ fingerprint: s.manifest.fingerprint, groups: [] }),
		);
		await expect(answerTrials(s.directory, options)).rejects.toThrow(
			"Both frozen judges",
		);
		expect(calls).toBe(0);
	} finally {
		s.close();
	}
});
test("reviewed transport recovery reuses the answer and retains the failed attempt", async () => {
	const s = fixture();
	let generated = 0,
		fail = true;
	try {
		await answerTrials(s.directory, {
			onProgress: () => {},
			completeFor: (provider, task) => async () => {
				if (task === "recall") {
					generated++;
					return {
						raw: '{"answer":"fixture","evidenceIds":[]}',
						threadId: null,
						usage: null,
					};
				}
				if (provider === "claude" && fail) {
					fail = false;
					throw new ApiFailure(
						"transport",
						"API transport failed or timed out",
					);
				}
				return {
					raw: '{"faithful":true,"violations":[],"reason":"fixture"}',
					threadId: null,
					usage: null,
				};
			},
		});
		const rows: AnswerTrial[] = JSON.parse(
			readFileSync(join(s.directory, "answers.json"), "utf8"),
		);
		const failed = rows.find((r) => r.error)!;
		expect(generated).toBeLessThan(120);
		resumeTransientStages(
			s.directory,
			[failed.key],
			"Reviewed transient failure",
		);
		const report = await answerTrials(s.directory, {
			onProgress: () => {},
			completeFor: (_provider, task) => async () => {
				if (task === "recall") {
					generated++;
					return {
						raw: '{"answer":"fixture","evidenceIds":[]}',
						threadId: null,
						usage: null,
					};
				}
				return {
					raw: '{"faithful":true,"violations":[],"reason":"recovered"}',
					threadId: null,
					usage: null,
				};
			},
		});
		expect(generated).toBe(120);
		expect(report.status).toBe("completed");
		const finalRows: AnswerTrial[] = JSON.parse(
			readFileSync(join(s.directory, "answers.json"), "utf8"),
		);
		expect(
			finalRows.find((r) => r.key === failed.key)!.recoveredFailures,
		).toHaveLength(1);
		for (const before of rows) {
			const after = finalRows.find((r) => r.key === before.key)!;
			expect(after.answer).toEqual(before.answer);
			for (const judge of before.judges)
				expect(after.judges).toContainEqual(judge);
		}
		expect(() =>
			resumeTransientStages(
				s.directory,
				[failed.key],
				"Cannot reroll a completed verdict",
			),
		).toThrow();
	} finally {
		s.close();
	}
});
test("answer judgment rejects contradictory verdicts and missing or ungrounded fields", () => {
	expect(
		parseAnswerJudge('{"faithful":true,"violations":[],"reason":"supported"}')
			.faithful,
	).toBe(true);
	for (const raw of [
		"{}",
		'{"faithful":true,"violations":["unsupported"],"reason":"x"}',
		'{"faithful":false,"violations":[],"reason":"x"}',
		'{"faithful":false,"violations":[""],"reason":"x"}',
	])
		expect(() => parseAnswerJudge(raw)).toThrow();
});
