"""Sealed AuditLog checkpoints kept with the backups, their append-only ledger, verification of an export in an isolated
verifier, and the retention check (S7-AUDIT-STORE; D281 OP-2 (i), OP-3 (a); D288 OP-5 (a)).

Usage: python scripts/ops_audit_integrity.py init <backup-root> [--years N]
       python scripts/ops_audit_integrity.py init <backup-root> --after-loss --reason TEXT [--years N]
       python scripts/ops_audit_integrity.py plan <backup-root> --years N
       python scripts/ops_audit_integrity.py verify --backup <backup-directory> [--checkpoint FILE]
       python scripts/ops_audit_integrity.py verify --container NAME --database DB --user ROLE --checkpoint FILE
       python scripts/ops_audit_integrity.py retention <backup-root> [--as-of UTC] [--max-age HOURS]
The seal runs inside `ops_backup.py backup` over the dump taken while the writers were stopped; there is no standalone seal
of a live database. verify and retention print one JSON line and exit 0 (verified), 1 (integrity failure) or 2 (input
error: neither a pass nor an integrity claim). Every verdict value is computed from an export inside a new networkless
PostgreSQL container started from a recorded image; nothing the exporting server computes or returns is trusted. Row
content never leaves that container: checkpoints, the ledger and reports carry ids, digests, counts and folder names.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid

import ops_backup as ops
from ops_monitor import BACKUP_AGE

CHECKPOINT = ops.AUDIT_CHECKPOINT
LEDGER = "audit-ledger.json"
FORMAT = 1
TABLE = "AuditLog"
COLUMNS = ("id", "at", "actor", "action", "target", "detail")
# The sealed columns as api/prisma/migrations/0_init/migration.sql creates them: (type, NOT NULL).
COLUMN_TYPES = {"id": ["integer", True], "at": ["timestamp(3) without time zone", True], "actor": ["text", True],
                "action": ["text", True], "target": ["text", True], "detail": ["text", False]}
MIN_YEARS = 2          # FACT-S7-RETENTION (D195): at least two years; an institution's plan may only raise it
REPORTED_IDS = 100
BACKUP_NAME = re.compile(r"\d{8}-\d{6}-[a-f0-9]{8}")   # the folders ops_backup creates and ops_monitor reads
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")
NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}")

# Runs inside the isolated verifier. The export arrives on stdin and stays in the container. The rows database receives
# only the public AuditLog TABLE and TABLE DATA entries of the export's table of contents (no function, trigger, rule,
# view, default or extension of the exporting server), and its digests are read before the schema database exists; the
# schema database then holds the export's whole schema for the guard probe and the shape check.
VERIFIER_SCRIPT = r"""set -eu
cat > /tmp/audit-export.dump
pg_restore --list /tmp/audit-export.dump > /tmp/audit-toc.list
grep -E '^[0-9]+; [0-9]+ [0-9]+ (TABLE|TABLE DATA) public AuditLog [^ ]+$' /tmp/audit-toc.list > /tmp/audit-rows.list || true
createdb -U postgres audit_rows
if [ -s /tmp/audit-rows.list ]; then
  pg_restore -U postgres -d audit_rows -L /tmp/audit-rows.list --no-owner --no-privileges --exit-on-error /tmp/audit-export.dump
fi
psql -X -q -A -t -U postgres -d audit_rows -v ON_ERROR_STOP=1 -f - <<'AUDIT_ROWS_SQL'
SELECT pg_catalog.to_regclass('public."AuditLog"') IS NOT NULL AS present \gset
\if :present
SELECT pg_catalog.json_build_object('table', true,
  'relkind', (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = 'public."AuditLog"'::pg_catalog.regclass),
  'columns', (SELECT pg_catalog.json_object_agg(a.attname, pg_catalog.json_build_array(
                pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull))
              FROM pg_catalog.pg_attribute a
              WHERE a.attrelid = 'public."AuditLog"'::pg_catalog.regclass AND a.attnum > 0 AND NOT a.attisdropped));
SELECT (j -> 'id')::text, pg_catalog.count(*),
  CASE WHEN pg_catalog.count(*) = 1 THEN pg_catalog.min(d)
       ELSE 'dup' || pg_catalog.count(*) || '-' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.string_agg(d, ',' ORDER BY d), 'UTF8')), 'hex') END
FROM (SELECT j, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
        j -> 'id', j -> 'at', j -> 'actor', j -> 'action', j -> 'target', j -> 'detail')::text, 'UTF8')), 'hex') AS d
      FROM (SELECT pg_catalog.to_jsonb(t) AS j FROM public."AuditLog" t) s) r
