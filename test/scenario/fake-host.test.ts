/**
 * 模擬 Eumenes ホスト（test/runners/fake-eumenes-host.ts）越しの運用シナリオ。
 * 実 Eumenes には触れない。ホストが渡す入力・非同期の競合・再起動・DB 復元・ジャーナル改ざんを決定的に試す。
 * H 段階の証明ではない（verification-status の H は実 Eumenes 結合）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FakeEumenesHost, HOST_ACCESS } from "../runners/fake-eumenes-host.ts";
import { ruleExtractor } from "../runners/extraction-stubs.ts";

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

/** user message を 1 件追加して auto で抽出し、採用された item の id を返す。 */
async function seedAdmittedItem(host: FakeEumenesHost, text = LIKES) {
	const id = host.conversation.add("user", text);
	const outcome = await host.extract({
		jobId: `job-${id}`,
		messageIds: [id],
		extractor: ruleExtractor(),
		policy: "auto",
	});
	expect(outcome).toMatchObject({ status: "applied" });
	const items = host.listItems();
	expect(items.length).toBeGreaterThan(0);
	return { messageId: id, itemId: items[items.length - 1]!.itemId };
}

describe("startup", () => {
	test("a fresh host passes the startup procedure", () => {
		const host = open();
		expect(host.startup).toEqual({ status: "ready", reapplied: 0 });
	});
});

describe("extraction through the host queue", () => {
	test("default policy only produces pending candidates; confirm admits one", async () => {
		const host = open();
		const id = host.conversation.add("user", LIKES);
		const outcome = await host.extract({
			jobId: "j1",
			messageIds: [id],
			extractor: ruleExtractor(),
		});
		expect(outcome).toMatchObject({
			status: "applied",
			result: { status: "applied", admitted: 0, pendingUser: 1 },
		});
		expect(host.listItems()).toEqual([]);
		const [candidate] = host.listPending();
		const confirmed = await host.confirm(candidate!.candidateId, "admit");
		expect(confirmed.status).toBe("admitted");
		expect(host.listItems()).toHaveLength(1);
	});

	test("a message edited while the model runs makes the run stale and writes nothing", async () => {
		const host = open();
		const id = host.conversation.add("user", LIKES);
		const outcome = await host.extract({
			jobId: "j1",
			messageIds: [id],
			extractor: ruleExtractor(),
			policy: "auto",
			during: () => host.conversation.edit(id, "私はコーヒーが嫌いです。"),
		});
		expect(outcome).toMatchObject({
			status: "applied",
			result: { status: "stale", reasonCode: "SOURCE_CHANGED" },
		});
		expect(host.listItems(true)).toEqual([]);
		expect(host.listPending()).toEqual([]);
		// 次の試行（新しい attempt）は編集後の本文で通る。
		const retry = await host.extract({
			jobId: "j1",
			attempt: 2,
			messageIds: [id],
			extractor: ruleExtractor(),
			policy: "auto",
		});
		expect(retry).toMatchObject({ result: { status: "applied", admitted: 1 } });
		expect(host.listItems()[0]?.value.polarity).toBe("negated");
	});

	test("a message deleted while the model runs makes the run stale", async () => {
		const host = open();
		const id = host.conversation.add("user", LIKES);
		const outcome = await host.extract({
			jobId: "j1",
			messageIds: [id],
			extractor: ruleExtractor(),
			policy: "auto",
			during: () => host.conversation.remove(id),
		});
		expect(outcome).toMatchObject({ result: { status: "stale" } });
		expect(host.listItems(true)).toEqual([]);
	});

	test("two jobs queued at the same time both settle, in order", async () => {
		const host = open();
		const a = host.conversation.add("user", "私はコーヒーが好きです。");
		const b = host.conversation.add("user", "私は紅茶が好きです。");
		const [first, second] = await Promise.all([
			host.extract({
				jobId: "ja",
				messageIds: [a],
				extractor: ruleExtractor(),
				policy: "auto",
			}),
			host.extract({
				jobId: "jb",
				messageIds: [b],
				extractor: ruleExtractor(),
				policy: "auto",
			}),
		]);
		expect(first).toMatchObject({ result: { status: "applied" } });
		expect(second).toMatchObject({ result: { status: "applied" } });
		expect(
			host
				.listItems()
				.map((item) => item.value.text)
				.sort(),
		).toEqual(["コーヒー", "紅茶"]);
	});
});

