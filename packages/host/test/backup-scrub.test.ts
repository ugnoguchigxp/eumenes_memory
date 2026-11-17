/** S4（§4C.4）: 忘却の後のバックアップの洗い直しと、失敗したときの上限。 */
import { afterEach, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	BACKUP_GENERATIONS,
	BACKUP_RETENTION_MS,
	listBackups,
	sha256File,
	writeMeta,
} from "../src/backup.ts";
import { restoreStore } from "../src/transport.ts";
import {
	disposeFixtures,
	fixture,
	forget,
	items,
	leakedTrigrams,
	remember,
	type Fixture,
} from "./support.ts";

afterEach(disposeFixtures);

const SECRET = "ZQXWVU秘密の好み";

async function backup(h: Fixture) {
	const result = await h.call("backup");
	expect(result.status).toBe("completed");
	return result as unknown as { path: string; sha256: string };
}

test("T-BAK-5 scrub removes forgotten text from older backups and renews the sha256", async () => {
	const h = await fixture();
	const saved = await remember(h, SECRET);
	await remember(h, "残す記憶です", undefined, { semanticKey: "keep" });
	const old = await backup(h);
	expect(leakedTrigrams(SECRET, [old.path]).length).toBeGreaterThan(0);
	const target = (await items(h)).find((x) => x["semanticKey"] === "drink")!;
	await forget(h, target.itemId, [saved.source["sourceHandle"]]);
	await h.host.backupIdle();
	expect(leakedTrigrams(SECRET, [old.path])).toEqual([]);
	const [meta] = listBackups(join(h.dir, "backups"));
	expect(meta!.sha256).not.toBe(old.sha256);
	expect(meta!.sha256).toBe(sha256File(old.path));
	expect(meta!.scrubPending).toBe(false);
	expect(await h.call("status")).toMatchObject({ backupScrubPending: false });
	// 洗い直したバックアップからも、ジャーナルの照合を通って復元できる。
	await h.close();
	expect((await restoreStore(old.path, h.dir, () => h.clock.now)).status).toBe(
		"completed",
	);
	await h.reopen();
	expect((await items(h)).map((x) => x["semanticKey"])).toEqual(["keep"]);
});

test("T-BAK-6 a failed scrub is marked pending and bounded by generations and seven days", async () => {
	const fail = { on: true };
	const h = await fixture({
		host: {
			beforeBackupScrub: () => {
				if (fail.on) throw new Error("scrub failure for test");
			},
		},
	});
	const saved = await remember(h, SECRET);
	const old = await backup(h);
	await forget(h, (await items(h))[0]!.itemId, [saved.source["sourceHandle"]]);
	await h.host.backupIdle();
	expect(await h.call("status")).toMatchObject({ backupScrubPending: true });
	expect(leakedTrigrams(SECRET, [old.path]).length).toBeGreaterThan(0);
	// Metadata write can fail too. The journal position must still drive retention.
	const directory = join(h.dir, "backups");
	const [stale] = listBackups(directory);
	writeMeta(directory, { ...stale!, scrubPending: false });
	expect(await h.call("status")).toMatchObject({ backupScrubPending: true });
	h.advance(BACKUP_RETENTION_MS);
	await backup(h);
	expect(listBackups(join(h.dir, "backups")).map((m) => m.file)).not.toContain(
		old.path.split("/").at(-1),
	);
	expect(await h.call("status")).toMatchObject({ backupScrubPending: false });
	// 世代の上限でも消える。
	fail.on = true;
	const second = await remember(h, "別の秘密ZQXWVU二つ目", undefined, {
		semanticKey: "two",
	});
	const pending = await backup(h);
	await forget(h, (await items(h))[0]!.itemId, [second.source["sourceHandle"]]);
	await h.host.backupIdle();
	expect(await h.call("status")).toMatchObject({ backupScrubPending: true });
	for (let i = 0; i < BACKUP_GENERATIONS; i++) {
		h.advance(1000);
		await backup(h);
	}
	expect(listBackups(join(h.dir, "backups")).map((m) => m.file)).not.toContain(
		pending.path.split("/").at(-1),
	);
	expect(await h.call("status")).toMatchObject({ backupScrubPending: false });
});

test.each(["before", "after"] as const)(
	"restart completes a scrub interrupted %s replacing the backup",
	async (when) => {
		let defer = true;
		const h = await fixture({
			host: {
				beforeBackupScrub: () => {
					if (defer) throw Error("defer scrub");
				},
			},
		});
		const saved = await remember(h, SECRET);
		const target = (await items(h))[0]!;
		await remember(h, "保持する記憶", undefined, { semanticKey: "keep" });
		const old = await backup(h);
		await forget(h, target.itemId, [saved.source["sourceHandle"]]);
		await h.host.backupIdle();
		await h.close();

		const script = join(h.dir, "interrupt-scrub.test.ts");
		writeFileSync(
			script,
			`
			import { test, spyOn } from "bun:test";
			import * as fs from "node:fs";
			const original = fs.renameSync;
			spyOn(fs, "renameSync").mockImplementation((from, to) => {
				const publishing = String(to).endsWith(${JSON.stringify("/" + basename(old.path))}) && String(from).endsWith("/fresh.db");
				if (publishing && ${when === "before"}) process.kill(process.pid, "SIGKILL");
				original(from, to);
				if (publishing && ${when === "after"}) process.kill(process.pid, "SIGKILL");
			});
			const { startStandalone } = await import(${JSON.stringify(new URL("../src/transport.ts", import.meta.url).href)});
			test("interrupt scrub", async () => {
				const owner = await startStandalone(${JSON.stringify(h.dir)});
				await owner.host.backupIdle();
				throw Error("scrub did not reach the interruption");
			});
		`,
		);
		const child = Bun.spawnSync([process.execPath, "test", script]);
		if (!child.signalCode) throw Error(child.stderr.toString());
		expect(child.signalCode).toBe("SIGKILL");
		const directory = join(h.dir, "backups");
		expect(listBackups(directory)[0]?.scrubPending).toBe(true);
		expect(
			readdirSync(directory).some((name) => name.startsWith(".scrub-")),
		).toBe(true);
		defer = false;
		await h.reopen();
		await h.host.backupIdle();
		expect(listBackups(directory)[0]).toMatchObject({
			scrubPending: false,
			sha256: sha256File(old.path),
		});
		expect(
			readdirSync(directory).some((name) => name.startsWith(".scrub-")),
		).toBe(false);
		expect(leakedTrigrams(SECRET, [old.path])).toEqual([]);
		expect((await items(h)).map((item) => item["semanticKey"])).toEqual([
			"keep",
		]);
	},
);
