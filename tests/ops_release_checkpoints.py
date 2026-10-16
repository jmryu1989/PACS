"""RELEASE-TOOLS-CHECKPOINTS (Astra spec D1336, order D1338): resumable checkpoints for the synthetic release-tools
rehearsal (tests/ops_deploy_host_container_test.py). Test harness only; scripts/** stays untouched (D73).

A checkpoint is taken only at a NORMAL product phase boundary (source-b0, seeded, held, introduced, verified, and the
separate forced-failure lineage's failure-held), after the stack's own services were stopped normally (proxy, api,
keycloak, orthanc, then the database last). It is a private cold bundle: the declared volumes, the fixture tree (the
checkout with its own Git objects, the records and their sibling secrets, the operations lock, the ComposeEntry
generations, the backup root with its audit ledger, the CA, the overlays) and an identity that binds the actual bytes it
was made from. It is never `docker commit`, never a mid-phase state, and never B0/B1 promoted to another phase.

Consumption is never a fresh end-to-end pass: a same-tree resume reuses the original plan and state bytes
(execution_kind=checkpoint-resume, fresh_e2e=false); a changed tool tree is admitted only when its exact difference lies
inside the five allowed late HostOps bodies and the suffix re-runs their first affected phase, and it then runs as a
synthetic diagnostic fork (child plan with the actual B tool, new ComposeEntry generation, empty child history, no
receipt; fresh_e2e=false, release_gate_eligible=false). The cross-tree admission compares raw source bytes on purpose:
it is a cache-admission contract that proves the already executed prefix is byte-identical, not a pin of product
behaviour (AGENTS.md section 1-B, item 14).

Docker and Compose commands are built and run only by the explicit adapter in tests/ops_deploy_host_container_test.py;
this module coordinates through a backend object (a fake one in the pure tests). Live checkpoints are refused on
Windows and Docker Desktop (UNSUPPORTED_HOST): v1 supports a native Linux synthetic host only.
"""
from __future__ import annotations

import argparse
import ast
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import ntpath
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import posixpath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))
import ops_emr_introduction as intro  # noqa: E402

SCHEMA = 1
REQUEST_ENV = "KIN_TEST_EMR_CHECKPOINT_REQUEST"
OPT_IN_ENV = "KIN_TEST_EMR_CHECKPOINTS"
LIVE_FILE = "tests/ops_release_checkpoints_live_test.py"
REHEARSAL_FILE = "tests/ops_deploy_host_container_test.py"
PRODUCT_FILE = "scripts/ops_emr_introduction.py"
HASH = re.compile(r"[0-9a-f]{64}")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
TTL = timedelta(hours=8)
MAX_ATTEMPTS, MAX_ATTEMPT_SECONDS = 3, 3600
MIN_HOST_RAM = 10 * 1024 ** 3
EXECUTION_KINDS = ("fresh", "checkpoint-resume", "diagnostic-fork", "reseed-from-recorded-b0")
SCENARIOS = {"normal": ("source", "seed", "capture", "introduce", "verify", "normal-tail"),
             "forward": ("source", "seed", "capture", "introduce", "verify", "forward-tail"),
             "forced": ("forced-capture", "forced-tail")}
PROOF_CASES = {"CheckpointSegments.test_original_late_fault": "forward-tail",
               "CheckpointSegments.test_late_change_resume": "verify",
               "CheckpointSegments.test_earlier_change_refused": "verify"}
# What each proof case runs after its stage, and the outcome its segment must show (anything else is not the proof).
PROOF_THEN = {"CheckpointSegments.test_late_change_resume": ("forward-tail",)}
PROOF_OUTCOMES = {"CheckpointSegments.test_original_late_fault": {"outcome": "STOP", "step": "L-11a"},
                  "CheckpointSegments.test_earlier_change_refused": {"outcome": "REFUSED", "code": "PREFIX_CHANGED"}}
# The harness files every leaf reads besides its plan, request, registry, source manifest and parent manifest; with
# `scripts` as a tree (the runner, the recorder and the product tool) they are the recorder inputs of every leaf.
LEAF_INPUT_FILES = ("tests/ops_release_checkpoints.py", "tests/ops_release_checkpoints_live_test.py",
                    "tests/ops_deploy_host_container_test.py", "tests/ops_deploy_host_test.py", "tests/live_test_gate.py")
LEAF_INPUT_TREES = ("scripts",)
CONTEXT_FILE = "checkpoint-context.json"
SECRETS_INVENTORY = "checkpoint-secrets-inventory.json"
CONTEXT_KEYS = {"previous_sha", "target_sha", "images", "legacy", "members", "b0", "copy_dir", "production_plan", "stacks"}
# The fixture stack whose product state a checkpoint carries.
LINEAGE_STACK = {"source-b0": "source", "seeded": "clone", "held": "clone", "introduced": "clone", "verified": "clone",
                 "failure-held": "failure"}
# Environment that selects another Docker endpoint or client configuration. Compose calls run without DOCKER_*/COMPOSE_*,
# raw calls inherit them: a checkpoint stage refuses any of them so that every call reaches the one observed daemon.
ENDPOINT_SELECTORS = ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")
RUNTIME_KEYS = ("python", "docker_server", "compose", "playwright", "chromium", "arch")
FORWARD_REQUIRED_TRUE = ("health", "migrations_after", "smoke_member_absent", "ordinary_entry_images")
FRESH_CASES = {
    "normal": "EmrIntroductionRehearsal.test_emr_introduction_rehearsal_seed_capture_introduce_verify_rollback_receipt",
    "forced": "EmrIntroductionRehearsal.test_emr_introduction_rehearsal_forced_l09b_failure_rolls_back_with_kept_values_and_the_pinned_overlay",
    "forward": "EmrIntroductionRehearsal.test_emr_introduction_rehearsal_forward_entry_after_reopen"}

# The completed product boundaries a checkpoint may be taken at (spec section 2). `boundary` is the last step of the
# phase whose product checkpoint contract (intro.checkpoint_valid) the restored stack must satisfy again.
CHECKPOINTS = {
    "source-b0": {"lineage": "source", "status": "HELD", "phase": "capture", "boundary": "L-04c", "next": ("seed",),
                  "cross_tree": False, "order": 0, "lock": True, "volumes": False},
    "seeded": {"lineage": "normal", "status": "SEEDED", "phase": "seed", "boundary": "S-03", "next": ("capture",),
               "cross_tree": False, "order": 1, "lock": False, "volumes": True},
    "held": {"lineage": "normal", "status": "HELD", "phase": "capture", "boundary": "L-04c", "next": ("introduce",),
             "cross_tree": True, "order": 2, "lock": True, "volumes": True},
    "introduced": {"lineage": "normal", "status": "INTRODUCED", "phase": "introduce", "boundary": "L-09b", "next": ("verify",),
                   "cross_tree": True, "order": 3, "lock": True, "volumes": True},
    "verified": {"lineage": "normal", "status": "VERIFIED", "phase": "verify", "boundary": "L-10e", "next": ("rollback", "reopen"),
                 "cross_tree": False, "order": 4, "lock": True, "volumes": True},
    "failure-held": {"lineage": "forced", "status": "HELD", "phase": "capture", "boundary": "L-04c", "next": ("introduce",),
                     "cross_tree": True, "order": 2, "lock": True, "volumes": True},
}
# The fixed stage selectors (no DAG or workflow engine): what each stage consumes, produces and runs.
STAGES = {
    "source": {"case": "CheckpointSegments.test_source_checkpoint", "consumes": None, "produces": "source-b0", "phases": ("capture",)},
    "seed": {"case": "CheckpointSegments.test_seed_checkpoint", "consumes": "source-b0", "produces": "seeded", "phases": ("seed",)},
    "capture": {"case": "CheckpointSegments.test_capture_checkpoint", "consumes": "seeded", "produces": "held", "phases": ("capture",)},
    "introduce": {"case": "CheckpointSegments.test_introduce_checkpoint", "consumes": "held", "produces": "introduced",
                  "phases": ("introduce",)},
    "verify": {"case": "CheckpointSegments.test_verify_checkpoint", "consumes": "introduced", "produces": "verified", "phases": ("verify",)},
    "normal-tail": {"case": "CheckpointSegments.test_normal_tail", "consumes": "verified", "produces": None,
                    "phases": ("rollback", "rollback_reopen", "receipt")},
    "forward-tail": {"case": "CheckpointSegments.test_forward_tail", "consumes": "verified", "produces": None, "phases": ("reopen",)},
    "forced-capture": {"case": "CheckpointSegments.test_forced_capture", "consumes": None, "produces": "failure-held",
                       "phases": ("capture",)},
    "forced-tail": {"case": "CheckpointSegments.test_forced_tail", "consumes": "failure-held", "produces": None,
                    "phases": ("introduce", "rollback_reopen")},
}
# The five late HostOps bodies a changed tool may differ in (spec section 4): the first phase each affects and the
# latest checkpoint a fork may start from. Every other difference invalidates every checkpoint.
ALLOWLIST = {
    "HostOps.proxy_ui": {"earliest_phase": "introduce", "latest": ("held", "failure-held")},
    "HostOps.fenced_smoke": {"earliest_phase": "verify", "latest": ("introduced",)},
    "HostOps.probe": {"earliest_phase": "verify", "latest": ("introduced",)},
    "HostOps.final_allowlist": {"earliest_phase": "reopen", "latest": ("introduced",)},
    "HostOps.backup_readiness": {"earliest_phase": "reopen", "latest": ("introduced",)},
}
PHASE_ORDER = {"seed": 0, "capture": 1, "introduce": 2, "verify": 3, "reopen": 4, "rollback": 4}
VOLUME_CATEGORIES = ("pg", "orthanc", "emr_access", "emr_state", "proxy_certs")
BINDINGS = ("state", "result", "secrets", "compose_entry", "ledger", "lock", "context")
# The one declared link of a volume payload: PostgreSQL's tablespace link into the emr-access mount (exact contract).
DECLARED_LINKS = {"pg": (re.compile(r"pg_tblspc/[0-9]{1,10}"), intro.TABLESPACE)}
# Writable-layer paths a stopped container may differ in and that its image regenerates (pid/cache/log/tmp). Anything
# else is persistent state outside the declared volumes and binds, which v1 refuses (spec section 3).
TRANSIENT_PATHS = ("/tmp", "/run", "/var/run", "/var/tmp", "/var/cache/nginx", "/var/log/nginx", "/opt/keycloak/data/tmp",
                   "/home/node/.npm", "/root/.npm", "/root/.cache")
IDENTITY_FIELDS = ("tool_tree_sha256_at_checkpoint", "tool_tree_sha256_at_resume", "source_tree_sha256", "harness_tree_sha256",
                   "tool_files_actual_raw_sha256", "source_b0_manifest_sha256", "clone_b0_manifest_sha256",
                   "payload_manifest_sha256", "image_ids", "plan_sha256", "target_manifest_sha256", "phase_reached",
                   "created_utc", "resumed_utc", "host_key_sha256", "daemon_identity", "absolute_fixture_root",
                   "runtime_identity", "segment_source_map")
# Same-tree resume: every field but the resume-time facts and the bundle's own payload hash (verified on load).
RESUME_COMPARED = ("tool_tree_sha256_at_checkpoint", "source_tree_sha256", "harness_tree_sha256", "tool_files_actual_raw_sha256",
                   "source_b0_manifest_sha256", "clone_b0_manifest_sha256", "image_ids", "plan_sha256", "target_manifest_sha256",
                   "host_key_sha256", "daemon_identity", "absolute_fixture_root", "runtime_identity")
HARNESS_FILES = ("tests/ops_release_checkpoints.py", "tests/ops_release_checkpoints_live_test.py", "tests/ops_deploy_host_container_test.py",
                 "tests/ops_deploy_host_test.py", "tests/live_test_gate.py", "scripts/run-tests.py", "scripts/record-run.py")
# The nine T16/T17 leaves, in execution order. `source` names the frozen source copy a leaf runs from (a: input A with
# the deterministic L-11a STOP, b: the unmodified candidate B, c: input C with HostOps.prepare changed); `parent` names
# the registered leaf whose sealed checkpoint this leaf consumes (its stage produces what this stage consumes). The
# parent map is explicit: late-fault takes A's verified, late-resume and early-refusal take A's introduced (never "the
# previous leaf"), and the fresh control has no parent.
DEFAULT_PROOF_LEAVES = (
    {"unit": "release-tools-checkpoints-proof-prefix-source", "file": LIVE_FILE, "case": STAGES["source"]["case"],
     "scenario": "forward", "stage": "source", "execution_kind": "fresh", "proof": "T16", "source": "a", "parent": None},
    {"unit": "release-tools-checkpoints-proof-prefix-seed", "file": LIVE_FILE, "case": STAGES["seed"]["case"],
     "scenario": "forward", "stage": "seed", "execution_kind": "reseed-from-recorded-b0", "proof": "T16", "source": "a",
     "parent": "release-tools-checkpoints-proof-prefix-source"},
    {"unit": "release-tools-checkpoints-proof-prefix-capture", "file": LIVE_FILE, "case": STAGES["capture"]["case"],
     "scenario": "forward", "stage": "capture", "execution_kind": "checkpoint-resume", "proof": "T16", "source": "a",
     "parent": "release-tools-checkpoints-proof-prefix-seed"},
    {"unit": "release-tools-checkpoints-proof-prefix-introduce", "file": LIVE_FILE, "case": STAGES["introduce"]["case"],
     "scenario": "forward", "stage": "introduce", "execution_kind": "checkpoint-resume", "proof": "T16", "source": "a",
     "parent": "release-tools-checkpoints-proof-prefix-capture"},
    {"unit": "release-tools-checkpoints-proof-prefix-verify", "file": LIVE_FILE, "case": STAGES["verify"]["case"],
     "scenario": "forward", "stage": "verify", "execution_kind": "checkpoint-resume", "proof": "T16", "source": "a",
     "parent": "release-tools-checkpoints-proof-prefix-introduce"},
    {"unit": "release-tools-checkpoints-proof-late-fault", "file": LIVE_FILE, "case": "CheckpointSegments.test_original_late_fault",
     "scenario": "forward", "stage": "forward-tail", "execution_kind": "checkpoint-resume", "proof": "T16", "source": "a",
     "parent": "release-tools-checkpoints-proof-prefix-verify"},
    {"unit": "release-tools-checkpoints-proof-late-resume", "file": LIVE_FILE, "case": "CheckpointSegments.test_late_change_resume",
     "scenario": "forward", "stage": "verify", "execution_kind": "diagnostic-fork", "proof": "T16", "source": "b",
     "parent": "release-tools-checkpoints-proof-prefix-introduce"},
    {"unit": "release-tools-checkpoints-proof-fresh-control", "file": REHEARSAL_FILE, "case": FRESH_CASES["forward"],
     "scenario": "forward", "stage": None, "execution_kind": "fresh", "proof": "T16", "source": "b", "parent": None},
    {"unit": "release-tools-checkpoints-proof-early-refusal", "file": LIVE_FILE, "case": "CheckpointSegments.test_earlier_change_refused",
     "scenario": "forward", "stage": "verify", "execution_kind": "diagnostic-fork", "proof": "T17", "source": "c",
     "parent": "release-tools-checkpoints-proof-prefix-introduce"},
)
# The frozen source copies of the proofs (tests/ops_release_checkpoints.py source-copy --mutant ...).
PROOF_SOURCES = {"a": "backup-readiness-stop", "b": None, "c": "prepare-change"}


class Refused(RuntimeError):
    """A checkpoint operation refused before (or instead of) acting; `code` names the contract."""

    def __init__(self, code, detail=""):
        super().__init__(code + (": " + detail if detail else ""))
        self.code = code


def require(condition, code, detail=""):
    if not condition:
        raise Refused(code, detail)


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def utc(value):
    """A timezone-aware UTC instant; naive or malformed times are refused (never assumed)."""
    try:
        stamp = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    except (TypeError, ValueError):
        raise Refused("TIME_INVALID", repr(value)[:80]) from None
    require(stamp.tzinfo is not None and stamp.utcoffset() is not None, "TIME_INVALID", "naive time")
    return stamp.astimezone(timezone.utc)


def now_utc():
    return datetime.now(timezone.utc)


# ── boundary admission (T01) ──

def boundary_publishable(checkpoint_id, *, state, result, result_raw, snapshot=None, plan=None, target=None, pending_browsers=0):
    """A checkpoint is published only for a completed, quiet, pre-PONR phase boundary: the phase's own PASS result
    (every step of the product's STEPS table, nothing partial), its history entry bound to that result file, no running
    phase, no UNKNOWN hold, no unsettled worker or browser, and (when a snapshot is given) the product's own boundary
    contract. A bare status string is never enough; a HELD that a failure returned to is not a boundary."""
    require(checkpoint_id in CHECKPOINTS, "NOT_A_BOUNDARY", str(checkpoint_id))
    spec = CHECKPOINTS[checkpoint_id]
    require(type(state) is dict and type(result) is dict and type(result_raw) is bytes, "NOT_A_BOUNDARY", "incomplete facts")
    require(result.get("phase") == spec["phase"] and result.get("status") == spec["status"], "NOT_A_BOUNDARY", "result phase/status")
    expected = [sid for sid, _, _, _ in intro.STEPS[spec["phase"]]]
    steps = result.get("steps") or []
    require([step.get("step") for step in steps] == expected and all(step.get("outcome") == "PASS" for step in steps),
            "NOT_A_BOUNDARY", "steps are not the complete PASS sequence")
    require(state.get("status") == spec["status"] and state.get("running") is None and state.get("unknown_hold") is None,
            "NOT_A_BOUNDARY", "state is running, held UNKNOWN or another status")
    require(state.get("ponr") is None and state.get("receipt") is None and not state.get("rollback_attempted"),
            "NOT_A_BOUNDARY", "past the point of no return or a recovery/receipt state")
    history = state.get("history") or []
    require(history and history[-1].get("phase") == spec["phase"] and history[-1].get("status") == "PASS"
            and history[-1].get("request_sha256") == result.get("request_sha256")
            and history[-1].get("result_sha256") == sha256(result_raw)
            and history[-1].get("steps") == [[sid, "PASS"] for sid in expected], "NOT_A_BOUNDARY", "history does not bind the PASS result")
    require(all(row.get("state") == "QUIET" for row in (state.get("workers") or {}).values()) and pending_browsers == 0,
            "NOT_A_BOUNDARY", "a worker or browser is unsettled")
    require(bool(state.get("lock_token")) is spec["lock"], "NOT_A_BOUNDARY", "lock ownership")
    if snapshot is not None:
        boundary_contract(checkpoint_id, snapshot, state=state, plan=plan, target=target)
    return {"checkpoint": checkpoint_id, "status": spec["status"], "boundary": spec["boundary"],
            "request_sha256": result["request_sha256"], "result_sha256": sha256(result_raw)}


def boundary_contract(checkpoint_id, snapshot, *, state, plan, target):
    """The product's own boundary contract (intro.checkpoint_valid) for the phase's last step, over an observation.
    The seed phase releases the operations lock when it ends, while the product contract describes the step end inside
    the phase (lock held): for that boundary the released lock is checked here (not owned, no token) and every other
    clause still comes from the product function; capture's own entry check re-runs the whole contract under its lock."""
    spec = CHECKPOINTS[checkpoint_id]
    require(plan is not None and target is not None, "NOT_A_BOUNDARY", "a snapshot needs its plan and target")
    context = type("Boundary", (), {})()
    context.state, context.plan, context.target = state, plan, target
    observation = snapshot
    if not spec["lock"]:
        require(intro.workers_quiet(snapshot) and snapshot["facts"]["lock"]["value"]["owned"] is False and not state.get("lock_token"),
                "NOT_A_BOUNDARY", "the released lock is still owned or the observation is incomplete")
        observation = copy.deepcopy(snapshot)
        observation["facts"]["lock"]["value"]["owned"] = True
        context.state = {**state, "lock_token": "released-at-phase-end"}
    try:
        intro.checkpoint_valid(observation, context, spec["boundary"])
    except intro.Stop as error:
        raise Refused("NOT_A_BOUNDARY", "product boundary contract: " + str(error)) from None
    return True


