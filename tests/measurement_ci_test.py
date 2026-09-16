"""D-MEASURE2 B1: runner refusal and public artifact secret redaction."""
import os, tempfile, unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
import measurement_ci as ci


class MeasurementCiTests(unittest.TestCase):
    def test_image_text_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['image-text']
        self.assertEqual(profile['suites'],(('e2e/test_viewer_image_text.py','ViewerImageTextE2E','ci-image-text'),))
        self.assertEqual(profile['out'].name,'image-text-ci')
        self.assertEqual(profile['project_prefix'],'kin-image-text-ci-')
        self.assertEqual(profile['suite_timeout'],900)

    def test_images_only_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['images-only']
        self.assertEqual(profile['suites'],(('e2e/test_viewer_images_only.py','ViewerImagesOnlyE2E','ci-images-only'),))
        self.assertEqual(profile['out'].name,'images-only-ci')
        self.assertEqual(profile['project_prefix'],'kin-images-only-ci-')
        self.assertEqual(profile['suite_timeout'],900)

    def test_study_arrivals_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['study-arrivals']
        self.assertEqual(profile['suites'],(('e2e/test_study_arrivals.py','StudyArrivalsE2E','ci-study-arrivals'),))
        self.assertEqual(profile['out'].name,'study-arrivals-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_display_scope_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['display-scope']
        self.assertEqual(profile['suites'],(('e2e/test_viewer_display_scope.py','ViewerDisplayScopeE2E','ci-display-scope'),))
        self.assertEqual(profile['out'].name,'display-scope-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_cell_merge_profile_is_exact_and_separate(self):
        profile = ci.PROFILES['cell-merge']
        self.assertEqual(profile['suites'], (('e2e/test_viewer_cell_merge.py', 'ViewerCellMergeE2E', 'ci-cell-merge'),))
        self.assertEqual(profile['out'].name, 'cell-merge-ci')
        self.assertEqual(profile['project_prefix'], 'kin-cell-merge-ci-')
        self.assertEqual(profile['suite_timeout'], 900)
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_viewer_cell_merge.py')
        self.assertEqual(command[command.index('--class')+1], 'ViewerCellMergeE2E')
        self.assertEqual(command[command.index('--timeout')+1], '900')
        self.assertEqual(outer, 935)
        for name, other in ci.PROFILES.items():
            if name == 'cell-merge':
                continue
            with self.subTest(profile=name):
                self.assertNotEqual(profile['out'], other['out'])
                self.assertNotEqual(profile['project_prefix'], other['project_prefix'])

    def test_validate_workflow_runs_cell_merge_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  cell-merge:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one cell-merge job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile cell-merge',
                         'tests/execution_selection_test.py',
                         'tests/e2e/artifacts/cell-merge-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        # One standing gate, one live step bound like every other e2e job, and no
        # duplicate dispatch entry for the same suite.
        self.assertEqual(text.count('--profile cell-merge'), 1)
        self.assertNotIn('--profile cell-merge', jobs[0])
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        for profile in ['measurements', 'volume-rendering', 'volume-mpr', 'volume-slab', 'hanging-protocols']:
            self.assertEqual(text.count('--profile '+profile), 1)
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertNotIn('- cell-merge', dispatch)

    def test_image_thumbnails_profile_is_exact_and_separate(self):
        profile=ci.PROFILES['image-thumbnails']
        self.assertEqual(profile['suites'],(('e2e/test_image_thumbnails.py','ImageThumbnailsE2E','ci-image-thumbnails'),))
        self.assertEqual(profile['out'].name,'image-thumbnails-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_source_pdf_profile_is_exact_and_has_separate_evidence(self):
        profile=ci.PROFILES['dicom-pdf']
        self.assertEqual(profile['suites'],(('e2e/test_dicom_pdf.py','DicomPdfE2E','ci-source-pdf'),))
        self.assertEqual(profile['out'].name,'dicom-pdf-ci')
        self.assertEqual(profile['suite_timeout'],900)

    def test_hanging_protocol_flow_preserves_shared_boundary_sequence(self):
        profile = ci.PROFILES['hanging-protocols']
        self.assertEqual(profile['suites'], (
            ('invariants_live.py', None, 'ci-hp-invariants'),
            ('e2e/test_worklist.py', None, 'ci-hp-worklist'),
            ('hanging_protocol_api_live.py', 'HangingProtocolApiLive', 'ci-hp-account'),
            ('e2e/test_hanging_protocol.py', 'HangingProtocolE2E', 'ci-hp-native'),
        ))
        self.assertEqual(profile['out'].name, 'hanging-protocols-ci')
        self.assertEqual(profile['suite_timeout'], 400)

    def test_hanging_protocol_budget_cannot_starve_the_trailing_flows(self):
        profile = ci.PROFILES['hanging-protocols']
        budgets = profile['suite_budgets']
        units = [unit for _, _, unit in profile['suites']]
        # Every suite is budgeted, and nothing is budgeted that is not a suite.
        self.assertEqual(sorted(budgets), sorted(units))
        self.assertEqual(budgets, {'ci-hp-invariants': 400, 'ci-hp-worklist': 240,
                                   'ci-hp-account': 120, 'ci-hp-native': 300})
        # No budget may exceed the profile's own declared maximum, and none of them
        # may raise the 900 this profile used to request.
        self.assertLessEqual(max(budgets.values()), profile['suite_timeout'])
        self.assertTrue(all(value < 900 for value in budgets.values()))
        # Unlike every other profile, this one's ENTIRE configured worst case fits
        # main()'s single deadline, with room left for the stack it shares.
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        worst_case = sum(budgets.values()) + 35*len(units)
        self.assertEqual(worst_case, 1200)
        # Measured on run 34703534031: 60.6s setup and 12.8s cleanup through this
        # same main() path. The reserve left over is 3.8x that.
        self.assertGreaterEqual(25*60 - worst_case, 4*74)
        # The required order is 69 -> 14 -> API -> e2e, so the new flow runs last;
        # even if everything ahead of it burns its whole budget and the stack takes
        # four times its measured time, the trailing suite keeps its full slice.
        ahead = sum(budgets[unit] + 35 for unit in units[:-1])
        self.assertEqual(units[-1], 'ci-hp-native')
        self.assertGreaterEqual(25*60 - ahead - 4*74, budgets['ci-hp-native'])

    def test_hanging_protocol_commands_are_exact_ordered_and_separately_capped(self):
        profile = ci.PROFILES['hanging-protocols']
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            self.assertEqual(command[command.index('--timeout')+1],
                             str(profile['suite_budgets'][unit]))
            self.assertEqual(outer, profile['suite_budgets'][unit] + 35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/invariants_live.py', 'tests/e2e/test_worklist.py',
                          'tests/hanging_protocol_api_live.py',
                          'tests/e2e/test_hanging_protocol.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-hp-invariants', 'ci-hp-worklist',
                          'ci-hp-account', 'ci-hp-native'])
        # The two shared boundary suites keep their own load_tests as the allowlist;
        # the two hanging-protocol suites stay pinned to their declared classes.
        self.assertNotIn('--class', commands[0])
        self.assertNotIn('--class', commands[1])
        self.assertEqual(commands[2][commands[2].index('--class')+1], 'HangingProtocolApiLive')
        self.assertEqual(commands[3][commands[3].index('--class')+1], 'HangingProtocolE2E')
        # A shrinking deadline shortens the request instead of overrunning it.
        near, _ = ci.guarded_profile_run(profile, *profile['suites'][3], 200)
        self.assertEqual(near[near.index('--timeout')+1], '165')
        # A separate Compose project and artifact directory from every other profile.
        for name, other in ci.PROFILES.items():
            if name == 'hanging-protocols':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('hanging-protocols', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_per_suite_budgets_leave_every_other_profile_unchanged(self):
        # The mapping is opt-in: a profile without it keeps requesting its own
        # maximum for every suite, exactly as before.
        # volume-mpr opted in when the curved MPR suite joined its runner; its exact
        # budgets are asserted in test_volume_mpr_profile_is_exact_bounded_and_isolated.
        # volume-slab opted in as the second MPR suite group; see its own exact test.
        for name, profile in ci.PROFILES.items():
            if name in ('hanging-protocols', 'volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch', 'volume-mip-output', 'volume-mip-orient'):
                self.assertIn('suite_budgets', profile)
                continue
            with self.subTest(profile=name):
                self.assertNotIn('suite_budgets', profile)
                for suite, class_name, unit in profile['suites']:
                    command, outer = ci.guarded_profile_run(
                        profile, suite, class_name, unit, 4000)
                    self.assertEqual(command[command.index('--timeout')+1],
                                     str(profile['suite_timeout']))
                    self.assertEqual(outer, profile['suite_timeout'] + 35)

    def test_validate_workflow_runs_hanging_protocols_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  hanging-protocols:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one hanging-protocols job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile hanging-protocols',
                         'tests/execution_selection_test.py',
                         'tests/e2e/artifacts/hanging-protocols-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        # The HP suites must not be appended to another job's budget, and the live
        # step keeps the same 28-minute bound as the existing e2e jobs.
        self.assertEqual(text.count('--profile hanging-protocols'), 1)
        self.assertNotIn('--profile hanging-protocols', jobs[0])
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        # Registering this standing gate must not disturb the gates already green.
        for profile in ['measurements', 'volume-rendering', 'volume-mpr', 'volume-slab']:
            self.assertEqual(text.count('--profile '+profile), 1)
        # The manual dispatch path for this profile stays available as well.
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertIn('- hanging-protocols', dispatch)
        self.assertIn('tests/e2e/artifacts/hanging-protocols-ci/', dispatch)

    def test_three_d_cursor_accuracy_profile_is_exact_and_dispatch_only(self):
        import ast
        profile = ci.PROFILES['three-d-cursor-accuracy']
        self.assertEqual(profile['suites'], (('e2e/test_three_d_cursor_accuracy.py',
                         'ThreeDCursorAccuracyE2E', 'ci-three-d-cursor-accuracy'),))
        self.assertEqual(profile['out'].name, 'three-d-cursor-accuracy-ci')
        self.assertEqual(profile['project_prefix'], 'kin-3d-cursor-acc-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_three_d_cursor_accuracy.py')
        self.assertEqual(command[command.index('--class')+1], 'ThreeDCursorAccuracyE2E')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        tree = ast.parse((ci.ROOT/'tests/e2e/test_three_d_cursor_accuracy.py').read_text(encoding='utf-8'))
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                   and node.name == 'ThreeDCursorAccuracyE2E')
        declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                    and node.name.startswith('test_')]
        self.assertEqual(len(declared), 3)
        self.assertTrue(all(name.startswith('test_cursor_accuracy_') for name in declared))
        # No push gate: the profile reaches CI only through the manual dispatch workflow.
        validate = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        self.assertNotIn('three-d-cursor-accuracy', validate)
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertIn('- three-d-cursor-accuracy', dispatch)
        self.assertIn('tests/e2e/artifacts/three-d-cursor-accuracy-ci/', dispatch)
        self.assertIn('tests/e2e/artifacts/THREE-D-CURSOR-ACCURACY-*.png', dispatch)

    def test_three_d_cursor_wiring_profile_is_exact_and_dispatch_only(self):
        import ast
        profile = ci.PROFILES['three-d-cursor-wiring']
        self.assertEqual(profile['suites'], (('e2e/test_three_d_cursor_wiring.py',
                         'ThreeDCursorWiringE2E', 'ci-three-d-cursor-wiring'),))
        self.assertEqual(profile['out'].name, 'three-d-cursor-wiring-ci')
        self.assertEqual(profile['project_prefix'], 'kin-3d-cursor-wire-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        # A separate profile, a separate Compose project and a separate artifact directory: the
        # accuracy run and the wiring run never share one.
        accuracy = ci.PROFILES['three-d-cursor-accuracy']
        self.assertNotEqual(profile['out'], accuracy['out'])
        self.assertNotEqual(profile['project_prefix'], accuracy['project_prefix'])
        command, outer = ci.guarded_profile_run(profile, *profile['suites'][0], 2000)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_three_d_cursor_wiring.py')
        self.assertEqual(command[command.index('--class')+1], 'ThreeDCursorWiringE2E')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        source = (ci.ROOT/'tests/e2e/test_three_d_cursor_wiring.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                   and node.name == 'ThreeDCursorWiringE2E')
        declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                    and node.name.startswith('test_')]
        self.assertEqual(len(declared), 3)
        self.assertTrue(all(name.startswith('test_wiring_') for name in declared))
        # The point of the suite: the modules must arrive through config/ohif.js, so the harness's
        # own injection call may not appear in it.
        self.assertNotIn('.add_script_tag(', source)
        # No push gate: the profile reaches CI only through the manual dispatch workflow.
        validate = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        self.assertNotIn('three-d-cursor-wiring', validate)
        dispatch = (ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        self.assertIn('- three-d-cursor-wiring', dispatch)
        self.assertIn('tests/e2e/artifacts/three-d-cursor-wiring-ci/', dispatch)
        self.assertIn('tests/e2e/artifacts/THREE-D-CURSOR-WIRING-*.png', dispatch)

    def test_profiles_are_exact_and_use_separate_owned_artifacts(self):
        self.assertEqual(set(ci.PROFILES),
                         {'measurements', 'volume-rendering', 'output-integration',
                          'identity-fields', 'vr-resize-probe', 'hanging-protocols', 'dicom-pdf', 'image-thumbnails', 'display-scope', 'study-arrivals', 'images-only', 'image-text',
                          'three-d-cursor-accuracy', 'three-d-cursor-wiring', 'volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch', 'volume-mip-output', 'volume-mip-orient', 'cell-merge'})
        measurements = ci.PROFILES['measurements']
        volume = ci.PROFILES['volume-rendering']
        output = ci.PROFILES['output-integration']
        identity = ci.PROFILES['identity-fields']
        self.assertEqual([row[:2] for row in measurements['suites']],
                         list(zip(ci.SUITES, ci.SUITE_CLASSES)))
        self.assertEqual(volume['suites'], (('e2e/test_volume_rendering.py',
                         None, 'ci-volume-rendering'),))
        self.assertEqual(output['suites'], (
            ('e2e/test_compare_reports.py', 'CompareReportsE2E',
             'ci-output-compare-reports'),
            ('e2e/test_viewer_job_report.py', 'ViewerJobReportE2E',
             'ci-output-viewer-job-report'),
            ('e2e/test_editor_compare_output.py', 'EditorCompareOutputE2E',
             'ci-output-editor-compare-output'),
        ))
        self.assertEqual(output['suite_timeout'], 900)
        self.assertEqual(identity['suites'], (
            ('reading_appearance_live.py', 'ReadingAppearanceLive',
             'ci-identity-reading-appearance'),
            ('reading_appearance_position_live.py', 'ReadingAppearancePositionLive',
             'ci-identity-reading-position'),
            ('reading_appearance_fields_live.py', 'ReadingAppearanceFieldsLive',
             'ci-identity-reading-fields'),
            ('e2e/test_viewer_identity_position.py', 'ViewerIdentityPositionE2E',
             'ci-identity-viewer-position'),
            ('e2e/test_viewer_identity_fields.py', 'ViewerIdentityFieldsE2E',
             'ci-identity-viewer-fields'),
        ))
        self.assertEqual(identity['suite_timeout'], 540)
        self.assertEqual(len({measurements['out'], volume['out'], output['out'],
                              identity['out']}), 4)
        self.assertEqual(volume['out'].name, 'volume-rendering-ci')
        self.assertEqual(output['out'].name, 'output-integration-ci')
        self.assertEqual(identity['out'].name, 'identity-fields-ci')
        hostile={key:'https://outside.invalid' for key in ['KIN_TEST_PROXY','KIN_TEST_API',
                 'KIN_TEST_TOKEN_URL','KIN_TEST_ORTHANC','KIN_TEST_ORTHANC_USER',
                 'KIN_TEST_ORTHANC_PASSWORD']}
        with patch.dict(os.environ, {**hostile, 'KIN_EVIDENCE_DIR':'caller-value'}, clear=False):
            values={'ORTHANC_PASS':'generated-orthanc-password'}
            stage=Path('private-stage')
            measurement_env=ci.profile_environment('measurements', measurements['out'], values)
            self.assertNotIn('KIN_EVIDENCE_DIR', measurement_env)
            volume_env=ci.profile_environment('volume-rendering', volume['out'], values, stage)
            self.assertEqual(volume_env
                             ['KIN_EVIDENCE_DIR'], str(stage))
            output_env=ci.profile_environment('output-integration', output['out'], values)
            self.assertNotIn('KIN_EVIDENCE_DIR', output_env)
            identity_env=ci.profile_environment('identity-fields', identity['out'], values)
            self.assertNotIn('KIN_EVIDENCE_DIR', identity_env)
            expected={
                'KIN_TEST_PROXY':'https://localhost:9443',
                'KIN_TEST_API':'https://localhost:9443/api',
                'KIN_TEST_TOKEN_URL':'http://127.0.0.1:8080/auth/realms/kin/protocol/openid-connect/token',
                'KIN_TEST_ORTHANC':'http://127.0.0.1:8042',
                'KIN_TEST_ORTHANC_USER':'admin',
                'KIN_TEST_ORTHANC_PASSWORD':'generated-orthanc-password'}
            self.assertEqual({key:measurement_env[key] for key in hostile}, expected)
            self.assertEqual({key:volume_env[key] for key in hostile}, expected)
            self.assertEqual({key:output_env[key] for key in hostile}, expected)
            self.assertEqual({key:identity_env[key] for key in hostile}, expected)

    def test_volume_mpr_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mpr']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_crosshair.py', None, 'ci-mpr-crosshair'),
            ('e2e/test_volume_display.py', None, 'ci-mpr-display'),
            ('e2e/test_volume_curved.py', None, 'ci-mpr-curved'),
        ))
        self.assertEqual(profile['out'].name, 'volume-mpr-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mpr-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420}
        self.assertEqual(profile['suite_budgets'], budgets)
        # A separate Compose project and a separate artifact directory from every
        # other profile, so a lost isolation edit fails here rather than in CI.
        for name, other in ci.PROFILES.items():
            if name == 'volume-mpr':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_crosshair.py',
                          'tests/e2e/test_volume_display.py',
                          'tests/e2e/test_volume_curved.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-mpr-crosshair', 'ci-mpr-display', 'ci-mpr-curved'])
        # All suites share main()'s single deadline, so no one suite may be able to
        # claim it: even at full cap every suite plus its reserved margin must fit
        # with stack time left, and the cap must stay under the volume-rendering cap.
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        self.assertLess(profile['suite_timeout'],
                        ci.PROFILES['volume-rendering']['suite_timeout'])
        # A shrinking deadline shortens the request instead of overrunning it.
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mpr', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mpr_modules_declare_exact_eleven_and_twelve_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_crosshair.py', 'VolumeCrosshairE2E', 'test_crosshair_', 12),
                ('e2e/test_volume_display.py', 'VolumeDisplayE2E', 'test_mpr_display_', 12),
                ('e2e/test_volume_curved.py', 'VolumeCurvedE2E', 'test_curved_', 4)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            # The module-level load_tests filters on exactly this prefix, so a
            # renamed or re-parented case would silently drop out of CI.
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            literals = [node.value for node in ast.walk(load_tests)
                        if isinstance(node, ast.Constant) and node.value == prefix]
            self.assertTrue(literals)

    def test_validate_workflow_runs_volume_mpr_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mpr:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mpr job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        mpr = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-mpr',
                         'tests/e2e/artifacts/volume-mpr-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, mpr)
        # The MPR suites must not be appended to the volume-rendering job's budget.
        self.assertNotIn('--profile volume-mpr', jobs[0])
        self.assertEqual(text.count('--profile volume-mpr'), 1)
        self.assertEqual(text.count('--profile volume-rendering'), 1)
        # The existing pure volume model gate stays registered exactly once.
        self.assertEqual(text.count('tmp/vr-ci/pure-volume-models'), 1)

    def test_volume_slab_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-slab']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_projection.py', None, 'ci-slab-projection'),
            ('e2e/test_volume_wheel.py', None, 'ci-slab-wheel'),
            ('e2e/test_volume_average_affine.py', None, 'ci-slab-average-affine'),
            ('e2e/test_volume_mip.py', None, 'ci-slab-mip-viewer'),
        ))
        self.assertEqual(profile['out'].name, 'volume-slab-ci')
        self.assertEqual(profile['project_prefix'], 'kin-slab-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering the slab suites must not widen or cut the first MPR group.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        mpr_modules = {row[0] for row in ci.PROFILES['volume-mpr']['suites']}
        self.assertFalse(mpr_modules & {row[0] for row in profile['suites']})
        for name, other in ci.PROFILES.items():
            if name == 'volume-slab':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_projection.py',
                          'tests/e2e/test_volume_wheel.py',
                          'tests/e2e/test_volume_average_affine.py',
                          'tests/e2e/test_volume_mip.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-slab-projection', 'ci-slab-wheel', 'ci-slab-average-affine', 'ci-slab-mip-viewer'])
        # Every suite at full cap plus its reserved margin fits the shared deadline with
        # stack time left, and no cap may exceed the profile maximum.
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-slab', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_slab_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_projection.py', 'VolumeProjectionE2E', 'test_projection_', 8),
                ('e2e/test_volume_wheel.py', 'VolumeWheelE2E', 'test_wheel_', 4),
                ('e2e/test_volume_average_affine.py', 'VolumeAverageAffineE2E', 'test_average_affine_', 2),
                ('e2e/test_volume_mip.py', 'VolumeMipE2E', 'test_mip_', 6)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_slab_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-slab:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-slab job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-slab',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_projection.py',
                         '--file tests/e2e/test_volume_wheel.py',
                         '--file tests/e2e/test_volume_average_affine.py',
                         '--file tests/e2e/test_volume_mip.py',
                         'tests/e2e/artifacts/volume-slab-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-slab'), 1)
        self.assertNotIn('--profile volume-slab', jobs[0])
        # The slab suites stay out of the first MPR job's shared deadline.
        mpr = text.split('\n  volume-mpr:\n')[1].split('\n  volume-slab:\n')[0]
        self.assertNotIn('--profile volume-slab', mpr)
        self.assertEqual(text.count('--profile volume-mpr'), 1)
        # The MIP Viewer model is listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-mip.js', pure)
        self.assertEqual(pure.count('tests/volume_mip_test.cjs'), 2)
        self.assertIn('tests/volume_mip_test.cjs', pure.rsplit(' --test ', 1)[1])
        # The protected VOI Slab geometry model and its unchanged tests run in the same pure gate.
        self.assertIn('--file worklist-v0/hpacs-lite/volume-voi.js', pure)
        self.assertEqual(pure.count('tests/volume_voi_test.cjs'), 2)
        self.assertIn(' --file tests/volume_voi_test.cjs --file ', pure)
        self.assertIn('tests/volume_voi_test.cjs', pure.rsplit(' --test ', 1)[1])

    def test_volume_path_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-path']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_path.py', None, 'ci-path-native'),
            ('e2e/test_volume_orientation.py', None, 'ci-mpr-orientation'),
        ))
        self.assertEqual(profile['out'].name, 'volume-path-ci')
        self.assertEqual(profile['project_prefix'], 'kin-path-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-path-native': 420, 'ci-mpr-orientation': 300}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering the path group must not widen or cut the first two MPR groups.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name in ('volume-mpr', 'volume-slab', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-path':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_path.py', 'tests/e2e/test_volume_orientation.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-path-native', 'ci-mpr-orientation'])
        # Both suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 790)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-path', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_path_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_path.py', 'VolumePathE2E', 'test_path_', 4),
                ('e2e/test_volume_orientation.py', 'VolumeOrientationE2E', 'test_orientation_', 6)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_path_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-path:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-path job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-path',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_path_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_path.py',
                         '--file tests/e2e/test_volume_orientation.py',
                         'tests/e2e/artifacts/volume-path-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-path'), 1)
        self.assertNotIn('--profile volume-path', jobs[0])
        # The path suites stay out of the first two MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-path', text.split('\n  '+other+':\n')[1].split('\n  volume-path:\n')[0])
        # The pure path model runs in the existing pure model gate (listed and executed), and the
        # compiled server Job checks keep running in the runtime gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-path.js', pure)
        self.assertEqual(pure.count('tests/volume_path_test.cjs'), 2)
        self.assertIn('tests/viewer_volume_job_capture_test.cjs', pure.rsplit(' --test ', 1)[1])
        runtime = next(line for line in text.splitlines() if 'tmp/runtime-ci/volume-api-models' in line)
        self.assertIn('/tests/viewer_volume_job_test.cjs', runtime.rsplit(' --test ', 1)[1])

    def test_volume_batch_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-batch']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_batch.py', None, 'ci-batch-preview'),
            ('e2e/test_volume_batch_context.py', None, 'ci-batch-context'),
            ('e2e/test_volume_batch_save.py', None, 'ci-batch-save'),
            ('e2e/test_volume_batch_scout.py', None, 'ci-batch-scout'),
        ))
        self.assertEqual(profile['out'].name, 'volume-batch-ci')
        self.assertEqual(profile['project_prefix'], 'kin-batch-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-batch-preview': 240, 'ci-batch-context': 240, 'ci-batch-save': 360, 'ci-batch-scout': 240}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering the batch group must not widen or cut the other MPR groups.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        self.assertEqual(ci.PROFILES['volume-path']['suite_budgets'],
                         {'ci-path-native': 420, 'ci-mpr-orientation': 300})
        modules = {row[0] for row in profile['suites']}
        # Saved batch print is its own requirement and suite; it is not part of this group.
        self.assertNotIn('e2e/test_volume_batch_print.py', modules)
        for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-batch':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_batch.py', 'tests/e2e/test_volume_batch_context.py',
                          'tests/e2e/test_volume_batch_save.py', 'tests/e2e/test_volume_batch_scout.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-batch-preview', 'ci-batch-context', 'ci-batch-save', 'ci-batch-scout'])
        # All four suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1220)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][2], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-batch', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_batch_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_batch.py', 'VolumeBatchE2E', 'test_batch_', 6),
                ('e2e/test_volume_batch_context.py', 'VolumeBatchContextE2E', 'test_batch_context_', 5),
                ('e2e/test_volume_batch_save.py', 'VolumeBatchSaveE2E', 'test_batch_save_', 8),
                ('e2e/test_volume_batch_scout.py', 'VolumeBatchScoutE2E', 'test_scout_', 5)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_batch_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-batch:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-batch job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-batch',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_batch_binding_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_batch.py',
                         '--file tests/e2e/test_volume_batch_context.py',
                         '--file tests/e2e/test_volume_batch_save.py',
                         '--file tests/e2e/test_volume_batch_scout.py',
                         '--file worklist-v0/hpacs-lite/viewer-volume-batch.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-scout.js',
                         'tests/e2e/artifacts/volume-batch-ci/',
                         'tests/e2e/artifacts/MPR-batch-*.png',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-batch'), 1)
        self.assertNotIn('--profile volume-batch', jobs[0])
        # The batch suites stay out of the other MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab', 'volume-path'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-batch', text.split('\n  '+other+':\n')[1].split('\n  volume-batch:\n')[0])
        # The pure batch and scout models stay listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        for model in ('tests/volume_batch_test.cjs', 'tests/volume_batch_scout_test.cjs'):
            self.assertEqual(pure.count(model), 2)
            self.assertIn(model, pure.rsplit(' --test ', 1)[1])

    def test_volume_sync_preferences_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-sync-preferences']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_sync.py', None, 'ci-mpr-sync'),
            ('e2e/test_volume_preferences.py', None, 'ci-mpr-preferences'),
        ))
        self.assertEqual(profile['out'].name, 'volume-sync-preferences-ci')
        self.assertEqual(profile['project_prefix'], 'kin-syncpref-ci-')
        self.assertEqual(profile['suite_timeout'], 540)
        budgets = {'ci-mpr-sync': 420, 'ci-mpr-preferences': 480}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering this group must not widen or cut the other MPR groups.
        self.assertEqual(ci.PROFILES['volume-mpr']['suite_budgets'],
                         {'ci-mpr-crosshair': 400, 'ci-mpr-display': 400, 'ci-mpr-curved': 420})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        self.assertEqual(ci.PROFILES['volume-path']['suite_budgets'],
                         {'ci-path-native': 420, 'ci-mpr-orientation': 300})
        self.assertEqual(ci.PROFILES['volume-batch']['suite_budgets'],
                         {'ci-batch-preview': 240, 'ci-batch-context': 240, 'ci-batch-save': 360, 'ci-batch-scout': 240})
        modules = {row[0] for row in profile['suites']}
        # Manual 3D marks and MPR printing inherit these suites but are separate requirements, not this group.
        for excluded in ('e2e/test_volume_marks.py', 'e2e/test_volume_mpr_print.py', 'e2e/test_volume_current_print.py'):
            self.assertNotIn(excluded, modules)
        for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-sync-preferences':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # Stable attempt units that no other profile shares.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        # Band diagnostics would go to another profile's folder; neither module reads bands.
        for suite in modules:
            self.assertNotIn('band_pixels(', (ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_sync.py', 'tests/e2e/test_volume_preferences.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-mpr-sync', 'ci-mpr-preferences'])
        # Both suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 970)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-sync-preferences', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_sync_preferences_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_sync.py', 'VolumeSyncE2E', 'test_sync_', 16),
                ('e2e/test_volume_preferences.py', 'VolumePreferencesE2E', 'test_properties_', 18)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_sync_preferences_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-sync-preferences:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-sync-preferences job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-sync-preferences',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_preferences_layout_dom_test.py',
                         'tests/viewer_volume_sync_layout_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_sync.py',
                         '--file tests/e2e/test_volume_preferences.py',
                         '--file worklist-v0/hpacs-lite/viewer-volume-sync.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-preferences.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-progressive.js',
                         'tests/e2e/artifacts/volume-sync-preferences-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-sync-preferences'), 1)
        self.assertNotIn('--profile volume-sync-preferences', jobs[0])
        # These suites stay out of the other MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-sync-preferences', text.split('\n  '+other+':\n')[1].split('\n  volume-sync-preferences:\n')[0])
        # The pure preference model stays listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-preferences.js', pure)
        self.assertEqual(pure.count('tests/volume_preferences_test.cjs'), 2)
        self.assertIn('tests/volume_preferences_test.cjs', pure.rsplit(' --test ', 1)[1])

    def test_volume_marks_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-marks']
        self.assertEqual(profile['suites'], (
            ('e2e/test_volume_marks.py', None, 'ci-mpr-marks'),
            ('e2e/test_volume_mpr_print.py', None, 'ci-mpr-marks-print'),
        ))
        self.assertEqual(profile['out'].name, 'volume-marks-ci')
        self.assertEqual(profile['project_prefix'], 'kin-marks-ci-')
        self.assertEqual(profile['suite_timeout'], 660)
        budgets = {'ci-mpr-marks': 660, 'ci-mpr-marks-print': 420}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Registering this group must not widen or cut the other MPR groups.
        self.assertEqual(ci.PROFILES['volume-batch']['suite_budgets'],
                         {'ci-batch-preview': 240, 'ci-batch-context': 240, 'ci-batch-save': 360, 'ci-batch-scout': 240})
        self.assertEqual(ci.PROFILES['volume-sync-preferences']['suite_budgets'],
                         {'ci-mpr-sync': 420, 'ci-mpr-preferences': 480})
        modules = {row[0] for row in profile['suites']}
        # Current unsaved output inherits the saved output suite but is a separate requirement, not this group.
        self.assertNotIn('e2e/test_volume_current_print.py', modules)
        for name in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-rendering'):
            self.assertFalse(modules & {row[0] for row in ci.PROFILES[name]['suites']}, name)
        for name, other in ci.PROFILES.items():
            if name == 'volume-marks':
                continue
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # Stable attempt units that no other profile shares.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        # Band diagnostics would go to another profile's folder; neither module reads bands.
        for suite in modules:
            self.assertNotIn('band_pixels(', (ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
        commands = []
        for suite, class_name, unit in profile['suites']:
            command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 2000)
            commands.append(command)
            # No --class: each module's own load_tests stays the allowlist.
            self.assertNotIn('--class', command)
            self.assertEqual(command[command.index('--timeout')+1], str(budgets[unit]))
            self.assertEqual(outer, budgets[unit]+35)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_volume_marks.py', 'tests/e2e/test_volume_mpr_print.py'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-mpr-marks', 'ci-mpr-marks-print'])
        # Both suites at full cap plus their reserved margins fit the shared deadline with stack time left.
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1150)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][1], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-marks', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_marks_modules_declare_exact_local_cases(self):
        import ast
        for suite, class_name, prefix, count in (
                ('e2e/test_volume_marks.py', 'VolumeMarksE2E', 'test_marks_', 20),
                ('e2e/test_volume_mpr_print.py', 'VolumeMprPrintE2E', 'test_mpr_print_', 9)):
            tree = ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                       and node.name == class_name)
            # The output suite declares four of its cases by assigning batch print cases to local names.
            declared = [node.name for node in cls.body if isinstance(node, ast.FunctionDef)
                        and node.name.startswith('test_')]
            declared += [target.id for node in cls.body if isinstance(node, ast.Assign)
                         for target in node.targets if isinstance(target, ast.Name) and target.id.startswith('test_')]
            self.assertEqual(len(declared), count)
            self.assertEqual(len(set(declared)), count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))
            load_tests = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                              and node.name == 'load_tests')
            self.assertTrue([node.value for node in ast.walk(load_tests)
                             if isinstance(node, ast.Constant) and node.value == prefix])

    def test_validate_workflow_runs_volume_marks_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-marks:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-marks job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'tests/measurement_ci.py --profile volume-marks',
                         'tests/measurement_ci_test.py',
                         'tests/viewer_volume_marks_progressive_dom_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_marks.py',
                         '--file tests/e2e/test_volume_mpr_print.py',
                         '--file worklist-v0/hpacs-lite/viewer-volume-marks.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-progressive.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-job-print.js',
                         'tests/e2e/artifacts/volume-marks-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-marks'), 1)
        self.assertNotIn('--profile volume-marks', jobs[0])
        # These suites stay out of the other MPR jobs' shared deadlines.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-marks', text.split('\n  '+other+':\n')[1].split('\n  volume-marks:\n')[0])
        # The pure annotation model stays listed and executed in the existing pure model gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-marks.js', pure)
        self.assertEqual(pure.count('tests/volume_marks_test.cjs'), 2)
        self.assertIn('tests/volume_marks_test.cjs', pure.rsplit(' --test ', 1)[1])

    def test_volume_mip_voi_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-voi']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_voi.py', None, 'ci-mip-voi'),))
        self.assertEqual(profile['out'].name, 'volume-mip-voi-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipvoi-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-voi': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Splitting the VOI Slab cases out must not widen or cut the slab group they came from.
        slab = ci.PROFILES['volume-slab']
        self.assertEqual(slab['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        self.assertEqual(len(slab['suites']), 4)
        self.assertIn(('e2e/test_volume_mip.py', None, 'ci-slab-mip-viewer'), slab['suites'])
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-voi':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets ci-slab-mip-viewer's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_voi.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-voi')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        # The one suite at full cap plus its reserved margin fits the shared deadline with stack time left.
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertEqual(25*60-sum(budget+35 for budget in budgets.values()), 265)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-voi', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_voi_module_selects_the_authored_cases_without_declaring_any(self):
        import ast
        voi = ('test_mip_04_voi_slab_known_voxels_modes_orientations',
               'test_mip_05_voi_order_delay_failure_missing_tool_cancel',
               'test_mip_06_voi_original_undo_reset_scope_lifecycle')
        source = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip.py').read_text(encoding='utf-8'))
        mip = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipE2E')
        declared = [node.name for node in mip.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        # The six authored cases stay declared once on the MIP Viewer class: three MIP Viewer and three VOI Slab.
        self.assertEqual(len(declared), 6)
        self.assertEqual(len(set(declared)), 6)
        self.assertTrue(set(voi) <= set(declared))
        self.assertEqual(sorted(set(declared) - set(voi)),
                         ['test_mip_01_known_voxels_modes_orientations_and_mpr_slab_parity',
                          'test_mip_02_order_delay_failure_capability_and_busy_gates',
                          'test_mip_03_lifecycle_identity_teardown_reentry_and_high_values'])
        constant = next(node for node in source.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['VOI_SLAB_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), voi)
        # The slab allowlist excludes exactly that tuple.
        slab_loader = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('VOI_SLAB_CASES', {node.id for node in ast.walk(slab_loader) if isinstance(node, ast.Name)})
        self.assertTrue([node for node in ast.walk(slab_loader)
                         if isinstance(node, ast.Compare) and any(isinstance(op, ast.NotIn) for op in node.ops)])
        # The VOI module selects exactly that tuple on a local subclass that declares nothing.
        wrapper = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_voi.py').read_text(encoding='utf-8'))
        classes = [node for node in wrapper.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes],
                         [('VolumeMipVoiE2E', ['VolumeMipE2E'])])
        self.assertFalse([node for node in ast.walk(classes[0]) if isinstance(node, (ast.FunctionDef, ast.Assign))])
        loader = next(node for node in wrapper.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('VOI_SLAB_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))

    def test_validate_workflow_runs_volume_mip_voi_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-voi:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-voi job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip.py',
                         '--file tests/e2e/test_volume_mip_voi.py',
                         '--file worklist-v0/hpacs-lite/volume-voi.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         'tests/measurement_ci.py --profile volume-mip-voi',
                         'name: synthetic-volume-mip-voi-results',
                         'tests/e2e/artifacts/volume-mip-voi-ci/',
                         'tmp/mipvoi-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-voi'), 1)
        self.assertNotIn('--profile volume-mip-voi', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-voi-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, including the slab job these cases came from, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-voi', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-voi:\n')[0])

    def test_volume_mip_job_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-job']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_job.py', None, 'ci-mip-job'),))
        self.assertEqual(profile['out'].name, 'volume-mip-job-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipjob-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-job': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the MIP Job group must not widen or cut the VOI Slab and slab groups beside it.
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-job':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets another suite's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_job.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-job')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        self.assertIn('deadline = time.monotonic()+25*60',
                      (ci.ROOT/'tests/measurement_ci.py').read_text(encoding='utf-8'))
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-job', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_job_module_declares_exactly_the_job_cases_on_the_mip_viewer_base(self):
        import ast
        cases = ('test_mip_job_01_save_restore_roundtrip_new_browser_pixels',
                 'test_mip_job_02_save_gates_failure_unconfirmed_retry_roles_account',
                 'test_mip_job_03_restore_failure_missing_tool_cancel_stale_rollback')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_job.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipJobE2E', ['VolumeMipE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_JOB_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_JOB_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP Viewer base keeps its six authored cases; none of them is redeclared here.
        mip = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip.py').read_text(encoding='utf-8'))
        base = next(node for node in mip.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 6)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_job_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-job:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-job job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip.py',
                         '--file tests/e2e/test_volume_mip_job.py',
                         '--file worklist-v0/hpacs-lite/volume-mip-job.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         'tests/measurement_ci.py --profile volume-mip-job',
                         'name: synthetic-volume-mip-job-results',
                         'tests/e2e/artifacts/volume-mip-job-ci/',
                         'tmp/mipjob-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-job'), 1)
        self.assertNotIn('--profile volume-mip-job', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-job-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, including the VOI Slab job, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-job', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-job:\n')[0])
        # The pure Job model runs in the existing pure model gate (listed and executed), and the compiled server Job
        # checks keep running in the runtime gate.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        self.assertIn('--file worklist-v0/hpacs-lite/volume-mip-job.js', pure)
        self.assertEqual(pure.count('tests/volume_mip_job_test.cjs'), 2)
        self.assertIn('tests/volume_mip_job_test.cjs', pure.rsplit(' --test ', 1)[1])
        runtime = next(line for line in text.splitlines() if 'tmp/runtime-ci/volume-api-models' in line)
        self.assertIn('/tests/viewer_volume_job_test.cjs', runtime.rsplit(' --test ', 1)[1])

    def test_volume_mip_batch_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-batch']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_batch.py', None, 'ci-mip-batch'),))
        self.assertEqual(profile['out'].name, 'volume-mip-batch-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipbatch-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-batch': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the MIP Batch group must not widen or cut the MIP Job, VOI Slab and slab groups beside it.
        self.assertEqual(ci.PROFILES['volume-mip-job']['suite_budgets'], {'ci-mip-job': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-batch':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets another suite's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_batch.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-batch')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-batch', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_batch_module_declares_exactly_the_batch_cases_on_the_mip_job_base(self):
        import ast
        cases = ('test_mip_batch_01_rotation_voi_frames_save_restore_new_browser',
                 'test_mip_batch_02_gates_cancel_failure_order_v12_compat',
                 'test_mip_batch_03_restore_failure_missing_tool_cancel_stale_rollback')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_batch.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipBatchE2E', ['VolumeMipJobE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_BATCH_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_BATCH_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP Job base keeps its three authored cases; none of them is redeclared here.
        job = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_job.py').read_text(encoding='utf-8'))
        base = next(node for node in job.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipJobE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 3)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_batch_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-batch:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-batch job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip.py',
                         '--file tests/e2e/test_volume_mip_job.py',
                         '--file tests/e2e/test_volume_mip_batch.py',
                         '--file worklist-v0/hpacs-lite/volume-mip-job.js',
                         '--file worklist-v0/hpacs-lite/volume-mip-batch.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-orientation.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         'tests/measurement_ci.py --profile volume-mip-batch',
                         'name: synthetic-volume-mip-batch-results',
                         'tests/e2e/artifacts/volume-mip-batch-ci/',
                         'tmp/mipbatch-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-batch'), 1)
        self.assertNotIn('--profile volume-mip-batch', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-batch-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, the MIP Job group included, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-batch', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-batch:\n')[0])
        # The pure MIP Batch model runs in the existing pure model gate (listed and executed), beside the capture harness that loads it.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        for name in ('--file worklist-v0/hpacs-lite/volume-mip-batch.js', '--file tests/volume_mip_batch_test.cjs'):
            self.assertEqual(pure.count(name), 1, name)
        tested = pure.rsplit(' --test ', 1)[1].split()
        self.assertIn('tests/volume_mip_batch_test.cjs', tested)
        self.assertIn('tests/viewer_volume_job_capture_test.cjs', tested)
        runtime = next(line for line in text.splitlines() if 'tmp/runtime-ci/volume-api-models' in line)
        self.assertIn('/tests/viewer_volume_job_test.cjs', runtime.rsplit(' --test ', 1)[1])

    def test_volume_mip_output_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-output']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_output.py', None, 'ci-mip-output'),))
        self.assertEqual(profile['out'].name, 'volume-mip-output-ci')
        self.assertEqual(profile['project_prefix'], 'kin-mipout-ci-')
        self.assertEqual(profile['suite_timeout'], 1200)
        budgets = {'ci-mip-output': 1200}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the MIP output group must not widen or cut the MIP Batch, MIP Job, VOI Slab and slab groups beside it.
        self.assertEqual(ci.PROFILES['volume-mip-batch']['suite_budgets'], {'ci-mip-batch': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-job']['suite_budgets'], {'ci-mip-job': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-output':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            # A new stable attempt unit: it neither shares nor resets another suite's ledger.
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        # No --class: the module's own load_tests stays the allowlist.
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_output.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-output')
        self.assertEqual(command[command.index('--timeout')+1], '1200')
        self.assertEqual(outer, 1235)
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 1235)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))
        near_deadline, _ = ci.guarded_profile_run(profile, *profile['suites'][0], 200)
        self.assertEqual(near_deadline[near_deadline.index('--timeout')+1], '165')
        with patch.dict(os.environ, {'KIN_EVIDENCE_DIR': 'caller-value'}, clear=False):
            env = ci.profile_environment('volume-mip-output', profile['out'],
                                         {'ORTHANC_PASS': 'generated-orthanc-password'})
        self.assertNotIn('KIN_EVIDENCE_DIR', env)

    def test_volume_mip_output_module_declares_exactly_the_output_cases_on_the_mip_batch_base(self):
        import ast
        cases = ('test_mip_output_01_v12_v13_fresh_pixel_frames_pdf_identity',
                 'test_mip_output_02_readiness_delay_failure_missing_tool_cancel_no_partial_page',
                 'test_mip_output_03_source_access_order_session')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_output.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipOutputE2E', ['VolumeMipBatchE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_OUTPUT_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_OUTPUT_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP Batch base keeps its three authored cases; none of them is redeclared here.
        batch = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_batch.py').read_text(encoding='utf-8'))
        base = next(node for node in batch.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipBatchE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 3)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_output_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-output:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-output job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip_batch.py',
                         '--file tests/e2e/test_volume_mip_output.py',
                         '--file worklist-v0/hpacs-lite/volume-mip-output.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip-print.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-job-print.js',
                         '--file worklist-v0/hpacs-lite/viewer-job-print.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         '--file worklist-v0/hpacs-lite/viewer-tech-note.js',
                         'tests/measurement_ci.py --profile volume-mip-output',
                         'name: synthetic-volume-mip-output-results',
                         'tests/e2e/artifacts/volume-mip-output-ci/',
                         'tmp/mipout-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-output'), 1)
        self.assertNotIn('--profile volume-mip-output', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-output-results'), 1)
        # A job of Validate itself, on the same triggers as every other synthetic group.
        header = text.split('\njobs:\n')[0]
        self.assertTrue(header.startswith('name: Validate production image\n'))
        self.assertIn('\n  pull_request:\n', header)
        # The other MPR jobs, the MIP Batch group included, keep their own profile and do not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch'):
            self.assertEqual(text.count('--profile '+other), 1)
            self.assertNotIn('--profile volume-mip-output', text.split('\n  '+other+':\n')[1].split('\n  volume-mip-output:\n')[0])
        # The pure MIP output model runs in the existing pure model gate (listed and executed), beside the capture harness of its print entry.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        for name in ('--file worklist-v0/hpacs-lite/volume-mip-output.js', '--file tests/volume_mip_output_test.cjs'):
            self.assertEqual(pure.count(name), 1, name)
        tested = pure.rsplit(' --test ', 1)[1].split()
        self.assertIn('tests/volume_mip_output_test.cjs', tested)
        self.assertIn('tests/viewer_volume_job_capture_test.cjs', tested)

    def test_volume_mip_orient_profile_is_exact_bounded_and_isolated(self):
        profile = ci.PROFILES['volume-mip-orient']
        self.assertEqual(profile['suites'], (('e2e/test_volume_mip_orient.py', None, 'ci-mip-orient'),))
        self.assertEqual(profile['out'].name, 'volume-mip-orient-ci')
        self.assertEqual(profile['project_prefix'], 'kin-miporient-ci-')
        self.assertEqual(profile['suite_timeout'], 900)
        budgets = {'ci-mip-orient': 900}
        self.assertEqual(profile['suite_budgets'], budgets)
        # Adding the Orientation Preset group must not widen or cut the MIP output, MIP Batch, MIP Job, VOI Slab or slab groups.
        self.assertEqual(ci.PROFILES['volume-mip-output']['suite_budgets'], {'ci-mip-output': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-batch']['suite_budgets'], {'ci-mip-batch': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-job']['suite_budgets'], {'ci-mip-job': 1200})
        self.assertEqual(ci.PROFILES['volume-mip-voi']['suite_budgets'], {'ci-mip-voi': 1200})
        self.assertEqual(ci.PROFILES['volume-slab']['suite_budgets'],
                         {'ci-slab-projection': 420, 'ci-slab-wheel': 300, 'ci-slab-average-affine': 240, 'ci-slab-mip-viewer': 240})
        modules = {row[0] for row in profile['suites']}
        for name, other in ci.PROFILES.items():
            if name == 'volume-mip-orient':
                continue
            self.assertFalse(modules & {row[0] for row in other['suites']}, name)
            self.assertNotEqual(profile['out'], other['out'])
            self.assertNotEqual(profile['project_prefix'], other['project_prefix'])
            self.assertFalse(set(budgets) & {row[2] for row in other['suites']}, name)
        suite, class_name, unit = profile['suites'][0]
        command, outer = ci.guarded_profile_run(profile, suite, class_name, unit, 1500)
        self.assertNotIn('--class', command)
        self.assertEqual(command[command.index('--module')+1], 'tests/e2e/test_volume_mip_orient.py')
        self.assertEqual(command[command.index('--unit')+1], 'ci-mip-orient')
        self.assertEqual(command[command.index('--timeout')+1], '900')
        self.assertEqual(outer, 935)
        self.assertEqual(sum(budget+35 for budget in budgets.values()), 935)
        self.assertLessEqual(sum(budget+35 for budget in budgets.values())+150, 25*60)
        self.assertTrue(all(budget <= profile['suite_timeout'] for budget in budgets.values()))

    def test_volume_mip_orient_module_declares_exactly_the_orient_cases_on_the_mip_output_base(self):
        import ast
        cases = ('test_mip_orient_01_presets_save_restore_output',
                 'test_mip_orient_02_refusals_current_view_cancel')
        module = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        classes = [node for node in module.body if isinstance(node, ast.ClassDef)]
        self.assertEqual([(node.name, [base.id for base in node.bases]) for node in classes], [('VolumeMipOrientE2E', ['VolumeMipOutputE2E'])])
        declared = [node.name for node in classes[0].body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
        self.assertEqual(declared, list(cases))
        constant = next(node for node in module.body if isinstance(node, ast.Assign)
                        and [target.id for target in node.targets if isinstance(target, ast.Name)] == ['MIP_ORIENT_CASES'])
        self.assertEqual(ast.literal_eval(constant.value), cases)
        loader = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'load_tests')
        self.assertIn('MIP_ORIENT_CASES', {node.id for node in ast.walk(loader) if isinstance(node, ast.Name)})
        self.assertNotIn('getTestCaseNames', ast.dump(loader))
        # The MIP output base keeps its three authored cases; none of them is redeclared here.
        output = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_output.py').read_text(encoding='utf-8'))
        base = next(node for node in output.body if isinstance(node, ast.ClassDef) and node.name == 'VolumeMipOutputE2E')
        self.assertEqual(len([node for node in base.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]), 3)
        self.assertFalse(set(cases) & {node.name for node in base.body if isinstance(node, ast.FunctionDef)})

    def test_validate_workflow_runs_volume_mip_orient_in_its_own_bounded_job(self):
        text = (ci.ROOT/'.github/workflows/validate.yml').read_text(encoding='utf-8')
        jobs = text.split('\n  volume-mip-orient:\n')
        self.assertEqual(len(jobs), 2, 'validate.yml must declare one volume-mip-orient job')
        body = []
        for line in jobs[1].splitlines():
            if line.startswith('  ') and not line.startswith('   '):
                break
            body.append(line)
        job = '\n'.join(body)
        for required in ['runs-on: ubuntu-24.04',
                         'timeout-minutes: 40',
                         'persist-credentials: false',
                         'python3 -B tests/measurement_ci_test.py',
                         'tests/execution_selection_test.py',
                         '--file tests/e2e/test_volume_mip_orient.py',
                         '--file worklist-v0/hpacs-lite/volume-mip.js',
                         '--file worklist-v0/hpacs-lite/volume-mip-job.js',
                         '--file worklist-v0/hpacs-lite/volume-mip-output.js',
                         '--file worklist-v0/hpacs-lite/viewer-volume-mip.js',
                         '--file worklist-v0/hpacs-lite/viewer-jobs.js',
                         'tests/measurement_ci.py --profile volume-mip-orient',
                         'name: synthetic-volume-mip-orient-results',
                         'tests/e2e/artifacts/volume-mip-orient-ci/',
                         'tmp/miporient-ci/',
                         'if: always()', 'if-no-files-found: error',
                         'retention-days: 7']:
            self.assertIn(required, job)
        self.assertEqual(job.count('timeout-minutes: 28'), 1)
        self.assertEqual(text.count('--profile volume-mip-orient'), 1)
        self.assertNotIn('--profile volume-mip-orient', jobs[0])
        self.assertEqual(text.count('name: synthetic-volume-mip-orient-results'), 1)
        # Every other synthetic group keeps its own profile and does not run this one.
        for other in ('volume-mpr', 'volume-slab', 'volume-path', 'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi', 'volume-mip-job', 'volume-mip-batch', 'volume-mip-output'):
            self.assertEqual(text.count('--profile '+other), 1)
        # The pure models of the new presets run in the existing pure model gate, with no new pure job.
        pure = next(line for line in text.splitlines() if 'tmp/vr-ci/pure-volume-models' in line)
        tested = pure.rsplit(' --test ', 1)[1].split()
        for name in ('tests/volume_mip_test.cjs', 'tests/volume_mip_job_test.cjs', 'tests/volume_mip_batch_test.cjs', 'tests/volume_mip_output_test.cjs', 'tests/viewer_volume_job_capture_test.cjs'):
            self.assertIn(name, tested, name)
    def test_e2e_route_handlers_bind_payloads_after_route_and_request(self):
        """A11-ORIENT-1 ci-02 regression (static, not a runtime exercise of any callback).

        Playwright calls a route handler with (route, route.request), passing as many of them as the handler declares. A handler
        that declares two parameters therefore receives the Request as its second one, so a payload bound as the second parameter
        default is overwritten by the Request (ci-02: json.dumps(Request) raised inside the handler and resurfaced at unroute).
        The rule this encodes: the leading non-defaulted parameters are exactly (route) or (route, request), and any bound default
        comes after both. Verified against every handler in tests/e2e at the time of writing.
        """
        import ast
        checked, violations = 0, []
        for path in sorted((ci.ROOT/'tests/e2e').glob('*.py')):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
            for call in ast.walk(tree):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr in ('route', 'unroute')):
                    continue
                if len(call.args) < 2:
                    continue
                handler = call.args[1]
                node = handler if isinstance(handler, ast.Lambda) else functions.get(handler.id) if isinstance(handler, ast.Name) else None
                if node is None:
                    continue
                checked += 1
                declared = len(node.args.posonlyargs) + len(node.args.args)
                defaulted = len(node.args.defaults)
                leading = declared - defaulted
                if leading not in (1, 2) or (defaulted and leading != 2):
                    violations.append((path.name, call.lineno, declared, defaulted))
        self.assertEqual(violations, [])
        self.assertGreaterEqual(checked, 300, 'the scan must still reach the e2e route handlers')

    def test_mip_orient_camera_diagnostics_compose_as_strings(self):
        """A11-ORIENT-1 ci-02 regression (static): assert_camera must not concatenate its label with +, and rolled_back must
        return a string, so a diagnostic value can never raise before the 1e-6 camera comparisons run."""
        import ast
        tree = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        camera = functions['assert_camera']
        concatenations = [node for node in ast.walk(camera)
                          if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add)
                          and isinstance(node.left, ast.Name) and node.left.id == 'label']
        self.assertEqual(concatenations, [], 'compose the message with an f-string, not label + ...')
        returns = [node.value for node in ast.walk(functions['rolled_back']) if isinstance(node, ast.Return)]
        self.assertTrue(returns and all(isinstance(value, ast.JoinedStr) for value in returns),
                        'rolled_back must return a formatted string')
    # A11-ORIENT-1 ci-03 regressions. Two static rules and one real execution of the module's own helper code; none of them
    # imports Playwright, launches a browser or mirrors the fixture.
    PLAYWRIGHT_ASSERTION_POSITIONALS = {
        'to_have_count': 1, 'to_have_text': 1, 'to_contain_text': 1, 'to_have_value': 1, 'to_have_values': 1,
        'to_have_class': 1, 'to_have_id': 1, 'to_have_title': 1, 'to_have_url': 1, 'to_have_attribute': 2,
        'to_have_js_property': 2, 'to_have_css': 2, 'to_be_visible': 0, 'to_be_hidden': 0, 'to_be_enabled': 0,
        'to_be_disabled': 0, 'to_be_checked': 0, 'to_be_editable': 0, 'to_be_empty': 0, 'to_be_focused': 0,
        'to_be_attached': 0, 'to_be_in_viewport': 0,
    }

    def test_playwright_assertions_take_only_their_expected_value_positionally(self):
        """expect(...).to_have_count(0, label) raised TypeError in ci-03: these assertions take the expected value positionally
        and everything else, timeout included, by keyword. A message never goes into the assertion call."""
        import ast
        violations, checked = [], 0
        for path in sorted((ci.ROOT/'tests/e2e').glob('*.py')):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            for call in ast.walk(tree):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)):
                    continue
                name = call.func.attr
                limit = self.PLAYWRIGHT_ASSERTION_POSITIONALS.get(name[4:] if name.startswith('not_') else name)
                if limit is None:
                    continue
                receiver = call.func.value
                while isinstance(receiver, ast.Attribute):
                    receiver = receiver.value
                if not (isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name) and receiver.func.id == 'expect'):
                    continue
                checked += 1
                if len(call.args) > limit:
                    violations.append((path.name, call.lineno, name, len(call.args), limit))
        self.assertEqual(violations, [])
        self.assertGreater(checked, 500, 'the scan must still reach the e2e assertions')

    def test_mip_orient_page_helpers_are_installed_before_use(self):
        """ci-03 NA1: FINAL_CAMERA calls mipView(), which only exists after HELPERS has been evaluated on THAT page. fresh_page()
        installs nothing, so every page must receive its helpers before the first use. Checked per page variable, in source order."""
        import ast
        installs = {'HELPERS': {'mipView', 'mipCount', 'canvasPixel', 'mipState'},
                    'VOI_HELPERS': {'mipVoiState', 'mipTransitions', 'mipStatuses'},
                    'BATCH_HELPERS': {'batchFrames', 'batchStatuses', 'batchHoldFrame', 'batchHeld', 'batchView'},
                    'PRINT_TRACE': {'printFrames', 'printEvents', 'printFault', 'printLeaks', 'printReady'}}
        constant_needs = {'FINAL_CAMERA': {'mipView'}, 'TAKE': {'printFrames'}, 'NO_LEAKS': {'printLeaks'}}
        method_needs = {'mark': {'mipTransitions'}, 'settled': {'mipTransitions'}, 'job_final': {'mipTransitions'},
                        'apply_voi_case': {'mipTransitions'}, 'batch_announced': {'batchStatuses'}, 'make': {'batchFrames'},
                        'rolled_back': {'mipTransitions'}, 'open_output': {'printFrames'}}
        # Helper methods that install helpers themselves (verified in test_volume_mip.py): opened_voi_study evaluates HELPERS on
        # the page it returns third, and open_voi evaluates VOI_HELPERS on the page it is given.
        installers = {'opened_voi_study': ('return3', installs['HELPERS']), 'open_voi': ('arg0', installs['VOI_HELPERS'])}
        tree = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        problems = []
        for function in [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name.startswith('test_')]:
            have = {}
            for node in sorted([n for n in ast.walk(function) if isinstance(n, (ast.Call, ast.Assign))],
                               key=lambda n: (n.lineno, n.col_offset)):
                if isinstance(node, ast.Assign):
                    call = node.value
                    if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                            and isinstance(call.func.value, ast.Name) and call.func.value.id == 'self'):
                        spec = installers.get(call.func.attr)
                        if spec and spec[0] == 'return3' and isinstance(node.targets[0], ast.Tuple) and len(node.targets[0].elts) == 3:
                            have.setdefault(node.targets[0].elts[2].id, set()).update(spec[1])
                    continue
                function_node = node.func
                if isinstance(function_node, ast.Attribute) and isinstance(function_node.value, ast.Name) and function_node.value.id == 'self':
                    spec = installers.get(function_node.attr)
                    if spec and spec[0] == 'arg0' and node.args and isinstance(node.args[0], ast.Name):
                        have.setdefault(node.args[0].id, set()).update(spec[1])
                    if function_node.attr in method_needs and node.args and isinstance(node.args[0], ast.Name):
                        missing = method_needs[function_node.attr] - have.get(node.args[0].id, set())
                        if missing:
                            problems.append((function.name, node.lineno, node.args[0].id + '.' + function_node.attr, sorted(missing)))
                # wait_for_function and evaluate_handle run page code exactly like evaluate, so a predicate such as NO_LEAKS needs
                # its helpers installed on that same page too (ci-03 N1: printLeaks was only ever installed by PRINT_TRACE).
                if (isinstance(function_node, ast.Attribute) and function_node.attr in ('evaluate', 'wait_for_function', 'evaluate_handle')
                        and isinstance(function_node.value, ast.Name)):
                    page, needed = function_node.value.id, set()
                    if node.args and isinstance(node.args[0], ast.Name):
                        if node.args[0].id in installs:
                            have.setdefault(page, set()).update(installs[node.args[0].id])
                        needed |= constant_needs.get(node.args[0].id, set())
                    if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                        for symbol in {s for group in installs.values() for s in group}:
                            if symbol in node.args[0].value:
                                needed.add(symbol)
                    missing = needed - have.get(page, set())
                    if missing:
                        problems.append((function.name, node.lineno, page, sorted(missing)))
        self.assertEqual(problems, [])

    def test_mip_orient_camera_diagnostics_execute_without_playwright(self):
        """Runs the module's own near/assert_camera/rolled_back on stubs: the ci-02 label defect was a runtime TypeError that a
        parse cannot see. A mismatch must raise AssertionError carrying the label, never TypeError."""
        import ast, math, unittest as ut
        source = ast.parse((ci.ROOT/'tests/e2e/test_volume_mip_orient.py').read_text(encoding='utf-8'))
        klass = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'VolumeMipOrientE2E')
        wanted = {'near', 'assert_camera', 'rolled_back'}
        extracted = ast.Module(body=[n for n in klass.body if isinstance(n, ast.FunctionDef) and n.name in wanted], type_ignores=[])
        self.assertEqual({n.name for n in extracted.body}, wanted)
        ast.fix_missing_locations(extracted)
        namespace = {'math': math, 'DISTANCE': 100.0}
        exec(compile(extracted, '<orient-helpers>', 'exec'), namespace)

        class Probe(ut.TestCase):
            def runTest(self):
                pass
        for name in wanted:
            setattr(Probe, name, namespace[name])
        probe = Probe()

        class Page:
            def locator(self, selector):
                return self
            def text_content(self):
                return 'ROLLED BACK STATUS'
            def evaluate(self, expression, argument=None):
                return ['pending', 'final']
        label = probe.rolled_back(Page(), 3, 'Anterior')
        self.assertIsInstance(label, str)
        self.assertIn('Anterior', label)
        self.assertIn('ROLLED BACK STATUS', label)
        camera = {'viewPlaneNormal': [0, -1, 0], 'viewUp': [0, 0, 1], 'focalPoint': [1.0, 2.0, 3.0],
                  'position': [1.0, 2.0 - 60.0, 3.0], 'parallelScale': 30.0}
        expected = {'viewPlaneNormal': [0, -1, 0], 'viewUp': [0, 0, 1], 'focalPoint': [1.0, 2.0, 3.0]}
        probe.assert_camera(camera, expected, label, (60.0, 30.0))
        wrong = dict(camera, viewPlaneNormal=[0, 1, 0])
        with self.assertRaises(AssertionError) as raised:
            probe.assert_camera(wrong, expected, label, (60.0, 30.0))
        self.assertIn('Anterior', str(raised.exception))
        # A tuple label must still compare and fail as an assertion, never as a TypeError (the ci-02 defect).
        with self.assertRaises(AssertionError):
            probe.assert_camera(wrong, expected, ('Anterior', 'status', []), (60.0, 30.0))
        # The zoom parity and the distance floor are still enforced.
        with self.assertRaises(AssertionError):
            probe.assert_camera(dict(camera, parallelScale=31.0), expected, label, (60.0, 30.0))
        with self.assertRaises(AssertionError):
            probe.assert_camera(dict(camera, position=[1.0, 2.0 - 40.0, 3.0]), expected, label, (40.0, 30.0))
    def test_output_integration_commands_are_exact_ordered_local_classes(self):
        profile=ci.PROFILES['output-integration']
        commands=[]
        for suite,class_name,unit in profile['suites']:
            command,outer=ci.guarded_profile_run(profile,suite,class_name,unit,2000)
            commands.append(command)
            self.assertEqual(command[command.index('--timeout')+1],'900')
            self.assertEqual(outer,935)
        self.assertEqual([command[command.index('--module')+1] for command in commands],
                         ['tests/e2e/test_compare_reports.py',
                          'tests/e2e/test_viewer_job_report.py',
                          'tests/e2e/test_editor_compare_output.py'])
        self.assertEqual([command[command.index('--class')+1] for command in commands],
                         ['CompareReportsE2E','ViewerJobReportE2E','EditorCompareOutputE2E'])
        self.assertEqual([command[command.index('--unit')+1] for command in commands],
                         ['ci-output-compare-reports','ci-output-viewer-job-report',
                          'ci-output-editor-compare-output'])

    def test_output_integration_declares_exact_six_four_four_tests(self):
        expected=(('e2e/test_compare_reports.py','CompareReportsE2E',
                   'test_compare_reports_',6),
                  ('e2e/test_viewer_job_report.py','ViewerJobReportE2E',
                   'test_job_report_',4),
                  ('e2e/test_editor_compare_output.py','EditorCompareOutputE2E',
                   'test_editor_output_',4))
        for suite,class_name,prefix,count in expected:
            text=(ci.ROOT/'tests'/suite).read_text(encoding='utf-8')
            import ast
            tree=ast.parse(text)
            cls=next(node for node in tree.body if isinstance(node,ast.ClassDef)
                     and node.name==class_name)
            declared=[node.name for node in cls.body if isinstance(node,ast.FunctionDef)
                      and node.name.startswith('test_')]
            self.assertEqual(len(declared),count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))

    def test_output_integration_workflow_is_manual_fixed_sha_and_hosted(self):
        text=(ci.ROOT/'.github/workflows/output-integration.yml').read_text(encoding='utf-8')
        for required in ['workflow_dispatch:', 'runs-on: ubuntu-24.04',
                         'ref: ${{ github.sha }}', 'persist-credentials: false',
                         'default: output-integration', '- identity-fields',
                         '- images-only', 'tests/e2e/artifacts/images-only-ci/',
                         '- image-text', 'tests/e2e/artifacts/image-text-ci/',
                         'tests/e2e/artifacts/IMAGE-TEXT-*.png',
                         'tests/e2e/artifacts/IMAGES-ONLY-*.png',
                         'tests/e2e/artifacts/test_images_only_*.png',
                         'KIN_CI_PROFILE: ${{ inputs.profile }}',
                         'tests/measurement_ci.py --profile "$KIN_CI_PROFILE"',
                         'if: always()', 'retention-days: 7']:
            self.assertIn(required,text)
        run_blocks='\n'.join(line for line in text.splitlines() if line.lstrip().startswith('run:'))
        self.assertNotIn('${{ inputs.profile }}',run_blocks)
        self.assertNotIn('pull_request:',text)
        self.assertNotIn('push:',text)

    def test_identity_fields_commands_are_exact_ordered_local_classes(self):
        profile=ci.PROFILES['identity-fields']
        expected=(
            ('reading_appearance_live.py','ReadingAppearanceLive','test_',17),
            ('reading_appearance_position_live.py','ReadingAppearancePositionLive',
             'test_identity_position_api_',2),
            ('reading_appearance_fields_live.py','ReadingAppearanceFieldsLive',
             'test_identity_fields_api_',2),
            ('e2e/test_viewer_identity_position.py','ViewerIdentityPositionE2E',
             'test_identity_position_',2),
            ('e2e/test_viewer_identity_fields.py','ViewerIdentityFieldsE2E',
             'test_identity_fields_',2),
        )
        self.assertEqual([row[:2] for row in profile['suites']],
                         [row[:2] for row in expected])
        import ast
        for (suite,class_name,unit),(_,_,prefix,count) in zip(profile['suites'],expected):
            command,outer=ci.guarded_profile_run(profile,suite,class_name,unit,1000)
            self.assertEqual(command[command.index('--module')+1],'tests/'+suite)
            self.assertEqual(command[command.index('--class')+1],class_name)
            self.assertEqual(command[command.index('--timeout')+1],'540')
            self.assertEqual(outer,575)
            tree=ast.parse((ci.ROOT/'tests'/suite).read_text(encoding='utf-8'))
            cls=next(node for node in tree.body if isinstance(node,ast.ClassDef)
                     and node.name==class_name)
            declared=[node.name for node in cls.body if isinstance(node,ast.FunctionDef)
                      and node.name.startswith('test_')]
            self.assertEqual(len(declared),count)
            self.assertTrue(all(name.startswith(prefix) for name in declared))

    def test_vr_resize_probe_executes_only_the_instrumented_original_vr20(self):
        import ast
        profile=ci.PROFILES['vr-resize-probe']
        self.assertEqual(profile['suites'], (('e2e/test_vr_resize_probe.py',
                         'VrResizeProbeE2E', 'ci-vr-resize-probe'),))
        self.assertEqual(profile['out'].name,'vr-resize-probe-ci')
        tree=ast.parse((ci.ROOT/'tests/e2e/test_vr_resize_probe.py').read_text(encoding='utf-8'))
        cls=next(node for node in tree.body if isinstance(node,ast.ClassDef))
        methods=[node.name for node in cls.body if isinstance(node,ast.FunctionDef)
                 and node.name.startswith('test_')]
        self.assertEqual(methods,['test_vr_resize_probe_01_original_vr20'])
        command,_=ci.guarded_profile_run(profile,*profile['suites'][0],1000)
        self.assertIn('VrResizeProbeE2E',command)
        self.assertEqual(len({p['out'] for p in ci.PROFILES.values()}),len(ci.PROFILES))

    def test_vr_artifact_allowlist_rejects_raw_text_and_validates_png(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);stage=root/'private';out=root/'public'
            stage.mkdir();out.mkdir()
            (stage/'volume-rendering.png').write_bytes(b'\x89PNG\r\n\x1a\nsynthetic')
            (stage/'raw.txt').write_text('Authorization: Bearer raw-secret',encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError,'Unexpected or missing'):
                ci.publish_vr_evidence(stage,out)
            self.assertEqual(list(out.iterdir()),[])
            (stage/'raw.txt').unlink()
            ci.publish_vr_evidence(stage,out)
            self.assertEqual((out/'volume-rendering.png').read_bytes(),
                             b'\x89PNG\r\n\x1a\nsynthetic')

    def test_inner_deadline_leaves_time_to_terminate_descendants(self):
        for remaining, expected in [(1000,540), (100,65), (36,1)]:
            command=ci.guarded_suite_command('e2e/test_manual_sr.py','ManualSrE2E',remaining)
            self.assertEqual(command[command.index('--timeout')+1],str(expected))
        with self.assertRaisesRegex(RuntimeError,'Insufficient CI time'):
            ci.guarded_suite_command('e2e/test_manual_sr.py','ManualSrE2E',35)
        command,outer=ci.guarded_profile_run(ci.PROFILES['volume-rendering'],
            'e2e/test_volume_rendering.py',None,'ci-volume-rendering',1300)
        self.assertNotIn('--class',command)
        self.assertEqual(command[command.index('--unit')+1],'ci-volume-rendering')
        self.assertEqual(command[command.index('--timeout')+1],'1200')
        self.assertEqual(outer,1235)
        self.assertGreaterEqual(outer,int(command[command.index('--timeout')+1])+35)

        command,outer=ci.guarded_profile_run(ci.PROFILES['measurements'],
            'e2e/test_manual_sr.py','ManualSrE2E','ci-test-manual-sr',1000)
        self.assertEqual(command[command.index('--timeout')+1],'540')
        self.assertEqual(outer,575)

    def test_main_runtime_uses_profile_outer_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            profile={**ci.PROFILES['volume-rendering'], 'out':root/'artifacts'}
            completed=MagicMock(returncode=0,stdout=b'',stderr=b'')
            response=MagicMock();response.__enter__.return_value.status=200
            checks=[b'',b'',b'unix:///var/run/docker.sock']
            with patch.dict(os.environ, {'GITHUB_ACTIONS':'true',
                    'RUNNER_ENVIRONMENT':'github-hosted','RUNNER_TEMP':folder}, clear=True), \
                 patch.object(ci,'ROOT',root), \
                 patch.dict(ci.PROFILES, {'volume-rendering':profile}), \
                 patch.object(ci,'seed_source'), \
                 patch.object(ci.subprocess,'check_output',side_effect=checks), \
                 patch.object(ci.subprocess,'run',return_value=completed) as run, \
                 patch.object(ci,'urlopen',return_value=response), \
                 patch.object(ci,'publish_vr_evidence'):
                ci.main('volume-rendering')
            invocation=next(call for call in run.call_args_list
                            if 'run-tests.py' in ' '.join(map(str,call.args[0])))
            command=invocation.args[0]
            inner=int(command[command.index('--timeout')+1])
            self.assertEqual(inner,1200)
            self.assertEqual(invocation.kwargs['timeout'],1235)
            self.assertGreaterEqual(invocation.kwargs['timeout'],inner+35)

    def test_local_and_self_hosted_refused_before_docker(self):
        for env in [{}, {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'self-hosted'}]:
            with patch.dict(os.environ,env,clear=True), patch.object(ci.subprocess,'check_output') as command, patch.object(ci.subprocess,'run') as mutation:
                with self.assertRaisesRegex(RuntimeError,'disposable GitHub-hosted'):
                    ci.main('measurements')
                command.assert_not_called()
                mutation.assert_not_called()

    def test_unknown_profile_refused_before_environment_or_docker(self):
        with patch.object(ci.subprocess,'check_output') as command:
            with self.assertRaisesRegex(RuntimeError,'Unknown CI profile'):
                ci.main('other')
            command.assert_not_called()

    def test_artifact_secrets_and_dynamic_credentials_removed(self):
        text='''generated=generated-secret
Authorization: Bearer token-value
Authorization: Basic dXNlcjpwYXNz
Set-Cookie: kin_session=session-value; HttpOnly
{"access_token":"eyJhbGci.payload.signature", "temporaryPassword":"temporary-value", "password":"another-value"}
test_measurement_readback PASS: 4'''
        result=ci.sanitize(text,['generated-secret'])
        for value in ['generated-secret','token-value','dXNlcjpwYXNz','session-value','eyJhbGci.payload.signature','temporary-value','another-value']:
            self.assertNotIn(value,result)
        self.assertIn('test_measurement_readback PASS: 4',result)


if __name__ == '__main__': unittest.main(verbosity=2)
