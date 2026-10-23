"""TEST-S3-U2a-VECTORS: required citation examples and normalization inputs.

REQ-S3-U2a-CITATION-BACKEND -> RISK-S3-CITATION-FALSE-PRESENCE -> TEST-S3-U2a-VECTORS.
The shared vectors are executed by report_citation_test.cjs and
report_citation_client_test.cjs against the shipped server and client. This file
keeps fixture coverage checks without a third implementation of the rule (D73).
"""
import json
import pathlib
import sys
import unicodedata
import unittest

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
VECTORS = ROOT / "tests" / "report_citation_vectors.json"


class VectorFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = json.loads(VECTORS.read_text(encoding="utf-8"))

    def operands(self, case: dict) -> tuple[str, str]:
        """`nfd` names the operand the harness decomposes, so no editor can flatten the vector."""
        body, block = case["body"], case["block"]
        if case.get("nfd") == "body":
            body = unicodedata.normalize("NFD", body)
        if case.get("nfd") == "block":
            block = unicodedata.normalize("NFD", block)
        return body, block


    def test_a_decomposed_vector_really_is_decomposed(self) -> None:
        # Without this the two NFC vectors could pass while comparing identical bytes, which proves
        # nothing about normalization at all.
        decomposed = [case for case in self.data["occurrence"] if case.get("nfd")]
        self.assertTrue(decomposed, "no vector exercises NFC")
        for case in decomposed:
            with self.subTest(case["name"]):
                body, block = self.operands(case)
                raw = case["body"] if case["nfd"] == "body" else case["block"]
                shifted = body if case["nfd"] == "body" else block
                self.assertNotEqual(raw, shifted, "the operand was already decomposed")
                self.assertEqual(unicodedata.normalize("NFC", shifted), unicodedata.normalize("NFC", raw))


    def test_every_a3_case_is_covered(self) -> None:
        """A3 named four cases. A vector file can be thinned by accident; this notices."""
        names = {case["name"] for section in ("occurrence", "blank", "assembly")
                 for case in self.data[section]}
        text = json.dumps(self.data, ensure_ascii=False)
        self.assertIn("lone CR field", names)
        self.assertIn("block carries its own final LF", names)
        self.assertIn("user keeps typing right after the block", names)
        self.assertIn("block with a leading LF", names)
        self.assertTrue(any("whitespace" in name or "space" in name for name in names))
        self.assertIn("A3(iv)", text)
        self.assertGreaterEqual(len(self.data["occurrence"]), 20)
        # N-C3: the section that binds n to k must not be dropped.
        self.assertGreaterEqual(len(self.data["equivalence"]), 5)
        self.assertTrue(any(case["states"] == ["ambiguous", "ambiguous"] for case in self.data["equivalence"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
