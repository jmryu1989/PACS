"""REQ-D941 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT -> statistical controls."""
import unittest
from noninferiority import noninferiority


class NonInferiorityTest(unittest.TestCase):
    def test_equal_and_faster_pass_but_slower_than_margin_fails(self):
        control = [[100.] * 10 for _ in range(6)]
        self.assertTrue(noninferiority(control, control)['accepted'])
        self.assertTrue(noninferiority(control, [[90.] * 10 for _ in range(6)])['accepted'])
        self.assertFalse(noninferiority(control, [[111.] * 10 for _ in range(6)])['accepted'])

    def test_uncertain_upper_bound_cannot_be_accepted_by_point_estimate(self):
        result = noninferiority([[100.] * 10 for _ in range(6)], [[80.] * 10] * 5 + [[80.] * 9 + [140.]])
        self.assertLessEqual(result['p95_ratio'], 1.10)
        self.assertGreater(result['upper_95_ratio'], 1.10)
        self.assertFalse(result['accepted'])

    def test_concurrent_requires_no_regression_and_invalid_data_refused(self):
        self.assertFalse(noninferiority([[100.]] * 6, [[101.]] * 6, 1.0)['accepted'])
        for a, b in [([[0.]] * 6, [[1.]] * 6), ([[1.]], [[1.]]), ([[1.]] * 6, [[1.]] * 5)]:
            with self.assertRaises(ValueError):
                noninferiority(a, b)


if __name__ == '__main__':
    unittest.main()
