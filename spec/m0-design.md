# M0 詳細設計 (coder 向け)

2026-10-08 / 対象: M0 のみ。正本の上位文書は [implementation-plan.md](implementation-plan.md) §3・§8 と [contracts-v0.md](contracts-v0.md)。本書はそれを実装可能な粒度へ落とした設計で、§10 に契約の曖昧点に対して下した決定を列挙する。契約と本書が食い違う場合は本書 §10 の決定を優先し、変更が必要なら親担当へ戻す。

**方針（親担当決定 2026-10-08）**: 配布方式は重視しない。M0 の目標は「隣接 checkout の `../eumenes` が M0 を `eumenes-memory` として import して使えること」。plan §7 の `.tgz` / manifest / `artifacts/` / vendor 取り込み / 一時 consumer による tarball 検証は**後続**（M1 以降で必要になった時点で設計）。

確認済みの事実（2026-10-08、この環境）
- ツール: bun 1.4.2、node v24.11.1。リポジトリは Git 未初期化。
- `../eumenes`: Bun + TypeScript 5.9.3（`strict`, `noUncheckedIndexedAccess`, `module: ESNext`, `moduleResolution: Bundler`, `allowImportingTsExtensions`, `noEmit`, `skipLibCheck`, `lib: ES2022+DOM`, `types: ["bun","vite/client"]`）、ESM、zod 4.4.3、oxlint 1.86.0（`--deny-warnings`、categories.correctness=error）、oxfmt 0.71.0（タブ、printWidth 80、ダブルクォート、trailingComma all）、依存は完全固定版、`bunfig.toml` に `minimumReleaseAge = 604800` と `peer = false`。domain のテストは `api/domains/<d>/test/*.test.ts` を `bun test` で実行。`scripts/verify.ts` は format → lint → typecheck → test と domain 境界検査（相対 import のみ対象、bare specifier は対象外）。
- Continuity（`api/domains/continuity/contracts`）: kind `goal|decision|open_question`、status `active|inactive`、origin `user_confirmed|user_edited` は本契約と同名。`revision` / `stateRevision` は `number`（int）。bookmark は単一の `sourceMessageId` と `sourceDigest = sha256(message.text)`（UTF-8、小文字 hex）を持ち、range はない。source 状態は `ok|missing|changed`（forgotten なし）。本文上限 `BOOKMARK_TEXT_MAX = 2000`（UTF-16 長、trim 後）、active 上限 `ACTIVE_BOOKMARK_MAX = 50`、bookmark id は `/^[A-Za-z0-9._:-]+$/` かつ 200 文字以下、conversationId は 120 文字以下。既存の純粋投影 `projectContinuity` は `JSON.stringify` で予算判定し自由文の `reason` を返す（M1 で本パッケージに置き換える対象。M0 では触らない）。
- 会話 message（`conversation/contracts`）は `id, conversationId, role, text, createdAt, runId` を持ち、message 単位の revision はない。

## 0. ゴールと非ゴール

ゴール
- 単一パッケージ `eumenes-memory`（ESM のみ、**TS ソースを直接 export**、実行時依存ゼロ）で `buildMemoryView` / `validateMemoryView` と入力パーサを提供する。
- Eumenes が `"eumenes-memory": "file:../eumenes_memory"` で取り込み、`import { buildMemoryView } from "eumenes-memory"` が Bun 実行・Eumenes の `tsc --noEmit` の両方で通る状態にする（§8.1）。
- 言語非依存の JSON fixture（期待 digest 直書き）で挙動を固定する。
- `bun run verify`（format:check + lint + typecheck + Eumenes 互換 typecheck + test）を通す。

非ゴール（M0 で作らない）
- DB、HTTP、LLM、Records、検索、抽出、World、Rust 連携。
- `../eumenes` 配下の変更（依存追加・アダプター実装は M1。§12 は M1 担当への参考情報）。
- ビルド成果物（dist）、tarball、manifest、npm pack（後続）。
- 公開 canonical/digest API（内部モジュールに留める）。
- Git の初期化・コミット（親担当の指示待ち）。

## 1. 公開 API と型

### 1.1 runtime exports（`src/index.ts` が唯一の公開面）

| export | 種別 | 定義ファイル |
|---|---|---|
| `buildMemoryView` | function | `src/view/build.ts` |
| `validateMemoryView` | function | `src/validation/validate.ts` |
| `parseBuildMemoryViewInput` | function | `src/contracts/parse-input.ts` |
| `parseValidationCurrent` | function | `src/contracts/parse-input.ts` |
| `parseMemoryView` | function | `src/contracts/parse-view.ts` |
| `MemoryContractError` | class | `src/contracts/errors.ts` |
| `isMemoryContractError` | function | `src/contracts/errors.ts` |
| `SCHEMA_VERSION` | const `1` | `src/contracts/constants.ts` |
| `LIMITS` | frozen object | `src/contracts/constants.ts` |
| `ITEM_KINDS` / `ITEM_STATUSES` / `ITEM_ORIGINS` / `SOURCE_STATUSES` | frozen readonly tuple | `src/contracts/constants.ts` |
| `BUILD_REASON_CODES` / `VALIDATION_REASON_CODES` | frozen readonly tuple | `src/contracts/reason-codes.ts` |
| `CONTRACT_ERROR_CODES` | frozen readonly tuple | `src/contracts/errors.ts` |

`src/contracts/test/exports.test.ts` で `Object.keys(await import("../../index.ts")).sort()` が上表と完全一致することを検査する（export の増減を検知）。

### 1.2 関数シグネチャ

```ts
export function buildMemoryView(input: BuildMemoryViewInput): MemoryView;
export function validateMemoryView(view: MemoryView, current: ValidationCurrent): MemoryViewValidation;
export function parseBuildMemoryViewInput(value: unknown): BuildMemoryViewInput;   // 失敗時 MemoryContractError
export function parseValidationCurrent(value: unknown): ValidationCurrent;
export function parseMemoryView(value: unknown): MemoryView;
export function isMemoryContractError(value: unknown): value is MemoryContractError;
```

- 引数の静的型は TS 利用者の補助であり、`buildMemoryView` / `validateMemoryView` は内部で必ず parse を実行する（JSON 由来の値をキャストして渡されても検査される）。
- parse は入力を読むだけで、検証済みの**新しいオブジェクト**を返す（parse-don't-validate）。以降の処理はこのコピーだけを使う。入力オブジェクトは一切変更しない。
- 戻り値は新規構築し deep-freeze する（入力と参照を共有しない）。parse 系の戻り値も deep-freeze する。
- モジュールレベルの可変状態を持たない（digest のメモ化は呼び出しローカル Map）。`Date`、`Math.random`、`crypto.randomUUID`、`localeCompare`、`Intl` を使わない。

### 1.3 型（`src/contracts/types.ts`、全フィールド readonly）

