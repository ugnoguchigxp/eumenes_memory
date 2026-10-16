# Eumenes Memory

Eumenes の記憶（State 台帳、再生成可能な資料 Records、忘却）を Eumenes と独立して開発するライブラリ。永続は `eumenes-memory/sqlite` の同期関数で、接続・transaction・キャッシュ容量・checkpoint はホストが所有する。World / Consolidation は別ドメイン・別リポジトリで作るため本体では実装せず、接続部（`ExternalDependent` と変更フィード `listMemoryChanges`）だけを提供する。Procedure（Rule / Skill）は指示の権限を持つため本体の対象外（Eumenes が扱う）。

各機能が到達した検証段階（実装 / fixture / 実 SQL / ホスト結合 / 実モデル評価）は [検証状況](spec/verification-status.md) が正本。設計の記録は [全体設計](spec/full-system-design.md)。

## 開発コマンド

```sh
bun install          # 依存取得（bun.lock を使用。実行時依存はゼロ）
bun run verify       # 全体検証（format / lint / 境界 / 型 / test / 公開面）
bun run verify:all   # 明示的な全体検証
bun run verify -- --domain state  # Stateと依存先・共有基盤の検証
bun run test:domain -- state      # Stateが所有するテスト
bun run lint:fix     # 自動修正（verifyではソースを変更しない）
```

内部は Records / State / Lifecycle / Temporal のドメイン構造。所有範囲と依存規則は [ドメイン構造](src/domains/README.md)。oxfmt / oxlintの版と共通設定は隣接Eumenesに合わせ、React向けの設定はこのライブラリに持ち込まない。検証記録は `verification-reports/` に保存する。Eumenes を模したホスト（会話 message、書き込みキュー、ジャーナル、再起動・DB 復元）は `test/runners/fake-eumenes-host.ts` にあり、実 Eumenes なしで結合の想定を試せる（実 Eumenes との結合の証明ではない）。

## 単体での動作チェック

Eumenes を起動せずに試す場合は、[独立ホストの実行例](examples/standalone/README.md) を使う。

```sh
bun run check:memory       # 認証なし。実 SQLite で保存・訂正・忘却・復元など17項目を検査
bun run check:memory:live  # Codex SDK + gpt-6-luna で日本語の判断と意味評価も実行
bun run check:memory:conversations:live # 人物・話題混在、曖昧な訂正、部分忘却など13種類の実験
```

工程別の結果、モデルの出力・使用量、DB と忘却ジャーナルを `verification-reports/memory-check/` に保存する。offline は固定判断の再生、live は実モデルによる判断であり、モデル未使用の結果を意味精度の証拠にはしない。examples の型検査と外部呼び出しなしの回帰試験は通常の `verify` に含まれる。

## 公開面

| import | 内容 |
|---|---|
| `eumenes-memory` | 純粋 API と、各 family の型・定数・reasonCode・上限。`MemoryContractError` / `isMemoryContractError`、`CONTRACT_VERSIONS`（records / state / lifecycle / external）、`LIMITS*`、`sliceUtf8Range`（UTF-8 byte 範囲の切り出し）、`verifyForgetJournal`（ジャーナルの鎖の検証）、`classifyValidity` / `periodFromStateMs`（成立期間の判定。時刻はホストが渡す） |
| `eumenes-memory/sqlite` | 永続 API。ホストが渡す `MemoryDb`（bun:sqlite の `Database` が構造的に満たす）に対する同期関数と `migrations`。`bun:sqlite` は import しない。State（`assertUserState` / `deactivateState` / `reactivateState` / `retractState` / `listState` / `readStateFact`）、Records（`captureRecord` / `readRecord` と、再生成可能な資料の `retainRecord` / `readRetainedRecord` / `useRetainedRecord` / `retainedRecordStats` / `evictRetainedRecords`）、Lifecycle（`planForget` / `applyForget` / `reconcileForgetJournal` / `getForgetReceipt` / `recordExternalDeletion` / `registerExternalDependents` / `unregisterExternalDependents`）、`assertMemorySchema` / `checkHostMigrations` / `migrations` / `MEMORY_DB_SCHEMA_VERSION`、`listMemoryChanges` / `latestMemoryChangeSeq`（scope で可視な変更の最大 seq。ホストが内部の表を読まずに世代を見る）、`MemoryStoreError`。State の `assertUserState` の origin は `user_confirmed` / `user_edited` / `agent_inferred`（ホストのエージェントが依頼なしに推定した内容。ユーザー由来の保護は受けない。意味は [State 契約](src/domains/state/contracts/index.ts)）。起動手順と規則は [src/infrastructure/sqlite/README.md](src/infrastructure/sqlite/README.md) |

