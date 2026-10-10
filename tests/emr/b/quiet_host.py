"""REQ-D949 -> RISK-EMR-HOST-NOISE -> pre-lease and in-run validity evidence.

No container is stopped to make a host quiet. The probe has no host mounts or
network. CPU is sampled on both the invoking OS and the Docker engine host.
"""
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

IDLE_CPU_LIMIT = .20
ACTIVE_CPU_LIMIT = .90
PREFLIGHT_SECONDS = 30
SAMPLE_SECONDS = 5


class InvalidRun(RuntimeError):
    pass


def command(args):
    return subprocess.check_output(args, timeout=15, text=True, encoding='utf-8')


def host_cpu():
    if os.name == 'nt':
        idle, kernel, user = (ctypes.c_ulonglong() for _ in range(3))
        if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
            raise OSError('GetSystemTimes failed')
        return kernel.value + user.value, idle.value
    return linux_cpu(Path('/proc/stat').read_text())


def linux_cpu(text):
    values = list(map(int, text.splitlines()[0].split()[1:9]))
    return sum(values), values[3] + values[4]


def utilization(before, after):
    total = after[0] - before[0]
    if total <= 0:
        raise InvalidRun('CPU sample did not advance')
    return 1 - (after[1] - before[1]) / total


def quiet_verdict(snapshot, allowed_labels, active=False):
    foreign = [c['Names'] for c in snapshot['containers']
               if not set(c.get('Labels', '').split(',')).intersection(allowed_labels)]
    limit = ACTIVE_CPU_LIMIT if active else IDLE_CPU_LIMIT
    reasons = (['foreign containers: ' + ', '.join(foreign)] if foreign else [])
    for key in ('host_cpu', 'engine_cpu'):
        value = snapshot.get(key)
        if value is None or not 0 <= value <= limit:
            reasons.append(key + ' exceeds ' + str(limit) + ' or is unavailable')
    return {'quiet': not reasons, 'reasons': reasons, 'foreign_containers': foreign,
            'cpu_limit': limit, 'phase': 'measurement' if active else 'idle'}


class HostProbe:
    def __init__(self, name):
        self.name = name

    def counters(self):
        raw = command(['docker', 'exec', self.name, 'sh', '-c', 'cat /proc/stat; cat /proc/loadavg'])
        return {'host': host_cpu(), 'engine': linux_cpu(raw),
                'engine_loadavg': raw.splitlines()[-1], 'host_loadavg': os.getloadavg() if hasattr(os, 'getloadavg') else None}

    def snapshot(self, before):
        after = self.counters()
        containers = [json.loads(s) for s in command(['docker', 'ps', '--no-trunc', '--format', '{{json .}}']).splitlines()]
        return after, {'utc': datetime.now(timezone.utc).isoformat(), 'monotonic': time.monotonic(),
            'host_cpu': utilization(before['host'], after['host']),
            'engine_cpu': utilization(before['engine'], after['engine']),
            'engine_loadavg': after['engine_loadavg'], 'host_loadavg': after['host_loadavg'], 'containers': containers}


class QuietMonitor:
    def __init__(self, probe, record, allowed_labels):
        self.probe, self.record, self.allowed_labels = probe, Path(record), allowed_labels
        self.stop = threading.Event()
        self.invalid = None

    def sample(self, before, active):
        after, snapshot = self.probe.snapshot(before)
        verdict = quiet_verdict(snapshot, self.allowed_labels, active)
        with self.record.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({**snapshot, **verdict}) + '\n')
        if not verdict['quiet']:
            self.invalid = '; '.join(verdict['reasons'])
        self.require_valid()
        return after

    def require_valid(self):
        if self.invalid:
            raise InvalidRun(self.invalid)

    def preflight(self, seconds=PREFLIGHT_SECONDS):
        before = self.probe.counters()
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            time.sleep(min(SAMPLE_SECONDS, max(0, deadline - time.monotonic())))
            before = self.sample(before, False)

    def __enter__(self):
        def observe():
            try:
                before = self.probe.counters()
                while not self.stop.wait(SAMPLE_SECONDS):
                    before = self.sample(before, True)
            except Exception as error:
                self.invalid = str(error)
        self.thread = threading.Thread(target=observe, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.thread.join(timeout=45)
        if self.thread.is_alive():
            self.invalid = 'host monitor did not stop'
        if args[0] is None:
            self.require_valid()


def launch(plan_path, record_dir):
    """The commander invokes this only after harness review; no retry loop."""
    import hashlib
    import sys
    root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(root / 'tests'))
    import live_test_gate as gate
    plan_path, record_dir = Path(plan_path).resolve(), Path(record_dir).resolve()
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    if plan['unit'] != 'emr-b1-r7-jit' or plan['mode'] != 'live':
        raise ValueError('D949 requires the existing live unit and budget')
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise ValueError('95% acceptance is commander-only, never hosted CI')
    gate.preflight_live()  # Read-only: never clears a marker or consumes an attempt.
    record_dir.mkdir(parents=True, exist_ok=False)
    token = uuid.uuid4().hex
    name, label = 'kin-emrb-quiet-' + token[:12], 'kin.emrb.quiet=' + token
    result = {'unit': plan['unit'], 'plan_sha256': hashlib.sha256(plan_path.read_bytes()).hexdigest(),
              'verdict': 'INVALID', 'runner_started': False, 'verdict_attempts_consumed': 0,
              'probe': name, 'probe_label': label}
    preflight = record_dir / 'preflight.json'
    try:
        command(['docker', 'run', '-d', '--name', name, '--label', label, '--network', 'none',
                 'postgres:16-alpine', 'sleep', 'infinity'])
        QuietMonitor(HostProbe(name), record_dir / 'host-before.jsonl', {label}).preflight()
        result['verdict'] = 'QUIET'
        preflight.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        env = {**os.environ, 'KIN_EMR_BENCHMARK_MODE': 'acceptance',
               'KIN_EMR_ACCEPTANCE_RECORD': str(preflight), 'KIN_EMR_LIVE_EVIDENCE': str(record_dir / 'data')}
        result['runner_started'] = True
        code = subprocess.run([sys.executable, 'scripts/record-run.py', '--run-dir', str(record_dir / 'execution'),
            '--tree', 'api/src', '--tree', 'api/prisma', '--tree', 'tests/emr/b', '--file', str(plan_path),
            '--', sys.executable, '-B', 'scripts/run-tests.py', '--plan', str(plan_path)], cwd=root, env=env).returncode
        invalid = list((record_dir / 'data').glob('comparison-*/invalid.json'))
        result.update(runner_exit=code, runner_attempt_consumed=True,
                      verdict='INVALID' if invalid else ('PASS' if code == 0 else 'FAIL'),
                      verdict_attempts_consumed=0 if invalid else 1)
        return 2 if invalid else code
    except (InvalidRun, subprocess.SubprocessError, OSError, ValueError) as error:
        result['verdict'] = 'INVALID'
        result['reason'] = str(error)
        return 2
    finally:
        # Only our exact, labelled probe; never quiet a host by stopping others.
        try:
            actual = json.loads(command(['docker', 'inspect', name]))[0]
            if actual['Config']['Labels'].get('kin.emrb.quiet') == token:
                command(['docker', 'rm', '-f', name])
        finally:
            (record_dir / 'launch.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True)
    parser.add_argument('--record', required=True)
    args = parser.parse_args()
    raise SystemExit(launch(args.plan, args.record))
