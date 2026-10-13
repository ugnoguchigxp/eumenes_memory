# 検証状況（機能 × 到達段階）

> **パス表記について**: 本書の `src/store/*`、`src/state/*`、`src/recall/*`、`src/lifecycle/*`、`src/evidence/*` は設計・実装時点の旧構造。現在は共通基盤が `src/infrastructure/sqlite/`、各機能が `src/domains/<domain>/{contracts,service,repository,test}/` にある（[ドメイン構造](../src/domains/README.md)）。記録は当時のまま残す。

2026-10-08 / 所有: 親担当（各スライス完了時に更新）。設計の正本は [full-system-design.md](full-system-design.md)、
ユーザー決定による範囲変更（World / Consolidation は別ドメイン・別リポジトリ、Rust spike なし）は §6 に記録する。

正直さの規律: 各機能は到達した段階までしか主張しない。実モデルを使っていない機能の意味精度、H 前の機能を「完了」と書かない。

| 段階 | 記号 | 意味 |
|---|---|---|
| contract | C | 型・定数・reasonCode・上限が確定している（実装は stub または未着手）。後続担当が依存してよい |
| implemented | I | コードがあり型検査・単体テストが通る |
| fixture-verified | F | 言語非依存 fixture と property/mutation 検査が通る |
| sql-verified | S | 使い捨ての実 SQLite（ファイル + WAL）で永続・トランザクション・復元シナリオが通る |
| host-integrated | H | Eumenes の Writer / queue / 採用 transaction に結合した試験が通る |
| model-evaluated | E | 実モデルを使った評価データで、事前に定めた閾値を満たす |

## 1. 到達段階表

`●` = 到達、`○` = 契約のみ（stub）、`—` = 未着手または対象外。

| 機能 | スライス | C | I | F | S | H | E | 備考 |
|---|---|---|---|---|---|---|---|---|
| M0 view v1（build / validate） | M0 | ● | ● | ● | — | — | — | DB なし。fixture 101 件 |
| MemoryDb ポート、`MemoryStoreError`、writable 検査、seq 発行 | S0 | ● | ● | — | ● | — | — | unit + 実 SQLite（readonly 接続・transaction 外の拒否） |
| `assertMemorySchema`（migration hash 検査）、migration 0001 foundation | S0 | ● | ● | — | ● | — | — | hash 不一致・版が新しい・版が古い・表なしを検出 |
| テスト用 Writer（`test/support/store.ts`） | S0 | ● | ● | — | ● | — | — | WAL ファイル DB、書き込み 1 + 読み取り専用 1、`snapshotTo` で複製 |
| 外部接続: 変更フィード `listMemoryChanges` / `appendMemoryChange` | S0 | ● | ● | — | ● | — | — | 本文なし。書き込み側は各スライスが呼ぶ |
| 外部接続: ExternalDependent（`registerExternalDependents` / `unregisterExternalDependents` / `recordExternalDeletion`） | S6 | ● | ● | ● | ● | — | — | 外部派生物 `(providerRef, externalId)` を node 種別 `external` で登録、forget の閉包に入ると `memory_forget_external` に `pending`。receipt は failed > pending > unverified > confirmed に集約。World 側の実体は別リポジトリ（未結合） |
| Records（capture / read / range / sourceStates / deactivate） | S1 | ● | ● | ● | ● | — | — | fixture E01–E11、F03 復元シナリオ（古い DB + 最新ジャーナル）で read/search/view に出ない |
| Recall（`searchRecords`） | S2 | ● | ● | ● | ● | — | — | fixture R01–R15、like/fts 同値 property、`LIKE_SCAN_MAX = 5000`（spec/bench-scope-results.md）。FTS5 は macOS システム SQLite でのみ確認 |
| View v2（build / validate / parse / `composeSnapshotV2`） | S4 | ● | ● | ● | ● | ● | — | `buildMemoryViewV2` / `validateMemoryViewV2` / parse（v1 の関数は無変更、`schemaVersion: 2` は従来どおり拒否）。fixture build-v2 114 件（v1 同一入力の v2 化 + 新 kind・subject・evidence・coverage.omitted・予算・出典検査）+ validate-v2 63 件、実 SQLite 結合（Records + State → 検索 → build → 忘却 → validate）。Eumenes 結合: 対話の prepare で build、採用 transaction で validate（api/domains/dialogue/test/memory-integration） |
| State 台帳（明示操作、reducer、admission 規則表） | S3 | ● | ● | ● | ● | ● | — | fixture S01–S20、admission 規則表（S3 の 47 件 + S5 で 59 件追加 = 106 件。§6.4(a) の全カテゴリ）。抽出由来の永続は S5。Eumenes 結合: 明示登録・停止・再開・訂正（retract）。抽出由来の永続は未結合 |
| Extraction（prepare / settle / confirm、`ExtractorPort`） | S5 | ● | ● | ● | ● | — | — | fixture X01–X40、実 SQLite の結合試験（§8、§10）。意味精度は主張しない（E は未） |
| Lifecycle / Forget（plan / apply / reconcile / receipt、外部削除） | S1→S6 | ● | ● | ● | ● | ● | — | target は record / host_source / state_item / scope。閉包は candidate / state_item / run / input / shown / progress / external に届き、値を消す（§9）。物理消去は保証しない。Eumenes 結合: state_item の忘却を外部 journal（fsync）経由で適用、起動時 reconcile、古い DB 復元で再適用、journal 改ざんで Memory を使わない |
| 時間判定（temporal: 精度つき期間、現在/過去/未来/時点不明、過去時点の照会） | 提案 段階2 | ● | ● | — | ● | ● | — | 成立期間の精度・根拠は State に永続（migration 0004、`assertUserState` の `validity`）。Eumenes 結合で期限切れ項目を現在の理解から除外 |
| 選択（selection: 認可後のscope適用、必須/追加集合、矛盾解決、overflow/hold、取得状況フラグ） | 提案 段階2 | ● | ● | — | ● | — | — | `listStateScopes`（複数scopeと各scopeの版）→ `candidateFromStateItem` → `selectContext` を実 SQLite で結合（test/scenario/selection-state）。Eumenes の対話はまだ単一scopeの View v2 を使う |
| 利用根拠の再検証・公開版の更新判定・Checkpoint検査 | 提案 段階3 | ● | ● | — | ● | — | — | 再検証は実 SQLite の scope 版で試験。公開版・Checkpoint は純粋のみ。Eumenes は現状 View v2 の `validateMemoryViewV2` で採用時に再検証 |
| ホスト向けの読み取り（`latestMemoryChangeSeq`: scope で可視な変更の最大 seq、`readStateFact`: item と同じ事実の forgotten・墓標を除く全版の ID） | 0.3.7 | ● | ● | — | ● | — | — | 実 SQLite（principal・scope の分離、ブロック、forgotten・墓標の除外、`listState` の上限に依存しない）。Eumenes が内部の表を直接 SQL で読んでいた箇所の置き換え用 |
| State の origin `agent_inferred`（ホストのエージェントが依頼なしに推定。`assertUserState` / `editState` が受理） | 0.3.7 | ● | ● | — | ● | — | — | migration 0007。ユーザー由来の保護は受けない: 抽出由来は根拠順位で置き換え（Admission 13 の対象外）、`user_confirmed` / `user_edited` は `replaces` / `editState` で置き換え、同値なら origin を昇格（reducer・実 SQLite・Admission）。停止（retract / deactivate）の保護は origin ではなく操作（cause_type=user）に効く。view v2 の item origin にも追加（`ITEM_ORIGINS_V2` の末尾。契約版は変更しない） |
| ユーザー停止の保護（由来に依らず cause_type=user の retract/deactivate を保護）、意味 key の辞書照合（`keyDictionary`） | 提案 段階2 | ● | ● | — | ● | — | — | 実 SQLite（state・extraction 試験）。辞書で確定できた key だけ正規化し、不明・曖昧は統合しない |
| 抽出評価の値の意味採点（`valueMeaning`: anyOf/noneOf、`valueErrors`） | 提案 段階4 | ● | ● | — | — | — | — | 合成データの gold は valueHint 由来で `humanReviewed:false`。実モデル評価は未実施 |
| World / Consolidation | — | — | — | — | — | — | — | **本体では作らない**（別ドメイン・別リポジトリ）。接続部は ExternalDependent と変更フィードだけ |