# ── actual-bytes identity (T03) ──

def tree_manifest(root, files):
    """[[relative path, sha256 of the raw bytes]] sorted, for exactly the listed files: a missing, unreadable, linked or
    duplicate input is a refusal (never an omission). No LF normalisation, no Git object IDs."""
    root = Path(root)
    seen, rows = set(), []
    for name in files:
        rel = PurePosixPath(str(name).replace("\\", "/"))
        require(not rel.is_absolute() and ".." not in rel.parts and str(rel) not in (".", ""), "INPUT_INVALID", str(name))
        key = rel.as_posix()
        require(key not in seen, "INPUT_DUPLICATE", key)
        seen.add(key)
        path = root / key
        try:
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode), "INPUT_INVALID", key + " is not a regular file")
            raw = path.read_bytes()
        except FileNotFoundError:
            raise Refused("INPUT_MISSING", key) from None
        except OSError as error:
            raise Refused("INPUT_UNREADABLE", key + " " + type(error).__name__) from None
        rows.append([key, sha256(raw)])
    rows.sort()
    return {"files": rows, "sha256": sha256(canonical(rows))}


def tree_manifest_from_bytes(files):
    """The same canonical rows for {relative path: raw bytes} held in memory (a bundle's tool-tree member)."""
    rows = sorted([PurePosixPath(name).as_posix(), sha256(raw)] for name, raw in files.items())
    require(len({name for name, _ in rows}) == len(rows), "INPUT_DUPLICATE", "tool tree")
    return {"files": rows, "sha256": sha256(canonical(rows))}


def tracked_files(root, prefix=None):
    """The source's tracked paths (Git index of the frozen copy); untracked helpers must be listed explicitly."""
    args = ["git", "-C", str(root), "ls-files", "-z"] + (["--", prefix] if prefix else [])
    listing = subprocess.run(args, capture_output=True, check=True, timeout=60).stdout.decode("utf-8")
    return [name for name in listing.split("\0") if name]


def source_identity(root, *, helpers=()):
    """Tool tree (every tracked scripts/** file plus explicit helpers), the rest of the tracked source, the harness inputs
    and the eight product TOOL_FILES, each from the actual bytes on disk."""
    tracked = tracked_files(root)
    tool = [name for name in tracked if name.startswith("scripts/")] + list(helpers)
    rest = [name for name in tracked if not name.startswith("scripts/")]
    return {"tool": tree_manifest(root, tool), "source": tree_manifest(root, rest),
            "harness": tree_manifest(root, HARNESS_FILES), "tool_files": tool_files_raw(root)}


def tool_files_raw(root):
    scripts = Path(root) / "scripts"
    out = {}
    for name in intro.TOOL_FILES:
        try:
            out[name] = sha256((scripts / name).read_bytes())
        except OSError:
            raise Refused("INPUT_MISSING", "scripts/" + name) from None
    return out


def unchanged(manifest, root):
    """Pre/post comparison: recompute the same file list from the actual bytes now."""
    again = tree_manifest(root, [name for name, _ in manifest["files"]])
    require(again == manifest, "SOURCE_CHANGED", "inputs changed during the run")
    return again


def identity_valid(identity, *, at_resume=False):
    require(type(identity) is dict and set(identity) >= set(IDENTITY_FIELDS), "IDENTITY_INVALID", "missing fields")
    for key in ("tool_tree_sha256_at_checkpoint", "source_tree_sha256", "harness_tree_sha256", "payload_manifest_sha256",
                "plan_sha256", "target_manifest_sha256", "host_key_sha256"):
        require(type(identity[key]) is str and HASH.fullmatch(identity[key]) is not None, "IDENTITY_INVALID", key)
    for key in ("source_b0_manifest_sha256", "clone_b0_manifest_sha256"):
        require(identity[key] is None or (type(identity[key]) is str and HASH.fullmatch(identity[key])), "IDENTITY_INVALID", key)
    require(type(identity["tool_files_actual_raw_sha256"]) is dict
            and set(identity["tool_files_actual_raw_sha256"]) == set(intro.TOOL_FILES), "IDENTITY_INVALID", "tool files")
    images = identity["image_ids"]
    require(type(images) is dict and images, "IDENTITY_INVALID", "image_ids")
    for side, value in images.items():
        flat = value.values() if type(value) is dict else [value]
        require(all(type(item) is str and IMAGE_ID.fullmatch(item) for item in flat), "IDENTITY_INVALID", "image_ids." + side)
    require(identity["phase_reached"] in CHECKPOINTS, "IDENTITY_INVALID", "phase_reached")
    utc(identity["created_utc"])
    require(type(identity["daemon_identity"]) is str and identity["daemon_identity"], "IDENTITY_INVALID", "daemon_identity")
    root = identity["absolute_fixture_root"]
    require(type(root) is str and (PurePosixPath(root).is_absolute() or Path(root).is_absolute()), "IDENTITY_INVALID",
            "absolute_fixture_root")
    require(type(identity["runtime_identity"]) is dict and type(identity["segment_source_map"]) is dict, "IDENTITY_INVALID", "runtime")
    if at_resume:
        require(type(identity["tool_tree_sha256_at_resume"]) is str and HASH.fullmatch(identity["tool_tree_sha256_at_resume"]),
                "IDENTITY_INVALID", "tool_tree_sha256_at_resume")
        utc(identity["resumed_utc"])
    else:
        require(identity["tool_tree_sha256_at_resume"] is None and identity["resumed_utc"] is None, "IDENTITY_INVALID", "resume fields")
    return identity


def identity_mismatches(recorded, observed, fields=RESUME_COMPARED):
    """Field by field; source and clone B0 are separate fields, never one set."""
    return [key for key in fields if recorded.get(key) != observed.get(key)]


def admit_same_tree(manifest, observed, *, source_root=None, helpers=()):
    """Same-tool resume: every bound input equal. With the executing source root the tool, source and harness trees are
    recomputed here from the actual bytes, so a caller's claimed hash never stands in for them. Returns the resume
    identity (fresh=false)."""
    recorded = identity_valid(manifest["identity"])
    identity_valid({**observed, "tool_tree_sha256_at_resume": None, "resumed_utc": None})
    if source_root is not None:
        actual = source_identity(source_root, helpers=helpers)
        require(actual["tool"]["sha256"] == observed["tool_tree_sha256_at_checkpoint"]
                and actual["source"]["sha256"] == observed["source_tree_sha256"]
                and actual["harness"]["sha256"] == observed["harness_tree_sha256"]
                and actual["tool_files"] == observed["tool_files_actual_raw_sha256"], "IDENTITY_MISMATCH",
                "claimed source identity differs from the actual bytes")
    mismatched = identity_mismatches(recorded, observed)
    require(not mismatched, "IDENTITY_MISMATCH", ",".join(mismatched))
    return {**recorded, "tool_tree_sha256_at_resume": observed["tool_tree_sha256_at_checkpoint"], "resumed_utc": now_utc().isoformat()}


# ── cross-tree impact admission (T04) ──

def _function_bodies(text, tree):
    """{qualified name: (start offset, end offset)} of every top-level function and top-level class method body."""
    starts = [0]
    for line in text.splitlines(keepends=True):
        starts.append(starts[-1] + len(line))

    def offset(line, column):
        # ast columns are UTF-8 byte offsets; convert within the line.
        raw = text[starts[line - 1]:starts[line]].encode("utf-8")
        return starts[line - 1] + len(raw[:column].decode("utf-8", errors="strict"))

    bodies, counts = {}, {}
    for node in tree.body:
        functions = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append((node.name, node))
        elif isinstance(node, ast.ClassDef):
            functions += [(node.name + "." + item.name, item) for item in node.body
                          if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for name, function in functions:
            counts[name] = counts.get(name, 0) + 1
            key = name if counts[name] == 1 else name + "#" + str(counts[name])
            first, last = function.body[0], function.body[-1]
            bodies[key] = (offset(first.lineno, first.col_offset), offset(last.end_lineno, last.end_col_offset))
    return bodies


def _skeleton(text, bodies):
    pieces, position = [], 0
    for name, (start, end) in sorted(bodies.items(), key=lambda item: item[1][0]):
        pieces.append(text[position:start])
        pieces.append("\0" + name + "\0")
        position = end
    pieces.append(text[position:])
    return "".join(pieces)


def classify_change(old_files, new_files):
    """Exact difference between two tool trees ({relative path: raw bytes}). Changed function bodies are named; any
    difference outside a function body (imports, constants, decorators, signatures, defaults, comments between
    functions, added/removed functions, other files) is UNCLASSIFIED."""
    changed, prefix, unclassified = [], [], []
    for name in sorted(set(old_files) | set(new_files)):
        old, new = old_files.get(name), new_files.get(name)
        if old == new:
            continue
        if name != PRODUCT_FILE or old is None or new is None:
            unclassified.append(name)
            continue
        try:
            old_text, new_text = old.decode("utf-8"), new.decode("utf-8")
            old_bodies = _function_bodies(old_text, ast.parse(old_text))
            new_bodies = _function_bodies(new_text, ast.parse(new_text))
        except (SyntaxError, UnicodeDecodeError, ValueError):
            unclassified.append(name + ": unparsable")
            continue
        if set(old_bodies) != set(new_bodies) or _skeleton(old_text, old_bodies) != _skeleton(new_text, new_bodies):
            unclassified.append(name + ": outside a function body")
            continue
        for body in sorted(old_bodies):
            if old_text[slice(*old_bodies[body])] != new_text[slice(*new_bodies[body])]:
                (changed if body in ALLOWLIST else prefix).append(body)
    return {"changed_bodies": changed, "prefix": prefix, "unclassified": unclassified}


def allowed_checkpoints(body):
    """A body's latest allowed checkpoint and the earlier cross-tree checkpoints of the same lineage."""
    latest = ALLOWLIST[body]["latest"]
    out = set(latest)
    for name in latest:
        spec = CHECKPOINTS[name]
        out |= {other for other, item in CHECKPOINTS.items()
                if item["cross_tree"] and item["lineage"] == spec["lineage"] and item["order"] <= spec["order"]}
    return out


def admit_changed_tree(checkpoint_id, classification, *, suffix_phases, harness_changed=False, source_changed=False,
                       parent_derived=False, parent_manifest_sha256=None, old_tool=None, new_tool=None):
    """Before any restore, volume or phase: the cross-tree fork admission (spec section 4). Returns admission.json."""
    require(checkpoint_id in CHECKPOINTS, "NOT_A_BOUNDARY", str(checkpoint_id))
    require(not harness_changed, "HARNESS_CHANGED", "the harness or the allowlist changed")
    require(not source_changed, "UNCLASSIFIED_CHANGE", "tracked source outside scripts/ changed")
    require(not classification["unclassified"], "UNCLASSIFIED_CHANGE", ",".join(classification["unclassified"]))
    require(not classification["prefix"], "PREFIX_CHANGED", ",".join(classification["prefix"]))
    bodies = classification["changed_bodies"]
    require(bodies, "UNCLASSIFIED_CHANGE", "the tool tree differs without a classified body change")
    require(checkpoint_id != "verified", "VERIFIED_PLAN_BINDING",
            "the verify smoke binds the parent plan; choose introduced and re-run verify under the new plan")
    require(not parent_derived, "DERIVED_DONOR", "a derived checkpoint is never the parent of another fork")
    require(CHECKPOINTS[checkpoint_id]["cross_tree"], "CROSS_TREE_REFUSED", checkpoint_id + " resumes with the same tool only")
    for body in bodies:
        require(checkpoint_id in allowed_checkpoints(body), "PREFIX_CHANGED",
                body + " already ran before " + checkpoint_id)
    earliest = {ALLOWLIST[body]["earliest_phase"] for body in bodies}
    require(earliest <= set(suffix_phases), "SUFFIX_INCOMPLETE",
            "the suffix must re-run " + ",".join(sorted(earliest - set(suffix_phases))))
    return {"schema": SCHEMA, "kind": "checkpoint-admission", "checkpoint": checkpoint_id, "execution_kind": "diagnostic-fork",
            "fresh_e2e": False, "release_gate_eligible": False, "changed_bodies": sorted(bodies),
            "earliest_phase": min(earliest, key=PHASE_ORDER.__getitem__), "suffix_phases": list(suffix_phases),
            "parent_manifest_sha256": parent_manifest_sha256, "tool_tree_sha256": {"parent": old_tool, "child": new_tool},
            "max_tree_transitions": 1, "admitted_utc": now_utc().isoformat()}


def admit_resume(manifest, observed, *, old_tool_files, new_tool_files, suffix_phases, parent_manifest_sha256, source_root=None):
    """One entry for both resume kinds: same actual tool tree -> checkpoint-resume; otherwise the fork admission."""
    recorded = identity_valid(manifest["identity"])
    if observed["tool_tree_sha256_at_checkpoint"] == recorded["tool_tree_sha256_at_checkpoint"]:
        return {"execution_kind": "checkpoint-resume", "identity": admit_same_tree(manifest, observed, source_root=source_root)}
    if source_root is not None:
        actual = source_identity(source_root)
        require(actual["tool"]["sha256"] == observed["tool_tree_sha256_at_checkpoint"], "IDENTITY_MISMATCH",
                "claimed tool tree differs from the actual bytes")
        require({name: sha256(raw) for name, raw in new_tool_files.items()} == dict(actual["tool"]["files"]), "IDENTITY_MISMATCH",
                "the compared tool files are not the executing bytes")
    others = [key for key in RESUME_COMPARED if key not in ("tool_tree_sha256_at_checkpoint", "tool_files_actual_raw_sha256",
                                                           "source_tree_sha256", "harness_tree_sha256", "plan_sha256")]
    mismatched = identity_mismatches(recorded, observed, others)
    require(not mismatched, "IDENTITY_MISMATCH", ",".join(mismatched))
    classification = classify_change(old_tool_files, new_tool_files)
    admission = admit_changed_tree(manifest["checkpoint"], classification, suffix_phases=suffix_phases,
                                   harness_changed=observed["harness_tree_sha256"] != recorded["harness_tree_sha256"],
                                   source_changed=observed["source_tree_sha256"] != recorded["source_tree_sha256"],
                                   parent_derived=bool(manifest.get("derived")), parent_manifest_sha256=parent_manifest_sha256,
                                   old_tool=recorded["tool_tree_sha256_at_checkpoint"], new_tool=observed["tool_tree_sha256_at_checkpoint"])
    return {"execution_kind": "diagnostic-fork", "admission": admission}


def resume_or_refuse(manifest, observed, *, restore, **admission):
    """Admission strictly before restore: a refusal leaves the bundle, the daemon and the fixture root untouched."""
    decision = admit_resume(manifest, observed, **admission)
    return decision, restore(decision)


# ── diagnostic fork projection (T05/T06) ──

def fork_plan(parent_plan, child_tool):
    """Only `tool` changes, to the actual B dictionary; the canonical plan identity is recomputed by the product."""
    require(type(child_tool) is dict and set(child_tool) == set(intro.TOOL_FILES), "FORK_REFUSED", "child tool hashes")
    require(child_tool != parent_plan["tool"], "FORK_REFUSED", "the child tool equals the parent tool")
    child = copy.deepcopy(parent_plan)
    child["tool"] = dict(child_tool)
    try:
        intro.plan_valid(child)
    except intro.Stop as error:
        raise Refused("FORK_REFUSED", str(error)) from None
    require({key for key in child if child[key] != parent_plan[key]} == {"tool"}, "FORK_REFUSED", "plan fields beyond tool")
    return child, intro.plan_identity(child)


def fork_compose_entry(entry_root, parent_pointer, *, parent_plan_sha256, child_plan_sha256, validate):
    """A new generation for the child plan from the parent generation's pinned bytes (sources, inputs.env, values,
    runtime) through the product's ComposeEntry.publish; the parent generation's bytes stay as they were."""
    entry = intro.ComposeEntry(entry_root)
    pointer, manifest, values = entry.load({key: parent_pointer[key] for key in ("generation", "sha256")})
    require(manifest["plan_sha256"] == parent_plan_sha256, "FORK_REFUSED", "the parent entry belongs to another plan")
    directory = entry.root / pointer["generation"]
    before = {path.name: sha256(path.read_bytes()) for path in sorted(directory.iterdir())}
    sources = [(row["logical"], (directory / row["pinned"]).read_bytes()) for row in manifest["logical_files"]]
    child = entry.publish(repository=Path(manifest["repository"]), project=manifest["project"], sources=sources,
                          env_raw=(directory / "inputs.env").read_bytes(), values=values,
                          runtime=(directory / "runtime.yml").read_bytes().decode("utf-8"),
                          plan_sha256=child_plan_sha256, validate=validate)
    require({path.name: sha256(path.read_bytes()) for path in sorted(directory.iterdir())} == before, "FORK_REFUSED",
            "the parent generation changed")
    require(child["generation"] != pointer["generation"], "FORK_REFUSED", "the child generation is the parent's")
    return child


def fork_state(parent_state, *, checkpoint_id, child_plan_sha256, child_pointer):
    """The real boundary state with the child plan hash and entry pointer; history starts empty (the inherited history
    stays in the parent lineage). Flags, status, lock, data, smoke member and worker facts are kept as observed."""
    spec = CHECKPOINTS[checkpoint_id]
    require(spec["cross_tree"] and checkpoint_id != "verified", "FORK_REFUSED", "no fork from " + checkpoint_id)
    require(parent_state.get("status") == spec["status"] and parent_state.get("running") is None
            and parent_state.get("unknown_hold") is None and parent_state.get("ponr") is None, "FORK_REFUSED", "not a quiet boundary")
    require(parent_state.get("receipt") is None and parent_state.get("operator_smoke") is None, "FORK_REFUSED",
            "the boundary already carries an operator smoke or a receipt of the parent plan")
    require(parent_state.get("compose_entry"), "FORK_REFUSED", "no persistent Compose entry")
    child = copy.deepcopy(parent_state)
    child["plan_sha256"] = child_plan_sha256
    child["history"] = []
    child["compose_entry"] = {**child_pointer, "root": parent_state["compose_entry"]["root"]}
    return child


def receipt_refused(state, plan, plan_sha256, records):
    """The product's own make_receipt over a child state: an empty history cannot prove a full rehearsal."""
    holder = type("Child", (), {})()
    holder.state, holder.plan, holder.plan_sha256, holder.records, holder.host_key = state, plan, plan_sha256, records, "0" * 64
    holder.now = now_utc
    try:
        intro.make_receipt(holder)
    except intro.Stop:
        return True
    return False


# ── private cold bundle (T02) ──

def _private_dir(path):
    path.mkdir(mode=0o700)
    if os.name == "posix":
        path.chmod(0o700)


def _fsync_dir(path):
    if os.name == "posix":
        descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _nested(a, b):
    a, b = Path(a).resolve(), Path(b).resolve()
    return a == b or a in b.parents or b in a.parents


class BundleStore:
    """Bundles under one private root, outside every fixture and evidence root. A bundle is written into
    `.partial-<token>`, its members fsynced, then manifest.json last, and only then renamed to the manifest's sha256.
    A `.partial-*` is never consumed and an existing bundle is never rewritten."""

    def __init__(self, root, *, forbidden=(), faults=None):
        self.root = Path(root)
        require(self.root.is_absolute(), "BUNDLE_INVALID", "bundle root must be absolute")
        for other in forbidden:
            require(not _nested(self.root, other), "BUNDLE_INVALID", "bundle root overlaps " + str(other))
        if not self.root.exists():
            self.root.mkdir(mode=0o700, parents=True)
        self.faults = faults or (lambda point: None)

    def begin(self, checkpoint_id):
        require(checkpoint_id in CHECKPOINTS, "NOT_A_BOUNDARY", str(checkpoint_id))
        pending = self.root / (".partial-" + checkpoint_id + "-" + uuid.uuid4().hex)
        _private_dir(pending)
        _private_dir(pending / "payload")
        return PendingBundle(self, checkpoint_id, pending)

    def load(self, digest):
        require(type(digest) is str and HASH.fullmatch(digest) is not None, "BUNDLE_INVALID", "bundle name")
        return load_bundle(self.root / digest)


class PendingBundle:
    def __init__(self, store, checkpoint_id, directory):
        self.store, self.checkpoint, self.directory = store, checkpoint_id, directory
        self.members, self.absent = [], []

    def add(self, name, category, source):
        """Copy one member (a path or bytes) into the payload and fsync it; the hash is of the bytes written."""
        require(re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,80}", name) is not None and name not in {m["name"] for m in self.members},
                "BUNDLE_INVALID", "member name " + name)
        self.store.faults("member:" + name)
        target = self.directory / "payload" / name
        digest, size = hashlib.sha256(), 0
        with open(target, "xb") as out:
            if os.name == "posix":
                os.chmod(target, 0o600)
            stream = io.BytesIO(source) if isinstance(source, bytes) else open(source, "rb")
            with stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    out.write(block)
                    digest.update(block)
                    size += len(block)
            out.flush()
            os.fsync(out.fileno())
        self.members.append({"name": name, "category": category, "sha256": digest.hexdigest(), "bytes": size})
        return self.members[-1]

    def declare_absent(self, category):
        require(category in VOLUME_CATEGORIES and category not in self.absent, "BUNDLE_INVALID", "absent " + category)
        self.absent.append(category)

    def seal(self, *, identity, boundary, bindings, owned, execution_kind, parent=None, derived=False):
        payload = sorted(self.members, key=lambda m: m["name"])
        manifest = {"schema": SCHEMA, "kind": "release-tools-checkpoint", "checkpoint": self.checkpoint,
                    "lineage": CHECKPOINTS[self.checkpoint]["lineage"], "members": payload, "absent": sorted(self.absent),
                    "identity": {**identity, "payload_manifest_sha256": sha256(canonical(payload)), "phase_reached": self.checkpoint},
                    "boundary": boundary, "bindings": bindings, "owned": owned, "execution_kind": execution_kind,
                    "fresh_e2e": False, "release_gate_eligible": False, "parent": parent, "derived": derived}
        manifest_complete(manifest)
        self.store.faults("manifest")
        raw = canonical(manifest) + b"\n"
        path = self.directory / "manifest.json"
        with open(path, "xb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        if os.name == "posix":
            os.chmod(path, 0o600)
        _fsync_dir(self.directory / "payload")
        _fsync_dir(self.directory)
        self.store.faults("rename")
        final = self.store.root / sha256(raw)
        require(not final.exists(), "BUNDLE_INVALID", "a bundle is never rewritten")
        os.replace(self.directory, final)
        _fsync_dir(self.store.root)
        return final


def manifest_complete(manifest):
    """Every required category is present: volumes as payload or declared absent, and the fixture bindings."""
    spec = CHECKPOINTS.get(manifest.get("checkpoint"))
    require(spec is not None, "BUNDLE_INVALID", "checkpoint")
    categories = {member["category"] for member in manifest["members"]}
    require("fixture-tree" in categories, "BUNDLE_INVALID", "fixture tree missing")
    if spec["volumes"]:
        for category in VOLUME_CATEGORIES:
            listed = ("volume:" + category in categories) + (category in manifest["absent"])
            require(listed == 1, "BUNDLE_INVALID", "volume " + category + " neither captured nor declared absent")
    required = [name for name in BINDINGS if name != "lock" or spec["lock"]]
    bindings = manifest.get("bindings") or {}
    for name in required:
        require(type(bindings.get(name)) is dict and HASH.fullmatch(str(bindings[name].get("sha256"))) is not None
                and type(bindings[name].get("path")) is str, "BUNDLE_INVALID", "binding " + name + " missing")
    if not spec["lock"]:
        require("lock" not in bindings, "BUNDLE_INVALID", "a lock at a boundary that released it")
    return manifest


def load_bundle(directory):
    """Verify a sealed bundle completely before anything is restored from it."""
    directory = Path(directory)
    require(not directory.name.startswith(".partial-"), "PARTIAL_BUNDLE", "an interrupted bundle is never consumed")
    try:
        raw = (directory / "manifest.json").read_bytes()
    except OSError:
        raise Refused("BUNDLE_INVALID", "manifest missing") from None
    require(sha256(raw) == directory.name, "BUNDLE_INVALID", "manifest hash differs from the bundle name")
    try:
        manifest = json.loads(raw)
    except ValueError:
        raise Refused("BUNDLE_INVALID", "manifest JSON") from None
    require(raw == canonical(manifest) + b"\n", "BUNDLE_INVALID", "manifest is not canonical")
    manifest_complete(manifest)
    payload = directory / "payload"
    listed = {member["name"]: member for member in manifest["members"]}
    require(len(listed) == len(manifest["members"]), "BUNDLE_INVALID", "duplicate member")
    present = sorted(path.name for path in payload.iterdir()) if payload.is_dir() else []
    require(present == sorted(listed), "BUNDLE_INVALID", "payload inventory differs from the manifest")
    for name, member in listed.items():
        path = payload / name
        require(not path.is_symlink() and path.is_file(), "BUNDLE_INVALID", name + " is not a regular file")
        digest = hashlib.sha256()
        with open(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        require(digest.hexdigest() == member["sha256"], "BUNDLE_INVALID", "member hash " + name)
    require(sha256(canonical(sorted(manifest["members"], key=lambda m: m["name"]))) == manifest["identity"]["payload_manifest_sha256"],
            "BUNDLE_INVALID", "payload manifest hash")
    for member in manifest["members"]:
        if member["name"].endswith(".tar"):
            category = member["category"].split(":", 1)[-1]
            archive_members(payload / member["name"], category=category)
    # The bound fixture files are re-read from the fixture member itself, not trusted from the manifest's own claims.
    check_bindings(payload / "fixture-tree.tar", manifest["bindings"], required=sorted(manifest["bindings"]))
    return manifest, directory


def archive_members(path, *, category=None):
    """Validate a tar archive's members with the standard library before any extraction: no absolute or parent paths,
    no device/FIFO/hardlink members, no undeclared link and nothing beneath a link. The whole archive is judged first
    (normalised path set, link set), so a duplicate path, a path listed twice with two types, or a member listed before
    the link it lies under refuses whatever the member order. Returns the validated members.
    This guards the harness's own bundles against honest mistakes and damage; it does not claim to defend against a
    deliberate same-account forgery (spec section 3)."""
    declared = DECLARED_LINKS.get(category)
    try:
        with tarfile.open(path, "r:") as archive:
            members = archive.getmembers()
    except (tarfile.TarError, OSError) as error:
        raise Refused("ARCHIVE_INVALID", type(error).__name__) from None
    names, links, normalised = set(), set(), []
    for member in members:
        name = member.name[2:] if member.name.startswith("./") else member.name
        if name.rstrip("/") in ("", "."):
            require(member.isdir(), "ARCHIVE_INVALID", "root entry")
            key = "."
        else:
            require("\\" not in name, "ARCHIVE_INVALID", "path " + name)
            pure = PurePosixPath(name)
            require(not pure.is_absolute() and ".." not in pure.parts, "ARCHIVE_INVALID", "path " + name)
            key = pure.as_posix()
        require(key not in names, "ARCHIVE_INVALID", "duplicate member " + key)
        names.add(key)
        if member.issym():
            require(declared is not None and declared[0].fullmatch(key) is not None and member.linkname == declared[1],
                    "ARCHIVE_INVALID", "undeclared link " + key)
            links.add(key)
        else:
            require(member.isfile() or member.isdir(), "ARCHIVE_INVALID", "unsupported member " + key)
        normalised.append((key, member))
    for key, member in normalised:
        if key != ".":
            require(not any(parent.as_posix() in links for parent in PurePosixPath(key).parents), "ARCHIVE_INVALID",
                    "member under a link " + key)
    return [member for _, member in normalised]


def write_tree_archive(root, destination, *, exclude=()):
    """The fixture tree as an uncompressed tar with numeric owners and modes; links and special files refuse."""
    root = Path(root)
    with tarfile.open(destination, "x:", format=tarfile.PAX_FORMAT) as archive:
        for current, directories, files in os.walk(root):
            directories.sort()
            base = Path(current)
            for name in sorted(directories) + sorted(files):
                path = base / name
                rel = path.relative_to(root).as_posix()
                if any(rel == item or rel.startswith(item + "/") for item in exclude):
                    continue
                info = path.lstat()
                require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), "ARCHIVE_INVALID", "link or special file " + rel)
                archive.add(str(path), arcname=rel, recursive=False)
    return destination


