#!/usr/bin/env python3
"""Run one command and retain local evidence; never publish or reuse a run directory."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def file_snapshot(paths, cwd):
    result = []
    for requested in paths:
        path = Path(requested)
        if not path.is_absolute():
            path = cwd / path
        item = {"requested": requested, "path": str(path.resolve())}
        try:
            digest, lf_digest = hashlib.sha256(), hashlib.sha256()
            pending = b""
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
                    # Retain a trailing CR so a split CRLF is normalized once.
                    data = pending + block
                    pending = b"\r" if data.endswith(b"\r") else b""
                    if pending:
                        data = data[:-1]
                    lf_digest.update(data.replace(b"\r\n", b"\n"))
            lf_digest.update(pending)
            # Byte-level CRLF -> LF only, including binary inputs. This is not
            # a Git blob id and does not apply attributes or clean filters.
            item.update(status="present", sha256=digest.hexdigest(), lf_sha256=lf_digest.hexdigest())
        except FileNotFoundError:
            item.update(status="missing", sha256=None, lf_sha256=None)
        except OSError as error:
            item.update(status="unreadable", sha256=None, lf_sha256=None, error=str(error))
        result.append(item)
    return result


def git_head(cwd):
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"], cwd=str(cwd),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, shell=False, timeout=10,
        )
        return result.stdout.decode("ascii").strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, UnicodeDecodeError):
        return None


def write_record(path, record):
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(record, stream, ensure_ascii=True, indent=2)
        stream.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Arguments and output are recorded verbatim. Do not supply secrets or "
        "patient data; review evidence before manually publishing it."
    ))
    parser.add_argument("--run-dir", required=True, help="New, unique output directory")
    parser.add_argument("--cwd", default=".", help="Command working directory")
    parser.add_argument("--file", action="append", default=[], help=(
        "File to hash before and after the command; repeat as needed; relative to --cwd"
    ))
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- executable argument ...")
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command after -- is required")
    run_dir = Path(args.run_dir).resolve()
    cwd = Path(args.cwd).resolve()
    try:
        # Exclusive mkdir claims this run before any command or evidence is written.
        run_dir.mkdir(parents=True, exist_ok=False)
    except OSError as error:
        print("Cannot create new run directory: {}".format(error), file=sys.stderr)
        return 125

    record = {
        "schema_version": 1, "command": command, "cwd": str(cwd),
        "status": "preparing", "started_at_utc": None, "ended_at_utc": None,
        "exit_code": None, "recorder_exit_code": None, "launch_error": None,
        "git_head_before": git_head(cwd), "git_head_after": None,
        "files_before": file_snapshot(args.file, cwd), "files_after": None,
        "stdout": "stdout.log", "stderr": "stderr.log", "log_files": None,
    }
    metadata = run_dir / "run.json"
    try:
        write_record(metadata, record)
        with (run_dir / "stdout.log").open("xb") as stdout, (run_dir / "stderr.log").open("xb") as stderr:
            record.update(status="running", started_at_utc=utc_now())
            write_record(metadata, record)
            started = time.monotonic()
            try:
                completed = subprocess.run(
                    command, cwd=str(cwd), stdin=subprocess.DEVNULL,
                    stdout=stdout, stderr=stderr, shell=False,
                )
                record.update(status="completed", exit_code=completed.returncode)
                wrapper_exit = completed.returncode
            except OSError as error:
                record.update(status="launch_failed", launch_error={
                    "type": type(error).__name__, "message": str(error),
                    "errno": error.errno,
                })
                wrapper_exit = 127
            record.update(ended_at_utc=utc_now(), duration_seconds=time.monotonic() - started)
        record.update(
            git_head_after=git_head(cwd), files_after=file_snapshot(args.file, cwd),
            log_files=file_snapshot(["stdout.log", "stderr.log"], run_dir),
        )
        # A successful child is not proof of complete evidence if a requested hash failed.
        if wrapper_exit == 0 and (
            any(item["status"] == "unreadable" for item in record["files_before"] + record["files_after"])
            or any(item["status"] != "present" for item in record["log_files"])
        ):
            wrapper_exit = 125
        # Preserve signal-based child exit in JSON; use its conventional shell exit here.
        if wrapper_exit < 0:
            wrapper_exit = 128 - wrapper_exit
        record["recorder_exit_code"] = wrapper_exit
        write_record(metadata, record)
        return wrapper_exit
    except OSError as error:
        print("Evidence recording failed: {}".format(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
