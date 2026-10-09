/**
 * State 台帳の遷移 reducer（純粋。時計・乱数・IO なし。full-system-design §3.5）。
 *
 * 規則の出典（SAAA personal-state-core、HEAD 28616e61ce5fe853383d4af6ec14e5b5d542c076、MIT。
 * コードは写さず、規則を本設計の語彙で独自に再実装した）:
 * - 遷移が status を決める（assert → active、dispute → disputed、supersede → superseded、
 *   retract → retracted、invalidate → invalidated）: crates/personal-state-core/src/reducer.rs:104-114。
 * - assert 以外の遷移は、対象が既存で status が活きている場合だけ許す（それ以外は INVALID_TRANSITION）:
 *   reducer.rs:417-430。本設計は `active / inactive / disputed` を活きているとみなす。
 * - 同 (kind, semanticKey) の active は 1 件（衝突は ACTIVE_EXISTS）: reducer.rs:466-474。
 * - 同 key のより新しい根拠を持つ item がすでにあるとき、古い根拠での置き換えを拒む（OLDER_EVIDENCE）:
 *   reducer.rs:440-455。新旧は出典の順位（本設計では `evidenceOrdinal`）で比べる。
 * - supersede は同 kind・同 key の別 item への置き換えだけ許し、自分自身への置き換えを拒む: reducer.rs:476-495。
 * - 依存の forget / invalidate は閉包で確定書き込みする（reducer を通さない）: reducer.rs:503-571 の意図。
 *
 * 本設計独自（SAAA に無い）: CAS（expectedRevision）、subject（self / other:*）と kind の同値検査、
 * 明示操作（user_confirmed / user_edited）が新旧比較を受けないこと、根拠の新旧が同じで値が違うときの dispute、
 * deactivate / reactivate（可逆）、同値の明示確認による origin の昇格（抽出由来 → user 由来。降格はしない）、
 * 同 key の履歴（`StateKeyHistory`）の扱い: disputed の item より古い根拠は `OLDER_EVIDENCE`、同順位以上でも
 * dispute を黙って解消せず disputed のまま加わる、ユーザー由来 item を retract / deactivate した key へは
 * 抽出由来を書かない（`INVALID_TRANSITION`。Admission は先に `pending_user` にする）。
 *
 * `forget` は reducer を通さない（lifecycle が閉包で value を消し status を `forgotten` にする）。
 * action に `forget` や未知の値が来たら INVALID_TRANSITION。
 */
import type { StateSubject } from "../../../contracts/common.ts";
import type {
	StateCause,
	StateEventAction,
	StateEventDraft,
	StateItemStatus,
	StateItemView,
	StateKind,
	StateKeyHistory,
	StateOrigin,
	StateTransition,
	StateTransitionContext,
	StateTransitionResult,
	StateValue,
	StateReasonCode,
} from "../contracts/index.ts";
import { USER_STATE_ORIGINS } from "../contracts/index.ts";
import { ownValue } from "../../../contracts/own.ts";
import { stateValueEquals } from "./value.ts";

const NO_KEY_HISTORY: StateKeyHistory = Object.freeze({
	disputedMaxOrdinal: null,
	userRemoved: false,
});

/**
 * 新しい item（assert / supersede が作る側）の同一性。`StateTransition` は ID・subject・kind・semanticKey を
 * 持たないので、新規 item を作る遷移だけが別に受ける（契約型の拡張。親へ契約への取り込みを要求済み）。
 */
export interface StateItemIdentity {
	readonly itemId: string;
	readonly subject: StateSubject;
	readonly kind: StateKind;
	readonly semanticKey: string;
}

export interface StateTransitionRequest extends StateTransition {
	/** `assert` と `supersede` では必須（`supersede` は current と同じ subject / kind / semanticKey）。 */
	readonly identity?: StateItemIdentity;
}

function keyHistoryOf(context: StateTransitionContext): StateKeyHistory {
	return ownValue(context, "keyHistory") ?? NO_KEY_HISTORY;
}

/** 活きている status（遷移の対象にできる）。 */
const LIVE_STATUSES: readonly StateItemStatus[] = [
	"active",
	"inactive",
	"disputed",
];

function reject(reasonCode: StateReasonCode): StateTransitionResult {
	return { ok: false, reasonCode };
}

/** 状態が変わらない（冪等）。items / events が空。 */
const UNCHANGED: StateTransitionResult = Object.freeze({
	ok: true,
	items: Object.freeze([]),
	events: Object.freeze([]),
});

function isExplicitOrigin(origin: StateOrigin | undefined): boolean {
	return (
		origin !== undefined &&
		(USER_STATE_ORIGINS as readonly string[]).includes(origin)
	);
}

