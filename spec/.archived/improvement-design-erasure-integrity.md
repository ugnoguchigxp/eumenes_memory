# 忘却の完全性と保持の整合 改善設計

作成日: 2026-11-06。基準コミット: `5504945`（本リポジトリ）、`2c2ac893`（Eumenes、読み取りのみ）。根拠は同日の多角評価（技術 76.6 / 運営 71.5）と、評価中に実行した再現試験2件。本書は計画であり、製品コードはまだ変えていない。

決定: 2026-11-06、利用者の指示により §2 の推奨案をすべて採用した（暫定。見直す場合は §2 を更新する）。

正直さの規律: 各項目の根拠を「再現済み」「コードの読解のみ（未再現）」で区別する。未再現の項目は、最初の作業として再現試験を書き、失敗を確認してから直す。

## 0. 目的・範囲・変えない原則

### 目的
1. 正しい形の入力であれば、どの形で出典を渡しても「忘却は派生先に届く」という中核の約束が守られるようにする（IMP-01、IMP-06）。
2. 永続の Records が、再生成資料の削除（evict）に巻き込まれないようにする（IMP-02）。
3. 古い DB の復元と reconcile の後も、正常な書き込みが例外で落ちないようにする。reconcile が、検証した値と同じ値を適用するようにする（IMP-03、IMP-04）。
4. 公開リポジトリの衛生、試験出力、文書を整える（IMP-07〜IMP-12）。

### 非目的
- 物理消去（SQLite の空きページ・WAL・バックアップ）の保証。既知の制限のまま。
- CI・npm 公開・署名。
- World / Consolidation の実装。
- 実 Eumenes 側の修正。追従が必要な点は §4 に書く。

### 変えない原則
- 実行時依存ゼロ。`src/` の衛生規則（`JSON.parse` / `Date` / `process` などの禁止、repository での transaction 制御の禁止）を守る。
- migration は追記専用。本書の推奨案は**スキーマを変えない**。
- 接続・transaction・時計・journal はホストが所有する。
- Eumenes が使わない機能は持たない。

## 1. 同日付の他の改善設計との関係

`spec/` には同日付の改善設計が他に2件ある（`improvement-design.md`、`improvement-design-2026-11-06.md`）。どちらも別の評価に基づく。本書の IMP-01・IMP-02・IMP-03・IMP-06 は、その2件に含まれていない。重なる項目は下表のとおりで、**実装前にどちらの案を採るかを決める**。

| 本書 | 他の設計 | 違い | 本書の決定 |
|---|---|---|---|
| IMP-04 seq の巻き戻りによる ID 衝突 | `improvement-design-2026-11-06.md` D3 / WS1-b（ID エポック、migration 0010） | 本書は ID 規則を変えずに衝突する seq を飛ばす。スキーマ変更なし | 本書の案を先に入れる。エポックは他の衝突経路が見つかった場合だけ |
| IMP-05 墓標の principal 境界 | 同 D1 / WS1（墓標を principal 別にする、migration 0009） | 本書は単一 principal 前提の明記と、計画時の存在検査（軽量案）。他の設計は完全対応 | 複数 principal を目標にするかで決める（D3） |
| IMP-08・IMP-09 リポジトリ衛生 | 同 D4 / WS13、`improvement-design.md` D1 | ほぼ同じ方針 | 統合して1回で行う |
| IMP-10 文書、IMP-11 repository の分割 | 同 WS7・WS9、`improvement-design.md` B2・C3 | 同じ方針 | 他の設計の作業として行う。本書の P0・P1 の後にする |

## 2. 決定事項

