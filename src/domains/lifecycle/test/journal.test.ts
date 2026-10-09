import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../canonical/json.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { GENESIS_JOURNAL_HASH } from "../contracts/index.ts";
import type {
	ForgetJournalEntry,
	ForgetJournalTarget,
} from "../contracts/index.ts";
import {
	buildJournalEntry,
	canonicalizeTargets,
	computeEntryHash,
	computeForgetId,
	isSelfConsistent,
	verifyForgetJournal,
} from "../service/journal.ts";

const T1: ForgetJournalTarget = {
	type: "record",
	id: `rec:${"a".repeat(64)}`,
	scopeKey: "scope:a",
};
const T2: ForgetJournalTarget = {
	type: "scope",
	id: "scope:b",
	scopeKey: "scope:b",
};

function chain(count: number): ForgetJournalEntry[] {
	const entries: ForgetJournalEntry[] = [];
	let prevHash: string = GENESIS_JOURNAL_HASH;
	for (let index = 0; index < count; index += 1) {
		const entry = buildJournalEntry({
			seq: index + 1,
			prevHash,
			principal: "local:owner",
			targets: [index % 2 === 0 ? T1 : T2],
		});
		entries.push(entry);
		prevHash = entry.hash;
	}
	return entries;
}

describe("buildJournalEntry", () => {
	test("hash and forgetId follow the documented formulas", () => {
		const entry = buildJournalEntry({
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "p",
			targets: [T2, T1, T1],
		});
		expect(entry.targets).toEqual([T1, T2]);
		const targets = [T1, T2];
		expect(entry.forgetId).toBe(
			`forget:${sha256Hex(canonicalJson({ principal: "p", seq: 1, targets }))}`,
		);
		expect(entry.hash).toBe(
			sha256Hex(
				canonicalJson({
					journalFormat: 1,
					seq: 1,
					prevHash: GENESIS_JOURNAL_HASH,
					forgetId: entry.forgetId,
					principal: "p",
					targets,
				}),
			),
		);
		expect(isSelfConsistent(entry)).toBe(true);
	});

	test("targets are ordered by UTF-16 code units (type, scopeKey, id)", () => {
		const ordered = canonicalizeTargets([
			{ type: "scope", id: "s", scopeKey: "😀" },
			{ type: "scope", id: "s", scopeKey: "￿" },
			{ type: "record", id: "z", scopeKey: "b" },
			{ type: "record", id: "a", scopeKey: "b" },
		]);
		expect(ordered.map((t) => `${t.type}/${t.scopeKey}/${t.id}`)).toEqual([
			"record/b/a",
			"record/b/z",
			"scope/😀/s", // 高位サロゲート (D83D) は U+FFFF より前
			"scope/￿/s",
		]);
	});

	test("entries carry no body or digest of the forgotten data", () => {
		const entry = buildJournalEntry({
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "p",
			targets: [T1],
		});
		expect(Object.keys(entry).sort()).toEqual([
			"forgetId",
			"hash",
			"journalFormat",
			"prevHash",
			"principal",
			"seq",
			"targets",
		]);
	});
});

