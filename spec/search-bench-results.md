# State の全文検索の bench の結果（S8）

設計 `spec/state-search-design.md` §6.3 の測定の記録。合否は §6.2 の目標で判定する。

- 測定日: 2026-11-16（JST）。計算機: 共有の Linux の箱（8 vCPU、メモリの空きは約 2 GB。ほかの処理と同居しているため、数値には揺れがある）。
- 実行環境: bun 1.4.4、同梱の SQLite 3.53.4（FTS5、`ENABLE_DBSTAT_VTAB`）。
- 道具: `bench/search-scale.ts`（verify の対象外）。本物の `assertUserState` で合成の item を入れ、核の `searchState` を呼ぶ。
  - 再現: `bun bench/search-scale.ts --sizes 1000,10000,100000 --json out.json`、走査の上限の確認は `--scan-max-case 20000`。
- scope は 10 種類、そのうち 3 種類を許可した（§6.1 と同じ）。p50 / p95 はウォームアップ 3 回の後の 30 回、単位は ms。
- 文書の長さ: `short` は 50 B、`medium` は 500 B、`max` は 4000 B ＋属性 16 個（各 200 B）。`mixed` は short 70%、medium 25%、max 5%。
- scope の偏り: `uniform` は 10 scope に均等（許可 3 scope に 3 割）、`concentrated` は 9 割を許可した 1 scope に置く。`allowedOnly` はすべてを許可した 3 scope に置く（走査の対象をちょうど n 件にするため）。
- 検索語: `frequent`「コーヒー」（約 4 割）、`rare`「珍味トリュフ」（1%）、`twoTerms`「コーヒー」＋「ミルクティー」（AND）、`shortOnly`「会議」（2 文字、約 3 割、走査）、`mixed`「コーヒー」＋「会議」、`shortRare`「珍味」（2 文字、珍しい、走査）。
- 走査の経路は、測定のため `scanMax` を 1,000,000 にした（本番の上限 20000 では、10 万件・均等の走査は `SCAN_LIMIT_EXCEEDED` になる）。

## 1. 大きさと初回の構築［事実］

| 件数 | 構成 | item の表（item・属性・根拠・event） | FTS 索引 | 対応表 | DB ファイル | WAL（checkpoint 後） | 初回投入（全体） | 0009 の初回構築 | verify |
|---|---|---|---|---|---|---|---|---|---|
| 1,000 | file mixed uniform | 1.6 MB | 1.3 MB | 0.18 MB | 4.3 MB | 0 | 0.2 s | 17 ms | 11 ms |
| 1,000 | file short | 1.0 MB | 0.22 MB | 0.18 MB | 2.4 MB | 0 | 0.1 s | 6 ms | 3 ms |
| 1,000 | file medium | 1.5 MB | 1.4 MB | 0.18 MB | 4.1 MB | 0 | 0.2 s | 18 ms | 13 ms |
| 1,000 | file max | 10.1 MB | 16.4 MB | 0.18 MB | 30.8 MB | 0 | 1.0 s | 229 ms | 112 ms |
| 10,000 | file mixed uniform | 15.6 MB | 12.9 MB | 1.7 MB | 39.2 MB | 0 | 2.6 s | 229 ms | 123 ms |
| 10,000 | memory mixed uniform | 15.6 MB | 12.9 MB | 1.7 MB | ― | ― | 1.9 s | 157 ms | 110 ms |
| 10,000 | file short | 9.8 MB | 1.9 MB | 1.7 MB | 21.3 MB | 0 | 1.7 s | 71 ms | 34 ms |
| 10,000 | file medium | 14.3 MB | 14.0 MB | 1.7 MB | 40.0 MB | 0 | 2.6 s | 277 ms | 151 ms |
| 10,000 | file max | 100.5 MB | 163.7 MB | 1.7 MB | 294.5 MB | 0 | 11.9 s | 2,837 ms | 1,155 ms |
| 20,000 | file mixed allowedOnly | 31.1 MB | 25.8 MB | 3.4 MB | 78.3 MB | 0 | ― | ― | ― |
| 100,000 | file mixed uniform | 156.3 MB | 128.8 MB | 17.1 MB | 391.1 MB | 0 | 36.4 s | 4,516 ms | 1,312 ms |

