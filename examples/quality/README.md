# 記憶基盤・根拠選択・最終回答を分けた評価

保存・権限・引用ID・忘却・復元の正確性は、公開APIと実SQLiteの試験で検証する。意味検索は固定snapshotに対する状態・根拠選択、自然文回答は`answers.ts`の別工程で評価する。いずれかの成功を他の精度の証明にしない。

## 誤支持を主に見る

`evaluate.ts`の今後のsummaryには`retrievalDiagnostics`を保存する。保存済みの凍結実行も、モデルを再度呼ばずに再集計できる。出力先は新規ファイルに限り、元のmanifest・応答・採点を上書きしない。

```sh
bun examples/quality/retrieval-report.ts verification-reports/quality-80/final verification-reports/quality-80/new-retrieval-diagnostics.json
```

| 指標 | 分子／分母 |
| --- | --- |
| `falseSupported` | 正解がunknownまたはconflictなのにsupportedとした項目数／正解がunknownまたはconflictの項目数 |
| `unsupportedAmongSupportedByGold` | 上記の誤支持＋正解がsupportedでも必要根拠欠落・許容外IDがある項目数／supportedとした項目数 |
| `supportedEvidenceMismatch` | 正解もsupportedだが根拠IDが固定正解を満たさない項目数／supportedとした項目数 |
| `unnecessaryUnknown` | 正解がsupportedなのにunknownとした項目数／正解がsupportedの項目数 |
| `missedSupported` | 正解がsupportedなのにunknownまたはconflictとした項目数／正解がsupportedの項目数 |

明示的な否定も、質問に答える根拠があればsupportedである。率には分子・分母を必ず併記し、分母0はnullとする。応答未取得・契約違反は`unavailableCases`、回答項目数の違いは`unalignedCases`として別掲し、項目別の分母に混ぜない。後者のsupported件数も`unalignedSupportedParts`へ残す。予定件数と実施件数が違えばincompleteであり、未取得を成功やunknownとして補完しない。

項目数が一致する応答は質問順で照合する。request自体の意味のずれや、正解集合にない別の十分な根拠は、コードだけでは断定できない。したがって`unsupportedAmongSupportedByGold`は固定正解に対する診断値であり、自然文全体の未根拠断定率とは区別する。根拠不一致の原応答は人・LLMによる意味確認に回し、都合よく正解を書き換えない。`casesRequiringReview`で対象の試行を特定できる。最終回答の意味評価は校正済みの評価器による別工程を使い、評価器の一致も真実の証明にはしない。

`status: completed`は予定した応答の取得・集計が終わったことだけを表す。固定正解への全件合格は別の`qualityPassed`で示し、意味失敗があればfalseになる。誤支持率だけが低くても、未取得・項目数不一致・取りこぼしがあれば全件合格にはしない。

集計前に、正解の項目数・状態・必要／許容根拠の整合性、実在する一意なIDを検証する。空の正解と空の応答による全件合格は認めない。再集計レポートには元データのhashとは別に`analysisSourceHash`を、各入力容量測定には指示・schema・空prompt形式から計算した`inputFormatSha256`を残す。元データが同じでも集計器や入力形式が変わった実行を識別できる。

`evaluate.ts`も`answers.ts`と共通の保存処理を使い、一時ファイルへの書込み・fsync・置換と、実行単位の排他を行う。モデル呼出し前に`pending: true`を永続化し、取得した`raw`を解析前に保存する。解析失敗の原応答も残し、再開時に引き直さない。未確認のpendingや未確定の予算予約、重複・不整合な結果があれば新規呼出し前に停止する。保存失敗時は新規呼出しを止め、実行中の呼出しが終了するまで排他を保持する。異常終了後のlockは自動解除せず、原応答・APIログ・予算台帳を確認してから復旧する。新しいmanifestは既存の応答があるディレクトリへ作らない。

モデル接続の初期化は全provider分を先に完了させる。一方の設定が不足している状態で、もう一方への呼出しを開始しない。呼出し時のAPI設定不備や監査ログ・会計の保存失敗も継続不能として扱い、実行中の呼出しだけを回収して新規呼出しを止める。

## 未使用会話での採用判定

現在の`cases.ts`の120件と既知回帰80件は既に応答を見た合成データである。`fresh`は過去のsuite名で、今後の未使用holdoutとは扱わない。今回の再集計も精度改善や独立した未使用試験として数えない。`freeze`はこの由来をmanifestに記録する。

次の指示変更・取得方式変更を採用する際は、既存の凍結・実行・採点機構を再利用し、開発用データと独立した未使用会話の入力・期待する項目・必要根拠・許容根拠を最初の実行前に固定する。固有名詞だけを置換した問題は独立会話に数えない。実会話を使う場合は利用・送信の許可を確認し、試験対象モデル自身に正解を決めさせない。

誤支持を主要な採用指標とし、取りこぼし・項目分割失敗・契約違反・未取得も別に確認する。基準値と比較回数は結果を見る前に確定する。原応答を保持し、成功するまでの再生成や最良試行の選別をしない。通信障害の補完は応答未取得と確認できるものだけを別記録に残し、意味失敗は引き直さない。同じ会話の反復を独立ケースとして数えない。

## 入力容量

再集計の`currentHostInputCapacity`は、凍結ケースのitems・質問を現在のホストの入力構築処理へ渡した測定である。過去のSDK/API経路の上限や、実ユーザーの記憶件数の測定ではない。付帯情報の形も実ストアと異なりうる。実ストアでは自然文CLIの`recall-size`を使う（[手順](../../docs/cli-mcp.md#自然文cliとモデル)）。全送信データが131072 UTF-8 bytesに収まるかを質問別に測り、全件方式が限界に達してから既存のページ走査・LLMによる候補取得と比較する。ベクトル検索・永続索引は今回追加していない。

今回の保存済み応答の診断値と容量測定は[RESULTS.md](RESULTS.md)を参照。
