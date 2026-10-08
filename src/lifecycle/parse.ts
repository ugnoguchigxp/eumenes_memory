/**
 * Lifecycle 入力の parse。違反は MemoryContractError。
 * S1 が実装する target は `record` と `scope`。それ以外（`host_source` / `state_item`）は形だけ検査して
 * そのまま返し、store 側が NOT_IMPLEMENTED（S6 が実装）にする。
 */
import { deepFreeze } from "../canonical/freeze.ts";
import { readAccessContext } from "../contracts/parse-input.ts";
import {
	readContractVersion,
	readHostClock,
	readScopeKey,
} from "../contracts/parse-store.ts";
import {
	checkKeys,
	fail,
	indexPath,
	keyPath,
	readArray,
	readEnum,
	readIdentifier,
	readRecord,
	readSafeInteger,
	requiredField,
} from "../contracts/reader.ts";
import type { Rec } from "../contracts/reader.ts";
import { LIMITS } from "../contracts/constants.ts";
import {
	FORGET_TARGET_TYPES,
	JOURNAL_FORMAT,
	LIMITS_LIFECYCLE,
} from "../contracts/lifecycle.ts";
import type {
	ApplyForgetInput,
	ForgetJournalEntry,
	ForgetJournalTarget,
	ForgetTarget,
	GetForgetReceiptInput,
	PlanForgetInput,
	ReconcileForgetJournalInput,
} from "../contracts/lifecycle.ts";
import { CONTRACT_VERSIONS } from "../contracts/versions.ts";
import { isRecordId } from "../evidence/record.ts";

const PATH = "$";

function readForgetTarget(value: unknown, path: string): ForgetTarget {
	const record = readRecord(value, path);
	const type = readEnum(
		requiredField(record, path, "type"),
		keyPath(path, "type"),
		FORGET_TARGET_TYPES,
	);
	const scopeKey = readScopeKey(
		requiredField(record, path, "scopeKey"),
		keyPath(path, "scopeKey"),
	);
	switch (type) {
		case "record": {
			checkKeys(record, path, ["type", "recordId", "scopeKey"]);
			const recordIdPath = keyPath(path, "recordId");
			const recordId = readIdentifier(
				requiredField(record, path, "recordId"),
				recordIdPath,
				68,
			);
			if (!isRecordId(recordId)) return fail("INVALID_ID_FORMAT", recordIdPath);
			return { type, recordId, scopeKey };
		}
		case "scope":
			checkKeys(record, path, ["type", "scopeKey"]);
			return { type, scopeKey };
		case "host_source": {
			checkKeys(record, path, ["type", "sourceKey", "scopeKey"]);
			const sourceKey = readIdentifier(
				requiredField(record, path, "sourceKey"),
				keyPath(path, "sourceKey"),
				1024,
			);
			return { type, sourceKey, scopeKey };
		}
		case "state_item": {
			checkKeys(record, path, ["type", "itemId", "scopeKey"]);
			const itemId = readIdentifier(
				requiredField(record, path, "itemId"),
				keyPath(path, "itemId"),
				LIMITS.maxItemIdBytes,
			);
			return { type, itemId, scopeKey };
		}
	}
}

export function parsePlanForgetInput(value: unknown): PlanForgetInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, ["contractVersion", "access", "target", "clock"]);
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.lifecycle,
	);
	const access = readAccessContext(
		requiredField(record, PATH, "access"),
		keyPath(PATH, "access"),
	);
	const target = readForgetTarget(
		requiredField(record, PATH, "target"),
		keyPath(PATH, "target"),
	);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	return deepFreeze({ contractVersion, access, target, clock });
}

function readHex64(value: unknown, path: string): string {
	const text = readIdentifier(value, path, 64);
	if (!/^[0-9a-f]{64}$/.test(text)) return fail("INVALID_DIGEST", path);
	return text;
}

