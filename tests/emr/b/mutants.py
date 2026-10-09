"""EMR-B1 mutants M01-M08, M11, M12, M14-M37 (emr/units/b.json `mutants`; order section 9).

Each mutant is one declared change applied to a separate copy of the committed checkout (`git archive HEAD`), never to
this working tree. Its declared kill cases run in that copy: contract cases (Cnn) through `node --test` with TAP output
and a name pattern, live cases (Lnn) through the copy's own scripts/run-tests.py with a plan that selects exactly those
EmrBLedgerLive cases and a production API image built from the mutated copy. A mutant is killed only when every declared
kill case has a behavioural assertion failure; a harness error, build failure, a missing case or a refusal before the case ran is not a kill.

Per mutant the record keeps the exact change, the cases, the expected failure, each run's exit code and raw log path, and
the changed file's SHA-256 before the change, while mutated, and after the restore (which must equal the first).

A killed live run leaves the live gate's inspection marker. This driver releases it only through the gate's own
protocol: after the run it lists every container and volume carrying live.py's label key; with none left it writes an
inspection record of that run (identity copied from the marker) and calls release_after_inspection. With anything left
the gate stays closed and the run is reported as needing inspection.

    python tests/emr/b/mutants.py --out tmp/emr-b1/mutants [--only M03,M04] [--contract-only]
    python tests/emr/b/mutants.py --self-test
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
    "M03": ("business COMMIT loses its original ledger append", [
        ("api/src/emr-runtime/store.ts", "    const act = statutoryAct(input, served), entries: ProvisionalEntry[] = [];", "    return Object.freeze({provisional: true, eventId: input.eventId, entries: []});\n    const act = statutoryAct(input, served), entries: ProvisionalEntry[] = [];")]),
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
        ("api/src/emr-runtime/store.ts", "      this.note(eventId, 'append-rolled-back', cause, attempt?.attemptId);\n", "")]),
    "M06": ("one display name joins two verified subjects into one member", [
        ("api/src/emr-runtime/contract.ts",
         "  const id = string(await resolve(claims.issuer, claims.subject));\n",
         "  const id = string(await resolve(claims.issuer, claims.displayName ?? claims.subject));\n")]),
    "M07": ("an audit link ID or a session reference passes as a credential", [
        ("api/src/emr-runtime/contract.ts", "/^(audit|authref):/i.test(value.trim())", "/^(?!)/.test(value.trim())")]),
    "M08": ("a forwarded address header is believed from any peer", [
        ("api/src/emr-runtime/contract.ts", "if (!peer || !trustedPeers.has(peer) || typeof real", "if (!peer || typeof real")]),
    "M11": ("the sealed tail may be rolled back", [
        ("api/src/emr-runtime/seal.ts", "    if (tail.sequence < current.sequence) throw new SealRefused('LedgerBehindSeal', stream);\n", ""),
        ("api/src/emr-runtime/seal.ts", "    if (sealed.sequence !== current.sequence || sealed.hash !== current.hash) throw new SealRefused('SealTailMismatch', stream);\n", "")]),
    "M12": ("an entry before its end under the retention rule (unexpired, or bound to a record whose end is unknown) is planned into the expired prefix", [
        ("api/src/emr-runtime/contract.ts", "    if (deadline === null || deadline > now || row.held) break;\n", "    if (row.held) break;\n")]),
    "M14": ("a declared live case missing from (or added to) its test file is accepted", [
        ("scripts/emr-compose.py", "    if live != expected_live:\n", "    if live is None:\n")]),
    "M15": ("checkpoint authority does not require preserved external prefix proof", [
        ("api/src/emr-runtime/seal.ts", "    if (!core || q.chainId !== chainId", "    if (!core) { const p=JSON.parse(entry.payload); return {anchor:{sequence:p.deletedThrough,hash:p.anchorHash}} as ExpiryCore; }\n    if (!core || q.chainId !== chainId")]),
    "M16": ("torn bytes remain in the good journal after quarantine", [
        ("api/src/emr-runtime/journal-file.ts", "fs.ftruncateSync(fd, goodLength);", "/* missing repair */")]),
    "M17": ("native clinical directions get only five years", [
        ("api/src/emr-contract/classification.ts", "original decision, including a code-only direction', clinical, chart)", "original decision, including a code-only direction', clinical, images)")]),
    "M18": ("registration with no original direction is accepted", [
        ("api/src/emr-contract/classification.ts", "  if (r.objectKind === 'registration' && r.directionSourceRef === null && r.origin !== 'migrated') refuse('DirectionSourceRequired');\n", "")]),
    "M19": ("a retransmission resets the first local receipt clock", [
        ("api/src/emr-contract/lawful-defaults.ts", " || before.firstReceivedAt !== after.firstReceivedAt", "")]),
    "M20": ("unanswered review silently ends on the internal deadline", [
        ("api/src/emr-contract/lawful-defaults.ts", "if (at >= p.finalDecisionDueAt) return 'superior-decision-overdue';", "if (at >= p.finalDecisionDueAt) return 'clear';")]),
    "M21": ("a claim end timestamp needs no actual ending evidence", [
        ("api/src/emr-contract/lawful-defaults.ts", "    string(d.endingEventId);\n", "")]),
    "M22": ("a changed seed is still treated as verified synthetic", [
        ("api/src/emr-contract/classification.ts", "s.originalSha256 !== s.observedSha256 || ", "")]),
    "M23": ("a subsequent event can drop an inherited original duty", [
        ("api/src/emr-contract/lawful-defaults.ts", "before.inherited.some(d => !after.inherited.some(n => JSON.stringify(d) === JSON.stringify(n))) ||", "false ||"),
        ("api/src/emr-contract/lawful-defaults.ts", "before.feed?.roles.some(role => role !== 'worklist-copy' && !after.feed?.roles.includes(role))", "false")]),
    "M24": ("a new clinical version needs no link to the prior preserved version", [
        ("api/src/emr-runtime/contract.ts",
         "    if (previous.event.versionId !== e.versionId && (e.predecessor?.recordId !== previous.recordId ||\n"
         "        e.predecessor?.partId !== previous.event.versionId || e.predecessor?.sha256 !== previous.event.sha256)) refuse('OrderHistoryIncomplete');\n", "")]),
    "M25": ("expiry settles an in-flight append as absent and permanently loses its intent", [
        ("api/src/emr-runtime/store.ts", "  const rows: RetentionRow[] = [];\n", "  await seal.recoverAtStart();\n  const rows: RetentionRow[] = [];\n")]),
    "M26": ("a rolled-back expiry leaves reusable proof for a forged checkpoint", [
        ("api/src/emr-runtime/store.ts", "    if (callbackFailed) seal.abort('viewing', attemptId);\n", "")]),
    "M27": ("a second calendar owner as a class method goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export class DuplicateCalendar { end(at: string) { return civilPeriodEnd(at, 2); } }\nexport interface ChainTail")]),
    "M28": ("a second calendar owner as an exported arrow goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export const duplicateCalendar = (at: string) => civilPeriodEnd(at, 2);\nexport interface ChainTail")]),
    "M29": ("a second calendar owner as a function expression goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export const duplicateCalendar = function(at: string) { return civilPeriodEnd(at, 2); };\nexport interface ChainTail")]),
    "M30": ("a second calendar owner at module scope goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export const duplicateCalendar = civilPeriodEnd('2026-01-01T00:00:00.000Z', 2);\nexport interface ChainTail")]),
    "M31": ("stale prepared expiry proof supersedes the latest exact reservation", [
        ("api/src/emr-runtime/seal.ts", "const core: ExpiryCore = q && state.proofs[key('viewing', q.attemptId)];",
         "const core: ExpiryCore = Object.values(state.proofs).find((p:any)=>p.binding.sequence===entry.sequence); if(core)return core;"),
        ("api/src/emr-runtime/seal.ts", "    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;", "    if(entry.kind==='expiry')return;\n    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;")]),
    "M32": ("I1: prepared expiry proof is authoritative without marker/slot/generation binding (X-STALE)", [
        ("api/src/emr-runtime/seal.ts", "const core: ExpiryCore = q && state.proofs[key('viewing', q.attemptId)];",
         "const core: ExpiryCore = Object.values(state.proofs).find((p:any)=>p.binding.sequence===entry.sequence); if(core)return core;"),
        ("api/src/emr-runtime/seal.ts", "    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;", "    if(entry.kind==='expiry')return;\n    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;")]),
    "M33": ("I2: startup vetoes pending before negative settlement", [
        ("api/src/emr-runtime/seal.ts", "    return this.sql.withWriterFence(async sql => {", "    return this.sql.withWriterFence(async sql => {\n      if(Object.keys(this.load().intents).length)throw new SealRefused('UnsealedEntryUnexplained','pending-conflict');")]),
    "M34": ("I3: a healthy own COMMIT waits for every unrelated pending event", [
        ("api/src/emr-runtime/seal.ts", "      try { result = await reader.snapshot(async sql => {", "      try { result = await reader.snapshot(async sql => {\n        for(const i of Object.values(this.load().intents))if(i.eventId&&!await sql.entryForEvent(i.stream,i.eventId))throw new SealRefused('UnsealedEntryUnexplained','pending-conflict');")]),
    "M35": ("I4: job reports success before its own checkpoint seal", [
        ("api/src/emr-runtime/store.ts", "  await seal.reconcileCommitted('viewing', { sequence: result.checkpointSequence, hash: result.checkpointHash });\n", "")]),
    "M36": ("per-operation Node startup returns to the head-locked writer: concurrent receipt latency exceeds the round-3 budget", [
        ("api/src/emr-runtime/coordinator.ts", "    try { return executeExternal(request); }",
         "    require('node:child_process').spawnSync(process.execPath, ['-e', '']); // Reintroduced per-reservation worker startup under the head lock.\n    try { return executeExternal(request); }")]),
    "M37": ("a verification snapshot aliases the coordinator index and accepts another writer's changed binding", [
        ("api/src/emr-runtime/external-writer.ts", "return { changed: true, result: clone(result) };", "return { changed: true, result };")]),

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


def make_copy(target, worktree=False):
    """The committed checkout (HEAD) as files, with this checkout's installed api/node_modules linked in."""
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip()
    archive = subprocess.run(["git", "archive", "--format=tar", head], cwd=ROOT, capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter="data") if sys.version_info >= (3, 12) else tar.extractall(target)
    if worktree:
        tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
        declaration = json.loads(DECLARATION.read_text(encoding="utf-8"))
        tracked = sorted(set(filter(None, tracked)) | {name for group in declaration["owned_paths"].values() for name in group})
        for name in filter(None, tracked):
            origin, destination = ROOT / name, target / name
            if origin.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(origin, destination)
            elif destination.exists():
                destination.unlink()
        (target / "mutant-inputs.json").write_text(json.dumps({name: sha256(ROOT / name) for name in tracked if name and (ROOT / name).is_file()}, sort_keys=True), encoding="utf-8")
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
        os.rmdir(link)  # Remove this verified junction only, never its shared target tree.
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


