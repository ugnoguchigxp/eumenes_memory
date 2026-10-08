# M0 検証記録

2026-10-08 / 対象: M0 のみ（設計書 [m0-design.md](m0-design.md)、計画 [implementation-plan.md](implementation-plan.md) §3、契約 [contracts-v0.md](contracts-v0.md)）。

M0 は「取得済みデータを処理する同期ライブラリ」。DB・HTTP・LLM・時計・乱数・Eumenes への接続は含まない。**実際の会話への注入、実モデルの意味精度、永続的な忘却、音声受入が完了したとは宣言しない。**

## 1. 区分

### 1.1 実装済み

- 単一パッケージ `eumenes-memory`（ESM、TS ソースを直接 export、実行時依存ゼロ、MIT）。
- `buildMemoryView` / `validateMemoryView` と入力パーサ（`parseBuildMemoryViewInput` / `parseValidationCurrent` / `parseMemoryView`）。
- 手書きの実行時検証（zod 不使用）。own-property だけを読み、検査済みの新しい deep-frozen オブジェクトを返す。入力は変更しない。
- 正規化 JSON（JCS サブセット、UTF-16 コード単位順）、SHA-256（`node:crypto` は `src/canonical/sha256.ts` のみ）、UTF-8 byte 長と文字境界判定。
- reasonCode の決定的な優先順位（build 2a–2d / 3a–3k、validate V1–V8）と例外コード 22 種。
- 言語非依存 JSON fixture 101 件（canonical 5 / utf8 4 / build 36 + 例外 25 / validate 31）と、独立実装の期待値検証用 `scripts/fixture-digest.py`。
- `bun run verify`（format → lint → typecheck → Eumenes 互換 typecheck → test → public-surface）。

### 1.2 fixture 検証済み（この環境の純粋処理のみ）

設計書 §7.5 の完了条件はすべて fixture または unit test で検証済み。

| 完了条件 | covers ID | 検証 |
|---|---|---|
| 同じ入力で同じ選択・順序・digest | `determinism` | B01, B02, B03（入力順を入れ替えても digest が B01 と同一）, C01–C05, runner の再実行・順序入れ替え再実行 |
| goal/decision/open_question の由来と原文参照 | `kinds-origin` | B01, E17（`extracted` は拒否） |
| 原文欠落・変更・忘却、revision 変更で旧 view 利用不可 | `stale` | B30–B37, V20–V36 |
| principal / scope / policy 不一致 | `access` | B20–B25, V11–V15 |
| 必須項目の予算超過は overflow | `budget` | B44, B50–B53 |
| 日本語・絵文字、不正 UTF-8 範囲 | `utf8` | U01–U04, B06, B07, B39–B41, B50, B53 |
| Memory OFF / 空 snapshot の区別 | `disabled-empty` | B05, B10–B12, B52 |
| 不完全 snapshot は blocked | `incomplete` | B23, B24, V10 |
| 入力非変更・状態非保持 | `pure` | runner が全 build/validate fixture で自動検査（入力 JSON の不変、2 回実行の一致、逆順再実行の一致、戻り値の再帰 freeze）。unit test で参照非共有・frozen 入力も確認 |
| 公開パッケージの利用 | `consumer` | `test/consumer/public-api.test.ts`（package self-reference `"eumenes-memory"` のみ。build/validate fixture を公開 API で再実行）、`tsconfig.compat.json` |
| 入力検証 | `schema` | E01–E25, V40–V42, `LIMITS` 全項目の境界表（ちょうど上限 = 成功、+1 = 例外） |

期待 digest は実装出力のコピーではなく、手書きした期待 view を `scripts/fixture-digest.py`（Python の `json.dumps(sort_keys, separators, ensure_ascii=False)` + `hashlib`）で独立に計算して直書きしている。runner は別途、実装を使わない正規化・SHA-256 で `canonicalWithoutDigest` / `viewDigest` / `finalByteLength`（`JSON.stringify` の byte 長と正規化 JSON の byte 長の両方）を照合する。

ミューテーション確認（手動、結果は元に戻し済み）: 依存の整列の削除、item 順の `localeCompare` 化、range 判定の UTF-16 長化、予算の `>=` 化、V8 の無効化、access 検査の削除、revision 比較の削除、primary 検査の削除はいずれもテストが失敗した。

### 1.3 ホスト結合未実施

