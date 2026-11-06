# Eumenes Memory ホスト導入と復元

配布tgzのJavaScriptと型宣言だけで利用できる。本ガイドは配布物に同梱し、ソースcheckoutを要求しない。モデルを呼ばないライブラリで、ホストが渡すidentity・scope・時計・DB接続を信頼する。外部APIへ直接公開する認証境界ではない。

## boundaries

本体はState台帳、Records、期限付きの再生成資料、依存閉包、忘却と変更フィードを所有する。DB接続・単一Writer・read/write transaction・非同期queue・モデル・アクセス認証・journalファイルはホストが所有する。Procedure、ベクトル検索、会話原文の正本を持たない。

## startup

1. ホスト側で接続を開く。書き込みは同一の直列Writerへ集め、読み取りもsnapshot transactionで囲む。
2. `eumenes-memory/sqlite`の`migrations`をホストの追記専用配列の末尾へ、各要素1本ずつ登録する。既適用の位置やSQLを変更しない。`checkHostMigrations(hostMigrations)`が空配列であることを検査する。
3. ホストのmigration管理で未適用SQLだけをtransaction内で実行する。新規DBの簡単な例は下記。実運用ではschema_migrations等で適用済み位置を記録する。
4. `assertMemorySchema(db)`を呼ぶ。SCHEMA_MISSING／OUTDATED／TOO_NEW／MISMATCHなら読み書きを開始しない。新しいDBへの旧バイナリの差戻しは安全なrollbackではない。
5. DBと別に保管する最新の忘却journalを確認する。既存DBのjournalが無い場合は勝手に空ファイルを作らない。
6. Worker起動前に、write transaction内で`reconcileForgetJournal(db,{contractVersion:2,entries,clock:{atMs}})`を呼ぶ。`inconsistent`ならMemory全利用を停止し、正しいjournal・DBの組を回復する。`feedResyncRequired`なら外部購読カーソルを捨て全再同期する。`hostIntentsToReapply`があれば、同じtransactionの中で各`hostIntent`に対するホスト自身の消去を冪等に再実行する。
7. 以後はwriteをtransaction内の同期関数として呼ぶ。async関数をtransactionへ渡さない。読み出しの複数SQL・ページ列挙の一貫性はホストのread transactionで守る。

Bunで新規の使い捨てDBを準備する最小例。実運用では上記migration管理とjournal存在確認を先に実装する。

```js
import { Database } from "bun:sqlite";
import { migrations, assertMemorySchema, reconcileForgetJournal } from "eumenes-memory/sqlite";
const db = new Database(":memory:");
db.exec("PRAGMA foreign_keys=ON");
db.transaction(() => { for (const migration of migrations) db.exec(migration); })();
assertMemorySchema(db);
const result = db.transaction(() => reconcileForgetJournal(db, {
  contractVersion: 2, entries: [], clock: { atMs: 0 },
}))();
if (result.status !== "ok") throw Error(result.reasonCode);
```

`MemoryDb`は`exec(sql)`、`query(sql).all/get/run(...params)`、`inTransaction`（必須）を持つ同期port。書込系の関数は`inTransaction`が`true`でなければ`NOT_IN_TRANSACTION`で拒否する（値を持たないadapterも拒否する）。Bunではそのまま満たす。Nodeの`node:sqlite`を使用する場合は`prepare`を`query`へ接続し、ホストが開いたtransactionの状態を`inTransaction`で返す。異なるdriverへの互換は実際のadapterで検証する。

## 保存と訂正

Stateは`assertUserState`へsubject、kind、semanticKey、値、出典の本文と引用範囲を渡す。引用とUTF-8 bytes、digest、revision、principal、scopeが一致しなければ拒否する。保存値は出典本文と同義である必要があり、その意味判断はホストのLLMが担う。同じkeyに異なる値がある場合、`replaces:{itemId,revision}`を指定したCASで訂正する。失敗・rejected・blockedを成功として扱わない。

## state-origin

`user_confirmed`／`user_edited`は本人由来の明示操作、`agent_inferred`はホストの推定。推定を本人確認と表示しない。同値の本人確認はoriginを昇格し、同値の推定では降格しない。`validity`や期限は保存するだけで、現在性はホストが`classifyValidity`等で判定する。

## 忘却とバックアップ復元

