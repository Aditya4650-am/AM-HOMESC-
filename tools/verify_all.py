# -*- coding: utf-8 -*-
"""
End-to-end verification of the surgical patch strategy against the real
Homescapes SaveGame.db. Read-only against the sample; writes only to
tools/_verify_out.db and tools/_verify_report.txt.

Checks:
  1. full span scan completes
  2. 'level' disambiguation (3 occurrences, exact byte spans + context)
  3. surgical edits (coins, earnedStars, lives.current, one booster)
     -> valid JSON, untouched regions byte-identical, integrity strings
  4. integrity string contents (CeReas_R1/R4/R8/R9) printed in full
"""
import sys, io, os, json, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from scan_spans import Scanner, ScanError   # noqa: E402

# Reconfigure in place (same utf-8 / no-newline-translation result as the old
# TextIOWrapper(sys.stdout.buffer, ...) line).  Wrapping in a fresh
# TextIOWrapper here drops the last reference to the wrapper scan_spans just
# installed; its deallocation closes the shared buffer and every subsequent
# print raises "ValueError: I/O operation on closed file".
try:
    sys.stdout.reconfigure(encoding="utf-8", newline="")
except AttributeError:
    _old_stdout = sys.stdout          # keep alive: its dealloc closes the buffer
    sys.stdout = io.TextIOWrapper(_old_stdout.buffer, encoding="utf-8", newline="")

SRC = r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db"
OUT = os.path.join(HERE, "_verify_out.db")
RPT = os.path.join(HERE, "_verify_report.txt")

lines = []
def log(s=""):
    print(s)
    lines.append(str(s))


def ctx(raw, pos, before=120, after=120):
    a = max(0, pos - before)
    b = min(len(raw), pos + after)
    return (raw[a:pos].decode("utf-8", "replace").replace("\r", "\\r")
            .replace("\n", "\\n").replace("\t", "\\t")
            + " <<HERE>> "
            + raw[pos:b].decode("utf-8", "replace").replace("\r", "\\r")
            .replace("\n", "\\n").replace("\t", "\\t"))


