"""REQ-G3-PUSH -> RISK-G3-STALE/OMITTED/WRONG-ATTEMPT -> ci_candidate_evidence_test.

The round record admits runs. Listings can only invalidate that population.
Runs created before the record's cutoff T0 (the first commit carrying the
producer) are legacy: listed, never admitted and never a STOP cause.
No product execution, Git writes or GitHub writes occur in this module.
"""
import argparse
import base64
from datetime import datetime, timezone
from email.message import Message
from email.parser import Parser
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
from urllib.parse import parse_qs, urlsplit
from urllib.request import parse_http_list
import zipfile

WORKFLOW = '.github/workflows/candidate.yml'
SHA = re.compile('[0-9a-f]{40}')
LIMIT = 512 * 1024


def produce(directory, env):
    """Write the current hosted attempt envelope beside the existing runner payload."""
    provenance = {
        'schema': 1, 'repository': env['GITHUB_REPOSITORY'],
        'run_id': int(env['GITHUB_RUN_ID']), 'run_attempt': int(env['GITHUB_RUN_ATTEMPT']),
        'candidate_sha': env['CANDIDATE_SHA'], 'tools_sha': env['GITHUB_SHA'],
        'workflow_path': WORKFLOW, 'workflow_ref': env['GITHUB_WORKFLOW_REF'],
        'event': env['GITHUB_EVENT_NAME'], 'started_at': env['G3_STARTED_AT'],
        'dispatch_nonce': env.get('DISPATCH_NONCE', ''),
    }
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'g3-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8')


def stop(reason, run=None, artifact=None):
    run = run or {}
    raise ValueError(f'STOP run_id={run.get("id", "unknown")} '
                     f'attempt={run.get("run_attempt", "unknown")} '
                     f'artifact_id={artifact if artifact is not None else "unknown"}: {reason}')


def instant(value):
    try:
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if date.tzinfo is None:
            raise ValueError('timezone required')
        return date
    except (ValueError, AttributeError, TypeError) as error:
        raise ValueError(f'invalid timestamp {value!r}') from error


def json_value(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'duplicate JSON key {key}')
            result[key] = value
        return result
    if len(raw) > LIMIT:
        stop('JSON exceeds 512 KiB')
    return json.loads(raw, object_pairs_hook=unique)


def read_record(path):
    raw = Path(path).read_bytes()
    record = json_value(raw)
    validate_record(record)
    return record, hashlib.sha256(raw).hexdigest()


def validate_record(record):
    if not isinstance(record, dict) or type(record.get('schema')) is not int or record['schema'] != 1:
        stop('round schema must be 1')
    fields = {'schema', 'repository', 'candidate_sha', 'round_id', 'workflow', 'revision',
              'pr_policy', 'partial_rerun_policy', 'cutoff', 'requests'}
    if set(record) != fields:
        stop('round schema fields missing/unknown')
    cutoff = record.get('cutoff')
    if (not isinstance(cutoff, dict) or set(cutoff) != {'sha', 'timestamp'}
            or not isinstance(cutoff.get('sha'), str) or not SHA.fullmatch(cutoff['sha'])):
        stop('legacy cutoff T0 requires exactly sha and timestamp')
    instant(cutoff.get('timestamp'))
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', record.get('repository', '')):
        stop('invalid repository')
    if not SHA.fullmatch(record.get('candidate_sha', '')) or not isinstance(record.get('round_id'), str) or not record['round_id']:
        stop('round id and full candidate SHA required')
    if record.get('workflow') != WORKFLOW or record.get('partial_rerun_policy') != 'whole-candidate-job':
        stop('invalid workflow/partial rerun policy')
    if record.get('pr_policy') not in ('forbid', 'candidate-checkout-with-merge-tools'):
        stop('explicit PR policy required')
    if type(record.get('revision')) is not int or record['revision'] < 1:
        stop('invalid record revision')
    entries = record.get('requests')
    if not isinstance(entries, list):
        stop('invalid official population')
    ids, nonces = set(), set()
    for entry in entries:
        required = {'nonce', 'requested_at', 'dispatch_ref', 'event', 'state', 'supersedes'}
        allowed = required | {'run_id', 'tools_sha', 'request', 'response', 'admission'}
        if not isinstance(entry, dict) or not required <= set(entry) <= allowed:
            stop('request schema fields missing/unknown')
        if any(not isinstance(entry[key], dict) for key in ('request', 'response', 'admission') if key in entry):
            stop('invalid request/response/admission object')
        nonce = entry.get('nonce', '')
        if not re.fullmatch('[0-9a-f]{32}', nonce) or nonce in nonces:
            stop('invalid/duplicate request nonce')
        nonces.add(nonce)
        instant(entry.get('requested_at'))
        if entry.get('state') not in ('dispatch_pending', 'bound'):
            stop('invalid request state')
        if entry.get('event') not in ('workflow_dispatch', 'pull_request'):
            stop('invalid recorded event')
        if not (entry['dispatch_ref'] is None or isinstance(entry['dispatch_ref'], str)):
            stop('invalid dispatch ref')
        if entry['event'] == 'pull_request' and record['pr_policy'] == 'forbid':
            stop('PR run forbidden by round policy')
        supersedes = entry.get('supersedes')
        if not isinstance(supersedes, list):
            stop('explicit supersedes list required')
        replaced = set()
        for prior in supersedes:
            if (not isinstance(prior, dict) or set(prior) != {'run_id', 'run_attempt'}
                    or type(prior.get('run_id')) is not int
                    or prior.get('run_id') not in ids or prior['run_id'] in replaced
                    or type(prior.get('run_attempt')) is not int or prior['run_attempt'] < 1):
                stop('replacement must name an earlier recorded run and exact attempt')
            replaced.add(prior['run_id'])
        if entry['state'] == 'bound':
            ident = entry.get('run_id')
            if type(ident) is not int or ident <= 0 or ident in ids:
                stop('invalid/duplicate recorded run id')
            ids.add(ident)
            if not SHA.fullmatch(entry.get('tools_sha', '')):
                stop('recorded tools SHA required')
        elif entry.get('run_id') is not None:
            stop('pending request cannot claim a bound run')


