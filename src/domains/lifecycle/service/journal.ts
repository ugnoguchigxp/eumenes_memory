/**
 * 墓標ジャーナル entry の生成・検査・鎖検証（純粋）。契約は `src/domains/lifecycle/contracts/index.ts` の JSDoc。
 *
 *   format 1: hash = sha256Hex(canonicalJson({ journalFormat, seq, prevHash, forgetId, principal, targets }))
 *   format 2: hash = sha256Hex(canonicalJson({ journalFormat, seq, prevHash, forgetId, principal, targets, hostIntent? }))
 *   forgetId = "forget:" + sha256Hex(canonicalJson({ principal, seq, targets }))
 *
 * `targets` は (type, scopeKey, id) の UTF-16 コード単位順に整列し重複を除く。entry は本文・digest を含まない。
 * `hostIntent` の各配列は UTF-16 コード単位順に整列し重複を除き、空の配列のキーは除く。
 */
import { canonicalJson } from "../../../canonical/json.ts";
import { compareCodeUnits } from "../../../canonical/compare.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { isWellFormedUtf16, utf8ByteLength } from "../../../canonical/utf8.ts";
import { hasControlChars } from "../../../contracts/reader.ts";
import {
	FORGET_TARGET_TYPES,
	GENESIS_JOURNAL_HASH,
	JOURNAL_FORMAT,
	JOURNAL_FORMAT_HOST_INTENT,
	LIMITS_LIFECYCLE,
} from "../contracts/index.ts";
import type {
	ForgetJournalEntry,
	ForgetJournalTarget,
	HostForgetIntent,
	JournalFormat,
	VerifyForgetJournalResult,
} from "../contracts/index.ts";

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

/**
 * 各配列を整列・重複除去し、空の配列のキーを除く。キーが残らなければ null。
 * `__proto__` などのキーでも own プロパティになるよう、null-prototype のオブジェクトを返す。
 */
export function canonicalizeHostIntent(
	intent: HostForgetIntent,
): HostForgetIntent | null {
	const result: Record<string, readonly string[]> = Object.create(null);
	let kept = 0;
	for (const key of Object.keys(intent).sort(compareCodeUnits)) {
		const ids = [...new Set(intent[key] ?? [])].sort(compareCodeUnits);
		if (ids.length === 0) continue;
		result[key] = ids;
		kept += 1;
	}
	return kept === 0 ? null : result;
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
	const body: Record<string, unknown> = {
		journalFormat: entry.journalFormat,
		seq: entry.seq,
		prevHash: entry.prevHash,
		forgetId: entry.forgetId,
		principal: entry.principal,
		targets: entry.targets,
	};
	if (
		entry.journalFormat === JOURNAL_FORMAT_HOST_INTENT &&
		entry.hostIntent !== undefined
	) {
		body["hostIntent"] = entry.hostIntent;
	}
	return sha256Hex(canonicalJson(body));
}

/**
 * DB の head の次に載る entry を作る。targets は整列・重複除去、hostIntent は正規化される。
 * format 1 では hostIntent を渡せない（渡されたら TypeError。parse 済みの入力からは起きない）。
 */
export function buildJournalEntry(args: {
	/** 省略時は format 1。 */
	readonly journalFormat?: JournalFormat;
	readonly seq: number;
	readonly prevHash: string;
	readonly principal: string;
	readonly targets: readonly ForgetJournalTarget[];
	readonly hostIntent?: HostForgetIntent | null;
}): ForgetJournalEntry {
	const targets = canonicalizeTargets(args.targets);
	const hostIntent =
		args.hostIntent === undefined || args.hostIntent === null
			? null
			: canonicalizeHostIntent(args.hostIntent);
	const journalFormat = args.journalFormat ?? JOURNAL_FORMAT;
	if (journalFormat === JOURNAL_FORMAT && hostIntent !== null) {
		throw new TypeError("buildJournalEntry: hostIntent needs format 2");
	}
	const body = {
		journalFormat,
		seq: args.seq,
		prevHash: args.prevHash,
		forgetId: computeForgetId(args.principal, args.seq, targets),
		principal: args.principal,
		targets,
		...(hostIntent !== null ? { hostIntent } : {}),
	};
	return { ...body, hash: computeEntryHash(body) };
}

