"""EMR-B1 mutants M01-M08, M11, M12, M14 (emr/units/b.json `mutants`; order section 9).

Each mutant is one declared change applied to a separate copy of the committed checkout (`git archive HEAD`), never to
this working tree. Its declared kill cases run in that copy: contract cases (Cnn) through `node --test` with TAP output
and a name pattern, live cases (Lnn) through the copy's own scripts/run-tests.py with a plan that selects exactly those
EmrBLedgerLive cases and a production API image built from the mutated copy. A mutant is killed only when every declared
kill case is reported failed; a build failure, a missing case or a refusal before the case ran is not a kill.

Per mutant the record keeps the exact change, the cases, the expected failure, each run's exit code and raw log path, and
the changed file's SHA-256 before the change, while mutated, and after the restore (which must equal the first).

A killed live run leaves the live gate's inspection marker. This driver releases it only through the gate's own
protocol: after the run it lists every container and volume carrying live.py's label key; with none left it writes an
inspection record of that run (identity copied from the marker) and calls release_after_inspection. With anything left
the gate stays closed and the run is reported as needing inspection.

    python tests/emr/b/mutants.py --out tmp/emr-b1/mutants [--only M03,M04] [--contract-only]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
DECLARATION = ROOT / "emr" / "units" / "b.json"
MIGRATION = "api/prisma/migrations/20261008120000_emr_b/migration.sql"
LIVE = {
    "L01": "test_b01_ledger_roles_and_restart", "L02": "test_b02_business_commit_and_failure_journal",
    "L03": "test_b03_idempotency_and_concurrent_append", "L04": "test_b04_chain_tail_and_crash_recovery",
    "L05": "test_b05_expiry_checkpoint_and_holds", "L06": "test_b06_complete_reload_and_clause_history",
    "L07": "test_b07_migration_backup_restore_roles", "L08": "test_b08_receipt_before_body",
}
LIVE_LABEL_KEY = "kin.emrb.live"
END_OF_MIGRATION = "  emr_access.storage_placement() TO kin_emr_retention;\nCOMMIT;\n"

# id -> (expected failure, [(path, before, after), ...]). `before` occurs exactly once in its file.
MUTANTS = {
    "M01": ("the runtime login is a member of the ledger owner: role checks and SET ROLE refusals fail", [
        (MIGRATION, END_OF_MIGRATION,
         "  emr_access.storage_placement() TO kin_emr_retention;\nGRANT kin_emr_owner TO kin_runtime;\nCOMMIT;\n")]),
    "M02": ("the runtime login may switch triggers off with session_replication_role", [
        (MIGRATION, END_OF_MIGRATION,
         "  emr_access.storage_placement() TO kin_emr_retention;\nGRANT SET ON PARAMETER session_replication_role TO kin_runtime;\nCOMMIT;\n")]),
    "M03": ("the business transaction commits without its ledger fact: no receipt, no projection join", [
        ("api/src/emr-runtime/store.ts",
         "      const result: AppendResult = await this.appendRow(tx, stream, event.eventId, text, act);\n",
         "      const result = { chainId: '', sequence: 0, previousHash: '', hash: '', storedAt: '', replay: false } as AppendResult;\n")]),
    "M04": ("body bytes leave before the durable receipt (and with no receipt at all)", [
        ("api/src/emr-runtime/contract.ts",
         "  return provideAfterDurableEvent(store, input, async receipt => {\n"
         "    if (!isDurableReceipt(receipt)) refuse('DurableReceiptRefused');\n"
         "    return sendBody(receipt);\n"
         "  });\n",
         "  const early = sendBody({ eventId: input.eventId, durableAt: new Date().toISOString() });\n"
         "  try { await provideAfterDurableEvent(store, input, async receipt => receipt); } catch { /* sent anyway */ }\n"
         "  return early;\n")]),
    "M05": ("a rolled-back business change leaves no failure journal record", [
        ("api/src/emr-runtime/store.ts", "    this.note(eventId, 'append-rolled-back', cause);\n", "")]),
    "M06": ("one display name joins two verified subjects into one member", [
        ("api/src/emr-runtime/contract.ts",
         "  const id = string(await resolve(claims.issuer, claims.subject));\n",
         "  const id = string(await resolve(claims.issuer, claims.displayName ?? claims.subject));\n")]),
    "M07": ("an audit link ID or a session reference passes as a credential", [
        ("api/src/emr-runtime/contract.ts", "/^(audit|authref):/i.test(value.trim())", "/^(?!)/.test(value.trim())")]),
    "M08": ("a forwarded address header is believed from any peer", [
        ("api/src/emr-runtime/contract.ts", "if (!peer || !trustedPeers.has(peer) || typeof real", "if (!peer || typeof real")]),
    "M11": ("start-up never compares the database chain with the trusted seal", [
        ("api/src/emr-runtime/seal.ts", "        if (tail.sequence < current.sequence) throw new SealRefused('LedgerBehindSeal', stream);\n", ""),
        ("api/src/emr-runtime/seal.ts",
         "          const sealed = entries.find(e => e.sequence === current.sequence);\n"
         "          if (sealed ? sealed.hash !== current.hash : current.sequence > anchor.sequence || (current.sequence === anchor.sequence && current.hash !== anchor.hash))\n"
         "            throw new SealRefused('SealTailMismatch', stream);\n", "")]),
    "M12": ("an entry before its end under the retention rule (unexpired, or bound to a record whose end is unknown) is planned into the expired prefix", [
        ("api/src/emr-runtime/contract.ts", "    if (deadline === null || deadline > now || row.held) break;\n", "    if (row.held) break;\n")]),
    "M14": ("a declared live case missing from (or added to) its test file is accepted", [
        ("scripts/emr-compose.py", "    if live != expected_live:\n", "    if live is None:\n")]),
}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, *, cwd, env=None, timeout, log):
    started = time.monotonic()
    with open(log, "wb") as out:
        try:
            code = subprocess.run(args, cwd=cwd, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            code = 124
    return code, round(time.monotonic() - started, 1)


def make_copy(target):
    """The committed checkout (HEAD) as files, with this checkout's installed api/node_modules linked in."""
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip()
    archive = subprocess.run(["git", "archive", "--format=tar", head], cwd=ROOT, capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter="data") if sys.version_info >= (3, 12) else tar.extractall(target)
    modules = ROOT / "api" / "node_modules"
    if not modules.is_dir():
        raise SystemExit("api/node_modules is required (npm ci --prefix api)")
    link = target / "api" / "node_modules"
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(modules.resolve())], check=True, capture_output=True)
    else:
        link.symlink_to(modules.resolve(), target_is_directory=True)
    return head, link


