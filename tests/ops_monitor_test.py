"""TEST-C5-01..05: failure, maintenance, stale-heartbeat and notification boundaries."""
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_monitor as mon
import ops_notify as note

NOW = 1800000000
ORIGIN = 'https://pacs.example.test'
RUN = 'https://github.com/owner/private/actions/runs/1234'


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def rows():
    return [{'name': '/' + name, 'id': name, 'running': True, 'restarting': False,
             'restarts': 0, 'health': 'healthy'} for name in mon.NAMES]


def responses(**status):
    return {
        ORIGIN + '/ops-status.json': json.dumps(dict(schema=1, checked_at=NOW, ok=True,
                                                   maintenance_until=0, **status)).encode(),
        ORIGIN + '/api/health': b'{"ok":true,"auth":true}',
        ORIGIN + '/auth/realms/kin/.well-known/openid-configuration':
            json.dumps({'issuer': ORIGIN + '/auth/realms/kin'}).encode(),
        ORIGIN + '/worklist/hpacs-lite/index.html': b'<script>KinAuth.init()</script>',
    }


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.backups = self.root / 'backups'
        self.backups.mkdir()
        self.lock = self.root / '.kin-ops.lock'

    def tearDown(self):
        self.temp.cleanup()

    def manifest(self, index=0, **fields):
        folder = self.backups / f'20260906-01000{index}-12345678'
        folder.mkdir()
        row = {'format': 1, 'created_utc': iso(NOW - 60), 'complete': True, 'ready': True,
               'resume_failures': []}
        row.update(fields)
        (folder / 'manifest.json').write_text(json.dumps(row), encoding='utf-8')
        return folder

    def status(self):
        return mon.backup_status(self.backups, self.lock, NOW)

    def test_01_no_backup_and_old_backup_fail(self):
        self.assertEqual(self.status(), (['backup_missing'], 0))
        self.manifest(created_utc=iso(NOW - mon.BACKUP_AGE - 1))
        self.assertIn('backup_stale', self.status()[0])

    def test_02_complete_without_ready_is_not_success(self):
        self.manifest(ready=False)
        self.assertEqual(self.status(), (['backup_stale', 'backup_failed'], 0))

    def test_03_latest_failure_not_hidden_by_old_success(self):
        self.manifest(created_utc=iso(NOW - 3600))
        self.manifest(1, complete=False, ready=False, backup_error={'stage': 'secret'})
        self.assertEqual(self.status(), (['backup_failed'], 0))

    def test_04_maintenance_requires_matching_lock_and_expires(self):
        self.manifest(created_utc=iso(NOW - 3600))
        self.manifest(1, complete=False, ready=None)
        self.assertIn('backup_failed', self.status()[0])
        self.lock.write_text('owner-token')
        os.utime(self.lock, (NOW - 90, NOW - 90))
        self.assertEqual(self.status(), ([], NOW + 510))
        os.utime(self.lock, (NOW - 601, NOW - 601))
        self.assertEqual(self.status(), (['backup_failed'], 0))

    def test_05_failed_backup_lock_cannot_suppress(self):
        self.manifest(ready=False)
        self.lock.write_text('token')
        os.utime(self.lock, (NOW - 90, NOW - 90))
        self.assertEqual(self.status()[1], 0)

    def test_06_future_and_corrupt_manifest_fail(self):
        folder = self.manifest(created_utc=iso(NOW + 120))
        with self.assertRaises(ValueError):
            self.status()
        (folder / 'manifest.json').write_text('{bad')
        with self.assertRaises(ValueError):
            self.status()

    def test_07_restart_increments_accumulate_and_age_out(self):
        data = rows()
        faults, snapshot = mon.host_status(data, {}, NOW, 0)
        self.assertEqual(faults, [])
        for delta in (1, 2, 3):
            data[0]['restarts'] = delta
            faults, snapshot = mon.host_status(data, {'containers': snapshot}, NOW + delta, 0)
        self.assertIn('restart_loop', faults)
        self.assertNotIn('restart_loop', mon.host_status(data, {'containers': snapshot}, NOW + 305, 0)[0])

    def test_08_new_container_does_not_inherit_restart_counter(self):
        data = rows()
        previous = {'containers': {'kin-api': {'id': 'old', 'restarts': 100, 'events': [NOW] * 3}}}
        self.assertEqual(mon.host_status(data, previous, NOW, 0)[0], [])
        data[0]['restarting'] = True
        self.assertIn('restart_loop', mon.host_status(data, {}, NOW, 0)[0])

    def test_09_only_writers_may_pause(self):
        data = rows()
        data[0]['running'] = False
        self.assertEqual(mon.host_status(data, {}, NOW, NOW + 60)[0], [])
        data[3]['running'] = False
        self.assertIn('service_unready', mon.host_status(data, {}, NOW, NOW + 60)[0])
        with self.assertRaises(ValueError):
            mon.host_status(data[:-1], {}, NOW, 0)

    def test_10_external_health_requires_all_components(self):
        data = responses()
        self.assertTrue(mon.probe(ORIGIN, NOW, data.__getitem__)['ok'])
        data[ORIGIN + '/api/health'] = b'{"ok":true,"auth":false}'
        self.assertEqual(mon.probe(ORIGIN, NOW, data.__getitem__)['faults'], ['api_unavailable'])
        data[ORIGIN + '/auth/realms/kin/.well-known/openid-configuration'] = b'{"issuer":"wrong"}'
        data[ORIGIN + '/worklist/hpacs-lite/index.html'] = b'Login required'
        self.assertEqual(len(mon.probe(ORIGIN, NOW, data.__getitem__)['faults']), 3)

    def test_11_status_stale_future_and_schema_fail(self):
        for change in ({'checked_at': NOW - 181}, {'checked_at': NOW + 31}, {'ok': 'true'},
                       {'schema': True}, {'maintenance_until': NOW + 601}, {'private_secret': 'do not print'}):
            data = responses()
            state = json.loads(data[ORIGIN + '/ops-status.json'])
            state.update(change)
            data[ORIGIN + '/ops-status.json'] = json.dumps(state).encode()
            self.assertIn('collector_unavailable', mon.probe(ORIGIN, NOW, data.__getitem__)['faults'])

    def test_12_maintenance_skips_only_application_probes(self):
        data = responses()
        state = json.loads(data[ORIGIN + '/ops-status.json'])
        state['maintenance_until'] = NOW + 100
        data = {ORIGIN + '/ops-status.json': json.dumps(state).encode()}
        self.assertTrue(mon.probe(ORIGIN, NOW, data.__getitem__)['maintenance'])
        state['ok'] = False
        data[ORIGIN + '/ops-status.json'] = json.dumps(state).encode()
        result = mon.probe(ORIGIN, NOW, data.__getitem__)
        self.assertFalse(result['maintenance'])
        self.assertEqual(len(result['faults']), 4)

    def test_13_request_errors_are_redacted(self):
        def fail(url):
            raise RuntimeError('secret patient token')
        result = mon.probe(ORIGIN, NOW, fail)
        self.assertFalse(result['ok'])
        self.assertNotIn('secret', json.dumps(result))
        for origin in ('http://example.test', 'https://user:pass@example.test', 'https://example.test/path'):
            with self.assertRaises(ValueError):
                mon.probe(origin, NOW, fail)

    def test_14_atomic_write_and_symlink_refusal(self):
        target = self.root / 'result.json'
        mon.atomic_json(target, {'ok': True})
        self.assertEqual(mon.read_json(target), {'ok': True})
        if os.name == 'posix':
            link = self.root / 'alias'
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                mon.atomic_json(link, {})
            with self.assertRaises(ValueError):
                mon.read_json(link)

    @unittest.skipUnless(os.name == 'posix', 'Host collector uses Linux flock; exercised in Docker/CI')
    def test_15_collector_daemon_failure_publishes_redacted_failure(self):
        self.manifest()
        with patch.object(mon, 'inspect_containers', side_effect=RuntimeError('SECRET')), \
                patch.object(mon.time, 'time', return_value=NOW), redirect_stdout(io.StringIO()) as output:
            result = mon.collect(self.root, self.backups, self.root / 'private', self.root / 'public')
        self.assertEqual(result, 1)
        published = mon.read_json(self.root / 'public/status.json')
        self.assertEqual(set(published), {'schema', 'checked_at', 'ok', 'maintenance_until'})
        self.assertFalse(published['ok'])
        self.assertNotIn('SECRET', output.getvalue())

    @unittest.skipUnless(os.name == 'posix', 'Linux permissions tested in Docker/CI')
    def test_16_private_directory_permissions_preserved(self):
        path = self.root / 'shared'
        path.mkdir(mode=0o755)
        with self.assertRaises(ValueError):
            mon.prepare_dir(path, 0o700)
        self.assertEqual(path.stat().st_mode & 0o777, 0o755)

    def test_17_http_redirect_is_not_followed(self):
        class Handler(BaseHTTPRequestHandler):
            calls = []
            def do_GET(self):
                self.calls.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/secret-destination')
                self.end_headers()
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with self.assertRaises(Exception):
                mon.fetch('http://127.0.0.1:' + str(server.server_port) + '/')
            self.assertEqual(Handler.calls, ['/'])
        finally:
            server.shutdown()
            worker.join()
            server.server_close()

    @unittest.skipUnless(os.name == 'posix', 'Linux umask exercised in Docker/CI')
    def test_25_private_umask_normalizes_only_new_leaf(self):
        old = os.umask(0o077)
        try:
            mon.prepare_dir(self.root / 'new-public', 0o755)
            mon.prepare_dir(self.root / 'new-private', 0o700)
            self.assertEqual((self.root / 'new-public').stat().st_mode & 0o777, 0o755)
            self.assertEqual((self.root / 'new-private').stat().st_mode & 0o777, 0o700)
            existing = self.root / 'existing'
            existing.mkdir(mode=0o700)
            with self.assertRaises(ValueError):
                mon.prepare_dir(existing, 0o755)
            self.assertEqual(existing.stat().st_mode & 0o777, 0o700)
        finally:
            os.umask(old)


