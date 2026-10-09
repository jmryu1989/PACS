# coding: utf-8
"""E-XA mutants X1..X14 (order e-xa-order.md section 5), X15..X21 (round 2: one per Astra finding EXA-R1-01..05,
two for EXA-R1-02 - model and viewer), X22..X37 (round 3: one per invariant I01..I16 of the D732 consult,
evidence/e-xa-consult-20261009/design.md section 8), X38..X42 (round 4: Astra review of 61eb967, EXA-R3-01..04),
X43..X54 (D757 persistent opening state, authorization proof and display transaction), and the case declaration check.

Each mutant breaks the shipped module in a COPY (the source tree is never written) and must be killed by a behaviour
failure: the named case fails on an assertion that carries that mutant's own token (XA-Xn:), the child exits non-zero
and nothing crashed. A mutant that only makes the code throw, or that fails some other assertion, is not a kill.
The clean copies must first pass the same runs through the same overrides, or no kill is reported.

  --check-cases   compare tests/part1/xa/cases.json with the cases the runners actually collect, both ways, and with
                  the mutant table below; a declared case that does not run or a running case that is not declared fails
  --anchors-only  check that every anchor occurs exactly once and every token is asserted in its named case, then stop
  (default)       --check-cases, anchors, clean baseline, then every mutant (X1..X54)

The anchors are source text on purpose: this runner rewrites a copy of the code, so it has to find the code. They bind
the mutation tool only; no test case asserts source text (AGENTS 1-B). stdlib only; browsers and node run as children.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCES = {
    'model': ROOT / 'worklist-v0' / 'hpacs-lite' / 'xa-playback-model.js',
    'viewer': ROOT / 'worklist-v0' / 'hpacs-lite' / 'viewer-xa-playback.js',
}
ENV = {'model': 'KIN_XA_MODEL_JS', 'viewer': 'KIN_XA_VIEWER_JS'}
SUITES = {
    'model': {'path': HERE / 'model_test.cjs'},
    'dom': {'path': HERE / 'viewer_dom_test.py', 'class': 'XaPlaybackDomTest'},
    'dicom': {'path': HERE / 'dicom_contract_test.py', 'class': 'XaDicomContractTest'},
}
CASES = HERE / 'cases.json'
CRASH = ('SyntaxError', 'ReferenceError', 'Cannot find module', 'ModuleNotFoundError', 'ERR_MODULE')

MUTANTS = [
    {'id': 'X1', 'file': 'model', 'suite': 'model', 'case': 'XA02-MODEL-ALLOW', 'token': 'XA-X1:',
     'title': 'every input plays at 10 fps',
     'old': '    return Math.abs(offsets[from] - offsets[neighbour]) / speed.rate;',
     'new': '    return 1000 / 10;'},
    {'id': 'X2', 'file': 'model', 'suite': 'model', 'case': 'XA02-MODEL-ALLOW', 'token': 'XA-X2:',
     'title': 'the Frame Time Vector is replaced by its average',
     'old': '      for (let i = 1; i < frames; i++) offsets.push(offsets[i - 1] + steps[i]);',
     'new': '      const mean = steps.slice(1).reduce((a, b) => a + b, 0) / (frames - 1);\n'
            '      for (let i = 1; i < frames; i++) offsets.push(offsets[i - 1] + mean);'},
    {'id': 'X3', 'file': 'model', 'suite': 'model', 'case': 'XA02-MODEL-ALLOW', 'token': 'XA-X3:',
     'title': 'the first 0 of the vector is added as a one-frame delay',
     'old': '      for (let i = 1; i < frames; i++) offsets.push(offsets[i - 1] + steps[i]);',
     'new': '      for (let i = 1; i < frames; i++) offsets.push(offsets[i - 1] + steps[i - 1]);'},
    {'id': 'X4', 'file': 'model', 'suite': 'model', 'case': 'XA03-MODEL-ALLOW', 'token': 'XA-X4:',
     'title': 'the last frame of the range is left out',
     'old': '    if (next >= first && next <= last) return { stop: false, direction: nextDirection, next };',
     'new': '    if (next >= first && next < last) return { stop: false, direction: nextDirection, next };'},
    {'id': 'X5', 'file': 'model', 'suite': 'model', 'case': 'XA03-MODEL-ALLOW', 'token': 'XA-X5:',
     'title': 'yoyo shows the end frame twice when it turns',
     'old': '      if (index === last && nextDirection === 1) nextDirection = -1;',
     'new': '      if (index === last && nextDirection === 1) return { stop: false, direction: -1, next: last };'},
    {'id': 'X6', 'file': 'viewer', 'suite': 'dom', 'case': 'XA04-DOM-601', 'token': 'XA-X6:',
     'title': 'the whole run is fetched eagerly',
     'old': '      const ahead = Model.aheadFor({ frameBytes: meta.frameBytes, owners });',
     'new': '      const ahead = total;'},
    {'id': 'X7', 'file': 'model', 'suite': 'model', 'case': 'XA04-MODEL-REJECT', 'token': 'XA-X7:',
     'title': 'frames still loading are left out of the reservation',
     'old': "      if (bytes + payload > limits.bytes) return no('bytes');",
     'new': "      if ([...resources.values()].filter(h => h.state === 'decoded').reduce((n, h) => n + h.payload, 0) + payload > limits.bytes) return no('bytes');"},
    {'id': 'X8', 'file': 'model', 'suite': 'model', 'case': 'XA04-MODEL-REJECT', 'token': 'XA-X8:',
     'title': 'the four-decode limit is removed',
     'old': "      if (permits >= limits.decodes) return no('decodes');",
     'new': '      // decode limit removed'},
    {'id': 'X9', 'file': 'model', 'suite': 'model', 'case': 'XA04-MODEL-REJECT', 'token': 'XA-X9:',
     'title': "one viewport's release frees a frame another viewport still holds",
     'old': "      if (held.leases.size || held.draws.size || held.displays.size) return 'kept';",
     'new': "      if (held.draws.size || held.displays.size) return 'kept';"},
    {'id': 'X10', 'file': 'viewer', 'suite': 'dom', 'case': 'XA05-DOM-BUFFERING', 'token': 'XA-X10:',
     'title': 'a frame that had not started drawing at Pause is still drawn',
     'old': "      withdraw(slot => slot.phase !== 'drawing');",
     'new': "      withdraw(slot => slot.kind === 'ahead' && slot.phase !== 'drawing');"},
    {'id': 'X11', 'file': 'model', 'suite': 'model', 'case': 'XA05-MODEL-REJECT', 'token': 'XA-X11:',
     'title': 'the opening sequence is not compared (A->B->A)',
     'old': "    if (now.study !== opened.study || now.series !== opened.series || now.sop !== opened.sop || now.sequence !== opened.sequence) return 'stale';",
     'new': "    if (now.study !== opened.study || now.series !== opened.series || now.sop !== opened.sop) return 'stale';"},
    {'id': 'X12', 'file': 'viewer', 'suite': 'dom', 'case': 'XA06-DOM-RETRY', 'token': 'XA-X12:',
     'title': 'a failed frame is stepped over',
     'old': '      return fail(slot.index, f);',
     'new': '      shown = slot.index; coverage.mark(slot.index); afterShown(); return;'},
    {'id': 'X13', 'file': 'model', 'suite': 'model', 'case': 'XA04-MODEL-ALLOW', 'token': 'XA-X13:',
     'title': 'a run is cut at 500 frames',
     'old': '    const frames = raw === undefined ? 1 : integer(raw);',
     'new': '    const frames = raw === undefined ? 1 : Math.min(integer(raw), 500);'},
    {'id': 'X14', 'file': 'viewer', 'suite': 'dom', 'case': 'XA06-DOM-NOT-SHOWN', 'token': 'XA-X14:',
     'title': 'a prepared frame is counted as shown',
     'old': "      if (!told.has(slot)) { told.add(slot); emit({ type: 'provided', index: slot.index }); }",
     'new': "      if (!told.has(slot)) { told.add(slot); coverage.mark(slot.index); emit({ type: 'provided', index: slot.index }); }"},
    # Round 2 (Astra review of 585c66f): each one puts back the defect a finding named; round 3 moved each onto the
    # one decision of the D732 ownership model that now carries it.
    {'id': 'X15', 'file': 'viewer', 'suite': 'dom', 'case': 'XA05-DOM-RENDER-RACE', 'token': 'XA-X15:',
     'title': 'EXA-R1-01: a render of an older intent still counts as the latest render request',
     'old': "        if (t.draw.G !== G) return 'drain';",
     'new': '        // a draw of an older intent stays current'},
    {'id': 'X16', 'file': 'model', 'suite': 'model', 'case': 'XA04-MODEL-RETIRING', 'token': 'XA-X16:',
     'title': 'EXA-R1-02: letting go of a load still decoding frees its bytes and slot at once',
     'old': "        held.retiring = true;\n        return 'retire';",
     'new': "        gone(held);\n        return 'retire';"},
    {'id': 'X17', 'file': 'viewer', 'suite': 'dom', 'case': 'XA04-DOM-LATE-ABORT', 'token': 'XA-X17:',
     'title': 'EXA-R1-02: a cancelled load gives its reservation back before its abort has settled',
     'old': "        res.abort.abort();\n        emit({ type: 'cancelled', index: slot.index });",
     'new': "        res.abort.abort(); ledger.settle(slot.res, false);\n        emit({ type: 'cancelled', index: slot.index });"},
    {'id': 'X18', 'file': 'model', 'suite': 'dom', 'case': 'XA05-DOM-OPENING-BINDING', 'token': 'XA-X18:',
     'title': 'EXA-R1-03: the opening is not compared with the Study/Series/SOP the source supplies',
     'old': "    if (key.study !== d.study || key.series !== d.series || key.sop !== d.sop) return Object.freeze({ ok: false, reason: 'manifest' });",
     'new': '    void d.study;'},
    {'id': 'X19', 'file': 'viewer', 'suite': 'dom', 'case': 'XA05-DOM-OPENING-BINDING', 'token': 'XA-X19:',
     'title': 'EXA-R1-03: after mount, async completions and timers no longer re-check the current opening',
     'old': '      const now = opening();',
     'new': "      const now = kind === 'mount' || kind === 'notice' ? opening() : 'current';"},
    {'id': 'X20', 'file': 'model', 'suite': 'model', 'case': 'XA02-MODEL-BASIS', 'token': 'XA-X20:',
     'title': 'EXA-R1-04: Frame Delay is dropped from the source timeline',
     'old': '    const relative = offsets.map(o => frameDelay + o);',
     'new': '    const relative = offsets.slice();'},
    {'id': 'X21', 'file': 'model', 'suite': 'model', 'case': 'XA02-MODEL-DT', 'token': 'XA-X21:',
     'title': 'EXA-R1-05: a DT offset outside -1200..+1400 is accepted',
     'old': "      if (zone < -720 || zone > 840 || (m[8] === '-' && zone === 0)) return null;",
     'new': "      if (m[8] === '-' && zone === 0) return null;"},
    # Round 3 (D732 consult, design.md section 8): one per invariant I01..I16, each a change of one decision of the
    # ownership ledger or the gate. 'where' names the shared matrix helper a DOM case runs (the token sits there).
    {'id': 'X22', 'file': 'model', 'suite': 'model', 'case': 'B08-MODEL', 'token': 'XA-X22:',
     'title': 'I01: the sharing key drops the opening/security/source scope and keeps only SOP#frame',
     'old': '      const id = JSON.stringify([scope, key]);',
     'new': '      const id = JSON.stringify([key]);'},
    {'id': 'X23', 'file': 'viewer', 'suite': 'dom', 'case': 'R01-DOM', 'where': 'late_seek', 'token': 'XA-X23:',
     'title': 'I02: the presentation generation moves when a new draw starts, not when the reader asks',
     'edits': [("      G = ++seq; P = ++seq;\n      cancelSleep(); dequeue(self); memoryWait = false; skip.clear(); pendingDue = null;",
                "      P = ++seq;\n      cancelSleep(); dequeue(self); memoryWait = false; skip.clear(); pendingDue = null;"),
               ('      const J = { draw: d.draw, surface: Object.freeze({}), slot, res, G, void: false, ended: false, abort: new AbortController(), timer: null };',
                '      G = ++seq; slot.G = G;\n      const J = { draw: d.draw, surface: Object.freeze({}), slot, res, G, void: false, ended: false, abort: new AbortController(), timer: null };')]},
    {'id': 'X24', 'file': 'viewer', 'suite': 'dom', 'case': 'B01-DOM', 'token': 'XA-X24:',
     'title': 'I03: the deferred source.load() call trusts the check made when the request was queued',
     'old': "    if (!wanted(res)) { broker.ledger.abandon(res.token); endResource(res, { kind: 'cancelled', status: null }); return; }",
     'new': '    // decided when the request was queued'},
    {'id': 'X25', 'file': 'model', 'suite': 'model', 'case': 'B09-MODEL', 'token': 'XA-X25:',
     'title': "I04: a second viewport's surface is treated as covered by the shared payload",
     'old': '      const cost = surface;',
     'new': '      const cost = held.draws.size || held.displays.size ? 0 : surface;'},
    {'id': 'X26', 'file': 'model', 'suite': 'model', 'case': 'B06-MODEL', 'token': 'XA-X26:',
     'title': 'I05: a new consumer may join a retiring load',
     'old': "        if (held.retiring || held.state === 'draining') return no('busy');",
     'new': "        if (held.state === 'draining') return no('busy');"},
    {'id': 'X27', 'file': 'model', 'suite': 'dom', 'case': 'D08-DOM', 'where': 'late_abort', 'token': 'XA-X27:',
     'title': 'I06: an abort request gives the decode permit back before the decoder has stopped',
     'old': "        held.retiring = true;\n        return 'retire';",
     'new': "        held.retiring = true; held.permit = false; permits--;\n        return 'retire';"},
    {'id': 'X28', 'file': 'viewer', 'suite': 'dom', 'case': 'R06-DOM', 'where': 'late_pressure', 'token': 'XA-X28:',
     'title': 'I07: a superseded draw gives its surface and frame back when it is asked to stop',
     'old': '      try { J.abort.abort(); } catch (_) {}  // asked to stop; its surface and its frame stay pinned until it really ends',
     'new': '      try { J.abort.abort(); } catch (_) {}  endDraw(J);'},
    {'id': 'X29', 'file': 'model', 'suite': 'model', 'case': 'B07-MODEL', 'token': 'XA-X29:',
     'title': 'I08: a frame on screen may be reclaimed under pressure once nothing is loading or drawing it',
     'old': "    const reclaimable = h => !!h && h.state === 'decoded' && !h.leases.size && !h.draws.size && !h.displays.size;",
     'new': "    const reclaimable = h => !!h && h.state === 'decoded' && !h.leases.size && !h.draws.size;"},
    {'id': 'X30', 'file': 'viewer', 'suite': 'dom', 'case': 'R01-DOM', 'where': 'late_seek', 'token': 'XA-X30:',
     'title': 'I09: a privately prepared surface is published without the current-draw check',
     'old': "      if (verdict === 'current' && !error && receiptOk(receipt, J)) { publish(J); return; }",
     'new': "      if (verdict !== 'reject' && !error && receiptOk(receipt, J)) { publish(J); return; }"},
    {'id': 'X31', 'file': 'viewer', 'suite': 'dom', 'case': 'B03-DOM', 'token': 'XA-X31:',
     'title': 'I10: a render receipt is accepted when only the frame number matches',
     'old': '    const receiptOk = (r, J) => !!r && r.draw === J.draw && r.surface === J.surface && r.sop === meta.sop &&\n      r.frame === J.slot.index + 1 && r.opening === opened.sequence;',
     'new': '    const receiptOk = (r, J) => !!r && r.frame === J.slot.index + 1 && !!r.surface;'},
    {'id': 'X32', 'file': 'viewer', 'suite': 'dom', 'case': 'B04-DOM', 'token': 'XA-X32:',
     'title': 'I11: the label, coverage and displayed move when the target is decoded, before its render',
     'old': "      if (!told.has(slot)) { told.add(slot); emit({ type: 'provided', index: slot.index }); }",
     'new': "      if (!told.has(slot)) { told.add(slot); emit({ type: 'provided', index: slot.index }); if (slot === target) { shown = slot.index; coverage.mark(slot.index); paint(); emit({ type: 'displayed', index: slot.index }); } }"},
    {'id': 'X33', 'file': 'viewer', 'suite': 'dom', 'case': 'B10-DOM', 'token': 'XA-X33:',
     'title': "I12: the new opening's cover is lifted when its first frame is decoded",
     'old': "      slot.phase = 'decoded';\n      clearTimer(slot);",
     'new': "      slot.phase = 'decoded'; if (physical.covered) coverPhysical(false);\n      clearTimer(slot);"},
    {'id': 'X34', 'file': 'viewer', 'suite': 'dom', 'case': 'XA06-DOM-RENDER-TIMEOUT', 'token': 'XA-X34:',
     'title': 'I13: a timed-out render that is still the latest recovers on its own when it answers',
     'old': "        if (t.draw.void) return 'drain';",
     'new': "        if (t.draw.void && t.draw.G === G) { O.failed = null; return 'current'; }"},
    {'id': 'X35', 'file': 'model', 'suite': 'model', 'case': 'B05-MODEL', 'token': 'XA-X35:',
     'title': 'I14: cleanup finds the current resource by its frame key instead of the exact token',
     'old': '    const exact = t => (t && resources.get(t)) || null;',
     'new': '    const exact = t => (t && (resources.get(t) || byScope.get(JSON.stringify([t.scope, t.key])))) || null;'},
    {'id': 'X36', 'file': 'viewer', 'suite': 'dom', 'case': 'R02-DOM', 'where': 'late_pause', 'token': 'XA-X36:',
     'title': 'I15: Pause also takes away the right to publish from a draw already under way',
     'old': "      withdraw(slot => slot.phase !== 'drawing');",
     'new': '      withdraw(slot => true);'},
    {'id': 'X37', 'file': 'model', 'suite': 'model', 'case': 'B15-MODEL', 'token': 'XA-X37:',
     'title': 'I16: DT is trimmed of any white space instead of only trailing ASCII SPACE',
     'old': '    const text = v.slice(0, end);',
     'new': '    const text = v.trim();'},
    # Round 4 (Astra review of 61eb967): each one puts back the defect a finding named.
    {'id': 'X38', 'file': 'viewer', 'suite': 'dom', 'case': 'EXA-R3-01-DOM', 'token': 'XA-X38:',
     'title': 'EXA-R3-01: a receipt is published when it carries any surface, not the one issued to this draw',
     'old': '&& r.surface === J.surface &&',
     'new': '&& !!r.surface &&'},
    {'id': 'X39', 'file': 'viewer', 'suite': 'dom', 'case': 'EXA-R3-01-DOM', 'token': 'XA-X39:',
     'title': 'EXA-R3-01: a refused receipt gives back the surface it names as if it were its own',
     'old': "      if (verdict === 'current') fail(J.slot.index, { kind: 'render' });\n      endDraw(J);",
     'new': "      if (verdict === 'current') fail(J.slot.index, { kind: 'render' });\n      if (receipt?.surface) viewport.release?.(receipt.surface);\n      endDraw(J);"},
    {'id': 'X40', 'file': 'viewer', 'suite': 'dom', 'case': 'EXA-R3-02-DOM', 'token': 'XA-X40:',
     'title': 'EXA-R3-02: a 401/403 on a look-ahead frame is only skipped',
     'old': '    const O = Q.opening;',
     'new': "    if (![...broker.resources.values()].some(r => r.Q === Q && [...r.consumers].some(s => s.kind === 'target'))) return;\n    const O = Q.opening;"},
    {'id': 'X41', 'file': 'viewer', 'suite': 'dom', 'case': 'EXA-R3-03-DOM', 'token': 'XA-X41:',
     'title': 'EXA-R3-03: the claim ignores a cover that failed and loads over the previous Study',
     'old': '      if (coverPhysical(true)) return true;',
     'new': '      coverPhysical(true); physical.covered = true; physical.safe = true; return true;'},
    {'id': 'X42', 'file': 'viewer', 'suite': 'dom', 'case': 'XA06-DOM-RENDER-TIMEOUT', 'token': 'XA-X42:',
     'title': 'EXA-R3-04: Retry after a render timeout during playback restarts playback',
     'old': '      const resume = playing && !error?.timedOut;',
     'new': '      const resume = playing;'},
    {'id': 'X43', 'file': 'viewer', 'suite': 'dom', 'case': 'C03-DOM', 'token': 'XA-X43:',
     'title': 'I17 direction clears the authoritative blocking reasons',
     'old': "      if (gate('settings') !== 'current') { paint(); return; }",
     'new': '      O.access = null; O.failed = null; O.faults.clear();'},
    {'id': 'X44', 'file': 'viewer', 'suite': 'dom', 'case': 'C01-DOM', 'token': 'XA-X44:',
     'title': 'I18 access outcome requires a remaining current consumer',
     'old': '    const O = Q.opening;',
     'new': '    if (![...broker.resources.values()].some(r => r.Q === Q && wanted(r))) return;\n    const O = Q.opening;'},
    {'id': 'X45', 'file': 'viewer', 'suite': 'dom', 'case': 'C06-DOM', 'token': 'XA-X45:',
     'title': 'I19 denial targets the current same-SOP opening instead of its request opening',
     'old': '    const O = Q.opening;',
     'new': '    const O = [...broker.openings.values()].reverse().find(o => !o.ended && o.key.sop === Q.opening.key.sop) || Q.opening;'},
    {'id': 'X46', 'file': 'viewer', 'suite': 'dom', 'case': 'C09-DOM', 'token': 'XA-X46:',
     'title': 'I20 proof completion ignores the current attempt and denial generation',
     'old': "        const valid = current() && proof?.attempt === attempt && proof?.authorized === true && proof?.fresh === true &&",
     'new': "        const valid = gate('retry') === 'current' && proof?.attempt === attempt && proof?.authorized === true && proof?.fresh === true &&"},
    {'id': 'X47', 'file': 'viewer', 'suite': 'dom', 'case': 'C03-DOM', 'token': 'XA-X47:',
     'title': 'I21 recovery accepts a failed physical barrier as safe',
     'old': '        if (!hide()) { paint(); return; }',
     'new': '        hide(); physical.safe = true;'},
    {'id': 'X48', 'file': 'viewer', 'suite': 'dom', 'case': 'C02-DOM', 'token': 'XA-X48:',
     'title': 'I22 cached seek gets effect permission despite an unchanged access latch',
     'old': "      if (['notice', 'pause', 'retry', 'end'].includes(kind)) return 'current';",
     'new': "      if (O.access && ['seek', 'bring', 'admit', 'supply', 'draw', 'publish'].includes(kind)) return 'current';\n      if (['notice', 'pause', 'retry', 'end'].includes(kind)) return 'current';"},
    {'id': 'X49', 'file': 'viewer', 'suite': 'dom', 'case': 'C11-DOM', 'token': 'XA-X49:',
     'title': 'I23 Retry clears Failed before the recovery target has committed',
     'old': "      O.failed = { index, kind: f.kind, resume: recovery.resume };",
     'new': '      O.failed = null; // Retry prematurely clears the latch'},
    {'id': 'X50', 'file': 'viewer', 'suite': 'dom', 'case': 'C04-DOM', 'token': 'XA-X50:',
     'title': 'I24 display facts commit before uncover succeeds',
     'old': '      if (physical.covered && !coverPhysical(false)) {',
     'new': '      commitDisplay(J);\n      if (physical.covered && !coverPhysical(false)) {'},
    {'id': 'X51', 'file': 'viewer', 'suite': 'dom', 'case': 'C04-DOM', 'token': 'XA-X51:',
     'title': 'I25 uncover failure releases the still attached hidden front',
     'old': '        physical.safe = false; block(); return;',
     'new': '        ledger.detach(J.draw); releaseSurface(J.draw); physical.safe = false; block(); return;'},
    {'id': 'X52', 'file': 'viewer', 'suite': 'dom', 'case': 'C13-DOM', 'token': 'XA-X52:',
     'title': 'I26 restored authorization revives old revoked prepared draws',
     'old': "        if (t.draw.void) return 'drain';",
     'new': "        if (O.auth && !O.access && !O.faults.size) return 'current';\n        if (t.draw.void) return 'drain';"},
    {'id': 'X53', 'file': 'viewer', 'suite': 'dom', 'case': 'C14-DOM', 'token': 'XA-X53:',
     'title': 'I27 displayed observer runs before label and full facts are committed',
     'old': '      shownSlot = slot; shown = index;',
     'new': "      emit({ type: 'displayed', index });\n      shownSlot = slot; shown = index;"},
    {'id': 'X54', 'file': 'viewer', 'suite': 'dom', 'case': 'C16-DOM', 'token': 'XA-X54:',
     'title': 'I28 normal seek requires an unnecessary Retry',
     'old': "      if (gate('seek') !== 'current') { paint(); return; }",
     'new': "      if (gate('seek') === 'current') { fail(index, { kind: 'failed' }); return; }"},
]


def edits(m):
    return m.get('edits') or [(m['old'], m['new'])]


def text_hash(path):
    """SHA-256 of the text with LF line ends, so a CRLF checkout and the LF blob hash the same."""
    return hashlib.sha256(Path(path).read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def load_cases():
    return json.loads(CASES.read_text(encoding='utf-8'))


def declared(cases):
    return {suite: {c['id']: c for c in body['cases']} for suite, body in cases['suites'].items()}


def child_env(overrides):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    for name, path in overrides.items():
        env[ENV[name]] = str(path)
    return env


def run_node(overrides, name=None, timeout=300):
    command = ['node', '--test', '--test-reporter=tap']
    if name:
        command.append('--test-name-pattern=^' + re.escape(name) + '$')
    command.append(str(SUITES['model']['path']))
    done = subprocess.run(command, cwd=str(ROOT), env=child_env(overrides), capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=timeout)
    return done.returncode, (done.stdout or '') + (done.stderr or '')


def run_python(suite, overrides, method=None, timeout=900):
    target = ['%s.%s' % (SUITES[suite]['class'], method)] if method else []
    done = subprocess.run([sys.executable, '-B', str(SUITES[suite]['path'])] + target, cwd=str(ROOT), env=child_env(overrides),
                          capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    return done.returncode, (done.stdout or '') + (done.stderr or '')


def tap_results(output):
    """Top-level node:test results: name -> (passed, the YAML block under it)."""
    results, lines = {}, output.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r'^(not ok|ok) \d+ - (.+?)(?: # .*)?$', line)
        if not m:
            continue
        block = []
        for follow in lines[i + 1:]:
            if re.match(r'^(not ok|ok) \d+ - ', follow) or follow.startswith('# Subtest:'):
                break
            block.append(follow)
        results[m.group(2)] = (m.group(1) == 'ok', '\n'.join(block))
    return results


def python_failure(output, method):
    named = any(re.match(r'^FAIL: %s \(' % re.escape(method), line) for line in output.splitlines())
    blocks = re.split(r'^={10,}$', output, flags=re.MULTILINE)
    mine = '\n'.join(b for b in blocks if re.search(r'^FAIL: %s \(' % re.escape(method), b, flags=re.MULTILINE))
    return named, mine


def collect_python(suite):
    path = SUITES[suite]['path']
    spec = importlib.util.spec_from_file_location('e_xa_collect_' + suite, path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(path.parent))
    names = []
    for test in unittest.defaultTestLoader.loadTestsFromModule(module):
        for case in test:
            names.append((type(case).__name__, case._testMethodName))
    return names


def check_cases(problems):
    cases = load_cases()
    table = declared(cases)
    # node: the cases that actually run (a TAP pass over the shipped model, nothing filtered)
    code, output = run_node({})
    ran = tap_results(output)
    model_names = {c['name'] for c in table['model'].values()}
    if code != 0:
        problems.append('model suite does not pass on the shipped model (exit %d)' % code)
    for missing in sorted(model_names - set(ran)):
        problems.append('declared model case did not run: %s' % missing)
    for extra in sorted(set(ran) - model_names):
        problems.append('model case runs but is not declared: %s' % extra)
    collected_counts = {'model': len(ran)}
    for suite in ('dom', 'dicom'):
        collected = collect_python(suite)
        names = {method for klass, method in collected if klass == SUITES[suite]['class']}
        collected_counts[suite] = len(collected)
        if {klass for klass, _ in collected} != {SUITES[suite]['class']}:
            problems.append('%s collects classes %s' % (suite, sorted({k for k, _ in collected})))
        want = {c['method'] for c in table[suite].values()}
        for missing in sorted(want - names):
            problems.append('declared %s case is not collected: %s' % (suite, missing))
        for extra in sorted(names - want):
            problems.append('%s case is collected but not declared: %s' % (suite, extra))
    for suite, body in cases['suites'].items():
        expected_path = SUITES[suite]['path'].relative_to(ROOT).as_posix()
        if body['path'] != expected_path:
            problems.append('%s path %s != %s' % (suite, body['path'], expected_path))
        for c in body['cases']:
            req = next((r for r in cases['requirements'] if r['test'] == c['test']), None)
            if not req or req['req'] != c['req'] or req['risk'] != c['risk']:
                problems.append('%s does not match the REQ/RISK/TEST table' % c['id'])
    counts = {s: len(b['cases']) for s, b in cases['suites'].items()}
    if counts != cases['planned_counts']:
        problems.append('planned counts %s != declared %s' % (cases['planned_counts'], counts))
    declared_mutants = {m['id']: (m['case'], m['token'], m['file']) for m in cases['mutants']}
    mine = {m['id']: (m['case'], m['token'], SOURCES[m['file']].relative_to(ROOT).as_posix()) for m in MUTANTS}
    if declared_mutants != mine:
        problems.append('cases.json mutants differ from the runner table')
    for name, recorded in cases['inputs'].items():
        if text_hash(ROOT / name) != recorded:
            problems.append('input hash changed: %s' % name)
    print('check-cases: collected %s declared %s problems=%d' % (collected_counts, counts, len(problems)))
    return table


def check_anchors(problems, table):
    sources = {name: path.read_text(encoding='utf-8') for name, path in SOURCES.items()}
    tests = {suite: body['path'].read_text(encoding='utf-8') for suite, body in SUITES.items()}
    tokens = set()
    for m in MUTANTS:
        for old, new in edits(m):
            found = sources[m['file']].count(old)
            print('anchor %-3s file=%-6s occurrences=%d case=%s' % (m['id'], m['file'], found, m['case']))
            if found != 1:
                problems.append('%s anchor occurs %d times' % (m['id'], found))
            if new in sources[m['file']]:
                problems.append('%s mutation is already the shipped text' % m['id'])
        if m['token'] in tokens:
            problems.append('%s reuses a token' % m['id'])
        tokens.add(m['token'])
        case = table[m['suite']].get(m['case'])
        if not case:
            problems.append('%s names an undeclared case %s' % (m['id'], m['case']))
            continue
        if m['token'] not in tests[m['suite']]:
            problems.append('%s token is asserted nowhere in %s' % (m['id'], m['suite']))
        # The token must sit inside the named case, not in another one.
        body = tests[m['suite']]
        if m['suite'] == 'model':
            start = body.find("test('%s'" % case['name'].replace("'", "\\'"))
            end = body.find('\ntest(', start + 1)
        else:
            start = body.find('def %s(' % case['method'])
            end = body.find('\n    def ', start + 1)
            # A matrix case runs a shared helper: the case must call it, and the token must sit in that helper.
            if m.get('where') and start >= 0:
                if 'self.%s(' % m['where'] not in body[start:end if end > 0 else None]:
                    problems.append('%s case %s does not run %s' % (m['id'], m['case'], m['where']))
                start = body.find('def %s(' % m['where'])
                end = body.find('\n    def ', start + 1)
        if start < 0 or m['token'] not in body[start:end if end > 0 else None]:
            problems.append('%s token is not asserted inside %s' % (m['id'], m['case']))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', help='summary JSON path; per-run logs are written next to it')
    parser.add_argument('--check-cases', action='store_true')
    parser.add_argument('--anchors-only', action='store_true')
    parser.add_argument('--only', help='comma-separated mutant ids (for a focused rerun; the summary says so)')
    args = parser.parse_args()
    if not shutil.which('node'):
        print('node is not on PATH: nothing can be verified')
        return 1
    before = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in SOURCES.items()}
    for name in sorted(before):
        print('%s sha256 %s' % (SOURCES[name].name, before[name]))
    problems = []
    table = check_cases(problems)
    if args.check_cases:
        for p in problems:
            print('CASE FAILURE:', p)
        return 1 if problems else 0
    check_anchors(problems, table)
    if problems:
        for p in problems:
            print('FAILURE:', p)
        return 1
    if args.anchors_only:
        print('anchors and cases ok (no mutant run requested)')
        return 0
    chosen = [m for m in MUTANTS if not args.only or m['id'] in args.only.split(',')]
    logs = Path(args.out).parent if args.out else None
    if logs:
        logs.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix='e-xa-mutants-'))
    results = []
    try:
        clean = {}
        for name, path in SOURCES.items():
            clean[name] = scratch / ('clean-' + path.name)
            shutil.copyfile(path, clean[name])
        baseline = []
        for suite in sorted({m['suite'] for m in chosen}):
            code, output = run_node(clean) if suite == 'model' else run_python(suite, clean)
            if logs:
                (logs / ('baseline-%s.log' % suite)).write_text(output, encoding='utf-8')
            ok = code == 0 and not any(c in output for c in CRASH)
            print('BASELINE %-5s exit=%d ok=%s' % (suite, code, ok))
            baseline.append({'suite': suite, 'exit': code, 'ok': ok})
            if not ok:
                print(output[-3000:])
                print('BASELINE FAILED - no kill is reported')
                return 1
        for m in chosen:
            source = SOURCES[m['file']].read_text(encoding='utf-8')
            broken = scratch / ('%s-%s' % (m['id'], SOURCES[m['file']].name))
            mutated = source
            for old, new in edits(m):
                mutated = mutated.replace(old, new)
            broken.write_text(mutated, encoding='utf-8')
            if broken.read_text(encoding='utf-8') == source:
                raise AssertionError(m['id'])
            overrides = dict(clean, **{m['file']: broken})
            case = table[m['suite']][m['case']]
            if m['suite'] == 'model':
                code, output = run_node(overrides, case['name'])
                results_tap = tap_results(output)
                named = case['name'] in results_tap and not results_tap[case['name']][0]
                block = results_tap.get(case['name'], (True, ''))[1]
            else:
                code, output = run_python(m['suite'], overrides, case['method'])
                named, block = python_failure(output, case['method'])
            crashed = any(c in output for c in CRASH)
            assertion = ('AssertionError' in block or 'ERR_ASSERTION' in block)
            matched = m['token'] in block
            killed = code != 0 and named and assertion and matched and not crashed
            if logs:
                (logs / ('%s.log' % m['id'])).write_text(output, encoding='utf-8')
            print('%-3s %-6s case=%-20s exit=%d named=%s assertion=%s token=%s crash=%s killed=%s'
                  % (m['id'], m['file'], m['case'], code, named, assertion, matched, crashed, killed))
            results.append({'id': m['id'], 'title': m['title'], 'file': SOURCES[m['file']].relative_to(ROOT).as_posix(),
                            'suite': m['suite'], 'case': m['case'], 'child_exit': code, 'named_failure': named,
                            'assertion': assertion, 'token': m['token'], 'token_in_failure': matched, 'crash': crashed,
                            'killed': killed, 'mutant_sha256': hashlib.sha256(broken.read_bytes()).hexdigest()})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    after = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in SOURCES.items()}
    unchanged = after == before
    summary = {'source_sha256_before': before, 'source_sha256_after': after, 'source_unchanged': unchanged,
               'selection': 'all' if not args.only else args.only, 'baseline': baseline, 'results': results}
    if args.out:
        Path(args.out).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
        print('summary written to %s' % args.out)
    survivors = [r['id'] for r in results if not r['killed']]
    print('sources unchanged=%s killed=%d survived=%s' % (unchanged, len(results) - len(survivors), survivors or 'none'))
    return 0 if unchanged and not survivors else 1


if __name__ == '__main__':
    raise SystemExit(main())
