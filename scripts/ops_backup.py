"""Consistent KIN backup and isolated restore rehearsal; never restores over production.

Usage: python scripts/ops_backup.py backup --output <outside-repository-directory> [--rotate-keep N | --no-rotate]
       python scripts/ops_backup.py rehearse <completed-backup-directory> [--wrapping-source <relocated-custody>]
       python scripts/ops_backup.py restore-wrapping <backup> --destination <new-secret-directory> [--source <relocated-custody>]
       python scripts/ops_backup.py rotate --root <backup-root> [--keep N] [--protect NAME ...] [--dry-run]
The running write services pause during backup and are resumed in finally. New backups need no audit seal.
For older archives that declare audit-checkpoint.json, rehearse still verifies the restored copy against that checkpoint.

The EMR-introduction release mode (scripts/ops_emr_introduction.py) uses capture_held() instead of backup(): it captures a
snapshot while the caller keeps every writer fenced and never resumes them itself (the release decides when they return).
After a complete, error-free backup the older daily sets rotate (D1047: keep 7): rotate() deletes complete daily sets
beyond the newest N, never a release, held, protected, latest-verified or incomplete set, and only thins (Orthanc archive
removed) a set the audit ledger still retains. A deleted set's separate wrapping-custody copy is removed after it; a thinned
or retained set keeps its copy.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from urllib.parse import urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
CONTAINERS = ("kin-api", "kin-keycloak", "kin-orthanc", "kin-db")
FILES = ("kin.dump", "keycloak.dump", "orthanc.tgz", ".env", "docker-compose.yml", "docker-compose.prod.yml")
EMR_FILES = ("cluster-roles.sql", "emr-state.tgz", "emr-catalog.json")
EMR_STATE = "/var/lib/kin-emr"
EMR_TABLESPACE = "/var/lib/postgresql/emr-access/ts"
WRAPPING_CUSTODY_CONFIG = Path("/etc/kin-deploy/emr-wrapping-custody.json")


_resource_prefix = ContextVar("backup_resource_prefix", default="kin-rehearsal-")


@contextmanager
def resource_names(prefix):
    """Keep isolated helpers in their caller's namespace; ownership still requires the unique run label."""
    if not re.fullmatch(r"kin-[a-z0-9-]{1,80}-", prefix):
        raise RuntimeError("Invalid isolated resource namespace")
    token = _resource_prefix.set(prefix)
    try:
        yield
    finally:
        _resource_prefix.reset(token)


def resource_name(token, suffix=""):
    return _resource_prefix.get() + token[:16] + suffix


def backup_components(manifest):
    return (*FILES, *EMR_FILES) if "emr" in manifest else FILES


def emr_catalog(container, user):
    """Owner, ACL, role attributes and placement are restore data, never inferred from row counts."""
    # pg_dump may omit an explicit owner-only ACL (notably identity sequences).
    # Compare its effective default grants with the same explicit grants.
    sql = """SELECT json_build_object(
      'ledger', (SELECT row_to_json(m) FROM emr_access.ledger_metadata m),
      'schema', (SELECT json_build_object('owner', pg_get_userbyid(nspowner), 'acl', nspacl::text)
                 FROM pg_namespace WHERE nspname='emr_access'),
      'roles', (SELECT json_agg(r ORDER BY rolname) FROM
        (SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolinherit
         FROM pg_roles WHERE rolname IN ('kin_emr_owner','kin_runtime','kin_emr_reader','kin_emr_retention')) r),
      'memberships', (SELECT json_agg(r ORDER BY granted, member) FROM
        (SELECT a.rolname AS granted, b.rolname AS member FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.roleid
         JOIN pg_roles b ON b.oid=m.member WHERE a.rolname LIKE 'kin_emr_%' OR b.rolname LIKE 'kin_emr_%'
         OR a.rolname='kin_runtime' OR b.rolname='kin_runtime') r),
      'tablespace', (SELECT json_build_object('name',spcname,'owner',pg_get_userbyid(spcowner),'acl',spcacl::text)
                    FROM pg_tablespace WHERE spcname='kin_emr_access'),
      'tables', (SELECT json_agg(r ORDER BY name) FROM
        (SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
         COALESCE(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))::text AS acl,
         t.spcname AS tablespace
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_tablespace t ON t.oid=c.reltablespace
         WHERE n.nspname='emr_access' AND c.relkind IN ('r','i','S')) r),
      'functions', (SELECT json_agg(r ORDER BY signature) FROM
        (SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         p.prosecdef AS security_definer, p.proconfig AS configuration
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='emr_access') r))"""
    value = json.loads(text(["docker", "exec", container, "psql", "-X", "-U", user, "-d", "kin", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql]))
    if not value.get("schema") or not value.get("tablespace") or not value.get("tables") or len(value.get("roles") or []) != 4:
        raise RuntimeError("EMR deployment catalog is incomplete")
    return value
# The sealed AuditLog checkpoint (scripts/ops_audit_integrity.py) is an extra component a manifest declares in its
# sha256/bytes; it is not in FILES, so backups taken before the seal existed stay valid six-file snapshots.
AUDIT_CHECKPOINT = "audit-checkpoint.json"

# Executed inside an isolated, networkless container against only the restored volume.
# Validate SQLite AND every indexed attachment: a healthy index without image files
# is not a usable PACS backup. Only totals leave the container, never patient tags.
SQLITE_CHECK = r'''
import json, pathlib, re, sqlite3
root = pathlib.Path('/restore')
db = sqlite3.connect('file:/restore/index?mode=ro', uri=True)
assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity failed'
columns = [r[1] for r in db.execute('PRAGMA table_info(AttachedFiles)')]
assert 'uuid' in columns and 'compressedSize' in columns, 'Unknown attachment schema'
count, size = 0, 0
for uid, expected in db.execute('SELECT uuid, compressedSize FROM AttachedFiles'):
    assert re.fullmatch(r'[0-9a-f-]{36}', uid), 'Invalid attachment identifier'
    path = root / uid[:2] / uid[2:4] / uid
    assert path.is_file() and not path.is_symlink(), 'Missing attachment'
    assert path.stat().st_size == expected, 'Attachment size mismatch'
    count += 1
    size += expected
print(json.dumps({'integrity': 'ok', 'attachments': count, 'attachment_bytes': size}))
'''


