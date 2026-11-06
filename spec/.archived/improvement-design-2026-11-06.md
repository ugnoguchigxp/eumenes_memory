# Eumenes Memory 改善設計（2026-11-06 評価への対応）

作成日: 2026年11月6日。基準コミット: `5504945`。根拠は同日の多角評価（総合 71/100）。CI（`.github/workflows/`）は本書の対象外。

本書は実装者が再調査せずに着手できることを目的とする。各ワークストリーム（WS）に対象ファイル、契約、受け入れ条件、対象テストを書く。コードで確認できなかった点は「要確認」と明記する。

## 1. 目的と非目的

### 目的
1. 複数 principal を同じ DB に置いても、忘却・墓標・ID が他の principal に作用しないようにする（評価 M1、L2）。
2. 忘却後に第三者の識別子が論理的に残らないようにする（M2）。
3. `applyForget` が呼び出し元の権限を検査するようにする（M3）。ジャーナルの性質を「鍵なしの整合性検査」として正しく記述する（L1）。
4. `MemoryDb.inTransaction` を必須にし、transaction 外の書込みをどのドライバでも拒否する。
5. 低重要度の欠陥 L3・L4 を直す。
6. 保守性（巨大 repository の分割）、統合者向けドキュメント、検証ツール、LLM 評価、リポジトリ衛生、DX を改善する。

### 非目的
- CI の変更（利用者指定で除外）。
- npm 公開、署名、provenance、SBOM。配布は tgz のまま。
- World / Consolidation の実装。`ExternalDependent` と変更フィードの契約は現状維持（撤去の判断材料がない）。
- 物理消去の保証（SQLite の空きページ・WAL・バックアップ）。既知の制限のまま。
- retention API（`useRetainedRecord` の boolean、`evictRetainedRecords` の `{deleted, blocked}`）の戻り型の統一。本書ではエラー処理ガイドでの明文化に留める。
- 契約版（`CONTRACT_VERSIONS`）の引き上げと、版ごとの分岐ロジック（D2）。
- Eumenes リポジトリのコード変更。Eumenes 側で必要な追従は §9 に要件として書き、Eumenes で別途実施する（D4）。
- git 履歴の書き換え（D4）。

## 2. 決定事項（2026-11-06 利用者確認）

| ID | 論点 | 決定 |
|---|---|---|
| D1 | 複数 principal に対応するか | **対応する**（WS1）。墓標を principal ごとにする |
| D2 | `applyForget` の入力変更に伴う契約版 | **上げない**。`CONTRACT_VERSIONS` は全 family 1 のまま。版ごとの分岐ロジックは作らない。`access` は必須項目として追加し、欠けた入力は既存の `MISSING_KEY` で失敗する |
| D3 | DB 復元後の state item ID 衝突（L2）と、復元で記憶が失われること | **復元の設計として §8 で扱う**。バックアップ後の記憶が失われることは避けられないので、失う幅を縮め（Eumenes 側）、失った範囲で矛盾が起きないことを本体が保証する。ID の衝突は「自分の墓標とぶつかったら seq を取り直す」で防ぐ（WS1 手順 4）。スキーマ変更と ID 式の変更はしない |
| D4 | Eumenes との関係、公開リポジトリの履歴 | **Eumenes を考慮する**。変更ごとに Eumenes への影響を確認し、追従事項と移行手順を §9 と CHANGELOG に書く。リポジトリは現在のツリーからの除去のみで、履歴は書き換えない |
| D5 | `SQLITE_BUSY` を型付きエラーにするか | **しない**（変更を増やさない）。並行性の試験では、例外が届くことと状態が壊れないことだけを確認する |

## 3. 共有契約（Phase 1 着手前に確定する）

### 3.1 DB スキーマ: migration 0009（墓標の principal 分離）
新ファイル `src/infrastructure/sqlite/migrations/0009-principal-tombstone.ts`。手順は 0007 と同じで、trigger を先に削除し、新表の作成 → 複製 → 旧表の削除 → 改名 → 索引と trigger の再作成を行う。0008 と同様、infrastructure に置く。

```sql
DROP TRIGGER memory_record_no_resurrection;
DROP TRIGGER memory_record_body_no_resurrection;
DROP TRIGGER memory_record_revision_no_resurrection;
DROP TRIGGER memory_state_item_no_resurrection;

CREATE TABLE memory_tombstone_v9 (
	target_type TEXT NOT NULL
		CHECK (target_type IN ('record', 'source', 'state_item', 'candidate', 'extraction_run', 'external')),
	target_id TEXT NOT NULL,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	forget_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	journal_seq INTEGER NOT NULL,
	PRIMARY KEY (principal, target_type, target_id)
);
INSERT INTO memory_tombstone_v9
	SELECT target_type, target_id, principal, scope_key, forget_id, seq, journal_seq FROM memory_tombstone;
DROP TABLE memory_tombstone;
ALTER TABLE memory_tombstone_v9 RENAME TO memory_tombstone;
CREATE INDEX memory_tombstone_by_forget ON memory_tombstone (forget_id);
CREATE INDEX memory_tombstone_by_target ON memory_tombstone (target_type, target_id);

-- record_id は principal を含むハッシュなので、records の 3 trigger は条件を変えずに再作成する。
-- state_item は principal を条件に加える。
CREATE TRIGGER memory_state_item_no_resurrection
BEFORE INSERT ON memory_state_item
WHEN EXISTS (
	SELECT 1 FROM memory_tombstone
	WHERE principal = NEW.principal AND target_type = 'state_item' AND target_id = NEW.item_id
)
BEGIN
	SELECT RAISE(ABORT, 'memory_tombstoned');
END;
```

