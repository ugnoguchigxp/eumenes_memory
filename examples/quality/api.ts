/** Two external API adapters for the existing Complete contract. No execution tools are supplied. */
import { appendFileSync } from "node:fs";
import type { Complete, ModelTask } from "../standalone/protocol.ts";
import { instructionsFor } from "../standalone/protocol.ts";
import { Budget } from "./budget.ts";
export type Provider = "openai" | "claude";
export const MODELS = {
	openai: "gpt-6-luna",
	claude: "claude-sonnet-5-5",
} as const;
// Standard prices verified 2026-11-05. Reservation uses the higher long-context/OpenAI
// and cache-write/Claude input rates. Settlement uses explicit5m cache usage when returned.
export const RATES = {
	openai: { input: 0.2, output: 0.75, reserveInput: 0.5 },
	claude: { input: 2, output: 10, reserveInput: 4 },
} as const;
export class ApiFailure extends Error {
	constructor(
		readonly kind:
			| "configuration"
			| "transport"
			| "http"
			| "refusal"
			| "incomplete"
			| "contract",
		message: string,
	) {
		super(message);
	}
}
export type ApiFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface ApiOptions {
	provider: Provider;
	budget: Budget;
	logPath: string;
	instructions?: Partial<Record<ModelTask, string>>;
	maxOutput?: number;
	timeoutMs?: number;
	fetcher?: ApiFetch;
	key?: string;
}
/** Only remove transport-unsupported constraints. The existing local parsers retain every limit. */
export function claudeSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(claudeSchema);
	if (!schema || typeof schema !== "object") return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(
				([k]) =>
					![
						"minimum",
						"maximum",
						"minLength",
						"maxLength",
						"minItems",
						"maxItems",
					].includes(k),
			)
			.map(([k, v]) => [k, claudeSchema(v)]),
	);
}
function obj(x: unknown): Record<string, unknown> {
	if (!x || typeof x !== "object" || Array.isArray(x))
		throw new ApiFailure("contract", "Invalid API object");
	return x as Record<string, unknown>;
}
function num(x: unknown): number {
	if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0)
		throw new ApiFailure("contract", "Missing API usage");
	return x;
}
export function tokenCostUpper(provider: Provider, raw: unknown): number {
	const usage = obj(raw),
		input = num(usage["input_tokens"]),
		output = num(usage["output_tokens"]);
	let dollars: number;
	if (provider === "openai") {
		const details = obj(usage["input_tokens_details"]);
		const cached = num(details["cached_tokens"]),
			written = num(details["cache_write_tokens"]);
		if (
			cached + written > input ||
			num(usage["total_tokens"]) !== input + output
		)
			throw new ApiFailure("contract", "Inconsistent API token counts");
		// Higher long-context prices also bound short requests; cache writes may bill separately.
		dollars =
			((input - cached - written) * 0.2 +
				cached * 0.02 +
				written * 0.5 +
				output * 0.75) /
			1e6;
	} else {
		dollars =
			(input * 2 +
				num(usage["cache_creation_input_tokens"]) * 2.5 +
				num(usage["cache_read_input_tokens"]) * 0.1 +
				output * 10) /
			1e6;
	}
	return Math.ceil(dollars * 1e6) / 1e6;
}
export function apiComplete(options: ApiOptions): Complete {
	const { provider, budget, logPath } = options;
	const key =
		options.key ??
		(provider === "openai"
			? (process.env["OPENAI_API_KEY"] ?? process.env["OPEN_AI_API_KEY"])
			: (process.env["ANTHROPIC_API_KEY"] ?? process.env["CLAUDE_API_KEY"]));
	if (!key)
		throw new ApiFailure("configuration", `Missing ${provider} API key`);
	return async (prompt, schema, task) => {
		const maxOutput = options.maxOutput ?? (provider === "openai" ? 2048 : 768);
		if (!Number.isSafeInteger(maxOutput) || maxOutput < 16 || maxOutput > 4096)
			throw new ApiFailure("configuration", "Invalid output budget");
		const instructions = options.instructions?.[task] ?? instructionsFor(task);
		const body =
			provider === "openai"
				? {
						model: MODELS.openai,
						instructions,
						input: prompt,
						reasoning: { effort: "medium" },
						max_output_tokens: maxOutput,
						store: false,
						text: {
							format: {
								type: "json_schema",
								name: "memory_result",
								strict: true,
								schema,
							},
						},
					}
				: {
						model: MODELS.claude,
						max_tokens: maxOutput,
						cache_control: { type: "ephemeral" },
						system: instructions,
						messages: [{ role: "user", content: prompt }],
						output_config: {
							effort: "medium",
							format: { type: "json_schema", schema: claudeSchema(schema) },
						},
					};
		const encoded = JSON.stringify(body);
		// Conservative byte bound including schema and hidden-format overhead; never truncate the input.
		if (Buffer.byteLength(encoded) > 512000)
			throw new ApiFailure("contract", "API_INPUT_BUDGET_EXCEEDED");
		const inputBound = Buffer.byteLength(encoded) * 2 + 8192;
		const rate = RATES[provider];
		const reservation = budget.reserve(
			(inputBound * rate.reserveInput + maxOutput * rate.output) / 1e6,
		);
		const started = performance.now();
		let status = "uncertain",
			charge: number | null = null,
			responseId: unknown = null,
			rawUsage: unknown = null,
			responseBody: unknown = null;
		try {
			let response: Response;
			try {
				response = await (options.fetcher ?? fetch)(
					provider === "openai"
						? "https://api.openai.com/v1/responses"
						: "https://api.anthropic.com/v1/messages",
					{
						method: "POST",
						headers:
							provider === "openai"
								? {
										Authorization: `Bearer ${key}`,
										"Content-Type": "application/json",
									}
								: {
										"x-api-key": key,
										"anthropic-version": "2023-06-01",
										"Content-Type": "application/json",
									},
						body: encoded,
						signal: AbortSignal.timeout(options.timeoutMs ?? 120000),
					},
				);
			} catch {
				throw new ApiFailure("transport", "API transport failed or timed out");
			}
			responseBody = await response.json();
			const data = obj(responseBody);
			responseId =
				data["id"] ??
				response.headers.get("request-id") ??
				response.headers.get("x-request-id");
			if (!response.ok) {
				// Definitive request rejection has no generated completion. Other HTTP failures remain uncertain.
				if ([400, 401, 403, 404, 422, 429].includes(response.status))
					charge = 0;
				throw new ApiFailure(
					"http",
					`HTTP ${response.status}: ${JSON.stringify(data["error"] ?? {})
						.replaceAll(key, "[redacted]")
						.slice(0, 700)}`,
				);
			}
			rawUsage = data["usage"];
			const usage = obj(rawUsage);
			const inputTokens = num(
				usage[provider === "openai" ? "input_tokens" : "input_tokens"],
			);
			const outputTokens = num(usage["output_tokens"]);
			charge = tokenCostUpper(provider, usage);
			let raw = "";
			if (provider === "openai") {
				if (data["status"] !== "completed")
					throw new ApiFailure(
						"incomplete",
						`OpenAI status ${String(data["status"])}`,
					);
				for (const item of data["output"] as unknown[]) {
					const i = obj(item);
					if (i["type"] === "reasoning") continue;
					if (i["type"] !== "message")
						throw new ApiFailure("contract", "Unexpected API activity");
					for (const content of i["content"] as unknown[]) {
						const c = obj(content);
						if (c["type"] === "refusal")
							throw new ApiFailure("refusal", "OpenAI refusal");
						if (c["type"] !== "output_text" || typeof c["text"] !== "string")
							throw new ApiFailure("contract", "Unexpected output content");
						raw += c["text"];
					}
				}
			} else {
				if (data["stop_reason"] === "refusal")
					throw new ApiFailure("refusal", "Claude refusal");
				if (data["stop_reason"] !== "end_turn")
					throw new ApiFailure(
						"incomplete",
						`Claude stop ${String(data["stop_reason"])}`,
					);
				for (const item of data["content"] as unknown[]) {
					const i = obj(item);
					if (i["type"] === "thinking" || i["type"] === "redacted_thinking")
						continue;
					if (i["type"] !== "text" || typeof i["text"] !== "string")
						throw new ApiFailure("contract", "Unexpected API activity");
					raw += i["text"];
				}
			}
			if (!raw) throw new ApiFailure("incomplete", "Missing API output");
			JSON.parse(raw);
			status = "completed";
			return {
				raw,
				threadId: null,
				usage: { input_tokens: inputTokens, output_tokens: outputTokens },
			};
		} catch (error) {
			status = error instanceof ApiFailure ? error.kind : "contract";
			throw error;
		} finally {
			// Save accounting before reporting completion. No hidden SDK retry or additional call.
			budget.settle(reservation, charge);
			appendFileSync(
				logPath,
				JSON.stringify({
					reservation,
					provider,
					model: MODELS[provider],
					task,
					status,
					durationMs: performance.now() - started,
					responseId,
					usage: rawUsage,
					costUpperUsd: charge,
					input: prompt,
					schema,
					instructions,
					response:
						responseBody === null
							? null
							: JSON.parse(
									JSON.stringify(responseBody).replaceAll(key, "[redacted]"),
								),
				}) + "\n",
				{ mode: 0o600 },
			);
		}
	};
}
