#!/usr/bin/env python3
"""Isolated synthetic rehearsal harness for the Stage-2 option-B runner (HB1-HB9 / I1-I8).

Runs ONLY inside the approved isolated GitHub-hosted job. It drives the REAL functions of
rollout.py against a synthetic nginx/postgres stack. No product image, no clinical data, no
credential, no main server, no database dump, and no contact with the production origin.

Corrections in this pass:
  HB1 S1 requires exit 0 for every step AND positive proof of execution: api/orthanc exist
      (created from the BASELINE file) before the sequence, are not running after `stop`, and
      carry NEW container Ids after `up`, while the proxy is byte-identical throughout.
  HB2 S6 calls the real rollout.apply_migration() and requires the EXACT injected exit; the
      refusal comes from run(), not from the harness; container Ids are observed unchanged and
      the argv log must contain no `up` and no `checkout`.
  HB3 S7 injects the unreachable endpoint where the child actually sees it (ENV_BASE), and
      carries an in-scenario positive control.
  HB4 One project identity for the whole job (PROJECT_DIR) plus harness-owned cleanup of the
      synthetic containers and network at every scenario start. Cleanup is issued by the
      HARNESS, never through rollout, and touches only these synthetic names.
  HB5 S3 observes argv instead of asserting a literal, covers BOTH network-present variants, and
      is named for what it is: a guard-function test against a real daemon.
  HB8 S5 polls pg_isready over TCP with a sleep, and uses a project .env so the compose files
      interpolate under the runner's stripped child environment.
  HB9 the baseline file creates api, orthanc AND proxy, so `--force-recreate` acts on
      baseline-created containers, which is the production shape.

Usage: python3 rehearsal_harness.py --scenario <name> --out <receipt.json>
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

HERE = pathlib.Path(__file__).resolve().parent
BUNDLE = HERE.parent
BASELINE_COMPOSE = "baseline-compose.yml"
TARGET_COMPOSE = "target-compose.yml"
NETWORK = "kin-workflow"
PROXY, API, ORTHANC = "kin-proxy", "kin-api", "kin-orthanc"
SYNTHETIC_CONTAINERS = (PROXY, API, ORTHANC, "kin-db")


def load_rollout():
    spec = importlib.util.spec_from_file_location("rollout_rehearsal", BUNDLE / "rollout.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["rollout_rehearsal"] = module
    spec.loader.exec_module(module)
    return module


rollout = load_rollout()
MANIFEST = json.loads((BUNDLE / "manifest-stage2.json").read_text(encoding="utf-8"))


def raw(args, check=False, timeout=900, cwd=None, env=None):
    result = subprocess.run(args, cwd=None if cwd is None else str(cwd), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env)
    record = {"argv": args, "exit": result.returncode,
              "stdout": result.stdout.decode("utf-8", "replace")[-4000:],
              "stderr": result.stderr.decode("utf-8", "replace")[-4000:]}
    if check and result.returncode != 0:
        raise SystemExit("rehearsal command failed: " + json.dumps(record)[:1500])
    return record


def versions():
    """I8: every conclusion is bound to these three, kept in the receipt."""
    return {"docker": raw(["docker", "version", "--format", "{{.Server.Version}}"])["stdout"].strip(),
            "docker_compose": raw(["docker", "compose", "version"])["stdout"].strip(),
            "python3": raw([sys.executable, "--version"])["stdout"].strip()}


# ---------------------------------------------------------------- HB4: one project, own cleanup

def project_dir():
    root = pathlib.Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "kin-rehearsal"
    root.mkdir(parents=True, exist_ok=True)
    (root / "config").mkdir(exist_ok=True)
    (root / "worklist-v0").mkdir(exist_ok=True)
    (root / "kin-workflow-nginx").mkdir(exist_ok=True)  # an EMPTY mount source; no route file
    for name in (BASELINE_COMPOSE, TARGET_COMPOSE):
        shutil.copyfile(HERE / name, root / name)
    # HB8: child_env() strips the job's variables, so the image reference must come from a
    # project .env file that Compose itself reads.
    (root / ".env").write_text("REHEARSAL_IMAGE=" + os.environ["REHEARSAL_IMAGE"] + "\n", encoding="utf-8")
    (root / "config" / "ohif.js").write_bytes(b"// synthetic viewer config\n")
    (root / "worklist-v0" / "index.html").write_bytes(b"<!doctype html>\n")
    return root


def cleanup(root):
    """HB4: harness-owned, confined to the synthetic names this job creates. Never via rollout."""
    log = [raw(["docker", "rm", "-f", *SYNTHETIC_CONTAINERS])]
    log.append(raw(["docker", "network", "rm", NETWORK]))
    return {"note": "issued by the harness only, on synthetic resources of this throwaway runner",
            "commands": log}


def compose_argv(root, compose_file, *verb):
    """The shape under test is the runner's own argv, not a re-typed copy."""
    previous = rollout.COMPOSE_FILES
    rollout.COMPOSE_FILES = (compose_file,)
    try:
        return rollout.compose(root) + list(verb)
    finally:
        rollout.COMPOSE_FILES = previous


