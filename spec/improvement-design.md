# 改善設計（2026-11-06。同日の4つの設計書を統合）

基準コミット: `5504945`（本リポジトリ）、Eumenes `2c2ac893`。本書が唯一の作業計画で、次の4つを統合した。元の文書は `spec/.archived/` に移した。

- `improvement-design-host-burden.md`（本書の統合前の版。ジャーナル1本化などの詳細設計）
- `improvement-design-2026-11-06.md`（以下「設計1」）
- `improvement-design-erasure-integrity.md`（「設計2」）
- `improvement-design-multi-axis-review.md`（「設計3」）

## 0. 採否の基準

利用者の指示（2026-11-06）: 原則は推奨どおり。ただし余計なロジックは入れず、効果のあるものだけを採る。本書ではこれを次のように適用した。

- **採る**: 次のどちらかに当たり、変更が小さいもの。
  - 再現した不具合で、Eumenes の使い方で結果が変わるもの。
  - 本体の約束（忘却が派生物に届く、通常の Records は消えない）が黙って破られるもの。直し方は、呼び出し時のエラーに変える検査1つか、SQL の1文の変更に限る。
- **採らない**: 次のどれかに当たるもの。
  - Eumenes では起きない状況のための新しい分岐・旧形式の読み替え・モード・migration。
  - 計測や検査の仕組みを増やすだけのもの。
  - 文書の量を増やすだけのもの。
- **文書だけ**: ホストの責任として書けば足りるもの。1〜2行で書く。

CI に関する改善は対象外（利用者の指定）。

変えない原則: 本体は接続・transaction・ファイル I/O・グローバル状態を持たない。Eumenes が使わない機能は持たない。migration は追記専用。ジャーナルの所有はホスト。

## 1. 実施済み（2026-11-06）

| 項目 | 内容 |
|---|---|
| 文書の訂正 | 忘却の plan・ジャーナルへの追記・apply は、単一 Writer の同じ write transaction で行う（`spec/full-system-design.md` §2.5、`docs/host-guide.md`、`src/infrastructure/sqlite/README.md`） |
| `inTransaction` の必須化 | `MemoryDb.inTransaction` は必須。`true` 以外は `NOT_IN_TRANSACTION`（設計1 WS4 と同じ） |
| 忘却の契約版 2 | `planForget` は同じ scope の複数 target と、ホストの忘却意図 `hostIntent` を受ける。journal format 2 で `hostIntent` を hash の鎖に含める。`reconcileForgetJournal` は今回適用した entry の `hostIntent` を `hostIntentsToReapply` で返す。契約版 1 の呼び出しは従来どおり |
| ジャーナルの1本化（Eumenes） | block journal を廃止し、忘却1回を忘却ジャーナルの1行にした（fsync 1回）。既存の block journal は起動時に1回だけ取り込み、`*.blocks.jsonl.imported` に移す |
| パッケージ | 0.0.3（この時点。§5 の作業で 0.0.4 に更新）。Eumenes の vendor に取り込み済み。Eumenes 側は commit `ed0b602e` に入っている（本セッションではコミットしていない） |
| 別セッションの実施分（未コミット） | 試験出力のノイズの除去（設計2 IMP-07）、追跡ファイルの大きさの検査（IMP-08）、合成 seed への切り替え（IMP-09 の一部） |

検証: ライブラリの試験（下記の再現試験を除く）、fixture、配布物の Bun・Node consumer、Eumenes の記憶に関係する試験 112 ファイル 577 件。独立レビューの Medium 1件・Low 5件を修正済み。

## 2. 採用する残作業

同じファイルを触るので1人で順に行う。最後にパッケージを 0.0.4 にし、Eumenes の vendor を更新する。Eumenes のコード変更は要らない見込み。

### R-1 復元後の ID 衝突を避ける（設計1 WS1 手順4、設計2 IMP-04。Eumenes に効果あり）

- 問題: State item の ID は `H(principal, scope, 作成した操作の seq)`。古い DB を復元すると seq が巻き戻り、reconcile が付け直した墓標の ID と、新しい保存の ID が一致する。保存が `MemoryStoreError(TOMBSTONED)` で失敗する。Eumenes は手動バックアップからの復元を想定している。
- 変更: `assertUserState` で新しい item の ID を決める前に、その ID に墓標があるかを見る。ある間は `issueSeq` で次の seq を取り直す。ID の式とスキーマは変えない。
- 受入: `test/scenario/forget-integrity.test.ts` の IMP-04 の試験が通る（修正前は失敗する）。

### R-2 本人確認の根拠を保存する（設計3 F4。Eumenes に効果あり）

- 問題: `agent_inferred` の item を同じ値で `user_confirmed` にすると、origin だけが上がる。確認に使った出典の evidence と依存辺は保存されない。
  - Eumenes は、記憶を忘れるときにその根拠の発言を会話から隠す。確認の発言が根拠に無いので、記憶を忘れても確認の発言は隠れずに残る。
