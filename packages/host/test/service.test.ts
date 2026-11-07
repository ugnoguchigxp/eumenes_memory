import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialize, openStandalone } from "../src/storage.ts";
import {
	assertUserState,
	planForget,
	applyForget,
	readRecord,
	registerExternalDependents,
	recordExternalDeletion,
} from "eumenes-memory/sqlite";
import type { StateItem, StateSubject, StateKind } from "eumenes-memory";
import { HOST_LIMITS } from "../src/contracts.ts";
import { MemoryHost } from "../src/service.ts";
import type { HostConfig } from "../src/contracts.ts";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of dispose.splice(0).reverse()) await close();
});
async function fixture(scopes = ["personal"]) {
	const dir = mkdtempSync(join(tmpdir(), "emh-"));
	const profile = initialize(dir, scopes);
	const configuration = () =>
		JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as HostConfig;
	let now = Date.now();
	const owner = openStandalone(dir);
	const host = new MemoryHost({
		port: owner.port,
		configuration,
		clock: () => now,
	});
	await host.start();
	dispose.push(async () => {
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const call = (
		method: string,
		params: unknown = {},
		credential = profile.credential,
	) => host.dispatch(credential, method, params);
	return {
		dir,
		profile,
		configuration,
		owner,
		host,
		call,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
function proposal(text: string, item?: { itemId: string }) {
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
					replacesItemId: item?.itemId ?? null,
				},
			],
		},
		relations: [
			{
				actionIndex: 0,
				relation: item ? "supersedes" : "new",
				relatedItemIds: item ? [item.itemId] : [],
			},
		],
		groups: [[0]],
	};
}
async function remember(
	h: Awaited<ReturnType<typeof fixture>>,
	text: string,
	item?: { itemId: string },
	scopeKey = "personal",
) {
	const context = await h.call("context", { scopeKeys: [scopeKey] });
	const source = await h.call("source", {
		submissionId: crypto.randomUUID(),
		scopeKey,
		content: text,
	});
	expect(source.status).toBe("registered");
	const plan = await h.call("plan", {
		snapshotId: context["snapshotId"],
		scopeKey,
		proposal: proposal(text, item),
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
	const params = {
		planId: plan["planId"],
		epoch: plan["epoch"],
		operationId: crypto.randomUUID(),
	};
	const result = await h.call("apply", params);
	return { context, source, plan, params, result };
}
test("shared public API: source, plan, apply, correction and duplicate response", async () => {
	const h = await fixture();
	const first = await remember(h, "コーヒーが好きです");
	expect(first.result.status).toBe("completed");
	expect(await h.call("apply", first.params)).toEqual(first.result);
	const context = await h.call("context");
	const items = context["items"] as {
		itemId: string;
		origin: string;
		revision: number;
	}[];
	expect(items).toHaveLength(1);
	expect(items[0]!.origin).toBe("agent_inferred");
	const second = await remember(h, "紅茶が好きです", items[0]);
	expect(second.result.status).toBe("completed");
	const updated = await h.call("context");
	expect(updated["items"] as unknown[]).toHaveLength(1);
	expect(
		await h.call("apply", { ...first.params, planId: second.plan["planId"] }),
	).toMatchObject({ status: "blocked", code: "OPERATION_ID_CONFLICT" });
});
test("authentication, input contracts and scope cannot be widened by model arguments", async () => {
	const h = await fixture(["personal", "project:private"]);
	expect(await h.call("context", {}, "invalid")).toMatchObject({
		status: "blocked",
		code: "AUTH_REQUIRED",
	});
	const config = h.configuration();
	config.credentials["limited"] = {
		clientId: "limited",
		scopeKeys: ["personal"],
		read: true,
		write: true,
		forgetAll: false,
		confirmedWrites: false,
	};
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(
		await h.call("context", { scopeKeys: ["project:private"] }, "limited"),
	).toMatchObject({ code: "SCOPE_NOT_PERMITTED" });
	expect(
		await h.call(
			"source",
			{
				submissionId: "a",
				scopeKey: "personal",
				content: "x",
				origin: "user_confirmed",
			},
			"limited",
		),
	).toMatchObject({ code: "INVALID_INPUT" });
	const a = await h.call("source", {
		submissionId: "a",
		scopeKey: "personal",
		content: "x",
	});
	expect(
		(
			await h.call("source", {
				submissionId: "a",
				scopeKey: "personal",
				content: "x",
			})
		)["source"],
	).toEqual(a["source"]);
	expect(
		await h.call("source", {
			submissionId: "a",
			scopeKey: "personal",
			content: "y",
		}),
	).toMatchObject({ code: "SUBMISSION_ID_CONFLICT" });
});
test("forget all versions and original source; pre-forget DB restore uses latest journal", async () => {
	const h = await fixture();
	const first = await remember(h, "コーヒーが好きです");
	expect(first.result.status).toBe("completed");
	const context = await h.call("context");
	const item = (context["items"] as { itemId: string }[])[0]!;
	const second = await remember(h, "紅茶が好きです", item);
	expect(second.result.status).toBe("completed");
	const reader = new Database(join(h.dir, "memory.db"), { readonly: true });
	try {
		reader.exec(`VACUUM INTO '${join(h.dir, "backup.db")}'`);
	} finally {
		reader.close();
	}
	const current = await h.call("context");
	const target = (current["items"] as { itemId: string }[])[0]!;
	const forget = {
		decision: {
			clarification: null,
			actions: [{ type: "forget", itemId: target.itemId }],
		},
		relations: [
			{ actionIndex: 0, relation: "forget", relatedItemIds: [target.itemId] },
		],
		groups: [[0]],
	};
	const plan = await h.call("plan", {
		snapshotId: current["snapshotId"],
		scopeKey: "personal",
		proposal: forget,
		sourceHandles: [
			first.source["sourceHandle"],
			second.source["sourceHandle"],
		],
	});
	expect(plan.status).toBe("planned");
	const applied = await h.call("apply", {
		planId: plan["planId"],
		epoch: plan["epoch"],
		operationId: "forget-op",
	});
	expect(applied.status).toBe("completed");
	expect((await h.call("context"))["items"]).toEqual([]);
	expect(
		await h.call("read", { sourceHandle: first.source["sourceHandle"] }),
	).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
	// Separate disposable copy models restoring ONLY the pre-forget DB, retaining the latest journal.
	const restoredDir = mkdtempSync(join(tmpdir(), "emr-"));
	copyFileSync(join(h.dir, "backup.db"), join(restoredDir, "memory.db"));
	copyFileSync(join(h.dir, "forget.jsonl"), join(restoredDir, "forget.jsonl"));
	const owner = openStandalone(restoredDir);
	const restored = new MemoryHost({
		port: owner.port,
		configuration: h.configuration,
	});
	dispose.push(async () => {
		await owner.close();
		rmSync(restoredDir, { recursive: true, force: true });
	});
	await restored.start();
	expect(
		(await restored.dispatch(h.profile.credential, "context", {}))["items"],
	).toEqual([]);
	expect(
		await restored.dispatch(h.profile.credential, "apply", {
			planId: plan["planId"],
			epoch: plan["epoch"],
			operationId: "lost-receipt",
		}),
	).toMatchObject({ status: "indeterminate" });
});
function forgetProposal(itemId: string) {
	return {
		decision: { clarification: null, actions: [{ type: "forget", itemId }] },
		relations: [
			{ actionIndex: 0, relation: "forget", relatedItemIds: [itemId] },
		],
		groups: [[0]],
	};
}
async function planFor(
	h: Awaited<ReturnType<typeof fixture>>,
	text: string,
	item?: { itemId: string },
	scopeKey = "personal",
) {
	const c = await h.call("context", { scopeKeys: [scopeKey] });
	const s = await h.call("source", {
		submissionId: crypto.randomUUID(),
		scopeKey,
		content: text,
	});
	const p = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey,
		proposal: proposal(text, item),
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
	return {
		planId: p["planId"],
		epoch: p["epoch"],
		operationId: crypto.randomUUID(),
	};
}
test("R02 exact UTF-8 range selects a repeated quote and rejects split codepoints", async () => {
	const h = await fixture();
	const quote = "珈琲が好き";
	const content = `${quote}。記録の途中。${quote}。`;
	const c = await h.call("context");
	const s = await h.call("source", {
		submissionId: "repeat",
		scopeKey: "personal",
		content,
	});
	const start = Buffer.byteLength(content.slice(0, content.lastIndexOf(quote)));
	const base = {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: proposal(quote),
	};
	expect(
		await h.call("plan", {
			...base,
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: s["sourceHandle"],
					startByte: start + 1,
					endByte: start + Buffer.byteLength(quote),
				},
			],
		}),
	).toMatchObject({ code: "QUOTE_MISMATCH" });
	const p = await h.call("plan", {
		...base,
		evidence: [
			{
				actionIndex: 0,
				sourceHandle: s["sourceHandle"],
				startByte: start,
				endByte: start + Buffer.byteLength(quote),
			},
		],
	});
	expect(p.status).toBe("planned");
	expect(
		(
			await h.call("apply", {
				planId: p["planId"],
				epoch: p["epoch"],
				operationId: "repeat-op",
			})
		).status,
	).toBe("completed");
	const items = (await h.call("context"))["items"] as StateItem[];
	expect(items[0]!.evidence[0]!.range).toEqual({
		startByte: start,
		endByte: start + Buffer.byteLength(quote),
	});
});
function seededAssertion(
	h: Awaited<ReturnType<typeof fixture>>,
	subject: StateSubject,
	kind: StateKind,
	origin: "agent_inferred" | "user_confirmed",
) {
	const ref = {
		namespace: "test-app",
		kind: "message",
		id: crypto.randomUUID(),
		revision: "r1",
		representation: "text",
		digest: createHash("sha256").update("水が好き").digest("hex"),
	};
	const content = "水が好き";
	return {
		contractVersion: 1 as const,
		access: h.host.access(h.configuration().credentials[h.profile.credential]!),
		scopeKey: "personal",
		clock: { atMs: h.host.clock() },
		subject,
		kind,
		semanticKey: "drink",
		value: { text: content, polarity: "affirmed" as const },
		origin,
		evidence: [
			{
				source: {
					...ref,
					range: { startByte: 0, endByte: Buffer.byteLength(content) },
				},
				quote: content,
			},
		],
		sources: [
			{
				...ref,
				principal: h.configuration().principal,
				scopeKey: "personal",
				status: "available" as const,
				content,
				ordinal: 1,
			},
		],
	};
}
test("R03 confirmed facts require a separate authority; ordinary source never upgrades origin", async () => {
	const h = await fixture();
	await h.owner.port.write((db) => {
		const r = assertUserState(
			db,
			seededAssertion(h, "self", "preference", "user_confirmed"),
		);
		expect(r.status).toBe("applied");
	});
	const c = await h.call("context");
	const item = (c["items"] as StateItem[])[0]!;
	const s = await h.call("source", {
		submissionId: "infer",
		scopeKey: "personal",
		content: "お茶が好き",
	});
	expect(s["origin"]).toBe("agent_inferred");
	expect(
		await h.call("plan", {
			snapshotId: c["snapshotId"],
			scopeKey: "personal",
			proposal: proposal("お茶が好き", item),
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: s["sourceHandle"],
					startByte: 0,
					endByte: 15,
				},
			],
		}),
	).toMatchObject({ code: "CONFIRMED_WRITE_NOT_PERMITTED" });
	expect((await h.call("context"))["items"]).toEqual(c["items"]);
});
test("R04/R05 scope-limited connections cannot inspect plans, operation outcomes or forget closures", async () => {
	const h = await fixture(["personal", "private"]);
	const saved = await remember(h, "秘密の好み", undefined, "private");
	expect(saved.result.status).toBe("completed");
	const config = h.configuration();
	config.credentials["limited"] = {
		clientId: "limited",
		scopeKeys: ["personal"],
		read: true,
		write: true,
		forgetAll: false,
		confirmedWrites: false,
	};
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(
		await h.call(
			"operation",
			{ operationId: saved.params.operationId, epoch: h.host.epoch },
			"limited",
		),
	).toMatchObject({ code: "SCOPE_NOT_PERMITTED" });
	expect(await h.call("apply", saved.params, "limited")).toMatchObject({
		code: "SCOPE_NOT_PERMITTED",
	});
	await remember(h, "公開した好み");
	const c = await h.call("context", { scopeKeys: ["personal"] }, "limited");
	const id = (c["items"] as StateItem[])[0]!.itemId;
	expect(
		await h.call(
			"plan",
			{
				snapshotId: c["snapshotId"],
				scopeKey: "personal",
				proposal: forgetProposal(id),
			},
			"limited",
		),
	).toEqual({ status: "blocked", code: "FORGET_REQUIRES_ALL_SCOPES" });
	delete config.credentials[h.profile.credential];
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(
		await h.call("operation", {
			operationId: saved.params.operationId,
			epoch: h.host.epoch,
		}),
	).toMatchObject({ code: "AUTH_REQUIRED" });
});
test("R06 scoped other-person facts paginate consistently and expired cursors fail", async () => {
	const h = await fixture();
	for (let i = 0; i < 3; i++)
		await h.owner.port.write((db) => {
			assertUserState(
				db,
				seededAssertion(
					h,
					`other:person-${i}`,
					"other_person_note",
					"agent_inferred",
				),
			);
		});
	const page = await h.call("context", { limit: 1 });
	expect((page["items"] as StateItem[])[0]!.subject).toStartWith("other:");
	expect(page["coverage"]).toMatchObject({
		complete: false,
		snapshotComplete: true,
	});
	const next = await h.call("context", {
		cursor: page["nextCursor"],
		limit: 1,
	});
	expect(next["snapshotId"]).toBe(page["snapshotId"]);
	h.advance(HOST_LIMITS.snapshotTtlMs + 1);
	expect(await h.call("context", { cursor: page["nextCursor"] })).toMatchObject(
		{ code: "SNAPSHOT_EXPIRED" },
	);
});
test("R07 competing corrections reject one; unrelated scope writes preserve the plan", async () => {
	const h = await fixture(["personal", "private"]);
	await remember(h, "水が好き");
	const item = (
		(await h.call("context", { scopeKeys: ["personal"] }))[
			"items"
		] as StateItem[]
	)[0]!;
	const a = await planFor(h, "お茶が好き", item);
	const b = await planFor(h, "牛乳が好き", item);
	await remember(h, "本が好き", undefined, "private");
	const results = await Promise.all([h.call("apply", a), h.call("apply", b)]);
	expect(results.map((r) => r.status).sort()).toEqual(["completed", "stale"]);
	expect(results.find((r) => r.status === "stale")!.code).toBe(
		"SNAPSHOT_STALE",
	);
});
test("R08 payload expiry preserves the used operation identity and cannot repeat a mutation", async () => {
	const h = await fixture();
	const one = await remember(h, "水が好き");
	h.advance(HOST_LIMITS.payloadTtlMs + 1);
	expect(await h.call("apply", one.params)).toEqual(one.result);
	expect((await h.call("context"))["items"]).toHaveLength(1);
});
test("R09 durable append recovers after a simulated crash even after client revocation", async () => {
	const h = await fixture();
	await remember(h, "水が好き");
	const c = await h.call("context");
	const item = (c["items"] as StateItem[])[0]!;
	const p = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: forgetProposal(item.itemId),
	});
	h.host.options.afterJournalAppend = () => {
		throw Error("simulated process death after fsync");
	};
	expect(
		(
			await h.call("apply", {
				planId: p["planId"],
				epoch: p["epoch"],
				operationId: "crash-forget",
			})
		).status,
	).not.toBe("completed");
	expect(h.host.healthy).toBe(false);
	const config = h.configuration();
	config.credentials["replacement"] = {
		...config.credentials[h.profile.credential]!,
		clientId: "replacement",
	};
	delete config.credentials[h.profile.credential];
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	const recovered = new MemoryHost({
		port: h.owner.port,
		configuration: h.configuration,
	});
	await recovered.start();
	expect(
		await recovered.dispatch(h.profile.credential, "context", {}),
	).toMatchObject({ code: "AUTH_REQUIRED" });
	expect(
		(await recovered.dispatch("replacement", "context", {}))["items"],
	).toEqual([]);
	expect(
		await recovered.dispatch("replacement", "operation", {
			operationId: "crash-forget",
			epoch: h.host.epoch,
		}),
	).toMatchObject({ status: "indeterminate", localForgetApplied: true });
});
test("R11 independent groups report partial when a later transaction rolls back", async () => {
	const h = await fixture();
	const c = await h.call("context");
	const text = "水が好き";
	const s = await h.call("source", {
		submissionId: "groups",
		scopeKey: "personal",
		content: text,
	});
	const p1 = proposal(text);
	const action = p1.decision.actions[0]!;
	const p = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: {
			decision: {
				clarification: null,
				actions: [
					action,
					{
						...action,
						semanticKey: "too-long",
						value: { text: "x".repeat(100000), polarity: "affirmed" },
					},
				],
			},
			relations: [
				p1.relations[0],
				{ actionIndex: 1, relation: "new", relatedItemIds: [] },
			],
			groups: [[0], [1]],
		},
		evidence: [0, 1].map((actionIndex) => ({
			actionIndex,
			sourceHandle: s["sourceHandle"],
			startByte: 0,
			endByte: Buffer.byteLength(text),
		})),
	});
	// A public API constraint failure in group 2 must preserve only group 1 and its receipt.
	const applied = await h.call("apply", {
		planId: p["planId"],
		epoch: p["epoch"],
		operationId: "partial-groups",
	});
	expect(applied).toMatchObject({
		status: "partial",
		groups: ["applied", "not_run"],
	});
	expect((await h.call("context"))["items"]).toHaveLength(1);
});
test("R11 source deletion refuses partial retention; external deletion remains pending", async () => {
	const h = await fixture();
	const saved = await remember(h, "水が好き");
	const c = await h.call("context");
	const item = (c["items"] as StateItem[])[0]!;
	expect(
		await h.call("plan", {
			snapshotId: c["snapshotId"],
			scopeKey: "personal",
			proposal: {
				decision: { clarification: null, actions: [] },
				relations: [],
				groups: [],
			},
			sourceHandles: [saved.source["sourceHandle"]],
		}),
	).toMatchObject({
		status: "needs_clarification",
		code: "SOURCE_RETENTION_CONFLICT",
	});
	await h.owner.port.write((db) => {
		const r = registerExternalDependents(db, {
			contractVersion: 1,
			access: h.host.access(
				h.configuration().credentials[h.profile.credential]!,
			),
			scopeKey: "personal",
			clock: { atMs: h.host.clock() },
			dependents: [
				{
					providerRef: "test-provider",
					externalId: "copy-1",
					dependsOn: [{ type: "state_item", id: item.itemId }],
				},
			],
		});
		expect(r.status).toBe("registered");
	});
	const p = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: forgetProposal(item.itemId),
	});
	expect(p["forgetPreview"]).toBeDefined();
	const params = {
		planId: p["planId"],
		epoch: p["epoch"],
		operationId: "pending-copy",
	};
	const pending = await h.call("apply", params);
	expect(pending.status).toBe("pending");
	const config = h.configuration();
	config.credentials[h.profile.credential]!.forgetAll = false;
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(
		await h.call("operation", {
			operationId: "pending-copy",
			epoch: h.host.epoch,
		}),
	).toEqual({ status: "blocked", code: "FORGET_REQUIRES_ALL_SCOPES" });
	config.credentials[h.profile.credential]!.forgetAll = true;
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(
		(await h.call("read", { sourceHandle: saved.source["sourceHandle"] }))
			.status,
	).toBe("found");
	for (const forgetId of pending["forgetIds"] as string[])
		await h.owner.port.write((db) => {
			recordExternalDeletion(db, {
				contractVersion: 2,
				access: h.host.access(
					h.configuration().credentials[h.profile.credential]!,
				),
				forgetId,
				providerRef: "test-provider",
				externalId: "copy-1",
				state: "confirmed",
				clock: { atMs: h.host.clock() },
			});
		});
	expect((await h.call("apply", params)).status).toBe("completed");
});
test("R06 incomplete snapshot cannot authorize a semantic forget", async () => {
	const h = await fixture();
	await remember(h, "水が好き");
	const c = await h.call("context");
	const item = (c["items"] as StateItem[])[0]!;
	const grant = h.configuration().credentials[h.profile.credential]!;
	const partial = h.host.snapshots.create(
		Array.from({ length: HOST_LIMITS.snapshotItems + 1 }, (_, i) => ({
			...item,
			itemId: `item-${i}`,
		})),
		["personal"],
		grant,
		h.host.policy,
	);
	expect(partial.complete).toBe(false);
	expect(
		await h.call("plan", {
			snapshotId: partial.id,
			scopeKey: "personal",
			proposal: forgetProposal("item-0"),
		}),
	).toMatchObject({ code: "COMPLETE_SNAPSHOT_REQUIRED" });
});
test("R11 a durable complete intent finishes history beyond one journal batch after a crash", async () => {
	const h = await fixture();
	let item: { itemId: string } | undefined;
	for (let i = 0; i < 66; i++) {
		const r = await remember(h, `第${i}版の好み`, item);
		expect(r.result.status).toBe("completed");
		item = ((await h.call("context"))["items"] as StateItem[])[0]!;
		h.advance(40000);
	}
	const c = await h.call("context");
	const p = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: forgetProposal(item!.itemId),
	});
	expect(p.status).toBe("planned");
	h.host.options.afterJournalAppend = () => {
		throw Error("crash between batches");
	};
	expect(
		(
			await h.call("apply", {
				planId: p["planId"],
				epoch: p["epoch"],
				operationId: "long-history",
			})
		).status,
	).not.toBe("completed");
	const recovered = new MemoryHost({
		port: h.owner.port,
		configuration: h.configuration,
	});
	await recovered.start();
	expect(
		(await recovered.dispatch(h.profile.credential, "context", {}))["items"],
	).toEqual([]);
	expect(
		readFileSync(join(h.dir, "forget.jsonl"), "utf8").trim().split("\n").length,
	).toBeGreaterThan(1);
}, 20000);
test("R11 forgetting a registered Record erases its library body and host copy", async () => {
	const h = await fixture();
	const source = await h.call("source", {
		submissionId: "record",
		scopeKey: "personal",
		kind: "record",
		content: "使い捨ての資料原文",
	});
	expect(source.status).toBe("registered");
	const ref = source["source"] as { id: string; revision: string };
	const c = await h.call("context");
	const p = await h.call("plan", {
		snapshotId: c["snapshotId"],
		scopeKey: "personal",
		proposal: {
			decision: { clarification: null, actions: [] },
			relations: [],
			groups: [],
		},
		sourceHandles: [source["sourceHandle"]],
	});
	expect(p.status).toBe("planned");
	expect(
		(
			await h.call("apply", {
				planId: p["planId"],
				epoch: p["epoch"],
				operationId: "forget-record",
			})
		).status,
	).toBe("completed");
	const record = h.owner.port.read((db) =>
		readRecord(db, {
			contractVersion: 1,
			access: h.host.access(
				h.configuration().credentials[h.profile.credential]!,
			),
			scopeKey: "personal",
			recordId: ref.id,
			revision: ref.revision,
		}),
	);
	expect(record.status).toBe("forgotten");
	expect(
		await h.call("read", { sourceHandle: source["sourceHandle"] }),
	).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
});
test("unused source TTL erases a Record through the journal, while adopted evidence stays readable", async () => {
	const h = await fixture();
	const adopted = await remember(h, "水が好き");
	const source = await h.call("source", {
		submissionId: "expire-record",
		scopeKey: "personal",
		kind: "record",
		content: "未採用の資料",
	});
	const ref = source["source"] as { id: string; revision: string };
	h.advance(HOST_LIMITS.sourceTtlMs + 1);
	expect(
		(
			await h.call("source", {
				submissionId: "trigger-retention",
				scopeKey: "personal",
				content: "新しい未採用出典",
			})
		).status,
	).toBe("registered");
	const record = h.owner.port.read((db) =>
		readRecord(db, {
			contractVersion: 1,
			access: h.host.access(
				h.configuration().credentials[h.profile.credential]!,
			),
			scopeKey: "personal",
			recordId: ref.id,
			revision: ref.revision,
		}),
	);
	expect(record.status).toBe("forgotten");
	const ctx = await h.call("context");
	const item = (ctx["items"] as StateItem[])[0]!;
	const read = await h.call("read", {
		snapshotId: ctx["snapshotId"],
		itemId: item.itemId,
	});
	expect(read.status).toBe("found");
	expect((read["sources"] as { status: string }[])[0]!.status).toBe(
		"registered",
	);
	expect(adopted.result.status).toBe("completed");
	expect(readFileSync(join(h.dir, "forget.jsonl"), "utf8")).not.toContain(
		"未採用の資料",
	);
});
test("partial context permits displayed-item reads while withholding broad semantic changes", async () => {
	const h = await fixture();
	await remember(h, "水が好き");
	const c = await h.call("context");
	const item = (c["items"] as StateItem[])[0]!;
	const grant = h.configuration().credentials[h.profile.credential]!;
	const partial = h.host.snapshots.create(
		[
			item,
			...Array.from({ length: HOST_LIMITS.snapshotItems }, (_, i) => ({
				...item,
				itemId: `partial-${i}`,
			})),
		],
		["personal"],
		grant,
		h.host.policy,
		(items) => h.owner.port.read((db) => h.host.fingerprint(db, items)),
	);
	expect(
		(await h.call("read", { snapshotId: partial.id, itemId: item.itemId }))
			.status,
	).toBe("found");
	expect(await h.call("read", { snapshotId: partial.id })).toMatchObject({
		code: "COMPLETE_SNAPSHOT_REQUIRED",
	});
});
test("application source revisions invalidate snapshots even if State itself has not changed", async () => {
	const h = await fixture();
	const assertion = seededAssertion(h, "self", "preference", "user_confirmed");
	let source = assertion.sources[0]!;
	h.host.options.resolveSource = () => source;
	await h.owner.port.write((db) => assertUserState(db, assertion));
	const c = await h.call("context");
	expect((await h.call("read", { snapshotId: c["snapshotId"] })).status).toBe(
		"found",
	);
	source = {
		...source,
		revision: "changed",
		digest: createHash("sha256").update("別の発言").digest("hex"),
		content: "別の発言",
	};
	expect(await h.call("read", { snapshotId: c["snapshotId"] })).toMatchObject({
		status: "stale",
		code: "SNAPSHOT_STALE",
	});
	const fresh = await h.call("context");
	const item = (fresh["items"] as StateItem[])[0]!;
	const read = await h.call("read", {
		snapshotId: fresh["snapshotId"],
		itemId: item.itemId,
	});
	expect(read["sources"]).toEqual([{ status: "stale" }]);
});
test("an application-initiated Record forget also erases the host source alias", async () => {
	const h = await fixture();
	const source = await h.call("source", {
		submissionId: "external-record-forget",
		scopeKey: "personal",
		kind: "record",
		content: "他経路から削除する資料",
	});
	expect(source.status).toBe("registered");
	const ref = source["source"] as { id: string };
	await h.owner.port.write((db) => {
		const plan = planForget(db, {
			contractVersion: 2,
			access: h.host.access(
				h.configuration().credentials[h.profile.credential]!,
			),
			targets: [{ type: "record", scopeKey: "personal", recordId: ref.id }],
			clock: { atMs: h.host.clock() },
		});
		if (plan.status !== "planned") throw Error("forget rejected");
		h.owner.port.journal.append(plan.plan.entry);
		const applied = applyForget(db, {
			contractVersion: 2,
			entry: plan.plan.entry,
			clock: { atMs: h.host.clock() },
		});
		expect(applied.local).toBe("applied");
		h.host.invalidateDerivedInTransaction(db, {
			scopeKeys: ["personal"],
			itemIds: [],
			forgetIds: [plan.plan.entry.forgetId],
		});
	});
	expect(
		await h.call("read", { sourceHandle: source["sourceHandle"] }),
	).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
	expect(
		h.owner.port.read(
			(db) =>
				(
					db
						.query("SELECT content FROM host_source WHERE submission_id=?")
						.get("external-record-forget") as { content: string | null }
				).content,
		),
	).toBeNull();
});