def extract_tree(archive_path, destination):
    """Restore the fixture tree into an empty owned directory at the recorded absolute path."""
    destination = Path(destination)
    require(not destination.exists() or not any(destination.iterdir()), "RESOURCE_EXISTS", "fixture root is not empty")
    members = archive_members(archive_path)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:") as archive:
        archive.extractall(destination, members=members, filter="tar", numeric_owner=True)
    return destination


def tree_member_sha256(archive_path, name):
    with tarfile.open(archive_path, "r:") as archive:
        try:
            member = archive.getmember(name)
        except KeyError:
            return None
        handle = archive.extractfile(member)
        return None if handle is None else sha256(handle.read())


def check_bindings(archive_path, bindings, *, required):
    """The fixture tree carries the bound state, result, secrets, Compose entry, ledger, lock and context bytes."""
    for name in required:
        binding = bindings.get(name)
        require(binding is not None, "BUNDLE_INVALID", "binding " + name + " missing")
        require(tree_member_sha256(archive_path, binding["path"]) == binding["sha256"], "BUNDLE_INVALID", "binding " + name + " differs")


def tree_member_bytes(archive_path, name):
    with tarfile.open(archive_path, "r:") as archive:
        try:
            member = archive.getmember(name)
        except KeyError:
            return None
        handle = archive.extractfile(member)
        return None if handle is None else handle.read()


def _inside(value, root, what):
    """The relative path of an absolute fixture path; anything outside the checkpoint's absolute root refuses. Both are
    absolute and normalised first ('..' collapsed, in the root's own path flavour), then compared component by component:
    a lexical prefix such as <root>/../elsewhere is outside (CKPT2-04). No link race defence (D557)."""
    require(type(value) is str and value, "PLAN_INPUT_OUTSIDE", what)
    require(type(root) is str and root, "PLAN_INPUT_OUTSIDE", "fixture root")
    windows = re.match(r"[A-Za-z]:[\\/]", root) is not None
    module, flavour = (ntpath, PureWindowsPath) if windows else (posixpath, PurePosixPath)
    require(flavour(root).is_absolute(), "PLAN_INPUT_OUTSIDE", "the fixture root " + root + " is not absolute")
    require(flavour(value).is_absolute(), "PLAN_INPUT_OUTSIDE", what + " " + value + " is not absolute")
    base, path = flavour(module.normpath(root)), flavour(module.normpath(value))
    fold = (lambda parts: [part.lower() for part in parts]) if windows else list
    require(fold(path.parts[:len(base.parts)]) == fold(base.parts), "PLAN_INPUT_OUTSIDE",
            what + " " + value + " lies outside the fixture root")
    return path.relative_to(base).as_posix()


def bundle_inputs(manifest, bundle_dir):
    """Before any restore: recompute the plan, target and both B0 identities from the actual bytes inside the fixture
    member and compare them with the manifest identity, the stack descriptor and the bound state (never one claimed hash
    against another). Every plan-dependent path must lie inside the absolute fixture root the bundle carries; another
    input refuses (PLAN_INPUT_OUTSIDE). Returns the recomputed facts."""
    identity, checkpoint = manifest["identity"], manifest["checkpoint"]
    tree = Path(bundle_dir) / "payload" / "fixture-tree.tar"
    root = identity["absolute_fixture_root"]

    def member(rel, what):
        raw = tree_member_bytes(tree, rel)
        require(raw is not None, "BUNDLE_INPUT_MISMATCH", what + " missing from the fixture member: " + rel)
        return raw

    def document(rel, what):
        try:
            return json.loads(member(rel, what))
        except ValueError:
            raise Refused("BUNDLE_INPUT_MISMATCH", what + " is not JSON") from None

    context = document(manifest["bindings"]["context"]["path"], "context")
    require(type(context) is dict and set(context) == CONTEXT_KEYS, "BUNDLE_INPUT_MISMATCH", "context keys")
    descriptor = (context["stacks"] or {}).get(LINEAGE_STACK[checkpoint])
    require(type(descriptor) is dict and type(descriptor.get("plan_document")) is dict, "BUNDLE_INPUT_MISMATCH",
            "no plan for the " + LINEAGE_STACK[checkpoint] + " stack")
    plan, target = descriptor["plan_document"], descriptor["target"]
    plan_sha = intro.plan_identity(plan)
    state = document(manifest["bindings"]["state"]["path"], "state")
    require(plan_sha == descriptor["plan_sha256"] == identity["plan_sha256"] == state.get("plan_sha256"), "BUNDLE_INPUT_MISMATCH",
            "the plan bytes, the descriptor, the state and the identity name different plans")
    target_sha = sha256(intro.canonical(target))
    require(target_sha == plan["target_manifest_sha256"] == identity["target_manifest_sha256"], "BUNDLE_INPUT_MISMATCH",
            "the target document differs from the plan and the identity")
    require(plan["tool"] == identity["tool_files_actual_raw_sha256"], "BUNDLE_INPUT_MISMATCH", "the plan binds other tool files")
    images = identity["image_ids"]
    require(context["images"] == {"previous": images.get("previous"), "release": images.get("release")}
            and plan["previous"]["images"] == images.get("previous") and plan["release"]["images"] == images.get("release"),
            "BUNDLE_INPUT_MISMATCH", "image IDs differ between the context, the plan and the identity")
    source_b0 = None
    if identity["source_b0_manifest_sha256"] is not None or context["b0"] is not None:
        b0 = context["b0"] or {}
        source_b0 = sha256(member(_inside(b0.get("dir"), root, "source B0") + "/manifest.json", "source B0 manifest"))
        require(source_b0 == b0.get("manifest_sha256") == identity["source_b0_manifest_sha256"], "BUNDLE_INPUT_MISMATCH",
                "the source B0 manifest bytes differ")
        if context["copy_dir"]:
            copied = sha256(member(_inside(context["copy_dir"], root, "seed B0 copy") + "/manifest.json", "seed B0 copy manifest"))
            require(copied == source_b0, "BUNDLE_INPUT_MISMATCH", "the seed's B0 copy differs from the source B0")
    clone_b0 = None
    state_b0 = state.get("b0") if LINEAGE_STACK[checkpoint] != "source" else None
    if identity["clone_b0_manifest_sha256"] is not None or state_b0:
        clone_b0 = sha256(member(_inside((state_b0 or {}).get("dir"), root, "clone B0") + "/manifest.json", "clone B0 manifest"))
        require(clone_b0 == (state_b0 or {}).get("manifest_sha256") == identity["clone_b0_manifest_sha256"], "BUNDLE_INPUT_MISMATCH",
                "the clone B0 manifest bytes differ")
    # Plan-dependent inputs the next phase reads: all of them must come from this bundle's own fixture tree.
    _inside(plan["backup_root"], root, "plan backup_root")
    if plan.get("seed"):
        _inside(plan["seed"]["b0_dir"], root, "plan seed b0_dir")
    _inside(descriptor["root"], root, "stack root")
    _inside(target["repository"], root, "target repository")
    _inside(target["ca_file"], root, "target ca_file")
    for name in target["compose_files"]:
        absolute = Path(name).is_absolute() or PurePosixPath(name).is_absolute()
        # A relative compose file is read from the repository: it must stay inside it after normalisation as well.
        _inside(name if absolute else target["repository"].rstrip("/\\") + "/" + name, root, "compose file")
    for overlay in target["declared_overlays"]:
        _inside(overlay["file"], root, "declared overlay")
        for bind in overlay.get("binds") or []:
            _inside(bind["source"], root, "overlay bind")
    return {"plan_sha256": plan_sha, "target_manifest_sha256": target_sha, "source_b0_manifest_sha256": source_b0,
            "clone_b0_manifest_sha256": clone_b0, "context_sha256": manifest["bindings"]["context"]["sha256"]}


def runtime_identity(facts, *, modules, root):
    """The executing runtime pinned from actual observation: interpreter, Docker server, Compose, Playwright and its
    Chromium build, architecture, and the origin of every harness/product module (inside the frozen source, never a
    bytecode cache; none may exist in the source's scripts/ or tests/). Origins are relative so A and B copies compare."""
    out = {}
    for key in RUNTIME_KEYS:
        require(type(facts.get(key)) is str and facts[key].strip(), "RUNTIME_UNPINNED", key)
        out[key] = facts[key].strip()
    root = Path(root).resolve()
    for folder in ("scripts", "tests"):
        require(not any((root / folder).rglob("__pycache__")), "RUNTIME_UNPINNED", "a bytecode cache in the frozen " + folder)
    origins = {}
    for name, module in sorted(modules.items()):
        origin = Path(getattr(module, "__file__", "") or "").resolve()
        require(origin.suffix == ".py" and "__pycache__" not in origin.parts, "RUNTIME_UNPINNED", name + " origin")
        try:
            origins[name] = origin.relative_to(root).as_posix()
        except ValueError:
            raise Refused("RUNTIME_UNPINNED", name + " was imported from outside the frozen source") from None
    out["modules"] = origins
    return out


def restored_mapping(recorded, observed):
    """After a restore, the product facts observed at the checkpoint (data, rights, realm, frame, migrations, mounts,
    networks, images, running roles) must be observed again; only container IDs may differ, and their old -> new
    correspondence is returned for the record. Anything else refuses (RESTORE_MISMATCH)."""
    require(type(recorded) is dict and type(observed) is dict and set(recorded) == set(observed), "RESTORE_MISMATCH",
            "fact inventory")
    differences, ids = [], {}
    require(set(recorded["containers"]) == set(observed["containers"]), "RESTORE_MISMATCH", "container roles")
    for role in sorted(recorded["containers"]):
        old, new = recorded["containers"][role], observed["containers"][role]
        if {k: v for k, v in old.items() if k != "id"} != {k: v for k, v in new.items() if k != "id"}:
            differences.append("container " + role)
        ids[role] = {"checkpoint": old.get("id"), "restored": new.get("id")}
    differences += [key for key in sorted(recorded) if key != "containers" and recorded[key] != observed[key]]
    require(not differences, "RESTORE_MISMATCH", ",".join(differences))
    return {"container_ids": ids, "compared": sorted(recorded)}


# ── capture and restore coordination (T08) through the backend adapter ──

