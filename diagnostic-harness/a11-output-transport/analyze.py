#!/usr/bin/env python3
"""Preregistered analysis of the one hosted A11-OUTPUT-1 volume-mip-output transport diagnostic run (never-merged harness).

It reads only the uploaded observation files (tmp/mipout-diag) and the profile's own logs, applies the decision rules registered
in preregistration.json and writes one JSON result. It never changes, retries or reinterprets the native outcome, never counts a
network rejection or a guard re-attempt as semantic detection, and never infers a cause from a request count alone.

  analyze.py --diag tmp/mipout-diag --profile tests/e2e/artifacts/volume-mip-output-ci [--out analysis.json]
"""
import argparse
import bisect
import collections
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
ORIGIN_PORT = '9443'
SOURCE_PREFIXES = ('/instances/', '/api/')
MATCH_START_MS = 1000           # Playwright request startTime against the NetLog URL request start
SUCCESS_OVERLAP_MS = 250        # a completed NetLog request that started with the rejected one
FALLBACK_SEEN_MS = (5000, 1000) # without startTime: NetLog end within [seen - 5 s, seen + 1 s]
BOUNDARY_MS = 5000              # a GOAWAY on the request's session at most this long before the request ended
CLOSE_AFTER_MS = 1000           # a session close at most this long after the request ended
TAIL_MS = 2000                  # an unclosed NetLog that ends this close to a failure cannot exclude a later boundary
CONNECTION_MATCH_MS = 3000
RULE_IDS = ('R0-validity', 'R1-inputs', 'R2-rejections', 'R3-mapping', 'R4-classification', 'R5-reporting')
REQUIRED_EVENT_TYPES = ('HTTP2_SESSION', 'HTTP2_SESSION_SEND_HEADERS', 'HTTP2_SESSION_RECV_GOAWAY', 'HTTP2_SESSION_CLOSE',
                        'URL_REQUEST_START_JOB', 'REQUEST_ALIVE')
KEPT_EVENT_TYPES = frozenset(REQUIRED_EVENT_TYPES) | {
    'HTTP2_SESSION_INITIALIZED', 'HTTP2_SESSION_RECV_HEADERS', 'HTTP2_SESSION_SEND_RST_STREAM', 'HTTP2_SESSION_RECV_RST_STREAM',
    'HTTP2_SESSION_POOL_REMOVE_SESSION', 'HTTP2_STREAM_ERROR', 'FAILED', 'CANCELLED', 'HTTP_TRANSACTION_RESTART_AFTER_ERROR',
    'TCP_CONNECT'}
NON_TRANSPORT = ('ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE', 'ERR_BLOCKED_BY_ORB', 'ERR_BLOCKED_BY_ADMINISTRATOR',
                 'ERR_CERT_', 'ERR_NAME_NOT_RESOLVED', 'ERR_INSECURE_RESPONSE', 'ERR_ACCESS_DENIED', 'ERR_INVALID_URL',
                 'ERR_UNSAFE_PORT', 'ERR_DISALLOWED_URL_SCHEME', 'ERR_UNKNOWN_URL_SCHEME', 'ERR_CACHE_MISS')
ROTATION_RESTARTS = ('ERR_HTTP2_SERVER_REFUSED_STREAM', 'ERR_HTTP2_GOAWAY_FRAME')
TRANSPORT_GUARD = 'MIP_OUTPUT_TRANSPORT_FAILURE'
TRANSPORT_TEXTS = ('Failed to fetch', 'network error')
STATEMENTS = [
    'The native outcome is reported exactly as the profile produced it; no product file, test, assertion, retry, message or '
    'budget was changed, and a failing test stays failing.',
    'MIP_OUTPUT_TRANSPORT_FAILURE lines and guarded re-attempts are existing instrumentation; a network rejection is never '
    'semantic or mutant detection.',
    'A connection request count at or near keepalive_requests is corroboration only; no classification uses it without the '
    'NetLog relation of rule R3.',
    'A passing diagnostic profile without a page-visible rejection does not resolve the main-01 failure (Validate run '
    '35014440552, job 104534192354); PARTIAL or INCONCLUSIVE leaves A11-OUTPUT-1 main acceptance blocked.',
    'The HTTP/2 rotation explanation stays a hypothesis unless this run is SUPPORTED, and SUPPORTED describes this run only.',
]

TYPE_TAIL = re.compile(rb'"type":\s*(-?\d+)\s*\}\s*,?\s*$')
DEPENDENCY = b'"source_dependency"'
ACCESS = re.compile(
    r'^msec=(?P<msec>[\d.]+) pid=(?P<pid>\d+) conn=(?P<conn>\d+) conn_req=(?P<conn_req>\d+) http2=(?P<http2>\S*) '
    r'proto=(?P<proto>\S+) remote=(?P<remote>\S+) server_port=(?P<server_port>\S+) method=(?P<method>\S+) '
    r'uri="(?P<uri>[^"]*)" status=(?P<status>\d+) bytes=(?P<bytes>\d+) req_len=(?P<req_len>\d+) req_time=(?P<req_time>[\d.]+) '
    r'up_status=(?P<up_status>\S*) up_time=(?P<up_time>\S*) completion=(?P<completion>\S*) ua="(?P<ua>[^"]*)"$')
