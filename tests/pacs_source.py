"""Thin subprocess adapter. TypeScript AST/provenance lives only in pacs_source.cjs.

Behaviour assertions execute the existing compiled suites, with their original vectors.
Successful runs are cached within this Python process; failed runs are never cached.
"""
import functools
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def source_query(operation, *arguments):
    return json.loads(subprocess.check_output(
        ['node', str(ROOT / 'tests/pacs_source.cjs'), operation, *arguments],
        cwd=ROOT, encoding='utf-8'))


@functools.lru_cache(maxsize=None)
def _behaviour(suite, pattern, api_src):
    command = ['node', '--require', str(ROOT / 'tests/pacs_source.cjs'),
               '--test', '--test-reporter=tap']
    if pattern:
        command += ['--test-name-pattern', pattern]
    command.append(str(ROOT / 'tests' / suite))
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                            env={**os.environ, 'KIN_PACS_TEST_PRELOAD': '1'})
    # Emit nested TAP so the recorder retains the actual selected IDs and failures.
    print(result.stdout, end='')
    print(result.stderr, end='')
    if result.returncode:
        raise AssertionError(f'{command!r}: exit {result.returncode}\n{result.stdout}\n{result.stderr}')
    passes = re.findall(r'^# pass (\d+)$', result.stdout, re.M)
    if len(passes) != 1 or int(passes[0]) == 0:
        raise AssertionError('No behaviour case ran: ' + result.stdout)
    if re.search(r'^# (?:fail|cancelled) [1-9]', result.stdout, re.M):
        raise AssertionError(result.stdout)
    return result.stdout


def assert_behaviour(suite, pattern=None):
    return _behaviour(suite, pattern, os.environ.get('KIN_TEST_API_SRC'))