- 旧 PK `(target_type, target_id)` のほうが厳しいので、複製で衝突は起きない。
- `MEMORY_DB_SCHEMA_VERSION` は migration の本数から 9 になる。0001〜0008 の本文は変更しない。
- 0006 の `memory_retention_forget` は墓標を参照しないので変更しない。

### 3.2 関数シグネチャ
```ts
// src/infrastructure/sqlite/tombstone.ts
export function isTombstoned(
	db: MemoryDb,
	principal: string,
	targetType: TombstoneTargetType,
	targetId: string,
): boolean;
```
`stateItemId`（`src/domains/state/service/ids.ts`）は変更しない。

### 3.3 公開契約の変更
`CONTRACT_VERSIONS` は変更しない（D2）。

```ts
// src/domains/lifecycle/contracts/index.ts
export interface ApplyForgetInput {
	readonly contractVersion: ContractVersion; // 1 のまま
	readonly access: AccessContext; // 追加（必須）
	readonly entry: ForgetJournalEntry;
	readonly clock: HostClock;
}

// src/infrastructure/sqlite/db.ts
export interface MemoryDb {
	exec(sql: string): void;
	query(sql: string): MemoryStatement;
	/** 現在 transaction 内か。書込み系の公開操作は true 以外を NOT_IN_TRANSACTION で拒否する。 */
	readonly inTransaction: boolean; // optional を廃止
}

// src/infrastructure/sqlite/errors.ts の STORE_ERROR_CODES に追加
//   "SCOPE_NOT_PERMITTED"  … applyForget の access 不一致（WS2）
```
`RECORD_RANGE_REASON_CODES` には追加しない。L3 は既存の `SOURCE_RANGE_OUT_OF_BOUNDS` を返す（WS5）。Eumenes の World は同じ条件を自前で `SOURCE_RANGE_OUT_OF_BOUNDS` として扱っている（`eumenes/api/domains/world/service/source-adapter.ts:214-222`）。新しいコードを足すと World の型（`SourceRangeReasonCode`）が壊れる。

## 4. ワークストリーム

### Phase 1: 正しさと安全性

#### WS1 墓標と ID の principal 分離（M1、L2）。分割しない
- **対象**
  - `src/infrastructure/sqlite/migrations/0009-principal-tombstone.ts`（新規）
  - `src/infrastructure/sqlite/tombstone.ts`
  - `src/domains/lifecycle/repository/index.ts`
    - `resolveForgetSet` 内の墓標の NOT EXISTS（:365）に `t.principal = o.principal` を加える。
    - `hasForeignTarget` / `applyEntry` / `sourceIsTombstoned` / `registerExternalDependents`（:1102, :1127）の `isTombstoned` 呼び出しに principal を渡す。
    - `insertTombstone` の `ON CONFLICT DO NOTHING` は新しい PK でそのまま動く。
  - `src/domains/state/repository/index.ts`
    - `NO_TOMBSTONE`（:106）に principal の一致条件を加える。
    - `isTombstoned` の呼び出し（:279, :665, :669）に principal を渡す。
  - `src/domains/records/repository/index.ts`（:159, :229-230）
  - `src/domains/state/repository/index.ts` の `assertUserState`（:711。ID を決める :751 より前）。手順 4 で再現した場合のみ
- **作業**
  1. 最初に再現試験を 2 本書き、変更前に失敗することを確認する。
     - (a) principal B が共有の SourceKey X を `host_source` として忘れたあと、principal A が X を引用する `assertUserState` を行う → 現状は `SOURCE_TOMBSTONED`。期待は成功。
     - (b) B が A の将来の item ID `state:<sha256([A, scope, s])>` を事前に忘れる → 現状は A の作成が `TOMBSTONED`。期待は成功。さらに、A がその item を後で忘れたとき、A の墓標が書かれること。
  2. `isTombstoned` に principal 引数を加える。型エラーを手掛かりに全呼び出し元を直す。
  3. 生 SQL の `memory_tombstone` 参照は全件見直す（`grep -rn memory_tombstone src`。test/ は除く）。reconcile の全体検査（:858「墓標が 1 行でもあるか」、:869 `MAX(journal_seq)`）は principal 横断のままでよい。
  4. **L2（D3）**: まず再現試験を書く。
     - 起きうる状況: state item の ID は `[principal, scopeKey, 作成した操作の seq]` のハッシュである。DB をバックアップから戻すと seq のカウンタも巻き戻る。巻き戻った期間に作って忘却した item（reconcile で墓標だけが戻る）と、復元後に同じ scope・同じ seq で作る item が同じ ID になり、新しい item の保存が `TOMBSTONED` で失敗する。
     - 試験の手順: スナップショットを取る → item を seq s で作成 → 忘却してジャーナルに記録 → DB をスナップショットに戻す → `reconcileForgetJournal` → 同じ scope で item を作成し、seq s が割り当てられることを確かめる → 作成が成功することを期待する。
     - 修正: `assertUserState` で ID を決める前（書込みより前）に、`isTombstoned(db, principal, "state_item", stateItemId(principal, scopeKey, seq))` が真である間は `seq = issueSeq(db)` で取り直す。
       - 復元後の DB に残っている item の seq は、どれも復元時点のカウンタ以下なので、衝突の相手は墓標だけである。
       - 失敗時と同様に seq の欠番が増えるだけで、ID の式とスキーマは変わらない。
     - 再現しなかった場合（別の経路で既に防がれている場合）は、修正せず、防いでいる箇所をこの節に追記する。
     - 復元全体の設計は §8。