ERROR_LINE = re.compile(r'^(?P<ts>\d{4}/\d\d/\d\d \d\d:\d\d:\d\d) \[(?P<level>\w+)\] (?P<pid>\d+)#\d+: (?:\*(?P<conn>\d+) )?(?P<message>.*)$')
OUTCOME = re.compile(r'^(test_mip_output_\w+ \(.*\) \.\.\. .*|(FAIL|ERROR): .*|Ran \d+ tests? in .*|OK( \(.*\))?|FAILED \(.*\))$')


def load_registry():
    return json.loads((HERE / 'preregistration.json').read_text(encoding='utf-8'))


# ---------------------------------------------------------------------------------------------------------------- NetLog
def _constants(prefix):
    text = prefix.decode('utf-8', 'replace').strip()
    if text.startswith('{'):
        text = text[1:]
    try:
        value = json.loads('{' + text.strip().rstrip(',') + '}')
    except ValueError:
        return None
    return value.get('constants') if isinstance(value, dict) else None


def _inverse(mapping):
    return {value: key for key, value in (mapping or {}).items() if isinstance(value, int)}


def read_netlog(path):
    """Tolerant reader of Chromium's file NetLog: a constants object, then one event per line. A file cut by a killed browser
    still yields every complete event line; 'closed' records whether the events array was terminated at shutdown."""
    info = {'path': str(path), 'bytes': 0, 'constants': False, 'events_array': False, 'closed': False, 'event_lines': 0,
            'unparsed_lines': 0, 'kept_events': 0, 'last_time_ms': None}
    constants, events, deps = None, [], collections.defaultdict(set)
    names = sources = {}
    head = []
    with open(path, 'rb') as stream:
        for raw in stream:
            info['bytes'] += len(raw)
            if not info['events_array']:
                head.append(raw)
                joined = b''.join(head).rstrip()
                for marker in (b'"events": [', b'"events":['):
                    if joined.endswith(marker):
                        constants = _constants(joined[:-len(marker)])
                        info['constants'] = constants is not None
                        info['events_array'] = True
                        names, sources = _inverse((constants or {}).get('logEventTypes')), _inverse((constants or {}).get('logSourceType'))
                        break
                continue
            line = raw.strip()
            if not line or info['closed']:
                continue
            if line.startswith(b']'):
                info['closed'] = True
                continue
            info['event_lines'] += 1
            body = line[:-1] if line.endswith(b',') else line
            if body.endswith((b'}]', b'}]}')):
                # The events array closed on the last event's own line.
                body = body[:body.rindex(b']')]
                info['closed'] = True
            tail = TYPE_TAIL.search(body)
            name = names.get(int(tail.group(1))) if tail else None
            if tail is not None and name not in KEPT_EVENT_TYPES and DEPENDENCY not in body:
                continue
            try:
                event = json.loads(body)
            except ValueError:
                info['unparsed_lines'] += 1
                continue
            name = names.get(event.get('type'))
            source = event.get('source') or {}
            try:
                time_ms = int(event.get('time'))
            except (TypeError, ValueError):
                info['unparsed_lines'] += 1
                continue
            info['last_time_ms'] = time_ms if info['last_time_ms'] is None else max(info['last_time_ms'], time_ms)
            params = event.get('params') if isinstance(event.get('params'), dict) else {}
            dependency = params.get('source_dependency')
            if isinstance(dependency, dict) and isinstance(dependency.get('id'), int):
                deps[source.get('id')].add(dependency['id'])
            if name in KEPT_EVENT_TYPES:
                events.append((time_ms, name, event.get('phase'), source.get('id'), sources.get(source.get('type')), params))
                info['kept_events'] += 1
    return info, constants, events, deps


def _header(headers, key):
    if isinstance(headers, dict):
        return headers.get(key)
    for item in headers or []:
        if isinstance(item, str) and item.startswith(key + ': '):
            return item[len(key) + 2:]
    return None


def _int(value):
    if isinstance(value, int):
        return value
    match = re.match(r'^\s*(-?\d+)', str(value)) if value is not None else None
    return int(match.group(1)) if match else None


