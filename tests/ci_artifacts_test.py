"""REQ-W2C-04 -> RISK-CI-EVIDENCE-OMISSION -> owner/download behaviour.

The real YAML upload declarations are the contract. Synthetic relocations and
duplicate artifact names prove collection never borrows another workflow's run.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml
from ci_artifacts import CANDIDATE, ROOT, download, inventory
from ci_workflows import WorkflowCatalog

SHA = 'a' * 40


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
        self.assertNotIn('gh run download $validateRun', doc)

    def fixture(self, folder):
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
                                              for artifact in artifacts]} for name, artifacts in jobs.items()}}
            (workflows / file).write_text(yaml.safe_dump(value), encoding='utf-8')
        return root, uploads

    def queries(self, uploads, defect=None):
        ids = {name: index + 10 for index, name in enumerate(uploads)}
        def query(*args):
            url = args[-1]
            if '/workflows/' in url:
                name = url.split('/workflows/')[1].split('/')[0]
                self.assertIn('head_sha=' + SHA, url)
                run = {'id': ids[name], 'head_sha': SHA, 'path': '.github/workflows/' + name,
                       'created_at': '2026-10-12T00:00:00Z', 'run_attempt': 2,
                       'status': 'completed', 'conclusion': 'success'}
                if name == 'renamed-volume.yml':
                    if defect == 'wrong-sha':
                        run['head_sha'] = 'b' * 40
                    elif defect == 'wrong-owner':
                        run['path'] = '.github/workflows/validate.yml'
                    elif defect == 'failed':
                        run['conclusion'] = 'failure'
                    elif defect == 'pending':
                        run['status'] = 'in_progress'
                return [{'workflow_runs': [run]}]
            run_id = int(url.split('/runs/')[1].split('/')[0])
            name = next(name for name, value in ids.items() if value == run_id)
            rows = [{'id': i + 100, 'name': artifact.replace('${{ env.CANDIDATE_SHA }}', SHA),
                     'expired': defect == 'expired'}
                    for i, artifact in enumerate(a for artifacts in uploads[name].values() for a in artifacts)]
            if defect == 'missing' and name == 'renamed-volume.yml':
                rows = []
            return [{'artifacts': rows}]
        return query, ids

    def test_relocated_and_same_name_artifacts_download_from_each_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            query, ids = self.queries(uploads)
            calls = []
            result = download(root, SHA, '8', root / 'out', query, calls.append)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(len(calls), 7)
            for call in calls:
                run_id, name, destination = int(call[3]), call[5], Path(call[7])
                owner = next(file for file, value in ids.items() if value == run_id)
                self.assertIn(name, [a.replace('${{ env.CANDIDATE_SHA }}', SHA)
                                    for names in uploads[owner].values() for a in names])
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
                query, ids = self.queries(uploads, defect)
                calls = []
                with self.assertRaises(ValueError):
                    download(root, SHA, '8', root / 'out', query, calls.append)
                self.assertFalse(any(call[5] == 'synthetic-volume-rendering-results' for call in calls))
                self.assertEqual(json.loads((root / 'out/artifact-downloads.json').read_text())['status'], 'incomplete')

    def test_duplicate_yaml_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _ = self.fixture(folder)
            (root / '.github/workflows/invalid.yml').write_text('jobs: {}\njobs: {}\n')
            with self.assertRaisesRegex(ValueError, 'duplicate YAML key'):
                WorkflowCatalog(root)


if __name__ == '__main__':
    unittest.main(verbosity=2)
