/** S6b（§4D.2a、決定 11）: 外部由来の item の自動停止と、再利用（use と適用した plan の参照）による延長。 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertUserState } from "eumenes-memory/sqlite";
import { runExpire } from "../src/expiry.ts";
import { restoreStore } from "../src/transport.ts";
import type { HostConfig } from "../src/contracts.ts";
import {
	disposeFixtures,
	DAY_MS,
	fixture,
	forget,
	items,
	remember,
	type Fixture,
} from "./support.ts";

afterEach(disposeFixtures);

/** UTC の日の境目から 1 時間後（日単位の判定を決まった形にする）。 */
const T0 = 20000 * DAY_MS + 3600000;

function q<T>(h: Fixture, sql: string, ...args: (string | number)[]): T[] {
	return h.owner.port.read((db) => db.query(sql).all(...args) as T[]);
}
function status(h: Fixture, itemId: string): string {
	return q<{ status: string }>(
		h,
		"SELECT status FROM memory_state_item WHERE item_id=?",
		itemId,
	)[0]!.status;
}
function useRows(h: Fixture) {
	return q<{ item_id: string; last_used_day: number }>(
		h,
		"SELECT * FROM host_item_use ORDER BY item_id",
	);
}
async function external(
	h: Fixture,
	text = "ウェブで見た好み",
	semanticKey = "web",
) {
	await remember(h, text, undefined, { provenance: "web", semanticKey });
	return (await items(h)).find((x) => x["semanticKey"] === semanticKey)!;
}
async function expire(h: Fixture) {
	const result = await h.call("expire");
	expect(result.status).toBe("completed");
	return result;
}
async function use(
	h: Fixture,
	refs: { itemId: string; revision: number }[],
	credential?: string,
) {
	const context = await h.call("context", {}, credential);
	return await h.call(
		"use",
		{ snapshotId: context["snapshotId"], items: refs },
		credential,
	);
}
function confirmed(h: Fixture, content: string, semanticKey: string) {
	const ref = {
		namespace: "test-app",
		kind: "message",
		id: crypto.randomUUID(),
		revision: "r1",
		representation: "text",
		digest: createHash("sha256").update(content).digest("hex"),
	};
	return h.owner.port.write((db) => {
		const r = assertUserState(db, {
			contractVersion: 1,
			access: h.host.access(
				h.configuration().credentials[h.profile.credential]!,
			),
			scopeKey: "personal",
			clock: { atMs: h.host.clock() },
			subject: "self",
			kind: "preference",
			semanticKey,
			value: { text: content, polarity: "affirmed" },
			origin: "user_confirmed",
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
		});
		expect(r.status).toBe("applied");
	});
}

test("a use committed after candidate selection prevents expiration", async () => {
	let pause = false;
	let selected!: () => void;
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		selected = resolve;
	});
	const resume = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await fixture({
		now: T0,
		wrapPort: (port) => ({
			...port,
			write: async (fn) => {
				if (pause) {
					pause = false;
					selected();
					await resume;
				}
				return port.write(fn);
			},
		}),
	});
	const item = await external(h);
	h.advance(91 * DAY_MS);
	pause = true;
	const stopping = runExpire(h.host);
	await waiting;
	try {
		expect(
			await use(h, [{ itemId: item.itemId, revision: item.revision }]),
		).toMatchObject({ status: "completed", updated: 1 });
	} finally {
		release();
	}
	expect(await stopping).toMatchObject({ expired: 0 });
	expect(await items(h)).toMatchObject([
		{ itemId: item.itemId, status: "active" },
	]);
});

test("T-EXP-1 external item stops after 90 days", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	expect(item["expiresOn"]).toBe("2025-01-02");
	h.advance(90 * DAY_MS - 60000);
	expect((await expire(h))["expired"]).toBe(0);
	h.advance(60001);
	expect((await expire(h))["expired"]).toBe(1);
	expect(status(h, item.itemId)).toBe("inactive");
	expect(await items(h)).toEqual([]);
	// S9: 停止した item は search にも出ない。
	expect(await h.call("search", { query: "ウェブで見た" })).toMatchObject({
		status: "found",
		items: [],
	});
	// S10: 見直しの一覧には「停止したもの」として出る。
	expect(await h.call("review")).toMatchObject({
		status: "found",
		items: [{ itemId: item.itemId, reason: "external_stopped" }],
	});
	// 停止は忘却ではない（ジャーナルを使わない）。
	expect(h.host.journalCount).toBe(0);
});

