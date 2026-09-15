#!/usr/bin/env python3
"""A11-VOI-2 semantic mutation harness. Harness branch only; never merged into product.

  prepare  local, once: build each registered patch from its exact anchor and fill the hash fields of registry.json
  plan     check registry, patches, workflow matrix, original step commands and (--scope) the harness-only diff
  restore  hosted: check out the exact candidate commit and prove its tree, workflow blob and clean status
  install  hosted: apply the one declared patch and prove the mutant bytes and that no other tracked file differs
  verify   hosted, after the original steps: prove the tracked tree is still the candidate plus that one patch

A failed check exits 3 with "GUARD FAILED"; that is a setup failure, never mutation detection. The original tests and
their raw exits are recorded by the product's scripts/record-run.py in the workflow, not here.
"""
import argparse
import datetime
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS_DIR = 'mutation-harness/a11-batch'
WORKFLOW = '.github/workflows/validate.yml'
MATRIX = re.compile(r'^ +id: \[([^\]\n]*)\] # tier ([a-z0-9-]+)$', re.M)
GITHUB = ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
          'RUNNER_NAME', 'RUNNER_ENVIRONMENT', 'ImageVersion')


class GuardFailure(Exception):
    pass


def git(*args, cwd=None, env=None, codes=(0,)):
    done = subprocess.run(['git', '-c', 'core.autocrlf=false', *args], cwd=cwd, env=env, capture_output=True)
    if done.returncode not in codes:
        raise GuardFailure('git %s exited %d: %s' % (' '.join(args), done.returncode,
                                                     done.stderr.decode('utf-8', 'replace').strip()))
    return done


def out(*args):
    return git(*args).stdout.decode('utf-8').rstrip('\n')


