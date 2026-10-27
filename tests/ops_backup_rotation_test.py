"""Daily backup rotation (D1047): synthetic backup roots only, real files and real deletions inside a temporary folder.

The production root showed what accumulates: 25 GB of daily sets beside release sets (s4-/s5-/stage1-/deploy-), a
latest-verified-*.json record and a scheduled.log. Rotation keeps N complete daily generations and never removes a
set that something else still needs; these cases bind that contract and the backup CLI's "only after a complete
backup" rule.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
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

    def daily(self, name, complete=True, manifest=True, created=None, checkpoint=False):
        """A physically whole daily set as backup() leaves it: the six components and a manifest with their SHA-256 and
        sizes (plus a declared audit checkpoint when asked)."""
        folder = self.path / name
        folder.mkdir(mode=0o700)
        sums, sizes = {}, {}
        for component in (*ops.FILES, *((audit.CHECKPOINT,) if checkpoint else ())):
            raw = ("synthetic " + component + " of " + name).encode()
            (folder / component).write_bytes(raw)
            sums[component], sizes[component] = hashlib.sha256(raw).hexdigest(), len(raw)
        if manifest:
            stamp = (created or NOW).isoformat()
            (folder / "manifest.json").write_text(json.dumps({"format": 1, "complete": complete, "created_utc": stamp,
                                                              "ready": True, "resume_failures": [], "sha256": sums, "bytes": sizes}))
        return folder

    def manifest(self, name):
        return json.loads((self.path / name / "manifest.json").read_text())

    def names(self):
        return sorted(entry.name for entry in self.path.iterdir())


class RotationTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Root(folder.name)
        repository = Path(folder.name) / "repository"
        repository.mkdir(mode=0o700)
        self.enterContext(patch.object(ops, "ROOT", repository))

    def rotate(self, keep=7, **kwargs):
        return ops.rotate(self.root.path, keep, now=NOW, **kwargs)

    def test_01_keeps_the_newest_generations_and_deletes_older_daily_sets(self):
        for day in range(1, 26):
            self.root.daily(daily(day))
        result = self.rotate()
        self.assertEqual(result["generations"], [daily(day) for day in range(25, 18, -1)])
        self.assertEqual(result["deleted"], [daily(day) for day in range(1, 19)])
        self.assertEqual(self.root.names(), [daily(day) for day in range(19, 26)])

    def custody(self, folder):
        root = self.root.path.parent / "custody"
        root.mkdir(exist_ok=True)
        directory = root / folder.name
        # capture_wrapping_custody creates each snapshot's copy private (0700); Linux rotation checks that mode.
        directory.mkdir(mode=0o700)
        key = directory / "wrap-0.key"
        key.write_bytes(bytes(range(32)))
        manifest = self.root.manifest(folder.name)
        manifest["wrapping_custody"] = {"directory": str(directory), "files": {
            "wrap": {"file": key.name, "sha256": ops.digest(key), "bytes": 32}}}
        (folder / "manifest.json").write_text(json.dumps(manifest))
        config = self.root.path.parent / "custody.json"
        config.write_text(json.dumps({"backup_root": str(root)}))
        self.enterContext(patch.dict(os.environ, {"KIN_EMR_WRAPPING_CUSTODY": str(config)}))
        return directory

    def test_rotation_retires_only_deleted_generations_custody(self):
        old, held, current = [self.root.daily(daily(day)) for day in (1, 2, 3)]
        old_keys, held_keys, current_keys = [self.custody(folder) for folder in (old, held, current)]
        dry = self.rotate(keep=1, protect={held.name}, dry_run=True)
        self.assertEqual(dry["would_delete"], [old.name])
        self.assertTrue(old_keys.exists())
        result = self.rotate(keep=1, protect={held.name})
        self.assertEqual(result["deleted"], [old.name])
        self.assertFalse(old_keys.exists())
        self.assertTrue(held_keys.exists())
        self.assertTrue(current_keys.exists())

    def test_rotation_preserves_snapshot_if_custody_does_not_match(self):
        old = self.root.daily(daily(1))
        self.root.daily(daily(2))
        keys = self.custody(old)
        (keys / "wrap-0.key").write_bytes(b"changed")
        result = self.rotate(keep=1)
        self.assertEqual(result["status"], "preserved-stop")
        self.assertTrue(old.exists())
        self.assertTrue(keys.exists())
        self.assertEqual(result["deleted"], [])

    def test_unavailable_custody_configuration_preserves_the_same_dry_run_set(self):
        old = self.root.daily(daily(1))
        self.root.daily(daily(2))
        keys = self.custody(old)
        (self.root.path.parent / "custody.json").unlink()
        dry = self.rotate(keep=1, dry_run=True)
        result = self.rotate(keep=1)
        self.assertEqual(dry["would_delete"], [])
        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["status"], "preserved-stop")
        self.assertTrue(old.exists())
        self.assertTrue(keys.exists())

    def test_thinning_retains_custody_for_the_remaining_database_dump(self):
        old = self.root.daily(daily(1), checkpoint=True)
        self.root.daily(daily(2))
        keys = self.custody(old)
        self.ledger(old.name)
        result = self.rotate(keep=1)
        self.assertEqual(result["thinned"], [old.name])
        self.assertTrue((old / "kin.dump").exists())
        self.assertTrue(keys.exists())
        self.assertEqual(result["custody_deleted"], [])

    def test_key_cleanup_io_failure_is_reported_as_incomplete(self):
        old = self.root.daily(daily(1))
        self.root.daily(daily(2))
        keys = self.custody(old)
        real_remove = ops.shutil.rmtree
        def remove(path, *args, **kwargs):
            if Path(path) == keys:
                raise OSError("synthetic key-storage outage")
            return real_remove(path, *args, **kwargs)
        with patch.object(ops.shutil, "rmtree", side_effect=remove):
            result = self.rotate(keep=1)
        self.assertEqual(result["status"], "preserved-stop")
        self.assertEqual(result["custody_cleanup_pending"], [str(keys)])
        self.assertEqual(result["deleted"], [old.name])
        self.assertTrue(keys.exists())

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

    def ledger(self, *names):
        created = (NOW - timedelta(days=40)).isoformat()
        entries = [{"kind": "init", "at": created, "years": 2}]
        for seq, name in enumerate(names, 1):
            entries.append({"kind": "seal", "seq": seq, "backup": name, "checkpoint_sha256": "a" * 64, "created_utc": created,
                            "retain_until": (NOW + timedelta(days=700)).isoformat(), "previous_verification": {"state": "none"}})
        (self.root.path / audit.LEDGER).write_text(json.dumps({"format": audit.FORMAT, "ledger_id": "f" * 32, "entries": entries}))

    def test_06_audit_ledger_retention_and_undeclared_checkpoints_win_over_generations(self):
        for day in range(1, 12):
            self.root.daily(daily(day), checkpoint=day in (1, 2))
        self.ledger(daily(1))
        self.assertEqual(self.rotate(dry_run=True)["would_thin"], [daily(1)])
        result = self.rotate()
        self.assertEqual(result["retained"], {daily(1): "audit-retention", daily(2): "audit-undeclared"})
        self.assertTrue((self.root.path / daily(1)).is_dir() and (self.root.path / daily(2)).is_dir())
        self.assertEqual(result["deleted"], [daily(3), daily(4)])
        self.assertTrue((self.root.path / audit.LEDGER).is_file())
        # What the ledger's retention reads stays; only the Orthanc archive of the ledger-only set goes, marker first.
        self.assertEqual(result["thinned"], [daily(1)])
        kept = self.root.path / daily(1)
        self.assertEqual(sorted(path.name for path in kept.iterdir()),
                         sorted([*(name for name in ops.FILES if name != "orthanc.tgz"), audit.CHECKPOINT, "manifest.json", ops.THINNED_FILE]))
        self.assertTrue((self.root.path / daily(2) / "orthanc.tgz").is_file(), "an undeclared checkpoint keeps its whole set")
        self.assertEqual(self.rotate()["thinned"], [])

    def test_17_a_set_that_became_incomplete_after_the_plan_is_neither_deleted_nor_thinned(self):
        """IRT2-21: right before a deletion or a thinning the set is checked whole again (files, sizes, SHA-256); one that
        lost a component or changed one since the plan stays, with the reason, and the other planned sets go."""
        for day in range(1, 12):
            self.root.daily(daily(day), checkpoint=day == 4)
        self.ledger(daily(4))
        original = ops._rotation_plan
        first = True

        def plan_then_damage(*args, **kwargs):
            nonlocal first
            planned = original(*args)
            if not first:
                return planned
            first = False
            self.assertEqual((planned["delete"], planned["thin"]), ([daily(1), daily(2), daily(3)], [daily(4)]))
            (self.root.path / daily(1) / "kin.dump").unlink()
            (self.root.path / daily(2) / "keycloak.dump").write_bytes(b"changed after the plan")
            (self.root.path / daily(4) / "kin.dump").unlink()
            return planned
        with patch.object(ops, "_rotation_plan", side_effect=plan_then_damage):
            result = self.rotate()
        self.assertEqual(result["deleted"], [daily(3)])
        self.assertEqual(result["thinned"], [])
        self.assertTrue(result["retained"][daily(1)].startswith("incomplete before deletion: component missing: kin.dump"))
        self.assertTrue(result["retained"][daily(2)].startswith("incomplete before deletion: component differs: keycloak.dump"))
        self.assertTrue(result["retained"][daily(4)].startswith("incomplete before thinning"))
        for day in (1, 2, 4):
            self.assertTrue((self.root.path / daily(day)).is_dir())
        self.assertTrue((self.root.path / daily(4) / "orthanc.tgz").is_file())

    def test_13_an_interrupted_deletion_is_rejudged_and_kept_when_anything_protects_it(self):
        """IRT-09: a .rotating-<name> left by an interrupted run is judged again by its original name and its folder."""
        for day in range(10, 18):
            self.root.daily(daily(day))
        cases = {daily(1): "hold", daily(2): "protected", daily(3): "latest-verified", daily(4): "audit-retention",
                 daily(5): "audit-undeclared", daily(6): None}
        for day, (name, reason) in enumerate(cases.items(), 1):
            folder = self.root.path / (ops.ROTATING + name)
            self.root.daily(name).rename(folder)
            if reason == "hold":
                (folder / ops.HOLD_FILE).write_text("{}")
            if reason == "audit-undeclared":
                (folder / audit.CHECKPOINT).write_text("{}")
                (folder / "manifest.json").write_text(json.dumps({"format": 1, "complete": True, "sha256": {audit.CHECKPOINT: "b" * 64}}))
        (self.root.path / "latest-verified-C.json").write_text(json.dumps({"backup": str(self.root.path / daily(3)), "success": True}))
        self.ledger(daily(4))
        planned = self.rotate(protect={daily(2)}, dry_run=True)
        result = self.rotate(protect={daily(2)})
        expected = {ops.ROTATING + name: reason for name, reason in cases.items() if reason}
        self.assertEqual(planned["kept_leftovers"], expected)
        self.assertEqual(result["kept_leftovers"], expected)
        self.assertEqual((planned["would_resume"], result["resumed"]), ([ops.ROTATING + daily(6)], [ops.ROTATING + daily(6)]))
        for name, reason in cases.items():
            self.assertEqual((self.root.path / (ops.ROTATING + name)).is_dir(), reason is not None, name)

    def test_14_physically_incomplete_sets_are_neither_counted_nor_deleted(self):
        """IRT-09: completeness is the files and their checksums, not the manifest's flag."""
        for day in range(1, 13):
            self.root.daily(daily(day))
        breaks = {daily(12): lambda folder: (folder / "orthanc.tgz").unlink(),
                  daily(11): lambda folder: (folder / "kin.dump").write_bytes(b"other bytes of the same name"),
                  daily(2): lambda folder: (folder / "keycloak.dump").write_bytes(b"x"),
                  daily(1): lambda folder: self.rewrite(folder, bytes={})}
        for name, change in breaks.items():
            change(self.root.path / name)
        planned = self.rotate(dry_run=True)
        result = self.rotate()
        self.assertEqual(result["generations"], [daily(day) for day in range(10, 3, -1)])
        self.assertEqual((planned["would_delete"], result["deleted"]), ([daily(3)], [daily(3)]))
        self.assertEqual(set(result["incomplete"]), set(breaks))
        self.assertEqual({name: result["retained"][name] for name in breaks}, {name: "incomplete" for name in breaks})
        for name in breaks:
            self.assertTrue((self.root.path / name).is_dir(), name)

    def rewrite(self, folder, **changes):
        manifest = json.loads((folder / "manifest.json").read_text())
        manifest.update(changes)
        (folder / "manifest.json").write_text(json.dumps(manifest))

    def test_15_dry_run_is_exactly_the_plan_the_run_executes(self):
        for day in range(1, 16):
            self.root.daily(daily(day), checkpoint=day == 1)
        (self.root.path / daily(5) / ops.HOLD_FILE).write_text("{}")
        (self.root.path / (ops.ROTATING + daily(20))).mkdir()
        self.ledger(daily(1))
        for name in ("s5-b9690cc-20260927T105611Z", "emr-b0-20261013T010000Z-0123abcd"):
            (self.root.path / name).mkdir()
        planned = self.rotate(protect={daily(15)}, dry_run=True)
        before = self.root.names()
        self.assertEqual(self.root.names(), before)
        result = self.rotate(protect={daily(15)})
        for key in ("generations", "retained", "incomplete", "kept_leftovers"):
            self.assertEqual(planned[key], result[key], key)
        self.assertEqual((planned["would_delete"], planned["would_thin"], planned["would_resume"]),
                         (result["deleted"], result["thinned"], result["resumed"]))
        self.assertEqual(result["deleted"], [daily(day) for day in (2, 3, 4, 6, 7, 8)])
        for name in (daily(15), daily(5), "s5-b9690cc-20260927T105611Z", "emr-b0-20261013T010000Z-0123abcd"):
            self.assertTrue((self.root.path / name).is_dir(), name)

    def test_16_a_hold_arriving_after_the_plan_keeps_the_set(self):
        for day in range(1, 10):
            self.root.daily(daily(day))
        real = ops.os.rename

        def rename_then_hold(source, target):
            real(source, target)
            if Path(source).name == daily(1):
                (Path(target) / ops.HOLD_FILE).write_text("{}")
        with patch.object(ops.os, "rename", side_effect=rename_then_hold):
            result = self.rotate()
        self.assertEqual(result["deleted"], [daily(2)])
        self.assertIn(ops.ROTATING + daily(1), result["kept_leftovers"])
        self.assertTrue((self.root.path / (ops.ROTATING + daily(1)) / "kin.dump").is_file())

    def test_12_a_thinned_set_is_never_taken_for_a_restorable_one(self):
        for day in range(1, 10):
            self.root.daily(daily(day))
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
            if os.name != "nt":
                self.fail("the filesystem cannot exercise the backup-root link boundary")
            import subprocess
            made = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(self.root.path)], capture_output=True)
            self.assertEqual(made.returncode, 0, "the owned Windows junction fixture must be created")
        try:
            with self.assertRaisesRegex(RuntimeError, "not a directory"):
                ops.rotate(link, 7)
        finally:
            if os.name == "nt":
                link.rmdir()
            else:
                link.unlink()

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


class RotationContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Root(temporary.name)
        self.repository = Path(temporary.name) / "repository"
        self.repository.mkdir(mode=0o700)
        change = patch.object(ops, "ROOT", self.repository)
        change.start()
        self.addCleanup(change.stop)
        for day in range(1, 9):
            self.root.daily(daily(day))

    def rotate(self, **kwargs):
        return ops.rotate(self.root.path, 7, now=NOW, **kwargs)

    def test_partial_rmtree_is_not_resumed_and_a_malformed_reference_never_authorizes_delete(self):
        def interrupted(path):
            (Path(path) / "kin.dump").unlink()
            raise OSError("synthetic partial rmtree")
        with patch.object(ops.shutil, "rmtree", side_effect=interrupted), self.assertRaises(OSError):
            self.rotate()
        moved = self.root.path / (ops.ROTATING + daily(1))
        result = self.rotate()
        self.assertTrue((moved / "keycloak.dump").exists())
        self.assertEqual(result["resumed"], [])
        self.assertEqual(result["status"], "preserved-stop")
        (self.root.path / "latest-verified-C.json").write_text("{}")
        with self.assertRaises(RuntimeError):
            self.rotate()

    def test_hardlinked_component_cannot_admit_deletion(self):
        folder = self.root.path / daily(1)
        elsewhere = self.root.path.parent / "other-owner-data"
        try:
            os.link(folder / "kin.dump", elsewhere)
        except OSError:
            self.skipTest("hard links unavailable")
        result = self.rotate()
        self.assertEqual(result["deleted"], [])
        self.assertTrue(folder.exists())
        self.assertEqual(elsewhere.read_bytes(), (folder / "kin.dump").read_bytes())

    def test_retained_operation_lease_never_authorizes_rotation(self):
        with ops.lock() as lease:
            lease.retain()
            try:
                with self.assertRaises(RuntimeError):
                    self.rotate()
                self.assertTrue((self.root.path / daily(1)).exists())
            finally:
                lease.retained = False  # This synthetic lease has no worker or uncertain operation.

    @unittest.skipUnless(os.name == "posix", "POSIX owner/mode contract")
    def test_unprotected_parent_refuses_before_any_change(self):
        parent = self.root.path.parent
        previous = parent.stat().st_mode & 0o7777
        parent.chmod(0o777)
        try:
            with self.assertRaises(RuntimeError):
                self.rotate()
            self.assertTrue((self.root.path / daily(1)).exists())
        finally:
            parent.chmod(previous)

    def test_rename_then_changed_component_preserves_the_whole_remaining_set(self):
        original = ops.os.rename
        def damage(source, target):
            original(source, target)
            (Path(target) / "kin.dump").write_bytes(b"damaged after rename")
        with patch.object(ops.os, "rename", side_effect=damage):
            result = self.rotate()
        self.assertTrue((self.root.path / (ops.ROTATING + daily(1)) / "orthanc.tgz").exists())
        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["status"], "preserved-stop")

    def test_resumed_deletion_damage_after_plan_is_preserved(self):
        folder = self.root.path / daily(1)
        moved = folder.with_name(ops.ROTATING + folder.name)
        folder.rename(moved)
        original, first = ops._rotation_plan, True
        def damage(*args, **kwargs):
            nonlocal first
            result = original(*args)
            if first:
                first = False
                (moved / "kin.dump").unlink()
            return result
        with patch.object(ops, "_rotation_plan", side_effect=damage):
            result = self.rotate()
        self.assertTrue((moved / "orthanc.tgz").exists())
        self.assertEqual(result["resumed"], [])
        self.assertEqual(result["status"], "preserved-stop")

    def test_truncated_marker_never_permits_an_absent_archive(self):
        folder = self.root.path / daily(1)
        (folder / "orthanc.tgz").unlink()
        (folder / ops.THINNED_FILE).write_text("{truncated", encoding="utf-8")
        before = {str(path.relative_to(self.root.path)): path.read_bytes() for path in self.root.path.rglob("*") if path.is_file()}
        result = self.rotate(dry_run=True)
        self.assertNotIn(daily(1), result["would_delete"])
        self.assertIn(daily(1), result["incomplete"])
        self.assertEqual(before, {str(path.relative_to(self.root.path)): path.read_bytes() for path in self.root.path.rglob("*") if path.is_file()})
        self.assertFalse((self.repository / ".kin-ops.lock").exists())
        self.assertEqual(self.rotate()["deleted"], [])
        self.assertTrue(folder.exists())

    def test_new_hold_reference_audit_protect_or_keep_loss_after_rename_preserves(self):
        for change in ("hold", "latest", "audit", "protect", "keep", "manifest", "manifest-change", "lock"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Root(temporary)
                for day in range(1, 9):
                    root.daily(daily(day))
                protected = set()
                original = ops.os.rename
                def intervene(source, target):
                    original(source, target)
                    folder = Path(target)
                    if change == "hold":
                        (folder / ops.HOLD_FILE).write_text("{}")
                    elif change == "latest":
                        (root.path / "latest-verified-C.json").write_text(json.dumps({"backup": str(root.path / daily(1))}))
                    elif change == "audit":
                        old_root = self.root
                        self.root = root
                        try:
                            RotationTests.ledger(self, daily(1))
                        finally:
                            self.root = old_root
                    elif change == "protect":
                        protected.add(daily(1))
                    elif change == "keep":
                        (root.path / daily(8) / "kin.dump").unlink()
                    elif change == "manifest":
                        (folder / "manifest.json").unlink()
                    elif change == "manifest-change":
                        manifest = folder / "manifest.json"
                        manifest.write_bytes(manifest.read_bytes() + b"\n")
                    else:
                        (self.repository / ".kin-ops.lock").write_text("foreign-owner")
                with patch.object(ops.os, "rename", side_effect=intervene):
                    if change == "lock":
                        with self.assertRaises(RuntimeError):
                            ops.rotate(root.path, 7, protect=protected, now=NOW)
                        (self.repository / ".kin-ops.lock").unlink()  # This test's synthetic marker; the product preserved it.
                    else:
                        result = ops.rotate(root.path, 7, protect=protected, now=NOW)
                        self.assertEqual(result["deleted"], [])
                        self.assertEqual(result["status"], "preserved-stop")
                self.assertTrue((root.path / (ops.ROTATING + daily(1)) / "orthanc.tgz").exists())

    def test_thin_interruption_marker_binding_and_remaining_components(self):
        RotationTests.ledger(self, daily(1))
        folder = self.root.path / daily(1)
        archive = folder / "orthanc.tgz"
        real_unlink = Path.unlink
        def interrupted(path, *args, **kwargs):
            if path == archive:
                raise OSError("synthetic power loss before archive unlink")
            return real_unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", interrupted), self.assertRaises(OSError):
            self.rotate()
        marker = json.loads((folder / ops.THINNED_FILE).read_text())
        self.assertEqual(marker["state"], "THIN_PLANNED")
        self.assertTrue(archive.exists())
        self.assertEqual(self.rotate()["thinned"], [daily(1)])
        complete = (folder / ops.THINNED_FILE).read_bytes()
        self.assertEqual(json.loads(complete)["state"], "THINNED_COMPLETE")
        self.assertIsNone(ops._daily_whole(folder))
        for field, value in (("backup", daily(2)), ("manifest_sha256", "0" * 64), ("state", "THIN_PLANNED"),
                             ("archive_sha256", "0" * 64), ("keep", 0), ("at", "2026-10-12T12:00:00+09:00")):
            changed = json.loads(complete)
            changed[field] = value
            (folder / ops.THINNED_FILE).write_text(json.dumps(changed))
            with self.subTest(field=field):
                self.assertIsNotNone(ops._daily_whole(folder))
                self.assertTrue(folder.exists())
        (folder / ops.THINNED_FILE).write_bytes(complete)
        (folder / "keycloak.dump").unlink()
        self.assertIsNotNone(ops._daily_whole(folder))
        self.assertEqual(self.rotate()["thinned"], [])

    def test_incomplete_thin_marker_and_new_protection_before_unlink_preserve(self):
        RotationTests.ledger(self, daily(1))
        folder = self.root.path / daily(1)
        original = audit.replace_json
        def hold(path, body):
            original(path, body)
            if path.name == ops.THINNED_FILE:
                (folder / ops.HOLD_FILE).write_text("{}")
        with patch.object(audit, "replace_json", side_effect=hold):
            result = self.rotate()
        self.assertEqual(result["thinned"], [])
        self.assertTrue((folder / "orthanc.tgz").exists())
        (folder / ops.HOLD_FILE).unlink()
        (folder / "orthanc.tgz").unlink()
        result = self.rotate()
        self.assertEqual(result["deleted"], [])
        self.assertNotIn(daily(1), result["incomplete"])
        self.assertEqual(json.loads((folder / ops.THINNED_FILE).read_text())["state"], "THINNED_COMPLETE")

    def test_valid_thinned_completion_can_be_deleted_only_after_retention_expires(self):
        RotationTests.ledger(self, daily(1))
        self.assertEqual(self.rotate()["thinned"], [daily(1)])
        result = ops.rotate(self.root.path, 7, now=NOW + timedelta(days=4000))
        self.assertEqual(result["deleted"], [daily(1)])

    def test_marker_symlink_and_orphan_are_preserved(self):
        folder = self.root.path / daily(1)
        try:
            (folder / ops.THINNED_FILE).symlink_to(folder / "manifest.json")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.assertIsNotNone(ops._daily_whole(folder))
        orphan = self.root.path / (ops.ROTATING + daily(2))
        (self.root.path / daily(2)).rename(orphan)
        (orphan / "manifest.json").unlink()
        result = self.rotate()
        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["resumed"], [])
        self.assertTrue(orphan.exists())


