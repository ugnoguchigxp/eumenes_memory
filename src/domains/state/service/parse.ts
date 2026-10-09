/**
 * State 永続 API の入力 parse（純粋）。違反は MemoryContractError（code と path のみ）。
 * 検査済みのコピーを deep-freeze して返す。意味の検査（subject と kind の同値、quote の一致、CAS）は
 * ここではなく reducer / evidence が `rejected` で返す。
 */
import { deepFreeze } from "../../../canonical/freeze.ts";
import { LIMITS } from "../../../contracts/constants.ts";
import type { EvidenceSpan } from "../../../contracts/common.ts";
import { POLARITIES } from "../../../contracts/common.ts";
import type { StateSubject } from "../../../contracts/common.ts";
import {
	readAccessContext,
	readSourceCore,
	readSourceRef,
} from "../../../contracts/parse-input.ts";
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
	readRecord,
	readSafeInteger,
	readText,
	requiredField,
} from "../../../contracts/reader.ts";
import type { Rec } from "../../../contracts/reader.ts";
import { ownValue } from "../../../contracts/own.ts";
import { sourceKey } from "../../../contracts/source-key.ts";
import {
	LIMITS_STATE,
	STATE_KINDS,
	USER_STATE_ORIGINS,
} from "../contracts/index.ts";
import type {
	AssertUserStateInput,
	EditStateInput,
	HostSourceState,
	ListStateInput,
	ListStateScopesInput,
	ReadMemorySnapshotPartInput,
	StateTargetInput,
	StateValue,
} from "../contracts/index.ts";
import { CONTRACT_VERSIONS } from "../../../contracts/versions.ts";
import {
	DATE_PRECISIONS,
	VALIDITY_BASES,
	assertPartialDate,
	periodBoundsMs,
} from "../../temporal/index.ts";
import type { PartialDate, ValidityPeriod } from "../../temporal/index.ts";
import { utf8ByteLength } from "../../../canonical/utf8.ts";

const SCOPED_WRITE_KEYS = ["contractVersion", "access", "scopeKey", "clock"];
const SCOPED_READ_KEYS = ["contractVersion", "access", "scopeKey"];

function readScopedHeader(record: Rec, path: string) {
	const contractVersion = readContractVersion(
		record,
		path,
		CONTRACT_VERSIONS.state,
	);
	const access = readAccessContext(
		requiredField(record, path, "access"),
		keyPath(path, "access"),
	);
	const scopeKey = readScopeKey(
		requiredField(record, path, "scopeKey"),
		keyPath(path, "scopeKey"),
	);
	return { contractVersion, access, scopeKey };
}

function readWriteHeader(record: Rec, path: string) {
	return {
		...readScopedHeader(record, path),
		clock: readHostClock(
			requiredField(record, path, "clock"),
			keyPath(path, "clock"),
		),
	};
}

export function readStateSubject(value: unknown, path: string): StateSubject {
	const text = readIdentifier(value, path, LIMITS_STATE.maxSubjectBytes);
	if (text === "self") return "self";
	if (text.startsWith("other:") && text.length > "other:".length) {
		return text as StateSubject;
	}
	return fail("INVALID_VALUE", path);
}

export function readStateValue(value: unknown, path: string): StateValue {
	const record = readRecord(value, path);
	checkKeys(record, path, ["text", "polarity", "attributes"]);
	const text = readText(
		requiredField(record, path, "text"),
		keyPath(path, "text"),
		LIMITS_STATE.maxValueTextBytes,
		false,
	);
	const polarity = readEnum(
		requiredField(record, path, "polarity"),
		keyPath(path, "polarity"),
		POLARITIES,
	);
	if (!Object.hasOwn(record, "attributes")) return { text, polarity };
	const attributesPath = keyPath(path, "attributes");
	const raw = readRecord(record["attributes"], attributesPath);
	const keys = Object.keys(raw);
	if (keys.length > LIMITS_STATE.maxAttributes) {
		return fail("ARRAY_TOO_LONG", attributesPath);
	}
	const attributes: Record<string, string> = Object.create(null);
	for (const key of keys.sort()) {
		readIdentifier(key, attributesPath, LIMITS_STATE.maxAttributeKeyBytes);
		attributes[key] = readText(
			raw[key],
			attributesPath,
			LIMITS_STATE.maxAttributeValueBytes,
			true,
		);
	}
	return { text, polarity, attributes };
}

