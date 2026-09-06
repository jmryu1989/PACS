#!/usr/bin/python3 -I
"""Install at /opt/kin-deploy/entry.py; request bytes on stdin, or fixed notify mode."""
import json
import os
from pathlib import Path
import select
import stat
import sys
import time


def main():
    try:
        if os.name != "posix" or os.geteuid() != 0 or not sys.flags.isolated:
            raise RuntimeError()
        library = Path("/opt/kin-deploy/lib")
        modules = ("ops_deploy_host", "ops_deploy_runner", "ops_deploy_preflight", "ops_backup",
                   "ops_email_monitor", "ops_monitor", "ops_notify")
        for name in modules:
            if not (library / (name + ".py")).is_file():
                raise RuntimeError()
        # Python can reuse bytecode or package directories. Protect the whole
        # installed library, including those paths, before importing any of it.
        children = list(library.rglob("*"))
        if len(children) > 100:
            raise RuntimeError()
        for path in (*reversed(library.parents), library, *children):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError()
            if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
                raise RuntimeError()
        os.environ.clear()
        os.environ.update({"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8",
                           "DOCKER_HOST": "unix:///var/run/docker.sock"})
        os.umask(0o077)
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(library))
        from ops_deploy_host import HostAdapter
        adapter = HostAdapter("/etc/kin-deploy/policy.json")
        if sys.argv[1:] == ["notify"]:
            result = adapter.drain()
        elif len(sys.argv) == 1:
            raw = bytearray()
            deadline = time.monotonic() + 10
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([sys.stdin.fileno()], [], [], remaining)[0]:
                    raise RuntimeError()
                chunk = os.read(sys.stdin.fileno(), 8193 - len(raw))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > 8192:
                    raise RuntimeError()
            result = adapter.execute(bytes(raw))
        else:
            raise RuntimeError()
        print(json.dumps(result))
        return 0 if result.get("status") == "DEPLOYED" or "notifications_accepted" in result else 1
    except Exception:
        print('{"status":"REJECTED","stage":"entry"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
