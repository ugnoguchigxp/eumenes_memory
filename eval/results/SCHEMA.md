# 結果 JSON の形式（schemaVersion 1）

`bun eval/run.ts --name <name>` が `eval/results/<name>.json` に書く。時刻・乱数を含まない（同じデータ・同じアダプター出力なら同一）。
設計書 §4 は `<date>-<extractorId>-<promptVersion>.json` を想定しているが、時刻を使わない方針のため `--name` に自分で日付・extractorId・promptVersion を入れる
（例 `20261101-larm-p3`）。

```jsonc
{
  "schemaVersion": 1,
  "name": "selfcheck",
  "dataset": {
    "id": "ja-memory-v1",
    "path": "eval/datasets/ja-memory-v1.jsonl",
    "sha256": "<データセットファイルの SHA-256 hex。データセット版>",
    "split": "all",                      // dev | test | all
    "cases": 124,
    "casesPerCategory": { "negation": 9, "...": 0 },
    "humanReviewed": false               // 選んだケースのすべてが true のときだけ true
  },
  "adapter": {
    "path": "eval/adapters/oracle.ts",
    "extractorId": "eval-oracle",
    "promptVersion": "oracle-1",
    "providerRef": "none",
    "modelId": null,                     // アダプターが modelId を出していれば文字列
    "stub": true                         // stub は E 段階の根拠にしない
  },
  "run": {
    "repeats": 1,
    "timeoutMs": 120000,
    "policy": { "preference": "auto_admit", "...": "..." }   // settle に渡した方針（最悪ケース）
  },
  "claims": {
    "eStageEligible": false,             // 機械判定。README の E 段階の条件をすべて満たすときだけ true
    "reasons": ["stub adapter: ...", "gold is not human reviewed ...", "..."]
  },
  "thresholds": null,                    // --thresholds を渡したときだけ: 下の Thresholds
  "overall": { "worst": Metrics, "perRepeat": [Metrics] },
  "categories": { "<category>": { "worst": Metrics, "perRepeat": [Metrics] } },
  "cases": [
    {
      "id": "neg-01", "category": "negation", "split": "dev",
      "runs": [                          // 反復ごと
        { "outcome": "applied", "emitted": 1, "flags": [] }
      ]
    }
  ]
}
```

## Metrics

件数（整数。ケースをまたいで合算）:

| キー | 意味 |
|---|---|
| `cases` | ケース数 |
| `goldCandidates` | gold 候補数（`acceptNoChange` で候補を出さなかったケースの gold は除く） |
| `emittedCandidates` | アダプターが出した候補数 |
| `candidatesWithBadEvidence` | 根拠の quote が byte 範囲と一致しない（範囲外・空を含む）候補。以降の指標に入れない |
| `matched` | 候補の一致（gold に候補が割り当てられた） |
| `fullMatch` | matched のうち属性がすべて正しい |
| `kindErrors` `subjectErrors` `polarityErrors` `modalityErrors` `temporalErrors` | matched の対の属性誤り（`acceptable` で許容された値は誤りにしない） |
| `missed` | 割り当てられなかった gold（アダプター失敗・settle の rejected_output のケースを含む） |
| `overExtracted` | どの gold にも割り当てられない候補（過剰抽出。tolerated は除く） |
| `duplicates` | overExtracted のうち、gold と重なるが別の候補が先に割り当てられていたもの |
| `tolerated` | tolerated の範囲と重なる候補（過剰にも誤採用にも数えない） |
| `acceptedNoChangeCases` | `acceptNoChange` で候補を出さず、許容されたケース |
| `noChangeCases` / `noChangeCorrect` | 期待が noChange のケース数 / 結果が applied かつ候補 0 件のケース数 |
| `adapterFailures` | アダプターの例外・タイムアウト（settle は呼ばない） |
| `rejectedOutputs` | settle が `rejected_output` を返したケース |
| `admitted` `pendingUser` `rejected` | settle が返した件数の合計（方針は `run.policy`） |
| `falseAdmissions` | `admitted` のうち、属性がすべて正しく gold に割り当てられていないもの（tolerated を除く） |

比率（小数。分母 0 は `null`）: `candidateRecall`（matched / goldCandidates）、`fullMatchRate`、`overExtractionRate`（overExtracted / emittedCandidates）、
`quoteMismatchRate`（candidatesWithBadEvidence / emittedCandidates）、`noChangeAccuracy`、`falseAdmissionRate`（falseAdmissions / admitted）。

`worst`: 反復ごとの Metrics から指標ごとに悪い方を取ったもの（`matched` `fullMatch` `noChangeCorrect` `candidateRecall` `fullMatchRate` `noChangeAccuracy` は最小、それ以外は最大）。
反復が 1 回なら `perRepeat[0]` と同じ。

## cases[].runs[].flags

属性名と添字だけ（本文を含まない）: `<attribute>:<gold index>`（属性誤り）、`missed:<gold index>`、`over:<出力の添字>`、`bad_evidence:<出力の添字>`、
`false_admission:<出力の添字>`、`missed_all`、`accepted_no_change`、`expected_no_change`、`adapter_failed`、`rejected_output`。

## Thresholds

```jsonc
{
  "path": "eval/thresholds/proposal-1.json",
  "sha256": "<閾値ファイルの SHA-256 hex>",
  "version": "proposal-1",
  "status": "proposal",                  // proposal | approved
  "decidedBy": null, "decidedAt": null,
  "pass": true,
  "failures": [ { "scope": "negation", "metric": "polarityErrors", "value": 1, "bound": { "max": 0 } } ]
}
```

閾値ファイルの形（`eval/thresholds/*.json`）: `thresholdsVersion`、`status`、`decidedBy`、`decidedAt`、`rationale`、`overall`（指標名 → `{min?, max?}`）、
`categories`（カテゴリ名 → 同じ形）。判定は `worst` の値に対して行い、分母 0（`null`）の指標は判定しない。
