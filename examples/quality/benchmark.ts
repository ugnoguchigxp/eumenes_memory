/** Fixed local SQLite/WAL workload; stress results are kept separate from the operating envelope. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openTestStore } from "../../test/support/store.ts";
import {
	assertInput,
	ACCESS,
	SCOPE,
	COFFEE,
} from "../../src/domains/state/testing.ts";
import {
	assertUserState,
	listState,
	planForget,
	applyForget,
} from "eumenes-memory/sqlite";
import { sourceKey } from "../../src/contracts/source-key.ts";
import { sourceHash } from "../../scripts/verify.ts";
const root = resolve(import.meta.dir, "../.."),
	out = join(root, "verification-reports/quality-80");
mkdirSync(out, { recursive: true });
const quantile = (a: number[], q: number) =>
	[...a].sort((x, y) => x - y)[Math.ceil(a.length * q) - 1]!;
const results = [];
for (const size of [100, 1000, 10000]) {
	const store = openTestStore();
	try {
		const start = performance.now();
		store.write((db) => {
			for (let i = 0; i < size; i++) {
				const r = assertUserState(
					db,
					assertInput({ semanticKey: `benchmark-${i}` }),
				);
				if (r.status !== "applied") throw Error("seed failed");
			}
		});
		const seedMs = performance.now() - start;
		const read = () =>
			store.read((db) => {
				let after: { updatedSeq: number; itemId: string } | undefined;
				let count = 0;
				do {
					const page = listState(db, {
						contractVersion: 1,
						access: ACCESS,
						scopeKey: SCOPE,
						...(after ? { after } : {}),
						limit: 1000,
					});
					if (page.status !== "ok") throw Error("read blocked");
					count += page.items.length;
					after = page.nextCursor;
				} while (after);
				if (count !== size) throw Error("pagination omitted data");
			});
		const firstStart = performance.now();
		read();
		const firstReadMs = performance.now() - firstStart;
		const times = [];
		for (let trial = 0; trial < 30; trial++) {
			const t = performance.now();
			read();
			times.push(performance.now() - t);
		}
		const snapshot = store.snapshotTo("pre-forget");
		const erasures = [];
		// All items share one host source: a real fanout closure, with restore before every sample.
		for (let trial = 0; trial < (size === 1000 ? 30 : 3); trial++) {
			const restored = openTestStore({ fromFile: snapshot });
			try {
				const t = performance.now();
				const p = restored.read((db) =>
					planForget(db, {
						contractVersion: 1,
						access: ACCESS,
						target: {
							type: "host_source",
							sourceKey: sourceKey(COFFEE),
							scopeKey: SCOPE,
						},
						clock: { atMs: 2000 },
					}),
				);
				if (p.status !== "planned") throw Error("plan failed");
				restored.write((db) =>
					applyForget(db, {
						contractVersion: 1,
						entry: p.plan.entry,
						clock: { atMs: 2000 },
					}),
				);
				erasures.push(performance.now() - t);
				const page = restored.read((db) =>
					listState(db, {
						contractVersion: 1,
						access: ACCESS,
						scopeKey: SCOPE,
					}),
				);
				if (page.status !== "ok" || page.items.length !== 0)
					throw Error("closure incomplete");
			} finally {
				restored.close();
			}
		}
		const plans = store.read((db) =>
			db
				.query(
					"EXPLAIN QUERY PLAN SELECT item_id FROM memory_state_item WHERE principal=? AND scope_key=? AND status='active' ORDER BY updated_seq DESC,item_id DESC LIMIT 1000",
				)
				.all(ACCESS.principal, SCOPE),
		);
		results.push({
			size,
			role: size === 10000 ? "stress" : "operating",
			seedMs,
			firstReadMs,
			warmRead: {
				samples: times.length,
				p50Ms: quantile(times, 0.5),
				p95Ms: quantile(times, 0.95),
			},
			sourceFanoutForget: {
				samples: erasures.length,
				p50Ms: quantile(erasures, 0.5),
				p95Ms: quantile(erasures, 0.95),
			},
			queryPlan: plans,
		});
	} finally {
		store.close();
	}
}
const operating = results.filter((x) => x.role === "operating");
const report = {
	sourceHash: sourceHash(root),
	runtime: Bun.version,
	platform: process.platform,
	architecture: process.arch,
	clock: "performance.now",
	firstReadIsNotOsColdCache: true,
	results,
	peakRssBytes: process.resourceUsage().maxRSS * 1024,
	budgets: { readP95Ms: 100, forgetP95Ms: 200, rssBytes: 512 * 1024 * 1024 },
	passed:
		operating.every(
			(x) => x.warmRead.p95Ms <= 100 && x.sourceFanoutForget.p95Ms <= 200,
		) && process.resourceUsage().maxRSS * 1024 <= 512 * 1024 * 1024,
};
writeFileSync(join(out, "performance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
