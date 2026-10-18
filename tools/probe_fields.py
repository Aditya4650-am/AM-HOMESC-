"""Field-map probe: locate the exact path of every value an editor tab touches.

Read-only. Answers: where do coins / level / stars / lives / energy / boosters
/ avatars / rooms / quests actually live in SaveGame.db, and what type are they?
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")


def walk_all(node, path):
    """Yield (path, value) for every node in the tree."""
    if isinstance(node, dict):
        for key, val in node.items():
            yield f"{path}.{key}", val
            yield from walk_all(val, f"{path}.{key}")
    elif isinstance(node, list):
        for i, val in enumerate(node):
            yield f"{path}[{i}]", val
            yield from walk_all(val, f"{path}[{i}]")


def show(label, matches, limit=25):
    print(f"--- {label} ({len(matches)} match) ---")
    for path, val in matches[:limit]:
        kind = "tagged:" + val["t"] if isinstance(val, dict) and set(val) <= {"t", "v"} else type(val).__name__
        shown = repr(val["v"] if isinstance(val, dict) and set(val) <= {"t", "v"} else val)
        if len(shown) > 70:
            shown = shown[:70] + "..."
        print(f"    [{kind}] {path} = {shown}")
    if len(matches) > limit:
        print(f"    ... {len(matches) - limit} more")
    print()


def find(data, pattern, regex=True):
    """Find paths whose *leaf key* matches `pattern`."""
    out = []
    rx = re.compile(pattern) if regex else None
    for sec in data:
        for path, val in walk_all(data[sec], sec):
            leaf = path.split(".")[-1].split("[")[0]
            ok = bool(rx.search(leaf)) if regex else leaf == pattern
            if ok:
                out.append((path, val))
    return out


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    data = json.loads(src.read_bytes())

    # Direct known locations.
    print("=== known core locations ===")
    pr = data.get("Properties", {})
    for k in ("level", "coins", "earnedStars", "spentStars", "boughtCoins",
              "realCoins", "earnedCoinsCount", "PiggyBankCoins"):
        if k in pr:
            print(f"    Properties.{k} = {pr[k]!r} ({type(pr[k]).__name__})")
    print()

    show("leaf key contains 'star'", find(data, r"star", regex=True), 30)
    show("leaf key contains 'life'", find(data, r"life", regex=True), 30)
    show("leaf key contains 'energy'", find(data, r"^energy|energy$", regex=True), 20)

    # Boosters: PlayerItems scalar ints that are not timestamps.
    print("--- PlayerItems booster candidates ---")
    items = data.get("PlayerItems", {})
    skip = re.compile(r"(StartTime|EndTime|RemainTime|Protect|AmountStart)")
    boosters = {k: v for k, v in items.items()
                if isinstance(v, int) and not skip.search(k)}
    print(f"    {len(boosters)} int keys in PlayerItems")
    for k, v in list(sorted(boosters.items()))[:30]:
        print(f"    PlayerItems.{k} = {v}")
    print(f"    ... {max(0, len(boosters) - 30)} more")
    print()

    show("Match3.currentBoosters", [("Match3.currentBoosters", data["Match3"]["currentBoosters"])], 5)

    # Avatars
    av = data.get("Avatars", {})
    owned = sum(1 for v in av.values() if v is True)
    print(f"--- Avatars: {len(av)} keys, {owned} unlocked ---")
    print(f"    sample: {list(av.items())[:6]}")
    print()

    # Rooms
    rd = data.get("RoomDesign", {})
    print(f"--- RoomDesign: {len(rd)} rooms ---")
    for k, v in list(rd.items())[:12]:
        kind = "tagged:" + v["t"] if isinstance(v, dict) and set(v) <= {"t", "v"} else type(v).__name__
        inner = v["v"] if kind.startswith("tagged") else v
        print(f"    [{kind}] RoomDesign.{k} = {repr(inner)[:70]}")
    print()

    # Quests
    q = data.get("Quests", {})
    done = sum(1 for v in q.values()
               if isinstance(v, dict) and isinstance(v.get("v"), dict)
               and v["v"].get("collected") is True)
    print(f"--- Quests: {len(q)} total, {done} collected ---")
    print()

    # Currency
    cur = data.get("Currency", {})
    print(f"--- Currency: {len(cur)} keys (event currencies, all scalar) ---")
    print(f"    sample: {list(cur.items())[:6]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
