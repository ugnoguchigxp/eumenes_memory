# M0 公開契約

2026-10-07 / 初期実装仕様。正本は本リポジトリ。M0 は取得済みデータを処理する同期ライブラリとし、DB・モデル・ネットワーク・時計・乱数を内部から使わない。

## 1. 入力と信頼境界

`buildMemoryView` は `schemaVersion: 1`、`access`、`snapshot`、`maxBytes`、`enabled` を受け取る。利用側が snapshot を同一時点の整合した読み取りから構成する。型検証で認証そのものは成立しない。クライアントやモデルが作った access を認証済みとして通さないのはホストの責任。

| データ | 必須の内容 |
|---|---|
| AccessContext | principal、許可された scopeKeys、用途 purpose、policyRevision |
| Snapshot | principal、対象 scopeKey、stateRevision、policyRevision、完全性 complete、sources、items |
| SourceRef | namespace、kind、id、revision、digest、任意の representation と半開区間の UTF-8 byte range |
| SourceState | SourceRef、principal、scopeKey、status: available / missing / changed / forgotten、引用範囲を確認する場合の本文 |
| MemoryItem | 名前空間付き item ID、revision、kind、text、status、origin、primarySource、dependencies |

最初の kind は `goal / decision / open_question`、status は `active / inactive`、origin は `user_confirmed / user_edited`。M0 の入力はユーザー確定の Continuity 相当だけとし、抽出候補や外部観測の自動採用を実装しない。後続で種類を増やす場合は契約と受入ケースを更新する。

revision はホストが発行する不透明な非空文字列。大小比較や数値化は行わず一致だけを判定する。原文に revision がなければ、ホストが内容 digest に基づく安定した版を発行する。stateRevision と source revision は別々に比較する。

digest は SHA-256 の小文字 hex。source digest の対象はその representation 全体の UTF-8 bytes とし、range は同じ表現内の `[startByte, endByte)`。範囲だけの digest と混同しない。本文を渡す場合は digest と実 bytes を検査する。本文なしの参照はホストによる検証済み SourceState として受け取るが、range がある場合は本文を要求し、文字境界・範囲・digest を検査する。

M0 で一つの view が使うのは同一 principal・同一 scopeKey の情報。複数 scope の合成は後続。item の原文とすべての dependencies を必要とし、primarySource も依存に含める。引用されていない入力も依存から落とさない。

## 2. 構成規則

入力 schema と上限を検査し、不正な型、未知の schemaVersion、ID の重複、同一参照の相反する状態を明示エラーにする。個数・文字列長などの入力上限を実装定数として文書化し、上限の境界を試験する。これはホストの認可検証の代用ではない。

正常な入力について以下の順に判定する:

1. enabled が false なら本文を含まない `disabled`。
2. principal、scope の許可、policyRevision が不一致、または complete が false なら本文を含まない `blocked`。
3. active な項目の原文と dependencies がすべて available で、指定の版・digest と一致することを確認。欠落・変更・忘却・許可外は `blocked`。
4. inactive を除外し、項目 ID のコード単位順で固定順序にする。locale に依存させない。
5. ready の構造を組み立て、JSON の UTF-8 bytes が maxBytes を超えたら本文を含まない `overflow`。M0 の active 項目はすべて必須で、一部だけを選んで成功としない。

空の complete snapshot は空の `ready`。空と取得失敗を混同しない。入力を変更せず、同じ入力の再実行で同じ結果を返す。

## 3. 出力

すべての結果は schemaVersion、status、principal、scopeKey、stateRevision、policyRevision、`instructionAuthority: none` を持つ。`blocked / overflow / disabled` は内容を持たず、機械判定可能な reasonCode を返す。エラー文や reasonCode に原文を埋め込まない。

`ready` は items、参照の完全な dependencies、coverage、viewDigest を持つ。M0 の coverage は complete を明示し、omitted は空。将来の任意 evidence の省略と、必須状態の不足を区別できるようにする。

viewDigest は view の内容・版・scope・依存・authority を含む決定的な JSON 表現の SHA-256。digest 自身をハッシュ対象から除き、キー順と配列の正規化規則を実装・fixture に固定する。利用側から渡された digest を盲信せず、再検証時に再計算する。ランダムな viewId をコア内で発行しない。

maxBytes は非負の安全な整数。予算判定は viewDigest を含む最終 ready JSON 全体に適用する。本文だけのサイズで判定しない。

## 4. 再検証

`validateMemoryView(view, current)` の current は、ホストが読み直した AccessContext と完全な Snapshot。ready 以外の view は採用可能としない。

- viewDigest が内容と一致すること。
- principal、scope、用途、policyRevision、stateRevision が view の取得条件と一致すること。用途も view の取得条件に保存する。
- 参照した item の revision、status、内容・由来・原文参照が変わっていないこと。
- すべての source dependencies が available で、版・digest・範囲・許可が一致すること。
- 不完全な current は利用不可とすること。

成功は `valid`、それ以外は `invalid` と reasonCode。版が変わったのに本文が同じ場合も初期版では invalid とする。無関係な項目の追加で stateRevision が変わった場合も安全側に無効化してよい。

コアは queue の attempt / lease を検証しない。ホストが同一採用トランザクション内で検査する。コアへの current の供給と回答保存の間に変更が割り込まないこともホストの責任。

## 5. 利用記録と後続の契約

Eumenes 側の UsageReceipt は runId、attempt、package/schema version、viewDigest、実際にモデルへ渡した source/item の版、採用検証結果を記録する。モデル内部で何を参照したかを証明するものではない。原文本文を receipt に重複保存しない。

Invalidation の event/cursor、ForgetReceipt、SourceReader の非同期ポート、Records の永続化 API は M0 の実装対象外。ただし source の missing / changed / forgotten を利用不可とする契約を後続でも維持する。本文を消さず履歴を残す deactivate を、忘却完了と呼ばない。

将来の抽出候補・外部資料の本文は参照データ。`instructionAuthority: none` の文字列だけで prompt injection が防げるとは扱わない。ツール権限と指示の優先順位はホストが制御する。