def netlog_model(path):
    info, constants, events, deps = read_netlog(path)
    constants = constants or {}
    offset = _int(constants.get('timeTickOffset')) or 0
    errors = _inverse(constants.get('netError'))
    phases = _inverse(constants.get('logEventPhase')) or {0: 'PHASE_NONE', 1: 'PHASE_BEGIN', 2: 'PHASE_END'}
    present = set((constants.get('logEventTypes') or {}))
    client = constants.get('clientInfo') or {}
    command_line = client.get('command_line') if isinstance(client.get('command_line'), str) else None
    sessions, requests, sockets = {}, {}, {}

    def error_name(code):
        return None if code is None else errors.get(code, str(code))

    for time_ms, name, phase, sid, stype, params in events:
        wall = offset + time_ms
        phase_name = phases.get(phase, str(phase))
        if name == 'TCP_CONNECT' and phase_name == 'PHASE_END':
            sockets[sid] = params.get('source_address') or params.get('local_address')
        if stype == 'HTTP2_SESSION':
            s = sessions.setdefault(sid, {'id': sid, 'host': None, 'start_wall': wall, 'end_wall': None, 'socket': None,
                                         'streams': {}, 'goaways': [], 'rst_sent': [], 'rst_recv': [], 'closes': [], 'stream_errors': []})
            if name == 'HTTP2_SESSION' and phase_name == 'PHASE_BEGIN':
                s['host'] = params.get('host') or params.get('host_and_port')
                s['start_wall'] = wall
            elif name == 'HTTP2_SESSION' and phase_name == 'PHASE_END':
                s['end_wall'] = wall
            elif name == 'HTTP2_SESSION_INITIALIZED':
                dependency = params.get('source_dependency') or {}
                s['socket'] = dependency.get('id')
            elif name == 'HTTP2_SESSION_SEND_HEADERS':
                stream_id = _int(params.get('stream_id'))
                dependency = params.get('source_dependency') or {}
                s['streams'][stream_id] = {'stream_id': stream_id, 'send_wall': wall, 'path': _header(params.get('headers'), ':path'),
                                           'method': _header(params.get('headers'), ':method'), 'request': dependency.get('id'),
                                           'responded_wall': None}
            elif name == 'HTTP2_SESSION_RECV_HEADERS':
                stream = s['streams'].get(_int(params.get('stream_id')))
                if stream is not None and stream['responded_wall'] is None:
                    stream['responded_wall'] = wall
            elif name == 'HTTP2_SESSION_RECV_GOAWAY':
                s['goaways'].append({'wall': wall, 'last_accepted': _int(params.get('last_accepted_stream_id')),
                                     'error_code': params.get('error_code'), 'active_streams': params.get('active_streams'),
                                     'unclaimed_streams': params.get('unclaimed_streams')})
            elif name in ('HTTP2_SESSION_SEND_RST_STREAM', 'HTTP2_SESSION_RECV_RST_STREAM'):
                s['rst_sent' if name.endswith('SEND_RST_STREAM') else 'rst_recv'].append(
                    {'wall': wall, 'stream_id': _int(params.get('stream_id')), 'error_code': params.get('error_code')})
            elif name == 'HTTP2_SESSION_CLOSE':
                s['closes'].append({'wall': wall, 'net_error': error_name(_int(params.get('net_error'))),
                                    'description': params.get('description')})
            elif name == 'HTTP2_STREAM_ERROR':
                s['stream_errors'].append({'wall': wall, 'stream_id': _int(params.get('stream_id')),
                                           'net_error': error_name(_int(params.get('net_error')))})
        elif stype == 'URL_REQUEST':
            r = requests.setdefault(sid, {'id': sid, 'url': None, 'host': None, 'path': None, 'method': None, 'start_wall': wall,
                                         'end_wall': None, 'net_error': None, 'restarts': [], 'streams': []})
            if name == 'URL_REQUEST_START_JOB' and r['url'] is None:
                r['url'], r['method'] = params.get('url'), params.get('method')
                try:
                    parts = urlsplit(r['url'] or '')
                    r['host'], r['path'] = parts.netloc, parts.path
                except ValueError:
                    pass
            elif name == 'REQUEST_ALIVE' and phase_name == 'PHASE_BEGIN':
                r['start_wall'] = wall
            elif name == 'REQUEST_ALIVE' and phase_name == 'PHASE_END':
                r['end_wall'] = wall
                if params.get('net_error') is not None:
                    r['net_error'] = _int(params.get('net_error'))
            elif name == 'FAILED':
                r['net_error'] = _int(params.get('net_error'))
            elif name == 'CANCELLED' and r['net_error'] is None:
                r['net_error'] = next((code for code, label in errors.items() if label == 'ERR_ABORTED'), -3)
            elif name == 'HTTP_TRANSACTION_RESTART_AFTER_ERROR':
                r['restarts'].append(error_name(_int(params.get('net_error'))))
    for s in sessions.values():
        s['local_address'] = sockets.get(s['socket'])
        for stream in s['streams'].values():
            if stream['request'] in requests:
                requests[stream['request']]['streams'].append((s['id'], stream['stream_id'], stream['send_wall']))
    for r in requests.values():
        r['net_error_name'] = error_name(r['net_error'])
    last_wall = offset + info['last_time_ms'] if info['last_time_ms'] is not None else None
    return {'info': info, 'offset': offset, 'present_event_types': present, 'command_line': command_line,
            'sessions': sessions, 'requests': requests, 'deps': deps, 'last_wall': last_wall}


