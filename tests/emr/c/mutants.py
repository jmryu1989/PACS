#!/usr/bin/env python3
# coding: utf-8
"""EMR-C1 existing 49 variants plus D739 CM01-CM12 over an exact baseline.

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
MUTANTS = {'M01': ('api/src/emr-report/commands.ts',
         'facts: outcome.facts, effects: outcome.effects, version: { ref: version',
         "facts: context.mode === 'offline-reconcile' && facts.firstApprovedAt === null ? {...outcome.facts, "
         'firstApprovedAt: receivedAt, amendUntil: new Date(Date.parse(receivedAt)+24*3600000).toISOString()} : '
         'outcome.facts, effects: outcome.effects, version: { ref: version'),
 'M02': ('api/src/emr-report/commands.ts',
         "    if (facts.amendUntil === null || boundaryPosition(sig.time.interval, facts.amendUntil) !== 'before') "
         "refuse('AmendWindowClosed');",
         '    if (facts.amendUntil === null || (boundaryPosition(sig.time.interval, facts.amendUntil) === '
         "'at-or-after' && sig.time.interval.earliest > facts.amendUntil)) refuse('AmendWindowClosed');"),
 'M03': ('api/src/emr-report/reconcile.ts',
         "  if (p.action === 'amend' && facts.state === 'Finalized') {",
         "  if (p.action === 'amend' && facts.state === 'Finalized') return refused(eventId, 'AmendWindowClosed', "
         'visible, receivedAt, p.signedAt);\n'
         '  if (false) {'),
 'M04-signer': ('api/src/emr-report/commands.ts',
                "    [same(p.signer, e.signer) && p.identityRegistrationId === e.identityRegistrationId, 'signer'],\n",
                ''),
 'M04-patient': ('api/src/emr-report/commands.ts', "    [same(p.patient, e.patient), 'patient'],\n", ''),
 'M04-base-version': ('api/src/emr-report/commands.ts',
                      "    [same(p.previousVersion, e.previousVersion), 'previousVersion'],\n",
                      ''),
 'M04-event-id': ('api/src/emr-report/commands.ts', "    [p.eventId === e.eventId, 'eventId'],\n", ''),
 'M05': ('api/src/emr-signature/time-basis.ts',
         '  if (elapsed < 0 || at(Date.parse(basis.anchorServerTime) + elapsed) !== signedAt) '
         "refuse('TimeBasisMismatch');\n",
         ''),
 'M06': ('api/src/emr-signature/keys.ts', 'new Set(ids).size !== ids.length || ', ''),
 'M07-queue': ('api/src/emr-report/offline-queue.ts',
               "      catch (error) { return freeze({ status: 'not-saved' as const, code: codeOf(error) }); }",
               "      catch (error) { return freeze({ status: 'pending-offline' as const, receipt: null }); }"),
 'M07-page': ('worklist-v0/hpacs-lite/offline-report.js',
              "if (saved?.status !== 'pending-offline' || saved.receipt?.eventId !== entry.eventId) throw new "
              "Error('no durable receipt');",
              ''),
 'M08': ('api/src/emr-report/offline-queue.ts',
         'const reply = await transport.submit(row.entry);',
         "const reply = await transport.submit(state.get(row.eventId) === 'sent-unknown' ? { ...row.entry, eventId: "
         "row.entry.eventId + ':retry' } : row.entry);"),
 'M09': ('api/src/emr-report/commands.ts',
         '    const receipt = parseCommitReceipt(existing);\n'
         "    if (receipt.contentDigest !== plan.contentDigest) refuse('EventIdConflict');\n",
         '    const receipt = parseCommitReceipt(existing);\n'),
 'M10-reconcile': ('api/src/emr-report/reconcile.ts',
                   "      if (!context.adoptDivergedDraft) return conflict('own-draft-diverged', "
                   "['adopt-signed-original', 'sign-new-version']);\n",
                   ''),
 'M10-queue': ('api/src/emr-report/offline-queue.ts',
               '      const blockedRecords = new Set<string>();\n'
               '      for (const row of list) {\n'
               '        if (!active()) break;\n'
               '        if (!row.entry || row.blocked) continue;\n'
               '        const record = JSON.stringify([row.entry.access.target.studyId, '
               'row.entry.access.target.recordId]);\n'
               "        if (['conflict', 'refused', 'corrupt'].includes(state.get(row.eventId)!)) { "
               'blockedRecords.add(record); continue; }\n'
               "        if (state.get(row.eventId) === 'committed') continue;\n"
               '        // Time/evidence holds are not automatically adopted. Technical predecessor holds are '
               'reevaluated each pass.\n'
               "        if (row.state === 'held' && row.evidence?.reason && row.evidence.reason !== "
               "'predecessor-unresolved') { blockedRecords.add(record); continue; }\n"
               "        if (blockedRecords.has(record)) { await set(row.eventId, 'held', { reason: "
               "'predecessor-unresolved' }); continue; }\n"
               '        control?.changed(row.entry, state.get(row.eventId)!, row.evidence);\n'
               '        const predecessor = row.entry.predecessorEventId;\n'
               '        if (predecessor !== null && !kept.has(predecessor) && !list.some(r => r.eventId === '
               'predecessor) && transport.findAdoption) {\n'
               '          try {\n'
               '            const found = await transport.findAdoption(predecessor, row.entry);\n'
               '            if (!active()) break;\n'
               '            if (found) {\n'
               '              const prior = parseAdoptedEvent(found);\n'
               "              if (!matchesParent(row.entry, prior)) refuse('PredecessorBindingRefused');\n"
               '              await store.keepCommitEvidence(predecessor, prior);\n'
               '              if (!active()) break;\n'
               '              kept.set(predecessor, prior);\n'
               '            }\n'
               '          } catch { if (!active()) break; }\n'
               '        }\n'
               '        if (predecessor !== null && (!kept.has(predecessor) || !matchesParent(row.entry, '
               'kept.get(predecessor)!))) {\n'
               "          await set(row.eventId, 'held', { waitingFor: predecessor, reason: 'predecessor-unresolved' "
               '});\n'
               "          if (!list.some(r => r.eventId === predecessor && ['conflict', 'refused', "
               "'corrupt'].includes(state.get(r.eventId)!))) retry.add(row.eventId);\n"
               '          blockedRecords.add(record); continue;\n'
               '        }\n',
               '      const blockedRecords = new Set<string>();\n'
               '      for (const row of list) {\n'
               '        if (!active()) break;\n'
               '        if (!row.entry || row.blocked) continue;\n'
               '        const record = JSON.stringify([row.entry.access.target.studyId, '
               'row.entry.access.target.recordId]);\n'
               "        if (['conflict', 'refused', 'corrupt'].includes(state.get(row.eventId)!)) { "
               'blockedRecords.add(record); continue; }\n'
               "        if (state.get(row.eventId) === 'committed') continue;\n"
               '        // Time/evidence holds are not automatically adopted. Technical predecessor holds are '
               'reevaluated each pass.\n'
               "        if (row.state === 'held' && row.evidence?.reason && row.evidence.reason !== "
               "'predecessor-unresolved') { blockedRecords.add(record); continue; }\n"
               "        if (false) { await set(row.eventId, 'held', { reason: 'predecessor-unresolved' }); continue; "
               '}\n'
               '        control?.changed(row.entry, state.get(row.eventId)!, row.evidence);\n'
               '        const predecessor = row.entry.predecessorEventId;\n'
               '        if (predecessor !== null && !kept.has(predecessor) && !list.some(r => r.eventId === '
               'predecessor) && transport.findAdoption) {\n'
               '          try {\n'
               '            const found = await transport.findAdoption(predecessor, row.entry);\n'
               '            if (!active()) break;\n'
               '            if (found) {\n'
               '              const prior = parseAdoptedEvent(found);\n'
               "              if (!matchesParent(row.entry, prior)) refuse('PredecessorBindingRefused');\n"
               '              await store.keepCommitEvidence(predecessor, prior);\n'
               '              if (!active()) break;\n'
               '              kept.set(predecessor, prior);\n'
               '            }\n'
               '          } catch { if (!active()) break; }\n'
               '        }\n'
               '        if (false) {\n'
               "          await set(row.eventId, 'held', { waitingFor: predecessor, reason: 'predecessor-unresolved' "
               '});\n'
               "          if (!list.some(r => r.eventId === predecessor && ['conflict', 'refused', "
               "'corrupt'].includes(state.get(r.eventId)!))) retry.add(row.eventId);\n"
               '          blockedRecords.add(record); continue;\n'
               '        }\n'),
 'M11-session': ('api/src/emr-report/offline-queue.ts',
                 "  if (kind === 'http' && s.status === 401 && s.code === 'AUTH_SESSION_ENDED') return "
                 "'awaiting-reauth';",
                 "  if (kind === 'network' || (kind === 'http' && s.status === 401 && s.code === "
                 "'AUTH_SESSION_ENDED')) return 'awaiting-reauth';"),
 'M11-page': ('worklist-v0/hpacs-lite/offline-report.js',
              "if (sessionEnded(signal)) throw { ...signal, kind: 'http' };",
              "if (sessionEnded(signal) || signal.kind === 'network') throw "
              "{kind:'http',status:401,code:'AUTH_SESSION_ENDED'};"),
 'M12-later-input': ('worklist-v0/hpacs-lite/offline-report.js',
                     'const text = textOf(view.readText());',
                     'const text = { get findings() { return view.readText().findings; }, get conclusion() { return '
                     'view.readText().conclusion; }, get recommendation() { return view.readText().recommendation; } '
                     '};'),
 'M12-aba': ('worklist-v0/hpacs-lite/offline-report.js',
             'if (!valid(token) || (token.screen && !visible(token))) return { stale: true };',
             'if (!valid(token)) return { stale: true };'),
 'M13': ('api/src/emr-report/reads.ts',
         '  return provideAfterDurableEvent(ledger, plan.event, sendBody);',
         '  const body = await sendBody({ eventId: plan.event.eventId, durableAt: plan.event.occurredAt });\n'
         '  await ledger.append(plan.event);\n'
         '  return body;'),
 'M14': ('api/src/emr-report/reconcile.ts',
         'act: STATUTORY_ACT[entry.access.action], event: entry.access });',
         'act: STATUTORY_ACT[entry.access.action], event: { ...entry.access, ip: context.ingress.ip } as any });'),
 'M15': ('api/src/emr-report/retention.ts',
         '  return transitionRetainedReport(facts, command, r.record, source, r.graph, r.archive);',
         '  { const outcome = transitionReport(facts, command); return freeze({ ...outcome, retention: '
         "require('../emr-contract/lawful-defaults').recordVersionAdded(r.record, source, r.graph, false) }); }"),
 'M16': ('api/src/emr-report/reads.ts',
         '  const access = readRetention(facts, context.archive, context.resume, context.retained);',
         "  const access = readRetention(facts, facts.contentHistory.some(h => h.use === 'preservation-entry') ? null "
         ': context.archive, context.resume, context.retained);'),
 'M17': ('api/src/emr-report/retention.ts',
         '  const read = requireRetainedRead(retained);',
         '  if (retained === null || retained === undefined) return reportRetentionAccess(facts, archive, resume, '
         'null);\n'
         '  const read = requireRetainedRead(retained);'),
 'M18': ('api/src/emr-report/retention.ts',
         "  if (cause !== 'server-retention-receipt') return false;",
         "  if (cause === 'cache-evicted' || cause === 'draft-purpose-ended') return true;\n"
         "  if (cause !== 'server-retention-receipt') return false;"),
 'M19-print': ('api/src/emr-report/reads.ts',
               "  return freeze({ event: ev, physicalOutput: 'not-observed' as const, outcome });",
               "  return freeze({ event: ev, physicalOutput: (outcome === 'dialog-returned' ? 'printed' : "
               "'not-observed') as any, outcome });"),
 'M19-ack': ('api/src/emr-report/reads.ts',
             'const current = acks.some(a => a.versionId === published.versionId) ?',
             'const current = acks.length > 0 ?'),
 'M19-page': ('worklist-v0/hpacs-lite/offline-report.js',
              "relatedEventId: opened.eventId, physicalOutput: 'not-observed' })))",
              "relatedEventId: opened.eventId, physicalOutput: 'printed' })))"),
 'M20-entry': ('api/src/emr-report/commands.ts',
               "  if (context.mode === 'online') ledger.push(accessEntry(accessAction, command, ctx, p.versionId, "
               'p.signedAt));',
               "  if (context.mode === 'online' && command.action !== 'approve') ledger.push(accessEntry(accessAction, "
               'command, ctx, p.versionId, p.signedAt));'),
 'M20-additional-entry': ('api/src/emr-report/commands.ts',
                          "  if (context.mode === 'online') ledger.push(accessEntry(accessAction, command, ctx, "
                          'p.versionId, p.signedAt));',
                          "  if (context.mode === 'online' && command.action !== 'addendum') "
                          'ledger.push(accessEntry(accessAction, command, ctx, p.versionId, p.signedAt));'),
 'M20-modification': ('api/src/emr-report/commands.ts',
                      "  if (context.mode === 'online') ledger.push(accessEntry(accessAction, command, ctx, "
                      'p.versionId, p.signedAt));',
                      "  if (context.mode === 'online' && command.action !== 'amend') "
                      'ledger.push(accessEntry(accessAction, command, ctx, p.versionId, p.signedAt));'),
 'M20-read': ('api/src/emr-report/reads.ts',
              '  return provideAfterDurableEvent(ledger, plan.event, sendBody);',
              '  return sendBody({ eventId: plan.event.eventId, durableAt: plan.event.occurredAt });'),
 'M21-amend-interval': ('api/src/emr-report/commands.ts',
                        '    if (facts.amendUntil === null || boundaryPosition(sig.time.interval, facts.amendUntil) '
                        "!== 'before') refuse('AmendWindowClosed');\n",
                        ''),
 'M21-anchor-interval': ('api/src/emr-signature/time-basis.ts',
                         '  if (basis.interval.latest > basis.anchorValidUntil) return held(',
                         '  if (signedAt > basis.anchorValidUntil) return held('),
 'M22-generation': ('api/src/emr-report/offline-grant.ts',
                    "  if (p.claimGeneration !== study.claimGeneration) refuse('GrantGenerationRefused');\n",
                    ''),
 'M22-anchor': ('api/src/emr-report/offline-grant.ts',
                "  if (p.timeBasis.anchorId !== grant.anchorId) refuse('GrantAnchorRefused');\n",
                ''),
 'M22-actions': ('api/src/emr-report/offline-grant.ts',
                 "  const signActions = usable ? grant.actions.filter(a => a !== 'read') : [];",
                 "  const signActions: any = usable ? ['approve-sign', 'amend', 'addendum'] : [];"),
 'M23': ('api/src/emr-report/reconcile.ts',
         '  try { prepareSignedCommand(planContext, command); }',
         "  try { if (!(p.action === 'amend' && facts.state === 'Finalized')) prepareSignedCommand(planContext, "
         'command); }'),
 'M24': ('api/src/emr-report/reads.ts',
         '  const readable = reader ? retainedVersions(facts) : publishedHistory(facts);',
         '  const readable = retainedVersions(facts);'),
 'M25': ('worklist-v0/hpacs-lite/offline-report.js',
         'if (!valid(token) || (token.screen && !visible(token))) return { stale: true };',
         'if (!valid(token)) return { stale: true };'),
 'M26-sign': ('worklist-v0/hpacs-lite/offline-report.js',
              'const valid = token => !disposed &&',
              "const valid = token => token.lane.includes('approval') || !disposed &&"),
 'M26-list': ('worklist-v0/hpacs-lite/offline-report.js',
              'const valid = token => !disposed &&',
              "const valid = token => token.lane.includes('drain') || !disposed &&"),
 'M26-reply': ('worklist-v0/hpacs-lite/offline-report.js',
               'if (!selection || entry.deviceSequence > selection.sequence) {',
               'if (true) {'),
 'M27': ('api/src/emr-report/reconcile.ts',
         "  if (actor.sessionState !== 'active') return fail('SessionEnded', null);",
         '  if (context.existingReceipt && parseCommitReceipt(context.existingReceipt).contentDigest === '
         "signedDigest(entry)) return freeze({kind:'duplicate' as "
         "const,response:answer('duplicate',null,null,false)});\n"
         "  if (actor.sessionState !== 'active') return fail('SessionEnded', null);"),
 'M28': ('api/src/emr-report/commands.ts',
         "  if (!sameEnvelope(command.envelope, sig.envelope)) refuse('SignedEnvelopeMismatch');",
         '  if (!command.envelope || command.envelope.payload !== sig.envelope.payload) '
         "refuse('SignedEnvelopeMismatch');"),
 'M29': ('api/src/emr-report/commands.ts',
         "  if (command.action === 'cancel-preliminary' && (facts.state !== 'Preliminary' || "
         'facts.preliminary?.reviewerId !== actor.identity.id))\n'
         "    refuse('DesignatedReviewerRequired');\n",
         ''),
 'M30': ('api/src/emr-report/offline-queue.ts',
         'const kept = new Map((await keptCommits()).map(a => [a.eventId, a]));',
         'const kept = new Map<string, Readonly<AdoptedEvent>>();'),
 'M31-session': ('api/src/emr-report/offline-queue.ts',
                 "  if (kind === 'http' && [403, 409].includes(s.status as number) && s.code === "
                 "'AUTH_SESSION_MISMATCH') return 'awaiting-reauth';\n",
                 ''),
 'M31-page': ('worklist-v0/hpacs-lite/offline-report.js',
              " ||\n      ([403, 409].includes(signal.status) && signal.code === 'AUTH_SESSION_MISMATCH'));",
              ');'),
 'M32': ('api/src/emr-report/reconcile.ts',
         'try { prepareSignedCommand(planContext, command); }',
         "try { if (facts.state !== 'Finalized') prepareSignedCommand(planContext, command); }"),
 'M33': ('api/src/emr-report/commands.ts', 'if (lower && sig.time.interval.earliest < lower)', 'if (false)'),
 'M34': ('api/src/emr-report/commands.ts',
         'if (versions.some(v => v?.recordId === p.recordId && v.versionId === p.versionId) ||\n'
         '      context.retained?.record?.parts.some(part => part.evidence.event.versionId === p.versionId)) '
         "refuse('VersionIdReused');",
         "if (facts.state !== 'Finalized' && (versions.some(v => v?.recordId === p.recordId && v.versionId === "
         'p.versionId) ||\n'
         '      context.retained?.record?.parts.some(part => part.evidence.event.versionId === p.versionId))) '
         "refuse('VersionIdReused');"),
 'M35': ('api/src/emr-report/commands.ts',
         '    let prior: Readonly<AdoptedEvent>;\n'
         "    try { prior = parseAdoptedEvent(context.predecessor); } catch { refuse('PredecessorBindingRefused'); }\n"
         '    if (prior.eventId !== p.predecessorEventId || prior.studyId !== p.studyId || prior.institutionId !== '
         'p.managingInstitutionId ||\n'
         '        !same(prior.version, p.previousVersion) || prior.ancestors.includes(p.eventId) ||\n'
         '        (prior.deviceId === p.deviceId && prior.deviceSequence >= p.deviceSequence) ||\n'
         '        !facts.contentHistory.some(h => same(h.version, prior.version) && h.at === prior.signedAt && h.use '
         "=== 'clinical'))\n"
         "      refuse('PredecessorBindingRefused');\n"
         '    predecessorAt = prior.signedAt;',
         "    if (context.predecessor.eventId !== p.predecessorEventId) refuse('PredecessorBindingRefused');\n"
         '    predecessorAt = context.predecessor.signedAt ?? null;'),
 'M36': ('worklist-v0/hpacs-lite/offline-report.js',
         'token.accountGeneration === context.accountGeneration() && token.session.epoch === context.session().epoch '
         '&&',
         ''),
 'M37': ('worklist-v0/hpacs-lite/offline-report.js', 'lanes.get(token.lane) === token.jobGeneration;', 'true;'),
 'M38': ('worklist-v0/hpacs-lite/offline-report.js',
         "if (saved?.status !== 'pending-offline' || saved.receipt?.eventId !== entry.eventId) throw new Error('no "
         "durable receipt');",
         ''),
 'M39': ('worklist-v0/hpacs-lite/offline-report.js',
         'if (!valid(token) || (token.screen && !visible(token))) return { stale: true };',
         'if (!valid(token)) return { stale: true };'),
 'M40': ('worklist-v0/hpacs-lite/offline-report.js',
         'const t = sendToken(entry);',
         'const t = sendToken(entry);\n'
         '                  if (stateOf(t.uid, t.recordId).eventId !== entry.eventId) return '
         "{stale:false,value:Promise.reject({kind:'network'})};"),
 'M41': ('worklist-v0/hpacs-lite/offline-report.js', 'if (drain && valid(drain.token)) {', 'if (false) {'),
 'M42': ('api/src/emr-report/offline-queue.ts',
         "if (row.state === 'held' && row.evidence?.reason && row.evidence.reason !== 'predecessor-unresolved')",
         "if (row.state === 'held')"),
 'M43': ('api/src/emr-report/offline-queue.ts',
         'const kept = new Map((await keptCommits()).map(a => [a.eventId, a]));',
         'const kept = new Map((await keptCommits()).filter(a => list.some(r => r.eventId === a.eventId)).map(a => '
         '[a.eventId, a]));')}


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


def failed_assertion(ran, variant, copy, node):
    """Bind the runner's actual failure to a behavioural test assertion, using Python/TypeScript ASTs.

    Syntax/import errors and assertions earlier than the declared target are never that mutant's kill evidence.
    The digest binds an assertion in a test, not any product implementation text.
    """
    if variant["suite"] == "dom":
        file = copy / DOM_FILE
        locations = re.findall(r'File "[^"]*offline_report_dom_test.py", line (\d+), in ' + re.escape(variant["case"]), ran["stderr"])
        source = file.read_text(encoding="utf-8")
        tree = ast.parse(source)
        for line in reversed(locations):
            for call in ast.walk(tree):
                if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and
                        isinstance(call.func.value, ast.Name) and call.func.value.id == "self" and call.func.attr.startswith("assert") and
                        call.lineno <= int(line) <= call.end_lineno):
                    return {"file": DOM_FILE, "line": call.lineno, "source": ast.get_source_segment(source, call).replace("\r\n", "\n")}
        return None
    relative = NODE_FILES[variant["suite"]]
    basename = Path(relative).name
    locations = [[int(line), int(col)] for line, col in re.findall(re.escape(basename) + r':(\d+):(\d+)\)', ran["stdout"])]
    if not locations:
        return None
    resolved = subprocess.run([node, NODE_FILES["contract"], "--assertion-at", str(copy / relative), json.dumps(locations)],
                              cwd=str(copy), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=TIMEOUT)
    if resolved.returncode:
        return None
    result = json.loads(resolved.stdout)
    return {"file": relative, **result} if result else None


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
                    assertion = failed_assertion(ran, entry, copy, node) if killed else None
                    if assertion:
                        assertion["sha256"] = hashlib.sha256(assertion["source"].encode("utf-8")).hexdigest()
                    expected_assertion = declared[name].get("assertion_sha256")
                    entry["assertion"] = assertion
                    entry["expected_assertion_sha256"] = expected_assertion
                    if not assertion or not expected_assertion or assertion["sha256"] != expected_assertion:
                        entry.update(killed=False, reason="failure did not reach the declared behavioural assertion")
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
