# MemorySystem 独立開発・実装計画

2026-10-07 / 実装前。開発先: `/Users/y.noguchi/Code/eumenes_memory`。

この文書を MemorySystem 本体の実装計画の正本とする。「Eumenes 内で M0 を実装してから別リポジトリへ移す」という旧案を置き換える。**本体は最初からここで開発し、Eumenes には利用アダプターと採用時の検証だけを追加する。**

## 1. システムの目的

MemorySystem は、出典を持つ記憶を管理し、現在の実行で使える情報を組み立てる。検索だけでなく、状態の訂正、適用範囲、忘却、利用中の情報の失効を扱う。

最初は「会話で確定した目的・決定・未解決事項を、原文参照付きで次の実行へ渡す」経路を作る。保存された決定が生成中に変更された場合は、古い決定を前提とする回答を確定させない。

初期の提供形態は、同一プロセスから利用する小さな TypeScript ライブラリ。Eumenes の Bun 環境を最初の利用先とするが、共通処理に `bun:sqlite`、Eumenes の domain、Tauri、LARM を import しない。独立リポジトリ化とサービス化・別 DB 化を分けて判断する。

## 2. 所有する責任

| 本体: eumenes_memory | 利用側: Eumenes |
|---|---|
| 契約の正本、スキーマの版、互換性テスト | 認証済み principal、許可スコープ、用途の決定 |
| 出典・項目・依存関係の表現 | 会話原文と既存 Continuity 状態の取得・変更・削除 |
| 決定的な view 構成と予算判定 | 元データの snapshot を整合した状態で読む |
| 渡された最新状態に対する有効性判定 | 検査に必要な最新状態の取得、検査と回答保存の原子性 |
| 将来の Records、状態台帳、検索、抽出、World | queue、scheduler、attempt、lease、再試行、モデル資格情報 |
| 本体が所有するデータの schema と migration の定義 | SQLite 接続・writer・トランザクションの所有と migration の実行 |
| 独立 fixture と契約テスト | UI/TTS への公開時点、アプリの起動終了、結合テスト |

本体は Eumenes のテーブルを直接参照しない。初期版は DB 自体を持たず、取得済み snapshot を入力として処理する。後続の永続化では、論理的な記憶ストアの責任を本体に置き、接続・トランザクションをホストから提供できる構造にする。

Continuity の goal / decision / open_question は当面 Eumenes 側が正本。本体に同じ項目を別台帳として書き込まない。Records を追加しても、会話原文を所有者不明のコピーへ置き換えない。

## 3. 初回実装: M0

**Claude Code に最初に依頼する範囲は、この M0 だけ。** 後続段階はロードマップであり、一括実装の指示ではない。

成果物は、一つの TypeScript パッケージ、[contracts-v0.md](contracts-v0.md) の契約、純粋な view 構成・再検証、JSON fixture、パッケージ利用例。fixture には実ユーザーの会話を使わない。

実装時に作る構成:

```text
src/
  index.ts
  contracts/         入出力と実行時検証
  view/              構成・順序・予算・digest
  validation/        版・出典・権限状態の再検証
fixtures/            言語に依存しない入力と期待結果
test/consumer/       公開 exports だけを使う利用テスト
spec/                計画・契約・検証結果
```

各部の試験は対象コードの近くに置く。最初から monorepo、複数パッケージ、plugin registry、空の将来機能ディレクトリは作らない。名前や export の具体形は契約を満たす小さな設計に留める。

M0 で用意する操作:

- `buildMemoryView(input)` — 信頼されたホストの snapshot から、出典付きの構造化 view または利用不可の理由を返す。
- `validateMemoryView(view, current)` — ホストが読み直した最新状態と比較し、利用可能か失効理由を返す。自分では DB やネットワークを読まない。
- 入出力の検証と公開 exports — 型の一致だけでなく、JSON として渡された不正な値を拒否する。

