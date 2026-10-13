/**
 * Eumenes の模擬ホスト（テスト専用）。実 Eumenes に触れず、ホストが Memory に渡す入力と運用の形を再現する。
 *
 * 再現するもの（Eumenes の構成を README の対応表と persistence-design に合わせた想定）:
 * - 会話 message（追加・編集・削除）と、その SourceState（revision = "sha256:" + digest、編集で changed、削除で missing）。
 * - 直列の書き込みキュー（`store.write` は 1 本ずつ）。モデル呼び出し（execute）はキューの外で非同期に走る。
 * - 抽出 job: prepare → execute（遅延中に会話が変わりうる）→ settle の 3 段。
 * - 対話: View v2 を build → 回答生成（非同期）→ 採用 transaction で `validateMemoryViewV2` を読み直しで行う。
 * - 忘却: plan → ジャーナルへ fsync 追記 → apply。途中でクラッシュする点も作れる。
 * - 起動手順: migration の部分列検査 → `assertMemorySchema` → ジャーナル検証 → reconcile。失敗したら Memory を止める。
 * - 再起動と、古い DB の復元。
 *
 * これは H（ホスト結合）段階の証明ではない。実 Eumenes の Writer / queue とは別物で、想定した形を決定的に試す道具。
 * モデルは使わない（ExtractorPort は呼び出し側が渡す）。ネットワーク・実時間・乱数を使わない。
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
import {
	buildMemoryViewV2,
	composeSnapshotV2,
	validateMemoryViewV2,
	verifyForgetJournal,
} from "eumenes-memory";
import type {
	AccessContext,
	ExtractionInput,
	ExtractorPort,
	MemoryViewV2,
	SnapshotV2,
	SourceState,
} from "eumenes-memory";
import {
	applyForget,
	assertMemorySchema,
	checkHostMigrations,
	confirmCandidate,
	listCandidates,
	listState,
	migrations,
	planForget,
	prepareExtraction,
	readMemorySnapshotPart,
	reconcileForgetJournal,
	settleExtraction,
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

export type AutoPolicy = "auto" | "confirm";
const POLICY = {
	auto: {
		preference: "auto_admit",
		personal_fact: "auto_admit",
		constraint: "auto_admit",
		habit: "auto_admit",
		other_person_note: "user_confirm",
	},
	confirm: {
		preference: "user_confirm",
		personal_fact: "user_confirm",
		constraint: "user_confirm",
		habit: "user_confirm",
		other_person_note: "user_confirm",
	},
} as const;

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
	/** Continuity の revision の代わり（会話が変わるたびに増える不透明な値）。 */
	private version = 0;

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
		this.version += 1;
		return id;
	}

	edit(id: string, text: string): void {
		this.require(id).text = text;
		this.version += 1;
	}

	remove(id: string): void {
		this.require(id).deleted = true;
		this.version += 1;
	}

	get revision(): string {
		return String(this.version);
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

	/** prepare に渡す入力（順位と role つき）。 */
	source(id: string): SourceState & {
		readonly ordinal: number;
		readonly role: MessageRole;
	} {
		const message = this.require(id);
		return { ...this.state(id), ordinal: message.ordinal, role: message.role };
	}

	allIds(): string[] {
		return [...this.messages.keys()];
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

export type ExtractOutcome =
	| { readonly status: "applied"; readonly result: unknown }
	| { readonly status: "skipped"; readonly reason: string };

export type DialogueOutcome =
	| {
			readonly status: "adopted";
			readonly reply: string;
			readonly view: MemoryViewV2;
	  }
	| { readonly status: "rejected"; readonly reasonCode: string }
	| { readonly status: "memory_off"; readonly reason: string };

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

	// ---- 抽出 ----

	/**
	 * 抽出 job。prepare と settle はキュー内の別 transaction、execute はキューの外。
	 * `during` は execute の最中（settle 前）に会話を変えるための差し込み口。
	 */
	async extract(args: {
		readonly jobId: string;
		readonly messageIds: readonly string[];
		readonly extractor: ExtractorPort;
		readonly policy?: AutoPolicy;
		readonly during?: () => void;
		readonly attempt?: number;
	}): Promise<ExtractOutcome> {
		if (!this.memoryOn) return { status: "skipped", reason: "memory_off" };
		const attempt = args.attempt ?? 1;
		const prepared = await this.enqueue(() =>
			this.store.write((db) =>
				prepareExtraction(db, {
					contractVersion: 1,
					access: HOST_ACCESS,
					scopeKey: HOST_SCOPE,
					clock: { atMs: this.tick() },
					run: { jobId: args.jobId, attempt },
					enabled: true,
					sources: args.messageIds.map((id) =>
						this.conversation.source(id),
					) as never,
					profile: {
						extractorId: "fake",
						promptVersion: "fake-1",
						providerRef: "fake-provider",
					},
					maxInputBytes: 65536,
				}),
			),
		);
		if (prepared.status !== "ready") {
			return { status: "skipped", reason: `prepare:${prepared.status}` };
		}
		const input: ExtractionInput = prepared.input;
		const output = await args.extractor(input, new AbortController().signal);
		args.during?.();
		const result = await this.enqueue(() =>
			this.store.write((db) =>
				settleExtraction(db, {
					contractVersion: 1,
					access: HOST_ACCESS,
					scopeKey: HOST_SCOPE,
					clock: { atMs: this.tick() },
					run: { jobId: args.jobId, attempt },
					output,
					currentSources: args.messageIds.map((id) =>
						this.conversation.state(id),
					) as never,
					policy: POLICY[args.policy ?? "confirm"],
				}),
			),
		);
		return { status: "applied", result };
	}

	listPending() {
		const listed = this.store.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: HOST_ACCESS,
				scopeKey: HOST_SCOPE,
			}),
		);
		if (listed.status !== "ok") throw new Error(`list: ${listed.status}`);
		return listed.candidates;
	}

	confirm(candidateId: string, action: "admit" | "reject") {
		return this.enqueue(() =>
			this.store.write((db) =>
				confirmCandidate(db, {
					contractVersion: 1,
					access: HOST_ACCESS,
					scopeKey: HOST_SCOPE,
					clock: { atMs: this.tick() },
					candidateId,
					action,
					currentSources: this.conversation
						.allIds()
						.map((id) => this.conversation.state(id)) as never,
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

	// ---- 対話 ----

	/** 1 つの read transaction で Memory 部品と会話の出典状態を読み、snapshot に合成する。 */
	snapshot(): SnapshotV2 {
		return this.store.read((db) => {
			const part = readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: HOST_ACCESS,
				scopeKey: HOST_SCOPE,
			});
			if (part.status !== "ok") throw new Error(`snapshot: ${part.status}`);
			const messageIds = new Set<string>();
			for (const item of part.items) {
				for (const dependency of item.dependencies) {
					if (dependency.namespace === "conversation")
						messageIds.add(dependency.id);
				}
			}
			return composeSnapshotV2({
				principal: HOST_PRINCIPAL,
				scopeKey: HOST_SCOPE,
				policyRevision: "1",
				complete: true,
				continuity: {
					revision: this.conversation.revision,
					items: [],
					sources: [...messageIds].map((id) => this.conversation.state(id)),
				},
				memory: part,
			});
		});
	}

	buildView(): MemoryViewV2 {
		return buildMemoryViewV2({
			schemaVersion: 2,
			access: HOST_ACCESS,
			snapshot: this.snapshot(),
			maxBytes: 16_384,
			enabled: this.memoryOn,
		});
	}

	/**
	 * 対話 1 ターン。view を作り、回答を生成し（非同期。この間に状態が変わりうる）、
	 * 採用 transaction で読み直した最新状態に対して再検証する。
	 */
	async dialogue(args: {
		readonly reply: (view: MemoryViewV2) => string | Promise<string>;
		readonly during?: () => void | Promise<void>;
	}): Promise<DialogueOutcome> {
		if (!this.memoryOn) {
			return {
				status: "memory_off",
				reason: this.startup.status === "disabled" ? this.startup.reason : "",
			};
		}
		const view = this.buildView();
		const reply = await args.reply(view);
		await args.during?.();
		return await this.enqueue(() =>
			this.store.read(() => {
				const validated = validateMemoryViewV2(view, {
					schemaVersion: 2,
					access: HOST_ACCESS,
					snapshot: this.snapshot(),
				});
				return validated.status === "valid"
					? { status: "adopted" as const, reply, view }
					: { status: "rejected" as const, reasonCode: validated.reasonCode };
			}),
		);
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
