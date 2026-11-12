# -*- coding: utf-8 -*-
"""
Homescapes Save Studio - Windows client.

Two roles, one file:

  * ADB bridge  — the Node server calls it as a subprocess in JSON mode:
        python client/hc_client.py devices
        python client/hc_client.py pull   --serial <s> [--out <path>]
        python client/hc_client.py push   --serial <s> --in <path> [--no-restart]
        python client/hc_client.py force-stop --serial <s>
        python client/hc_client.py start  --serial <s>
        python client/hc_client.py restore-backup --serial <s>
        python client/hc_client.py fresh-start-new-account --serial <s>
        python client/hc_client.py fresh-start-restore-account --serial <s>
      Every command prints exactly one JSON object on stdout.

  * Desktop shell — `python client/hc_client.py` with no arguments opens a
      native WebView2 window over the local studio server and exposes
      `window.hcNative` so the UI can drive ADB without a local HTTP round
      trip. (Requires the optional `pywebview` dependency.)

NO save algorithm lives here. All edit logic is server-side; this file only
moves bytes between the PC and the device. That split is deliberate: the
client is the part that ships to users, and it must not be able to corrupt a
save on its own.

The ADB helpers below (adb discovery, privileged pull fallbacks, on-device
path discovery, shell-error classification) are adapted from the proven
IGG VIP Studio client, re-targeted at Homescapes.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error as _urlerror
from urllib import parse as _urlparse
from urllib import request as _urlrequest

# The Playrix TS frame codec (AES + ts-id tag + LocalInfo decode). Sits next to
# this file so the desktop EXE bundles it; imported lazily-guarded so the ADB
# bridge still works even if it is missing, and cards report a clear error.
try:
    import ts_playrix_core as _tsx
except Exception:  # pragma: no cover
    _tsx = None

APP_NAME = "Homescapes Save Studio"
APP_VERSION = "0.1.0"
DEFAULT_SERVER_URL = "https://am-homesc-v3bt.onrender.com"

_ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_DEVICE_ID_RE = re.compile(r"^HSD(?:-[A-Z0-9]{4}){5}$")

def _mint_device_id() -> str:
    raw = os.urandom(20)
    chars = [_ALPH[b % len(_ALPH)] for b in raw]
    return "HSD-" + "-".join("".join(chars[i:i + 4]) for i in range(0, 20, 4))

def _app_data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "Homescapes-Save-Studio"

def get_device_id() -> str:
    p = _app_data_dir() / "device.id"
    try:
        existing = p.read_text(encoding="utf-8").strip().upper()
        if _DEVICE_ID_RE.match(existing):
            return existing
    except Exception:
        pass
    new_id = _mint_device_id()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(new_id, encoding="utf-8")
    except Exception:
        pass
    return new_id

def resolve_server_url() -> str:
    env = (os.environ.get("HC_STUDIO_URL") or "").strip()
    if env:
        return env.rstrip("/")
    try:
        txt = (_app_data_dir() / "server.txt").read_text(encoding="utf-8").strip()
        if txt:
            return txt.rstrip("/")
    except Exception:
        pass
    return DEFAULT_SERVER_URL

def normalize_base_url(url: str) -> str:
    raw = (url or "").strip()
    if not raw:
        return DEFAULT_SERVER_URL
    if "://" not in raw:
        raw = "https://" + raw
    try:
        from urllib.parse import urlsplit, urlunsplit
        u = urlsplit(raw)
    except ValueError:
        return DEFAULT_SERVER_URL
    host = u.hostname or ""
    if u.scheme not in ("http", "https") or not host:
        return DEFAULT_SERVER_URL
    return urlunsplit((u.scheme, u.netloc, "", "", ""))

def with_device_param(url: str, device_id: str) -> str:
    """Carry the machine's device id to the page on the window URL itself.

    pywebview defaults to `private_mode=True`, so WebView2 runs InPrivate and
    `localStorage` is empty at the start of every launch ("in private mode,
    cookies and local storage are not preserved"). The EXE also serves the UI
    from a loopback port that changes every launch, so the origin itself is
    different each time — there is no storage anywhere that survives. The web
    app's boot code therefore had nothing to read and minted a fresh random id
    on each start, which is exactly what made the id change on every restart
    and the key (bound to one id) stop matching the machine.

    Putting the id on the URL makes it available to the page synchronously,
    before React mounts: no bridge, no polling, no storage, no race. Any
    `did` already on the URL is replaced so the page can never see two.
    """
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    u = urlsplit(url)
    pairs = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if k != "did"]
    if device_id:
        pairs.append(("did", device_id))
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(pairs), u.fragment))

# pywebview exposes the api object as window.pywebview.api.*. The web app looks
# for window.hcNative.*, so we alias it as soon as the bridge is ready.
_ALIAS_JS = """
(function () {
  function install() {
    try {
      if (window.pywebview && window.pywebview.api && !window.hcNative) {
        window.hcNative = window.pywebview.api;
        window.dispatchEvent(new Event('hc-native-ready'));
      }
    } catch (e) {}
  }
  install();
  var n = 0;
  var t = setInterval(function () {
    install();
    if ((window.hcNative) || ++n > 50) clearInterval(t);
  }, 100);
})();
"""

# Homescapes ships as a single global package; the `.vn` variant follows the
# same layout if it ever appears.
GAME_PACKAGES = ["com.playrix.homescapes"]

# Confirmed from the reference editor's game descriptor and from the sample:
# the save is a JSON container sitting in the package's private storage.
SAVE_FILE = "SaveGame.db"
BACKUP_FILE = "SaveGame.db.bak"      # written by the GAME itself
TOOL_BACKUP_SUFFIX = ".hcsbak"       # our own pre-edit snapshot; the game never reads it

# Fresh Start touches EXACTLY these three files — the save, the backup the
# game itself writes and the buffer it writes before committing. The list is
# a fixed tuple, never a glob or a wildcard: `rm -f` on this device is only
# ever handed these three literal paths, so nothing else in the package's
# private storage can be caught up in it.
FRESH_FILES = (SAVE_FILE, SAVE_FILE + ".bak", SAVE_FILE + ".buf")
# Backup records kept on this PC: fresh-start-<epoch-ms>-<32 hex>.json
FRESH_BACKUP_RE = re.compile(r"^fresh-start-(\d+)-[0-9a-f]{32}\.json$")
FRESH_BACKUP_LIMIT = 96 * 1024 * 1024
FRESH_MAX_BYTES = 64 * 1024 * 1024

# Fallbacks only — the real path is discovered on the device (see _find_on_device).
_SAVE_SUBDIRS = ("", "files", "saves", "app_data")
_SAVE_BASES = (
    "/data/data/{pkg}",
    "/data/user/0/{pkg}",
    "/data/user_de/0/{pkg}",
    "/sdcard/Android/data/{pkg}/files",
    "/storage/emulated/0/Android/data/{pkg}/files",
)


def candidate_paths_for_package(pkg: str, filename: str) -> list[str]:
    """Candidate on-device paths for `filename`, most likely first."""
    out: list[str] = []
    for base in _SAVE_BASES:
        root = base.format(pkg=pkg)
        for sub in _SAVE_SUBDIRS:
            path = f"{root}/{sub}/{filename}" if sub else f"{root}/{filename}"
            if path not in out:
                out.append(path)
    return out


def fresh_backup_dir() -> Path:
    """Where this PC keeps the pre-fresh-start copies of a device's save."""
    return _app_data_dir() / "backups"


def write_fresh_backup(snapshot: dict) -> Path:
    """Persist a snapshot on THIS PC so a fresh start is always reversible.

    Written to a temp name and renamed into place: a crash mid-write can only
    ever leave a `.tmp` behind, never a half-filled record that a later
    restore would read as a good backup.
    """
    directory = fresh_backup_dir()
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"fresh-start-{int(time.time() * 1000)}-{os.urandom(16).hex()}.json"
    tmp = directory / f".pending-{os.urandom(8).hex()}.tmp"
    try:
        with open(tmp, "x", encoding="utf-8", newline="") as fh:
            fh.write(json.dumps(snapshot))
            fh.flush()
            os.fsync(fh.fileno())
        tmp.replace(target)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return target


def latest_fresh_backup(serial: str) -> Path | None:
    """Newest backup record on this PC that belongs to `serial`.

    Filenames carry an epoch-ms prefix, so sorting the names newest-first
    walks the records in the order they were taken. A record for a different
    device is skipped rather than returned — a client's PC may hold several.
    """
    directory = fresh_backup_dir()
    try:
        names = [n for n in os.listdir(directory) if FRESH_BACKUP_RE.match(n)]
    except OSError:
        return None
    for name in sorted(names, reverse=True):
        try:
            record = json.loads((directory / name).read_text(encoding="utf-8"))
        except Exception:
            continue  # a truncated record is simply not a candidate
        if isinstance(record, dict) and record.get("serial") == serial:
            return directory / name
    return None


# Real device paths discovered per (serial, package, filename), so a later
# push writes back to exactly where the pull came from.
_PATH_CACHE: dict[tuple[str, str, str], str] = {}
# Which package each device actually uses, so push targets the same one.
_ACTIVE_PACKAGE: dict[str, str] = {}


# ── adb discovery ────────────────────────────────────────────────────────────

# Emulator console/ADB ports, grouped so a raw serial can be labelled with the
# emulator and instance number the operator actually recognises.
#   MEmu        21503 + 10n (instances 1..10), plus 21503/21504/21505 for a
#                 default single-instance install
#   LDPlayer    62001 / 62025
#   Nox         7555
#   BlueStacks  5555 / 5554
# 5037 is adb's OWN server port and is deliberately NOT probed: `adb connect
# 127.0.0.1:5037` attaches to the daemon, not to a device, and yields a
# phantom entry. 5585/5597 were never a real emulator port either.
_EMULATOR_PORTS = [
    21503, 21513, 21523, 21533, 21543, 21553, 21563, 21573, 21583, 21593,
    21504, 21505,
    62001, 62025,
    7555,
    5555, 5554,
]

_MEMU_PORTS = {21503: 1, 21513: 2, 21523: 3, 21533: 4, 21543: 5,
               21553: 6, 21563: 7, 21573: 8, 21583: 9, 21593: 10}
_LDPLAYER_PORTS = {62001: 1, 62025: 2}


def _label_for(serial: str) -> str:
    """Human label for a serial — 'MEmu Instance 2' beats '127.0.0.1:21513'."""
    if ":" in serial:
        try:
            port = int(serial.rsplit(":", 1)[1])
        except ValueError:
            return serial
        if port in _MEMU_PORTS:
            return f"MEmu Instance {_MEMU_PORTS[port]}"
        if port in _LDPLAYER_PORTS:
            return f"LDPlayer {_LDPLAYER_PORTS[port]}"
        if port == 7555:
            return "Nox Player"
        if port in (5554, 5555):
            return "Android Emulator"
    return serial


def _find_adb() -> str | None:
    """Locate adb: bundled first, then PATH, then common emulator installs."""
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    candidates: list[Path] = [here / "adb" / "adb.exe", here / "adb.exe"]

    on_path = shutil.which("adb")
    if on_path:
        candidates.append(Path(on_path))

    local = os.environ.get("LOCALAPPDATA", "")
    roaming = os.environ.get("APPDATA", "")
    pf = os.environ.get("ProgramFiles", "C:\\Program Files")
    pfx = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
    home = str(Path.home())
    desktop = str(Path.home() / "Desktop")

    candidates += [
        Path(local) / "Android" / "Sdk" / "platform-tools" / "adb.exe",
        Path(pf) / "Android" / "platform-tools" / "adb.exe",
        Path(pf) / "Microvirt" / "MEmu" / "adb.exe",
        Path(pfx) / "Microvirt" / "MEmu" / "adb.exe",
        Path(local) / "Microvirt" / "MEmu" / "adb.exe",
        Path(roaming) / "Microvirt" / "MEmu" / "adb.exe",
        Path(pf) / "LDPlayer" / "adb.exe",
        Path(pf) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(pf) / "ldplayer9box" / "adb.exe",
        Path(pf) / "ldplayerbox" / "adb.exe",
        Path(pfx) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(local) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(local) / "ldplayer9box" / "adb.exe",
        Path(pf) / "Nox" / "bin" / "adb.exe",
        Path(pfx) / "Nox" / "bin" / "adb.exe",
        Path(local) / "Programs" / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(pf) / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(pfx) / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(local) / "Genymobile" / "Genymotion" / "tools" / "adb.exe",
        Path(home) / "platform-tools" / "adb.exe",
        Path(desktop) / "platform-tools" / "adb.exe",
        Path(home) / "Downloads" / "platform-tools" / "adb.exe",
    ]

    for c in candidates:
        try:
            if c and c.exists():
                return str(c)
        except OSError:
            continue
    return None


def _run_adb(adb: str, args: list[str], timeout: int = 30) -> tuple[int, bytes, bytes]:
    try:
        proc = subprocess.run(
            [adb] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, b"", b"adb timed out"
    except OSError as exc:
        return 1, b"", str(exc).encode("utf-8", "replace")


def _adb_devices(adb: str) -> list[dict]:
    code, out, _ = _run_adb(adb, ["devices"])
    if code != 0:
        return []
    result: list[dict] = []
    for line in out.decode("utf-8", "replace").splitlines()[1:]:
        line = line.strip()
        if not line or "\t" not in line:
            continue
        serial, state = line.split("\t", 1)
        serial = serial.strip()
        state = state.strip()
        # Only a fully ONLINE device can be pulled from. `offline` /
        # `unauthorized` / `no permissions` used to be dropped silently, which
        # presented as a bare "No device detected" with no reason — surface
        # them as a labelled, disabled-looking entry instead.
        if state == "device":
            result.append({"id": serial, "label": _label_for(serial)})
        elif state in ("offline", "unauthorized", "no permissions", "authorizing"):
            result.append({
                "id": serial,
                "label": f"{_label_for(serial)} — {state}",
            })
    return result


def _ensure_adb_ready(adb: str) -> list[dict]:
    """Start the adb server and auto-connect well-known emulator ports."""
    _run_adb(adb, ["start-server"], timeout=20)
    devices = _adb_devices(adb)
    if devices:
        return devices
    for port in _EMULATOR_PORTS:
        _run_adb(adb, ["connect", f"127.0.0.1:{port}"], timeout=8)
    return _adb_devices(adb)


# ── payload validation ───────────────────────────────────────────────────────

_PRINTABLE = frozenset(range(0x20, 0x7F)) | {0x09, 0x0A, 0x0D}
_SHELL_ERR_RE = re.compile(
    r"(permission denied|no such file|not found|is a directory|read-only"
    r"|operation not permitted|inaccessible|unknown option|not debuggable"
    r"|syntax error|usage:)",
    re.I,
)


def looks_like_save(buf: bytes) -> bool:
    """True when `buf` is a Homescapes save rather than shell diagnostics.

    Homescapes writes either plain JSON (leading `{` after whitespace) or an
    XOR-wrapped binary container. `adb exec-out` merges stderr into stdout, so
    a failed privileged read returns English text of arbitrary length — that
    text must never be accepted as a save.
    """
    if not buf or len(buf) < 16:
        return False
    head = buf[:512]
    if any(b == 0 for b in head):
        return True  # binary container
    if any(b not in _PRINTABLE for b in head):
        return True  # binary container
    stripped = head.lstrip(b"\xef\xbb\xbf \t\r\n")
    if stripped.startswith(b"{"):
        return True  # plain JSON
    return False


def _looks_like_shell_error(buf: bytes) -> bool:
    if not buf:
        return False
    if len(buf) > 64 and looks_like_save(buf):
        return False
    return bool(_SHELL_ERR_RE.search(buf[:200].decode("utf-8", "replace")))


# ── privileged I/O ───────────────────────────────────────────────────────────

def _pull_privileged(adb: str, serial: str, remote: str, diag: list[str] | None = None) -> bytes | None:
    """Read `remote` as root, trying every access path that emulators allow."""
    notes: list[str] = []

    def accept(out: bytes) -> bytes | None:
        if looks_like_save(out):
            return out
        text = out[:200].decode("utf-8", "replace").strip()
        if text:
            notes.append(text)
        return None

    for args in (
        ["-s", serial, "exec-out", "su", "-c", f"cat '{remote}'"],
        ["-s", serial, "exec-out", "su", "0", "cat", remote],
        ["-s", serial, "exec-out", "su", "-c", f'cat "{remote}"'],
    ):
        code, out, _ = _run_adb(adb, args, timeout=60)
        if code == 0:
            ok = accept(out)
            if ok is not None:
                return ok

    if remote.startswith("/data/data/"):
        pkg = remote.split("/data/data/")[1].split("/")[0]
        rel = remote.split(f"/data/data/{pkg}/", 1)[1]
        for args in (
            ["-s", serial, "exec-out", "run-as", pkg, "cat", rel],
            ["-s", serial, "exec-out", "su", "-c", f"run-as {pkg} cat {rel}"],
        ):
            code, out, _ = _run_adb(adb, args, timeout=60)
            if code == 0:
                ok = accept(out)
                if ok is not None:
                    return ok

    # Last resort: copy to a world-readable temp file, then adb pull it.
    tmp = "/data/local/tmp/hcs_pull_tmp.bin"
    code, _, _ = _run_adb(
        adb,
        ["-s", serial, "shell", f"su -c 'cp \"{remote}\" {tmp} && chmod 644 {tmp}'"],
        timeout=30,
    )
    if code == 0:
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / "pull.bin"
            code2, _, _ = _run_adb(adb, ["-s", serial, "pull", tmp, str(local)], timeout=60)
            if code2 == 0 and local.exists():
                ok = accept(local.read_bytes())
                if ok is not None:
                    return ok

    if diag is not None:
        diag.extend(notes)
    return None


def _find_on_device(adb: str, serial: str, pkg: str, filename: str) -> str | None:
    """Ask the device where `filename` really lives. Needs root."""
    roots = " ".join(
        base.format(pkg=pkg)
        for base in (
            "/data/data/{pkg}",
            "/data/user/0/{pkg}",
            "/data/user_de/{pkg}",
            "/sdcard/Android/data/{pkg}",
            "/storage/emulated/0/Android/data/{pkg}",
        )
    )
    scripts = [
        f"find {roots} -maxdepth 5 -name {filename} -type f 2>/dev/null | head -n 5",
        f"find {roots} -maxdepth 5 -iname '*{filename}*' -type f 2>/dev/null | head -n 10",
    ]
    for script in scripts:
        for args in (
            ["-s", serial, "exec-out", "su", "-c", script],
            ["-s", serial, "shell", f"su -c '{script}'"],
        ):
            code, out, _ = _run_adb(adb, args, timeout=25)
            if code != 0 or not out or _looks_like_shell_error(out):
                continue
            for line in out.decode("utf-8", "replace").splitlines():
                path = line.strip().lstrip("﻿")
                if path.startswith("/") and path.endswith(filename):
                    return path
    return None


# Playrix identifies a device by the Google Advertising ID: the very first
# GetSaveAndRegister of a session sends it as `deviceId`, and the server keys
# every save of that install off it.  Reading it back from GMS therefore lets
# us re-open the account without any on-disk LocalInfo (newer builds no longer
# write one at all).
_AAID_FILES = (
    "/data/data/com.google.android.gms/shared_prefs/adid_settings.xml",
    "/data/user/0/com.google.android.gms/shared_prefs/adid_settings.xml",
)


def _device_ad_id(adb: str, serial: str) -> str:
    """The install's advertising id, or "" when GMS is missing/unreadable."""
    # Every su spelling that has proven to work on rooted emulators — the
    # same set _pull_raw_file uses. Some builds' su only accepts `su 0 cat`,
    # others need the path quoted; trying just one form made the whole card
    # send fail with "could not read the device advertising id" on instances
    # where a different form works fine.
    forms = (
        ["-s", serial, "exec-out", "su", "-c", "cat '{p}'"],
        ["-s", serial, "exec-out", "su", "0", "cat", "{p}"],
        ["-s", serial, "shell", "su -c 'cat {p}'"],
        ["-s", serial, "exec-out", "su", "-c", 'cat "{p}"'],
    )
    for remote in (*_AAID_FILES,):
        for form in forms:
            args = [a.replace("{p}", remote) for a in form]
            code, out, _ = _run_adb(adb, args, timeout=20)
            if code != 0 or not out:
                continue
            txt = out.decode("utf-8", "replace")
            if _looks_like_shell_error(txt):
                continue
            m = re.search(
                r'name="adid_key"\s*value="([0-9a-fA-F-]{32,36})"', txt)
            if m:
                return m.group(1)
            m = re.search(r'\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
                          r'[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b', txt)
            if m:
                return m.group(1)
    # Last resort: the file may sit under a user-0 path we did not guess, or
    # GMS may be installed as a different package. Ask the device where it is.
    code, out, _ = _run_adb(
        adb,
        ["-s", serial, "exec-out", "su", "-c",
         "find /data -name adid_settings.xml 2>/dev/null"],
        timeout=30,
    )
    if code == 0 and out and not _looks_like_shell_error(out):
        for remote in out.decode("utf-8", "replace").split():
            if not remote.startswith("/"):
                continue
            for form in forms:
                args = [a.replace("{p}", remote) for a in form]
                code, out2, _ = _run_adb(adb, args, timeout=20)
                if code != 0 or not out2:
                    continue
                txt = out2.decode("utf-8", "replace")
                if _looks_like_shell_error(txt):
                    continue
                m = re.search(
                    r'name="adid_key"\s*value="([0-9a-fA-F-]{32,36})"', txt)
                if m:
                    return m.group(1)
                m = re.search(
                    r'\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
                    r'[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b', txt)
                if m:
                    return m.group(1)
    return ""


def _is_pkg_installed(adb: str, serial: str, pkg: str) -> bool:
    code, out, _ = _run_adb(adb, ["-s", serial, "shell", "pm", "path", pkg], timeout=10)
    return code == 0 and b"package:" in out


def _packages_for(serial: str) -> list[str]:
    preferred = _ACTIVE_PACKAGE.get(serial)
    out: list[str] = []
    for p in [preferred, *GAME_PACKAGES]:
        if p and p not in out:
            out.append(p)
    return out


# ── bridge ───────────────────────────────────────────────────────────────────

# ── cards (live game API) ─────────────────────────────────────────────────────
# Sending a card to yourself or a friend must travel Playrix's own SendBox, so
# the "card received" inbox/notification actually appears in-game — a save edit
# can only describe cards a city already holds, never deliver one. The frame
# codec lives in ts_playrix_core; these are the credentials + payload pieces.

# The Homescapes game API host and the active card-album event. Playrix serves
# each title on its own host and each card event has its own id/end-time, so
# every value is a default only — the web UI passes the real values from the
# server's HC_GAME_* config, which is why tuning them never needs a rebuild.
GAME_HOST_DEFAULT = "homescapes.playrix.com"
GAME_BVER = "9.2.601.10100292"
GAME_GVER = "9.2.5"
GAME_PVER = "F31A29B4"
GAME_USER_AGENT = "okhttp/3.12.13"

# The X-Signature key recovered from the shipping libgame.so (function
# 0x6d4b0e6 is a hand-rolled HMAC-SHA1: the key is copied into a 64-byte
# buffer, XOR'd with 0x36, fed through boost::uuids::detail::sha1 together
# with the raw request body, then re-hashed against the 0x5c pad).  The same
# constant verifies every captured /api/1 sample, so it is a build-wide
# literal rather than a per-account value.
_API1_HMAC_KEY = "0*~O*2V35NzUDNtS1vhnZfDNtHRv@@"

_API1_SIGN_SECRETS: dict[str, str] = {
    "homescapes.playrix.com": _API1_HMAC_KEY,
}
_API1_SIGN_FALLBACKS: list[str] = [
    _API1_HMAC_KEY,
]
CARD_COL_ID_DEFAULT = "CardsCollection7"  # card-album event id (from the live event)
CARD_COL_ET_DEFAULT = 1794560400     # event end-time (unix; API accepts stale)

# LocalInfo filenames to try, in order — the exact name varies by build.
LOCAL_INFO_FILES = ("mLocalInfo.xml", "LocalInfo.xml", "mGameInfo.xml")

# Pulled credentials per device serial; keyed so send/inbox reuse the token
# without re-reading LocalInfo. The token never leaves this process.
_CARD_CREDS: dict[str, dict] = {}


def _card_config(config: dict | None) -> dict:
    """Resolve host/event overrides from the UI (server env) over the defaults."""
    c = config or {}
    host = str(c.get("host") or GAME_HOST_DEFAULT).strip() or GAME_HOST_DEFAULT
    col_id = str(c.get("colId") or "").strip() or CARD_COL_ID_DEFAULT
    try:
        col_et = int(c.get("colEt") or CARD_COL_ET_DEFAULT)
    except Exception:
        col_et = CARD_COL_ET_DEFAULT
    return {"host": host, "colId": col_id, "colEt": col_et}


def _api1_secret_for(host: str, endpoint: str, token: str) -> str:
    s = _API1_SIGN_SECRETS.get(host, "")
    if s:
        return s
    for fb in _API1_SIGN_FALLBACKS:
        if fb:
            return fb
    return ""


def _api1_signature(body_str: str, secret: str = "") -> str:
    """X-Signature: lowercase hex HMAC-SHA1(key, exact request body bytes).

    This mirrors the game's own signer (libgame.so 0x6d4b0e6): the key is
    XOR-padded to the SHA-1 block size with 0x36, the raw body is hashed
    against it, and the digest is re-hashed against the 0x5c pad.  Only the
    body is signed — neither the URL nor the headers take part — which is why
    a body we send byte-for-byte identically reproduces the game's header.
    """
    key = (secret or _API1_HMAC_KEY).encode("utf-8", "replace")
    return hmac.new(key, body_str.encode("utf-8", "replace"), hashlib.sha1).hexdigest()


def _api1_url(endpoint: str, host: str, bver: str, save_id: str = "", query: str = "") -> str:
    url = f"https://{host}/api/1/{endpoint}"
    qs = f"?bver={bver}"
    if save_id:
        qs += f"&saveId={save_id}"
    if query:
        qs += ("&" if "?" in qs else "?") + query.lstrip("?")
    return url + qs


def _card_api(
    endpoint: str,
    body: dict,
    cfg: dict,
    *,
    bver: str,
    fver: str,
    token: str,
    query: str = "",
    save_id: str = "",
) -> dict:
    """One real POST to Playrix's /api/1 JSON endpoint (X-Signature + X-Request-ID)."""
    body_str = json.dumps(body, separators=(",", ":"))
    host = str(cfg.get("host") or GAME_HOST_DEFAULT).strip() or GAME_HOST_DEFAULT
    url = _api1_url(endpoint, host, bver, save_id or "", query)
    secret = _api1_secret_for(host, endpoint, token)
    sig = _api1_signature(body_str, secret)
    # The game mints a random RFC-4122 UUID here (libgame.so 0x6d2ac28), and
    # the server only echoes it back — it is not part of the signature — but
    # matching the shape keeps every header byte-for-byte identical to a real
    # client, so an unexpected validator can never tell the two apart.
    rid = str(uuid.uuid4())
    headers = {
        "Content-Type": "application/json",
        "x-request-id": rid,
        "x-signature": sig,
        "x-version": str(cfg.get("gver") or GAME_GVER),
        "user-agent": GAME_USER_AGENT,
    }
    # Playrix attaches the session token to every authenticated /api/1 call
    # (it is absent only from the pre-login handshake), so mirror that here.
    if token:
        headers["hs-token"] = token
    rq = _urlrequest.Request(
        url,
        data=body_str.encode("utf-8", "replace"),
        method="POST",
        headers=headers,
    )
    status = 0
    raw = ""
    try:
        with _urlrequest.urlopen(rq, timeout=20) as resp:
            status = int(resp.status)
            raw = resp.read().decode("utf-8", "replace")
    except Exception as exc:
        status = int(getattr(exc, "code", 0) or 0)
        # urllib raises for 4xx/5xx but keeps the response body on the error
        # object — read it, otherwise every rejection looks like a bare
        # "HTTPError: HTTP Error 400: Bad Request" with no server reason.
        body_txt = ""
        try:
            body_txt = exc.read().decode("utf-8", "replace")  # type: ignore[attr-defined]
        except Exception:
            body_txt = ""
        raw = body_txt or f"{type(exc).__name__}: {exc}"
    resp_json: dict = {}
    txt = raw.strip()
    if txt[:1] in ("{", "["):
        try:
            resp_json = json.loads(txt)
        except Exception:
            resp_json = {}
    return {
        "ok": status in (200, 201, 204),
        "status": status,
        "resp": resp_json if isinstance(resp_json, dict) else {},
        "error": "" if status in (200, 201, 204) else (str(resp_json)[:200] if resp_json else txt[:300]),
        "raw": txt[:300],
    }


def _probe_host(host: str) -> dict:
    """POST a tiny body at CheckCity to see if host+path is alive.

    Pure routing probe — no token, no codec — so it answers in one glance:
    401/403 = host + path correct (auth layer reached), 404 = wrong path,
    a throw = wrong host / offline.
    """
    if _tsx is None:
        return {"ok": False, "host": host, "url": "", "status": 0,
                "error": "frame codec not available", "hint": ""}
    url = _tsx.api_url("CheckCity", host)
    rq = _urlrequest.Request(
        url,
        data=b"\x00\x01\x02\x03",
        method="POST",
        headers={"Content-Type": "application/octet-stream", "User-Agent": "hc-client"},
    )
    status = 0
    try:
        with _urlrequest.urlopen(rq, timeout=8) as resp:
            status = resp.status
    except Exception as exc:
        status = int(getattr(exc, "code", 0) or 0)
        if not status:
            return {"ok": False, "host": host, "url": url, "status": 0,
                    "error": str(exc)[:200], "hint": "network/DNS error — host is wrong"}
    if status in (401, 403):
        hint, ok = "host + path OK (auth layer reached)", True
    elif status == 404:
        hint, ok = "wrong API path on this host", False
    else:
        hint, ok = f"HTTP {status}", status == 200
    return {"ok": ok, "host": host, "url": url, "status": status,
            "error": "", "hint": hint}


def _attr(attrs: str, name: str) -> str:
    m = re.search(rf'\b{re.escape(name)}="([^"]*)"', attrs, re.I)
    return m.group(1) if m else ""


def _attr_first(tag: str, names: tuple[str, ...]) -> str:
    for n in names:
        v = _attr(tag, n)
        if v:
            return v
    return ""


def _parse_card_creds(xml: str) -> dict:
    """Own account credentials out of a decoded LocalInfo document."""
    aws = re.search(r"<AWS\b([^>]*)>", xml, re.I)
    a = aws.group(1) if aws else ""
    city = _attr(a, "cityId") or _attr(xml, "cityId") or _attr(xml, "cityid")
    token = _attr(a, "token") or _attr(xml, "token")
    ver = re.search(r"<Version\b([^>]*?)/?>", xml, re.I)
    va = ver.group(1) if ver else ""
    bver = _attr(va, "version") or _attr(xml, "version")
    fver = _attr(va, "FVer") or _attr(xml, "fver") or _attr(xml, "FVer")
    # Display name: a chat msg the city itself sent carries fromName.
    name = ""
    if city:
        m = re.search(rf'<msg\b[^>]*\bfromId="{re.escape(city)}"[^>]*>', xml, re.I)
        if m:
            name = _attr(m.group(0), "fromName") or _attr(m.group(0), "fromname")
    return {"cityId": city, "token": token, "bver": bver, "fver": fver,
            "name": name, "pic": ""}


def _parse_card_friends(xml: str, own: str) -> list[dict]:
    """Friend roster from LocalInfo (id + display name + level). Drops self."""
    out: dict[str, dict] = {}
    for m in re.finditer(r"<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>", xml):
        tag = m.group(0)
        if re.match(r"</?(?:InvitedFriends|Global|root|Save)\b", tag, re.I):
            continue
        fid = _attr_first(tag, ("city_id", "cityid", "fromid", "id"))
        if not re.fullmatch(r"[A-Za-z0-9]+", fid):
            continue
        name = _attr_first(tag, ("city_name", "cityname", "name", "displayname",
                                 "playername", "nickname", "nick"))
        level_raw = _attr_first(tag, ("level", "citylevel", "playerlevel"))
        if not name and not level_raw:
            continue
        level = int(level_raw) if level_raw.isdigit() else 0
        prev = out.get(fid)
        if not prev or (prev["name"] == fid and name != fid) or (prev["level"] == 0 and level > 0):
            out[fid] = {"id": fid, "name": name or fid, "level": level}
    if not out:  # variants that expose only cityId
        for m in re.finditer(r'\bcityId="([A-Za-z0-9]+)"', xml, re.I):
            fid = m.group(1)
            out.setdefault(fid, {"id": fid, "name": fid, "level": 0})
    out.pop(own, None)
    return list(out.values())


def _card_set(card_id: str) -> str:
    """`card_12` → `set_02` (ten cards per set, matching the save's own ids)."""
    m = re.match(r"card_0*(\d+)$", card_id)
    n = int(m.group(1)) if m else 1
    return f"set_{((n - 1) // 10) + 1:02d}"


def _now_ms() -> int:
    return int(time.time() * 1000)


class ClientError(RuntimeError):
    """Raised for anything the user can act on; message is shown verbatim."""


class HomescapesClient:
    def adb_info(self) -> dict:
        adb = _find_adb()
        if not adb:
            return {"found": False, "path": "", "devices": [], "message": "adb not found"}
        devices = _ensure_adb_ready(adb)
        return {
            "found": True,
            "path": adb,
            "devices": devices,
            "message": "ok" if devices else "adb found but no device connected",
        }

    def devices(self) -> list[dict]:
        adb = _find_adb()
        if not adb:
            return []
        return _ensure_adb_ready(adb)

    def force_stop(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            return {"ok": False, "package": "", "error": "adb not found"}
        errs: list[str] = []
        for pkg in _packages_for(serial):
            code, _, err = _run_adb(
                adb, ["-s", serial, "shell", "am", "force-stop", pkg], timeout=10
            )
            if code == 0:
                _ACTIVE_PACKAGE[serial] = pkg
                return {"ok": True, "package": pkg}
            errs.append(f"{pkg}: {err.decode('utf-8', 'replace').strip()}")
        return {"ok": False, "package": "", "error": " | ".join(errs)}

    def start(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise ClientError("adb not found")
        for pkg in _packages_for(serial):
            code, _, err = _run_adb(
                adb,
                [
                    "-s", serial, "shell", "monkey", "-p", pkg,
                    "-c", "android.intent.category.LAUNCHER", "1",
                ],
                timeout=15,
            )
            if code == 0:
                _ACTIVE_PACKAGE[serial] = pkg
                return {"ok": True, "package": pkg}
        raise ClientError("could not launch Homescapes: " + err.decode("utf-8", "replace").strip())

    # ── auto-update ──────────────────────────────────────────────────────────
    # The EXE is a thin shell: it loads the UI from the server, so a UI deploy
    # reaches every installed copy with no rebuild. Only a change to the BINARY
    # ships a release EXE; the web app polls the server for it and calls
    # installUpdate. version() lets the web app decide whether it is newer.

    def version(self) -> str:
        return APP_VERSION

    def deviceId(self) -> str:
        """This machine's device id, file-backed and stable across launches.

        Lives in %APPDATA%\\Homescapes-Save-Studio\\device.id — the same value
        every time this EXE starts on this PC, so a key bound to it keeps
        matching. The page reads it from `?did=` on the URL first (synchronous,
        before React mounts); this bridge method is the fallback for builds
        that predate that, and the proof for the UI that the id is real.
        """
        try:
            return get_device_id()
        except Exception:
            return ""

    def installUpdate(self, release: dict) -> dict:
        """Download a verified release and swap this EXE in place.

        The download's SHA-256 must match the published one or nothing is
        written. The current release is the single-file EXE and swaps itself
        in place; a legacy foldered (onedir) zip still swaps its whole install
        folder. Either way a tiny .cmd does the swap after this process exits,
        then relaunches.
        """
        try:
            url = str(release["downloadUrl"])
            expected = str(release.get("sha256", "")).lower().strip()
            version = str(release.get("version", "")).strip()
        except Exception:
            return {"ok": False, "reason": "invalid release payload"}
        if not url:
            return {"ok": False, "reason": "no download url published"}
        if not getattr(sys, "frozen", False):
            return {"ok": False, "reason": "not packaged (dev run)"}

        current_exe = Path(sys.executable).resolve()
        install_dir = current_exe.parent

        try:
            req = _urlrequest.Request(url, headers={"User-Agent": "hc-client"})
            with _urlrequest.urlopen(req, timeout=300) as resp:
                payload = resp.read()
        except Exception as exc:
            return {"ok": False, "reason": f"download failed: {exc}"}

        import hashlib

        got = hashlib.sha256(payload).hexdigest()
        if expected and got != expected:
            return {"ok": False, "reason": f"checksum mismatch: got {got}, want {expected}"}

        import io
        import zipfile

        if zipfile.is_zipfile(io.BytesIO(payload)):
            with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                names = zf.namelist()
                if _release_zip_is_folder(names):
                    return self._swap_folder_release(zf, install_dir, current_exe, version)
                exe_names = [n for n in names if n.lower().endswith(".exe")]
                if not exe_names:
                    return {"ok": False, "reason": "no exe inside the release zip"}
                new_exe = install_dir / f"{current_exe.stem}-{version or 'new'}.exe"
                with zf.open(exe_names[0]) as src, open(new_exe, "wb") as out:
                    out.write(src.read())
                return self._begin_swap(new_exe, install_dir, current_exe, version)
        # Bare-exe payload (not zipped) — legacy single-file release.
        new_exe = install_dir / f"{current_exe.stem}-{version or 'new'}.exe"
        new_exe.write_bytes(payload)
        return self._begin_swap(new_exe, install_dir, current_exe, version)

    def _swap_folder_release(self, zf, install_dir: Path, current_exe: Path, version: str) -> dict:
        staged = Path(tempfile.mkdtemp(prefix="hc-update-"))
        try:
            zf.extractall(staged)
        except Exception as exc:
            return {"ok": False, "reason": f"extract failed: {exc}"}
        entries = list(staged.iterdir())
        # A release zipped as "Homescapes Save Studio/..." wraps everything in
        # one top folder; descend into it so the tree lands on install_dir.
        root = entries[0] if len(entries) == 1 and entries[0].is_dir() else staged
        bat = install_dir / f"{current_exe.stem}-update.cmd"
        bat.write_text(
            _wait_then_swap_bat(str(root), str(install_dir), current_exe.name),
            encoding="ascii",
        )
        return self._launch_updater(bat, install_dir, version)

    def _begin_swap(self, new_exe: Path, install_dir: Path, current_exe: Path, version: str) -> dict:
        bat = install_dir / f"{current_exe.stem}-update.cmd"
        bat.write_text(
            _swap_single_exe_bat(str(new_exe), str(install_dir / current_exe.name)),
            encoding="ascii",
        )
        return self._launch_updater(bat, install_dir, version)

    def _launch_updater(self, bat: Path, install_dir: Path, version: str) -> dict:
        try:
            subprocess.Popen(
                ["cmd", "/c", str(bat)],
                cwd=str(install_dir),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
                | getattr(subprocess, "DETACHED_PROCESS", 0),
            )
        except Exception as exc:
            return {"ok": False, "reason": f"could not start updater: {exc}"}
        # Give the .cmd a moment to start, then leave so it can swap us out.
        threading.Timer(0.6, lambda: os._exit(0)).start()
        return {"ok": True, "version": version}

    # ── cards (live game API) ────────────────────────────────────────────────
    # These speak Playrix's own SendBox/CheckCity so a delivered card really
    # shows up in the in-game inbox. Host/event come from the config param
    # (server env → web → here), the token comes from a prior cardsLoad, and
    # nothing here reads or writes the save.

    def _pull_raw_file(self, adb: str, serial: str, remote: str) -> bytes | None:
        """Read any small file as root. Unlike _pull_privileged (which only
        accepts save-shaped bytes) this takes whatever comes back, as long as
        it is not a shell error — LocalInfo is XML/encoded, not a save."""
        for args in (
            ["-s", serial, "exec-out", "su", "-c", f"cat '{remote}'"],
            ["-s", serial, "exec-out", "su", "0", "cat", remote],
            ["-s", serial, "exec-out", "su", "-c", f'cat "{remote}"'],
        ):
            code, out, _ = _run_adb(adb, args, timeout=30)
            if code == 0 and out and not _looks_like_shell_error(out):
                return out
        if remote.startswith("/data/data/"):
            pkg = remote.split("/data/data/")[1].split("/")[0]
            rel = remote.split(f"/data/data/{pkg}/", 1)[1]
            code, out, _ = _run_adb(adb, ["-s", serial, "exec-out", "run-as", pkg, "cat", rel], timeout=30)
            if code == 0 and out and not _looks_like_shell_error(out):
                return out
        return None

    def _local_info_xml(self, serial: str) -> str:
        """Find + pull + decode the device's LocalInfo. "" when absent."""
        if _tsx is None:
            raise ClientError("frame codec not available (ts_playrix_core missing)")
        adb = _find_adb()
        if not adb:
            raise ClientError("adb not found - connect an emulator first")
        _ensure_adb_ready(adb)
        for pkg in _packages_for(serial):
            if not _is_pkg_installed(adb, serial, pkg):
                continue
            for fname in LOCAL_INFO_FILES:
                ordered: list[str] = []
                for path in (_find_on_device(adb, serial, pkg, fname),
                             *candidate_paths_for_package(pkg, fname)):
                    if path and path not in ordered:
                        ordered.append(path)
                for remote in ordered:
                    buf = self._pull_raw_file(adb, serial, remote)
                    if buf and len(buf) >= 16:
                        try:
                            return _tsx.decode_local_info(buf)
                        except ValueError:
                            continue
        return ""

    def cardsTest(self, config: dict | None = None) -> dict:
        """Probe the configured host — one glance at `status` tells you if the
        host is right: 401/403 = OK, 404 = wrong path, 0 = wrong host."""
        cfg = _card_config(config)
        return _probe_host(cfg["host"])

    def _register_creds(self, serial: str, cfg: dict) -> dict:
        """Re-open the account through Playrix's own login call.

        `GetSaveAndRegister` is what the game itself fires on launch: given the
        install's advertising id it answers with every save bound to that
        device — saveId, session token, versions, name, level and the live
        card inbox.  No LocalInfo file is involved, which matters because
        recent builds stopped writing one.
        """
        adb = _find_adb()
        if not adb:
            raise ClientError("adb not found - connect an emulator first")
        _ensure_adb_ready(adb)
        device_id = _device_ad_id(adb, serial)
        if not device_id:
            raise ClientError(
                "could not read the device advertising id — root the emulator "
                "and open Homescapes once, then Refresh")
        body = {
            "bver": GAME_BVER,
            "deviceId": device_id,
            "gver": GAME_GVER,
            "platform": "g",
            "pver": GAME_PVER,
            "ts": time.time(),
        }
        r = _card_api("GetSaveAndRegister", body, cfg,
                      bver=GAME_BVER, fver=GAME_GVER, token="", save_id="")
        if not r.get("ok") or not isinstance(r.get("resp"), dict):
            status = int(r.get("status") or 0)
            raise ClientError(
                r.get("error") or f"GetSaveAndRegister: HTTP {status}")
        saves = r["resp"].get("result", {}).get("saves")
        saves = [s for s in saves if isinstance(s, dict)] if isinstance(saves, list) else []
        if not saves:
            raise ClientError(
                "Playrix knows no save for this device — open Homescapes once "
                "and let it reach the main screen, then Refresh")
        # One install normally has one save; if a device carries several, take
        # the most recently played rather than an arbitrary first entry.
        def _upd(s: dict) -> int:
            try:
                return int(s.get("updAt") or 0)
            except Exception:
                return 0
        save = max(saves, key=_upd)
        token = str(save.get("token") or "")
        city_id = str(save.get("saveId") or "")
        if not token or not city_id:
            raise ClientError("Playrix returned a save without a token — retry")
        try:
            fver = str(int(save.get("fver") or 0))
        except Exception:
            fver = str(save.get("fver") or "")
        boxes = save.get("boxes")
        return {
            "cityId": city_id,
            "token": token,
            "bver": str(save.get("bver") or GAME_BVER),
            "fver": fver,
            "name": str(save.get("name") or ""),
            "level": int(save.get("plevel") or 0),
            "deviceId": device_id,
            "boxes": boxes if isinstance(boxes, list) else [],
            "saves": len(saves),
        }

    def _ensure_creds(self, serial: str, config: dict | None) -> dict:
        """Cached account credentials for this device — register once.

        Both the per-card sender and the batch preflight go through here, so a
        successful registration happens exactly once per process and a failed
        one raises a single ClientError instead of being retried for every
        (card, friend) pair.
        """
        creds = _CARD_CREDS.get(serial)
        if creds:
            return creds
        cfg = self._card_cfg(serial, config)
        fresh = self._register_creds(serial, cfg)
        _CARD_CREDS[serial] = {
            "cityId": fresh["cityId"], "token": fresh["token"],
            "bver": fresh["bver"], "fver": fresh["fver"],
            "name": fresh["name"], "pic": "",
            "deviceId": fresh.get("deviceId") or "",
            "host": cfg["host"], "colId": cfg["colId"], "colEt": cfg["colEt"],
        }
        return _CARD_CREDS[serial]

    def cardsLoad(self, serial: str, config: dict | None = None) -> dict:
        """Re-open the account, stash the token, and confirm it with CheckCity.

        Returns the public account view only (cityId, versions, name, level,
        inbox) — never the token, which stays in _CARD_CREDS.
        """
        cfg = _card_config(config)
        try:
            creds = self._register_creds(serial, cfg)
        except ClientError as exc:
            return {"ok": False, "error": str(exc)}
        view = {
            "cityId": creds["cityId"],
            "bver": creds["bver"],
            "fver": creds["fver"],
            "name": creds["name"],
            "level": creds["level"],
            "friends": [],
            "boxes": len(creds["boxes"]),
            "checkedAt": 0,
            "checkError": None,
        }
        # Real FetchSave: proves the freshly-minted token is accepted for
        # authenticated calls before the first send.  (There is no CheckCity on
        # this build — every probe of it answers 404.)
        r = _card_api("FetchSave",
                      {"dkey": "SaveGame.db", "saveId": creds["cityId"],
                       "sources": ["deviceId"]},
                      cfg, bver=creds["bver"], fver=creds["fver"],
                      token=creds["token"], save_id=creds["cityId"])
        if r.get("ok"):
            view["checkedAt"] = _now_ms()
        else:
            status = int(r.get("status") or 0)
            view["checkError"] = (
                "token rejected (401) — Refresh again" if status == 401
                else f"FetchSave: {r.get('error') or 'HTTP ' + str(status)}"
            )
        _CARD_CREDS[serial] = {
            "cityId": creds["cityId"], "token": creds["token"],
            "bver": creds["bver"], "fver": creds["fver"],
            "name": view["name"], "pic": "",
            "deviceId": creds.get("deviceId") or "",
            "host": cfg["host"], "colId": cfg["colId"], "colEt": cfg["colEt"],
        }
        return {"ok": True, **view}

    def cardsSend(self, serial: str, to_city_id: str, card_id: str,
                  config: dict | None = None) -> dict:
        """Deliver one card via SaveBox. Returns sent / rejected / error with a
        human reason; 403 (anti-abuse cadence) is retried, 401 (bad token) is
        not, because retrying cannot fix a token."""
        if not re.fullmatch(r"card_\d{2,3}", str(card_id or "")):
            return {"ok": False, "status": "error", "error": f"bad card id {card_id!r}"}
        if not re.fullmatch(r"[A-Za-z0-9]{4,24}", str(to_city_id or "")):
            return {"ok": False, "status": "error", "error": f"bad recipient id {to_city_id!r}"}
        creds = _CARD_CREDS.get(serial)
        # Config precedence: explicit param (current server env) → what
        # cardsLoad stashed (host must match the load that minted the token)
        # → built-in defaults.
        cfg = self._card_cfg(serial, config)
        if not creds:
            # The bridge is a one-shot process, so a send can legitimately arrive
            # with nothing cached — open the account on demand instead of making
            # every caller remember to Refresh first.
            try:
                creds = self._ensure_creds(serial, config)
            except ClientError as exc:
                return {"ok": False, "status": "error", "error": str(exc)}
        col_id = cfg["colId"]
        # The box Playrix stores verbatim on the recipient — the exact camelCase
        # shape GetSaveAndRegister echoes back in its `boxes` array.  `si` is the
        # SENDER's save id and `from` the sender's profile, because the recipient
        # is the account that ends up holding this object.
        box = {
            "afg": 0,
            "bt": 5,
            "cardId": card_id,
            "colId": col_id,
            "friendType": "friend",
            "from": {
                "avatarId": str(creds.get("avatarId") or "17"),
                "avatarStyle": str(creds.get("avatarStyle") or "default"),
                "badgeId": str(creds.get("badgeId") or "default"),
                "frameId": str(creds.get("frameId") or "dragon_nest_frame_1"),
                "name": creds.get("name") or "",
            },
            "seed": str(random.randint(100000000, 999999999)),
            "sendCounter": 1,
            "sendType": "collection",
            "setId": _card_set(card_id),
            "si": creds["cityId"],
        }
        # `SaveBox` (not `SendBox` — that is only the log tag) takes the recipient
        # as `to_saveId`; the server rejects the call outright without it.
        body = {
            "saveId": creds["cityId"],
            "to_saveId": to_city_id,
            "box": json.dumps(box, separators=(",", ":")),
        }
        query = f"?cityId={creds['cityId']}"
        retried = 0
        for attempt in range(3):
            r = _card_api("SaveBox", body, cfg,
                          bver=creds["bver"], fver=creds["fver"],
                          token=creds["token"], query=query, save_id=creds["cityId"])
            if r.get("ok") and isinstance(r.get("resp"), dict):
                result = r["resp"].get("result")
                if isinstance(result, dict):
                    return {"ok": True, "status": "sent", "retried": retried}
                if result is None:  # recipient city does not exist → dropped
                    return {"ok": True, "status": "rejected", "retried": retried}
                return {"ok": False, "status": "error", "retried": retried,
                        "error": json.dumps(r["resp"])[:160]}
            status = int(r.get("status") or 0)
            if status == 403 and attempt < 2:
                retried += 1
                time.sleep(1.5)
                continue
            if status == 401:
                return {"ok": False, "status": "error", "http": 401, "retried": retried,
                        "error": "token rejected (401) — refresh LocalInfo"}
            if status == 403:
                return {"ok": False, "status": "error", "http": 403, "retried": retried,
                        "error": "temporarily blocked (403) — increase delay"}
            return {"ok": False, "status": "error", "http": status, "retried": retried,
                    "error": r.get("error") or f"HTTP {status}"}
        return {"ok": False, "status": "error", "retried": retried,
                "error": "retries exhausted (403)"}

    def _card_cfg(self, serial: str, config: dict | None) -> dict:
        """Config precedence exactly as cardsSend uses it: explicit param →
        what cardsLoad stashed (host must match the load that minted the
        token) → built-in defaults."""
        creds = _CARD_CREDS.get(serial)
        if config:
            return _card_config(config)
        if creds and creds.get("host"):
            return {"host": creds["host"], "colId": creds["colId"],
                    "colEt": creds["colEt"]}
        return _card_config(None)

    def cardsSendAll(self, serial: str, card_ids: list[str], friend_ids: list[str],
                     config: dict | None = None, delay_ms: int = 0) -> dict:
        """Send every card in card_ids to every friend in friend_ids via SendBox.

        Each (card, friend) pair is one real SendBox round-trip so the in-game
        "card received" popup fires for the actual recipient. No warning dialogs,
        no abort-on-first-failure — individual failures are reported per pair.
        """
        sent = 0
        failed: list[dict] = []
        results: list[dict] = []
        throttle_strikes = 0
        if not friend_ids:
            return {"ok": False, "status": "error", "error": "no friends to send to"}
        cards = [c for c in (card_ids or []) if re.fullmatch(r"card_\d{2,3}", str(c))]
        if not cards:
            return {"ok": False, "status": "error", "error": "no valid card ids to send"}
        # Open the account ONCE up front. Registering lazily inside cardsSend
        # meant a broken device (no root / no GMS / Playrix knows no save)
        # re-ran a full adb + GetSaveAndRegister round-trip for every one of
        # the N*M pairs — 450 identical failures, minutes of dead time, and a
        # reply no human can read. One preflight = one clear reason.
        if serial not in _CARD_CREDS:
            try:
                self._ensure_creds(serial, config)
            except ClientError as exc:
                return {"ok": False, "status": "error", "error": str(exc)}
        for card_id in cards:
            for friend_id in friend_ids:
                res = self.cardsSend(serial, friend_id, card_id, config)
                results.append({"card_id": card_id, "to": friend_id, "res": res})
                if res.get("ok"):
                    sent += 1
                else:
                    failed.append({"card_id": card_id, "to": friend_id, "res": res})
                    err = str((res.get("error") or "").lower())
                    # Credential-level failures are identical for every
                    # remaining pair — stop instead of repeating an unfixable
                    # error N*M times.
                    if res.get("http") == 401 or "token rejected" in err \
                            or "advertising id" in err:
                        for c2 in cards:
                            for f2 in friend_ids:
                                if c2 == card_id and f2 == friend_id:
                                    continue
                                if any(r["card_id"] == c2 and r["to"] == f2
                                       for r in results):
                                    continue
                                results.append({"card_id": c2, "to": f2,
                                                "res": {"ok": False, "status": "skipped",
                                                        "error": f"aborted: {res.get('error')}"}})
                                failed.append({"card_id": c2, "to": f2,
                                               "res": {"ok": False, "status": "skipped",
                                                       "error": f"aborted: {res.get('error')}"}})
                        break
                    # 403 = Playrix cadence limit. Back off (never abort the
                    # whole batch on a rate limit) and keep going; only give
                    # up once it is clearly persistent.
                    if res.get("http") == 403 or "temporarily blocked" in err \
                            or "retries exhausted" in err:
                        throttle_strikes += 1
                        if throttle_strikes >= 6:
                            for c2 in cards:
                                for f2 in friend_ids:
                                    if any(r["card_id"] == c2 and r["to"] == f2
                                           for r in results):
                                        continue
                                    res2 = {"ok": False, "status": "skipped",
                                            "error": "aborted: Playrix is rate-limiting this account "
                                                     "— raise the delay and retry"}
                                    results.append({"card_id": c2, "to": f2, "res": res2})
                                    failed.append({"card_id": c2, "to": f2, "res": res2})
                            break
                        time.sleep(min(6.0 * throttle_strikes, 15.0))
                    else:
                        throttle_strikes = 0
                # Pace the batch. Playrix throttles a burst of SaveBox calls
                # (403 cadence), so the UI's Delay field is honoured here —
                # without it a 150-card batch fired all at once and the tail
                # came back "temporarily blocked".
                if delay_ms > 0 and (sent + len(failed)) < len(cards) * len(friend_ids):
                    time.sleep(min(delay_ms, 10_000) / 1000.0)
            else:
                continue
            break
        return {
            "ok": len(failed) == 0,
            "status": "sent" if not failed else "partial",
            "sent": sent,
            "total": len(cards) * len(friend_ids),
            "failed": failed,
            "results": results,
        }

    def cardsInbox(self, serial: str, config: dict | None = None) -> dict:
        """Fresh inbox from GetSaveAndRegister — the same call the game makes on
        launch, so `boxes` is exactly what the recipient's game would show."""
        creds = _CARD_CREDS.get(serial)
        if not creds:
            # Same one-shot-process rule as cardsSend: open on demand.
            if config:
                cfg0 = _card_config(config)
            else:
                cfg0 = _card_config(None)
            try:
                loaded = self._register_creds(serial, cfg0)
            except ClientError as exc:
                return {"ok": False, "error": str(exc)}
            creds = {
                "cityId": loaded["cityId"], "token": loaded["token"],
                "bver": loaded["bver"], "fver": loaded["fver"],
                "name": loaded["name"], "pic": "",
                "deviceId": loaded.get("deviceId") or "",
                "host": cfg0["host"], "colId": cfg0["colId"], "colEt": cfg0["colEt"],
            }
            _CARD_CREDS[serial] = creds
        if config:
            cfg = _card_config(config)
        elif creds.get("host"):
            cfg = {"host": creds["host"], "colId": creds["colId"], "colEt": creds["colEt"]}
        else:
            cfg = _card_config(None)
        body = {
            "bver": creds["bver"],
            "deviceId": creds.get("deviceId") or "",
            "gver": GAME_GVER,
            "platform": "g",
            "pver": GAME_PVER,
            "saveId": creds["cityId"],
            "ts": time.time(),
        }
        r = _card_api("GetSaveAndRegister", body, cfg,
                      bver=creds["bver"], fver=creds["fver"],
                      token=creds["token"], save_id=creds["cityId"])
        if not (r.get("ok") and isinstance(r.get("resp"), dict)):
            status = int(r.get("status") or 0)
            return {"ok": False, "status": status,
                    "error": r.get("error") or f"HTTP {status}"}
        result = r["resp"].get("result")
        result = result if isinstance(result, dict) else {}
        saves = result.get("saves")
        saves = [s for s in saves if isinstance(s, dict)] if isinstance(saves, list) else []
        mine = next((s for s in saves if str(s.get("saveId")) == creds["cityId"]),
                    saves[0] if saves else {})
        boxes = mine.get("boxes")
        boxes = boxes if isinstance(boxes, list) else []
        return {"ok": True, "status": 200, "boxes": boxes, "total": len(boxes),
                "name": str(mine.get("name") or creds["name"]), "checkedAt": _now_ms()}

    def _read_save(self, adb: str, serial: str, pkg: str) -> tuple[str, bytes] | None:
        diag: list[str] = []
        known = _PATH_CACHE.get((serial, pkg, SAVE_FILE))
        discovered = _find_on_device(adb, serial, pkg, SAVE_FILE)
        ordered: list[str] = []
        for path in (discovered, known, *candidate_paths_for_package(pkg, SAVE_FILE)):
            if path and path not in ordered:
                ordered.append(path)
        for remote in ordered:
            buf = _pull_privileged(adb, serial, remote, diag)
            if buf and len(buf) >= 16:
                _PATH_CACHE[(serial, pkg, SAVE_FILE)] = remote
                return remote, buf
        return None

    def pull(self, serial: str, out_path: str | None = None) -> dict:
        """Read SaveGame.db off the device. Returns base64 plus provenance."""
        adb = _find_adb()
        if not adb:
            raise ClientError("adb not found - connect an emulator first")
        errs: list[str] = []
        for pkg in _packages_for(serial):
            if not _is_pkg_installed(adb, serial, pkg):
                errs.append(f"{pkg}: package not installed")
                continue
            found = self._read_save(adb, serial, pkg)
            if found:
                remote, buf = found
                _ACTIVE_PACKAGE[serial] = pkg
                if out_path:
                    Path(out_path).write_bytes(buf)
                return {
                    "ok": True,
                    "b64": base64.b64encode(buf).decode("ascii"),
                    "file": remote,
                    "package": pkg,
                    "size": len(buf),
                    "plainJson": buf.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"{"),
                    "savedTo": out_path or "",
                }
            errs.append(f"{pkg}: could not read {SAVE_FILE} in any known folder")
        raise ClientError(
            "Could not read SaveGame.db. Tried: " + " | ".join(errs)
            + ". Check that the device is rooted and open Homescapes at least once."
        )

    def push(self, serial: str, data, restart: bool = True, **kwargs) -> dict:
        """Write an edited save back. Accepts base64 (igg-style) or raw bytes."""
        if isinstance(data, (bytes, bytearray)):
            _data = bytes(data)
        else:
            try:
                _data = base64.b64decode(str(data), validate=False)
            except Exception:
                _data = str(data).encode()
        data = _data
        adb = _find_adb()
        if not adb:
            raise ClientError("adb not found - connect an emulator first")
        if len(data) < 16:
            raise ClientError("save output too short to push")
        if not looks_like_save(data):
            raise ClientError(
                "refusing to push: the payload is not a Homescapes save "
                "(it looks like text or an error message)"
            )
        if len(data) > 64 * 1024 * 1024:
            raise ClientError("save output exceeds the 64 MB safety limit")

        # Stop the game first, or it will overwrite our write when it saves.
        stop = self.force_stop(serial)
        if not stop.get("ok"):
            raise ClientError("could not stop Homescapes: " + str(stop.get("error")))
        time.sleep(0.4)

        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / SAVE_FILE
            local.write_bytes(data)
            tmp = "/data/local/tmp/hcs_push.bin"
            code, _, err = _run_adb(adb, ["-s", serial, "push", str(local), tmp], timeout=60)
            if code != 0:
                raise ClientError(
                    "adb push failed: " + err.decode("utf-8", "replace").strip()
                )

            errs: list[str] = []
            for pkg in _packages_for(serial):
                save_path = _PATH_CACHE.get((serial, pkg, SAVE_FILE)) or candidate_paths_for_package(pkg, SAVE_FILE)[0]
                bak_path = save_path.replace(SAVE_FILE, BACKUP_FILE)
                tool_bak = save_path + TOOL_BACKUP_SUFFIX
                # Snapshot whatever is there NOW (pre-edit) to our own file,
                # leave the game's .bak to the game, then install the edit.
                shell = (
                    f"su -c 'cp \"{save_path}\" \"{tool_bak}\" 2>/dev/null; "
                    f"cp \"{tmp}\" \"{save_path}\"; "
                    f"chmod 600 \"{save_path}\" \"{tool_bak}\"'"
                )
                code2, out2, err2 = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
                combined = (out2 + err2).decode("utf-8", "replace").strip()
                rejected = re.search(
                    r"permission denied|not found|no such file|failed|error:",
                    combined,
                    re.I,
                )
                if code2 == 0 and not rejected:
                    _ACTIVE_PACKAGE[serial] = pkg
                    if restart:
                        self.start(serial)
                    return {
                        "ok": True,
                        "package": pkg,
                        "file": save_path,
                        "toolBackup": tool_bak,
                        "gameBackup": bak_path,
                        "size": len(data),
                        "relaunched": bool(restart),
                    }
                errs.append(f"{pkg}: {combined or 'su cp failed'}")
            raise ClientError("Push failed — " + " | ".join(errs))

    def restore_backup(self, serial: str) -> dict:
        """Put the pre-edit snapshot back."""
        adb = _find_adb()
        if not adb:
            raise ClientError("adb not found - connect an emulator first")
        for pkg in _packages_for(serial):
            save_path = _PATH_CACHE.get((serial, pkg, SAVE_FILE)) or candidate_paths_for_package(pkg, SAVE_FILE)[0]
            tool_bak = save_path + TOOL_BACKUP_SUFFIX
            code, out, _ = _run_adb(adb, ["-s", serial, "shell", f"su -c 'ls \"{tool_bak}\"'"], timeout=15)
            if code != 0 or not out.strip():
                continue
            self.force_stop(serial)
            shell = f"su -c 'cp \"{tool_bak}\" \"{save_path}\" && chmod 600 \"{save_path}\"'"
            code2, out2, err2 = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
            combined = (out2 + err2).decode("utf-8", "replace").strip()
            if code2 == 0 and not re.search(r"permission denied|failed|error:", combined, re.I):
                self.start(serial)
                return {"ok": True, "file": save_path, "restoredFrom": tool_bak}
            raise ClientError(f"restore failed: {combined or 'su cp failed'}")
        raise ClientError("no tool backup found on this device yet")

    # ── fresh start ─────────────────────────────────────────────────────────
    # A fresh start is a FILE operation, not a save edit: the account becomes
    # new because the three files the game keeps are removed and the game is
    # restarted with none of them. Every one of them is copied to this PC
    # first, so "Create new account" is always reversible with "Restore
    # previous account" — the backup is written and fsync'ed BEFORE any rm.

    @staticmethod
    def _validate_fresh_snapshot(snapshot) -> tuple[str, str, dict[str, bytes | None]]:
        """Check a backup record. Runs before ANY command reaches the device."""
        if not isinstance(snapshot, dict):
            raise ClientError("invalid backup")
        pkg = snapshot.get("package")
        path = snapshot.get("file")
        files = snapshot.get("files")
        if pkg not in GAME_PACKAGES or not isinstance(path, str):
            raise ClientError("invalid backup source")
        roots = [base.format(pkg=pkg).rstrip("/") + "/" for base in _SAVE_BASES]
        if (
            not path.endswith("/" + SAVE_FILE)
            or not any(path.startswith(root) for root in roots)
            or ".." in path.split("/")
            or any(c in path for c in ("\x00", "\r", "\n", "'", '"', "$", "`", "\\"))
        ):
            raise ClientError("invalid backup path")
        if not isinstance(files, dict) or set(files) != set(FRESH_FILES):
            raise ClientError("incomplete backup")
        decoded: dict[str, bytes | None] = {}
        total = 0
        for name in FRESH_FILES:
            value = files[name]
            if value is None:
                decoded[name] = None
            elif isinstance(value, str):
                try:
                    decoded[name] = base64.b64decode(value, validate=True)
                except Exception as error:
                    raise ClientError("invalid backup data") from error
                total += len(decoded[name])
            else:
                raise ClientError("invalid backup data")
        if decoded[SAVE_FILE] is None or total > FRESH_MAX_BYTES:
            raise ClientError("invalid backup size")
        return pkg, path, decoded

    def _fresh_stop(self, serial: str, pkg: str) -> None:
        """Stop THIS package and only this one — the save must not be written back."""
        _ACTIVE_PACKAGE[serial] = pkg
        stopped = self.force_stop(serial)
        if not stopped.get("ok") or stopped.get("package") != pkg:
            raise ClientError("could not stop the selected game")
        time.sleep(0.4)

    def _fresh_read_files(self, adb: str, serial: str, path: str) -> dict[str, str | None]:
        """base64 of each of the three files; `None` where the file is absent."""
        parent = path.rsplit("/", 1)[0]
        files: dict[str, str | None] = {}
        for name in FRESH_FILES:
            remote = f"{parent}/{name}"
            shell = f"su -c 'if [ -e \"{remote}\" ]; then echo PRESENT; else echo ABSENT; fi'"
            code, out, _ = _run_adb(adb, ["-s", serial, "shell", shell], timeout=15)
            if code != 0 or out.strip() not in (b"PRESENT", b"ABSENT"):
                raise ClientError("could not inspect the save files")
            if out.strip() == b"ABSENT":
                files[name] = None
                continue
            content = _pull_privileged(adb, serial, remote)
            if content is None:
                raise ClientError("could not back up the save files")
            files[name] = base64.b64encode(content).decode("ascii")
        return files

    def _fresh_restore_files(
        self, adb: str, serial: str, pkg: str, path: str, files: dict[str, bytes | None]
    ) -> None:
        """Put every file back with the directory's own owner and mode."""
        parent = path.rsplit("/", 1)[0]
        code, out, _ = _run_adb(
            adb, ["-s", serial, "shell", f"su -c 'stat -c %u:%g \"{parent}\"'"], timeout=15
        )
        owner = out.decode("ascii", "ignore").strip()
        if code != 0 or not re.fullmatch(r"\d+:\d+", owner):
            raise ClientError("could not determine save ownership")
        with tempfile.TemporaryDirectory() as td:
            for index, (name, content) in enumerate(files.items()):
                remote = f"{parent}/{name}"
                if content is None:
                    shell = f"su -c 'rm -f \"{remote}\"'"
                else:
                    local = Path(td) / name
                    local.write_bytes(content)
                    transfer = f"/data/local/tmp/hcs_restore_{index}.bin"
                    code, _, _ = _run_adb(
                        adb, ["-s", serial, "push", str(local), transfer], timeout=60
                    )
                    if code != 0:
                        raise ClientError("backup upload failed")
                    shell = (
                        f"su -c 'cp \"{transfer}\" \"{remote}\" && chown {owner} \"{remote}\""
                        f" && chmod 600 \"{remote}\"'"
                    )
                code, out, err = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
                if code != 0 or re.search(rb"permission denied|failed|error:", out + err, re.I):
                    raise ClientError("backup restore failed")

    def fresh_snapshot(self, serial: str, pkg: str, path: str) -> dict:
        """Copy the three save files off the device into a backup record."""
        adb = _find_adb()
        if not adb or pkg not in GAME_PACKAGES or not _is_pkg_installed(adb, serial, pkg):
            raise ClientError("selected game unavailable")
        # Validate the pinned source before constructing any shell command.
        placeholder = {SAVE_FILE: "", SAVE_FILE + ".bak": None, SAVE_FILE + ".buf": None}
        self._validate_fresh_snapshot({"package": pkg, "file": path, "files": placeholder})
        self._fresh_stop(serial, pkg)
        found = self._read_save(adb, serial, pkg)
        if not found or found[0] != path:
            raise ClientError("save source changed; connect again")
        files = self._fresh_read_files(adb, serial, path)
        snapshot = {
            "ok": True,
            "schema": 1,
            "serial": serial,
            "package": pkg,
            "file": path,
            "files": files,
        }
        self._validate_fresh_snapshot(snapshot)
        return snapshot

    def fresh_start(self, serial: str, snapshot: dict, restore: bool = False) -> dict:
        """Delete the three save files (or put a backup of them back)."""
        pkg, path, files = self._validate_fresh_snapshot(snapshot)
        if snapshot.get("serial") != serial:
            raise ClientError("backup belongs to another device")
        adb = _find_adb()
        if not adb or not _is_pkg_installed(adb, serial, pkg):
            raise ClientError("selected game unavailable")
        self._fresh_stop(serial, pkg)
        if restore:
            self._fresh_restore_files(adb, serial, pkg, path, files)
        else:
            # Refuse to delete anything if the save moved under us between the
            # backup and the rm — that is the window where a restore would
            # otherwise hand back someone else's files.
            current = self._fresh_read_files(adb, serial, path)
            if current != snapshot["files"]:
                raise ClientError("save files changed after the backup; connect again")
            parent = path.rsplit("/", 1)[0]
            targets = " ".join(f'"{parent}/{name}"' for name in FRESH_FILES)
            shell = (
                f"su -c 'rm -f {targets} && for f in {targets}; do "
                f'[ ! -e "$f" ] || exit 1; done\''
            )
            code, out, err = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
            if code != 0 or re.search(rb"permission denied|failed|error:", out + err, re.I):
                # The rm failed part-way: put the original files back before
                # reporting, so the device is never left half-wiped.
                try:
                    self._fresh_restore_files(adb, serial, pkg, path, files)
                except Exception:
                    pass
                raise ClientError("fresh start failed; the original backup is retained")
        _ACTIVE_PACKAGE[serial] = pkg
        self.start(serial)
        return {"ok": True, "package": pkg, "file": path, "relaunched": True}

    def fresh_new_account(self, serial: str) -> dict:
        """Back up the save to THIS PC, then remove it on the device."""
        adb = _find_adb()
        if not adb:
            raise ClientError("adb not found - connect an emulator first")
        errs: list[str] = []
        for pkg in _packages_for(serial):
            if not _is_pkg_installed(adb, serial, pkg):
                errs.append(f"{pkg}: package not installed")
                continue
            found = self._read_save(adb, serial, pkg)
            if not found:
                errs.append(f"{pkg}: could not read {SAVE_FILE}")
                continue
            path = found[0]
            snapshot = self.fresh_snapshot(serial, pkg, path)
            # The copy is on disk and synced BEFORE the first byte is removed.
            backup = write_fresh_backup(snapshot)
            self.fresh_start(serial, snapshot)
            return {
                "ok": True,
                "package": pkg,
                "file": path,
                "localBackup": str(backup),
                "relaunched": True,
            }
        raise ClientError(
            "Could not prepare a fresh start. Tried: " + (" | ".join(errs) or "no game package")
        )

    def fresh_restore(self, serial: str, backup_file: str | None = None) -> dict:
        """Put the newest backup for `serial` back on the device."""
        path = Path(backup_file) if backup_file else latest_fresh_backup(serial)
        if not path or not path.is_file():
            raise ClientError("no backup is available for this device")
        if path.stat().st_size > FRESH_BACKUP_LIMIT:
            raise ClientError("backup is too large")
        try:
            snapshot = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:
            raise ClientError("backup is unreadable") from error
        result = self.fresh_start(serial, snapshot, restore=True)
        return {**result, "localBackup": str(path)}


# ── CLI (JSON in / JSON out) ─────────────────────────────────────────────────

def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# -------------------------------------------------------------------- update --
def _sha256_file(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _latest_release_tag(repo: str) -> str:
    req = _urlrequest.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"User-Agent": "hc-client", "Accept": "application/vnd.github+json"},
    )
    with _urlrequest.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode())
    tag = str(body.get("tag_name") or "")
    if not tag:
        raise ClientError("no GitHub release found")
    return tag


def _release_sha256(repo: str, tag: str, asset: str) -> str:
    """Read the published SHA-256 for a release asset.

    The client refuses to swap its own executable without one. A checksum
    fetched from the same host as the asset is not a signature, but it does
    catch a truncated or replaced upload — and, unlike the old code, it makes
    "no checksum published" a hard failure instead of a silent pass.
    """
    for name in (f"{asset}.sha256", "SHA256SUMS", "sha256sums.txt"):
        url = f"https://github.com/{repo}/releases/download/{tag}/{name}"
        try:
            req = _urlrequest.Request(url, headers={"User-Agent": "hc-client"})
            with _urlrequest.urlopen(req, timeout=30) as r:
                body = r.read().decode("utf-8", "replace")
        except Exception:
            continue
        for line in body.splitlines():
            parts = line.split()
            if not parts:
                continue
            digest = parts[0].strip().lower()
            target = parts[-1].lstrip("*") if len(parts) > 1 else asset
            if len(digest) == 64 and target.endswith(asset):
                return digest
    return ""


def _cmd_update() -> int:
    """Self-update from a published release asset (manual CLI fallback).

    The shipped EXE normally updates itself: the web app polls the server for
    a published release and calls `installUpdate`. This verb only exists so an
    operator can force it by hand.

    Env:
      HC_UPDATE_URL    - direct URL of the release EXE (preferred)
      HC_UPDATE_REPO   - owner/repo to pull from (default this project)
      HC_UPDATE_ASSET  - release asset name (default the single-file client EXE)
      HC_UPDATE_TAG    - pin a tag (skips the latest-release lookup)
      HC_UPDATE_SHA256 - expected SHA-256 of the asset; mismatch refuses to swap

    The old defaults pointed at the IGG VIP Studio repo and its asset, so
    `hc update` installed a DIFFERENT application over this one. The swap is now
    also gated on a checksum that must exist, and on the archive containing the
    executable this build actually ships.
    """
    repo = os.environ.get("HC_UPDATE_REPO") or "Aditya4650-am/AM-HOMESC-"
    direct = (os.environ.get("HC_UPDATE_URL") or "").strip()
    if direct:
        url = direct
        tag = os.environ.get("HC_UPDATE_TAG") or "manual"
    else:
        asset = os.environ.get("HC_UPDATE_ASSET") or "HOMESC.SAVE.STUDIO.exe"
        tag = os.environ.get("HC_UPDATE_TAG") or _latest_release_tag(repo)
        url = f"https://github.com/{repo}/releases/download/{tag}/{asset}"
    dest = Path(tempfile.gettempdir()) / f"hc_update_{tag}.zip"
    _emit({"ok": True, "event": "update", "stage": "download", "repo": repo, "tag": tag})
    req = _urlrequest.Request(url, headers={"User-Agent": "hc-client"})
    with _urlrequest.urlopen(req, timeout=900) as r:
        dest.write_bytes(r.read())
    got = _sha256_file(dest)
    want = (os.environ.get("HC_UPDATE_SHA256") or "").strip().lower() or _release_sha256(repo, tag, asset)
    if not want:
        raise ClientError(
            f"no SHA-256 published for {asset} in {repo}@{tag} — refusing to replace the "
            "client with an unverified download"
        )
    if got != want:
        raise ClientError(f"checksum mismatch: got {got}, want {want}")

    import zipfile

    with zipfile.ZipFile(dest) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".exe")]
        # Take OUR executable, and say so if it is not there.
        preferred = [n for n in names if Path(n).stem.lower() == APP_NAME.lower()]
        entry = (preferred or names)[0] if names else None
        if not entry:
            raise ClientError("no exe inside the release zip")
        if not preferred:
            raise ClientError(
                f"the release zip holds no {APP_NAME}.exe (found: {', '.join(names[:3])}) — "
                "refusing to install it"
            )
        with z.open(entry) as src, open(dest.with_suffix(".exe"), "wb") as out:
            out.write(src.read())
    new_exe = Path(str(dest) + ".exe")
    # Swap the running process out for the freshly verified one and relaunch.
    import subprocess as _sp

    _sp.Popen([str(new_exe)] + sys.argv[1:], cwd=str(new_exe.parent))
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