- **互換性**
  - 既存の DB は 0009 の適用だけで移行できる。既存の墓標は自分の principal にだけ効く形に変わる（従来より狭くなる方向）。
  - ID の式は変わらない。
- **受け入れ条件**
  - 再現試験 (a)(b)（L2 を直した場合はその試験も）が変更前に失敗し、変更後に通る。
  - 版 8 の DB に 0009 を適用したあとも、忘却・reconcile・ExternalDependent の登録が従来どおり通る。`remove-extraction-migration.test.ts` に倣った版 8 → 9 の移行試験を追加する。
  - 既存の `test/scenario/forget-property.test.ts` が無変更で通る。
- **対象テスト**: `bun test src/domains/lifecycle src/domains/state src/infrastructure/sqlite test/scenario/forget*.test.ts`

#### WS2 `applyForget` の権限検査とジャーナルの記述（M3、L1）。WS1 の後に行う（同じファイル）
- **対象**
  - `src/domains/lifecycle/contracts/index.ts`（§3.3）
  - `src/domains/lifecycle/service/parse.ts` の `parseApplyForgetInput`（:201）。`checkKeys` に `access` を加え、`parsePlanForgetInput` が使っている access の reader を再利用する。
  - `src/domains/lifecycle/repository/index.ts` の `applyForget`（:823）
  - `applyForget` の呼び出し元に `access` を追加する: `examples/quality/benchmark.ts:87`、`examples/standalone/host.ts:314`、`test/runners/records-support.ts:115`、`test/runners/fake-eumenes-host.ts:351`、`scripts/package-consumer.mjs`
- **作業**
  1. `applyForget` では、parse の直後で `enterWrite` より前（seq を消費しない位置）に検査する。
     - 検査内容: `entry.principal === access.principal` であり、`entry.targets` のすべての `scopeKey` が `access.scopeKeys` に含まれること。
     - 満たさなければ `MemoryStoreError("SCOPE_NOT_PERMITTED")` を投げる。
  2. `reconcileForgetJournal` は起動時に実行されるホスト信頼の操作なので、access を取らない。JSDoc に「ジャーナルはホストが信頼できる保存先に置くこと。中身の真正性は検証しない」と明記する。
  3. 用語の修正（L1）。`grep -rn '改ざん' src docs README.md` の該当箇所を「鍵なしハッシュ鎖による整合性検査（偶発的な破損・切り詰め・食い違いを検出する。悪意ある書換えの防止はホストの責任）」に揃える。
- **受け入れ条件**
  - 他の principal、または許可外の scope を含む entry の `applyForget` が `SCOPE_NOT_PERMITTED` を投げ、DB と seq が不変であること。
  - 正規の plan → apply は通ること。
  - `access` を欠いた入力が `MISSING_KEY` の `MemoryContractError` になること。
- **対象テスト**: `bun test src/domains/lifecycle test/scenario/forget.test.ts test/consumer`

#### WS3 忘却時の `subject` 除去（M2）。WS1 の後に行う（同じファイル）
- **対象**: `src/domains/state/repository/index.ts` の `scrubStateItem`（:1001-1048）
- **作業**
  - UPDATE に `subject = CASE WHEN subject LIKE 'other:%' THEN 'other:' ELSE subject END` を加える。
    - `'other:'` は既存の CHECK（`subject = 'self' OR subject LIKE 'other:%'`、`kind = 'other_person_note'` ⇔ `subject LIKE 'other:%'`）を満たすので、migration は不要。
    - `self` は識別子ではないので残す。`kind` は CHECK の都合で残す。
  - 自由文字列を持つ列がほかに残っていないか確認する。対象は `memory_state_event`、`memory_change`、`memory_dependency` の列定義。残っていれば同じ UPDATE で消す。
  - 既存の忘却済み行は、その行を含む forget を再適用したときに消える（scrub は冪等）。過去分を一括で消す migration は作らない（要判断なら D 表に追加）。
- **受け入れ条件**: `other:alice@example.com` の item を忘却したあと、`SELECT subject FROM memory_state_item WHERE item_id = ?` が `'other:'` を返す。DB の全テキスト列を走査する試験で、元の識別子が見つからない。
- **対象テスト**: `bun test src/domains/state test/scenario/forget.test.ts`

