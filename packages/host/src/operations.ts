import {
	LIMITS_LIFECYCLE,
	type HostForgetIntent,
	type StateItem,
} from "eumenes-memory";
import {
	applyForget,
	assertUserState,
	getForgetReceipt,
	planForget,
	readStateFact,
	readRecord,
	recordExternalDeletion,
	type ForgetTarget,
	type MemoryDb,
} from "eumenes-memory/sqlite";
import {
	demand,
	failure,
	HOST_LIMITS,
	HostError,
	type Grant,
	type HostResult,
	type MethodParams,
} from "./contracts.ts";
import {
	grantKey,
	listItems,
	opaqueId,
	referenceKey,
	sourceState,
	type SourceRow,
} from "./state.ts";
import type { MemoryPlan } from "./meaning/planning.ts";
import type { MemoryHost } from "./service.ts";

export interface StoredPlan {
	id: string;
	epoch: string;
	scopeKey: string;
	scopes: string[];
	policy: string;
	grantKey: string;
	fingerprint: string;
	parsed: MemoryPlan;
	evidence: {
		actionIndex: number;
		sourceId: string;
		revision: string;
		startByte: number;
		endByte: number;
	}[];
	sourceIds: string[];
	forgetSources: { id: string; key: string; recordId?: string }[];
	createdAt: number;
}
interface OperationPayload {
	plan: StoredPlan;
	groups: ("applied" | "skipped" | "blocked" | null)[];
	expected: string;
	forgetIds: string[];
}
interface OperationRow {
	id: string;
	plan_id: string;
	epoch: string;
	scope_keys: string;
	payload: string | null;
	result: string;
	created_at: number;
}

/** Preserve the non-text final outcome before erasing a legacy execution payload. */
export const operationOutcomeSql = `CASE
 WHEN json_type(result,'$.clarificationRequired') IS NULL
  AND json_type(payload,'$.plan.parsed.clarification') IN ('null','text')
 THEN json_set(result,'$.clarificationRequired',json(CASE
  WHEN coalesce(json_extract(payload,'$.plan.parsed.clarification'),'')<>''
   OR EXISTS(SELECT 1 FROM json_each(payload,'$.groups') WHERE value='blocked')
  THEN 'true' ELSE 'false' END)) ELSE result END`;

