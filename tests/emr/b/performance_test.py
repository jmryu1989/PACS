"""REQ-D1006 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT/RECEIPT-DELAY -> hosted verdict controls.

Known observations exercise the report and negative-control consumer, without
timing a machine, pinning source text, or changing the live acceptance rule.
The negative-control driver runs for real on a copy of the runtime sources; only
its benchmark subprocess returns known summaries and raw sample rows.
"""
import contextlib
import copy
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from performance import ROOT, build_report, case_result
import performance_mutants as mutants
from performance_mutants import (MP02_BASELINE_P95_BOUND_MS as B, MP02_DELAY_MS as L,
                                 mutant_result, property_failures)

ROOT = Path(os.environ.get('EMR_R3_SOURCE_ROOT', ROOT))

LATENCY_KEYS = {'sustained': [('sustained', 20, 20000)], 'concurrent': [('concurrent', 24, 0), ('concurrent', 48, 0)]}
# The audit's four attribution inputs (performance-mutant-verdict.json):
# (name, baseline p95, candidate p95, revision with one failed request).
ATTRIBUTION_INPUTS = [('latency_regression', 100, 140, None), ('baseline_request_failed', 100, 100, 'r3'),
                      ('candidate_request_failed', 100, 100, 'r4d'), ('no_regression', 100, 100, None)]


def sample(p95, **values):
    return {'p50': p95, 'p95': p95, 'p99': p95, 'failures': 0,
            'read_rows': 0, 'read_bytes': 0, **values}


def pairs(baseline=100., candidate=100., repetitions=10):
    return {'r3': [sample(baseline) for _ in range(repetitions)],
            'r4d': [sample(candidate) for _ in range(repetitions)]}


def measured(case, baseline, candidate, failed=None):
    """performance.py's own summary for one latency property's cases."""
    report = {'failures': [], 'cases': {}, 'repetitions': 10}
    for name, count, retained in LATENCY_KEYS[case]:
        pair = pairs(baseline, candidate)
        if failed:
            pair[failed][0]['failures'] = 1
        stats, failures = case_result(name, count, retained, pair)
        report['cases'][f'{name}-{count}-{retained}'] = stats
        report['failures'] += failures
    return report


def receipt_rows(baseline_p95, receipts, requests=4):
    """Raw sustained sample rows: ten r3 blocks and ten r4d blocks whose
    per-receipt times are `receipts(rep)` (a list per block)."""
    rows = []
    for rep in range(10):
        rows.append(dict(sample(baseline_p95), label=f'sustained-{rep}-r3', version='r3', concurrency=20, prefill=20000,
                         requests=requests, request_instruments=[{'receipt_ms': baseline_p95}] * requests))
        times = receipts(rep)
        rows.append(dict(sample(max(times)), label=f'sustained-{rep}-r4d', version='r4d', concurrency=20, prefill=20000,
                         requests=len(times), request_instruments=[{'receipt_ms': t} for t in times]))
    return rows


