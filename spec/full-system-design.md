# MemorySystem 設計

> **パス表記について**: 本書の `src/store/*` などは設計時点の旧構造を指すことがある。現在は共通基盤が `src/infrastructure/sqlite/`、各機能が `src/domains/<domain>/{contracts,service,repository,test}/` にある（[ドメイン構造](../src/domains/README.md)）。現行の公開面と契約は [README](../README.md) と各ドメインの `contracts/` が正本。

本体（`eumenes-memory`）は、出典を持つ記憶（State 台帳と Records）の保存、訂正、忘却、失効の通知を担当する。モデル呼び出し、queue、DB 接続、時計はホストが所有する。到達した検証段階は [検証状況](verification-status.md)。

| 段階 | 記号 | 意味 | 主張してよいこと |
|---|---|---|---|
| implemented | I | コードがあり型検査・単体テストが通る | 「実装済み」 |
| fixture-verified | F | 言語非依存 fixture と property 検査が通る | 「決定的な規則が fixture 上で成立」 |
| sql-verified | S | 使い捨ての実 SQLite（ファイル + WAL）で永続・トランザクション・復元シナリオが通る | 「本体単独の永続挙動が成立」 |
| host-integrated | H | Eumenes の Writer / queue / 採用 transaction に結合した試験が通る | 「Eumenes 上で動作」 |

H 前の機能を「完了」と書かない。

---

## 0. ゴール / 非ゴール / 禁止

ゴール
- 1 パッケージ `eumenes-memory` に、純粋 API（`.`）と永続 API（`./sqlite`）を持つ。
- 忘却は依存閉包・派生物・DB 復元まで含めて成立させる（F03 受入を必須）。
- ホストが使っていない機能は持たない（維持する面を小さくする）。

非ゴール
- HTTP サーバー、独自 DB 接続の open/close、PRAGMA 設定、queue / lease / retry / scheduler、モデル呼び出しと資格情報。
- embedding / ベクトル検索、全文検索。
- Continuity（goal / decision / open_question）の正本移管。会話原文のコピー保存（Records は外部取得物専用）。
- World / Consolidation（別ドメイン・別リポジトリ。接続部は ExternalDependent と変更フィードだけ）、Procedure（Rule / Skill。指示の権限を持つのでホストが扱う）。

禁止
- `src/` から `bun:*`、`node:crypto` 以外の組み込み、`Date`、`Math.random`、`process`、`fetch`、`JSON.parse`、`Intl`、`localeCompare` を使わない（`test/src-hygiene.test.ts` が検査）。時刻はホストが `atMs`（整数）で渡す。
- 本体関数内で `BEGIN/COMMIT/SAVEPOINT`、`db.transaction()` を呼ばない。async 関数を `./sqlite` から公開しない。
- ホストのテーブルを参照・外部キー参照しない。実会話データを fixture に使わない。

---

## 1. 全体アーキテクチャ

### 1.1 層と責務

| 層 | 責務 | 純粋/永続 | 正本 |
|---|---|---|---|
| Source / Evidence | SourceRef・版・digest・UTF-8 範囲・引用一致検査。host 由来の出典（会話）と Memory 所有の出典（Records）を同じ参照形で扱う | 純粋 | 会話: ホスト / Records: 本体 |
| Records | 外部取得物の本文・版・スコープ。再生成可能な資料の鮮度・未使用期限（retention） | 永続 | 本体 |
| State | 型付き状態（preference, personal_fact, constraint, habit, other_person_note）の台帳。明示操作による登録・置き換え・停止・撤回 | 純粋 reducer + 永続 | 本体 |
| Temporal | 精度つき期間、現在・過去・未来・時点不明の判定 | 純粋 | — |
| Lifecycle / Forget | deactivate（可逆）と forget（不可逆消去）、依存閉包、墓標、ジャーナル照合、外部削除の pending/unverified | 純粋（閉包計算）+ 永続 | 本体 |

