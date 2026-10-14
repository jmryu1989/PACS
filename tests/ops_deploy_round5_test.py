"""Binding r4 findings: external worker identities and observable release outcomes.

The Engine fixture implements request/response state per exec and container. It does not infer worker completion
from a Docker client exit, and deliberately keeps a healthcheck alive while the registered exec completes.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "scripts"), str(Path(__file__).resolve().parent)]
import ops_emr_introduction as release
import ops_emr_introduction_test as fixtures


class EngineFixture:
    def __init__(self, containers, execute):
        self.containers, self.execute = containers, execute
        self.execs = {}
        self.started = []

    def __call__(self, raw):
        head, data = raw.split(b"\r\n\r\n", 1)
        method, path, _ = head.split(b"\r\n")[0].decode().split()
        headers = dict(line.decode().split(": ", 1) for line in head.split(b"\r\n")[1:])
        size = int(headers["Content-Length"])
        body = json.loads(data[:size]) if size else None
        parts = path.split("/")[2:]
        status = 200
        if parts[0] == "containers":
            identity = "%064x" % (len(self.execs) + 1)
            self.execs[identity] = {"ID": identity, "ContainerID": parts[1], "Running": False, "ExitCode": None,
                                    "ProcessConfig": {"entrypoint": body["Cmd"][0], "arguments": body["Cmd"][1:]},
                                    "configuration": body}
            result, status = {"Id": identity}, 201
        elif parts[-1] == "json":
            result = self.execs.get(parts[1])
            if result is None:
                result, status = {"message": "No such exec"}, 404
        else:
            item = self.execs[parts[1]]
            item["Running"] = True
            self.started.append(item["ID"])
            config = item["configuration"]
            name = next(name for name, c in self.containers.items() if c["Id"] == item["ContainerID"])
            args = ["docker", "exec"]
            if config["AttachStdin"]:
                args += ["-i"]
            for key, flag in (("User", "-u"), ("WorkingDir", "-w")):
                if key in config:
                    args += [flag, config[key]]
            for value in config.get("Env", []):
                args += ["-e", value]
            result = self.execute([*args, name, *config["Cmd"]], input=data[size:] or None)
            item.update(Running=False, ExitCode=result.returncode)
            frames = b""
            for channel, value in ((1, result.stdout), (2, result.stderr)):
                value = value or b""
                frames += bytes([channel, 0, 0, 0]) + len(value).to_bytes(4, "big") + value
            return b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n" + frames
        encoded = json.dumps(result).encode()
        return (f"HTTP/1.1 {status} response\r\nContent-Length: {len(encoded)}\r\n\r\n").encode() + encoded


def succeeds(case, function, *args, **kwargs):
    """A supported positive control must complete; a product refusal is an assertion failure, not fixture drift."""
    try:
        return function(*args, **kwargs)
    except RuntimeError as error:
        case.fail("supported operation refused: " + str(error))


class ExecContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.records = release.Records(self.root / "records")
        self.records.begin("capture", "2" * 64)
        self.context = SimpleNamespace(plan_sha256="1" * 64, request_sha256="2" * 64, retrying=False,
                                       state={"workers": {}}, save=lambda: self.records.save(self.context.state))
        self.containers = {"db": {"Id": "d" * 64, "ExecIDs": ["f" * 64],
                                   "Config": {"Healthcheck": {"Test": ["CMD-SHELL", "pg_isready -U kin"]}}}}
        self.engine = EngineFixture(self.containers, self.execute)
        self.engine.execs["f" * 64] = {"ID": "f" * 64, "ContainerID": "d" * 64, "Running": True,
                                        "ProcessConfig": {"entrypoint": "/bin/sh", "arguments": ["-c", "pg_isready -U kin"]}}
        self.host = release.HostOps(target={"repository": str(self.root), "containers": {"db": "db"}}, plan={},
                                    runner=self.runner, records=self.records)
        self.host.intro = self.context
        self.reply = subprocess.CompletedProcess([], 0, b"ready\n", b"")

    def execute(self, args, **kwargs):
        workers = list(self.records.state()["workers"].values())
        self.assertIn(workers[-1]["exec_id"], self.engine.execs)
        self.assertEqual(workers[-1]["state"], "PLANNED")
        return self.reply

    def runner(self, args, **kwargs):
        if args[:3] == ["docker", "system", "dial-stdio"]:
            return subprocess.CompletedProcess(args, 0, self.engine(kwargs["input"]), b"")
        if args[:3] == ["docker", "container", "ls"]:
            return subprocess.CompletedProcess(args, 0, b"db\n", b"")
        if args[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(args, 0, json.dumps([self.containers[args[2]]]).encode(), b"")
        raise AssertionError(args)

    def test_registered_exec_completes_while_healthcheck_is_running_without_host_change(self):
        result = succeeds(self, self.host.cmd, ["docker", "exec", "db", "pg_isready"])
        self.assertEqual(result.stdout, b"ready\n")
        worker, = self.records.state()["workers"].values()
        self.assertEqual((worker["state"], worker["server_exit"]), ("QUIET", 0))
        self.assertNotEqual(worker["exec_id"], "f" * 64)
        self.assertFalse(self.context.state.get("host_changed", False))

    def test_foreign_long_exec_refuses_before_creating_our_exec(self):
        self.engine.execs["f" * 64]["ProcessConfig"] = {"entrypoint": "sleep", "arguments": ["600"]}
        with self.assertRaises(release.Stop):
            self.host.cmd(["docker", "exec", "db", "pg_isready"])
        self.assertEqual(self.engine.started, [])
        self.assertFalse(self.context.state.get("host_changed", False))

    def test_nonzero_server_exit_is_a_settled_refusal(self):
        self.reply = subprocess.CompletedProcess([], 17, b"", b"rejected\n")
        with self.assertRaises(release.Stop):
            self.host.cmd(["docker", "exec", "db", "pg_isready"])
        worker, = self.records.state()["workers"].values()
        self.assertEqual((worker["state"], worker["server_exit"]), ("QUIET", 17))

    def test_uncertain_own_exec_preserves_unknown_even_with_idle_container(self):
        self.containers["db"]["ExecIDs"] = []
        with patch.object(self.engine, "execute", side_effect=subprocess.TimeoutExpired("dial-stdio", 1)):
            with self.assertRaises(release.Unknown):
                self.host.cmd(["docker", "exec", "db", "psql"], timeout=1, mutating=True)
        worker, = self.records.state()["workers"].values()
        self.assertEqual(worker["state"], "UNKNOWN")
        self.assertTrue(self.context.state["host_changed"])
        with self.assertRaises(release.Unknown):
            self.host.cmd(["docker", "exec", "db", "pg_isready"])


class StateContracts(unittest.TestCase):
    def case(self, rehearsal=False):
        import ops_emr_introduction_test as fixtures
        case = fixtures.StateMachineTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        if rehearsal:
            case.kind = "rehearsal"
        return case

    def test_pending_observed_before_an_unchanged_admission_creates_a_durable_hold(self):
        case = self.case()
        snapshot = case.ops.snapshot
        def observed(context):
            case.ops.alive = ["foreign-running-instance"] if context.records.context.get("part") == "before" else []
            return snapshot(context)
        case.ops.snapshot = observed
        result = case.run_phase("capture")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual(result["steps"][0]["outcome"], "UNKNOWN")
        self.assertIsNotNone(case.records.state()["unknown_hold"])
        self.assertNotIn("checkout_mode", case.ops.calls)
        self.assertTrue(case.lock_held())

    def test_unexpected_mutation_failure_is_unknown_without_success_flags(self):
        case = self.case()
        case.ops.faults["checkout_mode"] = OSError("launch failed with an unknown end")
        result = case.run_phase("capture")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual(result["steps"][0]["outcome"], "UNKNOWN")
        self.assertIsNotNone(case.records.state()["unknown_hold"])
        self.assertTrue(case.lock_held())

    def test_running_database_without_readiness_refuses_unchanged_admission(self):
        case = self.case()
        snapshot = case.ops.snapshot

        def observed(context):
            value = snapshot(context)
            value["facts"]["database"]["value"]["ready"] = False
            return value

        case.ops.snapshot = observed
        result = case.run_phase("capture")
        self.assertFalse(result["phase_passed"])
        self.assertEqual(result["steps"][0]["outcome"], "STOP")
        self.assertEqual(case.ops.calls, [])
        self.assertFalse(case.lock_held())

    def test_unsettled_registered_worker_prevents_preparation_and_creates_a_hold(self):
        case = self.case()
        machine = case.machine()
        state = release.new_state(machine.plan_sha256, machine.plan)
        state["workers"] = {"previous-worker": {"kind": "exec", "state": "RUNNING", "exec_id": "pending-exec"}}
        case.records.save(state)
        prepared = []
        case.ops.prepare = lambda context: prepared.append(True)
        result = case.run_phase("capture")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual(prepared, [])
        self.assertEqual(case.ops.calls, [])
        self.assertIsInstance(case.records.state()["unknown_hold"], dict)
        self.assertTrue(case.lock_held())
        with self.assertRaises(release.Stop):
            case.run_phase("capture")

    def test_prepare_error_finishes_and_releases_unchanged_entry(self):
        case = self.case()
        case.ops.prepare = lambda context: (_ for _ in ()).throw(ValueError("malformed config"))
        result = case.run_phase("capture")
        self.assertFalse(result["phase_passed"])
        self.assertIsNone(case.records.state()["running"])
        self.assertFalse(case.lock_held())

    def test_backup_restore_and_smoke_unclassified_errors_hold_even_with_complete_facts(self):
        for phase, action, prior in (("capture", "capture_b0", None), ("capture", "restore_check_b0", None),
                                     ("verify", "fenced_smoke", "introduce"), ("rollback", "preserve_failed", "verify"),
                                     ("rollback_reopen", "fenced_previous_smoke", "verify")):
            with self.subTest(action=action):
                case = self.case()
                if prior:
                    case.deploy_through(prior)
                if phase == "rollback_reopen":
                    case.run_phase("rollback")
                case.ops.faults[action] = KeyError("unclassified partial operation")
                result = case.run_phase(phase)
                self.assertEqual(result["status"], "NEEDS_ATTENTION")
                self.assertEqual(result["steps"][-1]["outcome"], "UNKNOWN")
                self.assertIsNotNone(case.records.state()["unknown_hold"])
                self.assertTrue(case.lock_held())

    def test_fence_before_observation_refusal_releases_the_unchanged_entry(self):
        case = self.case()
        case.ops.checkout_mode = lambda context: {}
        case.ops.reconcile_checkout = lambda context: {}
        original = case.ops.snapshot
        def snapshot(context):
            result = original(context)
            if context.records.context == {"step": "L-04a", "part": "before"}:
                result["facts"]["database"] = {"outcome": "ERROR", "reason": "unavailable"}
            return result
        case.ops.snapshot = snapshot
        result = case.run_phase("capture")
        self.assertEqual(result["status"], "NEW")
        self.assertEqual(result["steps"][-1]["outcome"], "STOP")
        self.assertNotIn("fence", case.ops.calls)
        self.assertIsNone(case.records.state()["unknown_hold"])
        self.assertFalse(case.lock_held())

    def test_before_error_after_a_real_checkout_correction_keeps_the_hold(self):
        case = self.case()
        def correction(context):
            context.state["host_changed"] = True
            return {"corrected": "checkout mode"}
        case.ops.checkout_mode = correction
        original = case.ops.snapshot
        def snapshot(context):
            result = original(context)
            if context.records.context == {"step": "L-00b", "part": "before"}:
                result["facts"]["database"] = {"outcome": "ERROR", "reason": "unavailable"}
            return result
        case.ops.snapshot = snapshot
        result = case.run_phase("capture")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual(case.records.state()["unknown_hold"]["step"], "L-00b")
        self.assertNotIn("reconcile_checkout", case.ops.calls)
        self.assertTrue(case.lock_held())

    def test_finalization_cannot_publish_success_or_release_an_unknown_hold(self):
        case = self.case()
        case.ops.faults["checkout_mode"] = release.Unknown("unconfirmed correction")
        machine = case.machine()
        machine.run({"version": 1, "mode": release.MODE, "phase": "capture",
                     "plan_sha256": machine.plan_sha256, "nonce": "c" * 32}, "d" * 64)
        result = machine.finish("HELD", True, release=True)
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertFalse(result["phase_passed"])
        self.assertIsNotNone(case.records.state()["unknown_hold"])
        self.assertTrue(case.lock_held())

    def test_prepare_error_after_effect_records_unknown_and_keeps_lock(self):
        case = self.case()
        def prepare(context):
            context.state["host_changed"] = True
            raise OSError("partial preparation")
        case.ops.prepare = prepare
        result = case.run_phase("capture")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIsNone(case.records.state()["running"])
        self.assertIsNotNone(case.records.state()["unknown_hold"])
        self.assertTrue(case.lock_held())

    def test_retry_has_a_new_120_second_budget_capped_by_the_phase(self):
        import time
        case = self.case()
        machine = case.machine()
        machine.state = release.new_state(machine.plan_sha256, machine.plan)
        machine.phase = "verify"
        machine.deadline_left = lambda: 75
        observed = []
        case.ops.fenced_smoke = lambda context: observed.append(release.bounded_timeout(1000)) or {}
        machine.retry_step("fenced_smoke", release.Stop("temporary"))
        self.assertEqual(len(observed), 1)
        self.assertGreater(observed[0], 50)
        self.assertLessEqual(observed[0], 55)

    def test_permanent_smoke_refusal_is_not_retried(self):
        case = self.case()
        case.deploy_through("introduce")
        case.ops.faults["fenced_smoke"] = release.SmokeRefusal("credential policy refused")
        result = case.run_phase("verify")
        self.assertFalse(result["phase_passed"])
        self.assertEqual(case.ops.calls.count("fenced_smoke"), 1)
        self.assertIsNone(case.records.state().get("smoke_retry"))

    def test_unknown_smoke_never_retries_or_starts_rollback(self):
        case = self.case()
        case.deploy_through("introduce")
        case.ops.faults["fenced_smoke"] = release.Unknown("browser end is unobserved")
        result = case.run_phase("verify")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual(case.ops.calls.count("fenced_smoke"), 1)
        self.assertIsNone(case.records.state().get("smoke_retry"))
        self.assertIsInstance(case.records.state()["unknown_hold"], dict)
        self.assertFalse(case.records.state()["rollback_attempted"])
        self.assertNotIn("restore_b0", case.ops.calls)
        self.assertTrue(case.lock_held())

    def test_settled_failure_with_alive_or_unobservable_worker_blocks_every_later_phase(self):
        for problem in (["owned-helper-running"], OSError("daemon unavailable")):
            with self.subTest(problem=type(problem).__name__):
                case = self.case()
                case.deploy_through("introduce")
                case.ops.faults["fenced_smoke"] = release.SmokeRefusal("permanent login refusal")
                def pending(context):
                    if isinstance(problem, Exception):
                        raise problem
                    return problem
                case.ops.one_shots_alive = pending
                result = case.run_phase("verify")
                self.assertEqual(result["status"], "NEEDS_ATTENTION")
                hold = case.records.state()["unknown_hold"]
                self.assertIsInstance(hold, dict)
                self.assertEqual(hold["step"], "rollback-admission")
                self.assertFalse(case.records.state()["rollback_attempted"])
                calls = list(case.ops.calls)
                for phase in ("rollback", "release", "verify"):
                    with self.assertRaises(release.Stop):
                        case.run_phase(phase)
                self.assertEqual(case.ops.calls, calls)
                self.assertTrue(case.lock_held())

    def test_prepare_unexpected_exception_types_finish_without_a_stale_running_marker(self):
        for problem in (KeyError("missing"), subprocess.TimeoutExpired("inspect", 1)):
            with self.subTest(problem=type(problem).__name__):
                case = self.case()
                case.ops.prepare = lambda context: (_ for _ in ()).throw(problem)
                try:
                    result = case.run_phase("capture")
                except type(problem):
                    self.fail("the preparation error escaped without an entry outcome")
                self.assertFalse(result["phase_passed"])
                self.assertIsNone(case.records.state()["running"])
                self.assertFalse(case.lock_held())

    def test_operating_entry_classifies_unexpected_admission_exceptions(self):
        host = release.IntroductionHost.__new__(release.IntroductionHost)
        for problem in (KeyError("missing"), subprocess.TimeoutExpired("inspect", 1), OSError("not readable")):
            with self.subTest(problem=type(problem).__name__), patch.object(host, "execute_request", side_effect=problem):
                result = host.execute(b"{}")
                self.assertEqual(result["status"], "REJECTED")
                self.assertFalse(result["phase_passed"])

    @unittest.skipUnless(os.name == "posix", "systemd reentry observation runs in the Linux matrix")
    def test_reentry_observes_pending_browser_before_refusing_the_held_phase(self):
        case = self.case()
        case.deploy_through("introduce")
        state = case.records.state()
        state["unknown_hold"] = {"step": "browser", "reason": "previous observation failed"}
        state["workers"] = {"browser": {"kind": "browser", "state": "UNKNOWN",
                                        "resource": "kin-browser-" + "d" * 32 + ".service"}}
        case.records.save(state)
        host = release.HostOps(target={"repository": str(case.repository), "containers": {}}, plan={},
                               runner=lambda *a, **kw: None, records=case.records)
        case.ops.observe_pending_browsers = host.observe_pending_browsers
        calls = list(case.ops.calls)
        with patch.object(release.SystemdBrowser, "observe", return_value=True) as observed:
            with self.assertRaises(release.Stop):
                case.run_phase("rollback")
        self.assertEqual(observed.call_count, 1)
        worker = case.records.state()["workers"]["browser"]
        self.assertTrue(worker["reentry_observation"]["terminal_and_empty"])
        self.assertEqual(worker["state"], "UNKNOWN")
        self.assertEqual(case.records.state()["unknown_hold"], state["unknown_hold"])
        self.assertEqual(case.ops.calls, calls)

    def test_page_actions_receive_the_remaining_attempt_time(self):
        clock = [100.0]
        calls = []
        class Page:
            def __init__(self):
                self.context = SimpleNamespace(new_page=lambda: self)
                self.answers = iter([{"status": 200, "found": True, "patient": "synthetic", "modality": "CT"}, "CT"])
            def evaluate(self, *args):
                return next(self.answers)
            def set_default_timeout(self, *args):
                pass
            def set_default_navigation_timeout(self, *args):
                pass
            def close(self):
                pass
            def __getattr__(self, name):
                def action(*args, **kwargs):
                    left = (release._smoke_budget.get().work_end - clock[0]) * 1000
                    calls.append((name, kwargs.get("timeout"), left))
                    clock[0] += 0.05
                return action
        with patch.object(release.time, "monotonic", side_effect=lambda: clock[0]):
            with release.smoke_attempt(300, 30):
                page = Page()
                release.sign_in(page, {"username": "synthetic", "password": "synthetic"})
                result = release.product_screens_check(page, {"origin": "https://fixture.invalid", "study_uid": "1.2.3"}, "synthetic")
        self.assertTrue(all(result.values()), result)
        self.assertTrue({"click", "fill", "press"} <= {name for name, _, _ in calls})
        for name, timeout, left in calls:
            with self.subTest(action=name):
                self.assertIsNotNone(timeout)
                self.assertGreater(timeout, 0)
                self.assertLessEqual(timeout, left + 1)


class PolicyContracts(unittest.TestCase):
    def test_subject_and_http_credential_refusals_are_permanent(self):
        for code, subject in ((200, "other"), (401, "expected"), (403, "expected")):
            with self.subTest(code=code, subject=subject), patch.object(release, "health_check", return_value={}), \
                    patch.object(release, "https_get", return_value=(code, "application/json", json.dumps({"sub": subject}).encode())):
                with self.assertRaises(release.SmokeRefusal) as caught:
                    release.smoke("https://fixture.invalid", token={"subject": "expected", "access_token": "synthetic"},
                                  frame={"path": "/frame"}, worklist_uid="synthetic")
                self.assertFalse(caught.exception.retryable)

    def test_certificate_identity_failures_are_permanent_in_both_tls_transports(self):
        import ssl
        from unittest.mock import MagicMock
        context, sock = MagicMock(), MagicMock()
        context.wrap_socket.side_effect = ssl.SSLCertVerificationError("wrong SAN or chain")
        with patch.object(release.ssl, "create_default_context", return_value=context), \
                patch.object(release.socket, "create_connection", return_value=sock):
            for function in (lambda: release.verified_pin("fixture.invalid", 443, None, None),
                             lambda: release.PinnedHTTPS("127.0.0.1", 443, "fixture.invalid", context).connect()):
                with self.assertRaises(release.SmokeRefusal) as caught:
                    function()
                self.assertFalse(caught.exception.retryable)

    def policy(self):
        return {"browserFlow": "browser", "requiredActions": [], "passwordPolicy": "length(12) and digits(1) and lowerCase(1) and upperCase(1) and specialChars(1)",
                "executions": [{"providerId": "auth-cookie", "requirement": "ALTERNATIVE", "level": 0},
                               {"providerId": "auth-username-password-form", "requirement": "REQUIRED", "level": 1}]}

    def test_normal_and_permanently_incompatible_unattended_policies(self):
        import copy
        release.smoke_policy_valid(self.policy())
        changes = [lambda p: p.update(passwordPolicy="length(90)"),
                   lambda p: p["requiredActions"].append({"enabled": True, "defaultAction": True}),
                   lambda p: p["executions"].append({"providerId": "auth-otp-form", "requirement": "REQUIRED", "level": 1}),
                   lambda p: p["executions"].append({"providerId": "custom-authenticator", "requirement": "REQUIRED", "level": 1})]
        for change in changes:
            value = copy.deepcopy(self.policy())
            change(value)
            with self.subTest(policy=value), self.assertRaises(release.SmokeRefusal):
                release.smoke_policy_valid(value)

    def test_credential_generation_satisfies_the_admitted_character_classes(self):
        import re
        value = release.smoke_password()
        self.assertGreaterEqual(len(value), 40)
        for pattern in (r"[A-Z]", r"[a-z]", r"[0-9]", r"[^A-Za-z0-9]"):
            self.assertRegex(value, pattern)

    def test_keycloak_26_default_conditional_flow_and_single_policy_changes(self):
        policy = self.policy()
        policy["organizationsEnabled"] = False
        policy["executions"] = [
            {"authenticationFlow": True, "requirement": "CONDITIONAL", "level": 1},
            {"providerId": "conditional-user-configured", "requirement": "REQUIRED", "level": 2},
            {"providerId": "organization", "requirement": "ALTERNATIVE", "level": 2},
            {"providerId": "auth-username-password-form", "requirement": "REQUIRED", "level": 1},
            {"authenticationFlow": True, "requirement": "CONDITIONAL", "level": 1},
            {"providerId": "conditional-user-configured", "requirement": "REQUIRED", "level": 2},
            {"providerId": "conditional-credential", "requirement": "REQUIRED", "level": 2, "authenticationConfig": "fixture-config"},
            {"providerId": "auth-otp-form", "requirement": "ALTERNATIVE", "level": 2},
            {"providerId": "webauthn-authenticator", "requirement": "DISABLED", "level": 2},
        ]
        succeeds(self, release.smoke_policy_valid, policy)
        changes = [lambda p: p.update(organizationsEnabled=True), lambda p: p.pop("organizationsEnabled"),
                   lambda p: p["executions"][3].update(requirement="DISABLED"),
                   lambda p: p["executions"][5].update(requirement="DISABLED"),
                   lambda p: p["executions"].append({"providerId": "conditional-credential", "requirement": "REQUIRED", "level": 0})]
        for index, change in enumerate(changes):
            altered = copy.deepcopy(policy)
            change(altered)
            with self.subTest(change=index), self.assertRaises(release.SmokeRefusal):
                release.smoke_policy_valid(altered)

class SupervisorContracts(unittest.TestCase):
    def test_supervisor_failure_keeps_browser_unknown_profile_and_next_launch_blocked(self):
        problems = [release.Unknown("supervisor response cannot prove termination"),
                    OSError("supervisor transport failed after launch")]
        if os.name == "posix":
            problems.append(subprocess.TimeoutExpired("systemctl", 1))
        for problem in problems:
            with self.subTest(problem=type(problem).__name__):
                self.assert_supervisor_failure_preserves_profile_and_hold(problem)

    def assert_supervisor_failure_preserves_profile_and_hold(self, problem):
        import ops_emr_introduction_test as fixtures
        case = fixtures.CommanderAdditionsTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        host, _, context = case.unattended_host()
        profile = host.records.secret("profile-transport-error")
        profile.mkdir()
        (profile / "Cookies").write_text("synthetic")
        runner = patch.object(release.SystemdBrowser, "run", side_effect=problem) if os.name == "posix" else \
                 patch.object(release, "run_tree", side_effect=problem)
        with patch.object(release.SystemdBrowser, "command"), runner:
            try:
                host.run_browser({"profile_dir": str(profile)})
            except Exception as error:
                self.assertIsInstance(error, release.Unknown)
            else:
                self.fail("supervisor timeout was accepted")
        worker = [w for w in context.state["workers"].values() if w["kind"] == "browser"][-1]
        self.assertEqual(worker["state"], "UNKNOWN")
        with self.assertRaises(release.Unknown):
            host.cleanup_browser_profile(profile)
        self.assertTrue(profile.exists())
        with self.assertRaises(release.Unknown):
            host.register_worker("browser", "kin-browser-" + "f" * 32 + ".service", 10)

    def test_hung_systemctl_cannot_be_reported_as_browser_timeout(self):
        worker = {"resource": "kin-browser-" + "a" * 32 + ".service", "state": "RUNNING"}
        supervisor = release.SystemdBrowser(worker, None, lambda: None, release.SmokeBudget(30))
        with patch.object(release.subprocess, "run", side_effect=subprocess.TimeoutExpired("systemctl", 1)):
            try:
                supervisor.control("show")
            except Exception as error:
                self.assertIsInstance(error, release.Unknown)
            else:
                self.fail("hung supervisor was accepted")
        self.assertEqual(worker["observation_error"]["location"], "systemctl-show")
        self.assertEqual(worker["observation_error"]["type"], "TimeoutExpired")

    def test_cgroup_vanish_during_terminal_observation_is_not_an_error(self):
        from ops_deploy_smoke_test import SystemdObservationContracts
        case = SystemdObservationContracts()
        case.setUp()
        self.addCleanup(case.doCleanups)
        self.assertTrue(case.supervisor.observe())
        (case.cg / "cgroup.events").unlink()
        self.assertTrue(case.supervisor.observe())
        case.values["SubState"] = "running"
        self.assertFalse(case.supervisor.observe())

    def test_offlined_cgroup_requires_a_fresh_observation_before_quiet(self):
        import errno
        from ops_deploy_smoke_test import SystemdObservationContracts
        case = SystemdObservationContracts()
        case.setUp()
        self.addCleanup(case.doCleanups)
        read_text = Path.read_text

        def offlined(path, *args, **kwargs):
            if path == case.cg / "cgroup.events":
                raise OSError(errno.ENODEV, "synthetic offlined kernfs node")
            return read_text(path, *args, **kwargs)

        with patch.object(Path, "read_text", offlined):
            for state in ("running", "exited"):
                case.values["SubState"] = state
                try:
                    quiet = case.supervisor.observe()
                except OSError as error:
                    self.fail("an offlined cgroup must remain pending for a fresh observation: " + str(error))
                self.assertFalse(quiet,
                                 "an offline read cannot prove quiet, including a terminal unit")
        self.assertEqual(case.supervisor.worker["cgroup_read_retry"]["count"], 2)
        self.assertEqual(case.supervisor.worker["cgroup_read_retry"]["errno"], errno.ENODEV)
        self.assertNotIn("observation_error", case.supervisor.worker)
        (case.cg / "cgroup.events").unlink()
        self.assertTrue(case.supervisor.observe(), "fresh terminal identity and absence now prove quiet")

    def test_other_cgroup_io_errors_remain_unconfirmed_and_record_the_location(self):
        import errno
        from ops_deploy_smoke_test import SystemdObservationContracts
        case = SystemdObservationContracts()
        case.setUp()
        self.addCleanup(case.doCleanups)
        read_text = Path.read_text
        for number in (errno.EACCES, errno.EIO):
            def unreadable(path, *args, **kwargs):
                if path == case.cg / "cgroup.events":
                    raise OSError(number, "synthetic observation failure")
                return read_text(path, *args, **kwargs)

            with self.subTest(errno=number), patch.object(Path, "read_text", unreadable):
                with self.assertRaises(OSError):
                    case.supervisor.observe()
            error = case.supervisor.worker["observation_errors"][-1]
            self.assertEqual((error["location"], error["errno"]), ("cgroup-events", number))


    def test_service_runtime_limit_is_sent_to_the_independent_supervisor(self):
        files = {}
        records = SimpleNamespace(write_secret=lambda n,v: files.__setitem__(n,v), secret=lambda n: "/private/" + n,
                                  read_secret=files.__getitem__, discard_secret=files.pop)
        worker = {"resource": "kin-browser-" + "b" * 32 + ".service", "main_status": 0, "main_code": 1, "unit_result": "success"}
        supervisor = release.SystemdBrowser(worker, records, lambda: None, release.SmokeBudget(75))
        with patch.object(supervisor, "command", return_value=["/usr/bin/python3", "/protected/tool.py", "browser-smoke"]), \
                patch.object(supervisor, "observe", return_value=True), \
                patch.object(supervisor, "control", return_value=subprocess.CompletedProcess([],0,b"",b"")), \
                patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([],0,b"",b"")) as launch:
            supervisor.run([], b"{}")
        props = dict(value[len("--property="):].split("=",1) for value in launch.call_args.args[0] if value.startswith("--property="))
        self.assertIn("RuntimeMaxSec", props)
        self.assertLessEqual(float(props["RuntimeMaxSec"].rstrip("s")), 55)
        self.assertEqual(props["KillMode"], "control-group")
        self.assertEqual(props["ExitType"], "cgroup")


class HostContracts(unittest.TestCase):
    def host(self, baseline=False):
        import ops_emr_introduction_test as fixtures
        case = fixtures.RoundThreeHostTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        host, docker, context = case.baseline_host() if baseline else case.host()
        return fixtures, case, host, docker, context

    def test_owned_restore_server_has_create_ready_and_absent_cleanup_observations(self):
        _, _, host, docker, context = self.host()
        host.intro = context
        name = "kin-rehearsal-owned-server"
        succeeds(self, host.cmd, ["docker", "run", "-d", "--name", name, "--network", "none", "postgres:16-alpine"])
        server = next(row for row in context.state["workers"].values() if row["resource"] == name)
        self.assertEqual((server["kind"], server["state"]), ("server", "SERVING"))
        self.assertTrue(server["container_id"])
        self.assertTrue(server["created_at"])
        host.cmd(["docker", "exec", name, "pg_isready"])
        self.assertTrue(server["ready"]["exec_id"])
        host.cmd(["docker", "rm", "-f", "-v", name])
        self.assertEqual(server["state"], "QUIET")
        self.assertTrue(server["resource_absent"])
        self.assertNotIn(name, docker.containers)
        self.assertFalse(context.state.get("host_changed", False))

    def test_completed_read_only_helper_does_not_claim_host_change(self):
        _, _, host, _, context = self.host()
        host.intro = context
        host.cmd(["docker", "run", "--rm", "--name", "kin-rehearsal-inspection", "nginx:alpine", "true"])
        self.assertFalse(context.state.get("host_changed", False))
        self.assertTrue(all(w["state"] == "QUIET" for w in context.state["workers"].values()))

    def test_supervised_auto_remove_helper_reclaims_its_anonymous_volume(self):
        _, _, host, docker, context = self.host()
        host.intro = context
        original = host.run
        anonymous_volumes = set()
        name = "kin-rehearsal-volume-helper"

        def daemon(args, **kwargs):
            result = original(args, **kwargs)
            if args[:2] == ["docker", "run"]:
                anonymous_volumes.add(name)
            if args[:2] == ["docker", "rm"] and ("-v" in args or "--volumes" in args):
                anonymous_volumes.discard(name)
            return result

        host.run = daemon
        succeeds(self, host.cmd, ["docker", "run", "--rm", "--name", name, "postgres:16-alpine", "true"])
        self.assertNotIn(name, docker.containers)
        self.assertEqual(anonymous_volumes, set(), "--rm also reclaims image-created anonymous storage")
        self.assertFalse(context.state.get("host_changed", False))

    def test_bind_propagation_and_both_tmpfs_representations_are_checked(self):
        import copy
        fixtures, _, host, docker, context = self.host()
        target, plan = host.t, context.plan
        config = fixtures.compose_config(target, previous_images=plan["previous"]["images"])
        docker.config["pinned"] = config
        model = host.resolved(context, maintenance=False)
        actual = {role: fixtures.running_from(config, role, plan["previous"]["images"][role]) for role in ("db", "api", "keycloak", "orthanc", "proxy")}
        binds = [(role, index) for role, item in actual.items() for index, mount in enumerate(item["Mounts"]) if mount["Type"] == "bind"]
        self.assertTrue(binds)
        for mode in ("rprivate", "rslave"):
            for role, index in binds:
                actual[role]["Mounts"][index]["Propagation"] = mode
            succeeds(self, release.check_running, actual, model, target)
        actual[binds[0][0]]["Mounts"][binds[0][1]]["Propagation"] = "rshared"
        with self.assertRaises(release.Stop):
            release.check_running(actual, model, target)
        actual[binds[0][0]]["Mounts"][binds[0][1]]["Propagation"] = "rslave"
        actual["proxy"]["HostConfig"]["Tmpfs"] = {"/scratch": "rw,size=1048576"}
        with self.assertRaises(release.Stop):
            release.check_running(actual, model, target)
        model.setdefault("tmpfs", {})["proxy"] = ["/scratch:rw,size=1m"]
        release.check_running(actual, model, target)
        for wrong in ({}, {"/scratch": "ro,size=1048576"}, {"/scratch": "rw,size=2097152"}):
            actual["proxy"]["HostConfig"]["Tmpfs"] = wrong
            with self.subTest(tmpfs=wrong), self.assertRaises(release.Stop):
                release.check_running(actual, model, target)


    def test_rb00_reads_crontab_and_refuses_open_jobs_before_restore(self):
        import ops_backup_held_test as held
        with tempfile.TemporaryDirectory() as root:
            source = held.FakeHost(root)
            b0 = source.capture()
            fixtures, case, host, docker, context = self.host(baseline=True)
            context.plan["backup_root"] = root
            context.plan["budget"]["min_free_bytes"] = 0
            context.state.update(db_changed=True, ponr=None, recovery_reopen=None, unknown_hold=None, rollback_attempted=False,
                b0={"dir": str(b0), "manifest_sha256": release.sha256_bytes((b0 / "manifest.json").read_bytes()), "restore_check": {"success": True}})
            host.hold(b0, context.plan_sha256, True)
            for name, item in docker.containers.items():
                item["State"]["Running"] = name == host.names["db"]
            docker.psql["pg_stat_activity"] = "0"
            docker.crontab = "".join("0 3 * * * /bin/true # " + tag + "\n" for tag in host.t["cron"]["tags"])
            with patch.object(host, "stop_writers"), self.assertRaises(RuntimeError) as refused:
                host.classify(context)
            self.assertTrue(any(call[:1] == ["crontab"] and call[-1] == "-l" for call in docker.calls), str(refused.exception))
            self.assertFalse(context.state["rollback_attempted"])

    def test_running_but_unready_database_is_not_a_ready_snapshot(self):
        _, _, host, docker, context = self.host(baseline=True)
        docker.containers[host.names["db"]]["State"].update(Running=True, Health={"Status": "starting"})
        ready = []
        def wait(predicate, seconds, message):
            ready.append(predicate())
            if not ready[-1]:
                raise release.Stop(message)
        with patch.object(host, "wait", side_effect=wait), self.assertRaises(release.Stop):
            host.db_ready(1, "not ready")
        self.assertEqual(ready, [False])

    def test_previous_smoke_cannot_start_outside_the_shared_phase_deadline(self):
        _, _, host, _, context = self.host()
        context.deadline_left = lambda: 0.01
        with patch.object(host, "token_since") as login, self.assertRaises(release.Stop):
            host.fenced_previous_smoke(context)
        login.assert_not_called()

    def test_snapshot_refuses_a_running_database_that_rejects_connections(self):
        _, _, host, _, context = self.host(baseline=True)
        original = host.cmd
        readiness = []

        def command(args, **kwargs):
            if "pg_isready" in args:
                readiness.append(list(args))
                return subprocess.CompletedProcess(args, 1, b"rejecting connections", b"")
            return original(args, **kwargs)

        with patch.object(host, "cmd", side_effect=command):
            observed = host.snapshot(context)
        self.assertEqual(len(readiness), 1)
        self.assertEqual(observed["facts"]["database"]["outcome"], "ERROR")


class RestoreBodyContracts(unittest.TestCase):
    def test_rollback_compares_the_actual_held_capture_count_format(self):
        import contextlib
        import copy
        import ops_backup_held_test as held
        import ops_emr_introduction_test as fixtures
        with tempfile.TemporaryDirectory() as root:
            source = held.FakeHost(root)
            b0 = source.capture()
            manifest = json.loads((b0 / "manifest.json").read_text())
            values = json.loads((b0 / "values.json").read_text())
            projection = json.loads((b0 / "projection.json").read_text())
            context = SimpleNamespace(plan=fixtures.plan_fixture(), plan_sha256="a" * 64, save=lambda: None,
                state={"b0": {"dir": str(b0), "manifest_sha256": release.sha256_bytes((b0 / "manifest.json").read_bytes())}, "checkout": "previous"},
                records=SimpleNamespace(put=lambda *args: None))
            self.assertEqual(set(manifest["counts"]), {"kin", "keycloak"})
            self.assertTrue(all(isinstance(rows, list) for rows in manifest["counts"].values()))
            context.observe = lambda *args: {"schema": 1, "facts": {
                "database": release.absent(), "lock": {"outcome": "OK", "value": {"owned": True}},
                "fences": {"outcome": "OK", "value": {"writers": {}, "cron": "fenced", "ingress": "closed"}}}}
            host = release.HostOps(target={"repository": str(source.repo), "containers": {"db": "restore-db"}},
                plan=context.plan, runner=lambda *args, **kwargs: None, records=release.Records(Path(root) / "records"))
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(host, "bind", side_effect=contextlib.nullcontext))
                for name in ("write_env", "prepare", "remove_container", "db_ready", "compose", "cmd"):
                    stack.enter_context(patch.object(host, name))
                stack.enter_context(patch.object(host, "compose_digest_now", return_value=context.plan["compose"]["before_sha256"]))
                stack.enter_context(patch.object(host, "pins", return_value="services: {}"))
                stack.enter_context(patch.object(host, "recovery_project", return_value="kin-rehearsal-rb"))
                stack.enter_context(patch.object(host, "volume_exists", return_value=False))
                stack.enter_context(patch.object(host, "inspect", return_value={"Mounts": [{"Destination": "/var/lib/postgresql/data", "Name": "kin-rehearsal-rb_pg-db"}]}))
                stack.enter_context(patch.object(host, "text", return_value='{"integrity":"ok"}'))
                stack.enter_context(patch.object(release, "workers_quiet", return_value=True))
                stack.enter_context(patch.object(release.ops, "restore_pre_snapshot", return_value={"catalog": "equal"}))
                captured = stack.enter_context(patch.object(release.ops, "value_catalog", return_value=values))
                stack.enter_context(patch.object(release.ops, "migration_rows", return_value=[[n, h, True, False] for n, h in context.plan["migrations"]["before"]]))
                stack.enter_context(patch.object(release.ops, "projection", return_value=projection))
                stack.enter_context(patch.object(release.ops, "role_catalog", return_value={"roles": [{"rolname": "kin"}]}))
                stack.enter_context(patch.object(release.ops, "counts", return_value={"public.Report": 2}))
                self.assertEqual(succeeds(self, host.restore_b0, context)["catalog"], {"catalog": "equal"})
                changed = copy.deepcopy(values)
                changed["tables"][0]["count"] += 1
                captured.side_effect = [values, changed]
                with self.assertRaises(release.Stop):
                    host.restore_b0(context)

class OperationalTargetContracts(unittest.TestCase):
    def targets(self):
        production = release.example_target()
        production["declared_overlays"][0]["sha256"] = "a" * 64
        rehearsal = copy.deepcopy(production)
        rehearsal.update(kind="rehearsal", repository="/srv/clone/repo", origin="https://localhost:19443",
                         host_key_sha256="b" * 64, project="kin-r5-operating", cron=None,
                         ports={"maintenance": "127.0.0.1:19444:443", "public": ["127.0.0.1:19443:443"]})
        for group in ("containers", "volumes", "networks"):
            rehearsal[group] = {key: "kin-r5-operating-" + group + "-" + key for key in rehearsal[group]}
        overlay = rehearsal["declared_overlays"][0]
        overlay["file"] = "/srv/clone/overlays/docker-compose.halo-reports.yml"
        overlay["binds"][0]["source"] = "/srv/clone/halo-reports/nginx/report.conf"
        rehearsal["compose_files"] = ["docker-compose.yml", "docker-compose.prod.yml", "/srv/clone/vm.yml",
                                      overlay["file"], "docker-compose.monitor.yml"]
        rehearsal["external_networks"] = {"proxy": {"halo_reports": "kin-r5-operating-halo"}}
        return production, rehearsal

    def test_production_identity_stays_fixed_and_rehearsal_uses_its_declared_identity(self):
        production, rehearsal = self.targets()
        for target in (production, rehearsal):
            self.assertEqual(succeeds(self, release.target_valid, target, operational=True), target)
        for field in ("overlay", "bind", "network"):
            with self.subTest(field=field):
                altered = copy.deepcopy(production)
                if field == "overlay":
                    altered["declared_overlays"][0]["file"] = rehearsal["declared_overlays"][0]["file"]
                    altered["compose_files"][2] = altered["declared_overlays"][0]["file"]
                elif field == "bind":
                    altered["declared_overlays"][0]["binds"][0]["source"] = "/srv/clone/report.conf"
                else:
                    altered["external_networks"]["proxy"]["halo_reports"] = "kin-r5-operating-halo"
                with self.assertRaises(release.Stop):
                    release.target_valid(altered, operational=True)

    def test_rehearsal_operating_entry_requires_order_monitor_and_one_ro_halo_binding(self):
        _, rehearsal = self.targets()
        for defect in ("order", "monitor", "extra-overlay", "writable", "destination", "network"):
            with self.subTest(defect=defect):
                altered = copy.deepcopy(rehearsal)
                if defect == "order":
                    altered["compose_files"][1:3] = reversed(altered["compose_files"][1:3])
                elif defect == "monitor":
                    altered["compose_files"].pop()
                elif defect == "extra-overlay":
                    overlay = copy.deepcopy(altered["declared_overlays"][0])
                    overlay["file"] = "/srv/clone/overlays/extra.yml"
                    altered["declared_overlays"].append(overlay)
                    altered["compose_files"].insert(-1, overlay["file"])
                elif defect == "writable":
                    altered["declared_overlays"][0]["binds"][0]["read_only"] = False
                elif defect == "destination":
                    altered["declared_overlays"][0]["binds"][0]["target"] = "/etc/nginx/conf.d/other.conf"
                else:
                    altered["external_networks"]["proxy"] = {"other_halo": "kin-r5-operating-halo"}
                with self.assertRaises(release.Stop):
                    release.target_valid(altered, operational=True)


class OperatingEntryContracts(unittest.TestCase):
    def test_refused_capture_restores_the_previous_finished_operating_entry(self):
        from ops_deploy_round4_test import OperatorEntryContracts
        import ops_emr_introduction_test as fixtures
        case = OperatorEntryContracts()
        case.setUp()
        self.addCleanup(case.doCleanups)
        entry = release.ComposeEntry(case.state / "compose-entries")
        previous = entry.load()[0]
        records = release.Records(case.state / "rejected-capture")
        records.begin("capture", "c" * 64)
        (case.repo / ".env").write_text("SYNTHETIC=1\n")
        for name in case.target["compose_files"]:
            path = case.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("services: {}\n")
        host = release.HostOps(target=case.target, plan=case.plan, runner=case.docker, records=records,
                               entry_root=entry.root)
        state = release.new_state("f" * 64, case.plan)
        context = SimpleNamespace(state=state, plan=case.plan, plan_sha256="f" * 64,
                                  save=lambda: records.save(state), retrying=False, request_sha256="c" * 64)
        host.intro = context
        host.prepare_entry(context)
        host.publish_entry(runtime="services: {}\n")
        self.assertNotEqual(entry.load()[0], previous)
        machine = release.Introduction.__new__(release.Introduction)
        machine.state, machine.ops, machine.records = state, host, records
        machine.phase, machine.request_sha256, machine.plan_sha256 = "capture", "c" * 64, "f" * 64
        machine.repository, machine.plan, machine.target = case.repo, case.plan, case.target
        machine.steps, machine.warnings = [], []
        machine.clock, machine.started = lambda: 1, 0
        machine.now = lambda: fixtures.NOW
        state["lock_token"] = release.acquire_lock(case.repo)
        succeeds(self, machine.finish, "NEW", False, release=True)
        self.assertEqual(entry.load()[0], previous)
        self.assertFalse(release.lock_path(case.repo).exists())
        succeeds(self, case.invoke, "config")
        result = succeeds(self, case.invoke, "recreate", "proxy")
        self.assertTrue(result["phase_passed"])

    def test_recreate_refuses_images_that_differ_from_the_finished_plan(self):
        from ops_deploy_round4_test import OperatorEntryContracts
        case = OperatorEntryContracts()
        case.setUp()
        self.addCleanup(case.doCleanups)
        wrong = "sha256:" + "f" * 64
        case.model["services"]["api"]["image"] = wrong
        case.docker.containers[case.target["containers"]["api"]]["Image"] = wrong
        with self.assertRaises(release.Stop):
            case.invoke("recreate", "api")
        self.assertEqual(case.mutations(), [])
        self.assertFalse(release.lock_path(case.repo).exists())


class CloneBodyContracts(unittest.TestCase):
    def test_clone_database_credentials_refuse_missing_shared_or_unsupported_inputs_before_change(self):
        for roles, supplied in [(["kin"], {}), (["kin"], {"POSTGRES_PASSWORD": "source-secret"}),
                                (["kin", "unknown"], {"POSTGRES_PASSWORD": "clone-secret"})]:
            with self.subTest(roles=roles, supplied=bool(supplied)), tempfile.TemporaryDirectory() as root:
                host = release.HostOps(target={"repository": root, "containers": {"db": "clone"}}, plan={},
                    runner=lambda *args, **kwargs: None, records=release.Records(Path(root) / "records"))
                with patch.object(host, "cmd") as command:
                    with self.assertRaises(release.Stop):
                        host.isolate_database_credentials({"login_verifiers": roles}, {"POSTGRES_PASSWORD": "source-secret"}, supplied)
                    command.assert_not_called()

    def test_keycloak_transform_body_compares_residual_fields_and_catalog(self):
        import contextlib
        import copy
        for defect in (None, "other-client-field", "catalog"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as root:
                rows = {"realm": (["id", "name"], [["realm-id", "kin"]]),
                    "client": (["id", "realm_id", "client_id", "secret", "root_url", "base_url", "management_url", "other"],
                               [["client-id", "realm-id", "kin-web", "old-secret", "https://source.invalid", None, None, "kept"]]),
                    "redirect_uris": (["client_id", "value"], [["client-id", "https://source.invalid/*"]]),
                    "web_origins": (["client_id", "value"], [["client-id", "https://source.invalid"]]),
                    "realm_smtp_config": (["realm_id", "name", "value"], [["realm-id", "host", "source-mail.invalid"]]),
                    "identity_provider": (["realm_id", "internal_id", "enabled"], [["realm-id", "idp-id", "true"]])}
                catalog = {"privileges": "kept"}
                host = release.HostOps(target={"repository": root, "containers": {"db": "clone"}, "origin": "https://clone.invalid"},
                    plan={}, runner=lambda *args, **kwargs: None, records=release.Records(Path(root) / "records"))
                context = SimpleNamespace(plan={"previous": {"images": {"keycloak": "pinned"}}})
                def values(container, transform=None):
                    tables = []
                    for name, (columns, data) in sorted(rows.items()):
                        key = ("keycloak", "public", "table", name, None)
                        tables.append(release.ops.value_digest(key, columns, transform(key, columns, data) if transform else data))
                    return {"version": release.ops.RESTORE_INVENTORY, "tables": tables}
                def mutate(*args, **kwargs):
                    rows["client"][1][0][3:5] = ["new-secret", "https://clone.invalid"]
                    rows["redirect_uris"][1][0][1] = "https://clone.invalid/*"
                    rows["web_origins"][1][0][1] = "https://clone.invalid"
                    rows["realm_smtp_config"][1].clear()
                    rows["identity_provider"][1][0][2] = "false"
                    if defect == "other-client-field":
                        rows["client"][1][0][-1] = "lost"
                    if defect == "catalog":
                        catalog["privileges"] = "lost"
                with patch.object(host, "bind", side_effect=contextlib.nullcontext), \
                        patch.object(host, "text", return_value="Keycloak 26.7.3"), patch.object(host, "cmd", side_effect=mutate), \
                        patch.object(release.ops, "value_rows", side_effect=lambda c,d,s,t: copy.deepcopy(rows[t])), \
                        patch.object(release.ops, "value_catalog", side_effect=values), \
                        patch.object(release.ops, "cluster_catalog", side_effect=lambda c: dict(catalog)):
                    action = lambda: host.keycloak_isolation(context, {"KC_WEB_SECRET": "old-secret"}, {"KC_WEB_SECRET": "new-secret"}, "https://source.invalid")
                    if defect:
                        with self.assertRaises(release.Stop):
                            action()
                    else:
                        self.assertEqual(action()["residual_values"], "equal")

    def test_seed_body_compares_catalog_after_transform_and_residual_values_after_admin(self):
        import contextlib
        import copy
        import ops_backup_held_test as held
        import ops_emr_introduction_test as fixtures
        from ops_backup_restore_test import CloneContracts
        for defect in (None, "transform-catalog", "admin-catalog", "admin-residual"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as root:
                source = held.FakeHost(root)
                seed = source.capture()
                source_values = json.loads((seed / "values.json").read_text())
                catalog = json.loads((seed / "catalog.json").read_text())
                projection = json.loads((seed / "projection.json").read_text())
                before, after = CloneContracts().admin_fixture()
                phase = ["before"]
                login_credentials = ["source"]
                context = SimpleNamespace(plan=fixtures.plan_fixture(kind="rehearsal"), state={}, save=lambda: None)
                context.plan["seed"].update(b0_dir=str(seed), b0_manifest_sha256=release.sha256_bytes((seed / "manifest.json").read_bytes()))
                host = release.HostOps(target={"repository": str(source.repo), "containers": {"db": "clone"},
                                              "keycloak_admin": "clone-admin", "volumes": {"orthanc": "kin-rehearsal-o"}},
                    plan=context.plan, runner=lambda *args, **kwargs: None, records=release.Records(Path(root) / "records"))
                def isolation(*args):
                    phase[0] = "transformed"
                    return {}
                def bootstrap(*args, **kwargs):
                    self.assertEqual(login_credentials[0], "clone", "the cloned service must be able to authenticate")
                    phase[0] = "admin"
                    return {"exit": 0, "container_exit": 0, "logs": []}
                def isolate_credentials(*args):
                    login_credentials[0] = "clone"
                    return ["kin"]
                def catalog_now(container):
                    return {**catalog, "unexpected": True} if defect == phase[0] + "-catalog" or (defect == "transform-catalog" and phase[0] == "transformed") else catalog
                def values(container, transform=None):
                    result = copy.deepcopy(source_values)
                    if defect == "admin-residual" and phase[0] == "admin":
                        result["tables"][0]["sha256"] = "0" * 64
                    return result
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(host, "bind", side_effect=contextlib.nullcontext))
                    for name in ("compose", "cmd", "db_ready", "pins"):
                        stack.enter_context(patch.object(host, name))
                    stack.enter_context(patch.object(host, "keycloak_isolation", side_effect=isolation))
                    stack.enter_context(patch.object(host, "isolate_database_credentials", side_effect=isolate_credentials))
                    stack.enter_context(patch.object(host, "one_shot", side_effect=bootstrap))
                    stack.enter_context(patch.object(release.ops, "restore_pre_snapshot", return_value={"catalog": "equal"}))
                    stack.enter_context(patch.object(release.ops, "value_catalog", side_effect=values))
                    stack.enter_context(patch.object(release.ops, "cluster_catalog", side_effect=catalog_now))
                    stack.enter_context(patch.object(release.ops, "psql_json", side_effect=[["master"], ["admin", "default"]]))
                    stack.enter_context(patch.object(release.ops, "value_rows", side_effect=lambda c,d,s,t: copy.deepcopy((after if phase[0] == "admin" else before)[t])))
                    stack.enter_context(patch.object(release.ops, "migration_rows", return_value=[[n,h,True,False] for n,h in context.plan["migrations"]["before"]]))
                    stack.enter_context(patch.object(release.ops, "projection", return_value=projection))
                    stack.enter_context(patch.object(release.time, "time", return_value=100))
                    if defect:
                        with self.assertRaises(release.Stop):
                            host.seed_restore(context)
                    else:
                        self.assertEqual(host.seed_restore(context)["isolation"]["administrator"]["residual_values"], "equal")


class WindowsJobContracts(unittest.TestCase):
    @unittest.skipUnless(__import__("os").name == "nt", "Windows Job kernel contract")
    def test_closing_the_last_job_handle_terminates_its_process(self):
        import ctypes
        import sys
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        tree = release._ProcessTree([sys.executable, "-c", "import time;time.sleep(60)"])
        handle = int(tree.process._handle)
        try:
            tree.kernel32.CloseHandle(tree.job)
            tree.job = None
            self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0, "entry handle loss must terminate the Job")
        finally:
            tree.process.kill()
            tree.process.wait(timeout=10)
            for stream in (tree.process.stdin, tree.process.stdout, tree.process.stderr):
                stream.close()

    @unittest.skipUnless(__import__("os").name == "nt", "Windows Job kernel contract")
    def test_breakaway_child_creation_is_refused_by_the_job(self):
        import sys
        import os
        code = """import subprocess,sys
try:
 p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],creationflags=0x01000000)
 print('ESCAPED '+str(p.pid),flush=True)
 p.terminate();p.wait()
except OSError as error:
 print('REFUSED '+str(error.winerror),flush=True)
"""
        result = release.run_tree([sys.executable, "-c", code], input=None, timeout=20)
        self.assertEqual(result[0], 0)
        self.assertEqual(result[1].strip(), b"REFUSED 5", "children cannot opt out of the owning Job")


if __name__ == "__main__":
    unittest.main()