GROUP BY (j -> 'id')::text;
\else
SELECT pg_catalog.json_build_object('table', false);
\endif
AUDIT_ROWS_SQL
createdb -U postgres audit_schema
pg_restore -U postgres -d audit_schema --schema-only --no-owner --no-privileges --exit-on-error /tmp/audit-export.dump
psql -X -q -A -t -U postgres -d audit_schema -v ON_ERROR_STOP=1 -f - <<'AUDIT_SCHEMA_SQL'
CREATE TEMP TABLE audit_probe (statement text PRIMARY KEY, outcome text NOT NULL);
DO $probe$
DECLARE
  kind "char" := (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass('public."AuditLog"'));
BEGIN
  IF kind IS DISTINCT FROM 'r' THEN RETURN; END IF;
  BEGIN
    INSERT INTO public."AuditLog" (id, at, actor, action, target, detail)
      VALUES (-1, TIMESTAMP '2000-01-01 00:00:00', 'probe', 'probe', 'probe', 'probe');
    INSERT INTO pg_temp.audit_probe VALUES ('insert', 'accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO pg_temp.audit_probe VALUES ('insert', 'error ' || SQLSTATE);
    RETURN;
  END;
  BEGIN
    UPDATE public."AuditLog" SET detail = 'probe changed' WHERE id = -1;
    INSERT INTO pg_temp.audit_probe VALUES ('update', 'accepted');
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO pg_temp.audit_probe VALUES ('update', 'refused');
            WHEN OTHERS THEN INSERT INTO pg_temp.audit_probe VALUES ('update', 'error ' || SQLSTATE);
  END;
  BEGIN
    DELETE FROM public."AuditLog" WHERE id = -1;
    INSERT INTO pg_temp.audit_probe VALUES ('delete', 'accepted');
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO pg_temp.audit_probe VALUES ('delete', 'refused');
            WHEN OTHERS THEN INSERT INTO pg_temp.audit_probe VALUES ('delete', 'error ' || SQLSTATE);
  END;
  BEGIN
    TRUNCATE public."AuditLog";
    INSERT INTO pg_temp.audit_probe VALUES ('truncate', 'accepted');
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO pg_temp.audit_probe VALUES ('truncate', 'refused');
            WHEN OTHERS THEN INSERT INTO pg_temp.audit_probe VALUES ('truncate', 'error ' || SQLSTATE);
  END;
END
$probe$;
SELECT pg_catalog.json_build_object(
  'relkind', (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass('public."AuditLog"')),
  'inherits', (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits i
               WHERE i.inhrelid = pg_catalog.to_regclass('public."AuditLog"')
                  OR i.inhparent = pg_catalog.to_regclass('public."AuditLog"')),
  'shadows', (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = 'AuditLog' AND n.nspname <> 'public'),
  'probe', (SELECT pg_catalog.json_object_agg(statement, outcome) FROM pg_temp.audit_probe));
AUDIT_SCHEMA_SQL
"""


class InputError(Exception):
    """Exit 2: the inputs could not be judged. Never a pass and never an integrity claim."""


class LedgerMissing(Exception):
    """No ledger in the backup root: the tool never starts one by itself (explicit init only)."""


class LedgerInvalid(Exception):
    pass


class LedgerChanged(Exception):
    """The ledger changed between reading and appending; nothing was written."""


class Refused(Exception):
    pass


@dataclass(frozen=True)
class SnapshotDump:
    """A backup's kin.dump, taken while the writers were stopped, with its manifest digest and the recorded image."""
    path: Path
    sha256: str
    image: str


@dataclass(frozen=True)
class DatabaseExport:
    """A named database whose pg_dump (a read-only transaction) is the export; the verifier uses that container's image."""
    container: str
    database: str
    user: str


@dataclass
class Evaluation:
    """What the isolated verifier read from one export. rows is the digest stream, one (id, rows with that id, digest)
    per id in any order; an id held by n > 1 rows carries a 'dup<n>-...' digest and a duplicate_id shape finding."""
    table: bool
    rows: list = field(default_factory=list)
    guard: dict = field(default_factory=dict)
    schema: list = field(default_factory=list)


def index(evaluation):
    """The digest stream as id -> digest and id -> row count; a repeated id or a malformed item is an input error."""
    digests, counts = {}, {}
    for item in evaluation.rows:
        identity, count, digest = item if isinstance(item, (list, tuple)) and len(item) == 3 else (None, None, None)
        if type(identity) is not int or type(count) is not int or count < 1 or not isinstance(digest, str) \
                or identity in digests:
            raise InputError("The verifier stream repeats an id or is malformed")
        digests[identity], counts[identity] = digest, count
    return digests, counts


def utc_now():
    return datetime.now(timezone.utc)


def parse_utc(value):
    moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if moment.tzinfo is None:
        raise ValueError("Timezone required")
    return moment.astimezone(timezone.utc)


def years_after(moment, years):
    """The same UTC month, day and time N years later; 29 February becomes 1 March (never earlier than the anniversary).
    A fixed day count is not used: 730 days after 2026-09-30 is 2028-09-29, a day short of two years."""
    try:
        return moment.replace(year=moment.year + years)
    except ValueError:
        return moment.replace(year=moment.year + years, month=3, day=1)


def sha256_file(path):
    return ops.digest(path)


def report_ids(ids):
    ids = sorted(ids)
    return {"count": len(ids), "ids": ids[:REPORTED_IDS]}


# ── files: 0600, never through a symlink, replaced atomically ──

def fsync_directory(directory):
    if os.name == "posix":
        handle = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(handle)
        finally:
            os.close(handle)


def replace_json(path, body):
    """Write body to a new 0600 file beside path, fsync it, then replace path and fsync the directory."""
    path = Path(path)
    if path.is_symlink() or path.parent.is_symlink():
        raise Refused("Symlinked output refused")
    handle, name = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            os.chmod(name, 0o600)
            stream.write(json.dumps(body, ensure_ascii=False, indent=1) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        fsync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise FileNotFoundError(path.name)
    return json.loads(path.read_text(encoding="utf-8"))


def checked_root(root):
    root = Path(root)
    if root.is_symlink():
        raise Refused("Symlinked backup root refused")
    root = root.resolve()
    if root == ops.ROOT or ops.ROOT in root.parents:
        raise Refused("The backup root must be outside the Git repository")
    if not root.is_dir():
        raise Refused("Backup root is not a directory")
    return root


# ── the ledger: which backups were sealed, and the latest endpoint ──

def read_ledger(root):
    path = Path(root) / LEDGER
    if not path.exists() and not path.is_symlink():
        raise LedgerMissing("No audit ledger in the backup root")
    try:
        body = read_json(path)
    except (OSError, ValueError) as error:
        raise LedgerInvalid("Unreadable audit ledger") from error
    entries = body.get("entries") if isinstance(body, dict) else None
    if (not isinstance(body, dict) or body.get("format") != FORMAT or not isinstance(body.get("ledger_id"), str)
            or not isinstance(entries, list) or not entries):
        raise LedgerInvalid("Unknown audit ledger form")
    seq = 0
    for position, entry in enumerate(entries):
        kind = entry.get("kind") if isinstance(entry, dict) else None
        if kind in ("init", "reinit_after_loss", "plan"):
            # the first entry starts the ledger (init or reinit_after_loss); later ones may only raise the plan
            if (position == 0) == (kind == "plan") or type(entry.get("years")) is not int \
                    or not isinstance(entry.get("at"), str):
                raise LedgerInvalid("Unknown audit ledger entry")
        elif kind == "seal" and position:
            seq += 1
            valid = (entry.get("seq") == seq and BACKUP_NAME.fullmatch(str(entry.get("backup", "")))
                     and all(isinstance(entry.get(key), str) for key in ("checkpoint_sha256", "created_utc", "retain_until"))
                     and isinstance(entry.get("previous_verification"), dict)
                     and isinstance(entry["previous_verification"].get("state"), str))
            if not valid:
                raise LedgerInvalid("Audit ledger seals are not a continuous sequence")
        else:
            raise LedgerInvalid("Unknown audit ledger entry")
    return body


def ledger_years(entries):
    return max(int(entry["years"]) for entry in entries if entry["kind"] in ("init", "reinit_after_loss", "plan"))


def append_ledger(root, ledger, new_entries):
    """Append under the caller's operations lock. The whole file is re-read first and must equal what the caller read:
    entries are never removed or rewritten, and a ledger that changed meanwhile is not written."""
    if read_ledger(root) != ledger:
        raise LedgerChanged("The audit ledger changed while it was being extended")
    replace_json(Path(root) / LEDGER, {**ledger, "entries": ledger["entries"] + list(new_entries)})


def declared(folder):
    """The folder's manifest and its declared checkpoint digest, or None when the folder declares no checkpoint."""
    try:
        manifest = read_json(folder / "manifest.json")
    except (OSError, ValueError):
        return None
    digest = manifest.get("sha256", {}).get(CHECKPOINT) if isinstance(manifest, dict) else None
    return (manifest, digest) if isinstance(digest, str) else None


def declared_folders(root):
    return sorted(entry.name for entry in Path(root).iterdir()
                  if BACKUP_NAME.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink() and declared(entry))


def link_of(entry):
    return None if entry is None else {"backup": entry["backup"], "sha256": entry["checkpoint_sha256"], "seq": entry["seq"]}


def pending_checkpoints(root, ledger, latest, exclude=None):
    """Folders newer than the ledger's latest seal that declare a checkpoint the ledger does not list (a seal that
    stopped after its manifest declaration), oldest first, as (created, name, declared digest, checkpoint or None).
    A checkpoint that cannot be read is kept (None) so that it breaks recovery instead of being skipped."""
    listed = {entry["backup"] for entry in ledger["entries"] if entry["kind"] == "seal"}
    since = parse_utc(latest["created_utc"]) if latest else None
    found = []
    for name in declared_folders(root):
        if name in listed or name == exclude:
            continue
        manifest, digest = declared(Path(root) / name)
        try:
            created = parse_utc(manifest["created_utc"])
        except (KeyError, TypeError, ValueError):
            continue
        try:
            body, _ = load_checkpoint(Path(root) / name / CHECKPOINT)
        except InputError:
            body = None
        if body is not None and body["ledger_id"] != ledger["ledger_id"]:
            continue   # a checkpoint of another ledger (before a re-initialisation) is not this ledger's endpoint
        if since is None or created > since:
            found.append((created, name, digest, body))
    return sorted(found, key=lambda item: (item[0], item[1]))


def init(root, years, after_loss=False, reason=None, now=None):
    root = checked_root(root)
    path = root / LEDGER
    if path.exists() or path.is_symlink():
        raise Refused("An audit ledger already exists; it is never replaced")
    if not isinstance(years, int) or years < MIN_YEARS:
        raise Refused("Retention must be at least two years")
    found = declared_folders(root)
    at = (now or utc_now()).isoformat()
    if after_loss:
        if not reason or not reason.strip():
            raise Refused("A re-initialisation after loss needs a reason")
        first = {"kind": "reinit_after_loss", "at": at, "years": years, "reason": reason.strip(), "found": found}
    elif found:
        raise Refused("Sealed backups exist without a ledger: use --after-loss with a reason")
    else:
        first = {"kind": "init", "at": at, "years": years}
    body = {"format": FORMAT, "ledger_id": uuid.uuid4().hex, "entries": [first]}
    replace_json(path, body)
    return body


def plan(root, years, now=None):
    root = checked_root(root)
    ledger = read_ledger(root)
    if not isinstance(years, int) or years <= ledger_years(ledger["entries"]):
        raise Refused("The retention plan can only be raised")
    append_ledger(root, ledger, [{"kind": "plan", "at": (now or utc_now()).isoformat(), "years": years}])
    return years


# ── the isolated verifier ──

def _pump(chunks, args, output, timeout):
    """Feed chunks to a command's stdin; stdout goes to output and stderr to a file (a full pipe cannot stall the pump).
    Returns the exit code and the SHA-256 of exactly the bytes sent."""
    sha = hashlib.sha256()
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, cwd=ops.ROOT, stdin=subprocess.PIPE, stdout=output, stderr=errors)
        try:
            try:
                for chunk in chunks:
                    sha.update(chunk)
                    process.stdin.write(chunk)
            except BrokenPipeError:
                pass
            finally:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
            code = process.wait(timeout=timeout)
        except BaseException:
            process.kill()
            process.wait()
            raise
    return code, sha.hexdigest()


def _file_chunks(path):
    with open(path, "rb") as handle:
        yield from iter(lambda: handle.read(1024 * 1024), b"")


def _load_export(source, name, output, timeout):
    command = ["docker", "exec", "-i", name, "sh", "-c", VERIFIER_SCRIPT]
    if isinstance(source, SnapshotDump):
        code, sent = _pump(_file_chunks(source.path), command, output, timeout)
        if sent != source.sha256:
            raise InputError("The export differs from its manifest digest")
    else:
        with tempfile.TemporaryFile() as errors:
            producer = subprocess.Popen(["docker", "exec", source.container, "pg_dump", "-U", source.user,
                                         "-d", source.database, "-Fc"],
                                        cwd=ops.ROOT, stdout=subprocess.PIPE, stderr=errors)
            try:
                code, _ = _pump(iter(lambda: producer.stdout.read(1024 * 1024), b""), command, output, timeout)
            finally:
                producer.stdout.close()
                exported = producer.wait()
        if exported:
            raise InputError("The target database could not be exported")
    if code:
        raise InputError("The isolated verifier could not restore the export")


def _read_output(output):
    output.seek(0)
    lines = [line for line in output.read().decode("utf-8").splitlines() if line.strip()]
    if len(lines) < 2:
        raise InputError("The isolated verifier returned no result")
    return json.loads(lines[0]), lines[1:-1], json.loads(lines[-1])


def _judge(shape, digests, schema_view):
    findings = set()
    evaluation = Evaluation(table=bool(shape.get("table")))
    if not evaluation.table or shape.get("relkind") != "r":
        findings.add("not_a_table")
    columns = shape.get("columns") or {}
    if evaluation.table and any(columns.get(name) != expected for name, expected in COLUMN_TYPES.items()):
        findings.add("column_type")
    for line in digests:
        key, count, digest = line.rsplit("|", 2)
        try:
            identity = json.loads(key) if key else None
        except ValueError:
            identity = None
        if type(identity) is not int or not count.isdigit():
            findings.add("column_type")   # an id that is not an integer cannot be the sealed key
            continue
        evaluation.rows.append((identity, int(count), digest))
        if int(count) > 1:
            findings.add("duplicate_id")   # 0_init's primary key is gone from the export
    if schema_view.get("relkind") != "r":
        findings.add("not_a_table")
    if schema_view.get("inherits"):
        findings.add("inheritance")
    if schema_view.get("shadows"):
        findings.add("shadow_relation")
    probe = schema_view.get("probe") or {}
    present = probe.get("insert") == "accepted" and all(probe.get(s) == "refused" for s in ("update", "delete", "truncate"))
    evaluation.guard = {"state": "present" if present else "ineffective", "statements": probe}
    evaluation.schema = sorted(findings)
    return evaluation


def evaluate(source, timeout=3600):
    """The isolated verifier (scenario §1 I), the one place verdict values are computed: a new PostgreSQL container from
    the recorded image with no network, owned by label and removed at the end, reading only the export. The exporting
    server (the live database, or rehearse's restored copy) takes no part in any computation."""
    try:
        if isinstance(source, SnapshotDump):
            image = source.image
        else:
            if not all(NAME.fullmatch(value) for value in (source.container, source.database, source.user)):
                raise InputError("Invalid target name")
            image = ops.text(["docker", "inspect", "--format", "{{.Image}}", source.container])
        if not IMAGE_ID.fullmatch(image or ""):
            raise InputError("The verifier image must be a recorded image ID")
        ops.run(["docker", "image", "inspect", image])
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        raise InputError("The verifier image or target is unavailable") from error
    token = uuid.uuid4().hex
    name = "kin-rehearsal-" + token[:16] + "-audit"
    failure = None
    try:
        ops.run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + token,
                 "--network", "none", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image])
        deadline = time.monotonic() + 90
        while ops.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                      check=False).returncode:
            if time.monotonic() > deadline:
                raise InputError("The isolated verifier did not become ready")
            time.sleep(0.5)
        with tempfile.TemporaryFile() as output:
            _load_export(source, name, output, timeout)
            shape, digests, schema_view = _read_output(output)
        return _judge(shape, digests, schema_view)
    except InputError as error:
        failure = error
        raise
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        failure = InputError("The isolated verifier failed")
        raise failure from error
    finally:
        try:
            ops.remove_owned_if_present("container", name, token)
        except Exception as error:
            if failure is None:
                raise InputError("The isolated verifier could not be removed") from error


