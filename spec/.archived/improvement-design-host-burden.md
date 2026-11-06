# 改善設計（2026-11-06 評価の指摘と、ホスト負担の背景確認）

作成日: 2026-11-06。基準コミット: `5504945`（本リポジトリ）、`2c2ac893`（Eumenes、読み取りのみ）。本書は計画であり、製品コードはまだ変えていない。

## 0. 目的と範囲

2026-11-06 の多角的評価で挙げた改善点を、変更案・互換性・受入条件の形に整理する。ホストの負担については、現在の形に背景があるかを設計書と Eumenes の実装で確認し、背景がある負担は維持、背景が見当たらない負担だけを軽くする。

- 確認した資料: [全体設計](full-system-design.md)、[永続化設計](persistence-design.md)、[検証状況](verification-status.md)、`docs/host-guide.md`、`src/infrastructure/sqlite/README.md`、Eumenes の `api/domains/memory/service/{journal,forget,index}.ts`、`api/domains/memory/repository/{ledger,seeds}.ts`。
- Eumenes の実データは行数だけを確認した（`data/` の忘却ジャーナル11行、block journal 4行、World のジャーナル15行。中身は読んでいない）。
- 対象外: CI に関する改善・受入（利用者の指定）。受入条件はローカルの対象試験で示す。
- 変えない原則: 本体は接続・transaction・ファイル I/O・グローバル状態を持たない。Eumenes が使わない機能は持たない。migration は追記専用。ジャーナルの所有はホスト（[全体設計](full-system-design.md) §10、利用者の確認済みの判断）。

## 1. 決定事項（2026-11-06、利用者）

| 項目 | 決定 |
|---|---|
| A2 ジャーナル | Eumenes の block journal を廃止し、本体の忘却ジャーナル1本に統合する（ホストの意図を鎖に載せる） |
| A1 複数 target | 1回の `planForget` に複数の target を渡せる。ただし全 target は同じ `scopeKey` に限る |
| A3 transaction 検査 | `inTransaction` を必須にする。検査を外す宣言は作らない |
| D2 | Eumenes に同等の仕組みがあるかを調べてから決める（§3 D2 に調査結果） |
| 実施 | 2026-11-06、利用者の指示で B1・A1・A2・A3 と Eumenes 側（A2.5）を実施した（§6） |

## 2. ホスト負担の背景確認

| # | ホストの負担 | 背景 | 出典 | 判断 |
|---|---|---|---|---|
| H1 | 接続・単一 Writer・write transaction を持つ | State の書き込みと、ホストの回答保存・利用記録を同じ transaction で確定するため、同じ DB ファイルと同じ Writer を共有する。Eumenes の `openStore` が flock と Writer を所有する | 永続化設計 §1・§2 | 維持 |
| H2 | 本体の migration を自分の配列へ追記し、適用する | Eumenes の `schema_migrations` は全 domain 共通で、配列の添字 +1 が id | 永続化設計 §1・§4 | 維持。`checkHostMigrations` で足りている |
| H3 | 忘却ジャーナルのファイル操作（追記・fsync・ディレクトリの fsync） | DB ファイルを古い版へ戻すと墓標も戻るため、DB の外の媒体が要る。`src/` はファイル I/O と `process` を禁じる（Bun と Node の両方で使える純粋な層にする） | 全体設計 §0・§2.5・§10、永続化設計 §8-1 | 維持。Eumenes は `journal.ts` の94行で実装済み |
| H4 | 起動時の reconcile と、不整合時の利用停止（fail closed） | 本体は状態を持たないため、復元直後で未照合の DB を読み出し関数だけでは検出できない | 全体設計 §2.5-3・R-B | 維持 |
| H5 | 複数の文にまたがる読み出しを read transaction で囲む | 本体はどの接続で呼ばれるかを仮定しない | 永続化設計 §5 | 維持 |
| H6 | 物理消去（`secure_delete`、checkpoint、VACUUM） | 本体は PRAGMA を持たない | 全体設計 §2.5 | 維持 |
| H7 | ホストが所有する派生物を忘れる意図を、**第2のジャーナル**で管理する | **見当たらない**。entry に本文・digest を入れない規則（§2.5）があるだけで、ホストの意図を除外する理由は設計書に無い | Eumenes `journal.ts:29` | **統合する（A2、決定）** |
| H8 | 1回の忘却で fsync を 1+N 回行う | **見当たらない**。`PlanForgetInput.target` が1件しか取らないことによる。entry の `targets` はもともと配列（上限64） | `src/domains/lifecycle/contracts/index.ts:181`、Eumenes `forget.ts:139`・`:313` | **複数 target を受ける（A1、決定）** |
| H9 | `inTransaction` を持たないドライバでは、transaction 外の書き込みを自分で防ぐ | Bun 以外のドライバを構造的型付けで受けるため（全体設計 §2.2）。ただし検査を**黙って**省く理由は書かれていない | `src/infrastructure/sqlite/db.ts:22`・`:56` | **必須にする（A3、決定）** |

