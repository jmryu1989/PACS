"""Consistent KIN backup and isolated restore rehearsal; never restores over production.

Usage: python scripts/ops_backup.py backup --output <outside-repository-directory> [--rotate-keep N | --no-rotate]
       python scripts/ops_backup.py rehearse <completed-backup-directory>
       python scripts/ops_backup.py rotate --root <backup-root> [--keep N] [--protect NAME ...] [--dry-run]
The running write services pause during backup and are resumed in finally. A complete backup's AuditLog rows are then
sealed into audit-checkpoint.json and the backup root's ledger (scripts/ops_audit_integrity.py; the root needs a one-time
`ops_audit_integrity.py init`), and rehearse verifies its restored copy against that seal.

The EMR-introduction release mode (scripts/ops_emr_introduction.py) uses capture_held() instead of backup(): it captures a
snapshot while the caller keeps every writer fenced and never resumes them itself (the release decides when they return).
After a complete, error-free backup the older daily sets rotate (D1047: keep 7): rotate() deletes complete daily sets
beyond the newest N, never a release, held, protected, latest-verified or incomplete set, and only thins (Orthanc archive
removed) a set the audit ledger still retains.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
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


def backup_components(manifest):
    return (*FILES, *EMR_FILES) if "emr" in manifest else FILES


def emr_catalog(container, user):
    """Owner, ACL, role attributes and placement are restore data, never inferred from row counts."""
    sql = """SELECT json_build_object(
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
        (SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl, t.spcname AS tablespace
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


def temporary_run(args, *, timeout=600, output=None):
    # A timed-out docker client can leave its container running. Give even tar
    # helpers an ownership label/name so finally can find and remove exactly it.
    token = uuid.uuid4().hex
    name = "kin-rehearsal-" + token[:16] + "-helper"
    try:
        result = run(["docker", "run", "--rm", "--name", name,
                      "--label", "kin.ops.run=" + token, *args], timeout=timeout, output=output)
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


@contextmanager
def lock():
    path = ROOT / ".kin-ops.lock"
    token = uuid.uuid4().hex
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
    lease = LockLease()
    try:
        yield lease
    finally:
        if path.read_text() != token:
            raise RuntimeError("Operations lock ownership changed")
        if not lease.retained:
            path.unlink()


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
    tables = text(command + ["SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname IN ('public','emr_access') ORDER BY schemaname,tablename;"]).splitlines()
    if not tables or any(not re.fullmatch(r"(?:public|emr_access)\.[A-Za-z_][A-Za-z_0-9]*", name) for name in tables):
        raise RuntimeError("Unexpected or empty database table list")
    selects = [f'SELECT \'{name}\' AS name, count(*) AS n FROM ' + '.'.join('"'+p+'"' for p in name.split('.')) for name in tables]
    return json.loads(text(command + ["SELECT json_object_agg(name,n) FROM (" + " UNION ALL ".join(selects) + ") counts;"]))


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
    if parent.exists():
        if not parent.is_dir():
            raise RuntimeError("Backup parent is not a directory")
        if os.name == "posix":
            info = parent.stat()
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise RuntimeError("Existing backup parent must be private and owned by the current user")
    else:
        # Never chmod an existing /tmp, home, mount or other shared directory.
        # A racing creator also fails here; only our new leaf receives mode 700.
        parent.mkdir(parents=True, mode=0o700)


def reload_proxy():
    # Static nginx upstreams keep the IP resolved at startup. Docker can assign
    # different IPs when all writers resume, so Up containers can still yield 502.
    run(["docker", "exec", "kin-proxy", "nginx", "-t"], timeout=30)
    run(["docker", "exec", "kin-proxy", "nginx", "-s", "reload"], timeout=30)


def seal_audit(directory, parent, manifest):
    """Stage 'seal audit': after the writers resumed, seal the AuditLog rows of this complete snapshot's kin.dump. The
    outcome goes to the manifest's existing backup_error ('audit integrity' for a finding, 'seal audit' for a failure),
    which the unchanged monitor reports as backup_failed; the snapshot stays complete and restorable either way. A
    failure that ended the verification carries its termination proof (cleanup), confirmed or not, into that record."""
    # Imported here: the audit tool builds on this module's Docker, digest and lock helpers.
    import ops_audit_integrity as audit
    try:
        audit.seal(directory, parent, manifest)
    except Exception as error:
        manifest["backup_error"] = {"stage": "seal audit", "type": type(error).__name__}
        if getattr(error, "cleanup", None) is not None:
            manifest["backup_error"]["cleanup"] = error.cleanup
        audit.replace_json(directory / "manifest.json", manifest)


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
    prepare_backup_parent(parent)
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
        with (directory / "cluster-roles.sql").open("wb") as handle:
            run(["docker", "exec", "kin-db", "pg_dumpall", "-U", "kin", "--roles-only", "--no-role-passwords"], output=handle)
        for database in ("kin", "keycloak"):
            stage = "dump " + database
            manifest["counts"][database] = counts("kin-db", database, "kin")
            with (directory / (database + ".dump")).open("wb") as handle:
                run(["docker", "exec", "kin-db", "pg_dump", "-U", "kin", "-d", database, "-Fc", "--create"], output=handle)
        stage = "archive Orthanc"
        # The Docker helper runs as root on Linux. Stream to a host-owned file
        # instead of creating a root-owned archive in a writable host bind mount.
        with (directory / "orthanc.tgz").open("wb") as handle:
            temporary_run(["--network", "none", "--read-only",
                 "--mount", f"type=volume,source={volume},target=/source,readonly",
                 "--entrypoint", "tar", manifest["postgres_image"], "-czf", "-", "-C", "/source", "."],
                timeout=1800, output=handle)
        stage = "archive EMR state at the same pause"
        with (directory / "emr-state.tgz").open("wb") as handle:
            temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/source,readonly",
                           "--entrypoint", "tar", manifest["postgres_image"], "-czf", "-", "-C", "/source", "."], timeout=1800, output=handle)
        stage = "copy configuration and checksum"
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
        write_json(directory / "manifest.json", manifest)
        # The seal reads only the snapshot, so it runs after the writers resumed (it never lengthens the pause) and
        # also when resume or readiness failed: a complete snapshot is sealed whenever it exists.
        if manifest["complete"]:
            seal_audit(directory, parent, manifest)
        # Even an unsuccessful resume must identify a complete recovery snapshot.
        print(json.dumps({"backup": str(directory), "complete": manifest["complete"],
                          "ready": manifest["ready"], "resume_failures": resume_failures,
                          "pause_seconds": manifest["pause_seconds"],
                          "backup_error": manifest.get("backup_error")}), flush=True)
        if resume_failures:
            raise RuntimeError("Write services need recovery: " + ", ".join(resume_failures))
        if manifest["ready"] is False:
            raise RuntimeError("Backup preserved; application readiness needs recovery before deployment")
    if manifest.get("backup_error"):
        raise RuntimeError("Backup preserved; audit " + manifest["backup_error"]["stage"] + " needs an operator: "
                           + manifest["backup_error"]["type"])
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
            raise RuntimeError("EMR database/state consistency is not attested")
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
    if kind not in ("container", "volume") or not name.startswith("kin-rehearsal-"):
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


