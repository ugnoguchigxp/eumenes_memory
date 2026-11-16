#!/usr/bin/env bun
/**
 * ホスト経由の検索の測定（設計 §6.3 の「ホスト経由で evidenceStatus まで含める」、S9）。verify の対象外。
 * 一時ディレクトリにホストの店を作り、合成の item を核の `assertUserState` で入れてから、
 * `MemoryHost.dispatch("search")`（無害化、核の検索、水和、evidenceStatus と trust、byte の予算、検索用の snapshot）を測る。
 *
 * 使い方: bun bench/search-host.ts [--sizes 1000,10000] [--json out.json]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUserState } from "../src/sqlite.ts";
import { initialize, openStandalone } from "../packages/host/src/storage.ts";
import { MemoryHost } from "../packages/host/src/service.ts";
import type { HostConfig } from "../packages/host/src/contracts.ts";
import { expiredItems } from "../packages/host/src/expiry.ts";
import {
	makeSource,
	makeSpan,
	value,
} from "../src/domains/state/test/state-support.ts";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const SIZES = (arg("--sizes") ?? "1000,10000").split(",").map(Number);
const SCOPES = Array.from({ length: 10 }, (_, i) => `scope-${i}`);
const ALLOWED = SCOPES.slice(0, 3);
const FILLER = [
	"今日は天気が良いので散歩に出かけた",
	"the quick brown fox jumps over the lazy dog",
	"週末は家族と過ごすことが多い",
	"駅前の喫茶店で本を読むのが好きだ",
];
function makeText(bytes: number, i: number): string {
	const parts: string[] = [];
	if (i % 100 === 1) parts.push("珍味トリュフ");
	if (i % 10 < 3) parts.push("会議");
	if (i % 5 < 2) parts.push("コーヒー");
	if (i % 5 === 1 || i % 5 === 3) parts.push("ミルクティー");
	parts.push(`記録${i}`);
	let k = i;
	while (Buffer.byteLength(parts.join(" ")) < bytes)
		parts.push(FILLER[k++ % FILLER.length]!);
	let text = parts.join(" ");
	while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1);
	return text;
}
function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
	]!;
}
const QUERIES: Record<string, string> = {
	frequent: "コーヒー",
	rare: "珍味トリュフ",
	twoTerms: "コーヒー ミルクティー",
	shortOnly: "会議",
	mixed: "コーヒー 会議",
};
const results: unknown[] = [];
for (const n of SIZES) {
	const dir = mkdtempSync(join(tmpdir(), "search-host-bench-"));
	try {
		const profile = initialize(dir, SCOPES);
		const configuration = () =>
			JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as HostConfig;
		const owner = openStandalone(dir);
		const host = new MemoryHost({ port: owner.port, configuration });
		await host.start();
		const grant = configuration().credentials[profile.credential]!;
		const access = host.access(grant);
		for (let start = 0; start < n; start += 1000)
			await owner.port.write((db) => {
				for (let i = start; i < Math.min(n, start + 1000); i++) {
					const scopeKey = SCOPES[i % 10]!;
					const r = i % 20;
					const text = makeText(r === 0 ? 4000 : r < 6 ? 500 : 50, i);
					const source = makeSource(
						`m${i}`,
						text,
						i,
						{ principal: access.principal },
						scopeKey,
					);
					const result = assertUserState(db, {
						contractVersion: 1,
						access,
						scopeKey,
						clock: { atMs: 1000 + i },
						subject: "self",
						kind: "preference",
						semanticKey: `key-${i}`,
						value: value(text, "affirmed"),
						origin: "user_confirmed",
						evidence: [makeSpan(source, `記録${i}`)],
						sources: [source],
					});
					if (result.status !== "applied")
						throw new Error(JSON.stringify(result));
				}
			});
		const timings: Record<string, unknown> = {};
		for (const [name, query] of Object.entries(QUERIES)) {
			const call = () =>
				host.dispatch(profile.credential, "search", {
					query,
					scopeKeys: ALLOWED,
				});
			for (let i = 0; i < 3; i++) await call();
			const samples: number[] = [];
			let last: Record<string, unknown> = {};
			for (let i = 0; i < 30; i++) {
				const t = performance.now();
				last = await call();
				samples.push(performance.now() - t);
			}
			timings[name] = {
				p50: Number(percentile(samples, 50).toFixed(3)),
				p95: Number(percentile(samples, 95).toFixed(3)),
				status: last["status"],
				returned: last["returned"],
				truncatedBy: last["truncatedBy"],
				responseBytes: Buffer.byteLength(JSON.stringify(last)),
			};
		}
		// 見直しの一覧（CLI の review）と、起動時の expire の対象探し。どちらも候補が 0 件の最悪の形（全件が本人確認済み）。
		const measureOther = async (fn: () => unknown) => {
			for (let i = 0; i < 2; i++) await fn();
			const samples: number[] = [];
			for (let i = 0; i < 10; i++) {
				const t = performance.now();
				await fn();
				samples.push(performance.now() - t);
			}
			return {
				p50: Number(percentile(samples, 50).toFixed(3)),
				p95: Number(percentile(samples, 95).toFixed(3)),
			};
		};
		const review = await measureOther(() =>
			host.dispatch(profile.credential, "review", { scopeKeys: SCOPES }),
		);
		const expire = await measureOther(() =>
			owner.port.read((db) => expiredItems(host, db)),
		);
		results.push({ items: n, search: timings, review, expire });
		console.error(`done ${n}`);
		await owner.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const json = arg("--json");
if (json) await Bun.write(json, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