## 2. migration 凍結点

**未凍結。** Eumenes の実 DB へ本体の migration を適用した実績はない（H 段階の最初の採用まで、統合・並べ替え可）。
採用した時点で、ここに「凍結した migration 番号と各 body の SHA-256」を記録し、以降は追記専用にする。

| 番号 | 状態 | 内容 |
|---|---|---|
| 0001 | 登録済み | foundation |
| 0002 | 登録済み | records（S1+S2） |
| 0003 | 登録済み | state（S3）+ extraction（S5: run / input / shown / candidate / candidate_evidence / source_progress と各 no_resurrection trigger。採用前なので同ファイルに追記） |
| 0004 | 登録済み | state の成立期間の精度つき日付と根拠（追記。0001〜0003 の本文は不変）。Eumenes 結合では 0.2.0 の配布物から採用 |
| 0005 | 登録済み | records の再生成可能な資料の保持（`memory_record_retention`: 鮮度期限・未使用期限・採用 revision。retention v1） |
| 0006 | 登録済み | 忘却した資料の retention metadata を除去する（既存行の削除と、`status='forgotten'` への更新で消す trigger） |
| 0007 | 登録済み（0.3.7） | state の origin に `agent_inferred` を加える（CHECK の変更のため state 表4つを作り直し。行は不変。`foreign_keys=ON` の transaction 内で適用して行・外部キー・index・trigger の保存を試験） |

## 3. S0 の検証記録

- `bun run verify` exit 0（format → lint → typecheck → Eumenes 互換 typecheck → test → public-surface）。
- テスト 489 件通過 = M0 の 416 件 + S0 で追加した 73 件。M0 の fixture 101 件・M0 の test ファイルは無変更
  （変更したのは公開 export 一覧を固定する `src/contracts/test/exports.test.ts` の期待一覧と、依存方向を拡張した
  `test/src-hygiene.test.ts` の該当テスト、`test/public-surface.test.ts` への追加のみ）。
- S0-T: readonly 接続の拒否、transaction 外の拒否、migration hash 不一致、版が新しい DB の拒否、版が古い DB の拒否、
  表なしの DB、`MemoryDb` の bun:sqlite との構造的互換（型検査）、`./sqlite` を自己参照 import する consumer テスト。
- ミューテーション確認（手動、結果は元に戻し済み）: transaction 外検査の削除、hash 比較の削除、版が新しい DB の検査削除、
  readonly 変換の削除（2 経路とも）、`listMemoryChanges` の scope 検査削除、`bun:sqlite` の src/store への import 混入はいずれもテストが失敗した。
- 未確認: FTS5 の可用性検査（`FTS_UNAVAILABLE`）は S2 で実装する。Linux など別環境の SQLite では未検証。

## 4. 確定事項（後続担当向け。型の置き場所と番号割当）

親だけが編集する共有ファイル: `package.json`、`src/index.ts`、`src/sqlite.ts`、`src/contracts/**`、`src/store/migrations/index.ts`、
`src/store/{db,errors,session,schema-check}.ts`、`test/src-hygiene.test.ts`、`test/fixture-runner.ts`、`test/public-surface.test.ts`、
`scripts/**`、`spec/verification-status.md`、`README.md`、`THIRD_PARTY_NOTICES.md`。

| 内容 | 場所 |
|---|---|
| 共通（SourceKey, EvidenceSpan, HostClock, RunRef, Subject, Polarity, Modality, Temporal, SourceRole, ScopedRead/Write, MissingStatus, JsonValue） | `src/contracts/common.ts` |
| `CONTRACT_VERSIONS`（records / recall / state / extraction / lifecycle / external）、`VIEW_SCHEMA_VERSIONS = [1, 2]` | `src/contracts/versions.ts` |
| Records | `src/contracts/records.ts`（`LIMITS_RECORDS`、`RECORD_*`） |
| Recall | `src/contracts/recall.ts`（`LIMITS_RECALL`、`RecallHit`） |
| View v2 | `src/contracts/view-v2.ts`（`LIMITS_VIEW_V2`、`BUILD_V2_REASON_CODES`、`MemoryViewV2` 他） |
| State / Admission / reducer 型 | `src/contracts/state.ts`（`LIMITS_STATE`、`STATE_*`、`ADMISSION_*`） |
| Extraction | `src/contracts/extraction.ts`（`LIMITS_EXTRACTION`、`ExtractorPort`、`ExtractionOutput`） |
| Lifecycle / Forget / ジャーナル / 閉包の辺 | `src/contracts/lifecycle.ts`（`LIMITS_LIFECYCLE`、`ForgetJournalEntry`、`ClosureEdge`） |
| ExternalDependent / 変更フィード | `src/contracts/external.ts`（`LIMITS_EXTERNAL`、`MemoryChange`） |
| 永続 API の stub（担当が `export const` を `export function` に置換） | `src/store/{records,recall,state,extraction,lifecycle}.ts` |
| 実装済みの共有部品 | `src/store/{db,errors,session,schema-check,scope-state,dependency,tombstone,changes}.ts` |
| 純粋部品の置き場（作成は担当） | S1: `src/lifecycle/`（closure / journal / `verifyForgetJournal`）、`src/evidence/`、S2: `src/recall/`、S3: `src/state/` |
| migration 番号 | 0002 records（S1+S2）、0003 state + extraction（S3 → S5）。手順: `src/store/migrations/README.md` |