class ArgvLog:
    """HB2/HB5/HB2-R: observe every command the RUNNER issues on ITS OWN channel.

    Each entry keeps the argv, the returncode and a stderr tail, so a claim about an exit code
    is about the call the runner actually made, never about a second command issued elsewhere
    under a different environment.
    """

    def __init__(self):
        self.calls = []
        self.entries = []
        self._previous = None

    def __enter__(self):
        self._previous = rollout._EXECUTE
        outer = self

        def spy(args, **kwargs):
            argv = list(args)
            outer.calls.append(argv)
            result = outer._previous(args, **kwargs)
            stderr = getattr(result, "stderr", b"") or b""
            outer.entries.append({"argv": argv, "returncode": getattr(result, "returncode", None),
                                  "stderr": stderr.decode("utf-8", "replace")[-600:]
                                  if isinstance(stderr, (bytes, bytearray)) else str(stderr)[-600:]})
            return result

        rollout._EXECUTE = spy
        return self

    def __exit__(self, *_a):
        rollout._EXECUTE = self._previous
        return False

    def contains(self, token):
        return any(token in call for call in self.calls)

    def network_commands(self):
        return [call for call in self.calls if len(call) > 1 and call[0] == "docker" and call[1] == "network"]

    def find(self, *tokens):
        """The runner's own entries whose argv contains every token."""
        return [entry for entry in self.entries if all(token in entry["argv"] for token in tokens)]


def container_facts(name):
    found = raw(["docker", "inspect", name])
    if found["exit"] != 0:
        return {"exists": False, "raw_stderr": found["stderr"][-400:]}
    body = json.loads(found["stdout"])[0]
    return {"exists": True, "Id": body.get("Id"), "running": (body.get("State") or {}).get("Running"),
            "StartedAt": (body.get("State") or {}).get("StartedAt"),
            "networks": sorted((body.get("NetworkSettings") or {}).get("Networks") or {}),
            "mounts": sorted(m.get("Destination") for m in body.get("Mounts") or [] if m.get("Destination"))}


def proxy_identity():
    facts = container_facts(PROXY)
    return {k: facts.get(k) for k in ("exists", "Id", "StartedAt", "networks", "mounts")}


def network_state():
    """I8: keep the raw stderr of the inspect; it is the H1 wording evidence."""
    probe = raw(["docker", "inspect", "--type", "network", NETWORK])
    try:
        return {"absent": rollout.network_absent(NETWORK), "indeterminate": False,
                "raw_exit": probe["exit"], "raw_stderr": probe["stderr"][-400:]}
    except rollout.Refuse as error:
        return {"absent": None, "indeterminate": True, "refusal": str(error)[:300],
                "raw_exit": probe["exit"], "raw_stderr": probe["stderr"][-400:]}