- 変更: 格上げ（origin だけが変わる edit）のときに限り、新しい evidence を既存の evidence に追記し、依存辺（`support`）を足す。同じ出典・同じ範囲の重複は足さない。
  - 格上げは1つの item で一度しか起きないので、件数は入力の上限（8）の2倍を超えない。件数の検査と新しい reasonCode は足さない。
- 受入:
  - 格上げのあとで確認の出典を忘れると、item が forgotten になる。
  - 元の推定の出典を忘れても forgotten になる。
  - 同じ origin の再確認（`unchanged`）では evidence が増えない。

### R-3 memory record の出典で `representation` の省略を拒否する（設計2 IMP-01 (a)、設計3 F1・D1 (a)）

- 問題: `representation` を省いた memory record の出典で State を保存すると、依存辺の鍵が record の忘却の鍵とずれる。その record を忘れても State の値が黙って残る。Eumenes は常に `"text"` を渡している。
- 変更: 入力の読み取り（`src/contracts/parse-input.ts`）で、memory record の出典に `representation` が無ければ契約エラー（`MISSING_KEY`）、`"text"` 以外なら `INVALID_VALUE` にする。補完しない。
- 採らない部分: 旧形式の辺の読み替え（設計2 IMP-01 (b)。該当する行は Eumenes に無い）、Records 表での照合（同 (c)。Eumenes は State の根拠に memory record を使っていない）。
- 受入: 省略・`"html"` がそれぞれ契約エラーになる。`"text"` の既存の試験は変わらず通る。

### R-4 retention 中の origin への `captureRecord`（設計2 IMP-02）→ 文書のみに変更

- 実装してみると、retention 中の資料を外部へ送ったことは、同じ本文の `captureRecord`（`providerRef` つき）で記録する決まりで、拒否するとこの正規の経路まで止まった（`test/consumer/retention.test.ts` の既存試験）。
- 正規の経路と消失を起こす経路を分けるには、本文が変わったかを判定する分岐が要る。Eumenes はどちらも使っていないので、採否の基準により採らない。コードは変更前に戻した。
- 代わりに R-6-6 で、`retainRecord` した origin を永続化するときの手順を書く。

### R-5 忘却した item の `subject` を消す（設計1 WS3、設計3 F3）

- 問題: 忘却後も `subject` に `other:<名前>` が残る。Eumenes は他人の記憶を書かないので、現在は該当しない。
- 変更: `scrubStateItem` の UPDATE に `subject = CASE WHEN subject = 'self' THEN 'self' ELSE 'other:' END` を足す（CHECK を満たす）。既存の忘却済み行の一括 migration は作らない。
- 受入: `other:Alice` の item を忘れたあと、どの `memory_*` 表にも `Alice` が残らない。

### R-6 文書（ロジックなし）

`docs/host-guide.md` に、次をそれぞれ1〜2行で書く。

1. ジャーナルのハッシュの鎖は鍵なしで、偶発的な破損・切り詰め・食い違いを検出する。悪意のある書き換えの防止はホストの責任（設計1 L1）。これまでの文書の「改ざんを検出」の表現も直す。
2. 本体は単一 principal を前提に検証している。墓標は principal をまたいで効く（設計2 IMP-05・設計3 F5 の文書部分）。
3. state_item の忘却はその item と派生物だけに届く。置き換え前の版も忘れるときは、`readStateFact` で全版を集めて targets に渡す（設計3 Q3。Eumenes は実施済み）。
4. `planForget` / `getForgetReceipt` が返す件数と外部派生物は、同じ principal の閉包全体で、対象の scope に限らない（設計3 F2）。
5. `applyForget` に渡すのは `planForget` が返した entry だけ。入力は JSON 由来の plain なデータ（設計1 M3、設計2 IMP-03）。
6. R-3 の契約と、R-4 の手順（retain した origin を永続化するときは、先に `recordId` を指定して evict してから `captureRecord` する）。

### R-7 実データの seed の削除（設計2 IMP-09・D5 案B）

- 合成 seed への切り替えは済んでいる。`examples/seeds/data/codex-user-50.jsonl` を作業ツリーから消す。参照は残っていない。git の履歴は書き換えない。

### R-8 別セッションが残した再現試験の整理

- `test/scenario/forget-integrity.test.ts` は、採らない項目（IMP-01 の旧形式の読み替え、IMP-05、IMP-06）の試験も含んでいる。それらを削り、R-1・R-3 の試験だけを残して整形する。
- `test/consumer/retention.test.ts` の IMP-02 の試験は、R-4 を採らないので取り除く。
- これで `bun run verify` が通しで通る状態に戻す。

## 3. 採用しないもの

