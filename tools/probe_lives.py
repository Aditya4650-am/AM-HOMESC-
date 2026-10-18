"""Locate the raw bytes around 'lives' and check for mixed JSON formatting.

Read-only. The previous probe found Properties.lives.current = 5 via the parsed
tree, yet the raw needle b'"current": 5' matched zero times. That means the
file does not use one uniform style, and the editor must be position-aware
rather than pattern-matching on a single assumed layout.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")


def context(raw: bytes, needle: bytes, before: int = 90, after: int = 130,
            limit: int = 6) -> None:
    start = 0
    n = 0
    while n < limit:
        idx = raw.find(needle, start)
        if idx < 0:
            break
        lo = max(0, idx - before)
        hi = min(len(raw), idx + len(needle) + after)
        snippet = raw[lo:hi].decode("utf-8", "replace")
        print(f"  @{idx}: ...{snippet!r}...")
        start = idx + 1
        n += 1
    if n == 0:
        print(f"  needle {needle!r} NOT FOUND")
    print()


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    raw = src.read_bytes()
    text = raw.decode("utf-8")
    data = json.loads(text)

    print("=== where is 'lives' in the raw bytes? ===")
    context(raw, b"lives")

    print("=== raw around Properties.coins ===")
    context(raw, b'"coins"')

    print("=== raw around 'level' occurrences ===")
    context(raw, b'"level"', limit=6)

    # Is the file uniformly "key": value with a space after the colon?
    spaced = len(re.findall(rb'":\s', raw))
    tight = len(re.findall(rb'":[^\s]', raw))
    print(f"=== colon spacing ===\n  spaced = {spaced}\n  tight  = {tight}\n")

    # How does the parsed tree say lives looks?
    lives = data["Properties"].get("lives")
    print(f"=== parsed Properties.lives ===\n  {lives!r}\n")
    # Find its exact serialized form as json would render just that subtree.
    print(f"  json.dumps(lives, indent=\\t): "
          f"{json.dumps(lives, indent='\\t')!r}")
    print()

    # A value can appear under many keys; count key-occurrence for our targets.
    print("=== key occurrence counts (parsed) ===")
    counts = {"level": 0, "coins": 0, "current": 0, "lives": 0}

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k in counts:
                    counts[k] += 1
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    for k, v in counts.items():
        print(f"  {k!r}: {v} occurrence(s) as an object key")
    print()

    # The mixed-format question: does any section use compact arrays?
    print("=== array style sampling ===")
    for m in list(re.finditer(rb"\[([^\]\r\n]{1,120})\]", raw))[:8]:
        inner = m.group(1)
        compact = b"," in inner and b"\r\n" not in inner
        print(f"  compact={compact}  {inner[:80]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
