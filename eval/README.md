# eval/ — 実モデル評価（E 段階）の基盤（S9）

Memory 本体はモデルを呼ばない（設計書 §4）。ここは「ホストが実装したアダプター（`ExtractorPort`）を差し込んで、
日本語の合成データで抽出の品質を測る」ための**基盤だけ**を持つ。実モデルのアダプター・資格情報・ネットワークはこのリポジトリに置かない。
`bun run verify` からは呼ばれない（`bun test` のルート実行には `eval/test` の自己検査が含まれる。下記）。

## 目的と E 段階の定義

検証ラダー（設計書 §6.5）の L6。`spec/verification-status.md` の表の「E」列を埋める条件は、次を**すべて**満たす実行の記録があること。

1. 実モデルのアダプターで走らせた（`--adapter` が stub でない。結果の `adapter.stub === false`）。
2. gold を人が確認した（データの `humanReviewed: true`）。未確認の間の結果は**暫定**で、E 段階を主張しない。
3. 閾値を**実行の前に**決め、承認済み（`status: "approved"`）の閾値ファイルを `--thresholds` で渡して、結果と一緒に記録した（下記「閾値の規則」）。
4. `test` split で、3 回以上の反復（`--repeats 3`）の最悪値を記録した。
5. データが設計書の件数（各カテゴリ dev 15・test 15 以上）を満たす。

結果 JSON の `claims.eStageEligible` が上の機械判定で、満たさない理由を `claims.reasons` に列挙する。
現状は stub（oracle / echo-noop）の自己検査だけで、**E 段階は未達**（実モデルで走らせていない。gold は未確認。データは各カテゴリ 8〜9 件）。

## ディレクトリ

| パス | 内容 |
|---|---|
| `datasets/ja-memory-v1.jsonl` | 合成の日本語評価データ（1 行 1 ケース）。15 カテゴリ・124 件 |
| `adapters/oracle.ts` | stub。データセットの期待をそのまま返す（パイプラインの自己検査用） |
| `adapters/echo-noop.ts` | stub。常に noChange（下限の基準） |
| `run.ts` | CLI。`prepareExtraction` → アダプター → `settleExtraction` を使い捨て実 SQLite 上で回す |
| `lib/` | 型、データ読み込み、突き合わせと採点、実行本体、閾値の読み込み |
| `thresholds/proposal-1.json` | 閾値の**提案**（未承認）。根拠は `THRESHOLDS.md` |
| `results/` | 結果 JSON（形式は `results/SCHEMA.md`）。`selfcheck.json` は oracle の自己検査 |
| `test/` | データと採点の整合検査（`bun test eval/test`） |
| `tsconfig.json` | eval 専用の型検査設定 |

## 実行方法

```sh
# 自己検査（oracle が満点になること）
bun eval/run.ts --adapter eval/adapters/oracle.ts --name selfcheck

# 実モデル（ホスト側のアダプターを指定。H 段階以降）
bun eval/run.ts --adapter <path/to/adapter.ts> --name <run-name> \
  --split test --repeats 3 --thresholds eval/thresholds/<approved>.json
```

| 引数 | 既定 | 意味 |
|---|---|---|
| `--adapter` | 必須 | アダプターのモジュールのパス |
| `--name` | 必須 | 実行名。結果は `<out-dir>/<name>.json`。英数字と `. _ -` のみ。時刻は使わない（再現性のため。日付は名前に自分で入れる） |
| `--split` | `all` | `dev` / `test` / `all`。採否の根拠にするのは `test`。閾値の調整は `dev` で行う |
| `--repeats` | 1 | 反復回数。指標ごとの最悪値を `worst` に、各回を `perRepeat` に記録する |
| `--thresholds` | なし | 閾値ファイル。不合格なら exit code 2（結果は書く） |
| `--timeout-ms` | 120000 | アダプター 1 回あたりの制限。超えると失敗として数える |
| `--out-dir` | `eval/results` | 出力先 |

終了コード: 0 = 実行成功（閾値なし、または合格）、2 = 閾値不合格、64 = 引数の誤り。

### アダプター

モジュールの default export が `EvalAdapter`（`eval/lib/types.ts`）か、`ExtractorPort`（関数）。

```ts
import type { EvalAdapter } from "../lib/types.ts";
const adapter: EvalAdapter = {
	extractorId: "my-extractor",   // ≤ 64 byte。prepare の profile に渡る
	promptVersion: "p-1",          // ≤ 64 byte
	providerRef: "provider-x",     // ≤ 64 byte
	modelId: "model-name",         // 任意。結果に記録される
	extract: async (input, signal) => /* ExtractionInput → JSON.parse 済みの出力 */ ({}),
};
export default adapter;
```

