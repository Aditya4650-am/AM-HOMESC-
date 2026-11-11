# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Homescapes Save Studio Windows client.
#
# ONEFILE — the deliverable is a single "Homescapes Save Studio.exe" the
# operator sends to clients: no zip, no folder, no extra files. The Python
# runtime, pywebview and the bundled adb are packed inside the EXE and
# extracted to a temp dir on launch. Persistent state (device id, server url)
# lives in %APPDATA%\Homescapes-Save-Studio — never inside the bundle — so
# every feature behaves exactly like the old foldered build, and the
# auto-updater swaps this one file in place (hc_client._swap_single_exe_bat).
#
# Mirrors the IGG VIP Studio client build; onefile is what the owner asked
# for: clients receive and double-click ONE file.

import os

block_cipher = None
# The spec lives in client/, so ROOT must be that directory — it used to be its
# parent, which meant `client/adb/` (where build_exe.bat tells you to put
# adb.exe) was never bundled and the shipped EXE could not find ADB at all.
ROOT = os.path.abspath(SPECPATH)

# adb ships INSIDE the exe: _find_adb() resolves it from sys._MEIPASS, which
# in a onefile build is the extraction dir — so Connect works on a clean client
# PC with nothing else beside the single file.
adb_dir = os.path.join(ROOT, "adb")
datas = []
if os.path.isdir(adb_dir):
    for name in os.listdir(adb_dir):
        p = os.path.join(adb_dir, name)
        if os.path.isfile(p):
            datas.append((p, "adb"))

# Optional fresh profile (browser profile seed) — shipped if present.
fresh = os.path.join(ROOT, "fresh_profile")
if os.path.isdir(fresh):
    datas.append((fresh, "fresh_profile"))

a = Analysis(
    ["hc_client.py"],
    pathex=[ROOT],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "webview",
        "webview.platforms.winforms",
        "clr",
        "pythonnet",
        "bottle",
        "proxy_tools",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Never used on Windows: pywebview selects the winforms backend (and
    # hiddenimports above pins it), while its Qt backend lives behind a
    # try/except that modulegraph still follows — pulling in ~50MB of Qt5 DLLs
    # for a backend this app never loads. PIL is the same story: nothing in
    # hc_client or the winforms backend touches it. Excluding them keeps the
    # single-file deliverable lean without touching any code path we run.
    excludes=[
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "PIL",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

# onefile: binaries + datas go straight into the EXE (no COLLECT folder).
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Homescapes Save Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