M0 の完了条件:

| 検証 | 期待結果 |
|---|---|
| 同じ snapshot・権限・予算 | 同じ選択・順序・view digest。時計や乱数に依存しない |
| goal / decision / open_question | ユーザー確定・編集の由来と原文参照を保持する |
| 原文欠落・変更・忘却、項目の revision 変更 | 古い view を利用不可とする |
| principal / scope / policy の不一致 | 内容を含む成功結果を返さず、採用不可とする |
| 必須項目が予算超過 | 切り捨てず `overflow` |
| 日本語・絵文字、UTF-8 の不正な範囲 | サイズを byte で判定し、不正な引用範囲を拒否する |
| Memory OFF / 空の正常 snapshot | それぞれ `disabled` / 空の `ready` として区別する |
| ホストの snapshot が不完全 | 空の成功にせず `blocked` |
| 入力変更・再実行 | 入力オブジェクトを変更しない。前回の呼び出し状態を保持しない |
| 公開パッケージの利用 | source 内部への相対 import なしで型・実行テストが通る |

型検査、テスト、配布物のビルド、配布物を使う consumer テストを一つの `verify` コマンドから実行できるようにする。開発用 runner は Bun、lockfile を保存する。実行時依存は必要性を説明できるものに限定する。

M0 の成果は「Memory の純粋処理が利用できるライブラリ」。実際の会話に注入したこと、実モデルの意味精度、永続的な忘却、音声受入の完了を宣言しない。

## 4. Eumenes への最初の接続: M1

本体の M0 が通った後、Eumenes 側で別作業として接続する。詳細は [接続計画](../../eumenes/spec/memory-system-incremental-adoption-concept.md)。

Eumenes は conversation / continuity の公開操作から snapshot を作り、パッケージを呼ぶ。生成後、同一 writer の採用トランザクション内で原文・項目・権限を読み直し、同期の `validateMemoryView` と queue の attempt / lease 検査を行い、回答と利用記録を確定する。

ライブラリが `valid` を返すことは、渡された最新状態との一致を意味する。ホストが古い snapshot を再提示した場合の安全性まで保証しない。この責任を契約に明記し、結合テストで検証する。

初期接続では検証済み回答だけを公開する。逐次公開・TTS を先行させるなら、公開前検査と無効化時の停止を別途実装してから有効化する。モデル呼び出しや非同期 I/O を writer の transaction 内で待たない。

本体の不足を Eumenes 内の別 view 実装で補わない。必要な変更は本体の契約・fixture・版として更新する。接続中も既存 Continuity の書き込み正本を維持する。

## 5. 後続機能の導入順

| 段階 | 本体の開発物 | 着手・受入条件 |
|---|---|---|
| M2: Records | 外部取得物、本文表現、認可付き検索、範囲読み出し、依存・忘却 | M1 の実行中失効が成立。永続化ポートと migration の所有を確定。古い DB 復元でも忘却済み情報が read/search/view に戻らない |
| M3: State / Extraction | 型付き状態、候補生成、Admission、訂正、処理進捗 | 日本語の否定・仮定・引用・嗜好変更・別人情報を評価。初期は候補生成のみ。採用基準を項目種別ごとに定める |
| M4: World / Consolidation | エンティティ・関係・条件・予測・観測、再評価 | グラフは同じ台帳から派生。入力 manifest と進捗を固定し、同じ根拠の循環で確信を増やさない |

検索は明示参照・スコープ限定から始め、全文検索を追加する。埋め込みは検索評価で必要性を確認してから導入する。検索ヒットを自動的に確定事実へ昇格させない。

自動抽出では、本体が source revision・処理段階・候補・採否を持ち、Eumenes の queue が job status・attempt・lease・再試行を持つ。Memory 内に二つ目の queue を実装しない。外部への必要な保存が未確認のまま job を完了扱いしない。

