"""REQ-S9-U0a-BYTES -> RISK-BUNDLE-DRIFT/ORDER -> TEST-S9-U0a-BUNDLE.

Byte identity is the behaviour-preserving refactor's requirement (D73), not
an implementation shape chosen for testing. Mutants alter scratch inputs only.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("main_bundle", ROOT / "scripts/build-main-split-bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleContract(unittest.TestCase):
    def test_committed_artifact_and_original_body(self):
        report = bundle.check()
        self.assertTrue(report["equals_original_body"])
        self.assertEqual(45, len(report["sources"]))
        self.assertEqual(44, len(report["boundaries"]))
        self.assertEqual({"bundle_tags": 1, "source_tags": 0, "existing_tags": 56}, report["main_html"])

    def test_five_bundle_mutants(self):
        manifest = json.loads((ROOT / "scripts/main-split-order.json").read_bytes())
        original = (ROOT / manifest["artifact"]).read_bytes()
        for mutant in ("stale-artifact", "wrong-order", "dropped-boundary-byte", "extra-byte", "tag-count"):
            with self.subTest(mutant=mutant), tempfile.TemporaryDirectory(prefix="u0a-bundle-") as scratch:
                root = Path(scratch)
                page = root / manifest["page"]
                page.parent.mkdir(parents=True)
                page.write_bytes((ROOT / manifest["page"]).read_bytes())
                for source in manifest["sources"]:
                    (page.parent / source["file"]).write_bytes((ROOT / Path(manifest["page"]).parent / source["file"]).read_bytes())
                artifact = root / manifest["artifact"]
                artifact.write_bytes(original)
                modified = copy.deepcopy(manifest)
                if mutant == "stale-artifact":
                    artifact.write_bytes(original.replace(b"let ", b"var ", 1))
                elif mutant == "wrong-order":
                    modified["sources"][0], modified["sources"][1] = modified["sources"][1], modified["sources"][0]
                elif mutant == "dropped-boundary-byte":
                    # Gi is empty in this move; delete the first original trivia
                    # byte owned by S2 at that boundary, not an invented separator.
                    at = manifest["sources"][1]["original_bytes"][0]
                    self.assertEqual(b"\n", original[at:at + 1])
                    artifact.write_bytes(original[:at] + original[at + 1:])
                elif mutant == "extra-byte":
                    artifact.write_bytes(original + b"\n")
                else:
                    page.write_bytes(page.read_bytes().replace(b'<script src="main-split.bundle.js"></script>',
                        b'<script src="main-split.bundle.js"></script>' * 2))
                with self.assertRaisesRegex(AssertionError, "Stale bundle artifact|Original slice order|Bundle tag count") as rejected:
                    bundle.check(root, modified)
                row = {"id": "BUNDLE-" + mutant, "killed": True, "assertion": str(rejected.exception),
                       "artifact_sha256": bundle.sha256(artifact.read_bytes()),
                       "page_sha256": bundle.sha256(page.read_bytes()), "manifest": modified}
                if os.environ.get("KIN_PRE_TRACE_DIR"):
                    evidence = Path(os.environ["KIN_PRE_TRACE_DIR"]) / "bundle-mutants" / mutant
                    evidence.mkdir(parents=True, exist_ok=True)
                    (evidence / "artifact.js").write_bytes(artifact.read_bytes())
                    (evidence / "main.html").write_bytes(page.read_bytes())
                    (evidence / "result.json").write_text(json.dumps(row, indent=2) + "\n", encoding="utf-8")
                print(json.dumps({k: v for k, v in row.items() if k != "manifest"}))


if __name__ == "__main__":
    unittest.main()
