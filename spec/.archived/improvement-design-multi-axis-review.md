# 改善設計（2026-11-06 多角評価の全指摘）

作成日: 2026-11-06。基準コミット: `5504945`。根拠: 同日の多角評価（技術品質 78.4 / 100）と、評価中に実 SQLite で再現した probe。本書は計画であり、製品コードはまだ変えていない。

正直さの規律: 各項目の根拠を **再現済み**（実 SQLite の probe で確認）／**読解のみ**（コードを読んだだけ、未再現）／**観測**（ファイル・ログ・CI の実物を確認）で区別する。読解のみの項目は、最初に再現試験を書き、失敗を確認してから直す。

> 同日、別の評価に基づく設計書が `spec/` に3つある（`improvement-design.md`、`improvement-design-2026-11-06.md`、`improvement-design-erasure-integrity.md`）。本書はそれらと独立に書いた。重複項目の統合と採否は利用者が判断する。

## 0. 目的・非目的・変えない原則

### 目的
1. 「忘却は派生先に届く」という中核の約束を、入力の形に依存せず守る（F1、F4）。
2. 忘却の計画・受領が、呼び出し元の許可範囲を超えた情報を開示しないようにする（F2）。
3. 忘却後に識別子が論理的に残らないようにする（F3）。
4. ホストの導入負担と誤用リスクを下げる（A1、A2、DOC）。
5. 保守性・配布・リポジトリ衛生・評価基盤を、本体の規模に見合う形に整える（A3、V、H、E）。

### 非目的
- 物理消去（SQLite の空きページ・WAL・バックアップ）の保証。既知の制限のまま。
- World / Consolidation の実装。
- 実 Eumenes 側の修正。追従が必要な点は §10 に書く。
- git 履歴の書き換え。

### 変えない原則
- 実行時依存ゼロ。`src/` の衛生規則（`JSON.parse` / `Date` / `process` / `Bun.` などの禁止、repository での transaction 制御の禁止）を守る。
- 同期 API。接続・transaction・時計・ファイル I/O はホストが所有する。
- migration は追記専用。0001〜0008 の本文と順序を変えない。
- 期待値を弱めて試験を通さない。語句やケース別の分岐を製品コードに入れない。

## 1. 改善項目一覧

重要度は High / Medium / Low。優先度は P1（最初に着手）〜P3。

| ID | 区分 | 内容 | 重要度 | 根拠 | 優先度 |
|---|---|---|---|---|---|
| F1 | 欠陥 | 非正規の SourceRef で引用した State が record の忘却閉包に入らない | Medium | 再現済み | P1 |
| F2 | 欠陥 | 忘却の計画・受領が、許可外の scope の派生物 ID と件数を開示する | Medium | 再現済み | P1 |
| F3 | 欠陥 | 忘却した State item に `subject`（`other:<名前>`）が残る | Low〜Medium | 再現済み | P1 |
| F4 | 欠陥 | 同値での本人確認（origin 昇格）で、確認の根拠と依存辺が保存されない | Low | 再現済み | P1 |
| F5 | 欠陥 | 墓標の主キーに principal が無く、出典 ID が principal 間で衝突すると誤拒否する | Low | 再現済み | P2 |
| Q1 | 疑い | `useRetainedRecord` がホスト時計の巻き戻りで未使用期限を短くしうる | Low | 読解のみ | P2 |
| Q2 | 疑い | evict が変更フィードに `inactive` を書き、deactivate と区別できない | Low | 読解のみ | P3 |
| Q3 | 疑い | state_item の忘却で、置き換え前の旧版（superseded）が残る | Low | 読解のみ | P2 |
| A1 | API・運用 | journal の I/O・fsync を含む参照ホスト実装が配布物に無い | — | 観測 | P2 |
| A2 | API | ホストが SourceKey を本体と同じ規則で作る公開関数が無い | — | 観測 | P1 |
| A3 | 保守性 | repository が 1 ファイル 1,000〜1,200 行 | — | 観測 | P3 |
| V1 | 検証 | `verify:package` が配布物の型宣言を利用者側で型検査していない | — | 観測 | P2 |
| V2 | 検証 | property 試験が非正規入力・scope 横断・昇格を生成しない | — | 観測 | P1 |
| V3 | 検証 | 同時に走った verify が `latest.json` を上書きしあう | — | 観測 | P3 |
| V4 | 配布 | CHANGELOG・版のタグ・semver 方針が無い | — | 観測 | P3 |
| P1 | 性能 | 性能の回帰を検出する仕組みが無い | — | 観測 | P3 |
| DOC1〜7 | 文書 | リンク不整合、配布物に無い文書への参照、README の混在、API 一覧、英語、用語集、仕様の明記 | — | 観測 | P2 |
| H1〜H6 | 衛生 | git 内の結果 JSON 11MB、`memory-check` 977MB、古い CI 対象ブランチ、残存ブランチ、git 外の採点スクリプト、巨大コミット | — | 観測 | P2 |
| E1〜E5 | 評価 | 回答評価が途中で停止、構造化レビューの悪化、独立した採点の欠如、実データ未評価、評価基盤の肥大 | — | 観測 | P2 |
| B1 | 運営 | 開発者1名（bus factor 1）で、引き継ぎの入口が無い | — | 観測 | P3 |

