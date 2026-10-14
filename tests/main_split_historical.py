"""Run unchanged split-era oracles against their fixed landed Git blobs.

D73: byte/registration equivalence is historical evidence, not a constraint on
later UX changes. Current-source behavior is checked by main_split_landing_dom_test
and the served consumer suites. Neither move spec nor its baseline is rewritten.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
LANDED = 'c8e4f1b485ec05ccbb97589c74a573b3f48b70ce'


def main():
    command = sys.argv[1:]
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        raise SystemExit('child command required')
    with tempfile.TemporaryDirectory(prefix='kin-split-history-') as temporary:
        directory = Path(temporary)
        names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', LANDED,
                                         '--', 'worklist-v0/hpacs-lite'], cwd=ROOT, text=True).splitlines()
        for name in names:
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(['git', 'show', f'{LANDED}:{name}'], cwd=ROOT))
        # page_source consumes the same manifest path as the real page.
        target = directory / 'scripts/main-split-order.json'
        target.parent.mkdir()
        target.write_bytes(subprocess.check_output(['git', 'show', f'{LANDED}:scripts/main-split-order.json'], cwd=ROOT))
        assets = directory / 'worklist-v0/hpacs-lite'
        env = {**os.environ, 'KIN_PRE_PAGE': str(assets/'main.html'), 'KIN_PRE_ASSETS': str(assets),
               'KIN_SPLIT_PARENT':'7bccdb614c6582b2a718c493cfb5cff6600629b9'}
        print(json.dumps({'historical_sha': LANDED, 'command':command}), flush=True)
        return subprocess.run(command, cwd=ROOT, env=env).returncode


if __name__ == '__main__':
    sys.exit(main())
