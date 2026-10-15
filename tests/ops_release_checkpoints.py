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
import os
from pathlib import Path, PurePosixPath
import re
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
DEFAULT_PROOF_LEAVES = (
    {"unit": "release-tools-checkpoints-proof-prefix-source", "file": LIVE_FILE, "case": STAGES["source"]["case"],
     "scenario": "forward", "stage": "source", "execution_kind": "fresh", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-prefix-seed", "file": LIVE_FILE, "case": STAGES["seed"]["case"],
     "scenario": "forward", "stage": "seed", "execution_kind": "reseed-from-recorded-b0", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-prefix-capture", "file": LIVE_FILE, "case": STAGES["capture"]["case"],
     "scenario": "forward", "stage": "capture", "execution_kind": "checkpoint-resume", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-prefix-introduce", "file": LIVE_FILE, "case": STAGES["introduce"]["case"],
     "scenario": "forward", "stage": "introduce", "execution_kind": "checkpoint-resume", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-prefix-verify", "file": LIVE_FILE, "case": STAGES["verify"]["case"],
     "scenario": "forward", "stage": "verify", "execution_kind": "checkpoint-resume", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-late-fault", "file": LIVE_FILE, "case": "CheckpointSegments.test_original_late_fault",
     "scenario": "forward", "stage": "forward-tail", "execution_kind": "checkpoint-resume", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-late-resume", "file": LIVE_FILE, "case": "CheckpointSegments.test_late_change_resume",
     "scenario": "forward", "stage": "verify", "execution_kind": "diagnostic-fork", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-fresh-control", "file": REHEARSAL_FILE, "case": FRESH_CASES["forward"],
     "scenario": "forward", "stage": None, "execution_kind": "fresh", "proof": "T16"},
    {"unit": "release-tools-checkpoints-proof-early-refusal", "file": LIVE_FILE, "case": "CheckpointSegments.test_earlier_change_refused",
     "scenario": "forward", "stage": "verify", "execution_kind": "diagnostic-fork", "proof": "T17"},
)


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
    return manifest, directory


def archive_members(path, *, category=None):
    """Validate a tar archive's members with the standard library before any extraction: no absolute or parent paths,
    no device/FIFO/hardlink members, no undeclared link and nothing beneath a link. Returns the validated members."""
    declared = DECLARED_LINKS.get(category)
    links, out = set(), []
    try:
        with tarfile.open(path, "r:") as archive:
            for member in archive.getmembers():
                name = member.name[2:] if member.name.startswith("./") else member.name
                if name in ("", "."):
                    require(member.isdir(), "ARCHIVE_INVALID", "root entry")
                    out.append(member)
                    continue
                pure = PurePosixPath(name)
                require(not pure.is_absolute() and ".." not in pure.parts and "\\" not in name, "ARCHIVE_INVALID", "path " + name)
                require(not any(str(parent) in links for parent in pure.parents), "ARCHIVE_INVALID", "member under a link " + name)
                if member.issym():
                    require(declared is not None and declared[0].fullmatch(name) is not None and member.linkname == declared[1],
                            "ARCHIVE_INVALID", "undeclared link " + name)
                    links.add(name)
                else:
                    require(member.isfile() or member.isdir(), "ARCHIVE_INVALID", "unsupported member " + name)
                out.append(member)
    except (tarfile.TarError, OSError) as error:
        raise Refused("ARCHIVE_INVALID", type(error).__name__) from None
    return out


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
    migration runs; the product's boundary contract is observed at the end. Returns the action log."""
    spec = CHECKPOINTS[manifest["checkpoint"]]
    actions = []
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

def cleanup_owned(backend, owned):
    """Remove exactly the owned resources (exact labels or recorded IDs), then observe their absence. A removal whose
    re-query still lists the resource, or a failed query, makes the cleanup incomplete; foreign resources stay."""
    removed, errors = [], []
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
    try:
        after = backend.inventory()
        remaining = [item["name"] for kind in ("containers", "volumes", "networks") for item in after[kind] if owned_resource(item, owned)]
    except Exception as error:
        return {"complete": False, "removed": removed, "remaining": [], "errors": errors + ["re-query: " + type(error).__name__]}
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

def host_admission(facts, expected=None, *, gate=None):
    """Native Linux, the persistent live slot, D1034 (RAM, no foreign kin containers running or stopped, daemon
    answering), and for a resume the same host, daemon, architecture and absolute root as the checkpoint."""
    if gate is not None:
        gate.require_live_run()
        gate_state = Path(gate.STATE)
        require(facts.get("gate_state") == str(gate_state) and gate_state.is_dir(), "HOST_REFUSED", "persistent live slot")
    require(facts.get("os") == "linux", "UNSUPPORTED_HOST", "v1 checkpoints run on native Linux only")
    require("docker desktop" not in str(facts.get("docker_os", "")).lower() and facts.get("docker_os"), "UNSUPPORTED_HOST",
            "Docker Desktop is not a native Linux daemon")
    require(facts.get("daemon_ok") is True and facts.get("daemon_identity"), "DAEMON_UNAVAILABLE", "daemon query failed")
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


