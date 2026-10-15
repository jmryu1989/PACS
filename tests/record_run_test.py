"""Local, synthetic tests for the shared execution recorder (no services)."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

# The existing measurements entry point runs contracts, not a real-tree gap gate.
from ci_artifacts_test import ArtifactTests
from ci_workflow_consumers_test import WorkflowConsumerTests
from ci_rerun_diagnostic_test import RerunDiagnosticTests


RECORDER = Path(__file__).resolve().parents[1] / "scripts" / "record-run.py"


class RecordRunTest(unittest.TestCase):
    def test_served_page_records_local_assets_before_and_after_child(self):
        # REQ-W3-LAND-CI -> RISK-UNRECORDED-ASSET: workflow relocation must
        # retain dependencies even when a page adds another script or stylesheet.
        for name in ('worklist-v0/hpacs-lite/main.html', 'worklist-v0/hpacs-lite/drawer.css',
                     'scripts/record-run.py'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture\n', encoding='utf-8')
        child = "from pathlib import Path; Path('worklist-v0/hpacs-lite/added.js').write_text('added')"
        result = self.run_command([sys.executable, '-c', child], files=['worklist-v0/hpacs-lite/main.html'])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        for field in ('files_before', 'files_after'):
            rows = {row['requested']: row for row in record[field]}
            self.assertEqual(rows['worklist-v0/hpacs-lite/drawer.css']['status'], 'present')
            self.assertTrue(rows['worklist-v0/hpacs-lite/drawer.css']['sha256'])
        self.assertNotIn('worklist-v0/hpacs-lite/added.js', {r['requested'] for r in record['files_before']})
        self.assertIn('worklist-v0/hpacs-lite/added.js', {r['requested'] for r in record['files_after']})
        self.assertEqual(record['served_page_inputs']['trees'], ['worklist-v0/hpacs-lite'])

    def test_page_source_helper_records_the_served_page_assets(self):
        # W3R5-06: a step that serves main.html through a page-serving test records
        # tests/page_source.py, not main.html; its page and assets are still recorded.
        for name in ('worklist-v0/hpacs-lite/main.html', 'worklist-v0/hpacs-lite/drawer.js',
                     'tests/page_source.py', 'tests/other_test.py', 'scripts/record-run.py'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture\n', encoding='utf-8')
        served = self.run_command([sys.executable, '-c', 'pass'], files=['tests/other_test.py', 'tests/page_source.py'])
        self.assertEqual(served.returncode, 0, served.stderr)
        record = self.record()
        self.assertEqual(record['served_page_inputs']['trees'], ['worklist-v0/hpacs-lite'])
        for field in ('files_before', 'files_after'):
            rows = {row['requested']: row for row in record[field]}
            for name in ('worklist-v0/hpacs-lite/main.html', 'worklist-v0/hpacs-lite/drawer.js'):
                self.assertEqual(rows[name]['status'], 'present')
                self.assertTrue(rows[name]['sha256'])
        # A step that serves no page records no page directory.
        self.run_dir = self.root / 'evidence' / 'second'
        quiet = self.run_command([sys.executable, '-c', 'pass'], files=['tests/other_test.py'])
        self.assertEqual(quiet.returncode, 0, quiet.stderr)
        self.assertEqual(self.record()['served_page_inputs'], {'files': [], 'trees': []})

    def put(self, name, raw=b'synthetic\n'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        return path

    def test_absent_automatic_inputs_are_recorded_without_failing_child(self):
        # R5-RR-01: a partial source fixture is a valid declared input.
        self.put('tests/other_test.py')
        result = self.run_command([sys.executable, '-c', 'pass'], files=['tests/other_test.py'])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        self.assertEqual(record['declared_inputs'], {'files': ['tests/other_test.py'], 'trees': []})
        for key in ('files_before', 'files_after'):
            rows = {row['requested']: row for row in record[key]}
            for name in ('tests/ci_workflows.py', 'scripts/record-run.py', '.github/workflows'):
                self.assertEqual(rows[name]['status'], 'missing')
                self.assertIsNone(rows[name]['sha256'])
        self.run_dir = self.root / 'evidence' / 'explicit-missing'
        (self.root / 'tests/other_test.py').unlink()
        result = self.run_command([sys.executable, '-c', 'pass'], files=['tests/other_test.py'])
        self.assertEqual(result.returncode, 125)

    def test_every_tests_file_kind_records_workflow_hashes(self):
        # R5-RR-02 / OM04: names and extensions do not define the blanket rule.
        self.put('tests/ci_workflows.py')
        self.put('scripts/record-run.py')
        self.put('.github/workflows/probe.yml')
        for index, name in enumerate(('tests/e2e/test_probe.py', 'tests/probe.cjs', 'tests/invariants_live.py')):
            with self.subTest(name=name):
                self.put(name)
                self.run_dir = self.root / 'evidence' / str(index)
                result = self.run_command([sys.executable, '-c', 'pass'], files=[name])
                self.assertEqual(result.returncode, 0, result.stderr)
                for key in ('files_before', 'files_after'):
                    rows = {row['requested']: row for row in self.record()[key]}
                    self.assertEqual(rows['.github/workflows/probe.yml']['sha256'], hashlib.sha256(b'synthetic\n').hexdigest())

    def test_test_tree_ancestors_descendants_and_unrelated_tree(self):
        # R5-RR-03 / OM05/15: keep evidence outside the declared root tree.
        self.put('tests/nested/probe.py')
        self.put('scripts/fixture/probe.py')
        self.put('.github/workflows/probe.yml')
        with tempfile.TemporaryDirectory(prefix='record-tree-out-') as output:
            for index, tree in enumerate(('.', 'tests', 'tests/nested', 'scripts/fixture')):
                with self.subTest(tree=tree):
                    self.run_dir = Path(output) / str(index)
                    result = self.run_command([sys.executable, '-c', 'pass'], trees=[tree])
                    self.assertEqual(result.returncode, 0, result.stderr)
                    record = self.record()
                    self.assertEqual('.github/workflows' in record['workflow_contract_inputs']['trees'], tree != 'scripts/fixture')
                    for key in ('files_before', 'files_after'):
                        hashes = {row['path']: row['sha256'] for row in record[key]}
                        workflow = str((self.root / '.github/workflows/probe.yml').resolve())
                        self.assertEqual(workflow in hashes, tree != 'scripts/fixture')

    def test_recorder_self_test_observes_nested_test_and_parser_lock_changes(self):
        # R5-RR-04 / OM16: observe the public recorder result, not its helper array.
        self.put('tests/record_run_test.py')
        self.put('tests/nested/dependency.py', b'before')
        self.put('api/package-lock.json', b'before')
        child = "from pathlib import Path; Path('tests/nested/dependency.py').write_bytes(b'after'); Path('api/package-lock.json').write_bytes(b'after')"
        result = self.run_command([sys.executable, '-c', child], files=['tests/record_run_test.py'])
        self.assertEqual(result.returncode, 0, result.stderr)
        for key, raw in (('files_before', b'before'), ('files_after', b'after')):
            rows = {row['requested']: row for row in self.record()[key]}
            for name in ('tests/nested/dependency.py', 'api/package-lock.json'):
                self.assertEqual(rows[name]['sha256'], hashlib.sha256(raw).hexdigest())

    def test_automatic_missing_creation_removal_unreadable_and_declared_overlap(self):
        # R5-RR-05: explicit absolute aliases and explicit tree descendants win.
        self.put('tests/probe.py')
        helper = self.root / 'tests/ci_workflows.py'
        cases = [
            ('create', [], [], "from pathlib import Path; Path('tests/ci_workflows.py').write_bytes(b'new')", 0, 'missing', 'present'),
            ('remove', [], [], "from pathlib import Path; Path('tests/ci_workflows.py').unlink()", 0, 'present', 'missing'),
            ('absolute-overlap', [str(helper)], [], 'pass', 125, 'missing', 'missing'),
            ('unreadable-auto', [], [], 'pass', 0, 'unreadable', 'unreadable'),
            ('unreadable-declared', ['./tests/ci_workflows.py'], [], 'pass', 125, 'unreadable', 'unreadable'),
        ]
        for label, extra_files, trees, child, exit_code, before, after in cases:
            with self.subTest(case=label):
                if label == 'unreadable-auto':
                    helper.mkdir()
                self.run_dir = self.root / 'evidence' / label
                result = self.run_command([sys.executable, '-c', child], files=['tests/probe.py', *extra_files], trees=trees)
                self.assertEqual(result.returncode, exit_code, result.stderr)
                for key, status in (('files_before', before), ('files_after', after)):
                    rows = [row for row in self.record()[key] if row['path'] == str(helper)]
                    self.assertTrue(rows)
                    self.assertTrue(all(row['status'] == status for row in rows))
        helper.rmdir()
        self.put('tests/tree-child.txt')
        self.run_dir = self.root / 'evidence' / 'tree-descendant'
        child = "from pathlib import Path; Path('tests/tree-child.txt').unlink(); Path('tests/tree-child.txt').mkdir()"
        result = self.run_command([sys.executable, '-c', child], files=['tests/tree-child.txt'], trees=['tests'])
        self.assertEqual(result.returncode, 125)

    def test_child_and_launch_failures_keep_priority_over_absent_inputs(self):
        for label, command, expected in (
                ('child', [sys.executable, '-c', 'raise SystemExit(7)'], 7),
                ('launch', [str(self.root / 'absent-executable')], 127)):
            self.run_dir = self.root / 'evidence' / label
            result = self.run_command(command, files=['tests/missing.py'])
            self.assertEqual(result.returncode, expected)
            self.assertEqual(self.record()['recorder_exit_code'], expected)

    def test_log_hash_failure_is_required_even_without_declared_files(self):
        # Use the real child/recording path; simulate the OS losing its log after close.
        import importlib.util
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('rr_log_failure', RECORDER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        snapshot = module.file_snapshot
        def failed_log(paths, cwd):
            if Path(cwd) == self.run_dir and 'stdout.log' in paths:
                (self.run_dir / 'stdout.log').unlink()
            return snapshot(paths, cwd)
        with patch.object(module, 'file_snapshot', side_effect=failed_log):
            exit_code = module.main(['--run-dir', str(self.run_dir), '--cwd', str(self.root),
                                     '--', sys.executable, '-c', 'pass'])
        self.assertEqual(exit_code, 125)
        self.assertEqual(self.record()['exit_code'], 0)
        self.assertEqual(self.record()['log_files'][0]['status'], 'missing')

    def test_tree_only_unregistered_input_gets_workflow_catalogue(self):
        for name in ('tests/new/nested_probe.py', 'tests/ci_workflows.py', 'scripts/record-run.py',
                     '.github/workflows/new.yml'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic\n')
        result = self.run_command([sys.executable, '-c', 'pass'], trees=['tests/new'])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        self.assertIn('.github/workflows', record['workflow_contract_inputs']['trees'])
        for key in ('files_before', 'files_after'):
            self.assertIn('.github/workflows/new.yml', {row['requested'] for row in record[key]})

    def test_unregistered_nested_tree_hashes_workflows_and_missing_input_fails(self):
        for name in ('tests/new/nested_probe.py', 'tests/ci_workflows.py', 'scripts/record-run.py',
                     '.github/workflows/new.yml'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic\n')
        result = self.run_command([sys.executable, '-c', 'pass'],
                                  files=['tests/new/missing.py'], trees=['tests/new'])
        self.assertEqual(result.returncode, 125)
        record = self.record()
        self.assertEqual(record['exit_code'], 0)
        for key in ('files_before', 'files_after'):
            rows = {row['requested']: row for row in record[key]}
            self.assertEqual(rows['tests/new/missing.py']['status'], 'missing')
            self.assertEqual(rows['.github/workflows/new.yml']['sha256'], hashlib.sha256(b'synthetic\n').hexdigest())

    def test_workflow_contract_inputs_capture_relocated_and_new_workflows(self):
        # REQ-W2-LAND-CI -> RISK-UNRECORDED-WORKFLOW: both snapshots include
        # the catalogue/helper; a workflow created by the child is visible after.
        for name in ('tests/new_unregistered_test.py', 'tests/ci_workflows.py', 'scripts/record-run.py',
                     '.github/workflows/relocated.yml'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture\n', encoding='utf-8')
        child = "from pathlib import Path; Path('.github/workflows/added.yml').write_text('added')"
        result = self.run_command([sys.executable, '-c', child], files=['tests/new_unregistered_test.py'])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        before = {row['requested']: row for row in record['files_before']}
        after = {row['requested']: row for row in record['files_after']}
        expected = {'tests/new_unregistered_test.py', 'tests/ci_workflows.py', 'scripts/record-run.py',
                    '.github/workflows/relocated.yml'}
        self.assertEqual(set(before), expected)
        self.assertEqual(set(after), expected | {'.github/workflows/added.yml'})
        self.assertTrue(all(row['status'] == 'present' and row['sha256'] for row in after.values()))
        self.assertEqual(record['workflow_contract_inputs']['trees'], ['.github/workflows'])

    def test_workflow_consumer_hashes_all_workflows_before_and_after(self):
        for name in ('tests/candidate_ci_test.py', 'tests/ci_workflows.py', 'scripts/record-run.py',
                     '.github/workflows/relocated.yml'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'before\n')
        result = self.run_command([
            sys.executable, '-c',
            "from pathlib import Path; Path('.github/workflows/new.yml').write_bytes(b'new\\n')",
        ], files=['tests/candidate_ci_test.py'])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        before = {row['requested']: row for row in record['files_before']}
        after = {row['requested']: row for row in record['files_after']}
        self.assertIn('.github/workflows/relocated.yml', before)
        self.assertNotIn('.github/workflows/new.yml', before)
        self.assertEqual(after['.github/workflows/new.yml']['sha256'], hashlib.sha256(b'new\n').hexdigest())
        self.assertEqual(set(after) - set(before), {'.github/workflows/new.yml'})
        self.assertEqual(before['.github/workflows/relocated.yml'], after['.github/workflows/relocated.yml'])
        self.assertEqual(record['workflow_contract_inputs']['trees'], ['.github/workflows'])

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
        self.assertEqual(result.returncode, 125, result.stderr)
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
        self.assertEqual(result.returncode, 125, result.stderr)
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
        self.assertEqual(result.returncode, 125, result.stderr)
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
