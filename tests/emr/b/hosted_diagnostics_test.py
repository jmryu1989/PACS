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
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import hosted_diagnostics as h
import live_acceptance as acceptance


def records(deltas):
    return [{'pair': i, 'start_order': 'r3-first' if i % 2 == 0 else 'candidate-first', 'D_ms': d}
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
        self.assertEqual(result['D_ms_by_start_order'], {'r3-first': 3, 'candidate-first': 10})
        pairs[4]['D_ms'] = -7
        self.assertEqual(h.order_statistics(pairs)['D_ms_by_start_order']['r3-first'], 1)
        broken = [None, [], pairs[:-1], [None] * 6]
        for update in ({'start_order': None}, {'start_order': 'candidate-first'}, {'pair': 1}, {'D_ms': float('nan')}):
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

    def exercise(self, *, ab_latency=10, control_latency=10, failure=None, workloads=None):
        events, clock = [], [0.]
        class Fixture(unittest.TestCase):
            image, baseline_image = 'sha256:candidate', 'sha256:r3'
            created, env, label, token, latency_probe = {'container': [], 'volume': []}, {}, 'owned=fixture', 'fixture', ''
            def start_db(self, suffix, persistent=False):
                self.assertTrue(persistent)
                name = suffix + '-db'
                self.created['container'].append(name)
                events.append(('db', name, self.image))
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
                self.image = argv[-5]
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
                if failure and (self.phase, request['kind'], self.version) == failure:
                    return 'EMR_BENCHMARK {"error":"injected request/plan failure"}\n'
                if request['kind'] == 'prefill':
                    return 'EMR_BENCHMARK ' + json.dumps({'before': 5, 'after': 5+request['count']}) + '\n'
                if request['kind'] == 'plans':
                    return 'EMR_BENCHMARK {"plans":[{"jit":false}]}\n'
                value = (control_latency if self.phase == 'aa' else ab_latency) if self.version == 'candidate' else 10
                return 'EMR_BENCHMARK ' + json.dumps({'summary': {'failures': 0},
                    'results': [{'receipt_ms': value, 'attributed_ms': value}] * request['count']}) + '\n'
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
                contextlib.redirect_stdout(io.StringIO()):
            caught = None
            try:
                acceptance.compare(Fixture(), workloads or ['single', 'sustained'])
            except AssertionError as error:
                caught = error
            report = json.loads(next(Path(folder).glob('comparison-*/summary.json')).read_text())
            self.assertEqual(Fixture.created, {'container': [], 'volume': []})
            self.assertEqual(Fixture.image, 'sha256:candidate')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                acceptance.summarize(folder)
            summary = json.loads(output.getvalue())
        return report, events, caught, summary

    def test_executed_starts_are_fresh_balanced_symmetric_and_control_digest_equal(self):
        report, events, error, summary = self.exercise()
        self.assertIsNone(error)
        self.assertEqual(report['verdict'], 'CI_PASS')
        self.assertEqual(summary['run_qualification']['would_be'], 'VALID')
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
                self.assertEqual(versions, ['r3', 'candidate'] if index % 2 == 0 else ['candidate', 'r3'])
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

    def test_ab_plan_failure_remains_a_blocker_and_preserves_partial_evidence(self):
        report, _, error, _ = self.exercise(failure=('ab', 'plans', 'r3'))
        self.assertIsNotNone(error)
        self.assertEqual(report['verdict'], 'INCOMPLETE')
        self.assertEqual(report['run_qualification']['would_be'], 'INVALID')
        self.assertTrue(report['samples']['single'])

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