def rehearse_audit(directory, manifest, container):
    """RA-4: the copy this rehearsal restored, not the snapshot file, is compared with the sealed checkpoint. The export
    of the restored kin (pg_dump in the rehearsal container) is judged in a new isolated verifier; nothing the restored
    server computes is trusted. Success is the verifier's exit 0: a past event recorded in the checkpoint is carried,
    a current guard or shape defect of the restored copy fails. Backups taken before sealing existed are not_sealed."""
    import ops_audit_integrity as audit
    if AUDIT_CHECKPOINT not in manifest.get("sha256", {}):
        return "not_sealed"
    code, report = audit.verify(directory / AUDIT_CHECKPOINT, audit.DatabaseExport(container, "kin", "postgres"))
    return {"verified": code == 0, **report}


def rehearse_held_pre(directory, manifest):
    """L-04c for a pre-EMR held capture (B0): restore it exactly as a rollback would, in a fresh networkless cluster of
    the product's shape (POSTGRES_USER kin), with its roles replayed and owners/privileges kept; then the whole catalog,
    the row counts, the per-table projection and the Orthanc index with every attachment."""
    token = uuid.uuid4().hex
    name = "kin-rehearsal-" + token[:16]
    volume = name + "-orthanc"
    started = time.monotonic()
    result = {"backup": directory.name, "git_sha": manifest["git_sha"], "success": False, "shape": "pre"}
    try:
        run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, volume])
        run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + token, "--network", "none",
             "-e", "POSTGRES_USER=kin", "-e", "POSTGRES_DB=kin", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", manifest["postgres_image"]])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            # TCP readiness excludes the image's socket-only init server (see rehearse()).
            if run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "kin"], check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated PostgreSQL did not become ready")
        result["catalog"] = restore_pre_snapshot(name, directory, "kin")
        for database in PRE_DATABASES:
            if counts(name, database, "kin") != manifest["counts"][database]:
                raise RuntimeError("Restored database row counts differ: " + database)
        before = json.loads((directory / "projection.json").read_text(encoding="utf-8"))
        if projection(name, columns={table: value["columns"] for table, value in before.items()}) != before:
            raise RuntimeError("Restored rows differ from the snapshot's projection")
        result["audit"] = rehearse_audit(directory, manifest, name)
        if result["audit"] != "not_sealed" and not result["audit"]["verified"]:
            raise RuntimeError("Restored AuditLog is not verified against its sealed checkpoint")
        temporary_run(["--network", "none", "--read-only",
                       "--mount", f"type=volume,source={volume},target=/restore",
                       "--mount", f"type=bind,source={directory},target=/backup,readonly",
                       "--entrypoint", "tar", manifest["postgres_image"], "-xzf", "/backup/orthanc.tgz", "-C", "/restore"], timeout=1800)
        orthanc = json.loads(temporary_run(["--network", "none", "--read-only",
                                            "--mount", f"type=volume,source={volume},target=/restore,readonly",
                                            "--entrypoint", "python3", manifest["orthanc_image"], "-c", SQLITE_CHECK], timeout=300))
        result.update(success=True, databases=list(PRE_DATABASES), orthanc=orthanc, projection="equal")
    finally:
        failures = []
        for kind, resource in (("container", name), ("volume", volume)):
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


