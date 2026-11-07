import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialize } from "../src/storage.ts";
import { startStandalone, request } from "../src/transport.ts";

test("R09 owner SIGKILL after journal fsync releases ownership and recovers before ready", async () => {
	const dir = mkdtempSync(join(tmpdir(), "em-kill-"));
	const profile = initialize(dir);
	let owner = await startStandalone(dir);
	try {
		const text = "検証用の好み";
		const source = await request(profile, "source", {
			submissionId: "before-crash",
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
							semanticKey: "crash-fact",
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
		expect(
			(
				await request(profile, "apply", {
					planId: p["planId"],
					epoch: p["epoch"],
					operationId: "pre-crash-save",
				})
			).status,
		).toBe("completed");
		await owner.close();
		const program = join(dir, "crash.ts");
		writeFileSync(
			program,
			`import {openStandalone} from ${JSON.stringify(new URL("../src/storage.ts", import.meta.url).href)};
import {MemoryHost} from ${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)};
const dir=${JSON.stringify(dir)};const config=await Bun.file(dir+"/owner.json").json();const credential=${JSON.stringify(profile.credential)};const owner=openStandalone(dir);const host=new MemoryHost({port:owner.port,configuration:()=>config,afterJournalAppend:()=>process.kill(process.pid,"SIGKILL")});await host.start();const c=await host.dispatch(credential,"context",{});const id=c.items[0].itemId;const p=await host.dispatch(credential,"plan",{snapshotId:c.snapshotId,scopeKey:"personal",proposal:{decision:{clarification:null,actions:[{type:"forget",itemId:id}]},relations:[{actionIndex:0,relation:"forget",relatedItemIds:[id]}],groups:[[0]]}});if(p.status!=="planned")throw Error("plan failed");await host.dispatch(credential,"apply",{planId:p.planId,epoch:host.epoch,operationId:"kill-forget"});throw Error("kill hook was not reached");`,
		);
		const child = Bun.spawn([process.execPath, program], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		await child.exited;
		expect(child.signalCode).toBe("SIGKILL");
		expect(
			readFileSync(join(dir, "forget.jsonl"), "utf8").trim().length,
		).toBeGreaterThan(0);
		owner = await startStandalone(dir);
		expect((await request(profile, "context", {}))["items"]).toEqual([]);
		expect((await request(profile, "status", {})).status).toBe("ready");
	} finally {
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 15000);