## Eumenes からの利用

Eumenes はビルド済みの配布物（`artifacts/eumenes-memory-<version>.tgz`）を `vendor/eumenes-memory/` に置いて取り込む。配布物の中身は TS ソース（`exports["."] = "./src/index.ts"`、ビルド不要）で、`package.json` の `files` に含まれるものだけが入る。

```json
{ "dependencies": { "eumenes-memory": "file:vendor/eumenes-memory/eumenes-memory-0.0.1.tgz" } }
```

```ts
import { assertUserState, listState, migrations } from "eumenes-memory/sqlite";
import { CONTRACT_VERSIONS } from "eumenes-memory";

// ホストの migration の後ろに本体の migrations を 1 要素ずつ追記して適用し、
// 書き込みは同期 op を 1 transaction 内で呼ぶ（起動手順は src/infrastructure/sqlite/README.md）。
const written = store.write((db) =>
	assertUserState(db, {
		contractVersion: CONTRACT_VERSIONS.state,
		access, // { principal, scopeKeys, purpose, policyRevision }
		scopeKey: "conversation:c1",
		clock: { atMs: now },
		kind: "preference",
		subject: "self",
		semanticKey: "drink",
		value: { text: "コーヒー", polarity: "affirmed" },
		evidence, // quote つきの根拠（range の bytes と quote が一致すること）
		sources, // evidence の出典の本文つき状態
		origin: "user_confirmed",
	}),
);
```

## 既知の制限（抜粋）

- Proxy は検査対象外。JSON 由来またはアダプターが生成した plain なデータを渡すこと。
- 古い DB を復元した場合の安全性（忘却の再適用）はホストの起動手順（`reconcileForgetJournal`）に依存する。
- 物理消去（SQLite の空き領域、WAL、OS のスナップショット）は保証しない。

### 再生成可能な資料の保持（retention v1）

`eumenes-memory/sqlite` の `retainRecord` で明示したRecordsだけに鮮度期限と未使用期限を適用する。`readRetainedRecord` は読取専用で期限を動かさず、ホストの確定後に `useRetainedRecord` へ採用revisionを渡すと未使用期限だけ延長する。`retainedRecordStats` と `evictRetainedRecords` は許可されたprincipal/scope内だけを対象とし、evictの `recordId` で1資料の失効もできる。evictはforgetの墓標を消さない。通常のRecords（`captureRecord`）はこの削除対象に入らない。

書込はホストが提供するtransaction内で行う。再生成可能な資料の更新は古い本文revisionを剪定するため、永続Stateや外部派生物が参照する資料、および外部送付記録を持つ資料の更新・削除は拒否する。先に所有者側の公開操作で依存を解決する。forgetは本文とretention metadataを除去し、再captureを墓標で拒否する。接続・SQL transaction・キャッシュの容量方針・checkpoint/vacuumはホストが所有する。

## DB スキーマ（版 8）

`MEMORY_DB_SCHEMA_VERSION` は 8 で、パッケージの版とは独立（migration の本数と一致する）。登録済みの migration の本文と順序は変えず、変更は追記する。

- migration 0008 は、現在の機能が使わない永続物を削除する: 抽出の表（`memory_extraction_run` / `_input` / `_shown`、`memory_candidate` / `_evidence`、`memory_source_progress`）、全文索引 `memory_record_fts`、`memory_scope_state`、旧 node 種別（`candidate` / `extraction_run`）の依存辺と墓標。過去の忘却の記録（`memory_forget` / `memory_forget_external`）、State の item、Records は不変。
- 既存の行が持ちうる語彙（`disputed` / `invalidated` の status、`admitted_extraction` の origin など）は読み取りのために残る。現在の API はこれらを書かない。そうした State の item はそのまま読めて、忘却の対象にもなる。
- 旧い DB の閉包は狭くなる: 抽出の run が読んだだけで item が引用していない出典を忘れても、その run 経由で抽出由来の item には届かない。item が根拠として引用する出典は従来どおり届く。Eumenes は抽出を実行したことがなく、実データは無い。
- 版 7 の DB（抽出の行、候補由来の State、過去の忘却の記録を含む）への適用と、その後の読み取り・忘却・ジャーナルの照合・ExternalDependent の登録は `src/infrastructure/sqlite/test/remove-extraction-migration.test.ts` で試験している。
- 削除は論理的な削除。SQLite の空きページ・WAL・バックアップからの消去は保証しない。物理消去はホストの責任（`PRAGMA secure_delete=ON`、忘却後の checkpoint / VACUUM）。
