#!/usr/bin/env python3
"""Pure regressions for the rehearsal harness (HB1-HB9).

Each case first reproduces the OLD false pass or false failure the independent review recorded,
then proves the corrected harness reaches the opposite verdict. Every child process is a mock: a
tiny in-memory Docker model, not a daemon. No container, network, database, server or credential.

Run: python3 selftest_harness_regressions.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
FAILURES = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + ((" :: " + detail) if detail and not condition else ""))
    if not condition:
        FAILURES.append(name)


def load_harness(tmp):
    os.environ.setdefault("REHEARSAL_IMAGE", "nginx:1.27-alpine")
    os.environ.setdefault("REHEARSAL_POSTGRES", "postgres:16-alpine")
    os.environ["RUNNER_TEMP"] = str(tmp)
    spec = importlib.util.spec_from_file_location("harness_" + pathlib.Path(tmp).name,
                                                  HERE / "rehearsal" / "rehearsal_harness.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# Verbatim from run 35337766905: what Docker 28.0.4 writes when the network is absent.
NETWORK_NOT_FOUND = "Error response from daemon: network kin-workflow not found\n"
# `docker inspect` of one real container is ~8-12 KB. A model that always answers in a few
# hundred bytes cannot reproduce a stdout-tail defect, so the payload is padded to that order.
INSPECT_PADDING = 9000


class FakeDocker:
    """A minimal model: containers with Ids and running state, and one optional network.

    It returns what raw() returns, INCLUDING raw()'s stdout bound, so a caller that parses a
    truncated tail fails here exactly as it failed on the runner.
    """

    def __init__(self, step_exit=0, up_changes_id=True, stop_stops=True, migrate_exit=7,
                 malformed_inspect=None):
        self.containers = {}
        self.network = False
        self.step_exit = step_exit
        self.up_changes_id = up_changes_id
        self.stop_stops = stop_stops
        self.migrate_exit = migrate_exit
        self.malformed_inspect = malformed_inspect
        self.serial = 0
        self.calls = []

    def create(self, name):
        self.serial += 1
        self.containers[name] = {"Id": name + "-" + str(self.serial), "running": True,
                                 "StartedAt": "2026-09-18T10:00:0" + str(self.serial) + "Z",
                                 "networks": ["kin_default"], "mounts": ["/etc/letsencrypt"]}

    def __call__(self, args, check=False, timeout=900, cwd=None, env=None, stdout_limit=4000):
        self.calls.append(list(args))
        text = " ".join(args)
        out, err, code = "", "", 0
        if args[:2] == ["docker", "pull"]:
            pass
        elif args[:2] == ["docker", "rm"]:
            self.containers.clear()
        elif args[:3] == ["docker", "network", "rm"]:
            self.network = False
        elif args[:3] == ["docker", "network", "create"]:
            self.network = True
        elif args[:3] == ["docker", "network", "connect"]:
            self.containers.get("kin-proxy", {}).setdefault("networks", []).append("kin-workflow")
        elif args[:3] == ["docker", "network", "disconnect"]:
            proxy = self.containers.get("kin-proxy", {})
            proxy["networks"] = [n for n in proxy.get("networks", []) if n != "kin-workflow"]
        elif args[:2] == ["docker", "version"]:
            out = "27.0.0"
        elif args[:2] == ["docker", "compose"] and "version" in args:
            out = "Docker Compose version v2.29.0"
        elif args[:2] == ["docker", "inspect"] and "--type" in args:
            code, err = (0, "") if self.network else (1, NETWORK_NOT_FOUND)
            out = "[{}]" if self.network else ""
        elif args[:2] == ["docker", "inspect"]:
            name = args[-1]
            body = self.containers.get(name)
            if body is None:
                code, err = 1, "Error: No such object: " + name
            elif self.malformed_inspect is not None:
                out = self.malformed_inspect
            else:
                out = json.dumps([{"Id": body["Id"], "State": {"Running": body["running"],
                                                               "StartedAt": body["StartedAt"]},
                                   "NetworkSettings": {"Networks": {n: {} for n in body["networks"]}},
                                   "Mounts": [{"Destination": d} for d in body["mounts"]],
                                   "Config": {"Labels": {"pad": "x" * INSPECT_PADDING}}}])
        elif args[:2] == ["docker", "compose"] and "up" in args:
            code = 0 if "--force-recreate" in args and "proxy" in args else self.step_exit
            if code == 0:
                for name in ("api", "orthanc", "proxy"):
                    if name in args and ("kin-" + name not in self.containers or self.up_changes_id):
                        self.create("kin-" + name)
        elif args[:2] == ["docker", "compose"] and "stop" in args:
            code = self.step_exit
            if code == 0 and self.stop_stops:
                for name in ("kin-api", "kin-orthanc"):
                    if name in self.containers:
                        self.containers[name]["running"] = False
        elif args[:2] == ["docker", "compose"] and "run" in args:
            code = self.migrate_exit if "exit 7" in text else self.step_exit
        elif "python" in args[0].lower():
            out = "Python 3.12.0"
        return {"argv": args, "exit": code,
                "stdout": out if stdout_limit is None else out[-stdout_limit:], "stderr": err}


def with_fake(module, fake):
    module.raw = fake
    # rollout.network_absent must see the same model, so route its spawn through the fake too.
    # The stdout bound belongs to raw(), not to the process: rollout.spawn() gets the whole answer.
    def spawn(args, **kwargs):
        answer = fake(list(args), stdout_limit=None)

        class R:
            returncode = answer["exit"]
            stdout = answer["stdout"].encode()
            stderr = answer["stderr"].encode()
        return R()
    module.rollout._EXECUTE = spawn
    return module


def run_scenario(name, fake_kwargs):
    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    fake = FakeDocker(**fake_kwargs)
    with_fake(module, fake)
    return module.SCENARIOS[name](), fake, module


# ---------------------------------------------------------------- HB1
def test_hb1():
    receipt, fake, _ = run_scenario("compose-network", {"step_exit": 15})
    check("HB1 the old false success is gone: non-zero step exits now fail",
          receipt["passed"] is False and any("exit 15" in p for p in receipt["problems"]),
          json.dumps(receipt["problems"])[:200])
    receipt, fake, _ = run_scenario("compose-network", {})
    check("HB1 the honest happy path passes", receipt["passed"] is True,
          json.dumps(receipt.get("problems"))[:300])
    receipt, _, _ = run_scenario("compose-network", {"stop_stops": False})
    check("HB1 a stop that stops nothing fails",
          receipt["passed"] is False and any("still running" in p for p in receipt["problems"]))
    receipt, _, _ = run_scenario("compose-network", {"up_changes_id": False})
    check("HB1 an up that recreates nothing fails",
          receipt["passed"] is False and any("Id did not change" in p for p in receipt["problems"]))


# ---------------------------------------------------------------- HB2
def test_hb2():
    receipt, _, _ = run_scenario("partial-failure", {"migrate_exit": 15})
    check("HB2 the old any-nonzero pass is gone: a wrong failure exit fails",
          receipt["passed"] is False and any("not 7" in p for p in receipt["problems"]),
          json.dumps(receipt["problems"])[:200])
    receipt, _, _ = run_scenario("partial-failure", {})
    check("HB2 exactly the injected exit 7 passes", receipt["passed"] is True,
          json.dumps(receipt.get("problems"))[:300])
    check("HB2 the refusal comes from run(), not from the harness",
          "failed" in receipt.get("refusal", "").lower(), receipt.get("refusal", "")[:120])
    check("HB2 no up or checkout argv was issued during the failure",
          not any("checkout" in call for call in receipt["argv_log"]))
    receipt, _, _ = run_scenario("partial-failure", {"migrate_exit": 0})
    check("HB2 a migrate that succeeds is not a partial failure",
          receipt["passed"] is False and any("did not raise" in p for p in receipt["problems"]))


# ---------------------------------------------------------------- HB3
def test_hb3():
    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    seen = {}

    def fake(args, **kwargs):
        if args[:2] == ["docker", "inspect"] and "--type" in args:
            if module.rollout.ENV_BASE.get("DOCKER_HOST"):
                seen["injected"] = True
                return {"argv": args, "exit": 1, "stdout": "",
                        "stderr": "Cannot connect to the Docker daemon at tcp://127.0.0.1:1"}
            return {"argv": args, "exit": 1, "stdout": "", "stderr": NETWORK_NOT_FOUND}
        return {"argv": args, "exit": 0, "stdout": "", "stderr": ""}

    with_fake(module, fake)
    receipt = module.SCENARIOS["indeterminate-control"]()
    check("HB3 the endpoint reaches the child environment", seen.get("injected") is True)
    check("HB3 the positive control reports absent", receipt["positive_control"]["absent"] is True)
    check("HB3 the injected endpoint reports indeterminate, never absent",
          receipt["injected"]["indeterminate"] is True and receipt["injected"]["absent"] is None)
    check("HB3 the scenario can pass on a healthy runner", receipt["passed"] is True,
          json.dumps(receipt["problems"]))
    check("HB3 ENV_BASE is restored", "DOCKER_HOST" not in module.rollout.ENV_BASE)


# ---------------------------------------------------------------- HB4
def test_hb4():
    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    first, second = module.project_dir(), module.project_dir()
    check("HB4 one project identity for the whole job", first == second and first.name == "kin-rehearsal")
    check("HB4 the project carries a .env so the compose files interpolate",
          (first / ".env").read_text(encoding="utf-8").startswith("REHEARSAL_IMAGE="))
    fake = FakeDocker()
    with_fake(module, fake)
    fake.create("kin-proxy")
    cleaned = module.cleanup(first)
    names = [c for c in fake.calls if c[:2] == ["docker", "rm"]]
    check("HB4 cleanup removes the synthetic containers by name", bool(names)
          and set(names[0][3:]) == set(module.SYNTHETIC_CONTAINERS))
    check("HB4 cleanup removes only the synthetic network",
          any(c[:3] == ["docker", "network", "rm"] and c[3] == "kin-workflow" for c in fake.calls))
    check("HB4 cleanup is declared harness-owned", "harness only" in cleaned["note"])
    receipt, fake2, _ = run_scenario("compose-network", {})
    check("HB4 every scenario cleans up before it starts",
          any(c[:2] == ["docker", "rm"] for c in fake2.calls[:3]), json.dumps(fake2.calls[:2]))


# ---------------------------------------------------------------- HB5
def test_hb5():
    receipt, fake, _ = run_scenario("guard-function-against-daemon", {})
    check("HB5 the scenario is named for what it is",
          receipt["scenario"] == "guard-function-against-daemon")
    check("HB5 both network variants are exercised",
          [v["variant"] for v in receipt["variants"]] == ["network-only", "network-and-joined"],
          json.dumps([v["variant"] for v in receipt["variants"]]))
    check("HB5 the runner's network commands are OBSERVED, not asserted as a literal",
          all(v["runner_network_commands"] == [] for v in receipt["variants"])
          and any(c[:3] == ["docker", "network", "create"] for c in fake.calls))
    check("HB5 both variants trip the guard", receipt["passed"] is True, json.dumps(receipt["problems"]))


# ---------------------------------------------------------------- HB8 / receipts
def test_receipts_and_versions():
    receipt, _, _ = run_scenario("compose-network", {})
    check("I8 the receipt records the three versions",
          set(receipt["versions"]) == {"docker", "docker_compose", "python3"})
    check("I8 the receipt keeps the raw stderr of the network inspect",
          NETWORK_NOT_FOUND.strip() in receipt["before"]["network"]["raw_stderr"])
    check("I8 the runner reads that real answer as absent, not as indeterminate",
          receipt["before"]["network"]["absent"] is True
          and receipt["before"]["network"]["indeterminate"] is False,
          json.dumps(receipt["before"]["network"])[:200])
    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    fake = FakeDocker()
    with_fake(module, fake)

    def exploding():
        raise SystemExit("rehearsal command failed: synthetic")

    module.SCENARIOS["compose-network"] = exploding
    out = pathlib.Path(tmp) / "receipt.json"
    saved = sys.argv
    sys.argv = ["harness", "--scenario", "compose-network", "--out", str(out)]
    code, escaped = None, None
    try:
        code = module.main()
    except SystemExit as error:
        escaped = str(error)  # a harness that lets setup failures escape writes no receipt
    finally:
        sys.argv = saved
    body = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    check("HB7 a setup failure still writes a receipt",
          escaped is None and out.exists() and body.get("passed") is False and code == 1,
          "escaped=" + str(escaped)[:80])
    check("HB7 the setup error is preserved in the receipt", "synthetic" in body.get("setup_error", ""))


# ---------------------------------------------------------------- HB11: inspect output
def test_hb11_inspect_output():
    """The S1/S6 crash of run 35337766905, reproduced without a daemon.

    raw() keeps a stdout TAIL so receipts stay bounded. `docker inspect` of a container is far
    larger than that bound, and the tail of a JSON document is not JSON, so container_facts()
    died with JSONDecodeError before either scenario could write a receipt.
    """
    module = load_harness(tempfile.mkdtemp())
    payload = json.dumps([{"Id": "kin-api-1", "State": {"Running": True}, "Pad": "y" * 12000}])
    emit = "import sys; sys.stdout.write(sys.argv[1])"
    argv = [sys.executable, "-B", "-c", emit, payload]

    bounded = module.raw(argv)
    check("HB11 the receipt bound is unchanged for ordinary commands", len(bounded["stdout"]) == 4000)
    check("HB11 and that bounded tail is NOT parseable, which is what crashed S1 and S6",
          _json_raises(bounded["stdout"]), bounded["stdout"][:40])
    whole = module.raw(argv, stdout_limit=None)
    check("HB11 a parsing caller can ask for the whole answer",
          whole["stdout"] == payload and json.loads(whole["stdout"])[0]["Id"] == "kin-api-1")

    # Through container_facts, against a model that applies the same bound.
    fake = FakeDocker()
    with_fake(module, fake)
    fake.create("kin-api")
    facts = module.container_facts("kin-api")
    check("HB11 container_facts parses an oversize inspect answer",
          facts.get("exists") is True and facts.get("Id") == "kin-api-1"
          and facts.get("running") is True, json.dumps(facts)[:200])

    # An exit-0 answer that is empty, `[]` or not JSON is a typed non-fact, never a raise.
    for label, body in (("empty", ""), ("an empty array", "[]"), ("not JSON", "docker: oops")):
        fake = FakeDocker(malformed_inspect=body)
        with_fake(module, fake)
        fake.create("kin-api")
        facts = module.container_facts("kin-api")
        check("HB11 " + label + " inspect output is a typed non-fact, not a crash",
              facts.get("exists") is None and "unreadable_inspect" in facts, json.dumps(facts)[:200])

    # And the scenario that consumes it still reaches its own honest failing receipt.
    receipt, _, _ = run_scenario("compose-network", {"malformed_inspect": "[]"})
    check("HB11 a scenario with unreadable inspect output fails honestly instead of dying",
          receipt["passed"] is False and any("baseline stack was not created" in p
                                             for p in receipt["problems"]),
          json.dumps(receipt["problems"])[:200])


def _json_raises(text):
    try:
        json.loads(text)
        return False
    except ValueError:
        return True


# ---------------------------------------------------------------- HB12: no lost receipt
def test_hb12_unhandled_failure_still_writes_a_receipt():
    """Run 35337766905 lost s1, s2 and s6: the exception escaped and the gate saw only absence."""
    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)

    def exploding():
        raise json.JSONDecodeError("Expecting value", "", 0)

    module.SCENARIOS["compose-network"] = exploding
    out = pathlib.Path(tmp) / "hb12.json"
    saved = sys.argv
    sys.argv = ["harness", "--scenario", "compose-network", "--out", str(out)]
    code, escaped = None, None
    try:
        code = module.main()
    except BaseException as error:  # noqa: BLE001 - the point of the test is that nothing escapes
        escaped = type(error).__name__ + ": " + str(error)
    finally:
        sys.argv = saved
    body = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    check("HB12 an unhandled scenario exception still writes a FAILING receipt",
          escaped is None and out.exists() and body.get("passed") is False and code == 1,
          "escaped=" + str(escaped)[:80])
    check("HB12 the traceback is preserved so the cause is in the evidence",
          "JSONDecodeError" in body.get("harness_error", ""), json.dumps(body)[:200])


# ---------------------------------------------------------------- HB10: the workflow gate
WORKFLOW = HERE / "rehearsal" / "stage2-rollout-rehearsal.yml"


def gate_script():
    """Extract the gate heredoc VERBATIM from the workflow, so the test runs what CI runs."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.rstrip().endswith("<<'PY'"))
    body = []
    for line in lines[start + 1:]:
        if line.strip() == "PY":
            break
        body.append(line)
    indent = min((len(line) - len(line.lstrip())) for line in body if line.strip())
    return "\n".join(line[indent:] for line in body)


