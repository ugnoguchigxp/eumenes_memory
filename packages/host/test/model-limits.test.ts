import { expect, test, spyOn } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandComplete, encodeModelInput } from "../src/model.ts";
import { HOST_LIMITS, type Profile } from "../src/contracts.ts";

test("the exact model input limit is admitted; UTF-8 overflow is rejected before a second reservation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "em-model-input-"));
	try {
		const profile: Profile = {
			version: 1,
			socketPath: join(dir, "m.sock"),
			credential: "unused",
			modelDailyCalls: 1,
			modelCommand: [
				process.execPath,
				"-e",
				"const input=await Bun.stdin.text(); console.log(JSON.stringify({raw:String(Buffer.byteLength(input))}));",
			],
		};
		const base = Buffer.byteLength(encodeModelInput("", {}, "recall"));
		const prompt = "x".repeat(HOST_LIMITS.modelInputBytes - base);
		const complete = commandComplete(profile);
		expect((await complete(prompt, {}, "recall")).raw).toBe(
			String(HOST_LIMITS.modelInputBytes),
		);
		await expect(complete(prompt + "あ", {}, "recall")).rejects.toMatchObject({
			code: "MODEL_INPUT_TOO_LARGE",
			status: "blocked",
		});
		await expect(complete("", {}, "recall")).rejects.toMatchObject({
			code: "MODEL_BUDGET_EXHAUSTED",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("G5 model deadline includes inherited output pipes and stops remaining child processes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "em-model-deadline-"));
	const pidFile = join(dir, "child.pid");
	const program = join(dir, "adapter.ts");
	writeFileSync(
		program,
		`await Bun.stdin.text(); const child=Bun.spawn([process.execPath,"-e","setTimeout(()=>{},10000)"],{stdin:"ignore",stdout:"inherit",stderr:"inherit"}); await Bun.write(${JSON.stringify(pidFile)},String(child.pid)); console.log(JSON.stringify({raw:"{}"})); process.exit(0);`,
	);
	const originalTimer = globalThis.setTimeout;
	const timing = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: Parameters<typeof setTimeout>[0],
		ms?: number,
		...args: unknown[]
	) =>
		originalTimer(
			callback,
			ms === HOST_LIMITS.modelTimeoutMs ? 300 : ms,
			...args,
		)) as typeof setTimeout);
	const profile: Profile = {
		version: 1,
		socketPath: join(dir, "m.sock"),
		credential: "unused",
		modelCommand: [process.execPath, program],
		modelDailyCalls: 1,
	};
	const running = commandComplete(profile)("{}", {}, "recall").then(
		() => ({ code: "UNEXPECTED_SUCCESS" }),
		(error: unknown) => ({ code: (error as { code?: string }).code }),
	);
	try {
		const result = await Promise.race([
			running,
			new Promise<{ code: string }>((resolve) =>
				originalTimer(() => resolve({ code: "DEADLINE_MISSED" }), 2000),
			),
		]);
		expect(result).toEqual({ code: "MODEL_TIMEOUT" });
		expect(existsSync(pidFile)).toBe(true);
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8"));
			// A killed child can briefly remain as a zombie; it must no longer be running.
			const status = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
				.stdout.toString()
				.trim();
			expect(status === "" || status.startsWith("Z")).toBe(true);
		}
	} finally {
		timing.mockRestore();
		if (existsSync(pidFile)) {
			try {
				process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
			} catch {}
		}
		await running;
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	{ code: "MODEL_EXECUTION_FAILED", program: "process.exit(2)" },
	{ code: "MODEL_OUTPUT_INVALID", program: 'console.log("invalid JSON")' },
	{
		code: "MODEL_OUTPUT_INVALID",
		program: "console.log(JSON.stringify(null))",
	},
	{
		code: "MODEL_OUTPUT_INVALID",
		program: "console.log(JSON.stringify({raw:42}))",
	},
	{ code: "MODEL_OUTPUT_TOO_LARGE", program: 'console.log("x".repeat(70000))' },
])(
	"external model failures keep stable failed codes ($code)",
	async ({ code, program }) => {
		const dir = mkdtempSync(join(tmpdir(), "em-model-error-"));
		try {
			const profile: Profile = {
				version: 1,
				socketPath: join(dir, "m.sock"),
				credential: "unused",
				modelCommand: [process.execPath, "-e", program],
				modelDailyCalls: 1,
			};
			await expect(
				commandComplete(profile)("{}", {}, "recall"),
			).rejects.toMatchObject({ code, status: "failed" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
