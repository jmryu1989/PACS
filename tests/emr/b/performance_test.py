"""REQ-D1006 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT/RECEIPT-DELAY -> hosted verdict controls.

Known observations exercise the report and negative-control consumer, without
timing a machine, pinning source text, or changing the live acceptance rule.
The negative-control driver runs for real on a copy of the runtime sources; only
its benchmark subprocess returns known summaries and raw sample rows.
"""
import contextlib
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from performance import ROOT, build_report, case_result
import performance_mutants as mutants
from performance_mutants import (MP02_BASELINE_P95_BOUND_MS as B, MP02_DELAY_MS as L,
                                 mutant_result, property_failures)

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
        healthy = {**measured('sustained', 100, 100)['cases'], **measured('concurrent', 100, 100)['cases']}
        control = base / 'healthy.json'
        control.write_text(json.dumps({'candidate_sources': sources, 'failures': list(control_failures),
                                       'cases': healthy if control_cases is None else control_cases}))
        mutated = {}

        def benchmark(argv, **kwargs):
            target = Path(argv[argv.index('--out') + 1])
            target.mkdir(parents=True)
            candidate = Path(argv[argv.index('--candidate') + 1]) / 'api/src/emr-runtime'
            mutated.update({p.name: p.read_text(encoding='utf-8') for p in candidate.iterdir()})
            if error is not None:
                raise error
            (target / 'summary.json').write_text(json.dumps(report) if raw_summary is None else raw_summary)
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
                                             control_failures=['sustained-20-20000: request failed'])
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


if __name__ == '__main__':
    unittest.main()