`.` からは contracts の全 export（型 + 定数）を出し、`./sqlite` は関数・`MemoryDb`・`MemoryStoreError`・`migrations` と入出力の型を出す（定数は `.` から import）。

## 5. 実装担当への注意（hygiene・テストの形）

- src の禁止語（コメント・文字列を含む）: `Date` / `Math.random` / `process` / `fetch(` / `JSON.parse` / `Intl` / `localeCompare` / `globalThis` / `Bun.` など（`test/src-hygiene.test.ts`）。`bun:*` は src 全体で禁止、`node:crypto` は `src/canonical/sha256.ts` だけ。
- `src/store` と `src/sqlite.ts` に `BEGIN` / `COMMIT` / `SAVEPOINT` / `.transaction(` / `async` / `await` を書かない（コメント以外）。
- JSON 文字列の列は `JSON.parse` で読めない。SQL の `json_extract` / `json_each` を使うか列に分解する。
- `INSERT OR IGNORE` は CHECK 違反まで無視する。重複だけ無視するなら `ON CONFLICT DO NOTHING`。
- unit test は `src/store/test/*.test.ts`、DB は `test/support/store.ts` の `openTestStore()`。consumer テストは `test/consumer/` で `eumenes-memory` / `eumenes-memory/sqlite` / `../support/store.ts` だけを import する。

## 6. 設計書からの逸脱（ユーザー決定と S0 での判断）

ユーザー決定による範囲変更:

- World は別ドメイン・別リポジトリ。§3.7（World 型・world 表・confidence・deriveWorld・rebuildWorld）、§3.8 / S8（Consolidation）は本体で作らない。
  world / consolidation 用の表・LIMITS・CONTRACT_VERSIONS 要素・fixtures ディレクトリも作らない。代わりに接続部だけを契約化した:
  (a) `ExternalDependent`（memory の依存辺に node 種別 `external` で登録し、forget の閉包に入ると `pending` / `unverified` の外部削除として返る）、
  (b) 読み取り専用の変更フィード `listMemoryChanges(db, { afterSeq, limit })`（ID と版・状態だけ。本文は別 API）。
- Rust spike は行わない。`spec/rust-core-decision.md` は S3 担当が「A（TS 独自実装）採用、spike は wasm32 ターゲット未導入のため未実施」と記録する。

S0 での判断（設計書の細部を確定・補足したもの）:

1. 0001 の表に補足: `memory_dependency` に `principal` / `scope_key` 列と scope index を追加、`memory_forget` に `journal_seq`（UNIQUE）/ `entry_hash`、
   `memory_forget_external` に `external_id`（既定 `''`）を主キーへ追加（外部派生物単位の確認のため）、`memory_change` 表（変更フィード）を追加。
   `memory_scope_state.enabled_extraction` は作らない（`enabled` はホストが呼び出しごとに渡す）。`memory_tombstone.target_type` に `source` と `external` を追加。
2. migration の hash 記録: SQL は自分自身の hash を書けないため、各 `NNNN-*.ts` は body だけを持ち、`migrations/index.ts` が末尾に
   版と `migration_<n>_sha256`（body の SHA-256）の INSERT を付ける。
3. `assertMemorySchema` は「版が新しい」だけでなく「版が古い」（`SCHEMA_OUTDATED`）も拒否する（最新 migration 未適用のまま SQL を実行しないため）。
   `enterWrite` はスキーマ検査を seq 発行の前に置く（未適用 DB を `SCHEMA_MISSING` で報告するため）。
4. `ForgetTarget` の `record` / `state_item` に `scopeKey` を必須で追加（認可のため）。`captureRecord` などの結果に `status` 判別子を追加し、
   scope 不許可は `blocked`（作成系）／`not_permitted`（単一対象の読み出し）で返す。`RecallHit` に `scopeKey` を追加。
   `readMemorySnapshotPart` の結果を `status: "ok" | "blocked"` の判別共用体にした。`assertUserState` / `editState` に `subject` と、
   本文つき出典 `sources`（quote 検査用）を追加。`listCandidates` を追加（pending_user の確認 UI 用）。
5. `ExtractorPort` が失敗した場合、ホストは settle を呼ばない（settle は「モデルが返した値」だけを受ける）。出力トップレベルの形違反と候補内の権限系フィールドは
   run 全体の `rejected_output`（`OUTPUT_SCHEMA`）、個々の候補の値の不正は候補単位の `rejected`。
6. 根拠の新旧（`OLDER_EVIDENCE`）は、ホストが出典に付ける `ordinal`（同一 scope で比較可能な非負整数）で判定する。明示操作（`user_confirmed` / `user_edited`）は CAS のみ。
7. View v2 の `BUILD_V2_REASON_CODES` / `VALIDATION_V2_REASON_CODES` は S0 時点で v1 と同内容（evidence は既存の `SOURCE_*` / `BUDGET_EXCEEDED` で表せるため追加なし）。
   必要になれば S4 が末尾に追加する（v1 のタプルは変更しない）。

## 7. 未解決・次のスライスへ

- S1+S2 と S3 は並列可（書き込み先: `src/store/{records,recall}.ts`・`src/recall/`・`src/evidence/`・`src/lifecycle/` と `src/store/state.ts`・`src/state/`）。
  開始前に親が 0002 / 0003 の空 body を `migrations/index.ts` に登録しておくと、担当の統合試験が止まらない（`migrations/README.md` §追加手順 3）。
- ContextStill との境界（Episode は ContextStill、本体は会話をまたぐ話題・好み・本人の事実）は設計書 §10 の未決のまま。
- 墓標ジャーナルの実ファイル操作（tempfile → fsync → rename → dir fsync）、起動時 `reconcileForgetJournal`、`PRAGMA secure_delete` は Eumenes 側（M1 以降）。

## 8. S5（Extraction）の記録

- `bun run verify` exit 0（テスト 1291 件 = S4 完了時の 1122 件 + 169 件）。到達: I / F / S。H は未（Eumenes の queue handler 結合は S10）、E は未（モデル未使用）。
- 実装: `prepareExtraction` / `settleExtraction` / `confirmCandidate` / `listCandidates`（`src/store/extraction.ts`）、純粋部品は `src/extraction/`
  （`prompt.ts` 文言 + 出力 JSON schema、`candidate.ts` 厳密 parse、`parse.ts` 入力 parse、`ids.ts`）。
  `.` からは `parseExtractionOutput` / `buildExtractionPromptMaterial` / `runIdOf` / `candidateIdOf` を公開。
