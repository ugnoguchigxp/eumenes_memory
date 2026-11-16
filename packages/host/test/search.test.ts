/** S9: ホストの `search`（設計 §3.7、§3.8、§4.2）。件数と byte の上限、無害化、検索用の snapshot、読み取り専用。 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertUserState, verifyStateSearchIndex } from "eumenes-memory/sqlite";
import { exitCode, type HostResult } from "../src/contracts.ts";
import { sanitizeQuery } from "../src/search.ts";
import { SOURCE_BY_REF_SQL } from "../src/service.ts";
import { restoreStore } from "../src/transport.ts";
import {
	bulkSeed,
	disposeFixtures,
	fixture,
	items,
	remember,
	type Fixture,
} from "./support.ts";

afterEach(disposeFixtures);

let counter = 0;
/** 本人確認済みの item を、ホストの書き込みの順番で直接入れる（plan と apply を何十回も通さないため）。 */
async function seed(
	h: Fixture,
	text: string,
	options: {
		scopeKey?: string;
		attributes?: Record<string, string>;
		quotes?: string[];
	} = {},
) {
	counter += 1;
	const scopeKey = options.scopeKey ?? "personal";
	// 引用は 1024 B まで。既定は本文の先頭の 300 文字以内を引用にし、本文そのものを出典にする。
	const quotes = options.quotes ?? [[...text].slice(0, 300).join("")];
	const content = options.quotes ? quotes.join("\n") : text;
	const ref = {
		namespace: "test-app",
		kind: "message",
		id: `seed-${counter}`,
		revision: "r1",
		representation: "text",
		digest: createHash("sha256").update(content).digest("hex"),
	};
	let offset = 0;
	const evidence = quotes.map((quote) => {
		const start = offset;
		offset += Buffer.byteLength(quote) + 1;
		return {
			source: {
				...ref,
				range: { startByte: start, endByte: start + Buffer.byteLength(quote) },
			},
			quote,
		};
	});
	return await h.owner.port.write((db) => {
		const r = assertUserState(db, {
			contractVersion: 1,
			access: h.host.access(
				h.configuration().credentials[h.profile.credential]!,
			),
			scopeKey,
			clock: { atMs: h.host.clock() },
			subject: "self",
			kind: "preference",
			semanticKey: `seed-${counter}`,
			value: {
				text,
				polarity: "affirmed",
				...(options.attributes ? { attributes: options.attributes } : {}),
			},
			origin: "user_confirmed",
			evidence,
			sources: [
				{
					...ref,
					principal: h.configuration().principal,
					scopeKey,
					status: "available",
					content,
					ordinal: counter,
				},
			],
		});
		expect(r.status).toBe("applied");
		return r.status === "applied" ? r.item.itemId : "";
	});
}
async function search(h: Fixture, params: Record<string, unknown>) {
	return await h.call("search", params);
}
function itemsOf(result: HostResult) {
	return result["items"] as {
		itemId: string;
		revision: number;
		value: { text: string };
		trust?: string;
	}[];
}
function count(h: Fixture, sql: string): unknown {
	return h.owner.port.read((db) => db.query(sql).get());
}

test("T-CAP-1 default limit is 20", async () => {
	const h = await fixture();
	for (let i = 0; i < 50; i++) await seed(h, `抹茶ラテが好き ${i}`);
	const result = await search(h, { query: "抹茶ラテ" });
	expect(result).toMatchObject({
		status: "found",
		returned: 20,
		moreAvailable: true,
		truncatedBy: "count",
		query: { indexedTerms: ["抹茶ラテ"], scannedTerms: [], mode: "fts" },
	});
	expect(itemsOf(result)).toHaveLength(20);
	expect(exitCode(result)).toBe(0);
});

test("T-CAP-2 limit above 20 rejected", async () => {
	const h = await fixture();
	const result = await search(h, { query: "抹茶ラテ", limit: 21 });
	expect(result).toEqual({ status: "blocked", code: "INVALID_INPUT" });
	expect(exitCode(result)).toBe(4);
	for (const maxBytes of [16383, 65537])
		expect(await search(h, { query: "抹茶ラテ", maxBytes })).toEqual({
			status: "blocked",
			code: "INVALID_INPUT",
		});
});

