/**
 * 記憶の作り直しの部品（時間軸の照会・抑制・記憶の候補）の入力 parse（純粋）。
 * 違反は MemoryContractError（code と path のみ）。検査済みのコピーを deep-freeze して返す。
 */
import { deepFreeze } from "../../../canonical/freeze.ts";
import { LIMITS } from "../../../contracts/constants.ts";
import { readSourceRunId } from "../../../contracts/parse-store.ts";
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
import {
	CANDIDATE_STATUSES,
	LIMITS_CANDIDATE,
	LIMITS_STATE,
	STATE_KINDS,
} from "../contracts/index.ts";
import type {
	ListCandidatesInput,
	ListStateByTimeInput,
	ListSuppressionsInput,
	ReadCandidateInput,
	RecordCandidateInput,
	StateMarkTarget,
	SuppressStateInput,
} from "../contracts/index.ts";
import {
	readEvidence,
	readHostSources,
	readScopedHeader,
	readStateSubject,
	readStateValue,
	readWriteHeader,
} from "./parse.ts";
import { isSubjectKindConsistent } from "./reducer.ts";

const SCOPED_WRITE_KEYS = ["contractVersion", "access", "scopeKey", "clock"];
const SCOPED_READ_KEYS = ["contractVersion", "access", "scopeKey"];
const PATH = "$";

function readKinds(record: Rec, path: string) {
	if (!Object.hasOwn(record, "kinds")) return undefined;
	const kindsPath = keyPath(path, "kinds");
	const parsed = readArray(record["kinds"], kindsPath, STATE_KINDS.length).map(
		(element, index) =>
			readEnum(element, indexPath(kindsPath, index), STATE_KINDS),
	);
	if (parsed.length === 0 || new Set(parsed).size !== parsed.length) {
		return fail("INVALID_VALUE", kindsPath);
	}
	return parsed;
}

function readOptionalRunId(record: Rec, path: string): string | undefined {
	return Object.hasOwn(record, "sourceRunId")
		? readSourceRunId(record["sourceRunId"], keyPath(path, "sourceRunId"))
		: undefined;
}

function readOptionalLimit(
	record: Rec,
	path: string,
	max: number,
): number | undefined {
	return Object.hasOwn(record, "limit")
		? readSafeInteger(record["limit"], keyPath(path, "limit"), 1, max)
		: undefined;
}

function readTimeMs(value: unknown, path: string): number {
	return readSafeInteger(value, path, 0, Number.MAX_SAFE_INTEGER);
}

export function parseListStateByTimeInput(
	value: unknown,
): ListStateByTimeInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		...SCOPED_READ_KEYS,
		"kinds",
		"current",
		"recordedAt",
		"validAt",
		"limit",
		"after",
	]);
	const header = readScopedHeader(record, PATH);
	const kinds = readKinds(record, PATH);
	let current: boolean | undefined;
	if (Object.hasOwn(record, "current")) {
		if (typeof record["current"] !== "boolean") {
			return fail("INVALID_TYPE", keyPath(PATH, "current"));
		}
		current = record["current"];
	}
	const recordedAt = Object.hasOwn(record, "recordedAt")
		? readTimeMs(record["recordedAt"], keyPath(PATH, "recordedAt"))
		: undefined;
	const validAt = Object.hasOwn(record, "validAt")
		? readTimeMs(record["validAt"], keyPath(PATH, "validAt"))
		: undefined;
	const limit = readOptionalLimit(record, PATH, LIMITS_STATE.maxListItems);
	let after: ListStateByTimeInput["after"];
	if (Object.hasOwn(record, "after")) {
		const cursorPath = keyPath(PATH, "after");
		const cursor = readRecord(record["after"], cursorPath);
		checkKeys(cursor, cursorPath, ["createdSeq", "itemId"]);
		after = {
			createdSeq: readSafeInteger(
				requiredField(cursor, cursorPath, "createdSeq"),
				keyPath(cursorPath, "createdSeq"),
				1,
				Number.MAX_SAFE_INTEGER,
			),
			itemId: readIdentifier(
				requiredField(cursor, cursorPath, "itemId"),
				keyPath(cursorPath, "itemId"),
				LIMITS.maxItemIdBytes,
			),
		};
	}
	return deepFreeze({
		...header,
		...(kinds === undefined ? {} : { kinds }),
		...(current === undefined ? {} : { current }),
		...(recordedAt === undefined ? {} : { recordedAt }),
		...(validAt === undefined ? {} : { validAt }),
		...(limit === undefined ? {} : { limit }),
		...(after === undefined ? {} : { after }),
	});
}

function readMarkTarget(value: unknown, path: string): StateMarkTarget {
	const record = readRecord(value, path);
	const type = readEnum(
		requiredField(record, path, "type"),
		keyPath(path, "type"),
		["state_item", "state_fact"] as const,
	);
	if (type === "state_item") {
		checkKeys(record, path, ["type", "itemId"]);
		return {
			type,
			itemId: readIdentifier(
				requiredField(record, path, "itemId"),
				keyPath(path, "itemId"),
				LIMITS.maxItemIdBytes,
			),
		};
	}
	checkKeys(record, path, ["type", "subject", "kind", "semanticKey"]);
	const subject = readStateSubject(
		requiredField(record, path, "subject"),
		keyPath(path, "subject"),
	);
	const kind = readEnum(
		requiredField(record, path, "kind"),
		keyPath(path, "kind"),
		STATE_KINDS,
	);
	if (!isSubjectKindConsistent(subject, kind)) {
		return fail("INVALID_VALUE", path);
	}
	return {
		type,
		subject,
		kind,
		semanticKey: readIdentifier(
			requiredField(record, path, "semanticKey"),
			keyPath(path, "semanticKey"),
			LIMITS_STATE.maxSemanticKeyBytes,
		),
	};
}

