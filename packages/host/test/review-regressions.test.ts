import { afterEach, expect, test, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	readdirSync,
	symlinkSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
	AssertUserStateInput,
	HostSourceState,
	StateItem,
} from "eumenes-memory";
import {
	assertUserState,
	getForgetReceipt,
	readStateFact,
	registerExternalDependents,
	unregisterExternalDependents,
	recordExternalDeletion,
} from "eumenes-memory/sqlite";
import { HOST_LIMITS, type HostConfig } from "../src/contracts.ts";
import { MemoryHost, type HostOptions } from "../src/service.ts";
import { initialize, openStandalone, type AppPort } from "../src/storage.ts";
import { serveHost, request } from "../src/transport.ts";
import { natural } from "../src/natural.ts";
import type { HostItem } from "../src/meaning/model-input.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(scopes = ["personal"]) {
	const dir = mkdtempSync(join(tmpdir(), "em-regression-"));
	const profile = initialize(dir, scopes);
	const owner = openStandalone(dir);
	let now = Date.now();
	const fault = {
		afterJournal: false,
		closed: 0,
		beforeRollback: undefined as (() => void) | undefined,
	};
	const configuration = () =>
		JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as HostConfig;
	const port: AppPort = {
		...owner.port,
		failClosed: () => {
			fault.closed++;
		},
		write: (fn) =>
			owner.port.write((db) => {
				const bytes = statSync(join(dir, "forget.jsonl")).size;
				const value = fn(db);
				if (
					fault.afterJournal &&
					statSync(join(dir, "forget.jsonl")).size > bytes
				) {
					fault.afterJournal = false;
					fault.beforeRollback?.();
					throw Error("injected rollback after callback and journal fsync");
				}
				return value;
			}),
	};
	const options: HostOptions = { port, configuration, clock: () => now };
	let host = new MemoryHost(options);
	await host.start();
	cleanup.push(async () => {
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir,
		profile,
		owner,
		port,
		configuration,
		options,
		fault,
		get host() {
			return host;
		},
		call: (
			method: string,
			params: unknown = {},
			credential = profile.credential,
		) => host.dispatch(credential, method, params),
		access: () => host.access(configuration().credentials[profile.credential]!),
		advance: (ms: number) => {
			now += ms;
		},
		restart: async () => {
			host = new MemoryHost(options);
			await host.start();
		},
		setConfirmedPermission: (allowed: boolean) => {
			const c = configuration();
			c.credentials[profile.credential]!.confirmedWrites = allowed;
			writeFileSync(join(dir, "owner.json"), JSON.stringify(c));
		},
	};
}
type Harness = Awaited<ReturnType<typeof setup>>;
function proposal(text: string, replacesItemId: string | null = null) {
	return {
		decision: {
			clarification: null,
			actions: [
				{
					type: "remember",
					subject: "self",
					kind: "preference",
					semanticKey: "drink",
					value: { text, polarity: "affirmed" },
					quote: text,
					replacesItemId,
				},
			],
		},
		relations: [
			{
				actionIndex: 0,
				relation: replacesItemId ? "supersedes" : "new",
				relatedItemIds: replacesItemId ? [replacesItemId] : [],
			},
		],
		groups: [[0]],
	};
}
function forget(itemId: string, clarification: string | null = null) {
	return {
		decision: { clarification, actions: [{ type: "forget", itemId }] },
		relations: [
			{ actionIndex: 0, relation: "forget", relatedItemIds: [itemId] },
		],
		groups: [[0]],
	};
}
async function planRemember(
	h: Harness,
	text = "紅茶が好き",
	replacesItemId: string | null = null,
) {
	const c = await h.call("context", { scopeKeys: ["personal"] });
	const source = await h.call("source", {
		scopeKey: "personal",
		submissionId: crypto.randomUUID(),
		content: text,
	});
	expect(source.status).toBe("registered");
	const planned = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: proposal(text, replacesItemId),
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
	return {
		source,
		planned,
		params: {
			planId: planned["planId"],
			epoch: planned["epoch"],
			operationId: crypto.randomUUID(),
		},
	};
}
async function remember(h: Harness) {
	const value = await planRemember(h);
	expect((await h.call("apply", value.params)).status).toBe("completed");
	const items = (await h.call("context", { scopeKeys: ["personal"] }))[
		"items"
	] as StateItem[];
	return { ...value, item: items[0]! };
}
async function planForget(
	h: Harness,
	itemId: string,
	clarification: string | null = null,
) {
	const c = await h.call("context", { scopeKeys: ["personal"] });
	return h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: forget(itemId, clarification),
	});
}
function assertion(
	h: Harness,
	id: string,
	text: string,
	origin: AssertUserStateInput["origin"],
	replaces?: StateItem,
	scopeKey = "personal",
): AssertUserStateInput {
	const digest = createHash("sha256").update(text).digest("hex");
	const ref = {
		namespace: "test-app",
		kind: "message",
		id,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
	};
	const source: HostSourceState = {
		...ref,
		principal: h.configuration().principal,
		scopeKey,
		status: "available",
		content: text,
		ordinal: h.options.clock!(),
	};
	return {
		contractVersion: 1,
		access: h.access(),
		scopeKey,
		clock: { atMs: h.options.clock!() },
		subject: "self",
		kind: "preference",
		semanticKey: "drink",
		value: { text, polarity: "affirmed" },
		origin,
		evidence: [
			{
				source: {
					...ref,
					range: { startByte: 0, endByte: Buffer.byteLength(text) },
				},
				quote: text,
			},
		],
		sources: [source],
		...(replaces
			? { replaces: { itemId: replaces.itemId, revision: replaces.revision } }
			: {}),
	};
}

