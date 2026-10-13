# `eumenes-memory/sqlite` 永続層（共通基盤と各ドメインのrepository）

ホストが渡す `MemoryDb` に対する**同期関数とスキーマ定義だけ**を提供する。接続の open/close、flock、WAL、PRAGMA、
transaction、migration の実行、非同期処理（モデル呼び出し）はホストの責任。設計の正本は
[spec/full-system-design.md](../../../spec/full-system-design.md) §2 と [spec/persistence-design.md](../../../spec/persistence-design.md)。

## 規則（共通基盤と各repositoryが守る）

- `bun:sqlite` を import しない。`MemoryDb`（`db.ts`）の構造的型付けで満たす。`BEGIN` / `COMMIT` / `SAVEPOINT` /
  `db.transaction()`、`async`、グローバル状態、接続の保持を持たない（`test/src-hygiene.test.ts` が検査）。
- 書き込み系の公開操作の入口は `enterWrite(db)`（`session.ts`）: transaction 内 → スキーマ版 → seq 発行。
  transaction 外は `MemoryStoreError("NOT_IN_TRANSACTION")`、読み取り専用接続は `READONLY_CONNECTION`。
- 読み取り系の入口は `enterRead(db)`。transaction は要求しない。複数文の読み出しの一貫性はホストの
  read transaction に依存する（その関数の JSDoc に明記する）。
- 読み出し SQL は status 列に加え、`NOT EXISTS (SELECT 1 FROM memory_tombstone ...)` を必須条件にする。
- すべての読み出し API は `AccessContext` と `scopeKey(s)` を取り、SQL は `(principal, scope_key)` で始まる index を使う。
  scope を指定しない全件 API を作らない。
- 行は `unknown` として受け、`db.ts` の `readInteger` / `readText` などで検査する（違反は `CORRUPT_ROW`）。
- `JSON.parse` は使えない（src の規則）。JSON 列を読む必要があれば SQL の `json_extract` / `json_each` を使うか、
  列に分解して保存する。モデル出力などはホストが読み込み済みの `unknown` として渡す。
- 派生行（state_item / external）は必ず `memory_dependency` に辺を持つ（`dependency.ts` の `addDependency`）。
- 変更のたびに `appendMemoryChange`（`changes.ts`）を呼ぶ。

## 共有部品（S0 で実装済み）

| ファイル | 内容 |
|---|---|
| `db.ts` | `MemoryDb` / `MemoryStatement` / `SqlValue`、`assertWritable`、`issueSeq`、`guarded`・`translateSqliteError`（SQLite 例外 → `MemoryStoreError`）、行の読み取り部品 |
| `errors.ts` | `MemoryStoreError` / `STORE_ERROR_CODES` / `isMemoryStoreError` |
| `session.ts` | `enterWrite` / `enterRead` |
| `schema-check.ts` | `assertMemorySchema`（migration hash 検査）、`checkSchemaAgainst`（テスト用に body 列を指定） |
| `migrations/` | 登録配列と 0001 foundation。手順は [migrations/README.md](migrations/README.md) |
| `dependency.ts` / `tombstone.ts` | `addDependency` / `isTombstoned` |
| `changes.ts` | `appendMemoryChange`（内部）/ `listMemoryChanges`・`latestMemoryChangeSeq`（公開、外部ドメイン向けフィードと最大 seq） |
| `records.ts` `state.ts` `lifecycle.ts` | `lifecycle.ts` は target record / host_source / state_item / scope の plan・apply・reconcile・receipt、ExternalDependent の登録・解除、外部削除の記録。値の消去は表の持ち主（`scrubRecord` / `scrubStateItem`）が行い、`lifecycle.ts` が閉包を求めて呼ぶ |

入出力の型・reasonCode・上限は各ドメインの `contracts/` と `src/contracts/external.ts`。

## ホストの起動手順（必須）

本体は状態を持たないため、「古い版へ復元された DB」を読み出し関数だけでは検出できない。**fail closed の責任はホストの起動手順にある**。

