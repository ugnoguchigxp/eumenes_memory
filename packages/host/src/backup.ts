/**
 * バックアップと復元（設計 §4C、決定 10、S3）。
 * - 取得: 所有者が writer の順番で、読み取り専用の別接続から `VACUUM INTO` する（空きページを写さない）。
 * - 置き場所: owner.json の `backupDirectory`（0700、ファイルは 0600）。7 世代を残し、古いものは 0 で上書きしてから消す。
 * - 復元: サーバーを止めた状態で、ライブのジャーナルを優先し、その先頭がバックアップの `journalHead` 以上であることを確かめる。
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { verifyForgetJournal, type ForgetJournalEntry } from "eumenes-memory";
import { acquireOwnerLock } from "./owner-lock.ts";
import { demand, HostError, type HostResult } from "./contracts.ts";

/** 決定 10（2026-11-16 承認）で決めた、この環境での置き場所。どちらも `/workspace` の外。 */
export const DEFAULT_DATA_DIRECTORY = "/home/box/eumenes-memory-data";
export const DEFAULT_BACKUP_DIRECTORY = "/home/box/eumenes-memory-backups";
export const BACKUP_GENERATIONS = 7;
export const BACKUP_OVERDUE_MS = 36 * 3600000;
/** データの置き場所に対する既定のバックアップの置き場所。決定 10 の置き場所なら決定 10 のもの、それ以外は隣の `<名前>-backups`。 */
export function defaultBackupDirectory(root: string): string {
	return resolve(root) === DEFAULT_DATA_DIRECTORY
		? DEFAULT_BACKUP_DIRECTORY
		: join(dirname(resolve(root)), `${basename(resolve(root))}-backups`);
}
export interface JournalHead {
	seq: number;
	hash: string | null;
}
export interface BackupMeta {
	version: 1;
	file: string;
	journalFile: string;
	bytes: number;
	sha256: string;
	schemaVersion: number;
	hostSchemaVersion: number;
	journalHead: JournalHead;
	createdAt: number;
	/** 洗い直し（S4）が最後に反映したジャーナルの seq。 */
	scrubbedThrough: number;
	scrubPending: boolean;
}
export function journalHead(entries: readonly unknown[]): JournalHead {
	const last = entries.at(-1) as ForgetJournalEntry | undefined;
	return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: null };
}
export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
/** 0 で上書きし、fsync してから消す。無ければ何もしない。 */
export function shred(path: string): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return;
	if (stat.isFile() && stat.size > 0) {
		const fd = openSync(path, "r+");
		try {
			const zero = Buffer.alloc(Math.min(stat.size, 1 << 20));
			for (let offset = 0; offset < stat.size; offset += zero.length)
				writeSync(
					fd,
					zero,
					0,
					Math.min(zero.length, stat.size - offset),
					offset,
				);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	unlinkSync(path);
}
/** fresh で target を原子的に置き換え、置き換えられた古い中身を 0 で上書きする（途中で止まっても target は常に完全なファイル）。 */
export function replaceAndShred(fresh: string, target: string): void {
	const fd = openSync(target, "r+");
	try {
		const size = fstatSync(fd).size;
		renameSync(fresh, target);
		const zero = Buffer.alloc(Math.min(Math.max(size, 1), 1 << 20));
		for (let offset = 0; offset < size; offset += zero.length)
			writeSync(fd, zero, 0, Math.min(zero.length, size - offset), offset);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
export function ensurePrivateDirectory(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return realpathSync(path);
}
function writePrivateFile(path: string, content: string): void {
	const temp = `${path}.tmp`;
	writeFileSync(temp, content, { mode: 0o600 });
	chmodSync(temp, 0o600);
	fsyncPath(temp);
	renameSync(temp, path);
}
export function writeMeta(directory: string, meta: BackupMeta): void {
	writePrivateFile(
		join(directory, meta.file.replace(/\.db$/, ".json")),
		JSON.stringify(meta, null, 2) + "\n",
	);
	fsyncPath(directory);
}
export function writeJournalCopy(
	path: string,
	entries: readonly unknown[],
): void {
	writePrivateFile(path, entries.map((e) => JSON.stringify(e) + "\n").join(""));
}
/** バックアップの名前の基（`memory-<UTC の時刻>-<乱数>`）。記録の中のファイル名はこの形だけを信じる。 */
const BACKUP_BASE = /^memory-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
/** 記録のファイル名が、記録自身の名前と同じ基を持つ正しい形か（`../` などで置き場所の外を指させない）。 */
function wellFormedMeta(name: string, meta: BackupMeta): boolean {
	const base = name.slice(0, -".json".length);
	return (
		BACKUP_BASE.test(base) &&
		meta.file === `${base}.db` &&
		meta.journalFile === `${base}.forget.jsonl`
	);
}
/** 置き場所の中のバックアップを古い順に返す。壊れた記録と、形の正しくない記録は無視する。 */
export function listBackups(directory: string): BackupMeta[] {
	if (!existsSync(directory)) return [];
	const metas: BackupMeta[] = [];
	for (const name of readdirSync(directory)) {
		if (!/^memory-.*\.json$/.test(name)) continue;
		try {
			const meta = JSON.parse(
				readFileSync(join(directory, name), "utf8"),
			) as BackupMeta;
			if (
				meta.version === 1 &&
				wellFormedMeta(name, meta) &&
				existsSync(join(directory, meta.file))
			)
				metas.push(meta);
		} catch {
			continue;
		}
	}
	return metas.sort(
		(a, b) => a.createdAt - b.createdAt || (a.file < b.file ? -1 : 1),
	);
}
export function removeBackup(directory: string, meta: BackupMeta): void {
	shred(join(directory, meta.file));
	shred(join(directory, meta.journalFile));
	shred(join(directory, meta.file.replace(/\.db$/, ".json")));
}
export const BACKUP_RETENTION_MS = 7 * 86400000;
/**
 * 新しい順に `BACKUP_GENERATIONS` 世代だけ残す。洗い直しに失敗した印のあるものは、作成から 7 日で必ず消す
 * （忘れた本文がバックアップに残る最悪の期間を 7 日にする。§4C.4 の 3）。
 */
export function pruneBackups(
	directory: string,
	keep = BACKUP_GENERATIONS,
	now?: number,
): number {
	const all = listBackups(directory);
	const old = all.filter(
		(meta, index) =>
			index < all.length - keep ||
			(now !== undefined &&
				meta.scrubPending &&
				now - meta.createdAt > BACKUP_RETENTION_MS),
	);
	for (const meta of old) removeBackup(directory, meta);
	const orphans = removeOrphans(directory, all);
	if (old.length || orphans) fsyncPath(directory);
	return old.length;
}
/**
 * 途中で止まった作成や洗い直しの残り（記録の無い `.db` と写し、`.tmp`、`.scrub-*` の作業場所）を 0 で上書きして消す。
 * どれも忘れた本文を含みうるが、一覧にも洗い直しにも載らないため。バックアップの順番（作成と洗い直しの後）だけで呼ぶ。
 * 戻り値は消したファイルの数。
 */
export function removeOrphans(
	directory: string,
	known: readonly BackupMeta[] = listBackups(directory),
): number {
	if (!existsSync(directory)) return 0;
	const kept = new Set(
		known.flatMap((meta) => [
			meta.file,
			meta.journalFile,
			meta.file.replace(/\.db$/, ".json"),
		]),
	);
	let removed = 0;
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (name.startsWith(".scrub-")) {
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat?.isDirectory()) continue;
			for (const inner of readdirSync(path)) {
				shred(join(path, inner));
				removed++;
			}
			rmdirSync(path);
			continue;
		}
		if (!name.startsWith("memory-") || kept.has(name)) continue;
		if (
			!/\.(db|forget\.jsonl|json)(\.tmp)?$/.test(name) ||
			!lstatSync(path).isFile()
		)
			continue;
		shred(path);
		removed++;
	}
	return removed;
}
function stamp(atMs: number): string {
	return new Date(atMs)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
}
/** 読み取り専用の別接続から `VACUUM INTO` で 1 ファイルに写し、fsync してから最終の名前に rename する。 */
export function vacuumInto(source: string, target: string): void {
	const temp = `${target}.tmp`;
	// 前回の途中の写しは本文を含みうるので、0 で上書きしてから消す。
	shred(temp);
	const reader = new Database(source, { readonly: true });
	try {
		reader.query("VACUUM INTO ?").run(temp);
	} finally {
		reader.close();
	}
	chmodSync(temp, 0o600);
	fsyncPath(temp);
	renameSync(temp, target);
}
export interface BackupInput {
	databasePath: string;
	directory: string;
	journal: readonly unknown[];
	atMs: number;
	hostSchemaVersion: number;
}
/** バックアップを 1 つ作る。呼び出し側（所有者）が writer の順番で呼ぶ。 */
export function createBackupFiles(input: BackupInput): BackupMeta {
	const directory = ensurePrivateDirectory(input.directory);
	const base = `memory-${stamp(input.atMs)}-${randomBytes(4).toString("hex")}`;
	const file = `${base}.db`;
	const journalFile = `${base}.forget.jsonl`;
	vacuumInto(input.databasePath, join(directory, file));
	writeJournalCopy(join(directory, journalFile), input.journal);
	const check = new Database(join(directory, file), { readonly: true });
	let schemaVersion: number;
	try {
		const row = check
			.query(
				"SELECT value FROM memory_schema_info WHERE key='db_schema_version'",
			)
			.get() as { value: string } | null;
		schemaVersion = Number(row?.value ?? 0);
	} finally {
		check.close();
	}
	const head = journalHead(input.journal);
	const meta: BackupMeta = {
		version: 1,
		file,
		journalFile,
		bytes: statSync(join(directory, file)).size,
		sha256: sha256File(join(directory, file)),
		schemaVersion,
		hostSchemaVersion: input.hostSchemaVersion,
		journalHead: head,
		createdAt: input.atMs,
		scrubbedThrough: head.seq,
		scrubPending: false,
	};
	writeMeta(directory, meta);
	pruneBackups(directory, BACKUP_GENERATIONS, input.atMs);
	return meta;
}
export function backupStatus(
	directory: string | undefined,
	now: number,
	since: number,
): {
	lastBackupAt: number | null;
	backupOverdue: boolean;
	backupScrubPending: boolean;
	backupGenerations: number;
} {
	const all = directory ? listBackups(directory) : [];
	const last = all.at(-1)?.createdAt ?? null;
	return {
		lastBackupAt: last,
		backupOverdue: now - (last ?? since) > BACKUP_OVERDUE_MS,
		backupScrubPending: all.some((m) => m.scrubPending),
		backupGenerations: all.length,
	};
}
function readJournalFile(path: string): ForgetJournalEntry[] {
	demand(existsSync(path), "JOURNAL_MISSING");
	let entries: ForgetJournalEntry[];
	try {
		entries = readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ForgetJournalEntry);
	} catch {
		throw new HostError("JOURNAL_INVALID");
	}
	demand(verifyForgetJournal(entries).status === "ok", "JOURNAL_INVALID");
	return entries;
}

