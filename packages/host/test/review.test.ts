/** S10: 見直しの一覧（設計 §4D.2 の 3）。CLI だけ、読み取り専用、20 件まで、本文を返さない。 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertUserState } from "eumenes-memory/sqlite";
import {
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
