/** S1（決定 9）: 忘却の apply の後に wal_checkpoint(TRUNCATE) を行い、WAL に古い本文を残さない。 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	disposeFixtures,
	fixture,
	forget,
	items,
	leakedTrigrams,
	remember,
} from "./support.ts";

afterEach(disposeFixtures);

const SECRET = "ZQXWVU秘密の好み";

test("S1 forget checkpoints the WAL and leaves no trigram of the forgotten State text", async () => {
	const h = await fixture();
	const saved = await remember(h, SECRET);
	expect(saved.result.status).toBe("completed");
	const target = (await items(h))[0]!;
	const files = ["memory.db", "memory.db-wal"].map((n) => join(h.dir, n));
	expect(leakedTrigrams(SECRET, files).length).toBeGreaterThan(0);
	const result = await forget(h, target.itemId, [saved.source["sourceHandle"]]);
	expect(result.status).toBe("completed");
	expect(await items(h)).toEqual([]);
	expect(leakedTrigrams(SECRET, files)).toEqual([]);
	expect(await h.call("status")).toMatchObject({ checkpointPending: false });
});

test("S1 a failed checkpoint keeps the forget successful and reports checkpointPending", async () => {
	const behaviour = { fail: false };
	const h = await fixture({
		wrapPort: (port) => ({
			...port,
			checkpoint: async () =>
				behaviour.fail ? false : await port.checkpoint!(),
		}),
	});
	const saved = await remember(h, SECRET);
	const target = (await items(h))[0]!;
	behaviour.fail = true;
	const result = await forget(h, target.itemId, [saved.source["sourceHandle"]]);
	expect(result.status).toBe("completed");
	expect(await h.call("status")).toMatchObject({ checkpointPending: true });
	behaviour.fail = false;
	// 次の書き込みの後に再試行され、印が消える。
	await remember(h, "別の記憶です", undefined, { semanticKey: "other" });
	expect(await h.call("status")).toMatchObject({ checkpointPending: false });
	expect(
		leakedTrigrams(
			SECRET,
			["memory.db", "memory.db-wal"].map((n) => join(h.dir, n)),
		),
	).toEqual([]);
});

test("S1 a throwing checkpoint does not fail the forget", async () => {
	const h = await fixture({
		wrapPort: (port) => ({
			...port,
			checkpoint: async () => {
				throw new Error("busy");
			},
		}),
	});
	const saved = await remember(h, SECRET);
	const target = (await items(h))[0]!;
	expect(
		(await forget(h, target.itemId, [saved.source["sourceHandle"]])).status,
	).toBe("completed");
	expect(await h.call("status")).toMatchObject({ checkpointPending: true });
});

test("S1 control: without the checkpoint port the WAL keeps the forgotten text", async () => {
	const h = await fixture({
		wrapPort: ({ checkpoint: _checkpoint, ...port }) => port,
	});
	const saved = await remember(h, SECRET);
	const target = (await items(h))[0]!;
	await forget(h, target.itemId, [saved.source["sourceHandle"]]);
	expect(
		leakedTrigrams(SECRET, [join(h.dir, "memory.db-wal")]).length,
	).toBeGreaterThan(0);
});
