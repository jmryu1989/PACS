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


def dictation_toggle_reach_pins(source, probes):
    """U4L, Astra B2 amendment (2026-09-24, CI2 G3): the suite's one scrolling probe stays where the decision put it.
    Returns problems for `source` (tests/e2e/test_dictation_live.py) and its PROBES; the U4L test asserts none."""
    problems = []
    moves = ('scrollIntoView(', 'scrollTo(', 'scrollBy(', 'scrollTop =', 'scrollLeft =', 'scrollTop=', 'scrollLeft=')
    for name, probe in probes.items():
        if name != 'toggle_reach' and any(token in probe for token in moves):
            problems.append('%s scrolls; only toggle_reach may' % name)
    reach = probes.get('toggle_reach', '')
    pins = ["tg.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });",
            'out.rest = place();', 'if (!out.rest.whole) {', '} finally {', 'for (const [a, y, x] of saved) {',
            "try { a.scrollTo({ top: y, left: x, behavior: 'instant' }); } catch (e) {",
            'out.restored = !failed.length && saved.every(([a, y, x]) => a.scrollTop === y && a.scrollLeft === x);']
    for pin in pins:
        if reach.count(pin) != 1:
            problems.append('toggle_reach must hold exactly once: %s' % pin)
    if not problems:
        at = {pin: reach.index(pin) for pin in pins}
        if not (at['out.rest = place();'] < at['if (!out.rest.whole) {'] < at[pins[0]] < at['} finally {'] <
                at['for (const [a, y, x] of saved) {'] < at[pins[6]]) or reach.index('saved.push(') > at[pins[0]]:
            problems.append('toggle_reach order: rest, then the guarded reveal after saving, then restoring in finally')
        if reach.count('scrollIntoView(') != 1 or reach.count('scrollTo(') != 1:
            problems.append('toggle_reach scrolls once into view and restores through scrollTo only')
    for token in ('.focus(', '.click(', 'dispatchEvent', 'blur('):
        if token in reach:
            problems.append('toggle_reach must not %s' % token)
    tree = ast.parse(source)
    functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    probe_calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr == 'js' and node.args and isinstance(node.args[0], ast.Constant)]
    calls = [call for call in probe_calls if call.args[0].value == 'toggle_reach']
    geo_pass = functions.get('geo_pass')
    if len(calls) != 1 or geo_pass is None or not any(node is calls[0] for node in ast.walk(geo_pass)):
        problems.append('toggle_reach must be evaluated exactly once, in geo_pass')
        return problems
    reads = [node for node in ast.walk(geo_pass) if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
             and node.value in probe_calls and node.value.args[0].value == 'geometry'
             and "rec['measured']['review']" in [ast.unparse(target) for target in node.targets]]
    verdicts = [node for node in ast.walk(geo_pass) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == 'geo_problems' and node.args and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == 'review']
    if len(reads) != 1 or len(verdicts) != 1 or not reads[0].lineno < calls[0].lineno < verdicts[0].lineno:
        problems.append('toggle_reach must follow the review geometry read and precede the review verdict')
    return problems