test("F1 commit failure after durable forget closes reads and replays the intent before ready", async () => {
	const h = await setup();
	const { item } = await remember(h);
	const p = await planForget(h, item.itemId);
	h.fault.afterJournal = true;
	expect(
		(
			await h.call("apply", {
				planId: p["planId"],
				epoch: p["epoch"],
				operationId: "failed-forget",
			})
		).status,
	).toBe("failed");
	expect(h.fault.closed).toBeGreaterThan(0);
	expect(await h.call("status")).toMatchObject({ code: "HOST_NOT_READY" });
	expect((await h.call("context"))["items"]).toBeUndefined();
	expect(
		readFileSync(join(h.dir, "forget.jsonl"), "utf8").trim().length,
	).toBeGreaterThan(0);
	await h.restart();
	expect((await h.call("status")).status).toBe("ready");
	expect((await h.call("context"))["items"]).toEqual([]);
});
test("F1 queued writes recheck readiness after a journal rollback", async () => {
	const h = await setup();
	const { item } = await remember(h);
	const p = await planForget(h, item.itemId);
	h.fault.afterJournal = true;
	let queued: ReturnType<Harness["call"]> | undefined;
	h.fault.beforeRollback = () => {
		queued = h.call("source", {
			scopeKey: "personal",
			submissionId: "queued-write",
			content: "must not be accepted",
		});
	};
	await h.call("apply", {
		planId: p["planId"],
		epoch: p["epoch"],
		operationId: "queued-failure",
	});
	expect(queued).toBeDefined();
	expect(await queued).toMatchObject({ code: "HOST_NOT_READY" });
	expect(
		h.owner.port.read((db) =>
			db
				.query("SELECT id FROM host_source WHERE submission_id=?")
				.get("queued-write"),
		),
	).toBeNull();
});

