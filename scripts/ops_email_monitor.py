"""External probe + bounded SMTP outbox; no PACS credentials or raw logs in mail."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formatdate
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import sys
import time
import uuid

from ops_monitor import atomic_json, origin_url, prepare_dir, probe, read_json
from ops_notify import CODES

MAX_ATTEMPTS = 24
ADDRESS = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}')
STATE_KEYS = {'schema', 'origin', 'recipient', 'open', 'day', 'attempts', 'pending', 'last_sent', 'checked_at'}
EVENT_KEYS = {'id', 'kind', 'checked_at', 'faults'}


def require(value):
    if not value:
        raise ValueError('Invalid monitor configuration or state')


def address(value):
    require(type(value) is str and len(value) <= 254 and ADDRESS.fullmatch(value))
    return value


def private_file(path):
    require(not path.is_symlink() and path.is_file())
    info = path.stat()
    if os.name == 'posix':
        require(info.st_uid == os.geteuid() and not stat.S_IMODE(info.st_mode) & 0o077)


def credentials(path):
    private_file(path)
    require(path.stat().st_size <= 65536)
    result = {}
    # The existing file also contains unrelated ERP credentials. Select only these
    # keys; never import its collectors or expose the whole environment in output.
    for line in path.read_text(encoding='utf-8').splitlines():
        key, sep, value = line.partition('=')
        key = key.strip()
        if sep and key in ('HANMAIL_USER', 'HANMAIL_APP_PW'):
            require(key not in result)
            result[key] = value.strip().strip('"').strip("'")
    require(set(result) == {'HANMAIL_USER', 'HANMAIL_APP_PW'} and all(result.values()))
    require(all('\r' not in item and '\n' not in item for item in result.values()))
    sender = result['HANMAIL_USER']
    address(sender if '@' in sender else sender + '@hanmail.net')
    return result


@contextmanager
def lock(path):
    require(not path.is_symlink())
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode))
        if os.name == 'posix':
            import fcntl
            require(info.st_uid == os.geteuid() and not stat.S_IMODE(info.st_mode) & 0o077)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            import msvcrt
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        yield
    finally:
        # Keep the inode: unlinking a flock file lets another process lock a new
        # inode while the old one is still held. Closing releases a crashed owner.
        os.close(descriptor)


def event_valid(event):
    require(type(event) is dict and set(event) == EVENT_KEYS)
    require(type(event['id']) is str and re.fullmatch('[0-9a-f]{32}', event['id']))
    require(event['kind'] in ('alert', 'recovery'))
    require(type(event['checked_at']) is int and event['checked_at'] >= 0)
    require(type(event['faults']) is list and all(type(code) is str and code in CODES for code in event['faults']))
    require((event['kind'] == 'recovery') == (len(event['faults']) == 0))


def initial(origin, recipient, now):
    return {'schema': 1, 'origin': origin_url(origin), 'recipient': address(recipient), 'open': False,
            'day': now // 86400, 'attempts': 0, 'pending': None, 'last_sent': None, 'checked_at': 0}


def load_state(path, origin, recipient):
    private_file(path)
    state = read_json(path)
    require(type(state) is dict and set(state) == STATE_KEYS)
    require(type(state['schema']) is int and state['schema'] == 1)
    require(state['origin'] == origin and state['recipient'] == recipient)
    require(type(state['open']) is bool)
    require(type(state['day']) is int and state['day'] >= 0)
    require(type(state['attempts']) is int and 0 <= state['attempts'] <= MAX_ATTEMPTS)
    require(type(state['checked_at']) is int and state['checked_at'] >= 0)
    for field in ('pending', 'last_sent'):
        if state[field] is not None:
            event_valid(state[field])
    require(state['open'] == (state['last_sent'] is not None and state['last_sent']['kind'] == 'alert'))
    if state['pending']:
        require((state['pending']['kind'] == 'recovery') == state['open'])
    return state


def send_mail(values, recipient, origin, event, drill=False):
    event_valid(event)
    sender = values['HANMAIL_USER']
    message = EmailMessage()
    message['From'] = address(sender if '@' in sender else sender + '@hanmail.net')
    message['To'] = address(recipient)
    message['Subject'] = ('[KIN 장애 훈련]' if drill else '[KIN PACS 운영]') + (' 감지' if event['kind'] == 'alert' else ' 복구')
    message['Date'] = formatdate(event['checked_at'], localtime=False)
    message['Message-ID'] = '<' + event['id'] + '@koreaimagingnetwork.com>'
    observed = datetime.fromtimestamp(event['checked_at'], timezone.utc).isoformat()
    message.set_content('관측 대상: ' + origin_url(origin) + '\n관측 UTC: ' + observed
                        + '\n상태: ' + event['kind'] + '\n코드: ' + ', '.join(event['faults'])
                        + '\n\n자동 감지 알림입니다. 관측 시각 이후 상태는 달라질 수 있습니다. 환자 정보와 원본 로그는 포함하지 않습니다.\n')
    with smtplib.SMTP_SSL('smtp.daum.net', 465, timeout=30, context=ssl.create_default_context()) as smtp:
        smtp.login(values['HANMAIL_USER'], values['HANMAIL_APP_PW'])
        if smtp.send_message(message):
            raise RuntimeError('SMTP recipient refused')


def tick(path, origin, recipient, report, send, now):
    state = load_state(path, origin, recipient)
    require(type(report) is dict and set(report) == {'ok', 'maintenance', 'faults', 'checked_at'})
    require(type(report['ok']) is bool and type(report['maintenance']) is bool)
    require(type(report['checked_at']) is int and abs(now - report['checked_at']) <= 60)
    require(type(report['faults']) is list and all(type(code) is str and code in CODES for code in report['faults']))
    require(report['ok'] == (not report['faults']) and (not report['maintenance'] or report['ok']))
    require(type(now) is int and now >= state['checked_at'] and now // 86400 >= state['day'])
    if now // 86400 > state['day']:
        state['day'], state['attempts'] = now // 86400, 0
    state['checked_at'] = now
    if state['pending'] is None:
        kind = 'alert' if not report['ok'] and not state['open'] else (
            'recovery' if report['ok'] and not report['maintenance'] and state['open'] else None)
        if kind:
            state['pending'] = {'id': uuid.uuid4().hex, 'kind': kind, 'checked_at': report['checked_at'],
                                'faults': sorted(set(report['faults']))}
    if state['pending'] is None:
        atomic_json(path, state)
        return {'notification': 'unchanged', 'checked_at': now, 'open': state['open']}
    if state['attempts'] >= MAX_ATTEMPTS:
        atomic_json(path, state)
        raise RuntimeError('Daily SMTP attempt limit reached')
    state['attempts'] += 1
    atomic_json(path, state)
    # Persist before SMTP and acknowledge only afterwards. A lost SMTP reply can
    # cause a duplicate with the same Message-ID; it must never silently lose mail.
    send(state['pending'])
    state['last_sent'], state['pending'] = state['pending'], None
    state['open'] = state['last_sent']['kind'] == 'alert'
    atomic_json(path, state)
    return {'notification': state['last_sent']['kind'], 'checked_at': now, 'open': state['open']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--recipient', required=True)
    parser.add_argument('--credentials', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--mode', choices=['live', 'drill-alert', 'drill-recover'], default='live')
    parser.add_argument('--initialize', action='store_true')
    args = parser.parse_args()
    try:
        origin, recipient = origin_url(args.origin), address(args.recipient)
        prepare_dir(args.state_dir, 0o700)
        path = args.state_dir / ('live.json' if args.mode == 'live' else 'drill.json')
        with lock(args.state_dir / 'run.lock'):
            now = int(time.time())
            if args.initialize:
                # Missing/corrupt state must not silently reset the daily budget.
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, 'w') as output:
                    json.dump(initial(origin, recipient, now), output)
                    output.flush(); os.fsync(output.fileno())
                print(json.dumps({'initialized': True}))
                return 0
            values = credentials(args.credentials)
            report = probe(origin) if args.mode == 'live' else {
                'ok': args.mode == 'drill-recover', 'maintenance': False, 'checked_at': now,
                'faults': ['notification_drill'] if args.mode == 'drill-alert' else []}
            # The probe may take up to four bounded network timeouts.
            result = tick(path, origin, recipient, report,
                          lambda event: send_mail(values, recipient, origin, event, args.mode != 'live'), int(time.time()))
            print(json.dumps(result))
            return 0
    except Exception as error:
        print(json.dumps({'monitor_failed': True, 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
