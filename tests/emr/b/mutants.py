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
        # D1700 re-anchor: the (c) retention scope settles the rolled-back expiry (localRetentionScope.failed).
        ("api/src/emr-runtime/store.ts", "      if (rolledBack) seal.abort('viewing', attemptId);\n", "")]),
    "M27": ("a second calendar owner as a class method goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export class DuplicateCalendar { end(at: string) { return civilPeriodEnd(at, 2); } }\nexport interface ChainTail")]),
    "M28": ("a second calendar owner as an exported arrow goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export const duplicateCalendar = (at: string) => civilPeriodEnd(at, 2);\nexport interface ChainTail")]),
    "M29": ("a second calendar owner as a function expression goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export const duplicateCalendar = function(at: string) { return civilPeriodEnd(at, 2); };\nexport interface ChainTail")]),
    "M30": ("a second calendar owner at module scope goes undetected", [
        ("api/src/emr-runtime/contract.ts", "export interface ChainTail", "export const duplicateCalendar = civilPeriodEnd('2026-01-01T00:00:00.000Z', 2);\nexport interface ChainTail")]),
    "M31": ("stale prepared expiry proof supersedes the latest exact reservation", [
        ("api/src/emr-runtime/seal.ts", "const core: ExpiryCore = q && view.proofs[key('viewing', q.attemptId)];",
         "const core: ExpiryCore = Object.values(view.proofs).find((p:any)=>p.binding.sequence===entry.sequence); if(core)return core;"),
        ("api/src/emr-runtime/seal.ts", "    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;", "    if(entry.kind==='expiry')return;\n    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;")]),
    "M32": ("I1: prepared expiry proof is authoritative without marker/slot/generation binding (X-STALE)", [
        ("api/src/emr-runtime/seal.ts", "const core: ExpiryCore = q && view.proofs[key('viewing', q.attemptId)];",
         "const core: ExpiryCore = Object.values(view.proofs).find((p:any)=>p.binding.sequence===entry.sequence); if(core)return core;"),
        ("api/src/emr-runtime/seal.ts", "    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;", "    if(entry.kind==='expiry')return;\n    const marker = suppliedMarker === undefined ? await sql.markerForSlot(stream, entry.sequence) : suppliedMarker;")]),
    "M33": ("I2: startup vetoes pending before negative settlement", [
        ("api/src/emr-runtime/seal.ts", "    return this.sql.withWriterFence(async sql => {", "    return this.sql.withWriterFence(async sql => {\n      if(Object.keys(this.load().intents).length)throw new SealRefused('UnsealedEntryUnexplained','pending-conflict');")]),
    "M34": ("I3: a healthy own COMMIT waits for every unrelated pending event", [
        ("api/src/emr-runtime/seal.ts", "        const verifySnapshot = async (sql: PrismaLedgerSql, page?: VerificationPage) => {", "        const verifySnapshot = async (sql: PrismaLedgerSql, page?: VerificationPage) => {\n        for(const i of Object.values(this.load().intents))if(i.eventId&&!await sql.entryForEvent(i.stream,i.eventId))throw new SealRefused('UnsealedEntryUnexplained','pending-conflict');")]),
    "M35": ("I4: job reports success before its own checkpoint seal", [
        # D1700 re-anchor: the (c) retention scope seals the committed checkpoint (localRetentionScope.committed).
        ("api/src/emr-runtime/store.ts", "    async committed(binding: CommitBinding) { await seal.reconcileCommitted('viewing', { sequence: binding.sequence, hash: binding.hash }); },\n",
         "    async committed(binding: CommitBinding) { void binding; },\n")]),
    "M36": ("per-operation Node startup returns to the head-locked writer: concurrent receipt latency exceeds the round-3 budget", [
        # D1700 re-anchor: the (c) owner reserves through an explicit patch record (kind 'reserve') on the lock-owning writer.
        ("api/src/emr-runtime/coordinator.ts", "    return executeExternal(request);\n",
         "    if (operation === 'patch' && value?.kind === 'reserve') require('node:child_process').spawnSync(process.execPath, ['-e', '']);\n    return executeExternal(request);\n")]),
    "M38": ("A7 replay trusts a sealed DB row without binding its bytes through the external seal", [
        ("api/src/emr-runtime/seal.ts", "await reader.snapshot(sql => this.bindSealedTarget(sql, view, stream, target));", "void 0; /* missing sealed-target binding */")]),
    "M39": ("head-lock waiters acquire every pool connection ahead of a committed request's verification", [
        ("api/src/emr-runtime/admission.ts", "if (pool.active >= capacity)", "if (false)")]),
    "M40": ("append lanes consume the verification reserve", [
        ("api/src/emr-runtime/limits.ts", "export const EMR_VERIFY_RESERVE = 2;", "export const EMR_VERIFY_RESERVE = 0;")]),
    "M41": ("a reservation is acknowledged without its durable merged WAL record", [
        ("api/src/emr-runtime/external-writer.ts", "    engine.walOffset += append(engine.log, body, context);\n",
         "    if (kind !== 'reserve') engine.walOffset += append(engine.log, body, context);\n")]),
    "M42": ("merged reservation omits its recovery intent", [
        ("api/src/emr-runtime/seal.ts", "      if (!intent) changes.intents![id] = owned;", "      if (false) changes.intents![id] = owned;")]),
    "M37": ("a verification snapshot aliases the coordinator index and accepts another writer's changed binding", [
        ("api/src/emr-runtime/external-writer.ts", "return { changed: true, result: clone(result) };", "return { changed: true, result };")]),

}

# D1641 uses the same isolated-copy/apply/restore and behavioral-verdict machinery.
# Mutation strings locate the intentional changes; no acceptance assertion inspects
# a private product name or source spelling. M08 awaits the legacy compatibility gate.
# D1684 re-anchor: the seal now reads the owner's view (`view`, `get`, `slot-of`) and writes explicit `patch` records of
# the changed members; the terminal lookup of reserve is `this.terminal(id)` and the live acknowledgement patches the
# acknowledged attestation plus the owner-less terminals. Compaction streams the engine's member maps into a navigable
# checkpoint. Each mutant keeps its original semantic fault at the same decision point of the rewritten code.
_RESERVE_TERMINAL_CHECK = "    if (this.terminal(id)) refuse('AttemptAlreadySettled');\n    const pendingPosition"
_ACK_PATCH = ("    changes.bundles!['bundle:' + id] = { version: 1, phase: 'acknowledged', serviceEpoch: previous.serviceEpoch, refs: previous.refs, proofSha256: digest(actual) };\n"
              "    // Caller ownership is no longer required after exact full-proof delivery.\n"
              "    for (const b of bindings) {\n"
              "      const terminal = this.terminal(key(b.stream, b.attemptId));\n"
              "      if (terminal && terminal.owner !== undefined) { const { owner: _, ...rest } = terminal; changes.terminal![key(b.stream, b.attemptId)] = rest; }\n"
              "    }\n")
