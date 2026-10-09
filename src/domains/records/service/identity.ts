/**
 * Records の同一性規則（純粋）。契約は `src/domains/records/contracts/index.ts` の JSDoc。
 */
import { canonicalJson } from "../../../canonical/json.ts";
import { sha256Hex } from "../../../canonical/sha256.ts";
import {
	MEMORY_RECORD_REPRESENTATION,
	MEMORY_RECORD_SOURCE_KIND,
	MEMORY_SOURCE_NAMESPACE,
} from "../../../contracts/common.ts";
import type { SourceKey } from "../../../contracts/common.ts";
import type { RecordOrigin } from "../contracts/index.ts";
import { sourceKey } from "../../../contracts/source-key.ts";
import type { ByteRange, SourceRef } from "../../../contracts/types.ts";

/** `"rec:" + sha256Hex(canonicalJson([principal, scopeKey, namespace, kind, id]))`。 */
export function recordIdOf(
	principal: string,
	scopeKey: string,
	origin: RecordOrigin,
): string {
	return `rec:${sha256Hex(
		canonicalJson([
			principal,
			scopeKey,
			origin.namespace,
			origin.kind,
			origin.id,
		]),
	)}`;
}

/** revision = `"sha256:" + hex`、digest = 同じ hex（本文の UTF-8 bytes の SHA-256）。 */
export function contentRevision(content: string): {
	readonly revision: string;
	readonly digest: string;
} {
	const digest = sha256Hex(content);
	return { revision: `sha256:${digest}`, digest };
}

/** recordId の書式（`rec:` + 64 桁 hex）。 */
export function isRecordId(value: string): boolean {
	return /^rec:[0-9a-f]{64}$/.test(value);
}

/** Records の SourceRef（namespace `memory`, kind `record`, representation `text`）。 */
export function recordSourceRef(
	recordId: string,
	revision: string,
	digest: string,
	range?: ByteRange,
): SourceRef {
	return {
		namespace: MEMORY_SOURCE_NAMESPACE,
		kind: MEMORY_RECORD_SOURCE_KIND,
		id: recordId,
		representation: MEMORY_RECORD_REPRESENTATION,
		revision,
		digest,
		...(range === undefined ? {} : { range }),
	};
}

/** 依存辺・墓標が使う、record の出典キー。 */
export function recordSourceKey(recordId: string): SourceKey {
	return sourceKey({
		namespace: MEMORY_SOURCE_NAMESPACE,
		kind: MEMORY_RECORD_SOURCE_KIND,
		id: recordId,
		representation: MEMORY_RECORD_REPRESENTATION,
	});
}