# The auto-updater's on-disk swap. The client ships as ONE file, but installs
# built before the onefile switch still hold a foldered (onedir) tree and can
# receive a legacy zip release — so both swap paths stay.
# release is swapped by a tiny .cmd that waits for the running EXE to exit,
# copies the staged tree over the install folder, relaunches, and deletes
# itself. Nothing here decides WHAT to download — that comes from the server's
# published release, verified by SHA-256 before a single byte is staged.

def _release_zip_is_folder(names) -> bool:
    """A foldered (onedir) release zips a directory tree, so some entries carry
    a path separator; a single-file zip does not."""
    return any("/" in n.replace("\\", "/") for n in names)


def _wait_then_swap_bat(staged: str, dest: str, exe_name: str) -> str:
    """Batch: wait for the running EXE to exit, copy staged -> dest, relaunch."""
    lines = [
        "@echo off",
        "setlocal enabledelayedexpansion",
        f'set "STAGED={staged}"',
        f'set "DEST={dest}"',
        f'set "EXE={dest}\\{exe_name}"',
        "set /a N=0",
        ":wait",
        # tasklist|find -> errorlevel 1 when the EXE is NOT running.
        f'tasklist /fi "imagename eq {exe_name}" 2>nul | find /i "{exe_name}" >nul',
        "if errorlevel 1 goto copy",
        "set /a N+=1",
        "if !N! GEQ 60 goto copy",
        "timeout /t 1 /nobreak >nul",
        "goto wait",
        ":copy",
        'xcopy /y /e /q /i "%STAGED%\\*" "%DEST%\\" >nul',
        'start "" "%EXE%"',
        'rmdir /s /q "%STAGED%"',
        'del "%~f0"',
    ]
    return "\n".join(lines) + "\n"


