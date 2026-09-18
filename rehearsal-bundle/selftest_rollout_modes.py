#!/usr/bin/env python3
"""Mode-level behavioural regressions for B1-B3.

These drive the real `mode_rollback` and `mode_verify` entry points with a mocked `_EXECUTE`,
a temporary repository and a temporary durable record, and then assert on the RECORD FILE ON
DISK at the exact boundaries the review named: at the `compose stop` call, before the checkout,
and at the terminal decision. Nothing is asserted by searching the source text.

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


class Host:
    """A tiny synthetic host: answers the exact commands the modes issue, and records them.

    `snapshots` captures the durable record as it exists on disk at named boundaries, which is
    the only way to test B1's 'recorded before the rollback proceeds'.
    """

    def __init__(self, record_path, findings=(0, 0), findings_after=None, hanging_rows=0,
                 proxy_networks=("kin_default",), proxy_mounts=("/etc/letsencrypt",),
                 network_present=False, network_present_after=None):
        self.record_path = record_path
        self.calls = []
        self.snapshots = {}
        self.findings = findings
        self.findings_after = findings if findings_after is None else findings_after
        self.hanging_rows = hanging_rows
        self.proxy_networks = list(proxy_networks)
        self.proxy_mounts = list(proxy_mounts)
        self.network_present = network_present
        self.network_present_after = network_present if network_present_after is None else network_present_after
        self.quiesced = False

    def snapshot(self, label):
        try:
            self.snapshots[label] = json.loads(pathlib.Path(self.record_path).read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.snapshots[label] = None

    def __call__(self, args, **kwargs):
        self.calls.append(list(args))
        text = " ".join(args)
        if args[0] == "git":
            if "checkout" in args:
                # NB5/m3: snapshot the record exactly at the checkout boundary.
                self.snapshot("at_checkout")
            if "rev-parse" in args and "HEAD" in args:
                return Result(0, MANIFEST["baseline_sha"].encode())
            return Result(0, b"")
        if args[:2] == ["docker", "inspect"] and "--type" in args and "network" in args:
            present = self.network_present_after if self.quiesced else self.network_present
            return Result(0, b"[{}]") if present else Result(1, b"", b"Error: No such network: kin-workflow")
        if args[:2] == ["docker", "inspect"] and "--format" in args:
            if "{{.State.Running}}" in args:
                return Result(0, b"false")
            if "{{.Image}}" in args:
                return Result(0, b"sha256:previous")
            return Result(0, b"2026-09-18T12:00:00Z")
        if args[:2] == ["docker", "inspect"]:
            networks = self.proxy_networks + (["kin-workflow"] if
                                              (self.network_present_after if self.quiesced else self.network_present)
                                              and "joined" in self.proxy_mounts else [])
            payload = json.dumps([{"Image": "sha256:proxy", "State": {"StartedAt": "2026-09-18T11:00:00Z"},
                                   "NetworkSettings": {"Networks": {n: {} for n in self.proxy_networks}},
                                   "Mounts": [{"Destination": d} for d in self.proxy_mounts if d != "joined"]}])
            return Result(0, payload.encode())
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
        if args[:2] == ["docker", "compose"] and "stop" in args:
            self.snapshot("at_stop")
            self.quiesced = True
            return Result(0, b"")
        if args[:2] == ["docker", "compose"] and "up" in args:
            return Result(0, b"")
        if args[0] == "docker" and args[1] in ("exec", "tag"):
            return Result(0, b"")
        return Result(0, b"")


def scaffold(tmp, status="APPLIED_PENDING_AUTHENTICATED_CHECKS", extra=None):
    repo = pathlib.Path(tmp) / "repo"
    (repo / "config").mkdir(parents=True)
    shutil.copyfile(HERE / "manifest-stage2.json", repo / "manifest-copy.json")
    token = uuid.uuid4().hex
    (repo / ".kin-ops.lock").write_text(token, encoding="utf-8")
    manifest_path = pathlib.Path(tmp) / "manifest.json"
    shutil.copyfile(HERE / "manifest-stage2.json", manifest_path)
    manifest, _sha = rollout.load_manifest(str(manifest_path))
    record = pathlib.Path(tmp) / "record.json"
    state = {"schema": rollout.SCHEMA, "token": token, "status": status,
             "target": manifest["target_sha"], "baseline": manifest["baseline_sha"],
             "manifest_sha256": manifest["_self_sha256"], "previous_image": "sha256:previous",
             "candidate_image": "sha256:candidate", "started_utc": rollout.stamp()}
    state.update(extra or {})
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
                  "acknowledge_rewritten_tables": (), "static": "changed", "evidence_root": str(repo)}
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


# ---------------------------------------------------------------- B3
def test_b3_rollback_guard():
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0), proxy_networks=("kin_default", "kin-workflow"),
                    network_present=True)
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record)
        state = read_record(record)
        check("B3 a drifted proxy refuses the rollback at its start", outcome["outcome"] == "refuse",
              json.dumps(outcome)[:200])
        check("B3 the guard observation is recorded on the rollback side",
              state.get("proxy_guard_rollback_start") is not None)
        check("B3 the status stays NEEDS_ATTENTION with the lock retained",
              state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED" and (repo / ".kin-ops.lock").exists())
        check("B3 the manual action does not offer rollback as the remedy",
              "A rollback does NOT remedy that" in state.get("manual_next_action", ""),
              state.get("manual_next_action", "")[:120])
        check("B3 no docker network command was issued",
              not any(c[:2] == ["docker", "network"] for c in host.calls))
        check("B3 no checkout to the baseline happened",
              not any("checkout" in c for c in host.calls))

    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        # Clean at the start, drifted by the end: the terminal status must not be reached.
        host = Host(record, findings=(0, 0), network_present=False, network_present_after=True,
                    proxy_networks=("kin_default",))
        host.proxy_mounts = ["/etc/letsencrypt", "/etc/kin-workflow/nginx"]
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record)
        state = read_record(record)
        check("B3 drift discovered at the end still refuses", outcome["outcome"] == "refuse")
        check("B3 the terminal ROLLED_BACK status is not left on the record",
              state["status"] == "NEEDS_ATTENTION_LOCK_RETAINED", state["status"])
        check("B3 the lock is not released on a drifted rollback", (repo / ".kin-ops.lock").exists())


def test_b3_verify_guard():
    """Drives the real mode_verify: its expensive prerequisites are replaced, the mode is not."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(
            tmp, status="APPLIED_PENDING_AUTHENTICATED_CHECKS",
            extra={"applied_utc": rollout.stamp(), "tables": ["Finding"], "identity_columns": {"Finding": ["id"]},
                   "before": {"Finding": {"rows": 0}}})
        host = Host(record, proxy_networks=("kin_default", "kin-workflow"), network_present=True)
        evidence = pathlib.Path(tmp) / "auth.json"
        evidence.write_text("{}", encoding="utf-8")
        stubs = {
            "safe_input": lambda *a, **k: (evidence, "e" * 64, b"{}"),
            "validate_auth_body": lambda *a, **k: {"frame_sha256_after": "f" * 64, "method": "synthetic",
                                                  "created_utc": rollout.stamp()},
            "table_state": lambda *a, **k: {"Finding": {"rows": 0}},
            "compare_tables": lambda *a, **k: {"tables": 1},
            "static_matches": lambda *a, **k: {"checked": 0},
            "running_image": lambda *a, **k: "sha256:candidate",
            "wait_health": lambda *a, **k: True,
            "unauthenticated_is_refused": lambda *a, **k: 401,
        }
        saved = {name: getattr(rollout, name) for name in stubs}
        for name, value in stubs.items():
            setattr(rollout, name, value)
        try:
            outcome = run_mode(rollout.mode_verify, host, manifest_path, repo, record,
                               evidence=str(evidence), evidence_sha256="e" * 64)
        finally:
            for name, value in saved.items():
                setattr(rollout, name, value)
        after = read_record(record)
        check("B3 verify refuses on a drifted proxy instead of reaching DEPLOYED",
              outcome["outcome"] == "refuse" and after["status"] != "DEPLOYED", json.dumps(outcome)[:200])
        check("B3 verify records the guard and keeps NEEDS_ATTENTION",
              after.get("proxy_guard_verify_end") is not None
              and after["status"] == "NEEDS_ATTENTION_LOCK_RETAINED")
        check("B3 the lock file is untouched by the guard", (repo / ".kin-ops.lock").exists())
        check("B3 verify's guard action text is the network one",
              after.get("manual_next_action") == rollout.GUARD_NEXT_ACTION)


