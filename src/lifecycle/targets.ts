/**
 * forget の target 解決に使う純粋部品。
 */
import { isRecordId, recordSourceKey } from "../evidence/record.ts";

const RECORD_SOURCE_KEY = /^\["memory","record","(rec:[0-9a-f]{64})","text"\]$/;

/**
 * SourceKey が Records の record のものなら recordId、そうでなければ null。
 * 形の一致だけでなく `recordSourceKey` で組み直して一致を確かめる。
 */
export function recordIdOfSourceKey(key: string): string | null {
	const match = RECORD_SOURCE_KEY.exec(key);
	const recordId = match?.[1];
	if (recordId === undefined || !isRecordId(recordId)) return null;
	return recordSourceKey(recordId) === key ? recordId : null;
}