`input` は `prepareExtraction` が返した `ExtractionInput`（`instructions` の固定文言・出力 schema つき）。モデル固有の request 形式への変換はアダプターの責任。
アダプターが例外を投げたら、設計どおり settle を呼ばず `adapterFailures` に数える。資格情報・ネットワークはアダプター側が扱い、`eval/` のコードは扱わない。

## 型検査・lint・format

ルートの `tsconfig.json` は `eval/` を含まない。次で検査する。

```sh
bunx tsc --noEmit -p eval/tsconfig.json
bunx oxlint --deny-warnings eval
bunx oxfmt --check eval
bun test eval/test
```

`oxlint` / `oxfmt` はルート実行でも `eval/` を対象にする。`run.ts` は結果 JSON を書いたあと、リポジトリの `oxfmt` があれば `--write` で整形する（内容は変えない）。

## 評価データ

- 1 行 1 ケースの JSONL。カテゴリは設計書 §6.4(b) の 12 + あいまい・絵文字記号・長文の一部（`eval/lib/types.ts` の `CATEGORIES`）。
  否定 / 二重否定・部分否定 / 仮定 / 疑問 / 引用 / 伝聞 / 別人情報 / 嗜好変更 / 訂正 / 過去・未来 / 複数根拠 / 無変化（雑談）/ あいまい / 絵文字・記号 / 長文の一部。
- ケースの項目: `id`、`category`、`split`（`dev` / `test`。各カテゴリの先頭 4 件が dev）、`humanReviewed`（現在すべて false）、
  `sources`（`role` + `content`）、`expect`、`note`、任意で `acceptNoChange`、`tolerated`。
- `expect`: `noChange: true`（候補なし）または `candidates`（gold 候補）。gold 候補は
  `kind` / `subject`（`self` / `other` / `unknown` の種別。`other:<識別子>` の識別子は比べない）/ `polarity` / `modality` / `temporal`、
  `spans`（根拠。出典の添字 + 本文中にちょうど 1 回現れる `quote`。byte 範囲は読み込み時に求める）、`valueHint`（人が読む用。比較しない）、
  任意の `acceptable`（許容幅）。
- **`acceptable`（許容幅）**: gold 候補ごとの追加で許容する値。`{"kind":["habit"],"temporal":["unspecified"]}` のように属性ごとに列挙する。
  ケース単位の `acceptNoChange: true` は「候補を 1 件も出さなくてもよい」（見逃しに数えない。仮定・引用・あいまい表現で、出すなら危険な labeling を避けること、出さなくてもよいことを表す）。
  `tolerated` は「候補にしてよい」範囲（訂正前の旧値など。過剰抽出にも誤採用にも数えない）。
- すべて**合成**。実在の人物・実会話・製品データを含めない（次節）。SAAA の `ja-corpus.json` はカテゴリ設計の参考にしただけで、本文は流用していない。
- gold の人手確認は未実施（`humanReviewed: false`）。この間、結果は暫定。

### 実会話データを使わない規則

- `eval/` に置くデータ（datasets・results・テスト・コメント）に、実在の人物・実際の会話・SAAA や Eumenes の製品データを入れない。コピーもしない。
- 追加するケースは新しく合成する。URL・メールアドレス・電話番号・長い数字列は `eval/test` が拒否する。
- 結果 JSON に入るのは、ケース id、カテゴリ、件数、属性名つきの所見（例 `polarity:0`）だけ。モデルの出力本文・プロンプト・資格情報は書かない。
- 実モデルへ送るのは合成データだけなので、外部プロバイダーへ実ユーザーの情報は渡らない。

## 突き合わせと指標（`eval/lib/score.ts`）

- モデルの候補の根拠（evidence）がすべて「quote が byte 範囲と一致」するものだけを比較対象にする。1 つでも不一致・範囲外・空なら
  `candidatesWithBadEvidence`（引用不一致）に数え、他の指標には入れない。`quoteMismatchRate` = それ / 出した候補数。
- gold ごとに、根拠が gold の span と重なる未割り当ての候補を 1 件割り当てる（属性の一致数、次に重なりの大きさ、次に出力の順）。割り当てられた gold が `matched`（候補の一致）。
- 割り当てた対の属性を比べ、`kindErrors` / `subjectErrors` / `polarityErrors` / `modalityErrors` / `temporalErrors`、すべて正しければ `fullMatch`。
  subject が other の gold は kind を比べない（Admission が other_person_note に矯正するため）。
