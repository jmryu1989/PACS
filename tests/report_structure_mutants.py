# coding: utf-8
"""TEST-S3-STRUCT-MUTANTS: the browser mutants of the structured-entry path.

REQ-S3-STRUCT-BODY -> RISK-S3-STRUCT-SILENT-BODY-REWRITE/BROKEN-CITATION-BLOCK/LOST-TYPED-WORK/
STALE-CONFIRMATION -> TEST-S3-STRUCT-MUTANTS.

Six defects of this unit only exist once the rule is wired to a real textarea and a real answer, so
the only test that can see them is the browser one. A mutant that is merely declared is not a kill
(U2a precedent), so this runner breaks the product on purpose - in a COPY - and requires the named
case to fail on its own named assertion:

  M1  the sentence is concatenated instead of placed on whole lines  -> D2
  M2  the structure path stops asking for the citation guards        -> D6
  M3c the field is written even when the server refused              -> D7
  M4c the shown plan is no longer compared with the one being sent   -> D15
  M5c the state is kept across a commit instead of being re-read     -> D8
  M6  two identical sentences are replaced by guessing the first     -> D5

Every mutant here is a CLIENT file (P4). The server rules of this unit - the line-block attestation,
the render equality, the presence rule at commit and the explicit clear - are asserted DIRECTLY
through the compiled service in tests/report_structure_test.cjs and must be reported as
"asserted directly, no mutant executed", never as kills.

Rules this runner holds itself to:
  * the source tree is never mutated - every mutant is a COPY reached through the test's
    KIN_STRUCT_MAIN / KIN_STRUCT_STRUCTURE_JS overrides;
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
    "structure": ROOT / "worklist-v0" / "hpacs-lite" / "report-structure.js",
}
ENV_KEY = {"main": "KIN_STRUCT_MAIN", "structure": "KIN_STRUCT_STRUCTURE_JS"}
DOM_TEST = ROOT / "tests" / "report_structure_dom_test.py"
CASE = "ReportStructureDOMTest"

# Narrow on purpose: a marker that also appears in an ordinary failing run would turn every real
# kill into a survivor.
CRASH_MARKERS = ("playwright._impl._errors", "ModuleNotFoundError")

# The harness slices these out of main.html; if one of them moves, the browser file compiles into
# something else and no case means what it says.
SLICE_MARKERS = (
    "    let selectionSeq = 0;",
    "    function reportSource()",
    "    function heldByOther(s)",
    '<div class="modal" id="structmodal"',
)

MUTANTS = [
    {
        "id": "M1",
        "file": "structure",
        "title": "the sentence is concatenated onto the field instead of placed on whole lines",
        "case": "test_d02_apply_writes_the_field_only_after_the_server_answered",
        "expect": "S3-STRUCT M1: the sentence must occupy a whole line and delete nothing",
        "old": "      var plan = citationLib.placeBlock(text, block, at, guards);",
        "new": "      var plan = { text: String(text) + String(block), start: 0, end: 0, line: 1,\n"
               "                   mode: 'end', snapped: null, anchor: null };",
    },
    {
        "id": "M2",
        "file": "main",
        "title": "the structure path stops asking for the citation guards",
        "case": "test_d06_a_new_sentence_never_lands_inside_a_cited_block",
        "expect": "S3-STRUCT M2: an existing citation block may not be cut in half",
        "old": "      const guards = citationGuards(pane.field);",
        "new": "      const guards = [];",
    },
    {
        "id": "M3c",
        "file": "main",
        "title": "the field is written even when the server refused the apply",
        "case": "test_d07_a_refused_apply_leaves_the_body_untouched",
        "expect": "S3-STRUCT M3c: a refused apply must leave every byte of the report alone",
        "old": '        pane.status = "적용하지 못했습니다: " + e.message + " — 판독문은 그대로입니다.";',
        "new": '        $("#" + pane.field).value = fresh.text;\n'
               '        pane.status = "적용하지 못했습니다: " + e.message + " — 판독문은 그대로입니다.";',
    },
    {
        "id": "M4c",
        "file": "main",
        "title": "the plan the person read is no longer compared with the one about to be sent",
        "case": "test_d15_a_plan_that_went_stale_sends_nothing_and_asks_again",
        "expect": "S3-STRUCT M4c: a plan the person did not read may not be sent",
        "old": '      if (!shown || fresh.mode2 === "refuse" || !structureForm.samePlan(shown, fresh)) {',
        "new": '      if (!shown || fresh.mode2 === "refuse") {',
    },
    {
        "id": "M5c",
        "file": "main",
        "title": "the structure state is kept across a commit instead of being re-read",
        "case": "test_d08_after_a_commit_the_state_is_re_read_and_carries_no_stale_keep_list",
        "expect": "S3-STRUCT M5c: after a commit the state must be re-read, not kept",
        "old": "          structureState.forget(uid);\n          structureNotes.delete(uid);",
        "new": "          void uid;",
    },
    {
        "id": "M6",
        "file": "structure",
        "title": "two identical sentences are replaced by guessing the first one",
        "case": "test_d05_an_ambiguous_old_sentence_refuses_and_sends_nothing",
        "expect": "S3-STRUCT M6: two identical sentences must refuse, not guess which one to replace",
        "old": "      if (occurrences >= 2) return { mode2: 'refuse', message: MSG.ambiguous };",
        "new": "      if (occurrences >= 3) return { mode2: 'refuse', message: MSG.ambiguous };",
    },
]


def run_case(overrides, case, timeout):
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
    parser.add_argument("--timeout", type=int, default=240, help="Seconds per child run")
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
        print("anchor %-4s file=%-9s occurrences=%d expect=%r" % (mutant["id"], mutant["file"], found, mutant["expect"]))
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

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="struct-mutants-"))
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
            print("%-4s file=%-9s case=%s exit=%d expect_matched=%s killed=%s"
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
               "source_unchanged": unchanged,
               "server_rules_asserted_directly_not_mutated": "tests/report_structure_test.cjs",
               "results": results}
    if args.out:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print("summary written to %s" % out)
    survivors = [row for row in results if row["id"] != "BASELINE" and not row["killed"]]
    if survivors:
        print("SURVIVORS: %s" % ", ".join(row["id"] for row in survivors))
        return 1
    if not unchanged:
        print("SOURCE CHANGED - refusing to report a clean run")
        return 1
    print("all %d mutants killed" % len(MUTANTS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