def run(args, *, output=None, input_file=None, timeout=600, check=True):
    result = subprocess.run(args, cwd=ROOT, stdin=input_file, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        # Commands touching config/credentials must not echo their arguments/output.
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed (exit {result.returncode})")
    return result


def text(args, **kwargs):
    return run(args, **kwargs).stdout.decode("utf-8").strip()


def temporary_run(args, *, timeout=600, output=None, input_file=None):
    # A timed-out docker client can leave its container running. Give even tar
    # helpers an ownership label/name so finally can find and remove exactly it.
    token = uuid.uuid4().hex
    name = resource_name(token, "-helper")
    try:
        result = run(["docker", "run", "--rm", "--name", name,
                      "--label", "kin.ops.run=" + token, *args], timeout=timeout, output=output, input_file=input_file)
        return "" if output is not None else result.stdout.decode("utf-8").strip()
    finally:
        remove_owned_if_present("container", name, token)


def require_local_docker():
    host = os.environ.get("DOCKER_HOST", "")
    if host and not host.startswith(("unix:///", "npipe:////./pipe/")):
        raise RuntimeError("Run on the Docker host itself; remote DOCKER_HOST refused")
    endpoint = text(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
    if not endpoint.startswith(("unix:///", "npipe:////./pipe/")):
        raise RuntimeError("Remote Docker context refused")


@dataclass
class LockLease:
    # A timed-out deployment may still be changing containers after its caller
    # returns. Keep the shared lock until an operator reconciles that operation.
    retained: bool = False
    path: Path | None = None
    token: str | None = None
    identity: tuple | None = None

    def retain(self):
        """Persist the inspection hold before a deployment can start mutating."""
        self.verify()
        token = 'retained:' + self.token.split(':', 1)[-1]
        if token != self.token:
            with self.path.open('w') as handle:
                handle.write(token)
                handle.flush()
                os.fsync(handle.fileno())
            self.token = token
        self.retained = True

    def verify(self):
        if (self.path is None or self.path.is_symlink() or not self.path.is_file()
                or (self.path.stat().st_dev, self.path.stat().st_ino) != self.identity
                or self.path.read_text() != self.token):
            raise RuntimeError("Operations lock ownership changed / 작업 잠금 소유권이 바뀌었습니다")
        info = self.path.stat()
        if os.name == "posix" and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077):
            raise RuntimeError("작업 잠금의 소유자 또는 접근 권한이 바뀌었습니다")


_operations_lease = ContextVar("operations_lease", default=None)


def recover_process_lock(path):
    """Recover an exited process's lock; legacy/retained operation holds need inspection.

    Two startups can both see the same dead owner. Without serialization the slower one deletes the lock the faster one
    has just created for a live run (the 2026-10-27 reaudit's live_owner_lock_lost). Recovery therefore runs only under
    an exclusive guard, so no other recovery can unlink. The guard does not stop the owner read: it may release normally
    and exit after its PID is read, and a startup that skipped recovery may then take the absent lock (#262 review
    R262-1). The lock is therefore read again after the owner is found dead and unlinked only if it still holds that
    owner's token. From then on nothing can replace it: its owner is dead, a normal acquisition cannot replace an
    existing lock and no other recovery runs. A guard already present (another recovery, or one that died mid-way)
    skips recovery and the acquisition then refuses.
    """
    guard = path.with_name(path.name + ".recovery")
    try:
        descriptor = os.open(str(guard), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except (FileExistsError, PermissionError):
        return
    try:
        try:
            os.write(descriptor, str(os.getpid()).encode("ascii"))
        finally:
            os.close(descriptor)
        _recover_dead_owner(path)
    finally:
        guard.unlink()


def _recover_dead_owner(path):
    try:
        owner = path.read_text()
        pid = int(owner.partition(':')[0])
        if pid <= 0:
            return
        if os.name == 'nt':
            import ctypes
            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                code = ctypes.c_ulong()
                try:
                    if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259:
                        return
                finally:
                    ctypes.windll.kernel32.CloseHandle(handle)
            elif ctypes.windll.kernel32.GetLastError() != 87:
                return
        else:
            try:
                os.kill(pid, 0)
                return
            except ProcessLookupError:
                pass
        if path.read_text() != owner:
            return
        path.unlink()
    except (FileNotFoundError, ValueError, PermissionError):
        return


@contextmanager
def lock():
    path = ROOT / ".kin-ops.lock"
    recover_process_lock(path)
    token = str(os.getpid()) + ':' + uuid.uuid4().hex
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(token)
        handle.flush()
        os.fsync(handle.fileno())
    if os.name == "posix":
        # A retained deployment lock must survive a host restart as well as a
        # process exit; syncing only the journal in another directory is not enough.
        directory = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    lease = LockLease(path=path, token=token, identity=(path.stat().st_dev, path.stat().st_ino))
    context = _operations_lease.set(lease)
    try:
        yield lease
    finally:
        try:
            lease.verify()
            if not lease.retained:
                path.unlink()
        finally:
            _operations_lease.reset(context)


def write_json(path, body):
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def counts(container, database, user):
    command = ["docker", "exec", container, "psql", "-X", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-qAt", "-c"]
    tables = text(command + ["SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname IN ('public','emr_access','emr_signing','emr_clinical','emr_audit','emr_image') ORDER BY schemaname,tablename;"]).splitlines()
    if not tables or any(not re.fullmatch(r"(?:public|emr_access|emr_signing|emr_clinical|emr_audit|emr_image)\.[A-Za-z_][A-Za-z_0-9]*", name) for name in tables):
        raise RuntimeError("Unexpected or empty database table list")
    selects = [f'SELECT \'{name}\' AS name, count(*) AS n FROM ' + '.'.join('"'+p+'"' for p in name.split('.')) for name in tables]
    return json.loads(text(command + ["SELECT json_object_agg(name,n) FROM (" + " UNION ALL ".join(selects) + ") counts;"]))


def signing_keys(container, user="kin"):
    return psql_json(container, "kin", "SELECT COALESCE(json_agg(json_build_object('kid',kid,'wrapped',wrapped)), '[]'::json) FROM emr_signing.private_key", user)


def signing_key_count(manifest):
    tables = manifest["counts"].get("kin", {})
    # Held snapshots keep structured catalog keys; daily snapshots use qualified table names.
    if isinstance(tables, list):
        return sum(row["count"] for row in tables
                   if row["key"] == ["kin", "emr_signing", "table", "private_key", None])
    return tables.get("emr_signing.private_key", 0)


def capture_wrapping_custody(directory, manifest, container):
    """Keep wrapping bytes outside the database backup, with an exact per-snapshot locator."""
    has_keys = signing_key_count(manifest) > 0
    config_path = os.environ.get("KIN_EMR_WRAPPING_CUSTODY")
    # The installed release entry clears its environment before invoking held capture.
    if not config_path and WRAPPING_CUSTODY_CONFIG.is_file():
        config_path = WRAPPING_CUSTODY_CONFIG
    if not config_path:
        if has_keys:
            raise RuntimeError("Signing keys require wrapping custody configuration before backup")
        return
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    root = Path(config["backup_root"])
    if not root.is_absolute():
        raise RuntimeError("Wrapping custody backup_root must be absolute")
    root = root.resolve()
    backup_root = directory.parent.resolve()
    if any(root == other or other in root.parents or root in other.parents for other in (ROOT.resolve(), backup_root)):
        raise RuntimeError("Wrapping custody must be separate from the repository and database backup root")
    sources = config["files"]
    if not isinstance(sources, dict) or not sources:
        raise RuntimeError("Wrapping custody files are required")
    required = {row["wrapped"]["wrappingKeyId"] for row in signing_keys(container)} if has_keys else set()
    if not required <= sources.keys():
        raise RuntimeError("Wrapping custody is missing a stored signing key's wrappingKeyId")
    owner = prepare_backup_parent(root)
    target = root / directory.name
    target.mkdir(mode=0o700)
    give_to(target, owner)
    custody = {"directory": str(target), "files": {}}
    for number, (key_id, source) in enumerate(sorted(sources.items())):
        path = Path(source)
        if not isinstance(key_id, str) or not key_id or not path.is_absolute():
            raise RuntimeError("Wrapping custody requires key IDs and absolute source paths")
        try:
            data = path.read_bytes()
        except OSError as error:
            raise RuntimeError("Wrapping source file is unavailable") from error
        if len(data) != 32:
            raise RuntimeError("Wrapping secret must contain the existing 32-byte key")
        filename = f"wrap-{number}.key"
        output = target / filename
        with output.open("xb") as stream:
            output.chmod(0o600)
            stream.write(data)
        give_to(output, owner)
        custody["files"][key_id] = {"file": filename, "sha256": digest(output), "bytes": 32}
    manifest["wrapping_custody"] = custody


def wrapping_custody_files(manifest, source=None):
    """Read and check the complete snapshot before creating a restore destination."""
    custody = manifest.get("wrapping_custody")
    if not custody or not custody.get("files"):
        raise RuntimeError("Wrapping custody locator is missing")
    source = Path(source if source is not None else custody["directory"])
    if not source.is_absolute():
        raise RuntimeError("Wrapping custody locator must be absolute")
    files = {}
    for key_id, entry in custody["files"].items():
        filename = entry["file"]
        if not re.fullmatch(r"wrap-[0-9]+\.key", filename):
            raise RuntimeError("Invalid wrapping custody filename")
        try:
            data = (source / filename).read_bytes()
        except OSError as error:
            raise RuntimeError("Wrapping custody file is unavailable") from error
        if len(data) != 32 or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise RuntimeError("Wrapping custody file differs from the snapshot")
        files[key_id] = (filename, data)
    return source, files


def restore_wrapping_custody(manifest, destination, *, source=None):
    """An operator can relocate the separate custody copy without rewriting the backup manifest."""
    _, files = wrapping_custody_files(manifest, source)
    destination = Path(destination)
    destination.mkdir(mode=0o700)
    restored = {}
    try:
        for key_id, (filename, data) in files.items():
            output = destination / filename
            with output.open("xb") as stream:
                output.chmod(0o600)
                stream.write(data)
            restored[key_id] = str(output.resolve())
    except OSError:
        # Only this call's newly created directory is removed; an existing destination never enters here.
        shutil.rmtree(destination)
        raise
    return restored


def rehearse_wrapping_custody(directory, manifest, container, user="kin", *, source=None):
    # The caller has compared restored counts, so legacy manifests cannot omit a populated signing schema.
    has_keys = signing_key_count(manifest) > 0
    rows = signing_keys(container, user) if has_keys else []
    if not rows and "wrapping_custody" not in manifest:
        return {"keys": 0, "custody": "not configured; no stored signing keys"}
    with tempfile.TemporaryDirectory(prefix="kin-wrapping-restore-") as temporary:
        restored = restore_wrapping_custody(manifest, Path(temporary) / "secrets", source=source)
        if any(row["wrapped"]["wrappingKeyId"] not in restored for row in rows):
            raise RuntimeError("Restored signing key has no wrapping custody file")
        if rows:
            request = Path(temporary) / "request.json"
            write_json(request, {"rows": rows, "files": {key: "/custody/secrets/" + Path(path).name for key, path in restored.items()}})
            # Exercise the existing product unwrap implementation, including its authenticated kid/id binding.
            script = """const fs=require('node:fs');
const {unwrapServerPrivateKey}=require('/app/dist/emr-signature/server-crypto');
const input=JSON.parse(fs.readFileSync('/custody/request.json','utf8'));
for(const row of input.rows){const id=row.wrapped.wrappingKeyId, secret=fs.readFileSync(input.files[id]);
try { unwrapServerPrivateKey(row.wrapped,row.kid,id,secret); } finally { secret.fill(0); }}
process.stdout.write('WRAPPING_RESTORE_VERIFIED');"""
            result = temporary_run(["--network", "none", "--read-only", "--user", "0:0",
                "--mount", f"type=bind,source={temporary},target=/custody,readonly", "--entrypoint", "node",
                manifest["running_images"]["kin-api"]["id"], "-e", script])
            if result != "WRAPPING_RESTORE_VERIFIED":
                raise RuntimeError("Restored signing keys could not be unwrapped")
        return {"keys": len(rows), "custody": "restored and verified", "directory": str(source if source is not None else manifest["wrapping_custody"]["directory"])}


def wait_ready(origin, timeout=120):
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise RuntimeError("Expected an HTTPS PUBLIC_ORIGIN without credentials/path")
    context = ssl._create_unverified_context() if parsed.hostname in ("localhost", "127.0.0.1", "::1") else ssl.create_default_context()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen(origin + "/api/health", context=context, timeout=5) as response:
                health = json.load(response)
            with urlopen(origin + "/auth/realms/kin/.well-known/openid-configuration", context=context, timeout=5) as response:
                oidc = json.load(response)
            with urlopen(origin + "/worklist/hpacs-lite/index.html", context=context, timeout=5) as response:
                worklist = response.status == 200 and b"KinAuth" in response.read()
            if health.get("ok") and health.get("auth") and oidc.get("issuer") == origin + "/auth/realms/kin" and worklist:
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("API, Keycloak and worklist did not become ready after resume")


def prepare_backup_parent(parent):
    """The private backup parent; None, or the (uid, gid) of the operating account whose existing private parent root
    writes into (IRT2-03: the protected entry runs as root, the production backup root is the operating account's 0700
    folder with its audit ledger). What root then creates there is given to that account at the end, so the account's own
    daily backups, rotation and ledger keep working; the parent itself is never chown/chmod-ed."""
    if parent.exists():
        if not parent.is_dir():
            raise RuntimeError("Backup parent is not a directory")
        if os.name == "posix":
            info = parent.stat()
            if stat.S_IMODE(info.st_mode) & 0o077 or not (info.st_uid == os.geteuid() or (os.geteuid() == 0 and info.st_uid != 0)):
                raise RuntimeError("Existing backup parent must be private and owned by the current user (or, for root, by one "
                                   "operating account)")
            if info.st_uid != os.geteuid():
                return info.st_uid, info.st_gid
    else:
        # Never chmod an existing /tmp, home, mount or other shared directory.
        # A racing creator also fails here; only our new leaf receives mode 700.
        parent.mkdir(parents=True, mode=0o700)
    return None


def give_to(path, owner):
    """A folder root made in an operating account's backup parent, with everything in it, becomes that account's (no link
    is followed; modes stay)."""
    if owner is None or os.name != "posix":
        return
    path = Path(path)
    for item in [path, *sorted(path.rglob("*"))]:
        os.chown(item, owner[0], owner[1], follow_symlinks=False)


def reload_proxy():
    # Static nginx upstreams keep the IP resolved at startup. Docker can assign
    # different IPs when all writers resume, so Up containers can still yield 502.
    run(["docker", "exec", "kin-proxy", "nginx", "-t"], timeout=30)
    run(["docker", "exec", "kin-proxy", "nginx", "-s", "reload"], timeout=30)


def resumed_ledger_ready(timeout):
    """Read the resumed API's actual PG role/storage/durability boundary."""
    script = """
const {EmrLedgerClient}=require('/app/dist/emr-runtime/client');
const {verifyRuntimeConnection}=require('/app/dist/emr-runtime/manifest');
(async()=>{
  const db=new EmrLedgerClient(process.env.DATABASE_URL);
  try { await db.$connect(); await verifyRuntimeConnection(db); }
  finally { await db.$disconnect(); }
})().catch(()=>{console.error('Resumed PostgreSQL ledger is not ready');process.exitCode=1;});
"""
    run(['docker', 'exec', 'kin-api', 'node', '-e', script], timeout=timeout)


def backup(output, ready_timeout=120):
    if not 1 <= ready_timeout <= 900:
        raise RuntimeError("Readiness timeout must be between 1 and 900 seconds")
    parent = Path(output).resolve()
    if parent == ROOT or ROOT in parent.parents:
        raise RuntimeError("Backups containing secrets must be outside the Git repository")
    if not (ROOT / ".env").is_file():
        raise RuntimeError("Local .env is required")
    # Inspect may contain secrets; only selected fields go into the manifest.
    info = json.loads(text(["docker", "inspect", *CONTAINERS, "kin-proxy"]))
    by_name = {item["Name"].lstrip("/"): item for item in info}
    if not by_name["kin-db"]["State"]["Running"]:
        raise RuntimeError("PostgreSQL must be running")
    if any(item["State"].get("Restarting") for item in info):
        raise RuntimeError("Resolve restarting containers before taking a consistent backup")
    projects = {item["Config"].get("Labels", {}).get("com.docker.compose.project") for item in info}
    if None in projects or len(projects) != 1:
        raise RuntimeError("Containers do not belong to one Compose project")
    for item in info:
        working_dir = item["Config"].get("Labels", {}).get("com.docker.compose.project.working_dir")
        if not working_dir or Path(working_dir).resolve() != ROOT:
            raise RuntimeError("Container configuration belongs to a different repository")
    mounts = [m for m in by_name["kin-orthanc"]["Mounts"] if m["Destination"] == "/var/lib/orthanc/db"]
    if len(mounts) != 1 or mounts[0]["Type"] != "volume":
        raise RuntimeError("Expected one named Orthanc volume")
    volume = mounts[0]["Name"]
    state_mounts = [m for m in by_name["kin-api"]["Mounts"] if m["Destination"] == EMR_STATE]
    if len(state_mounts) != 1 or state_mounts[0]["Type"] != "volume":
        raise RuntimeError("Expected one named EMR state volume")
    state_volume = state_mounts[0]["Name"]
    initial_running = [name for name in CONTAINERS[:-1] if by_name[name]["State"]["Running"]]
    api_env = dict(entry.split("=", 1) for entry in by_name["kin-api"]["Config"].get("Env", []) if "=" in entry)
    origin = api_env.get("PUBLIC_ORIGIN", "https://localhost:9443").rstrip("/")
    if prepare_backup_parent(parent) is not None:
        # The daily backup is the owning account's own job (its sets, its ledger); root never writes one for it.
        raise RuntimeError("Run the daily backup as the account that owns the backup parent")
    volume_kib = int(temporary_run(["--network", "none", "--read-only",
                                    "--mount", f"type=volume,source={volume},target=/source,readonly",
                                    "--entrypoint", "du", by_name["kin-db"]["Image"], "-sk", "/source"]).split()[0])
    database_bytes = int(text(["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                               "SELECT pg_database_size('kin') + pg_database_size('keycloak');"]))
    state_kib = int(temporary_run(['--network', 'none', '--read-only', '--mount',
        f'type=volume,source={state_volume},target=/source,readonly', '--entrypoint', 'du',
        by_name['kin-db']['Image'], '-sk', '/source']).split()[0])
    required = 2 * ((volume_kib + state_kib) * 1024 + database_bytes) + 512 * 1024 * 1024
    if shutil.disk_usage(parent).free < required:
        raise RuntimeError("Insufficient free space for backup and restore margin")
    directory = parent / (datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    directory.mkdir(mode=0o700)
    manifest = {"format": 1, "complete": False, "created_utc": datetime.now(timezone.utc).isoformat(),
                "emr": {"state_volume": state_volume, "tablespace": "kin_emr_access", "same_pause": True},
                "git_sha": text(["git", "rev-parse", "HEAD"]),
                "git_dirty": bool(text(["git", "status", "--porcelain", "--untracked-files=no"])),
                "postgres_image": by_name["kin-db"]["Image"],
                "orthanc_image": by_name["kin-orthanc"]["Image"],
                "resumed_services": initial_running, "public_origin": origin, "counts": {}, "ready": None,
                "running_images": {name: {"id": item["Image"], "configured": item["Config"].get("Image")}
                                   for name, item in by_name.items()}}
    for image in manifest["running_images"].values():
        metadata = json.loads(text(["docker", "image", "inspect", image["id"]]))[0]
        image["repo_digests"] = metadata.get("RepoDigests") or []
    write_json(directory / "manifest.json", manifest)
    pause_started = time.monotonic()
    stage = "stop writers"
    try:
        if initial_running:
            run(["docker", "stop", "--time", "45", *initial_running], timeout=180)
        for name in initial_running:
            if text(["docker", "inspect", "--format", "{{.State.Running}}", name]) != "false":
                raise RuntimeError("A write service is still running")
        stage = "check EMR writers and preserve catalog"
        active = text(["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                       "SELECT count(*) FROM pg_stat_activity WHERE datname='kin' AND backend_type='client backend' AND pid<>pg_backend_pid();"])
        if active != "0":
            raise RuntimeError("Database clients remain after stopping writers")
        write_json(directory / "emr-catalog.json", emr_catalog("kin-db", "kin"))
        # D23: the cluster's roles, memberships, databases, tablespaces and schemas at the same pause, so that rehearse
        # rebuilds them by the catalog replay (as the held captures do) instead of replaying pg_dumpall's GRANTED BY
        # statements, which PostgreSQL 16 refuses in a cluster whose bootstrap superuser is not kin. Kept in the manifest:
        # the set's component files stay exactly the ones its consumers (validation, rotation, export inventory) know.
        manifest["role_catalog"] = role_catalog("kin-db")
        with (directory / "cluster-roles.sql").open("wb") as handle:
            run(["docker", "exec", "kin-db", "pg_dumpall", "-U", "kin", "--encoding=UTF8", "--roles-only", "--no-role-passwords"], output=handle)
        for database in ("kin", "keycloak"):
            stage = "dump " + database
            manifest["counts"][database] = counts("kin-db", database, "kin")
            with (directory / (database + ".dump")).open("wb") as handle:
                run(["docker", "exec", "kin-db", "pg_dump", "-U", "kin", "-d", database, "--encoding=UTF8", "-Fc", "--create"], output=handle)
        stage = "archive Orthanc"
        # The Docker helper runs as root on Linux. Stream to a host-owned file
        # instead of creating a root-owned archive in a writable host bind mount.
        with (directory / "orthanc.tgz").open("wb") as handle:
            temporary_run(["--network", "none", "--read-only",
                 "--mount", f"type=volume,source={volume},target=/source,readonly",
                 "--entrypoint", "tar", manifest["postgres_image"], "-czf", "-", "-C", "/source", "."],
                timeout=1800, output=handle)
        stage = "archive EMR failure spool at the same pause"
        with (directory / "emr-state.tgz").open("wb") as handle:
            temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/source,readonly",
                           "--entrypoint", "tar", manifest["postgres_image"], "-czf", "-", "-C", "/source", "."], timeout=1800, output=handle)
        stage = "copy configuration and checksum"
        capture_wrapping_custody(directory, manifest, "kin-db")
        for name in FILES[3:]:
            shutil.copyfile(ROOT / name, directory / name)
        components = backup_components(manifest)
        for name in components:
            path = directory / name
            path.chmod(0o600)
            if not path.stat().st_size:
                raise RuntimeError("Empty backup component")
        manifest["sha256"] = {name: digest(directory / name) for name in components}
        manifest["bytes"] = {name: (directory / name).stat().st_size for name in components}
        manifest["complete"] = True
    except BaseException as error:
        manifest["backup_error"] = {"stage": stage, "type": type(error).__name__}
        raise
    finally:
        resume_failures = []
        for name in initial_running:
            try:
                run(["docker", "start", name], timeout=120)
            except Exception:
                resume_failures.append(name)
        manifest["pause_seconds"] = round(time.monotonic() - pause_started, 3)
        manifest["proxy_reloaded"] = None
        if not resume_failures and initial_running and by_name["kin-proxy"]["State"]["Running"]:
            try:
                reload_proxy()
                manifest["proxy_reloaded"] = True
            except Exception:
                manifest["proxy_reloaded"] = False
                manifest["ready"] = False
                manifest["readiness_error"] = "Proxy configuration check or reload failed"
        if (not resume_failures and manifest["proxy_reloaded"] is not False
                and set(initial_running) == set(CONTAINERS[:-1])):
            try:
                wait_ready(origin, ready_timeout)
                manifest["ready"] = True
                manifest["ready_seconds"] = round(time.monotonic() - pause_started, 3)
            except Exception:
                manifest["ready"] = False
                manifest["readiness_error"] = "Application readiness deadline exceeded"
        manifest["resume_failures"] = resume_failures
        if not resume_failures and 'kin-api' in initial_running:
            try:
                resumed_ledger_ready(ready_timeout)
                manifest['emr']['resumed_pg_ready'] = True
            except Exception:
                manifest['emr']['resumed_pg_ready'] = False
                manifest['ready'] = False
                manifest['readiness_error'] = 'PostgreSQL ledger readiness failed after writer resume'
        write_json(directory / "manifest.json", manifest)
        # Even an unsuccessful resume must identify a complete recovery snapshot.
        print(json.dumps({"backup": str(directory), "complete": manifest["complete"],
                          "ready": manifest["ready"], "resume_failures": resume_failures,
                          "pause_seconds": manifest["pause_seconds"],
                          "backup_error": manifest.get("backup_error")}), flush=True)
        if resume_failures:
            raise RuntimeError("Write services need recovery: " + ", ".join(resume_failures))
        if manifest["ready"] is False:
            raise RuntimeError("Backup preserved; application readiness needs recovery before deployment")
    return directory


def validate_backup(directory):
    directory = Path(directory).resolve(strict=True)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") != 1 or not manifest.get("complete"):
        raise RuntimeError("Backup is incomplete")
    if (directory / THINNED_FILE).exists():
        raise RuntimeError("Backup was thinned by rotation (audit retention only); it is not a restorable set")
    # Snapshot validity is independent of the source application's readiness.
    # A failed restart is exactly when an intact snapshot must remain usable.
    # A declared audit checkpoint is a component like the others; an undeclared one is not trusted or required.
    components = backup_components(manifest)
    declared = (*components, AUDIT_CHECKPOINT) if AUDIT_CHECKPOINT in manifest.get("sha256", {}) else components
    for name in declared:
        path = directory / name
        if path.is_symlink() or not path.is_file() or digest(path) != manifest.get("sha256", {}).get(name):
            raise RuntimeError("Backup component checksum mismatch: " + name)
    # Checksums prove consistency with the manifest, not trust in archive paths.
    # Refuse links/devices/traversal before any extraction, even in an isolated volume.
    found_index = False
    with tarfile.open(directory / "orthanc.tgz", "r|gz") as archive:
        for entry in archive:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or ".." in path.parts or not (entry.isfile() or entry.isdir()):
                raise RuntimeError("Unsafe Orthanc archive entry")
            found_index |= str(path) == "index" and entry.isfile()
    if not found_index:
        raise RuntimeError("Orthanc archive has no SQLite index")
    if "emr" in manifest:
        if manifest.get("emr", {}).get("same_pause") is not True:
            raise RuntimeError("EMR database/failure-spool capture was not paused together")
        with tarfile.open(directory / "emr-state.tgz", "r|gz") as archive:
            for entry in archive:
                member = PurePosixPath(entry.name)
                if member.is_absolute() or ".." in member.parts or not (entry.isfile() or entry.isdir()):
                    raise RuntimeError("Unsafe EMR archive entry")
    if "emr" in manifest:
        api_image = manifest.get("running_images", {}).get("kin-api", {}).get("id", "")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", api_image):
            raise RuntimeError("Backup API image ID is invalid")
        run(["docker", "image", "inspect", api_image])
    for key in ("postgres_image", "orthanc_image"):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", manifest.get(key, "")):
            raise RuntimeError("Backup image ID is invalid")
        # Rehearse with the exact local images used for backup. No implicit latest pull.
        run(["docker", "image", "inspect", manifest[key]])
    return directory, manifest


def remove_owned(kind, name, token, timeout=600):
    """timeout bounds the whole removal (each command gets what is left of it), so a caller's cleanup budget holds."""
    end = time.monotonic() + timeout
    if kind not in ("container", "volume") or not name.startswith(_resource_prefix.get()):
        raise RuntimeError("Refusing cleanup outside rehearsal resources")
    label = text(["docker", kind, "inspect", "--format", '{{index .Labels "kin.ops.run"}}' if kind == "volume"
                  else '{{index .Config.Labels "kin.ops.run"}}', name], timeout=max(0.01, end - time.monotonic()))
    if label != token:
        raise RuntimeError("Refusing cleanup of a resource owned by another run")
    command = ["docker", "volume", "rm", name] if kind == "volume" else ["docker", "rm", "-f", "-v", name]
    run(command, timeout=max(0.01, end - time.monotonic()))


def remove_owned_if_present(kind, name, token, timeout=600):
    end = time.monotonic() + timeout
    found = run(["docker", kind, "inspect", name], check=False, timeout=timeout)
    if found.returncode == 0:
        remove_owned(kind, name, token, timeout=max(0.01, end - time.monotonic()))
    elif not any(message in found.stderr.decode("utf-8", errors="replace").lower()
                 for message in ("no such object", "no such container", "no such volume")):
        raise RuntimeError("Could not verify temporary resource cleanup")


def rehearse_audit(directory, manifest, container, user="postgres"):
    """RA-4: the copy this rehearsal restored, not the snapshot file, is compared with the sealed checkpoint. The export
    of the restored kin (pg_dump in the rehearsal container, as that cluster's superuser `user`) is judged in a new
    isolated verifier; nothing the restored server computes is trusted. Success is the verifier's exit 0: a past event
    recorded in the checkpoint is carried, a current guard or shape defect of the restored copy fails. Backups taken
    before sealing existed are not_sealed."""
    import ops_audit_integrity as audit
    if AUDIT_CHECKPOINT not in manifest.get("sha256", {}):
        return "not_sealed"
    code, report = audit.verify(directory / AUDIT_CHECKPOINT, audit.DatabaseExport(container, "kin", user))
    return {"verified": code == 0, **report}


EMR_RECOVERY_SCRIPT = """const {EmrRuntime}=require('/app/dist/emr-runtime/application');
const runtime=new EmrRuntime(process.env.DATABASE_URL,'/var/lib/kin-emr/outage');
(async()=>{try{await runtime.start();console.log('EMR_RESTORE_VERIFIED');}
finally{await runtime.stop(Date.now()+15000);}})().catch(()=>{process.exitCode=1});"""


def restored_emr_expiry(container, user):
    """D1796: run ordinary checked expiry on the isolated restored database.

    No history lifetime is inferred from access age. Unknown lifetimes are
    retained and counted in the receipt without blocking business recovery.
    Source backups remain untouched and retain their existing rotation policy.
    """
    return psql_json(container, 'kin',
        "BEGIN; SET LOCAL ROLE kin_emr_retention; "
        "SELECT emr_access.restore_expiry_sweep(); COMMIT;", user)


def rehearse_held(directory, manifest, *, daily=False, wrapping_source=None):
    """The isolated restore check of a held capture (L-04c for B0, L-10c for B1): restored exactly as a rollback would,
    in a fresh networkless cluster of the product's shape (bootstrap superuser kin), with its roles replayed and owners
    and privileges kept; then the whole catalog, the row counts, the per-table projection and the Orthanc index with
    every attachment. B1 also gets its EMR tablespace, its EMR catalog (owners, ACL, placement) and its state archive,
    whose seal must recover against the restored ledger.
    daily (D23): a daily EMR set that carries its role catalog in the manifest goes the same way in the post-EMR shape -
    its roles and memberships replayed by the catalog (never pg_dumpall's GRANTED BY statements), the restored cluster's
    role catalog compared with the manifest's within the set (R5-02: daily_set_catalog; a source database outside the
    set is named in the result), the AuditLog seal verified as kin (no projection: a daily set has none)."""
    shape = "post" if daily else manifest["shape"]
    token = uuid.uuid4().hex
    name = resource_name(token)
    volume, state_volume = name + "-orthanc", name + "-emr-state"
    started = time.monotonic()
    result = {"backup": directory.name, "git_sha": manifest["git_sha"], "success": False, "shape": shape}
    try:
        run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, volume])
        if shape == "post":
            run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, state_volume])
        run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + token, "--network", "none",
             *(["--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700"] if shape == "post" else []),
             "-e", "POSTGRES_USER=kin", "-e", "POSTGRES_DB=kin", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", manifest["postgres_image"]])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            # TCP readiness excludes the image's socket-only init server (see rehearse()).
            if run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "kin"], check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated PostgreSQL did not become ready")
        if shape == "post":
            run(["docker", "exec", "-u", "postgres", name, "mkdir", "-m", "700", EMR_TABLESPACE])
        source = None
        if daily:
            source, result["databases_outside_set"] = daily_set_catalog(manifest["role_catalog"])
        result["catalog"] = restore_snapshot(name, directory, "kin", shape, source=source)
        if daily:
            for database in PRE_DATABASES:
                if counts(name, database, "kin") != manifest["counts"][database]:
                    raise RuntimeError("Restored database row counts differ: " + database)
        if not daily:
            before = json.loads((directory / "projection.json").read_text(encoding="utf-8"))
            if projection(name, columns={table: value["columns"] for table, value in before.items()}) != before:
                raise RuntimeError("Restored rows differ from the snapshot's projection")
            # IRT2-24: every row of both databases, every schema, as captured.
            restored_values = value_catalog(name)
            if restored_values != json.loads((directory / "values.json").read_text(encoding="utf-8")):
                raise RuntimeError("Restored row values differ from the snapshot")
            if value_counts(restored_values) != manifest["counts"]:
                raise RuntimeError("Restored database row counts differ from the held manifest")
        result["wrapping_custody"] = rehearse_wrapping_custody(directory, manifest, name, source=wrapping_source)
        if shape == "post":
            if emr_catalog(name, "kin") != json.loads((directory / "emr-catalog.json").read_text(encoding="utf-8")):
                raise RuntimeError("Restored EMR owner/ACL/roles/tablespace differ")
            temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/restore",
                           "--mount", f"type=bind,source={directory},target=/backup,readonly", "--entrypoint", "tar",
                           manifest["postgres_image"], "-xzf", "/backup/emr-state.tgz", "-C", "/restore"], timeout=1800)
            checked = temporary_run(["--network", "container:" + name, "--read-only", "-e", "DATABASE_URL=postgresql://kin_runtime@127.0.0.1:5432/kin",
                                     "--mount", f"type=volume,source={state_volume},target={EMR_STATE}", "--entrypoint", "node",
                                     manifest["running_images"]["kin-api"]["id"], "-e", EMR_RECOVERY_SCRIPT])
            if checked != "EMR_RESTORE_VERIFIED":
                raise RuntimeError("Restored PostgreSQL ledger or failure spool is not ready")
            result["emr"] = {"owner_acl_preserved": True, "database_state_verified": True,
                             "expiry_sweep": restored_emr_expiry(name, "kin")}
            if result["emr"]["expiry_sweep"].get("ran") is not True:
                raise RuntimeError("Restored expiry sweep did not run before business use")
        result["audit"] = rehearse_audit(directory, manifest, name, user="kin")
        if result["audit"] != "not_sealed" and not result["audit"]["verified"]:
            raise RuntimeError("Restored AuditLog is not verified against its sealed checkpoint")
        temporary_run(["--network", "none", "--read-only",
                       "--mount", f"type=volume,source={volume},target=/restore",
                       "--mount", f"type=bind,source={directory},target=/backup,readonly",
                       "--entrypoint", "tar", manifest["postgres_image"], "-xzf", "/backup/orthanc.tgz", "-C", "/restore"], timeout=1800)
        orthanc = json.loads(temporary_run(["--network", "none", "--read-only",
                                            "--mount", f"type=volume,source={volume},target=/restore,readonly",
                                            "--entrypoint", "python3", manifest["orthanc_image"], "-c", SQLITE_CHECK], timeout=300))
        result.update(success=True, databases=list(PRE_DATABASES), orthanc=orthanc, projection="not captured" if daily else "equal",
                      roles="catalog replay")
    finally:
        failures = []
        for kind, resource in (("container", name), ("volume", volume), *((("volume", state_volume),) if shape == "post" else ())):
            try:
                remove_owned_if_present(kind, resource, token)
            except Exception:
                failures.append(resource)
        result["cleanup_failures"] = failures
        result["seconds"] = round(time.monotonic() - started, 3)
        write_json(directory / ("rehearsal-" + token[:16] + ".json"), result)
        if failures:
            raise RuntimeError("Rehearsal cleanup failed: " + ", ".join(failures))
    print(json.dumps(result))