def netlog_capability(path):
    """What the hosted preflight checks: the file is written, closed, Default mode and names the event types rule R3 needs."""
    model = netlog_model(path)
    info = model['info']
    return {'path': str(path), 'bytes': info['bytes'], 'constants': info['constants'], 'complete': info['constants'] and info['closed'],
            'event_lines': info['event_lines'], 'unparsed_lines': info['unparsed_lines'],
            'command_line_recorded': model['command_line'] is not None,
            'capture_mode_default': bool(model['command_line'] and '--net-log-capture-mode=Default' in model['command_line']),
            'missing_event_types': [name for name in REQUIRED_EVENT_TYPES if name not in model['present_event_types']]}


# ------------------------------------------------------------------------------------------------------------ nginx logs
def nginx_logs(proxy):
    config = (proxy / 'nginx-effective-config.txt').read_text(encoding='utf-8', errors='replace') if (proxy / 'nginx-effective-config.txt').is_file() else None
    limits = {}
    for key in ('keepalive_requests', 'keepalive_timeout'):
        found = re.findall(r'^\s*' + key + r'\s+([^;#]+);', config or '', re.M)
        limits[key] = sorted(set(value.strip() for value in found))
    keepalive = int(limits['keepalive_requests'][0]) if len(limits['keepalive_requests']) == 1 and limits['keepalive_requests'][0].isdigit() else None
    connections, unparsed, aborted = {}, 0, []
    access = proxy / 'access-conn.log'
    if access.is_file():
        for line in access.read_text(encoding='utf-8', errors='replace').splitlines():
            match = ACCESS.match(line)
            if not match:
                unparsed += bool(line.strip())
                continue
            row = match.groupdict()
            msec, conn, conn_req = float(row['msec']) * 1000, int(row['conn']), int(row['conn_req'])
            c = connections.setdefault(conn, {'conn': conn, 'requests': 0, 'max_conn_req': 0, 'h2': False, 'remote': row['remote'],
                                              'first_msec': msec, 'last_msec': msec, 'statuses': collections.Counter(), 'uris': {}})
            c['requests'] += 1
            c['max_conn_req'] = max(c['max_conn_req'], conn_req)
            c['h2'] = c['h2'] or row['http2'] == 'h2'
            c['first_msec'], c['last_msec'] = min(c['first_msec'], msec), max(c['last_msec'], msec)
            c['statuses'][row['status']] += 1
            c['uris'].setdefault(row['uri'], []).append(msec)
            if row['status'] == '499':
                aborted.append({'msec': msec, 'conn': conn, 'conn_req': conn_req, 'uri': row['uri']})
    for c in connections.values():
        for times in c['uris'].values():
            times.sort()
    errors = collections.defaultdict(list)
    error_path = proxy / 'error-info.log'
    if error_path.is_file():
        for line in error_path.read_text(encoding='utf-8', errors='replace').splitlines():
            match = ERROR_LINE.match(line)
            if match:
                errors[match.group('conn')].append({'ts': match.group('ts'), 'level': match.group('level'), 'message': match.group('message')[:300]})
    defaulted = keepalive is None and config is not None and not limits['keepalive_requests']
    effective = keepalive if keepalive is not None else (1000 if defaulted else None)
    at_limit = sorted(c['conn'] for c in connections.values() if c['h2'] and effective is not None and c['max_conn_req'] == effective)
    return {'effective_config_present': config is not None,
            'diagnostic_access_log_in_effective_config': bool(config and 'access_log /var/log/kin-diag/access-conn.log kin_diag_conn;' in config),
            'limits_in_effective_config': limits,
            'keepalive_requests_effective': effective,
            'keepalive_requests_source': 'explicit' if keepalive is not None else ('nginx default (no directive in the effective configuration)' if defaulted else 'unknown'),
            'access_log_present': access.is_file(), 'unparsed_access_lines': unparsed, 'connections': connections,
            'aborted_499': aborted, 'error_lines_by_connection': errors, 'connections_at_keepalive_requests': at_limit}