#### WS4 `inTransaction` の必須化。独立
- **対象**
  - `src/infrastructure/sqlite/db.ts`（§3.3。`assertWritable` を `if (db.inTransaction !== true) throw new MemoryStoreError("NOT_IN_TRANSACTION")` にする）
  - `src/infrastructure/sqlite/test/db.test.ts:42`。「省略時は検査を飛ばす」試験を「省略時・undefined は拒否」に反転する。
  - `scripts/package-consumer.mjs:28-49`。手動フラグをやめ、Node では `native.isTransaction`、Bun では `native.inTransaction` を返す。
  - `docs/host-guide.md:34` の Node アダプター例
- **要確認**: `node:sqlite` の `DatabaseSync#isTransaction` がどの版から使えるか。CI で使っている Node 24 で使えることを確認する。使えなければ、アダプター側で BEGIN / COMMIT を追跡する例を載せる。
- **受け入れ条件**: `inTransaction` を持たない MemoryDb への書込み操作がすべて `NOT_IN_TRANSACTION` になる。`bun run verify:package` の Node consumer が通る。
- **対象テスト**: `bun test src/infrastructure/sqlite test/consumer`、`bun run verify:package`

#### WS5 低重要度の欠陥（L3、L4）。独立
- **L3** `src/domains/records/service/range.ts` の `sliceUtf8Range`（:25）
  - 先頭に `if (range.startByte >= range.endByte) return { status: "invalid_range", reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS" }` を置く（新しいコードは足さない。§3.3）。
  - JSDoc の判定順を更新する。
- **L4** `src/domains/records/repository/retention.ts`
  - `db.query` の直接呼び出し 5 箇所を `guarded` で包む。
  - `useRetainedRecord` は時計が戻っても期限を縮めないよう、`idle_expires_at_ms = max(現在値, atMs + idle_ttl_ms)` にする。
  - 失敗時にも seq を消費することは仕様として JSDoc に明記する（reconcile の `inconsistent` と同じ扱い）。
- **受け入れ条件**
  - `{5,3}` と `{3,3}` が `SOURCE_RANGE_OUT_OF_BOUNDS` になる。
  - retention で発生した `SQLITE_READONLY` が `READONLY_CONNECTION` に変換される。
  - 時計を戻して `useRetainedRecord` を呼んでも期限が短くならない。
- **対象テスト**: `bun test src/domains/records test/consumer/retention.test.ts`

### Phase 2: 保守性

#### WS6 エラー処理ガイドと reasonCode 一覧
- **対象**: `docs/host-guide.md` に「エラー処理」節（`#errors`）を新設する。`test/docs.test.ts` に検査を追加する。
- **内容**
  - 公開関数ごとの表（関数 / 正常時の戻り値 / `status`・`reasonCode` の値 / 投げる `MemoryContractError` の code / 投げる `MemoryStoreError` の code / ホストの推奨対応）。
  - ホストの推奨対応の分類: 入力修正、起動手順の見直し（`SCHEMA_*`）、fail closed（`JOURNAL_*`）。SQLite の `SQLITE_BUSY` などは変換されずに生の例外として届くので、再試行はホストが判断する。
  - `AccessContext` の 4 項目の意味と、scope の可視性規則。
  - `host_source` の忘却が Record の origin（namespace / kind / id）には届かないこと、つまり同じ origin で再 capture できること。
  - 信頼の前提:
    - `reconcileForgetJournal` はホストを信頼する操作である。
    - ジャーナルは鍵なしの整合性検査である。
    - State の memory-record 出典は、ホストが渡した本文と digest を信じる。
- **受け入れ条件**: `STORE_ERROR_CODES`、契約エラーの code の一覧、各 family の `*_REASON_CODES` の全要素が `#errors` 節に現れることを `test/docs.test.ts` で機械的に検査する。

#### WS7 巨大 repository の分割。Phase 1 の完了後に行う（同じファイル）。挙動は変えない
- `src/domains/lifecycle/repository/index.ts`（1218 行）を同じディレクトリの次のファイルに分け、`index.ts` は再 export だけにする。
  - `closure.ts`（`collectClosure`、`queryIds`、`resolveForgetSet`、`hasForeignTarget`、`targetOf`）
  - `plan.ts`
  - `apply.ts`（`insertTombstone`、`insertPendingExternal`、`applyEntry`、`applyForget`）
  - `reconcile.ts`
  - `receipt.ts`（`buildReceipt`、`forgetVisibility`、`getForgetReceipt`、`recordExternalDeletion`）
  - `external.ts`（register / unregister）
- `applyEntry`（約 185 行）は、検証・record の除去・出典の墓標・派生ノードの除去・忘却の記録という段階ごとの内部関数に分ける。
- `src/domains/state/repository/index.ts`（1085 行）は `write.ts` / `read.ts` / `scrub.ts` に分ける。ローカルの `run` / `selectFirst` / `selectAll`（:451, :980, :985）は `src/infrastructure/sqlite/db.ts` の共通部品に寄せる。`guarded` で包むかどうかを含めて挙動を揃える。
- **受け入れ条件**
  - 既存テストが import の修正以外は無変更で通る。
  - `bun scripts/boundaries.ts` が通る。
  - 公開 export が不変（`src/contracts/test/exports.test.ts`）。
  - 1 ファイル 450 行以下、1 関数 80 行以下（SQL リテラルを除く）を目安とする。
- **対象テスト**: `bun run verify -- --domain lifecycle`、`bun run verify -- --domain state`