def start_baseline_stack(root):
    """HB9: api, orthanc AND proxy are created from the BASELINE-shaped file, as production is."""
    raw(["docker", "pull", os.environ["REHEARSAL_IMAGE"]], check=True)
    return raw(compose_argv(root, BASELINE_COMPOSE, "up", "-d", "--force-recreate",
                            "api", "orthanc", "proxy"), check=True, cwd=root)


# ---------------------------------------------------------------- S1 (HB1, HB9, I3)
def scenario_compose_network():
    root = project_dir()
    cleaned = cleanup(root)
    baseline_up = start_baseline_stack(root)
    before = {"proxy": proxy_identity(), "api": container_facts(API), "orthanc": container_facts(ORTHANC),
              "network": network_state()}
    steps, problems = [], []
    if not (before["api"].get("exists") and before["orthanc"].get("exists") and before["proxy"].get("exists")):
        problems.append("baseline stack was not created")

    with ArgvLog() as log:
        sequence = [
            ("stop", compose_argv(root, TARGET_COMPOSE, "stop", "api", "orthanc")),
            ("migrate-shape", compose_argv(root, TARGET_COMPOSE, "run", "--rm", "--no-deps",
                                           "--entrypoint", "sh", "api", "-c", "true")),
            ("up", compose_argv(root, TARGET_COMPOSE, "up", "-d", "--no-deps", "--no-build",
                                "--pull", "never", "--force-recreate", "api", "orthanc")),
        ]
        for label, argv in sequence:
            executed = raw(argv, cwd=root)
            observed = {"proxy": proxy_identity(), "api": container_facts(API),
                        "orthanc": container_facts(ORTHANC), "network": network_state()}
            # HB1: the exit code is now part of the verdict, not decoration.
            if executed["exit"] != 0:
                problems.append(label + ": exit " + str(executed["exit"]))
            if observed["proxy"] != before["proxy"]:
                problems.append(label + ": proxy identity changed")
            if observed["network"].get("absent") is not True:
                problems.append(label + ": kin-workflow is not absent by the typed rule")
            # HB1: positive proof that the command did something.
            if label == "stop" and (observed["api"].get("running") is not False
                                    or observed["orthanc"].get("running") is not False):
                problems.append("stop: api/orthanc are still running")
            if label == "up" and (observed["api"].get("Id") == before["api"].get("Id")
                                  or observed["orthanc"].get("Id") == before["orthanc"].get("Id")):
                problems.append("up: container Id did not change, so nothing was recreated")
            if label == "up" and (observed["api"].get("running") is not True
                                  or observed["orthanc"].get("running") is not True):
                problems.append("up: api/orthanc are not running")
            steps.append({"step": label, "command": executed, "observed": observed})
        runner_network_commands = log.network_commands()
    if runner_network_commands:
        problems.append("the runner issued a docker network command")
    route_dir = pathlib.Path("/etc/kin-workflow").exists()
    if route_dir:
        problems.append("/etc/kin-workflow exists on the runner")
    return {"scenario": "compose-network", "versions": versions(), "cleanup": cleaned,
            "baseline_up": baseline_up, "before": before, "steps": steps,
            "runner_network_commands": runner_network_commands,
            "host_route_directory_exists": route_dir, "problems": problems,
            "expected": "every step exits 0; after stop api/orthanc are down; after up they have NEW "
                        "container Ids and run; the proxy is identical and kin-workflow stays absent",
            "passed": not problems}


# ---------------------------------------------------------------- S2
def scenario_guard_clean():
    root = project_dir()
    cleaned = cleanup(root)
    start_baseline_stack(root)
    guard = rollout.proxy_guard()
    try:
        rollout.require_proxy_inert("rehearsal-clean")
        refused = None
    except rollout.Refuse as error:
        refused = str(error)[:300]
    return {"scenario": "guard-clean", "cleanup": cleaned, "guard": guard, "refusal": refused,
            "network": network_state(),
            "expected": "a proxy created from the BASELINE-shaped file is inert and the guard returns",
            "passed": guard["inert"] is True and refused is None}


