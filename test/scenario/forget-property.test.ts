/**
 * FG10（property）: ランダムな依存グラフ・ランダムな forget 順で、閉包の不変条件を検査する。
 * 固定 seed の決定的 PRNG（mulberry32）。oracle は実装とは別の素朴な BFS（`expectedForgotten`）。
 *
 * 各ケースで確認すること:
 * - 閉包外の行は forget の前後で一切変わらない。
 * - 閉包内の行は値（SECRET-…）がどの memory_ 表にも残らず、read / list / snapshot / 変更フィードに値が出ない。
 * - 依存辺の dependency が忘却済みなら dependent も忘却済み（forgotten でない行の依存に forgotten 行がない）。
 * - 再適用（applyForget の再実行、reconcile の再実行）は冪等。
 * - 忘却前に複製した DB + 最新ジャーナルで reconcile しても同じ結果で、値は戻らない。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	applyForget,
	listCandidates,
	listMemoryChanges,
	listState,
	readMemorySnapshotPart,
	searchRecords,
} from "eumenes-memory/sqlite";
import type { ForgetJournalEntry } from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";
import {
	forgetRecord,
	reconcile,
	tablesContain,
} from "../runners/records-support.ts";
import {
	ACCESS,
	OTHER_SCOPE,
	SCOPE,
	buildGraph,
	closureViolations,
	derivedRowsById,
	expectedForgotten,
	messageKey,
	progressRun,
	toForgetTarget,
	prng,
	tombstoneSet,
} from "../runners/forget-support.ts";
import type {
	BuiltGraph,
	Expected,
	ForgetTargetSpec,
	GraphSpec,
	ItemSpec,
	CandidateSpec,
	RunSpec,
	ExternalSpec,
} from "../runners/forget-support.ts";

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function pickOne<T>(rand: () => number, list: readonly T[]): T {
	return list[Math.floor(rand() * list.length)] as T;
}
function between(rand: () => number, lo: number, hi: number): number {
	return lo + Math.floor(rand() * (hi - lo + 1));
}
function subset<T>(rand: () => number, list: readonly T[], max: number): T[] {
	const pool = [...list];
	const out: T[] = [];
	const count = Math.min(pool.length, between(rand, 0, max));
	for (let i = 0; i < count; i += 1) {
		out.push(...pool.splice(Math.floor(rand() * pool.length), 1));
	}
	return out;
}

/** ランダムな依存グラフ（run → candidate → item、user item、shown、external、progress、2 scope）。 */
export function randomSpec(seed: number): GraphSpec {
	const rand = prng(seed);
	const messages = Array.from(
		{ length: between(rand, 3, 6) },
		(_, i) => `m:s${i}`,
	);
	const records = Array.from(
		{ length: between(rand, 0, 2) },
		(_, i) => `rec${i}`,
	);
	const sources = [...messages, ...records.map((name) => `r:${name}`)];
	const items: ItemSpec[] = [];
	const candidates: CandidateSpec[] = [];
	const runs: RunSpec[] = [];
	const externals: ExternalSpec[] = [];
	const itemScope = new Map<string, string>();
	for (let k = 0; k < between(rand, 1, 4); k += 1) {
		const scope = rand() < 0.75 ? SCOPE : OTHER_SCOPE;
		const shownPool = items
			.filter((item) => itemScope.get(item.id) === scope)
			.map((item) => item.id);
		runs.push({
			id: `run${k}`,
			scope,
			inputs: subset(rand, sources, 3)
				.concat(pickOne(rand, sources))
				.filter((v, i, a) => a.indexOf(v) === i),
			shown: subset(rand, shownPool, 2),
			...(rand() < 0.7 ? { provider: pickOne(rand, ["larm", "stub"]) } : {}),
			stage: rand() < 0.2 ? "prepared" : "settled",
		});
		for (let c = 0; c < between(rand, 0, 3); c += 1) {
			const id = `c${k}_${c}`;
			const evidence = subset(rand, sources, 2)
				.concat(pickOne(rand, sources))
				.filter((v, i, a) => a.indexOf(v) === i);
			candidates.push({ id, scope, run: `run${k}`, evidence });
			if (rand() < 0.6) {
				const itemId = `i${k}_${c}`;
				items.push({ id: itemId, scope, evidence, fromCandidate: id });
				itemScope.set(itemId, scope);
			}
		}
	}
	for (let u = 0; u < between(rand, 0, 3); u += 1) {
		const scope = rand() < 0.75 ? SCOPE : OTHER_SCOPE;
		const itemId = `u${u}`;
		items.push({ id: itemId, scope, evidence: [pickOne(rand, sources)] });
		itemScope.set(itemId, scope);
	}
	for (let e = 0; e < between(rand, 0, 3); e += 1) {
		const scope = rand() < 0.75 ? SCOPE : OTHER_SCOPE;
		const sameScopeItems = items.filter(
			(item) => itemScope.get(item.id) === scope,
		);
		const dependsOn = [
			...subset(rand, sources, 1),
			...subset(
				rand,
				sameScopeItems.map((item) => `i:${item.id}`),
				2,
			),
		];
		if (dependsOn.length === 0) dependsOn.push(pickOne(rand, sources));
		externals.push({
			id: `${pickOne(rand, ["world", "cons"])}:n${e}`,
			scope,
			dependsOn,
		});
	}
	return {
		records,
		items,
		candidates,
		runs,
		externals,
		progress: subset(rand, sources, 3),
	};
}

