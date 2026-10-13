"""Behaviour tests for the six G3 admission/evidence criteria (D73).

FakeGitHub uses real numeric /repositories/{id}/ Link paths and explicit attempt
endpoints. Producer tests execute the workflow's CLI argv with synthetic env;
they assert payload semantics, not source spelling or a private function name.
"""
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
import shlex
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit, urlencode
import zipfile

import ci_candidate_evidence as evidence

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('g3_dispatch', ROOT / 'scripts/g3_dispatch.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
SHA = 'a' * 40
TOOLS = 'b' * 40
OTHER = 'c' * 40
NONCE = 'd' * 32
REPO = 'owner/repo'
NOW = '2026-10-13T00:00:00+00:00'


def make_run(ident=10, attempt=1, sha=SHA, event='workflow_dispatch', status='completed', conclusion='success'):
    return {'id': ident, 'workflow_id': 30, 'repository': {'id': 20, 'full_name': REPO},
            'path': evidence.WORKFLOW, 'head_sha': TOOLS, 'event': event, 'head_branch': 'main',
            'display_title': f'candidate {sha} [g3:{NONCE}]', 'run_attempt': attempt,
            'status': status, 'conclusion': conclusion, 'created_at': NOW,
            'run_started_at': NOW, 'updated_at': '2026-10-13T00:02:00+00:00',
            'pull_requests': [{'number': 12}] if event == 'pull_request' else []}


def envelope(run, sha=SHA):
    return {'schema': 1, 'repository': REPO, 'run_id': run['id'], 'run_attempt': run['run_attempt'],
            'candidate_sha': sha, 'tools_sha': TOOLS, 'workflow_path': evidence.WORKFLOW,
            'workflow_ref': f'{REPO}/{evidence.WORKFLOW}@refs/heads/main', 'event': run['event'],
            'started_at': '2026-10-13T00:00:01+00:00', 'dispatch_nonce': NONCE}


def record(runs=(10,), pr=False):
    return {'schema': 1, 'repository': REPO, 'candidate_sha': SHA, 'round_id': 'fixture-r1',
            'workflow': evidence.WORKFLOW, 'revision': 1,
            'pr_policy': 'candidate-checkout-with-merge-tools' if pr else 'forbid',
            'partial_rerun_policy': 'whole-candidate-job', 'requests': [
                {'nonce': NONCE if i == 0 else f'{ident:032x}', 'requested_at': NOW,
                 'dispatch_ref': 'main', 'event': 'pull_request' if pr else 'workflow_dispatch',
                 'state': 'bound', 'run_id': ident, 'tools_sha': TOOLS, 'supersedes': []}
                for i, ident in enumerate(runs)]}


class FakeGitHub:
    def __init__(self):
        self.runs = {10: make_run()}
        self.artifacts = {}
        self.archives = {}
        self.calls = []
        self.fetched = []
        self.page_size = 1
        self.on_fetch = None
        self.on_query = None
        self.link_edit = None
        self.count_edit = None
        self.post_calls = 0
        self.post_status = 200
        self.add_artifact(10)

    def add_artifact(self, ident, sha=SHA, p=None, artifact_id=None, extra=None):
        run = self.runs[ident]
        artifact_id = artifact_id or ident * 100
        p = p or envelope(run, sha)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as zipped:
            zipped.writestr('g3-provenance.json', json.dumps(p))
            zipped.writestr('candidate-provenance.json', json.dumps({'candidate_sha': sha, 'tools_sha': TOOLS}))
            zipped.writestr('results.json', '{}')
            for name, value in (extra or {}).items():
                zipped.writestr(name, value)
        raw = stream.getvalue()
        self.archives[artifact_id] = raw
        artifact = {'id': artifact_id, 'name': f'candidate-{sha}', 'expired': False,
                    'created_at': '2026-10-13T00:01:00+00:00',
                    'workflow_run': {'id': ident, 'head_sha': run['head_sha']},
                    'digest': 'sha256:' + hashlib.sha256(raw).hexdigest()}
        self.artifacts[artifact_id] = artifact
        return artifact

    def query(self, endpoint):
        self.calls.append(endpoint)
        if self.on_query:
            self.on_query(endpoint)
        parsed = urlsplit(endpoint)
        path = parsed.path.removeprefix('/').replace('repositories/20', 'repos/' + REPO)
        tail = path.removeprefix('repos/' + REPO)
        if tail == '':
            result = {'id': 20, 'full_name': REPO}
        elif tail == '/actions/workflows/candidate.yml':
            result = {'id': 30, 'path': evidence.WORKFLOW}
        elif tail == '/pulls/12':
            result = {'head': {'sha': SHA}, 'merge_commit_sha': TOOLS}
        elif tail.endswith('/runs') or tail.endswith('/artifacts'):
            key = 'workflow_runs' if tail.endswith('/runs') else 'artifacts'
            if key == 'workflow_runs':
                rows = list(self.runs.values())
            else:
                ident = int(tail.split('/')[3])
                rows = [a for a in self.artifacts.values() if a['workflow_run']['id'] == ident]
            params = parse_qs(parsed.query)
            page = int(params.get('page', ['1'])[0])
            count = len(rows)
            if self.count_edit:
                count = self.count_edit(key, page, count)
            result = {'total_count': count, key: rows[(page-1)*self.page_size:page*self.page_size]}
            headers = {}
            if page * self.page_size < len(rows):
                query = urlencode({k: v[0] for k, v in params.items() if k != 'page'})
                link = f'https://api.github.com/repositories/20{tail}?{query}&page={page+1}'
                if self.link_edit:
                    link = self.link_edit(link)
                headers['Link'] = f'<{link}>; rel="next", <{link}>; rel="last"'
            return copy.deepcopy(result), headers
        elif tail.startswith('/actions/artifacts/'):
            result = self.artifacts[int(tail.split('/')[3])]
        elif tail.startswith('/actions/runs/'):
            result = self.runs[int(tail.split('/')[3])]
            if '/attempts/' in tail and int(tail.rsplit('/', 1)[1]) != result['run_attempt']:
                raise ValueError('404 attempt')
        else:
            raise AssertionError(endpoint)
        return copy.deepcopy(result), {}

    def fetch(self, endpoint, archive):
        ident = int(endpoint.split('/')[-2])
        self.fetched.append(ident)
        Path(archive).write_bytes(self.archives[ident])
        if self.on_fetch:
            self.on_fetch(ident)

    def post(self, endpoint, body):
        self.post_calls += 1
        ident = 11
        self.runs[ident] = make_run(ident)
        self.runs[ident]['display_title'] = f'candidate {body["inputs"]["candidate_sha"]} [g3:{body["inputs"]["dispatch_nonce"]}]'
        self.runs[ident]['head_branch'] = body['ref']
        return {'status': self.post_status, 'body': {'workflow_run_id': ident} if self.post_status == 200 else None}


class CandidateEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / 'round.json'
        self.github = FakeGitHub()
        self.rec = record()

    def collect(self):
        self.path.write_text(json.dumps(self.rec), encoding='utf-8')
        return evidence.collect(self.path, self.root / 'out', self.github.query, self.github.fetch)

    def refuse(self, reason, run_id=None):
        with self.assertRaisesRegex(ValueError, reason) as caught:
            self.collect()
        if run_id is not None:
            self.assertIn(f'run_id={run_id}', str(caught.exception))
        result = json.loads((self.root / 'out/g3-evidence.json').read_text())
        self.assertEqual(result['status'], 'incomplete')
        self.assertNotIn('verified_at', result)

    def test_normal_dispatch_binds_id_digest_and_payload_not_head_sha(self):
        result = self.collect()
        self.assertEqual(result['status'], 'verified')
        row = result['downloads'][0]
        self.assertEqual((row['run_id'], row['run_attempt'], row['artifact_id']), (10, 1, 1000))
        self.assertEqual(row['digest'], self.github.artifacts[1000]['digest'])
        self.assertEqual(self.github.fetched, [1000])
        self.assertLess(self.github.calls.index('repos/owner/repo/actions/runs/10'),
                        self.github.calls.index('repos/owner/repo/actions/workflows/candidate.yml/runs?per_page=100'))

    def test_successful_rerun_proves_current_attempt(self):
        self.github.runs[10]['run_attempt'] = 2
        self.github.add_artifact(10)
        self.assertEqual(self.collect()['downloads'][0]['run_attempt'], 2)

    def test_partial_rerun_with_old_job_upload_is_refused(self):
        self.github.runs[10]['run_attempt'] = 2
        self.refuse('producer run/attempt', 10)

    def test_pr_policy_accepts_candidate_checkout_with_merge_tools(self):
        self.rec = record(pr=True)
        self.github.runs[10] = make_run(event='pull_request')
        self.github.runs[10]['head_sha'] = SHA
        self.github.add_artifact(10)
        self.assertEqual(self.collect()['status'], 'verified')

    def test_pr_forbidden_without_recorded_policy(self):
        self.rec['requests'][0]['event'] = 'pull_request'
        self.refuse('PR run forbidden')

    def test_empty_population_cannot_discover_a_success(self):
        self.rec['requests'] = []
        self.refuse('empty official population')
        self.assertEqual(self.github.calls, [])

    def test_pending_request_invalidates_success(self):
        entry = copy.deepcopy(self.rec['requests'][0])
        entry.update(nonce='e'*32, state='dispatch_pending')
        entry.pop('run_id')
        self.rec['requests'].append(entry)
        self.refuse('unresolved dispatch')
        self.assertEqual(self.github.fetched, [])

    def test_recorded_wrong_workflow_is_refused(self):
        self.github.runs[10]['path'] = '.github/workflows/validate.yml'
        self.refuse('workflow/repository mismatch', 10)

    def test_recorded_wrong_repository_is_refused(self):
        self.github.runs[10]['repository']['id'] = 21
        self.refuse('workflow/repository mismatch', 10)

    def test_recorded_wrong_candidate_is_refused(self):
        self.github.add_artifact(10, OTHER)
        self.refuse('candidate SHA mismatch', 10)

    def test_legacy_pr_title_does_not_override_payload(self):
        self.github.runs[11] = make_run(11, event='pull_request')
        self.github.runs[11]['display_title'] = 'candidate ' + SHA
        self.github.add_artifact(11, OTHER)
        self.assertEqual(self.collect()['status'], 'verified')

    def test_unrecorded_same_candidate_ignores_misleading_title(self):
        self.github.runs[11] = make_run(11, event='pull_request')
        self.github.runs[11]['display_title'] = 'candidate ' + OTHER
        self.github.add_artifact(11)
        self.refuse('unrecorded same-candidate', 11)

    def test_unknown_legacy_no_upload_does_not_use_title_or_head(self):
        self.github.runs[11] = make_run(11, sha=OTHER, conclusion='failure')
        self.refuse('missing/ambiguous upload', 11)

    def test_multiple_artifacts_cannot_hide_old_attempt(self):
        self.github.add_artifact(10, artifact_id=1001)
        self.refuse('exactly one candidate artifact', 10)

    def test_expired_artifact(self):
        self.github.artifacts[1000]['expired'] = True
        self.refuse('expired candidate artifact', 10)

    def test_digest_mismatch(self):
        self.github.artifacts[1000]['digest'] = 'sha256:' + '0'*64
        self.refuse('archive digest mismatch', 10)

    def test_missing_advertised_digest_records_actual_digest(self):
        self.github.artifacts[1000].pop('digest')
        self.assertTrue(self.collect()['downloads'][0]['digest'].startswith('sha256:'))

    def test_wrong_artifact_owner(self):
        self.github.artifacts[1000]['workflow_run']['head_sha'] = OTHER
        self.refuse('artifact run owner mismatch', 10)

    def test_artifact_name_cannot_override_payload(self):
        self.github.artifacts[1000]['name'] = 'candidate-' + OTHER
        self.refuse('name contradicts producer SHA', 10)

    def test_producer_tools_sha_is_checked(self):
        p = envelope(self.github.runs[10]); p['tools_sha'] = OTHER
        self.github.add_artifact(10, p=p)
        self.refuse('producer tools SHA mismatch', 10)

    def test_producer_started_at_requires_attempt_interval(self):
        p = envelope(self.github.runs[10]); p['started_at'] = '2026-10-12T00:00:00Z'
        self.github.add_artifact(10, p=p)
        self.refuse('outside attempt/artifact interval', 10)

    def test_producer_nonce_is_checked(self):
        p = envelope(self.github.runs[10]); p['dispatch_nonce'] = 'f'*32
        self.github.add_artifact(10, p=p)
        self.refuse('dispatch nonce mismatch', 10)

    def test_run_replaced_during_download(self):
        self.github.on_fetch = lambda ident: self.github.runs[10].update(run_attempt=2, status='in_progress', conclusion=None)
        self.refuse('run changed during download', 10)

    def test_artifact_replaced_during_download(self):
        self.github.on_fetch = lambda ident: self.github.artifacts[ident].update(expired=True)
        self.refuse('artifact changed during download', 10)

    def test_new_artifact_added_after_download(self):
        self.github.on_fetch = lambda ident: self.github.add_artifact(10, artifact_id=1001)
        self.refuse('artifact replaced at final verification', 10)

    def test_record_changed_during_collection(self):
        def change(ident):
            self.rec['revision'] += 1
            self.path.write_text(json.dumps(self.rec), encoding='utf-8')
        self.github.on_fetch = change
        self.refuse('round record changed', 10)

    def test_count_cap_refuses_even_if_all_returned_rows_look_safe(self):
        self.github.count_edit = lambda key, page, n: 1000 if key == 'workflow_runs' else n
        self.refuse('search cap reached')

    def test_count_contradiction(self):
        self.github.count_edit = lambda key, page, n: n+1 if key == 'workflow_runs' else n
        self.refuse('incomplete listing')

    def test_explicit_replacement_retires_only_exact_terminal_attempt(self):
        self.github.runs[11] = make_run(11)
        self.github.runs[11].update(created_at='2026-10-13T00:03:00Z', run_started_at='2026-10-13T00:03:00Z', updated_at='2026-10-13T00:05:00Z')
        self.rec = record((10, 11))
        self.rec['requests'][1]['supersedes'] = [{'run_id': 10, 'run_attempt': 1}]
        self.github.runs[10]['conclusion'] = 'failure'
        p = envelope(self.github.runs[11]); p.update(started_at='2026-10-13T00:03:01Z', dispatch_nonce=f'{11:032x}')
        artifact = self.github.add_artifact(11, p=p)
        artifact['created_at'] = '2026-10-13T00:04:00Z'
        self.assertEqual(self.collect()['superseded_run_ids'], [10])

    def test_old_recorded_run_retry_invalidates_explicit_replacement(self):
        self.rec = record((10, 11))
        self.rec['requests'][1]['supersedes'] = [{'run_id': 10, 'run_attempt': 1}]
        self.github.runs[11] = make_run(11)
        self.github.runs[10].update(run_attempt=2, conclusion='failure')
        self.refuse('superseded run retried', 10)

    def test_archive_traversal_refused_before_extraction(self):
        self.github.add_artifact(10, extra={'../escape': 'bad'})
        self.refuse('unsafe/duplicate archive')
        self.assertFalse((self.root/'out/escape').exists())

    def alter_reply(self, predicate, change):
        original = self.github.query
        def query(endpoint):
            body, headers = original(endpoint)
            if predicate(endpoint):
                change(body)
            return body, headers
        self.github.query = query

    def test_latest_attempt_endpoint_must_agree(self):
        self.alter_reply(lambda e: '/attempts/' in e, lambda b: b.update(run_attempt=2))
        self.refuse('latest attempt endpoint contradicts run', 10)

    def test_run_and_attempt_creation_clocks_may_differ(self):
        self.alter_reply(lambda e: '/attempts/' in e, lambda b: b.update(created_at='2026-10-13T00:00:01Z'))
        self.assertEqual(self.collect()['attempts'][10]['created_at'], '2026-10-13T00:00:01Z')

    def test_artifact_metadata_must_agree_with_listing(self):
        self.alter_reply(lambda e: e.endswith('/artifacts/1000'), lambda b: b.update(created_at=NOW))
        self.refuse('artifact metadata differs from listing', 10)

    def test_run_listing_must_agree_with_direct_get(self):
        self.alter_reply(lambda e: '/workflows/candidate.yml/runs?' in e,
                         lambda b: b['workflow_runs'][0].update(updated_at=NOW))
        self.refuse('recorded run absent/changed in supersession listing', 10)

    def test_recorded_event_mismatch(self):
        self.github.runs[10]['event'] = 'pull_request'
        self.refuse('recorded run id/event mismatch', 10)

    def test_unsupported_event(self):
        self.github.runs[10]['event'] = 'schedule'
        self.refuse('unsupported run event', 10)

    def test_timestamp_without_timezone(self):
        self.github.runs[10]['run_started_at'] = '2026-10-13T00:00:00'
        self.refuse('invalid timestamp', 10)

    def test_new_run_at_final_population_recheck(self):
        seen = 0
        def add(endpoint):
            nonlocal seen
            if endpoint == 'repos/owner/repo/actions/workflows/candidate.yml/runs?per_page=100':
                seen += 1
                if seen == 2:
                    self.github.runs[11] = make_run(11, status='queued', conclusion=None)
        self.github.on_query = add
        self.refuse('supersession population changed')

    def test_earlier_run_changes_while_other_candidate_downloads(self):
        self.github.runs[11] = make_run(11)
        self.github.add_artifact(11, OTHER)
        def change(ident):
            if ident == 1100:
                self.github.runs[10].update(run_attempt=2, status='queued', conclusion=None)
        self.github.on_fetch = change
        self.refuse('run changed at final verification', 10)

    def test_final_attempt_endpoint_changed(self):
        seen = 0
        original = self.github.query
        def query(endpoint):
            nonlocal seen
            body, headers = original(endpoint)
            if endpoint.endswith('/attempts/1'):
                seen += 1
                if seen == 2:
                    body['run_attempt'] = 2
            return body, headers
        self.github.query = query
        self.refuse('attempt changed at final verification', 10)

    def test_missing_provenance_is_stop(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as zipped:
            zipped.writestr('results.json', '{}')
        self.github.archives[1000] = stream.getvalue()
        self.github.artifacts[1000]['digest'] = 'sha256:' + hashlib.sha256(stream.getvalue()).hexdigest()
        self.refuse('missing/invalid producer provenance', 10)

    def test_other_candidate_retry_is_not_a_supersession(self):
        self.github.runs[11] = make_run(11, attempt=3, conclusion='failure')
        self.github.add_artifact(11, OTHER)
        self.assertEqual(self.collect()['status'], 'verified')

    def test_missing_recorded_id_is_not_replaced_from_listing(self):
        self.github.runs[11] = self.github.runs.pop(10)
        self.github.runs[11]['id'] = 11
        self.refuse('STOP run_id=10', 10)
        self.assertEqual(self.github.fetched, [])

    def test_duplicate_recorded_id_is_stop_before_io(self):
        duplicate = dict(self.rec['requests'][0], nonce='f'*32)
        self.rec['requests'].append(duplicate)
        self.refuse('duplicate recorded run id')
        self.assertEqual(self.github.calls, [])

    def test_reader_rejects_schema_drift(self):
        self.rec['discover_latest'] = True
        self.refuse('schema fields missing/unknown')

    def test_reader_rejects_supersession_schema_drift(self):
        self.rec = record((10, 11))
        self.rec['requests'][1]['supersedes'] = [{'run_id': 10, 'run_attempt': 1, 'ignore_failures': True}]
        self.refuse('replacement must name an earlier recorded run and exact attempt')

    def test_replacement_cannot_retire_a_still_running_attempt(self):
        self.rec = record((10, 11))
        self.rec['requests'][1]['supersedes'] = [{'run_id': 10, 'run_attempt': 1}]
        self.github.runs[11] = make_run(11)
        self.github.runs[10].update(status='in_progress', conclusion=None)
        self.refuse('superseded run still active', 10)

    def test_replacement_must_follow_old_attempt_completion(self):
        self.rec = record((10, 11))
        self.rec['requests'][1]['supersedes'] = [{'run_id': 10, 'run_attempt': 1}]
        self.github.runs[11] = make_run(11)
        self.refuse('does not follow retired attempt', 10)


def refusal_case(status, conclusion, recorded, rerun=False):
    def test(self):
        ident = 9 if rerun else 11
        self.github.runs[ident] = make_run(ident, attempt=2 if rerun else 1, status=status, conclusion=conclusion)
        if recorded:
            self.rec = record((10, ident))
            self.refuse('not completed/success' if conclusion != 'success' else 'missing/ambiguous upload', ident)
        else:
            self.refuse('missing/ambiguous upload', ident)
    return test


for label, status, conclusion in [('failed', 'completed', 'failure'), ('cancelled', 'completed', 'cancelled'),
                                  ('queued', 'queued', None), ('in_progress', 'in_progress', None),
                                  ('no_upload', 'completed', 'success')]:
    for registered in (True, False):
        for rerun in (True, False):
            setattr(CandidateEvidenceTests, f'test_{label}_{"recorded" if registered else "unrecorded"}_{"old_run_retry" if rerun else "later_run"}',
                    refusal_case(status, conclusion, registered, rerun))


class PaginationTests(unittest.TestCase):
    def setUp(self):
        self.github = FakeGitHub()
        self.github.runs[11] = make_run(11)
        self.endpoint = 'repos/owner/repo/actions/workflows/candidate.yml/runs?per_page=100'

    def test_real_link_forms_complete(self):
        result = evidence.listing(self.github.query, self.endpoint, 'workflow_runs', 20)
        self.assertEqual([r['id'] for r in result], [10, 11])
        self.assertTrue(any('/repositories/20/' in c for c in self.github.calls))

    def test_artifact_listing_has_no_workflow_cap(self):
        self.github.page_size = 100
        for i in range(1001):
            self.github.artifacts[i+2000] = dict(self.github.artifacts[1000], id=i+2000)
        rows = evidence.listing(self.github.query, 'repos/owner/repo/actions/runs/10/artifacts?per_page=100', 'artifacts', 20)
        self.assertEqual(len(rows), 1002)

    def test_count_change(self):
        self.github.count_edit = lambda key, page, n: n if page == 1 else n+1
        with self.assertRaisesRegex(ValueError, 'count changed'):
            evidence.listing(self.github.query, self.endpoint, 'workflow_runs', 20)

    def test_foreign_host(self):
        self.github.link_edit = lambda link: link.replace('api.github.com', 'evil.example')
        with self.assertRaisesRegex(ValueError, 'foreign host'):
            evidence.listing(self.github.query, self.endpoint, 'workflow_runs', 20)

    def test_foreign_repository(self):
        self.github.link_edit = lambda link: link.replace('/20/', '/21/')
        with self.assertRaisesRegex(ValueError, 'foreign repository'):
            evidence.listing(self.github.query, self.endpoint, 'workflow_runs', 20)

    def test_changed_query(self):
        self.github.link_edit = lambda link: link.replace('per_page=100', 'per_page=99')
        with self.assertRaisesRegex(ValueError, 'changed query'):
            evidence.listing(self.github.query, self.endpoint, 'workflow_runs', 20)

    def test_link_cycle(self):
        def query(endpoint):
            body = {'total_count': 3, 'workflow_runs': [{'id': len(self.github.calls)+1}]}
            self.github.calls.append(endpoint)
            return body, {'Link': '<https://api.github.com/repositories/20/actions/workflows/candidate.yml/runs?per_page=100&page=2>; rel="next"'}
        with self.assertRaisesRegex(ValueError, 'Link cycle'):
            evidence.listing(query, self.endpoint, 'workflow_runs', 20)


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'round.json'
        self.github = FakeGitHub()

    def start(self, **kwargs):
        return dispatch.dispatch(self.path, REPO, SHA, 'fixture-r1', 'main', query=self.github.query,
                                 post=self.github.post, sleep=lambda seconds: None,
                                 now=datetime.fromisoformat(NOW), **kwargs)

    def test_response_id_written_after_durable_pending(self):
        post = self.github.post
        def checking(endpoint, body):
            pending, _ = evidence.read_record(self.path)
            self.assertEqual(pending['requests'][0]['state'], 'dispatch_pending')
            self.assertEqual(pending['requests'][0].get('request'), body)
            self.assertTrue(body['return_run_details'])
            return post(endpoint, body)
        self.github.post = checking
        self.assertEqual(self.start(), 11)
        result, _ = evidence.read_record(self.path)
        self.assertEqual(result['requests'][0]['run_id'], 11)
        self.assertEqual(result['requests'][0]['tools_sha'], TOOLS)
        self.assertEqual(self.github.post_calls, 1)

    def test_empty_response_recovers_unique_nonce_through_real_links(self):
        self.github.post_status = 204
        self.assertEqual(self.start(), 11)
        self.assertEqual(self.github.post_calls, 1)

    def test_response_loss_keeps_pending_and_never_redispatches(self):
        post = self.github.post
        def losing(endpoint, body):
            post(endpoint, body)
            raise ValueError('response lost')
        self.github.post = losing
        with self.assertRaisesRegex(ValueError, 'response lost'):
            self.start()
        with self.assertRaisesRegex(ValueError, 'unresolved prior request'):
            self.start()
        self.assertEqual(dispatch.dispatch(self.path, resume=True, query=self.github.query, sleep=lambda seconds: None), 11)
        self.assertEqual(self.github.post_calls, 1)

    def test_ambiguous_nonce_stops(self):
        post = self.github.post
        self.github.post_status = 204
        def duplicate(endpoint, body):
            response = post(endpoint, body)
            self.github.runs[12] = dict(self.github.runs[11], id=12)
            return response
        self.github.post = duplicate
        with self.assertRaisesRegex(ValueError, 'ambiguous dispatch nonce'):
            self.start()

    def test_pending_timeout_is_bounded(self):
        self.github.post = lambda endpoint, body: {'status': 204, 'body': None}
        with self.assertRaisesRegex(ValueError, 'bounded poll'):
            self.start()
        self.assertEqual(evidence.read_record(self.path)[0]['requests'][0]['state'], 'dispatch_pending')
        self.assertLess(len(self.github.calls), 30)

    def test_wrong_response_run_cannot_be_bound(self):
        self.github.post = lambda endpoint, body: {'status': 200, 'body': {'workflow_run_id': 10}}
        with self.assertRaisesRegex(ValueError, 'nonce/event/timestamp mismatch'):
            self.start()

    def test_lock_prevents_competing_writers_before_post(self):
        self.path.with_name('round.json.lock').write_text('fixture')
        with self.assertRaises(FileExistsError):
            self.start()
        self.assertEqual(self.github.post_calls, 0)

    def test_initialize_and_admit_pr_with_merge_tools(self):
        dispatch.initialize(self.path, REPO, SHA, 'fixture-r1', 'candidate-checkout-with-merge-tools')
        self.github.runs[10] = make_run(event='pull_request')
        self.github.add_artifact(10)
        dispatch.admit(self.path, 10, self.path.parent/'admission', query=self.github.query, fetch=self.github.fetch)
        result, _ = evidence.read_record(self.path)
        self.assertEqual(result['requests'][0]['event'], 'pull_request')
        self.assertEqual(result['requests'][0]['tools_sha'], TOOLS)
        self.assertEqual(self.github.post_calls, 0)


class ProducerTests(unittest.TestCase):
    def test_workflow_producer_payload_and_rerun_overwrite(self):
        import yaml
        doc = yaml.safe_load((ROOT/'.github/workflows/candidate.yml').read_text(encoding='utf-8'))
        job = doc['jobs']['candidate']
        upload = next(s for s in job['steps'] if str(s.get('uses', '')).startswith('actions/upload-artifact@'))
        self.assertTrue(upload['with']['overwrite'])
        self.assertEqual(upload['with']['name'], 'candidate-${{ env.CANDIDATE_SHA }}')
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, GITHUB_REPOSITORY=REPO, GITHUB_RUN_ID='10', GITHUB_RUN_ATTEMPT='3',
                       CANDIDATE_SHA=SHA, GITHUB_SHA=TOOLS, GITHUB_WORKFLOW_REF=REPO+'/'+evidence.WORKFLOW+'@refs/heads/main',
                       GITHUB_EVENT_NAME='workflow_dispatch', G3_STARTED_AT=NOW, DISPATCH_NONCE=NONCE)
            tool = Path(tmp)/'tools/tests/ci_candidate_evidence.py'
            tool.parent.mkdir(parents=True)
            shutil.copyfile(ROOT/'tests/ci_candidate_evidence.py', tool)
            # --produce is the producer CLI contract; execute the workflow's actual argv.
            commands = [(s, shlex.split(s['run'])) for s in job['steps'] if 'run' in s]
            for step, argv in commands:
                if '--produce' in argv:
                    self.assertEqual(step.get('if'), 'always()')
                    self.assertLess(job['steps'].index(step), job['steps'].index(upload))
                    subprocess.run([sys.executable, *argv[1:]], cwd=tmp, env=env, check=True)
            p = json.loads((Path(tmp)/'target/tests/e2e/artifacts/candidate-ci/g3-provenance.json').read_text())
            self.assertEqual({key: p[key] for key in ('run_id', 'run_attempt', 'candidate_sha', 'workflow_path', 'started_at')},
                             {'run_id': 10, 'run_attempt': 3, 'candidate_sha': SHA, 'workflow_path': evidence.WORKFLOW, 'started_at': NOW})
            self.assertEqual(p['tools_sha'], TOOLS)
            self.assertEqual(p['dispatch_nonce'], NONCE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