- fixture: `fixtures/extraction/X01–X35`（canned output → 期待 decision、stale 系 3 種、冪等・RUN_ALREADY_SETTLED_DIFFERENT・RUN_UNKNOWN、
  出力上限・TOO_MANY_CANDIDATES、引用不一致・絵文字境界、subject other、仮定・引用・伝聞・過去・assistant 出典、確認操作、確認済み項目の保護）。
  `fixtures/admission` は 106 件（§6.4(a): 否定・二重否定／部分否定・仮定・疑問・引用・伝聞・別人情報・嗜好変更・訂正・過去の状態 各 4 件以上 + `never` の優先順の回帰）。
  規則では止められない誤り（極性の取り違え、仮定文・疑問文の modality 取り違え）の fixture は `stage: "E"` と `note` を持ち、現在の挙動（admitted）を期待値にしている。
- シナリオ: `test/scenario/extraction-pipeline.test.ts`（決定的な stub ExtractorPort: canned / rule / faulty、prepare → 遅延中の source 変更・忘却 → settle、
  FG9、忘却前に複製した DB の復元 + reconcile、見せた state 経由の閉包）。
- mutation（手動、結果は元に戻し済み・復元後に同一性を diff で確認）: `never` 優先の削除（A51–A56, A84 が失敗）、確認済み項目の保護の削除（A92/A93/A96/X31）、
  temporal 規則の削除（A99–A101, A105, X19）、stale 判定の墓標検査の削除（X21）、見せた state の revision 検査の削除（X23 他）、
  output digest 比較の削除（X26 他）、noChange 同値検査の削除（X04/X05）、candidate→source 依存辺の削除（X01 他）、stale での進捗書き込み（X20 他）、
  run→見せた state 依存辺の削除（閉包シナリオ）— いずれもテストが失敗した。

### S5 の設計判断・設計書からの逸脱

1. **`never` の優先（S3 報告 #2 の修正）**: 方針が never の kind では、`pending_user` になる規則（MODALITY_QUOTED / SUBJECT_OTHER / TEMPORAL_NOT_CURRENT / NOT_USER_SOURCE / 確認済み項目の保護）は
   候補を作らず `rejected` / `POLICY_NEVER` にする。rejected になる規則（INVALID_CANDIDATE〜HOST_OWNED_KIND、MODALITY_NOT_ASSERTED、SUBJECT_UNKNOWN、OLDER_EVIDENCE）の reasonCode は変えない。
   subject other の方針は `other_person_note` の方針（self の kind の never は当たらない）。
2. **確認済み項目の保護（S3 報告 #3 の扱い）**: 契約（設計書 §3.5）は reducer の supersede / dispute / OLDER_EVIDENCE を抽出由来にも適用するだけで、`user_confirmed` / `user_edited` の active の保護には触れていない。
   安全側として Admission に規則を足した: 同 key の active が `user_confirmed` / `user_edited` で値が違い、かつ候補の根拠が古くない場合は `auto_admit` でも `pending_user`（reasonCode は既存の `POLICY_REQUIRES_USER`）。
   ユーザーが確認すると、settle 時点の active を CAS（revision）で置き換える。reducer は変更していない（S08–S11 の挙動のまま）。
3. **`TEMPORAL_NOT_CURRENT` を `ADMISSION_REASON_CODES` に追加**（`SUBJECT_UNKNOWN` と `NOT_USER_SOURCE` の間）: 設計書 §6.4(a) は「過去の状態 → pending_user」と書くが §3.5 の規則表に対応する行がなかった。
   temporal が `past` / `future` の候補は現在の状態にしない。`future` は §6.4(a) に明記がなく、安全側として同じ扱いにした。設計書 §3.5 の表への追記が必要。
4. 候補表は kind を StateKind に限る（CHECK）ため、INVALID_CANDIDATE・HOST_OWNED_KIND と kind を決められない候補は行を作らず run の rejected 件数にだけ数える。
   検査を通らなかった evidence（QUOTE_MISMATCH 等）は candidate_evidence に保存しない。subject が unknown の候補は pending にせず `SUBJECT_UNKNOWN` で rejected（admission 単体では A44 が MODALITY_QUOTED の pending を期待しているため規則表は変えず、settle で矯正）。
5. 出典の本文は run に保存しない。settle は `currentSources[].content`（ホストが同 transaction で読み直した本文）と入力の digest で quote を検査する。本文が渡されていない出典を引用した候補は `QUOTE_MISMATCH`（検証できない）。
6. run の再 prepare（stage が prepared のうち）は入力を作り直す（外れた入力の古い依存辺は残す）。確定した run を同じ ID で prepare すると `NO_NEW_INPUT`。run の ID を別の principal / scope が使っていれば `blocked`。出典の本文と digest の不一致は `MemoryContractError(INVALID_DIGEST)`。
7. 見せる state（shownState）は scope の active な self の item 最大 50 件（updated_seq の新しい順）。`other_person_note` は見せない。見せた item は run の入力として依存辺（role input）を持つ。
8. 表の追加: `memory_extraction_shown`（見せた item と revision。設計書の表にない）。`memory_candidate` に `idx` / `evidence_ordinal` / `replaces_item_id` / `replaces_revision` / `admitted_item_id` / `resolution` / `resolved_seq`、`memory_extraction_run` に `output_digest` と件数列、`memory_extraction_input` に `idx` / `role` / `ordinal`。
9. `auto_admit` は `settle` の `policy` 引数が明示したときだけ。本体は既定で自動採用しない。`other_person_note` の `auto_admit` は入力 parse が `INVALID_ENUM` で拒否する。

### S6 が知るべき点（閉包が届くべき行）

- 依存辺: `extraction_run → source`（role input、引用されなかった入力も）、`extraction_run → state_item`（見せた item、role input）、`candidate → extraction_run`（derived_from）、
  `candidate → source`（検査を通った evidence）、`state_item → candidate`（derived_from、抽出の自動採用と確認操作の両方）、`state_item → source`（evidence）。
- 閉包で消す行: `memory_candidate`（value_text / polarity を NULL、semantic_key を ''、`memory_candidate_evidence` 行を削除、decision `forgotten`、墓標 `candidate`）、
  `memory_extraction_run`（墓標 `extraction_run`。provider_ref は外部削除確認の対象）、`memory_extraction_input` / `memory_extraction_shown` の行、
  `memory_source_progress`（forget した出典の行。再 insert は trigger が拒否）。S1 の `applyForget` は墓標を書くだけで、これらの行の値の消去はしていない。
- run の `provider_ref` は prepare で `profile.providerRef` として保存済み（外部削除の pending 登録に使える）。
- 現在の挙動の確認: 墓標のある run は settle で `stale: SOURCE_TOMBSTONED`、候補は `confirmCandidate` で `forgotten`、listCandidates / listState に出ない（`test/scenario/extraction-pipeline.test.ts`）。

## 9. S6（Lifecycle 全閉包 + 外部接続）の記録

