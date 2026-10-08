/**
 * 墓標ジャーナル entry の生成・検査・鎖検証（純粋）。契約は `src/contracts/lifecycle.ts` の JSDoc。
 *
 *   hash     = sha256Hex(canonicalJson({ journalFormat, seq, prevHash, forgetId, principal, targets }))
 *   forgetId = "forget:" + sha256Hex(canonicalJson({ principal, seq, targets }))
 *
 * `targets` は (type, scopeKey, id) の UTF-16 コード単位順に整列し重複を除く。entry は本文・digest を含まない。
 */
import { canonicalJson } from "../canonical/json.ts";
import { compareCodeUnits } from "../canonical/compare.ts";
import { sha256Hex } from "../canonical/sha256.ts";
import {
	FORGET_TARGET_TYPES,
	GENESIS_JOURNAL_HASH,
	JOURNAL_FORMAT,
	LIMITS_LIFECYCLE,
} from "../contracts/lifecycle.ts";
import type {
	ForgetJournalEntry,
	ForgetJournalTarget,
	VerifyForgetJournalResult,
} from "../contracts/lifecycle.ts";

function compareTargets(
	a: ForgetJournalTarget,
	b: ForgetJournalTarget,
): number {
	return (
		compareCodeUnits(a.type, b.type) ||
		compareCodeUnits(a.scopeKey, b.scopeKey) ||
		compareCodeUnits(a.id, b.id)
	);
}

/** (type, scopeKey, id) の順に整列し、重複を除く。 */
export function canonicalizeTargets(
	targets: readonly ForgetJournalTarget[],
): readonly ForgetJournalTarget[] {
	const sorted = [...targets]
		.map((t) => ({ type: t.type, id: t.id, scopeKey: t.scopeKey }))
		.sort(compareTargets);
	return sorted.filter(
		(target, index) =>
			index === 0 ||
			compareTargets(sorted[index - 1] as ForgetJournalTarget, target) !== 0,
	);
}

export function computeForgetId(
	principal: string,
	seq: number,
	targets: readonly ForgetJournalTarget[],
): string {
	return `forget:${sha256Hex(canonicalJson({ principal, seq, targets }))}`;
}

export function computeEntryHash(
	entry: Omit<ForgetJournalEntry, "hash">,
): string {
	return sha256Hex(
		canonicalJson({
			journalFormat: entry.journalFormat,
			seq: entry.seq,
			prevHash: entry.prevHash,
			forgetId: entry.forgetId,
			principal: entry.principal,
			targets: entry.targets,
		}),
	);
}

/** DB の head の次に載る entry を作る。targets は整列・重複除去される。 */
export function buildJournalEntry(args: {
	readonly seq: number;
	readonly prevHash: string;
	readonly principal: string;
	readonly targets: readonly ForgetJournalTarget[];
}): ForgetJournalEntry {
	const targets = canonicalizeTargets(args.targets);
	const body = {
		journalFormat: JOURNAL_FORMAT,
		seq: args.seq,
		prevHash: args.prevHash,
		forgetId: computeForgetId(args.principal, args.seq, targets),
		principal: args.principal,
		targets,
	};
	return { ...body, hash: computeEntryHash(body) };
}

function isHex64(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * entry 単体の整合: 形、整列済み・重複なしの targets、forgetId と hash の再計算が一致すること。
 * 壊れた入力（欠けたキー、型違い）でも例外を投げず false を返す。
 */
export function isSelfConsistent(entry: unknown): entry is ForgetJournalEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	if (e["journalFormat"] !== JOURNAL_FORMAT) return false;
	const seq = e["seq"];
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
		return false;
	}
	if (!isHex64(e["prevHash"]) || !isHex64(e["hash"])) return false;
	if (!isNonEmptyString(e["principal"]) || !isNonEmptyString(e["forgetId"])) {
		return false;
	}
	const targets = e["targets"];
	if (
		!Array.isArray(targets) ||
		targets.length === 0 ||
		targets.length > LIMITS_LIFECYCLE.maxJournalTargets
	) {
		return false;
	}
	const typed: ForgetJournalTarget[] = [];
	for (const target of targets as unknown[]) {
		if (typeof target !== "object" || target === null) return false;
		const t = target as Record<string, unknown>;
		if (
			typeof t["type"] !== "string" ||
			!(FORGET_TARGET_TYPES as readonly string[]).includes(t["type"]) ||
			!isNonEmptyString(t["id"]) ||
			!isNonEmptyString(t["scopeKey"])
		) {
			return false;
		}
		typed.push({
			type: t["type"] as ForgetJournalTarget["type"],
			id: t["id"],
			scopeKey: t["scopeKey"],
		});
	}
	if (JSON.stringify(canonicalizeTargets(typed)) !== JSON.stringify(typed)) {
		return false;
	}
	const body = {
		journalFormat: JOURNAL_FORMAT,
		seq,
		prevHash: e["prevHash"],
		forgetId: e["forgetId"],
		principal: e["principal"],
		targets: typed,
	} as const;
	return (
		e["forgetId"] === computeForgetId(body.principal, seq, typed) &&
		e["hash"] === computeEntryHash(body)
	);
}

/**
 * ジャーナル全体の鎖検証（環境依存なし）。seq は 1 始まりで連続、先頭の prevHash は `GENESIS_JOURNAL_HASH`、
 * 各 entry は自己整合で `prevHash` が直前の `hash` と一致すること。切り詰め・欠落（DB との比較が要る）は
 * `reconcileForgetJournal` だけが検出する。空のジャーナルは `ok`（head は null）。
 */
export function verifyForgetJournal(
	entries: readonly ForgetJournalEntry[],
): VerifyForgetJournalResult {
	let prevHash: string = GENESIS_JOURNAL_HASH;
	let head: { readonly seq: number; readonly hash: string } | null = null;
	for (const [index, entry] of entries.entries()) {
		if (!isSelfConsistent(entry)) return broken();
		if (entry.seq !== index + 1 || entry.prevHash !== prevHash) return broken();
		prevHash = entry.hash;
		head = { seq: entry.seq, hash: entry.hash };
	}
	return { status: "ok", head };
}

function broken(): VerifyForgetJournalResult {
	return { status: "inconsistent", reasonCode: "JOURNAL_CHAIN_BROKEN" };
}