`planForget`は読取のみ。plan・journalへの追記・`applyForget`は、単一Writerの同じwrite transactionの中で行う。entryの`seq`/`prevHash`はplan時点のDBのheadの次なので、planとapplyの間に別の忘却が入ると、適用できないentryがjournalに残り、次のreconcileが`JOURNAL_CHAIN_BROKEN`になる。追記では完全な書込み・fsyncを確認してから`applyForget`を呼ぶ。journalへの初回作成・置換ではdirectoryのfsyncも必要。fsyncの間はWriterを保持する。journalの書込みはDBのrollbackでは戻らない。journal後・DB適用前の失敗では利用を止め、起動時reconcileで回復する。

`contractVersion:2`の`planForget`は、同じscopeの複数target（`targets`、最大64件）と、ホスト自身の派生物を忘れる意図`hostIntent`（キー→不透明なIDの配列。本文を入れない）を1つのentry（format 2）にまとめる。`hostIntent`だけで`targets`が無いentryも作れる。`hostIntent`はhashの鎖に入るので、行の偶発的な破損・切り詰め・食い違いをreconcileが検出する。ホストは`applyForget`と同じtransactionで自分の消去を行い、起動時は`hostIntentsToReapply`で返った分だけを再実行する。format 2のentryを一度書いたjournalは、format 2を読めない旧版の本体では開けない（reconcileが入力検査で失敗し、Memoryは止まる）。

古いDBを復元しても最新journalは巻き戻さない。reconcile後、対象の非表示・値の消去・派生物のpendingを確認する。外部派生物がバックアップ後に登録された場合は、外部所有者が依存を再登録してからreconcileする。外部削除を実行し確認するまでreceiptはcompletedにならない。外部確認状態は古いDB復元でpendingへ戻りうる。

journalのhashの鎖は鍵なしで、検出できるのは偶発的な破損・切り詰め・食い違いだけ。悪意のある書き換えの防止は、journalを保護された媒体に置くホストの責任。復元前のDBと短縮journalを同時に戻した状況は本体だけでは検出できない。journalを別の保護された媒体で保持する。deactivateは可逆の停止であり、忘却ではない。忘却は論理消去で、SQLite空き領域・WAL・OS snapshot・ログの物理消去を保証しない。ホストはsecure_delete、checkpoint、VACUUM、バックアップ保持を運用要件に合わせて管理する。

忘却の範囲と前提（ホストの責任）:

- 本体は単一principalを前提に検証している。墓標はprincipalをまたいで効くので、複数principalで同じ出典IDを使わない。
- `state_item`の忘却はそのitemと派生物だけに届く。置き換え前の版も忘れるときは、`readStateFact`で全版を集めて`targets`に渡す。
- `planForget`・`getForgetReceipt`が返す件数と外部派生物は、同じprincipalの閉包全体で、対象のscopeに限らない。
- `applyForget`に渡すのは`planForget`が返したentryだけ。入力はJSON由来のplainなデータにする（Proxyやgetterは検査対象外）。
- memory recordを出典に引用するときは`representation:"text"`を必ず付ける（省略は契約エラー）。

## 再生成資料と容量

`retainRecord`は明示した資料だけを保持する。読取で期限を延長せず、回答等へ採用したrevisionを`useRetainedRecord`で記録して未使用期限を延長する。State・外部依存・送付記録のある資料は更新やevictを拒否するため、所有者が先に依存を解決する。`retainRecord`したoriginを`captureRecord`しても、そのrecordはretentionの対象のまま（送付記録が無ければevictで消える）。永続化するときは、先に`recordId`を指定してevictしてから`captureRecord`する。通常Recordsはevictしない。忘却済み資料の再captureを墓標で拒否する。

## domains

Recordsは本文と版、Stateは台帳と根拠、Temporalは期間判断、Lifecycleは忘却閉包と外部削除を担当する。時間・モデル・外部ツールの判断をSQL層へ追加しない。純粋APIは`eumenes-memory`、永続APIは`eumenes-memory/sqlite`をimportする。

## verification

配布物は型検査・fixture・実SQLiteのWAL／復元・権限境界・独立consumerで検証する。実ホスト結合、合成の固定判断、実モデル評価は別の証拠であり、一つの成功で他の精度を保証しない。具体的な実行環境・到達段階は各リリースの検証記録で確認する。

## development-examples

`bun run memory`、`check:memory`、seed、比較実験はソースcheckout向けで、tgzの実行用APIには含めない。seedや検証用原文・忘却前snapshotは検証資料であり、forgetがそれらを消すものではない。不要な検証ディレクトリは所有者が削除する。
