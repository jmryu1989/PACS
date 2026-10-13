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
import os
from pathlib import Path
import re
import shutil
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
        if url.path == 'repos/o/r':
            return {'id': 42}, {}
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
            base = base.replace('/repos/o/r/', '/repositories/42/')
            headers['Link'] = f'<{base}&page={page + 1}>; rel="next"'
        return copy.deepcopy({'total_count': len(rows), key: rows[start:start + self.page_size]}), headers


class ArtifactTests(unittest.TestCase):
    def test_invalid_page_zero_and_empty_page_with_next_link(self):
        for page_number, rows in ((0, [{'id': 1}]), (2, [])):
            with self.subTest(page=page_number):
                def query(endpoint):
                    if 'page=' in endpoint:
                        return {'total_count': 1, 'artifacts': [{'id': 1}] if not rows else []}, {}
                    return {'total_count': 1, 'artifacts': rows}, {'Link':
                        f'<https://api.github.com/repositories/42/actions/runs/11/artifacts?page={page_number}>; rel="next"'}
                with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=unknown: invalid pagination Link page/fragment'):
                    listing(query, 'repos/o/r/actions/runs/11/artifacts', 'artifacts',
                            {'id': 11, 'run_attempt': 1}, repository_id=42)

    def test_refusal_reasons_keep_selected_run_and_artifacts(self):
        cases = ('wrong-sha', 'wrong-owner', 'failure', 'pending', 'zero', 'two', 'digest')
        for defect in cases:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                run = github.run('renamed-volume.yml')
                artifact, reason = 'unknown', 'run owner/SHA mismatch'
                if defect == 'wrong-sha':
                    run['head_sha'] = 'b' * 40
                elif defect == 'wrong-owner':
                    run['path'] = '.github/workflows/other.yml'
                elif defect in ('failure', 'pending'):
                    run.update(conclusion='failure' if defect == 'failure' else None,
                               status='completed' if defect == 'failure' else 'pending')
                    reason = 'latest run is not completed/success'
                elif defect in ('zero', 'two'):
                    if defect == 'zero':
                        run['artifacts'] = []
                        artifact = 'missing'
                    else:
                        run['artifacts'].append(dict(run['artifacts'][0], id=1150))
                        artifact = '1100,1150'
                    reason = 'expected one available synthetic-volume-rendering-results'
                else:
                    run['artifacts'][0]['digest'] = 'sha256:wrong'
                    artifact, reason = '1100', 'downloaded archive digest mismatch'
                with self.assertRaisesRegex(ValueError, re.escape(f'STOP run_id=11 attempt=1 artifact_id={artifact}:') + '.*' + reason):
                    self.collect(root, github)

    def test_final_run_set_change_keeps_last_known_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            class Changed(FakeGitHub):
                def __call__(self, endpoint):
                    body, headers = super().__call__(endpoint)
                    if '/workflows/renamed-volume.yml/runs?' in endpoint and self.urls.count(endpoint) == 2:
                        body['workflow_runs'][0]['updated_at'] = '2026-10-13T00:00:00Z'
                    return body, headers
            with self.assertRaisesRegex(ValueError, 'STOP run_id=12 attempt=1 artifact_id=1201: .*workflow run set/revisions changed during collection'):
                self.collect(root, Changed(uploads))

    def test_latest_run_uses_instants_across_calendar_and_timezone_boundaries(self):
        pairs = [
            ('2026-10-12T01:00:00+09:00', '2026-10-12T00:00:00Z'),
            ('2026-11-01T00:15:00+02:00', '2026-10-31T23:45:00Z'),
            ('2027-01-01T00:15:00+02:00', '2026-12-31T23:45:00Z'),
            ('2026-10-12T00:00:00Z', '2026-10-12T00:00:00.1Z'),
            ('2026-10-12T00:30:00+02:00', '2026-10-11T23:00:00-01:00'),
        ]
        for earlier, later in pairs:
            with self.subTest(earlier=earlier, later=later), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                github.run('renamed-volume.yml')['created_at'] = earlier
                github.add('renamed-volume.yml', ['synthetic-volume-rendering-results'], run_id=90,
                           created_at=later, conclusion='failure')
                with self.assertRaisesRegex(ValueError, 'STOP run_id=90 attempt=1 artifact_id=unknown: .*latest run is not completed/success'):
                    self.collect(root, github)

    @staticmethod
    def powershells():
        return list(dict.fromkeys(path for name in ('powershell', 'pwsh') if (path := shutil.which(name))))

    def test_all_documented_powershell_blocks_parse_without_native_quoting_hazard(self):
        shells = self.powershells()
        if not shells:
            self.skipTest('PowerShell is not installed; Windows validation is required separately')
        blocks = re.findall(r'```powershell\n(.*?)```', (ROOT / 'tests/stage-exit.md').read_text(encoding='utf-8'), re.S)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for index, block in enumerate(blocks):
                (root / f'{index}.ps1').write_text(block, encoding='utf-8-sig')
            parser = root / 'parse.ps1'
            parser.write_text('''$ErrorActionPreference = 'Stop'
foreach ($file in Get-ChildItem $PSScriptRoot -Filter '*.ps1' | Where-Object Name -ne 'parse.ps1') {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
  $hazards = $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
    @($node.CommandElements | Where-Object {
      $_ -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
      $_.StringConstantType -eq 'SingleQuoted' -and $_.Value.Contains([char]34)
    }).Count -gt 0
  }, $true)
  if ($hazards.Count) { throw ('Native quoting hazard in ' + $file.Name) }
}
''', encoding='utf-8-sig')
            for shell in shells:
                with self.subTest(shell=shell):
                    result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-File', str(parser)], capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))

    def test_manual_rerun_archive_and_three_guards_execute(self):
        shells = self.powershells()
        if not shells:
            self.skipTest('PowerShell is not installed; Windows validation is required separately')
        doc = (ROOT / 'tests/stage-exit.md').read_text(encoding='utf-8')
        block = next(block for block in re.findall(r'```powershell\n(.*?)```', doc, re.S) if block.startswith('$stopped ='))
        for shell in shells:
            for case, message in (('ok', None), ('id', '확인된 artifact id 필요'),
                                  ('origin', 'artifact 실행 출처 불일치'), ('digest', '수동 archive digest 불일치')):
                with self.subTest(shell=shell, case=case), tempfile.TemporaryDirectory() as folder:
                    root = Path(folder)
                    fake = root / 'fake-gh.py'
                    fake.write_text('''import hashlib, json, os, sys
from pathlib import Path
case = os.environ['MOCK_CASE']
archive = b'PK\\x03\\x04synthetic\\x00\\xff'
if sys.argv[1:3] == ['run', 'view']:
    print(json.dumps(dict(databaseId=42, attempt=2, status='completed', conclusion='success', headSha='a'*40, event='push', workflowName='validate')))
elif sys.argv[-1].endswith('/zip'):
    Path(os.environ['MOCK_DOWNLOAD']).write_text('downloaded')
    sys.stdout.buffer.write(archive)
else:
    print(json.dumps(dict(id=99, workflow_run=dict(id=7 if case == 'origin' else 42), digest='sha256:' + ('wrong' if case == 'digest' else hashlib.sha256(archive).hexdigest()))))
''', encoding='utf-8')
                    if os.name == 'nt':
                        # CreateProcess searches .exe, not PATHEXT: a .cmd mock can
                        # accidentally fall through to the real installed gh.exe.
                        source = root / 'MockGh.cs'
                        payload = b'PK\x03\x04synthetic\x00\xff'
                        run_json = json.dumps(dict(databaseId=42, attempt=2, status='completed', conclusion='success',
                                                   headSha='a' * 40, event='push', workflowName='validate'))
                        metadata_json = json.dumps(dict(id=99, workflow_run=dict(id=7 if case == 'origin' else 42),
                                                        digest='sha256:' + ('wrong' if case == 'digest' else hashlib.sha256(payload).hexdigest())))
                        source.write_text('''using System; using System.IO;
class MockGh { static void Main(string[] args) {
if (args.Length > 1 && args[0] == "run" && args[1] == "view") Console.WriteLine(RUN);
else if (args[args.Length-1].EndsWith("/zip")) {
File.WriteAllText(Environment.GetEnvironmentVariable("MOCK_DOWNLOAD"), "downloaded");
byte[] data = new byte[] {PAYLOAD}; Console.OpenStandardOutput().Write(data, 0, data.Length);
} else Console.WriteLine(METADATA);
} }
'''.replace('RUN', json.dumps(run_json)).replace('METADATA', json.dumps(metadata_json))
                            .replace('PAYLOAD', ','.join(map(str, payload))), encoding='utf-8')
                        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
                        compiled = subprocess.run([str(compiler), '/nologo', '/out:' + str(root / 'gh.exe'), str(source)], capture_output=True)
                        self.assertEqual(compiled.returncode, 0, compiled.stdout.decode(errors='replace'))
                    else:
                        executable = root / 'gh'
                        executable.write_text('#!' + sys.executable + '\n' + fake.read_text(), encoding='utf-8')
                        executable.chmod(0o755)
                    script = root / 'run.ps1'
                    script.write_text("$ErrorActionPreference = 'Stop'\n$out = $PSScriptRoot\n$repository = 'o/r'\n$stoppedRun = 42\n$artifactId = " + ('0' if case == 'id' else '99') + '\n' + block, encoding='utf-8-sig')
                    env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                               MOCK_CASE=case, MOCK_DOWNLOAD=str(root / 'downloaded'))
                    # pwsh's inherited module path can hide Windows PS 5.1's
                    # inbox Get-FileHash module. Let each shell build its own.
                    env.pop('PSModulePath', None)
                    result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-File', str(script)], env=env, capture_output=True)
                    evidence = root / 'manual-42-99.json'
                    if message is None:
                        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
                        record = json.loads(evidence.read_text(encoding='utf-8-sig'))
                        self.assertEqual((record['run']['databaseId'], record['run']['attempt'], record['artifact_id'], record['use']), (42, 2, 99, 'diagnostic-only'))
                        raw = (root / 'manual-42-99.zip').read_bytes()
                        self.assertEqual(raw, b'PK\x03\x04synthetic\x00\xff')
                        self.assertEqual(record['digest'], 'sha256:' + hashlib.sha256(raw).hexdigest())
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        # UTF-8 is configured by the execution environment on Windows.
                        self.assertIn(message, result.stderr.decode('utf-8', errors='replace'))
                        self.assertFalse(evidence.exists())
                        self.assertEqual((root / 'downloaded').exists(), case == 'digest')
    def test_invalid_repository_id_stops_before_listing(self):
        for payload in ({}, {'id': '42'}, {'id': 0}, {'id': -1}, {'id': True}):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as folder:
                root, _ = self.fixture(folder)
                urls = []
                def query(endpoint):
                    urls.append(endpoint)
                    return payload, {}
                with self.assertRaisesRegex(ValueError, 'STOP run_id=unknown attempt=unknown artifact_id=unknown: invalid repository id'):
                    self.collect(root, query)
                self.assertEqual(urls, ['repos/o/r'])
                self.assertFalse((root / 'out').exists())

    def test_missing_and_malformed_run_fields_preserve_identity(self):
        invalid = {'path': [None, 12, '', 'wrong.yml'],
                   'head_sha': [None, 12, '', 'xyz'],
                   'event': [None, 12, '', 'push!'],
                   'run_attempt': [None, '1', 0, -1, True],
                   'created_at': [None, 12, '', 'not-a-timestamp', '2026-02-30T00:00:00Z', '20261012'],
                   'updated_at': [None, 12, '', 'not-a-timestamp', '2026-13-12T00:00:00Z', '2026-10-12 00:00:00Z'],
                   'status': [None, 12, '', 'bogus'],
                   'conclusion': [None, 12, '', 'bogus', []]}
        missing = object()
        for field, values in invalid.items():
            for value in [missing, *values]:
                with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as folder:
                    root, uploads = self.fixture(folder)
                    github = FakeGitHub(uploads)
                    run = github.run('renamed-volume.yml')
                    if value is missing:
                        del run[field]
                    else:
                        run[field] = value
                    attempt = run.get('run_attempt', 'unknown')
                    reason = f'STOP run_id=11 attempt={attempt} artifact_id=unknown: missing/malformed run field {field}'
                    with self.assertRaisesRegex(ValueError, re.escape(reason)):
                        self.collect(root, github)
                    manifest = json.loads((root / 'out/artifact-downloads.json').read_text())
                    self.assertEqual(manifest['status'], 'incomplete')
                    self.assertEqual(manifest['error'], reason)
                    self.assertEqual(self.calls, [])
                    self.assertEqual(len(github.urls), 2)

    def test_rerun_operator_procedure_preserves_diagnostic_only_evidence(self):
        doc = (ROOT / 'tests/stage-exit.md').read_text(encoding='utf-8')
        for contract in ('CD-02-R', 'run_attempt', '전체 재실행·부분 재실행·attempt 미증명',
                         'gh run view $stoppedRun --json databaseId,attempt,status,conclusion,headSha,event,workflowName',
                         'repos/$repository/actions/artifacts/$artifactId/zip', 'artifact_id = $artifactId',
                         'digest = $digest', "use = 'diagnostic-only'", '이전 성공 run 대체 금지',
                         '이미 dispatch한 대체 run도 event=workflow_dispatch로 STOP',
                         'stage-exit PASS 증거로 쓰지 않는다'):
            self.assertIn(contract, doc)

    def test_pull_request_dispatch_and_schedule_are_not_push_evidence(self):
        for event in ('pull_request', 'workflow_dispatch', 'schedule'):
            with self.subTest(event=event), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                github.run('renamed-volume.yml')['event'] = event
                with self.assertRaisesRegex(ValueError, f'STOP run_id=11 attempt=1 artifact_id=unknown: only push evidence is supported; event={event}'):
                    self.collect(root, github)
                self.assertEqual(self.calls, [])
        doc = (ROOT / 'tests/stage-exit.md').read_text(encoding='utf-8')
        self.assertIn('**push 실행만**', doc)
        self.assertIn('pull_request는 GitHub 병합 ref', doc)

    def test_full_partial_and_unproven_reruns_stay_diagnostic_only_in_1a(self):
        for kind in ('full', 'partial', 'unproven'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                run = github.run('validate.yml')
                run['run_attempt'] = 2
                for index, artifact in enumerate(run['artifacts']):
                    if kind != 'unproven':
                        artifact['producer'] = {'run_id': run['id'], 'run_attempt': 2 if kind == 'full' or index == 0 else 1}
                with self.assertRaisesRegex(ValueError, 'STOP run_id=10 attempt=2 artifact_id=unknown: rerun artifact attempt cannot be proved.*CI-TOOLING-1b'):
                    self.collect(root, github)
                result = json.loads((root / 'out/artifact-downloads.json').read_text())
                self.assertEqual(result['status'], 'incomplete')

    def test_run_revision_differs_between_listing_and_get(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            class Changed(FakeGitHub):
                def __call__(self, endpoint):
                    body, headers = super().__call__(endpoint)
                    if endpoint.endswith('/runs/11'):
                        body['updated_at'] = '2026-10-13T12:00:00Z'
                    return body, headers
            with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=unknown: run changed between listing and collection'):
                self.collect(root, Changed(uploads))

    def test_artifact_metadata_differs_from_listing(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            class Changed(FakeGitHub):
                def __call__(self, endpoint):
                    body, headers = super().__call__(endpoint)
                    if endpoint.endswith('/artifacts/1100'):
                        body['size_in_bytes'] = 50
                    return body, headers
            with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=1100: artifact metadata changed before download'):
                self.collect(root, Changed(uploads))

    def test_artifact_owner_run_or_sha_differs(self):
        for field, value in (('id', 999), ('head_sha', 'b' * 40)):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                github.run('renamed-volume.yml')['artifacts'][0]['workflow_run'][field] = value
                with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=1100: artifact belongs to another run/SHA'):
                    self.collect(root, github)

    def test_artifact_changed_or_expired_during_download(self):
        for field, value in (('expired', True), ('size_in_bytes', 50)):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                def racing(endpoint, path):
                    with zipfile.ZipFile(path, 'w') as zipped:
                        zipped.writestr('evidence', 'synthetic')
                    github.run('renamed-volume.yml')['artifacts'][0][field] = value
                with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=1100: artifact changed during download'):
                    self.collect(root, github, fetch=racing)

    def test_naive_run_timestamps_stop(self):
        for field in ('created_at', 'updated_at'):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as folder:
                root, uploads = self.fixture(folder)
                github = FakeGitHub(uploads)
                github.run('renamed-volume.yml')[field] = '2026-10-12T00:00:00'
                with self.assertRaisesRegex(ValueError, f'STOP run_id=11 attempt=1 artifact_id=unknown: {field} lacks timezone'):
                    self.collect(root, github)

    def test_each_unsafe_pagination_link_has_its_own_stop(self):
        endpoint = 'repos/o/r/actions/runs/11/artifacts?per_page=1'
        good = 'https://api.github.com/repositories/42/actions/runs/11/artifacts?per_page=1&page=2'
        cases = [(good.replace('/42/', '/43/'), 'foreign repository/path'),
                 (good.replace('api.github.com', 'evil.invalid'), 'foreign host/scheme'),
                 (good.replace('/11/', '/12/'), 'foreign repository/path'),
                 (good.replace('per_page=1', 'per_page=2'), 'changed query'),
                 (good + '&extra=', 'changed query'),
                 (good + '#fragment', 'invalid pagination Link page/fragment')]
        for target, reason in cases:
            with self.subTest(target=target):
                calls = []
                def query(url):
                    calls.append(url)
                    # If a guard disappears, a unique final page succeeds: no duplicate masks it.
                    return ({'total_count': 2, 'artifacts': [{'id': len(calls)}]},
                            {'Link': f'<{target}>; rel="next"'} if len(calls) == 1 else {})
                with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=unknown: .*' + reason):
                    listing(query, endpoint, 'artifacts', {'id': 11, 'run_attempt': 1}, repository_id=42)
                self.assertEqual(len(calls), 1)

    def test_pagination_count_changes(self):
        calls = []
        def query(url):
            calls.append(url)
            return ({'total_count': 3 if len(calls) == 1 else 2, 'artifacts': [{'id': len(calls)}]},
                    {'Link': '<https://api.github.com/repositories/42/actions/runs/11/artifacts?per_page=1&page=2>; rel="next"'} if len(calls) == 1 else {})
        with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=unknown: count changed during pagination'):
            listing(query, 'repos/o/r/actions/runs/11/artifacts?per_page=1', 'artifacts',
                    {'id': 11, 'run_attempt': 1}, repository_id=42)

    def test_pagination_link_cycle(self):
        calls = []
        def query(url):
            calls.append(url)
            return ({'total_count': 3, 'artifacts': [{'id': len(calls)}]},
                    {'Link': '<https://api.github.com/repositories/42/actions/runs/11/artifacts?per_page=1&page=2>; rel="next"'})
        with self.assertRaisesRegex(ValueError, 'STOP run_id=11 attempt=1 artifact_id=unknown: pagination Link cycle'):
            listing(query, 'repos/o/r/actions/runs/11/artifacts?per_page=1', 'artifacts',
                    {'id': 11, 'run_attempt': 1}, repository_id=42)
        self.assertEqual(len(calls), 2)

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
        blocks = re.findall(r'```powershell\n(.*?)```', doc, re.DOTALL)
        collecting = [block for block in blocks if re.search(r'tests/ci_artifacts\.py --sha \$sha --stage [78]\b', block)]
        self.assertEqual(len(collecting), 2)
        for block in collecting:
            self.assertIn('--non-candidate', block)
            self.assertRegex(block, r'if \(-not \$candidateRun\) \{ throw [^\n]+\}')
            self.assertIn('gh run view $candidateRun --json workflowName,event,status,conclusion,headSha,attempt', block)
            for guard in ("$candidate.workflowName -ne 'Validate immutable deployment candidate'", "$candidate.event -ne 'workflow_dispatch'",
                          "$candidate.status -ne 'completed'", "$candidate.conclusion -ne 'success'",
                          '$candidate.attempt -lt 1'):
                self.assertIn(guard, block)
            self.assertRegex(block, r'if \([^\n]+\) \{ throw [^\n]+\}')
            self.assertIn('$candidate | ConvertTo-Json', block)
            self.assertLess(block.index('gh run view'), block.index('gh run download'))

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
                self.assertEqual(github.urls.count('repos/o/r'), 1)

    def test_original_link_path_is_also_allowed(self):
        with tempfile.TemporaryDirectory() as folder:
            root, uploads = self.fixture(folder)
            class OriginalPath(FakeGitHub):
                def __call__(self, endpoint):
                    body, headers = super().__call__(endpoint)
                    if 'Link' in headers:
                        headers['Link'] = headers['Link'].replace('/repositories/42/', '/repos/o/r/')
                    return body, headers
            github = OriginalPath(uploads)
            github.page_size = 1
            result, _ = self.collect(root, github)
            self.assertEqual(result['status'], 'completed')
            self.assertTrue(any('api.github.com/repos/o/r/' in u and 'page=2' in u for u in github.urls))

    def test_cap_count_contradiction_and_duplicate_rows_stop(self):
        endpoint = 'repos/o/r/actions/workflows/w.yml/runs?head_sha=' + SHA + '&per_page=100'
        cases = [({'total_count': n, 'workflow_runs': [{'id': 1}]}, {}) for n in (0, 2, 1000, 1002, '2500+', None)]
        # A capped count can equal the visible row count. Equality alone is not completeness.
        cases.append(({'total_count': 1000, 'workflow_runs': [{'id': i + 1} for i in range(1000)]}, {}))
        cases += [({'total_count': 2, 'workflow_runs': [{'id': 1}, {'id': 1}]}, {}),
                  ({'total_count': 1, 'workflow_runs': [{'id': 1}]}, {'Link': '<https://evil.invalid/x>; rel="next"'})]
        for payload, headers in cases:
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, 'STOP'):
                listing(lambda _: (payload, headers), endpoint, 'workflow_runs', repository_id=42)
        # The workflow search cap must not be applied to the artifact endpoint.
        rows = [{'id': i + 1} for i in range(1001)]
        self.assertEqual(listing(lambda _: ({'total_count': len(rows), 'artifacts': rows}, {}),
                                 'repos/o/r/actions/runs/1/artifacts?per_page=100', 'artifacts', repository_id=42), rows)

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
