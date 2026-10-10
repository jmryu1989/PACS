"""REQ-D952 -> RISK-EMR-HOST-NOISE -> pre-lease and in-run validity evidence.

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
import hashlib

IDLE_CPU_LIMIT = .20
ACTIVE_CPU_LIMIT = .90
PREFLIGHT_SECONDS = 30
SAMPLE_SECONDS = 5
SETTLE_WINDOW_SECONDS = 2
SETTLE_TIMEOUT_SECONDS = 30
ACTIVE_FAILURE_WINDOWS = 3


class InvalidRun(RuntimeError):
    pass


def command(args, timeout=15):
    return subprocess.check_output(args, timeout=timeout, text=True, encoding='utf-8')


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

    def read(self, args, deadline):
        remaining = 5 if deadline is None else min(5, deadline - time.monotonic())
        if remaining <= 0:
            raise InvalidRun('quiet probe deadline expired')
        return command(args, timeout=remaining)

    def counters(self, deadline=None):
        raw = self.read(['docker', 'exec', self.name, 'sh', '-c', 'cat /proc/stat; cat /proc/loadavg'], deadline)
        return {'host': host_cpu(), 'engine': linux_cpu(raw),
                'engine_loadavg': raw.splitlines()[-1], 'host_loadavg': os.getloadavg() if hasattr(os, 'getloadavg') else None}

    def snapshot(self, before, deadline=None):
        after = self.counters(deadline)
        containers = [json.loads(s) for s in self.read(['docker', 'ps', '--no-trunc', '--format', '{{json .}}'], deadline).splitlines()]
        return after, {'utc': datetime.now(timezone.utc).isoformat(), 'monotonic': time.monotonic(),
            'host_cpu': utilization(before['host'], after['host']),
            'engine_cpu': utilization(before['engine'], after['engine']),
            'engine_loadavg': after['engine_loadavg'], 'host_loadavg': after['host_loadavg'], 'containers': containers}


class QuietMonitor:
    def __init__(self, probe, record, allowed_labels):
        self.probe, self.record, self.allowed_labels = probe, Path(record), allowed_labels
        self.stop = threading.Event()
        self.invalid = None
        self.active_failures = 0
        self.last_quiet = False
        self.record_lock = threading.Lock()

    def write(self, value):
        # Main-thread idle windows and background active windows share a file.
        with self.record_lock, self.record.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(value) + '\n')

    def probe_call(self, method, *args, deadline=None):
        for attempt in range(2):
            try:
                return method(*args) if deadline is None else method(*args, deadline=deadline)
            except Exception as error:
                self.write({'utc': datetime.now(timezone.utc).isoformat(),
                            'probe_error': str(error), 'probe_attempt': attempt + 1})
                if attempt:
                    self.invalid = 'probe failed twice: ' + str(error)
                    self.require_valid()

    def sample(self, before, active, deadline=None):
        self.require_valid()
        after, snapshot = self.probe_call(self.probe.snapshot, before, deadline=deadline)
        verdict = quiet_verdict(snapshot, self.allowed_labels, active)
        self.write({**snapshot, **verdict})
        self.last_quiet = verdict['quiet']
        if not active:
            self.idle_quiet = verdict['quiet']
        if verdict['foreign_containers']:
            self.invalid = '; '.join(verdict['reasons'])
        elif active:
            self.active_failures = 0 if verdict['quiet'] else self.active_failures + 1
            if self.active_failures >= ACTIVE_FAILURE_WINDOWS:
                self.invalid = 'three consecutive active CPU windows: ' + '; '.join(verdict['reasons'])
        self.require_valid()
        return after

    def require_valid(self):
        if self.invalid:
            raise InvalidRun(self.invalid)

    def preflight(self, seconds=PREFLIGHT_SECONDS):
        self.wait_quiet(seconds)

    def wait_quiet(self, seconds=SETTLE_TIMEOUT_SECONDS):
        """Outcome-blind: keep every window, never discard a measured block."""
        self.require_valid()
        deadline = time.monotonic() + seconds
        before = self.probe_call(self.probe.counters, deadline=deadline)
        while time.monotonic() + SETTLE_WINDOW_SECONDS <= deadline:
            time.sleep(SETTLE_WINDOW_SECONDS)
            before = self.sample(before, False, deadline=deadline)
            # Evaluate this idle window, not the observer's last active window.
            if self.idle_quiet:
                return
        self.invalid = 'host remained non-quiet for ' + str(seconds) + ' seconds'
        self.require_valid()

    def __enter__(self):
        def observe():
            try:
                before = self.probe_call(self.probe.counters)
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
    import sys
    from live_acceptance import estimate_duration
    root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(root / 'tests'))
    import live_test_gate as gate
    plan_path, record_dir = Path(plan_path).resolve(), Path(record_dir).resolve()
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    if not plan.get('unit') or plan['mode'] != 'live':
        raise ValueError('reviewed live plan with an explicit unit required')
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise ValueError('95% acceptance is commander-only, never hosted CI')
    record_dir.mkdir(parents=True, exist_ok=False)
    token = uuid.uuid4().hex
    name, label = 'kin-emrb-quiet-' + token[:12], 'kin.emrb.quiet=' + token
    result = {'unit': plan['unit'], 'plan_sha256': hashlib.sha256(plan_path.read_bytes()).hexdigest(),
              'verdict': 'INVALID', 'runner_started': False, 'verdict_attempts_consumed': 0,
              'probe': name, 'probe_label': label}
    preflight = record_dir / 'preflight.json'
    probe_started = False
    try:
        result['duration_estimate'] = estimate_duration(plan)
        (record_dir / 'plan-record.json').write_text(json.dumps({
            'plan': plan, 'plan_sha256': result['plan_sha256'],
            'duration_estimate': result['duration_estimate']}, indent=2) + '\n', encoding='utf-8')
        print('EMR_DURATION_ESTIMATE ' + json.dumps(result['duration_estimate']), flush=True)
        if not result['duration_estimate']['within_cap']:
            raise InvalidRun('estimated duration exceeds pre-lease cap')
        gate.preflight_live()  # Read-only: never clears a marker or consumes an attempt.
        command(['docker', 'run', '-d', '--name', name, '--label', label, '--network', 'none',
                 'postgres:16-alpine', 'sleep', 'infinity'])
        probe_started = True
        QuietMonitor(HostProbe(name), record_dir / 'host-before.jsonl', {label}).preflight()
        result['verdict'] = 'QUIET'
        preflight.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        env = {**os.environ, 'KIN_EMR_BENCHMARK_MODE': 'acceptance',
               'KIN_EMR_ACCEPTANCE_RECORD': str(preflight), 'KIN_EMR_ACCEPTANCE_PLAN': str(plan_path),
               'KIN_EMR_LIVE_EVIDENCE': str(record_dir / 'data')}
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
            if probe_started:
                actual = json.loads(command(['docker', 'inspect', name]))[0]
                if actual['Config']['Labels'].get('kin.emrb.quiet') == token:
                    command(['docker', 'rm', '-f', '-v', name])
        finally:
            (record_dir / 'launch.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True)
    parser.add_argument('--record', required=True)
    args = parser.parse_args()
    raise SystemExit(launch(args.plan, args.record))
