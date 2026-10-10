"""D-MEASURE2 B1: runner refusal and public artifact secret redaction."""
import json, os, tempfile, unittest
import contextlib
import csv
import io
import hashlib
import shlex
import shutil
import sys
from datetime import datetime
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import MagicMock, patch
import measurement_ci as ci
from live_admin_credential_test import ImportedAdminCredentialTests


class MeasurementCiTests(unittest.TestCase):
    def test_main_uses_profile_deadline_to_clamp_commands_and_preserves_cleanup(self):
        # REQ-D949 -> RISK-CI-DEADLINE-DRIFT: observe the actual subprocess bound
        # passed by main(), without binding a source string or internal layout.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            calls = []
            def execute(command, **kwargs):
                calls.append((command, kwargs['timeout']))
                return SimpleNamespace(returncode=1 if 'up' in command else 0, stdout=b'', stderr=b'')
            profile = dict(ci.PROFILES['emr-b'], out=root/'out')
            with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}, clear=True), \
                    patch.object(ci, 'ROOT', root), patch.dict(ci.PROFILES, {'emr-b': profile}), \
                    patch.object(ci, 'seed_source'), patch.object(ci, 'profile_deadline_seconds', return_value=37), \
                    patch.object(ci.time, 'monotonic', side_effect=[100, 105, 106, 107, 108, 109, 110]), \
                    patch.object(ci.subprocess, 'check_output', side_effect=[b'', b'', b'unix:///runner.sock']), \
                    patch.object(ci.subprocess, 'run', side_effect=execute), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError):
                    ci.main('emr-b')
            self.assertEqual(calls[0][1], 32)
            self.assertEqual([timeout for argv, timeout in calls if 'logs' in argv], [30])
            self.assertEqual([timeout for argv, timeout in calls if 'down' in argv], [60])

    def test_context_loss_profile_selects_only_its_declared_cases_on_a_fresh_runner(self):
        import ast
        import yaml
        profile = ci.PROFILES['context-loss']
        self.assertEqual(profile['suites'], (('e2e/test_context_loss.py', 'ContextLossE2E', 'ci-context-loss'),))
        command, timeout = ci.guarded_profile_run(profile, *profile['suites'][0], 3900)
        self.assertEqual(command[command.index('--class') + 1], 'ContextLossE2E')
        self.assertLessEqual(timeout, 1235)
        module = ast.parse((ci.ROOT / 'tests/e2e/test_context_loss.py').read_text(encoding='utf-8'))
        cls = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == 'ContextLossE2E')
        cases = [n.name for n in cls.body if isinstance(n, ast.FunctionDef) and n.name.startswith('test_')]
        self.assertEqual(cases, [
            'test_context_01_mip_manual_reload_known_source_and_projection_pixels',
            'test_context_02_embedded_2d_reload_keeps_report_and_session',
            'test_context_03_mpr_batch_late_blob_does_not_commit',
            'test_context_04_mip_batch_late_blob_keeps_job_inputs',
        ])
        workflow = yaml.safe_load((ci.ROOT / '.github/workflows/validate.yml').read_text(encoding='utf-8'))
        job = workflow['jobs']['context-loss']
        self.assertEqual(job['runs-on'], 'ubuntu-24.04')
        self.assertEqual(job['timeout-minutes'], 45)
        runs = [s for s in job['steps'] if '--profile context-loss' in s.get('run', '')]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['timeout-minutes'], 28)
        uploads = [s for s in job['steps'] if s.get('uses', '').startswith('actions/upload-artifact@')]
        self.assertEqual(len(uploads), 1)
        self.assertEqual(uploads[0]['with']['path'], 'tests/e2e/artifacts/context-loss-ci/')

    def test_emr_b_profile_runs_the_declared_ledger_cases_only_in_its_own_workflow(self):
        """EMR-B1 (order section 10): one declared ledger suite including D941 live latency, a 3600s planned ceiling within
        its dedicated 65 minute deadline, a separate artifact and project, and only emr-b.yml requests the profile."""
        import ast
        import yaml
        profile = ci.PROFILES['emr-b']
        declaration = json.loads((ci.ROOT/'emr/units/b.json').read_text(encoding='utf-8'))
        self.assertEqual([list(row) for row in profile['suites']], declaration['cases']['live']['profile_suites'])
        self.assertEqual(profile['out'].name, 'emr-b-ci')
        self.assertNotIn('suite_budgets', profile)
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 3900)
        self.assertEqual(command[command.index('--module')+1], 'tests/emr/b/live.py')
        self.assertEqual(command[command.index('--class')+1], 'EmrBLedgerLive')
        self.assertEqual(command[command.index('--unit')+1], 'ci-emr-b-ledger')
        self.assertEqual(command[command.index('--timeout')+1], '3600')
        self.assertEqual(command[command.index('--mode')+1], 'live')
        self.assertEqual(outer, 3635)
        self.assertLessEqual(outer, 65*60-230)
        for name, other in ci.PROFILES.items():
            if name != 'emr-b':
                self.assertNotEqual(profile['out'], other['out'])
                self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        module = ast.parse((ci.ROOT/'tests/emr/b/live.py').read_text(encoding='utf-8'))
        cls = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == 'EmrBLedgerLive')
        self.assertEqual([n.name for n in cls.body if isinstance(n, ast.FunctionDef) and n.name.startswith('test_')],
                         declaration['cases']['live']['B1'])
        self.assertEqual((ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8').count('--profile emr-b'), 0)
        workflow = yaml.safe_load((ci.ROOT/'.github/workflows/emr-b.yml').read_text(encoding='utf-8'))
        self.assertEqual(list(workflow['jobs']), ['emr-b'])
        steps = workflow['jobs']['emr-b']['steps']
        self.assertEqual(len([s for s in steps if '--profile emr-b' in str(s.get('run', ''))]), 1)
        uploads = [s for s in steps if str(s.get('uses', '')).startswith('actions/upload-artifact@')]
        self.assertTrue(any('tests/e2e/artifacts/emr-b-ci' in str(s['with']['path']) for s in uploads))
        # The disposable stack's API reads its runtime login from a generated secret (docker-compose.yml refuses to
        # start without one), distinct from the installer's, and the secret is redacted from every artifact.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            patched = {**profile, 'out': root/'artifacts'}
            seen = []

            def fake_run(command, **kwargs):
                seen.append((list(map(str, command)), kwargs.get('env') or {}))
                secret = seen[0][1].get('KIN_EMR_RUNTIME_PASSWORD', 'missing')
                return MagicMock(returncode=1 if len(seen) == 1 else 0, stdout=('echo ' + secret).encode(), stderr=b'')

            with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}, clear=True), \
                    patch.object(ci, 'ROOT', root), patch.dict(ci.PROFILES, {'emr-b': patched}), \
                    patch.object(ci, 'seed_source'), \
                    patch.object(ci.subprocess, 'check_output', side_effect=[b'', b'', b'unix:///var/run/docker.sock']), \
                    patch.object(ci.subprocess, 'run', side_effect=fake_run), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'database failed'):
                    ci.main('emr-b')
            env = seen[0][1]
            self.assertRegex(env['KIN_EMR_RUNTIME_PASSWORD'], r'^[0-9a-f]{64}$')
            self.assertNotEqual(env['KIN_EMR_RUNTIME_PASSWORD'], env['POSTGRES_PASSWORD'])
            for log in (root/'artifacts').glob('*.log'):
                self.assertNotIn(env['KIN_EMR_RUNTIME_PASSWORD'], log.read_text(encoding='utf-8'))
            self.assertIn('[REDACTED]', (root/'artifacts'/'database.log').read_text(encoding='utf-8'))

    def test_browser_install_cache_and_budgets_cover_pinned_dependencies(self):
        import yaml
        workflow = yaml.safe_load((ci.ROOT / '.github/workflows/validate.yml').read_text(encoding='utf-8'))
        checked = []
        for name, job in workflow['jobs'].items():
            for index, install in enumerate(job['steps']):
                if 'playwright install --with-deps chromium' not in install.get('run', ''):
                    continue
                with self.subTest(job=name):
                    checked.append(name)
                    self.assertEqual(install['timeout-minutes'], 15)
                    cache = job['steps'][index - 1]
                    self.assertRegex(cache['uses'], r'^actions/cache@[0-9a-f]{40}$')
                    self.assertEqual(cache['with']['path'], '~/.cache/pip')
                    self.assertEqual(cache.get('if'), install.get('if'))
                    requirements = []
                    for line in install['run'].splitlines():
                        if ' -m pip install ' not in line:
                            continue
                        args = shlex.split(line)
                        requirements.extend(args[i + 1] for i, arg in enumerate(args) if arg == '-r')
                    self.assertTrue(requirements)
                    for requirement in requirements:
                        self.assertTrue((ci.ROOT / requirement).is_file())
                    self.assertEqual(cache['with']['key'], '${{ runner.os }}-pip-${{ hashFiles('
                                     + ', '.join(repr(r) for r in requirements) + ') }}')
                    run_budgets = [s['timeout-minutes'] for s in job['steps'] if
                                   'measurement_ci.py --profile' in s.get('run', '') or
                                   'tests/report_dictation_capture_dom_test.py' in s.get('run', '')]
                    self.assertEqual(len(run_budgets), 1)
                    self.assertGreater(job['timeout-minutes'], install['timeout-minutes'] + run_budgets[0])
        self.assertIn('study-arrivals', checked)
        self.assertIn('volume-slab', checked)
        self.assertIn('measurements', checked)
        self.assertIn('s7-u5-session-contracts', checked)

    def exercise_profile_failures(self, exhaust_deadline=False, real_runner=False, inspection_failure=False,
                                  wrong_unit=False, default_unit=False, manual=False, evidence=None,
                                  result_defect=None):
        """Only the real-runner variant proves module bodies execute across a retained marker."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state = root / 'gate-state'
            suites = ('first_failure.py', 'passing.py', 'second_failure.py')
            profile = {**ci.PROFILES['measurements'], 'out': root / 'artifacts',
                       'suites': tuple((s, None, None if default_unit else 'explicit-' + Path(s).stem.replace('_', '-'))
                                       for s in suites)}
            clock, live, commands = [0.0], [], []
            subprocess_run = ci.subprocess.run
            release = ci.gate.release_after_inspection
            snapshots = {}
            release_calls = []
            # Exercise run()'s real capture/log path without a Docker daemon or Compose project.
            captures = tuple((kind, [sys.executable, '-B', '-c',
                                    f"import sys; sys.stdout.write('synthetic {kind}'); sys.exit({int(inspection_failure == kind)})"])
                             for kind in ('compose-ps', 'daemon-containers'))

            def submit_record(path):
                release_calls.append(str(path))
                marker_path = state / 'live-needs-inspection.json'
                before = marker_path.read_bytes()
                record = json.loads(path.read_bytes())
                unit_ledger = state / (record['unit'] + '.json')
                ledger_before = unit_ledger.read_bytes()
                if wrong_unit:
                    original = record.copy()
                    record['unit'] = 'wrong-unit-only'
                    path.with_suffix('.original.json').write_bytes(path.read_bytes())
                    path.write_text(json.dumps(record), encoding='utf-8')
                    self.assertEqual({k: v for k, v in record.items() if k != 'unit'},
                                     {k: v for k, v in original.items() if k != 'unit'})
                if manual:
                    markdown = path.with_suffix('.md')
                    markdown.write_text('Owned synthetic Python fixtures inspected; no stack was started.\n', encoding='utf-8')
                    record['artifacts'].append(markdown.name)
                    path.write_text(json.dumps(record), encoding='utf-8')
                    command = [sys.executable, '-B', '-c',
                               'import live_test_gate as g; from pathlib import Path; '
                               'g.STATE=Path(' + repr(str(state)) + '); '
                               'g.release_after_inspection(' + repr(str(path)) + ')']
                    done = subprocess_run(command, cwd=source_root / 'tests', capture_output=True, timeout=20)
                    self.assertEqual(done.returncode, 0, done.stderr)
                    (root / 'manual-release.json').write_text(json.dumps({'argv': command, 'exit': done.returncode}), encoding='utf-8')
                else:
                    try:
                        release(path)
                    except ci.gate.Refused:
                        self.assertEqual(marker_path.read_bytes(), before)
                        self.assertFalse((state / 'inspections.jsonl').exists())
                        raise
                self.assertEqual(unit_ledger.read_bytes(), ledger_before)

            source_root = ci.ROOT
            if real_runner:
                (root / 'tests').mkdir()
                (root / 'scripts').mkdir()
                # The existing runner executes in both supervisor and worker processes.
                # Only its test root and gate STATE are redirected, never the account's ledger.
                bootstrap = root / 'scripts/run-tests.py'
                bootstrap.write_text(
                    'import importlib.util\nfrom pathlib import Path\n'
                    'spec=importlib.util.spec_from_file_location("runner", '
                    + repr(str(ci.ROOT / 'scripts/run-tests.py')) + ')\n'
                    'runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)\n'
                    'runner.ROOT=Path(' + repr(str(root)) + ')\n'
                    'runner.gate.STATE=Path(' + repr(str(state)) + ')\n'
                    'runner.__file__=__file__\nraise SystemExit(runner.main())\n', encoding='utf-8')
                for suite in suites:
                    (root / 'tests' / suite).write_text(
                        'import unittest\nfrom pathlib import Path\n'
                        'from live_test_gate import require_live_run\n'
                        'class Probe(unittest.TestCase):\n'
                        ' def test_body(self):\n'
                        '  require_live_run()\n'
                        '  with (Path(__file__).parent / "executed.txt").open("a") as stream:\n'
                        '   stream.write(' + repr(suite + '\n') + ')\n'
                        + ('  self.fail("intentional synthetic failure")\n' if 'failure' in suite else ''),
                        encoding='utf-8')
            response = MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b'{"memberRights":"ready"}'

            def execute(command, **kwargs):
                commands.append(command)
                code = 0
                if '--module' in command:
                    module = command[command.index('--module') + 1]
                    live.append(module)
                    self.assertGreater(kwargs['timeout'], 0)
                    if real_runner:
                        result = subprocess_run(command, **kwargs)
                        marker = state / 'live-needs-inspection.json'
                        if result_defect == 'foreign' and marker.exists():
                            foreign = json.loads(marker.read_bytes())
                            foreign['unit'] = 'foreign-owner'
                            marker.write_text(json.dumps(foreign), encoding='utf-8')
                        if marker.exists():
                            snapshots[module] = marker.read_bytes()
                            (root / (Path(module).stem + '-marker.json')).write_bytes(marker.read_bytes())
                        if result_defect in ('missing', 'attempt') and result.returncode:
                            lines = result.stdout.decode().splitlines()
                            rows = [json.loads(line[len('PLAN_RESULT '):]) for line in lines if line.startswith('PLAN_RESULT ')]
                            if result_defect == 'missing':
                                result.stdout = '\n'.join(line for line in lines if not line.startswith('PLAN_RESULT ')).encode()
                            else:
                                row = rows[0]
                                row['attempt'] += 1
                                result.stdout = '\n'.join('PLAN_RESULT ' + json.dumps(row) if line.startswith('PLAN_RESULT ')
                                                         else line for line in lines).encode()
                        clock[0] += 0.25
                        if exhaust_deadline:
                            clock[0] = 1501
                        return result
                    if exhaust_deadline:
                        clock[0] = 1501
                        raise ci.subprocess.TimeoutExpired(command, kwargs['timeout'], output=b'timed out')
                    clock[0] += 0.25
                    code = 1 if 'failure' in module else 0
                if any(command == capture for _, capture in captures):
                    # Inspection must retain its own bound after the profile deadline.
                    self.assertEqual(kwargs['timeout'], 30)
                    return subprocess_run(command, **kwargs)
                return MagicMock(returncode=code, stdout=b'module output', stderr=b'')

            with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                                          'RUNNER_TEMP': folder}, clear=True), \
                    patch.object(ci, 'ROOT', root), patch.dict(ci.PROFILES, {'measurements': profile}), \
                    patch.object(ci.gate, 'STATE', state), \
                    patch.object(ci.gate, 'release_after_inspection', side_effect=submit_record), \
                    patch.object(ci, 'stack_capture_commands', return_value=captures), \
                    patch.object(ci, 'seed_source'), patch.object(ci, 'time', SimpleNamespace(monotonic=lambda: clock[0])), \
                    patch.object(ci.subprocess, 'check_output', side_effect=[b'', b'', b'unix:///runner.sock']), \
                    patch.object(ci.subprocess, 'run', side_effect=execute), \
                    patch.object(ci.ssl, '_create_unverified_context', return_value=None), \
                    patch.object(ci, 'urlopen', return_value=response), \
                    patch.object(ci, 'ensure_imported_admin_credential', return_value='synthetic-secret'), \
                    contextlib.redirect_stdout(io.StringIO()):
                # An uncaught driver error is the CLI's non-zero exit contract.
                with self.assertRaises(RuntimeError) as error:
                    ci.main('measurements')
            if real_runner:
                for module in live:
                    print((profile['out'] / (Path(module).stem + '.log')).read_text(encoding='utf-8'))
            self.assertIn(Path(suites[0]).stem, str(error.exception))
            blocked = inspection_failure or wrong_unit or result_defect
            attempted = suites[:1] if exhaust_deadline or blocked else suites
            self.assertEqual(live, ['tests/' + s for s in attempted])
            if not exhaust_deadline and not blocked:
                self.assertIn(Path(suites[2]).stem, str(error.exception))
            rows = json.loads((profile['out'] / 'results.json').read_text(encoding='utf-8'))
            self.assertEqual(rows[-1]['name'], 'cleanup')
            self.assertEqual(sum('down' in c for c in commands), 1)
            with (profile['out'] / 'summary.tsv').open(encoding='utf-8', newline='') as stream:
                summary = list(csv.DictReader(stream, delimiter='\t'))
            modules = [row for row in summary if row['module'] in [Path(s).stem for s in suites]]
            self.assertEqual([row['module'] for row in modules], [Path(s).stem for s in live])
            failed_code = 125 if real_runner else (124 if exhaust_deadline else 1)
            expected = [f'FAIL ({failed_code})'] if len(attempted) == 1 else [f'FAIL ({failed_code})', 'PASS (0)', f'FAIL ({failed_code})']
            self.assertEqual([row['status'] for row in modules], expected)
            for row in modules:
                self.assertGreater(float(row['duration_seconds']), 0)
                self.assertTrue((profile['out'] / row['log']).is_file())
            if blocked:
                self.assertTrue((state / 'live-needs-inspection.json').is_file())
                self.assertFalse((state / 'inspections.jsonl').exists())
                self.assertEqual((state / 'live-needs-inspection.json').read_bytes(), snapshots['tests/' + suites[0]])
                if inspection_failure:
                    self.assertIn('fixture inspection failed', str(error.exception))
                    self.assertEqual(release_calls, [])
                if wrong_unit:
                    self.assertIn('does not identify', str(error.exception))
                    self.assertEqual(len(release_calls), 1)
                if result_defect:
                    self.assertIn('binding failed', str(error.exception))
                    self.assertEqual(release_calls, [])
            if real_runner:
                executed = (root / 'tests/executed.txt').read_text().splitlines()
                self.assertEqual(executed, list(attempted))
                ledger_path = state / 'inspections.jsonl'
                ledger = [json.loads(line) for line in ledger_path.read_text().splitlines()] if ledger_path.exists() else []
                failures = [s for s in attempted if 'failure' in s]
                self.assertEqual(len(ledger), 0 if blocked else len(failures))
                self.assertEqual((state / 'live-needs-inspection.json').exists(), bool(blocked))
                self.assertEqual(len([p for p in profile['out'].glob('inspection-*.json') if not p.name.endswith('.original.json')]), len(failures))
                for suite in failures:
                    record = json.loads((profile['out'] / ('inspection-' + Path(suite).stem + '.json')).read_bytes())
                    self.assertEqual(set(record['stack']), {'compose-ps', 'daemon-containers'})
                    for kind, capture in captures:
                        self.assertEqual(commands.count(capture), len(failures))
                        self.assertEqual(record['stack'][kind]['exit'], int(inspection_failure == kind))
                        self.assertEqual(record['stack'][kind]['output'], 'synthetic ' + kind)
                for entry, suite in zip(ledger, failures):
                    record_path = Path(entry['record_path'])
                    self.assertEqual(record_path.parent, profile['out'])
                    raw = record_path.read_bytes()
                    self.assertEqual(entry['record_sha256'], hashlib.sha256(raw).hexdigest())
                    record = json.loads(raw)
                    self.assertEqual(record['module'], 'tests/' + suite)
                    command = next(c for c in commands if '--module' in c and c[c.index('--module') + 1] == record['module'])
                    self.assertEqual(record['unit'], command[command.index('--unit') + 1])
                    self.assertEqual(record['unit'], ('ci-' if default_unit else 'explicit-') + Path(suite).stem.replace('_', '-'))
                    marker = json.loads(snapshots[record['module']])
                    self.assertEqual(entry['marker'], marker)
                    for key in ('unit', 'module', 'attempt', 'plan_sha256', 'pid', 'started_at'):
                        self.assertEqual(record[key], marker[key], key)
                    self.assertNotEqual(record['pid'], os.getpid())
                    unit_ledger = json.loads((state / (record['unit'] + '.json')).read_text())
                    row = unit_ledger['attempts'][record['attempt'] - 1]
                    self.assertEqual(row, record['plan_result'])
                    self.assertEqual(row['attempt'], record['attempt'])
                    self.assertEqual(row['plan_sha256'], record['plan_sha256'])
                    self.assertEqual(row['status'], 'failed')
                    self.assertGreater(datetime.fromisoformat(record['inspected_at']), datetime.fromisoformat(record['started_at']))
                    self.assertEqual(record['exit'], failed_code)
                    self.assertIn(record['result'], rows)
                    self.assertTrue(record['inspected_at'])
                    self.assertTrue(record['inspector'])
                    for artifact in record['artifacts']:
                        self.assertTrue((profile['out'] / artifact).is_file())
                    self.assertEqual(set(record['stack']), {'compose-ps', 'daemon-containers'})
                    self.assertTrue(all(row['exit'] == 0 for row in record['stack'].values()))
                    print('REAL_RUNNER_INSPECTION ' + json.dumps(record))
                print('REAL_RUNNER_RESULT ' + json.dumps({'executed': executed, 'failures': failures,
                      'ledger_lines': len(ledger), 'error': str(error.exception), 'cleanup': rows[-1]}))
                print('REAL_RUNNER_LEDGER ' + json.dumps(ledger))
                trace = {'commands': commands, 'executed': executed, 'ledger_lines': len(ledger),
                         'exits': [r['exit'] for r in rows if r['name'] in [Path(s).stem for s in suites]],
                         'final_failure': str(error.exception), 'cleanup_count': sum('down' in c for c in commands)}
                (root / 'trace.json').write_text(json.dumps(trace, indent=2), encoding='utf-8')
                if evidence is not None:
                    shutil.copytree(root, evidence)

    def test_live_profile_runs_all_modules_and_reports_each_failure(self):
        self.exercise_profile_failures()

    def test_live_profile_deadline_stops_remaining_modules_and_still_cleans_up(self):
        self.exercise_profile_failures(exhaust_deadline=True)

    def test_real_runner_executes_fail_pass_fail_after_recorded_inspections(self):
        for default in (False, True):
            with self.subTest(default_unit=default):
                self.exercise_profile_failures(real_runner=True, default_unit=default)

    def test_real_release_rejects_wrong_unit_and_stops_following_bodies(self):
        self.exercise_profile_failures(real_runner=True, wrong_unit=True)

    def test_missing_or_mismatched_plan_result_preserves_marker_and_stops(self):
        for defect in ('missing', 'attempt', 'foreign'):
            with self.subTest(defect=defect):
                self.exercise_profile_failures(real_runner=True, result_defect=defect)

    def test_manual_markdown_json_release_from_another_process(self):
        self.exercise_profile_failures(real_runner=True, manual=True)

    def test_real_runner_failure_then_deadline_skips_remaining_and_cleans_up(self):
        self.exercise_profile_failures(real_runner=True, exhaust_deadline=True)

    def test_failed_inspection_preserves_marker_and_still_cleans_up(self):
        for kind in ('compose-ps', 'daemon-containers'):
            with self.subTest(capture=kind):
                self.exercise_profile_failures(real_runner=True, inspection_failure=kind)

    def test_image_text_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['image-text']
        self.assertEqual(profile['suites'],(('e2e/test_viewer_image_text.py','ViewerImageTextE2E','ci-image-text'),))
        self.assertEqual(profile['out'].name,'image-text-ci')
        self.assertEqual(profile['project_prefix'],'kin-image-text-ci-')
        self.assertEqual(profile['suite_timeout'],900)

    def test_images_only_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['images-only']
        self.assertEqual(profile['suites'],(('e2e/test_viewer_images_only.py','ViewerImagesOnlyE2E','ci-images-only'),))
        self.assertEqual(profile['out'].name,'images-only-ci')
        self.assertEqual(profile['project_prefix'],'kin-images-only-ci-')
        self.assertEqual(profile['suite_timeout'],900)

    def test_study_arrivals_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['study-arrivals']
        self.assertEqual(profile['suites'],(('e2e/test_study_arrivals.py','StudyArrivalsE2E','ci-study-arrivals'),))
        self.assertEqual(profile['out'].name,'study-arrivals-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_display_scope_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['display-scope']
        self.assertEqual(profile['suites'],(('e2e/test_viewer_display_scope.py','ViewerDisplayScopeE2E','ci-display-scope'),))
        self.assertEqual(profile['out'].name,'display-scope-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_cell_merge_profile_is_exact_and_separate(self):
        profile = ci.PROFILES['cell-merge']
        self.assertEqual(profile['suites'], (('e2e/test_viewer_cell_merge.py', 'ViewerCellMergeE2E', 'ci-cell-merge'),))
        self.assertEqual(profile['out'].name, 'cell-merge-ci')
        self.assertEqual(profile['project_prefix'], 'kin-cell-merge-ci-')
        self.assertEqual(profile['suite_timeout'], 900)
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_viewer_cell_merge.py')
        self.assertEqual(command[command.index('--class')+1], 'ViewerCellMergeE2E')
        self.assertEqual(command[command.index('--timeout')+1], '900')
        self.assertEqual(outer, 935)
        for name, other in ci.PROFILES.items():
            if name == 'cell-merge':
                continue
            with self.subTest(profile=name):
                self.assertNotEqual(profile['out'], other['out'])
                self.assertNotEqual(profile['project_prefix'], other['project_prefix'])

    def test_validate_attribution_record_binds_exact_scanner_inputs(self):
        import argparse
        import shlex
        import yaml

        test_file = 'tests/admin_audit_attribution_test.cjs'
        workflow = yaml.safe_load((ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8'))
        commands = [shlex.split(step['run']) for job in workflow['jobs'].values()
                    for step in job.get('steps', []) if test_file in step.get('run', '')]
        self.assertEqual(len(commands), 1, 'one recorded attribution test invocation')
        command = commands[0]
        self.assertEqual(command[:2], ['python3', 'scripts/record-run.py'])
        boundary = command.index('--')
        self.assertEqual(command[-3:], ['node', '--test', test_file])
        parser = argparse.ArgumentParser()
        parser.add_argument('--run-dir', required=True)
        parser.add_argument('--cwd', default='.')
        parser.add_argument('--file', action='append', default=[])
        parser.add_argument('--tree', action='append', default=[])
        args = parser.parse_args(command[2:boundary])
        cwd = ci.ROOT / args.cwd
        recorded = [(cwd / name).resolve() for name in args.file]
        for name in args.tree:
            directory = cwd / name
            self.assertTrue(directory.is_dir(), name)
            recorded.extend(file.resolve() for file in directory.rglob('*') if file.is_file())

        # The scanner's stated corpus, plus its fixtures and compiler/generator inputs.
        # Expand the checked-out directories independently of the recorder options so
        # adding a source or accidentally recording an unrelated file cannot pass.
        read = set()
        for name in ('api/src', 'tests/fixtures/admin-audit-checker', 'tests/fixtures/admin_audit_completeness'):
            read.update(file.resolve() for file in (ci.ROOT / name).rglob('*') if file.is_file())
        read.update(file.resolve() for file in (ci.ROOT / 'api/prisma').glob('*.cjs') if file.is_file())
        read.update((ci.ROOT / name).resolve() for name in (
            'api/prisma/schema.prisma', 'api/tsconfig.json', 'api/package-lock.json', test_file))
        self.assertEqual(len(recorded), len(set(recorded)), 'no duplicate recorded inputs')
        self.assertSetEqual(set(recorded), read, 'recorded inputs must equal scanner inputs in both directions')

    def test_validate_workflow_runs_cell_merge_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  cell-merge:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one cell-merge job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile cell-merge',
                         'tests/execution_selection_test.py',
                         'tests/e2e/artifacts/cell-merge-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        # One standing gate, one live step bound like every other e2e job, and no
        # duplicate dispatch entry for the same suite.
        self.assertEqual(text.count('--profile cell-merge'), 1)
        self.assertNotIn('--profile cell-merge', jobs[0])
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        for profile in ['measurements', 'volume-rendering', 'volume-mpr', 'volume-slab', 'hanging-protocols']:
            self.assertEqual(text.count('--profile '+profile), 1)
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertNotIn('- cell-merge', dispatch)

    def test_u2b_regressions_profile_is_exact_and_fits_the_shared_deadline(self):
        # S5-CIE (Astra S5-EXIT-C-R-001 F03): the two live modules S5-U2b named as required regressions run
        # through one profile, in this order, each against its own declared class.
        profile = ci.PROFILES['u2b-regressions']
        self.assertEqual(profile['suites'], (
            ('e2e/test_prior_selection.py', 'PriorSelectionE2E', 'ci-u2b-prior-selection'),
            ('e2e/test_related_scope.py', 'RelatedScopeE2E', 'ci-u2b-related-scope')))
        self.assertEqual(profile['out'], ci.ROOT/'tests/e2e/artifacts/u2b-regressions-ci')
        self.assertEqual(profile['project_prefix'], 'kin-u2b-regress-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        self.assertNotIn('suite_budgets', profile)
        outers = []
        for suite, class_name, unit in profile['suites']:
            with self.subTest(suite=suite):
                command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
                self.assertEqual(command[command.index('--module')+1], 'tests/'+suite)
                self.assertEqual(command[command.index('--class')+1], class_name)
                self.assertEqual(command[command.index('--unit')+1], unit)
                self.assertEqual(command[command.index('--mode')+1], 'live')
                self.assertEqual(command[command.index('--timeout')+1], '540')
                self.assertEqual(outer, 575)
                outers.append(outer)
        # Both suites at their cap still leave the stack setup and cleanup their share of the one shared deadline.
        self.assertLessEqual(sum(outers), 25*60 - 350)

        # S5-CIE fix1 (Astra S5-CIE-R-001 F01): the deadline is observed from main() itself on a fake clock, where the
        # stack setup takes `setup` seconds and each suite spends its whole outer budget, not read from its source.
        def granted_budgets(setup):
            clock = [1000.0]
            fake_time = MagicMock()
            fake_time.monotonic.side_effect = lambda: clock[0]
            granted = []

            def fake_run(command, **kwargs):
                command = [str(part) for part in command]
                if any(part.endswith('run-tests.py') for part in command):
                    granted.append((int(command[command.index('--timeout')+1]), kwargs['timeout']))
                    clock[0] += kwargs['timeout']
                return MagicMock(returncode=0, stdout=b'', stderr=b'')

            def slow_setup():
                clock[0] += setup

            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                response = MagicMock(); response.__enter__.return_value.status = 200
                response.__enter__.return_value.read.return_value = b'{"memberRights":"ready"}'
                with patch.dict(os.environ, {'GITHUB_ACTIONS':'true', 'RUNNER_ENVIRONMENT':'github-hosted'}, clear=True), \
                     patch.object(ci, 'ROOT', root), \
                     patch.dict(ci.PROFILES, {'u2b-regressions': {**profile, 'out': root/'artifacts'}}), \
                     patch.object(ci, 'time', fake_time), \
                     patch.object(ci, 'seed_source', side_effect=slow_setup), \
                     patch.object(ci.subprocess, 'check_output', side_effect=[b'', b'', b'unix:///var/run/docker.sock']), \
                     patch.object(ci.subprocess, 'run', side_effect=fake_run), \
                     patch.object(ci.ssl, '_create_unverified_context', return_value=None), \
                     patch.object(ci, 'urlopen', return_value=response), \
                     patch.object(ci, 'ensure_imported_admin_credential', return_value='stub-imported-password'), \
                 contextlib.redirect_stdout(io.StringIO()):
                    ci.main('u2b-regressions')
                self.assertTrue((root/'artifacts'/'results.json').exists())
            return granted

        # 350s of setup: both suites still receive their full 540s inner and 575s outer budgets.
        self.assertEqual(granted_budgets(350), [(540, 575), (540, 575)])
        # One more second of setup and the second suite is already short: the shared deadline is exactly 25 minutes.
        self.assertEqual(granted_budgets(351), [(540, 575), (539, 574)])
        # Each suite's sanitized log is its own artifact file and never overwrites a stack step's log.
        logs = [Path(suite).stem for suite, _, _ in profile['suites']]
        self.assertEqual(len(set(logs)), 2)
        self.assertFalse(set(logs) & {'database', 'database-tcp', 'keycloak-database', 'stack', 'ports',
                                      'services', 'cleanup', 'results'})
        for name, other in ci.PROFILES.items():
            if name == 'u2b-regressions':
                continue
            with self.subTest(profile=name):
                self.assertNotEqual(profile['out'], other['out'])
                self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
                # Never run a second time inside another profile's budget.
                self.assertFalse({row[0] for row in other['suites']} & {row[0] for row in profile['suites']})

    def test_validate_workflow_runs_u2b_regressions_in_its_own_bounded_job(self):
        # S5-CIE fix1 (Astra S5-CIE-R-001 F01/F02): the workflow is read through the installed YAML parser and the
        # collection step through its own shell, so an equivalent spelling passes while a disabled upload, a missing
        # artifact path or a wrong timeout fails.
        import ast, fnmatch, re, shlex, shutil, subprocess
        import yaml

        def load(name):
            return yaml.safe_load((ci.ROOT/'.github/workflows'/name).read_text(encoding='utf-8'))

        def words(step):
            for line in str(step.get('run') or '').replace('\\\n', ' ').splitlines():
                try:
                    yield shlex.split(line, comments=True)
                except ValueError:
                    continue

        def profiles(step):
            # Every measurement_ci.py profile the step's shell requests, as --profile X or --profile=X.
            found = []
            for line in words(step):
                for index, word in enumerate(line):
                    if not word.endswith('tests/measurement_ci.py'):
                        continue
                    rest = line[index+1:]
                    for position, argument in enumerate(rest):
                        if argument == '--profile' and position+1 < len(rest):
                            found.append(rest[position+1])
                        elif argument.startswith('--profile='):
                            found.append(argument.split('=', 1)[1])
            return found

        def executes(step, script):
            # The script is an argument to run, not a --file input that record-run only hashes.
            return any(word == script and (index == 0 or line[index-1] != '--file')
                       for line in words(step) for index, word in enumerate(line))

        def always(step):
            return re.fullmatch(r'\s*(\$\{\{\s*always\(\)\s*\}\}|always\(\))\s*', str(step.get('if', ''))) is not None

        workflow = load('validate.yml')
        requests = [(name, index, found) for name, other in workflow['jobs'].items()
                    for index, step in enumerate(other.get('steps', [])) for found in profiles(step)]

        def requested(profile):
            return [(name, index) for name, index, found in requests if found == profile]

        job = workflow['jobs']['u2b-regressions']
        steps = job['steps']
        self.assertEqual(job['runs-on'], 'ubuntu-24.04')
        self.assertGreater(int(job['timeout-minutes']), 15 + 28)
        checkout = [step for step in steps if str(step.get('uses', '')).startswith('actions/checkout@')]
        self.assertEqual(len(checkout), 1)
        self.assertEqual(str(checkout[0]['with']['persist-credentials']).lower(), 'false')

        # One live step in the whole workflow runs this profile, in its own job, bounded at 28 minutes and unconditional.
        self.assertIn('u2b-regressions', ci.PROFILES)
        self.assertEqual(len(requested('u2b-regressions')), 1)
        (owner, live), = requested('u2b-regressions')
        self.assertEqual(owner, 'u2b-regressions')
        self.assertEqual(int(steps[live]['timeout-minutes']), 28)
        self.assertNotIn('if', steps[live])
        self.assertFalse(steps[live].get('continue-on-error', False))
        self.assertTrue(any(executes(step, 'tests/execution_selection_test.py') for step in steps[:live]))
        for profile in ['measurements', 'volume-rendering', 'volume-mpr', 'volume-slab', 'hanging-protocols', 'cell-merge']:
            self.assertEqual(len(requested(profile)), 1)

        # One upload, after the live step, that runs whatever the live step did.
        uploads = [index for index, step in enumerate(steps) if str(step.get('uses', '')).startswith('actions/upload-artifact@')]
        self.assertEqual(len(uploads), 1)
        upload, = uploads
        self.assertGreater(upload, live)
        self.assertTrue(always(steps[upload]))
        options = steps[upload]['with']
        self.assertEqual(options['name'], 'synthetic-u2b-regressions-results')
        self.assertEqual(sum(step.get('with', {}).get('name') == options['name']
                             for other in workflow['jobs'].values() for step in other.get('steps', [])), 1)
        paths = {line.strip().rstrip('/') for line in str(options['path']).splitlines() if line.strip()}
        self.assertEqual(paths, {'tests/e2e/artifacts/u2b-regressions-ci', 'tests/e2e/artifacts/test_d03a_*.png',
                                 'tests/e2e/artifacts/test_scope_*.png', 'tmp/u2b-regressions-ci'})
        self.assertEqual(options['if-no-files-found'], 'error')
        self.assertEqual(int(options['retention-days']), 7)

        def uploaded(relative):
            return any(relative == path or relative.startswith(path+'/') or fnmatch.fnmatchcase(relative, path)
                       for path in paths)

        # Every screenshot either suite writes reaches the artifact. The inherited viewer() names its file after the
        # running case under tests/e2e/artifacts/; fixed screenshot paths are resolved against the suite's cwd, ROOT.
        fixed = []
        for suite, class_name, _ in ci.PROFILES['u2b-regressions']['suites']:
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            declared = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
            cases = [node.name for node in declared.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
            self.assertEqual(len(cases), 2)
            for case in cases:
                with self.subTest(case=case):
                    self.assertTrue(uploaded('tests/e2e/artifacts/'+case+'-current.png'))
            fixed += [keyword.value.value for node in ast.walk(tree) if isinstance(node, ast.Call)
                      and isinstance(node.func, ast.Attribute) and node.func.attr == 'screenshot'
                      for keyword in node.keywords if keyword.arg == 'path'
                      and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str)]
        self.assertTrue(fixed)

        # The single step between the live step and the upload collects the fixed screenshots that land outside the
        # checkout; it is run here under bash -e, the runner's default shell for a run step without `shell`.
        between = steps[live+1:upload]
        self.assertEqual(len(between), 1)
        collect, = between
        self.assertTrue(always(collect))
        self.assertNotIn('shell', collect)
        bash = shutil.which('bash')
        self.assertIsNotNone(bash, 'the collection step is a bash run step')

        def collected(folder, sources):
            checkout = Path(folder)/'checkout'
            checkout.mkdir()
            for index, relative in enumerate(sources):
                target = (checkout/relative).resolve()
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'synthetic screenshot %d' % index)
            before = {path for path in checkout.rglob('*')}
            # On stdin, not -c: the Windows bash launcher re-parses a -c argument before bash sees it.
            result = subprocess.run([bash, '-e', '-s'], input=collect['run'].encode('utf-8'), cwd=checkout,
                                    capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            return {path.relative_to(checkout).as_posix(): path.read_bytes()
                    for path in checkout.rglob('*') if path.is_file() and uploaded(path.relative_to(checkout).as_posix())}, \
                   {path for path in checkout.rglob('*')} - before

        # A Windows bash (WSL) may still hold its former cwd when the folder is removed; only removal is tolerated.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            files, added = collected(folder, [])
            # A run that never reached the suite adds nothing and does not fail the evidence upload by itself.
            self.assertEqual((files, added), ({}, set()))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            files, _ = collected(folder, fixed)
            for index, relative in enumerate(fixed):
                with self.subTest(screenshot=relative):
                    self.assertIn(b'synthetic screenshot %d' % index, files.values())

        # A standing push/PR gate only; the manual dispatcher does not duplicate it.
        dispatch = load('output-integration.yml')
        triggers = dispatch.get('on', dispatch.get(True))
        self.assertNotIn('u2b-regressions', triggers['workflow_dispatch']['inputs']['profile']['options'])
        self.assertFalse([step for other in dispatch['jobs'].values() for step in other.get('steps', [])
                          if 'u2b-regressions' in profiles(step)])

    def test_image_thumbnails_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['image-thumbnails']
        self.assertEqual(profile['suites'],(('e2e/test_image_thumbnails.py','ImageThumbnailsE2E','ci-image-thumbnails'),))
        self.assertEqual(profile['out'].name,'image-thumbnails-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_source_pdf_profile_is_exact_and_has_separate_evidence(self):
        profile=ci.PROFILES['dicom-pdf']
        self.assertEqual(profile['suites'],(('e2e/test_dicom_pdf.py','DicomPdfE2E','ci-source-pdf'),))
        self.assertEqual(profile['out'].name,'dicom-pdf-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_hanging_protocol_flow_preserves_shared_boundary_sequence(self):
        profile = ci.PROFILES['hanging-protocols']
        self.assertEqual(profile['suites'], (
            ('invariants_live.py', None, 'ci-hp-invariants'),
            ('e2e/test_worklist.py', None, 'ci-hp-worklist'),
            ('hanging_protocol_api_live.py', 'HangingProtocolApiLive', 'ci-hp-account'),
            ('e2e/test_hanging_protocol.py', 'HangingProtocolE2E', 'ci-hp-native'),
        ))
        self.assertEqual(profile['out'].name, 'hanging-protocols-ci')
        self.assertEqual(profile['suite_timeout'], 400)

    def test_hanging_protocol_budget_cannot_starve_the_trailing_flows(self):
        profile = ci.PROFILES['hanging-protocols']
        budgets = profile['suite_budgets']
        units = [unit for _, _, unit in profile['suites']]
        # Every suite is budgeted, and nothing is budgeted that is not a suite.
        self.assertEqual(sorted(budgets), sorted(units))
        self.assertEqual(budgets, {'ci-hp-invariants': 400, 'ci-hp-worklist': 240,
                                   'ci-hp-account': 120, 'ci-hp-native': 300})
        # No budget may exceed the profile's own declared maximum, and none of them
        # may raise the 900 this profile used to request.
        self.assertLessEqual(max(budgets.values()), profile['suite_timeout'])
        self.assertTrue(all(value < 900 for value in budgets.values()))
        # Unlike every other profile, this one's ENTIRE configured worst case fits
        # main()'s single deadline, with room left for the stack it shares.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        worst_case = sum(budgets.values()) + 35*len(units)
        self.assertEqual(worst_case, 1200)
        # Measured on run 34703534031: 60.6s setup and 12.8s cleanup through this
        # same main() path. The reserve left over is 3.8x that.
        self.assertGreaterEqual(25*60 - worst_case, 4*74)
        # The required order is 69 -> 15 -> API -> e2e, so the new flow runs last;
        # even if everything ahead of it burns its whole budget and the stack takes
        # four times its measured time, the trailing suite keeps its full slice.
        ahead = sum(budgets[unit] + 35 for unit in units[:-1])
        self.assertEqual(units[-1], 'ci-hp-native')
        self.assertGreaterEqual(25*60 - ahead - 4*74, budgets['ci-hp-native'])

    def test_hanging_protocol_commands_are_exact_ordered_and_separately_capped(self):
        profile = ci.PROFILES['hanging-protocols']
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            self.assertEqual(command[command.index('--timeout')+1],
                             str(profile['suite_budgets'][unit]))
            self.assertEqual(outer, profile['suite_budgets'][unit] + 35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/invariants_live.py', 'tests/e2e/test_worklist.py',
                          'tests/hanging_protocol_api_live.py',
                          'tests/e2e/test_hanging_protocol.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-hp-invariants', 'ci-hp-worklist',
                          'ci-hp-account', 'ci-hp-native'])
        # The two shared boundary suites keep their own load_tests as the allowlist;
        # the two hanging-protocol suites stay pinned to their declared classes.
        self.assertNotIn('--class', commands[0])
        self.assertNotIn('--class', commands[1])
        self.assertEqual(commands[2][commands[2].index('--class')+1], 'HangingProtocolApiLive')
        self.assertEqual(commands[3][commands[3].index('--class')+1], 'HangingProtocolE2E')
        # A shrinking deadline shortens the request instead of overrunning it.
        near, _ = ci.guarded_profile_run(profile, *profile['suites'][3], 200)
        self.assertEqual(near[near.index('--timeout')+1], '165')
        # A separate Compose project and artifact directory from every other profile.
        for name, other in ci.PROFILES.items():
            if name == 'hanging-protocols':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('hanging-protocols', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_per_suite_budgets_leave_every_other_profile_unchanged(self):
        # The mapping is opt-in: a profile without it keeps requesting its own
        # maximum for every suite, exactly as before.
        # volume-mpr opted in when the curved MPR suite joined its runner; its exact
        # budgets are asserted in test_volume_mpr_profile_is_exact_bounded_and_isolated.
        # volume-slab opted in as the second MPR suite group; see its own exact test.
        for name, profile in ci.PROFILES.items():
            if name in ('hanging-protocols', 'volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch', 'volume-mip-output', 'volume-mip-orient'):
                self.assertIn('suite_budgets', profile)
                continue
            with self.subTest(profile=name):
                self.assertNotIn('suite_budgets', profile)
                for suite, class_name, unit in profile['suites']:
                    command, outer = ci.guarded_profile_run(
                        profile, suite, class_name, unit, 4000)
                    self.assertEqual(command[command.index('--timeout')+1],
                                     str(profile['suite_timeout']))
                    self.assertEqual(outer, profile['suite_timeout'] + 35)

    def test_validate_workflow_runs_hanging_protocols_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  hanging-protocols:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one hanging-protocols job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile hanging-protocols',
                         'tests/execution_selection_test.py',
                         'tests/e2e/artifacts/hanging-protocols-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        # The HP suites must not be appended to another job's budget, and the live
        # step keeps the same 28-minute bound as the existing e2e jobs.
        self.assertEqual(text.count('--profile hanging-protocols'), 1)
        self.assertNotIn('--profile hanging-protocols', jobs[0])
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        # Registering this standing gate must not disturb the gates already green.
        for profile in ['measurements', 'volume-rendering', 'volume-mpr', 'volume-slab']:
            self.assertEqual(text.count('--profile '+profile), 1)
        # The manual dispatch path for this profile stays available as well.
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertIn('- hanging-protocols', dispatch)
        self.assertIn('tests/e2e/artifacts/hanging-protocols-ci/', dispatch)

    def test_three_d_cursor_accuracy_profile_is_exact_and_dispatch_only(self):
        import ast
        profile = ci.PROFILES['three-d-cursor-accuracy']
        self.assertEqual(profile['suites'], (('e2e/test_three_d_cursor_accuracy.py',
                         'ThreeDCursorAccuracyE2E', 'ci-three-d-cursor-accuracy'),))
        self.assertEqual(profile['out'].name, 'three-d-cursor-accuracy-ci')
        self.assertEqual(profile['project_prefix'], 'kin-3d-cursor-acc-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_three_d_cursor_accuracy.py')
        self.assertEqual(command[command.index('--class')+1], 'ThreeDCursorAccuracyE2E')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        tree = ast.parse((ci.ROOT/'tests/e2e/test_three_d_cursor_accuracy.py').read_text(encoding='utf-8'))
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                   and node.name == 'ThreeDCursorAccuracyE2E')
        declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                    and node.name.startswith('test_')]
        self.assertEqual(len(declared), 3)
        self.assertTrue(all(name.startswith('test_cursor_accuracy_') for name in declared))
        # No push gate: the profile reaches CI only through the manual dispatch workflow.
        validate = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        self.assertNotIn('three-d-cursor-accuracy', validate)
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertIn('- three-d-cursor-accuracy', dispatch)
        self.assertIn('tests/e2e/artifacts/three-d-cursor-accuracy-ci/', dispatch)
        self.assertIn('tests/e2e/artifacts/THREE-D-CURSOR-ACCURACY-*.png', dispatch)

    def test_three_d_cursor_wiring_profile_is_exact_and_dispatch_only(self):
        import ast
        profile = ci.PROFILES['three-d-cursor-wiring']
        self.assertEqual(profile['suites'], (('e2e/test_three_d_cursor_wiring.py',
                         'ThreeDCursorWiringE2E', 'ci-three-d-cursor-wiring'),))
        self.assertEqual(profile['out'].name, 'three-d-cursor-wiring-ci')
        self.assertEqual(profile['project_prefix'], 'kin-3d-cursor-wire-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        # A separate profile, a separate Compose project and a separate artifact directory: the
        # accuracy run and the wiring run never share one.
        accuracy = ci.PROFILES['three-d-cursor-accuracy']
        self.assertNotEqual(profile['out'], accuracy['out'])
        self.assertNotEqual(profile['project_prefix'], accuracy['project_prefix'])
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_three_d_cursor_wiring.py')
        self.assertEqual(command[command.index('--class')+1], 'ThreeDCursorWiringE2E')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        source = (ci.ROOT/'tests/e2e/test_three_d_cursor_wiring.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                   and node.name == 'ThreeDCursorWiringE2E')
        declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                    and node.name.startswith('test_')]
        self.assertEqual(len(declared), 3)
        self.assertTrue(all(name.startswith('test_wiring_') for name in declared))
        # The point of the suite: the modules must arrive through config/ohif.js, so the harness's
        # own injection call may not appear in it.
        self.assertNotIn('.add_script_tag(', source)
        # No push gate: the profile reaches CI only through the manual dispatch workflow.
        validate = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        self.assertNotIn('three-d-cursor-wiring', validate)
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertIn('- three-d-cursor-wiring', dispatch)
        self.assertIn('tests/e2e/artifacts/three-d-cursor-wiring-ci/', dispatch)
        self.assertIn('tests/e2e/artifacts/THREE-D-CURSOR-WIRING-*.png', dispatch)

    def test_critical_result_screens_profile_is_exact_and_dispatch_only(self):
        # S7-U2b (TEST-S7-U2b-E2E, OP-1 A): the six screen cases of one declared class in one unit at the D-S7-12 (a) live cap,
        # dispatched once per candidate through Focused integration and never a push or PR gate. The workflows are read with
        # the installed YAML parser and the e2e module with ast (it is not imported: this runs before any browser package).
        import ast, shlex
        import yaml
        profile = ci.PROFILES['critical-result-screens']
        suite, class_name, unit = 'e2e/test_critical_result.py', 'CriticalResultScreensE2E', 'ci-s7-u2b-critical-result-screens'
        self.assertEqual(profile['suites'], ((suite, class_name, unit),))
        self.assertEqual(profile['out'].name, 'critical-result-screens-ci')
        self.assertEqual(profile['project_prefix'], 'kin-cvr-screens-ci-')
        self.assertEqual(profile['suite_timeout'], 900)
        self.assertNotIn('suite_budgets', profile)
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/'+suite)
        self.assertEqual(command[command.index('--class')+1], class_name)
        self.assertEqual(command[command.index('--unit')+1], unit)
        self.assertEqual(command[command.index('--mode')+1], 'live')
        self.assertEqual(command[command.index('--timeout')+1], '900')
        self.assertEqual(outer, 935)
        for name, other in ci.PROFILES.items():
            if name == 'critical-result-screens':
                continue
            with self.subTest(profile=name):
                self.assertNotEqual(profile['out'], other['out'])
                self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
                # The module's S7-U1a API class stays outside every hosted budget, this one included (OP-3).
                self.assertNotIn(suite, [row[0] for row in other['suites']])
                self.assertNotIn(unit, [row[2] for row in other['suites']])
        tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
        declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        # Equal, not at least: a case that silently disappears fails here (test-plan section 3, CRS-01..CRS-06 in order).
        self.assertEqual(declared, [
            'test_crs01_two_sessions_send_list_refuse_acknowledge_replay_supersede_cancel',
            'test_crs02_revoked_recipient_old_session_cannot_acknowledge_new_session_sees_nothing',
            'test_crs03_wrong_role_and_other_institution_are_offered_nothing',
            'test_crs04_lost_answers_stay_unknown_until_a_read_or_check_again_proves_them',
            'test_crs05_moved_head_before_send_is_refused_and_the_dialog_rereads_the_version',
            'test_crs06_account_switch_in_one_browser_keeps_nothing_of_the_first_recipient'])
        # The module's own allowlist for a class-less run: the inherited WorklistE2E cases never load.
        self.assertTrue(any(isinstance(node, ast.FunctionDef) and node.name == 'load_tests' for node in tree.body))

        def load(name):
            return yaml.safe_load((ci.ROOT/'.github/workflows'/name).read_text(encoding='utf-8'))

        def profiles(step):
            found = []
            for line in str(step.get('run') or '').replace('\\\n', ' ').splitlines():
                try:
                    words = shlex.split(line, comments=True)
                except ValueError:
                    continue
                for index, word in enumerate(words):
                    if word.endswith('tests/measurement_ci.py'):
                        rest = words[index+1:]
                        found += [rest[i+1] for i, arg in enumerate(rest[:-1]) if arg == '--profile']
                        found += [arg.split('=', 1)[1] for arg in rest if arg.startswith('--profile=')]
            return found
        # Dispatch only: no validate.yml step requests the profile.
        validate = load('validate.yml')
        self.assertFalse([step for job in validate['jobs'].values() for step in job.get('steps', [])
                          if 'critical-result-screens' in profiles(step)])
        self.assertNotIn('critical-result-screens', (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8'))
        dispatch = load('output-integration.yml')
        triggers = dispatch.get('on', dispatch.get(True))
        self.assertEqual(triggers['workflow_dispatch']['inputs']['profile']['options'].count('critical-result-screens'), 1)
        uploads = [step for job in dispatch['jobs'].values() for step in job.get('steps', [])
                   if str(step.get('uses', '')).startswith('actions/upload-artifact@')]
        paths = {line.strip().rstrip('/') for step in uploads for line in str(step['with']['path']).splitlines() if line.strip()}
        self.assertIn('tests/e2e/artifacts/critical-result-screens-ci', paths)

    def test_profiles_are_exact_and_use_separate_owned_artifacts(self):
        self.assertEqual(set(ci.PROFILES),
                         {'context-loss', 'measurements', 'volume-rendering', 'output-integration',
                          'identity-fields', 'vr-resize-probe', 'hanging-protocols', 'dicom-pdf', 'image-thumbnails', 'display-scope', 'study-arrivals', 'images-only', 'image-text',
                          'three-d-cursor-accuracy', 'three-d-cursor-wiring', 'volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch', 'volume-mip-output', 'volume-mip-orient', 'cell-merge', 'u2b-regressions',
                          'gateway-e2e', 'critical-result-screens',
                          # EMR-B1: the access ledger profile, run only by .github/workflows/emr-b.yml.
                          'emr-b',
                          # S7-U5: the session contract job's eight profiles (validate.yml s7-u5-session-contracts matrix);
                          # u5-fixups is the fix round's five screen regressions (final review part 1, blocker 3).
                          'u5-session-api', 'u5-session-draft', 'u5-session-regression', 'u5-session-boundaries',
                          'u5-session-mutants', 'u5-session-browser', 'u5-session-end', 'u5-fixups'})
        validate = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        self.assertIn('profile: [u5-session-api, u5-session-draft, u5-session-regression, u5-session-boundaries, '
                      'u5-session-mutants, u5-session-browser, u5-session-end, u5-fixups]', validate)
        self.assertEqual(ci.PROFILES['u5-session-end']['suites'],
                         (('live/session_end_live.py', 'SessionEndLive', 'ci-u5-session-end'),))
        self.assertEqual(ci.PROFILES['u5-fixups']['suites'], (('e2e/test_u5_fixups.py', None, 'ci-u5-fixups'),))
        self.assertEqual(ci.PROFILES['u5-fixups']['suite_timeout'], 900)
        self.assertNotIn('suite_budgets', ci.PROFILES['u5-fixups'])
        self.assertEqual(ci.PROFILES['u5-fixups']['out'].name, 'u5-fixups-ci')
        for name in ('u5-session-api', 'u5-session-draft', 'u5-session-regression', 'u5-session-boundaries',
                     'u5-session-mutants', 'u5-session-browser', 'u5-session-end', 'u5-fixups'):
            for suite in ci.PROFILES[name]['suites']:
                self.assertTrue((ci.ROOT/'tests'/suite[0]).is_file(), (name, suite[0]))
        measurements = ci.PROFILES['measurements']
        volume = ci.PROFILES['volume-rendering']
        output = ci.PROFILES['output-integration']
        identity = ci.PROFILES['identity-fields']
        self.assertEqual([row[:2] for row in measurements['suites']],
                         list(zip(ci.SUITES, ci.SUITE_CLASSES)))
        # S2-B1 and then S3-ASR-U4L each append one browser suite to this existing profile (review C5):
        # the exact 20 suites in order, the unchanged per-suite cap and shared deadline, and no new profile.
        self.assertEqual(list(zip(ci.SUITES, ci.SUITE_CLASSES)), [
            ('viewer_api_test.py', 'ViewerAPI'), ('e2e/test_measurement_readback.py', 'MeasurementReadbackE2E'),
            ('e2e/test_measurement_panel.py', 'MeasurementPanelE2E'), ('e2e/test_held_measurements.py', 'HeldMeasurementE2E'),
            ('e2e/test_manual_sr.py', 'ManualSrE2E'), ('e2e/test_measurement_recheck.py', 'MeasurementRecheckE2E'),
            ('e2e/test_viewer_recovery.py', 'ViewerRecoveryE2E'), ('e2e/test_measurement_calibration.py', 'MeasurementCalibrationE2E'),
            ('e2e/test_worklist_body_parts.py', 'WorklistBodyPartsE2E'), ('reading_appearance_live.py', 'ReadingAppearanceLive'),
            ('reading_appearance_position_live.py', 'ReadingAppearancePositionLive'), ('e2e/test_viewer_identity_position.py', 'ViewerIdentityPositionE2E'),
            ('reading_appearance_fields_live.py', 'ReadingAppearanceFieldsLive'), ('e2e/test_viewer_identity_fields.py', 'ViewerIdentityFieldsE2E'),
            ('e2e/test_cine.py', 'CineE2E'), ('e2e/test_volume_cine.py', 'VolumeCineE2E'),
            ('finding_api_test.py', 'FindingAPI'), ('e2e/test_finding_navigation.py', 'FindingNavigationE2E'),
            ('e2e/test_finding_worklist.py', 'FindingWorklistE2E'), ('e2e/test_dictation_live.py', 'DictationLiveE2E')])
        self.assertEqual(measurements['suites'][-1],
                         ('e2e/test_dictation_live.py', 'DictationLiveE2E', 'ci-test-dictation-live'))
        self.assertEqual(len({row[2] for row in measurements['suites']}), 20)
        self.assertEqual(measurements['suite_timeout'], 540)
        self.assertNotIn('suite_budgets', measurements)
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertEqual(volume['suites'], (('e2e/test_volume_rendering.py',
                         None, 'ci-volume-rendering'),))
        self.assertEqual(output['suites'], (
            ('e2e/test_compare_reports.py', 'CompareReportsE2E',
             'ci-output-compare-reports'),
            ('e2e/test_viewer_job_report.py', 'ViewerJobReportE2E',
             'ci-output-viewer-job-report'),
            ('e2e/test_editor_compare_output.py', 'EditorCompareOutputE2E',
             'ci-output-editor-compare-output'),
        ))
        self.assertEqual(output['suite_timeout'], 900)
        self.assertEqual(identity['suites'], (
            ('reading_appearance_live.py', 'ReadingAppearanceLive',
             'ci-identity-reading-appearance'),
            ('reading_appearance_position_live.py', 'ReadingAppearancePositionLive',
             'ci-identity-reading-position'),
            ('reading_appearance_fields_live.py', 'ReadingAppearanceFieldsLive',
             'ci-identity-reading-fields'),
            ('e2e/test_viewer_identity_position.py', 'ViewerIdentityPositionE2E',
             'ci-identity-viewer-position'),
            ('e2e/test_viewer_identity_fields.py', 'ViewerIdentityFieldsE2E',
             'ci-identity-viewer-fields'),
        ))
        self.assertEqual(identity['suite_timeout'], 540)
        self.assertEqual(len({measurements['out'], volume['out'], output['out'],
                              identity['out']}), 4)
        self.assertEqual(volume['out'].name, 'volume-rendering-ci')
        self.assertEqual(output['out'].name, 'output-integration-ci')
        self.assertEqual(identity['out'].name, 'identity-fields-ci')
        hostile={key:'https://outside.invalid' for key in ['KIN_TEST_PROXY','KIN_TEST_API',
                 'KIN_TEST_TOKEN_URL','KIN_TEST_ORTHANC','KIN_TEST_ORTHANC_USER',
                 'KIN_TEST_ORTHANC_PASSWORD']}
        with patch.dict(os.environ, {**hostile, 'KIN_EVIDENCE_DIR':'caller-value'}, clear=False):
            values={'ORTHANC_PASS':'generated-orthanc-password'}
            stage=Path('private-stage')
            measurement_env=ci.profile_environment('measurements', measurements['out'], values)
            self.assertNotIn('KIN_EVIDENCE_DIR', measurement_env)
            volume_env=ci.profile_environment('volume-rendering', volume['out'], values, stage)
            self.assertEqual(volume_env
                             ['KIN_EVIDENCE_DIR'], str(stage))
            output_env=ci.profile_environment('output-integration', output['out'], values)
            self.assertNotIn('KIN_EVIDENCE_DIR', output_env)
            identity_env=ci.profile_environment('identity-fields', identity['out'], values)
            self.assertNotIn('KIN_EVIDENCE_DIR', identity_env)
            expected={
                'KIN_TEST_PROXY':'https://localhost:9443',
                'KIN_TEST_API':'https://localhost:9443/api',
                'KIN_TEST_TOKEN_URL':'http://127.0.0.1:8080/auth/realms/kin/protocol/openid-connect/token',
                'KIN_TEST_ORTHANC':'http://127.0.0.1:8042',
                'KIN_TEST_ORTHANC_USER':'admin',
                'KIN_TEST_ORTHANC_PASSWORD':'generated-orthanc-password'}
            self.assertEqual({key:measurement_env[key] for key in hostile}, expected)
            self.assertEqual({key:volume_env[key] for key in hostile}, expected)
            self.assertEqual({key:output_env[key] for key in hostile}, expected)
            self.assertEqual({key:identity_env[key] for key in hostile}, expected)

    def test_volume_mpr_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mpr']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_crosshair.py', None, 'ci-mpr-crosshair'),
            ('e2e/test_volume_display.py', None, 'ci-mpr-display'),
            ('e2e/test_volume_curved.py', None, 'ci-mpr-curved'),
        ))
        self.assertEqual(profile['out'].name, 'volume-mpr-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mpr-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420}
        self.assertEqual(profile['suite_budgets'], budgets)
        # A separate Compose project and a separate artifact directory from every
        # other profile, so a lost isolation edit fails here rather than in CI.
        for name, other in ci.PROFILES.items():
            if name == 'volume-mpr':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_crosshair.py',
                          'tests/e2e/test_volume_display.py',
                          'tests/e2e/test_volume_curved.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-mpr-crosshair', 'ci-mpr-display', 'ci-mpr-curved'])
        # All suites share main()'s single deadline, so no one suite may be able to
        # claim it: even at full cap every suite plus its reserved margin must fit
        # with stack time left, and the cap must stay under the volume-rendering cap.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        self.assertLess(profile['suite_timeout'],
                        ci.PROFILES['volume-rendering']['suite_timeout'])
        # A shrinking deadline shortens the request instead of overrunning it.
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mpr', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mpr_modules_declare_exact_eleven_and_twelve_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_crosshair.py', 'VolumeCrosshairE2E', 'test_crosshair_', 12),
                ('e2e/test_volume_display.py', 'VolumeDisplayE2E', 'test_mpr_display_', 12),
                ('e2e/test_volume_curved.py', 'VolumeCurvedE2E', 'test_curved_', 4)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            # The module-level load_tests filters on exactly this prefix, so a
            # renamed or re-parented case would silently drop out of CI.
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            literals = [node.value for node in ast.walk(load_tests)
                        if isinstance(node, ast.Constant) and node.value == prefix]
            self.assertTrue(literals)

    def test_validate_workflow_runs_volume_mpr_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mpr:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mpr job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        mpr = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-mpr',
                         'tests/e2e/artifacts/volume-mpr-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, mpr)
        # The MPR suites must not be appended to the volume-rendering job's budget.
        self.assertNotIn('--profile volume-mpr', jobs[0])
        self.assertEqual(text.count('--profile volume-mpr'), 1)
        self.assertEqual(text.count('--profile volume-rendering'), 1)
        # The existing pure volume model gate stays registered exactly once.
        self.assertEqual(text.count('tmp/vr-ci/pure-volume-models'), 1)

    def test_volume_slab_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-slab']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_projection.py', None, 'ci-slab-projection'),
            ('e2e/test_volume_wheel.py', None, 'ci-slab-wheel'),
            ('e2e/test_volume_average_affine.py', None, 'ci-slab-average-affine'),
            ('e2e/test_volume_mip.py', None, 'ci-slab-mip-viewer'),
        ))
        self.assertEqual(profile['out'].name, 'volume-slab-ci')
        self.assertEqual(profile['project_prefix'], 'kin-slab-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering the slab suites must not widen or cut the first MPR group.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        mpr_modules = {row[0] for row in ci.PROFILES['volume-mpr']['suites']}
        self.assertFalse(mpr_modules & {row[0] for row in profile['suites']})
        for name, other in ci.PROFILES.items():
            if name == 'volume-slab':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_projection.py',
                          'tests/e2e/test_volume_wheel.py',
                          'tests/e2e/test_volume_average_affine.py',
                          'tests/e2e/test_volume_mip.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-slab-projection', 'ci-slab-wheel', 'ci-slab-average-affine', 'ci-slab-mip-viewer'])
        # Every suite at full cap plus its reserved margin fits the shared deadline with
        # stack time left, and no cap may exceed the profile maximum.
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-slab', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_slab_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_projection.py', 'VolumeProjectionE2E', 'test_projection_', 8),
                ('e2e/test_volume_wheel.py', 'VolumeWheelE2E', 'test_wheel_', 4),
                ('e2e/test_volume_average_affine.py', 'VolumeAverageAffineE2E', 'test_average_affine_', 2),
                ('e2e/test_volume_mip.py', 'VolumeMipE2E', 'test_mip_', 6)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_slab_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-slab:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-slab job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-slab',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_projection.py',
                         '--file tests/e2e/test_volume_wheel.py',
                         '--file tests/e2e/test_volume_average_affine.py',
                         '--file tests/e2e/test_volume_mip.py',
                         'tests/e2e/artifacts/volume-slab-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-slab'), 1)
        self.assertNotIn('--profile volume-slab', jobs[0])
        # The slab suites stay out of the first MPR job's shared deadline.
        mpr = text.split('\n  volume-mpr:\n')[1].split('\n  volume-slab:\n')[0]
        self.assertNotIn('--profile volume-slab', mpr)
        self.assertEqual(text.count('--profile volume-mpr'), 1)
        # The MIP Viewer model is listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-mip.js', pure)
        self.assertEqual(pure.count('tests/volume_mip_test.cjs'), 2)
        self.assertIn('tests/volume_mip_test.cjs', pure.rsplit(' --test ', 1)[1])
        # The protected VOI Slab geometry model and its unchanged tests run in the same pure gate.
        self.assertIn('--file worklist-v0/hpacs-lite/volume-voi.js', pure)
        self.assertEqual(pure.count('tests/volume_voi_test.cjs'), 2)
        self.assertIn(' --file tests/volume_voi_test.cjs --file ', pure)
        self.assertIn('tests/volume_voi_test.cjs', pure.rsplit(' --test ', 1)[1])

    def test_volume_path_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-path']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_path.py', None, 'ci-path-native'),
            ('e2e/test_volume_orientation.py', None, 'ci-mpr-orientation'),
            ('e2e/test_finding_locations.py', None, 'ci-finding-location'),
        ))
        self.assertEqual(profile['out'].name, 'volume-path-ci')
        self.assertEqual(profile['project_prefix'], 'kin-path-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-path-native': 420, 'ci-mpr-orientation': 300, 'ci-finding-location': 360}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering the path group must not widen or cut the first two MPR groups.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name in ('volume-mpr', 'volume-slab', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-path':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_path.py', 'tests/e2e/test_volume_orientation.py',
                          'tests/e2e/test_finding_locations.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-path-native', 'ci-mpr-orientation', 'ci-finding-location'])
        # All three suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1185)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-path', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_path_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_path.py', 'VolumePathE2E', 'test_path_', 4),
                ('e2e/test_volume_orientation.py', 'VolumeOrientationE2E', 'test_orientation_', 6),
                ('e2e/test_finding_locations.py', 'FindingLocationsE2E', 'test_location_', 3)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_finding_location_suite_is_selected_only_by_volume_path(self):
        # S2-L adds one module to volume-path and nothing anywhere else (no new profile).
        suite = 'e2e/test_finding_locations.py'
        owners = [name for name, profile in ci.PROFILES.items()
                  if suite in {row[0] for row in profile['suites']}]
        self.assertEqual(owners, ['volume-path'])
        self.assertNotIn(suite, ci.SUITES)
        units = [row[2] for profile in ci.PROFILES.values() for row in profile['suites']]
        self.assertEqual(units.count('ci-finding-location'), 1)
        for name, profile in ci.PROFILES.items():
            if name != 'volume-path':
                self.assertNotIn('ci-finding-location', profile.get('suite_budgets', {}), name)
        # The measurements profile keeps its 20 suites and its unchanged per-suite cap.
        measurements = ci.PROFILES['measurements']
        self.assertEqual(len(measurements['suites']), 20)
        self.assertEqual(measurements['suite_timeout'], 540)
        self.assertNotIn('suite_budgets', measurements)
        # Its base class belongs to volume-marks, which does not gain the location module or its unit.
        marks = ci.PROFILES['volume-marks']
        self.assertNotIn(suite, {row[0] for row in marks['suites']})
        self.assertNotIn('e2e/test_volume_marks.py', {row[0] for row in ci.PROFILES['volume-path']['suites']})
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        self.assertEqual(text.count('--file tests/e2e/test_finding_locations.py'), 1)
        self.assertIn('--file tests/e2e/test_finding_locations.py',
                      text.split('\n  volume-path:\n')[1].split('\n  volume-batch:\n')[0])

    def test_validate_workflow_runs_volume_path_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-path:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-path job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-path',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_path_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_path.py',
                         '--file tests/e2e/test_volume_orientation.py',
                         '--file tests/e2e/test_finding_locations.py',
                         'tests/e2e/artifacts/volume-path-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-path'), 1)
        self.assertNotIn('--profile volume-path', jobs[0])
        # The path suites stay out of the first two MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-path', text.split('\n  '+other+':\n')[1].split('\n  volume-path:\n')[0])
        # The pure path model runs in the existing pure model gate (listed and executed), and the
        # compiled server Job checks keep running in the runtime gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-path.js', pure)
        self.assertEqual(pure.count('tests/volume_path_test.cjs'), 2)
        self.assertIn('tests/viewer_volume_job_capture_test.cjs', pure.rsplit(' --test ', 1)[1])
        runtime = next(line for line in text.splitlines() if 'tmp/runtime-ci/volume-api-models' in line)
        self.assertIn('/tests/viewer_volume_job_test.cjs', runtime.rsplit(' --test ', 1)[1])

    def test_volume_batch_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-batch']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_batch.py', None, 'ci-batch-preview'),
            ('e2e/test_volume_batch_context.py', None, 'ci-batch-context'),
            ('e2e/test_volume_batch_save.py', None, 'ci-batch-save'),
            ('e2e/test_volume_batch_scout.py', None, 'ci-batch-scout'),
        ))
        self.assertEqual(profile['out'].name, 'volume-batch-ci')
        self.assertEqual(profile['project_prefix'], 'kin-batch-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-batch-preview': 240, 'ci-batch-context': 240, 'ci-batch-save': 360, 'ci-batch-scout': 240}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering the batch group must not widen or cut the other MPR groups.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        self.assertEqual(ci.PROFILES['volume-path']['suite_budgets'],
                         {'ci-path-native': 420, 'ci-mpr-orientation': 300, 'ci-finding-location': 360})
        modules = {row[0] for row in profile['suites']}
        # Saved batch print is its own requirement and suite; it is not part of this group.
        self.assertNotIn('e2e/test_volume_batch_print.py', modules)
        for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-batch':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_batch.py', 'tests/e2e/test_volume_batch_context.py',
                          'tests/e2e/test_volume_batch_save.py', 'tests/e2e/test_volume_batch_scout.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-batch-preview', 'ci-batch-context', 'ci-batch-save', 'ci-batch-scout'])
        # All four suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1220)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][2], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-batch', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_batch_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_batch.py', 'VolumeBatchE2E', 'test_batch_', 6),
                ('e2e/test_volume_batch_context.py', 'VolumeBatchContextE2E', 'test_batch_context_', 5),
                ('e2e/test_volume_batch_save.py', 'VolumeBatchSaveE2E', 'test_batch_save_', 8),
                ('e2e/test_volume_batch_scout.py', 'VolumeBatchScoutE2E', 'test_scout_', 5)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_batch_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-batch:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-batch job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-batch',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_batch_binding_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_batch.py',
                         '--file tests/e2e/test_volume_batch_context.py',
                         '--file tests/e2e/test_volume_batch_save.py',
                         '--file tests/e2e/test_volume_batch_scout.py',
                         '--file worklist-v0/hpacs-lite/viewer-volume-batch.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-scout.js',
                         'tests/e2e/artifacts/volume-batch-ci/',
                         'tests/e2e/artifacts/MPR-batch-*.png',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-batch'), 1)
        self.assertNotIn('--profile volume-batch', jobs[0])
        # The batch suites stay out of the other MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab', 'volume-path'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-batch', text.split('\n  '+other+':\n')[1].split('\n  volume-batch:\n')[0])
        # The pure batch and scout models stay listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        for model in ('tests/volume_batch_test.cjs', 'tests/volume_batch_scout_test.cjs'):
            self.assertEqual(pure.count(model), 2)
            self.assertIn(model, pure.rsplit(' --test ', 1)[1])

    def test_volume_sync_preferences_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-sync-preferences']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_sync.py', None, 'ci-mpr-sync'),
            ('e2e/test_volume_preferences.py', None, 'ci-mpr-preferences'),
        ))
        self.assertEqual(profile['out'].name, 'volume-sync-preferences-ci')
        self.assertEqual(profile['project_prefix'], 'kin-syncpref-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-mpr-sync': 420, 'ci-mpr-preferences': 480}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering this group must not widen or cut the other MPR groups.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        self.assertEqual(ci.PROFILES['volume-path']['suite_budgets'],
                         {'ci-path-native': 420, 'ci-mpr-orientation': 300, 'ci-finding-location': 360})
        self.assertEqual(ci.PROFILES['volume-batch']['suite_budgets'],
                         {'ci-batch-preview': 240, 'ci-batch-context': 240, 'ci-batch-save': 360, 'ci-batch-scout': 240})
        modules = {row[0] for row in profile['suites']}
        # Manual 3D marks and MPR printing inherit these suites but are separate requirements, not this group.
        for excluded in ('e2e/test_volume_marks.py', 'e2e/test_volume_mpr_print.py', 'e2e/test_volume_current_print.py'):
            self.assertNotIn(excluded, modules)
        for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-sync-preferences':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # Stable attempt units that no other profile shares.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        # Band diagnostics would go to another profile's folder; neither module reads bands.
        for suite in modules:
            self.assertNotIn('band_pixels(', (ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_sync.py', 'tests/e2e/test_volume_preferences.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-mpr-sync', 'ci-mpr-preferences'])
        # Both suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 970)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-sync-preferences', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_sync_preferences_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_sync.py', 'VolumeSyncE2E', 'test_sync_', 16),
                ('e2e/test_volume_preferences.py', 'VolumePreferencesE2E', 'test_properties_', 18)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_sync_preferences_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-sync-preferences:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-sync-preferences job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-sync-preferences',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_preferences_layout_dom_test.py',
                         'tests/viewer_volume_sync_layout_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_sync.py',
                         '--file tests/e2e/test_volume_preferences.py',
                         '--file worklist-v0/hpacs-lite/viewer-volume-sync.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-preferences.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-progressive.js',
                         'tests/e2e/artifacts/volume-sync-preferences-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-sync-preferences'), 1)
        self.assertNotIn('--profile volume-sync-preferences', jobs[0])
        # These suites stay out of the other MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-sync-preferences', text.split('\n  '+other+':\n')[1].split('\n  volume-sync-preferences:\n')[0])
        # The pure preference model stays listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-preferences.js', pure)
        self.assertEqual(pure.count('tests/volume_preferences_test.cjs'), 2)
        self.assertIn('tests/volume_preferences_test.cjs', pure.rsplit(' --test ', 1)[1])

    def test_volume_marks_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-marks']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_marks.py', None, 'ci-mpr-marks'),
            ('e2e/test_volume_mpr_print.py', None, 'ci-mpr-marks-print'),
        ))
        self.assertEqual(profile['out'].name, 'volume-marks-ci')
        self.assertEqual(profile['project_prefix'], 'kin-marks-ci-')
        self.assertEqual(profile['suite_timeout'], 660)
        budgets = {'ci-mpr-marks': 660, 'ci-mpr-marks-print': 420}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering this group must not widen or cut the other MPR groups.
        self.assertEqual(ci.PROFILES['volume-batch']['suite_budgets'],
                         {'ci-batch-preview': 240, 'ci-batch-context': 240, 'ci-batch-save': 360, 'ci-batch-scout': 240})
        self.assertEqual(ci.PROFILES['volume-sync-preferences']['suite_budgets'],
                         {'ci-mpr-sync': 420, 'ci-mpr-preferences': 480})
        modules = {row[0] for row in profile['suites']}
        # Current unsaved output inherits the saved output suite but is a separate requirement, not this group.
        self.assertNotIn('e2e/test_volume_current_print.py', modules)
        for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-marks':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # Stable attempt units that no other profile shares.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        # Band diagnostics would go to another profile's folder; neither module reads bands.
        for suite in modules:
            self.assertNotIn('band_pixels(', (ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_marks.py', 'tests/e2e/test_volume_mpr_print.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-mpr-marks', 'ci-mpr-marks-print'])
        # Both suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1150)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-marks', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_marks_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_marks.py', 'VolumeMarksE2E', 'test_marks_', 20),
                ('e2e/test_volume_mpr_print.py', 'VolumeMprPrintE2E', 'test_mpr_print_', 9)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            # The output suite declares four of its cases by assigning batch print cases to local names.
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            declared += [target.id for node in cls.body if isinstance(node, ast.Assign)
                         for target in node.targets if isinstance(target, ast.Name) and target.id.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertEqual(len(set(declared)), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_marks_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-marks:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-marks job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-marks',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_marks_progressive_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_marks.py',
                         '--file tests/e2e/test_volume_mpr_print.py',
                         '--file worklist-v0/hpacs-lite/viewer-volume-marks.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-progressive.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-job-print.js',
                         'tests/e2e/artifacts/volume-marks-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-marks'), 1)
        self.assertNotIn('--profile volume-marks', jobs[0])
        # These suites stay out of the other MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-marks', text.split('\n  '+other+':\n')[1].split('\n  volume-marks:\n')[0])
        # The pure annotation model stays listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-marks.js', pure)
        self.assertEqual(pure.count('tests/volume_marks_test.cjs'), 2)
        self.assertIn('tests/volume_marks_test.cjs', pure.rsplit(' --test ', 1)[1])

    def test_volume_mip_voi_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-voi']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_voi.py', None, 'ci-mip-voi'),))
        self.assertEqual(profile['out'].name, 'volume-mip-voi-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipvoi-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-voi': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Splitting the VOI Slab cases out must not widen or cut the slab group they came from.
        slab = ci.PROFILES['volume-slab']
        self.assertEqual(slab['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        self.assertEqual(len(slab['suites']), 4)
        self.assertIn(('e2e/test_volume_mip.py', None, 'ci-slab-mip-viewer'), slab['suites'])
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-voi':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets ci-slab-mip-viewer's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_voi.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-voi')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        # The one suite at full cap plus its reserved margin fits the shared deadline with stack time left.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertEqual(25*60-sum(budget+35 for budget in budgets.values()), 265)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-voi', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_voi_module_selects_the_authored_cases_without_declaring_any(self):
        import ast
        voi = ('test_mip_04_voi_slab_known_voxels_modes_orientations',
               'test_mip_05_voi_order_delay_failure_missing_tool_cancel',
               'test_mip_06_voi_original_undo_reset_scope_lifecycle')
        source = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip.py').read_text(encoding='utf-8'))
        mip = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipE2E')
        declared = [node.name for node in mip.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        # The six authored cases stay declared once on the MIP Viewer class: three MIP Viewer and three VOI Slab.
        self.assertEqual(len(declared), 6)
        self.assertEqual(len(set(declared)), 6)
        self.assertTrue(set(voi) <= set(declared))
        self.assertEqual(sorted(set(declared) - set(voi)),
                         ['test_mip_01_known_voxels_modes_orientations_and_mpr_slab_parity',
                          'test_mip_02_order_delay_failure_capability_and_busy_gates',
                          'test_mip_03_lifecycle_identity_teardown_reentry_and_high_values'])
        constant = next(node for node in source.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['VOI_SLAB_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), voi)
        # The slab allowlist excludes exactly that tuple.
        slab_loader = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('VOI_SLAB_CASES', {node.id for node in ast.walk(slab_loader) if isinstance(node, ast.Name)})
        self.assertTrue([node for node in ast.walk(slab_loader)
                         if isinstance(node, ast.Compare) and any(isinstance(op, ast.NotIn) for op in node.ops)])
        # The VOI module selects exactly that tuple on a local subclass that declares nothing.
        wrapper = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_voi.py').read_text(encoding='utf-8'))
        classes = [node for node in wrapper.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes],
                         [('VolumeMipVoiE2E', ['VolumeMipE2E'])])
        self.assertFalse([node for node in ast.walk(classes[0]) if isinstance(node, (ast.FunctionDef, ast.Assign))])
        loader = next(node for node in wrapper.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('VOI_SLAB_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))

    def test_validate_workflow_runs_volume_mip_voi_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-voi:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-voi job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip.py',
                         '--file tests/e2e/test_volume_mip_voi.py',
                         '--file worklist-v0/hpacs-lite/volume-voi.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         'tests/measurement_ci.py --profile volume-mip-voi',
                         'name: synthetic-volume-mip-voi-results',
                         'tests/e2e/artifacts/volume-mip-voi-ci/',
                         'tmp/mipvoi-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-voi'), 1)
        self.assertNotIn('--profile volume-mip-voi', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-voi-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, including the slab job these cases came from, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-voi', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-voi:\n')[0])

    def test_volume_mip_job_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-job']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_job.py', None, 'ci-mip-job'),))
        self.assertEqual(profile['out'].name, 'volume-mip-job-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipjob-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-job': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the MIP Job group must not widen or cut the VOI Slab and slab groups beside it.
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-job':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets another suite's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_job.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-job')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-job', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_job_module_declares_exactly_the_job_cases_on_the_mip_viewer_base(self):
        import ast
        cases = ('test_mip_job_01_save_restore_roundtrip_new_browser_pixels',
                 'test_mip_job_02_save_gates_failure_unconfirmed_retry_roles_account',
                 'test_mip_job_03_restore_failure_missing_tool_cancel_stale_rollback')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_job.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipJobE2E', ['VolumeMipE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_JOB_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_JOB_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP Viewer base keeps its six authored cases; none of them is redeclared here.
        mip = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip.py').read_text(encoding='utf-8'))
        base = next(node for node in mip.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 6)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_job_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-job:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-job job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip.py',
                         '--file tests/e2e/test_volume_mip_job.py',
                         '--file worklist-v0/hpacs-lite/volume-mip-job.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         'tests/measurement_ci.py --profile volume-mip-job',
                         'name: synthetic-volume-mip-job-results',
                         'tests/e2e/artifacts/volume-mip-job-ci/',
                         'tmp/mipjob-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-job'), 1)
        self.assertNotIn('--profile volume-mip-job', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-job-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, including the VOI Slab job, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-job', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-job:\n')[0])
        # The pure Job model runs in the existing pure model gate (listed and executed), and the compiled server Job
        # checks keep running in the runtime gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-mip-job.js', pure)
        self.assertEqual(pure.count('tests/volume_mip_job_test.cjs'), 2)
        self.assertIn('tests/volume_mip_job_test.cjs', pure.rsplit(' --test ', 1)[1])
        runtime = next(line for line in text.splitlines() if 'tmp/runtime-ci/volume-api-models' in line)
        self.assertIn('/tests/viewer_volume_job_test.cjs', runtime.rsplit(' --test ', 1)[1])

    def test_volume_mip_batch_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-batch']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_batch.py', None, 'ci-mip-batch'),))
        self.assertEqual(profile['out'].name, 'volume-mip-batch-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipbatch-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-batch': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the MIP Batch group must not widen or cut the MIP Job, VOI Slab and slab groups beside it.
        self.assertEqual(ci.PROFILES['volume-mip-job']['suite_budgets'], {'ci-mip-job': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-batch':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets another suite's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_batch.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-batch')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-batch', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_batch_module_declares_exactly_the_batch_cases_on_the_mip_job_base(self):
        import ast
        cases = ('test_mip_batch_01_rotation_voi_frames_save_restore_new_browser',
                 'test_mip_batch_02_gates_cancel_failure_order_v12_compat',
                 'test_mip_batch_03_restore_failure_missing_tool_cancel_stale_rollback')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_batch.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipBatchE2E', ['VolumeMipJobE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_BATCH_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_BATCH_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP Job base keeps its three authored cases; none of them is redeclared here.
        job = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_job.py').read_text(encoding='utf-8'))
        base = next(node for node in job.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipJobE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 3)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_batch_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-batch:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-batch job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip.py',
                         '--file tests/e2e/test_volume_mip_job.py',
                         '--file tests/e2e/test_volume_mip_batch.py',
                         '--file worklist-v0/hpacs-lite/volume-mip-job.js',
                         '--file worklist-v0/hpacs-lite/volume-mip-batch.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-orientation.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         'tests/measurement_ci.py --profile volume-mip-batch',
                         'name: synthetic-volume-mip-batch-results',
                         'tests/e2e/artifacts/volume-mip-batch-ci/',
                         'tmp/mipbatch-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-batch'), 1)
        self.assertNotIn('--profile volume-mip-batch', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-batch-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, the MIP Job group included, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-batch', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-batch:\n')[0])
        # The pure MIP Batch model runs in the existing pure model gate (listed and executed), beside the capture harness that loads it.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        for name in ('--file worklist-v0/hpacs-lite/volume-mip-batch.js', '--file tests/volume_mip_batch_test.cjs'):
            self.assertEqual(pure.count(name), 1, name)
        tested = pure.rsplit(' --test ', 1)[1].split()
        self.assertIn('tests/volume_mip_batch_test.cjs', tested)
        self.assertIn('tests/viewer_volume_job_capture_test.cjs', tested)
        runtime = next(line for line in text.splitlines() if 'tmp/runtime-ci/volume-api-models' in line)
        self.assertIn('/tests/viewer_volume_job_test.cjs', runtime.rsplit(' --test ', 1)[1])

    def test_volume_mip_output_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-output']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_output.py', None, 'ci-mip-output'),))
        self.assertEqual(profile['out'].name, 'volume-mip-output-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipout-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-output': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the MIP output group must not widen or cut the MIP Batch, MIP Job, VOI Slab and slab groups beside it.
        self.assertEqual(ci.PROFILES['volume-mip-batch']['suite_budgets'], {'ci-mip-batch': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-job']['suite_budgets'], {'ci-mip-job': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-output':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets another suite's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_output.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-output')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-output', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_output_module_declares_exactly_the_output_cases_on_the_mip_batch_base(self):
        import ast
        cases = ('test_mip_output_01_v12_v13_fresh_pixel_frames_pdf_identity',
                 'test_mip_output_02_readiness_delay_failure_missing_tool_cancel_no_partial_page',
                 'test_mip_output_03_source_access_order_session')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_output.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipOutputE2E', ['VolumeMipBatchE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_OUTPUT_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_OUTPUT_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP Batch base keeps its three authored cases; none of them is redeclared here.
        batch = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_batch.py').read_text(encoding='utf-8'))
        base = next(node for node in batch.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipBatchE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 3)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_output_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-output:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-output job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip_batch.py',
                         '--file tests/e2e/test_volume_mip_output.py',
                         '--file worklist-v0/hpacs-lite/volume-mip-output.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip-print.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-job-print.js',
                         '--file worklist-v0/hpacs-lite/viewer-job-print.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         '--file worklist-v0/hpacs-lite/viewer-tech-note.js',
                         'tests/measurement_ci.py --profile volume-mip-output',
                         'name: synthetic-volume-mip-output-results',
                         'tests/e2e/artifacts/volume-mip-output-ci/',
                         'tmp/mipout-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-output'), 1)
        self.assertNotIn('--profile volume-mip-output', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-output-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, the MIP Batch group included, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-output', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-output:\n')[0])
        # The pure MIP output model runs in the existing pure model gate (listed and executed), beside the capture harness of its print entry.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        for name in ('--file worklist-v0/hpacs-lite/volume-mip-output.js', '--file tests/volume_mip_output_test.cjs'):
            self.assertEqual(pure.count(name), 1, name)
        tested = pure.rsplit(' --test ', 1)[1].split()
        self.assertIn('tests/volume_mip_output_test.cjs', tested)
        self.assertIn('tests/viewer_volume_job_capture_test.cjs', tested)

    def test_volume_mip_orient_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-orient']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_orient.py', None, 'ci-mip-orient'),))
        self.assertEqual(profile['out'].name, 'volume-mip-orient-ci')
        self.assertEqual(profile['project_prefix'], 'kin-miporient-ci-')
        self.assertEqual(profile['suite_timeout'], 900)
        budgets = {'ci-mip-orient': 900}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the Orientation Preset group must not widen or cut the MIP output, MIP Batch, MIP Job, VOI Slab or slab groups.
        self.assertEqual(ci.PROFILES['volume-mip-output']['suite_budgets'], {'ci-mip-output': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-batch']['suite_budgets'], {'ci-mip-batch': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-job']['suite_budgets'], {'ci-mip-job': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-orient':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_orient.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-orient')
        self.assertEqual(command[command.index('--timeout')+1], '900')
        self.assertEqual(outer, 935)
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 935)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))

    def test_volume_mip_orient_module_declares_exactly_the_orient_cases_on_the_mip_output_base(self):
        import ast
        cases = ('test_mip_orient_01_presets_save_restore_output',
                 'test_mip_orient_02_refusals_current_view_cancel')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipOrientE2E', ['VolumeMipOutputE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_ORIENT_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_ORIENT_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP output base keeps its three authored cases; none of them is redeclared here.
        output = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_output.py').read_text(encoding='utf-8'))
        base = next(node for node in output.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipOutputE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 3)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_orient_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-orient:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-orient job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip_orient.py',
                         '--file worklist-v0/hpacs-lite/volume-mip.js',
                         '--file worklist-v0/hpacs-lite/volume-mip-job.js',
                         '--file worklist-v0/hpacs-lite/volume-mip-output.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         'tests/measurement_ci.py --profile volume-mip-orient',
                         'name: synthetic-volume-mip-orient-results',
                         'tests/e2e/artifacts/volume-mip-orient-ci/',
                         'tmp/miporient-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-orient'), 1)
        self.assertNotIn('--profile volume-mip-orient', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-orient-results'), 1)
        # Every other synthetic group keeps its own profile and does not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch', 'volume-mip-output'):
            self.assertEqual(text.count('--profile '+other), 1)
        # The pure models of the new presets run in the existing pure model gate, with no new pure job.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        tested = pure.rsplit(' --test ', 1)[1].split()
        for name in ('tests/volume_mip_test.cjs', 'tests/volume_mip_job_test.cjs', 'tests/volume_mip_batch_test.cjs', 'tests/volume_mip_output_test.cjs', 'tests/viewer_volume_job_capture_test.cjs'):
            self.assertIn(name, tested, name)
    def test_e2e_route_handlers_bind_payloads_after_route_and_request(self):
        """A11-ORIENT-1 ci-02 regression (static, not a runtime exercise of any callback).

        Playwright calls a route handler with (route, route.request), passing as many of them as the handler declares. A handler
        that declares two parameters therefore receives the Request as its second one, so a payload bound as the second parameter
        default is overwritten by the Request (ci-02: json.dumps(Request) raised inside the handler and resurfaced at unroute).
        The rule this encodes: the leading non-defaulted parameters are exactly (route) or (route, request), and any bound default
        comes after both. Verified against every handler in tests/e2e at the time of writing.
        """
        import ast
        checked, violations = 0, []
        for path in sorted((ci.ROOT/'tests/e2e').glob('*.py')):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
            for call in ast.walk(tree):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr in ('route', 'unroute')):
                    continue
                if len(call.args) < 2:
                    continue
                handler = call.args[1]
                node = handler if isinstance(handler, ast.Lambda) else functions.get(handler.id) if isinstance(handler, ast.Name) else None
                if node is None:
                    continue
                checked += 1
                declared = len(node.args.posonlyargs) + len(node.args.args)
                defaulted = len(node.args.defaults)
                leading = declared - defaulted
                if leading not in (1, 2) or (defaulted and leading != 2):
                    violations.append((path.name, call.lineno, declared, defaulted))
        self.assertEqual(violations, [])
        self.assertGreaterEqual(checked, 300, 'the scan must still reach the e2e route handlers')

    def test_mip_orient_camera_diagnostics_compose_as_strings(self):
        """A11-ORIENT-1 ci-02 regression (static): assert_camera must not concatenate its label with +, and rolled_back must
        return a string, so a diagnostic value can never raise before the 1e-6 camera comparisons run."""
        import ast
        tree = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        camera = functions['assert_camera']
        concatenations = [node for node in ast.walk(camera)
                          if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add)
                          and isinstance(node.left, ast.Name) and node.left.id == 'label']
        self.assertEqual(concatenations, [], 'compose the message with an f-string, not label + ...')
        returns = [node.value for node in ast.walk(functions['rolled_back']) if isinstance(node, ast.Return)]
        self.assertTrue(returns and all(isinstance(value, ast.JoinedStr) for value in returns),
                        'rolled_back must return a formatted string')
    # A11-ORIENT-1 ci-03 regressions. Two static rules and one real execution of the module's own helper code; none of them
    # imports Playwright, launches a browser or mirrors the fixture.
    PLAYWRIGHT_ASSERTION_POSITIONALS = {
        'to_have_count': 1, 'to_have_text': 1, 'to_contain_text': 1, 'to_have_value': 1, 'to_have_values': 1,
        'to_have_class': 1, 'to_have_id': 1, 'to_have_title': 1, 'to_have_url': 1, 'to_have_attribute': 2,
        'to_have_js_property': 2, 'to_have_css': 2, 'to_be_visible': 0, 'to_be_hidden': 0, 'to_be_enabled': 0,
        'to_be_disabled': 0, 'to_be_checked': 0, 'to_be_editable': 0, 'to_be_empty': 0, 'to_be_focused': 0,
        'to_be_attached': 0, 'to_be_in_viewport': 0,
    }

    def test_playwright_assertions_take_only_their_expected_value_positionally(self):
        """expect(...).to_have_count(0, label) raised TypeError in ci-03: these assertions take the expected value positionally
        and everything else, timeout included, by keyword. A message never goes into the assertion call."""
        import ast
        violations, checked = [], 0
        for path in sorted((ci.ROOT/'tests/e2e').glob('*.py')):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            for call in ast.walk(tree):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)):
                    continue
                name = call.func.attr
                limit = self.PLAYWRIGHT_ASSERTION_POSITIONALS.get(name[4:] if name.startswith('not_') else name)
                if limit is None:
                    continue
                receiver = call.func.value
                while isinstance(receiver, ast.Attribute):
                    receiver = receiver.value
                if not (isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name) and receiver.func.id == 'expect'):
                    continue
                checked += 1
                if len(call.args) > limit:
                    violations.append((path.name, call.lineno, name, len(call.args), limit))
        self.assertEqual(violations, [])
        self.assertGreater(checked, 500, 'the scan must still reach the e2e assertions')

    def test_mip_orient_page_helpers_are_installed_before_use(self):
        """ci-03 NA1: FINAL_CAMERA calls mipView(), which only exists after HELPERS has been evaluated on THAT page. fresh_page()
        installs nothing, so every page must receive its helpers before the first use. Checked per page variable, in source order."""
        import ast
        installs = {'HELPERS': {'mipView', 'mipCount', 'canvasPixel', 'mipState'},
                    'VOI_HELPERS': {'mipVoiState', 'mipTransitions', 'mipStatuses'},
                    'BATCH_HELPERS': {'batchFrames', 'batchStatuses', 'batchHoldFrame', 'batchHeld', 'batchView'},
                    'PRINT_TRACE': {'printFrames', 'printEvents', 'printFault', 'printLeaks', 'printReady'}}
        constant_needs = {'FINAL_CAMERA': {'mipView'}, 'TAKE': {'printFrames'}, 'NO_LEAKS': {'printLeaks'}}
        method_needs = {'mark': {'mipTransitions'}, 'settled': {'mipTransitions'}, 'job_final': {'mipTransitions'},
                        'apply_voi_case': {'mipTransitions'}, 'batch_announced': {'batchStatuses'}, 'make': {'batchFrames'},
                        'rolled_back': {'mipTransitions'}, 'open_output': {'printFrames'}}
        # Helper methods that install helpers themselves (verified in test_volume_mip.py): opened_voi_study evaluates HELPERS on
        # the page it returns third, and open_voi evaluates VOI_HELPERS on the page it is given.
        installers = {'opened_voi_study': ('return3', installs['HELPERS']), 'open_voi': ('arg0', installs['VOI_HELPERS'])}
        tree = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        problems = []
        for function in [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name.startswith('test_')]:
            have = {}
            for node in sorted([n for n in ast.walk(function) if isinstance(n, (ast.Call, ast.Assign))],
                               key=lambda n: (n.lineno, n.col_offset)):
                if isinstance(node, ast.Assign):
                    call = node.value
                    if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                            and isinstance(call.func.value, ast.Name) and call.func.value.id == 'self'):
                        spec = installers.get(call.func.attr)
                        if spec and spec[0] == 'return3' and isinstance(node.targets[0], ast.Tuple) and len(node.targets[0].elts) == 3:
                            have.setdefault(node.targets[0].elts[2].id, set()).update(spec[1])
                    continue
                function_node = node.func
                if isinstance(function_node, ast.Attribute) and isinstance(function_node.value, ast.Name) and function_node.value.id == 'self':
                    spec = installers.get(function_node.attr)
                    if spec and spec[0] == 'arg0' and node.args and isinstance(node.args[0], ast.Name):
                        have.setdefault(node.args[0].id, set()).update(spec[1])
                    if function_node.attr in method_needs and node.args and isinstance(node.args[0], ast.Name):
                        missing = method_needs[function_node.attr] - have.get(node.args[0].id, set())
                        if missing:
                            problems.append((function.name, node.lineno, node.args[0].id + '.' + function_node.attr, sorted(missing)))
                # wait_for_function and evaluate_handle run page code exactly like evaluate, so a predicate such as NO_LEAKS needs
                # its helpers installed on that same page too (ci-03 N1: printLeaks was only ever installed by PRINT_TRACE).
                if (isinstance(function_node, ast.Attribute) and function_node.attr in ('evaluate', 'wait_for_function', 'evaluate_handle')
                        and isinstance(function_node.value, ast.Name)):
                    page, needed = function_node.value.id, set()
                    if node.args and isinstance(node.args[0], ast.Name):
                        if node.args[0].id in installs:
                            have.setdefault(page, set()).update(installs[node.args[0].id])
                        needed |= constant_needs.get(node.args[0].id, set())
                    if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                        for symbol in {s for group in installs.values() for s in group}:
                            if symbol in node.args[0].value:
                                needed.add(symbol)
                    missing = needed - have.get(page, set())
                    if missing:
                        problems.append((function.name, node.lineno, page, sorted(missing)))
        self.assertEqual(problems, [])

    def test_mip_orient_camera_diagnostics_execute_without_playwright(self):
        """Runs the module's own near/assert_camera/rolled_back on stubs: the ci-02 label defect was a runtime TypeError that a
        parse cannot see. A mismatch must raise AssertionError carrying the label, never TypeError."""
        import ast, math, unittest as ut
        source = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        klass = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'VolumeMipOrientE2E')
        wanted = {'near', 'assert_camera', 'rolled_back'}
        extracted = ast.Module(body=[n for n in klass.body if isinstance(n, ast.FunctionDef) and n.name in wanted], type_ignores=[])
        self.assertEqual({n.name for n in extracted.body}, wanted)
        ast.fix_missing_locations(extracted)
        namespace = {'math': math, 'DISTANCE': 100.0}
        exec(compile(extracted, '<orient-helpers>', 'exec'), namespace)

        class Probe(ut.TestCase):
            def runTest(self):
                pass
        for name in wanted:
            setattr(Probe, name, namespace[name])
        probe = Probe()

        class Page:
            def locator(self, selector):
                return self
            def text_content(self):
                return 'ROLLED BACK STATUS'
            def evaluate(self, expression, argument=None):
                return ['pending', 'final']
        label = probe.rolled_back(Page(), 3, 'Anterior')
        self.assertIsInstance(label, str)
        self.assertIn('Anterior', label)
        self.assertIn('ROLLED BACK STATUS', label)
        camera = {'viewPlaneNormal': [0, -1, 0], 'viewUp': [0, 0, 1], 'focalPoint': [1.0, 2.0, 3.0],
                  'position': [1.0, 2.0 - 60.0, 3.0], 'parallelScale': 30.0}
        expected = {'viewPlaneNormal': [0, -1, 0], 'viewUp': [0, 0, 1], 'focalPoint': [1.0, 2.0, 3.0]}
        probe.assert_camera(camera, expected, label, (60.0, 30.0))
        wrong = dict(camera, viewPlaneNormal=[0, 1, 0])
        with self.assertRaises(AssertionError) as raised:
            probe.assert_camera(wrong, expected, label, (60.0, 30.0))
        self.assertIn('Anterior', str(raised.exception))
        # A tuple label must still compare and fail as an assertion, never as a TypeError (the ci-02 defect).
        with self.assertRaises(AssertionError):
            probe.assert_camera(wrong, expected, ('Anterior', 'status', []), (60.0, 30.0))
        # The zoom parity and the distance floor are still enforced.
        with self.assertRaises(AssertionError):
            probe.assert_camera(dict(camera, parallelScale=31.0), expected, label, (60.0, 30.0))
        with self.assertRaises(AssertionError):
            probe.assert_camera(dict(camera, position=[1.0, 2.0 - 40.0, 3.0]), expected, label, (40.0, 30.0))
    def test_output_integration_commands_are_exact_ordered_local_classes(self):
        profile=ci.PROFILES['output-integration']
        commands=[]
        for suite,class_name,unit in profile['suites']:
            command,outer=ci.guarded_profile_run(profile,suite,class_name,unit,2000)
            commands.append(command)
            self.assertEqual(command[command.index('--timeout')+1],'900')
            self.assertEqual(outer,935)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_compare_reports.py',
                          'tests/e2e/test_viewer_job_report.py',
                          'tests/e2e/test_editor_compare_output.py'])
        self.assertEqual([command[command.index('--class')+1] for command in commands],
                         ['CompareReportsE2E','ViewerJobReportE2E','EditorCompareOutputE2E'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-output-compare-reports','ci-output-viewer-job-report',
                          'ci-output-editor-compare-output'])

    def test_output_integration_declares_exact_six_four_four_tests(self):
        expected=(('e2e/test_compare_reports.py','CompareReportsE2E',
                   'test_compare_reports_',6),
                  ('e2e/test_viewer_job_report.py','ViewerJobReportE2E',
                   'test_job_report_',4),
                  ('e2e/test_editor_compare_output.py','EditorCompareOutputE2E',
                   'test_editor_output_',4))
        for suite,class_name,prefix,count in expected:
            text=(ci.ROOT/'tests'/suite).read_text(encoding='utf-8')
            import ast
            tree=ast.parse(text)
            cls=next(node for node in tree.body if isinstance(node,ast.ClassDef)
                     and node.name==class_name)
            declared=[node.name for node in cls.body if isinstance(node,ast.FunctionDef)
                      and node.name.startswith('test_')]
            self.assertEqual(len(declared),count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))

    def test_output_integration_workflow_is_manual_fixed_sha_and_hosted(self):
        text=(ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        for required in ['workflow_dispatch:', 'runs-on: ubuntu-24.04',
                         'ref: ${{ github.sha }}', 'persist-credentials: false',
                         'default: output-integration', '- identity-fields',
                         '- images-only', 'tests/e2e/artifacts/images-only-ci/',
                         '- image-text', 'tests/e2e/artifacts/image-text-ci/',
                         'tests/e2e/artifacts/IMAGE-TEXT-*.png',
                         'tests/e2e/artifacts/IMAGES-ONLY-*.png',
                         'tests/e2e/artifacts/test_images_only_*.png',
                         'KIN_CI_PROFILE: ${{ inputs.profile }}',
                         'tests/measurement_ci.py --profile "$KIN_CI_PROFILE"',
                         'if: always()', 'retention-days: 7']:
            self.assertIn(required,text)
        run_blocks='\n'.join(line for line in text.splitlines() if line.lstrip().startswith('run:'))
        self.assertNotIn('${{ inputs.profile }}',run_blocks)
        self.assertNotIn('pull_request:',text)
        self.assertNotIn('push:',text)

    def test_identity_fields_commands_are_exact_ordered_local_classes(self):
        profile=ci.PROFILES['identity-fields']
        expected=(
            ('reading_appearance_live.py','ReadingAppearanceLive','test_',17),
            ('reading_appearance_position_live.py','ReadingAppearancePositionLive',
             'test_identity_position_api_',2),
            ('reading_appearance_fields_live.py','ReadingAppearanceFieldsLive',
             'test_identity_fields_api_',2),
            ('e2e/test_viewer_identity_position.py','ViewerIdentityPositionE2E',
             'test_identity_position_',2),
            ('e2e/test_viewer_identity_fields.py','ViewerIdentityFieldsE2E',
             'test_identity_fields_',2),
        )
        self.assertEqual([row[:2] for row in profile['suites']],
                         [row[:2] for row in expected])
        import ast
        for (suite,class_name,unit),(_,_,prefix,count) in zip(profile['suites'],expected):
            command,outer=ci.guarded_profile_run(profile,suite,class_name,unit,1000)
            self.assertEqual(command[command.index('--module')+1],'tests/'+suite)
            self.assertEqual(command[command.index('--class')+1],class_name)
            self.assertEqual(command[command.index('--timeout')+1],'540')
            self.assertEqual(outer,575)
            tree=ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls=next(node for node in tree.body if isinstance(node,ast.ClassDef)
                     and node.name==class_name)
            declared=[node.name for node in cls.body if isinstance(node,ast.FunctionDef)
                      and node.name.startswith('test_')]
            self.assertEqual(len(declared),count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))

    def test_vr_resize_probe_executes_only_the_instrumented_original_vr20(self):
        import ast
        profile=ci.PROFILES['vr-resize-probe']
        self.assertEqual(profile['suites'], (('e2e/test_vr_resize_probe.py',
                         'VrResizeProbeE2E', 'ci-vr-resize-probe'),))
        self.assertEqual(profile['out'].name,'vr-resize-probe-ci')
        tree=ast.parse((ci.ROOT/'tests/e2e/test_vr_resize_probe.py').read_text(encoding='utf-8'))
        cls=next(node for node in tree.body if isinstance(node,ast.ClassDef))
        methods=[node.name for node in cls.body if isinstance(node,ast.FunctionDef)
                 and node.name.startswith('test_')]
        self.assertEqual(methods,['test_vr_resize_probe_01_original_vr20'])
        command,_=ci.guarded_profile_run(profile,*profile['suites'][0],1000)
        self.assertIn('VrResizeProbeE2E',command)
        self.assertEqual(len({p['out'] for p in ci.PROFILES.values()}),len(ci.PROFILES))

    def test_vr_artifact_allowlist_rejects_raw_text_and_validates_png(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);stage=root/'private';out=root/'public'
            stage.mkdir();out.mkdir()
            (stage/'volume-rendering.png').write_bytes(b'\x89PNG\r\n\x1a\nsynthetic')
            # The declared set is both PNGs: one alone is missing evidence, not a pass.
            with self.assertRaisesRegex(RuntimeError,'Unexpected or missing'):
                ci.publish_vr_evidence(stage,out)
            self.assertEqual(list(out.iterdir()),[])
            (stage/'vr-access-covered.png').write_bytes(b'\x89PNG\r\n\x1a\ncovered')
            (stage/'raw.txt').write_text('Authorization: Bearer raw-secret',encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError,'Unexpected or missing'):
                ci.publish_vr_evidence(stage,out)
            self.assertEqual(list(out.iterdir()),[])
            (stage/'raw.txt').unlink()
            (stage/'vr-access-covered.png').write_bytes(b'not a png')
            with self.assertRaisesRegex(RuntimeError,'not a PNG'):
                ci.publish_vr_evidence(stage,out)
            self.assertEqual(list(out.iterdir()),[])
            (stage/'vr-access-covered.png').write_bytes(b'\x89PNG\r\n\x1a\ncovered')
            ci.publish_vr_evidence(stage,out)
            self.assertEqual((out/'volume-rendering.png').read_bytes(),
                             b'\x89PNG\r\n\x1a\nsynthetic')
            self.assertEqual((out/'vr-access-covered.png').read_bytes(),
                             b'\x89PNG\r\n\x1a\ncovered')

    def test_inner_deadline_leaves_time_to_terminate_descendants(self):
        for remaining, expected in [(1000,540), (100,65), (36,1)]:
            command=ci.guarded_suite_command('e2e/test_manual_sr.py','ManualSrE2E',remaining)
            self.assertEqual(command[command.index('--timeout')+1],str(expected))
        with self.assertRaisesRegex(RuntimeError,'Insufficient CI time'):
            ci.guarded_suite_command('e2e/test_manual_sr.py','ManualSrE2E',35)
        command,outer=ci.guarded_profile_run(ci.PROFILES['volume-rendering'],
            'e2e/test_volume_rendering.py',None,'ci-volume-rendering',1300)
        self.assertNotIn('--class',command)
        self.assertEqual(command[command.index('--unit')+1],'ci-volume-rendering')
        self.assertEqual(command[command.index('--timeout')+1],'1200')
        self.assertEqual(outer,1235)
        self.assertGreaterEqual(outer,int(command[command.index('--timeout')+1])+35)

        command,outer=ci.guarded_profile_run(ci.PROFILES['measurements'],
            'e2e/test_manual_sr.py','ManualSrE2E','ci-test-manual-sr',1000)
        self.assertEqual(command[command.index('--timeout')+1],'540')
        self.assertEqual(outer,575)

    def test_main_runtime_uses_profile_outer_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            profile={**ci.PROFILES['volume-rendering'], 'out':root/'artifacts'}
            completed=MagicMock(returncode=0,stdout=b'',stderr=b'')
            response=MagicMock();response.__enter__.return_value.status=200
            response.__enter__.return_value.read.return_value = b'{"memberRights":"ready"}'
            checks=[b'',b'',b'unix:///var/run/docker.sock']
            with patch.dict(os.environ, {'GITHUB_ACTIONS':'true',
                    'RUNNER_ENVIRONMENT':'github-hosted','RUNNER_TEMP':folder}, clear=True), \
                 patch.object(ci,'ROOT',root), \
                 patch.dict(ci.PROFILES, {'volume-rendering':profile}), \
                 patch.object(ci,'seed_source'), \
                 patch.object(ci.subprocess,'check_output',side_effect=checks), \
                 patch.object(ci.subprocess,'run',return_value=completed) as run, \
                 patch.object(ci.ssl, '_create_unverified_context', return_value=None), \
                 patch.object(ci,'urlopen',return_value=response), \
                 patch.object(ci,'publish_vr_evidence'), \
                 patch.object(ci, 'ensure_imported_admin_credential', return_value='stub-imported-password'), \
                 contextlib.redirect_stdout(io.StringIO()):
                ci.main('volume-rendering')
            invocation=next(call for call in run.call_args_list
                            if 'run-tests.py' in ' '.join(map(str,call.args[0])))
            command=invocation.args[0]
            inner=int(command[command.index('--timeout')+1])
            self.assertEqual(inner,1200)
            self.assertEqual(invocation.kwargs['timeout'],1235)
            self.assertGreaterEqual(invocation.kwargs['timeout'],inner+35)

    def test_gateway_e2e_profile_is_exact_dispatch_only_and_fits_the_shared_deadline(self):
        """The focused workflow's two contract checks (steps that request the profile, dispatch options/default) are
        primary. The literal-absence check beside them preserves the earlier literal-ban regression with one exact
        record-run argument excepted; it is a supporting check, not a reader that proves what an arbitrary shell
        program does."""
        profile = ci.PROFILES['gateway-e2e']
        self.assertEqual(profile['suites'], (('gateway_pipeline_live.py', 'GatewayPipelineLive', 'ci-eg1-gateway'),))
        self.assertEqual(profile['out'].name, 'gateway-e2e-ci')
        self.assertEqual(profile['project_prefix'], 'kin-gateway-e2e-ci-')
        self.assertEqual(profile['suite_timeout'], 1260)
        self.assertNotIn('suite_budgets', profile)
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/gateway_pipeline_live.py')
        self.assertEqual(command[command.index('--class')+1], 'GatewayPipelineLive')
        self.assertEqual(command[command.index('--unit')+1], 'ci-eg1-gateway')
        self.assertEqual(command[command.index('--timeout')+1], '1260')
        self.assertEqual(outer, 1295)
        # A1: 1260+35 = 1295 <= 1500-205, and 205s is about 2.5x the recorded hosted stack setup and cleanup.
        self.assertTrue(all(ci.profile_deadline_seconds(name) == (3900 if name == 'emr-b' else 1500) for name in ci.PROFILES))
        self.assertLessEqual(profile['suite_timeout'] + 35, 25*60 - 205)
        for name, other in ci.PROFILES.items():
            if name != 'gateway-e2e':
                self.assertNotEqual(profile['out'], other['out'])
                self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        # Dispatch only, through its own workflow: never on push or PR, not through the focused integration dispatcher.
        validate = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        self.assertEqual(validate.count('--profile gateway-e2e'), 0)
        dispatch = (ci.ROOT/'.github/workflows/gateway-e2e.yml').read_text(encoding='utf-8')
        self.assertEqual(dispatch.count('--profile gateway-e2e'), 1)
        # The Focused integration dispatcher can never run this profile: none of its steps requests it and none of its
        # dispatch inputs offers it. These are the contract, not the words in the file, so a record-run
        # `--file .github/workflows/gateway-e2e.yml` (it only hashes a file its step reads) passes both (S7-CIREC-REC CR-3).
        # The workflow is read with the installed YAML parser.
        import copy, re, shlex
        import yaml

        UNRESOLVED = None

        def requested(step, env):
            # Every measurement_ci.py profile the step's shell requests, as --profile X or --profile=X. Fail closed
            # (UNRESOLVED, which runs_profile counts as the forbidden profile): a value is accepted only when it is
            # a literal, or a $NAME / ${NAME} whose YAML env value (step, job or workflow) is known and whose NAME is
            # never mentioned in the step's run text except as a plain expansion (so never assigned, exported, read
            # into or defaulted), or a ${{ inputs.* }} dispatch input, whose offered options offers_profile checks.
            # No shell is interpreted.
            text = str(step.get('run') or '')
            names = {**env, **{str(k): str(v) for k, v in (step.get('env') or {}).items()}}
            found = []
            for line in text.replace('\\\n', ' ').splitlines():
                try:
                    words = shlex.split(line, comments=True)
                except ValueError:
                    if 'tests/measurement_ci.py' in line:
                        found.append(UNRESOLVED)
                    continue
                for index, word in enumerate(words):
                    if word.endswith('tests/measurement_ci.py'):
                        rest = words[index+1:]
                        found += [rest[i+1] for i, arg in enumerate(rest[:-1]) if arg == '--profile']
                        found += [arg.split('=', 1)[1] for arg in rest if arg.startswith('--profile=')]
                        if rest[-1:] == ['--profile']:
                            found.append(UNRESOLVED)

            def literal_or_input(value):
                if re.fullmatch(r'\$\{\{\s*inputs\.\w+\s*\}\}', value):
                    return value
                return UNRESOLVED if re.search(r'[$`]', value) else value

            def resolve(value):
                if value is UNRESOLVED:
                    return UNRESOLVED
                variable = re.fullmatch(r'\$\{?(\w+)\}?', value)
                if not variable:
                    return literal_or_input(value)
                name = variable.group(1)
                rest_of_text = re.sub(r'\$\{'+name+r'\}|\$'+name+r'(?!\w)', '', text)
                if name not in names or re.search(r'(?<!\w)'+name+r'(?!\w)', rest_of_text):
                    return UNRESOLVED
                return literal_or_input(names[name])

            return [resolve(value) for value in found]

        def runs_profile(workflow, profile):
            outer = {str(k): str(v) for k, v in (workflow.get('env') or {}).items()}
            hits = []
            for name, job in workflow['jobs'].items():
                scope = {**outer, **{str(k): str(v) for k, v in (job.get('env') or {}).items()}}
                for index, step in enumerate(job.get('steps', [])):
                    got = requested(step, scope)
                    if profile in got or UNRESOLVED in got:
                        hits.append((name, index))
            return hits

        def offers_profile(workflow, profile):
            triggers = workflow.get('on', workflow.get(True)) or {}
            inputs = ((triggers.get('workflow_dispatch') or {}).get('inputs') or {}) if isinstance(triggers, dict) else {}
            return [name for name, field in inputs.items()
                    if profile in [str(option) for option in (field or {}).get('options') or []]
                    or str((field or {}).get('default')) == profile]

        # Secondary check: the earlier literal ban on the profile name anywhere in the focused workflow is kept, with one
        # exception, because the step that records the files it reads names `.github/workflows/gateway-e2e.yml`. The
        # installed YAML composer locates each jobs.<job>.steps[].run value; only a run in the approved direct form is
        # touched: a single-line plain scalar written right after `run: `, in a step without `shell` and a workflow and
        # job without `defaults`, made only of plain words (no quote, `;`, `&`, `|`, `$`, redirection, glob or comment),
        # whose first word is `python3` and second `scripts/record-run.py`, with record-run's own options as exact
        # --run-dir/--cwd/--file pairs before the child command's `--`. Within that option region only the whole pair
        # `--file .github/workflows/gateway-e2e.yml` is removed. Anything else (echo or another command first, a
        # preceding command, quoting, env, dispatch, a step name, a path suffix, another path, `--file=`, the child
        # command region) keeps its text. It is not a reader that proves what an arbitrary shell program does; the two
        # contract checks above stay the primary ones.
        recorded_file = '.github/workflows/gateway-e2e.yml'
        plain_words = re.compile(r'[A-Za-z0-9_./=:,+@%-]+(?: [A-Za-z0-9_./=:,+@%-]+)*')

        def entry(mapping, key):
            # (key node, value node) when the mapping holds the key exactly once; a repeated key is not settled here.
            if not isinstance(mapping, yaml.MappingNode):
                return None
            pairs = [(k, v) for k, v in mapping.value if isinstance(k, yaml.ScalarNode) and k.value == key]
            return pairs[0] if len(pairs) == 1 else None

        def recorded_runs(text):
            # (start, end, run without the recorded pair, pairs removed) for each run in the approved direct form.
            root = yaml.compose(text, Loader=yaml.SafeLoader)
            jobs = entry(root, 'jobs')
            if entry(root, 'defaults') or not jobs or not isinstance(jobs[1], yaml.MappingNode):
                return []
            found = []
            for _, job in jobs[1].value:
                steps = entry(job, 'steps')
                if entry(job, 'defaults') or not steps or not isinstance(steps[1], yaml.SequenceNode):
                    continue
                for step in steps[1].value:
                    run = entry(step, 'run')
                    if not run or entry(step, 'shell'):
                        continue
                    key, value = run
                    if not (isinstance(value, yaml.ScalarNode) and value.style is None
                            and re.fullmatch(r': +', text[key.end_mark.index:value.start_mark.index])):
                        continue
                    raw = text[value.start_mark.index:value.end_mark.index]
                    if raw != value.value or not plain_words.fullmatch(raw):
                        continue
                    words = raw.split(' ')
                    if words[:2] != ['python3', 'scripts/record-run.py'] or '--' not in words:
                        continue
                    child = words.index('--')
                    options = words[2:child]
                    pairs = list(zip(options[0::2], options[1::2]))
                    if len(options) % 2 or any(option not in ('--run-dir', '--cwd', '--file') for option, _ in pairs):
                        continue
                    kept = [pair for pair in pairs if pair != ('--file', recorded_file)]
                    found.append((value.start_mark.index, value.end_mark.index,
                                  ' '.join(words[:2] + [word for pair in kept for word in pair] + words[child:]),
                                  len(pairs) - len(kept)))
            return found

        def without_recorded_file(text):
            removed = 0
            for start, end, kept, count in sorted(recorded_runs(text), reverse=True):
                text = text[:start] + kept + text[end:]
                removed += count
            return text, removed

        raw_integration = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        residue, removed = without_recorded_file(raw_integration)
        self.assertEqual(removed, 1)
        self.assertNotIn('gateway-e2e', residue)

        def rejected(text, check):
            # `check` is the check that must catch the variant; YAML that fails to parse is not a catch.
            workflow = yaml.safe_load(text)
            self.assertIsInstance(workflow, dict)
            return check(workflow, text)

        def literal_left(workflow, text):
            return 'gateway-e2e' in without_recorded_file(text)[0]

        def executed(workflow, text):
            return bool(runs_profile(workflow, 'gateway-e2e'))

        def offered_in(workflow, text):
            return bool(offers_profile(workflow, 'gateway-e2e'))

        profile_step = '          "$RUNNER_TEMP/output-integration-python/bin/python" tests/measurement_ci.py --profile "$KIN_CI_PROFILE"\n'
        self.assertIn(profile_step, raw_integration)
        self.assertEqual(rejected(raw_integration, literal_left), False)
        for label, variant, check in (
            ('semicolon', profile_step.replace('"$KIN_CI_PROFILE"', 'gateway-e2e;'), literal_left),
            ('space', profile_step.replace('"$KIN_CI_PROFILE"', 'gateway-e2e '), literal_left),
            ('redirection', profile_step.replace('tests/measurement_ci.py', 'tests/measurement_ci.py</dev/null').replace(
                '"$KIN_CI_PROFILE"', 'gateway-e2e'), literal_left),
            ('equals', profile_step.replace('--profile "$KIN_CI_PROFILE"', '--profile=gateway-e2e'), executed),
            ('direct', profile_step.replace('"$KIN_CI_PROFILE"', 'gateway-e2e'), executed),
            ('reassigned', '          KIN_CI_PROFILE=gateway-e2e\n'+profile_step, executed),
            ('computed', '          X=".github/workflows/gateway-e2e.yml"; KIN_CI_PROFILE=${X##*/}; KIN_CI_PROFILE=${KIN_CI_PROFILE%.yml}\n'
                         + profile_step, literal_left),
            ('recording argument in a general run', '          echo --file '+recorded_file+'\n'+profile_step, literal_left),
            ('recording argument in a quoted value', '          X="--file '+recorded_file+'"\n'+profile_step, literal_left),
        ):
            mutated = raw_integration.replace(profile_step, variant)
            self.assertNotEqual(mutated, raw_integration, label)
            self.assertTrue(rejected(mutated, check), label)
        for label, mutated, check in (
            ('path suffix', raw_integration.replace(recorded_file, recorded_file+'.bak'), literal_left),
            ('another path', raw_integration.replace(recorded_file, '.github/workflows/gateway-e2e-copy.yml'), literal_left),
            ('child command region', raw_integration.replace('tests/measurement_ci_test.py\n', 'tests/measurement_ci_test.py --file '+recorded_file+'\n'),
             literal_left),
            ('recording argument inside a quoted value', raw_integration.replace(
                '--cwd .', '--cwd "x --file '+recorded_file+' y"'), literal_left),
            ('other script', raw_integration.replace('scripts/record-run.py', 'scripts/other-run.py'), literal_left),
            ('YAML list entry', raw_integration.replace('          - identity-fields\n', '          - identity-fields\n          - gateway-e2e\n'), literal_left),
            ('dispatch option', raw_integration.replace('          - identity-fields\n', '          - identity-fields\n          - gateway-e2e\n'), offered_in),
            ('dispatch default', raw_integration.replace('default: output-integration', 'default: gateway-e2e'), offered_in),
            ('workflow env', raw_integration.replace('permissions:\n', 'env:\n  KIN_CI_PROFILE: gateway-e2e\npermissions:\n'), literal_left),
            ('step env', raw_integration.replace('KIN_CI_PROFILE: ${{ inputs.profile }}', 'KIN_CI_PROFILE: gateway-e2e'), executed),
        ):
            self.assertNotEqual(mutated, raw_integration, label)
            self.assertTrue(rejected(mutated, check), label)
        # C-R-001 F01: the exception holds only for a run that is itself the direct record-run call. The same words
        # anywhere else keep their text, and so does a real record-run written in a form other than the approved one.
        record_command = next(line for line in raw_integration.splitlines()
                              if line.startswith('        run: python3 scripts/record-run.py ')).split('run: ', 1)[1]
        record_run = 'run: '+record_command
        shaped = 'python3 scripts/record-run.py --run-dir tmp/x --file '+recorded_file
        for label, mutated in (
            ('echo of a record-run', raw_integration.replace(record_run, 'run: echo '+record_command)),
            ('after a preceding command', raw_integration.replace(record_run, 'run: true && '+record_command)),
            ('variable assignment first', raw_integration.replace(record_run, 'run: X=1 '+record_command)),
            ('command list in the option region', raw_integration.replace(record_run, record_run.replace(' --cwd . ', ' --cwd . ; '))),
            ('--file= form', raw_integration.replace('--file '+recorded_file, '--file='+recorded_file)),
            ('YAML double-quoted run', raw_integration.replace(record_run, 'run: "'+record_command+'"')),
            ('YAML single-quoted run', raw_integration.replace(record_run, "run: '"+record_command+"'")),
            ('shell-quoted run', raw_integration.replace(record_run, "run: |\n          '"+record_command+"'")),
            ('block scalar run', raw_integration.replace(record_run, 'run: |\n          '+record_command)),
            ('custom step shell', raw_integration.replace(record_run, 'shell: cat {0}\n        '+record_run)),
            ('record-run-shaped quoted env', raw_integration.replace(
                'KIN_CI_PROFILE: ${{ inputs.profile }}\n', 'KIN_CI_PROFILE: ${{ inputs.profile }}\n          X: "'+shaped+'"\n')),
            ('record-run-shaped plain env', raw_integration.replace(
                'KIN_CI_PROFILE: ${{ inputs.profile }}\n', 'KIN_CI_PROFILE: ${{ inputs.profile }}\n          X: '+shaped+' -- true\n')),
            ('record-run-shaped step name', raw_integration.replace(
                '- name: Output integration profile safeguards and exact selection', '- name: '+shaped+' -- true')),
        ):
            self.assertNotEqual(mutated, raw_integration, label)
            self.assertTrue(rejected(mutated, literal_left), label)
        integration = yaml.safe_load(raw_integration)
        # Not vacuous: the dispatch input is read (its own default profile is offered).
        self.assertEqual(offers_profile(integration, 'output-integration'), ['profile'])
        self.assertEqual(runs_profile(integration, 'gateway-e2e'), [])
        self.assertEqual(offers_profile(integration, 'gateway-e2e'), [])
        # Controls on copies of the parsed workflow: each forbidden form fails its own check, and recording the file
        # in a record-run step fails neither.
        job = lambda workflow: next(iter(workflow['jobs'].values()))
        stepped = copy.deepcopy(integration)
        job(stepped)['steps'].append({'run': 'python3 tests/measurement_ci.py --profile gateway-e2e'})
        self.assertEqual((len(runs_profile(stepped, 'gateway-e2e')), offers_profile(stepped, 'gateway-e2e')), (1, []))
        through_env = copy.deepcopy(integration)
        live = next(step for step in job(through_env)['steps'] if requested(step, {}) == ['${{ inputs.profile }}'])
        live['env']['KIN_CI_PROFILE'] = 'gateway-e2e'
        self.assertEqual(len(runs_profile(through_env, 'gateway-e2e')), 1)
        # F01: the run text can reassign the profile variable before the unchanged command, or hand it a value this
        # check cannot settle; each must fail, with the YAML env left as it is.
        selected = lambda workflow: next(step for step in job(workflow)['steps'] if requested(step, {}) == ['${{ inputs.profile }}'])
        for prefix in ('KIN_CI_PROFILE=gateway-e2e\n', 'export KIN_CI_PROFILE=gateway-e2e\n', 'env KIN_CI_PROFILE=gateway-e2e true\n',
                       'read KIN_CI_PROFILE <<< gateway-e2e\n', ': "${KIN_CI_PROFILE:=gateway-e2e}"\n', 'KIN_CI_PROFILE=$(echo gateway-e2e)\n'):
            reassigned = copy.deepcopy(integration)
            step = selected(reassigned)
            step['run'] = prefix + step['run']
            self.assertEqual(len(runs_profile(reassigned, 'gateway-e2e')), 1, prefix)
        for value in ('"$(echo gateway-e2e)"', '`echo gateway-e2e`', '"$OTHER_PROFILE"'):
            unsettled = copy.deepcopy(integration)
            step = selected(unsettled)
            step['run'] = step['run'].replace('"$KIN_CI_PROFILE"', value)
            self.assertEqual(len(runs_profile(unsettled, 'gateway-e2e')), 1, value)
        unknown_env = copy.deepcopy(integration)
        del selected(unknown_env)['env']['KIN_CI_PROFILE']
        self.assertEqual(len(runs_profile(unknown_env, 'gateway-e2e')), 1)
        expression_env = copy.deepcopy(integration)
        selected(expression_env)['env']['KIN_CI_PROFILE'] = '${{ github.event.inputs.profile }}'
        self.assertEqual(len(runs_profile(expression_env, 'gateway-e2e')), 1)
        offered = copy.deepcopy(integration)
        triggers = offered.get('on', offered.get(True))
        triggers['workflow_dispatch']['inputs']['profile']['options'].append('gateway-e2e')
        self.assertEqual((runs_profile(offered, 'gateway-e2e'), offers_profile(offered, 'gateway-e2e')), ([], ['profile']))
        recorded = copy.deepcopy(integration)
        job(recorded)['steps'].append({'run': 'python3 scripts/record-run.py --run-dir tmp/x --cwd . --file '
                                              '.github/workflows/gateway-e2e.yml -- python3 -B tests/measurement_ci_test.py'})
        self.assertEqual((runs_profile(recorded, 'gateway-e2e'), offers_profile(recorded, 'gateway-e2e')), ([], []))
        self.assertEqual(ci.GATEWAY_HANDOFF, 'gateway-project.json')
        self.assertTrue(ci.GATEWAY_PROJECT.fullmatch('kin-eg1-gw-0123456789ab'))
        self.assertIsNone(ci.GATEWAY_PROJECT.fullmatch('kin-gateway'))

    def test_gateway_e2e_finally_unpauses_first_and_removes_the_handed_off_project_last(self):
        # A3: the suite hands its project over and is then killed on its deadline, so its own class cleanup never runs.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            profile = {**ci.PROFILES['gateway-e2e'], 'out': root/'artifacts'}
            project = 'kin-eg1-gw-0123456789ab'
            label = 'label=com.docker.compose.project='+project
            listings = {('docker', 'ps', '-q', '--filter', 'status=paused'): b'pausedid\n',
                        ('docker', 'ps', '-aq', '--filter', label): b'gwcontainer\n',
                        ('docker', 'network', 'ls', '-q', '--filter', label): b'gwnetwork\n',
                        ('docker', 'volume', 'ls', '-q', '--filter', label): b'gwvolume\n'}
            seen = []

            def fake_run(command, **kwargs):
                seen.append(tuple(map(str, command)))
                if 'run-tests.py' in ' '.join(seen[-1]):
                    (profile['out']/ci.GATEWAY_HANDOFF).write_text(json.dumps({'project': project}), encoding='utf-8')
                    with self.assertRaises(RuntimeError):
                        with ci.gate.live_run(unit=command[command.index('--unit') + 1],
                                              module=command[command.index('--module') + 1],
                                              plan_sha256='a' * 64, attempt=1):
                            raise RuntimeError('synthetic module failure')
                    raise ci.subprocess.TimeoutExpired(command, kwargs['timeout'])
                return MagicMock(returncode=0, stdout=listings.get(seen[-1], b''), stderr=b'')

            response = MagicMock(); response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b'{"memberRights":"ready"}'
            with patch.dict(os.environ, {'GITHUB_ACTIONS':'true', 'RUNNER_ENVIRONMENT':'github-hosted'}, clear=True), \
                 patch.object(ci, 'ROOT', root), \
                 patch.dict(ci.PROFILES, {'gateway-e2e': profile}), \
                 patch.object(ci.gate, 'STATE', root / 'gate-state'), \
                 patch.object(ci, 'seed_source'), \
                 patch.object(ci.subprocess, 'check_output', side_effect=[b'', b'', b'unix:///var/run/docker.sock']), \
                 patch.object(ci.subprocess, 'run', side_effect=fake_run), \
                 patch.object(ci.ssl, '_create_unverified_context', return_value=None), \
                 patch.object(ci, 'urlopen', return_value=response), \
                 patch.object(ci, 'ensure_imported_admin_credential', return_value='stub-imported-password'), \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'gateway_pipeline_live'):
                    ci.main('gateway-e2e')
            logs = next(index for index, command in enumerate(seen) if 'logs' in command and '--timestamps' in command)
            down = next(index for index, command in enumerate(seen) if 'down' in command and '--remove-orphans' in command)
            order = [seen.index(('docker', 'ps', '-q', '--filter', 'status=paused')),
                     seen.index(('docker', 'unpause', 'pausedid')), logs, down,
                     seen.index(('docker', 'rm', '-f', 'gwcontainer')), seen.index(('docker', 'network', 'rm', 'gwnetwork')),
                     seen.index(('docker', 'volume', 'rm', 'gwvolume')), seen.index(('docker', 'ps', '-aq')),
                     seen.index(('docker', 'volume', 'ls', '-q')),
                     seen.index(('docker', 'network', 'ls', '-q', '--filter', 'type=custom'))]
            self.assertEqual(order, sorted(order))
            daemon = json.loads((profile['out']/'daemon-empty.json').read_text(encoding='utf-8'))
            self.assertEqual(daemon, {'remaining': {'containers': [], 'volumes': [], 'networks': []}, 'problems': []})
            self.assertTrue((profile['out']/'results.json').exists())

    def test_local_and_self_hosted_refused_before_docker(self):
        for env in [{}, {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'self-hosted'}]:
            with patch.dict(os.environ,env,clear=True), patch.object(ci.subprocess,'check_output') as command, patch.object(ci.subprocess,'run') as mutation:
                with self.assertRaisesRegex(RuntimeError,'disposable GitHub-hosted'):
                    ci.main('measurements')
                command.assert_not_called()
                mutation.assert_not_called()

    def test_unknown_profile_refused_before_environment_or_docker(self):
        with patch.object(ci.subprocess,'check_output') as command:
            with self.assertRaisesRegex(RuntimeError,'Unknown CI profile'):
                ci.main('other')
            command.assert_not_called()

    def test_artifact_secrets_and_dynamic_credentials_removed(self):
        text='''generated=generated-secret
Authorization: Bearer token-value
Authorization: Basic dXNlcjpwYXNz
Set-Cookie: kin_session=session-value; HttpOnly
{"access_token":"eyJhbGci.payload.signature", "temporaryPassword":"temporary-value", "password":"another-value"}
test_measurement_readback PASS: 4'''
        result=ci.sanitize(text,['generated-secret'])
        for value in ['generated-secret','token-value','dXNlcjpwYXNz','session-value','eyJhbGci.payload.signature','temporary-value','another-value']:
            self.assertNotIn(value,result)
        self.assertIn('test_measurement_readback PASS: 4',result)


if __name__ == '__main__': unittest.main(verbosity=2)
