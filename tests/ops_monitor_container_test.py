"""TEST-C5-01: observe a real restarting container without touching the live stack."""
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_backup
import ops_monitor


class ContainerMonitorTest(unittest.TestCase):
    def test_restart_loop_from_real_docker_metadata(self):
        token = uuid.uuid4().hex
        name = 'kin-rehearsal-' + token[:16] + '-restart'
        try:
            ops_backup.run(['docker', 'run', '-d', '--name', name, '--label', 'kin.ops.run=' + token,
                            '--network', 'none', '--read-only', '--restart', 'on-failure:3',
                            '--entrypoint', 'sh', 'postgres:16-alpine', '-c', 'exit 1'], timeout=30)
            before = [{'name': '/' + item, 'id': item, 'running': True, 'restarting': False,
                       'restarts': 0, 'health': 'none'} for item in ops_monitor.NAMES]
            deadline = time.monotonic() + 20
            while True:
                raw = json.loads(ops_backup.text(['docker', 'inspect', name]))[0]
                if raw['RestartCount'] >= 3:
                    break
                if time.monotonic() > deadline:
                    self.fail('Temporary container did not restart three times')
                time.sleep(0.2)
            before[0]['id'] = raw['Id']
            _, history = ops_monitor.host_status(before, {}, int(time.time()), 0)
            observed = ops_monitor.inspect_containers((name,))[0]
            self.assertEqual(observed['health'], 'none')
            self.assertEqual(observed['restarts'], raw['RestartCount'])
            before[0].update(restarts=observed['restarts'], running=observed['running'],
                             restarting=observed['restarting'])
            faults, _ = ops_monitor.host_status(before, {'containers': history}, int(time.time()), 0)
            self.assertIn('restart_loop', faults)
            self.assertEqual(raw['HostConfig']['NetworkMode'], 'none')
            self.assertFalse(raw['HostConfig'].get('Binds'))
        finally:
            ops_backup.remove_owned_if_present('container', name, token)
        result = subprocess.run(['docker', 'inspect', name], capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
