# 評価軸の詳細

2026-10-07。score_review.py の計算結果から転記。軸の点数は評価済み部分だけの観測値（10点尺度）であり、未確認部分を含む全体点ではない。全軸が部分評価。正式点と暫定点は両方保留。

## Technical Quality

証拠充足率 35.7%、信頼度 Medium、除外重み 0.0%。未確認項目を0〜4で置いた算術上の全体範囲は 15.6〜79.9 / 100。これは推定点や統計的な信頼区間ではない。適用された数値上限はなし。

| 軸 | 観測値 /10 | 基本重み / 実効% | 充足率 | 信頼度 | 評価済みの根拠・未確認事項 |
|---|---:|---:|---:|---|---|
| architecture | 5.0 | 12 / 12.0 | 66.7% | Medium | boundaries: E02,E04,E05,E09; flow: E02,E04,E05,E07 / 未確認: fit |
| correctness | — | 15 / 15.0 | 0.0% | Unknown | 評価済み項目なし / 未確認: contracts, edge_cases, concurrency |
| security | 5.0 | 18 / 18.0 | 33.3% | Medium | access: E02,E04,E05,E07 / 未確認: input_secrets, abuse |
| reliability | 2.5 | 12 / 12.0 | 33.3% | High | recovery: E07,E08 / 未確認: failure, resilience |
| maintainability | 3.8 | 8 / 8.0 | 66.7% | Medium | clarity: E02,E04,E05,E09; change: E05,E04 / 未確認: debt |
| common_components | 5.0 | 5 / 5.0 | 33.3% | Medium | reuse: E02,E03,E09 / 未確認: duplication, abstraction |
| testing | 5.0 | 10 / 10.0 | 66.7% | Medium | quality: E02,E03,E08; automation: E03 / 未確認: risk_coverage |
| supply_chain | — | 8 / 8.0 | 0.0% | Unknown | 評価済み項目なし / 未確認: dependencies, build_release, license |
| performance | 2.5 | 7 / 7.0 | 33.3% | Medium | hot_path: E06 / 未確認: budget, measurement |
| operability | 5.0 | 5 / 5.0 | 33.3% | Medium | signals: E05,E10 / 未確認: lifecycle, interaction |

## Project Potential

証拠充足率 21.7%、信頼度 Medium、除外重み 0.0%。未確認項目を0〜4で置いた算術上の全体範囲は 10.8〜89.2 / 100。これは推定点や統計的な信頼区間ではない。適用された数値上限はなし。

| 軸 | 観測値 /10 | 基本重み / 実効% | 充足率 | 信頼度 | 評価済みの根拠・未確認事項 |
|---|---:|---:|---:|---|---|
| problem | 5.0 | 15 / 15.0 | 66.7% | Medium | need: E11,E12; validation: E12 / 未確認: impact |
| solution | — | 15 / 15.0 | 0.0% | Unknown | 評価済み項目なし / 未確認: mechanism, experience, outcomes |
| differentiation | — | 10 / 10.0 | 0.0% | Unknown | 評価済み項目なし / 未確認: alternatives, advantage, tradeoffs |
| novelty | — | 5 / 5.0 | 0.0% | Unknown | 評価済み項目なし / 未確認: prior_art, substance, verification |
| adoption | 5.0 | 15 / 15.0 | 33.3% | Medium | reach: E12 / 未確認: entry, retention |
| defensibility | 5.0 | 5 / 5.0 | 33.3% | Medium | assets: E02,E03,E09 / 未確認: substitution, incentives |
| execution | — | 10 / 10.0 | 0.0% | Unknown | 評価済み項目なし / 未確認: delivery, focus, feedback |
| timing | 5.0 | 5 / 5.0 | 33.3% | Medium | drivers: E11,E12 / 未確認: readiness, window |
| health | — | 10 / 10.0 | 0.0% | Unknown | 評価済み項目なし / 未確認: ownership, activity, governance |
| expansion | 5.0 | 10 / 10.0 | 33.3% | Medium | adjacency: E02,E03,E11,E12 / 未確認: scalability, path |

各項目の根拠・未知の理由は [review.json](review.json)、元の計算結果は [score-summary.json](score-summary.json)。技術評価の軸は agent profile 固有の重み。算術に使った観測部分の平均は全体点として表示していない。
