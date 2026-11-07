import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluate, freeze } from "../../examples/quality/evaluate.ts";
import { Budget } from "../../examples/quality/budget.ts";
import { ApiFailure } from "../../examples/quality/api.ts";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "retrieval-run-"));
	const manifest = freeze(directory);
	manifest.cases = manifest.cases.slice(0, 1);
	manifest.repetitions = 1;
	manifest.casesHash = createHash("sha256")
		.update(JSON.stringify(manifest.cases))
		.digest("hex");
	writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
	return {
		directory,
		manifest,
		options: { budgetDirectory: join(directory, "budget") },
		close: () => rmSync(directory, { recursive: true, force: true }),
	};
}

test("completed retrieval still fails quality when one provider makes a semantic error", async () => {
	const s = fixture();
	try {
		const value = s.manifest.cases[0]!.value;
		const report = await evaluate(s.directory, false, {
			...s.options,
			completeFor: (provider) => async () => ({
				raw: JSON.stringify({
					parts:
						provider === "openai"
							? value.parts.map((part) => ({
									request: value.message,
									status: part.status,
									evidenceIds: part.requiredIds,
								}))
							: [
									{
										request: value.message,
										status: "unknown",
										evidenceIds: [],
									},
								],
				}),
				threadId: null,
				usage: null,
			}),
		});
		expect(report.status).toBe("completed");
		expect(report.qualityPassed).toBe(false);
		expect(
			report.retrievalDiagnostics.groups.find((g) => g.provider === "claude")!
				.metrics.missedSupported.numerator,
		).toBe(1);
		expect(
			report.retrievalDiagnostics.groups.find((g) => g.provider === "openai")!
				.metrics.missedSupported.numerator,
		).toBe(0);
	} finally {
		s.close();
	}
});

test("unsettled cost reservations prevent new requests even without a pending row", async () => {
	const s = fixture();
	let calls = 0;
	try {
		const budget = new Budget(
			join(s.options.budgetDirectory, "cost-ledger.json"),
		);
		budget.reserve(0.01);
		await expect(
			evaluate(s.directory, false, {
				...s.options,
				completeFor: () => async () => {
					calls++;
					throw Error("must not dispatch");
				},
			}),
		).rejects.toThrow("API_BUDGET");
		expect(calls).toBe(0);
		expect(budget.snapshot().charges[0]!.status).toBe("reserved");
	} finally {
		s.close();
	}
});

test("retrieval writes pending before dispatch, rejects concurrent runs, and preserves raw failures without rerolls", async () => {
	const s = fixture();
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const raw =
		'{"parts":[{"request":"交通機関","status":"supported","evidenceIds":["invented"]}]}';
	try {
		const running = evaluate(s.directory, false, {
			...s.options,
			completeFor: () => async () => {
				calls++;
				await waiting;
				return { raw, threadId: null, usage: null };
			},
		});
		await setImmediate();
		const file = join(s.directory, "results.json");
		const pending = JSON.parse(readFileSync(file, "utf8"));
		expect(pending).toHaveLength(2);
		expect(
			pending.every((r: { pending?: boolean }) => r.pending === true),
		).toBe(true);
		await expect(evaluate(s.directory, false, s.options)).rejects.toThrow(
			"already active",
		);
		expect(calls).toBe(2);
		release();
		const report = await running;
		expect(report.status).toBe("incomplete");
		expect(report.qualityPassed).toBe(false);
		const rows = JSON.parse(readFileSync(file, "utf8"));
		expect(
			rows.every(
				(r: { raw: string; pending?: boolean }) =>
					r.raw === raw && r.pending === undefined,
			),
		).toBe(true);
		await evaluate(s.directory, false, {
			...s.options,
			completeFor: () => async () => {
				calls++;
				throw Error("must not reroll");
			},
		});
		expect(calls).toBe(2);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(rows);
	} finally {
		release();
		s.close();
	}
});

test("an unconfirmed checkpoint blocks dispatch even after its process lock is released", async () => {
	const s = fixture();
	let calls = 0;
	try {
		writeFileSync(
			join(s.directory, "results.json"),
			JSON.stringify([
				{
					provider: "openai",
					suite: s.manifest.cases[0]!.suite,
					id: s.manifest.cases[0]!.value.id,
					repetition: 0,
					status: "unavailable",
					durationMs: 0,
					pending: true,
				},
			]),
		);
		await expect(
			evaluate(s.directory, false, {
				...s.options,
				completeFor: () => async () => {
					calls++;
					throw Error("must not dispatch");
				},
			}),
		).rejects.toThrow("Unconfirmed pending");
		expect(calls).toBe(0);
	} finally {
		s.close();
	}
});

test("a failed checkpoint retains the run lock until all in-flight retrieval requests settle", async () => {
	const s = fixture();
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const running = evaluate(s.directory, false, {
		...s.options,
		completeFor: (provider) => async () => {
			calls++;
			if (provider === "claude") await waiting;
			else {
				await Promise.resolve();
				mkdirSync(join(s.directory, "results.json.tmp"));
			}
			return { raw: '{"parts":[]}', threadId: null, usage: null };
		},
	});
	const observed = running.then(
		() => false,
		() => true,
	);
	try {
		await setImmediate();
		await expect(evaluate(s.directory, false, s.options)).rejects.toThrow(
			"already active",
		);
		expect(calls).toBe(2);
	} finally {
		release();
		expect(await observed).toBe(true);
		expect(
			JSON.parse(readFileSync(join(s.directory, "results.json"), "utf8")).every(
				(r: { pending?: boolean }) => r.pending,
			),
		).toBe(true);
		s.close();
	}
});

test("freezing refuses orphaned results rather than creating a new experiment over them", () => {
	const directory = mkdtempSync(join(tmpdir(), "retrieval-orphan-"));
	try {
		writeFileSync(join(directory, "results.json"), "[]");
		expect(() => freeze(directory)).toThrow("new directory");
		expect(readFileSync(join(directory, "results.json"), "utf8")).toBe("[]");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("all provider adapters must initialize before any retrieval is dispatched", async () => {
	const s = fixture();
	let calls = 0;
	try {
		await expect(
			evaluate(s.directory, false, {
				...s.options,
				completeFor: (provider) => {
					if (provider === "claude")
						throw Error("missing provider configuration");
					return async () => {
						calls++;
						return { raw: '{"parts":[]}', threadId: null, usage: null };
					};
				},
			}),
		).rejects.toThrow("missing provider configuration");
		expect(calls).toBe(0);
	} finally {
		s.close();
	}
});

test.each(["configuration", "persistence"] as const)(
	"permanent API %s failures stop after calls already in flight",
	async (kind) => {
		const s = fixture();
		let calls = 0;
		try {
			s.manifest.repetitions = 3;
			writeFileSync(
				join(s.directory, "manifest.json"),
				JSON.stringify(s.manifest),
			);
			const report = await evaluate(s.directory, false, {
				...s.options,
				completeFor: () => async () => {
					calls++;
					throw new ApiFailure(kind, "fixture permanent failure");
				},
			});
			expect(report.status).toBe("incomplete");
			expect(calls).toBe(2);
		} finally {
			s.close();
		}
	},
);
