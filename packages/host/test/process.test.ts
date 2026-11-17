import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { HostResult } from "../src/contracts.ts";

const cli =
	process.env["MEMORY_HOST_CLI"] ??
	new URL("../src/cli.ts", import.meta.url).pathname;
async function command(args: string[], input?: unknown) {
	const child = Bun.spawn([process.execPath, cli, ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (input !== undefined) {
		child.stdin.write(JSON.stringify(input));
	}
	child.stdin.end();
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { result: JSON.parse(stdout || stderr) as HostResult, code };
}
async function connect(profile: string) {
	const client = new Client({ name: "host-integration-test", version: "1" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [cli, "--profile", profile, "mcp"],
		stderr: "pipe",
	});
	await client.connect(transport);
	return client;
}
async function tool(
	client: Client,
	method: string,
	args: Record<string, unknown> = {},
): Promise<HostResult> {
	const result = await client.callTool({
		name: `memory_${method}`,
		arguments: args,
	});
	return result.structuredContent as HostResult;
}
test("CLI and two independent MCP processes share one owner; closing one connection preserves others", async () => {
	const dir = mkdtempSync(join(tmpdir(), "emp-"));
	let owner: ReturnType<typeof Bun.spawn> | undefined;
	const clients: Client[] = [];
	try {
		expect((await command(["init", dir])).code).toBe(0);
		owner = Bun.spawn([process.execPath, cli, "serve", dir], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const reader = (owner.stderr as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(new TextDecoder().decode(first.value)).toContain('"ready"');
		reader.releaseLock();
		const profile = join(dir, "profile.json");
		const a = await connect(profile);
		clients.push(a);
		expect(a.getServerVersion()).toEqual({
			name: "eumenes-memory",
			version: "0.1.0",
		});
		const b = await connect(profile);
		clients.push(b);
		expect((await a.listTools()).tools.map((x) => x.name).sort()).toEqual([
			"memory_apply",
			"memory_context",
			"memory_operation",
			"memory_plan",
			"memory_read",
			// S9 で memory_search を足した（T-MCP-1）。
			"memory_search",
			"memory_source",
			"memory_status",
			// S6b（決定 11）で memory_use を足した。
			"memory_use",
		]);
		const search = (await a.listTools()).tools.find(
			(x) => x.name === "memory_search",
		)!;
		expect(search.annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
			destructiveHint: false,
		});
		const text = "一週間に二回、陶芸を楽しみます";
		const source = (
			await command(["--profile", profile, "source", "--input", "-"], {
				submissionId: "process-source",
				scopeKey: "personal",
				content: text,
			})
		).result;
		expect(source.status).toBe("registered");
		const context = await tool(a, "context");
		const proposal = {
			decision: {
				clarification: null,
				actions: [
					{
						type: "remember",
						subject: "self",
						kind: "habit",
						semanticKey: "pottery",
						value: { text, polarity: "affirmed" },
						quote: text,
						replacesItemId: null,
					},
				],
			},
			relations: [{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
			groups: [[0]],
		};
		const plan = await tool(a, "plan", {
			snapshotId: context["snapshotId"],
			scopeKey: "personal",
			proposal,
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: source["sourceHandle"],
					startByte: 0,
					endByte: Buffer.byteLength(text),
				},
			],
		});
		expect(plan.status).toBe("planned");
		const request = {
			planId: plan["planId"],
			epoch: plan["epoch"],
			operationId: "shared-operation",
		};
		const [one, two] = await Promise.all([
			tool(a, "apply", request),
			tool(b, "apply", request),
		]);
		expect(one.status).toBe("completed");
		expect(two).toEqual(one);
		const fromB = await tool(b, "context");
		expect(fromB["items"] as unknown[]).toHaveLength(1);
		const measured = await command(
			["--profile", profile, "recall-size", "--input", "-"],
			{
				scopeKey: "personal",
				message: "陶芸の頻度は？",
			},
		);
		expect(measured.code).toBe(0);
		expect(measured.result).toMatchObject({
			status: "found",
			measurement: { itemCount: 1, fitsModelInput: true },
		});
		const oversized = await command(
			["--profile", profile, "recall-size", "--input", "-"],
			{
				scopeKey: "personal",
				message: "長い質問".repeat(15000),
			},
		);
		expect(oversized.code).toBe(0);
		expect(oversized.result).toMatchObject({
			status: "found",
			measurement: { itemCount: 1, fitsModelInput: false },
		});
		expect(
			await command(["--profile", profile, "recall-size", "--input", "-"], {
				scopeKey: "not-granted",
				message: "何を覚えている？",
			}),
		).toMatchObject({ code: 4, result: { status: "blocked" } });
		const old = (fromB["items"] as { itemId: string }[])[0]!;
		const updatedText = "一週間に三回、陶芸を楽しみます";
		const updateSource = await tool(b, "source", {
			submissionId: "correction",
			scopeKey: "personal",
			content: updatedText,
		});
		const correction = structuredClone(proposal);
		correction.decision.actions[0]!.value.text = updatedText;
		correction.decision.actions[0]!.quote = updatedText;
		const correctionProposal = {
			...correction,
			decision: {
				...correction.decision,
				actions: [
					{ ...correction.decision.actions[0]!, replacesItemId: old.itemId },
				],
			},
			relations: [
				{
					actionIndex: 0,
					relation: "supersedes",
					relatedItemIds: [old.itemId],
				},
			],
		};
		const update = await tool(b, "plan", {
			snapshotId: fromB["snapshotId"],
			scopeKey: "personal",
			proposal: correctionProposal,
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: updateSource["sourceHandle"],
					startByte: 0,
					endByte: Buffer.byteLength(updatedText),
				},
			],
		});
		expect(update.status).toBe("planned");
		expect(
			(
				await tool(b, "apply", {
					planId: update["planId"],
					epoch: update["epoch"],
					operationId: "shared-correction",
				})
			).status,
		).toBe("completed");
		// T-CLI-1: search の終了コード（found は 0、blocked は 4）。MCP からも同じ結果を読む。
		const found = await command(
			["--profile", profile, "search", "--input", "-"],
			{ query: "三回" },
		);
		expect(found.code).toBe(0);
		expect(found.result).toMatchObject({
			status: "found",
			returned: 1,
			moreAvailable: false,
			truncatedBy: null,
			query: { indexedTerms: [], scannedTerms: ["三回"], mode: "scan" },
		});
		expect(
			await command(["--profile", profile, "search", "--input", "-"], {
				query: "陶芸",
				limit: 21,
			}),
		).toMatchObject({ code: 4, result: { code: "INVALID_INPUT" } });
		const viaMcp = await tool(b, "search", { query: "陶芸を楽しみ" });
		expect(viaMcp).toMatchObject({ status: "found", returned: 1 });
		expect(
			(viaMcp["items"] as { value: { text: string } }[])[0]!.value.text,
		).toBe(updatedText);
		// S10: review は CLI だけ（MCP の道具一覧には無い）。
		expect(await command(["--profile", profile, "review"])).toMatchObject({
			code: 0,
			result: { status: "found", items: [] },
		});
		const corrected = await tool(a, "context");
		expect(
			(corrected["items"] as { value: { text: string } }[])[0]!.value.text,
		).toBe(updatedText);
		const current = (corrected["items"] as { itemId: string }[])[0]!;
		const forget = await tool(a, "plan", {
			snapshotId: corrected["snapshotId"],
			scopeKey: "personal",
			proposal: {
				decision: {
					clarification: null,
					actions: [{ type: "forget", itemId: current.itemId }],
				},
				relations: [
					{
						actionIndex: 0,
						relation: "forget",
						relatedItemIds: [current.itemId],
					},
				],
				groups: [[0]],
			},
			sourceHandles: [source["sourceHandle"], updateSource["sourceHandle"]],
		});
		expect(forget.status).toBe("planned");
		expect(
			(
				await tool(a, "apply", {
					planId: forget["planId"],
					epoch: forget["epoch"],
					operationId: "shared-forget",
				})
			).status,
		).toBe("completed");
		expect((await tool(b, "context"))["items"]).toEqual([]);
		expect(await tool(b, "search", { query: "陶芸" })).toMatchObject({
			status: "found",
			items: [],
		});

		await a.close();
		clients.splice(clients.indexOf(a), 1);
		expect((await tool(b, "status")).status).toBe("ready");
		expect(
			(
				await command(["--profile", profile, "operation", "--input", "-"], {
					operationId: "shared-operation",
					epoch: plan["epoch"],
				})
			).result.status,
		).toBe("completed");
		// Competing owner must fail without taking the socket from the first process.
		const competitor = await command(["serve", dir]);
		expect(competitor.code).not.toBe(0);
		expect((await tool(b, "status")).status).toBe("ready");
		owner.kill("SIGTERM");
		await owner.exited;
		expect((await tool(b, "status")).status).toBe("failed");
		owner = Bun.spawn([process.execPath, cli, "serve", dir], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const restarted = (owner.stderr as ReadableStream<Uint8Array>).getReader();
		await restarted.read();
		restarted.releaseLock();
		expect((await tool(b, "context"))["items"]).toEqual([]);
		expect((await tool(b, "apply", request)).status).toBe("completed");
		const unknown = await tool(b, "apply", {
			planId: plan["planId"],
			epoch: plan["epoch"],
			operationId: "unknown-old-operation",
		});
		expect(unknown.status).toBe("indeterminate");
	} finally {
		for (const client of clients) await client.close();
		if (owner) {
			owner.kill("SIGTERM");
			await owner.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 20000);

/** S12（T-INT）: Grok Bot のように MCP で保存と検索をし、別のプロセスの CLI で読み、訂正、忘却、再起動、バックアップと復元まで通す。 */
async function serve(dir: string) {
	const owner = Bun.spawn([process.execPath, cli, "serve", dir], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const reader = (owner.stderr as ReadableStream<Uint8Array>).getReader();
	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toContain('"ready"');
	reader.releaseLock();
	return owner;
}
async function rememberVia(
	client: Client,
	text: string,
	semanticKey: string,
	options: { provenance?: string; replaces?: string } = {},
) {
	const source = await tool(client, "source", {
		submissionId: crypto.randomUUID(),
		scopeKey: "personal",
		content: text,
		provenance: options.provenance ?? "user_message",
	});
	expect(source.status).toBe("registered");
	const context = await tool(client, "context");
	const planned = await tool(client, "plan", {
		snapshotId: context["snapshotId"],
		scopeKey: "personal",
		proposal: {
			decision: {
				clarification: null,
				actions: [
					{
						type: "remember",
						subject: "self",
						kind: "preference",
						semanticKey,
						value: { text, polarity: "affirmed" },
						quote: text,
						replacesItemId: options.replaces ?? null,
					},
				],
			},
			relations: [
				{
					actionIndex: 0,
					relation: options.replaces ? "supersedes" : "new",
					relatedItemIds: options.replaces ? [options.replaces] : [],
				},
			],
			groups: [[0]],
		},
		evidence: [
			{
				actionIndex: 0,
				sourceHandle: source["sourceHandle"],
				startByte: 0,
				endByte: Buffer.byteLength(text),
			},
		],
	});
	expect(planned.status).toBe("planned");
	const applied = await tool(client, "apply", {
		planId: planned["planId"],
		epoch: planned["epoch"],
		operationId: crypto.randomUUID(),
	});
	expect(applied.status).toBe("completed");
	return source["sourceHandle"] as string;
}
type Found = {
	itemId: string;
	revision: number;
	value: { text: string };
	trust: string;
	evidenceStatus: string;
};
const texts = (result: HostResult) =>
	(result["items"] as Found[]).map((x) => x.value.text);

test("T-INT Grok Bot style usage: save, search from another process, correct, forget, restart, backup and restore", async () => {
	const dir = mkdtempSync(join(tmpdir(), "emi-"));
	const recoveryDirectory = mkdtempSync(join(tmpdir(), "emi-guard-"));
	let owner: ReturnType<typeof Bun.spawn> | undefined;
	const clients: Client[] = [];
	try {
		expect(
			(await command(["init", dir, "--backups", join(dir, "backups")])).code,
		).toBe(0);
		expect(
			(await command(["protect-journal", dir, recoveryDirectory])).code,
		).toBe(0);
		owner = await serve(dir);
		const profile = join(dir, "profile.json");
		const bot = await connect(profile);
		clients.push(bot);
		const drink = "朝は抹茶ラテを飲むのが好き";
		const drinkHandle = await rememberVia(bot, drink, "morning-drink");
		await rememberVia(bot, "夜は抹茶ラテよりほうじ茶が好き", "evening-drink");
		await rememberVia(
			bot,
			"ウェブの記事では抹茶ラテは午後が良いとあった",
			"web-tip",
			{ provenance: "web" },
		);
		// 別のプロセス（CLI）から検索する。上限と moreAvailable と trust が働く。
		const capped = await command(
			["--profile", profile, "search", "--input", "-"],
			{ query: "抹茶ラテ", limit: 2 },
		);
		expect(capped.code).toBe(0);
		expect(capped.result).toMatchObject({
			status: "found",
			returned: 2,
			moreAvailable: true,
			truncatedBy: "count",
		});
		expect(capped.result).not.toHaveProperty("nextCursor");
		const all = await tool(bot, "search", { query: "抹茶ラテ" });
		expect(all).toMatchObject({ returned: 3, moreAvailable: false });
		const byText = new Map(
			(all["items"] as Found[]).map((x) => [x.value.text, x]),
		);
		expect(byText.get(drink)?.evidenceStatus).toBe("current");
		expect(
			byText.get("ウェブの記事では抹茶ラテは午後が良いとあった")?.trust,
		).toBe("external");
		// 回答に採用したものだけを報告する。
		const adopted = byText.get(drink)!;
		expect(
			await tool(bot, "use", {
				snapshotId: all["snapshotId"],
				items: [{ itemId: adopted.itemId, revision: adopted.revision }],
			}),
		).toMatchObject({ status: "completed" });
		// バックアップ（管理用の CLI）。この時点の店には「抹茶ラテ」の記憶が 3 件ある。
		const backup = await command(["--profile", profile, "backup"]);
		expect(backup.code).toBe(0);
		const backupPath = backup.result["path"] as string;
		// 訂正すると、古い本文では見つからず、新しい本文で見つかる。
		const correctedText = "朝は抹茶ラテではなくカフェラテを飲むのが好き";
		const correctedHandle = await rememberVia(
			bot,
			correctedText,
			"morning-drink",
			{ replaces: adopted.itemId },
		);
		const other = await connect(profile);
		clients.push(other);
		expect(texts(await tool(other, "search", { query: "カフェラテ" }))).toEqual(
			[correctedText],
		);
		expect(
			texts(await tool(other, "search", { query: "朝は抹茶ラテを飲む" })),
		).toEqual([]);
		// 忘却（原文も消す）の後は、検索で見つからない。
		const found = await tool(other, "search", { query: "カフェラテ" });
		const target = (found["items"] as Found[])[0]!;
		const context = await tool(other, "context");
		const forgetPlan = await tool(other, "plan", {
			snapshotId: context["snapshotId"],
			scopeKey: "personal",
			proposal: {
				decision: {
					clarification: null,
					actions: [{ type: "forget", itemId: target.itemId }],
				},
				relations: [
					{
						actionIndex: 0,
						relation: "forget",
						relatedItemIds: [target.itemId],
					},
				],
				groups: [[0]],
			},
			sourceHandles: [drinkHandle, correctedHandle],
		});
		expect(forgetPlan.status).toBe("planned");
		expect(
			(
				await tool(other, "apply", {
					planId: forgetPlan["planId"],
					epoch: forgetPlan["epoch"],
					operationId: crypto.randomUUID(),
				})
			).status,
		).toBe("completed");
		expect(texts(await tool(other, "search", { query: "朝は" }))).toEqual([]);
		// 再起動しても、忘れたものは出ない。
		owner.kill("SIGTERM");
		await owner.exited;
		owner = await serve(dir);
		expect(texts(await tool(bot, "search", { query: "朝は" }))).toEqual([]);
		expect((await tool(bot, "search", { query: "抹茶ラテ" }))["returned"]).toBe(
			2,
		);
		// 忘却の前のバックアップから復元しても、ジャーナルの再適用で忘れたものは戻らない。
		owner.kill("SIGTERM");
		await owner.exited;
		owner = undefined;
		const journal = join(dir, "forget.jsonl");
		const protectedJournal = join(dir, "protected-forget.jsonl");
		const beforeRestore = readFileSync(join(dir, "memory.db"));
		renameSync(journal, protectedJournal);
		expect(await command(["restore", backupPath, dir])).toMatchObject({
			code: 4,
			result: { status: "blocked", code: "JOURNAL_MISSING" },
		});
		expect(readFileSync(join(dir, "memory.db"))).toEqual(beforeRestore);
		renameSync(protectedJournal, journal);
		const restored = await command(["restore", backupPath, dir]);
		expect(restored.code).toBe(0);
		owner = await serve(dir);
		expect(texts(await tool(bot, "search", { query: "朝は" }))).toEqual([]);
		expect(
			texts(await tool(bot, "search", { query: "抹茶ラテ" })).sort(),
		).toEqual(
			[
				"ウェブの記事では抹茶ラテは午後が良いとあった",
				"夜は抹茶ラテよりほうじ茶が好き",
			].sort(),
		);
		expect(
			await command(["--profile", profile, "search", "--input", "-"], {
				query: "会",
			}),
		).toMatchObject({ code: 0, result: { status: "found", items: [] } });
		owner.kill("SIGTERM");
		await owner.exited;
		owner = undefined;
		rmSync(join(dir, "memory.db"));
		expect(await command(["restore", backupPath, dir])).toMatchObject({
			code: 0,
			result: { status: "completed" },
		});
		owner = await serve(dir);
		expect(texts(await tool(bot, "search", { query: "朝は" }))).toEqual([]);
		expect((await tool(bot, "search", { query: "抹茶ラテ" }))["returned"]).toBe(
			2,
		);
	} finally {
		for (const client of clients) await client.close();
		if (owner) {
			owner.kill("SIGTERM");
			await owner.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