export function parseSuppressStateInput(value: unknown): SuppressStateInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [...SCOPED_WRITE_KEYS, "target", "sourceRunId"]);
	const sourceRunId = readOptionalRunId(record, PATH);
	return deepFreeze({
		...readWriteHeader(record, PATH),
		target: readMarkTarget(
			requiredField(record, PATH, "target"),
			keyPath(PATH, "target"),
		),
		...(sourceRunId === undefined ? {} : { sourceRunId }),
	});
}

export function parseListSuppressionsInput(
	value: unknown,
): ListSuppressionsInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, SCOPED_READ_KEYS);
	return deepFreeze({ ...readScopedHeader(record, PATH) });
}

export function parseRecordCandidateInput(
	value: unknown,
): RecordCandidateInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		...SCOPED_WRITE_KEYS,
		"kind",
		"subject",
		"semanticKey",
		"value",
		"evidence",
		"sources",
		"conversationId",
		"sourceRunId",
	]);
	const stateValue = readStateValue(
		requiredField(record, PATH, "value"),
		keyPath(PATH, "value"),
	);
	if (Object.hasOwn(stateValue, "attributes")) {
		return fail("INVALID_VALUE", keyPath(keyPath(PATH, "value"), "attributes"));
	}
	const evidence = readEvidence(
		requiredField(record, PATH, "evidence"),
		keyPath(PATH, "evidence"),
	);
	const conversationId = Object.hasOwn(record, "conversationId")
		? readIdentifier(
				record["conversationId"],
				keyPath(PATH, "conversationId"),
				LIMITS_CANDIDATE.maxConversationIdBytes,
			)
		: undefined;
	const sourceRunId = readOptionalRunId(record, PATH);
	return deepFreeze({
		...readWriteHeader(record, PATH),
		kind: readEnum(
			requiredField(record, PATH, "kind"),
			keyPath(PATH, "kind"),
			STATE_KINDS,
		),
		subject: readStateSubject(
			requiredField(record, PATH, "subject"),
			keyPath(PATH, "subject"),
		),
		semanticKey: readIdentifier(
			requiredField(record, PATH, "semanticKey"),
			keyPath(PATH, "semanticKey"),
			LIMITS_STATE.maxSemanticKeyBytes,
		),
		value: stateValue,
		evidence,
		sources: readHostSources(
			requiredField(record, PATH, "sources"),
			keyPath(PATH, "sources"),
		),
		...(conversationId === undefined ? {} : { conversationId }),
		...(sourceRunId === undefined ? {} : { sourceRunId }),
	});
}

export function parseListCandidatesInput(value: unknown): ListCandidatesInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [
		...SCOPED_READ_KEYS,
		"status",
		"kinds",
		"minObservations",
		"limit",
		"after",
	]);
	const header = readScopedHeader(record, PATH);
	const status = Object.hasOwn(record, "status")
		? readEnum(
				record["status"],
				keyPath(PATH, "status"),
				CANDIDATE_STATUSES.filter((entry) => entry !== "forgotten"),
			)
		: undefined;
	const kinds = readKinds(record, PATH);
	const minObservations = Object.hasOwn(record, "minObservations")
		? readSafeInteger(
				record["minObservations"],
				keyPath(PATH, "minObservations"),
				1,
				LIMITS_CANDIDATE.maxEvidencePerCandidate,
			)
		: undefined;
	const limit = readOptionalLimit(
		record,
		PATH,
		LIMITS_CANDIDATE.maxListCandidates,
	);
	let after: ListCandidatesInput["after"];
	if (Object.hasOwn(record, "after")) {
		const cursorPath = keyPath(PATH, "after");
		const cursor = readRecord(record["after"], cursorPath);
		checkKeys(cursor, cursorPath, ["updatedSeq", "candidateId"]);
		after = {
			updatedSeq: readSafeInteger(
				requiredField(cursor, cursorPath, "updatedSeq"),
				keyPath(cursorPath, "updatedSeq"),
				1,
				Number.MAX_SAFE_INTEGER,
			),
			candidateId: readIdentifier(
				requiredField(cursor, cursorPath, "candidateId"),
				keyPath(cursorPath, "candidateId"),
				LIMITS.maxItemIdBytes,
			),
		};
	}
	return deepFreeze({
		...header,
		...(status === undefined ? {} : { status }),
		...(kinds === undefined ? {} : { kinds }),
		...(minObservations === undefined ? {} : { minObservations }),
		...(limit === undefined ? {} : { limit }),
		...(after === undefined ? {} : { after }),
	});
}

export function parseReadCandidateInput(value: unknown): ReadCandidateInput {
	const record = readRecord(value, PATH);
	checkKeys(record, PATH, [...SCOPED_READ_KEYS, "candidateId"]);
	return deepFreeze({
		...readScopedHeader(record, PATH),
		candidateId: readIdentifier(
			requiredField(record, PATH, "candidateId"),
			keyPath(PATH, "candidateId"),
			LIMITS.maxItemIdBytes,
		),
	});
}