| ID | 論点 | 決定（推奨案を採用） | 不採用の代替案 |
|---|---|---|---|
| D1 | memory record の出典で `representation` が欠けている場合 | **`"text"` を補う**。`"text"` 以外は契約エラーにする。今成功している呼び出しを失敗にしない | 欠落も契約エラーにする（ホストの誤りが表に出るが、互換性を失う） |
| D2 | State の根拠に memory record を引用したとき、Records 表で照合するか | **照合する**。ホストが渡す本文を信じず、DB の現行 revision・digest・本文と一致させる | 照合しない（現状。存在しない record も引用できる） |
| D3 | 複数 principal に対応するか | Eumenes が単一 principal（`local:owner`）である間は、**単一 principal 前提を明記し、軽量案（IMP-05 案A）**にする | 墓標を principal 別にする（他の設計の WS1、案B） |
| D4 | state_item を忘れるとき、置き換え（supersede）前の旧版も忘れるか | **忘れる**。旧版を journal の target として明示的に記録する | 現状維持（旧版の値は残る）。この場合は既知の制限として文書化する |
| D5 | 公開リポジトリにある実会話由来の seed データ | **案B**（HEAD から削除し、合成 seed に置き換える） | 案A（意図した公開として維持し明記する）、案C（案B に加え履歴を書き換える。不可逆なので利用者が判断する） |
| D6 | 追跡している実験の生データ（19ファイル、約10 MiB） | **新しい生データは git に入れない**。既存のものは維持する（HEAD から消しても履歴は縮まないため） | 既存のものも HEAD から移す |

## 3. 改善項目

### P0（中核の約束に関わる。最初に行う）

#### IMP-01 memory record の出典キーを正規化する（再現済み）

**問題**: `representation` を省いた memory record の出典で State を保存すると、その record を忘れても State の値が残る。

経路:
- `src/contracts/parse-input.ts:47` は `representation` を任意として受ける。
- `src/contracts/source-key.ts:6` の `sourceKey` は、欠落を `null` として鍵にする（`["memory","record","rec:…",null]`）。
- `insertEvidence`（`src/domains/state/repository/index.ts:471`）は、その鍵で依存辺を作る。
- record の忘却が閉包を始める鍵は `"text"` 付きの `recordSourceKey` だけ（`src/domains/lifecycle/repository/index.ts:401`）。閉包の CTE は `dependency_id` を完全一致で照合するので、依存辺に届かない。

同じ鍵のずれがある箇所:
- retention の保護判定（`src/domains/records/repository/retention.ts:70`、evict の SQL `:262`）
- `recordIdOfSourceKey`（`src/domains/lifecycle/service/targets.ts:6`。正規表現が `"text"` 固定）
- `registerExternalDependents`（出典の鍵文字列をそのまま辺にする）

`hasTombstonedSource`（`state/repository/index.ts:659`）は record id でも照合している。鍵がずれうることは既に認識されていたが、閉包には同じ扱いが入っていない。

**影響**: Eumenes は常に `representation: "text"` を渡している（`api/domains/world/service/lifecycle-shared.ts:154`、`api/domains/memory/service/curation-evidence.ts:131`）。そのため、現行の実データでは発生していない見込み。ただし公開契約上は、正しい形の入力で忘却が黙って届かなくなる。

**設計**:

(a) 書き込み時の正規化（新しい旧形式の行を作らない）
- `src/contracts/source-key.ts` に、memory record の出典かを判定する `isMemoryRecordSource(ref)` を置く。条件は `namespace === MEMORY_SOURCE_NAMESPACE && kind === MEMORY_RECORD_SOURCE_KIND`。
- `readSourceCore`（`src/contracts/parse-input.ts`。`readSourceRef` 経由の呼び出しを含む）で、memory record の出典なら次のようにする（D1）。
  - `representation` が無ければ `MEMORY_RECORD_REPRESENTATION`（`"text"`）を補う。
  - 値が `"text"` 以外なら `fail("INVALID_VALUE", <path>.representation)`。
  - evidence の `source` と `sources[]` の両方が同じ関数を通るので、`findInputSource`（`state/service/evidence.ts:51`）の照合は一致したままになる。