## 2. 決定が必要な事項

着手前に利用者が決める。推奨案を先頭に書く。**現時点ではすべて未決**。

| # | 論点 | 選択肢 | 推奨と理由 |
|---|---|---|---|
| D1 | 非正規の Memory 出典（F1） | (a) 拒否する ／ (b) 正規形へ補う | **(a)**。本体は推測せず拒否する方針で一貫している。補うと、ホストの誤りが見えないまま残る |
| D2 | scope をまたぐ忘却（F2） | (a) 伝播は維持し、開示を許可範囲に限る ／ (b) 許可外の scope に届くなら blocked ／ (c) 現状維持で文書化だけ | **(a)**。出典の忘却は、その出典からの派生物すべてに届くべき（プライバシーの要求）。(b) は本人の忘却要求を権限の都合で止めてしまう |
| D3 | 墓標の principal（F5） | (a) 出典 ID を principal ごとに一意にすることをホストに要求し、文書化する ／ (b) migration で主キーに principal を加える | **当面 (a)**。現在の Eumenes は単一 principal の想定で、データの漏洩や消去は起きない。複数 principal を実際に使う時点で (b) |
| D4 | 参照ホスト実装（A1） | (a) 試験済みの参照実装を tgz に同梱し、exports には入れない ／ (b) 新しい entry として公開 API にする ／ (c) examples のまま | **(a)**。「Eumenes が使わない機能は持たない」原則と両立し、他のホストの誤実装は減らせる |
| D5 | git 内の結果 JSON（H1） | (a) 新規分は git の外に置き、要約と SHA-256 だけ git に置く。既存分は HEAD から外す（履歴は残す） ／ (b) git LFS ／ (c) 別リポジトリ ／ (d) 現状維持 | **(a)**。追加の仕組みが要らず、再現性の証拠（hash）は残る |
| D6 | 英語の文書（DOC5） | (a) README 冒頭に英語の要約と quickstart だけ足す ／ (b) 全文を二言語化 ／ (c) 日本語のみ | **(a)**。外部公開の予定が無いなら維持費の小さい (a) で十分 |
| D7 | 実データでの評価（E4） | (a) 利用者の同意のうえ、ローカルだけで実会話の取得精度を測る ／ (b) 合成データのみ | 利用者の判断。外部 API へ実データを送る案は、明示の同意なしには採らない |

## 3. 欠陥の修正

### F1 非正規の SourceRef が忘却閉包から漏れる（再現済み・Medium）

**現象**
- `SourceRef.representation` は省略可能（`src/contracts/parse-input.ts:48`）。
- `captureRecord` した record を `{ namespace: "memory", kind: "record", id }` の形で、representation を省いて引用すると、`assertUserState` は `applied` を返す。
- 依存辺の SourceKey は `["memory","record",<id>,null]` になる（`src/contracts/source-key.ts`）。
- record を忘却しても、閉包の起点は正規形 `["memory","record",<id>,"text"]` の1本だけ（`src/domains/lifecycle/repository/index.ts:402`）。そのため item は閉包に入らず、`listState` が値を返し続ける。
- 同じ理由で、retention の保護判定（`src/domains/records/repository/retention.ts:264`）もこの引用を State 依存と見なさない。evict でその資料が消えうる。
- 以後の新規の assert は `hasTombstonedSource`（`src/domains/state/repository/index.ts:659`）が record id で止める。漏れるのは、忘却より前に作られた item だけ。

