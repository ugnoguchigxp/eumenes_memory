/**
 * 忘却の後のバックアップの洗い直し（設計 §4C.4 の 2、S4）。
 * 各バックアップを一時的な場所に開き、最新のジャーナルを所有者の起動と同じ手順で再適用し、`VACUUM INTO` で新しいファイルにする。
 * 元のファイルは 0 で上書きしてから置き換える。失敗したバックアップには `scrubPending` の印を付け、7 日で消す（§4C.4 の 3）。
 */
import { Database } from "bun:sqlite";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type { MemoryDb } from "eumenes-memory/sqlite";
import {
	journalHead,
	listBackups,
	needsBackupScrub,
	pruneBackups,
	replaceAndShred,
	sha256File,
	shred,
	shredRetired,
	vacuumInto,
	writeJournalCopy,
	writeMeta,
	type BackupMeta,
} from "./backup.ts";
import type { HostConfig } from "./contracts.ts";
import type { MemoryHost } from "./service.ts";
import type { AppPort } from "./storage.ts";

/** 洗い直しに使う一時的なポート。ジャーナルは読むだけで、追記が要る回復は失敗にする（ライブのジャーナルを書き換えない）。 */
function temporaryPort(
	path: string,
	entries: readonly unknown[],
): { port: AppPort; close(): void } {
	const db = new Database(path);
	db.exec(
		"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON",
	);
	let tail: Promise<unknown> = Promise.resolve();
	const port: AppPort = {
		journal: {
			read: () => entries,
			append: () => {
				throw new Error("BACKUP_SCRUB_NEEDS_RECOVERY");
			},
		},
		read: (fn) => db.transaction(() => fn(db as unknown as MemoryDb))(),
		write: (fn) => {
			const task = tail.then(() =>
				db.transaction(() => fn(db as unknown as MemoryDb))(),
			);
			tail = task.catch(() => {});
			return task;
		},
		checkpoint: async () =>
			(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number })
				.busy === 0,
	};
	return { port, close: () => db.close() };
}

async function scrubOne(
	host: MemoryHost,
	directory: string,
	meta: BackupMeta,
	entries: readonly unknown[],
): Promise<void> {
	const work = mkdtempSync(join(directory, ".scrub-"));
	try {
		const copy = join(work, "memory.db");
		copyFileSync(join(directory, meta.file), copy);
		const temporary = temporaryPort(copy, entries);
		try {
			const { backupDirectory: _ignored, ...rest } = host.config;
			const configuration = (): HostConfig => rest;
			const Host = host.constructor as typeof MemoryHost;
			const replay = new Host({
				port: temporary.port,
				configuration,
				clock: host.clock,
				replayJournalOnly: true,
			});
			await replay.start();
		} finally {
			temporary.close();
		}
		const fresh = join(work, "fresh.db");
		vacuumInto(copy, fresh);
		for (const name of ["memory.db", "memory.db-wal", "memory.db-shm"])
			shred(join(work, name));
		replaceAndShred(fresh, join(directory, meta.file));
		writeJournalCopy(join(directory, meta.journalFile), entries);
		const head = journalHead(entries);
		writeMeta(directory, {
			...meta,
			bytes: statSync(join(directory, meta.file)).size,
			sha256: sha256File(join(directory, meta.file)),
			journalHead: head,
			scrubbedThrough: head.seq,
			scrubPending: false,
		});
	} finally {
		shredRetired(join(work, "retired.db"));
		for (const name of [
			"memory.db",
			"memory.db-wal",
			"memory.db-shm",
			"fresh.db",
			"fresh.db.tmp",
		])
			if (existsSync(join(work, name))) shred(join(work, name));
		rmSync(work, { recursive: true, force: true });
	}
}

/** ジャーナルの先頭より古いバックアップをすべて洗い直す。戻り値は失敗した数。 */
export async function scrubBackups(
	host: MemoryHost,
	directory: string,
): Promise<number> {
	const entries = host.options.port.journal.read() as unknown[];
	const head = journalHead(entries);
	let failed = 0;
	for (const meta of listBackups(directory)) {
		if (!needsBackupScrub(meta, head.seq)) continue;
		try {
			writeMeta(directory, { ...meta, scrubPending: true });
			host.options.beforeBackupScrub?.(meta.file);
			await scrubOne(host, directory, meta, entries);
		} catch {
			failed++;
		}
	}
	pruneBackups(directory, host.clock(), head.seq);
	return failed;
}