#### WS8 スキーマ検査の呼び出しごとの費用。計測して判断する
- 公開操作のたびに `assertMemorySchema` が `memory_schema_info` を読む（`session.ts` の `enterRead` / `enterWrite`）。
- `examples/quality/benchmark.ts` か新しいスクリプトで、`listState` 1 万回の所要時間を、検査ありと検査なし（試験用に差し替え）で比べる。
- 差が 10% を超える場合に限り、`WeakMap<MemoryDb, number>` で接続ごとに検査済みの版を記憶する。ホストが同じ接続で migration を追加する場合に備え、無効化の関数を公開する。10% 以下なら計測結果を本節に記録して閉じる。

### Phase 3: ドキュメント

#### WS9 統合者向けドキュメントの整備。Phase 1・2 の完了後
- **配布物から辿れない参照の解消**
  - 配布物（`package.json` の `files`）と `dist/*.d.ts` に、同梱されないパスへの参照が残っている。
    - README の `src/infrastructure/sqlite/README.md`、`test/runners/fake-eumenes-host.ts`、`verification-reports/memory-check/`、`src/infrastructure/sqlite/test/...`
    - `docs/quality-validation.md` の `verification-reports/quality-80/...`
    - JSDoc の `spec/...`、`§2.2`、`src/infrastructure/sqlite/README.md`、`src/reducer.rs`
  - 公開 JSDoc の参照は `docs/host-guide.md#...` に置き換える。開発者向けの参照は「ソース checkout のみ」と明示する。
  - README の公開面表で、リンク文言（`src/infrastructure/sqlite/README.md`）とリンク先（`docs/host-guide.md#startup`）が食い違っている箇所を直す。
- **生きた文書から過去の経緯を除く**
  - マイルストーン用語（`M0`、`S0`、`S6` など。`src/contracts/external.ts:28`、`records/contracts/index.ts:19,54`、`migrations/README.md:24` ほか）を消す。
  - migrations README の「同ファイルに追記」「採用前は 1 本に統合」は、append-only の規則と矛盾して見えるので書き直す。
- **本書による利用者向けの変更を host-guide の該当節に反映する**: `applyForget` の `access`、`inTransaction` の必須化、schema 9、墓標が principal ごとになったこと、`SCOPE_NOT_PERMITTED` の追加、`sliceUtf8Range` が空・逆転の範囲を拒否すること、復元の手順と保証（§8）。
- **CHANGELOG.md を新設し、`files` に含める**: 上記の変更と、Eumenes の移行手順（§9 の表）を版ごとに書く。
- **README の「17項目」を確認する**: `examples/standalone/checks.ts` の実数と照合し、違えば直す。数え方が曖昧なら件数を書かない。
- **README の書き直し**
  - 「最初の 5 分」（`bun install` → `bun run verify` → `bun run memory` の例）を追加する。
  - 公開面の表は、1 セルに詰め込まず family ごとの箇条書きにする。
- **受け入れ条件**: `test/docs.test.ts` を拡張する。
  - `files` に含まれる Markdown と `dist/**/*.d.ts` の相対リンク・パス参照が、配布物の中で解決すること。
  - マイルストーン用語の正規表現が `src/` の非テストファイルに現れないこと。

### Phase 4: テストと検証ツール

#### WS10 不足しているテスト。独立（新規テストファイルが中心）
- **並行性**: 同じファイルを開く 2 つの `bun:sqlite` 接続（WAL）。片方が書込み transaction を保持している間に、もう片方で書込み操作を行う。
  - 例外（SQLite の BUSY）が届くこと、ホストが ROLLBACK したあと両方の接続から見た状態が壊れていないことを確かめる。
  - エラーの変換は追加しない（D5）。
- **途中失敗の巻き戻し**: N 回目の `query().run()` で例外を投げる MemoryDb ラッパーを作る。`applyForget` / `assertUserState` / `retainRecord` の途中で失敗させてホストが ROLLBACK したあと、次を確かめる。
  - DB の内容（全表のダンプ）が操作前と一致すること。
  - ジャーナルの head が不変であること。
  - 同じ entry を再適用すると成功すること。
- **property の seed**: `test/scenario/forget-property.test.ts` の seed を `MEMORY_PROPERTY_SEED` 環境変数で上書きできるようにし、失敗時に seed を出力する。既定値は現行の固定 seed のまま（再現性を保つ）。
- **任意**: 旧版 DB のバイナリ fixture。現行の「migration を順に適用して旧 DB を作る」方式で十分なら行わない。
- **対象テスト**: 新規ファイル単体、`MEMORY_PROPERTY_SEED=123 bun test test/scenario/forget-property.test.ts`

#### WS11 検証ツールの実態と名前を揃える。独立
- `scripts/public-surface.ts` は import 規則の検査なので、`scripts/import-rules.ts`、verify の段階名 `import-rules` に改名する。
  - 参照箇所: `scripts/verify.ts`、`test/public-surface.test.ts`、`test/tooling.test.ts`。
- `scripts/verify-package.ts` に 2 つの検査を追加する。
  - 展開した配布物の `dist/index.d.ts` と `dist/sqlite.d.ts` の export 名を `EXPECTED_EXPORTS` と照合する。
  - 展開先に TypeScript の consumer（`import type` と値の import）を置き、`tsc --noEmit` で型検査する。
