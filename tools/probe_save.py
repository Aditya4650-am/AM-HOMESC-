"""Probe the Homescapes SaveGame.db and print the exact paths a tool edits.

Read-only. Used to lock down the field map before any editor code is written.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")

# Names that are plausible player-facing values we might expose in a tab.
INTERESTING = {
    "lives", "life", "energy", "stars", "star", "exp", "experience", "xp",
    "level", "coins", "coin", "moves", "crystals", "hints", "boosters",
}


def walk(node, path):
    """Yield (path, tagged_dict) for every type-tagged leaf."""
    if isinstance(node, dict):
        if "t" in node and "v" in node and set(node) <= {"t", "v"}:
            yield path, node
            return
        for key, val in node.items():
            yield from walk(val, f"{path}.{key}")
    elif isinstance(node, list):
        for i, val in enumerate(node):
            yield from walk(val, f"{path}[{i}]")


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    data = json.loads(src.read_bytes())
    print(f"loaded {src} ({src.stat().st_size} bytes), {len(data)} sections\n")

    # 1. Every tagged leaf whose final key looks player-facing.
    print("=== player-facing tagged leaves ===")
    hits = []
    for sec in data:
        for path, node in walk(data[sec], sec):
            base = path.split(".")[-1].split("[")[0].lower()
            if base in INTERESTING and isinstance(node["v"], (int, float, str, bool)):
                hits.append((path, node["t"], node["v"]))
    # de-dup on (basename, value) so 600 history rows don't drown the signal
    seen = set()
    for path, tag, val in hits:
        base = path.split(".")[-1].split("[")[0].lower()
        marker = (base, repr(val))
        if marker in seen:
            continue
        seen.add(marker)
        print(f"  [{tag:>3}] {path} = {val!r}")
    print(f"  ({len(hits)} total, {len(seen)} distinct shown)\n")

    # 2. Untagged scalar sections (Properties / Currency / PlayerItems style).
    print("=== untyped top-level maps ===")
    for sec, val in data.items():
        if isinstance(val, dict) and val and not ("t" in val and "v" in val and set(val) <= {"t", "v"}):
            scalars = sum(1 for v in val.values() if isinstance(v, (int, float, bool, str)))
            print(f"  {sec}: {len(val)} keys, {scalars} scalar")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