H1〜H6 には明確な背景があり、本体へ移すとその背景と衝突する。

World ドメインのジャーナル（Eumenes `world-forget-journal.jsonl`、`api/domains/world/service/world-journal.ts`）は統合の対象にしない。理由は2つ。

- World は別ドメインとして分ける設計判断がある（全体設計 §0）。
- World の忘却は複数の write transaction にまたがる段階処理（`lifecycle-forget-steps.ts` の journal → world → …）で、独自の鎖をすでに持っている。

## 3. 改善項目

### A1・A2 は1つの契約変更として入れる

どちらも `planForget` の入力と journal entry を変えるので、Lifecycle の契約版 2（`CONTRACT_VERSIONS.lifecycle` に 2 を追加）にまとめる。

- 契約版 1 の呼び出しは、今と同じ format 1 の entry を作る。
- 契約版 2 の呼び出しは format 2 の entry を作る。
- 検証・適用・reconcile は format 1 と 2 の両方を受ける。
- DB スキーマは変えない（`MEMORY_DB_SCHEMA_VERSION` は 8 のまま）。

#### A1. `planForget` で複数の target を受ける（決定: 同じ scope に限る）

- 現状: Eumenes は忘れる State item ごとに plan → 追記（fsync）→ apply を繰り返す（`forget.ts:126-153` の `forgetStateId` を `:313` でループ）。要求は5件までだが、`expandItems` が全ての版と統合元まで広げるので、実際の件数は増える。
- 変更: `PlanForgetInput` に `targets?: readonly ForgetTarget[]` を追加し、`target` と排他にする。
  - 全 target の `scopeKey` が同じでなければ、入力検査違反（`MemoryContractError`、`targets` のパス）。
  - 件数は `LIMITS_LIFECYCLE.maxJournalTargets`（64）以下。
  - `access.scopeKeys` に含まれない scope は、今と同じく `blocked: SCOPE_NOT_PERMITTED`。
- 同じ scope の検査は `planForget` の入力にだけ行う。entry の検証規則は変えない（format 1 の既存 entry に影響させない）。
- Eumenes の忘却の target はすべて `PROFILE_SCOPE` なので、この制限で困らない。

#### A2. ジャーナルを1本に統合する（決定）

##### A2.1 現状

Eumenes は、会話 message を文脈から外す、ベクトル・継続ノート・傾向・利用記録を消す、という意図を、忘却ジャーナルの隣の `*.blocks.jsonl` に書いている（`forget.ts` の `forgetInTransaction`）。その問題は次のとおり。

- block journal には hash の鎖が無い。`readJournal`（`journal.ts:43`）は各行が JSON として読めるかしか見ないので、行がまるごと欠けても検出されない。DB の復元と重なると、隠したはずの message が文脈に戻る。
- 2本のずれ（意図は書いたが State の忘却がジャーナルに届かなかった場合）を、Eumenes の `recover` が `completedIntents`（`index.ts:362` 以降）で補っている。
- 本体の `host_source` target は代わりにならない。これは「その出典を引用する item をすべて忘れる」閉包であり、Eumenes の意味（message は文脈から外すが、同じ message を根拠にする他の item は残す）と異なる。

##### A2.2 entry format 2

```ts
interface ForgetJournalEntryV2 {
  readonly journalFormat: 2;
  readonly seq: number;
  readonly prevHash: string;
  readonly forgetId: string;
  readonly principal: string;
  readonly targets: readonly ForgetJournalTarget[]; // 0〜64。0 件は hostIntent があるときだけ
  readonly hostIntent?: HostForgetIntent;          // 本体は意味を解釈しない
  readonly hash: string;
}
/** キー → 不透明な ID 文字列の集合。本文を入れない。 */
type HostForgetIntent = Readonly<Record<string, readonly string[]>>;
```

- `hash = sha256Hex(canonicalJson({ journalFormat, seq, prevHash, forgetId, principal, targets, hostIntent }))`。`hostIntent` が無いときはキーごと含めない。
- `forgetId` の計算は format 1 と同じ（`principal, seq, targets`）。`seq` が一意なので、`targets` が空でも衝突しない。
- `hostIntent` の正規化: 各配列は重複を除いて UTF-16 コード単位順に並べる。空の配列のキーは除く。キーが1つも残らなければ「無し」として扱う。
- 上限（`LIMITS_LIFECYCLE` に追加）: キー16個、キー64 bytes、ID 256 bytes、ID は entry 全体で65,536個。空文字列の ID は拒否する。ID の総数は当初1024個としたが、版が1000件を超える事実の忘却（Eumenes の既存試験）で意図が1行に収まらなかったため引き上げた。ホストは意図（全版の itemIds）を最初の entry に載せ、起動時に残りを忘れるので、意図を分割できない。超える場合、Eumenes は何もジャーナルに書く前に `forget_limit` で拒否する。
- 本文を入れない責任はホストにある。本体が検査するのは形と大きさだけ。Eumenes の seed のフェンス（`memory.seed-import`）は、取り込んだ seed 全体の digest であり、忘れた個々の文の digest ではない。再取り込みを止める識別子としてそのまま載せてよい。