function randomTargets(
	rand: () => number,
	spec: GraphSpec,
): ForgetTargetSpec[] {
	const out: ForgetTargetSpec[] = [];
	const messages = [...new Set((spec.runs ?? []).flatMap((run) => run.inputs))];
	for (let k = 0; k < between(rand, 1, 3); k += 1) {
		const roll = rand();
		if (roll < 0.35 && messages.length > 0) {
			out.push({ type: "host_source", source: pickOne(rand, messages) });
		} else if (roll < 0.5 && (spec.records ?? []).length > 0) {
			out.push({ type: "record", name: pickOne(rand, spec.records ?? []) });
		} else if (roll < 0.8 && (spec.items ?? []).length > 0) {
			out.push({ type: "state_item", id: pickOne(rand, spec.items ?? []).id });
		} else if (roll < 0.9) {
			out.push({ type: "scope", scope: rand() < 0.5 ? SCOPE : OTHER_SCOPE });
		} else if (messages.length > 0) {
			out.push({ type: "host_source", source: pickOne(rand, messages) });
		}
	}
	return out;
}

/** 辺の scope が行の scope と一致する（グラフは run/candidate/item の scope を揃えて作る）ことを前提に、scope を動かす対象を求める。 */
function dumpExceptScopeState(store: TestStore): string {
	const tables = store.writer
		.query(
			`SELECT name FROM sqlite_master
			WHERE type = 'table' AND name LIKE 'memory\\_%' ESCAPE '\\'
				AND name NOT LIKE 'memory\\_record\\_fts%' ESCAPE '\\'
				AND name NOT IN ('memory_seq', 'memory_scope_state')
			ORDER BY name`,
		)
		.all() as { name: string }[];
	const out: Record<string, unknown[]> = {};
	for (const { name } of tables) {
		out[name] = store.writer.query(`SELECT * FROM ${name} ORDER BY 1, 2`).all();
	}
	return JSON.stringify(out);
}

function idsOf(graph: BuiltGraph, expected: Expected) {
	const spec = graph.spec;
	return {
		items: new Set((spec.items ?? []).map((item) => item.id)),
		forgottenItems: expected.state_item,
		forgottenCandidates: expected.candidate,
		forgottenRuns: expected.extraction_run,
		spec,
	};
}

/** 生成したケースが自明でないことの確認用の集計。 */
const stats = {
	cases: 0,
	forgottenItems: 0,
	keptItems: 0,
	forgottenCandidates: 0,
	forgottenRuns: 0,
	forgottenExternals: 0,
	keptExternals: 0,
	targets: { host_source: 0, record: 0, state_item: 0, scope: 0 },
};