function readEvidence(value: unknown, path: string): readonly EvidenceSpan[] {
	const items = readArray(value, path, LIMITS_STATE.maxEvidencePerItem);
	if (items.length === 0) return fail("INVALID_VALUE", path);
	const spans: EvidenceSpan[] = [];
	const seen = new Set<string>();
	const revisions = new Map<string, string>();
	for (const [index, element] of items.entries()) {
		const elementPath = indexPath(path, index);
		const record = readRecord(element, elementPath);
		checkKeys(record, elementPath, ["source", "quote"]);
		const sourcePath = keyPath(elementPath, "source");
		const source = readSourceRef(
			requiredField(record, elementPath, "source"),
			sourcePath,
		);
		const range = ownValue(source, "range");
		if (range === undefined) {
			return fail("MISSING_KEY", keyPath(sourcePath, "range"));
		}
		const quote = readText(
			requiredField(record, elementPath, "quote"),
			keyPath(elementPath, "quote"),
			LIMITS_STATE.maxQuoteBytes,
			false,
		);
		const key = sourceKey(source);
		const identity = `${key}|${source.revision}|${source.digest}|${range.startByte}|${range.endByte}`;
		if (seen.has(identity)) return fail("DUPLICATE_DEPENDENCY", elementPath);
		seen.add(identity);
		const version = `${source.revision}|${source.digest}`;
		const known = revisions.get(key);
		if (known !== undefined && known !== version) {
			return fail("CONFLICTING_DEPENDENCY", elementPath);
		}
		revisions.set(key, version);
		spans.push({ source, quote });
	}
	return spans;
}

function readHostSources(
	value: unknown,
	path: string,
): readonly HostSourceState[] {
	const items = readArray(value, path, LIMITS_STATE.maxSources);
	const sources: HostSourceState[] = [];
	const seen = new Set<string>();
	let total = 0;
	for (const [index, element] of items.entries()) {
		const elementPath = indexPath(path, index);
		const record = readRecord(element, elementPath);
		checkKeys(record, elementPath, [
			"namespace",
			"kind",
			"id",
			"representation",
			"revision",
			"digest",
			"principal",
			"scopeKey",
			"status",
			"content",
			"ordinal",
		]);
		const core = readSourceCore(record, elementPath);
		const principal = readIdentifier(
			requiredField(record, elementPath, "principal"),
			keyPath(elementPath, "principal"),
			LIMITS.maxPrincipalBytes,
		);
		const scopeKey = readScopeKey(
			requiredField(record, elementPath, "scopeKey"),
			keyPath(elementPath, "scopeKey"),
		);
		const status = readEnum(
			requiredField(record, elementPath, "status"),
			keyPath(elementPath, "status"),
			["available", "missing", "changed", "forgotten"] as const,
		);
		const content = readText(
			requiredField(record, elementPath, "content"),
			keyPath(elementPath, "content"),
			LIMITS.maxSourceContentBytes,
			true,
		);
		total += utf8ByteLength(content);
		if (total > LIMITS.maxTotalSourceContentBytes) {
			return fail("TOTAL_CONTENT_TOO_LARGE", path);
		}
		const ordinal = readSafeInteger(
			requiredField(record, elementPath, "ordinal"),
			keyPath(elementPath, "ordinal"),
			0,
			Number.MAX_SAFE_INTEGER,
		);
		const key = sourceKey(core);
		if (seen.has(key)) return fail("DUPLICATE_SOURCE", elementPath);
		seen.add(key);
		sources.push({ ...core, principal, scopeKey, status, content, ordinal });
	}
	return sources;
}

function readOrigin(record: Rec, path: string) {
	return readEnum(
		requiredField(record, path, "origin"),
		keyPath(path, "origin"),
		USER_STATE_ORIGINS,
	);
}

function readRevision(value: unknown, path: string): number {
	return readSafeInteger(value, path, 1, Number.MAX_SAFE_INTEGER);
}

