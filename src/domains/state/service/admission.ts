/**
 * Admission 規則表（full-system-design §3.5）。純粋関数。Extraction（S5）と State の確認操作が同じ表を使う。
 *
 * 評価は上から順で、最初に当たった規則が決定する。順序は `ADMISSION_REASON_CODES` と同じ:
 *  1 INVALID_CANDIDATE          候補の値の不正（未知の kind・subject・enum、上限超過、evidence の個数）→ rejected
 *  2 QUOTE_MISMATCH             quote が range の bytes と不一致（文字境界外・範囲外を含む）→ rejected
 *  3 EVIDENCE_NOT_IN_INPUT      evidence の出典が run 入力にない → rejected
 *  4 SOURCE_STALE               出典が forgotten／版変更 → rejected
 *  5 HOST_OWNED_KIND            goal / decision / open_question → rejected
 *  6 MODALITY_QUOTED            modality が quoted / reported、または quote が括弧内 → pending_user
 *  7 MODALITY_NOT_ASSERTED      modality が hypothetical / question → rejected
 *  8 SUBJECT_OTHER              subject が other:* → pending_user（kind は other_person_note に固定）
 *  9 SUBJECT_UNKNOWN            subject が unknown → rejected
 * 10 TEMPORAL_NOT_CURRENT       temporal が past / future → pending_user（現在の状態にしない。§6.4(a) 過去の状態）
 * 11 NOT_USER_SOURCE            根拠の出典のどれかの role が user でない → pending_user
 * 12 OLDER_EVIDENCE             同 key の active と値が違い、根拠の順位が古い、または同 key の disputed の最新より古い → rejected
 * 13 （確認済み項目の保護）     同 key の active が user_confirmed / user_edited で値が違う → pending_user
 *                               （reasonCode は POLICY_REQUIRES_USER。抽出由来は確認済みの項目を黙って上書きしない）
 * 13b（dispute の継続）         同 key に disputed の item が残り（active なし、または active と値が違う）、根拠が disputed の最新以上
 *                               → pending_user（POLICY_REQUIRES_USER。dispute を自動で解消しない）
 * 13c（ユーザーが消したもの）   同 key で user_confirmed / user_edited の item を retract / deactivate 済み（active なし、
 *                               または active と値が違う）→ pending_user（POLICY_REQUIRES_USER。auto_admit でも自動で復活させない）
 * 14 POLICY_NEVER              kind の方針が never → rejected
 * 15 POLICY_REQUIRES_USER       kind の方針が user_confirm → pending_user
 *    （どれにも当たらず方針が auto_admit） admitted
 *
 * `never` の優先: 方針が never の kind では、6・8・10・11・13・13b・13c の `pending_user` は候補を作らず
 * `rejected` / `POLICY_NEVER` にする（contract: never = 候補も作らず rejected）。rejected になる規則
 * （1〜5・7・9・12）は理由が変わらないよう、そのままの reasonCode で先に当たる。
 *
 * 候補の schema 違反・未知フィールド・権限系フィールド（scope / confidence / status / origin）は
 * 出力の parse（S5）で `rejected_output` になる。ここに届くのは parse 済みの候補で、値の不正だけを 1 で見る。
 * 権限系の決定（scope・採用・origin）は常にこの関数と呼び出し側が行い、モデルの値は使わない。
 *
 * 出典: 規則表は本設計の独自設計（SAAA personal-state-core は subject / modality / kind ごとの方針を持たない）。
 * 根拠の新旧（11）は SAAA reducer.rs:440-455（より新しい根拠を持つ item を古い根拠で置き換えない）の考え方。
 */
import type { Polarity, StateSubject } from "../../../contracts/common.ts";
import {
	MODALITIES,
	POLARITIES,
	TEMPORALS,
} from "../../../contracts/common.ts";
import {
	HOST_OWNED_KINDS,
	MAX_EVIDENCE_PER_CANDIDATE,
} from "../../../contracts/admission-policy.ts";
import type { ExtractionSource, StateKeyHistory } from "../contracts/index.ts";
import {
	LIMITS_STATE,
	STATE_KINDS,
	USER_STATE_ORIGINS,
} from "../contracts/index.ts";
import type {
	AdmissionDecision,
	AdmissionPolicy,
	StateItemView,
	StateKind,
	StateValue,
} from "../contracts/index.ts";
import type { EvidenceSpan } from "../../../contracts/common.ts";
import type { SourceState } from "../../../contracts/types.ts";
import { isWellFormedUtf16, utf8ByteLength } from "../../../canonical/utf8.ts";
import { hasControlChars } from "../../../contracts/reader.ts";
import { ownValue } from "../../../contracts/own.ts";
import {
	checkEvidence,
	evidenceOrdinalOf,
	findInputSource,
	isQuotedSpan,
} from "./evidence.ts";
import { stateValueEquals } from "./value.ts";

