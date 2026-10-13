/**
 * Eumenes の模擬ホスト（テスト専用）。実 Eumenes に触れず、ホストが Memory に渡す入力と運用の形を再現する。
 *
 * 再現するもの:
 * - 会話 message（追加・編集・削除）と、その SourceState（revision = "sha256:" + digest、編集で changed、削除で missing）。
 * - 直列の書き込みキュー（`store.write` は 1 本ずつ）。
 * - ユーザーの明示操作（`assertUserState`）で State を書く。
 * - 忘却: plan → ジャーナルへ fsync 追記 → apply。途中でクラッシュする点も作れる。
 * - 起動手順: migration の部分列検査 → `assertMemorySchema` → ジャーナル検証 → reconcile。失敗したら Memory を止める。
 * - 再起動と、古い DB の復元。
 *
 * これは実 Eumenes の Writer / queue とは別物で、想定した形を決定的に試す道具。
 * ネットワーク・実時間・乱数を使わない。
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyForgetJournal } from "eumenes-memory";
import type {
	AccessContext,
	EvidenceSpan,
	HostSourceState,
	SourceState,
	StateValue,
} from "eumenes-memory";
import {
	applyForget,
	assertMemorySchema,
	assertUserState,
	checkHostMigrations,
	listState,
	migrations,
	planForget,
	reconcileForgetJournal,
} from "eumenes-memory/sqlite";
import type { ForgetJournalEntry } from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";

export const HOST_SCOPE = "conversation:c1";
export const HOST_PRINCIPAL = "local:owner";

export const HOST_ACCESS: AccessContext = {
	principal: HOST_PRINCIPAL,
	scopeKeys: [HOST_SCOPE],
	purpose: "dialogue.generate",
	policyRevision: "1",
};

/** ホスト自身の migration（本体の migrations を各 1 本ずつ後ろに追記する）。 */
export const HOST_MIGRATIONS: readonly string[] = [
	"CREATE TABLE host_conversation_marker (id INTEGER PRIMARY KEY);",
	...migrations,
];

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---- 会話 ----

export type MessageRole = "user" | "assistant";

interface StoredMessage {
	readonly id: string;
	readonly role: MessageRole;
	readonly ordinal: number;
	text: string;
	deleted: boolean;
}

/** ホスト所有の会話。message の SourceState を README の対応表どおりに作る。 */
export class FakeConversation {
	private readonly messages = new Map<string, StoredMessage>();
	private nextOrdinal = 1;

	add(role: MessageRole, text: string): string {
		const id = `m${this.nextOrdinal}`;
		this.messages.set(id, {
			id,
			role,
			ordinal: this.nextOrdinal,
			text,
			deleted: false,
		});
		this.nextOrdinal += 1;
		return id;
	}

	edit(id: string, text: string): void {
		this.require(id).text = text;
	}

	remove(id: string): void {
		this.require(id).deleted = true;
	}

	/** 現在の状態。編集後は revision / digest が変わる（呼び出し側が保持する ref との比較で changed になる）。 */
	state(id: string, withContent = true): SourceState {
		const message = this.require(id);
		const digest = sha256(message.text);
		return {
			namespace: "conversation",
			kind: "message",
			id,
			representation: "text",
			revision: `sha256:${digest}`,
			digest,
			principal: HOST_PRINCIPAL,
			scopeKey: HOST_SCOPE,
			status: message.deleted ? "missing" : "available",
			...(withContent && !message.deleted ? { content: message.text } : {}),
		};
	}

	/** `assertUserState` に渡す入力出典（順位つき）。 */
	source(id: string): HostSourceState {
		const message = this.require(id);
		return {
			...this.state(id),
			content: message.text,
			ordinal: message.ordinal,
		};
	}

	private require(id: string): StoredMessage {
		const message = this.messages.get(id);
		if (message === undefined) throw new Error(`no message ${id}`);
		return message;
	}
}

// ---- 忘却ジャーナル（DB の外のファイル。ホスト所有）----

export class FakeJournalFile {
	constructor(readonly path: string) {}

