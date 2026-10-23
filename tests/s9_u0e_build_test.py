#!/usr/bin/env python3
"""Real builder CLI and byte boundary, without a browser or LiveStack.

REQ-S9-U0e-BEHAVIOUR-PRESERVED -> RISK-SOURCE-ORDER/STALE-CONFIG ->
TEST-S9-U0E-BUILD. Exact bytes are the build contract (AGENTS 1-B.14).
No historical hash is pinned here: later approved features edit the sources.
Initial Git-blob equivalence is recorded separately for the extraction round.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts/build-ohif-config.py"


class OHIFBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        self.directory = self.root / "config/ohif"
        self.directory.mkdir(parents=True)
        self.output = self.root / "config/ohif.js"
        shutil.copyfile(BUILDER, self.root / "scripts/build-ohif-config.py")
        self.first = "// 원본 공백 유지\r\nconst title = '영상';\r\n".encode()
        self.second = b"\nwindow.config = { title };\n"
        (self.directory / "first.js").write_bytes(self.first)
        (self.directory / "second.js").write_bytes(self.second)
        self.order(["first.js", "second.js"])

    def order(self, names):
        (self.directory / "source-order.json").write_text(json.dumps({"sources": names}), encoding="utf-8")

    def run_builder(self, *args, root=None):
        root = root or self.root
        return subprocess.run([sys.executable, str(root / "scripts/build-ohif-config.py"), *args],
                              cwd=root, capture_output=True, text=True)

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_current_repository_artifact(self):
        self.success(self.run_builder("--check", root=ROOT))

    def test_exact_bytes_and_repeat_build(self):
        self.success(self.run_builder())
        self.assertEqual(self.output.read_bytes(), self.first + self.second)
        self.success(self.run_builder())
        self.assertEqual(self.output.read_bytes(), self.first + self.second)
        self.success(self.run_builder("--check"))

    def test_check_preserves_stale_output(self):
        self.output.write_bytes(b"previous artifact")
        self.assertNotEqual(self.run_builder("--check").returncode, 0)
        self.assertEqual(self.output.read_bytes(), b"previous artifact")

    def test_check_missing_output_does_not_create_it(self):
        self.assertNotEqual(self.run_builder("--check").returncode, 0)
        self.assertFalse(self.output.exists())

    def test_source_edit_rebuilds_without_historical_pin(self):
        self.success(self.run_builder())
        changed = b"window.config = { title, showStudyList: true };\n"
        (self.directory / "second.js").write_bytes(changed)
        self.assertNotEqual(self.run_builder("--check").returncode, 0)
        self.success(self.run_builder())
        self.assertEqual(self.output.read_bytes(), self.first + changed)
        self.success(self.run_builder("--check"))

    def test_declared_order_controls_output(self):
        self.success(self.run_builder())
        self.order(["second.js", "first.js"])
        self.assertNotEqual(self.run_builder("--check").returncode, 0)
        self.success(self.run_builder())
        self.assertEqual(self.output.read_bytes(), self.second + self.first)

    def test_missing_duplicate_and_unlisted_sources_preserve_output(self):
        for names in (["first.js"], ["first.js", "second.js", "second.js"],
                      ["first.js", "second.js", "absent.js"], []):
            with self.subTest(sources=names):
                self.output.write_bytes(b"previous artifact")
                self.order(names)
                for args in ((), ("--check",)):
                    self.assertNotEqual(self.run_builder(*args).returncode, 0)
                    self.assertEqual(self.output.read_bytes(), b"previous artifact")

    def test_invalid_manifest_preserves_output(self):
        for manifest in (b"{", b"{}", b'{"sources": "first.js"}', b'{"sources": [null]}'):
            with self.subTest(manifest=manifest):
                self.output.write_bytes(b"previous artifact")
                (self.directory / "source-order.json").write_bytes(manifest)
                self.assertNotEqual(self.run_builder().returncode, 0)
                self.assertEqual(self.output.read_bytes(), b"previous artifact")


if __name__ == "__main__":
    unittest.main(verbosity=2)