# ── checkpoints and verification ──

def load_checkpoint(path):
    try:
        raw = Path(path).read_bytes()
        body = json.loads(raw)
    except (OSError, ValueError) as error:
        raise InputError("Unreadable checkpoint") from error
    rows = body.get("rows") if isinstance(body, dict) else None
    if (not isinstance(body, dict) or body.get("format") != FORMAT or body.get("table") != TABLE
            or body.get("columns") != list(COLUMNS) or not isinstance(rows, list)
            or not isinstance(body.get("ledger_id"), str) or type(body.get("count")) is not int
            or not all(isinstance(body.get(key), str) for key in ("created_utc", "retain_until"))
            or not isinstance(body.get("previous_verification"), dict)
            or not isinstance(body["previous_verification"].get("state"), str)
            or not isinstance(body.get("guard"), dict) or not isinstance(body.get("schema"), list)
            or not (body.get("previous") is None or isinstance(body.get("previous"), dict))):
        raise InputError("Unknown checkpoint format")
    last = None
    for row in rows:
        if (not isinstance(row, list) or len(row) != 2 or type(row[0]) is not int or not isinstance(row[1], str)
                or (last is not None and row[0] <= last)):
            raise InputError("Checkpoint rows are not strictly ordered (id, digest) pairs")
        last = row[0]
    if body.get("through_id") != last:
        raise InputError("Checkpoint endpoint does not match its rows")
    return body, hashlib.sha256(raw).hexdigest()


