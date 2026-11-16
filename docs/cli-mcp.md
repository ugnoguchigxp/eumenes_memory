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

sourceは任意の`provenance`（`user_message`・`agent_reasoning`・`tool_result`・`web`・`other_agent`・`import`・`unknown`、既定`unknown`）を受ける。呼出し側の自己申告で、ホストは確かめない。由来は信頼を下げる方向にだけ効き、どの申告でもoriginは`agent_inferred`のまま。context・readのitemには`trust`（`confirmed`: 本人確認済み、`inferred`: 根拠がすべて`user_message`か`agent_reasoning`、`external`: それ以外）が付く。外部由来の根拠だけでは`constraint`を保存できず、外部由来でないitemを置き換えられない（`EXTERNAL_EVIDENCE_NOT_ALLOWED`）。

planのproposalはdecision/relations/groups、evidenceはactionIndex/sourceHandle/startByte/endByte。引用は原文の連続した1024 UTF-8 bytes以内。複数回出現する文も位置を明示し、無効な引用は修正せず拒否する。訂正はsupersedesとreplacesItemId、意味の異なる共存はcoexists、未解決の矛盾はconflictsとclarificationで表す。

applyはplanId/operationId/epochを受ける。操作IDは呼出し前に保持し、応答を失ったら同じIDでoperationを照会・applyを再送する。結果照会を古い計画の拒否より先に行うため、成功済み操作を再実行しない。古いDB復元で操作記録が不在の旧世代はindeterminateになり、未実行と断定しない。操作の受領記録は30日保持し、今の起動世代（epoch）の記録も30日で消す。消した後に来た古いIDには`indeterminate`/`OPERATION_RECEIPT_EXPIRED`を返し、再実行しない。1世代の記録の上限（`operationsPerEpoch`）は保持中の記録で数えるので、古い記録を消せば回復する。

忘却も同じplan/applyで、`forget plan`/`forget apply`は別名。Stateの忘却とsourceHandlesによる原文全体の消去を区別する。保持したい事実の原文を一緒に消す提案や、相互依存する保存/忘却の混在groupは要確認。限定scopeのクライアントに閉包の件数や外部IDを返す前に拒否する。確認済み項目を保護する権限も別に検査する。

終了コードは正常0、要確認2、部分適用/pending3、拒否・stale4、失敗/結果不明1。正常なplanは適用完了を意味しない。外部削除がpendingなら、ローカルの削除が済んでも全体完了にしない。

## MCP

既存のチャットや利用者設定は自動変更しない。接続したいエージェントで次の実行内容を指定する。

```json
{"command":"bun","args":["/absolute/path/node_modules/eumenes-memory-host/dist/cli.js","--profile","/tmp/shared-memory/profile.json","mcp"]}
```

公開ツールはmemory_source/context/search/read/plan/apply/operation/status/use。公式MCP SDK 2.4.0のstdioで、接続プロセスは所有者へ中継する。接続を一つ閉じても所有者と他のクライアントは動く。stdoutに診断ログを混ぜない。MCP側の追加モデルやAPIキーは不要。

## バックアップと復元

`eumenes-memory --profile <profile.json> backup`は、所有者がwriterの順番で読取専用の別接続から`VACUUM INTO`し、owner.jsonの`backupDirectory`（`init`の`--backups`、既定は隣の`<名前>-backups`）に置く。管理用（全scopeとforgetAllのgrant）でMCPには出さない。出力は`path`・`bytes`・`sha256`・`schemaVersion`・`journalHead`。忘却ジャーナルの写し（本文を含まない）を同じ組で置き、7世代を残して古いものは0で上書きしてから消す。`status`は`lastBackupAt`と、36時間を超えると`backupOverdue: true`を返す。日次の実行（例: JST 4:00）はホストの外の定期実行からこのCLIを呼ぶ。

忘却をcommitした後、所有者はそれより前のバックアップを洗い直す（一時的な場所で最新のジャーナルを再適用し、`VACUUM INTO`で作り直して原子的に置き換え、古い中身を0で上書きする。応答は待たせない）。失敗したバックアップには印を付け、`status`の`backupScrubPending: true`で知らせ、作成から7日で必ず消す。OSのsnapshot、ファイルシステムの空き領域、利用者が別の場所に写したものは保証の外。

`eumenes-memory restore <backup.db> <directory>`はサーバーを止めて行う（動いていれば`OWNER_ALREADY_RUNNING`）。sha256を照合し、ライブの`forget.jsonl`を優先する（失われていればバックアップの写しのうち最新を使う）。ジャーナルの先頭がバックアップの`journalHead`より古ければ`JOURNAL_OLDER_THAN_BACKUP`で止める。今のDBとWALは`restore-<時刻>/`へ退避し、バックアップを`memory.db`に置いて所有者を一度起動し、schemaの検査とジャーナルの再適用を通す。退避したファイルは、`status`と`context`で確認した後に利用者が0で上書きして消す。