test.each(["user_confirmed", "user_edited"] as const)(
	"F2 protected %s history requires permission and is still forgettable by an authorized owner",
	async (origin) => {
		const h = await setup();
		const first = await h.owner.port.write((db) =>
			assertUserState(db, assertion(h, "confirmed", "紅茶が好き", origin)),
		);
		if (first.status !== "applied") throw Error("seed rejected");
		const current = await h.owner.port.write((db) =>
			assertUserState(
				db,
				assertion(h, "inference", "珈琲が好き", "agent_inferred", first.item),
			),
		);
		if (current.status !== "applied") throw Error("correction rejected");
		expect(await planForget(h, current.item.itemId)).toMatchObject({
			code: "CONFIRMED_FORGET_REQUIRES_PERMISSION",
		});
		expect(
			h.owner.port.read((db) =>
				readStateFact(db, {
					contractVersion: 1,
					access: h.access(),
					scopeKey: "personal",
					itemId: first.item.itemId,
				}),
			).status,
		).toBe("ok");
		h.setConfirmedPermission(true);
		const p = await planForget(h, current.item.itemId);
		expect(p.status).toBe("planned");
		expect(
			(
				await h.call("apply", {
					planId: p["planId"],
					epoch: p["epoch"],
					operationId: "authorized-history-forget",
				})
			).status,
		).toBe("completed");
	},
);
test("F2 forget permission is checked again at apply for new protected history in another scope", async () => {
	const h = await setup(["personal", "other"]);
	const { item } = await remember(h);
	const p = await planForget(h, item.itemId);
	expect(p.status).toBe("planned");
	const protectedItem = await h.owner.port.write((db) =>
		assertUserState(
			db,
			assertion(
				h,
				"other-source",
				"別の好み",
				"user_confirmed",
				undefined,
				"other",
			),
		),
	);
	expect(protectedItem.status).toBe("applied");
	expect(
		await h.call("apply", {
			planId: p["planId"],
			epoch: p["epoch"],
			operationId: "new-history-denied",
		}),
	).toMatchObject({ code: "CONFIRMED_FORGET_REQUIRES_PERMISSION" });
	expect(
		(await h.call("context", { scopeKeys: ["personal"] }))["items"],
	).toHaveLength(1);
});
test("F3 one item cannot be forgotten and corrected by splitting it into groups", async () => {
	const h = await setup();
	const { item } = await remember(h);
	const c = await h.call("context");
	const text = "珈琲が好き";
	const source = await h.call("source", {
		scopeKey: "personal",
		submissionId: "correction",
		content: text,
	});
	const correction = proposal(text, item.itemId);
	const p = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: {
			decision: {
				clarification: null,
				actions: [
					{ type: "forget", itemId: item.itemId },
					...correction.decision.actions,
				],
			},
			relations: [
				{ actionIndex: 0, relation: "forget", relatedItemIds: [item.itemId] },
				{
					actionIndex: 1,
					relation: "supersedes",
					relatedItemIds: [item.itemId],
				},
			],
			groups: [[0], [1]],
		},
		evidence: [
			{
				actionIndex: 1,
				sourceHandle: source["sourceHandle"],
				startByte: 0,
				endByte: Buffer.byteLength(text),
			},
		],
	});
	expect(p).toMatchObject({
		status: "needs_clarification",
		code: "DEPENDENT_GROUP_UNSUPPORTED",
	});
	expect((await h.call("context"))["items"]).toHaveLength(1);
	expect(readFileSync(join(h.dir, "forget.jsonl"), "utf8")).toBe("");
});
test("F3 a stored legacy plan with a shared forget/correction target is rejected before deletion", async () => {
	const h = await setup();
	const { item } = await remember(h);
	const correction = await planRemember(h, "珈琲が好き", item.itemId);
	// Model an accepted pre-fix payload, using only host metadata, not the core's internal tables.
	await h.owner.port.write((db) => {
		const row = db
			.query("SELECT payload FROM host_plan WHERE id=?")
			.get(correction.planned["planId"] as string) as { payload: string };
		const stored = JSON.parse(
			row.payload,
		) as import("../src/operations.ts").StoredPlan;
		stored.parsed.changes[0]!.actionIndex = 1;
		stored.parsed.changes.unshift({
			actionIndex: 0,
			relation: "forget",
			relatedItemIds: [item.itemId],
			actions: [{ type: "forget", itemId: item.itemId }],
		});
		stored.parsed.groups = [[0], [1]];
		stored.evidence[0]!.actionIndex = 1;
		db.query("UPDATE host_plan SET payload=? WHERE id=?").run(
			JSON.stringify(stored),
			stored.id,
		);
	});
	expect(await h.call("apply", correction.params)).toMatchObject({
		status: "needs_clarification",
		code: "DEPENDENT_GROUP_UNSUPPORTED",
	});
	expect((await h.call("context"))["items"]).toHaveLength(1);
	expect(readFileSync(join(h.dir, "forget.jsonl"), "utf8")).toBe("");
});
async function pendingDeletion(
	h: Harness,
	clarification: string | null = null,
) {
	const { item } = await remember(h);
	const saved = await h.owner.port.write((db) =>
		registerExternalDependents(db, {
			contractVersion: 1,
			access: h.access(),
			scopeKey: "personal",
			clock: { atMs: h.options.clock!() },
			dependents: [
				{
					providerRef: "external-copy",
					externalId: "copy",
					dependsOn: [{ type: "state_item", id: item.itemId }],
				},
			],
		}),
	);
	expect(saved.status).toBe("registered");
	const plan = await planForget(h, item.itemId, clarification);
	const params = {
		planId: plan["planId"],
		epoch: plan["epoch"],
		operationId: crypto.randomUUID(),
	};
	const pending = await h.call("apply", params);
	expect(pending.status).toBe("pending");
	const confirm = async () => {
		for (const forgetId of pending["forgetIds"] as string[]) {
			await h.owner.port.write((db) =>
				recordExternalDeletion(db, {
					contractVersion: 2,
					access: h.access(),
					forgetId,
					providerRef: "external-copy",
					externalId: "copy",
					state: "confirmed",
					clock: { atMs: h.options.clock!() },
				}),
			);
			const receipt = h.owner.port.read((db) =>
				getForgetReceipt(db, {
					contractVersion: 2,
					access: h.access(),
					forgetId,
				}),
			);
			expect(receipt.status === "found" && receipt.receipt.completed).toBe(
				true,
			);
		}
	};
	return { params, pending, confirm };
}
test.each([null, "独立した別の要求は対象が曖昧です"])(
	"F4 payload-free external deletion settles correctly after restart (clarification=%s)",
	async (clarification) => {
		const h = await setup();
		const value = await pendingDeletion(h, clarification);
		await h.restart();
		expect(
			h.owner.port.read(
				(db) =>
					(
						db
							.query("SELECT payload FROM host_operation WHERE id=?")
							.get(value.params.operationId) as { payload: string | null }
					).payload,
			),
		).toBeNull();
		expect(
			(
				await h.call("operation", {
					operationId: value.params.operationId,
					epoch: value.params.epoch,
				})
			).status,
		).toBe("pending");
		await value.confirm();
		const expected = clarification ? "needs_clarification" : "completed";
		expect(
			(
				await h.call("operation", {
					operationId: value.params.operationId,
					epoch: value.params.epoch,
				})
			).status,
		).toBe(expected);
		expect((await h.call("status"))["pendingOperations"]).toBe(0);
		expect((await h.call("apply", value.params)).status).toBe(expected);
		expect((await h.call("context"))["items"]).toEqual([]);
	},
);
test("F4 legacy pending payload retains its non-text outcome before startup erases it", async () => {
	const h = await setup();
	const value = await pendingDeletion(h, "別件は要確認");
	await h.owner.port.write((db) =>
		db
			.query(
				"UPDATE host_operation SET result=json_remove(result,'$.clarificationRequired') WHERE id=?",
			)
			.run(value.params.operationId),
	);
	await h.restart();
	await value.confirm();
	expect((await h.call("apply", value.params)).status).toBe(
		"needs_clarification",
	);
	const row = h.owner.port.read((db) =>
		db
			.query("SELECT result,payload FROM host_operation WHERE id=?")
			.get(value.params.operationId),
	) as { payload: string | null; result: string };
	expect(row.payload).toBeNull();
	expect(row.result).not.toContain("別件は要確認");
	expect(row.result).not.toContain("紅茶");
});
test("F4 expired execution payload keeps completed groups and current receipts usable", async () => {
	const h = await setup();
	const value = await pendingDeletion(h);
	h.advance(HOST_LIMITS.payloadTtlMs + 1);
	await h.call("source", {
		scopeKey: "personal",
		submissionId: "ttl-cleanup",
		content: "未採用",
	});
	await value.confirm();
	expect((await h.call("apply", value.params)).status).toBe("completed");
});
test("F4 irrecoverable legacy outcome is indeterminate rather than a guessed success", async () => {
	const h = await setup();
	const value = await pendingDeletion(h);
	await h.restart();
	await h.owner.port.write((db) =>
		db
			.query(
				"UPDATE host_operation SET result=json_remove(result,'$.clarificationRequired') WHERE id=?",
			)
			.run(value.params.operationId),
	);
	await value.confirm();
	expect(
		await h.call("operation", {
			operationId: value.params.operationId,
			epoch: value.params.epoch,
		}),
	).toMatchObject({
		status: "indeterminate",
		code: "OPERATION_COMPLETION_METADATA_MISSING",
	});
});