def compare(checkpoint, evaluation):
    """Sealed ids S against the export's ids up to the checkpoint's endpoint: changed, deleted, inserted and the number of
    rows after the endpoint (outside the seal)."""
    digests, counts = index(evaluation)
    through = checkpoint["through_id"]
    sealed = dict((row[0], row[1]) for row in checkpoint["rows"])
    current = {key: value for key, value in digests.items() if through is not None and key <= through}
    changed = [key for key in sealed.keys() & current.keys() if sealed[key] != current[key]]
    tail = sum(count for key, count in counts.items() if through is None or key > through)
    return sorted(changed), sorted(sealed.keys() - current.keys()), sorted(current.keys() - sealed.keys()), tail


def verify(checkpoint_path, source):
    """V(K, E): exit 0 only when no sealed row changed, disappeared or was inserted and the export's own guard is present
    with no shape finding. The checkpoint's previous_verification is a past event and is only carried in the report."""
    try:
        checkpoint, _ = load_checkpoint(checkpoint_path)
        evaluation = evaluate(source)
        changed, deleted, inserted, tail = compare(checkpoint, evaluation)
    except InputError as error:
        return 2, {"exit": 2, "error": str(error)}
    passed = not (changed or deleted or inserted or evaluation.schema) and evaluation.guard.get("state") == "present"
    code = 0 if passed else 1
    return code, {"exit": code, "through_id": checkpoint["through_id"], "sealed": len(checkpoint["rows"]),
                  "changed": report_ids(changed), "deleted": report_ids(deleted), "inserted": report_ids(inserted),
                  "tail": tail, "guard": evaluation.guard, "schema": evaluation.schema,
                  "previous_verification": checkpoint.get("previous_verification")}


