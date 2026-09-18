#!/usr/bin/env python3
"""Derive the pinned Stage-1 rollout manifest from a read-only source checkout.

Reads Git objects only and writes one JSON file into the owned evidence directory.
No server, network, database, container or credential access. The runner re-derives
the same values on the server and refuses to run if they differ, so this file is a
pin to compare against, never a substitute for the server's own repository.

Usage: python3 derive-manifest.py --repo <checkout> --out <manifest.json>
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess

BASELINE = "17980d522b260b59fa97c96924f96038b63551ae"
TARGET = "5dd76a6318cb751c531b2e61f9f0d4f94577c5fd"
TARGET_TREE = "c8ec68e5ef97fddac5c2e928e1d43ead3aa4c747"

# Directories whose tree object must be IDENTICAL at baseline and target. A change
# here means the compose, auth or gateway contract moved and this rollout shape no
# longer applies. `proxy` is no longer a whole-tree member: exactly one file inside it
# moves (see DRIFT), and every OTHER file under proxy/ is pinned individually below.
PROTECTED = ("keycloak", "gateway")
PROTECTED_BLOBS = ("docker-compose.yml", "docker-compose.monitor.yml",
                   "api/Dockerfile", "api/start-production.sh", "api/package.json", "api/package-lock.json")
PROXY_ROOT = "proxy/"
# Directories this rollout is allowed to move, each pinned at both ends.
DELIVERED = ("api", "api/prisma", "api/src", "worklist-v0", "config")
# Bind-mounted into kin-orthanc but NOT byte-served, so the runner proves it on disk (C8).
DELIVERED_FILES = ("config/ohif.js",)
# Option B: these move on disk with the checkout and are delivered to no running container.
# They are pinned at both ends; any other byte set refuses before anything changes (C4).
DRIFT = ("docker-compose.prod.yml", "proxy/nginx.conf.template")
# Changed paths that reach no running container at all: test and workflow sources (C7).
DECLARED_INERT = ("tests", ".github")
# Served static root: every tracked file under it is reachable through the proxy.
STATIC_ROOT = "worklist-v0/"
STATIC_URL = "/worklist/"
VERSIONS = re.compile(r"if \(!\[([0-9,\s]+)\]\.includes\(s\.version\)")
MAIN_PUSH = re.compile(r"(?ms)^on:.*?^\s*push:\s*\n\s*branches:\s*\[\s*main\s*\]")


def git(repo, *args):
    out = subprocess.run(["git", *args], cwd=str(repo), stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, timeout=120)
    if out.returncode != 0:
        raise RuntimeError("git " + " ".join(args) + ": " + out.stderr.decode("utf-8", "replace").strip())
    return out.stdout


def text(repo, *args):
    return git(repo, *args).decode("utf-8").strip()


def lines(repo, *args):
    return [line for line in text(repo, *args).splitlines() if line]


def set_digest(items):
    """Order-independent digest of a path/object-id set, for compact comparison."""
    joined = "\n".join(sorted(items)) + "\n"
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def migration_dirs(repo, sha):
    """Migration directory names at `sha`: exactly the values Prisma writes as migration_name."""
    names = []
    for row in lines(repo, "ls-tree", sha, "api/prisma/migrations/"):
        meta, path = row.split("\t", 1)
        _mode, kind, _oid = meta.split()
        if kind == "tree":
            names.append(path.rstrip("/").split("/")[-1])
    return sorted(names)


HANGING_TABLE = "HangingProtocolPreference"


def hanging_protocol_ownership(repo, sha):
    """B2: three independent git-object facts about the baseline, not a guess."""
    migration = HANGING_TABLE.lower() in " ".join(migration_dirs(repo, sha)).replace("_", "")
    schema = "model " + HANGING_TABLE in git(repo, "show", sha + ":api/prisma/schema.prisma").decode("utf-8", "replace")
    service = HANGING_TABLE.lower() in git(repo, "show", sha + ":api/src/pacs.service.ts").decode("utf-8", "replace").lower()
    owns = bool(schema and (migration or service))
    return {"table": HANGING_TABLE, "baseline_sha": sha, "baseline_owns_table": owns,
            "evidence": {"migration_present": migration, "prisma_model_present": schema,
                         "read_by_api_source": service},
            "rule": "rows only block a rollback when the baseline does NOT own the table; otherwise "
                    "they are recorded as information"}


def rev_exists(repo, sha, path):
    return subprocess.run(["git", "rev-parse", "--verify", "--quiet", sha + ":" + path], cwd=str(repo),
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          timeout=60).returncode == 0


def classify(changed, classes):
    """C7: every changed path belongs to exactly one declared class or the derivation refuses."""
    assignment, unclassified, ambiguous = {}, [], []
    for path in sorted(set(changed)):
        owners = [name for name, entries in classes.items()
                  if any(path == entry or path.startswith(entry.rstrip("/") + "/") for entry in entries)]
        if not owners:
            unclassified.append(path)
        elif len(owners) > 1:
            ambiguous.append(path)
        else:
            assignment[path] = owners[0]
    return assignment, unclassified, ambiguous


def accepted_versions(repo, sha):
    body = git(repo, "show", sha + ":api/src/viewer-job-input.ts").decode("utf-8")
    found = VERSIONS.search(body)
    if not found:
        raise RuntimeError("Could not locate the accepted snapshot version list at " + sha)
    return [int(part) for part in found.group(1).replace(" ", "").split(",") if part]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    repo = pathlib.Path(args.repo).resolve(strict=True)

    if text(repo, "rev-parse", "HEAD") != TARGET:
        raise RuntimeError("Checkout is not the fixed final SHA")
    if text(repo, "rev-parse", "HEAD^{tree}") != TARGET_TREE:
        raise RuntimeError("Checkout tree is not the fixed final tree")
    if text(repo, "status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError("Checkout is dirty")
    for sha in (BASELINE, TARGET):
        if text(repo, "cat-file", "-t", sha) != "commit":
            raise RuntimeError("Not a commit: " + sha)
    if subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, TARGET], cwd=str(repo),
                      stdin=subprocess.DEVNULL, timeout=60).returncode != 0:
        raise RuntimeError("The live baseline is not an ancestor of the target")

    protected = {}
    for path in PROTECTED + PROTECTED_BLOBS:
        before, after = text(repo, "rev-parse", BASELINE + ":" + path), text(repo, "rev-parse", TARGET + ":" + path)
        if before != after:
            raise RuntimeError("Compatibility boundary changed: " + path)
        protected[path] = before
    # The proxy remainder: the UNION of both ends, so a file deleted or added at either end is
    # seen rather than silently skipped, and every one of them must be identical.
    proxy_paths = set(lines(repo, "ls-tree", "-r", "--name-only", BASELINE, PROXY_ROOT))
    proxy_paths |= set(lines(repo, "ls-tree", "-r", "--name-only", TARGET, PROXY_ROOT))
    for path in sorted(proxy_paths - set(DRIFT)):
        before = text(repo, "rev-parse", BASELINE + ":" + path) if rev_exists(repo, BASELINE, path) else None
        after = text(repo, "rev-parse", TARGET + ":" + path) if rev_exists(repo, TARGET, path) else None
        if before is None or after is None or before != after:
            raise RuntimeError("Proxy file outside the declared drift moved, was added or was deleted: " + path)
        protected[path] = before
    delivered = {path: {"baseline": text(repo, "rev-parse", BASELINE + ":" + path),
                        "target": text(repo, "rev-parse", TARGET + ":" + path)} for path in DELIVERED}
    drift = {}
    for path in DRIFT:
        before, after = text(repo, "rev-parse", BASELINE + ":" + path), text(repo, "rev-parse", TARGET + ":" + path)
        drift[path] = {
            "baseline": before, "target": after,
            "baseline_sha256": hashlib.sha256(git(repo, "cat-file", "blob", before)).hexdigest(),
            "target_sha256": hashlib.sha256(git(repo, "cat-file", "blob", after)).hexdigest(),
            "delivered_to_running_container": False,
        }
    delivered_files = {path: hashlib.sha256(
        git(repo, "cat-file", "blob", text(repo, "rev-parse", TARGET + ":" + path))).hexdigest()
        for path in DELIVERED_FILES}

    static = []
    for row in lines(repo, "ls-tree", "-r", TARGET, STATIC_ROOT):
        meta, path = row.split("\t", 1)
        mode, kind, blob = meta.split()
        if kind != "blob" or mode != "100644":
            raise RuntimeError("Unexpected served object: " + path)
        static.append([path, blob, STATIC_URL + path[len(STATIC_ROOT):]])
    changed_static = set(lines(repo, "diff", "--name-only", BASELINE, TARGET, "--", STATIC_ROOT))

    added = lines(repo, "diff", "--name-only", "--diff-filter=A", BASELINE, TARGET)
    deleted = lines(repo, "diff", "--name-only", "--diff-filter=D", BASELINE, TARGET)
    modified = lines(repo, "diff", "--name-only", "--diff-filter=M", BASELINE, TARGET)

    changed_all = lines(repo, "diff", "--name-only", BASELINE, TARGET)
    classes = {"delivered": [path for path in DELIVERED if path != "api"] + list(DELIVERED_FILES) + ["api/src", "api/prisma"],
               "drift": list(DRIFT), "declared_inert": list(DECLARED_INERT)}
    assignment, unclassified, ambiguous = classify(changed_all, classes)
    if unclassified or ambiguous:
        raise RuntimeError("Changed paths are not classified exactly once. unclassified=" + json.dumps(unclassified)
                           + " ambiguous=" + json.dumps(ambiguous))

    base_migrations = set(lines(repo, "ls-tree", "--name-only", BASELINE, "api/prisma/migrations/"))
    target_migrations = set(lines(repo, "ls-tree", "--name-only", TARGET, "api/prisma/migrations/"))
    if not base_migrations <= target_migrations:
        raise RuntimeError("A migration present at the live baseline is missing from the target")
    new_migrations = sorted(name.rstrip("/").split("/")[-1] for name in target_migrations - base_migrations)
    migration_sql = {}
    for name in new_migrations:
        body = git(repo, "show", TARGET + ":api/prisma/migrations/" + name + "/migration.sql").decode("utf-8")
        migration_sql[name] = {
            "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            "statements": sorted({word for word in ("CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX",
                                                    "ALTER TABLE", "DROP TABLE", "DROP INDEX", "DROP COLUMN",
                                                    "SET NOT NULL", "TRUNCATE", "DELETE FROM", "UPDATE ")
                                 if word in body.upper()}),
            "additive_only": not any(word in body.upper() for word in
                                     ("DROP TABLE", "DROP COLUMN", "TRUNCATE", "DELETE FROM", "UPDATE ", "ALTER TABLE")),
        }

    required_workflows = []
    for row in lines(repo, "ls-tree", "-r", "--name-only", TARGET, ".github/workflows/"):
        body = git(repo, "show", TARGET + ":" + row).decode("utf-8")
        if MAIN_PUSH.search(body):
            required_workflows.append(row)
    if not required_workflows:
        raise RuntimeError("No workflow triggers on push to main; the gate set cannot be derived")

    manifest = {
        "schema": 1,
        "purpose": "Pinned inputs for the Stage-1 rollout runner. Preparation only; not an authorization to deploy.",
        "baseline_sha": BASELINE,
        "target_sha": TARGET,
        "target_tree": TARGET_TREE,
        "live": {
            "host_repository": "/home/ubuntu/pacs-starter-kit",
            "previous_api_image": "sha256:24380d3d02423824345ceac12ea3b3d2f76568bb437d319ef748b8773cc3a131",
            "previous_api_revision": BASELINE,
            "previous_api_user": "node",
            "origin": "https://pacs.koreaimagingnetwork.com",
            "containers": ["kin-proxy", "kin-orthanc", "kin-db", "kin-keycloak", "kin-api"],
            "source": "evidence/stage1-server-access/verify-01/execution.json, rollout_status DEPLOYED, "
                      "observed.image_id and observed.revision at 2026-09-16T23:58:13Z",
            "delivery": {"services": ["api", "orthanc"], "running_proxy": "untouched",
                         "reason": "config/ohif.js and worklist-v0 are bind-mounted into orthanc; the proxy "
                                   "template is baked into the proxy image and is not delivered"},
        },
        "compatibility_boundary_unchanged": protected,
        "delivered_trees": delivered,
        "delivered_files_sha256": delivered_files,
        "drift_pins": drift,
        "change_classes": {
            "delivered": classes["delivered"], "drift": classes["drift"],
            "declared_inert": classes["declared_inert"],
            "changed_count": len(changed_all),
            "changed_sha256": set_digest(changed_all),
            "counts": {name: sum(1 for value in assignment.values() if value == name)
                       for name in ("delivered", "drift", "declared_inert")},
            "rule": "The FULL baseline..target diff, additions and deletions included, must be classified "
                    "exactly once. declared_inert paths reach no running container. Anything unclassified "
                    "refuses here and again in the runner.",
        },
        "static": {
            "root": STATIC_ROOT,
            "url_prefix": STATIC_URL,
            "count": len(static),
            "changed_count": len(changed_static),
            "set_sha256": set_digest(path + " " + blob for path, blob, _ in static),
            "paths": static,
        },
        "delta": {
            "added_count": len(added), "modified_count": len(modified), "deleted_count": len(deleted),
            "added_sha256": set_digest(added),
            "added_paths": added,
            "deleted_paths": deleted,
        },
        "migrations": {
            "baseline_count": len(base_migrations),
            "target_count": len(target_migrations),
            # Tree entries only: migration_lock.toml is a blob in the same directory and is
            # never a _prisma_migrations row, so it must not inflate the reconciliation.
            "baseline_names": migration_dirs(repo, BASELINE),
            "target_names": migration_dirs(repo, TARGET),
            "baseline_migration_count": len(migration_dirs(repo, BASELINE)),
            "new": new_migrations,
            "detail": migration_sql,
            "observed_state_rule": "The runner reads _prisma_migrations and refuses on a duplicate, a "
                                   "missing baseline name, a row the target does not contain, an unfinished "
                                   "or rolled-back row, or a pending set that is not exactly `new`. This "
                                   "derivation alone never authorizes an operation.",
        },
        # B2: does the BASELINE itself own HangingProtocolPreference? Derived from git objects, not
        # assumed. When it does, existing preference rows are ordinary data the baseline API reads,
        # and a rollback must not call them incompatible work.
        "hanging_protocol": hanging_protocol_ownership(repo, BASELINE),
        "snapshot_versions": {
            "previous_api_accepts": accepted_versions(repo, BASELINE),
            "target_api_accepts": accepted_versions(repo, TARGET),
        },
        "gate": {
            "required_workflows": sorted(required_workflows),
            "derivation": "Workflow files at the target that trigger on push to branch main. Dispatch-only "
                          "workflows (candidate, isolated integration) are candidate evidence, not the main gate.",
            "receipt_blocks_required": ["workflows", "checks", "candidate", "independent_review_refs",
                                        "release_tag"],
            "all_runs_rule": "Every workflow run recorded for the target head SHA must be success, not only "
                             "the required ones; the adapter includes every run and drops none.",
            "candidate_rule": "candidate.tree must equal target_tree and candidate.conclusion must be success. "
                              "Candidate counts are candidate evidence and never substitute for the main gate.",
            "independent_review_rule": "independent_review_refs must name at least one accepted independent review.",
            "release_tag_rule": "release_tag is mandatory: annotated, remote_verified, peeled_sha == target_sha, and "
                                "tag CI matched from the raw run export with tag_ci_head_sha == target_sha and every "
                                "required workflow's tag run completed/success. There is no untagged path: a null "
                                "tag and any user_decision_ref are refused. Prior main CI never substitutes for a "
                                "failed tag CI.",
        },
        "backup": {
            "procedure": "scripts/ops_backup.py backup --output <fresh owned parent>",
            "components": ["kin.dump", "keycloak.dump", "orthanc.tgz", ".env",
                           "docker-compose.yml", "docker-compose.prod.yml"],
            "disk_rule": "ops_backup.py requires free >= 2*(orthanc volume bytes + kin+keycloak database bytes) + 512 MiB",
        },
    }
    out = pathlib.Path(args.out)
    with out.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(manifest, stream, ensure_ascii=True, indent=2, sort_keys=False)
        stream.write("\n")
    print(json.dumps({
        "written": str(out),
        "static_files": manifest["static"]["count"],
        "static_changed": manifest["static"]["changed_count"],
        "added": manifest["delta"]["added_count"],
        "modified": manifest["delta"]["modified_count"],
        "deleted": manifest["delta"]["deleted_count"],
        "new_migrations": manifest["migrations"]["new"],
        "change_classes": manifest["change_classes"]["counts"],
        "drift_pins": sorted(manifest["drift_pins"]),
        "delivered_files": sorted(manifest["delivered_files_sha256"]),
        "previous_api_accepts": manifest["snapshot_versions"]["previous_api_accepts"],
        "target_api_accepts": manifest["snapshot_versions"]["target_api_accepts"],
        "required_workflows": manifest["gate"]["required_workflows"],
    }, indent=2))


if __name__ == "__main__":
    main()
