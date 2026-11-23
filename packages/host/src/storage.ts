import { acquireOwnerLock } from "./owner-lock.ts";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	closeSync,
	constants,
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
import { dirname, join, resolve } from "node:path";
import {
	defaultBackupDirectory,
	discardInterruptedRestores,
	readJournalFile,
	writeJournalCopy,
} from "./backup.ts";
import { randomBytes } from "node:crypto";
import {
	assertMemorySchema,
	MEMORY_DB_SCHEMA_VERSION,
	migrations,
	readForgetJournalHead,
	type MemoryDb,
} from "eumenes-memory/sqlite";
import {
	journalWithRecoveryHead,
	readRecoveryHead,
	writePrivateFile,
	writeRecoveryHead,
	type RecoveryConfig,
} from "./recovery.ts";
import type { ForgetJournalEntry, HostForgetIntent } from "eumenes-memory";
import {
	configSchema,
	demand,
	HostError,
	type HostConfig,
	type Profile,
} from "./contracts.ts";

/** Ports use an existing host's transactions; callbacks must remain synchronous. */
export interface StorePort {
	read<T>(fn: (db: MemoryDb) => T): T;
	write<T>(fn: (db: MemoryDb) => T): Promise<T>;
}
export interface JournalPort {
	readonly recoveryStoreId?: string;
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
	/** Queue a WAL truncate checkpoint outside the write transaction. Return false if it is busy. */
	checkpoint?: () => Promise<boolean>;
	/** DB ファイルの場所（バックアップに使う）。 */
	databasePath?: string;
	/** writer の順番で、transaction の外から fn を実行する（`VACUUM INTO` など）。 */
	exclusive?: <T>(fn: () => T) => Promise<T>;
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
/**
 * ホストの表の版上げ。添字 + 2 が上げた後の版（`host_schema.version`）。追記のみで、順序と本文を変えない。
 * 起動時と初期化時に `upgradeHostSchema` が、今の版より新しいものだけを writer の transaction の中で順に適用する。
 */
export const hostSchemaUpgrades: readonly string[] = Object.freeze([
	// 2: 今の epoch の受領記録を保持期限で消したことの記録（決定 8、S2）。
	`CREATE TABLE IF NOT EXISTS host_operation_horizon(epoch TEXT PRIMARY KEY, pruned_before INTEGER NOT NULL);`,
	// 3: 出典の由来（決定 12、S5）。版上げ前の出典は unknown（外部由来として扱う）。
	`ALTER TABLE host_source ADD COLUMN provenance TEXT NOT NULL DEFAULT 'unknown';`,
	// 4: 外部由来の item の最終利用日（UTC の日番号、決定 11、S6b）。忘却で一緒に消す。
	`CREATE TABLE IF NOT EXISTS host_item_use(item_id TEXT PRIMARY KEY, last_used_day INTEGER NOT NULL);`,
	// 5: Agenda, including rows already written by the development schema.
	`
CREATE TABLE IF NOT EXISTS host_agenda(
 id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES host_source(id),
 status_source_id TEXT REFERENCES host_source(id), kind TEXT NOT NULL,
 details TEXT NOT NULL, evidence TEXT NOT NULL, quote TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','done','cancelled')), updated_at INTEGER NOT NULL,
 creation_hash TEXT);
CREATE INDEX IF NOT EXISTS host_agenda_scope ON host_agenda(scope_key,id);
CREATE INDEX IF NOT EXISTS host_agenda_source ON host_agenda(source_id);
CREATE INDEX IF NOT EXISTS host_agenda_status_source ON host_agenda(status_source_id);
`,
]);
export const HOST_SCHEMA_VERSION = hostSchemaUpgrades.length + 1;
/** 版 1 の表を作り、足りない版上げを適用する。本体より新しい版は `HOST_SCHEMA_MISMATCH`。 */
export function upgradeHostSchema(db: MemoryDb): number {
	db.exec(hostSchemaSql);
	const row = db.query("SELECT version FROM host_schema").get() as {
		version: number;
	};
	demand(
		Number.isSafeInteger(row.version) &&
			row.version >= 1 &&
			row.version <= HOST_SCHEMA_VERSION,
		"HOST_SCHEMA_MISMATCH",
	);
	// An earlier agenda build also used version 2. Its agenda tables remain in place.
	if (
		row.version === 2 &&
		db
			.query(
				"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='host_agenda'",
			)
			.get()
	)
		db.exec(hostSchemaUpgrades[0]!);
	// A version number alone cannot identify a database created by another host build.
	if (row.version >= 2)
		demand(
			db
				.query(
					"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='host_operation_horizon'",
				)
				.get(),
			"HOST_SCHEMA_MISMATCH",
		);
	for (
		let version = row.version + 1;
		version <= HOST_SCHEMA_VERSION;
		version++
	) {
		db.exec(hostSchemaUpgrades[version - 2]!);
		db.query("UPDATE host_schema SET version=?").run(version);
	}
	return HOST_SCHEMA_VERSION;
}
function durableAppend(
	path: string,
	entry: unknown,
	beforeAppend?: () => void,
): void {
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
	);
	try {
		const data = Buffer.from(JSON.stringify(entry) + "\n");
		beforeAppend?.();
		let offset = 0;
		while (offset < data.length) {
			const written = writeSync(fd, data, offset);
			demand(written > 0, "JOURNAL_APPEND_FAILED");
			offset += written;
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
export function fileJournal(
	path: string,
	recovery?: RecoveryConfig,
): JournalPort {
	const root = dirname(path);
	if (recovery) {
		return {
			recoveryStoreId: recovery.storeId,
			read: () => {
				const { entries, pending } = journalWithRecoveryHead(
					readFileSync(path, "utf8"),
					readRecoveryHead(root, recovery),
				);
				if (pending) writeJournalCopy(path, entries);
				return entries;
			},
			append: (value) => {
				const entry = value as ForgetJournalEntry;
				const previous = readRecoveryHead(root, recovery);
				demand(
					entry.seq === (previous?.seq ?? 0) + 1 &&
						(!previous || entry.prevHash === previous.hash),
					"JOURNAL_HEAD_UNVERIFIED",
				);
				durableAppend(path, entry, () =>
					writeRecoveryHead(root, recovery, entry),
				);
			},
		};
	}
	return {
		read: () =>
			readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((s) => JSON.parse(s)),
		append: (entry) => durableAppend(path, entry),
	};
}
/** SQLite の機能（試験だけが差し替える）。 */
export interface SqliteFeatures {
	fts5: boolean;
	version: string;
}
/** 全文検索の索引（核の migration 0009）が要る最低の SQLite の版（集計関数の中の ORDER BY と secure-delete）。 */
export const MIN_SQLITE_VERSION = "3.44.0";
/** Bound file mappings for the FTS postings and random State lookups. */
export const SQLITE_MMAP_BYTES = 256 * 1024 * 1024;
export function sqliteFeatures(db: Database): SqliteFeatures {
	const fts5 = db
		.query(
			"SELECT 1 AS x FROM pragma_compile_options WHERE compile_options='ENABLE_FTS5'",
		)
		.get();
	const row = db.query("SELECT sqlite_version() AS v").get() as { v: string };
	return { fts5: Boolean(fts5), version: row.v };
}
function versionAtLeast(version: string, minimum: string): boolean {
	const a = version.split(".").map(Number);
	const b = minimum.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return true;
}
/** §5: FTS5 と SQLite の版を確かめる。満たさなければ `SQLITE_FEATURE_MISSING` で起動を止める。 */
export function assertSqliteFeatures(features: SqliteFeatures): void {
	if (!features.fts5 || !versionAtLeast(features.version, MIN_SQLITE_VERSION))
		throw new HostError("SQLITE_FEATURE_MISSING", "failed");
}
/** DB の核の版（`memory_schema_info` が無ければ 0）。 */
function memorySchemaVersion(db: Database): number {
	const table = db
		.query(
			"SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='memory_schema_info'",
		)
		.get();
	if (!table) return 0;
	const row = db
		.query("SELECT value FROM memory_schema_info WHERE key='db_schema_version'")
		.get() as { value: string } | null;
	return row && /^[1-9][0-9]{0,8}$/.test(row.value) ? Number(row.value) : 0;
}
/**
 * 既存の DB に、まだ適用していない核の migration を 1 つの transaction で適用する（例: 版 8 → 9 の索引の初回投入）。
 * 版が本体より新しいときや中身が違うときは、適用せずに `assertMemorySchema` に任せる。
 */
export function applyPendingMigrations(db: Database): number {
	const version = memorySchemaVersion(db);
	if (version === 0 || version >= MEMORY_DB_SCHEMA_VERSION) return 0;
	// 既に適用済みの migration の中身が本体と同じこと（記録された hash が本体の migration の記録文と一致すること）。
	for (let n = 1; n <= version; n++) {
		const row = db
			.query("SELECT value FROM memory_schema_info WHERE key=?")
			.get(`migration_${n}_sha256`) as { value: string } | null;
		if (!row || !migrations[n - 1]!.includes(`'${row.value}'`)) return 0;
	}
	const pending = migrations.slice(version);
	db.transaction(() => {
		for (const sql of pending) db.exec(sql);
	})();
	return pending.length;
}
export function initialize(
	directory: string,
	scopeKeys = ["personal"],
	options: { backupDirectory?: string } = {},
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
		backupDirectory: resolve(
			options.backupDirectory ?? defaultBackupDirectory(root),
		),
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
		assertSqliteFeatures(sqliteFeatures(db));
		db.transaction(() => {
			for (const sql of migrations) db.exec(sql);
			upgradeHostSchema(db as unknown as MemoryDb);
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
/** Enroll an existing stopped store, using its current DB to authenticate the local prefix. */
export function protectJournal(
	directory: string,
	protectedDirectory: string,
): void {
	const root = realpathSync(directory);
	const lock = acquireOwnerLock(root);
	try {
		const path = join(root, "owner.json");
		const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		demand(!config.recovery, "JOURNAL_ALREADY_PROTECTED");
		const entries = readJournalFile(join(root, "forget.jsonl"));
		const db = new Database(join(root, "memory.db"), { readonly: true });
		try {
			const head = readForgetJournalHead(db);
			demand(
				head.seq >= 0 &&
					head.seq <= entries.length &&
					(head.seq === 0 || head.hash === entries[head.seq - 1]?.hash),
				"JOURNAL_HEAD_UNVERIFIED",
			);
			const recovery = {
				directory: realpathSync(protectedDirectory),
				storeId: randomBytes(16).toString("hex"),
			};
			// Legacy JSONL may have a valid last line without a trailing newline.
			writeJournalCopy(join(root, "forget.jsonl"), entries);
			writeRecoveryHead(root, recovery, entries.at(-1) ?? null);
			writePrivateFile(
				root,
				path,
				JSON.stringify({ ...config, recovery }, null, 2) + "\n",
			);
		} finally {
			db.close();
		}
	} finally {
		lock.close();
	}
}

export function openStandalone(
	directory: string,
	options: { features?: (db: Database) => SqliteFeatures } = {},
): {
	port: AppPort;
	close(): Promise<void>;
} {
	const root = realpathSync(directory);
	demand(
		existsSync(join(root, "memory.db")) &&
			existsSync(join(root, "forget.jsonl")),
		"STORE_OR_JOURNAL_MISSING",
	);
	const lock = acquireOwnerLock(root);
	let db: Database;
	let recovery: RecoveryConfig | undefined;
	try {
		discardInterruptedRestores(root);
		const ownerPath = join(root, "owner.json");
		if (existsSync(ownerPath))
			recovery = configSchema.parse(
				JSON.parse(readFileSync(ownerPath, "utf8")),
			).recovery;
		db = new Database(join(root, "memory.db"), { readwrite: true });
	} catch (error) {
		lock.close();
		throw error;
	}
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON",
		);
		db.exec(`PRAGMA mmap_size=${SQLITE_MMAP_BYTES}`);
		assertSqliteFeatures((options.features ?? sqliteFeatures)(db));
		applyPendingMigrations(db);
		assertMemorySchema(db);
	} catch (error) {
		db.close();
		lock.close();
		throw error;
	}
	let tail: Promise<unknown> = Promise.resolve();
	let closed = false;
	const port: AppPort = {
		journal: fileJournal(join(root, "forget.jsonl"), recovery),
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
		databasePath: join(root, "memory.db"),
		exclusive: <T>(fn: () => T): Promise<T> => {
			const task = tail.then(() => {
				demand(!closed, "STORE_CLOSED");
				return fn();
			});
			tail = task.catch(() => {});
			return task;
		},
		checkpoint: () => {
			const task = tail.then(() => {
				demand(!closed, "STORE_CLOSED");
				const row = db
					.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
					.get();
				return row?.busy === 0;
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