test("T-CAP-3 byte budget truncates", async () => {
	const h = await fixture();
	for (let i = 0; i < 20; i++)
		await seed(h, `大きな記憶${i} ${"あ".repeat(1330)}`.slice(0, 1340));
	const result = await search(h, { query: "大きな記憶", maxBytes: 16384 });
	expect(result).toMatchObject({
		status: "found",
		moreAvailable: true,
		truncatedBy: "bytes",
	});
	const shown = itemsOf(result);
	expect(shown.length).toBeGreaterThan(0);
	expect(shown.length).toBeLessThanOrEqual(3);
	expect(
		shown.reduce((a, x) => a + Buffer.byteLength(JSON.stringify(x)), 0),
	).toBeLessThanOrEqual(16384);
	expect(Buffer.byteLength(shown.map((x) => x.value.text).join(""))).toBe(
		shown.reduce((a, x) => a + Buffer.byteLength(x.value.text), 0),
	);
});

test("T-CAP-4 largest single item fits min budget", async () => {
	const h = await fixture();
	// 本文 4096 B、属性 16 個（鍵 64 B、値 256 B）、根拠 8 件（引用は各 1024 B）。JSON の escape の要らない文字で作る。
	const text = `最大の記憶 ${"い".repeat(1360)}`;
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
	const attributes = Object.fromEntries(
		Array.from({ length: 16 }, (_, k) => [
			`${String.fromCharCode(97 + k)}${"k".repeat(63)}`,
			"う".repeat(85),
		]),
	);
	const quotes = Array.from({ length: 8 }, (_, k) => `${k}${"え".repeat(341)}`);
	await seed(h, text, { attributes, quotes });
	const result = await search(h, { query: "最大の記憶", maxBytes: 16384 });
	expect(result).toMatchObject({
		status: "found",
		returned: 1,
		truncatedBy: null,
	});
	expect(
		Buffer.byteLength(JSON.stringify(itemsOf(result)[0])),
	).toBeLessThanOrEqual(16384);
});

test("T-CAP-5 exact 20 matches has no more flag", async () => {
	const h = await fixture();
	for (let i = 0; i < 20; i++) await seed(h, `ほうじ茶が好き ${i}`);
	expect(await search(h, { query: "ほうじ茶" })).toMatchObject({
		status: "found",
		returned: 20,
		moreAvailable: false,
		truncatedBy: null,
	});
});

test("T-CAP-6 response under model input", async () => {
	const h = await fixture();
	for (let i = 0; i < 25; i++)
		await seed(h, `長い記憶${i} ${"お".repeat(1300)}`, {
			attributes: Object.fromEntries(
				Array.from({ length: 16 }, (_, k) => [`key${k}`, "か".repeat(85)]),
			),
		});
	const result = await search(h, { query: "長い記憶" });
	expect(result["truncatedBy"]).toBe("bytes");
	// mcp.ts と同じ形（本文の text と structuredContent の両方に同じ結果が入る）。
	const response = {
		content: [{ type: "text", text: JSON.stringify(result) }],
		structuredContent: result,
		isError: false,
	};
	expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(131072);
});

test("T-SCOPE-2/3 host: scopes are checked and no score is returned", async () => {
	const h = await fixture({ scopes: ["personal", "work"] });
	await seed(h, "仕事の抹茶ラテ", { scopeKey: "work" });
	await seed(h, "家の抹茶ラテ");
	expect(
		await search(h, { query: "抹茶ラテ", scopeKeys: ["other"] }),
	).toMatchObject({ status: "blocked", code: "SCOPE_NOT_PERMITTED" });
	const only = await search(h, { query: "抹茶ラテ", scopeKeys: ["personal"] });
	expect(itemsOf(only).map((x) => x.value.text)).toEqual(["家の抹茶ラテ"]);
	const both = await search(h, { query: "抹茶ラテ" });
	expect(both["returned"]).toBe(2);
	expect(JSON.stringify(both)).not.toMatch(/bm25|score|"rank"/);
});

