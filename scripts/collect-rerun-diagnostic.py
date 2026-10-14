#!/usr/bin/env python3
"""Retain one artifact by ID for diagnosis; this is never candidate evidence."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


class DiagnosticError(Exception):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(detail)


def positive_id(value):
    if not re.fullmatch(r'[0-9]+', value) or int(value) < 1:
        raise argparse.ArgumentTypeError('a positive integer ID is required')
    return int(value)


def repository_name(value):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', value):
        raise argparse.ArgumentTypeError('repository must be owner/repo')
    if any(part in ('.', '..') for part in value.split('/')):
        raise argparse.ArgumentTypeError('repository must be owner/repo')
    return value


def checked_json(raw, code):
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('expected a JSON object')
        return value
    except (ValueError, UnicodeError) as error:
        raise DiagnosticError(code, str(error)) from error


def command(argv, logs, label, code, output=None):
    # Keep native bytes even when gh returns a complete payload and a failing
    # exit. Text redirection through Windows PowerShell corrupts ZIP archives.
    try:
        with (logs / (label + '.stderr.log')).open('xb') as stderr:
            if output is None:
                with (logs / (label + '.stdout.log')).open('xb') as stdout:
                    result = subprocess.run(argv, stdin=subprocess.DEVNULL,
                                            stdout=stdout, stderr=stderr, shell=False)
            else:
                result = subprocess.run(argv, stdin=subprocess.DEVNULL,
                                        stdout=output, stderr=stderr, shell=False)
        (logs / (label + '.command.json')).write_text(
            json.dumps({'argv': argv, 'exit': result.returncode}, ensure_ascii=True) + '\n',
            encoding='utf-8', newline='\n')
    except OSError as error:
        raise DiagnosticError(code, str(error)) from error
    if result.returncode != 0:
        raise DiagnosticError(code, 'gh exit=' + str(result.returncode))
    if output is None:
        return (logs / (label + '.stdout.log')).read_bytes()


def collect(args, out, logs):
    raw = command(['gh', 'run', 'view', str(args.run_id), '--repo', args.repository,
                   '--json', 'databaseId,attempt,status,conclusion,headSha,event,workflowName'],
                  logs, 'run-view', 'RERUN_RUN_VIEW_FAILED')
    run = checked_json(raw, 'RERUN_RUN_INVALID')
    if (type(run.get('databaseId')) is not int or run['databaseId'] != args.run_id
            or type(run.get('attempt')) is not int or run['attempt'] <= 0
            or not re.fullmatch(r'[0-9a-fA-F]{40}', str(run.get('headSha', '')))
            or any(not isinstance(run.get(key), str) or not run[key]
                   for key in ('status', 'event', 'workflowName'))
            or 'conclusion' not in run
            or (run['conclusion'] is not None and not isinstance(run['conclusion'], str))):
        raise DiagnosticError('RERUN_RUN_INVALID', 'invalid run identity or fields')
    args.observed_attempt = run['attempt']
    endpoint = f'repos/{args.repository}/actions/artifacts/{args.artifact_id}'
    raw = command(['gh', 'api', '--method', 'GET', endpoint], logs, 'metadata', 'RERUN_METADATA_FAILED')
    metadata = checked_json(raw, 'RERUN_ARTIFACT_INVALID')
    owner = metadata.get('workflow_run')
    if (type(metadata.get('id')) is not int or metadata['id'] != args.artifact_id
            or not isinstance(owner, dict) or type(owner.get('id')) is not int
            or owner['id'] != args.run_id
            or ('url' in metadata and metadata['url'] != 'https://api.github.com/' + endpoint)):
        raise DiagnosticError('RERUN_ARTIFACT_INVALID', 'artifact identity or owner mismatch')
    advertised = metadata.get('digest')
    if not isinstance(advertised, str) or not re.fullmatch(r'sha256:[0-9a-fA-F]{64}', advertised):
        raise DiagnosticError('RERUN_DIGEST_REQUIRED', 'advertised SHA-256 is required')
    archive = out / f'manual-{args.run_id}-{args.artifact_id}.zip'
    try:
        with archive.open('xb') as stream:
            command(['gh', 'api', '--method', 'GET', endpoint + '/zip'],
                    logs, 'download', 'RERUN_DOWNLOAD_FAILED', stream)
    except OSError as error:
        raise DiagnosticError('RERUN_ARCHIVE_WRITE_FAILED', str(error)) from error
    try:
        with archive.open('rb') as stream:
            digest = 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest()
    except OSError as error:
        raise DiagnosticError('RERUN_ARCHIVE_READ_FAILED', str(error)) from error
    if digest.lower() != advertised.lower():
        raise DiagnosticError('RERUN_DIGEST_MISMATCH', 'downloaded archive SHA-256 mismatch')
    receipt = dict(repository=args.repository, run_id=args.run_id, attempt=run['attempt'],
                   artifact_id=args.artifact_id, archive=str(archive), digest=digest,
                   advertised_digest=advertised, run=run, metadata=metadata,
                   use='diagnostic-only', producer_attempt_verified=False, logs=str(logs))
    receipt_path = out / f'manual-{args.run_id}-{args.artifact_id}.json'
    created = False
    try:
        with receipt_path.open('x', encoding='utf-8', newline='\n') as stream:
            created = True
            json.dump(receipt, stream, ensure_ascii=True, indent=2)
            stream.write('\n')
    except OSError as error:
        # Only this invocation's incomplete receipt may be removed. Its archive
        # and command logs remain available for diagnosis and cannot be reused.
        if created:
            receipt_path.unlink()
        raise DiagnosticError('RERUN_RECEIPT_WRITE_FAILED', str(error)) from error
    return receipt


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=repository_name, required=True)
    parser.add_argument('--run-id', type=positive_id, required=True)
    parser.add_argument('--artifact-id', type=positive_id, required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--repo-root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    args.observed_attempt = None
    try:
        out = (args.repo_root.resolve() / args.out).resolve()
        out.mkdir(parents=True, exist_ok=True)
        logs = Path(tempfile.mkdtemp(prefix=f'rerun-{args.run_id}-{args.artifact_id}-', dir=out))
        receipt = collect(args, out, logs)
    except (DiagnosticError, OSError) as error:
        print(json.dumps(dict(code=getattr(error, 'code', 'RERUN_FILE_ERROR'),
                              run_id=args.run_id, attempt=args.observed_attempt,
                              artifact_id=args.artifact_id, detail=str(error)), ensure_ascii=True), file=sys.stderr)
        return 1
    print(json.dumps(receipt, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