function event(
	itemId: string,
	action: StateEventAction,
	fromRevision: number | null,
	toRevision: number | null,
	cause: StateCause,
	atMs: number,
): StateEventDraft {
	return { itemId, action, fromRevision, toRevision, cause, atMs };
}

/** `kind === "other_person_note"` ⇔ subject が `other:*`（それ以外の kind は `self`）。 */
export function isSubjectKindConsistent(
	subject: string,
	kind: string,
): boolean {
	const isOther = subject.startsWith("other:") && subject.length > 6;
	if (kind === "other_person_note") return isOther;
	return subject === "self";
}

function sameKey(a: StateItemIdentity, b: StateItemView): boolean {
	return (
		a.subject === b.subject &&
		a.kind === b.kind &&
		a.semanticKey === b.semanticKey
	);
}

function withStatus(
	item: StateItemView,
	status: StateItemStatus,
	revision: number,
): StateItemView {
	return { ...item, status, revision };
}

/** 既存 item への遷移の CAS。通れば null、通らなければ reasonCode。 */
function checkCas(
	current: StateItemView | null,
	transition: StateTransition,
): StateReasonCode | null {
	if (current === null || transition.expectedRevision === null) {
		return "INVALID_TRANSITION";
	}
	if (transition.expectedRevision !== current.revision) return "STALE_REVISION";
	return null;
}

interface NewItemFields {
	readonly identity: StateItemIdentity;
	readonly value: StateValue;
	readonly origin: StateOrigin;
	readonly evidenceOrdinal: number;
}

function readNewItemFields(
	transition: StateTransitionRequest,
): NewItemFields | null {
	const identity = ownValue(transition, "identity");
	const value = ownValue(transition, "value");
	const origin = ownValue(transition, "origin");
	const evidenceOrdinal = ownValue(transition, "evidenceOrdinal");
	if (
		identity === undefined ||
		value === undefined ||
		origin === undefined ||
		evidenceOrdinal === undefined
	) {
		return null;
	}
	return { identity, value, origin, evidenceOrdinal };
}

function newItem(
	fields: NewItemFields,
	status: StateItemStatus,
	revision: number,
): StateItemView {
	return {
		itemId: fields.identity.itemId,
		subject: fields.identity.subject,
		kind: fields.identity.kind,
		semanticKey: fields.identity.semanticKey,
		status,
		revision,
		value: fields.value,
		origin: fields.origin,
		evidenceOrdinal: fields.evidenceOrdinal,
	};
}

/** old(active) を `superseded` にし、新 item を active で作る。items の順は [old, new]（old を先に書く）。 */
function supersedeWith(
	old: StateItemView,
	fields: NewItemFields,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	const { cause } = transition;
	const { atMs } = context;
	return {
		ok: true,
		items: [
			withStatus(old, "superseded", old.revision + 1),
			newItem(fields, "active", 1),
		],
		events: [
			event(
				old.itemId,
				"supersede",
				old.revision,
				old.revision + 1,
				cause,
				atMs,
			),
			event(fields.identity.itemId, "assert", null, 1, cause, atMs),
		],
	};
}

/** 根拠の新旧が同じで値が違う: 双方 disputed（view に入らない）。 */
function disputeWith(
	old: StateItemView,
	fields: NewItemFields,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	const { cause } = transition;
	const { atMs } = context;
	const id = fields.identity.itemId;
	return {
		ok: true,
		items: [
			withStatus(old, "disputed", old.revision + 1),
			newItem(fields, "disputed", 2),
		],
		events: [
			event(old.itemId, "dispute", old.revision, old.revision + 1, cause, atMs),
			event(id, "assert", null, 1, cause, atMs),
			event(id, "dispute", 1, 2, cause, atMs),
		],
	};
}

/**
 * 同値の明示確認: active が抽出由来で、明示操作が同じ値を書いたとき、値は変えず origin だけを user 由来へ上げる
 * （revision +1、event は `edit`）。user 由来の item は変えない（降格しない）。昇格しないなら null。
 */
function promoteOrigin(
	current: StateItemView,
	origin: StateOrigin,
	cause: StateCause,
	atMs: number,
): StateTransitionResult | null {
	if (current.origin !== "admitted_extraction" || !isExplicitOrigin(origin)) {
		return null;
	}
	return {
		ok: true,
		items: [{ ...current, revision: current.revision + 1, origin }],
		events: [
			event(
				current.itemId,
				"edit",
				current.revision,
				current.revision + 1,
				cause,
				atMs,
			),
		],
	};
}

/**
 * 抽出由来の書き込みが、同 key の active 以外の履歴に当たるか。当たらなければ null。
 * - ユーザー由来の item を retract / deactivate した key: 自動で復活させない（INVALID_TRANSITION）。
 * - disputed の item より古い根拠: OLDER_EVIDENCE。
 */
