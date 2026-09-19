#!/usr/bin/env python3
"""Mode-level behavioural regressions for B1-B3 and the I1-I6 ingress correction.

These drive the real `mode_apply`, `mode_rollback` and `mode_verify` entry points with a mocked
`_EXECUTE`, a temporary repository and a temporary durable record, and then assert on the RECORD
FILE ON DISK at the exact boundaries the reviews named: at the `compose stop` call, before the
checkout, and at the terminal decision. Nothing is asserted by searching the source text.

Each case first reproduces the OLD failure (the assertion is written so it would fail against
the pre-fix code) and then proves the corrected behaviour.

Pure: no Docker daemon, database, network, server, credential or container. Every child process
is the mock. Run: python3 selftest_rollout_modes.py
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import uuid

HERE = pathlib.Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rollout = load("rollout_modes", "rollout.py")
MANIFEST = json.loads((HERE / "manifest-stage2.json").read_text(encoding="utf-8"))
FAILURES = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + ((" :: " + detail) if detail and not condition else ""))
    if not condition:
        FAILURES.append(name)


class Result:
    def __init__(self, returncode=0, stdout=b"", stderr=b""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


# The ingress the production host actually carries (2026-09-19 read-only observation and
# docker-compose.prod.yml:23). Every fixture here is built from this tuple rather than from the
# host SOURCE path the old fixtures injected as a Destination.
LIVE_ROUTE = {"Type": "bind", "Source": "/etc/kin-workflow/nginx", "Destination": "/etc/nginx/workflow",
              "Mode": "ro", "RW": False, "Propagation": "rprivate"}
LETSENCRYPT = {"Type": "bind", "Source": "/etc/letsencrypt", "Destination": "/etc/letsencrypt",
               "Mode": "ro", "RW": False, "Propagation": "rprivate"}
LIVE_NETWORK = {"Id": "d90d5f6b997729698edb62cf4493f1b5b0410443d84d7299402f1dfd1dc86776",
                "Name": "kin-workflow", "Internal": True,
                "Containers": {"a1": {"Name": "kin-proxy", "EndpointID": "e1"},
                               "b2": {"Name": "kin-workflow-receiver", "EndpointID": "e2"}}}
PRESENT = {"proxy_id": "proxy-1", "started": "2026-09-17T09:00:00Z",
           "networks": ["kin-workflow", "pacs-starter-kit_default"],
           "mounts": [LETSENCRYPT, LIVE_ROUTE], "network": LIVE_NETWORK}
# The same host after someone recreated the proxy: the rollout must notice and must not repair it.
PROXY_RECREATED = dict(PRESENT, proxy_id="proxy-2", started="2026-09-19T21:00:00Z")
# The same host after the workflow network was removed under us.
NETWORK_REMOVED = dict(PRESENT, networks=["pacs-starter-kit_default"], mounts=[LETSENCRYPT], network=None)
# Only the independently managed receiver moved: a different member set and endpoint, nothing else.
RECEIVER_ROTATED = dict(PRESENT, network=dict(
    LIVE_NETWORK, Containers={"a1": {"Name": "kin-proxy", "EndpointID": "e1"},
                              "z9": {"Name": "kin-workflow-receiver", "EndpointID": "ROTATED"}}))


def ingress_of(spec):
    """The observation a record must carry as its baseline for `spec` to compare equal."""
    proxy = {"container": "kin-proxy", "readable": True, "id": spec["proxy_id"],
             "image": "sha256:proxyimage", "running": True, "started_at": spec["started"],
             "networks": sorted(spec["networks"]),
             "mounts": rollout.mount_records(spec["mounts"])}
    network = ({"name": "kin-workflow", "state": "absent"} if spec["network"] is None else
               {"name": "kin-workflow", "state": "present", "id": spec["network"]["Id"],
                "internal": spec["network"]["Internal"],
                "member_names": sorted(entry["Name"] for entry in spec["network"]["Containers"].values())})
    shape, problems = rollout.ingress_shape(proxy, network)
    return {"schema": rollout.INGRESS_SCHEMA, "observed_utc": "2026-09-19T00:00:00+00:00",
            "proxy": proxy, "network": network, "shape": shape, "shape_problems": problems}


class Host:
    """A tiny synthetic host: answers the exact commands the modes issue, and records them.

    `snapshots` captures the durable record as it exists on disk at named boundaries, which is
    the only way to test B1's 'recorded before the rollback proceeds'.

    `ingress` is the live ingress before `compose stop`, `ingress_after` the one after it, so a
    case can move the proxy, the network or only the receiver at that boundary.
    """

    def __init__(self, record_path, findings=(0, 0), findings_after=None, hanging_rows=0,
                 ingress=None, ingress_after=None, nginx_ok=True):
        self.record_path = record_path
        self.calls = []
        self.snapshots = {}
        self.findings = findings
        self.findings_after = findings if findings_after is None else findings_after
        self.hanging_rows = hanging_rows
        self.ingress = dict(PRESENT if ingress is None else ingress)
        self.ingress_after = self.ingress if ingress_after is None else dict(ingress_after)
        self.nginx_ok = nginx_ok
        self.quiesced = False
        # The image compose would start api from: whatever was last tagged as the compose tag.
        self.api_image = "sha256:previous"
        self.next_image = "sha256:previous"

    def snapshot(self, label):
        try:
            self.snapshots[label] = json.loads(pathlib.Path(self.record_path).read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.snapshots[label] = None

    def live(self):
        return self.ingress_after if self.quiesced else self.ingress

    def __call__(self, args, **kwargs):
        self.calls.append(list(args))
        spec = self.live()
        if args[0] == "git":
            if "checkout" in args:
                # NB5/m3: snapshot the record exactly at the checkout boundary.
                self.snapshot("at_checkout")
            if "rev-parse" in args and "HEAD" in args:
                return Result(0, MANIFEST["baseline_sha"].encode())
            return Result(0, b"")
        if args[:2] == ["docker", "inspect"] and "--type" in args and "network" in args:
            if spec["network"] is None:
                return Result(1, b"", b"Error: No such network: kin-workflow")
            return Result(0, json.dumps([spec["network"]]).encode())
        if args[:3] == ["docker", "image", "inspect"]:
            return Result(0, json.dumps([{"Id": "sha256:candidate"}]).encode())
        if args[:2] == ["docker", "inspect"] and "--format" in args:
            if "{{.State.Running}}" in args:
                return Result(0, b"false")
            if "{{.Image}}" in args:
                return Result(0, self.api_image.encode())
            return Result(0, b"2026-09-18T12:00:00Z")
        if args[:2] == ["docker", "inspect"] and args[-1] == "kin-proxy":
            return Result(0, json.dumps([{
                "Id": spec["proxy_id"], "Image": "sha256:proxyimage",
                "State": {"Running": True, "StartedAt": spec["started"]},
                "NetworkSettings": {"Networks": {n: {} for n in spec["networks"]}},
                "Mounts": list(spec["mounts"])}]).encode())
        if args[:2] == ["docker", "inspect"]:
            return Result(0, json.dumps([{"Id": "other", "State": {"Running": True}}]).encode())
        if "psql" in args:
            query = args[-1]
            if "to_regclass" in query:
                return Result(0, b"t")
            if '"Finding"' in query and "count(*)" in query:
                return Result(0, str((self.findings_after if self.quiesced else self.findings)[0]).encode())
            if '"FindingRevision"' in query and "count(*)" in query:
                return Result(0, str((self.findings_after if self.quiesced else self.findings)[1]).encode())
            if "HangingProtocolPreference" in query:
                return Result(0, str(self.hanging_rows).encode())
            if "ViewerJob" in query:
                return Result(0, b'{"6": 3}')
            return Result(0, b"0")
        if "nginx" in args:
            return Result(0 if self.nginx_ok else 1, b"", b"nginx: configuration file test failed")
        if args[:2] == ["docker", "compose"] and "stop" in args:
            self.snapshot("at_stop")
            self.quiesced = True
            return Result(0, b"")
        if args[:2] == ["docker", "compose"] and "up" in args:
            self.api_image = self.next_image
            return Result(0, b"")
        if args[:2] == ["docker", "tag"]:
            if args[3] == "pacs-starter-kit-api:latest":
                self.next_image = args[2]
            return Result(0, b"")
        if args[0] == "docker" and args[1] == "exec":
            return Result(0, b"")
        return Result(0, b"")


def scaffold(tmp, status="APPLIED_PENDING_AUTHENTICATED_CHECKS", extra=None, baseline=PRESENT,
             with_record=True, with_lock=True):
    repo = pathlib.Path(tmp) / "repo"
    (repo / "config").mkdir(parents=True)
    shutil.copyfile(HERE / "manifest-stage2.json", repo / "manifest-copy.json")
    token = uuid.uuid4().hex
    if with_lock:
        (repo / ".kin-ops.lock").write_text(token, encoding="utf-8")
    manifest_path = pathlib.Path(tmp) / "manifest.json"
    shutil.copyfile(HERE / "manifest-stage2.json", manifest_path)
    manifest, _sha = rollout.load_manifest(str(manifest_path))
    record = pathlib.Path(tmp) / "record.json"
    state = {"schema": rollout.SCHEMA, "token": token, "status": status,
             "target": manifest["target_sha"], "baseline": manifest["baseline_sha"],
             "manifest_sha256": manifest["_self_sha256"], "previous_image": "sha256:previous",
             "candidate_image": "sha256:candidate", "started_utc": rollout.stamp()}
    if baseline is not None:
        state["ingress_baseline"] = ingress_of(baseline)
    state.update(extra or {})
    if with_record:
        record.write_text(json.dumps(state), encoding="utf-8")
    return repo, manifest_path, record


class Args:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeResponse:
    """Minimal object satisfying wait_health's context-manager + json.load usage."""

    def __init__(self, payload=b'{"ok": true, "auth": true}', status=200):
        self._payload, self.status = payload, status

    def read(self, *_a):
        return self._payload

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def fake_urlopen(url, timeout=None):
    """Health answers 200/ok; the unauthenticated probe answers 401 as the runner requires."""
    if "/api/health" in url:
        return FakeResponse()
    if "/api/studies" in url:
        raise rollout.urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)
    return FakeResponse(b"")


