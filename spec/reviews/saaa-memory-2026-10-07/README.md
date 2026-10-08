# 評価証拠の保管場所

2026-10-07、ユーザーの指示により `eumenes/spec/reviews/saaa-memory-2026-10-07` から本ディレクトリへ移動した。移動した全証拠ファイルの SHA-256 一致を確認した。

実行レポート・台帳・snapshot に含まれるパスと cwd は、実際に検証した当時の Eumenes / SAAA の場所を表す。移動に合わせて履歴を書き換えていない。新しい Memory ライブラリを検証した記録ではない。

再現スクリプトは `eumenes_memory` を cwd として、次のように実行できる:

```sh
python3 spec/reviews/saaa-memory-2026-10-07/records_restore_probe.py /Users/y.noguchi/Code/SAAA
```

SAAA ソースのスキーマと認可 SQL を読み、メモリー内 SQLite だけに書き込む。現在の SAAA が評価 snapshot と変わっていれば結果も変わり得る。再実行結果は歴史的な証拠を上書きせず別ファイルへ記録する。