class BackupCommandTests(unittest.TestCase):
    def run_main(self, argv, backup):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder) / "repo"), \
                patch.object(ops, "require_local_docker"), patch.object(ops, "backup", side_effect=backup), \
                patch.object(ops, "rotate", wraps=lambda *a, **k: {"deleted": [], "status": "complete"}) as rotation, \
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


class RoundFiveRotationContracts(unittest.TestCase):
    def setUp(self):
        self.fixture = RotationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root

    def test_planned_thinning_with_an_intact_archive_counts_in_current_keep(self):
        first = self.root.daily(daily(1))
        self.root.daily(daily(2))
        self.fixture.ledger(daily(1))
        original = Path.unlink
        def interrupt(path, *args, **kwargs):
            if path == first / "orthanc.tgz":
                raise OSError("interrupted before unlink")
            return original(path, *args, **kwargs)
        with patch.object(Path, "unlink", interrupt), self.assertRaises(OSError):
            self.fixture.rotate(keep=1)
        self.assertEqual(json.loads((first / ops.THINNED_FILE).read_text())["state"], "THIN_PLANNED")
        result = self.fixture.rotate(keep=2)
        self.assertEqual(result["generations"], [daily(2), daily(1)])
        self.assertEqual(result["thinned"], [])
        self.assertTrue((first / "orthanc.tgz").is_file())

    def test_rotating_leftover_never_displaces_an_available_daily_generation(self):
        for day in (1,2,3):
            self.root.daily(daily(day))
        moved = self.root.path / (ops.ROTATING + daily(3))
        (self.root.path / daily(3)).rename(moved)
        (moved / ops.HOLD_FILE).write_text("{}")
        result = self.fixture.rotate(keep=1)
        self.assertEqual(result["generations"], [daily(2)])
        self.assertEqual(result["kept_leftovers"][moved.name], "hold")
        self.assertTrue((self.root.path / daily(2)).is_dir())
        self.assertEqual(result["deleted"], [daily(1)])

    def test_revalidation_hashes_only_candidate_and_kept_sets_not_the_whole_root_per_delete(self):
        for day in range(1,26):
            self.root.daily(daily(day))
        calls = []
        original = ops.digest
        def observed(path):
            if Path(path).name == "orthanc.tgz":
                calls.append(Path(path).parent.name)
            return original(path)
        with patch.object(ops, "digest", side_effect=observed):
            result = self.fixture.rotate(keep=2)
        self.assertEqual(len(result["deleted"]), 23)
        self.assertLess(len(calls), 25 * 12, "fixed keep must not cause a full-root rehash for every deletion")

    def test_dry_run_never_creates_the_operations_lock(self):
        self.root.daily(daily(1))
        opened = []
        original = os.open
        def observe(path, flags, *args, **kwargs):
            if Path(path).name == ".kin-ops.lock" and flags & os.O_CREAT:
                opened.append(path)
            return original(path, flags, *args, **kwargs)
        with patch.object(ops.os, "open", side_effect=observe):
            self.fixture.rotate(dry_run=True)
        self.assertEqual(opened, [], "read-only dry-run must not create even a transient operations lock")

    def test_undeclared_set_content_is_preserved_before_deletion(self):
        first = self.root.daily(daily(1))
        second = self.root.daily(daily(2))
        self.root.daily(daily(3))
        (first / "operator-note").write_bytes(b"must remain")
        (second / "operator-files").mkdir()
        (second / "operator-files" / "note").write_bytes(b"must also remain")
        for dry_run in (True, False):
            result = self.fixture.rotate(keep=1, dry_run=dry_run)
            self.assertEqual(result["would_delete" if dry_run else "deleted"], [])
            self.assertIn(daily(1), result["incomplete"])
            self.assertIn(daily(2), result["incomplete"])
            self.assertEqual((first / "operator-note").read_bytes(), b"must remain")
            self.assertEqual((second / "operator-files" / "note").read_bytes(), b"must also remain")

    def test_completed_thin_marker_cannot_hide_changed_archive_bytes(self):
        first = self.root.daily(daily(1))
        self.root.daily(daily(2))
        self.fixture.ledger(daily(1))
        self.assertEqual(self.fixture.rotate(keep=1)["thinned"], [daily(1)])
        archive = first / "orthanc.tgz"
        archive.write_bytes(b"unexpected replacement archive")
        result = self.fixture.rotate(keep=1)
        self.assertIn(daily(1), result["incomplete"])
        self.assertEqual(result["deleted"], [])
        self.assertEqual(archive.read_bytes(), b"unexpected replacement archive")


if __name__ == "__main__":
    unittest.main(verbosity=2)
