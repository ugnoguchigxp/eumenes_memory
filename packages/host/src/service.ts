import { createHash, randomUUID } from "node:crypto";
import {
	sliceUtf8Range,
	verifyForgetJournal,
	type HostForgetIntent,
	type SourceRef,
	type StateItem,
} from "eumenes-memory";
import {
	assertMemorySchema,
	captureRecord,
	readRecord,
	readStateFact,
	getForgetReceipt,
	planForget,
	reconcileForgetJournal,
	rebuildStateSearchIndex,
	verifyStateSearchIndex,
	registerExternalDependents,
	unregisterExternalDependents,
	type MemoryDb,
} from "eumenes-memory/sqlite";
import {
	demand,
	failure,
	HOST_LIMITS,
	HostError,
	methodSchemas,
	planApplySchema,
	type Grant,
	type HostConfig,
	type HostResult,
	type Method,
	type MethodParams,
	INTERNAL_PROVENANCES,
	type Provenance,
	type Trust,
} from "./contracts.ts";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
	HOST_SCHEMA_VERSION,
	upgradeHostSchema,
	type AppPort,
} from "./storage.ts";
import { backupStatus, createBackupFiles } from "./backup.ts";
import { runSearch } from "./search.ts";
import { runReview } from "./review.ts";
import { scrubBackups } from "./scrub.ts";
import {
	EXPIRE_PLAN_ID,
	expiresAtMs,
	expiresOnText,
	reactivate,
	recordUse,
	runExpire,
} from "./expiry.ts";
import {
	activeUsage,
	capacityLimits,
	capacityReport,
	NEAR_LIMIT_RATIO,
} from "./capacity.ts";
import {
	accessFor,
	digest,
	grantKey,
	listItems,
	opaqueId,
	referenceKey,
	SnapshotStore,
	sourceState,
	stateFingerprint,
	isAgendaItem,
	type StoredItem,
	type Snapshot,
	type SourceRow,
} from "./state.ts";
import {
	parsePlan,
	planningSchema,
	modelAgendaItems,
	requiresQuote,
	targetItemId,
	type MemoryPlan,
} from "./meaning/planning.ts";
import {
	modelItems,
	type EvidenceStatus,
	type HostItem,
} from "./meaning/model-input.ts";
import type { HostAction } from "./meaning/protocol.ts";
import {
	hostPlanningInstructions,
	hostAgendaPlanningInstructions,
} from "./meaning/planning.ts";
import {
	applyPlan,
	cleanExternal,
	expireUnusedSource,
	recoverIntents,
	operationOutcomeSql,
	scrubHostIntent,
	type StoredPlan,
} from "./operations.ts";

import {
	agendaKey,
	agendaSources,
	applyAgenda,
	isAgendaId,
	listAgenda,
} from "./agenda.ts";

export interface HostOptions {
	port: AppPort;
	configuration: () => HostConfig;
	clock?: () => number;
	/** 試験だけが上限を小さくする（CLI と MCP からは届かない）。指定の無い上限は `HOST_LIMITS`。 */
	limits?: Partial<Record<keyof typeof HOST_LIMITS, number>>;
	/** Tests inject a crash after durable append. Never reachable through CLI/MCP. */
	afterJournalAppend?: () => void;
	/**
	 * バックアップの洗い直し（S4）だけが使う。ジャーナルの再適用で作った host intent は、検証済みの完全なジャーナルの
	 * entry から再適用済みなので完了とし、ジャーナルへの追記を伴う回復を走らせない（ライブのジャーナルを書き換えないため）。
	 */
	replayJournalOnly?: boolean;
	/** Validate and replay an offline restore candidate without appending to the journal. */
	restorePreflight?: boolean;
	/** 試験だけがバックアップの洗い直しを失敗させる。CLI と MCP からは届かない。 */
	beforeBackupScrub?: (file: string) => void;
	/** Trusted application-only resolver. Client assertions never enter this callback as verified facts. */
	resolveSource?: (
		db: MemoryDb,
		ref: SourceRef,
	) => import("eumenes-memory").HostSourceState | undefined;
}
/**
 * 出典を参照（namespace/kind/id）で探す SQL。ホストの表の版 1 からある部分索引 `host_source_ref` を使う
 * （索引の式と同じ式で、`forgotten=0` も同じ。式を変えると索引が使われなくなるので、試験で確かめる）。
 */
export const SOURCE_BY_REF_SQL =
	"SELECT * FROM host_source WHERE scope_key=? AND forgotten=0 AND json_extract(ref,'$.namespace')=? AND json_extract(ref,'$.kind')=? AND json_extract(ref,'$.id')=?";