```ts
export type SchemaVersion = 1;
export type ItemKind = "goal" | "decision" | "open_question";
export type ItemStatus = "active" | "inactive";
export type ItemOrigin = "user_confirmed" | "user_edited";
export type SourceStatus = "available" | "missing" | "changed" | "forgotten";
export type InstructionAuthority = "none";

export interface AccessContext {
  readonly principal: string;
  readonly scopeKeys: readonly string[];      // 1..LIMITS.maxScopeKeys、重複禁止
  readonly purpose: string;
  readonly policyRevision: string;
}

export interface ByteRange { readonly startByte: number; readonly endByte: number; } // [start, end), start < end

// item が参照する出典（期待する版・digest・任意の引用範囲）
export interface SourceRef {
  readonly namespace: string;
  readonly kind: string;
  readonly id: string;
  readonly representation?: string;
  readonly revision: string;
  readonly digest: string;                    // /^[0-9a-f]{64}$/、representation 全体の UTF-8 bytes の SHA-256
  readonly range?: ByteRange;
}

// snapshot が持つ出典の現在状態（range は持たない。§10 D2）
export interface SourceState {
  readonly namespace: string;
  readonly kind: string;
  readonly id: string;
  readonly representation?: string;
  readonly revision: string;
  readonly digest: string;
  readonly principal: string;
  readonly scopeKey: string;
  readonly status: SourceStatus;
  readonly content?: string;                  // representation 全体の本文。range 検査に必要
}

export interface MemoryItem {
  readonly id: string;                        // "<namespace>:<local>"
  readonly revision: string;
  readonly kind: ItemKind;
  readonly text: string;
  readonly status: ItemStatus;
  readonly origin: ItemOrigin;
  readonly primarySource: SourceRef;          // dependencies のいずれかと完全一致必須（§10 D3）
  readonly dependencies: readonly SourceRef[]; // 1..LIMITS.maxDependenciesPerItem
}

export interface Snapshot {
  readonly principal: string;
  readonly scopeKey: string;
  readonly stateRevision: string;
  readonly policyRevision: string;
  readonly complete: boolean;
  readonly sources: readonly SourceState[];
  readonly items: readonly MemoryItem[];
}

export interface BuildMemoryViewInput {
  readonly schemaVersion: SchemaVersion;
  readonly access: AccessContext;
  readonly snapshot: Snapshot;
  readonly maxBytes: number;                  // 0..Number.MAX_SAFE_INTEGER
  readonly enabled: boolean;
}

export interface ValidationCurrent {
  readonly schemaVersion: SchemaVersion;
  readonly access: AccessContext;
  readonly snapshot: Snapshot;
}

// ---- 出力 ----
export interface SourceDependency {          // view 全体の依存一覧（range なし、出典単位で重複排除）
  readonly namespace: string;
  readonly kind: string;
  readonly id: string;
  readonly representation?: string;
  readonly revision: string;
  readonly digest: string;
}

export interface ViewItem {
  readonly id: string;
  readonly revision: string;
  readonly kind: ItemKind;
  readonly status: "active";
  readonly origin: ItemOrigin;
  readonly text: string;
  readonly primarySource: SourceRef;
  readonly dependencies: readonly SourceRef[]; // §4.4 の順序で正規化済み
}

export interface ViewCoverage { readonly complete: true; readonly omitted: readonly never[]; }

interface ViewHeader {
  readonly schemaVersion: SchemaVersion;
  readonly principal: string;
  readonly scopeKey: string;
  readonly purpose: string;                   // §10 D1
  readonly stateRevision: string;
  readonly policyRevision: string;
  readonly instructionAuthority: InstructionAuthority;
}

export interface ReadyMemoryView extends ViewHeader {
  readonly status: "ready";
  readonly items: readonly ViewItem[];
  readonly dependencies: readonly SourceDependency[];
  readonly coverage: ViewCoverage;
  readonly viewDigest: string;
}
export interface BlockedMemoryView extends ViewHeader { readonly status: "blocked"; readonly reasonCode: BlockedReasonCode; }
export interface OverflowMemoryView extends ViewHeader { readonly status: "overflow"; readonly reasonCode: "BUDGET_EXCEEDED"; }
export interface DisabledMemoryView extends ViewHeader { readonly status: "disabled"; readonly reasonCode: "MEMORY_DISABLED"; }
export type MemoryView = ReadyMemoryView | BlockedMemoryView | OverflowMemoryView | DisabledMemoryView;

export type MemoryViewValidation =
  | { readonly schemaVersion: SchemaVersion; readonly status: "valid"; readonly viewDigest: string }
  | { readonly schemaVersion: SchemaVersion; readonly status: "invalid"; readonly reasonCode: ValidationReasonCode };
```

`ViewHeader` の値（非 ready も同じ規則、§10 D4）: `principal` = access.principal、`policyRevision` = access.policyRevision、`purpose` = access.purpose、`scopeKey` = snapshot.scopeKey、`stateRevision` = snapshot.stateRevision、`instructionAuthority` = `"none"`。ready では access と snapshot の値が一致済み。

`tsconfig` は `exactOptionalPropertyTypes: true`。任意フィールドは「キー不在」で表し、`undefined` 値は parse で `INVALID_TYPE`。

### 1.4 例外

```ts
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];
export class MemoryContractError extends Error {
  readonly name: "MemoryContractError";
  readonly code: ContractErrorCode;
  readonly path: string;      // 例 "$.snapshot.items[2].dependencies[0].range"
  // message は `${code} at ${path}` 固定。入力値・キー名・原文を含めない
}
```
`isMemoryContractError` は `instanceof` に加え `name === "MemoryContractError"` かつ `code` が既知コード、で判定（複数コピーのパッケージ対策）。インスタンスは freeze しない（Error の stack 書き換えと衝突するため）。

## 2. reasonCode と判定優先順位

reasonCode は列挙の文字列だけを返す。item ID・source ID・本文・差分値を含めない。複数の失敗が同時に起きた場合は**下表の番号が最も小さいもの一つ**を返す（短絡評価で最初に見つけたもの）。

### 2.1 例外（MemoryContractError）— すべてのドメイン判定より先

`CONTRACT_ERROR_CODES`（この順で定義）:

| code | 発生条件 |
|---|---|
| `INVALID_TYPE` | 期待型と異なる（object/array/string/boolean/number、`null`、`undefined` 値） |
| `INVALID_PROPERTY` | plain object でない（prototype が `Object.prototype` / `null` 以外）、accessor property、symbol キー、配列の穴・配列の非 index 自前プロパティ |
| `UNSUPPORTED_SCHEMA_VERSION` | `schemaVersion` が整数だが `1` 以外 |
| `UNKNOWN_KEY` | 未定義キー（`__proto__`、`constructor` 等の own property を含む）。path は**親オブジェクト**（キー名を出さない） |
| `MISSING_KEY` | 必須キー不在。path は不足キーを含む（キー名はスキーマ由来なので可） |
| `INVALID_ENUM` | kind/status/origin/source status/instructionAuthority/view status/reasonCode が列挙外 |
| `EMPTY_STRING` | 空文字が禁止されたフィールド（§3.2） |
| `INVALID_STRING` | lone surrogate を含む（全文字列）、識別子に制御文字 U+0000–U+001F, U+007F を含む |
| `STRING_TOO_LONG` | UTF-8 byte 長が上限超過 |
| `ARRAY_TOO_LONG` | 配列長が上限超過（要素検査の前に判定） |
| `INVALID_INTEGER` | 安全な整数でない、範囲外（負数等） |
| `INVALID_DIGEST` | `/^[0-9a-f]{64}$/` に不一致 |
| `INVALID_ID_FORMAT` | item ID・namespace・source kind の書式違反（§3.2） |
| `INVALID_RANGE` | `startByte >= endByte`（内容に依存しない構造違反） |
| `INVALID_VALUE` | 定数値違反（view の `coverage` が `{complete:true, omitted:[]}` でない、non-ready view の reasonCode が status と不整合 等） |
| `DUPLICATE_SCOPE_KEY` | `access.scopeKeys` 内の重複 |
| `DUPLICATE_SOURCE` | `snapshot.sources` で出典キー（§4.4）が重複 |
| `TOTAL_CONTENT_TOO_LARGE` | `sources[].content` の UTF-8 byte 合計が上限超過 |
| `DUPLICATE_DEPENDENCY` | 1 item の dependencies に完全一致の SourceRef が 2 つ以上 |
| `CONFLICTING_DEPENDENCY` | 1 item 内で同じ出典キーなのに revision または digest が異なる |
| `PRIMARY_SOURCE_NOT_IN_DEPENDENCIES` | primarySource と完全一致する dependency がない |
| `DUPLICATE_ITEM_ID` | `snapshot.items` / view `items` で id 重複 |

例外の決定的順序（同時違反時にどれを投げるか）: 深さ優先・スキーマ宣言順の走査で最初に見つかった違反。各オブジェクトでは次の順:
1. 値が object か（`INVALID_TYPE`）、plain object か（`INVALID_PROPERTY`）。symbol キー・accessor は `Reflect.ownKeys` + `Object.getOwnPropertyDescriptor` で検出。
2. **トップレベルのみ**: `schemaVersion` を先に検査（`MISSING_KEY` → `INVALID_TYPE` → `UNSUPPORTED_SCHEMA_VERSION`）。未知の版で新キーがあっても `UNSUPPORTED_SCHEMA_VERSION` を返すため。
3. 未知キー（`UNKNOWN_KEY`）。
4. 宣言順に各フィールド: 不在なら `MISSING_KEY`、あれば値を再帰検査。
5. 配列は長さ（`ARRAY_TOO_LONG`）→ 各要素 → 配列全体の重複・整合検査。

フィールド宣言順（= 走査順）:
- BuildMemoryViewInput: `schemaVersion, access, snapshot, maxBytes, enabled`
- ValidationCurrent: `schemaVersion, access, snapshot`
- AccessContext: `principal, scopeKeys(→DUPLICATE_SCOPE_KEY), purpose, policyRevision`
- Snapshot: `principal, scopeKey, stateRevision, policyRevision, complete, sources(→DUPLICATE_SOURCE→TOTAL_CONTENT_TOO_LARGE), items(→DUPLICATE_ITEM_ID)`
- SourceState: `namespace, kind, id, representation?, revision, digest, principal, scopeKey, status, content?`
- MemoryItem: `id, revision, kind, text, status, origin, primarySource, dependencies(→DUPLICATE_DEPENDENCY→CONFLICTING_DEPENDENCY→PRIMARY_SOURCE_NOT_IN_DEPENDENCIES)`
- SourceRef: `namespace, kind, id, representation?, revision, digest, range?`、ByteRange: `startByte, endByte(→INVALID_RANGE)`
- MemoryView: `schemaVersion, status, principal, scopeKey, purpose, stateRevision, policyRevision, instructionAuthority`、ready なら続けて `items, dependencies, coverage, viewDigest`、それ以外は `reasonCode`。許可キー集合は status で切り替える（status を unknown-key 検査より先に読む: schemaVersion → status → 未知キー → 残り）。

重複検査はすべて「後から出た要素」の path（例 `$.snapshot.items[5]`）を報告する。数値の `-0` は `0` に正規化してコピーする。

### 2.2 build のドメイン結果（`BUILD_REASON_CODES`）

parse 成功後、次の番号順で判定する。

