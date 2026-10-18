"""Catalog every scalar field worth exposing, and hunt lives/energy timers.

Read-only. Builds a candidate list for the editor tabs and looks specifically
for the life-restore / energy timers that Homescapes keeps as timestamps.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")

# Field-name fragments that suggest a life/energy/timer mechanic.
LIFE_RX = re.compile(r"life|hearts?|restore|regen|refill|timer|lastuse|lastgain", re.I)

# Timestamps are huge floats/ints; real durations are small.
def looks_like_epoch(v) -> bool:
    if isinstance(v, float):
        return v > 1_000_000_000
    if isinstance(v, int):
        return 1_000_000_000 < v < 3_000_000_000
    return False


def walk(node, path):
    if isinstance(node, dict):
        for key, val in node.items():
            yield f"{path}.{key}", key, val
            yield from walk(val, f"{path}.{key}")
    elif isinstance(node, list):
        for i, val in enumerate(node):
            yield f"{path}[{i}]", str(i), val
            yield from walk(val, f"{path}[{i}]")


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    data = json.loads(src.read_bytes())

    # 1. Life / energy / timer candidates that are NOT epoch timestamps.
    print("=== life/energy/timer candidates (non-epoch) ===")
    hits = []
    for sec in data:
        for path, key, val in walk(data[sec], sec):
            if not LIFE_RX.search(key):
                continue
            if not isinstance(val, (int, float, bool, str)):
                continue
            if looks_like_epoch(val):
                continue
            hits.append((path, val))
    seen = set()
    for path, val in hits:
        leaf = path.split(".")[-1].split("[")[0]
        marker = (leaf.lower(), repr(val))
        if marker in seen:
            continue
        seen.add(marker)
        print(f"    {path} = {val!r}")
    print(f"  ({len(hits)} raw, {len(seen)} distinct)\n")

    # 2. Currency keys that look like consumable stock (not scores/points).
    print("=== Currency: non-score entries (possible consumables) ===")
    cur = data.get("Currency", {})
    scoreish = re.compile(r"score|points|pts$", re.I)
    for k in sorted(cur):
        if not scoreish.search(k) and not k.endswith(".prevAmount"):
            print(f"    {k} = {cur[k]!r}")
    print()

    # 3. PlayerItems: timestamp-free counters, grouped by prefix.
    print("=== PlayerItems: counters without a paired *AmountStartTime ===")
    items = data.get("PlayerItems", {})
    start_times = {k[:-12] for k in items if k.endswith("AmountStartTime")}
    counters = [k for k in sorted(start_times) if k in items]
    print(f"  {len(counters)} counters with a matching AmountStartTime:")
    for k in counters[:40]:
        print(f"    PlayerItems.{k} = {items[k]!r}")
    if len(counters) > 40:
        print(f"    ... {len(counters) - 40} more")
    print()

    # 4. PlayerItems ints that have NO timestamp pair (one-shot flags etc).
    orphans = [k for k in sorted(items)
               if isinstance(items[k], int) and k not in start_times
               and k not in {c + "AmountStartTime" for c in counters}]
    print(f"=== PlayerItems: {len(orphans)} other int keys (sample) ===")
    for k in orphans[:25]:
        print(f"    PlayerItems.{k} = {items[k]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