- 「item の表」は dbstat の `memory_state_item*`、`memory_state_attribute*`、`memory_state_evidence*`、`memory_state_event*` の合計（出典の表 `memory_source*` などは含まない）。
- 「0009 の初回構築」は、索引を `ROLLBACK_0009_SQL` で消して版 8 に戻した DB に、migration 0009 を 1 transaction で再適用した時間（既存の DB への適用と同じ）。
- 「verify」は `verifyStateSearchIndex`（件数の照合と FTS5 の `integrity-check`）。起動のたびに走る。

## 2. 検索（核の `searchState`、水和を含む。ホストの evidenceStatus は含まない）［事実］

p50 / p95（ms）。括弧の中は返った件数（limit 20、21 件目があれば more）。

| 件数 | 構成 | frequent | rare | twoTerms | shortOnly（走査） | mixed | shortRare（走査） |
|---|---|---|---|---|---|---|---|
| 1,000 | file mixed uniform | 0.68 / 0.90 | 0.31 / 0.37 | 0.75 / 1.08 | 1.29 / 1.51 | 0.90 / 1.01 | 1.43 / 1.63 |
| 1,000 | memory mixed uniform | 0.61 / 0.78 | 0.31 / 0.39 | 0.71 / 0.85 | 1.23 / 1.38 | 0.87 / 1.37 | 1.41 / 1.53 |
| 1,000 | file mixed concentrated | 0.68 / 0.75 | 0.18 / 0.28 | 0.45 / 0.61 | 1.60 / 2.07 | 0.85 / 1.15 | 1.48 / 1.60 |
| 1,000 | file max | 2.20 / 2.27 | 0.88 / 1.75 | 2.41 / 2.53 | 4.54 / 6.02 | 8.13 / 8.57 | 5.78 / 6.86 |
| 10,000 | file mixed uniform | 8.31 / 8.46 | 1.42 / 1.53 | 3.36 / 3.56 | 17.6 / 18.5 | 9.37 / 9.61 | 19.3 / 20.1 |
| 10,000 | memory mixed uniform | 6.07 / 6.15 | 1.16 / 1.21 | 2.86 / 3.02 | 13.2 / 13.8 | 7.63 / 7.72 | 15.2 / 15.4 |
| 10,000 | file mixed concentrated | 7.60 / 9.22 | 1.10 / 1.28 | 3.08 / 3.71 | 20.5 / 22.6 | 9.52 / 9.63 | 19.3 / 34.5 |
| 10,000 | file short | 6.54 / 8.19 | 0.13 / 0.15 (0) | 0.16 / 0.21 (0) | 7.99 / 8.93 | 6.03 / 7.57 | 7.24 / 8.21 (0) |
| 10,000 | file medium | 8.39 / 8.49 | 0.16 / 0.22 (0) | 0.18 / 0.22 (0) | 11.7 / 11.9 | 8.58 / 8.84 | 10.7 / 11.6 (0) |
| 10,000 | file max | 26.2 / 28.2 | 5.72 / 6.06 | 30.0 / 32.0 | 47.8 / 52.7 | 88.3 / 117.8 | 58.8 / 60.4 |
| 20,000 | file mixed allowedOnly（走査の対象 20,000） | 20.2 / 20.5 | 2.21 / 2.45 | 7.34 / 8.85 | **75.0 / 77.9** | 21.6 / 21.7 | **78.2 / 80.9** |
| 100,000 | file mixed uniform | **106.7 / 113.7** | 8.74 / 9.61 | 29.8 / 31.7 | 215 / 237（対象 30,000、本番では QUERY_TOO_SHORT） | 108 / 118 | 228 / 263（同） |

- short と medium の rare と twoTerms が 0 件なのは、合成の文書の作り方による（50 B と 500 B の一部の文書では、語が長さの切り詰めで落ちる。`(0)` と記した）。0 件の検索の時間として読む。
- 件数が 1,000 の short と medium の表は省いた（JSON の記録にはある）。

## 3. 書き込みと忘却（核の関数）［事実］

