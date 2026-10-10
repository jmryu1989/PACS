"""Negative live controls inside the runner's one explicit live lease.

Expected behavioural failures are assertions of this test, not failed live
units. Setup/errors/timeouts never kill a mutant; any such error leaves the
normal runner inspection marker. This module never releases/deletes a marker.
"""
import contextlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from live import EmrBLedgerLive
from mutants import (ROOT, DECLARATION, MUTANTS, LIVE, apply, make_copy, unlink_modules,
                     live_verdict, run)
import live_test_gate as gate


class EmrBLiveMutants(unittest.TestCase):
    controls = {}

    def exercise(self, image, cases, log):
        class Probe(EmrBLedgerLive):
            pass
        # Each class owns a new labelled DB/volume set and its own cleanup.
        with patch.dict(os.environ, {'KIN_TEST_API_IMAGE': image}), log.open('w', encoding='utf-8') as stream, contextlib.redirect_stdout(stream):
            suite = unittest.TestSuite(Probe(LIVE[case]) for case in cases)
            result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
        return result

    def check_mutant(self, name):
        gate.require_live_run()
        output = Path(os.environ['KIN_EMR_LIVE_EVIDENCE']) / 'mutants' / name
        output.mkdir(parents=True, exist_ok=False)
        declaration = json.loads(DECLARATION.read_text(encoding='utf-8'))
        cases = next(m['kill'] for m in declaration['mutants'] if m['id'] == name)
        cases = [case for case in cases if case.startswith('L')]
        control_key = tuple(cases)
        report = {'id': name, 'cases': cases, 'killed': False}
        try:
            self.run_probe(name, cases, control_key, output, report)
        except Exception as error:
            report['killed'] = False
            report['runner_error'] = type(error).__name__ + ': ' + str(error)
            if not isinstance(error, AssertionError):
                report['harness_errors'] = True
            raise
        finally:
            (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
            print('EMR_LIVE_MUTANT ' + json.dumps(report), flush=True)

    def run_probe(self, name, cases, control_key, output, report):
        if control_key not in self.controls:
            control = self.exercise(os.environ['KIN_TEST_API_IMAGE'], cases, output / 'control.log')
            self.controls[control_key] = {'passed': control.wasSuccessful() and not control.skipped,
                                         'log': str(output / 'control.log')}
        report['control'] = self.controls[control_key]
        self.assertTrue(self.controls[control_key]['passed'], 'unmutated live control failed; no valid mutant verdict')
        tag = 'kin-emrb-r7-mutant:' + name.lower() + '-' + uuid.uuid4().hex[:8]
        try:
            with tempfile.TemporaryDirectory(prefix='emrb-live-mutant-') as folder:
                copy = Path(folder)
                head, link = make_copy(copy, source_manifest=os.environ['KIN_EMR_MUTANT_SOURCE_MANIFEST'])
                try:
                    # Restoration bytes belong to the disposable source copy;
                    # only its before/after hashes belong in the JSON evidence.
                    report['files'] = [{key: value for key, value in item.items() if key != 'original'}
                                       for item in apply(copy, MUTANTS[name][1])]
                    code, duration = run(['docker', 'build', '--target', 'production', '--label', 'kin.emrb.r7=mutant',
                        '--build-arg', 'VCS_REF=' + head + '-' + name, '-t', tag, str(copy / 'api')],
                        cwd=copy, timeout=1800, log=output / 'build.log')
                    report['build_exit'] = code
                    report['build_seconds'] = duration
                    self.assertEqual(code, 0, 'mutant build failed; not a kill')
                finally:
                    unlink_modules(link)
                result = self.exercise(tag, cases, output / 'mutant.log')
                text = (output / 'mutant.log').read_text(encoding='utf-8')
                report.update(live_verdict(text, cases, 0 if result.wasSuccessful() else 1))
                self.assertTrue(report['killed'], report)
        finally:
            # Exact image owned by this case only. Fixture cleanup already
            # checked its own labels; unrelated containers are never touched.
            run(['docker', 'image', 'rm', '-f', tag], cwd=ROOT, timeout=120, log=output / 'image-cleanup.log')

    def test_m01_owner_membership(self): self.check_mutant('M01')
    def test_m02_trigger_override(self): self.check_mutant('M02')
    def test_m03_missing_original(self): self.check_mutant('M03')
    def test_m04_early_body(self): self.check_mutant('M04')
    def test_m05_missing_failure_journal(self): self.check_mutant('M05')
    def test_m11_chain_corruption(self): self.check_mutant('M11')
    def test_m12_expiry_boundary(self): self.check_mutant('M12')
    def test_m36_receipt_startup_delay(self): self.check_mutant('M36')


def reporting_self_test():
    """Exercise the whole report path without a Docker or live-gate session."""
    from types import SimpleNamespace
    import sys
    module = sys.modules[__name__]

    class ReportingTests(unittest.TestCase):
        def exercise_report(self, mutant_text):
            with tempfile.TemporaryDirectory(prefix='emrb-report-test-') as directory:
                instance = EmrBLiveMutants('test_m01_owner_membership')
                instance.controls = {}
                def exercise(image, cases, log):
                    healthy = image == 'healthy'
                    log.write_text('OK\n' if healthy else mutant_text, encoding='utf-8')
                    return SimpleNamespace(wasSuccessful=lambda: healthy, skipped=[])
                environment = {'KIN_EMR_LIVE_EVIDENCE': directory, 'KIN_TEST_API_IMAGE': 'healthy',
                               'KIN_EMR_MUTANT_SOURCE_MANIFEST': 'unused'}
                with patch.dict(os.environ, environment), patch.object(gate, 'require_live_run'), \
                        patch.object(instance, 'exercise', side_effect=exercise), \
                        patch.object(module, 'make_copy', return_value=('head', None)), \
                        patch.object(module, 'unlink_modules'), patch.object(module, 'run', return_value=(0, 0)), \
                        patch.object(module, 'apply', return_value=[{'path': 'fixture.sql', 'original': b'original',
                            'before_sha256': 'before', 'mutated_sha256': 'after'}]):
                    error = None
                    try:
                        instance.check_mutant('M01')
                    except AssertionError as caught:
                        error = caught
                report = json.loads((Path(directory) / 'mutants/M01/result.json').read_text(encoding='utf-8'))
                return report, error

        def test_assertion_kill_keeps_serializable_hash_evidence(self):
            report, error = self.exercise_report('FAIL: ' + LIVE['L01'] + ' (probe)\nAssertionError: owner privilege\n')
            self.assertIsNone(error)
            self.assertTrue(report['killed'])
            self.assertEqual(report['files'], [{'path': 'fixture.sql', 'before_sha256': 'before', 'mutated_sha256': 'after'}])

        def test_harness_error_is_preserved_and_not_a_kill(self):
            report, error = self.exercise_report('ERROR: ' + LIVE['L01'] + ' (probe)\nRuntimeError: fixture failed\n')
            self.assertIsNotNone(error)
            self.assertFalse(report['killed'])
            self.assertTrue(report['harness_errors'])

    return 0 if unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReportingTests)).wasSuccessful() else 1


if __name__ == '__main__':
    import sys
    if sys.argv[1:] != ['--self-test']:
        raise SystemExit('Live cases require scripts/run-tests.py; only --self-test is supported directly.')
    raise SystemExit(reporting_self_test())
