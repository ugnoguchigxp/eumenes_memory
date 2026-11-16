/** S10: 見直しの一覧（設計 §4D.2 の 3）。CLI だけ、読み取り専用、20 件まで、本文を返さない。 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertUserState } from "eumenes-memory/sqlite";
import type { StateItem } from "eumenes-memory";
import {
	createdAtMs,
	expiredItems,
	expiresAtMs,
	expiresOnText,
} from "../src/expiry.ts";
import { listItems } from "../src/state.ts";
import {
	bulkSeed,
	countReadQueries,
	disposeFixtures,
	DAY_MS,
	fixture,
	items,
	remember,
	type Fixture,
} from "./support.ts";

afterEach(disposeFixtures);
import { writeMarkers } from "./support.ts";

const T0 = 20000 * DAY_MS + 3600000;
type Row = { itemId: string; reason: string; semanticKey: string };
async function review(h: Fixture, params: Record<string, unknown> = {}) {
	const result = await h.call("review", params);
	expect(result.status).toBe("found");
	return result as typeof result & { items: Row[] };
}
async function external(h: Fixture, key: string, scopeKey = "personal") {
	const saved = await remember(h, `ウェブで見た${key}`, undefined, {
		provenance: "web",
		semanticKey: key,
		scopeKey,
	});
	expect(saved.result.status).toBe("completed");
}

test("T-CAPY-4 review list is bounded", async () => {
	const h = await fixture({ now: T0 });
	for (let i = 0; i < 50; i++) {
		await external(h, `web${i}`);
		// 保存の補助は毎回 context を作るので、context の snapshot の枠（32 個、5 分）を空ける。
		h.advance(300001);
	}
	h.advance(80 * DAY_MS);
	const result = await review(h);
	expect(result).toMatchObject({ returned: 20, moreAvailable: true });
	expect(result.items).toHaveLength(20);
	expect(result.items.every((x) => x.reason === "external_expiring")).toBe(
		true,
	);
	expect(result).not.toHaveProperty("nextCursor");
	// 本文は返さない。
	expect(JSON.stringify(result)).not.toContain("ウェブで見た");
});

test("T-CAPY-5 review list does not mutate", async () => {
	const h = await fixture({ now: T0 });
	await external(h, "web");
	await remember(h, "推論した好み", undefined, { semanticKey: "guess" });
	h.advance(200 * DAY_MS);
	const before = writeMarkers(h);
	const journal = (h.owner.port.journal.read() as unknown[]).length;
	for (let i = 0; i < 20; i++) await review(h);
	expect(writeMarkers(h)).toEqual(before);
	expect((h.owner.port.journal.read() as unknown[]).length).toBe(journal);
});

test("review reasons: expiring, stopped, unconfirmed inference and ended validity", async () => {
	const h = await fixture({ now: T0 });
	await external(h, "web");
	await remember(h, "推論した好み", undefined, {
		provenance: "agent_reasoning",
		semanticKey: "guess",
	});
	await remember(h, "推論して直した好み", undefined, {
		provenance: "agent_reasoning",
		semanticKey: "edited",
	});
	await remember(h, "本人が言った好み", undefined, {
		provenance: "user_message",
		semanticKey: "said",
	});
	// 成立期間の過ぎた item（本人確認済み、直接入れる）。
	const content = "去年の夏だけ水泳に通っていた";
	const ref = {
		namespace: "test-app",
		kind: "message",
		id: "valid",
		revision: "r1",
		representation: "text",
		digest: createHash("sha256").update(content).digest("hex"),
	};
	await h.owner.port.write((db) =>
		assertUserState(db, {
			contractVersion: 1,
			access: h.host.access(
				h.configuration().credentials[h.profile.credential]!,
			),
			scopeKey: "personal",
			clock: { atMs: h.host.clock() },
			subject: "self",
			kind: "habit",
			semanticKey: "swim",
			value: { text: content, polarity: "affirmed" },
			origin: "user_confirmed",
			validUntilMs: T0 + DAY_MS,
			evidence: [
				{
					source: {
						...ref,
						range: { startByte: 0, endByte: Buffer.byteLength(content) },
					},
					quote: content,
				},
			],
			sources: [
				{
					...ref,
					principal: h.configuration().principal,
					scopeKey: "personal",
					status: "available",
					content,
					ordinal: 1,
				},
			],
		}),
	);
	expect((await review(h)).items).toEqual([]);
	h.advance(77 * DAY_MS);
	expect((await review(h)).items.map((x) => [x.semanticKey, x.reason])).toEqual(
		[
			["swim", "validity_ended"],
			["web", "external_expiring"],
		],
	);
	expect((await review(h)).items[1]).toHaveProperty("expiresOn");
	// 90 日を過ぎて停止すると「停止したもの」として残る（T-EXP-1 の見直しの一覧の部分）。
	h.advance(14 * DAY_MS);
	expect((await h.call("expire"))["expired"]).toBe(1);
	expect((await review(h)).items.map((x) => [x.semanticKey, x.reason])).toEqual(
		[
			["web", "external_stopped"],
			["swim", "validity_ended"],
		],
	);
	// 180 日を超えた、確認も訂正もされていない推論の記憶。訂正したもの（新しい item）は、まだ 180 日に届かないので出ない。
	const guess = (await items(h)).find((x) => x["semanticKey"] === "edited")!;
	await remember(h, "推論して直した好み、その後", guess, {
		provenance: "agent_reasoning",
		semanticKey: "edited",
	});
	h.advance(90 * DAY_MS);
	const listed = (await review(h)).items.map((x) => [x.semanticKey, x.reason]);
	expect(listed).toContainEqual(["guess", "inferred_unconfirmed"]);
	// 出典が user_message でも、origin は agent_inferred のまま（確認ではない）なので一覧に出る。
	expect(listed).toContainEqual(["said", "inferred_unconfirmed"]);
	expect(listed.map((x) => x[0])).not.toContain("edited");
});

test("review checks scope and read permission and is not an MCP tool", async () => {
	const h = await fixture();
	expect(await h.call("review", { scopeKeys: ["other"] })).toMatchObject({
		status: "blocked",
		code: "SCOPE_NOT_PERMITTED",
	});
	expect(await h.call("review", { limit: 21 })).toEqual({
		status: "blocked",
		code: "INVALID_INPUT",
	});
	const { CLI_ONLY_METHODS } = await import("../src/contracts.ts");
	expect(CLI_ONLY_METHODS).toContain("review");
});

/** 修正の前の見直しの一覧（scope の全件を水和して JS で選ぶ）。新しい実装と同じ結果になることを確かめる参照。 */
function referenceReview(h: Fixture) {
	const grant = h.configuration().credentials[h.profile.credential]!;
	return h.owner.port.read((db) => {
		const now = h.host.clock();
		const due: { item: StateItem; reason: string; at: number }[] = [];
		for (const item of listItems(
			db,
			h.host.access(grant),
			grant.scopeKeys,
			Infinity,
			true,
		)) {
			const external = h.host.trust(db, item) === "external";
			if (external && item.status === "inactive") {
				due.push({ item, reason: "external_stopped", at: 0 });
				continue;
			}
			if (item.status !== "active") continue;
			if (external) {
				const at = expiresAtMs(db, item.itemId);
				if (at - now <= 14 * DAY_MS) {
					due.push({ item, reason: "external_expiring", at });
					continue;
				}
			}
			if (item.validUntilMs !== null && item.validUntilMs <= now) {
				due.push({ item, reason: "validity_ended", at: item.validUntilMs });
				continue;
			}
			if (item.origin === "agent_inferred" && item.revision === 1) {
				const at = createdAtMs(db, item.itemId) + 180 * DAY_MS;
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
		return {
			items: due.slice(0, 20).map(({ item, reason }) => ({
				itemId: item.itemId,
				reason,
				...(reason === "external_expiring"
					? { expiresOn: expiresOnText(expiresAtMs(db, item.itemId)) }
					: {}),
			})),
			moreAvailable: due.length > 20,
		};
	});
}
/** 修正の前の自動停止の対象（同じく参照）。 */
function referenceExpired(h: Fixture): string[] {
	return h.owner.port.read((db) => {
		const now = h.host.clock();
		const access = h.host.access(
			h.configuration().credentials[h.profile.credential]!,
		);
		return listItems(db, access, h.configuration().scopeKeys)
			.filter((item) => h.host.trust(db, item) === "external")
			.map((item) => ({ item, at: expiresAtMs(db, item.itemId) }))
			.filter((x) => x.at <= now)
			.sort((a, b) => a.at - b.at || (a.item.itemId < b.item.itemId ? -1 : 1))
			.map((x) => x.item.itemId);
	});
}

test("review and expire choose the same items as the full scan, at every point in time", async () => {
	const h = await fixture({ now: T0 });
	// 外部由来（ウェブ）、内部の推論、本人の発言、直接入れた推論（出典に結び付かないので外部由来）と本人確認済み。
	for (let i = 0; i < 12; i++) {
		await external(h, `web${i}`);
		h.advance(300001);
	}
	for (let i = 0; i < 6; i++) {
		await remember(h, `推論した好み${i}`, undefined, {
			provenance: i % 2 ? "agent_reasoning" : "user_message",
			semanticKey: `guess${i}`,
		});
		h.advance(300001);
	}
	const used = (await items(h)).find((x) => x["semanticKey"] === "web3")!;
	const shown = await h.call("context");
	expect(
		(
			await h.call("use", {
				snapshotId: shown["snapshotId"],
				items: [{ itemId: used.itemId, revision: used["revision"] }],
			})
		).status,
	).toBe("completed");
	const compare = async () => {
		const actual = await review(h);
		const expected = referenceReview(h);
		expect(
			actual.items.map((x) => ({
				itemId: x.itemId,
				reason: x.reason,
				...("expiresOn" in x
					? { expiresOn: (x as { expiresOn: string }).expiresOn }
					: {}),
			})),
		).toEqual(expected.items);
		expect(actual["moreAvailable"]).toBe(expected.moreAvailable);
		expect(
			h.owner.port.read((db) =>
				expiredItems(h.host, db, Infinity).map((x) => x.itemId),
			),
		).toEqual(referenceExpired(h));
		return actual.items.length;
	};
	const seen: number[] = [];
	for (const step of [0, 40, 36, 1, 13, 1, 30, 60, 1, 90]) {
		h.advance(step * DAY_MS);
		// 40 日目に、出典に結び付かない推論（外部由来）と本人確認済みをまとめて入れる（期限の違う集団を作る）。
		if (step === 40) {
			await bulkSeed(h, 15, { origin: "agent_inferred" });
			await bulkSeed(h, 10, { origin: "user_confirmed" });
		}
		seen.push(await compare());
		if (step === 13) await h.call("expire");
	}
	// 容量の信頼の数え方（SQL）も MemoryHost.trust と同じ。
	const grant = h.configuration().credentials[h.profile.credential]!;
	const counts = { confirmed: 0, inferred: 0, external: 0 };
	h.owner.port.read((db) => {
		for (const item of listItems(db, h.host.access(grant), grant.scopeKeys))
			counts[h.host.trust(db, item)]++;
	});
	expect(counts.external).toBeGreaterThan(0);
	expect(counts.inferred).toBeGreaterThan(0);
	expect(counts.confirmed).toBeGreaterThan(0);
	expect((await h.call("status"))["capacity"]).toMatchObject({ trust: counts });
	// 途中で一覧が空でなく、20 件の上限にも届いたこと（比べた意味があること）。
	expect(Math.max(...seen)).toBe(20);
	expect(seen.some((n) => n > 0 && n < 20)).toBe(true);
});

test("review and expire read only candidates, not every item in scope", async () => {
	const h = await fixture({ now: T0 });
	await external(h, "web");
	h.advance(80 * DAY_MS);
	// 候補にならない item を多く入れる（新しい推論は外部由来だが期限が遠い。本人確認済みは対象外）。
	await bulkSeed(h, 300, { origin: "agent_inferred" });
	await bulkSeed(h, 300, {
		origin: "user_confirmed",
		scopeKey: "personal",
		text: (i) => `確認済み ${i}`,
	});
	const listed = await countReadQueries(h, () => review(h));
	expect(listed.result.items.map((x) => x.reason)).toEqual([
		"external_expiring",
	]);
	expect(listed.queries).toBeLessThan(30);
	const expired = await countReadQueries(h, () => h.call("expire"));
	expect(expired.result["expired"]).toBe(0);
	expect(expired.queries).toBeLessThan(30);
});

test("authorizeForget reads a bounded number of rows, not every item in scope", async () => {
	const h = await fixture({ now: T0 });
	await bulkSeed(h, 300, { origin: "agent_inferred" });
	const grant = {
		...h.configuration().credentials[h.profile.credential]!,
		confirmedWrites: false,
	};
	// 本人確認済みの item の有無を調べるときに読む行の数は、item の数によらない
	// （問い合わせの回数だけでは、まとめて全件を読む実装と区別できないので、返った行を数える）。
	const authorize = () =>
		h.owner.port.read((db) => {
			const target = db as unknown as { query: (sql: string) => unknown };
			const query = target.query;
			let rows = 0;
			target.query = (sql: string) => {
				const statement = query.call(target, sql) as Record<
					string,
					(...a: unknown[]) => unknown
				>;
				return new Proxy(statement, {
					get(object, key) {
						const value = Reflect.get(object, key) as unknown;
						if (typeof value !== "function") return value;
						return (...args: unknown[]) => {
							const result = (value as (...a: unknown[]) => unknown).apply(
								object,
								args,
							);
							if (key === "all" || key === "values")
								rows += (result as unknown[]).length;
							else if (key === "get" && result != null) rows++;
							else if (key === "iterate") throw new Error("iterate は数えない");
							return result;
						};
					},
				});
			};
			try {
				h.host.authorizeForget(db, grant);
				return { rows, code: undefined as string | undefined };
			} catch (error) {
				return { rows, code: (error as { code?: string }).code };
			} finally {
				target.query = query;
			}
		});
	const allowed = authorize();
	expect(allowed.code).toBeUndefined();
	expect(allowed.rows).toBeLessThan(5);
	// 本人確認済みが 1 件でもあれば、前と同じく拒否する。
	await bulkSeed(h, 1, { origin: "user_confirmed" });
	const denied = authorize();
	expect(denied.code).toBe("CONFIRMED_FORGET_REQUIRES_PERMISSION");
	expect(denied.rows).toBeLessThan(5);
	// confirmedWrites があれば調べない。
	grant.confirmedWrites = true;
	expect(authorize()).toEqual({ rows: 0, code: undefined });
});
