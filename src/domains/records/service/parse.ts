/**
 * Records 入力の parse（parse-don't-validate）。違反は MemoryContractError（code と path のみ）。
 * 検査済みの deep-frozen なコピーを返す。
 */
import { deepFreeze } from "../../../canonical/freeze.ts";
import {
	LIMITS_RECORDS,
	RECORD_CAPTURE_STATES,
	RECORD_MEDIA_TYPES,
} from "../contracts/index.ts";
import type {
	CaptureRecordInput,
	ReadRecordInput,
} from "../contracts/index.ts";
import type {
	EvictRetainedInput,
	RetainRecordInput,
	RetainedRecordRead,
	RetainedRecordUse,
} from "../contracts/retention.ts";
import { CONTRACT_VERSIONS } from "../../../contracts/versions.ts";
import { readAccessContext } from "../../../contracts/parse-input.ts";
import {
	readContractVersion,
	readHostClock,
	readScopeKey,
} from "../../../contracts/parse-store.ts";
import {
	checkKeys,
	fail,
	keyPath,
	readEnum,
	readIdentifier,
	readNameToken,
	readRecord,
	readSafeInteger,
	readText,
	requiredField,
	type Rec,
} from "../../../contracts/reader.ts";
import { ownValue } from "../../../contracts/own.ts";
import { LIMITS } from "../../../contracts/constants.ts";

import { isRecordId } from "./identity.ts";

const PATH = "$";

function readRecordId(value: unknown, path: string): string {
	const text = readIdentifier(value, path, 68);
	if (!isRecordId(text)) return fail("INVALID_ID_FORMAT", path);
	return text;
}

function readHeader(record: Rec) {
	const contractVersion = readContractVersion(
		record,
		PATH,
		CONTRACT_VERSIONS.records,
	);
	const access = readAccessContext(
		requiredField(record, PATH, "access"),
		keyPath(PATH, "access"),
	);
	const scopeKey = readScopeKey(
		requiredField(record, PATH, "scopeKey"),
		keyPath(PATH, "scopeKey"),
	);
	return { contractVersion, access, scopeKey };
}

export function parseCaptureRecordInput(value: unknown): CaptureRecordInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"clock",
		"origin",
		"mediaType",
		"content",
		"captureState",
		"providerRef",
	]);
	const header = readHeader(record);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	const originPath = keyPath(PATH, "origin");
	const origin = readRecord(requiredField(record, PATH, "origin"), originPath);
	checkKeys(origin, originPath, ["namespace", "kind", "id"]);
	const parsedOrigin = {
		namespace: readIdentifier(
			requiredField(origin, originPath, "namespace"),
			keyPath(originPath, "namespace"),
			LIMITS_RECORDS.maxOriginNamespaceBytes,
		),
		kind: readIdentifier(
			requiredField(origin, originPath, "kind"),
			keyPath(originPath, "kind"),
			LIMITS_RECORDS.maxOriginKindBytes,
		),
		id: readIdentifier(
			requiredField(origin, originPath, "id"),
			keyPath(originPath, "id"),
			LIMITS_RECORDS.maxOriginIdBytes,
		),
	};
	const mediaType = readEnum(
		requiredField(record, PATH, "mediaType"),
		keyPath(PATH, "mediaType"),
		RECORD_MEDIA_TYPES,
	);
	const contentPath = keyPath(PATH, "content");
	const content = readText(
		requiredField(record, PATH, "content"),
		contentPath,
		LIMITS_RECORDS.maxContentBytes,
		true,
	);
	// NUL を含む本文は受けない。
	if (content.includes("\u0000")) return fail("INVALID_STRING", contentPath);
	const captureState = readEnum(
		requiredField(record, PATH, "captureState"),
		keyPath(PATH, "captureState"),
		RECORD_CAPTURE_STATES,
	);
	const providerRef = Object.hasOwn(record, "providerRef")
		? readNameToken(
				record["providerRef"],
				keyPath(PATH, "providerRef"),
				LIMITS_RECORDS.maxProviderRefBytes,
			)
		: undefined;
	return deepFreeze({
		...header,
		clock,
		origin: parsedOrigin,
		mediaType,
		content,
		captureState,
		...(providerRef === undefined ? {} : { providerRef }),
	});
}

export function parseReadRecordInput(value: unknown): ReadRecordInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"recordId",
		"revision",
	]);
	const header = readHeader(record);
	const recordId = readRecordId(
		requiredField(record, PATH, "recordId"),
		keyPath(PATH, "recordId"),
	);
	const revision = Object.hasOwn(record, "revision")
		? readIdentifier(
				record["revision"],
				keyPath(PATH, "revision"),
				LIMITS.maxRevisionBytes,
			)
		: undefined;
	return deepFreeze({
		...header,
		recordId,
		...(revision === undefined ? {} : { revision }),
	});
}

