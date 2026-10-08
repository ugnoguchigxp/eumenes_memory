# MemorySystem 全体設計（M2–M4 + Lifecycle）

2026-10-08 / 設計のみ（コード未作成）。対象リポジトリ: `/Users/y.noguchi/Code/eumenes_memory`（M0 実装・検証済み、未コミット）。

**方針転換（ユーザー決定 2026-10-08）**: [implementation-plan.md](implementation-plan.md) §3「M0 のみ実装、後続はロードマップ」と §8「M0 のみ実装し…」を本書で置き換える。MemorySystem 全体（Records / Recall / State・Extraction / World / Consolidation / Lifecycle・忘却）を**最初から実装対象**とし、各機能の**検証段階を少しずつ上げる**。plan の他の節（所有責任 §2、M1 接続 §4、SAAA 継承 §6、パッケージ境界 §7）と [persistence-design.md](persistence-design.md) は引き続き有効で、本書はそれらを具体化する。既存 spec は編集しない（plan §3/§8 の置き換えは本書冒頭の宣言による）。

正直さの規律（維持）: 各機能は次の検証段階のどこまで到達したかだけを主張する。

| 段階 | 記号 | 意味 | 主張してよいこと |
|---|---|---|---|
| implemented | I | コードがあり型検査・単体テストが通る | 「実装済み」 |
| fixture-verified | F | 言語非依存 fixture と property/mutation 検査が通る | 「決定的な規則が fixture 上で成立」 |
| sql-verified | S | 使い捨ての実 SQLite（ファイル + WAL）で永続・トランザクション・復元シナリオが通る | 「本体単独の永続挙動が成立」 |
| host-integrated | H | Eumenes の Writer / queue / 採用 transaction に結合した試験が通る | 「Eumenes 上で動作」 |
| model-evaluated | E | 実モデルを使った評価データで、事前に定めた閾値を満たす | 「その評価セットでの意味精度」 |

実モデルを使っていない機能の意味精度、H 前の機能を「完了」と書かない。決定的スタブで通った抽出は F/S 止まり。

---

## 0. ゴール / 非ゴール / 禁止 / 要相談

ゴール
- 1 パッケージ `eumenes-memory` に、純粋 API（`.`）と永続 API（`./sqlite`）を持つ MemorySystem 全体を実装する。
- M0 の公開契約（schemaVersion 1 の入出力、fixture 101 件、export 16 件）を壊さない。
- 忘却は依存閉包・FTS・派生物・利用中 view・DB 復元まで含めて成立させる（F03 受入を必須）。
- モデル呼び出しはホスト注入。Memory は処理段階・候補・採否・進捗を持ち、queue は持たない。
- 縦切りスライスごとに API + 永続 + fixture + 検証段階を揃え、`spec/verification-status.md` に到達段階を記録する。

非ゴール
- HTTP サーバー、独自 DB 接続の open/close、PRAGMA 設定、queue / lease / retry / scheduler、モデル資格情報。
- embedding / ベクトル検索（検索評価で必要性を示すまで作らない）。
- Continuity（goal / decision / open_question）の正本移管。本体はこれらを別台帳として持たない。
- 会話原文のコピー保存（Records は外部取得物専用。会話原文は SourceRef で参照のみ）。
- tarball / manifest / vendor（plan §7。H 段階の前に別途）。
- Rust コアの全面移植・binding の本番採用（§5 の判断どおり）。

禁止
- `src/` から `bun:*`、`node:crypto` 以外の組み込み、`Date`、`Math.random`、`process`、`fetch`、`JSON.parse`、`Intl`、`localeCompare` を使わない（既存 `test/src-hygiene.test.ts` の規則を全モジュールへ適用）。時刻はホストが `atMs`（整数）で渡す。モデル出力はホストが JSON.parse 済みの `unknown` を渡す。
- 本体関数内で `BEGIN/COMMIT/SAVEPOINT`、`db.transaction()` を呼ばない。async 関数を `./sqlite` から公開しない。
- ホストのテーブルを参照・外部キー参照しない。
- 実会話データを fixture / 評価データに使わない。

要相談（§9 にまとめる）: 墓標ジャーナルの所有と配置、自動採用の初期設定、Records の初期プロデューサー。

---

## 1. 全体アーキテクチャ

### 1.1 層と責務

| 層 | 責務 | 純粋/永続 | 正本 |
|---|---|---|---|
| Source / Evidence | SourceRef・版・digest・UTF-8 範囲・引用一致検査。host 由来の出典（会話）と Memory 所有の出典（Records）を同じ参照形で扱う | 純粋 | 会話: ホスト / Records: 本体 |
| Records | 外部取得物（ツール結果・取り込み文書）の本文・版・スコープ・範囲読み出し | 永続 | 本体 |
| State / Admission | 型付き状態（preference, personal_fact, constraint, habit, other_person_note）の台帳、候補と採用の区別、訂正（supersede / dispute / retract） | 純粋 reducer + 永続 | 本体 |
| Extraction | 抽出 run の prepare / settle、候補の厳密 parse、引用検査、Admission 呼び出し、source 進捗 | 純粋 + 永続 | 本体（モデル呼び出しはホスト） |
| Projection / View | M0 の view を拡張（schemaVersion 2）。Continuity（ホスト）+ Memory 状態 + 任意の evidence を一つの view に | 純粋 | — |
| Recall / Search | スコープ限定検索（FTS5 trigram / スコープ内 LIKE）。結果は根拠候補で、事実へ昇格しない | 永続 | — |
| World | 状態台帳と Records から派生するエンティティ・関係・条件・予測・観測。独立根拠数による確信レベル | 純粋 + 永続（再構築可能な射影） | 派生（第二の正本にしない） |
| Consolidation | 入力 manifest を固定した要約・再評価の run。出力は派生物で、根拠数を増やさない | 純粋 + 永続 | 派生 |
| Lifecycle / Forget | deactivate（可逆）と forget（不可逆消去）、依存閉包、墓標、ジャーナル照合、外部削除の pending/unverified | 純粋（閉包計算）+ 永続 | 本体 |

### 1.2 ディレクトリ（新規分のみ。M0 の `canonical / contracts / view / validation` はそのまま）

```text
src/
  index.ts                 純粋 API の公開面（M0 + 追加）
  sqlite.ts                "./sqlite" の公開面（永続 API）。ロジックを置かない
  evidence/                quote 検査、span 正規化、root 集合（純粋）
  state/                   状態型、reducer（遷移の妥当性）、admission 規則表（純粋）
  extraction/              候補 schema の parse、run 入出力型、prompt 素材（純粋）
  world/                   派生規則、独立根拠、確信レベル、循環検出（純粋）
  consolidation/           manifest 構成・digest、出力 parse（純粋）
  lifecycle/               依存閉包計算、forget plan、ジャーナル entry とハッシュ鎖（純粋）
  recall/                  検索クエリの正規化、戦略選択、結果順序（純粋）
  store/                   SQL 層。上記の純粋部品を MemoryDb 上で使う唯一の層
    db.ts                  MemoryDb ポート、writable 検査、seq 発行
    migrations/            0001-foundation.ts … （各ファイルは SQL 文字列 1 本を export）
    migrations/index.ts    順序付き配列（共有ファイル: 親担当のみ編集）
    schema-check.ts        assertMemorySchema
    records.ts recall.ts state.ts extraction.ts world.ts consolidation.ts lifecycle.ts snapshot.ts
fixtures/
  (既存) canonical utf8 build validate
  build-v2/ validate-v2/ evidence/ state/ admission/ extraction/ world/ consolidation/ lifecycle/ scenario/
eval/                       実モデル評価（verify 対象外）。datasets/ と README
test/support/               テスト用 Writer（store.write 相当）、一時 DB、stub ポート
scripts/                    verify.ts（拡張）, bench-scope.ts, eval-run.ts, fixture-digest.py
```

依存方向（逆向き禁止、`test/src-hygiene.test.ts` を拡張して検査）:

```text
canonical ← contracts ← evidence ← {state, recall, lifecycle} ← extraction ← world ← consolidation
                     ↖ view ← validation（M0）。view は state の型を import してよい
store は上記すべてを import してよい。純粋層は store を import しない。
index.ts は純粋層のみ、sqlite.ts は store と型のみ。
```

### 1.3 公開 API 追加方針と互換ルール

1. `.`（`src/index.ts`）は既存 16 export を一切変更しない（名前・意味・挙動）。追加 export は可。`src/contracts/test/exports.test.ts` の期待一覧を更新する（共有ファイル）。
2. `./sqlite`（`src/sqlite.ts`）を `package.json` の `exports` に追加。純粋 API と分ける（Eumenes の web 側から SQL 層を誤 import しないため。SQL 層も `bun:sqlite` は import しない）。
3. **版の分離**:
   - `SCHEMA_VERSION`（= 1）は M0 view 契約の版として凍結。新たに `VIEW_SCHEMA_VERSIONS = [1, 2]` を追加。`buildMemoryView` は入力の `schemaVersion` が 1 なら M0 と完全同一の挙動・出力（既存 fixture で保証）、2 なら §3.4 の拡張。3 以上は従来どおり `UNSUPPORTED_SCHEMA_VERSION`。
   - 永続 API の入力は family ごとの `contractVersion: 1`（`CONTRACT_VERSIONS` で公開: records, recall, state, extraction, world, consolidation, lifecycle）。未知版は `UNSUPPORTED_SCHEMA_VERSION`（既存コードを再利用）。
   - DB スキーマ版は `MEMORY_DB_SCHEMA_VERSION`（整数、migration 本数と一致）。契約版とは独立。