function checkCase(seed: number, withRestore: boolean): void {
	const rand = prng(seed * 7919 + 13);
	const spec = randomSpec(seed);
	const store = openTestStore(withRestore ? {} : { inMemory: true });
	stores.push(store);
	const graph = buildGraph(store, spec);
	const targets = randomTargets(rand, spec);
	const where = `seed ${seed} targets ${JSON.stringify(targets)}`;

	const before = derivedRowsById(store);
	const oldDb = withRestore ? store.snapshotTo("before") : null;
	const journal: ForgetJournalEntry[] = [];
	for (const target of targets) {
		const { entry } = forgetRecord(
			store,
			toForgetTarget(graph, target) as never,
		);
		journal.push(entry);
	}
	const expected = expectedForgotten(graph, targets);
	stats.cases += 1;
	stats.forgottenItems += expected.state_item.size;
	stats.keptItems += (spec.items ?? []).length - expected.state_item.size;
	stats.forgottenCandidates += expected.candidate.size;
	stats.forgottenRuns += expected.extraction_run.size;
	stats.forgottenExternals += expected.external.size;
	stats.keptExternals += (spec.externals ?? []).length - expected.external.size;
	for (const target of targets) stats.targets[target.type] += 1;
	const sceneForgot = idsOf(graph, expected);

	// 1. 墓標の集合が oracle と一致（取りこぼしも余分もない）。
	expect({ where, ids: [...tombstoneSet(store, "state_item")].sort() }).toEqual(
		{
			where,
			ids: [...expected.state_item].sort(),
		},
	);
	expect({ where, ids: [...tombstoneSet(store, "candidate")].sort() }).toEqual({
		where,
		ids: [...expected.candidate].sort(),
	});
	expect({
		where,
		ids: [...tombstoneSet(store, "extraction_run")].sort(),
	}).toEqual({
		where,
		ids: [...expected.extraction_run].sort(),
	});
	expect({ where, ids: [...tombstoneSet(store, "external")].sort() }).toEqual({
		where,
		ids: [...expected.external].sort(),
	});
	expect({ where, ids: [...tombstoneSet(store, "source")].sort() }).toEqual({
		where,
		ids: [...expected.sources].sort(),
	});
	expect({ where, ids: [...tombstoneSet(store, "record")].sort() }).toEqual({
		where,
		ids: [...expected.records]
			.map((name) => graph.recordIds.get(name) as string)
			.sort(),
	});

	// 2. 閉包外の行は不変（付随表を含む）。進捗行は忘れた出典・忘れた run・scope forget の分だけ消える。
	const after = derivedRowsById(store);
	const scopeForgotten = new Set(
		targets
			.filter((t) => t.type === "scope")
			.map((t) => (t as { scope: string }).scope),
	);
	const insideKey = (key: string): boolean => {
		const [kind, id] = [
			key.slice(0, key.indexOf("|")),
			key.slice(key.indexOf("|") + 1),
		];
		if (kind.startsWith("state_item")) return expected.state_item.has(id);
		if (kind.startsWith("candidate")) return expected.candidate.has(id);
		if (kind === "extraction_run" || kind.startsWith("run.")) {
			return expected.extraction_run.has(id);
		}
		return false;
	};
	for (const [key, row] of before) {
		if (key.startsWith("progress|")) {
			const sourceKey = key.slice("progress|".length);
			const ref = (spec.progress ?? []).find(
				(r) => graph.sourceKeyOf(r) === sourceKey,
			);
			const gone =
				expected.sources.has(sourceKey) ||
				(ref !== undefined &&
					expected.extraction_run.has(progressRun(spec, ref))) ||
				scopeForgotten.has(SCOPE);
			if (gone)
				expect({ where, key, present: after.has(key) }).toEqual({
					where,
					key,
					present: false,
				});
			else
				expect({ where, key, row: after.get(key) }).toEqual({
					where,
					key,
					row,
				});
			continue;
		}
		if (!insideKey(key)) {
			expect({ where, key, row: after.get(key) }).toEqual({ where, key, row });
		}
	}

	// 3. 閉包内: 値が残らない（全 memory_ 表）、閉包外: 値が残る。
	for (const [id, secrets] of graph.secrets) {
		const inside = id.startsWith("i:")
			? expected.state_item.has(id.slice(2))
			: id.startsWith("c:")
				? expected.candidate.has(id.slice(2))
				: expected.records.has(id.slice(2));
		for (const secret of secrets) {
			expect({
				where,
				id,
				secret,
				found: tablesContain(store, secret),
			}).toEqual({
				where,
				id,
				secret,
				found: !inside,
			});
		}
	}

	// 4. 依存辺の不変条件。
	expect({ where, violations: closureViolations(store) }).toEqual({
		where,
		violations: [],
	});

	// 5. 読み出し・一覧・snapshot・変更フィードに忘れた値が出ない。
	for (const scopeKey of [SCOPE, OTHER_SCOPE]) {
		const listed = store.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey,
				includeInactive: true,
			}),
		);
		if (listed.status !== "ok") throw new Error("listState blocked");
		for (const item of listed.items) {
			expect({ where, leaked: expected.state_item.has(item.itemId) }).toEqual({
				where,
				leaked: false,
			});
		}
		const pending = store.read((db) =>
			listCandidates(db, { contractVersion: 1, access: ACCESS, scopeKey }),
		);
		if (pending.status !== "ok") throw new Error("listCandidates blocked");
		expect(JSON.stringify(pending)).not.toContain("SECRET-cand-" + "\u0000");
		for (const candidate of pending.candidates) {
			expect(expected.candidate.has(candidate.candidateId)).toBe(false);
		}
		const part = store.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey,
			}),
		);
		if (part.status !== "ok") throw new Error("snapshot blocked");
		for (const item of part.items) {
			expect(expected.state_item.has(item.id)).toBe(false);
		}
	}
	const hits = store.read((db) =>
		searchRecords(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKeys: [SCOPE],
			query: "SECRET-rec",
			limit: 50,
		}),
	);
	if (hits.status !== "ok") throw new Error("search blocked");
	for (const hit of hits.hits) {
		const forgottenIds = [...expected.records].map((name) =>
			graph.recordIds.get(name),
		);
		expect(forgottenIds.includes(hit.ref.id)).toBe(false);
	}
	const feed = store.read((db) =>
		listMemoryChanges(db, {
			contractVersion: 1,
			access: ACCESS,
			scopeKeys: [SCOPE, OTHER_SCOPE],
			afterSeq: 0,
			limit: 500,
		}),
	);
	if (feed.status !== "ok") throw new Error("feed blocked");
	expect(JSON.stringify(feed)).not.toContain("SECRET");
	const forgottenInFeed = new Set(
		feed.changes
			.filter((c) => c.targetType === "state_item" && c.status === "forgotten")
			.map((c) => c.targetId),
	);
	for (const id of expected.state_item) {
		const exists = sceneForgot.items.has(id);
		expect({ where, id, inFeed: !exists || forgottenInFeed.has(id) }).toEqual({
			where,
			id,
			inFeed: true,
		});
	}

	// 6. 冪等: 各 entry の再適用、reconcile の再実行で DB は変わらない（scope revision は再適用ごとに進む）。
	const dump = dumpExceptScopeState(store);
	for (const entry of journal) {
		store.write((db) =>
			applyForget(db, { contractVersion: 1, entry, clock: { atMs: 500 } }),
		);
	}
	expect(dumpExceptScopeState(store) === dump).toBe(true);
	expect(reconcile(store, journal)).toEqual({ status: "ok", reapplied: 0 });
	expect(dumpExceptScopeState(store) === dump).toBe(true);

	// 7. 復元（古い DB + 最新ジャーナル）でも戻らない。
	if (oldDb !== null) {
		const restored = openTestStore({ fromFile: oldDb });
		stores.push(restored);
		expect(reconcile(restored, journal)).toEqual({
			status: "ok",
			reapplied: journal.length,
			...(journal.length > 0 ? { feedResyncRequired: true } : {}),
		});
		for (const type of [
			"state_item",
			"candidate",
			"extraction_run",
			"external",
			"source",
			"record",
		]) {
			expect({
				where,
				type,
				ids: [...tombstoneSet(restored, type)].sort(),
			}).toEqual({
				where,
				type,
				ids: [...tombstoneSet(store, type)].sort(),
			});
		}
		for (const [id, list] of graph.secrets) {
			const inside = id.startsWith("i:")
				? expected.state_item.has(id.slice(2))
				: id.startsWith("c:")
					? expected.candidate.has(id.slice(2))
					: expected.records.has(id.slice(2));
			for (const secret of list) {
				expect(tablesContain(restored, secret)).toBe(!inside);
			}
		}
		expect(closureViolations(restored)).toEqual([]);
		const restoredRows = derivedRowsById(restored);
		for (const [key, row] of before) {
			if (!insideKey(key) && !key.startsWith("progress|")) {
				expect({ where, key, row: restoredRows.get(key) }).toEqual({
					where,
					key,
					row,
				});
			}
		}
		const restoredDump = dumpExceptScopeState(restored);
		expect(reconcile(restored, journal)).toEqual({
			status: "ok",
			reapplied: 0,
		});
		expect(dumpExceptScopeState(restored) === restoredDump).toBe(true);
	}
	void messageKey;
}

describe("FG10: closure invariants over random dependency graphs (fixed seeds)", () => {
	test("in-memory DB, 150 seeds", () => {
		for (let seed = 1; seed <= 150; seed += 1) checkCase(seed, false);
	});
	test("file DB with a pre-forget copy restored and reconciled, 40 seeds", () => {
		for (let seed = 1001; seed <= 1040; seed += 1) checkCase(seed, true);
	});

	test("the generated cases are not trivial (both forgotten and kept rows, every target type)", () => {
		expect(stats.cases).toBe(190);
		expect(stats.forgottenItems).toBeGreaterThan(100);
		expect(stats.keptItems).toBeGreaterThan(100);
		expect(stats.forgottenCandidates).toBeGreaterThan(100);
		expect(stats.forgottenRuns).toBeGreaterThan(80);
		expect(stats.forgottenExternals).toBeGreaterThan(30);
		expect(stats.keptExternals).toBeGreaterThan(30);
		for (const count of Object.values(stats.targets)) {
			expect(count).toBeGreaterThan(20);
		}
	});
});