- 鍵文字列を受ける入力で、`["memory","record",` で始まる文字列を正規化する `canonicalSourceKeyText(key, path)` を置く。対象は `planForget` の `host_source.sourceKey`（`lifecycle/service/parse.ts:73`）と、`registerExternalDependents` の `source` 依存（`lifecycle/service/external-parse.ts`）。
  - `"text"` の正規形はそのまま通す。
  - `null` の旧形式は `recordSourceKey(id)` に直す。
  - それ以外（他の representation や、空白を含む書式）は `INVALID_VALUE`。
  - memory 名前空間でも `record` 以外の kind（Eumenes の `["memory","state_item",…]` など）は対象外で、これまでどおり不透明な鍵として扱う。
  - 実装は正規表現だけで行い、`JSON.parse` は使わない。

(b) 読み取り時の同一視（既存の旧形式の行にも届かせる。migration は作らない）
- `src/domains/records/service/identity.ts` に `recordSourceKeys(recordId): readonly [canonical, legacy]` を置き、旧形式の鍵の組み立てをここ1か所にまとめる。
- 閉包の起点（`lifecycle/repository/index.ts:401`）に、両方の鍵を入れる。
- retention の `protectedSource` と evict の SQL で、両方の鍵を保護対象として照合する。evict の SQL の文字列連結（`:257-262`）は、同じ helper から作る。
- `recordIdOfSourceKey` は旧形式も record として認識する。これで、`scope` 忘却で record を他 scope に巻き込まない処理（`:373`）、`host_source` target の record への読み替え（`:300`）、古い journal の再適用が、旧形式でも正しく動く。journal の entry は hash の対象なので書き換えず、解決するときに読み替える。
- 実 DB に旧形式の辺があるかを確認する SQL を `docs/host-guide.md` に載せる。
  `SELECT COUNT(*) FROM memory_dependency WHERE dependency_type='source' AND dependency_id LIKE '["memory","record",%,null]'`

(c) Records 表での照合（D2 により採用）
- `checkUserEvidence`（`state/repository/index.ts:674`）で、memory record の出典ごとに次を確かめる。
  - 同じ principal の record であること。
  - その scope が `access.scopeKeys` に含まれ、status が active であること。
  - `ref.revision` と `ref.digest` が現行の revision と一致すること。
  - 対応する `sources[]` の本文が、保存された本文と一致すること。
- 失敗したときは既存の reasonCode を使う（契約の型は変えない）。
  - 忘却済み: `SOURCE_TOMBSTONED`
  - 存在しない、または権限が無い: `EVIDENCE_NOT_IN_INPUT`（存在の有無を漏らさない）
  - revision・digest・本文の不一致: `SOURCE_STALE`
- State から Records への依存は、既に許可されている（`scripts/domains.ts` の `state.dependencies`）。

**試験**:
- `src/domains/state/test/state.test.ts`
  - `representation` を省いた record の出典を保存すると、evidence の `representation` が `"text"` になり、依存辺が `recordSourceKey` になる。
  - `"html"` を渡すと `MemoryContractError(INVALID_VALUE)` になる。
- `test/scenario/forget-closure.test.ts`
  - 上の item が record の忘却で `forgotten` になり、`tablesContain` で値がどの表にも残らない。
  - 旧形式の辺を SQL で直接挿入した DB でも、record の忘却が届く。evict は `blocked` になる。`scope` 忘却では record として扱われる。
- lifecycle の external 試験: 旧形式の鍵は正規化されて登録される。忘却すると `pending` になる。不正な書式は `INVALID_VALUE`。
- `test/scenario/forget-property.test.ts`: 生成器の evidence に `representation` 省略の出典を混ぜる。oracle は変えない。
- `test/scenario/prototype-pollution.test.ts`: 継承した `representation` が補完の判定に影響しない。
- D2: 存在しない record、古い revision、本文の不一致、他 scope の record の引用が、それぞれ上記の reasonCode になる。

**完了条件**: 付録A-1 の試験で、State が `forgotten` になり値が残らない。既存の試験がすべて通る。

#### IMP-02 retention 中の origin への `captureRecord` を拒否する（再現済み）

