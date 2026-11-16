/**
 * 外部由来の item の自動停止と、再利用による延長（設計 §4D.2a、決定 11、S6b）。
 * 最終利用日はホストの表 `host_item_use` に日単位（UTC の日番号）で、外部由来の item だけに持つ。
 * 停止は核の `deactivateState`（忘却ではないのでジャーナルを使わない）。戻すのは管理用の `reactivate`。
 */
import {
	deactivateState,
	reactivateState,
	type MemoryDb,
} from "eumenes-memory/sqlite";
import type { StateItem } from "eumenes-memory";
import { demand, HostError, type Grant, type HostResult } from "./contracts.ts";
import { accessFor, listItems } from "./state.ts";
import type { MemoryHost } from "./service.ts";

export const DAY_MS = 86400000;
/** 最後に再利用された日（無ければ作成日）から停止までの日数。 */
export const EXPIRY_DAYS = 90;
/** 1 回の `expire` で停止する item の上限（残りは次回）。 */
export const EXPIRE_BATCH = 500;
/** `use` の 1 回の報告で受け付ける item の上限。 */
export const USE_BATCH = 20;
/** `expire` の内部の操作を `host_operation` に記録するときの plan_id（利用者の操作と区別する）。 */
export const EXPIRE_PLAN_ID = "host:expire";
const JST_OFFSET_MS = 9 * 3600000;

export function utcDay(ms: number): number {
	return Math.floor(ms / DAY_MS);
}
/** 作成の時刻（核の State の最初の event の時刻）。 */
export function createdAtMs(db: MemoryDb, itemId: string): number {
	const row = db
		.query("SELECT min(at_ms) AS at FROM memory_state_event WHERE item_id=?")
		.get(itemId) as { at: number | null };
	return row.at ?? 0;
}
export function lastUsedDay(db: MemoryDb, itemId: string): number | undefined {
	const row = db
		.query("SELECT last_used_day FROM host_item_use WHERE item_id=?")
		.get(itemId) as { last_used_day: number } | null;
	return row?.last_used_day;
}
/**
 * 停止する時刻。最後の利用は日単位なので、その日の終わり（翌日の 0 時 UTC）から数える（延長を短くしない側）。
 * 作成からは時刻で数える。
 */
export function expiresAtMs(db: MemoryDb, itemId: string): number {
	const used = lastUsedDay(db, itemId);
	const base = Math.max(
		createdAtMs(db, itemId),
		used === undefined ? 0 : (used + 1) * DAY_MS,
	);
	return base + EXPIRY_DAYS * DAY_MS;
}
/** 表示用の停止日（JST の日付）。 */
export function expiresOnText(ms: number): string {
	return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}
/**
 * 再利用を記録する。外部由来の active な item だけに書き、保存された日が今日より前のときだけ更新する。
 * 更新した行の数を返す。
 */
export function recordUse(
	host: MemoryHost,
	db: MemoryDb,
	items: readonly StateItem[],
): number {
	const today = utcDay(host.clock());
	let changed = 0;
	for (const item of items) {
		if (item.status !== "active" || host.trust(db, item) !== "external")
			continue;
		db.query(
			"INSERT INTO host_item_use(item_id,last_used_day) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET last_used_day=excluded.last_used_day WHERE last_used_day<excluded.last_used_day",
		).run(item.itemId, today);
		changed += (db.query("SELECT changes() AS n").get() as { n: number }).n;
	}
	return changed;
}
/** 適用が完了した plan の参照（関係が forget のものを除く）で、外部由来の item の期限を延ばす。 */
export function extendRelated(
	host: MemoryHost,
	db: MemoryDb,
	scopeKeys: readonly string[],
	relatedItemIds: readonly string[],
): void {
	if (!relatedItemIds.length) return;
	const items = listItems(
		db,
		internalAccess(host),
		scopeKeys,
		Infinity,
		false,
		relatedItemIds,
	);
	recordUse(host, db, items);
}
function internalAccess(host: MemoryHost) {
	return accessFor(host.config.principal, host.config.scopeKeys, host.policy);
}
/** 停止の対象（外部由来で、期限を過ぎた active な item）。古いものから最大 `limit` 件。 */
export function expiredItems(
	host: MemoryHost,
	db: MemoryDb,
	limit = EXPIRE_BATCH,
): StateItem[] {
	const now = host.clock();
	return listItems(db, internalAccess(host), host.config.scopeKeys)
		.filter((item) => host.trust(db, item) === "external")
		.map((item) => ({ item, at: expiresAtMs(db, item.itemId) }))
		.filter((x) => x.at <= now)
		.sort((a, b) => a.at - b.at || (a.item.itemId < b.item.itemId ? -1 : 1))
		.slice(0, limit)
		.map((x) => x.item);
}
/**
 * 期限を過ぎた外部由来の item を、1 件ずつ別の writer transaction で停止する。
 * operationId は `expire:<itemId>:<revision>` で、記録があれば停止を繰り返さない（異常終了の後の再実行も 1 回）。
 */