test.each([
	"current",
	"stale",
	"missing",
	"unverified",
	"foreign-scope",
] as const)(
	"F5 source validity %s reaches context/read/model and unavailable citations are rejected",
	async (validity) => {
		const h = await setup();
		const input = assertion(
			h,
			"external-message",
			"紅茶が好き",
			"agent_inferred",
		);
		const result = await h.port.write((db) => assertUserState(db, input));
		expect(result.status).toBe("applied");
		const source = input.sources[0]!;
		if (validity !== "unverified")
			h.options.resolveSource = () =>
				validity === "missing"
					? undefined
					: {
							...source,
							...(validity === "stale"
								? { revision: "changed", digest: "changed" }
								: {}),
							...(validity === "foreign-scope"
								? { scopeKey: "unauthorized" }
								: {}),
						};
		const expected = validity === "foreign-scope" ? "missing" : validity;
		const context = await h.call("context", {});
		const item = (context["items"] as HostItem[])[0]!;
		expect(item.evidenceStatus).toBe(expected);
		const read = await h.call("read", {
			snapshotId: context["snapshotId"],
			itemId: item.itemId,
		});
		expect((read["item"] as HostItem).evidenceStatus).toBe(expected);
		const transport = await serveHost(h.host, h.profile.socketPath);
		cleanup.push(() => transport.close());
		const answer = await natural(
			h.profile,
			"recall",
			{ scopeKey: "personal", message: "飲み物の好みは？" },
			async (prompt) => {
				expect(
					(JSON.parse(prompt).items as HostItem[])[0]!.evidenceStatus,
				).toBe(expected);
				return {
					raw: JSON.stringify({
						parts: [
							{
								request: "飲み物の好み",
								status: "supported",
								evidenceIds: [item.itemId],
							},
						],
					}),
					usage: null,
					threadId: null,
				};
			},
		);
		expect(answer.status).toBe(validity === "current" ? "found" : "blocked");
		if (validity !== "current") {
			expect(answer.code).toBe("EVIDENCE_UNAVAILABLE");
			expect(answer["parts"]).toBeUndefined();
			const unknown = await natural(
				h.profile,
				"recall",
				{ scopeKey: "personal", message: "飲み物の好みは？" },
				async () => ({
					raw: JSON.stringify({
						parts: [
							{ request: "飲み物の好み", status: "unknown", evidenceIds: [] },
						],
					}),
					usage: null,
					threadId: null,
				}),
			);
			expect(unknown.status).toBe("found");
			expect(unknown["items"]).toEqual([]);
		}
	},
);