- 割り当てられない候補は `overExtracted`（過剰抽出）。gold と重なるが先に別の候補が割り当てられていたものは `duplicates`（`overExtracted` にも含む）。`tolerated` の範囲と重なるものは `tolerated` に数え、過剰にも誤採用にも数えない。
- `noChangeAccuracy`: 期待が noChange のケースで、結果が applied かつ候補 0 件の割合。
- **`falseAdmissions`（誤採用）**: 評価は全 self kind を `auto_admit` にした最悪ケースの方針で settle する（`other_person_note` は `user_confirm`）。
  Admission が `admitted` にした候補のうち、gold に属性がすべて正しく割り当てられていないもの（tolerated を除く）。`falseAdmissionRate` = それ / admitted。
- **値の意味**（oracle は valueHint をそのまま返すので、oracle が誤り 0 になるのは採点経路の自己検査にすぎず、実モデルの意味精度の根拠にならない。動詞の項目は語幹も許容する。`noneOf` も部分一致なので、正しい値が別の対象に言及すると誤りに数える限界がある）: gold が `valueMeaning`（`anyOf` / `noneOf`）を持つとき、割り当てた候補の `value.text`（NFKC・小文字に正規化）が `anyOf` のどれかを含み `noneOf` のどれも含まないかを採点する。`valueScored` / `valueErrors` / `valueErrorRate`。外れた候補は属性が合っていても `fullMatch` にならず、採用されていれば誤採用に数える。現在の gold は valueHint 由来で人手未確認。
  本体は既定で自動採用しない。これは「auto_admit を有効にした場合に何が入るか」を測る指標で、設計書 §6.4(b) の最重要指標（誤採用率）に対応する。
- `candidateRecall` = matched / goldCandidates（`acceptNoChange` で候補を出さなかったケースの gold は除く）、`fullMatchRate`、`overExtractionRate` = overExtracted / 出した候補数。分母 0 の比率は null。
- `adapterFailures`（例外・タイムアウト）、`rejectedOutputs`（settle が `rejected_output`）はそのケースの gold を見逃しに数える。
- 反復が複数ある場合、`worst` は指標ごとの最悪値（大きいほど良い指標は最小、それ以外は最大）。

### 結果の読み方

1. まず `claims`。`eStageEligible: false` なら暫定・自己検査。理由が `claims.reasons` にある。
2. `overall.worst` と `categories.<name>.worst`。最優先は `falseAdmissions`（特に仮定・疑問・引用・伝聞・別人情報・過去未来）と `polarityErrors`。再現率は参考。
3. `cases[].runs[].flags` で個別ケースを追う（`polarity:0` = その gold の添字 0 の極性誤り、`over:2` = 出力 2 番目の過剰抽出、`false_admission:1` など。本文は含まない）。
4. 1 カテゴリ 8〜9 件（test は 4〜5 件）では 1 件の誤りが 11〜25% に相当する。比率ではなく件数で読む。0 件でも「誤りが少ない」ことの強い証拠にはならない（`THRESHOLDS.md`）。

## 閾値の規則

- 閾値は結果を見る**前**に決め、ファイルとして保存し、`--thresholds` で渡して結果 JSON に埋め込む（`thresholds.version` / `sha256` / `status` / `pass` / `failures`）。
- 結果を見たあとに閾値を動かして合格にしない。変えるなら新しい `thresholdsVersion` のファイルを作り、変更理由を `rationale` に書き、再実行する。
- `status: "proposal"`（未承認）の閾値で合格しても E 段階を主張しない。最終値はユーザー判断（設計書 §9 Q2）。承認したら `status: "approved"`、`decidedBy`、`decidedAt` を記入する（`decidedAt` は人が書く。run.ts は時刻を扱わない）。
- 閾値の調整・プロンプトの調整は `dev` split で行い、`test` split は最終確認に 1 回だけ使う。
- 提案値は `eval/thresholds/proposal-1.json`、根拠は `eval/THRESHOLDS.md`。

## `bun test` と `bun run verify` の関係

`eval/test/*.test.ts` は `.test.ts` のため、ルートの `bun test`（= `bun run verify` の test 工程）も拾う（28 テスト、約 1.5 秒、実モデルなし）。
verify から外すなら `scripts/verify.ts` の test 工程を `[process.execPath, "test", "./src", "./test", "./scripts"]` にする（`./` つきでパスの先頭に一致させる。`test` だけだと `eval/test` にも一致する）。
`eval/` の型検査（`tsc -p eval/tsconfig.json`）は verify に入っていない。入れるなら `STEPS` に `{ name: "typecheck:eval", run: () => spawn([bin("tsc"), "--noEmit", "-p", "eval/tsconfig.json"]) }` を足す。
