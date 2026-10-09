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
	ReadRecordRangeInput,
	RecordSourceStatesInput,
	RecordStatusChangeInput,
} from "../contracts/index.ts";
import { CONTRACT_VERSIONS } from "../../../contracts/versions.ts";
import {
	readAccessContext,
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
	readBoolean,
	readEnum,
	readIdentifier,
	readNameToken,
	readRecord,
	readSafeInteger,
	readText,
	requiredField,
	type Rec,
} from "../../../contracts/reader.ts";
import { LIMITS } from "../../../contracts/constants.ts";
import type { ByteRange } from "../../../contracts/types.ts";
import type { RunRef } from "../../../contracts/common.ts";
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

function readRunRef(value: unknown, path: string): RunRef {
	const record = readRecord(value, path);
	checkKeys(record, path, ["jobId", "attempt"]);
	return {
		jobId: readIdentifier(
			requiredField(record, path, "jobId"),
			keyPath(path, "jobId"),
			256,
		),
		attempt: readSafeInteger(
			requiredField(record, path, "attempt"),
			keyPath(path, "attempt"),
			0,
			Number.MAX_SAFE_INTEGER,
		),
	};
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
		"runRef",
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
	// NUL を含む本文は検索（LIKE / FTS）の結果を戦略間で一致させられないので受けない。
	if (content.includes("\u0000")) return fail("INVALID_STRING", contentPath);
	const captureState = readEnum(
		requiredField(record, PATH, "captureState"),
		keyPath(PATH, "captureState"),
		RECORD_CAPTURE_STATES,
	);
	const runRef = Object.hasOwn(record, "runRef")
		? readRunRef(record["runRef"], keyPath(PATH, "runRef"))
		: undefined;
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
		...(runRef === undefined ? {} : { runRef }),
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

function readByteRange(value: unknown, path: string): ByteRange {
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

export function parseReadRecordRangeInput(
	value: unknown,
): ReadRecordRangeInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"recordId",
		"revision",
		"range",
	]);
	const header = readHeader(record);
	const recordId = readRecordId(
		requiredField(record, PATH, "recordId"),
		keyPath(PATH, "recordId"),
	);
	const revision = readIdentifier(
		requiredField(record, PATH, "revision"),
		keyPath(PATH, "revision"),
		LIMITS.maxRevisionBytes,
	);
	const range = readByteRange(
		requiredField(record, PATH, "range"),
		keyPath(PATH, "range"),
	);
	return deepFreeze({ ...header, recordId, revision, range });
}

export function parseRecordSourceStatesInput(
	value: unknown,
): RecordSourceStatesInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"refs",
		"withContent",
	]);
	const header = readHeader(record);
	const refsPath = keyPath(PATH, "refs");
	const refs = readArray(
		requiredField(record, PATH, "refs"),
		refsPath,
		LIMITS_RECORDS.maxSourceStateRefs,
	).map((element, index) => {
		const path = indexPath(refsPath, index);
		const ref = readSourceRef(element, path);
		if (ref.namespace !== "memory" || ref.kind !== "record") {
			return fail("INVALID_VALUE", path);
		}
		return ref;
	});
	const withContent = Object.hasOwn(record, "withContent")
		? readBoolean(record["withContent"], keyPath(PATH, "withContent"))
		: undefined;
	return deepFreeze({
		...header,
		refs,
		...(withContent === undefined ? {} : { withContent }),
	});
}

export function parseRecordStatusChangeInput(
	value: unknown,
): RecordStatusChangeInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		"contractVersion",
		"access",
		"scopeKey",
		"clock",
		"recordId",
	]);
	const header = readHeader(record);
	const clock = readHostClock(
		requiredField(record, PATH, "clock"),
		keyPath(PATH, "clock"),
	);
	const recordId = readRecordId(
		requiredField(record, PATH, "recordId"),
		keyPath(PATH, "recordId"),
	);
	return deepFreeze({ ...header, clock, recordId });
}
