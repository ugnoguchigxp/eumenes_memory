# 会話履歴から抽出した50件のSeed

[data/codex-user-50.jsonl](data/codex-user-50.jsonl) は、2026年9月30日〜10月16日にこのMacへ保存されたCodexの会話から選んだ50件の候補です。42会話・86発言の97引用を根拠にしています。本人が確認済みの記憶ではありません。

ユーザーの依頼に基づく個人用の実データです。自動テストの正解や汎用ベンチマークには使いません。`test/examples/seeds.test.ts` は独立した架空データで契約と永続化を検査します。

## 使い方

リポジトリのルートで実行します。Seedの一覧表示と初期化はモデルも認証も不要です。保存先は他のExamplesと同じ`StandaloneHost`です。

```sh
# 50件すべてと、その保存先の区分を確認
bun run memory:seed inspect

# 新しい作業用DBへ、State候補28件を初期化
bun run memory:seed load /tmp/seed-memory

# 同じSeedで再実行しても重複しない
bun run memory:seed load /tmp/seed-memory

# 既存の参照処理を使う（Codex SDK + Luna。認証が必要）
bun run memory /tmp/seed-memory recall '私のAI動画の推薦条件は？'

# 別の同形式のJSONLも利用可能
bun run memory:seed inspect /path/to/seed.jsonl
bun run memory:seed load /tmp/other-memory /path/to/seed.jsonl
```

`recall`は自然文の回答ではなく、既存の入口と同じ`parts`（問い、supported / unknown / conflict、根拠のState ID）を返します。根拠の内容は下記の`host.list()`で確認できます。本人の記憶の参照であり、候補に書かれた作業方針を現在の実行指示へ昇格しません。

```ts
import { loadSeedData } from "./examples/seeds/data.ts";
import { importSeedData } from "./examples/seeds/import.ts";
import { StandaloneHost } from "./examples/standalone/host.ts";

const seeds = loadSeedData(); // 全50件。出典、範囲、条件、見直し情報も保持
const procedures = seeds.filter((seed) => seed.proposed_target === "host_procedure");
const continuity = seeds.filter((seed) => seed.proposed_target === "continuity");
const host = new StandaloneHost("/tmp/seed-memory");
try {
  console.log(importSeedData(host, seeds));
  console.log(host.list());
  // procedures / continuity はホストの正本との照合用。ここでは実行・登録しない。
} finally {
  host.close();
}
```

上のimportはリポジトリ直下に置くスクリプト用です。他の場所からは相対パスを合わせてください。`loadSeedData()`の既定パス自体はモジュール基準で解決します。

## 保存するもの

| 対象 | 件数 | 扱い |
|---|---:|---|
| `state` | 28 | 既存の`assertUserState`で`agent_inferred`として保存 |
| `host_procedure` | 18 | データとして閲覧可能。指示の権限を持つためMemory Stateへ投入しない |
| `continuity` | 4 | 案件の目的・判断の背景。本人の恒久的な嗜好へ変換しない |

保存値の本文には記憶だけでなく、`scope`、`use_when`、`limitations`、未確認の候補であることを含めます。既存の`modelItems`と`recallMemory`をそのまま使っても、適用条件がモデルから消えない形です。範囲の文字列をコードで解釈・分類する処理はありません。保存上のアクセス範囲はStandaloneHostの既存scopeであり、JSONL中の`scope`はLLMが解釈する適用条件です。

`evidence_basis: explicit`は、引用元で明言されているという意味です。今回の抽出内容が本人確認済みという意味ではなく、全件`status: candidate`のままです。初期化を依頼しただけで`user_confirmed`へ変更しません。`review`は見直しの目安として出典に保持し、自動削除期限にはしません。

出典はホストの`sources.jsonl`へ、`example-seed / candidate`として元Seed全体を保存します。Stateの引用はこの候補資料の記憶本文を指します。元のCodex会話のID、引用、digest、UTF-8範囲は候補資料の中に保持し、候補資料を元の会話そのものと偽りません。元会話のパスは来歴情報であり、読み込み時にアクセスしないため、元ログがない環境でも実行できます。Memory Recordsへの会話コピーはありません。

## 再実行・変更・忘却

初回は空のホストだけに初期化でき、State28件と初期化記録を一つのSQLite transactionで確定します。出典の追記・同期が失敗した場合もStateと初期化記録は確定しません。失敗前に追記された出典だけが残る場合はあります。

同じデータは、ホスト所有の`example_seed_import`に保存したdigestで二重実行を防ぎます。初期化後に記憶を訂正・忘却しても、Seedの再実行では書き戻しません。異なるSeedで同じホストを初期化し直す操作は拒否します。別のデータセットを試す場合は新しい保存先を使い、既存記憶の訂正・忘却には通常の`plan` / `apply`を使ってください。Seedによる既存事実の意味比較や置き換えは行いません。

JSONLの構造、版、候補状態、保存先とoriginの整合、出典の参照形式、IDとsemantic keyの重複を読み込み時に検査します。既存のState契約が値・引用・権限も検査します。引用の内容が記憶を意味的に支持するかという判断は、このアダプターでは再採点しません。

```sh
bun test test/examples/seeds.test.ts
bun run verify
```