- `src/` 非テストファイルの行カバレッジが 97% 以上であることを verify の `test` 段階で検査する。
  - `--coverage --coverage-reporter=lcov` の結果を小さな集計で読み、`src/` だけを対象にする。examples と scripts は対象外。
  - **要確認**: Bun 1.4.4 の `coveragePathIgnorePatterns` で同じことができるなら、そちらを使う。
- **受け入れ条件**: export を 1 つ消した配布物や、型が壊れた `.d.ts` を `verify-package` が検出する負例を、既存の負例 3 種に加える。

### Phase 5: 評価・リポジトリ・DX

#### WS12 LLM 評価の独立性と費用上限。独立（`examples/quality/` と `docs/quality-validation.md`）
- **自己採点を除いた集計**: `examples/quality/answers.ts` の集計に、生成 provider と採点 provider が同じ判定を除いた `crossOnly` の合格率を追加し、従来の値と並べて出力する。
  - 試験は `test/examples/quality-answers.test.ts` に追加する。自己採点だけが合格になる fixture で、`crossOnly` が下がることを確かめる。
- **結論の範囲を冒頭に書く**: `docs/quality-validation.md` の冒頭に quality-80 の実施状況を置く。
  - 内容: 未完了であること、回答数・判定数・消費額。値は `verification-reports/quality-80/answer-summary.json` から転記する。
  - 結論が部分集合の観察であることを明記する。
- **累積の予算上限**: `examples/quality/budget.ts` に予算ルート（`budget-root.json: { capUsd, ledgers: string[] }`）を導入する。
  - 追加台帳での freeze は、登録済み台帳の上限と新しい台帳の上限の合計が `capUsd` を超えると拒否する。
  - ルートの消失や破損は fail closed にする。
  - Codex SDK 経路（`check:memory:live`）が USD 台帳の対象外であることを docs に明記する。
- **有料コマンドの命名**: 有料 API を呼ぶ npm script に `paid:` 接頭辞を付ける。旧名の別名は残さない。
  - 対象: `eval:memory:*`、`check:memory:live`、`check:memory:conversations:live`。`bench:memory` が API を呼ぶかは**要確認**。
  - `package.json` は共有ファイルとして統合時に編集し、docs と README の記載を揃える。

#### WS13 リポジトリの整理（D4 に従い、現在のツリーだけを対象にする）
- **結果 JSON**: `examples/*/results/*.json`（19 件、約 10.4MB。最大 3.7MB）を GitHub Release の資産に移す（または外部に保管する）。
  - `examples/results-index.md` を置き、ファイル名・sha256・サイズ・要旨・保管先を記録する。
  - 先に `grep -rn 'results/' test examples scripts` で参照を洗い出す。試験が参照していれば、必要な最小部分を `fixtures/` に縮約する。
- **ローカルパスの除去**: `/Users/y.noguchi` を含む追跡ファイルは次のとおり。
  - `examples/seeds/data/codex-user-50.jsonl`
  - `examples/standalone/results/` の 5 件
  - `spec/reviews/` の 6 件
  - `spec/saaa-memory-system-review.md`

  seed の `evidence` 中の `/Users/.../.codex/sessions/<file>` は、`codex-session:<ファイル名の sha256 先頭12桁>` に置き換える。
  - `test/examples/seeds.test.ts` と `examples/seeds/` のローダーが evidence の書式を検査しているかは**要確認**。
  - `spec/reviews/` は、ハッシュで内容を固定している記録ならパスを置き換えず、README に注記する（**要確認**）。
- **`examples/experiments`（81 ファイル）**
  - `examples/experiments/README.md` に、各実験の状態（現役 / 凍結）と、再利用するコードか一回限りの調査記録かを示す表を置く。
  - 凍結した調査記録（WORKLOG、AMENDMENT、RECOVERY など）は `docs/archive/experiments/` へ移す。移す前に参照を洗い出す。
- **受け入れ条件**
  - `git ls-files | xargs grep -l '/Users/'` が 0 件（`spec/reviews` を注記対象にした場合はそれを除く）。
  - 追跡中の JSON の合計が 1MB 未満。
  - `bun test test/examples` が通る。

#### WS14 DX
- README のコマンド表を「無料・ローカル」「有料 API」「配布」に分類する（WS12 の命名と一致させる）。
- `src/index.ts` / `src/sqlite.ts` の JSDoc の日本語は `.d.ts` にそのまま出る。日本語のままにするか、英語の要約を併記するかを決めて host-guide に明記する（**要判断**。既定は日本語のまま）。

## 5. 共有ファイル
着手前に確定する契約（§3）:
- `src/domains/lifecycle/contracts/index.ts`（`ApplyForgetInput`）
- `src/infrastructure/sqlite/db.ts`（`MemoryDb` の型のみ。実装の変更は WS4）
- `src/infrastructure/sqlite/errors.ts`

各 WS の完了後に統合時に編集するもの:
- `package.json`（scripts の改名。版は統合時に決める）
- `bunfig.toml`（WS11 で必要なら）
- `src/index.ts`、`src/sqlite.ts`
- `src/infrastructure/sqlite/migrations/index.ts`（0009 の登録）
- `src/contracts/test/exports.test.ts`
- `README.md`、`docs/host-guide.md`、`CHANGELOG.md`（本文は WS9 が書く。他の WS は追記事項を WS9 に渡す）