**再現手順**: `captureRecord` → 返った `ref` から `representation` を除いた引用で `assertUserState` → `planForget({type:"record"})` の `closure.counts.state_item` が 0 → `applyForget` 後も `listState` に値が残る。

**変更案（D1 = (a) の場合）**
1. `readSourceCore`（`src/contracts/parse-input.ts:32`）で、`namespace === "memory"` の SourceRef に次の3条件を要求する。満たさなければ `MemoryContractError("INVALID_VALUE", <path>)` で拒否する。
   - `kind === "record"`
   - `representation === "text"`
   - `id` が `isRecordId` を満たす
2. 生の SourceKey 文字列を受け取る入力にも同じ検査を入れる。
   - 対象: `host_source` の `sourceKey`（`src/domains/lifecycle/service/parse.ts:73`）と、ExternalDependent の `dependsOn` の source（`src/domains/lifecycle/service/external-parse.ts`）。
   - 規則: 文字列が `["memory",` で始まるなら、`recordIdOfSourceKey` が非 null であることを要求する。
   - `JSON.parse` は使わない（衛生規則）。前方一致と既存の正規表現で判定する。
3. 既存データの修復は migration 0009（§9）で行う。非正規の record キーを持つ依存辺と evidence 行を正規形へ書き換える。
4. 既存データの救済:
   - 修復前に、すでに忘却済みの record を非正規の形で引用していた active な item は、残ったままになる。
   - 検出用の SQL を host-guide に載せる（`memory_state_evidence` で namespace が `memory`、representation が NULL の行のうち、record の墓標を持つもの）。
   - 1件以上あった場合に限り、ホストが該当する忘却 entry を再適用できる経路を用意する。`reconcileForgetJournal` に1回限りの全再適用 option を足す案を第一候補にする。
   - **要確認**: 再適用の `createdBefore` 制約で、忘却後に作られた item を巻き込まないこと。
   - 実 Eumenes の DB で該当が0件なら、救済の経路は作らない。

**互換性**
- 受け付ける入力を狭める変更。ただし、狭める対象は欠陥を起こす形だけ。
- 契約版は上げず、リリースノートに書く。Eumenes が `captureRecord` の `ref` をそのまま使っていれば影響しない（**要確認**）。

**受入条件**
- 上記の再現手順が、修正前に失敗し、修正後に `MemoryContractError(INVALID_VALUE)` になる試験を加える。置き場所は `src/domains/state/test/` と `test/scenario/forget-closure.test.ts`。
- `host_source` と ExternalDependent の非正規キーの拒否試験を加える。
- migration 0009 の試験: 版 8 の DB に非正規の辺を作り、適用後に record の忘却が item に届く。

### F2 許可外の scope の情報を開示する（再現済み・Medium）

**現象**
- 同じ SourceKey を scope s1 と s2 の item が引用している。
- `scopeKeys: ["s1"]` だけの access で `planForget({type:"host_source", scopeKey:"s1"})` を呼ぶと、次の結果になる。
  - `closure.counts.state_item = 2`
  - `externalDependents` に s2 の外部派生物 `vec:secret-doc-in-s2` が出る
  - 適用後、同じ access の `getForgetReceipt` も s2 の外部派生物を返す
- 原因の箇所:
  - 閉包は principal だけで絞っている（`collectClosure`、`src/domains/lifecycle/repository/index.ts:153`）。
  - 開示の検査は対象 scope だけを見る（`planForget` :489、`forgetVisibility` :958、`getForgetReceipt` :987、`recordExternalDeletion` :1006）。
- 補足: scope の忘却は、他 scope が引用する出典を巻き込まない設計（`resolveForgetSet` の scope 節）。host_source の忘却が scope をまたいで伝播するのは、「この出典を全部忘れる」という意味として妥当。問題は開示の範囲。

