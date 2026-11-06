"""A node child that dies by a signal is named NATIVE_CRASH <signal> and leaves its evidence.

Pure: no PostgreSQL, container or live admission. The child is synthetic and kills itself.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pg_ledger_restore_test as pg

NODE = os.environ.get('KIN_B2R_NODE') or shutil.which('node')
EVIDENCE = ('stdout.log', 'stderr.log', 'dmesg.txt', 'runtime.json', 'versions.json', 'cgroup.txt')


@unittest.skipUnless(os.name == 'posix', 'node signals only itself on POSIX')
class NativeCrashEvidence(pg.PgLedgerFixture):
    @classmethod
    def setUpClass(cls):
        cls.image, cls.token, cls.container = None, 'native-crash', 'native-crash'

    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.work)
        # A synthetic crash must not read as a real one in the CI run summary.
        summary = mock.patch.dict(os.environ)
        summary.start()
        self.addCleanup(summary.stop)
        os.environ.pop('GITHUB_STEP_SUMMARY', None)

    def crash(self, command, **options):
        with self.assertRaises(AssertionError) as failed:
            self.run_node_case(command, self.work / 'evidence', **options)
        return str(failed.exception)

    def test_node_test_child_killed_by_sigsegv(self):
        child = self.work / 'crash_test.cjs'
        child.write_text("require('node:test')('synthetic crash',()=>{process.kill(process.pid,'SIGSEGV')});\n")
        message = self.crash([NODE, '--test', str(child)])
        self.assertEqual(message.splitlines()[0], 'NATIVE_CRASH SIGSEGV ' + str(self.work / 'evidence'))
        for name in EVIDENCE:
            self.assertTrue((self.work / 'evidence' / ('node.' + name)).is_file(), name)
        versions = json.loads((self.work / 'evidence/node.versions.json').read_text())
        actual = subprocess.run([NODE, '-p', 'process.version+" "+process.versions.openssl'],
                                capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual([versions['runtime']['node'], versions['runtime']['openssl']], actual)
        print((self.work / 'evidence/node.dmesg.txt').read_text())

    def test_direct_child_killed_by_sigsegv(self):
        message = self.crash([NODE, '-e', "process.kill(process.pid,'SIGSEGV')"])
        self.assertTrue(message.startswith('NATIVE_CRASH SIGSEGV '), message)

    def test_ordinary_failure_is_not_a_crash(self):
        message = self.crash([NODE, '-e', 'process.exit(3)'])
        self.assertTrue(message.startswith('exit 3 '), message)
        self.assertNotIn('NATIVE_CRASH', message)

    def test_timeout_keeps_streamed_output(self):
        message = self.crash([NODE, '-e', 'console.log("before hang");setInterval(()=>{},1000)'], timeout=3)
        self.assertTrue(message.startswith('TIMEOUT after 3s '), message)
        self.assertEqual((self.work / 'evidence/node.stdout.log').read_text(), 'before hang\n')
        self.assertTrue((self.work / 'evidence/node.dmesg.txt').is_file())

    def test_child_starts_with_openssl_cert_defaults(self):
        # The in-process Prisma engine then has no SSL_CERT_* to write into the child's environment; a caller's value wins.
        for key in pg.CERT_ENV:
            os.environ.pop(key, None)
        show = 'console.log(JSON.stringify([process.env.SSL_CERT_FILE ?? null, process.env.SSL_CERT_DIR ?? null]))'
        expected = [value if Path(value).exists() else None for value in pg.CERT_ENV.values()]
        self.assertEqual(json.loads(self.run_node_case([NODE, '-e', show], self.work / 'preset')), expected)
        own = self.run_node_case([NODE, '-e', show], self.work / 'own', env={**os.environ, 'SSL_CERT_FILE': '/own/cert.pem'})
        self.assertEqual(json.loads(own)[0], '/own/cert.pem')

    def test_success_leaves_only_its_output(self):
        self.run_node_case([NODE, '-e', 'console.log("ok")'], self.work / 'evidence')
        self.assertEqual(sorted(p.name for p in (self.work / 'evidence').iterdir()), ['node.stderr.log', 'node.stdout.log'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