### 1.2 ディレクトリ

```text
src/
  index.ts                 純粋 API の公開面（型・定数・純粋関数）
  sqlite.ts                "./sqlite" の公開面（永続 API）。ロジックを置かない
  canonical/               canonical JSON、SHA-256、UTF-8
  contracts/               共有契約（出典・アクセス・外部接続・依存辺の語彙・入力の読み取り部品）
  domains/{temporal,records,state,lifecycle}/
  infrastructure/sqlite/   MemoryDb ポート、schema 検査、seq、依存辺、墓標、変更フィード、migration 登録
fixtures/                  言語非依存の fixture（canonical utf8 evidence state lifecycle）
test/                      scenario / consumer / runners / support（テスト用 Writer）
```

依存方向と検査は [ドメイン構造](../src/domains/README.md) と `scripts/boundaries.ts`。

### 1.3 公開 API と版

1. `.`（`src/index.ts`）は型・定数・純粋関数だけ。`./sqlite`（`src/sqlite.ts`）は `package.json` の `exports` で分け、SQL 層も `bun:sqlite` を import しない。公開面は `src/contracts/test/exports.test.ts` と `test/scenario/sqlite-surface.test.ts` が固定する。
2. 永続 API の入力は family ごとの `contractVersion`（`CONTRACT_VERSIONS`: records / state / lifecycle / external）。未知版は `UNSUPPORTED_SCHEMA_VERSION`。
3. DB スキーマ版は `MEMORY_DB_SCHEMA_VERSION`（migration 本数と一致）。契約版・パッケージの版とは独立。
4. 永続 API のエラーは `MemoryStoreError`（message は `code` 固定、本文・ID を含めない）。入力検査違反は `MemoryContractError`。

---

## 2. 永続化

### 2.1 責任分担

本体は `MemoryDb` に対する同期関数とスキーマ定義だけを持つ。接続、WAL、PRAGMA、transaction、migration の実行、非同期処理、墓標ジャーナルのファイル操作はホストが所有する（[persistence-design.md](persistence-design.md)）。

### 2.2 MemoryDb ポート（`src/infrastructure/sqlite/db.ts`、`./sqlite` から型を export）

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
- 読み取り関数は `inTransaction` を要求しない（ホストが read transaction で囲む責任）。複数文読み出しを行う関数は「一貫性はホストの transaction に依存」と JSDoc に明記。
- 行は `unknown` として受け、小さな row reader で型検査（列欠落・型違いは `CORRUPT_ROW`）。

### 2.3 migration

- `NNNN-<name>.ts` が `export const sql: string` を 1 本持つ。`src/infrastructure/sqlite/migrations/index.ts` が順序付き配列を持ち、`migrations`（body + 版と hash の記録文）を組み立てる。各 SQL は 1 回の `exec` で完結、`BEGIN/COMMIT`・PRAGMA・ホスト表 DDL なし。手順は同ディレクトリの README。
- `memory_schema_info` に `db_schema_version` と `migration_<n>_sha256` を記録する。`assertMemorySchema(db)` は DB の版が本体の既知版以下で、既知範囲の各 hash が本体の SQL と一致することを検査する（`SCHEMA_MISSING` / `SCHEMA_MISMATCH` / `SCHEMA_TOO_NEW` / `SCHEMA_OUTDATED`）。全公開操作の入口で呼ぶ。
- 登録済みの migration の本文・順序は変えない。変更は追記する。
- ホスト側は `[...hostMigrations, ...memoryMigrations]` のように各要素を 1 本ずつ末尾に追記する。

### 2.4 論理スキーマ（すべて `memory_` 接頭辞、ホスト表への FK なし。本体表どうしの FK は可）

共通列の規約: `principal TEXT`, `scope_key TEXT`、`*_seq INTEGER`（`memory_seq` 由来の単調値）、`at_ms INTEGER`（ホストが渡した時刻。表示・期限判定用で、順序判定には使わない）。