## 6. 実施順序と並列化
1. §3 の契約ファイルを更新する。
2. Phase 1:
   - WS1 → WS2 → WS3 は同じファイルを触るので、同じ担当者が順に行う。
   - WS4 と WS5 は WS1 と並行できる（書込み範囲が重ならない）。
3. Phase 2:
   - WS7 は Phase 1 の完了後に行う。
   - WS6 と WS8 は WS7 と並行できる。WS6 は docs のみで、WS8 は計測のみ。
4. Phase 3: WS9 は Phase 1・2 の完了後（記述対象が確定してから）。
5. Phase 4・5:
   - WS10・WS11・WS12・WS13 は src の変更と独立していて、互いに並行できる。
6. 最後に統合者が共有ファイルを編集し、`bun run verify:all` と `bun run verify:package` を 1 回ずつ実行する。

## 7. 全体の受け入れ条件
- `bun run verify:all` と `bun run verify:package` が通る。
- 有料 API を呼ぶコマンドは本書の範囲では実行しない。WS12 の変更は offline 試験で確認する。
- 各 WS の再現試験が変更前に失敗し、変更後に通る（修正系の WS1〜WS5、WS10）。
- 公開面の変更（§3.3）と復元の手順（§8）が host-guide と CHANGELOG に記載されている。
- §9 の各行について、Eumenes への影響の有無が確認済みである（Eumenes での実施は別途）。
- 再評価で、M1〜M3、`inTransaction`、L3、L4 が解消済みと判定される。評点の目標値は設定しない。

## 8. 復元の設計（D3）

### 8.1 復元で何が起きるか
- 復元とは、DB ファイル全体をバックアップ時点に戻すことである。
  - Eumenes は会話・Memory・World を 1 つの DB ファイルに置き、Writer も 1 つである。World が Memory の変更フィードを読む位置（カーソル）も同じ DB にある（`eumenes/api/domains/world/README.md`「Continuous input」）。
  - そのため、バックアップ後の書込みは全ドメインで同時に失われ、ドメイン間の参照は矛盾しない。
- **失われるもの**: バックアップ後に作った記憶（State・Records）、会話、World の導出物。
  - DB の中にしかないデータなので、本体では取り戻せない。「記憶が飛ぶ」こと自体は、バックアップから戻す限り避けられない。
  - できるのは、飛ぶ幅を縮めること（§8.3）と、飛んだ範囲で矛盾を起こさないこと（§8.2）である。
- **失ってはいけないもの**: 忘却。ジャーナルを DB の外に置き、起動時の `reconcileForgetJournal` で再適用している（実装済み）。
- **起きてはいけないもの**
  - 復元前に発行済みの番号との衝突（L2）。
  - 依存先が古い導出物を持ち続けること。忘却を再適用したときは `feedResyncRequired` で知らせる（実装済み）。

### 8.2 本体が保証すること
| # | 保証 | 実現方法 |
|---|---|---|
| R1 | 忘却は戻らない | 既存。ジャーナルの再適用と墓標 |
| R2 | 復元後の新しい記憶が保存できる（ID が衝突しない） | WS1 手順 4（墓標と衝突したら seq を取り直す） |
| R3 | 忘却を再適用したら依存先に再同期を知らせる | 既存。`reapplied > 0` で `feedResyncRequired: true`。忘却の再適用がない復元では、依存先のカーソルも同じ DB で一緒に戻るので、再同期は要らない |
| R4 | 復元を何度繰り返しても、また reconcile が途中で失敗して再起動しても、R1〜R3 が成り立つ | 試験で確認する（下記） |

- **試験**: `test/scenario/restore.test.ts` を新設し、`test/runners/fake-eumenes-host.ts` の「再起動・DB 復元」を使う。
  - 通しのシナリオ: バックアップ → 記憶の作成 → 忘却 → 記憶の作成 → 復元 → reconcile → 同じ scope で記憶の作成。
  - 確かめること: 忘却済みが見えない（R1）、最後の作成が成功する（R2）、`feedResyncRequired`（R3）。
  - 追加のケース: 2 回続けての復元、reconcile の途中で例外を起こして再起動。
  - 試験の配置先: WS10 と同じ。

### 8.3 失う幅を縮める（Eumenes 側の要件）
- **E1: 稼働中の定期バックアップ**
  - 現状の `bun run db:backup` は API の停止中しか使えない（`eumenes/docs/operations.md:24`）。
  - Writer を持つ API プロセス内で `VACUUM INTO` を定期的に実行する（例: 起動の直後、6 時間ごと、正常終了の時）。世代は N 件を保持する。
  - integrity_check と書き出しは既存の `backupDatabase`（`eumenes/api/infrastructure/sqlite/pre-migration-backup.ts:46`）を再利用する。
  - `VACUUM INTO` は読取り transaction 内で一貫したコピーを作るので、稼働中でも整合性は保たれる。
  - **要確認**: 実行中に Writer が待たされる時間と DB サイズの関係。
  - 失う幅はバックアップ間隔以下になる。
