/**
 * Extraction の永続 API（契約は `src/domains/extraction/contracts/index.ts`、設計は full-system-design §3.6, §4）。
 * ホスト queue handler の `prepareInTransaction` / `execute` / `settleInTransaction` のうち、本体が持つのは
 * prepare と settle（と候補の確認・一覧）。execute（モデル呼び出し）はホストで、本体は `ExtractorPort` の型だけ持つ。
 *
 * - prepare / settle / confirm は書き込み系で、ホストの write transaction の中で 1 回呼ぶ（入口は `enterWrite`）。
 *   listCandidates は読み取り（`enterRead`）。
 * - run 行は監査と冪等のため（job の status / attempt / lease / retry は保存しない）。runId = `jobId:attempt`。
 * - 本文は保存しない: run の入力は出典の SourceRef 相当・role・順位（ordinal）・digest だけを持つ。settle は
 *   ホストが同 transaction で読み直した `currentSources[].content` で quote を検査する（内容は digest で結ぶ）。
 *   本文が渡されていない出典を引用した候補は、quote を検証できないので `QUOTE_MISMATCH` で候補単位に却下する。
 * - stale は run を `stale` で確定して終える（候補・state・進捗を一切書かない）。判定の順:
 *   run の墓標／入力の墓標・forgotten → `SOURCE_TOMBSTONED`、入力の版・digest の不一致・欠落 → `SOURCE_CHANGED`、
 *   見せた state item の revision・状態の不一致 → `STATE_CHANGED`。stale な run は再 settle しても同じ結果を返す。
 * - 冪等: output の canonical digest を run 行に保存する。同じ output の再 settle は前回の結果を返し、違う output は
 *   `RUN_ALREADY_SETTLED_DIFFERENT`（run は変えない）。
 * - 採否は `evaluateAdmission`（`src/domains/state/service/admission.ts`）。方針（policy）は呼び出しごとの引数で、本体は
 *   既定で自動採用しない（`auto_admit` は policy が明示したときだけ）。
 * - 依存辺（forget の閉包が届くための辺）: extraction_run → 入力の各 source、見せた state_item（role input）。
 *   candidate → extraction_run（derived_from）、検査を通った evidence の各 source。state_item → candidate（derived_from）。
 *   run を再 prepare（stage が prepared のうち）したときに外れた入力の古い辺は残す（保守側）。
 * - 台帳に載らない値（INVALID_CANDIDATE・HOST_OWNED_KIND、kind を決められない候補）は候補行を作らず、
 *   run の rejected 件数にだけ数える（候補表の kind は StateKind に限るため）。
 */