忘却は本文・索引・派生情報・利用中 view・復元を含む。メモリー利用や抽出が OFF でも忘却処理は可能にする。外部プロバイダーでの削除未確認は `pending` / `unverified` として記録し、完了と言わない。

## 6. SAAA から継承するもの

SAAA は参照専用。実コードを取り込む段階では対象 snapshot・ライセンス・対象ファイル・改変を記録し、既存のライセンス表示を保持する。製品 DB、資格情報、設定、実会話データは取り込まない。

- 継承する設計: 原文版と引用範囲、候補と採用済み状態の区別、依存閉包による失効、原子的な変更、回答採用前の再検証。
- 残す資産: IO を持たない Rust の `personal-state-core`。M0 の TypeScript view を理由に、状態遷移コア全体を TypeScript へ書き直さない。
- M3 の前に判断する事項: Rust コアの binding / Wasm / 別プロセス利用。配布、変換、同期性、キャンセル、回復を小さな検証で比較し、採用方式を設計記録に残す。

SAAA 全体評価で確認した移植上の注意点:

| 項目 | 本計画への反映 |
|---|---|
| F01: worker / provider / runtime のホスト依存 | 本体は汎用データを受け取る。実行・資格情報はホストの責任 |
| F02: Personal State の view が全履歴をロード | 対象スコープと必要な依存に限定。規模を増やした行数・メモリー・時間を M2 以降に測定 |
| F03: records の復元 journal と読み出しの失効が不一致 | record tombstone の永続化、復元時の完全な再適用、墓標による読み出し除外を設計。通常忘却だけのテストで完了しない |

F03 は実 SQL の分離検証で再現した復元条件の問題であり、本番での露出を実証したものではない。SAAA の修正を待つことと、本体へ不完全な処理をコピーしないことは別。独立実装でも同じ復元受入を必須とする。

根拠の詳細: [SAAA 評価](saaa-memory-system-review.md)、[証拠台帳](reviews/saaa-memory-2026-10-07/review.json)。SAAA のコアテスト成功は独立ライブラリの完成証明として流用しない。

## 7. パッケージ境界と互換性

共通契約・JSON fixture・互換性テストの正本は本リポジトリに置く。Eumenes に同じ型定義を手書きで複製しない。初期開発の隣接パッケージ参照はよいが、両 checkout の HEAD に暗黙依存する恒久運用にしない。

M1 の正式な取り込みは、以下の `.tgz` 配布方式に固定する。package version、schemaVersion、source revision を記録する。consumer テストは source の直 import ではなく配布物を使う。未知の schemaVersion は明示エラーとする。

### 配布物の配置と取り込み

パッケージ名は `eumenes-memory`。npm 互換の package tarball（gzip 圧縮の `.tgz`）として配布する。ソースフォルダー全体を単に圧縮した `.gz` は使わない。初期接続で公開 registry は必要ない。

| 場所 | パス（リポジトリのルート基準） | 管理 |
|---|---|---|
| 本体の生成物 | `artifacts/eumenes-memory-<version>.tgz` | 再生成可能な出力。実装時に artifacts を Git 管理対象外にする |
| 本体の生成物情報 | `artifacts/eumenes-memory-<version>.manifest.json` | packageVersion、schemaVersion、sourceCommit、tarball 名、SHA-256、verify 結果を記録 |
| 利用側が保管する配布物 | `../eumenes/vendor/eumenes-memory/eumenes-memory-<version>.tgz` | 採用した実体を利用側で Git 管理する |
| 利用側が保管する採用情報 | `../eumenes/vendor/eumenes-memory/manifest.json` | 本体の manifest を元に採用版・SHA-256 と結合検証結果を記録する |

本体の担当は artifacts まで生成し、利用側へのコピー・依存更新は Eumenes 接続の作業で行う。本体の M0 実装だけを依頼された担当は Eumenes のファイルを更新しない。