def contract_verdict(text, cases, code):
    blocks = re.findall(r"^not ok \d+ - (C\d+) [^\n]*\n(.*?)(?=^# Subtest:|^ok |^not ok |^1\.\.|\Z)", text, re.M | re.S)
    failed = {case for case, details in blocks if case in cases and re.search(r"code: ['\"]?ERR_ASSERTION\b", details)}
    harness = any(case in cases and not re.search(r"code: ['\"]?ERR_ASSERTION\b", details) for case, details in blocks)
    passed = {case for case in cases if re.search(r"^ok \d+ - " + case + r" ", text, re.M)}
    return {"failed": sorted(failed), "passed": sorted(passed), "harness_errors": harness,
            "killed": code != 0 and failed == set(cases) and not harness}


def live_verdict(text, cases, code):
    failed = {case for case in cases if re.search(r"^FAIL: " + LIVE[case] + r" \(", text, re.M)}
    harness = bool(re.search(r"^ERROR: ", text, re.M))
    return {"failed": sorted(failed), "harness_errors": harness,
            "killed": code != 0 and failed == set(cases) and not harness}


def contract_kills(copy, cases, out, name, env):
    """Run the copy's contract file for these case IDs; each must be reported `not ok`."""
    pattern = "^(" + "|".join(cases) + ") "
    log = out / (name + "-contract.log")
    code, seconds = run(["node", "--test", "--test-reporter=tap", "--test-name-pattern=" + pattern, "tests/emr/b/contract_test.cjs"],
                        cwd=copy, env=env, timeout=900, log=log)
    text = log.read_text(encoding="utf-8", errors="replace")
    return {"kind": "contract", "cases": cases, "exit": code, "seconds": seconds, "log": str(log),
            **contract_verdict(text, cases, code)}