4. 追加の reasonCode / 例外コードは**既存タプルの末尾に足さない**。新しい family ごとに別タプル（例 `RECORD_REASON_CODES`）を作る。既存の `BUILD_REASON_CODES` は v2 用に `BUILD_V2_REASON_CODES`（v1 の全要素 + 追加分）を別に持つ。v1 結果に v2 専用コードは出ない。
5. 永続 API のエラーは `MemoryStoreError`（`code`, `path` なし、message は `code` 固定、本文・ID を含めない）。入力検査違反は従来どおり `MemoryContractError`。

---

## 2. 永続化

### 2.1 FTS5 の可用性（2026-10-08 にこの環境で実測）

`bun:sqlite`（bun 1.4.2）で確認。スクリプトは scratchpad で実行（リポジトリ外、未保存）。

| 確認 | 結果 |
|---|---|
| SQLite 版 | 3.51.0。compile options に `ENABLE_FTS5`、`ENABLE_FTS4`、JSON 関数あり。`CCCRYPT256` / `CODEC=see-cccrypt` を含むため **macOS システムの libsqlite3 が使われている**（Bun は macOS では同梱版ではなくシステム版を読む）。Eumenes は `/usr/lib/libSystem.B.dylib` を dlopen する macOS 専用実装なので、実運用も同条件 |
| `fts5(tokenize='trigram')` / `unicode61` / `contentless_delete=1` / `secure-delete` オプション | すべて作成・動作 OK |
| trigram で日本語 4 文字句 `"来週まで"` | ヒット |
| trigram で 2 文字 `"食べ"` の MATCH | **0 件**（trigram は 3 文字未満を検索できない）。`LIKE '%食べ%'` はヒット |
| contentless_delete で行削除後の MATCH | 0 件（削除が索引に反映） |
| 削除後の残渣（200 行、WAL、`secure_delete` on/off） | checkpoint(TRUNCATE) 後、DB / WAL ファイルの bytes に削除本文の断片なし。**小規模 1 回の観測で、一般の保証ではない** |
| `db.inTransaction` | transaction 外 false、内 true |
| readonly 接続への UPDATE | `SQLITE_READONLY` 例外 |
| `RETURNING` | 動作 |
| 同期 Wasm（`new WebAssembly.Module(bytes)`） | Bun で同期 instantiate 可（§5 の参考） |

スコープ限定の性能（F02 の一次観測、`:memory:`、100 scope に均等分布）:

| 方式 | 1 万行 | 10 万行 |
|---|---|---|
| FTS を JOIN して外側で scope 絞り込み（planner が scope index → FTS を行ごとに評価） | 1.56 ms | **146 ms** |
| `rowid IN (FTS MATCH)` + scope 条件 | 0.18 ms | 1.43 ms（全 scope のヒット数に比例） |
| FTS に scope タグ列を加えて MATCH | 0.58 ms | 1.88 ms |
| scope index で絞ってから `LIKE`（1 scope ≈ 全体の 1%） | 0.006 ms | 0.008 ms |

結論: **FTS5 は使える**。ただし (a) 3 文字未満は LIKE が必要、(b) JOIN の書き方次第で全 scope 依存になる。§2.6 の戦略で、scope 内件数が小さい間は scope index + LIKE、大きい場合は `IN (MATCH)` を使い、両者の結果同値を property test で固定する。閾値は S2 の bench で決める。

### 2.2 MemoryDb ポート（`src/store/db.ts`、`./sqlite` から型を export）

```ts
export interface MemoryStatement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;   // 行なしは null（bun:sqlite）/ undefined を両方許容
  run(...params: SqlValue[]): unknown;
}
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface MemoryDb {
  exec(sql: string): void;
  query(sql: string): MemoryStatement;
  readonly inTransaction?: boolean;      // bun:sqlite の Database は持つ。無ければ検査を省略
}
```

- 書き込み関数は入口で `assertWritable(db)`: `inTransaction === false` なら `MemoryStoreError("NOT_IN_TRANSACTION")`。続く最初の文が `UPDATE memory_seq SET value = value + 1 WHERE id = 1 RETURNING value`（seq 発行を兼ねる）で、`SQLITE_READONLY` を `READONLY_CONNECTION` に変換。
- 読み取り関数は `inTransaction` を要求しない（ホストが read transaction で囲む責任。persistence-design §5）。複数文読み出しを行う関数は「一貫性はホストの transaction に依存」と JSDoc に明記。
- 行は `unknown` として受け、store 内の小さな row reader で型検査（列欠落・型違いは `CORRUPT_ROW`）。
- prepared statement のキャッシュは呼び出しローカル（モジュール状態を持たない）。性能が足りなければ S2 bench の結果で `createStatementCache(db)` を追加（要計測）。

### 2.3 migration

- `src/store/migrations/NNNN-<name>.ts` が `export const sql: string` を 1 本持つ。`index.ts` が `export const migrations: readonly string[]` を順に並べる。各 SQL は 1 回の `exec` で完結、`BEGIN/COMMIT`・PRAGMA・ホスト表 DDL なし（persistence-design §4）。
- `memory_schema_info(key TEXT PRIMARY KEY, value TEXT NOT NULL)` に `db_schema_version`、`migration_<n>_sha256`（各 SQL の SHA-256）を各 migration 自身が INSERT する（persistence-design §8-2 を「記録する」で解決）。
- `assertMemorySchema(db)`: `db_schema_version` ≤ 本体の既知版であること、かつ既知範囲の各 `migration_<n>_sha256` が本体の SQL と一致すること。不一致は `SCHEMA_TOO_NEW` / `SCHEMA_MISMATCH`。全公開操作の入口で呼ぶ（1 回の SELECT。コストは S2 bench で確認）。
- **採用前の自由度**: Eumenes の実 DB に初めて適用されるまで（H 段階の最初の採用まで）、本リポジトリの migration は統合・並べ替えしてよい（テスト DB は使い捨て）。採用後は追記専用。`spec/verification-status.md` に「migration 凍結点」を記録する。
- ホスト側は `[...hostMigrations, ...memoryMigrations]` のように**各要素を 1 本ずつ**末尾に追記する（Eumenes の配列は 1 domain 1 文字列だが、本体は複数要素）。

### 2.4 論理スキーマ（すべて `memory_` 接頭辞、ホスト表への FK なし。本体表どうしの FK は可）

共通列の規約: `principal TEXT`, `scope_key TEXT`（M0 の識別子規則）、`*_seq INTEGER`（`memory_seq` 由来の単調値、時計の代替）、`at_ms INTEGER`（ホストが渡した時刻、表示・期限判定用。順序判定には使わない）。

**0001 foundation**

| 表 | 主な列 | 備考 |
|---|---|---|
| `memory_schema_info` | key PK, value | §2.3 |
| `memory_seq` | id=1, value | 単調 seq |
| `memory_scope_state` | (principal, scope_key) PK, revision INT, enabled_extraction INT | scope ごとの Memory 状態版。Memory 所有データが変わるたび +1（忘却含む）。view の stateRevision の一部 |
| `memory_dependency` | dependent_type, dependent_id, dependency_type, dependency_id, role(`primary`/`support`/`input`/`derived_from`), PK(全列) | 依存閉包の辺。index (dependency_type, dependency_id) |
| `memory_tombstone` | target_type, target_id PK(2列), principal, scope_key, forget_id, seq, journal_seq | 永久。本文・digest を持たない |
| `memory_forget` | forget_id PK, principal, request_json（対象 ID のみ）, local_state(`applied`), external_state(`none`/`pending`/`unverified`/`confirmed`/`failed`), seq, at_ms | ForgetReceipt の正本 |
| `memory_forget_external` | forget_id, provider_ref, state(`pending`/`unverified`/`confirmed`/`failed`), updated_seq, PK(forget_id, provider_ref) | 外部削除の確認状況 |
| `memory_journal_state` | id=1, applied_head_seq, applied_head_hash | 墓標ジャーナル照合位置（§2.5） |

**0002 records**

| 表 | 主な列 |
|---|---|
| `memory_record` | record_id PK（`rec:` + ホスト指定 or 内容由来）, principal, scope_key, origin_namespace, origin_kind, origin_id, media_type(`text/plain`,`text/markdown`,`application/json`), capture_state(`complete`/`partial`), status(`active`/`inactive`/`forgotten`), current_revision, created_seq, updated_seq |
| `memory_record_revision` | record_id, revision（`sha256:<hex>`）, digest, byte_length, body_rowid, seq, PK(record_id, revision) |
| `memory_record_body` | rowid INTEGER PK, record_id, revision, representation(`text`), content TEXT |
| `memory_record_fts` | `fts5(body, content='', contentless_delete=1, tokenize='trigram')`。rowid = body rowid。アプリコードで維持（trigger にしない。forget を同一関数で完結させるため） |

trigger: `memory_record_no_resurrection` — `BEFORE INSERT ON memory_record WHEN EXISTS(tombstone where target_type='record' and target_id=NEW.record_id) → RAISE(ABORT, 'memory_tombstoned')`。同様に `memory_record_body`、`memory_state_item`、`memory_candidate` にも（SAAA の `record_no_resurrection` と同じ型）。

index: `(principal, scope_key, status)` on record、`(record_id)` on body。

**0003 state / extraction**