def writable_layer_allowed(change):
    kind, _, path = change.partition(" ")
    path = path.strip()
    if any(path == prefix or path.startswith(prefix + "/") for prefix in TRANSIENT_PATHS):
        return True
    # A changed parent directory of a transient path is listed by `diff` as C <dir>.
    return kind == "C" and any(prefix.startswith(path.rstrip("/") + "/") for prefix in TRANSIENT_PATHS)


def stop_for_checkpoint(backend, names, running):
    """Normal stop in FENCE_ORDER, the database last; a forced kill or an unconfirmed stop fails the checkpoint."""
    for role in (*intro.FENCE_ORDER, "db"):
        if role not in running:
            continue
        outcome = backend.stop(names[role])
        require(outcome.get("exit_code") in (0, 143) and not outcome.get("forced") and not outcome.get("oom_killed")
                and outcome.get("running") is False, "STOP_UNCONFIRMED", role + " did not stop normally")


def owned_resource(item, owned):
    """Ownership is an exact label or exact recorded ID, never a name prefix."""
    labels = item.get("labels") or {}
    return (item.get("id") in owned.get("ids", ()) or labels.get("kin.ops.run") == owned["token"]
            or labels.get("kin.ops.recovery") in owned.get("recovery", ())
            or labels.get("com.docker.compose.project") in owned["projects"])


def mount_inventory(inventory, names, volumes, fixture_root, owned):
    """Persistent state outside the declared volumes and the fixture tree refuses (v1): every volume a stack container
    mounts is an owned named volume (the declared ones, or another of this Compose project that is captured as an extra
    member), never an anonymous one; every bind source lies inside the fixture root. Returns the extra volume names."""
    declared, extra = {name for name in volumes.values() if name}, []
    root = Path(fixture_root).resolve()
    listed = {item["name"]: item for item in inventory["volumes"]}
    for container in inventory["containers"]:
        if container["name"] not in names.values():
            continue
        for mount in container.get("mounts") or []:
            if mount.get("type") == "volume":
                name = mount.get("name") or ""
                require(name in listed and owned_resource(listed[name], owned) and not re.fullmatch(r"[0-9a-f]{64}", name),
                        "UNDECLARED_STATE", container["name"] + " mounts " + (name or "an anonymous volume"))
                if name not in declared and name not in extra:
                    extra.append(name)
            elif mount.get("type") == "bind":
                source = Path(str(mount.get("source")))
                require(source.is_absolute() and (source.resolve() == root or root in source.resolve().parents), "UNDECLARED_STATE",
                        container["name"] + " binds " + str(source) + " outside the fixture tree")
            else:
                require(mount.get("type") == "tmpfs", "UNDECLARED_STATE", container["name"] + " mount " + str(mount.get("type")))
    return sorted(extra)


def capture_checkpoint(*, checkpoint_id, store, backend, boundary, names, volumes, fixture_root, bindings, identity, owned,
                       execution_kind, parent=None, derived=False, running=None, extra_members=()):
    """Spec section 3 steps 1-5. `volumes` maps a category to its declared volume name; `bindings` names the fixture
    files (relative to the fixture root) whose bytes the bundle must carry. A checkpoint without volumes (the source-b0
    input cache, taken after the source stack was removed) has no daemon side: `backend` is None."""
    spec = CHECKPOINTS[checkpoint_id]
    require(spec["volumes"] is (backend is not None), "NOT_A_BOUNDARY", "daemon backend and checkpoint kind disagree")
    inventory = backend.inventory() if backend is not None else {"containers": [], "volumes": [], "networks": []}
    for item in inventory["containers"]:
        require(owned_resource(item, owned) or item["name"] not in names.values(), "NOT_OWNED", item["name"])
    if backend is not None:
        running = {role for role in intro.ROLES if any(c["name"] == names[role] and c["running"] for c in inventory["containers"])} \
            if running is None else running
        stop_for_checkpoint(backend, names, running)
        for role in intro.ROLES:
            if any(c["name"] == names[role] for c in inventory["containers"]):
                unknown = [change for change in backend.writable_changes(names[role]) if not writable_layer_allowed(change)]
                require(not unknown, "WRITABLE_LAYER", role + ": " + ",".join(unknown[:5]))
    extra = mount_inventory(inventory, names, volumes, fixture_root, owned)
    pending = store.begin(checkpoint_id)
    for name, category, path in extra_members:
        pending.add(name, category, Path(path))
    members = {}
    if spec["volumes"]:
        listed = {item["name"]: item for item in inventory["volumes"]}
        exports = [(category, volumes.get(category), "volume-" + category + ".tar") for category in VOLUME_CATEGORIES]
        exports += [("extra:" + name, name, "volume-extra-%02d.tar" % index) for index, name in enumerate(extra)]
        for category, name, member in exports:
            if name is None or name not in listed:
                pending.declare_absent(category)
                continue
            require(owned_resource(listed[name], owned), "NOT_OWNED", name)
            archive = pending.directory / ("export-" + member)
            backend.export_volume(name, archive)
            archive_members(archive, category=category)
            pending.add(member, "volume:" + category, archive)
            members[category] = member
            archive.unlink()
    tree = pending.directory / "export-fixture.tar"
    write_tree_archive(fixture_root, tree)
    required = [name for name in BINDINGS if name != "lock" or spec["lock"]]
    check_bindings(tree, bindings, required=required)
    pending.add("fixture-tree.tar", "fixture-tree", tree)
    tree.unlink()
    labels = {item["name"]: item.get("labels") or {} for item in inventory["volumes"]}
    named = {**{category: volumes.get(category) for category in VOLUME_CATEGORIES}, **{"extra:" + name: name for name in extra}}
    owned_record = {"token": owned["token"], "projects": sorted(owned["projects"]),
                    "volumes": {category: {"name": named[category], "labels": labels.get(named[category], {}), "member": member}
                                for category, member in sorted(members.items())},
                    "networks": owned.get("networks", []), "stack": owned.get("stack")}
    return pending.seal(identity=identity, boundary=boundary, bindings={k: bindings[k] for k in required}, owned=owned_record,
                        execution_kind=execution_kind, parent=parent, derived=derived)


def restore_checkpoint(manifest, bundle_dir, *, backend, fixture_root, names, images_present, observe):
    """Spec section 3 steps 6-9 into new objects only: an existing volume or a non-empty root refuses; containers are
    recreated from the pinned ComposeEntry with the same image IDs, the database alone for HELD; no seed, provision or
    migration runs; the product's boundary contract is observed at the end. Returns the action log. The plan, target and
    B0 bytes are recomputed from the bundle (bundle_inputs) before the first daemon call or file is created."""
    spec = CHECKPOINTS[manifest["checkpoint"]]
    actions = [("inputs", bundle_inputs(manifest, bundle_dir))]
    images = manifest["identity"]["image_ids"]
    for side, value in images.items():
        for image in (value.values() if type(value) is dict else [value]):
            require(images_present(image), "STALE_IMAGE", side + " " + image)
    for category, volume in manifest["owned"].get("volumes", {}).items():
        require(not backend.volume_exists(volume["name"]), "RESOURCE_EXISTS", volume["name"])
    inventory = backend.inventory()
    require(not any(c["name"] in names.values() for c in inventory["containers"]), "RESOURCE_EXISTS", "a container name is in use")
    payload = Path(bundle_dir) / "payload"
    extract_tree(payload / "fixture-tree.tar", fixture_root)
    actions.append(("fixture", str(fixture_root)))
    state = json.loads((Path(fixture_root) / manifest["bindings"]["state"]["path"]).read_bytes())
    require(state.get("status") == spec["status"], "LOCK_MISMATCH", "restored state status")
    if spec["lock"]:
        lock = Path(fixture_root) / manifest["bindings"]["lock"]["path"]
        require(lock.is_file() and lock.read_text() == state.get("lock_token"), "LOCK_MISMATCH", "the lock token differs from the state")
    for network in manifest["owned"].get("networks", []):
        backend.create_network(network["name"], network.get("labels") or {})
        actions.append(("network", network["name"]))
    if not spec["volumes"]:
        return actions
    for category, volume in sorted(manifest["owned"]["volumes"].items()):
        backend.create_volume(volume["name"], volume["labels"])
        backend.load_volume(volume["name"], payload / volume["member"], category)
        actions.append(("volume", volume["name"]))
    backend.compose_create(list(intro.ROLES))
    actions.append(("create", tuple(intro.ROLES)))
    backend.compose_start("db")
    actions.append(("start", "db"))
    backend.wait_db_ready()
    running = intro.BOUNDARY_RUNNING[spec["boundary"]]
    if running == "all":
        for role in intro.RESUME_ORDER:
            backend.compose_start(role)
            actions.append(("start", role))
    observe(spec["boundary"])
    actions.append(("observe", spec["boundary"]))
    return actions


# ── cleanup (T12) ──

def owned_remaining(inventory, owned):
    """Owned resources still listed: containers, volumes and networks by exact label or ID, and the exact image tags this
    run created (`owned["tags"]`); a foreign tag or a shared image ID is never counted as ours."""
    tags = set(owned.get("tags") or ())
    left = [item["name"] for kind in ("containers", "volumes", "networks") for item in inventory[kind] if owned_resource(item, owned)]
    return left + sorted(tag for image in inventory.get("images") or [] for tag in image.get("tags") or [] if tag in tags)


def cleanup_owned(backend, owned):
    """Remove exactly the owned resources (exact labels or recorded IDs), then observe their absence. A removal whose
    re-query still lists the resource, or a failed query, makes the cleanup incomplete; foreign resources stay. An owned
    image tag is only an alias: it is removed while another tag keeps the image, the image ID itself is never removed,
    and a tag that is the image's last name is kept and reported (removing it would delete a shared image)."""
    removed, errors = [], []
    tags = set(owned.get("tags") or ())
    try:
        inventory = backend.inventory()
    except Exception as error:  # an unobservable daemon is not a clean one
        return {"complete": False, "removed": [], "remaining": [], "errors": ["inventory: " + type(error).__name__]}
    for kind in ("containers", "volumes", "networks"):
        for item in inventory[kind]:
            if owned_resource(item, owned):
                try:
                    backend.remove(kind, item.get("id") or item["name"])
                    removed.append(item["name"])
                except Exception as error:
                    errors.append(item["name"] + ": " + type(error).__name__)
    images_before = {image["id"] for image in inventory.get("images") or []}
    for image in inventory.get("images") or []:
        names = set(image.get("tags") or [])
        mine = sorted(names & tags)
        # Decided per image before the first removal (CKPT2-05): with no foreign name left, one owned alias is kept as the
        # image's last name, however many owned aliases it has; each removal is judged against that, never a stale count.
        keep = None if names - tags else (mine[-1] if mine else None)
        for tag in mine:
            if tag == keep:
                errors.append(tag + ": the last name of image " + image["id"] + " (kept; the shared image is never removed)")
                continue
            try:
                backend.remove("tags", tag)
                removed.append(tag)
            except Exception as error:
                errors.append(tag + ": " + type(error).__name__)
    try:
        after = backend.inventory()
        remaining = owned_remaining(after, owned)
        lost = sorted(images_before - {image["id"] for image in after.get("images") or []})
    except Exception as error:
        return {"complete": False, "removed": removed, "remaining": [], "errors": errors + ["re-query: " + type(error).__name__]}
    errors += ["image removed: " + image for image in lost if any(set(i.get("tags") or []) & tags for i in inventory.get("images") or []
                                                                  if i["id"] == image)]
    return {"complete": not remaining and not errors, "removed": removed, "remaining": remaining, "errors": errors}


def remove_private_root(path, *, owner_root):
    """Delete one private fixture or bundle directory strictly inside its declared owner root (never the root itself,
    never through a link)."""
    path, owner_root = Path(path), Path(owner_root)
    require(path.is_absolute() and owner_root.is_absolute(), "NOT_OWNED", "absolute paths required")
    require(owner_root.resolve() in path.resolve().parents and not path.is_symlink(), "NOT_OWNED", str(path) + " escapes its root")
    if path.exists():
        shutil.rmtree(path)
    require(not path.exists(), "CLEANUP_INCOMPLETE", str(path))
    return {"removed": str(path)}


def discard_bundle(store, digest, *, reason):
    """Deleting a bundle is an explicit act with a reason; expiry alone never deletes (it only refuses reuse)."""
    require(reason in ("completed", "discarded"), "NOT_OWNED", "a bundle is removed only on completion or explicit discard")
    return remove_private_root(store.root / digest, owner_root=store.root)


# ── host admission (T13) and the live gate (T10) ──

def daemon_environment(environ=None):
    """The environment of every checkpoint Docker/Compose call: no DOCKER_* or COMPOSE_* selection at all, so raw and
    Compose calls reach the same (default context) daemon the admission observed."""
    environ = os.environ if environ is None else environ
    return {key: value for key, value in environ.items() if not key.startswith(("DOCKER_", "COMPOSE_"))}


def endpoint_selectors(environ=None):
    environ = os.environ if environ is None else environ
    return sorted(key for key in ENDPOINT_SELECTORS if environ.get(key))


def foreign_containers(rows, *, owned_ids=()):
    """D1034 over every container, running or stopped: a `kin-*` name, a `kin.ops.run` label or a `kin.emrb.live` label
    (whatever the name) is foreign unless its exact ID is in this stage's own list. Names alone never grant ownership."""
    found = []
    for row in rows:
        if row["id"] in owned_ids:
            continue
        if row["name"].startswith("kin-") or row.get("kin.ops.run") or row.get("kin.emrb.live"):
            found.append(row["name"] + " (" + (row.get("state") or "unknown") + ")")
    return sorted(found)


def host_admission(facts, expected=None, *, gate=None):
    """Native Linux, the persistent live slot, D1034 (RAM, no foreign kin containers running or stopped, daemon
    answering), one local daemon endpoint for every call, and for a resume the same host, daemon, architecture and
    absolute root as the checkpoint."""
    if gate is not None:
        gate.require_live_run()
        gate_state = Path(gate.STATE)
        require(facts.get("gate_state") == str(gate_state) and gate_state.is_dir(), "HOST_REFUSED", "persistent live slot")
    require(facts.get("os") == "linux", "UNSUPPORTED_HOST", "v1 checkpoints run on native Linux only")
    require(facts.get("endpoint_selectors") == [], "REMOTE_DAEMON",
            "DOCKER_* endpoint selection in the environment: " + ",".join(facts.get("endpoint_selectors") or ["unobserved"]))
    require(str(facts.get("docker_endpoint", "")).startswith("unix:///"), "REMOTE_DAEMON",
            "the current Docker context is not a local socket: " + str(facts.get("docker_endpoint"))[:120])
    require(facts.get("daemon_ok") is True and facts.get("daemon_identity"), "DAEMON_UNAVAILABLE", "daemon query failed")
    require("docker desktop" not in str(facts.get("docker_os", "")).lower() and facts.get("docker_os"), "UNSUPPORTED_HOST",
            "Docker Desktop is not a native Linux daemon")
    require(type(facts.get("available_ram_bytes")) is int and facts["available_ram_bytes"] >= MIN_HOST_RAM, "INSUFFICIENT_RAM",
            str(facts.get("available_ram_bytes")))
    require(type(facts.get("available_disk_bytes")) is int and facts["available_disk_bytes"] >= facts.get("required_disk_bytes", 0),
            "INSUFFICIENT_DISK", str(facts.get("available_disk_bytes")))
    require(not facts.get("foreign_containers"), "FOREIGN_RESOURCES", ",".join(facts.get("foreign_containers") or [])[:400])
    require(HASH.fullmatch(str(facts.get("host_key_sha256"))) is not None, "HOST_REFUSED", "host identity")
    if expected is not None:
        for key in ("host_key_sha256", "daemon_identity", "architecture", "absolute_fixture_root"):
            require(facts.get(key) == expected.get(key), "HOST_MISMATCH", key)
    return {"admitted": True, "os": "linux", "daemon_identity": facts["daemon_identity"]}


def stage_entry(gate, facts, expected=None):
    """Every checkpoint stage passes the process-local live permission and the inspection marker check before its
    first Docker query or mutation; checkpoint IO never touches the gate's own state."""
    gate.require_live_run()
    marker = Path(gate.STATE) / "live-needs-inspection.json"
    require(marker.is_file(), "HOST_REFUSED", "the live run's own marker is missing")
    return host_admission(facts, expected, gate=gate)


def marker_identity(gate):
    """The current gate marker's identity (this process's live run), read from the gate itself."""
    raw = (Path(gate.STATE) / "live-needs-inspection.json").read_bytes()
    marker = json.loads(raw)
    gate.validate_identity(marker)
    require(marker["pid"] == os.getpid(), "REQUEST_INVALID", "the marker belongs to another process")
    return {key: marker[key] for key in ("unit", "module", "attempt", "plan_sha256", "pid", "started_at")}


def bind_marker(gate, request):
    """The current gate marker's identity, read from the gate, never from the request."""
    marker = marker_identity(gate)
    require(marker["unit"] == request["unit"], "REQUEST_INVALID", "marker unit/pid")
    return marker


def finish_segment(gate, *, passed, segment, evidence_root):
    """Write the segment record. A failed or uncertain segment keeps the gate's marker for inspection: this harness never
    deletes or rewrites the marker or the unit ledger (release goes through gate.release_after_inspection only)."""
    path = Path(evidence_root) / "segment.json"
    Path(evidence_root).mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(path, "xb") as stream:  # a segment is written once; a second write is an error, never an overwrite
        stream.write(canonical({**segment, "passed": bool(passed)}) + b"\n")
    return path


def inspection_record(gate, *, exit_code, artifacts, stack, inspector):
    """An inspection for gate.release_after_inspection: the marker identity copied verbatim, the observed resource
    absence/preservation facts and the retained artifacts."""
    marker = json.loads((Path(gate.STATE) / "live-needs-inspection.json").read_bytes())
    require(type(stack) is dict and "remaining" in stack and "preserved" in stack, "INSPECTION_INCOMPLETE",
            "resource absence and preservation facts are required")
    require(artifacts and all(type(item) is str and item for item in artifacts), "INSPECTION_INCOMPLETE", "artifacts")
    return {**marker, "exit": exit_code, "artifacts": list(artifacts), "stack": stack, "inspector": inspector,
            "inspected_at": now_utc().isoformat()}


# ── time (T11) ──

def reuse_deadline(created_utc, *, window_end, tls_not_after):
    return min(utc(created_utc) + TTL, utc(window_end), utc(tls_not_after))


def time_admission(*, created_utc, window_end, tls_not_after, suffix_seconds, teardown_seconds, now=None, approval=None):
    """Real UTC only: the bundle is reusable until min(created + 8 h, plan window end, TLS notAfter), and only if the
    declared suffix and its teardown still fit. A future creation time or a clock behind the checkpoint refuses. A
    protected-entry approval is checked as given (expires_at); the direct harness has none (N/A). Nothing is rewritten."""
    current = utc(now or now_utc())
    created = utc(created_utc)
    require(created <= current, "CLOCK_INVALID", "checkpoint created in the future (clock rollback)")
    deadline = reuse_deadline(created_utc, window_end=window_end, tls_not_after=tls_not_after)
    require(type(suffix_seconds) is int and type(teardown_seconds) is int and suffix_seconds > 0 and teardown_seconds >= 0,
            "TIME_INVALID", "declared durations")
    require(current + timedelta(seconds=suffix_seconds + teardown_seconds) <= deadline, "EXPIRED",
            "the suffix and teardown do not fit before " + deadline.isoformat())
    approval_state = "N/A (direct SyntheticStack.phase: no host approval)"
    if approval is not None:
        require(utc(approval["expires_at"]) > current + timedelta(seconds=suffix_seconds), "EXPIRED", "approval expires_at")
        approval_state = "valid until " + utc(approval["expires_at"]).isoformat()
    return {"deadline_utc": deadline.isoformat(), "approval": approval_state}