def match_connection(session, connections, window=CONNECTION_MATCH_MS):
    """The browser reaches nginx through Docker's port publishing, so ports differ; match a NetLog session to one nginx HTTP/2
    connection by its streams' paths and times. Corroboration only."""
    # Only answered streams reached nginx as requests; a refused or reset stream has no access line by definition.
    streams = [s for s in session['streams'].values() if s['path'] and s['responded_wall'] is not None]
    if not streams:
        return None
    best = None
    for c in connections.values():
        if not c['h2'] or c['last_msec'] < session['start_wall'] - window or (session['end_wall'] and c['first_msec'] > session['end_wall'] + window):
            continue
        hits = 0
        for stream in streams:
            times = c['uris'].get(stream['path'].split('?')[0])
            if times:
                at = bisect.bisect_left(times, stream['send_wall'] - window)
                hits += at < len(times) and times[at] <= stream['send_wall'] + window
        score = min(hits / len(streams), hits / c['requests'])
        if best is None or score > best[1]:
            best = (c, score)
    if best is None or best[1] < 0.9:
        return None
    c, score = best
    return {'conn': c['conn'], 'score': round(score, 3), 'requests': c['requests'], 'max_conn_req': c['max_conn_req']}


# -------------------------------------------------------------------------------------------------------- browser events
def browser_events(folder):
    rows, bad = [], 0
    for path in sorted(folder.glob('events-*.jsonl')) if folder.is_dir() else []:
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                bad += 1
    rows.sort(key=lambda r: (r.get('wall') or 0, r.get('pid') or 0, r.get('seq') or 0))
    return rows, bad


def split_failures(rows):
    failed = [r for r in rows if r.get('kind') == 'requestfailed']
    visible = [r for r in failed if 'ERR_ABORTED' not in str(r.get('failure'))]
    source = [r for r in visible if str(r.get('host') or '').endswith(':' + ORIGIN_PORT) and str(r.get('path') or '').startswith(SOURCE_PREFIXES)]
    return failed, visible, source


# ------------------------------------------------------------------------------------------------------------ rule R3
def verdict(kind, reason, detail):
    return {'relation': kind, 'reason': reason, **detail}


def _path_streams(session, request, model):
    """Unlinked streams on a session that carry this request's path while it was alive (a stream linked to another request is not)."""
    low = request['start_wall'] - 50
    high = (request['end_wall'] if request['end_wall'] is not None else request['start_wall']) + 50
    return [s for s in session['streams'].values() if s['path'] and s['path'].split('?')[0] == request['path'] and low <= s['send_wall'] <= high
            and (s['request'] == request['id'] or s['request'] not in model['requests'])]


def bind_session(request, model):
    """(session, stream id or None, how), 'ambiguous', or None. 'No stream' is claimed only when the bound session sent none for the path."""
    bound = [binding for binding in request['streams'] if request['end_wall'] is None or binding[2] <= request['end_wall'] + 100]
    if bound:
        session_id, stream_id, _ = max(bound, key=lambda binding: binding[2])
        return model['sessions'][session_id], stream_id, 'stream source_dependency'
    seen, frontier = {request['id']}, [request['id']]
    for _ in range(3):
        frontier = [dep for node in frontier for dep in model['deps'].get(node, ()) if dep not in seen]
        seen.update(frontier)
        found = [model['sessions'][node] for node in frontier if node in model['sessions']]
        if found:
            session = min(found, key=lambda s: abs(s['start_wall'] - request['start_wall']))
            streams = _path_streams(session, request, model)
            if len(streams) > 1:
                return 'ambiguous'
            if streams:
                return session, streams[0]['stream_id'], 'dependency session, then stream by path and time'
            return session, None, 'dependency session; it sent no stream for the path while the request was alive'
    streams = [(s, stream) for s in model['sessions'].values() for stream in _path_streams(s, request, model)]
    if len(streams) == 1:
        return streams[0][0], streams[0][1]['stream_id'], 'stream by path and time only'
    return 'ambiguous' if streams else None