**問題**: 次の順で呼ぶと、永続のつもりで保存した record が、本文・revision ごと墓標なしで削除される。

1. `retainRecord(origin O)`
2. `captureRecord(O, 永続データ)`
3. `evictRetainedRecords`

`captureRecord`（`src/domains/records/repository/index.ts:217`）が `memory_record_retention` を見ないため。逆方向（capture 済みの origin への retain）は `retainRecord`（`retention.ts:113-124`）が拒否している。

**影響**: Eumenes は `captureRecord` を直接呼んでいない。`api/` 内の呼び出しは `retainRecord` だけ（`api/domains/web-research/service/cache.ts:254`）なので、現行の実害は無い。

**設計**:
- `captureRecord` の本体を、非公開の `captureRecordUnchecked` に移す。`retainRecord` はこれを呼ぶ。
- 公開の `captureRecord` は、scope と墓標の検査の後で、retention の行があれば `fail("INVALID_VALUE", "$.origin")` を投げる。逆方向の `retainRecord`（`$.record.origin`）と対称の契約エラーにする。
  - 結果型（`RecordBlockedReasonCode`）は増やさない。union に値を足すと、ホストの網羅的な switch を壊すため。
- `docs/host-guide.md` の「再生成資料と容量」に次を書く。「retain した origin は `captureRecord` で永続化できない。永続化するときは、`evictRetainedRecords` に `recordId` を指定して失効させてから `captureRecord` する」。
- 不採用の案: capture 時に retention の行を消して永続へ昇格させる。retention は旧 revision を既に剪定しており、昇格の意図も呼び出しから読み取れないため。

**試験**（`test/consumer/retention.test.ts`）:
- retain の後の capture は `INVALID_VALUE` を投げ、record・本文・revision の件数が変わらない。
- `recordId` を指定して evict した後の capture は成功する。その後の `oldest` の evict では削除されない。
- 既存の retain の試験はすべて通る。

**完了条件**: 付録A-2 の試験で、retention 中の capture が契約エラーになる。失効後に永続化した record が、その後の evict の後も残る（`memory_record` が 1 件）。

### P1（復元と入力境界の堅牢化）

#### IMP-03 reconcile の entry を厳格な parser に通す（コードの読解のみ）

**問題**:
- `parseReconcileForgetJournalInput`（`src/domains/lifecycle/service/parse.ts:230-256`）は、`entries` を parse も freeze もせずに返す。
- 鎖の検証に使う `isSelfConsistent`（`lifecycle/service/journal.ts:103`）は形の検査が緩い。空でない文字列かどうかしか見ず、長さの上限・制御文字・余分なキーを検査しない。
- `applyEntry` は同じ生のオブジェクトを使う。そのため、getter や Proxy の entry では、検証した値と適用する値が食い違いうる。
- target の余分なキーは、`canonicalJson({targets})` を経由して `request_json` に入る。
- 一方、`applyForget` は `readJournalEntry`（`parse.ts:122`）で厳格に読んでいる。

**設計**:
- `parseReconcileForgetJournalInput` で、各 entry を `readJournalEntry(entry, "$.entries[i]")` で読み、`deepFreeze` した写しを返す。
- 結果の契約は変えない。entry の形が不正なとき、これまでどおり `{status:"inconsistent", reasonCode:"JOURNAL_CHAIN_BROKEN"}` を返す。
  - parse 関数は `{ ok: true, entries } | { ok: false }` を返す。entry 部分の `MemoryContractError` だけをここで受け止める。
  - 外側の不正（`contractVersion`、`clock`、配列でない、件数超過）は、従来どおり契約エラーとして投げる。
- `verifyForgetJournal` と `applyEntry` には、freeze した写しだけを渡す。
- 性能: 上限の 100,000 entry を parse する時間を試験で一度測り、起動時の処理として許容できるかを記録する。

**試験**（`src/domains/lifecycle/test/journal.test.ts`）:
- 読むたびに値が変わる getter の entry は `inconsistent` になり、DB を変えない。
- target に余分なキーがある entry は `inconsistent` になる。
- `principal` が上限を超える entry は `inconsistent` になる。
- 既存の reconcile の試験はすべて通る。

