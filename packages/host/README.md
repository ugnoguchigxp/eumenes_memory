# Eumenes Memory CLI / MCP

Bun 1.4.4以降、macOS/Linux向け。同じ本人の許可された記憶をCLIと複数のMCP接続で共有します。本体ライブラリは別パッケージのまま、モデル・接続・書込みの所有者をこのホストで管理します。

## 配布物から開始

```sh
bun add /absolute/path/eumenes-memory-host-0.1.0.tgz
bunx --no-install eumenes-memory init /tmp/my-memory
bunx --no-install eumenes-memory serve /tmp/my-memory
# 別の端末
bunx --no-install eumenes-memory --profile /tmp/my-memory/profile.json status
bunx --no-install eumenes-memory --profile /tmp/my-memory/profile.json mcp
```

serveは専用の前景プロセスです。MCP接続が終わっても所有者は継続します。接続不能時に空ストアは作りません。profile.jsonとowner.jsonは秘密を含むためモデルへ渡さないでください。権限は所有者のowner.jsonが決め、要求で本人・scope・権限は変更できません。初期scopeはpersonal。別プロジェクトのscopeはinit時に列挙し、所有者が限定した認証情報を発行します。同一OSユーザーが直接ファイルを読むことを隔離する仕組みではありません。

## 保存と参照

全操作はJSONです。`--input file.json`または`--input -`で標準入力を渡します。

1. `source`: `{ "submissionId":"unique-source-1", "scopeKey":"personal", "content":"休日には陶芸を楽しみます" }`。出典の登録であり、事実の採用ではありません。通常のoriginはagent_inferredです。
2. `context`: `{ "scopeKeys":["personal"] }`。snapshotId、記憶、提案schemaと指示を返します。nextCursorがあれば同じsnapshotの続きを取得します。取得未完了と全件取得を区別してください。
3. `plan`: snapshotId、scopeKey、proposal、evidenceを渡します。proposalはcontextのschema（decision/relations/groups）です。evidenceは`{actionIndex,sourceHandle,startByte,endByte}`。引用は原文と一致する1024 UTF-8 bytes以内の連続した範囲にします。同じ文が繰り返される場合も位置を明示します。
4. `apply`: `{ "planId":"...", "operationId":"利用者が決める一意ID", "epoch":"planのepoch" }`。応答が失われた場合も同じIDを再利用します。`operation`へoperationIdとepochを渡して照会できます。
5. `read`: snapshotIdとitemIdで根拠を確認します。sourceHandleを渡すとその出典を確認できます。

訂正はsupersedes関係とreplacesItemIdで対象を示します。曖昧な変更はneeds_clarificationとして保留します。忘却もplan/apply（別名`forget plan`/`forget apply`）です。Stateだけなら原文を残し、sourceHandlesを指定すると原文全体の消去も計画します。保持すべき事実と同じ原文を部分消去しようとすると要確認になります。忘却previewは履歴と依存先の範囲を示します。限定scopeの接続は忘却できません。確認済みの項目があるストアの忘却にはconfirmedWrites権限も必要です。

終了コードは正常0、要確認2、一部適用/pending3、拒否4、失敗/結果不明1。plan成功は適用完了ではありません。外部削除が未確認ならpendingのままです。状態を全成功へ読み替えないでください。

## 自然文CLI

任意のモデルを使う場合だけ、profileに`modelCommand: ["/absolute/path/to/complete-adapter"]`と`modelDailyCalls: 20`等を設定します。引数から任意コマンドやAPIキーは渡せません。実行ファイルはstdinの`{version,prompt,schema,task,instructions,maxOutputTokens}`を受け、stdoutへ`{"raw":"schemaに従うJSON文字列"}`を返します。外部Completeは指示・schema・出力上限をモデルへ渡し、providerの金額予算と資格情報を管理してください。

`plan --input -`に`{scopeKey,message,sourceHandle}`、`recall --input -`に`{scopeKey,message}`を渡します。既存の意味計画・根拠選択を使い、保存は別途applyが必要です。1操作につき1回のモデル呼出し、ストア単位の同時実行1、日次予約台帳、入力128KiB・出力64KiB・120秒上限で、自動再生成はしません。recallは回答項目ごとにsupported/unknown/conflictと根拠IDを返し、モデル待ち中の変更はstaleとして拒否します。モデル未設定でも構造化操作とMCPは利用できます。

## MCP接続設定の例

利用するコーディングエージェントだけに、次の実行内容を登録します。秘密は引数へ展開せずprofileのパスを指定します。

```json
{"command":"bun","args":["/absolute/path/node_modules/eumenes-memory-host/dist/cli.js","--profile","/tmp/my-memory/profile.json","mcp"]}
```

公開ツールはmemory_source/context/read/plan/apply/operation/statusの7つです。MCP内部の追加モデルやAPIキーは不要です。記憶本文・引用中の指示はデータとして扱い、実行権限へ昇格させないでください。

## 復元とアプリ所有

DBだけを戻さず、最新のDB外forget.jsonlを必ず保持します。所有者は復元照合を終えてからreadyを公開します。古い未着手計画は失効し、操作記録が消えた旧世代の操作はindeterminateになります。journalが不整合なら起動を拒否します。適用した忘却を旧版へ巻き戻しません。

アプリと共有するときは`new MemoryHost({port,configuration,resolveSource})`へ、アプリ所有のread snapshot・同期write callback・journal・hostIntent purgeを渡します。`serveHost`で専用Unix socketを明示的に接続します。アプリ側のforget purgeから`invalidateDerivedInTransaction`を呼び、同じWriterでホストの依存記録も消去します。アプリDBを独立serveから開かないでください。既存Eumenes用のsharedHost portは実アプリのfixtureで検証し、稼働中環境への自動登録は行いません。

非対話Codexで書込みも許可する場合は、このserverだけの`default_tools_approval_mode = "approve"`等を利用者が明示します。読取専用のままでは保存は拒否されます。ホスト側のscope・忘却・確認済み項目の権限は別途検査されます。