def carries_producer(text):
    """True when candidate.yml's candidate job runs this module's --produce step."""
    import yaml  # Lazy: the hosted --produce step needs only the standard library.
    try:
        steps = yaml.safe_load(text)['jobs']['candidate']['steps']
        commands = [shlex.split(str(step['run'])) for step in steps if 'run' in step]
    except (yaml.YAMLError, KeyError, TypeError, ValueError) as error:
        stop(f'cannot read candidate.yml producer steps: {error}')
    return any('--produce' in argv and any(word.endswith('ci_candidate_evidence.py') for word in argv)
               for argv in commands)


def resolve_cutoff(repository, sha, query=None, now=None):
    """T0 = the first commit carrying the producer: T0 has it, its first parent does not.

    The commit's committer date is the cutoff instant. A later commit would hide
    producer-era runs as legacy, so the first-parent check refuses it.
    """
    query = query or gh_get
    if not SHA.fullmatch(sha or ''):
        stop('legacy cutoff T0 requires a full commit SHA')
    commit, _ = query(f'repos/{repository}/commits/{sha}')
    if commit.get('sha') != sha:
        stop('legacy cutoff commit identity mismatch')
    stamp = ((commit.get('commit') or {}).get('committer') or {}).get('date')
    if instant(stamp) > (now or datetime.now(timezone.utc)):
        stop('legacy cutoff timestamp lies in the future')
    parents = commit.get('parents')
    if not isinstance(parents, list) or not parents or not SHA.fullmatch(str(parents[0].get('sha', ''))):
        stop('legacy cutoff commit needs a first parent')

    def workflow_at(ref):
        content, _ = query(f'repos/{repository}/contents/.github/workflows/candidate.yml?ref={ref}')
        if content.get('type') != 'file' or content.get('encoding') != 'base64':
            stop(f'candidate.yml at {ref} is not a base64 file')
        return base64.b64decode(content['content']).decode('utf-8')

    if not carries_producer(workflow_at(sha)):
        stop('legacy cutoff commit does not carry the G3 producer')
    if carries_producer(workflow_at(parents[0]['sha'])):
        stop('legacy cutoff is not the first producer commit: its first parent already carries it')
    return {'sha': sha, 'timestamp': stamp}


def legacy(run, cutoff):
    """Created and latest attempt started before T0: excluded, never admitted or STOP.

    A pre-T0 run re-run after T0 is not legacy; it must prove its provenance.
    """
    boundary = instant(cutoff['timestamp'])
    return instant(run.get('created_at')) < boundary and instant(run.get('run_started_at')) < boundary


