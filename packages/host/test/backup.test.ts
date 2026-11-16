/** S3（§4C、決定 10）: VACUUM INTO のバックアップと、ジャーナルを優先する復元。 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	BACKUP_GENERATIONS,
	DEFAULT_BACKUP_DIRECTORY,
	DEFAULT_DATA_DIRECTORY,
	defaultBackupDirectory,
	listBackups,
	sha256File,
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
	return result as {
		status: string;
		path: string;
		sha256: string;
		journalHead: { seq: number };
	};
}
function readBackup<T>(path: string, fn: (db: Database) => T): T {
	const db = new Database(path, { readonly: true });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

test("T-BAK-1 vacuum into is consistent with committed rows still in the WAL", async () => {
	const h = await fixture();
	for (const [i, text] of ["一つ目", "二つ目", "三つ目"].entries())
		await remember(h, `${text}の好み`, undefined, { semanticKey: `k${i}` });
	expect(statSync(join(h.dir, "memory.db-wal")).size).toBeGreaterThan(0);
	const result = await backup(h);
	readBackup(result.path, (db) => {
		expect(
			(
				db
					.query(
						"SELECT count(*) AS n FROM memory_state_item WHERE status='active'",
					)
					.get() as {
					n: number;
				}
			).n,
		).toBe(3);
		expect(db.query("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});
		expect(db.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "delete",
		});
	});
});

test("T-BAK-2 a backup taken right after a forget (before checkpoint) excludes the forgotten text", async () => {
	const h = await fixture({
		wrapPort: (port) => ({ ...port, checkpoint: async () => false }),
	});
	const saved = await remember(h, SECRET);
	const target = (await items(h))[0]!;
	expect(
		(await forget(h, target.itemId, [saved.source["sourceHandle"]])).status,
	).toBe("completed");
	expect(
		leakedTrigrams(SECRET, [join(h.dir, "memory.db-wal")]).length,
	).toBeGreaterThan(0);
	const result = await backup(h);
	expect(leakedTrigrams(SECRET, [result.path])).toEqual([]);
});

test("T-BAK-3 restore round trip returns the State of the backup time", async () => {
	const h = await fixture();
	await remember(h, "コーヒーが好きです");
	const before = await items(h);
	const result = await backup(h);
	await remember(h, "犬が好きです", undefined, { semanticKey: "pet" });
	expect(await items(h)).toHaveLength(2);
	await h.close();
	const restored = await restoreStore(result.path, h.dir, () => h.clock.now);
	expect(restored).toMatchObject({ status: "completed", started: true });
	await h.reopen();
	expect((await items(h)).map((x) => x.itemId)).toEqual(
		before.map((x) => x.itemId),
	);
});

test("T-BAK-4 restore reapplies forgets made after the backup", async () => {
	const h = await fixture();
	const saved = await remember(h, SECRET);
	const target = (await items(h))[0]!;
	const result = await backup(h);
	expect(leakedTrigrams(SECRET, [result.path]).length).toBeGreaterThan(0);
	await forget(h, target.itemId, [saved.source["sourceHandle"]]);
	await h.close();
	expect(
		(await restoreStore(result.path, h.dir, () => h.clock.now)).status,
	).toBe("completed");
	await h.reopen();
	expect(await items(h)).toEqual([]);
	expect(
		leakedTrigrams(
			SECRET,
			["memory.db", "memory.db-wal"].map((n) => join(h.dir, n)),
		),
	).toEqual([]);
});

test("T-BAK-7 restore refuses a journal older than the backup", async () => {
	const h = await fixture();
	const saved = await remember(h, SECRET);
	await forget(h, (await items(h))[0]!.itemId, [saved.source["sourceHandle"]]);
	const result = await backup(h);
	expect(result.journalHead.seq).toBeGreaterThan(0);
	await h.close();
	writeFileSync(join(h.dir, "forget.jsonl"), "");
	const before = statSync(join(h.dir, "memory.db")).mtimeMs;
	expect(await restoreStore(result.path, h.dir)).toMatchObject({
		status: "blocked",
		code: "JOURNAL_OLDER_THAN_BACKUP",
	});
	expect(statSync(join(h.dir, "memory.db")).mtimeMs).toBe(before);
	expect(readdirSync(h.dir).some((n) => n.startsWith("restore-"))).toBe(false);
});

test.each(["missing", "truncated", "corrupt"] as const)(
	"restore keeps the current DB when a pre-forget backup has a %s live journal",
	async (fault) => {
		const h = await fixture({
			host: {
				beforeBackupScrub: () => {
					throw Error("scrub unavailable");
				},
			},
		});
		const saved = await remember(h, SECRET);
		const result = await backup(h);
		const item = (await items(h))[0]!;
		await forget(h, item.itemId, [saved.source["sourceHandle"]]);
		await h.host.backupIdle();
		expect(await items(h)).toEqual([]);
		await h.close();
		const journal = join(h.dir, "forget.jsonl");
		const db = join(h.dir, "memory.db");
		const priorDb = readFileSync(db);
		const original = readFileSync(journal);
		if (fault === "missing")
			renameSync(journal, join(h.dir, "protected-journal"));
		else writeFileSync(journal, fault === "truncated" ? "" : "{broken");
		expect(
			await restoreStore(result.path, h.dir, () => h.clock.now),
		).toMatchObject({
			status: "blocked",
			code:
				fault === "missing"
					? "JOURNAL_MISSING"
					: fault === "truncated"
						? "JOURNAL_OLDER_THAN_STORE"
						: "JOURNAL_INVALID",
		});
		expect(readFileSync(db)).toEqual(priorDb);
		expect(readdirSync(h.dir).some((name) => name.startsWith("restore-"))).toBe(
			false,
		);
		if (fault === "missing") expect(existsSync(journal)).toBe(false);
		writeFileSync(journal, original);
		await h.reopen();
		expect(await items(h)).toEqual([]);
	},
);

test("a checksum-valid backup with an incompatible host schema leaves the live DB in place", async () => {
	const h = await fixture();
	await remember(h, "復元対象の記憶");
	const copied = await backup(h);
	await remember(h, "残しておく現在の記憶", undefined, {
		semanticKey: "current",
	});
	await h.close();

	const candidate = new Database(copied.path);
	try {
		candidate.exec("UPDATE host_schema SET version=999");
	} finally {
		candidate.close();
	}
	const path = copied.path.replace(/\.db$/, ".json");
	const meta = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(
		path,
		JSON.stringify({ ...meta, sha256: sha256File(copied.path) }),
	);
	const live = join(h.dir, "memory.db");
	const original = readFileSync(live);

	expect(await restoreStore(copied.path, h.dir)).toMatchObject({
		status: "blocked",
		code: "HOST_SCHEMA_MISMATCH",
	});
	expect(readFileSync(live)).toEqual(original);
	expect(
		readdirSync(h.dir).some(
			(name) => name.startsWith("restore-") || name.startsWith(".restore-"),
		),
	).toBe(false);
	await h.reopen();
	expect(await items(h)).toHaveLength(2);
});

test.each(["before", "after"] as const)(
	"owner crash %s publishing a restore leaves a startable store that still forgets",
	async (when) => {
		const h = await fixture();
		const saved = await remember(h, SECRET);
		const original = (await items(h))[0]!;
		const copied = await backup(h);
		await forget(h, original.itemId, [saved.source["sourceHandle"]]);
		await h.host.backupIdle();
		await remember(h, "復元前の追加記憶");
		await h.close();
		const journal = readFileSync(join(h.dir, "forget.jsonl"));
		const target = realpathSync(h.dir);
		const testModule = join(h.dir, "interrupt-restore.test.ts");
		const script = `
			import { test, spyOn } from "bun:test";
			import * as fs from "node:fs";
			const original = fs.renameSync;
			const destination = ${JSON.stringify(join(target, "memory.db"))};
			spyOn(fs, "renameSync").mockImplementation((from, to) => {
				if (to === destination && ${when === "before"}) process.kill(process.pid, "SIGKILL");
				original(from, to);
				if (to === destination && ${when === "after"}) process.kill(process.pid, "SIGKILL");
			});
			const { restoreStore } = await import(${JSON.stringify(new URL("../src/transport.ts", import.meta.url).href)});
			test("interrupt at publish", async () => {
				const result = await restoreStore(${JSON.stringify(copied.path)}, ${JSON.stringify(target)}, () => ${h.clock.now});
				throw Error("restore did not reach publication: " + JSON.stringify(result));
			});
		`;
		writeFileSync(testModule, script);
		const child = Bun.spawn([process.execPath, "test", testModule], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [out, diagnostics] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (child.signalCode !== "SIGKILL") throw Error(out + diagnostics);
		expect(readFileSync(join(h.dir, "forget.jsonl"))).toEqual(journal);
		await h.reopen();
		const surviving = await items(h);
		expect(surviving.some((item) => item.itemId === original.itemId)).toBe(
			false,
		);
		expect(surviving).toHaveLength(when === "before" ? 1 : 0);
	},
	15000,
);

test("restore twice at the same time keeps both evacuations and leaves no staged copy", async () => {
	const h = await fixture();
	await remember(h, "コーヒーが好きです");
	const result = await backup(h);
	await h.close();
	for (let i = 0; i < 2; i++)
		expect(
			(await restoreStore(result.path, h.dir, () => h.clock.now)).status,
		).toBe("completed");
	const names = readdirSync(h.dir);
	expect(names.filter((n) => n.startsWith("restore-"))).toHaveLength(2);
	expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
	await h.reopen();
	expect(await items(h)).toHaveLength(1);
});

test("a backup run removes leftovers of interrupted backups and scrubs, and ignores malformed records", async () => {
	const h = await fixture();
	await remember(h, "コーヒーが好きです");
	await backup(h);
	const directory = join(h.dir, "backups");
	const base = "memory-20260101T000000Z-deadbeef";
	const leftovers = [
		`${base}.db`,
		`${base}.forget.jsonl`,
		`${base}.db.tmp`,
		"memory-20260101T000000Z-cafebabe.json.tmp",
	];
	for (const name of leftovers) writeFileSync(join(directory, name), SECRET);
	mkdirSync(join(directory, ".scrub-abc123"));
	writeFileSync(join(directory, ".scrub-abc123", "memory.db"), SECRET);
	// 置き場所の外を指す記録は、一覧に載せず、指す先にも触れない。
	writeFileSync(
		join(directory, "memory-20260101T000000Z-0badf00d.json"),
		JSON.stringify({
			version: 1,
			file: "../memory.db",
			journalFile: "../forget.jsonl",
			createdAt: 0,
		}),
	);
	writeFileSync(join(directory, "notes.txt"), "利用者のメモ");
	expect(listBackups(directory)).toHaveLength(1);
	await backup(h);
	const names = readdirSync(directory).sort();
	for (const name of [...leftovers, ".scrub-abc123"])
		expect(names).not.toContain(name);
	expect(names).not.toContain("memory-20260101T000000Z-0badf00d.json");
	expect(names).toContain("notes.txt");
	expect(listBackups(directory)).toHaveLength(2);
	expect(existsSync(join(h.dir, "memory.db"))).toBe(true);
	expect(existsSync(join(h.dir, "forget.jsonl"))).toBe(true);
	expect(
		leakedTrigrams(
			SECRET,
			names.map((n) => join(directory, n)),
		),
	).toEqual([]);
});

test("T-BAK-8 restore refuses while the server is running", async () => {
	const h = await fixture();
	await remember(h, "コーヒーが好きです");
	const result = await backup(h);
	expect(await restoreStore(result.path, h.dir)).toMatchObject({
		status: "blocked",
		code: "OWNER_ALREADY_RUNNING",
	});
});

test("T-BAK-9 backup location is outside /workspace with private permissions", async () => {
	for (const path of [DEFAULT_DATA_DIRECTORY, DEFAULT_BACKUP_DIRECTORY])
		expect(path.startsWith("/workspace")).toBe(false);
	expect(defaultBackupDirectory(DEFAULT_DATA_DIRECTORY)).toBe(
		DEFAULT_BACKUP_DIRECTORY,
	);
	expect(defaultBackupDirectory("/tmp/x/store")).toBe("/tmp/x/store-backups");
	const h = await fixture();
	await remember(h, "コーヒーが好きです");
	const result = await backup(h);
	const directory = join(h.dir, "backups");
	expect(statSync(directory).mode & 0o777).toBe(0o700);
	for (const name of readdirSync(directory))
		expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
	expect(statSync(h.dir).mode & 0o777).toBe(0o700);
	expect(statSync(join(h.dir, "memory.db")).mode & 0o777).toBe(0o600);
	expect(dirname(result.path)).toBe(realpathSync(directory));
});

test("S3 backup keeps seven generations, needs admin, and drives backupOverdue", async () => {
	const h = await fixture({ scopes: ["personal", "work"] });
	expect(await h.call("status")).toMatchObject({
		backupOverdue: false,
		lastBackupAt: null,
	});
	h.advance(36 * 3600000 + 1);
	expect(await h.call("status")).toMatchObject({ backupOverdue: true });
	for (let i = 0; i < BACKUP_GENERATIONS + 2; i++) {
		await backup(h);
		h.advance(1000);
	}
	expect(listBackups(join(h.dir, "backups"))).toHaveLength(BACKUP_GENERATIONS);
	expect(readdirSync(join(h.dir, "backups"))).toHaveLength(
		BACKUP_GENERATIONS * 3,
	);
	expect(await h.call("status")).toMatchObject({ backupOverdue: false });
	const config = h.configuration();
	config.credentials["limited"] = {
		clientId: "limited",
		scopeKeys: ["personal"],
		read: true,
		write: true,
		forgetAll: true,
		confirmedWrites: false,
	};
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(await h.call("backup", {}, "limited")).toMatchObject({
		code: "FORGET_REQUIRES_ALL_SCOPES",
	});
});
