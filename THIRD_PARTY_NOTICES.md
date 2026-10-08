# THIRD_PARTY_NOTICES

本パッケージ（eumenes-memory、MIT）が参照・再実装した第三者の設計と、そのライセンス表示を記録する。
実行時依存はゼロ（`package.json` に `dependencies` なし）。

## SAAA personal-state-core（設計規則の再実装）

- 出典: SAAA リポジトリ、HEAD `28616e61ce5fe853383d4af6ec14e5b5d542c076`（読み取りのみで参照）
- ライセンス: MIT（crate とリポジトリの `LICENSE`）、"Copyright (c) 2026 SAAA contributors"
- 取り込み方式: **コードのコピーはしない**。Rust の規則を TypeScript で再実装し、移植した規則ごとにコード冒頭コメントへ
  出典（SAAA commit、ファイル:行）を記す（判断の記録: `spec/full-system-design.md` §5、`spec/rust-core-decision.md` は S3 担当が作成）。
- 製品 DB、資格情報、設定、実会話データ、SAAA の評価データ本文は取り込まない。

### 移植した規則の一覧（S3 以降の担当が追記する）

| 本パッケージの場所 | 規則 | SAAA の出典（commit:ファイル:行） | 備考 |
|---|---|---|---|
| （S0 時点では無し） | | | |

### ライセンス全文

```text
MIT License

Copyright (c) 2026 SAAA contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 移植した規則（S3）

SAAA HEAD `28616e61ce5fe853383d4af6ec14e5b5d542c076`、`crates/personal-state-core/src/reducer.rs`。コードは写さず規則を TypeScript で独自実装した。

| 移植した規則 | 本実装の場所 | 出典 |
|---|---|---|
| 遷移の結果が status を決める | `src/state/reducer.ts` | reducer.rs:104-114 |
| assert 以外の遷移は対象が既存で status が活きているときだけ許す | `src/state/reducer.ts` | reducer.rs:417-430 |
| 同 (kind, semanticKey) の active は 1 件 | `src/state/reducer.ts`、migration 0003 の部分 UNIQUE | reducer.rs:466-474 |
| より新しい根拠がある場合に古い根拠での置き換えを拒む（OLDER_EVIDENCE） | `src/state/reducer.ts`、`src/state/admission.ts` | reducer.rs:440-455 |
| supersede は同 kind・同 key の別 item のみ | `src/state/reducer.ts` | reducer.rs:476-495 |
| 依存の forget / invalidate は invalidated | reducer は遷移の許可のみ（確定書き込みは S6） | reducer.rs:127、reducer.rs:503-571 |

上記の全文は標準の MIT ライセンス文である。SAAA の `LICENSE` と差異がないか、規則を実際に移植する時点で原本と照合して確定する。
