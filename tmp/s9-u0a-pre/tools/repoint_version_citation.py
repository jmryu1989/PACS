# coding: utf-8
"""One-off edit: report_version_citation_dom_test.py's HISTORY_BLOCK and its mutant driver's marker check move to the
fixture projection (M06 moved the end marker - reportWriteBlock's comment - ahead of the history block)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def edit(path, pairs):
    text = path.read_bytes().decode("utf-8")
    nl = "\r\n" if "\r\n" in text else "\n"
    text = text.replace("\r\n", "\n")
    for old, new in pairs:
        assert text.count(old) == 1, (path.name, old[:80])
        text = text.replace(old, new)
    path.write_bytes(text.replace("\n", nl).encode("utf-8"))


edit(ROOT / "tests/report_version_citation_dom_test.py", [
    ("from page_source import read_page_source\n", "from page_source import read_page_source\nfrom main_split_harness import fixture_blocks\n"),
    ('MAIN = read_page_source(Path(os.environ.get("KIN_HISTORY_CITATION_MAIN",\n'
     '                           ROOT / "worklist-v0" / "hpacs-lite" / "main.html")))\n',
     'MAIN_PATH = Path(os.environ.get("KIN_HISTORY_CITATION_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html"))\n'
     'MAIN = read_page_source(MAIN_PATH)\n'),
    ('# The end marker is the two-line composite: the following line in main.html is the bare "    /**"\n'
     '# opener of the next comment, so a single-line marker would leave an unterminated block comment\n'
     '# and every case would die before its first assertion.\n'
     'HISTORY_BLOCK = slice_between(MAIN, "    // ── 판독문 이력 ──",\n'
     '                              "    /**\\n     * 판독문 textarea를 **스크립트로**")\n',
     '# The shipped history block - the f1d5406 statements from the history state up to reportWriteBlock - by the\n'
     '# TypeScript-AST fixture projection (main_split_harness): S9-U0a-PRE moved reportWriteBlock, whose comment ended the\n'
     '# old text cut, ahead of its first caller.\n'
     'HISTORY_BLOCK = fixture_blocks(MAIN_PATH, {"HISTORY_BLOCK": ("historyEpoch", "reportWriteBlock")})["HISTORY_BLOCK"]\n'),
])
edit(ROOT / "tests/report_version_citation_mutants.py", [
    ("from page_source import read_page_bytes, read_page_source\n",
     "from page_source import read_page_bytes, read_page_source\nfrom main_split_harness import fixture_blocks\n"),
    ('# The two markers the DOM harness slices the shipped history block between. They are checked here\n'
     '# for the same reason the anchors are: if either drifts, the harness silently compiles a different\n'
     '# region and every mutant reports a survivor.\n'
     'SLICE_MARKERS = (\n'
     '    "    // ── 판독문 이력 ──",\n'
     '    "    /**\\n     * 판독문 textarea를 **스크립트로**",\n'
     ')\n',
     '# The DOM harness takes the shipped history block by the fixture projection (main_split_harness); the run is checked\n'
     '# after the anchors-only exit (it needs node and the api TypeScript) for the same reason the anchors are: a run that\n'
     '# does not resolve would compile a different region and every mutant would report a survivor.\n'
     'HISTORY_FIXTURE = {"HISTORY_BLOCK": ("historyEpoch", "reportWriteBlock")}\n'
     'SLICE_MARKERS = ()\n'),
    ('    if args.anchors_only:\n        print("anchors ok (no browser run requested)")\n        return 0\n',
     '    if args.anchors_only:\n        print("anchors ok (no browser run requested)")\n        return 0\n'
     '    try:\n        fixture_blocks(SOURCE, HISTORY_FIXTURE)\n        print("fixture run resolves: HISTORY_BLOCK")\n'
     '    except Exception as error:\n        print("ANCHOR FAILURE: harness fixture run does not resolve: %s" % error)\n        return 1\n'),
])
print("edited")