def rehearse(directory):
    directory, manifest = validate_backup(directory)
    if manifest.get("kind") == HELD_KIND and manifest.get("shape") == "pre":
        return rehearse_held_pre(directory, manifest)
    token = uuid.uuid4().hex
    name = "kin-rehearsal-" + token[:16]
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
            recovery = """const {PrismaClient}=require('/app/node_modules/@prisma/client');
const {PrismaLedgerSql}=require('/app/dist/emr-runtime/store');
const {AccessSeal}=require('/app/dist/emr-runtime/seal');
const {FailureJournal}=require('/app/dist/emr-runtime/failure-journal');
const db=new PrismaClient(); const dir='/var/lib/kin-emr';
new AccessSeal(dir,new PrismaLedgerSql(db),new FailureJournal(dir)).recoverAtStart()
.then(()=>console.log('EMR_RESTORE_VERIFIED')).catch(()=>{process.exitCode=1}).finally(()=>db.$disconnect());"""
            # The optional reader login may correctly be disabled in the source catalog. Use the disposable restore
            # administrator for this read-only ledger check; do not alter the preserved source role attributes.
            checked = temporary_run(["--network", "container:"+name, "--read-only", "-e", "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/kin",
                "--mount", f"type=volume,source={state_volume},target={EMR_STATE}", "--entrypoint", "node", api_image, "-e", recovery])
            if checked != "EMR_RESTORE_VERIFIED":
                raise RuntimeError("Restored database and external state do not agree")
            result["emr"] = {"owner_acl_preserved": True, "database_state_verified": True}
        result["audit"] = rehearse_audit(directory, manifest, name)
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
HELD_EXTRA = ("cluster-roles.sql", "catalog.json", "migrations.json", "projection.json", "metadata.json")
EMR_ROLES = ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")
RESOURCE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
SQL_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,62}")   # quoted into SQL text: plain identifiers only
CONFIG_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")

# Fixed session settings first: a role's VALID UNTIL is a timestamp whose text must not depend on the session.
ROLE_CATALOG_SQL = """SET TimeZone='UTC'; SET DateStyle='ISO, YMD'; SELECT json_build_object(
  'roles', (SELECT coalesce(json_agg(r ORDER BY rolname), '[]'::json) FROM
    (SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolinherit,
            rolconnlimit, rolvaliduntil::text AS rolvaliduntil, rolconfig
     FROM pg_roles WHERE rolname !~ '^pg_') r),
  'memberships', (SELECT coalesce(json_agg(r ORDER BY granted, member), '[]'::json) FROM
    (SELECT a.rolname AS granted, b.rolname AS member, m.admin_option, m.inherit_option, m.set_option
     FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.roleid
     JOIN pg_roles b ON b.oid=m.member WHERE a.rolname !~ '^pg_' OR b.rolname !~ '^pg_') r),
  'databases', (SELECT coalesce(json_agg(r ORDER BY name), '[]'::json) FROM
    (SELECT datname AS name, pg_get_userbyid(datdba) AS owner, datacl::text AS acl FROM pg_database WHERE NOT datistemplate) r),
  'tablespaces', (SELECT coalesce(json_agg(r ORDER BY name), '[]'::json) FROM
    (SELECT spcname AS name, pg_get_userbyid(spcowner) AS owner, pg_tablespace_location(oid) AS location FROM pg_tablespace) r),
  'schemas', (SELECT coalesce(json_agg(nspname::text ORDER BY nspname), '[]'::json) FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'))"""
