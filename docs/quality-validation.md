# 検証の再現とAPI予算

配布物は `bun run verify:package` でclean build、tgz展開、source aliasの無い別ディレクトリのBun／Node consumerを検証する。保存・訂正・保持・権限境界・忘却・古いDB復元・journal破損を検査し、欠落export・欠落guide・artifact改変を負例で検出する。ソース変更を検出した実行は無効になる。開発コマンドはソースcheckoutで実行する。

`dist/release-manifest.json` は基準commit、ソースhash、版、配布ファイルの内容hashを持つ。これは署名ではなく、配布物と実行したソースの対応を確認する記録。変更したartifactはmanifestとの照合で拒否する。`THIRD_PARTY_NOTICES.md`は再実装した規則と上流commitを対応させる。本体の実行時依存はゼロ。開発依存の版・license・lock hashは `bun run check:dependencies`、既知のadvisoryは `bun audit --json` で確認し、到達可能性と更新判断を記録する。

## APIキーと実行

OpenAIは `OPENAI_API_KEY`、Claudeは `ANTHROPIC_API_KEY` を使用する。既存の `OPEN_AI_API_KEY`／`CLAUDE_API_KEY` も読める。キーの定義をプロジェクトへ複製しない。ログイン環境で定義済みならその環境を継承する。この作業環境のGUI実行では `~/.local/bin/with-api-keys` をコマンドの前に付けると、共通の `.zprofile` を読み込める。

```sh
bun run eval:memory:preflight
bun run eval:memory:freeze
bun run eval:memory:pilot
bun run eval:memory:lifecycle
bun run eval:memory:run
bun run eval:memory:answers:freeze verification-reports/quality-80/answers
bun run eval:memory:calibrate verification-reports/quality-80/answers
bun run eval:memory:answers verification-reports/quality-80/answers
bun run bench:memory
```

最初のpreflightも有料APIの利用に含む。モデルはLuna `gpt-6-luna` とClaude `claude-sonnet-5-5`。渡すデータは固定の合成データであり、原会話やseed、プロジェクトのソース本文を自動で送信しない。モデルにshell／file／network toolの実行権限を渡さない。保存や忘却は検査済みの計画だけをホストが公開APIで適用する。

## 10 USDの上限

全工程は `verification-reports/quality-80/cost-ledger.json` の一つの予算を共有する。各dispatch前に保守的な最大費用を予約し、原usageで精算する。上限は10 USDで、同じ台帳を開き直しても残高を保持する。台帳を消して再開すると上限の保証が失われるため、自動で初期化しない。

原usage、cache read／write、課金対象出力を分け、reasoningを出力と二重計上しない。モデルの長文・cache writeの上限単価で予約する。Claudeの明示した5分cacheは同じ入力の連続反復に使用し、cache生成と読取を実際のusageで記録する。API応答のusage欠落や通信状態不明は予約を残して次の呼び出しを止める。秘密のheaderやキーをログへ保存しない。

通信不明の予約は0へ精算しない。実行中のrequestが無く、外部の変更を伴わない評価だったことを担当者が確認した場合だけ、`acknowledgeHeldUncertainty`で確認理由を記録して継続できる。不明requestの最大費用は全額残り、次のdispatchもその額を差し引いた10 USD内に制限する。予約額を超えた請求や実行中のrequestがある状態では解除できない。失敗した試行は保持し、成功したように書き換えない。

結果が意味的に不合格でも引き直さない。拒否、未完了、契約違反、通信失敗、費用停止を「不明な事実」や成功へ置き換えない。評価器は64の固定対照で校正し、校正に落ちた評価器の判断で合否を確定しない。両モデルの評価不一致は残し、同一の実装者による点検を独立した人間評価とは呼ばない。

自然文回答は専用の`answer-manifest.json`に、ソース・モデル・回答指示・評価指示・全問題・校正対照・予算ディレクトリを固定してから実行する。変更後の結果を過去の途中結果に混ぜず、新しい実行ディレクトリに保存する。校正は従来の40対照に構造化された24対照を加えた64件。合格一致率95%以上・危険な誤合格0件に加え、追加の境界対照は全件正解を開始条件にする。

追加のAPI予算を明示的に許可された場合は、`eval:memory:answers:freeze <新しい実行ディレクトリ> <追加予算ディレクトリ>`で別の10 USD台帳を指定できる。旧台帳の上限や精算値は変更しない。追加予算内で指示候補を比較するときは、実行ディレクトリを分けても同じ追加予算ディレクトリを使う。候補ごとに予算台帳を作り直さない。

回答の生成直後、各評価器の採点直後に個別保存する。採点が失敗しても回答と既に得た採点を保持し、失敗した回答を再生成しない。未確認の実行中状態が残る場合は、台帳と原応答を確認するまで自動再開しない。実行完了と品質合格を別に集計し、不一致や不合格があっても全問題の観測結果を残す。

実行ディレクトリ内の`answer-run.lock`で固定・校正・回答・再開操作を排他制御する。校正でも送信前の状態を保存し、保存済みの回答・採点・対照のIDと件数・型・再開履歴を読み直して確認する。中断後のロックや未確認の送信記録は自動で削除しない。稼働中の処理がないことと、台帳・原応答の対応を確認してから扱う。APIログを開けない設定は送信前に停止し、精算に失敗しても受信済みの応答はログに残す。

通信や一時的なサービス障害で採点結果を得られなかった場合は、担当者の確認後に`resumeTransientStages`で未完了の採点だけを再開できる。生成済みの回答と取得済みの採点は使い続け、以前のエラーは履歴に残す。再開は各試行2回までで、意味上の不合格・拒否・出力打切り・契約違反を合格にするための再生成には使えない。費用停止で送信されていなかった処理の再開も、同じ台帳の残額内に限定する。

設定・認証・HTTP・通信・保存の失敗が出た実行は、既に送信した処理の保存を終えてから停止する。台帳が保留中、または未精算の予約がある場合は新たに送信しない。HTTP 429・500・502・503・504の未取得の採点は明示的な再開対象にできるが、`Retry-After`がある場合は[HTTP仕様](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)に従って再開可能な時刻を保存し、その時刻より前の再開を拒否する。自動リトライは行わない。

## 結果の読み方

新規120ケースと既知回帰80ケースを分離する。各3反復は同じ問題の揺れの測定であり、独立した600問題ではない。指示が変わらないときは同じ指示を「旧新」と呼んで比較しない。最終回答の評価は正しい事実を与える条件を別に測り、取得から最終回答までの精度と混同しない。

自然文回答の修正後の評価では、従来の固定40問×2生成モデル＝80回答を維持する。別途、新しい12問×2モデル＝24回答と、診断した4問の追加2反復×2モデル＝16回答を分離して記録する。各回答を両モデルが採点する。追加反復を新しい独立問題として数えず、既知問題での改善を未知問題の精度向上とは呼ばない。

1000件以下の運用条件と10000件のstressを区別する。SQLiteのwarm／最初の読取、変更と閉包、RSS、モデルAPI時間・token・費用を分けて記録する。最初の読取はOSのcold cacheを保証しない。検証結果は実行環境・source hash・ケースhash・モデルとともに報告し、未実行を通過扱いしない。
