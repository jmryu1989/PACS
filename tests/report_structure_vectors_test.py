"""TEST-S3-STRUCT-VECTORS: the shared render vectors against an independent rule, and the proof
that the PRODUCT catalog is empty on both sides.

Why a third implementation: the server (`api/src/report-structure.ts`) and the browser
(`worklist-v0/hpacs-lite/report-structure.js`) each implement the render rule, and the whole design
rests on "what the browser showed is byte-identical to what the server verified". Two
implementations checking each other can agree on the same mistake; a third, written from the rule
rather than from either file, cannot be dragged along by a shared bug.

What this file does NOT prove: that either shipped implementation is the one that ran. That is what
the server-pure (`report_structure_test.cjs`) and client-pure (`report_structure_client_test.cjs`)
tests do by importing the real modules. Here the vectors themselves are the subject.

Host-pure: reads files, no browser, no container, no database, no network.
"""
import json
import pathlib
import re
import sys
import unittest

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "tests" / "report_structure_vectors.json").read_text(encoding="utf-8"))
SERVER = (ROOT / "api" / "src" / "report-structure.ts").read_text(encoding="utf-8")
CLIENT = (ROOT / "worklist-v0" / "hpacs-lite" / "report-structure.js").read_text(encoding="utf-8")

SLOT = "{value}"


def item_of(code):
    for template in VECTORS["catalog"]:
        for item in template["items"]:
            if item["code"] == code:
                return item
    raise AssertionError("unknown synthetic item: " + code)


def independent_value_text(item, value):
    """The rule, restated: a choice shows its own text, a boolean one of two fixed words, a number
    exactly the decimals the catalog fixed, free text itself. Nothing else is added."""
    kind = item["valueType"]
    if kind == "choice":
        for choice in item["choices"]:
            if choice["code"] == value:
                return choice["text"]
        raise AssertionError("choice not in catalog")
    if kind == "boolean":
        if value is not True and value is not False:
            raise AssertionError("not a boolean")
        return item["trueText"] if value else item["falseText"]
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise AssertionError("not a number")
        return f"%.{item['decimals']}f" % float(value)
    if not isinstance(value, str):
        raise AssertionError("not a string")
    return value


def independent_render(item, value):
    text = independent_value_text(item, value)
    prefix, suffix = item["template"].split(SLOT)
    return prefix + text + suffix


def js_string_replace_render(item, value):
    """What `template.replace('{value}', valueText)` does in JavaScript.

    This is NOT the contract; it is the defect the `$` vectors exist to catch. ECMAScript expands
    `$$`, `$&`, '$`' and "$'" inside the REPLACEMENT string, so a value the reader typed comes out
    as something else. Python's own str.replace does not do this, so it has to be written out.
    """
    template = item["template"]
    at = template.index(SLOT)
    before, after = template[:at], template[at + len(SLOT):]
    text = independent_value_text(item, value)
    out = []
    i = 0
    while i < len(text):
        if text[i] == "$" and i + 1 < len(text):
            nxt = text[i + 1]
            if nxt == "$":
                out.append("$")
                i += 2
                continue
            if nxt == "&":
                out.append(SLOT)
                i += 2
                continue
            if nxt == "`":
                out.append(before)
                i += 2
                continue
            if nxt == "'":
                out.append(after)
                i += 2
                continue
        out.append(text[i])
        i += 1
    return before + "".join(out) + after


def independent_valid(item, value):
    kind = item["valueType"]
    if kind == "choice":
        return any(choice["code"] == value for choice in item["choices"])
    if kind == "boolean":
        return value is True or value is False
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if value < item["min"] or value > item["max"]:
            return False
        return round(float(value), item["decimals"]) == float(value)
    if not isinstance(value, str) or not value.strip():
        return False
    if any(ord(ch) < 0x20 or ord(ch) in (0x7F, 0x2028, 0x2029) for ch in value):
        return False
    return len(value.encode("utf-8")) <= 512


