"""S4-EG1 offline judge: one verdict per assertion ID over the recorded Gateway evidence (stdlib only).

tests/gateway_pipeline_live.py only records what it observed; this module decides. The harness asks it about each
block before going on, and the dispatch workflow asks it again over the uploaded files, so the live verdict and the
offline re-judgement are the same code. Every check reads raw fields (docker log lines, list rows, psql rows) and
fails closed: a missing or malformed field fails its ID, it is never skipped. tests/gateway_pipeline_vectors.json holds
one clean vector and one violating vector per ID, and tests/gateway_pipeline_contract_test.py requires each violation
to fail exactly its own ID.
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 'kin-eg1-scenario/1'
TEARDOWN_SCHEMA = 'kin-eg1-teardown/1'
IDS = ('S-1', 'S-2',
       'N-1', 'N-2', 'N-3', 'N-4', 'N-5', 'N-6',
       'B-1', 'B-2', 'B-3', 'B-4', 'B-5',
       'R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7', 'R-8', 'R-9', 'R-10',
       'F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'F-8',
       'X-1', 'X-2', 'X-3', 'X-4', 'X-5',
       'T-1', 'T-2', 'T-3', 'T-4', 'T-5')
SCENARIO_IDS = tuple(name for name in IDS if not name.startswith('T-'))
# What the harness asks after each part. X-5 needs every block complete and the T IDs need the teardown, so both are
# judged later: X-5 at the end of the last method, the T IDs only offline.
BLOCK_IDS = {
    'setup': ('S-1', 'S-2'),
    'N': ('N-1', 'N-2', 'N-3', 'N-4', 'N-5', 'N-6'),
    'B': ('B-1', 'B-2', 'B-3', 'B-4', 'B-5'),
    'R': ('R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7', 'R-8', 'R-9', 'R-10'),
    'F': ('F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'F-8'),
    'X': ('X-1', 'X-2', 'X-3', 'X-4'),
}

BUDGET = 24 * 1024 * 1024       # the agent's body limit at BYTE_BUDGET_MIB=24 (agent.py:148-160)
NEAR_LIMIT = 20 * 1024 * 1024   # R3: a batch that uses the budget, not a token one
BACKOFF = 90                    # A1: flat test backoff; a request after study.retry + 90 s has no retry state to pull
RECEIPT_LAG = 100               # A1: BACKOFF_MAX 90 bounds the flush of the final receipt after an outage (O-3)
RETRY_NOW_WITHIN = 45           # one 30 s Now Retry poll plus loop time after the request
QUIET = 18                      # F-8: 3 x (StableAge 5 + poll 1); a bounded window, not a proof of never
IN_FLIGHT_TAIL = 12             # a request already in flight at reconnect ends by the 10 s HTTP timeout plus one poll
LOG_KEYS = frozenset(('at', 'event', 'uid', 'batch', 'sops', 'failed', 'bytes', 'attempt', 'afterSeconds', 'error',
                      'status', 'code', 'pending', 'byteBudget'))
OUTAGE_ERRORS = ('token request ConnectionError', 'cloud request ConnectionError')
STALL_ERROR = 'cloud request ReadTimeout'
F01_ERROR = 'single DICOM instance exceeds byte budget'
INSTITUTION = 'KIN 판독센터'
RESOLVE = {'kin-cloud': True, 'kin-api': False, 'kin-db': False, 'kin-keycloak': False, 'kin-orthanc': False}
OWNED_COUNTS = ('orthanc_studies', 'StudyState', 'GatewayReceipt', 'GatewayRetryRequest', 'AuditLog')
_STAMP = re.compile(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(?:Z|\+00:00)')


def stamp(text):
    """A UTC time as written by `docker logs --timestamps` (nanoseconds) or by the harness (microseconds)."""
    match = _STAMP.fullmatch(text)
    if not match:
        raise ValueError('not a UTC timestamp')
    whole = datetime.strptime(match.group(1), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp()
    return whole + float('0.' + (match.group(2) or '0'))


def parse_line(line):
    """One `docker logs --timestamps` line as (time, object), or None when it is not one timestamped JSON object."""
    head, _, body = line.partition(' ')
    try:
        value = json.loads(body)
        return (stamp(head), value) if isinstance(value, dict) else None
    except ValueError:
        return None


def events(scenario):
    found = []
    for line in scenario['agent_log']['stdout']:
        parsed = parse_line(line)
        if parsed is not None:
            found.append(dict(parsed[1], _t=parsed[0]))
    return sorted(found, key=lambda item: item['_t'])


def pick(found, event=None, uid=None, after=None, before=None):
    """Events in [after, before] (both inclusive, docker time), optionally of one name and one study."""
    low = float('-inf') if after is None else stamp(after)
    high = float('inf') if before is None else stamp(before)
    return [item for item in found if (event is None or item.get('event') == event)
            and (uid is None or item.get('uid') == uid) and low <= item['_t'] <= high]


def named(found, event):
    return [item for item in found if item.get('event') == event]


def cstore_ok(record, count):
    return record == {'exit': 0, 'ok': count, 'fail': 0}


def receipt_is(row, phase, success, local):
    receipt = row['gatewayReceipt']
    return (receipt['phase'], receipt['successCount'], receipt['localCount']) == (phase, success, local)


def converged(local, cloud, count):
    return len(local) == len(set(local)) == count and len(cloud) == len(set(cloud)) and set(cloud) == set(local)


def failed_receipt(row, local):
    return (row['phase'], row['errorCode'], row['successCount'], row['localCount']) == (
        'failed', 'instance_exceeds_budget', 0, local)


# ── setup ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def _s1(s, t, d, e):
    digest = s['setup']['agent_sha256']
    return bool(re.fullmatch(r'[0-9a-f]{64}', digest['container'])) and digest['container'] == digest['checkout']


def _s2(s, t, d, e):
    return s['setup']['resolve'] == RESOLVE


# ── Block N: normal transfer and late delta ───────────────────────────────────────────────────────────────────────

def _n1(s, t, d, e):
    return cstore_ok(s['N']['first']['cstore'], 1)


def _n2(s, t, d, e):
    block = s['N']
    seen = pick(e, uid=block['uid'], after=block['first']['t_send'], before=block['late']['t_send'])
    return (len(named(seen, 'study.queued')) == 1
            and [(item['sops'], item['failed']) for item in named(seen, 'batch.stored')] == [(1, 0)]
            and [item['sops'] for item in named(seen, 'study.complete')] == [1]
            and not named(seen, 'study.retry') and not named(seen, 'study.failed'))


def _n3(s, t, d, e):
    first = s['N']['first']
    return converged(first['local'], first['cloud'], 1)


def _n4(s, t, d, e):
    row = s['N']['first']['list']
    return (row['institutionName'] == INSTITUTION and row['ss'] == 'Unverified' and row['count'] == 1
            and receipt_is(row, 'complete', 1, 1) and row['gatewayReceipt']['errorCode'] is None)


def _n5(s, t, d, e):
    return s['N']['first']['audit'].count('study.announce') == 1


def _n6(s, t, d, e):
    block = s['N']
    first, late = block['first'], block['late']
    seen = pick(e, uid=block['uid'], after=late['t_send'], before=block['t_end'])
    return (cstore_ok(late['cstore'], 1)
            and [(item['sops'], item['failed']) for item in named(seen, 'batch.stored')] == [(1, 0)]
            and [item['sops'] for item in named(seen, 'study.complete')] == [2]
            and converged(late['local'], late['cloud'], 2) and receipt_is(late['list'], 'complete', 2, 2)
            and late['list']['gatewayReceipt']['agentSeq'] > first['list']['gatewayReceipt']['agentSeq']
            and late['audit'].count('study.announce') == 1)


# ── Block B: multi-batch, outage, graceful restart, resume ────────────────────────────────────────────────────────

def _b1(s, t, d, e):
    block = s['B']
    part = block['a']
    seen = pick(e, uid=block['uid'], after=part['t_send'], before=block['outage']['t_disconnect'])
    done, stored = named(seen, 'study.complete'), named(seen, 'batch.stored')
    return (cstore_ok(part['cstore'], 47) and part['plan'] == [47] and [item['sops'] for item in stored] == part['plan']
            and all(NEAR_LIMIT <= item['bytes'] <= BUDGET and item['failed'] == 0 for item in stored)
            and [item['sops'] for item in done] == [47]
            and len([item for item in named(seen, 'study.queued') if item['_t'] <= done[0]['_t']]) == 1)


def _b2(s, t, d, e):
    block = s['B']
    outage = block['outage']
    retries = pick(e, event='study.retry', uid=block['uid'], after=outage['t_disconnect'],
                   before=block['restart']['t_restart'])
    return (outage['detached'] is True and cstore_ok(outage['cstore'], 48) and bool(retries)
            and all(item['error'] in OUTAGE_ERRORS for item in retries)
            and outage['list']['count'] == 47 and receipt_is(outage['list'], 'complete', 47, 47))


def _b3(s, t, d, e):
    restart = s['B']['restart']
    window = pick(e, after=restart['t_restart'], before=restart['t_done'])
    stopped, started = named(window, 'agent.stopped'), named(window, 'agent.started')
    status = restart['status']
    # A5: a graceful stop logs agent.stopped before the new process starts, and the link is still down afterwards.
    return (restart['started_before'] != restart['started_after'] and len(stopped) == 1 and len(started) == 1
            and stopped[0]['_t'] <= started[0]['_t'] and status['phase'] == 'retry'
            and status['successfulSops'] == 47 and status['attempt'] >= 1 and restart['detached_after'] is True)


def _b4(s, t, d, e):
    block = s['B']
    reconnect = block['reconnect']
    stored = pick(e, event='batch.stored', uid=block['uid'], after=block['outage']['t_disconnect'],
                  before=block['t_end'])
    done = pick(e, event='study.complete', uid=block['uid'], after=reconnect['t_reconnect'], before=block['t_end'])
    return (reconnect['attached'] is True and len(reconnect['plan']) == 2 and sum(reconnect['plan']) == 48
            and [item['sops'] for item in stored] == reconnect['plan'] and stored[0]['bytes'] >= NEAR_LIMIT
            and all(item['bytes'] <= BUDGET and item['failed'] == 0 for item in stored)
            and [item['sops'] for item in done] == [95])


def _b5(s, t, d, e):
    block = s['B']
    final = block['final']
    done = pick(e, event='study.complete', uid=block['uid'], after=block['reconnect']['t_reconnect'],
                before=block['t_end'])
    refused = pick(e, event='receipt.refused', uid=block['uid'], after=block['a']['t_send'], before=block['t_end'])
    return (converged(final['local'], final['cloud'], 95) and final['list']['count'] == 95
            and receipt_is(final['list'], 'complete', 95, 95) and len(done) == 1
            and stamp(final['t_receipt_seen']) - done[0]['_t'] <= RECEIPT_LAG
            and final['list']['gatewayReceipt']['epoch'] == block['outage']['list']['gatewayReceipt']['epoch']
            and not refused and final['audit'].count('gateway.receipt.epoch_unrecognised') == 0
            and final['audit'].count('study.announce') == 1)


# ── Block R: storage stall, crash restart, Now Retry ──────────────────────────────────────────────────────────────

def _stall_retries(s, e):
    block = s['R']
    return pick(e, event='study.retry', uid=block['uid'], after=block['crash']['t_crash'], before=block['t_unpause'])


def _r1(s, t, d, e):
    block = s['R']
    first = block['c1']
    done = pick(e, event='study.complete', uid=block['uid'], after=first['t_send'], before=block['stall']['t_pause'])
    return (cstore_ok(first['cstore'], 1) and [item['sops'] for item in done] == [1] and first['list']['count'] == 1
            and receipt_is(first['list'], 'complete', 1, 1))


def _r2(s, t, d, e):
    stall = s['R']['stall']
    return (stall['paused'] is True and cstore_ok(stall['cstore'], 1) and stall['status']['phase'] == 'sending'
            and stall['status']['successfulSops'] == 1)


def _r3(s, t, d, e):
    block = s['R']
    crash = block['crash']
    stopped = pick(e, event='agent.stopped', after=block['stall']['t_pause'], before=crash['t_done'])
    started = pick(e, event='agent.started', after=crash['t_crash'], before=crash['t_done'])
    # The new process re-announces the row at once (process() sets announcing first, agent.py:748), so a snapshot
    # right after the restart may show either phase; the row, not its phase, is what survives the crash.
    return (crash['started_before'] != crash['started_after'] and not stopped and len(started) == 1
            and crash['status']['phase'] in ('sending', 'announcing') and crash['status']['successfulSops'] == 1)


def _r4(s, t, d, e):
    return ([item['error'] for item in _stall_retries(s, e)] == [STALL_ERROR]
            and s['R']['retry_audit'].count('study.announce') == 1)


def _r5(s, t, d, e):
    block = s['R']
    receipt = block['retry_list']['gatewayReceipt']
    # The killed STOW may still be stored after unpause, so the listed count is 1 or 2 (recorded, both accepted).
    return (block['unpaused'] is True and receipt['phase'] == 'retry' and receipt['attempt'] >= 1
            and receipt['errorCode'] == 'cloud_unreachable' and receipt['successCount'] == 1
            and receipt['localCount'] == 2 and block['retry_list']['count'] in (1, 2))


def _r6(s, t, d, e):
    block = s['R']
    asked = block['request']
    return (asked['status'] == 200 and asked['body']['studyUid'] == block['uid']
            and asked['body']['result'] == 'requested' and block['request_audits'] == 1)


def _r7(s, t, d, e):
    block = s['R']
    asked = block['request']
    pulled = pick(e, event='study.retry_now', uid=block['uid'], after=asked['t'], before=block['t_end'])
    retried = _stall_retries(s, e)
    return (len(pulled) == 1 and bool(retried) and pulled[0]['_t'] - stamp(asked['t']) <= RETRY_NOW_WITHIN
            and pulled[0]['_t'] < retried[0]['_t'] + BACKOFF)


def _r8(s, t, d, e):
    block = s['R']
    asked, final = block['request'], block['final']
    stored = pick(e, event='batch.stored', uid=block['uid'], after=asked['t'], before=block['t_end'])
    done = pick(e, event='study.complete', uid=block['uid'], after=asked['t'], before=block['t_end'])
    return ([item['sops'] for item in stored] == [1] and [item['sops'] for item in done] == [2]
            and converged(final['local'], final['cloud'], 2))


def _r9(s, t, d, e):
    final = s['R']['final']
    return (receipt_is(final['list'], 'complete', 2, 2) and final['poll'] == {'status': 200, 'body': {'studyUids': []}}
            and final['second'] == {'status': 409, 'code': 'GATEWAY_RETRY_NOT_RETRY'} and final['request_audits'] == 1)


def _r10(s, t, d, e):
    block = s['R']
    refused = pick(e, event='receipt.refused', uid=block['uid'], after=block['c1']['t_send'], before=block['t_end'])
    return (block['final']['list']['gatewayReceipt']['epoch'] == block['c1']['list']['gatewayReceipt']['epoch']
            and not refused)


# ── Block F: oversized instance, F-01 boundary, bounded repeat ────────────────────────────────────────────────────

def _f1(s, t, d, e):
    return cstore_ok(s['F']['big']['cstore'], 1)


def _f2(s, t, d, e):
    block = s['F']
    seen = pick(e, uid=block['uid'], after=block['big']['t_send'], before=block['normal']['t_send'])
    return ([item['error'] for item in named(seen, 'study.failed')] == [F01_ERROR]
            and not named(seen, 'batch.stored') and block['status']['phase'] == 'failed')


def _f3(s, t, d, e):
    return failed_receipt(s['F']['db_receipt'], 1)


def _f4(s, t, d, e):
    block = s['F']
    absent = block['list']['not_observed']
    # A4: the zero-delivered study's list shape belongs to S4-F01V; a receipt on the absent item is recorded as data
    # (receipt_projection_present) and never judged here. The empty cloud is F-6's.
    return block['list']['in_studies'] is False and absent['uid'] == block['uid'] and absent['origin'] == 'gateway'


def _f5(s, t, d, e):
    block = s['F']
    return (block['request'] == {'status': 409, 'code': 'GATEWAY_RETRY_UNSUPPORTED_F01'}
            and block['request_rows'] == 0 and block['request_audits'] == 0)


def _f6(s, t, d, e):
    return s['F']['cloud'] == []


def _f7(s, t, d, e):
    block = s['F']
    normal = block['normal']
    seen = pick(e, uid=block['uid'], after=normal['t_send'], before=block['quiet']['t_start'])
    return (cstore_ok(normal['cstore'], 1) and len(named(seen, 'study.queued')) == 1
            and [item['error'] for item in named(seen, 'study.failed')] == [F01_ERROR]
            and not named(seen, 'batch.stored') and failed_receipt(normal['db_receipt'], 2)
            and normal['cloud'] == [] and normal['audit'].count('study.announce') == 1)


def _f8(s, t, d, e):
    block = s['F']
    quiet = block['quiet']
    start, end = stamp(quiet['t_start']), stamp(quiet['t_end'])
    again = [item for item in pick(e, uid=block['uid'], before=quiet['t_end'])
             if item['_t'] > start and item.get('event') in ('study.queued', 'study.failed')]
    return end - start >= QUIET and not again


# ── Block X: cross-study convergence and negative controls ────────────────────────────────────────────────────────

def _x1(s, t, d, e):
    studies = s['X']['studies']
    return (all(converged(studies[key]['local'], studies[key]['cloud'], count)
                for key, count in (('N', 2), ('B', 95), ('R', 2)))
            and studies['F']['cloud'] == [])


def _x2(s, t, d, e):
    outage = (stamp(s['B']['outage']['t_disconnect']), stamp(s['B']['reconnect']['t_reconnect']))
    stall = (stamp(s['R']['stall']['t_pause']), stamp(s['R']['request']['t']))

    def injected(item):
        return ((item.get('uid') == s['B']['uid'] and outage[0] <= item['_t'] <= outage[1])
                or (item.get('uid') == s['R']['uid'] and stall[0] <= item['_t'] <= stall[1]))

    return not named(e, 'agent.retry') and all(injected(item) for item in named(e, 'study.retry'))


def _x3(s, t, d, e):
    low = stamp(s['B']['outage']['t_disconnect'])
    high = stamp(s['B']['reconnect']['t_reconnect']) + IN_FLIGHT_TAIL
    refused = [item for item in e
               if item.get('event') in ('receipt.refused', 'retry_request.invalid', 'retry_request.unconfirmed')]
    deferred = [item for item in e if item.get('event') in ('receipt.deferred', 'retry_request.deferred')]
    return not refused and all(low <= item['_t'] <= high for item in deferred)


def _x4(s, t, d, e):
    log = s['agent_log']
    lines = log['stdout']
    markers = [value for key in ('names', 'ids') for value in s['markers'][key]]
    parsed = [parse_line(line) for line in lines]
    return (log['stderr'] == [] and bool(lines) and len(markers) >= 8
            and all(isinstance(marker, str) and marker for marker in markers)
            and all(item is not None and 'event' in item[1] and set(item[1]) <= LOG_KEYS for item in parsed)
            and not any(marker in line for marker in markers for line in lines))


def _x5(s, t, d, e):
    return s['schema'] == SCHEMA and all(s[key]['complete'] is True for key in ('setup', 'N', 'B', 'R', 'F', 'X'))


# ── Teardown (offline only) ───────────────────────────────────────────────────────────────────────────────────────

def _t1(s, t, d, e):
    project = t['gateway_project']
    return (t['schema'] == TEARDOWN_SCHEMA and bool(re.fullmatch(r'kin-eg1-gw-[0-9a-f]{12}', project['project']))
            and (project['containers'], project['volumes'], project['networks']) == ([], [], []))


def _t2(s, t, d, e):
    owned = t['owned']
    expected = {s[key]['uid'] for key in ('N', 'B', 'R', 'F')
                if isinstance(s, dict) and isinstance(s.get(key), dict) and 'uid' in s[key]}
    return (bool(owned) and expected <= set(owned)
            and all(set(row) == set(OWNED_COUNTS) and all(row[key] == 0 for key in OWNED_COUNTS)
                    for row in owned.values()))


def _t3(s, t, d, e):
    client = t['gateway_client']
    return isinstance(client['id'], str) and bool(client['id']) and client['status_after'] == 404


def _t4(s, t, d, e):
    return d['remaining'] == {'containers': [], 'volumes': [], 'networks': []} and d['problems'] == []


def _t5(s, t, d, e):
    fixtures = t['fixtures']
    return fixtures['dir_exists'] is False and fixtures['dcm_in_artifacts'] == []


CHECKS = {
    'S-1': _s1, 'S-2': _s2,
    'N-1': _n1, 'N-2': _n2, 'N-3': _n3, 'N-4': _n4, 'N-5': _n5, 'N-6': _n6,
    'B-1': _b1, 'B-2': _b2, 'B-3': _b3, 'B-4': _b4, 'B-5': _b5,
    'R-1': _r1, 'R-2': _r2, 'R-3': _r3, 'R-4': _r4, 'R-5': _r5, 'R-6': _r6, 'R-7': _r7, 'R-8': _r8, 'R-9': _r9,
    'R-10': _r10,
    'F-1': _f1, 'F-2': _f2, 'F-3': _f3, 'F-4': _f4, 'F-5': _f5, 'F-6': _f6, 'F-7': _f7, 'F-8': _f8,
    'X-1': _x1, 'X-2': _x2, 'X-3': _x3, 'X-4': _x4, 'X-5': _x5,
    'T-1': _t1, 'T-2': _t2, 'T-3': _t3, 'T-4': _t4, 'T-5': _t5,
}


def judge(evidence, ids=IDS):
    """The failing assertion IDs, in the order asked. evidence = {'scenario', 'teardown', 'daemon'}; any may be None."""
    try:
        scenario, teardown, daemon = evidence.get('scenario'), evidence.get('teardown'), evidence.get('daemon')
    except AttributeError:
        return list(ids)
    try:
        found = events(scenario)
    except Exception:
        found = None
    failing = []
    for name in ids:
        try:
            holds = bool(CHECKS[name](scenario, teardown, daemon, found))
        except Exception:   # a missing or malformed field fails its ID; nothing is skipped
            holds = False
        if not holds:
            failing.append(name)
    return failing


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--evidence', required=True,
                        help='scenario-evidence.json; teardown-evidence.json and daemon-empty.json are read beside it')
    parser.add_argument('--out', help='judge.json to create (default: beside the evidence); never overwritten')
    args = parser.parse_args(argv)
    path = Path(args.evidence)
    inputs, evidence = {}, {}
    for key, source in (('scenario', path), ('teardown', path.parent / 'teardown-evidence.json'),
                        ('daemon', path.parent / 'daemon-empty.json')):
        try:
            raw = source.read_bytes()
            inputs[source.name] = hashlib.sha256(raw).hexdigest()
            evidence[key] = json.loads(raw.decode('utf-8'))
        except (OSError, ValueError):
            inputs[source.name] = None
            evidence[key] = None
    findings = judge(evidence)
    out = Path(args.out) if args.out else path.parent / 'judge.json'
    with out.open('x', encoding='utf-8') as stream:
        json.dump({'schema': 'kin-eg1-judge/1', 'inputs': inputs, 'ids': len(IDS), 'findings': findings}, stream,
                  indent=2)
        stream.write('\n')
    print('EG1-JUDGE ' + json.dumps({'findings': findings}), flush=True)
    return 0 if not findings else 1


if __name__ == '__main__':
    sys.exit(main())