def run_mode(mode, host, manifest_path, repo, record, stubs=None, **kw):
    """`stubs` replaces functions that are NOT under test here (served-asset comparison, row
    comparison), so the mode can reach the boundary the case is about."""
    previous, rollout._EXECUTE = rollout._EXECUTE, host
    previous_fetch, rollout._URLOPEN = rollout._URLOPEN, fake_urlopen
    saved_stubs = {name: getattr(rollout, name) for name in (stubs or {})}
    for name, value in (stubs or {}).items():
        setattr(rollout, name, value)
    try:
        fields = {"manifest": str(manifest_path), "repo": str(repo), "record": str(record),
                  "compose_image_tag": "pacs-starter-kit-api:latest",
                  "acknowledge_incompatible_jobs": False, "acknowledge_finding_inaccessibility": False,
                  "acknowledge_rewritten_tables": (), "static": "changed", "evidence_root": str(repo),
                  "acknowledge_absent_ingress_baseline": False}
        fields.update(kw)
        args = Args(**fields)
        try:
            code = mode(args)
            return {"outcome": "return", "code": code}
        except rollout.Refuse as error:
            return {"outcome": "refuse", "error": str(error)}
        except Exception as error:  # noqa: BLE001
            return {"outcome": type(error).__name__, "error": str(error)}
    finally:
        rollout._EXECUTE, rollout._URLOPEN = previous, previous_fetch
        for name, value in saved_stubs.items():
            setattr(rollout, name, value)


