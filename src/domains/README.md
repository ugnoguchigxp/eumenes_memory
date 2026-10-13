# ドメイン構造

各ドメインが契約、純粋な判断、同期SQL、テストを所有する。HTTPやモデル呼び出しを担当するcontrollerは置かない。パッケージの入口は従来の `src/index.ts` と `src/sqlite.ts` を維持する。

| ドメイン | 所有する処理 | 直接依存してよいドメイン |
|---|---|---|
| temporal | 精度つき日付、成立期間、現在・過去・未来・時点不明の判定（時刻はホスト注入） | なし |
| records | 原文の記録、出典識別、UTF-8範囲、再生成可能な資料の保持（retention）、原文の消去 | なし |
| state | 状態台帳、状態遷移、根拠の検査、成立期間の精度の永続 | records, temporal |
| lifecycle | 忘却閉包、ジャーナル照合、外部削除・派生物 | records, state |

依存の正本は `scripts/domains.ts`。共有契約を経由する依存も検査する。

- `contracts/`: 入出力の型・上限・理由コード。
- `service/`: DB・時計・乱数・ネットワークを使わない判断処理。
- `repository/`: ホストが渡す `MemoryDb` に対する同期処理。transactionはホストが所有する。
- `index.ts`: 他ドメイン向けの純粋APIと型。
- `sqlite.ts`: 他ドメイン向けの保存API。
- `test/`: 判断と実SQLiteのテスト。複数ドメインのシナリオは `test/scenario/`。
- `testing.ts`: 他ドメインのテストで使う素材。製品コードからの参照は禁止。
- `migrations/`: 所有するSQL定義。0002はRecords、0003・0004・0007はState。複数ドメインにまたがる0008（取り除いた機能の表の削除）は共通基盤に置く。

これらのドメイン入口は内部用で、パッケージとして公開しない。`src/contracts/` は出典・アクセスなどの共有形式と読み取り部品を持つ。依存辺・墓標の語彙は `dependency.ts` に置く。

`src/infrastructure/sqlite/` は接続の構造型、schema検査、通番、依存辺、墓標、変更フィードを扱う。業務ドメインの処理には依存しない。例外はmigration登録配列が各所有者のSQLを取り込む箇所だけ。LifecycleはRecords・Stateの消去APIを呼び、本文削除SQLを複製しない。

`scripts/boundaries.ts` はTypeScript ASTとモジュール解決を使い、import、再export、型import、動的import、require、aliasを検査する。宣言外の依存、他ドメインの内部参照、循環、純粋入口からSQLへの間接依存、製品コードからテストへの依存を拒否する。計算された動的参照も製品コードでは禁止する。

## 検証

```sh
bun run test:domain -- state
bun run verify -- --domain state
bun run verify:all
bun run verify
```

`test:domain` は指定した所有者のテストだけを実行する。`verify --domain` は依存先のテストと共有契約・SQL基盤・公開API・fixture・境界の検証を実行する。format、lint、型検査はドメイン指定でも全体を確認する。利用者まで含む受入判定には全体検証を使う。引数なしの `verify` は従来どおり全体検証。

fixtureは `fixtures/<family>/` の元の名前と内容を保持し、所有者を `scripts/domains.ts` に対応づける。移行SQLの登録順と移動前のSHA-256もテストで確認する。

検証はソースを書き換えない。`verification-reports/<実行ID>.json` に対象・依存範囲・前後のソースハッシュ・実際のツール版・各段階の結果と所要時間を記録する。前後のソースが変わった実行は失敗とする。`latest.json` は直近の完了結果。fixtureと設定もハッシュ対象で、生成レポート・配布物は除く。
