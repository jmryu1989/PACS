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

    def test_candidate_contract_remains_69_then_14(self):
        for filename, count in [('tests/invariants_live.py', 69), ('tests/e2e/test_worklist.py', 14)]:
            plan = runner.module_plan(filename, 'selection-check', 'live', 600)
            self.assertEqual(runner.collect(plan).countTestCases(), count)

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
            if index<2:self.assertEqual(len(plan['tests']),[69,14][index])
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