def main():
    raw = open(SRC, "rb").read()
    log("SOURCE          : %s (%d bytes)" % (SRC, len(raw)))
    log("sha256          : %s" % hashlib.sha256(raw).hexdigest())

    # 1. scan ------------------------------------------------------------
    sc = Scanner(raw)
    end, span, vtype = sc.value(0, "")
    log("\n[1] SCAN")
    log("    members      : %d" % len(sc.members))
    log("    root         : %s %s" % (vtype, span))
    log("    trailing     : %d bytes" % (len(raw) - end))

    # 2. level disambiguation --------------------------------------------
    log("\n[2] 'level' OCCURRENCES")
    needle = b'"level": 655'
    pos = 0
    hits = []
    while True:
        i = raw.find(needle, pos)
        if i < 0:
            break
        hits.append(i)
        pos = i + 1
    log("    literal hits : %d -> %s" % (len(hits), hits))
    for h in hits:
        # which recorded member owns this offset as its value start?
        owner = None
        for p, r in sc.members.items():
            if r["val_start"] == h:
                owner = p
                break
        log("    --- %s  owner=%s" % (h, owner))
        log("        %s" % ctx(raw, h, 150, 60))

    # span of the real Properties.level
    r = sc.members.get("Properties.level")
    log("    Properties.level span = [%d,%d) %s" %
        (r["val_start"], r["val_end"],
         raw[r["val_start"]:r["val_end"]].decode()))

    # 3. integrity strings -----------------------------------------------
    log("\n[3] INTEGRITY STRINGS")
    for p in ("CeReas_R1", "CeReas_R4", "CeReas_R8", "CeReas_R9"):
        r = sc.members.get(p)
        if not r:
            log("    %-10s MISSING" % p)
            continue
        txt = raw[r["val_start"]:r["val_end"]].decode("utf-8", "replace")
        log("    %-10s [%d,%d) %s" % (p, r["val_start"], r["val_end"], txt))

    # 4. surgical edit test ----------------------------------------------
    log("\n[4] SURGICAL EDIT TEST")
    edits = []   # (val_start, val_end, new_bytes, label)

    def set_plain_int(path, newval):
        rr = sc.members[path]
        old = raw[rr["val_start"]:rr["val_end"]]
        edits.append((rr["val_start"], rr["val_end"],
                      str(newval).encode(), "%s=%s (was %s)" %
                      (path, newval, old.decode())))
        return old

    def set_tagged_i64(path, newval):
        rr = sc.members[path]
        vr = sc.members.get(path + ".v")
        if vr is None or rr["type"] != "object":
            # Not a tagged {"t":...,"v":"..."} object in this save --
            # e.g. Properties.lives.current is the bare number 5 and
            # PlayerItems.BombAndLineBoost is the bare number 1776.
            # Patch the member's own value span instead (same as plain int).
            return set_plain_int(path, newval)
        old = raw[vr["val_start"]:vr["val_end"]]      # includes quotes
        inner = old[1:-1].decode()
        edits.append((vr["val_start"] + 1, vr["val_end"] - 1,
                      str(newval).encode(),
                      "%s -> %s (was %s)" % (path, newval, inner)))
        return old

    set_plain_int("Properties.coins", 999999999)
    set_plain_int("Properties.earnedStars", 5000)
    set_tagged_i64("Properties.lives.current", 99999)
    # pick a booster by its known PlayerItems key
    booster_path = None
    for p in sc.members:
        if p.startswith("PlayerItems.") and p.endswith(".BombAndLineBoost"):
            booster_path = p
            break
    log("    booster path : %s" % booster_path)
    if booster_path:
        set_tagged_i64(booster_path, 7777)

    edits.sort(key=lambda e: e[0])
    # overlap check
    for a, b in zip(edits, edits[1:]):
        assert a[1] <= b[0], "overlapping edits %s %s" % (a, b)

    out = bytearray(raw)
    # Byte spans are absolute in the SOURCE.  Applying edits lowest-offset
    # first into a mutating bytearray lets an earlier length-changing edit
    # shift the coordinates of every later edit (that corruption is what made
    # json.loads fail with "Expecting ',' delimiter").  Apply highest-offset
    # first so no already-recorded span can move; log in ascending order.
    for s, e, nb, _label in reversed(edits):
        out[s:e] = nb
    for s, e, nb, label in edits:
        log("    patch [%6d,%6d) len %d->%d : %s" %
            (s, e, e - s, len(nb), label))

    outb = bytes(out)
    log("    size %d -> %d (delta %+d)" % (len(raw), len(outb), len(outb) - len(raw)))

    # validate
    try:
        doc = json.loads(outb.decode("utf-8"))
        log("    JSON parse   : OK")
    except Exception as ex:
        log("    JSON parse   : FAILED %s" % ex)
        sys.exit(1)

    log("    coins        : %r" % doc["Properties"]["coins"])
    log("    level        : %r" % doc["Properties"]["level"])
    log("    earnedStars  : %r" % doc["Properties"]["earnedStars"])
    log("    spentStars   : %r" % doc["Properties"]["spentStars"])
    log("    lives.current: %r" % doc["Properties"]["lives.current"])
    if booster_path:
        tail = booster_path.split("PlayerItems.")[1]
        log("    booster      : %r" % doc["PlayerItems"][tail])

    # untouched regions byte-identical?
    changed = sum(1 for a, b in zip(raw, outb) if a != b)
    log("    differing bytes vs source: %d" % changed)

    with open(OUT, "wb") as f:
        f.write(outb)
    log("    wrote %s (%d bytes)" % (OUT, len(outb)))

    with open(RPT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("\nwrote report", RPT)


if __name__ == "__main__":
    main()