test("G1 forgetting an applied assertion erases the producing plan's proposed text", async () => {
	const h = await setup();
	const value = await remember(h);
	const plan = await planForget(h, value.item.itemId);
	expect(
		(
			await h.call("apply", {
				planId: plan["planId"],
				epoch: plan["epoch"],
				operationId: "erase-producing-plan",
			})
		).status,
	).toBe("completed");
	const original = h.owner.port.read(
		(db) =>
			db
				.query("SELECT payload FROM host_plan WHERE id=?")
				.get(value.params.planId as string) as { payload: string | null },
	);
	expect(original.payload).toBeNull();
});

test("G2 source dependencies outlive plan expiry while an admitted operation still holds execution text", async () => {
	const h = await setup();
	const value = await planRemember(h);
	const write = h.port.write;
	h.port.write = async (fn) => {
		let admitted = false;
		const result = await write((db) => {
			const before = db
				.query("SELECT count(*) AS n FROM host_operation")
				.get() as { n: number };
			const result = fn(db);
			const after = db
				.query("SELECT count(*) AS n FROM host_operation")
				.get() as { n: number };
			admitted = after.n > before.n;
			return result;
		});
		if (admitted) {
			h.port.write = write;
			throw Error("process lost after operation admission committed");
		}
		return result;
	};
	expect((await h.call("apply", value.params)).status).toBe("failed");
	h.advance(HOST_LIMITS.planTtlMs + 1);
	const row = h.owner.port.read(
		(db) =>
			db
				.query("SELECT submission_id,content FROM host_source WHERE id=?")
				.get((value.source["source"] as { id: string }).id) as {
				submission_id: string;
				content: string;
			},
	);
	const renewed = await h.call("source", {
		scopeKey: "personal",
		submissionId: row.submission_id,
		content: row.content,
	});
	expect(renewed.status).toBe("registered");
	const context = await h.call("context", {});
	const deletion = await h.call("plan", {
		snapshotId: context["snapshotId"],
		scopeKey: "personal",
		proposal: {
			decision: { clarification: null, actions: [] },
			relations: [],
			groups: [],
		},
		sourceHandles: [renewed["sourceHandle"]],
	});
	expect(deletion.status).toBe("planned");
	expect(
		(
			await h.call("apply", {
				planId: deletion["planId"],
				epoch: deletion["epoch"],
				operationId: "erase-after-expiry",
			})
		).status,
	).toBe("completed");
	const operation = h.owner.port.read(
		(db) =>
			db
				.query("SELECT payload FROM host_operation WHERE id=?")
				.get(value.params.operationId) as { payload: string | null },
	);
	expect(operation.payload).toBeNull();
	expect(
		await h.call("operation", {
			operationId: value.params.operationId,
			epoch: value.params.epoch,
		}),
	).toMatchObject({
		status: "indeterminate",
		code: "EXECUTION_PAYLOAD_UNAVAILABLE",
	});
});

