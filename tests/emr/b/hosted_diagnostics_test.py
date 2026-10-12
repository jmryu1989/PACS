"""REQ-D1038 -> RISK-HOST-OFFSET/START-ORDER -> TEST-HOSTED-AA/ORDER.

Numeric oracles and a pipe/resource-boundary fake exercise the executed design.
No Docker, live gate, product structure or timing claims from these tests.
"""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import hosted_diagnostics as h
import live_acceptance as acceptance


def records(deltas):
    return [{'pair': i, 'start_order': 'r3-first' if i in (0, 1, 4) else 'candidate-first',
             'request_order': 'candidate-first' if i % 2 == 0 else 'r3-first', 'D_ms': d}
            for i, d in enumerate(deltas)]


class HostedDiagnosticsTest(unittest.TestCase):
    def test_control_numeric_boundaries_and_signed_pairs(self):
        for a, b, expected in [(9, 9, True), (9, 14, True), (9, 14.01, False),
                               (100, 125, True), (100, 125.01, False), (100, 90, True)]:
            with self.subTest(a=a, b=b):
                value = h.control_statistics({'r3': [[a]] * 6, 'candidate': [[b]] * 6}, records([b-a] * 6))
                self.assertEqual(value['control_qualifies'], expected)
                self.assertAlmostEqual(value['control_R'], b/a)
                self.assertEqual(value['control_D_ms'], b-a)
                self.assertEqual(value['control_pair_deltas_ms'], [b-a] * 6)
        deltas = [5, 100, -89] * 2
        value = h.control_statistics({'r3': [[v] for v in [1, 5, 100] * 2],
                                      'candidate': [[v] for v in [6, 105, 11] * 2]}, records(deltas))
        self.assertAlmostEqual(value['control_R'], (6*21*.11)**(1/3))
        self.assertEqual(value['control_D_ms'], 5)
        self.assertTrue(value['control_qualifies'])

    def test_invalid_control_observations_never_qualify(self):
        valid = {'r3': [[10.]] * 6, 'candidate': [[10.]] * 6}
        invalid = [{}, {**valid, 'candidate': []}, {**valid, 'candidate': [[10.]] * 5},
                   {**valid, 'candidate': [[10., 11.]] * 6}]
        invalid += [{**valid, 'candidate': [[v]] * 6} for v in (0, -1, float('nan'), float('inf'), None, '10', True)]
        for samples in invalid:
            with self.subTest(samples=samples):
                self.assertFalse(h.control_statistics(samples, records([0] * 6))['control_qualifies'])
        self.assertFalse(h.control_statistics(valid, records([0] * 6), error='request failed')['control_qualifies'])
        self.assertFalse(h.control_statistics(valid, records([1] * 6))['control_qualifies'])
        self.assertFalse(h.control_statistics(valid, [None] * 6)['control_qualifies'])

    def test_order_medians_use_recorded_pairs_and_missing_order_refuses(self):
        pairs = records([1, 8, 3, 10, 5, 12])
        result = h.order_statistics(pairs)
        self.assertTrue(result['start_order_qualifies'])
        self.assertEqual(result['D_ms_by_start_order'], {'r3-first': 5, 'candidate-first': 10})
        self.assertEqual(result['D_ms_by_request_order'], {'r3-first': 10, 'candidate-first': 3})
        self.assertEqual(result['start_request_table'], {
            'r3-first': {'r3-first': {'count': 1, 'D_ms': 8}, 'candidate-first': {'count': 2, 'D_ms': 3}},
            'candidate-first': {'r3-first': {'count': 2, 'D_ms': 11}, 'candidate-first': {'count': 1, 'D_ms': 3}}})
        self.assertAlmostEqual(result['request_order_phi'], -1/3)
        pairs[4]['D_ms'] = -7
        self.assertEqual(h.order_statistics(pairs)['D_ms_by_start_order']['r3-first'], 1)
        broken = [None, [], pairs[:-1], [None] * 6]
        for update in ({'start_order': None}, {'start_order': 'candidate-first'}, {'pair': 1},
                       {'request_order': None}, {'request_order': 'r3-first'}, {'D_ms': float('nan')}):
            rows = copy.deepcopy(pairs)
            rows[0].update(update)
            broken.append(rows)
        for rows in broken:
            self.assertFalse(h.order_statistics(rows)['start_order_qualifies'])
        missing = records([0] * 6)
        del missing[0]['start_order']
        self.assertFalse(h.control_statistics({'r3': [[10]] * 6, 'candidate': [[10]] * 6}, missing)['control_qualifies'])

    def test_plan_has_six_fresh_pairs_each_order_and_abba_requests(self):
        plan = h.hosted_plan(['single', 'sustained', 'concurrent-24'])
        self.assertEqual([p['phase'] for p in plan['phases']], ['ab', 'aa'])
        for phase in plan['phases']:
            self.assertEqual(len(phase['pairs']), 6)
            self.assertEqual([p['start_order'] for p in phase['pairs']].count('r3-first'), 3)
            self.assertEqual([p['start_order'] for p in phase['pairs']].count('candidate-first'), 3)
            for pair in phase['pairs']:
                self.assertTrue(pair['fresh_db_and_state'])
                single = pair['workloads']['single']['segments']
                self.assertEqual([v for v, _ in single], ['candidate', 'r3', 'r3', 'candidate']
                                 if pair['pair'] % 2 == 0 else ['r3', 'candidate', 'candidate', 'r3'])
                self.assertEqual(sum(n for v, n in single if v == 'candidate'), 10)
                self.assertCountEqual(pair['workloads']['sustained']['plan_check'], ['r3', 'candidate'])
        self.assertNotIn('concurrent-24', plan['phases'][1]['pairs'][0]['workloads'])

    def exercise(self, *, ab_latency=10, base_latency=10, control_latency=10, failure=None,
                 request_failures=False, workloads=None, elapsed=0, crash_aa=False,
                 failure_measurement_only=False):
        events, clock = [], [0.]
        class Fixture(unittest.TestCase):
            image, baseline_image = 'sha256:candidate', 'sha256:r3'
            created, env, label, token, latency_probe = {'container': [], 'volume': []}, {}, 'owned=fixture', 'fixture', ''
            def start_db(self, suffix, persistent=False):
                self.assertTrue(persistent)
                name = suffix + '-db'
                self.created['container'].append(name)
                events.append(('db', name, self.image))
                if '-aa-' in name:
                    persisted = json.loads(next(Path(folder).glob('comparison-*/summary.json')).read_text())
                    events.append(('before_aa', persisted))
                    if crash_aa:
                        raise KeyboardInterrupt('simulated worker interruption')
                self.volume(suffix + '-pg')
                return name
            def provision(self, db): events.append(('provision', db))
            def migrate(self, db): events.append(('migrate', db, self.image))
            def ok(self, *args, **kwargs): pass
            def volume(self, suffix):
                name = suffix + '-state'
                self.created['volume'].append(name)
                events.append(('volume', name))
                return name
            def url(self): return 'postgresql://synthetic.invalid/db'
        class Process:
            def __init__(self, argv, **kwargs):
                self.name = argv[argv.index('--name')+1]
                self.version = 'candidate' if self.name.endswith('-candidate') else 'r3'
                self.phase = 'aa' if '-aa-' in self.name else 'ab'
                self.image = argv[argv.index('--entrypoint') + 2]
                self.ready, self.request = True, None
                self.stdin = self.stdout = self
                events.append(('process', self.name, self.image))
            def write(self, line): self.request = json.loads(line)
            def flush(self): pass
            def readline(self):
                if self.ready:
                    self.ready = False
                    return 'EMR_BENCHMARK {"ready":true}\n'
                request = self.request
                events.append(('command', self.name, dict(request)))
                if (failure and (self.phase, request['kind'], self.version) == failure
                        and (not failure_measurement_only or 'idle_ms' in request)):
                    return 'EMR_BENCHMARK {"error":"injected request/plan failure"}\n'
                if request['kind'] == 'prefill':
                    return 'EMR_BENCHMARK ' + json.dumps({'before': 5, 'after': 5+request['count']}) + '\n'
                if request['kind'] == 'plans':
                    if self.phase == 'ab' and self.version == 'r3':
                        return 'EMR_BENCHMARK {"error":"ERR_ASSERTION","detail":"nested JIT must be off: emr_access.access_retention_floor(timestamp with time zone)"}\n'
                    return 'EMR_BENCHMARK {"plans":[{"jit":false}]}\n'
                value = (control_latency if self.phase == 'aa' else ab_latency) if self.version == 'candidate' else base_latency
                failures = int(request_failures and self.phase == 'ab' and request['kind'] == 'sustained')
                return 'EMR_BENCHMARK ' + json.dumps({'summary': {'failures': failures},
                    'results': [{'receipt_ms': value, 'attributed_ms': value, 'segment_request': i,
                                 'idle_gap_ms': request.get('idle_ms', 0)} for i in range(request['count'])]}) + '\n'
            def communicate(self, **kwargs):
                events.append(('close', self.name))
                return '', ''
        def remove(argv, **kwargs):
            if argv[1:3] == ['image', 'inspect']:
                return SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': argv[-1]}]))
            events.append(('remove', argv[-1]))
            return SimpleNamespace(returncode=0)
        with tempfile.TemporaryDirectory() as folder, \
                patch.dict(os.environ, {'KIN_EMR_BENCHMARK_MODE': 'ci-gross', 'KIN_EMR_LIVE_EVIDENCE': folder}), \
                patch.object(h.subprocess, 'Popen', Process), patch.object(h.subprocess, 'run', side_effect=remove), \
                patch.object(h.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0]+n)), \
                patch.object(h.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(h, 'unit_elapsed_seconds', side_effect=lambda: elapsed + clock[0]), \
                contextlib.redirect_stdout(io.StringIO()) as progress:
            caught = None
            try:
                acceptance.compare(Fixture(), workloads or ['single', 'sustained'])
            except (AssertionError, KeyboardInterrupt) as error:
                caught = error
            report = json.loads(next(Path(folder).glob('comparison-*/summary.json')).read_text())
            self.assertEqual(Fixture.created, {'container': [], 'volume': []})
            self.assertEqual(Fixture.image, 'sha256:candidate')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                acceptance.summarize(folder)
            summary = json.loads(output.getvalue())
            summary['progress'] = progress.getvalue().splitlines()
        return report, events, caught, summary

    def test_executed_starts_are_fresh_balanced_symmetric_and_control_digest_equal(self):
        report, events, error, summary = self.exercise()
        self.assertIsNone(error)
        self.assertEqual(report['verdict'], 'CI_PASS')
        self.assertEqual(summary['run_qualification']['would_be'], 'VALID')
        ab_events = [i for i, e in enumerate(events) if len(e) > 1 and isinstance(e[1], str) and '-ab-' in e[1]]
        aa_events = [i for i, e in enumerate(events) if len(e) > 1 and isinstance(e[1], str) and '-aa-' in e[1]]
        self.assertLess(max(ab_events), min(aa_events))
        instances = [instance for pair in report['preparations'] for instance in pair['instances']]
        self.assertEqual(len(instances), 24)
        for resource in ('db', 'state_volume', 'container'):
            self.assertEqual(len({i[resource] for i in instances}), 24, resource)
        for _, persisted in (e for e in events if e[0] == 'before_aa'):
            self.assertEqual(persisted['verdict'], 'CI_PASS')
            self.assertEqual(set(persisted['results']), {'single', 'sustained'})
        databases = [e[1] for e in events if e[0] == 'db']
        volumes = [e[1] for e in events if e[0] == 'volume']
        self.assertEqual(len(databases), 24)
        self.assertEqual(len(set(databases)), 24)
        self.assertEqual(len(set(volumes)), len(volumes))
        self.assertEqual(len([e for e in events if e[0] == 'remove']), 48 + len(volumes))
        for phase in ('ab', 'aa'):
            for index in range(6):
                processes = [e for e in events if e[0] == 'process' and '-%s-%s-' % (phase, index) in e[1]]
                versions = [e[1].rsplit('-', 1)[-1] for e in processes]
                self.assertEqual(versions, ['r3', 'candidate'] if index in (0, 1, 4) else ['candidate', 'r3'])
                if phase == 'aa':
                    self.assertEqual([e[2] for e in processes], ['sha256:candidate'] * 2)
                for _, name, _ in processes:
                    commands = [e[2] for e in events if e[0] == 'command' and e[1] == name]
                    self.assertEqual(commands[0], {'kind': 'single', 'count': 5})
                    kinds = [c['kind'] for c in commands]
                    self.assertLess(kinds.index('prefill'), kinds.index('plans'))
                    self.assertLess(kinds.index('plans'), kinds.index('sustained'))
                    self.assertEqual(next(c['count'] for c in commands if c['kind'] == 'prefill'), 20000)
                # Every owned process/DB is gone before preparing the next pair.
                last_close = max(i for i, e in enumerate(events) if e[0] == 'close' and e[1] in [p[1] for p in processes])
                next_db = next((i for i in range(last_close+1, len(events)) if events[i][0] == 'db'), len(events))
                removed = [e[1] for e in events[last_close:next_db] if e[0] == 'remove']
                self.assertTrue(all(p[1] in removed for p in processes))
        for workload in ('single', 'sustained'):
            result = report['results'][workload]
            self.assertEqual(result['paired_blocks'], 6)
            self.assertEqual(result['D_ms_by_start_order'], {'r3-first': 0, 'candidate-first': 0})
            self.assertTrue(result['control_qualifies'])
            self.assertEqual(summary['reports'][0]['results'][workload], result)
            self.assertAlmostEqual(result['request_order_phi'], -1/3)
        self.assertEqual(summary['reports'][0]['jit'], {'plans': [{'jit': False}]})
        self.assertEqual(report['post_gap']['candidate']['post_gap_ms'], 10)
        self.assertEqual(report['post_gap']['r3']['gap_free_warm_ms'], 10)
        self.assertEqual(report['post_gap']['warmup_based_offset_ms'], 0)
        for prefix in ('EMR_LIVE_PAIR ', 'EMR_LIVE_BLOCK ', 'EMR_LIVE_PREFILL ', 'EMR_VERIFICATION_PLAN '):
            self.assertTrue(any(line.startswith(prefix) for line in summary['progress']), prefix)
        first_acceptance = next(i for i, line in enumerate(summary['progress']) if line.startswith('EMR_LIVE_ACCEPTANCE '))
        first_aa = next(i for i, line in enumerate(summary['progress']) if line.startswith('EMR_LIVE_PAIR ') and '"phase": "aa"' in line)
        self.assertLess(first_acceptance, first_aa)

    def test_invalid_or_noisy_control_never_changes_ab_verdict(self):
        for options in ({'control_latency': 20}, {'failure': ('aa', 'plans', 'r3')},
                        {'failure': ('aa', 'single', 'candidate')}):
            with self.subTest(options=options):
                report, _, error, summary = self.exercise(**options)
                self.assertIsNone(error)
                self.assertEqual(report['verdict'], 'CI_PASS')
                self.assertEqual(report['run_qualification']['would_be'], 'INVALID')
                self.assertEqual(summary['run_qualification']['would_be'], 'INVALID')
                self.assertFalse(report['results']['single']['control_qualifies'])
        report, _, error, _ = self.exercise(ab_latency=20)
        self.assertIsNotNone(error)
        self.assertEqual(report['verdict'], 'FAIL')
        self.assertEqual(report['run_qualification']['would_be'], 'VALID')
        self.assertTrue(report['results']['single']['control_qualifies'])
        report, _, error, _ = self.exercise(ab_latency=20, control_latency=20)
        self.assertIsNotNone(error)
        self.assertEqual(report['verdict'], 'FAIL')
        self.assertEqual(report['run_qualification']['would_be'], 'INVALID')
        self.assertFalse(report['results']['single']['gate_passed'])

    def test_ab_plan_failure_remains_a_blocker_and_preserves_partial_evidence(self):
        report, _, error, _ = self.exercise(failure=('ab', 'plans', 'candidate'))
        self.assertIsNotNone(error)
        self.assertEqual(report['verdict'], 'INCOMPLETE')
        self.assertEqual(report['run_qualification']['would_be'], 'INVALID')
        self.assertTrue(report['samples']['single'])
        self.assertEqual(report['results']['single']['paired_blocks'], 1)
        self.assertFalse(report['results']['single']['complete'])
        self.assertIn('error', report['jit'])
        self.assertEqual(report['post_gap']['candidate']['post_gap_ms'], 10)

    def test_baseline_plan_errors_are_record_only(self):
        report, _, error, _ = self.exercise(failure=('ab', 'plans', 'r3'))
        self.assertIsNone(error)
        self.assertEqual(report['verdict'], 'CI_PASS')
        for pair in report['preparations']:
            details = pair['workloads']['sustained']
            self.assertCountEqual(details['plans'], ['r3', 'candidate'])
            self.assertCountEqual(details['plan_seconds'], ['r3', 'candidate'])
            if pair['phase'] == 'ab':
                self.assertIn('error', details['plans']['r3'])

    def test_ab_single_error_is_a_failure_during_warmup_and_measurement(self):
        for options in ({}, {'failure_measurement_only': True}):
            with self.subTest(options=options):
                report, events, error, summary = self.exercise(failure=('ab', 'single', 'r3'), **options)
                self.assertIsInstance(error, AssertionError)
                self.assertEqual(report['verdict'], 'INCOMPLETE')
                self.assertEqual(report['run_qualification']['would_be'], 'INVALID')
                self.assertEqual(summary['run_qualification']['would_be'], 'INVALID')
                requests = [event[2] for event in events if event[0] == 'command']
                if options:
                    self.assertIn('idle_ms', requests[-1])
                else:
                    # A rejected warm-up must stop before either slot is measured.
                    self.assertEqual(len(requests), 1)
                    self.assertNotIn('idle_ms', requests[0])

    def test_ab_compare_mode_and_both_gross_limits(self):
        for baseline, candidate, expected in [(10, 12, 'CI_PASS'), (10, 16, 'FAIL'),
                                               (100, 120, 'CI_PASS'), (100, 125, 'CI_PASS'),
                                               (10, 15, 'CI_PASS'), (10, 15.01, 'FAIL')]:
            with self.subTest(baseline=baseline, candidate=candidate):
                report, _, error, _ = self.exercise(base_latency=baseline, ab_latency=candidate,
                                                     workloads=['concurrent-24'])
                self.assertEqual(report['verdict'], expected)
                self.assertEqual(error is None, expected == 'CI_PASS')
                self.assertEqual(report['results']['concurrent-24']['gate_ratio_limit'], 1.25)
                self.assertEqual(report['results']['concurrent-24']['gate_delta_floor_ms'], 5)

    def test_request_failure_blocks_and_retains_partial_single(self):
        report, _, error, _ = self.exercise(request_failures=True)
        self.assertIsNotNone(error)
        self.assertEqual(report['verdict'], 'INCOMPLETE')
        self.assertEqual(report['results']['single']['paired_blocks'], 1)
        self.assertNotIn('sustained', report['results'])

    def test_budget_skips_only_control_and_preserves_pass_and_fail(self):
        for latency, expected in [(10, 'CI_PASS'), (20, 'FAIL')]:
            report, events, error, summary = self.exercise(ab_latency=latency, elapsed=3400)
            self.assertEqual(report['verdict'], expected)
            self.assertEqual(error is None, expected == 'CI_PASS')
            self.assertFalse(any(p['phase'] == 'aa' for p in report['preparations']))
            self.assertEqual(report['run_qualification']['would_be'], 'INVALID')
            self.assertIn('budget', report['run_qualification']['reasons'])
            self.assertIn('budget', summary['run_qualification']['reasons'])
            self.assertLess(report['control_budget']['remaining_seconds'], 200)

    def test_budget_accounts_for_slow_pairs_and_prior_setup(self):
        report = {'preparations': [{'phase': 'ab', 'elapsed_seconds': 250}] * 6}
        with patch.object(h, 'unit_elapsed_seconds', return_value=1500):
            self.assertTrue(h.control_budget(report)['allowed'])
        with patch.object(h, 'unit_elapsed_seconds', return_value=1501):
            budget = h.control_budget(report)
            self.assertFalse(budget['allowed'])
            self.assertEqual(budget['required_aa_seconds'], 1800)
        with patch.object(h, 'unit_elapsed_seconds', side_effect=OSError('unavailable')):
            self.assertFalse(h.control_budget(report)['allowed'])

    def test_budget_clock_is_nonnegative_and_monotonic(self):
        elapsed = h.unit_elapsed_seconds()
        self.assertGreaterEqual(elapsed, 0)
        self.assertGreaterEqual(h.unit_elapsed_seconds(), elapsed)

    def test_budget_clock_includes_interpreter_age(self):
        result = subprocess.run(
            [sys.executable, '-B', '-c',
             'import time; time.sleep(1.5); import hosted_diagnostics; '
             'print(hosted_diagnostics.unit_elapsed_seconds())'],
            cwd=Path(__file__).resolve().parent, capture_output=True, text=True,
            check=True, timeout=30)
        elapsed = float(result.stdout.strip())
        self.assertGreaterEqual(elapsed, 1.5)
        self.assertLess(elapsed, 30)

    def test_run_qualification_uses_shared_gross_constants(self):
        report, _, _, _ = self.exercise(control_latency=12)
        self.assertEqual(h.run_qualification([report])['would_be'], 'VALID')
        with patch.object(h, 'CI_RATIO_LIMIT', 1.1), patch.object(h, 'CI_DELTA_FLOOR_MS', 1):
            self.assertEqual(h.run_qualification([report])['would_be'], 'INVALID')

    def test_ab_summary_survives_control_interruption(self):
        report, events, error, _ = self.exercise(crash_aa=True)
        self.assertIsInstance(error, KeyboardInterrupt)
        self.assertEqual(report['verdict'], 'CI_PASS')
        prior = next(e[1] for e in events if e[0] == 'before_aa')
        self.assertEqual(prior['verdict'], 'CI_PASS')
        self.assertTrue(prior['results']['single']['gate_passed'])

    def test_missing_order_and_missing_controls_cannot_qualify_run(self):
        report, _, _, _ = self.exercise()
        for update in ({'control_R': float('nan')}, {'control_D_ms': None},
                       {'control_pair_deltas_ms': []}, {'control_pair_deltas_ms': [1] * 6},
                       {'start_order_qualifies': False},
                       {'control_R': 2, 'control_D_ms': 10, 'control_pair_deltas_ms': [10] * 6}):
            broken = copy.deepcopy(report)
            broken['controls']['single'].update(update)
            self.assertEqual(h.run_qualification([broken])['would_be'], 'INVALID')
        del report['pairs']['single'][0]['start_order']
        self.assertEqual(h.run_qualification([report])['would_be'], 'INVALID')
        report['pairs']['single'][0]['start_order'] = 'r3-first'
        del report['controls']['sustained']
        self.assertEqual(h.run_qualification([report])['would_be'], 'INVALID')
        self.assertEqual(h.run_qualification([])['would_be'], 'INVALID')


if __name__ == '__main__':
    unittest.main()
