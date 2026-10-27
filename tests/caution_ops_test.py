"""Synthetic behavior regressions for removed ops size and process-lock gates."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_backup as backup
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