- `bun run verify` exit 0（テスト 1362 件 = S5 完了時の 1291 件 + 71 件）。到達: I / F / S。H は未（Eumenes の Writer / ジャーナル / 起動手順との結合は S10）、E は対象外（モデルを使わない）。
- 実装: `planForget` / `applyForget` / `reconcileForgetJournal` / `getForgetReceipt` の target に `host_source` / `state_item` を追加し、`scope` を record だけから全データへ拡張。
  `recordExternalDeletion` / `registerExternalDependents` / `unregisterExternalDependents`（`src/store/lifecycle.ts`）。純粋部品は `src/lifecycle/{external-parse,targets}.ts`。
  値の消去は表の持ち主の関数（`state.ts` の `scrubStateItem`、`extraction.ts` の `scrubCandidate` / `scrubRun` / `scrubSourceProgress` / `scrubScopeProgress`、`records.ts` の `recordOwnedBy`）。
- 閉包の起点と消去の規約は `src/contracts/lifecycle.ts` の JSDoc と `src/store/README.md`「forget の閉包と限界」。要点: host_source は出典キー（引用されなかった入力も `input` 辺で届く）、
  state_item は item と元の候補（同じ値を持つため）、scope は scope の全 record / item / candidate / run / external。閉包内の state_item / candidate は値・polarity を NULL・semantic_key を ''・付随行（attribute / evidence）を削除、
  run は入力・見せた state・digest・`provider_ref`・進捗行を消し確定前なら `stale: SOURCE_TOMBSTONED` で閉じる。依存辺は残す。
- 再帰 CTE は `reach` を外側にして `memory_dependency_by_dependency` を引く順に固定（`CROSS JOIN ... INDEXED BY`）。固定しないと辺の表の全走査が reach の行数ぶん繰り返される: 計測（1 出典に 3000 candidate + 3000 item + 1000 external、閉包 7000 node）で plan 4.4 s / apply 4.6 s → 固定後 plan 32 ms / apply 202 ms（R-D の 1 万行相当を 1 transaction で許容範囲）。
- fixture: `fixtures/lifecycle` L17–L21（entry / chain、期待 hash は TS の外の Python: hashlib + json.dumps で計算）、L22–L28（`forget-db`: 宣言的な依存グラフ → 実 SQLite → 実 forget。期待値は手書き）。runner は `test/runners/forget-db.ts`。
  extraction fixture の `tombstone` ステップを実 forget（`forget`）に置換（X21 / X30。X30 の確認操作は候補自体が忘れられるため `refused` ではなく `forgotten`）。
- シナリオ（`test/scenario/forget-closure.test.ts`）: FG2（cited 入力、復元 + reconcile、view v2 の invalid）、FG3（引用されなかった入力）、FG4（Memory OFF）、FG5（外部 pending / unverified / failed / confirmed の集約、不明な provider・他 principal・許可外 scope）、FG9（prepare 後 forget → settle は stale、候補 0 件）、state_item target、辺の不変条件（辺のない派生行がない）、不正なジャーナルで inconsistent。
- FG10（`test/scenario/forget-property.test.ts`）: 固定 seed の mulberry32、ランダムな依存グラフ（2 scope・共有出典・shown・user item・external・進捗）× ランダムな forget 順（host_source / record / state_item / scope）、190 ケース。
  oracle は実装と別の素朴な BFS（`test/runners/forget-support.ts`）。確認: 墓標集合が oracle と一致、閉包外の行が不変、閉包内の値が全 memory_ 表から消える、forgotten でない行の依存に forgotten 行がない、各 entry の再適用と reconcile の再実行で DB が不変、忘却前の複製 DB + 最新ジャーナルでも同じ結果。生成の自明でなさも検査（forgotten / kept の両方、全 target 型）。
- mutation（手動、結果は元に戻し済み・バックアップとの diff で同一性を確認）: 閉包が candidate を落とす、`input` 辺を無視、state の value 消去の欠落、candidate の value 消去の欠落、candidate evidence 行の削除欠落、外部状態の集約順の入れ替え、再適用で変更フィードを重複追記（冪等性）、scope の出典の排他検査の削除、run 入力行の削除欠落、`memory_forget.external_state` の更新欠落、`externalId` 指定の無視、prepared run を stale で閉じない、state_item の元の候補を起点に入れない、忘れた出典の進捗行の削除欠落、run の providerRef を pending に載せない、reconcile が 0 から再適用、再適用が createdBefore を無視、scope 出典の排他検査が忘れた行の辺を数える、plan が他人の行の target を通す、過去の変更フィードの revision を消さない — いずれもテストが失敗した（最初の 1 件だけ生き残った: 外部集約の「failed と pending の併存」を検査していなかったので FG5 に追加）。

- 独立レビュー 1 回（reviewer）: 指摘のうち、scope の出典排他検査が忘れた行の辺を数える（2 つ目の scope の forget で共有出典に墓標が付かない）、record / host_source / state_item の target が他の principal / scope の行を指せる、record forget 後も過去の変更フィードの行に本文の SHA-256 が残る、の 3 件を修正して回帰テストを追加。残りは下の限界に記録（外部派生物の依存辺はジャーナルに載らない、`registerExternalDependents` の source 参照は検査しない、provider 単位の行は同名の `providerRef` の外部派生物と `externalId` 省略で一括更新される、存在しない ID は他 principal が先に墓標にできる）。

### S6 の設計判断・設計書からの逸脱

1. **scope の forget を全データへ拡張**（設計書 §3.9「scope 内の本体所有データ全部」）: S1 は record だけだった。state_item / candidate / run / external（辺の scope_key が scope のもの）と進捗行も消す。plan の counts のキー（record / state_item / candidate / extraction_run / external）は S1 と同じで、墓標がまだ付いていない node だけ数える。
2. **state_item の forget は元の候補も起点に含める**: 設計書の閉包は dependency → dependent だけだが、候補は item と同じ値を持つので、item → candidate の辺で上流の候補も忘れる（候補の下流の他の item も閉包に入る）。run は忘れない（値を持たない。item を shown として見た run は S5 の辺で閉包に入る）。
3. **忘れた run の進捗行も消す**: run が処理済みにした他の出典（忘れていない）が、新しい run で抽出し直せるようにする。逆に state_item の forget では、元の run の進捗は残るので同じ出典は再抽出されない（出典が変わって再抽出すれば新しい ID で再び現れうる: 限界を参照）。
4. **確定前（prepared）の run は forget で `stale: SOURCE_TOMBSTONED` として閉じる**（X21 の期待どおり）。確定済みの run の stage は変えない。run 行は墓標とともに残す（settle / prepare を拒否するため）。
5. **host_source の SourceKey が record のものなら、その record も忘れる**（`recordIdOfSourceKey`）。record として存在しない・他 scope なら出典の墓標だけ。
6. **scope の forget は、他の scope の派生行も引用している出典に墓標を付けない**（出典を共有する別 scope を巻き込まない。record の出典は scope 内の record として扱う）。
7. **ExternalDependent の登録**: 辺のない外部派生物は作らない（`dependsOn` は 1 件以上）、全件検査してから書く、`state_item` 依存は同じ principal / scope のものだけ、忘却済み（墓標あり）の依存先と忘却済みの外部派生物には登録しない（`TOMBSTONED`）。同じ `(providerRef, externalId)` を別 principal / scope が使っていれば `EXTERNAL_ID_IN_USE`（`EXTERNAL_REJECTED_REASON_CODES` の末尾に追加）。登録は scope revision・変更フィードに触れない。
8. **recordExternalDeletion は最後に記録した状態が有効**（confirmed の後の failed で completed が取り消される）。`externalId` 省略は、その forget に登録された `providerRef` の全行（プロバイダー単位と外部派生物単位）が対象。`pending` へは戻せない（入力 parse が拒否）。
9. **state_item の event**: forgotten にするとき `cause_id` を ''、`from_revision` / `to_revision` を NULL、`at_ms` を 0 にし、`forget` event（action と seq）を足す。item の revision は forgotten への遷移で +1。
10. **辺（`memory_dependency`）と墓標は残す**: ID しか持たず、再適用（復元後の reconcile）の入力だから。`request_json` も targets の ID だけ。

