#!/usr/bin/env python3
"""Extract DEFAULT_KEY from decode_savegame.py by executing the module itself.

Prints (machine-readable, one record per line):
  KEY_LEN=<bytes>
  KEY_B64=<standard base64, single line>
  KEY_SHA256=<hex>
plus the SaveGame.db sanity-check report.

Read-only with respect to the source module.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import sys
from pathlib import Path

SRC = Path(r"C:\Users\User\Downloads\Telegram Desktop\decode_savegame.py")
SAVE = Path(r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db")


def load_default_key() -> bytes:
    """Execute the module's own definition of DEFAULT_KEY (no hand transcription)."""
    spec = importlib.util.spec_from_file_location("decode_savegame", SRC)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load spec for {SRC}")
    mod = importlib.util.module_from_spec(spec)
    # Prevent argparse/main side effects: the module only defines names at
    # import time (main() is guarded by __name__ == "__main__").
    spec.loader.exec_module(mod)
    key = mod.DEFAULT_KEY
    if isinstance(key, str):
        key = key.encode("latin1")  # mirror the module's own .encode("latin1")
    if not isinstance(key, (bytes, bytearray)):
        raise SystemExit(f"unexpected DEFAULT_KEY type: {type(key)!r}")
    return bytes(key)


def xor_repeat(data: bytes, key: bytes) -> bytes:
    if not key:
        raise ValueError("empty key")
    n = len(key)
    return bytes(b ^ key[i % n] for i, b in enumerate(data))


def main() -> int:
    key = load_default_key()

    b64 = base64.b64encode(key).decode("ascii")
    sha = hashlib.sha256(key).hexdigest()

    print(f"KEY_LEN={len(key)}")
    print(f"KEY_B64={b64}")
    print(f"KEY_SHA256={sha}")

    if SAVE.is_file():
        raw = SAVE.read_bytes()
        dec = xor_repeat(raw, key)
        stripped = dec.rstrip(b"\x00")
        ws = b" \t\r\n"
        first_non_ws = next((b for b in dec if b not in ws), None)
        print("SAVEGAME_REPORT")
        print(f"  raw_len={len(raw)}")
        print(f"  xor_len={len(dec)}")
        print(f"  xor_len_after_rstrip_nul={len(stripped)}")
        print(f"  trailing_nul_bytes={len(dec) - len(stripped)}")
        print(f"  first_non_ws_byte={first_non_ws!r} "
              f"is_0x7b={first_non_ws == 0x7b}")
        print(f"  first_40_repr={dec[:40]!r}")
        raw_ws = next((b for b in raw if b not in ws), None)
        print(f"  RAW first_non_ws_byte={raw_ws!r} "
              f"is_0x7b={raw_ws == 0x7b} raw_first40={raw[:40]!r}")
    else:
        print(f"SAVEGAME_REPORT: missing {SAVE}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