# Per database: owners and privileges of every schema, relation, function and default privilege outside the system
# schemas (what pg_restore with owners and privileges must reproduce, compared after a restore, never inferred).
OBJECT_CATALOG_SQL = """SELECT json_build_object(
  'schemas', (SELECT coalesce(json_agg(r ORDER BY name), '[]'::json) FROM
    (SELECT nspname::text AS name, pg_get_userbyid(nspowner) AS owner, nspacl::text AS acl FROM pg_namespace
     WHERE nspname !~ '^pg_' AND nspname <> 'information_schema') r),
  'relations', (SELECT coalesce(json_agg(r ORDER BY name), '[]'::json) FROM
    (SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) r),
  'functions', (SELECT coalesce(json_agg(r ORDER BY name), '[]'::json) FROM
    (SELECT p.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') r),
  'default_acl', (SELECT coalesce(json_agg(r ORDER BY owner, scope, kind), '[]'::json) FROM
    (SELECT pg_get_userbyid(d.defaclrole) AS owner, coalesce(n.nspname, '') AS scope, d.defaclobjtype::text AS kind, d.defaclacl::text AS acl
     FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace) r))"""
PRE_DATABASES = ("kin", "keycloak")
DEFAULT_TABLESPACES = ("pg_default", "pg_global")
MIGRATIONS_SQL = """SELECT coalesce(json_agg(json_build_array(migration_name, checksum, finished_at IS NOT NULL,
  rolled_back_at IS NOT NULL) ORDER BY migration_name COLLATE "C"), '[]'::json) FROM "_prisma_migrations\""""
# Fixed output settings: a projection must not change because a session's display defaults differ.
PROJECTION_SETTINGS = ("SET TimeZone='UTC'; SET DateStyle='ISO, YMD'; SET IntervalStyle='postgres'; "
                       "SET extra_float_digits=1; SET bytea_output='hex'; ")


def psql_json(container, database, sql, user="kin", timeout=300):
    return json.loads(text(["docker", "exec", container, "psql", "-X", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1",
                            "-qAt", "-c", sql], timeout=timeout))


def role_catalog(container, user="kin"):
    """Cluster roles, memberships, database owners, tablespaces and schemas: what pg_dump never carries."""
    return psql_json(container, "kin", ROLE_CATALOG_SQL, user)


def object_catalog(container, database, user="kin"):
    return psql_json(container, database, OBJECT_CATALOG_SQL, user)


def cluster_catalog(container, user="kin"):
    """What a held capture records as catalog.json and a restore must reproduce exactly: the cluster's roles,
    memberships, databases, tablespaces and kin's schemas, and the owners/privileges of both databases' objects."""
    catalog = role_catalog(container, user)
    catalog["objects"] = {database: object_catalog(container, database, user) for database in PRE_DATABASES}
    return catalog


def _unsupported(message):
    raise RuntimeError("Unsupported pre-EMR catalog: " + message)


def supported_pre_catalog(catalog):
    """A pre-EMR cluster this tool can rebuild exactly in a fresh cluster, or a refusal before anything changes.

    Supported: the installer superuser kin (the image's POSTGRES_USER, LOGIN), any number of further NOLOGIN roles
    (their attributes, connection limit and validity are replayed exactly; no password exists to carry), memberships
    among them (and predefined pg_* roles), the databases kin and keycloak (plus the image's postgres), and only the
    default tablespaces. Refused: a further LOGIN role (its password is never captured, so a restore could not
    reproduce it), per-role settings, another database or tablespace, a name that is not a plain identifier."""
    if type(catalog) is not dict:
        _unsupported("unreadable")
    roles = {}
    for role in catalog.get("roles") or []:
        name = role.get("rolname")
        if type(name) is not str or not SQL_NAME.fullmatch(name):
            _unsupported("a role name is not a plain identifier")
        roles[name] = role
    installer = roles.get("kin")
    if not installer or installer.get("rolsuper") is not True or installer.get("rolcanlogin") is not True:
        _unsupported("the installer superuser kin is missing")
    for name, role in roles.items():
        if any(key not in role for key in ("rolsuper", "rolcreaterole", "rolcreatedb", "rolcanlogin", "rolreplication",
                                           "rolbypassrls", "rolinherit", "rolconnlimit", "rolvaliduntil", "rolconfig")):
            _unsupported("role attributes are incomplete")
        if role.get("rolconfig"):
            _unsupported("a role carries its own settings")
        if name != "kin" and role.get("rolcanlogin") is not False:
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
    databases = {item.get("name"): item for item in catalog.get("databases") or []}
    if not set(PRE_DATABASES) <= set(databases) or not set(databases) <= {*PRE_DATABASES, "postgres"}:
        _unsupported("the databases are not exactly kin and keycloak")
    if any(databases[name].get("owner") != "kin" for name in databases if name != "keycloak") or databases["keycloak"].get("owner") not in roles:
        _unsupported("a database owner differs")
    if any(space.get("name") not in DEFAULT_TABLESPACES for space in catalog.get("tablespaces") or []):
        _unsupported("a further tablespace exists")
    return catalog


