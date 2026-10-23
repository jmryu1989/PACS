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
import time


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


class LeaseBusy(Refused):
    pass


def require_live_run():
    if _permitted_pid != os.getpid():
        raise Refused("LiveStack requires scripts/run-tests.py and an explicit live test plan")


MARKER = "live-needs-inspection.json"
PENDING = "needs-inspection"


def environment_name():
    """The live environment a run uses (D1804): its Compose project, or an explicit
    KIN_LIVE_ENVIRONMENT. A failed run blocks only this environment until inspected."""
    name = os.environ.get("KIN_LIVE_ENVIRONMENT") or os.environ.get("COMPOSE_PROJECT_NAME") or "default"
    return name.strip() or "default"


def marker_environment(contents):
    # Markers written before D1804 carry no environment: they belong to the default one.
    if isinstance(contents, dict):
        value = contents.get("environment", "default")
        return value if isinstance(value, str) and value.strip() else None
    return None


def pending_markers():
    """Every uninspected run record: the latest marker and the ones set aside."""
    paths = [STATE / MARKER] + sorted((STATE / PENDING).glob("*.json"))
    found = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            contents = json.loads(path.read_bytes())
        except (OSError, ValueError):
            contents = None
        found.append((path, contents))
    return found


def refuse_if_pending(environment):
    for path, contents in pending_markers():
        owner = marker_environment(contents)
        # An unreadable record names no environment, so it cannot be scoped: it blocks.
        if owner is None or owner == environment:
            raise Refused("Previous live run in environment '" + environment
                          + "' needs fixture inspection: " + str(path))


def preflight_live(environment=None):
    """Fail fast while another live run owns the lease, or while an uninspected
    failed run used this same environment. Other environments are not blocked."""
    with exclusive(STATE / "live.lock"):
        refuse_if_pending(environment or environment_name())


def set_aside(marker):
    """Keep an earlier run's marker as its inspection record; never delete it."""
    try:
        identity = json.loads(marker.read_bytes())
        name = "{}-{}-{}".format(identity["unit"], identity["attempt"], identity["pid"])
    except (OSError, ValueError, TypeError, KeyError):
        name = "unreadable"
    folder = STATE / PENDING
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (re.sub(r"[^A-Za-z0-9._-]", "_", name) + "-" + str(marker.stat().st_mtime_ns) + ".json")
    os.replace(str(marker), str(target))
    return target


def release_after_inspection(record):
    """Close the failed run's record once its executor has retained an inspection.

    The record is found by the run's identity, whether it is still the latest
    marker or was set aside by a run in another environment."""
    identity_keys = ("unit", "module", "attempt", "plan_sha256", "pid", "started_at")
    with exclusive(STATE / "live.lock"):
        pending = pending_markers()
        if not pending:
            raise Refused("No live inspection marker to release")
        try:
            path = Path(record).resolve()
            raw = path.read_bytes()
            inspection = json.loads(raw)
        except (OSError, ValueError, TypeError) as error:
            raise Refused("Inspection requires a readable JSON record and marker") from error
        validate_identity(inspection)
        # environment is optional in a record (existing callers copy the six identity fields);
        # when given it must name the marker's environment.
        keys = identity_keys + (("environment",) if "environment" in inspection else ())
        matches = [(marker_path, contents) for marker_path, contents in pending
                   if isinstance(contents, dict) and all(
                       (marker_environment(contents) if key == "environment" else contents.get(key)) == inspection.get(key)
                       for key in keys)]
        if len(matches) != 1:
            # No marker, or an unreadable/legacy one, is never matched by guessing.
            raise Refused("Inspection does not identify the failed live run")
        marker, marker_contents = matches[0]
        validate_identity(marker_contents)
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
            raise LeaseBusy("Another run owns the test lease: " + str(path)) from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def release_after_success(identity, wait_seconds=10):
    """A supervising parent reopens the gate for its own confirmed-successful execution only.

    The lease is briefly held by other runs' preflight checks, so a busy lease is
    retried for a bounded time; any other refusal leaves the marker in place.
    """
    validate_identity(identity)
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            with exclusive(STATE / "live.lock"):
                # A run in another environment may have set this marker aside meanwhile
                # (D1804): finish this execution's own record wherever it now is.
                pending = pending_markers()
                if not pending:
                    raise Refused("No readable live marker for this execution")
                own = [path for path, contents in pending if contents == identity]
                if len(own) != 1:
                    # Never clear a marker this execution did not write.
                    raise Refused("Live marker does not identify this execution")
                own[0].unlink()
                return
        except LeaseBusy:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.1)


@contextmanager
def live_run(unit, module, plan_sha256, attempt, release=True, environment=None):
    """Grant live permission under the lease with a persisted marker.

    release=False keeps the marker after a successful body: a supervised worker
    cannot see its parent's deadline or interruption, so only the parent decides
    whether the execution succeeded (release_after_success).
    A pending marker blocks only runs in its own environment (D1804).
    """
    global _permitted_pid
    if _permitted_pid is not None:
        raise Refused("Nested live runs are forbidden")
    environment = environment or environment_name()
    with exclusive(STATE / "live.lock"):
        refuse_if_pending(environment)
        quarantine = STATE / MARKER
        if quarantine.exists():
            # Another environment's uninspected run: keep its record for its owner
            # (needs-inspection/); it does not block this environment.
            set_aside(quarantine)
        # Persist before permitting any stack access. A crash never silently
        # reopens this environment; the executor must inspect its owned fixtures first.
        identity = dict(unit=unit, module=module, plan_sha256=plan_sha256, attempt=attempt,
                        pid=os.getpid(), started_at=datetime.now(timezone.utc).isoformat(),
                        environment=environment)
        validate_identity(identity)
        # Atomic: a termination mid-write must not leave a marker without its
        # identity, which no inspection could match and release.
        temporary = STATE / "live-needs-inspection.new"
        temporary.write_text(json.dumps(identity) + "\n", encoding="utf-8")
        os.replace(str(temporary), str(quarantine))
        _permitted_pid = os.getpid()
        try:
            yield dict(identity)
        except BaseException:
            raise
        else:
            if release:
                quarantine.unlink()
        finally:
            _permitted_pid = None