import { canonicalJson } from "../../../canonical/json.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { encodeUtf8 } from "../../../canonical/utf8.ts";
import { deepFreeze } from "../../../canonical/freeze.ts";
import {
	MEMORY_RECORD_SOURCE_KIND,
	MEMORY_SOURCE_NAMESPACE,
} from "../../../contracts/common.ts";
import type { StateSubject } from "../../../contracts/common.ts";
import { MemoryContractError } from "../../../contracts/errors.ts";
import { ownValue } from "../../../contracts/own.ts";
import {
	CANDIDATE_DECISIONS,
	EXTRACTION_REJECTED_OUTPUT_REASON_CODES,
	EXTRACTION_STALE_REASON_CODES,
	LIMITS_EXTRACTION,
} from "../contracts/index.ts";
import type {
	CandidateEvidenceRecord,
	CandidateRecord,
	ConfirmCandidateInput,
	ConfirmCandidateResult,
	ExtractionInput,
	ExtractionOutputCandidate,
	ExtractionRejectedOutputReasonCode,
	ExtractionStaleReasonCode,
	ListCandidatesInput,
	ListCandidatesResult,
	PrepareExtractionInput,
	PrepareExtractionResult,
	SettleExtractionInput,
	SettleExtractionResult,
	ShownStateItem,
} from "../contracts/index.ts";
import { sourceKey } from "../../../contracts/source-key.ts";
import {
	ADMISSION_REASON_CODES,
	STATE_KINDS,
	USER_STATE_ORIGINS,
} from "../../state/contracts/index.ts";
import type {
	AdmissionReasonCode,
	ExtractionSource,
	StateItemView,
	StateKeyHistory,
	StateKind,
	StateOrigin,
	StateValue,
} from "../../state/contracts/index.ts";
import type { SourceRef, SourceState } from "../../../contracts/types.ts";
import type { Modality, Temporal } from "../../../contracts/common.ts";
import { MODALITIES, TEMPORALS } from "../../../contracts/common.ts";
import { parseExtractionOutput } from "../service/candidate.ts";
import { candidateIdOf, runIdOf } from "../service/ids.ts";
import {
	parseConfirmCandidateInput,
	parseListCandidatesInput,
	parsePrepareExtractionInput,
	parseSettleExtractionInput,
} from "../service/parse.ts";
import { buildExtractionPromptMaterial } from "../service/prompt.ts";
import {
	candidateValue,
	effectiveCandidateKind,
	evaluateAdmission,
} from "../../state/index.ts";
import type { AdmissionCandidate } from "../../state/index.ts";
import { checkEvidence, evidenceOrdinalOf } from "../../state/index.ts";
import { isSubjectKindConsistent } from "../../state/index.ts";
import { makeKeyResolver, stateValueEquals } from "../../state/index.ts";
import type { KeyResolver } from "../../state/index.ts";
import { addDependency } from "../../../infrastructure/sqlite/dependency.ts";
import {
	readInteger,
	readNullableInteger,
	readNullableText,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";
import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import {
	findActiveStateView,
	findStateKeyHistory,
	listStateKeys,
	listState,
	readStateItem,
	readStateItemView,
	writeStateForCandidate,
} from "../../state/sqlite.ts";
import { isTombstoned } from "../../../infrastructure/sqlite/tombstone.ts";
import { all, first, placeholders, run } from "./sql.ts";

/** output を canonical 化できない場合の digest（冪等判定用の固定値。どれも OUTPUT_SCHEMA で同じ結果になる）。 */
const UNHASHABLE_OUTPUT_DIGEST = sha256Hex("memory:extraction:unhashable");
const SELF_KINDS: readonly StateKind[] = STATE_KINDS.filter(
	(kind) => kind !== "other_person_note",
);

// ---- 共通 ----

function isPermitted(
	access: { readonly scopeKeys: readonly string[] },
	scopeKey: string,
): boolean {
	return access.scopeKeys.includes(scopeKey);
}

/** 出典の墓標（会話などホスト所有は SourceKey、Records は recordId）。 */
function isSourceTombstoned(
	db: MemoryDb,
	ref: {
		readonly namespace: string;
		readonly kind: string;
		readonly id: string;
		readonly representation?: string;
	},
): boolean {
	if (isTombstoned(db, "source", sourceKey(ref))) return true;
	return (
		ref.namespace === MEMORY_SOURCE_NAMESPACE &&
		ref.kind === MEMORY_RECORD_SOURCE_KIND &&
		isTombstoned(db, "record", ref.id)
	);
}

function readEnumText<T extends string>(
	row: unknown,
	column: string,
	allowed: readonly T[],
): T {
	const value = readText(row, column);
	const found = allowed.find((candidate) => candidate === value);
	if (found === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return found;
}

interface StoredSource {
	readonly idx: number;
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
	readonly revision: string;
	readonly digest: string;
	readonly role: ExtractionSource["role"];
	readonly ordinal: number;
}

function representationOf(source: {
	readonly representation?: string;
}): string | undefined {
	return ownValue(source, "representation");
}

function toRef(source: {
	readonly namespace: string;
	readonly kind: string;
	readonly id: string;
	readonly representation?: string;
	readonly revision: string;
	readonly digest: string;
}): Omit<SourceRef, "range"> {
	return {
		namespace: source.namespace,
		kind: source.kind,
		id: source.id,
		...(representationOf(source) === undefined
			? {}
			: { representation: representationOf(source) as string }),
		revision: source.revision,
		digest: source.digest,
	};
}

// ---- run 行 ----

interface RunRow {
	readonly runId: string;
	readonly principal: string;
	readonly scopeKey: string;
	readonly stage: "prepared" | "settled" | "stale" | "rejected_output";
	readonly outcomeCode: string | null;
	readonly outputDigest: string | null;
	readonly admitted: number;
	readonly pendingUser: number;
	readonly rejected: number;
}

const RUN_STAGES = ["prepared", "settled", "stale", "rejected_output"] as const;

function loadRun(db: MemoryDb, runId: string): RunRow | null {
	const row = first(
		db,
		`SELECT run_id, principal, scope_key, stage, outcome_code, output_digest,
			admitted_count, pending_count, rejected_count
		FROM memory_extraction_run WHERE run_id = ?`,
		[runId],
	);
	if (row === null) return null;
	return {
		runId: readText(row, "run_id"),
		principal: readText(row, "principal"),
		scopeKey: readText(row, "scope_key"),
		stage: readEnumText(row, "stage", RUN_STAGES),
		outcomeCode: readNullableText(row, "outcome_code"),
		outputDigest: readNullableText(row, "output_digest"),
		admitted: readNullableInteger(row, "admitted_count") ?? 0,
		pendingUser: readNullableInteger(row, "pending_count") ?? 0,
		rejected: readNullableInteger(row, "rejected_count") ?? 0,
	};
}

function loadInputs(db: MemoryDb, runId: string): StoredSource[] {
	return all(
		db,
		`SELECT idx, namespace, kind, source_id, representation, revision, digest, role, ordinal
		FROM memory_extraction_input WHERE run_id = ? ORDER BY idx`,
		[runId],
	).map((row) => {
		const representation = readNullableText(row, "representation");
		return {
			idx: readInteger(row, "idx"),
			namespace: readText(row, "namespace"),
			kind: readText(row, "kind"),
			id: readText(row, "source_id"),
			...(representation === null ? {} : { representation }),
			revision: readText(row, "revision"),
			digest: readText(row, "digest"),
			role: readEnumText(row, "role", ["user", "assistant", "tool"] as const),
			ordinal: readInteger(row, "ordinal"),
		};
	});
}

function loadShown(
	db: MemoryDb,
	runId: string,
): { readonly itemId: string; readonly revision: number }[] {
	return all(
		db,
		"SELECT item_id, revision FROM memory_extraction_shown WHERE run_id = ? ORDER BY item_id",
		[runId],
	).map((row) => ({
		itemId: readText(row, "item_id"),
		revision: readInteger(row, "revision"),
	}));
}

// ---- prepare ----

function readProgress(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	key: string,
): { readonly revision: string; readonly stage: string } | null {
	const row = first(
		db,
		`SELECT processed_revision, stage FROM memory_source_progress
		WHERE principal = ? AND scope_key = ? AND source_key = ?`,
		[principal, scopeKey, key],
	);
	return row === null
		? null
		: {
				revision: readText(row, "processed_revision"),
				stage: readText(row, "stage"),
			};
}

/**
 * run を作り（または stage が prepared の同じ run を作り直し）、モデル層へ渡す入力を返す。書き込み系。
 * skip の順: 無効 → 出典の墓標／forgotten／run の墓標 → 確定済みの run → 入力なし／処理済み → サイズ超過。
 * 出典が scope と別（principal・scopeKey が違う）なら `blocked`。出典の本文と digest が一致しなければ
 * `MemoryContractError`（INVALID_DIGEST）。
 */
export function prepareExtraction(
	db: MemoryDb,
	input: PrepareExtractionInput,
): PrepareExtractionResult {
	const parsed = parsePrepareExtractionInput(input);
	const seq = enterWrite(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = parsed.access.principal;
	const scopeKey = parsed.scopeKey;
	if (
		parsed.sources.some(
			(source) =>
				source.principal !== principal || source.scopeKey !== scopeKey,
		)
	) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	for (const [index, source] of parsed.sources.entries()) {
		// 本文と digest を結ぶのは available の出典だけ。forgotten / missing / changed の出典は本文が空でありうる
		// （ホストが本文を読めない）ので、検査せず、後段の墓標・NO_NEW_INPUT の判定へ進める。
		if (
			source.status === "available" &&
			sha256Hex(source.content) !== source.digest
		) {
			throw new MemoryContractError(
				"INVALID_DIGEST",
				`$.sources[${index}].content`,
			);
		}
	}
	if (!parsed.enabled) return { status: "skip", reasonCode: "MEMORY_DISABLED" };

	const runId = runIdOf(parsed.run);
	if (
		parsed.sources.some(
			(source) =>
				source.status === "forgotten" || isSourceTombstoned(db, source),
		) ||
		isTombstoned(db, "extraction_run", runId)
	) {
		return { status: "skip", reasonCode: "SOURCE_TOMBSTONED" };
	}
	const existing = loadRun(db, runId);
	if (
		existing !== null &&
		(existing.principal !== principal || existing.scopeKey !== scopeKey)
	) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	if (existing !== null && existing.stage !== "prepared") {
		return { status: "skip", reasonCode: "NO_NEW_INPUT" };
	}
	const eligible = parsed.sources.filter(
		(source) => source.status === "available",
	);
	const hasNew = eligible.some((source) => {
		const progress = readProgress(db, principal, scopeKey, sourceKey(source));
		return (
			progress === null ||
			progress.revision !== source.revision ||
			progress.stage === "failed_output"
		);
	});
	if (!hasNew) return { status: "skip", reasonCode: "NO_NEW_INPUT" };
	let bytes = 0;
	for (const source of eligible) bytes += encodeUtf8(source.content).length;
	if (bytes > parsed.maxInputBytes) {
		return { status: "skip", reasonCode: "INPUT_TOO_LARGE" };
	}

	const listed = listState(db, {
		contractVersion: 1,
		access: parsed.access,
		scopeKey,
		kinds: SELF_KINDS,
		limit: LIMITS_EXTRACTION.maxShownState,
	});
	if (listed.status !== "ok") {
		return { status: "blocked", reasonCode: listed.reasonCode };
	}
	const shownState: ShownStateItem[] = listed.items.map((item) => ({
		itemId: item.itemId,
		revision: item.revision,
		kind: item.kind,
		semanticKey: item.semanticKey,
		value: item.value,
	}));
	const sources = eligible.map((source) => ({
		ref: toRef(source),
		role: source.role,
		content: source.content,
	}));
	const inputDigest = sha256Hex(
		canonicalJson({
			extractorId: parsed.profile.extractorId,
			promptVersion: parsed.profile.promptVersion,
			sources: sources.map((source) => ({
				ref: source.ref,
				role: source.role,
			})),
			shownState,
		}),
	);

	if (existing === null) {
		run(
			db,
			`INSERT INTO memory_extraction_run
				(run_id, principal, scope_key, stage, input_digest, extractor_id, prompt_version,
				 provider_ref, prepared_seq)
			VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?)`,
			[
				runId,
				principal,
				scopeKey,
				inputDigest,
				parsed.profile.extractorId,
				parsed.profile.promptVersion,
				parsed.profile.providerRef,
				seq,
			],
		);
	} else {
		run(db, "DELETE FROM memory_extraction_input WHERE run_id = ?", [runId]);
		run(db, "DELETE FROM memory_extraction_shown WHERE run_id = ?", [runId]);
		run(
			db,
			`UPDATE memory_extraction_run
			SET input_digest = ?, extractor_id = ?, prompt_version = ?, provider_ref = ?, prepared_seq = ?
			WHERE run_id = ?`,
			[
				inputDigest,
				parsed.profile.extractorId,
				parsed.profile.promptVersion,
				parsed.profile.providerRef,
				seq,
				runId,
			],
		);
	}
	for (const [idx, source] of eligible.entries()) {
		const key = sourceKey(source);
		run(
			db,
			`INSERT INTO memory_extraction_input
				(run_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, role, ordinal)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				runId,
				idx,
				key,
				source.namespace,
				source.kind,
				source.id,
				representationOf(source) ?? null,
				source.revision,
				source.digest,
				source.role,
				source.ordinal,
			],
		);
		addDependency(db, {
			principal,
			scopeKey,
			dependentType: "extraction_run",
			dependentId: runId,
			dependencyType: "source",
			dependencyId: key,
			role: "input",
		});
	}
	for (const item of shownState) {
		run(
			db,
			"INSERT INTO memory_extraction_shown (run_id, item_id, revision) VALUES (?, ?, ?)",
			[runId, item.itemId, item.revision],
		);
		addDependency(db, {
			principal,
			scopeKey,
			dependentType: "extraction_run",
			dependentId: runId,
			dependencyType: "state_item",
			dependencyId: item.itemId,
			role: "input",
		});
	}
	const extractionInput: ExtractionInput = {
		runId,
		inputDigest,
		sources,
		shownState,
		instructions: buildExtractionPromptMaterial(parsed.profile.promptVersion),
	};
	return { status: "ready", input: deepFreeze(extractionInput) };
}

// ---- settle ----

function finalizeRun(
	db: MemoryDb,
	runId: string,
	seq: number,
	stage: "settled" | "stale" | "rejected_output",
	outcomeCode: string | null,
	outputDigest: string,
	counts: { admitted: number; pendingUser: number; rejected: number },
): void {
	run(
		db,
		`UPDATE memory_extraction_run
		SET stage = ?, settled_seq = ?, outcome_code = ?, output_digest = ?,
			admitted_count = ?, pending_count = ?, rejected_count = ?
		WHERE run_id = ?`,
		[
			stage,
			seq,
			outcomeCode,
			outputDigest,
			counts.admitted,
			counts.pendingUser,
			counts.rejected,
			runId,
		],
	);
}

const NO_COUNTS = { admitted: 0, pendingUser: 0, rejected: 0 };

function writeProgress(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	runId: string,
	seq: number,
	inputs: readonly StoredSource[],
	stage: "extracted" | "no_change" | "failed_output",
): void {
	for (const source of inputs) {
		run(
			db,
			`INSERT INTO memory_source_progress
				(principal, scope_key, source_key, processed_revision, stage, run_id, seq)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (principal, scope_key, source_key) DO UPDATE SET
				processed_revision = excluded.processed_revision,
				stage = excluded.stage, run_id = excluded.run_id, seq = excluded.seq`,
			[
				principal,
				scopeKey,
				sourceKey(source),
				source.revision,
				stage,
				runId,
				seq,
			],
		);
	}
}

function replayResult(row: RunRow): SettleExtractionResult {
	if (row.stage === "settled") {
		return {
			status: "applied",
			admitted: row.admitted,
			pendingUser: row.pendingUser,
			rejected: row.rejected,
		};
	}
	if (row.stage === "stale") {
		const code = EXTRACTION_STALE_REASON_CODES.find(
			(candidate) => candidate === row.outcomeCode,
		);
		if (code === undefined) throw new MemoryStoreError("CORRUPT_ROW");
		return { status: "stale", reasonCode: code };
	}
	const code = EXTRACTION_REJECTED_OUTPUT_REASON_CODES.find(
		(candidate) => candidate === row.outcomeCode,
	);
	if (code === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return { status: "rejected_output", reasonCode: code };
}

/** 入力・見せた state の鮮度。stale なら理由。 */
function checkStale(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	runId: string,
	inputs: readonly StoredSource[],
	currentSources: readonly SourceState[],
): ExtractionStaleReasonCode | null {
	if (inputs.some((source) => isSourceTombstoned(db, source))) {
		return "SOURCE_TOMBSTONED";
	}
	const current = new Map<string, SourceState>();
	for (const source of currentSources) {
		if (source.principal === principal && source.scopeKey === scopeKey) {
			current.set(sourceKey(source), source);
		}
	}
	if (
		inputs.some(
			(source) => current.get(sourceKey(source))?.status === "forgotten",
		)
	) {
		return "SOURCE_TOMBSTONED";
	}
	for (const source of inputs) {
		const now = current.get(sourceKey(source));
		if (
			now === undefined ||
			now.status !== "available" ||
			now.revision !== source.revision ||
			now.digest !== source.digest
		) {
			return "SOURCE_CHANGED";
		}
	}
	for (const shown of loadShown(db, runId)) {
		const item = readStateItemView(db, principal, scopeKey, shown.itemId);
		if (
			item.status !== "found" ||
			item.view.status !== "active" ||
			item.view.revision !== shown.revision
		) {
			return "STATE_CHANGED";
		}
	}
	return null;
}

interface Decided {
	readonly index: number;
	readonly candidate: ExtractionOutputCandidate;
	readonly decision: "admitted" | "pending_user" | "rejected";
	readonly reasonCode: AdmissionReasonCode | null;
	readonly kind: StateKind | null;
	readonly spans: readonly { source: SourceRef; quote: string }[];
	readonly evidenceOk: boolean;
	readonly ordinal: number;
	readonly replaces: {
		readonly itemId: string;
		readonly revision: number;
	} | null;
	readonly activeItemId: string | null;
}

/** 台帳に載る kind を決められない候補（SUBJECT_UNKNOWN 等）の行の kind。StateKind でなければ null（行を作らない）。 */
function rowKind(effective: StateKind | null, raw: string): StateKind | null {
	if (effective !== null) return effective;
	return (STATE_KINDS as readonly string[]).includes(raw)
		? (raw as StateKind)
		: null;
}

const UNMATCHED_REF: SourceRef = Object.freeze({
	namespace: "unknown",
	kind: "unknown",
	id: "none",
	revision: `sha256:${"0".repeat(64)}`,
	digest: "0".repeat(64),
});

/**
 * 辞書で同値と確定できる key が既に台帳にあれば、その保存済みの key に揃える（active の照合・ユーザー停止の保護・
 * `replaces` が、辞書を足す前や明示操作で書かれた key とも一致するように）。複数あるときは active を持つ key、
 * ユーザーが停止した履歴のある key、正規の key、昇順の先頭の順で選ぶ。なければ正規の key。
 */
function alignSemanticKey(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	candidate: {
		readonly kind: string;
		readonly subject: string;
		readonly semanticKey: string;
		readonly value: { readonly text: string; readonly polarity: string };
		readonly modality: string;
		readonly temporal: string;
	},
	resolver: KeyResolver,
): string {
	const canonical = resolver.canonical(candidate.semanticKey);
	const kind = effectiveCandidateKind(candidate);
	if (kind === null) return canonical;
	const subject =
		candidate.subject === "self" ? "self" : (candidate.subject as StateSubject);
	const stored = listStateKeys(db, principal, scopeKey, subject, kind).filter(
		(key) => key === canonical || resolver.canonical(key) === canonical,
	);
	if (stored.length === 0) return canonical;
	const rank = (key: string): number => {
		if (
			findActiveStateView(db, principal, scopeKey, subject, kind, key) !== null
		)
			return 0;
		if (
			findStateKeyHistory(db, principal, scopeKey, subject, kind, key)
				.userRemoved
		)
			return 1;
		return key === canonical ? 2 : 3;
	};
	return [...stored].sort((a, b) => rank(a) - rank(b))[0] as string;
}

function decideCandidate(args: {
	readonly index: number;
	readonly candidate: ExtractionOutputCandidate;
	readonly principal: string;
	readonly scopeKey: string;
	readonly inputs: readonly StoredSource[];
	readonly inputSources: readonly ExtractionSource[];
	readonly currentSources: readonly SourceState[];
	readonly shown: ReadonlyMap<string, number>;
	readonly policy: SettleExtractionInput["policy"];
	readonly db: MemoryDb;
}): Decided {
	const { candidate, inputs } = args;
	const spans = candidate.evidence.map((evidence) => {
		const input = inputs[evidence.sourceIndex];
		const ref: SourceRef =
			input === undefined
				? UNMATCHED_REF
				: {
						...toRef(input),
						range: { startByte: evidence.startByte, endByte: evidence.endByte },
					};
		return { source: ref, quote: evidence.quote };
	});
	const admissionCandidate: AdmissionCandidate = {
		kind: candidate.kind,
		subject: candidate.subject,
		semanticKey: candidate.semanticKey,
		value: candidate.value,
		modality: candidate.modality,
		temporal: candidate.temporal,
		evidence: spans,
	};
	const effective = effectiveCandidateKind(admissionCandidate);
	const kind = rowKind(effective, candidate.kind);
	let active: StateItemView | null = null;
	let keyHistory: StateKeyHistory | undefined;
	if (effective !== null) {
		const subject =
			candidate.subject === "self"
				? "self"
				: (candidate.subject as StateSubject);
		active = findActiveStateView(
			args.db,
			args.principal,
			args.scopeKey,
			subject,
			effective,
			candidate.semanticKey,
		);
		keyHistory = findStateKeyHistory(
			args.db,
			args.principal,
			args.scopeKey,
			subject,
			effective,
			candidate.semanticKey,
		);
	}
	const evidenceInput = {
		principal: args.principal,
		scopeKey: args.scopeKey,
		evidence: spans,
		inputSources: args.inputSources,
		currentSources: args.currentSources,
	};
	const evidenceOk = spans.length > 0 && checkEvidence(evidenceInput) === null;
	const ordinal = evidenceOk ? (evidenceOrdinalOf(evidenceInput) ?? 0) : 0;
	const replacesId = ownValue(candidate, "replaces");
	const replacesValid =
		replacesId === undefined ||
		(args.shown.has(replacesId) &&
			active !== null &&
			active.itemId === replacesId);
	const base = {
		index: args.index,
		candidate,
		kind,
		spans,
		evidenceOk,
		ordinal,
		activeItemId: active?.itemId ?? null,
	};
	if (!replacesValid) {
		return {
			...base,
			decision: "rejected",
			reasonCode: "INVALID_CANDIDATE",
			replaces: null,
		};
	}
	const decision = evaluateAdmission({
		candidate: admissionCandidate,
		principal: args.principal,
		scopeKey: args.scopeKey,
		inputSources: args.inputSources,
		currentSources: args.currentSources,
		activeForKey: active,
		...(keyHistory === undefined ? {} : { keyHistory }),
		policy: args.policy,
	});
	// 置き換え対象: モデルが示した replaces、なければ評価時点の active（値が違う場合）。確認時の CAS に使う。
	const conflict =
		active !== null &&
		!stateValueEquals(active.value, candidateValue(admissionCandidate))
			? { itemId: active.itemId, revision: active.revision }
			: null;
	if (decision.decision === "admitted") {
		return {
			...base,
			decision: "admitted",
			reasonCode: null,
			replaces: conflict,
		};
	}
	// 台帳に載せられない候補（subject unknown など）は確認に回さない。
	if (decision.decision === "pending_user" && effective === null) {
		return {
			...base,
			decision: "rejected",
			reasonCode: "SUBJECT_UNKNOWN",
			replaces: null,
		};
	}
	return {
		...base,
		decision: decision.decision,
		reasonCode: decision.reasonCode,
		replaces: conflict,
	};
}

function insertCandidate(
	db: MemoryDb,
	args: {
		readonly principal: string;
		readonly scopeKey: string;
		readonly runId: string;
		readonly seq: number;
		readonly decided: Decided;
		readonly decision: "admitted" | "pending_user" | "rejected";
		readonly reasonCode: AdmissionReasonCode | null;
		readonly admittedItemId: string | null;
		readonly content: (ref: SourceRef) => string | undefined;
	},
): void {
	const { decided } = args;
	const { candidate } = decided;
	if (decided.kind === null) throw new MemoryStoreError("CORRUPT_ROW");
	const candidateId = candidateIdOf(args.runId, decided.index);
	run(
		db,
		`INSERT INTO memory_candidate
			(candidate_id, run_id, idx, principal, scope_key, kind, subject, semantic_key, value_text,
			 polarity, modality, temporal, decision, reason_code, evidence_ordinal, replaces_item_id,
			 replaces_revision, admitted_item_id, created_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			candidateId,
			args.runId,
			decided.index,
			args.principal,
			args.scopeKey,
			decided.kind,
			candidate.subject,
			candidate.semanticKey,
			candidate.value.text,
			candidate.value.polarity,
			candidate.modality,
			candidate.temporal,
			args.decision,
			args.reasonCode,
			decided.ordinal,
			decided.replaces?.itemId ?? null,
			decided.replaces?.revision ?? null,
			args.admittedItemId,
			args.seq,
		],
	);
	addDependency(db, {
		principal: args.principal,
		scopeKey: args.scopeKey,
		dependentType: "candidate",
		dependentId: candidateId,
		dependencyType: "extraction_run",
		dependencyId: args.runId,
		role: "derived_from",
	});
	if (!decided.evidenceOk) return;
	for (const [idx, span] of decided.spans.entries()) {
		const ref = span.source;
		const range = ownValue(ref, "range");
		const content = args.content(ref);
		if (range === undefined || content === undefined) {
			throw new MemoryStoreError("CORRUPT_ROW");
		}
		const key = sourceKey(ref);
		run(
			db,
			`INSERT INTO memory_candidate_evidence
				(candidate_id, idx, source_key, namespace, kind, source_id, representation, revision, digest,
				 start_byte, end_byte, quote_digest)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				candidateId,
				idx,
				key,
				ref.namespace,
				ref.kind,
				ref.id,
				representationOf(ref) ?? null,
				ref.revision,
				ref.digest,
				range.startByte,
				range.endByte,
				sha256Hex(encodeUtf8(content).subarray(range.startByte, range.endByte)),
			],
		);
		addDependency(db, {
			principal: args.principal,
			scopeKey: args.scopeKey,
			dependentType: "candidate",
			dependentId: candidateId,
			dependencyType: "source",
			dependencyId: key,
			role: idx === 0 ? "primary" : "support",
		});
	}
}

/**
 * モデルが返した値を検査して候補にし、Admission で採否を決める。書き込み系。
 * `output` は ExtractorPort の戻り値（JSON として読み込み済みの値）。ExtractorPort が失敗したときはホストは
 * 呼ばない（run は prepared のまま、再試行はホスト）。
 */
export function settleExtraction(
	db: MemoryDb,
	input: SettleExtractionInput,
): SettleExtractionResult {
	const parsed = parseSettleExtractionInput(input);
	const seq = enterWrite(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = parsed.access.principal;
	const scopeKey = parsed.scopeKey;
	const runId = runIdOf(parsed.run);
	const row = loadRun(db, runId);
	if (
		row === null ||
		row.principal !== principal ||
		row.scopeKey !== scopeKey
	) {
		return { status: "stale", reasonCode: "RUN_UNKNOWN" };
	}
	if (isTombstoned(db, "extraction_run", runId)) {
		return { status: "stale", reasonCode: "SOURCE_TOMBSTONED" };
	}
	const output = parseExtractionOutput(parsed.output);
	const outputDigest = output.digest ?? UNHASHABLE_OUTPUT_DIGEST;
	if (row.stage !== "prepared") {
		if (row.outputDigest !== outputDigest) {
			return { status: "stale", reasonCode: "RUN_ALREADY_SETTLED_DIFFERENT" };
		}
		return replayResult(row);
	}

	const inputs = loadInputs(db, runId);
	const staleReason = checkStale(
		db,
		principal,
		scopeKey,
		runId,
		inputs,
		parsed.currentSources,
	);
	if (staleReason !== null) {
		finalizeRun(db, runId, seq, "stale", staleReason, outputDigest, NO_COUNTS);
		return { status: "stale", reasonCode: staleReason };
	}
	if (!output.ok) {
		const reasonCode: ExtractionRejectedOutputReasonCode = output.reasonCode;
		finalizeRun(
			db,
			runId,
			seq,
			"rejected_output",
			reasonCode,
			outputDigest,
			NO_COUNTS,
		);
		writeProgress(db, principal, scopeKey, runId, seq, inputs, "failed_output");
		return { status: "rejected_output", reasonCode };
	}

	// 本文は run に保存していないので、ホストが渡した現在の本文で quote を検査する（digest で入力と結ばれる）。
	const contentOf = new Map<string, string>();
	for (const source of parsed.currentSources) {
		if (source.principal === principal && source.scopeKey === scopeKey) {
			const content = ownValue(source, "content");
			if (content !== undefined) contentOf.set(sourceKey(source), content);
		}
	}
	const inputSources: ExtractionSource[] = inputs.map((source) => ({
		...toRef(source),
		principal,
		scopeKey,
		status: "available",
		content: contentOf.get(sourceKey(source)) ?? "",
		ordinal: source.ordinal,
		role: source.role,
	}));
	const shown = new Map(
		loadShown(db, runId).map((item) => [item.itemId, item.revision]),
	);
	const counts = { admitted: 0, pendingUser: 0, rejected: 0 };
	const dictionary = ownValue(parsed, "keyDictionary");
	const resolver =
		dictionary === undefined ? null : makeKeyResolver(dictionary);
	for (const [index, extracted] of output.output.candidates.entries()) {
		// 辞書で確定できた key だけを整える。不明・曖昧は変えず、統合しない。
		const candidate =
			resolver === null
				? extracted
				: {
						...extracted,
						semanticKey: alignSemanticKey(
							db,
							principal,
							scopeKey,
							extracted,
							resolver,
						),
					};
		const decided = decideCandidate({
			index,
			candidate,
			principal,
			scopeKey,
			inputs,
			inputSources,
			currentSources: parsed.currentSources,
			shown,
			policy: parsed.policy,
			db,
		});
		let decision = decided.decision;
		let reasonCode = decided.reasonCode;
		let admittedItemId: string | null = null;
		if (decision === "admitted") {
			if (decided.kind === null) throw new MemoryStoreError("CORRUPT_ROW");
			const written = writeStateForCandidate(db, {
				principal,
				scopeKey,
				atMs: parsed.clock.atMs,
				subject:
					candidate.subject === "self"
						? "self"
						: (candidate.subject as StateSubject),
				kind: decided.kind,
				semanticKey: candidate.semanticKey,
				value: candidateValue({ ...candidate, evidence: decided.spans }),
				evidence: decided.spans,
				evidenceOrdinal: decided.ordinal,
				origin: "admitted_extraction",
				candidateId: candidateIdOf(runId, index),
				replaces: null,
			});
			if (written.status === "applied" || written.status === "unchanged") {
				admittedItemId = written.itemId;
			} else {
				// 採用の書き込みが拒否された（規則表を通った後の防御）。候補は rejected として残す。
				decision = "rejected";
				reasonCode =
					written.status === "rejected" &&
					written.reasonCode === "OLDER_EVIDENCE"
						? "OLDER_EVIDENCE"
						: "INVALID_CANDIDATE";
			}
		}
		if (decision === "admitted") counts.admitted += 1;
		else if (decision === "pending_user") counts.pendingUser += 1;
		else counts.rejected += 1;
		// 行を作らず件数だけ数える: 台帳に載らない値（INVALID_CANDIDATE・HOST_OWNED_KIND・kind を決められない候補）と、
		// 方針 never の候補（契約: never = 候補も作らず rejected。値を残さない）。
		if (
			decided.kind === null ||
			reasonCode === "INVALID_CANDIDATE" ||
			reasonCode === "HOST_OWNED_KIND" ||
			reasonCode === "POLICY_NEVER"
		) {
			continue;
		}
		insertCandidate(db, {
			principal,
			scopeKey,
			runId,
			seq,
			decided,
			decision,
			reasonCode,
			admittedItemId,
			content: (ref) => contentOf.get(sourceKey(ref)),
		});
	}
	finalizeRun(db, runId, seq, "settled", null, outputDigest, counts);
	writeProgress(
		db,
		principal,
		scopeKey,
		runId,
		seq,
		inputs,
		output.output.noChange ? "no_change" : "extracted",
	);
	return { status: "applied", ...counts };
}

// ---- 候補の参照・確認 ----

interface CandidateRow {
	readonly record: CandidateRecord;
	readonly ordinal: number;
	readonly replaces: {
		readonly itemId: string;
		readonly revision: number;
	} | null;
}

const NO_CANDIDATE_TOMBSTONE = `NOT EXISTS (SELECT 1 FROM memory_tombstone t
	WHERE t.target_type = 'candidate' AND t.target_id = c.candidate_id)`;

const CANDIDATE_COLUMNS = `c.candidate_id, c.run_id, c.scope_key, c.kind, c.subject, c.semantic_key,
	c.value_text, c.polarity, c.modality, c.temporal, c.decision, c.reason_code, c.evidence_ordinal,
	c.replaces_item_id, c.replaces_revision, c.created_seq`;

function loadCandidateEvidence(
	db: MemoryDb,
	candidateIds: readonly string[],
): Map<string, CandidateEvidenceRecord[]> {
	const byCandidate = new Map<string, CandidateEvidenceRecord[]>();
	if (candidateIds.length === 0) return byCandidate;
	const rows = all(
		db,
		`SELECT candidate_id, namespace, kind, source_id, representation, revision, digest,
			start_byte, end_byte, quote_digest
		FROM memory_candidate_evidence
		WHERE candidate_id IN (${placeholders(candidateIds.length)})
		ORDER BY candidate_id, idx`,
		[...candidateIds],
	);
	for (const row of rows) {
		const id = readText(row, "candidate_id");
		const representation = readNullableText(row, "representation");
		const list = byCandidate.get(id) ?? [];
		list.push({
			source: {
				namespace: readText(row, "namespace"),
				kind: readText(row, "kind"),
				id: readText(row, "source_id"),
				...(representation === null ? {} : { representation }),
				revision: readText(row, "revision"),
				digest: readText(row, "digest"),
				range: {
					startByte: readInteger(row, "start_byte"),
					endByte: readInteger(row, "end_byte"),
				},
			},
			quoteDigest: readText(row, "quote_digest"),
		});
		byCandidate.set(id, list);
	}
	return byCandidate;
}

function readCandidateRow(
	row: unknown,
	evidence: readonly CandidateEvidenceRecord[],
): CandidateRow {
	const subject = readText(row, "subject");
	if (
		subject !== "self" &&
		subject !== "unknown" &&
		!subject.startsWith("other:")
	) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	const decision = readEnumText(row, "decision", CANDIDATE_DECISIONS);
	const polarity = readNullableText(row, "polarity");
	const text = readNullableText(row, "value_text");
	if (decision !== "forgotten" && (polarity === null || text === null)) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	if (polarity !== null && polarity !== "affirmed" && polarity !== "negated") {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	const reason = readNullableText(row, "reason_code");
	const reasonCode =
		reason === null
			? null
			: readEnumText({ r: reason }, "r", ADMISSION_REASON_CODES);
	const replacesId = readNullableText(row, "replaces_item_id");
	const replacesRevision = readNullableInteger(row, "replaces_revision");
	return {
		record: {
			candidateId: readText(row, "candidate_id"),
			runId: readText(row, "run_id"),
			scopeKey: readText(row, "scope_key"),
			kind: readEnumText(row, "kind", STATE_KINDS),
			subject: subject as CandidateRecord["subject"],
			semanticKey: readText(row, "semantic_key"),
			value: { text: text ?? "", polarity: polarity ?? "affirmed" },
			modality: readEnumText(row, "modality", MODALITIES) as Modality,
			temporal: readEnumText(row, "temporal", TEMPORALS) as Temporal,
			decision,
			reasonCode,
			evidence,
			createdSeq: readInteger(row, "created_seq"),
		},
		ordinal: readInteger(row, "evidence_ordinal"),
		replaces:
			replacesId === null || replacesRevision === null
				? null
				: { itemId: replacesId, revision: replacesRevision },
	};
}

/** pending_user（既定）などの候補を新しい順に返す。forgotten と墓標のある候補は返さない。 */
export function listCandidates(
	db: MemoryDb,
	input: ListCandidatesInput,
): ListCandidatesResult {
	const parsed = parseListCandidatesInput(input);
	enterRead(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const rows = all(
		db,
		`SELECT ${CANDIDATE_COLUMNS} FROM memory_candidate c
		WHERE c.principal = ? AND c.scope_key = ? AND c.decision = ? AND ${NO_CANDIDATE_TOMBSTONE}
		ORDER BY c.created_seq DESC, c.run_id ASC, c.idx ASC
		LIMIT ?`,
		[
			parsed.access.principal,
			parsed.scopeKey,
			ownValue(parsed, "decision") ?? "pending_user",
			ownValue(parsed, "limit") ?? LIMITS_EXTRACTION.maxListedCandidates,
		],
	);
	const evidence = loadCandidateEvidence(
		db,
		rows.map((row) => readText(row, "candidate_id")),
	);
	return {
		status: "ok",
		candidates: rows.map(
			(row) =>
				readCandidateRow(row, evidence.get(readText(row, "candidate_id")) ?? [])
					.record,
		),
	};
}

/**
 * pending_user の候補をユーザーが採用／却下する。書き込み系。
 * admit: 候補の evidence の出典を `currentSources` で再検査し（墓標・版の変更で拒否）、state item を作る
 * （origin は `user_confirmed`、`editedValue` が候補と違えば `user_edited`）。settle 時に同 key の active と
 * 値が違っていた候補は、その active を CAS（revision）で置き換える。settle 後に別の active ができていた場合は
 * `ACTIVE_EXISTS`、置き換え対象が変わっていた場合は `STALE_REVISION` で拒否し、何も書かない。
 */
export function confirmCandidate(
	db: MemoryDb,
	input: ConfirmCandidateInput,
): ConfirmCandidateResult {
	const parsed = parseConfirmCandidateInput(input);
	const seq = enterWrite(db);
	if (!isPermitted(parsed.access, parsed.scopeKey)) {
		return { status: "not_permitted" };
	}
	const principal = parsed.access.principal;
	const scopeKey = parsed.scopeKey;
	const raw = first(
		db,
		`SELECT ${CANDIDATE_COLUMNS} FROM memory_candidate c
		WHERE c.candidate_id = ? AND c.principal = ? AND c.scope_key = ?`,
		[parsed.candidateId, principal, scopeKey],
	);
	if (raw === null) return { status: "missing" };
	if (isTombstoned(db, "candidate", parsed.candidateId)) {
		return { status: "forgotten" };
	}
	const evidence = loadCandidateEvidence(db, [parsed.candidateId]).get(
		parsed.candidateId,
	);
	const row = readCandidateRow(raw, evidence ?? []);
	const { record } = row;
	if (record.decision === "forgotten") return { status: "forgotten" };
	if (record.decision !== "pending_user") {
		return { status: "not_pending", decision: record.decision };
	}
	if (parsed.action === "reject") {
		run(
			db,
			`UPDATE memory_candidate
			SET decision = 'rejected', resolution = 'user_rejected', resolved_seq = ?
			WHERE candidate_id = ?`,
			[seq, parsed.candidateId],
		);
		return { status: "rejected" };
	}

	if (record.subject === "unknown") {
		return { status: "refused", reasonCode: "SUBJECT_KIND_MISMATCH" };
	}
	if (!isSubjectKindConsistent(record.subject, record.kind)) {
		return { status: "refused", reasonCode: "SUBJECT_KIND_MISMATCH" };
	}
	if (record.evidence.some((entry) => isSourceTombstoned(db, entry.source))) {
		return { status: "refused", reasonCode: "SOURCE_TOMBSTONED" };
	}
	const current = new Map<string, SourceState>();
	for (const source of parsed.currentSources) {
		if (source.principal === principal && source.scopeKey === scopeKey) {
			current.set(sourceKey(source), source);
		}
	}
	for (const entry of record.evidence) {
		const now = current.get(sourceKey(entry.source));
		if (now?.status === "forgotten") {
			return { status: "refused", reasonCode: "SOURCE_TOMBSTONED" };
		}
		if (
			now === undefined ||
			now.status !== "available" ||
			now.revision !== entry.source.revision ||
			now.digest !== entry.source.digest
		) {
			return { status: "refused", reasonCode: "SOURCE_STALE" };
		}
	}
	const editedValue = ownValue(parsed, "editedValue");
	const edited =
		editedValue !== undefined && !stateValueEquals(editedValue, record.value);
	const value: StateValue =
		edited && editedValue !== undefined ? editedValue : record.value;
	const origin: StateOrigin = edited ? "user_edited" : "user_confirmed";
	if (!(USER_STATE_ORIGINS as readonly string[]).includes(origin)) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	const written = writeStateForCandidate(db, {
		principal,
		scopeKey,
		atMs: parsed.clock.atMs,
		subject: record.subject,
		kind: record.kind,
		semanticKey: record.semanticKey,
		value,
		evidence: record.evidence,
		evidenceOrdinal: row.ordinal,
		origin,
		candidateId: record.candidateId,
		replaces: row.replaces,
	});
	if (written.status === "rejected") {
		return { status: "refused", reasonCode: written.reasonCode };
	}
	if (written.status !== "applied" && written.status !== "unchanged") {
		return { status: "refused", reasonCode: "STALE_REVISION" };
	}
	run(
		db,
		`UPDATE memory_candidate
		SET decision = 'admitted', resolution = 'user_admitted', resolved_seq = ?, admitted_item_id = ?
		WHERE candidate_id = ?`,
		[seq, written.itemId, parsed.candidateId],
	);
	const item = readStateItem(db, principal, scopeKey, written.itemId);
	if (item === null) throw new MemoryStoreError("CORRUPT_ROW");
	return { status: "admitted", item };
}

export * from "./forget.ts";