test("T-EXP-2 non-external items never auto-stop", async () => {
	const h = await fixture({ now: T0 });
	await remember(h, "コーヒーが好きです", undefined, {
		provenance: "user_message",
		semanticKey: "coffee",
	});
	await confirmed(h, "水が好き", "water");
	h.advance(365 * DAY_MS);
	await expire(h);
	await h.restart();
	const listed = await items(h);
	expect(listed.map((x) => x.trust).sort()).toEqual(["confirmed", "inferred"]);
	expect(listed.every((x) => x["expiresOn"] === undefined)).toBe(true);
});

test("T-EXP-3 use extends expiry", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	h.advance(80 * DAY_MS);
	const used = await use(h, [{ itemId: item.itemId, revision: item.revision }]);
	expect(used).toMatchObject({ status: "completed", updated: 1 });
	h.advance(10 * DAY_MS);
	await expire(h);
	expect(status(h, item.itemId)).toBe("active");
	h.advance(80 * DAY_MS); // 80 + 90 日目
	await expire(h);
	expect(status(h, item.itemId)).toBe("active");
	h.advance(DAY_MS); // その翌日
	await expire(h);
	expect(status(h, item.itemId)).toBe("inactive");
});

test("T-EXP-4 applied plan relation extends expiry", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	h.advance(80 * DAY_MS);
	const text = "紅茶も好きです";
	const context = await h.call("context");
	const source = await h.call("source", {
		submissionId: crypto.randomUUID(),
		scopeKey: "personal",
		content: text,
		provenance: "user_message",
	});
	const planned = await h.call("plan", {
		snapshotId: context["snapshotId"],
		scopeKey: "personal",
		proposal: {
			decision: {
				clarification: null,
				actions: [
					{
						type: "remember",
						subject: "self",
						kind: "preference",
						semanticKey: "tea",
						value: { text, polarity: "affirmed" },
						quote: text,
						replacesItemId: null,
					},
				],
			},
			relations: [
				{ actionIndex: 0, relation: "coexists", relatedItemIds: [item.itemId] },
			],
			groups: [[0]],
		},
		evidence: [
			{
				actionIndex: 0,
				sourceHandle: source["sourceHandle"],
				startByte: 0,
				endByte: Buffer.byteLength(text),
			},
		],
	});
	expect(planned.status).toBe("planned");
	expect(useRows(h)).toEqual([]);
	const applied = await h.call("apply", {
		planId: planned["planId"],
		epoch: planned["epoch"],
		operationId: crypto.randomUUID(),
	});
	expect(applied.status).toBe("completed");
	expect(useRows(h)).toEqual([{ item_id: item.itemId, last_used_day: 20080 }]);
	h.advance(10 * DAY_MS + 1);
	await expire(h);
	expect(status(h, item.itemId)).toBe("active");
	h.advance(81 * DAY_MS);
	await expire(h);
	expect(status(h, item.itemId)).toBe("inactive");
});

test("T-EXP-5 listing, read and unapplied plans do not extend", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	for (let day = 0; day < 90; day++) {
		const context = await h.call("context");
		expect(
			(
				await h.call("read", {
					snapshotId: context["snapshotId"],
					itemId: item.itemId,
				})
			).status,
		).toBe("found");
		const text = `別の記憶その${day}`;
		const source = await h.call("source", {
			submissionId: crypto.randomUUID(),
			scopeKey: "personal",
			content: text,
			provenance: "user_message",
		});
		const planned = await h.call("plan", {
			snapshotId: context["snapshotId"],
			scopeKey: "personal",
			proposal: {
				decision: {
					clarification: null,
					actions: [
						{
							type: "remember",
							subject: "self",
							kind: "preference",
							semanticKey: `other${day}`,
							value: { text, polarity: "affirmed" },
							quote: text,
							replacesItemId: null,
						},
					],
				},
				relations: [
					{
						actionIndex: 0,
						relation: "coexists",
						relatedItemIds: [item.itemId],
					},
				],
				groups: [[0]],
			},
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: source["sourceHandle"],
					startByte: 0,
					endByte: Buffer.byteLength(text),
				},
			],
		});
		expect(planned.status).toBe("planned");
		h.advance(DAY_MS);
	}
	h.advance(1);
	await expire(h);
	expect(status(h, item.itemId)).toBe("inactive");
	expect(useRows(h)).toEqual([]);
});