| 順 | status | reasonCode | 条件 |
|---|---|---|---|
| 1 | disabled | `MEMORY_DISABLED` | `enabled === false` |
| 2a | blocked | `PRINCIPAL_MISMATCH` | access.principal ≠ snapshot.principal |
| 2b | blocked | `SCOPE_NOT_PERMITTED` | snapshot.scopeKey ∉ access.scopeKeys |
| 2c | blocked | `POLICY_REVISION_MISMATCH` | access.policyRevision ≠ snapshot.policyRevision |
| 2d | blocked | `SNAPSHOT_INCOMPLETE` | snapshot.complete === false |
| 3 | blocked | 下表 3.x | active item の依存検査（共通関数 `checkDependencies`） |
| 4 | — | — | inactive 除外・順序固定（失敗しない） |
| 5 | overflow | `BUDGET_EXCEEDED` | 最終 ready JSON の UTF-8 byte 長 > maxBytes |
| — | ready | — | 上記すべて通過 |

2a–2d は共通関数 `checkAccess(access, snapshot)`（`src/view/access-check.ts`）。

**3. 依存検査（`checkDependencies`、`src/view/dependency-check.ts`）**: active item を id のコード単位昇順で走査し、各 item の dependencies を §4.4 の SourceRef 順で走査する（入力順に依存しない）。dependency ごとに次の順で最初の失敗を返す。primarySource は dependencies に含まれているので別途検査しない。

| 順 | reasonCode | 条件 |
|---|---|---|
| 3a | `SOURCE_NOT_IN_SNAPSHOT` | 出典キーに一致する SourceState がない |
| 3b | `SOURCE_NOT_PERMITTED` | state.principal ≠ snapshot.principal または state.scopeKey ≠ snapshot.scopeKey |
| 3c | `SOURCE_MISSING` | state.status = missing |
| 3d | `SOURCE_CHANGED` | state.status = changed |
| 3e | `SOURCE_FORGOTTEN` | state.status = forgotten |
| 3f | `SOURCE_REVISION_MISMATCH` | ref.revision ≠ state.revision |
| 3g | `SOURCE_DIGEST_MISMATCH` | ref.digest ≠ state.digest |
| 3h | `SOURCE_CONTENT_DIGEST_MISMATCH` | state.content があり sha256(UTF-8(content)) ≠ state.digest（range の有無に関係なく検査） |
| 3i | `SOURCE_CONTENT_REQUIRED` | ref.range があり state.content がない |
| 3j | `SOURCE_RANGE_OUT_OF_BOUNDS` | ref.range.endByte > byteLength(content) |
| 3k | `SOURCE_RANGE_NOT_CHAR_BOUNDARY` | startByte または endByte が UTF-8 文字境界でない（§5） |

inactive item の依存は検査しない（schema 検査と重複検査は行う）。どの active item にも参照されない SourceState は schema 以外検査しない。

`BUILD_REASON_CODES` = `["MEMORY_DISABLED","PRINCIPAL_MISMATCH","SCOPE_NOT_PERMITTED","POLICY_REVISION_MISMATCH","SNAPSHOT_INCOMPLETE","SOURCE_NOT_IN_SNAPSHOT","SOURCE_NOT_PERMITTED","SOURCE_MISSING","SOURCE_CHANGED","SOURCE_FORGOTTEN","SOURCE_REVISION_MISMATCH","SOURCE_DIGEST_MISMATCH","SOURCE_CONTENT_DIGEST_MISMATCH","SOURCE_CONTENT_REQUIRED","SOURCE_RANGE_OUT_OF_BOUNDS","SOURCE_RANGE_NOT_CHAR_BOUNDARY","BUDGET_EXCEEDED"]`
型: `AccessReasonCode`（2a–2d）、`SourceReasonCode`（3a–3k）、`BlockedReasonCode = AccessReasonCode | SourceReasonCode`、`BuildReasonCode = "MEMORY_DISABLED" | BlockedReasonCode | "BUDGET_EXCEEDED"`。

### 2.3 validate の結果（`VALIDATION_REASON_CODES`）

`validateMemoryView(view, current)`: まず `parseMemoryView(view)` と `parseValidationCurrent(current)` を（この順で）実行し、違反は例外。その後次の番号順。

| 順 | reasonCode | 条件 |
|---|---|---|
| V1 | `VIEW_NOT_READY` | view.status ≠ ready |
| V2 | `VIEW_DIGEST_MISMATCH` | view から viewDigest を除いた本体の再計算 digest ≠ view.viewDigest |
| V3a–d | `PRINCIPAL_MISMATCH` / `SCOPE_NOT_PERMITTED` / `POLICY_REVISION_MISMATCH` / `SNAPSHOT_INCOMPLETE` | `checkAccess(current.access, current.snapshot)`（build と同じ関数） |
| V4a | `PRINCIPAL_MISMATCH` | view.principal ≠ current.access.principal |
| V4b | `SCOPE_MISMATCH` | view.scopeKey ≠ current.snapshot.scopeKey |
| V4c | `PURPOSE_MISMATCH` | view.purpose ≠ current.access.purpose |
| V4d | `POLICY_REVISION_MISMATCH` | view.policyRevision ≠ current.access.policyRevision |
| V4e | `STATE_REVISION_MISMATCH` | view.stateRevision ≠ current.snapshot.stateRevision |
| V5 | item 差分（view.items の並び順で、item ごとに a→d） | |
| V5a | `ITEM_MISSING` | current.snapshot.items に同じ id がない |
| V5b | `ITEM_INACTIVE` | current の同 id が inactive |
| V5c | `ITEM_REVISION_CHANGED` | revision 不一致（本文が同じでも invalid） |
| V5d | `ITEM_CONTENT_CHANGED` | kind / text / origin / primarySource / 正規化済み dependencies のいずれかが不一致（canonical JSON 比較） |
| V6 | `ITEM_SET_CHANGED` | current の active item に view にない id がある |
| V7 | 3a–3k の `SOURCE_*` | `checkDependencies(view.items, current.snapshot)`（build と同じ関数。期待値は view 側の SourceRef） |
| V8 | `VIEW_REBUILD_MISMATCH` | current から ready 本体を再構成（`composeReadyBody(current.access, current.snapshot)`、予算判定なし）して digest を再計算し、view.viewDigest と不一致 |
| — | valid | すべて通過。`viewDigest` は V8 の再計算値 |

V8 は V1–V7 が正しければ到達しない防御（二重構え）。到達した場合はバグか未想定の差分。V8 用 fixture は作らず、unit test で「V1–V7 を迂回する内部関数呼び出し」により発火を確認する（§7.4）。

`VALIDATION_REASON_CODES` = `["VIEW_NOT_READY","VIEW_DIGEST_MISMATCH","PRINCIPAL_MISMATCH","SCOPE_NOT_PERMITTED","POLICY_REVISION_MISMATCH","SNAPSHOT_INCOMPLETE","SCOPE_MISMATCH","PURPOSE_MISMATCH","STATE_REVISION_MISMATCH","ITEM_MISSING","ITEM_INACTIVE","ITEM_REVISION_CHANGED","ITEM_CONTENT_CHANGED","ITEM_SET_CHANGED", ...SourceReasonCode(3a–3k の順), "VIEW_REBUILD_MISMATCH"]`

## 3. 入力上限と文字列規則

### 3.1 上限（`LIMITS`、すべて UTF-8 byte または個数）

| 定数 | 値 | 対象 | 根拠 |
|---|---|---|---|
| `maxPrincipalBytes` | 256 | principal（access/snapshot/source） | 認証 ID・UUID・URI 程度を収容 |
| `maxScopeKeyBytes` | 256 | scopeKey / scopeKeys 要素 | Eumenes の想定値 `conversation:<conversationId≤120>` を収容 |
| `maxScopeKeys` | 64 | access.scopeKeys | M0 は単一 scope 利用。将来の合成用に余裕 |
| `maxPurposeBytes` | 64 | purpose | 短い用途トークン想定 |
| `maxRevisionBytes` | 256 | stateRevision / policyRevision / item・source revision | 数値の文字列化、または `sha256:<hex64>` を収容 |
| `maxNamespaceBytes` | 64 | source namespace、item ID の namespace 部 | 識別子 |
| `maxSourceKindBytes` | 64 | source kind | 識別子 |
| `maxSourceIdBytes` | 256 | source id | message id 等 |
| `maxRepresentationBytes` | 64 | representation | `"text"` 等 |
| `maxItemIdBytes` | 256 | item id 全体 | `continuity:` + bookmark id（ASCII ≤200）= 211 byte を収容 |
| `maxItemTextBytes` | 16384 | item text | Eumenes の `BOOKMARK_TEXT_MAX = 2000`（UTF-16 長）は最大 6000 byte。約 2.7 倍の余裕 |
| `maxSourceContentBytes` | 1048576 | 1 source の content | 会話 message 1 件。Eumenes 側に message 長の上限は見当たらない（R1） |
| `maxTotalSourceContentBytes` | 16777216 | content 合計 | 1 呼び出しのメモリ・SHA-256 計算量の上限 |
| `maxSources` | 4096 | snapshot.sources、view.dependencies | item × 依存 の実用上限 |
| `maxItems` | 1000 | snapshot.items、view.items | Eumenes の active 上限 50（inactive を含めても余裕） |
| `maxDependenciesPerItem` | 32 | item.dependencies（primarySource を含む） | Eumenes は 1 bookmark 1 source。将来の複数根拠用 |