def _sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def replay_roles(container, source, user="kin"):
    """Rebuild a supported snapshot's roles and memberships in a fresh cluster (no passwords: every replayed role is
    NOLOGIN), then prove the cluster now has exactly the snapshot's roles and memberships."""
    supported_pre_catalog(source)
    fresh = role_catalog(container, user)
    present = {role["rolname"]: role for role in fresh["roles"]}
    statements = []
    for role in source["roles"]:
        name = role["rolname"]
        if name in present:
            if present[name] != role:
                raise RuntimeError("A role of the fresh cluster differs from the snapshot: " + name)
            continue
        flags = [("" if role["rolsuper"] else "NO") + "SUPERUSER", ("" if role["rolcreaterole"] else "NO") + "CREATEROLE",
                 ("" if role["rolcreatedb"] else "NO") + "CREATEDB", ("" if role["rolcanlogin"] else "NO") + "LOGIN",
                 ("" if role["rolreplication"] else "NO") + "REPLICATION", ("" if role["rolbypassrls"] else "NO") + "BYPASSRLS",
                 ("" if role["rolinherit"] else "NO") + "INHERIT", "CONNECTION LIMIT %d" % role["rolconnlimit"]]
        if role["rolvaliduntil"] is not None:
            flags.append("VALID UNTIL " + _sql_literal(role["rolvaliduntil"]))
        statements.append('CREATE ROLE "%s" WITH %s;' % (name, " ".join(flags)))
    granted = {(item["granted"], item["member"]) for item in fresh["memberships"]}
    for item in source["memberships"]:
        if (item["granted"], item["member"]) not in granted:
            statements.append('GRANT "%s" TO "%s" WITH ADMIN %s, INHERIT %s, SET %s;' % (
                item["granted"], item["member"], *("TRUE" if item[key] else "FALSE" for key in ("admin_option", "inherit_option", "set_option"))))
    if statements:
        import tempfile
        with tempfile.TemporaryFile() as handle:
            handle.write(("SET TimeZone='UTC';\nBEGIN;\n" + "\n".join(statements) + "\nCOMMIT;\n").encode("utf-8"))
            handle.flush()
            handle.seek(0)
            run(["docker", "exec", "-i", container, "psql", "-X", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"],
                input_file=handle)
    after = role_catalog(container, user)
    if after["roles"] != source["roles"] or after["memberships"] != source["memberships"]:
        raise RuntimeError("Replayed roles or memberships differ from the snapshot")
    return {"created": [line.split('"')[1] for line in statements if line.startswith("CREATE ROLE")],
            "granted": sum(1 for line in statements if line.startswith("GRANT"))}


def restore_pre_snapshot(container, directory, user="kin"):
    """A pre-EMR snapshot into a fresh product-shaped cluster (the image created kin as POSTGRES_USER/POSTGRES_DB):
    its roles replayed, the image's empty kin database replaced, kin and keycloak restored with --create (database
    owners, privileges and settings included), never with --no-owner/--no-privileges; then the cluster's whole catalog
    (roles, memberships, databases, tablespaces, schemas, every object's owner and privileges) equals the snapshot's."""
    directory = Path(directory)
    source = json.loads((directory / "catalog.json").read_text(encoding="utf-8"))
    replayed = replay_roles(container, source, user)
    probe = ["docker", "exec", container, "psql", "-X", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c"]
    fresh = text(probe + ["SELECT (SELECT count(*) FROM pg_database WHERE datname='keycloak') || ':' || "
                          "(SELECT count(*) FROM pg_database WHERE datname='kin');"])
    tables = text(["docker", "exec", container, "psql", "-X", "-U", user, "-d", "kin", "-v", "ON_ERROR_STOP=1", "-qAt", "-c",
                   "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';"])
    if fresh != "0:1" or tables != "0":
        raise RuntimeError("The restore target is not a fresh cluster")
    run(probe + ["DROP DATABASE kin WITH (FORCE);"])
    for database in PRE_DATABASES:
        with (directory / (database + ".dump")).open("rb") as handle:
            run(["docker", "exec", "-i", container, "pg_restore", "-U", user, "-d", "postgres", "--create", "--exit-on-error"],
                input_file=handle, timeout=1800)
    restored = cluster_catalog(container, user)
    if restored != source:
        differing = sorted(key for key in set(restored) | set(source) if restored.get(key) != source.get(key))
        raise RuntimeError("Restored catalog differs from the snapshot: " + ",".join(differing))
    return {"roles_created": replayed["created"], "memberships_granted": replayed["granted"], "catalog": "equal"}


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
        if not SQL_NAME.fullmatch(table) or not names or any(not SQL_NAME.fullmatch(name) for name in names):
            raise RuntimeError("Unexpected table or column name")
        row = "ROW(" + ", ".join('"' + name + '"' for name in names) + ")::text"
        selects.append(f"SELECT '{table}' AS name, (SELECT json_build_array(count(*), encode(sha256(convert_to("
                       f"coalesce(string_agg(r, E'\\n' ORDER BY r COLLATE \"C\"), ''), 'UTF8')), 'hex')) FROM "
                       f"(SELECT {row} AS r FROM public.\"{table}\") s) AS d")
    result = psql_json(container, database, PROJECTION_SETTINGS + "SELECT json_object_agg(name, d) FROM ("
                       + " UNION ALL ".join(selects) + ") x", user)
    return {table: {"columns": list(names), "count": result[table][0], "sha256": result[table][1]}
            for table, names in columns.items()}


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
    active = text(["docker", "exec", db_name, "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                   "SELECT count(*) FROM pg_stat_activity WHERE datname IN ('kin','keycloak') "
                   "AND backend_type='client backend' AND pid<>pg_backend_pid();"])
    if active != "0":
        raise RuntimeError("Database clients remain while writers are fenced")
    prepare_backup_parent(parent)
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
        write_json(directory / "catalog.json", dict(roles, objects={database: object_catalog(db_name, database) for database in PRE_DATABASES}))
        write_json(directory / "migrations.json", migration_rows(db_name))
        stage = "projection"
        write_json(directory / "projection.json", projection(db_name))
        if shape == "post":
            write_json(directory / "emr-catalog.json", emr_catalog(db_name, "kin"))
        with (directory / "cluster-roles.sql").open("wb") as handle:
            run(["docker", "exec", db_name, "pg_dumpall", "-U", "kin", "--roles-only", "--no-role-passwords"], output=handle)
        for database in ("kin", "keycloak"):
            stage = "dump " + database
            manifest["counts"][database] = counts(db_name, database, "kin")
            with (directory / (database + ".dump")).open("wb") as handle:
                run(["docker", "exec", db_name, "pg_dump", "-U", "kin", "-d", database, "-Fc", "--create"], output=handle)
        stage = "archive Orthanc"
        with (directory / "orthanc.tgz").open("wb") as handle:
            temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={volumes['orthanc']},target=/source,readonly",
                           "--entrypoint", "tar", db["Image"], "-czf", "-", "-C", "/source", "."], timeout=1800, output=handle)
        if shape == "post":
            stage = "archive EMR state at the same pause"
            with (directory / "emr-state.tgz").open("wb") as handle:
                temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/source,readonly",
                               "--entrypoint", "tar", db["Image"], "-czf", "-", "-C", "/source", "."], timeout=1800, output=handle)
        stage = "copy configuration and metadata"
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
            or manifest.get("shape") not in ("pre", "post") or not HELD_NAME.fullmatch(directory.name)):
        raise RuntimeError("Held capture is incomplete or of an unknown form")
    components = held_components(manifest, manifest.get("config") or ())
    if set(manifest.get("sha256", {})) != set(components):
        raise RuntimeError("Held capture components differ from its shape")
    for name in components:
        path = directory / name
        if path.is_symlink() or not path.is_file() or digest(path) != manifest["sha256"][name]:
            raise RuntimeError("Held capture component checksum mismatch: " + name)
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


