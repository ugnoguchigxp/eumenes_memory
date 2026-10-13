/** 忘却（lifecycle の閉包適用が呼ぶ）。値の消去は表の持ち主である extraction が行う。 */
import { readText } from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import { all, first, placeholders, run } from "./sql.ts";

export interface ScrubbedRow {
	/** 行が principal のものなら scope。行がない／他 principal の行なら null（何も書かない）。 */
	readonly scopeKey: string | null;
	/** 今回、値を消す遷移をしたか（既に消してあれば false）。 */
	readonly transitioned: boolean;
}

export interface ScrubbedRun extends ScrubbedRow {
	/** run が外部プロバイダーへ送っていた `providerRef`（外部削除確認の対象）。なければ null。 */
	readonly providerRef: string | null;
}

/**
 * 候補の値を消す（冪等）。規約（0003 の JSDoc）: value_text / polarity を NULL、semantic_key を ''、
 * decision を `forgotten`、`memory_candidate_evidence` の行を削除。墓標は呼び出し側が書く。
 */
export function scrubCandidate(
	db: MemoryDb,
	principal: string,
	candidateId: string,
): ScrubbedRow {
	const row = first(
		db,
		"SELECT principal, scope_key, decision FROM memory_candidate WHERE candidate_id = ?",
		[candidateId],
	);
	if (row === null || readText(row, "principal") !== principal) {
		return { scopeKey: null, transitioned: false };
	}
	run(db, "DELETE FROM memory_candidate_evidence WHERE candidate_id = ?", [
		candidateId,
	]);
	run(
		db,
		`UPDATE memory_candidate SET decision = 'forgotten', value_text = NULL, polarity = NULL,
			semantic_key = '' WHERE candidate_id = ?`,
		[candidateId],
	);
	return {
		scopeKey: readText(row, "scope_key"),
		transitioned: readText(row, "decision") !== "forgotten",
	};
}

/**
 * run が持つ入力・見せた state の行と digest、およびこの run が書いた進捗行を消す（冪等）。run 行自体は残す（墓標と合わせて
 * settle / prepare を拒否するため）。確定前（prepared）の run は `stale: SOURCE_TOMBSTONED` で閉じる。
 * `provider_ref` は返してから空にする（外部削除の pending は呼び出し側が `memory_forget_external` に残す）。
 */
export function scrubRun(
	db: MemoryDb,
	principal: string,
	runId: string,
	opSeq: number,
): ScrubbedRun {
	const row = first(
		db,
		"SELECT principal, scope_key, stage, provider_ref, input_digest FROM memory_extraction_run WHERE run_id = ?",
		[runId],
	);
	if (row === null || readText(row, "principal") !== principal) {
		return { scopeKey: null, transitioned: false, providerRef: null };
	}
	const providerRef = readText(row, "provider_ref");
	run(db, "DELETE FROM memory_extraction_input WHERE run_id = ?", [runId]);
	run(db, "DELETE FROM memory_extraction_shown WHERE run_id = ?", [runId]);
	// この run が処理済みにした出典の進捗行も消す（忘れた run の結果は残らないので、残った出典は新しい run で抽出し直せる）。
	run(
		db,
		"DELETE FROM memory_source_progress WHERE principal = ? AND run_id = ?",
		[principal, runId],
	);
	run(
		db,
		`UPDATE memory_extraction_run SET input_digest = '', output_digest = NULL, provider_ref = '',
			outcome_code = CASE WHEN stage = 'prepared' THEN 'SOURCE_TOMBSTONED' ELSE outcome_code END,
			settled_seq = CASE WHEN stage = 'prepared' THEN ? ELSE settled_seq END,
			stage = CASE WHEN stage = 'prepared' THEN 'stale' ELSE stage END
		WHERE run_id = ?`,
		[opSeq, runId],
	);
	return {
		scopeKey: readText(row, "scope_key"),
		transitioned:
			readText(row, "stage") === "prepared" ||
			providerRef !== "" ||
			readText(row, "input_digest") !== "",
		providerRef: providerRef === "" ? null : providerRef,
	};
}

/** 忘却した出典の進捗行を削除する（再 insert は trigger が拒否する）。 */
export function scrubSourceProgress(
	db: MemoryDb,
	principal: string,
	sourceKeys: readonly string[],
): void {
	for (let offset = 0; offset < sourceKeys.length; offset += 200) {
		const chunk = sourceKeys.slice(offset, offset + 200);
		run(
			db,
			`DELETE FROM memory_source_progress WHERE principal = ? AND source_key IN (${placeholders(chunk.length)})`,
			[principal, ...chunk],
		);
	}
}

/** scope の進捗行を全部削除し、その出典キーを返す（scope の forget 用）。 */
export function scrubScopeProgress(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	createdBefore: number | null,
): string[] {
	const params: SqlValue[] = [principal, scopeKey];
	let extra = "";
	if (createdBefore !== null) {
		extra = " AND seq < ?";
		params.push(createdBefore);
	}
	const keys = all(
		db,
		`SELECT source_key FROM memory_source_progress WHERE principal = ? AND scope_key = ?${extra}`,
		params,
	).map((entry) => readText(entry, "source_key"));
	run(
		db,
		`DELETE FROM memory_source_progress WHERE principal = ? AND scope_key = ?${extra}`,
		params,
	);
	return keys;
}

/** scope の候補の ID（`createdBefore` が非 null ならその seq より前に作られたものだけ）。 */
export function listCandidateIdsInScope(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	createdBefore: number | null,
): string[] {
	const params: SqlValue[] = [principal, scopeKey];
	let extra = "";
	if (createdBefore !== null) {
		extra = " AND created_seq < ?";
		params.push(createdBefore);
	}
	return all(
		db,
		`SELECT candidate_id FROM memory_candidate WHERE principal = ? AND scope_key = ?${extra}
		ORDER BY candidate_id ASC`,
		params,
	).map((entry) => readText(entry, "candidate_id"));
}

/** scope の run の ID（`createdBefore` が非 null ならその seq より前に prepare されたものだけ）。 */
export function listRunIdsInScope(
	db: MemoryDb,
	principal: string,
	scopeKey: string,
	createdBefore: number | null,
): string[] {
	const params: SqlValue[] = [principal, scopeKey];
	let extra = "";
	if (createdBefore !== null) {
		extra = " AND prepared_seq < ?";
		params.push(createdBefore);
	}
	return all(
		db,
		`SELECT run_id FROM memory_extraction_run WHERE principal = ? AND scope_key = ?${extra}
		ORDER BY run_id ASC`,
		params,
	).map((entry) => readText(entry, "run_id"));
}

/** run の `providerRef`（外部送付の記録）。run がない／他 principal／空なら null。 */
export function runProviderRef(
	db: MemoryDb,
	principal: string,
	runId: string,
): string | null {
	const row = first(
		db,
		"SELECT principal, provider_ref FROM memory_extraction_run WHERE run_id = ?",
		[runId],
	);
	if (row === null || readText(row, "principal") !== principal) return null;
	const providerRef = readText(row, "provider_ref");
	return providerRef === "" ? null : providerRef;
}
