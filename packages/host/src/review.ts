/**
 * 見直しの一覧（設計 §4D.2 の 3、S10）。CLI の `review` だけが使う読み取り専用の操作で、本文は返さない。
 * 次の条件に当たる item の ID と鍵を、20 件まで（cursor なし。§3.7 と同じ）返す。
 * - `trust: external` で、自動停止まで 14 日以内のもの（active）、または停止したもの（inactive）
 * - `agent_inferred` で、作成から 180 日を超え、一度も確認や訂正をされていないもの（active、revision 1）
 * - 成立期間（`validUntilMs`）が過ぎたもの（active）
 * 一覧を見て忘れるときは、通常の `plan` と `apply` を使う（特別な削除の経路は作らない）。
 */
import type { MemoryDb } from "eumenes-memory/sqlite";
import type { Grant, HostResult, MethodParams } from "./contracts.ts";
import { DAY_MS, expiresOnText, hydrateInOrder, itemFacts } from "./expiry.ts";
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
		const window = REVIEW_EXPIRY_WINDOW_DAYS * DAY_MS;
		const age = REVIEW_INFERRED_AGE_DAYS * DAY_MS;
		// 候補だけを SQL で選ぶ（下の理由の決め方のどれかに当たりうるもの）。理由と順序は下で決める。
		const facts = itemFacts(
			db,
			host.access(grant).principal,
			scopes,
			`(c.status='inactive' AND c.trust='external') OR (c.status='active' AND (
				(c.trust='external' AND c.expires - ? <= ?)
				OR (c.valid_until_ms IS NOT NULL AND c.valid_until_ms <= ?)
				OR (c.origin='agent_inferred' AND c.revision=1 AND c.created + ? < ?)))`,
			[now, window, now, age, now],
		);
		const due: { id: string; reason: ReviewReason; at: number }[] = [];
		for (const fact of facts) {
			const external = fact.trust === "external";
			if (external && fact.status === "inactive") {
				due.push({ id: fact.item_id, reason: "external_stopped", at: 0 });
				continue;
			}
			if (fact.status !== "active") continue;
			if (external && fact.expires - now <= window) {
				due.push({
					id: fact.item_id,
					reason: "external_expiring",
					at: fact.expires,
				});
				continue;
			}
			if (fact.valid_until_ms !== null && fact.valid_until_ms <= now) {
				due.push({
					id: fact.item_id,
					reason: "validity_ended",
					at: fact.valid_until_ms,
				});
				continue;
			}
			if (fact.origin === "agent_inferred" && fact.revision === 1) {
				const at = fact.created + age;
				if (at < now)
					due.push({ id: fact.item_id, reason: "inferred_unconfirmed", at });
			}
		}
		due.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const top = due.slice(0, REVIEW_LIMIT);
		const items = new Map(
			hydrateInOrder(
				db,
				host.access(grant),
				scopes,
				top.map((x) => x.id),
				true,
			).map((item) => [item.itemId, item]),
		);
		const shown = top.flatMap(({ id, reason, at }) => {
			const item = items.get(id);
			return item ? [{ item, reason, at }] : [];
		});
		return {
			status: "found",
			scopeKeys: [...scopes],
			items: shown.map(({ item, reason, at }) => ({
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
					? { expiresOn: expiresOnText(at) }
					: {}),
			})),
			returned: shown.length,
			moreAvailable: due.length > REVIEW_LIMIT,
		};
	});
}
