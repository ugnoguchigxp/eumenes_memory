# ホスト実装と受入の対応

2026年11月7日。基準commitは`86fe3c9b95deffc090fb41a4ff77a0d8685e02da`。実装は`packages/host`、配布は`bun run pack:host`、利用手順は[CLI/MCP導入](../../docs/cli-mcp.md)。本体の公開API・schema・実行時依存は変更していない。最終ゲートの成否と検査時点のsourceHashは`verification-reports/latest.json`、`verification-reports/quality-80/package.json`、`verification-reports/host/package.json`を正本とする。

## 実装した段階

| 段階 | 実装と検証先 |
| --- | --- |
| P0 | `contracts.md`、strictなwire schema、権限と上限、永続schema版1、起動世代、エラー/終了コードを確定 |
| P1 | examplesの意味指示・parser・根拠選択を製品側へ移し、examplesは再export。既存43件の対象回帰を維持。出典・計画・操作・hostIntentの永続化と消去を共通化 |
| P2 | SQLiteの所有権lockと単一Writer、Unix socket、複数のstdio接続。現在の権限・出典・snapshotを再照合。同一操作IDをまとめ、保存済み結果を先に照会 |
| P3 | init/serve/source/context/read/plan/apply/operation/status/recall、forgetの別名、JSONと終了コード。任意の外部Complete、同時実行と日次予約台帳を接続 |
| P4 | 公式SDK 2.4.0による7つのMCPツール。stdio、取消、再接続、未知のtool、異常状態を結合試験。配布物ではclient 2.4.0と1.32.2を別に検査 |
| P5 | 出典の連続引用、明示的な出現位置、originの提示、条件/主体/時点と未確定の区別を指示へ追加。4つの未使用合成質問で新旧の取得を比較 |
| P6a | 本体の実行用ファイルをホスト配布物へ同梱し、開発パスへの依存を除去。manifestの全ファイルhash、別環境のインストール、CLIと2つのMCP、Linux/macOS CIを用意 |
| P6b | 実EumenesのMemoryServiceにsharedHost portを公開。既存readSnapshot/write/journal/出典/purge/forget fenceへ接続し、実アプリfixtureで相互の保存・忘却・復元を検査 |

CLIの自然文経路とMCPは同じparser/validator/applyを使う。意味は呼出し元LLMまたはCompleteが決め、コードは出典の完全一致・数値範囲・権限・同一ID・版・依存閉包を検査する。引用の出現位置からUTF-8 bytesへの変換は文字列の位置変換だけを行い、意味による選択や自動補正をしない。

## 受入ケース

| ID | 検証先・観測 |
| --- | --- |
| R01 | service/process/natural: 登録→計画→適用、別MCPから参照。通常originはagent_inferred |
| R02 | service/natural: 日本語の繰返し引用の2回目を選択、文字の途中のbyte境界を拒否、submissionIdの異内容を拒否 |
| R03 | service/eumenes: 確認済み項目の訂正権限と出典originを分離。MCPのorigin指定はstrict schemaで拒否 |
| R04 | service: 不許可scope・別接続のID・失効したcredential・忘却権限を失った結果照会を拒否 |
| R05 | service: 限定接続のforgetを閉包の件数やIDを返す前に拒否。全scope管理でも確認済み項目を別に保護 |
| R06 | service: other_person_noteを参照、同一snapshotのページ、期限切れcursor、容量を超えたsnapshotによる忘却を拒否 |
| R07 | service/natural/eumenes: 同時訂正の一方をstaleにし、別scopeの更新は許可。モデル待ち中の変更を返却前に再照合 |
| R08 | service/process/cancellation: 同一IDの同時applyと再送で履歴を増やさず、異なるplanとのID再利用を拒否。詳細期限後も同一世代の使用済みIDを保持 |
| R09 | crash/service: fsync直後の実SIGKILLでlockを解放し、ready前に消去を回復。失効した元clientに依存せず回復 |
| R10 | service/eumenes: 古いDB＋最新journalでState・原文と派生payloadを再消去。消えた旧操作は結果不明、旧未着手planは再生しない |
| R11 | service: 66世代を分割して途中から回復、保持条件と原文全体消去の衝突を要確認、Record本体を消去、外部pendingと部分適用を区別。アプリ経由のRecord忘却でもホスト側原文を消去。未採用出典のTTLも依存閉包を確認してjournal経由で消去 |
| R12 | process: 接続Aだけの終了、所有者停止、同一clientで再接続、所有者再起動、二重所有を検査。MCP stdoutはSDKで読めるprotocolだけ |
| R13 | natural/live: 情報不足は根拠なしunknown、本文の指示はデータ。モデル上限と予算枯渇を検査し、自動再生成しない。liveでは他人への誤帰属・条件の欠落・未根拠のID採用を比較 |
| R14 | eumenes.integration: 実アプリの同じWriterへCLI/MCPを接続。アプリ出典の参照、相互の保存・忘却、fence更新、元DBの復元と原文ブロックを確認 |