| 項目 | 出典 | 理由 |
|---|---|---|
| retention 中の origin への `captureRecord` の拒否 | 設計2 IMP-02 | 外部送付の記録という正規の経路まで止まる。分けるには本文の変化を判定する分岐が要る（R-4） |
| 墓標を principal ごとにする migration 0009 | 設計1 WS1、設計3 F5 (b) | Eumenes は単一 principal。実 DB の表の作り直しが要る。R-6-2 の文書で足りる |
| 計画時の存在検査（IMP-05 案A） | 設計2 | 単一 principal では効果が無い。Eumenes は存在を確かめてから計画している |
| 置き換え前の版を本体が自動で target に足す | 設計2 IMP-06 | Eumenes は全版を渡している。自動で足すと、版の多い事実の忘却が target の並び順しだいで `ARRAY_TOO_LONG` になる。R-6-3 の文書で足りる |
| `applyForget` の権限検査 | 設計1 WS2（M3） | 単一 principal・単一ホストでは効果が無い。API の変更が要る |
| 許可外の scope の開示の絞り込み | 設計3 F2 | 開示先は同じホスト。絞り込みのロジックが増える。R-6-4 の文書で足りる |
| reconcile の entry の厳格な parser の残り | 設計2 IMP-03 | 未知のキーと `hostIntent` は実施済み。getter・Proxy は README で対象外と明記している |
| 空・逆転の範囲、retention の例外変換、期限を縮めない | 設計1 WS5（L3・L4）、設計3 Q1 | Eumenes の World は範囲を事前に検査している。retention は再生成可能な資料で、影響は小さい |
| evict の変更フィードの区別 | 設計3 Q2 | 購読者（Eumenes）は区別を必要としていない |
| 参照ホスト実装の同梱 | 設計3 A1 | 唯一のホストの Eumenes は実装済み |
| SourceKey を作る公開関数 | 設計3 A2 | R-3 で省略を拒否すれば、ずれは起きない |
| エラー処理の網羅表と文書試験、README の書き直し、CHANGELOG、英語の文書 | 設計1 WS6・WS9、設計3 DOC・V4 | 文書の量が増えるだけ。変更点は Eumenes の `docs/memory.md` と本書に記録している |
| 並行性・途中失敗の試験、property の seed、配布物の型宣言の検査、検査ツールの改名、カバレッジの関門 | 設計1 WS10・WS11、設計3 V1〜V3 | 検査の仕組みが増えるだけで、挙動は変わらない。Eumenes は型宣言で型検査している |
| スキーマ検査の費用の計測 | 設計1 WS8 | 問題の兆候が無い |
| LLM 評価の集計・予算・命名 | 設計1 WS12、設計3 E1〜E5 | 製品の挙動に関係しない。有料 API を呼ばない方針は変わらない |
| repository の分割 | 設計1 WS7、設計2 IMP-11、設計3 A3 | 挙動は変わらず、差分が大きい |
| 結果 JSON の移動 | 設計1 WS13、設計3 D5 | 既存は文書と試験が参照している。新規は IMP-08 の検査で防いでいる |
| Eumenes の矛盾確認（F4）・新規保存の上書き（F1） | 統合前の本書 D2 | F1 は seed の取り込みと重なったときだけ起きる。F4 は製品の機能追加で、本書の範囲外 |

## 4. 範囲外（必要になったときに別の計画で行う）

- Eumenes の稼働中の定期バックアップと復元コマンド（設計1 §8.3）。手順を作るときは、戻さない・消さないファイルを「忘却ジャーナルと `*.blocks.jsonl.imported`」とする（block journal は廃止した）。
- 複数 principal への対応（migration 0009）。

## 5. 実施記録

2026-11-06 実施。コミットはしていない。

| 項目 | 結果 |
|---|---|
| R-1 | `assertUserState` で、新しい item の ID が墓標とぶつかる間は seq を取り直す（`src/domains/state/repository/index.ts`） |
| R-2 | 格上げのとき、確認の evidence を既存の evidence に追記する（`appendEvidence`）。修正を外すと3件の試験が失敗することを確認した |
| R-3 | memory record の出典で `representation` が無ければ `MISSING_KEY`、`"text"` 以外なら `INVALID_VALUE`（`src/contracts/parse-input.ts`） |
| R-4 | 採らない（§2 R-4）。コードは変更前に戻し、手順を文書にした |
| R-5 | 忘却時に他人の `subject` を `other:` にする（`scrubStateItem`） |
| R-6 | `docs/host-guide.md` に前提5点と retain した origin の永続化の手順を追記した。鍵なしの鎖について、「改ざん」の表現を本リポジトリの文書・JSDoc と Eumenes の `docs/memory.md` で直した |
| R-7 | `examples/seeds/data/codex-user-50.jsonl` を作業ツリーから削除した（履歴は残る） |
| R-8 | `test/scenario/forget-integrity.test.ts` を R-1・R-2・R-3・R-5 の7件に絞った。`test/consumer/retention.test.ts` の IMP-02 の試験を取り除いた |
| 版 | 0.0.4（`artifacts/eumenes-memory-0.0.4.tgz`、sha256 `9c0e85aa2fa3…`）。Eumenes の vendor・`package.json`・`bun.lock`・`manifest.json`・`docs/memory.md` を更新した |

検証:

- 本リポジトリ: `bun run verify` が通しで通った（試験 837 件、失敗 0）。`verify:package` は Bun・Node の両方で通った。
- Eumenes: 記憶に関係する試験 112 ファイル 577 件が通った。lint・整形も通った。型検査は、別のセッションが作業中の `api/domains/browser/service/interact-execution.ts`（未コミット）だけでエラーになる。memory まわりにエラーは無い。
