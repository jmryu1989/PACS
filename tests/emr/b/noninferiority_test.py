"""REQ-D949 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT -> known-input estimator tests."""
import math
import unittest
from noninferiority import noninferiority, p95, gate_result


class NonInferiorityTest(unittest.TestCase):
    def test_equal_faster_and_margin_regression(self):
        a = [[100.] * 40 for _ in range(30)]
        for ratio, expected in [(1., True), (.9, True), (1.11, False)]:
            result = noninferiority(a, [[100 * ratio] * 40 for _ in range(30)])
            self.assertAlmostEqual(result['point_ratio'], ratio)
            self.assertAlmostEqual(result['upper_95_ratio'], ratio)
            self.assertEqual(result['accepted'], expected)

    def test_known_log_ratios_have_known_t_bound(self):
        # logs [-.1, 0, .1]: mean=0, sample SD=.1, df=2, t=.95=2.9199855804.
        b = [[100 * math.exp(x)] * 40 for x in [-.1, 0, .1]]
        result = noninferiority([[100.] * 40] * 3, b)
        self.assertAlmostEqual(result['point_ratio'], 1.)
        self.assertAlmostEqual(result['sd_log_ratio'], .1)
        self.assertAlmostEqual(result['upper_95_ratio'], math.exp(2.9199855804 * .1 / math.sqrt(3)), places=10)
        self.assertFalse(result['accepted'])

    def test_design_degrees_of_freedom_and_known_bounds(self):
        for n, critical in [(12, 1.7958848187), (24, 1.7138715277), (30, 1.6991270265)]:
            logs = [-.1, .1] * (n // 2)
            result = noninferiority([[100.]] * n, [[100 * math.exp(x)] for x in logs])
            self.assertEqual(result['degrees_of_freedom'], n-1)
            self.assertAlmostEqual(result['upper_95_ratio'], math.exp(critical * .1 / math.sqrt(n-1)))

    def test_concurrent_separate_point_and_upper_limits(self):
        a = [[100.]] * 24
        result = noninferiority(a, [[100 * math.exp(x)] for x in [-.06, .04] * 12], 1.)
        self.assertLess(result['point_ratio'], 1.)
        self.assertGreater(result['upper_95_ratio'], 1.)
        self.assertLess(result['upper_95_ratio'], 1.10)
        self.assertTrue(result['accepted'])
        self.assertFalse(noninferiority(a, [[101.]] * 24, 1.)['accepted'])

    def test_block_p95_and_estimand_are_not_pooled_p95(self):
        self.assertEqual(p95(list(range(1, 41))), 38)
        result = noninferiority([[100.] * 40, [1000.] * 40], [[200.] * 40, [500.] * 40])
        self.assertAlmostEqual(result['point_ratio'], 1.)
        self.assertEqual(result['pooled_p95_ratio'], .5)
        self.assertFalse(result['accepted'])

    def test_invalid_pairs_and_latencies_refused(self):
        for a, b in [([], []), ([[1.]], [[1.]]), ([[1.]] * 2, [[1.]] * 3),
                     ([[1., 2.]] * 2, [[1.]] * 2), ([[0.]] * 2, [[1.]] * 2),
                     ([[float('nan')]] * 2, [[1.]] * 2), ([[1.]] * 2, [[float('inf')]] * 2)]:
            with self.subTest(a=a, b=b), self.assertRaises(ValueError):
                noninferiority(a, b)

    def test_ci_records_uncertainty_without_ni_gate(self):
        result = noninferiority([[100.]] * 3, [[100 * math.exp(x)] for x in [-.1, 0, .1]])
        self.assertFalse(gate_result(result, 'acceptance'))
        self.assertTrue(gate_result(result, 'ci-gross'))
        self.assertFalse(gate_result(noninferiority([[100.]] * 3, [[126.]] * 3), 'ci-gross'))
        with self.assertRaises(ValueError):
            gate_result(result, 'unknown')


if __name__ == '__main__':
    unittest.main()