def invariant_witness(copy, out, name, env):
    """Keep the designated invariant's concrete trace, not only C13's assertion exit."""
    expected = {"M32": "I1-stale-proof", "M33": "I2", "M34": "I3", "M35": "I4"}[name]
    result_file, log = out / (name + "-checker.json"), out / (name + "-checker.log")
    code, seconds = run(["node", "tests/emr/b/seal_checker.cjs", str(copy),
        str(copy / "api/node_modules/typescript"), str(result_file), "named"],
        cwd=copy, env=env, timeout=180, log=log)
    try:
        result = json.loads(result_file.read_text(encoding="utf-8"))
        witness = result["witnesses"].get(expected)
        if name == "M33":
            # I2's designated control is a normal E -> open A/B -> crash/start,
            # not an incidental refusal while preparing an unrelated tamper probe.
            restart = result["named"]["RACE-3"]
            witness = {"trace": ["E:COMMIT", "E:success", "A:open", "B:open", "crash", "recoverAtStart"],
                       "detail": restart} if restart.get("found") is True else None
        healthy = name != "M32" or (not result["named"]["RACE-1"]["found"]
            and result["named"]["RACE-2"]["restart"] == "ok" and not result["named"]["RACE-3"]["found"])
    except (OSError, ValueError, KeyError, TypeError):
        witness, healthy = None, False
    return {"kind": "invariant-witness", "expected": expected, "exit": code, "seconds": seconds,
        "killed": code == 1 and bool(witness) and healthy, "witness": witness,
        "healthy_control": healthy, "result": str(result_file), "log": str(log)}


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