/** Read the applied head of the current store before considering an older backup. */
function readStoreHead(path: string): JournalHead {
	try {
		const db = new Database(path, { readonly: true });
		try {
			// This head is persisted by the core foundation migration, including in pre-FTS stores.
			const row = db
				.query<JournalHead, []>(
					"SELECT applied_head_seq AS seq, applied_head_hash AS hash FROM memory_journal_state WHERE id=1",
				)
				.get();
			demand(
				row &&
					Number.isSafeInteger(row.seq) &&
					row.seq >= 0 &&
					typeof row.hash === "string",
				"JOURNAL_HEAD_UNVERIFIED",
			);
			return row;
		} finally {
			db.close();
		}
	} catch {
		throw new HostError("JOURNAL_HEAD_UNVERIFIED");
	}
}

function containsHead(
	entries: readonly ForgetJournalEntry[],
	head: JournalHead,
): boolean {
	return head.seq === 0 || entries[head.seq - 1]?.hash === head.hash;
}

function checkpointStore(root: string): void {
	const db = new Database(join(root, "memory.db"), { readwrite: true });
	try {
		const state = db
			.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
			.get();
		demand(state?.busy === 0, "RESTORE_CHECKPOINT_BUSY");
		// Switching out of WAL acquires SQLite's exclusive database lock and leaves a self-contained DB.
		const mode = db
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode=DELETE")
			.get();
		demand(mode?.journal_mode === "delete", "RESTORE_CHECKPOINT_BUSY");
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === "SQLITE_BUSY"
		)
			throw new HostError("RESTORE_CHECKPOINT_BUSY");
		throw error;
	} finally {
		db.close();
	}
	const wal = join(root, "memory.db-wal");
	demand(
		!existsSync(wal) || statSync(wal).size === 0,
		"RESTORE_CHECKPOINT_BUSY",
	);
	if (existsSync(wal)) unlinkSync(wal);
	const shm = join(root, "memory.db-shm");
	if (existsSync(shm)) unlinkSync(shm);
}

