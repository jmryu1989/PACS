#!/usr/bin/env python3
"""Stage-1 rollout runner for the existing main server (v3).

Prepared, not executed. Adapted from the reviewed 2026-09-11 host-script pattern
(lock -> durable record -> quiesced migration -> row preservation -> smoke ->
authenticated check -> finalize); none of that script's hardcoded backup, lock,
record or source lists are reused. Every identity comes from delta-manifest.json,
is re-derived from the server's own repository at run time, and must match.

v2 corrects the eight blockers and ten execution defects of review-01:
B1 compose receives service names; container names are structurally refused there.
B2 _prisma_migrations leaves the strict equality set and is proven separately by
   migration identity, not merely excluded.
B3 served assets are compared as raw bytes end to end.
B4 backup component verification is reachable and is re-run inside apply.
B5 receipts are validated before any state change, verify is retryable, and row
   identity (primary-key fingerprint) separates a legitimate value update from a
   deletion; a missing original identity is never acknowledgeable.
B6 the receipt must carry candidate, independent-review and release-tag evidence.
B7 the live checkout is created with umask 022; records and evidence stay 077.
B8 table counts, primary-key coverage and the hashing cap are checked before any
   writer is stopped.

v3 corrects the two findings of fix-review-01:
F1 pre-stop counts are capacity information only. The identity SQL and uniqueness
   rule are dry-run read-only before the lock (results kept as hash/count metadata,
   never as a baseline); the strict baseline is taken only after quiescence, the cap
   is re-checked on the quiesced rows, and pre-stop versus quiesced drift is recorded
   for audit instead of refused.
F2 there is no untagged path. An annotated, remote-verified release tag peeling to
   the target, with successful tag CI on the exact target, is mandatory; a null tag
   and any user_decision_ref are refused.

v4 retargets the accepted v3 bundle to the Stage-2 option-B rollout
(baseline 17980d5 -> target 5dd76a6) with the smallest necessary additions. The accepted
stop/migrate/health/backup/lock/record/recovery path is unchanged; only new refusals are
added. Option B delivers SERVICES = (api, orthanc) with the two accepted Compose files and
leaves the running kin-proxy untouched: no proxy image build, no proxy recreate, no
kin-workflow network or host route directory created, deleted or activated.

C4/C5 ingress guard. After checkout the on-disk compose declares a top-level, non-external
   network kin-workflow that only the proxy references. The rollout must not create, change or
   remove it, so it is observed, not assumed. A post-apply trip is NEEDS_ATTENTION with lock and
   record retained and NO automatic rollback, because a rollback cannot restore external network
   state. This runner never creates or deletes a Docker network.

v5 corrects the ingress guard itself, which was the only code blocker for the option-B rollout.
I1 The invariant was always "this deployment does not create or change the workflow ingress",
   but it was implemented as "the ingress must not exist". The host was never inspected until
   2026-09-19, when kin-proxy was observed joined to kin-workflow with the declared route mount,
   exactly as docker-compose.prod.yml has declared since 2026-09-17. The absence rule therefore
   refused the real production topology. The rule is now PRESERVATION: a coherent observation is
   taken before any change and every later stage must still match it.
I2 The detector compared Destination against the host SOURCE /etc/kin-workflow, while the real
   Destination is /etc/nginx/workflow, so it answered False for the product's own compose. The
   unit fixtures injected the same wrong value and passed. Mounts are now compared as WHOLE
   records (type, source, destination, mode, rw, propagation) against the declared route.
I3 Only two observations are coherent enough to become a baseline: the ingress fully present in
   its declared shape, or fully absent (the legacy synthetic shape). Half-created, half-removed,
   read-write, foreign-source and unreadable states refuse BEFORE any mutation. Absence on this
   product's host is a change, not a new baseline, so the mutate path requires an explicit
   --acknowledge-absent-ingress-baseline to accept it.
I4 The separately managed workflow receiver is recorded but never compared. Its restart rotates
   the network's member list and its endpoint, and that must never keep this runner from
   restoring the previous API.
I5 rollback-start records and reports an ingress difference instead of refusing: the rollback
   restores api and orthanc images and does not touch the ingress at all. Every other guard
   (database, backup, image, writer, acknowledgement, lock) is unchanged, and rollback-END still
   ends in NEEDS_ATTENTION with the lock retained when the ingress is not what it was.
I6 `nginx -t` now runs BEFORE the lock, the writers and the checkout as well as after the
   update. Only its exit code is read: the proxy configuration includes a route directory owned
   by the receiver, and this runner never copies configuration or route contents into a record.
C6 findings rollback. Finding and FindingRevision counts are read behind to_regclass
   guards, so a rollback taken before the migration exists still works, and they need their
   OWN acknowledgement flag: --acknowledge-finding-inaccessibility, never the ViewerJob one.
   Rolling back to the baseline removes every finding API route and UI, so those rows become
   unreachable through the product until roll-forward. No row is ever deleted or rewritten.
C7 classification. The manifest must classify the FULL baseline..target diff (union,
   additions, deletions) as delivered / drift / declared-inert; anything unclassified refuses.
C8 delivered-file proof. After checkout the on-disk config/ohif.js sha256 must equal the
   pinned target content hash, and kin-orthanc must have restarted after the checkout.

Refusals are fail-closed. On any failure the lock, the record and every backup are
retained and a concrete manual next action is printed; nothing is reset, cleaned,
stashed, pruned, restored or deleted by this script under any circumstance.
"""

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

SCHEMA = 1
HASH = re.compile(r"[a-f0-9]{64}")
SHA1 = re.compile(r"[0-9a-f]{40}")
IDENT = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
POSIX = os.name == "posix"

# Indirection so the pure tests can drive real argument construction and mode
# transitions without a Docker daemon, a database, a network or a live host.
_EXECUTE = subprocess.run
_URLOPEN = urllib.request.urlopen
_DISK_USAGE = shutil.disk_usage

ENV_BASE = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
# L1: docker build needs a writable HOME for the buildx state directory. The runner
# never reads a credential from it; only the path is inherited.
RUNTIME_HOME = "/home/ubuntu"
DOCKER_CONFIG = None

# A structural allowlist, so a destructive command cannot be reached even by mistake.
GIT_OK = {"rev-parse", "status", "ls-files", "ls-tree", "cat-file", "show", "diff", "merge-base", "checkout"}
DOCKER_OK = {"inspect", "image", "compose", "exec", "tag", "stop", "ps", "build"}
GIT_FORBIDDEN = {"reset", "clean", "stash", "restore", "rm", "gc", "prune", "push", "fetch", "pull", "commit"}
DOCKER_FORBIDDEN = {"volume", "rm", "rmi", "system", "builder", "network", "cp", "run"}

# B1: Compose addresses SERVICES; docker inspect addresses CONTAINERS. Passing a
# container name to compose is the exact defect review-01 found, so it is refused.
SERVICES = ("api", "orthanc")
WRITER_CONTAINERS = ("kin-api", "kin-orthanc")
CONTAINERS = ("kin-proxy", "kin-orthanc", "kin-db", "kin-keycloak", "kin-api")
COMPOSE_FILES = ("docker-compose.yml", "docker-compose.prod.yml")

# B2: Prisma's own bookkeeping table necessarily gains one row per applied migration.
BOOKKEEPING = "_prisma_migrations"
# Sessions are created, renewed and expired by ordinary use, so identity is not pinned.
VOLATILE = ("AuthSession",)
TERMINAL = {"DEPLOYED", "ROLLED_BACK_DATABASE_RETAINED"}
MAX_HASHED_ROWS = 200000
CHECKOUT_UMASK = 0o022

# Option B: the running proxy is never addressed by a delivery command, only inspected.
PROXY_CONTAINER = "kin-proxy"
WORKFLOW_NETWORK = "kin-workflow"
# I2: the route the running proxy actually carries. docker-compose.prod.yml:23 declares
# /etc/kin-workflow/nginx:/etc/nginx/workflow:ro and the 2026-09-19 host observation shows exactly
# that bind. The previous constant was the host SOURCE and was compared against the Destination,
# so the detector could never be true for the product's own compose.
WORKFLOW_ROUTE_SOURCE = "/etc/kin-workflow/nginx"
WORKFLOW_ROUTE_DESTINATION = "/etc/nginx/workflow"
# The whole mount tuple. A Destination alone cannot tell the declared read-only route apart from
# a writable mount, or from a different host directory placed at the same path.
MOUNT_FIELDS = ("Type", "Name", "Source", "Destination", "Mode", "RW", "Propagation")
# The ingress observation is a durable record schema of its own: a record written by an older
# runner carries no baseline in this schema, and one is never invented after the fact (I3).
INGRESS_SCHEMA = 1
# Only what this rollout could itself influence is compared. The workflow network's member list
# and the receiver's endpoints are recorded and deliberately NOT compared (I4).
COMPARED_PROXY_FIELDS = ("id", "running", "started_at", "networks", "mounts")
COMPARED_NETWORK_FIELDS = ("state", "id", "internal")
# The explicit typed answers docker gives for an absent network. Anything else refuses (C5).
# Both forms NAME the network that was asked about, and both are the WHOLE message. The daemon
# form is what Docker 28.0.4 actually answered on the hosted rehearsal runner; the object form is
# what older CLIs answer. A substring test was used here before and matched neither reliably nor
# narrowly: it accepted a message about a DIFFERENT network, so the recognition is now an exact
# match against the forms built for the name under inspection.
NETWORK_ABSENT_FORMS = ("Error response from daemon: network {name} not found",
                        "Error: No such network: {name}")
# docker's CLI sometimes appends its own `exit status N` after the daemon's message. It carries
# no answer of its own, so it is dropped before matching; on its own it leaves nothing to match
# and still refuses.
EXIT_STATUS_LINE = re.compile(r"\Aexit status \d+\Z", re.I)
# C6: finding rows are counted, never read, and never deleted or rewritten.
FINDING_TABLES = ("Finding", "FindingRevision")


