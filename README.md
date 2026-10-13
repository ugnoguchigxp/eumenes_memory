# Eumenes Memory

MemorySystem を Eumenes と独立して開発するためのライブラリ。純粋な view 構成・再検証（M0）、永続層、Records / Recall、State 台帳、View v2、Extraction、Selection、時間判定、Lifecycle・忘却、評価基盤 `eval/` を実装済み（2026-10-09 時点で 1563 テスト、fixture 543 件）。M0 の実装結果は [M0 検証記録](spec/m0-validation.md)。リモートへの公開、tarball 配布、Eumenes への本接続（M1）は未実施。改善の計画は [改善計画書](spec/improvement-plan.md)。

M0 に続く全体（永続層、Records / Recall、State 台帳、View v2、Extraction、Lifecycle・忘却、評価基盤 `eval/`）は [全体設計](spec/full-system-design.md) に従い実装済み。各機能が到達した検証段階（実装 / fixture / 実 SQL / ホスト結合 / 実モデル評価）は [検証状況](spec/verification-status.md) が正本で、**ホスト結合（H）と実モデル評価（E）は未到達**。World / Consolidation は別ドメイン・別リポジトリで作るため本体では実装せず、接続部（`ExternalDependent` と変更フィード `listMemoryChanges`）だけを提供する。Procedure（Rule / Skill）は指示の権限を持つため本体の対象外（Eumenes が扱う）。

## 実装の入口

1. [実装計画本体](spec/implementation-plan.md) — 開発範囲、段階、受入条件、Claude Code への作業指示。
2. [初期契約](spec/contracts-v0.md) — 最初のライブラリが扱う入出力と検証規則。
3. [Eumenes 側の接続計画](../eumenes/spec/memory-system-incremental-adoption-concept.md) — 利用側で必要な最小変更。
4. [SAAA MemorySystem 評価](spec/saaa-memory-system-review.md) — 設計の根拠と移植時の注意点。

本体の正本はこのディレクトリに置く。Eumenes は本体の公開パッケージを使い、出典・状態の取得と実行結果の採用を担当する。最初から別サービスや別 DB にすることは前提としない。

他ディレクトリへのリンクは隣接 checkout を前提とする参考資料。本体の初期実装は、このディレクトリの `spec` だけで範囲と受入条件が分かるように記載している。

## 開発コマンド

```sh
bun install          # 依存取得（bun.lock を使用。実行時依存はゼロ）
bun run verify       # 全体検証（format / lint / 境界 / 型 / test / 公開面）
bun run verify:all   # 明示的な全体検証
bun run verify -- --domain state  # Stateと依存先・共有基盤の検証
bun run test:domain -- state      # Stateが所有するテスト
bun run lint:fix     # 自動修正（verifyではソースを変更しない）
```

内部はRecords / Recall / State / Extraction / Projection / Lifecycleのドメイン構造。所有範囲と依存規則は [ドメイン構造](src/domains/README.md)、改善の次段階は [発展案](spec/eumenes-memory-evolution-proposal.md)。oxfmt / oxlintの版と共通設定は隣接Eumenesに合わせ、React向けの設定はこのライブラリに持ち込まない。検証記録は `verification-reports/` に保存する。 Eumenes を模したホスト（会話 message、書き込みキュー、ジャーナル、再起動・DB 復元）は `test/runners/fake-eumenes-host.ts` にあり、実 Eumenes なしで結合の想定を試せる（H 段階の証明ではない）。

## 公開面

| import | 内容 |
|---|---|
| `eumenes-memory` | 純粋 API（M0 の view 構成・再検証）と、全 family の型・定数・reasonCode・上限（`CONTRACT_VERSIONS`、`LIMITS_*` など） |
| `eumenes-memory/sqlite` | 永続 API。ホストが渡す `MemoryDb`（bun:sqlite の `Database` が構造的に満たす）に対する同期関数と `migrations`。`bun:sqlite` は import しない。records / recall / state / extraction / lifecycle（忘却・ジャーナル・外部派生物の登録）の同期関数と `assertMemorySchema` / `migrations` / `listMemoryChanges` / `latestMemoryChangeSeq`（scope で可視な変更の最大 seq。ホストが内部の表を読まずに世代を見る）/ `readStateFact`（item と同じ事実の全版の ID。忘却の対象決めに使う）/ `MemoryStoreError`。State の `assertUserState` / `editState` の origin は `user_confirmed` / `user_edited` に加えて `agent_inferred`（ホストのエージェントが依頼なしに推定した内容。ユーザー由来の保護は受けない。意味は [State 契約](src/domains/state/contracts/index.ts)）。起動手順と規則は [src/infrastructure/sqlite/README.md](src/infrastructure/sqlite/README.md) |

## Eumenes からの利用例

M0 は TS ソースを直接 export する（`exports["."] = "./src/index.ts"`、ビルド不要）。隣接 checkout の Eumenes は次の依存で取り込む。

```json
{ "dependencies": { "eumenes-memory": "file:../eumenes_memory" } }
```

本パッケージに新しいファイルが追加されたら、Eumenes 側で `bun install` を再実行する（`file:` 依存は `node_modules` 内にファイル単位で配置されるため）。

