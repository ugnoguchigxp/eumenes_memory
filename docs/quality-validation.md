# 検証の再現とAPI予算

配布物は `bun run verify:package` でclean build、tgz展開、source aliasの無い別ディレクトリのBun／Node consumerを検証する。保存・訂正・保持・権限境界・忘却・古いDB復元・journal破損を検査し、欠落export・欠落guide・artifact改変を負例で検出する。ソース変更を検出した実行は無効になる。開発コマンドはソースcheckoutで実行する。

`dist/release-manifest.json` は基準commit、ソースhash、版、配布ファイルの内容hashを持つ。これは署名ではなく、配布物と実行したソースの対応を確認する記録。変更したartifactはmanifestとの照合で拒否する。`THIRD_PARTY_NOTICES.md`は再実装した規則と上流commitを対応させる。本体の実行時依存はゼロ。開発依存の版・license・lock hashは `bun run check:dependencies`、既知のadvisoryは `bun audit --json` で確認し、到達可能性と更新判断を記録する。

## APIキーと実行

OpenAIは `OPENAI_API_KEY`、Claudeは `ANTHROPIC_API_KEY` を使用する。既存の `OPEN_AI_API_KEY`／`CLAUDE_API_KEY` も読める。キーの定義をプロジェクトへ複製しない。ログイン環境で定義済みならその環境を継承する。この作業環境のGUI実行では `~/.local/bin/with-api-keys` をコマンドの前に付けると、共通の `.zprofile` を読み込める。

```sh
bun run eval:memory:preflight
bun run eval:memory:freeze
bun run eval:memory:pilot
bun run eval:memory:calibrate
bun run eval:memory:lifecycle
bun run eval:memory:run
bun run eval:memory:answers
bun run bench:memory
```

最初のpreflightも有料APIの利用に含む。モデルはLuna `gpt-6-luna` とClaude `claude-sonnet-5-5`。渡すデータは固定の合成データであり、原会話やseed、プロジェクトのソース本文を自動で送信しない。モデルにshell／file／network toolの実行権限を渡さない。保存や忘却は検査済みの計画だけをホストが公開APIで適用する。

## 10 USDの上限

全工程は `verification-reports/quality-80/cost-ledger.json` の一つの予算を共有する。各dispatch前に保守的な最大費用を予約し、原usageで精算する。上限は10 USDで、同じ台帳を開き直しても残高を保持する。台帳を消して再開すると上限の保証が失われるため、自動で初期化しない。

原usage、cache read／write、課金対象出力を分け、reasoningを出力と二重計上しない。モデルの長文・cache writeの上限単価で予約する。Claudeの明示した5分cacheは同じ入力の連続反復に使用し、cache生成と読取を実際のusageで記録する。API応答のusage欠落や通信状態不明は予約を残して次の呼び出しを止める。秘密のheaderやキーをログへ保存しない。

結果が意味的に不合格でも引き直さない。拒否、未完了、契約違反、通信失敗、費用停止を「不明な事実」や成功へ置き換えない。評価器は40の固定対照で校正し、校正に落ちた評価器の判断で合否を確定しない。両モデルの評価不一致は残し、同一の実装者による点検を独立した人間評価とは呼ばない。

## 結果の読み方

新規120ケースと既知回帰80ケースを分離する。各3反復は同じ問題の揺れの測定であり、独立した600問題ではない。指示が変わらないときは同じ指示を「旧新」と呼んで比較しない。最終回答の評価は正しい事実を与える条件を別に測り、取得から最終回答までの精度と混同しない。

1000件以下の運用条件と10000件のstressを区別する。SQLiteのwarm／最初の読取、変更と閉包、RSS、モデルAPI時間・token・費用を分けて記録する。最初の読取はOSのcold cacheを保証しない。検証結果は実行環境・source hash・ケースhash・モデルとともに報告し、未実行を通過扱いしない。
