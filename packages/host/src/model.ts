import { readBoundedText } from "./io.ts";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { demand, HOST_LIMITS, HostError, type Profile } from "./contracts.ts";
import { hostPlanningInstructions } from "./meaning/planning.ts";
import {
	hostGroundingInstructions,
	recallPrompt,
} from "./meaning/retrieval.ts";
import { evidenceSchema } from "./meaning/support.ts";
import type { ModelItem } from "./meaning/model-input.ts";
import type { Complete } from "./meaning/protocol.ts";

/** The measured payload is the exact UTF-8 envelope sent to the external adapter. */
export function encodeModelInput(
	prompt: string,
	schema: Parameters<Complete>[1],
	task: Parameters<Complete>[2],
) {
	return JSON.stringify({
		version: 1,
		prompt,
		schema,
		task,
		instructions:
			task === "decide" ? hostPlanningInstructions : hostGroundingInstructions,
		maxOutputTokens: 4096,
	});
}

export function measureRecallInput(
	items: readonly ModelItem[],
	message: string,
) {
	const textBytes = items
		.map((x) => Buffer.byteLength(x.value.text))
		.sort((a, b) => a - b);
	const textCharacters = items.map((x) => [...x.value.text].length);
	const totalTextBytes = textBytes.reduce((sum, n) => sum + n, 0);
	const prompt = recallPrompt(items, message);
	const modelInputBytes = Buffer.byteLength(
		encodeModelInput(prompt, evidenceSchema, "recall"),
	);
	return {
		inputFormatSha256: createHash("sha256")
			.update(encodeModelInput(recallPrompt([], ""), evidenceSchema, "recall"))
			.digest("hex"),
		itemCount: items.length,
		totalTextBytes,
		averageTextBytes: items.length ? totalTextBytes / items.length : 0,
		averageTextCharacters: items.length
			? textCharacters.reduce((sum, n) => sum + n, 0) / items.length
			: 0,
		p95TextBytes: textBytes[Math.ceil(textBytes.length * 0.95) - 1] ?? 0,
		maxTextBytes: textBytes.at(-1) ?? 0,
		questionBytes: Buffer.byteLength(message),
		promptBytes: Buffer.byteLength(prompt),
		modelInputBytes,
		modelInputLimitBytes: HOST_LIMITS.modelInputBytes,
		remainingBytes: HOST_LIMITS.modelInputBytes - modelInputBytes,
		fitsModelInput: modelInputBytes <= HOST_LIMITS.modelInputBytes,
	};
}

/** A configured executable implements Complete. No shell, model key or provider fallback. */
export function commandComplete(profile: Profile): Complete {
	return async (prompt, schema, task) => {
		demand(
			profile.modelCommand?.length && profile.modelDailyCalls,
			"MODEL_NOT_CONFIGURED",
		);
		const input = encodeModelInput(prompt, schema, task);
		demand(
			Buffer.byteLength(input) <= HOST_LIMITS.modelInputBytes,
			"MODEL_INPUT_TOO_LARGE",
		);
		// Separate admission ledger, never the Memory database. A crashed process releases its OS lock.
		const ledger = new Database(`${profile.socketPath}.model.lock`);
		let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (!child) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				if (child.exitCode === null) child.kill("SIGKILL");
			}
		};
		try {
			try {
				ledger.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
			} catch {
				throw new HostError("MODEL_BUSY");
			}
			ledger.exec(
				"CREATE TABLE IF NOT EXISTS reservations(day TEXT PRIMARY KEY, calls INTEGER NOT NULL)",
			);
			const day = new Date().toISOString().slice(0, 10);
			const row = ledger
				.query("SELECT calls FROM reservations WHERE day=?")
				.get(day) as { calls: number } | null;
			demand(
				(row?.calls ?? 0) < profile.modelDailyCalls,
				"MODEL_BUDGET_EXHAUSTED",
			);
			ledger
				.query(
					"INSERT INTO reservations VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1",
				)
				.run(day);
			// Persist the reservation before invoking a potentially billable external service, then retain the lock.
			ledger.exec("COMMIT; BEGIN EXCLUSIVE");
			child = Bun.spawn(profile.modelCommand, {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				detached: true,
			});
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					stop();
					reject(new HostError("MODEL_TIMEOUT", "failed"));
				}, HOST_LIMITS.modelTimeoutMs);
			});
			child.stdin.write(input);
			child.stdin.end();

			const [stdout, , code] = await Promise.race([
				Promise.all([
					readBoundedText(
						child.stdout,
						HOST_LIMITS.modelOutputBytes,
						"MODEL_OUTPUT_TOO_LARGE",
						"failed",
					),
					readBoundedText(
						child.stderr,
						HOST_LIMITS.modelOutputBytes,
						"MODEL_OUTPUT_TOO_LARGE",
						"failed",
					),
					child.exited,
				]),
				deadline,
			]);
			if (code !== 0) throw new HostError("MODEL_EXECUTION_FAILED", "failed");
			let result: { raw?: unknown } | null;
			try {
				result = JSON.parse(stdout) as typeof result;
			} catch {
				throw new HostError("MODEL_OUTPUT_INVALID", "failed");
			}
			if (
				typeof result?.raw !== "string" ||
				Buffer.byteLength(result.raw) > HOST_LIMITS.modelOutputBytes
			)
				throw new HostError("MODEL_OUTPUT_INVALID", "failed");
			return { raw: result.raw, usage: null, threadId: null };
		} finally {
			if (timer) clearTimeout(timer);
			stop();
			if (child && child.exitCode === null) {
				await child.exited;
			}
			ledger.close();
		}
	};
}
