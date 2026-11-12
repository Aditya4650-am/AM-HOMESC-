"""Fresh Start: backup first, delete exactly three files, restore exactly those.

Run with:  python -m unittest client.test_fresh_start  (from the repo root)
"""

import base64
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import hc_client as hc  # noqa: E402

PKG = "com.playrix.homescapes"
PATH = "/data/user/0/" + PKG + "/files/SaveGame.db"
SAVE = b'{"Properties":{"LID_Lvl":1}}'
NAMES = ("SaveGame.db", "SaveGame.db.bak", "SaveGame.db.buf")
SERIAL = "emulator-5554"


def snapshot(serial: str = SERIAL) -> dict:
    return {
        "ok": True,
        "schema": 1,
        "serial": serial,
        "package": PKG,
        "file": PATH,
        "files": {
            name: base64.b64encode(SAVE + str(i).encode()).decode("ascii")
            for i, name in enumerate(NAMES)
        },
    }


def ok_adb(_adb, _args, **_kw):
    return 0, b"", b""


class FreshStartTests(unittest.TestCase):
    def setUp(self):
        hc._ACTIVE_PACKAGE.clear()
        hc._PATH_CACHE.clear()
        self._old_appdata = os.environ.get("APPDATA")
        self._tmp = tempfile.mkdtemp()
        os.environ["APPDATA"] = self._tmp

    def tearDown(self):
        if self._old_appdata is None:
            os.environ.pop("APPDATA", None)
        else:
            os.environ["APPDATA"] = self._old_appdata
        shutil.rmtree(self._tmp, ignore_errors=True)

    # ---------------------------------------------------------------- delete --

    def test_delete_targets_only_the_three_named_files(self):
        item = snapshot()
        calls = []

        def adb(adb_path, args, **kw):
            calls.append(args)
            return 0, b"", b""

        with (
            patch.object(hc, "_find_adb", return_value="adb"),
            patch.object(hc, "_is_pkg_installed", return_value=True),
            patch.object(hc.HomescapesClient, "_fresh_stop"),
            patch.object(hc.HomescapesClient, "_fresh_read_files", return_value=item["files"]),
            patch.object(hc, "_run_adb", side_effect=adb),
            patch.object(hc.HomescapesClient, "start") as start,
        ):
            result = hc.HomescapesClient().fresh_start(SERIAL, item)

        self.assertTrue(result["ok"])
        start.assert_called_once_with(SERIAL)

        parent = PATH.rsplit("/", 1)[0]
        command = calls[0][-1]
        self.assertIn("rm -f", command)
        for name in NAMES:
            self.assertIn(f'"{parent}/{name}"', command)
        # Nothing outside the three literal paths may appear in the command.
        self.assertNotIn(".hcsbak", command)
        self.assertNotIn("*", command)
        self.assertNotIn("rm -rf", command)

    def test_changed_save_refuses_to_delete_anything(self):
        item = snapshot()
        with (
            patch.object(hc, "_find_adb", return_value="adb"),
            patch.object(hc, "_is_pkg_installed", return_value=True),
            patch.object(hc.HomescapesClient, "_fresh_stop"),
            patch.object(hc.HomescapesClient, "_fresh_read_files", return_value={}),
            patch.object(hc, "_run_adb") as run,
        ):
            with self.assertRaises(hc.ClientError):
                hc.HomescapesClient().fresh_start(SERIAL, item)
        run.assert_not_called()

    def test_bad_source_is_refused_before_any_device_call(self):
        cases = [
            dict(snapshot(), serial="other-device"),
            dict(snapshot(), file="/data/data/com.evil.app/files/SaveGame.db"),
            dict(snapshot(), files={"SaveGame.db": "AA=="}),
            dict(snapshot(), package="com.somethingelse"),
            dict(snapshot(), file="/data/user/0/%s/../../etc/SaveGame.db" % PKG),
        ]
        for index, item in enumerate(cases):
            with (
                self.subTest(case=index),
                patch.object(hc, "_run_adb") as run,
                patch.object(hc, "_find_adb", return_value="adb"),
            ):
                with self.assertRaises(hc.ClientError):
                    hc.HomescapesClient().fresh_start(SERIAL, item)
                run.assert_not_called()

    def test_failed_delete_restores_the_originals_and_never_launches(self):
        item = snapshot()
        with (
            patch.object(hc, "_find_adb", return_value="adb"),
            patch.object(hc, "_is_pkg_installed", return_value=True),
            patch.object(hc.HomescapesClient, "_fresh_stop"),
            patch.object(hc.HomescapesClient, "_fresh_read_files", return_value=item["files"]),
            patch.object(hc, "_run_adb", return_value=(1, b"", b"permission denied")),
            patch.object(hc.HomescapesClient, "_fresh_restore_files") as restore,
            patch.object(hc.HomescapesClient, "start") as start,
        ):
            with self.assertRaises(hc.ClientError):
                hc.HomescapesClient().fresh_start(SERIAL, item)
        restore.assert_called_once()
        start.assert_not_called()

    # -------------------------------------------------------------- snapshot --

    def test_snapshot_handles_an_absent_sibling_file(self):
        def adb(_adb, args, **_kw):
            return 0, (b"ABSENT" if "SaveGame.db.buf" in args[-1] else b"PRESENT"), b""

        def pull(_adb, _serial, remote, *_a):
            self.assertIn(remote, (PATH, PATH + ".bak"))
            return SAVE

        with (
            patch.object(hc, "_find_adb", return_value="adb"),
            patch.object(hc, "_is_pkg_installed", return_value=True),
            patch.object(hc.HomescapesClient, "_fresh_stop"),
            patch.object(hc.HomescapesClient, "_read_save", return_value=(PATH, SAVE)),
            patch.object(hc, "_run_adb", side_effect=adb),
            patch.object(hc, "_pull_privileged", side_effect=pull),
        ):
            result = hc.HomescapesClient().fresh_snapshot(SERIAL, PKG, PATH)

        self.assertEqual(set(result["files"]), set(NAMES))
        self.assertIsNone(result["files"]["SaveGame.db.buf"])
        self.assertEqual(result["serial"], SERIAL)

    # --------------------------------------------------------------- restore --

    def test_restore_puts_back_all_three_original_byte_sequences(self):
        item = snapshot()
        with (
            patch.object(hc, "_find_adb", return_value="adb"),
            patch.object(hc, "_is_pkg_installed", return_value=True),
            patch.object(hc.HomescapesClient, "_fresh_stop"),
            patch.object(hc.HomescapesClient, "_fresh_restore_files") as restore,
            patch.object(hc.HomescapesClient, "start"),
        ):
            hc.HomescapesClient().fresh_start(SERIAL, item, restore=True)

        decoded = restore.call_args.args[-1]
        for name in NAMES:
            self.assertEqual(decoded[name], base64.b64decode(item["files"][name]))

    # -------------------------------------------------- backup on this PC --

    def test_new_account_writes_the_backup_before_anything_is_removed(self):
        item = snapshot()
        seen: dict[str, bool] = {}

        def adb(_adb, args, **_kw):
            # Record whether the local copy already exists at the moment the
            # rm command reaches the device — it must, always.
            if "rm -f" in " ".join(args):
                seen["backup_before_rm"] = hc.latest_fresh_backup(SERIAL) is not None
            return 0, b"", b""

        with (
            patch.object(hc, "_find_adb", return_value="adb"),
            patch.object(hc, "_is_pkg_installed", return_value=True),
            patch.object(hc.HomescapesClient, "_read_save", return_value=(PATH, SAVE)),
            patch.object(hc.HomescapesClient, "_fresh_read_files", return_value=item["files"]),
            patch.object(hc, "_run_adb", side_effect=adb),
            patch.object(hc.HomescapesClient, "start"),
        ):
            result = hc.HomescapesClient().fresh_new_account(SERIAL)

        self.assertTrue(result["ok"])
        backup = Path(result["localBackup"])
        self.assertTrue(backup.is_file(), "the copy must be on disk")
        record = json.loads(backup.read_text(encoding="utf-8"))
        self.assertEqual(record["serial"], SERIAL)
        self.assertEqual(set(record["files"]), set(NAMES))
        self.assertTrue(seen["backup_before_rm"], "backup must precede the rm")
        # And the newest record for this device is the one just taken.
        self.assertEqual(hc.latest_fresh_backup(SERIAL), backup)

    def test_latest_backup_ignores_other_devices_and_junk(self):
        directory = hc.fresh_backup_dir()
        directory.mkdir(parents=True, exist_ok=True)
        (directory / ("fresh-start-9999999999999-" + "a" * 32 + ".json")).write_text(
            json.dumps(snapshot(serial="someone-else")), encoding="utf-8"
        )
        (directory / "fresh-start-123-not-a-uuid.json").write_text("{}", encoding="utf-8")
        (directory / "notes.txt").write_text("hi", encoding="utf-8")
        (directory / ("fresh-start-1111111111111-" + "b" * 32 + ".json")).write_text(
            json.dumps(snapshot(serial=SERIAL)), encoding="utf-8"
        )
        found = hc.latest_fresh_backup(SERIAL)
        self.assertIsNotNone(found)
        self.assertIn("1111111111111", found.name)

        self.assertIsNone(hc.latest_fresh_backup("no-such-device"))

    def test_restore_without_a_backup_is_a_clear_error(self):
        with self.assertRaises(hc.ClientError) as ctx:
            hc.HomescapesClient().fresh_restore(SERIAL)
        self.assertIn("no backup", str(ctx.exception))

    def test_restore_refuses_an_oversized_record(self):
        directory = hc.fresh_backup_dir()
        directory.mkdir(parents=True, exist_ok=True)
        name = directory / ("fresh-start-1234567890123-" + "c" * 32 + ".json")
        name.write_bytes(b"x" * (hc.FRESH_BACKUP_LIMIT + 1))
        with self.assertRaises(hc.ClientError) as ctx:
            hc.HomescapesClient().fresh_restore(SERIAL, str(name))
        self.assertIn("too large", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