def evaluate(request, model):
    detail = {'netlog_request': request['id'], 'net_error': request['net_error_name'], 'start_wall_ms': request['start_wall'],
              'end_wall_ms': request['end_wall'], 'restarts': request['restarts']}
    name = request['net_error_name'] or ''
    if name.startswith(NON_TRANSPORT):
        return verdict('INCOMPATIBLE', 'the NetLog request failed with a non-transport network error', detail)
    binding = bind_session(request, model)
    if binding is None:
        return verdict('UNMAPPED', 'no HTTP/2 session binding for the failed NetLog request', detail)
    if binding == 'ambiguous':
        return verdict('UNMAPPED', 'more than one unlinked stream could belong to the failed NetLog request', detail)
    session, stream_id, detail['binding'] = binding
    end = request['end_wall'] if request['end_wall'] is not None else model['last_wall']
    stream = session['streams'].get(stream_id) if stream_id is not None else None
    goaways = [g for g in session['goaways'] if g['wall'] <= end + 100 and end - g['wall'] <= BOUNDARY_MS]
    closes = [c for c in session['closes'] if request['start_wall'] - 100 <= c['wall'] <= end + CLOSE_AFTER_MS]
    later = sum(1 for s in session['streams'].values() if s['send_wall'] > end)
    reset = [x for x in session['rst_recv'] if stream_id is not None and x['stream_id'] == stream_id]
    detail.update(session=session['id'], session_host=session['host'], stream_id=stream_id,
                  goaway=goaways[-1] if goaways else None, close=closes[0] if closes else None,
                  later_streams_on_session=later, server_rst_stream=reset,
                  stream_responded=bool(stream and stream['responded_wall'] is not None))
    if goaways:
        goaway = goaways[-1]
        if stream_id is None:
            return verdict('COMPATIBLE', 'the request got no stream on a session that had received GOAWAY', detail)
        if goaway['last_accepted'] is None:
            return verdict('UNMAPPED', 'GOAWAY without last_accepted_stream_id', detail)
        if stream_id > goaway['last_accepted']:
            return verdict('COMPATIBLE', 'the request stream is above the GOAWAY last_accepted_stream_id', detail)
        if closes:
            return verdict('COMPATIBLE', 'an accepted stream was still open when its session closed after GOAWAY', detail)
        return verdict('INCOMPATIBLE', 'an accepted stream failed while its session stayed open after GOAWAY', detail)
    if closes and not detail['stream_responded']:
        return verdict('COMPATIBLE', 'the request was active when its HTTP/2 session closed without GOAWAY', detail)
    if not model['info']['closed'] and model['last_wall'] is not None and model['last_wall'] - end <= TAIL_MS:
        return verdict('UNMAPPED', 'the unclosed NetLog ends too soon after the failure to exclude a later boundary', detail)
    if reset:
        return verdict('INCOMPATIBLE', 'server RST_STREAM on the request stream without a session boundary', detail)
    return verdict('INCOMPATIBLE', 'no GOAWAY or close on the request HTTP/2 session near the failure', detail)


def map_rejection(rejection, model):
    timing = rejection.get('timing') if isinstance(rejection.get('timing'), dict) else {}
    start = timing.get('startTime')
    start = float(start) if isinstance(start, (int, float)) and start > 0 else None
    seen = float(rejection.get('wall') or 0) * 1000
    same = [r for r in model['requests'].values() if r['path'] == rejection.get('path') and r['host'] == rejection.get('host')
            and (r['method'] or 'GET') == rejection.get('method')]

    def near(r):
        if start is not None:
            return abs(r['start_wall'] - start) <= MATCH_START_MS
        return r['end_wall'] is not None and seen - FALLBACK_SEEN_MS[0] <= r['end_wall'] <= seen + FALLBACK_SEEN_MS[1]

    candidates = [r for r in same if near(r)]
    failed = [r for r in candidates if r['net_error'] not in (None, 0)]
    anchor = start if start is not None else seen
    if failed:
        request = min(failed, key=lambda r: abs(r['start_wall'] - anchor))
        if request['net_error_name'] == 'ERR_ABORTED':
            return verdict('UNMAPPED', 'the matching NetLog request was cancelled (ERR_ABORTED), not failed in transport',
                           {'netlog_request': request['id'], 'net_error': 'ERR_ABORTED'})
        return evaluate(request, model)
    if start is not None:
        completed = [r for r in same if r['net_error'] in (None, 0) and r['end_wall'] is not None and abs(r['start_wall'] - start) <= SUCCESS_OVERLAP_MS]
        if completed:
            request = min(completed, key=lambda r: abs(r['start_wall'] - start))
            return verdict('INCOMPATIBLE', 'the NetLog request that started with the rejected one completed without a network error',
                           {'netlog_request': request['id'], 'net_error': None})
    return verdict('UNMAPPED', 'no failed NetLog URL request matches the page-visible rejection', {'candidates_same_path': len(same)})


# -------------------------------------------------------------------------------------------------------------- inputs
def harness_validity(diag, baseline):
    records = {}
    for kind in ('restore', 'prepare', 'preflight', 'collect'):
        path = diag / 'harness' / (kind + '.json')
        try:
            records[kind] = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            records[kind] = None
    collect = records['collect'] or {}
    checks = {c.get('name'): c.get('ok') for c in collect.get('checks', [])}
    reasons = []
    for kind in ('restore', 'prepare', 'collect'):
        if (records[kind] or {}).get('result') != 'passed':
            reasons.append('%s record did not pass' % kind)
    if checks.get('HEAD is still the baseline') is not True:
        reasons.append('post-profile HEAD was not proven to be the baseline %s' % baseline)
    if checks.get('no tracked difference after the profile') is not True:
        reasons.append('post-profile tracked tree was not proven unchanged')
    return {'valid': not reasons, 'reasons': reasons,
            'results': {kind: (records[kind] or {}).get('result') for kind in records},
            'preflight_netlog': (records['preflight'] or {}).get('netlog')}


