# 改善計画書

2026-10-09 / 状態: **提案（未承認）**。2026-10-09 の多角評価で挙がった懸念点と追加の改善点を、実行できる単位に分解した計画。
到達段階の記号（C/I/F/S/H/E）は [verification-status.md](verification-status.md) に従う。**計画に書いたことは、実施して検証するまで達成と書かない。**

## 1. 目的と範囲

- 目的: 決定的な層の堅さ（I/F/S）を保ったまま、未到達の H（ホスト結合）と E（実モデル評価）に到達し、運用・文書・履歴の弱点を直す。
- 範囲外: World / Consolidation（別リポジトリ）、Procedure（Eumenes 側）。Rust 化はしない（[rust-core-decision.md](rust-core-decision.md)）。
- 原則: 契約（`src/contracts/**`）の破壊的変更を伴う項目は、この計画では扱わない。必要になったら別途設計する。

## 2. 懸念点・改善点と対応表

| ID | 内容 | 重要度 | 対応タスク |
|---|---|---|---|
| C1 | E 段階未到達（評価データ・閾値・実モデル評価） | 高 | T1〜T5 |
| C2 | H 段階が部分的（抽出由来の永続・selection が未結合）、migration 未凍結 | 高 | T6〜T9 |
| C3 | 安全性がホストの起動手順の遵守に依存する | 中 | T10, T11 |
| C4 | 環境差（FTS5・SQLite が macOS のみの確認） | 中 | T12, T13 |
| C5 | README / 文書の鮮度、履歴の薄さ | 中 | T14〜T16 |
| A1 | CI が無い（`.github` なし。検証は手元の `bun run verify` のみ） | 中 | T12 |
| A2 | 文書内のパスが旧構造（`src/store/...`）のまま | 低 | T14 |
| A3 | FTS 戦略が common な語で優位にならない（ヒット数を見積もる余地） | 低 | T17 |
| A4 | 巨大ファイル（repository が 1300〜1600 行、テストが 1700 行級） | 低 | T18 |
| A5 | `verify` 内の入れ子実行（`tooling.test.ts`）が実レポートを増やし、失敗レポートが混ざる | 低 | T19 |
| A6 | Python 製の `scripts/fixture-digest.py` が Bun 単一ツールチェーンから浮いている | 低 | T20 |
| A7 | 物理消去は保証しない（運用推奨のみ。検証手段がない） | 低 | T21 |
| A8 | `verification-reports/` が無制限に増える（git 管理外だが整理手段がない） | 低 | T19 |

## 3. 段階と依存

```
Phase 0 基盤整備   T12 T14 T15 T19 T20   （他と独立。先に着手して以後の変更を守る）
Phase 1 評価準備   T1 → T2 → T3 → T4 → T5   （E 段階）
Phase 2 ホスト結合 T6 → T7 → T8 → T9       （H 段階。T9 は T5 の結果を待つ判断を含む）
Phase 3 堅牢化     T10 T11 T13 T17 T18 T21  （Phase 1/2 と並行可）
Phase 4 公開準備   T16                      （Phase 1・2 の完了後）
```

担当の凡例: **人** = ユーザーの判断・作業が必須。**Claude** = 実装可能。**共同** = 人が決め Claude が実装。

## 4. タスク

### Phase 0: 基盤整備

**T12 CI の導入（A1, C4）— Claude**
- `.github/workflows/verify.yml`: push / PR で `bun install --frozen-lockfile` → `bun run verify:all`。
- OS は ubuntu と macOS のマトリクス。Linux の SQLite で FTS5 テストが通るかをここで初めて確認する（T13 の入力）。
- 受入: 両 OS で verify が緑。Linux で落ちるテストがあれば T13 に切り出す。

**T14 文書の鮮度回復（C5, A2）— Claude**
- README 冒頭を現状（S0〜S6 と提案の段階 2〜4 まで実装、H/E は部分的）に書き直す。「M0 を実装済み」の古い記述を直す。
- `src/store/...` の旧パスを `src/infrastructure/sqlite/` と `src/domains/*/repository` に更新（verification-status §4、bench-scope-results、各 spec）。
- verification-status の S0 記録（テスト 489 件など）は「履歴」と見出しで明示し、現在値（1563 件、fixture 543）は冒頭の表に置く。
- 受入: 文書内のパス参照が実在することを確認するテスト（リンク・パス検査）を `test/` に追加して緑。