class ExecutionSelectionTests(unittest.TestCase):
    def test_image_text_profile_selects_four_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['image-text']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        declared={class_name+'.'+name for name in cls.__dict__ if name.startswith('test_image_text_')}
        self.assertEqual({row['case'] for row in plan['tests']},declared)
        self.assertEqual(len(plan['tests']),4)
        self.assertEqual(runner.collect(plan).countTestCases(),4)

    def test_images_only_profile_selects_four_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['images-only']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        declared={class_name+'.'+name for name in cls.__dict__ if name.startswith('test_images_only_')}
        self.assertEqual({row['case'] for row in plan['tests']},declared)
        self.assertEqual(len(plan['tests']),4)
        self.assertEqual(runner.collect(plan).countTestCases(),4)

    def test_study_arrivals_profile_selects_four_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['study-arrivals']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        self.assertEqual({row['case'] for row in plan['tests']},
            {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_arrivals_')})
        self.assertEqual(len(plan['tests']),4)
        self.assertEqual(runner.collect(plan).countTestCases(),4)

    def test_display_scope_profile_selects_four_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['display-scope']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        self.assertEqual({row['case'] for row in plan['tests']},
            {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_scope_')})
        self.assertEqual(len(plan['tests']),4)
        self.assertEqual(runner.collect(plan).countTestCases(),4)

    def test_cell_merge_profile_selects_five_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['cell-merge']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        self.assertEqual({row['case'] for row in plan['tests']},
            {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_cell_merge_')})
        # test_cell_merge_05 added the MPR plane maximize/restore flow to the same declared
        # selection, so the exact declared count is now 5. This stays an equality: a floor
        # would let a case silently drop out of the profile that is supposed to run it.
        self.assertEqual(len(plan['tests']),5)
        self.assertEqual(runner.collect(plan).countTestCases(),5)

    def test_u2b_regressions_profile_selects_each_module_declared_cases_only(self):
        # S5-CIE: each module's own load_tests selection, never the inherited WorklistE2E or RelatedFilterE2E cases.
        profile=ci.PROFILES['u2b-regressions']
        for (filename,class_name,unit),prefix in zip(profile['suites'],('test_d03a_','test_scope_')):
            with self.subTest(filename=filename):
                plan=runner.module_plan('tests/'+filename,unit,'live',profile['suite_timeout'],class_name)
                cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
                declared={class_name+'.'+name for name in cls.__dict__ if name.startswith(prefix)}
                self.assertEqual({row['case'] for row in plan['tests']},declared)
                self.assertEqual(len(plan['tests']),2)
                self.assertEqual(runner.collect(plan).countTestCases(),2)

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

    # The fourteen cases the one-job VR VOI suite declared before S8-U1a fix12 split it; every one of them must still run.
    VR_VOI_BEFORE_SPLIT = ('test_vr_voi_00_render_extent_and_sample_position_convention', 'test_vr_voi_01_box_slab_edges_axis_and_oblique',
                           'test_vr_voi_02_known_markers_kept_hidden_after_rotation', 'test_vr_voi_03_signed_rescaled_encodings_same_result',
                           'test_vr_voi_04_reset_disable_undo_original_close_reopen', 'test_vr_voi_05_crop_sculpt_voi_intersection_and_independence',
                           'test_vr_voi_06_preflight_refusal_and_native_failure_close_only_vr', 'test_vr_voi_07_source_mpr_marks_report_preserved',
                           'test_vr_voi_08_first_slice_boundary', 'test_vr_voi_09_last_slice_boundary_move', 'test_vr_voi_10_full_extent_slab_equals_unmasked',
                           'test_vr_voi_11_missing_middle_slice_refused', 'test_vr_voi_12_missing_near_first_slice_refused',
                           'test_vr_voi_13_mask_session_context_loss_and_new_context')

    def vr_voi_groups(self):
        """{profile: (class, [collected tests])} for the VR VOI Slab groups, through the runner's own plan and collection."""
        filename = 'tests/e2e/test_volume_rendering_voi.py'; module = runner.load_module(ROOT/filename); out = {}
        for name in ci.VR_VOI_GROUPS:
            profile = ci.PROFILES[name]; (suite, class_name, unit), = profile['suites']
            self.assertEqual('tests/'+suite, filename); self.assertTrue(class_name, name)
            plan = runner.module_plan(filename, unit, 'live', profile['suite_timeout'], class_name)
            self.assertTrue(all(item['file'] == filename for item in plan['tests']))
            tests = list(runner.collect(plan))
            self.assertEqual([item['case'] for item in plan['tests']], [class_name+'.'+test._testMethodName for test in tests])
            out[name] = (getattr(module, class_name), tests)
        return module, out

    def test_volume_vr_voi_groups_run_every_declared_case_exactly_once(self):
        """S8-U1a CI-T-04 (fix12, D542 D-C): the VR VOI Slab groups together run exactly the module's declared test_vr_voi_*
        cases: the fourteen of the one-job suite and the access contract case added with the split, each in one group, none
        twice, none added, never an inherited test_vr_* case. A group's case is the very function the base class declares,
        so nothing about a case changes with its group, and each group keeps the job's 900 s cap."""
        module, groups = self.vr_voi_groups(); base = module.VolumeRenderingVoiE2E
        declared = {name: function for name, function in vars(base).items() if name.startswith('test')}
        self.assertTrue(all(name.startswith('test_vr_voi_') for name in declared))
        self.assertEqual(sorted(declared), sorted(self.VR_VOI_BEFORE_SPLIT + ('test_vr_voi_14_access_contract_under_long_frames',)))
        self.assertIn(len(ci.VR_VOI_GROUPS), (2, 3)); self.assertEqual(len(set(ci.VR_VOI_GROUPS)), len(ci.VR_VOI_GROUPS))
        owner = {}
        for name, (group, tests) in groups.items():
            self.assertTrue(tests, name); self.assertTrue(issubclass(group, base) and group is not base, name)
            self.assertEqual(group.__module__, module.__name__)
            self.assertEqual({key for key in vars(group) if key.startswith('test')}, {test._testMethodName for test in tests}, 'a group declares its cases and no other test')
            for test in tests:
                case = test._testMethodName
                self.assertIs(vars(group)[case], declared.get(case), 'the same function as the declared case')
                self.assertNotIn(case, owner, 'a case runs in one group only'); owner[case] = name
                self.assertEqual(test.suite_cap_s, ci.PROFILES[name]['suite_timeout'], (name, case)); self.assertEqual(test.suite_cap_s, 900)
                self.assertFalse(test.generator_reference, (name, case))
        self.assertEqual(set(owner), set(declared), 'every declared case runs, and nothing else')
        self.assertEqual(sum(len(tests) for _, tests in groups.values()), len(declared))
        # The module's own selection (no class) is still every declared case of the base class, once.
        whole = runner.module_plan('tests/e2e/test_volume_rendering_voi.py', 'selection-check', 'live', 900)
        self.assertEqual(sorted(item['case'] for item in whole['tests']), sorted('VolumeRenderingVoiE2E.'+name for name in declared))
        self.assertFalse({row[0] for row in ci.PROFILES['volume-rendering']['suites']} & {'e2e/test_volume_rendering_voi.py'})
        print('SELECTION vr-voi groups', {name: sorted(case[12:14] for case, group in owner.items() if group == name) for name in ci.VR_VOI_GROUPS}, flush=True)

    def test_bu_t03_runs_once_across_vr_voi_and_its_own_profile(self):
        """S8-U1a fix10 CI-T-08 (D531, TEST-S8-SCULPT-PERF BU-T03): the profiles on the VR VOI module select disjoint cases; the
        VR VOI Slab groups run the declared test_vr_voi_* cases, volume-bu-generator exactly its one BU-T03 case, and the
        generator comparison is on in that one collected case only, each under its own profile's cap."""
        import ast
        filename = 'tests/e2e/test_volume_rendering_voi.py'
        module, groups = self.vr_voi_groups()
        collected = {name: tests for name, (_, tests) in groups.items()}
        profile = ci.PROFILES['volume-bu-generator']; (suite, class_name, unit), = profile['suites']
        self.assertEqual('tests/'+suite, filename)
        collected['volume-bu-generator'] = list(runner.collect(runner.module_plan(filename, unit, 'live', profile['suite_timeout'], class_name)))
        for test in collected['volume-bu-generator']:
            self.assertEqual(test.suite_cap_s, profile['suite_timeout'], test.id())
        base, generator = module.VolumeRenderingVoiE2E, module.VolumeRenderingVoiGeneratorE2E
        cases = {name: sorted((type(test).__name__, test._testMethodName) for test in tests) for name, tests in collected.items()}
        self.assertEqual(cases['volume-bu-generator'], [('VolumeRenderingVoiGeneratorE2E', 'test_bu_t03_max_frames_equal_todays_generator')])
        self.assertEqual([name for name in vars(generator) if name.startswith('test')], ['test_bu_t03_max_frames_equal_todays_generator'])
        self.assertNotIn('test_bu_t03_max_frames_equal_todays_generator', {case for name in ci.VR_VOI_GROUPS for _, case in cases[name]})
        self.assertNotIn(generator, [group for group, _ in groups.values()])
        # BU-T03 is on in exactly one collected case of all these runs, the generator class's.
        on = [(name, type(test).__name__) for name, tests in collected.items() for test in tests if test.generator_reference]
        self.assertEqual(on, [('volume-bu-generator', 'VolumeRenderingVoiGeneratorE2E')])
        # Every generator comparison in the module runs under that switch, and the BU-T03 case drives the MAX flow that
        # test_vr_voi_05 drives (read from the module's syntax tree, not run).
        tree = ast.parse((ROOT/filename).read_text(encoding='utf-8'))
        guarded = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.If) and ast.unparse(node.test) == 'self.generator_reference':
                guarded |= {id(call) for statement in node.body for call in ast.walk(statement) if isinstance(call, ast.Call)}
        compares = [call for call in ast.walk(tree) if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == 'same_as_generator']
        self.assertTrue(compares)
        self.assertTrue(all(id(call) in guarded for call in compares))
        methods = {(klass.name, node.name): node for klass in tree.body if isinstance(klass, ast.ClassDef) for node in klass.body if isinstance(node, ast.FunctionDef)}
        drives = lambda key: [call for call in ast.walk(methods[key]) if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == 'max_combination']
        self.assertEqual(len(drives(('VolumeRenderingVoiE2E', 'test_vr_voi_05_crop_sculpt_voi_intersection_and_independence'))), 1)
        self.assertEqual(len(drives(('VolumeRenderingVoiGeneratorE2E', 'test_bu_t03_max_frames_equal_todays_generator'))), 1)

    def test_vr_voi_failures_are_written_when_they_happen_and_stay_failures(self):
        """S8-U1a fix11 CI-T-09: a failing or erroring VR VOI case writes its traceback before the next case starts (the runner
        prints tracebacks only when the whole run ends, which a suite killed on its cap never reaches), and its result is
        still the FAIL or ERROR it was. Run on the module's own class with a stand-in for the stack and five small cases.
        S8-U1a fix12: a case that failed also writes, before its cleanup, why its VR closed as far as it can be read
        (VRVOI-CLOSE) for each viewer page it watched; what could not be read is listed as not recorded, and a case that
        passed writes no such record."""
        import contextlib
        import io
        import json
        import time
        from unittest.mock import patch
        module = runner.load_module(ROOT/'tests/e2e/test_volume_rendering_voi.py')

        class Page:
            """A viewer page that is open and does not answer: everything the close record reads from it fails."""
            def on(self, name, handler):
                pass

            def is_closed(self):
                return False

            def wait_for_function(self, *arguments, **options):
                raise RuntimeError('PROBE-PAGE')

        def cases(base):
            class Probe(base):
                @classmethod
                def setUpClass(cls):
                    cls.suite_started = time.monotonic()

                def setUp(self):
                    self.contexts = []; print('PROBE-START', self._testMethodName, flush=True)
                    if hasattr(self, 'watch_access'):
                        self.watch_access(Page())

                def test_a_fails(self):
                    self.assertEqual(1, 2, 'PROBE-A')

                def test_b_errors(self):
                    raise RuntimeError('PROBE-B')

                def test_c_passes(self):
                    pass

                def test_d_part_fails(self):
                    with self.subTest(part=1):
                        self.fail('PROBE-D')

                def test_e_cleanup_errors(self):
                    def broken():
                        raise RuntimeError('PROBE-E')
                    self.addCleanup(broken)
            names = ['test_a_fails', 'test_b_errors', 'test_c_passes', 'test_d_part_fails', 'test_e_cleanup_errors']
            out = io.StringIO()
            with contextlib.ExitStack() as stack:
                if base is not unittest.TestCase:
                    # The inherited tearDown screenshots the stack's pages into the artifact folder; there is no stack here.
                    inherited = next(klass for klass in base.__mro__[1:] if 'tearDown' in vars(klass))
                    stack.enter_context(patch.object(inherited, 'tearDown', lambda case: None))
                stack.enter_context(contextlib.redirect_stdout(out))
                result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=2).run(unittest.TestSuite(Probe(name) for name in names))
            return result, out.getvalue()
        result, written = cases(module.VolumeRenderingVoiE2E)
        # The results are what the runner would have counted without the records: two failures, two errors, nothing skipped.
        self.assertEqual((result.testsRun, len(result.failures), len(result.errors), len(result.skipped)), (5, 2, 2, 0))
        self.assertFalse(result.wasSuccessful())
        blocks = written.split('VRVOI-TRACEBACK end')
        self.assertEqual(len(blocks), 5, written)
        for kind, name, marker, following in (('FAIL', 'test_a_fails', 'PROBE-A', 'test_b_errors'), ('ERROR', 'test_b_errors', 'PROBE-B', 'test_c_passes'),
                                              ('FAIL', 'test_d_part_fails', 'PROBE-D', 'test_e_cleanup_errors'), ('ERROR', 'test_e_cleanup_errors', 'PROBE-E', None)):
            header = [line for line in written.splitlines() if line.startswith('VRVOI-TRACEBACK ' + kind + ' ') and name in line]
            self.assertEqual(len(header), 1, (kind, name, written))
            at = written.index(header[0]); end = written.index('VRVOI-TRACEBACK end', at)
            self.assertIn(marker, written[at:end], name); self.assertIn('Traceback', written[at:end], name)
            if following:
                self.assertLess(end, written.index('PROBE-START ' + following), name + ' is written before the next case starts')
        self.assertNotIn('test_c_passes', ''.join(line for line in written.splitlines() if line.startswith('VRVOI-TRACEBACK ')))
        # The close record: one per watched page of each case whose body failed, written after its traceback and before the
        # next case; nothing it could not read is filled in. A cleanup that fails after the pages are gone writes none.
        lines = written.splitlines(); closes = [json.loads(line.split(' ', 1)[1]) for line in lines if line.startswith('VRVOI-CLOSE ')]
        self.assertEqual([record['case'] for record in closes], ['test_a_fails', 'test_b_errors', 'test_d_part_fails'])
        for record, following in zip(closes, ('test_b_errors', 'test_c_passes', 'test_e_cleanup_errors')):
            self.assertEqual(record['access_checks']['total'], 0)
            self.assertTrue(any('PROBE-PAGE' in item for item in record['not_recorded']), record)
            self.assertTrue(any('does not answer' in item for item in record['not_recorded']), record)
            for key in ('notice', 'dialog_status', 'context_lost_now', 'vr_closed_s'):
                self.assertNotIn(key, record, 'an item that was not read is not written')
            at = next(n for n, line in enumerate(lines) if line.startswith('VRVOI-CLOSE ') and json.loads(line.split(' ', 1)[1])['case'] == record['case'])
            self.assertGreater(at, next(n for n, line in enumerate(lines) if line.startswith('VRVOI-TRACEBACK ') and record['case'] in line))
            self.assertLess(at, lines.index('PROBE-START ' + following))
        # Each case's time is written as well (VRVOI-CASE), with whether a part of it failed.
        timed = {record['case']: record for record in (json.loads(line.split(' ', 1)[1]) for line in lines if line.startswith('VRVOI-CASE '))}
        self.assertEqual({name: record['failed_parts'] for name, record in timed.items()},
                         {'test_a_fails': 1, 'test_b_errors': 1, 'test_c_passes': 0, 'test_d_part_fails': 1, 'test_e_cleanup_errors': 1})
        # The same five cases on a plain TestCase write nothing: the records come from the VR VOI class.
        plain, silent = cases(unittest.TestCase)
        self.assertEqual((plain.testsRun, len(plain.failures), len(plain.errors)), (5, 2, 2))
        self.assertFalse([line for line in silent.splitlines() if line.startswith('VRVOI-')])

    def test_volume_mpr_profile_selects_only_the_declared_mpr_modules(self):
        profile = ci.PROFILES['volume-mpr']
        expected = [('e2e/test_volume_crosshair.py', 'VolumeCrosshairE2E',
                     'test_crosshair_', 'ci-mpr-crosshair', 12),
                    ('e2e/test_volume_display.py', 'VolumeDisplayE2E',
                     'test_mpr_display_', 'ci-mpr-display', 12),
                    ('e2e/test_volume_curved.py', 'VolumeCurvedE2E',
                     'test_curved_', 'ci-mpr-curved', 4)]
        self.assertEqual([row[0] for row in profile['suites']], [row[0] for row in expected])
        self.assertEqual([row[2] for row in profile['suites']], [row[3] for row in expected])
        for (suite, class_name, unit), (_, cls_name, prefix, _, count) in zip(
                profile['suites'], expected):
            with self.subTest(suite=suite):
                # No class is passed: the module's own load_tests is the allowlist.
                self.assertIsNone(class_name)
                plan = runner.module_plan('tests/'+suite, unit, 'live',
                                          profile['suite_timeout'], class_name)
                selected = [item['case'] for item in plan['tests']]
                cls = getattr(runner.load_module(ROOT/'tests'/suite), cls_name)
                declared = sorted(cls_name+'.'+name for name in cls.__dict__
                                  if name.startswith(prefix))
                self.assertEqual(sorted(selected), declared)
                self.assertEqual(len(selected), count)
                if cls_name == 'VolumeCrosshairE2E':
                    # The real pointer drag on the native rotation handle is the A02 line-rotation proof.
                    self.assertIn(cls_name+'.test_crosshair_12_native_rotate_handle_drag_follows_pointer_about_pivot',
                                  selected)
                # Inherited base-class cases must not widen this profile: the
                # orientation/job suites keep their own registration elsewhere.
                inherited = {name for base in cls.__mro__[1:]
                             for name in vars(base) if name.startswith('test_')}
                self.assertTrue(inherited, 'expected an inheriting MPR suite')
                self.assertFalse(inherited & {case.split('.', 1)[1] for case in selected})
                # And no case may come from another module or another class.
                self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
                self.assertTrue(all(case.startswith(cls_name+'.'+prefix) for case in selected))
                self.assertEqual(runner.collect(plan).countTestCases(), count)
                print('SELECTION', suite, len(selected), flush=True)
        # The MPR profile stays disjoint from the VR profile it is modelled on.
        vr_suite = ci.PROFILES['volume-rendering']['suites'][0][0]
        self.assertNotIn(vr_suite, [row[0] for row in profile['suites']])

    def test_volume_slab_profile_selects_only_the_declared_slab_modules(self):
        profile = ci.PROFILES['volume-slab']
        expected = [('e2e/test_volume_projection.py', 'VolumeProjectionE2E',
                     'test_projection_', 'ci-slab-projection', 8,
                     {'test_projection_01_known_voxels_modes_thickness_and_other_planes',
                      'test_projection_05_embedded_plane_change_and_source_guards',
                      'test_projection_07_anisotropic_oblique_small_structure_final_pixels',
                      'test_projection_08_progressive_slab_preview_final_and_capture_gate'}),
                    ('e2e/test_volume_wheel.py', 'VolumeWheelE2E',
                     'test_wheel_', 'ci-slab-wheel', 4,
                     {'test_wheel_01_target_mode_and_restore',
                      'test_wheel_03_mip_pixels_minimum_and_partial_failure'}),
                    ('e2e/test_volume_average_affine.py', 'VolumeAverageAffineE2E',
                     'test_average_affine_', 'ci-slab-average-affine', 2,
                     {'test_average_affine_01_negative_constant',
                      'test_average_affine_02_positive_constant'}),
                    ('e2e/test_volume_mip.py', 'VolumeMipE2E',
                     'test_mip_', 'ci-slab-mip-viewer', 3,
                     {'test_mip_01_known_voxels_modes_orientations_and_mpr_slab_parity',
                      'test_mip_02_order_delay_failure_capability_and_busy_gates',
                      'test_mip_03_lifecycle_identity_teardown_reentry_and_high_values'})]
        # The VOI Slab cases are declared on the MIP Viewer class but run only in the volume-mip-voi profile.
        voi = {'test_mip_04_voi_slab_known_voxels_modes_orientations',
               'test_mip_05_voi_order_delay_failure_missing_tool_cancel',
               'test_mip_06_voi_original_undo_reset_scope_lifecycle'}
        self.assertEqual([row[0] for row in profile['suites']], [row[0] for row in expected])
        self.assertEqual([row[2] for row in profile['suites']], [row[3] for row in expected])
        for (suite, class_name, unit), (_, cls_name, prefix, _, count, required) in zip(
                profile['suites'], expected):
            with self.subTest(suite=suite):
                self.assertIsNone(class_name)
                # Planned at the budget CI will actually request for this suite.
                plan = runner.module_plan('tests/'+suite, unit, 'live',
                                          profile['suite_budgets'][unit], class_name)
                selected = [item['case'] for item in plan['tests']]
                cls = getattr(runner.load_module(ROOT/'tests'/suite), cls_name)
                declared = sorted(cls_name+'.'+name for name in cls.__dict__
                                  if name.startswith(prefix) and name not in voi)
                self.assertEqual(sorted(selected), declared)
                self.assertEqual(len(selected), count)
                self.assertTrue({cls_name+'.'+name for name in required}.issubset(selected))
                # Inherited base-class cases (orientation, jobs, marks, print...) must not
                # widen this profile.
                inherited = {name for base in cls.__mro__[1:]
                             for name in vars(base) if name.startswith('test_')}
                self.assertFalse(inherited & {case.split('.', 1)[1] for case in selected})
                self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
                self.assertTrue(all(case.startswith(cls_name+'.'+prefix) for case in selected))
                self.assertEqual(runner.collect(plan).countTestCases(), count)
                print('SELECTION', suite, len(selected), flush=True)
        # The slab group stays disjoint from the first MPR group and the VR profile.
        others = {row[0] for name in ('volume-mpr', 'volume-rendering')
                  for row in ci.PROFILES[name]['suites']}
        self.assertFalse(others & {row[0] for row in profile['suites']})

    def test_volume_path_profile_selects_only_the_declared_path_and_orientation_modules(self):
        profile = ci.PROFILES['volume-path']
        expected = [('e2e/test_volume_path.py', 'VolumePathE2E',
                     'test_path_', 'ci-path-native', 4,
                     {'test_path_01_noncoplanar_points_unfolded_oracle_save_and_new_browser_restore',
                      'test_path_02_go_to_path_point_native_planes_pixels_and_rotation_semantics'}),
                    ('e2e/test_volume_orientation.py', 'VolumeOrientationE2E',
                     'test_orientation_', 'ci-mpr-orientation', 6,
                     {'test_orientation_01_double_oblique_pixels_reset_and_saved_reopen'}),
                    # S2-L: the finding location suite inherits every marks case; only its own three run here.
                    ('e2e/test_finding_locations.py', 'FindingLocationsE2E',
                     'test_location_', 'ci-finding-location', 3,
                     {'test_location_01_prior_point_link_new_login_continuation_and_exact_arrival',
                      'test_location_02_refusals_metadata_hidden_sync_off_and_server_matrix',
                      'test_location_03_same_document_restore_keeps_finding_drafts_and_withdrawal_removes_the_finding'})]
        self.assertEqual([row[0] for row in profile['suites']], [row[0] for row in expected])
        self.assertEqual([row[2] for row in profile['suites']], [row[3] for row in expected])
        for (suite, class_name, unit), (_, cls_name, prefix, _, count, required) in zip(
                profile['suites'], expected):
            with self.subTest(suite=suite):
                self.assertIsNone(class_name)
                # Planned at the budget CI will actually request for this suite.
                plan = runner.module_plan('tests/'+suite, unit, 'live',
                                          profile['suite_budgets'][unit], class_name)
                selected = [item['case'] for item in plan['tests']]
                cls = getattr(runner.load_module(ROOT/'tests'/suite), cls_name)
                declared = sorted(cls_name+'.'+name for name in cls.__dict__
                                  if name.startswith(prefix))
                self.assertEqual(sorted(selected), declared)
                self.assertEqual(len(selected), count)
                self.assertTrue({cls_name+'.'+name for name in required}.issubset(selected))
                # Inherited base-class cases (curved, marks, jobs, sync...) must not widen this profile.
                inherited = {name for base in cls.__mro__[1:]
                             for name in vars(base) if name.startswith('test_')}
                self.assertTrue(inherited, 'expected an inheriting suite')
                self.assertFalse(inherited & {case.split('.', 1)[1] for case in selected})
                self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
                self.assertTrue(all(case.startswith(cls_name+'.'+prefix) for case in selected))
                self.assertEqual(runner.collect(plan).countTestCases(), count)
                print('SELECTION', suite, len(selected), flush=True)
        # The path group stays disjoint from the other MPR groups and the VR profile.
        others = {row[0] for name in ('volume-mpr', 'volume-slab', 'volume-rendering')
                  for row in ci.PROFILES[name]['suites']}
        self.assertFalse(others & {row[0] for row in profile['suites']})

    def test_volume_batch_profile_selects_only_the_declared_batch_modules(self):
        profile = ci.PROFILES['volume-batch']
        expected = [('e2e/test_volume_batch.py', 'VolumeBatchE2E',
                     'test_batch_', 'ci-batch-preview', 6,
                     {'test_batch_01_pixels_navigation_cine_and_preservation',
                      'test_batch_02_oblique_real_camera_spacing',
                      'test_batch_06_cancel_late_volume_attachment_and_denied_account'}),
                    ('e2e/test_volume_batch_context.py', 'VolumeBatchContextE2E',
                     'test_batch_context_', 'ci-batch-context', 5,
                     {'test_batch_context_01_embedded_owner_and_report',
                      'test_batch_context_05_dpr150'}),
                    ('e2e/test_volume_batch_save.py', 'VolumeBatchSaveE2E',
                     'test_batch_save_', 'ci-batch-save', 8,
                     {'test_batch_save_01_frozen_recipe_new_login_size_and_dpr',
                      'test_batch_save_02_partial_failure_recovers_previous_batch',
                      'test_batch_save_03_rejects_forged_recipe_sources_and_roles'}),
                    ('e2e/test_volume_batch_scout.py', 'VolumeBatchScoutE2E',
                     'test_scout_', 'ci-batch-scout', 5,
                     {'test_scout_01_positions_pixels_navigation_and_preservation',
                      'test_scout_02_oblique_reverse_saved_replay_dpr',
                      'test_scout_05_missing_optional_asset_keeps_batch'})]
        self.assertEqual([row[0] for row in profile['suites']], [row[0] for row in expected])
        self.assertEqual([row[2] for row in profile['suites']], [row[3] for row in expected])
        methods = set()
        for (suite, class_name, unit), (_, cls_name, prefix, _, count, required) in zip(
                profile['suites'], expected):
            with self.subTest(suite=suite):
                self.assertIsNone(class_name)
                # Planned at the budget CI will actually request for this suite.
                plan = runner.module_plan('tests/'+suite, unit, 'live',
                                          profile['suite_budgets'][unit], class_name)
                selected = [item['case'] for item in plan['tests']]
                cls = getattr(runner.load_module(ROOT/'tests'/suite), cls_name)
                declared = sorted(cls_name+'.'+name for name in cls.__dict__
                                  if name.startswith(prefix))
                self.assertEqual(sorted(selected), declared)
                self.assertEqual(len(selected), count)
                self.assertTrue({cls_name+'.'+name for name in required}.issubset(selected))
                # The batch suites inherit one another and orientation, jobs, projection and copy
                # cases; none of those may widen this profile or run twice.
                inherited = {name for base in cls.__mro__[1:]
                             for name in vars(base) if name.startswith('test_')}
                self.assertTrue(inherited, 'expected an inheriting suite')
                names = {case.split('.', 1)[1] for case in selected}
                self.assertFalse(inherited & names)
                self.assertFalse(methods & names)
                methods |= names
                self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
                self.assertTrue(all(case.startswith(cls_name+'.'+prefix) for case in selected))
                self.assertEqual(runner.collect(plan).countTestCases(), count)
                print('SELECTION', suite, len(selected), flush=True)
        self.assertEqual(len(methods), 24)
        # The batch group stays disjoint from the other MPR groups and the VR profile.
        others = {row[0] for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-rendering')
                  for row in ci.PROFILES[name]['suites']}
        self.assertFalse(others & {row[0] for row in profile['suites']})

    def test_volume_sync_preferences_profile_selects_only_the_declared_modules(self):
        profile = ci.PROFILES['volume-sync-preferences']
        expected = [('e2e/test_volume_sync.py', 'VolumeSyncE2E',
                     'test_sync_', 'ci-mpr-sync', 16,
                     {'test_sync_01_windowing_zoom_and_selected_reset',
                      'test_sync_03_partial_peer_failure_and_retry',
                      'test_sync_05_sigmoid_inversion_pixels_and_exact_failure_restore',
                      'test_sync_12_native_mouse_windowing_and_zoom',
                      'test_sync_15_inversion_does_not_resynchronize_selected_reset',
                      'test_sync_16_hanging_protocol_vacancy_keeps_choices_and_applied_profile'}),
                    ('e2e/test_volume_preferences.py', 'VolumePreferencesE2E',
                     'test_properties_', 'ci-mpr-preferences', 18,
                     {'test_properties_02_native_mouse_and_duplicate_rejection',
                      'test_properties_06_account_new_browser_restores_after_modal_preserving_work',
                      'test_properties_07_progressive_refines_to_identical_pixels',
                      'test_properties_10_saved_profile_applies_after_job_restore',
                      'test_properties_14_modifier_touch_bindings_survive_and_restore',
                      'test_properties_18_passive_tool_bound_by_apply_mouse_restores_after_hanging_protocol_retirement'})]
        self.assertEqual([row[0] for row in profile['suites']], [row[0] for row in expected])
        self.assertEqual([row[2] for row in profile['suites']], [row[3] for row in expected])
        methods = set()
        for (suite, class_name, unit), (_, cls_name, prefix, _, count, required) in zip(
                profile['suites'], expected):
            with self.subTest(suite=suite):
                self.assertIsNone(class_name)
                # Planned at the budget CI will actually request for this suite.
                plan = runner.module_plan('tests/'+suite, unit, 'live',
                                          profile['suite_budgets'][unit], class_name)
                selected = [item['case'] for item in plan['tests']]
                cls = getattr(runner.load_module(ROOT/'tests'/suite), cls_name)
                # Exactly the declared cases, in the declared order the local history ran them.
                self.assertEqual(selected, [cls_name+'.'+name for name in cls.__dict__
                                            if name.startswith(prefix)])
                self.assertEqual(len(selected), count)
                self.assertTrue({cls_name+'.'+name for name in required}.issubset(selected))
                # Preferences inherits every sync case and sync inherits display, orientation and jobs;
                # none of those may widen this profile or run twice.
                inherited = {name for base in cls.__mro__[1:]
                             for name in vars(base) if name.startswith('test_')}
                self.assertTrue(inherited, 'expected an inheriting suite')
                names = {case.split('.', 1)[1] for case in selected}
                self.assertFalse(inherited & names)
                self.assertFalse(methods & names)
                methods |= names
                self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
                self.assertTrue(all(case.startswith(cls_name+'.'+prefix) for case in selected))
                self.assertEqual(runner.collect(plan).countTestCases(), count)
                print('SELECTION', suite, len(selected), flush=True)
        self.assertEqual(len(methods), 34)
        # The group stays disjoint from the other MPR groups and the VR profile; the marks suite that
        # inherits sync keeps its own registration outside this group.
        others = {row[0] for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-rendering')
                  for row in ci.PROFILES[name]['suites']}
        modules = {row[0] for row in profile['suites']}
        self.assertFalse(others & modules)
        self.assertNotIn('e2e/test_volume_marks.py', modules)

    def test_sync_and_preferences_load_tests_follow_unittest_name_patterns(self):
        # A local exact rerun (-k) must select what unittest itself selects among the module's own
        # declared cases. A module-specific matcher silently selected none for class-qualified names.
        def flatten(suite):
            for item in suite:
                yield from flatten(item) if isinstance(item, unittest.TestSuite) else (item,)
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_sync.py', 'VolumeSyncE2E', 'test_sync_', 16),
                ('e2e/test_volume_preferences.py', 'VolumePreferencesE2E', 'test_properties_', 18)):
            module = runner.load_module(ROOT/'tests'/suite)
            cls = getattr(module, class_name)
            first = sorted(name for name in cls.__dict__ if name.startswith(prefix))[0]
            for patterns, expected in ((None, count), (['*'+first+'*'], 1),
                                       (['*'+class_name+'.'+first+'*'], 1),
                                       (['*'+module.__name__+'.'+class_name+'.*'], count),
                                       (['*'+class_name+'*'], count), (['*'+first.upper()+'*'], 0),
                                       (['*test_mpr_display_01*'], 0)):
                with self.subTest(suite=suite, patterns=patterns):
                    loader = unittest.TestLoader()
                    loader.testNamePatterns = patterns
                    selected = [test._testMethodName for test in flatten(loader.loadTestsFromModule(module))]
                    reference = [name for name in loader.getTestCaseNames(cls)
                                 if name.startswith(prefix) and name in cls.__dict__]
                    self.assertEqual(sorted(selected), sorted(reference))
                    self.assertEqual(len(selected), expected)

    def test_volume_marks_profile_selects_only_the_declared_marks_and_annotated_output_modules(self):
        profile = ci.PROFILES['volume-marks']
        expected = [('e2e/test_volume_marks.py', 'VolumeMarksE2E',
                     'test_marks_', 'ci-mpr-marks', 20,
                     {'test_marks_02_job_and_new_browser_restore_full_volume',
                      'test_marks_12_legacy_jobs_clear_marks_without_target_dependency',
                      'test_marks_19_receipt_after_layout_change_acknowledges_saved_source',
                      'test_marks_20_progressive_slab_pick_final_batch_save_and_restore'}),
                    ('e2e/test_volume_mpr_print.py', 'VolumeMprPrintE2E',
                     'test_mpr_print_', 'ci-mpr-marks-print', 9,
                     {'test_mpr_print_02_marks_number_position_and_immutable_source',
                      'test_mpr_print_08_annotated_batch_offsets',
                      'test_mpr_print_09_oblique_average_readonly_dpr'})]
        self.assertEqual([row[0] for row in profile['suites']], [row[0] for row in expected])
        self.assertEqual([row[2] for row in profile['suites']], [row[3] for row in expected])
        methods = set()
        for (suite, class_name, unit), (_, cls_name, prefix, _, count, required) in zip(
                profile['suites'], expected):
            with self.subTest(suite=suite):
                self.assertIsNone(class_name)
                # Planned at the budget CI will actually request for this suite.
                plan = runner.module_plan('tests/'+suite, unit, 'live',
                                          profile['suite_budgets'][unit], class_name)
                selected = [item['case'] for item in plan['tests']]
                cls = getattr(runner.load_module(ROOT/'tests'/suite), cls_name)
                # The output suite declares four of its cases by assigning batch print cases to local names.
                declared = sorted(cls_name+'.'+name for name in cls.__dict__
                                  if name.startswith(prefix))
                self.assertEqual(sorted(selected), declared)
                self.assertEqual(len(selected), count)
                self.assertTrue({cls_name+'.'+name for name in required}.issubset(selected))
                # The output suite inherits every marks case and marks inherits sync, display, orientation
                # and jobs; none of those may widen this profile or run twice.
                inherited = {name for base in cls.__mro__[1:]
                             for name in vars(base) if name.startswith('test_')}
                self.assertTrue(inherited, 'expected an inheriting suite')
                names = {case.split('.', 1)[1] for case in selected}
                self.assertFalse(inherited & names)
                self.assertFalse(methods & names)
                methods |= names
                self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
                self.assertTrue(all(case.startswith(cls_name+'.'+prefix) for case in selected))
                self.assertEqual(runner.collect(plan).countTestCases(), count)
                print('SELECTION', suite, len(selected), flush=True)
        self.assertEqual(len(methods), 29)
        # The group stays disjoint from the other MPR groups and the VR profile; current unsaved output
        # inherits the saved output suite and keeps its own registration outside this group.
        others = {row[0] for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch',
                                      'volume-sync-preferences', 'volume-rendering')
                  for row in ci.PROFILES[name]['suites']}
        modules = {row[0] for row in profile['suites']}
        self.assertFalse(others & modules)
        self.assertNotIn('e2e/test_volume_current_print.py', modules)

    def test_volume_mip_voi_profile_selects_each_authored_voi_slab_case_once(self):
        profile = ci.PROFILES['volume-mip-voi']
        voi = ['test_mip_04_voi_slab_known_voxels_modes_orientations',
               'test_mip_05_voi_order_delay_failure_missing_tool_cancel',
               'test_mip_06_voi_original_undo_reset_scope_lifecycle']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_voi.py', None, 'ci-mip-voi'),))
        suite, class_name, unit = profile['suites'][0]
        # Planned at the budget CI will actually request for this suite.
        plan = runner.module_plan('tests/'+suite, unit, 'live', profile['suite_budgets'][unit], class_name)
        selected = [item['case'] for item in plan['tests']]
        self.assertEqual(selected, ['VolumeMipVoiE2E.'+name for name in voi])
        self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), 3)
        # The local subclass declares no case of its own: each selected case is the authored MIP Viewer method itself.
        cls = getattr(runner.load_module(ROOT/'tests'/suite), 'VolumeMipVoiE2E')
        base = getattr(runner.load_module(ROOT/'tests/e2e/test_volume_mip.py'), 'VolumeMipE2E')
        self.assertEqual(cls.__bases__, (base,))
        self.assertEqual([name for name in vars(cls) if name.startswith('test')], [])
        self.assertTrue(all(getattr(cls, name) is vars(base)[name] for name in voi))
        # With the slab profile's MIP Viewer suite, every authored test_mip_ case runs exactly once across both groups.
        slab = ci.PROFILES['volume-slab']
        self.assertIn(('e2e/test_volume_mip.py', None, 'ci-slab-mip-viewer'), slab['suites'])
        viewer = runner.module_plan('tests/e2e/test_volume_mip.py', 'ci-slab-mip-viewer', 'live',
                                    slab['suite_budgets']['ci-slab-mip-viewer'])
        names = [item['case'].split('.', 1)[1] for item in viewer['tests']] + voi
        self.assertEqual(len(names), 6)
        self.assertEqual(sorted(names), sorted(name for name in vars(base) if name.startswith('test_')))
        # No other profile selects this module or shares this unit's attempt ledger.
        for name, other in ci.PROFILES.items():
            if name != 'volume-mip-voi':
                self.assertNotIn(suite, [row[0] for row in other['suites']], name)
                self.assertNotIn(unit, [row[2] for row in other['suites']], name)
        print('SELECTION', suite, len(selected), flush=True)

    def test_volume_mip_job_profile_selects_each_authored_mip_job_case_once(self):
        profile = ci.PROFILES['volume-mip-job']
        cases = ['test_mip_job_01_save_restore_roundtrip_new_browser_pixels',
                 'test_mip_job_02_save_gates_failure_unconfirmed_retry_roles_account',
                 'test_mip_job_03_restore_failure_missing_tool_cancel_stale_rollback']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_job.py', None, 'ci-mip-job'),))
        suite, class_name, unit = profile['suites'][0]
        # Planned at the budget CI will actually request for this suite.
        plan = runner.module_plan('tests/'+suite, unit, 'live', profile['suite_budgets'][unit], class_name)
        self.assertEqual([item['case'] for item in plan['tests']], ['VolumeMipJobE2E.'+name for name in cases])
        self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), 3)
        # The class declares exactly these cases on the MIP Viewer base; no inherited MIP Viewer or VOI Slab case is selected.
        cls = getattr(runner.load_module(ROOT/'tests'/suite), 'VolumeMipJobE2E')
        base = getattr(runner.load_module(ROOT/'tests/e2e/test_volume_mip.py'), 'VolumeMipE2E')
        self.assertEqual(cls.__bases__, (base,))
        self.assertEqual(sorted(name for name in vars(cls) if name.startswith('test')), cases)
        for name, other in ci.PROFILES.items():
            if name != 'volume-mip-job':
                self.assertNotIn(suite, [row[0] for row in other['suites']], name)
                self.assertNotIn(unit, [row[2] for row in other['suites']], name)
        print('SELECTION', suite, len(cases), flush=True)

    def test_volume_mip_batch_profile_selects_each_authored_mip_batch_case_once(self):
        profile = ci.PROFILES['volume-mip-batch']
        cases = ['test_mip_batch_01_rotation_voi_frames_save_restore_new_browser',
                 'test_mip_batch_02_gates_cancel_failure_order_v12_compat',
                 'test_mip_batch_03_restore_failure_missing_tool_cancel_stale_rollback']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_batch.py', None, 'ci-mip-batch'),))
        suite, class_name, unit = profile['suites'][0]
        # Planned at the budget CI will actually request for this suite.
        plan = runner.module_plan('tests/'+suite, unit, 'live', profile['suite_budgets'][unit], class_name)
        self.assertEqual([item['case'] for item in plan['tests']], ['VolumeMipBatchE2E.'+name for name in cases])
        self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), 3)
        # The class declares exactly these cases on the MIP Job base; no inherited MIP Viewer, VOI Slab or MIP Job case is selected.
        cls = getattr(runner.load_module(ROOT/'tests'/suite), 'VolumeMipBatchE2E')
        self.assertEqual([(base.__module__, base.__name__) for base in cls.__bases__], [('test_volume_mip_job', 'VolumeMipJobE2E')])
        self.assertEqual(sorted(name for name in vars(cls) if name.startswith('test')), cases)
        for name, other in ci.PROFILES.items():
            if name != 'volume-mip-batch':
                self.assertNotIn(suite, [row[0] for row in other['suites']], name)
                self.assertNotIn(unit, [row[2] for row in other['suites']], name)
        print('SELECTION', suite, len(cases), flush=True)

    def test_volume_mip_output_profile_selects_each_authored_mip_output_case_once(self):
        profile = ci.PROFILES['volume-mip-output']
        cases = ['test_mip_output_01_v12_v13_fresh_pixel_frames_pdf_identity',
                 'test_mip_output_02_readiness_delay_failure_missing_tool_cancel_no_partial_page',
                 'test_mip_output_03_source_access_order_session']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_output.py', None, 'ci-mip-output'),))
        suite, class_name, unit = profile['suites'][0]
        # Planned at the budget CI will actually request for this suite.
        plan = runner.module_plan('tests/'+suite, unit, 'live', profile['suite_budgets'][unit], class_name)
        self.assertEqual([item['case'] for item in plan['tests']], ['VolumeMipOutputE2E.'+name for name in cases])
        self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), 3)
        # The class declares exactly these cases on the MIP Batch base; no inherited MIP Viewer, VOI Slab, MIP Job or MIP Batch case is selected.
        cls = getattr(runner.load_module(ROOT/'tests'/suite), 'VolumeMipOutputE2E')
        self.assertEqual([(base.__module__, base.__name__) for base in cls.__bases__], [('test_volume_mip_batch', 'VolumeMipBatchE2E')])
        self.assertEqual(sorted(name for name in vars(cls) if name.startswith('test')), cases)
        for name, other in ci.PROFILES.items():
            if name != 'volume-mip-output':
                self.assertNotIn(suite, [row[0] for row in other['suites']], name)
                self.assertNotIn(unit, [row[2] for row in other['suites']], name)
        print('SELECTION', suite, len(cases), flush=True)

    def test_volume_mip_orient_profile_selects_each_authored_orient_case_once(self):
        profile = ci.PROFILES['volume-mip-orient']
        cases = ['test_mip_orient_01_presets_save_restore_output',
                 'test_mip_orient_02_refusals_current_view_cancel']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_orient.py', None, 'ci-mip-orient'),))
        suite, class_name, unit = profile['suites'][0]
        # Planned at the budget CI will actually request for this suite.
        plan = runner.module_plan('tests/'+suite, unit, 'live', profile['suite_budgets'][unit], class_name)
        self.assertEqual([item['case'] for item in plan['tests']], ['VolumeMipOrientE2E.'+name for name in cases])
        self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), 2)
        # The class declares exactly these cases on the MIP output base; no inherited MIP Viewer, VOI Slab, MIP Job, MIP Batch or
        # MIP output case is selected.
        cls = getattr(runner.load_module(ROOT/'tests'/suite), 'VolumeMipOrientE2E')
        self.assertEqual([(base.__module__, base.__name__) for base in cls.__bases__], [('test_volume_mip_output', 'VolumeMipOutputE2E')])
        self.assertEqual(sorted(name for name in vars(cls) if name.startswith('test')), cases)
        for name, other in ci.PROFILES.items():
            if name != 'volume-mip-orient':
                self.assertNotIn(suite, [row[0] for row in other['suites']], name)
                self.assertNotIn(unit, [row[2] for row in other['suites']], name)
        print('SELECTION', suite, len(cases), flush=True)
    def test_gateway_e2e_profile_selects_five_declared_cases(self):
        # S4-EG1: exactly the five fixed methods of the one local class, in their declared order; no other profile or
        # unit selects this module. Importing it needs only the stdlib live stack (fixture and agent imports are
        # method-local), so this case also runs in the dispatch workflow's browser-free interpreter.
        profile = ci.PROFILES['gateway-e2e']
        cases = ['test_eg1_1_normal_transfer_and_late_delta', 'test_eg1_2_multibatch_outage_restart_resume',
                 'test_eg1_3_storage_stall_crash_restart_now_retry', 'test_eg1_4_oversized_f01_boundary_bounded_repeat',
                 'test_eg1_5_cross_study_convergence_and_negative_controls']
        self.assertEqual(profile['suites'], (('gateway_pipeline_live.py', 'GatewayPipelineLive', 'ci-eg1-gateway'),))
        suite, class_name, unit = profile['suites'][0]
        plan = runner.module_plan('tests/'+suite, unit, 'live', profile['suite_timeout'], class_name)
        self.assertEqual([item['case'] for item in plan['tests']], [class_name+'.'+name for name in cases])
        self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), 5)
        cls = getattr(runner.load_module(ROOT/'tests'/suite), class_name)
        self.assertEqual(cls.__bases__, (unittest.TestCase,))
        self.assertEqual([name for name in vars(cls) if name.startswith('test')], cases)
        for name, other in ci.PROFILES.items():
            if name != 'gateway-e2e':
                self.assertNotIn(suite, [row[0] for row in other['suites']], name)
                self.assertNotIn(unit, [row[2] for row in other['suites']], name)
        print('SELECTION', suite, len(cases), flush=True)

    def test_source_pdf_profile_selects_four_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['dicom-pdf']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        self.assertEqual({row['case'] for row in plan['tests']},
            {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_pdf_')})
        self.assertEqual(len(plan['tests']),4)
        self.assertEqual(runner.collect(plan).countTestCases(),4)

    def test_image_thumbnails_profile_selects_four_declared_native_cases(self):
        filename,class_name,unit=ci.PROFILES['image-thumbnails']['suites'][0]
        plan=runner.module_plan('tests/'+filename,unit,'live',900,class_name)
        cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
        self.assertEqual({row['case'] for row in plan['tests']},
            {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_image_thumbnails_')})
        self.assertEqual(len(plan['tests']),4)
        self.assertEqual(runner.collect(plan).countTestCases(),4)

    def test_candidate_contract_remains_89_then_15(self):
        # 69 -> 71: R15 added two live structured-entry cases (L-1, L-2). 71 -> 79: S3-ASR-U5 added
        # the eight dictation refusal cases T1-T8. 79 -> 80: S4-U2 added the one live order
        # reconciliation case. 80 -> 81: S4-U3 added the one live gateway receipt route case. 81 -> 82:
        # S4-U4 added the one live gateway retry route case. 82 -> 83: S4-U5 added the one live study
        # identity case. 83 -> 89: S7-U1a added the six live critical result cases
        # (CriticalResultInvariantTests). The worklist contract is untouched at 15,
        # and neither number may move without the test that moved it.
        for filename, count in [('tests/invariants_live.py', 89), ('tests/e2e/test_worklist.py', 15)]:
            plan = runner.module_plan(filename, 'selection-check', 'live', 600)
            self.assertEqual(runner.collect(plan).countTestCases(), count)
        # The eight U5 cases are selected by name, in the classes the pure oracle judges them in.
        import dictation_refusal_oracle as oracle
        plan = runner.module_plan('tests/invariants_live.py', 'selection-check', 'live', 600)
        selected = sorted(row['case'] for row in plan['tests'] if '.test_dictation_u5_' in row['case'])
        self.assertEqual(selected, sorted([
            'LiveInvariantTests.test_dictation_u5_01_role_guard_and_parser_order',
            'LiveInvariantTests.test_dictation_u5_02_input_refusals_after_the_gate',
            'LiveInvariantTests.test_dictation_u5_03_hold_refuses_other_actor_and_is_untouched',
            'LiveInvariantTests.test_dictation_u5_04_preliminary_third_party_refused',
            'LiveInvariantTests.test_dictation_u5_05_filming_non_emergency_refused',
            'LiveInvariantTests.test_dictation_u5_06_institution_follows_tele_visibility',
            'BffInvariantTests.test_dictation_u5_07_cookie_session_csrf',
            'LiveInvariantTests.test_dictation_u5_08_approved_report_parity']))
        self.assertEqual(selected, sorted(cls + '.' + name for cls, name in oracle.TESTS.values()))

    def test_dictation_live_suite_selection_and_declared_interception(self):
        # S3-ASR-U4L (readiness §7): one live suite appended last to the measurements profile, exactly its two
        # own cases, and a static pin on everything it may launch, intercept, inject or send. The runtime facts
        # (the real 503, the audit row, delivered headers, geometry) stay hosted observations; this pins only
        # the surface they are observed through.
        import re
        suite, class_name, unit = 'e2e/test_dictation_live.py', 'DictationLiveE2E', 'ci-test-dictation-live'
        cases = ['test_dictation_live_01_path_real_api_not_configured',
                 'test_dictation_live_02_geometry_recording_failed_review']
        measurements = ci.PROFILES['measurements']
        self.assertEqual(measurements['suites'][-1], (suite, class_name, unit))
        for name, profile in ci.PROFILES.items():
            rows = profile['suites'][:-1] if name == 'measurements' else profile['suites']
            self.assertNotIn(suite, [row[0] for row in rows], name)
            self.assertNotIn(unit, [row[2] for row in rows], name)
        plan = runner.module_plan('tests/'+suite, unit, 'live', 540, class_name)
        self.assertEqual([item['case'] for item in plan['tests']], [class_name+'.'+name for name in cases])
        self.assertTrue(all(item['file'] == 'tests/'+suite for item in plan['tests']))
        self.assertEqual(runner.collect(plan).countTestCases(), 2)
        module = runner.load_module(ROOT/'tests'/suite)
        cls = getattr(module, class_name)
        self.assertEqual([(base.__module__, base.__name__) for base in cls.__bases__], [('test_worklist', 'WorklistE2E')])
        self.assertEqual(cls.browser_channel, 'chromium')
        self.assertEqual([name for name in vars(cls) if name.startswith('test')], cases)
        source = (ROOT/'tests'/suite).read_text(encoding='utf-8')
        tree = ast.parse(source)
        functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
        named = lambda attr: [call for call in calls if call.func.attr == attr]
        inside = lambda function, call: any(node is call for node in ast.walk(functions[function]))
        # The base is imported under its own name and the class names it that way (review N-8).
        self.assertEqual([(alias.name, alias.asname) for node in ast.walk(tree) if isinstance(node, ast.Import)
                          for alias in node.names if alias.name == 'test_worklist'], [('test_worklist', None)])
        self.assertFalse([node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module == 'test_worklist'])
        klass = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
        self.assertEqual([ast.unparse(base) for base in klass.bases], ['test_worklist.WorklistE2E'])
        # The entry point filters by __dict__, so inherited worklist cases never run (review N-4).
        entry = next(node for node in tree.body if isinstance(node, ast.If) and '__name__' in ast.unparse(node.test))
        self.assertIn(class_name+'.__dict__', ast.unparse(entry))
        # One launch: the full pinned Chromium with exactly the imported U4b arguments (D1, review N-5), plus the
        # two accepted NetLog switches and nothing else (Astra decision 2026-09-23 on the P10 instrument).
        launches = named('launch')
        self.assertEqual(len(launches), 1)
        keywords = {keyword.arg: keyword.value for keyword in launches[0].keywords}
        self.assertEqual((launches[0].args, set(keywords)), ([], {'channel', 'headless', 'args'}))
        self.assertEqual(ast.literal_eval(keywords['channel']), 'chromium')
        self.assertIs(ast.literal_eval(keywords['headless']), True)
        self.assertEqual(ast.unparse(keywords['args'].func) if isinstance(keywords['args'], ast.Call) else None, 'u4l_launch_args')
        from pathlib import PurePosixPath
        self.assertEqual(module.u4l_launch_args(PurePosixPath('/f.wav'), PurePosixPath('/n/netlog.json')),
                         module.launch_args(PurePosixPath('/f.wav')) + ['--log-net-log=/n/netlog.json', '--net-log-duration=120'])
        # F5: the capture window and the completion deadline are the accepted ones and are never shortened.
        self.assertEqual((module.NETLOG_SECONDS, module.NETLOG_DEADLINE_SECONDS, module.NETLOG_WINDOW_SECONDS), (120, 140, 115))
        self.assertEqual(len(module.FORBIDDEN_LAUNCH_FLAGS), 3)
        for flag in module.FORBIDDEN_LAUNCH_FLAGS:
            self.assertNotIn(flag, source)
        # F1: one module-level tuple names the three forbidden NetLog switches, and each literal occurs exactly once
        # in the suite - as that tuple's own constant - so no other code or text can pass one to the browser.
        netlog_forbidden = ('--net-log-capture-mode', '--net-log-max-size-mb', '--ssl-key-log-file')
        tuples = [node for node in tree.body if isinstance(node, ast.Assign)
                  and [ast.unparse(target) for target in node.targets] == ['NETLOG_FORBIDDEN_FLAGS']]
        self.assertEqual(len(tuples), 1)
        self.assertEqual(ast.literal_eval(tuples[0].value), netlog_forbidden)
        self.assertEqual(module.NETLOG_FORBIDDEN_FLAGS, netlog_forbidden)
        owned = {id(node) for node in ast.walk(tuples[0].value)}
        for flag in netlog_forbidden:
            holders = [node for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)
                       and flag in node.value]
            self.assertEqual([id(node) in owned for node in holders], [True], flag)
            self.assertEqual(source.count(flag), 1, flag)
        # The capture modes that keep credentials or bytes, and the TLS key log variable, are never written whole.
        for token in ('IncludeSensitive', 'Everything', 'HeavilyRedacted', 'SSLKEYLOGFILE'):
            self.assertNotIn(token, source)
        # The raw log: read only in wait_netlog (the other read_bytes hashes ARTIFACTS for the manifest), never
        # copied or moved, removed only by remove_netlog; judged last in test 01, before its U4L-PATH line.
        reads = named('read_bytes')
        self.assertEqual(sorted(name for call in reads for name in ('wait_netlog', 'finalize_artifacts') if inside(name, call)),
                         ['finalize_artifacts', 'wait_netlog'])
        self.assertEqual(len(reads), 2)
        for attr in ('copy', 'copy2', 'copyfile', 'copyfileobj', 'copytree', 'move', 'rename', 'link_to', 'hardlink_to',
                     'symlink_to'):
            self.assertEqual(named(attr), [], attr)
        self.assertEqual([inside('remove_netlog', call) for call in named('rmtree')], [True])
        steps = named('netlog_p10_step')
        emits = [node for node in ast.walk(functions['path_finish']) if isinstance(node, ast.Call)
                 and ast.unparse(node.func) == 'emit']
        self.assertEqual([inside('path_finish', call) for call in steps], [True])
        self.assertLess(steps[0].lineno, emits[0].lineno)
        self.assertEqual(source.count("'p10-netlog.json'"), 1)
        # Two routes: the bootstrap path predicate while every context is prepared, and the review answer
        # inside the geometry case only. Nothing continues, falls back, unroutes, replays or adds page code.
        routes = named('route')
        prepared = [call for call in routes if inside('prepare_context', call)]
        review = [call for call in routes if inside(cases[1], call)]
        self.assertEqual((len(routes), len(prepared), len(review)), (2, 1, 1))
        self.assertEqual(ast.unparse(prepared[0].args[0]), 'bootstrap_request')
        compares = [node for node in ast.walk(functions['bootstrap_request']) if isinstance(node, ast.Compare)]
        self.assertEqual(len(compares), 1)
        self.assertIsInstance(compares[0].ops[0], ast.Eq)
        self.assertTrue(ast.unparse(compares[0].left).endswith('.path'))
        self.assertEqual([ast.literal_eval(node) for node in compares[0].comparators], ['/api/bootstrap'])
        predicate = review[0].args[0]
        self.assertIsInstance(predicate, ast.Lambda)
        self.assertEqual(ast.unparse(predicate.body).split(' == '), ['urlsplit(url).path', 'dictation_path'])
        for attr in ('route_from_har', 'unroute', 'unroute_all', 'continue_', 'fallback', 'set_extra_http_headers',
                     'expose_function', 'expose_binding', 'add_script_tag', 'wait_for_function', 'evaluate_handle'):
            self.assertEqual(named(attr), [], attr)
        inits = named('add_init_script')
        self.assertEqual(len(inits), 1)
        self.assertEqual((inits[0].args, [(keyword.arg, ast.unparse(keyword.value)) for keyword in inits[0].keywords]),
                         ([], [('script', 'OBSERVER')]))
        # One CDP session, Log domain only (D2), detached on cleanup.
        self.assertEqual((len(named('new_cdp_session')), named('new_browser_cdp_session')), (1, []))
        self.assertEqual(sorted(ast.literal_eval(call.args[0]) for call in named('send')), ['Log.disable', 'Log.enable'])
        self.assertEqual({node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)
                          and re.fullmatch(r'[A-Z][A-Za-z]+\.[a-z][A-Za-z]+', node.value)},
                         {'Log.enable', 'Log.disable', 'Log.entryAdded'})
        self.assertTrue(named('detach'))
        # Page code: every evaluate is a PROBES entry, and no probe reaches a product mutator.
        evaluates = named('evaluate')
        self.assertTrue(evaluates)
        for call in evaluates:
            self.assertTrue(isinstance(call.args[0], ast.Subscript) and ast.unparse(call.args[0].value) == 'PROBES',
                            ast.unparse(call))
        for name, probe in module.PROBES.items():
            for token in ('setServerCapability', '.start(', '.stop(', '.insert(', '.cancel(', '.close(', 'refresh(',
                          'load(', 'stash(', 'put(', 'updateReportButtons', 'appState'):
                self.assertNotIn(token, probe, name)
        # The one scrolling probe (Astra B2 amendment, CI2 G3): confined, restoring, once in review.
        self.assertEqual(dictation_toggle_reach_pins(source, module.PROBES), [])
        # Helpers come only from the reviewed U4b list, the version pin included (review N-2).
        imported = [alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                    and node.module == 'report_dictation_capture_dom_test' for alias in node.names]
        self.assertTrue(imported)
        self.assertLessEqual(set(imported), {'OBSERVER', 'launch_args', 'parse_launch', 'launch_problems', 'CHANNEL',
                                             'FULL_CHROMIUM_SUFFIX', 'FORBIDDEN_LAUNCH_FLAGS', 'log_entry',
                                             'csp_log_verdict', 'UNCHANGED', 'BROWSER_VERSION'})
        self.assertFalse([alias for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names
                          if alias.name == 'report_dictation_capture_dom_test'])
        # The suite's own oracles reject every failure shape they exist to catch.
        self.assertEqual(module.oracle_self_check(), [])

    def test_hanging_protocol_profile_runs_exact_shared_and_new_cases(self):
        profile=ci.PROFILES['hanging-protocols']
        # The required sequence: the shared invariants and worklist boundaries run
        # before the API change they protect, and the native flow runs last.
        self.assertEqual([row[0] for row in profile['suites']],
            ['invariants_live.py','e2e/test_worklist.py',
             'hanging_protocol_api_live.py','e2e/test_hanging_protocol.py'])
        for index,(filename,class_name,unit) in enumerate(profile['suites']):
            # Each suite is planned at the budget CI will actually request for it,
            # not at a uniform profile maximum.
            timeout=profile['suite_budgets'][unit]
            plan=runner.module_plan('tests/'+filename,unit,'live',timeout,class_name)
            self.assertEqual(runner.collect(plan).countTestCases(),len(plan['tests']))
            self.assertTrue(all(item['file']=='tests/'+filename for item in plan['tests']))
            if index<2:self.assertEqual(len(plan['tests']),[89,15][index])
            if class_name:
                self.assertTrue(all(row['case'].startswith(class_name+'.')
                                    for row in plan['tests']))
            if class_name=='HangingProtocolApiLive':
                cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
                self.assertEqual({row['case'] for row in plan['tests']},
                    {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_')})
                self.assertTrue(plan['tests'])
            if class_name=='HangingProtocolE2E':
                cls=getattr(runner.load_module(ROOT/'tests'/filename),class_name)
                self.assertEqual({row['case'] for row in plan['tests']},
                    {class_name+'.'+name for name in cls.__dict__ if name.startswith('test_hp_')})
                # test_hp_05 added the reconstructed-cell flow, test_hp_06 the published
                # institution flow, test_hp_07 the mixed plane+frame Job flow and test_hp_08
                # the merged cell layout Job flow to the same declared selection, so the exact
                # declared count is now 8. This stays an equality: a floor would let a case
                # silently disappear as long as seven remained, which is the regression this
                # guard exists to catch.
                self.assertEqual(len(plan['tests']),8)
            print('SELECTION',filename,len(plan['tests']),flush=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