def unlink_modules(link):
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "rmdir", str(link)], check=True, capture_output=True)
    else:
        link.unlink()


def apply(copy, changes):
    """Apply every change of one mutant; returns [(path, original bytes, hashes)]. Line endings follow the file."""
    applied = []
    for path, before, after in changes:
        file = copy / path
        raw = file.read_bytes()
        text = raw.decode("utf-8")
        crlf = "\r\n" in text
        old, new = (before.replace("\n", "\r\n"), after.replace("\n", "\r\n")) if crlf else (before, after)
        if text.count(old) != 1:
            raise RuntimeError("mutant anchor not found exactly once: " + path)
        previous = next((item for item in applied if item["path"] == path), None)
        file.write_bytes(text.replace(old, new).encode("utf-8"))
        if previous is None:
            applied.append({"path": path, "original": raw, "before_sha256": hashlib.sha256(raw).hexdigest()})
    for item in applied:
        item["mutated_sha256"] = sha256(copy / item["path"])
    return applied


def restore(copy, applied):
    for item in applied:
        (copy / item["path"]).write_bytes(item["original"])
        item["restored_sha256"] = sha256(copy / item["path"])
        if item["restored_sha256"] != item["before_sha256"]:
            raise RuntimeError("restore differs: " + item["path"])
        del item["original"]


