import { Codex } from "@openai/codex-sdk";
import type {
	CodexOptions,
	ThreadEvent,
	ThreadOptions,
} from "@openai/codex-sdk";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { instructionsFor } from "./protocol.ts";
import type { Complete, ModelResult, ModelTask } from "./protocol.ts";

export const MODEL = "gpt-6-luna";
export const SDK_VERSION = "0.163.0";

export function codexOptions(
	env: Record<string, string>,
	apiKey?: string,
	task: ModelTask = "decide",
	instruction: string = instructionsFor(task),
): CodexOptions {
	return {
		env,
		...(apiKey === undefined ? {} : { apiKey }),
		config: {
			developer_instructions: instruction,
			features: { shell_tool: false, multi_agent: false, skill_search: false },
			web_search: "disabled",
		},
	};
}

export function threadOptions(workingDirectory: string): ThreadOptions {
	return {
		model: MODEL,
		modelReasoningEffort: "medium",
		workingDirectory,
		sandboxMode: "read-only",
		skipGitRepoCheck: true,
		approvalPolicy: "never",
		networkAccessEnabled: false,
		webSearchMode: "disabled",
	};
}

/** Fail closed if the embedded decision model attempts anything except answering. */
export function assertNoTool(event: ThreadEvent): void {
	if (
		(event.type === "item.started" ||
			event.type === "item.updated" ||
			event.type === "item.completed") &&
		!["agent_message", "reasoning"].includes(event.item.type)
	)
		throw new Error(`Unexpected model activity: ${event.item.type}`);
}

/** Isolated configuration and fresh threads prevent inherited tools or conversation recall. */
export async function withLuna<T>(
	operation: (complete: Complete) => Promise<T>,
	instructions: Partial<Record<ModelTask, string>> = {},
): Promise<T> {
	const directory = mkdtempSync(join(tmpdir(), "memory-luna-"));
	try {
		const isolatedHome = join(directory, "codex");
		const work = join(directory, "work");
		mkdirSync(isolatedHome, { mode: 0o700 });
		mkdirSync(work, { mode: 0o700 });
		const apiKey =
			process.env["CODEX_API_KEY"] ?? process.env["OPENAI_API_KEY"];
		const authPath = join(
			process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
			"auth.json",
		);
		if (apiKey === undefined) {
			if (!existsSync(authPath))
				throw new Error(
					"Codex login file unavailable. Run codex login with file credential storage, or set CODEX_API_KEY / OPENAI_API_KEY.",
				);
			symlinkSync(authPath, join(isolatedHome, "auth.json"));
		}
		const env: Record<string, string> = { CODEX_HOME: isolatedHome };
		for (const key of [
			"PATH",
			"HOME",
			"TMPDIR",
			"TEMP",
			"TMP",
			"SSL_CERT_FILE",
			"SSL_CERT_DIR",
		]) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		return await operation(async (prompt, schema, task) => {
			const client = new Codex(
				codexOptions(env, apiKey, task, instructions[task]),
			);
			const thread = client.startThread(threadOptions(work));
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 120_000);
			let raw = "";
			let usage: ModelResult["usage"] = null;
			let completed = false;
			try {
				const stream = await thread.runStreamed(prompt, {
					outputSchema: schema,
					signal: controller.signal,
				});
				for await (const event of stream.events) {
					assertNoTool(event);
					if (event.type === "error") throw new Error(event.message);
					if (event.type === "turn.failed")
						throw new Error(event.error.message);
					if (
						event.type === "item.completed" &&
						event.item.type === "agent_message"
					)
						raw = event.item.text;
					if (event.type === "turn.completed") {
						completed = true;
						usage = event.usage;
					}
				}
				if (!completed || !raw) throw new Error("Incomplete model turn");
				return { raw, usage, threadId: thread.id };
			} finally {
				// SDK iterator cleanup terminates its child. Aborting after cleanup can
				// emit an unhandled AbortError after the SDK removes child listeners.
				clearTimeout(timeout);
			}
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
