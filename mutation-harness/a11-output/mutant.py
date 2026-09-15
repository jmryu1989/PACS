#!/usr/bin/env python3
"""A11-OUTPUT-1 semantic mutation harness. Harness branch only; never merged into product.

  prepare  local, once: build each registered patch from its exact anchor and fill the hash fields of registry.json
  syntax   local: parse every mutant JavaScript source with node --check (nothing executed), so no trial fails on syntax
  plan     check the registry, patches and test sources, the native job against the candidate's own volume-mip-output job
           and (--scope) the harness-only diff; --hosted adds the dispatch checks
  export   local pure tier: write the candidate blobs a pure trial reads, byte-exact (no line-ending filter), into a new
           directory outside every repository, apply at most one registered patch there and write a manifest
  recheck  local pure tier, after the recorded trial: prove the exported tree still equals its manifest and the harness
           worktree's product sources are still the candidate's
  restore  hosted: check out the exact candidate commit and prove its tree, workflow blob and clean status
  install  hosted: apply the one declared patch and prove the mutant bytes and that no other tracked file differs
  verify   hosted, after the original steps: prove the tracked tree is still the candidate plus that one patch, and record
           (never judge) the profile phases, the unittest outcome lines and every MIP_OUTPUT_TRANSPORT_FAILURE line

A failed check exits 3 with "GUARD FAILED"; that is a setup failure, never mutation detection. The original tests and
their raw exits are recorded by the product's scripts/record-run.py and tests/measurement_ci.py, not here.
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
HARNESS_DIR = 'mutation-harness/a11-output'
WORKFLOW = '.github/workflows/validate.yml'
TIERS = ('pure-local', 'native-mip-output')
MATRIX = re.compile(r'^ +id: \[([^\]\n]*)\] # tier ([a-z0-9-]+)$', re.M)
PROFILE_LOGS = ('tests/e2e/artifacts/volume-mip-output-ci', 'tmp/mipout-ci')
PROFILE_RESULTS = 'tests/e2e/artifacts/volume-mip-output-ci/results.json'
TRANSPORT = 'MIP_OUTPUT_TRANSPORT_FAILURE'
OUTCOME = re.compile(r'^(test_mip_output_\w+ \(.*\) \.\.\. .*|(FAIL|ERROR): .*|Ran \d+ tests? in .*|OK( \(.*\))?|FAILED \(.*\))$')
GIT_OVERRIDES = ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY')
GITHUB = ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
          'RUNNER_NAME', 'RUNNER_ENVIRONMENT', 'ImageVersion')


class GuardFailure(Exception):
    pass


def git(*args, cwd=None, env=None, codes=(0,), data=None):
    done = subprocess.run(['git', '-c', 'core.autocrlf=false', *args], cwd=cwd, env=env, input=data, capture_output=True)
    if done.returncode not in codes:
        raise GuardFailure('git %s exited %d: %s' % (' '.join(args), done.returncode,
                                                     done.stderr.decode('utf-8', 'replace').strip()))
    return done


def out(*args, cwd=None):
    return git(*args, cwd=cwd).stdout.decode('utf-8').rstrip('\n')


def blob(rev, path):
    return git('cat-file', 'blob', '%s:%s' % (rev, path)).stdout


def blobs(oids):
    """Raw stored bytes of each object id, in order (cat-file --batch applies no line-ending or clean filter)."""
    stream = git('cat-file', '--batch', data=''.join(oid + '\n' for oid in oids).encode('ascii')).stdout
    result, at = [], 0
    for oid in oids:
        end = stream.index(b'\n', at)
        name, kind, size = stream[at:end].decode('ascii').split(' ')
        if name != oid or kind != 'blob':
            raise GuardFailure('cat-file answered %s %s for %s' % (name, kind, oid))
        start = end + 1
        result.append(stream[start:start + int(size)])
        at = start + int(size) + 1
    return result


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
                sys.stdout.buffer.write(text.encode('utf-8'))
                sys.stdout.flush()
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


def outside_env(root):
    return dict(os.environ, GIT_CEILING_DIRECTORIES=str(Path(root).resolve().parent))


def patch_result(path, before, patch):
    """The bytes git apply produces from the candidate file in a scratch directory outside every repository."""
    with tempfile.TemporaryDirectory() as root:
        target = Path(root, path)
        target.parent.mkdir(parents=True)
        target.write_bytes(before)
        Path(root, 'variant.patch').write_bytes(patch)
        git('apply', 'variant.patch', cwd=root, env=outside_env(root))
        return target.read_bytes()


def check_variant(rec, reg, v):
    vid, patch = v['id'], (HERE / v['patch']).read_bytes()
    before = blob(reg['candidate']['sha'], v['source'])
    count, after = mutate(before, v)
    rec.check(vid + ' names the registered candidate', reg['candidate']['sha'], v['candidate_sha'])
    rec.check(vid + ' candidate blob', v['candidate_blob'], blob_id(before))
    rec.check(vid + ' candidate sha256', v['candidate_sha256'], sha256(before))
    rec.check(vid + ' anchor count in candidate', 1, count)
    rec.check(vid + ' anchor line', v['line'], anchor_line(before, v))
    rec.check(vid + ' mutant sha256', v['mutant_sha256'], sha256(after))
    rec.check(vid + ' mutant blob', v['mutant_blob'], blob_id(after))
    rec.check(vid + ' patch sha256', v['patch_sha256'], sha256(patch))
    rec.check(vid + ' git apply result equals the single anchor replacement', v['mutant_sha256'],
              sha256(patch_result(v['source'], before, patch)))


def test_hashes(reg, v):
    return {path: {'blob': blob_id(data), 'sha256': sha256(data)}
            for path in v['test_sources'] for data in [blob(reg['candidate']['sha'], path)]}


def check_tests(rec, reg, v):
    rec.check(v['id'] + ' test sources are the candidate blobs', v['test_source_hashes'], test_hashes(reg, v))


def export_listing(reg):
    rows = git('ls-tree', '-r', '-z', '--full-tree', reg['candidate']['sha'], '--', *reg['pure_export']['paths']).stdout
    entries = []
    for row in rows.split(b'\0'):
        if not row:
            continue
        meta, path = row.split(b'\t', 1)
        mode, kind, oid = meta.decode('ascii').split(' ')
        if kind != 'blob' or mode != '100644':
            raise GuardFailure('pure export holds a non-regular entry %s %s %r' % (mode, kind, path))
        entries.append((path.decode('utf-8'), oid))
    return entries


def listing_digest(entries):
    return sha256(''.join('%s %s\n' % (oid, path) for path, oid in entries).encode('utf-8'))


# The native job is compared step by step with the candidate's own volume-mip-output job (text, not YAML semantics).
def job_blocks(text):
    rows = text.split('\n')
    blocks, name = {}, None
    for line in rows[rows.index('jobs:') + 1:]:
        match = re.match(r'^  ([A-Za-z0-9_-]+):$', line)
        if match:
            name = match.group(1)
            blocks[name] = []
        elif name is not None:
            blocks[name].append(line)
    return blocks


def split_job(block):
    header, steps = [], []
    for line in block:
        if line.startswith('      - '):
            steps.append([line])
        elif steps:
            steps[-1].append(line)
        elif line.strip() and not line.strip().startswith('#'):
            header.append(line)
    return header, ['\n'.join(step).rstrip() for step in steps]


def step_name(step):
    match = re.search(r'^      (?:- |  )name: (.*)$', step, re.M)
    return match.group(1) if match else None


def check_workflow(rec, reg, text, original):
    rec.check('harness workflow has no automatic trigger', [],
              re.findall(r'^  (push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch|merge_group):', text, re.M))
    rec.check('harness workflow is dispatched by hand', True, '\non:\n  workflow_dispatch:\n' in text)
    rec.check('no continue-on-error anywhere in the harness workflow', 0, text.count('continue-on-error'))
    found = MATRIX.findall(text)
    rec.check('every matrix line is tier-tagged', text.count('id: ['), len(found))
    rec.check('the matrix runs each registered native variant exactly once in its tier',
              sorted([v['id'], v['tier']] for v in reg['variants'] if v['tier'] != 'pure-local'),
              sorted([i.strip(), tier] for listed, tier in found for i in listed.split(',')))
    job = reg['native_job']
    ours, theirs = job_blocks(text), job_blocks(original)
    rec.check('harness jobs', sorted(job['harness_jobs']), sorted(ours))
    o_header, o_steps = split_job(theirs[job['original']])
    h_header, h_steps = split_job(ours[job['harness']])
    rec.check('the original job runner and job timeout are kept', [line for line in o_header if line.strip() != 'steps:'],
              [line for line in h_header if line.strip().split(':')[0] in ('runs-on', 'timeout-minutes')])
    rec.check('harness step order', job['harness_step_names'], [step_name(step) for step in h_steps])
    kept = [step for step in h_steps if not (step_name(step) or '').startswith('Harness - ')]
    rec.check('every original step is kept, in order', len(o_steps), len(kept))
    applied = []
    for index, (theirs_step, ours_step) in enumerate(zip(o_steps, kept)):
        want = theirs_step
        for old, new in job['allowed_step_changes']:
            if old in want:
                want = want.replace(old, new, 1)
                applied.append(old)
        rec.check('original step %d (%s) is kept verbatim except the registered harness changes' % (index, step_name(theirs_step)), want, ours_step)
    rec.check('each registered harness change applies exactly once', sorted(old for old, _ in job['allowed_step_changes']), sorted(applied))
    harness_steps = [step for step in h_steps if (step_name(step) or '').startswith('Harness - ')]
    rec.check('harness steps add no timeout', [], [step_name(s) for s in harness_steps if 'timeout-minutes' in s])
    rec.check('only the post-trial guard of the harness steps always runs', job['always_harness_steps'],
              [step_name(s) for s in harness_steps if 'if: always()' in s])


def check_scope(rec, reg):
    cand = reg['candidate']['sha']
    rec.check('candidate is an ancestor of the harness commit', 0,
              git('merge-base', '--is-ancestor', cand, 'HEAD', codes=(0, 1)).returncode)
    changed = out('diff', '--name-only', '--no-renames', cand, 'HEAD').splitlines()
    rec.check('harness commit changes only harness paths', [],
              [p for p in changed if p != WORKFLOW and not p.startswith(HARNESS_DIR + '/')])
    rec.data['harness_sha'] = out('rev-parse', 'HEAD')
    rec.data['harness_changed_paths'] = changed


def check_staged(rec):
    names = out('ls-tree', '-r', '--name-only', 'HEAD', HARNESS_DIR).splitlines()
    for name in names:
        rec.check('harness file %s equals its HEAD blob' % name, sha256(blob('HEAD', name)),
                  sha256((HERE / Path(name).relative_to(HARNESS_DIR)).read_bytes()))
    present = sorted(p.relative_to(HERE).as_posix() for p in HERE.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    rec.check('no harness file outside HEAD', sorted(Path(n).relative_to(HARNESS_DIR).as_posix() for n in names), present)


def hosted(rec, reg):
    rec.check('GitHub Actions', 'true', os.environ.get('GITHUB_ACTIONS'))
    rec.check('GitHub-hosted runner', 'github-hosted', os.environ.get('RUNNER_ENVIRONMENT'))
    rec.check('dispatched by hand', 'workflow_dispatch', os.environ.get('GITHUB_EVENT_NAME'))
    rec.check('harness branch', reg['harness_ref'], os.environ.get('GITHUB_REF'))
    rec.check('first attempt only, no retry', '1', os.environ.get('GITHUB_RUN_ATTEMPT'))
    rec.check('dispatch input harness_sha is the dispatched commit', os.environ.get('GITHUB_SHA'), os.environ.get('EXPECTED_HARNESS_SHA'))
    rec.check('dispatch input candidate_sha is the registered candidate', reg['candidate']['sha'], os.environ.get('EXPECTED_CANDIDATE_SHA'))
    rec.check('commands run from the product checkout root', str(Path.cwd()), str(Path(out('rev-parse', '--show-toplevel'))))


def local_only(rec, kind):
    rec.check(kind + ' runs locally, never in Actions', None, os.environ.get('GITHUB_ACTIONS'))
    for name in GIT_OVERRIDES:
        rec.check('no %s override' % name, None, os.environ.get(name))


def product_unchanged(rec, reg, label):
    """The harness worktree's own product files still equal the candidate (only the harness paths differ)."""
    differing = [p for p in out('diff', '--name-only', '--no-renames', reg['candidate']['sha']).splitlines()
                 if p != WORKFLOW and not p.startswith(HARNESS_DIR + '/')]
    rec.check(label + ': harness worktree product files equal the candidate', [], differing)


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
        local_only(rec, 'prepare')
        reg = registry()
        cand = reg['candidate']
        rec.check('candidate tree', cand['tree'], out('rev-parse', cand['sha'] + '^{tree}'))
        rec.check('candidate workflow blob', cand['workflow_blob'], out('rev-parse', cand['sha'] + ':' + WORKFLOW))
        ids = [v['id'] for v in reg['variants']]
        rec.check('registered variant ids, once each and in contract order', reg['expected_ids'], ids)
        entries = export_listing(reg)
        reg['pure_export'].update(files=len(entries), listing_sha256=listing_digest(entries))
        listed = {path for path, _ in entries}
        (HERE / 'patches').mkdir(exist_ok=True)
        for v in reg['variants']:
            rec.check(v['id'] + ' tier', True, v['tier'] in TIERS)
            before = blob(cand['sha'], v['source'])
            count, after = mutate(before, v)
            rec.check(v['id'] + ' anchor count in candidate', 1, count)
            patch = build_patch(v['source'], before, after)
            v.update(candidate_sha=cand['sha'], line=anchor_line(before, v), anchor_count=count,
                     replacement_count_in_candidate=before.count(v['replacement'].encode('utf-8')) if v['replacement'] else None,
                     candidate_blob=blob_id(before), candidate_sha256=sha256(before),
                     mutant_blob=blob_id(after), mutant_sha256=sha256(after),
                     patch='patches/%s.patch' % v['id'], patch_sha256=sha256(patch), test_source_hashes=test_hashes(reg, v))
            if v['tier'] == 'pure-local':
                rec.check(v['id'] + ' pure inputs are all exported', [], [p for p in [v['source'], *v['test_sources'], *v['recorder_files']] if p not in listed])
            (HERE / v['patch']).write_bytes(patch)
            rec.check(v['id'] + ' git apply result equals the single anchor replacement', sha256(after),
                      sha256(patch_result(v['source'], before, patch)))
        (HERE / 'registry.json').write_bytes((json.dumps(reg, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))

    rec.run(work)


def syntax(args):
    rec = Record('syntax', None)

    def work():
        local_only(rec, 'syntax')
        reg = registry()
        rec.data['node'] = subprocess.run(['node', '--version'], capture_output=True).stdout.decode('ascii').strip()
        parsed = rec.data['parsed'] = {}
        with tempfile.TemporaryDirectory() as root:
            for v in reg['variants']:
                check_variant(rec, reg, v)
                rec.check(v['id'] + ' source is JavaScript', True, v['source'].endswith('.js'))
                before = blob(reg['candidate']['sha'], v['source'])
                for label, data in (('candidate', before), ('mutant', mutate(before, v)[1])):
                    target = Path(root, v['id'], label, Path(v['source']).name)
                    target.parent.mkdir(parents=True)
                    target.write_bytes(data)
                    done = subprocess.run(['node', '--check', str(target)], capture_output=True)
                    parsed['%s %s' % (v['id'], label)] = {'exit': done.returncode, 'stderr': done.stderr.decode('utf-8', 'replace')}
                    rec.check('%s %s parses (node --check, nothing executed)' % (v['id'], label), 0, done.returncode)

    rec.run(work)


def plan(args):
    rec = Record('plan', None)

    def work():
        reg = registry()
        cand = reg['candidate']
        if args.hosted:
            hosted(rec, reg)
        rec.check('candidate tree', cand['tree'], out('rev-parse', cand['sha'] + '^{tree}'))
        rec.check('candidate workflow blob', cand['workflow_blob'], out('rev-parse', cand['sha'] + ':' + WORKFLOW))
        rec.check('registered variant ids, once each and in contract order', reg['expected_ids'], [v['id'] for v in reg['variants']])
        for v in reg['variants']:
            rec.check(v['id'] + ' tier', True, v['tier'] in TIERS)
            check_variant(rec, reg, v)
            check_tests(rec, reg, v)
        entries = export_listing(reg)
        rec.check('pure export listing', [reg['pure_export']['files'], reg['pure_export']['listing_sha256']], [len(entries), listing_digest(entries)])
        check_workflow(rec, reg, blob('HEAD', WORKFLOW).decode('utf-8'), blob(cand['sha'], WORKFLOW).decode('utf-8'))
        if args.scope:
            check_scope(rec, reg)
            check_staged(rec)

    rec.run(work)


def export(args):
    rec = Record('export', args.variant or 'control')

    def work():
        local_only(rec, 'export')
        reg = registry()
        cand = reg['candidate']
        rec.check('candidate tree', cand['tree'], out('rev-parse', cand['sha'] + '^{tree}'))
        product_unchanged(rec, reg, 'before export')
        v = find(reg, args.variant, 'pure-local') if args.variant else None
        if v:
            check_variant(rec, reg, v)
            check_tests(rec, reg, v)
        dest, manifest = Path(args.dest).resolve(), Path(args.manifest).resolve()
        rec.check('export directory is new', False, dest.exists())
        rec.check('export parent exists', True, dest.parent.is_dir())
        rec.check('manifest is new and outside the export', [False, False], [manifest.exists(), manifest.is_relative_to(dest)])
        probe = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=dest.parent, capture_output=True)
        rec.check('export parent is outside every git repository', True, probe.returncode != 0)
        entries = export_listing(reg)
        rec.check('pure export listing', [reg['pure_export']['files'], reg['pure_export']['listing_sha256']], [len(entries), listing_digest(entries)])
        dest.mkdir()
        candidate_files, contents = {}, blobs([oid for _, oid in entries])
        rec.check('every exported byte string is its listed blob', [oid for _, oid in entries], [blob_id(data) for data in contents])
        for (path, oid), data in zip(entries, contents):
            target = dest / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            candidate_files[path] = sha256(data)
        files = dict(candidate_files)
        mutated = None
        if v:
            rec.check('declared source is exported as the candidate', v['candidate_sha256'], candidate_files[v['source']])
            patch = HERE / v['patch']
            rec.check('patch sha256', v['patch_sha256'], sha256(patch.read_bytes()))
            git('apply', '--check', str(patch), cwd=dest, env=outside_env(dest))
            git('apply', str(patch), cwd=dest, env=outside_env(dest))
            after = (dest / v['source']).read_bytes()
            rec.check('installed mutant sha256', v['mutant_sha256'], sha256(after))
            rec.check('installed mutant blob', v['mutant_blob'], blob_id(after))
            files[v['source']] = sha256(after)
            mutated = {'source': v['source'], 'candidate_sha256': v['candidate_sha256'], 'mutant_sha256': v['mutant_sha256'], 'patch': v['patch'], 'patch_sha256': v['patch_sha256']}
        actual = {p.relative_to(dest).as_posix(): sha256(p.read_bytes()) for p in sorted(dest.rglob('*')) if p.is_file()}
        rec.check('the export is exactly the listing', sorted(files), sorted(actual))
        rec.check('every exported file is its candidate blob, except the one declared source', [v['source']] if v else [],
                  sorted(path for path in actual if actual[path] != candidate_files[path]))
        rec.check('the exported bytes are the manifest', files, actual)
        body = {'unit': reg['unit'], 'candidate_sha': cand['sha'], 'candidate_tree': cand['tree'], 'variant': v['id'] if v else None,
                'identity': 'exact candidate blobs listed below, not a git checkout; no HEAD exists for this directory',
                'dest': str(dest), 'listing_sha256': reg['pure_export']['listing_sha256'], 'mutated': mutated, 'files': files}
        manifest.write_bytes((json.dumps(body, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))
        rec.data.update(dest=str(dest), manifest=str(manifest), manifest_sha256=sha256(manifest.read_bytes()), files=len(files), mutated=mutated)

    rec.run(work)


def recheck(args):
    manifest = Path(args.manifest).resolve()
    body = json.loads(manifest.read_text(encoding='utf-8'))
    rec = Record('recheck', body.get('variant') or 'control')

    def work():
        local_only(rec, 'recheck')
        reg = registry()
        rec.check('manifest names the registered candidate', reg['candidate']['sha'], body['candidate_sha'])
        dest = Path(body['dest'])
        actual = {p.relative_to(dest).as_posix(): sha256(p.read_bytes()) for p in sorted(dest.rglob('*')) if p.is_file()}
        rec.check('the exported tree still equals its manifest after the trial', body['files'], actual)
        product_unchanged(rec, reg, 'after the trial')
        rec.data['manifest_sha256'] = sha256(manifest.read_bytes())

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
        check_staged(rec)
        check_scope(rec, reg)
        check_variant(rec, reg, v)
        check_tests(rec, reg, v)
        check_workflow(rec, reg, blob('HEAD', WORKFLOW).decode('utf-8'), blob(reg['candidate']['sha'], WORKFLOW).decode('utf-8'))
        rec.check('fresh hosted checkout is clean', '', out('status', '--porcelain=v1', '--untracked-files=all', '--ignored'))
        git('checkout', '--quiet', '--detach', reg['candidate']['sha'])
        rec.check('HEAD is the candidate', reg['candidate']['sha'], out('rev-parse', 'HEAD'))
        rec.check('candidate tree', reg['candidate']['tree'], out('rev-parse', 'HEAD^{tree}'))
        rec.check('candidate workflow blob in HEAD', reg['candidate']['workflow_blob'], out('rev-parse', 'HEAD:' + WORKFLOW))
        rec.check('candidate workflow file on disk', reg['candidate']['workflow_blob'], blob_id((root / WORKFLOW).read_bytes()))
        rec.check('no tracked, untracked or ignored difference', '',
                  out('status', '--porcelain=v1', '--untracked-files=all', '--ignored'))
        rec.check('declared source on disk is the candidate', v['candidate_sha256'], sha256((root / v['source']).read_bytes()))
        for path, want in v['test_source_hashes'].items():
            rec.check('test source on disk %s is the candidate' % path, want['sha256'], sha256((root / path).read_bytes()))

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


def failure_blocks(rows):
    blocks, current = [], None
    for line in rows:
        if line.startswith(('FAIL: ', 'ERROR: ')):
            current = [line]
            blocks.append(current)
        elif current is not None:
            if line.startswith(('=' * 70, '-' * 70)) or len(current) >= 120:
                current = None
            else:
                current.append(line)
    return blocks


def profile_record(root):
    """What the original profile left, recorded for review; nothing here passes or fails a trial."""
    data = {'results': None, 'logs': {}, 'transport_failure_count': 0}
    results = root / PROFILE_RESULTS
    if results.is_file():
        data['results'] = json.loads(results.read_text(encoding='utf-8'))
        data['results_sha256'] = sha256(results.read_bytes())
    for folder in PROFILE_LOGS:
        for path in sorted((root / folder).rglob('*.log')) if (root / folder).is_dir() else []:
            raw = path.read_bytes()
            rows = raw.decode('utf-8', 'replace').splitlines()
            transport = [row for row in rows if TRANSPORT in row]
            entry = {'sha256': sha256(raw), 'bytes': len(raw), 'transport_failure_lines': transport}
            if path.name == 'test_volume_mip_output.log':
                entry.update(outcome_lines=[row for row in rows if OUTCOME.match(row)], failure_blocks=failure_blocks(rows))
            data['logs'][path.relative_to(root).as_posix()] = entry
            data['transport_failure_count'] += len(transport)
    return data


def verify(args):
    reg = registry()
    v = find(reg, args.variant, args.tier)
    rec, evidence = Record('verify', v['id']), evidence_dir(args, v['id'])

    def work():
        hosted(rec, reg)
        installed = result_of(evidence / 'install.json')
        rec.data['install_result'] = installed
        rec.data['profile'] = profile_record(Path.cwd())
        rec.check('restore passed', 'passed', result_of(evidence / 'restore.json'))
        rec.check('HEAD is still the candidate', reg['candidate']['sha'], out('rev-parse', 'HEAD'))
        rec.check('tracked difference is exactly the installed source', [v['source']] if installed == 'passed' else [],
                  out('diff', '--name-only', 'HEAD').splitlines())
        if installed == 'passed':
            rec.check('source still holds the installed mutant', v['mutant_sha256'], sha256((Path.cwd() / v['source']).read_bytes()))
        for path, want in v['test_source_hashes'].items():
            rec.check('test source %s is still the candidate' % path, want['sha256'], sha256((Path.cwd() / path).read_bytes()))
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
    sub.add_parser('syntax')
    planning = sub.add_parser('plan')
    planning.add_argument('--scope', action='store_true', help='also check the committed harness-only diff and harness files')
    planning.add_argument('--hosted', action='store_true', help='also check the hosted dispatch')
    exporting = sub.add_parser('export')
    which = exporting.add_mutually_exclusive_group(required=True)
    which.add_argument('--variant')
    which.add_argument('--control', action='store_true', help='the no-mutation control export')
    exporting.add_argument('--dest', required=True)
    exporting.add_argument('--manifest', required=True)
    sub.add_parser('recheck').add_argument('--manifest', required=True)
    for name in ('restore', 'install', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('--tier', required=True)
        p.add_argument('--variant', required=True)
        p.add_argument('--evidence', help='default $RUNNER_TEMP/mutant-evidence/<variant>')
    args = parser.parse_args(argv)
    commands = {'prepare': prepare, 'syntax': syntax, 'plan': plan, 'export': export, 'recheck': recheck,
                'restore': restore, 'install': install, 'verify': verify}
    try:
        commands[args.command](args)
    except Exception as error:
        print('GUARD FAILED (%s): %s: %s' % (args.command, type(error).__name__, error), file=sys.stderr)
        return 3
    print('%s passed' % args.command, file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
