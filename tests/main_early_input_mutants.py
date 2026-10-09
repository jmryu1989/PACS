# coding: utf-8
"""REQ-S9-U0a-PRE-ORDER -> RISK-EARLY-TDZ / RISK-REGISTRATION-ORDER / RISK-REGISTRATION-DUPLICATE
-> TEST-PRE-MUTANTS: the 37 mutants of the PRE design, each killed by its own case of main_early_input_dom_test.py.

  M01..M35  one declaration PRE moved ahead of its first caller goes back to its f1d5406 place (a split declarator
            back into its multi-declaration), every other one stays where PRE put it
  M36       the boot Retry click registers a second Quick Match closure of the same behaviour
  M37       the dictation edit notice is registered after the citation input listener of the same textareas

The mutants are written by main_split_harness.cjs from the page under test (main.html, or KIN_PRE_PAGE) into scratch
copies that main_early_input_dom_test.py loads through KIN_PRE_PAGE/KIN_PRE_SPEC; nothing in the source tree is
mutated. A declaration mutant's case is bound to the layout the browser is given: `mutant-layout` writes the mutant,
its derived spec and its 45-part layout and names the part that holds the restored statement; the case
(MutantBoundary, KIN_PRE_BOUNDARY) holds exactly that part, checks the moment - that part waits and has not run, the
consumer's listeners are registered, the restored binding is absent - and then gives the hazard's input (or leaves).
M26's consumer is a statement of the page's own load (the storage read that assigns userFilters), so the unsplit page
is its layout: the driver checks there that the read precedes the restored declaration, and the unsplit control kills
it. M36/M37 change registrations, not declarations, and have their registration cases.

Rules this runner holds itself to (as the S3 mutant runners do):
  * the unmutated page must first pass every case through the same override (the boundary cases with the binding
    present), or no kill is reported;
  * a kill needs a non-zero child exit AND the case reported as FAIL (never ERROR) AND an AssertionError (the
    suite's HazardFailure is one) AND that mutant's own expect text inside that case's failure block AND no harness
    crash AND no failed precondition - an import, fixture or precondition failure is not a kill;
  * the source hash is written to the summary before and after.

stdlib only; it launches the browser test as a child process (one per mutant) and never drives a browser itself.
--anchors-only writes every mutant and its layout (no browser) and stops.
"""
import argparse
import concurrent.futures
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
PAGE = pathlib.Path(os.environ.get("KIN_PRE_PAGE", ROOT / "worklist-v0" / "hpacs-lite" / "main.html"))
HELPER = ROOT / "tests" / "main_split_harness.cjs"
DOM_TEST = ROOT / "tests" / "main_early_input_dom_test.py"
CRASH_MARKERS = ("playwright._impl._errors", "ModuleNotFoundError")
PRECONDITION = "PRECONDITION "