## 容量

`status`は読取のgrantがあれば`capacity`を返す。許可されたscopeごとのactive件数、kind別・`trust`別のactive件数、State行の状態別件数（active/superseded/forgotten）、DBとWALのバイト数、上限ごとの使用量（`snapshotItems`・`snapshotBytes`・`maxSources`・`operationsPerEpoch`・`maxJournalEntries`）。本文は出さない。`snapshotBytes`は本文と属性の長さに1件あたり700バイトを足した見積もり。上限の70%と90%を超えると`capacityWarnings`に`{limit, level, ratio}`を出す。`snapshotItems`か`snapshotBytes`が90%以上のときは、新しいkeyの保存（`replacesItemId: null`の`remember`）だけを`plan`で`CAPACITY_NEAR_LIMIT`として止める。訂正と忘却は通す。

## 外部由来の記憶の期限と利用の報告

`trust: external`のitemは、最後に再利用された日（無ければ作成日）から90日で停止する（`deactivateState`。忘却ではなくジャーナルを使わない）。itemには停止する日`expiresOn`（JSTの日付）が付く。再利用に数えるのは次の2つだけ。

- `use`（MCP `memory_use`）: 回答や行動に採用した後に`{"snapshotId": ..., "items": [{"itemId": ..., "revision": ...}]}`（20件まで）を報告する。snapshotにあり、revisionが今のものと一致するitemだけを受け付け、1つでも合わなければ全体を拒否する。読取のgrantで呼べる。最終利用日は外部由来のitemだけに日単位で持ち、1日に1回まで更新する。Stateの変更のseqを進めないので、snapshotとcursorは切れない。
- 適用が完了したplanの`relatedItemIds`（関係がforgetのものを除く）。

`context`・`read`・未適用の`plan`は期限を延ばさない。停止は所有者の起動時と、`eumenes-memory --profile <profile.json> expire`（管理用、1回500件まで）で行う。日次の`backup`と同じ定期実行から呼ぶ。停止したitemは`eumenes-memory --profile <profile.json> reactivate --input <file>`（`{"itemId": ...}`、管理用）で戻せ、戻した日から90日を数え直す。最終利用日はitemの忘却で一緒に消える。

## 検索

`eumenes-memory --profile <profile.json> search --input <file|->`（MCP `memory_search`）は、許可されたactiveなStateを全文検索する読み取り専用の操作（読取のgrantで呼べる。Stateの変更のseqも操作の記録も変えない）。入力は`{"query": "...", "scopeKeys"?: [...], "kinds"?: [...], "subject"?: "self"|"other:...", "limit"?: 1〜20, "maxBytes"?: 16384〜65536}`。`kinds`は重複なし、`subject`の`other:`の後ろは1文字以上で、全体はUTF-8で128 byteまで（制御文字とlone surrogateは不可）。違反は`INVALID_INPUT`。

- 件数は20件まで（既定20、設定でも緩められない）。返すitemのJSONの合計は`maxBytes`（既定32768）まで。`moreAvailable: true`は「語を足すか`kinds`/`subject`/`scopeKeys`で絞る」の合図で、続きのcursorは出さない。`truncatedBy`は`count`、`bytes`、`null`のどれか。
- queryは256文字かつ1024 Bまで。空白（U+0020、U+3000、タブ）で語に分け、重複を除き8語まで、1語64文字まで。語はすべてANDで、FTSの構文（`OR`、`NOT`、`"`、`*`、`col:`など）はただの文字として扱う。違反は`QUERY_INVALID`、空は`QUERY_EMPTY`。
- 3文字以上の語は索引（FTS5 trigram）で引き、3文字未満の語は本文の走査で絞る。すべての語が3文字未満で、走査の対象が20000件を超えると`QUERY_TOO_SHORT`（語を足す）。大文字と小文字はASCIIだけ同じに扱い、NFKCの正規化はしない（全角のＡＢＣはABCと一致しない）。
- 並びは一致の度合い（bm25）、新しさ、itemIdの順。スコアの数値は返さない。itemは`context`と同じ形（`evidenceStatus`、`trust`、`expiresOn`を含む）。`current`だけが回答の根拠になる。見つからないことは、無いことの証拠ではない。
- 応答の`snapshotId`は返したitemだけを含む不完全なsnapshot（検索用の枠で32個、5分、古いものから捨てる）。`read`（itemId）と`use`に使えるが、`plan`には使えない（`COMPLETE_SNAPSHOT_REQUIRED`）。
- 索引の検査や作り直しに失敗したときは、`search`だけが`failed / SEARCH_INDEX_UNAVAILABLE`（終了コード1）になり、ほかの操作は動く。

## 見直しの一覧

