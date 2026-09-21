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
import hashlib
import json
import pathlib
import re
import sys
import unicodedata
import unittest

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "tests" / "report_structure_vectors.json").read_text(encoding="utf-8"))
SERVER = (ROOT / "api" / "src" / "report-structure.ts").read_text(encoding="utf-8")
CLIENT = (ROOT / "worklist-v0" / "hpacs-lite" / "report-structure.js").read_text(encoding="utf-8")
SERVICE = (ROOT / "api" / "src" / "pacs.service.ts").read_text(encoding="utf-8")

SLOT = "{value}"
FIELDS = ("findings", "conclusion", "recommendation")
VALUE_TYPES = ("choice", "number", "text", "boolean")
RENDERED_BYTES = 512


def item_of(code, catalog=None):
    for template in (VECTORS["catalog"] if catalog is None else catalog):
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


def comparison_key(text):
    """The presence equation, restated: fold CRLF and lone CR to LF, NFC, and let a block-final LF
    be the last line's terminator rather than an empty line. Everything below is built on this."""
    value = unicodedata.normalize("NFC", re.sub(r"\r\n?", "\n", text))
    lines = value.split("\n")
    if len(lines) > 1 and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def nfc(text):
    return unicodedata.normalize("NFC", text)


def one_line(text):
    return not any(ord(ch) < 0x20 or ord(ch) in (0x7F, 0x2028, 0x2029) for ch in text)


def well_formed(text):
    """No unpaired surrogate.

    Deliberately NOT a transcription of the shipped loop: Python strings are code points, so there
    are no pairs to walk and any surrogate at all is an unpaired one. Same property, arrived at from
    the rule rather than from either implementation - which is the whole reason this file exists.
    """
    return not any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)


def boundary_stable(prefix, text, suffix):
    """R-S, asked of the actual normaliser: does the key of the whole sentence equal the keys of its
    three pieces joined? If it does not, normalisation reached across a boundary and the sentence is
    no longer the one the literals describe."""
    return comparison_key(prefix + text + suffix) == nfc(prefix) + comparison_key(text) + nfc(suffix)