def run_driver(only, report, receipt=None, control_failures=(), control_cases=None, raw_summary=None, error=None,
               capture=None):
    """Run the real performance_mutants.main on a copy of the real runtime
    sources; only the benchmark subprocess returns the given summary (or the
    given raw summary.json text, or raises `error`)."""
    with tempfile.TemporaryDirectory(prefix='emr-perf-driver-') as folder:
        base = Path(folder)
        (base / 'api/src/emr-runtime').mkdir(parents=True)
        sources = {}
        for name in ('seal.ts', 'store.ts', 'external-writer.ts'):
            raw = (ROOT / 'api/src/emr-runtime' / name).read_bytes()
            (base / 'api/src/emr-runtime' / name).write_bytes(raw)
            sources['api/src/emr-runtime/' + name] = hashlib.sha256(raw).hexdigest()
        (base / 'api/tsconfig.json').write_bytes((ROOT / 'api/tsconfig.json').read_bytes())
        sources['api/tsconfig.json'] = hashlib.sha256((base / 'api/tsconfig.json').read_bytes()).hexdigest()
        healthy = {**measured('sustained', 100, 100)['cases'], **measured('concurrent', 100, 100)['cases']}
        control = base / 'healthy.json'
        control.write_text(json.dumps({'candidate_sources': sources, 'repetitions': 10, 'failures': list(control_failures),
                                       'cases': healthy if control_cases is None else control_cases}))
        mutated = {}

        def benchmark(argv, **kwargs):
            target = Path(argv[argv.index('--out') + 1])
            target.mkdir(parents=True)
            candidate = Path(argv[argv.index('--candidate') + 1]) / 'api/src/emr-runtime'
            mutated.update({p.name: p.read_text(encoding='utf-8') for p in candidate.iterdir()})
            if error is not None:
                raise error
            emitted = {**report, 'candidate_sources': {p.relative_to(candidate.parents[2]).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in candidate.parents[2].rglob('*') if p.is_file()}}
            (target / 'summary.json').write_text(json.dumps(emitted) if raw_summary is None else raw_summary)
            if receipt is not None:
                (target / 'receipt.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in receipt))
            return subprocess.CompletedProcess(argv, 1 if report['failures'] else 0, '', '')

        out, stderr = base / 'out', io.StringIO()
        with patch.object(mutants, 'ROOT', base), patch.object(mutants.subprocess, 'run', benchmark), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            exit_code = mutants.main(['--out', str(out), '--control', str(control), '--only', only])
        verdict = json.loads((out / 'summary.json').read_text())['results'][0]
        if capture is not None:
            capture.update(stderr=stderr.getvalue(), log=(out / (only + '.log')).read_text(encoding='utf-8'),
                           invalid=json.loads((out / 'summary.json').read_text())['invalid'])
        return verdict, bool(exit_code), mutated


class PerformanceVerdictTest(unittest.TestCase):
    def test_gross_point_boundary_for_every_receipt_workload(self):
        for case, count, retained in [('ledger', 1, 0), ('sustained', 20, 20000),
                                      ('concurrent', 24, 0), ('concurrent', 48, 0)]:
            for baseline, candidate, fails in [(9, 12, False), (9, 14, False),
                    (9, 14.01, True), (100, 124, False), (100, 125, False),
                    (100, 125.01, True), (1, 160, True), (1, 230, True),
                    (100, 90, False), (100, 140, True)]:
                with self.subTest(case=case, count=count, baseline=baseline, candidate=candidate):
                    stats, failures = case_result(case, count, retained, pairs(baseline, candidate))
                    self.assertEqual(bool(failures), fails)
                    self.assertEqual(stats['gate_passed'], not fails)
                    self.assertEqual(stats['R'], candidate / baseline)
                    self.assertEqual(stats['pair_deltas_ms'], [candidate - baseline] * 10)
                    self.assertEqual(stats['D'], candidate - baseline)
                    self.assertEqual(stats['gate_ratio_limit'], 1.25)
                    self.assertEqual(stats['gate_delta_floor_ms'], 5.)
                    self.assertTrue(stats['gate_reason'])

    def test_delta_is_signed_pair_median_and_ratio_is_ratio_of_medians(self):
        pair = {'r3': [sample(v) for v in [1, 5, 100] * 2],
                'r4d': [sample(v) for v in [6, 105, 11] * 2]}
        stats, failures = case_result('sustained', 20, 0, pair)
        self.assertFalse(failures)
        self.assertTrue(stats['gate_passed'])
        self.assertEqual(stats['pair_deltas_ms'], [5, 100, -89] * 2)
        self.assertEqual(stats['D'], 5)
        self.assertEqual(stats['R'], 11 / 5)
        self.assertEqual(stats['ratio_method'], 'ratio of block-p95 medians')

    def test_missing_mismatched_or_nonfinite_pairs_never_pass(self):
        for bad in ({}, {'r3': [], 'r4d': []}, {'r3': [sample(1)], 'r4d': []},
                    {'r3': [sample(1)], 'r4d': [sample(float('nan'))]},
                    {'r3': [sample(1)], 'r4d': [sample(float('inf'))]},
                    {'r3': [sample(0)], 'r4d': [sample(1)]},
                    {'r3': [sample(1)], 'r4d': [{}]}):
            with self.subTest(pair=bad), self.assertRaises(ValueError):
                case_result('ledger', 1, 0, bad)

    def test_concurrent_does_not_require_superiority(self):
        for count in (24, 48):
            stats, failures = case_result('concurrent', count, 0, pairs(100, 105))
            self.assertFalse(failures)
            self.assertAlmostEqual(stats['p95_pct'], 5.)

    def test_gross_pass_does_not_imply_noninferiority_acceptance(self):
        stats, failures = case_result('sustained', 20, 20000, pairs(100, 111))
        self.assertFalse(failures)
        self.assertTrue(stats['gate_passed'])
        self.assertFalse(stats['noninferiority']['accepted'])

    def test_sustained_uncertainty_is_recorded_without_veto(self):
        pair = pairs(repetitions=3)
        pair['r4d'] = [sample(100 * math.exp(x)) for x in (-.1, 0, .1)]
        receipt = [dict(row, label='sustained-' + v, version=v, concurrency=20, prefill=20000)
                   for v, rows in pair.items() for row in rows]
        report = build_report(receipt, [('sustained', 20, 20000)], ['sustained'], 3, {})
        stats = report['cases']['sustained-20-20000']
        self.assertFalse(report['failures'])
        self.assertEqual(stats['r4d']['p95'] / stats['r3']['p95'], 1.)
        self.assertGreater(stats['noninferiority']['upper_95_ratio'], 1.10)
        self.assertFalse(stats['noninferiority']['accepted'])
        self.assertEqual(stats['noninferiority']['role'], 'recorded statistic only; not a CI verdict')

    def test_ten_pair_statistics_are_preserved(self):
        stats, failures = case_result('ledger', 1, 0, pairs(100, 124))
        self.assertFalse(failures)
        self.assertAlmostEqual(stats['permutation_p'], 2 / 1024)
        self.assertAlmostEqual(stats['paired_geometric_pct'], 24.)
        self.assertAlmostEqual(stats['paired_upper_95_pct'], 24.)
        self.assertAlmostEqual(stats['added_p95_ms_upper95'], 24.)
        self.assertAlmostEqual(stats['p95_pct'], 24.)

    def test_request_failure_in_either_revision_still_fails(self):
        for case in ('ledger', 'sustained', 'concurrent'):
            for version in ('r3', 'r4d'):
                pair = pairs(100, 90)
                pair[version][0]['failures'] = 1
                stats, failures = case_result(case, 1, 0, pair)
                self.assertEqual(stats['failures'], 1)
                self.assertEqual(len(failures), 1)
                self.assertFalse(stats['gate_passed'])

    def test_single_receipt_prefix_read_still_fails(self):
        for read_rows, fails in [(4, False), (5, True)]:
            pair = pairs()
            pair['r4d'][0]['read_rows'] = read_rows
            _, failures = case_result('ledger', 1, 20000, pair)
            self.assertEqual(bool(failures), fails)
            self.assertEqual(bool(property_failures('ledger', failures)), fails)

    def test_ledger_size_effect_requires_both_probability_and_ratio(self):
        for repetitions, ratio, fails in [(10, 1.20, False), (10, 1.21, True), (2, 1.21, False)]:
            configs = [('ledger', 1, n) for n in (0, 20000, 100000)]
            receipt = [sample(100. if n == 0 else 100. * ratio, label='ledger-' + v,
                              version=v, concurrency=1, prefill=n)
                       for _, _, n in configs for v in ('r3', 'r4d') for _ in range(repetitions)]
            report = build_report(receipt, configs, ['ledger'], repetitions, {})
            self.assertEqual(len(report['failures']), 2 if fails else 0)

    def test_journal_reread_still_fails_without_latency_regression(self):
        for read_bytes, fails in [(0, False), (1, True)]:
            rows = [sample(100., records=n, version=v, read_bytes=read_bytes if v == 'r4d' else 0)
                    for n in (0, 10000, 150000) for v in ('r3', 'r4d') for _ in range(10)]
            report = build_report([], [], ['journal'], 10, {}, journal_rows=rows)
            self.assertEqual(len(report['failures']), 3 if fails else 0)
            self.assertEqual(bool(property_failures('journal', report['failures'])), fails)

    def test_journal_size_effect_requires_both_probability_and_ratio(self):
        for repetitions, ratio, fails in [(10, 1.20, False), (10, 1.21, True), (2, 1.21, False)]:
            rows = [sample(100. if n == 0 else 100. * ratio, records=n, version=v)
                    for n in (0, 10000, 150000) for v in ('r3', 'r4d') for _ in range(repetitions)]
            report = build_report([], [], ['journal'], repetitions, {}, journal_rows=rows)
            self.assertEqual(len(report['failures']), 2 if fails else 0)

    def test_latency_mutants_require_both_ratio_and_signed_delta(self):
        for case, count in [('sustained', 20), ('concurrent', 24), ('concurrent', 48)]:
            for baseline, candidate, fails in [(9, 12, False), (9, 14, False),
                    (9, 14.01, True), (100, 124, False), (100, 125, False),
                    (100, 125.01, True), (1, 160, True), (1, 230, True)]:
                _, failures = case_result(case, count, 0, pairs(baseline, candidate))
                self.assertEqual(bool(property_failures(case, failures)), fails)
                other = 'concurrent' if case == 'sustained' else 'sustained'
                self.assertFalse(property_failures(other, failures))

    # REQ-D1550 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT: a request failure on either
    # side is no latency verdict; only a measured gross regression kills.
    def test_latency_kill_attribution_four_inputs(self):
        for case in ('sustained', 'concurrent'):
            for (name, baseline, candidate, failed), expected in zip(ATTRIBUTION_INPUTS, [True, None, None, False]):
                with self.subTest(case=case, input=name):
                    report = measured(case, baseline, candidate, failed)
                    exit_code = 1 if report['failures'] else 0
                    killed, status = mutant_result(case, exit_code, report, property_failures(case, report['failures']))
                    self.assertIs(killed, expected)
                    self.assertEqual(status, 'invalid_measurement' if failed else 'completed')

    def test_latency_kill_attribution_on_the_real_driver(self):
        for (name, baseline, candidate, failed), expected in zip(ATTRIBUTION_INPUTS, [True, None, None, False]):
            with self.subTest(input=name):
                verdict, failed_exit, _ = run_driver('MP03', measured('concurrent', baseline, candidate, failed))
                self.assertIs(verdict['killed'], expected)
                self.assertEqual(failed_exit, expected is not True)

    def test_latency_verdict_needs_every_case_statistic(self):
        report = measured('concurrent', 100, 140)
        del report['cases']['concurrent-48-0']
        self.assertEqual(mutant_result('concurrent', 1, report, property_failures('concurrent', report['failures'])),
                         (None, 'invalid_measurement'))
        for bad in (float('nan'), float('inf'), None):
            report = measured('sustained', 100, 140)
            report['cases']['sustained-20-20000']['D'] = bad
            self.assertEqual(mutant_result('sustained', 1, report, ['x'])[0], None)
        self.assertEqual(mutant_result('sustained', 2, measured('sustained', 100, 140), ['x']), (None, 'harness_error'))
        self.assertEqual(mutant_result('sustained', 1, None, []), (None, 'harness_error'))

    def test_healthy_control_failure_is_reported_apart_from_control_design(self):
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, 100),
                                             control_failures=['sustained-20-20000: request failed'],
                                             control_cases=measured('sustained', 100, 100, 'r3')['cases'])
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'control_failed', True))
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, 100), control_cases={})
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'control_invalid', True))

    def test_benchmark_errors_and_malformed_output_are_no_verdict(self):
        # PERF-R1-01/02: a benchmark that cannot finish, or whose summary has the
        # wrong shape, gives killed=None/harness_error, INVALID_CONTROL, non-zero exit.
        missing_failures = {k: v for k, v in measured('sustained', 100, 140).items() if k != 'failures'}
        inputs = {'timeout': dict(error=subprocess.TimeoutExpired(['benchmark'], 1200, output='partial-out', stderr='partial-err')),
                  'oserror': dict(error=FileNotFoundError(2, 'No such file', 'python')),
                  'cases_null': dict(raw_summary=json.dumps({'failures': [], 'cases': None, 'repetitions': 10})),
                  'array_summary': dict(raw_summary=json.dumps([{'failures': []}])),
                  'missing_key': dict(raw_summary=json.dumps(missing_failures)),
                  'invalid_json': dict(raw_summary='{"failures": [')}
        for only in ('MP02', 'MP03'):
            for name, kwargs in inputs.items():
                with self.subTest(mutant=only, input=name):
                    seen = {}
                    verdict, failed_exit, _ = run_driver(only, measured('sustained', 100, 140), capture=seen, **kwargs)
                    self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'harness_error', True))
                    self.assertTrue(verdict['harness_cause'])
                    self.assertEqual(seen['invalid'], {only: 'harness_error'})
                    self.assertIn('INVALID_CONTROL ' + only, seen['stderr'])
                    if name == 'timeout':
                        self.assertIn('partial-out', seen['log'])
                        self.assertIn('partial-err', seen['log'])
                        self.assertIn('timeout', seen['log'])

    # REQ-D1550 -> RISK-EMR-RECEIPT-DELAY: MP02 breaks R > 1.25 AND D > 5 ms by
    # construction (baseline <= B, every receipt >= L) or it is INVALID_CONTROL.
    def test_mp02_size_guarantees_both_bounds(self):
        self.assertEqual(L, max(50, math.ceil(1.5 * B + 10)))
        self.assertGreater(L / B, 1.25)
        self.assertGreater(L - B, 5.)

    def test_mp02_valid_control_is_killed_and_delays_every_receipt_return(self):
        verdict, failed_exit, mutated = run_driver('MP02', measured('sustained', B, L),
                                                   receipt_rows(B, lambda rep: [L, L + 1, L + 50, L + 2]))
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (True, 'completed', False))
        self.assertTrue(verdict['control_validity']['valid'])
        self.assertEqual(verdict['control_validity']['mutant_receipt_min_ms'], L)
        self.assertEqual(verdict['control_validity']['baseline_block_p95_max_ms'], B)
        # The copy differs from the product source by one awaited L ms timer and
        # nothing else; the product file is untouched. That the timer reaches
        # every receipt is measured (control_validity), not read from the text.
        original = (ROOT / 'api/src/emr-runtime/store.ts').read_text(encoding='utf-8').splitlines()
        added = list(mutated['store.ts'].splitlines())
        for line in original:
            added.remove(line)
        self.assertEqual([line.strip() for line in added], ['await new Promise(resolve => setTimeout(resolve, %d));' % L])

    def test_mp02_baseline_above_bound_is_invalid_control(self):
        rows = receipt_rows(B, lambda rep: [L] * 4)
        rows[8]['p95'] = B + .1
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', B, L), rows)
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'invalid_control', True))
        self.assertFalse(verdict['control_validity']['valid'])

    def test_mp02_receipt_below_delay_is_invalid_control(self):
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, L),
                                             receipt_rows(100, lambda rep: [L] * 3 + ([L - .001] if rep == 5 else [L])))
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'invalid_control', True))
        for rows in ([], receipt_rows(100, lambda rep: [L] * 4)[:-1], None):
            with self.subTest(rows=None if rows is None else len(rows)):
                verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, L), rows)
                self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'invalid_control', True))


