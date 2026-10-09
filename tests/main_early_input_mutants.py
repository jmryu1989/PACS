# coding: utf-8
"""REQ-S9-U0a-PRE-ORDER -> RISK-EARLY-TDZ / RISK-REGISTRATION-ORDER / RISK-REGISTRATION-DUPLICATE
-> TEST-PRE-MUTANTS: the 37 mutants of the PRE design, each killed by its own case of main_early_input_dom_test.py.

  M01..M35  one declaration PRE moved ahead of its first caller goes back to its f1d5406 place (a split declarator
            back into its multi-declaration), every other one stays where PRE put it
  M36       the boot Retry click registers a second Quick Match closure of the same behaviour
  M37       the dictation edit notice is registered after the citation input listener of the same textareas

The mutants are written by main_split_harness.cjs `pre-mutant` from the page under test (main.html, or KIN_PRE_PAGE)
into a scratch copy that main_early_input_dom_test.py loads through KIN_PRE_PAGE; nothing in the source tree is
mutated. Rules this runner holds itself to (as the S3 mutant runners do):
  * the unmutated page must first pass every named case through the same override, or no kill is reported;
  * a kill needs a non-zero child exit AND the named case reported as FAIL (never ERROR) AND an AssertionError (the
    suite's HazardFailure is one) AND that mutant's own expect text inside that case's failure block AND no harness
    crash - an import or fixture error is not a kill;
  * the source hash is written to the summary before and after.

stdlib only; it launches the browser test as a child process (one per mutant) and never drives a browser itself.
--anchors-only writes every mutant (no browser) and stops.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = pathlib.Path(os.environ.get("KIN_PRE_PAGE", ROOT / "worklist-v0" / "hpacs-lite" / "main.html"))
HELPER = ROOT / "tests" / "main_split_harness.cjs"
DOM_TEST = ROOT / "tests" / "main_early_input_dom_test.py"
CRASH_MARKERS = ("playwright._impl._errors", "ModuleNotFoundError")

SPLIT = "EarlyInputSplit."
# One case per mutant that fails on it with the mutant's own text (the moved binding, or the user result for the
# saved-search chips and the two registration mutants), chosen from the full local runs of every mutant.
MUTANTS = [
    {"id": "M01", "case": "EarlyInputSplit.test_B1_03_45_hold_report_editor_js",
     "expect": "ReferenceError: selectionSeq is not defined"},
    {"id": "M02", "case": "EarlyInputSplit.test_B1_05_45_hold_worklist_columns_view_js",
     "expect": "ReferenceError: studies is not defined"},
    {"id": "M03", "case": "EarlyInputSplit.test_B1_05_45_hold_worklist_columns_view_js",
     "expect": "ReferenceError: selectedUid is not defined"},
    {"id": "M04", "case": "EarlyInputSplit.test_B1_05_45_hold_current_study_js",
     "expect": "ReferenceError: cur is not defined"},
    {"id": "M05", "case": "EarlyInputSplit.test_B1_05_45_hold_current_study_js",
     "expect": "ReferenceError: RFIELDS is not defined"},
    {"id": "M06", "case": "EarlyInputSplit.test_B1_05_45_hold_current_study_js",
     "expect": "ReferenceError: reportWriteBlock is not defined"},
    {"id": "M07", "case": "EarlyInputSplit.test_B1_05_TAB_45_hold_report_draft_save_js",
     "expect": "ReferenceError: editReport is not defined"},
    {"id": "M08", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: relatedModalities is not defined"},
    {"id": "M09", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: relatedPageQuery is not defined"},
    {"id": "M10", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: renderRelated is not defined"},
    {"id": "M11", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: savedFilterDays is not defined"},
    {"id": "M12", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: filteredFor is not defined"},
    {"id": "M13", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: consultationFilter is not defined"},
    {"id": "M14", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: searchCriteria is not defined"},
    {"id": "M15", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: filtered is not defined"},
    {"id": "M16", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: orderedStudies is not defined"},
    {"id": "M17", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: resultQuery is not defined"},
    {"id": "M18", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: render is not defined"},
    {"id": "M19", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: relatedStudy is not defined"},
    {"id": "M20", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: viewed is not defined"},
    {"id": "M21", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: renderStudyIdentity is not defined"},
    {"id": "M22", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: renderDraftHint is not defined"},
    {"id": "M23", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: heldByOther is not defined"},
    {"id": "M24", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: updateReportButtons is not defined"},
    {"id": "M25", "case": "EarlyInputSplit.test_B1_58_45_hold_saved_filters_js",
     "expect": "'chips': 'SYN Local Search (0)'"},
    {"id": "M26", "case": "UnsplitControl.test_B1_58_unsplit",
     "expect": "'chips': 'SYN Local Search (0)'"},
    {"id": "M27", "case": "EarlyInputSplit.test_B1_58_45_hold_saved_filters_js",
     "expect": "'chips': 'SYN Local Search (0)'"},
    {"id": "M28", "case": "EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js",
     "expect": "ReferenceError: activeFilterName is not defined"},
    {"id": "M29", "case": "EarlyInputSplit.test_B1_58_45_hold_saved_filters_js",
     "expect": "ReferenceError: renderActiveFilter is not defined"},
    {"id": "M30", "case": "EarlyInputSplit.test_B1_58_45_hold_saved_filters_js",
     "expect": "ReferenceError: renderChips is not defined"},
    {"id": "M31", "case": "EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js",
     "expect": "ReferenceError: layoutMode is not defined"},
    {"id": "M32", "case": "EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js",
     "expect": "ReferenceError: workspaceState is not defined"},
    {"id": "M33", "case": "EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js",
     "expect": "ReferenceError: portraitLayout is not defined"},
    {"id": "M34", "case": "EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js",
     "expect": "ReferenceError: workspaceAxis is not defined"},
    {"id": "M35", "case": "EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js",
     "expect": "ReferenceError: applyLayout is not defined"},
    {"id": "M36", "case": "Registration.test_after_retry_one_quick_match_change_has_one_effect",
     "expect": "the listeners one Quick Match change reaches after Retry"},
    {"id": "M37", "case": "Registration.test_a_report_field_input_reaches_its_listeners_in_the_original_order",
     "expect": "the (target, event, listener) invocation order of one focus/keypress"},
]


def run_cases(page, cases, timeout):
    environment = dict(os.environ, KIN_PRE_PAGE=str(page), PYTHONIOENCODING="utf-8")
    for key in ("KIN_PRE_SPEC", "KIN_PRE_TRACE_DIR"):
        environment.pop(key, None)
    command = [sys.executable, "-B", str(DOM_TEST), *cases]
    done = subprocess.run(command, cwd=str(ROOT), env=environment, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)
    return done, (done.stdout or "") + (done.stderr or "")


def failure_block(output, case):
    """The named FAIL line and the traceback block that belongs to that case."""
    name = case.split(".")[-1]
    named = [line.strip() for line in output.splitlines() if line.startswith("FAIL: " + name + " ")]
    blocks = re.split(r"^={10,}$", output, flags=re.MULTILINE)
    mine = [block for block in blocks if ("FAIL: " + name + " ") in block
            and re.search(r"^(HazardFailure|AssertionError): ", block, re.MULTILINE)]
    assertion = [line.strip() for block in mine for line in block.splitlines()
                 if re.match(r"(HazardFailure|AssertionError): ", line)]
    return (named[0] if named else ""), ("\n".join(mine) if mine else ""), (assertion[0][:600] if assertion else "")


def write_mutant(scratch, mutant_id):
    out = scratch / f"{mutant_id}.html"
    subprocess.run(["node", str(HELPER), "pre-mutant", str(PAGE), mutant_id, str(out)], cwd=str(ROOT), check=True,
                   capture_output=True, text=True, encoding="utf-8")
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="Where to write the per-mutant JSON summary")
    parser.add_argument("--timeout", type=int, default=600, help="Seconds per child run")
    parser.add_argument("--jobs", type=int, default=2, help="Mutant children at a time")
    parser.add_argument("--anchors-only", action="store_true", help="Write every mutant (no browser) and stop")
    parser.add_argument("only", nargs="*", help="Mutant ids (default: all 37)")
    args = parser.parse_args()
    selected = [m for m in MUTANTS if not args.only or m["id"] in args.only]
    before = hashlib.sha256(PAGE.read_bytes()).hexdigest()
    print("%s sha256 %s" % (PAGE.name, before))
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="pre-mutants-"))
    results = []
    try:
        problems = []
        dom_source = DOM_TEST.read_text(encoding="utf-8")
        for mutant in selected:
            try:
                path = write_mutant(scratch, mutant["id"])
                if path.read_bytes() == PAGE.read_bytes():
                    problems.append("%s changes nothing" % mutant["id"])
            except subprocess.CalledProcessError as error:
                problems.append("%s cannot be written: %s" % (mutant["id"], (error.stderr or "").strip()[-300:]))
            if not mutant["case"].startswith(SPLIT) and ("def %s(" % mutant["case"].split(".")[-1]) not in dom_source:
                problems.append("%s names a case that does not exist: %s" % (mutant["id"], mutant["case"]))
        if problems:
            for problem in problems:
                print("ANCHOR FAILURE:", problem)
            return 1
        if args.anchors_only:
            print("all %d mutants written (no browser run requested)" % len(selected))
            return 0
        cases = sorted({m["case"] for m in selected})
        done, output = run_cases(PAGE, cases, args.timeout * 2)
        ran = re.search(r"Ran (\d+) tests?", output)
        baseline_ok = (done.returncode == 0 and not any(marker in output for marker in CRASH_MARKERS)
                       and bool(ran) and int(ran.group(1)) == len(cases))
        print("BASELINE exit=%d cases=%s ok=%s" % (done.returncode, ran.group(1) if ran else "?", baseline_ok))
        results.append({"id": "BASELINE", "cases": cases, "child_exit": done.returncode,
                        "tests_ran": int(ran.group(1)) if ran else None, "ok": baseline_ok})
        if not baseline_ok:
            print("BASELINE FAILED - refusing to report kills:")
            print(output[-3000:])
            return 1

        def judge(mutant):
            page = scratch / f"{mutant['id']}.html"
            done, output = run_cases(page, [mutant["case"]], args.timeout)
            named, block, assertion = failure_block(output, mutant["case"])
            crashed = any(marker in output for marker in CRASH_MARKERS)
            matched = mutant["expect"] if mutant["expect"] in block else ""
            killed = done.returncode != 0 and bool(named) and bool(assertion) and bool(matched) and not crashed
            return {"id": mutant["id"], "case": mutant["case"], "child_exit": done.returncode, "named_failure": named,
                    "expect": mutant["expect"], "expect_matched": matched, "assertion_text": assertion,
                    "harness_crash": crashed, "killed": killed,
                    "mutant_sha256": hashlib.sha256(page.read_bytes()).hexdigest()}

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            for row in pool.map(judge, selected):
                results.append(row)
                print("%s case=%s exit=%d expect_matched=%s killed=%s" % (row["id"], row["case"], row["child_exit"],
                                                                           bool(row["expect_matched"]), row["killed"]))
                print("      %s" % (row["assertion_text"] or row["named_failure"] or "no failure reported"))
    finally:
        for item in scratch.glob("*.html"):
            item.unlink()
        scratch.rmdir()
    after = hashlib.sha256(PAGE.read_bytes()).hexdigest()
    summary = {"page": str(PAGE), "page_sha256_before": before, "page_sha256_after": after,
               "page_unchanged": before == after, "results": results}
    if args.out:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print("summary written to %s" % out)
    survivors = [row["id"] for row in results if row["id"] != "BASELINE" and not row["killed"]]
    if survivors or before != after:
        print("SURVIVORS: %s" % ", ".join(survivors) if survivors else "the page changed during the run")
        return 1
    print("all %d mutants killed on their own case" % (len(results) - 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
