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
                selection_nodes = [entry] + [n for n in tree.body
                                            if isinstance(n, ast.FunctionDef) and n.name == 'load_tests']
                literals = [n.value for selected_node in selection_nodes for n in ast.walk(selected_node) if isinstance(n, ast.Constant)
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
                    self.assertIn(filename, ['viewer_api_test.py', 'reading_appearance_live.py'])
                    module = runner.load_module(ROOT/'tests'/filename)
                    cls = getattr(module, class_name)
                    self.assertEqual(selected, sorted(name for name in cls.__dict__
                                                     if name.startswith('test_')))
                print('SELECTION', filename, len(selected), flush=True)

    def test_cine_profiles_keep_native_range_and_interruption_cases(self):
        for filename, class_name, prefix, required in [
            ('e2e/test_cine.py', 'CineE2E', 'test_cine_',
             {'test_cine_07_range_yoyo_invalid_input_and_source_reset',
              'test_cine_08_ranged_yoyo_selection_hidden_and_late_source_stop'}),
            ('e2e/test_volume_cine.py', 'VolumeCineE2E', 'test_volume_cine_',
             {'test_volume_cine_08_range_yoyo_pixels_invalid_and_geometry_reset'}),
        ]:
            self.assertIn((filename, class_name), list(zip(ci.SUITES, ci.SUITE_CLASSES)))
            plan = runner.module_plan('tests/'+filename, 'selection-check', 'live', 540, class_name)
            selected = {item['case'].split('.', 1)[1] for item in plan['tests']}
            cls = getattr(runner.load_module(ROOT/'tests'/filename), class_name)
            declared = {name for name in cls.__dict__ if name.startswith(prefix)}
            self.assertEqual(selected, declared)
            self.assertTrue(required.issubset(selected))

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

    def test_source_pdf_profile_selects_four_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['dicom-pdf']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        self.assertEqual({row['case'] for row in plan['tests']},
            {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_pdf_')})
        self.assertEqual(len(plan['tests']),4)
        self.assertEqual(runner.collect(plan).countTestCases(),4)

    def test_candidate_contract_remains_69_then_14(self):
        for filename, count in [('tests/invariants_live.py', 69), ('tests/e2e/test_worklist.py', 14)]:
            plan = runner.module_plan(filename, 'selection-check', 'live', 600)
            self.assertEqual(runner.collect(plan).countTestCases(), count)

    def test_hanging_protocol_profile_runs_exact_shared_and_new_cases(self):
        profile=ci.PROFILES['hanging-protocols']
        for index,(filename,class_name,unit) in enumerate(profile['suites']):
            plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
            self.assertEqual(runner.collect(plan).countTestCases(),len(plan['tests']))
            if index<2:self.assertEqual(len(plan['tests']),[69,14][index])
            if class_name=='HangingProtocolE2E':
                cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
                self.assertEqual({row['case'] for row in plan['tests']},
                    {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_hp_')})
                self.assertEqual(len(plan['tests']),4)


if __name__ == '__main__':
    unittest.main(verbosity=2)