test("T-EXP-6 use is coarse and idempotent", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	const context = await h.call("context");
	const seq = () =>
		q<{ value: number }>(h, "SELECT value FROM memory_seq")[0]!.value;
	const before = seq();
	let updated = 0;
	for (let i = 0; i < 100; i++) {
		const result = await h.call("use", {
			snapshotId: context["snapshotId"],
			items: [{ itemId: item.itemId, revision: item.revision }],
		});
		expect(result.status).toBe("completed");
		updated += result["updated"] as number;
	}
	expect(updated).toBe(1);
	expect(seq()).toBe(before);
	// snapshot は切れない。
	expect(
		await h.call("read", { snapshotId: context["snapshotId"] }),
	).toMatchObject({
		status: "found",
		current: true,
	});
	h.advance(DAY_MS);
	const next = await use(h, [{ itemId: item.itemId, revision: item.revision }]);
	expect(next["updated"]).toBe(1);
});

test("T-EXP-7 use rejects unseen or stale revisions and unpermitted scopes", async () => {
	const h = await fixture({ now: T0, scopes: ["personal", "work"] });
	const item = await external(h);
	const context = await h.call("context");
	await remember(h, "仕事の外部の記録", undefined, {
		provenance: "web",
		scopeKey: "work",
		semanticKey: "work",
	});
	const work = (await items(h, ["work"]))[0]!;
	// snapshot に無い item（後から作った）。
	expect(
		await h.call("use", {
			snapshotId: context["snapshotId"],
			items: [{ itemId: work.itemId, revision: work.revision }],
		}),
	).toMatchObject({ code: "ITEM_NOT_AVAILABLE" });
	// 古い revision。1 つでも合わなければ全体を拒否する。
	expect(
		await use(h, [
			{ itemId: item.itemId, revision: item.revision },
			{ itemId: work.itemId, revision: work.revision + 1 },
		]),
	).toMatchObject({ code: "STALE_REVISION" });
	// 許可されていない scope の item。
	const config = h.configuration();
	const limited = "limited-credential-for-test";
	config.credentials[limited] = {
		clientId: "limited",
		scopeKeys: ["personal"],
		read: true,
		write: false,
		forgetAll: false,
		confirmedWrites: false,
	};
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(
		await use(h, [{ itemId: work.itemId, revision: work.revision }], limited),
	).toMatchObject({ code: "ITEM_NOT_AVAILABLE" });
	// 他の grant の snapshot は使えない。
	const full = await h.call("context");
	expect(
		(
			await h.call(
				"use",
				{
					snapshotId: full["snapshotId"],
					items: [{ itemId: item.itemId, revision: item.revision }],
				},
				limited,
			)
		).status,
	).not.toBe("completed");
	expect(useRows(h)).toEqual([]);
	// 読み取りだけの grant でも、見えている item の報告はできる。
	expect(
		await use(h, [{ itemId: item.itemId, revision: item.revision }], limited),
	).toMatchObject({ status: "completed", updated: 1 });
});

test("T-EXP-8 use on non-external writes nothing", async () => {
	const h = await fixture({ now: T0 });
	await remember(h, "コーヒーが好きです", undefined, {
		provenance: "user_message",
	});
	const item = (await items(h))[0]!;
	const result = await use(h, [
		{ itemId: item.itemId, revision: item.revision },
	]);
	expect(result).toMatchObject({
		status: "completed",
		updated: 0,
		items: [{ itemId: item.itemId }],
	});
	expect(useRows(h)).toEqual([]);
});

test("T-EXP-9 reactivate restores and restarts clock", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	h.advance(91 * DAY_MS);
	await expire(h);
	expect(status(h, item.itemId)).toBe("inactive");
	const result = await h.call("reactivate", { itemId: item.itemId });
	expect(result).toMatchObject({ status: "completed", itemStatus: "active" });
	expect(status(h, item.itemId)).toBe("active");
	h.advance(89 * DAY_MS);
	await expire(h);
	expect(status(h, item.itemId)).toBe("active");
	h.advance(2 * DAY_MS);
	await expire(h);
	expect(status(h, item.itemId)).toBe("inactive");
	expect(
		q(h, "SELECT id FROM host_operation WHERE plan_id='host:expire'").length,
	).toBe(2);
});

