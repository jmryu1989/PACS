#!/usr/bin/env python3
# coding: utf-8
"""EMR-C1 mutants M01..M20 (order §8) over an exact baseline.

The C1 sources, the A contract they import and the C1 tests are copied into a fresh temporary tree; the originals are
never written (their hashes are compared before and after). In the copy the baseline must pass exactly: every declared
Node case `ok` once in the runner's own TAP (judged by contract_test.cjs --judge-tap) and every declared DOM method `ok`
once in unittest's own verbose output. Then each mutation is applied alone, only the case it must break is run, and the
original bytes are restored. A mutant is killed only when that case fails with an assertion (node: `not ok` with
ERR_ASSERTION for that case; unittest: `FAIL:` for that method, no `ERROR:`). Syntax/import errors, other exceptions and
timeouts are reported as not killed. The anchors below are the mutation points themselves, not test pins on products.
"""
import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[3]
UNIT = "emr/units/c.json"
NODE_FILES = {"contract": "tests/emr/c/contract_test.cjs", "queue": "tests/emr/c/offline_queue_test.cjs"}
DOM_FILE = "tests/emr/c/offline_report_dom_test.py"
DOM_CLASS = "OfflineReportDOM"
TIMEOUT = 300

CMD, REC, RD, RT, Q = ("api/src/emr-report/commands.ts", "api/src/emr-report/reconcile.ts", "api/src/emr-report/reads.ts",
                      "api/src/emr-report/retention.ts", "api/src/emr-report/offline-queue.ts")
