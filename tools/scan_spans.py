# -*- coding: utf-8 -*-
"""
Bytes-level, position-tracking JSON scanner for Homescapes SaveGame.db.

This is the REFERENCE implementation for the tool's surgical patcher.
It walks the raw bytes (never re-serializes) and records, for every JSON
member, the exact byte spans of:
  - the key (including its quotes)
  - the value
and classifies the value type. For tagged Playrix values of the form
  {"t":"i64","v":"5"}  it additionally exposes the span of the inner "v".

Output: tools/_spans.json  (path -> record) plus a stats summary on stdout.
Nothing is mutated. Read-only.
"""
import sys, io, json, os
from collections import OrderedDict

# NOTE: reconfigure in place.  Creating a *new* TextIOWrapper over
# sys.stdout.buffer drops the last reference to the previous wrapper, whose
# deallocation closes that shared buffer -> "ValueError: I/O operation on
# closed file" for every later print (hit on import by verify_all.py).
try:
    sys.stdout.reconfigure(encoding="utf-8", newline="")
except AttributeError:
    _old_stdout = sys.stdout          # keep alive: its dealloc closes the buffer
    sys.stdout = io.TextIOWrapper(_old_stdout.buffer, encoding="utf-8", newline="")

SAVE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "_SaveGame.db")
if not os.path.exists(SAVE):
    SAVE = r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db"

WS = {0x20, 0x09, 0x0a, 0x0d}


class ScanError(Exception):
    pass


def _skip_ws(b, i, n):
    while i < n and b[i] in WS:
        i += 1
    if i >= n:
        raise ScanError("eof while skipping ws at %d" % i)
    return i


def _scan_string(b, i, n):
    """i points at the opening quote. Returns index just past closing quote."""
    assert b[i] == 0x22, "string must start with quote at %d" % i
    i += 1
    while i < n:
        c = b[i]
        if c == 0x5C:            # backslash -> skip escaped char
            i += 2
            continue
        if c == 0x22:            # closing quote
            return i + 1
        i += 1
    raise ScanError("unterminated string ending at %d" % n)


def _scan_number(b, i, n):
    j = i
    while j < n:
        c = b[j]
        # JSON number charset
        if (0x30 <= c <= 0x39) or c in (0x2d, 0x2b, 0x2e, 0x65, 0x45):
            j += 1
        else:
            break
    if j == i:
        raise ScanError("bad number at %d" % i)
    return j


class Scanner:
    def __init__(self, raw):
        self.b = raw
        self.n = len(raw)
        self.members = OrderedDict()   # path -> record
        self.order = []                # list of paths in file order
        self.children = {}             # object path -> [paths of direct members]

    def _rec(self, path, key_span, val_span, vtype):
        rec = {
            "path": path,
            "key_start": None if key_span is None else key_span[0],
            "key_end": None if key_span is None else key_span[1],
            "val_start": val_span[0],
            "val_end": val_span[1],
            "type": vtype,
        }
        self.members[path] = rec
        self.order.append(path)
        return rec

    def value(self, i, path):
        """Scan one value at index i. Returns (end_index, val_span, vtype)."""
        n = self.n
        i = _skip_ws(self.b, i, n)
        c = self.b[i]

        if c == 0x7B:      # {
            return self.object(i, path)
        if c == 0x5B:      # [
            return self.array(i, path)
        if c == 0x22:      # "
            j = _scan_string(self.b, i, n)
            return j, (i, j), "string"
        if c == 0x2D or (0x30 <= c <= 0x39):   # number
            j = _scan_number(self.b, i, n)
            return j, (i, j), "number"
        if self.b[i:i + 4] == b"true":
            return i + 4, (i, i + 4), "true"
        if self.b[i:i + 5] == b"false":
            return i + 5, (i, i + 5), "false"
        if self.b[i:i + 4] == b"null":
            return i + 4, (i, i + 4), "null"
        raise ScanError("unexpected byte 0x%02x at %d" % (c, i))

    def object(self, i, path):
        n = self.n
        start = i
        i += 1  # consume {
        members = []
        i = _skip_ws(self.b, i, n)
        if self.b[i] == 0x7D:
            self.children[path] = []
            return i + 1, (start, i + 1), "object"
        while True:
            i = _skip_ws(self.b, i, n)
            if self.b[i] != 0x22:
                raise ScanError("expected key quote at %d" % i)
            kstart = i
            kend = _scan_string(self.b, i, n)
            key = self.b[kstart + 1:kend - 1].decode("utf-8")
            i = _skip_ws(self.b, kend, n)
            if self.b[i] != 0x3A:
                raise ScanError("expected ':' at %d" % i)
            i += 1
            cpath = path + "." + key if path else key
            vend, vspan, vtype = self.value(i, cpath)
            self._rec(cpath, (kstart, kend), vspan, vtype)
            members.append((cpath, vspan, vtype))
            i = _skip_ws(self.b, vend, n)
            c = self.b[i]
            if c == 0x2C:
                i += 1
                continue
            if c == 0x7D:
                self.children[path] = [cpath for cpath, _, _ in members]
                return i + 1, (start, i + 1), "object"
            raise ScanError("expected ',' or '}' at %d" % i)

    def array(self, i, path):
        n = self.n
        start = i
        i += 1  # consume [
        i = _skip_ws(self.b, i, n)
        if self.b[i] == 0x5D:
            return i + 1, (start, i + 1), "array"
        idx = 0
        while True:
            cpath = "%s[%d]" % (path, idx)
            vend, vspan, vtype = self.value(i, cpath)
            self._rec(cpath, None, vspan, vtype)
            i = _skip_ws(self.b, vend, n)
            c = self.b[i]
            if c == 0x2C:
                i += 1
                idx += 1
                continue
            if c == 0x5D:
                return i + 1, (start, i + 1), "array"
            raise ScanError("expected ',' or ']' at %d" % i)