| 件数 | 構成 | 書き込み 1 件（索引あり、新しい item） | 索引の更新だけ（`syncStateSearch` 1 件、既存の行の消去と再登録） | 忘却 1 件（`scrubStateItem`、索引の trigger を含む） | checkpoint（TRUNCATE、33 件の忘却と書き込みの後） |
|---|---|---|---|---|---|
| 1,000 | file mixed uniform | 1.37 / 2.15 | 1.15 / 2.64 | 1.66 / 3.93 | 0.43 |
| 1,000 | memory mixed uniform | 0.15 / 0.31 | 0.35 / 0.59 | 0.56 / 2.43 | ― |
| 10,000 | file mixed uniform | 1.37 / 1.76 | 2.21 / 3.50 | 2.50 / 9.27 | 0.34 |
| 10,000 | memory mixed uniform | 0.17 / 0.31 | 0.86 / 1.93 | 1.33 / 5.82 | ― |
| 10,000 | file max | 0.87 / 1.99 | 2.67 / 3.77 | 18.3 / 24.3 | 0.48 |
| 20,000 | file mixed allowedOnly | 0.85 / 1.56 | 2.72 / 4.62 | 3.14 / 21.2 | ― |
| 100,000 | file mixed uniform | 1.21 / 1.82 | 4.42 / 6.93 | 4.90 / 18.3 | 0.44 |

- 書き込みは short の新しい item を 1 件ずつ、1 transaction で書いた（ファイルの DB では commit の fsync を含む）。
- **「索引なし」の書き込みと忘却は未測定。** 核は版 9 の schema を要求し、索引を外した状態では `assertUserState` を呼べないため。代わりに「索引の更新だけ」の時間を測った。新しい item の書き込みの増分は、この値の INSERT の部分以下である［推定］。
- 忘却は核の `scrubStateItem` だけ。ホストの忘却（ジャーナルの追記、checkpoint、バックアップの洗い直し）は含まない。

## 4. EXPLAIN QUERY PLAN（10 万件）［事実］

- FTS の経路（frequent、rare、twoTerms、mixed は同じ形）:
  `SCAN f VIRTUAL TABLE INDEX 0:M1` → `SEARCH r USING INTEGER PRIMARY KEY (rowid=?)` → `SEARCH i USING INDEX sqlite_autoindex_memory_state_item_1 (item_id=?)` → `CORRELATED SCALAR SUBQUERY`（tombstone、`sqlite_autoindex_memory_tombstone_1`）→ `USE TEMP B-TREE FOR ORDER BY`
- 走査の経路（shortOnly、shortRare）:
  `SEARCH i USING INDEX memory_state_item_by_scope (principal=? AND scope_key=? AND status=?)` → tombstone の副問い合わせ → 文書の view（`memory_state_search_doc`、属性の `group_concat` に `USE TEMP B-TREE`）→ `USE TEMP B-TREE FOR ORDER BY`
- FTS の経路の費用は、一致した件数に比例する（bm25 で全件を並べてから LIMIT が効く）。scope の絞り込みは結合の中で効き、順位の前に行われる（§3.5 のとおり）。

## 5. §6.2 の目標との照合

| 目標 | 結果 | 判定 |
|---|---|---|
| 索引の大きさ: 1 万件で 10 MB 以下 | mixed 12.9 MB、short 1.9 MB、medium 14.0 MB、max 164 MB | **mixed では未達**［事実］。§6.1 の参考より文書が長い（平均は約 520 B と見積もった［推定］。属性を含む）ため。索引は item の表の約 0.8〜1.6 倍［事実］で、§6.1 の 1.8 倍より小さい |
| 書き込み 1 回の p95 が ＋2 ms 以下 | 新しい item の書き込み全体の p95 が 1.6〜2.2 ms（索引を含む）。既存の行の作り直し（編集）は p95 3.5 ms（1 万件）、6.9 ms（10 万件） | 新しい item は達成［推定: 増分は全体以下］。**編集は未達**（1 万件以上）。レビューの修正の後（§8）、文書が変わらない書き込み（確認、根拠の追加）は 0.03 ms 以下になった。本文を変える編集は p95 3.3 ms / 6.3 ms で未達のまま |
| 検索（1 万件）の p95 が 20 ms 以下 | FTS の経路は 1.2〜9.6 ms（max の文書だけの DB では 28〜118 ms）。走査は 13.8〜22.6 ms、集中のとき 34.5 ms | mixed の FTS は達成。走査と max だけの DB は**一部未達**。ホスト経由（§7）は 1 万件で p95 2.3〜13.3 ms で達成 |
| 検索（10 万件、よく出る語）の p95 が 100 ms 以下 | 113.7 ms（核のみ） | **未達**。§6.2 のとおり「よく出る語は bm25 を使わず `updated_seq` で並べる案」を検討する（今回は実装しない。利用者の判断が要る事項として設計の §11 に記録した） |
| 2 文字以下だけの走査: `SEARCH_SCAN_MAX` を測ったうえで決める | 走査の対象がちょうど 20,000 件のとき p95 77.9 ms と 80.9 ms | **20000 で決める**。最悪でも 10 万件の目標（100 ms）以下に収まる。これより多いと `QUERY_TOO_SHORT` |
| 忘却 1 件の増分の p95 が ＋10 ms 以下 | 忘却全体の p95 が 3.9〜24.3 ms（索引の trigger を含む）、checkpoint 0.3〜0.5 ms | 索引なしの忘却が未測定のため、増分は判定できない（**未測定**）。mixed の 1 万件で全体が 9.3 ms |