def _swap_single_exe_bat(new_exe: str, dest: str) -> str:
    """Batch: pause so the old EXE exits, move the new one over it, relaunch."""
    lines = [
        "@echo off",
        "setlocal",
        f'set "NEW={new_exe}"',
        f'set "DEST={dest}"',
        "ping 127.0.0.1 -n 4 >nul",
        'move /y "%NEW%" "%DEST%" >nul',
        'start "" "%DEST%"',
        'del "%~f0"',
    ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------- proxy --
_MIME_BY_EXT = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}


def _content_type_for(path: str) -> str:
    """MIME fallback for an upstream response that carries no Content-Type.

    Extension-less paths are SPA routes the studio serves as index.html, so
    they get the HTML type — otherwise a router URL would fall back to JSON
    and render as source again. API paths fall back to JSON for the same
    reason.
    """
    clean = path.split("?", 1)[0].split("#", 1)[0].lower()
    dot = clean.rfind(".")
    if dot != -1:
        ext = _MIME_BY_EXT.get(clean[dot:])
        if ext:
            return ext
    if clean.startswith("/api/"):
        return "application/json"
    return "text/html; charset=utf-8"


def _make_proxy_handler(client: "HomescapesClient", upstream_base: str) -> type[BaseHTTPRequestHandler]:
    """Reverse proxy for the desktop shell.

    The UI is served from the *studio server*, which may be hosted (Render) where
    no adb exists. This handler stands in locally: `/api/device/*` and
    `/api/devices` are answered by the real ADB client, and everything else is
    forwarded to the upstream studio server — local (`http://127.0.0.1:8787`) or
    hosted (`https://am-...onrender.com`). That is the same split as the IGG tool:
    the device stays local, all save logic runs wherever the server lives.
    """

    class ProxyHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, format, *args):  # noqa: A002 - keep the console quiet
            return

        # -- plumbing
        def _body(self) -> bytes:
            try:
                n = int(self.headers.get("content-length") or 0)
            except (TypeError, ValueError):
                n = 0
            return self.rfile.read(n) if n > 0 else b""

        def _respond_json(self, status: int, obj) -> None:
            data = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _upstream(self, method: str, path: str, body: bytes | None, token: str | None):
            url = upstream_base.rstrip("/") + path
            req = _urlrequest.Request(url, data=body, method=method)
            for key, value in self.headers.items():
                lk = key.lower()
                if lk in ("content-type", "x-hs-token", "authorization", "x-device-id", "accept", "user-agent"):
                    req.add_header(key, value)
            try:
                with _urlrequest.urlopen(req, timeout=300) as resp:
                    # The RESPONSE headers must come back too. The browser
                    # refuses a module script or stylesheet served with the
                    # wrong MIME type, so the proxy has to repeat what the
                    # studio actually said about the body — never infer it
                    # from the request (a GET carries no content-type at all,
                    # which made every page come back as application/json and
                    # render as raw source).
                    return resp.status, dict(resp.headers.items()), resp.read()
            except _urlerror.HTTPError as exc:
                # urllib RAISES on any 4xx/5xx. Uncaught, the exception
                # escaped _dispatch and the proxy closed the socket with no
                # reply at all — the browser's fetch() then rejects with
                # "Failed to fetch", which is exactly the error the Cards
                # Send button showed. Pass the studio's own error straight
                # through instead: the UI can read its JSON and say why.
                try:
                    data = exc.read() or b""
                except Exception:
                    data = b""
                headers = dict(exc.headers.items()) if exc.headers else {}
                if data:
                    return exc.code, headers, data
                # No body -> synthesize one so api.request never hits the
                # "non-JSON body" path either.
                payload = json.dumps(
                    {"ok": False, "error": f"server returned {exc.code} {exc.reason}"}
                ).encode()
                headers["content-type"] = "application/json"
                return exc.code, headers, payload
            except Exception as exc:  # URLError, timeout, DNS, TLS, reset…
                # Never drop the connection: answer 502 with a readable JSON
                # reason so the front end shows "Cards not sent — <why>"
                # instead of a dead fetch.
                payload = json.dumps(
                    {"ok": False, "error": f"studio unreachable ({type(exc).__name__}): {exc}"}
                ).encode()
                return 502, {"content-type": "application/json"}, payload

        # -- dispatch
        def _dispatch(self) -> None:
            path = self.path.split("?", 1)[0]
            token = self.headers.get("x-hs-token") or None

            if self.command == "GET" and path == "/api/devices":
                try:
                    info = client.adb_info()
                    self._respond_json(200, {"ok": True, **info})
                except ClientError as exc:
                    self._respond_json(400, {"ok": False, "error": str(exc)})
                return

            if self.command == "POST" and path == "/api/device/pull":
                try:
                    payload = json.loads(self._body().decode() or "{}")
                except Exception:
                    payload = {}
                serial = str(payload.get("serial") or "")
                if not serial:
                    self._respond_json(400, {"ok": False, "error": "`serial` is required"})
                    return
                try:
                    reply = client.pull(serial)
                    self._respond_json(200, {"ok": True, **reply})
                except ClientError as exc:
                    self._respond_json(400, {"ok": False, "error": str(exc)})
                return

            if self.command == "POST" and path == "/api/device/push":
                try:
                    payload = json.loads(self._body().decode() or "{}")
                except Exception:
                    payload = {}
                serial = str(payload.get("serial") or "")
                restart = payload.get("restart") is not False
                if not serial:
                    self._respond_json(400, {"ok": False, "error": "`serial` is required"})
                    return
                sid = str(payload.get("sessionId") or "")
                status, _headers, data = self._upstream(
                    "GET", f"/api/export?sessionId={_urlparse.quote(sid)}", None, token
                )
                if status != 200:
                    try:
                        self._respond_json(status, json.loads(data.decode() or "{}"))
                    except Exception:
                        self.send_response(status)
                        self.send_header("content-type", "application/json")
                        self.send_header("content-length", "0")
                        self.end_headers()
                    return
                try:
                    reply = client.push(serial, data, restart=restart)
                    self._respond_json(200, reply)
                except ClientError as exc:
                    self._respond_json(400, {"ok": False, "error": str(exc)})
                return

            if self.command == "POST" and path == "/api/device/stop":
                try:
                    payload = json.loads(self._body().decode() or "{}")
                except Exception:
                    payload = {}
                serial = str(payload.get("serial") or "")
                reply = client.force_stop(serial) if serial else {"ok": False, "error": "`serial` is required"}
                self._respond_json(200, {"ok": True, **reply})
                return

            if self.command == "POST" and path == "/api/device/start":
                try:
                    payload = json.loads(self._body().decode() or "{}")
                except Exception:
                    payload = {}
                serial = str(payload.get("serial") or "")
                reply = client.start(serial) if serial else {"ok": False, "error": "`serial` is required"}
                self._respond_json(200, {"ok": True, **reply})
                return

            if self.command == "POST" and path == "/api/device/restore-backup":
                try:
                    payload = json.loads(self._body().decode() or "{}")
                except Exception:
                    payload = {}
                serial = str(payload.get("serial") or "")
                reply = client.restore_backup(serial) if serial else {"ok": False, "error": "`serial` is required"}
                self._respond_json(200, {"ok": True, **reply})
                return

            # Fresh Start is a LIVE device flow — it removes files from the
            # client's own machine — so it runs here, not on the hosted
            # server, which has no adb. Same rule as pull/push: local device,
            # remote save logic. The hosted studio is still asked to confirm
            # the licence and the session FIRST: no file is touched unless
            # that check comes back 200.
            if self.command == "POST" and path in (
                "/api/fresh-start/new-account",
                "/api/fresh-start/restore",
            ):
                try:
                    payload = json.loads(self._body().decode() or "{}")
                except Exception:
                    payload = {}
                serial = str(payload.get("serial") or "")
                if not serial:
                    self._respond_json(400, {"ok": False, "error": "Select a device to continue"})
                    return
                restoring = path.endswith("/restore")
                if not restoring:
                    confirm = json.dumps(
                        {
                            "sessionId": str(payload.get("sessionId") or ""),
                            "confirmation": str(payload.get("confirmation") or ""),
                        }
                    ).encode()
                    status, _headers, data = self._upstream(
                        "POST", "/api/fresh-start/authorize", confirm, token
                    )
                    if status != 200:
                        try:
                            self._respond_json(status, json.loads(data.decode() or "{}"))
                        except Exception:
                            self._respond_json(
                                status,
                                {"ok": False, "error": "Fresh Start is not authorised on this server"},
                            )
                        return
                try:
                    reply = (
                        client.fresh_restore(serial)
                        if restoring
                        else client.fresh_new_account(serial)
                    )
                except ClientError as exc:
                    self._respond_json(400, {"ok": False, "error": str(exc)})
                    return
                except Exception as exc:  # never leave the fetch hanging
                    self._respond_json(400, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
                    return
                if not restoring:
                    # That session now describes a save which no longer exists
                    # on the device; drop it so Connect re-reads a clean one.
                    session_id = str(payload.get("sessionId") or "")
                    if session_id:
                        try:
                            self._upstream(
                                "POST",
                                "/api/session/close",
                                json.dumps({"sessionId": session_id}).encode(),
                                token,
                            )
                        except Exception:
                            pass
                self._respond_json(200, reply)
                return

            # Cards -> a friend is a LIVE device flow: every (card, friend)
            # pair is a SendBox round-trip through the user's own emulator, so
            # it must run on THIS machine — the hosted server has no adb. Same
            # rule as pull/push: local device, remote save logic.
            if self.command == "POST" and path == "/api/cards/send":
                try:
                    payload = json.loads(self._body().decode() or "{}")
                except Exception:
                    payload = {}
                serial = str(payload.get("serial") or "")
                raw_cards = payload.get("cards")
                raw_friends = payload.get("friends")
                cards = (
                    [str(c).strip() for c in raw_cards if str(c).strip()]
                    if isinstance(raw_cards, list)
                    else []
                )
                friends = (
                    [str(f).strip() for f in raw_friends if str(f).strip()]
                    if isinstance(raw_friends, list)
                    else []
                )
                if not serial:
                    self._respond_json(400, {"ok": False, "error": "`serial` is required"})
                    return
                if not cards or not friends:
                    self._respond_json(
                        400,
                        {"ok": False, "error": "`cards` and `friends` must be non-empty arrays"},
                    )
                    return
                try:
                    raw_delay = payload.get("delayMs")
                    delay_ms = max(0, min(10_000, int(raw_delay or 0)))
                except Exception:
                    delay_ms = 0
                try:
                    reply = client.cardsSendAll(serial, cards, friends, config={},
                                                delay_ms=delay_ms)
                except ClientError as exc:
                    self._respond_json(400, {"ok": False, "error": str(exc)})
                    return
                except Exception as exc:  # never leave the fetch hanging
                    self._respond_json(400, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
                    return
                if reply.get("ok"):
                    self._respond_json(200, reply)
                    return
                # Partial/total failure still carries the per-pair detail; give
                # the UI a human summary too so the toast is never generic.
                self._respond_json(
                    400,
                    {
                        **reply,
                        "error": reply.get("error")
                        or f"{reply.get('sent', 0)}/{reply.get('total', 0)} delivered · "
                        f"{len(reply.get('failed') or [])} failed",
                    },
                )
                return

            status, upstream_headers, data = self._upstream(self.command, self.path, self._body() or None, token)
            self.send_response(status)
            # Repeat the studio's own Content-Type. This header decides whether
            # the window renders the page or dumps it as raw source — and
            # whether the module script/CSS are allowed to execute at all
            # (the browser blocks them on a MIME mismatch).
            ct = ""
            for key, value in upstream_headers.items():
                if key.lower() == "content-type":
                    ct = value.strip()
                    break
            if not ct:
                ct = _content_type_for(self.path)
            self.send_header("content-type", ct)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _safe_dispatch(self) -> None:
            # Last line of defence: ANY exception (JSON parse, a typo in a
            # new local route, a half-written socket) must still produce a
            # readable reply. Before this, an exception meant the connection
            # closed with no response and the browser reported the opaque
            # "Failed to fetch" the Cards Send button was showing.
            try:
                self._dispatch()
            except Exception as exc:
                try:
                    self._respond_json(
                        500,
                        {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                    )
                except Exception:
                    pass  # socket already gone — nothing more to say

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self._safe_dispatch()

        def do_POST(self) -> None:  # noqa: N802
            self._safe_dispatch()

        def do_PUT(self) -> None:  # noqa: N802
            self._safe_dispatch()

        def do_DELETE(self) -> None:  # noqa: N802
            self._safe_dispatch()

    return ProxyHandler


def _start_proxy(port: int, upstream_base: str) -> tuple[ThreadingHTTPServer, int]:
    """Start the local device proxy on a background thread.

    `port=0` asks the OS for a free port, which is what the desktop shell wants:
    a fixed 8790 collides with the second copy of the app or with anything else
    already listening. Returns the server and the port actually bound.
    """
    handler = _make_proxy_handler(HomescapesClient(), upstream_base)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    bound = server.server_address[1]

    def _run() -> None:
        try:
            server.serve_forever()
        finally:
            try:
                server.server_close()
            except Exception:
                pass

    threading.Thread(target=_run, daemon=True, name="hc-proxy").start()
    print(f"[hc_client] proxy listening on http://127.0.0.1:{bound} -> {upstream_base}", flush=True)
    return server, bound


def _serve_proxy(port: int, upstream_base: str) -> ThreadingHTTPServer:
    """CLI mode: run the proxy in the foreground until interrupted."""
    server, bound = _start_proxy(port, upstream_base)
    print(f"[hc_client] proxy listening on http://127.0.0.1:{bound} -> {upstream_base}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    server.shutdown()
    return server


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="hc_client", add_help=True)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices")
    sub.add_parser("adb-info")

    p_pull = sub.add_parser("pull")
    p_pull.add_argument("--serial", required=True)
    p_pull.add_argument("--out", default=None)

    p_push = sub.add_parser("push")
    p_push.add_argument("--serial", required=True)
    p_push.add_argument("--in", dest="infile", required=True)
    p_push.add_argument("--no-restart", action="store_true")

    p_stop = sub.add_parser("force-stop")
    p_stop.add_argument("--serial", required=True)

    p_start = sub.add_parser("start")
    p_start.add_argument("--serial", required=True)

    p_restore = sub.add_parser("restore-backup")
    p_restore.add_argument("--serial", required=True)

    p_fs_new = sub.add_parser("fresh-start-new-account")
    p_fs_new.add_argument("--serial", required=True)
    p_fs_restore = sub.add_parser("fresh-start-restore-account")
    p_fs_restore.add_argument("--serial", required=True)
    p_fs_restore.add_argument("--backup", default=None)

    p_cards_load = sub.add_parser("cards-load")
    p_cards_load.add_argument("--serial", required=True)
    p_cards_send = sub.add_parser("cards-send")
    p_cards_send.add_argument("--serial", required=True)
    p_cards_send.add_argument("--to", required=True)
    p_cards_send.add_argument("--card", required=True)
    p_cards_send_all = sub.add_parser("cards-send-all")
    p_cards_send_all.add_argument("--serial", required=True)
    p_cards_send_all.add_argument("--cards", required=True)
    p_cards_send_all.add_argument("--friends", required=True)
    p_cards_send_all.add_argument("--delay-ms", type=int, default=0)
    p_cards_inbox = sub.add_parser("cards-inbox")
    p_cards_inbox.add_argument("--serial", required=True)

    sub.add_parser("proxy")
    sub.add_parser("update")

    args = parser.parse_args(argv)
    client = HomescapesClient()

    try:
        if args.cmd == "devices":
            _emit({"ok": True, "devices": client.devices()})
        elif args.cmd == "adb-info":
            _emit({"ok": True, "info": client.adb_info()})
        elif args.cmd == "pull":
            _emit(client.pull(args.serial, args.out))
        elif args.cmd == "push":
            data = Path(args.infile).read_bytes()
            _emit(client.push(args.serial, data, restart=not args.no_restart))
        elif args.cmd == "force-stop":
            _emit(client.force_stop(args.serial))
        elif args.cmd == "start":
            _emit(client.start(args.serial))
        elif args.cmd == "restore-backup":
            _emit(client.restore_backup(args.serial))
        elif args.cmd == "fresh-start-new-account":
            _emit(client.fresh_new_account(args.serial))
        elif args.cmd == "fresh-start-restore-account":
            _emit(client.fresh_restore(args.serial, args.backup))
        elif args.cmd == "cards-load":
            _emit(client.cardsLoad(args.serial, config={}))
        elif args.cmd == "cards-send":
            _emit(client.cardsSend(args.serial, args.to, args.card, config={}))
        elif args.cmd == "cards-send-all":
            cards = [c.strip() for c in args.cards.split(",") if c.strip()]
            friends = [f.strip() for f in args.friends.split(",") if f.strip()]
            _emit(client.cardsSendAll(args.serial, cards, friends, config={},
                                      delay_ms=max(0, int(args.delay_ms or 0))))
        elif args.cmd == "cards-inbox":
            _emit(client.cardsInbox(args.serial, config={}))
        elif args.cmd == "proxy":
            port = int(os.environ.get("HC_PROXY_PORT", "8790"))
            upstream = os.environ.get("HC_STUDIO_UPSTREAM", "http://127.0.0.1:8787").rstrip("/")
            _serve_proxy(port, upstream)
        elif args.cmd == "update":
            _cmd_update()
            return 0
        else:  # pragma: no cover - argparse enforces choices
            parser.error(f"unknown command {args.cmd}")
        return 0
    except ClientError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    except Exception as exc:  # noqa: BLE001 - the bridge must never crash the host
        _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


# ── desktop shell ────────────────────────────────────────────────────────────

def _serve_window() -> int:
    """Open a native WebView2 window over the studio.

    The window loads a LOCAL proxy whose upstream is ``HC_STUDIO_URL`` (or the
    default deployment). That is the split the module docstring describes and
    the reason it matters:

      * ``/api/devices`` and ``/api/device/*`` are answered by this process,
        driving ADB on the user's own machine;
      * every other route is forwarded to the studio server, wherever it lives.

    The previous build pointed the window straight at the remote URL and
    ``expose()``d the ADB client to it, so a page served by someone else's
    deployment could push a save to the user's emulator. Loopback origin means
    the page that holds the bridge is one we control.
    """
    try:
        import webview  # pywebview
    except ImportError:
        sys.stderr.write(
            "pywebview is not installed. Either:\n"
            "  pip install pywebview\n"
            "or run the bridge in JSON mode (pass a command such as `devices`).\n"
        )
        return 2

    # The page is served from OUR loopback proxy rather than the remote
    # deployment: a page served by someone else's deployment could otherwise
    # drive the ADB bridge. Loopback origin means the page that holds the
    # bridge is one we control.
    upstream = normalize_base_url(resolve_server_url())
    try:
        _server, port = _start_proxy(0, upstream)
    except OSError as exc:
        sys.stderr.write(f"could not start the local device bridge on loopback: {exc}\n")
        return 2

    device_id = get_device_id() if 'get_device_id' in globals() else ""
    url = with_device_param(f"http://127.0.0.1:{port}", device_id)

    # pywebview publishes a JS API object only through `js_api=` on
    # `create_window`. It must be a callable-collection (module/class with
    # methods), NOT an instance — `Window.expose()` rejects non-callables and
    # `webview.start()` has no `js_api` kwarg, so the old
    # `window.expose(HomescapesClient())` + `start(js_api=True)` pair raised
    # TypeError before any window opened (silently, in the windowed build).
    api = HomescapesClient()

    window = webview.create_window(
        APP_NAME,
        url,
        width=1440,
        height=900,
        min_size=(1024, 700),
        background_color="#0b0f17",
        js_api=api,
    )
    # `webview.start(func)` runs `func` on a background thread once the GUI is
    # ready, and only THEN blocks — unlike the previous placement, which ran
    # after the window had already closed. The bridge itself is published by
    # `js_api=api` above, so nothing is exposed twice here.
    def _install_alias() -> None:
        """Alias window.pywebview.api as window.hcNative once the page is up.

        This MUST run from webview.start's callback: `webview.start()` blocks
        until the window closes, so the old code called evaluate_js on a dead
        window and `window.hcNative` never existed at all.
        """
        try:
            window.events.loaded.wait(20)
        except Exception:
            pass
        for _ in range(40):
            try:
                if window.evaluate_js("!!(window.pywebview && window.pywebview.api)"):
                    window.evaluate_js(_ALIAS_JS)
                    return
            except Exception:
                pass
            time.sleep(0.25)

    try:
        webview.start(func=_install_alias, debug=bool(os.environ.get("HC_DEBUG")))
    finally:
        try:
            _server.shutdown()
        except Exception:
            pass
    return 0


def main() -> int:
    # In a windowed (no-console) build these are None, and any library that
    # writes to them raises AttributeError and kills the app on startup.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")  # noqa: SIM115
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")  # noqa: SIM115

    argv = sys.argv[1:]
    if not argv:
        return _serve_window()
    return _cli(argv)


if __name__ == "__main__":
    raise SystemExit(main())