_ACK_ERASES = ("    changes.bundles!['bundle:' + id] = null;\n"
               "    for (const b of bindings) changes.terminal![key(b.stream, b.attemptId)] = null;\n")
TERMINAL_MUTANTS = {
    # D1660: in the (c) service the exact full-proof acknowledgement is acknowledgeBundle (the local-owner acknowledge()
    # is a no-op the service never calls). The fault: the acknowledgement erases the durable terminal identity instead
    # of only its caller ownership; the engine refuses an attestation whose terminals are gone, so the fault is the
    # consistent erasure of the attestation and the terminal identities.
    "D1641-M01": ("acknowledgement deletes the durable terminal identity", [
        ("api/src/emr-runtime/seal.ts", _ACK_PATCH, _ACK_ERASES)]),
    "D1641-M02": ("a new client instance bypasses another client's terminal exclusion", [
        ("api/src/emr-runtime/seal.ts", _RESERVE_TERMINAL_CHECK,
         "    if (this.terminal(id)?.owner === owner) refuse('AttemptAlreadySettled');\n    const pendingPosition")]),
    "D1641-M03": ("changed mutable binding fields evade the terminal identity check", [
        ("api/src/emr-runtime/seal.ts", _RESERVE_TERMINAL_CHECK,
         "    { const settled = this.terminal(id); if (settled && same(settled.binding, { ...binding, generation: settled.generation, proofDigest: null })) refuse('AttemptAlreadySettled'); }\n    const pendingPosition")]),
    "D1641-M04": ("reserve persists a generation before refusing the terminal", [
        ("api/src/emr-runtime/seal.ts", _RESERVE_TERMINAL_CHECK,
         "    if (this.terminal(id)) { this.patch({}, { generation: view.generation + 1 }); refuse('AttemptAlreadySettled'); }\n    const pendingPosition")]),
    # D1684: compaction streams the terminal and bundle maps into the new checkpoint; a checkpoint that drops the
    # terminal identities can only load if their attestations go with them (unchanged semantic fault: durable exclusion
    # lost at compaction; D1641-T06's restart replay observes it as a mutated durable state).
    "D1641-M05": ("checkpoint compaction drops terminal identities", [
        ("api/src/emr-runtime/external-writer.ts",
         "map => (map === 'terminal' ? engine.terminal : engine.bundles).rawEntries(), false, () => engine.close());",
         "map => (map === 'terminal' ? [] : []) as [string, string][], false, () => engine.close());")]),
    "D1641-M06": ("terminal WAL success is returned without its flush barrier", [
        ("api/src/emr-runtime/external-writer.ts", "fs.writeFileSync(context.log.fd, line); fs.fdatasyncSync(context.log.fd);",
         "fs.writeFileSync(context.log.fd, line);")]),
    "D1641-M07": ("all valid new reservations are refused", [
        ("api/src/emr-runtime/seal.ts", _RESERVE_TERMINAL_CHECK,
         "    refuse('AttemptAlreadySettled');\n    const pendingPosition")]),
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


def make_copy(target, worktree=False, source_manifest=None):
    """The committed checkout (HEAD) as files, with this checkout's installed api/node_modules linked in."""
    if source_manifest:
        # A Linux copy need not carry the commander's Windows Git metadata.
        # Copy only the explicitly hash-bound source inventory; reject drift.
        manifest = json.loads(Path(source_manifest).read_text(encoding="utf-8"))
        head = manifest["base_head"]
        for name, expected in manifest["files"].items():
            origin, destination = ROOT / name, target / name
            if (Path(name).is_absolute() or '..' in Path(name).parts or
                    not destination.resolve().is_relative_to(target.resolve()) or
                    not origin.resolve().is_relative_to(ROOT.resolve()) or sha256(origin) != expected):
                raise RuntimeError("source manifest mismatch: " + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, destination)
        (target / "mutant-inputs.json").write_text(json.dumps(manifest["files"], sort_keys=True), encoding="utf-8")
    else:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip()
        archive = subprocess.run(["git", "archive", "--format=tar", head], cwd=ROOT, capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(target, filter="data") if sys.version_info >= (3, 12) else tar.extractall(target)
    if worktree and not source_manifest:
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
    blocks = re.findall(r"^not ok \d+ - ([\w.-]+) [^\n]*\n(.*?)(?=^# Subtest:|^ok |^not ok |^1\.\.|\Z)", text, re.M | re.S)
    failed = {case for case, details in blocks if case in cases and re.search(r"code: ['\"]?ERR_ASSERTION\b", details)}
    harness = any(case in cases and not re.search(r"code: ['\"]?ERR_ASSERTION\b", details) for case, details in blocks)
    passed = {case for case in cases if re.search(r"^ok \d+ - " + case + r" ", text, re.M)}
    return {"failed": sorted(failed), "passed": sorted(passed), "harness_errors": harness,
            "killed": code != 0 and failed == set(cases) and not harness}


IDENTITY_MUTANTS = {
    "D1655-M01": ("aggregate attestation returns before its WAL flush", [
        ("api/src/emr-runtime/external-writer.ts", "fs.writeFileSync(context.log.fd, line); fs.fdatasyncSync(context.log.fd);",
         "fs.writeFileSync(context.log.fd, line); if (!Object.values(body.patch?.bundles ?? {}).some((a:any) => a?.phase === 'published')) fs.fdatasyncSync(context.log.fd);")]),
    # D1684: the acknowledgement's durable record is its one `patch` (acknowledged attestation + owner-less terminals);
    # minimization = that record, reclamation = the later amortized compaction (never forced by an ack).
    "D1655-M02": ("ack returns without its durable minimized record", [
        ("api/src/emr-runtime/seal.ts", "    this.patch(changes);\n    return 'acknowledged';\n", "    return 'acknowledged';\n")]),
    "D1655-M03": ("ack silently succeeds after its durable record failed", [
        ("api/src/emr-runtime/seal.ts", "    this.patch(changes);\n    return 'acknowledged';\n",
         "    try { this.patch(changes); } catch { /* swallowed */ }\n    return 'acknowledged';\n")]),
    "D1655-M04": ("a retained proof is returned for a changed historical bundle", [
        ("api/src/emr-runtime/seal.ts", "    if (retained) return matches(retained);\n", "    if (retained) return retained;\n")]),
    "D1650-M01": ("requested-slot lookup accepts a moved pending attempt", [
        ("api/src/emr-runtime/seal.ts", "pending = pendingPosition ? view.slots[pendingPosition] : undefined",
         "pending = (void pendingPosition, view.slots[position]?.attemptId === binding.attemptId ? view.slots[position] : undefined)")]),
    "D1650-M02": ("omitting entry hash accepts a changed body", [
        ("api/src/emr-runtime/seal.ts", "bindingFields.every(field => a[field] === b[field])",
         "bindingFields.filter(field => field !== 'hash').every(field => a[field] === b[field])")]),
    "D1650-M03": ("stored expiry prefix is ignored", [
        ("api/src/emr-runtime/seal.ts", " || !samePrefix(view.proofs[id], prefix)", "")]),
    "D1650-M03-LATEST": ("latest issued prefix wrongly replaces original replay authority", [
        ("api/src/emr-runtime/seal.ts", "if (pending) {\n", "if (pending) {\n        if (prefix && admission && !samePrefix(admission.issuedPrefix, prefix)) refuse('AccessEventIdConflict');\n")]),
    "D1650-M04": ("persisting before conflict violates write-free refusal", [
        ("api/src/emr-runtime/seal.ts", "    if (pending) {\n      if (!intent",
         "    if (view.intents[id]) this.patch({}, { generation: view.generation + 1 });\n    if (pending) {\n      if (!intent")]),
    "D1650-M05": ("client identity alone adopts another live work", [
        ("api/src/emr-runtime/seal.ts", " || !this.origins.get(origin)?.has(id)", "")]),
    # D1660 (see D1641-M01): the live acknowledgement is acknowledgeBundle.
    "D1650-M06": ("ack erases permanent identity", [
        ("api/src/emr-runtime/seal.ts", _ACK_PATCH, _ACK_ERASES)]),
    # D1684: identity validation at startup is the streaming admission's identity closure of the small maps against
    # the terminal map (external-writer.ts scanCheckpoint), the per-record closure of every settlement the recovering
    # owner writes (Engine.validateTouched) and validateAttemptIdentities for the materialized whole-state operations.
    # A startup that normalizes contradictory records instead of refusing them is the fault only when no layer refuses;
    # the mutant silences the identity refusal of all three (three edits, one fault).
    "D1650-M07": ("startup normalizes contradictory attempt state", [
        ("api/src/emr-runtime/external-writer.ts", "      const corrupt = (): never => fail('UnsealedEntryUnexplained');\n      const validBinding",
         "      const corrupt = (): never => undefined as never;\n      const validBinding"),
        ("api/src/emr-runtime/external-writer.ts", "    const corrupt = (): never => fail('UnsealedEntryUnexplained');\n    const tailStreams",
         "    const corrupt = (): never => undefined as never;\n    const tailStreams"),
        ("api/src/emr-runtime/external-writer.ts", "  validateAttemptIdentities(state);\n", "")]),
    # D1660/D1684: rejecting the alias inside the admission closure would fail D1650-T08A at its publication step, not
    # at the load the case judges, so the same fault (a retained sealed expiry alias treated as a contradictory live
    # attempt) is injected where only a (re)starting owner reads the stored state: pair admission.
    "D1650-M07-ALIAS": ("valid historical expiry alias is rejected", [
        ("api/src/emr-runtime/external-writer.ts",
         "      context.pair = clone(origin);\n      context.copy = admission!.copy;\n",
         "      if (Object.values(engine.slots).some((q: any) => engine.terminal.get(q.stream + ':' + q.attemptId))) return fail('UnsealedEntryUnexplained');\n"
         "      context.pair = clone(origin);\n      context.copy = admission!.copy;\n")]),
    "D1650-M08": ("a committed tombstone is misclassified as fenced negative", [
        ("api/src/emr-runtime/state-service.ts", "terminal?.phase === 'aborted' && exactBinding(b, terminal.binding)",
         "terminal && exactBinding(b, terminal.binding)")]),
    "D1650-M11-FLUSH": ("WAL reply omits durable flush", [
        ("api/src/emr-runtime/external-writer.ts", "fs.writeFileSync(context.log.fd, line); fs.fdatasyncSync(context.log.fd);",
         "fs.writeFileSync(context.log.fd, line);")]),
    "D1650-M12": ("rejecting all reserves breaks valid traffic", [
        ("api/src/emr-runtime/seal.ts", _RESERVE_TERMINAL_CHECK, "    refuse('AccessEventIdConflict');\n" + _RESERVE_TERMINAL_CHECK)]),
    "D1650-M12-STREAM": ("global attempt identity rejects the legitimate second stream", [
        ("api/src/emr-runtime/seal.ts", "pending = pendingPosition ? view.slots[pendingPosition] : undefined",
         "pending = (void pendingPosition, Object.values(view.slots).find(q => q.attemptId === binding.attemptId))")]),
    "D1650-M12-ERROR": ("ordinary conflicts stop the service", [
        ("api/src/emr-runtime/seal.ts", "refuse('AccessEventIdConflict');\n      result = pending;",
         "throw new SealRefused('SealUnavailable');\n      result = pending;")]),
}


# EMR-B2 (c) API-side behavioural mutants (frozen C-M04/M07/M08/M09/M10/M13/M14/M15/M16 mapping), killed by the
# declared (c) API component cases (emr/units/b.json b2c.local_api_cases, selected by EMR_B2C_API_CASES; the real
# launcher child cases among them). Each is one deliberate edit of the API-side runtime; the kill is the named
# behavioural assertion of its case, never an import/setup/timeout failure.
API_MUTANTS = {
    "C-M04-LOST-SESSION": ("a lost control session still admits new recording scopes", [
        ("api/src/emr-runtime/remote-state.ts",
         "    if (this.client.unavailable.aborted) throw new SealRefused('SealUnavailable', 'state-service-lost');\n", "")]),
    "C-M07-RESEND": ("a lost confirm reply is resolved by resending the confirmation instead of the service's fenced lookup", [
        ("api/src/emr-runtime/remote-state.ts",
         "      try { outcome = await this.call('lookup-outcome', bundle); } catch { outcome = null; }\n",
         "      try { outcome = { outcome: 'committed-and-sealed', proof: await this.call('confirm-bundle', bundle) } as any; } catch { outcome = null; }\n")]),
    "C-M08-NOT-COMMITTED": ("an unknown outcome (no fenced knowledge) is classified as not committed", [
        ("api/src/emr-runtime/remote-state.ts",
         "      else if (outcome?.outcome === 'fenced-not-committed') {",
         "      else if (!outcome || outcome.outcome === 'fenced-not-committed') {")]),
    "C-M08-CALLBACK-FAILED": ("the caller's callbackFailed claim is trusted over the observed rejection", [
        ("api/src/emr-runtime/record-port.ts",
         "          return run(() => entry.bound.settleTransaction(entry.raw, input, error, entry.callbackFailed, served));",
         "          return run(() => entry.bound.settleTransaction(entry.raw, input, error, _callbackFailed, served));")]),
    "C-M09-NO-BIND": ("the exact reservation is not bound in the business transaction before COMMIT", [
        ("api/src/emr-runtime/store.ts", "        await this.bindCommit(tx, binding);\n", "")]),
    "C-M09-REPLAY-RESERVES": ("a replay of a stored event takes a new reservation instead of its original binding", [
        ("api/src/emr-runtime/store.ts", "      if (!result.replay) {\n        binding = await scope.reserve(", "      if (true) {\n        binding = await scope.reserve(")]),
    "C-M10-UNVERIFIED-PROOF": ("the service's proof is accepted without local revalidation against the exact bindings", [
        ("api/src/emr-runtime/remote-state.ts", "    verifyProof(appended, bundle, proof);\n", "")]),
    "C-M13-UNTRACKED-IMPORT": ("the rights import runs outside the owned background registry", [
        ("api/src/auth.service.ts",
         "    this.background.tryRun('auth.importRights', signal => this.importRights(1, signal));",
         "    void this.importRights(1, new AbortController().signal);")]),
    "C-M14-RAW-CAPABILITY": ("the transaction projection exposes a raw client capability", [
        ("api/src/emr-runtime/transaction-port.ts", "  return Object.freeze(projection);\n}",
         "  projection.$queryRaw = (...args: unknown[]) => (raw as any).$queryRaw(...args);\n  return Object.freeze(projection);\n}")]),
    "C-M14-EARLY-RETIREMENT": ("a work is retired from the drain before its remote scope ended", [
        ("api/src/emr-runtime/record-port.ts",
         "        void closing.then(() => { live--; settle(); }, () => { live--; settle(); });",
         "        live--; settle(); void closing.catch(() => undefined);")]),
    "C-M15-OBSERVER-ONLY": ("the raw HTTP admission observes the stop but dispatches a stopped request to Nest", [
        ("api/src/emr-runtime/http-admission.ts",
         "  function dispatch(request: IncomingMessage, response: ServerResponse) {\n    if (stopSignal.aborted) { rejectStopped(response); return; }\n    downstream.call(server, request, response);\n  }",
         "  function dispatch(request: IncomingMessage, response: ServerResponse) {\n    downstream.call(server, request, response);\n  }")]),
    "C-M15-NO-FORCE-CLOSE": ("sockets beyond the drain bound are never force closed", [
        ("api/src/emr-runtime/http-admission.ts", "    destroyAll() { for (const socket of sockets) socket.destroy(); },", "    destroyAll() { },")]),
    "C-M16-NO-SETTLEMENT": ("the drain omits the started background tasks' settlement", [
        ("api/src/emr-runtime/background-work.ts",
         "    drained(): Promise<void> { return tasks.size === 0 ? Promise.resolve() : new Promise<void>(resolve => waiting.push(() => resolve())); },",
         "    drained(): Promise<void> { return Promise.resolve(); },")]),
    "C-M16-RESET-DEADLINE": ("each cleanup step renews the shared fatal deadline", [
        ("api/src/emr-runtime/launcher.ts",
         "      const waited = await (fatal ??= budget(EMR_CLEANUP_TIMEOUT_MS)).race(release(entry));",
         "      const waited = await (fatal = budget(EMR_CLEANUP_TIMEOUT_MS)).race(release(entry));")]),
}


# KIN-EMR-STATE-V4 semantic mutants V4-M01..M12 (order section 8; emr/units/b.json b2c.v4_mutants). Each is one
# deliberate fault of the v4 engine, codec, seal anchor or entry-mode admission; the kill is the named behavioural
# assertion of a declared case run in its suite: `service-v4` (state_service_test.cjs under EMR_STATE_FORMAT=4),
# `service-v3` (the v3 pass: V4-T08 conversion/export, entry modes) or `codec` (checkpoint_v4_test.cjs, EMR_V4_CASES).
V4_MUTANTS = {
    "V4-M01": ("page checksum bypassed: altered page bytes are consumed", [
        ("api/src/emr-runtime/checkpoint-v4.ts",
         "  if (!domainHashRaw(DOMAIN.page, bytes.subarray(0, FOOTER_OFFSET)).equals(bytes.subarray(FOOTER_OFFSET))) corrupt(d + ':footer');\n", ""),
        ("api/src/emr-runtime/checkpoint-v4.ts",
         "  if (createHash('sha256').update(bytes.subarray(0, FOOTER_OFFSET)).digest('hex') !== pageSha256FromFooter(bytes) || expect.ref.sha256 !== bytes.subarray(FOOTER_OFFSET).toString('hex')) corrupt(d + ':reference-checksum');\n", "")]),
    "V4-M02": ("a missing/corrupt page on the route is answered as absence", [
        ("api/src/emr-runtime/external-writer.ts",
         "    try { raw = this.tree.get(key); } catch (error) { throw translateV4(error); }\n",
         "    try { raw = this.tree.get(key); } catch { raw = undefined; }\n")]),
    "V4-M03": ("a collision bucket answers by digest alone (the full key is ignored)", [
        ("api/src/emr-runtime/checkpoint-v4.ts",
         "        const pair = this.bucketPairs(entry).find(p => p[0] === key);\n",
         "        const pair = this.bucketPairs(entry)[0];\n")]),
    "V4-M04": ("the touched-closure validation of a transition is omitted", [
        ("api/src/emr-runtime/external-writer.ts",
         "    engine.apply(body, touched, undo);\n    engine.validateTouched(touched, body.publishing);\n  } catch (error) { revert(); throw error; }\n  const revision = body.revision, revisionText = String(revision);\n  const writer = v.writer",
         "    engine.apply(body, touched, undo);\n  } catch (error) { revert(); throw error; }\n  const revision = body.revision, revisionText = String(revision);\n  const writer = v.writer")]),
    "V4-M05": ("success is exposed without the durable selector publication", [
        ("api/src/emr-runtime/external-writer.ts",
         "    writeSelector(engine.file, { format: V4_FORMAT, version: 4, layout: 1, rootSha256: nextRoot, revision: revisionText, wal: { segment: v.segment.segment, offset: String(complete.end), lsn: String(v.lsn + 2), previousSha256: complete.sha256 } });\n    // The transition is the accepted root: advance the view.\n",
         "    // The transition is the accepted root: advance the view.\n")]),
    "V4-M06": ("admission keeps the selector's root and ignores completed transitions after it", [
        ("api/src/emr-runtime/external-writer.ts",
         "        root = readRoot(v4, r.nextRoot); rootSha256 = r.nextRoot; outstanding = null; adoptedEnd = item.end;\n",
         "        outstanding = null;\n")]),
    "V4-M07": ("pending work is never recorded for a live attempt", [
        ("api/src/emr-runtime/external-writer.ts",
         "      const attempt = engine.intents[id] && slot ? { kind: 'attempt', stateKey: id, slotKey: slot, proofKey: engine.proofs[id] ? id : null, revision: revisionText } : null;\n",
         "      const attempt = null;\n")]),
    "V4-M08": ("the fast path trusts the witness anchor without the chain's actual first retained row", [
        ("api/src/emr-runtime/seal.ts",
         "    if (!full && (this.anchors.get(stream) === anchorKey ||\n",
         "    if (!full && (this.anchors.has(stream) ||\n")]),
    "V4-M09": ("the complete-check age is never measured from the last completion", [
        ("api/src/emr-runtime/external-writer.ts",
         "  const completedAt = Date.parse(v.root.fullCheck.completedAt), ageMs = at - completedAt;\n",
         "  const completedAt = Date.parse(v.root.fullCheck.completedAt), ageMs = (void completedAt, 0);\n")]),
    "V4-M10": ("a dead pack the running sweep's pinned root still reads is reclaimed", [
        ("api/src/emr-runtime/external-writer.ts",
         "    if ((v.packs.get(pack) ?? 0) !== 0 || pack === v.writer?.currentPack || (v.sweepOrphans && v.sweepOrphans.has(pack))) {",
         "    if ((v.packs.get(pack) ?? 0) !== 0 || pack === v.writer?.currentPack) {")]),
    "V4-M10-LIVE": ("a forced reclamation unlinks packs the selected root still references", [
        ("api/src/emr-runtime/external-writer.ts",
         "    if (live.has(pack) || pinned.has(pack) || pack === v.writer?.currentPack) { retained++; continue; }\n",
         "    if (pinned.has(pack) || pack === v.writer?.currentPack) { retained++; continue; }\n")]),
    "V4-M11": ("the rollback export reads the segment's base root, not the selected root (post-conversion work omitted)", [
        ("api/src/emr-runtime/external-writer.ts",
         "    const v = engine.v4!;\n    const head = { version: 3 as const,",
         "    const v = (() => { const x = engine.v4!; const base = WalSegment.read(x.segment.file, 0).records[0].record; const old = base.type === 'start' ? readRoot(x.directory, base.baseRoot) : x.root; const trees: Record<number, Tree> = {}; for (const d of old.trees) trees[d.id] = Tree.open(x.store, d.id, d.ref, parseDecimal(d.count, 'root')); return { ...x, trees }; })();\n    const head = { version: 3 as const,")]),
    "V4-M12": ("the entry mode's format admission is bypassed: a v3-mode process admits a v4 root", [
        ("api/src/emr-runtime/external-writer.ts",
         "    if (format !== 4) return fail('SealUnsupportedFormat');\n    return admitEngineV4(engine, selector, pair, repair, inventory);\n",
         "    return admitEngineV4(engine, selector, pair, repair, inventory);\n")]),
    "V4-M13": ("a page split fills one page and leaves a one-member remainder (fan-out grows with the member count; the parent overflows)", [
        ("api/src/emr-runtime/checkpoint-v4.ts",
         "  const k = greedy.length;\n  if (k === 1) return greedy;\n",
         "  const k = greedy.length;\n  if (k >= 1) return folded();\n")]),
    "V4-M14": ("a relocation leaves the owner's large maps on the superseded root (its pages are orphans, their packs reclaimed)", [
        ("api/src/emr-runtime/external-writer.ts",
         "    (engine.terminal as V4Map).rebind(trees[5]); (engine.bundles as V4Map).rebind(trees[6]);\n",
         "")]),
    # RC-03 (order 05): the scratch accounting of an earlier incarnation is trusted as deletion authority at admission.
    "V4-M15": ("a stale scratch accounting naming the selected root is adopted at admission (a reachable pack it names at zero is unlinked)", [
        ("api/src/emr-runtime/external-writer.ts",
         "    if (repair) { try { fs.rmSync(packsFile(v4), { force: true }); } catch { /* scratch */ } }\n",
         "    const scratchPacks: any = readScratch(packsFile(v4)); const trusted: Map<string, number> | null = scratchPacks && scratchPacks.root === rootSha256 ? new Map(scratchPacks.live as [string, number][]) : null;\n"),
        ("api/src/emr-runtime/external-writer.ts",
         "      sweep, latched: null, writer: null, packs: null, dead: new Set(), liveness: null, overflowRoutes: null, relocateCursor: null,\n",
         "      sweep, latched: null, writer: null, packs: trusted, dead: new Set(trusted ? [...trusted].filter(([, n]) => n === 0).map(([p]) => p) : []), liveness: null, overflowRoutes: null, relocateCursor: null,\n")]),
    # RC-03 (S1-PRE-15): a relocation continues past a page it could not read on a candidate pack (the damage is swallowed).
    "V4-M16": ("a relocation skips an unreadable page of a live pack and continues (current-route damage is swallowed, not latched)", [
        ("api/src/emr-runtime/external-writer.ts",
         "      if (unverified) return refuse('relocate:' + pack + ':unreadable-live:' + unverified);\n",
         "      if (unverified) continue;\n")]),
    # RC-03 (S1-PRE-14): an overflow chain of a pack being evacuated is left where it is (a sparse overflow-only pack never empties).
    "V4-M17": ("an evacuated overflow chain stays in its pack (relocation never moves overflow pages)", [
        ("api/src/emr-runtime/checkpoint-v4.ts",
         "          if (!evacuate || !chain.some(p => evacuate.has(p.pack))) continue;\n",
         "          continue;\n")]),
}
V4_SUITES = {
    "service-v4": {"command": ["tests/emr/b/state_service_test.cjs"], "variable": "EMR_SERVICE_CASES", "env": {"EMR_STATE_FORMAT": "4"}, "declared": "local_service_cases"},
    "service-v3": {"command": ["tests/emr/b/state_service_test.cjs"], "variable": "EMR_SERVICE_CASES", "env": {}, "declared": "local_service_cases"},
    "codec": {"command": ["tests/emr/b/checkpoint_v4_test.cjs"], "variable": "EMR_V4_CASES", "env": {}, "declared": None},
}


def v4_main(args):
    """V4-M01..M12: per suite one unmutated baseline of the union of the declared kill cases and one rename/alias/
    format control of the codec module, then each mutant in the isolated copy with exactly its kill cases."""
    declaration = json.loads(DECLARATION.read_text(encoding="utf-8"))["b2c"]
    declared = {item["id"]: item for item in declaration["v4_mutants"]}
    if set(declared) != set(V4_MUTANTS):
        raise RuntimeError("v4 mutant declaration differs from driver: %s" % sorted(set(declared) ^ set(V4_MUTANTS)))
    chosen = [name for name in declared if not args.only or name in args.only.split(",")]
    if args.only and set(chosen) != set(args.only.split(",")):
        raise RuntimeError("unknown v4 mutant selection")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k not in {"EMR_B2C_SOURCE_ROOT", "EMR_SERVICE_CASES", "EMR_V4_CASES", "EMR_STATE_FORMAT", "EMR_B2C_API_CASES"}}
    env.update(KIN_EMR_PYTHON=os.environ.get("KIN_EMR_PYTHON", sys.executable), PYTHONIOENCODING="utf-8")
    for name in chosen:
        suite = declared[name]["suite"]
        if suite not in V4_SUITES:
            raise RuntimeError(name + ": unknown suite " + suite)
        if V4_SUITES[suite]["declared"] and any(case not in declaration[V4_SUITES[suite]["declared"]] for case in declared[name]["kill"]):
            raise RuntimeError(name + ": kill case not declared for " + suite)
    rows = []
    with tempfile.TemporaryDirectory(prefix="kin-emrb-v4-") as folder:
        copy = Path(folder) / "checkout"
        copy.mkdir()
        head, link = make_copy(copy, args.worktree, args.source_manifest)
        try:
            if (copy / "mutant-inputs.json").exists():
                shutil.copyfile(copy / "mutant-inputs.json", out / "mutant-inputs.json")
            node = ["node", "--max-old-space-size=3072", "--test", "--test-concurrency=1", "--test-reporter=tap"]
            def run_suite(suite, cases, log, extra_env=None):
                spec = V4_SUITES[suite]
                run_env = {**env, **spec["env"], spec["variable"]: ",".join(cases), **(extra_env or {})}
                code, seconds = run(node + spec["command"], cwd=copy, env=run_env, timeout=1800, log=log)
                text = log.read_text(encoding="utf-8", errors="replace")
                return code, seconds, text
            # Baselines: per suite, the union of the chosen mutants' kill cases must pass unmutated.
            baselines = {}
            for suite in V4_SUITES:
                cases = sorted({case for name in chosen if declared[name]["suite"] == suite for case in declared[name]["kill"]})
                if not cases:
                    continue
                code, seconds, text = run_suite(suite, cases, out / ("baseline-" + suite + ".log"))
                passed = sorted(set(re.findall(r"^ok \d+ - (V4-T[0-9]{2}|[\w.-]+) ", text, re.M)) & set(cases))
                failed = re.findall(r"^not ok \d+ - ([\w.-]+) ", text, re.M)
                baselines[suite] = {"exit": code, "seconds": seconds, "cases": cases, "passed": passed, "failed": failed}
                if code or passed != cases or failed:
                    (out / "baselines.json").write_text(json.dumps(baselines, indent=2) + "\n", encoding="utf-8")
                    raise RuntimeError("unmutated copy did not pass the %s selection; no v4 mutant verdict" % suite)
            # Control: a semantics-preserving rename/alias/layout change of the codec module must still pass.
            control_file = copy / "api/src/emr-runtime/checkpoint-v4.ts"
            original = control_file.read_bytes()
            renamed = original.decode("utf-8").replace("pageSha256FromFooter", "footerDigestOf").replace(
                "import { createHash, randomBytes } from 'node:crypto';", "import { createHash as hashFactory, randomBytes } from 'node:crypto';").replace("createHash(", "hashFactory(")
            control_file.write_bytes(renamed.replace("export class PackStore {", "\nexport class PackStore {").encode("utf-8"))
            control_sha = sha256(control_file)
            try:
                controls = {}
                for suite, baseline in baselines.items():
                    code, seconds, text = run_suite(suite, baseline["cases"], out / ("control-" + suite + ".log"))
                    passed = sorted(set(re.findall(r"^ok \d+ - ([\w.-]+) ", text, re.M)) & set(baseline["cases"]))
                    controls[suite] = {"exit": code, "seconds": seconds, "passed": passed}
            finally:
                control_file.write_bytes(original)
            control = {"before_sha256": hashlib.sha256(original).hexdigest(), "control_sha256": control_sha, "restored_sha256": sha256(control_file), "suites": controls}
            (out / "baselines.json").write_text(json.dumps(baselines, indent=2) + "\n", encoding="utf-8")
            (out / "oracle-control.json").write_text(json.dumps(control, indent=2) + "\n", encoding="utf-8")
            if control["before_sha256"] != control["restored_sha256"] or any(c["exit"] or c["passed"] != baselines[s]["cases"] for s, c in controls.items()):
                raise RuntimeError("rename/alias/format control failed; no v4 mutant verdict")
            for name in chosen:
                expected, changes = V4_MUTANTS[name]
                suite, kill = declared[name]["suite"], declared[name]["kill"]
                applied = apply(copy, changes)
                log = out / (name + ".log")
                try:
                    code, seconds, text = run_suite(suite, kill, log)
                    verdict = contract_verdict(text, kill, code)
                    failures = dict(re.findall(r"^not ok \d+ - ([\w.-]+) [^\n]*\n(.*?)(?=^# Subtest:|^ok |^not ok |^1\.\.|\Z)", text, re.M | re.S))
                    intended = set(declared[name]["assertions"]) == set(kill) and all(
                        message in failures.get(case, "") for case, message in declared[name]["assertions"].items())
                    row = {"id": name, "head": head, "suite": suite, "expected_failure": expected, "kill": kill, "exit": code, "seconds": seconds,
                           "log": str(log), **verdict, "intended_assertions": intended, "killed": verdict["killed"] and intended}
                finally:
                    restore(copy, applied)
                row["files"] = applied
                rows.append(row)
                (out / "mutants.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
                print("V4_MUTANT " + json.dumps({"id": name, "killed": row["killed"], "failed": row["failed"], "intended": intended}), flush=True)
        finally:
            unlink_modules(link)
    print("V4_MUTANTS_RESULT " + json.dumps({"head_sha": head, "chosen": chosen, "survived": [r["id"] for r in rows if not r["killed"]]}))
    return 0 if rows and all(row["killed"] for row in rows) else 1


def terminal_main(args):
    """A clean passing source copy is mandatory before any terminal mutant verdict."""
    declaration = json.loads(DECLARATION.read_text(encoding="utf-8"))["b2c"]
    api = bool(getattr(args, "api", False))
    mutations = API_MUTANTS if api else IDENTITY_MUTANTS if args.identity else TERMINAL_MUTANTS
    declared = {item["id"]: item for item in declaration["api_mutants" if api else "identity_mutants" if args.identity else "terminal_mutants"]}
    if set(declared) != set(mutations):
        raise RuntimeError("terminal mutant declaration differs from driver")
    chosen = [name for name in declared if not args.only or name in args.only.split(",")]
    if args.only and set(chosen) != set(args.only.split(",")):
        raise RuntimeError("unknown terminal mutant selection")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    env = {**os.environ, "NODE_OPTIONS": "--max-old-space-size=3072"}
    # A caller's baseline source override must not bypass the isolated mutated copy.
    env.pop("EMR_B2C_SOURCE_ROOT", None)
    env.pop("EMR_SERVICE_CASES", None)
    env.pop("EMR_B2C_API_CASES", None)
    rows = []
    # The API set selects the (c) API cases of the contract file (the B1 cases are excluded by the name pattern, as in
    # CI); the service sets select the state-service cases.
    selection_variable = "EMR_B2C_API_CASES" if api else "EMR_SERVICE_CASES"
    declared_cases = declaration["local_api_cases"] if api else declaration["local_service_cases"]
    baseline_cases = [case for case in declared_cases if any(case in declared[name]["kill"] for name in chosen)]
    env[selection_variable] = ",".join(baseline_cases)
    with tempfile.TemporaryDirectory(prefix="kin-emrb-api-" if api else "kin-emrb-terminal-") as folder:
        copy = Path(folder) / "checkout"
        copy.mkdir()
        head, link = make_copy(copy, args.worktree, args.source_manifest)
        try:
            inputs = copy / "mutant-inputs.json"
            if inputs.exists():
                shutil.copyfile(inputs, out / "mutant-inputs.json")
            command = ["node", "--max-old-space-size=3072", "--test", "--test-concurrency=1", "--test-reporter=tap",
                       *(["--test-name-pattern", "^C-A0", "tests/emr/b/contract_test.cjs"] if api else ["tests/emr/b/state_service_test.cjs"])]
            baseline_log = out / "baseline.log"
            code, seconds = run(command, cwd=copy, env=env, timeout=1800, log=baseline_log)
            text = baseline_log.read_text(encoding="utf-8", errors="replace")
            passed = re.findall(r"^ok \d+ - ([\w.-]+) ", text, re.M)
            (out / "baseline.json").write_text(json.dumps({"head": head, "exit": code, "seconds": seconds,
                "passed": passed, "expected": baseline_cases}, indent=2) + "\n", encoding="utf-8")
            if code or sorted(passed) != sorted(baseline_cases):
                raise RuntimeError("unmutated terminal copy did not pass exact selection; no mutant verdict")
            if api:
                # The API-side control renames a private, aliases an import and changes layout in the record port.
                control_file = copy / "api/src/emr-runtime/record-port.ts"
                original = control_file.read_bytes()
                renamed = original.decode("utf-8").replace("scoping", "scopePromise").replace(
                    "import { randomUUID } from 'node:crypto';", "import { randomUUID as makeId } from 'node:crypto';").replace("randomUUID(", "makeId(")
                control_file.write_bytes(renamed.replace("export function createRecordPort", "\nexport function createRecordPort").encode("utf-8"))
            else:
                control_file = copy / "api/src/emr-runtime/seal.ts"
                original = control_file.read_bytes()
                # These semantics-preserving edits deliberately alter private names,
                # the imported symbol name and layout used by the exercised paths.
                renamed = original.decode("utf-8").replace("proofOf", "retainedProofOf").replace(
                    "import { createHash", "import { createHash as hashFactory").replace("createHash(", "hashFactory(")
                control_file.write_bytes(renamed.replace("  private view()", "\n  private view()").encode("utf-8"))
            control_sha = sha256(control_file)
            try:
                control_log = out / "rename-alias-format.log"
                code, seconds = run(command, cwd=copy, env=env, timeout=1800, log=control_log)
                passed = re.findall(r"^ok \d+ - ([\w.-]+) ", control_log.read_text(encoding="utf-8", errors="replace"), re.M)
            finally:
                control_file.write_bytes(original)
            control = {"exit": code, "seconds": seconds, "passed": passed, "before_sha256": hashlib.sha256(original).hexdigest(),
                       "control_sha256": control_sha, "restored_sha256": sha256(control_file)}
            (out / "oracle-control.json").write_text(json.dumps(control, indent=2) + "\n", encoding="utf-8")
            if code or sorted(passed) != sorted(baseline_cases) or control["before_sha256"] != control["restored_sha256"]:
                raise RuntimeError("rename/alias/format control failed; no terminal mutant verdict")
            for name in chosen:
                expected, changes = mutations[name]
                kill = declared[name]["kill"]
                applied = apply(copy, changes)
                log = out / (name + ".log")
                try:
                    code, seconds = run(command, cwd=copy, env={**env, selection_variable: ",".join(kill)},
                                        timeout=1800, log=log)
                    text = log.read_text(encoding="utf-8", errors="replace")
                    verdict = contract_verdict(text, kill, code)
                    # An unrelated assertion (including child startup) is not the intended kill.
                    failures = dict(re.findall(r"^not ok \d+ - ([\w.-]+) [^\n]*\n(.*?)(?=^# Subtest:|^ok |^not ok |^1\.\.|\Z)",
                                               text, re.M | re.S))
                    intended = set(declared[name]["assertions"]) == set(kill) and all(
                        message in failures.get(case, "") for case, message in declared[name]["assertions"].items())
                    row = {"id": name, "head": head, "expected_failure": expected, "kill": kill,
                           "exit": code, "seconds": seconds, "log": str(log), **verdict,
                           "intended_assertions": intended, "killed": verdict["killed"] and intended}
                finally:
                    restore(copy, applied)
                row["files"] = applied
                rows.append(row)
                (out / "mutants.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
                print("TERMINAL_MUTANT " + json.dumps({"id": name, "killed": row["killed"]}), flush=True)
        finally:
            unlink_modules(link)
    return 0 if rows and all(row["killed"] for row in rows) else 1


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
            # D935: an append waiting for its slot has no durable intent yet.
            # Exercise the same I2 obligation after the merged reservation and
            # a genuine unknown0 result, where negative settlement is required.
            restart = result["named"]["R6-merged-intent-and-reservation"]
            witness = {"trace": ["A:merged-reservation", "A:unknown0", "crash", "recoverAtStart"],
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
        def test_live_control_is_printed_before_candidate_failure(self):
            from contextlib import redirect_stdout
            spec = importlib.util.spec_from_file_location('emrb_control_probe', ROOT / 'tests/emr/b/live.py')
            live = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(live)
            for count in (24, 48):
                probe = live.EmrBLedgerLive('test_b03_idempotency_and_concurrent_append')
                output = io.StringIO()
                baseline = {'summary': {'count': count, 'failures': 0, 'p95_ms': 123}}
                with patch.object(probe, 'ok', return_value=[]), \
                        patch.object(probe, 'driver', return_value={'results': []}), \
                        patch.object(probe, 'baseline_appends', return_value=baseline), redirect_stdout(output):
                    with self.assertRaises(AssertionError):
                        probe.measured_appends(count)
                rows = output.getvalue().splitlines()
                control = next(json.loads(row[len('EMR_BASELINE_THROUGHPUT '):])
                               for row in rows if row.startswith('EMR_BASELINE_THROUGHPUT '))
                relative = next(json.loads(row[len('EMR_RELATIVE_LATENCY '):])
                                for row in rows if row.startswith('EMR_RELATIVE_LATENCY '))
                self.assertEqual(control['summary'], baseline['summary'])
                self.assertEqual(relative['r3'], baseline['summary'])
                self.assertIsNone(relative['r4d'])

        def test_performance_mutant_uses_its_own_healthy_property(self):
            sys.path.insert(0, str(ROOT / 'tests/emr/b'))
            from performance_mutants import property_failures
            latency = 'ledger-1-0: candidate p95 exceeds same-run r3 budget'
            prefix = 'ledger-1-20000: single receipt reads retained prefix'
            sustained = 'sustained-20-20000: candidate p95 exceeds same-run r3 budget'
            concurrent = 'concurrent-24-0: candidate p95 exceeds same-run r3 budget'
            journal = 'journal-150000: append reads retained prefix'
            self.assertEqual(property_failures('ledger', [latency, sustained]), [])
            self.assertEqual(property_failures('ledger', [latency, prefix]), [prefix])
            self.assertEqual(property_failures('sustained', [latency, sustained, concurrent]), [sustained])
            self.assertEqual(property_failures('concurrent', [sustained, concurrent]), [concurrent])
            self.assertEqual(property_failures('journal', [journal, concurrent]), [journal])

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

        def test_terminal_setup_error_is_not_a_behavioral_kill(self):
            prefix = "not ok 1 - D1641-T01 terminal replay\n  ---\n  code: "
            self.assertTrue(contract_verdict(prefix + "'ERR_ASSERTION'\n  ...\n1..1\n", ["D1641-T01"], 1)["killed"])
            self.assertFalse(contract_verdict(prefix + "'PROTOCOL'\n  ...\n1..1\n", ["D1641-T01"], 1)["killed"])
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(VerdictTest)
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--self-test", action="store_true", help="verify verdicts and baseline source without Docker")
    parser.add_argument("--terminal", action="store_true", help="run declared D1641 terminal component mutants in an isolated copy")
    parser.add_argument("--identity", action="store_true", help="run declared D1650 identity component mutants in an isolated copy")
    parser.add_argument("--api", action="store_true", help="run declared EMR-B2c API-side behavioural mutants (C-M04..M16) in an isolated copy")
    parser.add_argument("--v4", action="store_true", help="run declared KIN-EMR-STATE-V4 semantic mutants (V4-M01..M12) in an isolated copy")
    parser.add_argument("--only", help="comma-separated mutant IDs")
    parser.add_argument("--worktree", action="store_true", help="snapshot tracked uncommitted inputs; preserve their hashes")
    parser.add_argument("--source-manifest", type=Path, help="hash-bound LF source inventory for an isolated Linux copy")
    parser.add_argument("--contract-only", action="store_true", help="run contract kill cases only (live ones are reported not_run)")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if args.out is None:
        parser.error("--out is required unless --self-test is selected")
    if args.v4:
        return v4_main(args)
    if args.terminal or args.identity or args.api:
        return terminal_main(args)
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
        head, link = make_copy(copy, args.worktree, args.source_manifest)
        if args.worktree or args.source_manifest:
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