##### A2.3 本体の API

| 関数 | 変更 |
|---|---|
| `planForget` | 契約版 2 で `targets` と `hostIntent` を受ける。`target` / `targets`（1件以上）/ `hostIntent` のうち少なくとも1つが必要。format 2 の entry を返す |
| `applyForget` | format 1・2 を受ける。`targets` が空なら、head を進めて `memory_forget` に1行を書くだけ（receipt は `completed: true`）。`memory_forget.request_json` は今と同じく `{targets}` だけで、`hostIntent` は DB に保存しない（正本はジャーナル） |
| `reconcileForgetJournal` | format 1・2 が混在する鎖を受ける。結果に `hostIntentsToReapply: readonly { forgetId, hostIntent }[]` を加える。今回の呼び出しで適用した entry のうち、`hostIntent` を持つもの |
| `verifyForgetJournal`（`.` の純粋関数） | format 1・2 の混在を受ける。format 2 の後に format 1 が来ても拒否しない（規則を増やさない） |
| 入力の読み取り（`readJournalEntry`） | format 2 では `hostIntent` を任意キーとして受ける。format 1 のキーの規則は変えない |

`hostIntentsToReapply` だけで再実行の範囲が足りる理由は次のとおり。

- ホストの消去は、本体の `applyForget` と同じ write transaction で確定する。
- したがって DB の head 以前の entry は、ホストの消去も DB に入っている。古い DB を復元した場合も、その DB の head 以前は同様。
- 再実行が要るのは、今回 reconcile が適用した entry（head より後）だけになる。

##### A2.4 互換性と巻き戻し

- 既存のジャーナル（format 1 の11行）はそのまま鎖の先頭に残り、検証・再適用できる。
- 最初の format 2 の entry を書いた後は、本体を古い版へ戻せない。古い版は format 2 を読めず、reconcile が入力検査で失敗して Memory が止まる（fail closed）。これは「新しい DB に旧バイナリを差し戻すのは安全な rollback ではない」（host-guide の startup 4）と同じ扱いで、文書に明記する。
- パッケージの版を上げる（0.0.3）。`MemoryDb` の型も変わる（A3）。

##### A2.5 Eumenes 側の変更

忘却（`forget.ts` の `forgetInTransaction`）:

1. 入力検査、版の展開（`expandItems`）、根拠の message と同じ run の相手（`withPartners`）、`derived`、seed のフェンスは今のまま。
2. `hostIntent = { conversationId: [..], messageIds, itemIds, ...derived }` を作る。`itemIds` はホストの消去（傾向・出所・利用記録）に要るので載せる。
3. `planForget({ contractVersion: 2, targets: 展開した item（PROFILE_SCOPE）, hostIntent })` → ジャーナルへ1行を追記（fsync 1回）→ `applyForget` → `purgeDerivedInTransaction` → 文脈の窓の消去。
4. 展開した item が64件を超える場合は entry を分ける。`hostIntent`（全 `itemIds` を含む）は最初の entry に載せる（意図を先に書く、という今の順序を保つ）。
5. block journal への追記、`deps.journalBlocked` へのその場での追加、`markBlockApplied` は削除する。`journalBlocked` は統合ジャーナルの `hostIntent.messageIds` から作る。

起動時（`index.ts` の `recover`）:

1. 統合ジャーナルを読み、読めた全行の `hostIntent.messageIds` で履歴の非表示の集合を作る。鎖の検証より前に行う（今の「何が失敗しても、まず履歴を隠す」を保つ）。
2. `assertMemorySchema` → `reconcileForgetJournal`。
3. `hostIntentsToReapply` の各要素について、同じ write transaction の中で `purgeDerivedInTransaction` を実行する。
4. どの entry の `targets` にも入っていない `hostIntent.itemIds` で、まだ存在する item を忘れる（A2.5 忘却の4で entry を分けた途中で落ちた場合だけ起きる）。今の `completedIntents` と同じ処理を、block journal ではなく統合ジャーナルから行う。
5. 全 entry の item について利用記録と傾向を消す処理（今の `purgeUsageFor` / `deleteTendenciesByEvidence`）は変えない。

既存の block journal（4行）の移行。起動時、reconcile が `ok` の後に1回だけ行う。