# R3-A00..A10: independent finite fixtures and actual child exits. The fixture
# producer does not use the validator/judge to derive an expected result.
TYPE_TOKENS = ['null', 'false', 'true', '0', '1', '-1', '0.5', '""', '"1"', '"x"', '[]', '[null]', '{}', '{"x":1}']
NUMBER_TOKENS = [str(10 ** 400), str(-10 ** 400), '1e400', '-1e400', 'NaN', 'Infinity', '-Infinity',
                 '"NaN"', '"Infinity"', '"1e400"', '-0.0', '1.7976931348623157e308', '-1.7976931348623157e308', '5e-324', '-5e-324']
SOURCE_NAMES = ['api/src/emr-runtime/seal.ts', 'api/src/emr-runtime/store.ts',
                'api/src/emr-runtime/external-writer.ts', 'api/tsconfig.json']
CASE_NAMES = {'MP02': ['sustained-20-20000'], 'MP03': ['concurrent-24-0', 'concurrent-48-0']}


def known_summary(ids, healthy=False):
    report = {'cases': {}, 'failures': [], 'repetitions': 10, 'candidate_sources': {n: 'SOURCE' for n in SOURCE_NAMES}}
    for name in ids:
        for key in CASE_NAMES.get(name, []):
            report['cases'][key] = {'R': 1 if healthy else (3010 / 2000 if name == 'MP02' else 1.4),
                                    'D': 0 if healthy else (1010 if name == 'MP02' else 40),
                                    'failures': 0, 'gate_passed': healthy,
                                    'gate_ratio_limit': 1.25, 'gate_delta_floor_ms': 5.0}
    coherent(report)
    for name in ids:
        if not healthy and name == 'MP01':
            report['failures'].append('ledger-20000: single receipt reads retained prefix')
        if not healthy and name == 'MP04':
            report['failures'].append('journal-10000: append rereads verified bytes')
    return report


def coherent(report):
    report['failures'] = []
    for key, row in report['cases'].items():
        regression = row['R'] > 1.25 and row['D'] > 5
        row['gate_passed'] = not regression and row['failures'] == 0
        if row['failures']:
            report['failures'].append(key + ': request failed')
        if regression:
            report['failures'].append(key + ': candidate p95 exceeds same-run r3 gross-regression bounds')


def oracle_summary(report, ids, healthy=False):
    """Contract table for generated observations; no production imports/calls."""
    def numeric(value):
        if type(value) not in (int, float):
            return False
        try:
            return math.isfinite(float(value))
        except OverflowError:
            return False
    def integer(value, lower=0):
        return type(value) is int and lower <= value <= 9007199254740991
    if (type(report) is not dict or type(report.get('failures')) is not list
            or any(type(v) is not str for v in report['failures']) or type(report.get('cases')) is not dict
            or not integer(report.get('repetitions'), 1)):
        return 'harness_error'
    sources = report.get('candidate_sources')
    if type(sources) is not dict or set(sources) != set(SOURCE_NAMES) or any(v != 'SOURCE' for v in sources.values()):
        return 'harness_error'
    invalid = failed = False
    for key in [key for name in ids for key in CASE_NAMES.get(name, [])]:
        if key not in report['cases']:
            invalid = True
            continue
        row = report['cases'][key]
        if (type(row) is not dict or not integer(row.get('failures')) or type(row.get('gate_passed')) is not bool
                or any(not numeric(row.get(field)) for field in ('gate_ratio_limit', 'gate_delta_floor_ms'))
                or any(field in row and not numeric(row[field]) for field in ('R', 'D'))):
            return 'harness_error'
        if ('R' not in row or 'D' not in row or row['R'] <= 0
                or row['gate_ratio_limit'] != 1.25 or row['gate_delta_floor_ms'] != 5):
            invalid = True
            continue
        regression = row['R'] > 1.25 and row['D'] > 5
        diagnostics = [v for v in report['failures'] if v.startswith(key + ':')]
        request = any(v.startswith(key + ': request failed') for v in diagnostics)
        latency = any(v.startswith(key + ': candidate p95 exceeds same-run r3 gross-regression bounds') for v in diagnostics)
        if (request != (row['failures'] > 0) or latency != regression
                or row['gate_passed'] != (not regression and row['failures'] == 0)
                or bool(diagnostics) != (regression or row['failures'] > 0)):
            return 'harness_error'
        failed |= regression or row['failures'] > 0
    if invalid:
        return 'control_invalid' if healthy else 'invalid_measurement'
    if healthy:
        return 'control_failed' if failed else 'valid'
    if any(row['failures'] for row in report['cases'].values()):
        return 'invalid_measurement'
    if 'MP02' in ids and report['repetitions'] != 10:
        return 'invalid_control'
    return 'completed'


def replaced(value, path, token, delete=False):
    result = copy.deepcopy(value)
    if not path:
        return None if delete else json.loads(token)
    target = result
    for key in path[:-1]:
        target = target[key]
    if delete:
        del target[path[-1]]
    else:
        target[path[-1]] = json.loads(token)
    return result


def raw_replaced(value, path, token, delete=False):
    if delete:
        return None if not path else json.dumps(replaced(value, path, token, True))
    # A marker preserves exact exponent/huge integer tokens in the disk input.
    marked = replaced(value, path, '"__RAW_TOKEN__"')
    return json.dumps(marked).replace('"__RAW_TOKEN__"', token)