test("T-Q-1 fts syntax is literal", async () => {
	const h = await fixture();
	const text = 'he said "OR NOT NEAR( * col:x ) ^start';
	await seed(h, text);
	await seed(h, "関係のない記憶");
	for (const query of [
		'"OR',
		"NOT NEAR(",
		"col:x",
		"* col:x )",
		"^start",
		'said "OR',
	]) {
		const result = await search(h, { query });
		expect(result.status).toBe("found");
		expect(itemsOf(result).map((x) => x.value.text)).toEqual([text]);
	}
	expect(itemsOf(await search(h, { query: "OR 関係" }))).toEqual([]);
});

test("T-Q-2 limits", async () => {
	const h = await fixture();
	const invalid = [
		"あ".repeat(257),
		"é".repeat(200) + "x".repeat(625), // 825 文字、1025 B
		"a1 a2 a3 a4 a5 a6 a7 a8 a9",
		"x".repeat(65),
		"abc\u0001",
		"abc\u007f",
		"abc\ud800",
		"\udc00abc",
	];
	expect(Buffer.byteLength(invalid[1]!)).toBe(1025);
	for (const query of invalid)
		expect(await search(h, { query })).toEqual({
			status: "blocked",
			code: "QUERY_INVALID",
		});
	for (const query of [" ", "\u3000\t "])
		expect(await search(h, { query })).toEqual({
			status: "blocked",
			code: "QUERY_EMPTY",
		});
	// 境目: 256 文字、1024 B、8 語、64 文字の語は通る。
	for (const query of [
		`${Array.from({ length: 7 }, () => "あ".repeat(31)).join(" ")} ${"あ".repeat(32)}`,
		Array.from({ length: 4 }, () => "😀".repeat(63)).join(" "),
		"a1 a2 a3 a4 a5 a6 a7 a8",
		"x".repeat(64),
		"😀😀😀",
	])
		expect((await search(h, { query })).status).toBe("found");
	expect(await search(h, { query: "" })).toEqual({
		status: "blocked",
		code: "INVALID_INPUT",
	});
});

test("search splits on U+0020, U+3000 and tab, dedupes, and routes terms by length", () => {
	expect(sanitizeQuery("通勤\u3000コーヒー\t通勤  珈琲豆")).toEqual({
		indexedTerms: ["コーヒー", "珈琲豆"],
		scannedTerms: ["通勤"],
	});
	expect(sanitizeQuery("😀😀 😀😀😀")).toEqual({
		indexedTerms: ["😀😀😀"],
		scannedTerms: ["😀😀"],
	});
});

test("T-Q-3/4 host: short terms scan and fail closed over the scan limit", async () => {
	const h = await fixture({ host: { limits: { searchScanMax: 2 } } });
	await seed(h, "電車通勤のときはコーヒー");
	await seed(h, "徒歩通勤");
	expect(await search(h, { query: "電車通勤" })).toMatchObject({
		returned: 1,
		query: { mode: "fts" },
	});
	expect(await search(h, { query: "通勤 コーヒー" })).toMatchObject({
		returned: 1,
		query: { mode: "fts" },
	});
	expect(await search(h, { query: "通勤" })).toMatchObject({
		returned: 2,
		query: { mode: "scan" },
	});
	await seed(h, "車で通勤");
	const blocked = await search(h, { query: "通勤" });
	expect(blocked).toEqual({ status: "blocked", code: "QUERY_TOO_SHORT" });
	expect(exitCode(blocked)).toBe(4);
	// 長い語を足せば FTS の経路で引ける。
	expect((await search(h, { query: "通勤 車で通" }))["returned"]).toBe(1);
});

test("T-SNAP-1 search snapshot allows read and use, rejects plan", async () => {
	const h = await fixture();
	await remember(h, "週末は陶芸を楽しむ");
	const result = await search(h, { query: "陶芸を" });
	const [item] = itemsOf(result);
	expect(item).toBeDefined();
	expect(
		await h.call("read", {
			snapshotId: result["snapshotId"],
			itemId: item!.itemId,
		}),
	).toMatchObject({ status: "found" });
	expect(
		await h.call("read", { snapshotId: result["snapshotId"] }),
	).toMatchObject({ status: "blocked", code: "COMPLETE_SNAPSHOT_REQUIRED" });
	expect(
		await h.call("plan", {
			snapshotId: result["snapshotId"],
			scopeKey: "personal",
			proposal: {
				decision: { clarification: null, actions: [] },
				relations: [],
				groups: [],
			},
		}),
	).toMatchObject({ status: "blocked", code: "COMPLETE_SNAPSHOT_REQUIRED" });
	expect(
		await h.call("use", {
			snapshotId: result["snapshotId"],
			items: [{ itemId: item!.itemId, revision: item!.revision }],
		}),
	).toMatchObject({ status: "completed" });
});

