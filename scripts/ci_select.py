#!/usr/bin/env python3
"""Select module jobs from changed paths; runtime still runs on every PR/main push."""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def matches(path, pattern):
    """Shell wildcards stay in one directory; ** spans directories."""
    parts, globs = path.split('/'), pattern.split('/')

    def walk(i, j):
        if j == len(globs):
            return i == len(parts)
        if globs[j] == '**':
            return walk(i, j + 1) or (i < len(parts) and walk(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], globs[j]) and walk(i + 1, j + 1)

    return walk(0, 0)


def select(paths, *, all_jobs=False, main_push=False):
    config = json.loads((ROOT / 'scripts/ci-paths.json').read_text(encoding='utf-8'))
    paths = [path for path in paths if not path.endswith('.md')]

    def changed(patterns):
        return any(matches(path, pattern) for path in paths for pattern in patterns)

    shared = changed(config['shared_browser'])
    return {job: all_jobs or (not main_push and (
        changed(config['common'] + patterns) or
        (job in config['browser_jobs'] and shared)))
        for job, patterns in config['jobs'].items()}


def event_paths(event, name):
    if name == 'pull_request':
        base = event['pull_request']['base']['sha']
        head = event['pull_request']['head']['sha']
        revision = base + '...' + head
    elif name == 'push' and event.get('before', '').strip('0'):
        revision = event['before'] + '..' + event['after']
    else:
        return []
    # --no-renames includes both the removed and added paths on a rename.
    raw = subprocess.check_output(['git', 'diff', '--name-only', '--no-renames', '-z', revision], cwd=ROOT)
    return [name.decode('utf-8') for name in raw.split(b'\0') if name]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--files-json', type=Path)
    args = parser.parse_args()
    name = os.environ.get('GITHUB_EVENT_NAME', '')
    if args.files_json:
        paths = json.loads(args.files_json.read_text(encoding='utf-8'))
        selected = select(paths)
    else:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text(encoding='utf-8'))
        main_push = name == 'push' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        paths = [] if main_push else event_paths(event, name)
        selected = select(paths, all_jobs=name == 'workflow_dispatch' or
                          os.environ.get('GITHUB_REF', '').startswith('refs/tags/'),
                          main_push=main_push)
    result = json.dumps(selected, separators=(',', ':'))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('jobs=' + result + '\n')
    print(result)


if __name__ == '__main__':
    main()