#### IMP-04 復元で seq が巻き戻った後の ID 衝突を避ける（コードの読解のみ）

**問題**:
- State item の ID は `H(principal, scope, createdSeq)`（`src/domains/state/service/ids.ts:9`）。
- 古い DB を復元すると `memory_seq` が巻き戻る。reconcile は、復元で失われた期間に作られて忘れられた item の ID に、墓標を付け直す。行の無い ID への墓標は許されている（`lifecycle/repository/index.ts:432` の注記）。
- その後の `assertUserState` が同じ seq に達すると、同じ ID を計算する。すると trigger `memory_state_item_no_resurrection`（`state/migrations/0003-state.ts:62`）が中断する。
- ホストには結果ではなく、`MemoryStoreError(TOMBSTONED)` が投げられ、ユーザーの訂正の保存が失敗する。

**設計**（採用。ID 規則とスキーマは変えない）:
- State の repository に `issueItemSeq(db, principal, scopeKey, seq)` を置く。
  - `stateItemId` が墓標付きである間は `issueSeq` で次の seq を発行し、墓標の無い `{seq, itemId}` を返す。
  - 1回の操作が作る item は高々1件なので、item を作る経路（`assertUserState` の identity を組み立てる箇所、`index.ts:744-750`）だけに入れる。
  - `ctx.seq` には返った seq を使い、`created_seq` が ID の規則（作成した操作の seq）と一致するようにする。
- 停止性: 1回の反復で seq を1つ消費する。衝突する回数は、state_item の墓標の件数を超えない。
- 代替案: ID エポック（他の設計の WS1-b）。ID の規則とスキーマが変わるので、seq を飛ばす方式で足りない衝突経路が見つかった場合だけにする。

**試験**（`test/scenario/forget.test.ts` の復元シナリオに追加）:
1. 複製を取る（`snapshotTo`）。
2. item X を保存し、journal を通して X を忘れる。
3. 複製を復元して reconcile する。
4. 新しい事実を保存すると `applied` になり、`itemId` が X と異なり、X の墓標が残っている。
- 変更フィードの seq が単調に増えることも確かめる。
- 最初に「修正前は例外で失敗する」ことを確認する。

#### IMP-05 墓標の principal 境界を明確にする（コードの読解のみ。D3 に従う）

**問題**:
- 墓標の主キーは `(target_type, target_id)` で全体共有。`isTombstoned`（`src/infrastructure/sqlite/tombstone.ts:8`）も principal で絞らない。
- `hasForeignTarget`（`lifecycle/repository/index.ts:436`）は、行がまだ無い ID を許す。

複数 principal のホストでは、次が起こりうる。
1. principal A が、B の将来の state_item ID（principal・scope・全体の seq から推測できる）に墓標を付け、B の書き込みを妨げる。IMP-04 の後は、seq を1つ飛ばすだけの影響になる。
2. A が `host_source` の鍵に墓標を付けると、B はその出典を根拠に使えなくなる（`SOURCE_TOMBSTONED`）。

Eumenes は単一 principal（`api/domains/conversation/contracts/index.ts:42`）なので、現行の影響は無い。

**案A（D3 により採用）**:
- `planForget` の `state_item` target は、行が存在し、principal と scope が一致することを必須にする。満たさないときは `{status:"blocked", reasonCode:"SCOPE_NOT_PERMITTED"}` を返し、存在の有無を漏らさない。
  - 忘却済みの行も残っている（status `forgotten`）ので、同じ item を再び忘れる操作は冪等のまま。
  - `applyEntry` と reconcile は、復元のために行の無い ID を許す現状を維持する。
- `docs/host-guide.md` に次を明記する。
  - `host_source` の鍵はホスト全体の識別子である。principal がその出典を所有しているかの確認はホストの責任。
  - 本体は単一 principal を前提に検証している。
  - `applyForget` には `planForget` が返した entry だけを渡す。

