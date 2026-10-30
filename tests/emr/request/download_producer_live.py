"""AR-IMPL-03: real original-download HTTP/PG and the Access Review query.

Uses B2's fresh synthetic install; never reads an application .env or DB.
The optional review migration (KIN_DOWNLOAD_REVIEW_MIGRATION) comes from the separately
owned Access Review tree; without it the review query step is not run.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture


class DownloadProducerLive(PgLedgerFixture):
    def test_original_download_and_review(self):
        migration = os.environ.get('KIN_DOWNLOAD_REVIEW_MIGRATION')
        if migration:
            self.sql(Path(migration).read_text(encoding='utf-8'))
        driver = ROOT / 'tests/emr/request/download_producer_pg_test.cjs'
        # Main now installs Access Review through normal migrate deploy. Retain the optional pre-merge fixture input.
        review = '1' if migration or (ROOT / 'api/prisma/migrations/20261025120000_access_review/migration.sql').is_file() else '0'
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(ROOT / 'tmp/download-producer-b2/spool' / self.token), 'KIN_DOWNLOAD_REVIEW': review}
        if self.image:
            command = ['docker', 'run', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                       '--network', self.network, '--mount', 'type=bind,source=' + str(driver) + ',target=/app/download-test.cjs,readonly',
                       '-e', 'KIN_DOWNLOAD_API=/app', '-e', 'KIN_DOWNLOAD_REVIEW=' + review, '-e', 'DATABASE_URL=' + self.runtime_url,
                       '-e', 'KIN_B2R_WITNESS_URL=' + self.witness_url, '-e', 'KIN_B2R_SPOOL=/tmp/download-spool',
                       self.image, 'node', '/app/download-test.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], str(driver)]
        self.run_node_case(command, ROOT / 'tmp/download-producer-b2' / self.token, env=env, timeout=120)


if __name__ == '__main__':
    unittest.main(verbosity=2)
