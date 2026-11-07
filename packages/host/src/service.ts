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
	type Grant,
	type HostConfig,
	type HostResult,
	type Method,
	type MethodParams,
} from "./contracts.ts";
import { hostSchemaSql, type AppPort } from "./storage.ts";
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
	type Snapshot,
	type SourceRow,
} from "./state.ts";
import {
	parsePlan,
	planningSchema,
	type MemoryPlan,
} from "./meaning/planning.ts";
import {
	modelItems,
	type EvidenceStatus,
	type HostItem,
} from "./meaning/model-input.ts";
import { hostPlanningInstructions } from "./meaning/planning.ts";
import {
	applyPlan,
	cleanExternal,
	expireUnusedSource,
	recoverIntents,
	operationOutcomeSql,
	scrubHostIntent,
	type StoredPlan,
} from "./operations.ts";

export interface HostOptions {
	port: AppPort;
	configuration: () => HostConfig;
	clock?: () => number;
	/** Tests inject a crash after durable append. Never reachable through CLI/MCP. */
	afterJournalAppend?: () => void;
	/** Trusted application-only resolver. Client assertions never enter this callback as verified facts. */
	resolveSource?: (
		db: MemoryDb,
		ref: SourceRef,
	) => import("eumenes-memory").HostSourceState | undefined;
}
export class MemoryHost {
	readonly epoch = randomUUID();
	readonly snapshots: SnapshotStore;
	readonly clock: () => number;
	healthy = false;
	journalCount = 0;
	activeOperation: string | undefined;
	readonly inFlight = new Map<string, Promise<HostResult>>();
	private readonly handles = new Map<
		string,
		{ sourceId: string; grantKey: string; policy: string; expiresAt: number }
	>();
	constructor(readonly options: HostOptions) {
		this.clock = options.clock ?? Date.now;
		this.snapshots = new SnapshotStore(this.epoch, this.clock);
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
	/** Wrap the owner's whole transaction, including its commit, without opening another transaction. */
	async write<T>(fn: (db: MemoryDb) => T, recovery = false): Promise<T> {
		const attempt = { attempted: false };
		try {
			return await this.options.port.write((db) => {
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
	validatePlanDependencies(plan: MemoryPlan): void {
		const forgotten = new Set(
			plan.changes.flatMap((c) =>
				c.actions.flatMap((a) => (a.type === "forget" ? [a.itemId] : [])),
			),
		);
		const corrected = new Set<string>();
		for (const change of plan.changes)
			for (const action of change.actions) {
				if (action.type !== "remember" || action.replacesItemId === null)
					continue;
				if (corrected.has(action.replacesItemId))
					throw new HostError(
						"DUPLICATE_CORRECTION_TARGET",
						"needs_clarification",
					);
				corrected.add(action.replacesItemId);
			}

		if (
			plan.changes.some((c) =>
				c.actions.some(
					(a) =>
						a.type === "remember" &&
						a.replacesItemId !== null &&
						forgotten.has(a.replacesItemId),
				),
			)
		)
			throw new HostError("DEPENDENT_GROUP_UNSUPPORTED", "needs_clarification");
	}
	authorizeForget(db: MemoryDb, grant: Grant): void {
		this.admin(grant);
		if (!grant.confirmedWrites)
			demand(
				!listItems(
					db,
					this.access(grant),
					this.config.scopeKeys,
					Infinity,
					true,
				).some(
					(x) => x.origin === "user_confirmed" || x.origin === "user_edited",
				),
				"CONFIRMED_FORGET_REQUIRES_PERMISSION",
			);
	}

	async start(): Promise<void> {
		this.healthy = false;
		try {
			await this.write((db) => {
				assertMemorySchema(db);
				db.exec(hostSchemaSql);
				const version = db.query("SELECT version FROM host_schema").get() as {
					version: number;
				};
				demand(version.version === 1, "HOST_SCHEMA_MISMATCH");
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
			}, true);
			await this.write((db) => {
				recoverIntents(this, db);
				this.cleanup(db);
			}, true);
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

	grant(credential: string): Grant {
		const grant = this.config.credentials[credential];
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
			const grant = this.grant(credential);
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
					...this.pendingStatus(grant),
				};
			if (name === "context") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return this.context(grant, params as MethodParams<"context">);
			}
			if (name === "read") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return this.read(grant, params as MethodParams<"read">);
			}
			if (name === "operation") {
				demand(grant.read, "READ_NOT_PERMITTED");
				return this.options.port.read((db) =>
					this.operation(db, grant, params as MethodParams<"operation">),
				);
			}
			demand(grant.write, "WRITE_NOT_PERMITTED");
			if (name === "apply")
				return await applyPlan(
					this,
					credential,
					params as MethodParams<"apply">,
				);
			return await this.write((db) => {
				const current = this.grant(credential);
				demand(grantKey(current) === grantKey(grant), "ACCESS_CHANGED");
				this.cleanup(db);
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
		db.query(
			"DELETE FROM host_operation WHERE epoch<>? AND payload IS NULL AND created_at <= ?",
		).run(this.epoch, this.clock() - HOST_LIMITS.receiptTtlMs);
		const unused = db
			.query(
				"SELECT * FROM host_source WHERE content IS NOT NULL AND created_at < ? AND forgotten=0 AND NOT EXISTS(SELECT 1 FROM host_state_source s WHERE s.source_id=host_source.id) AND NOT EXISTS (SELECT 1 FROM host_plan p WHERE p.payload IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(p.payload,'$.sourceIds') j WHERE j.value=host_source.id)) LIMIT 64",
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
				prior.content === p.content && prior.kind === p.kind,
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
			kind: "message",
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
		};
		db.query(
			"INSERT INTO host_source(id,client_id,submission_id,scope_key,kind,content,ref,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
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
	/** Technical identity/version checks only; meaning and applicability remain with the caller's LLM. */
	inspectEvidence(
		db: MemoryDb,
		item: StateItem,
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
			.query(
				"SELECT * FROM host_source WHERE scope_key=? AND forgotten=0 AND json_extract(ref,'$.namespace')=? AND json_extract(ref,'$.kind')=? AND json_extract(ref,'$.id')=?",
			)
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
	withEvidenceStatus(db: MemoryDb, item: StateItem): HostItem {
		const statuses = item.evidence.map(
			(ref) => this.inspectEvidence(db, item, ref).status,
		);
		const evidenceStatus: EvidenceStatus = statuses.includes("stale")
			? "stale"
			: statuses.includes("missing")
				? "missing"
				: !statuses.length || statuses.includes("unverified")
					? "unverified"
					: "current";
		return { ...item, evidenceStatus };
	}
	fingerprint(db: MemoryDb, items: readonly StateItem[]): string {
		const versions = [...items]
			.sort((a, b) => a.itemId.localeCompare(b.itemId))
			.flatMap((item) =>
				item.evidence.map((ref) => [
					item.itemId,
					referenceKey(ref),
					this.inspectEvidence(db, item, ref).version,
				]),
			);
		return digest([stateFingerprint(items), versions]);
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
				const value = this.snapshots.create(
					listItems(
						db,
						this.access(grant),
						scopes,
						HOST_LIMITS.snapshotItems,
					).map((item) => this.withEvidenceStatus(db, item)),
					scopes,
					grant,
					this.policy,
					(items) => this.fingerprint(db, items),
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
			items,
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
			proposalSchema: planningSchema(undefined, { quoteMode: "range" }),
			instructions: hostPlanningInstructions,
		};
	}
	checkSnapshot(snapshot: Snapshot, grant: Grant): void {
		this.options.port.read((db) =>
			demand(
				this.fingerprint(
					db,
					listItems(db, this.access(grant), snapshot.scopes),
				) === snapshot.fingerprint,
				"SNAPSHOT_STALE",
			),
		);
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
				};
			}
			demand(p.snapshotId, "INVALID_INPUT");
			const snapshot = this.snapshots.get(p.snapshotId, grant, this.policy);
			if (snapshot.complete)
				demand(
					this.fingerprint(
						db,
						listItems(db, this.access(grant), snapshot.scopes),
					) === snapshot.fingerprint,
					"SNAPSHOT_STALE",
				);
			if (!p.itemId) {
				demand(snapshot.complete, "COMPLETE_SNAPSHOT_REQUIRED");
				return {
					status: "found",
					snapshotId: snapshot.id,
					epoch: this.epoch,
					current: true,
				};
			}
			const item = listItems(
				db,
				this.access(grant),
				snapshot.scopes,
				HOST_LIMITS.snapshotItems,
			).find((x) => x.itemId === p.itemId);
			demand(
				snapshot.items.some((x) => x.itemId === p.itemId) && item,
				"ITEM_NOT_AVAILABLE",
			);
			if (!snapshot.complete)
				demand(
					this.fingerprint(db, [item]) ===
						snapshot.itemFingerprints.get(item.itemId),
					"SNAPSHOT_STALE",
				);
			const sources = item.evidence.map((ref) => {
				const inspected = this.inspectEvidence(db, item, ref);
				if (inspected.status !== "current") return { status: inspected.status };
				const row = (
					db
						.query(
							"SELECT * FROM host_source WHERE scope_key=? AND forgotten=0",
						)
						.all(item.scopeKey) as SourceRow[]
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
				item: this.withEvidenceStatus(db, item),
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
				listItems(db, this.access(grant), snapshot.scopes),
			) === snapshot.fingerprint,
			"SNAPSHOT_STALE",
		);
		let parsed: MemoryPlan;
		try {
			parsed = parsePlan(
				JSON.stringify(p.proposal),
				modelItems(snapshot.items.filter((x) => x.scopeKey === p.scopeKey)),
				"",
			);
		} catch {
			throw new HostError("INVALID_PROPOSAL");
		}
		this.validatePlanDependencies(parsed);
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
			p.evidence.length === changes.filter((a) => a.type === "remember").length,
			"EVIDENCE_COUNT_MISMATCH",
		);
		demand(
			new Set(evidence.map((e) => e.actionIndex)).size === evidence.length,
			"DUPLICATE_EVIDENCE",
		);
		for (const change of parsed.changes) {
			if (change.actions[0]?.type === "remember") {
				const e = evidence.find((x) => x.actionIndex === change.actionIndex);
				demand(e, "EVIDENCE_REQUIRED");
				const row = db
					.query("SELECT * FROM host_source WHERE id=?")
					.get(e.sourceId) as SourceRow;
				const slice = sliceUtf8Range(
					row.content!,
					{ startByte: e.startByte, endByte: e.endByte },
					1024,
				);
				demand(
					slice.status === "ok" && slice.text === change.actions[0].quote,
					"QUOTE_MISMATCH",
				);
			}
			for (const id of change.actions.flatMap((a) =>
				a.type === "forget"
					? [a.itemId]
					: a.replacesItemId
						? [a.replacesItemId]
						: [],
			)) {
				const item = snapshot.items.find((x) => x.itemId === id);
				if (item?.origin === "user_confirmed" || item?.origin === "user_edited")
					demand(grant.confirmedWrites, "CONFIRMED_WRITE_NOT_PERMITTED");
			}
		}
		for (const indexes of parsed.groups) {
			const kinds = new Set(
				indexes.flatMap((i) => parsed.changes[i]!.actions.map((a) => a.type)),
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
			...snapshot.items.map((item) => ({
				scope: item.scopeKey,
				ref: { type: "state_item" as const, id: item.itemId },
			})),
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
			const selected = dependencies
				.filter((x) => x.scope === scope)
				.map((x) => x.ref);
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
		if (!row)
			return {
				status: p.epoch === this.epoch ? "blocked" : "indeterminate",
				code: "OPERATION_NOT_RECORDED",
				operationId: p.operationId,
			};
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
