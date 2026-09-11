"""Compare guarded selection to the existing CI entry points without fixtures."""
import ast
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('execution_runner', ROOT/'scripts/run-tests.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
import measurement_ci as ci


class ExecutionSelectionTests(unittest.TestCase):
    def test_ci_selection_matches_existing_main_contracts(self):
        self.assertEqual(len(ci.SUITES), len(ci.SUITE_CLASSES))
        for filename, class_name in zip(ci.SUITES, ci.SUITE_CLASSES):
            with self.subTest(filename=filename):
                plan = runner.module_plan('tests/'+filename, 'selection-check', 'live', 540, class_name)
                selected = [item['case'].split('.', 1)[1] for item in plan['tests']]
                self.assertTrue(selected)
                self.assertEqual(runner.collect(plan).countTestCases(), len(selected))
                tree = ast.parse((ROOT/'tests'/filename).read_text(encoding='utf-8'))
                entry = next(n for n in tree.body if isinstance(n, ast.If) and '__name__' in ast.unparse(n.test))
                literals = [n.value for n in ast.walk(entry) if isinstance(n, ast.Constant)
                            and isinstance(n.value, str) and n.value.startswith('test_')]
                exact = [name for name in literals if name in selected]
                if exact:
                    self.assertEqual(sorted(exact), selected)
                elif literals:
                    module = runner.load_module(ROOT/'tests'/filename)
                    cls = getattr(module, class_name)
                    original = [name for name in unittest.defaultTestLoader.getTestCaseNames(cls)
                                if any(name.startswith(prefix) for prefix in literals)]
                    # __dict__ entry points intentionally exclude inherited tests.
                    if '__dict__' in ast.unparse(entry):
                        original = [name for name in original if name in cls.__dict__]
                    self.assertEqual(original, selected)
                else:
                    self.assertEqual(filename, 'viewer_api_test.py')
                print('SELECTION', filename, len(selected), flush=True)

    def test_volume_rendering_profile_selects_only_local_vr_methods(self):
        suite, class_name, unit = ci.PROFILES['volume-rendering']['suites'][0]
        plan = runner.module_plan('tests/'+suite, unit, 'live', 1800, class_name)
        selected = [item['case'] for item in plan['tests']]
        module = runner.load_module(ROOT/'tests'/suite)
        declared = sorted('VolumeRenderingE2E.'+name for name in
                          module.VolumeRenderingE2E.__dict__ if name.startswith('test_vr_'))
        self.assertEqual(selected, declared)
        self.assertGreaterEqual(len(selected), 12)
        self.assertTrue(all(case.startswith('VolumeRenderingE2E.test_vr_') for case in selected))
        self.assertTrue(all(item['file'] == 'tests/e2e/test_volume_rendering.py'
                            for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), len(declared))

    def test_candidate_contract_remains_69_then_14(self):
        for filename, count in [('tests/invariants_live.py', 69), ('tests/e2e/test_worklist.py', 14)]:
            plan = runner.module_plan(filename, 'selection-check', 'live', 600)
            self.assertEqual(runner.collect(plan).countTestCases(), count)


if __name__ == '__main__':
    unittest.main(verbosity=2)
