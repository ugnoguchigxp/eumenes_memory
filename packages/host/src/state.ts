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
	/** host schema 3 から。 */
	provenance?: string;
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
	itemIds?: readonly string[],
): StateItem[] {
	const items: StateItem[] = [];
	// ID を指定したときは、その item だけを読む（scope の全件を水和しない）。核の上限の 1000 件ずつに分ける。
	const unique = itemIds === undefined ? undefined : [...new Set(itemIds)];
	const groups =
		unique === undefined
			? [undefined]
			: Array.from({ length: Math.ceil(unique.length / 1000) }, (_, i) =>
					unique.slice(i * 1000, (i + 1) * 1000),
				);
	for (const scopeKey of [...scopeKeys].sort())
		for (const wanted of groups) {
			let after: { updatedSeq: number; itemId: string } | undefined;
			do {
				const result = listState(db, {
					contractVersion: 1,
					access,
					scopeKey,
					limit: 1000,
					includeInactive,
					...(after ? { after } : {}),
					...(wanted ? { itemIds: wanted } : {}),
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
	items: readonly (StateItem & {
		evidenceStatus?: string;
		trust?: string;
		expiresOn?: string;
	})[],
): string {
	return digest(
		items
			// ホストが計算して付ける表示用の値は、State の指紋に入れない。
			.map(
				({
					evidenceStatus: _status,
					trust: _trust,
					expiresOn: _expires,
					...state
				}) => state,
			)
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
	/** `search` が作った不完全な snapshot（§4.2）。context の枠とは別に数える。 */
	pool?: "search";
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
		pool?: "search",
	): Snapshot {
		for (const [id, snapshot] of this.snapshots)
			if (snapshot.expiresAt <= this.clock()) this.snapshots.delete(id);
		const inPool = [...this.snapshots.values()].filter((x) => x.pool === pool);
		if (pool === "search") {
			// 検索用の枠（§4.2）: 32 個を超えたら、古いもの（Map の挿入順の先頭）から捨てる。
			for (const old of inPool.slice(
				0,
				Math.max(0, inPool.length - HOST_LIMITS.searchSnapshots + 1),
			))
				this.snapshots.delete(old.id);
		} else demand(inPool.length < HOST_LIMITS.snapshots, "SNAPSHOT_CAPACITY");
		// 検索の snapshot は返した item だけを含むので、常に不完全（plan には使えない）。
		let complete =
			pool !== "search" && items.length <= HOST_LIMITS.snapshotItems;
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
			...(pool ? { pool } : {}),
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