class Refuse(RuntimeError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def stamp():
    return now().isoformat()


def child_env():
    env = dict(ENV_BASE)
    env["HOME"] = RUNTIME_HOME
    if DOCKER_CONFIG:
        env["DOCKER_CONFIG"] = DOCKER_CONFIG
    return env


def check_command(args):
    """Every rule that can be decided from the argument vector alone."""
    if not args:
        raise Refuse("Empty command")
    program = args[0]
    if program not in ("git", "docker", "python3"):
        raise Refuse("Program not allowed: " + program)
    if program == "git":
        sub = next((a for a in args[1:] if not a.startswith("-")), None)
        if sub in GIT_FORBIDDEN or sub not in GIT_OK:
            raise Refuse("git subcommand not allowed: " + str(sub))
        if sub == "checkout" and (len(args) < 4 or args[2] != "--detach" or not SHA1.fullmatch(args[3])):
            raise Refuse("git checkout is only allowed as: git checkout --detach <full sha>")
    if program == "docker":
        sub = args[1] if len(args) > 1 else None
        if sub in DOCKER_FORBIDDEN or sub not in DOCKER_OK:
            raise Refuse("docker subcommand not allowed: " + str(sub))
        if sub == "image" and (len(args) < 3 or args[2] != "inspect"):
            raise Refuse("only 'docker image inspect' is allowed")
        if sub == "compose":
            verb = next((a for a in args[2:] if a in ("up", "stop", "run", "ps", "config")), None)
            if verb is None or verb in ("down", "rm", "kill"):
                raise Refuse("compose verb not allowed")
            wrong = [a for a in args[2:] if a in CONTAINERS]
            if wrong:
                raise Refuse("docker compose addresses services, not container names: " + ", ".join(wrong)
                             + ". Use " + ", ".join(SERVICES) + " (container names are for docker inspect).")
            # Option B: the proxy is never delivered, so it may not appear in any Compose command,
            # and a service list is mandatory. A bare `up` would recreate the proxy from the
            # target compose, build the include, create kin-workflow and outlive a rollback.
            if "proxy" in args[2:]:
                raise Refuse("Option B never addresses the proxy service in a Compose command")
            if verb in ("up", "stop", "run") and not any(a in SERVICES for a in args[2:]):
                raise Refuse("Compose " + verb + " must name explicit services: " + ", ".join(SERVICES))
    return args


def spawn(args, cwd=None, timeout=600, stdout=subprocess.PIPE, umask=-1):
    check_command(args)
    # subprocess accepts umask on every platform and applies it only where it means
    # something; passing it unconditionally keeps the value observable to the tests.
    extra = {"umask": umask} if umask != -1 else {}
    return _EXECUTE(args, cwd=None if cwd is None else str(cwd), env=child_env(), shell=False,
                    stdin=subprocess.DEVNULL, timeout=timeout, stdout=stdout,
                    stderr=subprocess.PIPE, **extra)


def run(args, cwd=None, timeout=600, check=True, raw=False, umask=-1):
    """raw=True returns stdout bytes exactly as the child produced them (B3)."""
    result = spawn(args, cwd=cwd, timeout=timeout, umask=umask)
    if check and result.returncode != 0:
        raise Refuse(" ".join(args[:3]) + " failed: "
                     + (result.stderr or b"").decode("utf-8", "replace").strip()[:400])
    return result.stdout if raw else (result.stdout or b"").decode("utf-8", "replace").strip()


def run_rc(args, cwd=None, timeout=600):
    return spawn(args, cwd=cwd, timeout=timeout).returncode


def fetch(url, timeout=20):
    with _URLOPEN(url, timeout=timeout) as response:
        return response.read()


def digest_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def set_digest(items):
    return hashlib.sha256(("\n".join(sorted(items)) + "\n").encode("utf-8")).hexdigest()


def classify_changed_paths(changed, classes):
    """C7: pure. Every changed path must belong to exactly one declared class.

    `classes` holds `delivered`, `drift` and `declared_inert` member lists (a member is either
    an exact path or a directory prefix). Anything else is unclassified and refuses.
    """
    members = {name: classes.get(name) or [] for name in ("delivered", "drift", "declared_inert")}
    assignment, unclassified, ambiguous = {}, [], []
    for path in sorted(set(changed)):
        owners = [name for name, entries in members.items()
                  if any(path == entry or path.startswith(entry.rstrip("/") + "/") for entry in entries)]
        if not owners:
            unclassified.append(path)
        elif len(owners) > 1:
            ambiguous.append(path)
        else:
            assignment[path] = owners[0]
    return {"assignment": assignment, "unclassified": unclassified, "ambiguous": ambiguous,
            "counts": {name: sum(1 for value in assignment.values() if value == name) for name in members}}


def verify_delivered_on_disk(repo, manifest, checkout_utc):
    """C8: the bind-mounted viewer config is proved on disk, and orthanc restarted after checkout.

    static_matches already proves the served /worklist/ tree over HTTP. config/ohif.js is not
    byte-served (the Orthanc OHIF plugin injects it), so this is its only real proof.
    """
    proofs = {}
    for path, expected in manifest["delivered_files_sha256"].items():
        actual = digest_file(pathlib.Path(repo) / path)
        if actual != expected:
            raise Refuse("Delivered file on disk differs from the pinned target content: " + path)
        proofs[path] = actual
    started = run(["docker", "inspect", "--format", "{{.State.StartedAt}}", "kin-orthanc"])
    if not started_after(started, checkout_utc):
        raise Refuse("kin-orthanc did not restart after the checkout (" + started + " vs " + checkout_utc
                     + "), so the bind-mounted viewer config may still be the previous bytes")
    return {"files": proofs, "orthanc_started_at": started, "checkout_utc": checkout_utc}


def started_after(started_at, checkout_utc):
    """Pure: container StartedAt strictly after the checkout instant. Unparsable answers refuse."""
    try:
        left = datetime.datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
        right = datetime.datetime.fromisoformat(str(checkout_utc).replace("Z", "+00:00"))
    except ValueError:
        raise Refuse("Unparsable container start or checkout time")
    if left.tzinfo is None or right.tzinfo is None:
        raise Refuse("Container start or checkout time has no timezone")
    return left > right


def unsafe_permissions(mode):
    """Group or world writable. Pure, so it is tested on every platform."""
    return bool(mode & 0o022)


def safe_input(path_text, root, limit=4 * 1024 * 1024):
    """A caller-supplied evidence file: regular, owned, not group/world writable."""
    requested = pathlib.Path(path_text)
    if requested.is_symlink():
        raise Refuse("Evidence file may not be a symlink: " + path_text)
    path = requested.resolve(strict=True)
    try:
        path.relative_to(pathlib.Path(root).resolve(strict=True))
    except ValueError:
        raise Refuse("Evidence file must live under " + root)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
        raise Refuse("Evidence file is not a regular file of a sane size: " + str(path))
    # Ownership and mode are meaningful only on the target host; the pure tests run
    # elsewhere. On the server both are enforced.
    if POSIX and (info.st_uid != os.geteuid() or unsafe_permissions(info.st_mode)):
        raise Refuse("Evidence file has unsafe owner or permissions: " + str(path))
    return path, digest_file(path), json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- manifest

def load_manifest(path_text):
    path = pathlib.Path(path_text).resolve(strict=True)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema") != SCHEMA:
        raise Refuse("Unsupported manifest schema")
    for key in ("baseline_sha", "target_sha", "target_tree"):
        if not SHA1.fullmatch(str(manifest.get(key, ""))):
            raise Refuse("Manifest field is not a full object id: " + key)
    if manifest["baseline_sha"] == manifest["target_sha"]:
        raise Refuse("Manifest baseline equals target")
    if not manifest["migrations"]["new"]:
        raise Refuse("Manifest declares no migration delta; re-derive before use")
    manifest["_self_sha256"] = digest_file(path)
    return manifest, manifest["_self_sha256"]


def rederive(repo, manifest):
    """Re-derive every pinned value from the server's own repository."""
    baseline, target = manifest["baseline_sha"], manifest["target_sha"]
    for sha in (baseline, target):
        if run(["git", "cat-file", "-t", sha], cwd=repo) != "commit":
            raise Refuse("Commit missing from the server repository: " + sha +
                         " (fetch the target before running any mutate mode)")
    if run(["git", "rev-parse", target + "^{tree}"], cwd=repo) != manifest["target_tree"]:
        raise Refuse("Target tree on the server differs from the pinned tree")
    if run_rc(["git", "merge-base", "--is-ancestor", baseline, target], cwd=repo) != 0:
        raise Refuse("Pinned baseline is not an ancestor of the target in this repository")
    for path, pinned in manifest["compatibility_boundary_unchanged"].items():
        before = run(["git", "rev-parse", baseline + ":" + path], cwd=repo)
        after = run(["git", "rev-parse", target + ":" + path], cwd=repo)
        if before != after or before != pinned:
            raise Refuse("Compatibility boundary moved or differs from the pin: " + path)
    for path, ends in manifest["delivered_trees"].items():
        if (run(["git", "rev-parse", baseline + ":" + path], cwd=repo) != ends["baseline"]
                or run(["git", "rev-parse", target + ":" + path], cwd=repo) != ends["target"]):
            raise Refuse("Delivered tree differs from the pin: " + path)
    served = ls_tree(repo, target, manifest["static"]["root"])
    if (set_digest(name + " " + blob for name, blob in served) != manifest["static"]["set_sha256"]
            or len(served) != manifest["static"]["count"]):
        raise Refuse("Served static set differs from the pin")
    added = [line for line in run(["git", "diff", "--name-only", "--diff-filter=A", baseline, target],
                                  cwd=repo).splitlines() if line]
    if set_digest(added) != manifest["delta"]["added_sha256"]:
        raise Refuse("Added path set differs from the pin")
    # C4: drift paths move on disk with the checkout and are delivered to no running container.
    # They are pinned at both ends so an unexpected byte set refuses before anything changes.
    for path, ends in manifest["drift_pins"].items():
        if (run(["git", "rev-parse", baseline + ":" + path], cwd=repo) != ends["baseline"]
                or run(["git", "rev-parse", target + ":" + path], cwd=repo) != ends["target"]):
            raise Refuse("Drift path differs from the pin: " + path)
    # C7: every path in the full baseline..target diff must be classified exactly once.
    changed = [line for line in run(["git", "diff", "--name-only", baseline, target],
                                    cwd=repo).splitlines() if line]
    classification = classify_changed_paths(changed, manifest["change_classes"])
    if classification["unclassified"] or classification["ambiguous"]:
        raise Refuse("Changed paths are not classified exactly once:\n  unclassified: "
                     + json.dumps(classification["unclassified"]) + "\n  ambiguous: "
                     + json.dumps(classification["ambiguous"]))
    if set_digest(changed) != manifest["change_classes"]["changed_sha256"]:
        raise Refuse("The baseline..target changed path set differs from the pin")
    base_m = set(run(["git", "ls-tree", "--name-only", baseline, "api/prisma/migrations/"], cwd=repo).splitlines())
    target_m = set(run(["git", "ls-tree", "--name-only", target, "api/prisma/migrations/"], cwd=repo).splitlines())
    new_m = sorted(name.rstrip("/").split("/")[-1] for name in target_m - base_m)
    # The pending migration bytes are pinned by content hash; a heuristic never licenses them.
    for name in new_m:
        body = run(["git", "show", target + ":api/prisma/migrations/" + name + "/migration.sql"],
                   cwd=repo, raw=True)
        pinned = (manifest["migrations"]["detail"].get(name) or {}).get("sha256")
        if hashlib.sha256(body).hexdigest() != pinned:
            raise Refuse("Pending migration bytes differ from the pinned sha256: " + name)
    if not base_m <= target_m or new_m != manifest["migrations"]["new"]:
        raise Refuse("Migration delta differs from the pin")
    return {"added": added, "served": served, "new_migrations": new_m}


def ls_tree(repo, sha, root):
    rows = []
    for line in run(["git", "ls-tree", "-r", sha, root], cwd=repo).splitlines():
        if not line:
            continue
        meta, name = line.split("\t", 1)
        parts = meta.split()
        if parts[1] != "blob":
            raise Refuse("Unexpected served object: " + name)
        rows.append((name, parts[2]))
    return rows


# ---------------------------------------------------------------- database facts

def psql(database, query, timeout=300):
    return run(["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", database,
                "-v", "ON_ERROR_STOP=1", "-qAt", "-c", query], timeout=timeout)


def public_tables(include_bookkeeping=False):
    tables = psql("kin", "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").splitlines()
    tables = [name for name in tables if name]
    if not tables or any(not IDENT.fullmatch(name) for name in tables):
        raise Refuse("Unexpected or empty table list")
    if include_bookkeeping:
        return tables
    return [name for name in tables if name != BOOKKEEPING]


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def literal(name):
    return "'" + name.replace("'", "''") + "'"


def primary_keys(tables):
    """Stable row identity per table. Only column NAMES are read, never values."""
    body = psql("kin",
                "SELECT coalesce(json_object_agg(t, cols), '{}'::json) FROM ("
                "SELECT c.conrelid::regclass::text AS t, json_agg(a.attname ORDER BY k.ord) AS cols "
                "FROM pg_constraint c "
                "JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true "
                "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum "
                "WHERE c.contype = 'p' AND c.connamespace = 'public'::regnamespace GROUP BY 1) p;")
    raw = json.loads(body)
    keys = {}
    for name, cols in raw.items():
        keys[name.strip('"')] = list(cols)
    missing = sorted(name for name in tables if name not in keys)
    if missing:
        raise Refuse(
            "Cannot establish stable row identity for: " + ", ".join(missing) + ".\n"
            "Without a primary key a deletion cannot be told apart from an unrelated insert, so this "
            "runner refuses rather than compare on counts alone. Manual decision required: either add "
            "the missing key, or record an explicit, bounded exclusion for those tables naming what "
            "preservation evidence replaces identity for them.")
    return {name: keys[name] for name in tables}


def table_counts(tables):
    if not tables:
        return {}
    selects = ["SELECT {0} AS t, count(*) AS n FROM {1}".format(literal(name), quoted(name)) for name in tables]
    return {k: int(v) for k, v in
            json.loads(psql("kin", "SELECT json_object_agg(t,n) FROM (" + " UNION ALL ".join(selects) + ") c;")).items()}


def capacity_report(tables, keys, counts, cap):
    oversized = sorted(name for name, rows in counts.items() if rows > cap)
    return {"cap": cap, "counts": dict(sorted(counts.items())), "oversized": oversized,
            "identity_columns": {name: keys[name] for name in sorted(keys)}}


def require_capacity(report):
    if report["oversized"]:
        raise Refuse("Refusing to compare with a weaker check. Tables above the " + str(report["cap"]) +
                     " row limit: " + ", ".join(report["oversized"]) + ". Decide explicitly and re-run "
                     "with --max-hashed-rows, rather than accepting an aggregate-only comparison. "
                     "This is checked before any writer is stopped.")


def cap_refusal(oversized, cap, when):
    return Refuse("Refusing to hash above the " + str(cap) + " row limit " + when + ": "
                  + ", ".join(oversized) + ". Nothing is compared on counts alone; decide explicitly and "
                  "re-run with --max-hashed-rows.")


def table_state(tables, keys, cap=None):
    """Per table: row count, cheap digest, and identity -> row-hash map. Only digests
    and counts leave the database; no column value is ever read out.

    F1: when cap is given it is enforced on the rows actually read, first by a cheap
    count so an oversized table is never hashed, then on the hashed result. No count
    taken earlier is compared here; earlier counts are capacity information only."""
    if cap is not None:
        counts = table_counts(tables)
        oversized = sorted(name for name in tables if counts.get(name, 0) > cap)
        if oversized:
            raise cap_refusal(oversized, cap, "at this read")
    selects = []
    for name in tables:
        key_expr = "md5(json_build_array(" + ", ".join("x." + quoted(col) for col in keys[name]) + ")::text)"
        selects.append(
            "SELECT {0} AS t, coalesce(count(*),0)::bigint AS n, "
            "coalesce(md5(string_agg(h,'' ORDER BY h)),'') AS d, "
            "coalesce(json_object_agg(k,h),'{{}}'::json) AS ids FROM ("
            "SELECT {1} AS k, md5(row_to_json(x)::text) AS h FROM {2} x) s".format(
                literal(name), key_expr, quoted(name)))
    body = psql("kin", "SELECT json_object_agg(t, json_build_object('rows',n,'digest',d,'identities',ids)) FROM ("
                + " UNION ALL ".join(selects) + ") r;")
    state = json.loads(body)
    if set(state) != set(tables):
        raise Refuse("Table state did not cover every table")
    for name, value in state.items():
        if len(value["identities"]) != value["rows"]:
            raise Refuse("Row identity is not unique in " + name + " (" + str(len(value["identities"]))
                         + " identities for " + str(value["rows"]) + " rows); identity-based preservation "
                         "cannot be trusted there. Manual decision required.")
    if cap is not None:
        grown = sorted(name for name, value in state.items() if value["rows"] > cap)
        if grown:
            raise cap_refusal(grown, cap, "on the hashed rows")
    return state


def identity_probe(tables, keys, cap):
    """F1: a read-only, capped dry run of the exact identity SQL and uniqueness rule,
    executed before any lock, record or service stop. Writers may still be running, so
    the result is NEVER a preservation baseline; only hash/count metadata is kept."""
    state = table_state(tables, keys, cap)
    return {"probed_utc": stamp(), "cap": cap, "baseline": False,
            "tables": {name: {"rows": value["rows"], "digest": value["digest"],
                              "identity_count": len(value["identities"])}
                       for name, value in sorted(state.items())}}


def count_drift(pre_stop_counts, quiesced):
    """Pure: audit of legitimate writes between the pre-stop read and quiescence.
    Recorded, never refused; the quiesced read is the authoritative baseline."""
    drift = {}
    for name, value in sorted(quiesced.items()):
        before = pre_stop_counts.get(name)
        if before is None or before != value["rows"]:
            drift[name] = {"pre_stop": before, "quiesced": value["rows"],
                           "delta": None if before is None else value["rows"] - before}
    return drift


def migration_facts():
    """B2: bookkeeping proved by identity, not merely excluded from comparison."""
    names = [line for line in psql("kin", 'SELECT migration_name FROM "{0}" ORDER BY 1;'.format(BOOKKEEPING)).splitlines() if line]
    unfinished = int(psql("kin", 'SELECT count(*) FROM "{0}" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;'.format(BOOKKEEPING)))
    return {"names": names, "count": len(names), "unfinished_or_rolled_back": unfinished}


def require_migration_applied(before, after, expected_new):
    problems = []
    if set(before["names"]) - set(after["names"]):
        problems.append("migration rows disappeared: " + ", ".join(sorted(set(before["names"]) - set(after["names"]))))
    applied = sorted(set(after["names"]) - set(before["names"]))
    if applied != sorted(expected_new):
        problems.append("applied migrations " + json.dumps(applied) + " do not equal the pinned "
                        + json.dumps(sorted(expected_new)))
    if after["count"] != before["count"] + len(expected_new):
        problems.append("migration row count moved by " + str(after["count"] - before["count"])
                        + ", expected " + str(len(expected_new)))
    if after["unfinished_or_rolled_back"]:
        problems.append(str(after["unfinished_or_rolled_back"]) + " migration row(s) are unfinished or rolled back")
    if problems:
        raise Refuse("Migration bookkeeping is not what the pin requires:\n  - " + "\n  - ".join(problems))
    return {"applied": applied, "before_count": before["count"], "after_count": after["count"]}


def snapshot_versions():
    """Count-only distribution of ViewerJob snapshot versions. No row content is read."""
    if psql("kin", "SELECT to_regclass('public.\"ViewerJob\"') IS NOT NULL;") != "t":
        return {"table": "absent"}
    rows = psql("kin", "SELECT coalesce(json_object_agg(v, n),'{}'::json) FROM (SELECT "
                       "coalesce(snapshot->>'version','null') AS v, count(*) AS n "
                       "FROM \"ViewerJob\" GROUP BY 1) s;")
    return {"table": "present", "by_version": json.loads(rows)}


def hanging_protocol_rows():
    if psql("kin", "SELECT to_regclass('public.\"HangingProtocolPreference\"') IS NOT NULL;") != "t":
        return {"table": "absent", "rows": 0}
    return {"table": "present", "rows": int(psql("kin", 'SELECT count(*) FROM "HangingProtocolPreference";'))}


def finding_rows():
    """C6: counts only, behind to_regclass, so a rollback taken before the migration exists works."""
    out = {}
    for table in FINDING_TABLES:
        present = psql("kin", "SELECT to_regclass('public.\"{0}\"') IS NOT NULL;".format(table)) == "t"
        out[table] = {"table": "present" if present else "absent",
                      "rows": int(psql("kin", 'SELECT count(*) FROM "{0}";'.format(table))) if present else 0}
    out["total_rows"] = sum(entry["rows"] for entry in out.values() if isinstance(entry, dict))
    return out


def verify_observed_migration_state(facts, manifest):
    """The observed bookkeeping must reconcile with the pinned baseline and target.

    Derivation alone never authorizes anything: this reads the live rows and refuses on a
    duplicate, a missing baseline name, an unfinished or rolled-back row, or a pending set
    that is not exactly the pinned one.
    """
    names = list(facts["names"])
    pinned = manifest["migrations"]
    problems = []
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        problems.append("duplicate migration rows: " + ", ".join(duplicates))
    missing = [name for name in pinned["baseline_names"] if name not in names]
    if missing:
        problems.append("baseline migrations absent from the database: " + ", ".join(missing))
    if len(names) != pinned["baseline_migration_count"]:
        problems.append("observed " + str(len(names)) + " migration rows, pinned baseline count is "
                        + str(pinned["baseline_migration_count"]))
    extra = [name for name in names if name not in pinned["target_names"]]
    if extra:
        problems.append("rows the target does not contain: " + ", ".join(sorted(extra)))
    pending = [name for name in pinned["target_names"] if name not in names]
    if pending != list(pinned["new"]):
        problems.append("pending set " + json.dumps(pending) + " is not the pinned "
                        + json.dumps(list(pinned["new"])))
    if facts.get("unfinished_or_rolled_back"):
        problems.append(str(facts["unfinished_or_rolled_back"]) + " row(s) unfinished or rolled back")
    if problems:
        raise Refuse("Observed migration state does not match the pin:\n  - " + "\n  - ".join(problems))
    return {"observed_count": len(names), "pending": pending, "duplicates": [],
            "unfinished_or_rolled_back": facts.get("unfinished_or_rolled_back", 0)}


def typed_network_absence(name, message):
    """C5: True only when `message` IS one of the typed not-found answers for exactly `name`.

    Whole-message, name-bound and case-insensitive. Anything with an extra diagnostic line, any
    answer about another network, and any daemon failure that merely quotes the words are all
    False, so the caller refuses instead of reading them as absence.
    """
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    lines = [line for line in lines if not EXIT_STATUS_LINE.match(line)]
    if len(lines) != 1:
        return False
    accepted = {form.format(name=name).casefold() for form in NETWORK_ABSENT_FORMS}
    return lines[0].casefold() in accepted


def network_state(name):
    """C5/I3: a typed observation of one Docker network. It never guesses and never raises.

    `state` is "present" with the identity fields, "absent" only for the exact typed not-found
    answer for exactly this name, or "indeterminate". Indeterminate is a fact about what could
    not be learned, never an absence, and the callers refuse on it before any mutation.

    An inspect that does not RETURN is one more way of not learning the answer: a wedged container
    can block its own inspect until the 60 s timeout while the rest of the daemon answers. That is
    the same indeterminate observation, not an exception thrown through every caller, so the one
    stage that only reports - rollback-start - can still restore the previous api and orthanc.
    Only the exception TYPE is kept: TimeoutExpired carries the argv and whatever output was
    captured, OSError carries host paths, and neither belongs in this record. A Refuse from
    check_command is deliberately NOT caught: a command that breaks the argv rules is a defect in
    this runner, never an observation about the host.
    """
    try:
        result = spawn(["docker", "inspect", "--type", "network", name], timeout=60)
    except (subprocess.TimeoutExpired, OSError) as error:
        return {"name": name, "state": "indeterminate",
                "message": "docker inspect did not return: " + type(error).__name__}
    if result.returncode != 0:
        message = (result.stderr or b"").decode("utf-8", "replace").strip()
        if typed_network_absence(name, message):
            return {"name": name, "state": "absent"}
        return {"name": name, "state": "indeterminate", "message": message[:300]}
    try:
        body = json.loads((result.stdout or b"").decode("utf-8", "replace"))[0]
        if not isinstance(body, dict):
            raise ValueError("the inspect entry is not an object")
    except (ValueError, IndexError, TypeError) as error:
        return {"name": name, "state": "indeterminate",
                "message": "docker exited 0 with an unreadable network object: " + type(error).__name__}
    members = [entry for entry in (body.get("Containers") or {}).values() if isinstance(entry, dict)]
    return {"name": name, "state": "present", "id": body.get("Id"), "internal": body.get("Internal"),
            # I4: observational only. The workflow receiver is managed outside this repository, so
            # its restart rotates this list and its endpoint id; compare_ingress never reads it.
            "member_names": sorted(str(entry.get("Name")) for entry in members if entry.get("Name"))}


def network_absent(name):
    """C5: only the explicit typed not-found answer means absent; any other error refuses."""
    state = network_state(name)
    if state["state"] == "present":
        return False
    if state["state"] == "absent":
        return True
    raise Refuse("Could not determine whether network " + name + " exists; refusing rather than "
                 "guessing. docker said: " + str(state.get("message"))[:300])


def mount_record(entry):
    """Pure: one whole mount tuple, with every field this runner compares."""
    return {field: (entry or {}).get(field) for field in MOUNT_FIELDS}


def mount_records(entries):
    records = [mount_record(entry) for entry in entries or [] if isinstance(entry, dict)]
    return sorted(records, key=lambda record: json.dumps(record, sort_keys=True))


def proxy_state():
    """I3: a typed observation of the running proxy. It never raises.

    An unreadable answer is recorded as unreadable so the caller refuses on an unknown state
    rather than on an exception, and so a read-only observation still produces a report. Only the
    exit code of a failed inspect is kept; the daemon's message is not part of the answer.

    An inspect that never returns is unreadable in the same way, and for the same reason it is an
    answer rather than an exception: a sick proxy is exactly when someone needs the previous api
    back, and the rollback does not touch the proxy at all. Only the exception TYPE is recorded,
    never its argv, output or host paths, and a Refuse from check_command still propagates.
    """
    try:
        result = spawn(["docker", "inspect", PROXY_CONTAINER], timeout=60)
    except (subprocess.TimeoutExpired, OSError) as error:
        return {"container": PROXY_CONTAINER, "readable": False,
                "reason": "docker inspect did not return: " + type(error).__name__}
    if result.returncode != 0:
        return {"container": PROXY_CONTAINER, "readable": False,
                "reason": "docker inspect exited " + str(result.returncode)}
    try:
        body = json.loads((result.stdout or b"").decode("utf-8", "replace"))[0]
        if not isinstance(body, dict):
            raise ValueError("the inspect entry is not an object")
    except (ValueError, IndexError, TypeError) as error:
        return {"container": PROXY_CONTAINER, "readable": False,
                "reason": "docker exited 0 with an unreadable container object: " + type(error).__name__}
    return {"container": PROXY_CONTAINER, "readable": True, "id": body.get("Id"),
            "image": body.get("Image"), "running": (body.get("State") or {}).get("Running"),
            "started_at": (body.get("State") or {}).get("StartedAt"),
            "networks": sorted((body.get("NetworkSettings") or {}).get("Networks") or {}),
            "mounts": mount_records(body.get("Mounts"))}


def workflow_routes(mounts):
    """Pure: mounts that claim either end of the workflow route.

    Matching on EITHER end on purpose: a mount that is half right must be FOUND and judged, not
    missed. Matching Destination alone was the defect that made the old detector always False.
    """
    return [record for record in mounts or []
            if record.get("Destination") == WORKFLOW_ROUTE_DESTINATION
            or record.get("Source") == WORKFLOW_ROUTE_SOURCE]


def route_is_declared_shape(record):
    """Pure: exactly the declared read-only bind, both ends and the writability."""
    return (record.get("Type") == "bind" and record.get("Source") == WORKFLOW_ROUTE_SOURCE
            and record.get("Destination") == WORKFLOW_ROUTE_DESTINATION and record.get("RW") is False)


def ingress_shape(proxy, network):
    """I3: pure classification of one live observation. Two shapes may become a baseline.

    present: the network exists and is internal, the proxy is joined to it, and the proxy carries
             exactly one workflow route, read-only, between the two declared paths.
    absent:  the network answers the typed not-found form, the proxy is in no such network and
             carries no workflow route at all. This is the legacy synthetic shape; the production
             host was observed as `present` on 2026-09-19.
    Everything else is `partial` or `indeterminate`: half-created, half-removed, writable, a
    foreign host directory, or an answer that could not be read. None of those is a baseline.
    """
    unknown = []
    if proxy.get("readable") is not True:
        unknown.append(PROXY_CONTAINER + " could not be inspected: " + str(proxy.get("reason")))
    if network.get("state") == "indeterminate":
        unknown.append("could not determine whether " + WORKFLOW_NETWORK + " exists")
    if unknown:
        return "indeterminate", unknown
    joined = WORKFLOW_NETWORK in (proxy.get("networks") or [])
    routes = workflow_routes(proxy.get("mounts"))
    present = network.get("state") == "present"
    if not present and not joined and not routes:
        return "absent", []
    problems = []
    if not present:
        problems.append(WORKFLOW_NETWORK + " does not exist, yet " + PROXY_CONTAINER + " still carries "
                        + ("its membership" if joined else "") + (" and " if joined and routes else "")
                        + ("a workflow route mount" if routes else ""))
    elif network.get("internal") is not True:
        problems.append(WORKFLOW_NETWORK + " exists but is not internal (Internal="
                        + json.dumps(network.get("internal")) + ")")
    if present and not joined:
        problems.append(PROXY_CONTAINER + " is not joined to " + WORKFLOW_NETWORK)
    if len(routes) != 1:
        problems.append(PROXY_CONTAINER + " carries " + str(len(routes)) + " mounts claiming the "
                        "workflow route; exactly one is declared")
    elif not route_is_declared_shape(routes[0]):
        problems.append("the workflow route is not the declared read-only bind "
                        + WORKFLOW_ROUTE_SOURCE + " -> " + WORKFLOW_ROUTE_DESTINATION
                        + " (observed type " + json.dumps(routes[0].get("Type")) + ", source "
                        + json.dumps(routes[0].get("Source")) + ", destination "
                        + json.dumps(routes[0].get("Destination")) + ", RW "
                        + json.dumps(routes[0].get("RW")) + ")")
    # Every requirement of the declared shape held, so this is the present ingress; anything that
    # failed one of them is a half state and may not be adopted as a baseline.
    return ("partial" if problems else "present"), problems


def ingress_observation():
    """The live ingress as it actually is. Observation only: nothing is created, removed,
    connected or disconnected here, and no route or configuration file is ever read."""
    proxy = proxy_state()
    network = network_state(WORKFLOW_NETWORK)
    shape, problems = ingress_shape(proxy, network)
    return {"schema": INGRESS_SCHEMA, "observed_utc": stamp(), "proxy": proxy, "network": network,
            "shape": shape, "shape_problems": problems}


def compare_ingress(baseline, current):
    """I1/I4: pure. Did the ingress this rollout must preserve move since the baseline?

    Compared: the proxy's own identity, run state, network membership and WHOLE mount table, and
    the workflow network's existence, id and internal flag. NOT compared: the network's member
    list and the receiver's endpoints, because that container is managed outside this repository
    and an unrelated restart of it must never keep the previous API from coming back.
    """
    if not isinstance(baseline, dict) or baseline.get("schema") != INGRESS_SCHEMA:
        return {"comparable": False, "unchanged": False,
                "differences": ["this record carries no ingress baseline in schema "
                                + str(INGRESS_SCHEMA) + ", so there is nothing to compare against. "
                                "It was written before the ingress observation existed, or by a "
                                "different runner. A baseline is never invented after the fact: "
                                "decide manually what the ingress should be."]}
    differences = []
    was, is_now = baseline.get("proxy") or {}, (current.get("proxy") or {})
    if was.get("readable") is not True or is_now.get("readable") is not True:
        differences.append(PROXY_CONTAINER + " was not readable on both sides of the comparison")
    else:
        differences += [PROXY_CONTAINER + " " + field + " differs from the recorded baseline"
                        for field in COMPARED_PROXY_FIELDS if was.get(field) != is_now.get(field)]
    was, is_now = baseline.get("network") or {}, (current.get("network") or {})
    differences += [WORKFLOW_NETWORK + " " + field + " differs from the recorded baseline"
                    for field in COMPARED_NETWORK_FIELDS if was.get(field) != is_now.get(field)]
    return {"comparable": True, "unchanged": not differences, "differences": differences,
            "not_compared": ["the workflow network's member list",
                             "the workflow receiver's identity and endpoints"]}


def finding_ack_record(compatibility, acknowledged, manifest, phase):
    """B1: the durable statement of the findings decision, with its counts and its sentence.

    `acknowledged` distinguishes an explicit decision from `not_required`; a terminal record can
    never be read as either when the other is true.
    """
    findings = compatibility["findings"]
    n, m = findings["Finding"]["rows"], findings["FindingRevision"]["rows"]
    required = compatibility["findings_blocking"]
    text = ("I understand that rolling back to " + manifest["baseline_sha"] + " removes every finding "
            "API route and UI, that " + str(n) + " Finding rows and " + str(m) + " FindingRevision rows "
            "will remain stored but unreachable through the product until a roll-forward, and that no "
            "finding data may be deleted, reset or rewritten to resolve this.")
    return {"phase": phase, "utc": stamp(), "Finding": n, "FindingRevision": m,
            "acknowledgement_required": required,
            "state": "acknowledged" if (required and acknowledged) else
                     ("not_required" if not required else "missing"),
            "flag": "--acknowledge-finding-inaccessibility", "flag_given": bool(acknowledged),
            "text": text if required else
                    "no finding rows exist, so no acknowledgement is required; nothing is deleted either way"}


GUARD_NEXT_ACTION = (
    "The live ingress is no longer the one this rollout observed before it started: the proxy, the "
    "kin-workflow network or the route mount has moved, and this rollout is required to leave all "
    "three exactly as it found them. A rollback does NOT remedy that: this runner never creates or "
    "deletes a Docker network and never recreates the proxy, so restoring the previous api and "
    "orthanc leaves the network, the receiver and the host route directory exactly where they are. "
    "The lock and the record are retained deliberately, and the record holds both the baseline "
    "observation and this one. Compare them, find out who changed the proxy, the network or the "
    "route mount, decide the remedy outside this runner, and only then re-run the mode that refused.")


def clear_terminal_annotations(state):
    """NB1: a terminal record carries no leftover failure text from an earlier attempt."""
    state["failed_action"] = None
    state["error"] = None
    state["failed_utc"] = None
    state["manual_next_action"] = None
    state["guard_tripped_this_invocation"] = False
    return state


INGRESS_STOP_HERE = (
    "This runner never creates or deletes a Docker network and never recreates the proxy. Stop "
    "here: any lock, record and backup are retained. Do NOT run an automatic rollback, which "
    "cannot restore external network state; decide the next step explicitly.")


def ingress_checkpoint(record, state, key, stage, enforce=True):
    """I1: observe, compare against the baseline taken before the change, and ALWAYS record.

    enforce=False is used at rollback-start and nowhere else: there a difference is recorded and
    reported, but it may not stop the previous api and orthanc from being restored, because the
    rollback does not touch the ingress at all. Every other stage fails closed, including a record
    that carries no baseline in the current schema.
    """
    observation = ingress_observation()
    comparison = compare_ingress(state.get("ingress_baseline"), observation)
    state[key] = {"stage": stage, "enforced": bool(enforce), "observed": observation,
                  "comparison": comparison}
    # NB1: the flag describes THIS invocation, so an unchanged observation clears an earlier trip.
    state["guard_tripped_this_invocation"] = bool(enforce) and not comparison["unchanged"]
    if enforce and not comparison["unchanged"]:
        state["status"] = "NEEDS_ATTENTION_LOCK_RETAINED"
        state["failed_action"] = stage
        state["manual_next_action"] = GUARD_NEXT_ACTION
        write_private(record, state)
        raise Refuse("Ingress preservation failed at " + stage + ":\n  - "
                     + "\n  - ".join(comparison["differences"])
                     + "\nBoth observations are in " + str(record) + ".\n" + GUARD_NEXT_ACTION)
    write_private(record, state)
    if not comparison["unchanged"]:
        # I5: reported, not fatal. Silence here would hide a real host change behind a rollback.
        sys.stderr.write("\nNOTE: the live ingress differs from the recorded baseline at " + stage
                         + ":\n  - " + "\n  - ".join(comparison["differences"])
                         + "\nThis is recorded in " + str(record) + " and does NOT stop the previous "
                         "api and orthanc from being restored. It is checked again at rollback-end, "
                         "which ends in NEEDS_ATTENTION if it is still different.\n")
    return state[key]


def require_coherent_ingress(stage, allow_absent=False):
    """I3: the pre-mutation gate. Only a coherent observation may become the baseline.

    On this product's host the coherent shape is the PRESENT one, observed on 2026-09-19. Absence
    is therefore a CHANGE to the host rather than a new baseline, and it is accepted only when the
    operator says so explicitly, which is recorded. Absence remains a first-class shape because the
    synthetic rehearsal stacks legitimately have no ingress at all.
    """
    observation = ingress_observation()
    shape = observation["shape"]
    if shape == "present" or (shape == "absent" and allow_absent):
        return observation
    if shape == "absent":
        raise Refuse(
            "The live ingress is absent at " + stage + ": " + WORKFLOW_NETWORK + " does not exist and "
            + PROXY_CONTAINER + " carries no " + WORKFLOW_ROUTE_DESTINATION + " route. The production "
            "proxy was observed carrying both, so this is a change to the host, not a newly "
            "acceptable baseline, and it is never adopted silently.\n" + INGRESS_STOP_HERE + "\n"
            "If this host genuinely never had the ingress, re-run naming "
            "--acknowledge-absent-ingress-baseline so that decision is recorded with the run.")
    raise Refuse(
        "The live ingress is not in a state this rollout can take as a baseline at " + stage + ":\n  - "
        + "\n  - ".join(observation["shape_problems"] or ["no detail was recorded"])
        + "\nA half-created, half-removed, writable, foreign or unreadable ingress is never read as "
        "either present or absent.\n" + INGRESS_STOP_HERE)


def nginx_config_ok():
    """I6: `nginx -t` inside the running proxy, EXIT CODE ONLY.

    The proxy configuration includes a route directory written by the separately managed workflow
    receiver. Its contents are none of this runner's business, so neither stdout nor stderr is
    read, recorded or printed here; only whether the configuration parses.
    """
    return run_rc(["docker", "exec", PROXY_CONTAINER, "nginx", "-t"], timeout=120) == 0


def nginx_refusal(when):
    return Refuse("`nginx -t` fails inside " + PROXY_CONTAINER + " " + when + ". Only the exit code "
                  "is read: this runner never copies the proxy configuration or any route file into "
                  "its output. Fix the proxy configuration outside this runner, then re-run.")


# ---------------------------------------------------------------- preservation

def compare_tables(before, after, strict, acknowledged=()):
    """Identity-based preservation.

    strict (writers stopped): nothing may differ at all.
    otherwise: every original row identity must still exist. A missing identity is a
    loss and is NEVER acknowledgeable, so a deleted row cannot be hidden behind an
    unrelated insert that restores the count. An identity that still exists but whose
    value changed is a rewrite, reported separately and refused unless its table was
    explicitly acknowledged. New identities are true appends.
    """
    acknowledged = set(acknowledged)
    problems, report = [], {}
    for name, was in before.items():
        is_now = after.get(name)
        if is_now is None:
            problems.append(name + ": table disappeared")
            continue
        if strict:
            if (is_now["rows"] != was["rows"] or is_now["digest"] != was["digest"]
                    or is_now["identities"] != was["identities"]):
                problems.append(name + ": changed while writers were stopped ("
                                + str(was["rows"]) + " -> " + str(is_now["rows"]) + " rows)")
            continue
        old, new = was["identities"], is_now["identities"]
        missing = [k for k in old if k not in new]
        rewritten = [k for k in old if k in new and new[k] != old[k]]
        appended = [k for k in new if k not in old]
        report[name] = {"missing": len(missing), "rewritten": len(rewritten), "appended": len(appended)}
        if name in VOLATILE:
            continue
        if missing:
            problems.append(name + ": " + str(len(missing)) + " original row identity(ies) are gone. "
                            "This is never acknowledgeable; restore or explain before proceeding.")
        if rewritten and name not in acknowledged:
            problems.append(name + ": " + str(len(rewritten)) + " original row(s) kept their identity but "
                            "changed value. If that is legitimate, re-run naming the table in "
                            "--acknowledge-rewritten-tables so the decision is recorded.")
    if problems:
        raise Refuse("Production data preservation failed:\n  - " + "\n  - ".join(problems))
    return {"tables": len(before), "strict": strict,
            "acknowledged_rewrites": sorted(acknowledged),
            "per_table": {k: v for k, v in sorted(report.items()) if any(v.values())}}


def rollback_compatibility(manifest):
    """The previous API refuses snapshot versions it never accepted. Refuse to strand work."""
    versions = snapshot_versions()
    incompatible = incompatible_versions(versions.get("by_version"),
                                         manifest["snapshot_versions"]["previous_api_accepts"])
    hanging = hanging_protocol_rows()
    # B2: the baseline may own HangingProtocolPreference itself. At 17980d5 it does (its own last
    # migration creates the table and the baseline API reads it), so existing preference rows are
    # NOT incompatible work and must never refuse a rollback. The manifest derives ownership from
    # git objects; rows are recorded as information whenever the baseline owns the table.
    owned = bool((manifest.get("hanging_protocol") or {}).get("baseline_owns_table"))
    hanging = dict(hanging, baseline_owns_table=owned,
                   blocking=(not owned) and hanging["rows"] > 0,
                   note=("the baseline owns this table and reads these rows; they are information, "
                         "not incompatible work") if owned else
                        ("the baseline does not own this table, so these rows would be stranded"))
    findings = finding_rows()
    # C6: findings are a SEPARATE decision with their own acknowledgement. They are not folded
    # into `blocking`, so one acknowledgement can never silently cover both.
    return {"incompatible_viewer_jobs": incompatible, "hanging_protocol": hanging,
            "blocking": bool(incompatible) or hanging["blocking"],
            "findings": findings, "findings_blocking": findings["total_rows"] > 0,
            "findings_effect": "rolling back to the baseline removes every finding API route and UI; "
                               "these rows stay stored and become unreachable through the product until "
                               "roll-forward. No finding row is deleted, reset or rewritten."}


def incompatible_versions(by_version, accepted):
    """Pure: snapshot versions present in the database that the previous API never accepted."""
    accepted, out = set(accepted), {}
    for value, count in (by_version or {}).items():
        try:
            known = int(value) in accepted
        except (TypeError, ValueError):
            known = False
        if not known and int(count) > 0:
            out[str(value)] = int(count)
    return out


# ---------------------------------------------------------------- receipts

def validate_gate_body(body, manifest, current=None):
    """Pure: the actual-main gate plus the repository's declared release gates (B6).
    Candidate or dispatch-only runs never satisfy the main part, and no block may be absent."""
    current = current or now()
    if "user_decision_ref" in body:
        # F2: no user authorized an untagged deployment or a bypass of failed tag CI.
        raise Refuse("This rollout has no untagged path: user_decision_ref is not accepted, whatever it names. "
                     "A verified annotated release tag with successful tag CI on the target is mandatory.")
    required = {"schema", "head_sha", "head_tree", "run_id", "workflows", "checks", "collected_utc",
                "source", "candidate", "independent_review_refs", "release_tag"}
    if set(body) != required or body["schema"] != SCHEMA:
        raise Refuse("Gate receipt schema is invalid; every block must be present, including "
                     "candidate, independent_review_refs and release_tag")
    if body["head_sha"] != manifest["target_sha"] or body["head_tree"] != manifest["target_tree"]:
        raise Refuse("Gate receipt is not for the pinned target SHA and tree")
    names = {}
    for row in body["workflows"]:
        if set(row) != {"path", "conclusion"} or row["conclusion"] != "success":
            raise Refuse("A workflow run on the target did not conclude success: " + str(row.get("path")))
        names[row["path"]] = row["conclusion"]
    missing = sorted(set(manifest["gate"]["required_workflows"]) - set(names))
    if missing:
        raise Refuse("Gate receipt is missing required main workflows: " + ", ".join(missing))
    if not body["checks"]:
        raise Refuse("Gate receipt lists no checks")
    bad = [c for c in body["checks"] if set(c) != {"name", "conclusion"} or c["conclusion"] != "success"]
    if bad:
        raise Refuse("Gate receipt contains " + str(len(bad)) + " checks that are not success")
    created = datetime.datetime.fromisoformat(str(body["collected_utc"]).replace("Z", "+00:00"))
    if created.tzinfo is None or created > current + datetime.timedelta(minutes=5):
        raise Refuse("Gate receipt time is missing a timezone or lies in the future")

    candidate = body["candidate"]
    if (not isinstance(candidate, dict)
            or set(candidate) != {"run_id", "head_sha", "test_merge_sha", "tree", "conclusion"}):
        raise Refuse("Gate receipt candidate block is malformed")
    if candidate["tree"] != manifest["target_tree"]:
        raise Refuse("Candidate run validated tree " + str(candidate["tree"])
                     + ", which is not the pinned target tree")
    if candidate["conclusion"] != "success":
        raise Refuse("Candidate run did not conclude success")
    reviews = body["independent_review_refs"]
    if not isinstance(reviews, list) or not reviews or any(not isinstance(r, str) or not r.strip() for r in reviews):
        raise Refuse("Gate receipt must name at least one independent review reference")

    tag = body["release_tag"]
    if tag is None:
        raise Refuse("release_tag is null. This rollout has no untagged path; a verified annotated release tag "
                     "with successful tag CI on the target is mandatory.")
    if not isinstance(tag, dict) or set(tag) != {"name", "annotated", "peeled_sha", "remote_verified",
                                                 "tag_ci_run_id", "tag_ci_head_sha", "conclusion"}:
        raise Refuse("Gate receipt release_tag block is malformed")
    if not isinstance(tag["name"], str) or not tag["name"].strip():
        raise Refuse("Release tag name is missing")
    if tag["annotated"] is not True or tag["remote_verified"] is not True:
        raise Refuse("Release tag must be annotated and verified against the remote")
    if tag["peeled_sha"] != manifest["target_sha"]:
        raise Refuse("Release tag peels to " + str(tag["peeled_sha"]) + ", not the pinned target")
    if tag["tag_ci_head_sha"] != manifest["target_sha"]:
        raise Refuse("Release tag CI ran on " + str(tag["tag_ci_head_sha"]) + ", not the pinned target")
    if type(tag["tag_ci_run_id"]) is not int or tag["tag_ci_run_id"] <= 0:
        raise Refuse("Release tag CI run id must be recorded")
    if tag["conclusion"] != "success":
        raise Refuse("Release tag CI concluded " + str(tag["conclusion"]) + "; deployment is blocked. Prior main "
                     "CI is never a substitute for a failed tag CI.")
    return {"run_id": body["run_id"], "workflows": sorted(names), "check_count": len(body["checks"]),
            "collected_utc": body["collected_utc"], "source": body["source"],
            "candidate": candidate, "independent_review_refs": list(reviews), "release_tag": tag}


def gate_receipt(path_text, expected_sha256, manifest, root):
    _path, actual, body = safe_input(path_text, root)
    if not HASH.fullmatch(expected_sha256 or "") or actual != expected_sha256:
        raise Refuse("Gate receipt hash mismatch")
    return dict(validate_gate_body(body, manifest), sha256=actual)


def validate_build_body(body, manifest):
    """Pure: the candidate image must be the pinned target's API tree, built as node."""
    required = {"schema", "target_sha", "api_tree", "image_id", "image_tag", "revision", "user", "built_utc"}
    if set(body) != required or body["schema"] != SCHEMA:
        raise Refuse("Build receipt schema is invalid")
    if body["target_sha"] != manifest["target_sha"] or body["api_tree"] != manifest["delivered_trees"]["api"]["target"]:
        raise Refuse("Build receipt does not describe the pinned target API tree")
    if body["revision"] != manifest["target_sha"] or body["user"] != "node":
        raise Refuse("Build receipt revision or user is wrong")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", str(body["image_id"])):
        raise Refuse("Build receipt image id is malformed")
    return body


def build_receipt(path_text, expected_sha256, manifest, root):
    _path, actual, body = safe_input(path_text, root)
    if not HASH.fullmatch(expected_sha256 or "") or actual != expected_sha256:
        raise Refuse("Build receipt hash mismatch")
    return validate_build_body(body, manifest)


def validate_auth_body(body, manifest, applied_utc, current=None):
    """Pure: an externally collected authenticated READ-ONLY check of the deployed target.
    L7: the frame digest must be compared against the pre-update value, not merely present."""
    current = current or now()
    required = {"schema", "target", "authenticated", "passed", "frame_sha256_before", "frame_sha256_after",
                "clinical_counts", "account_unchanged", "created_utc", "method"}
    if set(body) != required or body["schema"] != SCHEMA:
        raise Refuse("Authenticated evidence schema is invalid")
    if body["target"] != manifest["target_sha"] or body["passed"] is not True or body["authenticated"] is not True:
        raise Refuse("Authenticated evidence does not record a passing authenticated check of the target")
    if body["account_unchanged"] is not True:
        raise Refuse("Authenticated evidence must assert that no account was created, promoted or changed")
    for key in ("frame_sha256_before", "frame_sha256_after"):
        if not HASH.fullmatch(str(body[key])):
            raise Refuse("Authenticated frame digest is malformed: " + key)
    if body["frame_sha256_before"] != body["frame_sha256_after"]:
        raise Refuse("The original frame payload digest changed across the deployment")
    counts = body["clinical_counts"]
    if not isinstance(counts, dict) or not counts or any(type(v) is not int or v < 0 for v in counts.values()):
        raise Refuse("Clinical counts must be a non-empty map of non-negative integers")
    created = datetime.datetime.fromisoformat(str(body["created_utc"]).replace("Z", "+00:00"))
    if created.tzinfo is None or created < datetime.datetime.fromisoformat(applied_utc):
        raise Refuse("Authenticated evidence must follow this deployment")
    if not 0 <= (current - created).total_seconds() <= 3600:
        raise Refuse("Authenticated evidence is stale")
    return body


# ---------------------------------------------------------------- backup

def verify_backup_components(backup_text, manifest, max_age_seconds=None):
    """B4: reachable from mode_backup AND re-run inside apply. Never writes."""
    requested = pathlib.Path(backup_text)
    if requested.is_symlink():                                  # L5: check before resolving
        raise Refuse("Backup directory may not be a symlink: " + str(backup_text))
    backup = requested.resolve(strict=True)
    if not backup.is_dir():
        raise Refuse("Backup path is not a directory")
    manifest_path = backup / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise Refuse("Backup manifest must be a regular file")
    body = json.loads(manifest_path.read_text(encoding="utf-8"))
    if body.get("format") != 1 or body.get("complete") is not True or body.get("ready") is not True:
        raise Refuse("Backup is not complete and ready")
    if body.get("git_sha") != manifest["baseline_sha"] or body.get("git_dirty") is not False:
        raise Refuse("Backup does not describe the clean pinned baseline")
    components = manifest["backup"]["components"]
    if set(body.get("sha256") or {}) != set(components) or set(body.get("bytes") or {}) != set(components):
        raise Refuse("Backup component manifest is incomplete")
    for name in components:
        item = backup / name
        info = item.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != body["bytes"][name] or info.st_size <= 0:
            raise Refuse("Unsafe, missing or empty backup component: " + name)
        if not HASH.fullmatch(str(body["sha256"][name])) or digest_file(item) != body["sha256"][name]:
            raise Refuse("Backup component checksum mismatch: " + name)
    age = (now() - datetime.datetime.fromisoformat(body["created_utc"].replace("Z", "+00:00"))).total_seconds()
    if max_age_seconds is not None and not 0 <= age <= max_age_seconds:
        raise Refuse("Backup must be no more than " + str(max_age_seconds) + " s old at cutover; take a fresh one")
    return {"backup": str(backup), "age_seconds": round(age, 1),
            "manifest_sha256": digest_file(manifest_path),
            "components_verified": sorted(components), "counts_recorded": bool(body.get("counts"))}


# ---------------------------------------------------------------- record + lock

def write_private(path, payload):
    tmp = pathlib.Path(str(path) + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, ensure_ascii=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    if POSIX:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def create_record(path_text, state):
    path = pathlib.Path(path_text)
    if path.exists() or path.is_symlink():
        raise Refuse("Durable record already exists; choose a fresh run-specific path. "
                     "Historical records are never adopted, reused or deleted: " + str(path))
    os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    write_private(path, state)
    return path


def lock_path(repo):
    return pathlib.Path(repo) / ".kin-ops.lock"


def read_lock(repo):
    try:
        return lock_path(repo).read_text(encoding="utf-8")
    except FileNotFoundError:                                    # L2: a Refuse, not a traceback
        raise Refuse("The operations lock " + str(lock_path(repo)) + " is absent while a durable record "
                     "claims ownership. Do not recreate it by hand; inspect the record and decide manually.")


def owned_record(path_text, manifest, repo):
    path = pathlib.Path(path_text).resolve(strict=True)
    state = json.loads(path.read_text(encoding="utf-8"))
    if (state.get("target") != manifest["target_sha"] or state.get("baseline") != manifest["baseline_sha"]
            or state.get("manifest_sha256") != manifest.get("_self_sha256")):
        raise Refuse("Durable record identity does not match this manifest")
    if read_lock(repo) != state.get("token"):
        raise Refuse("Operations lock is not owned by this record")
    return path, state


def take_lock(repo, token):
    path = lock_path(repo)
    handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write(token)
        stream.flush()
        os.fsync(stream.fileno())
    return path


def fail(record_path, state, error, action, next_action):
    state["status"] = "NEEDS_ATTENTION_LOCK_RETAINED"
    state["failed_action"] = action
    state["error"] = type(error).__name__ + ": " + str(error)
    state["failed_utc"] = stamp()
    # B3/NB1: the guard's action is used only when THIS invocation tripped the guard. A stale
    # text from an earlier, externally remedied trip must never contradict the current refusal.
    if state.get("guard_tripped_this_invocation") is True:
        state["manual_next_action"] = GUARD_NEXT_ACTION
    else:
        state["manual_next_action"] = next_action
    next_action = state["manual_next_action"]
    write_private(record_path, state)
    sys.stderr.write("\nREFUSED/FAILED. Lock, record and backups retained.\nNext action: " + next_action + "\n")


# ---------------------------------------------------------------- service control

def compose(repo):
    args = ["docker", "compose", "--project-directory", str(repo)]
    for name in COMPOSE_FILES:
        args += ["-f", str(pathlib.Path(repo) / name)]
    return args


def stop_writers(repo):
    run(compose(repo) + ["stop"] + list(SERVICES), cwd=repo, timeout=300)
    for name in WRITER_CONTAINERS:
        if run(["docker", "inspect", "--format", "{{.State.Running}}", name]) != "false":
            raise Refuse("Writer did not stop: " + name)


def start_services(repo):
    run(compose(repo) + ["up", "-d", "--no-deps", "--no-build", "--pull", "never",
                         "--force-recreate"] + list(SERVICES), cwd=repo, timeout=900)
    # I6: exit codes only, here as well as before the lock. `run()` would put the child's stderr
    # into the refusal, and that stderr quotes the offending configuration line.
    if not nginx_config_ok():
        raise nginx_refusal("after the service update")
    if run_rc(["docker", "exec", PROXY_CONTAINER, "nginx", "-s", "reload"], timeout=120) != 0:
        raise Refuse("`nginx -s reload` failed inside " + PROXY_CONTAINER + ". Only the exit code is "
                     "read; the configuration is never copied into this output. The services are up "
                     "but the proxy is still serving its previous configuration.")


def apply_migration(repo):
    return run(compose(repo) + ["run", "--rm", "--no-deps", "--entrypoint", "sh", "api", "-c",
                                "./node_modules/.bin/prisma migrate deploy"], cwd=repo, timeout=1800)


def move_checkout(repo, sha, target_tree=None):
    # B7: served files must be world readable for the Orthanc container; records stay 077.
    run(["git", "checkout", "--detach", sha], cwd=repo, umask=CHECKOUT_UMASK)
    if run(["git", "rev-parse", "HEAD"], cwd=repo) != sha:
        raise Refuse("Checkout did not move to " + sha)
    if target_tree and run(["git", "rev-parse", "HEAD^{tree}"], cwd=repo) != target_tree:
        raise Refuse("Checked-out tree is not the pinned tree")


def running_image(container="kin-api"):
    return run(["docker", "inspect", "--format", "{{.Image}}", container])


# ---------------------------------------------------------------- live checks

def wait_health(origin, seconds=180):
    deadline = time.monotonic() + seconds
    while True:
        try:
            with _URLOPEN(origin + "/api/health", timeout=5) as response:
                if response.status == 200 and json.load(response).get("ok"):
                    return True
        except Exception:
            pass
        if time.monotonic() >= deadline:
            raise Refuse("Service did not become healthy within " + str(seconds) + " s")
        time.sleep(2)


def unauthenticated_is_refused(origin):
    try:
        _URLOPEN(origin + "/api/studies", timeout=15).close()
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise Refuse("Unauthenticated studies request returned " + str(error.code))
        return 401
    raise Refuse("Unauthenticated studies request was accepted")


def served_paths(repo, sha, manifest, subset):
    """L4: derived from the selected commit's own tree, so a rollback check is never vacuous."""
    root, prefix = manifest["static"]["root"], manifest["static"]["url_prefix"]
    rows = ls_tree(repo, sha, root)
    if sha == manifest["target_sha"]:
        if set_digest(name + " " + blob for name, blob in rows) != manifest["static"]["set_sha256"]:
            raise Refuse("Served static set differs from the pin")
    if subset == "changed":
        changed = set(run(["git", "diff", "--name-only", manifest["baseline_sha"], sha], cwd=repo).splitlines())
        rows = [row for row in rows if row[0] in changed]
    if not rows:
        raise Refuse("The static check would verify zero files, which proves nothing. Use --static all "
                     "for this commit.")
    return [(name, prefix + name[len(root):]) for name, _blob in rows]


def static_matches(repo, sha, manifest, origin, subset):
    """B3: raw bytes on both sides. No decode, no strip, no re-encode."""
    checked = {}
    for path, url in served_paths(repo, sha, manifest, subset):
        expected = run(["git", "show", sha + ":" + path], cwd=repo, raw=True)
        body = fetch(origin + url)
        if body != expected:
            raise Refuse("Served asset differs from the selected commit: " + path
                         + " (" + str(len(body)) + " bytes served, " + str(len(expected)) + " expected)")
        checked[path] = hashlib.sha256(body).hexdigest()
    if run(["git", "rev-parse", "HEAD"], cwd=repo) != sha:
        raise Refuse("Checkout changed during the static check")
    return {"count": len(checked), "set_sha256": set_digest(k + " " + v for k, v in checked.items())}


# ---------------------------------------------------------------- fresh facts

def container_facts(names):
    facts = {}
    for name in names:
        raw = json.loads(run(["docker", "inspect", name]))[0]
        config = raw.get("Config") or {}
        facts[name] = {
            "image": raw.get("Image"),
            "running": (raw.get("State") or {}).get("Running"),
            "user": config.get("User"),
            "revision": (config.get("Labels") or {}).get("org.opencontainers.image.revision"),
            "mounts": [m.get("Destination") for m in raw.get("Mounts") or []],
            "env_names": sorted(entry.split("=", 1)[0] for entry in config.get("Env") or [] if "=" in entry),
        }
    return facts


def config_fingerprints(repo):
    """Hashes only. L10: the observe output is private evidence and is written 0600."""
    out = {}
    for name in ("docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml", ".env"):
        path = pathlib.Path(repo) / name
        out[name] = {"present": path.is_file(), "sha256": digest_file(path) if path.is_file() else None,
                     "bytes": path.stat().st_size if path.is_file() else None}
    return out


def database_facts(cap):
    tables = public_tables()
    keys = primary_keys(tables)
    counts = table_counts(tables + [BOOKKEEPING])
    report = capacity_report(tables, keys, {k: v for k, v in counts.items() if k != BOOKKEEPING}, cap)
    return {
        "tables": tables,
        "capacity": report,
        "bookkeeping_rows": counts.get(BOOKKEEPING),
        "migrations": migration_facts(),
        "snapshot_versions": snapshot_versions(),
        "hanging_protocol": hanging_protocol_rows(),
        "size_bytes": int(psql("kin", "SELECT pg_database_size('kin') + pg_database_size('keycloak');")),
    }


def fresh_facts(repo, manifest, with_database, cap=MAX_HASHED_ROWS):
    repo = pathlib.Path(repo).resolve(strict=True)
    untracked = [line for line in run(["git", "ls-files", "--others", "--exclude-standard"], cwd=repo).splitlines() if line]
    total, _used, free = _DISK_USAGE(repo)
    facts = {
        "collected_utc": stamp(),
        "repository": str(repo),
        "head": run(["git", "rev-parse", "HEAD"], cwd=repo),
        "head_tree": run(["git", "rev-parse", "HEAD^{tree}"], cwd=repo),
        "tracked_dirty": bool(run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo)),
        "untracked_count": len(untracked),
        "containers": container_facts(manifest["live"]["containers"]),
        "config_fingerprints": config_fingerprints(repo),
        "locks": {"/home/ubuntu/.kin-ops.lock": pathlib.Path("/home/ubuntu/.kin-ops.lock").exists(),
                  ".kin-ops.lock": lock_path(repo).exists()},
        "disk": {"repository": {"total": total, "free": free}},
        # C4/C5/I1: the live ingress is observed on every pass, never assumed. This is an
        # observation, so an unreadable answer is reported rather than raised.
        "ingress": ingress_observation(),
    }
    if with_database:
        facts["database"] = database_facts(cap)
        # Recorded here, ENFORCED by apply: observing after a successful apply legitimately shows
        # the pending set already applied, and that must not make a read-only pass raise.
        try:
            facts["migration_state"] = verify_observed_migration_state(facts["database"]["migrations"], manifest)
        except Refuse as error:
            facts["migration_state"] = {"reconciled": False, "refusal": str(error)}
    return facts, untracked


def require_pinned_baseline(facts, manifest, untracked, derived):
    """Abort on any mismatch. Changed server state is never adopted automatically."""
    live, problems = manifest["live"], []
    if facts["head"] != manifest["baseline_sha"]:
        problems.append("live HEAD is " + facts["head"] + ", pinned baseline is " + manifest["baseline_sha"])
    if facts["tracked_dirty"]:
        problems.append("tracked working tree is dirty")
    api = facts["containers"].get("kin-api", {})
    if api.get("image") != live["previous_api_image"]:
        problems.append("running API image differs from the pinned previous image")
    if api.get("revision") != live["previous_api_revision"]:
        problems.append("running API revision label differs from the pinned baseline")
    if api.get("user") != live["previous_api_user"] or api.get("mounts"):
        problems.append("running API user or mount set is not the pinned production shape")
    for name in live["containers"]:
        if not facts["containers"].get(name, {}).get("running"):
            problems.append("container not running: " + name)
    if any(facts["locks"].values()):
        problems.append("an operations lock already exists; manual review is required")
    collisions = sorted(set(derived["added"]) & set(untracked))
    if collisions:
        problems.append("untracked files occupy target paths: " + ", ".join(collisions[:10]))
    if problems:
        raise Refuse("Fresh server state does not match the pinned baseline:\n  - " + "\n  - ".join(problems))


# ---------------------------------------------------------------- modes

def mode_observe(args):
    manifest, manifest_sha = load_manifest(args.manifest)
    derived = rederive(args.repo, manifest)
    out = pathlib.Path(args.out)
    if out.exists():
        raise Refuse("Observation output already exists; use a fresh path")
    facts, untracked = fresh_facts(args.repo, manifest, False, args.max_hashed_rows)
    report = {"mode": "observe", "read_only": True, "manifest_sha256": manifest_sha,
              "baseline_sha": manifest["baseline_sha"], "target_sha": manifest["target_sha"],
              "privacy": "Private evidence: contains configuration digests. Do not publish.",
              "facts": facts, "untracked_collisions": sorted(set(derived["added"]) & set(untracked)),
              "matches_pinned_baseline": None, "mismatch": None,
              "database_ready": None, "database_error": None}
    try:
        require_pinned_baseline(facts, manifest, untracked, derived)
        report["matches_pinned_baseline"] = True
    except Refuse as error:
        report["matches_pinned_baseline"] = False
        report["mismatch"] = str(error)
    if not args.no_database:
        # F1: the database facts and the identity dry run are reported even when they refuse,
        # so a missing key or a non-unique identity is learned here, not after writers stop.
        try:
            facts["database"] = database_facts(args.max_hashed_rows)
            capacity = facts["database"]["capacity"]
            report["capacity_ok"] = not capacity["oversized"]
            if report["capacity_ok"]:
                report["identity_probe"] = identity_probe(facts["database"]["tables"],
                                                          capacity["identity_columns"], args.max_hashed_rows)
            report["rollback_compatibility_now"] = rollback_compatibility(manifest)
            report["database_ready"] = report["capacity_ok"]
        except Refuse as error:
            report["database_ready"] = False
            report["database_error"] = str(error)
    write_private(out, report)
    ready = bool(report["matches_pinned_baseline"]) and (args.no_database or bool(report["database_ready"]))
    print(json.dumps({"written": str(out), "matches_pinned_baseline": report["matches_pinned_baseline"],
                      # I3: the one fact a read-only pass can give about whether apply would refuse.
                      "ingress_shape": facts["ingress"]["shape"],
                      "ingress_shape_problems": facts["ingress"]["shape_problems"],
                      "capacity_ok": report.get("capacity_ok"), "database_ready": report["database_ready"],
                      "identity_probe_ok": "identity_probe" in report, "mismatch": report["mismatch"],
                      "database_error": report["database_error"],
                      "handling": "private evidence, mode 0600"}, indent=2))
    return 0 if ready else 3


def mode_backup(args):
    manifest, manifest_sha = load_manifest(args.manifest)
    if args.verify:
        # B4: verification is reachable after the backup exists inside the parent.
        parent = pathlib.Path(args.backup_parent).resolve(strict=True)
        target = pathlib.Path(args.verify)
        if target.is_symlink():
            raise Refuse("Backup directory may not be a symlink")
        resolved = target.resolve(strict=True)
        try:
            resolved.relative_to(parent)
        except ValueError:
            raise Refuse("The verified backup must live inside --backup-parent")
        report = verify_backup_components(str(resolved), manifest)
        print(json.dumps(dict(report, verified=True, manifest_sha256=manifest_sha,
                              must_be_under_seconds_at_apply=args.max_age), indent=2))
        return 0
    parent = pathlib.Path(args.backup_parent)
    if parent.is_symlink():
        raise Refuse("Backup parent may not be a symlink")
    if parent.exists() and any(parent.iterdir()):
        raise Refuse("Backup parent must be a fresh owned directory; existing backups are never reused, "
                     "overwritten or adopted")
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    print(json.dumps({
        "action": "run the repository's own backup procedure, unchanged",
        "command": ["python3", str(pathlib.Path(args.repo) / "scripts/ops_backup.py"), "backup",
                    "--output", str(parent.resolve())],
        "note": "ops_backup.py creates its own timestamped subdirectory, applies its own disk rule "
                "(2x data + 512 MiB) and writes manifest.json with complete/ready/git_sha/sha256/bytes. "
                "It briefly stops kin-api, kin-keycloak and kin-orthanc, then resumes them.",
        "then": ["python3", "rollout.py", "--manifest", args.manifest, "backup",
                 "--backup-parent", str(parent.resolve()), "--verify", str(parent.resolve()) + "/<created-dir>"],
        "manifest_sha256": manifest_sha,
    }, indent=2))
    return 0


def mode_build(args):
    manifest, _ = load_manifest(args.manifest)
    candidate = pathlib.Path(args.candidate_root).resolve(strict=True)
    if candidate == pathlib.Path(args.repo).resolve(strict=True):
        raise Refuse("The candidate must be built from a separate checkout, never the live repository")
    if run(["git", "rev-parse", "HEAD"], cwd=candidate) != manifest["target_sha"]:
        raise Refuse("Candidate checkout is not the pinned target")
    if run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=candidate):
        raise Refuse("Candidate checkout is dirty")
    if run(["git", "rev-parse", "HEAD:api"], cwd=candidate) != manifest["delivered_trees"]["api"]["target"]:
        raise Refuse("Candidate API tree differs from the pin")
    run(["docker", "build", "--target", "production", "--build-arg", "VCS_REF=" + manifest["target_sha"],
         "-t", args.tag, str(candidate / "api")], timeout=3600)
    image = json.loads(run(["docker", "image", "inspect", args.tag]))[0]
    config = image.get("Config") or {}
    if (config.get("Labels") or {}).get("org.opencontainers.image.revision") != manifest["target_sha"]:
        raise Refuse("Built image revision label is wrong")
    if config.get("User") != "node":
        raise Refuse("Built image does not run as node")
    receipt = {"schema": SCHEMA, "target_sha": manifest["target_sha"],
               "api_tree": manifest["delivered_trees"]["api"]["target"], "image_id": image["Id"],
               "image_tag": args.tag, "revision": manifest["target_sha"], "user": "node", "built_utc": stamp()}
    out = pathlib.Path(args.out)
    if out.exists():
        raise Refuse("Build receipt path already exists; use a fresh path")
    write_private(out, receipt)
    print(json.dumps({"written": str(out), "image_id": image["Id"], "sha256": digest_file(out)}, indent=2))
    return 0