maxBytes は `0..Number.MAX_SAFE_INTEGER` の整数（上限定数なし）。range の startByte/endByte は `0..maxSourceContentBytes` の整数。
文字列の長さ判定は `s.length > limit` なら即 `STRING_TOO_LONG`（UTF-8 bytes ≥ UTF-16 長のため）、そうでなければ `utf8ByteLength(s)` で判定。

### 3.2 文字列種別

| 種別 | 対象 | 規則 |
|---|---|---|
| 識別子 | principal, scopeKey(s), purpose, 各 revision, representation, source id | 非空（`EMPTY_STRING`）、制御文字なし・lone surrogate なし（`INVALID_STRING`） |
| 名前トークン | namespace、source kind | 識別子規則 + `/^[a-z][a-z0-9._-]*$/`（`INVALID_ID_FORMAT`） |
| item ID | item.id | 識別子規則 + 最初の `:` の前が名前トークン書式で `maxNamespaceBytes` 以下、後ろが非空（`INVALID_ID_FORMAT`） |
| 本文 | item.text（非空必須）、source content（空可） | lone surrogate なし。改行・タブ等の制御文字は許可 |
| digest | digest / viewDigest | `/^[0-9a-f]{64}$/` |

検査順: 型 → 空 → 長さ → lone surrogate/制御文字 → 書式。

## 4. 正規化 JSON と digest

### 4.1 正規化 JSON（`src/canonical/json.ts` の `canonicalJson(value): string`）

RFC 8785 (JCS) のサブセット。受理する値: plain object、array、string、boolean、安全な整数。`null`、`undefined`、非整数、非安全整数、`NaN`/`Infinity`、その他の型は内部エラー（`TypeError`、コアのバグ扱い。公開 API には出ない）。
- 空白なし。区切りは `,` と `:`。
- object のキーは UTF-16 コード単位の昇順（比較関数 `compareCodeUnits(a,b)` = `a < b ? -1 : a > b ? 1 : 0`。`localeCompare` 禁止）。値が `undefined` のキーは内部エラー（任意フィールドは不在にする）。
- 文字列は `JSON.stringify(s)` の出力と同一（well-formed 文字列では JCS と一致: `"` `\` を escape、U+0000–U+001F は `\b \t \n \f \r` か `\u00xx`（小文字 hex）、それ以外の非 ASCII・U+2028/2029 はそのまま）。lone surrogate は parse 段階で排除済み。
- 整数は `String(n)`（`-0` は `"0"`）。
- 配列は与えられた順（並べ替えは view 構成側の責任、§4.4）。

### 4.2 SHA-256（`src/canonical/sha256.ts`）

`sha256Hex(data: string | Uint8Array): string` — 文字列は UTF-8 に変換してハッシュ、出力は小文字 hex 64 文字。`node:crypto` の `createHash` を import するのはこのファイルだけ（将来差し替え点）。同期。

### 4.3 viewDigest の対象

- 対象 = ready view から `viewDigest` キーだけを除いたオブジェクト（以下 ReadyBody）。含むキー: `schemaVersion, status, principal, scopeKey, purpose, stateRevision, policyRevision, instructionAuthority, items, dependencies, coverage`。
- `viewDigest = sha256Hex(canonicalJson(ReadyBody))`。接頭辞なし。ドメイン分離文字列なし（`schemaVersion` と `status` が本体に含まれるため）。
- 予算: `finalView = { ...ReadyBody, viewDigest }`、`viewBytes = utf8ByteLength(canonicalJson(finalView))`。`viewBytes > maxBytes` で overflow、`viewBytes === maxBytes` は ready。`JSON.stringify(finalView)` の byte 長も同値になる（キー順以外同一のため）ので、ホストが通常の JSON で送っても予算と一致する。

### 4.4 順序・正規化規則（view 構成 `src/view/compose.ts`）

- 出典キー: `(namespace, kind, id, representation)`。内部 Map キーは `JSON.stringify([namespace, kind, id, representation ?? null])`。
- `compareSourceRef(a,b)`: namespace → kind → id → representation（不在 < 存在、存在同士はコード単位）→ revision → digest → range（不在 < 存在、startByte 数値昇順 → endByte 数値昇順）。文字列比較はすべて `compareCodeUnits`。
- `items`: active のみ、id のコード単位昇順。各 item の `dependencies` を `compareSourceRef` で並べ替え。`primarySource` はそのまま。フィールドは §1.3 の ViewItem のとおり（`status: "active"` 固定）。
- `dependencies`（top level）: 全 active item の dependencies から range を除いた SourceDependency を出典キーで重複排除し、同じ比較で並べる（依存検査通過後なので同一キーの revision/digest は一致している）。
- `coverage = { complete: true, omitted: [] }`。
- 任意フィールド（representation、range）は入力に存在した場合だけ出力に含める。

### 4.5 実装上の分割

```ts
// src/view/compose.ts
export type ReadyBody = Omit<ReadyMemoryView, "viewDigest">;
export function composeReadyBody(access: AccessContext, snapshot: Snapshot): ReadyBody; // 4 と構造化。検査済み前提
// src/view/digest.ts
export function computeViewDigest(body: ReadyBody): string;
export function finalizeReadyView(body: ReadyBody): { view: ReadyMemoryView; byteLength: number };
// src/view/access-check.ts
export function checkAccess(access: AccessContext, snapshot: Snapshot): AccessReasonCode | null;
// src/view/dependency-check.ts
export function indexSources(sources: readonly SourceState[]): ReadonlyMap<string, SourceState>;
export function checkDependencies(
  items: readonly { readonly dependencies: readonly SourceRef[] }[], // 呼び出し側が id 順で渡す
  snapshot: Snapshot,
): SourceReasonCode | null; // 内部で indexSources・呼び出しローカルの content digest メモを使う
// src/view/source-ref.ts
export function sourceKey(ref: { namespace: string; kind: string; id: string; representation?: string }): string;
export function compareSourceRef(a: SourceRef, b: SourceRef): number;
// src/view/freeze.ts
export function deepFreeze<T>(value: T): T;
```

依存方向: `canonical ← contracts ← view ← validation ← index`。逆向き import 禁止。

## 5. UTF-8 処理と range 検査（`src/canonical/utf8.ts`）

```ts
export function utf8ByteLength(s: string): number;        // エンコードせずコード単位から計算
export function encodeUtf8(s: string): Uint8Array;        // TextEncoder
export function isWellFormedUtf16(s: string): boolean;    // lone surrogate 検出（String.prototype.isWellFormed に依存しない手書き）
export function isUtf8CharBoundary(bytes: Uint8Array, index: number): boolean;
```

- byte 長: U+0000–007F=1、U+0080–07FF=2、BMP のそれ以外=3、サロゲートペア=4。
- 文字境界: `index === 0 || index === bytes.length || (bytes[index] & 0xC0) !== 0x80`。`index > bytes.length` は境界でない（3j で先に弾く）。
- 境界はコードポイント境界。書記素クラスタ（ZWJ 絵文字列、結合文字、異体字セレクタ）の途中は**許可**する（§10 D8）。
- range 検査は 3i→3j→3k の順。startByte < endByte は parse 済み（`INVALID_RANGE`）。

例: `"あ😀"` は bytes `E3 81 82 F0 9F 98 80`（7 byte）。境界は 0,3,7。`[0,3)` と `[3,7)` は可、`[1,3)` `[3,5)` は 3k、`[0,8)` は 3j。

## 6. ディレクトリ構成と責務

テスト配置は Eumenes の domain 規約（`<domain>/test/*.test.ts`）に合わせ、各層の直下 `test/` に置く。相対 import は `.ts` 拡張子付き（`allowImportingTsExtensions`）。

```text
package.json                 §8.1
bun.lock                     bun install で生成し保存
bunfig.toml                  [install] exact = true, peer = false, minimumReleaseAge = 604800（Eumenes と同じ）
tsconfig.json                本体の typecheck（src, test, scripts）。§8.2
tsconfig.compat.json         Eumenes と同じ compilerOptions で src だけを typecheck。§8.2
.oxlintrc.json               Eumenes の設定を複製（plugins: typescript, unicorn, oxc。react 系は不要）
.oxfmtrc.json                Eumenes の設定を複製
.gitignore                   node_modules/
README.md                    既存。末尾に「Eumenes からの利用例」節を追記
src/index.ts                 公開 export のみ（§1.1）。ロジックを置かない
src/contracts/constants.ts   SCHEMA_VERSION, LIMITS, 列挙タプル
src/contracts/types.ts       §1.3 の型
src/contracts/reason-codes.ts  BUILD_/VALIDATION_REASON_CODES と派生型
src/contracts/errors.ts      MemoryContractError, CONTRACT_ERROR_CODES, isMemoryContractError
src/contracts/reader.ts      own-property 安全な読み出し部品（readObject(keys), readArray, readString(kind, limit), readSafeInteger, readBoolean, readEnum, path 生成）
src/contracts/parse-input.ts parseAccessContext, parseSnapshot, parseBuildMemoryViewInput, parseValidationCurrent
src/contracts/parse-view.ts  parseMemoryView（ViewItem, SourceDependency, coverage 含む）
src/contracts/test/*.test.ts reader / parse / limits（境界表駆動）
src/canonical/json.ts        canonicalJson
src/canonical/utf8.ts        §5
src/canonical/sha256.ts      sha256Hex（node:crypto 唯一の import）
src/canonical/compare.ts     compareCodeUnits
src/canonical/test/*.test.ts
src/view/access-check.ts     checkAccess
src/view/dependency-check.ts indexSources, checkDependencies
src/view/source-ref.ts       sourceKey, compareSourceRef
src/view/compose.ts          composeReadyBody
src/view/digest.ts           computeViewDigest, finalizeReadyView
src/view/freeze.ts           deepFreeze
src/view/build.ts            buildMemoryView（parse → 1 → 2 → 3 → 4 → 5 → freeze）
src/view/test/*.test.ts
src/validation/item-diff.ts  V5/V6（item 比較）
src/validation/validate.ts   validateMemoryView（V1–V8）
src/validation/test/*.test.ts
test/fixture-runner.ts       fixture 実行器（API を引数で受け取る。src を import しない）
test/fixtures.test.ts        内部関数（canonical/utf8 を含む）で全 fixture を実行
test/consumer/public-api.test.ts  "eumenes-memory"（package self-reference）だけを import。§8.4
fixtures/canonical/*.json    §7.2
fixtures/utf8/*.json
fixtures/build/*.json
fixtures/validate/*.json
scripts/verify.ts            §8.3
scripts/fixture-digest.py    fixture の期待 digest を独立計算する補助（runtime と別実装、§7.1）
spec/m0-validation.md        実装後に作成（plan §8）
```

Eumenes は package 全体を per-file symlink で取り込む（§8.1）が、`exports` が `src/index.ts` だけを指すので test/fixtures/scripts は Eumenes の型検査・実行対象にならない。

## 7. fixture

### 7.1 共通規則

- すべて UTF-8 JSON、1 ファイル 1 ケース、ファイル名 = `id` + `.json`。読み込みは `readFileSync` + `JSON.parse`（Bun の JSON import は `__proto__` の扱いが異なる可能性があるため使わない）。
- 期待 digest は直書き。**実装の出力をそのまま期待値にしない**。canonical fixture は canonical 文字列を手書きし `printf '%s' '<canonical>' | shasum -a 256` で digest を得る。ready の build fixture は期待 view を手で並べた JSON から `scripts/fixture-digest.py`（`json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False)` → UTF-8 → sha256。view のキーはすべて ASCII のスキーマ名なので Python のキー順と JCS が一致）で `canonicalWithoutDigest`・`viewDigest`・`finalByteLength` を計算する。source content の digest も同スクリプト（または `shasum`）で計算する。
- 共通フィールド: `"fixtureFormat": 1`, `"id"`, `"covers": string[]`（§7.5 の完了条件 ID）, `"operation"`。
- runner は全 build/validate fixture について追加で自動検査する: (a) 入力を `structuredClone` した値と実行後の入力が deep-equal（非変更）、(b) 同一入力で 2 回実行し結果が deep-equal、別 fixture を挟んで再実行しても同じ（呼び出し状態を保持しない）、(c) 戻り値が再帰的に `Object.isFrozen`。

### 7.2 形式

```jsonc
// fixtures/canonical/<id>.json
{ "fixtureFormat": 1, "id": "C01-key-order", "covers": ["determinism"], "operation": "canonical",
  "value": { ... }, "canonical": "<期待文字列>", "sha256": "<hex>", "utf8ByteLength": 123 }

// fixtures/utf8/<id>.json
{ "fixtureFormat": 1, "id": "U01-ja-emoji", "covers": ["utf8"], "operation": "utf8",
  "text": "あ😀", "utf8ByteLength": 7, "boundaries": [0, 3, 7] }   // 0..len の全 index のうち境界であるもの

// fixtures/build/<id>.json
{ "fixtureFormat": 1, "id": "B01-ready-basic", "covers": [...], "operation": "build",
  "input": { /* BuildMemoryViewInput */ },
  "expect": { "outcome": "result", "result": { /* MemoryView 全体 */ },
              "canonicalWithoutDigest": "...", "finalByteLength": 1234 }   // 後 2 つは ready のみ必須
  // または { "outcome": "error", "code": "UNKNOWN_KEY", "path": "$.snapshot" }
}