**T15 履歴の整理（C5）— 共同**
- 以後の変更はスライス単位（機能 1 つ + 対応する文書・テスト）でコミットする運用に切り替える。
- コミットメッセージ規約（1 行目に段階記号、例: `S5: ...`）を `CONTRIBUTING` 相当として README に 1 節置く。
- 既存 2 コミットの書き換えはしない。受入: 規約が文書化され、以後のコミットが従う。

**T19 verify の整理（A5, A8）— Claude**
- `tooling.test.ts` が入れ子で `verify` を呼ぶ部分は、レポート出力先を一時ディレクトリに向けて、実レポートに失敗レポートが混ざらないようにする。
- `verification-reports/` に保持数の上限（例: 直近 50 件 + `latest.json`）を設ける整理コマンドを `scripts/` に追加。
- 受入: `bun run verify` 後に `verification-reports/` が失敗レポートで増えない。整理コマンドのテストが緑。

**T20 Python スクリプトの置換（A6）— Claude**
- `scripts/fixture-digest.py` の役割を確認し、同じ出力を返す TypeScript 版に置換（出力が一致することを現行 fixture で確認してから削除）。
- 受入: Python 無しで同じ digest が得られる。`scripts/__pycache__` が不要になる。

### Phase 1: 実モデル評価（E 段階）

**T1 評価データの拡充（C1）— 共同**
- 現状 124 件（各カテゴリ 8〜9 件、dev 4 / test 4〜5）。設計目標の各カテゴリ・各 split 15 件へ（30 組の不足を解消）。計 450 件程度。
- 方針: 失敗しやすい境界（二重否定、伝聞、絵文字の byte 範囲、嗜好の変更）を優先。Claude が候補を生成し、人がレビューする。
- 受入: `eval/test/dataset.test.ts` に「カテゴリ × split の最小件数」検査を追加し緑。

**T2 gold の人手レビュー（C1）— 人**
- 全件を確認し、`acceptable`（許容する別解）を見直す。境界事例は特に精査する。
- 完了したら `humanReviewed: true`。データの SHA-256 が変わるので T3 を再実施する。
- 受入: レビュー済みの印と、レビュー者・日付が dataset のメタに記録される。

**T3 閾値の承認（C1）— 人**
- [eval/THRESHOLDS.md](../eval/THRESHOLDS.md) の「承認の手順」に従い、`proposal-1.json` を修正して `approved`、`decidedBy` / `decidedAt` を記入。
- **実行前に決める。** test の結果を見てから閾値を変えない（変えた場合、その test は使い切りとして新ケースを足す）。
- 受入: `thresholds.status = "approved"` が結果 JSON に載る。

**T4 実モデル用アダプターの実装（C1）— Claude**
- `eval/adapters/` に実モデルのアダプターを追加（`ExtractorPort` 実装、プロンプト版を `promptVersion` に固定）。モデルは人が選ぶ。
- API キー等は環境変数から読む。リポジトリに含めない。結果 JSON に providerRef / modelId を記録する。
- 受入: 小さなサブセットで end-to-end が動き、`stub: false` の結果が出る。

**T5 評価の実行と判定（C1）— 共同**
- `--split test --repeats 3`（最悪値で判定）を実行。dev で調整し、test は 1 回の判定に使う。
- 必須項目（`falseAdmissions`、`polarityErrors` など）が 0 でなければ、該当カテゴリの `auto_admit` は不可とし、そのカテゴリを `user_confirm` に固定する設計を既定にする。
- 結果の要約を verification-status に記録する。stub でない・人手レビュー済み・件数が揃っている、をすべて満たす場合だけ E と書く。
- 受入: 結果 JSON と要約が残り、E の主張可否が `eStageEligible` と一致する。

### Phase 2: ホスト結合（H 段階）

**T6 抽出由来の永続の結合試験（C2）— 共同**
- Eumenes の Writer / queue / 採用 transaction に、Extraction（prepare / settle / confirm）を結合する。
- Eumenes 側の変更は [隣接リポジトリの接続計画](../../eumenes/spec/memory-system-incremental-adoption-concept.md) に従う。本体からは触らない。
- 受入: 抽出 → pending → ユーザー確認 → State 反映 → 忘却の流れが、Eumenes の結合試験で通る。