**案B（不採用）**: 他の設計の WS1（墓標を principal 別にする migration）。複数 principal を目標にした時点で再検討する。

**試験**（案A）: 存在しない ID、他 principal の ID、他 scope の ID はいずれも `blocked` になる。忘却済みの自分の item の再計画は成功する。

#### IMP-06 置き換え前の旧版も忘れる（コードの読解のみ。D4 に従う）

**問題**:
- 置き換えでは、旧 item を `superseded` にして新 item を作る（`src/domains/state/service/reducer.ts:169`）。旧版と新版のつながりは、同じ `(subject, kind, semantic_key)` であることしかない。
- `scrubStateItem`（`state/repository/index.ts:1001`）は対象の item だけを消す。そのため、現在の値を `state_item` target で忘れても、旧版の `value_text` が残る。
- `listState` は status を指定すれば `superseded` も返す（`:897`）。

**設計**（D4 により採用）:
- `planForget` で、`state_item` target と同じ principal・scope・subject・kind・semantic_key を持ち、status が `superseded` で、`created_seq` が target より小さい item を、**journal entry の target として明示的に加える**。
  - 解決時に自動で広げる方式は採らない。古い DB を復元すると旧版が active に戻っている場合があり、entry に記録しないと reconcile で届かないため。
  - 対象は `superseded` だけにする。`retracted` などは、本人が撤回した別の事実として扱う。
- target の上限は 64（`LIMITS_LIFECYCLE.maxJournalTargets`）。旧版が 63 件を超える場合は、既存の契約エラー `ARRAY_TOO_LONG` とする。ホストは古い旧版を個別に忘れてから、もう一度計画する。実データでの旧版の件数は要確認。
- plan の `closure.counts` に旧版の件数が出るので、ホストは「履歴 N 件も忘れる」と表示できる。

**試験**:
- 「コーヒー」を保存し、「紅茶」で置き換え、「紅茶」を忘れる。旧版も `forgotten` になり、値が表に残らない。
- 置き換え前の複製を復元して reconcile しても、「コーヒー」が `forgotten` になる。
- 旧版が 64 件以上なら `ARRAY_TOO_LONG` になる。

### P2（衛生・文書・運用）

#### IMP-07 試験出力のノイズを無くす
- `examples/quality/answers.ts:1001` の進捗出力（`console.log({crossJudged,…})`）を、`onProgress` の注入に変える。CLI の既定は `console.log`、試験は何もしない関数を渡す。
- 完了条件: `bun test` の出力に `crossJudged` の行が出ない。

#### IMP-08 実験の生データの置き場所（D6）
- 現状: `examples/*/results/` で19ファイル・約10 MiB を追跡している。最大は 3.7 MB（`examples/standalone/results/2026-10-16-structured-review.json`）。`RESULTS.md` と `test/examples/standalone.test.ts:825` から参照されている。
- 今後の実行では、生データを `verification-reports/`（git の対象外）に保存し、git には要約 JSON と、生データの sha256 一覧だけを入れる。
- `test/tooling.test.ts` に、追跡ファイルのサイズ上限（例: 512 KiB、既存のファイルは許可リスト）の検査を足し、大きな生データが再び入るのを防ぐ。

#### IMP-09 公開 seed データ（D5）
- 現状: `examples/seeds/data/codex-user-50.jsonl` には、Codex 会話でのご本人の発言原文、ローカルの絶対パス（`/Users/…/.codex/sessions/…`）、thread / message ID が入っている。公開リポジトリの main に push 済み（`f0357dc`）。秘密鍵の類は検出されなかった。
- 案B の作業:
  1. 合成の seed（同じ件数・分類・形式）を作る。
  2. `test/examples/seeds.test.ts` の期待値を合成データに合わせて作り直す。
  3. 実データのファイルを HEAD から削除する。
  4. seed を作る処理（`examples/seeds/import.ts`）で、`source_path` をハッシュかファイル名だけにする。