describe("dialogue adoption", () => {
	test("a view built from admitted state is adopted when nothing changes", async () => {
		const host = open();
		await seedAdmittedItem(host);
		const outcome = await host.dialogue({
			reply: (view) =>
				view.status === "ready" ? `items:${view.items.length}` : view.status,
		});
		expect(outcome).toMatchObject({ status: "adopted", reply: "items:1" });
	});

	test("editing the evidence message while the reply is generated rejects adoption", async () => {
		const host = open();
		const { messageId } = await seedAdmittedItem(host);
		const outcome = await host.dialogue({
			reply: () => "ok",
			during: () => host.conversation.edit(messageId, "やっぱり何でもない"),
		});
		expect(outcome.status).toBe("rejected");
	});

	test("deleting the evidence message rejects adoption", async () => {
		const host = open();
		const { messageId } = await seedAdmittedItem(host);
		const outcome = await host.dialogue({
			reply: () => "ok",
			during: () => host.conversation.remove(messageId),
		});
		expect(outcome.status).toBe("rejected");
	});

	test("forgetting the item while the reply is generated rejects adoption", async () => {
		const host = open();
		const { itemId } = await seedAdmittedItem(host);
		const outcome = await host.dialogue({
			reply: () => "ok",
			during: async () => {
				await host.forgetItem(itemId);
			},
		});
		expect(outcome.status).toBe("rejected");
		const after = host.buildView();
		expect(after.status === "ready" ? after.items : []).toEqual([]);
	});
});

describe("forget, crash, restart and restore", () => {
	test("crash after the journal append: restart re-applies the forget", async () => {
		const host = open();
		const { itemId } = await seedAdmittedItem(host);
		await expect(
			host.forgetItem(itemId, { crashAfterJournal: true }),
		).rejects.toThrow("simulated crash");
		// DB はまだ忘却していない（apply 前）。
		expect(host.listItems()).toHaveLength(1);
		const restarted = track(host.restart());
		expect(restarted.startup).toEqual({ status: "ready", reapplied: 1 });
		expect(restarted.listItems()).toEqual([]);
		expect(restarted.buildView()).toMatchObject({ status: "ready", items: [] });
	});

	test("restoring a pre-forget backup re-applies the forget from the latest journal", async () => {
		const host = open();
		const { itemId } = await seedAdmittedItem(host);
		const backup = host.backup("before-forget");
		await host.forgetItem(itemId);
		expect(host.listItems()).toEqual([]);
		const restored = track(host.restoreFrom(backup));
		expect(restored.startup).toEqual({ status: "ready", reapplied: 1 });
		expect(
			restored.listItems(true).every((item) => item.status === "forgotten"),
		).toBe(true);
		const view = restored.buildView();
		expect(view.status === "ready" ? view.items : []).toEqual([]);
	});

	test("a clean restart keeps state and reapplies nothing", async () => {
		const host = open();
		await seedAdmittedItem(host);
		const restarted = track(host.restart());
		expect(restarted.startup).toEqual({ status: "ready", reapplied: 0 });
		expect(restarted.listItems()).toHaveLength(1);
	});
});

describe("fail closed", () => {
	test("a tampered journal disables memory: no extraction, no dialogue", async () => {
		const host = open();
		const { itemId } = await seedAdmittedItem(host);
		await host.forgetItem(itemId);
		const entries = host.journal.read();
		host.journal.overwrite([{ ...entries[0]!, principal: "someone:else" }]);
		const restarted = track(host.restart());
		expect(restarted.startup.status).toBe("disabled");
		const id = restarted.conversation.add("user", LIKES);
		expect(
			await restarted.extract({
				jobId: "j",
				messageIds: [id],
				extractor: ruleExtractor(),
			}),
		).toEqual({ status: "skipped", reason: "memory_off" });
		expect(await restarted.dialogue({ reply: () => "x" })).toMatchObject({
			status: "memory_off",
		});
	});

	test("a journal that lost entries the DB already applied disables memory (JOURNAL_MISSING)", async () => {
		const host = open();
		const { itemId } = await seedAdmittedItem(host);
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
