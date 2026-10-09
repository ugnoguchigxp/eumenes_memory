import { canonicalJson } from "../../../canonical/json.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";

/**
 * state item の ID（`src/domains/state/contracts/index.ts` の規則）。
 * `"state:" + sha256Hex(canonicalJson([principal, scopeKey, createdSeq]))`。
 * createdSeq は item を作る操作の seq（1 操作が作る item は高々 1 件）なので、同じ入力に対して一意。
 */
export function stateItemId(
	principal: string,
	scopeKey: string,
	createdSeq: number,
): string {
	return `state:${sha256Hex(canonicalJson([principal, scopeKey, createdSeq]))}`;
}