**変更案（D2 = (a) の場合）**
1. 伝播は維持する。閉包の計算と `applyForget` の挙動は変えない。
2. `planForget`:
   - `resolveForgetSet` が持つ各 node の scope（`scopeOf`）で、node を許可内と許可外に分ける。
   - `closure.counts` と `externalDependents` は、許可内の node だけで数え、列挙する。
   - `closure.outsideAccess: boolean` を加える。許可外の node が1件以上あれば true。件数と ID は出さない。
   - journal の `entry` は target だけで閉包を含まないので変えない。
3. `getForgetReceipt` / `recordExternalDeletion`:
   - 外部削除の行を scope で絞る。scope は、同じ `forget_id` の `memory_tombstone(target_type='external')` の `scope_key` と結合して得る（**要確認**: external の墓標が全件 scope 付きで書かれていること）。
   - 結合できない旧行は、従来どおり「全 target scope の許可」で扱う。
   - `recordExternalDeletion` は、許可外の scope の行を更新しようとすると `not_permitted` を返す。
   - receipt の集約状態（`external`、`completed`）は全行で計算する。完了の判定を許可範囲で変えると、未削除なのに完了に見えるため。あわせて `outsideAccess` を返す。
4. 外部削除を実行するホストの worker は、principal の全 scope を持つ access で receipt を読む運用にする。host-guide に明記する。

**互換性**: `ForgetPlan` と `ForgetReceipt` への任意フィールドの追加と、開示範囲の縮小。許可を全 scope で渡している現行ホストの見え方は変わらない。

**受入条件**
- 狭い access の plan と receipt に、許可外の ID と件数が出ない試験。
- 全 scope の access なら従来どおり全件が出る試験。
- 許可外の行に対する `recordExternalDeletion` が `not_permitted` になる試験。
- 伝播そのもの（s2 の item が forgotten になる）を維持する試験。

### F3 忘却後に `subject` が残る（再現済み・Low〜Medium）

**現象**: `scrubStateItem`（`src/domains/state/repository/index.ts:1001`）は `semantic_key` と `value_text` を消すが、`subject` は消さない。`other:Alice Smith` のような自由文字列（最大 128 bytes）が、忘却後も行に残る。

**変更案**
- `scrubStateItem` の UPDATE に `subject = CASE WHEN subject = 'self' THEN 'self' ELSE 'other:' END` を加える。`self` は個人を識別しないので残す。
- 制約との整合: CHECK（`subject = 'self' OR subject LIKE 'other:%'`）、active 限定の一意索引、`readSubject` の前方一致のいずれにも違反しない。
- 既存の忘却済みの行は migration 0009 で同様に書き換える。
- 0003 / 0007 の消去規約の JSDoc と host-guide に、消す列の一覧を明記する。

**受入条件**
- 忘却後の全 `memory_*` 表に subject の原文が残らない試験。既存の `tablesContain` で走査する。
- 版 8 の DB に migration 0009 を適用すると消える試験。

### F4 本人確認の根拠が保存されない（再現済み・Low）

**現象**
- `agent_inferred` の item に、別の出典を根拠として同じ値を `user_confirmed` で assert すると、`promoteOrigin`（`src/domains/state/service/reducer.ts:203`）が origin だけを上げる（revision+1）。
- `assertUserState` は `persist` に `replacedEvidence = null` を渡す（`src/domains/state/repository/index.ts:800`）。`writeItem` は null のとき evidence を触らない（:558）。
- 結果として、確認に使った出典の evidence と依存辺は保存されない。その出典を忘却しても item は閉包に入らず、根拠を失った `user_confirmed` として残る。

**変更案**
- 昇格のとき（遷移が既存 item への `edit` で、origin だけが変わる場合）に限り、新しい evidence を既存の evidence へ**追記**する。
  - 追記分の idx は既存の続き、role は `support`。
  - 同じ (source_key, range) の重複は追記しない。
  - 置き換えではなく追記にするのは、元の推定の出典を忘却したときにも item へ届くようにするため。
