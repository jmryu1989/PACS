# coding: utf-8
"""TEST-F mutants (EMR-F round 1): M-F-01..M-F-07 and M-F-S1..S7 of api/src/emr-audit.

REQ-EMR-07/15/16/17/19 -> RISK-F-01..08 -> TEST-F-01..08 (tests/emr/f/contract_test.cjs).

Each mutant breaks one protection of the product in a COPY of api/src/emr-audit (api/src/emr-contract copied beside it
unchanged) and runs the contract test against that copy through KIN_EMR_F_SRC. A mutant counts as killed only when ALL
of these hold:
  * the unmutated copies first pass the same command and collect exactly DECLARED_CASES (else no kill is reported);
  * the anchor occurs exactly once in its file (a missing or repeated anchor is a failure, not a survivor);
  * the child exits non-zero, the named case is reported `not ok` in the TAP stream with failureType testCodeFailure
    and code ERR_ASSERTION, and that mutant's own expect text is inside that case's failure block;
  * no crash marker (syntax/reference/module errors) appears: an import or process failure is never a kill.

The live forms of these risks (the R2 SQL predicate, the A gate in lawful-defaults.ts, the real roster store and print
flow) are reported "not_run" with their reason, never as kills. The source tree is never modified. Source and mutated
file hashes go into the summary.

stdlib only. Usage: python -B tests/emr/f/mutants.py [--anchors-only] [--out PATH]; node comes from KIN_NODE or PATH.
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

ROOT = pathlib.Path(__file__).resolve().parents[3]
F_DIR = ROOT / "api" / "src" / "emr-audit"
A_DIR = ROOT / "api" / "src" / "emr-contract"
TEST = ROOT / "tests" / "emr" / "f" / "contract_test.cjs"
CRASH_MARKERS = ("SyntaxError:", "ReferenceError:", "Cannot find module", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE")

MUTANTS = [
    {
        "id": "M-F-01",
        "title": "a general admin is given audit authority without a roster grant",
        "file": "contract.ts",
        "old": "  if (!scopes.length) refuse('AuditorNotDesignated');\n",
        "new": "  if (!scopes.length && c.roles.includes('admin')) scopes.push(...ROSTER_SCOPES);\n"
               "  if (!scopes.length) refuse('AuditorNotDesignated');\n",
        "case": "TEST-F-01 roster_scope: a designated auditor gets exactly the granted scopes and a general admin without a grant gets none",
        "expect": "M-F-01: a general admin without a grant gets no audit authority",
    },
    {
        "id": "M-F-02",
        "title": "the institution filter is applied after the page is cut (count and page include other institutions)",
        "file": "contract.ts",
        "old": "      if (!inInstitutionScope(plan, event)) continue;\n"
               "      const targets = eventMatches(plan, event);\n"
               "      if (!targets) continue;\n"
               "      total++;\n"
               "      if (after !== null && sequence >= after) continue;\n"
               "      if (rows.length < limit) { rows.push(replayEntry(sequence, durableAt, event, targets, options.currentLink)); last = sequence; }\n",
        "new": "      const targets = eventMatches(plan, event);\n"
               "      if (!targets) continue;\n"
               "      total++;\n"
               "      if (after !== null && sequence >= after) continue;\n"
               "      if (rows.length < limit) { if (inInstitutionScope(plan, event)) rows.push(replayEntry(sequence, durableAt, event, targets, options.currentLink)); last = sequence; }\n",
        "case": "TEST-F-01 roster_scope: only the institution events are counted, paged and exported and other institutions add nothing",
        "expect": "M-F-02: other institutions add nothing to the count or the page",
    },
    {
        "id": "M-F-03",
        "title": "past events are re-attributed to the study's current patient link",
        "file": "contract.ts",
        "old": "    patient: recorded,\n",
        "new": "    patient: current ? { status: 'known' as const, value: current } : recorded,\n",
        "case": "TEST-F-02 patient_replay: replay keeps each event recorded patient, institutions, version and times after a re-match",
        "expect": "M-F-03: past events stay attributed to the patient they recorded",
    },
    {
        "id": "M-F-04",
        "title": "opening a print window marks the copy as issued",
        "file": "contract.ts",
        "old": "          if (state === null || TERMINAL.includes(state)) refuse('IssuanceTransitionRefused');\n"
               "          break;\n",
        "new": "          if (state === null || TERMINAL.includes(state)) refuse('IssuanceTransitionRefused');\n"
               "          if (state === 'Prepared' && e.observation === 'print-opened') state = 'Issued';\n"
               "          break;\n",
        "case": "TEST-F-04 issuance_result: Issued needs server bytes bound to the manifest and a designated issuer while a print window or client PDF never issues",
        "expect": "M-F-04: a print window is not an issued copy",
    },
    {
        "id": "M-F-05",
        "title": "the clause wording is chosen by promulgation date, so the future military clause applies now",
        "file": "contract.ts",
        "old": "  const inForce = DISCLOSURE_CLAUSE_VERSIONS.filter(v => v.effectiveAt <= day);\n",
        "new": "  const inForce = DISCLOSURE_CLAUSE_VERSIONS.filter(v => v.publishedAt <= day);\n",
        "case": "TEST-F-03 lawful_issue: a military manpower request is judged by the wording in force when it arrived",
        "expect": "M-F-05: a future clause is not applied before it is in force",
    },
    {
        "id": "M-F-06",
        "title": "a pending request hold ends at the original until although the deadline was lawfully extended",
        "file": "contract.ts",
        "old": "  if (at >= due) return freeze({ preserve: true, state: 'pending-overdue', dueAt: due });\n",
        "new": "  if (at >= facts.initialDueAt) return freeze({ preserve: false, state: 'pending-overdue', dueAt: facts.initialDueAt });\n",
        "case": "TEST-F-06 extended_request_hold: a lawfully extended pending request keeps its hold after the old until and the old until releases nothing",
        "expect": "M-F-06: the old until does not end a pending extended request",
    },
    {
        "id": "M-F-07",
        "title": "the automatically generated monthly report counts as the human review",
        "file": "contract.ts",
        "old": "    const review = events.filter(e => e.kind === 'reviewed').pop() ?? null;\n",
        "new": "    const review = events.filter(e => e.kind === 'reviewed' || e.kind === 'report-generated').pop() ?? null;\n",
        "case": "TEST-F-05 followup: an automatically generated monthly report is not an inspection and a designated reviewer completes it",
        "expect": "M-F-07: a generated report alone is not a completed inspection",
    },
    {
        "id": "M-F-S1",
        "title": "an unreadable ledger is reported as an incident with nobody affected (legal register D-15)",
        "file": "contract.ts",
        "old": "    reasons.push({ kind: 'ledger-unreadable', code: error.code });\n",
        "new": "    void error.code;\n",
        "case": "TEST-F-07 incident_scope: a ledger that cannot be read or verified is reported as subjects not identifiable and never as nobody affected",
        "expect": "M-F-S1: an unreadable ledger never reads as nobody affected",
    },
    {
        "id": "M-F-S2",
        "title": "a deletion request deletes a record the law keeps (legal register D-7)",
        "file": "contract.ts",
        "old": "    const outcome: RightsOutcome = r.kind === 'deletion' ? (kept ? 'refused-retained-by-law' : 'delete-irreversibly') :\n",
        "new": "    const outcome: RightsOutcome = r.kind === 'deletion' ? 'delete-irreversibly' :\n",
        "case": "TEST-F-08 rights_request: deletion or suspension of a record the law keeps is refused with reason and objection notice while purpose data is acted on",
        "expect": "M-F-S2: a statutory record is never deleted on request",
    },
    {
        "id": "M-F-S3", "title": "synthetic issuance can be relabelled as operational", "file": "contract.ts",
        "old": "    if (environment !== v.manifest.environment) refuse('IssuanceEnvironmentMismatch');\n",
        "new": "",
        "case": "TEST-F-04 issuance_result: a paper handover is the staff attestation and not a detection and synthetic recipients never count as operational",
        "expect": "M-F-S3: relabelling a synthetic issuance cannot make operational evidence",
    },
    {
        "id": "M-F-S4", "title": "the view stream is silently omitted", "file": "contract.ts",
        "old": "totalEntries: changePage.total + viewPage.total",
        "new": "totalEntries: changePage.total",
        "case": "TEST-F-02 patient_replay: change and view streams keep independent snapshots and cursors and neither stream may silently disappear",
        "expect": "M-F-S4: both access streams contribute their own entries",
    },
    {
        "id": "M-F-S5", "title": "an unbound stored release ends a pending request hold", "file": "contract.ts",
        "old": "  if (hold.release !== null) {\n    const release = guarded('HoldReleaseBindingRefused', () => {\n",
        "new": "  if (hold.release !== null) return freeze({ preserve: false, state: 'released', dueAt: due });\n"
               "  if (hold.release !== null) {\n    const release = guarded('HoldReleaseBindingRefused', () => {\n",
        "case": "TEST-F-06 extended_request_hold: a reloaded release needs its own verified resolution and institution and cannot end preservation early",
        "expect": "M-F-S5: a release without the request resolution never ends preservation",
    },
    {
        "id": "M-F-S6", "title": "an older recheck closes a new follow-up action", "file": "contract.ts",
        "old": "      return !action || recheck?.result !== 'resolved' || events.indexOf(recheck) <= events.indexOf(action);\n",
        "new": "      return !action || recheck?.result !== 'resolved';\n",
        "case": "TEST-F-05 followup: every new action needs a later recheck before closing including actions at the same time",
        "expect": "M-F-S6: a new action cannot reuse an earlier recheck",
    },
    {
        "id": "M-F-S7", "title": "possible-leak notification waits beyond its 72-hour deadline", "file": "contract.ts",
        "old": "    add('possible-leak', 'all-possibly-affected-subjects', hours72(f.awarenessAt), 'without-delay-within-72-hours',\n",
        "new": "    add('possible-leak', 'all-possibly-affected-subjects', hours72(hours72(f.awarenessAt)), 'without-delay-within-72-hours',\n",
        "case": "TEST-F-07 incident_scope: possible leak notice covers all possibly affected subjects within 72 hours and an unknown population is never zero",
        "expect": "M-F-S7: possible-leak notice retains its 72-hour deadline and all-possible-subject audience",
    },
]
# The exact round-1 selection of tests/emr/f/contract_test.cjs, written by hand (never generated from a run). The
# baseline must collect exactly these cases, each once, all passing; R2 moves the declaration into emr/units/f.json.
DECLARED_CASES = [
    "TEST-F-01 roster_scope: a designated auditor gets exactly the granted scopes and a general admin without a grant gets none",
    "TEST-F-01 roster_scope: a revoked, expired, not-yet-valid or moved auditor gets no authority and nothing is read",
    "TEST-F-01 roster_scope: client claims of auditor status, roles or institution are refused and the scope is the grant institution",
    "TEST-F-01 roster_scope: only the institution events are counted, paged and exported and other institutions add nothing",
    "TEST-F-01 roster_scope: every grant change is rights history kept three years on its own clock apart from the access ledger",
    "TEST-F-02 patient_replay: replay keeps each event recorded patient, institutions, version and times after a re-match",
    "TEST-F-02 patient_replay: the new patient finds only its own recorded events and a multi-target event shows only the investigated patient",
    "TEST-F-02 patient_replay: a stored event whose patient or version was rewritten fails its chain hash and nothing is shown",
    "TEST-F-02 patient_replay: refused, aborted and conflict events are replayed as such and filtered by action, result and address",
    "TEST-F-02 patient_replay: a source failure, misordered or out-of-snapshot row is an error and never an empty or short result",
    "TEST-F-02 patient_replay: a sealed cursor continues the same snapshot without duplicates or gaps and another plan, auditor or forged cursor is refused",
    "TEST-F-02 patient_replay: the investigation is itself an access event for exactly the rows shown and an export is a download",
    "TEST-F-03 lawful_issue: a patient own request prepares every version with the verification material of each signed version",
    "TEST-F-03 lawful_issue: a military manpower request is judged by the wording in force when it arrived",
    "TEST-F-03 lawful_issue: family, agent and statutory requests need their own qualification evidence and anything missing is refused before any package",
    "TEST-F-03 lawful_issue: the default is the whole record and a requester-specified part stays exact while incomplete or foreign listings are refused",
    "TEST-F-03 lawful_issue: a record head that moved after preparation refuses issuance and nothing is issued",
    "TEST-F-03 lawful_issue: the disclosure ledger event built from the package is a valid A event on the authorized-disclosure surface",
    "TEST-F-04 issuance_result: Issued needs server bytes bound to the manifest and a designated issuer while a print window or client PDF never issues",
    "TEST-F-04 issuance_result: Delivered needs real handover or receipt evidence while an unknown outcome is ReceiptUnknown and a failure is DeliveryFailed",
    "TEST-F-04 issuance_result: a paper handover is the staff attestation and not a detection and synthetic recipients never count as operational",
    "TEST-F-04 issuance_result: Closed only after a delivery outcome with a reason when not delivered and abort only before issue on an append-only history",
    "TEST-F-05 followup: an automatically generated monthly report is not an inspection and a designated reviewer completes it",
    "TEST-F-05 followup: every download of the month needs a confirmed reason before closing",
    "TEST-F-05 followup: an investigation closes only with a recorded action and a passing recheck by designated people",
    "TEST-F-05 followup: the inspection period stays the Seoul calendar month before and after 2026-11-01",
    "TEST-F-06 extended_request_hold: a lawfully extended pending request keeps its hold after the old until and the old until releases nothing",
    "TEST-F-06 extended_request_hold: the extension moves the request due and the hold validity together and keeps the earlier due and validity as history",
    "TEST-F-06 extended_request_hold: a release binds only to the same request verified resolution and A accepts it on reload",
    "TEST-F-06 extended_request_hold: an untimely, backward or unbound extension is refused and a due never becomes unlimited",
    "TEST-F-07 incident_scope: an incident query names the patients whose records were provided for the period and address and nothing for refused attempts",
    "TEST-F-07 incident_scope: a ledger that cannot be read or verified is reported as subjects not identifiable and never as nobody affected",
    "TEST-F-08 rights_request: deletion or suspension of a record the law keeps is refused with reason and objection notice while purpose data is acted on",
    "TEST-F-08 rights_request: a correction is a new signed version that keeps the original and an access event is never edited and the request binds its own patient",
    "TEST-F-02 patient_replay: change and view streams keep independent snapshots and cursors and neither stream may silently disappear",
    "TEST-F-06 extended_request_hold: a reloaded release needs its own verified resolution and institution and cannot end preservation early",
    "TEST-F-05 followup: every new action needs a later recheck before closing including actions at the same time",
    "TEST-F-07 incident_scope: possible leak notice covers all possibly affected subjects within 72 hours and an unknown population is never zero",
    "TEST-F-07 incident_scope: confirmed priority and additional notices and PIPC or KISA reports have separate deadlines and required fields",
    "TEST-F-07 incident_scope: not-a-leak follow-up and immediate MOHW notice remain distinct and a template is never sent evidence",
]
NOT_RUN = [
    {"id": "M-F-01-live", "status": "not_run", "reason": "the server roster check over B1 storage and the B2 caller context is round 2 "
     "(api/src/emr-audit/query.ts, admin.service.ts); TEST-F-01 live pair in tests/emr/f/live.py"},
    {"id": "M-F-02-live", "status": "not_run", "reason": "the institution/audit-scope predicate inside the R2 SQL query and its count/CSV "
     "(api/src/emr-audit/query.ts) does not exist in round 1"},
    {"id": "M-F-04-live", "status": "not_run", "reason": "the real print/PDF flow and the server artifact generator are round 2 "
     "(api/src/emr-audit/disclosure.ts, scripts/emr-disclosure.mjs, admin.html)"},
    {"id": "M-F-06-A", "status": "not_run", "reason": "the A gate holdEnded in api/src/emr-contract/lawful-defaults.ts (L5-06) is round-2 "
     "owned by F after release of ownership; H verifies the destruction race"},
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_lf(path):
    # Anchors are written with LF; a Windows checkout may hold CRLF. Compare and mutate on LF text.
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def check_anchors():
    problems = []
    for m in MUTANTS:
        count = read_lf(F_DIR / m["file"]).count(m["old"])
        if count != 1:
            problems.append(f"{m['id']}: anchor occurs {count} times in {m['file']}")
    if len(set(DECLARED_CASES)) != len(DECLARED_CASES):
        problems.append("DECLARED_CASES repeats a case")
    problems += [f"{m['id']}: named case is not declared" for m in MUTANTS if m["case"] not in DECLARED_CASES]
    return problems


def node_binary():
    node = os.environ.get("KIN_NODE") or shutil.which("node")
    if not node:
        raise SystemExit("node not found (set KIN_NODE)")
    return node


def stage(workdir, mutant=None):
    src = pathlib.Path(workdir) / "api" / "src"
    shutil.copytree(A_DIR, src / "emr-contract")
    shutil.copytree(F_DIR, src / "emr-audit")
    hashes = {}
    if mutant:
        target = src / "emr-audit" / mutant["file"]
        text = read_lf(target)
        mutated = text.replace(mutant["old"], mutant["new"], 1)
        target.write_bytes(mutated.encode("utf-8"))
        hashes = {"source": sha(text.encode("utf-8")), "mutated": sha(mutated.encode("utf-8"))}
    return src / "emr-audit", hashes


def run(node, f_src):
    env = {**os.environ, "KIN_EMR_F_SRC": str(f_src), "NODE_OPTIONS": ""}
    proc = subprocess.run([node, "--test", "--test-reporter=tap", str(TEST)], cwd=ROOT, env=env, capture_output=True, timeout=600)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


TAP_LINE = re.compile(r"^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO).*)?$")


def tap_cases(stdout):
    """Top-level TAP results: name -> (status, directive, block lines). Node escapes '#' and '\\' in names; ours have neither."""
    lines, cases, i = stdout.splitlines(), {}, 0
    while i < len(lines):
        match = TAP_LINE.match(lines[i])
        i += 1
        if not match:
            continue
        block = []
        if i < len(lines) and lines[i].strip() == "---":
            i += 1
            while i < len(lines) and lines[i].strip() != "...":
                block.append(lines[i])
                i += 1
            i += 1
        if match.group(3) in cases:
            raise SystemExit(f"duplicate TAP case name: {match.group(3)}")
        cases[match.group(3)] = (match.group(1), match.group(4), block)
    return cases


def judge(mutant, code, stdout, stderr):
    cases = tap_cases(stdout)
    entry = cases.get(mutant["case"])
    block = "\n".join(entry[2]) if entry else ""
    crash = [marker for marker in CRASH_MARKERS if marker in stdout or marker in stderr]
    reasons = []
    if code != 1:
        reasons.append(f"child exit is {code}, expected assertion-failure exit 1")
    if set(cases) != set(DECLARED_CASES) or any(skip for _, skip, _ in cases.values()):
        reasons.append("mutant collection differs from the exact declared selection")
    if entry is None:
        reasons.append("named case not reported")
    elif entry[0] != "not ok" or entry[1]:
        reasons.append(f"named case reported {entry[0]} {entry[1] or ''}".strip())
    if "failureType: 'testCodeFailure'" not in block:
        reasons.append("no testCodeFailure in the case block")
    if "code: 'ERR_ASSERTION'" not in block:
        reasons.append("no ERR_ASSERTION in the case block")
    if mutant["expect"] not in block:
        reasons.append("expect text not in the case block")
    if crash:
        reasons.append("crash markers: " + ", ".join(crash))
    failing = sorted(name for name, (status, _, _) in cases.items() if status == "not ok")
    return {"killed": not reasons, "reasons": reasons, "failing_cases": failing, "case_block": entry[2] if entry else []}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--anchors-only", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args()
    raw_dir = pathlib.Path(args.out).with_suffix(".raw") if args.out else None
    if raw_dir is not None:
        raw_dir.mkdir(parents=True, exist_ok=False)

    def retain_logs(label, stdout, stderr):
        if raw_dir is None:
            return {"stdout": stdout, "stderr": stderr}
        paths = {}
        for name, value in (("stdout", stdout), ("stderr", stderr)):
            log = raw_dir / f"{label}.{name}.log"
            log.write_text(value, encoding="utf-8")
            paths[name] = str(log)
        return paths
    problems = check_anchors()
    sources = {str(p.relative_to(ROOT)).replace("\\", "/"): sha(p.read_bytes())
               for p in sorted([*F_DIR.glob("*.ts"), *A_DIR.glob("*.ts"), TEST])}
    summary = {"sources": sources, "anchors": "ok" if not problems else problems, "baseline": None, "mutants": [], "not_run": NOT_RUN}

    def emit(code):
        text = json.dumps(summary, ensure_ascii=False, indent=2)
        if args.out:
            pathlib.Path(args.out).write_text(text, encoding="utf-8")
        print(text)
        return code

    if problems or args.anchors_only:
        return emit(1 if problems else 0)
    node = node_binary()
    summary["node"] = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="emr-f-baseline-") as work:
        f_src, _ = stage(work)
        code, stdout, stderr = run(node, f_src)
        cases = tap_cases(stdout)
        passed = {name for name, (status, skip, _) in cases.items() if status == "ok" and not skip}
        selection = {"declared": len(DECLARED_CASES), "collected": len(cases), "passed": len(passed),
                     "undeclared": sorted(set(cases) - set(DECLARED_CASES)), "not_collected": sorted(set(DECLARED_CASES) - set(cases))}
        summary["baseline"] = {"exit": code, "selection": selection, "logs": retain_logs("baseline", stdout, stderr),
                               "not_ok": sorted(n for n, (s, _, _) in cases.items() if s == "not ok")}
        if code != 0 or set(cases) != set(DECLARED_CASES) or passed != set(DECLARED_CASES):
            summary["baseline"]["stderr_tail"] = stderr[-2000:]
            return emit(1)
    for mutant in MUTANTS:
        with tempfile.TemporaryDirectory(prefix=f"emr-f-{mutant['id'].lower()}-") as work:
            f_src, hashes = stage(work, mutant)
            code, stdout, stderr = run(node, f_src)
            verdict = judge(mutant, code, stdout, stderr)
            summary["mutants"].append({"id": mutant["id"], "title": mutant["title"], "file": "api/src/emr-audit/" + mutant["file"],
                                       "case": mutant["case"], "expect": mutant["expect"], "exit": code,
                                       "logs": retain_logs(mutant["id"], stdout, stderr), **hashes, **verdict})
    killed = all(m["killed"] for m in summary["mutants"])
    summary["result"] = {"killed": sum(m["killed"] for m in summary["mutants"]), "total": len(MUTANTS), "not_run": len(NOT_RUN)}
    return emit(0 if killed else 1)


if __name__ == "__main__":
    sys.exit(main())