def rotate(root, keep, protect=(), dry_run=False, now=None):
    """Keep the newest `keep` physically whole daily sets; delete only older whole daily sets that nothing else retains.

    Whole: a complete manifest whose every declared component exists with its recorded size and SHA-256 (_daily_whole);
    an incomplete set is neither counted as a generation nor deleted. Never deleted: any name that is not a daily set
    (s4-/s5-/stage/release/held captures, logs, latest-verified-*.json), the protected names (the set just written), a
    set with restore-hold.json, a set named by latest-verified-*.json, a set the audit ledger still retains or a declared
    checkpoint it does not list. A deletion first renames the set out of the daily namespace, so a reader never sees half
    a set; an interrupted one (.rotating-<name>) is re-judged by its original name and its folder and stays in place when
    anything protects it. A set beyond the kept generations that only the audit ledger retains is thinned instead: its
    Orthanc archive is removed after a thinned.json marker, everything the ledger's retention reads stays. dry_run lists
    exactly the plan a run executes; the run re-checks each set right before it acts. The caller holds the operations
    lock (no backup or rehearsal runs meanwhile)."""
    if type(keep) is not int or not 1 <= keep <= 365:
        raise RuntimeError("Rotation keeps between 1 and 365 generations")
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("Backup root is not a directory")
    root = root.resolve()
    if root == ROOT or ROOT in root.parents:
        raise RuntimeError("The backup root must be outside the Git repository")
    if os.name == "posix":
        info = root.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError("Backup root must be private and owned by the current user")
    now = now or datetime.now(timezone.utc)
    audit_kept, undeclared = _retention_window(root, now)
    referenced = _referenced(root)
    plan = _rotation_plan(root, keep, set(protect), referenced, audit_kept, undeclared)
    result = {"root": str(root), "keep": keep, "dry_run": dry_run, "generations": plan["generations"], "retained": plan["retained"],
              "incomplete": plan["incomplete"], "kept_leftovers": plan["kept_leftovers"]}
    if dry_run:
        # The run below executes exactly this plan (and re-checks each set right before it acts on it).
        result.update(would_delete=plan["delete"], would_thin=plan["thin"], would_resume=plan["resume"])
        return result
    result.update(deleted=[], thinned=[], resumed=[])

    def still_free(name, folder):
        """Right before acting: the original name and the actual folder are re-judged (a new hold, protect, record or
        ledger entry since the plan keeps the set)."""
        return _retention_reason(name, folder, set(protect), _referenced(root), *_retention_window(root, now)) is None

    for name in plan["delete"]:
        source = root / name
        if source.is_symlink() or not source.is_dir() or not still_free(name, source):
            result["retained"][name] = "changed before deletion"
            continue
        moved = root / (ROTATING + name)
        os.rename(source, moved)
        if not still_free(name, moved):
            # A hold arrived between the plan and the rename: the set stays (outside the daily namespace) for an operator.
            result["kept_leftovers"][moved.name] = "hold or reference arrived during rotation"
            continue
        shutil.rmtree(moved)
        result["deleted"].append(name)
    for name in plan["thin"]:
        source = root / name
        archive = source / "orthanc.tgz"
        if (source.is_symlink() or not source.is_dir() or archive.is_symlink() or not archive.is_file()
                or _retention_reason(name, source, set(protect), _referenced(root), *_retention_window(root, now)) != "audit-retention"):
            result["retained"][name] = "changed before thinning"
            continue
        # The marker comes first: a reader (or validate_backup, which then refuses the set) never takes a thinned set
        # for a restorable one, and an interrupted thinning finishes on the next run.
        write_json(source / THINNED_FILE, {"removed": ["orthanc.tgz"], "at": now.isoformat(), "keep": keep,
                                           "reason": "audit-retained beyond the kept daily generations"})
        archive.unlink()
        result["thinned"].append(name)
    for leftover in plan["resume"]:
        folder = root / leftover
        if folder.is_symlink() or not folder.is_dir() or not still_free(leftover[len(ROTATING):], folder):
            result["kept_leftovers"][leftover] = "hold or reference arrived during rotation"
            continue
        shutil.rmtree(folder)
        result["resumed"].append(leftover)
    return result


