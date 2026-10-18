"""Map the derived/integrity strings in Properties (CeReas_* etc.).

Read-only. These strings embed copies of coins/stars/boosters. If a tool edits
the primaries without refreshing the derived copies, the save goes out of
sync with itself. This script proves which derived string mirrors which field.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")

I32 = 1 << 32


def u32(x: int) -> int:
    return x + I32 if x < 0 else x


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    data = json.loads(src.read_bytes())
    pr = data["Properties"]
    items = data.get("PlayerItems", {})

    print("=== all CeReas_* strings ===")
    derived = {k: v for k, v in pr.items() if k.startswith("CeReas")}
    for k in sorted(derived):
        print(f"  {k} = {derived[k]!r}")
    print()

    # Primary values the strings appear to mirror.
    coins = pr.get("coins")
    es, ss = pr.get("earnedStars"), pr.get("spentStars")
    print("=== primaries ===")
    print(f"  Properties.coins       = {coins}")
    print(f"  Properties.earnedStars = {es}")
    print(f"  Properties.spentStars  = {ss}")
    print(f"  uint32(earnedStars)    = {u32(es) if isinstance(es, int) else '?'}")
    if isinstance(es, int) and isinstance(ss, int):
        print(f"  uint32(earned)-spent   = {u32(es) - ss}")
    print()

    print("=== cross-check each numeric inside CeReas against primaries ===")
    prim = {
        "coins": coins,
        "u32earned-spent": (u32(es) - ss) if isinstance(es, int) and isinstance(ss, int) else None,
        "earnedStars": es,
        "spentStars": ss,
    }
    for k in sorted(derived):
        val = derived[k]
        if not isinstance(val, str):
            continue
        nums = re.findall(r"-?\d+", val)
        for n in nums:
            n_int = int(n)
            for pname, pval in prim.items():
                if pval is not None and n_int == pval:
                    print(f"  {k}: number {n_int} == {pname}")
    print()

    # Booster counts referenced by R8/R9 style strings.
    print("=== booster-ish primaries in PlayerItems ===")
    interesting = ["BombAndLineBoost", "LightningBoost", "HammerBonus",
                   "HorizontalLineBoosterBonus", "VerticalLineBoosterBonus",
                   "MultiplyFishBoost", "ReshuffleBoosterBonus", "SwapBoosterBonus",
                   "ShovelBoost", "DynamiteAndLightningBoost"]
    for name in interesting:
        if name in items:
            print(f"  PlayerItems.{name} = {items[name]!r}")
    print()

    print("=== raw int values in each CeReas string ===")
    for k in sorted(derived):
        v = derived[k]
        if isinstance(v, str):
            print(f"  {k}: {re.findall(r'-?\\d+', v)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