- 追記後の件数が `LIMITS_STATE.maxEvidencePerItem`（8）を超える場合は、新しい reasonCode `EVIDENCE_LIMIT_EXCEEDED` で拒否する。辺を落とすと閉包が欠けるので、切り詰めない。
- 同じ origin の `unchanged`（同値の再確認）では、従来どおり新しい根拠を保存しない。既存の根拠で値は支えられているため。この挙動は契約の JSDoc に明記する。

**互換性**: `StateReasonCode` に1語を追加する。網羅的な switch を書いたホストでは型エラーになりうるので、リリースノートに書く。

**受入条件**
- 昇格後に確認の出典を忘却すると、item が forgotten になる試験。
- 元の推定の出典を忘却しても forgotten になる試験。
- 上限超過の拒否試験。

### F5 墓標が principal をまたぐ（再現済み・Low）

**現象**
- `memory_tombstone` の主キーは `(target_type, target_id)` で、principal を含まない（`src/infrastructure/sqlite/migrations/0001-foundation.ts:58`）。
- `isTombstoned`（`src/infrastructure/sqlite/tombstone.ts:8`）も principal を見ない。
- record と state item の ID は principal を含む hash なので衝突しない。衝突しうるのは host の出典と external の ID。
- principal p1 が出典を忘却すると、同じ SourceKey を使う p2 の `assertUserState` は `SOURCE_TOMBSTONED`、`registerExternalDependents` は `TOMBSTONED` になる。
- 閉包は principal で絞られているので、データの漏洩や消去は起きない。起きるのは誤拒否と、存在の信号だけ。

**変更案**
- D3 = (a) の場合: host-guide の「出典 ID」の節に「出典の id は principal ごとに一意にする（例: id に principal を含める）」と書く。
- D3 = (b) の場合:
  - migration で `memory_tombstone` を `(principal, target_type, target_id)` 主キーで作り直す。手順は 0007 と同じ。
  - `isTombstoned` の呼び出し 14 箇所に principal を渡す。
  - no_resurrection の trigger を見直す（state_item の ID は principal 付きなので、現状のままで正しい）。

**受入条件（(b) の場合）**: 別 principal の同一 SourceKey が拒否されない試験と、同一 principal では従来どおり拒否される試験。

## 4. 未確認の疑い（最初に再現試験を書く）

| ID | 疑い | 確認方法 | 確認できた場合の変更案 |
|---|---|---|---|
| Q1 | `useRetainedRecord` は `idle_expires_at_ms = clock.atMs + idleTtl` で上書きする（`src/domains/records/repository/retention.ts:208`）。ホスト時計が巻き戻ると期限が短くなる | 時計を戻して use し、期限が縮むことを試験で確認する | `MAX(現在値, 新しい値)` で単調にする。`last_used_at_ms` も同様 |
| Q2 | evict が変更フィードに `status: "inactive"` を書く（同 :302）。購読側は deactivate と区別できない | 現在の購読者（Eumenes）が区別を必要とするかを確認する | 必要なら external 契約の版を上げて `evicted` を加える。不要なら、外部契約の JSDoc に「Records の `inactive` は evict を含む」と明記する |
| Q3 | state_item を target にした忘却は、その item と派生物だけを消し、置き換え前の旧版は残る | 置き換え後に新版だけを忘却し、旧版の値が `readStateFact` / `listState({includeInactive})` に残るかを試験する | 契約上は、ホストが `readStateFact` で全版を集めて忘却する前提（`src/domains/state/contracts/index.ts` の `ReadStateFactInput` の JSDoc）。挙動は変えず、host-guide の忘却の節にも明記する。1回の plan で複数 target を渡せるかは、別設計書の論点と合わせて決める |

## 5. API・構造

### A2 SourceKey を作る公開関数（P1、F1 と同時）
- `src/contracts/source-key.ts` の `sourceKey` を、`sourceKeyOf(ref)` として `eumenes-memory` から公開する。純粋関数で、衛生規則に抵触しない。
- host-guide に「`host_source` の `sourceKey` は `sourceKeyOf` で作る。引用と忘却で representation の有無を揃える」と書く。手書きの `JSON.stringify` による不一致（空白、representation の欠落）を防ぐ。
- 受入: public-surface 試験の公開名一覧に追加する。consumer 試験で `sourceKeyOf` から作ったキーで host_source を忘却し、閉包が届く。