function operationRow(db: MemoryDb, id: string): OperationRow | null {
	return db
		.query("SELECT * FROM host_operation WHERE id=?")
		.get(id) as OperationRow | null;
}
function saveProgress(
	db: MemoryDb,
	id: string,
	payload: OperationPayload,
	result: HostResult,
): void {
	db.query("UPDATE host_operation SET payload=?,result=? WHERE id=?").run(
		JSON.stringify(payload),
		JSON.stringify(result),
		id,
	);
}
function resultFor(
	host: MemoryHost,
	id: string,
	payload: OperationPayload,
	status: string,
): HostResult {
	return {
		status,
		operationId: id,
		epoch: host.epoch,
		groups: payload.groups.map((x) => x ?? "not_run"),
		forgetIds: payload.forgetIds,
		sourceIncluded: payload.plan.forgetSources.length > 0,
		clarificationRequired:
			Boolean(payload.plan.parsed.clarification) ||
			payload.groups.includes("blocked"),
		forgetRequested:
			payload.plan.forgetSources.length > 0 ||
			payload.plan.parsed.changes.some((c) =>
				c.actions.some((a) => a.type === "forget"),
			),
	};
}
function currentItems(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	plan: StoredPlan,
): StateItem[] {
	return listItems(db, host.access(grant), plan.scopes);
}
function validateSources(
	host: MemoryHost,
	db: MemoryDb,
	plan: StoredPlan,
): void {
	for (const e of plan.evidence) {
		const row = db
			.query("SELECT * FROM host_source WHERE id=?")
			.get(e.sourceId) as SourceRow | null;
		demand(
			row &&
				!row.forgotten &&
				row.content !== null &&
				sourceState(row, host.config.principal).revision === e.revision,
			"SOURCE_STALE",
		);
		if (row.kind === "record") {
			const ref = JSON.parse(row.ref);
			const record = readRecord(db, {
				contractVersion: 1,
				access: host.access({
					clientId: "source-check",
					scopeKeys: plan.scopes,
					read: true,
					write: false,
					forgetAll: false,
					confirmedWrites: false,
				}),
				scopeKey: plan.scopeKey,
				recordId: ref.id,
				revision: ref.revision,
			});
			demand(record.status === "available", "SOURCE_STALE");
		}
	}
}
function checkWriteProtection(
	grant: Grant,
	items: readonly StateItem[],
	plan: StoredPlan,
): void {
	for (const change of plan.parsed.changes)
		for (const id of change.actions.flatMap((a) =>
			a.type === "forget"
				? [a.itemId]
				: a.replacesItemId
					? [a.replacesItemId]
					: [],
		)) {
			const item = items.find((x) => x.itemId === id);
			if (item && ["user_confirmed", "user_edited"].includes(item.origin))
				demand(grant.confirmedWrites, "CONFIRMED_WRITE_NOT_PERMITTED");
		}
}
/** Keep only non-text identity metadata after deletion; never clear another domain's tables. */
export function scrubHostIntent(
	host: MemoryHost,
	db: MemoryDb,
	intent: HostForgetIntent,
): void {
	const sources = new Set(intent["host.sources"] ?? []);
	const states = intent["host.states"] ?? [];
	const plans = new Set(intent["host.plans"] ?? []);
	// Legacy plans did not track their outputs. These exact provenance links also cover those payloads.
	if (states.length) {
		const rows = db
			.query(
				"SELECT DISTINCT source_id FROM host_state_source WHERE item_id IN (SELECT value FROM json_each(?))",
			)
			.all(JSON.stringify(states)) as { source_id: string }[];
		for (const row of rows) sources.add(row.source_id);
	}
	if (sources.size) {
		const ids = JSON.stringify([...sources]);
		const rows = db
			.query(`SELECT id FROM host_plan WHERE EXISTS(SELECT 1 FROM json_each(payload,'$.sourceIds') r JOIN json_each(?) s ON r.value=s.value)
		UNION SELECT plan_id AS id FROM host_operation WHERE EXISTS(SELECT 1 FROM json_each(payload,'$.plan.sourceIds') r JOIN json_each(?) s ON r.value=s.value)`)
			.all(ids, ids) as { id: string }[];
		for (const row of rows) plans.add(row.id);
	}
	for (const id of intent["host.sources"] ?? [])
		db.query(
			"UPDATE host_source SET content=NULL,ref='',forgotten=1 WHERE id=?",
		).run(id);
	for (const id of intent["host.states"] ?? [])
		db.query("DELETE FROM host_state_source WHERE item_id=?").run(id);
	for (const id of plans) {
		db.query("UPDATE host_plan SET payload=NULL WHERE id=?").run(id);
		db.query(
			`UPDATE host_operation SET result=${operationOutcomeSql},payload=NULL WHERE plan_id=? AND id<>?`,
		).run(id, host.activeOperation ?? "");
	}
	const intentId = intent["host.intent"]?.[0];
	if (intentId)
		db.query(
			"INSERT INTO host_forget_intent(id,payload,completed) VALUES(?,?,0) ON CONFLICT(id) DO NOTHING",
		).run(intentId, JSON.stringify(intent));
}
export function cleanExternal(
	host: MemoryHost,
	db: MemoryDb,
	forgetId: string,
): boolean {
	const access = host.access({
		clientId: "recovery",
		scopeKeys: host.config.scopeKeys,
		read: true,
		write: true,
		forgetAll: true,
		confirmedWrites: true,
	});
	const result = getForgetReceipt(db, { contractVersion: 2, access, forgetId });
	demand(result.status === "found", "RECEIPT_MISSING");
	for (const external of result.receipt.externalDeletions) {
		if (
			!["memory-host", "memory-host-source"].includes(external.providerRef) ||
			external.externalId === null
		)
			continue;
		const row = db
			.query("SELECT plan_id FROM host_dependent WHERE id=?")
			.get(external.externalId) as { plan_id: string } | null;
		if (external.providerRef === "memory-host-source")
			host.scrub(db, { "host.sources": [external.externalId] });
		else if (row) host.scrub(db, { "host.plans": [row.plan_id] });
		const confirmed = recordExternalDeletion(db, {
			contractVersion: 2,
			access,
			forgetId,
			providerRef: external.providerRef,
			externalId: external.externalId,
			state: "confirmed",
			clock: { atMs: host.clock() },
		});
		demand(confirmed.status === "recorded", "EXTERNAL_CONFIRMATION_FAILED");
	}
	const updated = getForgetReceipt(db, {
		contractVersion: 2,
		access,
		forgetId,
	});
	return updated.status === "found" && updated.receipt.completed;
}
function durableForget(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	targets: ForgetTarget[],
	intent?: HostForgetIntent,
): string {
	demand(
		host.journalCount < LIMITS_LIFECYCLE.maxJournalEntries,
		"JOURNAL_CAPACITY",
	);
	const planned = planForget(db, {
		contractVersion: 2,
		access: host.access(grant),
		...(targets.length ? { targets } : {}),
		...(intent ? { hostIntent: intent } : {}),
		clock: { atMs: host.clock() },
	});
	demand(planned.status === "planned", "FORGET_REJECTED");
	try {
		host.appendForgetEntry(planned.plan.entry);
		host.options.afterJournalAppend?.();
		const applied = applyForget(db, {
			contractVersion: 2,
			entry: planned.plan.entry,
			clock: { atMs: host.clock() },
		});
		demand(applied.local === "applied", "FORGET_APPLY_FAILED");
		if (intent) host.scrub(db, intent, planned.plan.entry.forgetId);
		cleanExternal(host, db, planned.plan.entry.forgetId);
		return planned.plan.entry.forgetId;
	} catch (error) {
		host.failClosed();
		throw error;
	}
}
/** TTL cleanup is allowed only when the public dependency closure proves the source is unadopted. */
export function expireUnusedSource(
	host: MemoryHost,
	db: MemoryDb,
	row: SourceRow,
): void {
	const grant: Grant = {
		clientId: "retention",
		scopeKeys: host.config.scopeKeys,
		read: true,
		write: true,
		forgetAll: true,
		confirmedWrites: true,
	};
	const key = JSON.parse(row.ref) as import("eumenes-memory").SourceRef;
	const target: ForgetTarget =
		row.kind === "record"
			? { type: "record", scopeKey: row.scope_key, recordId: key.id }
			: {
					type: "host_source",
					scopeKey: row.scope_key,
					sourceKey: JSON.stringify([
						key.namespace,
						key.kind,
						key.id,
						key.representation ?? null,
					]),
				};
	const preview = planForget(db, {
		contractVersion: 2,
		access: host.access(grant),
		targets: [target],
		clock: { atMs: host.clock() },
	});
	demand(preview.status === "planned", "RETENTION_PREVIEW_REJECTED");
	if (
		(preview.plan.closure.counts["state_item"] ?? 0) > 0 ||
		(preview.plan.closure.counts["record"] ?? 0) >
			(row.kind === "record" ? 1 : 0) ||
		preview.plan.externalDependents.some(
			(x) => x.providerRef !== "memory-host-source" || x.externalId !== row.id,
		)
	)
		return;
	const intent: HostForgetIntent = {
		"host.intent": [opaqueId()],
		"host.scope": [row.scope_key],
		"host.sources": [row.id],
		...(row.kind === "record"
			? { "host.records": [key.id] }
			: {
					"host.sourceKeys": [
						JSON.stringify([
							key.namespace,
							key.kind,
							key.id,
							key.representation ?? null,
						]),
					],
				}),
	};
	durableForget(host, db, grant, [target], intent);
	db.query("UPDATE host_forget_intent SET completed=1 WHERE id=?").run(
		intent["host.intent"]![0]!,
	);
}

