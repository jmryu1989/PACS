# coding: utf-8
"""W9-API (W9-LITE server half, D1500): server mutants of the viewing-set resolve.

REQ W9L-01/02/06/07 -> RISK W9L-R01/R02/R06/R07 -> TEST tests/multi_study_view_service_test.cjs (T02 T03 T04 T10 T16 T18).
Spec mutants M01 M04 M05 M06 M15 M17 (spec-w9-lite requirement-risk-test.json) and the server extras of the W9-API order
(A-10) each break one product rule on purpose; the named case must fail on THE assertion that rule is about.

Rules (the U5/U2a mutant runners' rules, applied to the API source):
  * the source tree is never mutated: every variant, and first the unmutated BASELINE, is a fresh copy of api/src reached
    through the loader's KIN_TEST_API_SRC override, so a broken override cannot manufacture kills;
  * each anchor must occur exactly once in its file (line endings normalised to LF in the copy);
  * a kill needs a non-zero exit AND the named case reported `not ok` AND that failure an AssertionError
    (code 'ERR_ASSERTION') AND the mutant's own `expect` text inside that failure. A load error, a crash outside an
    assertion or another case's failure is `broken`, never a kill; a passing case is `survived`.
W9-UI appends its UI mutants to this file later (serial writer); the observation-route mutants (spec M16, accessRef as a
permission, replayed observation) are not applicable here: D1500 D-6 lands that route with Module A.

usage: python -B tests/multi_study_view_mutants.py --out <new directory> [--only ID ...]
Records under <out>/: baseline/tap.txt, <id>/{variant file, diff.txt, tap.txt, record.json}, summary.json (also printed).
Exit 0 only when the baseline passes and every mutant is killed. stdlib only; node from PATH.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = Path(__file__).resolve().parents[1]
API_SRC = ROOT / 'api' / 'src'
TEST = ROOT / 'tests' / 'multi_study_view_service_test.cjs'
SERVICE, CONTROLLER = 'multi-study-view.service.ts', 'multi-study-view.controller.ts'
ROLE = "    try { need(c.roles, 'radiologist', '여러 검사 열기'); } catch { throw viewForbidden(); }\n"
MEMBER_LOOP = '        for (const m of members) {\n          m.state = first.get(m.uid) ?? null;\n          if (!m.state ||'
KEY = 'key: `${m.state!.institutionId}|${patientId}`'
PREPARE = '      try { receipts = await within(() => preparing, signal); } catch (error) {'
STUDY_ACCESS, ORTHANC = 'study-access.service.ts', 'orthanc.service.ts'
# X29 moves the policy-revision check of StudyAccess before its rights read: one contiguous span of study-access.service.ts
# (the end of prepare() through allowed()'s re-check), cut from the file as it is so the anchor stays exact.
_SA = (API_SRC / STUDY_ACCESS).read_bytes().decode('utf-8').replace('\r\n', '\n')
_SA_FROM, _SA_TO = '    await this.unchanged(c,scope);\n  }\n', '    const latest=tx?policy:await this.unchanged(c,policy);'
REVISION_SPAN = _SA[_SA.index(_SA_FROM):_SA.index(_SA_TO) + len(_SA_TO)]
REVISION_FIRST = REVISION_SPAN.replace(_SA_FROM, '  }\n', 1).replace(
    '      if(!tx)await this.prepare(c,remaining,policy,signal);',
    '      if(!tx)await this.unchanged(c,policy);\n      if(!tx)await this.prepare(c,remaining,policy,signal);', 1).replace(
    _SA_TO, '    const latest=policy;', 1)

# W9-API r3 (D1562/D1564, R3-M01..M14): faults of the source-response owner in orthanc.service.ts, cut from the live file
# so every anchor is exact. A leaky twin of the owner (fetch with the caller's signal, no cleanup at all) replaces the
# owner for one wrapper at a time (R3-M01).
_OR = (API_SRC / ORTHANC).read_bytes().decode('utf-8').replace('\r\n', '\n')
_OWNER = '  private async withSourceResponse<T>('
_LEAKY = ('  private async leakySourceResponse<T>(path: string, init: RequestInit, signal: AbortSignal | undefined, consume: any,\n'
          '      transport?: any): Promise<T> {\n'
          '    let response: Response;\n'
          '    try { response = await fetch(this.base + path, { ...init, signal }); } catch (error) { throw transport ? transport(error) : error; }\n'
          '    const owned = response;\n'
          '    return await consume(owned, () => owned.body!.getReader(), signal ?? new AbortController().signal);\n'
          '  }\n\n')


def _owner_span(call):
    """From the owner's definition to one wrapper's call of it (both in the live file, the owner first)."""
    start = _OR.index(_OWNER)
    end = _OR.index(call, start) + len(call)
    return _OR[start:end]


def _leaky_for(call):
    span = _owner_span(call)
    return dict(old=span, new=_LEAKY + span[:-len(call)] + call.replace('this.withSourceResponse(', 'this.leakySourceResponse(', 1))


_CALLS = {
    'get': '    return this.withSourceResponse(path, { method: body === undefined',
    'viewerJson': '      return await this.withSourceResponse(path, {\n        method: body === undefined',
    'srBytes': '      return await this.withSourceResponse(path, { method: body ?',
    'lookupInstance': "    return this.withSourceResponse('/tools/lookup', {",
}
_STOP_FROM = '    const stop = () => {'
_FINALLY_TO = '      if (reader) { await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* already released */ } }\n    }\n'
_OWNER_BODY = _OR[_OR.index(_STOP_FROM):_OR.index(_FINALLY_TO) + len(_FINALLY_TO)]
_LOCKED_ONLY = _OWNER_BODY.replace(
    '      controller.abort();\n      const cancelling = reader ? reader.cancel() : response?.body && !response.body.locked ? response.body.cancel() : undefined;\n'
    '      void cancelling?.catch(() => {});\n',
    '      void response?.body?.cancel().catch(() => {});\n', 1).replace(
    _FINALLY_TO, '      if (reader) { try { reader.releaseLock(); } catch { /* already released */ } }\n    }\n', 1)
_VJ_FROM = '    const bounds = OrthancService.readLimit(signal, () => { timedOut = true; }), bound = bounds.signal;'
_RL_TO = "    return { signal: bound.signal, release: () => { clearTimeout(timer); signal?.removeEventListener('abort', follow); } };"
_VJ_SPAN = _OR[_OR.index(_VJ_FROM):_OR.index(_RL_TO) + len(_RL_TO)]
_VJ_REFRESH = _VJ_SPAN.replace('          chunks.push(value);\n', '          chunks.push(value); (bounds as any).timer.refresh();\n', 1).replace(
    _RL_TO, "    return { timer, signal: bound.signal, release: () => { clearTimeout(timer); signal?.removeEventListener('abort', follow); } };", 1)
R3_MUTANTS = [
    *[dict(id=f'R3-M01-{name}', title=f'terminal cleanup absent in {name} only (the other wrappers fixed)', file=ORTHANC,
           case='W9API-25', expect=f'A02 {name} 401 U: body and socket close', **_leaky_for(call)) for name, call in _CALLS.items()],
    dict(id='R3-M02-reader-only', title='reader-only cleanup: an error Response before any reader is dropped', file=ORTHANC,
         case='W9API-25', expect='A02 get 401 U: body and socket close',
         old="      signal?.removeEventListener('abort', stop);\n      stop();\n", new="      signal?.removeEventListener('abort', stop);\n"),
    dict(id='R3-M03-locked-body-cancel', title='only response.body.cancel (fails on a locked body), releaseLock without cancel, no abort', file=ORTHANC,
         case='W9API-25', expect='A04 get H: settles promptly', old=_OWNER_BODY, new=_LOCKED_ONLY),
    dict(id='R3-M04-return-without-await', title='return consume() without await inside the owner: cleanup cancels a valid body', file=ORTHANC,
         case='W9API-25', expect='A01 get segmented completes',
         old='      return await consume(owned,', new='      return consume(owned,'),
    dict(id='R3-M05-drain-error-body', title='an error body is read to its end before the refusal', file=ORTHANC,
         case='W9API-25', expect='A02 get 401 U: settles promptly',
         old='      if (!res.ok) throw new ServiceUnavailableException(`Orthanc HTTP ${res.status}`);\n      return OrthancService.jsonBody(res, read, owned);\n    }, (e: any) => new ServiceUnavailableException(`Orthanc에 연결할 수 없습니다: ${e?.message}`));\n  }\n\n  /**\n   * 서버',
         new='      if (!res.ok) { await res.text(); throw new ServiceUnavailableException(`Orthanc HTTP ${res.status}`); }\n      return OrthancService.jsonBody(res, read, owned);\n    }, (e: any) => new ServiceUnavailableException(`Orthanc에 연결할 수 없습니다: ${e?.message}`));\n  }\n\n  /**\n   * 서버'),
    dict(id='R3-M06-detach-at-headers', title='the caller signal is detached once the headers arrive', file=ORTHANC,
         case='W9API-25', expect='A04 get U: settles promptly',
         old='      const owned = response;\n      controller.signal.throwIfAborted();',
         new="      signal?.removeEventListener('abort', stop);\n      const owned = response;\n      controller.signal.throwIfAborted();"),
    dict(id='R3-M07-refresh-per-chunk', title='the 5 s read limit restarts at every body chunk', file=ORTHANC,
         case='W9API-25', expect='A04 the 5 s bound ends a trickle: settles promptly', old=_VJ_SPAN, new=_VJ_REFRESH),
    dict(id='R3-M08-resolve-finally-timers-only', title='the resolve exit only clears timers and leaves its source signals active', file=SERVICE,
         case='W9API-26', expect='A07 answer: every source signal the resolve owned is ended',
         old='      deadline.abort(); servedCut.abort();\n', new=''),
    dict(id='R3-M09-late-result-cached', title='a preparation answer after the abort is cached as a permission fact', file=STUDY_ACCESS,
         case='W9API-26', expect='a late preparation answer is never a cached permission fact',
         old='      signal?.throwIfAborted();\n', new=''),
    dict(id='R3-M10-dispatch-after-abort', title='an already-aborted caller signal is ignored and the request is dispatched', file=ORTHANC,
         case='W9API-25', expect='A04 get: an aborted signal dispatches zero requests',
         old="    if (signal?.aborted) controller.abort();\n    else signal?.addEventListener('abort', stop, { once: true });\n    try {\n      try {\n        controller.signal.throwIfAborted();\n",
         new="    signal?.addEventListener('abort', stop, { once: true });\n    try {\n      try {\n"),
    dict(id='R3-M14-gc-only', title='no deterministic cleanup at all: release left to GC', file=ORTHANC,
         case='W9API-25', expect='A02 get 401 U: body and socket close',
         old="    } finally {\n      signal?.removeEventListener('abort', stop);\n      stop();\n" + _FINALLY_TO[:_FINALLY_TO.index('\n    }\n') + 1] + '    }\n',
         new='    } finally { /* GC only */ }\n'),
]

MUTANTS = [
    dict(id='M01', spec=True, title='the same patient judged by the source name instead of the PatientID', file=SERVICE,
         case='W9API-06', expect='two normal studies with one PatientID must open as one set',
         old=KEY, new="key: `${m.state!.institutionId}|${OrthancService.tag(m.rows[0], '00100010')}`"),
    dict(id='M04-scope', spec=True, title='the last member skips the visibility, own-institution and tele checks', file=SERVICE,
         case='W9API-03', expect='must be judged on its own',
         old=MEMBER_LOOP, new='        for (const m of members) {\n          m.state = first.get(m.uid) ?? null;\n'
                              '          if (m === members[members.length - 1]) continue;\n          if (!m.state ||'),
    # The post-read source-tag match (SRW9-1) still refuses this member, so the kill is the pre-read rule: a member StudyAccess
    # refuses is never read at all.
    dict(id='M04-access', spec=True, title='the last member skips the StudyAccess decision', file=SERVICE,
         case='W9API-04', expect='only allowed members are read by the resolve',
         old='        for (const m of candidates) if (!allowed.has(m.uid)) m.code = W9_MEMBER_UNAVAILABLE;',
         new='        for (const m of candidates.slice(0, -1)) if (!allowed.has(m.uid)) m.code = W9_MEMBER_UNAVAILABLE;'),
    dict(id='M05-admin', spec=True, title='admin gets an other-institution exception', file=SERVICE,
         case='W9API-03', expect='admin has no institution or tele exception',
         old='          if (!m.state || !this.pacsAccess.visible(m.state, me)) m.code = W9_MEMBER_UNAVAILABLE;\n'
             '          else if (m.state.institutionId !== me ||',
         new="          if (!m.state || !this.pacsAccess.visible(m.state, me) && !c.roles.includes('admin')) m.code = W9_MEMBER_UNAVAILABLE;\n"
             "          else if (m.state.institutionId !== me && !c.roles.includes('admin') ||"),
    dict(id='M05-technician', spec=True, title='a technician is admitted to the viewing set', file=SERVICE,
         case='W9API-02', expect='technician must not resolve a viewing set',
         old=ROLE, new="    if (!c.roles.some(role => ['radiologist', 'admin', 'technician'].includes(role))) throw viewForbidden();\n"),
    dict(id='M06-rows', spec=True, title='the member rows are not re-checked after the source wait', file=SERVICE,
         case='W9API-11', expect='must be re-checked after the source wait',
         old='        if (members.some(m => !sameState(m.state, second.get(m.uid)))) throw contextChanged();',
         new='        if (members.some(m => false && !sameState(m.state, second.get(m.uid)))) throw contextChanged();'),
    dict(id='M06-policy', spec=True, title='the StudyAccess policy is not re-checked after the source wait', file=SERVICE,
         case='W9API-11', expect='policy changed must be re-checked after the source wait',
         old='        try { await within(() => this.studyAccess.unchanged(c, policy), signal); }', new='        try { void policy; }'),
    dict(id='M15', spec=True, title='a failed durable provide is ignored and the body returned', file=SERVICE,
         case='W9API-13', expect='fail: a provision without every receipt must not answer',
         old=PREPARE, new="      try { receipts = await within(() => preparing, signal); } catch (error) { receipts = { accessRefs: new Map(ready.map(m => [m.uid, 'unrecorded:' + m.uid])) }; } if (false) {"),
    dict(id='M17', spec=True, title='one composition-wide record instead of one per provided member', file=SERVICE,
         case='W9API-12', expect='every provided member must have its own target, and only those',
         old='        targets: ready.map(m => ({', new='        targets: ready.slice(0, 1).map(m => ({'),
    dict(id='X01-split-skipped', title='the one-resource rule is skipped: a split UID becomes ready', file=SERVICE,
         case='W9API-08', expect='a UID two patient resources answer must not be ready',
         old='        else if (unresolvedSource(m.rows)) m.code = STUDY_IDENTITY_UNRESOLVED;',
         new='        else if (false) m.code = STUDY_IDENTITY_UNRESOLVED;'),
    dict(id='X02-split-before-scope', title='every source is read and judged before the scope refusals (existence oracle)', file=SERVICE,
         case='W9API-08', expect='a split the caller may not see must answer its scope refusal',
         old='      const admitted = members.filter(m => !m.code);', new='      const admitted = members;'),
    dict(id='X03-lazy-row', title='an unregistered study gets a lazy StudyState row', file=SERVICE,
         case='W9API-15', expect='a resolve writes nothing and registers no StudyState',
         old=MEMBER_LOOP,
         new="        for (const m of members) {\n          m.state = first.get(m.uid) ?? null;\n"
             "          if (!m.state) await this.prisma.studyState.create({ data: { uid: m.uid, institutionId: me, ss: 'Unverified' } }).catch(() => undefined);\n"
             "          if (!m.state ||"),
    dict(id='X04-signal-dropped', title='the resolve signal is not passed to the source read', file=SERVICE,
         case='W9API-10', expect='every pending read must observe the sub-cut abort',
         old='        const read = this.orthanc.viewingSetStudy(m.uid, signal).catch(() => null);',
         new='        const read = this.orthanc.viewingSetStudy(m.uid, undefined).catch(() => null);'),
    dict(id='X05-stale-after-abort', title='a source answer that arrives after the deadline is used', file=SERVICE,
         case='W9API-10', expect='the deadline answers without waiting for a late source',
         old='        const rows = await Promise.race([read, expired]);\n        m.rows = signal.aborted ? null : rows;',
         new='        m.rows = await read;'),
    dict(id='X06-body-before-receipt', title='the body is answered before the durable receipt', file=SERVICE,
         case='W9API-13', expect='no body before the durable receipt',
         old=PREPARE,
         new="      receipts = { accessRefs: new Map(ready.map(m => [m.uid, 'pending:' + m.uid])) }; void preparing.catch(() => undefined); if (false) {"),
    dict(id='X07-finish-any-status', title='any finished response is recorded as an ended transfer', file=CONTROLLER,
         case='W9API-16', expect='a refused reply must never be recorded as a finished transfer',
         old="    res.once('finish', () => settle(res.statusCode === 200 ? 'ended' : 'aborted'));",
         new="    res.once('finish', () => settle('ended'));"),
    dict(id='X08-ended-unobserved', title='transfer-ended is recorded without an observed finish', file=SERVICE,
         case='W9API-14', expect='no transfer outcome before the response observed one',
         old='      this.settle(receipts, transfer);', new="      this.settle(receipts, Promise.resolve('ended'));"),
    dict(id='X09-eight-reads', title='more than four concurrent source reads', file=SERVICE,
         case='W9API-09', expect='a fifth read must wait for a free slot',
         old='concurrentReads: 4,', new='concurrentReads: 8,'),
    dict(id='X10-sixty-seconds', title='a resolve deadline other than ten seconds', file=SERVICE,
         case='W9API-10', expect='every pending read must observe the sub-cut abort',
         old='servedReadCutMs: 9000 }', new='servedReadCutMs: 60000 }'),
    dict(id='X10b-deadline-sixty', title='a whole-resolve deadline other than ten seconds', file=SERVICE,
         case='W9API-22', expect='policy snapshot: the deadline answers the resolve',
         old='deadlineMs: 10000,', new='deadlineMs: 60000,'),
    # D1558: the served-read sub-cut and SRW9R2-1 (classification before any timeout answer)
    dict(id='X31-no-sub-cut', title='the served reads run to the whole deadline (no 9 s sub-cut)', file=SERVICE,
         case='W9API-24', expect='the sub-cut answers inside 10 s',
         old='      await this.readSources(admitted, servedCut.signal);', new='      await this.readSources(admitted, signal);'),
    dict(id='X32-classify-after-timeout', title='a cut answers before the read rows are classified (SRW9R2-1)', file=SERVICE,
         case='W9API-24', expect='each member keeps its own cause; only the hung read is a load failure',
         old='      const sourcePolicy = this.studyAccess.needsMetadata(policy);',
         new='      if (servedCut.signal.aborted) return timedOut();\n      const sourcePolicy = this.studyAccess.needsMetadata(policy);'),
    dict(id='X33-timeout-erases-causes', title='a deadline overwrites the causes already found', file=SERVICE,
         case='W9API-24', expect='a deadline keeps the causes already found',
         old='      for (const m of members) if (!m.code) m.code = W9_LOAD_FAILED;', new='      for (const m of members) m.code = W9_LOAD_FAILED;'),
    dict(id='X11-expected-ignored', title="the admitted set's expected key is not compared", file=SERVICE,
         case='W9API-06', expect='an admitted set whose source key changed must not reopen',
         old='(input.expected !== null && ready.length && !keys.has(input.expected))', new='(false)'),
    dict(id='X12-normalised-id', title='the PatientID is trimmed and case-folded into the key', file=SERVICE,
         case='W9API-06', expect='case must not join two source patients',
         old=KEY, new='key: `${m.state!.institutionId}|${patientId.trim().toUpperCase()}`'),
    dict(id='X13-blank-id', title='a whitespace-only PatientID becomes a key', file=SERVICE,
         case='W9API-06', expect='a missing or whitespace-only PatientID is never a key',
         old="if (typeof patientId !== 'string' || !patientId.trim()) m.code = W9_IDENTITY_UNAVAILABLE;",
         new="if (typeof patientId !== 'string' || !patientId) m.code = W9_IDENTITY_UNAVAILABLE;"),
    dict(id='X14-input-before-role', title='the body is judged before the role', file=SERVICE,
         case='W9API-02', expect='the role is decided before the input',
         old=ROLE + '    const me = inst(c);\n    const input = selection(raw);\n',
         new='    const input = selection(raw);\n' + ROLE + '    const me = inst(c);\n'),
    dict(id='X15-tele-state', title='an open tele state without a channel row is admitted', file=SERVICE,
         case='W9API-03', expect='tele waiting without a channel row (last) must be judged on its own',
         old=' || !LOCAL_TELE_STATES.includes(m.state.ts))', new=')'),
    dict(id='X16-re-anchor', title='a failed anchor is silently replaced by the first ready member', file=SERVICE,
         case='W9API-12', expect='no silent re-anchor: each provided member is its own worklist read',
         old='      const anchor = members[0];', new='      const anchor = ready[0];'),
    dict(id='X17-incomplete-receipts', title='an incomplete receipt set is accepted', file=SERVICE,
         case='W9API-13', expect='missing: a provision without every receipt must not answer',
         old="      if (!(refs instanceof Map) || refs.size !== ready.length || new Set(refs.values()).size !== ready.length\n"
             "          || ready.some(m => typeof refs.get(m.uid) !== 'string' || !refs.get(m.uid))) {",
         new='      if (!(refs instanceof Map)) {'),
    dict(id='X18-served-rows-unmatched', title='the served rows are not held to a source-tag policy (SRW9-1)', file=SERVICE,
         case='W9API-19', expect='a row the policy refuses must never be served',
         old='        else if (sourcePolicy && !m.rows.every(row => this.studyAccess.matches(policy, m.uid, row))) m.code = W9_MEMBER_UNAVAILABLE;',
         new='        else if (false) m.code = W9_MEMBER_UNAVAILABLE;'),
    # W9A-01 (round 2): the StudyAccess preparation read and every wait before the answer are under the one resolve deadline.
    dict(id='X19-prep-signal-dropped', title='StudyAccess.allowed does not hand the resolve signal to its preparation read', file=STUDY_ACCESS,
         case='W9API-21', expect='the policy source read is cancelled by the deadline',
         old='      if(!tx)await this.prepare(c,remaining,policy,signal);', new='      if(!tx)await this.prepare(c,remaining,policy);'),
    dict(id='X20-find-ignores-signal', title='the batch identity read ignores the signal (fault: a read that ignores the abort)', file=ORTHANC,
         case='W9API-21', expect='the policy source read is cancelled by the deadline',
         old='      body: body === undefined ? undefined : JSON.stringify(body) }, signal, async (res, read, owned) => {',
         new='      body: body === undefined ? undefined : JSON.stringify(body) }, undefined, async (res, read, owned) => {'),
    dict(id='X21-allowed-unbounded', title='the StudyAccess decision is awaited without the deadline', file=SERVICE,
         case='W9API-22', expect='StudyAccess.allowed snapshot: the deadline answers the resolve',
         old='          ? await within(() => this.studyAccess.allowed(c, candidates.map(m => m.uid), undefined, signal), signal) : new Set<string>();',
         new='          ? await this.studyAccess.allowed(c, candidates.map(m => m.uid), undefined, signal) : new Set<string>();'),
    dict(id='X22-snapshot-unbounded', title='the policy snapshot is awaited without the deadline', file=SERVICE,
         case='W9API-22', expect='policy snapshot: the deadline answers the resolve',
         old='        policy = await within(() => this.studyAccess.snapshot(c), signal);', new='        policy = await this.studyAccess.snapshot(c);'),
    dict(id='X23-states-unbounded', title='the member rows are awaited without the deadline', file=SERVICE,
         case='W9API-22', expect='member rows: the deadline answers the resolve',
         old='        const first = await within(() => this.states(input.studyUids), signal);',
         new='        const first = await this.states(input.studyUids);'),
    dict(id='X24-recheck-unbounded', title='the member-rows re-check is awaited without the deadline', file=SERVICE,
         case='W9API-22', expect='member rows re-check: the deadline answers the resolve',
         old='        const second = await within(() => this.states(input.studyUids), signal);',
         new='        const second = await this.states(input.studyUids);'),
    dict(id='X24b-policy-recheck-unbounded', title='the policy re-check after allowed() is awaited without the deadline', file=SERVICE,
         case='W9API-22', expect='policy re-check: the deadline answers the resolve',
         old='        try { await within(() => this.studyAccess.unchanged(c, policy), signal); }',
         new='        try { await this.studyAccess.unchanged(c, policy); }'),
    dict(id='X24c-receipt-unbounded', title='the durable receipt is awaited without the deadline', file=SERVICE,
         case='W9API-22', expect='access-record receipt: the deadline answers the resolve',
         old='      try { receipts = await within(() => preparing, signal); } catch (error) {',
         new='      try { receipts = await preparing; } catch (error) {'),
    dict(id='X25-late-receipt-unfinished', title='a receipt arriving after the deadline answered 503 is never finished', file=SERVICE,
         case='W9API-22', expect='access-record receipt: the late receipt is finished',
         old="        if (error instanceof ResolveDeadline) void preparing.then(late => this.settle(late, Promise.resolve('aborted')), () => undefined);",
         new='        void ResolveDeadline;'),
    dict(id='X26-one-uid-signal-dropped', title='the one-UID preparation read does not get the signal', file=STUDY_ACCESS,
         case='W9API-22', expect='StudyAccess.prepare source read (one UID): the resolve signal reaches the read and aborts',
         old='this.orthanc.studyIdentityResources(requested[0],signal)', new='this.orthanc.studyIdentityResources(requested[0])'),
    dict(id='X27-timeout-untyped', title='a deadline answers members it never decided as ready', file=SERVICE,
         case='W9API-22', expect='policy snapshot: the deadline answers with the typed timeout result',
         old='      for (const m of members) if (!m.code) m.code = W9_LOAD_FAILED;', new='      void W9_LOAD_FAILED;'),
    # D1550 (3): the order - rights per resource AND, then the policy revision, then the source identity.
    dict(id='X28-rights-or', title='StudyAccess joins the resources of one UID with OR instead of AND', file=STUDY_ACCESS,
         case='W9API-23', expect='a UID with one resource outside the policy is refused by StudyAccess and never read',
         old='list.every(metadata=>accessPolicyMatches(policy,uid,metadata))', new='list.some(metadata=>accessPolicyMatches(policy,uid,metadata))'),
    dict(id='X29-revision-before-rights', title='the policy revision is checked before the rights read instead of after it', file=STUDY_ACCESS,
         case='W9API-23', expect='a policy revision during the rights read refuses before any served read',
         old=REVISION_SPAN, new=REVISION_FIRST),
    dict(id='X30-identity-before-rights', title='the source identity (split) is judged before the per-row rights match', file=SERVICE,
         case='W9API-19', expect='a served resource outside the policy refuses the member before the split answer',
         old='        else if (sourcePolicy && !m.rows.every(row => this.studyAccess.matches(policy, m.uid, row))) m.code = W9_MEMBER_UNAVAILABLE;\n'
             '        else if (unresolvedSource(m.rows)) m.code = STUDY_IDENTITY_UNRESOLVED;',
         new='        else if (unresolvedSource(m.rows)) m.code = STUDY_IDENTITY_UNRESOLVED;\n'
             '        else if (sourcePolicy && !m.rows.every(row => this.studyAccess.matches(policy, m.uid, row))) m.code = W9_MEMBER_UNAVAILABLE;'),
    *R3_MUTANTS,
]
NOT_APPLICABLE = {
    'M16': 'metadata/other-member reference accepted as an image display: the view-observations route is not in W9-API (D1500 D-6, Module A)',
    'X-accessRef-permission': 'accessRef accepted as a permission without the current access check: observation route, Module A',
    'X-observation-replay': 'observation replay appended as a new event: observation route, Module A',
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def tap_cases(text):
    """Top-level `ok`/`not ok` lines and the YAML block that follows each (node --test-reporter=tap)."""
    cases, lines = {}, text.replace('\r\n', '\n').split('\n')
    for index, line in enumerate(lines):
        match = re.match(r'^(not ok|ok) \d+ - (.*?)( # (?:SKIP|TODO).*)?$', line)
        if not match:
            continue
        block = []
        for follow in lines[index + 1:]:
            if follow.startswith('  ...'):
                break
            block.append(follow)
        cases[match.group(2)] = dict(passed=match.group(1) == 'ok', skipped=bool(match.group(3)), block='\n'.join(block))
    return cases


def run(tree, out_dir, pattern=None):
    node = shutil.which('node')
    if not node:
        raise SystemExit('node is not on PATH')
    # A bounded heap per variant run (host rule D1507): a runaway variant fails as a crash (broken), never as a kill.
    command = [node, '--max-old-space-size=3072', '--test', '--test-reporter=tap'] + \
        ([f'--test-name-pattern={pattern}'] if pattern else []) + [str(TEST)]
    env = dict(os.environ, KIN_TEST_API_SRC=str(tree))
    done = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, timeout=600)
    text = done.stdout.decode('utf-8', 'replace') + '\n' + done.stderr.decode('utf-8', 'replace')
    (out_dir / 'tap.txt').write_text(text, encoding='utf-8')
    return done.returncode, text


def fresh_tree(target):
    shutil.copytree(API_SRC, target, ignore=shutil.ignore_patterns('*.tsbuildinfo'))
    return target


def judge(mutant, out):
    folder = out / mutant['id']
    folder.mkdir()
    tree = fresh_tree(folder / 'api-src')
    path = tree / mutant['file']
    original = path.read_bytes().decode('utf-8').replace('\r\n', '\n')
    record = dict(id=mutant['id'], spec=mutant.get('spec', False), title=mutant['title'], file='api/src/' + mutant['file'],
                  case=mutant['case'], expect=mutant['expect'], anchor_count=original.count(mutant['old']))
    try:
        if record['anchor_count'] != 1:
            record['verdict'] = 'broken'
            record['reason'] = f"anchor found {record['anchor_count']} times"
            return record
        variant = original.replace(mutant['old'], mutant['new'])
        path.write_bytes(variant.encode('utf-8'))
        (folder / mutant['file']).write_bytes(variant.encode('utf-8'))
        (folder / 'diff.txt').write_text(''.join(difflib.unified_diff(original.splitlines(True), variant.splitlines(True),
                                                                       'a/api/src/' + mutant['file'], 'b/api/src/' + mutant['file'])),
                                         encoding='utf-8')
        record['variant_sha256'] = sha256(variant.encode('utf-8'))
        code, text = run(tree, folder, '^' + re.escape(mutant['case']) + ' ')
        record['exit'] = code
        case = next((value for name, value in tap_cases(text).items() if name.startswith(mutant['case'] + ' ')), None)
        if case is None:
            record['verdict'], record['reason'] = 'broken', 'the named case is not in the run (load error?)'
        elif case['passed']:
            record['verdict'] = 'survived'
        elif code != 0 and "code: 'ERR_ASSERTION'" in case['block'] and mutant['expect'] in case['block']:
            record['verdict'] = 'killed'
        else:
            record['verdict'] = 'broken'
            record['reason'] = 'the case failed, but not on an assertion carrying the expected message'
        return record
    finally:
        shutil.rmtree(tree, ignore_errors=True)
        (folder / 'record.json').write_text(json.dumps(record, indent=1, sort_keys=True, ensure_ascii=False) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--only', nargs='*')
    args = parser.parse_args()
    # Absolute: the copies reach node through KIN_TEST_API_SRC, which the loader joins as a path, not a module name.
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    chosen = [m for m in MUTANTS if not args.only or m['id'] in args.only]
    if args.only and len(chosen) != len(set(args.only)):
        raise SystemExit('unknown mutant id in --only')
    ids = [m['id'] for m in MUTANTS]
    if len(ids) != len(set(ids)):
        raise SystemExit('duplicate mutant id')
    baseline_dir = out / 'baseline'
    baseline_dir.mkdir()
    tree = fresh_tree(baseline_dir / 'api-src')
    try:
        code, text = run(tree, baseline_dir)
    finally:
        shutil.rmtree(tree, ignore_errors=True)
    cases = tap_cases(text)
    baseline = dict(exit=code, cases=sorted(cases), failed=sorted(name for name, case in cases.items() if not case['passed']))
    baseline['passed'] = code == 0 and bool(cases) and not baseline['failed']
    for mutant in chosen:
        if not any(name.startswith(mutant['case'] + ' ') for name in cases):
            baseline['passed'] = False
            baseline.setdefault('missing_cases', []).append(mutant['case'])
    results = [judge(mutant, out) for mutant in chosen] if baseline['passed'] else []
    summary = dict(test='tests/multi_study_view_service_test.cjs', test_sha256=sha256(TEST.read_bytes()), baseline=baseline,
                   mutants=[{key: r.get(key) for key in ('id', 'spec', 'title', 'file', 'case', 'expect', 'verdict', 'exit', 'reason',
                                                         'variant_sha256')} for r in results],
                   killed=sum(r['verdict'] == 'killed' for r in results), declared=len(chosen), not_applicable=NOT_APPLICABLE)
    summary['ok'] = baseline['passed'] and len(results) == len(chosen) and summary['killed'] == len(chosen)
    (out / 'summary.json').write_text(json.dumps(summary, indent=1, sort_keys=True, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=1, sort_keys=True, ensure_ascii=False))
    return 0 if summary['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