def rehearse(directory, *, wrapping_source=None):
    directory, manifest = validate_backup(directory)
    if manifest.get("kind") == HELD_KIND:
        return rehearse_held(directory, manifest, wrapping_source=wrapping_source)
    if "emr" in manifest and manifest.get("role_catalog") is not None:
        # D23: a daily EMR set made since its role catalog is captured: the catalog replay of the held path.
        return rehearse_held(directory, manifest, daily=True, wrapping_source=wrapping_source)
    # An older set (no role catalog): its pg_dumpall roles are replayed into a cluster bootstrapped as postgres, which
    # PostgreSQL 16 refuses for a membership recorded as GRANTED BY kin (a known limit of such sets; see D23).
    token = uuid.uuid4().hex
    name = resource_name(token)
    volume = name + "-orthanc"
    state_volume = name + "-emr-state"
    emr = "emr" in manifest
    started = time.monotonic()
    result = {"backup": directory.name, "git_sha": manifest["git_sha"], "success": False}
    try:
        run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, volume])
        if emr:
            run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, state_volume])
        run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + token,
             "--network", "none", "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", manifest["postgres_image"]])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            # The image's init server accepts Unix sockets before shutdown/restart.
            # TCP readiness excludes that temporary server and prevents restore races.
            if run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated PostgreSQL did not become ready")
        if emr:
            with (directory / "cluster-roles.sql").open("rb") as handle:
                run(["docker", "exec", "-i", name, "psql", "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], input_file=handle)
            run(["docker", "exec", "-u", "postgres", name, "mkdir", "-m", "700", EMR_TABLESPACE])
            run(["docker", "exec", name, "psql", "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
                 "CREATE TABLESPACE kin_emr_access OWNER kin_emr_owner LOCATION '" + EMR_TABLESPACE + "';"])
        for database in ("kin", "keycloak"):
            if not emr:
                run(["docker", "exec", name, "createdb", "-U", "postgres", database])
            with (directory / (database + ".dump")).open("rb") as handle:
                run(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres", "-d", "postgres" if emr else database,
                     *(["--create"] if emr else ["--no-owner", "--no-privileges"]), "--exit-on-error"], input_file=handle)
            expected_counts = manifest["counts"][database]
            if not emr:
                expected_counts = {key if "." in key else "public." + key: value for key, value in expected_counts.items()}
            if counts(name, database, "postgres") != expected_counts:
                raise RuntimeError("Restored database row counts differ: " + database)
        if emr:
            if emr_catalog(name, "postgres") != json.loads((directory / "emr-catalog.json").read_text(encoding="utf-8")):
                raise RuntimeError("Restored EMR owner/ACL/roles/tablespace differ")
            temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/restore",
                 "--mount", f"type=bind,source={directory},target=/backup,readonly", "--entrypoint", "tar",
                 manifest["postgres_image"], "-xzf", "/backup/emr-state.tgz", "-C", "/restore"], timeout=1800)
            api_image = manifest["running_images"]["kin-api"]["id"]
            # The private restore uses its preserved runtime role over the isolated
            # trust-only loopback. Startup performs normal PG recovery and imports
            # the restored failure-only spool before the copy is called verified.
            checked = temporary_run(["--network", "container:"+name, "--read-only", "-e", "DATABASE_URL=postgresql://kin_runtime@127.0.0.1:5432/kin",
                "--mount", f"type=volume,source={state_volume},target={EMR_STATE}", "--entrypoint", "node", api_image, "-e", EMR_RECOVERY_SCRIPT])
            if checked != "EMR_RESTORE_VERIFIED":
                raise RuntimeError("Restored PostgreSQL ledger or failure spool is not ready")
            result["emr"] = {"owner_acl_preserved": True, "database_state_verified": True,
                             "expiry_sweep": restored_emr_expiry(name, "postgres")}
            if result["emr"]["expiry_sweep"].get("ran") is not True:
                raise RuntimeError("Restored expiry sweep did not run before business use")
        result["audit"] = rehearse_audit(directory, manifest, name)
        result["wrapping_custody"] = rehearse_wrapping_custody(directory, manifest, name, "postgres", source=wrapping_source)
        if result["audit"] != "not_sealed" and not result["audit"]["verified"]:
            raise RuntimeError("Restored AuditLog is not verified against its sealed checkpoint")
        temporary_run(["--network", "none", "--read-only",
             "--mount", f"type=volume,source={volume},target=/restore",
             "--mount", f"type=bind,source={directory},target=/backup,readonly",
             "--entrypoint", "tar", manifest["postgres_image"], "-xzf", "/backup/orthanc.tgz", "-C", "/restore"], timeout=1800)
        orthanc = json.loads(temporary_run(["--network", "none", "--read-only",
                                  "--mount", f"type=volume,source={volume},target=/restore,readonly",
                                  "--entrypoint", "python3", manifest["orthanc_image"], "-c", SQLITE_CHECK], timeout=300))
        result.update(success=True, databases=["kin", "keycloak"], orthanc=orthanc)
    finally:
        failures = []
        for kind, resource in (("container", name), ("volume", volume), *(([("volume", state_volume)]) if emr else [])):
            try:
                remove_owned_if_present(kind, resource, token)
            except Exception:
                failures.append(resource)
        result["cleanup_failures"] = failures
        result["seconds"] = round(time.monotonic() - started, 3)
        write_json(directory / ("rehearsal-" + token[:16] + ".json"), result)
        if failures:
            raise RuntimeError("Rehearsal cleanup failed: " + ", ".join(failures))
    print(json.dumps(result))


# ── Held capture: the EMR-introduction release mode's B0 (before the EMR storage) and B1 (after it) ──
# The legacy manifest keys of running_images name roles ("kin-api" is "the API"), so ops.rehearse() and validate_backup()
# accept a held capture unchanged. The actual container names come from the caller's target manifest.
ROLE_KEYS = {"api": "kin-api", "keycloak": "kin-keycloak", "orthanc": "kin-orthanc", "db": "kin-db", "proxy": "kin-proxy"}
WRITER_ROLES = ("api", "keycloak", "orthanc", "proxy")
HELD_KIND = "held-capture"
HELD_LABEL = re.compile(r"[a-z][a-z0-9]{0,15}(?:-[a-z0-9]{1,16}){0,3}")
HELD_NAME = re.compile(r"[a-z][a-z0-9-]{0,63}-\d{8}T\d{6}Z-[a-f0-9]{8}")
HELD_EXTRA = ("cluster-roles.sql", "catalog.json", "migrations.json", "projection.json", "values.json", "metadata.json")
EMR_ROLES = ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")
RESOURCE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
SQL_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,62}")   # quoted into SQL text: plain identifiers only
CONFIG_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
RESTORE_SETTINGS = frozenset((
    "application_name bytea_output DateStyle IntervalStyle TimeZone client_encoding standard_conforming_strings "
    "backslash_quote escape_string_warning extra_float_digits lc_monetary lc_numeric lc_time search_path "
    "statement_timeout lock_timeout idle_in_transaction_session_timeout idle_session_timeout work_mem maintenance_work_mem "
    "default_transaction_deferrable default_transaction_isolation default_transaction_read_only "
    "transaction_deferrable transaction_isolation transaction_read_only row_security"
).split())

def _acl(column, kind, owner):
    """An object's privileges as a sorted list of aclitems, with a NULL ACL read as its default for the owner: pg_dump
    drops an explicit ACL that equals the default, so the raw text would differ after a faithful restore."""
    return (f"(SELECT coalesce(json_agg(x::text ORDER BY x::text), '[]'::json) FROM "
            f"unnest(coalesce({column}, acldefault({kind}, {owner}))) x)")


# Fixed session settings first: a role's VALID UNTIL is a timestamp whose text must not depend on the session.
ROLE_CATALOG_SQL = """SET search_path=pg_catalog; SET client_encoding='UTF8'; SET TimeZone='UTC'; SET DateStyle='ISO, YMD'; SELECT json_build_object(
  'server_major', current_setting('server_version_num')::int/10000,
  'roles', (SELECT coalesce(json_agg(r ORDER BY rolname), '[]'::json) FROM
    (SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolinherit,
            rolconnlimit, rolvaliduntil::text AS rolvaliduntil, rolconfig
     FROM pg_roles WHERE rolname !~ '^pg_') r),
  'unsupported_verifiers', (SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_authid
     WHERE rolpassword IS NOT NULL AND (NOT rolcanlogin OR rolname NOT IN ('kin','kin_runtime','kin_emr_reader','kin_emr_retention'))),
  'login_verifiers', (SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_authid WHERE rolpassword IS NOT NULL),
  'builtin_roles', (SELECT coalesce(jsonb_agg((to_jsonb(r)-'oid'-'rolpassword') ||
      jsonb_build_object('comment',shobj_description(oid,'pg_authid')) ORDER BY rolname),'[]'::jsonb)
     FROM pg_roles r WHERE rolname ~ '^pg_'),
  'memberships', (SELECT coalesce(json_agg(r ORDER BY granted, member, grantor), '[]'::json) FROM
    (SELECT a.rolname AS granted, b.rolname AS member, pg_get_userbyid(m.grantor) AS grantor, m.admin_option, m.inherit_option,
            m.set_option
     FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.roleid
     JOIN pg_roles b ON b.oid=m.member) r),
  'databases', (SELECT coalesce(json_agg(r ORDER BY name), '[]'::json) FROM
    (SELECT datname AS name, pg_get_userbyid(datdba) AS owner, """ + _acl("datacl", "'d'::\"char\"", "datdba") + """ AS acl,
       (to_jsonb(d)-ARRAY['oid','datname','datdba','datacl','datfrozenxid','datminmxid','dattablespace']) ||
       jsonb_build_object('tablespace',(SELECT spcname FROM pg_tablespace WHERE oid=d.dattablespace)) AS attributes,
       shobj_description(d.oid,'pg_database') AS comment FROM pg_database d) r),
  'tablespaces', (SELECT coalesce(json_agg(r ORDER BY name), '[]'::json) FROM
    (SELECT spcname AS name, pg_get_userbyid(spcowner) AS owner, pg_tablespace_location(oid) AS location,
       """ + _acl("spcacl", "'t'::\"char\"", "spcowner") + """ AS acl, spcoptions AS options,
       shobj_description(oid,'pg_tablespace') AS comment FROM pg_tablespace) r),
  'settings', (SELECT coalesce(json_agg(r ORDER BY database, role),'[]'::json) FROM
    (SELECT CASE WHEN s.setdatabase=0 THEN NULL ELSE d.datname END AS database,
      CASE WHEN s.setrole=0 THEN NULL ELSE pg_get_userbyid(s.setrole) END AS role, s.setconfig AS config
     FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase) r),
  'setting_names', (SELECT json_agg(name ORDER BY name) FROM pg_settings WHERE context IN ('user','superuser')
     AND name IN (""" + ",".join("'" + name + "'" for name in sorted(RESTORE_SETTINGS)) + """)),
  'role_comments', (SELECT coalesce(json_agg(json_build_array(rolname,shobj_description(oid,'pg_authid')) ORDER BY rolname),'[]'::json)
    FROM pg_roles WHERE rolname !~ '^pg_'),
  'schemas', (SELECT coalesce(json_agg(nspname::text ORDER BY nspname), '[]'::json) FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'))"""
PRE_DATABASES = ("kin", "keycloak")
DEFAULT_TABLESPACES = ("pg_default", "pg_global")
# What a daily set holds of the cluster's databases: the two it dumps, beside the image's own postgres and templates.
DAILY_SET_DATABASES = (*PRE_DATABASES, "postgres", "template0", "template1")


def daily_set_catalog(catalog):
    """R5-02: (the role catalog a daily set's rehearsal must reproduce, the source databases outside the set).

    A daily set dumps kin and keycloak only, as before D23; a further database of the source cluster is not in the set,
    so no restore of the set can bring it back, and the pre-D23 rehearsal restored such a set. Its catalog row and its
    database-scoped settings are outside what the replay compares: the rehearsal names them instead of refusing a
    complete set. Everything the set holds stays compared exactly (roles, memberships, verifiers, comments, the owners,
    ACLs and attributes of kin, keycloak, postgres and the templates, tablespaces, kin's schemas, cluster/role settings),
    and a restore that yields a database the set does not hold still differs. A malformed catalog is passed on unchanged
    for supported_catalog to refuse. The held captures (B0/B1) restore a whole cluster and keep refusing a further one."""
    if type(catalog) is not dict or type(catalog.get("databases")) is not list or type(catalog.get("settings")) is not list:
        return catalog, []
    outside = sorted(item["name"] for item in catalog["databases"]
                     if type(item) is dict and type(item.get("name")) is str and item["name"] not in DAILY_SET_DATABASES)
    scoped = {**catalog,
              "databases": [item for item in catalog["databases"] if not (type(item) is dict and item.get("name") in outside)],
              "settings": [entry for entry in catalog["settings"] if not (type(entry) is dict and entry.get("database") in outside)]}
    return scoped, outside
MIGRATIONS_SQL = """SELECT coalesce(json_agg(json_build_array(migration_name, checksum, finished_at IS NOT NULL,
  rolled_back_at IS NOT NULL) ORDER BY migration_name COLLATE "C"), '[]'::json) FROM "_prisma_migrations\""""
# Fixed output settings: a projection must not change because a session's display defaults differ.
PROJECTION_SETTINGS = ("SET client_encoding='UTF8'; SET TimeZone='UTC'; SET DateStyle='ISO, YMD'; SET IntervalStyle='postgres'; "
                       "SET extra_float_digits=1; SET bytea_output='hex'; SET lc_monetary='C'; SET lc_numeric='C'; ")

# C-RESTORE v1 is deliberately closed. PostgreSQL 16 catalog names are partitioned below; a different server major
# or an unclassified catalog refuses admission. Physical tuple/WAL/planner state is not logical restore content.
RESTORE_INVENTORY = "kin-pg16-logical-v1"
INVENTORY_COVERAGE = {
    "supported": "pg_attrdef pg_attribute pg_authid pg_auth_members pg_class pg_constraint pg_database pg_db_role_setting "
                 "pg_default_acl pg_depend pg_description pg_enum pg_index pg_namespace pg_policy pg_proc pg_sequence "
                 "pg_shdepend pg_shdescription pg_tablespace pg_trigger pg_type",
    "baseline": "pg_aggregate pg_am pg_amop pg_amproc pg_cast pg_collation pg_conversion pg_extension pg_init_privs "
                "pg_language pg_opclass pg_operator pg_opfamily pg_range pg_rewrite pg_ts_config pg_ts_config_map "
                "pg_ts_dict pg_ts_parser pg_ts_template",
    "refused": "pg_event_trigger pg_foreign_data_wrapper pg_foreign_server pg_foreign_table pg_inherits pg_largeobject "
               "pg_largeobject_metadata pg_parameter_acl pg_partitioned_table pg_publication pg_publication_namespace "
               "pg_publication_rel pg_replication_origin pg_seclabel pg_shseclabel pg_statistic_ext pg_subscription "
               "pg_subscription_rel pg_transform pg_user_mapping",
    "physical": "pg_statistic pg_statistic_ext_data",
}
INVENTORY_KINDS = frozenset(("schema", "relation", "column", "type", "routine", "constraint", "index", "trigger",
                           "policy", "default-acl", "dependency", "comment"))
INVENTORY_ATTRIBUTES = {
    "schema": "owner acl comment",
    "relation": "relname relnatts relchecks relhasindex relisshared relpersistence relkind relhasrules relhastriggers "
                "relhassubclass relrowsecurity relforcerowsecurity relispopulated relreplident relispartition reloptions relpartbound "
                "owner acl access_method tablespace row_type of_type view sequence sequence_state toast",
    "column": "attname attstattarget attlen attndims attbyval attalign attstorage attcompression attnotnull atthasdef attidentity "
              "attgenerated attisdropped attislocal attinhcount attoptions attfdwoptions atttypmod type collation acl expression",
    "type": "typname typlen typbyval typtype typcategory typispreferred typisdefined typdelim typalign typstorage typnotnull "
            "typtypmod typndims typdefault typrelid typelem typarray typbasetype typcollation typinput typoutput typreceive "
            "typsend typmodin typmodout typanalyze typsubscript owner acl default_expression enum_labels",
    "routine": "proname procost prorows prokind prosecdef proleakproof proisstrict proretset provolatile proparallel "
               "pronargs pronargdefaults proargmodes proargnames prosrc probin proconfig owner acl language result support "
               "arguments variadic transforms definition",
    "constraint": "conname contype condeferrable condeferred convalidated confupdtype confdeltype confmatchtype conislocal "
                  "coninhcount connoinherit conrelid conindid confrelid contypid conparentid conkey confkey confdelsetcols "
                  "conpfeqop conppeqop conffeqop conexclop definition",
    "index": "indnatts indnkeyatts indisunique indnullsnotdistinct indisprimary indisexclusion indimmediate indisclustered "
             "indisvalid indisready indislive indisreplident indoption table definition expressions predicate columns collations opclasses",
    "trigger": "tgname tgtype tgenabled tgisinternal tgdeferrable tginitdeferred tgnargs tgargs tgoldtable tgnewtable "
               "table function relation index constraint definition columns",
    "policy": "command permissive roles using check",
    "default-acl": "acl",
    "dependency": "type",
    "comment": "text",
}


def _object_address(catalog, oid, subid="0"):
    # PostgreSQL supplies structured names/arguments; neither dotted concatenation nor allocated OIDs are keys.
    return (f"CASE WHEN ({oid})=0 THEN NULL ELSE (SELECT jsonb_build_array(current_database(), _kin_ident.schema, _kin_ident.type, "
            f"_kin_addr.object_names, _kin_addr.object_args) FROM pg_identify_object('{catalog}'::regclass, {oid}, {subid}) _kin_ident, "
            f"pg_identify_object_as_address('{catalog}'::regclass, {oid}, {subid}) _kin_addr) END")


def _json_without(alias, fields):
    return "to_jsonb(" + alias + ") - ARRAY[" + ",".join("'" + name + "'" for name in fields.split()) + "]::text[]"


def _json_fields(**fields):
    return "jsonb_build_object(" + ",".join("'" + key + "'," + value for key, value in fields.items()) + ")"