describe("verifyForgetJournal", () => {
	test("empty and valid chains", () => {
		expect(verifyForgetJournal([])).toEqual({ status: "ok", head: null });
		const entries = chain(3);
		expect(verifyForgetJournal(entries)).toEqual({
			status: "ok",
			head: { seq: 3, hash: entries[2]?.hash ?? "" },
		});
	});

	test("every kind of damage is CHAIN_BROKEN", () => {
		const entries = chain(3);
		const broken = {
			status: "inconsistent",
			reasonCode: "JOURNAL_CHAIN_BROKEN",
		} as const;
		const [a, b, c] = entries as [
			ForgetJournalEntry,
			ForgetJournalEntry,
			ForgetJournalEntry,
		];
		expect(verifyForgetJournal([b, c])).toEqual(broken); // 先頭欠落
		expect(verifyForgetJournal([a, c])).toEqual(broken); // 途中欠落
		expect(verifyForgetJournal([a, c, b])).toEqual(broken); // 入れ替え
		expect(verifyForgetJournal([a, a])).toEqual(broken); // 重複
		expect(verifyForgetJournal([{ ...a, hash: "0".repeat(64) }, b, c])).toEqual(
			broken,
		);
		expect(verifyForgetJournal([{ ...a, principal: "x" }, b, c])).toEqual(
			broken,
		);
		expect(verifyForgetJournal([{ ...a, seq: 2 }, b, c])).toEqual(broken);
		expect(
			verifyForgetJournal([a, { ...b, prevHash: GENESIS_JOURNAL_HASH }, c]),
		).toEqual(broken);
		expect(verifyForgetJournal([a, { ...b, targets: [T1] }, c])).toEqual(
			broken,
		);
		// 型違い・欠落でも例外にならない
		expect(verifyForgetJournal([{} as ForgetJournalEntry])).toEqual(broken);
		expect(
			verifyForgetJournal([null as unknown as ForgetJournalEntry]),
		).toEqual(broken);
		expect(
			verifyForgetJournal([
				{ ...a, targets: "x" } as unknown as ForgetJournalEntry,
			]),
		).toEqual(broken);
		// 整列されていない targets は不正
		const unsorted = { ...a, targets: [T2, T1] };
		expect(verifyForgetJournal([unsorted])).toEqual(broken);
	});

	test("flipping any single byte of any field is detected (mutation sweep)", () => {
		const entries = chain(2);
		for (const [index, entry] of entries.entries()) {
			for (const key of [
				"prevHash",
				"forgetId",
				"principal",
				"hash",
			] as const) {
				const value = entry[key];
				const mutated = `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
				const copy = entries.map((e, i) =>
					i === index ? { ...e, [key]: mutated } : e,
				);
				expect(verifyForgetJournal(copy).status).toBe("inconsistent");
			}
		}
	});
});

/**
 * hash と forgetId を再計算した「自己整合な」entry だけで組む。hash の不一致で弾かれる経路を通さず、
 * 鎖の連結検査（prevHash / seq / targets の整列・重複 / forgetId）そのものを守る。
 */
describe("verifyForgetJournal: self-consistent entries that do not form one chain", () => {
	const broken = {
		status: "inconsistent",
		reasonCode: "JOURNAL_CHAIN_BROKEN",
	} as const;
	const T3: ForgetJournalTarget = {
		type: "record",
		id: `rec:${"b".repeat(64)}`,
		scopeKey: "scope:a",
	};

	/** 任意の形の body から、hash を再計算して作る（buildJournalEntry の整列・重複除去を通さない）。 */
	function forge(
		fields: Omit<ForgetJournalEntry, "hash" | "forgetId"> & {
			readonly forgetId?: string;
		},
	): ForgetJournalEntry {
		const forgetId =
			fields.forgetId ??
			computeForgetId(fields.principal, fields.seq, fields.targets);
		const body = { ...fields, forgetId };
		return { ...body, hash: computeEntryHash(body) };
	}

	test("the building blocks produce valid single entries (control)", () => {
		const [a, b] = chain(2) as [ForgetJournalEntry, ForgetJournalEntry];
		expect(isSelfConsistent(a)).toBe(true);
		expect(isSelfConsistent(b)).toBe(true);
		expect(verifyForgetJournal([a, b]).status).toBe("ok");
	});

	test("a fork: the second entry is self-consistent but chains to genesis, not to the first", () => {
		const [a] = chain(1) as [ForgetJournalEntry];
		const forked = buildJournalEntry({
			seq: 2,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [T2],
		});
		expect(isSelfConsistent(forked)).toBe(true);
		expect(verifyForgetJournal([a, forked])).toEqual(broken);
	});

	test("splicing two chains: every entry is valid on its own, the join is not", () => {
		const left = chain(2);
		const right: ForgetJournalEntry[] = [];
		let prevHash: string = GENESIS_JOURNAL_HASH;
		for (let seq = 1; seq <= 3; seq += 1) {
			const entry = buildJournalEntry({
				seq,
				prevHash,
				principal: "local:other",
				targets: [T3],
			});
			right.push(entry);
			prevHash = entry.hash;
		}
		expect(verifyForgetJournal(left).status).toBe("ok");
		expect(verifyForgetJournal(right).status).toBe("ok");
		const spliced = [left[0], left[1], right[2]] as ForgetJournalEntry[];
		expect(spliced.every((entry) => isSelfConsistent(entry))).toBe(true);
		expect(verifyForgetJournal(spliced)).toEqual(broken);
		// 先頭だけ別系統
		expect(
			verifyForgetJournal([right[0], left[1]] as ForgetJournalEntry[]),
		).toEqual(broken);
	});

	test("a seq gap with the prevHash pointing at the real predecessor", () => {
		const [a] = chain(1) as [ForgetJournalEntry];
		const gap = buildJournalEntry({
			seq: 3,
			prevHash: a.hash,
			principal: "local:owner",
			targets: [T2],
		});
		expect(isSelfConsistent(gap)).toBe(true);
		expect(verifyForgetJournal([a, gap])).toEqual(broken);
		// 先頭が seq 2 / 同じ seq を繰り返す
		const startsAtTwo = buildJournalEntry({
			seq: 2,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [T1],
		});
		expect(verifyForgetJournal([startsAtTwo])).toEqual(broken);
		const repeated = buildJournalEntry({
			seq: 1,
			prevHash: a.hash,
			principal: "local:owner",
			targets: [T2],
		});
		expect(isSelfConsistent(repeated)).toBe(true);
		expect(verifyForgetJournal([a, repeated])).toEqual(broken);
	});

	test("the first entry must chain to the genesis hash", () => {
		const wrongStart = buildJournalEntry({
			seq: 1,
			prevHash: "f".repeat(64),
			principal: "local:owner",
			targets: [T1],
		});
		expect(isSelfConsistent(wrongStart)).toBe(true);
		expect(verifyForgetJournal([wrongStart])).toEqual(broken);
	});

	test("targets that are not sorted, or contain a duplicate, are rejected even with a recomputed hash", () => {
		const unsorted = forge({
			journalFormat: 1,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [T2, T1],
		});
		const duplicated = forge({
			journalFormat: 1,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [T1, T1],
		});
		const sortedControl = forge({
			journalFormat: 1,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [T1, T2],
		});
		expect(isSelfConsistent(sortedControl)).toBe(true);
		expect(isSelfConsistent(unsorted)).toBe(false);
		expect(isSelfConsistent(duplicated)).toBe(false);
		expect(verifyForgetJournal([unsorted])).toEqual(broken);
		expect(verifyForgetJournal([duplicated])).toEqual(broken);
		// 後続の entry だけが非整列でも鎖は壊れていると判定する
		const [a] = chain(1) as [ForgetJournalEntry];
		const second = forge({
			journalFormat: 1,
			seq: 2,
			prevHash: a.hash,
			principal: "local:owner",
			targets: [T2, T1],
		});
		expect(verifyForgetJournal([a, second])).toEqual(broken);
	});

	test("a forgetId that does not match its (principal, seq, targets) is rejected even with a recomputed hash", () => {
		const forgedId = forge({
			journalFormat: 1,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [T1],
			forgetId: `forget:${"3".repeat(64)}`,
		});
		const otherPrincipalId = forge({
			journalFormat: 1,
			seq: 1,
			prevHash: GENESIS_JOURNAL_HASH,
			principal: "local:owner",
			targets: [T1],
			forgetId: computeForgetId("local:someone-else", 1, [T1]),
		});
		expect(isSelfConsistent(forgedId)).toBe(false);
		expect(isSelfConsistent(otherPrincipalId)).toBe(false);
		expect(verifyForgetJournal([forgedId])).toEqual(broken);
		expect(verifyForgetJournal([otherPrincipalId])).toEqual(broken);
	});
});
