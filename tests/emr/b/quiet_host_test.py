"""REQ-D952 -> RISK-EMR-HOST-NOISE -> refusal before lease, invalid during run."""
import json
import hashlib
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch, MagicMock

import quiet_host as q
import live_acceptance as acceptance
from live_acceptance import block_design, block_segments
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def full_plan(unit='emr-b1-r7-jit', timeout=3600):
    return {'unit': unit, 'mode': 'live', 'max_attempts': 3, 'timeout_seconds': timeout,
            'tests': [{'file': 'tests/emr/b/live.py', 'case': 'EmrBLedgerLive.' + name} for name in (
                'test_b03_idempotency_and_concurrent_append', 'test_b03b_concurrent_48_receipts',
                'test_b03c_warm_single_sustained_and_verification_plans')] + [
                {'file': 'tests/emr/b/live_mutants.py', 'case': 'EmrBLiveMutants.test_m36_receipt_startup_delay'}]}


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
            plan.write_text(json.dumps(full_plan()))
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
            monitor.sample({}, True)
            monitor.sample({}, True)
            with self.assertRaises(q.InvalidRun):
                monitor.sample({}, True)
            with self.assertRaises(q.InvalidRun):
                monitor.require_valid()
            self.assertEqual(len(out.read_text().splitlines()), 3)
            self.assertTrue(all(not json.loads(row)['quiet'] for row in out.read_text().splitlines()))

    def test_active_spike_resets_after_a_quiet_window(self):
        probe = MagicMock()
        probe.snapshot.side_effect = [({}, {'host_cpu': v, 'engine_cpu': .01, 'containers': []})
                                      for v in [.95, .95, .1, .95, .1]]
        with tempfile.TemporaryDirectory() as folder:
            monitor = q.QuietMonitor(probe, Path(folder) / 'samples.jsonl', set())
            for _ in range(5): monitor.sample({}, True)
            monitor.require_valid()

    def test_idle_wait_keeps_busy_windows_then_accepts_quiet(self):
        clock = [0.]
        probe = MagicMock()
        probe.snapshot.side_effect = [({}, {'host_cpu': v, 'engine_cpu': .01, 'containers': []}) for v in [.3, .4, .1]]
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(q.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(q.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)):
            path = Path(folder) / 'samples.jsonl'
            monitor = q.QuietMonitor(probe, path, set())
            monitor.wait_quiet()
            self.assertEqual(clock[0], 6)
            self.assertEqual([json.loads(row)['quiet'] for row in path.read_text().splitlines()], [False, False, True])

    def test_persistent_idle_noise_times_out_without_accepting(self):
        clock = [0.]
        probe = MagicMock()
        probe.snapshot.return_value = {}, {'host_cpu': .3, 'engine_cpu': .01, 'containers': []}
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(q.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(q.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)):
            monitor = q.QuietMonitor(probe, Path(folder) / 'samples.jsonl', set())
            with self.assertRaises(q.InvalidRun): monitor.wait_quiet()
            self.assertEqual(clock[0], 30)
            self.assertEqual(probe.snapshot.call_count, 15)

    def test_probe_retry_once_and_persistent_failure_is_invalid(self):
        with tempfile.TemporaryDirectory() as folder:
            probe = MagicMock()
            probe.snapshot.side_effect = [OSError('transient'), ({}, {'host_cpu': .1, 'engine_cpu': .1, 'containers': []})]
            monitor = q.QuietMonitor(probe, Path(folder) / 'samples.jsonl', set())
            monitor.sample({}, True)
            self.assertEqual(probe.snapshot.call_count, 2)
            probe.snapshot.side_effect = OSError('persistent')
            with self.assertRaises(q.InvalidRun): monitor.sample({}, True)
            self.assertEqual(probe.snapshot.call_count, 4)

    def test_duration_refusal_precedes_probe_and_gate(self):
        import live_test_gate as gate
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plan = root / 'plan.json'
            plan.write_text(json.dumps(full_plan(timeout=1800)))
            with patch.object(gate, 'preflight_live') as lease, patch.object(q, 'command') as command, \
                    patch.object(q.subprocess, 'run') as runner, patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}):
                self.assertEqual(q.launch(plan, root / 'record'), 2)
            lease.assert_not_called()
            command.assert_not_called()
            runner.assert_not_called()
            record = json.loads((root / 'record/plan-record.json').read_text())
            self.assertFalse(record['duration_estimate']['within_cap'])
            self.assertEqual(record['plan_sha256'], hashlib.sha256(plan.read_bytes()).hexdigest())

    def test_full_duration_is_under_fifty_minutes(self):
        estimate = acceptance.estimate_duration(full_plan())
        self.assertTrue(estimate['within_cap'])
        self.assertLessEqual(estimate['estimated_seconds'], 3000)
        with self.assertRaises(ValueError): acceptance.estimate_duration({**full_plan(), 'tests': []})
        with patch.object(acceptance, 'RETAINED_ROWS', 40000):
            self.assertFalse(acceptance.estimate_duration(full_plan())['within_cap'])

    def test_acceptance_sizes_and_ten_minute_single_spread(self):
        for work, blocks, size in [('single', 12, 100), ('concurrent-24', 24, 24),
                                    ('concurrent-48', 24, 48), ('sustained', 12, 200)]:
            count, requests, spacing = block_design(work, 'acceptance')
            self.assertEqual((count, requests), (blocks, size))
            if work == 'single':
                self.assertGreaterEqual(spacing * (count-1), 600)
        self.assertEqual(block_design('single', 'ci-gross')[:2], (6, 10))
        self.assertEqual(block_design('single', 'ci-gross', dry_run=True), block_design('single', 'acceptance'))
        self.assertGreaterEqual(acceptance.estimate_duration(full_plan())['components_seconds']['single'], 650)

    def test_single_experimental_unit_is_one_complete_abba_block(self):
        self.assertEqual(block_segments('single', 0, 40), [('candidate', 20), ('r3', 20), ('r3', 20), ('candidate', 20)])
        self.assertEqual(block_segments('single', 1, 40), [('r3', 20), ('candidate', 20), ('candidate', 20), ('r3', 20)])
        self.assertEqual(block_segments('concurrent-24', 0, 24) + block_segments('concurrent-24', 1, 24),
                         [('candidate', 24), ('r3', 24), ('r3', 24), ('candidate', 24)])

    def exercise_compare(self, invalid=False, mode='acceptance', attributed_ms=50, stale_plan=False, workloads=None, quiet_delays=None, candidate_ratio=1.):
        # Drive the Python director through its pipe boundary. No Docker, clock
        # waiting or product substitute is used as performance evidence.
        calls, clock = [], [0.]
        prefill_barrier = threading.Barrier(2)
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
                if command['kind'] == 'prefill':
                    # The second revision must enter its own pipe before either
                    # response can complete: a serial prefill times out here.
                    prefill_barrier.wait(timeout=5)
                    return 'EMR_BENCHMARK ' + json.dumps({'before': 5, 'after': 5 + command['count']}) + '\n'
                if command['kind'] == 'plans':
                    return 'EMR_BENCHMARK {"plans":[]}\n'
                clock[0] += command['count'] * .25
                return 'EMR_BENCHMARK ' + json.dumps({'summary': {'failures': 0},
                    'results': [{'receipt_ms': 50 * (candidate_ratio if self.version == 'candidate' else 1),
                                 'attributed_ms': attributed_ms * (candidate_ratio if self.version == 'candidate' else 1)}] * command['count']}) + '\n'
            def communicate(self, **kwargs): return '', ''
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            preflight = root / 'preflight.json'
            plan = root / 'plan.json'
            plan.write_text(json.dumps(full_plan(unit='reviewed-other-unit')))
            preflight.write_text(json.dumps({'verdict': 'QUIET', 'unit': 'reviewed-other-unit',
                                             'plan_sha256': 'stale' if stale_plan else hashlib.sha256(plan.read_bytes()).hexdigest(),
                                             'probe': 'probe', 'probe_label': 'owned=probe'}))
            monitor = MagicMock()
            if invalid:
                monitor.wait_quiet.side_effect = q.InvalidRun('foreign workload during measurement')
            elif quiet_delays:
                delays = iter(quiet_delays)
                monitor.wait_quiet.side_effect = lambda: clock.__setitem__(0, clock[0] + next(delays))
            env = {'KIN_EMR_BENCHMARK_MODE': mode, 'GITHUB_ACTIONS': 'false',
                   'KIN_EMR_ACCEPTANCE_RECORD': str(preflight), 'KIN_EMR_LIVE_EVIDENCE': str(root)}
            env['KIN_EMR_ACCEPTANCE_PLAN'] = str(plan)
            with patch.dict(os.environ, env), patch.object(acceptance.subprocess, 'Popen', Process), \
                    patch.object(acceptance, 'QuietMonitor', return_value=monitor), \
                    patch.object(acceptance.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(acceptance.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)), \
                    contextlib.redirect_stdout(io.StringIO()):
                if invalid:
                    with self.assertRaises(q.InvalidRun):
                        acceptance.compare(Fixture(), workloads or ['single'])
                else:
                    acceptance.compare(Fixture(), workloads or ['single'])
            report = json.loads(next(root.glob('comparison-*/summary.json')).read_text())
            return calls, report

    def test_director_collects_full_blocks_before_one_verdict(self):
        calls, report = self.exercise_compare()
        measured = [(version, request) for version, request in calls if request['count'] != 5]
        self.assertEqual(len(measured), 48)
        self.assertEqual([version for version, _ in measured[:4]], ['candidate', 'r3', 'r3', 'candidate'])
        self.assertTrue(all(request['count'] == 50 and request['idle_ms'] == 200 for _, request in measured))
        self.assertEqual(report['verdict'], 'PASS')
        result = report['results']['single']
        self.assertEqual((result['paired_blocks'], result['samples_per_revision']), (12, 1200))
        self.assertGreaterEqual(result['block_start_span_seconds'], 600)

    def test_variable_quiet_wait_does_not_shorten_measured_start_spread(self):
        # A long first quiet window must not move the first measured start past
        # the scheduling origin while leaving the last target unchanged.
        _, report = self.exercise_compare(quiet_delays=[9.] + [.1] * 11)
        self.assertGreaterEqual(report['results']['single']['block_start_span_seconds'], 600)

    def test_changed_plan_cannot_use_an_old_quiet_record(self):
        with self.assertRaises(q.InvalidRun): self.exercise_compare(stale_plan=True)

    def test_sustained_prefills_independent_revisions_concurrently(self):
        calls, report = self.exercise_compare(workloads=['sustained'])
        seeds = [(v, c['count']) for v, c in calls if c['kind'] == 'prefill']
        self.assertCountEqual(seeds, [('candidate', 20000), ('r3', 20000)])
        self.assertTrue(report['prefill']['parallel'])
        self.assertEqual(report['results']['sustained']['samples_per_revision'], 2400)

    def test_director_records_and_applies_both_concurrent_rules(self):
        _, report = self.exercise_compare(workloads=['concurrent-24', 'concurrent-48'], candidate_ratio=1.05)
        self.assertEqual(report['verdict'], 'PASS')
        for result in report['results'].values():
            self.assertTrue(result['noninferiority_met'])
            self.assertTrue(result['median']['accepted'])
            self.assertEqual(result['point_limit'], 1.10)
            self.assertIsNone(result['median']['point_limit'])
            self.assertEqual(result['median']['upper_limit'], 1.10)

    def test_control_reuse_is_bound_to_process_image_run_and_evidence(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'KIN_EMR_LIVE_EVIDENCE': 'run-one'}):
            path = Path(folder) / 'summary.json'
            path.write_text('{}')
            report = {'verdict': 'PASS', 'raw_directory': folder}
            acceptance.register_l03_control('image-one', report)
            self.assertTrue(acceptance.reusable_l03_control('image-one')['passed'])
            self.assertIsNone(acceptance.reusable_l03_control('image-two'))
            with patch.dict(os.environ, {'KIN_EMR_LIVE_EVIDENCE': 'run-two'}):
                self.assertIsNone(acceptance.reusable_l03_control('image-one'))
            path.write_text('{"tampered":true}')
            self.assertIsNone(acceptance.reusable_l03_control('image-one'))
            with self.assertRaises(ValueError):
                acceptance.register_l03_control('image-one', {**report, 'verdict': 'FAIL'})

    def test_gap_offset_uses_balanced_conditions_not_initial_warmup(self):
        samples = {version: [[{'scheduled_gap_ms': gap, 'receipt_ms': latency}
                             for gap, latency in [(0, base), (200, base + extra)]] * 10 for _ in range(6)]
                   for version, base, extra in [('r3', 100, 2), ('candidate', 20, 7)]}
        result = acceptance.summarize_gap_diagnostic(samples)
        self.assertEqual(result['post_gap_offset_ms'], 5.)
        self.assertEqual(result['upper_95_one_sided_ms'], 5.)
        self.assertEqual(result['conditions']['candidate']['200']['count'], 60)

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