| 表 | 主な列 |
|---|---|
| `memory_state_item` | item_id PK, principal, scope_key, subject(`self` / `other:<opaque>`), kind, semantic_key, status(`active`/`inactive`/`superseded`/`disputed`/`retracted`/`invalidated`/`forgotten`), revision INT, value_json（forgotten で NULL）, polarity, origin(`user_confirmed`/`user_edited`/`admitted_extraction`), valid_from_ms, valid_until_ms, created_seq, updated_seq |
| `memory_state_event` | event_seq PK, item_id, action(`assert`/`activate`/`edit`/`supersede`/`dispute`/`retract`/`deactivate`/`reactivate`/`invalidate`/`forget`), from_revision, to_revision, cause_type(`user`/`candidate`/`lifecycle`), cause_id, at_ms | 追記専用。forget で payload 列を消し action と seq だけ残す |
| `memory_extraction_run` | run_id PK（= ホストの `jobId:attempt`）, principal, scope_key, stage(`prepared`/`settled`/`stale`/`rejected_output`), input_digest, extractor_profile, provider_ref, prepared_seq, settled_seq, outcome_code |
| `memory_extraction_input` | run_id, source_key, revision, digest, PK(run_id, source_key) |
| `memory_candidate` | candidate_id PK（`cand:` + sha256(run_id, index)）, run_id, principal, scope_key, kind, subject, semantic_key, value_json, polarity, modality, temporal, decision(`admitted`/`pending_user`/`rejected`/`invalidated`/`forgotten`), reason_code, created_seq |
| `memory_candidate_evidence` | candidate_id, source_key, revision, start_byte, end_byte, quote_digest |
| `memory_source_progress` | (principal, scope_key, source_key) PK, processed_revision, stage(`extracted`/`no_change`/`failed_output`), run_id, seq |

**0004 world**

| 表 | 主な列 |
|---|---|
| `memory_world_node` | node_id PK, principal, scope_key, node_type(`entity`/`relation`/`condition`/`prediction`/`observation`), key, payload_json, epistemic(`observation`/`hypothesis`/`supported`/`disputed`), confidence_level INT（0–3 の序数）, root_count INT, derivation_seq, status(`active`/`invalidated`/`forgotten`) |
| `memory_world_root` | node_id, root_source_key, PK(node_id, root_source_key) | 独立根拠の集合（§6.3） |
| `memory_world_meta` | (principal, scope_key) PK, built_from_state_revision, built_seq | 射影が最新か |

**0005 consolidation**

| 表 | 主な列 |
|---|---|
| `memory_consolidation_run` | run_id PK, principal, scope_key, purpose(`summarize`/`reevaluate_world`), manifest_digest, stage(`prepared`/`settled`/`stale`/`held`), mode(`off`/`preview`/`apply`), outcome_code, prepared_seq, settled_seq |
| `memory_consolidation_input` | run_id, input_type, input_id, revision, PK(run_id, input_type, input_id) |
| `memory_consolidation_output` | output_id PK, run_id, principal, scope_key, kind(`summary_note`/`world_proposal`), payload_json, status(`preview`/`adopted`/`invalidated`/`forgotten`), seq |
| `memory_consolidation_cursor` | (principal, scope_key, purpose) PK, last_input_seq |

すべての派生行（candidate, state_item, world_node, consolidation_output）は `memory_dependency` に依存辺を持つ。辺のない派生行を作らない（S6 の不変条件テスト）。

### 2.5 F03: 復元で忘却が戻らない設計

SAAA の欠落（records の墓標がジャーナルへ書かれない・再適用が墓標挿入だけ・認可が墓標を見ない）を三つとも塞ぐ。

1. **読み出しの墓標除外**: Records / state / candidate / world / consolidation を返す全 SQL は、status 列に加えて `NOT EXISTS (SELECT 1 FROM memory_tombstone t WHERE t.target_type=? AND t.target_id=<row id>)` を必須条件にする。status と墓標の二重化。fixture: status を `active` に戻した（=古い行を復元した）DB で read/search/view/world/snapshot に出ないこと。
2. **完全な再適用**: `applyForget(db, entry)` は冪等で、墓標の有無に関係なく本文削除・FTS 削除・閉包の無効化・scope revision 更新を毎回実行する（「墓標を入れるだけ」にしない）。
3. **墓標ジャーナル（DB の外）**: 忘却は 2 相。
   - `planForget(db, request) → ForgetPlan`（読み取りのみ、決定的）: 対象と閉包を計算し、ジャーナル entry を返す。entry = `{ journalFormat: 1, seq, prevHash, forgetId, principal, targets: [{type, id}], hash }`。本文・digest を含めない。`hash = sha256(canonicalJson(entry 本体))`、`prevHash` で鎖にする。
   - ホストが entry をジャーナルファイルへ追記して fsync（async。transaction の外）。
   - `applyForget(db, entry)`（write transaction 内、同期）: 閉包を**その時点で再計算**して適用し、`memory_journal_state` の head を進める。plan 後に派生物が増えていても取りこぼさない。
   - 起動時（ホストの recover 順で worker 起動前）: `reconcileForgetJournal(db, entries)`。DB の `applied_head_seq` がジャーナルより古ければ不足 entry を順に再適用する。ジャーナルが DB head より短い、鎖が壊れている、DB に墓標があるのにジャーナルが空、のいずれかなら `inconsistent` を返す。ホストは Memory の読み出し・抽出を止める（fail closed）。
   - 制約: 本体は状態を持たないため、「復元直後で reconcile 未実行の DB」を読み出し関数だけでは検出できない（復元された DB は過去の正常状態と区別できない）。**fail closed の責任はホストの起動手順（§8 E5）に置き**、M1 結合試験で検証する。本体は reconcile を呼ばずに読める経路を減らすため、`./sqlite` の README に起動手順を必須事項として書く。
   - 順序はジャーナル先行。crash で「ジャーナルにあるが DB に未適用」は起動時の reconcile で回復。「DB にあるがジャーナルにない」は起こらない（apply は entry を要求する）。
4. ジャーナルのファイル操作（tempfile → fsync → rename → dir fsync、SAAA journal.rs と同方式）はホストの実装。本体は entry の生成・検査・鎖検証だけを純粋関数で提供（`verifyForgetJournal(entries)`）。

受入（S4 段階、S1 で実装）: capture → forget → 「忘却前に複製した DB ファイル」を復元 → 最新ジャーナルで reconcile → read / search / view / world / snapshot / candidate 一覧に出ない。reconcile を 2 回実行しても結果同一。ジャーナルの末尾切り詰め・1 entry 改ざん・空ジャーナルで `JOURNAL_INCONSISTENT`。通常の忘却だけのテストでは完了としない。

WAL・空き領域の残渣: 本体は PRAGMA を持たない。ホストに `PRAGMA secure_delete=ON` と忘却後の `wal_checkpoint(TRUNCATE)` を推奨事項として渡し（§8）、物理消去の保証は主張しない（SAAA README と同じ）。

### 2.6 F02: スコープ限定読み出し

- すべての読み出し API は `access: AccessContext`（M0 型）と対象 `scopeKey` を取り、SQL は `(principal, scope_key)` で始まる index を使う。scope を指定しない全件 API を作らない。
- View 用の Memory snapshot（§3.4）は対象 scope の active 項目と、その依存辺の 1 段先までだけを読む。閉包計算（forget）は書き込み側なので全辺を辿ってよいが、再帰 CTE で起点から辿る（全表ロードしない）。
- 検索戦略（`src/recall/strategy.ts`、純粋）: `scopeRowCount ≤ LIKE_SCAN_MAX`（初期値 5000、S2 bench で確定）または query の最短語が 3 文字未満 → scope index + `LIKE`（`ESCAPE` 付き）。それ以外 → `rowid IN (SELECT rowid FROM memory_record_fts WHERE … MATCH ?)` + scope 条件。結果順序はどちらも `(updated_seq DESC, record_id ASC)` で、bm25 は使わない（戦略間で結果を同一にするため。ランキング改善は検索評価後）。
- bench（`scripts/bench-scope.ts`、verify 対象外）: 1 千 / 1 万 / 10 万行 × scope 数 10/100、対象 scope の行数固定で p50/p95・`EXPLAIN QUERY PLAN` に SCAN がないこと・読み取り行数。結果を `spec/verification-status.md` に記録。閾値の合否は Eumenes の応答予算が決まるまで「記録のみ」（§9 Q4）。

---

## 3. 契約（共有型）— 親担当が S0 で固定する

型はすべて readonly、M0 の reader（own-property、deep-freeze、例外の path 規則）で parse する。以下は形の正本。上限値は各 family の `LIMITS_*` に置き、M0 の `LIMITS` は変えない。

### 3.1 共通

```ts
export type SourceKey = string;   // M0 の sourceKey(namespace,kind,id,representation) の文字列表現
export interface EvidenceSpan {
  readonly source: SourceRef;     // M0 型。revision/digest 必須、range 必須
  readonly quote: string;         // range の bytes を UTF-8 decode した文字列と完全一致必須
}
export interface HostClock { readonly atMs: number }      // 安全な整数
export interface RunRef { readonly jobId: string; readonly attempt: number }  // ホスト queue の値。Memory は lease を見ない
export type Subject = "self" | `other:${string}` | "unknown";
export type Polarity = "affirmed" | "negated";
export type Modality = "asserted" | "hypothetical" | "quoted" | "reported" | "question";
export type Temporal = "current" | "past" | "future" | "unspecified";
```

