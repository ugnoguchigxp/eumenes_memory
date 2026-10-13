# 永続化設計: Eumenes の SQLite 単一 Writer を共有する

本体の永続層がホストの接続・Writer・migration とどう接するかの設計。実装後の仕様は [全体設計](full-system-design.md) §2 と `src/infrastructure/sqlite/README.md`。

## 1. 前提（`../eumenes/api/infrastructure/sqlite/index.ts` の実態）

- `openStore(filename, migrations: readonly string[])` が唯一の入口。プロセスは `flock` で DB ファイルの所有権を取り、書き込み接続 1 本と読み取り専用接続 1 本（WAL）を持つ。
- `store.write(op)` は直列化された非同期キューで、`w.transaction(() => op(w))()` として **同期関数 `op` を 1 つの transaction 内で実行**する。`op` が Promise を返しても待たれない。キュー上限 64。
- `store.read(op)` は別の読み取り専用接続で同期実行する。複数文をまたぐ一貫性は呼び出し側が transaction で囲まない限り保証されない。
- migration は SQL 文字列の配列で、**添字 +1 が id**。`schema_migrations` は全 domain で 1 つ。適用順は配列順で固定。

## 2. 方針

**同じ DB ファイル・同じ Writer を共有する。** 別ファイルにすると「State の書き込みと、ホストの回答保存・利用記録を同一 transaction で確定する」保証を失うため採らない。本体は DB 接続・transaction・flock・PRAGMA を所有せず、ホストから渡された `db` に対する**同期関数とスキーマ定義だけ**を提供する。

| 本体が持つ | ホストが持つ |
|---|---|
| テーブル定義（SQL）とその論理的な意味 | 接続の open/close、flock、WAL、busy_timeout |
| `db` を受け取る同期の読み書き関数 | `store.write` / `store.read` での呼び出しと transaction 境界 |
| スキーマ版の検査 | migration の実行と配列への配置 |
| 契約・fixture・互換性テスト | 非同期処理（モデル呼び出し等）。transaction 内で待たない |

### 2.1 このリポジトリ自身の DB はテスト専用

本体のリポジトリで作る DB（インメモリまたは一時ファイル）は**単体・契約テストのためだけに使い捨てる**。データの引き継ぎ、旧版からの migration 互換、バックアップ・復元、本番運用は考えない。永続データの正本は常に Eumenes 側の DB で、本体はその上で動く。したがって:

- テストは毎回、本体の `migrations` を空の DB へ全適用して始める。テスト用 DB の旧版との互換性テストは書かない。Eumenes の実 DB に適用済みの版から新しい migration を当てる試験（例: 版 7 の DB への 0008）は書く。
- migration の前方互換・版巻き戻しの検査（§4-4）や復元と墓標の問題（§8-1）が問題になるのは、Eumenes 側の DB に適用した後だけ。
- テスト用の `openStore` 相当のヘルパーは本体の公開 API に含めず、`test/` 配下に置く。テスト用の最小 Writer は、ホストと同じく「同期 op を 1 transaction で実行する」形に揃え、挙動の違いで偽の安全を作らない。

## 3. 本体の永続化 API の形

```ts
// subpath export: "eumenes-memory/sqlite"（純粋 API とは別 entry）
export interface MemoryDb {            // bun:sqlite の Database と構造的に互換な最小面
  exec(sql: string): void;
  query(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown };
}
export const migrations: readonly string[];        // 本体の migration（追記専用）
export function assertMemorySchema(db: MemoryDb): void;   // 版が合わなければ例外
export function createRecordsStore(): RecordsStore;       // 各操作が (db, args) を取る同期関数
```

- `bun:sqlite` を import しない。`MemoryDb` は構造的型付けで満たす（Bun 以外への差し替えと、テストでのインメモリ DB 利用のため）。
- 本体は `BEGIN` / `COMMIT` / `db.transaction()` を呼ばない。呼び出しは常にホストの transaction 内（write）または読み取り専用接続（read）で行われる前提。`async` 関数を公開しない。
- 接続を開かない・保持しない・グローバル状態を持たない。前回の呼び出し状態を保持しない。
- `AccessContext` など純粋 API の契約型をそのまま使い、永続化層が別の型体系を作らない。