export function parseAssertUserStateInput(
	value: unknown,
): AssertUserStateInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		...SCOPED_WRITE_KEYS,
		"kind",
		"subject",
		"semanticKey",
		"value",
		"evidence",
		"sources",
		"origin",
		"validFromMs",
		"validUntilMs",
		"validity",
		"replaces",
	]);
	const header = readWriteHeader(record, path);
	const kind = readEnum(
		requiredField(record, path, "kind"),
		keyPath(path, "kind"),
		STATE_KINDS,
	);
	const subject = readStateSubject(
		requiredField(record, path, "subject"),
		keyPath(path, "subject"),
	);
	const semanticKey = readIdentifier(
		requiredField(record, path, "semanticKey"),
		keyPath(path, "semanticKey"),
		LIMITS_STATE.maxSemanticKeyBytes,
	);
	const stateValue = readStateValue(
		requiredField(record, path, "value"),
		keyPath(path, "value"),
	);
	const evidence = readEvidence(
		requiredField(record, path, "evidence"),
		keyPath(path, "evidence"),
	);
	const sources = readHostSources(
		requiredField(record, path, "sources"),
		keyPath(path, "sources"),
	);
	const origin = readOrigin(record, path);
	const validity = Object.hasOwn(record, "validity")
		? readValidity(record["validity"], keyPath(path, "validity"))
		: undefined;
	if (
		validity !== undefined &&
		(Object.hasOwn(record, "validFromMs") ||
			Object.hasOwn(record, "validUntilMs"))
	) {
		return fail("INVALID_VALUE", keyPath(path, "validity"));
	}
	const validFromMs = Object.hasOwn(record, "validFromMs")
		? readSafeInteger(
				record["validFromMs"],
				keyPath(path, "validFromMs"),
				0,
				Number.MAX_SAFE_INTEGER,
			)
		: undefined;
	const validUntilMs = Object.hasOwn(record, "validUntilMs")
		? readSafeInteger(
				record["validUntilMs"],
				keyPath(path, "validUntilMs"),
				0,
				Number.MAX_SAFE_INTEGER,
			)
		: undefined;
	if (
		validFromMs !== undefined &&
		validUntilMs !== undefined &&
		validUntilMs <= validFromMs
	) {
		return fail("INVALID_VALUE", keyPath(path, "validUntilMs"));
	}
	let replaces: AssertUserStateInput["replaces"];
	if (Object.hasOwn(record, "replaces")) {
		const replacesPath = keyPath(path, "replaces");
		const raw = readRecord(record["replaces"], replacesPath);
		checkKeys(raw, replacesPath, ["itemId", "revision"]);
		replaces = {
			itemId: readIdentifier(
				requiredField(raw, replacesPath, "itemId"),
				keyPath(replacesPath, "itemId"),
				LIMITS.maxItemIdBytes,
			),
			revision: readRevision(
				requiredField(raw, replacesPath, "revision"),
				keyPath(replacesPath, "revision"),
			),
		};
	}
	return deepFreeze({
		...header,
		kind,
		subject,
		semanticKey,
		value: stateValue,
		evidence,
		sources,
		origin,
		...(validFromMs === undefined ? {} : { validFromMs }),
		...(validUntilMs === undefined ? {} : { validUntilMs }),
		...(validity === undefined ? {} : { validity }),
		...(replaces === undefined ? {} : { replaces }),
	});
}

/** 精度つきの成立期間。暦として成立しない日付・逆転した期間は INVALID_VALUE。 */
function readValidity(value: unknown, path: string): ValidityPeriod {
	const record = readRecord(value, path);
	checkKeys(record, path, ["from", "until", "basis"]);
	const readDate = (raw: unknown, datePath: string): PartialDate => {
		const dateRecord = readRecord(raw, datePath);
		checkKeys(dateRecord, datePath, ["precision", "year", "month", "day"]);
		const date: PartialDate = {
			precision: readEnum(
				requiredField(dateRecord, datePath, "precision"),
				keyPath(datePath, "precision"),
				DATE_PRECISIONS,
			),
			year: readSafeInteger(
				requiredField(dateRecord, datePath, "year"),
				keyPath(datePath, "year"),
				0,
				9999,
			),
			...(Object.hasOwn(dateRecord, "month")
				? {
						month: readSafeInteger(
							dateRecord["month"],
							keyPath(datePath, "month"),
							0,
							99,
						),
					}
				: {}),
			...(Object.hasOwn(dateRecord, "day")
				? {
						day: readSafeInteger(
							dateRecord["day"],
							keyPath(datePath, "day"),
							0,
							99,
						),
					}
				: {}),
		};
		try {
			assertPartialDate(date);
		} catch {
			return fail("INVALID_VALUE", datePath);
		}
		return date;
	};
	const period: ValidityPeriod = {
		...(Object.hasOwn(record, "from")
			? { from: readDate(record["from"], keyPath(path, "from")) }
			: {}),
		...(Object.hasOwn(record, "until")
			? { until: readDate(record["until"], keyPath(path, "until")) }
			: {}),
		basis: readEnum(
			requiredField(record, path, "basis"),
			keyPath(path, "basis"),
			VALIDITY_BASES,
		),
	};
	try {
		periodBoundsMs(period);
	} catch {
		return fail("INVALID_VALUE", path);
	}
	return deepFreeze(period);
}

