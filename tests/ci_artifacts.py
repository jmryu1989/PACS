"""REQ-W2C-04 -> RISK-CI-EVIDENCE-OMISSION: non-G3 evidence by workflow/SHA.

CI-TOOLING-1a deliberately refuses G3 resolution (CI-TOOLING-1b).
Only first attempts are provably bound by the existing producer/REST contract.
"""
import argparse
from datetime import datetime, timezone
from email.parser import Parser
from email.message import Message
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import parse_qs, urlsplit
from urllib.request import parse_http_list
import zipfile

from ci_workflows import WorkflowCatalog

ROOT = Path(__file__).resolve().parents[1]
STAGE_ARTIFACTS = {
    '7': ('synthetic-runtime-record-runs', 'synthetic-workspace-dom-results'),
    '8': ('synthetic-runtime-record-runs', 'synthetic-workspace-dom-results',
          'synthetic-volume-rendering-results', 'synthetic-context-loss'),
}
CANDIDATE = 'candidate-${{ env.CANDIDATE_SHA }}'
# This cap belongs only to filtered workflow-run searches, not artifact listings.
# https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
RUN_SEARCH_CAP = 1000


def inventory(root):
    catalog = WorkflowCatalog(root)
    rows = []
    for workflow, doc in catalog.documents.items():
        for job_id, job in doc['jobs'].items():
            # Local restore jobs share ids; all other jobs must have one owner.
            owner = (catalog.owner(job_id)[0] if len(catalog.owners[job_id]) == 1
                     else workflow)
            for step in job.get('steps', []):
                if str(step.get('uses', '')).split('@')[0] == 'actions/upload-artifact':
                    rows.append({'workflow': owner, 'job': job_id,
                                 'artifact': step.get('with', {}).get('name', 'artifact')})
    return sorted(rows, key=lambda row: (row['workflow'], row['job'], row['artifact']))


def gh_json(*args):
    return json.loads(subprocess.check_output(['gh', *args], text=True, encoding='utf-8'))


def gh_get(endpoint):
    raw = subprocess.check_output(
        ['gh', 'api', '--method', 'GET', '--include', '-H', 'X-GitHub-Api-Version: 2022-11-28',
         '-H', 'Cache-Control: no-cache', endpoint], text=True, encoding='utf-8')
    head, body = raw.split('\n\n', 1)
    status, headers = head.split('\n', 1)
    if status.split()[1] != '200':
        raise ValueError(f'HTTP response {status}')
    return json.loads(body), dict(Parser().parsestr(headers).items())


def stop(reason, run=None, artifact=None):
    run = run or {}
    raise ValueError(f'STOP run_id={run.get("id", "unknown")} '
                     f'attempt={run.get("run_attempt", "unknown")} '
                     f'artifact_id={artifact if artifact is not None else "unknown"}: {reason}')


def listing(query, endpoint, key, run=None):
    """Follow actual Link relations; counts are consistency checks, never loop bounds.

    The 2026-09-25 count change may report a lower bound at scale. Reject capped,
    non-integer or inconsistent run counts. Artifact endpoints have no documented
    1,000 cap; they still need Link exhaustion and consistent unique row counts.
    """
    origin = urlsplit('https://api.github.com/' + endpoint)
    original_params = parse_qs(origin.query)
    rows, ids, visited, count = [], set(), set(), None
    while endpoint:
        if endpoint in visited:
            stop('pagination Link cycle', run)
        visited.add(endpoint)
        payload, headers = query(endpoint)
        total, page = payload.get('total_count'), payload.get(key)
        if type(total) is not int or total < 0 or not isinstance(page, list):
            stop('missing/exact count or invalid page', run)
        if count is not None and total != count:
            stop('count changed during pagination', run)
        count = total
        if key == 'workflow_runs' and total >= RUN_SEARCH_CAP:
            stop('workflow search cap reached; complete listing unproved', run)
        for row in page:
            ident = row.get('id')
            if type(ident) is not int or ident <= 0 or ident in ids:
                stop(f'invalid/duplicate {key} id {ident}', run, ident if key == 'artifacts' else None)
            ids.add(ident)
            rows.append(row)
        if len(rows) > count:
            stop('listed rows exceed reported count', run)
        link = next((v for k, v in headers.items() if k.lower() == 'link'), '')
        links = []
        for part in parse_http_list(link):
            address, separator, parameters = part.partition(';')
            if not separator or not address.strip().startswith('<') or not address.strip().endswith('>'):
                stop('invalid pagination Link', run)
            message = Message()
            message['content-type'] = 'link;' + parameters
            links.append({'url': address.strip()[1:-1], 'rel': message.get_param('rel')})
        next_links = [item['url'] for item in links if item.get('rel') == 'next']
        if len(next_links) > 1 or (link and not links):
            stop('invalid pagination Link', run)
        endpoint = next_links[0] if next_links else None
        if endpoint:
            target = urlsplit(endpoint)
            params = parse_qs(target.query)
            if (target.scheme != 'https' or target.netloc != origin.netloc or target.path != origin.path
                    or {k: v for k, v in params.items() if k != 'page'} != original_params
                    or not page):
                stop('unsafe/inconsistent pagination Link', run)
    if len(rows) != count:
        stop(f'incomplete listing: {len(rows)} unique rows, reported {count}', run)
    return rows


