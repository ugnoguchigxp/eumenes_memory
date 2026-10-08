import { canonicalJson } from "../canonical/json.ts";
import { sha256Hex } from "../canonical/sha256.ts";
import { utf8ByteLength } from "../canonical/utf8.ts";
import type { ReadyMemoryView } from "../contracts/types.ts";
import type { ReadyBody } from "./compose.ts";

export function computeViewDigest(body: ReadyBody): string {
	return sha256Hex(canonicalJson(body));
}

/** viewDigest を付け、予算判定に使う最終 JSON の UTF-8 byte 長を返す。 */
export function finalizeReadyView(body: ReadyBody): {
	view: ReadyMemoryView;
	byteLength: number;
} {
	const view: ReadyMemoryView = {
		...body,
		viewDigest: computeViewDigest(body),
	};
	return { view, byteLength: utf8ByteLength(canonicalJson(view)) };
}