/** entry の形だけを検査する（hash・鎖の整合は journal.ts の `isSelfConsistent`）。 */
export function readJournalEntry(
	value: unknown,
	path: string,
): ForgetJournalEntry {
	const record = readRecord(value, path);
	checkKeys(record, path, [
		"journalFormat",
		"seq",
		"prevHash",
		"forgetId",
		"principal",
		"targets",
		"hash",
	]);
	if (requiredField(record, path, "journalFormat") !== JOURNAL_FORMAT) {
		return fail("UNSUPPORTED_SCHEMA_VERSION", keyPath(path, "journalFormat"));
	}
	const seq = readSafeInteger(
		requiredField(record, path, "seq"),
		keyPath(path, "seq"),
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const prevHash = readHex64(
		requiredField(record, path, "prevHash"),
		keyPath(path, "prevHash"),
	);
	const forgetId = readIdentifier(
		requiredField(record, path, "forgetId"),
		keyPath(path, "forgetId"),
		71,
	);
	const principal = readIdentifier(
		requiredField(record, path, "principal"),
		keyPath(path, "principal"),
		LIMITS.maxPrincipalBytes,
	);
	const targetsPath = keyPath(path, "targets");
	const targets: ForgetJournalTarget[] = readArray(
		requiredField(record, path, "targets"),
		targetsPath,
		LIMITS_LIFECYCLE.maxJournalTargets,
	).map((element, index) => {
		const targetPath = indexPath(targetsPath, index);
		const target: Rec = readRecord(element, targetPath);
		checkKeys(target, targetPath, ["type", "id", "scopeKey"]);
		return {
			type: readEnum(
				requiredField(target, targetPath, "type"),
				keyPath(targetPath, "type"),
				FORGET_TARGET_TYPES,
			),
			id: readIdentifier(
				requiredField(target, targetPath, "id"),
				keyPath(targetPath, "id"),
				1024,
			),
			scopeKey: readScopeKey(
				requiredField(target, targetPath, "scopeKey"),
				keyPath(targetPath, "scopeKey"),
			),
		};
	});
	if (targets.length === 0) return fail("INVALID_VALUE", targetsPath);
	const hash = readHex64(
		requiredField(record, path, "hash"),
		keyPath(path, "hash"),
	);
	return {
		journalFormat: JOURNAL_FORMAT,
		seq,
		prevHash,
		forgetId,
		principal,
		targets,
		hash,
	};
}

export function parseApplyForgetInput(value: unknown): ApplyForgetInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, ["contractVersion", "entry", "clock"]);
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.lifecycle,
	);
	const entry = readJournalEntry(
		requiredField(record, PATH, "entry"),
		keyPath(PATH, "entry"),
	);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	return deepFreeze({ contractVersion, entry, clock });
}

/**
 * entries は配列であることと件数だけを検査し、要素は未検査のまま返す（壊れた entry は reconcile が
 * `inconsistent` として報告する。例外にしない）。
 */
export interface ParsedReconcileInput {
	readonly contractVersion: ReconcileForgetJournalInput["contractVersion"];
	readonly entries: readonly unknown[];
	readonly clock: ReconcileForgetJournalInput["clock"];
}

export function parseReconcileForgetJournalInput(
	value: unknown,
): ParsedReconcileInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, ["contractVersion", "entries", "clock"]);
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.lifecycle,
	);
	const entriesValue = requiredField(record, PATH, "entries");
	if (!Array.isArray(entriesValue)) {
		return fail("INVALID_TYPE", keyPath(PATH, "entries"));
	}
	if (entriesValue.length > LIMITS_LIFECYCLE.maxJournalEntries) {
		return fail("ARRAY_TOO_LONG", keyPath(PATH, "entries"));
	}
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	return {
		contractVersion,
		entries: entriesValue as readonly unknown[],
		clock,
	};
}

export function parseGetForgetReceiptInput(
	value: unknown,
): GetForgetReceiptInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, ["contractVersion", "access", "forgetId"]);
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.lifecycle,
	);
	const access = readAccessContext(
		requiredField(record, PATH, "access"),
		keyPath(PATH, "access"),
	);
	const forgetId = readIdentifier(
		requiredField(record, PATH, "forgetId"),
		keyPath(PATH, "forgetId"),
		71,
	);
	return deepFreeze({ contractVersion, access, forgetId });
}
