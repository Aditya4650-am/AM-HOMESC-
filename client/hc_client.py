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
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import parse as _urlparse
from urllib import request as _urlrequest

APP_NAME = "Homescapes Save Studio"
APP_VERSION = "0.1.0"

# Homescapes ships as a single global package; the `.vn` variant follows the
# same layout if it ever appears.
GAME_PACKAGES = ["com.playrix.homescapes"]

# Confirmed from the reference editor's game descriptor and from the sample:
# the save is a JSON container sitting in the package's private storage.
SAVE_FILE = "SaveGame.db"
BACKUP_FILE = "SaveGame.db.bak"      # written by the GAME itself
TOOL_BACKUP_SUFFIX = ".hcsbak"       # our own pre-edit snapshot; the game never reads it

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


# Real device paths discovered per (serial, package, filename), so a later
# push writes back to exactly where the pull came from.
_PATH_CACHE: dict[tuple[str, str, str], str] = {}
# Which package each device actually uses, so push targets the same one.
_ACTIVE_PACKAGE: dict[str, str] = {}


# ── adb discovery ────────────────────────────────────────────────────────────

_EMULATOR_PORTS = [5555, 5554, 62001, 62025, 21503, 21513, 21523, 21533, 21543, 21553, 21563, 21573, 21583, 21593, 7555, 5037, 5585, 5597, 21504, 21505]


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
        if state.strip() == "device":
            result.append({"id": serial.strip(), "label": serial.strip()})
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

    def push(self, serial: str, data: bytes, restart: bool = True) -> dict:
        """Write an edited save back, keeping both a game and a tool backup."""
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


def _cmd_update() -> int:
    """Self-update from a GitHub release zip.

    Env:
      HC_UPDATE_REPO   - owner/repo to pull from (default the IGG VIP Studio repo)
      HC_UPDATE_ASSET   - release asset name (default IGG.VIP.TOOL.zip)
      HC_UPDATE_TAG     - pin a tag (skips the latest-release lookup)
      HC_UPDATE_SHA256  - expected SHA-256 of the asset; mismatch refuses to swap
    """
    repo = os.environ.get("HC_UPDATE_REPO") or "Aditya4650-am/igg-vip-studio"
    asset = os.environ.get("HC_UPDATE_ASSET") or "IGG.VIP.TOOL.zip"
    tag = os.environ.get("HC_UPDATE_TAG") or _latest_release_tag(repo)
    url = f"https://github.com/{repo}/releases/download/{tag}/{asset}"
    dest = Path(tempfile.gettempdir()) / f"hc_update_{tag}.zip"
    req = _urlrequest.Request(url, headers={"User-Agent": "hc-client"})
    with _urlrequest.urlopen(req, timeout=900) as r:
        dest.write_bytes(r.read())
    got = _sha256_file(dest)
    want = (os.environ.get("HC_UPDATE_SHA256") or "").strip().lower()
    if want and got != want:
        raise ClientError(f"checksum mismatch: got {got}, want {want}")
    import zipfile

    with zipfile.ZipFile(dest) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".exe")]
        if not names:
            raise ClientError("no exe inside the release zip")
        entry = names[0]
        with z.open(entry) as src, open(dest.with_suffix(".exe"), "wb") as out:
            out.write(src.read())
    new_exe = Path(str(dest) + ".exe")
    # Swap the running process out for the freshly verified one and relaunch.
    import subprocess as _sp

    _sp.Popen([str(new_exe)] + sys.argv[1:], cwd=str(new_exe.parent))
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)





# --------------------------------------------------------------------- proxy --
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
            with _urlrequest.urlopen(req, timeout=300) as resp:
                return resp.status, resp.read()

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
                status, data = self._upstream(
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

            status, data = self._upstream(self.command, self.path, self._body() or None, token)
            self.send_response(status)
            ct = self.headers.get("content-type") or "application/json"
            if "json" in ct:
                ct = "application/json"
            self.send_header("content-type", ct)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self._dispatch()

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch()

        def do_PUT(self) -> None:  # noqa: N802
            self._dispatch()

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch()

    return ProxyHandler


def _serve_proxy(port: int, upstream_base: str) -> ThreadingHTTPServer:
    handler = _make_proxy_handler(HomescapesClient(), upstream_base)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True

    def _run() -> None:
        server.serve_forever()
        try:
            server.server_close()
        except Exception:
            pass

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    print(f"[hc_client] proxy listening on http://127.0.0.1:{port} -> {upstream_base}", flush=True)
    thread.join()
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
    """Open a native WebView2 window over the local studio server."""
    try:
        import webview  # pywebview
    except ImportError:
        sys.stderr.write(
            "pywebview is not installed. Either:\n"
            "  pip install pywebview\n"
            "or run the bridge in JSON mode (pass a command such as `devices`).\n"
        )
        return 2

    url = os.environ.get("HC_STUDIO_URL", "http://127.0.0.1:8787")
    window = webview.create_window(
        APP_NAME,
        url,
        width=1440,
        height=900,
        min_size=(1024, 700),
        background_color="#0b0f17",
    )
    # Expose the bridge so the UI can drive ADB without an HTTP hop.
    window.expose(HomescapesClient())
    webview.start(debug=bool(os.environ.get("HC_DEBUG")))
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