## 4. スキーマとマイグレーション

1. **名前空間:** 本体のテーブル・index・trigger はすべて `memory_` 接頭辞。ホストのテーブルを参照しない。**ホストのテーブルへの外部キーを張らない**（`foreign_keys=ON` のため）。他 domain の実体は不透明な ID 文字列で参照し、整合はホストの公開操作と再検証で担保する。
2. **配置:** 本体は `migrations` 配列を提供し、ホストが自分の配列へ**追記して**渡す（例: `[...host, ...memoryMigrations]`）。ホストの配列は追記専用で、一度適用された位置は動かさない。後で本体が migration を足したら、ホストはその時点の末尾に追記する。
3. **各 migration の制約:** 1 本の `exec` で完結する SQL。`BEGIN/COMMIT`、transaction 内で失敗する PRAGMA（`journal_mode` 等）、ホストのテーブルへの DDL を含めない。各 migration は既に適用された版を変更しない（新しい migration で変える）。
4. **版検査:** 本体は `memory_schema_info`（スキーマ版・本体 package version）を持ち、`assertMemorySchema` が起動時と各公開操作の入口で「DB の版 ≤ 本体の既知の版」を検査する。新しい DB に古い本体が接続したら読み書きを拒否する。巻き戻しは配布物の巻き戻しだけでは安全でない。
5. **移行の所有者:** SQL 定義は本体、実行はホスト。ホスト側に「本体の migrations が自配列の部分列として正しく並んでいる」ことを確認するテストを置く。

## 5. 書き込み・読み取りの規則

- **書き込み transaction:** ホストが `store.write(db => { 状態の読み直し → queue の attempt/lease 検査 → 本体の書き込み → 回答保存 })` を 1 回で行う。本体の関数はこの中で呼べる同期関数にする。
- **読み取り:** 複数文の読み出しは、読み取り専用接続でも一貫した版を得るため、ホストが読み取り transaction で囲む。本体は「どの接続で呼ぶか」を仮定せず、**書き込み系の関数に `readonly` 接続を渡すと明示エラー**になるようにする。
- **キュー圧:** `write` は全 domain で共有する直列キュー（上限 64）。本体の書き込みを大きな 1 transaction にしない。大量の再索引・派生情報の再構築は小さい単位に分割し、進捗はホスト queue の job として回す（Memory に二つ目の queue を作らない）。
- **忘却:** Memory 利用が OFF でも `forget` は呼べる。同一 transaction で本文・派生情報・墓標を更新し、WAL checkpoint 後も復元で戻らない設計にする（F03 の受入）。

## 6. 本体が持ってよいデータ・持ってはいけないデータ

- Records、State 台帳、依存辺、墓標、変更フィード、`memory_schema_info` は本体の所有。
- Continuity（goal / decision / open_question）と会話原文は**当面ホストが正本**。本体の表へコピーして第二の台帳にしない。必要なのは snapshot と参照（SourceRef）だけ。
- UsageReceipt はホスト側（Eumenes）の表。本体の型を含めてよいが、原文本文を重複保存しない。

## 7. Rust コア・別プロセスの扱い

SQLite の書き込みは常にホストの Writer 経由。Rust の `personal-state-core` を将来使う場合も、**IO を持たない計算部品**として呼び、DB には触れさせない（SAAA コアの性質を維持）。別プロセスから同じ DB ファイルを開く構成は単一 Writer の保証を壊すため採らない。

## 8. 決定済み・残る制約

1. **復元と墓標:** DB ファイル単位のバックアップを古い版へ戻すと墓標も戻る。墓標をホスト管理の別媒体（ジャーナル）にも書き、起動時に照合して再適用する（[全体設計](full-system-design.md) §2.5）。ジャーナルが欠けた古い DB の復元は本体だけでは検出できず、ホストの起動手順の責任。
2. **migration の添字制:** `memory_schema_info` に各 migration の hash を記録し、`assertMemorySchema` と `checkHostMigrations` で本体の migration の欠落・順序違い・改変を検出する。
3. **規模:** スコープ限定読み出しは `(principal, scope_key)` で始まる index を使う。
4. **`MemoryDb` の面:** `query().all/get/run` で足りている。