1. `*.blocks.jsonl` が存在すれば、各行のうち、統合ジャーナルのどの `hostIntent.legacyBlockForgetId` にも無い行を選ぶ。
2. 選んだ行ごとに `planForget({ contractVersion: 2, targets: [], hostIntent: { 行の内容, legacyBlockForgetId: [行の forgetId] } })` → 追記 → `applyForget`。DB 側の `isBlockApplied` が偽なら `purgeDerivedInTransaction` も行う。行の `at` は再適用に使われていない（grep で使用箇所なし）ので載せない。
3. 全行を取り込んだら、ファイルを `*.blocks.jsonl.imported` へ rename し、ディレクトリを fsync する。
4. 2 と 3 の間で落ちた場合、次の起動では `legacyBlockForgetId` で取り込み済みの行を飛ばし、rename だけを行う。
5. `memory_message_block.forget_id` には移行前の forgetId が残るが、参照は message の非表示だけなので影響しない。`memory_block_applied` の表は使わなくなる。削除は別の migration で後から行う（今回は表を消さない）。

##### A2.6 受入

本体（`bun run test:domain -- lifecycle`、`fixtures/lifecycle/` に L22 以降を追加）:

- format 2 の entry の生成と hash が、手書きの期待値と一致する。`hostIntent` の正規化（重複除去・整列・空配列の除去）も含める。
- `hostIntent` を1文字でも書き換えると `JOURNAL_CHAIN_BROKEN`、末尾を切り詰めると `JOURNAL_TRUNCATED` になる。
- format 1 の既存 fixture（L01〜L21）は変えずにすべて通る。format 1 の後に format 2 が続く鎖が通る。
- 忘却前の DB を復元して reconcile すると、head より後の entry だけが `hostIntentsToReapply` に返る。2回目の reconcile では空になる。
- `targets` が空で `hostIntent` だけの entry を apply すると、State と Records は変わらず、head と `memory_forget` だけが進む。
- 上限超過、空文字列の ID、異なる scope の混在、`target` と `targets` の同時指定を拒否する。
- 契約版 1 の呼び出しは、今と同じ format 1 の entry を返す（既存試験がそのまま通る）。

Eumenes（Eumenes 側の memory / world の試験）:

- 1回の忘却でジャーナルの追記と fsync が1回になる。
- 古い DB を復元して起動すると、message が隠れ、派生物の消去が再実行される。
- 統合ジャーナルの `hostIntent` を改ざんすると Memory が使えなくなる。
- block journal の移行は、途中で落ちても重複なく完了する。
- 既存の忘却・復元の試験がすべて通る。

### A3. `inTransaction` を必須にする（決定）

- 変更: `MemoryDb.inTransaction` を `readonly inTransaction: boolean`（必須）にする。`assertWritable` は `db.inTransaction !== true` のとき `MemoryStoreError("NOT_IN_TRANSACTION")` を投げる。値が無い場合も同じコードにする（エラーコードは増やさない）。
- 影響: bun:sqlite の `Database` は `inTransaction` を持つので、Eumenes の変更は不要。`scripts/package-consumer.mjs:33` の Node 用アダプタはすでにフラグを持つ。
- 更新するもの: `src/infrastructure/sqlite/db.ts` の型と JSDoc、全体設計 §2.2、`docs/host-guide.md` の Node の説明（「提供すると」→「必須」）。
- 受入（`src/infrastructure/sqlite/test/db.test.ts`）:
  - フラグの無いアダプタと、`false` を返すアダプタでは、書き込みが `NOT_IN_TRANSACTION` になる。
  - bun:sqlite の transaction 内・外の挙動は今と同じ。
  - 読み取り関数はフラグを要求しない。

### A4. 起動手順をまとめる関数（保留）

- Eumenes の `recover` は `verifyForgetJournal` を呼んでから reconcile しているが（`index.ts:351`）、`reconcileForgetJournal` も内部で同じ検証をしている。
- 唯一のホストである Eumenes は実装済みなので、「使わない機能は持たない」に従って保留する。

### B. 文書と実装の食い違い

#### B1. ジャーナルを追記する位置（優先: 高）

- 記述: [全体設計](full-system-design.md) §2.5（132行）は「ホストが entry をジャーナルへ追記して fsync（transaction の外）」、`docs/host-guide.md:46` は「fsync を確認してから、write transaction 内で `applyForget`」。plan を apply とは別の transaction で行ってよいようにも読める。
- 実装: `applyEntry` は、entry の `seq` が head+1 で、`prevHash` が head の hash に一致することを要求する（`src/domains/lifecycle/repository/index.ts:661`）。plan と apply の間に別の忘却が入ると、ジャーナルには適用できない entry が残り、次の reconcile で `JOURNAL_CHAIN_BROKEN` になって Memory 全体が止まる。
- Eumenes は plan → 追記（fsync）→ apply を1つの write transaction の中で行っており（`forget.ts:126-153`）、こちらが正しい。
- 案: 両方の文書を次の趣旨に書き直す。「plan・追記・apply は単一 Writer の同じ write transaction の中で行う。ジャーナルの書き込みは DB の rollback では戻らず、残った entry は次の起動時の reconcile が適用する。fsync の間は Writer を保持する（R-C）」。A2 の `hostIntent` と `hostIntentsToReapply` の説明も同じ節に加える。