def failure_blocks(rows):
    # unittest prints '=' * 70, 'FAIL: name', '-' * 70, then the traceback; a block ends at the next '=' * 70 or at 'Ran N tests'.
    blocks, current = [], None
    for line in rows:
        if line.startswith(('FAIL: ', 'ERROR: ')):
            current = [line]
            blocks.append(current)
        elif current is not None:
            if line.startswith('=' * 70) or re.match(r'^Ran \d+ tests? in ', line) or len(current) >= 200:
                current = None
            elif not line.startswith('-' * 70):
                current.append(line)
    return blocks


def native_outcome(profile):
    log = profile / 'test_volume_mip_output.log'
    data = {'test_log_present': log.is_file(), 'results': None}
    if log.is_file():
        rows = log.read_text(encoding='utf-8', errors='replace').splitlines()
        data.update(outcome_lines=[row for row in rows if OUTCOME.match(row)], failure_blocks=failure_blocks(rows),
                    plan_result=[row for row in rows if row.startswith('PLAN_RESULT ')],
                    transport_guard_lines=[row for row in rows if TRANSPORT_GUARD in row],
                    transport_text_in_failures=[text for text in TRANSPORT_TEXTS if any(text in line for block in failure_blocks(rows) for line in block)])
    results = profile / 'results.json'
    if results.is_file():
        try:
            data['results'] = json.loads(results.read_text(encoding='utf-8'))
        except ValueError:
            data['results'] = 'unparseable'
    return data


