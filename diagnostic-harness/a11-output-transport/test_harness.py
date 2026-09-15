#!/usr/bin/env python3
"""Pure local tests of the never-merged A11 output transport diagnostic harness: synthetic NetLog, nginx and observer fixtures,
the generated proxy copy, sanitization and the workflow scope against the baseline job. No browser, container or network."""
import copy
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'observer'))
import analyze  # noqa: E402
import harness  # noqa: E402
import kin_transport_observer as observer  # noqa: E402

EVENT_TYPES = ['REQUEST_ALIVE', 'URL_REQUEST_START_JOB', 'FAILED', 'CANCELLED', 'HTTP2_SESSION', 'HTTP2_SESSION_INITIALIZED',
               'HTTP2_SESSION_SEND_HEADERS', 'HTTP2_SESSION_RECV_HEADERS', 'HTTP2_SESSION_RECV_GOAWAY', 'HTTP2_SESSION_CLOSE',
               'HTTP2_SESSION_RECV_RST_STREAM', 'HTTP_TRANSACTION_RESTART_AFTER_ERROR', 'TCP_CONNECT', 'SOCKET_POOL_BOUND_TO_SOCKET']
SOURCE_TYPES = ['NONE', 'URL_REQUEST', 'HTTP2_SESSION', 'SOCKET']
OFFSET = 1789500000000
ORIGIN = 'https://localhost:9443'
INFO, TAGS, FRAME = '/instances/a/attachments/dicom/info', '/instances/a/simplified-tags', '/instances/b/frames/0/image-uint16'


def in_git():
    return subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=HERE, capture_output=True).returncode == 0


class NetLog:
    def __init__(self):
        self.lines = []

    def event(self, time, name, source, source_type, phase=0, **params):
        event = {'phase': phase, 'source': {'id': source, 'start_time': str(time), 'type': SOURCE_TYPES.index(source_type)},
                 'time': str(time), 'type': EVENT_TYPES.index(name)}
        if params:
            event['params'] = params
        self.lines.append(json.dumps(event, sort_keys=True, separators=(',', ':')))

    def session(self, sid, time=1000):
        self.event(time, 'HTTP2_SESSION', sid, 'HTTP2_SESSION', phase=1, host='localhost:9443', proxy='DIRECT')
        self.event(time, 'HTTP2_SESSION_INITIALIZED', sid, 'HTTP2_SESSION', protocol='h2', source_dependency={'id': 900 + sid, 'type': 3})

    def request(self, rid, start, path, end, net_error=None, session=None, stream=None, answered=False, link=True):
        self.event(start, 'REQUEST_ALIVE', rid, 'URL_REQUEST', phase=1)
        self.event(start, 'URL_REQUEST_START_JOB', rid, 'URL_REQUEST', phase=1, method='GET', url=ORIGIN + path)
        if session is not None and stream is not None:
            linked = {'source_dependency': {'id': rid, 'type': 1}} if link else {}
            self.event(start + 1, 'HTTP2_SESSION_SEND_HEADERS', session, 'HTTP2_SESSION', stream_id=stream, fin=True,
                       headers=[':method: GET', ':path: ' + path], **linked)
            if answered:
                self.event(start + 4, 'HTTP2_SESSION_RECV_HEADERS', session, 'HTTP2_SESSION', stream_id=stream, fin=False, headers=[':status: 200'])
        if net_error is None:
            self.event(end, 'REQUEST_ALIVE', rid, 'URL_REQUEST', phase=2)
        else:
            self.event(end, 'FAILED', rid, 'URL_REQUEST', net_error=net_error)
            self.event(end, 'REQUEST_ALIVE', rid, 'URL_REQUEST', phase=2, net_error=net_error)

    def text(self, closed=True, trailing_comma=True, cut=False):
        constants = {'logEventTypes': {n: i for i, n in enumerate(EVENT_TYPES)}, 'logSourceType': {n: i for i, n in enumerate(SOURCE_TYPES)},
                     'logEventPhase': {'PHASE_NONE': 0, 'PHASE_BEGIN': 1, 'PHASE_END': 2},
                     'netError': {'ERR_IO_PENDING': -1, 'ERR_FAILED': -2, 'ERR_ABORTED': -3, 'ERR_BLOCKED_BY_CLIENT': -20,
                                  'ERR_CONNECTION_CLOSED': -100, 'ERR_HTTP2_SERVER_REFUSED_STREAM': -351},
                     'timeTickOffset': str(OFFSET), 'clientInfo': {'command_line': '"chrome" --log-net-log=/t/n.json --net-log-capture-mode=Default'}}
        events = [line + ',' for line in self.lines]
        if events and not trailing_comma:
            events[-1] = events[-1][:-1]
        body = '{"constants":' + json.dumps(constants, separators=(',', ':')) + ',\n"events": [\n' + '\n'.join(events) + '\n'
        if cut:
            body = body[:-40]
        if closed:
            body += '],\n"polledData": {}\n}\n'
        return body


