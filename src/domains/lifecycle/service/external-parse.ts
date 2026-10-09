/**
 * ExternalDependent の登録・解除と外部削除記録の入力 parse。違反は MemoryContractError。
 * 契約は `src/contracts/external.ts` と `src/domains/lifecycle/contracts/index.ts`。
 */
import { deepFreeze } from "../../../canonical/freeze.ts";
import { readAccessContext } from "../../../contracts/parse-input.ts";
import {
	readContractVersion,
	readHostClock,
	readScopeKey,
} from "../../../contracts/parse-store.ts";
import {
	checkKeys,
	fail,
	indexPath,
	keyPath,
	readArray,
	readEnum,
	readIdentifier,
	readNameToken,
	readRecord,
	requiredField,
} from "../../../contracts/reader.ts";
import type { Rec } from "../../../contracts/reader.ts";
import {
	EXTERNAL_DEPENDENCY_TYPES,
	LIMITS_EXTERNAL,
} from "../../../contracts/external.ts";
import type {
	ExternalDependencyRef,
	ExternalDependent,
	ExternalDependentKey,
	RegisterExternalDependentsInput,
	UnregisterExternalDependentsInput,
} from "../../../contracts/external.ts";
import { EXTERNAL_DELETION_STATES } from "../contracts/index.ts";
import type { RecordExternalDeletionInput } from "../contracts/index.ts";
import { CONTRACT_VERSIONS } from "../../../contracts/versions.ts";

const PATH = "$";

/** SourceKey / itemId の最大長（lifecycle の parse と同じ）。 */
const MAX_DEPENDENCY_ID_BYTES = 1024;

function readProviderRef(value: unknown, path: string): string {
	return readNameToken(value, path, LIMITS_EXTERNAL.maxProviderRefBytes);
}

function readExternalId(value: unknown, path: string): string {
	return readIdentifier(value, path, LIMITS_EXTERNAL.maxExternalIdBytes);
}

function readDependencyRef(
	value: unknown,
	path: string,
): ExternalDependencyRef {
	const record = readRecord(value, path);
	checkKeys(record, path, ["type", "id"]);
	return {
		type: readEnum(
			requiredField(record, path, "type"),
			keyPath(path, "type"),
			EXTERNAL_DEPENDENCY_TYPES,
		),
		id: readIdentifier(
			requiredField(record, path, "id"),
			keyPath(path, "id"),
			MAX_DEPENDENCY_ID_BYTES,
		),
	};
}

function readDependent(value: unknown, path: string): ExternalDependent {
	const record = readRecord(value, path);
	checkKeys(record, path, ["providerRef", "externalId", "dependsOn"]);
	const providerRef = readProviderRef(
		requiredField(record, path, "providerRef"),
		keyPath(path, "providerRef"),
	);
	const externalId = readExternalId(
		requiredField(record, path, "externalId"),
		keyPath(path, "externalId"),
	);
	const dependsOnPath = keyPath(path, "dependsOn");
	const refs = readArray(
		requiredField(record, path, "dependsOn"),
		dependsOnPath,
		LIMITS_EXTERNAL.maxDependenciesPerDependent,
	).map((element, index) =>
		readDependencyRef(element, indexPath(dependsOnPath, index)),
	);
	// 辺のない派生物は作らない。
	if (refs.length === 0) return fail("INVALID_VALUE", dependsOnPath);
	const seen = new Set<string>();
	for (const [index, ref] of refs.entries()) {
		const key = `${ref.type}\u0000${ref.id}`;
		if (seen.has(key)) {
			return fail("DUPLICATE_DEPENDENCY", indexPath(dependsOnPath, index));
		}
		seen.add(key);
	}
	return { providerRef, externalId, dependsOn: refs };
}

function readKey(value: unknown, path: string): ExternalDependentKey {
	const record = readRecord(value, path);
	checkKeys(record, path, ["providerRef", "externalId"]);
	return {
		providerRef: readProviderRef(
			requiredField(record, path, "providerRef"),
			keyPath(path, "providerRef"),
		),
		externalId: readExternalId(
			requiredField(record, path, "externalId"),
			keyPath(path, "externalId"),
		),
	};
}

function failDuplicate(path: string): never {
	return fail("DUPLICATE_ITEM_ID", path);
}

export function parseRegisterExternalDependentsInput(
	value: unknown,
): RegisterExternalDependentsInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"clock",
		"dependents",
	]);
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.external,
	);
	const access = readAccessContext(
		requiredField(record, PATH, "access"),
		keyPath(PATH, "access"),
	);
	const scopeKey = readScopeKey(
		requiredField(record, PATH, "scopeKey"),
		keyPath(PATH, "scopeKey"),
	);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	const dependentsPath = keyPath(PATH, "dependents");
	const dependents = readArray(
		requiredField(record, PATH, "dependents"),
		dependentsPath,
		LIMITS_EXTERNAL.maxDependentsPerCall,
	).map((element, index) =>
		readDependent(element, indexPath(dependentsPath, index)),
	);
	const seen = new Set<string>();
	for (const [index, dependent] of dependents.entries()) {
		const key = `${dependent.providerRef}:${dependent.externalId}`;
		if (seen.has(key)) failDuplicate(indexPath(dependentsPath, index));
		seen.add(key);
	}
	return deepFreeze({ contractVersion, access, scopeKey, clock, dependents });
}

export function parseUnregisterExternalDependentsInput(
	value: unknown,
): UnregisterExternalDependentsInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"clock",
		"dependents",
	]);
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.external,
	);
	const access = readAccessContext(
		requiredField(record, PATH, "access"),
		keyPath(PATH, "access"),
	);
	const scopeKey = readScopeKey(
		requiredField(record, PATH, "scopeKey"),
		keyPath(PATH, "scopeKey"),
	);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	const dependentsPath = keyPath(PATH, "dependents");
	const dependents = readArray(
		requiredField(record, PATH, "dependents"),
		dependentsPath,
		LIMITS_EXTERNAL.maxDependentsPerCall,
	).map((element, index) => readKey(element, indexPath(dependentsPath, index)));
	return deepFreeze({ contractVersion, access, scopeKey, clock, dependents });
}

export function parseRecordExternalDeletionInput(
	value: unknown,
): RecordExternalDeletionInput {
	const record: Rec = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"clock",
		"forgetId",
		"providerRef",
		"externalId",
		"state",
	]);
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.lifecycle,
	);
	const access = readAccessContext(
		requiredField(record, PATH, "access"),
		keyPath(PATH, "access"),
	);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	const forgetId = readIdentifier(
		requiredField(record, PATH, "forgetId"),
		keyPath(PATH, "forgetId"),
		71,
	);
	// 抽出 run の providerRef は識別子（名前トークンとは限らない）。形の制限は識別子規則だけ。
	const providerRef = readIdentifier(
		requiredField(record, PATH, "providerRef"),
		keyPath(PATH, "providerRef"),
		LIMITS_EXTERNAL.maxProviderRefBytes,
	);
	const externalId = Object.hasOwn(record, "externalId")
		? readExternalId(record["externalId"], keyPath(PATH, "externalId"))
		: undefined;
	const stateValue = readEnum(
		requiredField(record, PATH, "state"),
		keyPath(PATH, "state"),
		EXTERNAL_DELETION_STATES,
	);
	if (stateValue === "pending") {
		return fail("INVALID_ENUM", keyPath(PATH, "state"));
	}
	return deepFreeze({
		contractVersion,
		access,
		clock,
		forgetId,
		providerRef,
		...(externalId === undefined ? {} : { externalId }),
		state: stateValue,
	});
}