// fixtures/validate/<id>.json
{ "fixtureFormat": 1, "id": "V01-valid", "covers": [...], "operation": "validate",
  "view": { ... } | "viewFrom": { "fixture": "B01-ready-basic", "patch": [ /* RFC 6902 */ ] },
  "current": { ... } | "currentFrom": { "fixture": "B01-ready-basic", "patch": [ ... ] },
  "expect": { "outcome": "result", "result": { "schemaVersion": 1, "status": "invalid", "reasonCode": "..." } }
           | { "outcome": "error", "code": "...", "path": "..." } }
```

- `viewFrom` は参照 build fixture の `expect.result` を、`currentFrom` は `{schemaVersion, access, snapshot}` = 参照 build fixture の `input` から作る。`patch` は RFC 6902 の `add` / `remove` / `replace` だけ（JSON Pointer、RFC 6901）。runner に小さな実装を置く。他言語でも再現可能。
- error の `path` は `$` 起点、プロパティは `.name`、配列は `[n]`。

### 7.3 共通データ

ベース snapshot（B01、§12 の Eumenes 対応に寄せる）: principal `"local:owner"`、scopeKey `"conversation:c1"`、access.scopeKeys `["conversation:c1"]`、purpose `"dialogue.generate"`、policyRevision `"1"`、stateRevision `"7"`、maxBytes `1000000`。sources: 日本語本文 `"目的は来週までにM0を完成させる。😀"`（`conversation/message/m1`、representation `"text"`、revision `"sha256:<digest>"`、content あり）、ASCII 本文（`m2`）、content なし source（`m3`）。items（revision は `"1"` 等の数値文字列）: `continuity:g1`(goal, user_confirmed, range 付き)、`continuity:d1`(decision, user_edited)、`continuity:q1`(open_question)。実ユーザー会話は使わない。

### 7.4 ケース一覧

canonical / utf8

| id | 内容 |
|---|---|
| C01-key-order | ASCII キー順、ネスト object/array、空 `{}` `[]` |
| C02-key-code-unit | キー `"\uFF5E"` と `"😀"`（D83D）: コード単位順で 😀 が先（コードポイント順と逆） |
| C03-escapes | `"\"\\\b\f\n\r\t\u0001\u001f"`、U+2028/U+2029 は生のまま、`/` は escape しない |
| C04-ja-emoji | 日本語・絵文字・ZWJ 列（👨‍👩‍👧）の値。`utf8ByteLength` を検証 |
| C05-integers | 0、`-0`→`0`、`9007199254740991`、負数、true/false |
| U01-ja-emoji | `"あ😀"` 境界 [0,3,7] |
| U02-mixed | `"aé€😀"`（1/2/3/4 byte）全境界 |
| U03-zwj | `"👨‍👩‍👧"` コードポイント境界のみ（ZWJ 間は境界、サロゲート中間は非境界） |
| U04-empty | `""` 長さ 0、境界 [0] |

canonical の非整数・非安全整数・null・undefined の拒否は unit test（`src/canonical/test/json.test.ts`）で行う（内部 API のため fixture にしない）。

build（ready/disabled/blocked/overflow）

| id | 期待 | 主眼 |
|---|---|---|
| B01-ready-basic | ready | 3 種の kind、user_confirmed/user_edited、range、日本語・絵文字。`canonicalWithoutDigest` 直書き |
| B02-ready-order | ready | items を逆順入力、id `a:B`/`a:a`/`a:é`/`a:z`/`a:\uFF5E`/`a:😀` を含みコード単位順を確認。dependencies も逆順入力 |
| B03-ready-permuted | ready | B01 の items・sources・dependencies の入力順を入れ替え、`viewDigest` が B01 と同一 |
| B04-ready-inactive-excluded | ready | inactive item（依存は forgotten）を含むが除外され ready |
| B05-ready-empty | ready | complete・items/sources 空 → items `[]`, dependencies `[]` |
| B06-ready-range-to-end | ready | endByte = content の byte 長 |
| B07-ready-zwj-split | ready | ZWJ 列の途中（コードポイント境界）で切る range を許可 |
| B08-ready-content-no-range | ready | range なし・content あり（content digest 一致） |
| B10-disabled | disabled `MEMORY_DISABLED` | 正常入力で enabled=false |
| B11-disabled-over-blocked | disabled | enabled=false かつ principal 不一致・incomplete |
| B12-disabled-empty | disabled | enabled=false の空 snapshot（B05 と区別） |
| B20-blocked-principal | `PRINCIPAL_MISMATCH` | |
| B21-blocked-scope | `SCOPE_NOT_PERMITTED` | |
| B22-blocked-policy | `POLICY_REVISION_MISMATCH` | |
| B23-blocked-incomplete | `SNAPSHOT_INCOMPLETE` | items あり |
| B24-blocked-incomplete-empty | `SNAPSHOT_INCOMPLETE` | 空 + complete=false（空 ready にしない） |
| B25-blocked-multi-access | `PRINCIPAL_MISMATCH` | principal・policy・incomplete 同時 |
| B30-source-not-in-snapshot | `SOURCE_NOT_IN_SNAPSHOT` | |
| B31-source-not-permitted | `SOURCE_NOT_PERMITTED` | source の scopeKey が別 |
| B32-source-missing | `SOURCE_MISSING` | |
| B33-source-changed | `SOURCE_CHANGED` | |
| B34-source-forgotten | `SOURCE_FORGOTTEN` | |
| B35-source-revision | `SOURCE_REVISION_MISMATCH` | |
| B36-source-digest | `SOURCE_DIGEST_MISMATCH` | |
| B37-content-digest | `SOURCE_CONTENT_DIGEST_MISMATCH` | content と state.digest 不一致 |
| B38-range-no-content | `SOURCE_CONTENT_REQUIRED` | |
| B39-range-oob | `SOURCE_RANGE_OUT_OF_BOUNDS` | endByte = byte 長 + 1（UTF-16 長以内に収まる値を選び、code unit 判定の誤りを検出） |
| B40-range-mid-ja | `SOURCE_RANGE_NOT_CHAR_BOUNDARY` | 「あ」の 2 byte 目開始 |
| B41-range-mid-emoji | `SOURCE_RANGE_NOT_CHAR_BOUNDARY` | 😀 の +2 byte で終了 |
| B42-blocked-item-order | `SOURCE_FORGOTTEN` | `a:1` が digest 不一致、`a:0` が forgotten（入力は a:1 が先）→ id 順で a:0 |
| B43-blocked-dep-order | `SOURCE_MISSING` | 1 item 内で dependencies の入力順と正規化順が異なる 2 失敗 |
| B44-blocked-over-overflow | blocked | maxBytes=0 かつ source missing → blocked |
| B50-overflow-plus1 | overflow `BUDGET_EXCEEDED` | 日本語・絵文字本文、maxBytes = finalByteLength − 1 |
| B51-ready-exact | ready | 同入力で maxBytes = finalByteLength |
| B52-overflow-empty | overflow | 空 ready の maxBytes=0 |
| B53-overflow-not-codeunits | overflow | maxBytes を「JSON の UTF-16 長」以上かつ byte 長未満に設定 |

build（例外）

| id | code / path |
|---|---|
| E01-unknown-top | `UNKNOWN_KEY` `$` |
| E02-unknown-nested | `UNKNOWN_KEY` `$.snapshot.items[0].primarySource` |
| E03-proto-key | `UNKNOWN_KEY` `$.snapshot`（JSON の `"__proto__"` own key） |
| E04-schema-2 | `UNSUPPORTED_SCHEMA_VERSION` `$.schemaVersion`（未知キー併存でもこちら） |
| E05-schema-string | `INVALID_TYPE` `$.schemaVersion`（`"1"`） |
| E06-missing-key | `MISSING_KEY` `$.snapshot.complete` |
| E07-dup-item | `DUPLICATE_ITEM_ID` `$.snapshot.items[1]` |
| E08-dup-source | `DUPLICATE_SOURCE` `$.snapshot.sources[1]` |
| E09-dup-dependency | `DUPLICATE_DEPENDENCY` |
| E10-conflicting-dependency | `CONFLICTING_DEPENDENCY`（同キーで revision 違い） |
| E11-primary-not-in-deps | `PRIMARY_SOURCE_NOT_IN_DEPENDENCIES` |
| E12-range-empty | `INVALID_RANGE`（start = end） |
| E13-range-fraction | `INVALID_INTEGER`（1.5） |
| E14-maxbytes-negative | `INVALID_INTEGER` `$.maxBytes` |
| E15-maxbytes-unsafe | `INVALID_INTEGER`（9007199254740992） |
| E16-kind-enum | `INVALID_ENUM`（`"fact"`） |
| E17-origin-extracted | `INVALID_ENUM`（`"extracted"`、M0 で自動採用しない） |
| E18-digest-upper | `INVALID_DIGEST` |
| E19-empty-id | `EMPTY_STRING` |
| E20-lone-surrogate | `INVALID_STRING`（text に `"\ud800"`） |
| E21-dup-scope-keys | `DUPLICATE_SCOPE_KEY` |
| E22-id-no-namespace | `INVALID_ID_FORMAT` |
| E23-null-value | `INVALID_TYPE`（任意フィールドに null） |
| E24-error-before-disabled | enabled=false でも不正入力は例外（`UNKNOWN_KEY`） |
| E25-error-order | 2 箇所違反（items[0] に未知キー、maxBytes 負）→ 走査順で `$.snapshot.items[0]` |

validate

| id | 期待 | 作り方 |
|---|---|---|
| V01-valid | valid（viewDigest = B01） | viewFrom/currentFrom = B01 |
| V02-valid-inactive-added | valid | current に inactive item を追加（stateRevision 同じ） |
| V03-not-ready | `VIEW_NOT_READY` | view = B20 の結果 |
| V04-not-ready-first | `VIEW_NOT_READY` | blocked view + current の principal 不一致 |
| V05-digest-tampered-text | `VIEW_DIGEST_MISMATCH` | view の items[0].text を置換 |
| V06-digest-tampered-field | `VIEW_DIGEST_MISMATCH` | viewDigest 自体を別 hex に |
| V07-digest-over-state | `VIEW_DIGEST_MISMATCH` | 改ざん + current stateRevision 変更 |
| V10-current-incomplete | `SNAPSHOT_INCOMPLETE` | |
| V11-principal | `PRINCIPAL_MISMATCH` | current の access と snapshot を別 principal へ |
| V12-scope-not-permitted | `SCOPE_NOT_PERMITTED` | access.scopeKeys から外す |
| V13-scope-mismatch | `SCOPE_MISMATCH` | current の scopeKey を別へ（access も許可） |
| V14-purpose | `PURPOSE_MISMATCH` | |
| V15-policy | `POLICY_REVISION_MISMATCH` | access・snapshot 両方 p2 |
| V16-state-revision | `STATE_REVISION_MISMATCH` | |
| V20-item-missing | `ITEM_MISSING` | |
| V21-item-inactive | `ITEM_INACTIVE` | |
| V22-item-revision | `ITEM_REVISION_CHANGED` | |
| V23-item-revision-same-text | `ITEM_REVISION_CHANGED` | revision のみ変更 |
| V24-item-text | `ITEM_CONTENT_CHANGED` | revision 同じで text 変更 |
| V25-item-origin | `ITEM_CONTENT_CHANGED` | user_confirmed→user_edited |
| V26-item-set | `ITEM_SET_CHANGED` | active item 追加（stateRevision 同じ） |
| V30-source-missing | `SOURCE_MISSING` | |
| V31-source-changed | `SOURCE_CHANGED` | |
| V32-source-forgotten | `SOURCE_FORGOTTEN` | |
| V33-source-revision | `SOURCE_REVISION_MISMATCH` | |
| V34-source-digest | `SOURCE_DIGEST_MISMATCH` | |
| V35-source-scope | `SOURCE_NOT_PERMITTED` | |
| V36-source-removed | `SOURCE_NOT_IN_SNAPSHOT` | |
| V40-view-unknown-key | 例外 `UNKNOWN_KEY` `$` | |
| V41-view-schema-2 | 例外 `UNSUPPORTED_SCHEMA_VERSION` | |
| V42-current-invalid | 例外（current の items[0].kind 列挙外） | |

unit test だけで扱うもの（fixture にしない）
- 上限境界: `LIMITS` 全項目を表駆動で「ちょうど上限 = 成功、+1 = 例外」（日本語 3 byte 文字で埋めて byte 判定を確認。`maxItemTextBytes` は `"あ"×5461 + "a"` = 16384 が可、さらに `"a"` で不可）。`maxItems`/`maxSources`/`maxTotalSourceContentBytes` は生成データ。
- JS 固有: object literal の `{ __proto__: x }`（prototype 変更 → `INVALID_PROPERTY`）、getter、symbol キー、`Object.create(null)` は可、配列の穴、Proxy は対象外（§11 R4）。
- V8 `VIEW_REBUILD_MISMATCH`: `src/validation/test/validate.test.ts` で、正当な digest を付け直したが items の並びを入れ替えた view（V2 は通過、V5 は id で引くので通過、V7 通過）を渡し V8 を確認する。
- 入力の deep-freeze 済みでも動くこと、出力がどの入力オブジェクトとも参照を共有しないこと。

### 7.5 完了条件（plan §3）との対応

| 完了条件 | covers ID | fixture / test |
|---|---|---|
| 同じ snapshot・権限・予算で同じ選択・順序・digest | `determinism` | B01, B02, B03, C01–C05, runner の再実行検査 |
| goal/decision/open_question の由来と原文参照保持 | `kinds-origin` | B01, E17 |
| 原文欠落・変更・忘却、revision 変更で旧 view 利用不可 | `stale` | V20–V36, B30–B37 |
| principal/scope/policy 不一致 | `access` | B20–B25, V11–V15 |
| 必須項目の予算超過は overflow | `budget` | B50–B53, B44 |
| 日本語・絵文字、不正 UTF-8 範囲 | `utf8` | U01–U04, B39–B41, B06, B07, B50, B53 |
| Memory OFF / 空 snapshot の区別 | `disabled-empty` | B05, B10–B12, B52 |
| 不完全 snapshot は blocked | `incomplete` | B23, B24, V10 |
| 入力非変更・状態非保持 | `pure` | runner 自動検査（全 fixture） |
| 公開パッケージ利用 | `consumer` | `test/consumer/public-api.test.ts`（self-reference）、`tsconfig.compat.json` |
| 入力検証（契約 §2） | `schema` | E01–E25, V40–V42, limits unit test |

## 8. パッケージ設定・取り込み方式・verify

### 8.1 Eumenes からの取り込み方式（推奨を 1 つに決定）

| 案 | 内容 | 評価 |
|---|---|---|
| **A（推奨）** | Eumenes の `package.json` に `"eumenes-memory": "file:../eumenes_memory"`。本パッケージの `exports` は TS ソース `./src/index.ts` を直接指す | 名前付き import・`bun.lock` に依存が記録される・ビルド不要。Bun 1.4.2 で検証済み: `file:` のフォルダー依存は `node_modules/<name>/` 配下に**ファイル単位の symlink** を作り、既存ファイルの編集は即時反映、`tsc`（Bundler 解決）は依存先 `.ts` を利用側の compilerOptions で型検査する。新規ファイル追加時は Eumenes 側で `bun install` の再実行が必要 |
| B | Eumenes の tsconfig `paths` で `../eumenes_memory/src/index.ts` に alias | install 不要だが依存が package.json/lock に現れず、Bun と tsc の両方の paths 設定に依存。暗黙依存になる |
| C | bun workspace | 両リポジトリを含む共通 root が必要。隣接独立 checkout と両立しない。不採用 |
| D | dist をビルドして `file:` または `.tgz` | ビルド手順と stale な dist の管理が必要。配布を重視する段階（後続）で再検討 |
| E | 相対パス import（`../../../../eumenes_memory/src`） | 境界外参照で脆い。Eumenes の domain 構成に反する。不採用 |

A の帰結（本パッケージ側の制約）
- `src/` は**本パッケージの tsconfig と Eumenes の tsconfig の両方**で型エラーなしにする必要がある。`tsconfig.compat.json` で Eumenes と同じ compilerOptions による検査を verify に入れる（§8.2）。
- 相対 import は `.ts` 拡張子（Eumenes も `allowImportingTsExtensions`）。`.js` 拡張子や `NodeNext` 前提の書き方をしない。
- `src/` は `bun:*` を import しない（Eumenes の web/vite 側から誤って import されても壊れないよう、`node:crypto` 以外の組み込みも使わない）。
- 実行時依存ゼロのため、Eumenes の `bun install` で追加取得は発生しない（`minimumReleaseAge` の影響なし）。

### 8.2 package.json / tsconfig

```json
{
  "name": "eumenes-memory",
  "version": "0.1.0",
  "private": true,
  "license": "UNLICENSED",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": "./src/index.ts",
    "./package.json": "./package.json"
  },
  "scripts": {
    "lint": "oxlint --deny-warnings",
    "format": "oxfmt --write",
    "format:check": "oxfmt --check",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "verify": "bun scripts/verify.ts"
  },
  "devDependencies": {
    "@types/bun": "1.3.14",
    "@types/node": "25.9.3",
    "oxfmt": "0.71.0",
    "oxlint": "1.86.0",
    "typescript": "5.9.3"
  }
}
```
- `dependencies` を置かない。devDependencies は Eumenes と同じ完全固定版（すでに releaseAge を満たす版）。`bun.lock` を保存。
- `private: true`（registry 誤公開防止）。`main`/`module`/`files` は置かない。

`tsconfig.json`（本体）
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["ES2022"], "types": ["bun"],
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "allowImportingTsExtensions": true, "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true, "isolatedModules": true
  },
  "include": ["src", "test", "scripts"]
}
```
`tsconfig.compat.json`（Eumenes の `tsconfig.json` と同じ値。`vite/client` と `jsx` は Eumenes 側専用なので除外）
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["bun"],
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "allowImportingTsExtensions": true, "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src"],
  "exclude": ["src/**/test/**"]
}
```
Eumenes の tsconfig が変わったらこのファイルを追従させる（R6）。

### 8.3 `scripts/verify.ts`

`bun scripts/verify.ts` が次を順に `Bun.spawn` で実行する（自分自身や `bun run verify` を呼ばない）。失敗で非 0 終了し、失敗ステップ名を表示。レポートファイルは書かない。

1. `format`: `oxfmt --check`
2. `lint`: `oxlint --deny-warnings`
3. `typecheck`: `tsc --noEmit -p tsconfig.json`
4. `typecheck:eumenes-compat`: `tsc --noEmit -p tsconfig.compat.json`
5. `test`: `bun test`（`src/**/test`、`test/` の全テスト。public-api テストを含む）
6. `public-surface`: `test/consumer/` 配下の import を静的に走査し、許可は `"eumenes-memory"`、`"bun:test"`、`"../fixture-runner.ts"`、`node:` 組み込みのみ。`src/` を指す相対 import があれば失敗。あわせて `test/fixture-runner.ts` が `src/` を import していないことも検査

### 8.4 public API テスト（plan §3「公開パッケージの利用」）

`test/consumer/public-api.test.ts` は `import { ... } from "eumenes-memory"` と `import type { ... } from "eumenes-memory"` のみを使う。package の self-reference（`name` + `exports`）で解決され、Bun 実行と tsc の両方で動くことを検証済み（bun 1.4.2 / tsc 5.9.3、scratch で確認）。内容:
- build/validate fixture を公開 API で実行する。runner は src を import せず API を引数で受けるので、`import { runFixtureSuite } from "../fixture-runner.ts"` だけを相対 import の例外として許可する（canonical/utf8 fixture は内部 API のためここでは実行しない）。
- 型テスト: `status` で narrowing して `viewDigest` に到達、`// @ts-expect-error` で `kind: "fact"` の入力型エラー、ready 以外で `items` にアクセスできないこと。
- 実行テスト: 正常 build → `ready`、出力が frozen、`validateMemoryView` → `valid`、不正入力で `MemoryContractError` かつ `isMemoryContractError` true。