def matrix_cases():
    cases = []
    roles = [('mutant', ['MP02']), ('mutant', ['MP03']), ('healthy', ['MP02']),
             ('healthy', ['MP03']), ('healthy', ['MP02', 'MP03'])]
    for role, ids in roles:
        healthy = role == 'healthy'
        normal = known_summary(ids, healthy)
        paths = [[], ['failures'], ['cases'], ['repetitions']]
        for key in [key for name in ids for key in CASE_NAMES[name]]:
            paths += [['cases', key]] + [['cases', key, f] for f in ('R', 'D', 'failures', 'gate_passed', 'gate_ratio_limit', 'gate_delta_floor_ms')]
        if healthy:
            paths += [['candidate_sources']] + [['candidate_sources', n] for n in SOURCE_NAMES]
        variants = [(path, normal, 'member') for path in paths]
        for length, positions in [(1, [0]), (3, [0, 1, 2])]:
            fixture = copy.deepcopy(normal)
            if healthy:
                fixture['failures'] = ['journal-0: unrelated diagnostic'] * length
            else:
                # Keep exactly one regressing case for diagnostic-list probes;
                # every non-list case probe below keeps both concurrent regressions.
                first = next(iter(fixture['cases']))
                for key, row in fixture['cases'].items():
                    if key != first:
                        row.update(R=1, D=0)
                coherent(fixture)
                fixture['failures'] *= length
            variants += [(['failures', position], fixture, 'element' + str(length)) for position in positions]
        for path, fixture, kind in variants:
            tokens = TYPE_TOKENS[:]
            numeric = path and (path[-1] == 'repetitions' or len(path) == 3 and path[-1] in ('R', 'D', 'failures', 'gate_ratio_limit', 'gate_delta_floor_ms'))
            if numeric:
                tokens += NUMBER_TOKENS
                if path[-1] in ('R', 'D'):
                    limit = 1.25 if path[-1] == 'R' else 5.0
                    tokens += [repr(limit), repr(math.nextafter(limit, -math.inf)), repr(math.nextafter(limit, math.inf))]
            operations = [(token, False) for token in tokens]
            if kind == 'member':
                operations += [('null', True)]
            for index, (token, delete) in enumerate(operations):
                report = replaced(fixture, path, token, delete)
                expected = oracle_summary(report, ids, healthy)
                # A missing file is a harness fault, whereas absent measurement
                # members inside an otherwise valid mapping are domain failures.
                if not path and delete:
                    expected = 'harness_error'
                ident = '/'.join([role, ','.join(ids), kind, '.'.join(map(str, path)) or 'root', str(index)])
                cases.append({'id': ident, 'role': role, 'only': ids, 'expected': expected,
                              'raw_summary': raw_replaced(fixture, path, token, delete), 'token': token,
                              'path': path, 'family': 'delete' if delete else ('numeric' if index >= 14 else 'type'),
                              'typed_failure': kind.startswith('element') and type(json.loads(token)) is not str})
        for label, raw in [('5000-digit', '{"repetitions":' + '9' * 5000 + '}'),
                           ('depth-2048', '[' * 2048 + '0' + ']' * 2048),
                           ('duplicate', '{"failures":[],"failures":[]}'), ('empty', ''), ('truncated', '{'),
                           ('utf8', 'INVALID_UTF8')]:
            cases.append({'id': role + '/' + ','.join(ids) + '/parser/' + label, 'role': role, 'only': ids,
                          'expected': 'harness_error', 'raw_summary': raw, 'family': 'parser'})
    return cases


def oracle_receipts(rows):
    invalid = False
    if type(rows) is not list:
        return 'harness_error'
    identities = []
    for row in rows:
        if type(row) is not dict or any(type(row.get(f)) is not str for f in ('label', 'version')):
            return 'harness_error'
        if any(type(row.get(f)) is not int or not 0 <= row[f] <= 9007199254740991 for f in ('concurrency', 'prefill', 'failures', 'requests')):
            return 'harness_error'
        invalid |= row['version'] not in ('r3', 'r4d') or row['concurrency'] != 20 or row['prefill'] != 20000 or row['failures'] != 0
        identities.append((row['label'], row['version']))
        values = []
        if row['version'] == 'r3':
            values = [row.get('p95')]
        if row['version'] == 'r4d':
            instruments = row.get('request_instruments')
            if type(instruments) is not list:
                return 'harness_error'
            invalid |= not instruments or len(instruments) != row['requests']
            for item in instruments:
                if type(item) is not dict or 'error' in item and type(item['error']) is not str:
                    return 'harness_error'
                values.append(item.get('receipt_ms'))
                invalid |= bool(item.get('error', ''))
        for value in values:
            try:
                finite = type(value) in (float, int) and math.isfinite(float(value))
            except OverflowError:
                finite = False
            if not finite:
                return 'harness_error'
            invalid |= (not 0 < value <= 2000) if row['version'] == 'r3' else value < 3010
    wanted = {(f'sustained-{r}-{v}', v) for r in range(10) for v in ('r3', 'r4d')}
    invalid |= len(identities) != 20 or set(identities) != wanted
    return 'invalid_control' if invalid else 'completed'


def receipt_matrix_cases():
    normal = receipt_rows(2000, lambda rep: [3010] * 4)
    paths = [[i] for i in (0, 10, 18, 1, 11, 19)]
    # First/middle/last blocks on each revision, plus all instrument positions.
    for index in (0, 10, 18, 1, 11, 19):
        paths += [[index, f] for f in ('label', 'version', 'concurrency', 'prefill', 'failures', 'requests')]
        if index % 2 == 0:
            paths += [[index, 'p95']]
        else:
            paths += [[index, 'request_instruments']]
            for position in (0, 2, 3):
                paths += [[index, 'request_instruments', position]]
                paths += [[index, 'request_instruments', position, f] for f in ('receipt_ms', 'error')]
    variants = [(path, normal, 'four') for path in paths]
    for index in (1, 11, 19):
        fixture = copy.deepcopy(normal)
        fixture[index]['requests'] = 1
        fixture[index]['request_instruments'] = [{'receipt_ms': 3010}]
        variants += [([index, 'request_instruments', 0] + tail, fixture, 'single') for tail in ([], ['receipt_ms'], ['error'])]
    cases = []
    for path, fixture, kind in variants:
        numeric = path[-1] in ('concurrency', 'prefill', 'failures', 'requests', 'p95', 'receipt_ms')
        tokens = TYPE_TOKENS + (NUMBER_TOKENS if numeric else [])
        if path[-1] == 'p95':
            tokens += ['2000', repr(math.nextafter(2000, math.inf))]
        if path[-1] == 'receipt_ms':
            tokens += ['3010', repr(math.nextafter(3010, -math.inf))]
        for j, token in enumerate(tokens):
            rows = replaced(fixture, path, token)
            # Encode rows separately to preserve raw JSONL tokens.
            raw = raw_replaced(fixture[path[0]], path[1:], token)
            lines = [json.dumps(row) for row in fixture]
            lines[path[0]] = raw
            cases.append({'id': 'receipt/' + kind + '/' + '.'.join(map(str, path)) + '/' + str(j), 'only': ['MP02'],
                          'role': 'receipt', 'expected': oracle_receipts(rows), 'raw_receipt': '\n'.join(lines) + '\n',
                          'token': token, 'path': path, 'family': 'numeric' if j >= 14 else 'type'})
    for name, rows in [('missing-block', normal[:-1]), ('extra-block', normal + [normal[0]]),
                       ('duplicate-same-count', normal[:-1] + [normal[1]]), ('extra-malformed', normal + [None])]:
        cases.append({'id': 'receipt/identity/' + name, 'only': ['MP02'], 'role': 'receipt',
                      'expected': oracle_receipts(rows), 'raw_receipt': ''.join(json.dumps(r) + '\n' for r in rows), 'family': 'identity'})
    return cases


