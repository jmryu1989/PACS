"""The one-shot EMR probe (INTERIM-RELEASE-TOOLS item 7; EMR-B2-BASE: the API owns the ledger state).

ProbeVerdictTests: the verdict over the two processes' outputs - the append as the sole owner (one new entry, zero
replay duplicates, the external seal over it), then the read-only observation beside the restarted API owner (the same
chain and seal, no new failure record, never an owner and never a recovery) - with each defect refused; run() quiesces
before the append and restarts the API before the observation, and refuses to start without both.
ProbeContainerTests (opt-in, a production API image in KIN_TEST_API_IMAGE and a local Docker daemon): the probe script
runs the product's compiled ledger modules in that image against a disposable provisioned and migrated PostgreSQL and
its own state volume: the append while no API runs, the real API service started on that volume (its own start-up
recovery), the observation beside it; an append beside the live API is refused before any recovery, and an
observation without an API owner never becomes one. Synthetic data only; nothing is cleaned from the ledger inside the
run (the disposable database is removed with its container).
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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
    first = {"operation": "append", "owner": True, "recovery": {"recovered": 0, "notCommitted": 0},
             "tail_before": tail if existed else {"sequence": 4, "hash": "d" * 64}, "existed_before": existed,
             "journal_before": 0, "receipt": {"eventId": PROBE["event_id"], "durableAt": "2026-10-13T01:00:00.000Z"},
             "tail_after": dict(tail), "replay": {"eventId": PROBE["event_id"], "durableAt": "2026-10-13T01:00:00.000Z"},
             "tail_replay": dict(tail), "stored": dict(entry), "sealed": dict(tail), "journal_after": 0}
    second = {"operation": "observe", "owner": False, "tail_before": dict(tail),
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
            "restart seal moved": lambda f, s: s.update(sealed={"sequence": 6, "hash": "f" * 64}),
            "restart journal": lambda f, s: s.update(journal_before=2, journal_after=2),
            "operations swapped": lambda f, s: s.update(operation="append"),
            "the old second-process recovery": lambda f, s: s.update(operation="restart"),
            "append beside another owner": lambda f, s: f.update(owner=False),
            "observation as an owner": lambda f, s: s.update(owner=True),
            "observation with a recovery": lambda f, s: s.update(recovery={"recovered": 0, "notCommitted": 0}),
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


    def test_06_run_quiesces_before_the_append_and_restarts_the_api_owner_before_the_observation(self):
        first, second = outputs()
        calls = []

        class Host:
            def one_shot(self, intro, service, args, **kwargs):
                operation = args[2]
                calls.append(operation)
                return {"exit": 0, "container_exit": 0, "logs": "",
                        "stdout": ("KIN_RESULT " + json.dumps(first if operation == "append" else second) + "\n").encode()}

        class Records:
            def put(self, name, value):
                calls.append("record")
                return "6" * 64

        class Intro:
            plan = {"probe": PROBE}
            state = {"probe_event": {**probe.probe_event(PROBE), "eventId": PROBE["event_id"]}}
            records = Records()

            def save(self):
                calls.append("save")

        with self.assertRaisesRegex(intro.Stop, "quiesced"):
            probe.run(Host(), Intro())
        self.assertEqual(calls, [], "nothing runs without the release tool's quiesce and restart")
        result = probe.run(Host(), Intro(), quiesce=lambda: calls.append("quiesce"), restart=lambda: calls.append("restart"))
        self.assertEqual(calls, ["quiesce", "append", "restart", "observe", "record"])
        self.assertEqual((result["added"], result["replay_duplicates"], result["restart"]), (1, 0, "same chain and seal"))


def required_handover_status(result):
    return 0 if result.wasSuccessful() and result.testsRun == 2 and not result.skipped else 1


class ProbeSelectionTests(unittest.TestCase):
    def test_missing_image_is_not_a_successful_empty_handover(self):
        env = dict(os.environ)
        env.pop("KIN_TEST_API_IMAGE", None)
        result = subprocess.run([sys.executable, "-B", __file__, "--require-image-handover"], env=env, capture_output=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)

    def test_missing_or_skipped_handover_case_fails_the_required_selection(self):
        for count, skipped in [(0, []), (1, []), (2, [("required", "unavailable")])]:
            result = unittest.TestResult()
            result.testsRun, result.skipped = count, skipped
            self.assertEqual(required_handover_status(result), 1)
        result = unittest.TestResult()
        result.testsRun = 2
        self.assertEqual(required_handover_status(result), 0)

    def test_launcher_matrix_requires_every_case_once_and_no_skip(self):
        spec = importlib.util.spec_from_file_location("b2_mutants", ROOT / "tests" / "emr" / "b" / "mutants.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cases = ["P" + str(n).zfill(2) for n in range(13)]
        lines = ["ok " + str(n + 1) + " - " + name + " synthetic case" for n, name in enumerate(cases)]
        self.assertTrue(module.pg_passes("\n".join(lines), cases, 0))
        for text in ["\n".join(lines[:-1]), "\n".join(lines + [lines[0]]), "\n".join(lines) + " # SKIP"]:
            self.assertFalse(module.pg_passes(text, cases, 0))
        self.assertFalse(module.pg_passes("\n".join(lines), cases, 1))


@unittest.skipUnless(sys.platform == "linux" and shutil.which("node") and (ROOT / "api" / "node_modules" / "typescript").is_dir(),
                     "the kernel fence (flock) and the installed TypeScript loader: Linux with api/node_modules")
class ProbeOwnerTests(unittest.TestCase):
    """The probe script over the product modules (api/src through tests/service_test_loader.cjs) and a real state
    directory, without a database: the ownership decision comes before any connection or recovery."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="emr-probe-owner-")
        self.addCleanup(folder.cleanup)
        self.state = Path(folder.name) / "state"
        self.state.mkdir(mode=0o700)
        self.env = {**os.environ, "KIN_EMR_STATE_DIR": str(self.state),
                    "DATABASE_URL": "postgresql://kin_runtime:Synthetic-Probe-Secret-0001@127.0.0.1:1/kin?connect_timeout=2"}
        self.loader = str(ROOT / "tests" / "service_test_loader.cjs")

    def probe(self, operation, value):
        result = subprocess.run(["node", "-r", self.loader, "-e", probe.PROBE_SCRIPT, operation, json.dumps(value)], cwd=ROOT,
                                env=self.env, capture_output=True, timeout=120)
        return result.returncode, intro.result_line(result.stdout)

    def test_07_an_append_beside_a_live_owner_and_an_observation_without_one_are_refused(self):
        owner = subprocess.Popen(["node", "-r", self.loader, "-e",
                                  "new (require('/app/dist/emr-runtime/coordinator').StateCoordinator)(process.env.KIN_EMR_STATE_DIR);"
                                  "console.log('EMR_OWNER_READY');setInterval(()=>{},1000)"],
                                 cwd=ROOT, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.assertEqual(owner.stdout.readline().decode().strip(), "EMR_OWNER_READY")
            code, result = self.probe("append", {"event": probe.probe_event(PROBE)})
            self.assertEqual((code, result), (1, {"operation": "append", "error": "EmrStateOwnerBusy"}),
                             "refused as a client of the live owner, before the database and any recovery")
        finally:
            owner.kill()
            owner.wait(timeout=30)
        # No owner now: the observation stays a client and fails rather than taking the fence.
        code, result = self.probe("observe", {"eventId": PROBE["event_id"]})
        self.assertEqual(code, 1)
        self.assertEqual(result["operation"], "observe")
        self.assertIn("error", result)
        self.assertNotIn("owner", result)


@unittest.skipUnless(os.environ.get("KIN_TEST_API_IMAGE"), "a production API image in KIN_TEST_API_IMAGE is required")
class ProbeContainerTests(unittest.TestCase):
    """The probe script in the real image: the append while no API runs, the real API owner's restart, the observation."""

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

    def process(self, operation, value, expected=0):
        result = subprocess.run(["docker", "run", "--rm", "--network", "container:" + self.db, "--label", "kin.ops.run=" + self.token,
                                 "-e", "DATABASE_URL=postgresql://kin_runtime@127.0.0.1:5432/kin", "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
                                 "--mount", "type=volume,source=" + self.state + ",target=" + ops.EMR_STATE, "--entrypoint", "node",
                                 self.image, "--max-old-space-size=3072", "-e", probe.PROBE_SCRIPT, operation, json.dumps(value)], capture_output=True, timeout=180)
        print(json.dumps({"probe_process": operation, "exit": result.returncode,
                          "stdout": result.stdout.decode(errors="replace"), "stderr": result.stderr.decode(errors="replace")}), flush=True)
        self.assertEqual(result.returncode, expected, result.stdout.decode(errors="replace")[-2000:] + result.stderr.decode(errors="replace")[-2000:])
        return intro.result_line(result.stdout)

    def start_api(self):
        """The real API service on the probe's state volume: its own start owns the fence and recovers the state."""
        name = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + uuid.uuid4().hex[:16] + "-probe-api"
        env = {"DATABASE_URL": "postgresql://kin_runtime@127.0.0.1:5432/kin", "KIN_EMR_STATE_DIR": ops.EMR_STATE,
               "NODE_OPTIONS": "--max-old-space-size=3072",
               "DEPLOYMENT_MODE": "production", "AUTH_REQUIRED": "true", "KC_ISSUER": "http://127.0.0.1:1/auth/realms/kin",
               "KC_JWKS_URL": "http://127.0.0.1:1/certs", "KC_AUDIENCE": "kin-api", "KC_WEB_SECRET": uuid.uuid4().hex,
               "KIN_COOKIE_SECRET": uuid.uuid4().hex, "PUBLIC_ORIGIN": "http://127.0.0.1:3000", "ORTHANC_USER": "synthetic-probe",
               "ORTHANC_PASS": uuid.uuid4().hex, "KC_ADMIN_URL": "http://127.0.0.1:1/auth", "KC_REALM": "kin", "KC_CLIENT_ID": "kin-api",
               "KC_CLIENT_SECRET": uuid.uuid4().hex}
        args = ["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + self.token, "--network", "container:" + self.db,
                "--mount", "type=volume,source=" + self.state + ",target=" + ops.EMR_STATE]
        for key, value in env.items():
            args += ["-e", key + "=" + value]
        self.addCleanup(ops.remove_owned_if_present, "container", name, self.token)
        ops.run([*args, self.image])
        deadline = time.monotonic() + 90
        while ops.run(["docker", "exec", name, "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(r.status!==200)process.exit(1)})"
                       ".catch(()=>process.exit(1))"], check=False).returncode:
            if time.monotonic() > deadline or not json.loads(ops.text(["docker", "inspect", name]))[0]["State"]["Running"]:
                self.fail("The API owner did not start: " + ops.run(["docker", "logs", name], check=False).stderr.decode(errors="replace")[-1500:])
            time.sleep(0.5)
        return name

    def stop_api(self, name):
        ops.run(["docker", "stop", "--time", "30", name])
        state = json.loads(ops.text(["docker", "inspect", name]))[0]["State"]
        self.assertFalse(state["Running"], "confirmed API exit precedes another owner")
        self.assertEqual(state["ExitCode"], 0, "clean SIGTERM exit")
        logs = ops.run(["docker", "logs", name], check=False)
        print(json.dumps({"api": name, "exit": state["ExitCode"], "stdout": logs.stdout.decode(errors="replace"),
                          "stderr": logs.stderr.decode(errors="replace")}), flush=True)

    def stored_event(self, event):
        # Observe storage and calculate retention through the shipped rule while the real API owns state.
        script = """const {PrismaClient}=require('/app/node_modules/@prisma/client');
const {PrismaLedgerSql}=require('/app/dist/emr-runtime/store');
const {accessDeadline,recordTargets}=require('/app/dist/emr-runtime/contract');
const db=new PrismaClient();
(async()=>{const row=await new PrismaLedgerSql(db).entryForEvent('viewing',process.argv[1]);
if(!row)throw Error('missing event'); const payload=JSON.parse(row.payload);
console.log(JSON.stringify({payload,retention:accessDeadline('viewing',{occurredAt:payload.occurredAt,targets:recordTargets(payload)})}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());"""
        result = ops.run(["docker", "run", "--rm", "--network", "container:" + self.db, "--label", "kin.ops.run=" + self.token,
                          "-e", "DATABASE_URL=postgresql://kin_runtime@127.0.0.1:5432/kin", "--entrypoint", "node",
                          self.image, "--max-old-space-size=3072", "-e", script, event["eventId"]])
        value = json.loads(result.stdout)
        self.assertEqual(value["payload"], event)
        self.assertEqual(value["retention"], "2028-10-11T15:00:00.000Z", "two calendar years, at the KST civil-day boundary")
        return value

    def test_05_probe_appends_as_sole_owner_and_observes_after_the_api_owner_restart(self):
        event = probe.probe_event({**PROBE, "event_id": str(uuid.uuid4())}, datetime(2026, 10, 12, tzinfo=timezone.utc))
        original_api = self.start_api()
        self.stop_api(original_api)
        first = self.process("append", {"event": event})                  # no API runs: the probe is the sole owner
        api = self.start_api()                                             # the API owner's own start-up recovery
        refused = self.process("append", {"event": event}, expected=1)     # beside the live owner: refused, no recovery
        self.assertEqual(refused, {"operation": "append", "error": "EmrStateOwnerBusy"})
        second = self.process("observe", {"eventId": event["eventId"]})    # a client of the live owner, read only
        try:
            evidence = probe.verify(first, second, event["eventId"])
        except intro.Stop as error:
            self.fail(str(error))
        stored = self.stored_event(event)
        self.assertEqual((evidence["added"], evidence["replay_duplicates"]), (1, 0))
        self.stop_api(api)
        # The same probe again (a re-run of the phase) is a replay: still one entry for the event.
        again = self.process("append", {"event": event})
        api = self.start_api()
        third = self.process("observe", {"eventId": event["eventId"]})
        try:
            evidence = probe.verify(again, third, event["eventId"])
        except intro.Stop as error:
            self.fail(str(error))
        self.assertEqual(evidence["added"], 0)
        self.assertEqual(again["stored"], first["stored"])
        self.assertEqual(self.stored_event(event), stored)
        self.stop_api(api)
        # No API owner: an observation stays a client and fails instead of taking the fence.
        alone = self.process("observe", {"eventId": event["eventId"]}, expected=1)
        self.assertNotIn("owner", alone)
        print(json.dumps({"probe_container": True, "entry": evidence["entry"], "image": self.image,
                          "database": self.db, "state_volume": self.state, "stored": stored}), flush=True)

    def test_06_restore_guard_refuses_running_source_and_recovers_only_paired_copy(self):
        """TEST-B2D-07-RESTORE: actual mount identities and product recovery, with labelled disposable resources."""
        from ops_product_transfer_fixture import provision
        event = probe.probe_event({**PROBE, "event_id": str(uuid.uuid4())}, datetime(2026, 10, 12, tzinfo=timezone.utc))
        self.process("append", {"event": event})
        target_db = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + uuid.uuid4().hex[:16] + "-copy-db"
        target_state = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + uuid.uuid4().hex[:16] + "-copy-state"
        for kind, name in [("container", target_db), ("volume", target_state)]:
            self.addCleanup(ops.remove_owned_if_present, kind, name, self.token)
        ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + self.token, target_state])
        ops.run(["docker", "run", "-d", "--name", target_db, "--label", "kin.ops.run=" + self.token, "--network", "none",
                 "--tmpfs", "/var/lib/postgresql/data", "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=kin", "postgres:16-alpine"])
        deadline = time.monotonic() + 60
        while ops.run(["docker", "exec", target_db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode:
            if time.monotonic() > deadline:
                self.fail("Disposable restore database did not start")
            time.sleep(0.5)
        provision(target_db)
        with tempfile.TemporaryFile() as dump:
            ops.run(["docker", "exec", self.db, "pg_dump", "-U", "postgres", "-Fc", "kin"], output=dump)
            dump.seek(0)
            ops.run(["docker", "exec", "-i", target_db, "pg_restore", "-U", "postgres", "-d", "kin", "--exit-on-error"], input_file=dump)
        # No API is running during this paired copy. Source is mounted read-only by the short-lived copy process.
        ops.run(["docker", "run", "--rm", "--network", "none", "--label", "kin.ops.run=" + self.token,
                 "--mount", "type=volume,source=" + self.state + ",target=/source,readonly",
                 "--mount", "type=volume,source=" + target_state + ",target=" + ops.EMR_STATE, "--entrypoint", "sh", self.image,
                 "-c", "set -eu; tar -C /source -cf - . | tar -C /var/lib/kin-emr -xf -"])
        api = self.start_api()
        before = self.stored_event(event)
        digest_script = """const fs=require('fs'),crypto=require('crypto'),path=require('path');const rows=[];
function scan(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),s=fs.lstatSync(file);
if(s.isDirectory())scan(file);else if(s.isFile())rows.push([file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);}}
scan('/source');console.log(JSON.stringify(rows));"""
        def source_hashes():
            return json.loads(ops.text(["docker", "run", "--rm", "--network", "none", "--label", "kin.ops.run=" + self.token,
                                      "--mount", "type=volume,source=" + self.state + ",target=/source,readonly",
                                      "--entrypoint", "node", self.image, "--max-old-space-size=3072", "-e", digest_script]))
        hashes = source_hashes()
        with self.assertRaisesRegex(RuntimeError, "mounted by a running container"):
            ops.restore_copy_only(self.state)
        ops.restore_copy_only(target_state)
        verified = ops.text(["docker", "run", "--rm", "--network", "container:" + target_db, "--label", "kin.ops.run=" + self.token,
                             "-e", "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/kin",
                             "--mount", "type=volume,source=" + target_state + ",target=" + ops.EMR_STATE,
                             "--entrypoint", "node", self.image, "--max-old-space-size=3072", "-e", ops.EMR_RECOVERY_SCRIPT])
        self.assertEqual(verified, "EMR_RESTORE_VERIFIED")
        self.assertEqual(source_hashes(), hashes, "restore must not change any source state file")
        self.assertEqual(self.stored_event(event), before, "live source event/content/retention unchanged")
        self.assertNotEqual(target_state, self.state)
        self.assertNotEqual(target_db, self.db)
        print(json.dumps({"restore": verified, "source_db": self.db, "target_db": target_db,
                          "source_state": self.state, "target_state": target_state, "source_hashes": hashes}), flush=True)
        self.stop_api(api)


if __name__ == "__main__":
    if "--require-image-handover" in sys.argv:
        if not os.environ.get("KIN_TEST_API_IMAGE", "").startswith("sha256:"):
            raise SystemExit("Mandatory handover requires an inspected immutable KIN_TEST_API_IMAGE")
        suite = unittest.defaultTestLoader.loadTestsFromNames([
            "ProbeContainerTests.test_05_probe_appends_as_sole_owner_and_observes_after_the_api_owner_restart",
            "ProbeContainerTests.test_06_restore_guard_refuses_running_source_and_recovers_only_paired_copy"], sys.modules[__name__])
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(required_handover_status(result))
    else:
        unittest.main(verbosity=2)
