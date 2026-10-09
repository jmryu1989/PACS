# coding: utf-8
"""TEST-G-MUTANTS: the required EMR-G round-1 mutants against the pure legacy migration contract.

REQ-EMR-03/05/12/18 -> RISK-G-01..05 -> TEST-G-01..05 -> M-G-01..06 (+ M-G-01R, M-G-01S, M-G-05R).

  M-G-01   the migration event is dated with the source's original time        -> TEST-G-03 refuse (past events)
  M-G-01R  the retention start is reset to the migration time                    -> TEST-G-04 allow
  M-G-01S  the stored original time is replaced by the migration time             -> TEST-G-01 allow
  M-G-02   a signer whose display name matches becomes the legacy author        -> TEST-G-03 refuse (same display name)
  M-G-03   a legacy approval gets a backdated signature event                    -> TEST-G-03 refuse (past events)
  M-G-04   patients are compared as a total, so an exchange passes               -> TEST-G-01 refuse (exchanged patients)
  M-G-05   the checkpoint is committed ahead of the bodies it covers             -> TEST-G-02 allow (crash at any boundary)
  M-G-05R  restart trusts a stored checkpoint without its bodies                 -> TEST-G-02 refuse (checkpoint ahead)
  M-G-06   an unknown approval time grants a 24-hour window from the migration  -> TEST-G-04 refuse (unknown dates)

M-G-01 reads "이관 시각을 원시각으로 덮기" as backdating the migration event; M-G-01R covers the other direction
(the original time replaced by the migration time) so neither reading survives.

Each mutant breaks api/src/emr-legacy/contract.ts in a COPY; tests/emr/g/contract_test.cjs compiles that copy under the
real module path through KIN_EMR_G_CONTRACT_SOURCE. Rules this runner holds itself to:
  * the source tree is never written; the source hash is recorded before and after;
  * each anchor occurs exactly once in the source, or that is a failure, not a survivor;
  * the unmutated copy, through the same override, must first pass every case, or no kill is reported;
  * a kill needs a non-zero exit, every baseline case reported, the named case 'not ok' with failureType
    testCodeFailure, an AssertionError (ERR_ASSERTION) and that mutant's own message inside the case's block;
  * a load/compile failure or a non-assertion error in the named case is a crash, never a kill;
  * a comment-only control edit must survive with every case passing, or the runner itself is reported broken.
Round 1 has no storage, signing or screen: their variants belong to R2 (tests/emr/g/live.py) and are listed as not_run.
stdlib only; it launches node as a child process and never touches a database, container or browser.
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
SOURCE = ROOT / "api" / "src" / "emr-legacy" / "contract.ts"
TEST = ROOT / "tests" / "emr" / "g" / "contract_test.cjs"
ENV_KEY = "KIN_EMR_G_CONTRACT_SOURCE"
TIMEOUT = 600

CASE_PAST = "TEST-G-03 unsigned_supplement refuse: migration creates no past signature, approval or reading"
WRITE_LINE = ("    events: [{ act: MIGRATION_ACT, at: ctx.at, runId: ctx.runId, unitId: ctx.unitId, actorId: ctx.actorId, "
              "signature: null }],")
FACTS_LINE = "    marking: markingFor(plan, item), retention: retentionFor(item), lifecycle: lifecycleFor(item),"

MUTANTS = [
    {
        "id": "M-G-01",
        "title": "the migration event is dated with the source's original time",
        "case": CASE_PAST,
        "expect": "M-G-01: the migration event carries the current server time of its own unit",
        "old": "    events: [{ act: MIGRATION_ACT, at: ctx.at, runId: ctx.runId,",
        "new": "    events: [{ act: MIGRATION_ACT, at: item.time.value, runId: ctx.runId,",
    },
    {
        "id": "M-G-01R",
        "title": "the retention start is reset to the migration time",
        "case": "TEST-G-04 unknown_dates allow: a verified original time stays the retention start; migration and supplement do not move it",
        "expect": "M-G-01R: the retention start is the stored original time, never the migration time",
        "old": FACTS_LINE,
        "new": "    marking: markingFor(plan, item), retention: retentionFor({ ...item, time: { value: ctx.at, basis: 'utc-verified' } }), "
               "lifecycle: lifecycleFor(item),",
    },
    {
        "id": "M-G-01S",
        "title": "the stored original time is replaced by the migration time",
        "case": "TEST-G-01 reconcile allow: original stored time survives migration",
        "expect": "M-G-01S: the stored original time is never replaced by the migration time",
        "old": "    original: { columns: item.columns, time: item.time }, institution: item.institution,",
        "new": "    original: { columns: item.columns, time: { ...item.time, value: ctx.at } }, institution: item.institution,",
    },
    {
        "id": "M-G-02",
        "title": "a signer whose display name equals the legacy author string is taken as that author",
        "case": "TEST-G-03 unsigned_supplement refuse: the same display name does not identify the legacy author",
        "expect": "M-G-02: a signer whose display name equals the legacy author string is not that author",
        "old": "    originalAuthor: { kind: 'legacy-display', values: authors, identity: record.marking.author.identity },",
        "new": "    originalAuthor: { kind: 'legacy-display', values: authors, identity: authors.includes(s.display) ? "
               "{ status: 'known', value: signer } : record.marking.author.identity },",
    },
    {
        "id": "M-G-03",
        "title": "a legacy approval receives a signature event dated to its original time",
        "case": CASE_PAST,
        "expect": "M-G-03: no signature, approval or reading event exists for any legacy row",
        "old": WRITE_LINE,
        "new": WRITE_LINE[:-2] + ", ...(lifecycleFor(item).legacyAction === 'approve' ? [{ act: 'entry', at: item.time.value, "
               "runId: ctx.runId, unitId: ctx.unitId, actorId: ctx.actorId, signature: { signedAt: item.time.value } }] : [])],",
    },
    {
        "id": "M-G-04",
        "title": "patients are compared only against the totals, so an exchange between rows passes",
        "case": "TEST-G-01 reconcile refuse: equal totals with two patients exchanged fail on both rows",
        "expect": "M-G-04: equal totals with exchanged patients must fail on each exchanged row",
        "old": "    if (!same(r.patient, item.patient)) m.push('patient');",
        "new": "    if (!p.items.some(i => same(r.patient, i.patient))) m.push('patient');",
    },
    {
        "id": "M-G-05",
        "title": "the unit's checkpoint is committed ahead of the bodies it covers",
        "case": "TEST-G-02 restart allow: a crash at any unit boundary resumes to exactly one stored copy of every row",
        "expect": "M-G-05: a committed checkpoint never runs ahead of its stored bodies",
        "old": "    checkpoint: { runId: j.runId, unitId, through, lastItemKey: p.items[through - 1].itemKey } });",
        "new": "    checkpoint: { runId: j.runId, unitId, through: Math.min(p.items.length, through + size), "
               "lastItemKey: p.items[through - 1].itemKey } });",
    },
    {
        "id": "M-G-05R",
        "title": "restart trusts a stored checkpoint without checking the bodies below it",
        "case": "TEST-G-02 restart refuse: a checkpoint ahead of its stored bodies, an orphan body and a partial re-read are refused",
        "expect": "M-G-05R: a stored checkpoint over a missing body is refused, never resumed past",
        "old": "  for (let n = 0; n < through; n++) if (!byKey.has(p.items[n].itemKey)) refuse('CheckpointAheadOfBody');",
        "new": "  void 0;",
    },
    {
        "id": "M-G-06",
        "title": "an unknown approval time grants a 24-hour amendment window from the migration time",
        "case": "TEST-G-04 unknown_dates refuse: an unverified time stays unresolved, is not destroyable and grants no 24-hour window",
        "expect": "M-G-06: an unknown approval time grants no 24-hour amendment counted from the migration",
        "old": FACTS_LINE,
        "new": "    marking: markingFor(plan, item), retention: retentionFor(item), lifecycle: item.time.basis === 'utc-verified' ? "
               "lifecycleFor(item) : { ...lifecycleFor(item), amendWindow: { status: 'granted', from: ctx.at, "
               "until: new Date(Date.parse(ctx.at) + 86400000).toISOString() } },",
    },
]
# A behaviour-preserving edit must survive; if it were "killed", this runner could not tell a survivor from a kill.
CONTROLS = [
    {
        "id": "CONTROL-comment",
        "title": "a comment-only edit (no behaviour change) must survive",
        "case": "TEST-G-01 reconcile refuse: equal totals with two patients exchanged fail on both rows",
        "expect": "M-G-04: equal totals with exchanged patients must fail on each exchanged row",
        "old": "      // A cleared draft row is a revision boundary, not a draft; it is listed, never silently dropped.",
        "new": "      // A cleared draft row is a revision boundary, not a draft; it is listed, never silently dropped (control).",
    },
]
NOT_RUN = [{"id": name + " (live)", "reason": "R2: real importer, B1 storage, C supplement signing and C/D re-read screens "
            "do not exist in round 1; tests/emr/g/live.py (EmrGLive) owns the live and DOM variants"}
           for name in ["M-G-01", "M-G-02", "M-G-03", "M-G-04", "M-G-05", "M-G-06"]]

RESULT = re.compile(r"^(ok|not ok) (\d+) - (.*)$")
# A broken copy that never reaches its assertions is a crash, not a kill.
CRASH_NAMES = ("name: 'TypeError'", "name: 'ReferenceError'", "name: 'SyntaxError'", "name: 'RangeError'", "name: 'ContractError'",
               "name: 'Error'")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def tap_unescape(name):
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v"}.get(m.group(1), m.group(1)), name)


def parse_tap(text):
    """Top-level results of `node --test --test-reporter=tap`; each with its YAML block."""
    lines, cases, i = text.splitlines(), {}, 0
    while i < len(lines):
        match = RESULT.match(lines[i])
        if match:
            status, _, name = match.groups()
            name, block = tap_unescape(name), []
            if i + 1 < len(lines) and lines[i + 1] == "  ---":
                j = i + 2
                while j < len(lines) and lines[j] != "  ...":
                    block.append(lines[j])
                    j += 1
                if j == len(lines):
                    raise ValueError("unterminated TAP block for " + name)
                i = j
            if name in cases:
                raise ValueError("duplicate TAP result " + name)
            cases[name] = {"ok": status == "ok", "block": "\n".join(block)}
        i += 1
    return cases


def run_copy(node, source_text, work, label):
    copy = work / (label + ".contract.ts")
    copy.write_bytes(source_text.encode("utf-8"))
    env = dict(os.environ)
    env[ENV_KEY] = str(copy)
    run = work / label
    completed = subprocess.run([sys.executable, str(ROOT / "scripts/record-run.py"), "--run-dir", str(run), "--cwd", str(ROOT),
                                "--file", str(SOURCE), "--file", str(copy), "--file", str(TEST), "--file", str(pathlib.Path(__file__)),
                                "--tree", "api/src/emr-contract", "--file", "api/tsconfig.json", "--file", "api/package-lock.json",
                                "--file", "api/prisma/schema.prisma", "--", node, "--test", "--test-reporter=tap", str(TEST)],
                               cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=TIMEOUT)
    if not (run / "run.json").is_file():
        raise RuntimeError("recorder did not create evidence: " + completed.stderr.decode("utf-8", errors="replace"))
    record = json.loads((run / "run.json").read_text(encoding="utf-8"))
    if record["status"] != "completed" or record["exit_code"] != completed.returncode:
        raise RuntimeError("incomplete recorded mutant run: " + str(run))
    stdout = (run / "stdout.log").read_text(encoding="utf-8", errors="replace")
    return completed.returncode, parse_tap(stdout), sha256(copy.read_bytes())


def anchors(source_text):
    problems = []
    for mutant in MUTANTS + CONTROLS:
        count = source_text.count(mutant["old"])
        if count != 1:
            problems.append({"id": mutant["id"], "anchor_count": count})
    return problems


def judge(mutant, exit_code, cases, baseline_names):
    case = cases.get(mutant["case"])
    missing = sorted(baseline_names - set(cases))
    extra = sorted(set(cases) - baseline_names)
    reasons = []
    if exit_code == 0:
        reasons.append("exit 0")
    if missing:
        reasons.append("cases not reported (load or harness crash): " + ", ".join(missing[:3]))
    if extra:
        reasons.append("unexpected cases: " + ", ".join(extra))
    if case is None:
        reasons.append("named case not reported")
    elif case["ok"]:
        reasons.append("named case passed (survivor)")
    else:
        block = case["block"]
        if "failureType: 'testCodeFailure'" not in block:
            reasons.append("named case did not fail in its own code")
        if "code: 'ERR_ASSERTION'" not in block or "name: 'AssertionError'" not in block:
            reasons.append("named case failed without an AssertionError (crash)")
        if any(marker in block for marker in CRASH_NAMES):
            reasons.append("named case raised a non-assertion error (crash)")
        if mutant["expect"] not in block:
            reasons.append("the mutant's own assertion message is absent")
    return not reasons, reasons, case["block"] if case else ""


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--anchors-only", action="store_true", help="check that every anchor occurs exactly once; run nothing")
    parser.add_argument("--node", default=shutil.which("node"), help="node executable (default: node on PATH)")
    parser.add_argument("--out", help="write the JSON summary to this new file")
    args = parser.parse_args(argv)

    source_bytes = SOURCE.read_bytes()
    source_text = source_bytes.decode("utf-8")
    summary = {"source": {"path": SOURCE.relative_to(ROOT).as_posix(), "sha256_before": sha256(source_bytes)},
               "test": {"path": TEST.relative_to(ROOT).as_posix(), "sha256": sha256(TEST.read_bytes())},
               "anchor_problems": anchors(source_text), "baseline": None, "mutants": [], "controls": [], "not_run": NOT_RUN}
    ok = not summary["anchor_problems"]
    if not args.anchors_only:
        if not args.node:
            raise SystemExit("node executable not found")
        summary["node"] = subprocess.run([args.node, "--version"], stdout=subprocess.PIPE, check=True).stdout.decode().strip()
        # Retain the copied inputs and complete recorder logs, including non-target failures and survivors.
        evidence_root = pathlib.Path(args.out).resolve().parent if args.out else ROOT / "tmp/emr-g-r1/runs"
        evidence_root.mkdir(parents=True, exist_ok=True)
        work = pathlib.Path(tempfile.mkdtemp(prefix="mutant-evidence-", dir=str(evidence_root)))
        summary["evidence"] = str(work)
        catalog = subprocess.run([args.node, str(TEST), "--list-cases"], cwd=str(ROOT), check=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=TIMEOUT)
        expected = json.loads(catalog.stdout.decode("utf-8"))
        (work / "expected-cases.json").write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
        if len(set(expected)) != len(expected) or not expected:
            raise RuntimeError("empty or duplicate case declaration")
        exit_code, cases, copy_sha = run_copy(args.node, source_text, work, "baseline")
        baseline_names = set(cases)
        failing = sorted(name for name, case in cases.items() if not case["ok"])
        summary["baseline"] = {"exit": exit_code, "cases": len(cases), "expected": expected, "collected": list(cases),
                               "fail": failing, "copy_sha256": copy_sha, "evidence": str(work / "baseline")}
        baseline_ok = exit_code == 0 and set(cases) == set(expected) and not failing and copy_sha == summary["source"]["sha256_before"]
        missing_cases = sorted({m["case"] for m in MUTANTS} - set(cases))
        if missing_cases:
            summary["baseline"]["missing_named_cases"] = missing_cases
            baseline_ok = False
        ok = ok and bool(baseline_ok)
        for mutant in MUTANTS:
            entry = {key: mutant[key] for key in ("id", "title", "case", "expect")}
            if not baseline_ok or source_text.count(mutant["old"]) != 1:
                entry.update(killed=False, reasons=["not judged: baseline failed or anchor not unique"])
                summary["mutants"].append(entry)
                ok = False
                continue
            mutated = source_text.replace(mutant["old"], mutant["new"], 1)
            exit_code, cases, copy_sha = run_copy(args.node, mutated, work, mutant["id"])
            killed, reasons, block = judge(mutant, exit_code, cases, baseline_names)
            entry.update(killed=killed, reasons=reasons, exit=exit_code, mutated_sha256=copy_sha,
                         other_failures=sorted(n for n, c in cases.items() if not c["ok"] and n != mutant["case"]),
                         expected=expected, collected=list(cases), evidence=block, raw_evidence=str(work / mutant["id"]))
            summary["mutants"].append(entry)
            ok = ok and killed
        for control in CONTROLS:
            entry = {key: control[key] for key in ("id", "title", "case")}
            if not baseline_ok or source_text.count(control["old"]) != 1:
                entry.update(survived=False, reasons=["not judged: baseline failed or anchor not unique"])
                ok = False
            else:
                exit_code, cases, copy_sha = run_copy(args.node, source_text.replace(control["old"], control["new"], 1), work, control["id"])
                killed, reasons, _ = judge(control, exit_code, cases, baseline_names)
                survived = not killed and exit_code == 0 and set(cases) == baseline_names and all(c["ok"] for c in cases.values())
                entry.update(survived=survived, exit=exit_code, mutated_sha256=copy_sha, reasons=reasons)
                ok = ok and survived
            summary["controls"].append(entry)
    summary["source"]["sha256_after"] = sha256(SOURCE.read_bytes())
    ok = ok and summary["source"]["sha256_after"] == summary["source"]["sha256_before"]
    summary["result"] = "pass" if ok else "fail"
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.out:
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text + "\n")
    print(text)
    for entry in summary["mutants"]:
        print("{} {}: {}".format("KILLED " if entry.get("killed") else "SURVIVED", entry["id"], "; ".join(entry.get("reasons") or ["named assertion failed"])))
    for entry in summary["controls"]:
        print("{} {}".format("CONTROL SURVIVED (expected)" if entry.get("survived") else "CONTROL NOT SURVIVED (runner broken)", entry["id"]))
    print("RESULT " + summary["result"])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