Memory 所有出典の SourceRef: Records は `(namespace "memory", kind "record", id record_id, representation "text")`、revision = `sha256:<hex>`。会話は M0 と同じ `("conversation","message",id,"text")`（ホスト所有）。

### 3.2 Records（`./sqlite`）

```ts
captureRecord(db, input: {
  contractVersion: 1; access: AccessContext; scopeKey: string; clock: HostClock;
  origin: { namespace: string; kind: string; id: string };
  mediaType: "text/plain" | "text/markdown" | "application/json";
  content: string;                     // ≤ LIMITS_RECORDS.maxContentBytes (1 MiB)
  captureState: "complete" | "partial";
  runRef?: RunRef; providerRef?: string;
}): { recordId: string; revision: string; created: boolean }   // 同一 origin + 同一内容は created:false（冪等）

readRecord(db, { contractVersion: 1; access; scopeKey; recordId; revision?: string })
  : { status: "available"; record: RecordMeta; content: string } | { status: "missing" | "forgotten" | "not_permitted" }
readRecordRange(db, { …; recordId; revision; range: ByteRange })  // 最大 64 KiB、文字境界違反は INVALID_RANGE 系 reason
  : { status: "available"; text: string; digest: string } | { status: … }
recordSourceStates(db, { access; scopeKey; refs: SourceRef[] }): SourceState[]   // view 用。forgotten/missing を M0 の status で返す
deactivateRecord(db, { access; scopeKey; recordId; clock })      // 可逆。本文保持。forget ではない
reactivateRecord(db, …)
```

### 3.3 Recall

```ts
searchRecords(db, { contractVersion: 1; access; scopeKeys: string[]; query: string; limit: number /*1..50*/; cursor?: string })
  : { hits: readonly RecallHit[]; nextCursor?: string; strategy: "like" | "fts" }
interface RecallHit {
  readonly ref: SourceRef;                 // range = 一致箇所（最初の 1 箇所、UTF-8 byte）
  readonly snippet: string;                // range 前後を文字境界で ≤ 256 byte
  readonly authority: "evidence_candidate"; // 事実ではない
}
```

`scopeKeys` は access.scopeKeys の部分集合でなければ `SCOPE_NOT_PERMITTED`（例外ではなく結果: `{ status: "blocked", reasonCode }` の判別共用体にする）。

### 3.4 View v2（`.`、M0 拡張）

- 入力 `BuildMemoryViewInputV2 = { schemaVersion: 2; access; snapshot: SnapshotV2; maxBytes; enabled; evidence?: { hits: RecallHit[]; maxEvidenceBytes: number } }`。
- `SnapshotV2` = M0 Snapshot + items の kind に `preference | personal_fact | constraint | habit` を追加、origin に `admitted_extraction` を追加、item に任意 `subject`（`self` のみ view に入る。`other:*` / `unknown` は build で除外し coverage に数えない）。
- 必須/任意: state items は M0 と同じく**全部必須**（超過で overflow）。evidence は任意で、予算に入らない分を `coverage.omitted: [{ type: "evidence", count }]` に入れ `coverage.complete: false`。必須項目の不足と任意 evidence の省略を区別（契約 §3 の予告どおり）。
- stateRevision: ホストが `"c:" + continuityRevision + "|m:" + memoryScopeRevision` のように合成して渡す（本体は不透明に比較するだけ。合成規則は M1 アダプターの責任、§8）。
- Memory 側 snapshot の取得: `./sqlite` の `readMemorySnapshotPart(db, { access; scopeKey }) → { memoryRevision: string; items: MemoryItemV2[]; sources: SourceState[] }`。ホストは Continuity の items と結合して `SnapshotV2` を作る。会話 source の状態はホストが入れ、Records source の状態は本体が入れる。
- `validateMemoryView` は view の schemaVersion で分岐。v2 に追加の validation reason: `EVIDENCE_SOURCE_*` は作らず、evidence も依存検査（3a–3k）の対象に含める（evidence の出典が忘却されたら view は invalid）。
- v1 fixture（101 件）は無変更で通ること（回帰）。v2 用に `fixtures/build-v2/`、`fixtures/validate-v2/` を新設。

### 3.5 State / Admission（純粋型は `.`、永続は `./sqlite`）

```ts
type StateKind = "preference" | "personal_fact" | "constraint" | "habit" | "other_person_note";
interface StateValue { readonly text: string; readonly polarity: Polarity; readonly attributes?: Readonly<Record<string, string>> }
// 明示操作（モデルなし）
assertUserState(db, { contractVersion: 1; access; scopeKey; clock; kind; semanticKey; value: StateValue; evidence: EvidenceSpan[]; origin: "user_confirmed" | "user_edited"; replaces?: { itemId; revision } })
editState / deactivateState / reactivateState / retractState(db, { …; itemId; expectedRevision })
listState(db, { access; scopeKey; kinds?; includeInactive?: boolean })
```

reducer（`src/state/reducer.ts`、純粋）: `applyStateTransition(current: StateItemView | null, transition, context) → { ok: true; next; events } | { ok: false; reasonCode }`。規則（SAAA personal-state-core の意味を TS で再実装。§5）:
- expectedRevision 不一致 → `STALE_REVISION`。
- 同 (subject, kind, semanticKey) の active は 1 件。新しい根拠（source seq が新しい）での変更は `supersede`、古い根拠で新しい active を置き換えない（`OLDER_EVIDENCE`）。
- 異なる値の同 key 候補で根拠の新旧が同じ → `dispute`（双方 disputed、view に入らない）。
- forget / invalidate された依存を持つ item は `invalidated`（遅延でなく、forget 時に閉包で確定書き込み）。

Admission 規則表（`src/state/admission.ts`、純粋、§6.4 の評価で更新）:

| 条件（上から評価、最初に当たったもの） | decision | reasonCode |
|---|---|---|
| 候補 schema 違反・未知フィールド・権限系フィールド（scope, confidence 等）の指定 | rejected | `INVALID_CANDIDATE` |
| evidence の quote が source range と不一致、range が文字境界外、source が run 入力にない | rejected | `QUOTE_MISMATCH` / `EVIDENCE_NOT_IN_INPUT` |
| evidence の source が forgotten / 版変更 | rejected | `SOURCE_STALE` |
| kind が host 所有（goal / decision / open_question）や World 種別 | rejected | `HOST_OWNED_KIND` |
| quote が括弧（「」『』“”""）内、または modality が quoted / reported | pending_user（kind を `other_person_note` に変える場合あり） | `MODALITY_QUOTED` |
| modality が hypothetical / question | rejected | `MODALITY_NOT_ASSERTED` |
| subject が `other:*` | pending_user（kind=`other_person_note` 固定、self の状態にしない） | `SUBJECT_OTHER` |
| subject が `unknown` | rejected | `SUBJECT_UNKNOWN` |
| 根拠 source の role がユーザー発言でない（ホストが SourceState に付与） | pending_user | `NOT_USER_SOURCE` |
| 同 key に active があり値が異なり、候補の根拠が古い | rejected | `OLDER_EVIDENCE` |
| kind ごとの policy が `auto_admit` でない | pending_user | `POLICY_REQUIRES_USER` |
| それ以外 | admitted（origin `admitted_extraction`） | — |

kind ごとの policy（`AdmissionPolicy`、ホストが設定として渡す。既定は**全 kind `user_confirm`**＝候補生成のみ）: `"never" | "user_confirm" | "auto_admit"`。`auto_admit` は model-evaluated（E）段階の合格記録がある kind だけに設定することを運用規則とする（コードは強制しない。§9 Q2）。

`confirmCandidate(db, { access; scopeKey; candidateId; clock; action: "admit" | "reject"; editedValue? })` → admit で origin `user_confirmed`/`user_edited`。

### 3.6 Extraction（ホストの queue handler の三つ組に対応）

Eumenes の `HandlerDefinition`（`prepareInTransaction` / `execute` / `settleInTransaction`、`api/domains/queue/types/index.ts:82-109`）にそのまま載る形にする。

```ts
// 1) prepare: write tx 内（run 行を作るため）。同期
prepareExtraction(db, {
  contractVersion: 1; access; scopeKey; clock; run: RunRef; enabled: boolean;
  sources: readonly (SourceState & { content: string; role: "user" | "assistant" | "tool" })[]; // ホストが同 tx で読んだ本文
  profile: { extractorId: string; promptVersion: string; providerRef: string };
  maxInputBytes: number;
}): { status: "ready"; input: ExtractionInput } | { status: "skip"; reasonCode: "MEMORY_DISABLED" | "NO_NEW_INPUT" | "SOURCE_TOMBSTONED" | "INPUT_TOO_LARGE" }

interface ExtractionInput {              // deep-frozen、JSON 化可能。ホストはこれだけをモデル層へ渡す
  readonly runId: string; readonly inputDigest: string;
  readonly sources: readonly { ref: SourceRef; role: string; content: string }[];
  readonly shownState: readonly { itemId: string; revision: number; kind: StateKind; semanticKey: string; value: StateValue }[]; // replaces の対象として見せたもの
  readonly instructions: ExtractionPromptMaterial;   // 純粋に生成するテンプレート素材（文言 + JSON schema）。モデル呼び出しはしない
}

// 2) execute: ホスト（async）。Memory は型だけ提供
export type ExtractorPort = (input: ExtractionInput, signal: AbortSignal) => Promise<unknown>; // JSON.parse 済みの値

// 3) settle: write tx 内。同期
settleExtraction(db, {
  contractVersion: 1; access; scopeKey; clock; run: RunRef;
  output: unknown;                          // ExtractorPort の戻り値、またはホストの失敗区分
  currentSources: readonly SourceState[];   // ホストが同 tx で読み直したもの
  policy: AdmissionPolicy;
}): { status: "applied"; admitted: number; pendingUser: number; rejected: number }
  | { status: "stale"; reasonCode: "SOURCE_CHANGED" | "SOURCE_TOMBSTONED" | "STATE_CHANGED" | "RUN_UNKNOWN" | "RUN_ALREADY_SETTLED_DIFFERENT" }
  | { status: "rejected_output"; reasonCode: "OUTPUT_SCHEMA" | "OUTPUT_TOO_LARGE" | "TOO_MANY_CANDIDATES" }
```

