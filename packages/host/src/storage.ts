import { Database } from "bun:sqlite";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	assertMemorySchema,
	migrations,
	type MemoryDb,
} from "eumenes-memory/sqlite";
import type { HostForgetIntent } from "eumenes-memory";
import {
	configSchema,
	demand,
	type HostConfig,
	type Profile,
} from "./contracts.ts";

/** Ports use an existing host's transactions; callbacks must remain synchronous. */
export interface StorePort {
	read<T>(fn: (db: MemoryDb) => T): T;
	write<T>(fn: (db: MemoryDb) => T): Promise<T>;
}
export interface JournalPort {
	read(): unknown;
	append(entry: unknown): void;
}
export interface AppPort extends StorePort {
	journal: JournalPort;
	/** Runs in the SAME writer transaction as apply/reconcile. */
	isReady?: () => boolean;
	failClosed?: () => void;
	applyHostIntent?: (
		db: MemoryDb,
		intent: HostForgetIntent,
		forgetId?: string,
	) => void;
}
export const hostSchemaSql = `
CREATE TABLE IF NOT EXISTS host_schema(version INTEGER NOT NULL);
INSERT INTO host_schema SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM host_schema);
CREATE TABLE IF NOT EXISTS host_source(
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, submission_id TEXT NOT NULL, scope_key TEXT NOT NULL,
 kind TEXT NOT NULL, content TEXT, ref TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL,
 forgotten INTEGER NOT NULL DEFAULT 0, UNIQUE(client_id,scope_key,submission_id));
CREATE INDEX IF NOT EXISTS host_source_ref ON host_source(scope_key,json_extract(ref,'$.namespace'),json_extract(ref,'$.kind'),json_extract(ref,'$.id')) WHERE forgotten=0;
CREATE TABLE IF NOT EXISTS host_plan(
 id TEXT PRIMARY KEY, scope_keys TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS host_operation(
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, epoch TEXT NOT NULL, scope_keys TEXT NOT NULL,
 payload TEXT, result TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS host_dependent(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS host_state_source(item_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(item_id,source_id));
CREATE TABLE IF NOT EXISTS host_forget_intent(id TEXT PRIMARY KEY, payload TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
`;
export function durableAppend(path: string, entry: unknown): void {
	const fd = openSync(path, "a", 0o600);
	try {
		const data = Buffer.from(JSON.stringify(entry) + "\n");
		let offset = 0;
		while (offset < data.length) offset += writeSync(fd, data, offset);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
export function fileJournal(path: string): JournalPort {
	return {
		read: () =>
			readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((s) => JSON.parse(s)),
		append: (entry) => durableAppend(path, entry),
	};
}
export function initialize(
	directory: string,
	scopeKeys = ["personal"],
): Profile {
	demand(
		[
			"owner.json",
			"profile.json",
			"memory.db",
			"memory.db-wal",
			"memory.db-shm",
			"forget.jsonl",
			"owner.lock",
			"owner.lock-journal",
			"memory.sock",
			"memory.sock.model.lock",
		].every(
			(name) => !lstatSync(join(directory, name), { throwIfNoEntry: false }),
		),
		"STORE_ALREADY_EXISTS",
	);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const root = realpathSync(directory);
	const socketPath = join(root, "memory.sock");
	demand(Buffer.byteLength(socketPath) < 104, "SOCKET_PATH_TOO_LONG");
	const credential = randomBytes(32).toString("hex");
	const config: HostConfig = configSchema.parse({
		version: 1,
		principal: "local:owner",
		scopeKeys,
		socketPath,
		credentials: {
			[credential]: {
				clientId: "owner",
				scopeKeys,
				read: true,
				write: true,
				forgetAll: true,
				confirmedWrites: false,
			},
		},
	});
	writeFileSync(
		join(root, "owner.json"),
		JSON.stringify(config, null, 2) + "\n",
		{ flag: "wx", mode: 0o600 },
	);
	const profile: Profile = { version: 1, socketPath, credential };
	writeFileSync(
		join(root, "profile.json"),
		JSON.stringify(profile, null, 2) + "\n",
		{ flag: "wx", mode: 0o600 },
	);
	const db = new Database(join(root, "memory.db"), { create: true });
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON",
		);
		db.transaction(() => {
			for (const sql of migrations) db.exec(sql);
			db.exec(hostSchemaSql);
		})();
	} finally {
		db.close();
	}
	chmodSync(join(root, "memory.db"), 0o600);
	const journalPath = join(root, "forget.jsonl");
	const fd = openSync(journalPath, "wx", 0o600);
	fsyncSync(fd);
	closeSync(fd);
	const dirFd = openSync(root, "r");
	fsyncSync(dirFd);
	closeSync(dirFd);
	return profile;
}
export function openStandalone(directory: string): {
	port: AppPort;
	close(): Promise<void>;
} {
	const root = realpathSync(directory);
	demand(
		existsSync(join(root, "memory.db")) &&
			existsSync(join(root, "forget.jsonl")),
		"STORE_OR_JOURNAL_MISSING",
	);
	const lock = new Database(join(root, "owner.lock"));
	try {
		lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
	} catch {
		lock.close();
		throw new Error("OWNER_ALREADY_RUNNING");
	}
	const db = new Database(join(root, "memory.db"));
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON",
		);
		assertMemorySchema(db);
	} catch (error) {
		db.close();
		lock.close();
		throw error;
	}
	let tail: Promise<unknown> = Promise.resolve();
	let closed = false;
	const port: AppPort = {
		journal: fileJournal(join(root, "forget.jsonl")),
		read: (fn) => {
			demand(!closed, "STORE_CLOSED");
			return db.transaction(() => fn(db))();
		},
		write: (fn) => {
			const task = tail.then(() => {
				demand(!closed, "STORE_CLOSED");
				return db.transaction(() => fn(db))();
			});
			tail = task.catch(() => {});
			return task;
		},
	};
	return {
		port,
		close: async () => {
			await tail;
			if (closed) return;
			closed = true;
			db.close();
			lock.close();
		},
	};
}
