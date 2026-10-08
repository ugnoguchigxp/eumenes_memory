/**
 * 入力の parse（parse-don't-validate）。入力は読むだけで、検査済みの新しい
 * deep-frozen オブジェクトを返す。走査順は設計書 §2.1 の宣言順。
 */
import { deepFreeze } from "../canonical/freeze.ts";
import { utf8ByteLength } from "../canonical/utf8.ts";
import {
	ITEM_KINDS,
	ITEM_ORIGINS,
	ITEM_STATUSES,
	LIMITS,
	SCHEMA_VERSION,
	SOURCE_STATUSES,
} from "./constants.ts";
import {
	checkKeys,
	fail,
	indexPath,
	keyPath,
	readArray,
	readBoolean,
	readDigest,
	readEnum,
	readIdentifier,
	readItemId,
	readNameToken,
	readRecord,
	readSafeInteger,
	readText,
	requiredField,
	type Rec,
} from "./reader.ts";
import { ownValue } from "./own.ts";
import { sourceKey } from "./source-key.ts";
import type {
	AccessContext,
	BuildMemoryViewInput,
	ByteRange,
	ItemStatus,
	MemoryItem,
	Snapshot,
	SourceRef,
	SourceState,
	ValidationCurrent,
} from "./types.ts";

// ---- 共通部品 ----

/** トップレベルのみ: schemaVersion を最初に検査する。 */
function checkSchemaVersion(record: Rec, path: string): void {
	const field = keyPath(path, "schemaVersion");
	const value = requiredField(record, path, "schemaVersion");
	if (typeof value !== "number") return fail("INVALID_TYPE", field);
	if (!Number.isSafeInteger(value)) return fail("INVALID_INTEGER", field);
	if (value !== SCHEMA_VERSION)
		return fail("UNSUPPORTED_SCHEMA_VERSION", field);
}

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

function sourceRefIdentity(ref: SourceRef): string {
	const range = ownValue(ref, "range");
	return JSON.stringify([
		sourceKey(ref),
		ref.revision,
		ref.digest,
		range === undefined ? null : [range.startByte, range.endByte],
	]);
}

// ---- item ----

const ITEM_KEYS = [
	"id",
	"revision",
	"kind",
	"text",
	"status",
	"origin",
	"primarySource",
	"dependencies",
] as const;

/** snapshot の MemoryItem と view の ViewItem で共通（status の許可集合だけ違う）。 */
export function readMemoryItem(
	value: unknown,
	path: string,
	statuses: readonly ItemStatus[],
): MemoryItem {
	const record = readRecord(value, path);
	checkKeys(record, path, ITEM_KEYS);
	const id = readItemId(
		requiredField(record, path, "id"),
		keyPath(path, "id"),
		LIMITS.maxItemIdBytes,
		LIMITS.maxNamespaceBytes,
	);
	const revision = readIdentifier(
		requiredField(record, path, "revision"),
		keyPath(path, "revision"),
		LIMITS.maxRevisionBytes,
	);
	const kind = readEnum(
		requiredField(record, path, "kind"),
		keyPath(path, "kind"),
		ITEM_KINDS,
	);
	const text = readText(
		requiredField(record, path, "text"),
		keyPath(path, "text"),
		LIMITS.maxItemTextBytes,
		false,
	);
	const status = readEnum(
		requiredField(record, path, "status"),
		keyPath(path, "status"),
		statuses,
	);
	const origin = readEnum(
		requiredField(record, path, "origin"),
		keyPath(path, "origin"),
		ITEM_ORIGINS,
	);
	const primarySource = readSourceRef(
		requiredField(record, path, "primarySource"),
		keyPath(path, "primarySource"),
	);
	const dependenciesPath = keyPath(path, "dependencies");
	const dependencies = readArray(
		requiredField(record, path, "dependencies"),
		dependenciesPath,
		LIMITS.maxDependenciesPerItem,
	).map((element, index) =>
		readSourceRef(element, indexPath(dependenciesPath, index)),
	);
	checkDependencies(dependencies, primarySource, dependenciesPath, path);
	return {
		id,
		revision,
		kind,
		text,
		status,
		origin,
		primarySource,
		dependencies,
	};
}

export function checkDependencies(
	dependencies: readonly SourceRef[],
	primarySource: SourceRef,
	dependenciesPath: string,
	itemPath: string,
): void {
	const identities = new Set<string>();
	for (const [index, dependency] of dependencies.entries()) {
		const identity = sourceRefIdentity(dependency);
		if (identities.has(identity)) {
			return fail("DUPLICATE_DEPENDENCY", indexPath(dependenciesPath, index));
		}
		identities.add(identity);
	}
	const versions = new Map<string, string>();
	for (const [index, dependency] of dependencies.entries()) {
		const key = sourceKey(dependency);
		const version = JSON.stringify([dependency.revision, dependency.digest]);
		const known = versions.get(key);
		if (known !== undefined && known !== version) {
			return fail("CONFLICTING_DEPENDENCY", indexPath(dependenciesPath, index));
		}
		versions.set(key, version);
	}
	if (!identities.has(sourceRefIdentity(primarySource))) {
		fail(
			"PRIMARY_SOURCE_NOT_IN_DEPENDENCIES",
			keyPath(itemPath, "primarySource"),
		);
	}
}

// ---- access / snapshot ----

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