PAGE = "worklist-v0/hpacs-lite/offline-report.js"
LEDGER = "  if (context.mode === 'online') ledger.push(accessEntry(accessAction, command, ctx, p.versionId, p.signedAt));"
SERVE = "  return provideAfterDurableEvent(ledger, plan.event, sendBody);"
GRANT = "api/src/emr-report/offline-grant.ts"
AMEND_WINDOW = "    if (facts.amendUntil === null || boundaryPosition(sig.time.interval, facts.amendUntil) !== 'before') refuse('AmendWindowClosed');"
# variant -> (file, anchor, replacement). Each anchor must occur exactly once in its file.
MUTANTS = {
    "M01": (CMD, "actor: lifecycleActor, at: p.signedAt,", "actor: lifecycleActor, at: context.mode === 'offline-reconcile' ? utc(context.receivedAt) : p.signedAt,"),
    "M02": (CMD, AMEND_WINDOW, AMEND_WINDOW.replace("boundaryPosition(sig.time.interval, facts.amendUntil) !== 'before'",
            "(boundaryPosition(sig.time.interval, facts.amendUntil) === 'at-or-after' && sig.time.interval.earliest > facts.amendUntil)")),
    "M03": (REC, "  if (p.action === 'amend' && facts.state === 'Finalized') {",
            "  if (p.action === 'amend' && facts.state === 'Finalized') return refused(eventId, 'AmendWindowClosed', visible, receivedAt, p.signedAt);\n  if (false) {"),
    "M04-signer": (CMD, "    [same(p.signer, e.signer) && p.identityRegistrationId === e.identityRegistrationId, 'signer'],\n", ""),
    "M04-patient": (CMD, "    [same(p.patient, e.patient), 'patient'],\n", ""),
    "M04-base-version": (CMD, "    [same(p.previousVersion, e.previousVersion), 'previousVersion'],\n", ""),
    "M04-event-id": (CMD, "    [p.eventId === e.eventId, 'eventId'],\n", ""),
    "M05": ("api/src/emr-signature/time-basis.ts",
            "  if (elapsed < 0 || at(Date.parse(basis.anchorServerTime) + elapsed) !== signedAt) refuse('TimeBasisMismatch');\n", ""),
    "M06": ("api/src/emr-signature/keys.ts", "new Set(ids).size !== ids.length || ", ""),
    "M07-queue": (Q, "      catch (error) { return freeze({ status: 'not-saved' as const, code: codeOf(error) }); }",
                  "      catch (error) { return freeze({ status: 'pending-offline' as const, receipt: null }); }"),
    "M07-page": (PAGE, "throw new Error('no durable receipt');\n        } catch { setState(t.uid, { status: 'not-saved' }); return stateOf(t.uid); }",
                 "throw new Error('no durable receipt');\n        } catch { setState(t.uid, { status: 'pending-offline', eventId: entry.eventId }); return stateOf(t.uid); }"),
    "M08": (Q, "try { answer = object(await transport.submit(row.entry), [",
            "try { answer = object(await transport.submit(state.get(row.eventId) === 'sent-unknown' ? { ...row.entry, eventId: row.entry.eventId + ':retry' } : row.entry), ["),
    "M09": (CMD, "    const receipt = parseCommitReceipt(existing);\n    if (receipt.contentDigest !== plan.contentDigest) refuse('EventIdConflict');\n",
            "    const receipt = parseCommitReceipt(existing);\n"),
    "M10-reconcile": (REC, "      if (!context.adoptDivergedDraft) return conflict('own-draft-diverged', ['adopt-signed-original', 'sign-new-version']);\n", ""),
    "M10-queue": (Q, "state.get(predecessor) !== 'committed' &&", "state.get(predecessor) === 'pending' &&"),
    "M11-session": (Q, "  if (kind === 'http' && s.status === 401 && s.code === 'AUTH_SESSION_ENDED') return 'awaiting-reauth';",
                    "  if (kind === 'network' || (kind === 'http' && s.status === 401 && s.code === 'AUTH_SESSION_ENDED')) return 'awaiting-reauth';"),
    "M11-page": (PAGE, "const sessionEnded = signal => !!signal && ((", "const sessionEnded = signal => !!signal || (("),
    "M12-later-input": (PAGE, "const text = textOf(view.readText());",
                        "const text = { get findings() { return view.readText().findings; }, get conclusion() { return view.readText().conclusion; }, "
                        "get recommendation() { return view.readText().recommendation; } };"),
    "M12-aba": (PAGE, "if (!body || !sameOpening(start)) return false;", "if (!body) return false;"),
    "M13": (RD, SERVE, "  const body = await sendBody({ eventId: plan.event.eventId, durableAt: plan.event.occurredAt });\n"
                       "  await ledger.append(plan.event);\n  return body;"),
    "M14": (REC, "act: STATUTORY_ACT[entry.access.action], event: entry.access });",
            "act: STATUTORY_ACT[entry.access.action], event: { ...entry.access, ip: context.ingress.ip } as any });"),
    "M15": (RT, "  return transitionRetainedReport(facts, command, r.record, source, r.graph, r.archive);",
            "  { const outcome = transitionReport(facts, command); return freeze({ ...outcome, "
            "retention: require('../emr-contract/lawful-defaults').recordVersionAdded(r.record, source, r.graph, false) }); }"),
    "M16": (RD, "  const access = readRetention(facts, context.archive, context.resume, context.retained);",
            "  const access = readRetention(facts, facts.contentHistory.some(h => h.use === 'preservation-entry') ? null : context.archive, context.resume, context.retained);"),
    "M17": (RT, "  const read = requireRetainedRead(retained);",
            "  if (retained === null || retained === undefined) return reportRetentionAccess(facts, archive, resume, null);\n"
            "  const read = requireRetainedRead(retained);"),
    "M18": (RT, "  if (cause !== 'server-retention-receipt') return false;",
            "  if (cause === 'cache-evicted' || cause === 'draft-purpose-ended') return true;\n  if (cause !== 'server-retention-receipt') return false;"),
    "M19-print": (RD, "  return freeze({ event: ev, physicalOutput: 'not-observed' as const, outcome });",
                  "  return freeze({ event: ev, physicalOutput: (outcome === 'dialog-returned' ? 'printed' : 'not-observed') as any, outcome });"),
    "M19-ack": (RD, "const current = acks.some(a => a.versionId === published.versionId) ?", "const current = acks.length > 0 ?"),
    "M19-page": (PAGE, "relatedEventId: opened.eventId, physicalOutput: 'not-observed' });", "relatedEventId: opened.eventId, physicalOutput: 'printed' });"),
    "M20-entry": (CMD, LEDGER, LEDGER.replace("context.mode === 'online'", "context.mode === 'online' && command.action !== 'approve'")),
    "M20-additional-entry": (CMD, LEDGER, LEDGER.replace("context.mode === 'online'", "context.mode === 'online' && command.action !== 'addendum'")),
    "M20-modification": (CMD, LEDGER, LEDGER.replace("context.mode === 'online'", "context.mode === 'online' && command.action !== 'amend'")),
    "M20-read": (RD, SERVE, "  return sendBody({ eventId: plan.event.eventId, durableAt: plan.event.occurredAt });"),
    # Round 2 (Astra review of 3521006, D734): each re-introduces one fixed defect.
    "M21-amend-interval": (CMD, AMEND_WINDOW + "\n", ""),
    "M21-anchor-interval": ("api/src/emr-signature/time-basis.ts", "  if (basis.interval.latest > basis.anchorValidUntil) return held(",
                            "  if (signedAt > basis.anchorValidUntil) return held("),
    "M22-generation": (GRANT, "  if (p.claimGeneration !== study.claimGeneration) refuse('GrantGenerationRefused');\n", ""),
    "M22-anchor": (GRANT, "  if (p.timeBasis.anchorId !== grant.anchorId) refuse('GrantAnchorRefused');\n", ""),
    "M22-actions": (GRANT, "  const signActions = usable ? grant.actions.filter(a => a !== 'read') : [];",
                    "  const signActions: any = usable ? ['approve-sign', 'amend', 'addendum'] : [];"),
    "M23": (REC, "  try { prepareSignedCommand(planContext, command); }",
            "  try { if (!(p.action === 'amend' && facts.state === 'Finalized')) prepareSignedCommand(planContext, command); }"),
    "M24": (RD, "  const readable = reader ? retainedVersions(facts) : publishedHistory(facts);", "  const readable = retainedVersions(facts);"),
    "M25": (PAGE, "        if (!sameOpening(start)) return false; // ", "        if (false) return false; // "),
    "M26-sign": (PAGE, "        if (!sameAccount(start)) { setState(t.uid, { status: 'not-saved' }); return stateOf(t.uid); }\n", ""),
    "M26-list": (PAGE, "          if (!sameAccount(start)) return; // ", "          if (false) return; // "),
    "M26-reply": (PAGE, "reply.eventId !== entry.eventId || stateOf(uid).eventId !== entry.eventId) return;", "reply.eventId !== entry.eventId) return;"),
    "M27": (REC, "  if (actor.sessionState !== 'active') return fail('SessionEnded', null);",
            "  if (context.existingReceipt && parseCommitReceipt(context.existingReceipt).eventId === eventId) return freeze({ kind: 'duplicate' as const, response: answer('duplicate', null, null, false) });\n"
            "  if (actor.sessionState !== 'active') return fail('SessionEnded', null);"),
    "M28": (CMD, "  if (!sameEnvelope(command.envelope, sig.envelope)) refuse('SignedEnvelopeMismatch');",
            "  if (!command.envelope || command.envelope.payload !== sig.envelope.payload) refuse('SignedEnvelopeMismatch');"),
    "M29": (CMD, "  if (command.action === 'cancel-preliminary' && (facts.state !== 'Preliminary' || facts.preliminary?.reviewerId !== actor.identity.id))\n    refuse('DesignatedReviewerRequired');\n", ""),
    "M30": (Q, "state.get(predecessor) !== 'committed' && !kept.has(predecessor)", "state.get(predecessor) !== 'committed'"),
    "M31-session": (Q, "  if (kind === 'http' && [403, 409].includes(s.status as number) && s.code === 'AUTH_SESSION_MISMATCH') return 'awaiting-reauth';\n", ""),
    "M31-page": (PAGE, " ||\n      ([403, 409].includes(signal.status) && signal.code === 'AUTH_SESSION_MISMATCH'));", ");"),
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(argv, cwd, log, env=None):
    started = time.monotonic()
    try:
        done = subprocess.run(argv, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=TIMEOUT, env=env)
        out, err, code, timed_out = done.stdout.decode("utf-8", "replace"), done.stderr.decode("utf-8", "replace"), done.returncode, False
        # Windows text streams end lines with CRLF; the runners' formats are judged line by line.
        out, err = out.replace("\r\n", "\n"), err.replace("\r\n", "\n")
    except subprocess.TimeoutExpired as expired:
        out = (expired.stdout or b"").decode("utf-8", "replace")
        err = (expired.stderr or b"").decode("utf-8", "replace")
        code, timed_out = None, True
    Path(log).write_text("$ " + " ".join(argv) + "\n--- stdout\n" + out + "\n--- stderr\n" + err, encoding="utf-8")
    return {"argv": argv, "exit": code, "timed_out": timed_out, "seconds": round(time.monotonic() - started, 3), "stdout": out, "stderr": err,
            "log": str(log)}


def tap_cases(text):
    """Top-level TAP results: {case_id: [(ok, skipped, yaml_block)]}."""
    lines, found = text.splitlines(), {}
    for index, line in enumerate(lines):
        match = re.match(r"^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$", line)
        if not match:
            continue
        block = []
        for follow in lines[index + 1:]:
            if not follow.startswith("  "):
                break
            block.append(follow)
            if follow.strip() == "...":
                break
        case = (re.match(r"^(C-[CQ]\d{2}) ", match.group(2)) or [None, match.group(2)])[1]
        found.setdefault(case, []).append((match.group(1) == "ok", match.group(3) is not None, "\n".join(block)))
    return found


def unittest_cases(text):
    """unittest -v lines `name (module.Class.name) ... status` plus FAIL/ERROR headers."""
    statuses = {}
    for match in re.finditer(r"^(test_\w+) \([^)]*\) \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$", text, re.M):
        statuses.setdefault(match.group(1), []).append(match.group(2))
    fails = set(re.findall(r"^FAIL: (test_\w+) ", text, re.M))
    errors = set(re.findall(r"^ERROR: (test_\w+) ", text, re.M))
    return statuses, fails, errors


def judge_unittest(text, expected):
    statuses, fails, errors = unittest_cases(text)
    problems = [f"{name}: {statuses.get(name)}" for name in expected if statuses.get(name) != ["ok"]]
    problems += [f"{name}: not declared" for name in statuses if name not in expected]
    if not re.search(rf"^Ran {len(expected)} tests? in ", text, re.M) or not re.search(r"^OK$", text, re.M) or fails or errors:
        problems.append("summary is not an exact OK run of the declared methods")
    return problems


def self_check_judges():
    """The unittest judge must reject skips, misses, extras and failures (B9: a judge that cannot fail is no judge)."""
    names = ["test_a", "test_b"]
    good = "test_a (m.C.test_a) ... ok\ntest_b (m.C.test_b) ... ok\n\n----\nRan 2 tests in 0.1s\n\nOK\n"
    bad = [good.replace("test_b (m.C.test_b) ... ok", "test_b (m.C.test_b) ... skipped 'x'"),
           good.replace("test_b (m.C.test_b) ... ok\n", "").replace("Ran 2", "Ran 1"),
           good.replace("test_b (m.C.test_b) ... ok", "test_b (m.C.test_b) ... FAIL") + "FAIL: test_b (m.C.test_b)\n",
           good.replace("test_b (m.C.test_b) ... ok", "test_b (m.C.test_b) ... ok\ntest_c (m.C.test_c) ... ok").replace("Ran 2", "Ran 3")]
    return not judge_unittest(good, names) and all(judge_unittest(text, names) for text in bad)


def dom_methods(path):
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == DOM_CLASS]
    if len(classes) != 1:
        return None
    return [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")]


def link_node_modules(copy):
    target, link = ROOT / "api" / "node_modules", copy / "api" / "node_modules"
    if not (target / "typescript").is_dir():
        raise SystemExit(f"installed api/node_modules/typescript is required: {target}")
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)
    return link


