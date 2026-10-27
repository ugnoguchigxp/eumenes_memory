import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import {
	CONTRACT_VERSIONS,
	sliceUtf8Range,
	verifyForgetJournal,
} from "eumenes-memory";
import type {
	AccessContext,
	EvidenceSpan,
	HostSourceState,
	StateItem,
} from "eumenes-memory";
import {
	applyForget,
	assertMemorySchema,
	assertUserState,
	checkHostMigrations,
	listState,
	migrations,
	planForget,
	readStateFact,
	reconcileForgetJournal,
} from "eumenes-memory/sqlite";
import type {
	ForgetJournalEntry,
	ForgetTarget,
	MemoryDb,
} from "eumenes-memory/sqlite";
import type { Action, RememberAction } from "./protocol.ts";

export const ACCESS: AccessContext = {
	principal: "standalone:owner",
	scopeKeys: ["standalone:conversation"],
	purpose: "memory.check",
	policyRevision: "1",
};
export const SCOPE = ACCESS.scopeKeys[0]!;

export function appendDurable(path: string, value: unknown): void {
	const fd = openSync(path, "a", 0o600);
	try {
		const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Example-only single-process host. All memory access goes through public APIs. */
export class StandaloneHost {
	private readonly db: Database;
	private previewing = false;
	readonly path: string;
	readonly journalPath: string;
	readonly startup: {
		status: "ok";
		reapplied: number;
		feedResyncRequired?: true;
	};

	constructor(readonly directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.path = join(directory, "memory.db");
		this.journalPath = join(directory, "forget.jsonl");
		const existing = existsSync(this.path);
		if (existing && !existsSync(this.journalPath))
			throw new Error("Host journal is missing");
		if (!existing) {
			const fd = openSync(this.journalPath, "wx", 0o600);
			fsyncSync(fd);
			closeSync(fd);
			const directoryFd = openSync(directory, "r");
			try {
				fsyncSync(directoryFd);
			} finally {
				closeSync(directoryFd);
			}
		}
		this.db = new Database(this.path, { create: true });
		try {
			this.db.exec(
				"PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;",
			);
			const problems = checkHostMigrations(migrations);
			if (problems.length) throw new Error(problems.join("; "));
			if (!existing)
				for (const migration of migrations) this.db.exec(migration);
			assertMemorySchema(this.db);
			const lines = readFileSync(this.journalPath, "utf8");
			const entries: ForgetJournalEntry[] = lines
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const verified = verifyForgetJournal(entries);
			if (verified.status !== "ok") throw new Error(verified.reasonCode);
			const result = this.write((db) =>
				reconcileForgetJournal(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					entries,
					clock: { atMs: Date.now() },
				}),
			);
			if (result.status !== "ok") throw new Error(result.reasonCode);
			this.startup = result;
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	write<T>(operation: (db: MemoryDb) => T): T {
		return this.db.transaction(() => operation(this.db))();
	}
	read<T>(operation: (db: MemoryDb) => T): T {
		return this.db.transaction(() => operation(this.db))();
	}
	/** Run the real contracts, then roll back. No host source or forget journal is appended. */
	preview(actions: readonly Action[], message: string): void {
		if (this.previewing) throw new Error("Nested preview");
		const rollback = new Error("preview rollback");
		this.previewing = true;
		try {
			this.write(() => {
				for (const action of actions) {
					if (action.type === "remember") this.remember(action, message);
					else this.forgetFact(action.itemId);
				}
				throw rollback;
			});
		} catch (error) {
			if (error !== rollback) throw error;
		} finally {
			this.previewing = false;
		}
	}
	list(includeInactive = false): readonly StateItem[] {
		return this.read((db) => {
			const items: StateItem[] = [];
			let after: { updatedSeq: number; itemId: string } | undefined;
			do {
				const result = listState(db, {
					contractVersion: CONTRACT_VERSIONS.state,
					access: ACCESS,
					scopeKey: SCOPE,
					includeInactive,
					...(after ? { after } : {}),
				});
				if (result.status !== "ok")
					throw new Error(`listState: ${result.status}`);
				items.push(...result.items);
				after = result.nextCursor;
			} while (after !== undefined);
			return items;
		});
	}

	/** Resolve only an authorized active item's exact evidence; used solely by the evaluator. */
	evidenceQuotes(itemId: string): readonly string[] {
		const item = this.list().find((candidate) => candidate.itemId === itemId);
		if (item === undefined) throw new Error("No active item for evidence");
		const sources: HostSourceState[] = readFileSync(
			join(this.directory, "sources.jsonl"),
			"utf8",
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		return item.evidence.map((ref) => {
			const source = sources.find(
				(candidate) =>
					candidate.namespace === ref.namespace &&
					candidate.kind === ref.kind &&
					candidate.id === ref.id &&
					candidate.representation === ref.representation &&
					candidate.revision === ref.revision &&
					candidate.digest === ref.digest &&
					candidate.principal === ACCESS.principal &&
					candidate.scopeKey === item.scopeKey &&
					candidate.status === "available",
			);
			if (source === undefined || ref.range === undefined)
				throw new Error("Evidence source unavailable");
			if (
				createHash("sha256").update(source.content).digest("hex") !== ref.digest
			)
				throw new Error("Evidence source digest mismatch");
			const slice = sliceUtf8Range(source.content, ref.range);
			if (slice.status !== "ok")
				throw new Error(`Evidence range: ${slice.reasonCode}`);
			return slice.text;
		});
	}

	remember(action: RememberAction, message: string): StateItem {
		const start = message.indexOf(action.quote);
		if (
			!action.quote ||
			start < 0 ||
			message.indexOf(action.quote, start + 1) !== -1
		)
			throw new Error("Quote must occur exactly once in the source");
		const contentHash = createHash("sha256").update(message).digest("hex");
		const source: HostSourceState = {
			namespace: "conversation",
			kind: "message",
			id: randomUUID(),
			representation: "text",
			revision: `sha256:${contentHash}`,
			digest: contentHash,
			principal: ACCESS.principal,
			scopeKey: SCOPE,
			status: "available",
			content: message,
			ordinal: Date.now(),
		};
		const evidence: EvidenceSpan = {
			source: {
				namespace: source.namespace,
				kind: source.kind,
				id: source.id,
				representation: "text",
				revision: source.revision,
				digest: source.digest,
				range: {
					startByte: Buffer.byteLength(message.slice(0, start)),
					endByte: Buffer.byteLength(
						message.slice(0, start + action.quote.length),
					),
				},
			},
			quote: action.quote,
		};
		const replaces =
			action.replacesItemId === null
				? undefined
				: this.list().find((item) => item.itemId === action.replacesItemId);
		if (action.replacesItemId !== null && replaces === undefined)
			throw new Error("Unknown replacement target");
		if (!this.previewing)
			appendDurable(join(this.directory, "sources.jsonl"), source);
		const result = this.write((db) =>
			assertUserState(db, {
				contractVersion: CONTRACT_VERSIONS.state,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: Date.now() },
				kind: action.kind,
				subject: action.subject,
				semanticKey: action.semanticKey,
				value: action.value,
				evidence: [evidence],
				sources: [source],
				origin: "agent_inferred",
				...(replaces === undefined
					? {}
					: {
							replaces: {
								itemId: replaces.itemId,
								revision: replaces.revision,
							},
						}),
			}),
		);
		if (result.status !== "applied" && result.status !== "unchanged")
			throw new Error(`assertUserState: ${JSON.stringify(result)}`);
		return result.item;
	}

	forgetFact(itemId: string): readonly string[] {
		const fact = this.read((db) =>
			readStateFact(db, {
				contractVersion: CONTRACT_VERSIONS.state,
				access: ACCESS,
				scopeKey: SCOPE,
				itemId,
			}),
		);
		if (fact.status !== "ok") throw new Error(`readStateFact: ${fact.status}`);
		for (const id of fact.itemIds)
			this.forget({ type: "state_item", scopeKey: SCOPE, itemId: id });
		return fact.itemIds;
	}

	forget(target: ForgetTarget, crashAfterJournal = false): void {
		const planned = this.read((db) =>
			planForget(db, {
				contractVersion: CONTRACT_VERSIONS.lifecycle,
				access: ACCESS,
				target,
				clock: { atMs: Date.now() },
			}),
		);
		if (planned.status !== "planned")
			throw new Error(`planForget: ${planned.status}`);
		if (!this.previewing) appendDurable(this.journalPath, planned.plan.entry);
		// This deliberate interruption is used only by the crash-recovery check.
		if (crashAfterJournal) throw new Error("simulated_crash_after_journal");
		try {
			this.write((db) =>
				applyForget(db, {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					entry: planned.plan.entry,
					clock: { atMs: Date.now() },
				}),
			);
		} catch (error) {
			// A durable journal entry must be reconciled before any further use.
			if (!this.previewing) this.close();
			throw error;
		}
	}

	snapshot(path: string): void {
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		copyFileSync(this.path, path);
	}
	close(): void {
		this.db.close();
	}
}