def mode_apply(args):
    manifest, manifest_sha = load_manifest(args.manifest)
    repo = pathlib.Path(args.repo).resolve(strict=True)
    origin = manifest["live"]["origin"]

    # Every validation that can refuse happens before the lock, the record and any
    # service change (B4, B5a, B8). A refusal here leaves the host exactly as found.
    derived = rederive(repo, manifest)
    gate = gate_receipt(args.gate, args.gate_sha256, manifest, args.evidence_root)
    build = build_receipt(args.build, args.build_sha256, manifest, args.evidence_root)
    facts, untracked = fresh_facts(repo, manifest, True, args.max_hashed_rows)
    require_pinned_baseline(facts, manifest, untracked, derived)
    require_capacity(facts["database"]["capacity"])
    tables = facts["database"]["tables"]
    keys = facts["database"]["capacity"]["identity_columns"]
    # F1: prove the identity SQL and uniqueness on the real database while nothing has
    # been stopped or locked. Writers are running, so this is metadata, never a baseline.
    probe = identity_probe(tables, keys, args.max_hashed_rows)
    # Enforced before the lock: derivation alone never authorizes an operation, so the live
    # bookkeeping must reconcile with the pin.
    migration_state = verify_observed_migration_state(facts["database"]["migrations"], manifest)
    # I3: the baseline every later stage is compared against. A shape that cannot be read as
    # coherently present or coherently absent refuses here, before anything is locked or stopped.
    pre_ingress = require_coherent_ingress("pre-apply", allow_absent=args.acknowledge_absent_ingress_baseline)
    # I6: the proxy configuration is proved to parse BEFORE the lock, the writers and the checkout.
    # It used to run only after api and orthanc had been recreated, so a route file written by the
    # receiver failed at the worst possible moment.
    if not nginx_config_ok():
        raise nginx_refusal("before anything was locked, stopped or checked out")
    backup = verify_backup_components(args.backup, manifest, max_age_seconds=args.max_age)
    if facts["disk"]["repository"]["free"] < args.min_free_bytes:
        raise Refuse("Refusing to mutate with less than the required free space")
    if json.loads(run(["docker", "image", "inspect", build["image_id"]]))[0]["Id"] != build["image_id"]:
        raise Refuse("Candidate image is not present on this host")

    token = uuid.uuid4().hex
    state = {"schema": SCHEMA, "mode": "apply", "status": "LOCKED", "token": token,
             "target": manifest["target_sha"], "target_tree": manifest["target_tree"],
             "baseline": manifest["baseline_sha"], "manifest_sha256": manifest_sha,
             "previous_image": facts["containers"]["kin-api"]["image"], "candidate_image": build["image_id"],
             "backup": backup, "gate": gate, "build": build, "tables": tables, "identity_columns": keys,
             "hash_cap": args.max_hashed_rows,
             "capacity_pre_stop": facts["database"]["capacity"]["counts"],
             "identity_probe": probe,
             # I1: written with the record itself, so every later stage - including a rollback from
             # a failure inside apply - has the observation it must restore the host to.
             "ingress_baseline": pre_ingress,
             "absent_ingress_baseline_acknowledged": bool(args.acknowledge_absent_ingress_baseline),
             "nginx_config_ok_pre_apply": True,
             "started_utc": stamp()}
    record = create_record(args.record, state)
    lock = take_lock(repo, token)
    try:
        run(["docker", "tag", state["previous_image"], args.previous_tag])
        stop_writers(repo)
        # F1: the authoritative baseline is read only now, with writers stopped. The cap is
        # re-checked on these rows; legitimate writes before this point are audited, not refused.
        state["before"] = table_state(tables, keys, args.max_hashed_rows)
        state["pre_stop_drift"] = count_drift(state["capacity_pre_stop"], state["before"])
        state["migrations_before"] = migration_facts()
        state["status"] = "WRITERS_STOPPED"
        write_private(record, state)

        state["migration_state"] = migration_state
        checkout_utc = stamp()
        move_checkout(repo, manifest["target_sha"], manifest["target_tree"])
        state["checkout_utc"] = checkout_utc
        run(["docker", "tag", build["image_id"], args.compose_image_tag])
        state["migration_output"] = apply_migration(repo)
        state["after_migration"] = table_state(tables, keys)
        state["migration_preservation"] = compare_tables(state["before"], state["after_migration"], strict=True)
        state["migrations_after"] = migration_facts()
        state["migration_identity"] = require_migration_applied(
            state["migrations_before"], state["migrations_after"], manifest["migrations"]["new"])
        state["new_tables"] = sorted(set(public_tables()) - set(tables))
        state["status"] = "MIGRATED_ROWS_PRESERVED"
        write_private(record, state)

        start_services(repo)
        wait_health(origin)
        state["unauthenticated"] = unauthenticated_is_refused(origin)
        state["static"] = static_matches(repo, manifest["target_sha"], manifest, origin, args.static)
        # C8: the served /worklist/ tree is proved over HTTP above; config/ohif.js is injected by
        # the Orthanc OHIF plugin rather than byte-served, so this is its only real proof.
        state["delivered_on_disk"] = verify_delivered_on_disk(repo, manifest, state["checkout_utc"])
        # C4/I1: the ingress must be exactly what it was before the change. A difference is
        # NEEDS_ATTENTION with lock and record retained. No automatic rollback follows: it could
        # not restore external network state.
        ingress_checkpoint(record, state, "ingress_post_apply", "post-apply")
        if running_image() != build["image_id"]:
            raise Refuse("Running API is not the candidate image")
        state["applied_utc"] = stamp()
        state["status"] = "APPLIED_PENDING_AUTHENTICATED_CHECKS"
        write_private(record, state)
    except BaseException as error:
        fail(record, state, error, "apply",
             "Inspect " + str(record) + " and " + str(lock) + ". The backup at " + backup["backup"] +
             " is intact and untouched. Decide explicitly between `rollback` and roll-forward; do not "
             "delete the lock, the record or any backup.")
        raise
    print(json.dumps({"status": state["status"], "record": str(record),
                      "next": "collect authenticated read-only evidence, then run verify"}, indent=2))
    return 0


