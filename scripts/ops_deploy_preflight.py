"""Read-only API deployment preflight. This never authorizes or executes deployment.

python scripts/ops_deploy_preflight.py request.json --request-sha256 <sha256>
The separately supplied hash binds bytes, not the identity/authority of an approver.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

import ops_backup as ops

COMPOSE = ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"]
PROTECTED = ["api/prisma", "keycloak", "config", "proxy", *COMPOSE]
FIELDS = {"version", "previous_sha", "target_sha", "previous_api_image", "target_api_image", "compose_files"}
SHA = re.compile(r"[0-9a-f]{40}")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
HASH = re.compile(r"[0-9a-f]{64}")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def parse_request(raw, expected_hash):
    require(isinstance(expected_hash, str) and HASH.fullmatch(expected_hash), "Invalid request hash")
    require(len(raw) <= 8192, "Request too large")
    require(hashlib.sha256(raw).hexdigest() == expected_hash, "Request hash mismatch")
    body = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    require(type(body) is dict and set(body) == FIELDS, "Unexpected request fields")
    require(type(body["version"]) is int and body["version"] == 1, "Unsupported request version")
    for field in ("previous_sha", "target_sha"):
        require(type(body[field]) is str and SHA.fullmatch(body[field]), "Invalid commit SHA")
    for field in ("previous_api_image", "target_api_image"):
        require(type(body[field]) is str and IMAGE.fullmatch(body[field]), "Expected immutable local image ID")
    require(body["compose_files"] == COMPOSE, "Base, production and monitor overlays required in order")
    require(body["previous_sha"] != body["target_sha"], "Target is already selected")
    return body


def git(*args):
    return ops.text(["git", *args], timeout=30)


def api_tree(sha):
    require(type(sha) is str and SHA.fullmatch(sha), "Invalid image revision")
    require(git("cat-file", "-t", sha) == "commit", "Expected a Git commit")
    require(git("cat-file", "-t", sha + ":api") == "tree", "Missing API tree")
    return git("rev-parse", sha + ":api")


def check_repository(body):
    previous, target = body["previous_sha"], body["target_sha"]
    require(git("rev-parse", "--show-toplevel") == str(ops.ROOT).replace("\\", "/"), "Wrong repository root")
    require(git("rev-parse", "HEAD") == previous, "Checkout SHA changed")
    require(not git("status", "--porcelain", "--untracked-files=no"), "Tracked working tree is dirty")
    trees = {sha: api_tree(sha) for sha in (previous, target)}
    for path in PROTECTED:
        # Missing paths must not make an empty diff look like proven compatibility.
        before = git("rev-parse", previous + ":" + path)
        after = git("rev-parse", target + ":" + path)
        require(before == after, "API-only compatibility boundary changed")
    return trees


def check_image(image, expected_id, expected_tree):
    require(image.get("Id") == expected_id, "Image ID mismatch")
    config = image.get("Config") or {}
    require(config.get("User") == "node", "Expected production node user")
    revision = (config.get("Labels") or {}).get("org.opencontainers.image.revision")
    require(api_tree(revision) == expected_tree, "Image revision API tree mismatch")


def check_running_api(container, expected_id):
    require(container.get("Name") == "/kin-api", "Wrong API container")
    require(container.get("Image") == expected_id, "Running API image changed")
    require((container.get("State") or {}).get("Running") is True, "API is not running")
    config = container.get("Config") or {}
    labels = config.get("Labels") or {}
    require(labels.get("com.docker.compose.project.working_dir") == str(ops.ROOT), "Wrong Compose working directory")
    require(labels.get("com.docker.compose.service") == "api", "Wrong Compose service")
    require(config.get("User") == "node", "Running API is not the production user")
    require(container.get("Mounts") == [], "API must run without host or volume overrides")
    network = container.get("NetworkSettings") or {}
    require("Ports" in network and not any((network["Ports"] or {}).values()), "API host ports are exposed or unknown")
    host = container.get("HostConfig") or {}
    require(host.get("NetworkMode") not in (None, "host") and not host.get("PortBindings"), "Unsafe API network mode or host bindings")
    env = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    require(env.get("DEPLOYMENT_MODE") == "production" and env.get("AUTH_REQUIRED") == "true", "Production authentication settings required")


def inspect_one(args):
    items = json.loads(ops.text(["docker", *args], timeout=30))
    require(type(items) is list and len(items) == 1 and type(items[0]) is dict, "Unexpected Docker inspection")
    return items[0]


def observe(body):
    """Recheck on the host; the caller must already own the operations lock."""
    ops.require_local_docker()
    trees = check_repository(body)
    for prefix in ("previous", "target"):
        identity = body[prefix + "_api_image"]
        check_image(inspect_one(["image", "inspect", identity]), identity, trees[body[prefix + "_sha"]])
    check_running_api(inspect_one(["inspect", "kin-api"]), body["previous_api_image"])
    return {"preflight_passed": True, "deployment_authorized": False,
            "automatic_rollback_authorized": False, "schema_unchanged": True,
            "previous_sha": body["previous_sha"], "target_sha": body["target_sha"],
            "target_api_image": body["target_api_image"], "compose_files": list(COMPOSE)}


def preflight(body):
    # Share the backup lock, but do not issue a token that could be reused after
    # releasing it. A future deployer must recheck and keep this lock throughout.
    with ops.lock():
        return observe(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args()
    try:
        with args.request.open("rb") as handle:
            body = parse_request(handle.read(8193), args.request_sha256)
        result = preflight(body)
    except Exception as error:
        # JSON, Docker and filesystem errors can contain supplied paths/secrets.
        print(json.dumps({"preflight_passed": False, "deployment_authorized": False,
                          "error_type": type(error).__name__}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