def unlink_node_modules(link):
    # Remove only the link itself; the installed modules it points to are never touched.
    if os.name == "nt":
        os.rmdir(link)
    else:
        os.unlink(link)
    if os.path.lexists(link):
        raise SystemExit("could not remove the node_modules link from the mutant copy")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=None, help="evidence directory (new); default tmp/emr-c1/mutants-<utc>")
    parser.add_argument("--only", action="append", default=[], help="run only these variants (still verifies the full baseline)")
    args = parser.parse_args()
    out = (Path(args.out) if args.out else ROOT / "tmp" / "emr-c1" / ("mutants-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))).resolve()
    out.mkdir(parents=True, exist_ok=False)
    (out / "logs").mkdir()
    unit = json.loads((ROOT / UNIT).read_text(encoding="utf-8"))
    result = {"root_head": None, "baseline": {}, "variants": [], "declaration": [], "judges_self_check": None}
    try:
        result["root_head"] = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip() or None
    except OSError:
        result["root_head"] = None

    # Declared mutants and their target cases must equal the implemented table exactly.
    declared = {v["variant"]: v for m in unit["mutants"] for v in m["variants"]}
    if set(declared) != set(MUTANTS) or [m["id"] for m in unit["mutants"]] != [f"M{n:02d}" for n in range(1, len(unit["mutants"]) + 1)]:
        result["declaration"].append("declared mutant variants differ from the implemented table")
    for name, variant in declared.items():
        if name in MUTANTS and variant["file"] != MUTANTS[name][0]:
            result["declaration"].append(f"{name}: declared file {variant['file']} != {MUTANTS[name][0]}")
        if variant["suite"] == "dom" and variant["case"] not in unit["cases"]["dom"]:
            result["declaration"].append(f"{name}: unknown DOM case")
        if variant["suite"] in NODE_FILES and variant["case"] not in unit["cases"][variant["suite"]]:
            result["declaration"].append(f"{name}: unknown {variant['suite']} case")
    if dom_methods(ROOT / DOM_FILE) != unit["cases"]["dom"]:
        result["declaration"].append("DOM test methods differ from the declared cases")
    result["judges_self_check"] = self_check_judges()

    sources = sorted(set(unit["owned_paths"]) | {str(p.relative_to(ROOT)).replace("\\", "/") for p in (ROOT / "api/src/emr-contract").glob("*.ts")} |
                     {"api/tsconfig.json"})
    before = {name: sha(ROOT / name) for name in sources}
    temp = Path(tempfile.mkdtemp(prefix="emr-c1-mutants-"))
    copy, link = temp / "tree", None
    try:
        for name in sources:
            (copy / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, copy / name)
        link = link_node_modules(copy)
        node, python = shutil.which("node"), sys.executable
        if not node:
            raise SystemExit("node is required on PATH")

        # Baseline: the full declared selection passes exactly, judged from each runner's own output.
        tap = out / "baseline-node.tap"
        base_node = run([node, "--test", "--test-reporter=tap", "--test-reporter-destination=" + str(tap), NODE_FILES["contract"], NODE_FILES["queue"]],
                        copy, out / "logs" / "baseline-node.log")
        judge = run([node, NODE_FILES["contract"], "--judge-tap", str(tap)], copy, out / "logs" / "baseline-node-judge.log")
        base_dom = run([python, "-B", DOM_FILE, "-v"], copy, out / "logs" / "baseline-dom.log")
        dom_problems = judge_unittest(base_dom["stderr"], unit["cases"]["dom"])
        node_found = tap_cases(tap.read_text(encoding="utf-8").replace("\r\n", "\n")) if tap.exists() else {}
        result["baseline"] = {
            "node": {"exit": base_node["exit"], "judge_exit": judge["exit"], "judge": judge["stdout"].strip(), "cases": sorted(node_found)},
            "dom": {"exit": base_dom["exit"], "problems": dom_problems},
            "ok": base_node["exit"] == 0 and judge["exit"] == 0 and base_dom["exit"] == 0 and not dom_problems,
        }
        selected = [name for name in MUTANTS if not args.only or name in args.only]
        if result["baseline"]["ok"] and not result["declaration"] and result["judges_self_check"]:
            for name in selected:
                file, anchor, replacement = MUTANTS[name]
                target = copy / file
                original = target.read_bytes()
                text = original.decode("utf-8")
                newline = "\r\n" if "\r\n" in text else "\n"
                anchor_n, replacement_n = anchor.replace("\n", newline), replacement.replace("\n", newline)
                entry = {"variant": name, "file": file, "suite": declared[name]["suite"], "case": declared[name]["case"],
                         "anchor_sha256": hashlib.sha256(anchor.encode("utf-8")).hexdigest(), "killed": False, "reason": None}
                if text.count(anchor_n) != 1:
                    entry["reason"] = f"anchor occurs {text.count(anchor_n)} times"
                    result["variants"].append(entry)
                    continue
                target.write_bytes(text.replace(anchor_n, replacement_n).encode("utf-8"))
                try:
                    log = out / "logs" / f"{name}.log"
                    if entry["suite"] == "dom":
                        ran = run([python, "-B", DOM_FILE, f"{DOM_CLASS}.{entry['case']}", "-v"], copy, log)
                        statuses, fails, errors = unittest_cases(ran["stderr"])
                        killed = not ran["timed_out"] and ran["exit"] not in (0, None) and entry["case"] in fails and not errors
                        entry["reason"] = "assertion failure" if killed else f"exit={ran['exit']} timed_out={ran['timed_out']} fails={sorted(fails)} errors={sorted(errors)}"
                    else:
                        ran = run([node, "--test", "--test-reporter=tap", f"--test-name-pattern=^{entry['case']} ", NODE_FILES[entry["suite"]]], copy, log)
                        found = tap_cases(ran["stdout"]).get(entry["case"], [])
                        asserted = any(not ok and not skipped and "code: 'ERR_ASSERTION'" in block for ok, skipped, block in found)
                        killed = not ran["timed_out"] and ran["exit"] not in (0, None) and len(found) == 1 and asserted
                        entry["reason"] = "assertion failure" if killed else f"exit={ran['exit']} timed_out={ran['timed_out']} results={[(ok, skipped) for ok, skipped, _ in found]}"
                    entry.update(killed=killed, exit=ran["exit"], seconds=ran["seconds"], log=str(log.relative_to(out)))
                finally:
                    target.write_bytes(original)
                    entry["restored"] = sha(target) == hashlib.sha256(original).hexdigest()
                result["variants"].append(entry)
    finally:
        if link is not None:
            unlink_node_modules(link)
        shutil.rmtree(temp, ignore_errors=False)
    after = {name: sha(ROOT / name) for name in sources}
    result["originals_unchanged"] = before == after
    result["summary"] = {
        "declared_variants": len(declared), "run": len(result["variants"]),
        "killed": sum(1 for v in result["variants"] if v["killed"]),
        "not_killed": [v["variant"] for v in result["variants"] if not v["killed"]],
    }
    complete = not args.only and result["summary"]["run"] == len(MUTANTS)
    result["ok"] = (result["baseline"].get("ok") is True and not result["declaration"] and result["judges_self_check"] is True and result["originals_unchanged"]
                    and all(v["killed"] and v.get("restored") for v in result["variants"]) and (complete or bool(args.only)))
    (out / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": result["ok"], "baseline_ok": result["baseline"].get("ok"), **result["summary"], "declaration": result["declaration"],
                      "judges_self_check": result["judges_self_check"], "originals_unchanged": result["originals_unchanged"], "out": str(out)}, ensure_ascii=False))
    return 0 if result["ok"] and complete else 1


if __name__ == "__main__":
    sys.exit(main())
