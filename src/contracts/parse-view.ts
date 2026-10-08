/** MemoryView の parse。構造違反は例外、ready 以外は VIEW_NOT_READY（validate 側）。 */
import { deepFreeze } from "../canonical/freeze.ts";
import { LIMITS, SCHEMA_VERSION } from "./constants.ts";
import {
	readMemoryItem,
	readSourceCore,
	assertUniqueItemIds,
} from "./parse-input.ts";
import {
	BUILD_REASON_CODES,
	ACCESS_REASON_CODES,
	SOURCE_REASON_CODES,
	type BuildReasonCode,
} from "./reason-codes.ts";
import {
	checkKeys,
	fail,
	indexPath,
	keyPath,
	readArray,
	readDigest,
	readEnum,
	readIdentifier,
	readRecord,
	requiredField,
	type Rec,
} from "./reader.ts";
import { sourceKey } from "./source-key.ts";
import type {
	MemoryView,
	SourceDependency,
	ViewCoverage,
	ViewItem,
} from "./types.ts";

const VIEW_STATUSES = ["ready", "blocked", "overflow", "disabled"] as const;
const HEADER_KEYS = [
	"schemaVersion",
	"status",
	"principal",
	"scopeKey",
	"purpose",
	"stateRevision",
	"policyRevision",
	"instructionAuthority",
] as const;
const READY_KEYS = [
	...HEADER_KEYS,
	"items",
	"dependencies",
	"coverage",
	"viewDigest",
] as const;
const REASON_KEYS = [...HEADER_KEYS, "reasonCode"] as const;

function readCoverage(value: unknown, path: string): ViewCoverage {
	const record = readRecord(value, path);
	checkKeys(record, path, ["complete", "omitted"]);
	const complete = requiredField(record, path, "complete");
	if (typeof complete !== "boolean") {
		return fail("INVALID_TYPE", keyPath(path, "complete"));
	}
	const omittedPath = keyPath(path, "omitted");
	const omitted = readArray(
		requiredField(record, path, "omitted"),
		omittedPath,
		LIMITS.maxCoverageOmitted,
	);
	if (!complete || omitted.length !== 0) return fail("INVALID_VALUE", path);
	return { complete: true, omitted: [] };
}

export function readSourceDependency(
	value: unknown,
	path: string,
): SourceDependency {
	const record = readRecord(value, path);
	checkKeys(record, path, [
		"namespace",
		"kind",
		"id",
		"representation",
		"revision",
		"digest",
	]);
	return readSourceCore(record, path);
}

export function readViewHeader(record: Rec, path: string) {
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
	const purpose = readIdentifier(
		requiredField(record, path, "purpose"),
		keyPath(path, "purpose"),
		LIMITS.maxPurposeBytes,
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
	const instructionAuthority = readEnum(
		requiredField(record, path, "instructionAuthority"),
		keyPath(path, "instructionAuthority"),
		["none"] as const,
	);
	return {
		schemaVersion: SCHEMA_VERSION,
		principal,
		scopeKey,
		purpose,
		stateRevision,
		policyRevision,
		instructionAuthority,
	};
}

export function reasonAllowedFor(
	status: "blocked" | "overflow" | "disabled",
	reason: BuildReasonCode,
): boolean {
	if (status === "disabled") return reason === "MEMORY_DISABLED";
	if (status === "overflow") return reason === "BUDGET_EXCEEDED";
	return (
		(ACCESS_REASON_CODES as readonly string[]).includes(reason) ||
		(SOURCE_REASON_CODES as readonly string[]).includes(reason)
	);
}

export function parseMemoryView(value: unknown): MemoryView {
	const path = "$";
	const record = readRecord(value, path);
	// schemaVersion → status → 未知キー → 残り（未知の版・状態を先に拒否する）
	const versionPath = keyPath(path, "schemaVersion");
	const version = requiredField(record, path, "schemaVersion");
	if (typeof version !== "number") return fail("INVALID_TYPE", versionPath);
	if (!Number.isSafeInteger(version))
		return fail("INVALID_INTEGER", versionPath);
	if (version !== SCHEMA_VERSION) {
		return fail("UNSUPPORTED_SCHEMA_VERSION", versionPath);
	}
	const status = readEnum(
		requiredField(record, path, "status"),
		keyPath(path, "status"),
		VIEW_STATUSES,
	);
	checkKeys(record, path, status === "ready" ? READY_KEYS : REASON_KEYS);
	const header = readViewHeader(record, path);

	if (status !== "ready") {
		const reasonCode = readEnum(
			requiredField(record, path, "reasonCode"),
			keyPath(path, "reasonCode"),
			BUILD_REASON_CODES,
		);
		if (!reasonAllowedFor(status, reasonCode)) {
			return fail("INVALID_VALUE", keyPath(path, "reasonCode"));
		}
		return deepFreeze({ ...header, status, reasonCode } as MemoryView);
	}

	const itemsPath = keyPath(path, "items");
	const items = readArray(
		requiredField(record, path, "items"),
		itemsPath,
		LIMITS.maxItems,
	).map((element, index): ViewItem => {
		const item = readMemoryItem(element, indexPath(itemsPath, index), [
			"active",
		]);
		return { ...item, status: "active" };
	});
	assertUniqueItemIds(items, itemsPath);

	const dependenciesPath = keyPath(path, "dependencies");
	const dependencies = readArray(
		requiredField(record, path, "dependencies"),
		dependenciesPath,
		LIMITS.maxSources,
	).map((element, index) =>
		readSourceDependency(element, indexPath(dependenciesPath, index)),
	);
	const seen = new Set<string>();
	for (const [index, dependency] of dependencies.entries()) {
		const key = JSON.stringify([
			sourceKey(dependency),
			dependency.revision,
			dependency.digest,
		]);
		if (seen.has(key)) {
			return fail("DUPLICATE_SOURCE", indexPath(dependenciesPath, index));
		}
		seen.add(key);
	}

	const coverage = readCoverage(
		requiredField(record, path, "coverage"),
		keyPath(path, "coverage"),
	);
	const viewDigest = readDigest(
		requiredField(record, path, "viewDigest"),
		keyPath(path, "viewDigest"),
	);
	return deepFreeze({
		...header,
		status,
		items,
		dependencies,
		coverage,
		viewDigest,
	});
}
