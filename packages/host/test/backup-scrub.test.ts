/** S4（§4C.4）: 忘却の後のバックアップの洗い直しと、失敗したときの上限。 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	BACKUP_GENERATIONS,
	BACKUP_RETENTION_MS,
	listBackups,
	sha256File,
} from "../src/backup.ts";
import { restoreStore } from "../src/transport.ts";
import {
	fixture,
	forget,
	items,
	leakedTrigrams,
	remember,
	type Fixture,
} from "./support.ts";

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
	// 7 日を過ぎると、失敗の印のあるバックアップは必ず消える。
	h.advance(BACKUP_RETENTION_MS + 1);
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