export function parseEditStateInput(value: unknown): EditStateInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		...SCOPED_WRITE_KEYS,
		"itemId",
		"expectedRevision",
		"value",
		"evidence",
		"sources",
		"origin",
	]);
	const header = readWriteHeader(record, path);
	return deepFreeze({
		...header,
		itemId: readIdentifier(
			requiredField(record, path, "itemId"),
			keyPath(path, "itemId"),
			LIMITS.maxItemIdBytes,
		),
		expectedRevision: readRevision(
			requiredField(record, path, "expectedRevision"),
			keyPath(path, "expectedRevision"),
		),
		value: readStateValue(
			requiredField(record, path, "value"),
			keyPath(path, "value"),
		),
		evidence: readEvidence(
			requiredField(record, path, "evidence"),
			keyPath(path, "evidence"),
		),
		sources: readHostSources(
			requiredField(record, path, "sources"),
			keyPath(path, "sources"),
		),
		origin: readOrigin(record, path),
	});
}

/** deactivate / reactivate / retract 共通。 */
export function parseStateTargetInput(value: unknown): StateTargetInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [...SCOPED_WRITE_KEYS, "itemId", "expectedRevision"]);
	return deepFreeze({
		...readWriteHeader(record, path),
		itemId: readIdentifier(
			requiredField(record, path, "itemId"),
			keyPath(path, "itemId"),
			LIMITS.maxItemIdBytes,
		),
		expectedRevision: readRevision(
			requiredField(record, path, "expectedRevision"),
			keyPath(path, "expectedRevision"),
		),
	});
}

export function parseListStateInput(value: unknown): ListStateInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		...SCOPED_READ_KEYS,
		"kinds",
		"includeInactive",
		"limit",
	]);
	const header = readScopedHeader(record, path);
	let kinds: ListStateInput["kinds"];
	if (Object.hasOwn(record, "kinds")) {
		const kindsPath = keyPath(path, "kinds");
		const parsed = readArray(
			record["kinds"],
			kindsPath,
			STATE_KINDS.length,
		).map((element, index) =>
			readEnum(element, indexPath(kindsPath, index), STATE_KINDS),
		);
		if (new Set(parsed).size !== parsed.length) {
			return fail("INVALID_VALUE", kindsPath);
		}
		kinds = parsed;
	}
	let includeInactive: boolean | undefined;
	if (Object.hasOwn(record, "includeInactive")) {
		const flag = record["includeInactive"];
		if (typeof flag !== "boolean") {
			return fail("INVALID_TYPE", keyPath(path, "includeInactive"));
		}
		includeInactive = flag;
	}
	const limit = Object.hasOwn(record, "limit")
		? readSafeInteger(
				record["limit"],
				keyPath(path, "limit"),
				1,
				LIMITS_STATE.maxListItems,
			)
		: undefined;
	return deepFreeze({
		...header,
		...(kinds === undefined ? {} : { kinds }),
		...(includeInactive === undefined ? {} : { includeInactive }),
		...(limit === undefined ? {} : { limit }),
	});
}

export function parseReadSnapshotPartInput(
	value: unknown,
): ReadMemorySnapshotPartInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, SCOPED_READ_KEYS);
	return deepFreeze(readScopedHeader(record, path));
}

export function parseListStateScopesInput(
	value: unknown,
): ListStateScopesInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		"contractVersion",
		"access",
		"scopeKeys",
		"includeInactive",
	]);
	const scopeKeys = readArray(
		requiredField(record, path, "scopeKeys"),
		keyPath(path, "scopeKeys"),
		LIMITS_STATE.maxScopesPerRead,
	).map((element, index) =>
		readScopeKey(element, indexPath(keyPath(path, "scopeKeys"), index)),
	);
	if (scopeKeys.length === 0 || new Set(scopeKeys).size !== scopeKeys.length) {
		return fail("INVALID_VALUE", keyPath(path, "scopeKeys"));
	}
	// 各 scope は単一 scope の parse を通し、header（版・access）の検査を共有する。
	const flag = Object.hasOwn(record, "includeInactive")
		? record["includeInactive"]
		: undefined;
	if (flag !== undefined && typeof flag !== "boolean") {
		return fail("INVALID_TYPE", keyPath(path, "includeInactive"));
	}
	const first = parseListStateInput({
		contractVersion: record["contractVersion"],
		access: record["access"],
		scopeKey: scopeKeys[0],
	});
	return deepFreeze({
		contractVersion: first.contractVersion,
		access: first.access,
		scopeKeys,
		...(flag === undefined ? {} : { includeInactive: flag }),
	});
}
