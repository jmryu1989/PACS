# coding: utf-8
"""TEST-S3-U6-CURSOR-MUTANTS: the browser mutants of the cursor placement path.

REQ-S3-U6-CURSOR-INSERTION -> RISK-S3-U6-SPLIT-LINE/BROKEN-GUARD/DIVERGENT-BODY/UNREAD-POSITION/
LOST-CARET -> TEST-S3-U6-CURSOR-MUTANTS.

Six of this unit's defects only exist once the rule is wired to a real textarea, so the only test
that can see them is the browser one. A mutant that is merely declared is not a kill (U2a precedent),
so this runner breaks the product on purpose - in a COPY - and requires the named case to fail on
its own named assertion:

  M1  the placement no longer terminates the line it lands on   -> D1
  M2  a field with no confirmed caret is read as position 0     -> D2
  M3  the shown-position check before the PUT is dropped        -> D7
  M4  the screen goes back to appending at the end              -> D11
  M5  the guard that steps past an existing citation is dropped -> D10
  M6  the caret is parked at the end of the field               -> D1

Rules this runner holds itself to:
  * the source tree is never mutated - every mutant is a COPY reached through the test's
    KIN_CURSOR_MAIN / KIN_CURSOR_CITATION_JS overrides;
  * each anchor must occur exactly once, or that is a failure, not a survivor;
  * a kill needs a non-zero child exit AND the named case reported as FAIL (never ERROR) AND an
    AssertionError AND that mutant's own expect text inside that case's failure block AND no
    harness crash - a crash is not a kill;
  * the unmutated copies must first pass through the same overrides, or no kill is reported;
  * both mutated file hashes and the unchanged source hashes are written to the summary.

stdlib only. It launches the browser test as a child process; it never drives a browser itself.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = {
    "main": ROOT / "worklist-v0" / "hpacs-lite" / "main.html",
    "citation": ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js",
}
ENV_KEY = {"main": "KIN_CURSOR_MAIN", "citation": "KIN_CURSOR_CITATION_JS"}
DOM_TEST = ROOT / "tests" / "report_cursor_insert_dom_test.py"
CASE = "ReportCursorInsertDOMTest"

# Narrow on purpose: a marker that also appears in an ordinary failing run would turn every real
# kill into a survivor.
CRASH_MARKERS = ("playwright._impl._errors", "ModuleNotFoundError")

# The harness slices these out of main.html; if one of them moves, the browser file compiles into
# something else and no case means what it says.
SLICE_MARKERS = (
    "    let selectionSeq = 0;",
    "    function reportSource()",
    "    function heldByOther(s)",
)

MUTANTS = [
    {
        "id": "M1",
        "file": "citation",
        "title": "the block no longer terminates the line it lands on, so it is spliced mid-line",
        "case": "test_d01_caret_in_the_middle_of_the_field_places_whole_lines_and_the_caret",
        "expect": "S3-U6 M1: the block must occupy whole lines after the caret's own line",
        "old": "    const prefix = q > 0 && value[q - 1] !== '\\n' ? '\\n' : '';",
        "new": "    const prefix = '';",
    },
    {
        "id": "M2",
        "file": "main",
        "title": "a field the person never put a caret in is read as position 0",
        "case": "test_d02_an_untouched_field_appends_exactly_as_before",
        "expect": "S3-U6 M2: a field nobody put a caret in still appends at the end",
        "old": "      if (!caretFields.has(field)) return null;",
        "new": "      if (false) return null;",
    },
    {
        "id": "M3",
        "file": "main",
        "title": "the position the person read is no longer compared with the one about to be sent",
        "case": "test_d07_a_change_before_the_first_press_sends_nothing_and_asks_again",
        "expect": "S3-U6 M3: a position the person did not read may not be sent",
        "old": "        if (!pane.plan || plan2.text !== pane.plan.text) {",
        "new": "        if (false) {",
    },
    {
        "id": "M4",
        "file": "main",
        "title": "the screen goes back to appending at the end instead of writing what was sent",
        "case": "test_d11_the_body_the_screen_and_the_attestation_are_one_string",
        "expect": "S3-U6 M4: the string that was sent is the string on the screen",
        "old": "        el.value = shown.text;",
        "new": "        el.value += (el.value ? \"\\n\" : \"\") + pane.block;",
    },
    {
        "id": "M5",
        "file": "citation",
        "title": "the step past an existing citation is dropped, so an insertion splits it",
        "case": "test_d10_an_anchor_inside_an_existing_citation_moves_past_it",
        "expect": "S3-U6 M5: the new sentence must land past the citation, never inside it",
        "old": "            if (from < pos && pos < to) { pos = to; moved = true; snapped = 'past-citation'; }",
        "new": "            if (false) { pos = to; moved = true; snapped = 'past-citation'; }",
    },
    {
        "id": "M6",
        "file": "main",
        "title": "the caret is parked at the end of the field instead of on the inserted block",
        "case": "test_d01_caret_in_the_middle_of_the_field_places_whole_lines_and_the_caret",
        "expect": "S3-U6 M6: the caret must end on the inserted block, not at the end of the field",
        "old": "        el.setSelectionRange(shown.end, shown.end);",
        "new": "        el.setSelectionRange(el.value.length, el.value.length);",
    },
]


def run_case(overrides, case, timeout):
    """Run one case of the browser test with the given files standing in for the shipped ones."""
    environment = dict(os.environ)
    for key, path in overrides.items():
        environment[ENV_KEY[key]] = str(path)
    environment["PYTHONIOENCODING"] = "utf-8"
    target = "%s.%s" % (CASE, case) if case else ""
    command = [sys.executable, "-B", str(DOM_TEST)] + ([target] if target else [])
    done = subprocess.run(command, cwd=str(ROOT), env=environment, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return done, (done.stdout or "") + (done.stderr or "")


def failure_block(output, case):
    """The named FAIL line and the traceback block that belongs to that case."""
    named = [line.strip() for line in output.splitlines()
             if case in line and "FAIL" in line and "ERROR" not in line]
    blocks = re.split(r"^={10,}$", output, flags=re.MULTILINE)
    mine = [block for block in blocks if case in block and "AssertionError" in block]
    assertion = [line.strip() for line in output.splitlines() if "AssertionError" in line]
    return named[0] if named else "", ("\n".join(mine) if mine else ""), (assertion[0][:400] if assertion else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="Where to write the per-mutant JSON summary")
    parser.add_argument("--timeout", type=int, default=180, help="Seconds per child run")
    parser.add_argument("--anchors-only", action="store_true",
                        help="Check every anchor, marker and case name against the shipped sources and stop")
    args = parser.parse_args()

    source = {name: path.read_text(encoding="utf-8") for name, path in SOURCES.items()}
    digest = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in SOURCES.items()}
    for name in sorted(digest):
        print("%s sha256 %s" % (SOURCES[name].name, digest[name]))

    problems = []
    dom_source = DOM_TEST.read_text(encoding="utf-8")
    seen = set()
    for mutant in MUTANTS:
        if ("def %s(" % mutant["case"]) not in dom_source:
            problems.append("%s names a case that does not exist: %s" % (mutant["id"], mutant["case"]))
        if mutant["expect"] not in dom_source:
            problems.append("%s expects a message no assertion carries: %s" % (mutant["id"], mutant["expect"]))
        if mutant["expect"] in seen:
            problems.append("%s reuses an expect message; a kill must name one boundary" % mutant["id"])
        seen.add(mutant["expect"])
    for marker in SLICE_MARKERS:
        found = source["main"].count(marker)
        print("marker occurrences=%d %r" % (found, marker[:40]))
        if found != 1:
            problems.append("harness slice marker occurs %d times: %r" % (found, marker[:40]))
    for mutant in MUTANTS:
        found = source[mutant["file"]].count(mutant["old"])
        print("anchor %-3s file=%-8s occurrences=%d expect=%r" % (mutant["id"], mutant["file"], found, mutant["expect"]))
        if found != 1:
            problems.append("%s anchor occurs %d times in %s" % (mutant["id"], found, mutant["file"]))
        if mutant["new"] in source[mutant["file"]]:
            problems.append("%s mutation is already the shipped text" % mutant["id"])
    if problems:
        for problem in problems:
            print("ANCHOR FAILURE:", problem)
        return 1
    if args.anchors_only:
        print("anchors ok (no browser run requested)")
        return 0

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="u6-mutants-"))
    results = []
    try:
        clean = {}
        for name, path in SOURCES.items():
            copy = scratch / ("baseline-%s%s" % (name, path.suffix))
            shutil.copyfile(path, copy)
            clean[name] = copy
        done, output = run_case(clean, None, args.timeout)
        baseline_ok = done.returncode == 0 and not any(marker in output for marker in CRASH_MARKERS)
        ran = re.search(r"Ran (\d+) tests?", output)
        print("BASELINE exit=%d tests=%s ok=%s" % (done.returncode, ran.group(1) if ran else "?", baseline_ok))
        results.append({"id": "BASELINE", "case": "all", "child_exit": done.returncode,
                        "tests_ran": int(ran.group(1)) if ran else None, "ok": baseline_ok})
        if not baseline_ok:
            print("BASELINE FAILED - refusing to report kills:")
            print(output[-2000:])
            return 1

        for mutant in MUTANTS:
            target = SOURCES[mutant["file"]]
            broken = scratch / ("%s-%s%s" % (mutant["id"], mutant["file"], target.suffix))
            broken.write_text(source[mutant["file"]].replace(mutant["old"], mutant["new"]), encoding="utf-8")
            if broken.read_text(encoding="utf-8") == source[mutant["file"]]:
                raise AssertionError(mutant["id"])
            overrides = dict(clean)
            overrides[mutant["file"]] = broken
            done, output = run_case(overrides, mutant["case"], args.timeout)
            named, block, assertion = failure_block(output, mutant["case"])
            crashed = any(marker in output for marker in CRASH_MARKERS)
            matched = mutant["expect"] if mutant["expect"] in block else ""
            killed = (done.returncode != 0 and bool(named) and bool(assertion)
                      and bool(matched) and not crashed)
            print("%-3s file=%-8s case=%s exit=%d expect_matched=%s killed=%s"
                  % (mutant["id"], mutant["file"], mutant["case"], done.returncode, bool(matched), killed))
            print("      %s" % (assertion or named or "no failure reported"))
            results.append({"id": mutant["id"], "title": mutant["title"], "file": mutant["file"],
                            "case": mutant["case"], "child_exit": done.returncode, "named_failure": named,
                            "expect": mutant["expect"], "expect_matched": matched,
                            "assertion_text": assertion, "harness_crash": crashed, "killed": killed,
                            "mutant_sha256": hashlib.sha256(broken.read_bytes()).hexdigest()})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    after = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in SOURCES.items()}
    unchanged = all(after[name] == digest[name] for name in digest)
    print("sources unchanged=%s" % unchanged)
    summary = {"source_sha256_before": digest, "source_sha256_after": after,
               "source_unchanged": unchanged, "results": results}
    if args.out:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print("summary written to %s" % out)
    survivors = [row for row in results if row["id"] != "BASELINE" and not row["killed"]]
    if survivors:
        print("SURVIVORS: %s" % ", ".join(row["id"] for row in survivors))
        return 1
    print("all %d mutants killed on their own assertion" % (len(results) - 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