# The hazard that reaches each restored declaration (the consumer), and the mutant's own failure text: its binding,
# or the user result for the saved-search chips and the two registration mutants. `hazard` names a
# main_early_input_dom_test HAZARDS input or a leaving (LEAVE_CONSUMERS); `case` a named case of that suite.
LEAVE = "leave:B1-15/41"
MUTANTS = [
    {"id": "M01", "hazard": "B1-03", "expect": "ReferenceError: selectionSeq is not defined"},
    {"id": "M02", "hazard": "B1-05", "expect": "ReferenceError: studies is not defined"},
    {"id": "M03", "hazard": "B1-05", "expect": "ReferenceError: selectedUid is not defined"},
    {"id": "M04", "hazard": "B1-05", "expect": "ReferenceError: cur is not defined"},
    {"id": "M05", "hazard": "B1-05", "expect": "ReferenceError: RFIELDS is not defined"},
    {"id": "M06", "hazard": "B1-05", "expect": "ReferenceError: reportWriteBlock is not defined"},
    {"id": "M07", "hazard": "B1-05-TAB", "expect": "ReferenceError: editReport is not defined"},
    {"id": "M08", "hazard": LEAVE, "expect": "ReferenceError: relatedModalities is not defined"},
    {"id": "M09", "hazard": LEAVE, "expect": "ReferenceError: relatedPageQuery is not defined"},
    {"id": "M10", "hazard": LEAVE, "expect": "ReferenceError: renderRelated is not defined"},
    {"id": "M11", "hazard": LEAVE, "expect": "ReferenceError: savedFilterDays is not defined"},
    {"id": "M12", "hazard": LEAVE, "expect": "ReferenceError: filteredFor is not defined"},
    {"id": "M13", "hazard": LEAVE, "expect": "ReferenceError: consultationFilter is not defined"},
    {"id": "M14", "hazard": LEAVE, "expect": "ReferenceError: searchCriteria is not defined"},
    {"id": "M15", "hazard": LEAVE, "expect": "ReferenceError: filtered is not defined"},
    {"id": "M16", "hazard": LEAVE, "expect": "ReferenceError: orderedStudies is not defined"},
    {"id": "M17", "hazard": LEAVE, "expect": "ReferenceError: resultQuery is not defined"},
    {"id": "M18", "hazard": LEAVE, "expect": "ReferenceError: render is not defined"},
    {"id": "M19", "hazard": LEAVE, "expect": "ReferenceError: relatedStudy is not defined"},
    {"id": "M20", "hazard": LEAVE, "expect": "ReferenceError: viewed is not defined"},
    {"id": "M21", "hazard": LEAVE, "expect": "ReferenceError: renderStudyIdentity is not defined"},
    {"id": "M22", "hazard": LEAVE, "expect": "ReferenceError: renderDraftHint is not defined"},
    {"id": "M23", "hazard": LEAVE, "expect": "ReferenceError: heldByOther is not defined"},
    {"id": "M24", "hazard": LEAVE, "expect": "ReferenceError: updateReportButtons is not defined"},
    {"id": "M25", "hazard": "B1-58", "expect": "'chips': 'SYN Local Search (0)'"},
    {"id": "M26", "case": "UnsplitControl.test_B1_58_unsplit", "expect": "'chips': 'SYN Local Search (0)'",
     "load_consumer": 582},   # f1d5406 statement: the storage read that assigns userFilters while the page loads
    {"id": "M27", "hazard": "B1-58", "expect": "'chips': 'SYN Local Search (0)'"},
    {"id": "M28", "hazard": LEAVE, "expect": "ReferenceError: activeFilterName is not defined"},
    {"id": "M29", "hazard": "B1-58", "expect": "ReferenceError: renderActiveFilter is not defined"},
    {"id": "M30", "hazard": "B1-58", "expect": "ReferenceError: renderChips is not defined"},
    {"id": "M31", "hazard": "leave:B1-57", "expect": "ReferenceError: layoutMode is not defined"},
    {"id": "M32", "hazard": "leave:B1-57", "expect": "ReferenceError: workspaceState is not defined"},
    {"id": "M33", "hazard": "leave:B1-57", "expect": "ReferenceError: portraitLayout is not defined"},
    {"id": "M34", "hazard": "leave:B1-57", "expect": "ReferenceError: workspaceAxis is not defined"},
    {"id": "M35", "hazard": "leave:B1-57", "expect": "ReferenceError: applyLayout is not defined"},
    {"id": "M36", "case": "Registration.test_after_retry_one_quick_match_change_has_one_effect",
     "expect": "the listeners one Quick Match change reaches after Retry"},
    {"id": "M37", "case": "Registration.test_a_report_field_input_reaches_its_listeners_in_the_original_order",
     "expect": "the (target, event, listener) invocation order of one focus/keypress"},
]


def node(*args):
    return json.loads(subprocess.run(["node", str(HELPER), *map(str, args)], cwd=str(ROOT), check=True,
                                     capture_output=True, text=True, encoding="utf-8").stdout)


def run_cases(page, cases, timeout, boundary=(), spec=None):
    environment = dict(os.environ, KIN_PRE_PAGE=str(page), PYTHONIOENCODING="utf-8")
    for key in ("KIN_PRE_SPEC", "KIN_PRE_TRACE_DIR", "KIN_PRE_BOUNDARY"):
        environment.pop(key, None)
    if boundary:
        environment["KIN_PRE_BOUNDARY"] = json.dumps(list(boundary))
    if spec:
        environment["KIN_PRE_SPEC"] = str(spec)
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


def prepare(scratch, mutant):
    """The mutant page and, for a declaration mutant, the boundary case bound to its delivered 45-part layout."""
    layout = node("mutant-layout", PAGE, mutant["id"], scratch / mutant["id"])
    mutant = dict(mutant, page=layout["page"], spec=layout["spec"], restored=layout["restored"])
    if "hazard" in mutant:
        part = layout["part"]
        name = "%s_%s_hold_%s" % (mutant["id"], re.sub(r"[^A-Za-z0-9]+", "_", mutant["hazard"]).strip("_"),
                                  re.sub(r"[^A-Za-z0-9]+", "_", part["file"]).strip("_"))
        mutant["boundary"] = {"name": name, "hazard": mutant["hazard"], "count": part["count"], "hold": part["file"],
                              "statement": part["index"], "bindings": layout["restored"]["bindings"], "binding": "absent"}
        mutant["case"] = "MutantBoundary.test_" + name
        mutant["layout"] = {"module": part["module"], "file": part["file"], "statement": part["name"]}
    if "load_consumer" in mutant:
        # The unsplit page is this mutant's layout: the load-time consumer has to run before the restored declaration.
        where = node("locate", layout["page"], mutant["load_consumer"], layout["restored"]["f1d5406"])
        consumer, declaration = where[str(mutant["load_consumer"])], where[str(layout["restored"]["f1d5406"])]
        mutant["layout"] = {"count": 0, "consumer_statement": consumer, "declaration_statement": declaration,
                            "consumer_first": 0 <= consumer < declaration}
    return mutant