def mode_verify(args):
    manifest, _ = load_manifest(args.manifest)
    repo = pathlib.Path(args.repo).resolve(strict=True)
    record, state = owned_record(args.record, manifest, repo)
    retry = state.get("status") == "NEEDS_ATTENTION_LOCK_RETAINED" and state.get("failed_action") == "verify"
    if state.get("status") != "APPLIED_PENDING_AUTHENTICATED_CHECKS" and not retry:
        raise Refuse("Verify requires the pending-authenticated-checks state, or a previous verify failure "
                     "on this same record")
    if retry and running_image() != state["candidate_image"]:
        raise Refuse("Refusing to retry verify: the running API is no longer the candidate image recorded "
                     "by apply. Decide rollback or roll-forward explicitly.")

    # B5a: the receipt is validated BEFORE anything in the durable record changes, so a
    # typo in --evidence-sha256 or a stale file is an ordinary refusal, not a dead end.
    _path, evidence_sha, raw = safe_input(args.evidence, args.evidence_root)
    if not HASH.fullmatch(args.evidence_sha256 or "") or evidence_sha != args.evidence_sha256:
        raise Refuse("Authenticated evidence hash mismatch; nothing was changed. Re-run with the correct "
                     "--evidence-sha256.")
    body = validate_auth_body(raw, manifest, state["applied_utc"])

    try:
        state["authenticated"] = {"sha256": evidence_sha, "frame_sha256": body["frame_sha256_after"],
                                  "frame_unchanged": True, "method": body["method"],
                                  "created_utc": body["created_utc"]}
        state["final_tables"] = table_state(state["tables"], state["identity_columns"])
        state["final_preservation"] = compare_tables(state["before"], state["final_tables"], strict=False,
                                                     acknowledged=args.acknowledge_rewritten_tables)
        wait_health(manifest["live"]["origin"], seconds=60)
        state["final_unauthenticated"] = unauthenticated_is_refused(manifest["live"]["origin"])
        state["final_static"] = static_matches(repo, manifest["target_sha"], manifest,
                                               manifest["live"]["origin"], args.static)
        if running_image() != state["candidate_image"]:
            raise Refuse("Final API image identity changed")
        state["established"] = {
            "service_reachable_and_authenticating": True,
            "served_sources_match_target": True,
            "existing_row_identities_preserved": True,
            "original_frame_payload_digest_unchanged": True,
            "authenticated_read_of_existing_study": True,
            "not_established": ["MIP orientation clinical correctness", "physician acceptance",
                                "multi-monitor and accessibility use", "any regulatory judgement"],
        }
        # B3/I1: hours can pass between apply and verify, so the ingress is observed and compared
        # once more. A moved proxy, network or route mount refuses here and keeps the lock.
        ingress_checkpoint(record, state, "ingress_verify_end", "verify-end")
        state["status"] = "DEPLOYED"
        clear_terminal_annotations(state)
        state["finalized_utc"] = stamp()
        write_private(record, state)
    except BaseException as error:
        fail(record, state, error, "verify",
             "Deployment stays in its recorded state and the running image is unchanged. Correct the "
             "reported condition and re-run verify on this same record, or decide rollback explicitly. "
             "Nothing is deleted automatically.")
        raise
    if read_lock(repo) != state["token"]:
        raise Refuse("Lock ownership changed before completion")
    lock_path(repo).unlink()
    print(json.dumps({"status": "DEPLOYED", "record": str(record),
                      "not_established": state["established"]["not_established"]}, indent=2))
    return 0