### 限界

- **物理消去は保証しない**: SQLite の空き領域・WAL・OS のスナップショット・Time Machine・ホストのバックアップに値が残りうる。ホストの推奨運用は `PRAGMA secure_delete=ON` と忘却後の `wal_checkpoint(TRUNCATE)`（本体は PRAGMA を持たない）。本体が保証するのは「memory_ 表の行・FTS の索引・変更フィード・読み出し API から値が消える」まで（テストは全 memory_ 表と FTS の影表を走査して確認）。
- **復元の境界**: 復元された DB は本体だけでは古い DB と区別できない。reconcile を呼ぶまでは古い状態（忘却前の値）が見える。ジャーナルの末尾が切れている場合、DB も古いと検出できない（`JOURNAL_TRUNCATED` は DB の head がジャーナルより進んでいるときだけ）。空のジャーナルは DB に墓標がなければ `ok`。**ジャーナルの保管と起動時 reconcile はホストの責任**（下の一覧）。
- **外部の確認状況は DB の中だけ**にある。古い DB を復元して reconcile すると、その forget の外部削除は `pending` に戻る（外部が既に削除済みでもホストが `recordExternalDeletion` をやり直すまで completed にならない。安全側）。
- 外部（プロバイダー、World など）側の実際の削除は確認できない。確認手段がなければホストが `unverified` を記録する（`completed` にはならない）。本体はプロバイダーへ送ったかどうかも知らないので、閉包内の run の `providerRef` は run が prepared でも pending にする（送っていなくても pending）。
- host_source / record の forget の閉包は、その principal の全 scope に届く（出典キーが scope を持たないため）。呼び出しの認可は target の `scopeKey` だけで行う。
- state_item を忘れても、元になった出典が残っていて内容が変われば、新しい run が同じ事実を新しい ID の candidate / item として作りうる（本体は「意味的に同じもの」を墓標にしない）。
- 外部派生物の依存辺（`registerExternalDependents`）はジャーナルに載らない。DB を復元した場合、スナップショット後に登録した外部派生物は閉包に入らないので、外部が再登録してから reconcile する。
- `registerExternalDependents` の `source` 参照は形式・scope を検査しない（本体は出典の所有者を知らない）。別 scope が同じ出典を引用していると見なされうる（scope の forget の排他検査に影響）。
- `recordExternalDeletion` を `externalId` 省略で呼ぶと、同じ `providerRef` のプロバイダー単位の行と外部派生物の行が一括で更新される。外部派生物の `providerRef` と抽出 run の `providerRef` に同名を使わない。
- 存在しない ID（record / state_item）の forget は、その ID の将来の作成を止める墓標になる。ID は他の principal も指せるので、別 principal が先に墓標にできる（ID にホストが principal を含めない運用では DoS になりうる）。
- 再抽出の拒否は出典・run・candidate・item の ID に対する墓標で、内容の一致では判断しない。

### ホスト（Eumenes）側の必須手順（S10 で結合試験）

1. 墓標ジャーナルは DB の外のファイルで、ホストが所有する。忘却は `planForget` → entry をジャーナルへ追記して fsync（tempfile → fsync → rename → dir fsync）→ `applyForget`（write transaction 内）の順を守る。plan → 追記 → apply は直列化する（本体は plan 時点の head の次の entry を作る）。
2. ジャーナルは DB のバックアップと別媒体で保管し、DB を過去へ復元しても最新のジャーナルを残す。
3. 起動時（queue / worker の起動前）に `reconcileForgetJournal` を必ず実行し、`inconsistent` なら Memory の読み出し・抽出を止める（fail closed）。復元直後を本体は検出できない。
   結果が `ok` で `feedResyncRequired: true`（`reapplied > 0` = DB がジャーナルより古かった）なら、変更フィード（`listMemoryChanges`）の購読者（外部ドメイン）は保存済みのカーソル（`afterSeq`）を破棄して全再同期する。
   理由: 古い DB を復元すると `memory_seq` と変更フィードの番号が失われた期間の分だけ巻き戻り、再適用した忘却の通知は古い番号に並び直されるので、巻き戻り前のカーソルを持つ購読者は忘却通知を取りこぼす。
   ジャーナルの entry の形式（hash）は変えていない。`reapplied === 0` でも、ジャーナルに forget が無いまま DB だけを過去へ戻した場合は番号が巻き戻りうるが、本体は検出できない: **DB を復元したホストは、この値に関わらず購読者のカーソルを破棄する**。
4. `PRAGMA secure_delete=ON` と、忘却後の `wal_checkpoint(TRUNCATE)`。
5. 閉包に外部プロバイダーまたは外部派生物があれば、receipt の `externalDeletions` を見て外部へ削除を依頼し、確認できたら `recordExternalDeletion`（確認手段がなければ `unverified`、失敗なら `failed`）。DB を復元した後は、確認済みの分も記録し直す。`completed` を UI で「完了」と言ってよいのは `true` のときだけ。
6. 外部ドメインは、派生物を作ったら `registerExternalDependents`、自分で作り直す／消したら `unregisterExternalDependents`、変更フィード（`listMemoryChanges`）の `forgotten` を見て自分の派生物を作り直す／消す。
7. 会話 message の削除は host_source の forget（出典キーと scope）として呼ぶ。host が message を消したのに forget しないと、抽出済みの candidate / item は残る。
8. Memory OFF でも forget は実行する（`enabled` を渡さない）。抽出の prepare に `enabled: false` を渡して skip する。
9. state item の期限（`validFromMs` / `validUntilMs`）は本体が評価しない（`readMemorySnapshotPart` は現在時刻を持たない）。期限の評価はホスト: 期限切れの item を snapshot に合成する前に除くか、扱いを決める。