- **E2（E1 で足りない場合の代替）**: WAL を継続的に複製する（Litestream など）。失う幅を秒単位まで縮められるが、外部プロセスの運用が増える。
- **E3: 復元コマンド `bun run db:restore <bak>`**。`eumenes/docs/operations.md` の手動 6 手順（「手順は未実行」と書かれている）を自動化する。
  1. owner lock を取れることを確認する（API が停止していること）。
  2. `.bak` に `PRAGMA integrity_check` をかける。
  3. 現在の DB と `-wal`・`-shm` を `<DB>.before-restore-<時刻>` へ退避する。削除はしない。
  4. `.bak` を DB のパスへ複製する。
  5. **忘却ジャーナル（`*.jsonl` と `*.blocks.jsonl`）は戻さず、消さない。** 古いジャーナルを戻すと、忘れた記憶が復活する。この規則は `docs/operations.md` にも明記する。
  6. 終了する。次の起動時、通常の起動経路で migration → `reconcileForgetJournal` → `feedResyncRequired` → World の recover が順に動く。
- **Eumenes 側の受け入れ**: バックアップ → 会話・記憶・忘却 → `db:restore` → 起動の通し試験で、次を確かめる。
  - 忘却済みが見えない。
  - 新しい記憶が保存できる。
  - World が再同期する。

### 8.4 救出（任意。既定では行わない）
旧 DB が読める場合に限り、バックアップ後に作られた State を旧 DB から復元先へ移す案がある。忘却済みのものは墓標とトリガーで拒否されるので、復活はしない。

ただし次の問題があるため、採用しない。
- 根拠の会話は復元で消えているので、会話に存在しない記憶ができる。
- 復元の理由が DB の論理的な破損なら、壊れたデータも一緒に移る。

## 9. Eumenes 側の追従（D4。実施は Eumenes リポジトリで別途）
基準: Eumenes `2c2ac893`、vendor の `eumenes-memory-0.0.2-3070b7dd6e4a.tgz`。

| 本書の変更 | Eumenes の該当箇所 | 必要な対応 |
|---|---|---|
| `applyForget` の `access` 必須化（WS2） | `api/domains/memory/service/forget.ts:140`。試験: `api/application/world/world-research.fixture.ts:174`、`api/application/world/world-acceptance-p3.test.ts:339`、`api/domains/world/test/lifecycle-fixture.ts:185`、`api/domains/world/test/memory-adapter.test.ts:395` | 直前の `planForget` と同じ `access: access(db, "memory.forget")` を渡す。同じ access なので `SCOPE_NOT_PERMITTED` は起きない |
| migration 0009（WS1） | `api/application/migrations.ts` の適用順の一覧（:83 以降の `"memory-package/000N"`）。本文は `packageMigrations("memory-package", memoryPackageSql)`（:199）で自動的に入る | 一覧に `"memory-package/0009"` を追記する。起動時の pre-migration バックアップが自動で取られる |
| 墓標の principal 分離（WS1） | principal は定数 `PRINCIPAL` 1 つ（`api/domains/memory/service/index.ts:175` ほか） | 挙動の変化なし |
| `inTransaction` の必須化（WS4） | `bun:sqlite` の `Database` を直接渡している | 変更不要。**要確認**: 試験用の fixture で MemoryDb を自作していないか |
| L3（WS5） | World は `endByte <= startByte` を自前で弾いてから `sliceUtf8Range` を呼ぶ（`api/domains/world/service/source-adapter.ts:214-229`） | 変更不要（新しいコードを足さないため） |
| M2（WS3）、L4（WS5）、WS7 | 公開 API の変更なし | 変更不要 |
| 復元（§8.3） | `api/application/db-backup.ts`、`api/infrastructure/sqlite/pre-migration-backup.ts`、`docs/operations.md` | E1・E3 を実装し、復元の通し試験を追加する |
| 配布物の更新 | `vendor/eumenes-memory/`、`vendor/eumenes-memory/manifest.json`、`package.json:57` | `bun pm pack --destination artifacts` で作った tgz に差し替える |

Eumenes 側の受け入れ: vendor の更新後に、memory と world ドメインの verify と、§8.3 の復元の通し試験が通ること。

## 10. リスクと未解決事項
- **呼び出し側の更新**: `applyForget` の `access` 追加と `inTransaction` の必須化により、本リポジトリの呼び出し側（examples、test/runners、`scripts/package-consumer.mjs`）と、Eumenes（§9）の修正が要る。vendor を更新するときに同時に対応する。
- **0009 は表の作り直し**: 墓標の多い DB では適用に時間がかかる。件数別の所要時間を WS1 の移行試験で記録する。
- **墓標を principal ごとにすると挙動が変わる**: principal をまたいで共有している SourceKey について、他の principal が忘れても自分の側では採用が止まらなくなる。全 principal から消したいホストは principal ごとに forget を計画する。これを host-guide に書く。
- **要確認の一覧**: L2 の再現性、`DatabaseSync#isTransaction` が使える Node の版、Bun の `coveragePathIgnorePatterns`、`bench:memory` が有料かどうか、seed ローダーの evidence 書式の検査、`spec/reviews` のハッシュ固定。
- **履歴**: 履歴は書き換えない（D4）。公開リポジトリの過去のコミットには、ローカルパスと結果 JSON が残る。
