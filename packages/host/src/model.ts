import { readBoundedText } from "./io.ts";
import { Database } from "bun:sqlite";
import { demand, HOST_LIMITS, HostError, type Profile } from "./contracts.ts";
import { hostPlanningInstructions } from "./meaning/planning.ts";
import { hostGroundingInstructions } from "./meaning/retrieval.ts";
import type { Complete } from "./meaning/protocol.ts";

/** A configured executable implements Complete. No shell, model key or provider fallback. */
export function commandComplete(profile: Profile): Complete {
	return async (prompt, schema, task) => {
		demand(
			profile.modelCommand?.length && profile.modelDailyCalls,
			"MODEL_NOT_CONFIGURED",
		);
		const input = JSON.stringify({
			version: 1,
			prompt,
			schema,
			task,
			instructions:
				task === "decide"
					? hostPlanningInstructions
					: hostGroundingInstructions,
			maxOutputTokens: 4096,
		});
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
