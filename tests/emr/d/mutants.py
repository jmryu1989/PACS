# coding: utf-8
"""TEST-D mutants (EMR-D round 1): the pure mutants M-D-01..M-D-05 of api/src/emr-clinical.

REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-01..04 (tests/emr/d/contract_test.cjs).

Each mutant breaks one protection of the product in a COPY of api/src/emr-clinical (with api/src/emr-contract copied
beside it unchanged) and runs the contract test against that copy through KIN_EMR_D_SRC. A mutant counts as killed only
when ALL of these hold:
  * the unmutated copies first pass the same command (baseline), or no kill is reported at all;
  * the anchor occurs exactly once in its file (a missing or repeated anchor is a failure, not a survivor);
  * the child exits non-zero, the named case is reported `not ok` in the TAP stream with failureType testCodeFailure
    and code ERR_ASSERTION, and that mutant's own expect text is inside that case's failure block;
  * no crash marker (syntax/reference/module errors) appears: an import or process failure is never a kill.

M-D-06 (the delayed-response sequence check) lives in page code that round 2 owns; it is reported "not_run" with that
reason, never as a kill. The source tree is never modified. Source and mutated file hashes go into the summary.

stdlib only. Usage: python -B tests/emr/d/mutants.py [--anchors-only] [--out PATH]; node comes from KIN_NODE or PATH.
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
D_DIR = ROOT / "api" / "src" / "emr-clinical"
A_DIR = ROOT / "api" / "src" / "emr-contract"
TEST = ROOT / "tests" / "emr" / "d" / "contract_test.cjs"
CRASH_MARKERS = ("SyntaxError:", "ReferenceError:", "Cannot find module", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE")

MUTANTS = [
    {
        "id": "M-D-01",
        "title": "a clinical entry is classified as an assignment (no signature is requested)",
        "file": "contract.ts",
        "old": "  return path.capacity === C ? 'clinical-entry' : 'operational-note';",
        "new": "  return path.capacity === C ? 'assignment' : 'operational-note';",
        "case": "TEST-D-01 clinical_vs_operational: a question and its answer are signed clinical entries of their own authors",
        "expect": "M-D-01: a clinician question text must be a signed clinical entry",
    },
    {
        "id": "M-D-02",
        "title": "a version is stored without its original text (only the hash remains)",
        "file": "records.ts",
        "old": "    text, contentSha256: text === null ? null : hex(Buffer.from(text, 'utf8')), reason, attachments, navigation,",
        "new": "    text: null, contentSha256: text === null ? null : hex(Buffer.from(text, 'utf8')), reason, attachments, navigation,",
        "case": "TEST-D-02 versions_and_sr: every change appends a version; earlier text stays exact and the projection is the fold",
        "expect": "M-D-02: the request text and the reply both stay in the history",
    },
    {
        "id": "M-D-03",
        "title": "a failed signature still proceeds to the commit and answers success",
        "file": "records.ts",
        "old": "    if (result.ok === false) return failed(result.code);",
        "new": "    if (result.ok === false) signature = null;",
        "case": "TEST-D-04 atomic_retry: a failed, unverified or proxy signature commits nothing and leaves the record unchanged",
        "expect": "M-D-03: a signature failure must not commit or answer success",
    },
    {
        "id": "M-D-04",
        "title": "the 24-hour window clears adopted and store-attempted SR bytes",
        "file": "records.ts",
        "old": "      row.storedAt !== null || row.adoptedVersion !== null ? 'adopted' :\n      row.attemptedAt !== null ? 'store-attempted' :\n",
        "new": "",
        "case": "TEST-D-02 versions_and_sr: the 24-hour window ends only an unattempted, unadopted, unreferenced, unheld copy Orthanc confirms absent",
        "expect": "M-D-04: an adopted SR is never cleared by the 24-hour window",
    },
    {
        "id": "M-D-05",
        "title": "the institution boundary is skipped",
        "file": "records.ts",
        "old": "  return institutionId === managing || ((TELE_RECORDS[mode] as readonly string[]).includes(record) && reading !== null && institutionId === reading);",
        "new": "  return true || institutionId === managing || ((TELE_RECORDS[mode] as readonly string[]).includes(record) && reading !== null && institutionId === reading);",
        "case": "TEST-D-03 read_scope: the author and institution readers are served; another clinician and another institution are not",
        "expect": "M-D-05: another institution gets no body",
    },
]
# The exact round-1 selection of tests/emr/d/contract_test.cjs, written by hand (never generated from a run). The
# baseline must collect exactly these cases, each once, all passing; R2 moves the declaration into emr/units/d.json.
DECLARED_CASES = [
    "TEST-D-01 clinical_vs_operational: a question and its answer are signed clinical entries of their own authors",
    "TEST-D-01 clinical_vs_operational: consultation and finding text is signed; acceptance only moves state",
    "TEST-D-01 clinical_vs_operational: reader assignment carries no text and never a clinical signature",
    "TEST-D-01 clinical_vs_operational: staff processing text is an operational note; a clinician's request text is adopted and signed",
    "TEST-D-01 clinical_vs_operational: a radiographer signs their own Tech Note; an administrator never signs in their place",
    "TEST-D-01 clinical_vs_operational: body claims of authority are refused and server facts alone decide the class",
    "TEST-D-01 clinical_vs_operational: no registered signer, a service account or a foreign path plans nothing",
    "TEST-D-01 clinical_vs_operational: planned kinds belong to the A route and the signing request is a valid A payload",
    "TEST-D-02 versions_and_sr: every change appends a version; earlier text stays exact and the projection is the fold",
    "TEST-D-02 versions_and_sr: a rewritten, dropped or reordered earlier version is refused, never projected",
    "TEST-D-02 versions_and_sr: a finding correction keeps the original and incorporates source copies, not the comparison link",
    "TEST-D-02 versions_and_sr: the 24-hour window ends only an unattempted, unadopted, unreferenced, unheld copy Orthanc confirms absent",
    "TEST-D-02 versions_and_sr: Orthanc reconciliation adopts only the exact bytes this server authorized",
    "TEST-D-02 versions_and_sr: the store intent is the author's signature over the exact SR bytes; others are refused",
    "TEST-D-03 read_scope: the author and institution readers are served; another clinician and another institution are not",
    "TEST-D-03 read_scope: a write from another institution is refused before anything else is examined",
    "TEST-D-03 read_scope: bodies are handed out only after the access event for exactly those versions is durable",
    "TEST-D-03 read_scope: summaries, receipts and refusals carry no clinical text",
    "TEST-D-04 atomic_retry: one commit per request; a replay returns the stored receipt without signing again",
    "TEST-D-04 atomic_retry: a failed, unverified or proxy signature commits nothing and leaves the record unchanged",
    "TEST-D-04 atomic_retry: a lost commit answer is resolved by the stored receipt, never guessed",
    "TEST-D-04 atomic_retry: a stale revision, a forbidden transition or a regressed clock is refused before any signing",
]
NOT_RUN = [{"id": "M-D-06", "status": "not_run",
            "reason": "delayed-response UID+sequence/account-generation check is page code (consultations.js, finding-command.js, "
                      "reading-findings.js, clinician.js); round 2 DOM case TEST-D-05 ui_reopen owns it"}]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_lf(path):
    # Anchors are written with LF; a Windows checkout may hold CRLF. Compare and mutate on LF text.
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def check_anchors():
    problems = []
    for m in MUTANTS:
        count = read_lf(D_DIR / m["file"]).count(m["old"])
        if count != 1:
            problems.append(f"{m['id']}: anchor occurs {count} times in {m['file']}")
    return problems


def node_binary():
    node = os.environ.get("KIN_NODE") or shutil.which("node")
    if not node:
        raise SystemExit("node not found (set KIN_NODE)")
    return node


def stage(workdir, mutant=None):
    src = pathlib.Path(workdir) / "api" / "src"
    shutil.copytree(A_DIR, src / "emr-contract")
    shutil.copytree(D_DIR, src / "emr-clinical")
    hashes = {}
    if mutant:
        target = src / "emr-clinical" / mutant["file"]
        text = read_lf(target)
        mutated = text.replace(mutant["old"], mutant["new"], 1)
        target.write_bytes(mutated.encode("utf-8"))
        hashes = {"source": sha(text.encode("utf-8")), "mutated": sha(mutated.encode("utf-8"))}
    return src / "emr-clinical", hashes


def run(node, d_src):
    env = {**os.environ, "KIN_EMR_D_SRC": str(d_src), "NODE_OPTIONS": ""}
    proc = subprocess.run([node, "--test", "--test-reporter=tap", str(TEST)], cwd=ROOT, env=env, capture_output=True, timeout=600)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


TAP_LINE = re.compile(r"^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO).*)?$")


def tap_cases(stdout):
    """Top-level TAP results: name -> (status, block lines). Node escapes '#' and '\\' in names; ours contain neither."""
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
    if code == 0:
        reasons.append("child exited 0")
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
    problems = check_anchors()
    sources = {str(p.relative_to(ROOT)).replace("\\", "/"): sha(p.read_bytes())
               for p in sorted([*D_DIR.glob("*.ts"), *A_DIR.glob("*.ts"), TEST])}
    summary = {"sources": sources, "anchors": "ok" if not problems else problems, "baseline": None, "mutants": [], "not_run": NOT_RUN}
    if problems or args.anchors_only:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 1 if problems else 0
    node = node_binary()
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    summary["node"] = version
    with tempfile.TemporaryDirectory(prefix="emr-d-baseline-") as work:
        d_src, _ = stage(work)
        code, stdout, stderr = run(node, d_src)
        cases = tap_cases(stdout)
        passed = {name for name, (status, skip, _) in cases.items() if status == "ok" and not skip}
        missing = sorted({m["case"] for m in MUTANTS} - passed)
        selection = {"declared": len(DECLARED_CASES), "collected": len(cases), "passed": len(passed),
                     "undeclared": sorted(set(cases) - set(DECLARED_CASES)), "not_collected": sorted(set(DECLARED_CASES) - set(cases))}
        summary["baseline"] = {"exit": code, "selection": selection, "not_ok": sorted(n for n, (s, _, _) in cases.items() if s == "not ok"),
                               "named_cases_not_passing": missing}
        mismatch = len(set(DECLARED_CASES)) != len(DECLARED_CASES) or set(cases) != set(DECLARED_CASES) or passed != set(DECLARED_CASES)
        if code != 0 or missing or mismatch:
            summary["baseline"]["stderr_tail"] = stderr[-2000:]
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 1
    for mutant in MUTANTS:
        with tempfile.TemporaryDirectory(prefix=f"emr-d-{mutant['id'].lower()}-") as work:
            d_src, hashes = stage(work, mutant)
            code, stdout, stderr = run(node, d_src)
            verdict = judge(mutant, code, stdout, stderr)
            summary["mutants"].append({"id": mutant["id"], "title": mutant["title"], "file": "api/src/emr-clinical/" + mutant["file"],
                                       "case": mutant["case"], "expect": mutant["expect"], "exit": code, **hashes, **verdict})
    killed = all(m["killed"] for m in summary["mutants"])
    summary["result"] = {"killed": sum(m["killed"] for m in summary["mutants"]), "total": len(MUTANTS), "not_run": len(NOT_RUN)}
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.out:
        pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0 if killed else 1


if __name__ == "__main__":
    sys.exit(main())
