import type { SourceRef } from "eumenes-memory";
import {
	registerExternalDependents,
	type MemoryDb,
} from "eumenes-memory/sqlite";
import type {
	AgendaDetails,
	AgendaItem,
	AgendaKind,
	AgendaStatus,
} from "./agenda-contract.ts";
import {
	demand,
	HostError,
	type Grant,
	type HostResult,
	type MethodParams,
} from "./contracts.ts";
import { digest, opaqueId, referenceKey, type SourceRow } from "./state.ts";
import type { MemoryHost } from "./service.ts";

export const agendaProvider = "memory-host-agenda";
export const isAgendaId = (id: string) => id.startsWith("agenda:");
export const agendaKey = (id: string) =>
	JSON.stringify(["eumenes-host-agenda", "item", id, null]);

interface AgendaRow {
	id: string;
	scope_key: string;
	source_id: string;
	status_source_id: string | null;
	kind: AgendaKind;
	details: string;
	evidence: string;
	quote: string;
	status: AgendaStatus;
	updated_at: number;
}

function itemOf(row: AgendaRow): AgendaItem {
	return {
		...(JSON.parse(row.details) as AgendaDetails),
		itemId: row.id,
		scopeKey: row.scope_key,
		kind: row.kind,
		sourceRole: row.kind === "commitment" ? "agent" : "user",
		status: row.status,
		updatedAtMs: row.updated_at,
		evidence: JSON.parse(row.evidence) as SourceRef,
		quote: row.quote,
	};
}

export function listAgenda(
	db: MemoryDb,
	scopes: readonly string[],
	limit: number,
): AgendaItem[] {
	return (
		db
			.query(
				"SELECT * FROM host_agenda WHERE scope_key IN (SELECT value FROM json_each(?)) ORDER BY scope_key,id LIMIT ?",
			)
			.all(JSON.stringify(scopes), limit) as AgendaRow[]
	).map(itemOf);
}

export function agendaSources(db: MemoryDb, id: string): string[] {
	return (
		db
			.query(`SELECT s.ref FROM host_agenda a JOIN host_source s
		ON s.id=a.source_id OR s.id=a.status_source_id WHERE a.id=? AND s.forgotten=0`)
			.all(id) as { ref: string }[]
	).map((row) => referenceKey(JSON.parse(row.ref)));
}

function registerAgenda(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	scopeKey: string,
	id: string,
): void {
	const result = registerExternalDependents(db, {
		contractVersion: 1,
		access: host.access(grant),
		scopeKey,
		clock: { atMs: host.clock() },
		dependents: [
			{
				providerRef: agendaProvider,
				externalId: id,
				dependsOn: [agendaKey(id), ...agendaSources(db, id)].map((key) => ({
					type: "source",
					id: key,
				})),
			},
		],
	});
	demand(result.status === "registered", "AGENDA_DEPENDENCY_REJECTED");
}

export function addAgenda(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	source: SourceRow,
	kind: AgendaKind,
	details: AgendaDetails,
	quote: string,
	range: { startByte: number; endByte: number },
): string {
	demand(
		source.kind === (kind === "commitment" ? "agent_reply" : "text"),
		"SOURCE_ROLE_MISMATCH",
	);
	host.checkQuote(source, range, quote);
	// A single reply span identifies one commitment. Retries keep its ID and current status.
	const key =
		kind === "commitment"
			? digest([source.id, range.startByte, range.endByte])
			: null;
	const id = `agenda:${key ?? opaqueId()}`;
	const creationHash = key ? digest(details) : null;
	if (key) {
		const prior = db
			.query("SELECT creation_hash FROM host_agenda WHERE id=?")
			.get(id) as { creation_hash: string } | null;
		if (prior) {
			demand(prior.creation_hash === creationHash, "COMMITMENT_CONFLICT");
			return id;
		}
	}
	const evidence = {
		...(JSON.parse(source.ref) as SourceRef),
		range: { startByte: range.startByte, endByte: range.endByte },
	};
	db.query(`INSERT INTO host_agenda(id,scope_key,source_id,kind,details,evidence,quote,status,updated_at,creation_hash)
		VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(
		id,
		source.scope_key,
		source.id,
		kind,
		JSON.stringify(details),
		JSON.stringify(evidence),
		quote,
		host.clock(),
		creationHash,
	);
	registerAgenda(host, db, grant, source.scope_key, id);
	return id;
}

export function changeAgendaStatus(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	scopeKey: string,
	id: string,
	status: Exclude<AgendaStatus, "pending">,
	source?: SourceRow,
): void {
	const row = db
		.query("SELECT status FROM host_agenda WHERE id=? AND scope_key=?")
		.get(id, scopeKey) as { status: AgendaStatus } | null;
	demand(row, "ITEM_NOT_AVAILABLE");
	if (row.status === status) return;
	if (row.status !== "pending")
		throw new HostError("AGENDA_STATUS_CONFLICT", "stale");
	db.query(
		"UPDATE host_agenda SET status=?,updated_at=?,status_source_id=? WHERE id=?",
	).run(status, host.clock(), source?.id ?? null, id);
	if (source) registerAgenda(host, db, grant, scopeKey, id);
}

export function applyAgenda(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	params: NonNullable<MethodParams<"apply">["agenda"]>,
): HostResult {
	demand(grant.read, "READ_NOT_PERMITTED");
	host.allowed(grant, [params.scopeKey]);
	let itemId: string;
	if (params.type === "record_commitment") {
		const source = host.sourceByHandle(db, params.sourceHandle, grant);
		demand(source.scope_key === params.scopeKey, "SOURCE_SCOPE_MISMATCH");
		itemId = addAgenda(
			host,
			db,
			grant,
			source,
			"commitment",
			{
				text: params.text,
				certainty: "confirmed",
				time: params.time,
				trigger: params.trigger,
			},
			params.quote,
			params,
		);
	} else {
		itemId = params.itemId;
		changeAgendaStatus(host, db, grant, params.scopeKey, itemId, params.status);
	}
	return { status: "completed", itemId };
}
