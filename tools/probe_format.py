"""Characterise the exact byte-level formatting of SaveGame.db.

Read-only. A safe editor must reproduce the file byte-for-byte except for the
values it deliberately changes, so we need to know indentation, line endings,
number formatting and whether duplicate keys exist.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    raw = src.read_bytes()

    print(f"size          = {len(raw)} bytes")
    is_obj = raw[:1] == b"{"
    print(f"first byte    = {raw[:1]!r} (json object: {is_obj!r})")
    print(f"last byte     = {raw[-1:]!r}")
    print(f"CRLF count    = {raw.count(b'\\r\\n')}")
    print(f"LF total      = {raw.count(b'\\n')}")
    print(f"bare LF       = {raw.count(b'\\n') - raw.count(b'\\r\\n')}")
    print(f"trailing NUL  = {len(raw) - len(raw.rstrip(chr(0).encode()))}")
    print()

    # Indentation: look at the first few lines' leading whitespace.
    head = raw[:400].decode("utf-8", "replace")
    lines = head.split("\r\n")
    print("first lines (repr of leading ws):")
    for line in lines[:8]:
        ws = re.match(r"^[\t ]*", line).group(0)
        print(f"    ws={ws!r}  len={len(line)}  text={line.strip()[:60]!r}")
    print()

    # Every distinct indent width used anywhere.
    indents = Counter()
    for m in re.finditer(rb"\r\n([\t ]*)\"", raw):
        ws = m.group(1)
        indents[(b"\t" in ws, len(ws))] += 1
    print("indent patterns (has_tab, width) -> count:")
    for (tab, width), n in sorted(indents.items(), key=lambda kv: -kv[1])[:8]:
        print(f"    has_tab={tab} width={width}: {n}")
    print()

    # Encoding / BOM.
    print(f"BOM           = {raw[:3] == b'\\xef\\xbb\\xbf'}")
    try:
        text = raw.decode("utf-8")
        print("utf-8 decode  = OK")
    except UnicodeDecodeError as e:
        print(f"utf-8 decode  = FAIL {e}")
        text = raw.decode("utf-8", "replace")
    print()

    # Number formatting: collect integer and float literal shapes.
    ints = re.findall(r":\s*(-?\d+)", text)
    floats = re.findall(r":\s*(-?\d+\.\d+(?:[eE][+-]?\d+)?)", text)
    print(f"integer literals   = {len(ints)}")
    big = [i for i in ints if len(i.lstrip('-')) >= 10]
    print(f"  >=10 digits      = {len(big)}  sample={big[:5]}")
    print(f"float literals     = {len(floats)}  sample={floats[:5]}")
    exp = [f for f in floats if "e" in f or "E" in f]
    print(f"  scientific       = {len(exp)}  sample={exp[:5]}")
    print()

    # Leading zeros / non-standard JSON that json.load would silently accept
    # differently? (json rejects them, so presence would matter.)
    print(f"leading-zero ints = {len(re.findall(r':\\s*0\\d+', text))}")
    print()

    # Duplicate keys would be lost on a parse/serialize round trip.
    dupes = Counter(re.findall(r'"([^"\\]+)"\s*:', text))
    repeated = {k: v for k, v in dupes.items() if v > 1 and v < 50}
    print(f"keys appearing >1 time = {len(repeated)} (many are expected across sections)")
    top = sorted(repeated.items(), key=lambda kv: -kv[1])[:10]
    for k, v in top:
        print(f"    {k!r}: {v}")
    print()

    # Prove parse/serialize round-trip stability: does json give back our bytes?
    obj = json.loads(text)
    reencoded = json.dumps(obj, indent="\t", ensure_ascii=False, separators=(",", ": "))
    print(f"json.dumps(indent=tab) == original? {reencoded == text}")
    print(f"  re-encoded len = {len(reencoded.encode('utf-8'))} vs original {len(raw)}")
    # Try CRLF flavour.
    re2 = json.dumps(obj, indent="\t", ensure_ascii=False, separators=(",", ": "))
    re2_crlf = re2.replace("\n", "\r\n")
    print(f"with CRLF == original? {re2_crlf == text}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
