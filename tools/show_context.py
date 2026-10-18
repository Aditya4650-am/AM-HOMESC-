# -*- coding: utf-8 -*-
"""Show surrounding context of literal matches so we can disambiguate them."""
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="")
p = r"C:\Users\User\Downloads\Telegram Desktop\SaveGame.db"
raw = open(p, "rb").read()
txt = raw.decode("utf-8")
needle = '"level": 655'
start = 0
while True:
    i = txt.find(needle, start)
    if i < 0:
        break
    print("=== occurrence at char", i, "===")
    print("... " + txt[i-260:i].replace("\n","\\n").replace("\r","\\r").replace("\t","\\t") + " <<HERE>> " + txt[i+len(needle):i+len(needle)+120].replace("\n","\\n").replace("\r","\\r").replace("\t","\\t") + " ...")
    print()
    start = i + 1
