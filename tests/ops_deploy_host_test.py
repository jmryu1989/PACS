"""Protected host contracts. Synthetic approvals/data/SMTP; real Git, UID and TLS.

Run Linux checks as root only in an isolated rehearsal. Fixed-path installation
requires KIN_TEST_ISOLATED_INSTALL=1 inside the disposable test container.
"""
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops
import ops_deploy_host as host
import ops_deploy_runner as runner
from ops_deploy_runner_test import SyntheticHost

FRAME = b"synthetic-frame-only\x00\xff"


def private(path, raw):
    path.write_bytes(raw)
    path.chmod(0o600)
    return path


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def policy_fixture(repository, state):
    for name in host.DIRS:
        (state / name).mkdir(mode=0o700)
    token = private(state / "token.json", encoded({"access_token": "synthetic.token", "subject": "fixture"}))
    mail = private(state / "mail.env", b"HANMAIL_USER=fixture@example.invalid\nHANMAIL_APP_PW=synthetic-only\n")
    private(state / "mail-budget.json", encoded({"day": int(time.time()) // 86400, "attempts": 0, "last_attempt": 0}))
    private(repository / ".env", b"# synthetic configuration only\n")
    return {"schema": 1, "enabled": True, "repository": str(repository), "state_dir": str(state),
            "compose_sha256": host.compose_digest(repository), "origin": "https://127.0.0.1:1",
            "smoke": {"token_file": str(token), "frame_path": "/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/1",
                      "bytes": len(FRAME), "sha256": hashlib.sha256(FRAME).hexdigest(), "ca_file": None},
            "mail": {"credentials": str(mail), "recipient": "fixture@example.invalid"}}


def approve(state, plan):
    # Deliberately synthetic operator attestations. Never operational restore proof.
    hashes = []
    for kind in ("offsite-restore", "app-compatibility"):
        raw = encoded({"schema": 1, "kind": kind, "request_sha256": plan.request_sha256,
                       "passed": True, "evidence_sha256": hashlib.sha256(b"SYNTHETIC TEST ONLY").hexdigest()})
        digest = hashlib.sha256(raw).hexdigest()
        private(state / "evidence" / (digest + ".json"), raw)
        hashes.append(digest)
    path = state / "approvals" / (plan.request_sha256 + ".json")
    private(path, encoded({"schema": 1, "request_sha256": plan.request_sha256,
                          "expires_at": int(time.time()) + 3600,
                          "restore_sha256": hashes[0], "compatibility_sha256": hashes[1]}))
    return path


class PortableTests(unittest.TestCase):
    def test_01_duplicate_json_rejected(self):
        with self.assertRaises(RuntimeError):
            host.decode(b'{"enabled":true,"enabled":false}')

    def test_02_entry_refuses_nonisolated_interpreter(self):
        result = subprocess.run([sys.executable, str(Path(host.__file__).with_name("ops_deploy_entry.py"))],
                                input=b"secret-not-to-print", capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {"status": "REJECTED", "stage": "entry"})
        self.assertEqual(result.stdout, b"")

    def test_03_event_rejects_extra_content(self):
        plan = runner.Plan("a" * 64, "b" * 40, "c" * 40, "sha256:" + "d" * 64, "sha256:" + "e" * 64)
        event = runner.event_for(plan, "REJECTED", "authorize", False, "pending")
        host.event_valid(event)
        for field, value in (("raw_log", "private"), ("stage", "private"), ("event_id", "0" * 64)):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                host.event_valid({**event, field: value})

    def test_04_policy_rejects_paths_and_credential_urls(self):
        policy = {"schema": 1, "enabled": False, "repository": "/repo", "state_dir": "/state",
                  "compose_sha256": "a" * 64, "origin": "https://example.invalid",
                  "smoke": {"token_file": "/token", "frame_path": "/dicom-web/studies/1/series/2/instances/3/frames/1",
                            "bytes": 1, "sha256": "b" * 64, "ca_file": None},
                  "mail": {"credentials": "/mail", "recipient": "fixture@example.invalid"}}
        host.policy_valid(policy)
        for key, value in (("enabled", 1), ("origin", "https://user:pass@example.invalid"),
                           ("origin", "https://example.invalid/path"), ("repository", "relative"), ("command", "sh")):
            with self.subTest(key=key), self.assertRaises((RuntimeError, ValueError)):
                host.policy_valid({**policy, key: value})
        for key, value in (("frame_path", "/../secret"), ("bytes", True), ("bytes", host.MAX_FRAME + 1)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                host.policy_valid({**policy, "smoke": {**policy["smoke"], key: value}})


@unittest.skipUnless(os.name == "posix" and os.geteuid() == 0, "isolated Linux root fixture required")
class HostTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="kin-host-test-")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.repo, self.state = self.root / "repo", self.root / "state"
        self.repo.mkdir(mode=0o700)
        self.state.mkdir(mode=0o700)
        self.synthetic = SyntheticHost(self.repo)
        self.policy = policy_fixture(self.repo, self.state)
        self.policy_path = private(self.root / "policy.json", encoded(self.policy))
        self.adapter = host.HostAdapter(self.policy_path)
        self.plan = runner.make_plan(self.synthetic.raw, self.synthetic.digest)
        self.approval = approve(self.state, self.plan)
        self.event = runner.event_for(self.plan, "REJECTED", "authorize", False, "pending")

    def rewrite_approval(self, **updates):
        value = host.decode(self.approval.read_bytes())
        value.update(updates)
        private(self.approval, encoded(value))

    def test_05_disabled_policy(self):
        private(self.policy_path, encoded({**self.policy, "enabled": False}))
        with self.assertRaises(RuntimeError):
            host.HostAdapter(self.policy_path)

    def test_06_permission_links_and_owner(self):
        for mode in (0o644, 0o620, 0o666):
            self.policy_path.chmod(mode)
            with self.assertRaises(RuntimeError):
                host.HostAdapter(self.policy_path)
        self.policy_path.chmod(0o600)
        link = self.root / "link"
        link.symlink_to(self.policy_path)
        with self.assertRaises(RuntimeError):
            host.read_secure(link)
        link.unlink()
        os.link(self.policy_path, link)
        with self.assertRaises(RuntimeError):
            host.read_secure(self.policy_path)
        link.unlink()
        os.chown(self.policy_path, 65534, 65534)
        with self.assertRaises(RuntimeError):
            host.read_secure(self.policy_path)

    def test_07_parent_and_symlink_repository(self):
        self.root.chmod(0o777)
        with self.assertRaises(RuntimeError):
            host.HostAdapter(self.policy_path)
        self.root.chmod(0o700)
        link = self.root / "repository-link"
        link.symlink_to(self.repo, target_is_directory=True)
        private(self.policy_path, encoded({**self.policy, "repository": str(link)}))
        with self.assertRaises(RuntimeError):
            host.HostAdapter(self.policy_path)

    def test_08_approval_consumed_once(self):
        receipt = self.adapter.authorize(self.plan)
        self.assertTrue(receipt["consumed"])
        self.assertTrue((self.state / "used" / self.approval.name).is_file())
        with self.assertRaises(FileExistsError):
            self.adapter.authorize(self.plan)

    def test_09_missing_expired_or_foreign_approval_no_apply(self):
        for updates in ({"expires_at": 0}, {"expires_at": int(time.time()) + 90000},
                        {"request_sha256": "0" * 64}, {"schema": True}):
            approve(self.state, self.plan)
            self.rewrite_approval(**updates)
            with patch.object(self.adapter, "apply_api") as apply, patch.object(self.adapter, "send_failure"):
                result = self.adapter.execute(self.synthetic.raw)
            self.assertEqual(result["status"], "REJECTED")
            apply.assert_not_called()
        self.approval.unlink()
        with self.assertRaises(FileNotFoundError):
            self.adapter.authorize(self.plan)

    def test_10_evidence_tamper_and_kind(self):
        receipt = host.decode(self.approval.read_bytes())
        proof_path = self.state / "evidence" / (receipt["restore_sha256"] + ".json")
        private(proof_path, proof_path.read_bytes() + b" ")
        with self.assertRaises(RuntimeError):
            self.adapter.authorize(self.plan)
        approve(self.state, self.plan)
        self.rewrite_approval(restore_sha256=receipt["compatibility_sha256"])
        with self.assertRaises(RuntimeError):
            self.adapter.authorize(self.plan)

    def test_11_configuration_changed_before_approval(self):
        private(self.repo / ".env", b"changed")
        with self.assertRaises(RuntimeError):
            self.adapter.authorize(self.plan)
        self.assertFalse(list((self.state / "used").iterdir()))

    def test_12_journal_append_and_fsync(self):
        with patch.object(host.os, "fsync", wraps=os.fsync) as fsync:
            self.adapter.record(self.event)
            self.adapter.record({**self.event, "notification": "accepted"})
        records = [json.loads(line) for line in (self.state / "journal" / (self.plan.request_sha256 + ".jsonl")).read_text().splitlines()]
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["event"]["event_id"], records[1]["event"]["event_id"])
        self.assertNotEqual(records[0]["record_id"], records[1]["record_id"])
        self.assertGreaterEqual(fsync.call_count, 4)

    def test_13_busy_lock_preserved_and_separate_refusal(self):
        lock = private(self.repo / ".kin-ops.lock", b"another-owner")
        with patch.object(self.adapter, "authorize") as auth:
            result = self.adapter.execute(self.synthetic.raw)
        auth.assert_not_called()
        self.assertEqual(result["stage"], "lock")
        self.assertEqual(lock.read_bytes(), b"another-owner")
        records = list((self.state / "refusals").glob("*.json"))
        self.assertEqual(len(records), 1)
        self.assertEqual(host.decode(records[0].read_bytes())["code"], "lock_busy")

    def test_14_fixed_commands_and_environment(self):
        with patch.dict(os.environ, {"PATH": "/attacker", "DOCKER_HOST": "tcp://attacker", "COMPOSE_FILE": "/attacker"}), \
                patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as run:
            self.adapter.command(["git", "rev-parse", "HEAD"])
            command, options = run.call_args.args[0], run.call_args.kwargs
        self.assertEqual(command[0], "/usr/bin/git")
        self.assertIn("core.hooksPath=/dev/null", command)
        self.assertEqual(options["env"]["DOCKER_HOST"], "unix:///var/run/docker.sock")
        self.assertNotIn("COMPOSE_FILE", options["env"])
        with self.assertRaises(RuntimeError):
            self.adapter.command(["sh", "-c", "false"])

    def test_15_apply_exact_api_only_command(self):
        self.adapter.authorize(self.plan)
        with patch.object(self.adapter, "command") as command, patch.object(ops, "reload_proxy") as proxy:
            self.assertTrue(self.adapter.apply_api(self.plan.target_sha, self.plan.target_api_image)["settled"])
        self.assertEqual(command.call_args_list[0].args[0], ["git", "checkout", "--detach", self.plan.target_sha])
        args = command.call_args_list[1].args[0]
        self.assertEqual(args[-8:], ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "api"])
        override = json.loads(command.call_args_list[1].kwargs["input_data"])
        self.assertEqual(set(override["services"]), {"api"})
        self.assertEqual(override["services"]["api"]["image"], self.plan.target_api_image)
        proxy.assert_called_once()

    def test_16_timeout_retains_lock_and_never_rolls_back(self):
        observation = {"preflight_passed": True, "deployment_authorized": False, "automatic_rollback_authorized": False,
                       "schema_unchanged": True, **{k: v for k, v in self.plan.request().items() if k != "version"}}
        with patch.object(self.adapter, "observe", return_value=observation), \
                patch.object(self.adapter, "command", side_effect=subprocess.TimeoutExpired("fixed", 1)) as command, \
                patch.object(self.adapter, "send_failure"):
            result = self.adapter.execute(self.synthetic.raw)
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertTrue(result["lock_retained"])
        self.assertEqual(command.call_count, 1)

    def test_17_outbox_failure_retry_and_dedup(self):
        with patch.object(self.adapter, "send_failure", side_effect=RuntimeError("smtp")):
            with self.assertRaises(RuntimeError):
                self.adapter.notify_failure(self.event)
        path = self.state / "outbox" / (self.event["event_id"] + ".json")
        self.assertFalse(host.decode(path.read_bytes())["accepted"])
        with patch.object(self.adapter, "send_failure") as send:
            self.assertEqual(self.adapter.drain(), {"notifications_accepted": 1})
            self.assertTrue(self.adapter.notify_failure(self.event))
            send.assert_called_once()
        self.assertEqual(host.decode((self.state / "mail-budget.json").read_bytes())["attempts"], 2)

    def test_18_mail_budget_and_clock_reversal(self):
        path = self.state / "mail-budget.json"
        for budget in ({"day": int(time.time()) // 86400, "attempts": 24, "last_attempt": 0},
                       {"day": int(time.time()) // 86400, "attempts": 0, "last_attempt": int(time.time()) + 60}):
            private(path, encoded(budget))
            with patch.object(self.adapter, "send_failure") as send, self.assertRaises(RuntimeError):
                self.adapter.notify_failure(self.event)
            send.assert_not_called()

    def test_19_smtp_fixed_tls_recipient_and_message_id(self):
        with patch.object(host.smtplib, "SMTP_SSL") as smtp:
            smtp.return_value.__enter__.return_value.send_message.return_value = {}
            self.adapter.send_failure(self.event)
            message = smtp.return_value.__enter__.return_value.send_message.call_args.args[0]
        self.assertEqual(smtp.call_args.args, ("smtp.daum.net", 465))
        self.assertEqual(smtp.call_args.kwargs["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(message["To"], "fixture@example.invalid")
        self.assertIn(self.event["event_id"], message["Message-ID"])
        self.assertNotIn("synthetic-only", message.as_string())

    def test_20_unprivileged_uid_cannot_replace_policy_or_module(self):
        module = private(self.root / "module.py", b"# protected installed module fixture")
        source = "import os,sys;os.setgroups([]);os.setgid(65534);os.setuid(65534);open(sys.argv[1],'w').write('changed')"
        for path in (self.policy_path, module):
            before = path.read_bytes()
            result = subprocess.run([sys.executable, "-I", "-c", source, str(path)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"PermissionError", result.stderr)
            self.assertEqual(path.read_bytes(), before)

    def tls_server(self):
        cert, key = self.root / "cert.pem", self.root / "key.pem"
        subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
                        "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
        cert.chmod(0o600)
        key.chmod(0o600)
        fixture = {"health": True, "redirect": False, "frame": FRAME, "subject": "fixture", "requests": []}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                fixture["requests"].append(self.path)
                kind, status = "application/json", 200
                if fixture["redirect"]:
                    self.send_response(302)
                    self.send_header("Location", "/redirect-destination")
                    self.end_headers()
                    return
                if self.path == "/api/health":
                    raw = encoded({"ok": fixture["health"], "auth": True})
                elif self.headers.get("Authorization") != "Bearer synthetic.token":
                    status, raw = 401, b"{}"
                elif self.path == "/api/me":
                    raw = encoded({"sub": fixture["subject"]})
                else:
                    kind = 'multipart/related; boundary="fixture-boundary"; type="application/octet-stream"'
                    raw = b"--fixture-boundary\r\nContent-Type: application/octet-stream\r\n\r\n" + fixture["frame"] + b"\r\n--fixture-boundary--\r\n"
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.adapter.policy["origin"] = "https://127.0.0.1:" + str(server.server_port)
        self.adapter.policy["smoke"]["ca_file"] = str(cert)
        return fixture

    def smoke_fixture(self):
        container = self.synthetic.inspect(["inspect", "kin-api"])
        container["Config"]["Labels"]["kin.deploy.release"] = self.plan.previous_sha
        with self.adapter.bound(), patch.object(host.pre, "inspect_one", return_value=container):
            return self.adapter.smoke_once(self.plan.previous_sha, self.plan.previous_api_image)

    def test_21_real_tls_health_auth_and_frame(self):
        fixture = self.tls_server()
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:1"}):
            self.assertTrue(self.smoke_fixture()["image_read"])
        self.assertEqual(fixture["requests"].count("/api/me"), 2)

    def test_22_tls_untrusted_cert_and_redirect_refused(self):
        fixture = self.tls_server()
        ca = self.adapter.policy["smoke"]["ca_file"]
        self.adapter.policy["smoke"]["ca_file"] = None
        with self.assertRaises(Exception):
            self.smoke_fixture()
        self.adapter.policy["smoke"]["ca_file"] = ca
        fixture["redirect"] = True
        with self.assertRaises(Exception):
            self.smoke_fixture()
        self.assertNotIn("/redirect-destination", fixture["requests"])

    def test_23_wrong_identity_health_and_frame_refused(self):
        fixture = self.tls_server()
        for key, value in (("health", False), ("subject", "different-subject"), ("frame", b"wrong"), ("frame", b"x" * 70000)):
            before = fixture[key]
            fixture[key] = value
            with self.subTest(key=key), self.assertRaises(Exception):
                self.smoke_fixture()
            fixture[key] = before

    def test_24_outbox_tamper_does_not_mail(self):
        path = self.state / "outbox" / (self.event["event_id"] + ".json")
        private(path, encoded({"event": {**self.event, "raw_secret": "never-mail"}, "accepted": False}))
        with patch.object(self.adapter, "send_failure") as send, self.assertRaises(RuntimeError):
            self.adapter.deliver(path)
        send.assert_not_called()

    @unittest.skipUnless(os.environ.get("KIN_TEST_ISOLATED_INSTALL") == "1", "fixed paths only in disposable container")
    def test_25_isolated_fixed_install_and_caller_environment(self):
        library = Path("/opt/kin-deploy/lib")
        library.mkdir(mode=0o755)
        scripts = Path(host.__file__).parent
        for name in ("ops_deploy_host", "ops_deploy_runner", "ops_deploy_preflight", "ops_backup", "ops_email_monitor", "ops_monitor", "ops_notify"):
            shutil.copyfile(scripts / (name + ".py"), library / (name + ".py"))
            (library / (name + ".py")).chmod(0o644)
        entry = Path("/opt/kin-deploy/entry.py")
        shutil.copyfile(scripts / "ops_deploy_entry.py", entry)
        entry.chmod(0o755)
        policy = Path("/etc/kin-deploy/policy.json")
        private(policy, encoded(self.policy))
        private(self.repo / ".kin-ops.lock", b"owned-by-test")
        env = {**os.environ, "PYTHONPATH": "/attacker", "DOCKER_HOST": "tcp://attacker", "COMPOSE_FILE": "/attacker"}
        result = subprocess.run(["/usr/bin/python3", "-I", str(entry)], input=self.synthetic.raw, capture_output=True, env=env)
        self.assertEqual(json.loads(result.stdout)["stage"], "lock")
        self.assertEqual(result.stderr, b"")
        (library / "ops_deploy_host.py").chmod(0o666)
        result = subprocess.run(["/usr/bin/python3", "-I", str(entry)], input=self.synthetic.raw, capture_output=True)
        self.assertEqual(json.loads(result.stderr)["stage"], "entry")


if __name__ == "__main__":
    unittest.main(verbosity=2)