Eumenes の実環境での取り込み確認（`file:` 依存追加 → `bun install` → Eumenes の `tsc`）は M1 の作業。M0 では `tsconfig.compat.json` が代替。

## 9. 実装順序とチェックポイント

単一エージェントで順に実装する。各 CP で `bun run typecheck && bun test` が通ってから次へ。

1. **雛形**: package.json, tsconfig 2 つ, bunfig.toml, .oxlintrc.json, .oxfmtrc.json, .gitignore, 空の `src/index.ts`、`bun install`。CP: typecheck 成功、bun.lock 生成。
2. **canonical**: compare, utf8, sha256, json と unit test、`fixtures/canonical`・`fixtures/utf8`、`test/fixture-runner.ts`（canonical/utf8 部分）、`test/fixtures.test.ts`（内部 API を渡す）。CP: C01–C05, U01–U04 緑。
3. **contracts**: constants, types, reason-codes, errors, reader, parse-input と unit test（limits 境界含む）。CP: E01–E25 緑（runner は error 期待のとき parse/build の例外を確認）。
4. **view**: source-ref, access-check, dependency-check, compose, digest, freeze, build。`scripts/fixture-digest.py` で B01 の canonical/digest を独立計算して fixture へ。CP: B01–B53 緑、B03 の digest = B01。
5. **parse-view と validation**: parse-view, item-diff, validate と unit test（V8 含む）。CP: V01–V42 緑。
6. **公開面**: `src/index.ts`、`src/contracts/test/exports.test.ts`（export 一覧固定）、`test/consumer/public-api.test.ts`。CP: export 一覧一致、compat typecheck 成功。
7. **verify**: `scripts/verify.ts`、`bun run format` で整形。CP: `bun run verify` exit 0。
8. **文書**: README に Eumenes からの利用例（§12 の対応表を要約）、`spec/m0-validation.md`（実装済み / fixture 検証済み / ホスト結合未実施、公開 API、verify コマンドと終了状態、既知の制限）。

