import { sha256Hex } from "../canonical/sha256.ts";
import { encodeUtf8, isUtf8CharBoundary } from "../canonical/utf8.ts";
import type { SourceReasonCode } from "../contracts/reason-codes.ts";
import type { Snapshot, SourceRef, SourceState } from "../contracts/types.ts";
import { MEMORY_SOURCE_NAMESPACE } from "../contracts/common.ts";
import { ownValue } from "../contracts/own.ts";
import { compareSourceRef, sourceKey } from "./source-ref.ts";

export function indexSources(
	sources: readonly SourceState[],
): ReadonlyMap<string, SourceState> {
	const index = new Map<string, SourceState>();
	for (const source of sources) index.set(sourceKey(source), source);
	return index;
}

interface ContentInfo {
	readonly bytes: Uint8Array;
	readonly digest: string;
}

type SnapshotSources = Pick<Snapshot, "principal" | "scopeKey" | "sources">;

/**
 * 出典 1 件の検査（build 3a–3k / validate V7 の 1 要素分）。呼び出しローカルの content メモを閉じ込める。
 * `relaxMemoryRanges` が true（v2）のとき、Memory 所有の出典（namespace `memory`。Records）は
 * range があっても content が無ければ範囲検査を省く: 版・digest が本文を固定し、範囲は書き込み時に
 * 検証済みだから。content があれば範囲・文字境界は検査する。ホスト所有の出典と v1 は、range に content 必須。
 */
function createRefChecker(
	snapshot: SnapshotSources,
	relaxMemoryRanges: boolean,
): (ref: SourceRef) => SourceReasonCode | null {
	const sources = indexSources(snapshot.sources);
	// 呼び出しローカルのメモ。モジュール状態は持たない。
	const contents = new Map<string, ContentInfo>();

	const contentOf = (key: string, content: string): ContentInfo => {
		let info = contents.get(key);
		if (info === undefined) {
			const bytes = encodeUtf8(content);
			info = { bytes, digest: sha256Hex(bytes) };
			contents.set(key, info);
		}
		return info;
	};

	return (ref) => {
		const key = sourceKey(ref);
		const state = sources.get(key);
		if (state === undefined) return "SOURCE_NOT_IN_SNAPSHOT";
		if (
			state.principal !== snapshot.principal ||
			state.scopeKey !== snapshot.scopeKey
		) {
			return "SOURCE_NOT_PERMITTED";
		}
		if (state.status === "missing") return "SOURCE_MISSING";
		if (state.status === "changed") return "SOURCE_CHANGED";
		if (state.status === "forgotten") return "SOURCE_FORGOTTEN";
		if (ref.revision !== state.revision) return "SOURCE_REVISION_MISMATCH";
		if (ref.digest !== state.digest) return "SOURCE_DIGEST_MISMATCH";
		const content = ownValue(state, "content");
		const info = content === undefined ? undefined : contentOf(key, content);
		if (info !== undefined && info.digest !== state.digest) {
			return "SOURCE_CONTENT_DIGEST_MISMATCH";
		}
		const range = ownValue(ref, "range");
		if (range !== undefined) {
			if (info === undefined) {
				const pinned =
					relaxMemoryRanges && ref.namespace === MEMORY_SOURCE_NAMESPACE;
				return pinned ? null : "SOURCE_CONTENT_REQUIRED";
			}
			if (range.endByte > info.bytes.length) {
				return "SOURCE_RANGE_OUT_OF_BOUNDS";
			}
			if (
				!isUtf8CharBoundary(info.bytes, range.startByte) ||
				!isUtf8CharBoundary(info.bytes, range.endByte)
			) {
				return "SOURCE_RANGE_NOT_CHAR_BOUNDARY";
			}
		}
		return null;
	};
}

/**
 * active item の依存検査（build 3a–3k / validate V7 共通）。
 * items は呼び出し側が id 順で渡す。各 item の dependencies は SourceRef 順に
 * 並べ替えて走査するので入力順に依存しない。最初の失敗の reasonCode を返す。
 */
export function checkDependencies(
	items: readonly { readonly dependencies: readonly SourceRef[] }[],
	snapshot: SnapshotSources,
): SourceReasonCode | null {
	const check = createRefChecker(snapshot, false);
	for (const item of items) {
		const dependencies = [...item.dependencies].sort(compareSourceRef);
		for (const ref of dependencies) {
			const reason = check(ref);
			if (reason !== null) return reason;
		}
	}
	return null;
}

/**
 * v2 の依存検査。item の依存を先に、続けて evidence の出典を SourceRef 順に検査する。
 * 規則は v1 と同じ（判定順も同じ）。違いは Memory 所有の出典の range に content を要求しない点だけ。
 */
export function checkItemsAndEvidence(
	items: readonly { readonly dependencies: readonly SourceRef[] }[],
	evidenceRefs: readonly SourceRef[],
	snapshot: SnapshotSources,
): SourceReasonCode | null {
	const check = createRefChecker(snapshot, true);
	for (const item of items) {
		const dependencies = [...item.dependencies].sort(compareSourceRef);
		for (const ref of dependencies) {
			const reason = check(ref);
			if (reason !== null) return reason;
		}
	}
	for (const ref of [...evidenceRefs].sort(compareSourceRef)) {
		const reason = check(ref);
		if (reason !== null) return reason;
	}
	return null;
}