def main():
    raw = open(SAVE, "rb").read()
    sc = Scanner(raw)
    try:
        end, span, vtype = sc.value(0, "")
    except ScanError as e:
        print("SCAN FAILED:", e)
        sys.exit(1)

    tail = raw[end:]
    print("bytes                 :", len(raw))
    print("root type             :", vtype)
    print("root span             :", span)
    print("members recorded      :", len(sc.members))
    print("trailing bytes        :", len(tail), repr(tail[:40]))

    # ---- targeted lookups -----------------------------------------------
    WATCH = [
        "Properties.coins",
        "Properties.level",
        "Properties.earnedStars",
        "Properties.spentStars",
        "Properties.lives.current",
        "CeReas_R1",
        "CeReas_R4",
        "CeReas_R8",
        "CeReas_R9",
    ]
    print("\n--- watch list ---")
    for p in WATCH:
        r = sc.members.get(p)
        if not r:
            print("  %-28s MISSING" % p)
            continue
        txt = raw[r["val_start"]:r["val_end"]].decode("utf-8", "replace")
        if len(txt) > 200:
            txt = txt[:200] + " ...<%d chars>" % len(txt)
        print("  %-28s [%8d,%8d) %s  %s" %
              (p, r["val_start"], r["val_end"], r["type"], txt))

    # ---- tagged value stats ---------------------------------------------
    print("\n--- tagged value stats ---")
    tagcounts = {}
    tagged_paths = []
    for p, r in sc.members.items():
        if r["type"] != "object":
            continue
        sub = self_submembers(sc, r)
        if set(sub) == {"t", "v"}:
            trec = sc.members.get(p + ".t")
            if trec and trec["type"] == "string":
                tag = raw[trec["val_start"] + 1:trec["val_end"] - 1].decode()
                tagcounts[tag] = tagcounts.get(tag, 0) + 1
                tagged_paths.append((p, tag))
    for k in sorted(tagcounts, key=lambda x: -tagcounts[x]):
        print("  t=%-6s %d" % (k, tagcounts[k]))

    # ---- dump spans ------------------------------------------------------
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_spans.json")
    slim = OrderedDict()
    for p, r in sc.members.items():
        slim[p] = {
            "ks": r["key_start"], "ke": r["key_end"],
            "vs": r["val_start"], "ve": r["val_end"], "ty": r["type"],
        }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(slim, f, separators=(",", ":"))
    print("\nwrote", out, os.path.getsize(out), "bytes")


def self_submembers(sc, rec):
    """Names of direct members of the object spanning rec's value.

    Uses the child index recorded by Scanner.object() during the single
    forward pass (exact structural containment), so this is O(1) per object
    instead of the old O(n^2) span re-scan over every member.
    """
    kids = sc.children.get(rec["path"])
    if not kids:
        return set()
    plen = len(rec["path"])
    return {c[plen + 1:] for c in kids}


if __name__ == "__main__":
    main()
