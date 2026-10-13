/**
 * 入力の parse（parse-don't-validate）。入力は読むだけで、検査済みの新しい
 * deep-frozen オブジェクトを返す。
 */
import { LIMITS } from "./constants.ts";
import {
	checkKeys,
	fail,
	indexPath,
	keyPath,
	readArray,
	readDigest,
	readIdentifier,
	readNameToken,
	readRecord,
	readSafeInteger,
	requiredField,
	type Rec,
} from "./reader.ts";
import type { AccessContext, ByteRange, SourceRef } from "./types.ts";

/** 出典の同一性 + 版（SourceRef / SourceState / SourceDependency で共通）。 */
export interface SourceCore {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
	readonly revision: string;
	readonly digest: string;
}

export function readSourceCore(record: Rec, path: string): SourceCore {
	const namespace = readNameToken(
		requiredField(record, path, "namespace"),
		keyPath(path, "namespace"),
		LIMITS.maxNamespaceBytes,
	);
	const kind = readNameToken(
		requiredField(record, path, "kind"),
		keyPath(path, "kind"),
		LIMITS.maxSourceKindBytes,
	);
	const id = readIdentifier(
		requiredField(record, path, "id"),
		keyPath(path, "id"),
		LIMITS.maxSourceIdBytes,
	);
	const representation = Object.hasOwn(record, "representation")
		? readIdentifier(
				record["representation"],
				keyPath(path, "representation"),
				LIMITS.maxRepresentationBytes,
			)
		: undefined;
	const revision = readIdentifier(
		requiredField(record, path, "revision"),
		keyPath(path, "revision"),
		LIMITS.maxRevisionBytes,
	);
	const digest = readDigest(
		requiredField(record, path, "digest"),
		keyPath(path, "digest"),
	);
	return {
		namespace,
		kind,
		id,
		...(representation === undefined ? {} : { representation }),
		revision,
		digest,
	};
}

const SOURCE_CORE_KEYS = [
	"namespace",
	"kind",
	"id",
	"representation",
	"revision",
	"digest",
] as const;

function parseByteRange(value: unknown, path: string): ByteRange {
	const record = readRecord(value, path);
	checkKeys(record, path, ["startByte", "endByte"]);
	const startByte = readSafeInteger(
		requiredField(record, path, "startByte"),
		keyPath(path, "startByte"),
		0,
		LIMITS.maxSourceContentBytes,
	);
	const endByte = readSafeInteger(
		requiredField(record, path, "endByte"),
		keyPath(path, "endByte"),
		0,
		LIMITS.maxSourceContentBytes,
	);
	if (startByte >= endByte) return fail("INVALID_RANGE", path);
	return { startByte, endByte };
}

export function readSourceRef(value: unknown, path: string): SourceRef {
	const record = readRecord(value, path);
	checkKeys(record, path, [...SOURCE_CORE_KEYS, "range"]);
	const core = readSourceCore(record, path);
	if (!Object.hasOwn(record, "range")) return core;
	return {
		...core,
		range: parseByteRange(record["range"], keyPath(path, "range")),
	};
}

export function readAccessContext(value: unknown, path: string): AccessContext {
	const record = readRecord(value, path);
	checkKeys(record, path, [
		"principal",
		"scopeKeys",
		"purpose",
		"policyRevision",
	]);
	const principal = readIdentifier(
		requiredField(record, path, "principal"),
		keyPath(path, "principal"),
		LIMITS.maxPrincipalBytes,
	);
	const scopeKeysPath = keyPath(path, "scopeKeys");
	const scopeKeys = readArray(
		requiredField(record, path, "scopeKeys"),
		scopeKeysPath,
		LIMITS.maxScopeKeys,
	).map((element, index) =>
		readIdentifier(
			element,
			indexPath(scopeKeysPath, index),
			LIMITS.maxScopeKeyBytes,
		),
	);
	const seen = new Set<string>();
	for (const [index, scopeKey] of scopeKeys.entries()) {
		if (seen.has(scopeKey)) {
			return fail("DUPLICATE_SCOPE_KEY", indexPath(scopeKeysPath, index));
		}
		seen.add(scopeKey);
	}
	const purpose = readIdentifier(
		requiredField(record, path, "purpose"),
		keyPath(path, "purpose"),
		LIMITS.maxPurposeBytes,
	);
	const policyRevision = readIdentifier(
		requiredField(record, path, "policyRevision"),
		keyPath(path, "policyRevision"),
		LIMITS.maxRevisionBytes,
	);
	return { principal, scopeKeys, purpose, policyRevision };
}
