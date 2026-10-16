"""Round 4 contracts: observations, worker lifetime and immutable Compose handover.

These are behaviour tests. They inject host outcomes and inspect durable decisions, without source-string assertions.
The synthetic strings below are fixtures and contain no credentials. Actual Docker/systemd rehearsals are separate.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_emr_introduction as release
import ops_emr_introduction_test as fixtures


# The consultation's closed action inventory, independent of the implementation's STEPS table.
ACTION_CONTRACT = {
    "capture": (("L-00a", "checkout_mode"), ("L-00b", "reconcile_checkout"), ("L-01", "baseline"),
                ("L-04a", "fence"), ("L-04b", "capture_b0"), ("L-04c", "restore_check_b0")),
    "release": (("RL-01", "unfence"), ("RL-02", "public_check_previous")),
    "introduce": (("I-00", "recheck_fence"), ("L-06a", "storage"), ("L-06b", "provision"), ("L-07", "migrate"),
                  ("L-08a", "keycloak"), ("L-08b", "member_import"), ("L-09a", "api"), ("L-09b", "proxy_ui")),
    "verify": (("L-10a", "fenced_smoke"), ("L-10b", "probe"), ("L-10c", "capture_b1"), ("L-10d", "resume"),
               ("L-10e", "remove_smoke_member")),
    "reopen": (("L-11a", "final_allowlist"), ("L-11b", "restore_jobs"), ("L-11c", "reopen_ingress"), ("L-11d", "public_smoke")),
    "rollback": (("RB-00", "classify"), ("RB-01", "preserve_failed"), ("RB-02", "restore_b0"), ("RB-03", "previous_services")),
    "rollback_reopen": (("RB-04a", "recovery_persisted"), ("RB-04b", "fenced_previous_smoke"),
                        ("RB-04c", "restore_jobs_after_rollback"), ("RB-04d", "reopen_previous_ingress"), ("RB-04e", "public_previous_smoke")),
    "seed": (("S-01", "seed_check"), ("S-02", "seed_restore"), ("S-03", "seed_services")),
    "receipt": (("RC-01", "write_receipt"),),
}


class ObservationContracts(fixtures.MachineHarness, unittest.TestCase):
    def test_receipt_tool_identity_includes_the_entry_and_unchanged_runner(self):
        source = Path(__file__).resolve().parents[1] / "scripts"
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            for path in source.glob("ops_*.py"):
                shutil.copyfile(path, folder / path.name)
            original = release.tool_hashes(folder)
            for name in ("ops_deploy_entry.py", "ops_deploy_runner.py"):
                with self.subTest(file=name):
                    self.assertIn(name, original)
                    previous = (folder / name).read_bytes()
                    (folder / name).write_bytes(previous + b"\n# synthetic partial installation\n")
                    changed = release.tool_hashes(folder)
                    self.assertNotEqual(changed, original)
                    self.assertEqual([key for key in original if original[key] != changed[key]], [name])
                    (folder / name).write_bytes(previous)

    def test_receipt_uses_the_operations_lock_and_releases_it_on_a_known_refusal(self):
        self.kind = "rehearsal"
        for phase in ("seed", "capture", "introduce", "verify", "rollback", "rollback_reopen"):
            self.assertTrue(self.run_phase(phase)["phase_passed"])
        token = release.acquire_lock(self.repository)
        before = list(self.ops.calls)
        try:
            with self.assertRaises(release.Stop):
                self.run_phase("receipt")
            self.assertEqual(self.ops.calls, before)
            self.assertTrue(release.lock_owned(self.repository, token))
        finally:
            release.release_lock(self.repository, token)
        self.ops.faults["write_receipt"] = release.Stop("합성 영수증 거절")
        self.assertFalse(self.run_phase("receipt")["phase_passed"])
        self.assertFalse(self.lock_held())
        self.ops.faults.clear()
        result = self.run_phase("receipt")
        self.assertTrue(result["phase_passed"])
        recorded = json.loads((self.records.directory / ("result-receipt-" + result["request_sha256"][:16] + ".json")).read_bytes())
        self.assertTrue(recorded["steps"][0]["before"]["facts"]["lock"]["value"]["owned"])
        self.assertFalse(self.lock_held())

    def test_every_action_refuses_missing_before_and_holds_on_pass_or_stop_after_error(self):
        prefixes = {"capture": [], "release": ["capture"], "introduce": ["capture"],
                    "verify": ["capture", "introduce"], "reopen": ["capture", "introduce", "verify"],
                    "rollback": ["capture", "introduce", "verify"],
                    "rollback_reopen": ["capture", "introduce", "verify", "rollback"], "seed": [],
                    "receipt": ["seed", "capture", "introduce", "verify", "rollback", "rollback_reopen"]}
        actions = [(phase, sid, name) for phase, steps in ACTION_CONTRACT.items() for sid, name in steps]
        actions.append(("introduce", "I-RV", "revert_configuration"))
        for phase, sid, name in actions:
            for boundary, command_stop in (("before", False), ("after", False), ("after", True),
                                             ("timeout", True), ("after-query-error", False)):
                with self.subTest(phase=phase, step=sid, boundary=boundary, command_stop=command_stop):
                    self.setUp()
                    if phase in ("seed", "receipt"):
                        self.kind = "rehearsal"
                    def run(phase):
                        side = self.local_restore() if phase == "introduce" and self.kind == "production" else (
                            self.operator_smoke() if phase == "reopen" else None)
                        return self.run_phase(phase, side)
                    for earlier in prefixes[phase]:
                        self.assertTrue(run(earlier)["phase_passed"], earlier)
                    if sid == "I-RV":
                        self.ops.faults["storage"] = release.Stop("합성 변경 전 실패")
                    original = self.ops.snapshot
                    hit = []
                    def snapshot(context):
                        value = original(context)
                        part = "after" if boundary in ("timeout", "after-query-error") else boundary
                        if context.records.context == {"step": sid, "part": part}:
                            hit.append(True)
                            if boundary == "after-query-error":
                                value["facts"]["containers"] = release.observation_error(OSError())
                            elif boundary != "timeout":
                                value["facts"].pop("workers")
                        return value
                    self.ops.snapshot = snapshot
                    if command_stop:
                        self.ops.faults[name] = (release.Unknown("합성 작업 timeout") if boundary == "timeout"
                                                else release.Stop("합성 확정 실패"))
                    before_calls = len(self.ops.calls)
                    result = run(phase)
                    self.assertTrue(hit, "the intended boundary must be reached")
                    outcomes = [row["outcome"] for row in result["steps"] if row["step"] == sid]
                    unchanged_entry = sid in ("L-00a", "S-01", "S-02") and boundary == "before"
                    expected = "STOP" if unchanged_entry else "UNKNOWN"
                    self.assertEqual(outcomes, [expected])
                    self.assertFalse(result["phase_passed"])
                    if boundary == "before":
                        self.assertNotIn(name, self.ops.calls[before_calls:])
                    if expected == "UNKNOWN":
                        self.assertEqual(result["status"], "NEEDS_ATTENTION")
                        self.assertIsNotNone(self.records.state()["unknown_hold"])

    def test_initial_observation_error_stops_without_action(self):
        original = self.ops.snapshot
        def unavailable(context):
            value = original(context)
            value["facts"]["containers"] = {"outcome": "ERROR", "reason": "daemon"}
            return value
        self.ops.snapshot = unavailable
        result = self.run_phase("capture")
        self.assertFalse(result["phase_passed"])
        self.assertEqual(self.ops.calls, [])
        self.assertIsNone(self.records.state()["unknown_hold"])
        self.assertFalse(self.lock_held())

    def test_stop_after_observation_failure_is_durable_unknown(self):
        self.assertEqual(self.run_phase("capture")["status"], "HELD")
        original = self.ops.snapshot
        self.ops.faults["migrate"] = release.Stop("합성 명령 실패")
        def unavailable(context):
            value = original(context)
            if context.records.context == {"step": "L-07", "part": "after"}:
                value["facts"]["database"] = {"outcome": "ERROR", "reason": "daemon"}
            return value
        self.ops.snapshot = unavailable
        result = self.run_phase("introduce", self.local_restore())
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual(self.records.state()["unknown_hold"]["step"], "L-07")
        self.assertNotIn("classify", self.ops.calls)
        self.ops.snapshot = original
        self.ops.faults.clear()
        for phase in ("release", "rollback", "verify", "reopen", "receipt"):
            with self.subTest(phase=phase), self.assertRaisesRegex(release.Stop, "UNKNOWN"):
                self.run_phase(phase)
        self.assertTrue(self.lock_held())

    def test_schema_omissions_and_error_outcomes_are_not_observations(self):
        context = self.machine()
        context.state = release.new_state(context.plan_sha256, context.plan)
        sample = self.ops.snapshot(context)
        self.assertTrue(release.observed(sample))
        for field in ("checkout", "compose_entry", "lock", "containers", "database", "fences", "workers"):
            for change in ("missing", "error", "empty", "absent"):
                value = copy.deepcopy(sample)
                if change == "missing":
                    del value["facts"][field]
                else:
                    value["facts"][field] = {"error": {"outcome": "ERROR", "reason": "fixture"},
                                             "empty": {}, "absent": {"outcome": "ABSENT"}}[change]
                with self.subTest(field=field, change=change):
                    self.assertFalse(release.observed(value))

    def test_seed_database_absence_has_three_exact_boundaries(self):
        context = self.machine()
        context.state = release.new_state(context.plan_sha256, context.plan)
        value = self.ops.snapshot(context)
        value["facts"]["containers"]["value"]["db"] = {"outcome": "ABSENT"}
        value["facts"]["database"] = {"outcome": "ABSENT"}
        for step, boundary, expected in (("S-01", "before", True), ("S-01", "after", True), ("S-02", "before", True),
                                         ("S-02", "after", False), ("S-03", "before", False), ("RB-02", "before", False),
                                         ("RB-02", "after", False), ("RB-02", "db-removed", True), ("RC-01", "after", False)):
            value["checkpoint"] = [step, boundary]
            with self.subTest(step=step, boundary=boundary):
                self.assertEqual(release.observed(value), expected)

    def test_cron_attempt_records_ponr_before_it_runs(self):
        self.deploy_through("verify")
        observed = []
        def inspect_marker(context):
            observed.append((self.records.state().get("ponr") or {}).get("step"))
            raise release.Stop("예약 작업 복구 실패")
        self.ops.effect_restore_jobs = inspect_marker
        result = self.run_phase("reopen", self.operator_smoke())
        self.assertEqual(observed, ["L-11b"])
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertNotIn("reopen_ingress", self.ops.calls)
        with self.assertRaises(release.Stop):
            self.run_phase("rollback")

    def test_recovery_cron_attempt_records_marker_before_it_runs(self):
        self.deploy_through("verify")
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")
        observed = []
        def inspect_marker(context):
            observed.append((self.records.state().get("recovery_reopen") or {}).get("step"))
            raise release.Unknown("예약 작업 종료 불명")
        self.ops.effect_restore_jobs_after_rollback = inspect_marker
        result = self.run_phase("rollback_reopen")
        self.assertEqual(observed, ["RB-04c"])
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIsNotNone(self.records.state()["unknown_hold"])


class ComposeBundleContracts(unittest.TestCase):
    def setUp(self):
        parent = "/root" if os.name == "posix" and os.geteuid() == 0 else None
        folder = tempfile.TemporaryDirectory(prefix="release-r4-", dir=parent)
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        if os.name == "posix":
            self.root.chmod(0o700)
        self.repo = self.root / "checkout"
        self.repo.mkdir()
        self.entry = release.ComposeEntry(self.root / "entries")
        self.sources = [("docker-compose.yml", b"services: {}\n"), ("docker-compose.prod.yml", b"services: {}\n"),
                        ("/etc/kin-deploy/overlays/docker-compose.halo-reports.yml", b"services: {}\n"),
                        ("docker-compose.monitor.yml", b"services: {}\n")]
        self.parameters = dict(repository=self.repo, project="synthetic", sources=self.sources,
                               env_raw=b"VALUE='fixture $ with space'\n", values={"VALUE": "fixture $ with space", "EMPTY": ""},
                               runtime="services: {}\n", plan_sha256="1" * 64, validate=lambda *args: None)

    def test_installed_admission_closes_production_and_vm_file_lists(self):
        target = fixtures.target_fixture()
        halo = self.sources[2][0]
        target.update(compose_files=[name for name, _ in self.sources],
                      declared_overlays=[{"file": halo, "sha256": "f" * 64, "service": "proxy",
                                          "binds": [{"source": "/srv/halo-reports/nginx/report.conf",
                                                     "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}]}],
                      external_networks={"proxy": {"halo_reports": "halo_reports_private"}})
        release.target_valid(target, operational=True)
        for change in (lambda t: t["compose_files"].pop(), lambda t: t["compose_files"].reverse(),
                       lambda t: t["compose_files"].remove(halo),
                       lambda t: t["declared_overlays"][0]["binds"][0].update(read_only=False)):
            changed = copy.deepcopy(target)
            change(changed)
            with self.assertRaises(release.Stop):
                release.target_valid(changed, operational=True)
        clone = fixtures.target_fixture("rehearsal")
        clone.update({name: copy.deepcopy(target[name]) for name in ("compose_files", "declared_overlays", "external_networks")})
        clone["compose_files"].insert(2, "/srv/kin/rehearsal-override.yml")
        release.target_valid(clone, operational=True)
        clone["compose_files"][2], clone["compose_files"][3] = clone["compose_files"][3], clone["compose_files"][2]
        with self.assertRaises(release.Stop):
            release.target_valid(clone, operational=True)

    def test_new_process_reads_immutable_inputs_after_checkout_and_overlay_vanish(self):
        pointer = self.entry.publish(**self.parameters)
        self.repo.rmdir()
        script = "import json,sys;sys.path.insert(0,sys.argv[1]);import ops_emr_introduction as r;print(json.dumps(r.ComposeEntry(sys.argv[2]).argv(['config'])))"
        result = subprocess.run([sys.executable, "-B", "-c", script, str(Path(release.__file__).parent), str(self.entry.root)],
                                capture_output=True, timeout=30, check=True, env={**os.environ, "COMPOSE_FILE": "wrong", "VALUE": "poison"})
        command, environment = json.loads(result.stdout)
        self.assertEqual(environment, self.parameters["values"])
        files = [command[index + 1] for index, arg in enumerate(command) if arg == "-f"]
        self.assertEqual([Path(name).read_bytes() for name in files[:-1]], [raw for _, raw in self.sources])
        self.assertEqual(Path(files[-1]).read_text(), self.parameters["runtime"])
        self.assertEqual(self.entry.load()[0], pointer)

    def test_common_command_uses_existing_pinned_files_and_complete_captured_values(self):
        self.entry.publish(**self.parameters)
        command, values = self.entry.argv(["config"])
        files = [command[index + 1] for index, word in enumerate(command) if word == "-f"]
        self.assertTrue(all(Path(path).is_file() for path in files), files)
        self.assertTrue(all(self.entry.root in Path(path).parents for path in files))
        self.assertEqual(values, self.parameters["values"])

    def test_failed_candidate_validation_preserves_previous_active_generation(self):
        previous = self.entry.publish(**self.parameters)
        def fail(*args):
            raise release.Stop("합성 config 실패")
        with self.assertRaises(release.Stop):
            self.entry.publish(**{**self.parameters, "runtime": "services: {api: {image: changed}}\n", "validate": fail})
        self.assertEqual(self.entry.load()[0], previous)

    def test_every_pinned_component_and_pointer_is_checked(self):
        pointer = self.entry.publish(**self.parameters)
        _, manifest, _ = self.entry.load()
        paths = [self.entry.root / pointer["generation"] / name for name in manifest["files"]]
        paths += [self.entry.root / pointer["generation"] / "manifest.json", self.entry.root / "active.json"]
        for path in paths:
            original = path.read_bytes()
            path.write_bytes(b"{}")
            try:
                with self.subTest(file=path.name), self.assertRaises((release.Stop, ValueError, KeyError)):
                    self.entry.load()
            finally:
                path.write_bytes(original)

    def test_bundle_cannot_live_in_checkout_or_admit_control_environment(self):
        with self.assertRaises(release.Stop):
            release.ComposeEntry(self.repo / "entries").publish(**self.parameters)
        with self.assertRaises(release.Stop):
            self.entry.publish(**{**self.parameters, "values": {"COMPOSE_FILE": "wrong"}})

    @unittest.skipUnless(shutil.which("docker"), "실제 Compose CLI가 필요합니다")
    def test_actual_compose_new_process_uses_pins_and_literal_environment(self):
        fixed_image = "sha256:" + "a" * 64
        sources = [(self.sources[0][0], b'services:\n  api:\n    image: ${API_IMAGE:-stale:latest}\n    environment:\n      VALUE: ${VALUE}\n      EMPTY: ${EMPTY-default}\n'), *self.sources[1:]]
        parameters = {**self.parameters, "sources": sources,
                      "runtime": 'services:\n  api:\n    image: "' + fixed_image + '"\n'}
        runner = release.Runner(self.repo)
        def validate(command, environment):
            result = runner(command, env=environment, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        pointer = self.entry.publish(**{**parameters, "validate": validate})
        (self.repo / ".env").write_text("VALUE=poison\nAPI_IMAGE=stale:latest\nCOMPOSE_FILE=missing.yml\n", encoding="utf-8")
        script = ("import json,subprocess,sys;sys.path.insert(0,sys.argv[1]);import ops_emr_introduction as r;"
                  "a,e=r.ComposeEntry(sys.argv[2]).argv(['config','--format','json']);"
                  "p=subprocess.run(a,env=r.compose_environment(e),capture_output=True,timeout=30);"
                  "sys.stdout.buffer.write(p.stdout);sys.stderr.buffer.write(p.stderr);sys.exit(p.returncode)")
        process = subprocess.run([sys.executable, "-B", "-c", script, str(Path(release.__file__).parent), str(self.entry.root)],
                                 env={**os.environ, "VALUE": "caller-poison", "COMPOSE_FILE": "caller-missing.yml"},
                                 capture_output=True, timeout=40, check=True)
        service = json.loads(process.stdout)["services"]["api"]
        self.assertEqual(service["image"], fixed_image)
        # `compose config` escapes dollars in its reusable output. The runtime env needs a container rehearsal too.
        self.assertEqual(service["environment"], {"VALUE": "fixture $$ with space", "EMPTY": ""})
        self.assertEqual(self.entry.load()[0], pointer)

    @unittest.skipUnless(shutil.which("docker"), "실제 Compose CLI가 필요합니다")
    def test_forward_and_recovery_helpers_cannot_change_the_open_entry_back_to_maintenance(self):
        target = fixtures.target_fixture(repository=str(self.repo))
        plan = fixtures.plan_fixture(target)
        base_model = {"services": {role: {"image": "stale:latest"} for role in release.ROLES},
                      "volumes": {"pg-db": {}, "orthanc-db": {}}}
        base_model["services"]["db"]["volumes"] = ["pg-db:/var/lib/postgresql/data"]
        base_model["services"]["orthanc"]["volumes"] = ["orthanc-db:/var/lib/orthanc/db"]
        base_model["services"]["proxy"]["ports"] = ["443:443"]
        source = json.dumps(base_model)
        runner = release.Runner(self.repo)
        records = release.Records(self.root / "records")
        host = release.HostOps(target=target, plan=plan, runner=runner, records=records, entry_root=self.entry.root)
        context = SimpleNamespace(plan=plan, plan_sha256="1" * 64, state={}, save=lambda: records.save(context.state))
        host.intro = context
        host.entry_inputs = {"sources": [("docker-compose.yml", source.encode())], "env_raw": b"", "values": {}}
        for side, marker in (("target", "ponr"), ("previous", "recovery_reopen")):
            context.state = {"checkout": side, "fenced": {"cron": "saved"}, marker: {"step": "fixture"}}
            if side == "previous":
                context.state["recovery"] = {"project": "synthetic-rb", "pg": "synthetic-rb-pg", "orthanc": "synthetic-rb-orthanc"}
            # This is the same default runtime selection that helper invocations use after a successful reopen.
            result = host.compose(["config", "--format", "json"], override=host.pins(context), mutating=False)
            model = json.loads(result.stdout)
            expected = plan["release" if side == "target" else "previous"]["images"]
            self.assertEqual({role: model["services"][role]["image"] for role in release.ROLES}, expected)
            self.assertEqual(model["services"]["proxy"]["ports"][0]["published"], "443")
            if side == "previous":
                self.assertEqual(model["name"], "synthetic-rb")
                self.assertEqual(model["volumes"]["pg-db"]["name"], "synthetic-rb-pg")
                self.assertEqual(model["volumes"]["orthanc-db"]["name"], "synthetic-rb-orthanc")


class ContainerObservationContracts(unittest.TestCase):
    def test_rollback_admission_checks_held_b0_before_stopping_or_preserving_anything(self):
        case = fixtures.RoundThreeHostTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        host, docker, context = case.host()
        directory = case.root / "b0"
        directory.mkdir()
        context.plan["backup_root"] = str(case.root)
        context.plan["budget"]["min_free_bytes"] = 0
        context.state.update(db_changed=True, ponr=None, recovery_reopen=None, unknown_hold=None, rollback_attempted=False,
                             b0={"dir": str(directory), "manifest_sha256": "a" * 64, "restore_check": {"success": True}})
        host.hold(directory, context.plan_sha256, True)
        hold = directory / release.ops.HOLD_FILE
        with patch.object(host, "one_shots_alive", return_value=[]), patch.object(host, "stop_writers") as stop, \
                patch.object(host, "freeze_without_cron", return_value={"cron": "fenced"}), \
                patch.object(release.ops, "validate_held", return_value=(directory, {}, "a" * 64)) as validate:
            host.classify(context)
            self.assertEqual(stop.call_count, 1)
            self.assertEqual(validate.call_args.args, (directory, "a" * 64))
            for field, value in (("ponr", {"step": "L-11b"}), ("unknown_hold", {"step": "L-07"}),
                                 ("rollback_attempted", True), ("db_changed", False)):
                previous = context.state[field]
                context.state[field] = value
                with self.subTest(field=field), self.assertRaises(release.Stop):
                    host.classify(context)
                context.state[field] = previous
            hold.write_text(json.dumps({"plan_sha256": "different", "reason": "emr-introduction"}))
            with self.assertRaises(release.Stop):
                host.classify(context)
            self.assertEqual(stop.call_count, 1)
            with self.assertRaises(release.Stop):
                host.hold(directory, context.plan_sha256, False)
            self.assertTrue(hold.exists())

    def test_host_migration_rows_are_complete_and_unfinished_is_a_known_refusal(self):
        case = fixtures.RoundThreeHostTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        host, docker, context = case.baseline_host()
        context.target = host.t
        context.state["lock_token"] = release.acquire_lock(host.repo)
        self.addCleanup(release.release_lock, host.repo, context.state["lock_token"])
        case.records.context = {"step": "L-01", "part": "after"}
        rows = [row + [True, False] for row in context.plan["migrations"]["before"]]
        docker.psql["pg_stat_activity"] = "0"
        value = host.snapshot(context)
        self.assertTrue(release.observed(value), value)
        release.checkpoint_valid(value, context, "L-01")
        for corrupted in (None, [{"migration": "unknown"}], [rows[0][:2]], [[None, rows[0][1], True, False]],
                          [[rows[0][0], "bad checksum", True, False]], [[rows[0][0], rows[0][1], 1, False]]):
            changed = copy.deepcopy(value)
            changed["facts"]["database"]["value"]["migrations"] = corrupted
            with self.subTest(rows=corrupted):
                self.assertFalse(release.observed(changed))
        changed = copy.deepcopy(value)
        changed["facts"]["database"]["value"]["migrations"][0][2] = False
        self.assertTrue(release.observed(changed), "unfinished is a known state, not a parsing failure")
        with self.assertRaises(RuntimeError):
            release.checkpoint_valid(changed, context, "L-01")

    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="r4-host-", dir="/root" if os.name == "posix" and os.geteuid() == 0 else None)
        self.addCleanup(folder.cleanup)
        self.records = release.Records(Path(folder.name) / "records")

    def host(self, runner):
        target = fixtures.target_fixture()
        return release.HostOps(target=target, plan=fixtures.plan_fixture(target), runner=runner,
                               records=self.records)

    def test_daemon_query_error_cannot_mean_container_or_volume_absence(self):
        calls = []
        def denied(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 1, b"", b"synthetic daemon denied")
        host = self.host(denied)
        with self.assertRaises(release.Stop):
            host.inspect("proxy")
        with self.assertRaises(release.Stop):
            host.volume_exists("synthetic")
        self.assertEqual(len(calls), 2)

    def test_successful_empty_inventory_proves_absence(self):
        host = self.host(lambda args, **kw: subprocess.CompletedProcess(args, 0, b"", b""))
        self.assertIsNone(host.inspect("proxy"))
        self.assertFalse(host.volume_exists("synthetic"))

    def test_real_mount_permissions_extra_mount_anonymous_destination_and_protocol(self):
        target = fixtures.target_fixture()
        plan = fixtures.plan_fixture(target)
        config = fixtures.compose_config(target, previous_images=plan["previous"]["images"])
        config["services"]["orthanc"]["volumes"][1]["read_only"] = True
        runner = fixtures.FakeDocker(target, plan)
        runner.config["pinned"] = config
        host = self.host(runner)
        context = SimpleNamespace(plan=plan, state={"checkout": "previous"})
        model = host.resolved(context, maintenance=False)
        actual = {role: fixtures.running_from(config, role, plan["previous"]["images"][role])
                  for role in ("db", "api", "keycloak", "orthanc", "proxy")}
        release.check_running(actual, model, target)
        mutations = {
            "ro-becomes-rw": lambda data: data["orthanc"]["Mounts"][1].update(RW=True),
            "undeclared-tmpfs": lambda data: data["proxy"]["Mounts"].append({"Type": "tmpfs", "Destination": "/extra", "RW": True}),
            "anonymous-wrong-destination": lambda data: data["proxy"]["Mounts"].append({"Type": "volume", "Name": "a" * 64, "Destination": "/extra", "RW": True}),
            "tcp-becomes-udp": lambda data: data["proxy"]["HostConfig"].update(PortBindings={"443/udp": data["proxy"]["HostConfig"]["PortBindings"]["443/tcp"]}),
            "wrong-image": lambda data: data["api"].update(Image="sha256:" + "f" * 64),
        }
        for name, mutate in mutations.items():
            changed = copy.deepcopy(actual)
            mutate(changed)
            with self.subTest(case=name), self.assertRaises(release.Stop):
                release.check_running(changed, model, target, {"proxy": {"/image-volume": {"read_only": False}}})
        actual["proxy"]["Mounts"].append({"Type": "volume", "Name": "a" * 64, "Destination": "/image-volume", "RW": True})
        release.check_running(actual, model, target, {"proxy": {"/image-volume": {"read_only": False}}})


class OperatorEntryContracts(unittest.TestCase):
    """Common entry admission and command effects; root path enforcement is the separate Linux install suite."""
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="r4-operator-", dir="/root" if os.name == "posix" and os.geteuid() == 0 else None)
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.repo, self.state = self.root / "repo", self.root / "state"
        self.repo.mkdir()
        (self.repo / ".git").mkdir()
        self.state.mkdir(mode=0o700)
        target = release.example_target()
        target.update(fixtures.production_identity(), repository=str(self.repo))
        target["declared_overlays"][0]["sha256"] = release.sha256_bytes(b"services: {}\n")
        self.target = target
        self.plan = fixtures.plan_fixture(target)
        self.plan["tool"] = release.tool_hashes()
        plan_sha = release.plan_identity(self.plan)
        self.run_state = self.state / "emr-runs" / plan_sha / "state.json"
        self.run_state.parent.mkdir(parents=True)
        for group, name, value in (("emr-plans", plan_sha, self.plan),
                                   ("emr-targets", self.plan["target_manifest_sha256"], target)):
            directory = self.state / group
            directory.mkdir()
            (directory / (name + ".json")).write_bytes(release.canonical(value))
        entry = release.ComposeEntry(self.state / "compose-entries")
        pointer = entry.publish(repository=self.repo, project=target["project"],
                                sources=[(name, b"services: {}\n") for name in target["compose_files"]],
                                env_raw=b"", values={}, runtime="services: {}\n", plan_sha256=plan_sha,
                                validate=lambda command, values: None)
        self.finished = {"plan_sha256": plan_sha, "status": "RELEASED", "running": None, "unknown_hold": None,
                         "workers": {}, "lock_token": None, "compose_entry": pointer, "recovery": None}
        self.run_state.write_bytes(release.canonical(self.finished))
        self.docker = fixtures.FakeDocker(target, self.plan)
        self.model = fixtures.compose_config(target, previous_images=self.plan["previous"]["images"],
                                            extra_networks=target["external_networks"]["proxy"],
                                            extra_binds=[{"type": "bind", **row} for row in target["declared_overlays"][0]["binds"]])
        self.docker.config["pinned"] = self.model
        self.docker.volumes = {name["name"]: {"Name": name["name"], "CreatedAt": "2026-10-13T00:00:00Z"}
                               for name in self.model["volumes"].values()}
        self.finished["operational_volumes"] = {name: {"name": name, "created": item["CreatedAt"]}
                                                for name, item in self.docker.volumes.items()}
        self.run_state.write_bytes(release.canonical(self.finished))
        self.docker.containers = {target["containers"][role]: fixtures.running_from(self.model, role, self.plan["previous"]["images"][role])
                                  for role in release.ROLES}
        self.operator = release.IntroductionHost.__new__(release.IntroductionHost)
        self.operator.repository, self.operator.state, self.operator.owner = self.repo, self.state, None
        self.operator.policy = {"targets_allowed": ["production"], "production": fixtures.production_identity()}
        self.operator.host = SimpleNamespace(ENV={}, decode=release.decode,
                                             protected=lambda path, **kwargs: Path(path),
                                             read_secure=lambda path, *args, **kwargs: Path(path).read_bytes())

    def invoke(self, *arguments):
        with patch.object(release, "Runner", return_value=self.docker), \
                patch.object(release, "HostRecords", side_effect=lambda directory, host: release.Records(directory)), \
                patch.object(release, "local_host_key", return_value="a" * 64):
            return self.operator.compose_operation(list(arguments))

    def mutations(self):
        return [args for args in self.docker.calls if args[:2] == ["docker", "compose"] and "up" in args]

    def test_finished_entry_uses_its_pins_for_recreate_and_releases_the_lock(self):
        result = self.invoke("recreate", "proxy")
        self.assertTrue(result["phase_passed"])
        self.assertEqual(result["images"], self.plan["previous"]["images"])
        self.assertEqual(len(self.mutations()), 1)
        command = self.mutations()[0]
        self.assertIn("--pull", command)
        self.assertIn("never", command)
        self.assertFalse(release.lock_path(self.repo).exists())

    def test_unknown_state_and_actual_allowlist_mismatch_refuse_before_recreate(self):
        self.run_state.write_bytes(release.canonical({**self.finished, "unknown_hold": {"step": "L-07"}}))
        with self.assertRaises(release.Stop):
            self.invoke("recreate", "proxy")
        self.assertEqual(self.mutations(), [])
        self.run_state.write_bytes(release.canonical(self.finished))
        self.docker.containers[self.target["containers"]["proxy"]]["Mounts"][-1]["RW"] = True
        with self.assertRaises(release.Stop):
            self.invoke("recreate", "proxy")
        self.assertEqual(self.mutations(), [])
        self.assertFalse(release.lock_path(self.repo).exists())

    def test_recreate_failure_keeps_unknown_and_the_operations_lock(self):
        self.docker.failing = lambda args: args[:2] == ["docker", "compose"] and "up" in args
        with self.assertRaises(release.Stop):
            self.invoke("recreate", "proxy")
        self.assertTrue(release.lock_path(self.repo).exists())
        written, = (self.state / "emr-runs").glob("operator-*/state.json")
        self.assertEqual(json.loads(written.read_bytes())["status"], "UNKNOWN")

    def test_missing_or_replaced_volume_is_never_created_by_ordinary_recreate(self):
        name = self.target["volumes"]["pg"]
        previous = self.docker.volumes.pop(name)
        with self.assertRaises(release.Stop):
            self.invoke("recreate", "db")
        self.assertEqual(self.mutations(), [])
        self.docker.volumes[name] = {**previous, "CreatedAt": "2026-10-13T01:00:00Z"}
        with self.assertRaises(release.Stop):
            self.invoke("recreate", "db")
        self.assertEqual(self.mutations(), [])


class WorkerContracts(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="r4-workers-", dir="/root" if os.name == "posix" and os.geteuid() == 0 else None)
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.records = release.Records(self.root / "records")
        self.records.begin("fixture", "2" * 64)
        target = fixtures.target_fixture(repository=str(self.root))
        self.context = SimpleNamespace(plan_sha256="1" * 64, request_sha256="2" * 64, retrying=False,
                                       state={}, save=lambda: self.records.save(self.context.state))
        self.containers = {}
        self.calls = []
        self.timeout = False
        from ops_deploy_round5_test import EngineFixture
        self.exec_fixture = EngineFixture(self.containers, self.engine)
        self.host = release.HostOps(target=target, plan=fixtures.plan_fixture(target), runner=self.engine, records=self.records)
        self.host.intro = self.context

    def engine(self, args, **kwargs):
        self.calls.append(args)
        stdout = b""
        if args[:3] == ["docker", "system", "dial-stdio"]:
            stdout = self.exec_fixture(kwargs["input"])
        elif args[:3] == ["docker", "container", "ls"]:
            name = args[args.index("--filter") + 1][len("name=^/"):-1]
            stdout = (name + "\n").encode() if name in self.containers else b""
        elif args[:2] == ["docker", "inspect"]:
            stdout = json.dumps([self.containers[args[2]]]).encode()
        elif args[:2] in (["docker", "exec"], ["docker", "run"]):
            # The test examines the durable registry at the external execution boundary, before simulating launch.
            workers = list(self.records.state()["workers"].values())
            self.assertEqual(workers[-1]["state"], "PLANNED")
            self.assertEqual(workers[-1]["request_sha256"], "2" * 64)
            self.assertIn("deadline_utc", workers[-1])
            if self.timeout:
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            if args[1] == "run":
                name = args[args.index("--name") + 1]
                self.containers[name] = {"Id": "d" * 64,
                                         "Config": {"Labels": dict(args[index + 1].split("=", 1) for index, arg in enumerate(args) if arg == "--label")},
                                         "State": {"Running": False, "Restarting": False, "Status": "exited", "ExitCode": 0}}
        elif args[:2] == ["docker", "rm"]:
            self.containers.pop(args[-1])
        return subprocess.CompletedProcess(args, 0, stdout, b"")

    def test_run_registered_before_launch_and_removed_only_after_server_exit(self):
        self.host.cmd(["docker", "run", "--rm", "synthetic", "true"])
        worker, = self.records.state()["workers"].values()
        self.assertEqual((worker["kind"], worker["state"], worker["server_exit"]), ("run", "QUIET", 0))
        self.assertFalse(self.containers)
        removal = next(index for index, args in enumerate(self.calls) if args[:2] == ["docker", "rm"])
        self.assertTrue(any(args[:2] == ["docker", "inspect"] for args in self.calls[:removal]))

    def test_foreign_container_name_is_refused_without_launch_or_removal(self):
        self.containers["existing"] = {"Id": "foreign", "State": {"Running": False, "Restarting": False,
                                                                  "Status": "exited", "ExitCode": 0}}
        with self.assertRaises(release.Stop):
            self.host.cmd(["docker", "run", "--rm", "--name", "existing", "synthetic", "true"])
        self.assertEqual(self.containers["existing"]["Id"], "foreign")
        self.assertFalse(any(args[:2] in (["docker", "run"], ["docker", "rm"]) for args in self.calls))

    def test_terminal_worker_with_a_different_nonce_is_kept_unknown(self):
        engine = self.engine
        def replaced(args, **kwargs):
            result = engine(args, **kwargs)
            if args[:2] == ["docker", "run"]:
                name = args[args.index("--name") + 1]
                self.containers[name]["Config"]["Labels"]["kin.release.worker"] = "foreign"
            return result
        self.host.run = replaced
        with self.assertRaises(release.Unknown):
            self.host.cmd(["docker", "run", "--rm", "synthetic", "true"])
        self.assertTrue(self.containers)
        self.assertFalse(any(args[:2] == ["docker", "rm"] for args in self.calls))

    def test_read_only_exec_timeout_is_unknown_and_does_not_clean_helpers(self):
        self.containers["synthetic-db"] = {"Id": "d" * 64, "ExecIDs": None}
        self.timeout = True
        with self.assertRaises(release.Unknown):
            self.host.cmd(["docker", "exec", "synthetic-db", "pg_isready"], timeout=1)
        worker, = self.records.state()["workers"].values()
        self.assertEqual((worker["kind"], worker["state"]), ("exec", "UNKNOWN"))
        with self.host.bind(), self.assertRaises(release.Unknown):
            release.ops.remove_owned_if_present("container", "kin-rehearsal-fixture", "fixture")
        self.assertFalse(any(args[:2] == ["docker", "rm"] for args in self.calls))
        before = list(self.calls)
        for operation in (lambda: self.host.cmd(["docker", "rm", "owned-helper"], mutating=True),
                          lambda: self.host.compose(["up", "-d", "proxy"]),
                          lambda: self.host.one_shot(self.context, "api", ["true"], timeout=1, name="later"),
                          lambda: self.host.remove_smoke_member_now(self.context)):
            with self.assertRaises(release.Unknown):
                operation()
        self.assertEqual(self.calls, before, "no finally/cleanup/new worker may bypass the pending-worker gate")

    @unittest.skipUnless(os.name == "nt", "Windows Job supervisor contract")
    def test_browser_is_registered_before_launch_and_unknown_keeps_profile(self):
        self.host.browser_cmd = [sys.executable, "-c", "pass"]
        profile = self.records.secret("browser-profile-synthetic")
        profile.mkdir()
        (profile / "private").write_text("synthetic")
        def boundary(*args, **kwargs):
            worker, = self.records.state()["workers"].values()
            self.assertEqual((worker["kind"], worker["state"]), ("browser", "PLANNED"))
            raise release.Stop("synthetic unreaped supervisor")
        with patch.object(release, "run_tree", side_effect=boundary), self.assertRaises(release.Unknown):
            self.host.run_browser({"profile_dir": str(profile)})
        with self.assertRaises(release.Unknown):
            self.host.cleanup_browser_profile(profile)
        self.assertTrue((profile / "private").is_file())
        self.assertEqual(next(iter(self.records.state()["workers"].values()))["state"], "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
