"""The one-shot EMR probe (INTERIM-RELEASE-TOOLS item 7).

ProbeVerdictTests: the verdict over the two processes' outputs - one new entry, zero replay duplicates, the external
seal over it, the same chain after restart - with each defect refused. ProbeContainerTests (opt-in, a production API
image in KIN_TEST_API_IMAGE and a local Docker daemon): the probe script itself runs the product's compiled ledger
modules in that image against a disposable provisioned and migrated PostgreSQL and its own state volume; the rows it
appended are counted through the product's read functions. Synthetic data only; nothing is cleaned from the ledger
inside the run (the disposable database is removed with its container).
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ops_backup as ops
import ops_emr_introduction as intro
import ops_emr_probe as probe

PROBE = {"study": "SYNTHETIC-release-probe", "event_id": "12345678-1234-4123-8123-123456789abc", "institution": "kin-center",
         "approved_by": "commander", "approved_at": "2026-10-12T00:00:00Z"}


SERVICE = {"epoch": "0f5c2d2e-7a1b-4c3d-8e9f-000000000001", "instanceId": "synthetic-pair", "state": "ready"}


def outputs(existed=False):
    """EMR-B2 (c): two client-only processes; the second is an API-only restart that sees the same service epoch."""
    entry = {"sequence": 5, "hash": "e" * 64, "kind": "access", "eventId": PROBE["event_id"]}
    tail = {"sequence": 5, "hash": "e" * 64}
    first = {"operation": "append", "service": dict(SERVICE),
             "tail_before": tail if existed else {"sequence": 4, "hash": "d" * 64}, "existed_before": existed,
             "journal_before": 0, "pending_before": 0, "sealed_before": dict(tail) if existed else {"sequence": 4, "hash": "d" * 64},
             "receipt": {"eventId": PROBE["event_id"], "durableAt": "2026-10-13T01:00:00.000Z"},
             "tail_after": dict(tail), "replay": {"eventId": PROBE["event_id"], "durableAt": "2026-10-13T01:00:00.000Z"},
             "tail_replay": dict(tail), "stored": dict(entry), "sealed": dict(tail), "journal_after": 0, "pending_after": 0, "scopes_after": 0}
    second = {"operation": "restart", "service": dict(SERVICE), "tail_before": dict(tail), "existed_before": True,
              "journal_before": 0, "pending_before": 0, "sealed_before": dict(tail), "stored": dict(entry), "sealed": dict(tail),
              "journal_after": 0, "pending_after": 0, "scopes_after": 0}
    return first, second


def after_service_restart():
    """A third client process after the service itself restarted: a new epoch, the same chain and seal."""
    _first, second = outputs()
    return {**second, "service": {**SERVICE, "epoch": "0f5c2d2e-7a1b-4c3d-8e9f-000000000002"}}


class ProbeVerdictTests(unittest.TestCase):
    def test_01_the_event_is_a_service_job_bound_to_the_synthetic_study(self):
        event = probe.probe_event(PROBE, datetime(2026, 10, 13, 1, 2, 3, 456789, tzinfo=timezone.utc))
        self.assertEqual(event["eventId"], PROBE["event_id"])
        self.assertEqual((event["executor"], event["cause"], event["context"]["basis"]), ("service", "service-job", "service-job"))
        self.assertEqual(event["context"]["studyId"], PROBE["study"])
        self.assertEqual(event["occurredAt"], "2026-10-13T01:02:03.456Z")
        self.assertTrue(all(target["kind"] == "system-operation" for target in event["targets"]))
        self.assertNotEqual(event["userId"]["value"]["issuer"].split(":")[0], "https")
        with self.assertRaisesRegex(intro.Stop, "synthetic"):
            probe.probe_event({**PROBE, "study": "1.2.410.200.real"})

    def test_02_a_complete_chain_passes_new_or_already_present(self):
        for existed in (False, True):
            first, second = outputs(existed)
            evidence = probe.verify(first, second, PROBE["event_id"])
            self.assertEqual((evidence["added"], evidence["replay_duplicates"]), (0 if existed else 1, 0))

    def test_03_each_defect_is_refused(self):
        cases = {
            "process error": lambda f, s: f.update(error="SealUnavailable"),
            "no receipt": lambda f, s: f.update(receipt=None),
            "other event": lambda f, s: f["receipt"].update(eventId="other"),
            "replay receipt differs": lambda f, s: f["replay"].update(durableAt="2026-10-13T01:00:01.000Z"),
            "two entries": lambda f, s: f["tail_after"].update(sequence=6),
            "replay duplicate": lambda f, s: f["tail_replay"].update(sequence=6),
            "stored elsewhere": lambda f, s: f["stored"].update(sequence=3),
            "history kind": lambda f, s: f["stored"].update(kind="history"),
            "seal behind": lambda f, s: f.update(sealed={"sequence": 4, "hash": "d" * 64}),
            "failure journal": lambda f, s: f.update(journal_after=1),
            "pending reservation left": lambda f, s: f.update(pending_after=1),
            "live scope left": lambda f, s: f.update(scopes_after=1),
            "service not ready": lambda f, s: f["service"].update(state="stopping"),
            "restart lost entry": lambda f, s: s.update(stored=None),
            "restart chain changed": lambda f, s: s.update(tail_before={"sequence": 6, "hash": "f" * 64}),
            "restart changed the service epoch": lambda f, s: s["service"].update(epoch="0f5c2d2e-7a1b-4c3d-8e9f-000000000009"),
            "restart saw another instance": lambda f, s: s["service"].update(instanceId="other-pair"),
            "restart found pending work": lambda f, s: s.update(pending_before=1),
            "restart journal": lambda f, s: s.update(journal_after=2),
            "operations swapped": lambda f, s: s.update(operation="append"),
        }
        for name, change in cases.items():
            first, second = outputs()
            change(first, second)
            with self.subTest(case=name), self.assertRaises((intro.Stop, KeyError, TypeError)):
                probe.verify(first, second, PROBE["event_id"])

    def test_03b_a_separate_service_restart_needs_a_new_epoch_and_the_same_chain(self):
        first, second = outputs()
        evidence = probe.verify(first, second, PROBE["event_id"])
        third = after_service_restart()
        result = probe.verify_after_service_restart(evidence, third, PROBE["event_id"])
        self.assertEqual(result["service_restart"], "new epoch, same chain and seal")
        self.assertNotEqual(result["service_epoch_after_restart"], evidence["service_epoch"])
        cases = {
            "same epoch (no service restart happened)": lambda t: t["service"].update(epoch=SERVICE["epoch"]),
            "chain changed": lambda t: t.update(sealed={"sequence": 6, "hash": "f" * 64}),
            "entry lost": lambda t: t.update(stored=None),
            "pending work": lambda t: t.update(pending_after=1),
            "new failure record": lambda t: t.update(journal_after=1),
            "process failed": lambda t: t.update(error="EmrStatePairMismatch"),
        }
        for name, change in cases.items():
            third = after_service_restart()
            change(third)
            with self.subTest(case=name), self.assertRaises((intro.Stop, KeyError, TypeError)):
                probe.verify_after_service_restart(evidence, third, PROBE["event_id"])

    def test_04_cli_verify_and_event(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            first, second = outputs()
            paths = [Path(folder) / "first.json", Path(folder) / "second.json"]
            for path, value in zip(paths, (first, second)):
                path.write_text(json.dumps(value))
            result = subprocess.run([sys.executable, probe.__file__, "verify", *map(str, paths), "--event-id", PROBE["event_id"]],
                                    capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["replay_duplicates"], 0)
            bad = copy.deepcopy(first)
            bad["tail_replay"]["sequence"] = 6
            paths[0].write_text(json.dumps(bad))
            result = subprocess.run([sys.executable, probe.__file__, "verify", *map(str, paths), "--event-id", PROBE["event_id"]],
                                    capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("replay added", json.loads(result.stderr)["error"])


@unittest.skipUnless(os.environ.get("KIN_TEST_API_IMAGE"), "a production API image in KIN_TEST_API_IMAGE is required")
class ProbeContainerTests(unittest.TestCase):
    """EMR-B2 (c): the probe script in the real image against the real protected-state service (state-serve-v3, Node
    PID 1 as UID 1000 with the reader credential, the state volume and the two IPC volumes) over a disposable
    provisioned and migrated PostgreSQL. Client processes run as UID 1001 with only the read-only API IPC volume and
    the runtime credential: the replay is 0 rows, an API-only restart sees the same sealed chain and the same service
    epoch, and a restart of the service itself starts a new epoch over the same chain and seal."""

    PREFIX = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-")
    INSTANCE = "probe-synthetic-pair"
    API_IPC = "/run/kin-emr-api"
    RETENTION_IPC = "/run/kin-emr-retention"

    @classmethod
    def setUpClass(cls):
        cls.enterClassContext(ops.resource_names(cls.PREFIX))
        ops.require_local_docker()
        cls.image = os.environ["KIN_TEST_API_IMAGE"]
        cls.token = uuid.uuid4().hex
        short = cls.token[:16]
        cls.db = cls.PREFIX + short + "-probe-db"
        cls.state = cls.PREFIX + short + "-probe-state"
        cls.api_ipc = cls.PREFIX + short + "-probe-api-ipc"
        cls.retention_ipc = cls.PREFIX + short + "-probe-retention-ipc"
        cls.service = cls.PREFIX + short + "-probe-state-service"
        cls.reader_password = "Synthetic-Reader-" + uuid.uuid4().hex[:24]
        cls.runtime_password = "Synthetic-Runtime-" + uuid.uuid4().hex[:24]
        for kind, name in (("volume", cls.state), ("volume", cls.api_ipc), ("volume", cls.retention_ipc),
                           ("container", cls.service), ("container", cls.db)):
            cls.addClassCleanup(ops.remove_owned_if_present, kind, name, cls.token)
        ops.run(["docker", "run", "-d", "--name", cls.db, "--label", "kin.ops.run=" + cls.token, "--network", "none",
                 "--tmpfs", "/var/lib/postgresql/data", "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=kin", "postgres:16-alpine"])
        deadline = time.monotonic() + 60
        while ops.run(["docker", "exec", cls.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError("Disposable PostgreSQL did not start")
            time.sleep(0.5)
        spec = importlib.util.spec_from_file_location("emr_compose", ROOT / "scripts" / "emr-compose.py")
        compose = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(compose)
        ops.run(["docker", "exec", "-u", "postgres", cls.db, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + cls.runtime_password,
                                      "-e", "KIN_EMR_READER_PASSWORD=" + cls.reader_password, cls.db, "psql", "-X",
                                      "-U", "postgres", "-d", "kin"], input=compose.PROVISION_SQL.encode(), capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("Provisioning failed")
        migrated = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.db, "-e",
                                   "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/kin", cls.image, "sh", "/app/start-production.sh",
                                   "migrate"], capture_output=True, timeout=300)
        if migrated.returncode:
            raise RuntimeError("Migration failed: " + migrated.stdout.decode(errors="replace")[-800:])
        for volume in (cls.state, cls.api_ipc, cls.retention_ipc):
            ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + cls.token, volume])
        cls.start_service()

    @classmethod
    def service_args(cls):
        # The service is the only process with the state volume, the reader credential and both IPC volumes.
        return ["--network", "container:" + cls.db, "--label", "kin.ops.run=" + cls.token, "--user", "1000:1000",
                "--group-add", "2001", "--group-add", "2002", "--stop-timeout", "20",
                "-e", "DATABASE_URL=postgresql://kin_emr_reader:" + cls.reader_password + "@127.0.0.1:5432/kin",
                "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE, "-e", "KIN_EMR_INSTANCE_ID=" + cls.INSTANCE,
                "-e", "KIN_EMR_API_SOCKET=" + cls.API_IPC + "/writer.sock", "-e", "KIN_EMR_RETENTION_SOCKET=" + cls.RETENTION_IPC + "/writer.sock",
                "--mount", "type=volume,source=" + cls.state + ",target=" + ops.EMR_STATE,
                "--mount", "type=volume,source=" + cls.api_ipc + ",target=" + cls.API_IPC,
                "--mount", "type=volume,source=" + cls.retention_ipc + ",target=" + cls.RETENTION_IPC,
                "--entrypoint", "sh", cls.image, "/app/start-production.sh", "state-serve-v3"]

    @classmethod
    def start_service(cls):
        ops.run(["docker", "run", "-d", "--name", cls.service, *cls.service_args()])
        deadline = time.monotonic() + 120
        while True:
            logs = subprocess.run(["docker", "logs", cls.service], capture_output=True, timeout=30)
            text = logs.stdout.decode(errors="replace") + logs.stderr.decode(errors="replace")
            if "EMR_STATE_READY" in text:
                return text
            state = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", cls.service], capture_output=True, timeout=30)
            if state.stdout.decode().split()[:1] != ["true"] or time.monotonic() > deadline:
                raise RuntimeError("State service did not become ready: " + text[-1500:])
            time.sleep(0.5)

    @classmethod
    def stop_service(cls):
        ops.run(["docker", "stop", "--time", "20", cls.service])
        logs = subprocess.run(["docker", "logs", cls.service], capture_output=True, timeout=30).stdout.decode(errors="replace")
        exit_code = subprocess.run(["docker", "inspect", "-f", "{{.State.ExitCode}}", cls.service], capture_output=True, timeout=30).stdout.decode().strip()
        ops.run(["docker", "rm", "-v", cls.service])
        return logs, exit_code

    def process(self, operation, value):
        # A client: the API UID and group, the runtime credential, the read-only API IPC volume, no state volume.
        result = subprocess.run(["docker", "run", "--rm", "--network", "container:" + self.db, "--label", "kin.ops.run=" + self.token,
                                 "--user", "1001:1001", "--group-add", "2001", "--read-only",
                                 "-e", "DATABASE_URL=postgresql://kin_runtime:" + self.runtime_password + "@127.0.0.1:5432/kin",
                                 "-e", "KIN_EMR_INSTANCE_ID=" + self.INSTANCE, "-e", "KIN_EMR_STATE_SOCKET=" + self.API_IPC + "/writer.sock",
                                 "--mount", "type=volume,source=" + self.api_ipc + ",target=" + self.API_IPC + ",readonly",
                                 "--entrypoint", "node", self.image, "-e", probe.PROBE_SCRIPT, operation, json.dumps(value)],
                                capture_output=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout.decode(errors="replace")[-2000:] + result.stderr.decode(errors="replace")[-2000:])
        return intro.result_line(result.stdout)

    def test_05_probe_appends_once_replays_nothing_and_api_restart_keeps_the_service_epoch(self):
        event = probe.probe_event({**PROBE, "event_id": str(uuid.uuid4())})
        first = self.process("append", {"event": event})
        second = self.process("restart", {"eventId": event["eventId"]})
        evidence = probe.verify(first, second, event["eventId"])
        self.assertEqual((evidence["added"], evidence["replay_duplicates"]), (1, 0))
        # The same probe again (a re-run of the phase) is a replay: still one entry for the event, same epoch.
        again = self.process("append", {"event": event})
        third = self.process("restart", {"eventId": event["eventId"]})
        evidence = probe.verify(again, third, event["eventId"])
        self.assertEqual(evidence["added"], 0)
        self.assertEqual(again["stored"], first["stored"])
        self.assertEqual(again["service"]["epoch"], first["service"]["epoch"])
        # A separate restart of the service: its own fenced recovery, a new epoch, the same chain and seal.
        logs, exit_code = self.stop_service()
        self.assertIn("EMR_STATE_CLOSED", logs, logs[-1500:])
        self.assertEqual(exit_code, "0")
        self.start_service()
        after = self.process("restart", {"eventId": event["eventId"]})
        evidence = probe.verify_after_service_restart(evidence, after, event["eventId"])
        self.assertNotEqual(after["service"]["epoch"], first["service"]["epoch"])
        print(json.dumps({"probe_container": True, "entry": evidence["entry"], "image": self.image,
                          "service_epochs": [first["service"]["epoch"], after["service"]["epoch"]]}), flush=True)

    def test_06_a_client_without_the_service_or_with_a_state_mount_never_promotes(self):
        # Service absent: the client refuses at its session phase and leaves no state file behind.
        logs, exit_code = self.stop_service()
        try:
            result = subprocess.run(["docker", "run", "--rm", "--network", "container:" + self.db, "--label", "kin.ops.run=" + self.token,
                                     "--user", "1001:1001", "--group-add", "2001", "--read-only",
                                     "-e", "DATABASE_URL=postgresql://kin_runtime:" + self.runtime_password + "@127.0.0.1:5432/kin",
                                     "-e", "KIN_EMR_INSTANCE_ID=" + self.INSTANCE, "-e", "KIN_EMR_STATE_SOCKET=" + self.API_IPC + "/writer.sock",
                                     "--mount", "type=volume,source=" + self.api_ipc + ",target=" + self.API_IPC + ",readonly",
                                     "--entrypoint", "node", self.image, "-e", probe.PROBE_SCRIPT, "restart", json.dumps({"eventId": "absent"})],
                                    capture_output=True, timeout=180)
            self.assertEqual(result.returncode, 1)
            self.assertIn("error", intro.result_line(result.stdout))
            # A client handed the state directory is refused before any connection (no owner path in the API).
            misdeployed = subprocess.run(["docker", "run", "--rm", "--network", "container:" + self.db, "--label", "kin.ops.run=" + self.token,
                                          "--user", "1001:1001", "--group-add", "2001",
                                          "-e", "DATABASE_URL=postgresql://kin_runtime:" + self.runtime_password + "@127.0.0.1:5432/kin",
                                          "-e", "KIN_EMR_INSTANCE_ID=" + self.INSTANCE, "-e", "KIN_EMR_STATE_SOCKET=" + self.API_IPC + "/writer.sock",
                                          "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
                                          "--mount", "type=volume,source=" + self.api_ipc + ",target=" + self.API_IPC + ",readonly",
                                          "--entrypoint", "node", self.image, "-e", probe.PROBE_SCRIPT, "restart", json.dumps({"eventId": "absent"})],
                                         capture_output=True, timeout=180)
            self.assertEqual(misdeployed.returncode, 1)
            self.assertEqual(intro.result_line(misdeployed.stdout).get("error"), "EmrStartupFailure")
        finally:
            self.start_service()


if __name__ == "__main__":
    unittest.main(verbosity=2)
