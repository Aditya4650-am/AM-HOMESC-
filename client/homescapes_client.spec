# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Homescapes Save Studio Windows client.
# Mirrors the IGG VIP Studio client spec; produces an onedir folder
# "Homescapes Save Studio" so the auto-updater can swap it atomically.

import os

block_cipher = None
ROOT = os.path.abspath(os.path.dirname(SPECPATH))

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
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Homescapes Save Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Homescapes Save Studio",
)