def _restore_inventory_sql():
    rows = []
    user_schema = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'"
    def add(kind, schema, name, qualifier, attributes, source, where):
        rows.append("SELECT jsonb_build_object('key',jsonb_build_array(current_database()," + schema + ", '" + kind
                    + "'," + name + "," + qualifier + "),'attributes'," + attributes + ") AS doc FROM " + source + " WHERE " + where)
    add("schema", "n.nspname", "n.nspname", "NULL",
        _json_fields(owner="pg_get_userbyid(n.nspowner)", acl=_acl("n.nspacl", "'n'::\"char\"", "n.nspowner"),
                     comment="obj_description(n.oid,'pg_namespace')"),
        "pg_namespace n", user_schema)
    relation = _json_without("c", "oid relnamespace relowner relam relfilenode relpages reltuples relallvisible reltoastrelid "
                             "reltablespace reltype reloftype relfrozenxid relminmxid relacl relrewrite")
    relation += " || " + _json_fields(
        # pg_class flags are lazy caches (PG16 catalog-pg-class); dropped attnum slots are physical layout. Query the
        # current logical objects instead, so a faithful pg_dump restore need not reproduce stale cache bits.
        relnatts="(SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)",
        relhasindex="EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid)",
        relhasrules="EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid)",
        relhastriggers="EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid)",
        relhassubclass="EXISTS(SELECT 1 FROM pg_inherits h WHERE h.inhparent=c.oid)",
        owner="pg_get_userbyid(c.relowner)", acl=_acl("c.relacl", "(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::\"char\"", "c.relowner"),
        access_method="(SELECT amname FROM pg_am WHERE oid=c.relam)",
        tablespace="(SELECT spcname FROM pg_tablespace WHERE oid=coalesce(nullif(c.reltablespace,0),(SELECT dattablespace FROM pg_database WHERE datname=current_database())))",
        row_type=_object_address("pg_type", "c.reltype"), of_type=_object_address("pg_type", "c.reloftype"),
        view="CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,false) END",
        sequence="(SELECT (to_jsonb(s)-'seqrelid'-'seqtypid') || jsonb_build_object('type',format_type(s.seqtypid,NULL)) FROM pg_sequence s WHERE s.seqrelid=c.oid)",
        sequence_state="CASE WHEN c.relkind='S' THEN (SELECT jsonb_build_array((xpath('/row/last_value/text()',x))[1]::text,(xpath('/row/is_called/text()',x))[1]::text) FROM query_to_xml(format('SELECT last_value,is_called FROM %I.%I',n.nspname,c.relname),false,true,'') x) END",
        # Dropping the last wide column can leave an unused default TOAST relation behind. A fresh logical restore
        # need not allocate that physical relation; compare its effective storage policy, including every override.
        toast="coalesce((SELECT jsonb_build_object('options',t.reloptions,'owner',pg_get_userbyid(t.relowner),'acl',t.relacl::text,'tablespace',s.spcname,"
              "'indexes',(SELECT jsonb_agg(jsonb_build_array(a.amname,i.reloptions,si.spcname) ORDER BY a.amname,i.reloptions::text) "
              "FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid LEFT JOIN pg_am a ON a.oid=i.relam "
              "LEFT JOIN pg_tablespace si ON si.oid=coalesce(nullif(i.reltablespace,0),(SELECT dattablespace FROM pg_database WHERE datname=current_database())) WHERE ix.indrelid=t.oid)) "
              "FROM pg_class t LEFT JOIN pg_tablespace s ON s.oid=coalesce(nullif(t.reltablespace,0),(SELECT dattablespace FROM pg_database WHERE datname=current_database())) WHERE t.oid=c.reltoastrelid), "
              "CASE WHEN c.relkind='r' THEN jsonb_build_object('options',NULL,'owner',pg_get_userbyid(c.relowner),'acl',NULL,"
              "'tablespace',(SELECT spcname FROM pg_tablespace WHERE oid=coalesce(nullif(c.reltablespace,0),(SELECT dattablespace FROM pg_database WHERE datname=current_database()))),"
              "'indexes',jsonb_build_array(jsonb_build_array('btree',NULL,(SELECT spcname FROM pg_tablespace WHERE oid=coalesce(nullif(c.reltablespace,0),(SELECT dattablespace FROM pg_database WHERE datname=current_database())))))) END)")
    add("relation", "n.nspname", "c.relname", "NULL", relation,
        "pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace", user_schema + " AND c.relkind IN ('r','v','S','c','i')")
    # attnum holes and attmissingval describe the old physical tuple layout; the surviving column order and actual
    # values are preserved instead. The logical default/generated expression remains part of this inventory.
    column = _json_without("a", "attrelid atttypid attnum attcacheoff atthasmissing attmissingval attcollation attacl")
    column += " || " + _json_fields(
        # Index attributes can retain the pre-RENAME table column name. pg_dump rebuilds those attributes using the
        # current table definition; compare that definition rather than the stale physical index attribute name.
        attname="CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid,a.attnum,true) ELSE a.attname::text END",
        type=_object_address("pg_type", "a.atttypid"), collation=_object_address("pg_collation", "a.attcollation"),
        acl="(SELECT coalesce(jsonb_agg(x::text ORDER BY x::text),'[]'::jsonb) FROM unnest(a.attacl) x)",
        expression="(SELECT pg_get_expr(d.adbin,d.adrelid,true) FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)")
    add("column", "n.nspname", "c.relname", "(SELECT count(*) FROM pg_attribute z WHERE z.attrelid=a.attrelid AND z.attnum>0 AND NOT z.attisdropped AND z.attnum<=a.attnum)", column,
        "pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace",
        user_schema + " AND a.attnum>0 AND NOT a.attisdropped")
    type_row = _json_without("t", "oid typnamespace typowner typrelid typelem typarray typinput typoutput typreceive typsend "
                            "typmodin typmodout typanalyze typsubscript typbasetype typcollation typdefaultbin typacl")
    type_refs = {key: _object_address(catalog, "t." + key) for catalog, keys in (
        ("pg_class", "typrelid"), ("pg_type", "typelem typarray typbasetype"), ("pg_collation", "typcollation"),
        ("pg_proc", "typinput typoutput typreceive typsend typmodin typmodout typanalyze typsubscript")) for key in keys.split()}
    type_refs.update(owner="pg_get_userbyid(t.typowner)", acl=_acl("t.typacl", "'T'::\"char\"", "t.typowner"),
                     default_expression="pg_get_expr(t.typdefaultbin,0,true)",
                     enum_labels="(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)")
    add("type", "n.nspname", "t.typname", "NULL", type_row + " || " + _json_fields(**type_refs),
        "pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace", user_schema)
    routine = _json_without("p", "oid pronamespace proowner prolang prorettype proargtypes proallargtypes proargdefaults prosupport prosqlbody proacl provariadic protrftypes")
    routine += " || " + _json_fields(owner="pg_get_userbyid(p.proowner)", acl=_acl("p.proacl", "'f'::\"char\"", "p.proowner"),
        language="l.lanname", result=_object_address("pg_type", "p.prorettype"), support=_object_address("pg_proc", "p.prosupport"),
        variadic=_object_address("pg_type", "p.provariadic"),
        transforms="(SELECT jsonb_agg(" + _object_address("pg_type", "x.id") + " ORDER BY x.ord) FROM unnest(p.protrftypes) WITH ORDINALITY x(id,ord))",
        arguments="(SELECT jsonb_agg(format_type(a,NULL) ORDER BY ord) FROM unnest(coalesce(p.proallargtypes,p.proargtypes::oid[])) WITH ORDINALITY x(a,ord))",
        definition="CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) END")
    add("routine", "n.nspname", "p.proname", "pg_get_function_identity_arguments(p.oid)", routine,
        "pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang", user_schema)
    constraint = _json_without("c", "oid connamespace conrelid contypid conindid conparentid confrelid conkey confkey confdelsetcols conpfeqop conppeqop conffeqop conexclop conbin")
    refs = {key: _object_address(catalog, "c." + key) for catalog, keys in (
        ("pg_class", "conrelid conindid confrelid"), ("pg_type", "contypid"), ("pg_constraint", "conparentid")) for key in keys.split()}
    for key, relation_id in (("conkey", "conrelid"), ("confkey", "confrelid"), ("confdelsetcols", "conrelid")):
        refs[key] = "(SELECT jsonb_agg(a.attname ORDER BY x.ord) FROM unnest(c." + key + ") WITH ORDINALITY x(num,ord) LEFT JOIN pg_attribute a ON a.attrelid=c." + relation_id + " AND a.attnum=x.num)"
    for key in ("conpfeqop", "conppeqop", "conffeqop", "conexclop"):
        refs[key] = "(SELECT jsonb_agg(" + _object_address("pg_operator", "x.id") + " ORDER BY x.ord) FROM unnest(c." + key + ") WITH ORDINALITY x(id,ord))"
    # PostgreSQL's pretty deparser removes redundant same-precedence parentheses (nested AND/OR) while preserving
    # grouping with different precedence. Its canonical expression survives dump/reparse without a custom parser.
    refs["definition"] = "pg_get_constraintdef(c.oid,true)"
    add("constraint", "n.nspname", "c.conname", "coalesce(" + _object_address("pg_class", "c.conrelid") + "," + _object_address("pg_type", "c.contypid") + ")",
        constraint + " || " + _json_fields(**refs), "pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace", user_schema)
    index = _json_without("i", "indexrelid indrelid indkey indcollation indclass indexprs indpred indcheckxmin")
    index += " || " + _json_fields(table=_object_address("pg_class", "i.indrelid"), definition="pg_get_indexdef(i.indexrelid)",
        expressions="pg_get_expr(i.indexprs,i.indrelid,true)", predicate="pg_get_expr(i.indpred,i.indrelid,true)",
        columns="(SELECT jsonb_agg(a.attname ORDER BY x.ord) FROM unnest(i.indkey) WITH ORDINALITY x(num,ord) LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=x.num)",
        collations="(SELECT jsonb_agg(" + _object_address("pg_collation", "x.id") + " ORDER BY x.ord) FROM unnest(i.indcollation) WITH ORDINALITY x(id,ord))",
        opclasses="(SELECT jsonb_agg(" + _object_address("pg_opclass", "x.id") + " ORDER BY x.ord) FROM unnest(i.indclass) WITH ORDINALITY x(id,ord))")
    add("index", "n.nspname", "c.relname", "NULL", index,
        "pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace", user_schema)
    # PG16 CreateTrigger appends an allocated OID to internal constraint-trigger names. Their constraint, function,
    # firing flags and relation identities are logical; the OID suffix and redundant generated DDL are not.
    trigger = _json_without("t", "oid tgname tgrelid tgparentid tgfoid tgconstrrelid tgconstrindid tgconstraint tgattr tgqual")
    trigger_name = "CASE WHEN t.tgisinternal THEN regexp_replace(t.tgname::text,'_[0-9]+$','') ELSE t.tgname::text END"
    trigger += " || " + _json_fields(tgname=trigger_name, table=_object_address("pg_class", "t.tgrelid"), function=_object_address("pg_proc", "t.tgfoid"),
        relation=_object_address("pg_class", "t.tgconstrrelid"), index=_object_address("pg_class", "t.tgconstrindid"),
        constraint=_object_address("pg_constraint", "t.tgconstraint"), definition="CASE WHEN NOT t.tgisinternal THEN pg_get_triggerdef(t.oid,false) END",
        columns="(SELECT jsonb_agg(a.attname ORDER BY x.ord) FROM unnest(t.tgattr) WITH ORDINALITY x(num,ord) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num)")
    identity = "CASE WHEN t.tgisinternal THEN jsonb_build_array(" + _object_address("pg_constraint", "t.tgconstraint") + ",t.tgtype," + _object_address("pg_proc", "t.tgfoid") + ") ELSE to_jsonb(t.tgname) END"
    add("trigger", "n.nspname", identity, "c.relname", trigger,
        "pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace", user_schema)
    policy = _json_fields(command="p.polcmd", permissive="p.polpermissive",
        roles="(SELECT jsonb_agg(CASE WHEN id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(id) END ORDER BY CASE WHEN id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(id) END) FROM unnest(p.polroles) id)",
        using="pg_get_expr(p.polqual,p.polrelid,true)", check="pg_get_expr(p.polwithcheck,p.polrelid,true)")
    add("policy", "n.nspname", "p.polname", "c.relname", policy,
        "pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace", user_schema)
    add("default-acl", "n.nspname", "pg_get_userbyid(d.defaclrole)", "d.defaclobjtype",
        _json_fields(acl="(SELECT jsonb_agg(x::text ORDER BY x::text) FROM unnest(d.defaclacl) x)"),
        "pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace", "true")
    # Dependencies also cover column defaults, sequence ownership, enum/array/table-row type relationships and SQL
    # routine bodies. pg_identify_object_as_address resolves allocated OIDs and column numbers to their names.
    address = lambda cls, obj, sub: "(SELECT jsonb_build_array(current_database(),i.schema,i.type,a.object_names,a.object_args) FROM pg_identify_object(" + cls + "," + obj + "," + sub + ") i, pg_identify_object_as_address(" + cls + "," + obj + "," + sub + ") a)"
    source_id = address("d.classid", "d.objid", "d.objsubid")
    target_id = address("d.refclassid", "d.refobjid", "d.refobjsubid")
    # These generated dependency names carry trigger OIDs; every referenced constraint/function/relation is already
    # compared in the normalized internal-trigger record above. Altered internal triggers refuse admission below.
    logical_dependency = " AND NOT (d.classid='pg_trigger'::regclass AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.oid=d.objid AND t.tgisinternal))"
    # PG16 can record the same dependency more than once (for example an index key also used by its predicate).
    # Collapse identical physical edges before resolving identities; distinct targets and dependency types remain.
    add("dependency", "i.schema", "i.name", "jsonb_build_array(" + source_id + "," + target_id + ",d.deptype)", "jsonb_build_object('type',d.deptype)",
        "(SELECT DISTINCT * FROM pg_depend WHERE classid<>0 AND objid<>0 AND deptype<>'p') d CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) i",
        "i.schema !~ '^pg_' AND i.schema <> 'information_schema'" + logical_dependency)
    add("dependency", "i.schema", "i.name", "jsonb_build_array(" + source_id + "," + address("d.refclassid", "d.refobjid", "0") + ",d.deptype)",
        "jsonb_build_object('type',d.deptype)",
        "pg_shdepend d CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) i",
        "d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND i.schema !~ '^pg_' AND i.schema <> 'information_schema'" + logical_dependency)
    add("comment", "i.schema", "i.name", address("d.classoid", "d.objoid", "d.objsubid"), "jsonb_build_object('text',d.description)",
        "pg_description d CROSS JOIN LATERAL pg_identify_object(d.classoid,d.objoid,d.objsubid) i",
        "i.schema !~ '^pg_' AND i.schema <> 'information_schema'")
    refused = []
    def reject(name, query):
        refused.append("SELECT '" + name + "' AS kind,count(*) AS count FROM (" + query + ") bad HAVING count(*)>0")
    for table in INVENTORY_COVERAGE["refused"].split():
        reject(table, "SELECT 1 FROM " + table)
    reject("replication_slots", "SELECT 1 FROM pg_replication_slots")
    reject("reserved_namespace", "SELECT 1 FROM pg_namespace n WHERE nspname ~ '^pg_' AND nspname NOT IN ('pg_catalog','pg_toast') "
           "AND NOT(nspname ~ '^pg_(toast_)?temp_[0-9]+$' AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid) "
           "AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid))")
    # pg_identify_object reports NULL schema for these comments, and pg_dump omits a view's _RETURN rule comment.
    # The closed v1 restore contract refuses them before capture rather than silently losing their content.
    reject("unsupported_object_comment", "SELECT 1 FROM pg_description d WHERE "
           "(d.classoid='pg_trigger'::regclass AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
           "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE t.oid=d.objoid AND " + user_schema + ")) OR "
           "(d.classoid='pg_policy'::regclass AND EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
           "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE p.oid=d.objoid AND " + user_schema + ")) OR "
           "(d.classoid='pg_rewrite'::regclass AND EXISTS(SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class "
           "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.oid=d.objoid AND " + user_schema + "))")
    reject("unsupported_relation", "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE " + user_schema
           + " AND (c.relkind NOT IN ('r','v','S','c','i') OR c.relpersistence<>'p' OR c.relispartition)")
    reject("invalid_index", "SELECT 1 FROM pg_index WHERE NOT indisvalid OR NOT indisready OR NOT indislive")
    reject("altered_internal_trigger", "SELECT 1 FROM pg_trigger t WHERE t.tgisinternal AND (t.tgenabled<>'O' OR t.tgconstraint=0 "
           "OR t.tgparentid<>0 OR t.tgnargs<>0 OR t.tgqual IS NOT NULL OR cardinality(t.tgattr::smallint[])<>0 "
           "OR t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL OR obj_description(t.oid,'pg_trigger') IS NOT NULL "
           "OR t.tgname::text NOT IN ('RI_ConstraintTrigger_a_'||t.oid,'RI_ConstraintTrigger_c_'||t.oid,"
           "'PK_ConstraintTrigger_'||t.oid,'Unique_ConstraintTrigger_'||t.oid))")
    reject("unsupported_type", "SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE " + user_schema
           + " AND t.typtype NOT IN ('e','d','c') AND NOT EXISTS(SELECT 1 FROM pg_type e WHERE e.typarray=t.oid)")
    reject("unsupported_routine", "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE "
           + user_schema + " AND (l.lanname NOT IN ('sql','plpgsql') OR p.prokind NOT IN ('f','p'))")
    reject("extension", "SELECT 1 FROM pg_extension WHERE extname<>'plpgsql' OR extversion<>'1.0' OR extnamespace<>'pg_catalog'::regnamespace")
    reject("language", "SELECT 1 FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql')")
    reject("custom_rule", "SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE "
           + user_schema + " AND NOT(c.relkind='v' AND r.rulename='_RETURN')")
    for table in ("pg_am", "pg_amop", "pg_amproc", "pg_cast", "pg_collation", "pg_conversion", "pg_opclass", "pg_operator", "pg_opfamily", "pg_range",
                  "pg_ts_config", "pg_ts_dict", "pg_ts_parser", "pg_ts_template"):
        key = "rngtypid" if table == "pg_range" else "oid"
        reject("custom_" + table, "SELECT 1 FROM " + table + " WHERE " + key + ">=16384")
    return (PROJECTION_SETTINGS + "SET search_path=pg_catalog; SELECT jsonb_build_object('version','" + RESTORE_INVENTORY
            + "','server_major',current_setting('server_version_num')::int/10000,'catalogs',"
            "(SELECT jsonb_agg(relname ORDER BY relname) FROM pg_class WHERE relnamespace='pg_catalog'::regnamespace AND relkind='r'),"
            "'records',(SELECT coalesce(jsonb_agg(doc ORDER BY doc->'key'),'[]'::jsonb) FROM (" + " UNION ALL ".join(rows)
            + ") records),'unsupported',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY kind),'[]'::jsonb) FROM ("
            + " UNION ALL ".join(refused) + ") b));")


OBJECT_CATALOG_SQL = _restore_inventory_sql()


def inventory_valid(inventory, database):
    """Missing queries and unknown kinds/attributes are refusals, including an otherwise empty catalog."""
    expected = {name for group in INVENTORY_COVERAGE.values() for name in group.split()}
    if (type(inventory) is not dict or set(inventory) != {"version", "server_major", "catalogs", "records", "unsupported"}
            or inventory["version"] != RESTORE_INVENTORY or inventory["server_major"] != 16
            or type(inventory["catalogs"]) is not list or set(inventory["catalogs"]) != expected
            or len(inventory["catalogs"]) != len(expected) or type(inventory["unsupported"]) is not list
            or type(inventory["records"]) is not list):
        _unsupported("PostgreSQL 16 복원 inventory 조사 범위가 불완전합니다")
    if inventory["unsupported"]:
        _unsupported("v1 미지원 객체가 있어 변경 전에 거절했습니다", {"unsupported": inventory["unsupported"]})
    seen = set()
    for row in inventory["records"]:
        if type(row) is not dict or set(row) != {"key", "attributes"}:
            _unsupported("복원 객체 기록 형식이 다릅니다")
        key, attributes = row["key"], row["attributes"]
        if (type(key) is not list or len(key) != 5 or key[0] != database or key[2] not in INVENTORY_KINDS
                or type(attributes) is not dict or set(attributes) != set(INVENTORY_ATTRIBUTES[key[2]].split())):
            _unsupported("v1 미분류 객체 또는 속성이 있습니다")
        encoded = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
        if encoded in seen:
            _unsupported("복원 객체의 구조화 식별자가 중복됐습니다")
        seen.add(encoded)
    return inventory


