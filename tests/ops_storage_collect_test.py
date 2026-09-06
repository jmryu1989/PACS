"""REQ/RISK/TEST-C4U-01..06: synthetic credentials and TLS loopback only."""
from datetime import datetime, timezone
import http.server
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, quote, quote_plus, urlencode, urlsplit
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import ops_storage_collect as collect

BUCKET, PREFIX = 'kin-synthetic-only', 'kin/c4/'
TOKEN = 'opaque+/%=='
KEYS = [PREFIX+'sample%20 space+é.dcm', PREFIX+'second.unk', PREFIX+'third.unk']
SECRET = {'access_key_id': 'SYNTHETIC-ONLY', 'secret_access_key': 'SYNTHETIC-SECRET-NO-ACCOUNT',
          'session_token': 'SYNTHETIC-TOKEN'}


def config():
    return dict(schema=1, endpoint='https://127.0.0.1:9444', region='us-east-1', bucket=BUCKET,
                prefix=PREFIX, expected_owner='000000000000', credentials_file=str(Path.cwd()/'secret.json'),
                storage_profile=collect.core.PROFILE)


def response(**changes):
    body = dict(Name=BUCKET, Prefix=quote(PREFIX, safe=''), MaxKeys=1000, KeyCount=1, IsTruncated=False,
                Contents=[dict(Key=quote(KEYS[0], safe=''), Size=31, LastModified=datetime.now(timezone.utc))],
                EncodingType='url', ResponseMetadata={'HTTPStatusCode': 200})
    body.update(changes)
    return body