# ---------------------------------------------------------------- S3 (HB5, I6)
def scenario_guard_function_against_daemon():
    """HB5: a guard-FUNCTION test against a real daemon, in both network-present variants."""
    root = project_dir()
    cleaned = cleanup(root)
    start_baseline_stack(root)
    record = pathlib.Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / ("record-s3-" + uuid.uuid4().hex[:8] + ".json")
    variants, problems = [], []

    for variant in ("network-only", "network-and-joined"):
        state = {"schema": rollout.SCHEMA, "status": "MIGRATED_ROWS_PRESERVED",
                 "target": MANIFEST["target_sha"], "baseline": MANIFEST["baseline_sha"]}
        record.write_text(json.dumps(state), encoding="utf-8")
        created = raw(["docker", "network", "create", "--internal", NETWORK])
        joined = None
        if variant == "network-and-joined":
            joined = raw(["docker", "network", "connect", NETWORK, PROXY], check=True)
        with ArgvLog() as log:
            try:
                rollout.guard_or_needs_attention(record, state, "proxy_guard_post_apply", "post-apply")
                refusal = None
            except rollout.Refuse as error:
                refusal = str(error)
            runner_network_commands = log.network_commands()
        on_disk = json.loads(record.read_text(encoding="utf-8"))
        ok = (bool(refusal) and on_disk.get("status") == "NEEDS_ATTENTION_LOCK_RETAINED"
              and on_disk.get("manual_next_action") == rollout.GUARD_NEXT_ACTION
              and on_disk.get("proxy_guard_post_apply") is not None
              and on_disk.get("guard_tripped_this_invocation") is True
              and not runner_network_commands)
        if not ok:
            problems.append(variant)
        variants.append({"variant": variant, "network_create": created, "network_connect": joined,
                         "refusal": (refusal or "")[:300], "record": on_disk,
                         "runner_network_commands": runner_network_commands, "ok": ok})
        # Reset between variants; harness-owned, synthetic only.
        raw(["docker", "network", "disconnect", NETWORK, PROXY])
        raw(["docker", "network", "rm", NETWORK])

    return {"scenario": "guard-function-against-daemon", "cleanup": cleaned, "variants": variants,
            "problems": problems,
            "expected": "both an unreferenced network and a joined proxy trip the guard, record "
                        "NEEDS_ATTENTION with the network manual action, and the runner issues no "
                        "network command (observed argv, not a literal)",
            "passed": not problems}


# ---------------------------------------------------------------- S4
def scenario_pin_drift():
    repo = os.environ.get("REHEARSAL_REPO")
    if not repo:
        return {"scenario": "pin-drift", "passed": False, "reason": "REHEARSAL_REPO is not set"}
    try:
        rollout.rederive(pathlib.Path(repo), json.loads(json.dumps(MANIFEST)))
        control = "passed"
    except rollout.Refuse as error:
        control = "refused: " + str(error)[:300]
    mutated = json.loads(json.dumps(MANIFEST))
    mutated["drift_pins"]["docker-compose.prod.yml"]["target"] = "0" * 40
    out = pathlib.Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "mutated-manifest.json"
    out.write_text(json.dumps(mutated), encoding="utf-8")
    try:
        rollout.rederive(pathlib.Path(repo), mutated)
        refusal = None
    except rollout.Refuse as error:
        refusal = str(error)
    return {"scenario": "pin-drift", "positive_control": control, "mutated_manifest": str(out),
            "refusal": (refusal or "")[:300],
            "expected": "the unmutated manifest passes rederive on this checkout and the mutated one refuses",
            "passed": control == "passed" and "Drift path differs from the pin" in (refusal or "")}