def mode_rollback(args):
    manifest, _ = load_manifest(args.manifest)
    repo = pathlib.Path(args.repo).resolve(strict=True)
    record, state = owned_record(args.record, manifest, repo)
    if state.get("status") not in {"APPLIED_PENDING_AUTHENTICATED_CHECKS", "WRITERS_STOPPED",
                                   "MIGRATED_ROWS_PRESERVED", "NEEDS_ATTENTION_LOCK_RETAINED"}:
        raise Refuse("Rollback is not valid from the current durable state")
    try:
        # I5: the ingress is observed, compared and recorded before anything is decided, but a
        # difference does NOT refuse here. A rollback restores the previous api and orthanc images
        # and never touches the network, the receiver or the route mount, so an ingress change -
        # which is exactly the situation in which someone needs the previous API back - must not
        # be the reason the previous API cannot come back. Every other gate below is unchanged,
        # and rollback-end still ends in NEEDS_ATTENTION if the ingress is still different.
        ingress_checkpoint(record, state, "ingress_rollback_start", "rollback-start", enforce=False)
        compatibility = rollback_compatibility(manifest)
        state["rollback_compatibility"] = compatibility
        # B1: the decision, its counts and its sentence are durable before ANY gate can refuse and
        # before any service stops, so every record state is readable as acknowledged / not_required
        # / missing rather than silence.
        state["finding_inaccessibility_pre_stop"] = finding_ack_record(
            compatibility, args.acknowledge_finding_inaccessibility, manifest, "pre-stop")
        state["finding_inaccessibility"] = state["finding_inaccessibility_pre_stop"]
        write_private(record, state)
        if compatibility["blocking"] and not args.acknowledge_incompatible_jobs:
            write_private(record, state)
            raise Refuse(
                "Rollback refused: work exists that the previous API cannot read.\n"
                "  ViewerJob snapshot versions outside " + str(manifest["snapshot_versions"]["previous_api_accepts"])
                + ": " + json.dumps(compatibility["incompatible_viewer_jobs"]) + "\n"
                "  HangingProtocolPreference rows: " + str(compatibility["hanging_protocol"]["rows"])
                + " (" + compatibility["hanging_protocol"]["note"] + ")\n"
                "Nothing is deleted. Choose explicitly: roll forward and fix, or re-run with "
                "--acknowledge-incompatible-jobs to keep that work in place while the previous API ignores "
                "or refuses it. This script never removes rows to make a rollback succeed.")
        if compatibility["findings_blocking"] and not args.acknowledge_finding_inaccessibility:
            write_private(record, state)
            raise Refuse(
                "Rollback refused: finding data exists and the baseline has no way to reach it.\n"
                "  Finding rows: " + str(compatibility["findings"]["Finding"]["rows"]) + "\n"
                "  FindingRevision rows: " + str(compatibility["findings"]["FindingRevision"]["rows"]) + "\n"
                "Rolling back to " + manifest["baseline_sha"] + " restores an API image and a static tree "
                "that contain NO finding routes and NO finding UI. Every finding, of any schema version, "
                "becomes completely inaccessible through the product until a roll-forward. This is stricter "
                "than read-only.\n"
                "Nothing is deleted. Re-run with --acknowledge-finding-inaccessibility to record that "
                "decision. This script never deletes, resets, truncates or rewrites finding data, and it "
                "offers no database rollback.")
        # B1: the acknowledgement, its counts and its verbatim sentence are durable BEFORE any
        # service stops, so a record read at the stop boundary already states the decision.
        stop_writers(repo)
        after_quiesce = rollback_compatibility(manifest)
        state["rollback_compatibility_after_quiesce"] = after_quiesce
        if after_quiesce["blocking"] and not args.acknowledge_incompatible_jobs:
            start_services(repo)
            raise Refuse("New incompatible work appeared while quiescing; services were restarted unchanged")
        if after_quiesce["findings_blocking"] and not args.acknowledge_finding_inaccessibility:
            start_services(repo)
            raise Refuse("New finding data appeared while quiescing; services were restarted unchanged and "
                         "no row was touched. Re-run with --acknowledge-finding-inaccessibility if that "
                         "data may become unreachable until roll-forward.")
        # B1: the post-quiesce counts are the authoritative ones, written BEFORE the checkout so a
        # terminal record can never claim 0 rows while rows are actually stranded.
        state["finding_inaccessibility"] = finding_ack_record(
            after_quiesce, args.acknowledge_finding_inaccessibility, manifest, "post-quiesce-authoritative")
        write_private(record, state)
        move_checkout(repo, manifest["baseline_sha"])
        run(["docker", "tag", state["previous_image"], args.compose_image_tag])
        start_services(repo)
        wait_health(manifest["live"]["origin"])
        state["rollback_unauthenticated"] = unauthenticated_is_refused(manifest["live"]["origin"])
        # L4: verify the baseline's own served tree, which is never an empty set.
        state["rollback_static"] = static_matches(repo, manifest["baseline_sha"], manifest,
                                                  manifest["live"]["origin"], "all")
        if running_image() != state["previous_image"]:
            raise Refuse("Rolled-back API is not the exact previous image")
        # L3: a rollback from a state reached before the baseline snapshot exists cannot
        # compare rows; say so instead of raising KeyError after a successful restore.
        if state.get("before") and state.get("tables"):
            state["rollback_preservation"] = compare_tables(
                state["before"], table_state(state["tables"], state["identity_columns"]), strict=False,
                acknowledged=args.acknowledge_rewritten_tables)
        else:
            state["rollback_preservation"] = {
                "compared": False,
                "reason": "the failure preceded the baseline row snapshot, so no before-state exists; "
                          "service was restored and the database was never written by this runner"}
        # B3/I5: api and orthanc are restored first, but an ingress that is not what it was still
        # ends as NEEDS_ATTENTION with the lock and the evidence retained; the terminal status is
        # not reached and nothing about the network or the receiver is repaired automatically.
        state["rolled_back_utc"] = stamp()
        state["status"] = "ROLLED_BACK_DATABASE_RETAINED"
        clear_terminal_annotations(state)
        ingress_checkpoint(record, state, "ingress_rollback_end", "rollback-end")
        write_private(record, state)
    except BaseException as error:
        fail(record, state, error, "rollback",
             "The database and every backup are untouched. Resolve manually; do not restore a dump and do "
             "not delete the lock, record or backups.")
        raise
    if read_lock(repo) == state["token"]:
        lock_path(repo).unlink()
    print(json.dumps({"status": state["status"], "database": "retained, nothing restored or deleted",
                      "preservation": state["rollback_preservation"], "record": str(record)}, indent=2))
    return 0