def snapshot_source(directory, manifest):
    """A backup's kin.dump as the export. Its bytes are checked against the manifest here and again while they stream
    into the verifier, so a dump replaced in between is not judged."""
    path = Path(directory) / "kin.dump"
    expected = manifest["sha256"]["kin.dump"]
    if path.is_symlink() or not path.is_file() or sha256_file(path) != expected:
        raise InputError("The export differs from its manifest digest")
    return SnapshotDump(path, expected, manifest["postgres_image"])


def verify_backup(directory, checkpoint=None):
    directory = Path(directory)
    try:
        manifest = read_json(directory / "manifest.json")
        declared_digest = manifest.get("sha256", {}).get(CHECKPOINT)
        source = snapshot_source(directory, manifest)
    except (OSError, ValueError, KeyError, AttributeError, TypeError):
        return 2, {"exit": 2, "error": "Unreadable backup manifest"}
    except InputError as error:
        return 2, {"exit": 2, "error": str(error)}
    if checkpoint is None:
        checkpoint = directory / CHECKPOINT
        if not isinstance(declared_digest, str) or not checkpoint.is_file() or sha256_file(checkpoint) != declared_digest:
            return 2, {"exit": 2, "error": "The backup declares no intact checkpoint"}
    return verify(checkpoint, source)