配布物には package metadata、公開 exports に対応するビルド済み JavaScript と型定義、必要なライセンス・利用資料を含める。runtime が参照するファイルの欠落がないことを consumer テストで確認する。DB、資格情報、開発データ、別の tarball を含めない。

受け渡し手順:

1. 本体のテスト・型検査・ビルドを実行し、tarball を artifacts に生成する。
2. 隣接 Eumenes の source に依存しない一時 consumer へ、その tarball をインストールして公開契約を検証する。verify の中で同じ処理を再帰的に呼ばない。
3. 配布対象とする本体のコミットを確定し、そのコミットのクリーンな状態から生成・検証する。検証した tarball の SHA-256 と sourceCommit を manifest に残す。開発途中の出力を採用済みリリースと混同しない。
4. Eumenes 担当が tarball と採用情報を vendor に取り込み、`package.json` に `eumenes-memory` の `file:vendor/eumenes-memory/eumenes-memory-<version>.tgz` 依存を追加し、`bun.lock` を更新する。
5. Eumenes の接続試験と横断検証を通した後、tarball・manifest・依存設定・lockfile を同じ変更として採用する。Eumenes だけを取得した環境から依存解決できることを確認する。

同一 version の配布物を別内容で上書きしない。修正は新しい version とファイル名で渡す。採用前に SHA-256 または内部 package version が一致しなければ拒否する。切り戻しは利用側の配布物・manifest・依存設定・lockfile を整合した前の版へ戻す。永続データを導入する M2 以降は、パッケージの巻き戻しだけでデータ互換性を保証しない。

ここでは配置と受け渡しを定義しただけで、artifacts / vendor、tarball、manifest、依存設定はまだ作成していない。

本体に永続化を導入する M2 以降は、schema migration の単独責任者を決める。ホストは接続を提供し、本体のテーブルを独自 SQL で更新しない。別サービス・別 DB へ変更する場合は採用時検証の整合性方式を設計し直す。現在の同一トランザクションの保証をそのまま主張しない。

既存 Continuity の正本移管は M0/M1 の必須作業にしない。必要になった時点で、履歴・ID・revision・冪等性・失効を保持し、書き込み停止位置の確定、インポート、投影同値性確認、単一 writer の切り替えを行う。無効化と本文消去を区別し、切り戻しでも最新の墓標を維持する。

## 8. Claude Code / Sonnet への渡し方

作業ディレクトリは `eumenes_memory`。この文書と `contracts-v0.md` を読み、**M0 のみ実装し、verify と consumer テストを通した結果を報告する**。Eumenes 内で本体実装を始める旧案は使わない。

契約と fixture 形式を親担当が固定した後、サブエージェントへ次を分担できる:

| 担当 | 所有する編集範囲 | 完了条件 |
|---|---|---|
| A | `src/view` | 固定契約に沿う投影・順序・予算・digest |
| B | `src/validation` | 失効・scope・版の再検証と部品テスト |
| C | `test/consumer` と割当 fixture | 公開配布物での正常・拒否・互換性の確認 |
| 親 | contracts、package 設定、public exports、共通 fixture の管理 | 変更を統合し、単独 checkout で再現する |

契約変更は親担当へ戻す。各担当が型や fixture の意味を独自変更しない。共有ファイル・Eumenes の domain を並列編集しない。検証が失敗した場合は原因を直して同じ受入を再実行する。

初回の対象外は、HTTP サーバー、専用 DB、LLM 呼び出し、Records、embedding、World、Rust 全面移植、Eumenes の本接続。これらを完成させるために M0 を拡大しない。未確定の Rust 接続方式などは後続の設計判断として残してよい。

実装後は、実装済み / fixture 検証済み / ホスト結合未実施を分けて `spec/m0-validation.md` に記録する。公開 API と挙動、verify のコマンドと終了状態、既知の制限を記載する。本計画の作成時点では、これらのコードや検証結果はまだ存在しない。
