"""REQ-D949 -> RISK-EMR-HOST-NOISE/RECEIPT-DELAY -> hosted verdict controls.

Known observations exercise the report and negative-control consumer, without
timing a machine, pinning source text, or changing the live acceptance rule.
"""
import math
import unittest

from performance import build_report, case_result
from performance_mutants import property_failures


def sample(p95, **values):
    return {'p50': p95, 'p95': p95, 'p99': p95, 'failures': 0,
            'read_rows': 0, 'read_bytes': 0, **values}


def pairs(ratio=1., repetitions=10):
    return {'r3': [sample(100.) for _ in range(repetitions)],
            'r4d': [sample(100. * ratio) for _ in range(repetitions)]}


class PerformanceVerdictTest(unittest.TestCase):
    def test_gross_point_boundary_for_every_receipt_workload(self):
        for case, count, retained in [('ledger', 1, 0), ('sustained', 20, 20000),
                                      ('concurrent', 24, 0), ('concurrent', 48, 0)]:
            for ratio, fails in [(1.24, False), (1.25, False), (1.26, True)]:
                with self.subTest(case=case, count=count, ratio=ratio):
                    _, failures = case_result(case, count, retained, pairs(ratio))
                    self.assertEqual(bool(failures), fails)

    def test_concurrent_does_not_require_superiority(self):
        for count in (24, 48):
            stats, failures = case_result('concurrent', count, 0, pairs(1.05))
            self.assertFalse(failures)
            self.assertAlmostEqual(stats['p95_pct'], 5.)

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
        stats, failures = case_result('ledger', 1, 0, pairs(1.24))
        self.assertFalse(failures)
        self.assertAlmostEqual(stats['permutation_p'], 2 / 1024)
        self.assertAlmostEqual(stats['paired_geometric_pct'], 24.)
        self.assertAlmostEqual(stats['paired_upper_95_pct'], 24.)
        self.assertAlmostEqual(stats['added_p95_ms_upper95'], 24.)
        self.assertAlmostEqual(stats['p95_pct'], 24.)

    def test_request_failure_in_either_revision_still_fails(self):
        for case in ('ledger', 'sustained', 'concurrent'):
            for version in ('r3', 'r4d'):
                pair = pairs()
                pair[version][0]['failures'] = 1
                stats, failures = case_result(case, 1, 0, pair)
                self.assertEqual(stats['failures'], 1)
                self.assertEqual(len(failures), 1)

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

    def test_latency_mutants_use_the_gross_gate(self):
        for case, count in [('sustained', 20), ('concurrent', 24), ('concurrent', 48)]:
            for ratio, fails in [(1.24, False), (1.26, True)]:
                _, failures = case_result(case, count, 0, pairs(ratio))
                self.assertEqual(bool(property_failures(case, failures)), fails)
                other = 'concurrent' if case == 'sustained' else 'sustained'
                self.assertFalse(property_failures(other, failures))


if __name__ == '__main__':
    unittest.main()
