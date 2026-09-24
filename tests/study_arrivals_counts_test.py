# coding: utf-8
"""S4-U1a count contract: QIDO 00201208/00201206 absent or non-integer is unknown (null), never 0.

Pure stdlib. Two things are checked here and nothing more:
  1. Discriminating vectors for the count rule, evaluated against a Python model that mirrors
     `qidoCount` in api/src/pacs.service.ts character for character in its decision surface
     (trim, IS-shaped digits with optional '+', safe-integer bound). The TS/JS runtimes are NOT
     executed by this file; the Node cases live in tests/study_arrivals_test.cjs and the API
     build is a hosted concern. A green run here is a spec check plus source pins, not runtime proof.
  2. Source pins that the shipped files still carry the rule the vectors describe, so a later
     edit that reintroduces `|| 0` or drops the null branch fails this file rather than silently
     changing the meaning of 0 in the worklist.
"""
from __future__ import annotations

import math
import re
import sys
import unittest
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "api" / "src" / "pacs.service.ts"
ARRIVALS = ROOT / "worklist-v0" / "hpacs-lite" / "study-arrivals.js"
CJS = ROOT / "tests" / "study_arrivals_test.cjs"
CHANGED = (SERVICE, ARRIVALS, CJS, Path(__file__).resolve())

IS_SHAPE = re.compile(r"\+?\d+", re.ASCII)   # JS \d is ASCII-only; Python's is not without re.ASCII
SAFE = 2 ** 53 - 1


class _Absent:
    """Marks a QIDO row where Value or the tag itself is missing."""


ABSENT = _Absent()


def qido_count(raw):
    """Python model of `qidoCount(st, key)` after `st?.[key]?.Value?.[0]` has been resolved to raw.

    JS: typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
    """
    if isinstance(raw, bool) or raw is ABSENT or raw is None:
        text = ""
    elif isinstance(raw, (int, float)):
        text = js_number_string(raw)
    elif isinstance(raw, str):
        text = raw.strip()
    else:
        text = ""
    if not IS_SHAPE.fullmatch(text):
        return None
    # JS Number(digits) rounds anything above 2^53-1 to >= 2^53, which isSafeInteger rejects,
    # so an exact integer comparison is the same decision.
    value = int(text)
    return value if value <= SAFE else None


def js_number_string(number):
    """`String(n)` for the number shapes the vectors use; enough to decide the IS regex."""
    if isinstance(number, float):
        if math.isnan(number):
            return "NaN"
        if math.isinf(number):
            return "Infinity" if number > 0 else "-Infinity"
        if number.is_integer() and abs(number) < 1e21:
            return str(int(number))          # 12.0 -> "12", -0.0 -> "0" (String(-0) is "0")
        if abs(number) >= 1e21:
            return "1e+21"                   # any such value fails the regex; exact text is irrelevant
        return repr(number)                  # "3.5"
    return str(number)


# (label, raw QIDO Value[0], expected) — every row names the boundary it discriminates.
VECTORS = [
    ("tag absent", ABSENT, None),
    ("Value present but null (JSON null)", None, None),
    ("empty string", "", None),
    ("whitespace only", "   ", None),
    ("real zero as number", 0, 0),
    ("real zero as IS string", "0", 0),
    ("negative zero number is 0", -0.0, 0),
    ("plain integer number", 12, 12),
    ("integer-valued float number", 12.0, 12),
    ("IS string", "12", 12),
    ("IS string with DICOM padding", "  12 ", 12),
    ("IS string with leading plus", "+12", 12),
    ("IS string with leading zeros", "0012", 12),
    ("negative number is unknown, not a count", -1, None),
    ("negative IS string is unknown", "-1", None),
    ("fractional number is unknown", 3.5, None),
    ("fractional string is unknown", "3.5", None),
    ("exponent string is unknown", "1e3", None),
    ("hex string is unknown (no Number() coercion)", "0x10", None),
    ("digits with inner space are unknown", "1 2", None),
    ("non-numeric string is unknown", "abc", None),
    ("NaN is unknown", float("nan"), None),
    ("Infinity is unknown", float("inf"), None),
    ("number at 1e21 is unknown", 1e21, None),
    ("boolean true is unknown (typeof boolean)", True, None),
    ("object value is unknown", {"Alphabetic": "12"}, None),
    ("largest safe integer as string", str(SAFE), SAFE),
    ("largest safe integer as number", SAFE, SAFE),
    ("2^53 is unknown (not a safe integer)", str(SAFE + 1), None),
    ("20-digit string is unknown", "99999999999999999999", None),
    ("fullwidth digits are unknown (JS \\d is ASCII)", "１２", None),
]