def login_after_restore(auth_time, restored_utc):
    """A restored boundary is proved again with a new interactive login made after the restore (auth_time/newAuthAfter
    and the temporary member TTL are never carried over)."""
    require(type(auth_time) is int and auth_time > 0, "LOGIN_REQUIRED", "no interactive login")
    require(datetime.fromtimestamp(auth_time, timezone.utc) >= utc(restored_utc).replace(microsecond=0), "LOGIN_REQUIRED",
            "the login predates the restore")
    return True


# ── proof leaves, requests and budgets (T09) ──

def registry_valid(leaves):
    """The commander's frozen leaf registry: stable unit names fixed before the first run, one exact selection each."""
    require(type(leaves) in (list, tuple) and leaves, "REGISTRY_INVALID", "empty")
    units, selections, seen = set(), set(), {}
    for leaf in leaves:
        require(type(leaf) is dict and set(leaf) == {"unit", "file", "case", "scenario", "stage", "execution_kind", "proof", "source",
                                                     "parent"},
                "REGISTRY_INVALID", "leaf keys")
        require(type(leaf["source"]) is str and re.fullmatch(r"[a-z]", leaf["source"]) is not None, "REGISTRY_INVALID",
                str(leaf.get("unit")) + " source copy")
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", leaf["unit"]) is not None and leaf["unit"] not in units, "REGISTRY_INVALID",
                "unit " + str(leaf["unit"]))
        units.add(leaf["unit"])
        require(leaf["scenario"] in SCENARIOS and leaf["execution_kind"] in EXECUTION_KINDS, "REGISTRY_INVALID", leaf["unit"])
        require(leaf["stage"] is None or leaf["stage"] in STAGES, "REGISTRY_INVALID", leaf["unit"] + " stage")
        stage, kind = leaf["stage"], leaf["execution_kind"]
        if stage is None:
            require(kind == "fresh" and leaf["file"] == REHEARSAL_FILE and leaf["case"] == FRESH_CASES[leaf["scenario"]],
                    "REGISTRY_INVALID", leaf["unit"] + ": a stage-less leaf is an existing fresh method")
        else:
            require(leaf["file"] == LIVE_FILE and stage in SCENARIOS[leaf["scenario"]]
                    and (leaf["case"] == STAGES[stage]["case"] or PROOF_CASES.get(leaf["case"]) == stage), "REGISTRY_INVALID",
                    leaf["unit"] + ": case/stage/scenario")
            consumes = STAGES[stage]["consumes"]
            allowed = ("fresh",) if consumes is None else ("reseed-from-recorded-b0",) if consumes == "source-b0" else \
                ("checkpoint-resume", "diagnostic-fork") if CHECKPOINTS[consumes]["cross_tree"] else ("checkpoint-resume",)
            require(kind in allowed, "REGISTRY_INVALID", leaf["unit"] + ": execution kind " + kind)
        # The parent map: an earlier registered leaf whose stage seals exactly the checkpoint this stage consumes; the
        # same source copy resumes (checkpoint-resume / reseed), another source copy is a diagnostic fork.
        consumes = STAGES[stage]["consumes"] if stage is not None else None
        if consumes is None:
            require(leaf["parent"] is None, "REGISTRY_INVALID", leaf["unit"] + ": a fresh leaf has no parent")
        else:
            parent = seen.get(leaf["parent"])
            require(parent is not None and parent["stage"] is not None and STAGES[parent["stage"]]["produces"] == consumes
                    and parent["case"] == STAGES[parent["stage"]]["case"], "REGISTRY_INVALID",
                    leaf["unit"] + ": parent must be an earlier leaf sealing " + consumes)
            require((kind == "diagnostic-fork") is (parent["source"] != leaf["source"]), "REGISTRY_INVALID",
                    leaf["unit"] + ": a fork runs another source copy than its parent, a resume the same one")
        key = (leaf["file"], leaf["case"])
        require(key not in selections, "REGISTRY_INVALID", "duplicate selection " + leaf["case"])
        selections.add(key)
        seen[leaf["unit"]] = leaf
    return list(leaves)


def registry_leaf(leaves, unit):
    leaf = next((item for item in registry_valid(leaves) if item["unit"] == unit), None)
    require(leaf is not None, "REGISTRY_INVALID", "unregistered unit " + str(unit))
    return leaf


def leaf_stages(leaf):
    """The stages a registered leaf runs itself: the whole scenario (a fresh method), none (the refusal proof), or its
    stage and what its proof case runs after it."""
    if leaf["stage"] is None:
        return list(SCENARIOS[leaf["scenario"]])
    if PROOF_OUTCOMES.get(leaf["case"], {}).get("outcome") == "REFUSED":
        return []
    return [leaf["stage"], *PROOF_THEN.get(leaf["case"], ())]


def leaf_phases(leaf):
    """(executed, inherited) product phases of one registered leaf: what it must run itself, and what its parent lineage
    already ran (never counted as executed here)."""
    stage = leaf["stage"]
    executed = [phase for name in leaf_stages(leaf) for phase in STAGES[name]["phases"]]
    if stage is None:
        return executed, []
    order = SCENARIOS[leaf["scenario"]]
    inherited = [phase for name in order[:order.index(stage)] for phase in STAGES[name]["phases"]] if leaf["parent"] else []
    return executed, inherited


# The fixture stack each stage runs its product phases on (every other stage: the clone).
STAGE_STACK = {"source": "source", "forced-capture": "failure", "forced-tail": "failure"}
# The raw results that end otherwise by design, as (status, the STOP step, the phase whose steps follow in the same
# result): input A's deterministic L-11a STOP keeps reopen VERIFIED before the point of no return; the forced lineage's
# L-09b failure rolls back automatically inside introduce (RB-00..RB-03) and ends RESTORED.
RESULT_ENDINGS = {("CheckpointSegments.test_original_late_fault", "reopen"): ("VERIFIED", "L-11a", None),
                  ("forced", "introduce"): ("RESTORED", "L-09b", "rollback")}


def expected_results(leaf):
    """The fixed leaf contract of every product phase the leaf runs itself, in order: its stack, phase, result status,
    exact [step, outcome] sequence and history status - the phase's complete PASS sequence with intro.DONE, or one of the
    by-design endings above (CKPT2-01). Nothing here is read from the run."""
    out = []
    for stage in leaf_stages(leaf):
        for phase in STAGES[stage]["phases"]:
            steps = [[sid, "PASS"] for sid, _, _, _ in intro.STEPS[phase]]
            row = {"stack": STAGE_STACK.get(stage, "clone"), "phase": phase, "status": intro.DONE[phase], "steps": steps, "history": "PASS"}
            ending = RESULT_ENDINGS.get((leaf["case"], phase)) or RESULT_ENDINGS.get((leaf["scenario"], phase))
            if ending is not None:
                status, stop, then = ending
                index = [sid for sid, _ in steps].index(stop)
                tail = [[sid, "PASS"] for sid, _, _, _ in intro.STEPS[then]] if then else []
                row.update(status=status, steps=steps[:index] + [[stop, "STOP"]] + tail, history=status)
            out.append(row)
    return out


def leaf_outcome(leaf):
    return dict(PROOF_OUTCOMES.get(leaf["case"], {"outcome": "PASS"}))


def leaf_produces(leaf):
    """The checkpoint a leaf seals: only a plain stage selection (a proof case consumes, it never seals)."""
    stage = leaf["stage"]
    return STAGES[stage]["produces"] if stage is not None and leaf["case"] == STAGES[stage]["case"] else None


def leaf_plan(leaves, unit, *, timeout_seconds=MAX_ATTEMPT_SECONDS):
    """The run-tests plan of one registered leaf. The unit comes from the registry only: an output root, source SHA,
    attempt or evidence folder never names a new unit (no fresh failure budget)."""
    leaf = registry_leaf(leaves, unit)
    require(type(timeout_seconds) is int and 1 <= timeout_seconds <= MAX_ATTEMPT_SECONDS, "REGISTRY_INVALID", "timeout")
    return {"unit": leaf["unit"], "mode": "live", "tests": [{"file": leaf["file"], "case": leaf["case"]}],
            "max_attempts": MAX_ATTEMPTS, "timeout_seconds": timeout_seconds}


REQUEST_KEYS = ("schema", "unit", "case", "scenario", "stage", "execution_kind", "parent_manifest", "source_manifest",
                "output_root", "evidence_root")


def attempt_paths(proof_root, unit, attempt=1, *, flavour=Path):
    """One attempt of one registered unit (CKPT2-06): only its request, run folder and evidence root are new per attempt.
    The unit, its gate plan (<proof_root>/plan-<unit>.json), its parent, the source copies, the shared bundle store and the
    gate's persistent ledger stay the same; an attempt never names a new unit or budget."""
    require(type(attempt) is int and 1 <= attempt <= MAX_ATTEMPTS, "REGISTRY_INVALID", "attempt " + repr(attempt))
    root = flavour(proof_root)
    return {"request": root / ("request-" + unit + "-" + str(attempt) + ".json"), "run": root / "runs" / (unit + "-" + str(attempt)),
            "evidence": root / "evidence" / unit / ("attempt-" + str(attempt))}


def unused_attempt(paths):
    """An attempt's request, run folder and evidence root are new: an existing one is refused before anything is written
    (never overwritten, never reused)."""
    for key in ("request", "run", "evidence"):
        require(not Path(paths[key]).exists(), "EVIDENCE_EXISTS", key + " " + str(paths[key]) + " already exists")
    return paths


def retry_admission(state_dir, leaves, unit, attempt, proof_root):
    """Whether attempt N (N >= 2) of a unit may run (CKPT2-06), read from the gate's persistent ledger and marker (never
    written here): the previous attempt of this proof root exists, the unit is not BOUND, the failed run's marker was
    released through a real inspection, the ledger's attempts are all `failed` and below the budget. An interrupted
    (timeout/kill), running or passed attempt is final for scripts/run-tests.py: an inspection alone never makes it
    retryable here either."""
    registry_leaf(leaves, unit)
    require(type(attempt) is int and attempt >= 2, "RETRY_REFUSED", "attempt 1 is the first run, not a retry")
    paths = unused_attempt(attempt_paths(proof_root, unit, attempt))
    require(attempt_paths(proof_root, unit, attempt - 1)["run"].is_dir(), "RETRY_REFUSED",
            "attempt %d of %s has no run folder: attempts are consecutive" % (attempt - 1, unit))
    require(not (Path(proof_root) / "index" / (unit + ".json")).exists(), "RETRY_REFUSED", unit + " is already BOUND")
    # A failed leaf keeps its private fixture for the inspection; the retry restores into the same absolute root.
    require(not (Path(proof_root) / "out" / "fixture").exists(), "RETRY_REFUSED", "the failed attempt's fixture root is not cleared yet")
    state = Path(state_dir)
    require(not (state / "live-needs-inspection.json").exists(), "RETRY_REFUSED",
            "the failed run's marker is not released (gate.release_after_inspection with the real inspection first)")
    try:
        ledger = json.loads((state / (unit + ".json")).read_bytes())
        statuses = [row["status"] for row in ledger["attempts"]]
    except (OSError, ValueError, TypeError, KeyError):
        raise Refused("RETRY_REFUSED", "no readable gate ledger for " + unit) from None
    require(statuses, "RETRY_REFUSED", "the ledger records no attempt of " + unit)
    require("interrupted" not in statuses, "RETRY_REFUSED", "an interrupted attempt is never retried on an inspection alone")
    require("running" not in statuses and "passed" not in statuses, "RETRY_REFUSED", "a running or passed unit is never repeated")
    require(statuses[-1] == "failed" and len(statuses) < MAX_ATTEMPTS, "RETRY_REFUSED", "attempt budget: " + ",".join(statuses))
    return {"unit": unit, "attempt": attempt, "ledger": statuses, "paths": {key: str(value) for key, value in paths.items()}}


def _reference(value, what, *, optional=False):
    if value is None and optional:
        return None
    require(type(value) is dict and set(value) == {"path", "sha256"} and type(value["path"]) is str
            and Path(value["path"]).is_absolute() and HASH.fullmatch(str(value["sha256"])) is not None, "REQUEST_INVALID", what)
    try:
        actual = sha256(Path(value["path"]).read_bytes())
    except OSError:
        raise Refused("REQUEST_INVALID", what + " unreadable") from None
    require(actual == value["sha256"], "REQUEST_INVALID", what + " bytes differ from the request")
    return value


def load_request(path, leaves, *, case):
    """KIN_TEST_EMR_CHECKPOINT_REQUEST: a selection input, never a permission. Closed schema, a registered
    unit/case/scenario/stage/kind combination, and manifests bound by their actual bytes."""
    require(path and Path(path).is_absolute(), "REQUEST_INVALID", "absolute request path required")
    raw = Path(path).read_bytes()
    request = json.loads(raw)
    require(type(request) is dict and set(request) == set(REQUEST_KEYS) and request["schema"] == SCHEMA, "REQUEST_INVALID", "keys")
    leaf = next((item for item in registry_valid(leaves) if item["unit"] == request["unit"]), None)
    require(leaf is not None and leaf["case"] == case == request["case"], "REQUEST_INVALID", "unit/case selection")
    require(all(request[key] == leaf[key] for key in ("scenario", "stage", "execution_kind")), "REQUEST_INVALID", "scenario/stage/kind")
    fresh = request["execution_kind"] == "fresh"
    _reference(request["parent_manifest"], "parent_manifest", optional=fresh)
    require(fresh is (request["parent_manifest"] is None), "REQUEST_INVALID", "parent_manifest is null only for a fresh leaf")
    _reference(request["source_manifest"], "source_manifest")
    for key in ("output_root", "evidence_root"):
        require(type(request[key]) is str and Path(request[key]).is_absolute(), "REQUEST_INVALID", key)
    require(not _nested(request["output_root"], request["evidence_root"]), "REQUEST_INVALID", "output and evidence roots overlap")
    # CKPT2-06: an attempt's evidence root is new; an existing one is refused here, before anything is written into it.
    require(not Path(request["evidence_root"]).exists(), "EVIDENCE_EXISTS", request["evidence_root"])
    if not fresh:
        parent_lineage(request, leaf)
    return request, sha256(raw)


def parent_lineage(request, leaf):
    """Before any restore: the parent manifest is a sealed checkpoint of exactly the kind this stage consumes, of this
    scenario's lineage, never a derived (fork) bundle, and it lives in this request's own bundle store, so that its parent
    chain stays queryable from there."""
    path = Path(request["parent_manifest"]["path"])
    try:
        manifest = json.loads(path.read_bytes())
    except (OSError, ValueError):
        raise Refused("REQUEST_INVALID", "parent manifest unreadable") from None
    consumes = STAGES[leaf["stage"]]["consumes"]
    require(type(manifest) is dict and manifest.get("kind") == "release-tools-checkpoint", "REQUEST_INVALID", "not a checkpoint manifest")
    require(manifest.get("checkpoint") == consumes, "REQUEST_INVALID",
            "the parent checkpoint is " + str(manifest.get("checkpoint")) + ", this stage consumes " + str(consumes))
    require(manifest.get("lineage") == CHECKPOINTS[consumes]["lineage"] and not manifest.get("derived"), "REQUEST_INVALID",
            "the parent lineage is not this stage's or the parent is a derived bundle")
    require(path.name == "manifest.json" and path.parent.name == request["parent_manifest"]["sha256"]
            and path.parent.parent.resolve() == (Path(request["output_root"]) / "bundles").resolve(), "REQUEST_INVALID",
            "the parent manifest is not a sealed bundle of this request's store")
    return manifest


def fresh_guard(environ=None):
    """The three fresh rehearsal methods run whole; a checkpoint request in their environment refuses them."""
    environ = os.environ if environ is None else environ
    require(not environ.get(REQUEST_ENV), "FRESH_WITH_REQUEST", "a fresh rehearsal never consumes a checkpoint request")


def run_scenario(scenario, stages, context, *, environ=None):
    """The explicit stage table of a fresh rehearsal: every stage in order, an assertion failure ends it."""
    fresh_guard(environ)
    require(scenario in SCENARIOS, "REQUEST_INVALID", str(scenario))
    executed = []
    for stage in SCENARIOS[scenario]:
        stages[stage](context)
        executed.append(stage)
    return executed


# ── segments, claims and evidence (T07/T14) ──

def segment_record(*, request, request_sha256, marker, identity, executed_phases, inherited_phases, results, admission=None,
                   cleanup, run_json, started_utc, ended_utc, selected_tests, phase_results=(), raw_records=(), inputs_before=None,
                   inputs_after=None, parent_chain=()):
    kind = request["execution_kind"]
    return {"schema": SCHEMA, "kind": "release-tools-checkpoint-segment", "unit": request["unit"], "case": request["case"],
            "stage": request["stage"], "scenario": request["scenario"], "execution_kind": kind,
            "fresh_e2e": kind == "fresh" and request["stage"] is None,
            "release_gate_eligible": False, "request_sha256": request_sha256, "marker": marker, "identity": identity,
            "executed_phases": list(executed_phases), "inherited_phases": list(inherited_phases), "results": results,
            "phase_results": list(phase_results), "raw_records": [list(row) for row in raw_records],
            "inputs_before": inputs_before, "inputs_after": inputs_after,
            "inputs_unchanged": inputs_before is not None and inputs_before == inputs_after, "parent_chain": list(parent_chain),
            "admission_sha256": sha256(canonical(admission)) if admission else None, "cleanup": cleanup,
            "run_json": str(run_json), "started_utc": started_utc, "ended_utc": ended_utc, "selected_tests": list(selected_tests)}


def inputs_summary(root):
    """The executing source's tool, source and harness trees and the eight TOOL_FILES, from the actual bytes now."""
    actual = source_identity(root)
    return {"tool": actual["tool"]["sha256"], "source": actual["source"]["sha256"], "harness": actual["harness"]["sha256"],
            "tool_files": actual["tool_files"]}


def parent_reference(manifest, bundle_dir):
    """How a child bundle and a segment name their parent: the parent's manifest SHA (its bundle name, recomputed from the
    manifest bytes here) and, as a separate field, its payload manifest SHA."""
    bundle_dir = Path(bundle_dir)
    raw = (bundle_dir / "manifest.json").read_bytes()
    require(sha256(raw) == bundle_dir.name, "BUNDLE_INVALID", "manifest hash differs from the bundle name")
    return {"manifest_sha256": sha256(raw), "payload_manifest_sha256": manifest["identity"]["payload_manifest_sha256"],
            "checkpoint": manifest["checkpoint"], "lineage": manifest["lineage"]}


def current_identity(inputs, *, execution_kind, plan_sha256, root, resumed_utc=None, admission_sha256=None):
    """What this leaf itself executed with: its own source trees, the plan its phases ran under (the child plan of a fork)
    and, for every consumption of a checkpoint, the resume time. The parent identity is recorded beside it, never as it."""
    resumed = execution_kind != "fresh"
    if resumed:
        utc(resumed_utc)
    return {"execution_kind": execution_kind, "source_root": str(root), "tool_tree_sha256": inputs["tool"],
            "source_tree_sha256": inputs["source"], "harness_tree_sha256": inputs["harness"],
            "tool_files_actual_raw_sha256": inputs["tool_files"], "tool_tree_sha256_at_resume": inputs["tool"] if resumed else None,
            "resumed_utc": resumed_utc if resumed else None, "plan_sha256": plan_sha256, "admission_sha256": admission_sha256}


