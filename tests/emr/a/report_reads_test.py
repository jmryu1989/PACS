"""A2 report history reads on the real Nest/HTTP/PG boundary (REQ-A-REPORT, REQ-A-DURABLE, REQ-A-TARGET, REQ-A-OUTCOME).

The production AppModule serves GET studies/:uid/report/versions and .../versions/:version/citations on the accepted
B2 synthetic PG fixture; the driver reads the ledger back on an independent witness connection. Renderer display
(client-shown) belongs to A4/A5 and is not proven here.
"""
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture

EVIDENCE = ROOT / 'tmp/emr-a/report-reads'


class ReportReadsHttp(PgLedgerFixture):
    def test_report_reads_record_every_returned_version_before_the_body(self):
        driver = ROOT / 'tests/emr/a/report_reads_test.cjs'
        evidence = EVIDENCE / self.token
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(evidence / 'spool'),
               'KIN_B2R_BUILD': os.environ.get('KIN_B2R_BUILD', str(ROOT / 'api/dist'))}
        if self.image:
            args = ['docker', 'run', '--rm', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                    '--network', self.network, '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2',
                    '--mount', 'type=bind,source=' + str(driver) + ',target=/app/report_reads_test.cjs,readonly']
            for key, value in {**env, 'KIN_B2R_BUILD': '/app/dist', 'KIN_B2R_SPOOL': '/tmp/report-reads-spool'}.items():
                if key in ('DATABASE_URL', 'KIN_B2R_WITNESS_URL', 'KIN_B2R_BUILD', 'KIN_B2R_SPOOL'):
                    args += ['-e', key + '=' + value]
            command = args + [self.image, 'node', '--test', '--test-reporter=tap', '/app/report_reads_test.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], '--test', '--test-reporter=tap', str(driver)]
        result = self.command(command, env=env, check=False, timeout=240)
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / 'node.stdout.log').write_text(result.stdout, encoding='utf-8')
        (evidence / 'node.stderr.log').write_text(result.stderr, encoding='utf-8')
        print(result.stdout)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:] or result.stdout[-2000:])


if __name__ == '__main__':
    unittest.main(verbosity=2)