/** parse 済みの抽出候補（モデルの値）。kind / subject / modality はモデルの文字列のまま受ける。 */
export interface AdmissionCandidate {
	readonly kind: string;
	readonly subject: string;
	readonly semanticKey: string;
	readonly value: { readonly text: string; readonly polarity: string };
	readonly modality: string;
	readonly temporal: string;
	/** quote 本文つき。 */
	readonly evidence: readonly EvidenceSpan[];
}

export interface AdmissionInput {
	readonly candidate: AdmissionCandidate;
	readonly principal: string;
	readonly scopeKey: string;
	/** run 入力の出典（本文・role・順位つき）。 */
	readonly inputSources: readonly ExtractionSource[];
	/** 判定時点の出典の現在状態（settle ではホストが読み直したもの）。 */
	readonly currentSources: readonly SourceState[];
	/** 同 (subject, effective kind, semanticKey) の現在の active（なければ null）。 */
	readonly activeForKey: StateItemView | null;
	/** 同 key の active 以外の履歴（disputed の最新の根拠順位、ユーザー由来 item の retract / deactivate）。省略は履歴なし。 */
	readonly keyHistory?: StateKeyHistory;
	readonly policy: AdmissionPolicy;
}

function isHostOwnedKind(kind: string): boolean {
	return (HOST_OWNED_KINDS as readonly string[]).includes(kind);
}

function isStateKind(kind: string): kind is StateKind {
	return (STATE_KINDS as readonly string[]).includes(kind);
}

function readSubject(subject: string): StateSubject | "unknown" | null {
	if (subject === "self" || subject === "unknown") return subject;
	if (
		subject.startsWith("other:") &&
		subject.length > "other:".length &&
		utf8ByteLength(subject) <= LIMITS_STATE.maxSubjectBytes &&
		isWellFormedUtf16(subject) &&
		!hasControlChars(subject)
	) {
		return subject as StateSubject;
	}
	return null;
}

function isSaneText(text: string, maxBytes: number): boolean {
	return (
		text.length > 0 &&
		isWellFormedUtf16(text) &&
		utf8ByteLength(text) <= maxBytes
	);
}

/** 識別子（semanticKey）: `isSaneText` に加えて制御文字なし。明示操作の入力 parse（`readIdentifier`）と同じ規則。 */
function isSaneIdentifier(text: string, maxBytes: number): boolean {
	return isSaneText(text, maxBytes) && !hasControlChars(text);
}

/** 規則 1。 */
function isInvalidCandidate(candidate: AdmissionCandidate): boolean {
	const subject = readSubject(candidate.subject);
	if (
		subject === null ||
		!(isStateKind(candidate.kind) || isHostOwnedKind(candidate.kind)) ||
		!isSaneIdentifier(
			candidate.semanticKey,
			LIMITS_STATE.maxSemanticKeyBytes,
		) ||
		!isSaneText(candidate.value.text, LIMITS_STATE.maxValueTextBytes) ||
		!(POLARITIES as readonly string[]).includes(candidate.value.polarity) ||
		!(MODALITIES as readonly string[]).includes(candidate.modality) ||
		!(TEMPORALS as readonly string[]).includes(candidate.temporal) ||
		candidate.evidence.length === 0 ||
		candidate.evidence.length > MAX_EVIDENCE_PER_CANDIDATE
	) {
		return true;
	}
	for (const span of candidate.evidence) {
		if (!isSaneText(span.quote, LIMITS_STATE.maxQuoteBytes)) return true;
	}
	// 自分の事柄を other_person_note にはできない（⇔ の片側）。
	return candidate.kind === "other_person_note" && subject === "self";
}

/**
 * 台帳に載るときの kind。subject が `other:*` なら `other_person_note` に固定、host 所有・未知の kind と
 * `unknown` subject は台帳に載らないので null。
 */
export function effectiveCandidateKind(
	candidate: Pick<AdmissionCandidate, "kind" | "subject">,
): StateKind | null {
	const subject = readSubject(candidate.subject);
	if (subject === null || subject === "unknown") return null;
	if (subject !== "self") return "other_person_note";
	return isStateKind(candidate.kind) && candidate.kind !== "other_person_note"
		? candidate.kind
		: null;
}