def wait_for_live_gate(copy, minutes=90):
    """Another unit's live run holds the account's lease (or awaits its own inspection): wait for it, never touch it."""
    sys.path.insert(0, str(copy / "tests"))
    import live_test_gate as gate
    deadline = time.monotonic() + minutes * 60
    while time.monotonic() < deadline:
        try:
            gate.preflight_live()
            return
        except gate.Refused:
            time.sleep(5)
    raise RuntimeError("another run still owns the live lease or inspection marker")


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
        wait_for_live_gate(copy)
        code, seconds = run([sys.executable, "-B", "scripts/run-tests.py", "--plan", str(plan)], cwd=copy,
                        env={**env, "KIN_TEST_API_IMAGE": tag, "KIN_EMR_BASELINE_REPOSITORY": str(ROOT)}, timeout=3300, log=log)
        text = log.read_text(encoding="utf-8", errors="replace")
        # Only a behavioural assertion (FAIL) kills a mutant. KeyError, setup errors and all other ERROR sections
        # are harness failures even when their heading names the selected case.
        verdict = live_verdict(text, cases, code)
        passed = {case for case in cases if re.search(r"^" + LIVE[case] + r" \([\w.]+\)(?:\n(?!test_)[^\n]*?)? \.\.\. ok$", text, re.M)}
        # A run the gate refused before any case ran (another unit held the account's live lease) proves nothing either way.
        started = "EXACT_TESTS " in text
        result.update(unit=unit, exit=code, seconds=seconds, log=str(log), **verdict, passed=sorted(passed),
                      **({} if started else {"status": "not_run", "reason": "live run refused before any case ran (gate lease)"}))
        if not started:
            result["killed"] = None
        result["gate"] = release_gate(copy, unit, code, log, out, name) if code else {"marker": "not-needed"}
    finally:
        subprocess.run(["docker", "image", "rm", "-f", tag], capture_output=True, timeout=300)
    return result