`eumenes-memory --profile <profile.json> review [--input <file|->]`（`{"scopeKeys"?: [...]}`、CLIのみ、読取のgrant）は、見直したほうがよいitemのIDと鍵（scopeKey、subject、kind、semanticKey、status、revision、origin）と理由を20件まで返す読み取り専用の操作。本文は返さず、cursorも出さない（`moreAvailable`だけ）。理由は次の4つ。

- `external_stopped`: `trust: external`で停止したもの（inactive）
- `external_expiring`: `trust: external`で、自動停止まで14日以内のもの（`expiresOn`つき）
- `validity_ended`: 成立期間（`validUntilMs`）が過ぎたもの
- `inferred_unconfirmed`: `agent_inferred`で、作成から180日を超え、一度も確認や訂正をされていないもの

並びは期限の早い順。一覧を見て忘れるときは、通常の`plan`と`apply`でforgetする（特別な削除の経路は無い）。自動では忘れない。

## 自然文CLIとモデル

自然文planは`{scopeKey,message,sourceHandle}`、recallは`{scopeKey,message}`。利用者がprofileへmodelCommandとmodelDailyCallsを明示した場合のみ、外部Completeを1回呼び出す。既存の計画parser、意味指示、根拠選択を共用し、発話別の条件分岐を持たない。モデルなしの構造化操作も利用できる。

Completeはstdinのversion/prompt/schema/task/instructions/maxOutputTokensを受け、stdoutへ`{"raw":"schema準拠JSON文字列"}`を返す。資格情報・provider金額予算はCompleteが所有する。ホスト側は入力128KiB・出力64KiB・120秒、同時実行1、永続台帳で日次回数を予約する。自動再生成は行わない。recallはsupported/unknown/conflictを項目ごとに返し、返却前の状態照合でモデル待ち中の変更を拒否する。

自然文recallは指定した許可scopeの全Stateを渡す。snapshotの上限（10000項目／8MiB）と、モデル入力の上限（131072 UTF-8 bytes）は別であり、snapshotを取得できても自然文recallを実行できるとは限らない。モデル上限は記憶本文・ID・origin等の付帯情報、質問、指示、schema、JSONのエスケープを含む送信データ全体に適用する。128K tokenを意味しない。超過時はモデルを呼ぶ前に`blocked/MODEL_INPUT_TOO_LARGE`で拒否し、記憶を切り捨てたりunknownへ変換したりしない。

モデルを設定せずに、実ストアと質問から入力容量を測定できる。

```sh
printf '%s' '{"scopeKey":"personal","message":"私の通勤手段は？"}' | bunx --no-install eumenes-memory --profile /tmp/shared-memory/profile.json recall-size --input -
```

`measurement`は件数、本文の平均文字数（Unicode符号位置）・平均／p95／最大bytes、質問bytes、実際の送信データの`modelInputBytes`、残容量、`fitsModelInput`を返す。本文や資格情報は返さず、モデルの呼出し・日次予約は行わない。上限超過でも測定自体の成功は終了コード0であり、利用可否は`fitsModelInput`で確認する。権限・snapshotの完全性・鮮度は通常のrecallと同じ条件で検査する。代表的な質問と長文の分布で測定し、実ストアが収まる間は全件方式を維持する。超過が確認された場合に、既存のページ走査やLLMによる候補取得と精度・費用を比較する。件数だけから一律の利用上限を保証しない。

`inputFormatSha256`は指示・schemaと、空の質問・記憶を使った送信形式の識別値。測定値を保存する場合は上限bytesと共に残し、将来の入力形式変更を区別する。記憶本文や質問内容のhashではない。

## アプリとの共有と復元

アプリ所有のDBでは、CLIからDBを開かず、アプリの既存Writer/readSnapshot/journal/purgeをMemoryHostへ渡す。実EumenesのMemoryService.sharedHostがこのportを公開する。アプリのforget purge hookからMemoryHost.invalidateDerivedInTransactionを呼ぶ。アプリ出典はsharedHost.resolveSourceで解決し、hostIntentは同じtransaction内でアプリ由来の派生物とforget fenceへ再適用する。接続transportの開始はアプリの所有者が明示的に行う。

最新のDB外journalを保持してからDBを復元する。所有者はjournal照合、完全な消去意図の再開、アプリ由来の消去を終えてreadyになる。journalが不整合なら起動を拒否する。記憶の本文を含む計画・実行payloadにも寿命と忘却依存を持たせ、使用済み操作IDと本文を分離する。

Worldや他エージェント等が独自コピーを持つ接続では、[外部接続の必須受入契約](host-guide.md#external-connector-acceptance)も満たす必要がある。外部所有者による依存の再登録は、起動時のjournal照合より前に完了させる。既定のホスト起動が任意の外部台帳を自動復旧するわけではない。再登録できない接続は復元後の利用を停止し、接続所有者が削除・照合を解決する。`hostIntent`は記録済みのホスト消去意図を再適用する仕組みであり、未登録コピーの検出を保証しない。

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