### A1 参照ホスト実装（P2、D4 = (a) の場合）
- 元にするもの: `examples/standalone/host.ts` と `test/runners/fake-eumenes-host.ts`。
- 実装する範囲は次のとおり。
  - 単一 Writer と read snapshot transaction
  - `inTransaction` の提供
  - journal の追記（ファイルと directory の fsync を含む）
  - 起動手順（`checkHostMigrations` → 未適用 SQL → `assertMemorySchema` → `reconcileForgetJournal`）
  - 忘却の流れ（`planForget` → journal 追記 → `applyForget`）
- 置き場所: `src/` の外の `reference-host/`。src の衛生規則の対象外とし、boundaries は「公開 entry だけを import」に限る。
- tgz の `files` に含めるが、`exports` には入れない。docs に「API の保証外。写して使う参照」と明記する。
- 受入: Bun と Node（`node:sqlite`）で、保存・忘却・古い DB の復元・journal の破損の各シナリオを通す試験。既存の `test/runners` の再利用を優先する。

### A3 repository の分割（P3、F1〜F4 の取り込み後）
- `src/domains/lifecycle/repository/index.ts`（1,218 行）を次の単位に分ける。
  - `closure.ts`: `collectClosure` / `resolveForgetSet`
  - `plan.ts`
  - `apply.ts`: `applyEntry` / `applyForget` / `reconcileForgetJournal`
  - `external.ts`: register / unregister / `recordExternalDeletion` / `refreshForgetExternalState`
  - `receipt.ts`
- `src/domains/state/repository/index.ts`（1,085 行）を `read.ts` / `write.ts` / `scrub.ts` に分ける。
- 挙動は変えない。受入: 既存の全試験、public-surface、boundaries が無修正で通る。

## 6. 検証・配布

| ID | 変更 | 受入条件 |
|---|---|---|
| V1 | `scripts/verify-package.ts` に、展開した tgz を使う利用者 TypeScript プロジェクトの `tsc --noEmit` を加える（`moduleResolution` が `nodenext` と `bundler` の2通り、`skipLibCheck: false`）。評価時に手作業で両方の解決を確認済み | わざと型エラーを入れた負例が失敗し、正例が通る |
| V2 | `test/scenario/forget-property.test.ts` の生成器を拡張する。(1) record の引用で representation をランダムに省く（F1 修正後は拒否を期待）、(2) 複数 scope が同じ出典を共有するグラフ、(3) 推定から本人確認への昇格を混ぜる。oracle は、独立した素朴な BFS のまま scope 横断を含める | 固定 seed で決定的。F1・F2・F4 の修正前のコードでは失敗する seed が存在する |
| V3 | `scripts/verify.ts` に、`verification-reports/` の排他ロック（作成時に既存なら失敗する方式）を加える。評価中、別プロセスの verify が同時に走り、`latest.json` を後から上書きした（CI はこのファイルを成果物として上げる） | 同時に起動した2つ目が、明示的なエラーで停止する |
| V4 | `CHANGELOG.md` を置き、tgz を作るたびに `v<version>` の tag を打つ。0.x の間は「minor は契約・schema の変更、patch は欠陥修正」と決める。`dist/release-manifest.json` の基準 commit と tag を対応させる | `verify:package` が manifest の commit と tag の一致を検査する |
| P1 | `bench:memory` に上限を宣言する。目安は、1000件で warm read の p95 < 10ms、出典からの忘却の p95 < 200ms、書き込みの p95 < 200ms（既存の `budgetMs`）。CI の計時は揺れるので、ローカル実行の検査にとどめる | 上限超過で非0終了。現状の実測（read p50 2.3ms、忘却 p50 57ms、write p50 0.18ms）で通る |

## 7. 文書

