"""REQ-D949 -> RISK-EMR-HOST-NOISE -> refusal before lease, invalid during run."""
import json
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import quiet_host as q
import live_acceptance as acceptance
from live_acceptance import block_design, block_segments


class QuietHostTests(unittest.TestCase):
    def test_foreign_container_is_invalid_even_at_low_cpu(self):
        sample = {'host_cpu': .01, 'engine_cpu': .01,
                  'containers': [{'Names': 'foreign', 'Labels': 'kin.emrb.live=someone-else'}]}
        self.assertFalse(q.quiet_verdict(sample, {'kin.emrb.live=ours'}, True)['quiet'])

    def test_cpu_limits_missing_samples_and_exact_ownership(self):
        sample = {'host_cpu': .1, 'engine_cpu': .1,
                  'containers': [{'Names': 'ours', 'Labels': 'kin.emrb.live=ours'}]}
        self.assertTrue(q.quiet_verdict(sample, {'kin.emrb.live=ours'})['quiet'])
        sample['host_cpu'] = .21
        self.assertFalse(q.quiet_verdict(sample, {'kin.emrb.live=ours'})['quiet'])
        self.assertTrue(q.quiet_verdict(sample, {'kin.emrb.live=ours'}, True)['quiet'])
        sample['engine_cpu'] = None
        self.assertFalse(q.quiet_verdict(sample, {'kin.emrb.live=ours'}, True)['quiet'])

    def test_cpu_delta_and_counter_failure(self):
        self.assertAlmostEqual(q.utilization((100, 90), (200, 170)), .2)
        with self.assertRaises(q.InvalidRun):
            q.utilization((100, 90), (100, 90))

    def test_preflight_invalid_never_invokes_runner(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
        import live_test_gate as gate
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plan = root / 'plan.json'
            plan.write_text(json.dumps({'unit': 'emr-b1-r7-jit', 'mode': 'live'}))
            with patch.object(gate, 'preflight_live'), patch.object(q, 'command', return_value='[{"Config":{"Labels":{}}}]'), \
                    patch.object(q.QuietMonitor, 'preflight', side_effect=q.InvalidRun('foreign workload')), \
                    patch.object(q.subprocess, 'run') as runner, patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}):
                self.assertEqual(q.launch(plan, root / 'record'), 2)
            runner.assert_not_called()
            result = json.loads((root / 'record/launch.json').read_text())
            self.assertEqual(result['verdict'], 'INVALID')
            self.assertFalse(result['runner_started'])
            self.assertEqual(result['verdict_attempts_consumed'], 0)

    def test_during_invalid_is_sticky_and_recorded(self):
        class Probe:
            def snapshot(self, before):
                return {}, {'host_cpu': .99, 'engine_cpu': .01, 'containers': []}
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'host.jsonl'
            monitor = q.QuietMonitor(Probe(), out, set())
            with self.assertRaises(q.InvalidRun):
                monitor.sample({}, True)
            with self.assertRaises(q.InvalidRun):
                monitor.require_valid()
            self.assertFalse(json.loads(out.read_text())['quiet'])

    def test_acceptance_sizes_and_ten_minute_single_spread(self):
        for work, blocks, size in [('single', 30, 40), ('concurrent-24', 24, 24),
                                    ('concurrent-48', 24, 48), ('sustained', 12, 200)]:
            count, requests, spacing = block_design(work, 'acceptance')
            self.assertEqual((count, requests), (blocks, size))
            if work == 'single':
                self.assertGreaterEqual(spacing * (count-1), 600)
        self.assertEqual(block_design('single', 'ci-gross')[:2], (6, 10))

    def test_single_experimental_unit_is_one_complete_abba_block(self):
        self.assertEqual(block_segments('single', 0, 40), [('candidate', 20), ('r3', 20), ('r3', 20), ('candidate', 20)])
        self.assertEqual(block_segments('single', 1, 40), [('r3', 20), ('candidate', 20), ('candidate', 20), ('r3', 20)])
        self.assertEqual(block_segments('concurrent-24', 0, 24) + block_segments('concurrent-24', 1, 24),
                         [('candidate', 24), ('r3', 24), ('r3', 24), ('candidate', 24)])

    def exercise_compare(self, invalid=False, mode='acceptance', attributed_ms=50):
        # Drive the Python director through its pipe boundary. No Docker, clock
        # waiting or product substitute is used as performance evidence.
        calls, clock = [], [0.]
        class Fixture(unittest.TestCase):
            image, baseline_image = 'candidate-image', 'r3-image'
            created, env, label, token, latency_probe = {'container': []}, {}, 'owned=fixture', 'fixture', ''
            def start_db(self, *args, **kwargs): return 'owned-db'
            def provision(self, *args): pass
            def migrate(self, *args): pass
            def ok(self, *args, **kwargs): pass
            def volume(self, *args): return 'owned-state'
            def url(self): return 'postgresql://synthetic.invalid/db'
        class Process:
            def __init__(self, argv, **kwargs):
                self.version = 'candidate' if 'candidate-image' in argv else 'r3'
                self.ready, self.value = True, None
                self.stdin = self.stdout = self
            def write(self, line): self.value = json.loads(line)
            def flush(self): pass
            def readline(self):
                if self.ready:
                    self.ready = False
                    return 'EMR_BENCHMARK {"ready":true}\n'
                command = self.value
                calls.append((self.version, command))
                clock[0] += command['count'] * .25
                return 'EMR_BENCHMARK ' + json.dumps({'summary': {'failures': 0},
                    'results': [{'receipt_ms': 50, 'attributed_ms': attributed_ms}] * command['count']}) + '\n'
            def communicate(self, **kwargs): return '', ''
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            preflight = root / 'preflight.json'
            preflight.write_text(json.dumps({'verdict': 'QUIET', 'unit': 'emr-b1-r7-jit',
                                             'probe': 'probe', 'probe_label': 'owned=probe'}))
            monitor = MagicMock()
            if invalid:
                monitor.sample.side_effect = q.InvalidRun('foreign workload during measurement')
            env = {'KIN_EMR_BENCHMARK_MODE': mode, 'GITHUB_ACTIONS': 'false',
                   'KIN_EMR_ACCEPTANCE_RECORD': str(preflight), 'KIN_EMR_LIVE_EVIDENCE': str(root)}
            with patch.dict(os.environ, env), patch.object(acceptance.subprocess, 'Popen', Process), \
                    patch.object(acceptance, 'QuietMonitor', return_value=monitor), \
                    patch.object(acceptance.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(acceptance.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)), \
                    contextlib.redirect_stdout(io.StringIO()):
                if invalid:
                    with self.assertRaises(q.InvalidRun):
                        acceptance.compare(Fixture(), ['single'])
                else:
                    acceptance.compare(Fixture(), ['single'])
            report = json.loads(next(root.glob('comparison-*/summary.json')).read_text())
            return calls, report

    def test_director_collects_full_blocks_before_one_verdict(self):
        calls, report = self.exercise_compare()
        measured = [(version, request) for version, request in calls if request['count'] != 5]
        self.assertEqual(len(measured), 120)
        self.assertEqual([version for version, _ in measured[:4]], ['candidate', 'r3', 'r3', 'candidate'])
        self.assertTrue(all(request['count'] == 20 and request['idle_ms'] == 200 for _, request in measured))
        self.assertEqual(report['verdict'], 'PASS')
        result = report['results']['single']
        self.assertEqual((result['paired_blocks'], result['samples_per_revision']), (30, 1200))
        self.assertGreaterEqual(result['block_start_span_seconds'], 600)

    def test_director_records_invalid_without_performance_failure(self):
        _, report = self.exercise_compare(invalid=True)
        self.assertEqual(report['verdict'], 'INVALID')
        self.assertEqual(report['verdict_attempts_consumed'], 0)
        self.assertTrue(report['runner_attempt_consumed'])
        self.assertEqual(report['results'], {})

    def test_ci_records_attribution_without_an_acceptance_gate(self):
        _, report = self.exercise_compare(mode='ci-gross', attributed_ms=25)
        self.assertEqual(report['verdict'], 'CI_PASS')
        self.assertFalse(report['results']['single']['attribution_met'])
        self.assertTrue(report['results']['single']['gate_passed'])

    def test_ci_statistics_record_keeps_full_bounds_and_raw_binding(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaises(ValueError):
                acceptance.summarize(root)
            path = root / 'comparison-synthetic/summary.json'
            path.parent.mkdir()
            stats = {'point_ratio': 1.02, 'upper_95_ratio': 1.21, 'block_log_ratios': [.01, .03]}
            raw = json.dumps({'mode': 'ci-gross', 'verdict': 'CI_PASS', 'design': {'single': [6, 10, 0]},
                              'results': {'single': stats}, 'raw_directory': str(path.parent)}).encode()
            path.write_bytes(raw)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                acceptance.summarize(root)
            record = json.loads(output.getvalue())['reports'][0]
            self.assertEqual(record['results']['single'], stats)
            self.assertEqual(record['sha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(record['raw_directory'], str(path.parent))


if __name__ == '__main__':
    unittest.main()
