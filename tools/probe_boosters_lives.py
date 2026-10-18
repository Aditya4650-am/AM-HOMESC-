"""Fix the AmountStartTime pairing and hunt the lives/energy mechanics.

Read-only.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")
SUFFIX = "AmountStartTime"  # 16 chars


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    data = json.loads(src.read_bytes())
    items = data.get("PlayerItems", {})

    # Correct pairing: Foo + FooAmountStartTime.
    paired = sorted(k[: -len(SUFFIX)] for k in items if k.endswith(SUFFIX))
    print(f"=== {len(paired)} PlayerItems counters with AmountStartTime ===")
    for k in paired:
        if not k.startswith("GivingDecor"):
            print(f"    PlayerItems.{k} = {items[k]!r}")
    print()

    # Boosters actually listed by Match3.currentBoosters.
    cur = data["Match3"]["currentBoosters"]
    print(f"=== Match3.currentBoosters ({len(cur)}) ===")
    for name in cur:
        val = items.get(name, "<not in PlayerItems>")
        print(f"    {name} = {val!r}")
    print()

    # Also check the booster unlock flags in Properties.
    pr = data["Properties"]
    print("=== booster unlock flags in Properties ===")
    for k in sorted(pr):
        if "BoosterWasUnlocked" in k or k.startswith("IsBoosterFree"):
            print(f"    {k} = {pr[k]!r}")
    print()

    # Lives: Homescapes restores lives on a timer. Look for a lives-shaped
    # int (0..5) with a sibling timestamp anywhere in Properties.
    print("=== Properties: int in 0..10 with a *time* sibling ===")
    times = [k for k in pr if re.search(r"time|date|stamp", k, re.I)]
    for k in sorted(pr):
        v = pr[k]
        if isinstance(v, int) and 0 <= v <= 10 and not isinstance(v, bool):
            print(f"    {k} = {v}")
    print(f"  ({len(times)} time-ish keys in Properties)")
    print()

    # Any key literally named like a life counter, case-insensitive, anywhere.
    print("=== exact-ish life keys anywhere ===")
    rx = re.compile(r"(^|[^a-z])(lives|life|hearts)([^a-z]|$)", re.I)

    def walk(node, path):
        if isinstance(node, dict):
            for key, val in node.items():
                yield f"{path}.{key}", key, val
                yield from walk(val, f"{path}.{key}")
        elif isinstance(node, list):
            for i, val in enumerate(node):
                yield f"{path}[{i}]", str(i), val
                yield from walk(val, f"{path}[{i}]")

    found = []
    for sec in data:
        for path, key, val in walk(data[sec], sec):
            if rx.search(key) and isinstance(val, (int, float, str, bool)):
                found.append((path, val))
    seen = set()
    for path, val in found:
        leaf = path.split(".")[-1].split("[")[0]
        if (leaf.lower(), repr(val)) in seen:
            continue
        seen.add((leaf.lower(), repr(val)))
        print(f"    {path} = {val!r}")
    print(f"  ({len(found)} raw)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