| 表 | 内容 |
|---|---|
| `memory_schema_info` / `memory_seq` | 版と hash の記録 / 単調 seq |
| `memory_dependency` | 依存閉包の辺（dependent → dependency、role）。派生行（state_item / external）は必ず辺を持つ |
| `memory_tombstone` | 忘却済み ID の墓標（永久。本文・digest を持たない） |
| `memory_forget` / `memory_forget_external` | ForgetReceipt の正本 / 外部削除の確認状況 |
| `memory_journal_state` | 墓標ジャーナル照合位置（head の seq と hash） |
| `memory_change` | 変更フィード（ID と版・状態だけ。本文なし） |
| `memory_record` / `_revision` / `_body` / `_provider` | Records（外部取得物）。revision ごとに本文を保持。外部へ送った記録（provider） |
| `memory_record_retention` | 再生成可能な資料の鮮度期限・未使用期限・採用 revision |
| `memory_state_item` / `_attribute` / `_evidence` / `_event` | State 台帳。event は追記専用で、forget で action と seq だけ残す |

墓標の再挿入防止 trigger（`*_no_resurrection`）を record / body / revision / state_item に置く。

### 2.5 F03: 復元で忘却が戻らない設計

1. **読み出しの墓標除外**: Records / State を返す全 SQL は、status 列に加えて `NOT EXISTS (SELECT 1 FROM memory_tombstone ...)` を必須条件にする（二重化）。status を `active` に戻した（古い行を復元した）DB でも出ない。
2. **完全な再適用**: `applyForget(db, entry)` は冪等で、墓標の有無に関係なく本文削除・閉包の無効化を毎回実行する。
3. **墓標ジャーナル（DB の外）**: 忘却は 2 相。
   - `planForget(db, request) → ForgetPlan`（読み取りのみ、決定的）: 対象と閉包を計算し、ジャーナル entry（`journalFormat, seq, prevHash, forgetId, principal, targets, hash`。本文・digest を含まない）を返す。`hash = sha256(canonicalJson(entry 本体))`、`prevHash` で鎖にする。
   - ホストが entry をジャーナルへ追記して fsync（transaction の外）。
   - `applyForget(db, entry)`（write transaction 内、同期）: 閉包を**その時点で再計算**して適用し、`memory_journal_state` の head を進める。
   - 起動時: `reconcileForgetJournal(db, entries)`。DB の head がジャーナルより古ければ不足 entry を順に再適用する。ジャーナルが短い、鎖が壊れている、DB に墓標があるのにジャーナルが空、のいずれかなら `inconsistent`。ホストは Memory を止める（fail closed）。
   - 制約: 本体は状態を持たないため、復元直後で reconcile 未実行の DB は読み出し関数だけでは検出できない。fail closed の責任はホストの起動手順（[sqlite README](../src/infrastructure/sqlite/README.md)）に置く。
4. ジャーナルのファイル操作（tempfile → fsync → rename → dir fsync）はホストの実装。本体は entry の生成・検査・鎖検証（`verifyForgetJournal`）だけを純粋関数で提供する。

受入: capture → forget → 「忘却前に複製した DB ファイル」を復元 → 最新ジャーナルで reconcile → read / list に出ない。reconcile を 2 回実行しても結果同一。ジャーナルの末尾切り詰め・1 entry 改ざん・空ジャーナルで `inconsistent`。

物理消去: 本体は PRAGMA を持たない。論理的な削除（行の値の消去と墓標）を保証し、SQLite の空きページ・WAL・OS のスナップショットからの消去は保証しない。ホストは `PRAGMA secure_delete=ON` と、忘却後の `wal_checkpoint(TRUNCATE)` / VACUUM を実施する。

### 2.6 F02: スコープ限定読み出し