def contract_kills(copy, cases, out, name, env):
    """Run the copy's contract file for these case IDs; each must be reported `not ok`."""
    pattern = "^(" + "|".join(cases) + ") "
    log = out / (name + "-contract.log")
    code, seconds = run(["node", "--test", "--test-reporter=tap", "--test-name-pattern=" + pattern, "tests/emr/b/contract_test.cjs"],
                        cwd=copy, env=env, timeout=900, log=log)
    text = log.read_text(encoding="utf-8", errors="replace")
    failed = {case for case in cases if re.search(r"^\s*not ok \d+ - " + case + r" ", text, re.M)}
    passed = {case for case in cases if re.search(r"^\s*ok \d+ - " + case + r" ", text, re.M)}
    return {"kind": "contract", "cases": cases, "exit": code, "seconds": seconds, "log": str(log),
            "failed": sorted(failed), "passed": sorted(passed), "killed": code != 0 and failed == set(cases)}


def leftovers():
    found = []
    for args in (["docker", "ps", "-aq", "--filter", "label=" + LIVE_LABEL_KEY],
                 ["docker", "volume", "ls", "-q", "--filter", "label=" + LIVE_LABEL_KEY]):
        found += subprocess.run(args, capture_output=True, timeout=60).stdout.decode().split()
    return found


def release_gate(copy, unit, code, log, out, name):
    """After a failed live run: inspect this run's labelled resources, then release through the gate's protocol."""
    sys.path.insert(0, str(copy / "tests"))
    import live_test_gate as gate  # the copy's gate: the same account-wide state directory
    marker = gate.STATE / "live-needs-inspection.json"
    if not marker.is_file():
        return {"marker": "absent"}
    identity = json.loads(marker.read_text(encoding="utf-8"))
    if identity.get("unit") != unit:
        return {"marker": "foreign", "unit": identity.get("unit")}
    remaining = leftovers()
    if remaining:
        return {"marker": "kept", "remaining": remaining}
    time.sleep(0.05)
    record = out / (name + "-inspection.json")
    record.write_text(json.dumps({**identity, "inspected_at": datetime.now(timezone.utc).isoformat(),
        "inspector": "tests/emr/b/mutants.py", "exit": code, "artifacts": [str(log)],
        "stack": {"label_key": LIVE_LABEL_KEY, "containers": [], "volumes": [], "note": "mutant run; its own labelled resources only"}}),
        encoding="utf-8")
    gate.release_after_inspection(record)
    return {"marker": "released", "record": str(record)}


