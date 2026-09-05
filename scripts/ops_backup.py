"""Consistent KIN backup and isolated restore rehearsal; never restores over production.

Usage: python scripts/ops_backup.py backup --output <outside-repository-directory>
       python scripts/ops_backup.py rehearse <completed-backup-directory>
The running write services pause during backup and are resumed in finally.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
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


@contextmanager
def lock():
    path = ROOT / ".kin-ops.lock"
    token = uuid.uuid4().hex
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(token)
    try:
        yield
    finally:
        if path.read_text() != token:
            raise RuntimeError("Operations lock ownership changed")
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
    tables = text(command + ["SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;"]).splitlines()
    if not tables or any(not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name) for name in tables):
        raise RuntimeError("Unexpected or empty database table list")
    selects = [f'SELECT \'{name}\' AS name, count(*) AS n FROM "{name}"' for name in tables]
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
    initial_running = [name for name in CONTAINERS[:-1] if by_name[name]["State"]["Running"]]
    api_env = dict(entry.split("=", 1) for entry in by_name["kin-api"]["Config"].get("Env", []) if "=" in entry)
    origin = api_env.get("PUBLIC_ORIGIN", "https://localhost:9443").rstrip("/")
    prepare_backup_parent(parent)
    volume_kib = int(temporary_run(["--network", "none", "--read-only",
                                    "--mount", f"type=volume,source={volume},target=/source,readonly",
                                    "--entrypoint", "du", by_name["kin-db"]["Image"], "-sk", "/source"]).split()[0])
    database_bytes = int(text(["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                               "SELECT pg_database_size('kin') + pg_database_size('keycloak');"]))
    required = 2 * (volume_kib * 1024 + database_bytes) + 512 * 1024 * 1024
    if shutil.disk_usage(parent).free < required:
        raise RuntimeError("Insufficient free space for backup and restore margin")
    directory = parent / (datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    directory.mkdir(mode=0o700)
    manifest = {"format": 1, "complete": False, "created_utc": datetime.now(timezone.utc).isoformat(),
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
        for database in ("kin", "keycloak"):
            stage = "dump " + database
            manifest["counts"][database] = counts("kin-db", database, "kin")
            with (directory / (database + ".dump")).open("wb") as handle:
                run(["docker", "exec", "kin-db", "pg_dump", "-U", "kin", "-d", database, "-Fc"], output=handle)
        stage = "archive Orthanc"
        # The Docker helper runs as root on Linux. Stream to a host-owned file
        # instead of creating a root-owned archive in a writable host bind mount.
        with (directory / "orthanc.tgz").open("wb") as handle:
            temporary_run(["--network", "none", "--read-only",
                 "--mount", f"type=volume,source={volume},target=/source,readonly",
                 "--entrypoint", "tar", manifest["postgres_image"], "-czf", "-", "-C", "/source", "."],
                timeout=1800, output=handle)
        stage = "copy configuration and checksum"
        for name in FILES[3:]:
            shutil.copyfile(ROOT / name, directory / name)
        for name in FILES:
            path = directory / name
            path.chmod(0o600)
            if not path.stat().st_size:
                raise RuntimeError("Empty backup component")
        manifest["sha256"] = {name: digest(directory / name) for name in FILES}
        manifest["bytes"] = {name: (directory / name).stat().st_size for name in FILES}
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
        # Even an unsuccessful resume must identify a complete recovery snapshot.
        print(json.dumps({"backup": str(directory), "complete": manifest["complete"],
                          "ready": manifest["ready"], "resume_failures": resume_failures,
                          "pause_seconds": manifest["pause_seconds"]}), flush=True)
        if resume_failures:
            raise RuntimeError("Write services need recovery: " + ", ".join(resume_failures))
        if manifest["ready"] is False:
            raise RuntimeError("Backup preserved; application readiness needs recovery before deployment")


def validate_backup(directory):
    directory = Path(directory).resolve(strict=True)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") != 1 or not manifest.get("complete"):
        raise RuntimeError("Backup is incomplete")
    # Snapshot validity is independent of the source application's readiness.
    # A failed restart is exactly when an intact snapshot must remain usable.
    for name in FILES:
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
    for key in ("postgres_image", "orthanc_image"):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", manifest.get(key, "")):
            raise RuntimeError("Backup image ID is invalid")
        # Rehearse with the exact local images used for backup. No implicit latest pull.
        run(["docker", "image", "inspect", manifest[key]])
    return directory, manifest


def remove_owned(kind, name, token):
    if kind not in ("container", "volume") or not name.startswith("kin-rehearsal-"):
        raise RuntimeError("Refusing cleanup outside rehearsal resources")
    label = text(["docker", kind, "inspect", "--format", '{{index .Labels "kin.ops.run"}}' if kind == "volume"
                  else '{{index .Config.Labels "kin.ops.run"}}', name])
    if label != token:
        raise RuntimeError("Refusing cleanup of a resource owned by another run")
    command = ["docker", "volume", "rm", name] if kind == "volume" else ["docker", "rm", "-f", "-v", name]
    run(command)


def remove_owned_if_present(kind, name, token):
    found = run(["docker", kind, "inspect", name], check=False)
    if found.returncode == 0:
        remove_owned(kind, name, token)
    elif not any(message in found.stderr.decode("utf-8", errors="replace").lower()
                 for message in ("no such object", "no such container", "no such volume")):
        raise RuntimeError("Could not verify temporary resource cleanup")


def rehearse(directory):
    directory, manifest = validate_backup(directory)
    token = uuid.uuid4().hex
    name = "kin-rehearsal-" + token[:16]
    volume = name + "-orthanc"
    started = time.monotonic()
    result = {"backup": directory.name, "git_sha": manifest["git_sha"], "success": False}
    try:
        run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, volume])
        run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + token,
             "--network", "none", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", manifest["postgres_image"]])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            # The image's init server accepts Unix sockets before shutdown/restart.
            # TCP readiness excludes that temporary server and prevents restore races.
            if run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated PostgreSQL did not become ready")
        for database in ("kin", "keycloak"):
            run(["docker", "exec", name, "createdb", "-U", "postgres", database])
            with (directory / (database + ".dump")).open("rb") as handle:
                run(["docker", "exec", "-i", name, "pg_restore", "-U", "postgres", "-d", database,
                     "--no-owner", "--no-privileges", "--exit-on-error"], input_file=handle)
            if counts(name, database, "postgres") != manifest["counts"][database]:
                raise RuntimeError("Restored database row counts differ: " + database)
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


def main():
    if hasattr(os, "umask"):
        os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    backup_parser = commands.add_parser("backup")
    backup_parser.add_argument("--output", required=True, help="Parent directory outside the repository")
    backup_parser.add_argument("--ready-timeout", type=int, default=120, help="Seconds to wait after resuming writers (1-900)")
    commands.add_parser("rehearse").add_argument("directory")
    args = parser.parse_args()
    require_local_docker()
    with lock():
        if args.action == "backup":
            backup(args.output, args.ready_timeout)
        else:
            rehearse(args.directory)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Operations failed: {error}", file=sys.stderr)
        sys.exit(1)
