/**
 * Lifecycle 入力の parse。違反は MemoryContractError。
 * record / scope / host_source / state_item の形を検査する。所有権と閉包はrepositoryが検査する。
 */
import { deepFreeze } from "../../../canonical/freeze.ts";
import { readAccessContext } from "../../../contracts/parse-input.ts";
import {
	readContractVersionIn,
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
	readRecord,
	readSafeInteger,
	requiredField,
} from "../../../contracts/reader.ts";
import type { Rec } from "../../../contracts/reader.ts";
import { LIMITS } from "../../../contracts/constants.ts";
import {
	FORGET_TARGET_TYPES,
	JOURNAL_FORMAT,
	JOURNAL_FORMAT_HOST_INTENT,
	LIFECYCLE_CONTRACT_VERSIONS,
	LIMITS_LIFECYCLE,
} from "../contracts/index.ts";
import type {
	ApplyForgetInput,
	ForgetJournalEntry,
	ForgetJournalTarget,
	ForgetTarget,
	GetForgetReceiptInput,
	HostForgetIntent,
	LifecycleContractVersion,
	PlanForgetInput,
	ReconcileForgetJournalInput,
} from "../contracts/index.ts";
import { isRecordId } from "../../records/index.ts";
import { canonicalizeHostIntent } from "./journal.ts";

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

/** Lifecycle の全関数が受ける契約版（1・2）。 */
function readLifecycleContractVersion(record: Rec): LifecycleContractVersion {
	return readContractVersionIn(record, PATH, LIFECYCLE_CONTRACT_VERSIONS);
}

/** `planForget` の入力を、版によらず `targets` の配列と `hostIntent`（無ければ null）に揃えたもの。 */
export interface ParsedPlanForgetInput {
	readonly contractVersion: LifecycleContractVersion;
	readonly access: PlanForgetInput["access"];
	readonly targets: readonly ForgetTarget[];
	readonly hostIntent: HostForgetIntent | null;
	readonly clock: PlanForgetInput["clock"];
}

/**
 * `hostIntent` の形を検査して正規化する（各配列の整列・重複除去、空配列のキーの除去）。キーが残らなければ null。
 * キー・ID は識別子規則（非空・制御文字なし・lone surrogate なし）と bytes の上限、ID の総数（重複除去の前）の
 * 上限を守ること。`requireCanonical` なら、正規形でない入力（未整列・重複・空配列・キーなし）を INVALID_VALUE にする
 * （journal entry の読み取り用。hash はディスク上の表現そのものを覆うので、別の表現を受けない）。
 */
export function readHostIntent(
	value: unknown,
	path: string,
	requireCanonical = false,
): HostForgetIntent | null {
	const record = readRecord(value, path);
	const keys = Object.keys(record);
	if (keys.length > LIMITS_LIFECYCLE.maxHostIntentKeys) {
		return fail("ARRAY_TOO_LONG", path);
	}
	const copy: Record<string, readonly string[]> = Object.create(null);
	let total = 0;
	for (const key of keys) {
		readIdentifier(key, path, LIMITS_LIFECYCLE.maxHostIntentKeyBytes);
		const idsPath = keyPath(path, key);
		const ids = readArray(
			record[key],
			idsPath,
			LIMITS_LIFECYCLE.maxHostIntentIds,
		).map((element, index) =>
			readIdentifier(
				element,
				indexPath(idsPath, index),
				LIMITS_LIFECYCLE.maxHostIntentIdBytes,
			),
		);
		total += ids.length;
		if (total > LIMITS_LIFECYCLE.maxHostIntentIds) {
			return fail("ARRAY_TOO_LONG", idsPath);
		}
		copy[key] = ids;
	}
	const canonical = canonicalizeHostIntent(copy);
	if (
		requireCanonical &&
		(canonical === null ||
			Object.keys(canonical).length !== keys.length ||
			keys.some((key) => {
				const raw = copy[key] ?? [];
				const sorted = canonical[key] ?? [];
				return (
					raw.length !== sorted.length ||
					raw.some((id, index) => id !== sorted[index])
				);
			}))
	) {
		return fail("INVALID_VALUE", path);
	}
	return canonical;
}