- `../eumenes` での `file:../eumenes_memory` 依存追加、`bun install`、Eumenes の `tsc` / テスト（M1）。M0 では `tsconfig.compat.json`（Eumenes と同じ compilerOptions）と、スクラッチの consumer プロジェクト（リポジトリ外、`file:` 依存 → `bun install` → `bun` 実行 + `tsc --noEmit` が成功）で代替確認した。Eumenes 自体は読み取りのみで変更していない。
- Eumenes アダプター（Continuity / conversation の snapshot 化、本文込みの transaction 内読み出し、number revision の文字列化）。
- 検査と回答保存の原子性、queue の attempt / lease 検査、UsageReceipt、Invalidation。
- tarball / manifest / `artifacts/` / vendor 取り込み（設計方針により後続）。
- 実データでの message 長測定（R1）。

## 2. 公開 API

`src/index.ts` が唯一の公開面。export 一覧は `src/contracts/test/exports.test.ts` で固定している（16 件）。

| export | 内容 |
|---|---|
| `buildMemoryView(input)` | parse → disabled → access → 依存検査 → 構成 → 予算。`ready` / `disabled` / `blocked` / `overflow` を返す |
| `validateMemoryView(view, current)` | `valid`（`viewDigest` 付き）または `invalid` + reasonCode |
| `parseBuildMemoryViewInput` / `parseValidationCurrent` / `parseMemoryView` | 検査済みの deep-frozen コピーを返す。違反は `MemoryContractError` |
| `MemoryContractError` / `isMemoryContractError` / `CONTRACT_ERROR_CODES` | `code` と `path` のみ。message は `${code} at ${path}` 固定で入力値・キー名を含まない |
| `SCHEMA_VERSION`(1) / `LIMITS` / `ITEM_KINDS` / `ITEM_STATUSES` / `ITEM_ORIGINS` / `SOURCE_STATUSES` | frozen 定数 |
| `BUILD_REASON_CODES` / `VALIDATION_REASON_CODES` | frozen タプル（順序は設計書 §2.2 / §2.3） |
| 型 | `BuildMemoryViewInput`, `ValidationCurrent`, `MemoryView`（`status` で narrowing する判別共用体）, `SourceRef`, `SourceState`, `MemoryItem`, `Snapshot` ほか |

## 3. 挙動の要点

- 判定順: 例外（入力不正）→ `MEMORY_DISABLED` → access（`PRINCIPAL_MISMATCH` > `SCOPE_NOT_PERMITTED` > `POLICY_REVISION_MISMATCH` > `SNAPSHOT_INCOMPLETE`）→ active item の依存（id 昇順、依存は SourceRef 順、1 つ目の失敗）→ ready 構成 → `BUDGET_EXCEEDED`。`enabled: false` でも不正入力は例外。
- 空で complete な snapshot は空の `ready`。complete でなければ空でも `blocked`。
- 予算は viewDigest を含む最終 ready JSON の UTF-8 byte 長（`maxBytes` ちょうどは ready、+1 不足で overflow）。必須項目は切り捨てない。
- 順序は UTF-16 コード単位。`localeCompare` / `Intl` / `Date` / `Math.random` は使わない（`test/src-hygiene.test.ts` が静的に検査）。
- range は UTF-8 のコードポイント境界のみ検査。書記素クラスタ（ZWJ 絵文字列の途中など）は許可する。
- 非 ready の結果は reasonCode だけを持ち、item ID・source ID・本文・差分値を含めない。
- `validateMemoryView` の `valid` は、渡された current との一致だけを意味する。古い snapshot を再提示された場合の安全性、検査と回答保存の原子性、queue の attempt / lease はホストの責任。

## 4. verify

```sh
bun run verify    # = bun scripts/verify.ts
```

ステップ（失敗した時点で非 0 終了し、ステップ名を表示。レポートファイルは書かない）:

1. `format` — `oxfmt --check`
2. `lint` — `oxlint --deny-warnings`
3. `typecheck` — `tsc --noEmit -p tsconfig.json`（src / test / scripts、`exactOptionalPropertyTypes` など厳格設定）
4. `typecheck:eumenes-compat` — `tsc --noEmit -p tsconfig.compat.json`（Eumenes と同じ compilerOptions で `src` のみ）
5. `test` — `bun test`
6. `public-surface` — `test/consumer` の import が許可リスト（`eumenes-memory` / `bun:test` / `../fixture-runner.ts` / `node:`）に収まり、`test/fixture-runner.ts` が src を import しないことの静的検査（`scripts/public-surface.ts`、検査自体は `test/public-surface.test.ts` で違反例を含めて試験）