すべての読み出し API は `access: AccessContext` と対象 `scopeKey` を取り、SQL は `(principal, scope_key)` で始まる index を使う。scope を指定しない全件 API を作らない。閉包計算（forget）は書き込み側で、再帰 CTE で起点から辿る（全表をロードしない）。

---

## 3. 契約

型はすべて readonly。入力は own-property だけで読み、検査済みの deep-freeze コピーを返す。上限値は各 family の `LIMITS_*` に置く。

### 3.1 共通

- `SourceKey`（`sourceKey(ref)` の文字列表現）、`EvidenceSpan`（`source` + `quote`。quote は `source.range` の bytes と完全一致）、`HostClock`（安全な整数のミリ秒）、`ScopedRead` / `ScopedWrite`、`MissingStatus`。
- Memory 所有出典の SourceRef: Records は `(namespace "memory", kind "record", id record_id, representation "text")`、revision = `sha256:<hex>`。会話は `("conversation","message",id,"text")`（ホスト所有）。

### 3.2 Records（`./sqlite`）

`captureRecord` は外部取得物を保存する（同一 origin・同一内容は冪等、内容が変われば新 revision、墓標のある record は `blocked: TOMBSTONED`）。`readRecord` は現在または指定 revision の本文を返す。再生成可能な資料は `retainRecord` / `readRetainedRecord` / `useRetainedRecord` / `retainedRecordStats` / `evictRetainedRecords`（retention v1。通常の Records は削除対象に入らない）。範囲の切り出しは純粋関数 `sliceUtf8Range`。

### 3.5 State（純粋型は `.`、永続は `./sqlite`）

規則の正本は `src/domains/state/contracts/index.ts` の JSDoc。要点:
- `assertUserState`（明示操作で登録。同 (subject, kind, semanticKey) の active は 1 件。置き換えは `replaces` の CAS）、`deactivateState` / `reactivateState` / `retractState`、`listState`、`readStateFact`。
- origin は `user_confirmed` / `user_edited` / `agent_inferred`。明示書き込みは根拠の新旧比較を受けず CAS だけで決まる。`agent_inferred` にはユーザー由来の保護がない。同値の明示確認は origin を昇格する（降格はしない）。
- 根拠の quote は state 側に本文を残さない（SourceRef + range だけ）。期限は保存するだけで、評価は `classifyValidity`（時刻はホストが渡す）。
- 遷移の妥当性は純粋な reducer が決める（規則の出典は [rust-core-decision.md](rust-core-decision.md)）。

### 3.9 Lifecycle / Forget

```ts
planForget(db, { contractVersion; access; target: ForgetTarget; clock }): PlanForgetResult   // read のみ
type ForgetTarget =
  | { type: "record"; recordId: string; scopeKey: string }
  | { type: "host_source"; sourceKey: SourceKey; scopeKey: string }   // 会話 message 等、ホストが消す出典
  | { type: "state_item"; itemId: string; scopeKey: string }
  | { type: "scope"; scopeKey: string }                                 // scope 内の本体所有データ全部
applyForget(db, { contractVersion; entry; clock }): ForgetReceipt        // write tx。冪等。enabled に依存しない
reconcileForgetJournal(db, { contractVersion; entries; clock }): { status: "ok"; reapplied; feedResyncRequired? } | { status: "inconsistent"; reasonCode }
recordExternalDeletion(db, { ...; forgetId; providerRef; externalId?; state }) / getForgetReceipt(db, { ...; forgetId })
registerExternalDependents / unregisterExternalDependents                // 外部派生物を閉包に参加させる
```

閉包（`src/domains/lifecycle/service/closure.ts`、純粋）: 起点から `memory_dependency` を dependency → dependent 方向に推移的に辿る。閉包内の各行は value を NULL、status `forgotten`、墓標挿入、変更フィードに `forgotten` を追記する。外部へ送った record の `providerRef` と閉包内の外部派生物は `memory_forget_external` に `pending` で登録し、ホストの確認（`recordExternalDeletion`）で `confirmed` / `unverified` / `failed` になる。`completed` は外部削除が無いか全部 `confirmed` のときだけ。