#### B2. README の整理（優先: 低）

- README には公開面の全関数・DB スキーマの経緯・retention の規則が1ページに入っている。README は入口（目的、導入、コマンド、各文書へのリンク）に絞り、規則は `docs/host-guide.md` と各 README に寄せる。`test/docs.test.ts` が README を検査しているので、同時に更新する。

### C. コード品質（優先: 低）

| # | 現状 | 案 | 備考 |
|---|---|---|---|
| C1 | `assertUserState` などは `enterWrite`（seq の発行）の後で `isPermitted` を見る（`src/domains/state/repository/index.ts:716-717`、`:814-815`）。拒否された書き込みでも seq を消費する | 現状維持でよい。直すなら、エラーの優先順位（NOT_IN_TRANSACTION > SCHEMA_* > blocked）を固定した試験を先に書く | 実害は seq の欠番だけ |
| C2 | `translateSqliteError` は読取専用のエラーを英文の部分一致でも判定する（`db.ts:26-44`） | `node:sqlite` の読取専用接続への書き込みが `READONLY_CONNECTION` になる試験を、`scripts/package-consumer.mjs` の Node 経路に足す | 判定ロジックは変えない |
| C3 | `src/domains/lifecycle/repository/index.ts`（1218行）と `src/domains/state/repository/index.ts`（1085行）が大きい | plan/apply/reconcile/external、assert/status/read の単位でファイルを分ける。公開面と SQL は変えない | A2 の実装と同時に行うと差分が読みにくいので、A2 の後に行う |
| C4 | `listState` は件数に比例して遅くなり（1万件で28ms）、ORDER BY に一時 B-tree を使う | 保留。個人の記憶の規模では不要 | `verification-reports/quality-80/performance.json` |

### D. リポジトリの構成

#### D1. examples と結果の置き場所（優先: 低）

- `examples/standalone` は独立ホスト（`bun run memory`）、`examples/experiments` と `examples/quality` は評価用。コミット済みの結果 JSON は `RESULTS.md` と `test/examples/standalone.test.ts:825` が参照する凍結済みの証拠で、事前登録との対応を保つためにコミットしている。
- 案: 別リポジトリへは分けない（同じコミットで型検査と回帰を回せる利点を失う）。代わりに「生データとログは `verification-reports/`（git 管理外）に置き、コミットするのは集計と、文書や試験が参照するものだけ」という規則を `examples/experiments/README.md` に明記する。

#### D2. 独立ホストで採用した方式と Eumenes の関係（調査済み）

比較元は `examples/standalone` の `applyMemoryPlan`（`execution.ts`）、`planMemory`（`planning.ts`）、一括取得（`retrieval.ts`）。Eumenes の記憶の保存判断は steward ドメインの curate-memory（`api/domains/steward/service/`、`api/domains/memory/service/curation*.ts`）で行われる。以下は Eumenes `2c2ac893` を読んだ結果で、file:line は Eumenes の `api/` 配下。

Eumenes の流れ:

1. 会話の run の終了時、または memory ツールの依頼で、unit と queue の job を同じ transaction で作る（`steward/service/kick.ts:69-150`）。
2. curate-memory の job は concurrencyKey `steward:long-term` で、会話をまたいで1件ずつ直列に実行される（`kick.ts:40-41`・`:96-98`）。
3. prepare で入力を作り、その時点の forgetSeq を記録する（`unit-prepare.ts:95-184`）。
4. LLM を1回呼ぶ。
5. settle は単一 Writer の1つの transaction で行う。
   - owner・attempt・generation を照合する。
   - prepare 以降に忘却があれば unit ごと捨てる（`unit-settle.ts:162-174`）。
   - 適用は forget（依頼ごとの savepoint）→ withdraw → 残りの要素（要素ごとの savepoint）の順（`curate-apply.ts:600-687`、`memory/service/curation.ts:76-105`）。