def child_driver(config_path):
    config = json.loads(Path(config_path).read_text(encoding='utf-8'))
    base = Path(config_path).parent
    selected = config['only']
    source = base / 'source'
    sources = {}
    for name in SOURCE_NAMES:
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
        sources[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    healthy = known_summary(selected, True)
    healthy['candidate_sources'] = sources

    def bind_raw(raw, digests):
        if raw is None:
            return None
        if raw == 'INVALID_UTF8':
            return b'\xff'
        # Only placeholder digest values are replaced. Malformed digest probes
        # remain verbatim, including malformed containers and missing members.
        for name, digest in digests.items():
            raw = raw.replace(json.dumps(name) + ': "SOURCE"', json.dumps(name) + ': ' + json.dumps(digest))
        return raw.encode('utf-8')

    raw = bind_raw(config.get('raw_summary'), sources) if config.get('role') == 'healthy' else json.dumps(healthy).encode()
    if raw is not None:
        (base / 'healthy.json').write_bytes(raw)
    launches = []
    fault = config.get('fault', {})
    current = {'name': 'healthy', 'fired': False}

    class SyntheticBase(BaseException):
        pass

    class BrokenMessage(Exception):
        def __str__(self):
            raise RuntimeError('message formatter failed')

    def injected_error():
        kind = fault.get('exception', 'RuntimeError')
        if kind == 'UnicodeDecodeError':
            return UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'injected decode failure')
        if kind == 'TimeoutExpired':
            values = [None, 'partial log', b'partial\xfflog']
            return subprocess.TimeoutExpired(['benchmark'], 1200,
                                             output=values[fault.get('stdout', 0)], stderr=values[fault.get('stderr', 0)])
        if kind == 'BrokenMessage':
            return BrokenMessage()
        if kind == 'SyntheticBase':
            return SyntheticBase('injected primary')
        if kind == 'SystemExit':
            return SystemExit(fault.get('code'))
        import builtins
        return getattr(builtins, kind)('injected primary\ud800' if fault.get('surrogate') else 'injected primary')

    def trace(frame, event, arg):
        if frame.f_code.co_filename == mutants.__file__:
            if frame.f_code.co_name == 'evaluate' and event == 'call':
                current['name'] = frame.f_locals['transaction'].name
            site = fault.get('site')
            target = fault.get('target', 'MP02')
            function = {'parse': 'strict_json', 'validate': 'validate_summary', 'hash': 'source_hashes',
                        'judge': 'control_status' if target == 'healthy' else 'mutant_result',
                        'after_judge': 'control_status' if target == 'healthy' else 'mutant_result',
                        'encode': 'encode_summary', 'aggregate': 'aggregate', 'setup': 'run'}.get(site)
            if site == 'cleanup' and target == 'healthy':
                function = '<lambda>'
            moment = 'return' if site == 'after_judge' else 'call'
            if function == frame.f_code.co_name and event == moment and (current['name'] == target or site in ('encode', 'aggregate')) and not current['fired']:
                current['fired'] = True
                raise injected_error()
        return trace

    def benchmark(argv, **kwargs):
        name = Path(argv[argv.index('--out') + 1]).name
        launches.append(name)
        (base / 'launches.json').write_text(json.dumps(launches))
        if config.get('primary_error') or fault.get('site') == 'launch' and name == fault.get('target'):
            raise injected_error()
        target = Path(argv[argv.index('--out') + 1])
        target.mkdir(parents=True)
        candidate = Path(argv[argv.index('--candidate') + 1])
        digests = {p.relative_to(candidate).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                   for p in candidate.rglob('*') if p.is_file()}
        report = known_summary([name])
        if config.get('scenario') == 'survival':
            report = known_summary([name], True)
        report['candidate_sources'] = digests
        raw = bind_raw(config.get('raw_summary'), digests) if config.get('role') == 'mutant' else json.dumps(report).encode()
        if name in config.get('errors_for', []):
            raw = b'{'
        if raw is not None:
            (target / 'summary.json').write_bytes(raw)
        receipts = config.get('raw_receipt', ''.join(json.dumps(r) + '\n' for r in receipt_rows(2000, lambda rep: [3010] * 4)))
        if receipts is not None:
            (target / 'receipt.jsonl').write_bytes(receipts.encode('utf-8'))
        code = config.get('benchmark_exit')
        if code is None:
            try:
                observed = json.loads(raw) if raw is not None else {}
                code = int(bool(observed.get('failures', []))) if isinstance(observed, dict) else 1
            except (ValueError, RecursionError, UnicodeError):
                code = 1
        if config.get('real_log_bytes'):
            child = real_run([sys.executable, '-c',
                              'import sys;from pathlib import Path;p=Path(sys.argv[1]);p.write_bytes(p.read_bytes());sys.stdout.buffer.write(b"\\xff");sys.stderr.buffer.write(b"\\xfe")',
                              str(target / 'summary.json')], capture_output=True)
            return subprocess.CompletedProcess(argv, code, child.stdout, child.stderr)
        return subprocess.CompletedProcess(argv, code, b'benchmark stdout\n', b'benchmark stderr\n')

    real_run, real_read, real_write, real_cleanup = subprocess.run, Path.read_bytes, Path.write_text, tempfile.TemporaryDirectory.cleanup
    real_read_text = Path.read_text
    real_copy, real_replace, real_fsync, real_open = shutil.copytree, os.replace, os.fsync, Path.open

    def read(path):
        is_input = path.name == 'healthy.json' if fault.get('target') == 'healthy' else path.name == 'summary.json'
        if fault.get('site') == 'read' and is_input and not current['fired']:
            current['fired'] = True
            raise injected_error()
        return real_read(path)

    def write(path, *args, **kwargs):
        if path.suffix == '.log' and (fault.get('secondary') == 'log' or fault.get('site') == 'log'):
            raise OSError('secondary log write failed')
        return real_write(path, *args, **kwargs)

    def read_text(path, *args, **kwargs):
        if fault.get('site') == 'mutation' and path.suffix == '.ts' and current['name'] == fault.get('target'):
            raise injected_error()
        return real_read_text(path, *args, **kwargs)

    def cleanup(folder):
        real_cleanup(folder)
        if fault.get('site') == 'cleanup' and current['name'] == fault.get('target') and not current['fired']:
            current['fired'] = True
            raise injected_error()
        if fault.get('secondary') == 'cleanup':
            raise OSError('secondary cleanup failed')

    def copytree(*args, **kwargs):
        if fault.get('site') == 'copy' and current['name'] == fault.get('target'):
            raise injected_error()
        return real_copy(*args, **kwargs)

    publication = {'fired': False}

    def publication_error(site):
        if fault.get('publication') == site and (fault.get('permanent') or not publication['fired']):
            publication['fired'] = True
            raise OSError('injected publication ' + site)

    class OutputFile:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            self.stream.__enter__()
            return self
        def __exit__(self, *args):
            return self.stream.__exit__(*args)
        def write(self, raw):
            publication_error('write')
            if fault.get('publication') == 'prefix' and not publication['fired']:
                self.stream.write(raw[:17])
                publication_error('prefix')
            return self.stream.write(raw)
        def flush(self):
            publication_error('flush')
            return self.stream.flush()
        def fileno(self):
            return self.stream.fileno()

    def opening(path, *args, **kwargs):
        if path.name.startswith('.summary-'):
            publication_error('create')
            return OutputFile(real_open(path, *args, **kwargs))
        return real_open(path, *args, **kwargs)

    def fsync(fd):
        publication_error('fsync')
        return real_fsync(fd)

    def replace(a, b):
        publication_error('replace')
        result = real_replace(a, b)
        publication_error('after_replace')
        return result

    if config.get('stale'):
        (base / 'out').mkdir()
        (base / 'out/summary.json').write_text('{"run_id":"OLD","terminal":true,"status":"completed","killed":1}')
    with contextlib.ExitStack() as stack:
        for obj, attr, value in [(mutants, 'ROOT', source), (mutants.subprocess, 'run', benchmark),
                                 (Path, 'read_bytes', read), (Path, 'write_text', write),
                                 (Path, 'read_text', read_text),
                                 (tempfile.TemporaryDirectory, 'cleanup', cleanup), (shutil, 'copytree', copytree),
                                 (Path, 'open', opening), (os, 'replace', replace), (os, 'fsync', fsync)]:
            stack.enter_context(patch.object(obj, attr, value))
        class BrokenStream:
            def write(self, value):
                raise OSError('secondary stream write failed')
            def flush(self):
                raise OSError('secondary stream flush failed')
        for channel in config.get('broken_streams', []):
            stack.enter_context(patch.object(sys, channel, BrokenStream()))
        if config.get('fallback_serialization_error'):
            stack.enter_context(patch.object(json.JSONEncoder, 'encode', side_effect=OSError('secondary fallback formatting failed')))
        sys.settrace(trace)
        try:
            entry = getattr(mutants, 'entrypoint', mutants.main)
            if config.get('repeat'):
                repeats = []
                for index in range(3):
                    config['errors_for'] = ['MP03'] if index == 1 else []
                    target = base / ('out' if index == 2 else 'out' + str(index))
                    value = entry(['--out', str(target), '--control', str(base / 'healthy.json'), '--only', ','.join(selected)])
                    repeats.append({'exit': int(value), 'summary': json.loads((target / 'summary.json').read_text())})
                (base / 'repeats.json').write_text(json.dumps(repeats))
                code = value
            else:
                code = entry(['--out', str(base / 'out'), '--control', str(base / 'healthy.json'), '--only', ','.join(selected)])
        finally:
            sys.settrace(None)
    return int(code)