def segment_identity(current, *, parent_manifest=None, parent_dir=None):
    return {"parent": parent_manifest["identity"] if parent_manifest is not None else None,
            "parent_reference": parent_reference(parent_manifest, parent_dir) if parent_manifest is not None else None,
            "current": current}


def parent_chain(store_root, digest, *, limit=16):
    """The lineage of a bundle in one store, from `digest` up through each manifest's parent reference; every link's
    manifest bytes must hash to its name (a missing or altered ancestor refuses: CHAIN_BROKEN)."""
    chain, current = [], digest
    while current is not None:
        require(len(chain) < limit and type(current) is str and HASH.fullmatch(current) is not None, "CHAIN_BROKEN", str(current))
        try:
            raw = (Path(store_root) / current / "manifest.json").read_bytes()
        except OSError:
            raise Refused("CHAIN_BROKEN", "missing bundle " + current) from None
        require(sha256(raw) == current, "CHAIN_BROKEN", "manifest hash " + current)
        manifest = json.loads(raw)
        chain.append({"manifest_sha256": current, "checkpoint": manifest["checkpoint"], "execution_kind": manifest["execution_kind"],
                      "payload_manifest_sha256": manifest["identity"]["payload_manifest_sha256"]})
        current = (manifest.get("parent") or {}).get("manifest_sha256")
    return chain


# The evidence secrets policy (spec section 3): the product keeps working secrets in the sibling `<records>.secrets`
# directory; these names never leave the private fixture even when found inside a records directory.
SECRET_RECORD_NAMES = frozenset({intro.COMPOSE_VALUES, ".env", "env.next"})
SECRET_RECORD_PATTERN = re.compile(r"smoke-member-.*|browser-.*|.*\.secrets")


def preserve_records(sources, evidence_dir):
    """Copy each stack's raw product records (state, journal, phase results, command records, step and one-shot logs) into
    the evidence, under the secrets policy, while the fixture still exists. A link or special file refuses; nothing is
    overwritten. Returns [[evidence-relative path, sha256 of the bytes written]] sorted."""
    evidence_dir = Path(evidence_dir)
    rows = []
    for label, directory in sorted(sources.items()):
        require(re.fullmatch(r"[a-z]+", label) is not None, "RECORD_INVALID", "stack label " + str(label))
        directory = Path(directory)
        if not directory.is_dir():
            continue
        for current, folders, files in os.walk(directory):
            base = Path(current)
            for folder in folders:
                require(not (base / folder).is_symlink(), "RECORD_INVALID", "linked folder " + folder)
            folders[:] = sorted(folder for folder in folders if not SECRET_RECORD_PATTERN.fullmatch(folder))
            for name in sorted(files):
                if name in SECRET_RECORD_NAMES or SECRET_RECORD_PATTERN.fullmatch(name):
                    continue
                path = base / name
                rel = path.relative_to(directory).as_posix()
                require(stat.S_ISREG(path.lstat().st_mode), "RECORD_INVALID", "link or special file " + rel)
                raw = path.read_bytes()
                out = evidence_dir / ("records-" + label) / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                with open(out, "xb") as stream:
                    stream.write(raw)
                rows.append(["records-" + label + "/" + rel, sha256(raw)])
    return sorted(rows)


def phase_results(sources, before=None):
    """The phase result files the product wrote during this leaf (not in `before`, {label: set of names}): stack, file,
    sha256, phase, status and the step outcomes."""
    out = []
    for label, directory in sorted(sources.items()):
        known = (before or {}).get(label, set())
        for path in sorted(Path(directory).glob("result-*.json")):
            if path.name in known:
                continue
            raw = path.read_bytes()
            result = json.loads(raw)
            out.append({"stack": label, "file": path.name, "sha256": sha256(raw), "phase": result.get("phase"),
                        "status": result.get("status"), "steps": [[step.get("step"), step.get("outcome")] for step in result.get("steps") or []]})
    return out


def result_names(sources):
    return {label: {path.name for path in Path(directory).glob("result-*.json")} for label, directory in sources.items()}


def close_leaf(gate, *, request, request_sha256, marker, identity, executed, inherited, phase_rows, results, admission, cleanup,
               observed, expected, records, evidence, fixture_root, output_root, source_root, inputs_before, run_json, started_utc,
               selected_tests, passed, chain=()):
    """The end of one leaf, in this order: the raw product records are preserved into the evidence (secrets policy) while
    the fixture still exists; the source inputs are hashed again; only a passed leaf with a complete cleanup and unchanged
    inputs removes its private fixture root (a failed one keeps it for inspection); the segment binds all of it and its
    path and hash are printed once for the recorder's stdout. Returns (segment, path)."""
    raw = preserve_records(records, evidence) if records else []
    try:
        inputs_after = inputs_summary(source_root)
    except Refused:
        inputs_after = None
    passed = bool(passed) and cleanup.get("complete") is True and inputs_before is not None and inputs_after == inputs_before
    removed = None
    if passed and Path(fixture_root).exists():
        removed = remove_private_root(fixture_root, owner_root=output_root)["removed"]
    record = segment_record(request=request, request_sha256=request_sha256, marker=marker, identity=identity, executed_phases=executed,
                            inherited_phases=inherited, results=results, admission=admission, cleanup=cleanup, run_json=run_json,
                            started_utc=started_utc, ended_utc=now_utc().isoformat(), selected_tests=selected_tests,
                            phase_results=phase_rows, raw_records=raw, inputs_before=inputs_before, inputs_after=inputs_after,
                            parent_chain=chain)
    record.update(observed=observed, expected=expected, fixture_removed=removed, passed=passed)
    path = finish_segment(gate, passed=passed, segment=record, evidence_root=evidence)
    print(json.dumps({"segment": str(path), "sha256": sha256(path.read_bytes())}), flush=True)
    return record, path


def segment_outcome(segment):
    """PASS, EXPECTED_STOP (a negative proof that met exactly its product STOP) or FAIL."""
    if segment.get("exit_code") != 0 or segment.get("skipped") or not (segment.get("cleanup") or {}).get("complete"):
        return "FAIL"
    expected, observed = segment.get("expected") or {"outcome": "PASS"}, segment.get("observed") or {}
    if expected["outcome"] == "PASS":
        return "PASS" if observed.get("outcome", "PASS") == "PASS" else "FAIL"
    return "EXPECTED_STOP" if observed.get("outcome") == "STOP" and observed.get("step") == expected.get("step") else "FAIL"


def fresh_gate_verdict(index):
    """Whether an evidence index counts as a fresh end-to-end rehearsal pass for a final candidate: exactly one fresh
    segment of one of the three existing methods, exit 0, no skip, one test run, complete results and cleanup."""
    reasons = []
    segments = index.get("segments") or []
    if len(segments) != 1:
        reasons.append("not exactly one segment")
    for segment in segments:
        if segment.get("execution_kind") != "fresh" or segment.get("fresh_e2e") is not True or segment.get("stage") is not None:
            reasons.append("inherited, resumed or derived segment " + str(segment.get("unit")))
        if segment.get("case") not in FRESH_CASES.values():
            reasons.append("not a full fresh rehearsal method")
        if segment_outcome(segment) != "PASS" or segment.get("tests_run") != 1:
            reasons.append("exit, skip, result or cleanup incomplete in " + str(segment.get("unit")))
        if not segment.get("results_complete"):
            reasons.append("results incomplete")
    return {"fresh_pass": not reasons, "reasons": reasons}


def leaf_expectation(leaves, unit, proof_root, attempt=1):
    """Everything a leaf's evidence must show, derived from the frozen proof layout (never from the run's own claims):
    the registry leaf, its plan (equal to leaf_plan), request, source manifest and parent manifest with their actual bytes,
    the recorder inputs it must have declared, its exact selection, phases, outcome and checkpoint. The attempt selects
    the request, run folder and evidence root (CKPT2-06): the request must name exactly that attempt's evidence."""
    leaf = registry_leaf(leaves, unit)
    root = Path(proof_root)
    paths = attempt_paths(root, unit, attempt)
    plan_path, registry_path = root / ("plan-" + unit + ".json"), root / "registry.json"
    source_path = root / (leaf["source"] + ".source-manifest.json")
    try:
        plan_raw, source_raw = plan_path.read_bytes(), source_path.read_bytes()
    except OSError as error:
        raise Refused("INDEX_INPUT", "proof input unreadable: " + str(error)) from None
    require(json.loads(plan_raw) == leaf_plan(leaves, unit), "INDEX_INPUT", "the plan file is not this leaf's registered plan")
    source = json.loads(source_raw)
    files, request_sha, parent_sha = [plan_path, registry_path, source_path], None, None
    output = None
    if leaf["stage"] is not None:
        request_path = paths["request"]
        try:
            request_raw = request_path.read_bytes()
            request = json.loads(request_raw)
        except (OSError, ValueError) as error:
            raise Refused("INDEX_INPUT", "request of attempt %d unreadable: %s" % (attempt, type(error).__name__)) from None
        request_sha = sha256(request_raw)
        require(all(request.get(key) == leaf[key] for key in ("unit", "case", "scenario", "stage", "execution_kind")), "INDEX_INPUT",
                "the request is not this leaf's")
        require(Path(request["source_manifest"]["path"]).resolve() == source_path.resolve()
                and request["source_manifest"]["sha256"] == sha256(source_raw), "INDEX_INPUT", "the request names another source copy")
        evidence = Path(request["evidence_root"])
        require(evidence.resolve() == paths["evidence"].resolve(), "INDEX_INPUT", "the request names another attempt's evidence root")
        output = Path(request["output_root"])
        files.append(request_path)
        if request["parent_manifest"]:
            parent_path, parent_sha = Path(request["parent_manifest"]["path"]), request["parent_manifest"]["sha256"]
            try:
                parent_raw = parent_path.read_bytes()
            except OSError:
                raise Refused("INDEX_INPUT", "the parent manifest is unreadable") from None
            require(sha256(parent_raw) == parent_sha, "INDEX_INPUT", "the parent manifest bytes differ from the request")
            files.append(parent_path)
    else:
        evidence = paths["evidence"]
    executed, inherited = leaf_phases(leaf)
    outcome = leaf_outcome(leaf)
    expect = {"unit": unit, "case": leaf["case"], "stage": leaf["stage"], "scenario": leaf["scenario"],
              "execution_kind": leaf["execution_kind"], "request_sha256": request_sha,
              "fresh_e2e": leaf["stage"] is None and leaf["execution_kind"] == "fresh", "module": leaf["file"],
              "marker_plan_sha256": sha256(json.dumps(json.loads(plan_raw)).encode("utf-8")), "outcome": outcome,
              "executed": executed, "inherited": inherited, "parent_manifest_sha256": parent_sha, "produces": leaf_produces(leaf),
              "admission": leaf["execution_kind"] == "diagnostic-fork" and outcome["outcome"] == "PASS",
              "inputs": {"tool": source["tool"]["sha256"], "source": source["source"]["sha256"], "harness": source["harness"]["sha256"]},
              "cwd": str(Path(source["root"]).resolve()), "forward_verdict": leaf["stage"] is None or leaf["case"] in PROOF_THEN,
              "results": expected_results(leaf), "consumes": STAGES[leaf["stage"]]["consumes"] if leaf["stage"] else None,
              "bundles": str(output / "bundles") if output is not None else None}
    return {"leaf": leaf, "expect": expect, "segment_path": evidence / "segment.json", "attempt": attempt, "run_dir": paths["run"],
            "expected_tests": [Path(leaf["file"]).stem + "." + leaf["case"]], "output_root": output,
            "required_files": [str(path) for path in files] + list(LEAF_INPUT_FILES), "required_trees": list(LEAF_INPUT_TREES)}


def segment_contract(segment, expect):
    """The segment's own claims, AND-ed against the expectation: selection, marker, request, kind, outcome, phases and
    their raw results, identities (parent and current apart), unchanged inputs, checkpoint and cleanup."""
    reasons = []
    for key in ("unit", "case", "stage", "scenario", "execution_kind", "request_sha256", "fresh_e2e"):
        if segment.get(key) != expect[key]:
            reasons.append("segment " + key)
    if segment.get("release_gate_eligible") is not False:
        reasons.append("segment release_gate_eligible")
    marker = segment.get("marker") or {}
    if (marker.get("unit") != expect["unit"] or marker.get("module") != expect["module"]
            or marker.get("plan_sha256") != expect["marker_plan_sha256"] or type(marker.get("attempt")) is not int
            or type(marker.get("pid")) is not int):
        reasons.append("segment marker")
    if segment.get("selected_tests") != [expect["case"]]:
        reasons.append("segment selection")
    if segment.get("passed") is not True:
        reasons.append("segment not passed")
    if segment.get("observed") != expect["outcome"]:
        reasons.append("segment outcome")
    if segment.get("executed_phases") != expect["executed"] or segment.get("inherited_phases") != expect["inherited"]:
        reasons.append("segment phases")
    rows = segment.get("phase_results")
    if (type(rows) is not list or sorted(str(row.get("phase")) for row in rows) != sorted(expect["executed"])
            or any(HASH.fullmatch(str(row.get("sha256"))) is None or not row.get("status") or not row.get("steps") for row in rows)):
        reasons.append("segment phase results")
    raw = segment.get("raw_records")
    if (type(raw) is not list or bool(raw) != bool(expect["executed"])
            or any(type(row) is not list or len(row) != 2 or HASH.fullmatch(str(row[1])) is None for row in raw)):
        reasons.append("segment raw records")
    identity = segment.get("identity") or {}
    current = identity.get("current") or {}
    if any(current.get(field) != expect["inputs"][key] for field, key in (("tool_tree_sha256", "tool"), ("source_tree_sha256", "source"),
                                                                           ("harness_tree_sha256", "harness"))):
        reasons.append("segment current identity")
    if expect["execution_kind"] == "fresh":
        if identity.get("parent") is not None or identity.get("parent_reference") is not None or current.get("resumed_utc") is not None:
            reasons.append("segment fresh identity")
    else:
        reference = identity.get("parent_reference") or {}
        if type(identity.get("parent")) is not dict or reference.get("manifest_sha256") != expect["parent_manifest_sha256"]:
            reasons.append("segment parent identity")
        if not current.get("resumed_utc") or current.get("tool_tree_sha256_at_resume") != expect["inputs"]["tool"]:
            reasons.append("segment resume identity")
        chain = segment.get("parent_chain") or []
        if not chain or chain[0].get("manifest_sha256") != expect["parent_manifest_sha256"]:
            reasons.append("segment parent chain")
    before = segment.get("inputs_before") or {}
    if segment.get("inputs_unchanged") is not True or before != segment.get("inputs_after") or before.get("tool") != expect["inputs"]["tool"]:
        reasons.append("segment inputs")
    checkpoint = (segment.get("results") or {}).get("checkpoint")
    if expect["produces"]:
        if (type(checkpoint) is not dict or HASH.fullmatch(str(checkpoint.get("manifest_sha256"))) is None
                or Path(str(checkpoint.get("path"))).name != checkpoint.get("manifest_sha256")):
            reasons.append("segment checkpoint")
    elif checkpoint is not None:
        reasons.append("segment checkpoint from a leaf that seals none")
    if expect["admission"] and HASH.fullmatch(str(segment.get("admission_sha256"))) is None:
        reasons.append("segment admission")
    cleanup = segment.get("cleanup") or {}
    if cleanup.get("complete") is not True or cleanup.get("remaining") or cleanup.get("errors") or segment.get("skipped"):
        reasons.append("segment cleanup or skip")
    return reasons


def _log_references(value, found):
    """Every {"file": "logs/...", "sha256": ...} a product record refers to (step details, command records)."""
    if isinstance(value, dict):
        if type(value.get("file")) is str and value["file"].startswith("logs/") and type(value.get("sha256")) is str:
            found.append((value["file"], value["sha256"]))
        for item in value.values():
            _log_references(item, found)
    elif isinstance(value, list):
        for item in value:
            _log_references(item, found)
    return found