分担について: 本設計は単一エージェント実装を前提とする。plan §8 の A(view)/B(validation) は `checkAccess`/`checkDependencies`/`composeReadyBody` を共有し強く結合するため **don't split**。C(consumer) は小さいので分けない。

## 10. 契約の曖昧点・矛盾に対する決定

| # | 論点 | 決定 |
|---|---|---|
| D1 | contracts §3 の出力一覧に purpose がないが §4 は用途の保存を要求 | 全結果の header に `purpose`（= access.purpose）を持たせ、ready では viewDigest の対象に含める。契約側の補完 |
| D2 | SourceState が「SourceRef を含む」とあるが range は状態ではなく引用 | SourceState は出典キー + revision + digest + 状態（range なし）。range は item の SourceRef だけが持つ。出典キー = (namespace, kind, id, representation) |
| D3 | 「primarySource も依存に含める」の扱い | 入力で dependencies に完全一致の要素を必須とし、なければ例外。自動追加しない（入力の意味を黙って変えない） |
| D4 | 非 ready で principal 等をどこから取るか | principal・policyRevision・purpose は access、scopeKey・stateRevision は snapshot。要求者の視点で他 principal の値を返さない |
| D5 | 「正常な入力について」判定 | schema 検査は enabled より先。enabled=false でも不正入力は例外 |
| D6 | 本文に依存する range/digest 不整合の分類 | 内容が分かって初めて判定できるもの（3h–3k）は blocked。内容に依存しない構造違反（start ≥ end、負数、非整数）は例外 |
| D7 | 空 range | 不許可（`INVALID_RANGE`）。引用は 1 byte 以上 |
| D8 | 「文字境界」の定義 | UTF-8 コードポイント境界。書記素クラスタは考慮しない |
| D9 | 複数失敗時の reasonCode | §2 の番号順で最初の一つだけ。失敗箇所の item/source ID は返さない（原文・識別子の漏えい回避。診断性の不足は R3） |
| D10 | coverage の形 | `{ complete: true, omitted: [] }` 固定。将来の任意 evidence 省略は omitted に入れる |
| D11 | 「参照の完全な dependencies」 | top level は range を除いた出典単位の重複排除一覧、range 付きの完全な参照は各 item の dependencies |
| D12 | view item の status | `"active"` を明示的に含める |
| D13 | validate の current 形 | `{ schemaVersion: 1, access, snapshot }`。結果も schemaVersion を持つ |
| D14 | stateRevision と item 差分の優先 | V4e（stateRevision）を item 差分より先に判定。無関係な変更でも安全側に invalid（契約 §4 許容） |
| D15 | 同一 stateRevision での active item 追加 | `ITEM_SET_CHANGED` で invalid（ホスト不整合を安全側に）。inactive の追加は valid |
| D16 | 壊れた view | 構造違反は例外、構造は正しいが ready でないものは `VIEW_NOT_READY` |
| D17 | 「JSON の UTF-8 bytes」の JSON 表現 | 正規化 JSON（§4.1）。`JSON.stringify` と byte 長は同じ |
| D18 | content がある場合の digest 検査 | range の有無に関係なく active item が参照する source は必ず検査 |
| D19 | 参照されない source / inactive item | schema・重複のみ検査。依存状態は検査しない |
| D20 | 文字列の妥当性 | 全文字列で lone surrogate を拒否（UTF-8 に変換できないため）。識別子は制御文字も拒否 |
| D21 | reasonCode 名 | disabled = `MEMORY_DISABLED`、overflow = `BUDGET_EXCEEDED` |
| D22 | digest 形式 | 接頭辞なしの小文字 hex 64 文字（契約 §1 と同じ） |
| D23 | license / 公開 | `private: true`、`license: "UNLICENSED"`。LICENSE ファイルは作らない（Q1） |
| D24 | 配布・取り込み（plan §7 の tgz 方式） | M0 は `file:../eumenes_memory` + TS ソース export（§8.1 案 A）。tgz・manifest・vendor は後続 |
| D25 | 実行時バリデータに zod を使うか | **使わない（手書き、依存ゼロ）**。理由: (1) 例外の code・path・同時違反時の優先順位を fixture で固定する必要があり、zod の issue 収集順・コード体系・メッセージ（`unrecognized_keys` は入力キー名を含む）に挙動を委ねると zod の更新で契約が揺れる。(2) own-property のみ参照・accessor 拒否・prototype 検査・`schemaVersion` 先行判定・UTF-8 byte 長・lone surrogate・重複/相反検査はいずれも zod の標準機能外で、結局 `superRefine`/`preprocess` の手書きになる。(3) 案 A では依存先 `.ts` の realpath から解決されるため、zod を依存にすると `eumenes_memory/node_modules/zod` と Eumenes の zod の 2 コピーになり、zod 型を公開面に出すと型同一性が崩れる（未検証の推測を含む）。(4) 将来の Rust/Wasm 実装とのクロス検証で検証規則を言語非依存に保てる。Eumenes 側は HTTP/永続層の検証に引き続き zod を使い、アダプターは型付きの値を渡す |
| D26 | Eumenes の数値 revision | 契約どおり不透明な文字列。数値→文字列化はアダプターの責任（`String(n)`、§12）。コアは数値を受け付けない（`INVALID_TYPE`） |
| D27 | 本パッケージの SHA-256 | `node:crypto` の `createHash`（Eumenes の continuity と同じ実装系。`sha256(message.text)` と同値になる） |