FULL_ROLLBACK_STUBS = {"static_matches": lambda *a, **k: {"checked": 0, "stubbed": True},
                       "compare_tables": lambda *a, **k: {"tables": 0, "stubbed": True}}


def read_record(record):
    return json.loads(pathlib.Path(record).read_text(encoding="utf-8"))


# ---------------------------------------------------------------- B1
def test_b1_ack_is_durable_before_stop():
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(7, 19))
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record)
        state = read_record(record)
        check("B1 an unacknowledged rollback with findings refuses", outcome["outcome"] == "refuse",
              json.dumps(outcome)[:200])
        ack = state.get("finding_inaccessibility")
        check("B1 the refusal durably records the decision state",
              bool(ack) and ack["state"] == "missing" and ack["Finding"] == 7 and ack["FindingRevision"] == 19,
              json.dumps(ack))
        check("B1 the verbatim sentence with N and M is stored",
              bool(ack) and "7 Finding rows and 19 FindingRevision rows" in ack["text"])
        check("B1 nothing was stopped", not any("stop" in " ".join(c) for c in host.calls))

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(7, 19))
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record,
                           acknowledge_finding_inaccessibility=True)
        at_stop = host.snapshots.get("at_stop")
        check("B1 the acknowledged run reached the stop boundary", at_stop is not None,
              json.dumps(outcome)[:200])
        check("B1 the record ON DISK at the stop call already states the acknowledgement",
              bool(at_stop) and at_stop.get("finding_inaccessibility", {}).get("state") == "acknowledged",
              json.dumps((at_stop or {}).get("finding_inaccessibility")))
        stop_ack = (at_stop or {}).get("finding_inaccessibility") or {}
        check("B1 the record at the stop call already carries N and M",
              stop_ack.get("Finding") == 7 and stop_ack.get("FindingRevision") == 19,
              json.dumps(stop_ack))
        check("B1 acknowledged is distinguishable from not_required",
              stop_ack.get("acknowledgement_required") is True and stop_ack.get("flag_given") is True,
              json.dumps(stop_ack))


def test_b1_post_quiesce_counts_are_authoritative():
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        # Rows appear during quiescence: the terminal record must not claim the pre-stop count.
        host = Host(record, findings=(0, 0), findings_after=(4, 9))
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record,
                           acknowledge_finding_inaccessibility=True)
        state = read_record(record)
        ack = state.get("finding_inaccessibility") or {}
        check("B1 the authoritative record is the post-quiesce one",
              ack.get("phase") == "post-quiesce-authoritative" and ack.get("Finding") == 4
              and ack.get("FindingRevision") == 9, json.dumps(ack))
        check("B1 the pre-stop statement is kept separately",
              (state.get("finding_inaccessibility_pre_stop") or {}).get("Finding") == 0)
        check("B1 the terminal text names the stranded rows, not zero",
              "4 Finding rows and 9 FindingRevision rows" in ack.get("text", ""))
        check("B1 the post-quiesce compatibility is stored",
              state.get("rollback_compatibility_after_quiesce") is not None)
        check("B1 the counts were written before the checkout",
              outcome["outcome"] in ("return", "refuse"))


def test_b1_not_required_is_explicit():
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0))
        run_mode(rollout.mode_rollback, host, manifest_path, repo, record)
        ack = read_record(record).get("finding_inaccessibility") or {}
        check("B1 a rollback with no findings records not_required, not silence",
              ack.get("state") == "not_required" and ack.get("acknowledgement_required") is False,
              json.dumps(ack))


# ---------------------------------------------------------------- B2
def test_b2_hanging_protocol_is_derived():
    check("B2 the manifest derives baseline ownership of the table",
          MANIFEST["hanging_protocol"]["baseline_owns_table"] is True,
          json.dumps(MANIFEST.get("hanging_protocol")))
    check("B2 ownership rests on three independent git facts",
          all(MANIFEST["hanging_protocol"]["evidence"].values()))
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0), hanging_rows=25)
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record)
        state = read_record(record)
        hanging = state["rollback_compatibility"]["hanging_protocol"]
        check("B2 existing preference rows no longer block a rollback",
              hanging["blocking"] is False and state["rollback_compatibility"]["blocking"] is False,
              json.dumps(hanging))
        check("B2 the rows are still recorded as information", hanging["rows"] == 25
              and hanging["baseline_owns_table"] is True)
        check("B2 the rollback is not refused for them",
              outcome["outcome"] != "refuse" or "previous API cannot read" not in outcome.get("error", ""),
              json.dumps(outcome)[:200])
    # Counterfactual: a baseline that does NOT own the table must still block.
    manifest = json.loads(json.dumps(MANIFEST))
    manifest["hanging_protocol"]["baseline_owns_table"] = False
    previous, rollout._EXECUTE = rollout._EXECUTE, Host(pathlib.Path(tempfile.gettempdir()) / "nonexistent.json",
                                                        findings=(0, 0), hanging_rows=3)
    try:
        compat = rollout.rollback_compatibility(manifest)
    finally:
        rollout._EXECUTE = previous
    check("B2 a baseline without the table still blocks on its rows",
          compat["hanging_protocol"]["blocking"] is True and compat["blocking"] is True)


