"""Local, synthetic tests for the shared execution recorder (no services)."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


RECORDER = Path(__file__).resolve().parents[1] / "scripts" / "record-run.py"


class RecordRunTest(unittest.TestCase):
    def test_unreadable_file_has_no_raw_or_normalized_success_hash(self):
        (self.root / "directory").mkdir()
        result = self.run_command([sys.executable, "-c", "pass"], files=["directory"])
        self.assertEqual(result.returncode, 125)
        for field in ["files_before", "files_after"]:
            item = self.record()[field][0]
            self.assertEqual(item["status"], "unreadable")
            self.assertIsNone(item["sha256"])
            self.assertIsNone(item["lf_sha256"])

    def test_lf_hash_handles_mixed_binary_and_split_crlf_without_changing_raw(self):
        raw = b"x" * (1024 * 1024 - 1) + b"\r\nfirst\nsecond\r\n\x00\xfflone\rend\r"
        (self.root / "mixed.bin").write_bytes(raw)
        result = self.run_command([sys.executable, "-c", "pass"], files=["mixed.bin", "absent"])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        for field in ["files_before", "files_after"]:
            self.assertEqual(record[field][0]["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(record[field][0]["lf_sha256"], hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest())
            self.assertIsNone(record[field][1]["lf_sha256"])
        self.assertEqual((self.root / "mixed.bin").read_bytes(), raw)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="record-run-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.run_dir = self.root / "evidence" / "first"

    def run_command(self, command, files=(), trees=()):
        args = [sys.executable, "-B", str(RECORDER), "--run-dir", str(self.run_dir), "--cwd", str(self.root)]
        for path in files:
            args.extend(["--file", path])
        for path in trees:
            args.extend(["--tree", path])
        return subprocess.run(args + ["--"] + command, capture_output=True, shell=False)

    def record(self):
        return json.loads((self.run_dir / "run.json").read_text(encoding="utf-8"))

    def test_trees_record_nested_regular_files_in_posix_order_with_hashes(self):
        payloads = {"source/z.txt": b"last\r\n", "source/nested/b.bin": b"\x00\xff\r\n",
                    "source/a.txt": b"first\n", "other/c.txt": b"other"}
        for name, raw in payloads.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        (self.root / "source/empty").mkdir()
        result = self.run_command([sys.executable, "-c", "pass"],
                                  files=["source/a.txt"], trees=["source", "other"])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        self.assertEqual(record["files_before"], record["files_after"])
        explicit, *items = record["files_before"]
        self.assertNotIn("tree", explicit)
        self.assertEqual([item["requested"] for item in items],
                         ["source/a.txt", "source/nested/b.bin", "source/z.txt", "other/c.txt"])
        for item in items:
            name = item["requested"]
            raw = payloads[name]
            self.assertEqual(item, {
                "requested": name, "path": str((self.root / name).resolve()),
                "status": "present", "sha256": hashlib.sha256(raw).hexdigest(),
                "lf_sha256": hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest(),
                "tree": name.split("/")[0],
            })
        self.assertEqual(explicit, {key: value for key, value in items[0].items() if key != "tree"})

    def test_missing_tree_records_one_missing_directory(self):
        result = self.run_command([sys.executable, "-c", "pass"], trees=["absent"])
        self.assertEqual(result.returncode, 0, result.stderr)
        for field in ["files_before", "files_after"]:
            self.assertEqual(self.record()[field], [{
                "requested": "absent", "path": str((self.root / "absent").resolve()),
                "status": "missing", "sha256": None, "lf_sha256": None, "tree": "absent",
            }])

    def test_unreadable_tree_does_not_record_success(self):
        (self.root / "not-a-directory").write_bytes(b"file")
        result = self.run_command([sys.executable, "-c", "pass"], trees=["not-a-directory"])
        self.assertEqual(result.returncode, 125, result.stderr)
        for field in ["files_before", "files_after"]:
            items = self.record()[field]
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["requested"], "not-a-directory")
            self.assertEqual(items[0]["tree"], "not-a-directory")
            self.assertEqual(items[0]["status"], "unreadable")
            self.assertIsNone(items[0]["sha256"])
            self.assertIsNone(items[0]["lf_sha256"])

    def test_file_added_to_tree_changes_the_recorded_set(self):
        (self.root / "source").mkdir()
        (self.root / "source/old.txt").write_bytes(b"old")
        result = self.run_command([
            sys.executable, "-c", "from pathlib import Path; Path('source/new.txt').write_bytes(b'new')",
        ], trees=["source"])
        self.assertEqual(result.returncode, 0, result.stderr)
        before, after = (self.record()[field] for field in ["files_before", "files_after"])
        self.assertEqual([item["requested"] for item in before], ["source/old.txt"])
        self.assertEqual([item["requested"] for item in after], ["source/new.txt", "source/old.txt"])
        self.assertEqual(before[0], after[1])
        self.assertEqual(after[0]["sha256"], hashlib.sha256(b"new").hexdigest())

    def test_success_preserves_raw_bytes_and_arguments(self):
        payload = "import os; os.write(1, bytes([0, 13, 10, 255])); os.write(2, b'err\\r\\n')"
        command = [sys.executable, "-c", payload, "literal & ; $()"]
        result = self.run_command(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        self.assertEqual(record["command"], command)
        self.assertEqual(record["cwd"], str(self.root.resolve()))
        self.assertEqual(record["status"], "completed")
        self.assertEqual(record["exit_code"], 0)
        self.assertTrue(record["started_at_utc"].endswith("+00:00"))
        self.assertTrue(record["ended_at_utc"].endswith("+00:00"))
        self.assertGreaterEqual(record["duration_seconds"], 0)
        self.assertEqual((self.run_dir / "stdout.log").read_bytes(), bytes([0, 13, 10, 255]))
        self.assertEqual((self.run_dir / "stderr.log").read_bytes(), b"err\r\n")
        logs = {item["requested"]: item for item in record["log_files"]}
        self.assertEqual(set(logs), {"stdout.log", "stderr.log"})
        for name, raw in [("stdout.log", bytes([0, 13, 10, 255])), ("stderr.log", b"err\r\n")]:
            self.assertEqual(logs[name]["status"], "present")
            self.assertEqual(logs[name]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertIn("git_head_before", record)
        self.assertIn("git_head_after", record)

    def test_nonzero_exit_is_preserved(self):
        result = self.run_command([sys.executable, "-c", "import sys; print('failed'); sys.exit(7)"])
        self.assertEqual(result.returncode, 7)
        self.assertEqual(self.record()["exit_code"], 7)
        self.assertEqual(self.record()["recorder_exit_code"], 7)
        self.assertIn(b"failed", (self.run_dir / "stdout.log").read_bytes())

    def test_launch_failure_has_no_invented_child_exit(self):
        result = self.run_command([str(self.root / "does-not-exist")])
        self.assertEqual(result.returncode, 127)
        record = self.record()
        self.assertEqual(record["status"], "launch_failed")
        self.assertIsNone(record["exit_code"])
        self.assertEqual(record["launch_error"]["type"], "FileNotFoundError")
        self.assertIsNotNone(record["ended_at_utc"])
        self.assertEqual((self.run_dir / "stdout.log").read_bytes(), b"")
        self.assertEqual((self.run_dir / "stderr.log").read_bytes(), b"")

    def test_existing_run_is_not_changed_or_executed(self):
        self.run_dir.mkdir(parents=True)
        original = b"original\x00\xff\r\n"
        (self.run_dir / "run.json").write_bytes(original)
        result = self.run_command([sys.executable, "-c", "open('executed', 'w').close()"])
        self.assertEqual(result.returncode, 125)
        self.assertEqual((self.run_dir / "run.json").read_bytes(), original)
        self.assertFalse((self.root / "executed").exists())
        self.assertEqual(list(self.run_dir.iterdir()), [self.run_dir / "run.json"])

    def test_before_after_distinguish_change_creation_and_stability(self):
        original = b"before\x00\xff\r\n"
        (self.root / "changed.bin").write_bytes(original)
        (self.root / "stable.bin").write_bytes(original)
        result = self.run_command([
            sys.executable, "-c",
            "from pathlib import Path; Path('changed.bin').write_bytes(b'after'); Path('created.bin').write_bytes(b'new')",
        ], files=["changed.bin", "stable.bin", "created.bin"])
        self.assertEqual(result.returncode, 0, result.stderr)
        before = self.record()["files_before"]
        after = self.record()["files_after"]
        self.assertEqual(before[0]["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(after[0]["sha256"], hashlib.sha256(b"after").hexdigest())
        self.assertEqual(before[1], after[1])
        self.assertEqual(before[2]["status"], "missing")
        self.assertIsNone(before[2]["sha256"])
        self.assertEqual(after[2]["sha256"], hashlib.sha256(b"new").hexdigest())


if __name__ == "__main__":
    unittest.main(verbosity=2)