class ReportStructureVectors(unittest.TestCase):
    def test_render_vectors_match_the_independent_rule(self) -> None:
        self.assertTrue(VECTORS["render"], "no render vectors")
        for case in VECTORS["render"]:
            with self.subTest(item=case["itemCode"], value=case["value"]):
                self.assertEqual(independent_render(item_of(case["itemCode"]), case["value"]),
                                 case["rendered"])

    def test_the_dollar_vectors_actually_discriminate_the_defect_they_name(self) -> None:
        # A vector that both the right rule and the wrong one answer the same way tests nothing.
        # `str.replace(needle, replacement)` expands `$$`, `$&`, '$`' and "$'" INSIDE the
        # replacement, so the sentence stops being the value the reader typed. These vectors exist
        # to fail against that implementation, so at least one must disagree with it.
        differing = []
        for case in VECTORS["render"]:
            item = item_of(case["itemCode"])
            if js_string_replace_render(item, case["value"]) != case["rendered"]:
                differing.append(case)
        self.assertGreaterEqual(len(differing), 4,
                                "the $-pattern vectors must be the ones a string replacement gets wrong")
        for case in differing:
            self.assertIn("$", str(case["value"]), "only $-bearing values may differ")
        # and every value WITHOUT a dollar must be answered identically by both, so the vectors
        # isolate exactly this defect and nothing else.
        for case in VECTORS["render"]:
            if "$" not in str(case["value"]):
                self.assertEqual(js_string_replace_render(item_of(case["itemCode"]), case["value"]),
                                 case["rendered"])

    def test_every_rendered_vector_is_exactly_one_line(self) -> None:
        # v1 renders one line so the existing citation guards are reused unchanged (P10). A vector
        # that smuggled a newline in would make the whole guard argument untrue.
        for case in VECTORS["render"]:
            with self.subTest(rendered=case["rendered"]):
                self.assertNotIn("\n", case["rendered"])
                self.assertNotIn("\r", case["rendered"])
                self.assertTrue(case["rendered"].strip())
                self.assertLessEqual(len(case["rendered"].encode("utf-8")), 512)

    def test_invalid_vectors_are_actually_invalid(self) -> None:
        # A refusal vector that the rule accepts would silently stop testing a refusal.
        for case in VECTORS["invalid"]:
            with self.subTest(item=case["itemCode"], why=case["why"]):
                self.assertFalse(independent_valid(item_of(case["itemCode"]), case["value"]))

    def test_render_is_injective_over_enumerable_values(self) -> None:
        # If two (item, value) pairs produced the same line, a line found in the report could not be
        # attributed, and presence would quietly become ambiguous.
        for template in VECTORS["catalog"]:
            seen = {}
            for item in template["items"]:
                values = ([choice["code"] for choice in item["choices"]] if item["valueType"] == "choice"
                          else [True, False] if item["valueType"] == "boolean" else [])
                for value in values:
                    line = independent_render(item, value)
                    self.assertNotIn(line, seen, f"{seen.get(line)} and {item['code']} render the same line")
                    seen[line] = item["code"]

    def test_free_input_items_have_distinct_sentence_skeletons(self) -> None:
        # number/text cannot be enumerated; the decidable necessary condition is that no two of them
        # share the literal text around the slot.
        for template in VECTORS["catalog"]:
            skeletons = set()
            for item in template["items"]:
                if item["valueType"] in ("choice", "boolean"):
                    continue
                self.assertEqual(item["template"].count(SLOT), 1)
                key = item["template"]
                self.assertNotIn(key, skeletons)
                skeletons.add(key)

    def test_product_catalogs_are_empty_on_both_sides(self) -> None:
        # P6: the product catalog ships EMPTY. This is the assertion that fails the day someone
        # invents a clinical item to make a test runnable.
        server = re.search(r"STRUCTURE_CATALOG:\s*readonly StructureTemplate\[\]\s*=\s*Object\.freeze\((\[[^\]]*\])\)",
                           SERVER)
        client = re.search(r"PRODUCT_CATALOG\s*=\s*Object\.freeze\((\[[^\]]*\])\)", CLIENT)
        self.assertIsNotNone(server, "server product catalog literal not found")
        self.assertIsNotNone(client, "client product catalog literal not found")
        self.assertEqual(json.loads(server.group(1)), [])
        self.assertEqual(json.loads(client.group(1)), [])
        self.assertEqual(json.dumps(json.loads(server.group(1)), sort_keys=True, separators=(",", ":")),
                         json.dumps(json.loads(client.group(1)), sort_keys=True, separators=(",", ":")))

    def test_a_nonempty_product_catalog_would_need_the_load_time_gate_closed_first(self) -> None:
        """P12 is PARTIAL (Astra D1), and this is the tripwire that keeps it honest.

        Cross-item render collisions are prevented exactly for enumerable values; free-input items
        are only held to distinct sentence skeletons, and the CLIENT has no validateCatalog at all.
        Today the product catalog is empty, so none of that is reachable. The day it stops being
        empty this test fails, and the gate - sufficient cross-item collision prevention plus
        load-time validation on BOTH sides, checked over the whole catalog by T1/T2/T3 - has to be
        closed before the content ships.
        """
        server = re.search(r"STRUCTURE_CATALOG:\s*readonly StructureTemplate\[\]\s*=\s*Object\.freeze\((\[[^\]]*\])\)",
                           SERVER)
        client = re.search(r"PRODUCT_CATALOG\s*=\s*Object\.freeze\((\[[^\]]*\])\)", CLIENT)
        empty = json.loads(server.group(1)) == [] and json.loads(client.group(1)) == []
        if empty:
            self.assertNotIn("function validateCatalog", CLIENT,
                             "if the client ever grows one, say so here and close the gate")
            return
        self.assertIn("function validateCatalog", CLIENT,
                      "a non-empty catalog needs the same load-time validation on the client")
        self.assertRegex(SERVER, r"validateCatalog\(STRUCTURE_CATALOG\)",
                         "and the server must validate its own catalog at load time")

    def test_no_synthetic_fixture_is_reachable_from_product_code(self) -> None:
        # The synthetic items exist only in this repository's tests. If "SYN-" ever appears in a
        # shipped file, the injection seam has leaked into the product.
        for name, text in (("report-structure.ts", SERVER), ("report-structure.js", CLIENT)):
            with self.subTest(file=name):
                self.assertNotIn("SYN-", text)
                self.assertNotIn("SYNTHETIC", text)
        self.assertTrue(all(template["templateId"].startswith("SYN-") for template in VECTORS["catalog"]))
        for case in VECTORS["render"]:
            self.assertTrue(case["rendered"].startswith("SYNTHETIC-ITEM"))
            self.assertTrue(case["rendered"].isascii())


if __name__ == "__main__":
    unittest.main(verbosity=2)
