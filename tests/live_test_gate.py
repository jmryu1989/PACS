"""Process-local permission and an OS lease for synthetic live test runs.

This is an accident barrier, not a sandbox against code that edits the gate.
Neither an environment variable nor importing a live TestCase grants permission.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import os


def state_directory():
    # Resolve the OS account's persistent directory, not TEMP/TMP/HOME supplied
    # by a shell or virtual environment. Every checkout uses the same lease.
    if os.name == "nt":
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        result = ctypes.windll.shell32.SHGetFolderPathW(None, 28, None, 0, buffer)
        if result != 0 or not buffer.value:
            raise RuntimeError("Cannot resolve the OS account's Local AppData")
        return Path(buffer.value) / "KIN" / "PACS" / "test-gate"
    import pwd
    return Path(pwd.getpwuid(os.getuid()).pw_dir) / ".local" / "state" / "kin-pacs" / "test-gate"


STATE = state_directory()
_permitted_pid = None


class Refused(RuntimeError):
    pass


def require_live_run():
    if _permitted_pid != os.getpid():
        raise Refused("LiveStack requires scripts/run-tests.py and an explicit live test plan")


def preflight_live():
    with exclusive(STATE / "live.lock"):
        if (STATE / "live-needs-inspection.json").exists():
            raise Refused("Previous live run needs fixture inspection: " + str(STATE))


def release_after_inspection(record):
    """Reopen a failed run only after its executor has retained an inspection."""
    with exclusive(STATE / "live.lock"):
        marker = STATE / "live-needs-inspection.json"
        if not marker.is_file():
            raise Refused("No live inspection marker to release")
        try:
            path = Path(record).resolve()
            raw = path.read_bytes()
            inspection = json.loads(raw)
            marker_contents = json.loads(marker.read_bytes())
        except (OSError, ValueError, TypeError) as error:
            raise Refused("Inspection requires a readable JSON record and marker") from error
        if (not isinstance(inspection, dict)
                or any(not isinstance(inspection.get(key), str) or not inspection[key].strip()
                       for key in ("unit", "module", "inspected_at", "inspector"))
                or type(inspection.get("exit")) is not int
                or not isinstance(inspection.get("artifacts"), list) or not inspection["artifacts"]
                or any(not isinstance(item, str) or not item.strip() for item in inspection["artifacts"])
                or not isinstance(inspection.get("stack"), dict) or not inspection["stack"]):
            raise Refused("Incomplete or malformed fixture inspection record")
        entry = {"marker": marker_contents, "record_path": str(path),
                 "record_sha256": hashlib.sha256(raw).hexdigest(),
                 "released_at": datetime.now(timezone.utc).isoformat()}
        # Persist the attestation before releasing the marker; a write failure
        # must leave the gate closed. Never truncate the account's audit trail.
        with (STATE / "inspections.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        marker.unlink()


@contextmanager
def exclusive(path):
    """Nonblocking, same-user cross-process lease; never delete the lock inode."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        stream.seek(0, 2)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise Refused("Another run owns the test lease: " + str(path)) from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


@contextmanager
def live_run():
    global _permitted_pid
    if _permitted_pid is not None:
        raise Refused("Nested live runs are forbidden")
    with exclusive(STATE / "live.lock"):
        quarantine = STATE / "live-needs-inspection.json"
        if quarantine.exists():
            raise Refused("Previous live run needs fixture inspection: " + str(quarantine))
        # Persist before permitting any stack access. A crash never silently
        # reopens the gate; the executor must inspect its owned fixtures first.
        quarantine.write_text('{"pid": %d}\n' % os.getpid(), encoding="utf-8")
        _permitted_pid = os.getpid()
        try:
            yield
        except BaseException:
            raise
        else:
            quarantine.unlink()
        finally:
            _permitted_pid = None
