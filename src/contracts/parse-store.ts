/**
 * 永続 API の入力 parse に共通の部品と、S0 で実装する `listMemoryChanges` の入力 parse。
 * 各 family の parse は所有ドメインが自分のファイル（例 `src/domains/records/service/parse.ts`）に書き、
 * ここの部品を使う。違反は MemoryContractError（code と path のみ）。
 */
import { deepFreeze } from "../canonical/freeze.ts";
import { LIMITS } from "./constants.ts";
import { CONTRACT_VERSIONS } from "./versions.ts";
import { readAccessContext } from "./parse-input.ts";
import {
	checkKeys,
	fail,
	indexPath,
	keyPath,
	readArray,
	readIdentifier,
	readRecord,
	readSafeInteger,
	requiredField,
	type Rec,
} from "./reader.ts";
import type { ContractVersion, HostClock } from "./common.ts";
import { LIMITS_EXTERNAL } from "./external.ts";
import type { ListMemoryChangesInput } from "./external.ts";

/** `contractVersion` を検査する。整数でなければ INVALID_*、期待と違えば UNSUPPORTED_SCHEMA_VERSION。 */
export function readContractVersion(
	record: Rec,
	path: string,
	expected: number,
): ContractVersion {
	const field = keyPath(path, "contractVersion");
	const value = requiredField(record, path, "contractVersion");
	if (typeof value !== "number") return fail("INVALID_TYPE", field);
	if (!Number.isSafeInteger(value)) return fail("INVALID_INTEGER", field);
	if (value !== expected) return fail("UNSUPPORTED_SCHEMA_VERSION", field);
	return 1;
}

export function readScopeKey(value: unknown, path: string): string {
	return readIdentifier(value, path, LIMITS.maxScopeKeyBytes);
}

/** 重複なし・1 件以上の scopeKey 配列。 */
export function readScopeKeys(value: unknown, path: string): readonly string[] {
	const scopeKeys = readArray(value, path, LIMITS.maxScopeKeys).map(
		(element, index) => readScopeKey(element, indexPath(path, index)),
	);
	if (scopeKeys.length === 0) return fail("INVALID_VALUE", path);
	const seen = new Set<string>();
	for (const [index, scopeKey] of scopeKeys.entries()) {
		if (seen.has(scopeKey)) {
			return fail("DUPLICATE_SCOPE_KEY", indexPath(path, index));
		}
		seen.add(scopeKey);
	}
	return scopeKeys;
}

export function readHostClock(value: unknown, path: string): HostClock {
	const record = readRecord(value, path);
	checkKeys(record, path, ["atMs"]);
	return {
		atMs: readSafeInteger(
			requiredField(record, path, "atMs"),
			keyPath(path, "atMs"),
			0,
			Number.MAX_SAFE_INTEGER,
		),
	};
}

export function parseListMemoryChangesInput(
	value: unknown,
): ListMemoryChangesInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		"contractVersion",
		"access",
		"scopeKeys",
		"afterSeq",
		"limit",
	]);
	const contractVersion = readContractVersion(
		record,
		path,
		CONTRACT_VERSIONS.external,
	);
	const access = readAccessContext(
		requiredField(record, path, "access"),
		keyPath(path, "access"),
	);
	const scopeKeys = readScopeKeys(
		requiredField(record, path, "scopeKeys"),
		keyPath(path, "scopeKeys"),
	);
	const afterSeq = readSafeInteger(
		requiredField(record, path, "afterSeq"),
		keyPath(path, "afterSeq"),
		0,
		Number.MAX_SAFE_INTEGER,
	);
	const limit = readSafeInteger(
		requiredField(record, path, "limit"),
		keyPath(path, "limit"),
		LIMITS_EXTERNAL.minChangesPerPage,
		LIMITS_EXTERNAL.maxChangesPerPage,
	);
	return deepFreeze({ contractVersion, access, scopeKeys, afterSeq, limit });
}
