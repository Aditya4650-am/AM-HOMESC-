"""Case-insensitive field hunt: find every key mentioning star / life / level.

Read-only. Corrects an earlier probe whose case-sensitive match on "star"
silently matched only "start".
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")


def walk(node, path):
    if isinstance(node, dict):
        for key, val in node.items():
            yield f"{path}.{key}", key, val
            yield from walk(val, f"{path}.{key}")
    elif isinstance(node, list):
        for i, val in enumerate(node):
            yield f"{path}[{i}]", str(i), val
            yield from walk(val, f"{path}[{i}]")


def scalarish(val):
    if isinstance(val, (int, float, bool, str)):
        return True
    return isinstance(val, dict) and set(val) <= {"t", "v"} and isinstance(
        val.get("v"), (int, float, bool, str)
    )


def untag(val):
    return val["v"] if isinstance(val, dict) and set(val) <= {"t", "v"} else val


def hunt(data, needle, limit=40):
    rx = re.compile(needle, re.I)
    hits = []
    for sec in data:
        for path, key, val in walk(data[sec], sec):
            if rx.search(key) and scalarish(val):
                hits.append((path, val))
    print(f"=== ~/{needle}/i  ({len(hits)} scalar hits) ===")
    shown = set()
    for path, val in hits:
        leaf = path.split(".")[-1].split("[")[0]
        marker = (leaf.lower(), repr(untag(val)))
        if marker in shown:
            continue
        shown.add(marker)
        tag = f"[{val['t']}]" if isinstance(val, dict) else "     "
        print(f"  {tag} {path} = {untag(val)!r}")
        if len(shown) >= limit:
            break
    print()


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    data = json.loads(src.read_bytes())

    for needle in (r"^stars?$", r"^lives?$", r"^level$",
                   r"earnedstar", r"spentstar", r"^coins$"):
        hunt(data, needle)

    # The two counter fields, read straight out.
    pr = data["Properties"]
    for k in ("earnedStars", "spentStars", "level", "coins"):
        if k in pr:
            print(f"  Properties.{k} = {pr[k]!r}")
    es, ss = pr.get("earnedStars"), pr.get("spentStars")
    if isinstance(es, int) and isinstance(ss, int):
        print(f"\n  earnedStars as uint32 = {es + (1 << 32) if es < 0 else es}")
        print(f"  earnedStars - spentStars (int64) = {es - ss}")
        print(f"  uint32(earnedStars) - spentStars  = "
              f"{(es + (1 << 32) if es < 0 else es) - ss}")
    print(f"\n  int32 range: -2147483648 .. 2147483647")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