def live_kills(copy, cases, out, name, head, env):
    """Build the production image from the mutated copy and run exactly these live cases through run-tests.py."""
    token = secrets.token_hex(4)
    tag = "kin-emrb-mutant:%s-%s" % (name.lower(), token)
    build_log = out / (name + "-image.log")
    code, seconds = run(["docker", "build", "--target", "production", "--label", "kin.emrb.mutant=" + token, "--build-arg",
                         "VCS_REF=emr-b-mutant", "-t", tag, str(copy / "api")], cwd=copy, timeout=1800, log=build_log)
    result = {"kind": "live", "cases": cases, "image_build_exit": code, "image_build_seconds": seconds, "image_log": str(build_log)}
    if code:
        result.update(killed=False, reason="image build failed (not a kill)")
        return result
    try:
        unit = "emr-b1-mut-%s-%s" % (name.lower(), head[:10])
        plan = out / (name + "-plan.json")
        plan.write_text(json.dumps({"unit": unit, "mode": "live", "max_attempts": 3, "timeout_seconds": 3000,
            "tests": [{"file": "tests/emr/b/live.py", "case": "EmrBLedgerLive." + LIVE[case]} for case in cases]}), encoding="utf-8")
        log = out / (name + "-live.log")
        code, seconds = run([sys.executable, "-B", "scripts/run-tests.py", "--plan", str(plan)], cwd=copy,
                            env={**env, "KIN_TEST_API_IMAGE": tag}, timeout=3300, log=log)
        text = log.read_text(encoding="utf-8", errors="replace")
        # unittest's failure section names each failed or erroring case (also through a subtest); a class fixture error
        # ("ERROR: setUpClass") names no case and so kills nothing.
        failed = {case for case in cases if re.search(r"^(?:FAIL|ERROR): " + LIVE[case] + r" \(", text, re.M)}
        passed = {case for case in cases if re.search(r"^" + LIVE[case] + r" \([\w.]+\)(?:\n(?!test_)[^\n]*?)? \.\.\. ok$", text, re.M)}
        result.update(unit=unit, exit=code, seconds=seconds, log=str(log), failed=sorted(failed), passed=sorted(passed),
                      killed=code != 0 and failed == set(cases))
        result["gate"] = release_gate(copy, unit, code, log, out, name) if code else {"marker": "not-needed"}
    finally:
        subprocess.run(["docker", "image", "rm", "-f", tag], capture_output=True, timeout=300)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--only", help="comma-separated mutant IDs")
    parser.add_argument("--contract-only", action="store_true", help="run contract kill cases only (live ones are reported not_run)")
    args = parser.parse_args(argv)
    declared = {m["id"]: m for m in json.loads(DECLARATION.read_text(encoding="utf-8"))["mutants"]}
    if set(declared) != set(MUTANTS):
        raise SystemExit("declared mutants differ from this driver: %s" % sorted(set(declared) ^ set(MUTANTS)))
    chosen = [m for m in declared if not args.only or m in args.only.split(",")]
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "KIN_EMR_PYTHON": os.environ.get("KIN_EMR_PYTHON", sys.executable), "PYTHONIOENCODING": "utf-8"}
    rows = []
    with tempfile.TemporaryDirectory(prefix="kin-emrb-mutants-") as folder:
        copy = Path(folder) / "checkout"
        copy.mkdir()
        head, link = make_copy(copy)
        try:
            for name in chosen:
                expected, changes = MUTANTS[name]
                kill = declared[name]["kill"]
                row = {"id": name, "behaviour": declared[name]["behaviour"], "expected_failure": expected, "kill": kill,
                       "changes": [{"path": p, "before": b, "after": a} for p, b, a in changes], "head_sha": head}
                applied = apply(copy, changes)
                try:
                    runs = []
                    contract = [case for case in kill if case.startswith("C")]
                    live = [case for case in kill if case.startswith("L")]
                    if contract:
                        runs.append(contract_kills(copy, contract, out, name, env))
                    if live and args.contract_only:
                        runs.append({"kind": "live", "cases": live, "killed": None, "status": "not_run", "reason": "--contract-only"})
                    elif live:
                        runs.append(live_kills(copy, live, out, name, head, env))
                    row["runs"] = runs
                finally:
                    restore(copy, applied)
                row["files"] = applied
                row["killed"] = all(r["killed"] for r in row["runs"]) if all(r["killed"] is not None for r in row["runs"]) else None
                rows.append(row)
                (out / "mutants.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
                print("MUTANT %s killed=%s %s" % (name, row["killed"], json.dumps([(r["kind"], r.get("exit"), r.get("failed")) for r in row["runs"]])), flush=True)
        finally:
            unlink_modules(link)
    survived = [r["id"] for r in rows if r["killed"] is False]
    print("MUTANTS_RESULT " + json.dumps({"head_sha": head, "chosen": chosen, "survived": survived,
                                          "not_run": [r["id"] for r in rows if r["killed"] is None]}))
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
