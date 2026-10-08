# Rust `personal-state-core` の扱い: 決定

2026-10-08 / S3（State 台帳）担当が記録。設計の背景は [full-system-design.md](full-system-design.md) §5。

## 決定

**A（TypeScript 独自実装）を採用する。Rust コア（SAAA `crates/personal-state-core`）は参照仕様として扱い、取り込まない。**

比較 spike（案 B: wasm32 にビルドして Bun で同期 instantiate し、同じ fixture を流す）は**実施していない**。
この環境に wasm32 ターゲット（`wasm32-unknown-unknown`）が導入されておらず、ユーザー決定（verification-status §6）でも
Rust spike は行わないことになっているため。したがって「B の方が良い／悪い」という実測の主張はしない。
以下の根拠は、Rust コアの読み取り（コードの読解）と本設計の要件の突き合わせだけに基づく。

## 根拠

1. **履歴全ロード（F02）**。Rust コアは全遷移をメモリ上の `Ledger` に保持し、status を replay で導出する
   （`model.rs`、`reducer.rs:92-155`）。本設計は共有 SQLite 上で `(principal, scope_key)` 始まりの index により
   scope 限定の行だけを読み書きする。B を採ると呼び出しごとに DB から `Ledger` を再構成して渡すことになり、
   スコープ外の全履歴を読む F02 の問題を再導入する。
2. **概念が無い**。Rust コアには次の概念が無い（どの案でも新規実装が必要）:
   - `subject`（self / 他人）と、`kind = other_person_note ⇔ subject が other:*` の同値、
   - 根拠の `quote`（出典 range の bytes との完全一致検査）と、その文字境界検査、
   - modality（asserted / hypothetical / quoted / reported / question）と括弧内引用の扱い、
   - host 所有の kind（goal / decision / open_question）の除外、kind ごとの admission policy、
   - 「仮定」（hypothetical）を事実にしない規則。
3. **同期 transaction 内で動く必要**。A は追加の非同期初期化・ビルド成果物なしで、ホストの `store.write` の同期 op の中で呼べる。
4. **検証様式の継続**。M0 で確立した「依存ゼロ・手書き検査・言語非依存 fixture」をそのまま使える
   （`fixtures/state/` S01–S20 と `fixtures/admission/` A01–A50 が正本。期待値は手書き）。
5. **ライセンス**。SAAA は MIT のため規則の移植は可能。コードはコピーせず、移植した規則ごとにコード冒頭コメントと
   fixture の `provenance` に出典（commit `28616e61ce5fe853383d4af6ec14e5b5d542c076`、ファイル:行）を残した。
   一覧は `THIRD_PARTY_NOTICES.md` に置く。

## 移植した規則（SAAA の出典）

| 規則 | 本実装の場所 | SAAA の出典 |
|---|---|---|
| 遷移の結果が status を決める（assert → active、dispute → disputed、supersede → superseded、retract → retracted、invalidate → invalidated） | `src/state/reducer.ts` | `reducer.rs:104-114` |
| assert 以外の遷移は、対象が既存で status が活きているときだけ許す | `src/state/reducer.ts` | `reducer.rs:417-430` |
| 同じ (kind, semanticKey) の active は 1 件（衝突は拒否） | `src/state/reducer.ts`、0003 の一意 index | `reducer.rs:466-474` |
| より新しい根拠を持つ item がある場合、古い根拠での置き換えを拒む | `src/state/reducer.ts`、`src/state/admission.ts`（`OLDER_EVIDENCE`） | `reducer.rs:440-455` |
| supersede は同 kind・同 key の別 item への置き換えだけ許し、自分自身を拒む | `src/state/reducer.ts` | `reducer.rs:476-495` |
| 依存が forget / invalidate された item は invalidated | `src/state/reducer.ts`（遷移の許可）。確定書き込みは S6 の閉包 | `reducer.rs:127`、`reducer.rs:503-571` |

本設計独自（SAAA に無い）: CAS（expectedRevision）、subject と kind の同値検査、`evidenceOrdinal` による新旧判定、
明示操作が新旧比較を受けないこと、根拠の新旧が同じで値が違うときの dispute、deactivate / reactivate（可逆）、
Admission 規則表、quote / 括弧内引用の検査。

## 再検討の条件

案 A が共有 fixture（S01–S20、A01–A50）を通せなくなった場合、または Eumenes 側で wasm の同期 instantiate を許容する
ビルド経路ができて、かつ上の根拠 1・2 が解消された場合のみ。解消されない限り A を維持する。