## 10. 最終レビュー対応（S0〜S6・S9 完了後の独立レビュー 2 件）

レビュー A（Records / Recall / 墓標・ジャーナル）の残りと、レビュー B（State / View v2 / Extraction）の指摘を一括で修正した。コミットなし。

### レビュー A

- **A-3 復元後の変更フィード**: ジャーナル entry の形式は変えない。`ReconcileForgetJournalResult`（ok）に `feedResyncRequired?: true` を追加（`reapplied > 0` のときだけ）し、型の JSDoc と上のホスト必須手順 3 に「購読者はカーソルを破棄して全再同期」を明記した。テスト: `test/scenario/forget.test.ts`（番号が巻き戻った古い DB の復元 + reconcile、古いカーソルでは忘却通知が見えず、全再同期なら見える）、`src/store/test/lifecycle.test.ts`。
- **A-4 鎖の連結検査**: `buildJournalEntry` / `computeEntryHash` / `computeForgetId` で hash を再計算した自己整合な別系統 entry（分岐・継ぎ接ぎ・seq 飛び・先頭の prevHash 違い・targets 非整列／重複・forgetId 不一致）で、`verifyForgetJournal`（`src/lifecycle/test/journal.test.ts`）、`applyForget` の連結検査（`prevHash == head.hash`、seq 連続、適用済み seq の別 entry）、`reconcileForgetJournal`（分岐・継ぎ接ぎ・seq 飛び・非整列・forgetId 不一致は何も書かず `JOURNAL_CHAIN_BROKEN`）を固定した（`src/store/test/lifecycle.test.ts`）。
- **A-5**: `test/scenario/forget.test.ts` の空振りテスト（try 内 throw を同じ catch が拾う）を、hash を再計算した seq ギャップ entry が `JOURNAL_ENTRY_INVALID` で拒否され、DB が変わらず、連続した seq は適用できる、という検査に書き直した。適用済み seq の hash 違いの検査も、transaction 外呼びで落ちていた（別の理由）ものを `live.write` 経由の `JOURNAL_ENTRY_INVALID` 確認に直した。
- **メモ**: `assertMemorySchema` はモジュール読み込み時に 1 回計算した migration hash の定数列を使う（`src/store/schema-check.ts`。状態を持たない定数のみ）。`reconcileForgetJournal` は `inconsistent` でも操作 seq（`memory_seq`）を 1 つ進める（行は書かない）旨を docstring に明記した。

### レビュー B

1. **同値の明示確認で origin を昇格**: active が `admitted_extraction` で、`assertUserState` / `confirmCandidate` / 同値の `editState`（`replaces` つきの assert も）が同じ値を `user_confirmed` / `user_edited` で書くと、値は変えずに origin を user 由来へ上げる（revision +1、event は `edit`、結果は `applied`。根拠は差し替えない）。逆（user → 抽出）の降格・user 同士の横移動はしない。昇格後は「確認済み項目の保護」が効く。reducer（`promoteOrigin`）と store の両方、fixture S21 / X38 / X39。
2. **disputed / ユーザーが消したものの可視化**: `StateKeyHistory`（`disputedMaxOrdinal`、`userRemoved`）を `StateTransitionContext.keyHistory`（省略可）と `AdmissionInput.keyHistory`（省略可）に追加し、store が `loadKeyHistory` で計算して渡す。(a) 同 key に disputed があり根拠順位が disputed の最新より古ければ `OLDER_EVIDENCE`、同順位以上でも dispute を解消せず、reducer は disputed の item として加わり、Admission は `pending_user`（`POLICY_REQUIRES_USER`、never の kind は `POLICY_NEVER`）。(b) ユーザー由来（`user_confirmed` / `user_edited`）の item を retract / deactivate した key への抽出由来は auto_admit でも `pending_user`（reducer 単体では `INVALID_TRANSITION`）。明示操作は履歴を無視する。再現 t2: 古い根拠は `OLDER_EVIDENCE`。fixture S22 / S23 / A107–A115 / X36 / X37。**限界**: 抽出由来の item をユーザーが止めた key は対象外（再抽出で再び入る。X37 に明記）。
3. **prepare の非 available な出典**: 本文と digest の一致検査は `status === "available"` の出典だけ。forgotten は `skip / SOURCE_TOMBSTONED`、missing / changed は他に新しい入力がなければ `skip / NO_NEW_INPUT`（本文が空でも `INVALID_DIGEST` を投げない）。available の出典は従来どおり検査する。
4. **ownValue（M0）の適用漏れ**: `src/contracts/own.ts` の `ownValue` を State / Extraction / Records / Recall / Lifecycle の省略可能キーの読みへ適用（`state/value.ts`・`state/evidence.ts`・`state/parse.ts`・`state/reducer.ts`・`store/state.ts`・`store/extraction.ts`・`store/records.ts`・`store/recall.ts`・`store/lifecycle.ts`・`extraction/parse.ts`）。判別用の `"reasonCode" in x` は discriminated union（`ok`）に置き換えた。回帰テスト `src/store/test/prototype-pollution.test.ts`: 省略可能キー（attributes / validFromMs / validUntilMs / replaces / kinds / includeInactive / limit / value / origin / evidenceOrdinal / identity / range / representation / content / decision / editedValue / keyHistory / revision / runRef / providerRef / withContent / cursor / externalId / reasonCode / subject / evidence）を 1 つずつ Object.prototype に仕込み、State・Extraction・Records・Lifecycle の操作列の結果（戻り値 + 全 memory_ 行）が変わらないこと、キーごとの敵対値が必要な箇所（range / content / representation / keyHistory / 遷移の欠けたキー）は個別のテストで固定した。各 `ownValue` を元に戻す mutation はすべてテストが落ちた（到達不能な防御 1 件を除く: `store/extraction.ts` の候補 evidence の range）。M0 の View 系（`contracts/parse-*.ts`・`view/*`）は既存のテストの範囲。
5. **`never` と rejected の候補行**: 方針 `never` の候補（`POLICY_NEVER`）は候補行を作らず件数だけ（契約どおり）。仮定文・疑問文・`QUOTE_MISMATCH`・`OLDER_EVIDENCE`・`SUBJECT_UNKNOWN` などの rejected は監査用に行を残し、行は `value_text` / `polarity` / `semantic_key` を保持する。これらは forget の閉包の対象で（run → candidate の辺。値は消える）、`listCandidates({ decision: "rejected" })` が値つきで返す。`src/contracts/extraction.ts` の JSDoc に明記。
6. **View v2 の件数上限**: `buildMemoryViewV2` は snapshot の items が `LIMITS.maxItems`、sources が `LIMITS.maxSources` を超えるとき、parse の `ARRAY_TOO_LONG` を投げず `overflow` / `BUDGET_EXCEEDED` を返す（disabled / blocked の判定は先。形が不正な入力は従来どおり例外）。`readMemorySnapshotPart` / `composeSnapshotV2` は上限なしで返し、契約 JSDoc に明記。実 SQLite で 1001 件の active item を作って固定（`test/scenario/view-v2.test.ts`）。
7. **小項目**: `disputed` を `admitted` と数える（X33）のは仕様として維持し契約に明記。attributes の差による同値比較の偽衝突は、抽出の候補に attributes が無いことを JSDoc に明記し、比較は変更しない。`validFromMs` / `validUntilMs` は評価しない旨を契約 JSDoc とホスト必須手順 9 に明記。`MemoryContractError` の path に attribute のキー名を出さない（`$.value.attributes`。State と Extraction の `editedValue` で共通の `readStateValue` に統一）。モデル由来の `semanticKey` / `subject` は明示操作と同じ識別子規則（制御文字なし）で拒否（`INVALID_CANDIDATE`、A116–A118）、`value.text` と quote は lone surrogate を拒否（A119 / A120 / A122）、`value.text` の改行は許可（A121）。
8. **mutation 生存テストの穴**: supersede の別 key 拒否（fixture S24、reducer の単体、context の不整合）、`editState` の scope 権限、prepare の shownState から other_person_note を除く（実際に note を作って確認）、subject unknown の quoted 候補（`SUBJECT_UNKNOWN` に矯正、confirm 側の拒否。**注**: confirm 側の `subject === "unknown"` の検査は後続の `isSubjectKindConsistent` と重複していて、外しても拒否される冗長な防御）、`readPolicy` の `other_person_note: auto_admit` → `INVALID_ENUM`、`plainCopy` の getter／非 plain prototype／配列の余分なプロパティ・穴・symbol、v1 の memory namespace の range content なしは `SOURCE_CONTENT_REQUIRED`、evidence の両端 ASCII 引用符と対応しない括弧、`isSaneText` の lone surrogate、`checkStale` の status／revision のみ／digest のみの不一致にテストを足した。