def raw_contract(segment, expect, evidence):
    """CKPT2-01: the raw evidence itself, not the segment's claims about it. Every raw_records file exists under the
    attempt's evidence root with its recorded SHA-256 and no record file is unlisted; per stack the raw plan.json,
    state.json and journal.jsonl are there, the state names the plan.json identity (the product's canonical plan hash, not
    the file hash), and the leaf's own phases are the tail of state.history; each history row binds its raw result file
    by hash, and the raw result's phase, status, steps, request and plan equal the fixed leaf contract (expected_results)
    and that row; the command record and every log a result or command record refers to are there with their hash; the
    segment's phase_results are exactly these raw results. A fresh method binds each stack's plan apart (source and clone
    differ); any other leaf with executed phases names the plan its results ran under; only the refusal proof (T17) has
    no phase and no plan. A fork's admission.json and a sealed checkpoint's manifest are bound by their actual bytes.
    Returns (reasons, bound) - bound is what bound_index re-checks at every consumption (CKPT2-03)."""
    reasons, evidence = [], Path(evidence)
    listed, raw = {}, {}
    for row in segment.get("raw_records") or []:
        if type(row) is list and len(row) == 2 and type(row[0]) is str and type(row[1]) is str:
            listed[row[0]] = row[1]
    for rel, digest in sorted(listed.items()):
        pure = PurePosixPath(rel)
        if ("\\" in rel or pure.is_absolute() or ".." in pure.parts or len(pure.parts) < 2
                or re.fullmatch(r"records-[a-z]+", pure.parts[0]) is None):
            reasons.append("raw record outside the records folders: " + rel)
            continue
        try:
            data = (evidence / rel).read_bytes()
        except OSError:
            reasons.append("raw record missing: " + rel)
            continue
        if sha256(data) != digest:
            reasons.append("raw record changed: " + rel)
            continue
        raw[rel] = data
    try:
        present = {path.relative_to(evidence).as_posix() for folder in evidence.glob("records-*") for path in folder.rglob("*")
                   if path.is_file()}
    except OSError:
        present = set()
        reasons.append("the evidence root is unreadable")
    reasons += ["raw record not listed in the segment: " + rel for rel in sorted(present - set(listed))]
    expected, plans, derived = expect["results"], {}, []
    for stack in sorted({item["stack"] for item in expected}):
        mine = [item for item in expected if item["stack"] == stack]
        prefix = "records-" + stack + "/"
        missing = [name for name in ("plan.json", "state.json", "journal.jsonl") if prefix + name not in raw]
        if missing:
            reasons.append(stack + ": raw " + ", ".join(missing) + " missing")
            continue
        try:
            plan_sha, state = intro.plan_identity(json.loads(raw[prefix + "plan.json"])), json.loads(raw[prefix + "state.json"])
        except ValueError:
            reasons.append(stack + ": raw plan or state unreadable")
            continue
        plans[stack] = plan_sha
        if type(state) is not dict or state.get("plan_sha256") != plan_sha:
            reasons.append(stack + ": the raw state names another plan than its plan.json")
        history = state.get("history") if type(state) is dict and type(state.get("history")) is list else []
        if len(history) < len(mine):
            reasons.append(stack + ": the raw state history lacks the leaf's own phases")
            continue
        for item, row in zip(mine, history[len(history) - len(mine):]):
            label = stack + " " + item["phase"]
            if (type(row) is not dict or row.get("phase") != item["phase"] or row.get("status") != item["history"]
                    or row.get("steps") != item["steps"] or HASH.fullmatch(str(row.get("request_sha256"))) is None):
                reasons.append(label + ": the raw state history differs from the fixed leaf contract")
                continue
            name = "result-" + item["phase"] + "-" + row["request_sha256"][:16] + ".json"
            data = raw.get(prefix + name)
            if data is None or sha256(data) != row.get("result_sha256"):
                reasons.append(label + ": the raw result the history binds is missing or another one")
                continue
            try:
                result = json.loads(data)
                steps = [[step["step"], step["outcome"]] for step in result["steps"]]
            except (ValueError, TypeError, KeyError):
                reasons.append(label + ": the raw result is unreadable")
                continue
            if (result.get("phase") != item["phase"] or result.get("status") != item["status"] or steps != item["steps"]
                    or result.get("request_sha256") != row["request_sha256"] or result.get("plan_sha256") != plan_sha):
                reasons.append(label + ": the raw result differs from the fixed leaf contract (phase, status, steps, request or plan)")
                continue
            references = _log_references(result, [])
            ranges = [step["commands"] for step in result["steps"] if type(step.get("commands")) is dict]
            commands = sorted({str(item.get("file")) for item in ranges if type(item.get("first")) is int and type(item.get("last")) is int
                               and item["last"] >= item["first"]})
            for command in commands:
                if prefix + command not in raw:
                    reasons.append(label + ": the referenced command record is missing: " + str(command))
                    continue
                for line in raw[prefix + command].splitlines():
                    try:
                        _log_references(json.loads(line), references)
                    except ValueError:
                        reasons.append(label + ": an unreadable command record line")
                        break
            for log, digest in references:
                if prefix + log not in raw or sha256(raw[prefix + log]) != digest:
                    reasons.append(label + ": the referenced log is missing or changed: " + log)
            derived.append({"stack": stack, "file": name, "sha256": sha256(data), "phase": result.get("phase"),
                            "status": result.get("status"), "steps": steps})
    key = lambda row: (str(row.get("stack")), str(row.get("file"))) if type(row) is dict else ("", "")
    if sorted(segment.get("phase_results") or [], key=key) != sorted(derived, key=key) and len(derived) == len(expected):
        reasons.append("the segment's phase results are not the raw results")
    current = (segment.get("identity") or {}).get("current") or {}
    if not expected:
        if expect["outcome"].get("outcome") != "REFUSED" or current.get("plan_sha256") is not None or segment.get("phase_results"):
            reasons.append("only the refusal proof runs no phase and names no plan")
    elif expect["stage"] is None:
        if current.get("plan_sha256") is not None:
            reasons.append("a fresh method binds each stack's own plan, never one plan for all")
    elif current.get("plan_sha256") is None or current.get("plan_sha256") != plans.get(expected[0]["stack"]):
        reasons.append("the executed plan is missing or is not the plan the raw results ran under")
    bound = {"evidence": str(evidence.resolve()), "files": sorted([rel, digest] for rel, digest in listed.items()), "plans": plans,
             "admission": None, "checkpoint": None}
    admission_path = evidence / "admission.json"
    if expect["admission"]:
        try:
            data = admission_path.read_bytes()
            admission = json.loads(data)
            if (data != canonical(admission) + b"\n" or sha256(canonical(admission)) != segment.get("admission_sha256")
                    or current.get("admission_sha256") != segment.get("admission_sha256")):
                reasons.append("admission.json is not the admission the segment names")
            elif (admission.get("checkpoint") != expect["consumes"] or admission.get("execution_kind") != "diagnostic-fork"
                  or admission.get("parent_manifest_sha256") != expect["parent_manifest_sha256"] or not admission.get("changed_bodies")):
                reasons.append("admission.json does not admit this fork of its parent")
            bound["admission"] = {"path": str(admission_path.resolve()), "sha256": sha256(data)}
        except (OSError, ValueError, AttributeError):
            reasons.append("admission.json missing or unreadable")
    elif admission_path.exists() or segment.get("admission_sha256") is not None:
        reasons.append("an admission from a leaf that is not an admitted fork")
    checkpoint = (segment.get("results") or {}).get("checkpoint")
    if expect["produces"] and type(checkpoint) is dict:
        folder = Path(str(checkpoint.get("path")))
        try:
            data = (folder / "manifest.json").read_bytes()
            manifest = json.loads(data)
            if sha256(data) != checkpoint.get("manifest_sha256") or folder.name != checkpoint.get("manifest_sha256"):
                reasons.append("the sealed checkpoint's manifest is not the one the segment names")
            elif expect["bundles"] is not None and folder.parent.resolve() != Path(expect["bundles"]).resolve():
                reasons.append("the sealed checkpoint is not in the request's bundle store")
            elif (manifest.get("checkpoint") != expect["produces"] or manifest.get("execution_kind") != expect["execution_kind"]
                  or (manifest.get("parent") or {}).get("manifest_sha256") != expect["parent_manifest_sha256"]
                  or (manifest.get("identity") or {}).get("plan_sha256") != current.get("plan_sha256")):
                reasons.append("the sealed checkpoint is not this leaf's (kind, execution kind, parent or plan)")
            bound["checkpoint"] = {"path": str((folder / "manifest.json").resolve()), "sha256": sha256(data)}
        except (OSError, ValueError, AttributeError):
            reasons.append("the sealed checkpoint's manifest is missing or unreadable")
    return reasons, bound


def _resolved(cwd, name):
    path = Path(name)
    return str((path if path.is_absolute() else Path(cwd) / path).resolve())


def recorded_inputs(run, *, required_files=(), required_trees=()):
    """The input half of an index over a record-run run.json: every recorded input present and unchanged before/after,
    nothing appeared during the run (a new file under a declared tree, such as a bytecode cache, is an input change), and
    the required files and trees were declared."""
    reasons = []
    cwd = run.get("cwd") or "."
    declared = run.get("declared_inputs") or {}
    declared_files = {_resolved(cwd, name) for name in declared.get("files") or []}
    declared_trees = set(declared.get("trees") or [])
    before = {item["path"]: item for item in run.get("files_before") or []}
    after = {item["path"]: item for item in run.get("files_after") or []}
    for path, first in sorted(before.items()):
        last = after.get(path)
        required = path in declared_files or first.get("tree") in declared_trees
        if last is None:
            reasons.append("input not hashed after the run: " + first["requested"])
        elif first.get("status") != "present" or last.get("status") != "present":
            if required or first.get("status") != last.get("status"):
                reasons.append("input missing: " + first["requested"])
        elif first["sha256"] != last["sha256"]:
            reasons.append("input changed during the run: " + first["requested"])
    reasons += ["input appeared during the run: " + after[path]["requested"] for path in sorted(set(after) - set(before))]
    reasons += ["required input not declared: " + name for name in required_files if _resolved(cwd, name) not in declared_files]
    reasons += ["required tree not declared: " + name for name in required_trees if name not in declared_trees]
    return reasons


def evidence_index(run_dir, *, segment_path, expected_tests, expect, required_files=(), required_trees=()):
    """AND-binding of an existing record-run directory: a completed run with exit 0; every recorded input present and
    unchanged before/after, and the leaf's complete required inputs among the declared ones (a shrunk --file list is not
    a binding); logs matching their recorded hashes; the exact test selection and the runner's passed result; the one
    segment the run announced on stdout, unchanged since (path and SHA); the segment's claims (segment_contract); and
    the raw evidence those claims are about (raw_contract, CKPT2-01). The hashes of run.json and segment.json live only
    here, so nothing hashes itself."""
    run_dir, reasons = Path(run_dir), []
    try:
        run_raw = (run_dir / "run.json").read_bytes()
        run = json.loads(run_raw)
    except (OSError, ValueError):
        return {"verdict": "UNVERIFIED", "reasons": ["run.json missing or unreadable"]}
    if run.get("status") != "completed" or run.get("exit_code") != 0 or run.get("recorder_exit_code") != 0:
        reasons.append("command or recorder exit")
    cwd = run.get("cwd") or "."
    if expect.get("cwd") is not None and str(Path(cwd).resolve()) != expect["cwd"]:
        reasons.append("the run's working tree is not the leaf's source copy")
    reasons += recorded_inputs(run, required_files=required_files, required_trees=required_trees)
    logs = {}
    for item in run.get("log_files") or []:
        try:
            actual = sha256((run_dir / item["requested"]).read_bytes())
        except OSError:
            actual = None
        logs[item["requested"]] = actual
        if item.get("status") != "present" or actual != item.get("sha256"):
            reasons.append("log changed or missing: " + item["requested"])
    if set(logs) != {"stdout.log", "stderr.log"}:
        reasons.append("log inventory")
    stdout = (run_dir / "stdout.log").read_bytes().decode("utf-8", errors="replace").splitlines() if (run_dir / "stdout.log").exists() else []
    selections = [json.loads(line[len("EXACT_TESTS "):]) for line in stdout if line.startswith("EXACT_TESTS ")]
    if selections != [list(expected_tests)]:
        reasons.append("selected tests differ")
    outcomes = [json.loads(line[len("PLAN_RESULT "):]) for line in stdout if line.startswith("PLAN_RESULT ")]
    if len(outcomes) != 1 or outcomes[0].get("status") != "passed" or outcomes[0].get("exit_code") != 0:
        reasons.append("the runner did not record this unit as passed")
    announced = [json.loads(line) for line in stdout if line.startswith('{"segment"')]
    segment_raw = segment = None
    try:
        segment_raw = Path(segment_path).read_bytes()
        segment = json.loads(segment_raw)
    except (OSError, ValueError):
        reasons.append("segment missing")
    if len(announced) != 1:
        reasons.append("the run announced %d segments" % len(announced))
    elif segment_raw is not None and (Path(str(announced[0].get("segment"))).resolve() != Path(segment_path).resolve()
                                      or announced[0].get("sha256") != sha256(segment_raw)):
        reasons.append("the segment differs from the one the run announced")
    raw = None
    if type(segment) is dict:
        if Path(str(segment.get("run_json", ""))).resolve() != (run_dir / "run.json").resolve():
            reasons.append("segment names another run")
        reasons += segment_contract(segment, expect)
        # CKPT2-01: the raw records, admission and sealed checkpoint themselves (the segment's claims are not enough).
        found, raw = raw_contract(segment, expect, Path(segment_path).parent)
        reasons += found
    elif segment is not None:
        reasons.append("segment is not a JSON object")
    if expect.get("forward_verdict"):
        rows = [line for line in stdout if line.startswith('{"forward_verdict"')]
        if len(rows) != 1:
            reasons.append("expected exactly one forward_verdict line")
    return {"verdict": "UNVERIFIED" if reasons else "BOUND", "reasons": reasons, "run_dir": str(run_dir.resolve()),
            "run_json_sha256": sha256(run_raw), "segment": str(Path(segment_path).resolve()),
            "segment_sha256": sha256(segment_raw) if segment_raw is not None else None, "logs": logs,
            "selected_tests": list(expected_tests), "raw": raw}


def leaf_index(leaves, unit, proof_root, run_dir=None, attempt=1):
    """The index of one attempt: its request, run folder and evidence root are the ones that attempt names (CKPT2-06)."""
    expectation = leaf_expectation(leaves, unit, proof_root, attempt)
    require(run_dir is None or Path(run_dir).resolve() == expectation["run_dir"].resolve(), "INDEX_INPUT",
            "the run folder is not attempt %d's" % attempt)
    run_dir = expectation["run_dir"]
    result = evidence_index(run_dir, segment_path=expectation["segment_path"], expected_tests=expectation["expected_tests"],
                            expect=expectation["expect"], required_files=expectation["required_files"],
                            required_trees=expectation["required_trees"])
    return {**result, "unit": unit, "case": expectation["leaf"]["case"]}


def bound_index(proof_root, unit):
    """A leaf's BOUND index, re-checked at every consumption (CKPT2-03): run.json, stdout.log, stderr.log, the segment,
    every raw record the index bound, the admission and the sealed checkpoint manifest must still hash to what the index
    recorded. A change, a missing file, a read error or an incomplete index is PARENT_UNBOUND, never a traceback taken as
    a result. Returns (index, segment, the verified stdout bytes)."""
    try:
        index = json.loads((Path(proof_root) / "index" / (unit + ".json")).read_bytes())
    except (OSError, ValueError):
        raise Refused("PARENT_UNBOUND", unit + " has no BOUND index") from None
    require(type(index) is dict and index.get("verdict") == "BOUND" and index.get("unit") == unit, "PARENT_UNBOUND", unit + " is not BOUND")

    def current(path, recorded, what):
        try:
            data = Path(path).read_bytes()
        except OSError:
            raise Refused("PARENT_UNBOUND", unit + ": " + what + " is missing or unreadable") from None
        require(type(recorded) is str and sha256(data) == recorded, "PARENT_UNBOUND", unit + ": " + what + " changed after its index")
        return data
    try:
        run_dir, logs, raw = Path(index["run_dir"]), index["logs"], index["raw"]
        evidence = Path(raw["evidence"])
        current(run_dir / "run.json", index["run_json_sha256"], "run.json")
        stdout = current(run_dir / "stdout.log", logs["stdout.log"], "stdout.log")
        current(run_dir / "stderr.log", logs["stderr.log"], "stderr.log")
        segment = json.loads(current(index["segment"], index["segment_sha256"], "the segment"))
        for rel, digest in raw["files"]:
            current(evidence / rel, digest, "raw record " + rel)
        for key in ("admission", "checkpoint"):
            if raw[key] is not None:
                current(raw[key]["path"], raw[key]["sha256"], key)
    except (KeyError, TypeError, ValueError):
        raise Refused("PARENT_UNBOUND", unit + ": the index or its segment is incomplete") from None
    require(type(segment) is dict, "PARENT_UNBOUND", unit + ": the segment is not an object")
    return index, segment, stdout


def resolve_parent(leaves, unit, proof_root):
    """The parent manifest of a registered leaf: from its parent leaf's BOUND index and segment, the sealed checkpoint
    that leaf produced, of exactly the kind this leaf's stage consumes. No parent is taken from 'the previous leaf'."""
    leaf = registry_leaf(leaves, unit)
    if leaf["parent"] is None:
        return None
    _, segment, _ = bound_index(proof_root, leaf["parent"])
    checkpoint = (segment.get("results") or {}).get("checkpoint") or {}
    path = Path(str(checkpoint.get("path"))) / "manifest.json"
    try:
        raw = path.read_bytes()
        manifest = json.loads(raw)
    except (OSError, ValueError):
        raise Refused("PARENT_UNBOUND", "the parent bundle is missing or unreadable") from None
    require(sha256(raw) == checkpoint.get("manifest_sha256") == path.parent.name, "PARENT_UNBOUND", "the parent bundle changed")
    require(type(manifest) is dict and manifest.get("checkpoint") == STAGES[leaf["stage"]]["consumes"], "PARENT_UNBOUND",
            "the parent sealed " + str(manifest.get("checkpoint") if type(manifest) is dict else manifest))
    return {"path": str(path.resolve()), "sha256": sha256(raw)}


def forward_verdict_reasons(verdict):
    reasons = [] if verdict.get("status") == "DEPLOYED" else ["status " + str(verdict.get("status"))]
    reasons += [key + " not true" for key in FORWARD_REQUIRED_TRUE if not verdict.get(key)]
    if verdict.get("ordinary_entry_side") != "release":
        reasons.append("ordinary entry side " + str(verdict.get("ordinary_entry_side")))
    return reasons


def compare_forward_verdicts(resumed, fresh, *, resumed_bound=False, fresh_bound=False):
    """T16: the resumed A->B suffix and B's fresh forward control reach the same product verdict. IDs, times and the new
    B1 hash are bound to each run's own artifacts and are not compared byte for byte. Equality alone is not the proof:
    t16_pass also needs both verdicts to be a successful forward (DEPLOYED, every required fact true, the release side)
    and both runs BOUND by their evidence index."""
    keys = ("status", "release_images", "health", "migrations_after", "smoke_member_absent", "ordinary_entry_side",
            "ordinary_entry_images", "frame_sha256")
    differences = [key for key in keys if key not in resumed or resumed.get(key) != fresh.get(key)]
    reasons = (["resumed: " + reason for reason in forward_verdict_reasons(resumed)]
               + ["fresh: " + reason for reason in forward_verdict_reasons(fresh)]
               + ([] if resumed_bound else ["the resumed run is not BOUND"]) + ([] if fresh_bound else ["the fresh control is not BOUND"]))
    return {"equal": not differences, "differences": differences, "t16_pass": not differences and not reasons, "reasons": reasons}


def verdict_from_stdout(raw):
    """The single forward_verdict line a forward tail prints (ops_deploy_host_container_test.forward_verdict), from the
    stdout bytes bound_index verified; an unreadable line is UNVERIFIED, never an exception."""
    try:
        rows = [json.loads(line)["forward_verdict"] for line in raw.decode("utf-8", errors="replace").splitlines()
                if line.startswith('{"forward_verdict"')]
    except (ValueError, KeyError, TypeError):
        raise Refused("UNVERIFIED", "an unreadable forward_verdict line") from None
    require(len(rows) == 1 and type(rows[0]) is dict, "UNVERIFIED", "expected exactly one forward_verdict object")
    return rows[0]


def t16_comparison(leaves, proof_root):
    """The late-resume leaf and the fresh control, each from its BOUND index re-checked now (bound_index: run.json, logs,
    segment, raw records, admission) and the stdout bytes that check verified (CKPT2-03)."""
    resumed_unit = next(leaf["unit"] for leaf in registry_valid(leaves) if leaf["case"] == "CheckpointSegments.test_late_change_resume")
    fresh_unit = next(leaf["unit"] for leaf in leaves if leaf["stage"] is None and leaf["scenario"] == "forward")
    verdicts, bound, unbound = {}, {}, []
    for side, unit in (("resumed", resumed_unit), ("fresh", fresh_unit)):
        try:
            _, _, stdout = bound_index(proof_root, unit)
            verdicts[side], bound[side] = verdict_from_stdout(stdout), True
        except Refused as error:
            bound[side], verdicts[side] = False, {}
            unbound.append(side + ": " + str(error))
    result = compare_forward_verdicts(verdicts["resumed"], verdicts["fresh"], resumed_bound=bound["resumed"], fresh_bound=bound["fresh"])
    result["reasons"] += unbound
    return result