def blob(rev, path):
    return git('cat-file', 'blob', '%s:%s' % (rev, path)).stdout


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def blob_id(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class Record:
    """One JSON evidence file per guard step, written even when a check fails."""

    def __init__(self, kind, variant):
        self.data = {'kind': kind, 'variant': variant, 'started_utc': now(), 'ended_utc': None, 'result': 'running',
                     'github': {k: os.environ.get(k) for k in GITHUB}, 'checks': []}

    def check(self, name, expected, actual):
        ok = expected == actual
        self.data['checks'].append({'name': name, 'ok': ok, 'expected': expected, 'actual': actual})
        if not ok:
            raise GuardFailure('%s: expected %r, actual %r' % (name, expected, actual))

    def run(self, work, path=None):
        try:
            work()
            self.data['result'] = 'passed'
        except BaseException as error:
            self.data.update(result='failed', error='%s: %s' % (type(error).__name__, error))
            raise
        finally:
            self.data['ended_utc'] = now()
            text = json.dumps(self.data, ensure_ascii=False, indent=1) + '\n'
            if path is None:
                sys.stdout.write(text)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(text.encode('utf-8'))


def registry():
    return json.loads((HERE / 'registry.json').read_text(encoding='utf-8'))


def find(reg, vid, tier):
    found = [v for v in reg['variants'] if v['id'] == vid]
    if len(found) != 1:
        raise GuardFailure('variant %s is registered %d times' % (vid, len(found)))
    if found[0]['tier'] != tier:
        raise GuardFailure('variant %s is registered for tier %s, not %s' % (vid, found[0]['tier'], tier))
    return found[0]


def mutate(before, v):
    anchor = v['anchor'].encode('utf-8')
    return before.count(anchor), before.replace(anchor, v['replacement'].encode('utf-8'), 1)


def anchor_line(before, v):
    return before[:before.index(v['anchor'].encode('utf-8'))].count(b'\n') + 1


def lines(data):
    parts = data.decode('utf-8').split('\n')
    return [p + '\n' for p in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def build_patch(path, before, after):
    body = list(difflib.unified_diff(lines(before), lines(after), 'a/' + path, 'b/' + path, n=3))
    if not body or any(not line.endswith('\n') for line in body):
        raise GuardFailure('%s: empty change or a hunk touching a last line without newline' % path)
    head = 'diff --git a/%s b/%s\nindex %s..%s 100644\n' % (path, path, blob_id(before), blob_id(after))
    return (head + ''.join(body)).encode('utf-8')


def patch_result(path, before, patch):
    """The bytes git apply produces from the candidate file in a scratch directory outside every repository."""
    with tempfile.TemporaryDirectory() as root:
        target = Path(root, path)
        target.parent.mkdir(parents=True)
        target.write_bytes(before)
        Path(root, 'variant.patch').write_bytes(patch)
        git('apply', 'variant.patch', cwd=root, env=dict(os.environ, GIT_CEILING_DIRECTORIES=str(Path(root).parent)))
        return target.read_bytes()


def check_variant(rec, reg, v):
    vid, patch = v['id'], (HERE / v['patch']).read_bytes()
    before = blob(reg['candidate']['sha'], v['source'])
    count, after = mutate(before, v)
    rec.check(vid + ' candidate blob', v['candidate_blob'], blob_id(before))
    rec.check(vid + ' candidate sha256', v['candidate_sha256'], sha256(before))
    rec.check(vid + ' anchor count in candidate', 1, count)
    rec.check(vid + ' anchor line', v['line'], anchor_line(before, v))
    rec.check(vid + ' mutant sha256', v['mutant_sha256'], sha256(after))
    rec.check(vid + ' mutant blob', v['mutant_blob'], blob_id(after))
    rec.check(vid + ' patch sha256', v['patch_sha256'], sha256(patch))
    rec.check(vid + ' git apply result equals the single anchor replacement', v['mutant_sha256'],
              sha256(patch_result(v['source'], before, patch)))


def check_scope(rec, reg):
    cand = reg['candidate']['sha']
    rec.check('candidate is an ancestor of the harness commit', 0,
              git('merge-base', '--is-ancestor', cand, 'HEAD', codes=(0, 1)).returncode)
    changed = out('diff', '--name-only', '--no-renames', cand, 'HEAD').splitlines()
    rec.check('harness commit changes only harness paths', [],
              [p for p in changed if p != WORKFLOW and not p.startswith(HARNESS_DIR + '/')])
    rec.data['harness_changed_paths'] = changed


def hosted(rec, reg):
    rec.check('GitHub Actions', 'true', os.environ.get('GITHUB_ACTIONS'))
    rec.check('GitHub-hosted runner', 'github-hosted', os.environ.get('RUNNER_ENVIRONMENT'))
    rec.check('dispatched by hand', 'workflow_dispatch', os.environ.get('GITHUB_EVENT_NAME'))
    rec.check('harness branch', reg['harness_ref'], os.environ.get('GITHUB_REF'))
    rec.check('first attempt only, no retry', '1', os.environ.get('GITHUB_RUN_ATTEMPT'))
    rec.check('commands run from the product checkout root', str(Path.cwd()), str(Path(out('rev-parse', '--show-toplevel'))))


def untracked():
    rows = [r[3:] for r in out('status', '--porcelain=v1', '--untracked-files=normal').splitlines() if r.startswith('?? ')]
    return {'count': len(rows), 'first': rows[:20]}


def result_of(path):
    try:
        return json.loads(path.read_text(encoding='utf-8')).get('result')
    except (OSError, ValueError):
        return None


def prepare(args):
    rec = Record('prepare', None)

    def work():
        rec.check('prepare runs locally, never in Actions', None, os.environ.get('GITHUB_ACTIONS'))
        reg = registry()
        cand = reg['candidate']
        rec.check('candidate tree', cand['tree'], out('rev-parse', cand['sha'] + '^{tree}'))
        rec.check('candidate workflow blob', cand['workflow_blob'], out('rev-parse', cand['sha'] + ':' + WORKFLOW))
        for v in reg['variants']:
            before = blob(cand['sha'], v['source'])
            count, after = mutate(before, v)
            rec.check(v['id'] + ' anchor count in candidate', 1, count)
            patch = build_patch(v['source'], before, after)
            v.update(line=anchor_line(before, v), anchor_count=count,
                     replacement_count_in_candidate=before.count(v['replacement'].encode('utf-8')) if v['replacement'] else None,
                     candidate_blob=blob_id(before), candidate_sha256=sha256(before),
                     mutant_blob=blob_id(after), mutant_sha256=sha256(after),
                     patch='patches/%s.patch' % v['id'], patch_sha256=sha256(patch))
            (HERE / 'patches').mkdir(exist_ok=True)
            (HERE / v['patch']).write_bytes(patch)
            rec.check(v['id'] + ' git apply result equals the single anchor replacement', sha256(after),
                      sha256(patch_result(v['source'], before, patch)))
        (HERE / 'registry.json').write_bytes((json.dumps(reg, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))

    rec.run(work)


def plan(args):
    rec = Record('plan', None)

    def work():
        reg = registry()
        cand = reg['candidate']
        rec.check('candidate tree', cand['tree'], out('rev-parse', cand['sha'] + '^{tree}'))
        rec.check('candidate workflow blob', cand['workflow_blob'], out('rev-parse', cand['sha'] + ':' + WORKFLOW))
        ids = [v['id'] for v in reg['variants']]
        rec.check('variant ids are unique', sorted(set(ids)), sorted(ids))
        for v in reg['variants']:
            check_variant(rec, reg, v)
        root = Path(out('rev-parse', '--show-toplevel'))
        workflow = (root / WORKFLOW).read_text(encoding='utf-8')
        original = blob(cand['sha'], WORKFLOW).decode('utf-8')
        found = MATRIX.findall(workflow)
        rec.check('every matrix line is tier-tagged', workflow.count('id: ['), len(found))
        rec.check('the matrices run each registered variant exactly once in its tier',
                  sorted([v['id'], v['tier']] for v in reg['variants'] if v['tier'] != 'pure-local'),
                  sorted([i.strip(), tier] for listed, tier in found for i in listed.split(',')))
        for group, steps in reg['workflow_lines'].items():
            for step in steps:
                rec.check('%s %s: harness line present' % (group, step['role']), True, step['harness'] in workflow)
                rec.check('%s %s: original candidate line present' % (group, step['role']), True, step['original'] in original)
        if args.scope:
            check_scope(rec, reg)

    rec.run(work)


def evidence_dir(args, vid):
    return Path(args.evidence) if args.evidence else Path(os.environ['RUNNER_TEMP'], 'mutant-evidence', vid)


def restore(args):
    reg = registry()
    v = find(reg, args.variant, args.tier)
    rec, evidence = Record('restore', v['id']), evidence_dir(args, v['id'])

    def work():
        hosted(rec, reg)
        root = Path.cwd()
        rec.check('staged harness is outside the product tree', False, HERE.is_relative_to(root))
        head = out('rev-parse', 'HEAD')
        rec.check('harness HEAD is the dispatched commit', os.environ.get('GITHUB_SHA'), head)
        rec.data['harness_sha'] = head
        for name in out('ls-tree', '-r', '--name-only', 'HEAD', HARNESS_DIR).splitlines():
            staged = HERE / Path(name).relative_to(HARNESS_DIR)
            rec.check('staged ' + name, sha256(blob('HEAD', name)), sha256(staged.read_bytes()))
        check_scope(rec, reg)
        check_variant(rec, reg, v)
        rec.check('fresh hosted checkout is clean', '', out('status', '--porcelain=v1', '--untracked-files=all', '--ignored'))
        git('checkout', '--quiet', '--detach', reg['candidate']['sha'])
        rec.check('HEAD is the candidate', reg['candidate']['sha'], out('rev-parse', 'HEAD'))
        rec.check('candidate tree', reg['candidate']['tree'], out('rev-parse', 'HEAD^{tree}'))
        rec.check('candidate workflow blob in HEAD', reg['candidate']['workflow_blob'], out('rev-parse', 'HEAD:' + WORKFLOW))
        rec.check('candidate workflow file on disk', reg['candidate']['workflow_blob'], blob_id((root / WORKFLOW).read_bytes()))
        rec.check('no tracked, untracked or ignored difference', '',
                  out('status', '--porcelain=v1', '--untracked-files=all', '--ignored'))
        rec.check('declared source on disk is the candidate', v['candidate_sha256'], sha256((root / v['source']).read_bytes()))

    rec.run(work, evidence / 'restore.json')


def install(args):
    reg = registry()
    v = find(reg, args.variant, args.tier)
    rec, evidence = Record('install', v['id']), evidence_dir(args, v['id'])

    def work():
        hosted(rec, reg)
        rec.check('restore passed', 'passed', result_of(evidence / 'restore.json'))
        rec.check('HEAD is the candidate', reg['candidate']['sha'], out('rev-parse', 'HEAD'))
        rec.check('no tracked difference before the patch', '', out('status', '--porcelain=v1', '--untracked-files=no'))
        rec.data['untracked_before_patch'] = untracked()
        patch = HERE / v['patch']
        rec.check('patch sha256', v['patch_sha256'], sha256(patch.read_bytes()))
        git('apply', '--check', str(patch))
        git('apply', str(patch))
        mutant = (Path.cwd() / v['source']).read_bytes()
        rec.check('installed mutant sha256', v['mutant_sha256'], sha256(mutant))
        rec.check('installed mutant blob', v['mutant_blob'], blob_id(mutant))
        rec.check('only the declared source differs from the candidate', [v['source']], out('diff', '--name-only', 'HEAD').splitlines())
        rec.check('tracked status is that one modified source', ' M ' + v['source'],
                  out('status', '--porcelain=v1', '--untracked-files=no'))

    rec.run(work, evidence / 'install.json')


def verify(args):
    reg = registry()
    v = find(reg, args.variant, args.tier)
    rec, evidence = Record('verify', v['id']), evidence_dir(args, v['id'])

    def work():
        hosted(rec, reg)
        installed = result_of(evidence / 'install.json')
        rec.data['install_result'] = installed
        rec.check('restore passed', 'passed', result_of(evidence / 'restore.json'))
        rec.check('HEAD is still the candidate', reg['candidate']['sha'], out('rev-parse', 'HEAD'))
        rec.check('tracked difference is exactly the installed source', [v['source']] if installed == 'passed' else [],
                  out('diff', '--name-only', 'HEAD').splitlines())
        if installed == 'passed':
            rec.check('source still holds the installed mutant', v['mutant_sha256'], sha256((Path.cwd() / v['source']).read_bytes()))
        rec.data['untracked_after_run'] = untracked()

    try:
        rec.run(work, evidence / 'verify.json')
    finally:
        if evidence.is_dir():
            shutil.copytree(evidence, Path.cwd() / 'tmp' / 'mutant-evidence' / v['id'], dirs_exist_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('prepare')
    sub.add_parser('plan').add_argument('--scope', action='store_true', help='also check the committed harness-only diff')
    for name in ('restore', 'install', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('--tier', required=True)
        p.add_argument('--variant', required=True)
        p.add_argument('--evidence', help='default $RUNNER_TEMP/mutant-evidence/<variant>')
    args = parser.parse_args(argv)
    try:
        {'prepare': prepare, 'plan': plan, 'restore': restore, 'install': install, 'verify': verify}[args.command](args)
    except Exception as error:
        print('GUARD FAILED (%s): %s: %s' % (args.command, type(error).__name__, error), file=sys.stderr)
        return 3
    print('%s passed' % args.command, file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
