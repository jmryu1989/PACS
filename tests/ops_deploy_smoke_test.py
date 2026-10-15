"""C-BROWSER/C-SMOKE: supervisor facts and elapsed-time behavior, independent of implementation spelling.

Pure tests never start Docker or systemd. Linux real Chromium/cgroup tests are separate opt-in execution evidence.
"""
import json
import http.server
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "scripts"), str(Path(__file__).resolve().parent)]
import ops_emr_introduction as release
import ops_emr_introduction_test as fixtures


class SmokeDeadlineContracts(unittest.TestCase):
    def test_unconfirmed_command_tree_keeps_helper_unknown_without_cleanup_or_next_work(self):
        self.assert_unconfirmed_command_tree(release.Unknown("synthetic command tree still alive"))

    @unittest.skipUnless(os.name == "posix", "POSIX subprocess timeout has no Job tree proof")
    def test_posix_cli_timeout_does_not_claim_its_plugin_tree_is_terminal(self):
        self.assert_unconfirmed_command_tree(subprocess.TimeoutExpired(["docker", "compose"], 1))

    def assert_unconfirmed_command_tree(self, problem):
        fixture = fixtures.CommanderAdditionsTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        host, docker, context = fixture.unattended_host()
        def runner(args, **kwargs):
            if args[:2] == ["docker", "compose"] and "run" in args:
                worker, = context.state["workers"].values()
                docker.containers[worker["resource"]] = {"Id": "unreaped-helper", "State": {"Running": True, "Restarting": False},
                    "Config": {"Labels": {"kin.release.worker": worker["nonce"],
                                            "kin.emr-introduction": context.plan_sha256[:16]}}}
                raise problem
            return docker(args, **kwargs)
        host.run = runner
        def compose(args, **kwargs):
            return host.cmd(["docker", "compose", *args], timeout=kwargs["timeout"], env=kwargs["env"],
                            check=False, mutating=True)
        budget = release.SmokeBudget(30)
        token = release._smoke_budget.set(budget)
        try:
            with patch.object(host, "compose", side_effect=compose), self.assertRaises(release.Unknown):
                host.one_shot(context, "api", ["synthetic"], name="unreaped-client", timeout=30)
            worker, = context.state["workers"].values()
            self.assertEqual(worker["state"], "UNKNOWN")
            self.assertFalse(any(args[:2] in (["docker", "stop"], ["docker", "rm"]) for args in docker.calls))
            self.assertTrue(docker.containers[worker["resource"]]["State"]["Running"], "unconfirmed client must retain its helper")
            with self.assertRaises(release.Unknown):
                host.register_worker("compose-run", "forbidden-next", 10)
            commands = [json.loads(line) for path in fixture.records.directory.glob("commands-*.jsonl")
                        for line in path.read_text().splitlines()]
            outcome = "timeout" if isinstance(problem, subprocess.TimeoutExpired) else "unknown"
            self.assertTrue(any(row.get("outcome") == outcome and row.get("client_terminal") is False for row in commands))
        finally:
            release._smoke_budget.reset(token)

    def test_cancelled_helper_removes_its_secret_environment_or_is_unknown(self):
        for fail_remove in (False, True):
            with self.subTest(fail_remove=fail_remove):
                fixture = fixtures.CommanderAdditionsTests()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                host, docker, context = fixture.unattended_host()
                name = "kin-rehearsal-owned-smoke-helper"
                worker = host.register_worker("run", name, 30)
                worker["state"] = "UNKNOWN"
                docker.containers[name] = {"Id": "owned-helper", "State": {"Running": True, "Restarting": False},
                    "Config": {"Env": ["PASSWORD=synthetic-secret"], "Labels": {
                        "kin.release.worker": worker["nonce"], "kin.emr-introduction": context.plan_sha256[:16]}}}
                def runner(args, **kwargs):
                    if args[:2] == ["docker", "stop"]:
                        docker.containers[name]["State"].update(Running=False, Status="exited", ExitCode=137)
                    return docker(args, **kwargs)
                host.run = runner
                docker.failing = lambda args: fail_remove and args[:2] == ["docker", "rm"]
                budget = release.SmokeBudget(30)
                budget.work_end = time.monotonic() - 1
                token = release._smoke_budget.set(budget)
                try:
                    if fail_remove:
                        with self.assertRaises(release.Unknown):
                            host.cancel_smoke_helper(worker)
                        self.assertIn(name, docker.containers)
                        self.assertEqual(worker["state"], "UNKNOWN")
                    else:
                        host.cancel_smoke_helper(worker)
                        self.assertNotIn(name, docker.containers)
                        self.assertEqual(worker["state"], "QUIET")
                finally:
                    release._smoke_budget.reset(token)

    def test_logout_replay_trickle_uses_one_deadline(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.send_response(401)
                self.send_header("Content-Length", "10000")
                self.end_headers()
                try:
                    for _ in range(30):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.04)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        budget = release.SmokeBudget(0.6, cleanup=0.25)
        token = release._smoke_budget.set(budget)
        try:
            start = time.monotonic()
            with self.assertRaises((release.Stop, TimeoutError)):
                release.session_replay({"origin": "http://127.0.0.1:%d" % server.server_address[1]}, {"Cookie": "synthetic"})
            self.assertLess(time.monotonic() - start, 0.6)
        finally:
            release._smoke_budget.reset(token)

    def test_shared_budget_stops_new_subprocesses_after_work_deadline(self):
        with tempfile.TemporaryDirectory() as folder:
            fixture = fixtures.CommanderAdditionsTests()
            fixture.setUp()
            self.addCleanup(fixture.doCleanups)
            host, _, context = fixture.unattended_host()
            calls = []
            def runner(args, **kwargs):
                calls.append(kwargs["timeout"])
                return subprocess.run([sys.executable, "-c", "import time;time.sleep(10)"],
                                      timeout=kwargs["timeout"], capture_output=True)
            host.run = runner
            start = time.monotonic()
            budget = release.SmokeBudget(0.7, cleanup=0.25)
            token = release._smoke_budget.set(budget)
            try:
                with self.assertRaises(release.Stop):
                    host.cmd(["git", "status"], timeout=180)
                with self.assertRaises(release.Stop):
                    host.cmd(["git", "status"], timeout=180)
                self.assertEqual(len(calls), 1, "an expired attempt must not launch another command")
                self.assertLess(calls[0], 0.5)
                self.assertLess(time.monotonic() - start, 1.2)
                with budget.cleanup():
                    self.assertGreater(budget.remaining(), 0)
            finally:
                release._smoke_budget.reset(token)

    def test_slow_pagination_cannot_renew_the_attempt(self):
        calls = []
        def page(*args, **kwargs):
            calls.append(time.monotonic())
            time.sleep(0.06)
            return 200, "application/json", json.dumps({"studies": [], "pagination": {"next": str(len(calls))}}).encode()
        budget = release.SmokeBudget(0.35, cleanup=0.15)
        token = release._smoke_budget.set(budget)
        try:
            start = time.monotonic()
            with patch.object(release, "https_get", side_effect=page), self.assertRaises(release.Stop):
                release.worklist_row("https://smoke.invalid", "absent", pages=1000)
            self.assertLess(len(calls), 6)
            self.assertTrue(all(moment < budget.work_end for moment in calls))
            self.assertLess(time.monotonic() - start, 0.5)
        finally:
            release._smoke_budget.reset(token)

    @unittest.skipUnless(os.name == "nt", "Windows Job execution")
    def test_windows_job_hang_has_one_cleanup_deadline(self):
        start = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            release.run_tree([sys.executable, "-c", "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);time.sleep(60)"],
                             input=b"", timeout=0.5, deadline=start + 1.5)
        self.assertLess(time.monotonic() - start, 2)

    @unittest.skipUnless(os.name == "nt", "Windows command Job execution")
    def test_command_plugin_cannot_hold_pipes_past_the_smoke_deadline(self):
        import ctypes
        from ctypes import wintypes
        code = ("import subprocess,sys,time;from pathlib import Path;"
                "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);"
                "Path('child-pid').write_text(str(child.pid));time.sleep(60)")
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        with tempfile.TemporaryDirectory() as folder:
            # Start the real Job-contained plugin before measuring the command deadline. Python startup under
            # the full matrix's load is not the timeout behavior this test is checking.
            tree = release._ProcessTree([sys.executable, "-c", code], cwd=folder)
            handle, token = None, None
            try:
                ready_by = time.monotonic() + 30
                while handle is None and time.monotonic() < ready_by:
                    try:
                        pid = int((Path(folder) / "child-pid").read_text())
                        handle = kernel.OpenProcess(0x00100000, False, pid) or None
                    except (OSError, ValueError):
                        pass
                    if handle is None:
                        time.sleep(0.01)
                self.assertIsNotNone(handle, "plugin must be observed alive before the deadline starts")
                budget = release.SmokeBudget(3, cleanup=2)
                token = release._smoke_budget.set(budget)
                start = time.monotonic()
                with patch.object(release, "_ProcessTree", return_value=tree), self.assertRaises(subprocess.TimeoutExpired):
                    release.Runner(folder)(["docker", "compose", "run", "synthetic"], timeout=0.75)
                self.assertLess(time.monotonic() - start, 3.5)
                remaining_ms = int(max(0, budget.end - time.monotonic()) * 1000)
                self.assertEqual(kernel.WaitForSingleObject(handle, remaining_ms), 0, "plugin must exit in the same budget")
            finally:
                tree.kill()
                tree.process.wait(timeout=10)
                tree.gone(seconds=10)
                if handle:
                    kernel.CloseHandle(handle)
                if token is not None:
                    release._smoke_budget.reset(token)

    @unittest.skipUnless(os.name == "nt", "Windows command Job execution")
    def test_command_job_preserves_working_directory_environment_and_binary_streams(self):
        original_popen = subprocess.Popen
        code = ("import json,os,sys;from pathlib import Path;"
                "print(json.dumps([str(Path.cwd()),os.environ['KIN_SYNTHETIC_VALUE'],sys.stdin.buffer.read().hex()]));"
                "sys.stderr.buffer.write(b'child-stderr')")
        def executable(argv, **options):
            self.assertEqual(argv, ["docker", "synthetic"])
            return original_popen([sys.executable, "-c", code], **options)
        with tempfile.TemporaryDirectory() as folder:
            payload = b"\x00\xff\r\nUTF8:\xed\x95\x9c"
            for source in ("input", "file"):
                with self.subTest(source=source), tempfile.TemporaryFile() as incoming, tempfile.TemporaryFile() as outgoing:
                    incoming.write(payload)
                    incoming.seek(0)
                    with patch.object(release.subprocess, "Popen", side_effect=executable):
                        result = release.Runner(folder)(["docker", "synthetic"], timeout=5,
                            env={"KIN_SYNTHETIC_VALUE": "kept"}, output=outgoing,
                            **({"input": payload} if source == "input" else {"stdin": incoming}))
                    self.assertEqual((result.returncode, result.stdout, result.stderr), (0, None, b"child-stderr"))
                    self.assertFalse(incoming.closed or outgoing.closed, "caller-owned streams remain usable")
                    outgoing.seek(0)
                    self.assertEqual(json.loads(outgoing.read()), [str(Path(folder)), "kept", payload.hex()])

    @unittest.skipUnless(os.name == "nt", "Windows Job execution")
    def test_failed_job_termination_returns_unknown_without_waiting_on_open_pipes(self):
        trees = []
        original = release._ProcessTree
        original_kill = original.kill
        def owned_tree(argv):
            tree = original(argv)
            trees.append(tree)
            return tree
        start = time.monotonic()
        try:
            with patch.object(release, "_ProcessTree", side_effect=owned_tree), \
                    patch.object(original, "kill", return_value=None), self.assertRaises(release.Unknown):
                release.run_tree([sys.executable, "-c", "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);time.sleep(30)"],
                                 input=b"", timeout=0.2, deadline=start + 0.8)
            self.assertLess(time.monotonic() - start, 1.5)
            self.assertGreater(trees[0].remaining(), 0)
        finally:
            for tree in trees:
                original_kill(tree)
                tree.process.communicate(timeout=3)
                self.assertTrue(tree.gone(seconds=3), "the test must reap its own injected survivors")

    def test_cleanup_exhaustion_is_unknown_and_keeps_profile(self):
        fixture = fixtures.CommanderAdditionsTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        host, _, context = fixture.unattended_host()
        profile = fixture.records.secret("browser-profile-retained")
        profile.mkdir()
        budget = release.SmokeBudget(0.15, cleanup=0.1)
        token = release._smoke_budget.set(budget)
        try:
            start = time.monotonic()
            with patch.object(release.shutil, "rmtree", return_value=None), self.assertRaises(release.Unknown):
                host.cleanup_browser_profile(profile)
            self.assertTrue(profile.exists())
            self.assertLess(time.monotonic() - start, 0.8)
        finally:
            release._smoke_budget.reset(token)

    def test_pending_worker_prevents_cleanup_and_next_account(self):
        fixture = fixtures.CommanderAdditionsTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        host, docker, context = fixture.unattended_host()
        profile = fixture.records.secret("browser-profile-retained")
        profile.mkdir()
        context.state["workers"] = {"unreaped": {"state": "UNKNOWN", "kind": "browser"}}
        before = list(docker.calls)
        with self.assertRaises(release.Unknown):
            host.cleanup_browser_profile(profile)
        with self.assertRaises(release.Unknown):
            host.remove_smoke_member_now(context)
        self.assertTrue(profile.is_dir())
        self.assertEqual(docker.calls, before)


