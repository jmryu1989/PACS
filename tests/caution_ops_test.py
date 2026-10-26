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
    def test_value_comparison_accepts_more_than_old_row_cell_and_byte_limits(self):
        columns = ['c' + str(n) for n in range(11)]
        rows = [[str(n)] * len(columns) for n in range(100001)]
        with patch.object(backup, 'psql_json_stdin', side_effect=[columns, [len(rows), 70 * 1024 * 1024], rows]):
            actual_columns, actual_rows = backup.value_rows('synthetic', 'kin', 'public', 'Synthetic')
        self.assertEqual(actual_columns, columns)
        self.assertEqual(actual_rows[-1], ['100000'] * 11)
        self.assertEqual(len(actual_rows), len(rows))
        with patch.object(backup, 'psql_json_stdin', side_effect=[columns, [len(rows), 70 * 1024 * 1024], rows[:-1]]):
            with self.assertRaises(backup.RestoreAdmissionError):
                backup.value_rows('synthetic', 'kin', 'public', 'Synthetic')

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
                    lease.retained = True
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

    def test_distinct_environments_run_concurrently_and_same_environment_waits(self):
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
                        with gate.live_run('parent', 'synthetic', 'b'*64, 1, environment='site-b'):
                            self.assertTrue(any(row.get('environment') == 'site-a' for _, row in gate.pending_markers()))
                finally:
                    child.communicate('\n', timeout=30)
            self.assertEqual(child.returncode, 0)
            with patch.object(gate, 'STATE', state):
                self.assertEqual(gate.pending_markers(), [])


if __name__ == '__main__':
    unittest.main()
