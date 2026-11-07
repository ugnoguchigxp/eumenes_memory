import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { initialize, openStandalone } from "../src/storage.ts";
import { MemoryHost } from "../src/service.ts";
import { serveHost, request } from "../src/transport.ts";
import type { HostConfig, HostResult } from "../src/contracts.ts";

test("MCP cancellation does not undo an accepted mutation; its operation ID resolves the actual result", async () => {
	const dir = mkdtempSync(join(tmpdir(), "em-cancel-"));
	const profile = initialize(dir);
	const owner = openStandalone(dir);
	let release!: () => void;
	let entered!: () => void;
	let paused = false;
	const gate = new Promise<void>((r) => (release = r));
	const began = new Promise<void>((r) => (entered = r));
	const host = new MemoryHost({
		configuration: () =>
			JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as HostConfig,
		port: {
			...owner.port,
			write: async (fn) => {
				if (paused) {
					entered();
					await gate;
				}
				return owner.port.write(fn);
			},
		},
	});
	await host.start();
	const server = await serveHost(host, profile.socketPath);
	const client = new Client({ name: "cancellation", version: "1" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [
					new URL("../src/cli.ts", import.meta.url).pathname,
					"--profile",
					join(dir, "profile.json"),
					"mcp",
				],
			}),
		);
		await expect(
			client.callTool({ name: "nonexistent_tool", arguments: {} }),
		).rejects.toBeDefined();
		const text = "試験用の好み";
		const s = await request(profile, "source", {
			submissionId: "cancel",
			scopeKey: "personal",
			content: text,
		});
		const c = await request(profile, "context", {});
		const p = await request(profile, "plan", {
			snapshotId: c["snapshotId"],
			scopeKey: "personal",
			proposal: {
				decision: {
					clarification: null,
					actions: [
						{
							type: "remember",
							subject: "self",
							kind: "preference",
							semanticKey: "cancel",
							value: { text, polarity: "affirmed" },
							quote: text,
							replacesItemId: null,
						},
					],
				},
				relations: [{ actionIndex: 0, relation: "new", relatedItemIds: [] }],
				groups: [[0]],
			},
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: s["sourceHandle"],
					startByte: 0,
					endByte: Buffer.byteLength(text),
				},
			],
		});
		expect(p.status).toBe("planned");
		const args = {
			planId: p["planId"],
			epoch: p["epoch"],
			operationId: "cancelled-response",
		};
		paused = true;
		const controller = new AbortController();
		const pending = client.callTool(
			{ name: "memory_apply", arguments: args },
			{ signal: controller.signal },
		);
		const outcome = pending.then(
			() => false,
			() => true,
		);
		await Promise.race([
			began,
			pending.then(
				(value) => {
					throw Error(
						"MCP completed before owner writer: " + JSON.stringify(value),
					);
				},
				(error) => {
					throw error;
				},
			),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(Error("MCP did not reach the owner writer")),
					3000,
				),
			),
		]);
		controller.abort();
		expect(await outcome).toBe(true);
		paused = false;
		release();
		let result: HostResult = { status: "pending" };
		for (let i = 0; i < 100; i++) {
			result = await request(profile, "operation", {
				operationId: args.operationId,
				epoch: args.epoch,
			});
			if (result.status === "completed") break;
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(result.status).toBe("completed");
		expect(await request(profile, "apply", args)).toEqual(result);
		expect((await request(profile, "context", {}))["items"]).toHaveLength(1);
		expect(
			(await client.callTool({ name: "memory_status", arguments: {} })).isError,
		).not.toBe(true);
	} finally {
		release();
		await client.close();
		await server.close();
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 10000);
