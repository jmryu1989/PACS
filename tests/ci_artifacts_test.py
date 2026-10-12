"""REQ-W2C-04 -> RISK-CI-EVIDENCE-OMISSION -> owner/download behaviour.

The real YAML upload declarations are the contract. Synthetic relocations and
duplicate artifact names prove collection never borrows another workflow's run.
The fake below answers the GitHub REST endpoints the collector uses (workflow
runs, artifacts by name, one run, a run's artifacts) from a list of runs; it
serves every run of a workflow regardless of head_sha or creation date, so SHA
and date filtering are the collector's own duty.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

import yaml
from ci_artifacts import CANDIDATE, ROOT, TITLE, download, inventory
from ci_workflows import WorkflowCatalog

SHA = 'a' * 40
MAIN_TIP = 'f' * 40


def real_name(template):
    return template.replace('${{ env.CANDIDATE_SHA }}', SHA)


class FakeGitHub:
    def __init__(self, uploads):
        self.runs, self.urls = [], []
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
               'artifacts': [{'id': run_id * 100 + i, 'name': name, 'expired': expired}
                             for i, name in enumerate(names)]}
        self.runs.append(run)
        return run

    def run(self, file):
        return next(run for run in self.runs if run['listed_under'] == file)

    @staticmethod
    def public(run):
        return {key: value for key, value in run.items() if key not in ('artifacts', 'listed_under')}

    def __call__(self, *args):
        url = urlsplit(args[-1])
        self.urls.append(args[-1])
        params = parse_qs(url.query)
        listing = re.search(r'/actions/workflows/([^/]+)/runs$', url.path)
        if listing:
            return [{'workflow_runs': [self.public(run) for run in self.runs
                                       if run['listed_under'] == listing.group(1)]}]
        if url.path.endswith('/actions/artifacts'):
            name = params['name'][0]
            return [{'artifacts': [dict(item, workflow_run={'id': run['id'], 'head_sha': run['head_sha']})
                                   for run in self.runs for item in run['artifacts'] if item['name'] == name]}]
        one = re.search(r'/actions/runs/(\d+)(/artifacts)?$', url.path)
        run = next(run for run in self.runs if run['id'] == int(one.group(1)))
        return [{'artifacts': run['artifacts']}] if one.group(2) else self.public(run)


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
        self.assertIsNone(re.search(r'\bgh\s+run\s+download\b', doc, re.IGNORECASE))
        self.assertIsNone(re.search(r'/artifacts/[^\s/]+/zip\b', doc))
        blocks = re.findall(r'```powershell\n(.*?)```', doc, re.DOTALL)
        collecting = [block for block in blocks if re.search(r'tests/ci_artifacts\.py --sha \$sha --stage [78]\b', block)]
        self.assertEqual(len(collecting), 2)

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

    def collect(self, root, github, stage='8'):
        calls = []
        try:
            return download(root, SHA, stage, root / 'out', github, calls.append), calls
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
            self.assertEqual(len(calls), 7)
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

    def candidate_downloads(self, calls):
        return [int(call[3]) for call in calls if call[5] == real_name(CANDIDATE)]

    def test_hand_started_and_pull_request_g3_runs_are_found_by_their_artifact(self):
        for event in ('workflow_dispatch', 'pull_request'):
            with self.subTest(event=event), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                run = github.run('candidate.yml')
                run['event'] = event
                if event == 'workflow_dispatch':
                    # `--ref main -f candidate_sha=SHA`: the run's commit is main's tip.
                    run['head_sha'] = MAIN_TIP
                    # Another hand-started run *from* SHA's commit validated a different candidate.
                    github.add('candidate.yml', ['candidate-' + 'c' * 40], run_id=91, head_sha=SHA,
                               created_at='2026-10-12T05:00:00Z', event=event, conclusion='failure')
                result, calls = self.collect(root, github)
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(self.candidate_downloads(calls), [run['id']])
                row = next(row for row in result['runs'] if row['id'] == run['id'])
                self.assertEqual((row['sha'], row['run_head_sha']), (SHA, run['head_sha']))

    def test_g3_lookup_refuses_absent_unsuccessful_superseded_or_foreign_uploads(self):
        for defect in ('absent', 'failed', 'pending', 'latest-failed', 'foreign-workflow', 'foreign-workflow-expired',
                       'expired', 'expired-latest'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                run = github.run('candidate.yml')
                run['head_sha'], run['event'] = MAIN_TIP, 'workflow_dispatch'
                if defect == 'absent':
                    run['artifacts'] = []
                elif defect == 'failed':
                    run['conclusion'] = 'failure'
                elif defect == 'pending':
                    run['status'] = 'in_progress'
                elif defect == 'latest-failed':
                    github.add('candidate.yml', [real_name(CANDIDATE)], run_id=92, head_sha=MAIN_TIP,
                               created_at='2026-10-12T06:00:00Z', event='workflow_dispatch', conclusion='failure')
                elif defect.startswith('foreign-workflow'):
                    # An undeclared uploader is a refusal even after its upload expired.
                    github.add('rogue.yml', [real_name(CANDIDATE)], run_id=93, head_sha=SHA,
                               expired=defect.endswith('expired'))
                elif defect == 'expired':
                    for item in run['artifacts']:
                        item['expired'] = True
                else:
                    # The older run still holds a valid upload; the latest run's upload expired.
                    github.add('candidate.yml', [real_name(CANDIDATE)], run_id=94, head_sha=MAIN_TIP,
                               created_at='2026-10-12T06:00:00Z', event='workflow_dispatch', expired=True)
                calls = self.refused(root, github)
                self.assertEqual(self.candidate_downloads(calls), [])

    def g3_after_older_success(self, folder, **later):
        """An older hand-started G3 run for SHA that succeeded and uploaded, then one later run."""
        root, uploads = self.fixture(folder)
        github = FakeGitHub(uploads)
        older = github.run('candidate.yml')
        older.update(head_sha=MAIN_TIP, event='workflow_dispatch', display_title='candidate ' + SHA)
        later = dict(dict(head_sha=MAIN_TIP, event='workflow_dispatch', title='candidate ' + SHA,
                          created_at='2026-10-12T03:00:00Z'), **later)
        github.add('candidate.yml', later.pop('names', []), run_id=later.pop('run_id', 95), **later)
        return root, github, older

    def test_a_later_g3_run_for_the_candidate_is_never_bypassed_by_an_older_success(self):
        other_title = 'Workflow candidate.yml'  # a hand-started run from before the run-name
        cases = {
            'failed before upload': {'conclusion': 'failure'},
            'cancelled': {'conclusion': 'cancelled'},
            'in progress': {'status': 'in_progress', 'conclusion': None},
            'queued': {'status': 'queued', 'conclusion': None},
            'success without upload': {},
            'pull request for the candidate': {'event': 'pull_request', 'head_sha': SHA, 'title': 'Some pull request',
                                               'conclusion': 'failure'},
            'untitled hand-started failure': {'title': other_title, 'conclusion': 'failure'},
            'untitled hand-started run in progress': {'title': other_title, 'status': 'in_progress',
                                                      'conclusion': None},
            'untitled hand-started success without upload': {'title': other_title},
            # Created later with a lower id: the creation time orders runs.
            'later failure with a lower id': {'conclusion': 'failure', 'run_id': 5},
            'failure created in the same second': {'conclusion': 'failure', 'created_at': '2026-10-12T00:00:00Z'},
        }
        for case, later in cases.items():
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, github, older = self.g3_after_older_success(folder, **later)
                calls = self.refused(root, github)
                self.assertEqual(self.candidate_downloads(calls), [])
                manifest = json.loads((root / 'out/artifact-downloads.json').read_text())
                self.assertNotIn(older['id'], [run['id'] for run in manifest['runs']])
        with tempfile.TemporaryDirectory() as folder:
            root, github, _ = self.g3_after_older_success(folder, title=other_title, conclusion='failure', run_id=96)
            with self.assertRaisesRegex(ValueError, r'STOP.*\b96\b'):
                self.collect(root, github)

    def test_later_g3_runs_of_other_candidates_do_not_block(self):
        other = 'c' * 40
        cases = {
            # Started from the candidate's own commit, but validating another candidate.
            'hand-started from the commit for another candidate': {'head_sha': SHA, 'title': 'candidate ' + other,
                                                                   'conclusion': 'failure'},
            'pull request with another head': {'event': 'pull_request', 'head_sha': other,
                                               'title': 'Some pull request', 'conclusion': 'failure'},
            'titled pull request run in progress': {'event': 'pull_request', 'head_sha': other,
                                                    'title': 'candidate ' + other, 'status': 'in_progress',
                                                    'conclusion': None},
            'untitled hand-started run that uploaded another candidate': {
                'title': 'Workflow candidate.yml', 'names': ['candidate-' + other], 'conclusion': 'failure'},
            'untitled run created before the candidate run': {'title': 'Workflow candidate.yml',
                                                              'created_at': '2026-10-11T23:00:00Z',
                                                              'conclusion': 'failure'},
            'untitled run in the same second with a lower id': {'title': 'Workflow candidate.yml',
                                                                'created_at': '2026-10-12T00:00:00Z',
                                                                'run_id': 7, 'conclusion': 'failure'},
            'older failure with a higher id': {'created_at': '2026-10-11T23:00:00Z', 'run_id': 999,
                                               'conclusion': 'failure'},
        }
        for case, later in cases.items():
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, github, older = self.g3_after_older_success(folder, **later)
                result, calls = self.collect(root, github)
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(self.candidate_downloads(calls), [older['id']])

    def test_g3_runs_are_titled_with_the_candidate_they_upload(self):
        # A run that stops before its upload is attributed through its run-name alone.
        def terms(value):  # the expression's operands, ignoring spacing and parentheses
            return re.findall(r'[\w.]+|\|\|', value)

        owners = {row['workflow'] for row in inventory(ROOT) if row['artifact'] == CANDIDATE}
        self.assertTrue(owners)
        for workflow in owners:
            parsed = yaml.safe_load((ROOT / workflow).read_text(encoding='utf-8'))
            sources = [terms(dict(parsed.get('env', {}), **job.get('env', {}))['CANDIDATE_SHA'])
                       for job in parsed['jobs'].values()
                       if any(step.get('with', {}).get('name') == CANDIDATE for step in job.get('steps', []))]
            title = parsed['run-name']
            self.assertTrue(title.startswith('candidate ${{'), workflow)
            self.assertEqual(sources, [terms(title[len('candidate '):])], workflow)
        self.assertEqual(TITLE.fullmatch('candidate ' + SHA).group(1), SHA)

    def test_duplicate_yaml_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _ = self.fixture(folder)
            (root / '.github/workflows/invalid.yml').write_text('jobs: {}\njobs: {}\n')
            with self.assertRaisesRegex(ValueError, 'duplicate YAML key'):
                WorkflowCatalog(root)


if __name__ == '__main__':
    unittest.main(verbosity=2)