test("G3 partial snapshots reject source changes even when the displayed State itself is unchanged", async () => {
	const h = await setup();
	const input = assertion(h, "partial-source", "出典の内容", "agent_inferred");
	let source = input.sources[0]!;
	h.options.resolveSource = () => source;
	await h.port.write((db) => {
		for (let i = 0; i < 1800; i++) {
			const written = assertUserState(db, {
				...input,
				semanticKey: `partial-${i}`,
				value: { text: "x".repeat(4096), polarity: "affirmed" },
			});
			expect(written.status).toBe("applied");
		}
	});
	const context = await h.call("context", { limit: 1 });
	expect(
		(context["coverage"] as { snapshotComplete: boolean }).snapshotComplete,
	).toBe(false);
	const item = (context["items"] as HostItem[])[0]!;
	expect(
		(
			await h.call("read", {
				snapshotId: context["snapshotId"],
				itemId: item.itemId,
			})
		).status,
	).toBe("found");
	source = { ...source, revision: "updated", digest: "updated" };
	expect(
		await h.call("read", {
			snapshotId: context["snapshotId"],
			itemId: item.itemId,
		}),
	).toMatchObject({ status: "stale", code: "SNAPSHOT_STALE" });
});

test("G6 repeated corrections of one target are rejected before any group can commit", async () => {
	const h = await setup();
	const { item } = await remember(h);
	const context = await h.call("context", {});
	const text = "珈琲が好き。白湯が好き";
	const source = await h.call("source", {
		scopeKey: "personal",
		submissionId: "two-corrections",
		content: text,
	});
	const actions = ["珈琲が好き", "白湯が好き"].map(
		(value) => proposal(value, item.itemId).decision.actions[0]!,
	);
	const result = await h.call("plan", {
		snapshotId: context["snapshotId"],
		scopeKey: "personal",
		proposal: {
			decision: { clarification: null, actions },
			relations: actions.map((_, actionIndex) => ({
				actionIndex,
				relation: "supersedes",
				relatedItemIds: [item.itemId],
			})),
			groups: [[0], [1]],
		},
		evidence: actions.map((action, actionIndex) => ({
			actionIndex,
			sourceHandle: source["sourceHandle"],
			startByte: Buffer.byteLength(text.slice(0, text.indexOf(action.quote))),
			endByte: Buffer.byteLength(
				text.slice(0, text.indexOf(action.quote) + action.quote.length),
			),
		})),
	});
	expect(result).toMatchObject({
		status: "needs_clarification",
		code: "DUPLICATE_CORRECTION_TARGET",
	});
	expect(
		((await h.call("context", {}))["items"] as StateItem[])[0]!.itemId,
	).toBe(item.itemId);
});