実行結果（2026-10-08、この環境: bun 1.4.2 / tsc 5.9.3 / node v24.11.1）: **exit 0**。

```text
==> format                    ok  (All matched files use the correct format.)
==> lint                      ok
==> typecheck                 ok
==> typecheck:eumenes-compat  ok
==> test                      ok  (397 pass, 0 fail, 11 files)
==> public-surface            ok
verify ok: format, lint, typecheck, typecheck:eumenes-compat, test, public-surface
```

## 5. 設計書からの逸脱・補足判断

| # | 内容 | 理由 |
|---|---|---|
| 1 | ライセンスは `MIT`、`LICENSE` ファイルを作成（著作者表記 "Eumenes Memory contributors"）。設計書 D23 / Q1 の `UNLICENSED` ではない | ユーザー確認済みの決定。`private: true` は維持 |
| 2 | `bunfig.toml` に `exact = true` を追加（設計書 §6 の指定どおり）。`.gitignore` は設計書の `node_modules/` に加え dist / artifacts / `*.tgz` / verification-reports / coverage / `.serena` / `.DS_Store` / `*.log` | ユーザー確認済み |
| 3 | `deepFreeze` を `src/canonical/freeze.ts`、`sourceKey` を `src/contracts/source-key.ts` に置いた（設計書は `src/view/freeze.ts` と `src/view/source-ref.ts`）。`sourceKey` は `src/view/source-ref.ts` から再 export | parse（contracts 層）が両方を必要とし、設計書の依存方向 `canonical ← contracts ← view ← validation` を守るため。`test/src-hygiene.test.ts` が依存方向を検査 |
| 4 | `public-surface` の本体を `scripts/public-surface.ts` に分離し、`scripts/verify.ts` から呼ぶ。`test/public-surface.test.ts` と `test/src-hygiene.test.ts` を追加 | 検査自体を違反例で試験するため。設計書の記載は verify.ts 内 |
| 5 | `.oxfmtrc.json` の ignorePatterns に `fixtures/**` と `.claude/**`（ツール設定。自動更新されるため）を追加。`.oxlintrc.json` は react 系 plugin を除外 | fixture は言語非依存の生成物で、整形差分で期待値を揺らさないため。react 系は不要（設計書 §6） |
| 6 | canonical fixture の SHA-256 は `shasum` ではなく Python `hashlib` で算出した。canonical 文字列は手書き | 設計書 §7.1 は `shasum` を例示。独立実装である点は同じ |
| 7 | fixture runner の入力複製は `structuredClone` ではなく JSON の往復（`JSON.parse(JSON.stringify())`）を使う | E03 の own `__proto__` キーを確実に保つため |
| 8 | `access.scopeKeys` の空配列は受理する（型コメントは `1..maxScopeKeys`）。`scope` が許可されず `SCOPE_NOT_PERMITTED` で blocked になる | 設計書に空配列用の例外コードがなく、fail closed の domain 結果に落ちるため。変更するなら親担当の判断 |
| 9 | `schemaVersion` が number でも整数でない場合は `INVALID_INTEGER`、number 以外は `INVALID_TYPE` | 設計書は `INVALID_TYPE` → `UNSUPPORTED_SCHEMA_VERSION` の順のみ規定 |
| 10 | `PRIMARY_SOURCE_NOT_IN_DEPENDENCIES` の path は `<item>.primarySource`、view の `dependencies` 内重複は `DUPLICATE_SOURCE`（path は後から出た要素）、view の `reasonCode` が列挙外なら `INVALID_ENUM`、列挙内だが status と不整合なら `INVALID_VALUE`、view item の `status` が `active` 以外は `INVALID_ENUM` | 設計書が path / コードを明示していない箇所の補完 |
| 11 | 配列の構造違反（穴・非 index プロパティ・accessor）は長さ判定（`ARRAY_TOO_LONG`）の後、要素検査の前に `INVALID_PROPERTY` | 設計書 §2.1 の順序（長さ → 要素）と矛盾しない範囲で位置を確定 |

### 設計書内の不整合（編集せず報告のみ）

