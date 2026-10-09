/**
 * 意味 key の照合（evolution-proposal「本人の事実と推測」）。モデルが毎回作る自由文字列だけで同一性を決めない。
 * 版つきの辞書（少数の共通 predicate と alias）に照らし、確定できたものだけ正規の key にする。
 *
 * - 完全一致（正規化後の predicate ID）または alias が 1 つの predicate にだけ当たるときだけ `resolved`。
 * - 2 つ以上に当たる alias は `ambiguous`、辞書に無いものは `unknown`。どちらも key を変えず、統合しない
 *   （誤った自動統合は、別々に残る重複より影響が大きい）。
 * - `predicate@target` の `@` 以降は scope 内の対象 ID として保持する（正規化は小文字・空白除去のみ）。
 * - 同じ語でも scope（Project）が違えば別の台帳なので統合されない。期間の違いは key ではなく item の期間で表す。
 */
import { compareCodeUnits } from "../../../canonical/compare.ts";
import type { PredicateDictionary } from "../contracts/index.ts";

export type KeyResolution =
	| {
			readonly status: "resolved";
			readonly key: string;
			readonly predicate: string;
			readonly via: "exact" | "alias";
	  }
	| { readonly status: "ambiguous"; readonly candidates: readonly string[] }
	| { readonly status: "unknown" };

const MAX_PREDICATES = 256;
const MAX_ALIASES = 64;

function normalize(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 辞書の検査。predicate ID と alias の重複（別 predicate が同じ alias を持つ場合は許すが ambiguous になる）以外の不正は例外。 */
export function assertPredicateDictionary(
	dictionary: PredicateDictionary,
): void {
	if (
		typeof dictionary.version !== "string" ||
		dictionary.version.length === 0 ||
		!Array.isArray(dictionary.predicates) ||
		dictionary.predicates.length > MAX_PREDICATES
	)
		throw new TypeError("INVALID_DICTIONARY");
	const ids = new Set<string>();
	for (const entry of dictionary.predicates) {
		const id = typeof entry.id === "string" ? normalize(entry.id) : "";
		if (
			id === "" ||
			id.includes("@") ||
			ids.has(id) ||
			!Array.isArray(entry.aliases) ||
			entry.aliases.length > MAX_ALIASES ||
			entry.aliases.some(
				(alias: unknown) =>
					typeof alias !== "string" ||
					normalize(alias) === "" ||
					normalize(alias).includes("@"),
			)
		)
			throw new TypeError("INVALID_DICTIONARY");
		ids.add(id);
	}
}

export interface KeyResolver {
	/** 確定できたときだけ正規の key。不明・曖昧は元のまま。 */
	canonical(rawKey: string): string;
	resolve(rawKey: string): KeyResolution;
}

/** 辞書を 1 度だけ検査し、照合表を作る（候補ごとに作り直さない）。 */
export function makeKeyResolver(dictionary: PredicateDictionary): KeyResolver {
	assertPredicateDictionary(dictionary);
	const ids = new Set(
		dictionary.predicates.map((entry) => normalize(entry.id)),
	);
	const aliases = new Map<string, string[]>();
	for (const entry of dictionary.predicates) {
		for (const alias of entry.aliases) {
			const key = normalize(alias);
			const list = aliases.get(key) ?? [];
			const id = normalize(entry.id);
			if (!list.includes(id)) list.push(id);
			aliases.set(key, list);
		}
	}
	const resolve = (rawKey: string): KeyResolution => {
		const at = rawKey.indexOf("@");
		const head = normalize(at < 0 ? rawKey : rawKey.slice(0, at));
		const target =
			at < 0 ? "" : normalize(rawKey.slice(at + 1)).replace(/ /g, "");
		if (head === "" || (at >= 0 && target === "")) return { status: "unknown" };
		const withTarget = (id: string) => (target === "" ? id : `${id}@${target}`);
		if (ids.has(head)) {
			return {
				status: "resolved",
				key: withTarget(head),
				predicate: head,
				via: "exact",
			};
		}
		const hits = [...(aliases.get(head) ?? [])].sort(compareCodeUnits);
		if (hits.length === 1) {
			const id = hits[0] as string;
			return {
				status: "resolved",
				key: withTarget(id),
				predicate: id,
				via: "alias",
			};
		}
		if (hits.length > 1) return { status: "ambiguous", candidates: hits };
		return { status: "unknown" };
	};
	return {
		resolve,
		canonical(rawKey) {
			const resolution = resolve(rawKey);
			return resolution.status === "resolved" ? resolution.key : rawKey;
		},
	};
}

export function resolveSemanticKey(
	rawKey: string,
	dictionary: PredicateDictionary,
): KeyResolution {
	return makeKeyResolver(dictionary).resolve(rawKey);
}

/** 確定できたときだけ正規の key を返し、それ以外は元の key のまま（統合しない）。 */
export function canonicalSemanticKey(
	rawKey: string,
	dictionary: PredicateDictionary | undefined,
): string {
	return dictionary === undefined
		? rawKey
		: makeKeyResolver(dictionary).canonical(rawKey);
}

/** 2 つの key が同じ対象かを、辞書で確定できる場合だけ true。不明・曖昧は false（統合しない）。 */
export function sameSemanticKey(
	a: string,
	b: string,
	dictionary: PredicateDictionary,
): boolean {
	const resolver = makeKeyResolver(dictionary);
	const left = resolver.resolve(a);
	const right = resolver.resolve(b);
	return (
		left.status === "resolved" &&
		right.status === "resolved" &&
		left.key === right.key
	);
}