test.each(["profile.json", "forget.jsonl", "owner.lock", "memory.sock"])(
	"G7 init refuses a reserved %s before creating any store files",
	(name) => {
		const dir = mkdtempSync(join(tmpdir(), "em-init-reserved-"));
		try {
			writeFileSync(join(dir, name), "existing-data");
			expect(() => initialize(dir)).toThrow();
			expect(readdirSync(dir)).toEqual([name]);
			expect(readFileSync(join(dir, name), "utf8")).toBe("existing-data");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("G8 request stops consuming an oversized response at the byte limit", async () => {
	let chunks = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				chunks++;
				controller.enqueue(new Uint8Array(HOST_LIMITS.responseBytes / 2));
				if (chunks === 8) controller.close();
			},
			cancel() {
				cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	const mocked = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(stream),
	);
	try {
		expect(
			await request(
				{ version: 1, socketPath: "unused", credential: "unused" },
				"status",
				{},
			),
		).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
		expect(chunks).toBeLessThan(8);
		expect(cancelled).toBe(true);
	} finally {
		mocked.mockRestore();
	}
});

test("G9 configuration errors before request admission return sanitized protocol failures", async () => {
	const h = await setup();
	const transport = await serveHost(h.host, h.profile.socketPath, () => {
		throw Error("synthetic private configuration detail");
	});
	cleanup.push(() => transport.close());
	const result = await request(h.profile, "status", {});
	expect(result).toEqual({ status: "failed", code: "HOST_OPERATION_FAILED" });
});

test("G8 CLI input rejects oversized files before parsing or contacting the host", async () => {
	const h = await setup();
	const input = join(h.dir, "large.json");
	writeFileSync(input, " ".repeat(HOST_LIMITS.requestBytes + 1));
	const { main } = await import("../src/cli.ts");
	await expect(
		main([
			"--profile",
			join(h.dir, "profile.json"),
			"status",
			"--input",
			input,
		]),
	).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
});

test("G1 legacy producing plans without output dependencies are scrubbed on a later forget", async () => {
	const h = await setup();
	const value = await remember(h);
	await h.port.write((db) => {
		// The previous release tracked plan inputs but not the assertion created by apply.
		const dependency = db
			.query(
				"SELECT id FROM host_dependent WHERE plan_id=? ORDER BY rowid DESC LIMIT 1",
			)
			.get(value.params.planId as string) as { id: string };
		expect(
			unregisterExternalDependents(db, {
				contractVersion: 1,
				access: h.access(),
				scopeKey: "personal",
				clock: { atMs: h.options.clock!() },
				dependents: [{ providerRef: "memory-host", externalId: dependency.id }],
			}).status,
		).toBe("unregistered");
		db.query("DELETE FROM host_dependent WHERE id=?").run(dependency.id);
	});
	await h.restart();
	const deletion = await planForget(h, value.item.itemId);
	expect(
		(
			await h.call("apply", {
				planId: deletion["planId"],
				epoch: deletion["epoch"],
				operationId: "legacy-producer-forget",
			})
		).status,
	).toBe("completed");
	expect(
		h.owner.port.read(
			(db) =>
				(
					db
						.query("SELECT payload FROM host_plan WHERE id=?")
						.get(value.params.planId as string) as { payload: string | null }
				).payload,
		),
	).toBeNull();
});

test("G7 init also refuses a dangling reserved symlink without adding files", () => {
	const dir = mkdtempSync(join(tmpdir(), "em-init-link-"));
	try {
		symlinkSync(join(dir, "missing-target"), join(dir, "profile.json"));
		expect(() => initialize(dir)).toThrow();
		expect(readdirSync(dir)).toEqual(["profile.json"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("G10 an unchanged correction does not keep its unadopted new source forever", async () => {
	const h = await setup();
	const original = await remember(h);
	const same = await planRemember(h, "紅茶が好き", original.item.itemId);
	expect((await h.call("apply", same.params)).status).toBe("completed");
	expect(
		((await h.call("context", {}))["items"] as StateItem[])[0]!.itemId,
	).toBe(original.item.itemId);
	h.advance(HOST_LIMITS.sourceTtlMs + 1);
	expect(
		(
			await h.call("source", {
				scopeKey: "personal",
				submissionId: "trigger-unused-correction",
				content: "別の出典",
			})
		).status,
	).toBe("registered");
	const source = h.owner.port.read(
		(db) =>
			db
				.query("SELECT content FROM host_source WHERE id=?")
				.get((same.source["source"] as { id: string }).id) as {
				content: string | null;
			},
	);
	expect(source.content).toBeNull();
	expect(
		((await h.call("context", {}))["items"] as StateItem[])[0]!.itemId,
	).toBe(original.item.itemId);
});