def _referenced(root):
    referenced = set()
    for path in root.glob("latest-verified-*.json"):
        try:
            referenced.add(Path(json.loads(path.read_text(encoding="utf-8")).get("backup", "")).name)
        except (OSError, ValueError, AttributeError):
            raise RuntimeError("Unreadable latest-verified record: " + path.name) from None
    return referenced


def _retention_reason(name, folder, protect, referenced, audit_kept, undeclared):
    """Why a set (by its original daily name, read in its actual folder) must stay, or None."""
    return ("protected" if name in protect else "hold" if (folder / HOLD_FILE).exists() or (folder / HOLD_FILE).is_symlink()
            else "latest-verified" if name in referenced else "audit-retention" if name in audit_kept
            else "audit-undeclared" if name in undeclared else None)


def _daily_whole(folder):
    """None when the set is physically whole, else why not: manifest format 1 and complete, and every component its
    manifest declares (the six files, the EMR files of an EMR set, a declared audit checkpoint) is a regular file with
    its recorded size and SHA-256. A thinned set lacks only its Orthanc archive."""
    try:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "unreadable manifest"
    if type(manifest) is not dict or manifest.get("format") != 1 or manifest.get("complete") is not True:
        return "manifest not complete"
    sums, sizes = manifest.get("sha256"), manifest.get("bytes")
    if type(sums) is not dict or type(sizes) is not dict:
        return "manifest has no checksums"
    components = backup_components(manifest)
    required = (*components, AUDIT_CHECKPOINT) if AUDIT_CHECKPOINT in sums else components
    thinned = (folder / THINNED_FILE).is_file()
    for name in required:
        if thinned and name == "orthanc.tgz":
            continue
        path = folder / name
        expected = sums.get(name)
        if type(expected) is not str or not re.fullmatch(r"[a-f0-9]{64}", expected) or type(sizes.get(name)) is not int:
            return "checksum missing: " + name
        if path.is_symlink() or not path.is_file():
            return "component missing: " + name
        if path.stat().st_size != sizes[name] or digest(path) != expected:
            return "component differs: " + name
    return None