def execute_case(config, directory, module_dir=None):
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'input.json').write_text(json.dumps(config, ensure_ascii=True), encoding='utf-8')
    # All generated source copies and TemporaryDirectory cleanup stay in this
    # fixture directory. No live fixture, Node or Docker is reachable here.
    env = {**os.environ, 'TMP': str(directory), 'TEMP': str(directory), 'PYTHONDONTWRITEBYTECODE': '1',
           'EMR_R3_SOURCE_ROOT': str(ROOT)}
    module = str(Path(__file__).resolve()) if module_dir is None else str(module_dir / 'performance_test.py')
    process = subprocess.run([sys.executable, '-B', module, '--r3-child', str(directory / 'input.json')],
                             capture_output=True, timeout=30, env=env)
    (directory / 'stdout.bin').write_bytes(process.stdout)
    (directory / 'stderr.bin').write_bytes(process.stderr)
    summary_file = directory / 'out/summary.json'
    raw = summary_file.read_bytes() if summary_file.exists() else None
    summary = None
    if raw is not None:
        try:
            summary = json.loads(raw)
        except (ValueError, UnicodeError):
            pass
    outcome = {'exit': process.returncode, 'summary': summary,
               'stdout_b64': base64.b64encode(process.stdout).decode(), 'stderr_b64': base64.b64encode(process.stderr).decode(),
               'summary_sha256': hashlib.sha256(raw).hexdigest() if raw is not None else None,
               'input_sha256': hashlib.sha256((directory / 'input.json').read_bytes()).hexdigest()}
    outcome['launches'] = json.loads((directory / 'launches.json').read_text()) if (directory / 'launches.json').exists() else []
    if (directory / 'repeats.json').exists():
        outcome['repeats'] = json.loads((directory / 'repeats.json').read_text())
    (directory / 'observation.json').write_text(json.dumps(outcome, ensure_ascii=True), encoding='utf-8')
    return outcome


def assert_observation(test, config, observed):
    summary = observed['summary']
    if config.get('unavailable'):
        test.assertNotEqual(observed['exit'], 0, config['id'])
        test.assertFalse(observed['exit'] == 0 and summary and summary.get('terminal')
                         and summary.get('run_id') != 'OLD', config['id'])
        return
    test.assertIsInstance(summary, dict, config['id'] + ': missing terminal aggregate')
    test.assertIn('results', summary, config['id'] + ': missing canonical results')
    canonical = list(dict.fromkeys(config['only']))
    test.assertEqual([r['id'] for r in summary['results']], canonical, config['id'])
    expected = config['expected']
    rows = summary['results']
    if config.get('repeat'):
        test.assertIn('repeats', observed)
        test.assertEqual([r['exit'] for r in observed['repeats']], [0, 1, 0])
        test.assertEqual([r['summary']['results'][0]['killed'] for r in observed['repeats']], [True, None, True])
        test.assertEqual(len({r['summary']['run_id'] for r in observed['repeats']}), 3)
    if expected == 'sequence':
        bad = config['errors_for']
        test.assertEqual([r['killed'] for r in rows], [None if r['id'] in bad else True for r in rows])
        test.assertEqual(summary['not_run'], bad)
        test.assertEqual(summary['killed'], 2 - len(bad))
        test.assertEqual(observed['exit'], int(bool(bad)))
        if bad:
            test.assertEqual(summary['status'], 'INVALID_CONTROL')
        return
    if expected not in ('completed', 'valid'):
        test.assertNotEqual(observed['exit'], 0, config['id'])
        test.assertTrue(all(r['killed'] is None for r in rows), config['id'])
        test.assertTrue(all(r['status'] == expected for r in rows), config['id'] + ': ' + repr([(r['id'], r['status']) for r in rows]))
        test.assertEqual(summary['killed'], 0, config['id'])
        test.assertEqual(summary['survived'], [], config['id'])
        test.assertEqual(summary['not_run'], canonical, config['id'])
        if config.get('role') == 'healthy':
            test.assertEqual(observed['launches'], [], config['id'] + ': invalid healthy basis launched benchmark')
        if expected == 'harness_error':
            test.assertTrue(all(r.get('harness_cause') for r in rows), config['id'] + ': missing cause')
            test.assertEqual(summary.get('status'), 'INVALID_CONTROL', config['id'])
            test.assertTrue(all(r.get('phase') and r.get('errors') for r in rows), config['id'])
            if config.get('typed_failure'):
                test.assertEqual(rows[0]['errors'][0]['type'], 'EvidenceError', config['id'] + ': malformed diagnostic reached property filtering')
            if config.get('fault', {}).get('secondary'):
                test.assertTrue(all(len(r['errors']) >= 2 for r in rows), config['id'] + ': lost secondary')
                test.assertEqual(rows[0]['errors'][0]['type'], 'TimeoutExpired', config['id'] + ': lost primary')
            if config.get('fault', {}).get('exception') == 'BrokenMessage':
                test.assertEqual(rows[0]['errors'][0]['message'], 'message unavailable')
                test.assertEqual(rows[0]['errors'][0]['formatting_error'], 'RuntimeError')
    else:
        if expected == 'valid' or config.get('role') == 'receipt':
            killed = True
        else:
            report = json.loads(config['raw_summary']) if 'raw_summary' in config else known_summary(config['only'])
            killed = any(r['R'] > 1.25 and r['D'] > 5 for r in report['cases'].values()) if report['cases'] else bool(report['failures'])
        test.assertTrue(all(r['killed'] is killed and r['status'] == 'completed' for r in rows), config['id'])
        test.assertEqual(observed['exit'], 0 if killed else 1, config['id'])


