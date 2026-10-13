# migrations

`NNNN-<name>.ts` が `export const sql: string`（SQL 本文 = body）を 1 本 export する。`index.ts` が登録配列
`MIGRATION_BODIES` を持ち、ホストに渡す `migrations`（body + 版と hash の記録文）を組み立てる。

SQL本文は所有ドメインの `migrations/` に置く。0001と複数ドメインにまたがる0008は共通基盤に置き、0002・0005・0006は `src/domains/records/migrations/`、0003・0004・0007は `src/domains/state/migrations/` にある。登録配列はこのディレクトリの `index.ts` で一元管理する。

## 規則

- 1 回の `exec` で完結する。`BEGIN` / `COMMIT` / `SAVEPOINT` / `PRAGMA` / ホスト表への DDL・外部キーを含めない。
- 表・index・trigger はすべて `memory_` 接頭辞。ホストの表を参照しない。
- `memory_schema_info` への INSERT は書かない（`index.ts` が `migration_<n>_sha256` と `db_schema_version` を末尾に付ける。
  SQL は自分自身の hash を書けないため）。DB に保存される hash は body の SHA-256 hex。
- 列挙の CHECK は共有契約または所有ドメインの `contracts/` のタプルと一致させる（0001 は `migrations.test.ts` で照合）。新しい CHECK も同様のテストを足す。
- `ON CONFLICT DO NOTHING` を使い、`INSERT OR IGNORE` は使わない（CHECK 違反まで黙って無視するため）。
- 既存0001〜0003はドメイン移行時のSQLを固定し、SHA-256のテストで確認する。今後は追記し、登録済みの本文・順序を変更しない。

## 番号の割当

| 番号 | ファイル | 担当 | 内容 |
|---|---|---|---|
| 0001 | `0001-foundation.ts` | S0（済） | schema_info / seq / scope_state（0008 で削除） / dependency / tombstone / forget / forget_external / journal_state / change |
| 0002 | `0002-records.ts` | S1+S2 | memory_record / _revision / _body / _fts（0008 で削除）、no_resurrection trigger |
| 0003 | `0003-state.ts` | S3（→ S5 が同ファイルに extraction 表を追記。S6 は表の変更なし） | memory_state_item / _attribute / _evidence / _event、memory_extraction_run / _input / _shown、memory_candidate / _evidence、memory_source_progress、no_resurrection trigger。forgotten 行の規約（値を NULL / '' にし、付随行を削除）は S6 の閉包適用が守る。採用前は 1 本に統合、採用後に S5 が必要なら 0004 に分ける |
| 0004 | `src/domains/state/migrations/0004-state-validity.ts` | State | memory_state_item に成立期間の精度つき日付（`valid_from_text` / `valid_until_text`）と根拠（`valid_basis`）を追加。ms の境界は従来の列。forget は 3 列とも NULL |
| 0005 | `src/domains/records/migrations/0005-record-retention.ts` | Records | 再生成可能な資料の鮮度・未使用期限・採用revision |
| 0006 | `src/domains/records/migrations/0006-retention-forget.ts` | Records | 忘却した資料のretention metadataを除去する |
| 0007 | `src/domains/state/migrations/0007-state-agent-origin.ts` | State | `memory_state_item` の origin の CHECK に `agent_inferred` を加える。SQLite は CHECK を変更できないため、`memory_state_item` と子表3つ（attribute / evidence / event）を作り直す（行・列・値は不変） |
| 0008 | `0008-remove-extraction-and-recall.ts` | Memory | 取り除いた機能（Extraction と Recall）の表と、どこからも読まれない `memory_scope_state` を削除する。抽出の6表（run / input / shown / candidate / candidate_evidence / source_progress）と `memory_record_fts`、取り除いた node 種別（`candidate` / `extraction_run`、role `input`）の依存辺と墓標。既存の CHECK 制約は作り直さない |
| 0009〜 | 未割当 | — | 新しい変更の所有ドメインで追加する |

world / consolidation 用の migration は作らない（別ドメイン・別 repo）。

## 追加手順

1. 所有ドメインの `migrations/NNNN-<name>.ts` に `export const sql` を作る。
2. 共通の `index.ts` にimportと `MIGRATION_BODIES` の要素を追記する。番号順で、途中に挿入しない。
3. `migrations.test.ts` が共通基盤と全ドメインのSQLを探索し、連番・登録漏れ・既存SQLの同一性を検査する。
4. 新しいSQLを `checkSchemaAgainst(db, bodies)` と `openTestStore({ migrations })` で検証し、全体のverifyを通す。古いDBからの適用も確認する。