export async function runExpire(
	host: MemoryHost,
	options: { recovery?: boolean; afterItem?: (n: number) => void } = {},
): Promise<{ expired: number; remaining: boolean }> {
	const targets = host.options.port.read((db) =>
		expiredItems(host, db, EXPIRE_BATCH + 1),
	);
	let expired = 0;
	for (const item of targets.slice(0, EXPIRE_BATCH)) {
		const operationId = `expire:${item.itemId}:${item.revision}`;
		const done = await host.write((db) => {
			const prior = db
				.query("SELECT 1 AS x FROM host_operation WHERE id=? AND plan_id=?")
				.get(operationId, EXPIRE_PLAN_ID);
			if (prior) return false;
			const result = deactivateState(db, {
				contractVersion: 1,
				access: internalAccess(host),
				scopeKey: item.scopeKey,
				clock: { atMs: host.clock() },
				itemId: item.itemId,
				expectedRevision: item.revision,
			});
			// 期限を数えた後に訂正や停止があれば、その item は今回は止めない。
			if (result.status !== "applied") return false;
			db.query(
				"INSERT INTO host_operation(id,plan_id,epoch,scope_keys,payload,result,created_at) VALUES(?,?,?,?,NULL,?,?) ON CONFLICT(id) DO NOTHING",
			).run(
				operationId,
				EXPIRE_PLAN_ID,
				host.epoch,
				JSON.stringify([item.scopeKey]),
				JSON.stringify({ status: "completed", operationId, expired: true }),
				host.clock(),
			);
			host.snapshots.invalidate([item.scopeKey]);
			return true;
		}, options.recovery ?? false);
		if (done) expired++;
		options.afterItem?.(expired);
	}
	return { expired, remaining: targets.length > EXPIRE_BATCH };
}
/** 管理用の `reactivate`（admin の grant）。active に戻し、最終利用日を今日にして 90 日を数え直す。 */
export function reactivate(
	host: MemoryHost,
	db: MemoryDb,
	grant: Grant,
	itemId: string,
): HostResult {
	host.admin(grant);
	const item = listItems(
		db,
		internalAccess(host),
		host.config.scopeKeys,
		Infinity,
		true,
		[itemId],
	)[0];
	demand(item, "ITEM_NOT_AVAILABLE");
	const result = reactivateState(db, {
		contractVersion: 1,
		access: internalAccess(host),
		scopeKey: item.scopeKey,
		clock: { atMs: host.clock() },
		itemId,
		expectedRevision: item.revision,
	});
	if (result.status === "rejected")
		throw new HostError(result.reasonCode, "blocked");
	demand(
		result.status === "applied" || result.status === "unchanged",
		"STATE_WRITE_REJECTED",
	);
	if (host.trust(db, result.item) === "external")
		db.query(
			"INSERT INTO host_item_use(item_id,last_used_day) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET last_used_day=excluded.last_used_day",
		).run(itemId, utcDay(host.clock()));
	host.snapshots.invalidate([item.scopeKey]);
	return {
		status: "completed",
		itemId,
		revision: result.item.revision,
		itemStatus: result.item.status,
		...(host.trust(db, result.item) === "external"
			? { expiresOn: expiresOnText(expiresAtMs(db, itemId)) }
			: {}),
	};
}