function performForget(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	opId: string,
	groupIndex: number,
	payload: OperationPayload,
): void {
	const { plan } = payload;
	host.authorizeForget(db, grant);
	const indexes = plan.parsed.groups[groupIndex] ?? [];
	const stateIds = new Set<string>();
	for (const i of indexes)
		for (const action of plan.parsed.changes[i]!.actions) {
			if (action.type !== "forget") continue;
			const fact = readStateFact(db, {
				contractVersion: 1,
				access: host.access(grant),
				scopeKey: plan.scopeKey,
				itemId: action.itemId,
			});
			if (fact.status === "forgotten") continue;
			demand(fact.status === "ok", "FORGET_TARGET_MISSING");
			for (const id of fact.itemIds) stateIds.add(id);
		}
	const extraSources =
		groupIndex === plan.parsed.groups.length ? plan.forgetSources : [];
	const intent: HostForgetIntent = {
		"host.intent": [opaqueId()],
		"host.scope": [plan.scopeKey],
		"host.states": [...stateIds],
		"host.sources": extraSources.map((x) => x.id),
		"host.sourceKeys": extraSources
			.filter((x) => !x.recordId)
			.map((x) => x.key),
		"host.records": extraSources.flatMap((x) =>
			x.recordId ? [x.recordId] : [],
		),
		"host.operation": [opId],
		"host.plans": [plan.id],
	};
	const targets: ForgetTarget[] = [
		...[...stateIds].map((itemId) => ({
			type: "state_item" as const,
			scopeKey: plan.scopeKey,
			itemId,
		})),
		...extraSources.map((s): ForgetTarget =>
			s.recordId
				? { type: "record", scopeKey: plan.scopeKey, recordId: s.recordId }
				: {
						type: "host_source",
						scopeKey: plan.scopeKey,
						sourceKey: s.key,
					},
		),
	];
	if (!targets.length) return;
	// One durable complete intent before any partial batch can be lost to backup restore.
	demand(
		stateIds.size + extraSources.length * 2 + 4 <= 65536,
		"FORGET_INTENT_TOO_LARGE",
	);
	for (let i = 0; i < targets.length; i += 64) {
		const forgetId = durableForget(
			host,
			db,
			grant,
			targets.slice(i, i + 64),
			i === 0 ? intent : undefined,
		);
		payload.forgetIds.push(forgetId);
	}
	db.query("UPDATE host_forget_intent SET completed=1 WHERE id=?").run(
		intent["host.intent"]![0]!,
	);
}
/** Runs before ready, independently of a disconnected/revoked client. */
export function recoverIntents(host: MemoryHost, db: MemoryDb): void {
	const grant: Grant = {
		clientId: "recovery",
		scopeKeys: host.config.scopeKeys,
		read: true,
		write: true,
		forgetAll: true,
		confirmedWrites: true,
	};
	const rows = db
		.query("SELECT id,payload FROM host_forget_intent WHERE completed=0")
		.all() as { id: string; payload: string }[];
	for (const row of rows) {
		const intent = JSON.parse(row.payload) as HostForgetIntent;
		const scopeKey = intent["host.scope"]?.[0];
		demand(scopeKey, "RECOVERY_SCOPE_MISSING");
		const targets: ForgetTarget[] = [
			...(intent["host.states"] ?? []).map((itemId) => ({
				type: "state_item" as const,
				scopeKey,
				itemId,
			})),
			...(intent["host.records"] ?? []).map((recordId) => ({
				type: "record" as const,
				scopeKey,
				recordId,
			})),
			...(intent["host.sourceKeys"] ?? []).map((sourceKey) => ({
				type: "host_source" as const,
				scopeKey,
				sourceKey,
			})),
		];
		for (let i = 0; i < targets.length; i += 64)
			durableForget(host, db, grant, targets.slice(i, i + 64));
		host.scrub(db, intent);
		db.query("UPDATE host_forget_intent SET completed=1 WHERE id=?").run(
			row.id,
		);
		const operationId = intent["host.operation"]?.[0];
		if (operationId)
			db.query(
				"UPDATE host_operation SET payload=NULL,result=? WHERE id=?",
			).run(
				JSON.stringify({
					status: "indeterminate",
					code: "FORGET_RECOVERED_CHECK_REMAINING_GROUPS",
					operationId,
					localForgetApplied: true,
					forgetRequested: true,
				}),
				operationId,
			);
	}
}
export async function applyPlan(
	host: MemoryHost,
	credential: string,
	params: MethodParams<"apply">,
): Promise<HostResult> {
	// Only execution is coordinated here; durable results remain the source of truth.
	const running = host.inFlight.get(params.operationId);
	if (running) {
		await running.catch(() => {});
		return runPlan(host, credential, params);
	}
	const task = runPlan(host, credential, params);
	host.inFlight.set(params.operationId, task);
	try {
		return await task;
	} finally {
		if (host.inFlight.get(params.operationId) === task)
			host.inFlight.delete(params.operationId);
	}
}
async function runPlan(
	host: MemoryHost,
	credential: string,
	params: MethodParams<"apply">,
): Promise<HostResult> {
	let existing: HostResult | undefined;
	const initial = await host.write((db) => {
		const grant = host.grant(credential);
		demand(grant.write && grant.read, "WRITE_NOT_PERMITTED");
		host.cleanup(db);
		const prior = operationRow(db, params.operationId);
		if (prior) {
			host.allowed(grant, JSON.parse(prior.scope_keys));
			demand(prior.plan_id === params.planId, "OPERATION_ID_CONFLICT");
			const result = host.operation(db, grant, params);
			if (!prior.payload || result.status !== "pending") {
				db.query(
					"UPDATE host_operation SET result=?,payload=CASE WHEN ? IN ('completed','needs_clarification') THEN NULL ELSE payload END WHERE id=?",
				).run(JSON.stringify(result), result.status, params.operationId);
				existing = result;
				return undefined;
			}
			const resumed = JSON.parse(prior.payload) as OperationPayload;
			host.validatePlanDependencies(resumed.plan.parsed);
			return resumed;
		}
		if (params.epoch !== host.epoch) {
			existing = {
				status: "indeterminate",
				code: "OPERATION_NOT_RECORDED",
				operationId: params.operationId,
			};
			return undefined;
		}
		const row = db
			.query("SELECT payload,expires_at FROM host_plan WHERE id=?")
			.get(params.planId) as {
			payload: string | null;
			expires_at: number;
		} | null;
		demand(row?.payload && row.expires_at > host.clock(), "PLAN_UNAVAILABLE");
		const plan = JSON.parse(row.payload) as StoredPlan;
		host.validatePlanDependencies(plan.parsed);
		demand(
			plan.epoch === host.epoch &&
				plan.policy === host.policy &&
				plan.grantKey === grantKey(grant),
			"PLAN_STALE",
		);
		host.allowed(grant, plan.scopes);
		const items = currentItems(host, db, grant, plan);
		demand(host.fingerprint(db, items) === plan.fingerprint, "SNAPSHOT_STALE");
		checkWriteProtection(grant, items, plan);
		validateSources(host, db, plan);
		if (
			plan.forgetSources.length ||
			plan.parsed.changes.some((c) =>
				c.actions.some((a) => a.type === "forget"),
			)
		)
			host.authorizeForget(db, grant);
		const count = db
			.query("SELECT count(*) AS n FROM host_operation WHERE epoch=?")
			.get(host.epoch) as { n: number };
		demand(count.n < HOST_LIMITS.operationsPerEpoch, "OPERATION_CAPACITY");
		const value: OperationPayload = {
			plan,
			groups: [
				...plan.parsed.groups.map(() => null),
				...(plan.forgetSources.length ? [null] : []),
			],
			expected: plan.fingerprint,
			forgetIds: [],
		};
		db.query(
			"INSERT INTO host_operation(id,plan_id,epoch,scope_keys,payload,result,created_at) VALUES(?,?,?,?,?,?,?)",
		).run(
			params.operationId,
			plan.id,
			host.epoch,
			JSON.stringify(plan.scopes),
			JSON.stringify(value),
			JSON.stringify(resultFor(host, params.operationId, value, "pending")),
			host.clock(),
		);
		return value;
	});
	if (!initial) return existing!;
	let payload: OperationPayload = initial;
	for (let groupIndex = 0; groupIndex < payload.groups.length; groupIndex++) {
		if (payload.groups[groupIndex] !== null) continue;
		try {
			const candidate: OperationPayload = structuredClone(payload);
			await host.write((db) => {
				demand(host.healthy, "HOST_NOT_READY");
				const grant = host.grant(credential);
				demand(grant.write && grant.read, "WRITE_NOT_PERMITTED");
				demand(
					candidate.plan.policy === host.policy &&
						candidate.plan.grantKey === grantKey(grant),
					"ACCESS_CHANGED",
				);
				const items = currentItems(host, db, grant, candidate.plan);
				demand(
					host.fingerprint(db, items) === candidate.expected,
					"SNAPSHOT_STALE",
				);
				const indexes = candidate.plan.parsed.groups[groupIndex];
				const changes =
					indexes?.map((i) => candidate.plan.parsed.changes[i]!) ?? [];
				const actions = changes.flatMap((c) => c.actions);
				if (changes.some((c) => c.relation === "conflicts"))
					candidate.groups[groupIndex] = "blocked";
				else if (!indexes || actions.some((a) => a.type === "forget")) {
					host.activeOperation = params.operationId;
					try {
						performForget(
							host,
							db,
							grant,
							params.operationId,
							groupIndex,
							candidate,
						);
					} finally {
						host.activeOperation = undefined;
					}
					candidate.groups[groupIndex] = "applied";
				} else {
					validateSources(host, db, candidate.plan);
					checkWriteProtection(grant, items, candidate.plan);
					for (const change of changes)
						for (const action of change.actions) {
							if (action.type !== "remember")
								throw new HostError("MIXED_GROUP_UNSUPPORTED");
							const e = candidate.plan.evidence.find(
								(x) => x.actionIndex === change.actionIndex,
							)!;
							const source = db
								.query("SELECT * FROM host_source WHERE id=?")
								.get(e.sourceId) as SourceRow;
							const replacement = action.replacesItemId
								? items.find((i) => i.itemId === action.replacesItemId)
								: undefined;
							if (action.replacesItemId !== null && !replacement)
								throw new HostError("CORRECTION_TARGET_STALE", "stale");
							const result = assertUserState(db, {
								contractVersion: 1,
								access: host.access(grant),
								scopeKey: candidate.plan.scopeKey,
								clock: { atMs: host.clock() },
								subject: action.subject,
								kind: action.kind,
								semanticKey: action.semanticKey,
								value: action.value,
								origin: source.origin,
								evidence: [
									{
										source: {
											...JSON.parse(source.ref),
											range: { startByte: e.startByte, endByte: e.endByte },
										},
										quote: action.quote,
									},
								],
								sources: [sourceState(source, host.config.principal)],
								...(replacement
									? {
											replaces: {
												itemId: replacement.itemId,
												revision: replacement.revision,
											},
										}
									: {}),
							});
							demand(
								result.status === "applied" || result.status === "unchanged",
								"STATE_WRITE_REJECTED",
							);
							host.registerPlanDependencies(db, grant, candidate.plan.id, [
								{
									scope: candidate.plan.scopeKey,
									ref: { type: "state_item", id: result.item.itemId },
								},
							]);

							if (
								result.item.evidence.some(
									(ref) =>
										referenceKey(ref) === referenceKey(JSON.parse(source.ref)),
								)
							)
								db.query(
									"INSERT OR IGNORE INTO host_state_source VALUES(?,?)",
								).run(result.item.itemId, source.id);
						}
					candidate.groups[groupIndex] = actions.length ? "applied" : "skipped";
				}
				candidate.expected = host.fingerprint(
					db,
					currentItems(host, db, grant, candidate.plan),
				);
				saveProgress(
					db,
					params.operationId,
					candidate,
					resultFor(host, params.operationId, candidate, "pending"),
				);
			});
			payload = candidate;
		} catch (error) {
			const errorResult = failure(error);
			const result = {
				...errorResult,
				...resultFor(
					host,
					params.operationId,
					payload,
					payload.groups.includes("applied") ? "partial" : errorResult.status,
				),
			};
			if (host.healthy)
				await host.write((db) => {
					db.query(
						"UPDATE host_operation SET payload=NULL,result=? WHERE id=?",
					).run(JSON.stringify(result), params.operationId);
				});
			try {
				const current = host.grant(credential);
				demand(current.read, "READ_NOT_PERMITTED");
				host.allowed(current, payload.plan.scopes);
				if (
					payload.plan.forgetSources.length ||
					payload.plan.parsed.changes.some((c) =>
						c.actions.some((a) => a.type === "forget"),
					)
				)
					host.admin(current);
			} catch (accessError) {
				return failure(accessError);
			}
			return result;
		}
	}
	return await host.write((db) => {
		const grant = host.grant(credential);
		demand(
			grant.read &&
				grant.write &&
				payload.plan.grantKey === grantKey(grant) &&
				payload.plan.policy === host.policy,
			"ACCESS_CHANGED",
		);
		let pendingExternal = false;
		for (const forgetId of payload.forgetIds)
			if (!cleanExternal(host, db, forgetId)) pendingExternal = true;
		const status = pendingExternal
			? "pending"
			: payload.plan.parsed.clarification || payload.groups.includes("blocked")
				? "needs_clarification"
				: "completed";
		host.allowed(grant, payload.plan.scopes);
		const result = resultFor(host, params.operationId, payload, status);
		db.query("UPDATE host_operation SET payload=?,result=? WHERE id=?").run(
			status === "pending" ? JSON.stringify(payload) : null,
			JSON.stringify(result),
			params.operationId,
		);
		return result;
	});
}