test("reactivate requires the admin grant", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	h.advance(91 * DAY_MS);
	await expire(h);
	const config: HostConfig = h.configuration();
	config.credentials["writer"] = {
		clientId: "writer",
		scopeKeys: ["personal"],
		read: true,
		write: true,
		forgetAll: false,
		confirmedWrites: false,
	};
	writeFileSync(join(h.dir, "owner.json"), JSON.stringify(config));
	expect(
		await h.call("reactivate", { itemId: item.itemId }, "writer"),
	).toMatchObject({
		code: "FORGET_REQUIRES_ALL_SCOPES",
	});
	expect(await h.call("expire", {}, "writer")).toMatchObject({
		code: "FORGET_REQUIRES_ALL_SCOPES",
	});
	expect(status(h, item.itemId)).toBe("inactive");
});

test("T-EXP-10 expire is idempotent across crash", async () => {
	const h = await fixture({ now: T0 });
	const a = await external(h, "外部の記録その一", "a");
	const b = await external(h, "外部の記録その二", "b");
	h.advance(91 * DAY_MS);
	await expect(
		runExpire(h.host, {
			afterItem: () => {
				throw new Error("crash");
			},
		}),
	).rejects.toThrow("crash");
	expect([status(h, a.itemId), status(h, b.itemId)].sort()).toEqual([
		"active",
		"inactive",
	]);
	await h.restart(); // 起動時の expire が残りを止める。
	await expire(h);
	await expire(h);
	for (const item of [a, b]) {
		expect(status(h, item.itemId)).toBe("inactive");
		expect(
			q(
				h,
				"SELECT id FROM host_operation WHERE id LIKE ?",
				`expire:${item.itemId}:%`,
			).length,
		).toBe(1);
		expect(
			q(
				h,
				"SELECT event_seq FROM memory_state_event WHERE item_id=? AND action='deactivate'",
				item.itemId,
			).length,
		).toBe(1);
	}
});

test("T-EXP-11 forget removes usage record, also after restore", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	h.advance(DAY_MS);
	await use(h, [{ itemId: item.itemId, revision: item.revision }]);
	expect(useRows(h).length).toBe(1);
	const backup = await h.call("backup");
	const old = join(h.dir, "old-backup");
	mkdirSync(old);
	const file = backup["path"] as string;
	copyFileSync(file, join(old, basename(file)));
	copyFileSync(
		file.replace(/\.db$/, ".json"),
		join(old, basename(file).replace(/\.db$/, ".json")),
	);
	expect((await forget(h, item.itemId)).status).toBe("completed");
	expect(useRows(h)).toEqual([]);
	await h.host.backupIdle();
	await h.close();
	const restored = await restoreStore(
		join(old, basename(file)),
		h.dir,
		() => h.clock.now,
	);
	expect(restored.status).toBe("completed");
	await h.reopen();
	expect(useRows(h)).toEqual([]);
	expect(await items(h)).toEqual([]);
	expect(
		readFileSync(join(h.dir, "forget.jsonl"), "utf8").length,
	).toBeGreaterThan(0);
});

test("T-CAPY-7 no automatic forget", async () => {
	const h = await fixture({ now: T0 });
	const item = await external(h);
	await remember(h, "コーヒーが好きです", undefined, {
		provenance: "user_message",
		semanticKey: "coffee",
	});
	h.advance(365 * DAY_MS);
	await expire(h);
	await h.restart();
	expect(h.host.journalCount).toBe(0);
	expect(status(h, item.itemId)).toBe("inactive");
	expect(
		q(h, "SELECT item_id FROM memory_state_item WHERE status='forgotten'"),
	).toEqual([]);
	expect((await items(h)).length).toBe(1);
	// S10: 停止したものは見直しの一覧に出るだけで、忘れるかどうかは利用者が決める。
	expect((await h.call("review"))["items"]).toContainEqual(
		expect.objectContaining({
			itemId: item.itemId,
			reason: "external_stopped",
		}),
	);
	expect(h.host.journalCount).toBe(0);
});