class SystemdObservationContracts(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.unit = "kin-browser-" + "a" * 32 + ".service"
        self.group = "/system.slice/" + self.unit
        self.cg = self.root / "cgroup" / "system.slice" / self.unit
        self.cg.mkdir(parents=True)
        (self.cg / "cgroup.events").write_text("populated 0\nfrozen 0\n")
        self.worker = {"resource": self.unit, "state": "PLANNED"}
        self.values = {"Id": self.unit, "InvocationID": "b" * 32, "LoadState": "loaded", "ActiveState": "active",
                       "SubState": "exited", "Result": "success", "ExecMainCode": "1", "ExecMainStatus": "0",
                       "ExecMainPID": "100", "ControlGroup": self.group, "Type": "exec", "ExitType": "cgroup",
                       "KillMode": "control-group", "Restart": "no"}
        self.supervisor = release.SystemdBrowser(self.worker, None, lambda: None, release.SmokeBudget(30))
        self.supervisor.control = lambda *args: subprocess.CompletedProcess(args, 0,
            "\n".join(k + "=" + v for k, v in self.values.items()).encode(), b"")
        original = Path
        def filesystem(path):
            return {"/proc": self.proc, "/sys/fs/cgroup": self.root / "cgroup"}.get(str(path), original(path))
        patcher = patch.object(release, "Path", side_effect=filesystem)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_successful_main_does_not_hide_a_failed_service(self):
        class PrivateFiles:
            def __init__(self):
                self.files = {}
            def write_secret(self, name, value):
                self.files[name] = value
            def secret(self, name):
                return "/private/" + name
            def read_secret(self, name):
                return self.files[name]
            def discard_secret(self, name):
                del self.files[name]
        self.supervisor.records = PrivateFiles()
        for outcome, success in (("success", True), ("oom-kill", False), ("exit-code", False)):
            with self.subTest(outcome=outcome):
                self.values["Result"] = outcome
                present = True
                observed = self.supervisor.control
                def lifecycle(operation, *options):
                    nonlocal present
                    if not present:
                        return subprocess.CompletedProcess([], 1, b"", b"unit unloaded")
                    if operation == "stop":
                        present = False
                        return subprocess.CompletedProcess([], 0, b"", b"")
                    return observed(operation, *options)
                with patch.object(self.supervisor, "command", return_value=["/usr/bin/python3", "/protected/module.py", "browser-smoke"]), \
                        patch.object(self.supervisor, "control", side_effect=lifecycle), \
                        patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")):
                    code, _, _ = self.supervisor.run([], b"{}")
                self.assertEqual(code == 0, success)
                self.assertEqual(self.supervisor.records.files, {})

    def test_unit_result_cgroup_and_reaping_are_all_required(self):
        self.assertTrue(self.supervisor.observe())
        for field, value in (("SubState", "running"), ("ExecMainCode", "0")):
            previous = self.values[field]
            self.values[field] = value
            self.assertFalse(self.supervisor.observe())
            self.values[field] = previous
        (self.cg / "cgroup.events").write_text("populated 1\n")
        self.assertFalse(self.supervisor.observe())
        (self.cg / "cgroup.events").write_text("populated 0\n")
        task = self.proc / "101"
        task.mkdir()
        (task / "cgroup").write_text("0::" + self.group + " (deleted)\n")
        fields = ["Z"] + ["0"] * 18 + ["12345"]
        (task / "stat").write_text("101 (orphan chromium) " + " ".join(fields))
        self.assertFalse(self.supervisor.observe(), "populated=0 does not prove zombie reaping")
        (task / "stat").unlink()
        (task / "cgroup").unlink()
        task.rmdir()
        self.assertTrue(self.supervisor.observe())

    def test_replaced_unit_or_failed_query_never_proves_termination(self):
        self.assertTrue(self.supervisor.observe())
        self.values["InvocationID"] = "c" * 32
        with self.assertRaises(release.Stop):
            self.supervisor.observe()
        self.supervisor.control = lambda *args: subprocess.CompletedProcess(args, 1, b"", b"offline")
        with self.assertRaises(release.Stop):
            self.supervisor.observe()

    def test_disappeared_cgroup_requires_terminal_result_and_same_unit(self):
        self.assertTrue(self.supervisor.observe())
        (self.cg / "cgroup.events").unlink()
        self.cg.rmdir()
        self.values["ControlGroup"] = ""
        self.assertTrue(self.supervisor.observe())
        self.values["ExecMainCode"] = "0"
        self.assertFalse(self.supervisor.observe(), "absence without a terminal result is still pending")
        self.values["ExecMainCode"] = "1"
        self.assertTrue(self.supervisor.observe(), "the same invocation may finish after its cgroup disappears")


if __name__ == "__main__":
    unittest.main(verbosity=2)