- §7.4 B39 の説明「UTF-16 長以内に収まる値を選び」は、byte 長 + 1 の `endByte` と両立しない（byte 長 ≥ UTF-16 長のため）。fixture は `endByte = byte 長 + 1`（content 51 byte、UTF-16 長 19、`endByte = 52`）とし、code unit 判定の誤りは B06（`endByte = 51`、UTF-16 長 19 より大きいが byte 長と一致するので ready）と合わせて検出する。
- §8.1 で `file:` 依存は「ファイル単位の symlink」とあるが、スクラッチ consumer では `node_modules/eumenes-memory/` に `.git` / `.claude` ディレクトリ構造も作られた（内容は symlink）。動作に影響はないが、M1 で Eumenes の `node_modules` 内の見え方を確認すること。

## 6. 既知の制限・リスク（設計書 §11 を含む）

- **R1（未検証）**: 上限は Eumenes の定数に基づく。会話 message 本文長の上限は未確認で、1 MiB 超の message は `STRING_TOO_LONG` の例外になる。M1 で実データを測る。
- **R2**: `file:` 依存では本パッケージに新規ファイルを追加すると Eumenes で `bun install` の再実行が必要（既存ファイルの編集は即時反映）。
- **R3**: reasonCode が 1 つだけなので、どの item / source が失効したかは分からない。必要なら契約変更として親担当へ。
- **R4**: Proxy は検出しない。ただし入力は一度コピーされ、型・enum はコピー時点で検査されるため、Proxy が構造検査をすり抜けた値を出力へ持ち込むことはない。残る影響は trap の副作用と非決定性だけ（呼び出し側の責任）。JSON 由来またはアダプター生成の plain データを渡すこと。cross-realm の plain object（別 realm の `Object.prototype`）は `INVALID_PROPERTY` になる。
- **R5**: 隣接 checkout（`../eumenes_memory`）前提。plan §7 の「両 checkout の HEAD に暗黙依存する恒久運用にしない」は後続の配布方式で解消する。Eumenes の `scripts/verify.ts` の source revision hash は `node_modules` を除外するため、本パッケージの変更を検知しない。Eumenes の concept 文書 E1 は `file:vendor/...tgz` を前提としており、本方式と食い違う（更新は M1 担当）。
- **R6**: Eumenes の tsconfig が変わると `tsconfig.compat.json` が追従しなければ M1 で初めて型エラーが出る。
- **R7（未検証）**: Bun が symlink 先の realpath でモジュール解決するかは未確認。依存ゼロのため M0 の動作に影響しない。
- 書記素クラスタの途中を指す range は許可される（コードポイント境界のみ検査）。
- 同一 stateRevision での active item 追加は `ITEM_SET_CHANGED`、無関係な変更による stateRevision 変化も invalid（安全側、契約 §4 許容）。
- 空 `scopeKeys` は blocked（逸脱 8）。
- Q2（Git 初期化）は親担当。コミット・push はしていない。

## 独立レビューと対応

reviewer による独立レビューを 2 周行った。契約・判定順序・UTF-8・digest・予算判定に確認できたバグはなく、指摘は防御の深さとテストの穴だった。修正後の `bun run verify` は 416 pass / exit 0。

- 省略可能キー（range / content / representation）を own-property だけで読む `ownValue`（`src/contracts/own.ts`）を、読み取り箇所すべてに適用。`Object.prototype` 汚染でも結果が変わらないことを `src/view/test/hardening.test.ts` で試験し、各適用箇所を元の直接参照へ戻すと対応するテストが落ちることを（リポジトリ外の複製で）確認した。
- `readRecord` は `Object.hasOwn(descriptor, "value")` で accessor を判定し、null-prototype コピーへ代入する（汚染された `value` / `get` の影響を受けない）。
- `coverage.omitted` に `LIMITS.maxCoverageOmitted`（16）を設け、巨大配列を全走査せず `ARRAY_TOO_LONG`。境界（16 件 / 17 件）を試験。
- validate 経由の `SOURCE_CONTENT_*`、`SOURCE_RANGE_OUT_OF_BOUNDS`、`SOURCE_RANGE_NOT_CHAR_BOUNDARY`、view・scopeKeys・source の lone surrogate を試験。
- `test/src-hygiene.test.ts` は `extractSpecifiers` を使い、動的 import / `require` も検出。禁止 API に `getRandomValues`・`performance.`・`globalThis` を追加。
- `.claude/settings.local.json` を `.gitignore` に追加。V8 のコメントと R4 の説明を実態に合わせた。
- 意図的に残した点: build.ts と compose.ts の「active 抽出 + id 順ソート」の数行の重複（reviewer も許容範囲と判断。3 箇所を超えたら共通化）。