def revision(run):
    return tuple(run[key] for key in ('id', 'path', 'head_sha', 'event', 'run_attempt',
                                      'updated_at', 'status', 'conclusion'))


def check_run(run, workflow, sha):
    if run['path'].split('@')[0] != workflow or run['head_sha'] != sha:
        stop(f'{workflow}: run owner/SHA mismatch', run)
    if run.get('event') not in ('push', 'pull_request'):
        stop('only push/pull_request head_sha evidence is supported', run)
    if type(run.get('run_attempt')) is not int or run['run_attempt'] != 1:
        # REST artifacts have run_id but no attempt. Existing producers do not
        # bind attempt either. Timestamps/name ordering are not that evidence.
        stop('rerun artifact attempt cannot be proved by existing producer; CI-TOOLING-1b', run)
    for key in ('created_at', 'updated_at'):
        value = datetime.fromisoformat(run[key].replace('Z', '+00:00'))
        if value.tzinfo is None:
            stop(f'{key} lacks timezone', run)


def fetch_archive(endpoint, archive):
    with archive.open('xb') as stream:
        subprocess.run(['gh', 'api', '--method', 'GET', endpoint], stdout=stream, check=True)


def unpack(archive, destination):
    with zipfile.ZipFile(archive) as zipped:
        for info in zipped.infolist():
            name = info.filename.replace('\\', '/')
            target = (destination / name).resolve()
            if (not target.is_relative_to(destination.resolve()) or ':' in name
                    or (info.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('unsafe archive member')
        zipped.extractall(destination)


def download(root, sha, stage, out, query=gh_get, fetch=fetch_archive, *,
             non_candidate=False, dry_run=False, repository=None):
    # Default/full stage collection must never yield a partial G3 result.
    if not non_candidate:
        stop('candidate.yml evidence resolution belongs to CI-TOOLING-1b; '
             'use --non-candidate only for the separate non-G3 collection')
    if not re.fullmatch('[0-9a-f]{40}', sha):
        stop('full candidate SHA required')
    declarations = inventory(root)
    required = STAGE_ARTIFACTS[stage]
    selected = [row for row in declarations if row['artifact'] in required]
    if any(Path(row['workflow']).name == 'candidate.yml' or row['job'] == 'candidate'
           or row['artifact'] == CANDIDATE for row in selected):
        stop('candidate workflow evidence resolution belongs to CI-TOOLING-1b')
    missing = set(required) - {row['artifact'] for row in selected}
    if missing:
        stop(f'missing upload declarations: {sorted(missing)}')
    repository = repository or gh_json('repo', 'view', '--json', 'nameWithOwner')['nameWithOwner']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        stop('invalid repository')
    base = f'repos/{repository}/actions'
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    (out / 'artifact-inventory.json').write_text(json.dumps(declarations, indent=2) + '\n', encoding='utf-8')
    manifest = {'sha': sha, 'stage': stage, 'repository': repository, 'scope': 'non-candidate',
                'g3': 'NOT_COLLECTED: CI-TOOLING-1b', 'runs': [], 'downloads': [],
                'listings': {}, 'dry_run': dry_run, 'status': 'incomplete'}
    context, artifact_id = None, None

    def save():
        (out / 'artifact-downloads.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

    def workflow_runs(workflow):
        endpoint = f'{base}/workflows/{Path(workflow).name}/runs?head_sha={sha}&per_page=100'
        rows = listing(query, endpoint, 'workflow_runs')
        runs = [run for run in rows if run['head_sha'] == sha]
        # Do not silently drop contradictory filtered API rows.
        if len(runs) != len(rows):
            stop(f'{workflow}: head_sha search returned a foreign SHA')
        for run in runs:
            check_run(run, workflow, sha)
        return runs

    save()
    try:
        for workflow in sorted({row['workflow'] for row in selected}):
            context, artifact_id = None, None
            names = {row['artifact'] for row in selected if row['workflow'] == workflow}
            runs = workflow_runs(workflow)
            if not runs:
                stop(f'{workflow}: no run for {sha}')
            manifest['listings'][workflow] = sorted([list(revision(run)) for run in runs])
            run = max(runs, key=lambda item: (item['created_at'], item['id']))
            context = run
            current, _ = query(f'{base}/runs/{run["id"]}')
            if revision(current) != revision(run):
                stop('run changed between listing and collection', run)
            if run['status'] != 'completed' or run['conclusion'] != 'success':
                stop(f'{workflow}: latest run is not completed/success', run)
            manifest['runs'].append({'workflow': workflow, 'id': run['id'], 'lookup': 'head_sha',
                                     'sha': sha, 'run_head_sha': run['head_sha'], 'event': run['event'],
                                     'attempt': run['run_attempt'], 'updated_at': run['updated_at'],
                                     'conclusion': run['conclusion']})
            artifacts = listing(query, f'{base}/runs/{run["id"]}/artifacts?per_page=100', 'artifacts', run)
            for artifact in sorted(names):
                named = [item for item in artifacts if item['name'] == artifact]
                artifact_id = ','.join(str(item['id']) for item in named) or 'missing'
                matches = [item for item in named if not item['expired']]
                if len(matches) != 1:
                    stop(f'{workflow}: expected one available {artifact}', run, artifact_id)
                checked = matches[0]
                artifact_id = checked['id']
                metadata, _ = query(f'{base}/artifacts/{artifact_id}')
                if metadata != checked:
                    stop('artifact metadata changed before download', run, artifact_id)
                owner = metadata.get('workflow_run', {})
                if owner.get('id') != run['id'] or owner.get('head_sha') != sha:
                    stop('artifact belongs to another run/SHA', run, artifact_id)
                category = 'support' if artifact == 'synthetic-context-loss' else 'runs'
                destination = out / category / Path(workflow).stem / str(run['id']) / artifact
                endpoint = f'{base}/artifacts/{artifact_id}/zip'
                row = {'workflow': workflow, 'run': run['id'], 'attempt': run['run_attempt'],
                       'attempt_binding': 'unrerun-run', 'artifact': artifact, 'artifact_id': artifact_id,
                       'download_endpoint': endpoint, 'destination': str(destination), 'downloaded': False}
                if not dry_run:
                    destination.mkdir(parents=True, exist_ok=False)
                    archive = destination.parent / (artifact + '.zip')
                    fetch(endpoint, archive)
                    digest = 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest()
                    if metadata.get('digest') and metadata['digest'] != digest:
                        stop('downloaded archive digest mismatch', run, artifact_id)
                    unpack(archive, destination)
                    row.update(downloaded=True, archive=str(archive), digest=digest)
                manifest['downloads'].append(row)
                save()
                current, _ = query(f'{base}/runs/{run["id"]}')
                if revision(current) != revision(run):
                    stop('run/attempt/updated_at changed during download', run, artifact_id)
                after, _ = query(f'{base}/artifacts/{artifact_id}')
                if after != metadata:
                    stop('artifact changed during download', run, artifact_id)
        # The last workflow may take time: recheck all earlier owners too.
        for workflow, initial in manifest['listings'].items():
            final = sorted([list(revision(run)) for run in workflow_runs(workflow)])
            if final != initial:
                stop(f'{workflow}: workflow run set/revisions changed during collection', context, artifact_id)
        manifest['verified_at'] = datetime.now(timezone.utc).isoformat()
        manifest['status'] = 'planned' if dry_run else 'completed'
    except Exception as error:
        message = str(error)
        if not message.startswith('STOP '):
            message = (f'STOP run_id={(context or {}).get("id", "unknown")} '
                       f'attempt={(context or {}).get("run_attempt", "unknown")} '
                       f'artifact_id={artifact_id if artifact_id is not None else "unknown"}: {message}')
        manifest['error'] = message
        raise ValueError(message) from error
    finally:
        save()
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--list', action='store_true', help='all upload names/templates and owners')
    parser.add_argument('--sha')
    parser.add_argument('--stage', choices=STAGE_ARTIFACTS)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--non-candidate', action='store_true', help='explicitly exclude G3; never a full stage result')
    parser.add_argument('--dry-run', action='store_true', help='GET metadata only; manifest status planned, no archives')
    args = parser.parse_args()
    if args.list:
        print(json.dumps(inventory(args.root), indent=2))
    elif args.sha and args.stage and args.out:
        print(json.dumps(download(args.root, args.sha, args.stage, args.out,
                                  non_candidate=args.non_candidate, dry_run=args.dry_run), indent=2))
    else:
        parser.error('use --list or --sha SHA --stage 7|8 --out NEW_DIRECTORY [--non-candidate]')


if __name__ == '__main__':
    main()
