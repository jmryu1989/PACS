#!/usr/bin/env python3
"""G3 push-side admission. A pending request is durable before the one POST.

Use --resume after response loss; it never dispatches again. A nonce, not a SHA
title or most-recent run heuristic, resolves an empty dispatch response.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import quote
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tests'))
from ci_candidate_evidence import (WORKFLOW, SHA, LIMIT, check_run, gh_get, inspect_artifact,
    fetch_archive, instant, listing, read_record, resolve_cutoff, stop, validate_record)


def save(path, record):
    validate_record(record)
    encoded = json.dumps(record, indent=2) + '\n'
    if len(encoded.encode('utf-8')) > LIMIT:
        stop('round record exceeds 512 KiB')
    temporary = path.with_name(path.name + '.new')
    with temporary.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def initialize(path, repository, sha, round_id, pr_policy='forbid', *, cutoff_sha, query=gh_get, now=None):
    """Create the round record; the only writer of the legacy cutoff T0."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with locked(path):
        if path.exists():
            stop('record already exists')
        cutoff = resolve_cutoff(repository, cutoff_sha, query, now)
        save(path, {'schema': 1, 'repository': repository, 'candidate_sha': sha,
                   'round_id': round_id, 'workflow': WORKFLOW, 'revision': 1,
                   'pr_policy': pr_policy, 'partial_rerun_policy': 'whole-candidate-job',
                   'cutoff': cutoff, 'requests': []})


@contextmanager
def locked(path):
    lock = path.with_name(path.name + '.lock')
    from ops_backup import recover_process_lock
    recover_process_lock(lock)
    # Recovery unlinks only a lock still holding the token it saw; a successor that reuses the PID must not match it.
    with lock.open('x', encoding='utf-8') as stream:
        stream.write(str(os.getpid()) + ':g3:' + uuid.uuid4().hex)
    try:
        yield
    finally:
        lock.unlink()


