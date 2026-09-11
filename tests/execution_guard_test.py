"""Synthetic subprocess regressions; never start Docker, a browser or a live stack."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'scripts/run-tests.py'


class ExecutionGuardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='pacs-gate-test-')
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name)
        self.tests = self.path / 'repo/tests'
        self.tests.mkdir(parents=True)
        self.state = self.path / 'state'
        self.bootstrap = self.path / 'bootstrap.py'
        self.bootstrap.write_text(
            'import importlib.util\nfrom pathlib import Path\n'
            'spec=importlib.util.spec_from_file_location("runner", '+repr(str(RUNNER))+')\n'
            'runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)\n'
            'runner.ROOT=Path('+repr(str(self.tests.parent))+')\n'
            'runner.gate.STATE=Path('+repr(str(self.state))+')\n'
            'runner.__file__=__file__\nraise SystemExit(runner.main())\n', encoding='utf-8')
        (self.tests/'probe.py').write_text('''import subprocess, sys, time, unittest
from pathlib import Path
from live_test_gate import require_live_run
BASE=Path(__file__).parent
class Probe(unittest.TestCase):
 def test_pass(self): (BASE/'passed').write_text('yes')
 def test_fail(self): self.fail('intentional synthetic failure')
 def test_live(self): require_live_run(); (BASE/'live').write_text('yes')
 def test_hold(self): require_live_run(); (BASE/'holding').write_text('yes'); time.sleep(2)
 def test_timeout(self):
  subprocess.Popen([sys.executable,'-c',"import time;from pathlib import Path;time.sleep(3);Path("+repr(str(BASE/'escaped'))+").write_text('bad')"])
  time.sleep(8)
''', encoding='utf-8')

    def plan(self, unit='probe', case='test_pass', mode='pure', timeout=10, attempts=3):
        value = dict(unit=unit, mode=mode, tests=[dict(file='tests/probe.py', case='Probe.'+case)],
                     max_attempts=attempts, timeout_seconds=timeout)
        path = self.path/(unit+'-input.json')
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def run_plan(self, plan):
        return subprocess.run([sys.executable, '-B', str(self.bootstrap), '--plan', str(plan)],
                              capture_output=True, timeout=20)

    def test_live_stack_denies_before_configuration_or_network(self):
        import invariants_live as live
        with patch.object(live.LiveStack, '_load_local_configuration') as configuration:
            with self.assertRaisesRegex(RuntimeError, 'explicit live test plan'):
                live.LiveStack()
            configuration.assert_not_called()

    def test_shell_temp_and_home_variables_do_not_split_gate_state(self):
        command=[sys.executable,'-B','-c',
                 'import sys;sys.path.insert(0,'+repr(str(ROOT/'tests'))+');import live_test_gate;print(live_test_gate.STATE)']
        original=subprocess.check_output(command)
        altered=dict(os.environ, TMP=str(self.path), TEMP=str(self.path), TMPDIR=str(self.path), HOME=str(self.path))
        self.assertEqual(subprocess.check_output(command,env=altered),original)

    def test_pure_mode_cannot_grant_live_permission(self):
        result = self.run_plan(self.plan(case='test_live'))
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertFalse((self.tests/'live').exists())
        self.assertFalse((self.state/'live-needs-inspection.json').exists())

    def test_imported_testcase_refused_before_any_test_runs(self):
        (self.tests/'accidental.py').write_text('from probe import Probe\nimport unittest\nclass Pure(unittest.TestCase):\n def test_ok(self): pass\n')
        result = subprocess.run([sys.executable, '-B', str(self.bootstrap), '--module', 'tests/accidental.py',
                                 '--unit', 'accidental'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertIn(b'imported TestCase', result.stderr)
        self.assertFalse((self.tests/'passed').exists())

    def test_duplicate_unknown_and_imported_selection_refused(self):
        for kind in ['duplicate', 'unknown', 'imported']:
            path = self.plan(unit=kind)
            value = json.loads(path.read_text())
            if kind == 'duplicate': value['tests'] *= 2
            if kind == 'unknown': value['tests'][0]['case'] = 'Probe.test_missing'
            if kind == 'imported':
                (self.tests/'accidental.py').write_text('from probe import Probe\n')
                value['tests'][0]['file'] = 'tests/accidental.py'
            path.write_text(json.dumps(value))
            self.assertEqual(self.run_plan(path).returncode, 125)
        self.assertFalse((self.tests/'passed').exists())

    def test_pass_cannot_repeat_even_with_new_evidence_or_changed_plan(self):
        path = self.plan()
        self.assertEqual(self.run_plan(path).returncode, 0)
        path = self.plan(case='test_fail')
        result = self.run_plan(path)
        self.assertEqual(result.returncode, 125)
        self.assertIn(b'already passed', result.stderr)
        self.assertEqual(len(json.loads((self.state/'probe.json').read_text())['attempts']), 1)

    def test_attempt_budget_survives_fixes_and_cannot_be_raised(self):
        path = self.plan(case='test_fail', attempts=2)
        self.assertEqual(self.run_plan(path).returncode, 125)
        self.assertEqual(self.run_plan(path).returncode, 125)
        path = self.plan(case='test_pass', attempts=3)
        self.assertIn(b'Cannot change', self.run_plan(path).stderr)
        path = self.plan(case='test_pass', attempts=2)
        self.assertIn(b'budget exhausted', self.run_plan(path).stderr)
        self.assertFalse((self.tests/'passed').exists())

    def test_worker_entry_cannot_bypass_parent_budget(self):
        path = self.plan()
        result = subprocess.run([sys.executable, '-B', str(self.bootstrap), '--worker', str(path)],
                                input=b'', capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 125)
        self.assertFalse((self.tests/'passed').exists())

    def test_import_is_inside_deadline_and_attempt_budget(self):
        (self.tests/'slow_import.py').write_text('import time\ntime.sleep(8)\n')
        result = subprocess.run([sys.executable, '-B', str(self.bootstrap), '--module', 'tests/slow_import.py',
                                 '--unit', 'slow-import', '--timeout', '1'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 124, result.stderr)
        ledger = json.loads((self.state/'slow-import.json').read_text())
        self.assertEqual(ledger['attempts'][0]['status'], 'interrupted')

    def test_live_process_lease_and_release(self):
        first = subprocess.Popen([sys.executable, '-B', str(self.bootstrap), '--plan',
                                  str(self.plan(unit='first', case='test_hold', mode='live'))],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: first.kill() if first.poll() is None else None)
        deadline = time.monotonic()+8
        while not (self.tests/'holding').exists() and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertTrue((self.tests/'holding').exists())
        second = self.run_plan(self.plan(unit='second', case='test_live', mode='live'))
        self.assertEqual(second.returncode, 125)
        self.assertIn(b'Another run owns', second.stderr)
        self.assertFalse((self.state/'second.json').exists())
        self.assertFalse((self.tests/'live').exists())
        self.assertEqual(first.wait(timeout=10), 0)
        self.assertEqual(self.run_plan(self.plan(unit='third', case='test_live', mode='live')).returncode, 0)

    def test_failed_live_run_stays_closed_for_other_units(self):
        self.assertEqual(self.run_plan(self.plan(case='test_fail', mode='live')).returncode, 125)
        result = self.run_plan(self.plan(unit='next', case='test_live', mode='live'))
        self.assertEqual(result.returncode, 125)
        self.assertIn(b'fixture inspection', result.stderr)
        self.assertFalse((self.state/'next.json').exists())
        self.assertFalse((self.tests/'live').exists())

    def test_timeout_kills_owned_descendants_and_blocks_retry(self):
        path = self.plan(case='test_timeout', mode='live', timeout=1)
        result = self.run_plan(path)
        self.assertEqual(result.returncode, 124, result.stderr)
        time.sleep(3)
        self.assertFalse((self.tests/'escaped').exists())
        self.assertEqual(self.run_plan(path).returncode, 125)
        self.assertTrue((self.state/'live-needs-inspection.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