function isHex64(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** 非空・上限 bytes 以下・制御文字なし・lone surrogate なし。 */
function isBoundedIdentifier(
	value: unknown,
	maxBytes: number,
): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxBytes &&
		utf8ByteLength(value) <= maxBytes &&
		isWellFormedUtf16(value) &&
		!hasControlChars(value)
	);
}

const FORMAT_1_KEYS = Object.freeze([
	"journalFormat",
	"seq",
	"prevHash",
	"forgetId",
	"principal",
	"targets",
	"hash",
]);
const FORMAT_2_KEYS = Object.freeze([...FORMAT_1_KEYS, "hostIntent"]);

/**
 * 正規化済みの hostIntent か（plain object、キー 1〜上限、各配列は非空で狭義の昇順、ID の総数が上限以下）。
 * 正規化済みなら null-prototype の型付きコピーを返し、違えば null。
 */
function readCanonicalHostIntent(value: unknown): HostForgetIntent | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return null;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 0 || keys.length > LIMITS_LIFECYCLE.maxHostIntentKeys) {
		return null;
	}
	const copy: Record<string, readonly string[]> = Object.create(null);
	let total = 0;
	for (const key of keys) {
		if (!isBoundedIdentifier(key, LIMITS_LIFECYCLE.maxHostIntentKeyBytes)) {
			return null;
		}
		const ids = record[key];
		if (!Array.isArray(ids) || ids.length === 0) return null;
		total += ids.length;
		if (total > LIMITS_LIFECYCLE.maxHostIntentIds) return null;
		const typed: string[] = [];
		for (const id of ids as unknown[]) {
			if (!isBoundedIdentifier(id, LIMITS_LIFECYCLE.maxHostIntentIdBytes)) {
				return null;
			}
			const previous = typed[typed.length - 1];
			if (previous !== undefined && compareCodeUnits(previous, id) >= 0) {
				return null;
			}
			typed.push(id);
		}
		copy[key] = typed;
	}
	return copy;
}

/**
 * entry 単体の整合: 形（未知のキーなし）、整列済み・重複なしの targets、format 2 では正規化済みの hostIntent、
 * forgetId と hash の再計算が一致すること。壊れた入力（欠けたキー、型違い）でも例外を投げず false を返す。
 */
export function isSelfConsistent(entry: unknown): entry is ForgetJournalEntry {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return false;
	}
	const e = entry as Record<string, unknown>;
	const journalFormat = e["journalFormat"];
	if (
		journalFormat !== JOURNAL_FORMAT &&
		journalFormat !== JOURNAL_FORMAT_HOST_INTENT
	) {
		return false;
	}
	const allowed =
		journalFormat === JOURNAL_FORMAT ? FORMAT_1_KEYS : FORMAT_2_KEYS;
	if (Object.keys(e).some((key) => !allowed.includes(key))) return false;
	const seq = e["seq"];
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
		return false;
	}
	if (!isHex64(e["prevHash"]) || !isHex64(e["hash"])) return false;
	if (!isNonEmptyString(e["principal"]) || !isNonEmptyString(e["forgetId"])) {
		return false;
	}
	let hostIntent: HostForgetIntent | null = null;
	if (Object.hasOwn(e, "hostIntent")) {
		hostIntent = readCanonicalHostIntent(e["hostIntent"]);
		if (hostIntent === null) return false;
	}
	const targets = e["targets"];
	if (
		!Array.isArray(targets) ||
		targets.length > LIMITS_LIFECYCLE.maxJournalTargets ||
		(targets.length === 0 && hostIntent === null)
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
		journalFormat,
		seq,
		prevHash: e["prevHash"],
		forgetId: e["forgetId"],
		principal: e["principal"],
		targets: typed,
		...(hostIntent !== null ? { hostIntent } : {}),
	} as const;
	return (
		e["forgetId"] === computeForgetId(body.principal, seq, typed) &&
		e["hash"] === computeEntryHash(body)
	);
}

/**
 * ジャーナル全体の鎖検証（環境依存なし）。seq は 1 始まりで連続、先頭の prevHash は `GENESIS_JOURNAL_HASH`、
 * 各 entry は自己整合で `prevHash` が直前の `hash` と一致すること。format 1 と 2 は混在してよい。
 * 切り詰め・欠落（DB との比較が要る）は `reconcileForgetJournal` だけが検出する。空のジャーナルは `ok`（head は null）。
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
