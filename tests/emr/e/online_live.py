"""E-T1/T2: actual B2 PostgreSQL plus HTTP; synthetic source protocol only.

Uses the shipped E migration/store on the B2 transaction.
Full nginx/OHIF and actual DICOM decoder acceptance remain separate checks.
"""
import os
from pathlib import Path
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg


class OnlineImagePg(pg.PgLedgerFixture):
    @classmethod
    def setUpClass(cls):
        pg.gate.require_live_run()
        if not os.environ.get('KIN_TEST_API_IMAGE') and not os.environ.get('KIN_B2R_NODE'):
            # Candidate CI supplies the checkout, while the dedicated E job supplies Node.
            # Match B's existing compiled production-image fixture entry.
            tag = 'kin-emre-live:' + uuid.uuid4().hex[:12]
            cls.command(['docker', 'build', '--target', 'production', '--build-arg',
                         'VCS_REF=emr-e-live', '-t', tag, str(ROOT / 'api')], timeout=1800)
            cls.addClassCleanup(cls.command, ['docker', 'image', 'rm', tag])
            os.environ['KIN_TEST_API_IMAGE'] = tag
            cls.addClassCleanup(os.environ.pop, 'KIN_TEST_API_IMAGE', None)
        super().setUpClass()

    def test_fixed_image_http(self):
        logs = ROOT / 'tmp/emr-e-online' / ('pg-' + self.token)
        logs.mkdir(parents=True)
        env = {'DATABASE_URL': self.runtime_url, 'KIN_E_WITNESS_URL': self.witness_url,
               'KIN_E_SPOOL': '/tmp/e-spool' if self.image else str(logs / 'spool')}
        if self.image:
            command = ['docker', 'run', '--rm', '--name', self.container + '-node',
                       '--label', 'kin.b2r=' + self.token, '--network', self.network, '--tmpfs', '/tmp',
                       '-v', str(ROOT / 'tests/emr/e') + ':/tests:ro', '-e', 'KIN_E_API=/app']
            for key, value in env.items():
                command += ['-e', key + '=' + value]
            command += ['--entrypoint', 'node', self.image, '--test', '/tests/stream_pg_test.cjs']
            result = self.command(command, check=False)
        else:
            result = self.command([os.environ['KIN_B2R_NODE'], str(ROOT / 'tests/emr/e/stream_pg_test.cjs')],
                                  env={**os.environ, **env}, check=False)
        (logs / 'stdout.log').write_text(result.stdout, encoding='utf-8')
        (logs / 'stderr.log').write_text(result.stderr, encoding='utf-8')
        print('E PG/HTTP logs:', logs)
        self.assertEqual(result.returncode, 0, result.stdout[-1800:] + result.stderr[-1000:])
        # E-05: native dump/restore retains the exact representation, copy facts,
        # grants and the next observation sequence on this owned synthetic host.
        snapshot = """SELECT jsonb_build_object(
          'preparation',(SELECT jsonb_agg(to_jsonb(t) ORDER BY event_id) FROM emr_image.preparation t),
          'source_manifest',(SELECT jsonb_agg(to_jsonb(t) ORDER BY body_sha256) FROM emr_image.source_manifest t),
          'observation',(SELECT jsonb_agg(to_jsonb(t) ORDER BY sequence) FROM emr_image.observation t),
          'sequence',(SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM emr_image.observation_sequence_seq),
          'grants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY table_schema,table_name,grantor,grantee,privilege_type,is_grantable,with_hierarchy)
            FROM (SELECT grantor,grantee,table_schema,table_name,privilege_type,is_grantable,with_hierarchy
              FROM information_schema.role_table_grants WHERE table_schema='emr_image') t))::text;"""
        before = self.sql(snapshot).stdout.strip()
        dump = self.command(['docker', 'exec', self.container, 'pg_dump', '-U', self.admin_user,
                             '-n', 'emr_image', self.database_name]).stdout
        restored = 'image_restore_' + self.token
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