**T7 selection の結合（C2）— 共同**
- Eumenes の対話を単一 scope の View v2 から、`listStateScopes` → `candidateFromStateItem` → `selectContext` の複数 scope へ移す。
- 受入: 複数 scope・矛盾解決・overflow / hold を含む結合試験が緑。既存の単一 scope の挙動は互換。

**T8 時間判定・利用根拠の再検証の結合（C2）— 共同**
- Checkpoint 検査と公開版の更新判定を、Eumenes の採用 transaction に結合する（現状は純粋部分のみ）。
- 受入: 古い snapshot の再提示を拒否する試験が結合側にある（README の既知制限「古い snapshot はホストの責任」を試験で担保）。

**T9 migration の凍結（C2）— 人が判断、Claude が記録**
- T6〜T8 で Eumenes の実 DB に適用した時点で、凍結する番号と各 body の SHA-256 を verification-status §2 に記録し、以後は追記専用にする。
- 凍結前に migration の統合・並べ替えの要否を最後に確認する（0003 に抽出が同居している点など）。
- 受入: 凍結表が記録され、`assertMemorySchema` の hash 検査が凍結済みの body に対して通る。凍結済み body の変更を検出するテストを追加。

### Phase 3: 堅牢化

**T10 ホスト契約テストの提供（C3）— Claude**
- ホストが自分のテストに流用できる契約テスト（起動手順: migrations の部分列検査、`assertMemorySchema`、reconcile、`inconsistent` 時の停止）を、公開面の一部として提供する。
- 受入: Eumenes 側がそのテストを取り込み、起動手順を外すと落ちることを確認する。

**T11 古い DB の復元検出の強化（C3）— 共同**
- 現状はジャーナルがホスト側の外部ファイル。ジャーナル欠落（外部ファイルごと古い）の検出方法を設計する（例: 世代カウンタをジャーナルと DB の両方に持つ）。
- review.json の指摘「バックアップ復元でのレコード忘却が不完全」への対応状況を確認し、残りを塞ぐ。
- 受入: 「DB とジャーナルを同時に古い版へ戻す」シナリオを、検出できる範囲と限界を含めて試験・文書化する。

**T13 SQLite / FTS5 の環境差（C4）— Claude**
- T12 の Linux 結果を受け、FTS5 が無い環境で `FTS_UNAVAILABLE` から LIKE に縮退することを試験で固定する。
- bun の組み込み SQLite と、システム SQLite の版差を `bench/` で再計測し、`LIKE_SCAN_MAX` を再確認する。
- 受入: Linux での FTS 有無・両パスのテストが緑。bench の結果を `bench-scope-results.md` に追記。

**T17 FTS の戦略選択の改善（A3）— Claude**
- common な語は 5,000 件超でも FTS が LIKE と同等（1.02 倍）。ヒット数の見積もりで戦略を選ぶ案を検討する。
- 効果が計測で確認できなければ実施しない（LIKE / FTS 同値 property は維持）。T1〜T9 より優先度は低い。

**T18 巨大ファイルの分割（A4）— Claude**
- 1300 行以上の repository（state 1520、extraction 1604、lifecycle 1303）を、責務ごとに分割する（読み取り / 書き込み / 検証など）。
- 公開面と挙動を変えない。`public-surface` と全テスト、fixture の結果が変わらないことで確認する。
- 受入: 1 ファイル 800 行以下。テスト・fixture 無変更で緑。

**T21 物理消去の検証手段（A7）— 共同**
- `secure_delete=ON` と `wal_checkpoint(TRUNCATE)` 後に、忘却した文字列が DB・WAL ファイルのバイト列に残らないことを確認する試験（実 SQLite）を追加する。
- 限界（OS のスナップショット、ファイルシステムの残存）は保証外のまま文書に残す。
- 受入: 試験が緑。保証範囲の記述が試験の範囲と一致する。

### Phase 4: 公開準備

**T16 公開と配布（C5）— 人が判断**
- Phase 1・2 の完了後に、`private: true` の解除、バージョン方針（凍結後は互換性規則）、配布方法（tarball / レジストリ）を決める。
- 現状 `file:` 依存の運用で `bun install` の再実行が必要な点を、配布方法の決定で解消する。
- 受入: 方針が文書化される。リモート公開はユーザーの承認を得てから行う。

## 5. 完了の定義