test("T-SNAP-2 search snapshots do not exhaust context capacity", async () => {
	const h = await fixture();
	await seed(h, "抹茶ラテが好き");
	const first = await search(h, { query: "抹茶ラテ" });
	for (let i = 0; i < 100; i++)
		expect((await search(h, { query: "抹茶ラテ" })).status).toBe("found");
	expect((await h.call("context")).status).toBe("context");
	// 検索用の枠は 32 個で、古いものから捨てる。
	expect(
		await h.call("read", {
			snapshotId: first["snapshotId"],
			itemId: itemsOf(first)[0]!.itemId,
		}),
	).toMatchObject({ status: "stale", code: "SNAPSHOT_EXPIRED" });
	// context の枠は今までどおり 32 個まで（検索の snapshot は数えない）。
	for (let i = 0; i < 31; i++)
		expect((await h.call("context")).status).toBe("context");
	expect(await h.call("context")).toMatchObject({ code: "SNAPSHOT_CAPACITY" });
	expect((await search(h, { query: "抹茶ラテ" })).status).toBe("found");
});

test("T-IDEM-6 search is read-only", async () => {
	const h = await fixture();
	await remember(h, "抹茶ラテが好き");
	const snapshot = () => ({
		seq: count(h, "SELECT value FROM memory_seq"),
		operations: count(h, "SELECT count(*) AS n FROM host_operation"),
		plans: count(h, "SELECT count(*) AS n FROM host_plan"),
		items: count(h, "SELECT count(*) AS n FROM memory_state_item"),
		events: count(h, "SELECT count(*) AS n FROM memory_state_event"),
		uses: count(h, "SELECT count(*) AS n FROM host_item_use"),
		journal: (h.owner.port.journal.read() as unknown[]).length,
	});
	const before = snapshot();
	for (let i = 0; i < 100; i++)
		await search(h, { query: i % 2 ? "抹茶ラテ" : "抹茶" });
	expect(snapshot()).toEqual(before);
});

test("T-POI-2 search shows external trust", async () => {
	const h = await fixture();
	await remember(h, "ウェブで見た抹茶ラテの話", undefined, {
		provenance: "web",
		semanticKey: "web",
	});
	const [item] = itemsOf(await search(h, { query: "抹茶ラテ" }));
	expect(item?.trust).toBe("external");
	expect(item).toHaveProperty("evidenceStatus");
	expect(item).toHaveProperty("expiresOn");
});

test("search filters by kinds and subject", async () => {
	const h = await fixture();
	await seed(h, "抹茶ラテが好き");
	expect(
		(await search(h, { query: "抹茶ラテ", kinds: ["habit"] }))["returned"],
	).toBe(0);
	expect(
		(await search(h, { query: "抹茶ラテ", kinds: ["preference"] }))["returned"],
	).toBe(1);
	expect(
		(await search(h, { query: "抹茶ラテ", subject: "other:a" }))["returned"],
	).toBe(0);
	expect(
		await search(h, { query: "抹茶ラテ", kinds: ["unknown"] }),
	).toMatchObject({ code: "INVALID_INPUT" });
});

