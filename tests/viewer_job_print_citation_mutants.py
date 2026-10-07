# coding: utf-8
"""TEST-S3-U5-JOB-PRINT-CITATION-MUTANTS: mutants of the job print citation evidence.

REQ-S3-U5-JOB-PRINT-CITATION -> RISK-S3-U5-PANEL-TEARDOWN / CROSS-STUDY-EVIDENCE /
STALE-EVIDENCE-PRINTED / FALSE-EMPTY / EVIDENCE-LESS-PAGE -> TEST-S3-U5-JOB-PRINT-CITATION-MUTANTS.

The print projection defects are exercised in the browser factory. The plain-refusal
boundary now lives in viewer-jobs.js and is exercised by its mounted-panel Node test.
A mutant that is merely declared is not a kill (U2a precedent): each copied product
must fail on the named behaviour assertion, using unittest or Node's JUnit result.

  MJ1  a plain 403 ends the Job panel               -> Job plain-failure/retry case
  MJ2  every entry is read with the current uid     -> D3   one study's evidence on another's page
  MJ3  the projection becomes non-enumerable        -> D12  equal() goes blind, stale evidence prints
  MJ4  the answer no longer has to be this version  -> D10  another version's citations printed
  MJ5  the per-entry catch stops catching           -> D5   one failed read blanks the whole output
  MJ6  the editor branch stops applying             -> D6   an unconfirmed draft draws a citation state
  MJ7  the answer's draft is kept in the projection -> D13  a draft-only change refuses the print

Rules this runner holds itself to, and how it differs from the U4 runner it is modelled on:
  * the source tree is never mutated - every mutant is a COPY in a temp dir, reached through
    the tests' KIN_JOB_PRINT_JS / KIN_VIEWER_JOBS_JS overrides;
  * each anchor must occur exactly once, or the mutant is a failure, not a survivor;
  * a kill needs a non-zero child exit AND the target case's assertion failure (never a runtime error) AND
    an AssertionError AND **the mutant's own `expect` text inside that failure** AND no
    harness-start failure. The U4 rule accepted ANY AssertionError, so a mutant that broke
    the case for an unrelated reason still counted (D-N1); here it does not. A crash or a
    tearDown error is never a kill;
  * the crash markers stay narrow (see CRASH_MARKERS): a marker that also appears in an
    ordinary failing run turns every real kill into a survivor;
  * both unmutated copies must first pass through the same overrides, so a broken override
    cannot manufacture seven kills;
  * `expect` is an assertion MESSAGE, never a serialized document: a long HTML dump is
    truncated by the reporter and drifts with any wording change.

Python stdlib only; child tests require Playwright and Node. It never drives a browser itself.
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
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-job-print.js"
JOBS_SOURCE = SOURCE.with_name("viewer-jobs.js")
JOBS_TEST = ROOT / "tests" / "viewer_jobs_session_test.cjs"
DOM_TEST = ROOT / "tests" / "viewer_job_print_citation_dom_test.py"
CASE = "ViewerJobPrintCitationDOM"

# Harness-start failures only. A bare "Traceback (most recent call last)" MUST NOT be here:
# unittest prints that line for every ordinary assertion failure, so it would mark each genuine
# kill as a crash and report all seven mutants as survivors. The U4 runner this is modelled on
# used harness-start strings only, which is why it passed hosted; the U5 tightening over-reached
# and the fixed-code review reproduced the consequence host-pure.
#
# Narrow on purpose: a marker that can appear in a normal failing run silently disables every
# kill. A Playwright timeout or browser crash still carries playwright._impl._errors, so
# timeouts remain non-kills, and a missing dependency still carries ModuleNotFoundError.
CRASH_MARKERS = (
    "playwright._impl._errors",
    "ModuleNotFoundError",
    "ReferenceError:",
    "SyntaxError:",
)

# Anchors are whole shipped statements: a mutation that no longer applies is a failure here
# rather than a mutant that quietly does nothing.
MUTANTS = [
    {
        "id": "MJ1",
        "title": "a plain 403 without an auth code ends the viewer panel",
        "case": "U5 Job: plain failures, including dropped answers, do not end the document and retry works",
        "expect": "a plain refusal must not end the viewer panel",
        "old": "        if (window.KinSessionTransport.refusal(r)) throw window.KinSessionTransport.responseError(r);",
        "new": "        if (r.status === 403 && !r.headers.get('X-KIN-Auth-Code')) end();\n"
               "        if (window.KinSessionTransport.refusal(r)) throw window.KinSessionTransport.responseError(r);",
    },
    {
        "id": "MJ2",
        "title": "every entry is read with the current study's uid instead of its own",
        "case": "test_03_both_keeps_each_studys_evidence_on_its_own_page",
        "expect": "each report page must carry its own study's evidence",
        "old": "          answer = await api('/studies/' + target.uid + '/report/citations', { signal });",
        "new": "          answer = await api('/studies/' + item.uid + '/report/citations', { signal });",
    },
    {
        "id": "MJ3",
        # The naive form ('keep it in a local variable') also stops html() from drawing the
        # lines, so D12 would fail for the wrong reason and still be counted. A non-enumerable
        # property leaves the render untouched and blinds only JSON.stringify, which is
        # exactly - and only - the property this unit relies on.
        "title": "the projection is attached non-enumerably, so only equal() stops seeing it",
        "case": "test_12_print_refuses_when_the_evidence_changed_since_the_render",
        "expect": "a changed head must refuse the print",
        "old": "        entries[index].citations = paper.citationAnswerOk(answer, entries[index].report.version)\n"
               "          ? { state: 'ok', entries: answer.head, actor } : { state: 'unknown', entries: [], actor };",
        "new": "        Object.defineProperty(entries[index], 'citations', { configurable: true, writable: true,\n"
               "          enumerable: false, value: paper.citationAnswerOk(answer, entries[index].report.version)\n"
               "            ? { state: 'ok', entries: answer.head, actor } : { state: 'unknown', entries: [], actor } });",
    },
    {
        "id": "MJ4",
        "title": "the answer no longer has to belong to the version being printed",
        "case": "test_10_an_answer_for_another_version_is_unknown",
        "expect": "an answer for another version must not be printed",
        "old": "        entries[index].citations = paper.citationAnswerOk(answer, entries[index].report.version)",
        "new": "        entries[index].citations = Array.isArray(answer && answer.head)",
    },
    {
        "id": "MJ5",
        "title": "the per-entry catch rethrows everything, so one failed read blanks the output",
        "case": "test_05_a_failed_read_loses_only_its_own_section",
        "expect": "one failed citation read must not blank the whole output",
        "old": "          const terminal = identity.citationTerminal({ aborted: signal.aborted, live: live(), status: error?.status, code: error?.code });",
        "new": "          const terminal = 'rethrow';",
    },
    {
        "id": "MJ6",
        "title": "the editor branch stops applying, so an unsaved draft is given a citation state",
        "case": "test_06_editor_mode_prints_a_notice_and_never_reads_citations",
        "expect": "an unconfirmed draft must print the notice and nothing else",
        "old": "        if (target.mode === 'editor') { entries[index].citations = { state: 'editor' }; continue; }",
        "new": "        if (false) { entries[index].citations = { state: 'editor' }; continue; }",
    },
    {
        "id": "MJ7",
        "title": "the answer's draft array is kept in the compared projection",
        "case": "test_13_a_draft_only_change_does_not_refuse_the_print",
        "expect": "draft-only change must not refuse the print",
        "old": "          ? { state: 'ok', entries: answer.head, actor } : { state: 'unknown', entries: [], actor };",
        "new": "          ? { state: 'ok', entries: answer.head, actor, draft: answer.draft } : { state: 'unknown', entries: [], actor };",
    },
]


def run_case(module_js, case, timeout, jobs=False):
    """Run the real consumer through a copied source, with no product test hooks."""
    environment = dict(os.environ)
    environment["KIN_VIEWER_JOBS_JS" if jobs else "KIN_JOB_PRINT_JS"] = str(module_js)
    environment["PYTHONIOENCODING"] = "utf-8"
    target = "%s.%s" % (CASE, case) if case else ""
    command = [sys.executable, "-B", str(DOM_TEST)] + ([target] if target else [])
    if jobs:
        command = ["node", "--test", "--test-reporter=junit"]
        if case:
            command += ["--test-name-pattern=^" + re.escape(case) + "$"]
        command += [str(JOBS_TEST)]
    done = subprocess.run(command, cwd=str(ROOT), env=environment, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return done, (done.stdout or "") + (done.stderr or "")


def failure_block(output, case):
    """The named failure line and the whole traceback block that belongs to that case.

    The `expect` text is an assertion message, which unittest prints on the AssertionError
    line; reading the whole block rather than one line keeps a multi-line diff readable and
    lets the message be found wherever the reporter placed it.
    """
    # FAIL only. An ERROR names an exception, not the assertion the mutant is about, and that
    # is the U4 tearDown hole: a case that raises after its assertions would otherwise be
    # adjudicated on whatever AssertionError happened to be in the output.
    named = [line.strip() for line in output.splitlines()
             if case in line and "FAIL" in line and "ERROR" not in line]
    blocks = re.split(r"^={10,}$", output, flags=re.MULTILINE)
    mine = [block for block in blocks if case in block and "AssertionError" in block]
    assertion = [line.strip() for line in output.splitlines() if "AssertionError" in line]
    return named[0] if named else "", ("\n".join(mine) if mine else ""), (assertion[0][:400] if assertion else "")


def jobs_failure(output, case):
    """Node's JUnit reporter identifies the exact testcase and assertion error."""
    root = ET.fromstring(output)
    failures = [failure for test in root.iter("testcase") if test.get("name") == case
                for failure in test.findall("failure")]
    if len(failures) != 1:
        return "", "", ""
    failure = failures[0]
    block = "".join(failure.itertext())
    if failure.get("type") != "testCodeFailure" or "cause: AssertionError [ERR_ASSERTION]:" not in block:
        return "", block, ""
    return case + " FAIL", block, failure.get("message", "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="Where to write the per-mutant JSON summary")
    parser.add_argument("--timeout", type=int, default=180, help="Seconds per child run")
    parser.add_argument("--anchors-only", action="store_true",
                        help="Check every anchor and case name against the shipped sources and stop (no browser)")
    args = parser.parse_args()

    paths = {"print": SOURCE, "jobs": JOBS_SOURCE}
    sources = {key: path.read_text(encoding="utf-8") for key, path in paths.items()}
    digest = {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in paths.items()}
    print("source sha256 %s" % digest)
    problems = []
    # A case-name typo would report a green run of nothing, and an `expect` that is not in the
    # test would make every kill unreachable. Both are checked before any browser starts:
    # waiting for the hosted run to find out costs a dispatch.
    dom_source = DOM_TEST.read_text(encoding="utf-8")
    for mutant in MUTANTS:
        test_source = JOBS_TEST.read_text(encoding="utf-8") if mutant["id"] == "MJ1" else dom_source
        declaration = "test('%s'," if mutant["id"] == "MJ1" else "def %s("
        if (declaration % mutant["case"]) not in test_source:
            problems.append("%s names a case that does not exist: %s" % (mutant["id"], mutant["case"]))
        if mutant["expect"] not in test_source:
            problems.append("%s expects a message no assertion carries: %s" % (mutant["id"], mutant["expect"]))
    for mutant in MUTANTS:
        source = sources["jobs" if mutant["id"] == "MJ1" else "print"]
        found = source.count(mutant["old"])
        print("anchor %-5s occurrences=%d expect=%r" % (mutant["id"], found, mutant["expect"]))
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

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="u5-mutants-"))
    results = []
    try:
        # The control: the unmutated copy, through the same override. Without this a broken
        # override would report seven kills that are really seven harness failures.
        for key, path in paths.items():
            baseline_copy = scratch / ("baseline-%s.js" % key)
            shutil.copyfile(path, baseline_copy)
            done, output = run_case(baseline_copy, None, args.timeout, jobs=key == "jobs")
            baseline_ok = done.returncode == 0 and not any(marker in output for marker in CRASH_MARKERS)
            ran = re.search(r"Ran (\d+) tests?", output)
            count = len(list(ET.fromstring(output).iter("testcase"))) if key == "jobs" else int(ran.group(1)) if ran else 0
            baseline_ok = baseline_ok and count > 0
            print("BASELINE %s exit=%d tests=%d ok=%s" % (key, done.returncode, count, baseline_ok))
            results.append({"id": "BASELINE", "file": key, "case": "all", "child_exit": done.returncode,
                            "tests_ran": count, "ok": baseline_ok})
            if args.out:
                log = pathlib.Path(args.out).with_name("baseline-%s.log" % key)
                log.parent.mkdir(parents=True, exist_ok=True)
                log.write_text(output, encoding="utf-8")
            if not baseline_ok:
                print("BASELINE FAILED - refusing to report kills:")
                print(output[-2000:])
                return 1

        for mutant in MUTANTS:
            jobs = mutant["id"] == "MJ1"
            source = sources["jobs" if jobs else "print"]
            copy = scratch / ("%s.js" % mutant["id"])
            copy.write_text(source.replace(mutant["old"], mutant["new"]), encoding="utf-8")
            if copy.read_text(encoding="utf-8") == source:
                raise AssertionError(mutant["id"])
            done, output = run_case(copy, mutant["case"], args.timeout, jobs=jobs)
            if args.out:
                pathlib.Path(args.out).with_name(mutant["id"] + ".log").write_text(output, encoding="utf-8")
            named, block, assertion = (jobs_failure if jobs else failure_block)(output, mutant["case"])
            crashed = any(marker in output for marker in CRASH_MARKERS)
            matched = mutant["expect"] if mutant["expect"] in block else ""
            killed = (done.returncode != 0 and bool(named) and bool(assertion)
                      and bool(matched) and not crashed)
            print("%-5s case=%s exit=%d expect_matched=%s killed=%s"
                  % (mutant["id"], mutant["case"], done.returncode, bool(matched), killed))
            print("      %s" % (assertion or named or "no failure reported"))
            results.append({"id": mutant["id"], "title": mutant["title"], "case": mutant["case"],
                            "child_exit": done.returncode, "named_failure": named,
                            "expect": mutant["expect"], "expect_matched": matched,
                            "assertion_text": assertion, "harness_crash": crashed, "killed": killed,
                            "mutant_sha256": hashlib.sha256(copy.read_bytes()).hexdigest()})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    after = {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in paths.items()}
    print("source sha256 after %s (unchanged=%s)" % (after, after == digest))
    summary = {"source_sha256_before": digest, "source_sha256_after": after,
               "source_unchanged": after == digest, "results": results}
    if args.out:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print("summary written to %s" % out)
    survivors = [row for row in results if row["id"] != "BASELINE" and not row["killed"]]
    if survivors:
        print("SURVIVORS: %s" % ", ".join(row["id"] for row in survivors))
        return 1
    if after != digest:
        print("SOURCE CHANGED - refusing to report a clean run")
        return 1
    print("all %d mutants killed on their own assertion" % len(MUTANTS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
