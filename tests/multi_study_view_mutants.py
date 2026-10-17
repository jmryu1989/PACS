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
MEMBER_LOOP = '      for (const m of members) {\n        if (!m.state ||'
KEY = 'key: `${m.state!.institutionId}|${patientId}`'
PREPARE = '      try { receipts = await this.access.prepare(provision); } catch { throw auditUnavailable(); }'

MUTANTS = [
    dict(id='M01', spec=True, title='the same patient judged by the source name instead of the PatientID', file=SERVICE,
         case='W9API-06', expect='two normal studies with one PatientID must open as one set',
         old=KEY, new="key: `${m.state!.institutionId}|${OrthancService.tag(m.rows[0], '00100010')}`"),
    dict(id='M04-scope', spec=True, title='the last member skips the visibility, own-institution and tele checks', file=SERVICE,
         case='W9API-03', expect='must be judged on its own',
         old=MEMBER_LOOP, new='      for (const m of members.slice(0, -1)) {\n        if (!m.state ||'),
    dict(id='M04-access', spec=True, title='the last member skips the StudyAccess decision', file=SERVICE,
         case='W9API-04', expect='StudyAccess refusal must be applied',
         old='      for (const m of candidates) if (!allowed.has(m.uid)) m.code = W9_MEMBER_UNAVAILABLE;',
         new='      for (const m of candidates.slice(0, -1)) if (!allowed.has(m.uid)) m.code = W9_MEMBER_UNAVAILABLE;'),
    dict(id='M05-admin', spec=True, title='admin gets an other-institution exception', file=SERVICE,
         case='W9API-03', expect='admin has no institution or tele exception',
         old='        if (!m.state || !this.pacsAccess.visible(m.state, me)) m.code = W9_MEMBER_UNAVAILABLE;\n'
             '        else if (m.state.institutionId !== me ||',
         new="        if (!m.state || !this.pacsAccess.visible(m.state, me) && !c.roles.includes('admin')) m.code = W9_MEMBER_UNAVAILABLE;\n"
             "        else if (m.state.institutionId !== me && !c.roles.includes('admin') ||"),
    dict(id='M05-technician', spec=True, title='a technician is admitted to the viewing set', file=SERVICE,
         case='W9API-02', expect='technician must not resolve a viewing set',
         old=ROLE, new="    if (!c.roles.some(role => ['radiologist', 'admin', 'technician'].includes(role))) throw viewForbidden();\n"),
    dict(id='M06-rows', spec=True, title='the member rows are not re-checked after the source wait', file=SERVICE,
         case='W9API-11', expect='must be re-checked after the source wait',
         old='      if (members.some(m => !sameState(m.state, second.get(m.uid)))) throw contextChanged();',
         new='      if (members.some(m => false && !sameState(m.state, second.get(m.uid)))) throw contextChanged();'),
    dict(id='M06-policy', spec=True, title='the StudyAccess policy is not re-checked after the source wait', file=SERVICE,
         case='W9API-11', expect='policy changed must be re-checked after the source wait',
         old='      try { await this.studyAccess.unchanged(c, policy); }', new='      try { void policy; }'),
    dict(id='M15', spec=True, title='a failed durable provide is ignored and the body returned', file=SERVICE,
         case='W9API-13', expect='fail: a provision without every receipt must not answer',
         old=PREPARE, new="      try { receipts = await this.access.prepare(provision); } catch { receipts = { accessRefs: new Map(ready.map(m => [m.uid, 'unrecorded:' + m.uid])) }; }"),
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
         new="      for (const m of members) {\n        if (!m.state) await this.prisma.studyState.create({ data: { uid: m.uid, institutionId: me, ss: 'Unverified' } }).catch(() => undefined);\n        if (!m.state ||"),
    dict(id='X04-signal-dropped', title='the resolve signal is not passed to the source read', file=SERVICE,
         case='W9API-10', expect='every pending read must observe the deadline abort',
         old='        const read = this.orthanc.viewingSetStudy(m.uid, signal).catch(() => null);',
         new='        const read = this.orthanc.viewingSetStudy(m.uid, undefined).catch(() => null);'),
    dict(id='X05-stale-after-abort', title='a source answer that arrives after the deadline is used', file=SERVICE,
         case='W9API-10', expect='a read answered after the deadline must not become metadata',
         old='        const rows = await Promise.race([read, expired]);\n        m.rows = signal.aborted ? null : rows;',
         new='        m.rows = await read;'),
    dict(id='X06-body-before-receipt', title='the body is answered before the durable receipt', file=SERVICE,
         case='W9API-13', expect='no body before the durable receipt',
         old=PREPARE,
         new="      receipts = { accessRefs: new Map(ready.map(m => [m.uid, 'pending:' + m.uid])) }; void this.access.prepare(provision).catch(() => undefined);"),
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
         case='W9API-10', expect='every pending read must observe the deadline abort',
         old='deadlineMs: 10000 }', new='deadlineMs: 60000 }'),
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
        match = re.match(r'^(not ok|ok) \d+ - (.*?)( # SKIP.*)?$', line)
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
    command = [node, '--test', '--test-reporter=tap'] + ([f'--test-name-pattern={pattern}'] if pattern else []) + [str(TEST)]
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
