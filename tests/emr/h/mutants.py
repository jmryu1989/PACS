# coding: utf-8
"""TEST-H-MUTANTS: the EMR-H round 1 mutants M-H-01..M-H-09 (order section 8) and M-H-10..M-H-16 (extra).

Each mutant breaks one rule of api/src/emr-retention (M-H-05: of the consumed A contract) in a COPY of api/src and
requires tests/emr/h/contract_test.cjs to fail on the named case with that case's own assertion message.

Rules:
  * the source tree is never mutated: every mutant is a copy reached through KIN_EMR_RETENTION_SRC, and the unmutated
    BASELINE goes through the same override first, so a broken override cannot manufacture kills;
  * each anchor must occur exactly once in its file;
  * a kill needs a non-zero exit, the full case count reported (no harness-start failure), the target case reported
    'not ok' with failureType testCodeFailure, an AssertionError (ERR_ASSERTION) and the mutant's own `expect`
    message inside that case's block. A crash, a load failure or another case failing is never a kill;
  * live-only mutants (round 2 storage/worker paths) are not listed here; the result says so.

stdlib only. It runs `node --test --test-reporter=tap` as a child process.
"""
import argparse
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
SOURCE = ROOT / "api" / "src"
TEST = ROOT / "tests" / "emr" / "h" / "contract_test.cjs"
COPIED = ("emr-contract", "emr-retention")
INVENTORY = "emr-retention/inventory.ts"
CONTRACT = "emr-retention/contract.ts"
CASE_H01_READ = "TEST-H-01/period_extension: a read never becomes a retained part and never restarts the period"
CASE_H01_LINK = "TEST-H-01/period_extension: a comparison link from a live report does not stretch the compared image"
CASE_H01_STREAMS = "TEST-H-01/period_extension: access units leave by their stream at destruction time"
CASE_H01_HISTORY = "TEST-H-01/period_extension: change history leaves with its record, its last two-year remainder and viewing stay"
CASE_H02_REQUEST = "TEST-H-02/archive_and_holds: a request hold released at its old until cannot free a record whose request is unresolved"
CASE_H03_FAILED = "TEST-H-03/inventory_refusal: a listing that fails is an incomplete inventory, never an empty place"
CASE_H03_DEFECTS = "TEST-H-03/inventory_refusal: every unread, unregistered, partial or inconsistent inventory starts nothing"
CASE_H04_KEYS = "TEST-H-04/expired_restore_impossible: shared backups are replaced and a key that opens kept data is retained"
CASE_H04_OFFSITE = "TEST-H-04/expired_restore_impossible: an old backup kept offsite keeps the erasure partial"
CASE_H04_FILTER = "TEST-H-04/expired_restore_impossible: a restore filter never counts as erasure"
CASE_H04_SUMMARY = "TEST-H-04/expired_restore_impossible: the completion record holds kinds, counts, time and method only"
CASE_H05 = "TEST-H-05/key_lifetime: signer evidence stays for live records, expired payloads never stay as evidence"
CASE_H06_TERMINAL = "TEST-H-06/crash_resume: unconfirmed terminals never verify and an unsent original blocks the set"

