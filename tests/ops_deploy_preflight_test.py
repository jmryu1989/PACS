"""C1-2a safety contracts; synthetic Git/files only, no service mutations."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_deploy_preflight as deploy
import ops_backup as ops


def request():
    return {"version": 1, "previous_sha": "a" * 40, "target_sha": "b" * 40,
            "previous_api_image": "sha256:" + "c" * 64, "target_api_image": "sha256:" + "d" * 64,
            "compose_files": list(deploy.COMPOSE)}


def parsed(body):
    raw = json.dumps(body).encode()
    return deploy.parse_request(raw, hashlib.sha256(raw).hexdigest())


def container():
    return {"Name": "/kin-api", "Image": request()["previous_api_image"], "State": {"Running": True},
            "Config": {"User": "node", "Env": ["DEPLOYMENT_MODE=production", "AUTH_REQUIRED=true"],
                       "Labels": {"com.docker.compose.project.working_dir": str(ops.ROOT), "com.docker.compose.service": "api"}},
            "Mounts": [], "NetworkSettings": {"Ports": {"3000/tcp": None}},
            "HostConfig": {"NetworkMode": "fixture_default", "PortBindings": {}}}


class PreflightTests(unittest.TestCase):
    def test_01_strict_request_and_mutable_identity_refusal(self):
        self.assertEqual(parsed(request()), request())
        cases = [("version", True), ("target_sha", "main"), ("target_sha", "--help"),
                 ("target_sha", "b" * 40 + "\n"), ("target_sha", request()["previous_sha"]),
                 ("target_api_image", "kin-api:latest"), ("target_api_image", "sha256:" + "D" * 64),
                 ("compose_files", deploy.COMPOSE[:2]), ("compose_files", deploy.COMPOSE[::-1]), ("extra", "command")]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                body = request(); body[key] = value
                with self.assertRaises(RuntimeError): parsed(body)
        body = request(); del body["previous_sha"]
        with self.assertRaises(RuntimeError): parsed(body)

    def test_02_hash_duplicate_size_and_type_refusal(self):
        raw = json.dumps(request()).encode()
        with self.assertRaises(RuntimeError): deploy.parse_request(raw, "0" * 64)
        for value in (b'{"version":1,"version":1}', b" " * 8193, b"[]", b"null"):
            with self.assertRaises(RuntimeError): deploy.parse_request(value, hashlib.sha256(value).hexdigest())

    def test_03_real_git_identity_dirty_and_compatibility(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=folder, stderr=subprocess.PIPE).decode().strip()
            git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture")
            for relative in deploy.PROTECTED:
                path = Path(folder) / relative
                if "." not in path.name:
                    path = path / "fixture.txt"
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixture\n")
            app = Path(folder) / "api/app.txt"; app.write_text("old\n")
            git("add", "--all"); git("commit", "-m", "previous")
            body = request(); body["previous_sha"] = git("rev-parse", "HEAD")
            app.write_text("new\n"); git("add", "api/app.txt"); git("commit", "-m", "target")
            body["target_sha"] = git("rev-parse", "HEAD")
            git("checkout", "--detach", body["previous_sha"])
            self.assertEqual(len(deploy.check_repository(body)), 2)
            (Path(folder) / "branding.png").write_bytes(b"preserve")
            self.assertEqual(len(deploy.check_repository(body)), 2)
            app.write_text("dirty\n")
            with self.assertRaisesRegex(RuntimeError, "dirty"): deploy.check_repository(body)
            app.write_text("old\n")
            git("checkout", "--detach", body["target_sha"])
            with self.assertRaisesRegex(RuntimeError, "Checkout"): deploy.check_repository(body)
            (Path(folder) / "api/prisma/fixture.txt").write_text("schema changed\n")
            git("add", "api/prisma/fixture.txt"); git("commit", "-m", "incompatible")
            body["target_sha"] = git("rev-parse", "HEAD")
            git("checkout", "--detach", body["previous_sha"])
            with self.assertRaisesRegex(RuntimeError, "compatibility"): deploy.check_repository(body)
            self.assertEqual((Path(folder) / "branding.png").read_bytes(), b"preserve")

    def test_04_image_identity_user_and_revision(self):
        identity = request()["target_api_image"]
        image = {"Id": identity, "Config": {"User": "node", "Labels": {"org.opencontainers.image.revision": "b" * 40}}}
        with patch.object(deploy, "api_tree", return_value="tree"):
            deploy.check_image(image, identity, "tree")
            for candidate in ({**image, "Id": "other"}, {**image, "Config": {"User": "root"}}):
                with self.assertRaises(RuntimeError): deploy.check_image(candidate, identity, "tree")
            with self.assertRaises(RuntimeError): deploy.check_image(image, identity, "different-tree")
        with self.assertRaises(RuntimeError): deploy.api_tree("--help")

    def test_05_running_target_and_exposure_refusal(self):
        good = container(); deploy.check_running_api(good, request()["previous_api_image"])
        changes = [("Image", "other"), ("State", {"Running": False}), ("Mounts", [{}]),
                   ("NetworkSettings", {}), ("NetworkSettings", {"Ports": {"3000/tcp": [{"HostPort": "3000"}]}}),
                   ("HostConfig", {"NetworkMode": "host"}), ("HostConfig", {"NetworkMode": "bridge", "PortBindings": {"3000/tcp": [{}]}})]
        for key, value in changes:
            bad = copy.deepcopy(good); bad[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): deploy.check_running_api(bad, request()["previous_api_image"])
        for key, value in (("User", "root"), ("Env", ["DEPLOYMENT_MODE=production", "AUTH_REQUIRED=false"]), ("Labels", {})):
            bad = copy.deepcopy(good); bad["Config"][key] = value
            with self.assertRaises(RuntimeError): deploy.check_running_api(bad, request()["previous_api_image"])

    def test_05b_emr_running_api_holds_only_its_state_volume_and_runtime_role(self):
        """EMR-B1: after the storage is installed the API runs with exactly its state volume and the runtime role."""
        good = container()
        good["Mounts"] = [{"Type": "volume", "Name": "kin_emr-state", "Destination": deploy.EMR_STATE, "RW": True}]
        good["Config"]["Env"] += ["DATABASE_URL=postgresql://kin_runtime:fixture@db:5432/kin", "KIN_EMR_STATE_DIR=" + deploy.EMR_STATE]
        deploy.check_running_api(good, request()["previous_api_image"], emr=True)
        with self.assertRaises(RuntimeError): deploy.check_running_api(good, request()["previous_api_image"])
        for mounts in ([], [{**good["Mounts"][0], "Type": "bind"}], [{**good["Mounts"][0], "Destination": "/app"}],
                       good["Mounts"] * 2, [{**good["Mounts"][0], "RW": False}]):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts
            with self.subTest(mounts=mounts), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)
        for env in (["DATABASE_URL=postgresql://kin:fixture@db:5432/kin"], ["POSTGRES_PASSWORD=fixture"],
                    ["KIN_EMR_STATE_DIR=/tmp"], ["DATABASE_URL=not a url::"]):
            bad = copy.deepcopy(good); bad["Config"]["Env"] = good["Config"]["Env"] + env
            with self.subTest(env=env[0].split("=")[0]), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)

    def test_03b_emr_introduction_is_never_api_only(self):
        """EMR-B1: a target that brings the EMR storage is refused before any other compatibility check passes it."""
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=folder, stderr=subprocess.PIPE).decode().strip()
            git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture")
            for relative in deploy.PROTECTED:
                path = Path(folder) / relative
                if "." not in path.name:
                    path = path / "fixture.txt"
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixture\n")
            (Path(folder) / "api/app.txt").write_text("old\n")
            git("add", "--all"); git("commit", "-m", "previous")
            body = request(); body["previous_sha"] = git("rev-parse", "HEAD")
            migration = Path(folder) / deploy.EMR_MIGRATION
            migration.parent.mkdir(parents=True); migration.write_text("-- synthetic\n")
            git("add", "--all"); git("commit", "-m", "emr")
            body["target_sha"] = git("rev-parse", "HEAD")
            git("checkout", "--detach", body["previous_sha"])
            with self.assertRaisesRegex(RuntimeError, "EMR-B storage requires provisioning"): deploy.check_repository(body)
            self.assertFalse(deploy.has_emr_storage(body["previous_sha"]))
            self.assertTrue(deploy.has_emr_storage(body["target_sha"]))
            # Both sides already carry it: the ordinary API-only boundary decides (here an unchanged one).
            git("checkout", "--detach", body["target_sha"])
            (Path(folder) / "api/app.txt").write_text("new\n"); git("add", "api/app.txt"); git("commit", "-m", "next")
            later = dict(body, previous_sha=body["target_sha"], target_sha=git("rev-parse", "HEAD"))
            git("checkout", "--detach", later["previous_sha"])
            self.assertEqual(len(deploy.check_repository(later)), 2)

    def test_06_backup_lock_contention_and_failure_cleanup(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            with ops.lock(), patch.object(ops, "require_local_docker") as probe:
                with self.assertRaises(FileExistsError): deploy.preflight(request())
                probe.assert_not_called()
                source = "import sys,pathlib;sys.path.insert(0,sys.argv[1]);import ops_backup as o;o.ROOT=pathlib.Path(sys.argv[2]);\nwith o.lock(): pass"
                child = subprocess.run([sys.executable, "-c", source, str(Path(ops.__file__).parent), folder], capture_output=True)
                self.assertNotEqual(child.returncode, 0)
                self.assertIn(b"FileExistsError", child.stderr)
            with patch.object(ops, "require_local_docker", side_effect=RuntimeError("failure")):
                with self.assertRaises(RuntimeError): deploy.preflight(request())
            self.assertFalse((Path(folder) / ".kin-ops.lock").exists())

    def test_07_foreign_lock_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            path = Path(folder) / ".kin-ops.lock"
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                with ops.lock(): path.write_text("another-owner")
            self.assertEqual(path.read_text(), "another-owner")

    def test_08_success_is_only_observation_and_queries(self):
        body = request()
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)), \
                patch.object(ops, "require_local_docker"), \
                patch.object(deploy, "check_repository", return_value={body["previous_sha"]: "old", body["target_sha"]: "new"}), \
                patch.object(deploy, "check_image"), patch.object(deploy, "check_running_api"), \
                patch.object(ops, "text", return_value='[{}]') as commands:
            result = deploy.preflight(body)
        self.assertTrue(result["preflight_passed"])
        self.assertFalse(result["deployment_authorized"])
        self.assertFalse(result["automatic_rollback_authorized"])
        self.assertEqual([call.args[0] for call in commands.call_args_list], [
            ["docker", "image", "inspect", body["previous_api_image"]],
            ["docker", "image", "inspect", body["target_api_image"]], ["docker", "inspect", "kin-api"]])

    def test_09_cli_rejects_secret_input_without_echo_or_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "request.json"; path.write_text('{"SECRET": "must-not-leak"}')
            result = subprocess.run([sys.executable, deploy.__file__, str(path), "--request-sha256", "0" * 64], capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertNotIn(b"must-not-leak", result.stderr)
            self.assertFalse(json.loads(result.stderr)["deployment_authorized"])


class StateLaunchTests(unittest.TestCase):
    # REQ-B2C-01/10 -> DUAL-OWNER/WRONG-STATE-RECOVERY -> D1656-T03/T04/T08.
    # Engine observations are boundary doubles; the actual HostOps mutation path
    # executes. A refused start must leave the simulated protected file untouched.
    def fixture(self):
        release = {"sha": "b" * 40, "images": {"api": "sha256:" + "d" * 64, "db": "sha256:" + "e" * 64}}
        image = {"Id": release["images"]["api"], "Config": {"Labels": {"org.opencontainers.image.revision": release["sha"]},
                 "WorkingDir": "/app", "Env": ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_ENV=production"]}}
        args = dict(release=release, image=image, state_volume="fixture_emr-state", api_ipc_volume="fixture_emr-state-api-ipc",
                    retention_ipc_volume="fixture_emr-state-retention-ipc", instance_id="fixture", database_host="db")
        item = {"Id": "owner", "Name": "/kin-emr-state", "Image": image["Id"], "Path": "sh",
                "Args": ["/app/start-production.sh", "state-serve-v3"], "State": {"Running": False, "Restarting": False},
                "Config": {"User": "1000:1000", "WorkingDir": "/app", "Entrypoint": ["sh", "/app/start-production.sh"], "Cmd": ["state-serve-v3"],
                    "Labels": {"com.docker.compose.service": "emr-state"}, "Env": [*image["Config"]["Env"],
                        "DATABASE_URL=postgresql://kin_emr_reader:synthetic@db:5432/kin", "KIN_EMR_INSTANCE_ID=fixture",
                        "KIN_EMR_STATE_DIR=/var/lib/kin-emr", "KIN_EMR_API_SOCKET=/run/kin-emr-api/writer.sock",
                        "KIN_EMR_RETENTION_SOCKET=/run/kin-emr-retention/writer.sock"]},
                "HostConfig": {"GroupAdd": ["2001", "2002"], "Privileged": False, "NetworkMode": "fixture_default",
                    "PortBindings": {}, "RestartPolicy": {"Name": "no"}},
                "Mounts": [{"Type": "volume", "Name": name, "Destination": target, "RW": True} for target, name in [
                    (deploy.EMR_STATE, args["state_volume"]), (deploy.STATE_API_IPC, args["api_ipc_volume"]),
                    (deploy.STATE_RETENTION_IPC, args["retention_ipc_volume"])]]}
        return item, args

    def client_fixture(self):
        item, args = self.fixture()
        item.update(Id="client", Name="/kin-api", Args=["/app/start-production.sh", "serve"])
        item["Config"].update(User="1001:1001", Cmd=["serve"], Labels={"com.docker.compose.service": "api"}, Env=[
            "DATABASE_URL=postgresql://kin_runtime:synthetic@db:5432/kin", "KIN_EMR_INSTANCE_ID=fixture",
            "KIN_EMR_STATE_SOCKET=/run/kin-emr-api/writer.sock", "DEPLOYMENT_MODE=production", "AUTH_REQUIRED=true",
            *args["image"]["Config"]["Env"]])
        item["HostConfig"]["GroupAdd"] = ["2001"]
        item["Mounts"] = [item["Mounts"][1]]
        return item, args

    def test_10_state_artifact_command_role_mount_and_credential_matrix(self):
        item, args = self.fixture()
        deploy.check_state_service(item, **args)
        mutations = [lambda c: c.update(Image="sha256:" + "a" * 64),
            lambda c: c["Config"].update(Cmd=["serve"]), lambda c: c["Config"].update(Entrypoint=["node"]),
            lambda c: c.update(Path="node", Args=["dist/emr-runtime/state-service-main.js"]),
            lambda c: c["Config"].update(User="1001:1001"),
            lambda c: c["Config"]["Labels"].update({"com.docker.compose.service": "api"}),
            lambda c: c["Mounts"][0].update(Name="original-source"),
            lambda c: c["Mounts"].append({"Type": "bind", "Name": None, "Destination": "/app", "RW": False}),
            lambda c: c["HostConfig"].update(RestartPolicy={"Name": "always"}),
            lambda c: c["HostConfig"].update(GroupAdd=["2001"]),
            lambda c: c["Config"]["Env"].append("KIN_EMR_RUNTIME_PASSWORD=not-allowed"),
            lambda c: c["Config"]["Env"].append("KIN_EMR_INSTANCE_ID=wrong")]
        for change in mutations:
            bad = copy.deepcopy(item); change(bad)
            with self.subTest(change=mutations.index(change)), self.assertRaises(RuntimeError):
                deploy.check_state_service(bad, **args)
        for change in ({"Id": "kin-api:latest"}, {"Config": {"Labels": {"org.opencontainers.image.revision": "a" * 40}}}):
            with self.assertRaises(RuntimeError): deploy.check_state_service(item, **{**args, "image": {**args["image"], **change}})

    def test_10b_the_plan_state_format_selects_the_entry_mode_and_nothing_else_does(self):
        """EMR-B2 (c) v4: a v4 deployment's owner is the same image in `state-serve-v4`; the plan's state_format alone
        decides which entry mode the admission binds (a container's own command never selects it)."""
        item, args = self.fixture()
        deploy.check_state_service(item, **args)
        deploy.check_state_service(item, **{**args, "state_format": 3})
        with self.assertRaises(RuntimeError):
            deploy.check_state_service(item, **{**args, "state_format": 4})
        v4 = copy.deepcopy(item)
        v4["Args"] = ["/app/start-production.sh", "state-serve-v4"]
        v4["Config"]["Cmd"] = ["state-serve-v4"]
        deploy.check_state_service(v4, **{**args, "state_format": 4})
        with self.assertRaises(RuntimeError):
            deploy.check_state_service(v4, **args)
        for stale in (["state-serve-v3"], ["state-convert-v4"], ["state-export-v3"], ["serve"]):
            bad = copy.deepcopy(v4)
            bad["Args"] = ["/app/start-production.sh", *stale]
            with self.subTest(args=stale), self.assertRaises(RuntimeError):
                deploy.check_state_service(bad, **{**args, "state_format": 4})
        for unsupported in (2, 5, "4", None):
            with self.subTest(state_format=unsupported), self.assertRaises(RuntimeError):
                deploy.check_state_service(v4, **{**args, "state_format": unsupported})
        self.assertEqual(deploy.state_format_of(v4["Args"]), 4)
        self.assertEqual(deploy.state_format_of(item["Args"]), 3)
        self.assertIsNone(deploy.state_format_of(["/app/start-production.sh", "state-convert-v4"]))

    def test_11_legacy_restart_eligibility_is_an_owner(self):
        item, args = self.fixture(); item["Name"] = "/retained-api"
        deploy.check_state_owners([item], args["state_volume"], "new-service")
        for state, restart in [({"Running": True, "Restarting": False}, "no"),
                               ({"Running": False, "Restarting": True}, "no"),
                               ({"Running": False, "Restarting": False}, "always")]:
            bad = copy.deepcopy(item); bad["State"] = state; bad["HostConfig"]["RestartPolicy"]["Name"] = restart
            with self.assertRaises(RuntimeError): deploy.check_state_owners([bad], args["state_volume"], "new-service")

    def test_execution_overrides_refuse_for_both_owner_and_client(self):
        """D1656-T03/T05: immutable argv does not authorize a different loader or namespace."""
        for client in (False, True):
            item, args = self.client_fixture() if client else self.fixture()
            if client:
                args.pop("retention_ipc_volume")
            check = deploy.check_state_client if client else deploy.check_state_service
            check(item, **args)
            changes = [("env", key, value) for key, value in [
                ("NODE_OPTIONS", "--require=/tmp/other.cjs"), ("NODE_PATH", "/tmp/modules"),
                ("LD_PRELOAD", "/tmp/loader.so"), ("LD_LIBRARY_PATH", "/tmp"), ("LD_AUDIT", "/tmp/audit.so"),
                ("PRISMA_QUERY_ENGINE_LIBRARY", "/tmp/engine.node"), ("BASH_ENV", "/tmp/init.sh"),
                ("ENV", "/tmp/init.sh"), ("OPENSSL_CONF", "/tmp/ssl.cnf"), ("PATH", "/tmp/bin")]]
            changes += [("config", "WorkingDir", "/tmp"), ("config", "Healthcheck", {"Test": ["CMD", "node", "other.js"]}),
                        ("config", "StopSignal", "SIGUSR1")]
            changes += [("host", key, value) for key, value in [
                ("Devices", [{"PathOnHost": "/dev/sda", "PathInContainer": "/dev/raw", "CgroupPermissions": "rwm"}]),
                ("DeviceRequests", [{"Driver": "nvidia", "Count": -1}]), ("DeviceCgroupRules", ["a *:* rwm"]),
                ("VolumesFrom", ["old-owner"]), ("Tmpfs", {"/app": "rw"}), ("IpcMode", "host"),
                ("UTSMode", "host"), ("UsernsMode", "host"), ("SecurityOpt", ["seccomp=unconfined"]),
                ("NetworkMode", "container:old-owner"), ("Init", True)]]
            for section, key, value in changes:
                bad = copy.deepcopy(item)
                if section == "env":
                    bad["Config"]["Env"] = [e for e in bad["Config"]["Env"] if not e.startswith(key + "=")] + [key + "=" + value]
                else:
                    bad["Config" if section == "config" else "HostConfig"][key] = value
                with self.subTest(client=client, section=section, key=key), self.assertRaises(RuntimeError):
                    check(bad, **args)
            item["HostConfig"]["SecurityOpt"] = ["no-new-privileges:true"]
            check(item, **args)

    def test_12_actual_start_consumer_refuses_legacy_before_mutation(self):
        import ops_emr_introduction as intro
        from types import SimpleNamespace
        item, args = self.fixture()
        # A stale old container can carry the expected tag/label while its real
        # command still dispatches serve. Removing the consumer guard starts it.
        item["Name"] = "/kin-api"; item["Config"]["Cmd"] = ["serve"]
        item["Args"] = ["/app/start-production.sh", "serve"]
        with tempfile.TemporaryDirectory() as directory:
            protected = Path(directory) / "journal"; protected.write_bytes(b'good\n{"torn":')
            before = protected.read_bytes()
            host = object.__new__(intro.HostOps)
            host.intro = None; host.t = {"project": "fixture", "containers": {"api": "kin-api"},
                                        "volumes": {"emr_state": args["state_volume"]}}
            host.plan = {"release": args["release"]}; host.names = {"api": "kin-api"}
            host.records = SimpleNamespace(command=lambda value: None)
            host.inspect_container = lambda name: copy.deepcopy(item)
            calls = []
            def runner(command, **kwargs):
                calls.append(command)
                if command[:3] == ["docker", "image", "inspect"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps([args["image"]]).encode(), b"")
                if command[:2] in (["docker", "start"], ["docker", "restart"]):
                    protected.write_bytes(b'good\n')
                    return subprocess.CompletedProcess(command, 0, b"", b"")
                self.fail("unexpected boundary operation " + str(command[:3]))
            host.run = runner
            for command in (["docker", "start", "kin-api"], ["docker", "restart", "kin-api"]):
                refusal = None
                try: host.cmd(command, mutating=True)
                except RuntimeError as error: refusal = error
                self.assertEqual(protected.read_bytes(), before, "start admission must precede owner execution")
                self.assertIsInstance(refusal, RuntimeError)
            self.assertFalse(any(c[:2] in (["docker", "start"], ["docker", "restart"]) for c in calls))
            # Positive client path proves the test reaches the actual mutation boundary.
            item, _ = self.client_fixture()
            host.cmd(["docker", "start", "kin-api"], mutating=True)
            self.assertEqual(protected.read_bytes(), b'good\n')

    def test_13_compose_creation_rejects_a_legacy_owner_before_launch(self):
        import ops_emr_introduction as intro
        host = object.__new__(intro.HostOps)
        host.t = {"volumes": {"emr_state": "fixture_emr-state"}}
        model = {"services": {"api": {"volumes": [{"type": "volume", "source": "state", "target": deploy.EMR_STATE}]}},
                 "volumes": {"state": {"name": "fixture_emr-state"}}}
        with self.assertRaises(RuntimeError): host.admit_compose_launch(model, ["up", "api"])
        model["services"] = {"emr-state": {**model["services"]["api"], "entrypoint": ["node"], "command": ["dist/main.js"]}}
        with self.assertRaises(RuntimeError): host.admit_compose_launch(model, ["up", "emr-state"])

    def test_14_start_rechecks_changed_image_command_volume_and_database(self):
        """D1656-T04/T08: the real start consumer reaches inspection, then refuses a changed handoff."""
        import ops_emr_introduction as intro
        from types import SimpleNamespace
        for change in (None, "initial-image", "initial-command", "initial-entrypoint", "image", "command", "volume", "database",
                       "same-volume-bytes", "same-volume-lineage", "same-volume-pair", "missing-fingerprint"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                protected = Path(directory) / "journal"; protected.write_bytes(b'good\n{"torn":')
                original = protected.read_bytes()
                item, args = self.fixture()
                if change == "initial-image": item["Image"] = "sha256:" + "0" * 64
                if change == "initial-command":
                    item["Config"]["Cmd"] = ["serve"]
                    item["Args"] = ["/app/start-production.sh", "serve"]
                if change == "initial-entrypoint":
                    item["Config"]["Entrypoint"] = ["node"]
                    item["Config"]["Cmd"] = ["dist/emr-runtime/state-service-main.js"]
                    item.update(Path="node", Args=["dist/emr-runtime/state-service-main.js"])
                db = {"Id": "db", "Image": args["release"]["images"]["db"], "State": {"Running": True},
                      "Mounts": [{"Destination": "/var/lib/postgresql/data", "Name": "fixture_pg"},
                                 {"Destination": "/var/lib/postgresql/emr-access", "Name": "fixture_access"}]}
                host = object.__new__(intro.HostOps)
                host.intro = None; host.t = {"project": "fixture", "volumes": {"emr_state": args["state_volume"],
                    "pg": "fixture_pg", "emr_access": "fixture_access"}}
                host.plan = {"release": args["release"]}; host.names = {"db": "fixture-db"}
                host.records = SimpleNamespace(command=lambda value: None)
                inspected = False
                def container(name):
                    current = copy.deepcopy(item)
                    if inspected and change == "image": current["Image"] = "sha256:" + "0" * 64
                    if inspected and change == "command": current["Config"]["Cmd"] = ["serve"]
                    return current
                def database(role):
                    current = copy.deepcopy(db)
                    if inspected and change == "database": current["Id"] = "replacement-db"
                    return current
                host.inspect_container = container; host.inspect = database
                host.volume_identity = lambda name: {"name": name, "created": "replaced" if inspected and change == "volume" else "original"}
                host.text = lambda command: "kin-emr-state"
                launches = []
                def runner(command, **kwargs):
                    nonlocal inspected
                    if command[:3] == ["docker", "image", "inspect"]:
                        return subprocess.CompletedProcess(command, 0, json.dumps([args["image"]]).encode(), b"")
                    if command[:2] == ["docker", "run"]:
                        self.assertTrue(any(word.endswith(",readonly") for word in command))
                        value = {"version": 3, "lineage": "00000000-0000-4000-8000-000000000001", "fingerprint": "a" * 64,
                                 "pair": {"instanceId": "fixture", "database": {"database": "kin", "oid": 42, "address": "127.0.0.1", "port": 5432},
                                          "chains": {"viewing": "00000000-0000-4000-8000-000000000002", "history": "00000000-0000-4000-8000-000000000003"}}}
                        if change == "missing-fingerprint": value.pop("fingerprint")
                        if inspected and change == "same-volume-bytes": value["fingerprint"] = "b" * 64
                        if inspected and change == "same-volume-lineage": value["lineage"] = "00000000-0000-4000-8000-000000000004"
                        if inspected and change == "same-volume-pair": value["pair"]["database"]["oid"] += 1
                        inspected = True
                        return subprocess.CompletedProcess(command, 0, ("KIN_RESULT " + json.dumps(value)).encode(), b"")
                    if command[:2] == ["docker", "start"]:
                        launches.append(command); protected.write_bytes(b'good\n')
                        return subprocess.CompletedProcess(command, 0, b"", b"")
                    self.fail("Unexpected boundary command " + str(command[:3]))
                host.run = runner
                if change is None:
                    host.cmd(["docker", "start", "kin-emr-state"], mutating=True)
                    self.assertEqual(len(launches), 1)
                else:
                    refusal = None
                    try: host.cmd(["docker", "start", "kin-emr-state"], mutating=True)
                    except RuntimeError as error: refusal = error
                    self.assertEqual(protected.read_bytes(), original)
                    if change.startswith("initial-"):
                        self.assertFalse(inspected, "incompatible executable must refuse before even the readonly inspector runs")
                    else:
                        self.assertTrue(inspected, "the changed observation must occur after successful readonly inspection")
                    self.assertIsInstance(refusal, RuntimeError)
                    self.assertEqual(launches, [])

if __name__ == "__main__":
    unittest.main(verbosity=2)