- 冪等: 同じ run・同じ output の再 settle は前回結果を返す（output の canonical digest を run 行に保存）。違う output は `RUN_ALREADY_SETTLED_DIFFERENT`。
- stale 判定: run 入力の各 source の revision/digest が currentSources と一致し墓標がないこと。shownState の各 item の revision が現在と一致すること（違えば replaces を伴う候補だけでなく run 全体を stale。SAAA の CAS と同じ安全側）。
- 候補 schema（モデル出力、`src/extraction/candidate.ts`）: `{ noChange: boolean; candidates: [{ kind; subject; semanticKey; value: {text, polarity}; modality; temporal; evidence: [{ sourceIndex; startByte; endByte; quote }]; replaces?: itemId }] }`。最大 10 件、出力 ≤ 16 KiB（canonical JSON bytes）、`noChange` は candidates 空と同値。モデルが scope / confidence / status / origin を出したら `OUTPUT_SCHEMA`。
- 進捗: settle `applied` / `rejected_output` で `memory_source_progress` を更新。`stale` では更新しない（ホストは再 enqueue 判断）。Memory は job の status / attempt / lease / retry を保存しない（run 行は監査・冪等用）。
- **job 完了条件（ホスト側の規則として明記）**: settle が `applied` を返し、同 tx で queue の settle が成功した場合だけ job 成功。`stale` / `rejected_output` は job 側の失敗/再試行区分へ渡す（外部保存未確認で完了扱いにしない）。

### 3.7 World（`./sqlite` + 純粋）

```ts
rebuildWorld(db, { contractVersion: 1; access; scopeKey; clock; maxNodes: number })
  : { status: "rebuilt" | "up_to_date"; nodes: number } | { status: "partial"; nextCursor: string }  // 大きい scope は分割（ホスト job で回す）
readWorld(db, { access; scopeKey; rootKeys?: string[]; depth: 1 | 2 | 3; limit })  // 根と必要な閉包だけ（F02）
proposeWorld… は Consolidation 経由（§3.8 の purpose "reevaluate_world"）
```

派生規則（純粋 `deriveWorld(stateItems, records, priorObservations) → WorldNode[]`）: active な self の state item から entity/condition を、admitted の relation/prediction/observation 提案（consolidation 出力の adopted）から relation/prediction/observation を作る。射影なので `rebuildWorld` は同じ入力で同じ node 集合（node_id は内容由来の sha256）を作り、`memory_world_meta.built_from_state_revision` で鮮度を判断。

### 3.8 Consolidation

```ts
prepareConsolidation(db, { contractVersion: 1; access; scopeKey; clock; run: RunRef; purpose: "summarize" | "reevaluate_world"; mode: "off" | "preview" | "apply"; window: { maxInputs: number; maxBytes: number } })
  : { status: "ready"; input: ConsolidationInput /* manifest + 本文 */ } | { status: "skip"; reasonCode: "MODE_OFF" | "NO_NEW_INPUT" | "INSUFFICIENT_INDEPENDENT_ROOTS" }
export type ConsolidatorPort = (input: ConsolidationInput, signal: AbortSignal) => Promise<unknown>;
settleConsolidation(db, { …; run; output: unknown; policy })
  : { status: "applied" | "preview"; outputs: number } | { status: "stale"; reasonCode: "MANIFEST_CHANGED" | "NEWER_INPUT_EXISTS" | … } | { status: "rejected_output"; reasonCode }
```

- manifest = 入力（state item id+revision、record/message SourceRef、world node id+derivation_seq）の正規順リストと `manifestDigest = sha256(canonicalJson(manifest))`。prepare で `memory_consolidation_input` に固定、cursor（`last_input_seq`）を進めるのは settle 成功時だけ。
- settle で manifest を再計算して不一致なら `MANIFEST_CHANGED`（SAAA の `proposal-input-changed` と同じ）。prepare 後に同 scope へ新しい入力が入った場合は `NEWER_INPUT_EXISTS` で held（再実行はホスト判断）。
- 出力は `summary_note`（view には evidence 扱いでのみ入る。事実としない）または `world_proposal`（Admission と同じ quote 検査を通した relation/prediction/observation 提案）。依存辺は manifest 全入力へ張る（忘却閉包が届く）。

### 3.9 Lifecycle / Forget

```ts
planForget(db, { contractVersion: 1; access; target: ForgetTarget; clock }): ForgetPlan   // read のみ
type ForgetTarget =
  | { type: "record"; recordId: string }
  | { type: "host_source"; sourceKey: SourceKey; scopeKey: string }      // 会話 message 等。ホストが本体側で消した/消す出典
  | { type: "state_item"; itemId: string }
  | { type: "scope"; scopeKey: string }                                    // scope 内の本体所有データ全部
interface ForgetPlan { readonly entry: ForgetJournalEntry; readonly closure: { readonly counts: Readonly<Record<string, number>> }; readonly externalProviders: readonly string[] }
applyForget(db, { entry: ForgetJournalEntry; clock }): ForgetReceipt                      // write tx。冪等。enabled に依存しない
reconcileForgetJournal(db, { entries: readonly ForgetJournalEntry[] }): { status: "ok"; reapplied: number } | { status: "inconsistent"; reasonCode: "JOURNAL_TRUNCATED" | "JOURNAL_CHAIN_BROKEN" | "JOURNAL_MISSING" }
verifyForgetJournal(entries): …                                                           // 純粋
recordExternalDeletion(db, { forgetId; providerRef; state: "confirmed" | "unverified" | "failed"; clock })
getForgetReceipt(db, { access; forgetId }): ForgetReceipt
interface ForgetReceipt { readonly forgetId: string; readonly local: "applied"; readonly external: "none" | "pending" | "unverified" | "confirmed" | "failed"; readonly completed: boolean } // completed = local applied かつ external ∈ {none, confirmed}
```

閉包（`src/lifecycle/closure.ts`、純粋。入力は辺のリスト。store は再帰 CTE で起点から辺を集めて渡す）: 起点から `memory_dependency` を dependency→dependent 方向に推移的に辿る。**引用されなかった入力も含む**（run の `memory_extraction_input` と consolidation manifest は `input` 辺として張るため、run の候補・出力はすべて閉包に入る）。閉包内の各行: 本文/value_json/payload を NULL、status `forgotten`、FTS 行削除、墓標挿入、関係 scope の revision +1。world 射影は scope ごと `memory_world_meta` を無効化し次回 rebuild（SAAA と同じく射影全体を捨てる方が安全）。

外部プロバイダー: 閉包内の extraction / consolidation run の `provider_ref`（ホストが prepare で渡した）を集め、`memory_forget_external` に `pending` で登録。ホストが確認したら `recordExternalDeletion`。確認手段がないプロバイダーはホストが `unverified` を記録。`completed: true` を返す条件は上記のみ。

deactivate と forget の区別: deactivate（records / state）は本文を残す可逆操作で、墓標・ジャーナルを作らず、ForgetReceipt を返さない。API 名・reason・UI 文言で「忘却」と呼ばない。

Memory OFF: `applyForget` / `planForget` / `reconcileForgetJournal` は `enabled` を引数に取らない。抽出・consolidation の prepare は `enabled:false` / `mode:"off"` で skip。

---

## 4. 外部依存（モデル）の注入

- ポートは §3.6 / §3.8 の `ExtractorPort` と `ConsolidatorPort` の 2 種（World の再評価は `ConsolidatorPort` の purpose で兼ねる）。本体はポートを**呼ばない**。型と、prepare が返す入力・settle が受け取る出力の契約だけを持つ。ホストの queue handler の `execute` がポートを呼ぶ。
- Memory 内に queue を作らない: run 表は「どの入力で何が採用されたか」の監査と冪等のため。run の再試行判断・attempt 番号の発行・lease はホスト。Memory は RunRef を ID の一部として保存するだけで、attempt の大小を比較しない。
- prompt: `ExtractionPromptMaterial`（固定文言 + 出力 JSON schema + few-shot なし）を純粋に生成し版（`promptVersion`）を付ける。モデル固有の request 形式への変換はホスト。
- 決定的スタブ（`test/support/stub-ports.ts`）:
  - `cannedExtractor(map)`: `inputDigest → output` の表から返す。fixture の `modelOutput` をそのまま返す。
  - `ruleExtractor`: 「〜が好き」「〜が嫌い」等の数パターンの正規表現で候補を作る。**意味精度の主張には使わない**。パイプライン（prepare→settle→view→forget）の S/H 試験用。
  - `faultyExtractor`: schema 違反、範囲外 quote、11 件、巨大出力、遅延中の source 変更（settle 前に source を書き換える）を返す。