- `spec/reviews/*` と `examples/*/results` にも `/Users/…` のパスがある。新しく出力するものは相対パスにする。
- 案C（履歴の書き換えと force push）は不可逆なので、本書の作業には含めない。

#### IMP-10 文書
- `docs/host-guide.md` に、IMP-01・02・04・05 の挙動、旧形式の検出 SQL、単一 principal 前提を足す。
- `spec/verification-status.md` の該当行を更新する。
- README の整理（利用者向けと開発者向けの分離）は、他の設計の B2 / WS9 として行う。

#### IMP-11 大きな repository の分割
- 他の設計の C3 / WS7 として、本書の P0・P1 の後に行う。同じファイルを触るため、先に分割すると P0・P1 の差分が読みにくくなる。

#### IMP-12 運用
- 1項目1変更の単位で、ブランチと PR を使って入れる（現在は main へ直接コミットしており、1コミットが大きい）。
- 評点は観察の要約として扱い、目標値にしない。完了は試験と受入条件で判定する。

## 4. 公開契約・スキーマ・Eumenes への影響

| 項目 | 型 | 挙動の変化 | 契約版 | スキーマ | Eumenes への影響 |
|---|---|---|---|---|---|
| IMP-01 (a)(b) | 変更なし | memory record の出典の `representation` を補う。`"text"` 以外と、memory record の鍵の不正な書式は契約エラー | 据え置き | なし | なし（常に `"text"` を渡している） |
| IMP-01 (c) | 変更なし | 既存の reasonCode を返す条件が増える | 据え置き | なし | 要確認（State の根拠に memory record を使っていないことを、`api/domains/memory/service/curation-*.ts` で確かめる） |
| IMP-02 | 変更なし | retention 中の origin への `captureRecord` が契約エラーになる | 据え置き | なし | なし（`captureRecord` を呼んでいない） |
| IMP-03 | 変更なし | 形の不正な entry を `inconsistent` として検出する範囲が広がる | 据え置き | なし | なし（自分の writer が書いた entry） |
| IMP-04 | 変更なし | 復元後の衝突で、例外の代わりに次の seq を使う | 据え置き | なし | 改善のみ |
| IMP-05 案A | 変更なし | 存在しない `state_item` の計画が `blocked` になる | 据え置き | なし | 要確認（存在しない ID を忘れる経路の有無） |
| IMP-06 | 変更なし | entry の `targets` が複数になりうる | 据え置き | なし | 要確認（journal・receipt の表示が複数の target を扱えるか。`forget.ts`） |

## 5. 実施順と担当範囲

1. **再現試験を先に入れる**。IMP-01・02 は付録Aの試験を、IMP-03・04 は上記の試験を、修正前に失敗することを確認して追加する。
2. IMP-01 → IMP-02 → IMP-03 → IMP-04 → IMP-05（案A）→ IMP-06 の順に直す。
3. P2 を行う。IMP-07〜09 は `examples/`・`test/examples/`・`test/tooling.test.ts` だけを触り、P0・P1 と書込み範囲が重ならないので、並行して進めてよい。
4. 文書（IMP-10）と分割（IMP-11）は最後に行う。

P0・P1 は1人の実装者が順に行う。書込み範囲が重なるため（`lifecycle/repository/index.ts` は IMP-01・05・06、`retention.ts` は IMP-01・02）。他の2件の設計も同じファイルを変えるので、**着手前に3件の計画を一つの順序にまとめる**。

## 6. 全体の受け入れ条件

- `bun run verify:all` と `bun run verify:package` が通る。
- 追加した再現試験は、修正前に失敗し、修正後に通る（それぞれの結果を `verification-reports/` に記録する）。
- 実行時依存ゼロと `src/` の衛生規則（`test/src-hygiene.test.ts`）を維持する。スキーマ版は 8 のまま。
- `docs/host-guide.md` と `spec/verification-status.md` が実装と一致する。
- 推奨案では、Eumenes の現行の呼び出しに挙動の変化が無い。配布 tgz を Eumenes の memory 試験で確かめることを推奨するが、これはこのリポジトリの外の作業になる。

