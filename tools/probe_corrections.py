"""Confirm two corrections before any editor code gets written.

1. `Properties.lives` is NOT a nested object — the earlier path printer joined
   keys with dots, which faked nesting. The real key is the flat string
   "lives.current".

2. The file mixes `": ` (spaced) and `":` (tight) colon styles, so any editor
   that assumes one layout is wrong. Locate where the tight ones are.

Conclusion drives the design: patch by byte offset found via a
position-tracking parse, never by pattern-matching a formatted string.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    raw = src.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    props = data["Properties"]

    print("=== correction 1: flat dotted keys in Properties ===")
    dotted = sorted(k for k in props if "." in k)
    print(f"  {len(dotted)} keys contain a literal dot")
    for k in dotted:
        if k.startswith("lives") or k in ("level", "coins"):
            print(f"    {k!r} = {props[k]!r}")
    print(f"  'lives' as a bare key present? {'lives' in props}")
    print(f"  'lives.current' present?       {'lives.current' in props}")
    print()

    print("=== correction 2: where are the tight colons? ===")
    hits = [(m.start(), raw[max(0, m.start() - 45):m.start() + 35].decode("utf-8", "replace"))
            for m in re.finditer(rb'":[^\s]', raw)]
    print(f"  {len(hits)} tight-colon occurrences")
    for pos, snip in hits[:10]:
        print(f"    @{pos}: ...{snip!r}...")
    # Are they inside string *values* (escaped quotes) rather than structure?
    in_string = 0
    for pos, _ in hits[:200]:
        # Naive: count unescaped quotes before pos.
        seg = raw[:pos]
        n_quotes = len(re.findall(rb'(?<!\\)"', seg))
        if n_quotes % 2 == 1:
            in_string += 1
    print(f"  of first 200, {in_string} fall inside an open string "
          f"(=> likely value text, not structure)")
    print()

    print("=== exact targets the Core tabs will patch ===")
    targets = [
        ("Properties", "coins"),
        ("Properties", "level"),
        ("Properties", "earnedStars"),
        ("Properties", "spentStars"),
        ("Properties", "lives.current"),
    ]
    for sec, key in targets:
        if sec in data and key in data[sec]:
            print(f"  {sec}.{key} = {data[sec][key]!r} "
                  f"({type(data[sec][key]).__name__})")
        else:
            print(f"  {sec}.{key} = <MISSING>")
    print()

    print("=== booster targets (PlayerItems) ===")
    items = data["PlayerItems"]
    for name in data["Match3"]["currentBoosters"]:
        print(f"  PlayerItems.{name} = {items.get(name)!r}")
    print()

    print("=== integrity strings that mirror the above ===")
    for k in sorted(props):
        if k.startswith("CeReas"):
            print(f"  Properties.{k} = {props[k]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
