#!/usr/bin/env python3
"""fixture の期待 digest を、ランタイム（TypeScript）とは独立に計算する補助。

  python3 scripts/fixture-digest.py print <fixture.json>
      expect.result (ready) から canonicalWithoutDigest / viewDigest /
      finalByteLength を計算して表示する。
  python3 scripts/fixture-digest.py fill <fixture.json>...
      同じ値を fixture に書き戻す（expect.result.viewDigest も更新）。
  python3 scripts/fixture-digest.py sha256 <text>
      文字列（UTF-8）の SHA-256 を表示する。

正規化は json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)。
ready view のキーはすべて ASCII のスキーマ名なので Python のキー順 (コードポイント順)
と JCS のキー順 (UTF-16 コード単位順) は一致する。
"""

import hashlib
import json
import sys


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def compute(view):
    body = {k: v for k, v in view.items() if k != "viewDigest"}
    canon = canonical(body)
    digest = sha256_hex(canon)
    final = dict(body, viewDigest=digest)
    return {
        "canonicalWithoutDigest": canon,
        "viewDigest": digest,
        "finalByteLength": len(canonical(final).encode("utf-8")),
        "finalUtf16Length": len(canonical(final).encode("utf-16-le")) // 2,
    }


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    mode = argv[1]
    if mode == "sha256":
        print(sha256_hex(argv[2]))
        return 0
    for path in argv[2:]:
        with open(path, encoding="utf-8") as handle:
            fixture = json.load(handle)
        expect = fixture["expect"]
        result = expect.get("result", {})
        if result.get("status") != "ready":
            continue
        values = compute(result)
        if mode == "print":
            print(path, json.dumps(values, ensure_ascii=False, indent=2))
        elif mode == "fill":
            result["viewDigest"] = values["viewDigest"]
            expect["canonicalWithoutDigest"] = values["canonicalWithoutDigest"]
            expect["finalByteLength"] = values["finalByteLength"]
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(fixture, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
        else:
            print(__doc__)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