function checkAgainstHistory(
	fields: NewItemFields,
	history: StateKeyHistory,
): StateTransitionResult | null {
	if (history.userRemoved) return reject("INVALID_TRANSITION");
	if (
		history.disputedMaxOrdinal !== null &&
		fields.evidenceOrdinal < history.disputedMaxOrdinal
	) {
		return reject("OLDER_EVIDENCE");
	}
	return null;
}

/** active が無いが disputed が残る key への抽出由来の書き込み: dispute を解消せず、新しい item も disputed で加わる。 */
function joinDispute(
	fields: NewItemFields,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	const { cause } = transition;
	const id = fields.identity.itemId;
	return {
		ok: true,
		items: [newItem(fields, "disputed", 2)],
		events: [
			event(id, "assert", null, 1, cause, context.atMs),
			event(id, "dispute", 1, 2, cause, context.atMs),
		],
	};
}

/**
 * 抽出由来（admitted_extraction）の値が既存 active と衝突したときの解決。
 * 根拠の順位が新しい → supersede、古い → OLDER_EVIDENCE、同じ → dispute。
 * 明示操作はここを通らない（CAS だけ）。
 */
function resolveAgainstActive(
	active: StateItemView,
	fields: NewItemFields,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	if (fields.evidenceOrdinal > active.evidenceOrdinal) {
		return supersedeWith(active, fields, transition, context);
	}
	if (fields.evidenceOrdinal < active.evidenceOrdinal) {
		return reject("OLDER_EVIDENCE");
	}
	return disputeWith(active, fields, transition, context);
}

function applyAssert(
	current: StateItemView | null,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	if (current !== null || transition.expectedRevision !== null) {
		return reject("INVALID_TRANSITION");
	}
	const fields = readNewItemFields(transition);
	if (fields === null) return reject("INVALID_TRANSITION");
	if (!isSubjectKindConsistent(fields.identity.subject, fields.identity.kind)) {
		return reject("SUBJECT_KIND_MISMATCH");
	}
	const active = context.activeForKey;
	const history = keyHistoryOf(context);
	if (active === null) {
		if (!isExplicitOrigin(fields.origin)) {
			const blocked = checkAgainstHistory(fields, history);
			if (blocked !== null) return blocked;
			if (history.disputedMaxOrdinal !== null) {
				return joinDispute(fields, transition, context);
			}
		}
		return {
			ok: true,
			items: [newItem(fields, "active", 1)],
			events: [
				event(
					fields.identity.itemId,
					"assert",
					null,
					1,
					transition.cause,
					context.atMs,
				),
			],
		};
	}
	if (active.status !== "active" || !sameKey(fields.identity, active)) {
		return reject("INVALID_TRANSITION");
	}
	if (stateValueEquals(active.value, fields.value)) {
		return (
			promoteOrigin(active, fields.origin, transition.cause, context.atMs) ??
			UNCHANGED
		);
	}
	if (!isExplicitOrigin(fields.origin)) {
		return (
			checkAgainstHistory(fields, history) ??
			resolveAgainstActive(active, fields, transition, context)
		);
	}
	return reject("ACTIVE_EXISTS");
}

function applySupersede(
	current: StateItemView | null,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	const cas = checkCas(current, transition);
	if (cas !== null || current === null)
		return reject(cas ?? "INVALID_TRANSITION");
	const fields = readNewItemFields(transition);
	if (fields === null) return reject("INVALID_TRANSITION");
	if (current.status !== "active") return reject("INVALID_TRANSITION");
	if (
		fields.identity.itemId === current.itemId ||
		!sameKey(fields.identity, current) ||
		(context.activeForKey !== null &&
			context.activeForKey.itemId !== current.itemId)
	) {
		return reject("REPLACES_MISMATCH");
	}
	if (stateValueEquals(current.value, fields.value)) {
		return (
			promoteOrigin(current, fields.origin, transition.cause, context.atMs) ??
			UNCHANGED
		);
	}
	if (!isExplicitOrigin(fields.origin)) {
		return (
			checkAgainstHistory(fields, keyHistoryOf(context)) ??
			resolveAgainstActive(current, fields, transition, context)
		);
	}
	return supersedeWith(current, fields, transition, context);
}