# ---------------------------------------------------------------- I5: rollback-start
def test_i5_rollback_start_records_but_never_blocks_recovery():
    """The OLD behaviour: an ingress difference refused at rollback-start, so a topology the
    rollback never touches could keep the previous API image from being restored."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        # The workflow network was removed under us and never comes back.
        host = Host(record, findings=(0, 0), ingress=NETWORK_REMOVED)
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record,
                           stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        start = state.get("ingress_rollback_start") or {}
        check("I5 the difference is OBSERVED and recorded at rollback-start",
              start.get("comparison", {}).get("unchanged") is False
              and bool(start["comparison"]["differences"]), json.dumps(start.get("comparison"))[:220])
        check("I5 rollback-start is explicitly not enforced", start.get("enforced") is False)
        check("I5 the previous checkout and image were restored anyway",
              any("checkout" in c for c in host.calls)
              and any(c[:2] == ["docker", "tag"] for c in host.calls), json.dumps(host.calls[-4:])[:200])
        check("I5 the writers were stopped and started again",
              any(c[:2] == ["docker", "compose"] and "stop" in c for c in host.calls)
              and any(c[:2] == ["docker", "compose"] and "up" in c for c in host.calls))
        check("I5 but rollback-END still ends in NEEDS_ATTENTION with the lock retained",
              outcome["outcome"] == "refuse" and state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED"
              and (repo / ".kin-ops.lock").exists(), json.dumps(outcome)[:200])
        check("I5 the end observation is recorded too",
              (state.get("ingress_rollback_end") or {}).get("comparison", {}).get("unchanged") is False)
        check("I5 the manual action is the preservation one, not a rollback instruction",
              state.get("manual_next_action") == rollout.GUARD_NEXT_ACTION
              and "A rollback does NOT remedy that" in rollout.GUARD_NEXT_ACTION)
        check("I5 no docker network command was ever issued",
              not any(c[:2] == ["docker", "network"] for c in host.calls))

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        # Different at the start, restored by the end: the rollback completes normally.
        host = Host(record, findings=(0, 0), ingress=NETWORK_REMOVED, ingress_after=PRESENT)
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record,
                           stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("I5 an ingress restored before the end reaches the terminal status",
              outcome["outcome"] == "return" and state["status"] == "ROLLED_BACK_DATABASE_RETAINED",
              json.dumps(outcome)[:200])
        check("I5 and the start difference is still on the record for the audit",
              (state.get("ingress_rollback_start") or {}).get("comparison", {}).get("unchanged") is False)
        check("I5 the lock is released on a completed rollback", not (repo / ".kin-ops.lock").exists())

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        # Only the independently managed receiver rotated: that is never a preservation failure.
        host = Host(record, findings=(0, 0), ingress=RECEIVER_ROTATED)
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record,
                           stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("I4 a receiver-only rotation does not disturb the rollback",
              outcome["outcome"] == "return" and state["status"] == "ROLLED_BACK_DATABASE_RETAINED",
              json.dumps(outcome)[:200])
        check("I4 and both ingress observations compare unchanged",
              state["ingress_rollback_start"]["comparison"]["unchanged"] is True
              and state["ingress_rollback_end"]["comparison"]["unchanged"] is True)

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        # The proxy itself was recreated during the rollback: rollback-end must catch it.
        host = Host(record, findings=(0, 0), ingress=PRESENT, ingress_after=PROXY_RECREATED)
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record,
                           stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("I1 a proxy recreated during the rollback is caught at the end",
              outcome["outcome"] == "refuse" and state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED",
              json.dumps(outcome)[:200])
        check("I1 the terminal ROLLED_BACK status is not left on the record",
              state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED", state["status"])
        check("I1 the lock is not released on an unrestored ingress", (repo / ".kin-ops.lock").exists())
        check("I1 the difference names the proxy fields that moved",
              any("kin-proxy id" in d for d in state["ingress_rollback_end"]["comparison"]["differences"]),
              json.dumps(state["ingress_rollback_end"]["comparison"]["differences"]))


def test_i3_an_old_record_fails_closed():
    """A durable record written before the ingress baseline existed must never be compared
    against an invented snapshot. It fails closed, with a message that says why."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, baseline=None,
                                               extra={"proxy_guard_pre_apply": {"inert": True}})
        host = Host(record, findings=(0, 0))
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record,
                           stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("I3 a record with no ingress baseline still restores the services",
              any("checkout" in c for c in host.calls), json.dumps(outcome)[:200])
        check("I3 rollback-start records that it cannot compare, rather than inventing a baseline",
              state["ingress_rollback_start"]["comparison"]["comparable"] is False
              and "never invented after the fact" in " ".join(
                  state["ingress_rollback_start"]["comparison"]["differences"]),
              json.dumps(state["ingress_rollback_start"]["comparison"])[:240])
        check("I3 and rollback-end fails CLOSED instead of passing vacuously",
              outcome["outcome"] == "refuse" and state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED",
              json.dumps(outcome)[:200])
        check("I3 the refusal explains what to do about the old record",
              "no ingress baseline in schema" in outcome.get("error", ""), outcome.get("error", "")[:200])


