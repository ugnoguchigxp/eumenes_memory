import { createHash, randomUUID } from "node:crypto";
import type {
	AccessContext,
	HostSourceState,
	SourceRef,
	StateItem,
} from "eumenes-memory";
import { listState, type MemoryDb } from "eumenes-memory/sqlite";
import { demand, HOST_LIMITS, type Grant } from "./contracts.ts";
import type { HostItem, EvidenceStatus } from "./meaning/model-input.ts";

export const digest = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** SourceKey's documented wire representation, not an internal table dependency. */
export const referenceKey = (ref: SourceRef): string =>
	JSON.stringify([ref.namespace, ref.kind, ref.id, ref.representation ?? null]);
export const opaqueId = (): string => randomUUID();
export interface SourceRow {
	id: string;
	client_id: string;
	submission_id: string;
	scope_key: string;
	kind: string;
	content: string | null;
	ref: string;
	origin: "agent_inferred" | "user_confirmed" | "user_edited";
	created_at: number;
	forgotten: number;
}
export function sourceState(
	row: SourceRow,
	principal: string,
): HostSourceState {
	demand(row.content !== null && !row.forgotten, "SOURCE_UNAVAILABLE");
	return {
		...(JSON.parse(row.ref) as SourceRef),
		principal,
		scopeKey: row.scope_key,
		status: "available",
		content: row.content,
		ordinal: row.created_at,
	};
}
export function accessFor(
	principal: string,
	scopes: readonly string[],
	revision: string,
): AccessContext {
	return {
		principal,
		scopeKeys: scopes,
		purpose: "memory.host",
		policyRevision: revision,
	};
}
export function listItems(
	db: MemoryDb,
	access: AccessContext,
	scopeKeys: readonly string[],
	cap = Infinity,
	includeInactive = false,
): StateItem[] {
	const items: StateItem[] = [];
	for (const scopeKey of [...scopeKeys].sort()) {
		let after: { updatedSeq: number; itemId: string } | undefined;
		do {
			const result = listState(db, {
				contractVersion: 1,
				access,
				scopeKey,
				limit: 1000,
				includeInactive,
				...(after ? { after } : {}),
			});
			demand(result.status === "ok", "SCOPE_NOT_PERMITTED");
			items.push(...result.items);
			if (items.length > cap) return items.slice(0, cap + 1);
			after = result.nextCursor;
		} while (after);
	}
	return items;
}
export function stateFingerprint(
	items: readonly (StateItem & { evidenceStatus?: string })[],
): string {
	return digest(
		items
			.map(({ evidenceStatus: _status, ...state }) => state)
			.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)),
	);
}
export function grantKey(grant: Grant): string {
	return digest(grant);
}
export interface Snapshot {
	id: string;
	epoch: string;
	grantKey: string;
	policy: string;
	scopes: string[];
	items: readonly HostItem[];
	fingerprint: string;
	itemFingerprints: ReadonlyMap<string, string>;
	complete: boolean;
	expiresAt: number;
}
export class SnapshotStore {
	private readonly snapshots = new Map<string, Snapshot>();
	constructor(
		readonly epoch: string,
		private readonly clock: () => number,
	) {}
	create(
		items: (StateItem & { evidenceStatus?: EvidenceStatus })[],
		scopes: string[],
		grant: Grant,
		policy: string,
		fingerprint: (items: readonly StateItem[]) => string = stateFingerprint,
	): Snapshot {
		for (const [id, snapshot] of this.snapshots)
			if (snapshot.expiresAt <= this.clock()) this.snapshots.delete(id);
		demand(this.snapshots.size < HOST_LIMITS.snapshots, "SNAPSHOT_CAPACITY");
		let complete = items.length <= HOST_LIMITS.snapshotItems;
		let size = 0;
		const shown: HostItem[] = [];
		for (const item of items.slice(0, HOST_LIMITS.snapshotItems)) {
			size += Buffer.byteLength(JSON.stringify(item));
			if (size > HOST_LIMITS.snapshotBytes) {
				complete = false;
				break;
			}
			shown.push({
				...item,
				evidenceStatus: item.evidenceStatus ?? "unverified",
			});
		}
		const snapshot: Snapshot = {
			id: opaqueId(),
			epoch: this.epoch,
			grantKey: grantKey(grant),
			policy,
			scopes: [...scopes],
			items: structuredClone(shown),
			fingerprint: fingerprint(shown),
			itemFingerprints: new Map(
				shown.map((item) => [item.itemId, fingerprint([item])]),
			),
			complete,
			expiresAt: this.clock() + HOST_LIMITS.snapshotTtlMs,
		};
		this.snapshots.set(snapshot.id, snapshot);
		return snapshot;
	}
	get(id: string, grant: Grant, policy: string): Snapshot {
		const snapshot = this.snapshots.get(id);
		demand(snapshot && snapshot.expiresAt > this.clock(), "SNAPSHOT_EXPIRED");
		demand(
			snapshot.grantKey === grantKey(grant) && snapshot.policy === policy,
			"ACCESS_CHANGED",
		);
		return snapshot;
	}
	invalidate(scopes: readonly string[]): void {
		for (const [id, snapshot] of this.snapshots)
			if (scopes.some((s) => snapshot.scopes.includes(s)))
				this.snapshots.delete(id);
	}
}