# ---------------------------------------------------------------- S5 (HB8)
def scenario_findings_rollback():
    root = project_dir()
    cleaned = cleanup(root)
    start_baseline_stack(root)
    image = os.environ["REHEARSAL_POSTGRES"]
    raw(["docker", "pull", image], check=True)
    raw(["docker", "run", "-d", "--name", "kin-db", "-e", "POSTGRES_USER=kin",
         "-e", "POSTGRES_PASSWORD=synthetic-rehearsal-only", "-e", "POSTGRES_DB=kin", image], check=True)
    # HB8: TCP probe with a sleep, so the init-phase socket cannot be mistaken for readiness.
    ready, attempts = None, 0
    for attempts in range(1, 61):
        ready = raw(["docker", "exec", "kin-db", "pg_isready", "-h", "127.0.0.1", "-U", "kin"])
        if ready["exit"] == 0:
            break
        time.sleep(2)
    seed = ('CREATE TABLE "Finding"(id int primary key); '
            'CREATE TABLE "FindingRevision"(id int primary key); '
            'CREATE TABLE "HangingProtocolPreference"(id int primary key); '
            'INSERT INTO "Finding" VALUES (1),(2),(3); '
            'INSERT INTO "FindingRevision" VALUES (1),(2),(3),(4); '
            'INSERT INTO "HangingProtocolPreference" VALUES (1),(2);')
    seeded = raw(["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", "kin",
                  "-v", "ON_ERROR_STOP=1", "-qAt", "-c", seed], check=True)

    compat = rollout.rollback_compatibility(MANIFEST)
    record = pathlib.Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / ("record-s5-" + uuid.uuid4().hex[:8] + ".json")
    token = uuid.uuid4().hex
    (root / ".kin-ops.lock").write_text(token, encoding="utf-8")
    manifest_path = root / "manifest.json"
    shutil.copyfile(BUNDLE / "manifest-stage2.json", manifest_path)
    manifest, _sha = rollout.load_manifest(str(manifest_path))
    record.write_text(json.dumps({"schema": rollout.SCHEMA, "token": token,
                                  "status": "APPLIED_PENDING_AUTHENTICATED_CHECKS",
                                  "target": manifest["target_sha"], "baseline": manifest["baseline_sha"],
                                  "manifest_sha256": manifest["_self_sha256"],
                                  "previous_image": "sha256:synthetic"}), encoding="utf-8")

    class Args:
        pass

    args = Args()
    args.manifest, args.repo, args.record = str(manifest_path), str(root), str(record)
    args.compose_image_tag = "rehearsal-api:latest"
    args.acknowledge_incompatible_jobs = False
    args.acknowledge_finding_inaccessibility = False
    args.acknowledge_rewritten_tables = ()
    args.static = "changed"
    with ArgvLog() as log:
        try:
            rollout.mode_rollback(args)
            refusal = None
        except rollout.Refuse as error:
            refusal = str(error)
        stopped = log.contains("stop")
    on_disk = json.loads(record.read_text(encoding="utf-8"))
    ack = on_disk.get("finding_inaccessibility") or {}
    problems = []
    if not refusal:
        problems.append("the rollback was not refused")
    if ack.get("Finding") != 3 or ack.get("FindingRevision") != 4 or ack.get("state") != "missing":
        problems.append("the record does not carry the refusal counts")
    if "3 Finding rows and 4 FindingRevision rows" not in ack.get("text", ""):
        problems.append("the verbatim sentence does not name N and M")
    if compat["hanging_protocol"]["blocking"] is not False or compat["hanging_protocol"]["rows"] != 2:
        problems.append("preference rows were treated as blocking")
    if not (root / ".kin-ops.lock").exists():
        problems.append("the lock was released")
    if stopped:
        problems.append("writers were stopped despite the refusal")
    return {"scenario": "findings-rollback", "cleanup": cleaned, "compatibility": compat,
            "db_ready": {"exit": (ready or {}).get("exit"), "attempts": attempts}, "seeded": seeded,
            "refusal": (refusal or "")[:500], "record_finding_inaccessibility": ack,
            "problems": problems,
            "expected": "refusal naming 3 and 4 before anything is stopped; the record already carries "
                        "the counts and the sentence; 2 preference rows do not block; the lock is kept",
            "passed": not problems}