def independent_catalog_rule(catalog):
    """The five rules, restated from the contract, in the fixed order R-D, R-S, R-C, then pairs
    (R-A before R-B). Returns the first rule the catalog breaks, or ACCEPT."""
    seen_templates = set()
    flat = []
    for template in catalog:
        tid = template.get("templateId")
        if not isinstance(tid, str) or not tid or tid in seen_templates:
            return "R-D"
        seen_templates.add(tid)
        revision = template.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            return "R-D"
        if not isinstance(template.get("title"), str) or not template["title"]:
            return "R-D"
        codes = set()
        for item in template.get("items", []):
            code = item.get("code")
            if not isinstance(code, str) or not code or code in codes:
                return "R-D"
            codes.add(code)
            if item.get("field") not in FIELDS or item.get("valueType") not in VALUE_TYPES:
                return "R-D"
            if not isinstance(item.get("label"), str) or not item["label"]:
                return "R-D"
            sentence = item.get("template")
            if not isinstance(sentence, str) or sentence.count(SLOT) != 1:
                return "R-D"
            prefix, suffix = sentence.split(SLOT)
            if not one_line(prefix + suffix):
                return "R-D"
            if not well_formed(prefix) or not well_formed(suffix):
                return "R-D"
            if nfc(prefix) != prefix or nfc(suffix) != suffix:
                return "R-D"
            if len((prefix + suffix).encode("utf-8")) >= RENDERED_BYTES:
                return "R-D"

            kind = item["valueType"]
            if kind == "choice":
                choices = item.get("choices") or []
                if not choices:
                    return "R-D"
                choice_codes = set()
                for choice in choices:
                    if not isinstance(choice.get("code"), str) or not choice["code"]:
                        return "R-D"
                    if not isinstance(choice.get("text"), str) or not choice["text"]:
                        return "R-D"
                    if not well_formed(choice["text"]):
                        return "R-D"
                    if choice["code"] in choice_codes:
                        return "R-D"
                    choice_codes.add(choice["code"])
                values = [choice["code"] for choice in choices]
            elif kind == "boolean":
                for word in ("trueText", "falseText"):
                    if not isinstance(item.get(word), str) or not item[word]:
                        return "R-D"
                    if not well_formed(item[word]):
                        return "R-D"
                values = [True, False]
            elif kind == "number":
                low, high = item.get("min"), item.get("max")
                if not isinstance(low, (int, float)) or not isinstance(high, (int, float)) or low > high:
                    return "R-D"
                decimals = item.get("decimals")
                if isinstance(decimals, bool) or not isinstance(decimals, int) or not 0 <= decimals <= 6:
                    return "R-D"
                values = []
            else:
                values = []

            for value in values:
                if not boundary_stable(prefix, independent_value_text(item, value), suffix):
                    return "R-S"

            lines = set()
            for value in values:
                line = independent_render(item, value)
                if not one_line(line) or not line.strip():
                    return "R-D"
                if len(line.encode("utf-8")) > RENDERED_BYTES:
                    return "R-D"
                key = comparison_key(line)
                if key in lines:
                    return "R-C"
                lines.add(key)

            flat.append({"field": item["field"], "prefix": prefix, "suffix": suffix,
                         "enumerable": kind in ("choice", "boolean"), "lines": lines})

    for i, a in enumerate(flat):
        for b in flat[i + 1:]:
            if a["field"] != b["field"]:
                continue
            if a["enumerable"] and b["enumerable"]:
                if a["lines"] & b["lines"]:
                    return "R-A"
                continue
            # The empty string is a prefix and a suffix of everything, so an item with an empty
            # literal on one side can only ever be separated by the other side.
            by_prefix = not a["prefix"].startswith(b["prefix"]) and not b["prefix"].startswith(a["prefix"])
            by_suffix = not a["suffix"].endswith(b["suffix"]) and not b["suffix"].endswith(a["suffix"])
            if not by_prefix and not by_suffix:
                return "R-B"
    return "ACCEPT"


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


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

    def test_catalog_vectors_get_the_same_rule_from_an_independent_implementation(self) -> None:
        """The third rule over the whole catalog table.

        The server and the browser each implement these five rules, and they were written together.
        This one is written from the contract, in another language, against another Unicode build -
        so the two shipped copies cannot agree on a shared mistake without this file disagreeing.
        """
        self.assertGreaterEqual(len(VECTORS["catalogVectors"]), 30, "the catalog vectors are missing")
        for case in VECTORS["catalogVectors"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(independent_catalog_rule(case["catalog"]), case["rule"], case["why"])

    def test_entry_vectors_get_the_same_answer_from_an_independent_boundary_rule(self) -> None:
        # Free text is not in the catalog, so the load-time pass never sees these values; R-S has to
        # reach them again at entry time. The ACCEPT rows matter as much as the rejections: they are
        # the values a combining-class rule would have refused for no safety gain.
        self.assertGreaterEqual(len(VECTORS["entryVectors"]), 10, "the entry vectors are missing")
        for case in VECTORS["entryVectors"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(independent_catalog_rule(case["catalog"]), "ACCEPT",
                                 "an entry case must not be decided by its catalog")
                item = item_of(case["itemCode"], case["catalog"])
                prefix, suffix = item["template"].split(SLOT)
                stable = boundary_stable(prefix, independent_value_text(item, case["value"]), suffix)
                self.assertEqual("ACCEPT" if stable else "R-S", case["expect"], case["why"])

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

    def test_both_sides_validate_their_catalog_at_load_time(self) -> None:
        """P12's load gate, asserted as source coordinates on both implementations.

        The behaviour is proved by T1 (compiled, in the image) and T2 (the real browser module);
        what is checked here is that neither gate can be reached around: the server's call is the
        LAST statement of its module, so importing it at all runs the check, and the browser's
        `create()` catches only the typed catalog error - a programming mistake still surfaces.
        """
        self.assertTrue(SERVER.rstrip().endswith("validateCatalog(STRUCTURE_CATALOG);"),
                        "the server must validate its own catalog as the last statement of the module")
        self.assertIn("function validateCatalog(citationLib, catalog)", CLIENT,
                      "the browser needs the same five rules at load time")
        self.assertIn("validateCatalog(citationLib, wanted);", CLIENT, "and create() must call them")
        self.assertIn("if (!(e instanceof CatalogError)) throw e;", CLIENT,
                      "only a catalog rule may be caught; anything else must still surface")
        # B4(b): the injection seam is a gate, and it validates BEFORE it replaces.
        setter = re.search(r"protected set structureCatalog\([^)]*\)\s*\{(.*?)\n  \}", SERVICE, re.S)
        self.assertIsNotNone(setter, "the validated setter is the only way to change the catalog")
        body = setter.group(1)
        self.assertLess(body.index("validateCatalog(next);"), body.index("this.structureCatalogValue = next;"),
                        "validating after assigning would leave an unchecked catalog in place")
        self.assertNotIn("process.env", SERVICE[SERVICE.index("structureCatalogValue"):][:800],
                         "no environment seam was added next to it")

    def test_any_future_catalog_revision_is_still_held(self) -> None:
        """B5: cross-revision collision safety is a named HOLD, not a solved problem.

        Entries written under an older revision are kept and rendered read-only, and head and draft
        are projected separately - so a retired sentence can still be counted present. Nothing in
        this unit decides that. While `revision === 1` holds, the question is vacuous: there is no
        earlier revision for anything to collide with.

        This is an INCOMPLETE tripwire and it is not a proof: it does not see an item-code rename or
        an item removal inside revision 1, and those raise the same question. It fails on the first
        revision bump, which is the moment the decision has to be made.
        """
        server = re.search(r"STRUCTURE_CATALOG:\s*readonly StructureTemplate\[\]\s*=\s*Object\.freeze\((\[[^\]]*\])\)",
                           SERVER)
        client = re.search(r"PRODUCT_CATALOG\s*=\s*Object\.freeze\((\[[^\]]*\])\)", CLIENT)
        for name, group in (("server", server), ("client", client)):
            for template in json.loads(group.group(1)):
                with self.subTest(side=name, template=template.get("templateId")):
                    self.assertEqual(template.get("revision"), 1,
                                     "a revision bump needs an explicit disposition for the retired one first")

    def test_the_pinned_product_sha_is_the_sha_of_both_shipped_literals(self) -> None:
        # B8. T1 asserts this hash against the compiled STRUCTURE_CATALOG and T2 against the browser
        # PRODUCT_CATALOG; neither can see the other. Here both literals are read from source, so
        # this file is what fails if one side ships a catalog and the other does not.
        server = re.search(r"STRUCTURE_CATALOG:\s*readonly StructureTemplate\[\]\s*=\s*Object\.freeze\((\[[^\]]*\])\)",
                           SERVER)
        client = re.search(r"PRODUCT_CATALOG\s*=\s*Object\.freeze\((\[[^\]]*\])\)", CLIENT)
        pinned = VECTORS["productCatalogSha256"]
        self.assertRegex(pinned, r"^[0-9a-f]{64}$")
        for name, group in (("server", server), ("client", client)):
            with self.subTest(side=name):
                digest = hashlib.sha256(
                    canonical_json(json.loads(group.group(1))).encode("utf-8")).hexdigest()
                self.assertEqual(digest, pinned, f"the {name} product catalog is not the pinned one")

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
