"""CD-03: observable query, append-only evidence and notification behavior.

The byte-prefix assertion verifies the required preservation of prior records.
All OSV and GitHub responses are synthetic; no server or credentials are used.
"""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

import ops_soup_vulns as soup
import ops_notify


def component(name='example', version='1.2.3', **fields):
    return dict(name=name, version=version, origin='api/package-lock.json:node_modules/' + name,
                section='API', **fields)


VULN = {'id': 'GHSA-example', 'aliases': ['CVE-other'],
        'severity': [{'type': 'CVSS_V3', 'score': 'CVSS:3.1/AV:N'}]}


class SoupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.out = self.root / 'components.json', self.root / 'history.jsonl'
        self.write_components([component()])

    def write_components(self, rows):
        self.source.write_text(json.dumps({'schema_version': 1, 'components': rows}), encoding='utf-8')

    def run_scan(self, responses):
        with patch.object(soup, 'post_osv', side_effect=responses) as query, \
                patch.object(soup, 'send_notification', return_value='opened') as notify, \
                contextlib.redirect_stdout(io.StringIO()):
            code = soup.main(['--components', str(self.source), '--out', str(self.out), '--timeout', '30'])
        return code, query, notify, json.loads(self.out.read_text(encoding='utf-8').splitlines()[-1])

    def test_new_then_repeat_preserves_history_and_notifies_once(self):
        self.write_components([component(scope='Development')])
        code, query, notify, first = self.run_scan([{'vulns': [VULN]}])
        self.assertEqual(code, 0)
        self.assertEqual(query.call_args.args[0], {'package': {'ecosystem': 'npm', 'name': 'example'}, 'version': '1.2.3'})
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0], 1)
        row = first['components'][0]
        self.assertEqual((row['scope'], row['section']), ('Development', 'API'))
        self.assertEqual(row['findings'][0]['aliases'], VULN['aliases'])
        self.assertEqual((row['component'], row['version'], row['findings'][0]['identifier']), ('example', '1.2.3', 'GHSA-example'))
        self.assertEqual(row['findings'][0]['severity'], VULN['severity'])
        self.assertEqual(row['findings'][0]['impact'], '미판정')
        self.assertTrue(first['date'])
        prefix = self.out.read_bytes()
        code, _, notify, second = self.run_scan([{'vulns': [VULN]}])
        self.assertEqual(code, 0)
        notify.assert_not_called()
        self.assertEqual(second['new_items'], 0)
        self.assertTrue(self.out.read_bytes().startswith(prefix))
        self.assertEqual(len(self.out.read_text().splitlines()), 2)

    def test_network_failure_is_not_zero_findings(self):
        code, _, notify, record = self.run_scan([URLError('synthetic private detail')])
        self.assertNotEqual(code, 0)
        notify.assert_not_called()
        self.assertEqual(record['status'], 'FAILED')
        self.assertEqual(record['failed'], 1)
        self.assertIsNone(record['found'])
        self.assertIsNone(record['new_items'])
        self.assertEqual(record['components'][0]['status'], 'FAILED')
        self.assertNotIn('synthetic private detail', self.out.read_text())

    def test_unqueryable_rows_are_counted_with_reasons(self):
        self.write_components([component(version='^1.2.3'),
                               dict(name='image OS packages', version='node:22-slim', section='Containers', origin='api/Dockerfile'),
                               dict(name='requests', version='2.32.5', section='Gateway', origin='gateway/agent/requirements.txt')])
        code, query, notify, record = self.run_scan([{}])
        self.assertEqual(code, 0)
        self.assertEqual((record['queried'], record['unqueried'], record['found']), (1, 2, 0))
        self.assertEqual(query.call_args.args[0]['package']['ecosystem'], 'PyPI')
        notify.assert_not_called()
        for row in record['components'][:2]:
            self.assertEqual(row['status'], 'NOT_QUERIED')
            self.assertTrue(row['reason'].startswith('미조회:'))
            self.assertIsNone(row['findings'])

    def test_partial_failure_retains_success_and_is_failure(self):
        self.write_components([component(), component('second')])
        code, _, notify, record = self.run_scan([{'vulns': [VULN]}, TimeoutError()])
        self.assertNotEqual(code, 0)
        self.assertEqual((record['queried'], record['failed'], record['observed_findings']), (1, 1, 1))
        self.assertIsNone(record['found'])
        notify.assert_called_once()

    def test_pagination_and_duplicate_ids(self):
        code, query, notify, record = self.run_scan([
            {'vulns': [VULN], 'next_page_token': 'next'}, {'vulns': [VULN, {'id': 'CVE-other'}]}])
        self.assertEqual(code, 0)
        self.assertEqual(query.call_args.args[0]['page_token'], 'next')
        self.assertEqual(record['found'], 2)
        self.assertEqual(notify.call_args.args[0], 2)
        self.assertEqual(record['components'][0]['findings'][1]['severity'], '미제공')
        self.assertEqual(record['components'][0]['findings'][1]['aliases'], [])

    def test_bad_response_and_incomplete_pagination_fail(self):
        for responses in ([{'error': 'unavailable'}], [{'vulns': None}], [{'vulns': [{}]}],
                          [{'next_page_token': 'same'}, {'next_page_token': 'same'}],
                          [{'vulns': [VULN], 'next_page_token': 'next'}, URLError('failure')]):
            with self.subTest(responses=responses):
                code, _, _, record = self.run_scan(responses)
                self.assertNotEqual(code, 0)
                self.assertIsNone(record['found'])

    def test_key_includes_component_and_version(self):
        self.run_scan([{'vulns': [VULN]}])
        self.write_components([component(version='1.2.4'), component('different')])
        code, _, notify, record = self.run_scan([{'vulns': [VULN]}, {'vulns': [VULN]}])
        self.assertEqual(code, 0)
        self.assertEqual(record['new_items'], 2)
        self.assertEqual(notify.call_args.args[0], 2)

    def test_notification_failure_is_retained(self):
        with patch.object(soup, 'send_notification', side_effect=ValueError('secret')), \
                patch.object(soup, 'post_osv', return_value={'vulns': [VULN]}), \
                contextlib.redirect_stdout(io.StringIO()):
            code = soup.main(['--components', str(self.source), '--out', str(self.out), '--timeout', '30'])
        record = json.loads(self.out.read_text(encoding='utf-8'))
        self.assertNotEqual(code, 0)
        self.assertEqual(record['notification']['status'], 'FAILED')
        self.assertNotIn('secret', self.out.read_text())

    def test_failed_notification_retries_same_count_then_stops_after_success(self):
        with patch.object(soup, 'send_notification', side_effect=OSError('offline')) as failed, \
                patch.object(soup, 'post_osv', return_value={'vulns': [VULN]}):
            first = soup.scan(self.source, self.out, 30)
        self.assertEqual(first['notification']['status'], 'FAILED')
        prefix = self.out.read_bytes()
        code, _, notify, second = self.run_scan([{'vulns': [VULN]}])
        self.assertEqual(code, 0)
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0], failed.call_args.args[0])
        self.assertEqual(second['new_items'], first['new_items'])
        self.assertEqual(second['notification']['status'], 'SENT')
        self.assertTrue(self.out.read_bytes().startswith(prefix))
        code, _, notify, third = self.run_scan([{'vulns': [VULN]}])
        self.assertEqual(code, 0)
        notify.assert_not_called()
        self.assertEqual(third['new_items'], 0)
        self.assertEqual(len(self.out.read_text(encoding='utf-8').splitlines()), 3)

    def test_bad_input_or_history_is_preserved_and_fails(self):
        for target in (self.source, self.out):
            with self.subTest(target=target):
                target.write_text('{broken', encoding='utf-8')
                prefix = self.out.read_bytes() if self.out.exists() else b''
                code, query, notify, record = self.run_scan([])
                self.assertNotEqual(code, 0)
                query.assert_not_called()
                notify.assert_not_called()
                self.assertEqual(record['status'], 'FAILED')
                self.assertTrue(self.out.read_bytes().startswith(prefix))
                self.write_components([component()])

    def test_actual_transport_uses_osv_and_deadline(self):
        with patch.object(soup, 'urlopen') as opened, patch.object(soup.time, 'monotonic', return_value=10):
            opened.return_value.__enter__.return_value.read.return_value = b'{}'
            self.assertEqual(soup.post_osv({'version': '1.2.3'}, 12), {})
            request = opened.call_args.args[0]
            self.assertEqual(request.full_url, 'https://api.osv.dev/v1/query')
            self.assertEqual(json.loads(request.data), {'version': '1.2.3'})
            self.assertEqual(opened.call_args.kwargs['timeout'], 2)
            opened.reset_mock()
            with self.assertRaises(TimeoutError):
                soup.post_osv({}, 10)
            opened.assert_not_called()

    def test_existing_notification_channel_creates_one_private_issue(self):
        from unittest.mock import Mock
        api = Mock()
        api.call.side_effect = [{'private': True, 'owner': {'login': 'owner'}}, {'assignees': [{'login': 'owner'}]}]
        self.assertEqual(ops_notify.notify_soup(api, 3, 1800000000, 'https://github.com/owner/private/actions/runs/123'), 'opened')
        posts = [call for call in api.call.call_args_list if call.args[0] == 'POST']
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0].args[1], '/issues')
        self.assertIn('3', posts[0].args[2]['body'])
        self.assertNotIn(ops_notify.MARKER, posts[0].args[2]['body'])
        api.reset_mock()
        api.call.side_effect = [{'private': False}]
        with self.assertRaises(ValueError):
            ops_notify.notify_soup(api, 1, 1800000000, 'https://github.com/owner/private/actions/runs/123')
        self.assertEqual(api.call.call_count, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
