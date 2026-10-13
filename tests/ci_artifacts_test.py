"""REQ-W2C-04 -> RISK-CI-EVIDENCE-OMISSION -> owner/download behaviour.

The real YAML upload declarations are the contract. Synthetic relocations and
duplicate artifact names prove collection never borrows another workflow's run.
The fake answers paged workflow/run/artifact REST requests and ID downloads.
It deliberately returns foreign SHA rows too, so the collector must fail closed
on contradictory filtered responses. G3 requests must stop before any lookup.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from urllib.parse import parse_qs, urlsplit

import yaml
from ci_artifacts import CANDIDATE, ROOT, download, inventory, listing, gh_get
from ci_workflows import WorkflowCatalog

SHA = 'a' * 40
MAIN_TIP = 'f' * 40


def real_name(template):
    return template.replace('${{ env.CANDIDATE_SHA }}', SHA)


class FakeGitHub:
    def __init__(self, uploads):
        self.runs, self.urls = [], []
        self.page_size = 100
        for index, (file, jobs) in enumerate(uploads.items()):
            names = [real_name(a) for artifacts in jobs.values() for a in artifacts]
            self.add(file, names, run_id=index + 10,
                     event='pull_request' if file == 'candidate.yml' else 'push')

    def add(self, file, names, run_id, head_sha=SHA, created_at='2026-10-12T00:00:00Z', event='push',
            status='completed', conclusion='success', expired=False, path=None, title=None):
        # GitHub's default titles: the workflow name, or the pull request title.
        title = title or ('Some pull request' if event == 'pull_request' else 'Workflow ' + file)
        run = {'id': run_id, 'head_sha': head_sha, 'path': path or '.github/workflows/' + file,
               'listed_under': file, 'created_at': created_at, 'run_attempt': 1, 'event': event,
               'status': status, 'conclusion': conclusion, 'display_title': title,
               'updated_at': '2026-10-12T12:00:00Z',
               'artifacts': [{'id': run_id * 100 + i, 'name': name, 'expired': expired,
                              'workflow_run': {'id': run_id, 'head_sha': head_sha}}
                             for i, name in enumerate(names)]}
        self.runs.append(run)
        return run

    def run(self, file):
        return next(run for run in self.runs if run['listed_under'] == file)

    @staticmethod
    def public(run):
        return {key: value for key, value in run.items() if key not in ('artifacts', 'listed_under')}

    def __call__(self, endpoint):
        url = urlsplit(endpoint)
        self.urls.append(endpoint)
        params = parse_qs(url.query)
        listing = re.search(r'/actions/workflows/([^/]+)/runs$', url.path)
        if listing:
            rows = [self.public(run) for run in self.runs if run['listed_under'] == listing.group(1)]
            key = 'workflow_runs'
        else:
            artifact = re.search(r'/artifacts/(\d+)$', url.path)
            if artifact:
                return copy.deepcopy(next(a for r in self.runs for a in r['artifacts']
                                          if a['id'] == int(artifact[1]))), {}
            one = re.search(r'/actions/runs/(\d+)(/artifacts)?$', url.path)
            run = next(run for run in self.runs if run['id'] == int(one.group(1)))
            if not one.group(2):
                return copy.deepcopy(self.public(run)), {}
            rows, key = run['artifacts'], 'artifacts'
        page = int(params.get('page', ['1'])[0])
        start = (page - 1) * self.page_size
        headers = {}
        if start + self.page_size < len(rows):
            base = endpoint.split('&page=')[0]
            if not base.startswith('https:'):
                base = 'https://api.github.com/' + base
            headers['Link'] = f'<{base}&page={page + 1}>; rel="next"'
        return copy.deepcopy({'total_count': len(rows), key: rows[start:start + self.page_size]}), headers


class ArtifactTests(unittest.TestCase):
    def test_documented_inventory_lists_every_upload_and_only_its_owners(self):
        doc = (ROOT / 'tests/stage-exit.md').read_text(encoding='utf-8')
        command = 'python -B tests/ci_artifacts.py --list'
        self.assertIn(command, doc)
        listed = json.loads(subprocess.check_output([sys.executable, '-B', 'tests/ci_artifacts.py', '--list'], cwd=ROOT))
        expected = []
        for workflow in sorted((ROOT / '.github/workflows').glob('*.y*ml')):
            parsed = yaml.safe_load(workflow.read_text(encoding='utf-8'))
            for job_id, job in parsed['jobs'].items():
                for step in job.get('steps', []):
                    if step.get('uses', '').startswith('actions/upload-artifact@'):
                        expected.append({'workflow': workflow.relative_to(ROOT).as_posix(), 'job': job_id,
                                         'artifact': step.get('with', {}).get('name', 'artifact')})
        self.assertCountEqual(listed, expected)

    def test_procedure_takes_hosted_artifacts_only_through_the_collector(self):
        # A direct download picks one run by hand and can skip an owning workflow,
        # whatever variable or flag spelling it uses.
        doc = (ROOT / 'tests/stage-exit.md').read_text(encoding='utf-8')
        self.assertIn('CI-TOOLING-1b', doc)
        for command in re.finditer(r'\bgh\s+run\s+download\b[^\r\n]*', doc, re.IGNORECASE):
            self.assertRegex(command[0], r'-n "candidate-\$sha"')
            self.assertIn('$candidateRun', command[0])
        self.assertIsNone(re.search(r'/artifacts/[^\s/]+/zip\b', doc))
        blocks = re.findall(r'```powershell\n(.*?)```', doc, re.DOTALL)
        collecting = [block for block in blocks if re.search(r'tests/ci_artifacts\.py --sha \$sha --stage [78]\b', block)]
        self.assertEqual(len(collecting), 2)
        for block in collecting:
            self.assertIn('--non-candidate', block)

    def fixture(self, folder, omit=()):
        root = Path(folder)
        workflows = root / '.github/workflows'
        workflows.mkdir(parents=True)
        uploads = {
            'validate.yml': {'runtime': ['synthetic-runtime-record-runs'],
                             'measurements': ['synthetic-workspace-dom-results'],
                             'context-loss': ['synthetic-context-loss']},
            'renamed-volume.yml': {'volume-rendering': ['synthetic-volume-rendering-results']},
            'worklist-ux.yml': {'worklist-ux-runtime': ['synthetic-runtime-record-runs'],
                                'worklist-ux-measurements': ['synthetic-workspace-dom-results']},
            'candidate.yml': {'candidate': [CANDIDATE]},
        }
        for file, jobs in uploads.items():
            value = {'jobs': {name: {'steps': [{'uses': 'actions/upload-artifact@pin', 'with': {'name': artifact}}
                                              for artifact in artifacts]}
                              for name, artifacts in jobs.items() if name not in omit}}
            (workflows / file).write_text(yaml.safe_dump(value), encoding='utf-8')
        return root, uploads

    def collect(self, root, github, stage='8', fetch=None, dry_run=False):
        calls = []
        def archive(endpoint, path):
            ident = int(endpoint.split('/')[-2])
            run, item = next((r, a) for r in github.runs for a in r['artifacts'] if a['id'] == ident)
            # Keep the existing owner assertions, but observe the actual ID endpoint.
            calls.append(['gh', 'api', endpoint, str(run['id']), '-n', item['name'], '-D', str(path.with_suffix(''))])
            if fetch:
                fetch(endpoint, path)
            else:
                with zipfile.ZipFile(path, 'w') as zipped:
                    zipped.writestr('evidence.txt', endpoint)
        try:
            return download(root, SHA, stage, root / 'out', github, archive,
                            non_candidate=True, dry_run=dry_run, repository='o/r'), calls
        finally:
            self.calls = calls

    def refused(self, root, github):
        with self.assertRaises(ValueError):
            self.collect(root, github)
        self.assertEqual(json.loads((root / 'out/artifact-downloads.json').read_text())['status'], 'incomplete')
        return self.calls

    def test_relocated_and_same_name_artifacts_download_from_each_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            github = FakeGitHub(uploads)
            result, calls = self.collect(root, github)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(len(calls), 6)
            self.assertEqual(result['scope'], 'non-candidate')
            self.assertFalse(any('candidate.yml' in url for url in github.urls))
            for row, call in zip(result['downloads'], calls):
                self.assertEqual(call[2], f'repos/o/r/actions/artifacts/{row["artifact_id"]}/zip')
                self.assertEqual(row['attempt'], 1)
                self.assertEqual((Path(row['destination']) / 'evidence.txt').read_text(), call[2])
                self.assertEqual(row['digest'], 'sha256:' + hashlib.sha256(Path(row['archive']).read_bytes()).hexdigest())
            for call in calls:
                run_id, name, destination = int(call[3]), call[5], Path(call[7])
                owner = next(run['listed_under'] for run in github.runs if run['id'] == run_id)
                self.assertIn(name, [real_name(a) for names in uploads[owner].values() for a in names])
                self.assertIn(Path(owner).stem, destination.parts)
            for name in ('synthetic-runtime-record-runs', 'synthetic-workspace-dom-results'):
                rows = [call for call in calls if call[5] == name]
                self.assertEqual(len({call[3] for call in rows}), 2)
                self.assertEqual(len({call[7] for call in rows}), 2)
            self.assertEqual(len([row for row in inventory(root) if row['artifact'] == 'synthetic-runtime-record-runs']), 2)

    def test_wrong_sha_owner_failed_pending_missing_or_expired_never_substitute(self):
        for defect in ('wrong-sha', 'wrong-owner', 'failed', 'pending', 'missing', 'expired'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                run = github.run('renamed-volume.yml')
                if defect == 'wrong-sha':
                    run['head_sha'] = 'b' * 40
                elif defect == 'wrong-owner':
                    run['path'] = '.github/workflows/validate.yml'
                elif defect == 'failed':
                    run['conclusion'] = 'failure'
                elif defect == 'pending':
                    run['status'] = 'in_progress'  # a stale conclusion alone must not admit it
                elif defect == 'missing':
                    run['artifacts'] = []
                else:
                    for item in run['artifacts']:
                        item['expired'] = True
                calls = self.refused(root, github)
                self.assertFalse(any(call[5] == 'synthetic-volume-rendering-results' for call in calls))

    def test_latest_run_decides_and_an_older_success_never_substitutes(self):
        older, newer = '2026-10-12T00:00:00Z', '2026-10-12T01:00:00Z'
        # Same creation second: the higher run id is the later run. Otherwise the creation
        # time decides, even when the later run carries the lower id (5 < the first run's 11).
        for latest, created, run_id in (('failure', newer, 90), ('success', newer, 90), ('failure', older, 90),
                                        ('success', older, 90), ('failure', newer, 5), ('success', newer, 5)):
            with self.subTest(latest=latest, created=created, run_id=run_id), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                first = github.run('renamed-volume.yml')
                first['conclusion'] = 'success' if latest == 'failure' else 'failure'
                second = github.add('renamed-volume.yml', ['synthetic-volume-rendering-results'], run_id=run_id,
                                    created_at=created, conclusion=latest)
                first['created_at'] = older
                if latest == 'failure':
                    calls = self.refused(root, github)
                    self.assertFalse(any(call[5] == 'synthetic-volume-rendering-results' for call in calls))
                else:
                    result, calls = self.collect(root, github)
                    used = [call[3] for call in calls if call[5] == 'synthetic-volume-rendering-results']
                    self.assertEqual(used, [str(second['id'])])
                    self.assertIn(second['id'], [run['id'] for run in result['runs']])

    def test_two_available_artifacts_with_one_name_in_a_run_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            github = FakeGitHub(uploads)
            run = github.run('renamed-volume.yml')
            run['artifacts'].append(dict(run['artifacts'][0], id=run['artifacts'][0]['id'] + 50))
            calls = self.refused(root, github)
            self.assertFalse(any(call[5] == 'synthetic-volume-rendering-results' for call in calls))

    def test_required_artifact_without_upload_declaration_is_refused_before_any_query(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _ = self.fixture(folder, omit=('context-loss',))
            github = FakeGitHub({})
            with self.assertRaisesRegex(ValueError, 'synthetic-context-loss'):
                self.collect(root, github)
            self.assertEqual(github.urls, [])
            self.assertEqual(self.calls, [])
            self.assertFalse((root / 'out').exists())
            # Stage 7 does not require that artifact, so the same tree is collectable there.
            result, _ = self.collect(root, FakeGitHub({
                'validate.yml': {'runtime': ['synthetic-runtime-record-runs'],
                                 'measurements': ['synthetic-workspace-dom-results']},
                'worklist-ux.yml': {'r': ['synthetic-runtime-record-runs'], 'm': ['synthetic-workspace-dom-results']},
                'candidate.yml': {'candidate': [CANDIDATE]}}), stage='7')
            self.assertEqual(result['status'], 'completed')


    def test_g3_resolution_refuses_all_prior_attribution_scenarios_before_io(self):
        cases = [dict(event='pull_request'), dict(event='workflow_dispatch', head_sha=MAIN_TIP),
                 dict(conclusion='failure'), dict(status='in_progress'), dict(expired=True),
                 dict(title='candidate ' + 'b' * 40), dict(path='.github/workflows/foreign.yml')]
        for values in cases:
            with self.subTest(values=values), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                github.add('candidate.yml', [], 99, **values)
                calls = []
                with self.assertRaisesRegex(ValueError, 'STOP.*CI-TOOLING-1b'):
                    download(root, SHA, '8', root / 'out', github, calls.append)
                self.assertEqual(github.urls, [])
                self.assertEqual(calls, [])
                self.assertFalse((root / 'out').exists())

    def test_candidate_owner_cannot_be_collected_in_non_candidate_scope(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            p = root / '.github/workflows/candidate.yml'
            doc = yaml.safe_load(p.read_text())
            doc['jobs']['candidate']['steps'][0]['with']['name'] = 'synthetic-runtime-record-runs'
            p.write_text(yaml.safe_dump(doc))
            github = FakeGitHub(uploads)
            with self.assertRaisesRegex(ValueError, 'STOP.*CI-TOOLING-1b'):
                self.collect(root, github)
            self.assertEqual(github.urls, [])

    def test_old_or_ambiguous_attempt_artifacts_and_older_run_reruns_refuse(self):
        for outcome in ('success', 'failure', 'cancelled', 'in_progress', 'queued'):
            for artifacts in ('old-only', 'old-and-new', 'none'):
                with self.subTest(outcome=outcome, artifacts=artifacts), tempfile.TemporaryDirectory() as folder:
                    root, uploads = self.fixture(folder)
                    github = FakeGitHub(uploads)
                    run = github.run('renamed-volume.yml')
                    run.update(run_attempt=2, created_at='2026-10-11T00:00:00Z',
                               run_started_at='2026-10-13T00:00:00Z', conclusion=outcome)
                    if artifacts == 'none':
                        run['artifacts'] = []
                    if artifacts == 'old-and-new':
                        run['artifacts'].append(dict(run['artifacts'][0], id=999))
                    github.add('renamed-volume.yml', ['synthetic-volume-rendering-results'], 90)
                    with self.assertRaisesRegex(ValueError, 'STOP.*attempt=2'):
                        self.collect(root, github)
                    self.assertEqual(self.calls, [])
                    self.assertEqual(json.loads((root / 'out/artifact-downloads.json').read_text())['status'], 'incomplete')

    def test_rerun_or_revision_change_during_download_refuses(self):
        for field, value in (('run_attempt', 2), ('updated_at', '2026-10-13T00:00:00Z'), ('status', 'in_progress')):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                def racing(endpoint, path):
                    with zipfile.ZipFile(path, 'w') as z:
                        z.writestr('evidence', 'synthetic')
                    github.run('renamed-volume.yml')[field] = value
                with self.assertRaisesRegex(ValueError, 'STOP.*artifact_id=1100'):
                    self.collect(root, github, fetch=racing)
                self.assertEqual(json.loads((root / 'out/artifact-downloads.json').read_text())['status'], 'incomplete')

    def test_final_recheck_detects_earlier_owner_change_and_new_run(self):
        for change in ('rerun', 'new-run'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                calls = []
                def racing(endpoint, path):
                    calls.append(endpoint)
                    with zipfile.ZipFile(path, 'w') as z:
                        z.writestr('evidence', 'synthetic')
                    if len(calls) == 6:
                        if change == 'rerun':
                            github.run('renamed-volume.yml')['run_attempt'] = 2
                        else:
                            github.add('renamed-volume.yml', [], 900, created_at='2026-10-13T00:00:00Z', conclusion='failure')
                with self.assertRaisesRegex(ValueError, 'STOP'):
                    self.collect(root, github, fetch=racing)

    def test_checked_id_is_used_when_same_name_is_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            github = FakeGitHub(uploads)
            checked = github.run('renamed-volume.yml')['artifacts'][0]['id']
            def replaced(endpoint, path):
                self.assertEqual(endpoint, f'repos/o/r/actions/artifacts/{checked}/zip')
                github.run('renamed-volume.yml')['artifacts'][0]['id'] = 99999
                raise FileNotFoundError('checked artifact deleted')
            with self.assertRaisesRegex(ValueError, f'STOP.*artifact_id={checked}'):
                self.collect(root, github, fetch=replaced)

    def test_digest_invalid_zip_and_unsafe_members_refuse(self):
        for defect in ('digest', 'zip', 'traversal'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                fetch = None
                if defect == 'digest':
                    github.run('renamed-volume.yml')['artifacts'][0]['digest'] = 'sha256:' + '0' * 64
                elif defect == 'zip':
                    fetch = lambda endpoint, path: path.write_bytes(b'not zip')
                else:
                    def fetch(endpoint, path):
                        with zipfile.ZipFile(path, 'w') as z:
                            z.writestr('../outside', 'bad')
                with self.assertRaisesRegex(ValueError, 'STOP'):
                    self.collect(root, github, fetch=fetch)

    def test_link_pagination_reaches_last_page_for_runs_and_artifacts(self):
        for failed in (False, True):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                github.page_size = 1
                github.add('renamed-volume.yml', ['synthetic-volume-rendering-results'], 90,
                           created_at='2026-10-13T00:00:00Z', conclusion='failure' if failed else 'success')
                if failed:
                    self.refused(root, github)
                    self.assertEqual(self.calls, [])
                else:
                    result, _ = self.collect(root, github)
                    self.assertEqual(len(result['downloads']), 6)
                    self.assertTrue(any('/artifacts?' in u and 'page=3' in u for u in github.urls))
                self.assertTrue(any('/runs?' in u and 'page=2' in u for u in github.urls))

    def test_cap_count_contradiction_and_duplicate_rows_stop(self):
        endpoint = 'repos/o/r/actions/workflows/w.yml/runs?head_sha=' + SHA + '&per_page=100'
        cases = [({'total_count': n, 'workflow_runs': [{'id': 1}]}, {}) for n in (0, 2, 1000, 1002, '2500+', None)]
        # A capped count can equal the visible row count. Equality alone is not completeness.
        cases.append(({'total_count': 1000, 'workflow_runs': [{'id': i + 1} for i in range(1000)]}, {}))
        cases += [({'total_count': 2, 'workflow_runs': [{'id': 1}, {'id': 1}]}, {}),
                  ({'total_count': 1, 'workflow_runs': [{'id': 1}]}, {'Link': '<https://evil.invalid/x>; rel="next"'})]
        for payload, headers in cases:
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, 'STOP'):
                listing(lambda _: (payload, headers), endpoint, 'workflow_runs')
        # The workflow search cap must not be applied to the artifact endpoint.
        rows = [{'id': i + 1} for i in range(1001)]
        self.assertEqual(listing(lambda _: ({'total_count': len(rows), 'artifacts': rows}, {}),
                                 'repos/o/r/actions/runs/1/artifacts?per_page=100', 'artifacts'), rows)

    def test_http_headers_are_used_and_dry_run_is_never_completed(self):
        raw = 'HTTP/2.0 200 OK\nLink: <https://api.github.com/repos/o/r/actions/runs?page=2>; rel="next"\n\n{"total_count":0,"workflow_runs":[]}'
        with patch('ci_artifacts.subprocess.check_output', return_value=raw) as command:
            body, headers = gh_get('repos/o/r/actions/runs')
        self.assertIn('Link', headers)
        self.assertEqual(body['total_count'], 0)
        self.assertIn('GET', command.call_args.args[0])
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            result, calls = self.collect(root, FakeGitHub(uploads), dry_run=True)
            self.assertEqual(result['status'], 'planned')
            self.assertEqual(calls, [])
            self.assertTrue(all(not row['downloaded'] for row in result['downloads']))

    def test_duplicate_yaml_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _ = self.fixture(folder)
            (root / '.github/workflows/invalid.yml').write_text('jobs: {}\njobs: {}\n')
            with self.assertRaisesRegex(ValueError, 'duplicate YAML key'):
                WorkflowCatalog(root)


if __name__ == '__main__':
    unittest.main(verbosity=2)