def post_dispatch(endpoint, body):
    raw = subprocess.check_output(['gh', 'api', '--method', 'POST', '--include',
        '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint, '--input', '-'],
        input=json.dumps(body), text=True, encoding='utf-8', timeout=60)
    head, payload = raw.split('\n\n', 1)
    status = int(head.splitlines()[0].split()[1])
    if status not in (200, 204):
        stop(f'dispatch response {status}; request remains pending')
    return {'status': status, 'body': json.loads(payload) if payload.strip() else None}


def bind(path, record, entry, query, repository_id, workflow_id, polls=12, sleep=time.sleep):
    base = f'repos/{record["repository"]}/actions'
    body = entry.get('response', {}).get('body') or {}
    response_id = body.get('workflow_run_id')
    if response_id is not None and (type(response_id) is not int or response_id <= 0):
        stop('invalid dispatch response run id')
    if response_id is not None and 'run_url' in body and \
            body['run_url'] != f'https://api.github.com/repos/{record["repository"]}/actions/runs/{response_id}':
        stop('dispatch response run_url names another repository/run')
    title = f'candidate {record["candidate_sha"]} [g3:{entry["nonce"]}]'
    started = instant(entry['requested_at'])
    seen_title = None
    for index in range(polls):
        if response_id is not None:
            run, _ = query(f'{base}/runs/{response_id}')
            if run.get('id') != response_id:
                # The GET body must name the very ID the POST returned; another run is never bound.
                stop(f'dispatch response run id differs from the GET body id {run.get("id")!r}',
                     {'id': response_id, 'run_attempt': run.get('run_attempt', 'unknown')})
            matches = [run]
        else:
            # This is dispatch response recovery, never collector discovery.
            since = quote((started - timedelta(seconds=5)).isoformat(), safe='')
            rows = listing(query, f'{base}/workflows/candidate.yml/runs?event=workflow_dispatch&created=%3E%3D{since}&per_page=100',
                           'workflow_runs', repository_id)
            matches = [r for r in rows if r.get('display_title') == title]
        if len(matches) > 1:
            stop(f'ambiguous dispatch nonce: run ids {[r["id"] for r in matches]}')
        if matches:
            run = matches[0]
            check_run(run, repository_id, workflow_id)
            # Immutable identity is never retried: another event, creation window or ref is not ours.
            if (run['event'] != 'workflow_dispatch'
                    or not started - timedelta(seconds=5) <= instant(run['created_at']) <= started + timedelta(minutes=10)):
                stop('dispatch response event/timestamp mismatch', run)
            if run.get('head_branch') != entry['dispatch_ref']:
                stop('dispatch ref mismatch', run)
            if run.get('display_title') == title:
                entry.update(state='bound', run_id=run['id'], tools_sha=run['head_sha'])
                record['revision'] += 1
                save(path, record)
                return run['id']
            # Defensive rule: tolerate a title that becomes visible later by re-reading the same ID
            # within the bound. Observed on run 38504773317: 200 + run ID, a STOP leaving the request
            # pending, the correct title on later GETs and a 0-POST --resume. That the first GET lacked
            # the rendered run-name is INFERRED (no first-GET snapshot was kept). The title carries the
            # candidate SHA and nonce, so a run that never shows them is refused below, never bound.
            seen_title = run.get('display_title')
        if index + 1 < polls:
            sleep(5)
    if response_id is not None:
        stop(f'dispatch response run never showed this request title (last {seen_title!r}); '
             'preserve pending request and --resume', {'id': response_id})
    stop('dispatch unresolved after bounded poll; preserve pending request and --resume')


def dispatch(path, repository=None, sha=None, round_id=None, ref=None, *,
             resume=False, supersedes=(), query=gh_get,
             post=post_dispatch, sleep=time.sleep, now=None):
    path = Path(path)
    if not path.exists():
        # The cutoff T0 is written only by --init; never invent one here.
        stop('round record missing; create it with --init --cutoff-sha first')
    with locked(path):
        record, _ = read_record(path)
        for key, value in (('repository', repository), ('candidate_sha', sha), ('round_id', round_id)):
            if value is not None and value != record[key]:
                stop(f'existing record {key} mismatch')
        base = f'repos/{record["repository"]}/actions'
        repo, _ = query(f'repos/{record["repository"]}')
        workflow, _ = query(f'{base}/workflows/candidate.yml')
        if (repo.get('full_name') != record['repository'] or type(repo.get('id')) is not int
                or workflow.get('path') != WORKFLOW or type(workflow.get('id')) is not int):
            stop('repository/workflow identity mismatch before dispatch')
        pending = [e for e in record['requests'] if e['state'] == 'dispatch_pending']
        if resume:
            if len(pending) != 1:
                stop('resume requires exactly one pending request')
            return bind(path, record, pending[0], query, repo['id'], workflow['id'], sleep=sleep)
        if pending:
            stop('unresolved prior request; use --resume, no automatic second dispatch')
        if not ref or not SHA.fullmatch(sha or ''):
            stop('dispatch ref and full candidate SHA required')
        known = {e['run_id'] for e in record['requests']}
        retired = []
        for ident, attempt in supersedes:
            if ident not in known:
                stop(f'replacement run {ident} is not recorded')
            prior, _ = query(f'{base}/runs/{ident}')
            check_run(prior, repo['id'], workflow['id'])
            if prior['run_attempt'] != attempt or prior['status'] != 'completed':
                stop('replacement requires exact completed attempt', prior)
            retired.append({'run_id': ident, 'run_attempt': attempt})
        entry = {'nonce': uuid.uuid4().hex, 'requested_at': (now or datetime.now(timezone.utc)).isoformat(),
                 'dispatch_ref': ref, 'event': 'workflow_dispatch', 'state': 'dispatch_pending',
                 'supersedes': retired}
        record['requests'].append(entry)
        record['revision'] += 1
        save(path, record)
        body = {'ref': ref, 'inputs': {'candidate_sha': sha, 'dispatch_nonce': entry['nonce']},
                'return_run_details': True}
        # Persist the exact request and response, including empty responses.
        entry['request'] = body
        save(path, record)
        entry['response'] = post(f'{base}/workflows/candidate.yml/dispatches', body)
        record['revision'] += 1
        save(path, record)
        return bind(path, record, entry, query, repo['id'], workflow['id'], sleep=sleep)


def admit(path, run_id, evidence_dir, *, query=gh_get, fetch=fetch_archive):
    """Explicitly adopt an existing run after payload validation (never by title).

    PR policy must already allow candidate checkout; merge-tools SHA is checked
    against the PR API at admission and preserved for later collection.
    """
    path = Path(path)
    with locked(path):
        record, _ = read_record(path)
        if any(e['state'] != 'bound' for e in record['requests']):
            stop('resolve pending dispatch before adopting another run')
        if any(e['run_id'] == run_id for e in record['requests']):
            stop('run already recorded; reruns keep the same admission')
        base = f'repos/{record["repository"]}/actions'
        repo, _ = query(f'repos/{record["repository"]}')
        workflow, _ = query(f'{base}/workflows/candidate.yml')
        run, _ = query(f'{base}/runs/{run_id}')
        if run.get('id') != run_id:
            # Refused before any download or save: the admitted ID must be the GET body's ID.
            stop(f'requested run id differs from the GET body id {run.get("id")!r}',
                 {'id': run_id, 'run_attempt': run.get('run_attempt', 'unknown')})
        check_run(run, repo['id'], workflow['id'])
        if instant(run['created_at']) < instant(record['cutoff']['timestamp']):
            stop('run predates the legacy cutoff T0; legacy runs are never admitted', run)
        if run['event'] == 'pull_request' and record['pr_policy'] == 'forbid':
            stop('PR run forbidden by round policy', run)
        out = Path(evidence_dir)
        out.mkdir(parents=True, exist_ok=False)
        row = inspect_artifact(base, run, repo['id'], query, fetch, out, record['candidate_sha'])
        p = row['provenance']
        if run['event'] == 'pull_request':
            prs = run.get('pull_requests', [])
            if len(prs) != 1:
                stop('PR admission requires one linked PR', run)
            pr, _ = query(f'repos/{record["repository"]}/pulls/{prs[0]["number"]}')
            if pr['head']['sha'] != record['candidate_sha'] or pr['merge_commit_sha'] != p.get('tools_sha'):
                stop('PR head/merge tools mismatch at admission', run)
        runner = json.loads((Path(row['destination']) / 'candidate-provenance.json').read_text(encoding='utf-8'))
        if runner.get('candidate_sha') != record['candidate_sha'] or runner.get('tools_sha') != p.get('tools_sha'):
            stop('candidate runner provenance contradicts admission', run)
        entry = {'nonce': p['dispatch_nonce'] if run['event'] == 'workflow_dispatch' else uuid.uuid4().hex,
                 'requested_at': datetime.now(timezone.utc).isoformat(), 'dispatch_ref': None,
                 'event': run['event'], 'state': 'bound', 'run_id': run_id, 'tools_sha': p['tools_sha'],
                 'supersedes': [], 'admission': row}
        record['requests'].append(entry)
        record['revision'] += 1
        save(path, record)
        return run_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--repository')
    parser.add_argument('--sha')
    parser.add_argument('--round-id')
    parser.add_argument('--ref')
    parser.add_argument('--pr-policy', choices=('forbid', 'candidate-checkout-with-merge-tools'), default='forbid')
    parser.add_argument('--cutoff-sha', help='--init only: T0, the first commit carrying the G3 producer')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--init', action='store_true')
    mode.add_argument('--resume', action='store_true')
    mode.add_argument('--adopt-run', type=int)
    parser.add_argument('--evidence-dir', type=Path)
    parser.add_argument('--supersede', action='append', default=[], metavar='RUN_ID:ATTEMPT')
    args = parser.parse_args()
    if (args.cutoff_sha or args.pr_policy != 'forbid') and not args.init:
        parser.error('--cutoff-sha and --pr-policy are written only by --init')
    if args.init:
        if not args.cutoff_sha:
            parser.error('--init requires --cutoff-sha (legacy cutoff T0)')
        initialize(args.record, args.repository, args.sha, args.round_id, args.pr_policy,
                   cutoff_sha=args.cutoff_sha)
        ident = None
    elif args.adopt_run:
        if args.evidence_dir is None:
            parser.error('--adopt-run requires --evidence-dir')
        ident = admit(args.record, args.adopt_run, args.evidence_dir)
    else:
        retired = [tuple(map(int, value.split(':'))) for value in args.supersede]
        if any(len(row) != 2 for row in retired):
            parser.error('--supersede requires RUN_ID:ATTEMPT')
        ident = dispatch(args.record, args.repository, args.sha, args.round_id, args.ref,
                         resume=args.resume, supersedes=retired)
    print(json.dumps({'record': str(args.record), 'run_id': ident}))


if __name__ == '__main__':
    main()