def rejection(path, start, seq=1, failure='net::ERR_FAILED', timing=True):
    return {'seq': seq, 'kind': 'requestfailed', 'wall': (OFFSET + start + 20) / 1000, 'monotonic': 10.0, 'pid': 7,
            'test': 'test_volume_mip_output.VolumeMipOutputE2E.test_mip_output_01', 'context': 2, 'page': 3, 'method': 'GET',
            'url': ORIGIN + path, 'host': 'localhost:9443', 'path': path, 'failure': failure, 'resource_type': 'fetch',
            'timing': {'startTime': OFFSET + start} if timing else {}, 'source_read': True}


LAUNCH = {'seq': 0, 'kind': 'launch', 'wall': OFFSET / 1000, 'pid': 7, 'added_args': ['--log-net-log=/t/n.json', '--net-log-capture-mode=Default']}
CONFIG = 'http2 on;\naccess_log /var/log/kin-diag/access-conn.log kin_diag_conn;\n'


def access_line(msec, conn, conn_req, uri, status=200):
    return ('msec=%.3f pid=30 conn=%d conn_req=%d http2=h2 proto=HTTP/2.0 remote=172.18.0.1:40000 server_port=443 method=GET '
            'uri="%s" status=%d bytes=250 req_len=40 req_time=0.004 up_status=200 up_time=0.004 completion=OK ua="HeadlessChrome"'
            % (msec / 1000, conn, conn_req, uri, status))