export function parsePlanForgetInput(value: unknown): ParsedPlanForgetInput {
	const record = readRecord(value, PATH);
	const contractVersion = readLifecycleContractVersion(record);
	checkKeys(
		record,
		PATH,
		contractVersion === 1
			? ["contractVersion", "access", "target", "clock"]
			: [
					"contractVersion",
					"access",
					"target",
					"targets",
					"hostIntent",
					"clock",
				],
	);
	const access = readAccessContext(
		requiredField(record, PATH, "access"),
		keyPath(PATH, "access"),
	);
	let targets: ForgetTarget[];
	if (contractVersion === 1 || Object.hasOwn(record, "target")) {
		if (Object.hasOwn(record, "targets")) {
			return fail("INVALID_VALUE", keyPath(PATH, "targets"));
		}
		targets = [
			readForgetTarget(
				requiredField(record, PATH, "target"),
				keyPath(PATH, "target"),
			),
		];
	} else if (Object.hasOwn(record, "targets")) {
		const targetsPath = keyPath(PATH, "targets");
		targets = readArray(
			record["targets"],
			targetsPath,
			LIMITS_LIFECYCLE.maxJournalTargets,
		).map((element, index) =>
			readForgetTarget(element, indexPath(targetsPath, index)),
		);
		if (targets.length === 0) return fail("INVALID_VALUE", targetsPath);
		const scopeKey = targets[0]?.scopeKey;
		if (targets.some((target) => target.scopeKey !== scopeKey)) {
			return fail("INVALID_VALUE", targetsPath);
		}
	} else {
		targets = [];
	}
	const hostIntent = Object.hasOwn(record, "hostIntent")
		? readHostIntent(record["hostIntent"], keyPath(PATH, "hostIntent"))
		: null;
	if (targets.length === 0 && hostIntent === null) {
		return fail("INVALID_VALUE", keyPath(PATH, "hostIntent"));
	}
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	return deepFreeze({ contractVersion, access, targets, hostIntent, clock });
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
	const journalFormat = requiredField(record, path, "journalFormat");
	if (
		journalFormat !== JOURNAL_FORMAT &&
		journalFormat !== JOURNAL_FORMAT_HOST_INTENT
	) {
		return fail("UNSUPPORTED_SCHEMA_VERSION", keyPath(path, "journalFormat"));
	}
	const keys = [
		"journalFormat",
		"seq",
		"prevHash",
		"forgetId",
		"principal",
		"targets",
		"hash",
	];
	checkKeys(
		record,
		path,
		journalFormat === JOURNAL_FORMAT ? keys : [...keys, "hostIntent"],
	);
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
	const hostIntent =
		journalFormat === JOURNAL_FORMAT_HOST_INTENT &&
		Object.hasOwn(record, "hostIntent")
			? readHostIntent(record["hostIntent"], keyPath(path, "hostIntent"), true)
			: null;
	if (targets.length === 0 && hostIntent === null) {
		return fail("INVALID_VALUE", targetsPath);
	}
	const hash = readHex64(
		requiredField(record, path, "hash"),
		keyPath(path, "hash"),
	);
	return {
		journalFormat,
		seq,
		prevHash,
		forgetId,
		principal,
		targets,
		...(hostIntent !== null ? { hostIntent } : {}),
		hash,
	};
}

export function parseApplyForgetInput(value: unknown): ApplyForgetInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, ["contractVersion", "entry", "clock"]);
	const contractVersion = readLifecycleContractVersion(record);
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
	const contractVersion = readLifecycleContractVersion(record);
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
	const contractVersion = readLifecycleContractVersion(record);
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