| 比較元の仕組み | Eumenes | 内容 |
|---|---|---|
| F1 古い計画の拒否（記憶全体の snapshot hash） | 部分的 | 更新・停止は、モデルに見せた revision と違えば `item_changed` で拒否する（`curation-state.ts:187-206`）。忘却は forgetSeq の柵で捨てる。ただし新規の保存は、適用時点の active 版を `replaces` に使うので（`curation-state.ts:127-129`）、prepare 後に同じ key が変わっても検出しない |
| F2 全変更の事前検査 | 無 | 要素の検査は各書き込みの時点で行う。忘却のジャーナル追記はその前に起きるが、追記後の失敗は起動時の reconcile が忘却を完了させるので、忘れる方向に倒れる |
| F3 依存する変更のグループ化 | 部分的 | 依存でまとめる単位は無い。要素ごとの savepoint で、片方の失敗がもう片方を巻き戻さない点は同じ |
| F4 矛盾した変更の保留と確認 | 無 | relation も needs_clarification も無い。指示文に「曖昧な対象は推測で変更せず保留」とあるだけ（`steward/contexts/curate-memory/instructions-text.context.toml:19`） |
| F5 再試行の記録（operationId） | 不要 | 適用・unit の close・job の完了が1つの commit に入るので、途中まで適用された状態が残らない |
| F6 忘却対象の全版を先に永続化 | 有 | 全版と統合元まで展開し、block journal に書いてから消す（`memory/service/forget.ts:84-123`・`:295-311`）。A2 の後は統合ジャーナルの `hostIntent` になる |
| F7 グループ間の外部変更の検出 | 不要 | settle 全体が直列の Writer の1 transaction なので、途中に外部の変更が入らない |
| F8 取得 | 方式は別、指示は移植済み | 会話の入力に載る記憶は、本人が述べた嗜好系だけで300トークン以内（`dialogue/service/conversation-input.ts:36-37`）。それ以外は read 道具で最大16件を引く。指示（`dialogue/contexts/system/talk-facts.context.toml`）は、持ち主・否定の範囲・条件と例外・既知部分の保持を、比較元の改善とほぼ同じ趣旨で書いている |

結論:

- 実行制御は移植しない。比較元の成功数の伸び（52→96）は、主に故障の注入・再試行・外部変更のケース（6→45）によるもので、通常のケースでは46→51だった（`examples/experiments/holdout-100/RESULTS.md`）。Eumenes は queue・lease・単一 transaction の設計で、F5・F7 を別の方法で満たしている。
- 移す価値があるのは次の2点だけで、どちらも小さい変更で済む。
  - **F4**: 矛盾した変更を保留し、ユーザーに確認を返す。比較元の改善版でも、残った不合格4件は確認文の欠落だった。
  - **F1 の穴**: 新規の保存でも、モデルに見せた revision と適用時の active 版が違えば `item_changed` にする。curate-memory は直列なので、この穴に当たるのは prepare から settle までの間に seed の取り込み（`/api/memory/seeds/import`）が同じ key を書いた場合に限られる（State を書く経路は `curation-state.ts`・`curation-state-ops.ts`・`curation-merge.ts` だけ）。
- 取得の方式は変えない。300トークンの上限と「本人の言葉だけ」の規則には、会話の毎回の費用と、prompt cache の接頭辞を安定させる理由がある（`conversation-input.ts` の `MEMORY_TOKENS`・`memoryDigestOf`）。比較元の実験は記憶についての質問への正答を測ったもので、毎回の会話の費用は測っていない。
- F4 と F1 は Eumenes の変更で、本リポジトリの作業ではない。実施するかは利用者が決める。

## 4. 背景があるので維持するもの

- H1〜H6 の分担（接続、migration、ジャーナルのファイル操作、起動時の照合、read transaction、物理消去）。
- lint の設定（`.oxlintrc.json` の `correctness` だけ）。README のとおり、隣の Eumenes に合わせている（Eumenes も `correctness` だけ）。変えるなら両方を同時に変える。
- 本体に Node 用アダプタを同梱しないこと。Eumenes は bun:sqlite を使い、「使わない機能は持たない」に当たる。Node の例は文書のコード片にとどめる。
- World ドメインのジャーナル（§2 の末尾）。

## 5. 実施順

1. B1（文書のみ）。
2. A3（本体の型と検査。Eumenes の変更は不要）。
3. A1・A2 の本体側（Lifecycle 契約版 2、format 2、fixture の追加）。パッケージ 0.0.3 の tgz を作る。
4. Eumenes 側: vendor の更新、忘却と起動時処理の書き換え、block journal の移行（A2.5）。
5. C・D は余裕のあるときに行う。

各段階では、変更したドメインの試験（`bun run test:domain -- lifecycle` など）を通す。公開面が変わる段階では、`test/consumer/` と `src/contracts/test/exports.test.ts` の期待値も更新する。

## 6. 実施記録（2026-11-06）

コミットはしていない（作業ツリーの変更のみ）。

本リポジトリ:

