"""REQ-CI-RERUN-DIAGNOSTIC -> RISK-FALSE-RECEIPT/LOSS -> R5-PS-01..07.

Exercise the shipped CLI with a native gh mock, including valid payloads with
nonzero exits. Only OS write/read failures are injected in-process.
"""

import atexit
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'scripts/collect-rerun-diagnostic.py'
_MOCK = None


def native_mock():
    global _MOCK
    if _MOCK is not None:
        return _MOCK
    temporary = tempfile.TemporaryDirectory(prefix='rerun-native-gh-')
    atexit.register(temporary.cleanup)
    root = Path(temporary.name)
    if os.name == 'nt':
        source = root / 'MockGh.cs'
        source.write_text('''using System; using System.IO;
class MockGh {
  static int Main(string[] args) {
    string root = Environment.GetEnvironmentVariable("RERUN_MOCK_ROOT");
    File.AppendAllText(Path.Combine(root, "calls.log"), String.Join("|", args) + "\\n");
    string stage;
    if (args.Length == 7 && args[0] == "run" && args[1] == "view" && args[2] == "42" && args[3] == "--repo" && args[4] == "o/r") stage = "run";
    else if (args.Length == 4 && args[0] == "api" && args[1] == "--method" && args[2] == "GET" && args[3] == "repos/o/r/actions/artifacts/99") stage = "metadata";
    else if (args.Length == 4 && args[0] == "api" && args[1] == "--method" && args[2] == "GET" && args[3] == "repos/o/r/actions/artifacts/99/zip") stage = "download";
    else { Console.Error.WriteLine("MOCK_UNEXPECTED_COMMAND"); return 93; }
    byte[] data = File.ReadAllBytes(Path.Combine(root, stage + ".stdout"));
    Console.OpenStandardOutput().Write(data, 0, data.Length);
    Console.Error.Write("MOCK_" + stage + "_STDERR");
    return Int32.Parse(File.ReadAllText(Path.Combine(root, stage + ".exit")));
  }
}
''', encoding='utf-8')
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        result = subprocess.run([str(compiler), '/nologo', '/out:' + str(root / 'gh.exe'), str(source)], capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stdout.decode(errors='replace'))
    else:
        executable = root / 'gh'
        executable.write_text('#!' + sys.executable + '''
import os, sys
from pathlib import Path
root = Path(os.environ['RERUN_MOCK_ROOT'])
args = sys.argv[1:]
with (root / 'calls.log').open('a') as log:
    log.write('|'.join(args) + '\\n')
if len(args) == 7 and args[:5] == ['run', 'view', '42', '--repo', 'o/r']:
    stage = 'run'
elif args == ['api', '--method', 'GET', 'repos/o/r/actions/artifacts/99']:
    stage = 'metadata'
elif args == ['api', '--method', 'GET', 'repos/o/r/actions/artifacts/99/zip']:
    stage = 'download'
else:
    sys.exit(93)
sys.stdout.buffer.write((root / (stage + '.stdout')).read_bytes())
sys.stderr.write('MOCK_' + stage + '_STDERR')
sys.exit(int((root / (stage + '.exit')).read_text()))
''', encoding='utf-8')
        executable.chmod(0o755)
    _MOCK = root
    return root


