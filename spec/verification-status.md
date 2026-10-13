# 検証状況（機能 × 到達段階）

設計の正本は [full-system-design.md](full-system-design.md)。正直さの規律: 各機能は到達した段階までしか主張しない。H（ホスト結合）前の機能を「完了」と書かない。

| 段階 | 記号 | 意味 |
|---|---|---|
| contract | C | 型・定数・reasonCode・上限が確定している |
| implemented | I | コードがあり型検査・単体テストが通る |
| fixture-verified | F | 言語非依存 fixture と property 検査が通る |
| sql-verified | S | 使い捨ての実 SQLite（ファイル + WAL）で永続・トランザクション・復元シナリオが通る |
| host-integrated | H | Eumenes の Writer / queue / 採用 transaction に結合した試験が通る |

## 1. 到達段階表

`●` = 到達、`—` = 未着手または対象外。

| 機能 | C | I | F | S | H | 備考 |
|---|---|---|---|---|---|---|
| MemoryDb ポート、`MemoryStoreError`、writable 検査、seq 発行 | ● | ● | — | ● | — | unit + 実 SQLite（readonly 接続・transaction 外の拒否） |
| `assertMemorySchema`（migration hash 検査）、`checkHostMigrations` | ● | ● | — | ● | — | hash 不一致・版が新しい・版が古い・表なしを検出。ホストの配列への追記の検査 |
| テスト用 Writer（`test/support/store.ts`） | ● | ● | — | ● | — | WAL ファイル DB、書き込み 1 + 読み取り専用 1、`snapshotTo` で複製 |
| 変更フィード（`listMemoryChanges` / `latestMemoryChangeSeq`） | ● | ● | — | ● | ● | 本文なし。`latestMemoryChangeSeq` は scope で可視な変更の最大 seq で、ホストが内部の表を読まずに世代を見る |
| ExternalDependent（`registerExternalDependents` / `unregisterExternalDependents` / `recordExternalDeletion`） | ● | ● | ● | ● | ● | 外部派生物 `(providerRef, externalId)` を node 種別 `external` で登録し、forget の閉包に入ると `memory_forget_external` に `pending`。receipt は failed > pending > unverified > confirmed に集約 |
| Records（`captureRecord` / `readRecord`、再生成可能な資料の retention） | ● | ● | ● | ● | ● | fixture E01–E10（`sliceUtf8Range` を含む）、復元シナリオ（古い DB + 最新ジャーナル）。Eumenes 結合: Web 調査のキャッシュが retention を使う |
| State 台帳（`assertUserState` / `deactivateState` / `reactivateState` / `retractState` / `listState` / `readStateFact`、reducer） | ● | ● | ● | ● | ● | fixture S01–S07・S11–S16・S20・S21・S24。origin `agent_inferred`（ユーザー由来の保護は受けない）。既存 DB の `disputed` / `invalidated` / `admitted_extraction` の行の読み取りと遷移も実 SQLite で試験 |
| Lifecycle / Forget（plan / apply / reconcile / receipt、外部削除） | ● | ● | ● | ● | ● | target は record / host_source / state_item / scope。閉包は state_item / external に届き、値を消す。論理的な削除で、物理消去は保証しない。Eumenes 結合: state_item の忘却を外部 journal（fsync）経由で適用、起動時 reconcile、古い DB 復元で再適用、journal 改ざんで Memory を使わない |
| 時間判定（temporal: 精度つき期間、現在/過去/未来/時点不明） | ● | ● | — | ● | ● | 成立期間の精度・根拠は State に永続（`assertUserState` の `validity`）。Eumenes 結合で期限切れ項目を現在の理解から除外 |
| World / Consolidation | — | — | — | — | — | **本体では作らない**（別ドメイン・別リポジトリ）。接続部は ExternalDependent と変更フィードだけ |

## 2. migration

0001〜0007 は Eumenes の実 DB に適用済みで、本文と順序を変えない（追記専用）。0008 は未リリースの追記。SQL 定義は所有ドメインの `migrations/`、登録は `src/infrastructure/sqlite/migrations/index.ts`（手順は同ディレクトリの README）。

