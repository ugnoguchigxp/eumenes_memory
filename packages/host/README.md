# Eumenes Memory CLI / MCP

Bun 1.4.4以降、SQLite 3.44以上（FTS5有効）、macOS/Linux向け。同じ本人の許可された記憶をCLIと複数のMCP接続で共有します。本体ライブラリは別パッケージのまま、モデル・接続・書込みの所有者をこのホストで管理します。

## 配布物から開始

```sh
bun add /absolute/path/eumenes-memory-host-0.2.1.tgz
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

## 予定・意図・約束（0.2.0）

`context`の`items`は既存のStateです。同じページの`agendaItems`に、予定（`plan`）、いま気にしていること（`concern`）、条件つきの依頼（`conditional_request`）、期限つきの指示（`temporary_instruction`）、エージェントの約束（`commitment`）が入ります。範囲と件数上限は両配列を合わせたものです。`nextCursor`がある間は両方を集めてください。`read`にはどちらの`itemId`も渡せます。通常の`recall`はStateを使います。

各agenda項目には次が入ります。

| 項目 | 内容 |
| --- | --- |
| `itemId`, `scopeKey`, `kind` | 永続ID、権限範囲、種類 |
| `text`, `quote`, `evidence`, `sourceRole` | 内容、原文の連続引用、版・digest・UTF-8 byte範囲を含む出典、話者（`user` / `agent`） |
| `certainty` | `confirmed`（決定・指示・約束）または `tentative`（考え中）。本人確認の権限を示すStateの`origin`とは別 |
| `time` | 時間情報がなければ`null`。あれば`{original,scheduledFor,deadline,validUntil}`。元の時の表現を`original`に残し、未確定の各値は`null`。予定日・期限・失効時刻は`YYYY-MM`・`YYYY-MM-DD`・オフセット付きISO 8601日時のうち判明している精度で保存 |
| `trigger` | `null`、`{type:"time",at}`（`time`と同じ日付・日時形式）、または`{type:"event",condition}`（出来事や話題を説明する文） |
| `status`, `updatedAtMs` | `pending`、`done`、`cancelled`と、状態が最後に変わった時刻（Unix epochミリ秒）。登録時は`pending` |

完了済み・取りやめも履歴として返します。先回りの対象は`pending`から選び、期限・失効や話題の照合は呼び出し元で判断します。

### 利用者の発言から計画する

`source`に利用者の原文を`kind:"text"`で登録し、`context`に`agenda:true`を指定すると拡張した計画スキーマと指示が返ります。TypeScriptから組み立てる場合は`eumenes-memory-host/meaning/planning`の`hostAgendaPlanningInstructions`、`modelAgendaItems(agendaItems)`、`planningSchema(ids,{quoteMode:"range",agenda:true})`、`parsePlan(raw,items,"",agendaItems)`を使います。`ids`は両配列のID、`items`と`agendaItems`はそれぞれモデル向けの投影です。自然文CLIの`plan`はこの形を使います。

モデルへの`message`の先頭に、アプリ側が作ったローカル時刻を`今: 2026-11-10T09:00:00+09:00`の形式で入れてください。`source`には時刻の前置きを足さず、利用者の原文だけを入れます。相対日時の解釈は、同じ計画のモデル呼び出しで行います。ホストは保存する日時の形式と引用範囲を検査します。

- `remember_agenda`は`{type,kind,text,certainty,time,trigger,quote,replacesItemId}`です。新規は`replacesItemId:null`、訂正は`supersedes`と対象IDを指定します。同じ種類の未完了項目を`cancelled`にし、新しいIDの項目を同じトランザクションで保存します。
- 会話だけで既存項目を終えるときは`{type:"set_agenda_status",itemId,status,quote}`と、`supersedes`、`relatedItemIds:[itemId]`を指定します。状態は`done`または`cancelled`です。
- 実行対象の`remember`、`remember_agenda`、`set_agenda_status`にそれぞれ`evidence`を付けます。TypeScriptでは`requiresQuote(action)`で判定できます。`forget`は項目を消去する操作で、状態更新と別のグループにします。

### 約束の登録と状態更新

実際に利用者へ返した全文を`source`の`kind:"agent_reply"`で登録し、返った`sourceHandle`を使います。ホストは登録された返事と引用が同じUTF-8範囲に一致することを検査します。実際に送った返事を登録する責任は認証済みの呼び出し元にあります。`agent_reply`は利用者の事実や会話からのagenda書き込みの根拠に使えません。

```json
{
  "agenda": {
    "type": "record_commitment",
    "scopeKey": "personal",
    "sourceHandle": "<登録時のハンドル>",
    "startByte": 0,
    "endByte": 48,
    "quote": "京都の朝の天気を調べておきますね",
    "text": "京都の朝の天気を調べておきますね",
    "time": null,
    "trigger": null
  }
}
```

このJSONを`apply`へ渡すと、モデルなしで`{status:"completed",itemId}`が返ります。1つの返事の同じ範囲は同じ約束を指し、同じ登録の再送ではIDと現在の状態を保持します。再起動などでハンドルが失効したら、同じ`submissionId`、scope、種類、全文で再登録して取得します。

報告済みなどの状態更新は`apply`へ`{"agenda":{"type":"set_agenda_status","scopeKey":"personal","itemId":"<ID>","status":"done"}}`を渡します。`cancelled`も指定できます。同じ状態への再送は成功し、反対の終端状態への変更は拒否されます。この2操作にはscopeのread/write権限が必要です。

### 忘却と移行

出典の消去は、その出典を使ったagenda項目にも連鎖します。会話で行った状態更新の出典も依存関係に含まれます。agenda項目だけを消すときは、同じ`plan`と`apply`で`forget`の対象にagendaのIDを選びます。出典ごと消すときは、該当の`sourceHandle`を`plan.sourceHandles`に指定します。既存のStateが同じ出典を利用する場合は、その保持と消去の衝突を従来どおり検査します。

旧ホストを停止し、DBと最新の忘却journalを揃えてバックアップしてください。0.2.0は起動時に、ホストのスキーマを1から2へ所有者のトランザクション内で移行します。既存のStateと出典を引き継ぎます。本体は同梱の`eumenes-memory@0.0.4`、本体DBスキーマは8、wire版は1です。移行後のDBは旧ホストでは開けません。journalは最新のものを保持してください。agencyの`profile.md`や`agenda-state.json`は別途移行が必要です。

0.2.1は同梱の本体を`eumenes-memory@0.0.5`（本体DBスキーマ10）に更新しました。起動時にmigration 0010（除外・抑制・記憶の候補・強度・変更フィードの列）を適用します。0010を適用したDBは0.2.0以前のホストでは開けません。ホストの操作と挙動は0.2.0のままです（0010の部品はホストからは公開していません）。

## 自然文CLI

任意のモデルを使う場合だけ、profileに`modelCommand: ["/absolute/path/to/complete-adapter"]`と`modelDailyCalls: 20`等を設定します。引数から任意コマンドやAPIキーは渡せません。実行ファイルはstdinの`{version,prompt,schema,task,instructions,maxOutputTokens}`を受け、stdoutへ`{"raw":"schemaに従うJSON文字列"}`を返します。外部Completeは指示・schema・出力上限をモデルへ渡し、providerの金額予算と資格情報を管理してください。

`plan --input -`に`{scopeKey,message,sourceHandle}`、`recall --input -`に`{scopeKey,message}`を渡します。既存の意味計画・根拠選択を使い、保存は別途applyが必要です。1操作につき1回のモデル呼出し、ストア単位の同時実行1、日次予約台帳、入力128KiB・出力64KiB・120秒上限で、自動再生成はしません。recallは回答項目ごとにsupported/unknown/conflictと根拠IDを返し、モデル待ち中の変更はstaleとして拒否します。モデル未設定でも構造化操作とMCPは利用できます。

`recall-size --input -`に`{scopeKey,message}`を渡すと、モデルを呼ばずに全件投入の容量を測定できます。件数・本文の平均文字数／bytes・p95／最大bytesと、質問・指示・schema・JSONを含む送信全体の`modelInputBytes`、`fitsModelInput`を返します。入力上限は131072 UTF-8 bytesであり、128K tokenではありません。測定の成功は入力が収まることを意味しないため、`fitsModelInput`を確認してください。snapshot上限10000項目／8MiBは、自然文recallが扱える量の保証ではありません。

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

配布物には、同梱コアの第三者表示と、ホストの実行時依存の一覧・ライセンス原文が入ります。実行時依存は `dist/runtime-notices/` から確認できます。
