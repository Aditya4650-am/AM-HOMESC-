# -*- coding: utf-8 -*-
"""Temporary helper: run the two analysis scripts and capture their raw
stdout/stderr bytes verbatim (PowerShell's '>' transcodes to UTF-16LE, which
is not the bytes the process actually wrote)."""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
for script, out in (("scan_spans.py", "_scan_stdout.txt"),
                    ("verify_all.py", "_verify_stdout.txt")):
    p = subprocess.run([sys.executable, script], cwd=HERE,
                       capture_output=True)
    with open(os.path.join(HERE, out), "wb") as f:
        f.write(p.stdout)
    err = p.stderr.decode("utf-8", "replace")
    print("%s -> exit %d, stdout %d bytes, stderr %d bytes"
          % (script, p.returncode, len(p.stdout), len(p.stderr)))
    if err.strip():
        print("--- stderr of %s ---" % script)
        print(err)
