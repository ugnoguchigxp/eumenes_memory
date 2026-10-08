# migrations

`NNNN-<name>.ts` が `export const sql: string`（SQL 本文 = body）を 1 本 export する。`index.ts` が登録配列
`MIGRATION_BODIES` を持ち、ホストに渡す `migrations`（body + 版と hash の記録文）を組み立てる。

## 規則

- 1 回の `exec` で完結する。`BEGIN` / `COMMIT` / `SAVEPOINT` / `PRAGMA` / ホスト表への DDL・外部キーを含めない。
- 表・index・trigger はすべて `memory_` 接頭辞。ホストの表を参照しない。
- `memory_schema_info` への INSERT は書かない（`index.ts` が `migration_<n>_sha256` と `db_schema_version` を末尾に付ける。
  SQL は自分自身の hash を書けないため）。DB に保存される hash は body の SHA-256 hex。
- 列挙の CHECK は `src/contracts/*.ts` のタプルと一致させる（0001 は `migrations.test.ts` で照合）。新しい CHECK も同様のテストを足す。
- `ON CONFLICT DO NOTHING` を使い、`INSERT OR IGNORE` は使わない（CHECK 違反まで黙って無視するため）。
- 採用前（Eumenes の実 DB に初めて適用されるまで）は統合・並べ替えしてよい。採用後は追記専用で、適用済みの body を変更しない。
  凍結点は `spec/verification-status.md` に記録する。

## 番号の割当

| 番号 | ファイル | 担当 | 内容 |
|---|---|---|---|
| 0001 | `0001-foundation.ts` | S0（済） | schema_info / seq / scope_state / dependency / tombstone / forget / forget_external / journal_state / change |
| 0002 | `0002-records.ts` | S1+S2 | memory_record / _revision / _body / _fts、no_resurrection trigger |
| 0003 | `0003-state.ts` | S3（→ S5 が同ファイルに extraction 表を追記。S6 は表の変更なし） | memory_state_item / _attribute / _evidence / _event、memory_extraction_run / _input / _shown、memory_candidate / _evidence、memory_source_progress、no_resurrection trigger。forgotten 行の規約（値を NULL / '' にし、付随行を削除）は S6 の閉包適用が守る。採用前は 1 本に統合、採用後に S5 が必要なら 0004 に分ける |
| 0004〜 | 未割当 | — | 必要になったら親が割り当てる |

world / consolidation 用の migration は作らない（別ドメイン・別 repo）。

## 追加手順

1. 担当は自分の `NNNN-<name>.ts`（`export const sql`）を作る。登録配列は編集しない。
2. 親が `index.ts` に 1 行ずつ追記する（import と `MIGRATION_BODIES` への要素。順序は番号順、途中に挿入しない）。
   `migrations.test.ts` が「ディレクトリの `NNNN-*.ts` が連番で全部登録されていること」を検査する。
3. 登録されるまで `assertMemorySchema`（全公開操作の入口）は新しい migration を知らない。開発中の担当は、
   自ファイルを作ったら親へ登録を依頼する（親は担当の起動時に空の body で先に登録しておくと並列開発が止まらない）。
   自分の SQL だけを試す単体テストは `checkSchemaAgainst(db, bodies)` と `openTestStore({ migrations })` で書ける。
4. body を変更したら、その DB（使い捨てのテスト DB）を作り直す。
