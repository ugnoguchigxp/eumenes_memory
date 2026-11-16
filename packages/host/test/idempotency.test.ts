/** S2（§4A、決定 8）: 操作の受領記録の保持と、再送しても二重に書かないこと。 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_LIMITS } from "../src/contracts.ts";
import {
	disposeFixtures,
	DAY_MS,
	fixture,
	items,
	plan,
	remember,
	type Fixture,
} from "./support.ts";

afterEach(disposeFixtures);

function counts(h: Fixture) {
	return h.owner.port.read((db) => ({
		items: (
			db.query("SELECT count(*) AS n FROM memory_state_item").get() as {
				n: number;
			}
		).n,
		events: (
			db.query("SELECT count(*) AS n FROM memory_state_event").get() as {
				n: number;
			}
		).n,
		revisions: (
			db
				.query("SELECT coalesce(sum(revision),0) AS n FROM memory_state_item")
				.get() as {
				n: number;
			}
		).n,
	}));
}

test("T-IDEM-1 duplicate apply after a lost response returns the stored result and writes once", async () => {
	const h = await fixture();
	const { planned } = await plan(h, "コーヒーが好きです");
	const params = {
		planId: planned["planId"],
		epoch: planned["epoch"],
		operationId: "lost-response",
	};
	// 応答を捨てる（呼び出し側には届かなかったものとする）。
	void (await h.call("apply", params));
	const before = counts(h);
	const second = await h.call("apply", params);
	expect(second.status).toBe("completed");
	expect(await h.call("apply", params)).toEqual(second);
	expect(counts(h)).toEqual(before);
	expect(before.items).toBe(1);
});

/** 子プロセスで所有者を動かし、指定の commit の直後に SIGKILL する。 */
async function crashChild(h: Fixture, killAfter: "admission" | "state") {
	await h.close();
	const program = join(h.dir, `crash-${killAfter}.ts`);
	writeFileSync(
		program,
		`import {openStandalone} from ${JSON.stringify(new URL("../src/storage.ts", import.meta.url).href)};
import {MemoryHost} from ${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)};
const dir=${JSON.stringify(h.dir)};const config=await Bun.file(dir+"/owner.json").json();const credential=${JSON.stringify(h.profile.credential)};
const owner=openStandalone(dir);const write=owner.port.write;let armed=false;
const count=(db,t)=>db.query("SELECT count(*) AS n FROM "+t).get().n;
owner.port.write=async(fn)=>{let changed=false;const r=await write((db)=>{const t=${JSON.stringify(killAfter === "admission" ? "host_operation" : "memory_state_item")};const b=count(db,t);const v=fn(db);changed=count(db,t)>b;return v;});if(armed&&changed)process.kill(process.pid,"SIGKILL");return r;};
const host=new MemoryHost({port:owner.port,configuration:()=>config});await host.start();
const text="再送の確認";
const c=await host.dispatch(credential,"context",{});
const s=await host.dispatch(credential,"source",{submissionId:"crash-src",scopeKey:"personal",content:text});
const p=await host.dispatch(credential,"plan",{snapshotId:c.snapshotId,scopeKey:"personal",proposal:{decision:{clarification:null,actions:[{type:"remember",subject:"self",kind:"preference",semanticKey:"crash",value:{text,polarity:"affirmed"},quote:text,replacesItemId:null}]},relations:[{actionIndex:0,relation:"new",relatedItemIds:[]}],groups:[[0]]},evidence:[{actionIndex:0,sourceHandle:s.sourceHandle,startByte:0,endByte:Buffer.byteLength(text)}]});
if(p.status!=="planned")throw Error("plan failed "+JSON.stringify(p));
console.log(JSON.stringify({planId:p.planId,epoch:p.epoch}));
armed=true;await host.dispatch(credential,"apply",{planId:p.planId,epoch:p.epoch,operationId:"crash-op"});throw Error("kill hook was not reached");`,
	);
	const child = Bun.spawn([process.execPath, program], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(child.stdout).text();
	await child.exited;
	expect(child.signalCode).toBe("SIGKILL");
	const params = JSON.parse(out.trim().split("\n")[0]!) as {
		planId: string;
		epoch: string;
	};
	return { ...params, operationId: "crash-op" };
}

test("T-IDEM-2 crash between commit and response: the stored result is returned and nothing is written twice", async () => {
	const h = await fixture();
	const params = await crashChild(h, "state");
	await h.reopen();
	const before = counts(h);
	expect(before.items).toBe(1);
	const applied = await h.call("apply", params);
	expect(applied.status).toBe("completed");
	expect(
		await h.call("operation", {
			operationId: params.operationId,
			epoch: params.epoch,
		}),
	).toMatchObject({
		status: "completed",
	});
	expect(counts(h)).toEqual(before);
}, 15000);

test("T-IDEM-2b crash after admission before the first group resumes the remaining group once", async () => {
	const h = await fixture();
	const params = await crashChild(h, "admission");
	await h.reopen();
	expect(counts(h).items).toBe(0);
	expect((await h.call("apply", params)).status).toBe("completed");
	const after = counts(h);
	expect(after.items).toBe(1);
	expect((await h.call("apply", params)).status).toBe("completed");
	expect(counts(h)).toEqual(after);
}, 15000);

test("T-IDEM-2b with an expired payload the admitted operation is indeterminate and never runs", async () => {
	const h = await fixture();
	const params = await crashChild(h, "admission");
	h.advance(HOST_LIMITS.payloadTtlMs + 60000);
	await h.reopen();
	expect(await h.call("apply", params)).toMatchObject({
		status: "indeterminate",
		code: "EXECUTION_PAYLOAD_EXPIRED",
	});
	expect(counts(h).items).toBe(0);
}, 15000);

test("T-IDEM-3 expired operationId of an old epoch is indeterminate and not re-executed", async () => {
	const h = await fixture();
	const saved = await remember(h, "コーヒーが好きです");
	expect(saved.result.status).toBe("completed");
	h.advance(HOST_LIMITS.receiptTtlMs + 1);
	await h.restart();
	const before = counts(h);
	expect(await h.call("apply", saved.params)).toMatchObject({
		status: "indeterminate",
		code: "OPERATION_NOT_RECORDED",
	});
	expect(counts(h)).toEqual(before);
});

test("T-IDEM-3b expired operationId of the same epoch is indeterminate, records the horizon and is not re-executed", async () => {
	const h = await fixture();
	const saved = await remember(h, "コーヒーが好きです");
	h.advance(30 * DAY_MS + 1);
	const before = counts(h);
	expect(await h.call("apply", saved.params)).toMatchObject({
		status: "indeterminate",
		code: "OPERATION_RECEIPT_EXPIRED",
	});
	expect(
		await h.call("operation", {
			operationId: saved.params.operationId,
			epoch: saved.params.epoch,
		}),
	).toMatchObject({
		status: "indeterminate",
		code: "OPERATION_RECEIPT_EXPIRED",
	});
	expect(counts(h)).toEqual(before);
	const horizon = h.owner.port.read((db) =>
		db.query("SELECT epoch,pruned_before FROM host_operation_horizon").all(),
	);
	expect(horizon).toEqual([
		{ epoch: h.host.epoch, pruned_before: h.clock.now - 30 * DAY_MS },
	]);
	// 記録を消す前の、記録の無い今の epoch の ID は従来どおり blocked だった（消した後は indeterminate）。
	expect(
		await h.call("operation", {
			operationId: "never-sent",
			epoch: h.host.epoch,
		}),
	).toMatchObject({
		status: "indeterminate",
		code: "OPERATION_RECEIPT_EXPIRED",
	});
});

test("T-IDEM-3b before any pruning a missing same-epoch ID stays blocked", async () => {
	const h = await fixture();
	expect(
		await h.call("operation", {
			operationId: "never-sent",
			epoch: h.host.epoch,
		}),
	).toMatchObject({ status: "blocked", code: "OPERATION_NOT_RECORDED" });
});

test("T-IDEM-3c capacity recovers after same-epoch pruning", async () => {
	const h = await fixture({ host: { limits: { operationsPerEpoch: 2 } } });
	await remember(h, "一つ目の好み", undefined, { semanticKey: "a" });
	await remember(h, "二つ目の好み", undefined, { semanticKey: "b" });
	const { planned } = await plan(h, "三つ目の好み", undefined, {
		semanticKey: "c",
	});
	expect(
		await h.call("apply", {
			planId: planned["planId"],
			epoch: planned["epoch"],
			operationId: "over-capacity",
		}),
	).toMatchObject({ status: "blocked", code: "OPERATION_CAPACITY" });
	h.advance(30 * DAY_MS + 1);
	const again = await remember(h, "三つ目の好み", undefined, {
		semanticKey: "c",
	});
	expect(again.result.status).toBe("completed");
});

test("T-IDEM-4 the same plan with a new operationId is not executed twice", async () => {
	const h = await fixture();
	const saved = await remember(h, "コーヒーが好きです");
	const before = counts(h);
	const result = await h.call("apply", {
		...saved.params,
		operationId: "another-id",
	});
	expect(["SNAPSHOT_STALE", "PLAN_UNAVAILABLE"]).toContain(
		result.code as string,
	);
	expect(["stale", "blocked"]).toContain(result.status);
	expect(counts(h)).toEqual(before);
});

test("T-IDEM-5 concurrent duplicate apply executes once and both calls see the same result", async () => {
	const h = await fixture();
	const { planned } = await plan(h, "コーヒーが好きです");
	const params = {
		planId: planned["planId"],
		epoch: planned["epoch"],
		operationId: "concurrent",
	};
	const [a, b] = await Promise.all([
		h.call("apply", params),
		h.call("apply", params),
	]);
	expect(a.status).toBe("completed");
	expect(b).toEqual(a);
	expect(counts(h).items).toBe(1);
	expect((await items(h)).length).toBe(1);
});
