/**
 * 記憶の候補（L1）の永続 API。契約は `src/domains/state/contracts/index.ts`。
 * 書き込みはホストの write transaction の中で 1 回呼ぶ（入口は `enterWrite`）。拒否・冪等では何も書かない。
 *
 * - 候補は `memory_inferred_candidate`（origin は `agent_inferred` だけ）と、根拠の行 `_evidence`（引用の本文は持たない）。
 *   観測の回数・観測した会話は根拠の行から導く。
 * - 依存辺: candidate → 根拠の出典（先頭が primary、残りは support）。既に昇格済みの state_item → candidate（derived_from）。
 *   出典を忘れると候補が、候補を忘れると昇格済みの item が閉包に入る。
 * - 忘却の閉包の適用は `scrubCandidate`（値と根拠の行を消し status を forgotten にする）を呼ぶ。墓標は呼び出し側が書く。
 * - 除外（`memory_exclusion` の candidate）された候補は、どの照会にも現れない。
 */
import type { EvidenceSpan } from "../../../contracts/common.ts";
import { ownValue } from "../../../contracts/own.ts";
import { sourceKey } from "../../../contracts/source-key.ts";
import type { SourceRef } from "../../../contracts/types.ts";
import { addDependency } from "../../../infrastructure/sqlite/dependency.ts";
import {
	issueSeq,
	readInteger,
	readNullableText,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";
import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import { isTombstoned } from "../../../infrastructure/sqlite/tombstone.ts";
import {
	CANDIDATE_STATUSES,
	LIMITS_CANDIDATE,
	STATE_KINDS,
} from "../contracts/index.ts";
import type {
	InferredCandidate,
	ListCandidatesInput,
	ListCandidatesResult,
	ReadCandidateInput,
	ReadCandidateResult,
	RecordCandidateInput,
	RecordCandidateResult,
	StateKind,
} from "../contracts/index.ts";
import { inferredCandidateId } from "../service/ids.ts";
import {
	parseListCandidatesInput,
	parseReadCandidateInput,
	parseRecordCandidateInput,
} from "../service/parse-recall.ts";
import { isSubjectKindConsistent } from "../service/reducer.ts";
import {
	checkUserEvidence,
	isPermitted,
	placeholders,
	run,
	selectAll,
	selectFirst,
} from "./index.ts";

const NO_CANDIDATE_TOMBSTONE = `NOT EXISTS (SELECT 1 FROM memory_tombstone t
	WHERE t.target_type = 'candidate' AND t.target_id = c.candidate_id)`;
const NOT_EXCLUDED = `NOT EXISTS (SELECT 1 FROM memory_exclusion x
	WHERE x.principal = c.principal AND x.scope_key = c.scope_key
		AND x.target_type = 'candidate' AND x.target_id = c.candidate_id)`;
const CANDIDATE_COLUMNS = `c.candidate_id, c.kind, c.subject, c.semantic_key, c.status,
	c.value_text, c.polarity, c.evidence_ordinal, c.promoted_item_id, c.created_seq, c.updated_seq`;

interface EvidenceRow {
	readonly ref: SourceRef;
	readonly conversationId: string | null;
	readonly observedMs: number;
}

function loadEvidenceRows(
	db: MemoryDb,
	candidateIds: readonly string[],
): Map<string, EvidenceRow[]> {
	const byCandidate = new Map<string, EvidenceRow[]>();
	if (candidateIds.length === 0) return byCandidate;
	const rows = selectAll(
		db,
		`SELECT candidate_id, namespace, kind, source_id, representation, revision, digest,
			start_byte, end_byte, conversation_id, observed_ms
		FROM memory_inferred_candidate_evidence
		WHERE candidate_id IN (${placeholders(candidateIds.length)})
		ORDER BY candidate_id, idx`,
		[...candidateIds],
	);
	for (const row of rows) {
		const representation = readNullableText(row, "representation");
		const id = readText(row, "candidate_id");
		const list = byCandidate.get(id) ?? [];
		list.push({
			ref: {
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
			conversationId: readNullableText(row, "conversation_id"),
			observedMs: readInteger(row, "observed_ms"),
		});
		byCandidate.set(id, list);
	}
	return byCandidate;
}

function readKind(row: unknown): StateKind {
	const kind = readText(row, "kind");
	const found = STATE_KINDS.find((candidate) => candidate === kind);
	if (found === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return found;
}

function hydrateCandidates(
	db: MemoryDb,
	scopeKey: string,
	rows: readonly unknown[],
): InferredCandidate[] {
	const evidence = loadEvidenceRows(
		db,
		rows.map((row) => readText(row, "candidate_id")),
	);
	return rows.map((row) => {
		const candidateId = readText(row, "candidate_id");
		const status = readText(row, "status");
		const found = CANDIDATE_STATUSES.find((entry) => entry === status);
		const polarity = readNullableText(row, "polarity");
		const text = readNullableText(row, "value_text");
		const subject = readText(row, "subject");
		if (
			found === undefined ||
			found === "forgotten" ||
			text === null ||
			(polarity !== "affirmed" && polarity !== "negated") ||
			!(subject === "self" || subject.startsWith("other:"))
		) {
			throw new MemoryStoreError("CORRUPT_ROW");
		}
		const list = evidence.get(candidateId) ?? [];
		const conversations: string[] = [];
		for (const entry of list) {
			if (
				entry.conversationId !== null &&
				!conversations.includes(entry.conversationId)
			) {
				conversations.push(entry.conversationId);
			}
		}
		const observed = list.map((entry) => entry.observedMs);
		const promotedItemId = readNullableText(row, "promoted_item_id");
		return {
			candidateId,
			scopeKey,
			status: found,
			kind: readKind(row),
			subject: subject as InferredCandidate["subject"],
			semanticKey: readText(row, "semantic_key"),
			value: { text, polarity },
			origin: "agent_inferred" as const,
			observationCount: list.length,
			conversationIds: conversations,
			evidence: list.map((entry) => entry.ref),
			firstObservedMs: observed.length === 0 ? 0 : Math.min(...observed),
			lastObservedMs: observed.length === 0 ? 0 : Math.max(...observed),
			...(promotedItemId === null ? {} : { promotedItemId }),
			createdSeq: readInteger(row, "created_seq"),
			updatedSeq: readInteger(row, "updated_seq"),
		};
	});
}

type LoadedCandidate =
	| { readonly status: "found"; readonly row: unknown }
	| { readonly status: "missing" | "forgotten" };

/** scope 内の候補を 1 件読む。他 scope・存在しない・除外されている → missing、墓標あり／forgotten → forgotten。 */
function loadCandidate(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	candidateId: string,
): LoadedCandidate {
	const row = selectFirst(
		db,
		`SELECT ${CANDIDATE_COLUMNS}, c.principal AS principal FROM memory_inferred_candidate c
		WHERE c.principal = ? AND c.scope_key = ? AND c.candidate_id = ?`,
		[principal, scopeKey, candidateId],
	);
	if (row === null) return { status: "missing" };
	if (isTombstoned(db, "candidate", candidateId))
		return { status: "forgotten" };
	if (readText(row, "status") === "forgotten") return { status: "forgotten" };
	const excluded = selectFirst(
		db,
		`SELECT 1 AS found FROM memory_exclusion
		WHERE principal = ? AND scope_key = ? AND target_type = 'candidate' AND target_id = ?`,
		[principal, scopeKey, candidateId],
	);
	if (excluded !== null) return { status: "missing" };
	return { status: "found", row };
}

function insertCandidateEvidence(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	candidateId: string,
	firstIdx: number,
	spans: readonly EvidenceSpan[],
	conversationId: string | undefined,
	atMs: number,
): void {
	for (const [offset, span] of spans.entries()) {
		const idx = firstIdx + offset;
		const ref = span.source;
		const range = ownValue(ref, "range");
		if (range === undefined) throw new MemoryStoreError("CORRUPT_ROW");
		const key = sourceKey(ref);
		run(
			db,
			`INSERT INTO memory_inferred_candidate_evidence
				(candidate_id, idx, source_key, namespace, kind, source_id, representation, revision, digest,
				 start_byte, end_byte, conversation_id, observed_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				candidateId,
				idx,
				key,
				ref.namespace,
				ref.kind,
				ref.id,
				ownValue(ref, "representation") ?? null,
				ref.revision,
				ref.digest,
				range.startByte,
				range.endByte,
				conversationId ?? null,
				atMs,
			],
		);
		addDependency(db, {
			principal,
			scopeKey,
			dependentType: "candidate",
			dependentId: candidateId,
			dependencyType: "source",
			dependencyId: key,
			role: idx === 0 ? "primary" : "support",
		});
	}
}

function readCandidateById(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	candidateId: string,
): InferredCandidate {
	const row = selectFirst(
		db,
		`SELECT ${CANDIDATE_COLUMNS} FROM memory_inferred_candidate c
		WHERE c.principal = ? AND c.scope_key = ? AND c.candidate_id = ?`,
		[principal, scopeKey, candidateId],
	);
	const [candidate] =
		row === null ? [] : hydrateCandidates(db, scopeKey, [row]);
	if (candidate === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return candidate;
}

/**
 * 候補の記録（観測の追加）。同じ (subject, kind, semanticKey, polarity, text) の open な候補へ観測を足し、無ければ作る。
 * 根拠は State と同じ検査に通す。同じ出典の同じ範囲は数えない（冪等）。
 */
export function recordCandidate(
	db: MemoryDb,
	rawInput: RecordCandidateInput,
): RecordCandidateResult {
	const input = parseRecordCandidateInput(rawInput);
	let seq = enterWrite(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = input.access.principal;
	const scopeKey = input.scopeKey;
	if (!isSubjectKindConsistent(input.subject, input.kind)) {
		return { status: "rejected", reasonCode: "SUBJECT_KIND_MISMATCH" };
	}
	const checked = checkUserEvidence(db, input);
	if (!checked.ok) {
		return {
			status: "rejected",
			reasonCode: checked.reasonCode as "QUOTE_MISMATCH",
		};
	}
	const existing = selectFirst(
		db,
		`SELECT candidate_id, evidence_ordinal FROM memory_inferred_candidate
		WHERE principal = ? AND scope_key = ? AND subject = ? AND kind = ? AND semantic_key = ?
			AND polarity = ? AND value_text = ? AND status = 'open'`,
		[
			principal,
			scopeKey,
			input.subject,
			input.kind,
			input.semanticKey,
			input.value.polarity,
			input.value.text,
		],
	);
	const known =
		existing === null
			? []
			: selectAll(
					db,
					`SELECT source_key, start_byte, end_byte FROM memory_inferred_candidate_evidence
					WHERE candidate_id = ?`,
					[readText(existing, "candidate_id")],
				);
	const seen = new Set(
		known.map(
			(row) =>
				`${readText(row, "source_key")}\u0001${readInteger(row, "start_byte")}\u0001${readInteger(row, "end_byte")}`,
		),
	);
	const fresh = input.evidence.filter((span) => {
		const range = ownValue(span.source, "range");
		if (range === undefined) return false;
		const key = `${sourceKey(span.source)}\u0001${range.startByte}\u0001${range.endByte}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (known.length + fresh.length > LIMITS_CANDIDATE.maxEvidencePerCandidate) {
		return { status: "rejected", reasonCode: "EVIDENCE_LIMIT_EXCEEDED" };
	}
	const conversationId = ownValue(input, "conversationId");
	let candidateId: string;
	let created = false;
	if (existing === null) {
		// 古い DB の復元で seq が巻き戻っても、墓標の付いた ID を再利用しない（State item と同じ）。
		while (
			isTombstoned(
				db,
				"candidate",
				inferredCandidateId(principal, scopeKey, seq),
			)
		) {
			seq = issueSeq(db);
		}
		candidateId = inferredCandidateId(principal, scopeKey, seq);
		created = true;
		run(
			db,
			`INSERT INTO memory_inferred_candidate
				(candidate_id, principal, scope_key, kind, subject, semantic_key, status, value_text, polarity,
				 origin, evidence_ordinal, created_seq, updated_seq)
			VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, 'agent_inferred', ?, ?, ?)`,
			[
				candidateId,
				principal,
				scopeKey,
				input.kind,
				input.subject,
				input.semanticKey,
				input.value.text,
				input.value.polarity,
				checked.ordinal,
				seq,
				seq,
			],
		);
	} else {
		candidateId = readText(existing, "candidate_id");
	}
	if (fresh.length > 0) {
		insertCandidateEvidence(
			db,
			principal,
			scopeKey,
			candidateId,
			known.length,
			fresh,
			conversationId,
			input.clock.atMs,
		);
		if (!created) {
			run(
				db,
				`UPDATE memory_inferred_candidate
				SET updated_seq = ?, evidence_ordinal = MAX(evidence_ordinal, ?) WHERE candidate_id = ?`,
				[seq, checked.ordinal, candidateId],
			);
		}
	}
	return {
		status: "recorded",
		created,
		newObservations: fresh.length,
		candidate: readCandidateById(db, principal, scopeKey, candidateId),
	};
}

/** 候補の一覧（既定は open）。除外・忘却された候補は返さない。順序は updatedSeq の降順、同じなら candidateId。 */
export function listCandidates(
	db: MemoryDb,
	rawInput: ListCandidatesInput,
): ListCandidatesResult {
	const input = parseListCandidatesInput(rawInput);
	enterRead(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const params: SqlValue[] = [
		input.access.principal,
		input.scopeKey,
		ownValue(input, "status") ?? "open",
	];
	let filter = "";
	const kinds = ownValue(input, "kinds");
	if (kinds !== undefined) {
		filter += ` AND c.kind IN (${placeholders(kinds.length)})`;
		params.push(...kinds);
	}
	const minObservations = ownValue(input, "minObservations");
	if (minObservations !== undefined) {
		filter += ` AND (SELECT COUNT(*) FROM memory_inferred_candidate_evidence e
			WHERE e.candidate_id = c.candidate_id) >= ?`;
		params.push(minObservations);
	}
	const after = ownValue(input, "after");
	if (after !== undefined) {
		filter +=
			" AND (c.updated_seq < ? OR (c.updated_seq = ? AND c.candidate_id > ?))";
		params.push(after.updatedSeq, after.updatedSeq, after.candidateId);
	}
	const pageSize =
		ownValue(input, "limit") ?? LIMITS_CANDIDATE.maxListCandidates;
	params.push(pageSize + 1);
	const rows = selectAll(
		db,
		`SELECT ${CANDIDATE_COLUMNS} FROM memory_inferred_candidate c
		WHERE c.principal = ? AND c.scope_key = ? AND c.status = ?${filter}
			AND ${NO_CANDIDATE_TOMBSTONE} AND ${NOT_EXCLUDED}
		ORDER BY c.updated_seq DESC, c.candidate_id ASC
		LIMIT ?`,
		params,
	);
	const candidates = hydrateCandidates(
		db,
		input.scopeKey,
		rows.slice(0, pageSize),
	);
	const last = candidates.at(-1);
	return {
		status: "ok",
		candidates,
		...(rows.length > pageSize && last !== undefined
			? {
					nextCursor: {
						updatedSeq: last.updatedSeq,
						candidateId: last.candidateId,
					},
				}
			: {}),
	};
}

/** 候補を 1 件読む（昇格済み・却下済みも読める）。除外されたものは `missing`。 */
export function readCandidate(
	db: MemoryDb,
	rawInput: ReadCandidateInput,
): ReadCandidateResult {
	const input = parseReadCandidateInput(rawInput);
	enterRead(db);
	if (!isPermitted(input.access, input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const loaded = loadCandidate(
		db,
		input.access.principal,
		input.scopeKey,
		input.candidateId,
	);
	if (loaded.status !== "found") return { status: loaded.status };
	const [candidate] = hydrateCandidates(db, input.scopeKey, [loaded.row]);
	if (candidate === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return { status: "ok", candidate };
}

// ---- 忘却（lifecycle の閉包適用が呼ぶ。reducer を通さない）----

export interface ScrubbedCandidate {
	/** 行が principal のものなら scope。行がない／他 principal の行なら null（何も書かない）。 */
	readonly scopeKey: string | null;
	/** 今回 `forgotten` に遷移したか（既に forgotten なら false）。 */
	readonly transitioned: boolean;
}

/**
 * 候補の値を消す（冪等）。value_text / polarity / promoted_* を NULL、semantic_key を ''、他人の subject を `other:`、
 * status を `forgotten`、根拠の行を削除する。初めて forgotten になるときだけ updated_seq を進める。墓標は呼び出し側が書く。
 */
export function scrubCandidate(
	db: MemoryDb,
	principal: string,
	candidateId: string,
	opSeq: number,
): ScrubbedCandidate {
	const row = selectFirst(
		db,
		"SELECT principal, scope_key, status FROM memory_inferred_candidate WHERE candidate_id = ?",
		[candidateId],
	);
	if (row === null || readText(row, "principal") !== principal) {
		return { scopeKey: null, transitioned: false };
	}
	const transitioned = readText(row, "status") !== "forgotten";
	run(
		db,
		"DELETE FROM memory_inferred_candidate_evidence WHERE candidate_id = ?",
		[candidateId],
	);
	run(
		db,
		`UPDATE memory_inferred_candidate SET status = 'forgotten', semantic_key = '', value_text = NULL,
			subject = CASE WHEN subject = 'self' THEN 'self' ELSE 'other:' END,
			polarity = NULL, promoted_item_id = NULL, promoted_run_id = NULL,
			updated_seq = CASE WHEN status = 'forgotten' THEN updated_seq ELSE ? END
		WHERE candidate_id = ?`,
		[opSeq, candidateId],
	);
	run(
		db,
		`DELETE FROM memory_exclusion WHERE principal = ? AND target_type = 'candidate' AND target_id = ?`,
		[principal, candidateId],
	);
	return { scopeKey: readText(row, "scope_key"), transitioned };
}

/** scope の候補の ID（`createdBefore` が非 null ならその seq より前に作られたものだけ）。 */
export function listCandidateIdsInScope(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	createdBefore: number | null,
): string[] {
	const params: SqlValue[] = [principal, scopeKey];
	let extra = "";
	if (createdBefore !== null) {
		extra = " AND created_seq < ?";
		params.push(createdBefore);
	}
	return selectAll(
		db,
		`SELECT candidate_id FROM memory_inferred_candidate WHERE principal = ? AND scope_key = ?${extra}
		ORDER BY candidate_id ASC`,
		params,
	).map((entry) => readText(entry, "candidate_id"));
}

/** 候補の principal・scope・status（forget の target 検査用）。行がなければ null。 */
export function candidateScope(
	db: MemoryDb,
	candidateId: string,
): {
	readonly principal: string;
	readonly scopeKey: string;
	readonly status: string;
} | null {
	const row = selectFirst(
		db,
		"SELECT principal, scope_key, status FROM memory_inferred_candidate WHERE candidate_id = ?",
		[candidateId],
	);
	return row === null
		? null
		: {
				principal: readText(row, "principal"),
				scopeKey: readText(row, "scope_key"),
				status: readText(row, "status"),
			};
}