## 実エージェントと実アプリの証拠の範囲

Codex CLI 0.163.0を、一時CODEX_HOME・使い捨てストア・新規の会話で検査した。読み取り専用設定で保存が拒否されたため、当該検証用MCPだけにdefault_tools_approval_mode=approveを指定した。既存設定や既存チャットへの送信は行っていない。7ツール中の保存と結果照会を含む9回の呼出しと、保存されたagent_inferredを確認した。直近の比較は共通4件で旧/新とも成功し、新指示の出典有効性2件も成功した。使用量と遅延はlive.jsonに記録した。小標本の観測であり、一般的な性能優位とは扱わない。直接API費用は発生させず、subscriptionのtoken使用量をlive.jsonに記録した。

Eumenes作業先は`../eumenes/api/domains/memory/service/shared-host.ts`と、その公開先のservice/index.ts。作業ツリーには無関係の既存変更と生成物があるため保持した。元環境の標準verifyは既存artifacts内の試験一覧で停止した。一時checkoutへ今回のportを加え、既存依存を参照し、既存の無関係な整形差分を一時環境内だけで整形してから、標準の`verify --domain memory`を通した（187件、0失敗。型・境界・設計・format/lint・ビルドを含む）。さらに現作業ツリーの実fixtureを直接使う結合試験を別に実行する。これは稼働中アプリへの常設導入・再起動の証明ではない。

## 残す境界

Windows、公開HTTP、別principal間の共有、任意のRecords全文検索、アプリ設定への自動登録は初期対象外。利用者の既存設定・稼働中DB・忘却journalは自動で移行しない。接続を停止して旧利用経路へ戻せるが、適用済みの忘却やjournalを巻き戻してはならない。検証で見つけた実行契約の失敗は固定応答へ置き換えず、共通の契約検査と回帰試験で修正した。

最終点検では、部分snapshotの表示済み項目をreadできること、アプリの出典revisionの変更だけでも旧snapshotがstaleになること、Recordの別経路の忘却がホスト側のコピーにも伝播することを追加検証した。出典とscopeの照合は契約上のID・revision・digestで行い、意味判断をコードへ移していない。


## コードレビューF1〜F5への対応

`review-regressions.test.ts`で、journal保存後のowner transaction失敗と待機中Writerの遮断、確認済みの過去版の忘却権限、グループをまたぐ忘却・訂正の拒否、再起動・期限切れ・旧形式における外部削除完了の再照会、出典状態をモデルへ渡すことと無効な引用の拒否を検査する。実アプリfixtureでも、同じ失敗によるアプリ側healthの停止・journal復旧と、snapshot作成前の会話訂正、既存seed出典の照合を検査する。アプリのseed照合は既存の`seedEvidence`を再利用した。

意味判断の条件分岐は追加していない。追加した検査はWriterの実行状態、権限、対象IDの依存、削除証明、出典のID・版・digestに限る。モデルには出典の有効性を渡し、何を回答できるかの意味判断を委ねる。共通の根拠検証は無効なIDの引用を拒否する。coreの公開API/schema変更や利用者の実データ移行はない。

最終検証の正本は各reportのsourceHashで照合する。`host/live.json`は従来の4件の新旧比較に加え、古い・消去済み・照合不可の根拠を含む2件を新指示で検査する。遅延比較は共通の4件に限り、成功条件と最大11回の呼出し上限は実行前に固定する。


## 再レビューの対応

G1〜G10として、生成先Stateと計画本文の削除依存、操作payloadと依存登録の寿命、部分snapshotの出典鮮度、配布物のMCP識別名、外部Completeの期限と配下プロセス、訂正対象IDの重複、既存ファイルのある初期化、入力・応答の逐次サイズ検査、設定取得時の例外処理、unchangedな訂正の未採用出典の寿命を見直した。再現試験を先に実行し、失敗を確認してから共通機構を修正した。旧計画の出力依存が欠けている場合と、リンク先のないsymlinkも回帰に含める。

追加した判定は、所有するmetadataの参照、IDの一致、版、byte数、processの終了、設定読込みの成否に限る。意味判断は既存のモデル指示に残し、core API/schemaと既存アプリの実データを変更しない。再レビューの記録は`verification-reports/host/review-round2.json`に保存する。