deactivate と forget の区別: deactivate は本文を残す可逆操作で、墓標・ジャーナルを作らず ForgetReceipt を返さない。API 名・reason・文言で「忘却」「削除」と呼ばない。

---

## 5. Rust `personal-state-core` の扱い

SAAA の Rust 実装は TypeScript で独自に再実装し、取り込まない。規則の出典と判断は [rust-core-decision.md](rust-core-decision.md)、ライセンス表示は `THIRD_PARTY_NOTICES.md`。

---

## 6. 横断方針

### 6.1 忘却の受入

| ID | シナリオ | 期待 |
|---|---|---|
| FG1 | record を forget | read に出ない。本文・全 revision が消える。墓標あり。ForgetReceipt local applied |
| FG2 | host_source を forget（その source を根拠にする state item と外部派生物がある） | 閉包内すべて forgotten、value NULL。無関係な行は不変 |
| FG4 | Memory OFF でも forget | 成功（`enabled` に依存しない） |
| FG5 | 外部プロバイダーに送った record を forget | external `pending`、`completed:false`。全 `confirmed` で true。`unverified` は false のまま |
| FG6 | deactivate | 本文残存、墓標なし、ForgetReceipt なし、reactivate で戻る |
| FG7 | 復元（§2.5） | 古い DB + 最新ジャーナル → 不可視。冪等。ジャーナル破損で inconsistent |
| FG8 | 墓標済み ID の再 capture | trigger で拒否 → `TOMBSTONED` |
| FG10 | 閉包の不変条件（property） | ランダムな依存グラフで、forget 後に「forgotten でない行の依存に forgotten 行がない」 |

### 6.2 deactivate と forget

§3.9 のとおり。fixture・API・reasonCode・文書のどこでも deactivate を「忘却」「削除」と書かない。

### 6.5 検証ラダー

| 段 | 内容 | 実行場所 |
|---|---|---|
| L1 fixture | 言語非依存 JSON、期待値は手書き | `bun test`（verify） |
| L2 property | 生成グラフでの閉包不変条件、reducer の不変条件 | `bun test` |
| L3 SQL 実 DB | `test/support/store.ts` の使い捨てファイル DB（WAL、writer + readonly reader）。readonly 接続への書き込み拒否、transaction 外呼び出し拒否、migration 全適用、hash 照合 | `bun test` |
| L4 復元 / 忘却シナリオ | FG1–FG10、DB ファイルの複製と復元、ジャーナル破損 | `bun test`（`test/scenario/`） |
| L5 ホスト結合 | Eumenes の Writer / queue / 採用 transaction での結合試験 | Eumenes 側 |

各機能の到達段を [verification-status.md](verification-status.md) の表に「機能 × I/F/S/H」で記録する。

---

## 9. リスクと未決事項

- **R-A**: 物理消去（空き領域、WAL、OS のスナップショット、Time Machine）は保証しない。
- **R-B**: 復元直後の DB を本体だけでは検出できない（§2.5-3）。ホストの起動手順が必須。
- **R-C**: `store.write` の共有キュー。閉包の大きい forget は 1 transaction が長くなる。
- **R-D**: SAAA の規則を TS で再実装する際の意味の取り違え。fixture に出典を付け、差分は設計判断として記録する。

## 10. 確認済みの判断（ユーザー回答）

- 墓標ジャーナルは必須で、所有はホスト（Eumenes）。
- 本体の DB はテストごとに初期化する使い捨てで、永続データの保守は Eumenes 側が行う（[persistence-design.md](persistence-design.md) §2.1）。
- 正本は常に原文（テキスト）と出典参照。
- Procedure（Rule / Skill に相当する手順）は本体の対象外。指示の権限を持つのでホストが扱う。