def gh_get(endpoint):
    raw = subprocess.check_output(['gh', 'api', '--method', 'GET', '--include',
        '-H', 'X-GitHub-Api-Version: 2022-11-28', '-H', 'Cache-Control: no-cache', endpoint],
        text=True, encoding='utf-8', timeout=60)
    head, body = raw.split('\n\n', 1)
    status, headers = head.split('\n', 1)
    if status.split()[1] != '200':
        stop(f'HTTP response {status}')
    return json.loads(body), dict(Parser().parsestr(headers).items())


def fetch_archive(endpoint, archive):
    with Path(archive).open('xb') as stream:
        subprocess.run(['gh', 'api', '--method', 'GET', endpoint], stdout=stream,
                       check=True, timeout=120)


def listing(query, endpoint, key, repository_id, run=None):
    """1a pagination contract, including GitHub's numeric repository Link form."""
    origin = urlsplit('https://api.github.com/' + endpoint)
    params = {k: v for k, v in parse_qs(origin.query, keep_blank_values=True).items() if k != 'page'}
    canonical = f'/repositories/{repository_id}/' + origin.path.split('/', 4)[4]
    rows, ids, visited, count = [], set(), set(), None
    while endpoint:
        if endpoint in visited:
            stop('pagination Link cycle', run)
        visited.add(endpoint)
        payload, headers = query(endpoint)
        total, page = payload.get('total_count'), payload.get(key)
        if type(total) is not int or total < 0 or not isinstance(page, list):
            stop('invalid exact count/page', run)
        if count is not None and count != total:
            stop('count changed during pagination', run)
        count = total
        if key == 'workflow_runs' and total >= 1000:
            stop('workflow search cap reached; completeness unproved', run)
        for row in page:
            ident = row.get('id')
            if type(ident) is not int or ident <= 0 or ident in ids:
                stop(f'invalid/duplicate {key} id {ident}', run)
            ids.add(ident)
            rows.append(row)
        if len(rows) > count:
            stop('rows exceed reported count', run)
        link = next((v for k, v in headers.items() if k.lower() == 'link'), '')
        following = []
        for part in parse_http_list(link):
            address, separator, parameters = part.partition(';')
            if not separator or not address.strip().startswith('<') or not address.strip().endswith('>'):
                stop('invalid pagination Link', run)
            message = Message()
            message['content-type'] = 'link;' + parameters
            if message.get_param('rel') == 'next':
                following.append(address.strip()[1:-1])
        if len(following) > 1:
            stop('multiple next Links', run)
        endpoint = following[0] if following else None
        if endpoint:
            target = urlsplit(endpoint)
            query_params = parse_qs(target.query, keep_blank_values=True)
            if target.scheme != 'https' or target.netloc != 'api.github.com':
                stop('pagination Link foreign host/scheme', run)
            if target.path not in (origin.path, canonical):
                stop('pagination Link foreign repository/path', run)
            if {k: v for k, v in query_params.items() if k != 'page'} != params:
                stop('pagination Link changed query', run)
            if (target.fragment or len(query_params.get('page', [])) != 1
                    or not query_params['page'][0].isdigit() or int(query_params['page'][0]) < 1 or not page):
                stop('invalid pagination Link page/fragment', run)
    if len(rows) != count:
        stop(f'incomplete listing: {len(rows)} rows, reported {count}', run)
    return rows


def revision(run):
    return tuple(run.get(key) for key in ('id', 'repository', 'workflow_id', 'path', 'head_sha',
        'event', 'run_attempt', 'created_at', 'run_started_at', 'updated_at', 'status', 'conclusion'))


def attempt_revision(run):
    # GitHub run.created_at and attempt.created_at are different clocks (also on
    # attempt 1). Keep both snapshots, but compare shared execution identity here.
    snapshot = revision(run)
    return snapshot[:7] + snapshot[8:]


def check_run(run, repository_id, workflow_id, entry=None):
    if (run.get('path') != WORKFLOW or run.get('workflow_id') != workflow_id
            or run.get('repository', {}).get('id') != repository_id):
        stop('run workflow/repository mismatch', run)
    if type(run.get('id')) is not int or type(run.get('run_attempt')) is not int or run['run_attempt'] < 1:
        stop('invalid run id/attempt', run)
    if run.get('event') not in ('workflow_dispatch', 'pull_request'):
        stop('unsupported run event', run)
    for key in ('created_at', 'run_started_at', 'updated_at'):
        instant(run.get(key))
    if entry and (run['id'] != entry['run_id'] or run['event'] != entry['event']):
        stop('recorded run id/event mismatch', run)
    if entry and run['event'] == 'workflow_dispatch' and run.get('head_sha') != entry['tools_sha']:
        stop('dispatch tools SHA mismatch', run)


