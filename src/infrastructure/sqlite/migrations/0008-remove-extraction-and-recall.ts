/**
 * 取り除いた機能（Extraction と Recall）の永続物と、どこからも読まれない scope 版の表を削除する。
 *
 * - Extraction: `memory_extraction_run` / `_input` / `_shown`、`memory_candidate` / `_evidence`、`memory_source_progress`。
 *   子の表から順に消す（`foreign_keys=ON` でも親の削除が違反にならない）。index と trigger は表と一緒に消える。
 *   候補の値と抽出入力の digest は論理的に削除される（SQLite の空きページ・WAL・バックアップからの消去は保証しない。
 *   物理消去はホストの責任で、`secure_delete` と VACUUM / checkpoint を使う）。
 * - 依存辺: 取り除いた node 種別（`candidate` / `extraction_run`）と役割 `input` の辺を消す。残すと forget の閉包の
 *   読み取りが未知の種別に当たる。State item から出典への辺（`primary` / `support`）は残るので、item が引用する出典の
 *   忘却は抽出由来だった item にも届く。
 *   閉包は狭くなる（受容済みの変更）: 抽出の run が読んだだけで item が引用していない出典（`input` 辺）を忘れても、
 *   その run 経由で抽出由来の item には届かなくなる。item が根拠として引用する出典は従来どおり届く。
 *   Eumenes は抽出を実行したことがなく、実データは無い。
 * - 墓標: 取り除いた対象の種別（`candidate` / `extraction_run`）の行を消す。対象の表が無いので再挿入を止める相手がいない。
 *   `record` / `source` / `state_item` / `external` の墓標と、forget の記録（`memory_forget` / `memory_forget_external`）は残す。
 * - Recall: Records の全文索引 `memory_record_fts`。検索 API を取り除いたので維持する対象が無い。
 * - scope 版: `memory_scope_state`。書かれるだけで公開 API から読まれないので、書き込みと一緒に削除する。
 *
 * 既存の CHECK 制約（0001・0003・0007）は作り直さない。`candidate` / `extraction_run` / `input` と、State の
 * `admitted_extraction` / `dispute` / `invalidate` / `candidate` は、行に残りうる語彙として制約に残る（以後の API は書かない）。
 */
export const sql = `
DROP TABLE memory_candidate_evidence;
DROP TABLE memory_candidate;
DROP TABLE memory_extraction_shown;
DROP TABLE memory_extraction_input;
DROP TABLE memory_extraction_run;
DROP TABLE memory_source_progress;

DELETE FROM memory_dependency
WHERE dependent_type IN ('candidate', 'extraction_run')
	OR dependency_type IN ('candidate', 'extraction_run')
	OR role = 'input';

DELETE FROM memory_tombstone WHERE target_type IN ('candidate', 'extraction_run');

DROP TABLE memory_record_fts;
DROP TABLE memory_scope_state;
`;
