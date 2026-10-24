"""The one-shot EMR probe (INTERIM-RELEASE-TOOLS item 7).

ProbeVerdictTests: the verdict over the two processes' outputs - one legal entry, an immutable committed outcome,
zero replay duplicates, and the same outcome after restart. ProbeContainerTests (opt-in, a production API
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


def outputs(existed=False):
    entry = {"sequence": 57, "entryId": str(uuid.uuid4()), "kind": "access", "stream": "viewing", "eventId": PROBE["event_id"]}
    receipt = {"eventId": PROBE["event_id"], "durableAt": "2026-10-13T01:00:00.000Z"}
    outcome = {"operationId": str(uuid.uuid4()), "eventId": PROBE["event_id"], "outcome": "committed", "result": None,
               "durableAt": "2026-10-13T01:00:00+00:00", "entries": [{"entryId": entry["entryId"], "stream": "viewing",
               "attemptId": str(uuid.uuid4()), "expired": False}]}
    first = {"operation": "append", "readiness": {"role": "kin_runtime", "relations": 37}, "existed_before": existed,
             "receipt": receipt, "replay": dict(receipt), "outcome": outcome, "replay_outcome": copy.deepcopy(outcome), "stored": entry}
    second = {"operation": "restart", "readiness": dict(first["readiness"]), "existed_before": True,
              "receipt": dict(receipt), "outcome": copy.deepcopy(outcome), "stored": dict(entry)}
    return first, second


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

    def test_02_committed_outcome_passes_new_or_already_present_with_sequence_gaps(self):
        for existed in (False, True):
            first, second = outputs(existed)
            evidence = probe.verify(first, second, PROBE["event_id"])
            self.assertEqual((evidence["added"], evidence["replay_duplicates"]), (0 if existed else 1, 0))

    def test_03_each_defect_is_refused(self):
        cases = {
            "process error": lambda f, s: f.update(error="EmrRuntimeRefused"),
            "no receipt": lambda f, s: f.update(receipt=None),
            "other event": lambda f, s: f["receipt"].update(eventId="other"),
            "replay receipt differs": lambda f, s: f["replay"].update(durableAt="2026-10-13T01:00:01.000Z"),
            "two entries": lambda f, s: f["outcome"]["entries"].append(dict(f["outcome"]["entries"][0])),
            "replay duplicate": lambda f, s: f["replay_outcome"]["entries"][0].update(entryId=str(uuid.uuid4())),
            "stored elsewhere": lambda f, s: f["stored"].update(entryId=str(uuid.uuid4())),
            "history kind": lambda f, s: f["stored"].update(kind="history"),
            "provisional": lambda f, s: f["outcome"].update(outcome="pending"),
            "negative": lambda f, s: f["outcome"].update(outcome="negative"),
            "expired": lambda f, s: f["outcome"]["entries"][0].update(expired=True),
            "missing expiry observation": lambda f, s: f["outcome"]["entries"][0].pop("expired"),
            "integer is not false": lambda f, s: f["outcome"]["entries"][0].update(expired=0),
            "wrong role": lambda f, s: f["readiness"].update(role="postgres"),
            "readiness absent": lambda f, s: s.pop("readiness"),
            "invalid clock": lambda f, s: f["receipt"].update(durableAt="yesterday"),
            "local clock": lambda f, s: f["receipt"].update(durableAt="2026-10-13T01:00:00"),
            "restart lost entry": lambda f, s: s.update(stored=None),
            "restart outcome changed": lambda f, s: s["outcome"].update(operationId=str(uuid.uuid4())),
            "restart unknown": lambda f, s: s.update(outcome=None),
            "missing observation": lambda f, s: f.pop("existed_before"),
            "operations swapped": lambda f, s: s.update(operation="append"),
        }
        for name, change in cases.items():
            first, second = outputs()
            change(first, second)
            with self.subTest(case=name), self.assertRaises((intro.Stop, KeyError, TypeError)):
                probe.verify(first, second, PROBE["event_id"])

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
            bad["replay_outcome"]["entries"][0]["entryId"] = str(uuid.uuid4())
            paths[0].write_text(json.dumps(bad))
            result = subprocess.run([sys.executable, probe.__file__, "verify", *map(str, paths), "--event-id", PROBE["event_id"]],
                                    capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("replay changed", json.loads(result.stderr)["error"])


@unittest.skipUnless(os.environ.get("KIN_TEST_API_IMAGE"), "a production API image in KIN_TEST_API_IMAGE is required")
class ProbeContainerTests(unittest.TestCase):
    """The probe script in the real image: one entry and the same outcome after a new process starts."""

    @classmethod
    def setUpClass(cls):
        cls.enterClassContext(ops.resource_names(os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-")))
        ops.require_local_docker()
        cls.image = os.environ["KIN_TEST_API_IMAGE"]
        cls.image_id = ops.run(["docker", "image", "inspect", "--format", "{{.Id}}", cls.image]).stdout.decode().strip()
        cls.token = uuid.uuid4().hex
        cls.db = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + cls.token[:16] + "-probe-db"
        cls.state = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + cls.token[:16] + "-probe-state"
        cls.addClassCleanup(ops.remove_owned_if_present, "volume", cls.state, cls.token)
        cls.addClassCleanup(ops.remove_owned_if_present, "container", cls.db, cls.token)
        ops.run(["docker", "run", "-d", "--name", cls.db, "--label", "kin.ops.run=" + cls.token, "--network", "none",
                 "--memory", "512m", "--memory-swap", "512m", "--cpus", "2",
                 "--tmpfs", "/var/lib/postgresql/data:rw,size=128m", "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700,size=64m",
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
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex, cls.db, "psql", "-X",
                                      "-U", "postgres", "-d", "kin"], input=compose.PROVISION_SQL.encode(), capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("Provisioning failed")
        migrated = subprocess.run(["docker", "run", "--rm", "--memory", "512m", "--memory-swap", "512m", "--network", "container:" + cls.db, "-e",
                                   "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/kin", cls.image, "sh", "/app/start-production.sh",
                                   "migrate"], capture_output=True, timeout=300)
        if migrated.returncode:
            raise RuntimeError("Migration failed: " + migrated.stdout.decode(errors="replace")[-800:])
        ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + cls.token, cls.state])

    def process(self, operation, value):
        result = subprocess.run(["docker", "run", "--rm", "--memory", "512m", "--memory-swap", "512m", "--network", "container:" + self.db, "--label", "kin.ops.run=" + self.token,
                                 "-e", "DATABASE_URL=postgresql://kin_runtime@127.0.0.1:5432/kin", "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
                                 "--mount", "type=volume,source=" + self.state + ",target=" + ops.EMR_STATE, "--entrypoint", "node",
                                 self.image, "--max-old-space-size=3072", "-e", probe.PROBE_SCRIPT, operation, json.dumps(value)], capture_output=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout.decode(errors="replace")[-2000:] + result.stderr.decode(errors="replace")[-2000:])
        return intro.result_line(result.stdout)

    def test_05_probe_appends_once_replays_nothing_and_recovers_after_restart(self):
        event = probe.probe_event({**PROBE, "event_id": str(uuid.uuid4())})
        keys = {"operationId": str(uuid.uuid4()), "attemptId": str(uuid.uuid4())}
        first = self.process("append", {"event": event, "keys": keys})
        restart = {"eventId": event["eventId"], "operationId": first["outcome"]["operationId"]}
        second = self.process("restart", restart)
        evidence = probe.verify(first, second, event["eventId"])
        self.assertEqual((evidence["added"], evidence["replay_duplicates"]), (1, 0))
        # The same probe again (a re-run of the phase) is a replay: still one entry for the event.
        again = self.process("append", {"event": event, "keys": keys})
        third = self.process("restart", restart)
        evidence = probe.verify(again, third, event["eventId"])
        self.assertEqual(evidence["added"], 0)
        self.assertEqual(again["stored"], first["stored"])
        counts = ops.run(["docker", "exec", self.db, "psql", "-X", "-q", "-t", "-A", "-U", "postgres", "-d", "kin", "-c",
                          "SELECT (SELECT count(*) FROM emr_access.access_entry WHERE event_id='" + event["eventId"] +
                          "')::text || ',' || (SELECT count(*) FROM emr_access.attempt_outcome WHERE operation_id='" +
                          restart["operationId"] + "')::text;"]).stdout.decode().strip()
        self.assertEqual(counts, "1,1")
        print(json.dumps({"probe_container": True, "entry": evidence["entry"], "image": self.image,
                          "image_id": self.image_id, "independent_entry_outcome_counts": counts}), flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
