"""F_LINK on an owned synthetic PG database and the shipped Nest HTTP consumer."""
import json
import os
from pathlib import Path
import sys
import subprocess
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg


class AuditLinkPg(pg.PgLedgerFixture):
    disk_storage = True  # The review scale includes 300k E rows and 20k access events.
    @classmethod
    def setUpClass(cls):
        pg.gate.require_live_run()
        if not os.environ.get('KIN_TEST_API_IMAGE') and not os.environ.get('KIN_B2R_NODE'):
            tag = 'kin-emrf-live:' + uuid.uuid4().hex[:12]
            cls.command(['docker', 'build', '--target', 'production', '--build-arg',
                         'VCS_REF=emr-f-live', '-t', tag, str(ROOT / 'api')], timeout=1800)
            cls.addClassCleanup(cls.command, ['docker', 'image', 'rm', tag])
            os.environ['KIN_TEST_API_IMAGE'] = tag
            cls.addClassCleanup(os.environ.pop, 'KIN_TEST_API_IMAGE', None)
        super().setUpClass()
        bootstrap = cls.command([sys.executable, str(ROOT / 'scripts/emr-compose.py'), 'sql', 'audit-grantor',
            '--institution', 'synthetic-hospital', '--issuer', 'https://synthetic.invalid/realms/f-link',
            '--subject', 'officer', '--capacity', 'privacy-officer',
            '--basis-document', 'synthetic-designation-authority']).stdout
        cls.sql(bootstrap)

    def test_audit_copy_hold_http(self):
        logs = ROOT / 'tmp/emr-f-link' / ('pg-' + self.token)
        logs.mkdir(parents=True)
        spool = logs / 'spool'
        spool.mkdir()
        if self.image:
            spool.chmod(0o777)  # Disposable synthetic output, writable by the image's node user.
        env = {'DATABASE_URL': self.runtime_url, 'KIN_F_WITNESS_URL': self.witness_url,
               'KIN_F_SPOOL': '/evidence' if self.image else str(spool)}
        if self.image:
            command = ['docker', 'run', '--rm', '--name', self.container + '-node',
                       '--label', 'kin.b2r=' + self.token, '--network', self.network, '--tmpfs', '/tmp',
                       '-v', str(ROOT / 'tests/emr/f') + ':/tests:ro', '-v', str(spool) + ':/evidence', '-e', 'KIN_F_API=/app']
            for key, value in env.items():
                command += ['-e', key + '=' + value]
            command += ['--entrypoint', 'node', self.image, '--test', '/tests/link_pg_test.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], '--test', str(ROOT / 'tests/emr/f/link_pg_test.cjs')]
        try:
            result = self.command(command, env={**os.environ, **env}, check=False, timeout=360)
        except subprocess.TimeoutExpired as error:
            for name, content in [('stdout', error.stdout), ('stderr', error.stderr)]:
                if isinstance(content, bytes):
                    content = content.decode('utf-8', errors='replace')
                (logs / (name + '.log')).write_text(content or '', encoding='utf-8')
            raise
        (logs / 'stdout.log').write_text(result.stdout, encoding='utf-8')
        (logs / 'stderr.log').write_text(result.stderr, encoding='utf-8')
        print('F_LINK PG/HTTP logs:', logs)
        self.assertEqual(result.returncode, 0, result.stdout[-2200:] + result.stderr[-1000:])
        # Native restore preserves original bytes, roster history, request/hold
        # history and identity sequences. Restore consumers use the same functions.
        snapshot = """SELECT jsonb_build_object(
          'grantor',(SELECT jsonb_agg(to_jsonb(t) ORDER BY institution_id,subject_id) FROM emr_audit.grantor t),
          'roster',(SELECT jsonb_agg(to_jsonb(t) ORDER BY sequence) FROM emr_audit.roster_event t),
          'issuance',(SELECT jsonb_agg(to_jsonb(t) ORDER BY sequence) FROM emr_audit.issuance_event t),
          'copies',(SELECT jsonb_agg(to_jsonb(t) ORDER BY issuance_id) FROM emr_audit.fixed_copy t),
          'requests',(SELECT jsonb_agg(to_jsonb(t) ORDER BY sequence) FROM emr_audit.request_event t),
          'holds',(SELECT jsonb_agg(to_jsonb(t) ORDER BY hold_id,phase) FROM emr_access.legal_hold_event t),
          'hold_reader',(SELECT jsonb_agg(to_jsonb(h) ORDER BY r.record_id,h.hold_id,h.phase)
            FROM (SELECT DISTINCT record_id FROM emr_access.legal_hold_event) r
            CROSS JOIN LATERAL emr_access.holds_for(r.record_id) h),
          'request_reader',(SELECT jsonb_agg(to_jsonb(d) ORDER BY r.request_id,d.phase)
            FROM (SELECT DISTINCT request_id FROM emr_audit.request_event) r
            CROSS JOIN LATERAL emr_access.duty_requests('access-request',r.request_id) d))::text;"""
        before = self.sql(snapshot).stdout.strip()
        dump = self.command(['docker', 'exec', self.container, 'pg_dump', '-U', self.admin_user,
                             '--no-tablespaces', self.database_name]).stdout
        restored = 'audit_restore_' + self.token
        self.command(['docker', 'exec', self.container, 'createdb', '-U', self.admin_user, restored])
        self.command(['docker', 'exec', '-i', self.container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                      '-U', self.admin_user, '-d', restored], data=dump)
        after = self.command(['docker', 'exec', self.container, 'psql', '-X', '-q', '-t', '-A',
                              '-U', self.admin_user, '-d', restored, '-c', snapshot]).stdout.strip()
        (logs / 'before-restore.json').write_text(before, encoding='utf-8')
        (logs / 'restore.json').write_text(after, encoding='utf-8')
        self.assertEqual(after, before)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()