1. DB を開き、ホストの migration の後ろに本体の `migrations` を**各要素 1 本ずつ**追記して適用する（`[...hostMigrations, ...migrations]`）。
   ホスト側のテストで `expect(checkHostMigrations(hostMigrationsArray)).toEqual([])` を呼ぶ（欠落・重複・順序違い・改変を文字列で返す。空なら正しい）。
2. `assertMemorySchema(db)` を呼ぶ（版が新しい DB や migration の中身が違う DB は `SCHEMA_TOO_NEW` / `SCHEMA_MISMATCH` で拒否）。
3. 墓標ジャーナル（DB の外のファイル、所有はホスト）を読み、`reconcileForgetJournal` を **queue / worker の起動前**に実行する。
   `inconsistent` が返ったら Memory の読み出し・書き込みを止める（fail closed）。
4. 以後、書き込み系は `store.write` の同期 op（1 transaction）内、読み取り系は read transaction 内で呼ぶ。

運用の推奨: `PRAGMA secure_delete=ON`、忘却後の `wal_checkpoint(TRUNCATE)`。物理消去（空き領域・WAL・OS のスナップショット）は保証しない。
ジャーナルは DB のバックアップに含めない（古い DB とは別媒体で保管する）。

## 外部ドメイン（World など）との接続

本体は外部ドメインの型・表を持たない。接続は 2 つだけ（契約: `src/contracts/external.ts`）。

- `registerExternalDependents` / `unregisterExternalDependents` / `recordExternalDeletion`（S6、実装済み）: 外部派生物
  `(providerRef, externalId)` を依存閉包に登録（置き換え。忘却済みの対象には登録できない）。forget の閉包に入ると
  `memory_forget_external` に `pending` で載り、外部が削除を確認したら `recordExternalDeletion` で
  `confirmed` / `unverified` / `failed` にする。receipt の集約は failed > pending > unverified > confirmed、
  `completed` は外部削除が無いか全部 `confirmed` のときだけ。プロバイダー（外部へ送った record の
  `providerRef`）の外部削除も同じ表に `externalId = null` の行で載る。
- `latestMemoryChangeSeq`（実装済み）: 指定 scope で可視な変更の最大 seq（なければ 0）。ホストは `memory_change` を直接読まず、これを世代番号に使う。
- `listMemoryChanges`（実装済み）: 読み取り専用の変更フィード。ID と版・状態だけを返す。本文は `readRecord` / `listState` で読む。
  forget は record / state_item の `forgotten` と、host_source（SourceKey）の `source` `forgotten` を `forgetId` つきで流す
  （外部ドメインはこれを見て自分の派生物を作り直す／消す。外部が自分で消したら `recordExternalDeletion`）。

## forget の閉包と限界

- 起点: record は出典キー、host_source は出典キー、state_item は item、scope は scope の全 record / state_item / external（辺の scope_key が scope のもの）。
  `memory_dependency` を dependency → dependent に再帰 CTE で辿る（`reach` を外側にして `memory_dependency_by_dependency`
  で引く順に固定している。固定しないと辺の全走査が二乗になる）。
- 閉包内: state_item は value / polarity / 有効期間を NULL、semantic_key を ''、attribute / evidence の行を削除、event は action と seq だけ残す。
  墓標は state_item / external / source / record に書く。
- 依存辺は消さない（再適用の入力であり、`ID` 以外を持たない）。
- 限界: 物理消去（SQLite の空き領域、WAL、OS のスナップショット、Time Machine）は保証しない。外部の確認状況は DB の中にだけあるので、
  古い DB を復元して reconcile すると外部削除は `pending` に戻る（ホストが外部に再確認して `recordExternalDeletion` をやり直す）。
  scope の forget は他の scope が（まだ忘れていない行で）引用している出典に墓標を付けない（他 scope を巻き込まない）。
  外部派生物の依存辺（`registerExternalDependents`）はジャーナルに載らない: 古い DB を復元した場合、スナップショット後に登録した
  外部派生物は閉包に入らない（外部が再登録してから reconcile する）。他の principal / scope の行を指す target は plan が `blocked`、
  entry を直接作って apply しても `JOURNAL_ENTRY_INVALID`（まだ存在しない ID は、その ID の将来の作成を止める墓標になる）。