/** 根拠の版と状態を調べる関数（`MemoryHost.inspectEvidence` と同じ結果）。 */
export type EvidenceInspector = (
	item: StoredItem,
	ref: SourceRef,
) => ReturnType<MemoryHost["inspectEvidence"]>;
export class MemoryHost {
	readonly epoch = randomUUID();
	readonly startedAt: number;
	readonly snapshots: SnapshotStore;
	readonly clock: () => number;
	healthy = false;
	journalCount = 0;
	activeOperation: string | undefined;
	/** 起動時の検査で索引を作り直せなかった（§3.4）。search だけを止め、ほかの操作には影響させない。 */
	searchIndexUnavailable = false;
	readonly inFlight = new Map<string, Promise<HostResult>>();
	private readonly handles = new Map<
		string,
		{ sourceId: string; grantKey: string; policy: string; expiresAt: number }
	>();
	constructor(readonly options: HostOptions) {
		this.clock = options.clock ?? Date.now;
		this.startedAt = this.clock();
		this.snapshots = new SnapshotStore(this.epoch, this.clock);
	}
	limit(name: keyof typeof HOST_LIMITS): number {
		return this.options.limits?.[name] ?? HOST_LIMITS[name];
	}
	get config(): HostConfig {
		return this.options.configuration();
	}
	get policy(): string {
		return digest(this.config);
	}
	access(grant: Grant) {
		return accessFor(this.config.principal, grant.scopeKeys, this.policy);
	}
	private journalAttempt: { attempted: boolean } | undefined;
	private checkpointPending = false;
	/** Wrap the owner's whole transaction, including its commit, without opening another transaction. */
	async write<T>(fn: (db: MemoryDb) => T, recovery = false): Promise<T> {
		const attempt = { attempted: false };
		let value: T;
		try {
			value = await this.options.port.write((db) => {
				demand(
					recovery || (this.healthy && (this.options.port.isReady?.() ?? true)),
					"HOST_NOT_READY",
				);
				this.journalAttempt = attempt;
				try {
					return fn(db);
				} finally {
					this.journalAttempt = undefined;
				}
			});
		} catch (error) {
			if (attempt.attempted) this.failClosed();
			throw error;
		}
		if (!recovery && (attempt.attempted || this.checkpointPending))
			await this.checkpointAfterForget();
		if (!recovery && attempt.attempted) this.queueBackupScrub();
		return value;
	}
	private async checkpointAfterForget(): Promise<void> {
		const port = this.options.port;
		if (!port.checkpoint) return;
		try {
			this.checkpointPending = !(await port.checkpoint());
		} catch {
			this.checkpointPending = true;
		}
	}
	private backupQueue: Promise<unknown> = Promise.resolve();
	/** バックアップの作成と洗い直しを 1 本ずつ行う。 */
	withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
		const task = this.backupQueue.then(fn);
		this.backupQueue = task.catch(() => {});
		return task;
	}
	/** 忘却の後、既存のバックアップを洗い直す（§4C.4 の 2、S4）。忘却の応答は待たせない。 */
	private queueBackupScrub(): void {
		void this.scheduleBackupScrub().catch(() => {});
	}
	async scheduleBackupScrub(): Promise<number> {
		const directory = this.config.backupDirectory;
		if (!directory || !this.options.port.databasePath)
			return Promise.resolve(0);
		return this.withBackupLock(() => scrubBackups(this, directory));
	}
	/** 試験と CLI が、予約済みのバックアップの処理の完了を待つ。 */
	async backupIdle(): Promise<void> {
		await this.backupQueue;
	}
	appendForgetEntry(entry: unknown): void {
		demand(this.journalAttempt, "WRITER_TRANSACTION_REQUIRED");
		this.journalAttempt.attempted = true;
		this.options.port.journal.append(entry);
		this.journalCount++;
	}
	failClosed(): void {
		this.healthy = false;
		this.snapshots.invalidate(this.config.scopeKeys);
		this.options.port.failClosed?.();
	}
	validatePlanDependencies(plan: MemoryPlan<HostAction>): void {
		const forgotten = new Set(
			plan.changes.flatMap((c) =>
				c.actions.flatMap((a) => (a.type === "forget" ? [a.itemId] : [])),
			),
		);
		const corrected = new Set<string>();
		for (const change of plan.changes)
			for (const action of change.actions) {
				if (action.type === "forget") continue;
				const target = targetItemId(action);
				if (target === null) continue;
				if (corrected.has(target))
					throw new HostError(
						"DUPLICATE_CORRECTION_TARGET",
						"needs_clarification",
					);
				corrected.add(target);
			}
		if ([...corrected].some((id) => forgotten.has(id)))
			throw new HostError("DEPENDENT_GROUP_UNSUPPORTED", "needs_clarification");
	}
	authorizeForget(db: MemoryDb, grant: Grant): void {
		this.admin(grant);
		if (grant.confirmedWrites) return;
		// 本人確認済みの item が 1 つでもあるか（全件を水和せずに SQL で探す。listItems と同じ条件で、
		// 全 scope の読み取りの許可が要ることも同じ）。
		demand(
			this.config.scopeKeys.every((s) => grant.scopeKeys.includes(s)),
			"SCOPE_NOT_PERMITTED",
		);
		demand(
			!db
				.query(
					`SELECT 1 AS x FROM memory_state_item i WHERE i.principal=? AND i.scope_key IN (${this.config.scopeKeys.map(() => "?").join(",")}) AND i.status<>'forgotten' AND i.origin IN ('user_confirmed','user_edited') AND NOT EXISTS (SELECT 1 FROM memory_tombstone t WHERE t.target_type='state_item' AND t.target_id=i.item_id) LIMIT 1`,
				)
				.get(this.access(grant).principal, ...this.config.scopeKeys),
			"CONFIRMED_FORGET_REQUIRES_PERMISSION",
		);
	}

	async start(): Promise<void> {
		this.healthy = false;
		try {
			await this.write((db) => {
				assertMemorySchema(db);
				upgradeHostSchema(db);
				const entries = this.options.port.journal.read();
				demand(Array.isArray(entries), "JOURNAL_INVALID");
				this.journalCount = entries.length;
				const verified = verifyForgetJournal(entries as never);
				demand(verified.status === "ok", "JOURNAL_INVALID");
				const result = reconcileForgetJournal(db, {
					contractVersion: 2,
					entries: entries as never,
					clock: { atMs: this.clock() },
				});
				demand(result.status === "ok", "JOURNAL_INCONSISTENT");
				for (const entry of entries as import("eumenes-memory").ForgetJournalEntry[]) {
					if (entry.hostIntent)
						this.scrub(db, entry.hostIntent, entry.forgetId);
					cleanExternal(this, db, entry.forgetId);
				}
				if (this.options.replayJournalOnly)
					for (const entry of entries as import("eumenes-memory").ForgetJournalEntry[]) {
						const intentId = entry.hostIntent?.["host.intent"]?.[0];
						if (intentId)
							db.query(
								"UPDATE host_forget_intent SET completed=1 WHERE id=?",
							).run(intentId);
					}
			}, true);
			if (!this.options.restorePreflight)
				await this.write((db) => {
					recoverIntents(this, db);
					this.cleanup(db);
				}, true);
			// §3.4: 索引を検査し、一致しなければ writer の transaction の中で作り直す。失敗は search だけを止める。
			// 次の checkpoint より前に行い、作り直しで捨てた古い索引のページ（忘れた本文の断片を含みうる）を DB ファイルに残さない。
			await this.write((db) => {
				if (verifyStateSearchIndex(db).consistent) return;
				this.searchIndexUnavailable = !rebuildStateSearchIndex(db).consistent;
			}, true).then(
				() => {},
				() => {
					this.searchIndexUnavailable = true;
				},
			);
			// ジャーナルの再適用や回復、索引の作り直しで消した本文を WAL に残さない（決定 9）。
			await this.checkpointAfterForget();
			if (this.options.restorePreflight) {
				demand(
					!this.searchIndexUnavailable && !this.checkpointPending,
					"RESTORE_PREFLIGHT_FAILED",
				);
				return;
			}
			this.queueBackupScrub();
			// 決定 11: 起動時に、期限を過ぎた外部由来の item を停止する。失敗しても起動は止めない（次回に再試行）。
			if (!this.options.replayJournalOnly)
				await runExpire(this, { recovery: true }).catch(() => {});
			this.healthy = true;
		} catch (error) {
			this.failClosed();
			throw error;
		}
	}
	scrub(db: MemoryDb, intent: HostForgetIntent, forgetId?: string): void {
		scrubHostIntent(this, db, intent);
		this.options.port.applyHostIntent?.(db, intent, forgetId);
		if (intent["host.states"]?.length)
			this.snapshots.invalidate(intent["host.scope"] ?? []);
	}
	/** Application forget hook: own metadata only, without recursively invoking the app purge. */
	invalidateDerivedInTransaction(
		db: MemoryDb,
		input: {
			scopeKeys: readonly string[];
			itemIds: readonly string[];
			forgetIds: readonly string[];
		},
	): void {
		scrubHostIntent(this, db, { "host.states": input.itemIds });
		this.snapshots.invalidate(input.scopeKeys);
		for (const forgetId of input.forgetIds) cleanExternal(this, db, forgetId);
	}

	grant(credential: string, config = this.config): Grant {
		const grant = Object.hasOwn(config.credentials, credential)
			? config.credentials[credential]
			: undefined;
		demand(grant, "AUTH_REQUIRED");
		return grant;
	}
	allowed(grant: Grant, scopes: readonly string[]): void {
		demand(
			scopes.every(
				(s) => grant.scopeKeys.includes(s) && this.config.scopeKeys.includes(s),
			),
			"SCOPE_NOT_PERMITTED",
		);
	}
	admin(grant: Grant): void {
		demand(
			grant.forgetAll &&
				this.config.scopeKeys.every((s) => grant.scopeKeys.includes(s)),
			"FORGET_REQUIRES_ALL_SCOPES",
		);
	}
	async dispatch(
		credential: string,
		method: string,
		input: unknown,
	): Promise<HostResult> {
		try {
			demand(
				this.healthy && (this.options.port.isReady?.() ?? true),
				"HOST_NOT_READY",
			);
			const config = this.config;
			const grant = this.grant(credential, config);
			demand(Object.hasOwn(methodSchemas, method), "UNKNOWN_METHOD");
			const name = method as Method;
			const params = methodSchemas[name].parse(input);
			if (name === "status")
				return {
					status: "ready",
					version: 1,
					epoch: this.epoch,
					scopeKeys: grant.scopeKeys,
					capabilities: {
						read: grant.read,
						write: grant.write,
						forget: grant.forgetAll,
					},
					limits: HOST_LIMITS,
					recovery: "reconciled",
					...(this.options.port.checkpoint
						? { checkpointPending: this.checkpointPending }
						: {}),
					...backupStatus(
						this.config.backupDirectory,
						this.clock(),
						this.startedAt,
						this.journalCount,
					),
					...this.pendingStatus(grant),
					...this.capacityStatus(grant),
				};
			if (name === "context") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return this.context(grant, params as MethodParams<"context">);
			}
			if (name === "review") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return runReview(this, grant, params as MethodParams<"review">);
			}
			if (name === "search") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return runSearch(this, grant, params as MethodParams<"search">);
			}
			if (name === "read") {
				demand(grant.read, "READ_NOT_PERMITTED");
				const read = params as MethodParams<"read">;
				if (read.itemIds) return this.validatePartialSnapshot(credential, read);
				const result = this.read(grant, read);
				demand(this.policy === digest(config), "ACCESS_CHANGED");
				return result;
			}
			if (name === "operation") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return this.options.port.read((db) =>
					this.operation(db, grant, params as MethodParams<"operation">),
				);
			}
			if (name === "use") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return await this.write((db) => {
					const current = this.grant(credential);
					demand(grantKey(current) === grantKey(grant), "ACCESS_CHANGED");
					return this.use(db, current, params as MethodParams<"use">);
				});
			}
			demand(grant.write, "WRITE_NOT_PERMITTED");
			if (name === "backup") return await this.backup(grant);
			if (name === "expire") {
				this.admin(grant);
				return { status: "completed", ...(await runExpire(this)) };
			}
			if (name === "reactivate")
				return await this.write((db) => {
					const current = this.grant(credential);
					demand(grantKey(current) === grantKey(grant), "ACCESS_CHANGED");
					return reactivate(
						this,
						db,
						current,
						(params as MethodParams<"reactivate">).itemId,
					);
				});
			const direct =
				name === "apply" ? (params as MethodParams<"apply">).agenda : undefined;
			if (name === "apply" && !direct)
				return await applyPlan(this, credential, planApplySchema.parse(params));
			return await this.write((db) => {
				const current = this.grant(credential);
				demand(grantKey(current) === grantKey(grant), "ACCESS_CHANGED");
				this.cleanup(db);
				if (direct) return applyAgenda(this, db, current, direct);
				if (name === "source")
					return this.source(db, current, params as MethodParams<"source">);
				if (name === "plan")
					return this.plan(db, current, params as MethodParams<"plan">);
				throw new HostError("UNKNOWN_METHOD");
			});
		} catch (error) {
			return failure(error);
		}
	}
	/**
	 * 決定 11: 回答や行動に採用した item の報告。snapshot に入っていて revision が今のものと一致する item だけを受け付け、
	 * 1 つでも合わなければ全体を拒否する（期限は変えない）。外部由来の item の最終利用日だけを、1 日 1 回まで更新する。
	 * State の変更の seq を進めないので、snapshot と cursor は切れない。
	 */
	use(db: MemoryDb, grant: Grant, p: MethodParams<"use">): HostResult {
		const snapshot = this.snapshots.get(p.snapshotId, grant, this.policy);
		this.allowed(grant, snapshot.scopes);
		const current = new Map(
			listItems(
				db,
				this.access(grant),
				snapshot.scopes,
				Infinity,
				false,
				p.items.map((ref) => ref.itemId),
			).map((x) => [x.itemId, x]),
		);
		const items = p.items.map((ref) => {
			const seen = snapshot.items.find((x) => x.itemId === ref.itemId);
			const item = current.get(ref.itemId);
			demand(seen && !isAgendaItem(seen) && item, "ITEM_NOT_AVAILABLE");
			demand(
				seen.revision === ref.revision && item.revision === ref.revision,
				"STALE_REVISION",
			);
			return item;
		});
		const updated = recordUse(this, db, items);
		return {
			status: "completed",
			items: items.map((item) =>
				this.trust(db, item) === "external"
					? {
							itemId: item.itemId,
							expiresOn: expiresOnText(expiresAtMs(db, item.itemId)),
						}
					: { itemId: item.itemId },
			),
			updated,
		};
	}
	/** §4C.2: 所有者が writer の順番で `VACUUM INTO` し、ジャーナルの写しと一緒に置く。admin の grant が要る。 */
	async backup(grant: Grant): Promise<HostResult> {
		this.admin(grant);
		const directory = this.config.backupDirectory;
		demand(directory, "BACKUP_NOT_CONFIGURED");
		const { exclusive, databasePath, journal } = this.options.port;
		demand(exclusive && databasePath, "BACKUP_UNSUPPORTED");
		const meta = await this.withBackupLock(() =>
			exclusive(() =>
				createBackupFiles({
					databasePath,
					directory,
					journal: this.options.port.journal.read() as unknown[],
					atMs: this.clock(),
					hostSchemaVersion: HOST_SCHEMA_VERSION,
					...(journal.recoveryStoreId
						? { recoveryStoreId: journal.recoveryStoreId }
						: {}),
				}),
			),
		);
		return {
			status: "completed",
			path: join(realpathSync(directory), meta.file),
			bytes: meta.bytes,
			sha256: meta.sha256,
			schemaVersion: meta.schemaVersion,
			journalHead: meta.journalHead,
		};
	}
	/** §4D.2 の 1: 件数、大きさ、使用率と警告。本文は出さない。read の grant の scope だけを数える。 */
	capacityStatus(grant: Grant): Record<string, unknown> {
		if (!grant.read) return {};
		return this.options.port.read((db) =>
			capacityReport({
				db,
				principal: this.config.principal,
				scopeKeys: grant.scopeKeys.filter((s) =>
					this.config.scopeKeys.includes(s),
				),
				limits: capacityLimits((name) => this.limit(name)),
				journalEntries: this.journalCount,
				operationsThisEpoch: (
					db
						.query(
							"SELECT count(*) AS n FROM host_operation WHERE epoch=? AND plan_id<>?",
						)
						.get(this.epoch, EXPIRE_PLAN_ID) as { n: number }
				).n,
				databasePath: this.options.port.databasePath,
			}),
		);
	}
	pendingStatus(grant: Grant): { pendingOperations: number } {
		if (!grant.read) return { pendingOperations: 0 };
		return this.options.port.read((db) => {
			const rows = db
				.query(
					"SELECT id,scope_keys,result FROM host_operation WHERE json_extract(result,'$.status') IN ('pending','partial','indeterminate')",
				)
				.all() as { id: string; scope_keys: string; result: string }[];
			return {
				pendingOperations: rows.filter((r) => {
					const result = JSON.parse(r.result);
					const permitted =
						(JSON.parse(r.scope_keys) as string[]).every((s) =>
							grant.scopeKeys.includes(s),
						) &&
						(!(
							result.forgetRequested ||
							result.localForgetApplied ||
							result.forgetIds?.length
						) ||
							(grant.forgetAll &&
								this.config.scopeKeys.every((s) =>
									grant.scopeKeys.includes(s),
								)));
					return (
						permitted &&
						["pending", "partial", "indeterminate"].includes(
							this.operation(db, grant, {
								operationId: r.id,
								epoch: this.epoch,
							}).status,
						)
					);
				}).length,
			};
		});
	}

	cleanup(db: MemoryDb): void {
		// Keep identity tombstones; only unreferenced text/payload may expire.
		const expired = db
			.query(
				"SELECT id,scope_keys FROM host_plan p WHERE expires_at<=? AND EXISTS(SELECT 1 FROM host_dependent d WHERE d.plan_id=p.id) AND NOT EXISTS(SELECT 1 FROM host_operation o WHERE o.plan_id=p.id AND o.payload IS NOT NULL)",
			)
			.all(this.clock()) as { id: string; scope_keys: string }[];
		for (const plan of expired) {
			const keys = db
				.query("SELECT id FROM host_dependent WHERE plan_id=?")
				.all(plan.id) as { id: string }[];
			for (const scopeKey of JSON.parse(plan.scope_keys) as string[])
				for (let i = 0; i < keys.length; i += 32) {
					const result = unregisterExternalDependents(db, {
						contractVersion: 1,
						access: accessFor(
							this.config.principal,
							this.config.scopeKeys,
							this.policy,
						),
						scopeKey,
						clock: { atMs: this.clock() },
						dependents: keys
							.slice(i, i + 32)
							.map((x) => ({ providerRef: "memory-host", externalId: x.id })),
					});
					demand(result.status === "unregistered", "DEPENDENCY_CLEANUP_FAILED");
				}
			db.query("DELETE FROM host_dependent WHERE plan_id=?").run(plan.id);
		}

		db.query("UPDATE host_plan SET payload=NULL WHERE expires_at <= ?").run(
			this.clock(),
		);
		db.query(
			`UPDATE host_operation SET result=${operationOutcomeSql} WHERE payload IS NOT NULL AND created_at<=?`,
		).run(this.clock() - HOST_LIMITS.payloadTtlMs);
		db.query(
			"UPDATE host_operation SET payload=NULL,result=CASE WHEN EXISTS(SELECT 1 FROM json_each(result,'$.groups') WHERE value='not_run') THEN json_set(result,'$.status','indeterminate','$.code','EXECUTION_PAYLOAD_EXPIRED') ELSE result END WHERE payload IS NOT NULL AND created_at<=?",
		).run(this.clock() - HOST_LIMITS.payloadTtlMs);
		const receiptHorizon = this.clock() - this.limit("receiptTtlMs");
		db.query(
			"DELETE FROM host_operation WHERE epoch<>? AND payload IS NULL AND created_at <= ?",
		).run(this.epoch, receiptHorizon);
		// 決定 8: 今の epoch の受領記録も 30 日で消し、消したことを epoch ごとに記録する。
		// 以後、この epoch で記録の無い ID は「実行しなかった」とは答えず indeterminate にする。
		db.query(
			"DELETE FROM host_operation WHERE epoch=? AND payload IS NULL AND created_at <= ?",
		).run(this.epoch, receiptHorizon);
		const pruned = db.query("SELECT changes() AS n").get() as { n: number };
		if (pruned.n > 0)
			db.query(
				"INSERT INTO host_operation_horizon(epoch,pruned_before) VALUES(?,?) ON CONFLICT(epoch) DO UPDATE SET pruned_before=max(pruned_before,excluded.pruned_before)",
			).run(this.epoch, receiptHorizon);
		const unused = db
			.query(
				`SELECT * FROM host_source WHERE content IS NOT NULL AND created_at < ? AND forgotten=0
				AND NOT EXISTS(SELECT 1 FROM host_state_source s WHERE s.source_id=host_source.id)
				AND NOT EXISTS(SELECT 1 FROM host_agenda a WHERE a.source_id=host_source.id OR a.status_source_id=host_source.id)
				AND NOT EXISTS(SELECT 1 FROM host_plan p WHERE p.payload IS NOT NULL
					AND EXISTS(SELECT 1 FROM json_each(p.payload,'$.sourceIds') j WHERE j.value=host_source.id))
				LIMIT 64`,
			)
			.all(this.clock() - HOST_LIMITS.sourceTtlMs) as SourceRow[];
		for (const row of unused) expireUnusedSource(this, db, row);
	}
	source(db: MemoryDb, grant: Grant, p: MethodParams<"source">): HostResult {
		this.allowed(grant, [p.scopeKey]);
		demand(
			Buffer.byteLength(p.content) <= HOST_LIMITS.sourceBytes,
			"SOURCE_TOO_LARGE",
		);
		const prior = db
			.query(
				"SELECT * FROM host_source WHERE client_id=? AND scope_key=? AND submission_id=?",
			)
			.get(grant.clientId, p.scopeKey, p.submissionId) as SourceRow | null;
		if (prior) {
			demand(!prior.forgotten && prior.content !== null, "SOURCE_UNAVAILABLE");
			demand(
				prior.content === p.content &&
					prior.kind === p.kind &&
					(prior.provenance ?? "unknown") === p.provenance,
				"SUBMISSION_ID_CONFLICT",
			);
			return this.sourceResult(prior, grant);
		}
		const count = db
			.query("SELECT count(*) AS n FROM host_source WHERE content IS NOT NULL")
			.get() as { n: number };
		demand(count.n < HOST_LIMITS.maxSources, "SOURCE_CAPACITY");
		const id = opaqueId();
		const hash = createHash("sha256").update(p.content).digest("hex");
		let ref: SourceRef = {
			namespace: "eumenes-host",
			kind: p.kind === "agent_reply" ? "agent-reply" : "message",
			id,
			representation: "text",
			revision: `sha256:${hash}`,
			digest: hash,
		};
		if (p.kind === "record") {
			const saved = captureRecord(db, {
				contractVersion: 1,
				access: this.access(grant),
				scopeKey: p.scopeKey,
				clock: { atMs: this.clock() },
				origin: { namespace: "host-import", kind: "document", id },
				mediaType: "text/plain",
				content: p.content,
				captureState: "complete",
			});
			demand(saved.status === "captured", "RECORD_REJECTED");
			ref = saved.ref;
		}
		const row: SourceRow = {
			id,
			client_id: grant.clientId,
			submission_id: p.submissionId,
			scope_key: p.scopeKey,
			kind: p.kind,
			content: p.content,
			ref: JSON.stringify(ref),
			origin: "agent_inferred",
			created_at: this.clock(),
			forgotten: 0,
			provenance: p.provenance,
		};
		db.query(
			"INSERT INTO host_source(id,client_id,submission_id,scope_key,kind,content,ref,origin,created_at,provenance) VALUES(?,?,?,?,?,?,?,?,?,?)",
		).run(
			id,
			grant.clientId,
			p.submissionId,
			p.scopeKey,
			p.kind,
			p.content,
			row.ref,
			row.origin,
			row.created_at,
			p.provenance,
		);
		const dependency = registerExternalDependents(db, {
			contractVersion: 1,
			access: this.access(grant),
			scopeKey: p.scopeKey,
			clock: { atMs: this.clock() },
			dependents: [
				{
					providerRef: "memory-host-source",
					externalId: row.id,
					dependsOn: [{ type: "source", id: referenceKey(ref) }],
				},
			],
		});
		demand(dependency.status === "registered", "SOURCE_DEPENDENCY_REJECTED");
		return this.sourceResult(row, grant);
	}
	sourceResult(row: SourceRow, grant: Grant): HostResult {
		for (const [id, entry] of this.handles)
			if (entry.expiresAt <= this.clock()) this.handles.delete(id);
		demand(
			this.handles.size < HOST_LIMITS.sourceHandles,
			"SOURCE_HANDLE_CAPACITY",
		);
		const handle = opaqueId();
		this.handles.set(handle, {
			sourceId: row.id,
			grantKey: grantKey(grant),
			policy: this.policy,
			expiresAt: this.clock() + HOST_LIMITS.planTtlMs,
		});
		return {
			status: "registered",
			sourceHandle: handle,
			scopeKey: row.scope_key,
			origin: row.origin,
			provenance: row.provenance ?? "unknown",
			...(row.kind === "agent_reply" ? { sourceRole: "agent" } : {}),
			byteLength: Buffer.byteLength(row.content ?? ""),
			source: JSON.parse(row.ref),
		};
	}
	sourceByHandle(db: MemoryDb, handle: string, grant: Grant): SourceRow {
		const owned = this.handles.get(handle);
		demand(
			owned &&
				owned.expiresAt > this.clock() &&
				owned.grantKey === grantKey(grant) &&
				owned.policy === this.policy,
			"SOURCE_HANDLE_INVALID",
		);
		const row = db
			.query("SELECT * FROM host_source WHERE id=?")
			.get(owned.sourceId) as SourceRow | null;
		demand(row && !row.forgotten && row.content !== null, "SOURCE_UNAVAILABLE");
		this.allowed(grant, [row.scope_key]);
		if (row.kind === "record") {
			const ref = JSON.parse(row.ref) as SourceRef;
			const record = readRecord(db, {
				contractVersion: 1,
				access: this.access(grant),
				scopeKey: row.scope_key,
				recordId: ref.id,
				revision: ref.revision,
			});
			demand(record.status === "available", "SOURCE_UNAVAILABLE");
		}
		return row;
	}
	checkQuote(
		row: SourceRow,
		range: { startByte: number; endByte: number },
		quote: string,
	): void {
		demand(row.content !== null && !row.forgotten, "SOURCE_UNAVAILABLE");
		const slice = sliceUtf8Range(
			row.content,
			{ startByte: range.startByte, endByte: range.endByte },
			1024,
		);
		demand(slice.status === "ok" && slice.text === quote, "QUOTE_MISMATCH");
	}

	listSnapshotItems(
		db: MemoryDb,
		grant: Grant,
		scopes: readonly string[],
		cap = HOST_LIMITS.snapshotItems,
	): StoredItem[] {
		const items = listItems(db, this.access(grant), scopes, cap);
		if (items.length > cap) return items;
		return [...items, ...listAgenda(db, scopes, cap - items.length + 1)];
	}
	/** Technical identity/version checks only; meaning and applicability remain with the caller's LLM. */
	inspectEvidence(
		db: MemoryDb,
		item: StoredItem,
		ref: SourceRef,
	): { status: EvidenceStatus; version: unknown } {
		if (ref.namespace === "memory") {
			const record = readRecord(db, {
				contractVersion: 1,
				access: accessFor(this.config.principal, [item.scopeKey], this.policy),
				scopeKey: item.scopeKey,
				recordId: ref.id,
				revision: ref.revision,
			});
			return {
				status:
					record.status === "available"
						? record.ref.digest === ref.digest &&
							record.revision === ref.revision
							? "current"
							: "stale"
						: "missing",
				version:
					record.status === "available"
						? [record.status, record.revision, record.ref.digest]
						: [record.status],
			};
		}
		const row = db
			.query(SOURCE_BY_REF_SQL)
			.get(item.scopeKey, ref.namespace, ref.kind, ref.id) as SourceRow | null;
		const source =
			row && row.content !== null
				? sourceState(row, this.config.principal)
				: this.options.resolveSource?.(db, ref);
		if (!source)
			return {
				status:
					this.options.resolveSource || ref.namespace === "eumenes-host"
						? "missing"
						: "unverified",
				version: ["unresolved"],
			};
		if (
			source.principal !== this.config.principal ||
			source.scopeKey !== item.scopeKey ||
			referenceKey(source) !== referenceKey(ref)
		)
			return { status: "missing", version: ["unavailable"] };
		return {
			status:
				source.status === "available" &&
				source.revision === ref.revision &&
				source.digest === ref.digest
					? "current"
					: "stale",
			version: [source.status, source.revision, source.digest],
		};
	}
	/**
	 * 1 つの読み取りの中で、同じ根拠を何度も調べ直さないための `inspectEvidence`（scope と参照の全体で覚える）。
	 * `withEvidenceStatus` と snapshot の指紋（全体と item ごと）が同じ根拠を調べるため。読み取りの外へ持ち出さない。
	 */
	evidenceInspector(db: MemoryDb): EvidenceInspector {
		const seen = new Map<string, ReturnType<MemoryHost["inspectEvidence"]>>();
		return (item, ref) => {
			const key = JSON.stringify([item.scopeKey, ref]);
			let result = seen.get(key);
			if (!result) {
				result = this.inspectEvidence(db, item, ref);
				seen.set(key, result);
			}
			return result;
		};
	}
	withEvidenceStatus(
		db: MemoryDb,
		item: StateItem,
		inspect: EvidenceInspector = (x, ref) => this.inspectEvidence(db, x, ref),
	): HostItem {
		const statuses = item.evidence.map((ref) => inspect(item, ref).status);
		const evidenceStatus: EvidenceStatus = statuses.includes("stale")
			? "stale"
			: statuses.includes("missing")
				? "missing"
				: !statuses.length || statuses.includes("unverified")
					? "unverified"
					: "current";
		const trust = this.trust(db, item);
		return {
			...item,
			evidenceStatus,
			trust,
			...(trust === "external" && item.status === "active"
				? { expiresOn: expiresOnText(expiresAtMs(db, item.itemId)) }
				: {}),
		};
	}
	/**
	 * §4B.3: confirmed は本人確認済みの origin。inferred は根拠の出典がすべて user_message か agent_reasoning。
	 * それ以外（外部由来、由来の分からない出典、ホストの出典に結び付かない根拠）は external。
	 */
	trust(db: MemoryDb, item: StateItem): Trust {
		if (item.origin === "user_confirmed" || item.origin === "user_edited")
			return "confirmed";
		const rows = db
			.query(
				"SELECT s.provenance AS provenance FROM host_state_source l JOIN host_source s ON s.id=l.source_id WHERE l.item_id=?",
			)
			.all(item.itemId) as { provenance: string }[];
		return rows.length > 0 &&
			rows.length >= item.evidence.length &&
			rows.every((r) =>
				INTERNAL_PROVENANCES.includes(r.provenance as Provenance),
			)
			? "inferred"
			: "external";
	}
	fingerprint(
		db: MemoryDb,
		items: readonly StoredItem[],
		inspect: EvidenceInspector = (item, ref) =>
			this.inspectEvidence(db, item, ref),
	): string {
		const facts = items.filter((item) => !isAgendaItem(item));
		const agenda = items.filter(isAgendaItem);
		const versions = [...items]
			.sort((a, b) => a.itemId.localeCompare(b.itemId))
			.flatMap((item) =>
				(isAgendaItem(item) ? [item.evidence] : item.evidence).map((ref) => [
					item.itemId,
					referenceKey(ref),
					inspect(item, ref).version,
				]),
			);
		return digest([
			stateFingerprint(facts),
			versions,
			...(agenda.length ? [agenda] : []),
		]);
	}

	context(grant: Grant, p: MethodParams<"context">): HostResult {
		let snapshot: Snapshot;
		let offset = 0;
		if (p.cursor) {
			const cursor = JSON.parse(
				Buffer.from(p.cursor, "base64url").toString(),
			) as { id: string; offset: number };
			demand(
				Number.isSafeInteger(cursor.offset) && cursor.offset >= 0,
				"INVALID_CURSOR",
			);
			snapshot = this.snapshots.get(cursor.id, grant, this.policy);
			offset = cursor.offset;
			this.checkSnapshot(snapshot, grant);
			if (p.scopeKeys)
				demand(
					digest(p.scopeKeys) === digest(snapshot.scopes),
					"CURSOR_SCOPE_CHANGED",
				);
		} else {
			const scopes = p.scopeKeys ?? grant.scopeKeys;
			this.allowed(grant, scopes);
			snapshot = this.options.port.read((db) => {
				const inspect = this.evidenceInspector(db);
				const value = this.snapshots.create(
					this.listSnapshotItems(db, grant, scopes).map((item) =>
						isAgendaItem(item)
							? item
							: this.withEvidenceStatus(db, item, inspect),
					),
					scopes,
					grant,
					this.policy,
					(items) => this.fingerprint(db, items, inspect),
				);
				return value;
			});
		}
		const items = snapshot.items.slice(offset, offset + p.limit);
		const next = offset + items.length;
		return {
			status: "context",
			epoch: this.epoch,
			snapshotId: snapshot.id,
			scopeKeys: snapshot.scopes,
			items: items.filter((item) => !isAgendaItem(item)),
			agendaItems: items.filter(isAgendaItem),
			coverage: {
				complete: snapshot.complete && next >= snapshot.items.length,
				snapshotComplete: snapshot.complete,
				itemCount: snapshot.items.length,
				returned: items.length,
			},
			...(snapshot.complete && next < snapshot.items.length
				? {
						nextCursor: Buffer.from(
							JSON.stringify({ id: snapshot.id, offset: next }),
						).toString("base64url"),
					}
				: {}),
			proposalSchema: planningSchema(undefined, {
				quoteMode: "range",
				agenda: p.agenda ?? false,
			}),
			instructions: p.agenda
				? hostAgendaPlanningInstructions
				: hostPlanningInstructions,
		};
	}
	private checkSnapshotInTransaction(
		db: MemoryDb,
		snapshot: Snapshot,
		grant: Grant,
	): void {
		demand(
			this.fingerprint(
				db,
				this.listSnapshotItems(db, grant, snapshot.scopes),
				this.evidenceInspector(db),
			) === snapshot.fingerprint,
			"SNAPSHOT_STALE",
		);
	}

	checkSnapshot(snapshot: Snapshot, grant: Grant): void {
		this.options.port.read((db) =>
			this.checkSnapshotInTransaction(db, snapshot, grant),
		);
	}

	/** Only for the application that owns this host's SQLite connection. */
	isContextCurrentInTransaction(
		db: MemoryDb,
		credential: string,
		snapshotId: string,
	): boolean {
		try {
			demand(
				this.healthy && (this.options.port.isReady?.() ?? true),
				"HOST_NOT_READY",
			);
			const config = this.config;
			const grant = this.grant(credential, config);
			demand(grant.read, "READ_NOT_PERMITTED");
			const policy = digest(config);
			const snapshot = this.snapshots.get(snapshotId, grant, policy);
			demand(snapshot.complete, "COMPLETE_SNAPSHOT_REQUIRED");
			this.checkSnapshotInTransaction(db, snapshot, grant);
			return this.policy === policy;
		} catch (error) {
			if (error instanceof HostError) return false;
			throw error;
		}
	}

	private validatePartialSnapshot(
		credential: string,
		p: MethodParams<"read">,
	): HostResult {
		const { itemIds, snapshotId } = p;
		demand(
			itemIds && snapshotId && !p.itemId && !p.sourceHandle,
			"INVALID_INPUT",
		);
		return this.options.port.read((db) => {
			const config = this.config;
			const grant = this.grant(credential, config);
			demand(grant.read, "READ_NOT_PERMITTED");
			const policy = digest(config);
			const snapshot = this.snapshots.get(snapshotId, grant, policy);
			demand(!snapshot.complete && snapshot.pool === "search", "INVALID_INPUT");
			demand(
				itemIds.every((id) => snapshot.itemFingerprints.has(id)),
				"ITEM_NOT_AVAILABLE",
			);
			const current = listItems(
				db,
				accessFor(config.principal, grant.scopeKeys, policy),
				snapshot.scopes,
				Infinity,
				false,
				itemIds,
			);
			demand(current.length === new Set(itemIds).size, "ITEM_NOT_AVAILABLE");
			demand(
				current.every(
					(item) =>
						this.fingerprint(db, [item]) ===
						snapshot.itemFingerprints.get(item.itemId),
				),
				"SNAPSHOT_STALE",
			);
			demand(this.policy === policy, "ACCESS_CHANGED");
			return { status: "found", snapshotId, epoch: this.epoch, current: true };
		});
	}

	read(grant: Grant, p: MethodParams<"read">): HostResult {
		return this.options.port.read((db) => {
			if (p.sourceHandle) {
				demand(!p.itemId && !p.snapshotId, "INVALID_INPUT");
				const row = this.sourceByHandle(db, p.sourceHandle, grant);
				return {
					status: "found",
					source: sourceState(row, this.config.principal),
					origin: row.origin,
					...(row.kind === "agent_reply" ? { sourceRole: "agent" } : {}),
				};
			}
			demand(p.snapshotId, "INVALID_INPUT");
			const snapshot = this.snapshots.get(p.snapshotId, grant, this.policy);
			if (snapshot.complete)
				this.checkSnapshotInTransaction(db, snapshot, grant);
			if (!p.itemId) {
				demand(snapshot.complete, "COMPLETE_SNAPSHOT_REQUIRED");
				return {
					status: "found",
					snapshotId: snapshot.id,
					epoch: this.epoch,
					current: true,
				};
			}
			const seen = snapshot.items.find((x) => x.itemId === p.itemId);
			const item =
				seen && isAgendaItem(seen)
					? this.listSnapshotItems(db, grant, snapshot.scopes).find(
							(x) => x.itemId === p.itemId,
						)
					: listItems(
							db,
							this.access(grant),
							snapshot.scopes,
							Infinity,
							false,
							[p.itemId],
						)[0];
			demand(seen && item, "ITEM_NOT_AVAILABLE");
			if (!snapshot.complete)
				demand(
					this.fingerprint(db, [item]) ===
						snapshot.itemFingerprints.get(item.itemId),
					"SNAPSHOT_STALE",
				);
			const refs = isAgendaItem(item) ? [item.evidence] : item.evidence;
			const sources = refs.map((ref) => {
				const inspected = this.inspectEvidence(db, item, ref);
				if (inspected.status !== "current") return { status: inspected.status };
				const row = (
					db
						.query(SOURCE_BY_REF_SQL)
						.all(item.scopeKey, ref.namespace, ref.kind, ref.id) as SourceRow[]
				).find(
					(r) => r.ref && referenceKey(JSON.parse(r.ref)) === referenceKey(ref),
				);
				if (row && row.content !== null)
					return {
						...this.sourceResult(row, grant),
						quote: ref.range ? sliceUtf8Range(row.content!, ref.range) : null,
					};
				if (ref.namespace === "memory") {
					const result = readRecord(db, {
						contractVersion: 1,
						access: this.access(grant),
						scopeKey: item.scopeKey,
						recordId: ref.id,
						revision: ref.revision,
					});
					return result;
				}
				const resolved = this.options.resolveSource?.(db, ref);
				if (
					!resolved ||
					resolved.principal !== this.config.principal ||
					resolved.scopeKey !== item.scopeKey
				)
					return { status: "missing" };
				return resolved.status === "available" &&
					resolved.revision === ref.revision &&
					resolved.digest === ref.digest
					? { status: "available", source: resolved }
					: { status: "stale" };
			});
			return {
				status: "found",
				item: isAgendaItem(item) ? item : this.withEvidenceStatus(db, item),
				sources,
			};
		});
	}
	plan(db: MemoryDb, grant: Grant, p: MethodParams<"plan">): HostResult {
		demand(grant.read, "READ_NOT_PERMITTED");
		this.allowed(grant, [p.scopeKey]);
		const snapshot = this.snapshots.get(p.snapshotId, grant, this.policy);
		demand(
			snapshot.complete && snapshot.scopes.includes(p.scopeKey),
			"COMPLETE_SNAPSHOT_REQUIRED",
		);
		demand(
			this.fingerprint(
				db,
				this.listSnapshotItems(db, grant, snapshot.scopes),
			) === snapshot.fingerprint,
			"SNAPSHOT_STALE",
		);
		let parsed: MemoryPlan<HostAction>;
		try {
			const items = snapshot.items.filter((x) => x.scopeKey === p.scopeKey);
			parsed = parsePlan(
				JSON.stringify(p.proposal),
				modelItems(items.filter((item) => !isAgendaItem(item))),
				"",
				modelAgendaItems(items.filter(isAgendaItem)),
			);
		} catch {
			throw new HostError("INVALID_PROPOSAL");
		}
		this.validatePlanDependencies(parsed);
		// §4D.2 の 2: 90% を超えたら新しい key の保存だけを止める。訂正と忘却は通す（容量を減らす操作を止めない）。
		if (
			parsed.changes.some((c) =>
				c.actions.some(
					(a) => a.type === "remember" && a.replacesItemId === null,
				),
			)
		) {
			const usage = activeUsage(db, this.config.principal, snapshot.scopes);
			demand(
				usage.items < NEAR_LIMIT_RATIO * this.limit("snapshotItems") &&
					usage.bytes < NEAR_LIMIT_RATIO * this.limit("snapshotBytes"),
				"CAPACITY_NEAR_LIMIT",
			);
		}
		const evidence = p.evidence.map((e) => {
			const row = this.sourceByHandle(db, e.sourceHandle, grant);
			demand(row.scope_key === p.scopeKey, "SOURCE_SCOPE_MISMATCH");
			return {
				...e,
				sourceId: row.id,
				revision: sourceState(row, this.config.principal).revision,
			};
		});
		const sources = p.sourceHandles.map((s) =>
			this.sourceByHandle(db, s, grant),
		);
		for (const row of sources)
			demand(row.scope_key === p.scopeKey, "SOURCE_SCOPE_MISMATCH");
		const changes = parsed.changes.flatMap((c) => c.actions);
		demand(
			p.evidence.length === changes.filter(requiresQuote).length,
			"EVIDENCE_COUNT_MISMATCH",
		);
		demand(
			new Set(evidence.map((e) => e.actionIndex)).size === evidence.length,
			"DUPLICATE_EVIDENCE",
		);
		for (const change of parsed.changes) {
			const action = change.actions[0];
			if (action && requiresQuote(action)) {
				const e = evidence.find((x) => x.actionIndex === change.actionIndex);
				demand(e, "EVIDENCE_REQUIRED");
				const row = db
					.query("SELECT * FROM host_source WHERE id=?")
					.get(e.sourceId) as SourceRow;
				demand(
					action.type === "remember"
						? row.kind !== "agent_reply"
						: row.kind === "text",
					"SOURCE_ROLE_MISMATCH",
				);
				this.checkQuote(row, e, action.quote);
			}
			for (const action of change.actions) {
				const item = snapshot.items.find(
					(x) => x.itemId === targetItemId(action),
				);
				if (
					item &&
					!isAgendaItem(item) &&
					(item.origin === "user_confirmed" || item.origin === "user_edited")
				)
					demand(grant.confirmedWrites, "CONFIRMED_WRITE_NOT_PERMITTED");
			}
			// §4B.3 の 4: 外部由来の根拠だけでは、行動を縛る記憶を保存せず、外部でない記憶も置き換えない。
			// 本人確認済みの保護（CONFIRMED_WRITE_NOT_PERMITTED）を先に検査する。
			const remembered = change.actions[0];
			const proof = evidence.find((x) => x.actionIndex === change.actionIndex);
			if (remembered?.type === "remember" && proof) {
				const source = db
					.query("SELECT provenance FROM host_source WHERE id=?")
					.get(proof.sourceId) as { provenance: string } | null;
				if (
					!INTERNAL_PROVENANCES.includes(
						(source?.provenance ?? "unknown") as Provenance,
					)
				) {
					demand(
						remembered.kind !== "constraint",
						"EXTERNAL_EVIDENCE_NOT_ALLOWED",
					);
					const replaced = remembered.replacesItemId
						? snapshot.items.find((x) => x.itemId === remembered.replacesItemId)
						: undefined;
					demand(
						!replaced ||
							(!isAgendaItem(replaced) &&
								this.trust(db, replaced) === "external"),
						"EXTERNAL_EVIDENCE_NOT_ALLOWED",
					);
				}
			}
		}
		for (const indexes of parsed.groups) {
			const kinds = new Set(
				indexes.flatMap((i) =>
					parsed.changes[i]!.actions.map((a) =>
						a.type === "forget" ? "forget" : "write",
					),
				),
			);
			if (kinds.size >= 2)
				throw new HostError("MIXED_GROUP_UNSUPPORTED", "needs_clarification");
		}
		if (sources.length || changes.some((a) => a.type === "forget"))
			this.authorizeForget(db, grant);
		// Removing a complete source while retaining another assertion derived from it is unsupported.
		const removedSourceIds = new Set(sources.map((s) => s.id));
		if (evidence.some((e) => removedSourceIds.has(e.sourceId)))
			throw new HostError("SOURCE_RETENTION_CONFLICT", "needs_clarification");
		const selectedIds = new Set(
			changes.flatMap((a) => (a.type === "forget" ? [a.itemId] : [])),
		);
		for (const row of sources) {
			const retained = listItems(
				db,
				this.access(grant),
				this.config.scopeKeys,
			).some(
				(x) =>
					!selectedIds.has(x.itemId) &&
					x.evidence.some(
						(r) => referenceKey(r) === referenceKey(JSON.parse(row.ref)),
					),
			);
			if (retained)
				throw new HostError("SOURCE_RETENTION_CONFLICT", "needs_clarification");
		}
		const count = db
			.query("SELECT count(*) AS n FROM host_plan WHERE payload IS NOT NULL")
			.get() as { n: number };
		demand(count.n < HOST_LIMITS.maxPlans, "PLAN_CAPACITY");
		const id = opaqueId();
		const stored: StoredPlan = {
			id,
			epoch: this.epoch,
			scopeKey: p.scopeKey,
			scopes: snapshot.scopes,
			policy: this.policy,
			grantKey: grantKey(grant),
			fingerprint: snapshot.fingerprint,
			parsed,
			evidence,
			sourceIds: [
				...new Set([
					...evidence.map((e) => e.sourceId),
					...sources.map((s) => s.id),
				]),
			],
			forgetSources: sources.map((s) => ({
				id: s.id,
				key: referenceKey(JSON.parse(s.ref)),
				...(s.kind === "record"
					? { recordId: (JSON.parse(s.ref) as SourceRef).id }
					: {}),
			})),
			createdAt: this.clock(),
		};
		db.query(
			"INSERT INTO host_plan(id,scope_keys,payload,created_at,expires_at) VALUES(?,?,?,?,?)",
		).run(
			id,
			JSON.stringify(snapshot.scopes),
			JSON.stringify(stored),
			this.clock(),
			this.clock() + HOST_LIMITS.planTtlMs,
		);
		// A plan is derived from the supplied context. Register every read item, in bounded batches.
		const dependencies = [
			...snapshot.items.flatMap<{
				scope: string;
				ref: { type: "source" | "state_item"; id: string };
			}>((item) =>
				isAgendaItem(item)
					? [agendaKey(item.itemId), ...agendaSources(db, item.itemId)].map(
							(id) => ({
								scope: item.scopeKey,
								ref: { type: "source" as const, id },
							}),
						)
					: [
							{
								scope: item.scopeKey,
								ref: { type: "state_item" as const, id: item.itemId },
							},
						],
			),
			...stored.sourceIds.map((sourceId) => {
				const row = db
					.query("SELECT * FROM host_source WHERE id=?")
					.get(sourceId) as SourceRow;
				return {
					scope: row.scope_key,
					ref: {
						type: "source" as const,
						id: referenceKey(JSON.parse(row.ref)),
					},
				};
			}),
		];
		this.registerPlanDependencies(db, grant, id, dependencies);
		const targets: import("eumenes-memory/sqlite").ForgetTarget[] = [];
		for (const itemId of selectedIds) {
			if (isAgendaId(itemId)) {
				targets.push({
					type: "host_source",
					scopeKey: p.scopeKey,
					sourceKey: agendaKey(itemId),
				});
				continue;
			}
			const fact = readStateFact(db, {
				contractVersion: 1,
				access: this.access(grant),
				scopeKey: p.scopeKey,
				itemId,
			});
			demand(fact.status === "ok", "FORGET_TARGET_MISSING");
			for (const oldId of fact.itemIds)
				targets.push({
					type: "state_item",
					scopeKey: p.scopeKey,
					itemId: oldId,
				});
		}
		for (const row of sources)
			targets.push(
				row.kind === "record"
					? {
							type: "record",
							scopeKey: p.scopeKey,
							recordId: (JSON.parse(row.ref) as SourceRef).id,
						}
					: {
							type: "host_source",
							scopeKey: p.scopeKey,
							sourceKey: referenceKey(JSON.parse(row.ref)),
						},
			);
		const batches = [];
		for (let i = 0; i < targets.length; i += 64) {
			const preview = planForget(db, {
				contractVersion: 2,
				access: this.access(grant),
				targets: targets.slice(i, i + 64),
				clock: { atMs: this.clock() },
			});
			demand(preview.status === "planned", "FORGET_REJECTED");
			batches.push({
				targets: targets.slice(i, i + 64),
				counts: preview.plan.closure.counts,
				externalProviders: preview.plan.externalProviders,
			});
		}
		return {
			status: parsed.clarification ? "needs_clarification" : "planned",
			...(targets.length
				? {
						forgetPreview: {
							includesOriginalSources: sources.length > 0,
							batches,
							countsMayOverlap: true,
						},
					}
				: {}),
			planId: id,
			epoch: this.epoch,
			clarification: parsed.clarification,
			groups: parsed.groups,
			sourceIncluded: sources.length > 0,
			changes: parsed.changes.map((c) => ({
				actionIndex: c.actionIndex,
				relation: c.relation,
				relatedItemIds: c.relatedItemIds,
			})),
		};
	}
	/** Track both the inputs and committed outputs of a plan until every text payload is gone. */
	registerPlanDependencies(
		db: MemoryDb,
		grant: Grant,
		planId: string,
		dependencies: readonly {
			scope: string;
			ref: { type: "state_item" | "source"; id: string };
		}[],
	): void {
		for (const scope of new Set(dependencies.map((x) => x.scope))) {
			const selected = [
				...new Map(
					dependencies
						.filter((x) => x.scope === scope)
						.map(
							({ ref }) => [JSON.stringify([ref.type, ref.id]), ref] as const,
						),
				).values(),
			];
			for (let n = 0; n < selected.length; n += 32) {
				const externalId = `${planId}.${opaqueId()}`;
				const saved = registerExternalDependents(db, {
					contractVersion: 1,
					access: this.access(grant),
					scopeKey: scope,
					clock: { atMs: this.clock() },
					dependents: [
						{
							providerRef: "memory-host",
							externalId,
							dependsOn: selected.slice(n, n + 32),
						},
					],
				});
				demand(saved.status === "registered", "DEPENDENCY_REJECTED");
				db.query("INSERT INTO host_dependent VALUES(?,?)").run(
					externalId,
					planId,
				);
			}
		}
	}

	/** 今の epoch で受領記録を消した時刻の上限。消していなければ undefined（決定 8）。 */
	receiptHorizon(db: MemoryDb): number | undefined {
		const row = db
			.query("SELECT pruned_before FROM host_operation_horizon WHERE epoch=?")
			.get(this.epoch) as { pruned_before: number } | null;
		return row?.pruned_before;
	}
	operation(
		db: MemoryDb,
		grant: Grant,
		p: MethodParams<"operation">,
	): HostResult {
		const row = db
			.query("SELECT * FROM host_operation WHERE id=?")
			.get(p.operationId) as {
			scope_keys: string;
			result: string;
			payload: string | null;
		} | null;
		if (!row) {
			if (p.epoch === this.epoch && this.receiptHorizon(db) !== undefined)
				return {
					status: "indeterminate",
					code: "OPERATION_RECEIPT_EXPIRED",
					operationId: p.operationId,
				};
			return {
				status: p.epoch === this.epoch ? "blocked" : "indeterminate",
				code: "OPERATION_NOT_RECORDED",
				operationId: p.operationId,
			};
		}
		this.allowed(grant, JSON.parse(row.scope_keys));
		const result = JSON.parse(row.result) as HostResult;
		if (
			result["forgetRequested"] ||
			result["localForgetApplied"] ||
			(Array.isArray(result["forgetIds"]) && result["forgetIds"].length)
		)
			this.admin(grant);
		if (result.status === "pending") {
			const groups = result["groups"];
			const terminal =
				Array.isArray(groups) &&
				groups.every((x) => ["applied", "skipped", "blocked"].includes(x));
			if (!terminal)
				return row.payload === null
					? {
							...result,
							status: "indeterminate",
							code: "EXECUTION_PAYLOAD_UNAVAILABLE",
						}
					: result;
			const ids = result["forgetIds"];
			if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
				return {
					...result,
					status: "indeterminate",
					code: "OPERATION_METADATA_INVALID",
				};
			for (const forgetId of ids) {
				const receipt = getForgetReceipt(db, {
					contractVersion: 2,
					access: this.access(grant),
					forgetId,
				});
				if (receipt.status !== "found")
					return {
						...result,
						status: "indeterminate",
						code: "RECEIPT_UNAVAILABLE",
					};
				if (!receipt.receipt.completed) return result;
			}
			if (typeof result["clarificationRequired"] !== "boolean")
				return {
					...result,
					status: "indeterminate",
					code: "OPERATION_COMPLETION_METADATA_MISSING",
				};
			return {
				...result,
				status: result["clarificationRequired"]
					? "needs_clarification"
					: "completed",
			};
		}
		return result;
	}
}