def previous_verification(root, latest, evaluation):
    """Compare the new rows with the ledger's latest sealed checkpoint, file to file (no database)."""
    folder = Path(root) / latest["backup"]
    path = folder / CHECKPOINT
    if not folder.is_dir() or folder.is_symlink() or not path.is_file():
        return {"state": "unverifiable", "reason": "previous_missing"}
    if sha256_file(path) != latest["checkpoint_sha256"]:
        return {"state": "failed", "reason": "previous_changed"}
    try:
        previous, _ = load_checkpoint(path)
    except InputError:
        return {"state": "unverifiable", "reason": "previous_unreadable"}
    changed, deleted, inserted, _ = compare(previous, evaluation)
    if changed or deleted or inserted:
        return {"state": "failed", "reason": "sealed_rows_differ", "changed": report_ids(changed),
                "deleted": report_ids(deleted), "inserted": report_ids(inserted)}
    return {"state": "verified"}


def seal_entry(name, digest, checkpoint, latest, recovered):
    return {"kind": "seal", "seq": latest["seq"] + 1 if latest else 1, "backup": name, "checkpoint_sha256": digest,
            "through_id": checkpoint["through_id"], "count": checkpoint["count"],
            "created_utc": checkpoint["created_utc"], "retain_until": checkpoint["retain_until"],
            "previous_seq": latest["seq"] if latest else None,
            "previous_verification": {key: value for key, value in checkpoint["previous_verification"].items()
                                      if key in ("state", "reason")},
            "recovered": recovered}


