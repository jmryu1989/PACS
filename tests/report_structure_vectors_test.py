"""TEST-S3-STRUCT-VECTORS: coverage of the shared structure examples.

The shipped server and client execute these vectors in report_structure_test.cjs
and report_structure_client_test.cjs, including the GEN-1 catalog and literal dollar
values. Keep fixture coverage here; do not maintain a third validator or a source
literal parser. The vector JSON and its expected sentences remain unchanged.
"""
import json
import pathlib
import sys
import unittest

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "tests" / "report_structure_vectors.json").read_text(encoding="utf-8"))


class ReportStructureVectors(unittest.TestCase):


    def test_every_rendered_vector_is_exactly_one_line(self) -> None:
        # v1 renders one line so the existing citation guards are reused unchanged (P10). A vector
        # that smuggled a newline in would make the whole guard argument untrue.
        for case in VECTORS["render"]:
            with self.subTest(rendered=case["rendered"]):
                self.assertNotIn("\n", case["rendered"])
                self.assertNotIn("\r", case["rendered"])
                self.assertTrue(case["rendered"].strip())
                self.assertLessEqual(len(case["rendered"].encode("utf-8")), 512)


    def test_the_vectors_discriminate_every_rule_and_are_not_all_refusals(self) -> None:
        # A table that only ever expected a refusal would pass against a validator that refused
        # everything, and a table missing a rule would never notice that rule being deleted.
        rules = [case["rule"] for case in VECTORS["catalogVectors"]]
        for rule in ("R-D", "R-S", "R-C", "R-A", "R-B"):
            self.assertGreaterEqual(rules.count(rule), 1, f"no vector exercises {rule}")
        self.assertGreaterEqual(rules.count("ACCEPT"), 5, "too few catalogs are expected to be legal")
        expectations = [case["expect"] for case in VECTORS["entryVectors"]]
        self.assertGreaterEqual(expectations.count("ACCEPT"), 4)
        self.assertGreaterEqual(expectations.count("R-S"), 4)
        # and the shipped fixture catalog is among the accepted ones, so every closed test that uses
        # it stays reachable.
        accepted = [case["catalog"] for case in VECTORS["catalogVectors"] if case["rule"] == "ACCEPT"]
        self.assertIn(VECTORS["catalog"], accepted, "the SYN-T1 fixture must be an ACCEPT vector")


if __name__ == "__main__":
    unittest.main(verbosity=2)