/** 既に検査した header に対し、渡された recordId だけを読み取りと同じ順で検査する。 */
function readSuppliedRecordId(
	header: {
		readonly contractVersion: ReadRecordInput["contractVersion"];
		readonly access: ReadRecordInput["access"];
		readonly scopeKey: ReadRecordInput["scopeKey"];
	},
	recordId: unknown,
): string {
	return parseReadRecordInput({
		contractVersion: header.contractVersion,
		access: header.access,
		scopeKey: header.scopeKey,
		recordId,
	}).recordId;
}

/**
 * 再生成可能な資料の保持登録。検査順は、キー、capture 入力、freshUntilMs、idleTtlMs、
 * 加算の安全性と provider / captureState。
 */
export function parseRetainRecordInput(value: unknown): RetainRecordInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, ["record", "freshUntilMs", "idleTtlMs"]);
	const captured = parseCaptureRecordInput(
		requiredField(record, PATH, "record"),
	);
	const freshUntilMs = readSafeInteger(
		requiredField(record, PATH, "freshUntilMs"),
		"$.freshUntilMs",
		captured.clock.atMs,
		Number.MAX_SAFE_INTEGER,
	);
	const idleTtlMs = readSafeInteger(
		requiredField(record, PATH, "idleTtlMs"),
		"$.idleTtlMs",
		1,
		365 * 86400000,
	);
	if (
		!Number.isSafeInteger(captured.clock.atMs + idleTtlMs) ||
		ownValue(captured, "providerRef") !== undefined ||
		captured.captureState !== "complete"
	) {
		return fail("INVALID_VALUE", "$.record");
	}
	return deepFreeze({
		record: captured,
		freshUntilMs,
		idleTtlMs,
	});
}

/** 保持中の資料の読み取り。clock は recordId の後に検査する。 */
export function parseRetainedRecordRead(value: unknown): RetainedRecordRead {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"clock",
		"recordId",
	]);
	const parsed = parseReadRecordInput({
		contractVersion: requiredField(record, PATH, "contractVersion"),
		access: requiredField(record, PATH, "access"),
		scopeKey: requiredField(record, PATH, "scopeKey"),
		recordId: requiredField(record, PATH, "recordId"),
	});
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	return deepFreeze({ ...parsed, clock });
}

/** scope 内の件数。recordId は受けない。 */
export function parseRetainedRecordStatsInput(
	value: unknown,
): Omit<RetainedRecordRead, "recordId"> {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, ["contractVersion", "access", "scopeKey", "clock"]);
	const header = readHeader(record);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	return deepFreeze({ ...header, clock });
}

/** 採用。retentionRevision は clock の後に検査する。 */
export function parseRetainedRecordUse(value: unknown): RetainedRecordUse {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"clock",
		"recordId",
		"retentionRevision",
	]);
	const parsed = parseReadRecordInput({
		contractVersion: requiredField(record, PATH, "contractVersion"),
		access: requiredField(record, PATH, "access"),
		scopeKey: requiredField(record, PATH, "scopeKey"),
		recordId: requiredField(record, PATH, "recordId"),
	});
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	const retentionRevision = readSafeInteger(
		requiredField(record, PATH, "retentionRevision"),
		"$.retentionRevision",
		1,
		Number.MAX_SAFE_INTEGER,
	);
	return deepFreeze({ ...parsed, clock, retentionRevision });
}

export interface ParsedEvictRetainedRecords {
	readonly contractVersion: EvictRetainedInput["contractVersion"];
	readonly access: EvictRetainedInput["access"];
	readonly scopeKey: EvictRetainedInput["scopeKey"];
	readonly clock: EvictRetainedInput["clock"];
	readonly limit: number;
	readonly oldest: boolean;
	readonly recordId: string | null;
}

/**
 * 失効。検査順は header、clock、limit、recordId、oldest。
 * recordId と oldest は無くてよい。
 */
export function parseEvictRetainedRecordsInput(
	value: unknown,
): ParsedEvictRetainedRecords {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"clock",
		"limit",
		"oldest",
		"recordId",
	]);
	const header = readHeader(record);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	const limit = readSafeInteger(
		requiredField(record, PATH, "limit"),
		"$.limit",
		1,
		100,
	);
	const recordId =
		record["recordId"] === undefined
			? null
			: readSuppliedRecordId(header, record["recordId"]);
	if (record["oldest"] !== undefined && typeof record["oldest"] !== "boolean") {
		return fail("INVALID_VALUE", "$.oldest");
	}
	return deepFreeze({
		...header,
		clock,
		limit,
		oldest: record["oldest"] === true,
		recordId,
	});
}
