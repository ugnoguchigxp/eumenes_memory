/**
 * 除外（`memory_exclusion`）と抑制（`memory_suppression`）の読み出し SQL の部品。State の読み出しと Lifecycle の書き込みが
 * 共有する（State は Lifecycle に依存しないので、ここ＝共通基盤に置く）。`alias` は `memory_state_item` の別名。
 * 一覧系の SQL は、墓標と同じく、status とは別にこの印の不在を必須条件にする（二重化）。
 */

/** 同じ事実（subject・kind・semantic_key）を指す抑制の対象 ID。SQL の `stateFactSql` と同じ連結。 */
export function stateFactKey(
	subject: string,
	kind: string,
	semanticKey: string,
): string {
	return `${subject}\u001f${kind}\u001f${semanticKey}`;
}

/** `memory_state_item` の行の事実キーを返す SQL 式（`stateFactKey` と同じ）。 */
export function stateFactSql(alias: string): string {
	return `${alias}.subject || char(31) || ${alias}.kind || char(31) || ${alias}.semantic_key`;
}

/** 除外されている item か（真偽を返す式）。 */
export function excludedSql(alias: string): string {
	return `EXISTS (SELECT 1 FROM memory_exclusion x
		WHERE x.principal = ${alias}.principal AND x.scope_key = ${alias}.scope_key
			AND x.target_type = 'state_item' AND x.target_id = ${alias}.item_id)`;
}

/** 抑制されている item か（item 自身、または同じ事実への抑制）。 */
export function suppressedSql(alias: string): string {
	return `EXISTS (SELECT 1 FROM memory_suppression s
		WHERE s.principal = ${alias}.principal AND s.scope_key = ${alias}.scope_key
			AND ((s.target_type = 'state_item' AND s.target_id = ${alias}.item_id)
				OR (s.target_type = 'state_fact' AND s.target_id = ${stateFactSql(alias)})))`;
}

/** 明示操作（本人由来）の origin。強度が下がっても、検索・一覧から外さない。 */
export const USER_ORIGIN_SQL = "('user_confirmed', 'user_edited')";
