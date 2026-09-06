"""C1 synchronous deployment contract core; no operational adapter or apply CLI.

Adapters are trusted installed code, never modules/commands selected by a request.
Synthetic adapters live only in tests. This library is not an authorization boundary.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
import hashlib
import sys
from typing import Protocol

import ops_backup as ops
import ops_deploy_preflight as pre


@dataclass(frozen=True)
class Plan:
    request_sha256: str
    previous_sha: str
    target_sha: str
    previous_api_image: str
    target_api_image: str

    def request(self):
        return {"version": 1, "previous_sha": self.previous_sha, "target_sha": self.target_sha,
                "previous_api_image": self.previous_api_image, "target_api_image": self.target_api_image,
                "compose_files": list(pre.COMPOSE)}


@dataclass(frozen=True)
class AuthorizedPlan(Plan):
    approval_sha256: str
    restore_sha256: str
    compatibility_sha256: str


class Adapter(Protocol):
    """Site integration must implement bounded calls and durable private records.

    authorize verifies and consumes one approval bound to this request and verifies
    the referenced offsite restore and data compatibility evidence. A hash alone
    is not proof. observe must call pre.observe while this core owns the lock.
    apply_api returns settled=True only after all mutation work has terminated.
    record returns only after durable persistence. notify_failure accepts delivery
    into the existing fixed channel; acceptance does not prove inbox receipt.
    """
    def authorize(self, plan: Plan) -> dict: ...
    def observe(self, plan: Plan) -> dict: ...
    def record(self, event: dict) -> None: ...
    def apply_api(self, sha: str, image: str) -> dict: ...
    def smoke(self, sha: str, image: str) -> dict: ...
    def notify_failure(self, event: dict) -> bool: ...


def make_plan(raw, expected_hash):
    body = pre.parse_request(raw, expected_hash)
    return Plan(hashlib.sha256(raw).hexdigest(), *(body[key] for key in (
        "previous_sha", "target_sha", "previous_api_image", "target_api_image")))


def check_authorization(receipt, plan):
    keys = {"request_sha256", "approval_sha256", "restore_sha256", "compatibility_sha256", "consumed"}
    pre.require(type(receipt) is dict and set(receipt) == keys, "Invalid authorization receipt")
    pre.require(receipt["request_sha256"] == plan.request_sha256 and receipt["consumed"] is True,
                "Authorization is not bound and consumed")
    for key in keys - {"consumed"}:
        pre.require(type(receipt[key]) is str and pre.HASH.fullmatch(receipt[key]), "Invalid evidence identity")
    return AuthorizedPlan(**asdict(plan), **{key: receipt[key] for key in (
        "approval_sha256", "restore_sha256", "compatibility_sha256")})


def check_observation(result, plan):
    expected = {"preflight_passed": True, "deployment_authorized": False,
                "automatic_rollback_authorized": False, "schema_unchanged": True,
                "previous_sha": plan.previous_sha, "target_sha": plan.target_sha,
                "target_api_image": plan.target_api_image, "compose_files": list(pre.COMPOSE)}
    pre.require(type(result) is dict and set(result) == set(expected), "Invalid preflight observation")
    pre.require(all(type(result[key]) is type(value) and result[key] == value
                    for key, value in expected.items()), "Preflight observation changed")


def mutation_result(value):
    # An exception/malformed return cannot tell us whether the Docker operation
    # stopped. Only an explicit, completed operation permits any subsequent one.
    pre.require(type(value) is dict and set(value) == {"settled", "succeeded"}, "Unknown mutation state")
    pre.require(value["settled"] is True and type(value["succeeded"]) is bool, "Mutation has not settled")
    return value["succeeded"]


def smoke_passed(value, sha, image):
    expected = {"sha": sha, "image": image, "health": True, "auth": True, "image_read": True}
    return (type(value) is dict and set(value) == set(expected)
            and all(type(value[key]) is type(item) and value[key] == item for key, item in expected.items()))


def event_for(plan, status, stage, retained, notification="not_required"):
    identity = hashlib.sha256(f"{plan.request_sha256}:{status}:{stage}".encode("ascii")).hexdigest()
    return {"version": 1, "event_id": identity, **asdict(plan), "status": status, "stage": stage,
            "lock_retained": retained, "notification": notification}


def finish(adapter, plan, lease, status, stage, *, safe):
    failed = status != "DEPLOYED"
    result = event_for(plan, status, stage, not safe, "pending" if failed else "not_required")
    # Persist pending before delivery. If the process dies immediately after SMTP
    # acceptance, the fixed channel can retry the same request-bound event.
    try:
        adapter.record(dict(result))
    except Exception:
        lease.retained = True
        result = event_for(plan, "NEEDS_ATTENTION", "record", True, "pending")
        try:
            adapter.notify_failure(dict(result))
        except Exception:
            pass
        return result
    if failed:
        try:
            accepted = adapter.notify_failure(dict(result)) is True
        except Exception:
            accepted = False
        if accepted:
            result["notification"] = "accepted"
            try:
                adapter.record(dict(result))
            except Exception:
                lease.retained = True
                return event_for(plan, "NEEDS_ATTENTION", "record", True, "pending")
    lease.retained = not safe
    return result


def run_locked(plan, adapter, lease):
    stage = "authorize"
    try:
        plan = check_authorization(adapter.authorize(plan), plan)
        stage = "observe"
        check_observation(adapter.observe(plan), plan)
    except Exception:
        return finish(adapter, plan, lease, "REJECTED", stage, safe=True)

    lease.retained = True
    try:
        adapter.record(event_for(plan, "STARTED", "apply", True))
    except Exception:
        return finish(adapter, plan, lease, "NEEDS_ATTENTION", "record", safe=False)

    try:
        applied = mutation_result(adapter.apply_api(plan.target_sha, plan.target_api_image))
    except Exception:
        return finish(adapter, plan, lease, "NEEDS_ATTENTION", "apply", safe=False)

    stage = "apply"
    if applied:
        stage = "smoke"
        try:
            healthy = smoke_passed(adapter.smoke(plan.target_sha, plan.target_api_image),
                                   plan.target_sha, plan.target_api_image)
        except Exception:
            healthy = False
        if healthy:
            return finish(adapter, plan, lease, "DEPLOYED", "complete", safe=True)

    # Both applications use the unchanged schema, and the trusted authorization
    # gate has verified prior-app data compatibility. Never restore a database.
    try:
        adapter.record(event_for(plan, "ROLLING_BACK", stage, True, "pending"))
    except Exception:
        return finish(adapter, plan, lease, "NEEDS_ATTENTION", "record", safe=False)
    try:
        restored = mutation_result(adapter.apply_api(plan.previous_sha, plan.previous_api_image))
    except Exception:
        return finish(adapter, plan, lease, "NEEDS_ATTENTION", "rollback", safe=False)
    if not restored:
        return finish(adapter, plan, lease, "NEEDS_ATTENTION", "rollback", safe=False)
    try:
        healthy = smoke_passed(adapter.smoke(plan.previous_sha, plan.previous_api_image),
                               plan.previous_sha, plan.previous_api_image)
    except Exception:
        healthy = False
    if not healthy:
        return finish(adapter, plan, lease, "NEEDS_ATTENTION", "rollback_smoke", safe=False)
    return finish(adapter, plan, lease, "ROLLED_BACK", stage, safe=True)


def execute(raw, expected_hash, adapter: Adapter):
    """Invalid input/lock contention raise before any adapter call or mutation.

    Only DEPLOYED means success. REJECTED/ROLLED_BACK remain failed deployments;
    NEEDS_ATTENTION keeps the lock. Never delete such a lock on a timer or retry.
    """
    plan = make_plan(raw, expected_hash)
    with ops.lock() as lease:
        return run_locked(plan, adapter, lease)


if __name__ == "__main__":
    print("No operational adapter installed; deployment CLI is unavailable.", file=sys.stderr)
    sys.exit(2)