def run_gate(root):
    import subprocess
    script = HERE / "gate-extracted.py"
    script.write_text(gate_script(), encoding="utf-8")
    try:
        outcome = subprocess.run([sys.executable, "-B", str(script), str(root)], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    finally:
        script.unlink(missing_ok=True)
    return {"exit": outcome.returncode, "stdout": outcome.stdout.decode("utf-8", "replace"),
            "stderr": outcome.stderr.decode("utf-8", "replace")}


def receipts_dir(passed_map, records=(), extra=None):
    root = pathlib.Path(tempfile.mkdtemp()) / "receipts"
    (root / "state-records").mkdir(parents=True)
    for stem, value in passed_map.items():
        body = {"scenario": stem} if value is _ABSENT else {"scenario": stem, "passed": value}
        (root / (stem + ".json")).write_text(json.dumps(body), encoding="utf-8")
    for name in records:
        # The rollout STATE RECORDS: no `passed` key at all, exactly as the modes write them.
        (root / "state-records" / name).write_text(
            json.dumps({"status": "NEEDS_ATTENTION_LOCK_RETAINED", "failed_action": "apply"}), encoding="utf-8")
    for name, text in (extra or {}).items():
        (root / name).write_text(text, encoding="utf-8")
    return root


class _Absent:
    pass


_ABSENT = _Absent()
ALL_GREEN = {stem: True for stem in ("s1", "s2", "s3", "s4", "s5", "s6", "s7")}
RECORDS = ("record-s3-ab12cd34.json", "record-s5-ef56ab78.json", "record-s6-0011aabb.json")


def test_hb10_gate():
    green = run_gate(receipts_dir(ALL_GREEN, RECORDS))
    check("HB10 the old crash is gone: all-green receipts beside state records pass",
          green["exit"] == 0 and "Traceback" not in green["stderr"], green["stderr"][-200:])
    summary = json.loads(green["stdout"].strip().splitlines()[-1])
    check("HB10 the gate consumes exactly the seven expected names",
          summary["expected"] == ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]
          and summary["missing"] == [] and summary["failed"] == [] and summary["malformed"] == [])
    check("HB10 the state records are preserved and reported separately",
          sorted(summary["state_records_kept_separately"]) == sorted(RECORDS),
          json.dumps(summary["state_records_kept_separately"]))

    missing = run_gate(receipts_dir({k: v for k, v in ALL_GREEN.items() if k != "s4"}, RECORDS))
    check("HB10 a missing receipt is refused by name",
          missing["exit"] != 0 and '"missing": ["s4"]' in missing["stdout"], missing["stdout"][-160:])
    failed = run_gate(receipts_dir({**ALL_GREEN, "s6": False}, RECORDS))
    check("HB10 a failed receipt is refused by name",
          failed["exit"] != 0 and '"failed": ["s6"]' in failed["stdout"], failed["stdout"][-160:])
    wrong_type = run_gate(receipts_dir({**ALL_GREEN, "s2": "true"}, RECORDS))
    check("HB10 a non-boolean passed value is refused, not coerced",
          wrong_type["exit"] != 0 and '"malformed": ["s2"]' in wrong_type["stdout"], wrong_type["stdout"][-160:])
    no_key = run_gate(receipts_dir({**ALL_GREEN, "s1": _ABSENT}, RECORDS))
    check("HB10 a receipt without a passed key is malformed, not a crash",
          no_key["exit"] != 0 and '"malformed": ["s1"]' in no_key["stdout"]
          and "Traceback" not in no_key["stderr"])
    broken = receipts_dir(ALL_GREEN, RECORDS)
    (broken / "s5.json").write_text("{not json", encoding="utf-8")
    unreadable = run_gate(broken)
    check("HB10 unreadable JSON is malformed, not a crash",
          unreadable["exit"] != 0 and '"malformed": ["s5"]' in unreadable["stdout"]
          and "Traceback" not in unreadable["stderr"])


