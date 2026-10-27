"""Synthetic behavior regressions for removed ops size and process-lock gates."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_backup as backup
import ops_emr_introduction as release
import g3_dispatch
import live_test_gate as gate


class OpsBoundaryTests(unittest.TestCase):
    def test_value_comparison_accepts_more_than_old_row_and_cell_limits(self):
        columns = ['c' + str(n) for n in range(11)]
        rows = sorted(([str(n)] * len(columns) for n in range(100001)), key=backup._value_encoded)
        def run(args, *, output=None, input_file=None, timeout=600, check=True):
            for row in rows:
                output.write(backup._value_encoded(row) + b'\n')
        with patch.object(backup, 'value_columns', return_value=columns), patch.object(backup, 'run', side_effect=run):
            digest = backup.value_table_digest('synthetic', 'kin', 'public', 'Synthetic')
            actual_columns, actual_rows = backup.value_rows('synthetic', 'kin', 'public', 'Synthetic')
        self.assertEqual(digest, backup.value_digest(('kin', 'public', 'table', 'Synthetic', None), columns, rows))
        self.assertEqual(digest['count'], 100001)
        self.assertEqual(actual_columns, columns)
        self.assertEqual(actual_rows, rows)

    def test_registered_exec_output_reaches_the_digest_while_the_command_still_runs(self):
        """#262 review R262-2: restore admission runs the value comparison through a registered Engine exec, whose
        transport and frame decoder held a whole table's COPY output before handing it on. Here a stand-in daemon
        process behind the real transport emits the first rows, then sends the rest only once those rows have reached
        the digest's file; a transport or decoder that waits for the whole output never receives the rest."""
        columns = ['id', 'body']
        rows = sorted(([str(n), 'synthetic \\ 값 "' + str(n) + '"'] for n in range(5)), key=backup._value_encoded)
        lines = [backup._value_encoded(row).replace(b'\\', b'\\\\') + b'\n' for row in rows]
        daemon = r'''import json, os, sys, time
source, marker, patience = sys.argv[1], sys.argv[2], float(sys.argv[3])
data = sys.stdin.buffer
head = b''
while not head.endswith(b'\r\n\r\n'):
    head += data.read(1)
length = int(next(line.split(b':', 1)[1] for line in head.split(b'\r\n') if line.lower().startswith(b'content-length:')))
data.read(length)
path = head.split(b' ', 2)[1]
out = sys.stdout.buffer
def reply(status, body):
    out.write(b'HTTP/1.1 ' + status + b'\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
    out.flush()
frame = lambda channel, body: bytes([channel, 0, 0, 0]) + len(body).to_bytes(4, 'big') + body
if path.endswith(b'/start'):
    out.write(b'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    out.flush()
    data.read()
    first, rest = open(source, 'rb').read().split(b'\0')
    out.write(frame(1, first))
    out.flush()
    end = time.monotonic() + patience
    while not os.path.exists(marker) and time.monotonic() < end:
        time.sleep(0.01)
    if os.path.exists(marker):
        out.write(frame(1, rest[:1]) + frame(2, b'') + frame(1, rest[1:]))
    out.flush()
elif path.endswith(b'/json'):
    reply(b'200 OK', json.dumps({'ID': 'a' * 64, 'ContainerID': 'synthetic', 'Running': False, 'ExitCode': 0}).encode())
else:
    reply(b'201 Created', json.dumps({'Id': 'a' * 64}).encode())
'''
        with tempfile.TemporaryDirectory() as folder:
            source, marker = Path(folder) / 'output', Path(folder) / 'received'
            half = len(lines) // 2
            source.write_bytes(b''.join(lines[:half]) + b'\0' + b''.join(lines[half:]))
            command = [sys.executable, '-c', daemon, str(source), str(marker), '60']
            host = object.__new__(release.HostOps)
            host.intro = SimpleNamespace(save=lambda: None)
            host.run = lambda args, *, input=None, timeout=60, output=None, **_: release.engine_transport(
                command, input, timeout, cwd=folder, env=None, output=output)
            class Arrival:
                def __init__(self, target):
                    self.target = target
                def write(self, data):
                    marker.touch()
                    return self.target.write(data)
            def run(args, *, output=None, input_file=None, timeout=600, check=True):
                return host.exec_instance(args, 3, {'container_id': 'synthetic'}, input=None, stdin=input_file,
                                          output=Arrival(output), timeout=timeout)
            with patch.object(backup, 'value_columns', return_value=columns), patch.object(backup, 'run', side_effect=run):
                digest = backup.value_table_digest('synthetic', 'kin', 'public', 'Synthetic')
            self.assertTrue(marker.exists())
        self.assertEqual(digest, backup.value_digest(('kin', 'public', 'table', 'Synthetic', None), columns, rows))

    def test_racing_startup_never_removes_a_live_owner_lock(self):
        """2026-10-27 reaudit M19-b: two startups saw one dead owner and the slower one deleted the lock the faster one
        had just taken. A complete second startup is run at every step of the first one's recovery; whatever it gets,
        a lock it acquired must still be its own afterwards, and the first startup must then refuse."""
        child = subprocess.Popen([sys.executable, '-c', 'pass'])
        child.wait(timeout=30)
        code = (backup.recover_process_lock.__code__, backup._recover_dead_owner.__code__)
        steps = 0
        while True:
            with tempfile.TemporaryDirectory() as folder:
                lock = Path(folder) / 'operation.lock'
                lock.write_text(str(child.pid) + ':dead')
                seen, outcome = [0], {}
                def trace(frame, event, arg):
                    if frame.f_code in code and event == 'line':
                        seen[0] += 1
                        if seen[0] == steps + 1 and not outcome:
                            backup.recover_process_lock(lock)
                            try:
                                descriptor = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                            except FileExistsError:
                                outcome['second'] = None
                            else:
                                os.write(descriptor, (str(os.getpid()) + ':second').encode())
                                os.close(descriptor)
                                outcome['second'] = str(os.getpid()) + ':second'
                    return trace
                sys.settrace(trace)
                try:
                    backup.recover_process_lock(lock)
                finally:
                    sys.settrace(None)
                if not outcome:
                    break
                with self.subTest(step=steps):
                    try:
                        descriptor = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    except FileExistsError:
                        first = False
                    else:
                        os.close(descriptor)
                        first = True
                    if outcome['second'] is not None:
                        self.assertFalse(first)
                        self.assertEqual(lock.read_text(), outcome['second'])
                    self.assertEqual([p.name for p in Path(folder).iterdir() if p != lock], [])
                steps += 1
        self.assertGreater(steps, 3)

    def test_owner_released_during_recovery_never_costs_the_successor_its_lock(self):
        """#262 review R262-1: a live owner released normally and exited after a startup read its PID; another startup
        then took the absent lock, and the first startup, finding the old PID dead, deleted the successor's lock. At
        every step of the first startup's recovery the owner releases and exits and a successor acquires through the
        same entry point; the successor must keep its lock and the first startup must refuse."""
        scripts = str(Path(backup.__file__).resolve().parent)
        holder = '''import pathlib, sys
sys.path.insert(0, sys.argv[1])
import ops_backup, g3_dispatch
ops_backup.ROOT = pathlib.Path(sys.argv[2])
with (ops_backup.lock() if sys.argv[3] == 'backup' else g3_dispatch.locked(ops_backup.ROOT / 'round.json')):
    print('held', flush=True)
    sys.stdin.readline()
'''
        code = (backup.recover_process_lock.__code__, backup._recover_dead_owner.__code__)
        for kind in ('backup', 'g3'):
            steps = 0
            while True:
                with tempfile.TemporaryDirectory() as folder, patch.object(backup, 'ROOT', Path(folder)):
                    root = Path(folder)
                    lock = root / ('.kin-ops.lock' if kind == 'backup' else 'round.json.lock')
                    acquire = backup.lock if kind == 'backup' else (lambda: g3_dispatch.locked(root / 'round.json'))
                    owner = subprocess.Popen([sys.executable, '-c', holder, scripts, folder, kind],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                    successor, seen, outcome = [], [0], {}
                    try:
                        self.assertEqual(owner.stdout.readline().strip(), 'held')
                        def trace(frame, event, arg):
                            if frame.f_code in code and event == 'line':
                                seen[0] += 1
                                if seen[0] == steps + 1 and not outcome:
                                    owner.communicate('\n', timeout=30)
                                    self.assertEqual(owner.returncode, 0)
                                    manager = acquire()
                                    manager.__enter__()
                                    successor.append(manager)
                                    outcome['token'] = lock.read_text()
                            return trace
                        sys.settrace(trace)
                        try:
                            with acquire():
                                outcome['first_acquired'] = True
                        except FileExistsError:
                            outcome['first_acquired'] = False
                        finally:
                            sys.settrace(None)
                        if 'token' in outcome:
                            with self.subTest(kind=kind, step=steps):
                                self.assertFalse(outcome['first_acquired'])
                                self.assertEqual(lock.read_text(), outcome['token'])
                    finally:
                        sys.settrace(None)
                        if owner.poll() is None:
                            owner.communicate('\n', timeout=30)
                        for manager in successor:
                            manager.__exit__(None, None, None)
                    self.assertEqual(list(root.iterdir()), [])
                if 'token' not in outcome:
                    break
                steps += 1
            self.assertGreater(steps, 3)

    def test_exited_process_lock_recovers_but_live_and_retained_locks_stay(self):
        child = subprocess.Popen([sys.executable, '-c', 'pass'])
        child.wait(timeout=30)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lock = root / '.kin-ops.lock'
            with patch.object(backup, 'ROOT', root):
                lock.write_text(str(child.pid) + ':abandoned')
                with backup.lock():
                    self.assertTrue(lock.exists())
                    with self.assertRaises(FileExistsError):
                        with backup.lock():
                            pass
                self.assertFalse(lock.exists())
                with backup.lock() as lease:
                    lease.retain()
                with self.assertRaises(FileExistsError):
                    with backup.lock():
                        pass
            record = root / 'round.json'
            record.with_name('round.json.lock').write_text(str(child.pid) + ':g3')
            with g3_dispatch.locked(record):
                with self.assertRaises(FileExistsError):
                    with g3_dispatch.locked(record):
                        pass
            self.assertFalse(record.with_name('round.json.lock').exists())

    def test_live_host_lease_refuses_even_a_distinct_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            script = '''import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import live_test_gate as gate
gate.STATE = Path(sys.argv[2])
with gate.live_run('child', 'synthetic', 'a'*64, 1, environment='site-a'):
 print('ready', flush=True)
 sys.stdin.readline()
'''
            with subprocess.Popen([sys.executable, '-c', script, str(Path(__file__).parent), folder],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
                try:
                    self.assertEqual(child.stdout.readline().strip(), 'ready')
                    with patch.object(gate, 'STATE', state):
                        with self.assertRaises(gate.LeaseBusy):
                            gate.preflight_live('site-a')
                        with self.assertRaises(gate.LeaseBusy):
                            with gate.live_run('parent', 'synthetic', 'b'*64, 1, environment='site-b'):
                                self.fail('second live stack admitted')
                finally:
                    child.communicate('\n', timeout=30)
            self.assertEqual(child.returncode, 0)
            with patch.object(gate, 'STATE', state):
                self.assertEqual(gate.pending_markers(), [])
                with gate.live_run('parent', 'synthetic', 'b'*64, 1, environment='site-b'):
                    gate.require_live_run()


if __name__ == '__main__':
    unittest.main()