def _rotation_plan(root, keep, protect, referenced, audit_kept, undeclared):
    """The one decision both dry-run and run use. Generations: the newest `keep` physically whole, unthinned daily sets.
    Older whole sets that nothing retains are deleted; ones only the audit ledger retains are thinned; an incomplete set
    is neither counted nor deleted. An interrupted deletion (.rotating-<name>) resumes only when its original name and
    its folder are free of every protection; otherwise it stays where it is."""
    retained, incomplete, kept_leftovers = {}, {}, {}
    daily = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        if not DAILY_NAME.fullmatch(entry.name):
            continue
        if entry.is_symlink() or not entry.is_dir():
            raise RuntimeError("Invalid backup directory: " + entry.name)
        daily.append(entry.name)
        reason = _retention_reason(entry.name, entry, protect, referenced, audit_kept, undeclared)
        if reason:
            retained[entry.name] = reason
    generations, older = [], []
    checked = {}
    for name in sorted(daily, reverse=True):
        thinned = (root / name / THINNED_FILE).is_file()
        if len(generations) < keep and not thinned:
            checked[name] = _daily_whole(root / name)
            if checked[name] is None:
                generations.append(name)
                continue
        older.append(name)
    delete, thin = [], []
    for name in sorted(older):
        if name in generations:
            continue
        reason = retained.get(name)
        if reason not in (None, "audit-retention"):
            continue
        why = checked[name] if name in checked else _daily_whole(root / name)
        if why is not None:
            incomplete[name] = why
            retained.setdefault(name, "incomplete")
            continue
        if reason is None:
            delete.append(name)
        elif (root / name / "orthanc.tgz").exists():
            # Only the audit ledger still needs this set: its Orthanc archive goes (also finishing an interrupted thinning).
            thin.append(name)
    for name, why in checked.items():
        if why is not None:
            incomplete[name] = why
            retained.setdefault(name, "incomplete")
    resume = []
    for item in sorted(root.iterdir(), key=lambda entry: entry.name):
        if not item.name.startswith(ROTATING) or not DAILY_NAME.fullmatch(item.name[len(ROTATING):]):
            continue
        if item.is_symlink() or not item.is_dir():
            raise RuntimeError("Invalid interrupted rotation entry: " + item.name)
        reason = _retention_reason(item.name[len(ROTATING):], item, protect, referenced, audit_kept, undeclared)
        if reason:
            kept_leftovers[item.name] = reason
        else:
            resume.append(item.name)
    return {"generations": generations, "delete": delete, "thin": thin, "resume": resume, "retained": retained,
            "incomplete": incomplete, "kept_leftovers": kept_leftovers}


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
    commands.add_parser("rehearse").add_argument("directory")
    rotate_parser = commands.add_parser("rotate")
    rotate_parser.add_argument("--root", required=True, help="The backup root holding the daily sets")
    rotate_parser.add_argument("--keep", type=int, default=DAILY_GENERATIONS)
    rotate_parser.add_argument("--protect", action="append", default=[], help="A set name never to delete")
    rotate_parser.add_argument("--dry-run", action="store_true", help="List what would be deleted; change nothing")
    args = parser.parse_args()
    if args.action == "rotate":
        # Rotation reads and deletes host files only; it needs no Docker, but the lock keeps backup/rehearse out.
        with lock():
            print(json.dumps(rotate(args.root, args.keep, set(args.protect), args.dry_run)))
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
                print(json.dumps({"rotation": rotate(args.output, args.rotate_keep, {directory.name})}), flush=True)
        else:
            rehearse(args.directory)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Operations failed: {error}", file=sys.stderr)
        sys.exit(1)
