/**
 * ホストの全文検索（設計 `spec/state-search-design.md` §3.7、§3.8、§4.2、S9）。
 * 検索語の無害化（長さ、制御文字、分割、重複の除去）はここで行い、核の `searchState` には
 * 3 文字以上の語（FTS の経路）と 3 文字未満の語（instr の経路）に分けて渡す。
 * 件数は 20 件まで（核では limit + 1 件を読む）、返す item の JSON の合計は maxBytes まで。cursor は出さない（決定 2）。
 */
import { searchState, type MemoryDb } from "eumenes-memory/sqlite";
import {
	demand,
	HostError,
	type Grant,
	type HostResult,
	type MethodParams,
} from "./contracts.ts";
import type { HostItem } from "./meaning/model-input.ts";
import type { MemoryHost } from "./service.ts";

/** §3.7 の検索語の上限。 */
export const SEARCH_QUERY_LIMITS = Object.freeze({
	maxChars: 256,
	maxBytes: 1024,
	maxTerms: 8,
	maxTermChars: 64,
	/** これ以上の文字数（コードポイント）の語は FTS5 trigram で引く。未満は instr で絞る。 */
	minIndexedChars: 3,
});
const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** 区切りのタブ（U+0009）を除く制御文字（U+0000〜U+001F、U+007F。§3.8 の 1）があるか。タブは 2 の区切り。 */
function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
	}
	return false;
}
/** 空白（U+0020、U+3000、タブ）で分ける（§3.8 の 2）。 */
function splitTerms(text: string): string[] {
	const terms: string[] = [];
	let current = "";
	for (const char of text) {
		if (char === " " || char === "\u3000" || char === "\t") {
			if (current !== "") terms.push(current);
			current = "";
		} else current += char;
	}
	if (current !== "") terms.push(current);
	return terms;
}

export interface SanitizedQuery {
	indexedTerms: string[];
	scannedTerms: string[];
}
/** §3.8 の 1〜2 と 6。違反は QUERY_INVALID、語が無ければ QUERY_EMPTY。 */
export function sanitizeQuery(query: string): SanitizedQuery {
	demand(
		[...query].length <= SEARCH_QUERY_LIMITS.maxChars &&
			Buffer.byteLength(query, "utf8") <= SEARCH_QUERY_LIMITS.maxBytes &&
			!hasControl(query) &&
			!LONE_SURROGATE.test(query),
		"QUERY_INVALID",
	);
	const terms = [...new Set(splitTerms(query))];
	demand(terms.length > 0, "QUERY_EMPTY");
	demand(
		terms.length <= SEARCH_QUERY_LIMITS.maxTerms &&
			terms.every((t) => [...t].length <= SEARCH_QUERY_LIMITS.maxTermChars),
		"QUERY_INVALID",
	);
	return {
		indexedTerms: terms.filter(
			(t) => [...t].length >= SEARCH_QUERY_LIMITS.minIndexedChars,
		),
		scannedTerms: terms.filter(
			(t) => [...t].length < SEARCH_QUERY_LIMITS.minIndexedChars,
		),
	};
}

/** `search` の本体。読み取りの transaction の中で、核の検索 → 水和と evidenceStatus → byte の予算 → 検索用の snapshot。 */
export function runSearch(
	host: MemoryHost,
	grant: Grant,
	p: MethodParams<"search">,
): HostResult {
	if (host.searchIndexUnavailable)
		throw new HostError("SEARCH_INDEX_UNAVAILABLE", "failed");
	const query = sanitizeQuery(p.query);
	const scopes = p.scopeKeys ?? grant.scopeKeys;
	host.allowed(grant, scopes);
	return host.options.port.read((db: MemoryDb) => {
		const result = searchState(db, {
			contractVersion: 1,
			access: host.access(grant),
			scopeKeys: scopes,
			terms: { indexed: query.indexedTerms, scanned: query.scannedTerms },
			...(p.kinds ? { kinds: p.kinds } : {}),
			...(p.subject
				? { subject: p.subject as "self" | `other:${string}` }
				: {}),
			limit: Math.min(p.limit, host.limit("searchResults")),
			scanMax: host.limit("searchScanMax"),
		});
		if (result.status === "blocked")
			throw new HostError(
				result.reasonCode === "SCAN_LIMIT_EXCEEDED"
					? "QUERY_TOO_SHORT"
					: result.reasonCode === "SCOPE_NOT_PERMITTED"
						? "SCOPE_NOT_PERMITTED"
						: "READ_NOT_PERMITTED",
			);
		const items: HostItem[] = [];
		let bytes = 0;
		let truncatedBy: "count" | "bytes" | null = result.more ? "count" : null;
		for (const item of result.items) {
			const shown = host.withEvidenceStatus(db, item);
			const size = Buffer.byteLength(JSON.stringify(shown), "utf8");
			if (bytes + size > p.maxBytes) {
				truncatedBy = "bytes";
				break;
			}
			bytes += size;
			items.push(shown);
		}
		const snapshot = host.snapshots.create(
			items,
			scopes,
			grant,
			host.policy,
			(list) => host.fingerprint(db, list),
			"search",
		);
		return {
			status: "found",
			epoch: host.epoch,
			snapshotId: snapshot.id,
			scopeKeys: snapshot.scopes,
			items: snapshot.items,
			returned: snapshot.items.length,
			moreAvailable: truncatedBy !== null,
			truncatedBy,
			query: { ...query, mode: result.mode },
		};
	});
}