class Pure(unittest.TestCase):
    def test_01_config_scope(self):
        body = config()
        self.assertEqual(collect.config_body(collect.private.encode(body)), body)
        for field, value in [('endpoint', 'http://localhost'), ('endpoint', 'https://u:p@localhost'),
                             ('endpoint', 'https://localhost/path'), ('endpoint', 'https://localhost/?x=1'),
                             ('expected_owner', '12'), ('schema', True), ('credentials_file', 'relative'),
                             ('ca_file', '/tmp/ca'), ('region', 'a/b')]:
            with self.subTest(field=field, value=value), self.assertRaises((ValueError, TypeError)):
                collect.config_body(collect.private.encode(dict(body, **{field: value})))

    def test_02_exact_once_and_datetime_projection(self):
        page = collect.normalize(response(), None)
        self.assertEqual(page['response']['Contents'], [{'Key': KEYS[0], 'Size': 31}])
        self.assertEqual(collect.decode('%2520'), '%20')
        self.assertEqual(collect.decode('a+b%2Bc%2520'), 'a b+c%20')
        for invalid in ('%', '%0', '%GG', '%ff', 'é'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                collect.decode(invalid)

    def test_03_bad_sdk_envelopes(self):
        for changes in ({'ResponseMetadata': {'HTTPStatusCode': 403}}, {'EncodingType': 'xml'},
                        {'CommonPrefixes': []}, {'RequestCharged': 'requester'}, {'Contents': None},
                        {'Contents': [{'Key': 'k', 'Size': 1, 'Mystery': True}]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                collect.normalize(response(**changes), None)

    def test_04_guard_blocks_scope_operation_body_and_extra_query(self):
        guard = collect.RequestGuard(config())
        query = {'list-type': '2', 'prefix': PREFIX, 'max-keys': '1000', 'encoding-type': 'url'}
        req = SimpleNamespace(url=config()['endpoint']+'/'+BUCKET+'?'+urlencode(query), method='GET', body=None,
                              headers={'X-Amz-Expected-Bucket-Owner': b'000000000000'})
        guard(req, event_name='before-send.s3.ListObjectsV2')
        for changes in ({'url': req.url.replace('127.0.0.1', 'localhost')}, {'url': req.url+'&x=1'},
                        {'url': req.url.replace(BUCKET, 'wrong-bucket')}, {'method': 'PUT'}, {'body': b'x'},
                        {'headers': {'x-amz-expected-bucket-owner': '111111111111'}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                guard(SimpleNamespace(**dict(vars(req), **changes)), event_name='before-send.s3.ListObjectsV2')
        with self.assertRaises(ValueError):
            guard(req, event_name='before-send.s3.HeadBucket')
        with patch.object(collect, 'REQUEST_LIMIT', guard.attempts), self.assertRaises(ValueError):
            guard(req, event_name='before-send.s3.ListObjectsV2')

    def test_05_opaque_token_and_complete_empty_page(self):
        calls = []
        def fake(**args):
            calls.append(args)
            if len(calls) == 1:
                return response(IsTruncated=True, NextContinuationToken=TOKEN)
            self.assertEqual(args['ContinuationToken'], TOKEN)
            return response(Contents=[], KeyCount=0, ContinuationToken=TOKEN)
        raw, objects, pages = collect.collect_pages(SimpleNamespace(list_objects_v2=fake),
                                                    collect.RequestGuard(config()), config())
        self.assertEqual((objects, pages), (1, 2))
        self.assertIn(TOKEN, raw.decode())

    def test_06_fail_before_requesting_more_pages(self):
        for bad in (response(Name='other'), response(KeyCount=2), response(MaxKeys=True),
                    response(Contents=[{'Key': 'outside', 'Size': 1}])):
            calls = []
            def fake(**args):
                calls.append(args); return bad
            with self.assertRaises(ValueError):
                collect.collect_pages(SimpleNamespace(list_objects_v2=fake), collect.RequestGuard(config()), config())
            self.assertEqual(len(calls), 1)

    def test_07_duplicate_token_key_and_limits(self):
        page = response(IsTruncated=True, NextContinuationToken=TOKEN)
        calls = []
        def fake(**args):
            calls.append(args)
            return page if len(calls) == 1 else response(IsTruncated=True, NextContinuationToken=TOKEN,
                                                       ContinuationToken=TOKEN, Contents=[], KeyCount=0)
        with self.assertRaises(ValueError):
            collect.collect_pages(SimpleNamespace(list_objects_v2=fake), collect.RequestGuard(config()), config())
        self.assertEqual(len(calls), 2)
        for attribute, value in [('LIST_LIMIT', 20), ('ITEM_LIMIT', 0), ('PAGE_LIMIT', 0)]:
            with patch.object(collect.core, attribute, value), self.assertRaises(ValueError):
                collect.collect_pages(SimpleNamespace(list_objects_v2=lambda **kw: response()),
                                      collect.RequestGuard(config()), config())

    def test_08_credentials_and_duplicate_json(self):
        self.assertEqual(collect.credentials(collect.private.encode(SECRET)), SECRET)
        for raw in (b'{"access_key_id":"a","secret_access_key":"b","profile":"default"}',
                    b'{"access_key_id":"a","access_key_id":"b"}', b'NaN'):
            with self.assertRaises(ValueError):
                collect.credentials(raw)

    def test_09_kill_and_reap_before_cleanup(self):
        from unittest.mock import MagicMock
        process = MagicMock()
        process.wait.side_effect = [KeyboardInterrupt(), 0]
        manager = MagicMock(); manager.__enter__.return_value = process
        with patch.object(collect.subprocess, 'Popen', return_value=manager), self.assertRaises(KeyboardInterrupt):
            collect.run_worker(Path('/tmp/private'))
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)


@unittest.skipUnless(sys.platform == 'linux', 'Linux private files and actual pinned SDK worker')
class Linux(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='kin-collect-test-')
        cls.root = Path(cls.temp.name)
        cls.cert, cls.key = cls.root/'cert.pem', cls.root/'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
                        '-keyout', str(cls.key), '-out', str(cls.cert)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.cert.chmod(0o600); cls.key.chmod(0o600)
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                query = parse_qs(urlsplit(self.path).query)
                token = query.get('continuation-token', [None])[0]
                cls.requests.append((self.path, self.headers.get('x-amz-expected-bucket-owner')))
                index = {None: 0, TOKEN: 1, 'last-token': 2}.get(token, 99)
                if cls.mode == 'slow':
                    time.sleep(2)
                if cls.mode == 'denied':
                    status, payload = 403, b'<Error><Code>AccessDenied</Code><Message>SYNTHETIC-SECRET-NO-ACCOUNT</Message></Error>'
                elif cls.mode == 'broken':
                    status, payload = 200, b'<ListBucketResult><broken'
                else:
                    status = 200
                    assert index < 3 and self.path.startswith('/'+BUCKET+'?')
                    assert query['max-keys'] == ['1000'] and query['encoding-type'] == ['url']
                    assert self.headers['Authorization'].startswith('AWS4-HMAC-SHA256 ')
                    assert self.headers['x-amz-security-token'] == SECRET['session_token']
                    key = KEYS[0] if cls.mode == 'duplicate' else KEYS[index]
                    parts = ['<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
                             '<Name>'+BUCKET+'</Name><Prefix>'+quote(PREFIX, safe='')+'</Prefix>',
                             '<EncodingType>url</EncodingType><MaxKeys>1000</MaxKeys><KeyCount>1</KeyCount>',
                             '<IsTruncated>'+('true' if index < 2 else 'false')+'</IsTruncated>',
                             '<Contents><Key>'+quote_plus(key, safe='')+'</Key><Size>31</Size>',
                             '<LastModified>2026-09-06T00:00:00Z</LastModified></Contents>']
                    if token is not None:
                        parts.append('<ContinuationToken>'+escape(token)+'</ContinuationToken>')
                    if index < 2:
                        parts.append('<NextContinuationToken>'+escape([TOKEN, 'last-token'][index])+'</NextContinuationToken>')
                    parts.append('</ListBucketResult>'); payload = ''.join(parts).encode()
                self.send_response(status); self.send_header('Content-Length', str(len(payload))); self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass
            def log_message(self, *args):
                pass
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.temp.cleanup()

    def setUp(self):
        type(self).mode, type(self).requests = 'normal', []
        self.folder = self.root/self._testMethodName; self.folder.mkdir(mode=0o700)
        self.secret = self.folder/'secret.json'; collect.write_json(self.secret, SECRET)
        self.body = dict(config(), endpoint='https://127.0.0.1:'+str(self.server.server_port),
                         credentials_file=str(self.secret), ca_file=str(self.cert),
                         ca_sha256=collect.digest(self.cert.read_bytes()))
        self.path, self.destination = self.folder/'config.json', self.folder/'output'
        collect.write_json(self.path, self.body)

    def run_collect(self):
        return collect.collect(self.path, collect.digest(self.path.read_bytes()), self.destination)

    def failed_only(self):
        self.assertFalse(self.destination.exists())
        pending = self.folder/'.output.pending'
        self.assertEqual({p.name for p in pending.iterdir()}, {'failure.json'})
        self.assertEqual(json.loads(self.secret.read_bytes()), SECRET)

    def test_10_tls_three_pages_and_private_receipt(self):
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:1', 'AWS_PROFILE': 'NONEXISTENT',
                                     'AWS_ENDPOINT_URL': 'https://invalid.example', 'PYTHONPATH': '/nonexistent'}):
            result = self.run_collect()
        self.assertEqual((result['pages'], result['listed_objects'], result['request_attempts']), (3, 3, 3))
        self.assertTrue(all(result[k] is False for k in collect.AUTHORITY))
        self.assertEqual({p.name for p in self.destination.iterdir()}, {'listing.json', 'receipt.json'})
        raw = (self.destination/'listing.json').read_bytes()
        objects, pages = collect.core.listing(raw, result['listing_sha256'], BUCKET, PREFIX)
        self.assertEqual(set(objects), set(KEYS)); self.assertEqual(pages, 3)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o700)
        for path in self.destination.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(all(value.encode() not in path.read_bytes() for value in SECRET.values()))

    def test_11_denied_redacted_cli(self):
        type(self).mode = 'denied'
        result = subprocess.run([sys.executable, '-B', collect.__file__, 'collect', '--config', str(self.path),
                                 '--config-sha256', collect.digest(self.path.read_bytes()),
                                 '--destination', str(self.destination)], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(all(value.encode() not in result.stdout+result.stderr for value in SECRET.values()))
        self.assertEqual(len(self.requests), 1); self.failed_only()

    def test_12_malformed_xml(self):
        type(self).mode = 'broken'
        with self.assertRaises(ValueError):
            self.run_collect()
        self.assertLessEqual(len(self.requests), 2); self.failed_only()

    def test_13_duplicate_stops_before_third_page(self):
        type(self).mode = 'duplicate'
        with self.assertRaises(ValueError):
            self.run_collect()
        self.assertEqual(len(self.requests), 2); self.failed_only()

    def test_14_untrusted_tls(self):
        self.path.unlink()
        self.body.pop('ca_file'); self.body.pop('ca_sha256')
        collect.write_json(self.path, self.body)
        with self.assertRaises(ValueError):
            self.run_collect()
        self.assertEqual(self.requests, []); self.failed_only()

    def test_15_timeout_real_child_reaped(self):
        type(self).mode = 'slow'
        started = time.monotonic()
        with patch.object(collect, 'WORKER_TIMEOUT', 0.1), self.assertRaises(subprocess.TimeoutExpired):
            self.run_collect()
        self.assertLess(time.monotonic()-started, 3); self.failed_only()

    def test_16_hash_and_file_permissions(self):
        with self.assertRaises(ValueError):
            collect.collect(self.path, '0'*64, self.destination)
        self.secret.chmod(0o644)
        with self.assertRaises(ValueError):
            self.run_collect()
        self.assertEqual(self.requests, []); self.assertFalse(self.destination.exists())

    def test_17_existing_destination_or_pending_preserved(self):
        self.destination.mkdir(mode=0o700)
        marker = self.destination/'marker'; marker.write_text('keep')
        with self.assertRaises(ValueError):
            self.run_collect()
        self.assertEqual(marker.read_text(), 'keep')
        self.destination = self.folder/'other'
        pending = self.folder/'.other.pending'; pending.mkdir(mode=0o700)
        marker = pending/'marker'; marker.write_text('keep')
        with self.assertRaises(FileExistsError):
            self.run_collect()
        self.assertEqual(marker.read_text(), 'keep'); self.assertEqual(self.requests, [])

    def test_18_ca_hash_rejected_before_network(self):
        self.path.unlink(); self.body['ca_sha256'] = '0'*64; collect.write_json(self.path, self.body)
        with self.assertRaises(ValueError):
            self.run_collect()
        self.assertEqual(self.requests, []); self.failed_only()

    def test_19_worker_input_changed_after_parent_binding(self):
        original = collect.run_worker
        def changed(pending):
            self.secret.unlink()
            collect.write_json(self.secret, dict(SECRET, access_key_id='CHANGED-SYNTHETIC'))
            original(pending)
        with patch.object(collect, 'run_worker', side_effect=changed), self.assertRaises(ValueError):
            self.run_collect()
        self.assertEqual(self.requests, [])
        self.assertFalse(self.destination.exists())
        self.assertEqual({p.name for p in (self.folder/'.output.pending').iterdir()}, {'failure.json'})

    def test_20_parent_rejects_worker_receipt_tampering(self):
        original = collect.run_worker
        def changed(pending):
            original(pending)
            path = pending/'receipt.json'
            body = json.loads(path.read_bytes()); body['migration_authorized'] = True
            path.unlink(); collect.write_json(path, body)
        with patch.object(collect, 'run_worker', side_effect=changed), self.assertRaises(ValueError):
            self.run_collect()
        self.failed_only()

    def test_21_parent_rejects_worker_listing_tampering(self):
        original = collect.run_worker
        def changed(pending):
            original(pending)
            with (pending/'listing.json').open('ab') as stream:
                stream.write(b' ')
        with patch.object(collect, 'run_worker', side_effect=changed), self.assertRaises(ValueError):
            self.run_collect()
        self.failed_only()

    def test_22_publication_race_preserves_other_output(self):
        original = collect.private.publish
        def conflict(pending, destination):
            destination.mkdir(mode=0o700)
            (destination/'marker').write_text('keep')
            original(pending, destination)
        with patch.object(collect.private, 'publish', side_effect=conflict), self.assertRaises(OSError):
            self.run_collect()
        self.assertEqual((self.destination/'marker').read_text(), 'keep')
        self.assertEqual({p.name for p in (self.folder/'.output.pending').iterdir()}, {'failure.json'})

    def test_23_real_sdk_disallowed_operations_never_reach_tls_server(self):
        client, guard = collect.sdk_client(self.body, SECRET, str(self.cert))
        try:
            for call in (lambda: client.head_bucket(Bucket=BUCKET),
                         lambda: client.get_object(Bucket=BUCKET, Key='synthetic'),
                         lambda: client.list_objects_v2(Bucket=BUCKET, Prefix='outside/', MaxKeys=1000,
                             EncodingType='url', ExpectedBucketOwner='000000000000')):
                with self.assertRaises(ValueError):
                    call()
            self.assertEqual(self.requests, [])
            self.assertEqual(guard.attempts, 3)
        finally:
            client.close()

    def test_24_receipt_times_compare_instants_and_reject_reversed_order(self):
        original = collect.run_worker
        end = '2026-09-06T00:00:00.500+00:00'
        def changed(pending):
            original(pending)
            path = pending/'receipt.json'; body = json.loads(path.read_bytes())
            body.update(started_at='2026-09-06T00:00:00.500000+00:00', ended_at=end)
            path.unlink(); collect.write_json(path, body)
        with patch.object(collect, 'run_worker', side_effect=changed):
            self.assertTrue(self.run_collect()['collection_complete'])
            end = '2026-09-06T00:00:00.400+00:00'
            self.destination = self.folder/'reversed'
            with self.assertRaises(ValueError):
                self.run_collect()
        self.assertFalse(self.destination.exists())
        self.assertEqual({p.name for p in (self.folder/'.reversed.pending').iterdir()}, {'failure.json'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
