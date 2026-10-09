/**
 * Recall 入力の parse。違反は MemoryContractError。
 */
import { deepFreeze } from "../../../canonical/freeze.ts";
import { LIMITS_RECALL } from "../contracts/index.ts";
import type { SearchRecordsInput } from "../contracts/index.ts";
import { readAccessContext } from "../../../contracts/parse-input.ts";
import {
	readContractVersion,
	readScopeKeys,
} from "../../../contracts/parse-store.ts";
import {
	checkKeys,
	fail,
	keyPath,
	readIdentifier,
	readRecord,
	readSafeInteger,
	readText,
	requiredField,
} from "../../../contracts/reader.ts";
import { CONTRACT_VERSIONS } from "../../../contracts/versions.ts";
import { parseQueryTerms } from "./query.ts";
import type { ParsedQuery } from "./query.ts";

export interface ParsedSearchRecordsInput {
	readonly input: SearchRecordsInput;
	readonly query: ParsedQuery;
}

export function parseSearchRecordsInput(
	value: unknown,
): ParsedSearchRecordsInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		"contractVersion",
		"access",
		"scopeKeys",
		"query",
		"limit",
		"cursor",
	]);
	const contractVersion = readContractVersion(
		record,
		path,
		CONTRACT_VERSIONS.recall,
	);
	const access = readAccessContext(
		requiredField(record, path, "access"),
		keyPath(path, "access"),
	);
	const scopeKeys = readScopeKeys(
		requiredField(record, path, "scopeKeys"),
		keyPath(path, "scopeKeys"),
	);
	if (scopeKeys.length > LIMITS_RECALL.maxScopeKeys) {
		return fail("ARRAY_TOO_LONG", keyPath(path, "scopeKeys"));
	}
	const queryPath = keyPath(path, "query");
	const queryText = readText(
		requiredField(record, path, "query"),
		queryPath,
		LIMITS_RECALL.maxQueryBytes,
		true,
	);
	const parsed = parseQueryTerms(queryText);
	if (parsed.status === "invalid") return fail(parsed.code, queryPath);
	const limit = readSafeInteger(
		requiredField(record, path, "limit"),
		keyPath(path, "limit"),
		LIMITS_RECALL.minLimit,
		LIMITS_RECALL.maxLimit,
	);
	const cursor = Object.hasOwn(record, "cursor")
		? readIdentifier(
				record["cursor"],
				keyPath(path, "cursor"),
				LIMITS_RECALL.maxCursorBytes,
			)
		: undefined;
	return {
		input: deepFreeze({
			contractVersion,
			access,
			scopeKeys,
			query: queryText,
			limit,
			...(cursor === undefined ? {} : { cursor }),
		}),
		query: parsed.query,
	};
}
