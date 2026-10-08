/**
 * Extraction 永続 API の入力 parse（純粋）。違反は MemoryContractError（code と path のみ）。
 * 検査済みのコピーを deep-freeze して返す。`settle` の `output` は parse しない（`candidate.ts` が
 * 候補単位／run 単位で扱う）。意味の検査（出典の版、墓標、revision）は store が結果の状態で返す。
 */
import { deepFreeze } from "../canonical/freeze.ts";
import { utf8ByteLength } from "../canonical/utf8.ts";
import { LIMITS } from "../contracts/constants.ts";
import { SOURCE_ROLES } from "../contracts/common.ts";
import type { RunRef } from "../contracts/common.ts";
import type {
	ConfirmCandidateInput,
	ExtractionProfile,
	ListCandidatesInput,
	PrepareExtractionInput,
	SettleExtractionInput,
} from "../contracts/extraction.ts";
import {
	CANDIDATE_DECISIONS,
	CONFIRM_ACTIONS,
	LIMITS_EXTRACTION,
} from "../contracts/extraction.ts";
import {
	readAccessContext,
	readSourceCore,
	readSourceState,
} from "../contracts/parse-input.ts";
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
	readText,
	requiredField,
} from "../contracts/reader.ts";
import type { Rec } from "../contracts/reader.ts";
import { ownValue } from "../contracts/own.ts";
import { sourceKey } from "../contracts/source-key.ts";
import type {
	AdmissionPolicy,
	ExtractionSource,
	StateKind,
} from "../contracts/state.ts";
import { ADMISSION_MODES, STATE_KINDS } from "../contracts/state.ts";
import { CONTRACT_VERSIONS } from "../contracts/versions.ts";
import { readStateValue } from "../state/parse.ts";

const SCOPED_WRITE_KEYS = ["contractVersion", "access", "scopeKey", "clock"];
const SCOPED_READ_KEYS = ["contractVersion", "access", "scopeKey"];

function readHeader(record: Rec, path: string) {
	return {
		contractVersion: readContractVersion(
			record,
			path,
			CONTRACT_VERSIONS.extraction,
		),
		access: readAccessContext(
			requiredField(record, path, "access"),
			keyPath(path, "access"),
		),
		scopeKey: readScopeKey(
			requiredField(record, path, "scopeKey"),
			keyPath(path, "scopeKey"),
		),
	};
}

function readWriteHeader(record: Rec, path: string) {
	return {
		...readHeader(record, path),
		clock: readHostClock(
			requiredField(record, path, "clock"),
			keyPath(path, "clock"),
		),
	};
}

function readRun(value: unknown, path: string): RunRef {
	const record = readRecord(value, path);
	checkKeys(record, path, ["jobId", "attempt"]);
	return {
		jobId: readIdentifier(
			requiredField(record, path, "jobId"),
			keyPath(path, "jobId"),
			LIMITS.maxItemIdBytes,
		),
		attempt: readSafeInteger(
			requiredField(record, path, "attempt"),
			keyPath(path, "attempt"),
			0,
			Number.MAX_SAFE_INTEGER,
		),
	};
}

function readProfile(value: unknown, path: string): ExtractionProfile {
	const record = readRecord(value, path);
	checkKeys(record, path, ["extractorId", "promptVersion", "providerRef"]);
	return {
		extractorId: readIdentifier(
			requiredField(record, path, "extractorId"),
			keyPath(path, "extractorId"),
			LIMITS_EXTRACTION.maxExtractorIdBytes,
		),
		promptVersion: readIdentifier(
			requiredField(record, path, "promptVersion"),
			keyPath(path, "promptVersion"),
			LIMITS_EXTRACTION.maxPromptVersionBytes,
		),
		providerRef: readIdentifier(
			requiredField(record, path, "providerRef"),
			keyPath(path, "providerRef"),
			LIMITS_EXTRACTION.maxProviderRefBytes,
		),
	};
}

function readExtractionSources(
	value: unknown,
	path: string,
): readonly ExtractionSource[] {
	const items = readArray(value, path, LIMITS_EXTRACTION.maxSources);
	const sources: ExtractionSource[] = [];
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
			"role",
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
		const role = readEnum(
			requiredField(record, elementPath, "role"),
			keyPath(elementPath, "role"),
			SOURCE_ROLES,
		);
		const key = sourceKey(core);
		if (seen.has(key)) return fail("DUPLICATE_SOURCE", elementPath);
		seen.add(key);
		sources.push({
			...core,
			principal,
			scopeKey,
			status,
			content,
			ordinal,
			role,
		});
	}
	return sources;
}

export function parsePrepareExtractionInput(
	value: unknown,
): PrepareExtractionInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		...SCOPED_WRITE_KEYS,
		"run",
		"enabled",
		"sources",
		"profile",
		"maxInputBytes",
	]);
	const header = readWriteHeader(record, path);
	const enabled = requiredField(record, path, "enabled");
	if (typeof enabled !== "boolean") {
		return fail("INVALID_TYPE", keyPath(path, "enabled"));
	}
	return deepFreeze({
		...header,
		run: readRun(requiredField(record, path, "run"), keyPath(path, "run")),
		enabled,
		sources: readExtractionSources(
			requiredField(record, path, "sources"),
			keyPath(path, "sources"),
		),
		profile: readProfile(
			requiredField(record, path, "profile"),
			keyPath(path, "profile"),
		),
		maxInputBytes: readSafeInteger(
			requiredField(record, path, "maxInputBytes"),
			keyPath(path, "maxInputBytes"),
			1,
			LIMITS_EXTRACTION.maxInputBytesCap,
		),
	});
}

