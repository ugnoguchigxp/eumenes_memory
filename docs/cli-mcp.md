# CLIとメモリーMCP

CLIとMCPは`packages/host`の共通ホストを利用する。本体の同期API・DB schemaと実行時依存は変えず、BunとMCP SDKの依存を別のホスト配布物に置く。

## 導入

ソースcheckoutでは次の順で用意する。

```sh
bun install --frozen-lockfile
bun run build:host
bun run pack:host
```

`artifacts/host/eumenes-memory-host-0.1.0.tgz`に、実行用JavaScript・型・本体の実行用ファイルとライセンス・導入手順・内容hash一覧を含める。利用環境にソースcheckoutは必要ない。

```sh
bun add /absolute/path/eumenes-memory-host-0.1.0.tgz
bunx --no-install eumenes-memory init /tmp/shared-memory
bunx --no-install eumenes-memory serve /tmp/shared-memory
# 別端末
bunx --no-install eumenes-memory --profile /tmp/shared-memory/profile.json status
```

macOS/Linuxの同じOSユーザー向け。所有者は明示的に起動し、Unix socketと専用DB/journalを所有する。プロファイルの接続先が停止しても空の記憶へ自動切替しない。プロジェクト情報は許可scopeで分離する。owner.jsonに設定したgrantを操作ごとに再検査し、任意の要求から本人・scope・originを変更できない。

## 利用の流れ

すべての操作はJSON入力（`--input file.json`または`--input -`）・JSON出力。source→context→plan→applyを使う。source登録と事実の採用を区別する。contextは原文の指示を実行権限として扱わず、origin、主体、期間、revision、取得範囲、提案schemaと指示を返す。呼出し元モデルが意味を判断し、ホストは出典と変更の契約を検査する。

planのproposalはdecision/relations/groups、evidenceはactionIndex/sourceHandle/startByte/endByte。引用は原文の連続した1024 UTF-8 bytes以内。複数回出現する文も位置を明示し、無効な引用は修正せず拒否する。訂正はsupersedesとreplacesItemId、意味の異なる共存はcoexists、未解決の矛盾はconflictsとclarificationで表す。

applyはplanId/operationId/epochを受ける。操作IDは呼出し前に保持し、応答を失ったら同じIDでoperationを照会・applyを再送する。結果照会を古い計画の拒否より先に行うため、成功済み操作を再実行しない。古いDB復元で操作記録が不在の旧世代はindeterminateになり、未実行と断定しない。

忘却も同じplan/applyで、`forget plan`/`forget apply`は別名。Stateの忘却とsourceHandlesによる原文全体の消去を区別する。保持したい事実の原文を一緒に消す提案や、相互依存する保存/忘却の混在groupは要確認。限定scopeのクライアントに閉包の件数や外部IDを返す前に拒否する。確認済み項目を保護する権限も別に検査する。

終了コードは正常0、要確認2、部分適用/pending3、拒否・stale4、失敗/結果不明1。正常なplanは適用完了を意味しない。外部削除がpendingなら、ローカルの削除が済んでも全体完了にしない。

## MCP

既存のチャットや利用者設定は自動変更しない。接続したいエージェントで次の実行内容を指定する。

```json
{"command":"bun","args":["/absolute/path/node_modules/eumenes-memory-host/dist/cli.js","--profile","/tmp/shared-memory/profile.json","mcp"]}
```

公開ツールはmemory_source/context/read/plan/apply/operation/status。公式MCP SDK 2.4.0のstdioで、接続プロセスは所有者へ中継する。接続を一つ閉じても所有者と他のクライアントは動く。stdoutに診断ログを混ぜない。MCP側の追加モデルやAPIキーは不要。

## 自然文CLIとモデル

自然文planは`{scopeKey,message,sourceHandle}`、recallは`{scopeKey,message}`。利用者がprofileへmodelCommandとmodelDailyCallsを明示した場合のみ、外部Completeを1回呼び出す。既存の計画parser、意味指示、根拠選択を共用し、発話別の条件分岐を持たない。モデルなしの構造化操作も利用できる。

