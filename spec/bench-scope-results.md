# scope 限定検索の bench 結果（F02、記録のみ）

2026-10-08 / S2 担当。再現: `bun bench/bench-scope.ts`（全部、約 1 分。`--quick` で 1k / 10k のみ）。合否は付けない
（応答予算が未決のため、設計書 §9 Q4）。**ここで確定するのは `LIKE_SCAN_MAX` だけ。**

## 条件

- 環境: bun 1.4.2 / macOS システムの SQLite 3.51.0（`ENABLE_FTS5`）/ `:memory:` / 1 プロセス・1 接続。
- 投入は実際の `captureRecord`（FTS 索引込み）。1 record の本文は約 24 語（約 230 byte）。**本文が大きい record が多い
  環境では LIKE の 1 行あたりのコストが上がるため、`LIKE_SCAN_MAX` は再計測が要る**（上限は 1 MiB）。
- 検索は `searchRecordsWithStrategy` を戦略指定で呼ぶ（`limit` 20、1 scope、ウォームアップ 3 回の後 30 回の p50 / p95）。
  - `rare(~1%)`: 約 1% の record に含まれる語、`common(~20%)`: 約 20%、`two-terms`: 両方（AND）。
  - `fts global matches` は FTS の MATCH が scope 絞り込みの前に返す件数（`IN (SELECT rowid ... MATCH)` はこの件数に比例する）。
- 「読み取り行数」の代わりに、LIKE は対象 scope の行数（scope index で絞った行だけを走査）、FTS は上の global matches を記録した。

## 結果

### Matrix: even distribution, target = scope:0 (total rows x scopes)

| total rows | scopes | target rows | query | like p50 / p95 (ms) | fts p50 / p95 (ms) | hits | fts global matches |
|---|---|---|---|---|---|---|---|
| 1000 | 10 | 100 | rare(~1%) | 0.101 / 0.162 | 0.134 / 0.145 | 1/1 | 11 |
| 1000 | 10 | 100 | common(~20%) | 0.129 / 0.168 | 0.206 / 0.244 | 17/17 | 208 |
| 1000 | 10 | 100 | two-terms | 0.089 / 0.106 | 0.196 / 0.325 | 1/1 | 208 |
| 1000 | 100 | 10 | rare(~1%) | 0.039 / 0.049 | 0.092 / 0.098 | 0/0 | 11 |
| 1000 | 100 | 10 | common(~20%) | 0.042 / 0.053 | 0.132 / 0.137 | 2/2 | 208 |
| 1000 | 100 | 10 | two-terms | 0.038 / 0.044 | 0.157 / 0.163 | 0/0 | 208 |
| 10000 | 10 | 1000 | rare(~1%) | 0.690 / 0.829 | 0.596 / 0.610 | 11/11 | 117 |
| 10000 | 10 | 1000 | common(~20%) | 0.733 / 0.868 | 1.012 / 1.073 | 20/20 | 1958 |
| 10000 | 10 | 1000 | two-terms | 0.642 / 0.655 | 0.688 / 0.706 | 3/3 | 1958 |
| 10000 | 100 | 100 | rare(~1%) | 0.091 / 0.104 | 0.162 / 0.263 | 1/1 | 117 |
| 10000 | 100 | 100 | common(~20%) | 0.127 / 0.137 | 0.448 / 0.534 | 17/17 | 1958 |
| 10000 | 100 | 100 | two-terms | 0.091 / 0.098 | 0.281 / 0.297 | 1/1 | 1958 |
| 100000 | 10 | 10000 | rare(~1%) | 8.458 / 9.757 | 6.454 / 7.138 | 20/20 | 1011 |
| 100000 | 10 | 10000 | common(~20%) | 8.801 / 11.7 | 12.0 / 13.2 | 20/20 | 19937 |
| 100000 | 10 | 10000 | two-terms | 7.700 / 9.054 | 7.158 / 7.642 | 16/16 | 19937 |
| 100000 | 100 | 1000 | rare(~1%) | 0.800 / 0.917 | 1.023 / 1.042 | 11/11 | 1011 |
| 100000 | 100 | 1000 | common(~20%) | 0.814 / 0.881 | 4.207 / 4.269 | 20/20 | 19937 |
| 100000 | 100 | 1000 | two-terms | 0.709 / 0.720 | 1.819 / 1.856 | 3/3 | 19937 |

### Sweep: total ~100k rows, target scope size K (the rest in other scopes)

