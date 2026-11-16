/** S6（§4D.2）: 容量の監視と、上限に近いときの新しい key の保存の制限。 */
import { expect, test } from "bun:test";
import {
	fixture,
	forget,
	items,
	plan,
	remember,
	writeMarkers,
	type Fixture,
} from "./support.ts";

const SECRET = "ZQXWVU秘密の好み";

async function fill(h: Fixture, n: number, from = 0) {
	for (let i = from; i < from + n; i++)
		expect(
			(
				await remember(h, `記憶その${i}です`, undefined, {
					semanticKey: `k${i}`,
				})
			).result.status,
		).toBe("completed");
}
test("T-CAPY-1 status reports capacity without memory text", async () => {
	const h = await fixture({ scopes: ["personal", "work"] });
	await remember(h, SECRET, undefined, { provenance: "web" });
	await remember(h, "仕事の好みです", undefined, {
		scopeKey: "work",
		provenance: "user_message",
		semanticKey: "work",
	});
	const status = await h.call("status");
	expect(JSON.stringify(status)).not.toContain("秘密");
	expect(status["capacity"]).toMatchObject({
		scopes: {
			personal: { active: 1 },
			work: { active: 1 },
		},
		kinds: { preference: 2 },
		trust: { confirmed: 0, inferred: 1, external: 1 },
		rows: { active: 2 },
		usage: {
			snapshotItems: { used: 2, limit: 10000 },
			maxJournalEntries: { used: 0 },
		},
	});
	const capacity = status["capacity"] as {
		databaseBytes: number;
		usage: { snapshotBytes: { used: number } };
	};
	expect(capacity.databaseBytes).toBeGreaterThan(0);
	expect(capacity.usage.snapshotBytes.used).toBeGreaterThan(0);
	expect(status["capacityWarnings"]).toEqual([]);
	// 置き換えと忘却の行数も数える。
	const [item] = await items(h, ["personal"]);
	await remember(h, "別の秘密の値", item, { provenance: "web" });
	const after = await h.call("status");
	expect(
		(after["capacity"] as { rows: Record<string, number> }).rows,
	).toMatchObject({
		active: 2,
		superseded: 1,
	});
});

test("T-CAPY-2 warnings at 70 and 90 percent", async () => {
	const h = await fixture({ host: { limits: { snapshotItems: 10 } } });
	await fill(h, 6);
	expect((await h.call("status"))["capacityWarnings"]).toEqual([]);
	await fill(h, 1, 6);
	expect((await h.call("status"))["capacityWarnings"]).toEqual([
		{ limit: "snapshotItems", level: 70, ratio: 0.7 },
	]);
	await fill(h, 2, 7);
	expect((await h.call("status"))["capacityWarnings"]).toEqual([
		{ limit: "snapshotItems", level: 90, ratio: 0.9 },
	]);
});

test("T-CAPY-3 new keys are blocked near the limit while corrections and forgets pass", async () => {
	const h = await fixture({ host: { limits: { snapshotItems: 10 } } });
	await fill(h, 9);
	const { planned } = await plan(h, "新しい鍵の記憶", undefined, {
		semanticKey: "new",
	});
	expect(planned).toMatchObject({
		status: "blocked",
		code: "CAPACITY_NEAR_LIMIT",
	});
	const target = (await items(h)).find((x) => x["semanticKey"] === "k0")!;
	expect(
		(await remember(h, "訂正した記憶です", target, { semanticKey: "k0" }))
			.result.status,
	).toBe("completed");
	const victim = (await items(h)).find((x) => x["semanticKey"] === "k1")!;
	expect((await forget(h, victim.itemId)).status).toBe("completed");
	// 減った後は新しい key を保存できる。
	expect(
		(await remember(h, "新しい鍵の記憶", undefined, { semanticKey: "new" }))
			.result.status,
	).toBe("completed");
});

test("T-CAPY-6 reads do not write", async () => {
	const h = await fixture();
	await fill(h, 3);
	const before = writeMarkers(h);
	for (let i = 0; i < 20; i++) {
		const context = await h.call("context");
		const first = (context["items"] as { itemId: string }[])[0]!;
		await h.call("read", {
			snapshotId: context["snapshotId"],
			itemId: first.itemId,
		});
		await h.call("status");
		// S9: search も読み取りだけ（同じ条件で検査する）。
		// S10: review も読み取りだけ。
		expect((await h.call("review")).status).toBe("found");
		const found = await h.call("search", { query: "記憶その" });
		expect(found.status).toBe("found");
		await h.call("read", {
			snapshotId: found["snapshotId"],
			itemId: (found["items"] as { itemId: string }[])[0]!.itemId,
		});
	}
	expect(writeMarkers(h)).toEqual(before);
});