function readPolicy(value: unknown, path: string): AdmissionPolicy {
	const record = readRecord(value, path);
	checkKeys(record, path, STATE_KINDS);
	const policy = {} as Record<StateKind, (typeof ADMISSION_MODES)[number]>;
	for (const kind of STATE_KINDS) {
		const kindPath = keyPath(path, kind);
		const mode = readEnum(
			requiredField(record, path, kind),
			kindPath,
			ADMISSION_MODES,
		);
		// 別人の情報（other_person_note）を自動採用させない。
		if (kind === "other_person_note" && mode === "auto_admit") {
			return fail("INVALID_ENUM", kindPath);
		}
		policy[kind] = mode;
	}
	return policy;
}

export function parseSettleExtractionInput(
	value: unknown,
): SettleExtractionInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		...SCOPED_WRITE_KEYS,
		"run",
		"output",
		"currentSources",
		"policy",
	]);
	const header = readWriteHeader(record, path);
	const sourcesPath = keyPath(path, "currentSources");
	const currentSources = readArray(
		requiredField(record, path, "currentSources"),
		sourcesPath,
		LIMITS_EXTRACTION.maxSources,
	).map((element, index) =>
		readSourceState(element, indexPath(sourcesPath, index)),
	);
	const seen = new Set<string>();
	let total = 0;
	for (const [index, source] of currentSources.entries()) {
		const key = sourceKey(source);
		if (seen.has(key)) {
			return fail("DUPLICATE_SOURCE", indexPath(sourcesPath, index));
		}
		seen.add(key);
		total += utf8ByteLength(ownValue(source, "content") ?? "");
		if (total > LIMITS.maxTotalSourceContentBytes) {
			return fail("TOTAL_CONTENT_TOO_LARGE", sourcesPath);
		}
	}
	// output は検査せずそのまま渡す（候補単位の検査は parseExtractionOutput）。
	const output = requiredField(record, path, "output");
	return deepFreezeInput({
		...header,
		run: readRun(requiredField(record, path, "run"), keyPath(path, "run")),
		output,
		currentSources,
		policy: readPolicy(
			requiredField(record, path, "policy"),
			keyPath(path, "policy"),
		),
	});
}

/** output はホストの値そのもの（freeze しない）。それ以外を freeze する。 */
function deepFreezeInput(input: SettleExtractionInput): SettleExtractionInput {
	const { output, ...rest } = input;
	return { ...deepFreeze(rest), output };
}

export function parseListCandidatesInput(value: unknown): ListCandidatesInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [...SCOPED_READ_KEYS, "decision", "limit"]);
	const header = readHeader(record, path);
	const decision = Object.hasOwn(record, "decision")
		? readEnum(
				record["decision"],
				keyPath(path, "decision"),
				CANDIDATE_DECISIONS.filter((candidate) => candidate !== "forgotten"),
			)
		: undefined;
	const limit = Object.hasOwn(record, "limit")
		? readSafeInteger(
				record["limit"],
				keyPath(path, "limit"),
				1,
				LIMITS_EXTRACTION.maxListedCandidates,
			)
		: undefined;
	return deepFreeze({
		...header,
		...(decision === undefined ? {} : { decision }),
		...(limit === undefined ? {} : { limit }),
	});
}

export function parseConfirmCandidateInput(
	value: unknown,
): ConfirmCandidateInput {
	const path = "$";
	const record = readRecord(value, path);
	checkKeys(record, path, [
		...SCOPED_WRITE_KEYS,
		"candidateId",
		"action",
		"editedValue",
		"currentSources",
	]);
	const header = readWriteHeader(record, path);
	const sourcesPath = keyPath(path, "currentSources");
	const currentSources = readArray(
		requiredField(record, path, "currentSources"),
		sourcesPath,
		LIMITS_EXTRACTION.maxSources,
	).map((element, index) =>
		readSourceState(element, indexPath(sourcesPath, index)),
	);
	const editedValue = Object.hasOwn(record, "editedValue")
		? readStateValue(record["editedValue"], keyPath(path, "editedValue"))
		: undefined;
	const action = readEnum(
		requiredField(record, path, "action"),
		keyPath(path, "action"),
		CONFIRM_ACTIONS,
	);
	if (editedValue !== undefined && action !== "admit") {
		return fail("INVALID_VALUE", keyPath(path, "editedValue"));
	}
	return deepFreeze({
		...header,
		candidateId: readIdentifier(
			requiredField(record, path, "candidateId"),
			keyPath(path, "candidateId"),
			LIMITS.maxItemIdBytes,
		),
		action,
		...(editedValue === undefined ? {} : { editedValue }),
		currentSources,
	});
}