# ---------------------------------------------------------------- B3/I1: verify
def test_b3_verify_guard():
    """Drives the real mode_verify: its expensive prerequisites are replaced, the mode is not."""
    verify_stubs = {
        "table_state": lambda *a, **k: {"Finding": {"rows": 0}},
        "compare_tables": lambda *a, **k: {"tables": 1},
        "static_matches": lambda *a, **k: {"checked": 0},
        "running_image": lambda *a, **k: "sha256:candidate",
        "wait_health": lambda *a, **k: True,
        "unauthenticated_is_refused": lambda *a, **k: 401,
    }

    def drive(host, repo, manifest_path, record, tmp):
        evidence = pathlib.Path(tmp) / "auth.json"
        evidence.write_text("{}", encoding="utf-8")
        stubs = dict(verify_stubs)
        stubs["safe_input"] = lambda *a, **k: (evidence, "e" * 64, b"{}")
        stubs["validate_auth_body"] = lambda *a, **k: {"frame_sha256_after": "f" * 64,
                                                       "method": "synthetic",
                                                       "created_utc": rollout.stamp()}
        return run_mode(rollout.mode_verify, host, manifest_path, repo, record, stubs=stubs,
                        evidence=str(evidence), evidence_sha256="e" * 64)

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(
            tmp, status="APPLIED_PENDING_AUTHENTICATED_CHECKS",
            extra={"applied_utc": rollout.stamp(), "tables": ["Finding"],
                   "identity_columns": {"Finding": ["id"]}, "before": {"Finding": {"rows": 0}}})
        host = Host(record, ingress=PROXY_RECREATED)
        outcome = drive(host, repo, manifest_path, record, tmp)
        after = read_record(record)
        check("I1 verify refuses on a moved ingress instead of reaching DEPLOYED",
              outcome["outcome"] == "refuse" and after["status"] != "DEPLOYED", json.dumps(outcome)[:200])
        check("I1 verify records the observation and keeps NEEDS_ATTENTION",
              after.get("ingress_verify_end") is not None
              and after["status"] == "NEEDS_ATTENTION_LOCK_RETAINED")
        check("I1 the lock file is untouched by the guard", (repo / ".kin-ops.lock").exists())
        check("I1 verify's guard action is the preservation one",
              after.get("manual_next_action") == rollout.GUARD_NEXT_ACTION)

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(
            tmp, status="APPLIED_PENDING_AUTHENTICATED_CHECKS",
            extra={"applied_utc": rollout.stamp(), "tables": ["Finding"],
                   "identity_columns": {"Finding": ["id"]}, "before": {"Finding": {"rows": 0}}})
        # The ingress the apply recorded is exactly what is still there: this is the case the OLD
        # absence guard refused on the real production host.
        host = Host(record, ingress=PRESENT)
        outcome = drive(host, repo, manifest_path, record, tmp)
        after = read_record(record)
        check("I1 the REAL production ingress verifies to DEPLOYED",
              outcome["outcome"] == "return" and after["status"] == "DEPLOYED", json.dumps(outcome)[:240])
        check("I1 the verify-end comparison is recorded as unchanged",
              after["ingress_verify_end"]["comparison"]["unchanged"] is True)
        check("I1 the lock is released on a completed verify", not (repo / ".kin-ops.lock").exists())

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(
            tmp, status="APPLIED_PENDING_AUTHENTICATED_CHECKS",
            extra={"applied_utc": rollout.stamp(), "tables": ["Finding"],
                   "identity_columns": {"Finding": ["id"]}, "before": {"Finding": {"rows": 0}}})
        host = Host(record, ingress=RECEIVER_ROTATED)
        outcome = drive(host, repo, manifest_path, record, tmp)
        after = read_record(record)
        check("I4 a receiver rotation between apply and verify does not block the deployment",
              outcome["outcome"] == "return" and after["status"] == "DEPLOYED", json.dumps(outcome)[:240])


# ---------------------------------------------------------------- I3/I6: the apply gate
APPLY_STUBS = {
    "rederive": lambda *a, **k: {"added": [], "served": [], "new_migrations": []},
    "gate_receipt": lambda *a, **k: {"run_id": 1, "stubbed": True},
    "build_receipt": lambda *a, **k: {"image_id": "sha256:candidate", "stubbed": True},
    "require_pinned_baseline": lambda *a, **k: None,
    "require_capacity": lambda *a, **k: None,
    "identity_probe": lambda *a, **k: {"stubbed": True},
    "verify_observed_migration_state": lambda *a, **k: {"stubbed": True},
    "verify_backup_components": lambda *a, **k: {"backup": "/tmp/backup", "stubbed": True},
    "move_checkout": lambda *a, **k: None,
    "apply_migration": lambda *a, **k: "stubbed",
    "table_state": lambda *a, **k: {"Finding": {"rows": 0, "digest": "d", "identities": {}}},
    "compare_tables": lambda *a, **k: {"tables": 1, "stubbed": True},
    "migration_facts": lambda *a, **k: {"names": [], "count": 0, "unfinished_or_rolled_back": 0},
    "require_migration_applied": lambda *a, **k: {"applied": []},
    "public_tables": lambda *a, **k: ["Finding"],
    "static_matches": lambda *a, **k: {"count": 0},
    "verify_delivered_on_disk": lambda *a, **k: {"files": {}},
}


def apply_facts():
    return ({"containers": {"kin-api": {"image": "sha256:previous"}},
             "disk": {"repository": {"total": 10 ** 12, "free": 10 ** 12}},
             "database": {"tables": ["Finding"], "migrations": {"names": []},
                          "capacity": {"counts": {"Finding": 0}, "identity_columns": {"Finding": ["id"]},
                                       "oversized": []}}}, [])


def drive_apply(host, manifest_path, repo, record, **kw):
    stubs = dict(APPLY_STUBS)
    stubs["fresh_facts"] = lambda *a, **k: apply_facts()
    fields = {"backup": "/tmp/backup", "gate": "g", "gate_sha256": "a" * 64, "build": "b",
              "build_sha256": "b" * 64, "previous_tag": "kin-api:previous",
              "min_free_bytes": 1, "max_age": 3600, "max_hashed_rows": 1000, "static": "all"}
    fields.update(kw)
    return run_mode(rollout.mode_apply, host, manifest_path, repo, record, stubs=stubs, **fields)


