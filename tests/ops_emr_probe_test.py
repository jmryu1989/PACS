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


def outputs(existed=False):
    entry = {"sequence": 5, "hash": "e" * 64, "kind": "access", "eventId": PROBE["event_id"]}
    tail = {"sequence": 5, "hash": "e" * 64}
    first = {"operation": "append", "recovery": {"recovered": 0, "notCommitted": 0},
             "tail_before": tail if existed else {"sequence": 4, "hash": "d" * 64}, "existed_before": existed,
             "journal_before": 0, "receipt": {"eventId": PROBE["event_id"], "durableAt": "2026-10-13T01:00:00.000Z"},
             "tail_after": dict(tail), "replay": {"eventId": PROBE["event_id"], "durableAt": "2026-10-13T01:00:00.000Z"},
             "tail_replay": dict(tail), "stored": dict(entry), "sealed": dict(tail), "journal_after": 0}
    second = {"operation": "restart", "recovery": {"recovered": 0, "notCommitted": 0}, "tail_before": dict(tail),
              "existed_before": True, "journal_before": 0, "stored": dict(entry), "sealed": dict(tail), "journal_after": 0}
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
            "restart lost entry": lambda f, s: s.update(stored=None),
            "restart chain changed": lambda f, s: s.update(tail_before={"sequence": 6, "hash": "f" * 64}),
            "restart unsealed work": lambda f, s: s["recovery"].update(recovered=1),
            "restart journal": lambda f, s: s.update(journal_after=2),
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
            bad["tail_replay"]["sequence"] = 6
            paths[0].write_text(json.dumps(bad))
            result = subprocess.run([sys.executable, probe.__file__, "verify", *map(str, paths), "--event-id", PROBE["event_id"]],
                                    capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("replay added", json.loads(result.stderr)["error"])


@unittest.skipUnless(os.environ.get("KIN_TEST_API_IMAGE"), "a production API image in KIN_TEST_API_IMAGE is required")
class ProbeContainerTests(unittest.TestCase):
    """The probe script in the real image: the replay is 0 rows, a restart recovers the same sealed chain."""

    @classmethod
    def setUpClass(cls):
        cls.enterClassContext(ops.resource_names(os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-")))
        ops.require_local_docker()
        cls.image = os.environ["KIN_TEST_API_IMAGE"]
        cls.token = uuid.uuid4().hex
        cls.db = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + cls.token[:16] + "-probe-db"
        cls.state = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + cls.token[:16] + "-probe-state"
        cls.addClassCleanup(ops.remove_owned_if_present, "volume", cls.state, cls.token)
        cls.addClassCleanup(ops.remove_owned_if_present, "container", cls.db, cls.token)
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
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex, cls.db, "psql", "-X",
                                      "-U", "postgres", "-d", "kin"], input=compose.PROVISION_SQL.encode(), capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("Provisioning failed")
        migrated = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.db, "-e",
                                   "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/kin", cls.image, "sh", "/app/start-production.sh",
                                   "migrate"], capture_output=True, timeout=300)
        if migrated.returncode:
            raise RuntimeError("Migration failed: " + migrated.stdout.decode(errors="replace")[-800:])
        ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + cls.token, cls.state])

    def process(self, operation, value):
        result = subprocess.run(["docker", "run", "--rm", "--network", "container:" + self.db, "--label", "kin.ops.run=" + self.token,
                                 "-e", "DATABASE_URL=postgresql://kin_runtime@127.0.0.1:5432/kin", "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
                                 "--mount", "type=volume,source=" + self.state + ",target=" + ops.EMR_STATE, "--entrypoint", "node",
                                 self.image, "-e", probe.PROBE_SCRIPT, operation, json.dumps(value)], capture_output=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout.decode(errors="replace")[-2000:] + result.stderr.decode(errors="replace")[-2000:])
        return intro.result_line(result.stdout)

    def test_05_probe_appends_once_replays_nothing_and_recovers_after_restart(self):
        event = probe.probe_event({**PROBE, "event_id": str(uuid.uuid4())})
        first = self.process("append", {"event": event})
        second = self.process("restart", {"eventId": event["eventId"]})
        evidence = probe.verify(first, second, event["eventId"])
        self.assertEqual((evidence["added"], evidence["replay_duplicates"]), (1, 0))
        # The same probe again (a re-run of the phase) is a replay: still one entry for the event.
        again = self.process("append", {"event": event})
        third = self.process("restart", {"eventId": event["eventId"]})
        evidence = probe.verify(again, third, event["eventId"])
        self.assertEqual(evidence["added"], 0)
        self.assertEqual(again["stored"], first["stored"])
        print(json.dumps({"probe_container": True, "entry": evidence["entry"], "image": self.image}), flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
