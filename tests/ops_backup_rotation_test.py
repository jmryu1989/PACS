"""Daily backup rotation (D1047): synthetic backup roots only, real files and real deletions inside a temporary folder.

The production root showed what accumulates: 25 GB of daily sets beside release sets (s4-/s5-/stage1-/deploy-), a
latest-verified-*.json record and a scheduled.log. Rotation keeps N complete daily generations and never removes a
set that something else still needs; these cases bind that contract and the backup CLI's "only after a complete
backup" rule.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import contextlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_audit_integrity as audit
import ops_backup as ops
import ops_monitor as monitor

NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)


def daily(day, suffix="0" * 8):
    return "202609%02d-200002-%s" % (day, suffix)


class Root:
    def __init__(self, folder):
        self.path = Path(folder) / "backups"
        self.path.mkdir(mode=0o700)

    def daily(self, name, complete=True, manifest=True, created=None):
        folder = self.path / name
        folder.mkdir(mode=0o700)
        if manifest:
            stamp = (created or NOW).isoformat()
            (folder / "manifest.json").write_text(json.dumps({"format": 1, "complete": complete, "created_utc": stamp,
                                                              "ready": True, "resume_failures": []}))
        (folder / "orthanc.tgz").write_bytes(b"synthetic archive bytes")
        return folder

    def names(self):
        return sorted(entry.name for entry in self.path.iterdir())


class RotationTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Root(folder.name)

    def rotate(self, keep=7, **kwargs):
        return ops.rotate(self.root.path, keep, now=NOW, **kwargs)

    def test_01_keeps_the_newest_generations_and_deletes_older_daily_sets(self):
        for day in range(1, 26):
            self.root.daily(daily(day))
        result = self.rotate()
        self.assertEqual(result["generations"], [daily(day) for day in range(25, 18, -1)])
        self.assertEqual(result["deleted"], [daily(day) for day in range(1, 19)])
        self.assertEqual(self.root.names(), [daily(day) for day in range(19, 26)])

    def test_02_never_touches_release_sets_records_or_logs(self):
        for day in range(1, 12):
            self.root.daily(daily(day))
        others = ["s4-489c326-20260926T051901Z", "s5-b9690cc-20260927T105611Z", "stage1-17980d5-20260916T234959Z",
                  "deploy-C1-20260906-004315", "20260903-025812-members", "emr-b0-20261013T010000Z-0123abcd", "scheduled.log"]
        for name in others:
            (self.root.path / name).mkdir() if "." not in name else (self.root.path / name).write_text("log")
        self.rotate()
        for name in others:
            self.assertTrue((self.root.path / name).exists(), name)

    def test_03_protected_held_and_latest_verified_sets_stay(self):
        for day in range(1, 15):
            self.root.daily(daily(day))
        (self.root.path / daily(2) / ops.HOLD_FILE).write_text("{}")
        (self.root.path / "latest-verified-C.json").write_text(json.dumps({"backup": str(self.root.path / daily(3)), "success": True}))
        result = self.rotate(protect={daily(4)})
        self.assertEqual(result["retained"], {daily(2): "hold", daily(3): "latest-verified", daily(4): "protected"})
        for day in (2, 3, 4, *range(8, 15)):
            self.assertTrue((self.root.path / daily(day)).is_dir(), day)
        for day in (1, 5, 6, 7):
            self.assertFalse((self.root.path / daily(day)).exists(), day)

    def test_04_incomplete_or_unreadable_sets_are_neither_counted_nor_deleted(self):
        for day in range(1, 10):
            self.root.daily(daily(day))
        self.root.daily(daily(10), complete=False)
        self.root.daily(daily(11), manifest=False)
        result = self.rotate(keep=3)
        self.assertEqual(result["generations"], [daily(9), daily(8), daily(7)])
        self.assertEqual(result["retained"], {daily(10): "incomplete", daily(11): "incomplete"})
        self.assertTrue((self.root.path / daily(10)).is_dir() and (self.root.path / daily(11)).is_dir())

    def test_05_dry_run_lists_without_deleting(self):
        for day in range(1, 11):
            self.root.daily(daily(day))
        before = self.root.names()
        result = self.rotate(dry_run=True)
        self.assertEqual(result["would_delete"], [daily(1), daily(2), daily(3)])
        self.assertEqual(self.root.names(), before)

    def test_06_audit_ledger_retention_and_undeclared_checkpoints_win_over_generations(self):
        for day in range(1, 12):
            folder = self.root.daily(daily(day))
            if day in (1, 2):
                (folder / audit.CHECKPOINT).write_text("{}")
                manifest = json.loads((folder / "manifest.json").read_text())
                manifest["sha256"] = {audit.CHECKPOINT: "a" * 64}
                (folder / "manifest.json").write_text(json.dumps(manifest))
        created = (NOW - timedelta(days=40)).isoformat()
        ledger = {"format": audit.FORMAT, "ledger_id": "f" * 32, "entries": [
            {"kind": "init", "at": created, "years": 2},
            {"kind": "seal", "seq": 1, "backup": daily(1), "checkpoint_sha256": "a" * 64, "created_utc": created,
             "retain_until": (NOW + timedelta(days=700)).isoformat(), "previous_verification": {"state": "none"}}]}
        (self.root.path / audit.LEDGER).write_text(json.dumps(ledger))
        self.assertEqual(self.rotate(dry_run=True)["would_thin"], [daily(1)])
        result = self.rotate()
        self.assertEqual(result["retained"], {daily(1): "audit-retention", daily(2): "audit-undeclared"})
        self.assertTrue((self.root.path / daily(1)).is_dir() and (self.root.path / daily(2)).is_dir())
        self.assertEqual(result["deleted"], [daily(3), daily(4)])
        self.assertTrue((self.root.path / audit.LEDGER).is_file())
        # What the ledger's retention reads stays; only the Orthanc archive of the ledger-only set goes, marker first.
        self.assertEqual(result["thinned"], [daily(1)])
        kept = self.root.path / daily(1)
        self.assertEqual(sorted(path.name for path in kept.iterdir()), sorted([audit.CHECKPOINT, "manifest.json", ops.THINNED_FILE]))
        self.assertTrue((self.root.path / daily(2) / "orthanc.tgz").is_file(), "an undeclared checkpoint keeps its whole set")
        self.assertEqual(self.rotate()["thinned"], [])

    def test_12_a_thinned_set_is_never_taken_for_a_restorable_one(self):
        for day in range(1, 10):
            folder = self.root.daily(daily(day))
            (folder / "kin.dump").write_bytes(b"synthetic dump")
        created = (NOW - timedelta(days=40)).isoformat()
        ledger = {"format": audit.FORMAT, "ledger_id": "f" * 32, "entries": [
            {"kind": "init", "at": created, "years": 2},
            {"kind": "seal", "seq": 1, "backup": daily(1), "checkpoint_sha256": "a" * 64, "created_utc": created,
             "retain_until": (NOW + timedelta(days=700)).isoformat(), "previous_verification": {"state": "none"}}]}
        (self.root.path / audit.LEDGER).write_text(json.dumps(ledger))
        self.assertEqual(self.rotate()["thinned"], [daily(1)])
        self.assertTrue((self.root.path / daily(1) / "kin.dump").is_file())
        with self.assertRaisesRegex(RuntimeError, "thinned by rotation"):
            ops.validate_backup(self.root.path / daily(1))
        # A hold on a ledger-retained set keeps all of it.
        (self.root.path / daily(1) / ops.THINNED_FILE).unlink()
        (self.root.path / daily(1) / "orthanc.tgz").write_bytes(b"restored archive")
        (self.root.path / daily(1) / ops.HOLD_FILE).write_text("{}")
        self.assertEqual(self.rotate()["thinned"], [])
        self.assertTrue((self.root.path / daily(1) / "orthanc.tgz").is_file())

    def test_07_an_unreadable_ledger_or_record_refuses_rotation(self):
        for day in range(1, 11):
            self.root.daily(daily(day))
        (self.root.path / audit.LEDGER).write_text("not json")
        with self.assertRaises(Exception):
            self.rotate()
        (self.root.path / audit.LEDGER).unlink()
        (self.root.path / "latest-verified-C.json").write_text("{")
        with self.assertRaisesRegex(RuntimeError, "latest-verified"):
            self.rotate()
        self.assertEqual(len([name for name in self.root.names() if ops.DAILY_NAME.fullmatch(name)]), 10)

    def test_08_a_reader_never_sees_half_a_set_and_an_interrupted_deletion_resumes(self):
        for day in range(1, 10):
            self.root.daily(daily(day))
        removed = []
        real = ops.shutil.rmtree

        def interrupted(path, *args, **kwargs):
            # The set has already left the daily namespace before any byte is removed.
            self.assertTrue(Path(path).name.startswith(ops.ROTATING))
            removed.append(Path(path).name)
            raise OSError("interrupted")
        with patch.object(ops.shutil, "rmtree", side_effect=interrupted), self.assertRaises(OSError):
            self.rotate()
        self.assertEqual(removed, [ops.ROTATING + daily(1)])
        rows = monitor.backup_status(self.root.path, self.root.path / ".no-lock", int(NOW.timestamp()) + 3600)
        self.assertIsInstance(rows, tuple)
        result = self.rotate()
        self.assertEqual(result["resumed"], [ops.ROTATING + daily(1)])
        self.assertEqual(result["deleted"], [daily(2)])
        self.assertFalse(any(name.startswith(ops.ROTATING) for name in self.root.names()))
        self.assertIs(real, ops.shutil.rmtree)

    def test_09_bounds_and_root_safety(self):
        for keep in (0, 366, True, "7"):
            with self.subTest(keep=keep), self.assertRaisesRegex(RuntimeError, "between 1 and 365"):
                self.rotate(keep=keep)
        with self.assertRaisesRegex(RuntimeError, "outside the Git repository"):
            ops.rotate(ops.ROOT, 7)
        link = self.root.path.parent / "link"
        try:
            link.symlink_to(self.root.path, target_is_directory=True)
        except (OSError, NotImplementedError):
            return
        with self.assertRaisesRegex(RuntimeError, "not a directory"):
            ops.rotate(link, 7)

    def test_10_a_symlink_in_the_daily_namespace_is_refused_without_deleting(self):
        for day in range(1, 10):
            self.root.daily(daily(day))
        try:
            (self.root.path / daily(20)).symlink_to(self.root.path / daily(1), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaisesRegex(RuntimeError, "Invalid backup directory"):
            self.rotate()
        self.assertTrue((self.root.path / daily(1)).is_dir())


class BackupCommandTests(unittest.TestCase):
    def run_main(self, argv, backup):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder) / "repo"), \
                patch.object(ops, "require_local_docker"), patch.object(ops, "backup", side_effect=backup), \
                patch.object(ops, "rotate", wraps=lambda *a, **k: {"deleted": []}) as rotation, \
                patch.object(sys, "argv", ["ops_backup.py", *argv]), contextlib.redirect_stdout(io.StringIO()):
            (Path(folder) / "repo").mkdir()
            try:
                ops.main()
            except RuntimeError:
                pass
            return rotation

    def test_11_backup_rotates_only_after_a_complete_backup_and_protects_it(self):
        made = Path("/backups/20261012-200002-abcdef01")
        # D1047: the daily backup keeps seven generations without any extra argument (the existing schedule line).
        rotation = self.run_main(["backup", "--output", "/backups"], lambda *a: made)
        rotation.assert_called_once()
        self.assertEqual(rotation.call_args.args[1:], (7, {made.name}))
        rotation = self.run_main(["backup", "--output", "/backups", "--rotate-keep", "10"], lambda *a: made)
        self.assertEqual(rotation.call_args.args[1:], (10, {made.name}))

        def failed(*args):
            raise RuntimeError("Write services need recovery: kin-api")
        rotation = self.run_main(["backup", "--output", "/backups"], failed)
        rotation.assert_not_called()
        rotation = self.run_main(["backup", "--output", "/backups", "--no-rotate"], lambda *a: made)
        rotation.assert_not_called()
        calls = []
        rotation = self.run_main(["backup", "--output", "/backups", "--rotate-keep", "0"], lambda *a: calls.append(1) or made)
        rotation.assert_not_called()
        self.assertEqual(calls, [], "an invalid rotation refuses before the backup")


if __name__ == "__main__":
    unittest.main(verbosity=2)
