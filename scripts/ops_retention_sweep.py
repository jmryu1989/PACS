"""One host-scheduled daily invocation of the opt-in retention Compose profile.

CD-09a wires the PG ledger sweep and native report units. The worker returns
nonzero until every phase is connected (images: CD-09b) and nothing is unread.
This command neither installs a schedule nor enables production retention.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

from ops_backup import DAILY_GENERATIONS

ROOT = Path(__file__).resolve().parents[1]


def backup_rotation_reference():
    # A generation count is not a promise of physical removal after N days.
    # --rotate-keep/--no-rotate and retained exceptions must be checked at deploy.
    return {
        "source": "scripts/ops_backup.py:DAILY_GENERATIONS",
        "defaultDailyGenerations": DAILY_GENERATIONS,
        "actualDeploymentPolicy": "unverified",
        "exceptions": ["release", "held", "protected", "latest-verified", "incomplete", "audit-retained"],
        "physicalCopiesClosed": False,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose-file", action="append", default=[])
    parser.add_argument("--timeout", required=True, type=float,
                        help="Hang timeout in seconds, sized from the deployment's measured sweep")
    args = parser.parse_args(argv)
    if args.timeout <= 0 or not args.timeout < float("inf"):
        parser.error("--timeout must be positive and finite")
    command = ["docker", "compose"]
    for filename in args.compose_file:
        command += ["-f", filename]
    command += ["--profile", "retention", "run", "--rm", "--no-deps", "retention"]
    print(json.dumps({"backupRotationReference": backup_rotation_reference()}), flush=True)
    try:
        return subprocess.run(command, cwd=ROOT, timeout=args.timeout, check=False).returncode
    except subprocess.TimeoutExpired:
        # Do not start another run until the operator checks the run container.
        print("Retention command timed out; inspect its container before retrying.", file=sys.stderr)
        return 1
    except OSError:
        print("Retention command could not start.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
