import { canonicalJson } from "../canonical/json.ts";
import { sha256Hex } from "../canonical/sha256.ts";
import type { RunRef } from "../contracts/common.ts";

/**
 * run の ID（`src/contracts/extraction.ts` の規則）。`jobId + ":" + attempt`。attempt は末尾の整数なので、
 * jobId に `:` を含んでも (jobId, attempt) から一意に決まる。attempt の大小は比較しない。
 */
export function runIdOf(run: RunRef): string {
	return `${run.jobId}:${run.attempt}`;
}

/** 候補の ID。`"cand:" + sha256Hex(canonicalJson([runId, index]))`（index は出力内の 0 始まり位置）。 */
export function candidateIdOf(runId: string, index: number): string {
	return `cand:${sha256Hex(canonicalJson([runId, index]))}`;
}
