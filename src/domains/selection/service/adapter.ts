import { periodBoundsMs, periodFromStateMs } from "../../temporal/index.ts";
import type { StateItem } from "../../state/contracts/index.ts";
import type {
	Duration,
	RequiredReason,
	ScopeGrant,
	ScopeKind,
	SelectionCandidate,
	SelectionSignals,
} from "../contracts/index.ts";

export interface StateCandidateOptions {
	/**
	 * 過去の照会のための読み取り。置き換えられた（superseded）・停止した（inactive）項目も候補にする。
	 * 撤回（retracted）・無効（invalidated）・係争中（disputed）の項目は常に候補にしない。
	 * State は置き換え・停止の時点で期間を閉じないので、`endedAtMs`（その項目が現在の理解でなくなった時刻。
	 * ホストが変更の履歴から求める）が必要で、無ければ候補にしない（期間が開いたままの旧版が、後の時点でも
	 * 新しい版と競合するのを防ぐ）。逆に、新しい版は開始が開いている（最初から成立していた扱い）ので、
	 * `valid_then` で古い時点を問うと旧版と新版が競合しうる。その場合は新版に `period.from`（成立開始）を持たせる。
	 */
	readonly historical?: boolean;
	readonly endedAtMs?: number;
	/**
	 * 記録した時点（ホスト時計）。State は ms の時刻を持たないので、ホストが項目ごとに求めて渡す
	 * （全項目に同じ値を使うと、過去の照会の「当時すでに記録されていたか」の判定が意味を失う）。
	 */
	readonly recordedAtMs: number;
	readonly requiredReason?: RequiredReason;
	readonly duration?: Duration;
	readonly requestId?: string;
	readonly explicit?: boolean;
	readonly exception?: boolean;
	readonly signals?: SelectionSignals;
	readonly stale?: boolean;
}

const NO_SIGNALS: SelectionSignals = Object.freeze({
	explicitRef: false,
	termMatches: 0,
	subjectMatch: false,
});

/**
 * State item を選択の候補にする（対象にならない項目は null）。否定の値は view と同じ `NOT: ` を前置する。矛盾の単位は
 * (kind, semanticKey)、値の同一性は (極性, 本文)。精度つきの期間があればそれを、なければ ms の境界を使う。
 */
export function candidateFromStateItem(
	item: StateItem,
	options: StateCandidateOptions,
): SelectionCandidate | null {
	// 本人の項目（self）だけ。他者のメモは読み出し側（readMemorySnapshotPart）と同じく選択に入れない。
	if (item.subject !== "self") return null;
	const usable =
		item.status === "active" ||
		(options.historical === true &&
			(item.status === "superseded" || item.status === "inactive"));
	if (!usable) return null;
	const ended = item.status !== "active";
	if (ended && options.endedAtMs === undefined) return null;
	let period =
		item.validity ?? periodFromStateMs(item.validFromMs, item.validUntilMs);
	if (ended) {
		// 現在の理解でなくなった時刻で期間を閉じる（既に早く終わる期間ならそのまま）。
		const bounds = period === undefined ? null : periodBoundsMs(period);
		const until = Math.min(
			bounds?.endMs ?? Number.POSITIVE_INFINITY,
			options.endedAtMs as number,
		);
		if (bounds?.startMs != null && until <= bounds.startMs) return null;
		period = {
			...(bounds?.startMs == null ? {} : { fromMs: bounds.startMs }),
			untilMs: until,
			// 元の根拠を保つ（時点不明の期間を、終わりを足したことで「明示された期間」に格上げしない）。
			basis: period?.basis ?? "stated",
		};
	}
	return {
		id: item.itemId,
		revision: String(item.revision),
		scopeKey: item.scopeKey,
		text: `${item.value.polarity === "negated" ? "NOT: " : ""}${item.value.text}`,
		...(options.requiredReason === undefined
			? {}
			: { requiredReason: options.requiredReason }),
		duration: options.duration ?? "ongoing",
		...(options.requestId === undefined
			? {}
			: { requestId: options.requestId }),
		conflictKey: `${item.subject}:${item.kind}:${item.semanticKey}`,
		valueKey: `${item.value.polarity}:${item.value.text}`,
		...(options.explicit === undefined ? {} : { explicit: options.explicit }),
		...(options.exception === undefined
			? {}
			: { exception: options.exception }),
		recordedAtMs: options.recordedAtMs,
		...(period === undefined ? {} : { period }),
		signals: options.signals ?? NO_SIGNALS,
		...(options.stale === undefined ? {} : { stale: options.stale }),
	};
}

/**
 * 認可済み参照を作る。`authorizationRevision` はホストが持つ認可の版（scope の内容の版ではない）。
 * 内容の版（`listStateScopes` の revision）は書き込みのたびに進むので、認可の版として使うと、
 * 同じ scope への無関係な書き込みで回答が失効してしまう。
 */
export function grantFromScope(
	scope: { readonly scopeKey: string },
	kind: ScopeKind,
	authorizationRevision: string,
): ScopeGrant {
	return { scopeKey: scope.scopeKey, kind, revision: authorizationRevision };
}

/** `listStateScopes` の結果のうち、上限で打ち切られた scope があるか（`SelectionInput.retrieval.truncated` に渡す）。 */
export function anyScopeTruncated(
	scopes: readonly { readonly truncated: boolean }[],
): boolean {
	return scopes.some((scope) => scope.truncated);
}