/** Validate the candidate before a single atomic replacement of the checkpointed DB. */
export async function restoreFiles(
	backupPath: string,
	directory: string,
	atMs: number,
	prepare: (stagedDirectory: string) => Promise<string>,
): Promise<HostResult & { evacuated: string }> {
	const root = realpathSync(directory);
	const backup = resolve(backupPath);
	const metaPath = backup.replace(/\.db$/, ".json");
	demand(existsSync(backup) && existsSync(metaPath), "BACKUP_NOT_FOUND");
	const meta = JSON.parse(readFileSync(metaPath, "utf8")) as BackupMeta;
	demand(
		meta.version === 1 &&
			basename(backup) === meta.file &&
			Number.isSafeInteger(meta.journalHead?.seq) &&
			meta.journalHead.seq >= 0 &&
			(meta.journalHead.seq === 0
				? meta.journalHead.hash === null
				: typeof meta.journalHead.hash === "string"),
		"BACKUP_METADATA_INVALID",
	);

	const lock = acquireOwnerLock(root);
	try {
		const entries = readJournalFile(join(root, "forget.jsonl"));
		demand(
			containsHead(entries, meta.journalHead),
			"JOURNAL_OLDER_THAN_BACKUP",
		);
		const destination = join(root, "memory.db");
		const applied = readStoreHead(destination);
		demand(applied.seq <= entries.length, "JOURNAL_OLDER_THAN_STORE");
		demand(containsHead(entries, applied), "JOURNAL_INCONSISTENT");

		const staging = mkdtempSync(join(root, ".restore-"));
		try {
			const staged = join(staging, "memory.db");
			copyFileSync(backup, staged);
			chmodSync(staged, 0o600);
			demand(sha256File(staged) === meta.sha256, "BACKUP_CHECKSUM_MISMATCH");
			writeJournalCopy(join(staging, "forget.jsonl"), entries);
			const epoch = await prepare(staging);
			checkpointStore(staging);
			fsyncPath(staged);

			checkpointStore(root);
			const evacuated = join(
				root,
				`restore-${stamp(atMs)}-${randomBytes(4).toString("hex")}`,
			);
			mkdirSync(evacuated, { mode: 0o700 });
			fsyncPath(destination);
			linkSync(destination, join(evacuated, "memory.db"));
			fsyncPath(evacuated);
			fsyncPath(root);
			renameSync(staged, destination);
			fsyncPath(root);
			return {
				status: "completed",
				started: true,
				epoch,
				restored: meta.file,
				journalHead: journalHead(entries),
				backupJournalHead: meta.journalHead,
				evacuated,
			};
		} finally {
			for (const name of ["memory.db", "memory.db-wal", "memory.db-shm"])
				shred(join(staging, name));
			rmSync(staging, { recursive: true, force: true });
		}
	} finally {
		lock.close();
	}
}