MUTANTS = [
    {"id": "M-H-01", "title": "only the database rows are re-checked; an old backup kept elsewhere passes", "file": INVENTORY,
     "case": CASE_H04_OFFSITE, "expect": "an old backup copy kept offsite keeps the erasure partial",
     "old": "  for (const container of snapshot.containers) {",
     "new": "  for (const container of snapshot.containers.filter(c => ORIGINAL_CLASSES.includes(c.locationClass))) {"},
    {"id": "M-H-02", "title": "a restore filter is counted as erasure", "file": INVENTORY,
     "case": CASE_H04_FILTER, "expect": "a restore filter never counts as erasure",
     "old": "    const members = container.scopeMembers;",
     "new": "    const members = container.scopeMembers.filter(m => !container.restoreExcludes.includes(m));"},
    {"id": "M-H-03", "title": "a whole-archive key is shredded although it still opens kept data", "file": INVENTORY,
     "case": CASE_H04_KEYS, "expect": "a key that still opens a kept container must be retained",
     "old": "      disposition: protects.every(id => removed.includes(id)) ? 'erase' as const : 'retain-live-key' as const };",
     "new": "      disposition: protects.some(id => removed.includes(id)) ? 'erase' as const : 'retain-live-key' as const };"},
    {"id": "M-H-04", "title": "the nonpersonal completion record keeps the source payload hash", "file": INVENTORY,
     "case": CASE_H04_SUMMARY, "expect": "the completion record carries no identifier or digest",
     "old": "    verifiedAt: verification.at, units: assessment.recordIds.length,",
     "new": "    verifiedAt: verification.at, units: assessment.recordIds.length, sourceSha256: require('node:crypto').createHash('sha256').update(assessment.recordIds[0] + ':' + assessment.recordIds[0] + '-1').digest('hex'),"},
    {"id": "M-H-05", "title": "a read is accepted as a retained part and restarts the period (consumed A contract)",
     "file": "emr-contract/lawful-defaults.ts", "case": CASE_H01_READ, "expect": "a read must never become a retained part",
     "old": "['image', 'external-sr-seg', 'study-metadata'].includes(k)) ? ['acquisition', 'correction'] :",
     "new": "['image', 'external-sr-seg', 'study-metadata'].includes(k)) ? ['acquisition', 'correction', 'read'] :"},
    {"id": "M-H-06", "title": "a comparison (navigation) link retains the image like an incorporation", "file": INVENTORY,
     "case": CASE_H01_LINK, "expect": "a navigation link from a live record must not retain the compared image",
     "old": "      if (copy.reference.relation === 'navigation') return 'retain-other-record';",
     "new": "      if (false) return 'retain-other-record';"},
    {"id": "M-H-07", "title": "a request hold released at its old until is trusted (L5-06)", "file": INVENTORY,
     "case": CASE_H02_REQUEST, "expect": "a hold released at its old until cannot free an unresolved request",
     "old": "    if (!['pending-access-request', 'statutory-duty'].includes(hold.basis.type)) continue;",
     "new": "    if (hold.release !== null || !['pending-access-request', 'statutory-duty'].includes(hold.basis.type)) continue;"},
    {"id": "M-H-08", "title": "a failed listing is read as an empty location", "file": INVENTORY,
     "case": CASE_H03_FAILED, "expect": "a failed listing must stop the set before any start",
     "old": "  try { raw = readers().locations.list(location.locationId, scope); } catch { note(reasons, 'LocationListingFailed', at); return; }",
     "new": "  try { raw = readers().locations.list(location.locationId, scope); } catch { raw = { locationId: location.locationId, checkedAt: scope.at, complete: true, copies: [], containers: [], unattributed: 0 }; }"},
    {"id": "M-H-09", "title": "an unsent signed original on a terminal is erased like a cache", "file": INVENTORY,
     "case": CASE_H06_TERMINAL, "expect": "an unsent signed original on a terminal blocks the set",
     "old": "      note(reasons, 'PendingOriginalNotDurable', copy.locationId); return 'blocked';",
     "new": "      return 'erase';"},
    {"id": "M-H-10", "title": "signer evidence is erased while a live record still needs it", "file": INVENTORY,
     "case": CASE_H05, "expect": "identity evidence still needed by a live record is retained",
     "old": "      return copy.dependents.every(id => set.has(id)) ? 'erase' : 'retain-shared-evidence';",
     "new": "      return 'erase';"},
    {"id": "M-H-11", "title": "permission history gets the two-year access floor", "file": CONTRACT,
     "case": CASE_H01_STREAMS, "expect": "a permission change is kept three years",
     "old": "'permission-history': { clauseIds: [STATUTORY_MINIMUM.access.clauseId, 'access-safety:5.3'], years: 3, withRecord: false },",
     "new": "'permission-history': { clauseIds: [STATUTORY_MINIMUM.access.clauseId, 'access-safety:5.3'], years: STATUTORY_MINIMUM.access.years, withRecord: false },"},
    {"id": "M-H-12", "title": "the last two-year remainder of change history is erased with the record", "file": INVENTORY,
     "case": CASE_H01_HISTORY, "expect": "the last two-year remainder of change history stays behind",
     "old": "      return accessFloor(stream, occurredAt) <= at ? 'erase' : 'retain-viewing-remainder';",
     "new": "      return 'erase';"},
    {"id": "M-H-13", "title": "a change-history event is destroyed alone at two years", "file": INVENTORY,
     "case": CASE_H01_STREAMS, "expect": "change history never leaves alone, only with its record",
     "old": "  if (facts.stream === 'change-history') note(reasons, 'ChangeHistoryFollowsRecord');",
     "new": "  if (false) note(reasons, 'ChangeHistoryFollowsRecord');"},
    {"id": "M-H-14", "title": "an unregistered storage place is ignored", "file": INVENTORY,
     "case": "TEST-H-03/inventory_refusal: unregistered-location starts nothing", "expect": "defect unregistered-location must stop the set",
     "old": "      for (const id of found) if (!known.includes(id)) note(reasons, 'UnregisteredLocation', id);",
     "new": "      for (const id of found) if (false) note(reasons, 'UnregisteredLocation', id);"},
    {"id": "M-H-15", "title": "a reference added after the snapshot is ignored", "file": INVENTORY,
     "case": "TEST-H-03/inventory_refusal: concurrent-reference starts nothing", "expect": "defect concurrent-reference must stop the set",
     "old": "  for (const k of listed) if (!expected.has(k)) note(reasons, 'ReferenceNotInSnapshot');",
     "new": "  for (const k of listed) if (false) note(reasons, 'ReferenceNotInSnapshot');"},
    {"id": "M-H-16", "title": "an expired signature payload is kept as verification evidence", "file": INVENTORY,
     "case": CASE_H05, "expect": "an expired signature payload is never kept as evidence",
     "old": "    default: return 'erase';",
     "new": "    case 'signature-payload': return 'retain-shared-evidence';\n    default: return 'erase';"},
]
NOT_RUN = {
    "round-2 live": "M-H-01..M-H-09 also have live sides (real DB/Orthanc/backup/key stores, worker crash, terminal "
                    "grant expiry/logout); round 1 has no storage, worker or terminal API, so those sides are not_run "
                    "here and belong to tests/emr/h/live.py in round 2.",
}