# ---------------------------------------------------------------- S6 (HB2, I5)
def scenario_partial_failure():
    """The real run() path with apply_migration's argv shape, failing with a deliberate exit 7.

    HB2-R, accurately labelled (Astra option ii):
      * Real code exercised: rollout.compose(), check_command(), spawn()/child_env(), run() and
        fail(). The BODY of apply_migration is NOT executed, and mode_apply is NOT driven.
      * The exit code is required on the RUNNER'S OWN call, observed through the spy's
        returncode, because that call is the only one made under child_env(). The separate raw()
        command is kept as a secondary control, never as the verdict.
      * The record assertion is about fail(), which the harness itself invokes; it is not
        evidence that mode_apply would write the same record.
    """
    root = project_dir()
    cleaned = cleanup(root)
    start_baseline_stack(root)
    before = {"api": container_facts(API), "orthanc": container_facts(ORTHANC)}
    record = pathlib.Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / ("record-s6-" + uuid.uuid4().hex[:8] + ".json")
    token = uuid.uuid4().hex
    (root / ".kin-ops.lock").write_text(token, encoding="utf-8")
    state = {"schema": rollout.SCHEMA, "token": token, "status": "WRITERS_STOPPED",
             "target": MANIFEST["target_sha"], "baseline": MANIFEST["baseline_sha"]}
    record.write_text(json.dumps(state), encoding="utf-8")

    # The injected failure: the real apply_migration argv with a command that exits exactly 7.
    previous_files, previous_migrate = rollout.COMPOSE_FILES, rollout.apply_migration
    rollout.COMPOSE_FILES = (TARGET_COMPOSE,)
    expected_exit, observed_exit = 7, None
    try:
        def injected(repo):
            return rollout.run(rollout.compose(repo) + ["run", "--rm", "--no-deps", "--entrypoint",
                                                        "sh", "api", "-c", "exit 7"],
                               cwd=repo, timeout=300)
        rollout.apply_migration = injected
        with ArgvLog() as log:
            try:
                rollout.apply_migration(root)
                error = None
            except rollout.Refuse as err:
                error = err
                rollout.fail(record, state, err, "apply",
                             "Inspect the record and the lock. The backup is intact and untouched.")
            argv_log = list(log.calls)
            # HB2-R: the verdict comes from the runner's OWN call, under child_env().
            runner_entries = log.find("run", "--entrypoint")
    finally:
        rollout.COMPOSE_FILES, rollout.apply_migration = previous_files, previous_migrate

    runner_exit = runner_entries[-1]["returncode"] if runner_entries else None
    runner_stderr = runner_entries[-1]["stderr"] if runner_entries else ""
    # Secondary observation only: the same command outside the runner's environment.
    control = raw(compose_argv(root, TARGET_COMPOSE, "run", "--rm", "--no-deps", "--entrypoint",
                               "sh", "api", "-c", "exit 7"), cwd=root)
    observed_exit = control["exit"]
    after = {"api": container_facts(API), "orthanc": container_facts(ORTHANC)}
    on_disk = json.loads(record.read_text(encoding="utf-8"))
    problems = []
    if error is None:
        problems.append("run() did not raise on the failing migrate")
    if not runner_entries:
        problems.append("the runner issued no compose run call")
    if runner_exit != expected_exit:
        problems.append("the runner's own call exited " + str(runner_exit) + ", not " + str(expected_exit))
    if observed_exit != expected_exit:
        problems.append("the control command exited " + str(observed_exit) + ", not " + str(expected_exit))
    if on_disk.get("status") != "NEEDS_ATTENTION_LOCK_RETAINED" or on_disk.get("failed_action") != "apply":
        problems.append("the record is not NEEDS_ATTENTION/apply")
    if not (root / ".kin-ops.lock").exists():
        problems.append("the lock was released")
    if before["api"].get("Id") != after["api"].get("Id") or before["orthanc"].get("Id") != after["orthanc"].get("Id"):
        problems.append("container identity changed during the failure")
    if any("up" in call for call in argv_log) or any("checkout" in call for call in argv_log):
        problems.append("an up or checkout argv was issued")
    return {"scenario": "partial-failure", "cleanup": cleaned, "expected_exit": expected_exit,
            "runner_exit": runner_exit, "runner_stderr": runner_stderr,
            "control_exit": observed_exit, "observed_exit": runner_exit,
            "exercises": ["rollout.compose", "check_command", "spawn/child_env", "run", "fail"],
            "does_not_exercise": ["the body of apply_migration", "mode_apply"],
            "record_assertion_scope": "fail() only: the harness invoked fail(), so the record proves "
                                      "fail()'s behaviour, not what mode_apply would write",
            "refusal": (str(error) if error else "")[:400],
            "argv_log": argv_log, "before": before, "after": after, "record": on_disk,
            "problems": problems,
            "expected": "the runner's OWN compose run call (under child_env) exits exactly 7 and run() "
                        "raises; the record written by fail() is "
                        "NEEDS_ATTENTION/apply with the lock kept; no up or checkout is issued and the "
                        "api/orthanc container Ids are unchanged",
            "passed": not problems}


