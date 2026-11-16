/**
 * 見直しの一覧（設計 §4D.2 の 3、S10）。CLI の `review` だけが使う読み取り専用の操作で、本文は返さない。
 * 次の条件に当たる item の ID と鍵を、20 件まで（cursor なし。§3.7 と同じ）返す。
 * - `trust: external` で、自動停止まで 14 日以内のもの（active）、または停止したもの（inactive）
 * - `agent_inferred` で、作成から 180 日を超え、一度も確認や訂正をされていないもの（active、revision 1）
 * - 成立期間（`validUntilMs`）が過ぎたもの（active）
 * 一覧を見て忘れるときは、通常の `plan` と `apply` を使う（特別な削除の経路は作らない）。
 */
import type { MemoryDb } from "eumenes-memory/sqlite";
import type { StateItem } from "eumenes-memory";
import type { Grant, HostResult, MethodParams } from "./contracts.ts";
import { DAY_MS, createdAtMs, expiresAtMs, expiresOnText } from "./expiry.ts";
import { listItems } from "./state.ts";
import type { MemoryHost } from "./service.ts";

/** 返す件数の上限（search と同じ）。 */
export const REVIEW_LIMIT = 20;
/** 自動停止までの日数がこれ以内なら一覧に出す。 */
export const REVIEW_EXPIRY_WINDOW_DAYS = 14;
/** 確認されていない推論の記憶を一覧に出すまでの日数。 */
export const REVIEW_INFERRED_AGE_DAYS = 180;

export type ReviewReason =
	| "external_expiring"
	| "external_stopped"
	| "inferred_unconfirmed"
	| "validity_ended";

export function runReview(
	host: MemoryHost,
	grant: Grant,
	p: MethodParams<"review">,
): HostResult {
	const scopes = p.scopeKeys ?? grant.scopeKeys;
	host.allowed(grant, scopes);
	return host.options.port.read((db: MemoryDb) => {
		const now = host.clock();
		const due: { item: StateItem; reason: ReviewReason; at: number }[] = [];
		for (const item of listItems(
			db,
			host.access(grant),
			scopes,
			Infinity,
			true,
		)) {
			const external = host.trust(db, item) === "external";
			if (external && item.status === "inactive") {
				due.push({ item, reason: "external_stopped", at: 0 });
				continue;
			}
			if (item.status !== "active") continue;
			if (external) {
				const at = expiresAtMs(db, item.itemId);
				if (at - now <= REVIEW_EXPIRY_WINDOW_DAYS * DAY_MS) {
					due.push({ item, reason: "external_expiring", at });
					continue;
				}
			}
			if (item.validUntilMs !== null && item.validUntilMs <= now) {
				due.push({ item, reason: "validity_ended", at: item.validUntilMs });
				continue;
			}
			if (item.origin === "agent_inferred" && item.revision === 1) {
				const at =
					createdAtMs(db, item.itemId) + REVIEW_INFERRED_AGE_DAYS * DAY_MS;
				if (at < now) due.push({ item, reason: "inferred_unconfirmed", at });
			}
		}
		due.sort(
			(a, b) =>
				a.at - b.at ||
				(a.item.itemId < b.item.itemId
					? -1
					: a.item.itemId > b.item.itemId
						? 1
						: 0),
		);
		const shown = due.slice(0, REVIEW_LIMIT);
		return {
			status: "found",
			scopeKeys: [...scopes],
			items: shown.map(({ item, reason }) => ({
				itemId: item.itemId,
				scopeKey: item.scopeKey,
				subject: item.subject,
				kind: item.kind,
				semanticKey: item.semanticKey,
				status: item.status,
				revision: item.revision,
				origin: item.origin,
				reason,
				...(reason === "external_expiring"
					? { expiresOn: expiresOnText(expiresAtMs(db, item.itemId)) }
					: {}),
			})),
			returned: shown.length,
			moreAvailable: due.length > REVIEW_LIMIT,
		};
	});
}