def baseline_cases(prepared):
    """The same cases on the unmutated page: each boundary with its binding present, and the named cases."""
    boundary, by_moment = [], {}
    for mutant in prepared:
        if "boundary" not in mutant:
            continue
        b = mutant["boundary"]
        key = (b["hazard"], b["hold"])
        if key not in by_moment:
            name = "BASE_%s_hold_%s" % (re.sub(r"[^A-Za-z0-9]+", "_", b["hazard"]).strip("_"),
                                        re.sub(r"[^A-Za-z0-9]+", "_", b["hold"]).strip("_"))
            by_moment[key] = dict(b, name=name, statement=None, bindings=[], binding="present")
            boundary.append(by_moment[key])
        # One unmutated case per moment: every binding its mutants restore there is present on the unmutated page.
        by_moment[key]["bindings"] += [n for n in b["bindings"] if n not in by_moment[key]["bindings"]]
    named = sorted({m["case"] for m in prepared if "boundary" not in m})
    return boundary, ["MutantBoundary.test_" + b["name"] for b in boundary] + named


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="Where to write the per-mutant JSON summary")
    parser.add_argument("--timeout", type=int, default=600, help="Seconds per child run")
    parser.add_argument("--jobs", type=int, default=2, help="Mutant children at a time")
    parser.add_argument("--anchors-only", action="store_true", help="Write every mutant and its layout (no browser) and stop")
    parser.add_argument("only", nargs="*", help="Mutant ids (default: all 37)")
    args = parser.parse_args()
    selected = [m for m in MUTANTS if not args.only or m["id"] in args.only]
    before = hashlib.sha256(PAGE.read_bytes()).hexdigest()
    print("%s sha256 %s" % (PAGE.name, before))
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="kin-pre-split-mutants-"))
    results = []
    try:
        problems, prepared = [], []
        dom_source = DOM_TEST.read_text(encoding="utf-8")
        for mutant in selected:
            try:
                ready = prepare(scratch, mutant)
                prepared.append(ready)
                if pathlib.Path(ready["page"]).read_bytes() == PAGE.read_bytes():
                    problems.append("%s changes nothing" % mutant["id"])
                if "load_consumer" in ready and not ready["layout"]["consumer_first"]:
                    problems.append("%s: the load-time consumer does not precede the declaration %s" % (mutant["id"], ready["layout"]))
            except subprocess.CalledProcessError as error:
                problems.append("%s cannot be written: %s" % (mutant["id"], (error.stderr or "").strip()[-300:]))
                continue
            if "boundary" not in ready and ("def %s(" % ready["case"].split(".")[-1]) not in dom_source:
                problems.append("%s names a case that does not exist: %s" % (mutant["id"], ready["case"]))
        if problems:
            for problem in problems:
                print("ANCHOR FAILURE:", problem)
            return 1
        for mutant in prepared:
            print("%s case=%s layout=%s" % (mutant["id"], mutant["case"], json.dumps(mutant.get("layout"))))
        if args.anchors_only:
            print("all %d mutants and layouts written (no browser run requested)" % len(prepared))
            return 0
        boundary, cases = baseline_cases(prepared)
        done, output = run_cases(PAGE, cases, args.timeout * 4, boundary=boundary)
        ran = re.search(r"Ran (\d+) tests?", output)
        baseline_ok = (done.returncode == 0 and not any(marker in output for marker in CRASH_MARKERS)
                       and bool(ran) and int(ran.group(1)) == len(cases))
        print("BASELINE exit=%d cases=%s/%d ok=%s" % (done.returncode, ran.group(1) if ran else "?", len(cases), baseline_ok))
        results.append({"id": "BASELINE", "cases": cases, "boundary": boundary, "child_exit": done.returncode,
                        "tests_ran": int(ran.group(1)) if ran else None, "ok": baseline_ok})
        if not baseline_ok:
            print("BASELINE FAILED - refusing to report kills:")
            print(output[-4000:])
            return 1

        def judge(mutant):
            page = pathlib.Path(mutant["page"])
            boundary = [mutant["boundary"]] if "boundary" in mutant else ()
            done, output = run_cases(page, [mutant["case"]], args.timeout, boundary=boundary,
                                     spec=mutant["spec"] if boundary else None)
            named, block, assertion = failure_block(output, mutant["case"])
            crashed = any(marker in output for marker in CRASH_MARKERS)
            precondition = PRECONDITION in block
            matched = mutant["expect"] if mutant["expect"] in block else ""
            killed = (done.returncode != 0 and bool(named) and bool(assertion) and bool(matched) and not crashed
                      and not precondition)
            return {"id": mutant["id"], "case": mutant["case"], "layout": mutant.get("layout"),
                    "boundary": mutant.get("boundary"), "child_exit": done.returncode, "named_failure": named,
                    "expect": mutant["expect"], "expect_matched": matched, "assertion_text": assertion,
                    "precondition_failed": precondition, "harness_crash": crashed, "killed": killed,
                    "mutant_sha256": hashlib.sha256(page.read_bytes()).hexdigest()}

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            for row in pool.map(judge, prepared):
                results.append(row)
                print("%s case=%s exit=%d expect_matched=%s precondition_failed=%s killed=%s" % (
                    row["id"], row["case"], row["child_exit"], bool(row["expect_matched"]), row["precondition_failed"],
                    row["killed"]))
                print("      %s" % (row["assertion_text"] or row["named_failure"] or "no failure reported"))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
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
