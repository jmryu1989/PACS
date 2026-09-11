"""Process-local permission and an OS lease for synthetic live test runs.

This is an accident barrier, not a sandbox against code that edits the gate.
Neither an environment variable nor importing a live TestCase grants permission.
"""
from contextlib import contextmanager
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