_restore_container = ContextVar("backup_restore_container", default=None)


def _pg_command(container, program, *, interactive=False):
    command = ["docker", "exec", *(["-i"] if interactive else [])]
    if _restore_container.get() == container:
        # Replayed role/database defaults apply to the next connection. They must not turn the restore itself
        # read-only or cancel it mid-statement; the command runner still enforces its own bounded deadline.
        command += ["-e", "PGOPTIONS=-c default_transaction_read_only=off -c transaction_read_only=off "
                    "-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0 -c idle_session_timeout=0 -c search_path=pg_catalog"]
    return command + [container, program]


def psql_json(container, database, sql, user="kin", timeout=300):
    return json.loads(text(_pg_command(container, "psql") + ["-X", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1",
                            "-qAt", "-c", "SET client_encoding='UTF8'", "-c", "SET search_path=pg_catalog,public", "-c", sql], timeout=timeout))


def role_catalog(container, user="kin"):
    """Cluster roles, memberships, database owners, tablespaces and schemas: what pg_dump never carries."""
    return psql_json(container, "kin", ROLE_CATALOG_SQL, user)


def object_catalog(container, database, user="kin"):
    return inventory_valid(psql_json_stdin(container, database, OBJECT_CATALOG_SQL, user), database)


def cluster_catalog(container, user="kin"):
    """What a held capture records as catalog.json and a restore must reproduce exactly: the cluster's roles,
    memberships, databases, tablespaces and kin's schemas, and the owners/privileges of both databases' objects."""
    catalog = role_catalog(container, user)
    catalog["objects"] = {database: object_catalog(container, database, user) for database in PRE_DATABASES}
    return catalog


# System catalogs are compared with the exact image's initdb, not with a remembered default. These are logical
# fields only: tuple locations, transaction horizons and planner samples change without a logical database change.
BOUNDARY_SHARED = frozenset("pg_authid pg_auth_members pg_database pg_db_role_setting pg_replication_origin pg_shdepend "
                            "pg_shdescription pg_shseclabel pg_subscription pg_tablespace".split())
BOUNDARY_KEYS = {"pg_aggregate": "aggfnoid", "pg_attribute": "attrelid", "pg_attrdef": "adrelid", "pg_depend": "objid", "pg_description": "objoid",
                 "pg_enum": "enumtypid", "pg_index": "indexrelid", "pg_init_privs": "objoid", "pg_sequence": "seqrelid",
                 "pg_range": "rngtypid", "pg_ts_config_map": "mapcfg", "pg_publication_namespace": "pnnspid",
                 "pg_publication_rel": "prrelid", "pg_largeobject": "loid", "pg_inherits": "inhrelid",
                 "pg_partitioned_table": "partrelid", "pg_foreign_table": "ftrelid", "pg_subscription_rel": "srrelid",
                 "pg_seclabel": "objoid"}


def boundary_sql(system_only):
    rows = []
    for table in sorted({n for group in INVENTORY_COVERAGE.values() for n in group.split()}
                        - BOUNDARY_SHARED - set(INVENTORY_COVERAGE["physical"].split())):
        fields = ""
        if table == "pg_class":
            fields = "relfilenode relpages reltuples relallvisible relfrozenxid relminmxid"
        elif table == "pg_index":
            fields = "indcheckxmin"
        value = _json_without("r", fields) if fields else "to_jsonb(r)"
        where = ""
        if system_only:
            key = BOUNDARY_KEYS.get(table, "oid")
            # plpgsql is initdb's sole extension. Its generated OIDs must also match this image's baseline.
            namespace = {"pg_class": "relnamespace", "pg_type": "typnamespace", "pg_proc": "pronamespace",
                         "pg_constraint": "connamespace", "pg_collation": "collnamespace"}.get(table)
            condition = (namespace + " IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog','information_schema'))"
                         if namespace else key + "<16384")
            if table == "pg_namespace":
                condition = "nspname IN ('pg_catalog','information_schema','pg_toast')"
            if table in ("pg_description", "pg_init_privs"):
                condition += " OR " + key + " IN (SELECT oid FROM pg_extension UNION ALL SELECT oid FROM pg_language)"
                if table == "pg_description":
                    condition = "(" + condition + ") AND NOT(classoid='pg_namespace'::regclass AND objoid='public'::regnamespace)"
            where = " WHERE " + ("true" if table in ("pg_extension", "pg_language") else condition)
        rows.append("SELECT " + _sql_literal(table) + " AS name, coalesce(jsonb_agg(v ORDER BY v),'[]'::jsonb) AS rows FROM "
                    "(SELECT " + value + " AS v FROM pg_catalog." + table + " r" + where + ") x")
    return PROJECTION_SETTINGS + "SET search_path=pg_catalog; SELECT jsonb_object_agg(name,rows) FROM (" + " UNION ALL ".join(rows) + ") x;"


def boundary_proof(container, catalog, image=None):
    """Observe template0 on a private physical copy; never enable connections on the source template.

    A same-image initdb supplies the postgres/template/system baseline. The helper owns its temporary storage and has no source
    volume mounts. pg_basebackup is read-only with respect to logical source contents; its checkpoint/WAL activity is
    explicit. The disposable helper uses disk for its private copy. No raw values/verifiers leave it.
    """
    import shlex
    import tempfile
    info = json.loads(text(["docker", "inspect", container]))[0]
    image = image or info["Image"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        _unsupported("PostgreSQL 이미지 digest를 확인하지 못했습니다")
    size = psql_json(container, "kin", "SELECT sum(pg_database_size(oid)) FROM pg_database;")
    if type(size) is not int or size <= 0:
        _unsupported("template 경계 조사에 필요한 DB 크기를 읽지 못했습니다")
    env = dict(line.split("=", 1) for line in info.get("Config", {}).get("Env", []) if "=" in line)
    password = env.get("POSTGRES_PASSWORD")
    if not password or "\x00" in password:
        _unsupported("원본의 installer 인증 입력이 없습니다")
    # The script is private stdin; neither the password nor copied verifier data is an argv or a recorder artifact.
    script = "set -eu\numask 077\nexport PGPASSWORD=" + shlex.quote(password) + "\n"
    script += ("mkdir -p /tmp/source /tmp/fresh /tmp/emr\n"
               "pg_basebackup -h 127.0.0.1 -U kin -D /tmp/source -X stream --checkpoint=fast "
               "--no-password --tablespace-mapping=" + EMR_TABLESPACE + "=/tmp/emr >/dev/null 2>&1\n"
               "rm -f /tmp/source/postgresql.auto.conf /tmp/source/standby.signal /tmp/source/recovery.signal\n"
               "printf 'local all all trust\\nhost all all 127.0.0.1/32 scram-sha-256\\n' >/tmp/source/pg_hba.conf\n"
               "printf \"data_directory='/tmp/source'\\nhba_file='/tmp/source/pg_hba.conf'\\n"
               "listen_addresses='127.0.0.1'\\nport=5541\\nunix_socket_directories='/tmp'\\n"
               "shared_preload_libraries=''\\narchive_mode=off\\n\" >/tmp/source/config.private\n"
               "pg_ctl -D /tmp/source -o '-c config_file=/tmp/source/config.private' -l /tmp/source.log -w -t 60 start >/dev/null\n"
               "PGPORT=5541 psql -h 127.0.0.1 -U kin -d postgres -XqAt -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null\n"
               "psql -h /tmp -p 5541 -U kin -d postgres -XqAt -v ON_ERROR_STOP=1 "
               "-c 'ALTER DATABASE template0 ALLOW_CONNECTIONS true' >/dev/null\n"
               "initdb -D /tmp/fresh -U kin -A trust --no-instructions >/dev/null 2>&1\n"
               "pg_ctl -D /tmp/fresh -o '-p 5542 -k /tmp -c listen_addresses= -c shared_preload_libraries=' "
               "-l /tmp/fresh.log -w -t 60 start >/dev/null\n"
               "psql -h /tmp -p 5542 -U kin -d postgres -XqAt -v ON_ERROR_STOP=1 "
               "-c 'ALTER DATABASE template0 ALLOW_CONNECTIONS true' >/dev/null\n")
    secrets = snapshot_credentials(ROOT) if set(catalog["login_verifiers"]) - {"kin"} else {}
    for member in catalog["login_verifiers"]:
        if member == "kin":
            continue
        password = secrets.get(member)
        if not password:
            _unsupported("LOGIN 역할의 보호된 인증 입력이 없습니다")
        script += ("PGPASSWORD=" + shlex.quote(password) + " psql -h 127.0.0.1 -p 5541 -U " + shlex.quote(member)
                   + " -d kin -XqAt -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null\n")
    queries = [("source", 5541, name, False) for name in ("postgres", "template0", "template1")]
    queries += [("fresh", 5542, name, False) for name in ("postgres", "template0", "template1")]
    queries += [("source", 5541, name, True) for name in PRE_DATABASES]
    queries += [("fresh", 5542, "postgres", True)]
    for index, (label, port, name, system) in enumerate(queries):
        script += (f"psql -h /tmp -p {port} -U kin -d {name} -XqAt -v ON_ERROR_STOP=1 <<'BOUNDARY_{index}'\n"
                   + boundary_sql(system) + f"\nBOUNDARY_{index}\n")
    # Fresh global baseline has no kin database yet; this query's schemas are immaterial to that comparison.
    script += "psql -h /tmp -p 5542 -U kin -d postgres -XqAt -v ON_ERROR_STOP=1 <<'GLOBAL_BASELINE'\n" + ROLE_CATALOG_SQL + ";\nGLOBAL_BASELINE\n"
    script += "pg_ctl -D /tmp/source -m fast -w stop >/dev/null\npg_ctl -D /tmp/fresh -m fast -w stop >/dev/null\n"
    with tempfile.TemporaryFile() as handle:
        handle.write(script.encode("utf-8")); handle.seek(0)
        raw = temporary_run(["-i", "--network", "container:" + container, "--user", "postgres", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=1m",
                             "--entrypoint", "sh", image, "-s"], input_file=handle, timeout=600)
    try:
        # json_agg of composite rows may emit embedded newlines. A psql row is one JSON document, not one line.
        decoder, found = json.JSONDecoder(), []
        while raw:
            value, end = decoder.raw_decode(raw)
            found.append(value)
            raw = raw[end:].lstrip(" \t\r\n")
    except ValueError:
        _unsupported("template 경계 조사 결과를 읽지 못했습니다")
    if len(found) != len(queries) + 1:
        _unsupported("template 경계 조사가 불완전합니다")
    if any(found[index] != found[index + 3] for index in range(3)) or any(found[index] != found[8] for index in (6, 7)):
        _unsupported("postgres/template 또는 시스템 객체가 같은 이미지의 초기 경계와 다릅니다")
    fresh = found[-1]
    if catalog.get("builtin_roles") != fresh.get("builtin_roles"):
        _unsupported("기본 제공 역할이 초기 경계와 다릅니다")
    def builtin_memberships(value):
        return [row for row in value["memberships"] if row["member"].startswith("pg_")]
    if builtin_memberships(catalog) != builtin_memberships(fresh):
        _unsupported("기본 제공 역할의 membership이 초기 경계와 다릅니다")
    if catalog.get("setting_names") != fresh.get("setting_names"):
        _unsupported("역할 설정의 PostgreSQL 지원 목록이 초기 경계와 다릅니다")
    for database in ("postgres", "template0", "template1"):
        source_row = next(row for row in catalog["databases"] if row["name"] == database)
        fresh_row = dict(next(row for row in fresh["databases"] if row["name"] == database))
        if database == "template0":
            fresh_row["attributes"] = dict(fresh_row["attributes"], datallowconn=False)
        if source_row != fresh_row:
            _unsupported("postgres/template 데이터베이스 속성이 초기 경계와 다릅니다")
    for space in DEFAULT_TABLESPACES:
        if next(row for row in catalog["tablespaces"] if row["name"] == space) != next(row for row in fresh["tablespaces"] if row["name"] == space):
            _unsupported("기본 tablespace 속성이 초기 경계와 다릅니다")
    return {"version": RESTORE_INVENTORY, "postgres_image": image, "boundary": "same-image-initdb", "template0": "private-physical-copy"}


def restore_admission(container, *, shape, image=None):
    """Called before the first fence and again under the fence, before creating a capture directory."""
    catalog = supported_catalog(cluster_catalog(container), shape=shape)
    boundary_proof(container, catalog, image)
    values = value_catalog(container)
    return catalog, values


class RestoreAdmissionError(RuntimeError):
    def __init__(self, message, evidence=None):
        super().__init__("Unsupported pre-EMR catalog: " + message)
        self.evidence = {"version": RESTORE_INVENTORY, "reason": message, **(evidence or {})}


def _unsupported(message, evidence=None):
    raise RestoreAdmissionError(message, evidence)


# The bootstrap superuser of a fresh cluster of the product's image (POSTGRES_USER=kin), as pg_roles shows it.
BOOTSTRAP_KIN = {"rolsuper": True, "rolcreaterole": True, "rolcreatedb": True, "rolcanlogin": True, "rolreplication": True,
                 "rolbypassrls": True, "rolinherit": True, "rolconnlimit": -1, "rolvaliduntil": None, "rolconfig": None}


def supported_pre_catalog(catalog):
    """A pre-EMR cluster this tool can rebuild exactly in a fresh cluster, or a refusal before anything changes.

    Supported: the installer superuser kin (the image's POSTGRES_USER, LOGIN), any number of further NOLOGIN roles
    (their attributes, connection limit and validity are replayed exactly; stored verifiers are refused), memberships
    among them (and predefined pg_* roles), the databases kin and keycloak (plus the image's postgres), and only the
    default tablespaces. Refused: a further LOGIN role (its password is never captured, so a restore could not
    reproduce it), another database or tablespace, a name that is not a plain identifier. Declared session settings
    are replayed at their role/database scope; custom settings, preload hooks and template settings are refused."""
    return supported_catalog(catalog, shape="pre")


def supported_catalog(catalog, *, shape):
    """supported_pre_catalog's rule; a post-EMR capture (B1, restored only into an isolated check cluster) may also hold
    the EMR roles and tablespace. Every stored LOGIN verifier must have protected credential input for replay."""
    if type(catalog) is not dict:
        _unsupported("unreadable")
    if catalog.get("server_major") != 16 or type(catalog.get("unsupported_verifiers")) is not list:
        _unsupported("PG16 자격증명 존재 여부를 조사하지 못했습니다")
    if catalog["unsupported_verifiers"]:
        _unsupported("재현 계약 밖의 저장 verifier가 있습니다. NOLOGIN도 예외가 아닙니다")
    if type(catalog.get("settings")) is not list or type(catalog.get("setting_names")) is not list:
        _unsupported("cluster/database/role 설정 조사가 불완전합니다")
    if type(catalog.get("login_verifiers")) is not list or "kin" not in catalog["login_verifiers"]:
        _unsupported("installer 저장 verifier 조사가 불완전합니다")
    roles = {}
    for role in catalog.get("roles") or []:
        name = role.get("rolname")
        if type(name) is not str or not SQL_NAME.fullmatch(name):
            _unsupported("a role name is not a plain identifier")
        if name in roles:
            _unsupported("역할 식별자가 중복됐습니다")
        roles[name] = role
    installer = roles.get("kin")
    if not installer or installer.get("rolsuper") is not True or installer.get("rolcanlogin") is not True:
        _unsupported("the installer superuser kin is missing")
    # IRT2-17: a fresh cluster's bootstrap kin has exactly these attributes and the replay never alters it, so a kin that
    # differs (connection limit, validity, settings, a dropped attribute) could not be rebuilt: refused at capture.
    if {key: installer.get(key) for key in BOOTSTRAP_KIN if key != "rolconfig"} != {key: value for key, value in BOOTSTRAP_KIN.items() if key != "rolconfig"}:
        _unsupported("the installer superuser kin has attributes a fresh cluster's kin does not")
    for name, role in roles.items():
        if any(key not in role for key in ("rolsuper", "rolcreaterole", "rolcreatedb", "rolcanlogin", "rolreplication",
                                           "rolbypassrls", "rolinherit", "rolconnlimit", "rolvaliduntil", "rolconfig")):
            _unsupported("role attributes are incomplete")
        configuration(role.get("rolconfig"), catalog["setting_names"])
        if name != "kin" and role.get("rolcanlogin") is not False and not (shape == "post" and name in EMR_ROLES):
            _unsupported("a further LOGIN role exists (its password cannot be restored)")
        if role.get("rolvaliduntil") is not None and not re.fullmatch(r"[0-9A-Za-z :+.-]{1,40}", str(role["rolvaliduntil"])):
            _unsupported("a role validity is unreadable")
        if type(role.get("rolconnlimit")) is not int:
            _unsupported("a role connection limit is unreadable")
    for membership in catalog.get("memberships") or []:
        for key in ("granted", "member"):
            name = membership.get(key)
            if type(name) is not str or not (name in roles or (name.startswith("pg_") and SQL_NAME.fullmatch(name))):
                _unsupported("a membership names an unknown role")
        if any(type(membership.get(key)) is not bool for key in ("admin_option", "inherit_option", "set_option")):
            _unsupported("membership options are unreadable")
        # IRT2-16: the replay grants as the bootstrap kin, so only memberships kin granted can be rebuilt with their grantor.
        if membership.get("grantor") != "kin":
            _unsupported("a membership was granted by another role than kin")
    databases = {item.get("name"): item for item in catalog.get("databases") or []}
    if set(databases) != {*PRE_DATABASES, "postgres", "template0", "template1"}:
        _unsupported("the databases are not exactly kin and keycloak")
    if any(databases[name].get("owner") != "kin" for name in databases if name != "keycloak") or databases["keycloak"].get("owner") not in roles:
        _unsupported("a database owner differs")
    for name in PRE_DATABASES:
        attributes = databases[name].get("attributes") or {}
        if attributes.get("datistemplate") is not False or attributes.get("datallowconn") is not True:
            _unsupported("업무 데이터베이스의 template 또는 연결 허용 속성이 초기 경계와 다릅니다")
    allowed = (*DEFAULT_TABLESPACES, *(("kin_emr_access",) if shape == "post" else ()))
    if any(space.get("name") not in allowed for space in catalog.get("tablespaces") or []):
        _unsupported("a further tablespace exists")
    if shape == "post" and not any(space.get("name") == "kin_emr_access" and space.get("location") == EMR_TABLESPACE
                                   for space in catalog.get("tablespaces") or []):
        _unsupported("the EMR tablespace is missing or elsewhere")
    scopes = set()
    for entry in catalog["settings"]:
        if type(entry) is not dict or set(entry) != {"database", "role", "config"}:
            _unsupported("설정 범위 형식이 다릅니다")
        database, member = entry["database"], entry["role"]
        if database not in (*PRE_DATABASES, None) or (member is not None and member not in roles):
            _unsupported("순정 postgres/template 또는 기본 제공 역할의 설정이 달라졌습니다")
        if (database, member) in scopes:
            _unsupported("설정 범위가 중복됐습니다")
        scopes.add((database, member))
        configuration(entry["config"], catalog["setting_names"])
    return catalog


def _sql_literal(value):
    # Role/database defaults may disable standard_conforming_strings. Explicit escapes keep stored backslashes and
    # quotes as data in either setting; doubled quotes also work when backslash_quote is disabled.
    return "E'" + str(value).replace("\\", "\\\\").replace("'", "''") + "'"


def configuration(values, allowed):
    if values is None:
        return []
    if type(values) is not list:
        _unsupported("역할 또는 DB 설정 값이 배열이 아닙니다")
    found, result = set(), []
    for item in values:
        if type(item) is not str or "=" not in item or "\x00" in item:
            _unsupported("역할 또는 DB 설정 값을 읽지 못했습니다")
        name, value = item.split("=", 1)
        if name not in RESTORE_SETTINGS or name not in allowed or name.lower() in found or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name):
            _unsupported("v1 지원 목록 밖의 역할 또는 DB 설정입니다")
        found.add(name.lower())
        result.append((name, value))
    return result