def fault_cases():
    cases = []
    families = ['RuntimeError', 'AssertionError', 'TypeError', 'AttributeError', 'ValueError',
                'OverflowError', 'RecursionError', 'MemoryError', 'SyntheticBase', 'UnicodeDecodeError']
    for target in ('healthy', 'MP02', 'MP03'):
        only = [target] if target != 'healthy' else ['MP02', 'MP03']
        for site in ('read', 'parse', 'validate', 'judge', 'hash', 'after_judge', 'cleanup'):
            for exception in families:
                cases.append({'id': f'fault/{target}/{site}/{exception}', 'only': only, 'role': 'fault',
                              'expected': 'harness_error', 'fault': {'target': target, 'site': site, 'exception': exception}})
        for site in ('judge', 'cleanup'):
            for exception, code in [('KeyboardInterrupt', None), ('SystemExit', None), ('SystemExit', 0), ('SystemExit', 2)]:
                cases.append({'id': f'cancel/{target}/{site}/{exception}/{code}', 'only': only, 'role': 'fault',
                              'expected': 'harness_error', 'fault': {'target': target, 'site': site, 'exception': exception, 'code': code}})
    for name in ('MP02', 'MP03'):
        for site in ('setup', 'copy', 'mutation'):
            cases.append({'id': f'fault/{name}/{site}', 'only': [name], 'role': 'fault', 'expected': 'harness_error',
                          'fault': {'site': site, 'target': name}})
        for exception in ('FileNotFoundError', 'OSError'):
            cases.append({'id': f'fault/{name}/launch/{exception}', 'only': [name], 'role': 'fault', 'expected': 'harness_error',
                          'fault': {'target': name, 'site': 'launch', 'exception': exception}})
        for stdout in range(3):
            for stderr in range(3):
                cases.append({'id': f'fault/{name}/timeout/{stdout}/{stderr}', 'only': [name], 'role': 'fault', 'expected': 'harness_error',
                              'fault': {'target': name, 'site': 'launch', 'exception': 'TimeoutExpired', 'stdout': stdout, 'stderr': stderr}})
        for code in (2, -9):
            cases.append({'id': f'fault/{name}/exit/{code}', 'only': [name], 'role': 'fault',
                          'expected': 'harness_error', 'benchmark_exit': code})
        cases.append({'id': f'positive/{name}/log-bytes', 'only': [name], 'role': 'fault', 'expected': 'completed', 'real_log_bytes': True})
        for scenario in ('kill', 'survival'):
            # MP02 has no B/L-valid survival; MP03 supplies the false verdict.
            if scenario == 'survival' and name == 'MP02':
                continue
            cases.append({'id': f'fault/{name}/after-{scenario}', 'only': [name], 'role': 'fault', 'expected': 'harness_error',
                          'scenario': scenario, 'fault': {'target': name, 'site': 'after_judge'}})
        for secondary in ('log', 'cleanup'):
            cases.append({'id': f'double/{name}/timeout/{secondary}', 'only': [name], 'role': 'fault', 'expected': 'harness_error',
                          'fault': {'target': name, 'site': 'launch', 'exception': 'TimeoutExpired', 'secondary': secondary, 'stdout': 2, 'stderr': 2}})
        for kind in ('BrokenMessage', 'RuntimeError'):
            cases.append({'id': f'double/{name}/format/{kind}', 'only': [name], 'role': 'fault', 'expected': 'harness_error',
                          'fault': {'target': name, 'site': 'judge', 'exception': kind, 'surrogate': True}})
    for site in ('create', 'write', 'prefix', 'flush', 'fsync', 'replace', 'after_replace', 'encode', 'aggregate'):
        for primary in (False, True):
            for stale in (False, True):
                fault = {'publication': site}
                if site in ('encode', 'aggregate'):
                    fault['site'] = site
                elif primary:
                    fault.update(site='launch', target='MP02', exception='TimeoutExpired')
                cases.append({'id': f'publication/{site}/{primary}/{stale}', 'only': ['MP02'], 'role': 'fault',
                              'expected': 'harness_error', 'fault': fault, 'stale': stale, 'primary_error': primary})
    for stale in (False, True):
        cases.append({'id': f'publication/unavailable/{stale}', 'only': ['MP02'], 'role': 'fault', 'expected': 'harness_error',
                      'fault': {'publication': 'create', 'permanent': True}, 'stale': stale, 'unavailable': True})
    for only in ([''], ['UNKNOWN'], ['MP02', 'UNKNOWN'], ['MP02', 'MP02']):
        # Duplicate input IDs are rejected but accounted for once canonically.
        cases.append({'id': 'selection/' + ','.join(only), 'only': only, 'role': 'fault', 'expected': 'harness_error'})
    for bad in (['MP03'], ['MP02'], ['MP02', 'MP03'], []):
        cases.append({'id': 'sequence/' + (','.join(bad) or 'valid'), 'only': ['MP02', 'MP03'],
                      'role': 'fault', 'expected': 'sequence', 'errors_for': bad})
    cases.append({'id': 'sequence/valid-error-valid', 'only': ['MP03'], 'role': 'fault', 'expected': 'completed', 'repeat': True})
    for channels in (['stdout'], ['stderr'], ['stdout', 'stderr']):
        cases.append({'id': 'double/streams/' + ','.join(channels), 'only': ['MP02'], 'role': 'fault',
                      'expected': 'harness_error', 'broken_streams': channels,
                      'fault': {'site': 'launch', 'target': 'MP02', 'exception': 'TimeoutExpired'}})
    cases.append({'id': 'double/fallback-format', 'only': ['MP02'], 'role': 'fault', 'expected': 'harness_error',
                  'fault': {'site': 'launch', 'target': 'MP02', 'exception': 'TimeoutExpired'},
                  'fallback_serialization_error': True, 'unavailable': True})
    for name in ('empty', 'partial', 'extra', 'escape', 'digest'):
        report = known_summary(['MP02', 'MP03'], True)
        if name == 'empty':
            report['candidate_sources'] = {}
        elif name == 'partial':
            del report['candidate_sources'][SOURCE_NAMES[0]]
        elif name in ('extra', 'escape'):
            report['candidate_sources']['../outside' if name == 'escape' else 'api/extra.ts'] = 'SOURCE'
        else:
            report['candidate_sources'][SOURCE_NAMES[0]] = '0' * 64
        cases.append({'id': 'provenance/' + name, 'only': ['MP02', 'MP03'], 'role': 'healthy',
                      'raw_summary': json.dumps(report), 'expected': 'harness_error'})
    return cases


def positive_cases():
    cases = []
    for name in ('MP02', 'MP03'):
        for version in (None, 'r3', 'r4d'):
            for healthy in (False, True):
                report = known_summary([name], healthy)
                if version:
                    for row in report['cases'].values():
                        row['failures'] = 1
                    coherent(report)
                cases.append({'id': f'positive/{name}/{version}/{healthy}', 'only': [name],
                              'role': 'healthy' if healthy else 'mutant',
                              'raw_summary': json.dumps(report), 'expected': oracle_summary(report, [name], healthy)})
    for key in CASE_NAMES['MP03']:
        for field, values in [('R', [1.25, math.nextafter(1.25, -math.inf), math.nextafter(1.25, math.inf)]),
                              ('D', [5.0, math.nextafter(5, -math.inf), math.nextafter(5, math.inf), -20, -0.0])]:
            for i, value in enumerate(values):
                report = known_summary(['MP03'], True)
                report['cases'][key].update(R=2, D=100)
                report['cases'][key][field] = value
                coherent(report)
                cases.append({'id': f'positive/boundary/{key}/{field}/{i}', 'only': ['MP03'], 'role': 'mutant',
                              'raw_summary': json.dumps(report), 'expected': 'completed'})
    for name in ('MP01', 'MP04'):
        for healthy in (False, True):
            report = known_summary([name], healthy)
            cases.append({'id': f'positive/{name}/{healthy}', 'only': [name], 'role': 'mutant',
                          'raw_summary': json.dumps(report), 'expected': 'completed'})
    cases.append({'id': 'positive/all-four', 'only': ['MP01', 'MP02', 'MP03', 'MP04'], 'role': 'fault', 'expected': 'completed'})
    return cases


def run_cases(test, cases, root, module_dir=None):
    ids = [case['id'] for case in cases]
    test.assertEqual(len(ids), len(set(ids)), 'duplicate materialized case IDs')
    root.mkdir(parents=True, exist_ok=False)
    (root / 'expected.json').write_text(json.dumps(ids), encoding='utf-8')
    executed = []
    for i, case in enumerate(cases):
        observation = execute_case(case, root / f'{i:05}', module_dir)
        executed.append(case['id'])
        (root / 'executed.json').write_text(json.dumps(executed), encoding='utf-8')
        with test.subTest(case=case['id']):
            assert_observation(test, case, observation)
    test.assertEqual(executed, ids, 'matrix coverage incomplete')


def run_acceptance_group(test, group):
    generators = {'summary': matrix_cases, 'receipt': receipt_matrix_cases, 'fault': fault_cases, 'positive': positive_cases}
    evidence = os.environ.get('EMR_R3_EVIDENCE')
    if evidence:
        run_cases(test, generators[group](), Path(evidence) / group)
    else:
        with tempfile.TemporaryDirectory(prefix='emr-r3-') as folder:
            run_cases(test, generators[group](), Path(folder) / group)


# These methods are deliberately on the class imported by the existing CI entry.
def test_r3_summary_matrix(self):
    run_acceptance_group(self, 'summary')


def test_r3_receipt_matrix(self):
    run_acceptance_group(self, 'receipt')


def test_r3_fault_matrix(self):
    run_acceptance_group(self, 'fault')


def test_r3_positive_controls(self):
    run_acceptance_group(self, 'positive')


PerformanceVerdictTest.test_r3_summary_matrix = test_r3_summary_matrix
PerformanceVerdictTest.test_r3_receipt_matrix = test_r3_receipt_matrix
PerformanceVerdictTest.test_r3_fault_matrix = test_r3_fault_matrix
PerformanceVerdictTest.test_r3_positive_controls = test_r3_positive_controls