# ---------------------------------------------------------------- HB2-R: split channels
class SplitDocker(FakeDocker):
    """Two channels: the RUNNER's own compose run can fail differently from the raw() control."""

    def __init__(self, runner_migrate_exit=7, control_migrate_exit=7, **kw):
        super().__init__(**kw)
        self.runner_migrate_exit = runner_migrate_exit
        self.control_migrate_exit = control_migrate_exit
        self.channel = "control"

    def __call__(self, args, **kwargs):
        if args[:2] == ["docker", "compose"] and "run" in args and "exit 7" in " ".join(args):
            code = self.runner_migrate_exit if self.channel == "runner" else self.control_migrate_exit
            self.calls.append(list(args))
            return {"argv": args, "exit": code, "stdout": "",
                    "stderr": "compose run failed with " + str(code)}
        return super().__call__(args, **kwargs)


def with_split(module, fake):
    module.raw = fake

    def spawn(args, **kwargs):
        fake.channel = "runner"
        try:
            answer = fake(list(args), stdout_limit=None)
        finally:
            fake.channel = "control"

        class R:
            returncode = answer["exit"]
            stdout = answer["stdout"].encode()
            stderr = answer["stderr"].encode()
        return R()

    module.rollout._EXECUTE = spawn
    return module


def test_hb2r_split_channel():
    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    fake = SplitDocker(runner_migrate_exit=1, control_migrate_exit=7)
    with_split(module, fake)
    receipt = module.SCENARIOS["partial-failure"]()
    check("HB2-R the old pass is gone: runner exit 1 with control 7 now fails",
          receipt["passed"] is False and any("runner's own call exited 1" in p for p in receipt["problems"]),
          json.dumps(receipt["problems"])[:220])
    check("HB2-R the runner's own returncode is recorded", receipt["runner_exit"] == 1)
    check("HB2-R the control exit is kept as a secondary observation", receipt["control_exit"] == 7)

    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    fake = SplitDocker(runner_migrate_exit=7, control_migrate_exit=7)
    with_split(module, fake)
    receipt = module.SCENARIOS["partial-failure"]()
    check("HB2-R both channels at exactly 7 passes", receipt["passed"] is True,
          json.dumps(receipt.get("problems"))[:220])
    check("HB2-R the receipt does not claim mode_apply or apply_migration's body",
          "mode_apply" in receipt["does_not_exercise"]
          and "the body of apply_migration" in receipt["does_not_exercise"]
          and "run" in receipt["exercises"])
    check("HB2-R the record assertion is scoped to fail()",
          "fail()" in receipt["record_assertion_scope"])
    check("HB2-R the runner's stderr tail is recorded", "compose run failed with 7" in receipt["runner_stderr"])

    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    fake = SplitDocker(runner_migrate_exit=127, control_migrate_exit=7)
    with_split(module, fake)
    receipt = module.SCENARIOS["partial-failure"]()
    check("HB2-R a different runner-side failure (127) is refused",
          receipt["passed"] is False and any("exited 127" in p for p in receipt["problems"]))

    # The control remains a real check too: a control that is not 7 is still a problem.
    tmp = tempfile.mkdtemp()
    module = load_harness(tmp)
    fake = SplitDocker(runner_migrate_exit=7, control_migrate_exit=15)
    with_split(module, fake)
    receipt = module.SCENARIOS["partial-failure"]()
    check("HB2-R a control exit other than 7 is still refused",
          receipt["passed"] is False and any("control command exited 15" in p for p in receipt["problems"]),
          json.dumps(receipt["problems"])[:200])


def main():
    test_hb10_gate()
    test_hb2r_split_channel()
    test_hb1()
    test_hb2()
    test_hb3()
    test_hb4()
    test_hb5()
    test_hb11_inspect_output()
    test_hb12_unhandled_failure_still_writes_a_receipt()
    test_receipts_and_versions()
    print("FAILURES=" + str(len(FAILURES)) + (" " + ",".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
