# カテゴリ別の合格閾値（提案）

状態: **提案（未承認）**。最終値はユーザー判断（設計書 §9 Q2）。機械可読版は `eval/thresholds/proposal-1.json`（`status: "proposal"`）。
**実モデルの結果が無い間は E 段階を主張しない。** 現在あるのは stub（oracle / echo-noop）による自己検査だけで、
stub が提案値を満たしても何の証明にもならない（oracle は定義上満点）。この閾値は、実行の**前**に決めて結果と一緒に記録するための草案。

## 方針

1. **危険な誤りは 0 件を要求する。** 誤採用（`falseAdmissions`）は、全 self kind を `auto_admit` にした最悪ケースで測る。
   仮定・疑問・引用・伝聞・別人情報・過去未来で 1 件でも採用されると、本人の状態でないものが self の台帳に入る（設計書 §6.4(b): これらのカテゴリで test 0 件が `auto_admit` 有効化の必要条件）。
2. **極性の取り違え（`polarityErrors`）は 0。** Admission は quote と意味が逆でも検出できない（fixture A61 / A64 / A66、`stage: "E"`）ので、ここが唯一の防御。
   「好き」と「嫌い」の逆転は、逆の内容を長期記憶として注入する。
3. **見逃しは許す。** 再現率は参考（設計書 §6.4(b) (3)）。記憶しなかった情報はユーザーが言い直せるが、誤った情報は気づかれにくい。下限は「使い物になる」水準に留める。
4. **過剰抽出は、雑談・質問・伝聞・過去未来・長文の一部で 0。** 候補が増えること自体は pending_user で人が見るため軽いが、`auto_admit` と組み合わさると誤採用になる。
5. **引用不一致率は 2% 以下（全体）、絵文字・記号は 0%。** quote が byte 範囲と一致しない候補は Admission が `QUOTE_MISMATCH` で落とすので安全だが、取りこぼしになる。
   絵文字（surrogate pair）の境界は決定的に検査できる分野で、モデルのコピー精度の問題なので 0 を求める。

## カテゴリ別の提案

| カテゴリ | 必須（0 件） | 参考の下限 | 根拠 |
|---|---|---|---|
| negation | polarityErrors, falseAdmissions | candidateRecall ≥ 0.8 | 基本形。ここで極性を誤るモデルは使えない。単純な文で見逃しも許さない |
| double_negation | polarityErrors, falseAdmissions, overExtracted | なし | 二重否定・部分否定は断定しない方が安全（`acceptNoChange` / noChange の gold）。出すなら弱い肯定に限る。再現率は求めない |
| hypothetical | modalityErrors, falseAdmissions | なし | 仮定を asserted にすると現実の願望・習慣になる。出さなくてよい |
| question | modalityErrors, falseAdmissions, overExtracted | なし | 質問は状態でない。一般論の質問から候補を作らない |
| quote | modalityErrors, subjectErrors, falseAdmissions, overExtracted | なし | 引用・書き付けは本人の主張でない。他人の発言を self にしない |
| hearsay | modalityErrors, subjectErrors, falseAdmissions, overExtracted | なし | 伝聞を事実にしない。他人の情報を self にしない |
| other_person | subjectErrors, falseAdmissions | candidateRecall ≥ 0.7 | 別人の情報が self の personal_fact になるのが最も有害な混入 |
| preference_change | polarityErrors, temporalErrors, falseAdmissions | candidateRecall ≥ 0.7 | 古い嗜好を現在にしない。現在の方が正 |
| correction | polarityErrors, falseAdmissions | candidateRecall ≥ 0.8 | 訂正後の値が採用されること。旧値は tolerated |
| past_future | temporalErrors, falseAdmissions, overExtracted | candidateRecall ≥ 0.7 | 過去・未来を current にしない。一回きりの出来事は覚えない |
| multi_evidence | polarityErrors, falseAdmissions | candidateRecall ≥ 0.7 | 複数根拠・複数事柄でも極性を取り違えない |
| no_change | overExtracted, falseAdmissions | noChangeAccuracy ≥ 0.9 | 雑談から何も作らない。現在の件数（9 件）では実質 100% |
| ambiguous | polarityErrors, falseAdmissions | なし | あいまいな表現は出さなくてよいが、出すなら極性を逆にしない |
| emoji_symbol | polarityErrors, quoteMismatchRate = 0 | candidateRecall ≥ 0.8 | 記号・絵文字の扱いと byte 範囲の正しさ |
| long_partial | polarityErrors, falseAdmissions, overExtracted | candidateRecall ≥ 0.7 | 長文の中の 1 件を拾い、周辺の出来事は拾わない |

全体（`overall`）: polarityErrors = 0、falseAdmissions = 0、quoteMismatchRate ≤ 0.02、overExtractionRate ≤ 0.15、candidateRecall ≥ 0.7、noChangeAccuracy ≥ 0.9。

## 評価の統計的な限界（採用判断に使う前に必ず読む）

- 現在のデータは各カテゴリ 8〜9 件（dev 4 / test 4〜5）。`test` で 0 件の誤りでも、95% 信頼の誤り率の上限はおよそ 3 / n（n=15 候補なら約 20%）。
  「誤採用率が 5% 以下」を示すには、関連する候補が約 60 件以上必要。設計書の件数（各 dev 15・test 15）でもカテゴリ単独では不足で、全体で見る。
- 誤りが 1 件でも出たら、そのカテゴリの `auto_admit` は不可。0 件でも、必要条件であって十分条件ではない（設計書 §6.4(b)）。
- 3 回の反復の最悪値で判定する（`--repeats 3`）。温度 0 でもプロバイダー側の揺れがある。
- gold は未確認（`humanReviewed: false`）。極性・modality の境界事例（二重否定、あいまい）は人手確認で `acceptable` を見直す。見直したら `datasets` の版（SHA-256）が変わるので、閾値の再承認が必要。
- 閾値の調整は dev で行う。test の結果を見て閾値・プロンプトを変えたら、その test は使い切りとし、新しいケースを足す。

## 承認の手順（人が行う）

1. `proposal-1.json` を読み、カテゴリごとの必須項目・下限を修正する（修正したら `thresholdsVersion` を上げる）。
2. `status` を `approved`、`decidedBy` と `decidedAt`（日付は人が書く）を記入して保存する。
3. その閾値を `--thresholds` に渡して `--split test --repeats 3` で実行する。結果 JSON の `thresholds.status` が `approved` であることを確認する。
4. 結果の要約を `spec/verification-status.md` に書く（stub でない・humanReviewed・件数が揃っていなければ E 段階とは書かない）。
