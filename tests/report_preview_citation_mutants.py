# coding: utf-8
"""TEST-S3-U4-PREVIEW-CITATION-MUTANTS: the browser mutants of the printed citation evidence.

REQ-S3-U4-CITATION-OUTPUT -> RISK-S3-U4-STALE-ANSWER-PRINTED/WRONG-PATIENT-PAPER/FALSE-EMPTY
-> TEST-S3-U4-PREVIEW-CITATION-MUTANTS.

Four of this unit's defects live in report-preview.js's factory, not in its pure functions, so the
only test that can see them is the browser one. A mutant that is merely declared is not a kill
(U2a precedent), so this runner breaks the product on purpose and requires the named case to fail
on an assertion:

  M2w      the answer no longer has to belong to the head being printed -> D6
  M5a      the print-time re-read is dropped                            -> D11
  M5b      the citations await moves after the last guard               -> D9
  M5b-close the guard that only a closed/reopened dialog needs is gone  -> D16
  M6       the editor paper draws a citation state                      -> D7

Rules this runner holds itself to:
  * the source tree is never mutated - every mutant is a COPY in a temp dir, reached through the
    test's KIN_PREVIEW_JS override;
  * each anchor must occur exactly once, or the mutant is a failure, not a survivor;
  * a kill needs a non-zero child exit AND the target case named as FAIL/ERROR with an
    AssertionError AND no harness-start failure - a crash is not a kill;
  * the unmutated copy must first pass through the same override, so a broken override cannot
    manufacture five kills.

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
SOURCE = ROOT / "worklist-v0" / "hpacs-lite" / "report-preview.js"
DOM_TEST = ROOT / "tests" / "report_preview_citation_dom_test.py"
CASE = "ReportPreviewCitationDOMTest"

# Anchors are whole shipped statements: a mutation that no longer applies is a failure here rather
# than a mutant that quietly does nothing.
MUTANTS = [
    {
        "id": "M2w",
        "title": "the citation answer no longer has to belong to this head version",
        "case": "test_a_citation_answer_for_another_version_is_unknown",
        "old": "      return citationAnswerOk(answer, s.data.report.version) ? { state: 'ok', entries: answer.head } : { state: 'unknown', entries: [] };",
        "new": "      return Array.isArray(answer && answer.head) ? { state: 'ok', entries: answer.head } : { state: 'unknown', entries: [] };",
    },
    {
        "id": "M5a",
        "title": "the print-time re-read is dropped and the rendered evidence is trusted",
        "case": "test_print_refuses_when_the_evidence_changed_since_the_render",
        "old": "          const latestCitations = await readCitations(s, signal);",
        "new": "          const latestCitations = ready.citations;",
    },
    {
        "id": "M5b",
        "title": "the citations await moves after the last guard, so a late answer is painted",
        "case": "test_a_late_citation_answer_cannot_overwrite_a_newer_paper",
        "old": "          const citations = await readCitations(s, signal);\n"
               "          check(s); if (selectionEpoch !== s.selectionEpoch) return;",
        "new": "          check(s); if (selectionEpoch !== s.selectionEpoch) return;\n"
               "          const citations = await readCitations(s, signal);",
    },
    {
        "id": "M5b-close",
        "title": "check(s) is removed, so a closed or reopened dialog takes the late answer",
        "case": "test_a_late_citation_answer_cannot_paint_another_patients_paper",
        "old": "          check(s); if (selectionEpoch !== s.selectionEpoch) return;",
        "new": "          if (selectionEpoch !== s.selectionEpoch) return;",
    },
    {
        "id": "M6",
        "title": "the unconfirmed editor paper draws a citation state instead of the notice",
        "case": "test_editor_mode_prints_a_notice_and_never_reads_citations",
        "old": "      if (source.value === 'editor') return { state: 'editor' };",
        "new": "      if (source.value === 'editor') return { state: 'ok', entries: [] };",
    },
]

# A harness that never started reports whatever it touched first; that is not a kill.
CRASH_MARKERS = ("the generated harness did not start", "the shipped preview factory did not load",
                 "the sliced product api() did not define")


def run_case(preview_js, case, timeout):
    """Run one case of the browser test with report-preview.js taken from `preview_js`."""
    environment = dict(os.environ)
    environment["KIN_PREVIEW_JS"] = str(preview_js)
    environment["PYTHONIOENCODING"] = "utf-8"
    target = "%s.%s" % (CASE, case) if case else ""
    command = [sys.executable, "-B", str(DOM_TEST)] + ([target] if target else [])
    done = subprocess.run(command, cwd=str(ROOT), env=environment, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return done, (done.stdout or "") + (done.stderr or "")


def assertion_text(output, case):
    """The first AssertionError line, and the line that names the case as failed."""
    named = [line.strip() for line in output.splitlines()
             if case in line and ("FAIL" in line or "ERROR" in line)]
    failure = [line.strip() for line in output.splitlines() if "AssertionError" in line]
    return named[0] if named else "", failure[0][:400] if failure else ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="Where to write the per-mutant JSON summary")
    parser.add_argument("--timeout", type=int, default=120, help="Seconds per child run")
    parser.add_argument("--anchors-only", action="store_true",
                        help="Check every anchor against the shipped source and stop (no browser)")
    args = parser.parse_args()

    source = SOURCE.read_text(encoding="utf-8")
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    print("report-preview.js sha256 %s" % digest)
    problems = []
    # A case name typo would report a green run of nothing, so it is checked before any browser
    # starts: unittest exits 0 when a selector matches no test only in some versions, and waiting
    # for the hosted run to find out costs a dispatch.
    dom_source = DOM_TEST.read_text(encoding="utf-8")
    for mutant in MUTANTS:
        if ("def %s(" % mutant["case"]) not in dom_source:
            problems.append("%s names a case that does not exist: %s" % (mutant["id"], mutant["case"]))
    for mutant in MUTANTS:
        found = source.count(mutant["old"])
        print("anchor %-10s occurrences=%d" % (mutant["id"], found))
        if found != 1:
            problems.append("%s anchor occurs %d times" % (mutant["id"], found))
        if mutant["new"] in source:
            problems.append("%s mutation is already the shipped text" % mutant["id"])
    if problems:
        for problem in problems:
            print("ANCHOR FAILURE:", problem)
        return 1
    if args.anchors_only:
        print("anchors ok (no browser run requested)")
        return 0

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="u4-mutants-"))
    results = []
    try:
        # The control: the unmutated copy, through the same override. Without this a broken
        # override would report five kills that are really five harness failures.
        baseline_copy = scratch / "baseline.js"
        shutil.copyfile(SOURCE, baseline_copy)
        done, output = run_case(baseline_copy, None, args.timeout)
        baseline_ok = done.returncode == 0 and not any(marker in output for marker in CRASH_MARKERS)
        ran = re.search(r"Ran (\d+) tests", output)
        print("BASELINE through the override: exit=%d ran=%s" % (done.returncode, ran.group(1) if ran else "?"))
        results.append({"id": "BASELINE", "case": "all", "child_exit": done.returncode,
                        "tests_ran": int(ran.group(1)) if ran else None, "ok": baseline_ok})
        if not baseline_ok:
            print("BASELINE FAILED - refusing to report kills:")
            print(output[-2000:])
            return 1

        for mutant in MUTANTS:
            copy = scratch / ("%s.js" % mutant["id"])
            copy.write_text(source.replace(mutant["old"], mutant["new"]), encoding="utf-8")
            assert copy.read_text(encoding="utf-8") != source, mutant["id"]
            done, output = run_case(copy, mutant["case"], args.timeout)
            named, failure = assertion_text(output, mutant["case"])
            crashed = any(marker in output for marker in CRASH_MARKERS)
            killed = done.returncode != 0 and bool(named) and bool(failure) and not crashed
            print("%-10s case=%s exit=%d killed=%s" % (mutant["id"], mutant["case"], done.returncode, killed))
            print("           %s" % (failure or named or output.strip().splitlines()[-1:] or ""))
            results.append({"id": mutant["id"], "title": mutant["title"], "case": mutant["case"],
                            "child_exit": done.returncode, "named_failure": named,
                            "assertion_text": failure, "harness_crash": crashed, "killed": killed,
                            "mutant_sha256": hashlib.sha256(copy.read_bytes()).hexdigest()})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    after = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    print("report-preview.js sha256 after %s (unchanged=%s)" % (after, after == digest))
    summary = {"source_sha256_before": digest, "source_sha256_after": after,
               "source_unchanged": after == digest, "results": results}
    if args.out:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print("summary written to %s" % out)
    survivors = [r["id"] for r in results if r.get("id") != "BASELINE" and not r["killed"]]
    if survivors or after != digest:
        print("SURVIVORS:", survivors, "source_unchanged:", after == digest)
        return 1
    print("all %d browser mutants killed" % len(MUTANTS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