def proof_commands(leaves, *, proof_root, candidate, python="python3", from_unit=None, attempt=1):
    """The exact T16/T17 command sequence (bash) for the frozen registry at <proof_root>/registry.json: the source copies,
    then per leaf in registry order its plan, its request (parent resolved from the parent leaf's BOUND index), the
    recorded run through the live gate with every input declared, and its index; then the T16 comparison. Every leaf runs
    as attempt 1 there.

    A retry (CKPT2-06, `from_unit` with attempt 2 or 3) resumes the same sequence at that unit: no source copy is made
    again and no earlier (BOUND) leaf runs again; `retry` first checks the gate ledger and the released marker
    (retry_admission); the unit keeps its plan file, parent and ledger, and only its request, run folder and evidence root
    are the attempt's own; the later leaves follow as their attempt 1."""
    leaves = registry_valid(leaves)
    root, candidate = str(PurePosixPath(proof_root)), str(PurePosixPath(candidate))
    require(root.startswith("/") and candidate.startswith("/"), "REGISTRY_INVALID", "absolute Linux paths required")
    units = [leaf["unit"] for leaf in leaves]
    if from_unit is None:
        require(attempt == 1, "REGISTRY_INVALID", "a retry names its unit (--from-unit)")
        start = 0
    else:
        require(from_unit in units, "REGISTRY_INVALID", "unregistered unit " + str(from_unit))
        require(type(attempt) is int and 2 <= attempt <= MAX_ATTEMPTS, "REGISTRY_INVALID", "a retry is attempt 2 or 3")
        start = units.index(from_unit)
    q = shlex.quote
    tool = python + " -B " + q(candidate + "/tests/ops_release_checkpoints.py")
    registry = q(root + "/registry.json")
    lines = ["#!/usr/bin/env bash", "# RELEASE-TOOLS-CHECKPOINTS T16/T17 (generated by tests/ops_release_checkpoints.py commands).",
             "# Run as the persistent live-gate account (root) on the native Linux synthetic host, one leaf at a time.",
             "set -euo pipefail"]
    lines += [': "${%s:?}"' % name for name in ("KIN_TEST_PREVIOUS_API_IMAGE", "KIN_TEST_PREVIOUS_PROXY_IMAGE", "KIN_TEST_API_IMAGE",
                                                "KIN_TEST_PROXY_IMAGE", "PLAYWRIGHT_BROWSERS_PATH")]
    lines += ["export KIN_TEST_ISOLATED_INSTALL=1", "test -f " + registry, "mkdir -p -m 700 " + q(root + "/runs") + " " + q(root + "/index")]
    if from_unit is None:
        for source in sorted({leaf["source"] for leaf in leaves}):
            mutant = PROOF_SOURCES.get(source)
            lines.append(tool + " source-copy --source " + q(candidate) + " --out " + q(root + "/" + source)
                         + (" --mutant " + mutant if mutant else ""))
    else:
        lines.append("# Retry of " + from_unit + " as attempt " + str(attempt) + ": the source copies and the BOUND leaves before it stay.")
        lines += ["test -f " + q(root + "/" + source + ".source-manifest.json") for source in sorted({leaf["source"] for leaf in leaves[start:]})]
        lines.append(tool + " retry --registry " + registry + " --unit " + from_unit + " --attempt " + str(attempt) + " --proof-root " + q(root))
    for leaf in leaves[start:]:
        unit, source = leaf["unit"], leaf["source"]
        number = attempt if unit == from_unit else 1
        paths = attempt_paths(root, unit, number, flavour=PurePosixPath)
        copy_root, run, request = root + "/" + source, str(paths["run"]), str(paths["request"])
        plan = root + "/plan-" + unit + ".json"
        lines += ["", "# " + unit + " (attempt " + str(number) + "): " + leaf["case"] + " from copy " + source
                  + (" consuming " + STAGES[leaf["stage"]]["consumes"] + " of " + leaf["parent"] if leaf["parent"] else " (no parent)")]
        # The gate plan is written once per unit (its ledger is keyed by it); a retry reuses the same file.
        lines.append("test -f " + q(plan) if number > 1 else tool + " plan --registry " + registry + " --unit " + unit + " --out " + q(plan))
        files = ["--file " + q(plan), "--file " + registry, "--file " + q(root + "/" + source + ".source-manifest.json")]
        if leaf["stage"] is not None:
            lines.append(tool + " request --registry " + registry + " --unit " + unit + " --attempt " + str(number) + " --proof-root " + q(root)
                         + " --out " + q(request))
            files.append("--file " + q(request))
            if leaf["parent"]:
                files.append('--file "$(' + tool + " parent-manifest --request " + q(request) + ')"')
            environment = ["env", "-u", "KIN_TEST_EMR_REHEARSAL", "-u", "KIN_TEST_EMR_REHEARSAL_EVIDENCE", "KIN_TEST_EMR_CHECKPOINTS=1",
                           "KIN_TEST_EMR_CHECKPOINT_REQUEST=" + q(request), "KIN_TEST_EMR_CHECKPOINT_REGISTRY=" + registry,
                           "KIN_TEST_EMR_CHECKPOINT_RUN_JSON=" + q(run + "/run.json")]
        else:
            environment = ["env", "-u", REQUEST_ENV, "-u", OPT_IN_ENV, "KIN_TEST_EMR_REHEARSAL=1",
                           "KIN_TEST_EMR_REHEARSAL_EVIDENCE=" + q(str(paths["evidence"])),
                           "KIN_TEST_EMR_CHECKPOINT_RUN_JSON=" + q(run + "/run.json")]
        files += ["--file " + name for name in LEAF_INPUT_FILES] + ["--tree " + name for name in LEAF_INPUT_TREES]
        lines.append("(cd " + q(copy_root) + " && " + " ".join(environment) + " " + python + " -B scripts/record-run.py --run-dir " + q(run)
                     + " --cwd " + q(copy_root) + " " + " ".join(files) + " -- " + python + " -B scripts/run-tests.py --plan " + q(plan) + ")")
        lines.append(tool + " index --registry " + registry + " --unit " + unit + " --attempt " + str(number) + " --proof-root " + q(root)
                     + " --run-dir " + q(run))
    lines += ["", tool + " compare --registry " + registry + " --proof-root " + q(root)]
    return "\n".join(lines) + "\n"


# ── host preconditions of the generated proof (checked by `commands` before proof.sh exists) ──
# A leaf that fails on one of these spends a gate attempt of its unit without proving anything (T16 run-d1428: attempt 1
# lacked pydicom, attempt 2 ran under /home/ubuntu), so `commands` refuses them instead.

# Every leaf runs `<python> -B` for the recorder, the runner and the tests: the smoke browser imports Playwright from it and
# the synthetic study is written with pydicom (ops_deploy_host_container_test.synthetic_dicom).
PROOF_PYTHON_MODULES = (("playwright", "playwright.sync_api"), ("pydicom", "pydicom"))
PROOF_PYTHON_PROBE = """import importlib, importlib.metadata, json, sys
found = {}
for name, module in %r:
    try:
        importlib.import_module(module)
        found[name] = {"version": importlib.metadata.version(name)}
    except Exception as error:
        found[name] = {"error": type(error).__name__ + ": " + str(error)}
print(json.dumps({"python": sys.version.split()[0], "executable": sys.executable, "modules": found}))
""" % (PROOF_PYTHON_MODULES,)


def python_precondition(python, *, cwd=None, run=subprocess.run):
    """The --python interpreter imports playwright and pydicom (their versions are returned); anything else refuses."""
    try:
        result = run([python, "-B", "-c", PROOF_PYTHON_PROBE], capture_output=True, text=True, timeout=120, cwd=cwd)
    except (OSError, subprocess.SubprocessError) as error:
        raise Refused("HOST_PRECONDITION", "--python %s cannot run: %s" % (python, error)) from None
    try:
        observed = json.loads(result.stdout.strip().splitlines()[-1]) if result.returncode == 0 else None
        modules = observed["modules"]
        require(set(modules) == {name for name, _ in PROOF_PYTHON_MODULES}, "HOST_PRECONDITION")
    except (IndexError, ValueError, TypeError, KeyError, Refused):
        raise Refused("HOST_PRECONDITION", "--python %s did not answer the module probe (exit %s): %s"
                      % (python, result.returncode, (result.stderr or "").strip()[-400:])) from None
    missing = ["%s (%s)" % (name, modules[name].get("error")) for name, _ in PROOF_PYTHON_MODULES if "version" not in modules[name]]
    require(not missing, "HOST_PRECONDITION", "--python %s lacks %s; install it into that interpreter (a leaf would otherwise "
            "spend a gate attempt on it)" % (python, ", ".join(missing)))
    return {"python": python, "version": observed.get("python"), "executable": observed.get("executable"),
            "modules": {name: modules[name]["version"] for name, _ in PROOF_PYTHON_MODULES}}


def user_homes():
    """The home folders of the host's user accounts (uid 1000 and above, apart from nobody), from the account database."""
    import pwd
    return sorted({PurePosixPath(entry.pw_dir) for entry in pwd.getpwall()
                   if entry.pw_uid >= 1000 and entry.pw_uid != 65534 and entry.pw_dir.startswith("/") and entry.pw_dir != "/"})


def root_owned_chain(path, what, *, homes, lstat=os.lstat):
    """`path` and every folder above it: no link, owned by uid 0, writable by neither group nor others, and not inside a
    user's home. The product refuses anything else for the declared overlay (IRT2-19) and for the browser module
    (ops_deploy_host.protected), and both live under the proof root's copies; the copies borrow the candidate's objects."""
    require(type(path) is str and path.startswith("/"), "HOST_PRECONDITION", what + " must be an absolute Linux path: " + repr(path))
    pure = PurePosixPath(path)
    require(".." not in pure.parts, "HOST_PRECONDITION", what + " must not contain '..': " + path)
    for home in homes:
        require(pure != home and home not in pure.parents, "HOST_PRECONDITION",
                "%s %s lies inside the user home %s; use a root-owned folder such as /srv/kin-ckpt/..." % (what, pure, home))
    chain = []
    for item in reversed((pure, *pure.parents)):
        try:
            info = lstat(str(item))
        except OSError as error:
            raise Refused("HOST_PRECONDITION", "%s: %s cannot be read: %s" % (what, item, error)) from None
        require(not stat.S_ISLNK(info.st_mode), "HOST_PRECONDITION", "%s has a link on its path: %s" % (what, item))
        require(info.st_uid == 0, "HOST_PRECONDITION", "%s is not on a root-owned path: %s is owned by uid %d" % (what, item, info.st_uid))
        require(not info.st_mode & 0o022, "HOST_PRECONDITION",
                "%s is not on a protected path: %s is writable by group or others (mode %s)" % (what, item, oct(info.st_mode & 0o7777)))
        chain.append({"path": str(item), "uid": info.st_uid, "mode": oct(info.st_mode & 0o7777)})
    return chain


def host_preconditions(python, proof_root, candidate, *, platform=None, homes=None, lstat=os.lstat, run=subprocess.run):
    """What `commands` checks before it writes proof.sh: a POSIX host, the proof root and the candidate on root-owned
    chains outside every user home, and the --python interpreter with Playwright and pydicom."""
    platform = os.name if platform is None else platform
    require(platform == "posix", "HOST_PRECONDITION", "T16/T17 run on a native Linux host (this host is %s)" % platform)
    homes = user_homes() if homes is None else [PurePosixPath(home) for home in homes]
    paths = {what: root_owned_chain(str(value), what, homes=homes, lstat=lstat)
             for what, value in (("--proof-root", proof_root), ("--candidate", candidate))}
    return {"paths": paths, "python": python_precondition(python, cwd=str(candidate), run=run)}


# ── source copies for the Linux proofs ──

def mutate_body(text, qualified, replacement):
    """Replace one function body (by AST range) with `replacement` lines, keeping signature and indentation."""
    tree = ast.parse(text)
    bodies = _function_bodies(text, tree)
    require(qualified in bodies, "INPUT_INVALID", qualified)
    start, end = bodies[qualified]
    line_start = text.rfind("\n", 0, start) + 1
    indent = text[line_start:start]
    require(indent.strip() == "", "INPUT_INVALID", "one-line body")
    body = "\n".join(indent + line for line in replacement)
    return text[:line_start] + body + text[end:]


MUTANT_SOURCES = {
    "backup-readiness-stop": (("HostOps.backup_readiness",
                               ['raise Stop("RELEASE-TOOLS-CHECKPOINTS T16 input A: deterministic L-11a STOP")']),),
    "prepare-change": (("HostOps.prepare", None),),
    "prepare-and-late": (("HostOps.prepare", None), ("HostOps.backup_readiness",
                                                     ['raise Stop("RELEASE-TOOLS-CHECKPOINTS T17 input: late body too")'])),
}


def mutated_product(text, mutant):
    for qualified, replacement in MUTANT_SOURCES[mutant]:
        if replacement is None:
            # Keep the body's behaviour and add one statement after its docstring: a real prefix body change.
            tree = ast.parse(text)
            start, end = _function_bodies(text, tree)[qualified]
            line_end = text.find("\n", text.find('"""', start + 3) + 3)
            line_start = text.rfind("\n", 0, start) + 1
            indent = text[line_start:start]
            text = text[:line_end + 1] + indent + 'require(True, "RELEASE-TOOLS-CHECKPOINTS T17 input C")\n' + text[line_end + 1:]
        else:
            text = mutate_body(text, qualified, replacement)
    return text


def source_copy(source, out, mutant=None):
    """A frozen copy of the candidate (shared Git objects, detached at its HEAD), optionally with one product body
    mutated in the working tree only, and its source manifest from the actual bytes."""
    out = Path(out)
    require(not out.exists(), "RESOURCE_EXISTS", str(out))
    head = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], capture_output=True, check=True, text=True).stdout.strip()
    subprocess.run(["git", "-c", "safe.directory=*", "clone", "-q", "-c", "core.autocrlf=false", "--shared", "--no-checkout",
                    str(source), str(out)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(out), "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", head], check=True,
                   capture_output=True)
    if mutant:
        path = out / PRODUCT_FILE
        path.write_bytes(mutated_product(path.read_bytes().decode("utf-8"), mutant).encode("utf-8"))
    identity = source_identity(out)
    manifest = {"schema": SCHEMA, "kind": "release-tools-source", "head": head, "mutant": mutant, "root": str(out),
                "tool": identity["tool"], "source": identity["source"], "harness": identity["harness"], "tool_files": identity["tool_files"]}
    target = out.with_name(out.name + ".source-manifest.json")
    target.write_bytes(canonical(manifest) + b"\n")
    return target


def leaf_request(leaves, unit, proof_root, attempt=1):
    """The closed request of one attempt of a registered stage leaf: its own source copy's manifest, the parent resolved
    from the parent leaf's BOUND index (never given by hand; the same for every attempt), one shared output root (one
    bundle store, so every parent chain is queryable) and the attempt's own new evidence root under <proof_root>
    (an existing request, run folder or evidence root of that attempt is refused: CKPT2-06)."""
    leaf = registry_leaf(leaves, unit)
    require(leaf["stage"] is not None, "REQUEST_INVALID", unit + " is a fresh method: it never takes a request")
    root = Path(proof_root)
    paths = unused_attempt(attempt_paths(root, unit, attempt))
    source = root / (leaf["source"] + ".source-manifest.json")
    return {"schema": SCHEMA, "unit": leaf["unit"], "case": leaf["case"], "scenario": leaf["scenario"], "stage": leaf["stage"],
            "execution_kind": leaf["execution_kind"], "parent_manifest": resolve_parent(leaves, unit, proof_root),
            "source_manifest": {"path": str(source.resolve()), "sha256": sha256(source.read_bytes())},
            "output_root": str((root / "out").resolve()), "evidence_root": str(paths["evidence"].resolve())}


def write_index(proof_root, result):
    """<proof_root>/index/<unit>.<run>.attempt.json for every attempt; <unit>.json only for the one BOUND attempt (a passed unit
    never passes twice, so an existing BOUND index is never replaced)."""
    folder = Path(proof_root) / "index"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    raw = canonical(result) + b"\n"
    with open(folder / (result["unit"] + "." + Path(result["run_dir"]).name + ".attempt.json"), "xb") as stream:
        stream.write(raw)
    if result["verdict"] == "BOUND":
        with open(folder / (result["unit"] + ".json"), "xb") as stream:
            stream.write(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(description="RELEASE-TOOLS-CHECKPOINTS helper (no Docker)")
    sub = parser.add_subparsers(dest="command", required=True)
    registry = sub.add_parser("registry")
    registry.add_argument("--out", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--registry", required=True)
    plan.add_argument("--unit", required=True)
    plan.add_argument("--out", required=True)
    request = sub.add_parser("request")
    request.add_argument("--registry", required=True)
    request.add_argument("--unit", required=True)
    request.add_argument("--proof-root", required=True)
    request.add_argument("--attempt", type=int, default=1)
    request.add_argument("--out", required=True)
    retry = sub.add_parser("retry")
    retry.add_argument("--registry", required=True)
    retry.add_argument("--unit", required=True)
    retry.add_argument("--attempt", type=int, required=True)
    retry.add_argument("--proof-root", required=True)
    parent = sub.add_parser("parent-manifest")
    parent.add_argument("--request", required=True)
    copy_parser = sub.add_parser("source-copy")
    copy_parser.add_argument("--source", required=True)
    copy_parser.add_argument("--out", required=True)
    copy_parser.add_argument("--mutant", choices=sorted(MUTANT_SOURCES))
    commands = sub.add_parser("commands", description="Print proof.sh after checking the host preconditions (HOST_PRECONDITION "
                              "otherwise, before any byte is written).")
    commands.add_argument("--registry", required=True)
    commands.add_argument("--proof-root", required=True, help="absolute; it and every folder above it root-owned, writable by "
                          "no group or other, outside every user home (e.g. /srv/kin-ckpt/proof-<stamp>)")
    commands.add_argument("--candidate", required=True, help="the candidate checkout, on a root-owned chain like --proof-root")
    commands.add_argument("--python", default="python3", help="the interpreter of every leaf; it must import playwright and pydicom")
    commands.add_argument("--from-unit")
    commands.add_argument("--attempt", type=int, default=1)
    index = sub.add_parser("index")
    index.add_argument("--registry", required=True)
    index.add_argument("--unit", required=True)
    index.add_argument("--proof-root", required=True)
    index.add_argument("--attempt", type=int, default=1)
    index.add_argument("--run-dir")
    compare = sub.add_parser("compare")
    compare.add_argument("--registry", required=True)
    compare.add_argument("--proof-root", required=True)
    args = parser.parse_args(argv)

    def write_new(path, value):
        with open(path, "xb") as out:
            out.write(canonical(value) + b"\n")
        print(json.dumps({"written": str(path), "sha256": sha256(Path(path).read_bytes())}))

    def leaves():
        return registry_valid(json.loads(Path(args.registry).read_bytes()))

    try:
        if args.command == "registry":
            write_new(args.out, registry_valid(list(DEFAULT_PROOF_LEAVES)))
        elif args.command == "plan":
            write_new(args.out, leaf_plan(leaves(), args.unit))
        elif args.command == "request":
            require(Path(args.out).resolve() == attempt_paths(args.proof_root, args.unit, args.attempt)["request"].resolve(),
                    "REQUEST_INVALID", "the request file of attempt %d is %s" % (args.attempt,
                                                                               attempt_paths(args.proof_root, args.unit, args.attempt)["request"]))
            write_new(args.out, leaf_request(leaves(), args.unit, args.proof_root, args.attempt))
        elif args.command == "retry":
            import live_test_gate
            print(json.dumps(retry_admission(live_test_gate.STATE, leaves(), args.unit, args.attempt, args.proof_root)))
        elif args.command == "parent-manifest":
            value = json.loads(Path(args.request).read_bytes())["parent_manifest"]
            require(value is not None, "REQUEST_INVALID", "this request has no parent manifest")
            print(value["path"])
        elif args.command == "source-copy":
            path = source_copy(Path(args.source).resolve(), Path(args.out).resolve(), args.mutant)
            print(json.dumps({"source_manifest": str(path), "sha256": sha256(path.read_bytes())}))
        elif args.command == "commands":
            require(Path(args.registry).resolve() == (Path(args.proof_root) / "registry.json").resolve(), "REGISTRY_INVALID",
                    "the frozen registry lives at <proof-root>/registry.json")
            # Before any byte of proof.sh: a host that cannot pass a leaf is refused here, not inside a gate attempt.
            facts = host_preconditions(args.python, args.proof_root, args.candidate)
            script = proof_commands(leaves(), proof_root=args.proof_root, candidate=args.candidate, python=args.python,
                                    from_unit=args.from_unit, attempt=args.attempt)
            print(json.dumps({"host_preconditions": facts}), file=sys.stderr)
            sys.stdout.write(script)
        elif args.command == "index":
            result = leaf_index(leaves(), args.unit, args.proof_root, args.run_dir, args.attempt)
            write_index(args.proof_root, result)
            print(json.dumps(result, indent=2))
            return 0 if result["verdict"] == "BOUND" else 1
        elif args.command == "compare":
            result = t16_comparison(leaves(), args.proof_root)
            print(json.dumps(result, indent=2))
            return 0 if result["t16_pass"] else 1
    except (Refused, FileExistsError) as error:
        print("CHECKPOINT_REFUSED " + str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