| ID | 変更 |
|---|---|
| DOC1 | `README.md:47` のリンク文言は `src/infrastructure/sqlite/README.md` だが、リンク先は `docs/host-guide.md#startup`。文言をリンク先に合わせる |
| DOC2 | `src/sqlite.ts:5` の JSDoc は `dist/sqlite.d.ts` として配布されるのに、tgz に入らない `src/infrastructure/sqlite/README.md` と `migrations/README.md` を参照している。`docs/host-guide.md#startup` を参照するように変える |
| DOC3 | README を利用者向けと開発者向けに分ける。利用者向けは、目的、導入、最小例、公開面、既知の制限。開発者向けは `docs/development.md` へ移す（verify、実験、seed、API 予算） |
| DOC4 | 公開関数ごとの一覧表を作る。列は、必要な transaction（read / write）、必須入力、戻りの status、reasonCode。public-surface 試験で「全 export が表に載っている」ことを検査する |
| DOC5 | （D6 = (a)）README 冒頭に英語の要約と quickstart を足す |
| DOC6 | host-guide に次の仕様を明記する: scope 横断の忘却の方針と開示範囲（F2）、旧版の扱い（Q3）、representation の一貫性と `sourceKeyOf`（F1、A2）、出典 ID の principal 一意性（F5）、忘却で消える列（F3）、F1 の既存データの検出 SQL |
| DOC7 | 用語集を作る（閉包、墓標、receipt、journal、principal、scope、origin、retention）。host-guide の冒頭からリンクする |

## 8. リポジトリ衛生・評価基盤・運営

### 衛生

| ID | 観測 | 変更案 |
|---|---|---|
| H1 | `examples/*/results/*.json` が git に約 11MB ある（最大 3.7MB） | （D5 = (a)）新規の結果は `verification-reports/` 側に保存し、git には要約と SHA-256 だけを置く。既存分を HEAD から外すかは D5 で決める |
| H2 | `verification-reports/memory-check/` が 270 実行・977MB に増え続けている。`pruneReports`（`scripts/verify.ts:56`）は最上位の verify 報告しか削除しない | standalone の runner に、suite ごとに新しい N 件を残す削除を加える。`pruneReports` を再利用する |
| H3 | CI の push 対象に `codex/quality-80` が残っている（`.github/workflows/verify.yml:5`） | main へ取り込み済みなら対象から外す |
| H4 | ローカルに `codex/memory-adoption`、`codex/memory-evidence-followup`、`codex/memory-representation`、`codex/quality-80` が残っている | 削除は利用者が判断する。本書では一覧化だけ |
| H5 | 評点の集計スクリプト（`verification-reports/quality-80/build-review.py`、`model-metrics.py`）が、git の無視ディレクトリにある | `scripts/eval/` へ移して版管理し、評点を git から再計算できるようにする |
| H6 | 10万〜13万行のコミットがある（結果 JSON とコードが同じコミット） | 結果データとコードを別コミットにし、1コミット1関心にする（運用規則として CONTRIBUTING に書く） |

### LLM 込みの品質と評価基盤

| ID | 観測 | 変更案 |
|---|---|---|
| E1 | 自然文回答の評価が予算で停止した（30/80 生成、29 件の相互採点、根拠のない断定が1件以上） | 利用者が追加予算を承認した場合に限り、新しい台帳で残りを完了する。目標は「根拠のない断定 0 件」。既存の結果は書き換えない |
| E2 | 構造化レビューが 81/90 から 75/90 に悪化した | 次の指示変更より先に、失敗 15 ケースを family 別に原因分析する。改善案は既存の事前登録の手順で比較する |
| E3 | 判定の裁定を実装者と同じエージェントが行っている | 回答 20 件程度を、実装者以外が盲検で判定する標本を設ける。モデル2つの一致を正解とは扱わない |
| E4 | 評価は合成データだけ | （D7 で決める）同意のうえ、ローカルで実会話の取得精度を測る |
| E5 | 評価基盤（examples 約 1.86 万行）が本体（src 約 8.7k 行）の2倍ある | 置き換えた実験のコードは削除し、要約と hash だけを残す。新しい実験は凍結プロトコルの共通部品だけで書く。基盤が更に増えるなら、別パッケージ（例: `eval/` から別リポジトリ）へ分ける |

### 運営

- B1: `CONTRIBUTING.md` を置き、次の3点を書く。1ページで読める設計判断の索引（`spec/` の各文書の要点と現状）、verify の通し方、変えてはいけない原則（§0）。

## 9. migration 0009（必要になった場合だけ追記）