| K (target rows) | query | like p50 / p95 (ms) | fts p50 / p95 (ms) | fts/like p50 |
|---|---|---|---|---|
| 500 | rare(~1%) | 0.396 / 0.409 | 0.744 / 0.768 | 1.88 |
| 500 | common(~20%) | 0.442 / 0.522 | 3.853 / 3.916 | 8.72 |
| 1000 | rare(~1%) | 0.777 / 0.879 | 1.040 / 1.078 | 1.34 |
| 1000 | common(~20%) | 0.843 / 0.939 | 4.213 / 4.316 | 5.00 |
| 2000 | rare(~1%) | 1.604 / 1.729 | 1.686 / 1.998 | 1.05 |
| 2000 | common(~20%) | 1.615 / 2.047 | 5.041 / 5.252 | 3.12 |
| 5000 | rare(~1%) | 4.168 / 4.621 | 3.425 / 3.587 | 0.82 |
| 5000 | common(~20%) | 4.230 / 4.612 | 7.965 / 9.277 | 1.88 |
| 10000 | rare(~1%) | 8.523 / 13.0 | 8.727 / 10.2 | 1.02 |
| 10000 | common(~20%) | 8.500 / 9.808 | 11.9 / 13.1 | 1.40 |
| 20000 | rare(~1%) | 18.3 / 22.6 | 13.3 / 14.8 | 0.73 |
| 20000 | common(~20%) | 18.7 / 22.6 | 21.6 / 25.1 | 1.15 |
| 50000 | rare(~1%) | 47.6 / 55.2 | 34.5 / 36.1 | 0.72 |
| 50000 | common(~20%) | 48.5 / 50.1 | 49.5 / 55.2 | 1.02 |

#### EXPLAIN QUERY PLAN (scope k:5000, query rarezzq)

like:
    SEARCH r USING INDEX memory_record_by_scope (principal=? AND scope_key=? AND status=?)
    CORRELATED SCALAR SUBQUERY 1
    SEARCH t USING COVERING INDEX sqlite_autoindex_memory_tombstone_1 (target_type=? AND target_id=?)
    CORRELATED SCALAR SUBQUERY 2
    SEARCH s USING COVERING INDEX sqlite_autoindex_memory_tombstone_1 (target_type=? AND target_id=?)
    SEARCH v USING INDEX sqlite_autoindex_memory_record_revision_1 (record_id=? AND revision=?)
    SEARCH b USING INTEGER PRIMARY KEY (rowid=?)
    USE TEMP B-TREE FOR ORDER BY

fts:
    SEARCH r USING INDEX memory_record_by_scope (principal=? AND scope_key=? AND status=?)
    CORRELATED SCALAR SUBQUERY 1
    SEARCH t USING COVERING INDEX sqlite_autoindex_memory_tombstone_1 (target_type=? AND target_id=?)
    CORRELATED SCALAR SUBQUERY 2
    SEARCH s USING COVERING INDEX sqlite_autoindex_memory_tombstone_1 (target_type=? AND target_id=?)
    SEARCH v USING INDEX sqlite_autoindex_memory_record_revision_1 (record_id=? AND revision=?)
    LIST SUBQUERY 3
    SCAN memory_record_fts VIRTUAL TABLE INDEX 0:M1
    CREATE BLOOM FILTER
    SEARCH b USING INTEGER PRIMARY KEY (rowid=?)
    USE TEMP B-TREE FOR ORDER BY


`EXPLAIN QUERY PLAN`: どちらの戦略も `memory_record` は `memory_record_by_scope (principal, scope_key, status)` の
index 検索で、全表走査（`SCAN memory_record`）はない。墓標の二重検査は主キーの covering index 検索。FTS 側の `SCAN memory_record_fts
VIRTUAL TABLE INDEX 0:M1` は全文索引の MATCH 自体（仮想表の検索）で、record の全走査ではない。この検査は
`src/store/test/recall.test.ts` が（plan に `SCAN memory_record` が無いこととして）固定している。

## 読み取り

- LIKE は対象 scope の行数にほぼ線形（約 0.85 µs/行、本文 230 byte）で、**他 scope の行数には依存しない**
  （K=500 のとき総数 10 万行でも 0.4 ms、matrix で 1,000 行の scope は総数 1 万行でも 10 万行でも 0.7〜0.8 ms）。
- FTS は rare な語では scope が約 2,000〜5,000 行を超えると LIKE と同等以下になる（K=5,000 で 0.82 倍、K=20,000〜50,000 で 0.72 倍）。
  common な語（全体の 20% が一致）では **K=50,000 でも LIKE と同等（1.02 倍）で優位にならない**（`IN (MATCH)` が全 scope の一致件数に比例するため）。
- 設計書 §2.1 の観測（`IN (MATCH)` は全 scope のヒット数に比例）と一致する。

## 確定: `LIKE_SCAN_MAX = 5000`

- scope 内の record が 5,000 件以下なら LIKE（p50 ≤ 約 4.2 ms、本文 230 byte の場合）。5,000 件超で、最短語が 3 文字以上のときだけ FTS。
- 根拠: 5,000 付近が rare な語での損益分岐（K=2,000 で 1.05 倍、K=5,000 で 0.82 倍）で、それ以下では LIKE が同等以上かつ他 scope に影響されない。
  common な語では FTS が遅いため、閾値を下げる理由がない。
- 限界（記録）: (1) 本文サイズが大きい環境では LIKE のコストが比例して増える。(2) common な語では 5,000 件超でも FTS が LIKE より遅いことがある
  （ヒット数を見積もって戦略を選ぶ改善余地。検索評価の後に検討する）。(3) 1 プロセス・`:memory:`・単一接続の値で、Eumenes の応答予算とは未照合。
