/** 段階 S1 以降の試験で共有する組み立て。既存の service.test.ts の fixture と同じ形。 */
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { assertUserState } from "eumenes-memory/sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialize, openStandalone, type AppPort } from "../src/storage.ts";
import { MemoryHost, type HostOptions } from "../src/service.ts";
import type { HostConfig } from "../src/contracts.ts";

export const DAY_MS = 86400000;
const dispose: (() => Promise<void>)[] = [];
/**
 * fixture を閉じて一時ディレクトリを消す。1 つのプロセスで複数の試験ファイルを走らせると、この module は 1 回だけ評価されるので、
 * ここで afterEach を登録すると最初のファイルにしか付かない（/tmp に残っていた）。fixture を使う試験ファイルは、
 * それぞれ `afterEach(disposeFixtures)` を呼ぶ。
 */
export async function disposeFixtures(): Promise<void> {
	for (const close of dispose.splice(0).reverse()) await close();
}
export function onDispose(close: () => Promise<void>): void {
	dispose.push(close);
}
export interface FixtureOptions {
	scopes?: string[];
	wrapPort?: (port: AppPort) => AppPort;
	host?: Partial<HostOptions>;
	dir?: string;
	now?: number;
}
export async function fixture(options: FixtureOptions = {}) {
	const scopes = options.scopes ?? ["personal"];
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "emh-"));
	const profile = initialize(dir, scopes, {
		backupDirectory: join(dir, "backups"),
	});
	const configuration = () =>
		JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as HostConfig;
	const clock = { now: options.now ?? Date.now() };
	let owner = openStandalone(dir);
	const make = () =>
		new MemoryHost({
			port: options.wrapPort ? options.wrapPort(owner.port) : owner.port,
			configuration,
			clock: () => clock.now,
			...options.host,
		});
	const state = { host: make() };
	await state.host.start();
	let closed = false;
	dispose.push(async () => {
		if (!closed) await owner.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const h = {
		dir,
		profile,
		configuration,
		clock,
		get host() {
			return state.host;
		},
		get owner() {
			return owner;
		},
		call: (
			method: string,
			params: unknown = {},
			credential = profile.credential,
		) => state.host.dispatch(credential, method, params),
		advance: (ms: number) => {
			clock.now += ms;
		},
		/** 所有者を閉じて開き直す（新しい epoch）。 */
		restart: async () => {
			await owner.close();
			owner = openStandalone(dir);
			state.host = make();
			await state.host.start();
		},
		close: async () => {
			closed = true;
			await owner.close();
		},
		reopen: async () => {
			owner = openStandalone(dir);
			closed = false;
			state.host = make();
			await state.host.start();
		},
	};
	return h;
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function proposal(
	text: string,
	item?: { itemId: string },
	options: { kind?: string; semanticKey?: string } = {},
) {
	return {
		decision: {
			clarification: null,
			actions: [
				{
					type: "remember",
					subject: "self",
					kind: options.kind ?? "preference",
					semanticKey: options.semanticKey ?? "drink",
					value: { text, polarity: "affirmed" },
					quote: text,
					replacesItemId: item?.itemId ?? null,
				},
			],
		},
		relations: [
			{
				actionIndex: 0,
				relation: item ? "supersedes" : "new",
				relatedItemIds: item ? [item.itemId] : [],
			},
		],
		groups: [[0]],
	};
}
export interface RememberOptions {
	scopeKey?: string;
	kind?: string;
	semanticKey?: string;
	provenance?: string;
	operationId?: string;
}
export async function plan(
	h: Fixture,
	text: string,
	item?: { itemId: string },
	options: RememberOptions = {},
) {
	const scopeKey = options.scopeKey ?? "personal";
	const context = await h.call("context", { scopeKeys: [scopeKey] });
	const source = await h.call("source", {
		submissionId: crypto.randomUUID(),
		scopeKey,
		content: text,
		...(options.provenance ? { provenance: options.provenance } : {}),
	});
	expect(source.status).toBe("registered");
	const planned = await h.call("plan", {
		snapshotId: context["snapshotId"],
		scopeKey,
		proposal: proposal(text, item, options),
		evidence: [
			{
				actionIndex: 0,
				sourceHandle: source["sourceHandle"],
				startByte: 0,
				endByte: Buffer.byteLength(text),
			},
		],
	});
	return { context, source, planned };
}
export async function remember(
	h: Fixture,
	text: string,
	item?: { itemId: string },
	options: RememberOptions = {},
) {
	const { context, source, planned } = await plan(h, text, item, options);
	expect(planned.status).toBe("planned");
	const params = {
		planId: planned["planId"],
		epoch: planned["epoch"],
		operationId: options.operationId ?? crypto.randomUUID(),
	};
	const result = await h.call("apply", params);
	return { context, source, plan: planned, params, result };
}
export function forgetProposal(itemId: string) {
	return {
		decision: { clarification: null, actions: [{ type: "forget", itemId }] },
		relations: [
			{ actionIndex: 0, relation: "forget", relatedItemIds: [itemId] },
		],
		groups: [[0]],
	};
}
/** item を忘れる。sourceHandles を渡すと原文も消す。 */
export async function forget(
	h: Fixture,
	itemId: string,
	sourceHandles: unknown[] = [],
	scopeKey = "personal",
) {
	const context = await h.call("context", { scopeKeys: [scopeKey] });
	const planned = await h.call("plan", {
		snapshotId: context["snapshotId"],
		scopeKey,
		proposal: forgetProposal(itemId),
		...(sourceHandles.length ? { sourceHandles } : {}),
	});
	expect(planned.status).toBe("planned");
	return await h.call("apply", {
		planId: planned["planId"],
		epoch: planned["epoch"],
		operationId: crypto.randomUUID(),
	});
}
export async function items(h: Fixture, scopeKeys?: string[]) {
	const context = await h.call("context", scopeKeys ? { scopeKeys } : {});
	return context["items"] as {
		itemId: string;
		revision: number;
		origin: string;
		trust?: string;
		[key: string]: unknown;
	}[];
}
/** 文字列の 3 文字の断片（コードポイント単位）が、ファイルの byte 列に一つでも残っていれば、その断片を返す。 */
export function leakedTrigrams(
	text: string,
	paths: readonly string[],
): string[] {
	const chars = [...text];
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= chars.length; i++)
		grams.add(chars.slice(i, i + 3).join(""));
	const found: string[] = [];
	for (const path of paths) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(path);
		} catch {
			continue;
		}
		for (const gram of grams)
			if (bytes.includes(Buffer.from(gram, "utf8")))
				found.push(`${path}:${gram}`);
	}
	return found;
}
/** 読み取りで変わってはならない値（State の変更の seq と、ホストの表の行数）。 */
export function writeMarkers(h: Fixture) {
	return h.owner.port.read((db) => ({
		seq: (db.query("SELECT value FROM memory_seq").get() as { value: number })
			.value,
		tables: Object.fromEntries(
			[
				"host_operation",
				"host_plan",
				"host_source",
				"host_state_source",
				"host_forget_intent",
				"memory_state_item",
				"memory_state_event",
			].map((t) => [
				t,
				(db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
			]),
		),
	}));
}
/**
 * 核の `assertUserState` で item を n 件、1 回の書き込みでまとめて入れる（plan と apply を通さない）。
 * ホストの出典に結び付かないので、origin が agent_inferred なら trust は external になる。返り値は itemId の配列（入れた順）。
 */
let bulkBatches = 0;
export async function bulkSeed(
	h: Fixture,
	n: number,
	options: {
		origin?: "user_confirmed" | "agent_inferred";
		text?: (i: number) => string;
		scopeKey?: string;
	} = {},
): Promise<string[]> {
	const scopeKey = options.scopeKey ?? "personal";
	const batch = ++bulkBatches;
	const access = h.host.access(
		h.configuration().credentials[h.profile.credential]!,
	);
	return await h.owner.port.write((db) => {
		const ids: string[] = [];
		for (let i = 0; i < n; i++) {
			const text = options.text?.(i) ?? `まとめて入れた記憶 ${i}`;
			const ref = {
				namespace: "test-app",
				kind: "message",
				id: `bulk-${batch}-${i}`,
				revision: "r1",
				representation: "text",
				digest: createHash("sha256").update(text).digest("hex"),
			};
			const result = assertUserState(db, {
				contractVersion: 1,
				access,
				scopeKey,
				clock: { atMs: h.host.clock() },
				subject: "self",
				kind: "preference",
				semanticKey: `bulk-${batch}-${i}`,
				value: { text, polarity: "affirmed" },
				origin: options.origin ?? "user_confirmed",
				evidence: [
					{
						source: {
							...ref,
							range: { startByte: 0, endByte: Buffer.byteLength(text) },
						},
						quote: text,
					},
				],
				sources: [
					{
						...ref,
						principal: h.configuration().principal,
						scopeKey,
						status: "available",
						content: text,
						ordinal: i + 1,
					},
				],
			});
			if (result.status !== "applied") throw new Error(JSON.stringify(result));
			ids.push(result.item.itemId);
		}
		return ids;
	});
}
/** 所有者のポートの読み取りの中で発行された SQL の数を数える（fn の間だけ）。 */
export async function countReadQueries<T>(
	h: Fixture,
	fn: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
	const port = h.owner.port;
	const original = port.read;
	let queries = 0;
	port.read = ((op: (db: never) => unknown) =>
		original((db) => {
			const target = db as unknown as { query: (...a: unknown[]) => unknown };
			const query = target.query;
			target.query = (...args: unknown[]) => {
				queries++;
				return query.apply(target, args);
			};
			try {
				return op(db as never);
			} finally {
				target.query = query;
			}
		})) as typeof port.read;
	try {
		return { result: await fn(), queries };
	} finally {
		port.read = original;
	}
}
