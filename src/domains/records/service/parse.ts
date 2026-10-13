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
	readText,
	requiredField,
	type Rec,
} from "../../../contracts/reader.ts";
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