| 番号 | 内容 |
|---|---|
| 0001 | foundation（schema_info / seq / scope_state（0008 で削除） / dependency / tombstone / forget / forget_external / journal_state / change） |
| 0002 | records（record / revision / body / provider、全文索引） |
| 0003 | state（item / attribute / evidence / event）と抽出の表 |
| 0004 | state の成立期間の精度つき日付と根拠 |
| 0005 | records の再生成可能な資料の保持（`memory_record_retention`） |
| 0006 | 忘却した資料の retention metadata を除去する |
| 0007 | state の origin に `agent_inferred` を加える（CHECK の変更のため state 表4つを作り直し。行は不変） |
| 0008 | 抽出の6表、全文索引 `memory_record_fts`、`memory_scope_state` の削除。取り除いた node 種別の依存辺と墓標の削除。`src/infrastructure/sqlite/test/remove-extraction-migration.test.ts` が、抽出の行・候補由来の State・過去の忘却の記録を含む版 7 の DB への適用と、その後の読み取り・忘却・ジャーナルの照合・ExternalDependent の登録を試験する |

既存の CHECK 制約は作り直さないので、`candidate` / `extraction_run` / role `input`（依存辺・墓標）と、State の `admitted_extraction` / `disputed` / `invalidated` / `dispute` / `invalidate` / `candidate` は、既存の行に残りうる語彙として DB の制約に残る。TS 側は、書かない語彙（`candidate` などの node 種別、`input`）を型から外し、読む語彙（State の status / origin / event / cause）を残している。

0008 は閉包を狭める（受容済みの変更）: 抽出の run が読んだだけで item が引用していない出典を忘れても、その run 経由で抽出由来の item には届かない。item が根拠として引用する出典は従来どおり届く。Eumenes は抽出を実行したことがなく、実データは無い。

## 3. 確定事項（型の置き場所）

| 内容 | 場所 |
|---|---|
| 共通（SourceKey, EvidenceSpan, HostClock, Polarity, ScopedRead/Write, MissingStatus） | `src/contracts/common.ts` |
| `CONTRACT_VERSIONS`（records / state / lifecycle / external） | `src/contracts/versions.ts` |
| Records / State / Lifecycle / Temporal の契約 | `src/domains/<domain>/contracts/` |
| ExternalDependent / 変更フィード | `src/contracts/external.ts` |
| 依存辺・墓標の語彙 | `src/contracts/dependency.ts` |

`.` からは contracts の全 export（型 + 定数）と純粋関数、`./sqlite` は関数・`MemoryDb`・`MemoryStoreError`・`migrations` と入出力の型を出す（定数は `.` から import）。

## 4. hygiene とテストの形

- src の禁止語（コメント・文字列を含む）: `Date` / `Math.random` / `process` / `fetch(` / `JSON.parse` / `Intl` / `localeCompare` / `globalThis` / `Bun.` など（`test/src-hygiene.test.ts`）。`bun:*` は src 全体で禁止、`node:crypto` は `src/canonical/sha256.ts` だけ。
- `src/infrastructure/sqlite` と各 `repository` に `BEGIN` / `COMMIT` / `SAVEPOINT` / `.transaction(` / `async` / `await` を書かない（コメント以外）。
- JSON 文字列の列は `JSON.parse` で読めない。SQL の `json_extract` / `json_each` を使うか列に分解する。
- `INSERT OR IGNORE` は CHECK 違反まで無視する。重複だけ無視するなら `ON CONFLICT DO NOTHING`。
- unit test は各ドメインの `test/`、DB は `test/support/store.ts` の `openTestStore()`。consumer テストは `test/consumer/` で `eumenes-memory` / `eumenes-memory/sqlite` / `../support/store.ts` だけを import する。
- 検証は `bun run verify`（format → lint → boundaries → typecheck → Eumenes 互換 typecheck → test → public-surface）。ソースを書き換えず、`verification-reports/` に記録する。

## 5. 範囲の決定

- World / Consolidation は別ドメイン・別リポジトリ。本体は接続部だけを提供する: (a) `ExternalDependent`、(b) 読み取り専用の変更フィード `listMemoryChanges(db, { afterSeq, limit })`（ID と版・状態だけ。本文は別 API）。
- Rust の `personal-state-core` は取り込まない（[rust-core-decision.md](rust-core-decision.md)）。
- Eumenes が使わない機能は持たない。

## 6. 限界

- 物理消去（空き領域、WAL、OS のスナップショット）は保証しない。ホストの責任（`secure_delete`、checkpoint、VACUUM）。
- 復元直後で reconcile 未実行の DB は本体だけでは検出できない。ホストの起動手順（ジャーナルの存在確認）が必須。
- 外部の確認状況は DB の中にだけあり、古い DB を復元して reconcile すると外部削除は `pending` に戻る。
- 外部派生物の依存辺はジャーナルに載らない: 古い DB を復元した場合、スナップショット後に登録した外部派生物は閉包に入らない（外部が再登録してから reconcile する）。
- 日本語の意味精度は本体の対象外（本体はモデルを呼ばない）。