def bind_marker(gate, request):
    """The current gate marker's identity, read from the gate, never from the request."""
    raw = (Path(gate.STATE) / "live-needs-inspection.json").read_bytes()
    marker = json.loads(raw)
    gate.validate_identity(marker)
    require(marker["unit"] == request["unit"] and marker["pid"] == os.getpid(), "REQUEST_INVALID", "marker unit/pid")
    return {key: marker[key] for key in ("unit", "module", "attempt", "plan_sha256", "pid", "started_at")}


def finish_segment(gate, *, passed, segment, evidence_root):
    """Write the segment record. A failed or uncertain segment keeps the gate's marker for inspection: this harness never
    deletes or rewrites the marker or the unit ledger (release goes through gate.release_after_inspection only)."""
    path = Path(evidence_root) / "segment.json"
    path.write_bytes(canonical({**segment, "passed": bool(passed)}) + b"\n")
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
    units, selections = set(), set()
    for leaf in leaves:
        require(type(leaf) is dict and set(leaf) == {"unit", "file", "case", "scenario", "stage", "execution_kind", "proof"},
                "REGISTRY_INVALID", "leaf keys")
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
        key = (leaf["file"], leaf["case"])
        require(key not in selections, "REGISTRY_INVALID", "duplicate selection " + leaf["case"])
        selections.add(key)
    return list(leaves)


def leaf_plan(leaves, unit, *, timeout_seconds=MAX_ATTEMPT_SECONDS):
    """The run-tests plan of one registered leaf. The unit comes from the registry only: an output root, source SHA,
    attempt or evidence folder never names a new unit (no fresh failure budget)."""
    leaf = next((item for item in registry_valid(leaves) if item["unit"] == unit), None)
    require(leaf is not None, "REGISTRY_INVALID", "unregistered unit " + str(unit))
    require(type(timeout_seconds) is int and 1 <= timeout_seconds <= MAX_ATTEMPT_SECONDS, "REGISTRY_INVALID", "timeout")
    return {"unit": leaf["unit"], "mode": "live", "tests": [{"file": leaf["file"], "case": leaf["case"]}],
            "max_attempts": MAX_ATTEMPTS, "timeout_seconds": timeout_seconds}


REQUEST_KEYS = ("schema", "unit", "case", "scenario", "stage", "execution_kind", "parent_manifest", "source_manifest",
                "output_root", "evidence_root")


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
    return request, sha256(raw)


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
                   cleanup, run_json, started_utc, ended_utc, selected_tests):
    kind = request["execution_kind"]
    return {"schema": SCHEMA, "kind": "release-tools-checkpoint-segment", "unit": request["unit"], "case": request["case"],
            "stage": request["stage"], "scenario": request["scenario"], "execution_kind": kind,
            "fresh_e2e": kind == "fresh" and request["stage"] is None,
            "release_gate_eligible": False, "request_sha256": request_sha256, "marker": marker, "identity": identity,
            "executed_phases": list(executed_phases), "inherited_phases": list(inherited_phases), "results": results,
            "admission_sha256": sha256(canonical(admission)) if admission else None, "cleanup": cleanup,
            "run_json": str(run_json), "started_utc": started_utc, "ended_utc": ended_utc, "selected_tests": list(selected_tests)}


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


def evidence_index(run_dir, *, segment_path, expected_tests, declared_inputs):
    """AND-binding of an existing record-run directory: completed run, exit 0, declared inputs unchanged and present,
    logs matching their recorded hashes, the exact test selection, and a segment naming this run.json (hashes of
    run.json and segment.json live only here, so nothing hashes itself)."""
    run_dir, reasons = Path(run_dir), []
    try:
        run_raw = (run_dir / "run.json").read_bytes()
        run = json.loads(run_raw)
    except (OSError, ValueError):
        return {"verdict": "UNVERIFIED", "reasons": ["run.json missing or unreadable"]}
    if run.get("status") != "completed" or run.get("exit_code") != 0 or run.get("recorder_exit_code") != 0:
        reasons.append("command or recorder exit")
    before = {item["requested"]: item for item in run.get("files_before") or []}
    after = {item["requested"]: item for item in run.get("files_after") or []}
    for name in declared_inputs:
        first, last = before.get(name), after.get(name)
        if not first or not last or first.get("status") != "present" or last.get("status") != "present":
            reasons.append("declared input missing: " + name)
        elif first["sha256"] != last["sha256"]:
            reasons.append("declared input changed during the run: " + name)
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
    stdout = (run_dir / "stdout.log").read_bytes().decode("utf-8", errors="replace") if (run_dir / "stdout.log").exists() else ""
    selections = [json.loads(line[len("EXACT_TESTS "):]) for line in stdout.splitlines() if line.startswith("EXACT_TESTS ")]
    if selections != [list(expected_tests)]:
        reasons.append("selected tests differ")
    segment_raw = None
    try:
        segment_raw = Path(segment_path).read_bytes()
        segment = json.loads(segment_raw)
        if Path(segment.get("run_json", "")).resolve() != (run_dir / "run.json").resolve():
            reasons.append("segment names another run")
        if not (segment.get("cleanup") or {}).get("complete") or segment.get("skipped"):
            reasons.append("segment cleanup or skip")
    except (OSError, ValueError):
        reasons.append("segment missing")
    return {"verdict": "UNVERIFIED" if reasons else "BOUND", "reasons": reasons, "run_json_sha256": sha256(run_raw),
            "segment_sha256": sha256(segment_raw) if segment_raw is not None else None,
            "logs": logs, "selected_tests": list(expected_tests)}