def configuration_sql(scope, values, allowed):
    # Persist scalar defaults without activating them on this connection (transaction_read_only and short timeouts
    # would interrupt the replay). search_path is v1's only GUC_LIST_QUOTE setting; PostgreSQL parses its list.
    statements = [scope + " RESET ALL;"]
    for name, value in configuration(values, allowed):
        if name != "search_path":
            statements.append(scope + " SET " + _identifier(name) + " TO " + _sql_literal(value) + ";")
            continue
        statements += ["SELECT pg_catalog.set_config(" + _sql_literal(name) + "," + _sql_literal(value) + ",false);",
                       scope + " SET " + _identifier(name) + " FROM CURRENT;", "RESET " + _identifier(name) + ";"]
    return statements


def run_private_sql(container, statements, user="kin"):
    import tempfile
    with tempfile.TemporaryFile() as handle:
        handle.write(("SET client_encoding='UTF8';\nSET search_path=pg_catalog; SET TimeZone='UTC'; SET log_statement='none'; SET log_min_duration_statement=-1;\nBEGIN;\n"
                      + "\n".join(statements) + "\nCOMMIT;\n").encode("utf-8"))
        handle.seek(0)
        run(_pg_command(container, "psql", interactive=True) + ["-X", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], input_file=handle)


def replay_roles(container, source, user="kin", shape="pre", credentials=None):
    """Rebuild a supported snapshot's roles and memberships in a fresh cluster whose bootstrap superuser is kin, as the
    product's. Supported EMR login verifiers are rebuilt from the private snapshot credentials, whose authentication
    was checked on the source copy. Memberships are granted by kin (PG16 requires the grantor's ADMIN OPTION), then
    the cluster must have exactly the snapshot's roles and memberships."""
    supported_catalog(source, shape=shape)
    fresh = role_catalog(container, user)
    present = {role["rolname"]: role for role in fresh["roles"]}
    statements = []
    for role in source["roles"]:
        name = role["rolname"]
        if name in present:
            if {k: v for k, v in present[name].items() if k != "rolconfig"} != {k: v for k, v in role.items() if k != "rolconfig"}:
                raise RuntimeError("A role of the fresh cluster differs from the snapshot: " + name)
            continue
        flags = [("" if role["rolsuper"] else "NO") + "SUPERUSER", ("" if role["rolcreaterole"] else "NO") + "CREATEROLE",
                 ("" if role["rolcreatedb"] else "NO") + "CREATEDB", ("" if role["rolcanlogin"] else "NO") + "LOGIN",
                 ("" if role["rolreplication"] else "NO") + "REPLICATION", ("" if role["rolbypassrls"] else "NO") + "BYPASSRLS",
                 ("" if role["rolinherit"] else "NO") + "INHERIT", "CONNECTION LIMIT %d" % role["rolconnlimit"]]
        if role["rolvaliduntil"] is not None:
            flags.append("VALID UNTIL " + _sql_literal(role["rolvaliduntil"]))
        statements.append('CREATE ROLE "%s" WITH %s;' % (name, " ".join(flags)))
    # initdb's bootstrap kin already exists but trust-only rehearsal initialization supplies no verifier. Rebuild
    # every supported source verifier, including existing roles, from the protected capture credentials.
    for name in source["login_verifiers"]:
        password = (credentials or {}).get(name)
        if not password:
            _unsupported("저장 verifier가 있는 LOGIN 역할의 복원 인증 입력이 없습니다")
        statements.append('ALTER ROLE ' + _identifier(name) + ' PASSWORD ' + _sql_literal(password) + ';')
    for name, comment in source.get("role_comments", []):
        if name not in {row["rolname"] for row in source["roles"]}:
            _unsupported("역할 주석이 조사한 역할 밖을 가리킵니다")
        if comment is not None:
            statements.append('COMMENT ON ROLE ' + _identifier(name) + ' IS ' + _sql_literal(comment) + ';')
    for role in source["roles"]:
        if role.get("rolconfig"):
            statements += configuration_sql('ALTER ROLE ' + _identifier(role["rolname"]), role["rolconfig"], source["setting_names"])
    granted = {(item["granted"], item["member"]) for item in fresh["memberships"]}
    for item in source["memberships"]:
        if (item["granted"], item["member"]) not in granted:
            statements.append('GRANT "%s" TO "%s" WITH ADMIN %s, INHERIT %s, SET %s;' % (
                item["granted"], item["member"], *("TRUE" if item[key] else "FALSE" for key in ("admin_option", "inherit_option", "set_option"))))
    if statements:
        run_private_sql(container, statements, user)
    after = role_catalog(container, user)
    if any(after.get(key) != source.get(key) for key in ("roles", "memberships", "login_verifiers", "role_comments")):
        raise RuntimeError("Replayed roles or memberships differ from the snapshot")
    return {"created": [line.split('"')[1] for line in statements if line.startswith("CREATE ROLE")],
            "granted": sum(1 for line in statements if line.startswith("GRANT"))}


def restore_pre_snapshot(container, directory, user="kin"):
    """A pre-EMR snapshot into a fresh product-shaped cluster (the image created kin as POSTGRES_USER/POSTGRES_DB):
    its roles replayed, the image's empty kin database replaced, kin and keycloak restored with --create (database
    owners, privileges and settings included), never with --no-owner/--no-privileges; then the cluster's whole catalog
    (roles, memberships, databases, tablespaces, schemas, every object's owner and privileges) equals the snapshot's."""
    return restore_snapshot(container, directory, user, shape="pre")


def restore_snapshot(container, directory, user="kin", shape="pre", source=None):
    """restore_pre_snapshot for either held shape; a post-EMR snapshot also gets its EMR tablespace (owned by the
    replayed kin_emr_owner, at the product's fixed path) before its databases are restored. source: a daily set's role
    catalog (D23; from its manifest, without per-object owners and privileges), compared as the role catalog only;
    otherwise the snapshot's catalog.json, compared whole."""
    token = _restore_container.set(container)
    try:
        return _restore_snapshot(container, directory, user, shape, source)
    finally:
        _restore_container.reset(token)