def mode_status(args):
    manifest, manifest_sha = load_manifest(args.manifest)
    state = json.loads(pathlib.Path(args.record).read_text(encoding="utf-8"))
    lock = lock_path(args.repo)
    present = lock.exists()
    print(json.dumps({"status": state.get("status"), "target": state.get("target"),
                      "baseline": state.get("baseline"), "failed_action": state.get("failed_action"),
                      "manifest_matches": state.get("manifest_sha256") == manifest_sha,
                      "lock_present": present,
                      "lock_owned": present and lock.read_text(encoding="utf-8") == state.get("token"),
                      "terminal": state.get("status") in TERMINAL,
                      "manual_next_action": state.get("manual_next_action")}, indent=2))
    return 0


def comma_list(value):
    return tuple(part.strip() for part in value.split(",") if part.strip())


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--repo", default="/home/ubuntu/pacs-starter-kit")
    parser.add_argument("--evidence-root", default="/home/ubuntu")
    parser.add_argument("--home", default=None, help="writable HOME for docker build state (L1)")
    parser.add_argument("--docker-config", default=None)
    parser.add_argument("--max-hashed-rows", type=int, default=MAX_HASHED_ROWS)
    modes = parser.add_subparsers(dest="mode", required=True)

    observe = modes.add_parser("observe", help="read-only fresh metadata")
    observe.add_argument("--out", required=True)
    observe.add_argument("--no-database", action="store_true")
    observe.set_defaults(func=mode_observe)

    backup = modes.add_parser("backup", help="fresh owned backup, then verify it")
    backup.add_argument("--backup-parent", required=True)
    backup.add_argument("--verify")
    backup.add_argument("--max-age", type=int, default=3600)
    backup.set_defaults(func=mode_backup)

    build = modes.add_parser("build", help="build the candidate image from a separate checkout")
    build.add_argument("--candidate-root", required=True)
    build.add_argument("--tag", required=True)
    build.add_argument("--out", required=True)
    build.set_defaults(func=mode_build)

    apply_mode = modes.add_parser("apply", help="the cutover")
    apply_mode.add_argument("--record", required=True)
    apply_mode.add_argument("--backup", required=True)
    apply_mode.add_argument("--gate", required=True)
    apply_mode.add_argument("--gate-sha256", required=True)
    apply_mode.add_argument("--build", required=True)
    apply_mode.add_argument("--build-sha256", required=True)
    apply_mode.add_argument("--previous-tag", required=True)
    apply_mode.add_argument("--compose-image-tag", default="pacs-starter-kit-api:latest")
    apply_mode.add_argument("--static", choices=("all", "changed"), default="all")
    apply_mode.add_argument("--min-free-bytes", type=int, default=8 * 1024 ** 3)
    apply_mode.add_argument("--max-age", type=int, default=3600)
    # I3: absence is a legitimate baseline only where the ingress was never built. On the host this
    # rollout targets it was observed present, so accepting absence there must be a recorded human
    # decision rather than a silent one.
    apply_mode.add_argument("--acknowledge-absent-ingress-baseline", action="store_true",
                            help="record that the kin-workflow ingress is genuinely absent on this "
                                 "host and that its absence is the state to preserve")
    apply_mode.set_defaults(func=mode_apply)

    verify = modes.add_parser("verify", help="validate authenticated read-only evidence and finalize")
    verify.add_argument("--record", required=True)
    verify.add_argument("--evidence", required=True)
    verify.add_argument("--evidence-sha256", required=True)
    verify.add_argument("--static", choices=("all", "changed"), default="changed")
    verify.add_argument("--acknowledge-rewritten-tables", type=comma_list, default=())
    verify.set_defaults(func=mode_verify)

    rollback = modes.add_parser("rollback", help="previous image and checkout; database retained")
    rollback.add_argument("--record", required=True)
    rollback.add_argument("--compose-image-tag", default="pacs-starter-kit-api:latest")
    rollback.add_argument("--acknowledge-incompatible-jobs", action="store_true")
    # C6: findings have their own flag. The ViewerJob acknowledgement must never cover them.
    rollback.add_argument("--acknowledge-finding-inaccessibility", action="store_true",
                          help="record that every finding becomes unreachable through the product until "
                               "roll-forward; no finding row is deleted, reset or rewritten")
    rollback.add_argument("--acknowledge-rewritten-tables", type=comma_list, default=())
    rollback.set_defaults(func=mode_rollback)

    status = modes.add_parser("status", help="read-only record state")
    status.add_argument("--record", required=True)
    status.set_defaults(func=mode_status)
    return parser


def main(argv=None):
    global RUNTIME_HOME, DOCKER_CONFIG
    os.umask(0o077)
    args = build_parser().parse_args(argv)
    RUNTIME_HOME = args.home or os.environ.get("HOME") or RUNTIME_HOME
    DOCKER_CONFIG = args.docker_config
    try:
        return args.func(args)
    except Refuse as error:
        sys.stderr.write("REFUSED: " + str(error) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