- 実モデル評価（E 段階）は `eval/` と `scripts/eval-run.ts` に分離。verify から呼ばない。ホストが実装したアダプター（例: Eumenes の LARM 経由）を CLI 引数のモジュールパスで受け取り、`prepareExtraction` → アダプター → `settleExtraction`（使い捨て DB）→ 採否を gold と比較。結果は `eval/results/<date>-<extractorId>-<promptVersion>.json`（モデル ID、promptVersion、データセット版、反復回数、指標）として保存し、`spec/verification-status.md` に要約。

---

## 5. Rust `personal-state-core` の扱い

### 5.1 事実（SAAA HEAD `28616e61ce5fe853383d4af6ec14e5b5d542c076`、読み取りのみ）

- 依存は serde / serde_json / sha2 のみ、時計・乱数・IO なし（`src/lib.rs:1-2`）。wasm32 を妨げる API は grep で見つからない（ビルドは未実施。この環境は wasm32 target 未導入、wasm-pack あり、napi なし）。MIT（crate と repo `LICENSE`、"Copyright (c) 2026 SAAA contributors"）。
- 中心は**メモリ上の `Ledger` 構造体に全遷移を保持し、status を replay で導出**する設計（`model.rs:241-265`、`reducer.rs:92-155`）。`Ledger` / `Projection` / `CommitContext` は Serialize を持たない。
- 種別は 14 種（continuity 系 7、profile 系 4、world 系 3）で、payload は外部参照（`payload_ref`）。self / 他人の subject 表現はない。modality は `EvidenceKind{UserReported, Inferred}` と World の `Epistemic` のみ。
- テスト 106 件は Rust 内の `json!` リテラルで、言語非依存の fixture ファイルはない。

### 5.2 比較手順（S3 の前に 1 日以内の spike。結果を `spec/rust-core-decision.md` に記録）

| 案 | spike 内容 | 判定観点 |
|---|---|---|
| A: TS 独自実装（SAAA の規則を出典付きで再実装） | §3.5 の reducer を最小実装し、§5.3 の共有 fixture 20 件を通す | 実装量、Eumenes 互換 typecheck、同期性 |
| B: Wasm（wasm32-unknown-unknown + 手書き JSON ABI） | scratch で crate を wasm32 にビルド、`Ledger` を JSON から再構成する薄い wrapper を書き、Bun で同期 instantiate して同じ fixture を流す | 配布物サイズ、Ledger の毎回再構成コスト（1 万遷移）、`exports` が TS ソース直 export の方式と両立するか、Eumenes の vite 側で import されない保証 |
| C: bun:ffi / napi（native） | 評価のみ（ビルドしない） | `src/` の `bun:*` 禁止に反する、ネイティブ配布、macOS 署名 |
| D: 別プロセス | 評価のみ | persistence-design §7 で不採用（単一 Writer を壊す） |

### 5.3 共有契約

M0 と同じ形式（`fixtureFormat: 1`、1 ファイル 1 ケース、期待値は手書き）で `fixtures/state/`・`fixtures/admission/`・`fixtures/lifecycle/` を作る。これが言語非依存の正本。SAAA の Rust テストから意味を移す場合は、ケースの出典（ファイル:行）を fixture の `"provenance"` に記録する。

### 5.4 推奨: **A（TypeScript で独自実装）**。Rust コアは参照仕様として扱い、取り込まない。

根拠:
1. **データ配置が合わない**。Rust コアは全履歴をメモリの Ledger に載せて replay する。本設計は共有 SQLite 上で scope 限定の行を読み書きする（F02 の対策そのもの）。B を採ると毎回 DB から Ledger を再構成して渡すことになり、F02 を再導入する。
2. **同期 transaction 内で動く必要**。A は追加の非同期初期化・ビルド成果物なしで `store.write` の同期 op 内で呼べる。B も同期 instantiate は可能（実測）だが、wasm バイナリのビルド・同梱・TS ソース直 export との二重化が要る。
3. **意味の差分が大きい**。本設計は subject（self / 他人）、modality 5 値、host 所有 kind の除外、kind ごとの admission policy を持つ。Rust コアにない概念で、どの案でも新規実装が必要。
4. M0 で確立した「依存ゼロ・手書き検査・言語非依存 fixture」の検証様式をそのまま使える。
5. plan §6「M0 の TS view を理由に状態遷移コア全体を TS へ書き直さない」への回答: 書き直すのは Rust コア全体ではなく、本設計に必要な規則のサブセット（遷移の CAS、supersede/dispute、依存閉包、quote 検査、World の確信を下げる方向のみの更新）で、理由は 1–3（データ配置と同期性）であって M0 ではない。
6. MIT のため規則の移植は可能。移植した規則ごとにコード冒頭コメントで出典（SAAA commit、ファイル:行）を記し、`THIRD_PARTY_NOTICES.md`（新規）に SAAA の MIT 表示を置く。コードのコピーはしない（Rust→TS の再実装）。

spike で B が「1 万遷移の Ledger 再構成 < 5 ms、wasm < 300 KB、同 fixture 全通過」を示しても、1 と 3 が残るので A を維持する。逆に A が共有 fixture を通せない場合だけ再検討（§9 Q5 ではなく実装判断）。

---

## 6. 横断方針

### 6.1 忘却の受入（S1 と S6 で段階的に）

| ID | シナリオ | 期待 |
|---|---|---|
| FG1 | record を forget | read / range / search / view v2 evidence / snapshot に出ない。FTS MATCH 0 件。墓標あり。ForgetReceipt local applied |
| FG2 | host_source を forget（その source から抽出した candidate・state item・consolidation output・world node がある） | 閉包内すべて forgotten、value NULL、view から消え、validate は既存 view を `SOURCE_FORGOTTEN` か `STATE_REVISION_MISMATCH` で invalid |
| FG3 | 引用されなかった入力の forget（run 入力 3 source のうち候補が引用したのは 1 つ） | run の全候補・採用 item も閉包に入る |
| FG4 | Memory OFF（enabled=false、mode=off）で forget | 成功。抽出は skip |
| FG5 | 外部プロバイダーに送った source を forget | external `pending`、`completed:false`。`recordExternalDeletion(confirmed)` 後に true。`unverified` は false のまま |
| FG6 | deactivate | 本文残存、墓標なし、ForgetReceipt なし、reactivate で戻る |
| FG7 | 復元（§2.5） | 古い DB + 最新ジャーナル → 不可視。冪等。ジャーナル破損で inconsistent |
| FG8 | 墓標済み ID の再 capture / 再抽出 | trigger で拒否 → `TOMBSTONED`。prepare は `SOURCE_TOMBSTONED` で skip |
| FG9 | settle 前に source が forget された run | `stale: SOURCE_TOMBSTONED`、候補を 1 件も書かない |
| FG10 | 閉包の不変条件（property） | ランダムな依存グラフで、forget 後に「forgotten でない行の依存に forgotten 行がない」 |

### 6.2 deactivate と forget

§3.9 のとおり。fixture・API・reasonCode・文書のどこでも deactivate を「忘却」「削除」と書かない（hygiene テストで `deactivate` 系関数が墓標表を触らないことを SQL 監視で確認）。

### 6.3 World の循環根拠による確信増加の防止

- **根（root）**: 依存辺を dependency 方向に辿って到達する葉の出典（会話 message の SourceKey または record の SourceKey + revision）。consolidation output・world node・state item は根にならない。
- **独立根拠数** = 異なる根の数。ただし同一 quote（空白正規化後の sha256）を持つ根は 1 つに数える（SAAA `independent_origins`、admission.rs:174-205 と同じ考え方）。consolidation 出力は manifest の根をそのまま引き継ぐので、要約を何度重ねても根の数は増えない。
- 確信レベル（序数 0–3、確率ではない）: 0 = hypothesis、1 = 根 1、2 = 根 2 以上、3 = 根 2 以上かつ予測と独立な根の観測で確認。観測による確認は「観測の根 ∩ 予測の根 = ∅」の場合だけ数える。反証（challenges）は下げるだけ（SAAA `CounterevidenceV1` の下げ方向のみの方針）。
- 循環: 依存辺の追加時に再帰 CTE で到達性を検査し、循環は `DEPENDENCY_CYCLE` で拒否（深さ上限 256、SAAA reducer.rs:343 と同じ）。
- 受入 fixture（`fixtures/world/`）: W1 同じ message を 2 回要約 → root_count 1 のまま。W2 要約 A を入力にした要約 B → 根は A の根と同じ。W3 予測の根と同じ message を観測根拠に使う → 確認に数えない。W4 循環辺 → 拒否。W5 同文 quote を別 message から 2 件 → 1 と数える（コピペ対策）。W6 反証で level が下がり、同じ支持を再投入しても元に戻らない。

### 6.4 日本語の評価データ方針

二層に分ける。

**(a) 決定的 fixture（F 段階、verify 対象）**: `fixtures/admission/` に「入力本文 + 手書きの候補（モデル出力を模したもの）+ 期待 decision / reasonCode」。モデルの能力ではなく **Admission 規則が誤った候補を止めるか**を検証する。各カテゴリ最低 4 件:

| カテゴリ | 例（合成） | 期待 |
|---|---|---|
| 否定 | 「辛いものは好きじゃない」→ polarity negated の候補 | admitted/pending は negated のまま。polarity affirmed の候補は quote と意味が逆でも規則では検出できない → **E 段階で測る**と fixture に注記 |
| 二重否定・部分否定 | 「嫌いではない」「全部が好きなわけではない」 | 候補が affirmed の強い好みなら規則では止められない → E で測る |
| 仮定 | 「もし時間があれば毎朝走りたい」 | modality hypothetical → rejected |
| 疑問 | 「コーヒーやめたほうがいいかな？」 | question → rejected |
| 引用 | 「『猫が苦手』って書いてあった」 | 括弧内 quote → pending_user `MODALITY_QUOTED` |
| 伝聞 | 「兄はラーメンが好きらしい」 | subject other → `other_person_note` で pending_user |
| 別人情報 | 「母は甘いものを控えている」 | self の personal_fact にならない |
| 嗜好変更 | 「前は紅茶派だったけど、今はコーヒー」 | 新根拠で supersede、古い根拠での逆転は `OLDER_EVIDENCE` |
| 訂正 | 「訂正します。辛いものが好きです」（SAAA memory_contract.rs:244 と同型） | supersede |
| 過去の状態 | 「学生のころは毎日ゲームしていた」 | temporal past → current の状態にしない（pending_user） |

**(b) 実モデル評価セット（E 段階、verify 対象外）**: `eval/datasets/ja-memory-v1.jsonl`。
- **すべて合成**。実会話・SAAA の製品データを使わない。SAAA の `tests/fixtures/personal-state/ja-corpus.json`（64 件、8 カテゴリ、`humanReviewed: false`）はカテゴリ設計の参考にし、本文は流用しない（参照のみ。流用する場合はライセンスと出典を記録して別判断）。
- カテゴリ: 否定 / 二重否定 / 仮定 / 疑問 / 引用 / 伝聞 / 別人情報 / 嗜好変更 / 訂正 / 過去 / 複数根拠 / 無変化（雑談）。各 dev 15・test 15 以上。SAAA にない「嗜好変更」「別人情報」を独立カテゴリにする。
- 各ケース: sources、gold candidates（kind, subject, semanticKey, polarity, modality, temporal, span）、`forbidden`（作ってはいけない self 状態）、gold の人手確認者と日付（未確認なら `humanReviewed:false` を明示し、その結果は「暫定」と記録）。
- 指標: (1) **誤採用率**（admitted のうち gold にない、または forbidden に当たる）— 最重要。仮定・引用・伝聞・別人情報カテゴリで test セット 0 件を `auto_admit` 有効化の必要条件とする。(2) 採用精度、(3) 候補再現率（参考）。3 回反復し最悪値を記録。
- 閾値の最終値はユーザー判断（§9 Q2）。評価前の auto_admit は不可。

### 6.5 検証ラダー

| 段 | 内容 | 実行場所 |
|---|---|---|
| L1 fixture | 言語非依存 JSON、期待値は手書き + `fixture-digest.py` で独立計算 | `bun test`（verify） |
| L2 property / mutation | 生成グラフでの閉包不変条件、検索戦略の同値、reducer の可換でない操作の順序依存確認。mutation は M0 と同じ手動手順を各スライスで 5 箇所以上（結果を記録して戻す） | `bun test` / 手動 |
| L3 SQL 実 DB | `test/support/store.ts` の使い捨てファイル DB（WAL、writer + readonly reader、同期 op を 1 transaction で実行する Eumenes と同形）。readonly 接続への書き込み拒否、transaction 外呼び出し拒否、migration 全適用、hash 照合 | `bun test` |
| L4 復元 / 忘却シナリオ | FG1–FG10、DB ファイルの複製と復元、ジャーナル破損 | `bun test`（`test/scenario/`） |
| L5 ホスト結合 | Eumenes の Writer / queue / dialogue settle での結合試験 | Eumenes 側（§8） |
| L6 実モデル評価 | §6.4(b) | `scripts/eval-run.ts`（手動） |

各機能の到達段を `spec/verification-status.md`（新規、親担当が所有）の表に「機能 × I/F/S/H/E」で記録し、スライス完了時に更新する。

---

## 7. 実装順序（縦切りスライス）

各スライスは「契約（型・reasonCode）→ 純粋部品 + fixture → SQL + migration → シナリオ → 文書更新」の順で閉じる。CP は `bun run verify` exit 0。

### S0 基盤と契約固定 — **単一エージェント（親）、don't split**

- 内容: `./sqlite` subpath（package.json exports）、`src/sqlite.ts`、`MemoryDb` / `MemoryStoreError` / `assertWritable` / seq、migration 0001、`assertMemorySchema`、`test/support/store.ts`（Writer 相当）、§3 の**全 family の型・reasonCode タプル・LIMITS_*・CONTRACT_VERSIONS**（実装は空でよいが型は確定）、hygiene テストの依存方向拡張、exports テスト更新、`spec/verification-status.md` 雛形、`THIRD_PARTY_NOTICES.md`。
- fixture: なし（S0-T: unit test。readonly 拒否、transaction 外拒否、migration hash 不一致検出、版が新しい DB の拒否）。
- 受入: 既存 404 テスト不変で通過、M0 fixture 101 件無変更、`./sqlite` を self-reference で import する consumer テスト追加。到達: I, S。

### S1 Records + 墓標 + 忘却の最小形 + ジャーナル（F03） — S0 後

- 表: 0002 records、0001 の tombstone / forget / journal_state。
- API: captureRecord, readRecord, readRecordRange, recordSourceStates, deactivate/reactivateRecord, planForget/applyForget/reconcileForgetJournal/verifyForgetJournal（target `record` と `scope` のみ）、getForgetReceipt。
- fixture: `fixtures/evidence/`（range 読み出し、日本語・絵文字境界、64 KiB 上限）、`fixtures/lifecycle/L01–L10`（journal entry の canonical / hash 鎖、破損検出、閉包計算の入力辺→期待集合）。
- シナリオ: FG1, FG6, FG7, FG8（record 分）。
- 受入: F03 受入（§2.5）が L4 で成立。到達: I, F, S。

### S2 Recall — S1 後（S1 と同じ担当が続ける。表を共有するため **S1 と split しない**）

- API: searchRecords（LIKE / FTS 戦略、cursor、blocked 結果）。
- fixture: `fixtures/recall/`（2 文字・3 文字、scope 外が出ない、forget 後 0 件、戦略間同値の小ケース）。
- property: ランダム本文・ランダム query で like 戦略と fts 戦略の結果集合が一致（3 文字以上）。
- bench: `scripts/bench-scope.ts` を作り結果を記録、`LIKE_SCAN_MAX` を確定。
- 到達: I, F, S。

### S3 State 台帳（モデルなしの明示操作）— S0 後、S1 と**並列可**

- 表: 0003 の state_item / state_event / dependency 利用。
- 純粋: reducer、admission 規則表（Extraction でも使う）。
- API: assertUserState, edit/deactivate/reactivate/retractState, listState, readMemorySnapshotPart（state 部分）。
- fixture: `fixtures/state/S01–S20`（CAS、supersede、OLDER_EVIDENCE、dispute、同 key 一意、subject other の扱い）、Rust spike（§5.2）はこのスライス開始前に実施。
- 到達: I, F, S。

### S4 View v2 — S1 と S3 の後（親が実施。`src/view`・`src/validation`・exports を触るため **don't split**）

- schemaVersion 2 の build / validate / parse、evidence と coverage.omitted、subject 除外、readMemorySnapshotPart の records 部分。
- fixture: `fixtures/build-v2/`（B201– : v1 と同一入力の v2 化、新 kind、evidence 省略、必須超過 overflow、forgotten evidence で blocked）、`fixtures/validate-v2/`。v1 fixture 無変更通過。
- 到達: I, F, S。

### S5 Extraction — S3・S4 後

- 表: 0003 の run / input / candidate / candidate_evidence / source_progress。
- API: prepareExtraction, settleExtraction, confirmCandidate, ExtractorPort 型, prompt 素材。
- fixture: `fixtures/extraction/X01–X30`（canned output → 期待 decision、stale 系、冪等、出力上限）、`fixtures/admission/`（§6.4(a) 全カテゴリ）。
- シナリオ: FG9、stub ポートを使った prepare → (source 変更) → settle。
- 到達: I, F, S。**意味精度は主張しない**。

### S6 Lifecycle 全閉包 — S5 後

- forget target `host_source` / `state_item`、外部削除、閉包が candidate / state / run に届くこと。
- シナリオ: FG2–FG5, FG9, FG10（property）。
- 到達: I, F, S（L4）。

### S7 World — S3 後に純粋部分を並列可、永続は S6 後

- 表: 0004。純粋: deriveWorld、roots、confidence、cycle 検出。API: rebuildWorld, readWorld。
- fixture: `fixtures/world/W01–W12`（§6.3 の W1–W6 を含む）。
- 到達: I, F, S。

### S8 Consolidation / World 再評価 — S6・S7 後

- 表: 0005。API: prepare/settleConsolidation, ConsolidatorPort。
- fixture: `fixtures/consolidation/K01–K12`（manifest digest、MANIFEST_CHANGED、NEWER_INPUT_EXISTS、preview/apply、要約の要約で根が増えない、forget で出力が消える）。
- 到達: I, F, S。

### S9 評価基盤 — S5 後いつでも（独立）

- `eval/` データセット雛形（合成）、`scripts/eval-run.ts`（アダプターを引数で受ける）、結果形式。実モデル実行は H 後に Eumenes のアダプターで行う。到達: 基盤は I。E は実行後。

### S10 ホスト結合 — Eumenes 側（本リポジトリ外）。§8 の一覧。

### 並列化

