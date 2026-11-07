/** Explicit opt-in cross-repository test against the actual application source and SQLite owner. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MemoryHost } from "../src/service.ts";
import { serveHost, request } from "../src/transport.ts";
import type { HostConfig } from "../src/contracts.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { StateItem } from "eumenes-memory";

const application = process.env["EUMENES_CHECKOUT"];
test.skipIf(!application)(
	"R14 actual Eumenes writer, application sources, MCP and shared journal restore",
	async () => {
		const root = resolve(application!);
		const { setupMemory, saveItem, memoryTestMigrations } = await import(
			join(root, "api/domains/memory/test/memory.fixture.ts")
		);
		const { PRINCIPAL, PROFILE_SCOPE } = await import(
			join(root, "api/domains/memory/contracts/index.ts")
		);
		const { openStore } = await import(
			join(root, "api/infrastructure/sqlite/index.ts")
		);
		const { createConversationService } = await import(
			join(root, "api/domains/conversation/index.ts")
		);
		const { createContinuityFixture } = await import(
			join(root, "api/application/world/state-services.fixture.ts")
		);
		const { createMemoryService } = await import(
			join(root, "api/domains/memory/index.ts")
		);
		const h = await setupMemory();
		const dir = mkdtempSync(join(tmpdir(), "ema-"));
		let transport: Awaited<ReturnType<typeof serveHost>> | undefined;
		let client: Client | undefined;
		try {
			const config: HostConfig = {
				version: 1,
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				socketPath: join(dir, "a.sock"),
				credentials: {
					test: {
						clientId: "test",
						scopeKeys: [PROFILE_SCOPE],
						read: true,
						write: true,
						forgetAll: true,
						confirmedWrites: true,
					},
				},
			};
			const host = new MemoryHost({
				port: h.memory.sharedHost,
				configuration: () => config,
				resolveSource: h.memory.sharedHost.resolveSource,
			});
			await host.start();
			h.memory.registerForgetPurge(
				(
					db: Parameters<typeof host.invalidateDerivedInTransaction>[0],
					purge: { itemIds: string[]; forgetIds?: string[] },
				) =>
					host.invalidateDerivedInTransaction(db, {
						scopeKeys: [PROFILE_SCOPE],
						itemIds: purge.itemIds,
						forgetIds: purge.forgetIds ?? [],
					}),
			);
			// Direct in-process transport exercises application ownership without starting the application server.
			transport = await serveHost(host, config.socketPath);
			const profile = {
				version: 1 as const,
				socketPath: config.socketPath,
				credential: "test",
			};
			const profilePath = join(dir, "profile.json");
			await Bun.write(profilePath, JSON.stringify(profile));
			client = new Client({ name: "eumenes-acceptance", version: "1" });
			await client.connect(
				new StdioClientTransport({
					command: process.execPath,
					args: [
						new URL("../src/cli.ts", import.meta.url).pathname,
						"--profile",
						profilePath,
						"mcp",
					],
				}),
			);
			const messageId = await h.say("user", "休日には折り紙を楽しみます");
			const appItem = await saveItem(h.store, h.memory, {
				conversationId: "c1",
				messageId,
				kind: "habit",
				semanticKey: "origami",
				text: "休日には折り紙を楽しむ",
				quote: "休日には折り紙を楽しみます",
			});
			const context = (
				await client.callTool({ name: "memory_context", arguments: {} })
			).structuredContent as { snapshotId: string; items: StateItem[] };
			expect(context.items.some((x) => x.itemId === appItem.id)).toBe(true);
			const read = (
				await client.callTool({
					name: "memory_read",
					arguments: { snapshotId: context.snapshotId, itemId: appItem.id },
				})
			).structuredContent as { sources: { source: { content: string } }[] };
			expect(read.sources[0]!.source.content).toBe(
				"休日には折り紙を楽しみます",
			);
			const text = "甘い飲み物を好みます";
			const source = await request(profile, "source", {
				submissionId: "mcp-source",
				scopeKey: PROFILE_SCOPE,
				content: text,
			});
			const plan = await request(profile, "plan", {
				snapshotId: context.snapshotId,
				scopeKey: PROFILE_SCOPE,
				proposal: {
					decision: {
						clarification: null,
						actions: [
							{
								type: "remember",
								subject: "self",
								kind: "preference",
								semanticKey: "sweet-drink",
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
						sourceHandle: source["sourceHandle"],
						startByte: 0,
						endByte: Buffer.byteLength(text),
					},
				],
			});
			expect(plan.status).toBe("planned");
			const firstApply = await request(profile, "apply", {
				planId: plan["planId"],
				epoch: host.epoch,
				operationId: "host-to-app",
			});
			expect(firstApply.status).toBe("completed");
			const hostItem = h.memory
				.list()
				.find((x: { semanticKey: string }) => x.semanticKey === "sweet-drink");
			expect(hostItem).toBeDefined();
			expect(hostItem.origin).toBe("agent_inferred");
			const forgetView = await request(profile, "context", {});
			const fence = h.store.read((db: import("bun:sqlite").Database) =>
				h.memory.forgetSeqInTransaction(db),
			);
			const forgetPlan = await request(profile, "plan", {
				snapshotId: forgetView["snapshotId"],
				scopeKey: PROFILE_SCOPE,
				proposal: {
					decision: {
						clarification: null,
						actions: [{ type: "forget", itemId: hostItem.id }],
					},
					relations: [
						{
							actionIndex: 0,
							relation: "forget",
							relatedItemIds: [hostItem.id],
						},
					],
					groups: [[0]],
				},
			});
			expect(
				(
					await request(profile, "apply", {
						planId: forgetPlan["planId"],
						epoch: host.epoch,
						operationId: "host-forget-app",
					})
				).status,
			).toBe("completed");
			expect(
				h.memory.list().some((x: { id: string }) => x.id === hostItem.id),
			).toBe(false);
			expect(
				h.store.read((db: import("bun:sqlite").Database) =>
					h.memory.forgetSeqInTransaction(db),
				),
			).toBeGreaterThan(fence);
			expect(h.memory.blockedMessageIds([messageId]).has(messageId)).toBe(
				false,
			);
			const concurrentView = await request(profile, "context", {});
			const concurrentSource = await request(profile, "source", {
				submissionId: "second-host-source",
				scopeKey: PROFILE_SCOPE,
				content: text,
			});
			const concurrentPlan = await request(profile, "plan", {
				snapshotId: concurrentView["snapshotId"],
				scopeKey: PROFILE_SCOPE,
				proposal: {
					decision: {
						clarification: null,
						actions: [
							{
								type: "remember",
								subject: "self",
								kind: "preference",
								semanticKey: "sweet-drink-second",
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
						sourceHandle: concurrentSource["sourceHandle"],
						startByte: 0,
						endByte: Buffer.byteLength(text),
					},
				],
			});
			expect(concurrentPlan.status).toBe("planned");

			const concurrentMessage = await h.say("user", "朝は散歩をします");
			const [applied] = await Promise.all([
				request(profile, "apply", {
					planId: concurrentPlan["planId"],
					epoch: host.epoch,
					operationId: "app-concurrent",
				}),
				saveItem(h.store, h.memory, {
					conversationId: "c1",
					messageId: concurrentMessage,
					kind: "habit",
					semanticKey: "walking",
					text: "朝は散歩をする",
					explicit: false,
				}),
			]);
			// The application may win first; both serialized orders are valid and must not overwrite each other.
			expect(["completed", "stale"]).toContain(applied.status);
			if (applied.status === "stale")
				expect(applied.code).toBe("SNAPSHOT_STALE");
			// Take a consistent old DB; the application journal stays current after its own forget.
			const { Database } = await import("bun:sqlite");
			const backupReader = new Database(join(h.dir, "db.sqlite3"), {
				readonly: true,
			});
			try {
				backupReader.exec(`VACUUM INTO '${join(dir, "backup.db")}'`);
			} finally {
				backupReader.close();
			}
			const forgotten = await h.memory.forget({
				conversationId: "c1",
				itemIds: [appItem.id],
				messageIds: [messageId],
			});
			expect(forgotten.completed).toBe(true);
			expect(h.memory.blockedMessageIds([messageId]).has(messageId)).toBe(true);
			const after = (
				await client.callTool({ name: "memory_context", arguments: {} })
			).structuredContent as { items: StateItem[] };
			expect(after.items.some((x) => x.itemId === appItem.id)).toBe(false);
			const restoredPath = join(dir, "restored.db");
			copyFileSync(join(dir, "backup.db"), restoredPath);
			const journal = join(dir, "restored.jsonl");
			await Bun.write(journal, readFileSync(join(h.dir, "journal.jsonl")));
			const restoredStore = openStore(restoredPath, memoryTestMigrations);
			try {
				const conversation = createConversationService(restoredStore);
				const continuity = createContinuityFixture(
					restoredStore,
					() => h.time.now,
				);
				const memory = createMemoryService(
					restoredStore,
					conversation,
					continuity,
					{ journalPath: journal, clock: () => h.time.now },
				);
				expect((await memory.recover()).healthy).toBe(true);
				const restoredHost = new MemoryHost({
					port: memory.sharedHost,
					configuration: () => config,
				});
				await restoredHost.start();
				expect(
					memory.list(true).some((x: { id: string }) => x.id === appItem.id),
				).toBe(false);
				expect(memory.blockedMessageIds([messageId]).has(messageId)).toBe(true);
				const restoredContext = await restoredHost.dispatch(
					"test",
					"context",
					{},
				);
				expect(
					(restoredContext["items"] as StateItem[]).some(
						(x) => x.itemId === appItem.id,
					),
				).toBe(false);
			} finally {
				await restoredStore.close();
			}
		} finally {
			await client?.close();
			await transport?.close();
			await h.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	30000,
);

function regressionConfig(
	principal: string,
	scope: string,
	socketPath: string,
): HostConfig {
	return {
		version: 1,
		principal,
		scopeKeys: [scope],
		socketPath,
		credentials: {
			test: {
				clientId: "test",
				scopeKeys: [scope],
				read: true,
				write: true,
				forgetAll: true,
				confirmedWrites: true,
			},
		},
	};
}

test.skipIf(!application)(
	"F5 actual Eumenes rejects a corrected conversation source before snapshot and preserves imported seed evidence",
	async () => {
		const { setupMemory, saveItem } = await import(
			join(resolve(application!), "api/domains/memory/test/memory.fixture.ts")
		);
		const { PRINCIPAL, PROFILE_SCOPE } = await import(
			join(resolve(application!), "api/domains/memory/contracts/index.ts")
		);
		const { natural } = await import("../src/natural.ts");
		const h = await setupMemory();
		const dir = mkdtempSync(join(tmpdir(), "em-app-evidence-"));
		let transport: Awaited<ReturnType<typeof serveHost>> | undefined;
		try {
			const id = await h.say("user", "紅茶が好きです");
			const item = await saveItem(h.store, h.memory, {
				conversationId: "c1",
				messageId: id,
				kind: "preference",
				semanticKey: "drink",
				text: "紅茶が好き",
				quote: "紅茶が好きです",
			});
			expect(
				(
					await h.conversation.correct({
						messageId: id,
						text: "その発言を取り消します。珈琲が好きです",
					})
				).status,
			).toBe("applied");
			const quote = "旅行の相談では徒歩の移動を好みます";
			await h.memory.importSeeds({
				seeds: [
					{
						schema_version: 1,
						id: "host-regression-seed",
						status: "candidate",
						category: "移動",
						subject: "self",
						semantic_key: "travel.host-regression",
						memory: quote,
						scope: "旅行の相談",
						evidence_basis: "inferred",
						confidence: "medium",
						proposed_target: "state",
						proposed_state_kind: "preference",
						proposed_state_origin: "agent_inferred",
						use_when: "旅程を考えるとき",
						limitations: "現在の希望を優先する",
						review: { after_days: 30, on: "本人の訂正時" },
						evidence: [
							{
								evidence_id: "seed-evidence",
								thread_id: "external-thread",
								message_id: "external-message",
								timestamp: "2026-10-01T00:00:00Z",
								speaker: "user",
								source_path: "/not-read/external.jsonl",
								source_line: 1,
								source_text_sha256: "a".repeat(64),
								range_utf8: { start: 0, end: Buffer.byteLength(quote) },
								quote,
							},
						],
					},
				],
			});
			const config = regressionConfig(
				PRINCIPAL,
				PROFILE_SCOPE,
				join(dir, "a.sock"),
			);
			const host = new MemoryHost({
				port: h.memory.sharedHost,
				configuration: () => config,
				resolveSource: h.memory.sharedHost.resolveSource,
			});
			await host.start();
			transport = await serveHost(host, config.socketPath);
			const context = await host.dispatch("test", "context", {});
			const items = context[
				"items"
			] as import("../src/meaning/model-input.ts").HostItem[];
			expect(items.find((x) => x.itemId === item.id)?.evidenceStatus).toBe(
				"stale",
			);
			expect(
				items.find((x) => x.semanticKey === "travel.host-regression")
					?.evidenceStatus,
			).toBe("current");
			const result = await natural(
				{ version: 1, socketPath: config.socketPath, credential: "test" },
				"recall",
				{ scopeKey: PROFILE_SCOPE, message: "私の飲み物の好みは？" },
				async (prompt) => {
					expect(
						(
							JSON.parse(prompt)
								.items as import("../src/meaning/model-input.ts").ModelItem[]
						).find((x) => x.itemId === item.id)?.evidenceStatus,
					).toBe("stale");
					return {
						raw: JSON.stringify({
							parts: [
								{
									request: "飲み物の好み",
									status: "supported",
									evidenceIds: [item.id],
								},
							],
						}),
						usage: null,
						threadId: null,
					};
				},
			);
			expect(result).toMatchObject({
				status: "blocked",
				code: "EVIDENCE_UNAVAILABLE",
			});
			expect(result["parts"]).toBeUndefined();
		} finally {
			await transport?.close();
			await h.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test.skipIf(!application)(
	"F1 actual Eumenes closes application health when owner commit rolls back after durable journal",
	async () => {
		const { setupMemory, saveItem } = await import(
			join(resolve(application!), "api/domains/memory/test/memory.fixture.ts")
		);
		const { PRINCIPAL, PROFILE_SCOPE } = await import(
			join(resolve(application!), "api/domains/memory/contracts/index.ts")
		);
		const h = await setupMemory();
		try {
			let inject = false;
			const original = h.memory.sharedHost;
			const port: import("../src/storage.ts").AppPort = {
				...original,
				write: (fn) =>
					original.write((db: import("eumenes-memory/sqlite").MemoryDb) => {
						const count = original.journal.read().length;
						const result = fn(db);
						if (inject && original.journal.read().length > count) {
							inject = false;
							throw Error("owner commit rollback");
						}
						return result;
					}),
			};
			const messageId = await h.say("user", "休日に折り紙を楽しみます");
			const item = await saveItem(h.store, h.memory, {
				conversationId: "c1",
				messageId,
				kind: "habit",
				semanticKey: "origami",
				text: "休日に折り紙を楽しむ",
			});
			const config = regressionConfig(PRINCIPAL, PROFILE_SCOPE, "unused");
			const host = new MemoryHost({
				port,
				configuration: () => config,
				resolveSource: original.resolveSource,
			});
			await host.start();
			const context = await host.dispatch("test", "context", {});
			const plan = await host.dispatch("test", "plan", {
				snapshotId: context["snapshotId"],
				scopeKey: PROFILE_SCOPE,
				proposal: {
					decision: {
						clarification: null,
						actions: [{ type: "forget", itemId: item.id }],
					},
					relations: [
						{ actionIndex: 0, relation: "forget", relatedItemIds: [item.id] },
					],
					groups: [[0]],
				},
			});
			expect(plan.status).toBe("planned");
			inject = true;
			expect(
				(
					await host.dispatch("test", "apply", {
						planId: plan["planId"],
						epoch: host.epoch,
						operationId: "app-rollback",
					})
				).status,
			).not.toBe("completed");
			expect(h.memory.status().healthy).toBe(false);
			expect(await host.dispatch("test", "context", {})).toMatchObject({
				status: "blocked",
				code: "HOST_NOT_READY",
			});
			expect((await h.memory.recover()).healthy).toBe(true);
			await host.start();
			const recovered = await host.dispatch("test", "context", {});
			expect(recovered.status).toBe("context");
			expect(
				(recovered["items"] as StateItem[]).some((x) => x.itemId === item.id),
			).toBe(false);
		} finally {
			await h.close();
		}
	},
);