## 6. 未測定

- 索引なしの書き込みと忘却（上の §3 の理由）。
- 10 万件の `:memory:`、10 万件の short、medium、max、concentrated（メモリの空きと時間のため）。
- バックアップの洗い直し（S4）の時間の、件数ごとの変化。

## 7. ホスト経由の検索（S9）［事実］

`bench/search-host.ts`（verify の対象外）。一時ディレクトリにホストの店を作り、合成の item を核の `assertUserState` で入れて（scope 10 種類に均等、文書は short 70%・medium 25%・4000 B 5%、属性なし）、`MemoryHost.dispatch("search", { query, scopeKeys: 許可した 3 scope })` を測った。無害化、核の検索、水和、`evidenceStatus` と `trust`、byte の予算（既定 32768）、検索用の snapshot の作成を含む。socket と JSON の転送は含まない。p50 / p95（ms）、括弧は返った件数。

| 件数 | frequent「コーヒー」 | rare「珍味トリュフ」 | twoTerms「コーヒー ミルクティー」 | shortOnly「会議」（走査） | mixed「コーヒー 会議」 |
|---|---|---|---|---|---|
| 1,000 | 1.56 / 1.90 (20) | 0.88 / 0.94 (10) | 1.75 / 2.40 (20) | 1.59 / 2.31 (20) | 1.43 / 1.73 (20) |
| 10,000 | 6.55 / 8.04 (20) | 1.23 / 2.26 (20) | 5.30 / 5.41 (20) | 12.3 / 13.3 (20) | 8.82 / 10.1 (20) |
| 100,000 | 87.3 / 89.1 (20) | 5.71 / 6.56 (20) | 59.9 / 63.7 (20) | 28.3 / 31.0（`QUERY_TOO_SHORT`、対象 30,000 件） | 103 / 112 (20) |

- 応答の JSON の大きさは 15〜30 KB（20 件、既定の maxBytes の範囲）。
- 10 万件では、よく出る語の p95 は 89 ms で目標（100 ms）以内だったが、よく出る語と 2 文字の語の混在は 112 ms で目標を超えた（§5 の判定と同じく、順位の規則は変えずに記録する）。
- 走査の上限を超える問い合わせは、候補を数えるだけで拒否し、約 30 ms で返る。

## 8. コードレビューの修正の後の再測定（2026-11-16 JST）［事実］

同じ道具（`bench/search-scale.ts --sizes 10000,100000`、`bench/search-host.ts --sizes 10000`）、同じ箱（SQLite 3.53.4、Bun 1.4.4）。修正は、確認や根拠の追加で索引を作り直さないこと（核の `writeItem` と `syncStateSearch`）と、検査に `staleRows`（索引の文書と正本の比較）を足したこと。`edit` は今回足した列で、本文を変える UPDATE（trigger が古い行を消す）と再登録の時間（核の書き込みの残りは含まない）。p50 / p95（ms）。