# ----------------------------------------------------------------------------------------------------------- analysis
def analyze(diag, profile):
    registry = load_registry()
    diag, profile = Path(diag), Path(profile)
    validity = harness_validity(diag, registry['baseline']['sha'])
    rows, bad_rows = browser_events(diag / 'browser')
    launches = [r for r in rows if r.get('kind') == 'launch']
    hook = {'event_rows': len(rows), 'unparsed_rows': bad_rows, 'processes': sorted({r.get('pid') for r in rows if r.get('kind') == 'hook'}),
            'launches': launches, 'launch_failures': [r for r in rows if r.get('kind') == 'launch_failed'],
            'contexts': sum(1 for r in rows if r.get('kind') == 'context'), 'pages': sum(1 for r in rows if r.get('kind') == 'page'),
            'route_changes': [r for r in rows if r.get('kind') == 'route'], 'hook_errors': [r for r in rows if r.get('kind') == 'hook_error'],
            'tests': [r.get('test') for r in rows if r.get('kind') == 'test_start']}
    failed, visible, source = split_failures(rows)
    netlogs = sorted((diag / 'browser' / 'netlog').glob('*.json')) if (diag / 'browser' / 'netlog').is_dir() else []
    models = []
    for path in netlogs:
        try:
            models.append(netlog_model(path))
        except OSError as error:
            hook['hook_errors'].append({'kind': 'netlog_unreadable', 'path': str(path), 'error': str(error)})
    proxy = nginx_logs(diag / 'proxy')
    native = native_outcome(profile)

    netlog_summary = []
    for model in models:
        origin = [s for s in model['sessions'].values() if str(s['host'] or '').endswith(':' + ORIGIN_PORT)]
        restarts = collections.Counter(name for r in model['requests'].values() for name in r['restarts'])
        netlog_summary.append({**model['info'], 'command_line_has_default_capture': bool(model['command_line'] and '--net-log-capture-mode=Default' in model['command_line']),
                               'missing_event_types': [n for n in REQUIRED_EVENT_TYPES if n not in model['present_event_types']],
                               'url_requests': len(model['requests']), 'http2_sessions_to_origin': len(origin),
                               'goaways_on_origin_sessions': [{'session': s['id'], 'streams_sent': len(s['streams']), **g} for s in origin for g in s['goaways']],
                               'origin_session_closes': [{'session': s['id'], 'streams_sent': len(s['streams']), **c} for s in origin for c in s['closes']],
                               'restart_after_error_counts': dict(restarts),
                               'failed_request_errors': dict(collections.Counter(r['net_error_name'] for r in model['requests'].values() if r['net_error'] not in (None, 0)))})
    usable = [m for m in models if m['info']['constants'] and m['info']['event_lines'] and not [n for n in REQUIRED_EVENT_TYPES if n not in m['present_event_types']]]
    hook_ok = bool(launches) and any('--net-log-capture-mode=Default' in ' '.join(r.get('added_args') or []) for r in launches)

    mapped = []
    for rejection in source:
        best, owner = None, None
        for model in usable:
            candidate = map_rejection(rejection, model)
            if best is None or (best['relation'] == 'UNMAPPED' and candidate['relation'] != 'UNMAPPED'):
                best, owner = candidate, model
        best = best or verdict('UNMAPPED', 'no usable NetLog', {})
        corroboration = None
        if best.get('session') is not None and owner is not None:
            corroboration = match_connection(owner['sessions'][best['session']], proxy['connections'])
            if corroboration is not None:
                corroboration['at_keepalive_requests'] = proxy['keepalive_requests_effective'] is not None and corroboration['max_conn_req'] == proxy['keepalive_requests_effective']
        mapped.append({'rejection': {k: rejection.get(k) for k in ('seq', 'pid', 'wall', 'monotonic', 'test', 'context', 'page', 'method', 'url', 'failure', 'resource_type', 'timing')},
                       'netlog_file': owner['info']['path'] if owner else None, **best, 'nginx_connection': corroboration})

    rotation = {'netlog_goaways_on_origin_sessions': sum(len(s['goaways_on_origin_sessions']) for s in netlog_summary),
                'netlog_rotation_restarts': sum(count for s in netlog_summary for name, count in s['restart_after_error_counts'].items() if name in ROTATION_RESTARTS),
                'nginx_connections_at_keepalive_requests': len(proxy['connections_at_keepalive_requests'])}
    rotation['observed'] = any(rotation.values())

    rule, reasons = None, []
    if not validity['valid']:
        result, rule, reasons = 'INCONCLUSIVE', 'R0-validity', validity['reasons']
    elif not native['test_log_present']:
        result, rule, reasons = 'INCONCLUSIVE', 'R1-inputs', ['the profile left no test log']
    elif not hook_ok:
        result, rule, reasons = 'INCONCLUSIVE', 'R1-inputs', ['the browser observer recorded no NetLog launch, so absent rejections prove nothing']
    elif not source and (native.get('transport_guard_lines') or native.get('transport_text_in_failures')):
        result, rule, reasons = 'INCONCLUSIVE', 'R2-rejections', ['the profile reported a transport text or guard line that the observer did not capture']
    elif not source:
        if rotation['observed']:
            result, rule, reasons = 'PARTIAL', 'R4-classification', ['HTTP/2 connection boundaries occurred without a page-visible source-read rejection']
        else:
            result, rule, reasons = 'INCONCLUSIVE', 'R4-classification', ['no page-visible source-read rejection and no observed connection boundary']
    elif not usable:
        result, rule, reasons = 'INCONCLUSIVE', 'R1-inputs', ['page-visible rejections exist but no usable NetLog maps them']
    else:
        relations = [m['relation'] for m in mapped]
        if 'INCOMPATIBLE' in relations:
            result, rule = 'REJECTED', 'R4-classification'
            reasons = ['rejection %s: %s' % (m['rejection']['seq'], m['reason']) for m in mapped if m['relation'] == 'INCOMPATIBLE']
        elif all(relation == 'COMPATIBLE' for relation in relations):
            result, rule = 'SUPPORTED', 'R4-classification'
            reasons = ['every page-visible source-read rejection maps to a GOAWAY or HTTP/2 session boundary in NetLog']
        else:
            result, rule = 'INCONCLUSIVE', 'R3-mapping'
            reasons = ['rejection %s: %s' % (m['rejection']['seq'], m['reason']) for m in mapped if m['relation'] == 'UNMAPPED']

    connections = proxy.pop('connections')
    proxy['connection_count'] = len(connections)
    proxy['http2_connections'] = [{k: c[k] for k in ('conn', 'requests', 'max_conn_req', 'first_msec', 'last_msec')} | {'statuses': dict(c['statuses'])}
                                  for c in sorted(connections.values(), key=lambda c: c['first_msec']) if c['h2']]
    proxy['error_lines_by_connection'] = {key or 'none': value[:50] for key, value in proxy['error_lines_by_connection'].items()}
    return {'schema_version': 1, 'question': registry['question'], 'baseline': registry['baseline']['sha'],
            'decision_rules': registry['decision_rules'], 'harness_validity': validity,
            'classification': {'result': result, 'rule': rule, 'reasons': reasons},
            'page_visible_source_read_rejections': mapped,
            'other_page_visible_failures': [r for r in visible if r not in source],
            'aborted_or_cancelled_failures': len(failed) - len(visible),
            'rotation_observations': rotation,
            'request_limit_coincidence': {'per_rejection': [m['nginx_connection'] for m in mapped], 'causal_inference_from_count_alone': False},
            'existing_guard_instrumentation': {'transport_guard_lines': native.get('transport_guard_lines', []),
                                               'counted_as_detection': False},
            'native_outcome': native, 'browser_observer': hook, 'netlog': netlog_summary, 'nginx': proxy,
            'statements': STATEMENTS}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--diag', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--out')
    args = parser.parse_args(argv)
    text = json.dumps(analyze(args.diag, args.profile), ensure_ascii=False, indent=1, default=str) + '\n'
    if args.out:
        Path(args.out).write_text(text, encoding='utf-8')
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
