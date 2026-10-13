/**
 * 模擬 Eumenes ホスト（test/runners/fake-eumenes-host.ts）越しの運用シナリオ。
 * 実 Eumenes には触れない。ホストが渡す入力・非同期の競合・再起動・DB 復元・ジャーナル改ざんを決定的に試す。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FakeEumenesHost, HOST_ACCESS } from "../runners/fake-eumenes-host.ts";

const hosts: FakeEumenesHost[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.close();
});
function open(): FakeEumenesHost {
	const host = new FakeEumenesHost();
	hosts.push(host);
	return host;
}
/** restart / restore が返す新しいホストも後片付けの対象にする。 */
function track(host: FakeEumenesHost): FakeEumenesHost {
	hosts.push(host);
	return host;
}

const LIKES = "私はコーヒーが好きです。";

/** user message を 1 件追加して State を書き、その item の id を返す。 */
async function seedItem(host: FakeEumenesHost, text = LIKES) {
	const id = host.conversation.add("user", text);
	const outcome = await host.assertFact({
		messageId: id,
		semanticKey: `drink-${id}`,
		value: { text: "コーヒー", polarity: "affirmed" },
	});
	expect(outcome).toMatchObject({ status: "applied" });
	const items = host.listItems();
	expect(items.length).toBeGreaterThan(0);
	return { messageId: id, itemId: items[0]!.itemId };
}

describe("startup", () => {
	test("a fresh host passes the startup procedure", () => {
		const host = open();
		expect(host.startup).toEqual({ status: "ready", reapplied: 0 });
	});
});

describe("State through the host queue", () => {
	test("two writes queued at the same time both apply, in order", async () => {
		const host = open();
		const a = host.conversation.add("user", "私はコーヒーが好きです。");
		const b = host.conversation.add("user", "私は紅茶が好きです。");
		const [first, second] = await Promise.all([
			host.assertFact({
				messageId: a,
				semanticKey: "coffee",
				value: { text: "コーヒー", polarity: "affirmed" },
			}),
			host.assertFact({
				messageId: b,
				semanticKey: "tea",
				value: { text: "紅茶", polarity: "affirmed" },
			}),
		]);
		expect(first).toMatchObject({ status: "applied" });
		expect(second).toMatchObject({ status: "applied" });
		expect(
			host
				.listItems()
				.map((item) => item.value.text)
				.sort(),
		).toEqual(["コーヒー", "紅茶"]);
	});
});

describe("forget, crash, restart and restore", () => {
	test("crash after the journal append: restart re-applies the forget", async () => {
		const host = open();
		const { itemId } = await seedItem(host);
		await expect(
			host.forgetItem(itemId, { crashAfterJournal: true }),
		).rejects.toThrow("simulated crash");
		// DB はまだ忘却していない（apply 前）。
		expect(host.listItems()).toHaveLength(1);
		const restarted = track(host.restart());
		expect(restarted.startup).toEqual({ status: "ready", reapplied: 1 });
		expect(restarted.listItems()).toEqual([]);
	});

	test("restoring a pre-forget backup re-applies the forget from the latest journal", async () => {
		const host = open();
		const { itemId } = await seedItem(host);
		const backup = host.backup("before-forget");
		await host.forgetItem(itemId);
		expect(host.listItems()).toEqual([]);
		const restored = track(host.restoreFrom(backup));
		expect(restored.startup).toEqual({ status: "ready", reapplied: 1 });
		expect(
			restored.listItems(true).every((item) => item.status === "forgotten"),
		).toBe(true);
	});

	test("a clean restart keeps state and reapplies nothing", async () => {
		const host = open();
		await seedItem(host);
		const restarted = track(host.restart());
		expect(restarted.startup).toEqual({ status: "ready", reapplied: 0 });
		expect(restarted.listItems()).toHaveLength(1);
	});
});

describe("fail closed", () => {
	test("a tampered journal disables memory: no writes", async () => {
		const host = open();
		const { itemId } = await seedItem(host);
		await host.forgetItem(itemId);
		const entries = host.journal.read();
		host.journal.overwrite([{ ...entries[0]!, principal: "someone:else" }]);
		const restarted = track(host.restart());
		expect(restarted.startup.status).toBe("disabled");
		const id = restarted.conversation.add("user", LIKES);
		expect(
			await restarted.assertFact({
				messageId: id,
				semanticKey: "coffee",
				value: { text: "コーヒー", polarity: "affirmed" },
			}),
		).toEqual({ status: "skipped" });
	});

	test("a journal that lost entries the DB already applied disables memory (JOURNAL_MISSING)", async () => {
		const host = open();
		const { itemId } = await seedItem(host);
		await host.forgetItem(itemId);
		host.journal.overwrite([]);
		const restarted = track(host.restart());
		expect(restarted.startup).toEqual({
			status: "disabled",
			reason: "reconcile: JOURNAL_MISSING",
		});
	});

	test("access context used by the host stays scoped to its conversation", () => {
		expect(HOST_ACCESS.scopeKeys).toEqual(["conversation:c1"]);
	});
});