- B1: `spec/full-system-design.md` §2.2・§2.5・§3.9、`docs/host-guide.md`、`src/infrastructure/sqlite/README.md`、`src/domains/lifecycle/contracts/index.ts` の JSDoc を、plan・追記・apply を同じ write transaction で行う形に直した。
- A3: `MemoryDb.inTransaction` を必須にし、`assertWritable` は `true` 以外を拒否する（`src/infrastructure/sqlite/db.ts`）。
- A1・A2: Lifecycle 契約版 2（`CONTRACT_VERSIONS.lifecycle = 2`、関数は 1 も受ける）、`planForget` の `targets` / `hostIntent`、journal format 2、`reconcileForgetJournal` の `hostIntentsToReapply`。format 1・2 とも未知のキーを持つ entry を拒否する（format 1 の hash は `hostIntent` を覆わないため）。
- 試験: `src/domains/lifecycle/test/host-intent.test.ts`（14件）、fixture L29〜L34（期待値は実装と別の Python で計算）、`scripts/package-consumer.mjs` に format 2 の復元と `inTransaction` 欠落の拒否（Bun・Node）。
- パッケージ 0.0.3（`artifacts/eumenes-memory-0.0.3.tgz`、sha256 `353a710c8012…`）。`dist/release-manifest.json` の `baseCommit` は `5504945` だが、中身は未コミットの作業ツリーで、`sourceHash` で特定する。

Eumenes（`../eumenes`）:

- `vendor/eumenes-memory/` を 0.0.3 に差し替え（旧 tgz を削除、`package.json`・`bun.lock`・`manifest.json` を更新）。
- `api/domains/memory/service/journal.ts`: `ForgetIntent` と `hostIntent` の相互変換、壊れた行を飛ばして読む `readJournalLenient`（履歴を隠す用途だけ）、旧 block journal の退避。
- `api/domains/memory/service/forget.ts`: 忘却 1 回を forget journal の 1 行に（64 件を超える版だけ分割）。block journal への追記を廃止。
- `api/domains/memory/service/index.ts`: 起動時の照合で `hostIntentsToReapply` の派生データ削除をやり直し、旧 block journal の行を 1 回だけ取り込んで `*.blocks.jsonl.imported` へ移す。
- 試験: `forget-contract` / `forget-derived` / `forget-closure` / `ledger` を統合ジャーナルの形に書き換え、旧 block journal の取り込み（停止位置 1・2）と、壊れた行があっても履歴を隠す試験を追加。
- `docs/memory.md` の journal と復旧の節。

既知の残り:

- 本リポジトリの作業ツリーには、別のセッションが残した変更（`test/scenario/forget-integrity.test.ts` など）がある。その再現試験 12 件は失敗し、整形の検査も通らないため、`bun run verify` は整形の段階で止まる。本書の変更は、整形以外の各段階を個別に実行して確認した。
- F4（矛盾した変更の確認）と F1 の穴（新規の保存の上書き）は未決定のため実施していない。


## 7. 残作業の統合（同日付の3つの設計書との突き合わせ、2026-11-06）

対象: `spec/improvement-design-2026-11-06.md`（以下「設計1」）、`spec/improvement-design-erasure-integrity.md`（「設計2」）、`spec/improvement-design-multi-axis-review.md`（「設計3」）。§6 の実施後の作業ツリーで状態を確かめた。

### 7.1 済んだもの・不要になったもの

| 項目 | 状態 |
|---|---|
| `inTransaction` の必須化（設計1 WS4） | 済み（本書 A3） |
| 試験出力のノイズ（設計2 IMP-07）、追跡ファイルの大きさの検査（IMP-08）、合成 seed への切り替え（IMP-09 の一部） | 別のセッションが未コミットで実装済み（`examples/quality/answers.ts` の `onProgress`、`test/tooling.test.ts` の 512 KiB 検査、`examples/seeds/data/synthetic-seed.jsonl`）。実データの `codex-user-50.jsonl` は追跡されたまま |
| 再現試験（設計2 IMP-01・02・04・05・06） | 別のセッションが `test/scenario/forget-integrity.test.ts` と `test/consumer/retention.test.ts` に追加済み。修正は未着手なので 12 件が失敗する。整形も通っていない |
| 設計1 §8.3 E3 の手順5「`*.jsonl` と `*.blocks.jsonl` を戻さない」 | block journal は廃止した。戻さないのは忘却ジャーナルと `*.blocks.jsonl.imported` |
| 設計1 D2「契約版を上げない」 | 前提が変わった。本書 A1・A2 で Lifecycle は契約版 2 になっている |

### 7.2 決めることなく進められるもの（推奨順。同じファイルを触るので1人で順に行う）

