/**
 * 容量の監視（設計 §4D.2 の 1〜2、S6）。本文は返さない。
 * 件数と大きさは読み取りの集計で、書き込みを伴わない。snapshot の大きさは見積もり（本文と鍵と属性の byte 数に、1 件あたりの固定の上乗せを足す）。
 */
import { statSync } from "node:fs";
import { LIMITS_LIFECYCLE } from "eumenes-memory";
import type { MemoryDb } from "eumenes-memory/sqlite";
import { HOST_LIMITS } from "./contracts.ts";

/** item 1 件の JSON の、本文以外の部分の見積もり（id、revision、根拠の参照など）［推定］。 */
export const ITEM_OVERHEAD_BYTES = 700;
export const WARNING_LEVELS = [0.7, 0.9] as const;
export const NEAR_LIMIT_RATIO = 0.9;
export interface CapacityLimits {
	snapshotItems: number;
	snapshotBytes: number;
	maxSources: number;
	operationsPerEpoch: number;
	maxJournalEntries: number;
}
export function capacityLimits(
	limit: (name: keyof typeof HOST_LIMITS) => number,
): CapacityLimits {
	return {
		snapshotItems: limit("snapshotItems"),
		snapshotBytes: limit("snapshotBytes"),
		maxSources: limit("maxSources"),
		operationsPerEpoch: limit("operationsPerEpoch"),
		maxJournalEntries: LIMITS_LIFECYCLE.maxJournalEntries,
	};
}
function placeholders(n: number): string {
	return Array.from({ length: n }, () => "?").join(",");
}
/** 許可された scope の active な item の件数と、snapshot の大きさの見積もり。 */
export function activeUsage(
	db: MemoryDb,
	principal: string,
	scopeKeys: readonly string[],
): { items: number; bytes: number } {
	if (!scopeKeys.length) return { items: 0, bytes: 0 };
	const row = db
		.query(
			`SELECT count(*) AS n, coalesce(sum(length(CAST(i.value_text AS BLOB)) + length(CAST(i.semantic_key AS BLOB)) + coalesce((SELECT sum(length(CAST(a.attr_key AS BLOB)) + length(CAST(a.attr_value AS BLOB))) FROM memory_state_attribute a WHERE a.item_id=i.item_id),0)),0) AS b FROM memory_state_item i WHERE i.principal=? AND i.status='active' AND i.scope_key IN (${placeholders(scopeKeys.length)})`,
		)
		.get(principal, ...scopeKeys) as { n: number; b: number };
	return { items: row.n, bytes: row.b + row.n * ITEM_OVERHEAD_BYTES };
}
export interface CapacityReport {
	scopes: Record<string, { active: number; estimatedSnapshotBytes: number }>;
	kinds: Record<string, number>;
	trust: { confirmed: number; inferred: number; external: number };
	rows: Record<string, number>;
	databaseBytes: number | null;
	walBytes: number | null;
	usage: Record<
		keyof CapacityLimits,
		{ used: number; limit: number; ratio: number }
	>;
}
export interface CapacityWarning {
	limit: keyof CapacityLimits;
	level: 70 | 90;
	ratio: number;
}
export function capacityReport(input: {
	db: MemoryDb;
	principal: string;
	scopeKeys: readonly string[];
	limits: CapacityLimits;
	journalEntries: number;
	operationsThisEpoch: number;
	databasePath: string | undefined;
}): { capacity: CapacityReport; capacityWarnings: CapacityWarning[] } {
	const { db, principal, scopeKeys, limits } = input;
	const scopes: CapacityReport["scopes"] = {};
	for (const scope of scopeKeys) {
		const usage = activeUsage(db, principal, [scope]);
		scopes[scope] = {
			active: usage.items,
			estimatedSnapshotBytes: usage.bytes,
		};
	}
	const inScope = `principal=? AND scope_key IN (${placeholders(scopeKeys.length)})`;
	const kinds: Record<string, number> = {};
	const rows: Record<string, number> = {};
	if (scopeKeys.length) {
		for (const row of db
			.query(
				`SELECT kind, count(*) AS n FROM memory_state_item WHERE status='active' AND ${inScope} GROUP BY kind`,
			)
			.all(principal, ...scopeKeys) as { kind: string; n: number }[])
			kinds[row.kind] = row.n;
		for (const row of db
			.query(
				`SELECT status, count(*) AS n FROM memory_state_item WHERE ${inScope} GROUP BY status`,
			)
			.all(principal, ...scopeKeys) as { status: string; n: number }[])
			rows[row.status] = row.n;
	}
	const trust = { confirmed: 0, inferred: 0, external: 0 };
	if (scopeKeys.length)
		for (const row of db
			.query(
				`SELECT CASE WHEN i.origin IN ('user_confirmed','user_edited') THEN 'confirmed'
 WHEN (SELECT count(*) FROM host_state_source l JOIN host_source s ON s.id=l.source_id WHERE l.item_id=i.item_id AND s.provenance IN ('user_message','agent_reasoning')) > 0
  AND (SELECT count(*) FROM host_state_source l JOIN host_source s ON s.id=l.source_id WHERE l.item_id=i.item_id AND s.provenance NOT IN ('user_message','agent_reasoning')) = 0
  AND (SELECT count(*) FROM host_state_source l WHERE l.item_id=i.item_id) >= (SELECT count(*) FROM memory_state_evidence e WHERE e.item_id=i.item_id)
 THEN 'inferred' ELSE 'external' END AS t, count(*) AS n
 FROM memory_state_item i WHERE i.status='active' AND i.principal=? AND i.scope_key IN (${placeholders(scopeKeys.length)}) GROUP BY t`,
			)
			.all(principal, ...scopeKeys) as { t: keyof typeof trust; n: number }[])
			trust[row.t] = row.n;
	const total = activeUsage(db, principal, scopeKeys);
	const sources = (
		db
			.query("SELECT count(*) AS n FROM host_source WHERE content IS NOT NULL")
			.get() as {
			n: number;
		}
	).n;
	const size = (path: string) =>
		statSync(path, { throwIfNoEntry: false })?.size ?? null;
	const used = {
		snapshotItems: total.items,
		snapshotBytes: total.bytes,
		maxSources: sources,
		operationsPerEpoch: input.operationsThisEpoch,
		maxJournalEntries: input.journalEntries,
	};
	const usage = Object.fromEntries(
		(Object.keys(used) as (keyof CapacityLimits)[]).map((key) => [
			key,
			{ used: used[key], limit: limits[key], ratio: used[key] / limits[key] },
		]),
	) as CapacityReport["usage"];
	const capacityWarnings: CapacityWarning[] = [];
	for (const key of Object.keys(usage) as (keyof CapacityLimits)[]) {
		const ratio = usage[key].ratio;
		if (ratio >= WARNING_LEVELS[1])
			capacityWarnings.push({ limit: key, level: 90, ratio });
		else if (ratio >= WARNING_LEVELS[0])
			capacityWarnings.push({ limit: key, level: 70, ratio });
	}
	return {
		capacity: {
			scopes,
			kinds,
			trust,
			rows,
			databaseBytes: input.databasePath ? size(input.databasePath) : null,
			walBytes: input.databasePath ? size(`${input.databasePath}-wal`) : null,
			usage,
		},
		capacityWarnings,
	};
}