/** status だけが変わる単純遷移。`from` にない status は INVALID_TRANSITION、`to` にいれば UNCHANGED。 */
function simpleStatusChange(
	current: StateItemView | null,
	transition: StateTransition,
	context: StateTransitionContext,
	action: StateEventAction,
	from: readonly StateItemStatus[],
	to: StateItemStatus,
	requiresNoOtherActive: boolean,
): StateTransitionResult {
	const cas = checkCas(current, transition);
	if (cas !== null || current === null)
		return reject(cas ?? "INVALID_TRANSITION");
	if (current.status === to) return UNCHANGED;
	if (!from.includes(current.status)) return reject("INVALID_TRANSITION");
	if (
		requiresNoOtherActive &&
		context.activeForKey !== null &&
		context.activeForKey.itemId !== current.itemId
	) {
		return reject("ACTIVE_EXISTS");
	}
	return {
		ok: true,
		items: [withStatus(current, to, current.revision + 1)],
		events: [
			event(
				current.itemId,
				action,
				current.revision,
				current.revision + 1,
				transition.cause,
				context.atMs,
			),
		],
	};
}

function applyEdit(
	current: StateItemView | null,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	const cas = checkCas(current, transition);
	if (cas !== null || current === null)
		return reject(cas ?? "INVALID_TRANSITION");
	const value = ownValue(transition, "value");
	const requestedOrigin = ownValue(transition, "origin");
	if (
		value === undefined ||
		(requestedOrigin !== undefined && !isExplicitOrigin(requestedOrigin))
	) {
		return reject("INVALID_TRANSITION");
	}
	if (!LIVE_STATUSES.includes(current.status)) {
		return reject("INVALID_TRANSITION");
	}
	const origin = requestedOrigin ?? "user_edited";
	if (stateValueEquals(current.value, value)) {
		return (
			promoteOrigin(current, origin, transition.cause, context.atMs) ??
			UNCHANGED
		);
	}
	const next: StateItemView = {
		...current,
		revision: current.revision + 1,
		value,
		origin,
		evidenceOrdinal:
			ownValue(transition, "evidenceOrdinal") ?? current.evidenceOrdinal,
	};
	return {
		ok: true,
		items: [next],
		events: [
			event(
				current.itemId,
				"edit",
				current.revision,
				next.revision,
				transition.cause,
				context.atMs,
			),
		],
	};
}

/**
 * 遷移を 1 つ適用する。戻りの `items` は状態が変わった item の変更後の像（`supersede` / `dispute` は
 * 旧 → 新の順）、`events` は追記する event の下書き。`items` と `events` が空なら冪等（`unchanged`）。
 * 副作用はない。永続化（同 key 一意の維持、依存辺、seq の発行）は呼び出し側（`src/domains/state/repository/index.ts`）。
 *
 * - `assert`: `current` と `expectedRevision` は null、`identity` / `value` / `origin` / `evidenceOrdinal` が必須。
 *   active が無ければ新規 active（抽出由来で同 key に disputed が残るときは `context.keyHistory` の規則）。ある場合、
 *   同値は冪等（ただし抽出由来の active に明示操作が同値を書けば origin を昇格）、明示操作は ACTIVE_EXISTS、
 *   抽出由来は根拠の新旧で supersede / OLDER_EVIDENCE / dispute。
 * - `supersede`: current（active）を CAS で置き換える。同じ新旧規則（抽出由来のみ）。
 * - `edit`: active / inactive / disputed の値を変える。status は変わらない（同値でも抽出由来なら origin を昇格）。
 * - `deactivate`: active → inactive。`reactivate`: inactive → active。`activate`: disputed → active（紛争の解決）。
 *   `retract`: active / inactive / disputed → retracted。`invalidate`: active / inactive / disputed → invalidated。
 *   `dispute`: active → disputed。
 */
export function applyStateTransition(
	current: StateItemView | null,
	transition: StateTransitionRequest,
	context: StateTransitionContext,
): StateTransitionResult {
	switch (transition.action) {
		case "assert":
			return applyAssert(current, transition, context);
		case "supersede":
			return applySupersede(current, transition, context);
		case "edit":
			return applyEdit(current, transition, context);
		case "deactivate":
			return simpleStatusChange(
				current,
				transition,
				context,
				"deactivate",
				["active"],
				"inactive",
				false,
			);
		case "reactivate":
			return simpleStatusChange(
				current,
				transition,
				context,
				"reactivate",
				["inactive"],
				"active",
				true,
			);
		case "activate":
			return simpleStatusChange(
				current,
				transition,
				context,
				"activate",
				["disputed"],
				"active",
				true,
			);
		case "dispute":
			return simpleStatusChange(
				current,
				transition,
				context,
				"dispute",
				["active"],
				"disputed",
				false,
			);
		case "retract":
			return simpleStatusChange(
				current,
				transition,
				context,
				"retract",
				LIVE_STATUSES,
				"retracted",
				false,
			);
		case "invalidate":
			return simpleStatusChange(
				current,
				transition,
				context,
				"invalidate",
				LIVE_STATUSES,
				"invalidated",
				false,
			);
		default:
			// `forget`（lifecycle の閉包適用が行う）と実行時に渡された未知の action。
			return reject("INVALID_TRANSITION");
	}
}