| 件数 | 構成 | 書き込み 1 件（新しい item） | 索引の更新だけ（文書が変わらない再登録） | 編集の索引の部分（`edit`） | 忘却 1 件 | verify | FTS 索引 |
|---|---|---|---|---|---|---|---|
| 10,000 | file mixed uniform | 1.04 / 2.92 | 0.014 / 0.023（前 2.21 / 3.50） | 2.57 / 3.30 | 3.32 / 10.1 | 152 ms（前 123） | 12.9 MB |
| 10,000 | memory mixed uniform | 0.26 / 0.54 | 0.031 / 0.044（前 0.86 / 1.93） | 1.35 / 2.93 | 1.29 / 7.10 | 136 ms（前 110） | 12.9 MB |
| 10,000 | file mixed concentrated | 1.38 / 2.50 | 0.013 / 0.019 | 2.32 / 3.23 | 2.10 / 13.8 | 132 ms | 12.9 MB |
| 10,000 | file short | 1.25 / 1.51 | 0.012 / 0.029 | 1.29 / 1.70 | 1.21 / 2.02 | 51 ms（前 34） | 1.9 MB |
| 10,000 | file medium | 1.51 / 2.11 | 0.013 / 0.026 | 2.81 / 12.0 | 9.36 / 14.9 | 181 ms（前 151） | 14.0 MB |
| 10,000 | file max | 0.90 / 1.71 | 0.016 / 0.026（前 2.67 / 3.77） | 2.89 / 20.5 | 20.7 / 26.8 | 1,343 ms（前 1,155） | 163.7 MB |
| 100,000 | file mixed uniform | 1.50 / 2.05 | 0.020 / 0.032（前 4.42 / 6.93） | 4.36 / 6.27 | 4.36 / 16.0 | 1,761 ms（前 1,312） | 128.8 MB |

- 「索引の更新だけ」は前回と同じ測り方（同じ item をもう一度登録する）。前回は文書が同じでも消して入れ直していたが、今は比べるだけで終わる。確認や根拠の追加の書き込みは、この経路になる。
- 本文を変える編集の索引の部分は p95 3.3 ms（1 万件）、6.3 ms（10 万件）で、§5 の「＋2 ms 以下」は**未達のまま**。残りは secure-delete の消去の費用［推定］（secure-delete なしの値は**未測定**）。
- verify は `staleRows` の比較のぶん 2〜3 割増えた（起動のたびに 1 回）。
- 核の検索の p95（ms、frequent / rare / twoTerms / shortOnly / mixed / shortRare）: 1 万件 file mixed uniform は 11.8 / 1.68 / 4.21 / 18.0 / 11.0 / 22.3、10 万件は 114.2 / 9.72 / 32.0 / 240 / 116 / 276。検索の経路は変えておらず、前回（§2）との差は測定のぶれの範囲と見る［推定］。
- ホスト経由（§7 と同じ条件、1 万件）の p95: frequent 8.63、rare 2.21、twoTerms 6.87、shortOnly 15.6、mixed 10.8（すべて 20 件）。1,000 件と 10 万件のホスト経由は**未測定**（今回は再測定していない）。
- `use`、`extendRelated`、`reactivate` を対象の item だけ読むようにした効果は**未測定**。

### 8.1 見直しの一覧と自動停止の対象探し、snapshot の根拠の調べ直し（レビュー 2）

`bench/search-host.ts --sizes 10000`（1 万件、10 scope、すべて本人確認済みで候補は 0 件。`review` は 10 scope 全部、`expire` は `expiredItems` だけ）。p50 / p95（ms）。

| 測定 | 修正の前 | 修正の後 |
|---|---|---|
| `review` | 67.5 / 74.3 | 9.99 / 10.1 |
| `expire` の対象探し | 61.8 / 74.6 | 9.58 / 10.3 |
| 検索 frequent / rare / twoTerms / shortOnly / mixed の p95 | 8.59 / 2.18 / 6.31 / 14.0 / 11.0 | 8.17 / 2.19 / 6.40 / 13.8 / 10.3 |

- 検索の差が小さいのは、この道具の item がホストの出典を持たず、根拠の調べ方が軽いため［推定］。ホストの出典を持つ item（`json_extract` で出典を走査する）での効果は**未測定**。根拠を調べる回数は 3 回から 1 回になった（試験で数えている）［事実］。
- 候補が多いとき（外部由来の期限切れが多数）の時間は**未測定**。
