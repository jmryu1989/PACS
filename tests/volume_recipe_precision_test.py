"""Exercise the actual recipe assertion without starting browser fixtures."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent / 'e2e'))
import test_volume_batch_save as batch_save


class RecipePrecisionTest(unittest.TestCase):
    def test_large_patient_coordinates_and_zero_roundtrip(self):
        original = {'cell': {'camera': {'position': [1000., -2000., 0.], 'viewUp': [0., 0., 1.], 'parallelProjection': True}}, 'count': 3}
        rounded = copy.deepcopy(original)
        rounded['cell']['camera']['position'] = [1000. + 5e-11, -2000. - 1e-10, 5e-15]
        batch_save.VolumeBatchSaveE2E.same_recipe(self, original, rounded)
        wrong = copy.deepcopy(original)
        wrong['cell']['camera']['position'][0] += 1e-7
        with self.assertRaises(AssertionError):
            batch_save.VolumeBatchSaveE2E.same_recipe(self, original, wrong)
        wrong = copy.deepcopy(original)
        wrong['cell']['camera']['viewUp'][0] = 1e-8
        with self.assertRaises(AssertionError):
            batch_save.VolumeBatchSaveE2E.same_recipe(self, original, wrong)
        wrong = copy.deepcopy(original)
        wrong['count'] = 4
        with self.assertRaises(AssertionError):
            batch_save.VolumeBatchSaveE2E.same_recipe(self, original, wrong)


if __name__ == '__main__':
    unittest.main(verbosity=2)