	read(): ForgetJournalEntry[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as ForgetJournalEntry);
	}

	/** 追記して fsync する（apply の前に必ず呼ぶ）。 */
	appendDurable(entry: ForgetJournalEntry): void {
		const fd = openSync(this.path, "a");
		try {
			writeSync(fd, `${JSON.stringify(entry)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	/** 試験用: ファイル全体を置き換える（改ざん・欠落の再現）。 */
	overwrite(entries: readonly unknown[]): void {
		writeFileSync(
			this.path,
			entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
		);
	}
}

// ---- ホスト ----

export type StartupStatus =
	| { readonly status: "ready"; readonly reapplied: number }
	| { readonly status: "disabled"; readonly reason: string };

export interface FakeHostOptions {
	/** 既存の DB ファイルを開く（復元・再起動用）。 */
	readonly dbFile?: string;
	/** 既存のジャーナルを使う（再起動時は同じものを渡す）。 */
	readonly journal?: FakeJournalFile;
	readonly directory?: string;
	/** 会話はホスト所有でプロセスをまたいで残る想定。再起動時は同じものを渡す。 */
	readonly conversation?: FakeConversation;
}

export class FakeEumenesHost {
	readonly conversation: FakeConversation;
	readonly journal: FakeJournalFile;
	store: TestStore;
	startup: StartupStatus;
	private readonly directory: string;
	private tail: Promise<unknown> = Promise.resolve();
	private clockMs = 1000;

	constructor(options: FakeHostOptions = {}) {
		this.conversation = options.conversation ?? new FakeConversation();
		this.directory =
			options.directory ?? mkdtempSync(join(tmpdir(), "fake-host-"));
		this.journal =
			options.journal ??
			new FakeJournalFile(join(this.directory, "forget.journal"));
		this.store = openTestStore({
			migrations: HOST_MIGRATIONS,
			...(options.dbFile === undefined ? {} : { fromFile: options.dbFile }),
		});
		this.startup = this.runStartup();
	}

	/** 起動手順（sqlite README の必須手順）。失敗したら Memory を止める（fail closed）。 */
	runStartup(): StartupStatus {
		const problems = checkHostMigrations(HOST_MIGRATIONS);
		if (problems.length > 0) {
			return {
				status: "disabled",
				reason: `migrations: ${problems.join("; ")}`,
			};
		}
		try {
			assertMemorySchema(this.store.writer);
		} catch (error) {
			return {
				status: "disabled",
				reason: `schema: ${(error as { code?: string }).code ?? String(error)}`,
			};
		}
		const entries = this.journal.read();
		const verified = verifyForgetJournal(entries);
		if (verified.status !== "ok") {
			return { status: "disabled", reason: `journal: ${verified.reasonCode}` };
		}
		const reconciled = this.store.write((db) =>
			reconcileForgetJournal(db, {
				contractVersion: 1,
				entries,
				clock: { atMs: this.tick() },
			}),
		);
		if (reconciled.status !== "ok") {
			return {
				status: "disabled",
				reason: `reconcile: ${reconciled.reasonCode}`,
			};
		}
		return { status: "ready", reapplied: reconciled.reapplied };
	}

	private tick(): number {
		this.clockMs += 1;
		return this.clockMs;
	}

	private get memoryOn(): boolean {
		return this.startup.status === "ready";
	}

	/** 書き込みキュー: 1 本ずつ直列に実行する。 */
	private enqueue<T>(job: () => T | Promise<T>): Promise<T> {
		const run = this.tail.then(job, job);
		this.tail = run.catch(() => undefined);
		return run;
	}

	// ---- State ----

	/** message の全文を根拠にして、ユーザーの明示操作で State を書く。 */
	async assertFact(args: {
		readonly messageId: string;
		readonly semanticKey: string;
		readonly value: StateValue;
	}) {
		if (!this.memoryOn) return { status: "skipped" as const };
		const source = this.conversation.source(args.messageId);
		const quote = source.content;
		const evidence: EvidenceSpan = {
			source: {
				namespace: source.namespace,
				kind: source.kind,
				id: source.id,
				...(source.representation === undefined
					? {}
					: { representation: source.representation }),
				revision: source.revision,
				digest: source.digest,
				range: { startByte: 0, endByte: Buffer.byteLength(quote, "utf8") },
			},
			quote,
		};
		return await this.enqueue(() =>
			this.store.write((db) =>
				assertUserState(db, {
					contractVersion: 1,
					access: HOST_ACCESS,
					scopeKey: HOST_SCOPE,
					clock: { atMs: this.tick() },
					kind: "preference",
					subject: "self",
					semanticKey: args.semanticKey,
					value: args.value,
					evidence: [evidence],
					sources: [source],
					origin: "user_confirmed",
				}),
			),
		);
	}

	listItems(includeInactive = false) {
		const listed = this.store.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: HOST_ACCESS,
				scopeKey: HOST_SCOPE,
				includeInactive,
			}),
		);
		if (listed.status !== "ok") throw new Error(`list: ${listed.status}`);
		return listed.items;
	}

	// ---- 忘却 ----

	/**
	 * plan → ジャーナルに fsync 追記 → apply。`crashAfterJournal` なら追記後に apply せず例外（プロセス死の再現）。
	 */
	forgetItem(
		itemId: string,
		options: { readonly crashAfterJournal?: boolean } = {},
	) {
		return this.enqueue(() => {
			const planned = this.store.read((db) =>
				planForget(db, {
					contractVersion: 1,
					access: HOST_ACCESS,
					target: { type: "state_item", itemId, scopeKey: HOST_SCOPE },
					clock: { atMs: this.tick() },
				}),
			);
			if (planned.status !== "planned")
				throw new Error(`plan: ${planned.reasonCode}`);
			this.journal.appendDurable(planned.plan.entry);
			if (options.crashAfterJournal === true)
				throw new Error("simulated crash");
			return this.store.write((db) =>
				applyForget(db, {
					contractVersion: 1,
					entry: planned.plan.entry,
					clock: { atMs: this.tick() },
				}),
			);
		});
	}

	// ---- 運用 ----

	/** DB のコピー（バックアップ）。checkpoint 済みの時点を表す。 */
	backup(label: string): string {
		return this.store.snapshotTo(label);
	}

	/** 再起動: 現在の DB を閉じ、同じファイルとジャーナルで開き直して起動手順を踏む。 */
	restart(): FakeEumenesHost {
		return this.reopenFrom(this.backup("restart"));
	}

	/** 古い DB を復元して起動する（ジャーナルは最新のまま）。 */
	restoreFrom(dbFile: string): FakeEumenesHost {
		return this.reopenFrom(dbFile);
	}

	private reopenFrom(dbFile: string): FakeEumenesHost {
		const next = new FakeEumenesHost({
			dbFile,
			journal: this.journal,
			directory: this.directory,
			conversation: this.conversation,
		});
		this.store.close();
		return next;
	}

	close(): void {
		this.store.close();
		rmSync(this.directory, { recursive: true, force: true });
	}
}
