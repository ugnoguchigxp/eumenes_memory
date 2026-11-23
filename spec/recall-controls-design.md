# 記憶の作り直しの部品（版 0.0.5、DB スキーマ版 10）

- 日付: 2026-11-22
- 状態: 実装済み。到達段階は C（契約）・I（実装）・F（fixture）・S（実 SQL）。H（Eumenes 結合）は未着手
- 利用者の合意: 2026-11-22（Eumenes 側の設計書 `eumenes/spec/memory-architecture-redesign-2026-11-22.md` の段 1・2・4・6 の前提）
- 0.0.6 で廃止: 候補の昇格・却下（`promoteCandidate` / `dismissCandidate`）、強度の減衰・強化（`decayStateStrength` / `reinforceStateStrength`）、自分の run を除く変更の照会（`hasMemoryChangesExcludingRun`）。使っていたホスト側の層が無くなったため。候補・強度の列と読み取り、忘却の閉包は残す。以下の表は 0.0.5 での設計の記録で、この 3 組の記述は上の廃止に読み替える
- 範囲: 本リポジトリの中核（`src/`）。記憶ホスト（`packages/host`）は触らない

本書は、Eumenes の記憶系の作り直しが記憶ライブラリに求める 8 つの部品の、実装した形と決めたことの記録。使い方は [host-guide.md](../docs/host-guide.md#recall-controls)。

## 1. 部品と公開操作

| # | 部品 | 公開操作（`eumenes-memory/sqlite`） | 永続物（migration 0010） |
|---|---|---|---|
| 1 | 即時の除外 | `planExclusion` / `applyExclusion` / `listExclusions`（`applyForget` と `reconcileForgetJournal` も format 3 を受ける） | `memory_exclusion`、journal format 3 |
| 2 | `sourceRunId` | `assertUserState` / `deactivateState` / `reactivateState` / `retractState` / `applyForget` / `applyExclusion` / `suppressState` の `sourceRunId` | `memory_change.source_run_id` |
| 3 | 二重の時間軸 | `listStateByTime`（`current` / `recordedAt` / `validAt`） | なし（`memory_state_event` の `at_ms` から導く） |
| 4 | 抑制 | `suppressState` / `releaseStateSuppression` / `listSuppressions`、`listState` の `suppressed`、`searchState` が印を付ける | `memory_suppression` |
| 5 | 記憶の候補（L1） | `recordCandidate` / `listCandidates` / `readCandidate`。忘却の閉包と `FORGET_TARGET_TYPES` の `candidate` | `memory_inferred_candidate`、`_evidence` |
| 6 | 根拠必須の検査 | `checkGroundedClaim`（純粋。`eumenes-memory` から） | なし |
| 7 | 置き換えの種類 | `assertUserState` の `change`、変更フィードの `changeKind` / `successorId` | `memory_change.change_kind` / `successor_id` |
| 8 | 順位の重み（強度） | `listState` / `searchState` の `minStrength` | `memory_state_item.strength` |

## 2. 決めたこと

| 論点 | 決定 | 理由 |
|---|---|---|
| 除外の journal | 忘却と同じ hash の鎖に format 3 の entry（`exclusionOp` = `exclude` / `release`）を載せる。`planExclusion` → ホストが追記・fsync → `applyExclusion` | 復旧の正本が journal だけなので、同じ鎖に載せれば `reconcileForgetJournal` が順に再現する。第二の journal をホストに増やさない。`memory_forget` にも 1 行入るので、鎖と DB の照合・receipt・`readForgetJournalHead` は変えずに動く |
| 除外の対象 | State item の ID と候補の ID だけ。事実（subject・kind・semanticKey）への除外は作らない | journal は消せない。semanticKey は本文に近い語を含みうるので、journal に入れない。全版は `readStateFact` で集めて渡す（忘却と同じ手順） |
| 除外の既定 | `listState`・`searchState`・`listStateByTime`・候補の照会は常に外す。`listState` の `includeExcluded: true` だけが、忘却の処理（全版・根拠の収集）用に返す（各 item に `excluded: true`）。`readStateFact` は外さない | 回答・文脈の材料に出ないことを既定にし、閉包削除の対象収集だけを例外にする |
| 除外の再適用 | 適用済み（seq <= head）の entry の再送は何もしない | 後の解除を打ち消さない。復旧は head より後の entry だけを順に適用する |
| 除外の解除 | 閉包削除が対象を墓標にした transaction で、対象の除外を消す（journal の再適用でも同じ結果になる）。それ以外は `release` の entry | 忘却が済めば印は不要。解除も journal に載るので、復元で古い除外が蘇らない |
| 変更フィードの拡張 | `memory_change` に省略可の 3 列。`MemoryChange` に省略可の `sourceRunId` / `changeKind` / `successorId` を足す。新しい target 種別・status は足さない | 既存の読み手を壊さない。除外・抑制は item の status を変えないので、`changeKind`（`excluded` ほか）で出す |
| 訂正と統合の区別 | `replaces` の置き換えの旧版の行に `changeKind`（`correction`〔既定〕/ `consolidation`）と `successorId` | 設計書 §9.1・§6.2。統合は参照の付け替え、訂正は「見直し中」にする |
| 統合と本人由来 | `change: "consolidation"` で、置き換え対象が `user_confirmed` / `user_edited` で本文が変わるなら `USER_TEXT_PROTECTED` | 本人の記録の本文は整理で書き換えない（§6.2）。本人が自分で直す訂正（既定）は通す |
| 時間軸 | 列を足さず、`memory_state_event` の `at_ms`（書き込み時にホストが渡した時計）から導く。`recordedAtMs` = 版を作った書き込み、`supersededAtMs` = 置き換え・撤回・無効化の書き込み（停止・紛争中は失効にしない） | 既存の版の履歴で表せる |
| 抑制 | item か事実（以後の新しい版にも効く）に付ける。journal には載せない。`listState` は既定で印を付けて返し（`suppressed: true`）、`suppressed: "omit"` で外す。`searchState` は常に印を付けて返す。事実・item が忘却されたら印も消える | 抑制は忘却ではなく可逆。既定を返す側にしたのは、忘却の処理（根拠の収集）が抑制された item を見落とさないため。`## Memory` を作る側が `omit` を渡す |
| 候補の同一性 | (subject, kind, semanticKey, polarity, text) が同じ open の候補は 1 件。観測の回数は distinct な根拠（出典の同じ範囲）の件数 | 再試行・読み直しで回数が増えない（冪等）。違う本文は別の候補 |
| 候補の根拠 | State と同じ検査（引用・出典の現在状態・墓標）。外部のメモは別の namespace の出典として同じ形で渡す。`trust`（external）は本体の語彙でないので、昇格を止める判断は呼び出し側 | 設計書 §4.5。出所の分類は host の `provenance` / `trust` に任せる |
| 候補の忘却 | 依存辺 `candidate → 出典`、昇格した item → candidate（`derived_from`）。出典・候補・scope の忘却で閉包に入り、値と根拠の行を消し墓標を書く。`FORGET_TARGET_TYPES` に `candidate` を足した | 設計書 §9.2 |
| 根拠必須の検査の適用 | 既存の `assertUserState` は元から引用つきの根拠が必須（変更なし）。新しい書き込み（候補の記録）は常に検査する。純粋な `checkGroundedClaim` を公開し、傾向（L4）など本体の外の書き込みもホストが同じ検査を使える | 既存の呼出しを壊さない |
| 傾向（L4）の表 | 本リポジトリでは作らない（設計書 §10 の対象外）。昇格の先は State | 傾向は Eumenes の既存の表のまま。移すときに別の版で足す |
| 強度 | `strength`（0〜1、既定 1）。item の値・revision・変更フィードには関わらない。閾値は `minStrength`（推定由来だけを外し、本人由来は常に残す）で、既定では適用しない。目安は `DEFAULT_WEAK_STRENGTH` | 既定の検索への適用は呼び出し側（`## Memory`・自動選択）が閾値を渡す。語を指定した直接の検索は渡さなければ引ける。ホストの `use`（外部由来の期限の延長）は別の仕組みで、触らない |
| journal の互換 | format 3 を書いた journal は、format 3 を読めない旧版の本体では開けない（format 2 のときと同じ） | 一度書いたら戻れないことを host-guide に書く |

## 3. 検証の段階

| 部品 | C | I | F | S | H | 試験 |
|---|---|---|---|---|---|---|
| 即時の除外 | ● | ● | ● | ● | — | fixture L35〜L38（entry の hash、混在の鎖、改ざん、format 3 の対象制限）、`src/domains/lifecycle/test/exclusion.test.ts`、`test/scenario/forget-closure.test.ts`（古い DB の復元 + journal の再適用で除外・解除を再現、閉包削除で印が消える） |
| `sourceRunId` | ● | ● | — | ● | — | `src/domains/state/test/recall-controls.test.ts` |
| 時間軸の照会 | ● | ● | — | ● | — | 同上 |
| 抑制 | ● | ● | — | ● | — | 同上、`exclusion.test.ts`（閉包削除で印と事実キーが消える） |
| 記憶の候補 | ● | ● | — | ● | — | `src/domains/state/test/candidates.test.ts`、`forget-closure.test.ts`（出典・候補・scope の忘却、復旧） |
| 根拠必須の検査 | ● | ● | — | ● | — | `recall-controls.test.ts`、`candidates.test.ts` |
| 強度 | ● | ● | — | ● | — | `recall-controls.test.ts` |
| migration 0010 | ● | ● | — | ● | — | `src/infrastructure/sqlite/test/recall-controls-migration.test.ts`（版 9 の DB の更新、既存の migration の本文が不変、CHECK と契約の一致） |

Eumenes への結合（H）は、取り込みの後に Eumenes 側の試験で確認する。実モデル評価は対象外（モデルを呼ばない部品）。
