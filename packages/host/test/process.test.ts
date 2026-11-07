import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
			"memory_source",
			"memory_status",
		]);
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