def test_nb5_call_sites():
    """NB5: removing the rollback-END guard or the post-quiesce write must be caught."""
    with tempfile.TemporaryDirectory() as tmp:
        repo, manifest_path, record = scaffold(tmp)
        host = Host(record, findings=(0, 0), findings_after=(2, 5))
        stages = []
        original = rollout.guard_or_needs_attention

        def spy(rec, state, key, stage):
            stages.append(stage)
            return original(rec, state, key, stage)

        rollout.guard_or_needs_attention = spy
        try:
            run_mode(rollout.mode_rollback, host, manifest_path, repo, record, stubs=FULL_ROLLBACK_STUBS,
                     acknowledge_finding_inaccessibility=True)
        finally:
            rollout.guard_or_needs_attention = original
        check("NB5/m1 the rollback observes the guard at BOTH start and end",
              stages == ["rollback-start", "rollback-end"], json.dumps(stages))
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
        # The proxy is inert now, but findings exist: the refusal is the findings one.
        host = Host(record, findings=(3, 4))
        outcome = run_mode(rollout.mode_rollback, host, manifest_path, repo, record)
        state = read_record(record)
        check("NB1 the later refusal is the findings one", outcome["outcome"] == "refuse"
              and "finding data exists" in outcome.get("error", ""), json.dumps(outcome)[:160])
        check("NB1 the stale guard action does not annotate it",
              state.get("manual_next_action") != rollout.GUARD_NEXT_ACTION,
              (state.get("manual_next_action") or "")[:120])
        check("NB1 an inert observation clears the guard flag",
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
    test_b3_rollback_guard()
    test_b3_verify_guard()
    test_nb5_call_sites()
    test_nb1_stale_next_action()
    test_b3_fail_does_not_overwrite_guard_action()
    print("FAILURES=" + str(len(FAILURES)) + (" " + ",".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