def unpack(archive, destination):
    # Inspect all members before writing any; Windows aliases cannot overwrite provenance.
    with zipfile.ZipFile(archive) as zipped:
        seen = set()
        for info in zipped.infolist():
            name = info.filename
            parts = name.rstrip('/').split('/')
            normalized = name.rstrip('/').casefold()
            if (not name or '\\' in name or name.startswith('/') or normalized in seen
                    or any(p in ('', '.', '..') or p.endswith((' ', '.'))
                           or re.search(r'[<>:"|?*\x00-\x1f]', p)
                           or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?', p)
                           for p in parts)
                    or (info.external_attr >> 16) & 0o170000 == 0o120000):
                stop('unsafe/duplicate archive member')
            seen.add(normalized)
        zipped.extractall(destination)


def payload(directory, run, artifact, expected_sha=None, entry=None):
    try:
        p = json_value((directory / 'g3-provenance.json').read_bytes())
    except (OSError, ValueError) as error:
        stop(f'missing/invalid producer provenance: {error}', run, artifact['id'])
    required = {'schema': 1, 'run_id': run['id'], 'run_attempt': run['run_attempt'],
                'workflow_path': WORKFLOW, 'event': run['event']}
    if any(p.get(k) != v or type(p.get(k)) is not type(v) for k, v in required.items()):
        stop('producer run/attempt/workflow/event mismatch', run, artifact['id'])
    sha = p.get('candidate_sha', '')
    if not SHA.fullmatch(sha) or (expected_sha is not None and sha != expected_sha):
        stop('producer candidate SHA mismatch', run, artifact['id'])
    if p.get('repository') != run['repository']['full_name']:
        stop('producer repository mismatch', run, artifact['id'])
    if artifact['name'] != f'candidate-{sha}':
        stop('artifact name contradicts producer SHA', run, artifact['id'])
    started = instant(p.get('started_at'))
    if not instant(run['run_started_at']) <= started <= instant(artifact['created_at']):
        stop('producer started_at outside attempt/artifact interval', run, artifact['id'])
    if entry and p.get('tools_sha') != entry['tools_sha']:
        stop('producer tools SHA mismatch', run, artifact['id'])
    if run['event'] == 'workflow_dispatch':
        if p.get('tools_sha') != run['head_sha']:
            stop('producer dispatch tools SHA mismatch', run, artifact['id'])
        if entry and p.get('dispatch_nonce') != entry['nonce']:
            stop('producer dispatch nonce mismatch', run, artifact['id'])
    return p


def inspect_artifact(base, run, repo_id, query, fetch, out, expected_sha=None, entry=None):
    artifacts = listing(query, f'{base}/runs/{run["id"]}/artifacts?per_page=100', 'artifacts', repo_id, run)
    candidates = [a for a in artifacts if a.get('name', '').startswith('candidate-')]
    if len(candidates) != 1:
        stop('expected exactly one candidate artifact; missing/ambiguous upload', run)
    artifact = candidates[0]
    ident = artifact['id']
    if artifact.get('expired') is not False:
        stop('expired candidate artifact', run, ident)
    try:
        metadata, _ = query(f'{base}/artifacts/{ident}')
    except Exception as error:
        stop(f'artifact metadata unavailable: {error}', run, ident)
    if metadata != artifact:
        stop('artifact metadata differs from listing', run, ident)
    owner = artifact.get('workflow_run', {})
    if owner.get('id') != run['id'] or owner.get('head_sha') != run['head_sha']:
        stop('artifact run owner mismatch', run, ident)
    destination = out / f'run-{run["id"]}-attempt-{run["run_attempt"]}-artifact-{ident}'
    destination.mkdir()
    archive = destination.with_suffix('.zip')
    try:
        fetch(f'{base}/artifacts/{ident}/zip', archive)
    except Exception as error:
        stop(f'artifact download unavailable: {error}', run, ident)
    digest = 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest()
    if artifact.get('digest') and artifact['digest'] != digest:
        stop('downloaded archive digest mismatch', run, ident)
    unpack(archive, destination)
    provenance = payload(destination, run, artifact, expected_sha, entry)
    current, _ = query(f'{base}/runs/{run["id"]}')
    after, _ = query(f'{base}/artifacts/{ident}')
    if revision(current) != revision(run):
        stop('run changed during download', run, ident)
    if after != metadata:
        stop('artifact changed during download', run, ident)
    return {'run_id': run['id'], 'run_attempt': run['run_attempt'], 'artifact_id': ident,
            'digest': digest, 'advertised_digest': artifact.get('digest'), 'archive': str(archive),
            'destination': str(destination), 'provenance': provenance, 'metadata': metadata,
            'artifact_listing': artifacts}


