"""KEY-ADMIN: the administrator's doctor-key path and the doctor's approval with that key.

KeyAdminHttpPg runs tests/emr/c/key_admin_http_pg_test.cjs against an owned PostgreSQL fixture with the normal
production migrations: real Nest controllers, AuthGuard, startup clinical providers, B2 ledger, C2 crypto and file
custody; only the IdP, Orthanc and the Keycloak directory are synthetic. With KIN_TEST_API_IMAGE the script runs in
that compiled image (the same product boundary CI builds); otherwise KIN_B2R_NODE runs it against api/dist.

KeyAdminFreshHostLive is the fresh-host sign check: a newly started synthetic stack whose API received only the
deployment's custody overlay (emr/deploy/docker-compose.signing.yml with a new 32-byte file) and no synthetic key
fixture. Through the real proxy, Keycloak login and API, the institution admin creates a doctor's key, the doctor's
ordinary report approval signs with it, rotation and retirement take effect, and each change is in the access ledger.
"""
import os
from pathlib import Path
import sys
import unittest
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
sys.path.insert(0, str(ROOT / 'tests'))
import pg_ledger_restore_test as pg


class KeyAdminHttpPg(pg.PgLedgerFixture):
    def test_key_admin_http(self):
        logs = ROOT / 'tmp/emr-key-admin' / ('http-' + self.token)
        logs.mkdir(parents=True)
        env = {'DATABASE_URL': self.runtime_url, 'KIN_D_WITNESS_URL': self.witness_url,
               'KIN_D_SPOOL': '/tmp/key-admin-spool' if self.image else str(logs / 'spool')}
        if self.image:
            command = ['docker', 'run', '--rm', '--network', self.network, '--tmpfs', '/tmp',
                       '-v', str(ROOT / 'tests/emr/c') + ':/tests:ro', '-e', 'KIN_D_API=/app']
            for key, value in env.items():
                command += ['-e', key + '=' + value]
            command += ['--entrypoint', 'node', self.image, '--test', '/tests/key_admin_http_pg_test.cjs']
            result = self.command(command, check=False, timeout=600)
        else:
            result = self.command([os.environ['KIN_B2R_NODE'], '--test', str(ROOT / 'tests/emr/c/key_admin_http_pg_test.cjs')],
                                  env={**os.environ, **env}, check=False, timeout=600)
        (logs / 'stdout.log').write_text(result.stdout, encoding='utf-8')
        (logs / 'stderr.log').write_text(result.stderr, encoding='utf-8')
        print('Key admin HTTP raw logs:', logs)
        self.assertEqual(result.returncode, 0, result.stdout[-3000:] + result.stderr[-1000:])


class KeyAdminFreshHostLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # This check owns key creation: a stack whose members already received fixture keys is not a fresh host.
        if os.environ.get('KIN_D_SYNTHETIC_SIGNING') == '1':
            raise RuntimeError('Fresh-host key check needs a stack without the synthetic key fixture')
        import invariants_live as live   # the LiveStack harness; imported here so KeyAdminHttpPg needs no stack
        cls.live = live
        cls.stack = live.LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()

    def approve(self, user='doctor'):
        fixture = self.stack.create_fixture()
        return self.stack.request('POST', f'/studies/{quote(fixture.uid)}/report/commit', user, {
            'action': 'approve', 'baseVersion': 0, 'findings': fixture.secret, 'conclusion': 'approved', 'recommendation': 'none'})

    def change(self, route, action, expected_kid, reason):
        result = self.stack.request('POST', route, 'jmryu', {'action': action, 'expectedKid': expected_kid, 'reason': reason})
        self.assertEqual(result.status, 201, result.text)
        return result.body

    def test_fresh_host_admin_key_and_doctor_approval(self):
        doctor = self.stack.user_ids['doctor']
        route = f'/admin/users/{quote(doctor)}/signing-key'
        self.assertEqual(self.stack.request('GET', route, 'doctor').status, 403)
        before = self.stack.request('GET', route, 'jmryu')
        self.assertEqual((before.status, before.body.get('current'), before.body.get('keys')), (200, None, []), before.text)
        refused = self.approve()
        self.assertEqual((refused.status, refused.body.get('code')), (503, 'DoctorSigningKeyUnavailable'), refused.text)

        created = self.change(route, 'provision', None, '합성 스택 판독의 서명키 발급')
        approved = self.approve()
        self.assertEqual(approved.status, 201, approved.text)
        self.assertEqual(approved.body['signature']['kid'], created['current'])
        rotated = self.change(route, 'replace', created['current'], '합성 스택 정기 교체')
        self.assertNotEqual(rotated['current'], created['current'])
        again = self.approve()
        self.assertEqual(again.status, 201, again.text)
        self.assertEqual(again.body['signature']['kid'], rotated['current'])
        retired = self.change(route, 'revoke', rotated['current'], '합성 스택 키 폐기')
        self.assertIsNone(retired['current'])
        after = self.approve()
        self.assertEqual((after.status, after.body.get('code')), (503, 'DoctorSigningKeyUnavailable'), after.text)

        # The key exists only as the API's wrapped row; the ledger has each change by the admin about this doctor.
        events = self.live.psql(
            "SELECT payload::jsonb->'userId'->'value'->>'subject' || '|' || (payload::jsonb->'targets'->0->'versionId'->>'value') "
            "FROM emr_access.access_entry WHERE payload::jsonb->>'surface'='server:doctor-key-management' "
            f"AND payload::jsonb->'targets'->0->'versionId'->>'value' IN ('{created['current']}','{rotated['current']}') ORDER BY sequence")
        admin = self.stack.user_ids['jmryu']
        self.assertEqual(events, [f'{admin}|{created["current"]}', f'{admin}|{rotated["current"]}', f'{admin}|{rotated["current"]}'])
        wrapping = self.live.psql(
            f"SELECT wrapped->>'wrappingKeyId' FROM emr_signing.private_key WHERE kid IN ('{created['current']}','{rotated['current']}')")
        self.assertEqual(wrapping, ['c2-wrap-v1', 'c2-wrap-v1'])


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