| 境界 | 並列可否 | 理由 |
|---|---|---|
| S1+S2（records/recall）と S3（state） | 可 | 書き込み先が `src/store/records.ts`・`recall.ts`・`src/recall/` と `src/state/`・`src/store/state.ts` で分離。migration は各自 `0002-*.ts` / `0003-*.ts` を作り、`migrations/index.ts` への登録は親 |
| S7 純粋部分（`src/world/`） | S3 型確定後に可 | store を触らない |
| S9 | 常に可 | `eval/`・`scripts/eval-run.ts` のみ |
| S0, S4 | 不可（親） | 契約・公開面・exports・M0 コードを触る |
| S5, S6, S8 | 順次（単一） | candidate / dependency / lifecycle が強く結合 |

共有ファイル（親のみ編集、ワーカーは変更要求を返す）: `package.json`、`bun.lock`、`src/index.ts`、`src/sqlite.ts`、`src/contracts/**`（型・reasonCode・LIMITS）、`src/store/migrations/index.ts`、`src/store/db.ts`、`src/contracts/test/exports.test.ts`、`test/src-hygiene.test.ts`、`test/fixture-runner.ts`、`scripts/verify.ts`、`spec/verification-status.md`、`README.md`。
fixture runner は family ごとに `test/runners/<family>.ts` を新設してワーカーの所有にし、`test/fixtures.test.ts` からの登録は親。

ワーカーの targeted test: `bun test src/<layer>/test test/scenario/<family>.test.ts`。全体 verify は親が最後に 1 回。

---

## 8. Eumenes 側（M1 以降）で必要な変更（読み取りのみで確認。実装しない）

確認したファイル: `api/infrastructure/sqlite/index.ts`（openStore、flock、migration は 1 要素 1 transaction、`store.write` は同期 op を transaction で実行、キュー上限 64）、`api/application/server.ts:36-46`（migration 配列、追記コメント）、`api/domains/queue/types/index.ts:82-109`（HandlerDefinition）、`api/domains/continuity/service/index.ts:53-58`（sourceStatus は ok/missing/changed）、`api/domains/conversation/service/index.ts`（削除操作なし）。

| # | 変更 | 対応する本体機能 |
|---|---|---|
| E1 | `package.json` に `eumenes-memory` 依存（当面 `file:../eumenes_memory`、正式は plan §7 の tgz）、`bun install` | 全体 |
| E2 | `api/domains/memory`（adapters / service / test）: ConversationSourceAdapter、ContinuityStateAdapter、MemoryClient（`.` と `./sqlite` を呼ぶ薄い層） | S4 |
| E3 | conversation / continuity に transaction 内 snapshot 読み出し（本文込み）の公開操作を追加（`getSnapshot` は active のみで本文なし） | S4 |
| E4 | `server.ts` の migration 配列末尾に本体 migrations を 1 要素ずつ追記。「本体 migrations が部分列として正しく並ぶ」テスト。起動時 `assertMemorySchema` | S0 |
| E5 | 起動 recover 順に `reconcileForgetJournal` を追加（queue.start() より前）。失敗時は Memory 機能を停止（fail closed） | S1 |
| E6 | 墓標ジャーナルファイル（例 `<db>.memory-forget.jsonl`、0600、tempfile→fsync→rename→dir fsync）と追記処理 | S1 |
| E7 | 会話 message の削除（忘却）操作と、その後の `planForget/applyForget(host_source)` 呼び出し。conversation 側の墓標（再作成拒否）。Continuity bookmark の source が forgotten になった場合の扱い（sourceStatus に forgotten を追加） | S6 |
| E8 | dialogue handler: prepare で view v2 構成、settle で `validateMemoryView` と UsageReceipt（dialogue 側 migration 追記）。stateRevision の合成規則 `"c:<n>|m:<memoryRevision>"` | S4 |
| E9 | queue handler `memory.extract`（background lane、dedupeKey = scope + source revision 集合の digest、recovery `replay_safe`）: prepare/settle は本体関数、execute で LARM 経由の ExtractorPort。settle 成功時のみ job 成功 | S5 |
| E10 | queue handler `memory.consolidate` / `memory.world.rebuild`（partial を次 job へ） | S7, S8 |
| E11 | 設定: Memory enabled、policyRevision、kind 別 AdmissionPolicy（既定 user_confirm）、consolidation mode | S5, S8 |
| E12 | 候補確認 UI / API（pending_user の一覧と admit/reject） | S5 |
| E13 | 外部プロバイダー削除の確認手段（LARM 側で確認できないなら `unverified` を記録） | S6 |
| E14 | 推奨 PRAGMA（`secure_delete=ON`）と忘却後 checkpoint、バックアップ/復元手順の文書（ジャーナルは DB バックアップに含めない） | S1 |
| E15 | Records のプロデューサー（現状 Eumenes にツール取得物の経路は見当たらない、未確認） | S1/S2 の H 段階 |
| E16 | 実モデル評価用アダプター（`scripts/eval-run.ts` に渡すモジュール） | S9 |

---

## 9. リスクと未決事項

リスク
- **R-A（未検証）**: FTS5 / trigram はこの macOS のシステム SQLite で確認。Bun が同梱 SQLite を使う環境（Linux 等）や OS 更新で compile options が変わり得る。`assertMemorySchema` で `fts5` の存在を検査し、なければ `FTS_UNAVAILABLE`（LIKE 戦略のみで動作）にする。
- **R-B**: 物理消去（空き領域、WAL、OS のスナップショット、Time Machine）は保証しない。残渣観測は小規模 1 回のみ。
- **R-C**: 復元直後の DB を本体だけでは検出できない（§2.5-3）。ホストの起動手順（E5）が必須で、H 段階まで F03 は「S 段階で成立」止まり。
- **R-D**: `store.write` の共有キュー（上限 64）。閉包の大きい forget や world rebuild は 1 transaction が長くなる。S6/S7 で 1 万行の forget 時間を測り、閾値超過なら scope 単位の分割（ただし forget は分割すると途中状態が見えるため、分割するのは world rebuild だけ）。
- **R-E**: 日本語の否定・二重否定の極性誤りは Admission 規則で止められない（quote は一致する）。E 段階まで auto_admit を使わないことで緩和。
- **R-F**: migration を採用前に統合してよい規則（§2.3）は、誤って Eumenes の実 DB へ早期適用すると破綻する。H の最初の取り込みで凍結点を記録する。
- **R-G**: SAAA の規則を TS で再実装する際、意味の取り違えがあり得る。共有 fixture に出典を付け、差分は設計判断として記録する。

ユーザーに確認が必要な判断（最小限）
- **Q1 墓標ジャーナル**: 本設計はジャーナル（DB 外ファイル）を必須にし、所有をホスト（Eumenes）に置く。代案は「復元手順の制約として契約に書くだけ」（実装が軽いが F03 受入を満たさない）。**推奨: ジャーナル必須**。
- **Q2 自動採用**: 既定は全 kind `user_confirm`（候補生成のみ）。`auto_admit` を許す条件を「E 段階で仮定・引用・伝聞・別人情報の誤採用 0 件」とする案でよいか。
- **Q3 Records の初期用途**: Eumenes に外部取得物の経路がまだない（未確認）。Records は S 段階まで実装し、H はプロデューサーができてからでよいか。
- **Q4 F02 の閾値**: 応答予算が未定のため、bench は記録のみとし合否を付けない。

実装時に決めてよい事項（ユーザー確認不要）: `LIKE_SCAN_MAX` の値、各 LIMITS_* の値、prepared statement キャッシュの要否、reasonCode の細目名。

## 10. 確認済みの判断（2026-10-08、ユーザー回答）

- **Q1 墓標ジャーナル:** 必須。所有はホスト（Eumenes）。
- **Q2 自動採用:** 「問題ない」との回答。§9 の案（既定は `user_confirm`、E 段階で誤採用 0 件を確認した kind から `auto_admit` を許可）を了承したものとして扱う。確認なし採用の項目も、`origin` で由来を区別し、訂正・忘却の対象にする。
- **Q3 Records:** S 段階（実 SQL DB での検証済み）で進める。この リポジトリの DB はテストごとに初期化する使い捨てで、永続データの保守は Eumenes 側が行う（persistence-design §2.1 と一致）。
- **Q4 数値の記録:** ここでの「数値」は、ベンチマークの計測値（応答時間・読む行数）の記録であり、ベクトル・埋め込みのことではない。**元の言語に戻せない表現だけを正本にすることはしない**。正本は常に原文（テキスト）と出典参照で、検索はテキスト（FTS / LIKE）。埋め込みを将来導入する場合も、原文に必ず戻れる派生インデックスに限り、検索評価で必要性を確認してから（plan §5）。
- **記憶の範囲:** Episode（出来事の記憶）は ContextStill が扱う。本体は Episode 以外に、会話をまたいで覚えておくべき話題（目的・決定・未解決事項に加え、好み・継続中の話題・本人に関する事実など）を記憶する。「相手が健忘症でない」ことが目的であり、State / Extraction（S3・S5）を後回しにしない。
  - 未決: ContextStill との境界（どちらが何を持ち、View にどう合流するか。重複して覚えないための参照規則）を、ContextStill 側の公開面を確認して設計に追記する。
- **Procedure（Rule / Skill に相当する手順）:** 本体の対象外。Procedure は指示そのもので、優先順位とツール権限を決めるホスト（Eumenes）が扱う。本体の View は `instructionAuthority: none` の参照データであり、指示の権限を持つ文面を同じ経路に混ぜない。ContextStill が保管し、Eumenes が読み出して適切な権限でプロンプトに入れる。本体は Procedure を保存も参照もしない。
