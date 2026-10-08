import { canonicalJson } from "../canonical/json.ts";
import { sha256Hex } from "../canonical/sha256.ts";
import { utf8ByteLength } from "../canonical/utf8.ts";
import type { ReadyMemoryViewV2 } from "../contracts/view-v2.ts";
import type { ReadyBodyV2 } from "./compose-v2.ts";

/**
 * v2 の viewDigest: `viewDigest` を除いた ready 本体（schemaVersion 2、items / evidence /
 * dependencies / coverage を含む）の canonical JSON（canonicalJson = JCS 相当）の SHA-256 の小文字 hex。
 * 規則は v1 と同一で、対象の形だけが違う。
 */
export function computeViewDigestV2(body: ReadyBodyV2): string {
	return sha256Hex(canonicalJson(body));
}

/** viewDigest を付け、予算判定に使う最終 JSON の UTF-8 byte 長を返す。 */
export function finalizeReadyViewV2(body: ReadyBodyV2): {
	view: ReadyMemoryViewV2;
	byteLength: number;
} {
	const view: ReadyMemoryViewV2 = {
		...body,
		viewDigest: computeViewDigestV2(body),
	};
	return { view, byteLength: utf8ByteLength(canonicalJson(view)) };
}