TOP = re.compile(r"^(not ok|ok) (\d+) - (.*)$")


def blocks(output):
    """{case name: (status, block text)} for the top-level TAP points of one run."""
    found, current, lines = {}, None, []
    for line in output.splitlines():
        match = TOP.match(line)
        if match or line.startswith("# tests "):
            if current:
                found[current[1]] = (current[0], "\n".join(lines))
            current, lines = ((match.group(1), match.group(3).replace("\\#", "#")) if match else None), []
            continue
        if current:
            lines.append(line)
    if current:
        found[current[1]] = (current[0], "\n".join(lines))
    return found


def count(output):
    match = re.search(r"^# tests (\d+)$", output, re.M)
    return int(match.group(1)) if match else None


def copy_tree(target):
    for name in COPIED:
        shutil.copytree(SOURCE / name, target / name)


def run(node, src, timeout):
    env = {**os.environ, "KIN_EMR_RETENTION_SRC": str(src)}
    result = subprocess.run([node, "--test", "--test-reporter=tap", str(TEST)], cwd=str(ROOT), env=env,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return result.returncode, result.stdout + ("\n" + result.stderr if result.stderr else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--evidence-dir", default=None, help="Directory for each child run's raw TAP output")
    parser.add_argument("--only", action="append", default=[], help="Run only these mutant IDs")
    args = parser.parse_args()
    evidence = pathlib.Path(args.evidence_dir) if args.evidence_dir else None
    if evidence:
        evidence.mkdir(parents=True, exist_ok=False)
    results, ok = {"baseline": None, "mutants": [], "not_run": NOT_RUN}, True
    with tempfile.TemporaryDirectory(prefix="emr-h-mutants-") as temp:
        base = pathlib.Path(temp) / "baseline"
        copy_tree(base)
        code, output = run(args.node, base, args.timeout)
        if evidence:
            (evidence / "baseline.tap").write_text(output, encoding="utf-8")
        cases = blocks(output)
        expected = count(output)
        declaration = subprocess.run([args.node, str(TEST)], cwd=str(ROOT),
            env={**os.environ, "KIN_EMR_RETENTION_SRC": str(base), "KIN_EMR_H_LIST_CASES": "1"},
            capture_output=True, text=True, encoding="utf-8", timeout=args.timeout)
        declared = json.loads(declaration.stdout) if declaration.returncode == 0 else []
        failing = sorted(name for name, (status, _block) in cases.items() if status == "not ok")
        results["baseline"] = {"exit": code, "tests": expected, "expected": declared, "collected": list(cases), "failing": failing}
        if code != 0 or failing or not expected or expected != len(declared) or list(cases) != declared:
            print(json.dumps(results, ensure_ascii=False, indent=2))
            print("BASELINE FAILED: the unmutated copy must pass before any mutant counts", file=sys.stderr)
            return 2
        for mutant in MUTANTS:
            if args.only and mutant["id"] not in args.only:
                continue
            folder = pathlib.Path(temp) / mutant["id"]
            copy_tree(folder)
            target = folder / mutant["file"]
            text = target.read_text(encoding="utf-8")
            occurrences = text.count(mutant["old"])
            record = {"id": mutant["id"], "title": mutant["title"], "case": mutant["case"], "expect": mutant["expect"]}
            if occurrences != 1 or mutant["old"] == mutant["new"]:
                record.update(killed=False, reason=f"anchor occurs {occurrences} times")
                results["mutants"].append(record)
                ok = False
                continue
            target.write_text(text.replace(mutant["old"], mutant["new"]), encoding="utf-8")
            code, output = run(args.node, folder, args.timeout)
            if evidence:
                (evidence / f"{mutant['id']}.tap").write_text(output, encoding="utf-8")
            cases = blocks(output)
            status, block = cases.get(mutant["case"], (None, ""))
            checks = {
                "nonzero exit": code != 0,
                "all cases reported": count(output) == expected and list(cases) == declared,
                "target case not ok": status == "not ok",
                "test code failure": "failureType: 'testCodeFailure'" in block,
                "assertion error": "code: 'ERR_ASSERTION'" in block,
                "own message": mutant["expect"] in block,
            }
            killed = all(checks.values())
            record.update(killed=killed, exit=code, checks=checks,
                          failing=sorted(name for name, (s, _b) in cases.items() if s == "not ok"))
            if not killed:
                ok = False
            results["mutants"].append(record)
    results["summary"] = {"declared": len(MUTANTS), "run": len(results["mutants"]),
                          "killed": sum(1 for m in results["mutants"] if m["killed"])}
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if ok and results["summary"]["run"] == len(MUTANTS if not args.only else results["mutants"]) else 1


if __name__ == "__main__":
    sys.exit(main())