export function readSourceState(value: unknown, path: string): SourceState {
	const record = readRecord(value, path);
	checkKeys(record, path, [
		...SOURCE_CORE_KEYS,
		"principal",
		"scopeKey",
		"status",
		"content",
	]);
	const core = readSourceCore(record, path);
	const principal = readIdentifier(
		requiredField(record, path, "principal"),
		keyPath(path, "principal"),
		LIMITS.maxPrincipalBytes,
	);
	const scopeKey = readIdentifier(
		requiredField(record, path, "scopeKey"),
		keyPath(path, "scopeKey"),
		LIMITS.maxScopeKeyBytes,
	);
	const status = readEnum(
		requiredField(record, path, "status"),
		keyPath(path, "status"),
		SOURCE_STATUSES,
	);
	const base = { ...core, principal, scopeKey, status };
	if (!Object.hasOwn(record, "content")) return base;
	const content = readText(
		record["content"],
		keyPath(path, "content"),
		LIMITS.maxSourceContentBytes,
		true,
	);
	return { ...base, content };
}

function readSnapshot(value: unknown, path: string): Snapshot {
	return readSnapshotWith(value, path, (element, itemPath) =>
		readMemoryItem(element, itemPath, ITEM_STATUSES),
	);
}

/** snapshot の共通部分。items の読み方（v1 / v2 で kind・origin・subject が違う）だけを差し替える。 */
export function readSnapshotWith<TItem extends { readonly id: string }>(
	value: unknown,
	path: string,
	readItem: (element: unknown, itemPath: string) => TItem,
): {
	readonly principal: string;
	readonly scopeKey: string;
	readonly stateRevision: string;
	readonly policyRevision: string;
	readonly complete: boolean;
	readonly sources: readonly SourceState[];
	readonly items: readonly TItem[];
} {
	const record = readRecord(value, path);
	checkKeys(record, path, [
		"principal",
		"scopeKey",
		"stateRevision",
		"policyRevision",
		"complete",
		"sources",
		"items",
	]);
	const principal = readIdentifier(
		requiredField(record, path, "principal"),
		keyPath(path, "principal"),
		LIMITS.maxPrincipalBytes,
	);
	const scopeKey = readIdentifier(
		requiredField(record, path, "scopeKey"),
		keyPath(path, "scopeKey"),
		LIMITS.maxScopeKeyBytes,
	);
	const stateRevision = readIdentifier(
		requiredField(record, path, "stateRevision"),
		keyPath(path, "stateRevision"),
		LIMITS.maxRevisionBytes,
	);
	const policyRevision = readIdentifier(
		requiredField(record, path, "policyRevision"),
		keyPath(path, "policyRevision"),
		LIMITS.maxRevisionBytes,
	);
	const complete = readBoolean(
		requiredField(record, path, "complete"),
		keyPath(path, "complete"),
	);

	const sourcesPath = keyPath(path, "sources");
	const sources = readArray(
		requiredField(record, path, "sources"),
		sourcesPath,
		LIMITS.maxSources,
	).map((element, index) =>
		readSourceState(element, indexPath(sourcesPath, index)),
	);
	const sourceKeys = new Set<string>();
	for (const [index, source] of sources.entries()) {
		const key = sourceKey(source);
		if (sourceKeys.has(key)) {
			return fail("DUPLICATE_SOURCE", indexPath(sourcesPath, index));
		}
		sourceKeys.add(key);
	}
	let totalContentBytes = 0;
	for (const source of sources) {
		const content = ownValue(source, "content");
		if (content !== undefined) totalContentBytes += utf8ByteLength(content);
	}
	if (totalContentBytes > LIMITS.maxTotalSourceContentBytes) {
		return fail("TOTAL_CONTENT_TOO_LARGE", sourcesPath);
	}

	const itemsPath = keyPath(path, "items");
	const items = readArray(
		requiredField(record, path, "items"),
		itemsPath,
		LIMITS.maxItems,
	).map((element, index) => readItem(element, indexPath(itemsPath, index)));
	assertUniqueItemIds(items, itemsPath);

	return {
		principal,
		scopeKey,
		stateRevision,
		policyRevision,
		complete,
		sources,
		items,
	};
}

export function assertUniqueItemIds(
	items: readonly { readonly id: string }[],
	itemsPath: string,
): void {
	const ids = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (ids.has(item.id)) {
			return fail("DUPLICATE_ITEM_ID", indexPath(itemsPath, index));
		}
		ids.add(item.id);
	}
}

// ---- 公開 parse ----

export function parseBuildMemoryViewInput(
	value: unknown,
): BuildMemoryViewInput {
	const path = "$";
	const record = readRecord(value, path);
	checkSchemaVersion(record, path);
	checkKeys(record, path, [
		"schemaVersion",
		"access",
		"snapshot",
		"maxBytes",
		"enabled",
	]);
	const access = readAccessContext(
		requiredField(record, path, "access"),
		keyPath(path, "access"),
	);
	const snapshot = readSnapshot(
		requiredField(record, path, "snapshot"),
		keyPath(path, "snapshot"),
	);
	const maxBytes = readSafeInteger(
		requiredField(record, path, "maxBytes"),
		keyPath(path, "maxBytes"),
		0,
		Number.MAX_SAFE_INTEGER,
	);
	const enabled = readBoolean(
		requiredField(record, path, "enabled"),
		keyPath(path, "enabled"),
	);
	return deepFreeze({
		schemaVersion: SCHEMA_VERSION,
		access,
		snapshot,
		maxBytes,
		enabled,
	});
}

export function parseValidationCurrent(value: unknown): ValidationCurrent {
	const path = "$";
	const record = readRecord(value, path);
	checkSchemaVersion(record, path);
	checkKeys(record, path, ["schemaVersion", "access", "snapshot"]);
	const access = readAccessContext(
		requiredField(record, path, "access"),
		keyPath(path, "access"),
	);
	const snapshot = readSnapshot(
		requiredField(record, path, "snapshot"),
		keyPath(path, "snapshot"),
	);
	return deepFreeze({ schemaVersion: SCHEMA_VERSION, access, snapshot });
}