def _restore_snapshot(container, directory, user, shape, source):
    directory = Path(directory)
    whole = source is None
    if whole:
        source = json.loads((directory / "catalog.json").read_text(encoding="utf-8"))
        if type(source.get("objects")) is not dict or set(source["objects"]) != set(PRE_DATABASES):
            _unsupported("복원 snapshot의 DB inventory가 불완전합니다")
        for database in PRE_DATABASES:
            inventory_valid(source["objects"][database], database)
    credentials = snapshot_credentials(directory)
    replayed = replay_roles(container, source, user, shape, credentials)
    probe = _pg_command(container, "psql") + ["-X", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c"]
    if shape == "post":
        run(probe + ["CREATE TABLESPACE kin_emr_access OWNER kin_emr_owner LOCATION '" + EMR_TABLESPACE + "';"])
    fresh = text(probe + ["SELECT (SELECT count(*) FROM pg_database WHERE datname='keycloak') || ':' || "
                          "(SELECT count(*) FROM pg_database WHERE datname='kin');"])
    tables = text(_pg_command(container, "psql") + ["-X", "-U", user, "-d", "kin", "-v", "ON_ERROR_STOP=1", "-qAt", "-c",
                   "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';"])
    if fresh != "0:1" or tables != "0":
        raise RuntimeError("The restore target is not a fresh cluster")
    run(probe + ["DROP DATABASE kin WITH (FORCE);"])
    for database in PRE_DATABASES:
        with (directory / (database + ".dump")).open("rb") as handle:
            run(_pg_command(container, "pg_restore", interactive=True) + ["-U", user, "-d", "postgres", "--create", "--exit-on-error"],
                input_file=handle, timeout=1800)
    settings = []
    for entry in source["settings"]:
        scope = "ALTER ROLE " + ("ALL" if entry["role"] is None else _identifier(entry["role"]))
        if entry["database"] is not None:
            scope += " IN DATABASE " + _identifier(entry["database"])
        settings += configuration_sql(scope, entry["config"], source["setting_names"])
    if settings:
        run_private_sql(container, settings, user)
    restored = cluster_catalog(container, user) if whole else role_catalog(container, user)
    if restored != source:
        differing = sorted(key for key in set(restored) | set(source) if restored.get(key) != source.get(key))
        raise RuntimeError("Restored catalog differs from the snapshot: " + ",".join(differing))
    return {"roles_created": replayed["created"], "memberships_granted": replayed["granted"], "catalog": "equal"}


def snapshot_credentials(directory):
    env = {}
    for line in (Path(directory) / ".env").read_text(encoding="utf-8").splitlines():
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env[key.strip()] = value
    return {role: env.get(key) for role, key in (("kin", "POSTGRES_PASSWORD"), ("kin_runtime", "KIN_EMR_RUNTIME_PASSWORD"),
        ("kin_emr_reader", "KIN_EMR_READER_PASSWORD"), ("kin_emr_retention", "KIN_EMR_RETENTION_PASSWORD"))}


def migration_rows(container, user="kin"):
    """The applied Prisma history as [name, checksum, finished, rolled_back], in Prisma's name order."""
    return psql_json(container, "kin", MIGRATIONS_SQL, user)


def projection(container, database="kin", user="kin", columns=None):
    """Per public table: row count and a SHA-256 over the rows of the given columns (default: every current column).

    Recomputed after a migration with the snapshot's own column lists, it proves the existing rows kept every value they
    had: a new column is outside the projection, a changed, dropped or rewritten value is a different digest."""
    if columns is None:
        found = psql_json(container, database, """SELECT coalesce(json_object_agg(t.tablename, (SELECT json_agg(c.column_name::text
          ORDER BY c.ordinal_position) FROM information_schema.columns c WHERE c.table_schema='public'
          AND c.table_name=t.tablename)), '{}'::json) FROM pg_tables t WHERE t.schemaname='public'""", user)
        columns = {name: found[name] for name in sorted(found)}
    if not columns:
        raise RuntimeError("Empty projection source")
    selects = []
    for table, names in columns.items():
        if type(table) is not str or not table or "\x00" in table or not names or any(type(name) is not str or not name or "\x00" in name for name in names):
            raise RuntimeError("Unexpected table or column name")
        row = "ROW(" + ", ".join(_identifier(name) for name in names) + ")::text"
        selects.append("SELECT " + _sql_literal(table) + " AS name, (SELECT json_build_array(count(*), encode(sha256(convert_to("
                       f"coalesce(string_agg(r, E'\\n' ORDER BY r COLLATE \"C\"), ''), 'UTF8')), 'hex')) FROM "
                       + "(SELECT " + row + " AS r FROM public." + _identifier(table) + ") s) AS d")
    result = psql_json(container, database, PROJECTION_SETTINGS + "SELECT json_object_agg(name, d) FROM ("
                       + " UNION ALL ".join(selects) + ") x", user)
    return {table: {"columns": list(names), "count": result[table][0], "sha256": result[table][1]}
            for table, names in columns.items()}


VALUE_TABLES_SQL = """SELECT coalesce(json_agg(json_build_array(n.nspname, c.relname) ORDER BY n.nspname, c.relname), '[]'::json)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'"""


def _identifier(name):
    return '"' + str(name).replace('"', '""') + '"'


def psql_json_stdin(container, database, sql, user="kin", timeout=1800):
    """psql_json with the statement on stdin (a statement over every table can exceed a command line)."""
    import tempfile
    with tempfile.TemporaryFile() as handle:
        handle.write(("SET client_encoding='UTF8';\nSET search_path=pg_catalog,public;\n" + sql).encode("utf-8"))
        handle.flush()
        handle.seek(0)
        result = run(_pg_command(container, "psql", interactive=True) + ["-X", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-qAt", "-f", "-"],
                     input_file=handle, timeout=timeout)
    return json.loads(result.stdout.decode("utf-8").strip())


def value_columns(container, database, schema, table, user="kin"):
    columns = psql_json_stdin(container, database,
        "SET search_path=pg_catalog; SELECT coalesce(json_agg(a.attname ORDER BY a.attnum),'[]'::json) FROM pg_attribute a "
        "JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind='r' AND c.relpersistence='p' AND n.nspname="
        + _sql_literal(schema) + " AND c.relname=" + _sql_literal(table) + ";", user)
    if type(columns) is not list or any(type(name) is not str for name in columns) or len(set(columns)) != len(columns):
        _unsupported("값 비교의 column 목록을 읽지 못했습니다")
    return columns


def _value_encoded(value):
    """The row encoding value_digest frames: compact JSON, non-ASCII kept, UTF-8."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _stream_values(container, database, schema, table, columns, user, *, ordered):
    """Yield (encoded, row) for every row of one table without aggregating it anywhere.

    #252 removed the invented row/cell/byte caps but left one jsonb_agg of the whole table in the source backend and its
    whole text in the psql client and in this process (2026-10-27 reaudit R3). COPY streams rows from the backend
    through psql into a file, and only one row is decoded here at a time, so no bound is needed. The server builds
    value_digest's exact row encoding (to_json escapes the same characters as json.dumps; NULL is null) and, when
    ordered, sorts by its UTF-8 bytes (external sort, spilling to disk past work_mem), the order value_digest sorts in.
    Every row is checked to be that canonical encoding and, when ordered, not to precede the previous one, so a
    differing server encoding or order refuses the comparison instead of producing an incomparable digest.
    """
    import tempfile
    relation = _identifier(schema) + "." + _identifier(table)
    encoding = "'['" + "".join((" || ',' || " if index else " || ") + "coalesce(to_json(t." + _identifier(name)
                               + "::text)::text,'null')" for index, name in enumerate(columns)) + " || ']'"
    query = "SELECT e FROM (SELECT " + encoding + " AS e FROM " + relation + " t) s" + (" ORDER BY convert_to(e,'UTF8')" if ordered else "")
    sql = (PROJECTION_SETTINGS + "SET search_path=pg_catalog; SET statement_timeout='180s';\n"
           "COPY (" + query + ") TO STDOUT;\n")
    with tempfile.TemporaryFile() as statement, tempfile.TemporaryFile() as output:
        statement.write(sql.encode("utf-8"))
        statement.flush()
        statement.seek(0)
        run(_pg_command(container, "psql", interactive=True) + ["-X", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-qAt", "-f", "-"],
            input_file=statement, output=output, timeout=1800)
        output.seek(0)
        previous = None
        for line in output:
            # The encoding has no raw tab/newline/carriage return (JSON escapes them), so COPY's text format only
            # doubles each backslash. A lone backslash would mean another escape and is refused.
            if not line.endswith(b"\n"):
                _unsupported("값 조회 출력이 행 경계에서 끝나지 않았습니다")
            parts = line[:-1].split(b"\\\\")
            if any(b"\\" in part for part in parts):
                _unsupported("값 조회 출력의 escape 형식이 다릅니다")
            encoded = b"\\".join(parts)
            try:
                row = json.loads(encoded.decode("utf-8"))
            except ValueError:
                _unsupported("값 조회 출력이 JSON 행이 아닙니다")
            if (type(row) is not list or len(row) != len(columns) or any(value is not None and type(value) is not str for value in row)
                    or _value_encoded(row) != encoded or (ordered and previous is not None and encoded < previous)):
                _unsupported("값 조회 중 row/column 범위 또는 순서가 달라졌습니다")
            if ordered:
                previous = encoded
            yield encoded, row


def value_rows(container, database, schema, table, user="kin"):
    """Private in-memory rows only, for callers that rebuild or inspect rows. The command recorder keeps output hashes,
    never this response's contents.

    Text of each typed column is enclosed in a JSON array, retaining NULL, empty values, JSON text, bytea and embedded
    separators exactly.
    """
    columns = value_columns(container, database, schema, table, user)
    return columns, [row for _, row in _stream_values(container, database, schema, table, columns, user, ordered=False)]


def _digest_record(key, columns, encoded_rows):
    digest_value = hashlib.sha256()
    count = 0
    for value in encoded_rows:
        digest_value.update(str(len(value)).encode("ascii") + b":" + value)
        count += 1
    return {"key": list(key), "columns": list(columns), "count": count, "sha256": digest_value.hexdigest()}


def value_digest(key, columns, rows):
    """Length-framed UTF-8 arrays make row boundaries and duplicate multiplicity unambiguous."""
    return _digest_record(key, columns, sorted(_value_encoded(row) for row in rows))


def value_table_digest(container, database, schema, table, user="kin"):
    """value_digest of one table, computed while its server-sorted rows stream past: memory stays one row."""
    columns = value_columns(container, database, schema, table, user)
    return _digest_record((database, schema, "table", table, None), columns,
                          (encoded for encoded, _ in _stream_values(container, database, schema, table, columns, user, ordered=True)))


def value_catalog(container, user="kin", transform=None):
    """All columns/rows of both databases, with structured keys; each table's digest is computed as its rows stream.

    An internal clone transform may compute a precise expected projection before mutation; only that path holds a
    table's rows, and only on the clone. Actual observations (including restore_admission on the live database) always
    use transform=None. A table name is never an exemption from residual comparison.
    """
    out = {"version": RESTORE_INVENTORY, "tables": []}
    seen = set()
    for database in PRE_DATABASES:
        tables = psql_json(container, database, VALUE_TABLES_SQL, user)
        if type(tables) is not list:
            _unsupported("값 비교의 table 목록을 읽지 못했습니다")
        for item in tables:
            if type(item) is not list or len(item) != 2 or any(type(name) is not str for name in item):
                _unsupported("table 식별자 형식이 다릅니다")
            schema, table = item
            key = (database, schema, "table", table, None)
            if key in seen:
                _unsupported("table 식별자가 중복됐습니다")
            seen.add(key)
            if transform is None:
                out["tables"].append(value_table_digest(container, database, schema, table, user))
            else:
                columns, rows = value_rows(container, database, schema, table, user)
                out["tables"].append(value_digest(key, columns, transform(key, columns, rows)))
    out["tables"].sort(key=lambda row: row["key"][:4])
    return values_valid(out)


def values_valid(values):
    if type(values) is not dict or set(values) != {"version", "tables"} or values["version"] != RESTORE_INVENTORY or type(values["tables"]) is not list:
        _unsupported("전체 값 inventory 형식이 다릅니다")
    seen = set()
    for row in values["tables"]:
        if type(row) is not dict or set(row) != {"key", "columns", "count", "sha256"}:
            _unsupported("전체 값 table 기록이 불완전합니다")
        key, columns = row["key"], row["columns"]
        if (type(key) is not list or len(key) != 5 or key[0] not in PRE_DATABASES or key[2] != "table" or key[4] is not None
                or any(type(key[index]) is not str or not key[index] or "\x00" in key[index] for index in (1, 3))
                or type(columns) is not list or any(type(name) is not str or not name or "\x00" in name for name in columns)
                or len(set(columns)) != len(columns) or type(row["count"]) is not int or row["count"] < 0
                or type(row["sha256"]) is not str or re.fullmatch(r"[a-f0-9]{64}", row["sha256"]) is None):
            _unsupported("전체 값 table의 구조화 키 또는 digest가 잘못됐습니다")
        if tuple(key) in seen:
            _unsupported("전체 값 table 키가 중복됐습니다")
        seen.add(tuple(key))
    return values


def value_counts(values):
    return {database: [{"key": row["key"], "count": row["count"]} for row in values["tables"] if row["key"][0] == database]
            for database in PRE_DATABASES}


def env_names(path):
    """Variable names of an env file, never values."""
    names = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            name = stripped.split("=", 1)[0].strip()
            if ENV_NAME.fullmatch(name):
                names.append(name)
    return sorted(set(names))


def _held_resources(resources):
    containers, volumes = resources.get("containers"), resources.get("volumes")
    if (type(containers) is not dict or set(containers) != set(ROLE_KEYS) or type(volumes) is not dict
            or not {"orthanc", "pg"} <= set(volumes)
            or any(type(name) is not str or not RESOURCE_NAME.fullmatch(name)
                   for name in (*containers.values(), *volumes.values()))):
        raise RuntimeError("Incomplete capture resources")
    return containers, volumes


def _volume_of(container, destination):
    mounts = [m for m in container.get("Mounts") or [] if m.get("Destination") == destination]
    if len(mounts) != 1 or mounts[0].get("Type") != "volume":
        raise RuntimeError("Expected one named volume at " + destination)
    return mounts[0]["Name"]


def capture_held(output, resources, *, shape, label, config=(), facts=None, ready_free=512 * 1024 * 1024):
    """One consistent snapshot while the caller holds every writer fenced; returns the new directory.

    shape 'pre' is the Stage-5 form (no EMR storage may exist yet); 'post' requires the EMR storage and archives its API
    state volume at the same pause. This function stops and starts nothing: writers that are running refuse the
    capture, and on any failure they stay as the caller left them. The caller releases them (or rolls back) explicitly.
    facts: the caller's secret-free identifiers recorded in metadata.json (e.g. origin, TLS certificate path).
    """
    if shape not in ("pre", "post") or type(label) is not str or not HELD_LABEL.fullmatch(label):
        raise RuntimeError("Invalid held capture request")
    facts = dict(facts or {})
    if any(type(key) is not str or not CONFIG_NAME.fullmatch(key) or type(value) is not str or len(value) > 1024
           for key, value in facts.items()):
        raise RuntimeError("Invalid capture facts")
    containers, volumes = _held_resources(resources)
    if shape == "post" and not RESOURCE_NAME.fullmatch(str(volumes.get("emr_state", ""))):
        raise RuntimeError("Post-EMR capture needs the EMR state volume")
    parent = Path(output).resolve()
    if parent == ROOT or ROOT in parent.parents:
        raise RuntimeError("Backups containing secrets must be outside the Git repository")
    extra = {}
    for name, source in dict(config).items():
        if not CONFIG_NAME.fullmatch(name) or name in (*FILES, *HELD_EXTRA, *EMR_FILES, "manifest.json"):
            raise RuntimeError("Invalid configuration component name")
        extra[name] = Path(source)
    for name in FILES[3:]:
        if not (ROOT / name).is_file():
            raise RuntimeError("Configuration file missing: " + name)
    info = json.loads(text(["docker", "inspect", *containers.values()]))
    by_role = {}
    for role, name in containers.items():
        found = [item for item in info if item.get("Name") == "/" + name]
        if len(found) != 1:
            raise RuntimeError("Capture resource not found: " + role)
        by_role[role] = found[0]
    db = by_role["db"]
    if not db["State"]["Running"] or any(item["State"].get("Restarting") for item in by_role.values()):
        raise RuntimeError("PostgreSQL must run and nothing may be restarting")
    running = [role for role in WRITER_ROLES if by_role[role]["State"]["Running"]]
    if running:
        raise RuntimeError("Writers are not fenced: " + ", ".join(running))
    if _volume_of(by_role["orthanc"], "/var/lib/orthanc/db") != volumes["orthanc"]:
        raise RuntimeError("Orthanc volume differs from the target manifest")
    if _volume_of(db, "/var/lib/postgresql/data") != volumes["pg"]:
        raise RuntimeError("Database volume differs from the target manifest")
    db_name = containers["db"]
    roles = role_catalog(db_name)
    present = {role["rolname"] for role in roles["roles"]} & set(EMR_ROLES)
    if shape == "pre":
        if (present or any(str(name).startswith("emr_") for name in roles["schemas"])
                or any(space.get("name") == "kin_emr_access" for space in roles["tablespaces"])
                or any(m.get("Destination") == EMR_STATE for m in by_role["api"].get("Mounts") or [])):
            raise RuntimeError("A pre-EMR capture found EMR storage")
        # A B0 that a rollback could not rebuild exactly is refused before anything is written.
        supported_pre_catalog(roles)
        state_volume = None
    else:
        state_volume = _volume_of(by_role["api"], EMR_STATE)
        if state_volume != volumes["emr_state"] or present != set(EMR_ROLES):
            raise RuntimeError("Post-EMR capture resources differ from the target manifest")
        # Its restore check rebuilds it the same way: refused before anything is written, not in the check cluster.
        supported_catalog(roles, shape="post")
    catalog, captured_values = restore_admission(db_name, shape=shape, image=db["Image"])
    if {key: value for key, value in catalog.items() if key != "objects"} != roles:
        _unsupported("admission 도중 전역 카탈로그가 달라졌습니다")
    roles = catalog
    active = text(["docker", "exec", db_name, "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                   "SELECT count(*) FROM pg_stat_activity WHERE "
                   "backend_type='client backend' AND pid<>pg_backend_pid();"])
    if active != "0":
        raise RuntimeError("Database clients remain while writers are fenced")
    owner = prepare_backup_parent(parent)
    sizes = [int(temporary_run(["--network", "none", "--read-only", "--mount",
                                f"type=volume,source={volume},target=/source,readonly", "--entrypoint", "du",
                                db["Image"], "-sk", "/source"]).split()[0]) for volume in (volumes["orthanc"], state_volume) if volume]
    database_bytes = int(text(["docker", "exec", db_name, "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                               "SELECT pg_database_size('kin') + pg_database_size('keycloak');"]))
    if shutil.disk_usage(parent).free < 2 * (sum(sizes) * 1024 + database_bytes) + ready_free:
        raise RuntimeError("Insufficient free space for the capture and its restore margin")
    now = datetime.now(timezone.utc)
    directory = parent / (label + "-" + now.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    directory.mkdir(mode=0o700)
    manifest = {"format": 1, "kind": HELD_KIND, "shape": shape, "label": label, "complete": False,
                "restore_inventory": RESTORE_INVENTORY,
                "created_utc": now.isoformat(), "hold": {"writers_fenced": list(WRITER_ROLES), "resumed_by_capture": False},
                "git_sha": text(["git", "rev-parse", "HEAD"]),
                "git_dirty": bool(text(["git", "status", "--porcelain", "--untracked-files=no"])),
                "postgres_image": db["Image"], "orthanc_image": by_role["orthanc"]["Image"],
                "running_images": {ROLE_KEYS[role]: {"id": item["Image"], "configured": item["Config"].get("Image")}
                                   for role, item in by_role.items()},
                "resources": {"containers": dict(containers), "volumes": dict(volumes)}, "counts": {}}
    if shape == "post":
        manifest["emr"] = {"state_volume": state_volume, "tablespace": "kin_emr_access", "same_pause": True}
    write_json(directory / "manifest.json", manifest)
    started = time.monotonic()
    stage = "catalog"
    try:
        write_json(directory / "catalog.json", roles)
        write_json(directory / "migrations.json", migration_rows(db_name))
        stage = "projection"
        write_json(directory / "projection.json", projection(db_name))
        stage = "values"
        write_json(directory / "values.json", captured_values)
        if shape == "post":
            write_json(directory / "emr-catalog.json", emr_catalog(db_name, "kin"))
        with (directory / "cluster-roles.sql").open("wb") as handle:
            run(["docker", "exec", db_name, "pg_dumpall", "-U", "kin", "--encoding=UTF8", "--roles-only", "--no-role-passwords"], output=handle)
        for database in ("kin", "keycloak"):
            stage = "dump " + database
            manifest["counts"][database] = value_counts(captured_values)[database]
            with (directory / (database + ".dump")).open("wb") as handle:
                run(["docker", "exec", db_name, "pg_dump", "-U", "kin", "-d", database, "--encoding=UTF8", "-Fc", "--create"], output=handle)
        stage = "archive Orthanc"
        with (directory / "orthanc.tgz").open("wb") as handle:
            temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={volumes['orthanc']},target=/source,readonly",
                           "--entrypoint", "tar", db["Image"], "-czf", "-", "-C", "/source", "."], timeout=1800, output=handle)
        if shape == "post":
            stage = "archive EMR failure spool at the same pause"
            with (directory / "emr-state.tgz").open("wb") as handle:
                temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/source,readonly",
                               "--entrypoint", "tar", db["Image"], "-czf", "-", "-C", "/source", "."], timeout=1800, output=handle)
        stage = "copy configuration and metadata"
        capture_wrapping_custody(directory, manifest, db_name)
        for name in FILES[3:]:
            shutil.copyfile(ROOT / name, directory / name)
        for name, source in extra.items():
            shutil.copyfile(source, directory / name)
        volume_ids = {}
        for key, volume in sorted(volumes.items()):
            found = run(["docker", "volume", "inspect", volume], check=False)
            if found.returncode == 0:
                item = json.loads(found.stdout.decode("utf-8"))[0]
                volume_ids[key] = {"name": item["Name"], "created": item.get("CreatedAt"), "driver": item.get("Driver")}
        write_json(directory / "metadata.json", {"env_names": env_names(ROOT / ".env"), "volumes": volume_ids,
                                                  "config": sorted([*FILES[3:], *extra]), "facts": facts})
        components = held_components(manifest, extra)
        for name in components:
            path = directory / name
            path.chmod(0o600)
            if not path.stat().st_size:
                raise RuntimeError("Empty capture component")
        manifest["sha256"] = {name: digest(directory / name) for name in components}
        manifest["bytes"] = {name: (directory / name).stat().st_size for name in components}
        manifest["config"] = sorted(extra)
        manifest["complete"] = True
    except BaseException as error:
        manifest["backup_error"] = {"stage": stage, "type": type(error).__name__}
        raise
    finally:
        manifest["capture_seconds"] = round(time.monotonic() - started, 3)
        write_json(directory / "manifest.json", manifest)
        # IRT2-03: in the operating account's backup parent the capture is that account's, like its daily sets.
        give_to(directory, owner)
        print(json.dumps({"capture": str(directory), "shape": shape, "complete": manifest["complete"],
                          "backup_error": manifest.get("backup_error"), "writers_resumed": False}), flush=True)
    return directory


def held_components(manifest, extra=()):
    base = (*FILES, *HELD_EXTRA, *(EMR_FILES if manifest.get("shape") == "post" else ()))
    return tuple(dict.fromkeys((*base, *sorted(extra))))


def validate_held(directory, manifest_sha256=None):
    """A complete held capture: manifest (optionally its exact bytes), every component's checksum, safe archives."""
    directory = Path(directory).resolve(strict=True)
    raw = (directory / "manifest.json").read_bytes()
    if manifest_sha256 is not None and hashlib.sha256(raw).hexdigest() != manifest_sha256:
        raise RuntimeError("Held capture manifest differs from the recorded one")
    manifest = json.loads(raw.decode("utf-8"))
    if (manifest.get("format") != 1 or manifest.get("kind") != HELD_KIND or manifest.get("complete") is not True
            or manifest.get("restore_inventory") != RESTORE_INVENTORY
            or manifest.get("shape") not in ("pre", "post") or not HELD_NAME.fullmatch(directory.name)):
        raise RuntimeError("Held capture is incomplete or of an unknown form")
    components = held_components(manifest, manifest.get("config") or ())
    if set(manifest.get("sha256", {})) != set(components):
        raise RuntimeError("Held capture components differ from its shape")
    for name in components:
        path = directory / name
        if path.is_symlink() or not path.is_file() or digest(path) != manifest["sha256"][name]:
            raise RuntimeError("Held capture component checksum mismatch: " + name)
    catalog = supported_catalog(json.loads((directory / "catalog.json").read_text(encoding="utf-8")), shape=manifest["shape"])
    if type(catalog.get("objects")) is not dict or set(catalog["objects"]) != set(PRE_DATABASES):
        _unsupported("held DB inventory가 불완전합니다")
    for database in PRE_DATABASES:
        inventory_valid(catalog["objects"][database], database)
    values = values_valid(json.loads((directory / "values.json").read_text(encoding="utf-8")))
    if value_counts(values) != manifest["counts"]:
        _unsupported("held manifest의 건수가 구조화된 값 inventory와 다릅니다")
    for archive_name, index in (("orthanc.tgz", True), *((("emr-state.tgz", False),) if manifest["shape"] == "post" else ())):
        found_index = False
        with tarfile.open(directory / archive_name, "r|gz") as archive:
            for entry in archive:
                member = PurePosixPath(entry.name)
                if member.is_absolute() or ".." in member.parts or not (entry.isfile() or entry.isdir()):
                    raise RuntimeError("Unsafe archive entry: " + archive_name)
                found_index |= str(member) == "index" and entry.isfile()
        if index and not found_index:
            raise RuntimeError("Orthanc archive has no SQLite index")
    return directory, manifest, hashlib.sha256(raw).hexdigest()


# ── Rotation of the daily backup sets (D1047: the host kept every daily set) ──
DAILY_NAME = re.compile(r"\d{8}-\d{6}-[a-f0-9]{8}")   # the folders backup() creates; ops_monitor reads the same names
HOLD_FILE = "restore-hold.json"
THINNED_FILE = "thinned.json"
ROTATING = ".rotating-"
_rotation_ledger_lease = ContextVar("rotation_ledger_lease", default=None)
DAILY_GENERATIONS = 7   # D1047 (user, 2026-10-12): the last seven daily sets beside the release sets


def _retention_window(root, now):
    """Sets the audit ledger still keeps (ops_audit_integrity retention), and declared checkpoints it does not list."""
    import ops_audit_integrity as audit
    try:
        ledger = audit.read_ledger(root)
    except audit.LedgerMissing:
        return set(), set(audit.declared_folders(root))
    years = audit.ledger_years(ledger["entries"])
    kept = set()
    for entry in ledger["entries"]:
        if entry["kind"] == "seal":
            created = audit.parse_utc(entry["created_utc"])
            if now < max(audit.parse_utc(entry["retain_until"]), audit.years_after(created, years)):
                kept.add(entry["backup"])
    listed = {entry["backup"] for entry in ledger["entries"] if entry["kind"] == "seal"}
    return kept, {name for name in audit.declared_folders(root) if name not in listed}




def _rotation_link(path):
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def _rotation_identity(path, *, directory=True):
    if _rotation_link(path) or (not path.is_dir() if directory else not path.is_file()):
        raise RuntimeError("보존 경로의 종류 또는 링크가 바뀌었습니다: " + path.name)
    info = path.stat()
    if not directory and info.st_nlink != 1:
        raise RuntimeError("다른 경로에 연결된 보존 파일입니다: " + path.name)
    if os.name == "posix" and (info.st_uid != os.geteuid() or (directory and stat.S_IMODE(info.st_mode) & 0o077)):
        raise RuntimeError("보존 경로의 소유자 또는 접근 권한이 다릅니다: " + path.name)
    return info.st_dev, info.st_ino


def _rotation_root(root):
    root = Path(root).absolute()
    if not root.is_dir() or _rotation_link(root):
        raise RuntimeError("Backup root is not a directory / 백업 루트를 확인할 수 없습니다")
    if any(_rotation_link(parent) for parent in root.parents):
        raise RuntimeError("백업 루트의 상위 경로가 링크입니다")
    if os.name == "posix":
        for parent in root.parents:
            info = parent.stat()
            if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise RuntimeError("백업 루트의 상위 경로가 보호되지 않았습니다")
    root = root.resolve()
    if root == ROOT.resolve() or ROOT.resolve() in root.parents:
        raise RuntimeError("The backup root must be outside the Git repository / 저장소 밖 백업 루트가 필요합니다")
    _rotation_identity(root)
    return root


def _thin_marker(folder, manifest):
    """A marker describes a bound transition, never permission inferred from a filename's presence."""
    path = folder / THINNED_FILE
    if not path.exists() and not path.is_symlink():
        return None
    if not path.is_file() or _rotation_link(path) or path.stat().st_nlink != 1:
        raise ValueError("invalid thin marker path")
    marker = json.loads(path.read_text(encoding="utf-8"))
    name = folder.name.removeprefix(ROTATING)
    required = {"format", "state", "backup", "manifest_sha256", "archive_sha256", "archive_bytes", "at", "keep", "reason"}
    if (type(marker) is not dict or set(marker) != required or type(marker["format"]) is not int or marker["format"] != 1
            or marker["state"] not in ("THIN_PLANNED", "THINNED_COMPLETE") or marker["backup"] != name
            or not DAILY_NAME.fullmatch(name) or marker["manifest_sha256"] != digest(folder / "manifest.json")
            or marker["archive_sha256"] != manifest["sha256"].get("orthanc.tgz")
            or marker["archive_bytes"] != manifest["bytes"].get("orthanc.tgz")
            or type(marker["archive_bytes"]) is not int
            or type(marker["keep"]) is not int or not 1 <= marker["keep"] <= 365
            or marker["reason"] != "audit-retained beyond the kept daily generations"
            or type(marker["at"]) is not str or datetime.fromisoformat(marker["at"]).utcoffset() != timezone.utc.utcoffset(None)):
        raise ValueError("invalid thin marker transition")
    return marker


def _daily_whole(folder, *, completing_thin=False):
    """Verify every declared component. Only a valid completed thin transition permits the absent archive."""
    try:
        _rotation_identity(folder)
        _rotation_identity(folder / "manifest.json", directory=False)
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, RuntimeError):
        return "unreadable manifest or unsafe set"
    if (type(manifest) is not dict or type(manifest.get("format")) is not int or manifest.get("format") != 1
            or manifest.get("complete") is not True or manifest.get("kind")):
        return "manifest not complete daily backup"
    if "wrapping_custody" in manifest:
        try:
            wrapping_custody_files(manifest)
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            return "wrapping custody unavailable or differs from snapshot"
    sums, sizes = manifest.get("sha256"), manifest.get("bytes")
    if type(sums) is not dict or type(sizes) is not dict:
        return "manifest has no checksums"
    components = backup_components(manifest)
    required = (*components, AUDIT_CHECKPOINT) if AUDIT_CHECKPOINT in sums else components
    if set(sums) != set(required) or set(sizes) != set(required):
        return "component inventory differs"
    try:
        marker = _thin_marker(folder, manifest)
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        return "invalid thin marker"
    for name in required:
        path, expected = folder / name, sums.get(name)
        if type(expected) is not str or not re.fullmatch(r"[a-f0-9]{64}", expected) or type(sizes.get(name)) is not int or sizes[name] < 1:
            return "checksum missing: " + name
        if (name == "orthanc.tgz" and marker and (marker["state"] == "THINNED_COMPLETE" or completing_thin)
                and not path.exists() and not path.is_symlink()):
            continue
        if path.is_symlink() or not path.is_file():
            return "component missing: " + name
        try:
            _rotation_identity(path, directory=False)
            if path.stat().st_size != sizes[name] or digest(path) != expected:
                return "component differs: " + name
        except (OSError, RuntimeError):
            return "component unreadable: " + name
    # A rehearsal writes its own result next to the components. Unknown directories or links may hold unrelated data.
    allowed = {*required, "manifest.json", THINNED_FILE, HOLD_FILE}
    for entry in folder.iterdir():
        if (_rotation_link(entry) or not entry.is_file() or entry.stat().st_nlink != 1
                or (entry.name not in allowed and not re.fullmatch(r"rehearsal-[a-f0-9]{16}\.json", entry.name))):
            return "undeclared component: " + entry.name
    return None


def _rotation_plan(root, keep, protect, referenced, audit_kept, undeclared, *, focus=None):
    """Recompute complete daily generations; recheck renamed sets separately without counting them toward keep."""
    retained, incomplete, kept_leftovers, checked, entries, identities = {}, {}, {}, {}, {}, {}
    for item in sorted(root.iterdir(), key=lambda entry: entry.name):
        name = item.name.removeprefix(ROTATING)
        if not DAILY_NAME.fullmatch(name):
            continue
        if item.is_symlink() or not item.is_dir():
            raise RuntimeError("Invalid backup directory / 올바르지 않은 백업 경로: " + item.name)
        entries.setdefault(name, []).append(item)
    candidates = []
    for name, folders in sorted(entries.items(), reverse=True):
        for folder in folders:
            reason = _retention_reason(name, folder, protect, referenced, audit_kept, undeclared)
            if focus is not None and folder.name != focus and (len(candidates) >= keep or folder.name.startswith(ROTATING)):
                checked[folder.name] = "outside current generation verification"
                continue
            why = _daily_whole(folder)
            checked[folder.name] = why
            if why is None:
                identities[folder.name] = (_rotation_identity(folder), digest(folder / "manifest.json"))
            if len(folders) != 1:
                reason = "duplicate original and renamed generation"
            if why is not None:
                incomplete[folder.name] = why
                reason = reason or "incomplete"
            if reason:
                (kept_leftovers if folder.name.startswith(ROTATING) else retained)[folder.name] = reason
            if (len(folders) == 1 and why is None and not folder.name.startswith(ROTATING)
                    and (folder / "orthanc.tgz").is_file()):
                candidates.append(name)
    generations = sorted(candidates, reverse=True)[:keep]
    delete, thin, resume = [], [], []
    for name, folders in sorted(entries.items()):
        for folder in folders:
            if len(generations) < keep and checked[folder.name] is None:
                (kept_leftovers if folder.name.startswith(ROTATING) else retained).setdefault(folder.name, "insufficient complete generations")
                continue
            if name in generations or checked[folder.name] is not None or len(folders) != 1:
                if folder.name.startswith(ROTATING) and name in generations:
                    kept_leftovers.setdefault(folder.name, "kept generation")
                continue
            if folder.name not in kept_leftovers and retained.get(name) is None:
                try:
                    rotation_custody(folder, name)
                except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                    why = "wrapping custody rotation unavailable: " + type(error).__name__
                    incomplete[folder.name] = why
                    (kept_leftovers if folder.name.startswith(ROTATING) else retained)[folder.name] = why
                    continue
            if folder.name.startswith(ROTATING):
                if folder.name not in kept_leftovers:
                    resume.append(folder.name)
            elif retained.get(name) is None:
                delete.append(name)
            elif retained[name] == "audit-retention" and (folder / "orthanc.tgz").is_file():
                thin.append(name)
    return {"generations": generations, "delete": delete, "thin": thin, "resume": resume, "retained": retained,
            "incomplete": incomplete, "kept_leftovers": kept_leftovers, "identities": identities}


def rotation_custody(folder, name):
    """Only a snapshot's own separate key copy rotates; live keys and retained sets do not."""
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    if "wrapping_custody" not in manifest:
        return None
    config_path = os.environ.get("KIN_EMR_WRAPPING_CUSTODY") or WRAPPING_CUSTODY_CONFIG
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    root = Path(config["backup_root"])
    source, files = wrapping_custody_files(manifest)
    if (not root.is_absolute() or source.name != name or source.parent.resolve() != root.resolve()
            or source.resolve() == folder.resolve() or source.resolve() in folder.resolve().parents
            or folder.parent.resolve() == root.resolve() or folder.parent.resolve() in root.resolve().parents):
        raise RuntimeError("Wrapping custody is not this generation's separate configured copy")
    _rotation_identity(source)
    if {p.name for p in source.iterdir()} != {filename for filename, _ in files.values()}:
        raise RuntimeError("Wrapping custody contains unlisted files")
    for filename, _ in files.values():
        _rotation_identity(source / filename, directory=False)
    return source


def rotate(root, keep, protect=(), dry_run=False, now=None):
    """Plan and destructive transitions use the same current completeness/retention admission under one lease.

    The protected root, the shared operations lock and the root's audit ledger lock exclude cooperating writers (a
    backup, a rehearsal, a seal, a retention plan or init) during the last check and delete;
    this is not a defense against a concurrently malicious root user. Incomplete or changed sets remain in place.
    """
    if type(keep) is not int or not 1 <= keep <= 365:
        raise RuntimeError("Rotation keeps between 1 and 365 generations / 보존 세대는 1~365여야 합니다")
    root = _rotation_root(root)
    if not dry_run and _operations_lease.get() is None:
        with lock():
            return rotate(root, keep, protect, dry_run, now)
    if not dry_run and _rotation_ledger_lease.get() is None:
        # P3R1-01: the retention period is changed (ops_audit_integrity plan) under the backup root's ledger lock, not the
        # operations lock beside the tool (RT-P3-LEDGER-LOCK); the destructive part holds that ledger lock too, so a plan
        # never succeeds between its final retention decision and the rename/delete. Taken after the operations lock
        # (operations -> ledger, as the seal does), never waited for, never broken: a held one refuses and deletes nothing.
        import ops_audit_integrity as audit
        with audit.ledger_lock(root) as ledger_lease:
            context = _rotation_ledger_lease.set(ledger_lease)
            try:
                return rotate(root, keep, protect, dry_run, now)
            finally:
                _rotation_ledger_lease.reset(context)
    root_identity = _rotation_identity(root)
    instant = lambda: now or datetime.now(timezone.utc)
    def plan_now(*, focus=None):
        if _rotation_root(root) != root or _rotation_identity(root) != root_identity:
            raise RuntimeError("백업 루트의 신원이 바뀌었습니다")
        lease = _operations_lease.get()
        if not dry_run:
            if lease is None or lease.retained or _rotation_ledger_lease.get() is None:
                raise RuntimeError("삭제 작업 잠금을 확인할 수 없습니다")
            lease.verify()
            _rotation_ledger_lease.get().verify()
        return _rotation_plan(root, keep, set(protect), _referenced(root), *_retention_window(root, instant()), focus=focus)
    # Unlink and marker replacement are separate durable operations. If only replacement was interrupted, validate
    # the manifest-bound transition and every remaining byte before finishing its metadata; no archive is deleted.
    if not dry_run:
        for folder in sorted(root.iterdir()):
            if not DAILY_NAME.fullmatch(folder.name) or not (folder / THINNED_FILE).is_file() or (folder / "orthanc.tgz").exists():
                continue
            if _daily_whole(folder, completing_thin=True) is not None:
                continue
            manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            marker = _thin_marker(folder, manifest)
            if marker["state"] == "THIN_PLANNED":
                _operations_lease.get().verify()
                if _rotation_identity(root) != root_identity:
                    raise RuntimeError("thin 완료 기록 전 백업 루트가 바뀌었습니다")
                import ops_audit_integrity as audit
                audit.replace_json(folder / THINNED_FILE, {**marker, "state": "THINNED_COMPLETE"})
    plan = plan_now()
    result = {"root": str(root), "keep": keep, "dry_run": dry_run, "generations": plan["generations"],
              "retained": plan["retained"], "incomplete": plan["incomplete"], "kept_leftovers": plan["kept_leftovers"],
              "status": "preserved-stop" if plan["incomplete"] or plan["kept_leftovers"] else "complete", "stopped": {}}
    if dry_run:
        result.update(would_delete=plan["delete"], would_thin=plan["thin"], would_resume=plan["resume"])
        return result
    result.update(deleted=[], thinned=[], resumed=[], custody_deleted=[], custody_cleanup_pending=[])

    def admission(name, folder, action, identity, manifest_hash):
        try:
            if folder.parent != root or _rotation_identity(folder) != identity or digest(folder / "manifest.json") != manifest_hash:
                return "백업 세트 또는 manifest가 바뀌었습니다"
            why = _daily_whole(folder)
            if why:
                return "incomplete before " + ("thinning: " if action == "thin" else "deletion: ") + why
            if action != "thin":
                rotation_custody(folder, name)
            current = plan_now(focus=folder.name)
            key = folder.name if action == "resume" else name
            if key not in current[action]:
                return current["kept_leftovers"].get(folder.name) or current["retained"].get(name) or "현재 complete 세대의 keep 조건 또는 보호 조건이 바뀌었습니다"
        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
            return "삭제 직전 관측 실패: " + type(error).__name__
        return None

    def preserve(folder, reason):
        result["status"] = "preserved-stop"
        result["stopped"][folder.name] = reason
        result["kept_leftovers" if folder.name.startswith(ROTATING) else "retained"][folder.name] = reason

    def remove_generation(folder, name):
        custody = rotation_custody(folder, name)
        # Data goes first: a failed/interrupted archive removal must never destroy its recovery key.
        shutil.rmtree(folder)
        if custody is not None:
            try:
                shutil.rmtree(custody)
                result["custody_deleted"].append(str(custody))
            except OSError as error:
                result["status"] = "preserved-stop"
                result["custody_cleanup_pending"].append(str(custody))
                result["stopped"][name] = "Data removed; custody cleanup pending: " + type(error).__name__

    for action, names in (("delete", plan["delete"]), ("thin", plan["thin"]), ("resume", plan["resume"])):
        for selected in names:
            name, folder = selected.removeprefix(ROTATING), root / selected
            try:
                identity, manifest_hash = plan["identities"][folder.name]
            except (OSError, RuntimeError, KeyError):
                preserve(folder, "삭제 전 백업 세트를 확인할 수 없습니다")
                continue
            why = admission(name, folder, action, identity, manifest_hash)
            if why:
                preserve(folder, why)
                continue
            if action == "delete":
                moved = root / (ROTATING + name)
                if moved.exists() or moved.is_symlink():
                    preserve(folder, "중단된 동일 세대가 이미 존재합니다")
                    continue
                os.rename(folder, moved)
                why = admission(name, moved, "resume", identity, manifest_hash)
                if why:
                    preserve(moved, why)
                    continue
                remove_generation(moved, name)
                result["deleted"].append(name)
            elif action == "resume":
                # This is the same admission as the check immediately after a normal rename.
                remove_generation(folder, name)
                result["resumed"].append(selected)
            else:
                manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
                marker = {"format": 1, "state": "THIN_PLANNED", "backup": name, "manifest_sha256": manifest_hash,
                          "archive_sha256": manifest["sha256"]["orthanc.tgz"], "archive_bytes": manifest["bytes"]["orthanc.tgz"],
                          "at": instant().isoformat(), "keep": keep, "reason": "audit-retained beyond the kept daily generations"}
                import ops_audit_integrity as audit
                audit.replace_json(folder / THINNED_FILE, marker)
                why = admission(name, folder, "thin", identity, manifest_hash)
                if why:
                    preserve(folder, why)
                    continue
                (folder / "orthanc.tgz").unlink()
                marker["state"] = "THINNED_COMPLETE"
                audit.replace_json(folder / THINNED_FILE, marker)
                result["thinned"].append(name)
    return result


def _referenced(root):
    referenced = set()
    for path in root.glob("latest-verified-*.json"):
        try:
            _rotation_identity(path, directory=False)
            body = json.loads(path.read_text(encoding="utf-8"))
            value = body.get("backup")
            if type(value) is not str or not value or not Path(value).name or "\x00" in value:
                raise ValueError("missing backup reference")
            referenced.add(Path(value).name)
        except (OSError, ValueError, AttributeError, TypeError, RuntimeError):
            raise RuntimeError("Unreadable latest-verified record: " + path.name) from None
    return referenced


def _retention_reason(name, folder, protect, referenced, audit_kept, undeclared):
    """Why a set (by its original daily name, read in its actual folder) must stay, or None. A folder outside the daily
    namespace (an interrupted deletion) is also kept while it declares an audit checkpoint the ledger does not list."""
    reason = ("protected" if name in protect else "hold" if (folder / HOLD_FILE).exists() or (folder / HOLD_FILE).is_symlink()
              else "latest-verified" if name in referenced else "audit-retention" if name in audit_kept
              else "audit-undeclared" if name in undeclared else None)
    if reason is None and folder.name != name:
        import ops_audit_integrity as audit
        if audit.declared(folder) is not None:
            try:
                listed = {entry["backup"] for entry in audit.read_ledger(folder.parent)["entries"] if entry["kind"] == "seal"}
            except audit.LedgerMissing:
                listed = set()
            if name not in listed:
                reason = "audit-undeclared"
    return reason






def main():
    if hasattr(os, "umask"):
        os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    backup_parser = commands.add_parser("backup")
    backup_parser.add_argument("--output", required=True, help="Parent directory outside the repository")
    backup_parser.add_argument("--ready-timeout", type=int, default=120, help="Seconds to wait after resuming writers (1-900)")
    backup_parser.add_argument("--rotate-keep", type=int, default=DAILY_GENERATIONS,
                               help="After a complete, error-free backup, keep this many daily generations (1-365, default 7)")
    backup_parser.add_argument("--no-rotate", action="store_true", help="Leave the older daily sets as they are")
    rehearse_parser = commands.add_parser("rehearse")
    rehearse_parser.add_argument("directory")
    rehearse_parser.add_argument("--wrapping-source", help="Relocated separate custody directory for this snapshot")
    custody_parser = commands.add_parser("restore-wrapping")
    custody_parser.add_argument("directory", help="Database backup directory containing manifest.json")
    custody_parser.add_argument("--source", help="Relocated separate custody directory for this snapshot")
    custody_parser.add_argument("--destination", required=True, help="New directory outside the repository and database storage")
    rotate_parser = commands.add_parser("rotate")
    rotate_parser.add_argument("--root", required=True, help="The backup root holding the daily sets")
    rotate_parser.add_argument("--keep", type=int, default=DAILY_GENERATIONS)
    rotate_parser.add_argument("--protect", action="append", default=[], help="A set name never to delete")
    rotate_parser.add_argument("--dry-run", action="store_true", help="List what would be deleted; change nothing")
    args = parser.parse_args()
    if args.action == "restore-wrapping":
        directory = Path(args.directory).resolve(strict=True)
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if not manifest.get("complete"):
            raise RuntimeError("Backup is incomplete")
        destination = Path(args.destination).resolve()
        if any(destination == root or root in destination.parents for root in (ROOT.resolve(), directory.parent)):
            raise RuntimeError("Restore wrapping secrets outside the repository and database backup root")
        print(json.dumps({"files": restore_wrapping_custody(manifest, destination, source=args.source)}))
        return
    if args.action == "rotate":
        # Rotation reads and deletes host files only; it needs no Docker, but the lock keeps backup/rehearse out.
        # A dry-run performs no lock-file write either; it reports a current plan without authorizing deletion.
        result = rotate(args.root, args.keep, set(args.protect), args.dry_run)
        print(json.dumps(result), flush=True)
        if result["status"] != "complete":
            raise RuntimeError("불완전하거나 보호 조건이 바뀐 세트를 보존했습니다. 삭제 전 점검이 필요합니다")
        return
    require_local_docker()
    with lock():
        if args.action == "backup":
            if not 1 <= args.rotate_keep <= 365:
                raise RuntimeError("Rotation keeps between 1 and 365 generations")
            # backup() raises on any incomplete set, resume/readiness failure or backup_error: rotation follows only a
            # complete, error-free set, and never touches that set.
            directory = backup(args.output, args.ready_timeout)
            if not args.no_rotate:
                result = rotate(args.output, args.rotate_keep, {directory.name})
                print(json.dumps({"rotation": result}), flush=True)
                if result["status"] != "complete":
                    raise RuntimeError("백업은 보존했으나 rotation을 마치지 못했습니다. 보존된 세트를 점검하세요")
        else:
            rehearse(args.directory, wrapping_source=args.wrapping_source)



# A10 purpose/copy predicate, adapted to PostgreSQL (D1770/D1794). No timer
# deletes attempt keys while this installation or a restorable copy serves them.
RETENTION_CLASSES = {
    'RET-01': 'Access/auth facts: two civil years, plus actual duties/holds.',
    'RET-02': 'Record history: the linked record lifetime and access floor.',
    'RET-03': 'Pending attempts: resolve the real transaction; no timeout ending.',
    'RET-06': 'Attempt keys, outcomes and minimal receipts: retire the lineage only.',
    'RET-08': 'Native PG WAL/backup/temp: existing PostgreSQL recovery and backup rotation.',
    'RET-09': 'Failure facts: two years; duplicate spool: verified import and no recovery need.',
    'RET-10': 'Hold/disposal/review evidence: the actual duty or evidence purpose.',
    'RET-11': 'Backup/private restore: actual recovery purpose and existing rotation.',
    'RET-12': 'Synthetic test evidence: existing project evidence retention.',
}
COPY_MANIFEST_FIELDS = ('copy_id', 'location', 'custodian', 'installation_id', 'snapshot_sha256',
                        'source_images', 'data_classes', 'hold', 'restorable', 'dependent_copy_ids', 'disposition')
RETIREMENT_CONDITIONS = ('retired_from_service', 'obligations_ended_or_preserved',
                         'no_restorable_copy_remains', 'consumers_ended', 'disposition_receipt')
NOT_AN_ENDING = ('timeout', 'elapsed', 'no-response', 'silence')


def _required_text(value):
    if type(value) is not str or not value.strip():
        raise ValueError('Nonempty evidence reference required')
    return value


def copy_manifest(*, copy_id, location, custodian, manifest, installation_id, data_classes,
                  restorable, dependent_copies=(), hold=None, disposition=None):
    for value in (copy_id, location, custodian, installation_id):
        _required_text(value)
    if type(restorable) is not bool or type(manifest) is not dict or type(manifest.get('sha256')) is not dict:
        raise ValueError('Explicit copy status and native backup manifest required')
    classes = list(data_classes)
    if not classes or any(c not in RETENTION_CLASSES for c in classes):
        raise ValueError('Unknown retention class')
    if hold is not None:
        if type(hold) is not dict or set(hold) != {'basis', 'closure_evidence'}:
            raise ValueError('Hold basis and explicit closure status required')
        _required_text(hold['basis'])
        if hold['closure_evidence'] is not None:
            _required_text(hold['closure_evidence'])
    if disposition is not None:
        if type(disposition) is not dict or set(disposition) != {'action', 'verification'}:
            raise ValueError('Actual disposition and verification required')
        _required_text(disposition['action']); _required_text(disposition['verification'])
    dependencies = [_required_text(v) for v in dependent_copies]
    if len(set(dependencies)) != len(dependencies) or copy_id in dependencies:
        raise ValueError('Distinct dependent copies required')
    return dict(copy_id=copy_id, location=location, custodian=custodian, installation_id=installation_id,
                snapshot_sha256=dict(manifest['sha256']), source_images=manifest.get('running_images', {}),
                data_classes={c: RETENTION_CLASSES[c] for c in classes}, hold=hold,
                restorable=restorable, dependent_copy_ids=dependencies, disposition=disposition)


def retirement(lineage, evidence):
    """Report the A10 ending predicate; this does not erase a running database.

    Missing copy status, missing dependencies and booleans encoded as integers
    are incomplete evidence, never proof of retirement. Retired installations
    and all their copies use the existing operator disposal/rotation procedure.
    """
    _required_text(lineage)
    if type(evidence) is not dict or set(evidence) != set(RETIREMENT_CONDITIONS):
        raise ValueError('Exactly the five retirement conditions are required')
    unmet, why = [], {}
    for name in RETIREMENT_CONDITIONS:
        item = evidence[name]
        if type(item) is not dict or type(item.get('met')) is not bool:
            raise ValueError('Explicit boolean condition required: ' + name)
        _required_text(item.get('evidence'))
        reason = None if item['met'] else 'purpose continues'
        if name == 'consumers_ended':
            basis = item.get('basis')
            if type(basis) is not str or not basis.strip() or basis.strip().lower() in NOT_AN_ENDING:
                reason = 'actual consumer ending not established'
        if name == 'no_restorable_copy_remains':
            copies = item.get('copies')
            if type(copies) is not list or item.get('inventory_complete') is not True:
                reason = 'copy inventory incomplete'
            else:
                ids = set()
                for copy in copies:
                    if type(copy) is not dict or set(copy) != set(COPY_MANIFEST_FIELDS):
                        reason = 'copy manifest incomplete'; continue
                    if copy['installation_id'] != lineage or copy['copy_id'] in ids:
                        reason = 'copy lineage or identity differs'
                    ids.add(copy['copy_id'])
                    if type(copy['restorable']) is not bool or copy['restorable']:
                        reason = 'restorable or unknown copy remains'
                    disposition = copy['disposition']
                    if type(disposition) is not dict or not disposition.get('action') or not disposition.get('verification'):
                        reason = 'copy disposition unverified'
                    if copy['hold'] is not None and not copy['hold'].get('closure_evidence'):
                        reason = 'copy hold remains'
                for copy in copies:
                    if type(copy) is not dict or type(copy.get('dependent_copy_ids')) is not list or not set(copy['dependent_copy_ids']) <= ids:
                        reason = 'dependent copies missing'
        if reason:
            unmet.append(name); why[name] = reason
    return dict(lineage=lineage, retire=not unmet, unmet=unmet, why=why)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Operations failed: {error}", file=sys.stderr)
        sys.exit(1)