def collect(record_path, out, query=gh_get, fetch=fetch_archive):
    """Return a verified provenance manifest; stage-exit still judges test results.

    A new output directory retains incomplete manifests and raw archives on STOP.
    The record is read again at the end, not accepted as a mutable caller dict.
    """
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    # legacy_excluded stays None (unknown, never "0 legacy") until a complete listing is classified.
    manifest = {'status': 'incomplete', 'scope': 'candidate', 'downloads': [], 'legacy_excluded': None,
                'legacy_listing': 'unlisted/incomplete: record, repository or workflow not confirmed'}
    context, audit = None, None

    def classify(population, runs):
        """Legacy rows by time only; their bytes are never read or admitted."""
        rows, excluded = [], set()
        for context in population:
            if context['id'] not in runs and legacy(context, record['cutoff']):
                excluded.add(context['id'])
                rows.append({key: context.get(key) for key in (
                    'id', 'created_at', 'run_started_at', 'run_attempt', 'event', 'status', 'conclusion')})
        manifest.update(legacy_excluded=rows, legacy_listing='complete')
        return excluded

    try:
        record, record_digest = read_record(record_path)
        manifest.update(record=record, record_sha256=record_digest, cutoff=record['cutoff'])
        cutoff = instant(record['cutoff']['timestamp'])
        if not record['requests']:
            stop('empty official population')
        pending = [e['nonce'] for e in record['requests'] if e['state'] != 'bound']
        if pending:
            stop(f'unresolved dispatch requests {pending}')
        repo, _ = query(f'repos/{record["repository"]}')
        repo_id = repo.get('id')
        if type(repo_id) is not int or repo_id <= 0 or repo.get('full_name') != record['repository']:
            stop('repository identity mismatch')
        base = f'repos/{record["repository"]}/actions'
        workflow, _ = query(f'{base}/workflows/candidate.yml')
        if workflow.get('path') != WORKFLOW or type(workflow.get('id')) is not int:
            stop('workflow identity mismatch')
        entries = {e['run_id']: e for e in record['requests']}
        endpoint = f'{base}/workflows/candidate.yml/runs?per_page=100'
        audit = (repo_id, set(entries))  # From here on a STOP manifest still lists legacy rows.
        runs, snapshots, attempts = {}, {}, {}
        # Recorded IDs are the only entry point for official evidence.
        for ident, entry in entries.items():
            context = {'id': ident}
            context, _ = query(f'{base}/runs/{ident}')
            check_run(context, repo_id, workflow['id'], entry)
            if instant(context['created_at']) < cutoff:
                stop('recorded run predates the legacy cutoff T0; legacy runs are never admitted', context)
            attempt, _ = query(f'{base}/runs/{ident}/attempts/{context["run_attempt"]}')
            instant(attempt.get('created_at'))
            if attempt_revision(attempt) != attempt_revision(context):
                stop('latest attempt endpoint contradicts run', context)
            runs[ident] = context
            attempts[ident] = attempt
        superseded = set()
        for ident, entry in entries.items():
            for prior in entry['supersedes']:
                old = runs[prior['run_id']]
                if old['run_attempt'] != prior['run_attempt']:
                    stop(f'superseded run retried; replacement={ident}', old)
                if old['status'] != 'completed':
                    stop(f'superseded run still active; replacement={ident}', old)
                if instant(runs[ident]['created_at']) <= instant(old['updated_at']):
                    stop(f'replacement {ident} does not follow retired attempt', old)
                superseded.add(old['id'])
        active = [run for ident, run in runs.items() if ident not in superseded]
        for context in active:
            if context['status'] != 'completed' or context['conclusion'] != 'success':
                stop('official run latest attempt is not completed/success', context)
            row = inspect_artifact(base, context, repo_id, query, fetch, out,
                                   record['candidate_sha'], entries[context['id']])
            # The existing runner's evidence and the new producer envelope must agree.
            p = json_value((Path(row['destination']) / 'candidate-provenance.json').read_bytes())
            if p.get('candidate_sha') != record['candidate_sha'] or p.get('tools_sha') != entries[context['id']]['tools_sha']:
                stop('candidate runner provenance contradicts envelope', context, row['artifact_id'])
            manifest['downloads'].append(row)
            snapshots[context['id']] = row
        population = listing(query, endpoint, 'workflow_runs', repo_id)
        manifest['observed_runs'] = population
        # All legacy rows are classified before any post-T0 inspection or recorded-run check.
        excluded = classify(population, runs)
        listed = {r['id']: r for r in population}
        for ident, run in runs.items():
            if ident not in listed or revision(listed[ident]) != revision(run):
                stop('recorded run absent/changed in supersession listing', run)
        for context in population:
            if context['id'] in runs or context['id'] in excluded:
                continue
            check_run(context, repo_id, workflow['id'])
            actual, _ = query(f'{base}/runs/{context["id"]}')
            if revision(actual) != revision(context):
                stop('unrecorded run changed since listing', context)
            attempt, _ = query(f'{base}/runs/{context["id"]}/attempts/{context["run_attempt"]}')
            instant(attempt.get('created_at'))
            if attempt_revision(attempt) != attempt_revision(context):
                stop('unrecorded attempt endpoint contradicts run', context)
            attempts[context['id']] = attempt
            # Title, head_sha and artifact name never establish candidate identity.
            row = inspect_artifact(base, context, repo_id, query, fetch, out)
            snapshots[context['id']] = row
            if row['provenance']['candidate_sha'] == record['candidate_sha']:
                stop('unrecorded same-candidate run; explicitly admit/reconcile supersession', context, row['artifact_id'])
        for context in population:
            if context['id'] in excluded:
                continue  # The final listing comparison below still covers legacy revisions.
            current, _ = query(f'{base}/runs/{context["id"]}')
            if revision(current) != revision(context):
                stop('run changed at final verification', context)
            attempt, _ = query(f'{base}/runs/{context["id"]}/attempts/{context["run_attempt"]}')
            if revision(attempt) != revision(attempts[context['id']]):
                stop('attempt changed at final verification', context)
            if context['id'] in snapshots:
                row = snapshots[context['id']]
                artifacts = listing(query, f'{base}/runs/{context["id"]}/artifacts?per_page=100', 'artifacts', repo_id, context)
                current_artifact, _ = query(f'{base}/artifacts/{row["artifact_id"]}')
                if artifacts != row['artifact_listing'] or current_artifact != row['metadata']:
                    stop('artifact replaced at final verification', context, row['artifact_id'])
        final = listing(query, endpoint, 'workflow_runs', repo_id)
        if sorted(map(revision, population), key=lambda r: r[0]) != sorted(map(revision, final), key=lambda r: r[0]):
            stop('supersession population changed during collection', context)
        if read_record(record_path)[1] != record_digest:
            stop('round record changed during collection', context)
        manifest.update(status='verified', verified_at=datetime.now(timezone.utc).isoformat(),
                        superseded_run_ids=sorted(superseded), attempts=attempts)
    except Exception as error:
        message = str(error)
        if not message.startswith('STOP '):
            message = f'STOP run_id={(context or {}).get("id", "unknown")} attempt={(context or {}).get("run_attempt", "unknown")}: {message}'
        manifest['error'] = message
        if audit is not None and manifest['legacy_listing'] != 'complete':
            # An earlier STOP (official failure, expiry, missing upload) still records which
            # rows were legacy; the original STOP reason above is kept unchanged.
            try:
                classify(listing(query, endpoint, 'workflow_runs', audit[0]), audit[1])
            except Exception as listing_error:
                manifest.update(legacy_excluded=None,
                                legacy_listing=f'unlisted/incomplete: {listing_error}')
        raise ValueError(message) from error
    finally:
        (out / 'g3-evidence.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--produce', type=Path, help='write hosted attempt provenance without API access')
    mode.add_argument('--record', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.produce:
        produce(args.produce, os.environ)
        return
    if args.out is None:
        parser.error('--record requires --out')
    result = collect(args.record, args.out)
    print(json.dumps({'status': result['status'], 'destinations': [r['destination'] for r in result['downloads']]}))


if __name__ == '__main__':
    main()
