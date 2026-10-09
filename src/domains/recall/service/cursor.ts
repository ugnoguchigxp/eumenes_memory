/**
 * 検索 cursor（不透明な文字列）。形式 `c1.<updatedSeq>.<binding>.<recordId>`。
 * binding は (principal, 検索 scope 集合, 語) の hash の先頭 16 hex で、別の検索への流用を検出する。
 * 順序キー (updated_seq DESC, record_id ASC) の最後に返した位置を指す（keyset）。
 */
import { canonicalJson } from "../../../canonical/json.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import { isRecordId } from "../../records/index.ts";

export interface CursorPosition {
	readonly updatedSeq: number;
	readonly recordId: string;
}

export function cursorBinding(
	principal: string,
	scopeKeys: readonly string[],
	folded: readonly string[],
): string {
	const scopes = [...scopeKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const terms = [...folded].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return sha256Hex(canonicalJson([principal, scopes, terms])).slice(0, 16);
}

export function encodeCursor(
	position: CursorPosition,
	binding: string,
): string {
	return `c1.${position.updatedSeq}.${binding}.${position.recordId}`;
}

/** 形式違反・binding 不一致は null。 */
export function decodeCursor(
	cursor: string,
	binding: string,
): CursorPosition | null {
	const match =
		/^c1\.(0|[1-9][0-9]{0,15})\.([0-9a-f]{16})\.(rec:[0-9a-f]{64})$/.exec(
			cursor,
		);
	if (match === null) return null;
	const [, seq, bound, recordId] = match;
	if (seq === undefined || bound !== binding || recordId === undefined) {
		return null;
	}
	const updatedSeq = Number(seq);
	if (!Number.isSafeInteger(updatedSeq) || !isRecordId(recordId)) return null;
	return { updatedSeq, recordId };
}