def compare_forward_verdicts(resumed, fresh):
    """T16: the resumed A->B suffix and B's fresh forward control reach the same product verdict. IDs, times and the new
    B1 hash are bound to each run's own artifacts and are not compared byte for byte."""
    keys = ("status", "release_images", "health", "migrations_after", "smoke_member_absent", "ordinary_entry_side",
            "ordinary_entry_images", "frame_sha256")
    differences = [key for key in keys if key not in resumed or resumed.get(key) != fresh.get(key)]
    return {"equal": not differences, "differences": differences}


def verdict_from_log(path):
    """The single forward_verdict line a forward tail prints (ops_deploy_host_container_test.forward_verdict)."""
    rows = [json.loads(line)["forward_verdict"] for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
            if line.startswith('{"forward_verdict"')]
    require(len(rows) == 1, "UNVERIFIED", "expected exactly one forward_verdict line in " + str(path))
    return rows[0]


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
    request.add_argument("--parent-manifest")
    request.add_argument("--source-manifest", required=True)
    request.add_argument("--output-root", required=True)
    request.add_argument("--evidence-root", required=True)
    request.add_argument("--out", required=True)
    copy_parser = sub.add_parser("source-copy")
    copy_parser.add_argument("--source", required=True)
    copy_parser.add_argument("--out", required=True)
    copy_parser.add_argument("--mutant", choices=sorted(MUTANT_SOURCES))
    index = sub.add_parser("index")
    index.add_argument("--run-dir", required=True)
    index.add_argument("--segment", required=True)
    index.add_argument("--expected-test", action="append", required=True)
    index.add_argument("--declared", action="append", default=[])
    compare = sub.add_parser("compare")
    compare.add_argument("--resumed", required=True)
    compare.add_argument("--fresh", required=True)
    args = parser.parse_args(argv)

    def write_new(path, value):
        with open(path, "xb") as out:
            out.write(canonical(value) + b"\n")
        print(json.dumps({"written": str(path), "sha256": sha256(Path(path).read_bytes())}))

    if args.command == "registry":
        write_new(args.out, registry_valid(list(DEFAULT_PROOF_LEAVES)))
    elif args.command == "plan":
        write_new(args.out, leaf_plan(json.loads(Path(args.registry).read_bytes()), args.unit))
    elif args.command == "request":
        leaves = registry_valid(json.loads(Path(args.registry).read_bytes()))
        leaf = next(item for item in leaves if item["unit"] == args.unit)

        def reference(path):
            return None if path in (None, "none") else {"path": str(Path(path).resolve()), "sha256": sha256(Path(path).read_bytes())}
        write_new(args.out, {"schema": SCHEMA, "unit": leaf["unit"], "case": leaf["case"], "scenario": leaf["scenario"],
                             "stage": leaf["stage"], "execution_kind": leaf["execution_kind"],
                             "parent_manifest": reference(args.parent_manifest), "source_manifest": reference(args.source_manifest),
                             "output_root": str(Path(args.output_root).resolve()), "evidence_root": str(Path(args.evidence_root).resolve())})
    elif args.command == "source-copy":
        path = source_copy(Path(args.source).resolve(), Path(args.out).resolve(), args.mutant)
        print(json.dumps({"source_manifest": str(path), "sha256": sha256(path.read_bytes())}))
    elif args.command == "index":
        result = evidence_index(args.run_dir, segment_path=args.segment, expected_tests=args.expected_test,
                                declared_inputs=args.declared)
        print(json.dumps(result, indent=2))
        return 0 if result["verdict"] == "BOUND" else 1
    elif args.command == "compare":
        result = compare_forward_verdicts(verdict_from_log(args.resumed), verdict_from_log(args.fresh))
        print(json.dumps(result, indent=2))
        return 0 if result["equal"] else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
