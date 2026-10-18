"""Prove the edit strategy: surgical byte-level replacement, no reserialization.

Two things get checked here:

1. The real line endings / indent of SaveGame.db (the previous probe had a
   double-escaping bug and reported literal backslash-n counts instead).
2. That a targeted string replacement changes exactly the intended value and
   leaves every other byte untouched, and that parse/reserialize does NOT.

Conclusion of this script is what the editor will be built on.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")


def fmt_report(raw: bytes) -> None:
    crlf = raw.count(b"\r\n")
    lf = raw.count(b"\n")
    cr = raw.count(b"\r")
    print("=== byte-level formatting ===")
    print(f"  size          = {len(raw)}")
    print(f"  CRLF (\\r\\n)   = {crlf}")
    print(f"  total LF (\\n) = {lf}")
    print(f"  total CR (\\r) = {cr}")
    print(f"  bare LF       = {lf - crlf}")
    print(f"  bare CR       = {cr - crlf}")
    ending = "CRLF" if crlf and crlf >= lf - crlf else "LF"
    print(f"  dominant EOL  = {ending}")
    print(f"  starts with   = {raw[:1]!r}")
    print(f"  ends with     = {raw[-1:]!r}")
    print(f"  trailing ws   = {raw[len(raw.rstrip()):]!r}")
    # Indent unit: diff of leading tabs between nesting levels.
    import re
    widths = sorted({len(m.group(1))
                     for m in re.finditer(rb"\r?\n([\t ]*)\"", raw)})
    print(f"  indent widths = {widths[:12]}")
    tab_count = raw[:5000].count(b"\t")
    print(f"  uses tabs     = {tab_count > 0} (first 5000 bytes: {tab_count})")
    print()


def reserialize_check(text: str, raw: bytes) -> None:
    print("=== parse -> reserialize ===")
    obj = json.loads(text)
    for kwargs, label in (
        (dict(indent="\t", separators=(",", ": ")), "indent=tap, sep=', : '"),
        (dict(indent="\t", separators=(",", ": "), ensure_ascii=False), "+ ensure_ascii=False"),
        (dict(indent="\t", separators=(",", ": "), ensure_ascii=False,
              sort_keys=False), "no sort"),
    ):
        out = json.dumps(obj, **kwargs)
        if label.startswith("+") or label.startswith("no "):
            encoded = out.encode("utf-8")
            print(f"  {label:34} len={len(encoded)}  == original? {encoded == raw}"
                  f"  delta={len(encoded) - len(raw):+d}")
    # With CRLF restored.
    out = json.dumps(obj, indent="\t", separators=(",", ": "), ensure_ascii=False)
    out_crlf = out.replace("\n", "\r\n").encode("utf-8")
    print(f"  + CRLF restored                   len={len(out_crlf)}  "
          f"== original? {out_crlf == raw}  delta={len(out_crlf) - len(raw):+d}")
    print()


def surgical_check(raw: bytes, needle: bytes, replacement: bytes, label: str) -> None:
    print(f"=== surgical edit: {label} ===")
    occurrences = raw.count(needle)
    print(f"  needle {needle!r} occurs {occurrences} time(s)")
    if occurrences != 1:
        print("  SKIPPED: needle is not unique")
        print()
        return
    patched = raw.replace(needle, replacement, 1)
    print(f"  size {len(raw)} -> {len(patched)} ({len(patched) - len(raw):+d} bytes)")
    # Exactly one differing region?
    pre = 0
    while pre < min(len(raw), len(patched)) and raw[pre] == patched[pre]:
        pre += 1
    suf = 0
    while (suf < len(raw) - pre and suf < len(patched) - pre
           and raw[len(raw) - 1 - suf] == patched[len(patched) - 1 - suf]):
        suf += 1
    changed_raw = raw[pre:len(raw) - suf]
    changed_new = patched[pre:len(patched) - suf]
    print(f"  differing region: offset={pre}  old={changed_raw!r}  new={changed_new!r}")
    untouched_before = raw[:pre]
    untouched_after = raw[len(raw) - suf:]
    print(f"  head preserved byte-for-byte: {untouched_before == patched[:pre]}")
    print(f"  tail preserved byte-for-byte: {untouched_after == patched[len(patched) - suf:]}")
    # Still valid JSON?
    obj = json.loads(patched.decode("utf-8"))
    print(f"  still valid JSON: True   coins={obj['Properties']['coins']}")
    print()


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    raw = src.read_bytes()
    text = raw.decode("utf-8")

    fmt_report(raw)
    reserialize_check(text, raw)

    # The four primaries, each with a plausible new value.
    surgical_check(raw, b'"coins": 2144822766', b'"coins": 999999999', "coins")
    surgical_check(raw, b'"level": 655', b'"level": 1000', "level")
    surgical_check(raw, b'"earnedStars": -2147482755',
                   b'"earnedStars": 3000', "earnedStars")
    surgical_check(raw, b'"current": 5', b'"current": 5', "lives (no-op test)")

    # How many times does "current": 5 appear? (lives may not be unique)
    print("=== uniqueness checks the editor will rely on ===")
    for probe in (b'"coins": 2144822766', b'"level": 655',
                  b'"earnedStars": -2147482755', b'"spentStars": 1763',
                  b'"current": 5', b'"lives": {'):
        print(f"  {probe!r}: {raw.count(probe)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