def make_run(folder, netlog=None, events=(), access=(), config=CONFIG, test_log='Ran 3 tests in 1.0s\n\nOK\n', valid=True, hook=True):
    diag, profile = Path(folder) / 'diag', Path(folder) / 'profile'
    (diag / 'harness').mkdir(parents=True)
    for kind in ('restore', 'prepare'):
        (diag / 'harness' / (kind + '.json')).write_text(json.dumps({'result': 'passed'}), encoding='utf-8')
    (diag / 'harness' / 'collect.json').write_text(json.dumps({'result': 'passed' if valid else 'failed', 'checks': [
        {'name': 'HEAD is still the baseline', 'ok': valid}, {'name': 'no tracked difference after the profile', 'ok': True}]}), encoding='utf-8')
    (diag / 'browser' / 'netlog').mkdir(parents=True)
    rows = ([LAUNCH] if hook else []) + list(events)
    (diag / 'browser' / 'events-7.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    if netlog is not None:
        (diag / 'browser' / 'netlog' / 'netlog-7-1.json').write_text(netlog, encoding='utf-8')
    (diag / 'proxy').mkdir()
    (diag / 'proxy' / 'access-conn.log').write_text(''.join(line + '\n' for line in access), encoding='utf-8')
    if config is not None:
        (diag / 'proxy' / 'nginx-effective-config.txt').write_text(config, encoding='utf-8')
    profile.mkdir()
    if test_log is not None:
        (profile / 'test_volume_mip_output.log').write_text(test_log, encoding='utf-8')
    return diag, profile


def goaway_log(failed_stream=2001, last_accepted=1999, error=-2, close=False):
    log = NetLog()
    log.session(10)
    log.request(200, 4990, INFO, 4995, session=10, stream=1997, answered=True)
    log.event(5000, 'HTTP2_SESSION_RECV_GOAWAY', 10, 'HTTP2_SESSION', last_accepted_stream_id=last_accepted, active_streams=1,
              unclaimed_streams=0, error_code='0 (NO_ERROR)')
    log.request(300, 5002, FRAME, 5010, net_error=error, session=10, stream=failed_stream)
    if close:
        log.event(5011, 'HTTP2_SESSION_CLOSE', 10, 'HTTP2_SESSION', net_error=0, description='Finished going away')
    return log


class AnalysisTests(unittest.TestCase):
    def run_case(self, **kwargs):
        with tempfile.TemporaryDirectory() as folder:
            diag, profile = make_run(folder, **kwargs)
            return analyze.analyze(diag, profile)

    def test_supported_when_the_rejected_stream_is_above_goaway_last_accepted(self):
        result = self.run_case(netlog=goaway_log().text(), events=[rejection(FRAME, 5002)],
                               access=[access_line(OFFSET + 4995, 5, 1000, INFO)])
        self.assertEqual(result['classification']['result'], 'SUPPORTED', result['classification'])
        mapped = result['page_visible_source_read_rejections'][0]
        self.assertEqual([mapped['relation'], mapped['stream_id'], mapped['goaway']['last_accepted']], ['COMPATIBLE', 2001, 1999])
        self.assertEqual(mapped['nginx_connection']['conn'], 5)
        self.assertTrue(mapped['nginx_connection']['at_keepalive_requests'])
        self.assertFalse(result['request_limit_coincidence']['causal_inference_from_count_alone'])

    def test_rejected_when_an_accepted_stream_fails_on_a_session_that_stays_open(self):
        log = NetLog()
        log.session(10)
        log.request(300, 5002, FRAME, 5010, net_error=-2, session=10, stream=5)
        log.request(301, 5600, TAGS, 5620, session=10, stream=7, answered=True)
        result = self.run_case(netlog=log.text(), events=[rejection(FRAME, 5002)])
        self.assertEqual(result['classification']['result'], 'REJECTED', result['classification'])
        self.assertEqual(result['page_visible_source_read_rejections'][0]['later_streams_on_session'], 1)

    def test_rejected_when_the_network_request_completed_while_the_page_reported_failure(self):
        log = NetLog()
        log.session(10)
        log.request(300, 5002, FRAME, 5050, session=10, stream=5, answered=True)
        result = self.run_case(netlog=log.text(), events=[rejection(FRAME, 5002)])
        self.assertEqual(result['classification']['result'], 'REJECTED', result['classification'])

    def test_rejected_for_a_non_transport_network_error(self):
        result = self.run_case(netlog=goaway_log(error=-20).text(), events=[rejection(FRAME, 5002)])
        self.assertEqual(result['classification']['result'], 'REJECTED', result['classification'])

    def test_supported_when_the_request_is_active_as_its_session_closes_without_goaway(self):
        log = NetLog()
        log.session(10)
        log.request(300, 5002, FRAME, 5010, net_error=-100, session=10, stream=5)
        log.event(5010, 'HTTP2_SESSION_CLOSE', 10, 'HTTP2_SESSION', net_error=-100, description='Connection closed')
        result = self.run_case(netlog=log.text(), events=[rejection(FRAME, 5002)])
        self.assertEqual(result['classification']['result'], 'SUPPORTED', result['classification'])
        self.assertIn('without GOAWAY', result['page_visible_source_read_rejections'][0]['reason'])

    def test_inconclusive_when_no_netlog_request_matches(self):
        result = self.run_case(netlog=goaway_log().text(), events=[rejection(TAGS, 5002)])
        self.assertEqual([result['classification']['result'], result['classification']['rule']], ['INCONCLUSIVE', 'R3-mapping'])

    def test_a_count_at_keepalive_requests_alone_never_supports(self):
        result = self.run_case(netlog=None, events=[rejection(FRAME, 5002)], access=[access_line(OFFSET + 4995, 5, 1000, INFO)])
        self.assertEqual([result['classification']['result'], result['classification']['rule']], ['INCONCLUSIVE', 'R1-inputs'])
        self.assertEqual(result['nginx']['connections_at_keepalive_requests'], [5])

    def test_partial_when_boundaries_occur_without_rejection(self):
        log = goaway_log()
        result = self.run_case(netlog=log.text(), events=[rejection(FRAME, 5002, failure='net::ERR_ABORTED')])
        self.assertEqual(result['classification']['result'], 'PARTIAL', result['classification'])
        self.assertEqual(result['aborted_or_cancelled_failures'], 1)

    def test_partial_from_nginx_connection_limit_without_rejection(self):
        result = self.run_case(netlog=None, access=[access_line(OFFSET + 4995, 5, 1000, INFO)])
        self.assertEqual(result['classification']['result'], 'PARTIAL', result['classification'])

    def test_inconclusive_without_rejection_or_boundary(self):
        log = NetLog()
        log.session(10)
        log.request(200, 4990, INFO, 4995, session=10, stream=1, answered=True)
        result = self.run_case(netlog=log.text(), access=[access_line(OFFSET + 4995, 5, 1, INFO)])
        self.assertEqual([result['classification']['result'], result['classification']['rule']], ['INCONCLUSIVE', 'R4-classification'])

    def test_inconclusive_when_the_harness_run_is_not_valid(self):
        result = self.run_case(netlog=goaway_log().text(), events=[rejection(FRAME, 5002)], valid=False)
        self.assertEqual([result['classification']['result'], result['classification']['rule']], ['INCONCLUSIVE', 'R0-validity'])

    def test_inconclusive_without_the_browser_hook(self):
        result = self.run_case(netlog=goaway_log().text(), hook=False)
        self.assertEqual([result['classification']['result'], result['classification']['rule']], ['INCONCLUSIVE', 'R1-inputs'])

    def test_inconclusive_when_a_guard_line_or_transport_text_was_not_captured(self):
        log = 'MIP_OUTPUT_TRANSPORT_FAILURE {"attempt": 1}\nRan 3 tests in 1.0s\n\nOK\n'
        result = self.run_case(netlog=goaway_log().text(), test_log=log)
        self.assertEqual([result['classification']['result'], result['classification']['rule']], ['INCONCLUSIVE', 'R2-rejections'])
        self.assertFalse(result['existing_guard_instrumentation']['counted_as_detection'])
        failed = ('test_mip_output_01 (x) ... FAIL\n\n' + '=' * 70 + '\nFAIL: test_mip_output_01 (x)\n' + '-' * 70 +
                  '\nTraceback (most recent call last):\nAssertionError: Locator expected to contain text\nActual value: Failed to fetch \n\n\n' +
                  '-' * 70 + '\nRan 3 tests in 173.214s\n\nFAILED (failures=1)\n')
        result = self.run_case(netlog=goaway_log().text(), test_log=failed)
        self.assertEqual(result['classification']['rule'], 'R2-rejections')

    def test_unmapped_when_an_unclosed_netlog_ends_right_after_the_failure(self):
        log = NetLog()
        log.session(10)
        log.request(300, 5002, FRAME, 5010, net_error=-2, session=10, stream=5)
        result = self.run_case(netlog=log.text(closed=False), events=[rejection(FRAME, 5002)])
        self.assertEqual(result['classification']['result'], 'INCONCLUSIVE', result['classification'])

    def test_unlinked_stream_binds_by_dependency_path_and_time_or_stays_unmapped_when_ambiguous(self):
        log = NetLog()
        log.session(10)
        log.request(200, 4990, INFO, 4995, session=10, stream=1997, answered=True)
        log.event(5000, 'HTTP2_SESSION_RECV_GOAWAY', 10, 'HTTP2_SESSION', last_accepted_stream_id=1999, error_code='0 (NO_ERROR)')
        log.request(300, 5002, FRAME, 5010, net_error=-2, session=10, stream=2001, link=False)
        log.event(5003, 'SOCKET_POOL_BOUND_TO_SOCKET', 300, 'URL_REQUEST', source_dependency={'id': 10, 'type': 2})
        result = self.run_case(netlog=log.text(), events=[rejection(FRAME, 5002)])
        mapped = result['page_visible_source_read_rejections'][0]
        self.assertEqual([result['classification']['result'], mapped['stream_id']], ['SUPPORTED', 2001], result['classification'])
        self.assertIn('path and time', mapped['binding'])
        log.event(5004, 'HTTP2_SESSION_SEND_HEADERS', 10, 'HTTP2_SESSION', stream_id=2003, fin=True, headers=[':method: GET', ':path: ' + FRAME])
        result = self.run_case(netlog=log.text(), events=[rejection(FRAME, 5002)])
        self.assertEqual([result['classification']['result'], result['classification']['rule']], ['INCONCLUSIVE', 'R3-mapping'])

    def test_fallback_match_without_start_time(self):
        result = self.run_case(netlog=goaway_log().text(), events=[rejection(FRAME, 5002, timing=False)])
        self.assertEqual(result['classification']['result'], 'SUPPORTED', result['classification'])

    def test_the_statements_keep_main_01_blocked_and_detection_separate(self):
        result = self.run_case(netlog=goaway_log().text())
        joined = ' '.join(result['statements'])
        for text in ('does not resolve the main-01 failure', 'never semantic or mutant detection', 'stays a hypothesis'):
            self.assertIn(text, joined)


class NetLogReaderTests(unittest.TestCase):
    def read(self, text):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'n.json'
            path.write_text(text, encoding='utf-8')
            return analyze.netlog_model(path), analyze.netlog_capability(path)

    def test_closed_file_with_and_without_trailing_comma(self):
        for comma in (True, False):
            model, capability = self.read(goaway_log().text(trailing_comma=comma))
            self.assertTrue(model['info']['closed'])
            self.assertEqual(model['info']['unparsed_lines'], 0)
            self.assertEqual(sorted(model['requests']), [200, 300])
            self.assertEqual(model['sessions'][10]['goaways'][0]['last_accepted'], 1999)
            self.assertTrue(capability['complete'] and capability['capture_mode_default'])
            self.assertEqual(capability['missing_event_types'], [])

    def test_events_array_closed_on_the_last_event_line(self):
        text = goaway_log().text(closed=False, trailing_comma=False).rstrip('\n') + ']}\n'
        model, capability = self.read(text)
        self.assertTrue(model['info']['closed'] and capability['complete'])
        self.assertEqual([model['info']['unparsed_lines'], model['requests'][300]['net_error_name']], [0, 'ERR_FAILED'])

    def test_truncated_file_keeps_complete_lines(self):
        model, capability = self.read(goaway_log().text(closed=False, cut=True))
        self.assertFalse(model['info']['closed'])
        self.assertEqual(model['info']['unparsed_lines'], 1)
        self.assertFalse(capability['complete'])
        self.assertIn(200, model['requests'])

    def test_event_with_type_not_last_is_still_read(self):
        log = goaway_log()
        event = json.loads(log.lines[-1])
        log.lines[-1] = json.dumps({'type': event['type'], **{k: v for k, v in event.items() if k != 'type'}}, separators=(',', ':'))
        model, _ = self.read(log.text())
        self.assertEqual(model['requests'][300]['net_error_name'], 'ERR_FAILED')

    def test_missing_event_types_are_reported(self):
        text = goaway_log().text().replace('"HTTP2_SESSION_RECV_GOAWAY"', '"RENAMED_GOAWAY"')
        _, capability = self.read(text)
        self.assertEqual(capability['missing_event_types'], ['HTTP2_SESSION_RECV_GOAWAY'])


class SanitizeTests(unittest.TestCase):
    def test_tokens_headers_fields_and_query_values_are_redacted_idempotently(self):
        raw = ('"url":"https://localhost:9443/api/auth/callback?code=abc123&state=xyz&empty=","headers":[":path: /auth/x?session_code=s1",'
               '"cookie: kin_at=secret","authorization: Bearer eyJhbGciOi.eyJzdWIi.c2ln"],"password":"hunter2" '
               'proxy_set_header Authorization "Basic YWRtaW46cGFzcw==";')
        clean, counts = harness.sanitize_text(raw)
        for secret in ('abc123', 'xyz', 's1', 'kin_at=secret', 'eyJhbGciOi', 'hunter2', 'YWRtaW46cGFzcw=='):
            self.assertNotIn(secret, clean)
        self.assertIn('/api/auth/callback?code=[REDACTED]&state=[REDACTED]&empty=', clean)
        self.assertGreater(sum(counts.values()), 0)
        self.assertEqual(harness.sanitize_text(clean)[0], clean)
        source = '/instances/608fdb48-3ac68563-c0ee1c53-38538d31-894f1c35/frames/0/image-uint16'
        self.assertEqual(harness.sanitize_text(source)[0], source)

    def test_stream_sanitizer_hashes_raw_and_clean(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / 'raw.json', Path(folder) / 'out' / 'clean.json'
            source.write_bytes(b'{"url":"https://h/x?token=1"},\n{"url":"https://h/instances/a"},\n')
            info = harness.sanitize_stream(source, target)
            self.assertEqual(info['raw_sha256'], harness.sha256(source.read_bytes()))
            self.assertEqual(info['sha256'], harness.sha256(target.read_bytes()))
            self.assertEqual(info['redactions']['query_values'], 1)

    def test_observer_redacts_urls(self):
        self.assertEqual(observer.redact_url('https://localhost:9443/api/auth/callback?code=1&state=&x=2#frag'),
                         'https://localhost:9443/api/auth/callback?code=[REDACTED]&state=&x=[REDACTED]')
        self.assertEqual(observer.redact_url(ORIGIN + FRAME), ORIGIN + FRAME)


@unittest.skipUnless(in_git(), 'needs the harness git worktree')
class ScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reg = harness.registry()
        cls.baseline = harness.blob(cls.reg['baseline']['sha'], harness.WORKFLOW).decode('utf-8')
        cls.ours = (HERE.parents[1] / harness.WORKFLOW).read_bytes().decode('utf-8')

    def check(self, text):
        harness.check_workflow(harness.Record('test'), self.reg, text, self.baseline)

    def test_workflow_matches_the_registered_scope(self):
        self.check(self.ours)

    def test_workflow_changes_outside_the_registry_are_refused(self):
        collect = 'Harness - collect and sanitize observation evidence, guard the tree and analyze'
        cases = {
            'automatic trigger': self.ours.replace('on:\n  workflow_dispatch:\n', 'on:\n  push:\n  workflow_dispatch:\n', 1),
            'live timeout': self.ours.replace('timeout-minutes: 28', 'timeout-minutes: 30', 1),
            'continue-on-error': self.ours.replace('        if: always()\n        timeout-minutes: 8', '        if: always()\n        continue-on-error: true\n        timeout-minutes: 8', 1),
            'selection step': self.ours.replace('--file tests/e2e/test_volume_mip_output.py ', '', 1),
            'extra environment': self.ours.replace('          KIN_TRANSPORT_DIAG_DIR: ${{ runner.temp }}/transport-diagnostics/browser',
                                                   '          KIN_TRANSPORT_DIAG_DIR: ${{ runner.temp }}/transport-diagnostics/browser\n          KIN_E2E_HEADED: "1"', 1),
            'always step': self.ours.replace('      - name: ' + collect + '\n        if: always()\n', '      - name: ' + collect + '\n', 1),
            'job timeout': self.ours.replace('    timeout-minutes: 40', '    timeout-minutes: 45', 1),
            'write token': self.ours.replace('  contents: read', '  contents: write', 1),
            'retry': self.ours.replace('python3 "$RUNNER_TEMP/transport-harness/harness.py" cleanup', 'python3 "$RUNNER_TEMP/transport-harness/harness.py" cleanup || retry', 1),
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, self.ours, label)
                with self.assertRaises(harness.GuardFailure):
                    self.check(text)

    def test_registry_hashes_and_rule_ids(self):
        harness.check_registry(harness.Record('test'), self.reg)
        self.assertEqual([rule['id'] for rule in self.reg['decision_rules']], list(analyze.RULE_IDS))

    def test_generated_proxy_copy_only_adds_the_logging_block(self):
        original = harness.blob(self.reg['baseline']['sha'], harness.TEMPLATE).decode('utf-8')
        files = harness.generated(original, Path('/RUNNER_TEMP/transport-diagnostics'))
        template = files['proxy-config/default.conf.template'][0].decode('utf-8')
        self.assertEqual(template.replace(harness.LOGGING_BLOCK, '', 1), original)
        self.assertLess(template.index(harness.LOGGING_BLOCK), template.index('limit_req_zone'))
        self.assertLess(template.index('limit_req_zone'), template.index('server {'))
        for variable in ('$connection ', '$connection_requests ', '$http2 ', '$msec ', '$remote_port '):
            self.assertIn(variable, harness.LOGGING_BLOCK)
        added = [line for line in harness.LOGGING_BLOCK.splitlines() if line.strip() and not line.startswith('#')]
        directives = sorted({line.split()[0] for line in added if not line.startswith(' ')})
        self.assertEqual(directives, ['access_log', 'error_log', 'log_format'])
        for forbidden in ('keepalive', 'http2 ', 'listen', 'timeout', 'buffer', 'proxy_', 'location'):
            self.assertNotIn(forbidden, '\n'.join(added).replace('$http2', '').replace('$request_time', '').replace('$upstream_response_time', ''))
        script = files['proxy-config/99-kin-diag-effective-config.sh'][0].decode('utf-8')
        self.assertTrue(script.rstrip().endswith('exit 0'))
        self.assertIn("sed -E 's|(Basic )[A-Za-z0-9+/=]+|\\1[REDACTED]|g'", script)
        for forbidden in ('nginx -s', 'reload', 'rm ', 'kill'):
            self.assertNotIn(forbidden, script)
        override = files[harness.OVERRIDE][0].decode('utf-8')
        self.assertEqual(override.count('- type: bind'), 3)
        for target in ('/etc/nginx/templates/default.conf.template', '/docker-entrypoint.d/99-kin-diag-effective-config.sh', '/var/log/kin-diag'):
            self.assertIn('target: ' + target + '\n', override)
        self.assertEqual([k for k in files], ['proxy-config/default.conf.template', 'proxy-config/99-kin-diag-effective-config.sh', harness.OVERRIDE])


class FakeContext:
    def __init__(self):
        self.handlers = {}

    def on(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)

    def route(self, url, handler):
        return 'routed'


class FakePage(FakeContext):
    def __init__(self, context):
        super().__init__()
        self.context = context


class FakeBrowser:
    version = '148.0.0.0'

    def new_context(self, **kwargs):
        return FakeContext()

    def new_page(self, **kwargs):
        return FakePage(FakeContext())

    def close(self):
        return 'closed'


class FakeBrowserType:
    def launch(self, **kwargs):
        if kwargs.get('headless') == 'boom':
            raise RuntimeError('launch failed')
        return (FakeBrowser(), kwargs)


class FakeRequest:
    method, resource_type, failure = 'GET', 'fetch', 'net::ERR_FAILED'
    timing = {'startTime': 1.0}

    def __init__(self, url):
        self.url = url

    @property
    def frame(self):
        raise RuntimeError('service worker request')

    def is_navigation_request(self):
        return False


class ObserverTests(unittest.TestCase):
    def setUp(self):
        import unittest.result as result
        self.folder = tempfile.TemporaryDirectory()
        self.saved_env = os.environ.get('KIN_TRANSPORT_DIAG_DIR')
        os.environ['KIN_TRANSPORT_DIAG_DIR'] = self.folder.name
        self.saved = {name: result.TestResult.__dict__[name] for name in ('startTest', 'stopTest', 'addSuccess', 'addFailure', 'addError', 'addSkip')}
        self.observer = importlib.reload(observer)

    def tearDown(self):
        import unittest.result as result
        for name, value in self.saved.items():
            setattr(result.TestResult, name, value)
        if self.observer._state['stream'] is not None:
            self.observer._state['stream'].close()
        if self.saved_env is None:
            os.environ.pop('KIN_TRANSPORT_DIAG_DIR', None)
        else:
            os.environ['KIN_TRANSPORT_DIAG_DIR'] = self.saved_env
        self.folder.cleanup()

    def rows(self):
        path = Path(self.folder.name) / ('events-%d.jsonl' % os.getpid())
        return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]

    def fake_module(self):
        module = type(sys)('fake_generated')
        module.BrowserType, module.Browser, module.BrowserContext, module.Page = (
            type('BrowserType', (FakeBrowserType,), {}), type('Browser', (FakeBrowser,), {}),
            type('BrowserContext', (FakeContext,), {}), type('Page', (FakePage,), {}))
        return module

    def test_wrappers_pass_through_and_add_only_the_netlog_switches(self):
        module = self.fake_module()
        self.observer.patch(module)
        browser, called = module.BrowserType().launch(headless=True, args=['--enable-unsafe-swiftshader'])
        netlog = called['args'][1]
        self.assertEqual(called['args'][0], '--enable-unsafe-swiftshader')
        self.assertTrue(netlog.startswith('--log-net-log=') and netlog.endswith('.json'))
        self.assertEqual(called['args'][2:], ['--net-log-capture-mode=Default'])
        self.assertEqual({k: v for k, v in called.items() if k != 'args'}, {'headless': True})
        with self.assertRaisesRegex(RuntimeError, 'launch failed'):
            module.BrowserType().launch(headless='boom')
        context = module.Browser.new_context(module.Browser())
        self.assertEqual(sorted(context.handlers), ['close', 'page', 'requestfailed'])
        context.handlers['requestfailed'][0](FakeRequest(ORIGIN + '/api/auth/callback?code=secret'))
        broken = FakeRequest(ORIGIN + FRAME)
        type(broken).url = property(lambda self: (_ for _ in ()).throw(RuntimeError('gone')))
        try:
            context.handlers['requestfailed'][0](broken)
        finally:
            del type(broken).url
        self.assertEqual(module.BrowserContext.route(context, '**/x.js', lambda route: None), 'routed')
        self.assertEqual(module.Browser.close(module.Browser()), 'closed')
        page = module.Browser.new_page(module.Browser())
        self.assertIn('requestfailed', page.context.handlers)
        rows = self.rows()
        kinds = [row['kind'] for row in rows]
        for kind in ('patched', 'launch', 'launched', 'launch_failed', 'context', 'requestfailed', 'hook_error', 'route', 'browser_close', 'browser_closed', 'page'):
            self.assertIn(kind, kinds)
        failed = next(row for row in rows if row['kind'] == 'requestfailed')
        self.assertEqual([failed['url'], failed['page'], failed['source_read'], failed['failure']],
                         [ORIGIN + '/api/auth/callback?code=[REDACTED]', None, True, 'net::ERR_FAILED'])
        self.assertNotIn('secret', json.dumps(rows))

    def test_patch_is_applied_once_and_records_test_identity(self):
        import unittest.result as result
        module = self.fake_module()
        self.observer.patch(module)
        launch = module.BrowserType.launch
        self.observer._state['patched'] = False
        self.observer.patch(module)
        self.assertIs(module.BrowserType.launch, launch)
        test = unittest.FunctionTestCase(lambda: None)
        outcome = result.TestResult()
        outcome.startTest(test)
        outcome.addSuccess(test)
        outcome.stopTest(test)
        rows = [row for row in self.rows() if row['kind'].startswith('test_')]
        self.assertEqual([row['kind'] for row in rows], ['test_start', 'test_outcome', 'test_stop'])
        self.assertTrue(all(row['test'] == test.id() for row in rows))
        self.assertTrue(outcome.wasSuccessful())

    def test_after_import_hook_runs_once_the_module_executed(self):
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder) / 'kinfakepw' / 'sync_api'
            package.mkdir(parents=True)
            (Path(folder) / 'kinfakepw' / '__init__.py').write_text('', encoding='utf-8')
            (package / '__init__.py').write_text('from kinfakepw.sync_api._generated import BrowserType\n', encoding='utf-8')
            (package / '_generated.py').write_text('class BrowserType:\n    def launch(self, **kwargs):\n        return kwargs\n', encoding='utf-8')
            seen = []
            finder = self.observer._AfterImport('kinfakepw.sync_api._generated', lambda module: seen.append(module.BrowserType))
            sys.path.insert(0, folder)
            sys.meta_path.insert(0, finder)
            try:
                importlib.import_module('kinfakepw.sync_api')
                self.assertEqual(len(seen), 1)
                self.assertIs(seen[0], sys.modules['kinfakepw.sync_api._generated'].BrowserType)
            finally:
                sys.meta_path.remove(finder)
                sys.path.remove(folder)
                for name in [n for n in sys.modules if n.startswith('kinfakepw')]:
                    del sys.modules[name]

    def test_sitecustomize_is_dormant_without_the_environment_variable(self):
        script = 'import sys; import kin_transport_observer as o; print(o.installed())'
        base = {k: v for k, v in os.environ.items() if k not in ('KIN_TRANSPORT_DIAG_DIR', 'PYTHONPATH')}
        for extra, want in (({}, 'False'), ({'KIN_TRANSPORT_DIAG_DIR': self.folder.name}, 'True')):
            env = dict(base, PYTHONPATH=str(HERE / 'observer'), **extra)
            done = subprocess.run([sys.executable, '-B', '-c', script], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual((done.returncode, done.stdout.strip()), (0, want), done.stderr)
        self.assertTrue(any(json.loads(line)['kind'] == 'hook' for path in Path(self.folder.name).glob('events-*.jsonl')
                            for line in path.read_text(encoding='utf-8').splitlines()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