def test_i6_nginx_is_proved_before_the_lock():
    """The OLD placement ran `nginx -t` only after api and orthanc had been recreated."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, with_record=False, with_lock=False)
        host = Host(record, nginx_ok=False)
        outcome = drive_apply(host, manifest_path, repo, record)
        check("I6 a proxy whose configuration does not parse refuses the apply",
              outcome["outcome"] == "refuse" and "nginx -t" in outcome.get("error", ""),
              json.dumps(outcome)[:240])
        check("I6 the refusal leaks no configuration or route content",
              "configuration file test failed" not in outcome.get("error", ""), outcome.get("error", "")[:200])
        check("I6 no durable record was created", not record.exists())
        check("I6 no lock was taken", not (repo / ".kin-ops.lock").exists())
        check("I6 nothing was stopped, tagged or checked out",
              not any("stop" in c for c in host.calls) and not any("checkout" in c for c in host.calls)
              and not any(c[:2] == ["docker", "tag"] for c in host.calls), json.dumps(host.calls)[:240])


def test_i3_apply_gate_and_baseline():
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, with_record=False, with_lock=False)
        host = Host(record, ingress=PRESENT)
        outcome = drive_apply(host, manifest_path, repo, record)
        state = read_record(record)
        check("I1 the REAL production ingress no longer refuses the apply",
              outcome["outcome"] == "return"
              and state["status"] == "APPLIED_PENDING_AUTHENTICATED_CHECKS", json.dumps(outcome)[:240])
        check("I1 the baseline observation is on the record from the moment it is created",
              state["ingress_baseline"]["shape"] == "present"
              and state["ingress_baseline"]["schema"] == rollout.INGRESS_SCHEMA)
        at_stop = host.snapshots.get("at_stop") or {}
        check("I1 the baseline was durable BEFORE the writers were stopped",
              (at_stop.get("ingress_baseline") or {}).get("shape") == "present",
              json.dumps(sorted(at_stop))[:200])
        check("I6 the pre-lock nginx result is recorded", state.get("nginx_config_ok_pre_apply") is True)
        check("I1 post-apply compares equal and is recorded",
              state["ingress_post_apply"]["comparison"]["unchanged"] is True
              and state["ingress_post_apply"]["enforced"] is True)
        check("I3 the absence acknowledgement is recorded as not given",
              state["absent_ingress_baseline_acknowledged"] is False)
        check("I1 no docker network command was issued during a whole apply",
              not any(c[:2] == ["docker", "network"] for c in host.calls))

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, with_record=False, with_lock=False)
        # The ingress disappears between the pre-apply baseline and the post-apply check.
        host = Host(record, ingress=PRESENT, ingress_after=NETWORK_REMOVED)
        outcome = drive_apply(host, manifest_path, repo, record)
        state = read_record(record)
        check("I1 an ingress that moves during the apply is NEEDS_ATTENTION",
              outcome["outcome"] == "refuse" and state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED",
              json.dumps(outcome)[:240])
        check("I1 the lock and the record are retained", (repo / ".kin-ops.lock").exists() and record.exists())
        check("I1 the preservation failure, not a generic one, is what the record tells the operator",
              state["manual_next_action"] == rollout.GUARD_NEXT_ACTION
              and state["ingress_post_apply"]["stage"] == "post-apply"
              and state["ingress_post_apply"]["comparison"]["unchanged"] is False,
              json.dumps({"failed_action": state.get("failed_action"),
                          "differences": state["ingress_post_apply"]["comparison"]["differences"]})[:240])
        # The rollback's own signature is re-tagging the previous image as the compose tag. It must
        # not happen by itself: a rollback cannot restore external network state.
        check("I1 no automatic rollback was attempted after the trip",
              not any(c[:2] == ["docker", "tag"] and c[3:] == ["pacs-starter-kit-api:latest"]
                      and c[2] == "sha256:previous" for c in host.calls)
              and host.api_image == "sha256:candidate", json.dumps(host.calls[-3:])[:200])

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, with_record=False, with_lock=False)
        # A host with no ingress at all: coherent, but on THIS product it is a change, not a baseline.
        host = Host(record, ingress=NETWORK_REMOVED)
        outcome = drive_apply(host, manifest_path, repo, record)
        check("I3 a disappeared production ingress is not silently adopted as a baseline",
              outcome["outcome"] == "refuse" and "absent" in outcome.get("error", ""),
              json.dumps(outcome)[:240])
        check("I3 and nothing was created before that refusal",
              not record.exists() and not (repo / ".kin-ops.lock").exists())

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, with_record=False, with_lock=False)
        host = Host(record, ingress=NETWORK_REMOVED)
        outcome = drive_apply(host, manifest_path, repo, record,
                              acknowledge_absent_ingress_baseline=True)
        state = read_record(record)
        check("I3 an explicitly acknowledged absence is accepted and recorded",
              outcome["outcome"] == "return" and state["ingress_baseline"]["shape"] == "absent"
              and state["absent_ingress_baseline_acknowledged"] is True, json.dumps(outcome)[:240])

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, with_record=False, with_lock=False)
        half = dict(PRESENT, mounts=[LETSENCRYPT, dict(LIVE_ROUTE, RW=True)])
        host = Host(record, ingress=half)
        outcome = drive_apply(host, manifest_path, repo, record,
                              acknowledge_absent_ingress_baseline=True)
        check("I3 a half state refuses even with the absence acknowledgement",
              outcome["outcome"] == "refuse"
              and "not in a state this rollout can take as a baseline" in outcome.get("error", ""),
              json.dumps(outcome)[:240])
        check("I3 and it too creates nothing",
              not record.exists() and not (repo / ".kin-ops.lock").exists())


# ---------------------------------------------------------------- B-1: a raising inspect
# The OLD failure, reproduced: the rollback-start relaxation covered a DIFFERENT ingress and an
# unreadable one, but `docker inspect kin-proxy` can also fail to return at all - a wedged
# container blocks its own inspect for the full 60 s while the rest of the daemon answers. That
# exception escaped the enforce=False checkpoint into mode_rollback's handler, so the record ended
# NEEDS_ATTENTION before stop_writers, before the baseline checkout and before the previous image
# was re-tagged: the previous API was not restored, for an ingress-observation reason alone.
HUNG_INSPECT = subprocess.TimeoutExpired(
    ["docker", "inspect", "kin-proxy"], 60,
    output=b'[{"Id": "proxy-1", "Config": {"Env": ["WORKFLOW_ROUTE_TOKEN=s3cret-value"]}}]',
    stderr=b"Cannot connect to the Docker daemon at unix:///var/run/docker.sock")
NO_CLIENT = PermissionError(13, "Permission denied: '/home/ubuntu/.docker/config.json'")


def hung_inspect_host(host, error, what="proxy", until_quiesced=True):
    """`host`, except that one of the two ingress inspects RAISES instead of answering.

    until_quiesced=True makes it a transient failure that is over by the `compose stop`, which is
    the case in which the rollback may still reach its terminal status.
    """
    def run(args, **kwargs):
        selected = (list(args)[:2] == ["docker", "inspect"]
                    and ("--type" in args if what == "network" else args[-1] == "kin-proxy"))
        if selected and not (until_quiesced and host.quiesced):
            host.calls.append(list(args))
            raise error
        return host(args, **kwargs)
    return run


def test_b1_a_raising_ingress_inspect_never_blocks_recovery():
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0), ingress=PRESENT)
        outcome = run_mode(rollout.mode_rollback, hung_inspect_host(host, HUNG_INSPECT),
                           manifest_path, repo, record, stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        start = state.get("ingress_rollback_start") or {}
        check("B-1 the writers were quiesced despite the hung proxy inspect",
              any(c[:2] == ["docker", "compose"] and "stop" in c for c in host.calls),
              json.dumps(outcome)[:240])
        check("B-1 the baseline checkout still happened",
              any("checkout" in c for c in host.calls), json.dumps(host.calls[-4:])[:240])
        check("B-1 the previous image was re-tagged and the services were started",
              any(c[:2] == ["docker", "tag"] and c[2] == "sha256:previous" for c in host.calls)
              and any(c[:2] == ["docker", "compose"] and "up" in c for c in host.calls),
              json.dumps(host.calls[-4:])[:240])
        check("B-1 rollback-start is RECORDED as an unreadable observation, not an exception",
              start.get("enforced") is False
              and start.get("observed", {}).get("shape") == "indeterminate"
              and start.get("comparison", {}).get("unchanged") is False,
              json.dumps(start.get("observed", {}).get("shape_problems"))[:240])
        check("B-1 the record keeps the exception type only, with no argv, output or secret",
              "TimeoutExpired" in json.dumps(start)
              and "s3cret-value" not in json.dumps(state) and "docker.sock" not in json.dumps(state),
              json.dumps(start.get("observed", {}).get("proxy"))[:240])
        check("B-1 a transient start-only failure still reaches the terminal status",
              outcome["outcome"] == "return" and state["status"] == "ROLLED_BACK_DATABASE_RETAINED",
              json.dumps(outcome)[:240])
        check("B-1 rollback-end observed a healthy ingress and released the lock",
              state["ingress_rollback_end"]["comparison"]["unchanged"] is True
              and not (repo / ".kin-ops.lock").exists())
        check("B-1 no docker network command was issued while the inspect was hung",
              not any(c[:2] == ["docker", "network"] for c in host.calls))

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0), ingress=PRESENT)
        outcome = run_mode(rollout.mode_rollback,
                           hung_inspect_host(host, NO_CLIENT, what="network"),
                           manifest_path, repo, record, stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("B-1 the OTHER spawn site behaves the same: an OSError on the network inspect",
              outcome["outcome"] == "return" and state["status"] == "ROLLED_BACK_DATABASE_RETAINED"
              and any("checkout" in c for c in host.calls), json.dumps(outcome)[:240])
        check("B-1 and its recorded reason is the exception type, not the host path",
              "PermissionError" in json.dumps(state["ingress_rollback_start"])
              and "/home/ubuntu" not in json.dumps(state),
              json.dumps(state["ingress_rollback_start"]["observed"]["network"])[:240])

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0), ingress=PRESENT)
        # The inspect never recovers: the api is restored, but the END is still enforced.
        outcome = run_mode(rollout.mode_rollback,
                           hung_inspect_host(host, HUNG_INSPECT, until_quiesced=False),
                           manifest_path, repo, record, stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("B-1 a persistent hang still restores the previous api and orthanc",
              any("checkout" in c for c in host.calls)
              and any(c[:2] == ["docker", "compose"] and "up" in c for c in host.calls),
              json.dumps(outcome)[:240])
        check("B-1 but an ingress that cannot be read at the END is NEEDS_ATTENTION, lock retained",
              outcome["outcome"] == "refuse" and state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED"
              and (repo / ".kin-ops.lock").exists() and record.exists(), json.dumps(outcome)[:240])
        check("B-1 the terminal ROLLED_BACK status is not left on the record",
              state["ingress_rollback_end"]["enforced"] is True
              and state["ingress_rollback_end"]["comparison"]["unchanged"] is False
              and state["manual_next_action"] == rollout.GUARD_NEXT_ACTION, state["status"])
        check("B-1 nothing about the network or the proxy was repaired automatically",
              not any(c[:2] == ["docker", "network"] for c in host.calls)
              and not any(c[:3] == ["docker", "compose", "restart"] for c in host.calls))

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        # An UNRELATED guard: the relaxation is about the ingress comparison and nothing else.
        host = Host(record, findings=(3, 4), ingress=PRESENT)
        outcome = run_mode(rollout.mode_rollback, hung_inspect_host(host, HUNG_INSPECT),
                           manifest_path, repo, record, stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("B-1 the unacknowledged finding guard still refuses under a hung inspect",
              outcome["outcome"] == "refuse" and "finding data exists" in outcome.get("error", ""),
              json.dumps(outcome)[:240])
        check("B-1 and it refuses BEFORE anything is stopped, tagged or checked out",
              not any(c[:2] == ["docker", "compose"] and "stop" in c for c in host.calls)
              and not any("checkout" in c for c in host.calls)
              and not any(c[:2] == ["docker", "tag"] for c in host.calls),
              json.dumps(host.calls)[:240])
        check("B-1 the unreadable observation is on the record without becoming the reason",
              (state.get("ingress_rollback_start") or {}).get("observed", {}).get("shape")
              == "indeterminate"
              and state.get("manual_next_action") != rollout.GUARD_NEXT_ACTION
              and state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED"
              and (repo / ".kin-ops.lock").exists(), json.dumps(state.get("failed_action")))

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp, with_record=False, with_lock=False)
        host = Host(record, ingress=PRESENT)
        # Pre-apply is NOT relaxed: an unreadable ingress refuses before the record and the lock.
        outcome = drive_apply(hung_inspect_host(host, HUNG_INSPECT, until_quiesced=False),
                              manifest_path, repo, record)
        check("B-1 pre-apply still fails closed on an inspect that never returns",
              outcome["outcome"] == "refuse"
              and "not in a state this rollout can take as a baseline" in outcome.get("error", ""),
              json.dumps(outcome)[:240])
        check("B-1 the pre-apply refusal leaks no captured output",
              "s3cret-value" not in outcome.get("error", "")
              and "docker.sock" not in outcome.get("error", ""), outcome.get("error", "")[:200])
        check("B-1 no record, no lock, nothing stopped or checked out before that refusal",
              not record.exists() and not (repo / ".kin-ops.lock").exists()
              and not any("stop" in c for c in host.calls)
              and not any("checkout" in c for c in host.calls), json.dumps(host.calls)[:240])


def test_nb5_call_sites():
    """NB5: removing the rollback-END checkpoint or the post-quiesce write must be caught."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0), findings_after=(2, 5))
        stages = []
        original = rollout.ingress_checkpoint

        def spy(rec, state, key, stage, enforce=True):
            stages.append((stage, enforce))
            return original(rec, state, key, stage, enforce)

        rollout.ingress_checkpoint = spy
        try:
            run_mode(rollout.mode_rollback, host, manifest_path, repo, record, stubs=FULL_ROLLBACK_STUBS,
                     acknowledge_finding_inaccessibility=True)
        finally:
            rollout.ingress_checkpoint = original
        check("NB5/m1 the rollback observes the ingress at BOTH start and end",
              stages == [("rollback-start", False), ("rollback-end", True)], json.dumps(stages))
        at_checkout = host.snapshots.get("at_checkout")
        ack = (at_checkout or {}).get("finding_inaccessibility") or {}
        check("NB5/m3 the post-quiesce counts are on disk BEFORE the checkout",
              ack.get("phase") == "post-quiesce-authoritative" and ack.get("Finding") == 2
              and ack.get("FindingRevision") == 5, json.dumps(ack))


