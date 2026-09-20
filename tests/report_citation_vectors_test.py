"""TEST-S3-U2a-VECTORS: the shared citation oracle, checked against an independent rule.

REQ-S3-U2a-CITATION-BACKEND -> RISK-S3-CITATION-FALSE-PRESENCE -> TEST-S3-U2a-VECTORS.

`tests/report_citation_vectors.json` is the single oracle two separate implementations answer to:
the compiled server validator (`api/src/report-citation.ts`, exercised by
`tests/report_citation_test.cjs` inside the built image) and the S3-U2b client comparator that does
not exist yet. A shared oracle only helps if the oracle itself is right, so this file re-derives the
contract rule here - whole lines, consecutive, non-overlapping, compared after CRLF/lone-CR/NFC
normalization - and holds every vector against it. If the vectors and the rule ever disagree, one of
them is wrong and the person would be told a sentence is preserved when it is not.

Pure: reads two files, no stack, no container, no network, no database.
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


def normalize(text: str) -> str:
    """Comparison only. The stored bytes are never normalized - that would edit a medical record."""
    return unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))


def is_blank(block: str) -> bool:
    return normalize(block).strip() == ""


def block_lines(block: str) -> list[str]:
    """A block's final LF terminates its last line; it is not an extra empty line."""
    lines = normalize(block).split("\n")
    if len(lines) > 1 and lines[-1] == "":
        lines.pop()
    return lines


def occurrences(body: str, block: str) -> int:
    if is_blank(block):
        return 0
    want = block_lines(block)
    lines = normalize(body).split("\n")
    count = index = 0
    while index + len(want) <= len(lines):
        if lines[index:index + len(want)] == want:
            count += 1
            index += len(want)
        else:
            index += 1
    return count


def comparison_key(text: str) -> str:
    """n and k must use one equivalence. k counts whole-line blocks, so the block's final LF is a
    terminator there; if n ignored that, two citations competing for one occurrence would both read
    'present' while only one line exists."""
    return "\n".join(block_lines(text))


def same_text_counts(entries: list[dict]) -> list[int]:
    keys = [(entry["field"], comparison_key(entry["insertedText"])) for entry in entries]
    return [keys.count(key) for key in keys]


def presence(k: int, n: int) -> str:
    if k <= 0:
        return "absent"
    return "present" if k >= n else "ambiguous"


def assemble(title: str, text: str, characteristics):
    """R5's one deterministic template: title, text, characteristics in that order."""
    blocks = []
    for value, prefix in ((title, ""), (text, ""), (characteristics, "특성: ")):
        if value is None:
            continue
        normalized = normalize(value)
        if not normalized:
            continue
        blocks.append(prefix + normalized)
    joined = "\n".join(blocks)
    return None if is_blank(joined) else joined


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

    def test_occurrence_vectors_match_the_contract_rule(self) -> None:
        for case in self.data["occurrence"]:
            with self.subTest(case["name"]):
                body, block = self.operands(case)
                self.assertEqual(occurrences(body, block), case["k"], case.get("why", ""))

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

    def test_blank_vectors(self) -> None:
        for case in self.data["blank"]:
            with self.subTest(case["name"]):
                self.assertEqual(is_blank(case["block"]), case["refused"])
                if case["refused"]:
                    # A refused block must also count nothing: otherwise one blank line in the
                    # field would satisfy every blank citation.
                    self.assertEqual(occurrences("one\n\ntwo", case["block"]), 0)

    def test_same_text_counts(self) -> None:
        for case in self.data["sameText"]:
            with self.subTest(case["name"]):
                self.assertEqual(same_text_counts(case["entries"]), case["counts"])

    def test_presence_states(self) -> None:
        for case in self.data["state"]:
            with self.subTest(case["name"]):
                self.assertEqual(presence(case["k"], case["n"]), case["state"])

    def test_equivalence_vectors_tie_k_and_n_to_one_rule(self) -> None:
        """The defect this section exists for: if n keys on raw normalized text while k absorbs the
        block's final LF, two citations competing for a single occurrence both report 'present'."""
        for case in self.data["equivalence"]:
            with self.subTest(case["name"]):
                texts = [entry["insertedText"] for entry in case["entries"]]
                self.assertEqual([occurrences(case["body"], text) for text in texts], case["k"])
                counts = same_text_counts(case["entries"])
                self.assertEqual(counts, case["counts"], case.get("why", ""))
                self.assertEqual([presence(k, n) for k, n in zip(case["k"], counts)], case["states"])

    def test_one_equivalence_is_used_for_both_counts(self) -> None:
        # A regression guard on the rule itself, independent of the vector list.
        self.assertEqual(comparison_key("A line"), comparison_key("A line\n"))
        self.assertEqual(comparison_key("A line"), comparison_key("A line\r"))
        self.assertEqual(comparison_key("one\r\ntwo"), comparison_key("one\ntwo"))
        self.assertNotEqual(comparison_key("A line"), comparison_key("\nA line"))
        self.assertNotEqual(comparison_key("A line"), comparison_key("A line\n\n"))
        # The key never touches the stored bytes: two citations may share n and still be different
        # records with their own attested text.
        self.assertNotEqual("A line", "A line\n")

    def test_assembly_vectors(self) -> None:
        # S3-U2b consumes these; they are pinned now so the client cannot invent a different
        # template later. No U2a product code reads them.
        for case in self.data["assembly"]:
            with self.subTest(case["name"]):
                built = assemble(case["title"], case["text"], case["characteristics"])
                if case.get("refused"):
                    self.assertIsNone(built)
                else:
                    self.assertEqual(built, case["block"])

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

    def test_assembled_blocks_are_findable_in_a_report_field(self) -> None:
        """The two halves meet here: what R5 assembles must satisfy the block rule it will be
        attested with. An assembled block that could never match would make every citation
        'absent' the moment it was written."""
        for case in self.data["assembly"]:
            if case.get("refused"):
                continue
            with self.subTest(case["name"]):
                block = case["block"]
                # The client appends one LF when the field is not empty; the separator is outside
                # insertedText.
                self.assertEqual(occurrences("기존 판독문\n" + block, block), 1)
                self.assertEqual(occurrences(block, block), 1)
                self.assertEqual(occurrences("기존 판독문\n" + block + "\n이어 친 글", block), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