## 7. リスクと未確認事項

- IMP-03〜06 はコードの読解による指摘で、まだ再現していない。再現しない場合は、その項目を取り下げて記録する。
- 実 DB に旧形式の辺があるかは未確認。§3 IMP-01 (b) の SQL で確かめる。
- IMP-06 は「忘れる」の意味を広げる変更になる。ユーザーの期待（履歴も消える）と一致するかを、D4 で確認する。
- IMP-01 (c) は、ホストが本文を加工して渡している場合、これまで成功していた保存を `SOURCE_STALE` にしうる。

## 付録A 再現試験（評価時に実行し、記述どおりの結果を確認した）

`test/scenario/` に置く想定で、import は相対パスにしている。修正前は、末尾の期待値で失敗する。

### A-1 IMP-01

```ts
import { expect, test } from "bun:test";
import { assertUserState } from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import { accessFor, capture, forgetRecord } from "../runners/records-support.ts";

test("record evidence without representation is reached by record forget", () => {
	const s = openTestStore();
	const content = "the secret is hunter2 ok";
	const c = capture(s, { origin: "o1", content });
	const at = content.indexOf("hunter2");
	const { representation: _omit, ...ref } = c.ref;
	const written = s.write((db) =>
		assertUserState(db, {
			contractVersion: 1, access: accessFor(), scopeKey: "scope:a", clock: { atMs: 5 },
			kind: "preference", subject: "self", semanticKey: "k",
			value: { text: "hunter2", polarity: "affirmed" },
			evidence: [{ source: { ...ref, range: { startByte: at, endByte: at + 7 } }, quote: "hunter2" }],
			sources: [{ ...ref, principal: "local:owner", scopeKey: "scope:a", status: "available", content, ordinal: 1 }],
			origin: "user_confirmed",
		}),
	);
	expect(written.status).toBe("applied");
	forgetRecord(s, { type: "record", recordId: c.recordId, scopeKey: "scope:a" });
	// 修正前: [{ status: "active", value_text: "hunter2" }]
	expect(s.writer.query("SELECT status, value_text FROM memory_state_item").all())
		.toEqual([{ status: "forgotten", value_text: null }]);
	s.close();
});
```

### A-2 IMP-02

```ts
import { expect, test } from "bun:test";
import { evictRetainedRecords, retainRecord } from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import { accessFor, capture } from "../runners/records-support.ts";

test("durable capture over a retained origin is refused", () => {
	const s = openTestStore();
	const record = {
		contractVersion: 1, access: accessFor(), scopeKey: "scope:a", clock: { atMs: 10 },
		origin: { namespace: "web", kind: "page", id: "o1" },
		mediaType: "text/plain", content: "cache", captureState: "complete",
	} as const;
	const retained = s.write((db) => retainRecord(db, { record, freshUntilMs: 100, idleTtlMs: 50 }));
	// 修正前: 成功し、永続のつもりの本文が retention の対象のまま残る
	expect(() => capture(s, { origin: "o1", content: "durable user data", atMs: 20 })).toThrow();
	const evict = (extra: object) =>
		s.write((db) =>
			evictRetainedRecords(db, {
				contractVersion: 1, access: accessFor(), scopeKey: "scope:a", clock: { atMs: 1000 }, limit: 10, ...extra,
			}),
		);
	// 失効させてから永続化すると、その後の evict に巻き込まれない
	evict({ recordId: (retained as { recordId: string }).recordId });
	capture(s, { origin: "o1", content: "durable user data", atMs: 30 });
	evict({ oldest: true });
	expect(s.writer.query("SELECT COUNT(*) AS n FROM memory_record").get()).toEqual({ n: 1 });
	s.close();
});
```

付録の試験は、評価時の再現コードの意味を変えずに、置き場所に合わせて書き直したもの。型の都合で調整が要る場合は、期待値を弱めずに入力の書き方だけを直す。
