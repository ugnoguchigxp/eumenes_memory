import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Budget, liability } from "../../examples/quality/budget.ts";
import {
	apiComplete,
	claudeSchema,
	type ApiFetch,
} from "../../examples/quality/api.ts";
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "memory-api-test-"));
	const budget = new Budget(join(dir, "cost.json"), 0.1);
	return {
		dir,
		budget,
		close: () => rmSync(dir, { recursive: true, force: true }),
	};
}
const schema = {
	type: "object",
	properties: { ok: { type: "boolean" } },
	required: ["ok"],
	additionalProperties: false,
};
test("persistent reservations prevent overspend across reopen and unknown outcomes", () => {
	const s = setup();
	try {
		const id = s.budget.reserve(0.08);
		expect(() => new Budget(s.budget.path, 0.1).reserve(0.03)).toThrow(
			"EXHAUSTED",
		);
		s.budget.settle(id, null);
		expect(liability(s.budget.snapshot())).toBe(0.08);
		expect(() => s.budget.settle(id, 0)).toThrow();
		expect(() => new Budget(s.budget.path, 10)).toThrow("cannot change");
	} finally {
		s.close();
	}
});
test("settlement releases only confirmed unused funds and corrupt/locked state fails closed", () => {
	const s = setup();
	try {
		const id = s.budget.reserve(0.08);
		s.budget.settle(id, 0.001);
		expect(s.budget.reserve(0.09)).toBeString();
		writeFileSync(s.budget.path + ".lock", "held");
		expect(() => s.budget.reserve(0.001)).toThrow();
		rmSync(s.budget.path + ".lock");
		writeFileSync(s.budget.path, "broken");
		expect(() => s.budget.reserve(0.001)).toThrow();
	} finally {
		s.close();
	}
});
test("nonfinite and negative accounting values cannot bypass cap", () => {
	const s = setup();
	try {
		for (const bad of [NaN, Infinity, -1, 0])
			expect(() => s.budget.reserve(bad)).toThrow();
		expect(() => new Budget(s.budget.path, 11)).toThrow();
	} finally {
		s.close();
	}
});
test("Claude transport removes unsupported limits without mutating authoritative schema", () => {
	const original = {
		...schema,
		properties: {
			value: { type: "string", maxLength: 3 },
			count: { type: "integer", maximum: 2 },
		},
	};
	const transformed = claudeSchema(original);
	expect(JSON.stringify(transformed)).not.toContain("maxLength");
	expect(original.properties.value.maxLength).toBe(3);
});
for (const provider of ["openai", "claude"] as const) {
	test(`${provider} complete records usage without exposing credentials to input`, async () => {
		const s = setup();
		try {
			let sent = "";
			const fetcher: ApiFetch = (async (_u: unknown, init: RequestInit) => {
				sent = String(init.body);
				return Response.json(
					provider === "openai"
						? {
								id: "r",
								status: "completed",
								usage: {
									input_tokens: 10,
									output_tokens: 5,
									total_tokens: 15,
									input_tokens_details: {
										cached_tokens: 0,
										cache_write_tokens: 0,
									},
									cache_creation_input_tokens: 0,
									cache_read_input_tokens: 0,
								},
								output: [
									{
										type: "message",
										content: [{ type: "output_text", text: '{"ok":true}' }],
									},
								],
							}
						: {
								id: "m",
								stop_reason: "end_turn",
								usage: {
									input_tokens: 10,
									output_tokens: 5,
									total_tokens: 15,
									input_tokens_details: {
										cached_tokens: 0,
										cache_write_tokens: 0,
									},
									cache_creation_input_tokens: 0,
									cache_read_input_tokens: 0,
								},
								content: [{ type: "text", text: '{"ok":true}' }],
							},
				);
			}) as ApiFetch;
			const value = await apiComplete({
				provider,
				budget: s.budget,
				logPath: join(s.dir, "calls"),
				key: "test-private-key",
				fetcher,
			})("synthetic", schema, "recall");
			expect(JSON.parse(value.raw)).toEqual({ ok: true });
			expect(value.threadId).toBeNull();
			expect(sent).not.toContain("test-private-key");
			expect(liability(s.budget.snapshot())).toBeLessThan(0.001);
		} finally {
			s.close();
		}
	});
	for (const failure of [
		"timeout",
		"429",
		"503",
		"refusal",
		"incomplete",
		"tool",
		"usage",
	] as const) {
		test(`${provider} ${failure} cannot become success or trigger hidden retry`, async () => {
			const s = setup();
			let calls = 0;
			try {
				const fetcher = (async () => {
					calls++;
					if (failure === "timeout") throw Error("network");
					if (failure === "429" || failure === "503")
						return Response.json(
							{ error: { type: "test" } },
							{ status: Number(failure) },
						);
					if (provider === "openai")
						return Response.json({
							status: failure === "incomplete" ? "incomplete" : "completed",
							usage:
								failure === "usage"
									? {}
									: {
											input_tokens: 10,
											output_tokens: 5,
											total_tokens: 15,
											input_tokens_details: {
												cached_tokens: 0,
												cache_write_tokens: 0,
											},
											cache_creation_input_tokens: 0,
											cache_read_input_tokens: 0,
										},
							output: [
								{
									type: failure === "tool" ? "function_call" : "message",
									content: [
										{
											type: failure === "refusal" ? "refusal" : "output_text",
											text: '{"ok":true}',
										},
									],
								},
							],
						});
					return Response.json({
						stop_reason:
							failure === "refusal"
								? "refusal"
								: failure === "incomplete"
									? "max_tokens"
									: "end_turn",
						usage:
							failure === "usage"
								? {}
								: {
										input_tokens: 10,
										output_tokens: 5,
										total_tokens: 15,
										input_tokens_details: {
											cached_tokens: 0,
											cache_write_tokens: 0,
										},
										cache_creation_input_tokens: 0,
										cache_read_input_tokens: 0,
									},
						content: [
							{
								type: failure === "tool" ? "tool_use" : "text",
								text: '{"ok":true}',
							},
						],
					});
				}) as ApiFetch;
				await expect(
					apiComplete({
						provider,
						budget: s.budget,
						logPath: join(s.dir, "calls"),
						key: "test",
						fetcher,
					})("synthetic", schema, "recall"),
				).rejects.toThrow();
				expect(calls).toBe(1);
				const ledger = s.budget.snapshot();
				expect(ledger.charges).toHaveLength(1);
				if (["timeout", "503", "usage"].includes(failure))
					expect(ledger.charges[0]!.actualUsd).toBeNull();
			} finally {
				s.close();
			}
		});
	}
	test(`${provider} input/output and cost limits reject before network`, async () => {
		const s = setup();
		let calls = 0;
		const fetcher = (async () => {
			calls++;
			throw Error("must not call");
		}) as ApiFetch;
		try {
			const complete = apiComplete({
				provider,
				budget: s.budget,
				logPath: join(s.dir, "calls"),
				key: "test",
				fetcher,
			});
			await expect(
				complete("x".repeat(600000), schema, "recall"),
			).rejects.toThrow("INPUT_BUDGET");
			s.budget.reserve(0.1);
			await expect(complete("x", schema, "recall")).rejects.toThrow(
				"EXHAUSTED",
			);
			expect(calls).toBe(0);
		} finally {
			s.close();
		}
	});
}

