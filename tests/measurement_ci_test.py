"""D-MEASURE2 B1: runner refusal and public artifact secret redaction."""
import os, tempfile, unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
import measurement_ci as ci


class MeasurementCiTests(unittest.TestCase):
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
        self.assertEqual(profile['suite_timeout'], 900)

    def test_profiles_are_exact_and_use_separate_owned_artifacts(self):
        self.assertEqual(set(ci.PROFILES),
                         {'measurements', 'volume-rendering', 'output-integration',
                          'identity-fields', 'vr-resize-probe', 'hanging-protocols', 'dicom-pdf', 'image-thumbnails'})
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