test("search rejects kinds and subjects the core would reject as invalid input, not as a failure", async () => {
	const h = await fixture();
	await seed(h, "抹茶ラテが好き");
	// subject の上限は UTF-8 の 128 byte（核の LIMITS_STATE.maxSubjectBytes）。
	const atLimit = `other:${"あ".repeat(40)}${"a".repeat(2)}`;
	expect(Buffer.byteLength(atLimit)).toBe(128);
	expect(
		await search(h, { query: "抹茶ラテ", subject: atLimit }),
	).toMatchObject({ status: "found", returned: 0 });
	for (const params of [
		{ kinds: ["preference", "preference"] },
		{ subject: "other:" },
		{ subject: `${atLimit}a` },
		{ subject: "other:a\u0007b" },
		{ subject: "other:\ud800" },
	]) {
		const result = await search(h, { query: "抹茶ラテ", ...params });
		expect(result).toEqual({ status: "blocked", code: "INVALID_INPUT" });
		expect(exitCode(result)).not.toBe(1);
	}
});

test("search needs read permission and fails closed when the index is unavailable", async () => {
	const h = await fixture();
	await seed(h, "抹茶ラテが好き");
	h.host.searchIndexUnavailable = true;
	const failed = await search(h, { query: "抹茶ラテ" });
	expect(failed).toEqual({
		status: "failed",
		code: "SEARCH_INDEX_UNAVAILABLE",
	});
	expect(exitCode(failed)).toBe(1);
	// ほかの操作には影響させない。
	expect((await h.call("context")).status).toBe("context");
});

test("T-BAK-10 search index survives restore", async () => {
	const h = await fixture();
	await remember(h, "コーヒーが好きです");
	const backup = await h.call("backup");
	expect(backup.status).toBe("completed");
	await remember(h, "犬が好きです", undefined, { semanticKey: "pet" });
	await h.close();
	expect(
		await restoreStore(backup["path"] as string, h.dir, () => h.clock.now),
	).toMatchObject({ status: "completed" });
	await h.reopen();
	expect(h.host.searchIndexUnavailable).toBe(false);
	expect(
		await h.owner.port.write((db) => verifyStateSearchIndex(db)),
	).toMatchObject({
		consistent: true,
	});
	const context = await items(h);
	const found = itemsOf(await search(h, { query: "好きです" }));
	expect(found.map((x) => x.itemId).sort()).toEqual(
		context.map((x) => x.itemId).sort(),
	);
	expect(itemsOf(await search(h, { query: "犬が好" }))).toEqual([]);
});

test("search and context inspect each evidence once per request", async () => {
	const h = await fixture();
	await bulkSeed(h, 5, { text: (i) => `抹茶ラテが好き ${i}` });
	const original = h.host.inspectEvidence.bind(h.host);
	let calls = 0;
	h.host.inspectEvidence = (...args) => {
		calls++;
		return original(...args);
	};
	const found = await search(h, { query: "抹茶ラテ" });
	expect(found["returned"]).toBe(5);
	expect(calls).toBe(5);
	// snapshot の指紋は同じ結果を使う（item ごとの再読み取りで一致する）。
	const first = itemsOf(found)[0]!;
	expect(
		(
			await h.call("read", {
				snapshotId: found["snapshotId"],
				itemId: first.itemId,
			})
		).status,
	).toBe("found");
	calls = 0;
	const context = await h.call("context");
	expect(context.status).toBe("context");
	expect(calls).toBe(5);
});

test("read finds a search result older than the first snapshotItems items of the scope", async () => {
	const h = await fixture();
	// 最も古い item だけが「珍味トリュフ」を含む。その後に 10,001 件（HOST_LIMITS.snapshotItems より多く）を入れる。
	await bulkSeed(h, 1, { text: () => "珍味トリュフが好き" });
	await bulkSeed(h, 10001);
	const found = await search(h, { query: "珍味トリュフ" });
	expect(found["returned"]).toBe(1);
	const target = itemsOf(found)[0]!;
	expect(
		await h.call("read", {
			snapshotId: found["snapshotId"],
			itemId: target.itemId,
		}),
	).toMatchObject({ status: "found", item: { itemId: target.itemId } });
}, 60000);

test("the source lookup by reference uses the host_source_ref index", async () => {
	const h = await fixture();
	const plan = h.owner.port.read(
		(db) =>
			db
				.query(`EXPLAIN QUERY PLAN ${SOURCE_BY_REF_SQL}`)
				.all("personal", "host", "source", "x") as { detail: string }[],
	);
	expect(plan.map((x) => x.detail).join("\n")).toContain(
		"USING INDEX host_source_ref",
	);
});