def alarm_of(checkpoint):
    """The manifest backup_error type for what this seal found, current defects first; None when nothing was found."""
    if checkpoint["guard"].get("state") != "present":
        return "AuditGuardIneffective"
    if checkpoint["schema"]:
        return "AuditSchemaFinding"
    state = checkpoint["previous_verification"]["state"]
    return {"failed": "AuditIntegrityMismatch", "unverifiable": "AuditPreviousUnverifiable"}.get(state)


def seal(directory, root, manifest):
    """Seal a complete backup's AuditLog (stage 'seal audit' of ops_backup.backup, which holds the operations lock and
    calls this after the writers resumed). The digests come from the snapshot's kin.dump in the isolated verifier; the
    live database is never contacted. Commit order: checkpoint file -> manifest declaration (with backup_error
    'audit integrity' when a finding is recorded) -> ledger seal. Returns the alarm type or None; failures raise and the
    caller records them as backup_error 'seal audit'."""
    directory, root = Path(directory), Path(root)
    target = directory / CHECKPOINT
    if directory.is_symlink() or target.exists() or target.is_symlink():
        raise Refused("The backup already holds a checkpoint")
    ledger = read_ledger(root)
    years = ledger_years(ledger["entries"])
    seals = [entry for entry in ledger["entries"] if entry["kind"] == "seal"]
    latest = seals[-1] if seals else None
    recovered, broken = [], False
    for _, name, digest, body in pending_checkpoints(root, ledger, latest, exclude=directory.name):
        if (broken or body is None or body["previous"] != link_of(latest)
                or sha256_file(root / name / CHECKPOINT) != digest):
            broken = True
            continue
        latest = seal_entry(name, digest, body, latest, True)
        recovered.append(latest)
    evaluation = evaluate(snapshot_source(directory, manifest))
    digests, counts = index(evaluation)
    if broken:
        previous = {"state": "unverifiable", "reason": "uncommitted_checkpoint"}
    elif latest is None:
        previous = {"state": "none"}
    else:
        previous = previous_verification(root, latest, evaluation)
    rows = sorted(digests.items())
    created = parse_utc(manifest["created_utc"])
    checkpoint = {"format": FORMAT, "ledger_id": ledger["ledger_id"], "table": TABLE, "columns": list(COLUMNS),
                  "through_id": rows[-1][0] if rows else None, "count": sum(counts.values()),
                  "rows": [[key, value] for key, value in rows], "previous": link_of(latest),
                  "previous_verification": previous, "guard": evaluation.guard, "schema": evaluation.schema,
                  "created_utc": manifest["created_utc"], "retain_until": years_after(created, years).isoformat()}
    replace_json(target, checkpoint)
    digest = sha256_file(target)
    manifest.setdefault("sha256", {})[CHECKPOINT] = digest
    manifest.setdefault("bytes", {})[CHECKPOINT] = target.stat().st_size
    alarm = alarm_of(checkpoint)
    if alarm:
        manifest["backup_error"] = {"stage": "audit integrity", "type": alarm}
    replace_json(directory / "manifest.json", manifest)
    append_ledger(root, ledger, [*recovered, seal_entry(directory.name, digest, checkpoint, latest, False)])
    return alarm


# ── retention: the ledger is the list of what must still exist ──

