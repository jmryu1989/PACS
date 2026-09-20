# coding: utf-8
"""TEST-S3-U5b-HISTORY-CITATION-MUTANTS: the browser mutants of the report-history citation block.

REQ-S3-U5b-HISTORY-CITATION -> RISK-S3-U5b-WRONG-BODY / FALSE-EMPTY / CROSS-VERSION /
SURVIVING-AFTER-CLOSE / WRONG-ATTRIBUTION / SILENT-COUNT-LOSS -> TEST-S3-U5b-HISTORY-CITATION-MUTANTS.

Every defect this unit can have lives in the browser block, not in a pure function, so the DOM
test is the only thing that can see it. A declared mutant is not a kill (U2a precedent): this
runner breaks the shipped main.html on purpose and requires the named case to fail on THE
assertion that mutant is about.

  MH1  the answer no longer has to be this version   -> H6  another version's citations drawn
  MH2  the screen recomputes presence locally        -> H5  the server's per-version answer lost
  MH3  a refusal is rendered as a citation list      -> H3  "no citations" for a refusal
  MH4  one shared host instead of the pressed one    -> H8  one version's evidence under another
  MH5  closing no longer discards the drawn blocks   -> H9  revoked content survives in the DOM
  MH6  the attribution names the session, not the    -> H1  the paper says the wrong reader
       server-echoed actor
  MH7  the per-entry shape check is dropped          -> H6  a malformed entry vanishes silently

Rules, inherited from the U5 runner this is modelled on:
  * the source tree is never mutated - every mutant is a COPY reached through the DOM test's
    KIN_HISTORY_CITATION_MAIN override, and the unmutated BASELINE goes through the same
    override first, so a broken override cannot manufacture seven kills;
  * each anchor must occur exactly once, and the two harness slice markers are checked the same
    way: a marker that drifted would make the harness compile something else;
  * a kill needs a non-zero child exit AND the target case named FAIL (never ERROR) AND an
    AssertionError AND **the mutant's own `expect` message inside that failure** AND no
    harness-start failure. A crash or a tearDown error is never a kill;
  * `expect` is an assertion MESSAGE that exists verbatim in the DOM test, and all seven differ:
    product wording would match any unrelated failure of the same case (the 'unknown' wording is
    a prefix of the 'refused' wording and is expected by several cases at once).

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
SOURCE = ROOT / "worklist-v0" / "hpacs-lite" / "main.html"
DOM_TEST = ROOT / "tests" / "report_version_citation_dom_test.py"
CASE = "ReportVersionCitationDOM"

# The two markers the DOM harness slices the shipped history block between. They are checked here
# for the same reason the anchors are: if either drifts, the harness silently compiles a different
# region and every mutant reports a survivor.
SLICE_MARKERS = (
    "    // ── 판독문 이력 ──",
    "    /**\n     * 판독문 textarea를 **스크립트로**",
)

# Harness-start failures only. A bare "Traceback (most recent call last)" MUST NOT be here:
# unittest prints it for every ordinary assertion failure, which would turn each genuine kill
# into a reported crash.
CRASH_MARKERS = (
    "playwright._impl._errors",
    "ModuleNotFoundError",
)

MUTANTS = [
    {
        "id": "MH1",
        "title": "the answer no longer has to belong to the version that was pressed",
        "case": "test_06_every_shape_the_answer_can_fail_is_unknown_and_never_empty",
        "expect": "an answer for another version must make the whole answer unknown",
        "old": "      if (!Number.isSafeInteger(answer.version) || answer.version !== version) return false;",
        "new": "      if (false) return false;",
    },
    {
        "id": "MH2",
        # The shipped presenceOf treats an entry without insertedText as reduced and answers null,
        # so the state text disappears: the screen stops speaking the server's per-row answer.
        "title": "the screen recomputes presence with the shipped rule instead of the server's answer",
        "case": "test_05_each_block_speaks_the_presence_of_its_own_version",
        "expect": "each block must speak the server presence for its own version",
        "old": "          presenceOf: e => (!e || e.state === \"source-unavailable\") ? null : e.presence } });",
        "new": "          presenceOf: citation.presenceOf } });",
    },
    {
        "id": "MH3",
        "title": "a refusal is given the success state, so it renders as an empty citation list",
        "case": "test_03_a_refusal_is_not_an_empty_list",
        "expect": "a refusal must never read as an empty citation list",
        "old": "        state = e?.status === 403 ? \"refused\" : \"unknown\";",
        "new": "        state = \"ok\";",
    },
    {
        "id": "MH4",
        "title": "every answer is written into the first host instead of the pressed version's",
        "case": "test_08_two_answers_arriving_out_of_order_stay_in_their_own_blocks",
        "expect": "each version block must show its own answer",
        "old": "      host.replaceChildren(box);",
        "new": "      document.querySelector(\".vcite-host\").replaceChildren(box);",
    },
    {
        "id": "MH5",
        # Reverting the close listener to the shipped-before-U5b arrow: the modal hides, but the
        # drawn blocks and the per-version state stay in the DOM.
        "title": "closing the history no longer discards the drawn blocks and the per-version state",
        "case": "test_09_closing_discards_the_blocks_and_no_late_answer_writes",
        "expect": "closing the history must discard every drawn citation block",
        "old": "    $(\"#hist-close\").addEventListener(\"click\", closeHistory);",
        "new": "    $(\"#hist-close\").addEventListener(\"click\", () => $(\"#histmodal\").classList.remove(\"show\"));",
    },
    {
        "id": "MH6",
        "title": "the attribution line is built from the session instead of the server-echoed actor",
        "case": "test_01_a_pressed_version_draws_its_own_entries_and_the_server_actor",
        "expect": "the attribution line must name the server-echoed actor",
        "old": "        actor: answer ? answer.actor : null,",
        "new": "        actor: KinAuth.session().sub,",
    },
    {
        "id": "MH7",
        "title": "the per-entry shape check is dropped, so a malformed entry vanishes from the list",
        "case": "test_06_every_shape_the_answer_can_fail_is_unknown_and_never_empty",
        "expect": "a malformed entry must make the whole answer unknown",
        "old": "        if (!RFIELDS.includes(entry.field)) return false;",
        "new": "        if (false) return false;",
    },
]


def run_case(main_html, case, timeout):
    """Run one case of the browser test with main.html taken from `main_html`."""
    environment = dict(os.environ)
    environment["KIN_HISTORY_CITATION_MAIN"] = str(main_html)
    environment["PYTHONIOENCODING"] = "utf-8"
    target = "%s.%s" % (CASE, case) if case else ""
    command = [sys.executable, "-B", str(DOM_TEST)] + ([target] if target else [])
    done = subprocess.run(command, cwd=str(ROOT), env=environment, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return done, (done.stdout or "") + (done.stderr or "")


def failure_block(output, case):
    """The named failure line and the traceback block that belongs to that case."""
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

    source = SOURCE.read_text(encoding="utf-8")
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    print("main.html sha256 %s" % digest)
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
        found = source.count(marker)
        print("marker occurrences=%d %r" % (found, marker[:40]))
        if found != 1:
            problems.append("harness slice marker occurs %d times: %r" % (found, marker[:40]))
    for mutant in MUTANTS:
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

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="u5b-mutants-"))
    results = []
    try:
        baseline_copy = scratch / "baseline.html"
        shutil.copyfile(SOURCE, baseline_copy)
        done, output = run_case(baseline_copy, None, args.timeout)
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
            copy = scratch / ("%s.html" % mutant["id"])
            copy.write_text(source.replace(mutant["old"], mutant["new"]), encoding="utf-8")
            if copy.read_text(encoding="utf-8") == source:
                raise AssertionError(mutant["id"])
            done, output = run_case(copy, mutant["case"], args.timeout)
            named, block, assertion = failure_block(output, mutant["case"])
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

    after = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    print("main.html sha256 after %s (unchanged=%s)" % (after, after == digest))
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
    print("all %d mutants killed on their own assertion" % (len(results) - 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