| 順 | 項目 | 出典 | 内容 |
|---|---|---|---|
| 1 | memory record の出典キーの正規化 | 設計2 IMP-01（D1・D2 決定済み）、設計3 F1 | `representation` の欠落を `"text"` で補い、それ以外は契約エラー。State の根拠に引用した memory record を Records 表の現行 revision と照合する |
| 2 | retention 中の origin への `captureRecord` の拒否 | 設計2 IMP-02 | 永続の record が evict で墓標なしに消える問題 |
| 3 | 復元後の ID 衝突 | 設計1 WS1 手順4、設計2 IMP-04 | 両案とも同じ（墓標とぶつかる seq を飛ばす）。スキーマ変更なし |
| 4 | 忘却時の `subject` の消去 | 設計1 WS3、設計3 F3 | `other:<名前>` を `other:` にする。既存の忘却済み行は、その forget の再適用で消える（一括 migration はしない） |
| 5 | 本人確認（origin 昇格）の根拠の保存 | 設計3 F4 | 昇格に使った出典の evidence と依存辺を保存し、その出典の忘却が届くようにする |
| 6 | 許可外の scope の開示 | 設計3 F2（推奨 (a)） | 閉包の伝播は維持し、plan・receipt が返す ID と件数を許可された scope に限る |
| 7 | reconcile の entry の厳格な読み取りの残り | 設計2 IMP-03 | 本書で未知のキーと `hostIntent` は厳格にした。残りは文字列の上限・制御文字の検査と、検証した写しを適用に使うこと（getter・Proxy 対策） |
| 8 | 低重要度の欠陥 | 設計1 WS5（L3・L4）、設計3 Q1 | 空・逆転の範囲の拒否、retention の例外変換、未使用期限を縮めない |
| 9 | 「改ざん」の用語 | 設計1 WS2 の L1 | 鍵なしのハッシュ鎖は偶発的な破損・切り詰め・食い違いを検出する。悪意のある書き換えの防止はホストの責任。本書の文書（host-guide の format 2 の説明を含む）も直す |
| 10 | 文書 | 設計1 WS6・WS9、設計3 DOC、設計2 IMP-10 | エラー処理の節、配布物に無い文書への参照の解消、CHANGELOG の新設（0.0.3 の破壊的変更を含む） |
| 11 | 試験と検証ツール | 設計1 WS10・WS11、設計3 V1・V2 | 途中失敗の巻き戻し、property の seed、配布物の型宣言の利用者側の型検査 |
| 12 | LLM 評価の集計と予算 | 設計1 WS12 | 自己採点を除いた集計、予算の累積上限、有料コマンドの命名。有料 API は呼ばない |
| 13 | repository の分割 | 設計1 WS7、設計2 IMP-11、設計3 A3、本書 C3 | 最後に行う |

1〜9 はライブラリの版を 0.0.4 に上げて Eumenes に取り込む。Eumenes 側で必要になるのは vendor の更新だけの見込み（6 の開示範囲は Eumenes の単一 scope では変化なし）。

### 7.3 決めることが必要なもの

| # | 論点 | 食い違い | 推奨 |
|---|---|---|---|
| R1 | 墓標を principal ごとにするか | 設計1 D1 は「対応する（migration 0009）」、設計2 D3 は「単一 principal 前提を明記し、計画時の存在検査だけ（IMP-05 案A）」。どちらも利用者の決定と書いている | 設計2 の案A。Eumenes は単一 principal で、0009 は実 DB の表を作り直す。複数 principal を使う時点で 0009 |
| R2 | 置き換え前の旧版を本体が自動で忘れるか | 設計2 IMP-06（決定済み）は、本体が旧版を target に足し、63 件を超えると契約エラー。設計3 Q3 は、挙動を変えずにホストの責任と明記 | 設計3。Eumenes はすでに全版を target に渡している。IMP-06 を入れると、版の多い事実の忘却が target の並び順しだいで `ARRAY_TOO_LONG` になりうる（起動時の補完は ID の辞書順で渡すので当たる） |
| R3 | `applyForget` に `access` を足すか、足すならどの契約版か | 設計1 WS2（M3）は契約版 1 のまま必須にする。本書で Lifecycle は契約版 2 になった | 契約版 2 で必須にし、版 1 は従来どおり。0.0.4 と同時に Eumenes の呼び出しも直す |
| R4 | 参照ホスト実装を配布物に入れるか | 設計3 A1（D4 (a)）は同梱を推奨。本書 §4 は「Node 用アダプタは同梱しない」 | 入れない。唯一のホストの Eumenes は実装済み。2つ目のホストが現れた時点で再検討 |
| R5 | 実データの seed ファイル | 設計2 D5 案B（HEAD から削除）は決定済みで、合成 seed は用意された。削除はまだ | 削除する（履歴は書き換えない）。削除は利用者の確認後に行う |
| R6 | 追跡中の結果 JSON | 設計1 は Release へ移す、設計2 D6 は既存を維持して新規を入れない、設計3 D5 は HEAD から外す | 設計2（決定済みで、検査も入っている）。既存は RESULTS.md と試験が参照している |
| R7 | Eumenes の運用（稼働中の定期バックアップ、`db:restore`） | 設計1 §8.3。Eumenes 側の作業 | 別の作業として行う。本リポジトリの作業の後 |
| R8 | Eumenes の F4・F1（本書 D2） | 未決のまま | F1 の穴だけ先に直す（小さく、上書きの事故を防ぐ）。F4 は試験設計から |