# ---------------------------------------------------------------- S7 (HB3, I4)
def scenario_indeterminate_control():
    """HB3: the endpoint is injected into the CHILD environment, with a positive control."""
    positive = network_state()
    previous = dict(rollout.ENV_BASE)
    rollout.ENV_BASE["DOCKER_HOST"] = "tcp://127.0.0.1:1"
    try:
        injected = network_state()
    finally:
        rollout.ENV_BASE.clear()
        rollout.ENV_BASE.update(previous)
    restored = network_state()
    problems = []
    if positive.get("absent") is not True or positive.get("indeterminate"):
        problems.append("the positive control did not report absent")
    if injected.get("indeterminate") is not True or injected.get("absent") is not None:
        problems.append("an unreachable daemon was not reported as indeterminate")
    if restored.get("absent") is not True:
        problems.append("the environment was not restored")
    return {"scenario": "indeterminate-control", "positive_control": positive, "injected": injected,
            "restored": restored, "problems": problems,
            "expected": "a reachable daemon answers absent; the injected unreachable endpoint is "
                        "indeterminate, never absent; the environment is restored afterwards",
            "passed": not problems}


SCENARIOS = {
    "compose-network": scenario_compose_network,
    "guard-clean": scenario_guard_clean,
    "guard-function-against-daemon": scenario_guard_function_against_daemon,
    "pin-drift": scenario_pin_drift,
    "findings-rollback": scenario_findings_rollback,
    "partial-failure": scenario_partial_failure,
    "indeterminate-control": scenario_indeterminate_control,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", required=True, choices=sorted(SCENARIOS))
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = pathlib.Path(args.out)
    if out.exists():
        raise SystemExit("refusing to overwrite " + str(out))
    try:
        receipt = SCENARIOS[args.scenario]()
    except SystemExit as error:
        # I8: a setup failure still produces a receipt, so one dispatch never loses the evidence.
        receipt = {"scenario": args.scenario, "passed": False, "setup_error": str(error)[:1500]}
    receipt["isolated"] = True
    receipt["clinical_fixtures"] = False
    receipt["product_image"] = False
    out.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"scenario": receipt["scenario"], "passed": receipt["passed"], "out": str(out)}))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
