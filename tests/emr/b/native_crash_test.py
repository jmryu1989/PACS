"""A node child that dies by a signal is named NATIVE_CRASH <signal> and leaves its evidence.

Pure: no PostgreSQL, container or live admission. The child is synthetic and kills itself.
"""
import contextlib
import io
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
        # Both names exist before the in-process Prisma engine starts, so its own setenv of them updates in place and never
        # grows the environment array (CERT_ENV); a caller's value wins.
        for key in pg.CERT_ENV:
            os.environ.pop(key, None)
        show = 'console.log(JSON.stringify([process.env.SSL_CERT_FILE ?? null, process.env.SSL_CERT_DIR ?? null]))'
        expected = [value if Path(value).exists() else None for value in pg.CERT_ENV.values()]
        self.assertEqual(json.loads(self.run_node_case([NODE, '-e', show], self.work / 'preset')), expected)
        own = self.run_node_case([NODE, '-e', show], self.work / 'own', env={**os.environ, 'SSL_CERT_FILE': '/own/cert.pem'})
        self.assertEqual(json.loads(own)[0], '/own/cert.pem')

    def test_children_outside_run_node_case_start_with_the_preset(self):
        # B probe/upgrade use command(), AccessReview Popen; both take cert_preset's (command, env).
        for key in pg.CERT_ENV:
            os.environ.pop(key, None)
        show = 'console.log(JSON.stringify([process.env.SSL_CERT_FILE ?? null, process.env.SSL_CERT_DIR ?? null]))'
        expected = [value if Path(value).exists() else None for value in pg.CERT_ENV.values()]
        command, env = self.cert_preset([NODE, '-e', show], {**os.environ, 'KIN_PROBE': '1'})
        self.assertEqual(json.loads(self.command(command, env=env).stdout), expected)
        self.assertEqual(env['KIN_PROBE'], '1')
        with (self.work / 'popen.log').open('w') as log:
            subprocess.Popen(command, env=env, stdout=log).wait(timeout=30)
        self.assertEqual(json.loads((self.work / 'popen.log').read_text()), expected)
        # A docker run gets -e before its own options; a caller's -e value wins.
        docker, unchanged = self.cert_preset(['docker', 'run', '--rm', '-e', 'SSL_CERT_DIR=/own', 'image', 'node'])
        self.assertIsNone(unchanged)
        self.assertEqual(docker, ['docker', 'run', '-e', 'SSL_CERT_FILE=/usr/lib/ssl/cert.pem', '--rm',
                                  '-e', 'SSL_CERT_DIR=/own', 'image', 'node'])

    def test_failed_child_record_reaches_the_ci_artifact(self):
        # The G3 profile uploads only its artifact directory; measurement_ci copies the named record into it.
        import measurement_ci as ci
        evidence = self.work / 'tmp/emr-e-online/pg-synthetic'
        child = "process.stderr.write('token synthetic-secret\\n');process.kill(process.pid,'SIGSEGV')"
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed), self.assertRaises(AssertionError):
            self.run_node_case([NODE, '-e', child], evidence)
        out = self.work / 'artifacts/candidate-ci'
        out.mkdir(parents=True)
        # A named directory outside the checkout's tmp/ is never copied.
        (self.work / 'outside').mkdir()
        (self.work / 'outside/node.dmesg.txt').write_text('outside')
        (out / 'online_live.log').write_text(printed.getvalue() + 'exit 1 ' + str(self.work / 'outside') + '\n',
                                             encoding='utf-8')
        with mock.patch.object(ci, 'ROOT', self.work):
            kept = ci.keep_child_records(out, 'online_live', ['synthetic-secret'])
        copied = out / 'child-online_live/emr-e-online/pg-synthetic'
        self.assertEqual(sorted(kept), sorted('child-online_live/emr-e-online/pg-synthetic/' + p.name
                                              for p in copied.iterdir()))
        self.assertEqual(sorted(p.name for p in copied.iterdir()),
                         ['node.cgroup.txt', 'node.dmesg.txt', 'node.runtime.json', 'node.stderr.log', 'node.versions.json'])
        self.assertEqual((copied / 'node.stderr.log').read_text(), 'token [REDACTED]\n')
        self.assertEqual(json.loads((copied / 'node.versions.json').read_text()),
                         json.loads((evidence / 'node.versions.json').read_text()))

    def test_success_leaves_only_its_output(self):
        self.run_node_case([NODE, '-e', 'console.log("ok")'], self.work / 'evidence')
        self.assertEqual(sorted(p.name for p in (self.work / 'evidence').iterdir()), ['node.stderr.log', 'node.stdout.log'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
