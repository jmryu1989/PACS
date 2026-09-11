"""D-MEASURE2 B1: runner refusal and public artifact secret redaction."""
import os, tempfile, unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
import measurement_ci as ci


class MeasurementCiTests(unittest.TestCase):
    def test_profiles_are_exact_and_use_separate_owned_artifacts(self):
        self.assertEqual(set(ci.PROFILES), {'measurements', 'volume-rendering'})
        measurements = ci.PROFILES['measurements']
        volume = ci.PROFILES['volume-rendering']
        self.assertEqual([row[:2] for row in measurements['suites']],
                         list(zip(ci.SUITES, ci.SUITE_CLASSES)))
        self.assertEqual(volume['suites'], (('e2e/test_volume_rendering.py',
                         None, 'ci-volume-rendering'),))
        self.assertNotEqual(measurements['out'], volume['out'])
        self.assertEqual(volume['out'].name, 'volume-rendering-ci')
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
            expected={
                'KIN_TEST_PROXY':'https://localhost:9443',
                'KIN_TEST_API':'https://localhost:9443/api',
                'KIN_TEST_TOKEN_URL':'http://127.0.0.1:8080/auth/realms/kin/protocol/openid-connect/token',
                'KIN_TEST_ORTHANC':'http://127.0.0.1:8042',
                'KIN_TEST_ORTHANC_USER':'admin',
                'KIN_TEST_ORTHANC_PASSWORD':'generated-orthanc-password'}
            self.assertEqual({key:measurement_env[key] for key in hostile}, expected)
            self.assertEqual({key:volume_env[key] for key in hostile}, expected)

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