def self_test():
    """Behavioural verdicts and the pinned live baseline's source boundary, without Docker."""
    import unittest
    import importlib.util
    from unittest.mock import patch
    class VerdictTest(unittest.TestCase):
        def test_live_baseline_from_gitless_mutant_copy(self):
            spec = importlib.util.spec_from_file_location('emrb_baseline_probe', ROOT / 'tests/emr/b/live.py')
            live = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(live)
            clean = {k: v for k, v in os.environ.items()
                     if not k.startswith('GIT_') and k != 'KIN_EMR_BASELINE_REPOSITORY'}
            expected = subprocess.check_output(['git', 'show', live.BASELINE + ':api/src/emr-runtime/seal.ts'],
                                               cwd=ROOT, env=clean).decode().replace('\r\n', '\n')
            class BaselineReady(Exception):
                pass
            probe = type('ArchiveProbe', (), {'token': 'source-probe', 'label': 'kin.emrb.live=source-probe'})()
            actual_run = live.run
            def before_docker(args, **kwargs):
                if args[:2] == ['docker', 'build']:
                    self.assertEqual((Path(args[-1]) / 'src/emr-runtime/seal.ts').read_text(), expected)
                    raise BaselineReady()
                return actual_run(args, **kwargs)
            with tempfile.TemporaryDirectory(prefix='emrb-gitless-') as directory, \
                    patch.object(live, 'ROOT', Path(directory)), patch.object(live, 'run', side_effect=before_docker), \
                    patch.dict(os.environ, clean, clear=True):
                with self.assertRaises(RuntimeError):
                    live.EmrBLedgerLive.baseline_appends(probe, 24)
                with patch.dict(os.environ, {'KIN_EMR_BASELINE_REPOSITORY': str(ROOT)}):
                    with self.assertRaises(BaselineReady):
                        live.EmrBLedgerLive.baseline_appends(probe, 24)
                with patch.object(live, 'ROOT', ROOT):
                    with self.assertRaises(BaselineReady):
                        live.EmrBLedgerLive.baseline_appends(probe, 24)

        def test_live_assertion_and_key_error_are_distinct(self):
            name = "test_b05_expiry_checkpoint_and_holds (live.EmrBLedgerLive)"
            self.assertTrue(live_verdict("FAIL: " + name + "\nAssertionError: expected expiry", ["L05"], 1)["killed"])
            self.assertFalse(live_verdict("ERROR: " + name + "\nKeyError: deleted_count", ["L05"], 1)["killed"])
            self.assertFalse(live_verdict("FAIL: " + name + "\nERROR: tearDownClass\n", ["L05"], 1)["killed"])

        def test_contract_assertion_and_harness_exception_are_distinct(self):
            prefix = "not ok 1 - C13 expiry proof\n  ---\n  code: "
            self.assertTrue(contract_verdict(prefix + "'ERR_ASSERTION'\n  ...\n1..1\n", ["C13"], 1)["killed"])
            self.assertFalse(contract_verdict(prefix + "'ReferenceError'\n  ...\n1..1\n", ["C13"], 1)["killed"])
            self.assertFalse(contract_verdict(prefix + "'ERR_ASSERTION'\n  ...\n1..1\n", ["C13"], 0)["killed"])

        def test_missing_case_and_wrong_case_are_not_kills(self):
            self.assertFalse(contract_verdict("not ok 1 - test file\n", ["C13"], 1)["killed"])
            self.assertFalse(live_verdict("FAIL: test_b04_chain_tail_and_crash_recovery (live.EmrBLedgerLive)\n", ["L05"], 1)["killed"])
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(VerdictTest)
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--self-test", action="store_true", help="verify verdicts and baseline source without Docker")
    parser.add_argument("--only", help="comma-separated mutant IDs")
    parser.add_argument("--worktree", action="store_true", help="snapshot tracked uncommitted inputs; preserve their hashes")
    parser.add_argument("--contract-only", action="store_true", help="run contract kill cases only (live ones are reported not_run)")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if args.out is None:
        parser.error("--out is required unless --self-test is selected")
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
        head, link = make_copy(copy, args.worktree)
        if args.worktree:
            shutil.copyfile(copy / "mutant-inputs.json", out / "mutant-inputs.json")
        try:
            baseline_log = out / "baseline-contract.log"
            baseline_code, baseline_seconds = run(["node", "--test", "--test-reporter=tap", "tests/emr/b/contract_test.cjs"],
                cwd=copy, env=env, timeout=900, log=baseline_log)
            expected_cases = json.loads(DECLARATION.read_text(encoding="utf-8"))["cases"]["contract"]["B1"]
            expected_ids = {case.split()[0] for case in expected_cases}
            passed = re.findall(r"^ok \d+ - (C\d+) ", baseline_log.read_text(encoding="utf-8", errors="replace"), re.M)
            baseline = dict(exit=baseline_code, seconds=baseline_seconds, passed=passed, expected=sorted(expected_ids))
            (out / "baseline.json").write_text(json.dumps(baseline, indent=2), encoding="utf-8")
            if baseline_code or len(passed) != len(expected_ids) or set(passed) != expected_ids:
                raise RuntimeError("unmutated copy did not pass its complete contract selection; no mutant verdict is valid")
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
                    if name in {"M32", "M33", "M34", "M35"}:
                        runs.append(invariant_witness(copy, out, name, env))
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