### 検証

- `bun run verify` exit 0（format → lint → typecheck → Eumenes 互換 typecheck → **eval typecheck（今回追加。`scripts/verify.ts`）** → test → public-surface）。テスト 1457 件 = 修正前の 1362 件 + 95 件。既存の fixture は 1 件も変えていない（追加のみ: state S21–S24、admission A107–A124、extraction X36–X40）。`.oxfmtrc.json` の ignorePatterns に `eval/results/**` を追加。
- mutation（手動。**リポジトリ外の `mktemp -d` のコピー**で適用し、コピー内で元のファイルを戻した。リポジトリの src は上書きしていない）: A: 鎖の seq 連続／prevHash の連結／targets の整列・重複なし／forgetId の再計算（`verifyForgetJournal`・`isSelfConsistent`）、`applyEntry` の `prevHash == head.hash` と seq ギャップ、reconcile の head hash 照合、`feedResyncRequired`。B: 昇格の無効化／降格の許可／edit の同値昇格／昇格時の根拠差し替え、reducer の履歴（userRemoved・disputed より古い・dispute への合流）、Admission の履歴（古い・pending・never・changesKey）、store が履歴を渡さない（候補書き込み・settle）、`loadKeyHistory` の墓標除外・user 由来の限定、prepare の digest 検査（available のみ）、never の候補行、View v2 の overflow、attribute path のキー名、識別子の制御文字（semanticKey・subject）、supersede の別 key／context の不整合、`editState` の scope 権限、shownState の other_person_note 除外、SUBJECT_UNKNOWN の矯正、`readPolicy` の auto_admit、v1 の range content 必須、ASCII 引用符の両端判定、`isSaneText` の lone surrogate、`checkStale` の status／revision のみ／digest のみ、`plainCopy` の余分なキー・非 plain prototype、判別用の `in` — すべてテストが落ちた。`ownValue` 全 36 箇所（State／Extraction／Records／Recall／Lifecycle）を `(x as any).k` に戻す mutation も、到達不能な 1 件（上記）を除いてテストが落ちた。
- 生き残った 3 件は同値 mutation または死んだコード: `assertUserState` への keyHistory の受け渡し（明示操作は履歴を見ないので削除した）、`plainCopy` の「配列要素・オブジェクトのプロパティが accessor のとき `descriptor.value` を見る」検査（accessor の値は undefined になり、その後の型検査で同じく `OUTPUT_SCHEMA` になる冗長な防御）、`confirmCandidate` の `subject === "unknown"` 検査（直後の `isSubjectKindConsistent` と重複）。

### 設計の限界として記録（見送り）

- `value.text` はモデルの任意の文字列で、evidence の quote とは検証上結ばれない（quote が出典の range と一致することしか検査しない）。意味の一致は規則では検出できず、E 段階（実モデル評価）の対象。
- 抽出由来の item をユーザーが retract / deactivate した key は、再抽出で自動採用されうる（決定どおり user 由来の item だけを保護）。
- `store/extraction.ts` の候補 evidence の `range` の ownValue 化は到達不能な防御（spans は常に range を持つ）のため、pollution テストでは検出されない。


## 11. ドメイン移行と開発基盤（2026-10-09）

改善案の段階0を実装した。Records / Recall / State / Extraction / Projection / Lifecycleが契約・純粋処理・同期SQL・テストを所有する。共通SQL基盤は `src/infrastructure/sqlite/`。現在の構造・依存規則は [ドメイン構造](../src/domains/README.md) を参照する。以前の節の `src/store/` などは移行前の記録。

- TypeScript ASTとモジュール解決による境界検査を追加。別ドメインの内部参照、宣言外の依存、共有契約による迂回、循環、純粋入口からSQLへの依存、所有者のないソースを拒否する。alias・再export・動的import・型importを含む回帰テストで検証した。
- Eumenesと同じoxfmt 0.71.0 / oxlint 1.86.0・共通設定を維持。`lint:fix`、`test:domain`、`verify --domain`、`verify:all` を追加した。引数なしのverifyも全体検証。
- 検証ごとの対象・ソースハッシュ・実ツール版・各段階の結果・所要時間を `verification-reports/` に記録する。途中のソース変更で失敗することと、検証失敗時にも記録することをテストした。
- パッケージ公開面の名前と既存3本の移行SQLは移動前と一致。既存fixtureの名前・内容も維持。移行SQLの登録漏れとSHA-256を継続検査する。
- 全体verifyは1,478件のテストで成功。State指定verify、Extraction単独の `test:domain` も成功。既存の忘却・復元・再採用・出典失効のシナリオを含む。

ホスト結合（H）と実モデル評価（E）の到達状態は変わらない。Eumenes本体のコード変更、時間評価・関連記憶の選択、公開Snapshotの更新は次段階。構造移行を機能改善の完了とは扱わない。