def adequacy_specs():
    """Behavioral harness faults; syntax/import failures never count as kills."""
    return {
        'F1': ('result', "return exit_code == 1 and bool(matching), 'completed'", 'positive/MP03/r3/False'),
        'F2': ('replace', ("if validity is not None and not validity['valid']:", 'if False:'), 'receipt/four/0.p95/30'),
        'F3': ('replace', ("return (row['failures'] == 0 and row['R'] > 0", "return (row['R'] > 0"), 'positive/MP03/r3/False'),
        'F4': ('location', None, 'test_mp02_valid_control_is_killed_and_delays_every_receipt_return'),
        'F5': ('replace', ('for item in instruments:', 'for item in instruments[:1]:'), 'receipt/four/11.request_instruments.3.receipt_ms/30'),
        'F6': ('replace', ("return 'control_failed'", "return 'control_invalid'"), 'positive/MP02/r3/True'),
        'R3-M07': ('replace', ('except BaseException as error:',
                               'except (subprocess.TimeoutExpired, OSError) as error:'), 'fault/MP03/judge/RuntimeError'),
        'R3-M08': ('replace', ('any(type(item) is not str for item in value)', 'any(type(item) is not str for item in value[:1])'),
                   'mutant/MP02/element3/failures.2/0'),
        'R3-M09': ('replace', ("if type(value) not in (int, float):", "if not isinstance(value, (int, float)):"),
                   'healthy/MP03/member/cases.concurrent-24-0.R/2'),
        'R3-M10': ('healthy', None, 'healthy/MP02/member/candidate_sources/12'),
        'R3-M11': ('replace', ("return {'id': name, 'property': MUTANTS[name][0] if name in MUTANTS else None,\n            'killed': None,",
                              "return {'id': name, 'property': MUTANTS[name][0] if name in MUTANTS else None,\n            'killed': True,"), 'fault/MP02/launch/OSError'),
        'R3-M12': ('replace', ('return transaction.result() if transaction.errors else tentative',
                              'return tentative if tentative is not None else transaction.result()'), 'fault/MP02/cleanup/RuntimeError'),
        'R3-M13': ('replace', ("os.replace(temporary, out / 'summary.json')", "try:\n        os.replace(temporary, out / 'summary.json')\n    except OSError:\n        pass"), 'publication/replace/False/True'),
        'R3-M14': ('formatter', None, 'double/MP02/format/BrokenMessage'),
        'R3-M15': ('zeroexit', None, 'cancel/MP03/judge/SystemExit/0'),
        'R3-M16': ('selection', None, 'selection/UNKNOWN'),
    }


def change_function(source, name, body):
    import ast
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == name)
    lines = source.splitlines(True)
    return ''.join(lines[:node.body[0].lineno - 1]) + '\n'.join('    ' + line for line in body.splitlines()) + '\n' + ''.join(lines[node.end_lineno:])


def faulty_source(source, kind, change):
    if kind == 'replace':
        old, new = change
        if old not in source:
            raise RuntimeError('fault location absent')
        return source.replace(old, new)
    if kind == 'result':
        return change_function(source, 'mutant_result', change)
    if kind == 'location':
        injection = "MUTANTS['MP02'] = ('sustained', 'seal.ts', '      Promise.resolve().then(drain);', '      setTimeout(drain, 3010);', 'old first-drain delay')\n\n"
        return source.replace('def main(argv=None):', injection + 'def main(argv=None):')
    if kind == 'healthy':
        source = source.replace("validate_sources(summary, identity['source_sha256'])", 'pass')
        return source
    if kind == 'formatter':
        return change_function(source, 'error_record', "return {'phase': phase, 'type': type(error).__name__, 'message': str(error)}")
    if kind == 'zeroexit':
        return source.replace('except BaseException as error:\n        # Cancellation',
                              'except SystemExit as error:\n        return error.code or 0\n    except BaseException as error:\n        # Cancellation')
    if kind == 'selection':
        return source.replace("selected = list(MUTANTS) if args.only is None else args.only.split(',')",
                              "selected = list(MUTANTS) if args.only is None else args.only.split(',')\n    if any(name not in MUTANTS for name in selected):\n        return 0")
    raise ValueError('unknown fault mutation')


def adequacy_run(destination):
    import ast
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    all_cases = {case['id']: case for group in (matrix_cases(), receipt_matrix_cases(), fault_cases(), positive_cases()) for case in group}
    original = Path(mutants.__file__).read_text(encoding='utf-8')
    results = {}
    for name, (kind, change, test_id) in adequacy_specs().items():
        folder = destination / name
        folder.mkdir()
        for filename in ('performance.py', 'performance_test.py', 'performance_mutants.py', 'noninferiority.py', 'power_design.py'):
            shutil.copyfile(Path(__file__).parent / filename, folder / filename)
        altered = faulty_source(original, kind, change)
        ast.parse(altered)
        (folder / 'performance_mutants.py').write_text(altered, encoding='utf-8', newline='\n')
        env = {**os.environ, 'EMR_R3_SOURCE_ROOT': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1', 'TMP': str(folder), 'TEMP': str(folder)}
        if name == 'F4':
            command = [sys.executable, '-B', str(folder / 'performance_test.py'), 'PerformanceVerdictTest.' + test_id]
        else:
            case = all_cases[test_id]
            (folder / 'case.json').write_text(json.dumps(case), encoding='utf-8')
            command = [sys.executable, '-B', str(folder / 'performance_test.py'), '--r3-one', str(folder / 'case.json'), str(folder / 'observation')]
        process = subprocess.run(command, capture_output=True, timeout=60, env=env)
        (folder / 'stdout.bin').write_bytes(process.stdout)
        (folder / 'stderr.bin').write_bytes(process.stderr)
        text = process.stderr.decode('utf-8', 'replace')
        killed = process.returncode != 0 and 'AssertionError' in text and 'ImportError' not in text and 'SyntaxError' not in text
        results[name] = {'killed_by_assertion': killed, 'test_id': test_id, 'exit': process.returncode,
                         'source_sha256': hashlib.sha256(altered.encode()).hexdigest()}
        (destination / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
        if not killed:
            raise AssertionError('required fault mutant survived or failed without a behavioral assertion: ' + name)
    return 0


def matrix_run(destination, baseline=False):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    modules = None
    if baseline:
        modules = destination / 'base-modules'
        modules.mkdir()
        for filename in ('performance.py', 'performance_mutants.py', 'noninferiority.py', 'power_design.py'):
            raw = subprocess.check_output(['git', 'show', 'd8649b7:tests/emr/b/' + filename], cwd=ROOT)
            (modules / filename).write_bytes(raw)
        shutil.copyfile(__file__, modules / 'performance_test.py')
    generated = matrix_cases() + receipt_matrix_cases() + fault_cases() + positive_cases()
    manifest = {'base': 'd8649b7', 'baseline': baseline, 'cases': [c['id'] for c in generated],
                'sources': {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
                            for name in ('performance.py', 'performance_mutants.py', 'performance_test.py')}}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    class Acceptance(unittest.TestCase):
        def runTest(self):
            run_cases(self, generated, destination / 'cases', modules)
    result = unittest.TextTestRunner(verbosity=2).run(Acceptance())
    report = {'cases': len(generated), 'assertion_failures': len(result.failures), 'errors': len(result.errors),
              'skipped': len(result.skipped), 'successful': result.wasSuccessful()}
    (destination / 'result.json').write_text(json.dumps(report, indent=2))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--r3-child':
        raise SystemExit(child_driver(sys.argv[2]))
    if len(sys.argv) > 1 and sys.argv[1] == '--r3-one':
        case = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
        observed = execute_case(case, Path(sys.argv[3]))
        assert_observation(unittest.TestCase(), case, observed)
        raise SystemExit(0)
    if len(sys.argv) > 1 and sys.argv[1] == '--r3-adequacy':
        raise SystemExit(adequacy_run(sys.argv[2]))
    if len(sys.argv) > 1 and sys.argv[1] == '--r3-matrix':
        raise SystemExit(matrix_run(sys.argv[2], baseline='--base' in sys.argv[3:]))
    unittest.main()