## 11. リスクと未確定事項

- **R1（一部未検証）**: §3.1 の上限は Eumenes の contracts の定数（本文 2000、active 50、id 200、conversationId 120）に基づくが、会話 message 本文長の上限は見つからなかった。1 MiB を超える message があると `STRING_TOO_LONG` の例外になる。M1 で実データを測る。
- **R2**: 案 A では Eumenes の `node_modules` に作られる symlink がファイル単位のため、本パッケージに新規ファイルを追加したら Eumenes で `bun install` が必要（既存ファイルの編集は即時反映）。M1 手順に記載する。
- **R3**: reasonCode が一つだけなので、ホストはどの item が失効したかを知れない。M1 で必要なら非機密の index 等を追加する契約変更を親へ戻す。
- **R4**: Proxy は own-property 検査をすり抜けうる（trap が任意の値を返す）。M0 は JSON 由来・アダプター生成のデータを想定し、Proxy 検出はしない。README の既知の制限に記載。
- **R5**: 案 A は隣接 checkout（`../eumenes_memory`）を前提にする。plan §7 の「両 checkout の HEAD に暗黙依存する恒久運用にしない」は後続の配布方式（D）で解消する。Eumenes の `scripts/verify.ts` の source revision hash は `node_modules` を除外するため、本パッケージの変更を検知しない。また Eumenes の `spec/memory-system-incremental-adoption-concept.md` E1 は `file:vendor/...tgz` を前提としており、本決定と食い違う。concept 側の更新は M1 担当（親担当判断）。
- **R6**: Eumenes の `tsc` は本パッケージの `src/` を Eumenes の設定で型検査する。`tsconfig.compat.json` が Eumenes の設定とずれると M1 で初めて型エラーが出る。
- **R7（未検証）**: Bun が symlink 先の realpath でモジュール解決するか（zod 二重化の推測、D25(3)）は確認していない。依存ゼロなので M0 の動作には影響しない。
- **Q1**: ライセンス種別は未決定（親担当の判断事項）。
- **Q2**: Git 初期化は親担当。
- **Q3**: `purpose` を列挙にするか自由トークンにするか。M0 は自由トークン（識別子規則）とし、Eumenes の値は §12 の仮案。

## 12. Eumenes アダプターへの対応表（M1 参考、M0 では実装しない）

M1 で `api/domains/memory`（concept 文書の配置候補）に置くアダプターが Continuity / conversation の読み出しから入力を作る想定。M0 の fixture B01 はこの形に寄せる。

| 本契約 | Eumenes の値（仮案） |
|---|---|
| access.principal / snapshot.principal | ローカル単一ユーザーの固定値（例 `"local:owner"`）。認証主体の決定は Eumenes の責任 |
| snapshot.scopeKey / access.scopeKeys | `"conversation:" + conversationId` |
| access.purpose | `"dialogue.generate"`（dialogue の job kind と同名） |
| policyRevision | Eumenes の設定版（未存在なら固定 `"1"`） |
| snapshot.stateRevision | `String(ContinuitySnapshot.stateRevision)` |
| snapshot.complete | 一つの read transaction で読めたら true |
| item.id | `"continuity:" + bookmark.id` |
| item.revision | `String(bookmark.revision)` |
| item.kind / status / origin / text | bookmark の同名フィールドをそのまま |
| SourceRef / SourceState の (namespace, kind, id, representation) | `("conversation", "message", sourceMessageId, "text")` |
| source revision | message に版がないため `"sha256:" + sha256(message.text)`（contracts §1「ホストが内容 digest に基づく安定した版を発行」） |
| source digest | `bookmark.sourceDigest`（= `sha256(message.text)`、同一規則） |
| source status | `ok → available`、`missing → missing`、`changed → changed`（forgotten は未使用） |
| source content | message.text を渡す（range はないが content digest 検査 3h が効く） |
| range | M1 では付けない |
| item.dependencies | `[primarySource]` |

注意: Eumenes の `getSnapshot` は active bookmark のみを返し、message 本文を返さない。M1 では本文込みの transaction 内読み出しを continuity/conversation の公開操作として追加する必要がある（concept 文書 E1 と同じ指摘）。