def test_nb1_stale_next_action():
    """NB1: a remedied guard trip must not annotate a later, unrelated failure."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(
            tmp, extra={"manual_next_action": rollout.GUARD_NEXT_ACTION,
                        "guard_tripped_this_invocation": True, "failed_action": "post-apply",
                        "error": "an earlier trip"})
        # The ingress is unchanged now, but findings exist: the refusal is the findings one.
        host = Host(record, findings=(3, 4))
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record)
        state = read_record(record)
        check("NB1 the later refusal is the findings one", outcome["outcome"] == "refuse"
              and "finding data exists" in outcome.get("error", ""), json.dumps(outcome)[:160])
        check("NB1 the stale guard action does not annotate it",
              state.get("manual_next_action") != rollout.GUARD_NEXT_ACTION,
              (state.get("manual_next_action") or "")[:120])
        check("NB1 an unchanged observation clears the guard flag",
              state.get("guard_tripped_this_invocation") is False)

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(
            tmp, extra={"manual_next_action": "an older generic text", "error": "older error",
                        "failed_action": "verify", "failed_utc": "2026-09-18T00:00:00+00:00"})
        host = Host(record, findings=(0, 0))
        run_mode(rollout.mode_rollback, host, manifest_path, repo, record, stubs=FULL_ROLLBACK_STUBS)
        state = read_record(record)
        check("NB1 a terminal rollback record carries no stale failure text",
              state["status"] == "ROLLED_BACK_DATABASE_RETAINED"
              and state.get("manual_next_action") is None and state.get("error") is None
              and state.get("failed_action") is None, json.dumps(
                  {k: state.get(k) for k in ("status", "manual_next_action", "error", "failed_action")})[:200])


def test_b3_fail_does_not_overwrite_guard_action():
    state = {"manual_next_action": rollout.GUARD_NEXT_ACTION, "guard_tripped_this_invocation": True}
    with tempfile.TemporaryDirectory() as tmp:
        record = pathlib.Path(tmp) / "r.json"
        record.write_text("{}", encoding="utf-8")
        rollout.fail(record, state, RuntimeError("x"), "apply", "Decide explicitly between `rollback` and roll-forward")
        check("B3 a guard action survives the enclosing mode's generic text when THIS run tripped it",
              json.loads(record.read_text(encoding="utf-8"))["manual_next_action"] == rollout.GUARD_NEXT_ACTION)
        stale = {"manual_next_action": rollout.GUARD_NEXT_ACTION, "guard_tripped_this_invocation": False}
        rollout.fail(record, stale, RuntimeError("x"), "rollback", "the current generic text")
        check("NB1 a stale guard action from an earlier run is replaced",
              json.loads(record.read_text(encoding="utf-8"))["manual_next_action"] == "the current generic text")
        state2 = {}
        rollout.fail(record, state2, RuntimeError("x"), "apply", "generic text")
        check("B3 an ordinary failure still gets its own text",
              json.loads(record.read_text(encoding="utf-8"))["manual_next_action"] == "generic text")


def main():
    test_b1_ack_is_durable_before_stop()
    test_b1_post_quiesce_counts_are_authoritative()
    test_b1_not_required_is_explicit()
    test_b2_hanging_protocol_is_derived()
    test_i5_rollback_start_records_but_never_blocks_recovery()
    test_i3_an_old_record_fails_closed()
    test_b3_verify_guard()
    test_i6_nginx_is_proved_before_the_lock()
    test_i3_apply_gate_and_baseline()
    test_b1_a_raising_ingress_inspect_never_blocks_recovery()
    test_nb5_call_sites()
    test_nb1_stale_next_action()
    test_b3_fail_does_not_overwrite_guard_action()
    print("FAILURES=" + str(len(FAILURES)) + (" " + ",".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