```ts
import { buildMemoryView, validateMemoryView } from "eumenes-memory";
import type { BuildMemoryViewInput, ValidationCurrent } from "eumenes-memory";

// 1. ホストが同一 read transaction から snapshot を構成する
const input: BuildMemoryViewInput = {
	schemaVersion: 1,
	access: { principal, scopeKeys: [`conversation:${conversationId}`], purpose: "dialogue.generate", policyRevision: "1" },
	snapshot, // principal / scopeKey / stateRevision / policyRevision / complete / sources / items
	maxBytes: 16_384,
	enabled: true,
};
const view = buildMemoryView(input);
if (view.status !== "ready") {
	// disabled / blocked / overflow: reasonCode だけを持ち、本文は含まない
}

// 2. 回答の採用トランザクション内で、読み直した最新状態を渡して再検証する
const current: ValidationCurrent = { schemaVersion: 1, access, snapshot: reread };
const result = validateMemoryView(view, current);
if (result.status !== "valid") {
	// result.reasonCode で失効理由を判別。回答は確定させない
}
```

Eumenes の Continuity / conversation との対応（M1 のアダプター想定。M0 では実装しない）:

| 本契約 | Eumenes の値（仮案） |
|---|---|
| principal | ローカル単一ユーザーの固定値（例 `"local:owner"`） |
| scopeKey / scopeKeys | `"conversation:" + conversationId` |
| purpose | `"dialogue.generate"` |
| policyRevision | 設定版（未存在なら固定 `"1"`） |
| stateRevision | `String(ContinuitySnapshot.stateRevision)` |
| item.id / revision | `"continuity:" + bookmark.id` / `String(bookmark.revision)` |
| kind / status / origin / text | bookmark の同名フィールド |
| SourceRef / SourceState | `("conversation", "message", sourceMessageId, "text")` |
| source revision / digest | `"sha256:" + sha256(message.text)` / `bookmark.sourceDigest` |
| source status | `ok → available`、`missing → missing`、`changed → changed` |
| source content | `message.text`（range は M1 では付けない） |
| item.dependencies | `[primarySource]` |

## 既知の制限（抜粋）

- Proxy は検査対象外。JSON 由来またはアダプターが生成した plain なデータを渡すこと。
- reasonCode は 1 つだけで、どの item / source が失効したかは返さない。
- `valid` は「渡された最新状態との一致」を意味する。古い snapshot を再提示された場合の安全性はホストの責任。
- 詳細は [spec/m0-validation.md](spec/m0-validation.md)。


### 再生成可能な資料の保持（retention v1）

`eumenes-memory/sqlite` の `retainRecord` で明示したRecordsだけに鮮度期限と未使用期限を適用する。`readRetainedRecord` は読取専用で期限を動かさず、ホストの確定後に `useRetainedRecord` へ採用revisionを渡すと未使用期限だけ延長する。`retainedRecordStats` と `evictRetainedRecords` は許可されたprincipal/scope内だけを対象とし、evictの `recordId` で1資料の失効もできる。evictはforgetの墓標を消さない。通常のRecordsはこの削除対象に入らない。

書込はホストが提供するtransaction内で行う。再生成可能な資料の更新は古い本文revisionを剪定するため、永続Stateや外部派生物が参照する資料、および外部送付記録を持つ資料の更新・削除は拒否する。先に所有者側の公開操作で依存を解決する。forgetは本文と索引に加えてretention metadataも除去し、再captureを墓標で拒否する。接続・SQL transaction・キャッシュの容量方針・checkpoint/vacuumはホストが所有する。

## 0.3.7 の変更

公開面の変更を含む。0.3.6 から取り込むホストは次を確認する。

- State の新しい origin `agent_inferred`（ホストのエージェントが依頼なしに推定した内容）。`assertUserState` / `editState` が受理する。ユーザー由来の保護は受けない（意味は [State 契約](src/domains/state/contracts/index.ts)）。`HOST_STATE_ORIGINS`（`user_confirmed` / `user_edited` / `agent_inferred`）を追加し、`STATE_ORIGINS` の末尾にも加えた。
- 型 `UserStateOrigin` を削除した（`AssertUserStateInput` / `EditStateInput` の `origin` は `HostStateOrigin`）。利用側が参照していれば `HostStateOrigin` か `(typeof USER_STATE_ORIGINS)[number]` に置き換える。
- view v2 の item origin（`ITEM_ORIGINS_V2`）の末尾に `agent_inferred` を加えた。v2 の origin を網羅的に分岐するホストは扱いを足す。契約版（`CONTRACT_VERSIONS`）は変えていない。
- 新しい読み取り関数 `latestMemoryChangeSeq`（scope で可視な変更の最大 seq）と `readStateFact`（item と同じ事実の全版の ID）。ホストが内部の表を直接読む代わりに使う。
- DB スキーマ版は 7。migration 0007 が State の 4 表を作り直す（行は不変。`foreign_keys=ON` の transaction 内で適用できる）。適用済みの DB は版 6 から 7 へ上がる。