F1（D1 = (a)）と F3 を採るなら、1本の追記 migration にまとめる。`MEMORY_DB_SCHEMA_VERSION` は 8 から 9 になる。

1. **依存辺の正規化**
   - 対象: `memory_dependency` で `dependency_type = 'source'` かつ `dependency_id LIKE '["memory","record","rec:%",null]'` の行。
   - 正規形の行を `INSERT ... SELECT ... ON CONFLICT DO NOTHING` で入れてから、非正規の行を削除する。`OR IGNORE` は CHECK 違反まで無視するので使わない（`spec/verification-status.md` §4）。
2. **evidence の正規化**: `memory_state_evidence` で `namespace = 'memory'`、`kind = 'record'`、`representation IS NULL` の行を、`representation = 'text'` と正規の `source_key` に更新する。
3. **subject の消去**: `UPDATE memory_state_item SET subject = 'other:' WHERE status = 'forgotten' AND subject <> 'self'`。
4. **非正規キーの墓標**: `target_type = 'source'` の行は消さずに残す（拒否が増えるだけで害は無い）。record の墓標がすでにあるかを試験で確認する。

試験は `src/infrastructure/sqlite/test/` に置く。版 8 の DB（非正規の辺、忘却済みで subject 付きの行、過去の忘却記録を含む）に適用し、その後の読み取り・忘却・ジャーナルの照合を通す。`remove-extraction-migration.test.ts` と同じ形にする。F5 で (b) を採る場合は、別の migration 0010 にする。

## 10. 実施順序とワークストリーム

| 段階 | 内容 | 書き込み範囲 | 並列 |
|---|---|---|---|
| 0 | D1〜D7 の決定 | — | — |
| 1a | F1、F3、F4、A2、V2 の F1/F4 部分 | `src/contracts/{parse-input,source-key}.ts`、`src/domains/state/**`、`src/domains/lifecycle/service/{parse,external-parse}.ts`、対応する試験 | 1b と並列可 |
| 1b | F2、V2 の scope 横断部分 | `src/domains/lifecycle/repository/index.ts`、`src/domains/lifecycle/contracts/index.ts`、`src/domains/lifecycle/test/**`、`test/scenario/forget*.test.ts` のうち F2 の分 | 1a と並列可 |
| 1c | migration 0009、migration の登録、`MEMORY_DB_SCHEMA_VERSION`、`src/index.ts`、public-surface | 共有ファイル。1a・1b の完了後に1人で編集する | 不可 |
| 2 | Q1〜Q3 の再現試験と修正、V1、V3、DOC1・DOC2・DOC6 | 各項目のファイル | 項目間は並列可 |
| 3 | A3 の分割、A1、DOC3〜DOC5・DOC7、V4、P1 | 分割は段階1の取り込み後に単独で行う | A3 は単独 |
| 4 | H1〜H6、E1〜E5、B1 | `examples/`、`scripts/`、`.github/`、文書 | 項目間は並列可（E1 は予算の承認後） |

各段階の終わりに `bun run verify:all` と `bun run verify:package` を通す。段階1の取り込み後に、独立したレビューを1回行う。

**Eumenes 側で確認が必要な点（本リポジトリでは直さない）**
- record を引用するとき、`captureRecord` の `ref` をそのまま使っているか（F1 の影響範囲）。
- `host_source` の SourceKey をどう作っているか（A2 の `sourceKeyOf` への置き換え）。
- 外部削除の worker が全 scope の access を使えるか（F2）。
- 版 9 の migration を追記する手順。

## 11. 完了判定

- F1〜F4 について、修正前に失敗し修正後に通る試験がある。F5 は D3 の決定どおりに対応している。
- Q1〜Q3 は、再現試験の結果（再現した／しなかった）を本書に追記し、再現したものは修正済み。
- `verify:all`、`verify:package`（V1 を含む）、`check:memory` が、変更後の固定ソースで通る。検証中にソースが変わっていない。
- host-guide と README が実装と一致している（DOC1・DOC2・DOC6 は必須）。
- 同じ観点で再評価し、技術品質の点と残った指摘を記録する。点数を上げるために、対象を狭めたり期待値を変えたりしない。