class Fixture:
    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='rerun-cli-')
        self.base = Path(self.temporary.name)
        self.root = self.base / 'repository space 한글'
        (self.root / 'scripts').mkdir(parents=True)
        shutil.copyfile(CLI, self.root / 'scripts/collect-rerun-diagnostic.py')
        self.out = self.root / 'tmp' / 'diagnostic space 한글'
        self.out.mkdir(parents=True)
        self.mock = self.base / 'responses'
        self.mock.mkdir()
        self.cwd = self.base / 'process cwd'
        self.cwd.mkdir()
        self.run = dict(databaseId=42, attempt=2, status='completed', conclusion='success',
                        headSha='a' * 40, event='push', workflowName='validate')
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('synthetic.bin', b'original\x00\xff\r\n')
        self.archive = stream.getvalue()
        self.metadata = dict(id=99, workflow_run=dict(id=42),
                             url='https://api.github.com/repos/o/r/actions/artifacts/99',
                             digest='sha256:' + hashlib.sha256(self.archive).hexdigest())
        for stage, value in (('run', self.run), ('metadata', self.metadata), ('download', self.archive)):
            self.response(stage, value)
        self.env = dict(os.environ, PATH=str(native_mock()) + os.pathsep + os.environ['PATH'],
                        RERUN_MOCK_ROOT=str(self.mock))
        self.env.pop('PSModulePath', None)

    def response(self, stage, value, exit_code=0):
        (self.mock / (stage + '.stdout')).write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())
        (self.mock / (stage + '.exit')).write_text(str(exit_code), encoding='ascii')

    def args(self):
        return ['--repository', 'o/r', '--run-id', '42', '--artifact-id', '99',
                '--out', 'tmp/diagnostic space 한글']

    def invoke(self, args=None):
        return subprocess.run([sys.executable, '-B', str(self.root / 'scripts/collect-rerun-diagnostic.py'),
                               *(self.args() if args is None else args)], cwd=self.cwd, env=self.env, capture_output=True)

    def calls(self):
        path = self.mock / 'calls.log'
        return path.read_text().splitlines() if path.exists() else []

    def close(self):
        self.temporary.cleanup()


def check_documented_invocation(test):
    shells = list(dict.fromkeys(path for name in ('powershell', 'pwsh') if (path := shutil.which(name))))
    if not shells:
        test.skipTest('PowerShell unavailable; separate Windows validation required')
    doc = (ROOT / 'tests/stage-exit.md').read_text(encoding='utf-8')
    block = next(block for block in re.findall(r'```powershell\n(.*?)```', doc, re.S)
                 if block.startswith('python -B scripts/collect-rerun-diagnostic.py '))
    for shell in shells:
        for case in ('success', 'digest-absent', 'view-failure'):
            with test.subTest(shell=shell, case=case):
                fixture = Fixture()
                try:
                    if case == 'digest-absent':
                        del fixture.metadata['digest']
                        fixture.response('metadata', fixture.metadata)
                    if case == 'view-failure':
                        fixture.response('run', fixture.run, 17)
                    script = fixture.base / 'invoke.ps1'
                    # Deliberately no Stop policy and no absolute $out injection.
                    quoted_root = str(fixture.root).replace("'", "''")
                    script.write_text("Set-Location -LiteralPath '" + quoted_root + "'\n"
                                      "$repository = 'o/r'\n$stoppedRun = 42\n$artifactId = 99\n"
                                      "$out = 'tmp/diagnostic space 한글'\n" + block,
                                      encoding='utf-8-sig')
                    result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-File', str(script)],
                                            cwd=fixture.cwd, env=fixture.env, capture_output=True)
                    receipt = fixture.out / 'manual-42-99.json'
                    if case == 'success':
                        test.assertEqual(result.returncode, 0, result.stderr)
                        data = json.loads(receipt.read_bytes())
                        archive = Path(data['archive'])
                        test.assertTrue(archive.is_absolute())
                        test.assertEqual(archive.parent, fixture.out)
                        test.assertEqual(data['digest'], 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest())
                        test.assertEqual(data['advertised_digest'], data['digest'])
                    else:
                        test.assertNotEqual(result.returncode, 0)
                        test.assertFalse(receipt.exists())
                        code = b'RERUN_DIGEST_REQUIRED' if case == 'digest-absent' else b'RERUN_RUN_VIEW_FAILED'
                        test.assertIn(code, result.stderr)
                    test.assertFalse((fixture.cwd / 'tmp').exists())
                finally:
                    fixture.close()


class RerunDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)

    def failure(self, result, code, downloads=0):
        self.assertEqual(result.returncode, 1, result.stderr)
        error = json.loads(result.stderr)
        self.assertEqual(error['code'], code)
        self.assertEqual((error['run_id'], error['artifact_id']), (42, 99))
        self.assertFalse((self.fixture.out / 'manual-42-99.json').exists())
        self.assertEqual(sum(line.endswith('/zip') for line in self.fixture.calls()), downloads)
        return error

    def test_documented_invocation_uses_repo_root_after_set_location(self):
        check_documented_invocation(self)

    def test_success_is_diagnostic_only_and_preserves_native_bytes_and_logs(self):
        fixture = self.fixture
        result = fixture.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['repository'], 'o/r')
        self.assertEqual((data['run_id'], data['attempt'], data['artifact_id']), (42, 2, 99))
        self.assertEqual(data['use'], 'diagnostic-only')
        self.assertIs(data['producer_attempt_verified'], False)
        self.assertEqual(data['advertised_digest'], data['digest'])
        self.assertEqual(Path(data['archive']).read_bytes(), fixture.archive)
        self.assertEqual(json.loads((fixture.out / 'manual-42-99.json').read_bytes()), data)
        self.assertTrue(all(byte < 128 for byte in result.stdout))
        logs = Path(data['logs'])
        self.assertEqual((logs / 'run-view.stdout.log').read_bytes(), (fixture.mock / 'run.stdout').read_bytes())
        self.assertEqual((logs / 'download.stderr.log').read_bytes(), b'MOCK_download_STDERR')
        self.assertEqual(len(fixture.calls()), 3)

    def test_absolute_output_and_explicit_repo_root_override(self):
        fixture = self.fixture
        for absolute in (False, True):
            with self.subTest(absolute=absolute):
                output = fixture.base / ('override-' + str(absolute))
                args = fixture.args()[:-2] + ['--repo-root', str(fixture.base), '--out', str(output) if absolute else output.name]
                result = fixture.invoke(args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(Path(json.loads(result.stdout)['archive']).parent, output)

    def test_required_digest_absent_empty_malformed_and_mismatching(self):
        fixture = self.fixture
        for value in (None, '', 'sha256:wrong', 'md5:' + 'a' * 64, 'sha256:' + 'b' * 64):
            with self.subTest(value=value):
                fixture.metadata.pop('digest', None)
                if value is not None:
                    fixture.metadata['digest'] = value
                fixture.response('metadata', fixture.metadata)
                mismatch = value == 'sha256:' + 'b' * 64
                self.failure(fixture.invoke(), 'RERUN_DIGEST_MISMATCH' if mismatch else 'RERUN_DIGEST_REQUIRED', int(mismatch))
        self.assertEqual((fixture.out / 'manual-42-99.zip').read_bytes(), fixture.archive)

    def test_usage_errors_never_call_gh(self):
        for option in ('--run-id', '--artifact-id', '--repository', '--out'):
            for value in (None, '0', '-1', 'abc') if option.endswith('-id') else (None,):
                with self.subTest(option=option, value=value):
                    args = self.fixture.args()
                    index = args.index(option)
                    if value is None:
                        del args[index:index + 2]
                    else:
                        args[index + 1] = value
                    result = self.fixture.invoke(args)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(self.fixture.calls(), [])

    def test_run_fields_and_metadata_identity_rejected_before_download(self):
        fixture = self.fixture
        for field, value in (('databaseId', 7), ('databaseId', '42'), ('attempt', 0),
                             ('attempt', True), ('headSha', 'wrong'), ('status', None),
                             ('event', ''), ('workflowName', None), ('conclusion', [])):
            with self.subTest(field=field, value=value):
                fixture.response('run', dict(fixture.run, **{field: value}))
                self.failure(fixture.invoke(), 'RERUN_RUN_INVALID')
        fixture.response('run', fixture.run)
        for change in ({'id': 7}, {'id': '99'}, {'workflow_run': {'id': 7}},
                       {'workflow_run': None}, {'url': 'https://api.github.com/repos/other/repo/actions/artifacts/99'}):
            with self.subTest(change=change):
                fixture.response('metadata', dict(fixture.metadata, **change))
                self.failure(fixture.invoke(), 'RERUN_ARTIFACT_INVALID')

    def test_valid_run_json_with_nonzero_exit_is_rejected(self):
        self.fixture.response('run', self.fixture.run, 17)
        self.failure(self.fixture.invoke(), 'RERUN_RUN_VIEW_FAILED')
        self.assertEqual(len(self.fixture.calls()), 1)

    def test_metadata_failure_and_invalid_json_have_no_receipt(self):
        for body, exit_code, code in ((self.fixture.metadata, 9, 'RERUN_METADATA_FAILED'),
                                     (b'not json', 0, 'RERUN_ARTIFACT_INVALID')):
            with self.subTest(exit_code=exit_code):
                self.fixture.response('metadata', body, exit_code)
                self.failure(self.fixture.invoke(), code)

    def test_nonzero_download_preserves_complete_or_partial_bytes(self):
        for payload in (self.fixture.archive, b'partial\x00\xff'):
            with self.subTest(payload=payload):
                fixture = Fixture()
                try:
                    fixture.response('download', payload, 19)
                    result = fixture.invoke()
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(json.loads(result.stderr)['code'], 'RERUN_DOWNLOAD_FAILED')
                    self.assertEqual((fixture.out / 'manual-42-99.zip').read_bytes(), payload)
                    self.assertFalse((fixture.out / 'manual-42-99.json').exists())
                finally:
                    fixture.close()

    def test_existing_archive_is_never_overwritten(self):
        archive = self.fixture.out / 'manual-42-99.zip'
        original = b'preserved different bytes\x00\xff'
        archive.write_bytes(original)
        self.failure(self.fixture.invoke(), 'RERUN_ARCHIVE_WRITE_FAILED')
        self.assertEqual(archive.read_bytes(), original)

    def test_existing_receipt_is_never_overwritten(self):
        receipt = self.fixture.out / 'manual-42-99.json'
        original = b'preserved receipt\x00\xff'
        receipt.write_bytes(original)
        result = self.fixture.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr)['code'], 'RERUN_RECEIPT_WRITE_FAILED')
        self.assertEqual(receipt.read_bytes(), original)
        self.assertEqual((self.fixture.out / 'manual-42-99.zip').read_bytes(), self.fixture.archive)

    def module(self):
        spec = importlib.util.spec_from_file_location('rerun_diagnostic_under_test', CLI)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_archive_read_failure_has_no_receipt(self):
        module = self.module()
        original_open = Path.open
        def unreadable(path, mode='r', *args, **kwargs):
            if path.name == 'manual-42-99.zip' and mode == 'rb':
                raise PermissionError('synthetic archive read failure')
            return original_open(path, mode, *args, **kwargs)
        stderr = io.StringIO()
        with patch.dict(os.environ, self.fixture.env), patch.object(Path, 'open', unreadable), redirect_stderr(stderr):
            code = module.main([*self.fixture.args(), '--repo-root', str(self.fixture.root)])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stderr.getvalue())['code'], 'RERUN_ARCHIVE_READ_FAILED')
        self.assertFalse((self.fixture.out / 'manual-42-99.json').exists())

    def test_partial_receipt_write_removes_only_its_new_receipt(self):
        module = self.module()
        unrelated = self.fixture.out / 'manual-other.json'
        unrelated.write_bytes(b'preserve')
        def fail_write(value, stream, **kwargs):
            stream.write('{"partial":')
            raise OSError('synthetic full disk')
        stderr = io.StringIO()
        with patch.dict(os.environ, self.fixture.env), patch.object(module.json, 'dump', fail_write), redirect_stderr(stderr):
            code = module.main([*self.fixture.args(), '--repo-root', str(self.fixture.root)])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stderr.getvalue())['code'], 'RERUN_RECEIPT_WRITE_FAILED')
        self.assertFalse((self.fixture.out / 'manual-42-99.json').exists())
        self.assertEqual(unrelated.read_bytes(), b'preserve')
        self.assertEqual((self.fixture.out / 'manual-42-99.zip').read_bytes(), self.fixture.archive)
        self.assertTrue(list(self.fixture.out.glob('rerun-*/download.stderr.log')))

    def test_receipt_does_not_claim_run_success(self):
        self.fixture.run.update(status='in_progress', conclusion=None)
        self.fixture.response('run', self.fixture.run)
        result = self.fixture.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertIsNone(receipt['run']['conclusion'])
        self.assertIs(receipt['producer_attempt_verified'], False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