class CountRuleVectors(unittest.TestCase):
    def test_vectors_discriminate_absent_from_zero_and_reject_coercion(self):
        for label, raw, expected in VECTORS:
            with self.subTest(label):
                self.assertEqual(expected, qido_count(raw))

    def test_zero_and_unknown_are_distinct_values(self):
        self.assertEqual(0, qido_count("0"))
        self.assertIsNone(qido_count(ABSENT))
        self.assertIsNot(qido_count("0"), qido_count(ABSENT))

    def test_old_rule_would_have_collapsed_these_to_zero(self):
        # Documents the defect the unit removes: `+'' || 0` and `+'abc' || 0` are 0.
        collapsed = [label for label, raw, expected in VECTORS if expected is None and raw in (ABSENT, "", "abc")]
        self.assertEqual(3, len(collapsed))


class SourcePins(unittest.TestCase):
    def setUp(self):
        self.service = SERVICE.read_text(encoding="utf-8")
        self.arrivals = ARRIVALS.read_text(encoding="utf-8")
        self.cjs = CJS.read_text(encoding="utf-8")

    def test_service_routes_both_count_tags_through_qido_count_and_never_or_zero(self):
        self.assertIn("count: qidoCount(st, '00201208'),", self.service)
        self.assertIn("series: qidoCount(st, '00201206'),", self.service)
        self.assertNotRegex(self.service, r"tag\(st, '0020120[68]'\)")
        self.assertNotRegex(self.service, r"\+OrthancService\.tag\([^)]*\)\s*\|\|\s*0")

    def test_service_helper_decision_surface_matches_the_python_model(self):
        body = self.service[self.service.index("export function qidoCount("):]
        body = body[:body.index("\n}\n") + 3]
        self.assertIn("typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''", body)
        self.assertIn(r"/^\+?\d+$/.test(text)", body)
        self.assertIn("return null", body)
        self.assertIn("Number.isSafeInteger(value) ? value : null", body)
        self.assertEqual(r"\+?\d+", IS_SHAPE.pattern)
        self.assertIn(": number | null", body)

    def test_arrivals_module_accepts_null_as_unknown_and_measures_growth_only_between_known(self):
        self.assertIn("const validCount=value=>value===null||(Number.isSafeInteger(value)&&value>=0);", self.arrivals)
        self.assertIn("const added=(before,after)=>before!==null&&after!==null&&after>before?after-before:0;", self.arrivals)
        self.assertIn("if(!addedInstances&&!addedSeries)continue;", self.arrivals)
        self.assertNotIn("current.count<=old.count", self.arrivals)
        self.assertNotIn("Math.max(0,", self.arrivals)
        self.assertNotIn("||0", self.arrivals.replace(" ", ""))

    def test_node_cases_carry_the_discriminating_vectors(self):
        for needle in (
            "arrivals.diff([row('1.2',null,null)],[row('1.2',12,3)]),{ok:true,changes:[]}",
            "arrivals.diff([row('1.2',5,2)],[row('1.2',null,2)]),{ok:true,changes:[]}",
            "previousCount:0,count:3,previousSeries:0,series:1,addedInstances:3,addedSeries:1",
            "previousCount:5,count:7,previousSeries:null,series:3,addedInstances:2,addedSeries:0",
            "[[row('1.2','12',1)],'invalid-count']",
            "[[row('1.2',undefined,1)],'invalid-count']",
        ):
            self.assertIn(needle, self.cjs)
        self.assertNotIn("[[row('1.2',null,1)],'invalid-count']", self.cjs)

    def test_changed_files_are_strict_utf8_without_bom_or_bare_cr(self):
        # The committed blobs are LF (core.autocrlf normalises on add); a Windows checkout may
        # show CRLF, so only a bare CR or a BOM is a defect here. LF-ness of the blobs is
        # recorded by the run evidence, not by this working-tree read.
        for path in CHANGED:
            with self.subTest(path.name):
                data = path.read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                text = data.decode("utf-8")
                self.assertNotIn("\r", text.replace("\r\n", "\n"))
                self.assertEqual(text.replace("\r\n", "\n"), path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