const REJECTED = (
	reasonCode: Extract<
		AdmissionDecision,
		{ decision: "rejected" }
	>["reasonCode"],
): AdmissionDecision => ({ decision: "rejected", reasonCode });
const PENDING = (
	reasonCode: Extract<
		AdmissionDecision,
		{ decision: "pending_user" }
	>["reasonCode"],
): AdmissionDecision => ({ decision: "pending_user", reasonCode });

export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
	const { candidate } = input;
	if (isInvalidCandidate(candidate)) return REJECTED("INVALID_CANDIDATE");

	const failure = checkEvidence({
		principal: input.principal,
		scopeKey: input.scopeKey,
		evidence: candidate.evidence,
		inputSources: input.inputSources,
		currentSources: input.currentSources,
	});
	if (failure !== null) return REJECTED(failure);

	if (isHostOwnedKind(candidate.kind)) return REJECTED("HOST_OWNED_KIND");

	// 方針が never の kind では、pending_user になる規則は候補を作らず rejected にする。
	// 台帳に載らない（kind を決められない）候補は方針を持たないので、そのまま pending のまま返す。
	const kind = effectiveCandidateKind(candidate);
	const pending = (
		reasonCode: Extract<
			AdmissionDecision,
			{ decision: "pending_user" }
		>["reasonCode"],
	): AdmissionDecision =>
		kind !== null && input.policy[kind] === "never"
			? REJECTED("POLICY_NEVER")
			: PENDING(reasonCode);

	const quotedSpan = candidate.evidence.some((span) => {
		const source = findInputSource(
			span.source,
			input.principal,
			input.scopeKey,
			input.inputSources,
		);
		return source !== undefined && isQuotedSpan(source.content, span);
	});
	if (
		candidate.modality === "quoted" ||
		candidate.modality === "reported" ||
		quotedSpan
	) {
		return pending("MODALITY_QUOTED");
	}
	if (
		candidate.modality === "hypothetical" ||
		candidate.modality === "question"
	) {
		return REJECTED("MODALITY_NOT_ASSERTED");
	}

	const subject = readSubject(candidate.subject);
	if (subject !== "self" && subject !== "unknown" && subject !== null) {
		return pending("SUBJECT_OTHER");
	}
	if (subject === "unknown") return REJECTED("SUBJECT_UNKNOWN");

	if (candidate.temporal === "past" || candidate.temporal === "future") {
		return pending("TEMPORAL_NOT_CURRENT");
	}

	const notUser = candidate.evidence.some(
		(span) =>
			findInputSource(
				span.source,
				input.principal,
				input.scopeKey,
				input.inputSources,
			)?.role !== "user",
	);
	if (notUser) return pending("NOT_USER_SOURCE");

	const ordinal = evidenceOrdinalOf({
		principal: input.principal,
		scopeKey: input.scopeKey,
		evidence: candidate.evidence,
		inputSources: input.inputSources,
	});
	const active = input.activeForKey;
	const history = ownValue(input, "keyHistory");
	const differsFromActive =
		active !== null &&
		!stateValueEquals(active.value, candidateValue(candidate));
	// 書き込みが新しい値を持ち込む（active がない、または active と値が違う）。
	const changesKey = active === null || differsFromActive;
	const disputedMax = history?.disputedMaxOrdinal ?? null;
	if (
		active !== null &&
		differsFromActive &&
		ordinal !== null &&
		ordinal < active.evidenceOrdinal
	) {
		return REJECTED("OLDER_EVIDENCE");
	}
	if (
		changesKey &&
		disputedMax !== null &&
		ordinal !== null &&
		ordinal < disputedMax
	) {
		return REJECTED("OLDER_EVIDENCE");
	}
	// 抽出由来は、ユーザーが確認／編集した active を黙って上書きしない（auto_admit でも確認に回す）。
	if (
		active !== null &&
		differsFromActive &&
		(USER_STATE_ORIGINS as readonly string[]).includes(active.origin)
	) {
		return pending("POLICY_REQUIRES_USER");
	}
	// dispute を自動で解消しない／ユーザーが明示的に消したものを自動で復活させない。
	if (changesKey && (disputedMax !== null || history?.userRemoved === true)) {
		return pending("POLICY_REQUIRES_USER");
	}

	const mode = kind === null ? "never" : input.policy[kind];
	if (mode === "never") return REJECTED("POLICY_NEVER");
	if (mode === "user_confirm") return PENDING("POLICY_REQUIRES_USER");
	return { decision: "admitted" };
}

/** 候補の値を StateValue にする（attributes はモデルから受けない）。parse 済みなので polarity は検査済み。 */
export function candidateValue(candidate: AdmissionCandidate): StateValue {
	return {
		text: candidate.value.text,
		polarity: candidate.value.polarity as Polarity,
	};
}