test("cache-write costs are counted once, malformed usage fails closed and rounding is conservative", async () => {
	const { tokenCostUpper } = await import("../../examples/quality/api.ts");
	expect(
		tokenCostUpper("openai", {
			input_tokens: 1000,
			output_tokens: 100,
			total_tokens: 1100,
			input_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 },
		}),
	).toBeCloseTo(0.000317, 6);
	expect(
		tokenCostUpper("claude", {
			input_tokens: 100,
			output_tokens: 10,
			cache_creation_input_tokens: 200,
			cache_read_input_tokens: 1000,
		}),
	).toBeCloseTo(0.0009, 6);
	expect(() =>
		tokenCostUpper("openai", {
			input_tokens: 2,
			output_tokens: 1,
			total_tokens: 3,
			input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
		}),
	).toThrow();
	expect(() =>
		tokenCostUpper("claude", { input_tokens: 2, output_tokens: 1 }),
	).toThrow();
});
test("provider errors cannot echo the configured API credential into saved results", async () => {
	const { readFileSync } = await import("node:fs");
	const s = setup();
	try {
		const secret = "synthetic-test-private-credential";
		const fetcher = (async () =>
			Response.json(
				{ error: { message: secret } },
				{ status: 401 },
			)) as ApiFetch;
		const complete = apiComplete({
			provider: "openai",
			budget: s.budget,
			logPath: join(s.dir, "calls"),
			key: secret,
			fetcher,
		});
		await expect(complete("synthetic", schema, "recall")).rejects.toThrow(
			"[redacted]",
		);
		expect(readFileSync(join(s.dir, "calls"), "utf8")).not.toContain(secret);
	} finally {
		s.close();
	}
});