| 懸念 | 完了条件 |
|---|---|
| C1 | T5 で E の主張可否が結果 JSON と一致して記録される（満たさなければ満たさないと記録される） |
| C2 | T6〜T8 の結合試験が Eumenes 側で緑、T9 で migration 凍結表が記録される |
| C3 | T10 の契約テストが Eumenes 側に取り込まれ、T11 の限界が文書化される |
| C4 | Linux + macOS の CI が緑で、FTS 有無の両パスが試験で固定される |
| C5 | README・パス参照が現状と一致（T14 の検査で保証）、コミット規約が運用される |

## 6. 人の判断が必要な点

1. 評価に使う実モデルと予算（T4, T5）。
2. 評価データのレビューと閾値の承認（T2, T3）。
3. migration 凍結の時期（T9）と、公開・配布方針（T16）。
4. T11 で DB とジャーナルの同時ロールバックをどこまで防ぐか（ホスト側の運用を含む）。

## 7. 進め方

- Phase 0 を最初に行い、CI と文書の検査で以後の変更を守る。
- 各タスクは、実装・試験・verification-status の更新を 1 スライスとして完了させる。
- 大きな変更の後は独立レビューを 1 回行い、まとめて直す（レビューと修正の往復はしない）。
- 共有ファイル（`package.json`、`src/index.ts`、`src/sqlite.ts`、`src/contracts/**`、`scripts/**`、`spec/verification-status.md`、`README.md`）は、親担当が最後にまとめて編集する。
- コミット・push はユーザーの指示があるまで行わない。

## 8. 実施状況（2026-10-09）

`bun run verify` 全通過（1585 テスト）。コミットはしていない。

| タスク | 状態 | 内容・訂正 |
|---|---|---|
| T12 | 実装済み（CI 実行は未確認） | `.github/workflows/verify.yml`（ubuntu + macOS）。remote に push して初めて緑を確認できる。Linux の結果は T13 の入力 |
| T14 | 完了 | README を現状に更新、旧パスの注記、`test/docs.test.ts`（生きた文書の相対リンクと `src/` パスの実在検査）。検査が `src/infrastructure/sqlite/README.md` の壊れたリンク 2 件を見つけて修正 |
| T15 | 未実施 | コミット規約は、コミットを行う指示を受けてから決める |
| T19 | 部分的 | `verify` が直近 50 件のレポートと `latest.json` だけを残す（`pruneReports`）。**A5 は誤認だった**: 失敗レポートは `tooling.test.ts` が一時ディレクトリに出すもので、リポジトリの `verification-reports/` には混ざらない（出力に標準出力が混ざって見えただけ） |
| T20 | **中止** | `fixture-digest.py` は「TypeScript のランタイムとは独立に digest を計算する」ための意図的な第二実装。TS に置換すると独立性が失われるので残す |
| T13 | 既存で足りる | FTS 無し環境の縮退（`FTS_UNAVAILABLE` と LIKE への切替）は `recall.test.ts` が既に固定している。Linux 実測は CI 待ち |
| T21 | 完了 | `test/scenario/physical-erasure.test.ts`。`secure_delete=ON` + `wal_checkpoint(TRUNCATE)` で本文が DB・WAL のバイト列から消えること、`OFF` では残ること（対照）を確認 |
| T10 | 部分的 | `checkHostMigrations`（欠落・重複・順序違い・改変を返す）を `./sqlite` に追加。起動手順全体の契約テスト一式と Eumenes 側の取り込みは未 |
| T18 | 部分的 | extraction の忘却部分と SQL 補助を `forget.ts` / `sql.ts` に分離（1604 → 1396 行）。公開面は不変。state・lifecycle は相互依存が強く、浅い分割は価値が低いので見送り |
| T1 | 未実施 | 約 330 件の gold（byte 範囲つき）の生成は、人のレビューと一体で行う |
| T2〜T9, T11, T16, T17 | 未実施 | 人の判断・実モデル・Eumenes リポジトリ・CI の結果を待つもの。T17 は T13 の計測後 |
| 模擬ホスト（追加） | 完了 | `test/runners/fake-eumenes-host.ts` と `test/scenario/fake-host.test.ts`（15 件）。Eumenes を模した会話 message・直列キュー・fsync ジャーナル・再起動・DB 復元・起動手順を決定的に再現し、実 Eumenes なしで T6〜T8 の想定を先に試せる。**H 段階の代わりにはならない**（実 Writer / queue ではない）。Eumenes 側の実際の形と食い違いが分かったら、この模擬を直す |
