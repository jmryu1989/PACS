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
import re


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
        validate_identity(marker_contents)
        validate_identity(inspection)
        if (not isinstance(inspection, dict)
                or any(not isinstance(inspection.get(key), str) or not inspection[key].strip()
                       for key in ("unit", "module", "inspected_at", "inspector"))
                or type(inspection.get("exit")) is not int
                or not isinstance(inspection.get("artifacts"), list) or not inspection["artifacts"]
                or any(not isinstance(item, str) or not item.strip() for item in inspection["artifacts"])
                or not isinstance(inspection.get("stack"), dict) or not inspection["stack"]):
            raise Refused("Incomplete or malformed fixture inspection record")
        if any(inspection[key] != marker_contents[key] for key in
               ("unit", "module", "attempt", "plan_sha256", "pid", "started_at")):
            raise Refused("Inspection does not identify the failed live run")
        started = inspection_time(marker_contents["started_at"])
        inspected = inspection_time(inspection["inspected_at"])
        if not started < inspected <= datetime.now(timezone.utc):
            raise Refused("Inspection time must follow the run and not be in the future")
        if path.stat().st_mtime_ns <= marker.stat().st_mtime_ns:
            raise Refused("Inspection record must be newer than the marker")
        digest = hashlib.sha256(raw).hexdigest()
        ledger = STATE / "inspections.jsonl"
        if ledger.exists():
            # Read the entire audit trail under the lease; renaming a used record
            # does not make its attestation fresh. Unreadable trails fail closed.
            try:
                for line in ledger.read_text(encoding="utf-8").splitlines():
                    previous = json.loads(line)
                    if not isinstance(previous, dict) or not isinstance(previous.get("record_sha256"), str):
                        raise ValueError("Malformed inspection ledger")
                    if previous["record_sha256"] == digest:
                        raise Refused("Inspection record has already been used")
            except ValueError as error:
                raise Refused("Unreadable inspection ledger") from error
        entry = {"marker": marker_contents, "record_path": str(path),
                 "record_sha256": digest,
                 "released_at": datetime.now(timezone.utc).isoformat()}
        # Persist the attestation before releasing the marker; a write failure
        # must leave the gate closed. Never truncate the account's audit trail.
        with (STATE / "inspections.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        marker.unlink()


def inspection_time(value):
    try:
        stamp = datetime.fromisoformat(value)
        if stamp.tzinfo is None or stamp.utcoffset() is None:
            raise ValueError("Timezone required")
        return stamp
    except (TypeError, ValueError) as error:
        raise Refused("Inspection requires a timezone-aware ISO-8601 time") from error


def validate_identity(value):
    if (not isinstance(value, dict)
            or any(not isinstance(value.get(key), str) or not value[key].strip()
                   for key in ("unit", "module", "plan_sha256", "started_at"))
            or any(type(value.get(key)) is not int or value[key] < 1 for key in ("attempt", "pid"))
            or not re.fullmatch(r"[0-9a-f]{64}", value["plan_sha256"])):
        raise Refused("Incomplete or malformed live run identity")
    inspection_time(value["started_at"])


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
def live_run(unit, module, plan_sha256, attempt):
    global _permitted_pid
    if _permitted_pid is not None:
        raise Refused("Nested live runs are forbidden")
    with exclusive(STATE / "live.lock"):
        quarantine = STATE / "live-needs-inspection.json"
        if quarantine.exists():
            raise Refused("Previous live run needs fixture inspection: " + str(quarantine))
        # Persist before permitting any stack access. A crash never silently
        # reopens the gate; the executor must inspect its owned fixtures first.
        identity = dict(unit=unit, module=module, plan_sha256=plan_sha256, attempt=attempt,
                        pid=os.getpid(), started_at=datetime.now(timezone.utc).isoformat())
        validate_identity(identity)
        quarantine.write_text(json.dumps(identity) + "\n", encoding="utf-8")
        _permitted_pid = os.getpid()
        try:
            yield
        except BaseException:
            raise
        else:
            quarantine.unlink()
        finally:
            _permitted_pid = None