Completeはstdinのversion/prompt/schema/task/instructions/maxOutputTokensを受け、stdoutへ`{"raw":"schema準拠JSON文字列"}`を返す。資格情報・provider金額予算はCompleteが所有する。ホスト側は入力128KiB・出力64KiB・120秒、同時実行1、永続台帳で日次回数を予約する。自動再生成は行わない。recallはsupported/unknown/conflictを項目ごとに返し、返却前の状態照合でモデル待ち中の変更を拒否する。

## アプリとの共有と復元

アプリ所有のDBでは、CLIからDBを開かず、アプリの既存Writer/readSnapshot/journal/purgeをMemoryHostへ渡す。実EumenesのMemoryService.sharedHostがこのportを公開する。アプリのforget purge hookからMemoryHost.invalidateDerivedInTransactionを呼ぶ。アプリ出典はsharedHost.resolveSourceで解決し、hostIntentは同じtransaction内でアプリ由来の派生物とforget fenceへ再適用する。接続transportの開始はアプリの所有者が明示的に行う。

最新のDB外journalを保持してからDBを復元する。所有者はjournal照合、完全な消去意図の再開、アプリ由来の消去を終えてreadyになる。journalが不整合なら起動を拒否する。記憶の本文を含む計画・実行payloadにも寿命と忘却依存を持たせ、使用済み操作IDと本文を分離する。

## 検証

```sh
bun run verify
bun run verify:package
bun run verify:host
EUMENES_CHECKOUT=/absolute/path/eumenes bun test packages/host/test/eumenes.integration.test.ts
bun run check:host:live  # 明示実行。最大11回のCodex subscription turn、自動再試行なし
```

部分・結合・配布物の順に検証する。verify:hostはcheckout外へ配布物をインストールし、CLIと別プロセス2つのMCPで保存・訂正・忘却・再起動・旧操作IDを試す。配布物の改変を検出する対照試験も行う。CIはLinux/macOSで本体とホスト両方を検査する。

実Eumenes試験は実ソースと既存SQLite所有者を使う使い捨てfixtureで、稼働中サービスの導入試験とは区別する。live試験は一時設定の新規Codex CLI、4つの合成質問による旧/新取得方式の比較、新指示の出典有効性2ケースの確認であり、大規模な品質優位を証明するものではない。結果・版・使用量・遅延・採否条件はverification-reports/hostに保存する。

非対話のCodex CLIでは、読み取り専用の許可設定のままだとmemory_source/plan/applyが拒否される。保存も行う接続に限り、利用者が認めたMCP serverの`default_tools_approval_mode = "approve"`等を設定する。これはホストのscopeやconfirmedWritesを拡張せず、所有者のgrantを別途必要とする。実際の設定名と対応版は[Codex MCPの設定](https://learn.chatgpt.com/docs/extend/mcp)で確認できる。


出典が変更・消去された記憶は、`context`と`read`の`item.evidenceStatus`で区別する。`current`だけを回答の根拠にできる。`stale`は版やdigestの不一致、`missing`は出典が利用できない状態、`unverified`は照合できる出典resolverがない状態を表す。本文の意味や正しさを保証する値ではない。自然文の`recall`は、無効な根拠をモデルが引用すると`EVIDENCE_UNAVAILABLE`で拒否する。訂正・忘却の対象を特定するためのIDは引き続き利用できる。

外部コピーの削除待ちは`operation`で再照会できる。再起動で原文を含む実行詳細が消えていても、保存した処理結果と現在の削除証明から完了を確認する。古い記録に判定材料が残っていない場合は`indeterminate`を返し、成功を推測しない。忘却は過去・停止中の確認済みデータにも影響するため、`confirmedWrites`権限の検査対象には履歴も含まれる。


再レビューでは、保存したStateの生成元計画にも削除依存を登録し、実行詳細が残る間は計画のTTL後も維持するよう修正した。旧形式の計画は出典との関連を辿って本文を消去するため、同じ出典に由来する未適用計画は破棄される場合がある。別の保存済みの事実は保持する。一部表示でも項目と出典の版を再照合し、重複した訂正対象は適用前に拒否する。

初期化先に予約済みのファイルやsymlinkがある場合は、書き込まずに拒否する。CLI入力とIPC応答、外部Completeの出力は読取り中にサイズ上限を検査する。Completeの期限超過は`failed/MODEL_TIMEOUT`となり、配下のプロセスも停止する。