def retention(root, as_of=None, max_age_hours=BACKUP_AGE // 3600):
    """Report, never write or delete. Exit 1 when a sealed backup still inside its retention window is missing or no
    longer matches the ledger, when the latest seal is older than max_age_hours, when a declared checkpoint is not in the
    ledger, or when a re-initialisation after loss is still inside its window; exit 2 without a readable ledger."""
    as_of = as_of or utc_now()
    root = Path(root)
    try:
        ledger = read_ledger(root)
    except LedgerMissing:
        return 2, {"exit": 2, "error": "ledger_missing", "declared": declared_folders(root) if root.is_dir() else []}
    except LedgerInvalid:
        return 2, {"exit": 2, "error": "ledger_invalid"}
    entries = ledger["entries"]
    years = ledger_years(entries)
    seals = [entry for entry in entries if entry["kind"] == "seal"]
    findings = {"missing": [], "checkpoint_changed": [], "dump_missing": [], "dump_changed": []}
    events = {"past": [], "current": []}
    in_window = []
    for entry in seals:
        created = parse_utc(entry["created_utc"])
        deadline = max(parse_utc(entry["retain_until"]), years_after(created, years))
        if as_of >= deadline:
            continue
        in_window.append(entry["backup"])
        folder = root / entry["backup"]
        if entry["previous_verification"]["state"] in ("failed", "unverifiable"):
            events["past"].append({"backup": entry["backup"], **entry["previous_verification"]})
        if folder.is_symlink() or not folder.is_dir():
            findings["missing"].append(entry["backup"])
            continue
        path = folder / CHECKPOINT
        found = declared(folder)
        body = None
        if (not path.is_file() or path.is_symlink() or sha256_file(path) != entry["checkpoint_sha256"]
                or (found is not None and found[1] != entry["checkpoint_sha256"])):
            findings["checkpoint_changed"].append(entry["backup"])
        else:
            try:
                body, _ = load_checkpoint(path)
            except InputError:
                findings["checkpoint_changed"].append(entry["backup"])
        if body is not None and (body["guard"].get("state") != "present" or body["schema"]):
            events["current"].append({"backup": entry["backup"], "guard": body["guard"].get("state"),
                                      "schema": body["schema"]})
        dump = folder / "kin.dump"
        if found is None or not dump.is_file() or dump.is_symlink():
            findings["dump_missing"].append(entry["backup"])   # without the manifest the dump cannot be checked
        elif sha256_file(dump) != found[0].get("sha256", {}).get("kin.dump"):
            findings["dump_changed"].append(entry["backup"])
    latest = seals[-1] if seals else None
    stale = latest is not None and as_of - parse_utc(latest["created_utc"]) > timedelta(hours=max_age_hours)
    uncommitted = [name for _, name, _, _ in pending_checkpoints(root, ledger, latest)]
    first = entries[0]
    discontinuity = (first["kind"] == "reinit_after_loss" and as_of < years_after(parse_utc(first["at"]), years))
    failed = (not seals or stale or uncommitted or discontinuity or any(findings.values()))
    code = 1 if failed else 0
    return code, {"exit": code, "as_of": as_of.isoformat(), "years": years, "sealed": len(seals),
                  "in_window": len(in_window), "no_seal": not seals,
                  "oldest": in_window[0] if in_window else None, "latest": latest["backup"] if latest else None,
                  **findings, "stale": stale, "uncommitted": uncommitted,
                  "discontinuity": first["at"] if discontinuity else None, "integrity_events": events}


def main(argv=None):
    if hasattr(os, "umask"):
        os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="action", required=True)
    init_parser = commands.add_parser("init")
    init_parser.add_argument("root")
    init_parser.add_argument("--years", type=int, default=MIN_YEARS)
    init_parser.add_argument("--after-loss", action="store_true")
    init_parser.add_argument("--reason")
    plan_parser = commands.add_parser("plan")
    plan_parser.add_argument("root")
    plan_parser.add_argument("--years", type=int, required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--backup")
    verify_parser.add_argument("--container")
    verify_parser.add_argument("--database")
    verify_parser.add_argument("--user")
    verify_parser.add_argument("--checkpoint")
    retention_parser = commands.add_parser("retention")
    retention_parser.add_argument("root")
    retention_parser.add_argument("--as-of")
    retention_parser.add_argument("--max-age", type=float, default=BACKUP_AGE / 3600)
    args = parser.parse_args(argv)
    try:
        if args.action in ("init", "plan"):
            with ops.lock():
                if args.action == "init":
                    body = init(args.root, args.years, args.after_loss, args.reason)
                    result = {"exit": 0, "ledger": body["entries"][0]["kind"], "years": args.years}
                else:
                    result = {"exit": 0, "plan": plan(args.root, args.years)}
            code = 0
        elif args.action == "verify":
            named = (args.container, args.database, args.user)
            if args.backup and not any(named):
                ops.require_local_docker()
                code, result = verify_backup(args.backup, Path(args.checkpoint) if args.checkpoint else None)
            elif all(named) and args.checkpoint and not args.backup:
                ops.require_local_docker()
                code, result = verify(Path(args.checkpoint),
                                      DatabaseExport(args.container, args.database, args.user))
            else:
                raise InputError("verify needs --backup, or --container, --database, --user and --checkpoint")
        else:
            as_of = parse_utc(args.as_of) if args.as_of else None
            code, result = retention(args.root, as_of, args.max_age)
    except (InputError, Refused, LedgerMissing, LedgerInvalid, LedgerChanged, OSError, RuntimeError, ValueError) as error:
        # Refusals, a held operations lock and a remote Docker context are not judgements: exit 2, no paths echoed.
        code, result = 2, {"exit": 2, "error": type(error).__name__,
                           "detail": str(error) if isinstance(error, (InputError, Refused, LedgerMissing,
                                                                        LedgerInvalid, LedgerChanged)) else None}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