class FakeGitHub:
    def __init__(self, private=True, issues=None):
        self.private, self.issues, self.calls = private, issues or [], []
    def call(self, method, path='', data=None):
        self.calls.append((method, path, data))
        if path == '':
            return {'private': self.private, 'owner': {'login': 'owner'}}
        if method == 'GET':
            return self.issues
        if path == '/issues':
            return {'number': 1, 'assignees': [{'login': 'owner'}]}
        return {}


class NotifyTest(unittest.TestCase):
    def report(self, ok=False, maintenance=False):
        return {'ok': ok, 'checked_at': NOW, 'faults': [] if ok else ['host_unhealthy'], 'maintenance': maintenance}
    def issue(self, drill=False):
        return {'number': 12, 'user': {'login': 'github-actions[bot]'},
                'assignees': [{'login': 'owner'}],
                'body': note.MARKER + (' drill' if drill else ' live') + '\nbody'}

    def test_18_public_repository_refused(self):
        api = FakeGitHub(private=False)
        with self.assertRaises(ValueError):
            note.notify(api, self.report(), RUN)
        self.assertEqual(len(api.calls), 1)

    def test_19_first_failure_assigns_owner_without_raw_logs(self):
        api = FakeGitHub()
        self.assertEqual(note.notify(api, self.report(), RUN), 'opened')
        body = api.calls[-1][2]
        self.assertEqual(body['assignees'], ['owner'])
        self.assertTrue(body['body'].startswith(note.MARKER + ' live\n'))

    def test_20_existing_failure_does_not_spam(self):
        api = FakeGitHub(issues=[self.issue()])
        self.assertEqual(note.notify(api, self.report(), RUN), 'ongoing')
        self.assertEqual([x for x in api.calls if x[0] != 'GET'], [])

    def test_21_recovery_and_maintenance_differ(self):
        api = FakeGitHub(issues=[self.issue()])
        self.assertEqual(note.notify(api, self.report(True, True), RUN), 'maintenance')
        self.assertEqual([x for x in api.calls if x[0] != 'GET'], [])
        self.assertEqual(note.notify(api, self.report(True), RUN), 'recovered')
        self.assertEqual(api.calls[-1][2]['state'], 'closed')

    def test_22_drill_cannot_close_live_or_human_issue(self):
        issue = self.issue(True)
        issue['user']['login'] = 'owner'
        api = FakeGitHub(issues=[self.issue(), issue])
        self.assertEqual(note.notify(api, self.report(True), RUN, drill=True), 'healthy')
        self.assertEqual([x for x in api.calls if x[0] != 'GET'], [])

    def test_23_untrusted_report_and_link_refused(self):
        report = self.report()
        report['faults'].append('patient-secret')
        with self.assertRaises(ValueError):
            note.notify(FakeGitHub(), report, RUN)
        with self.assertRaises(ValueError):
            note.notify(FakeGitHub(), self.report(), 'https://attacker.test/')

    def test_24_delivery_error_propagates(self):
        api = FakeGitHub()
        original = api.call
        def call(method, path='', data=None):
            if method == 'POST':
                raise TimeoutError('transport')
            return original(method, path, data)
        api.call = call
        with self.assertRaises(TimeoutError):
            note.notify(api, self.report(), RUN)


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
