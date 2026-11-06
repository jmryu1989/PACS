"""C1-2a safety contracts; synthetic Git/files only, no service mutations."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ops_deploy_preflight as deploy
import ops_backup as ops


class _ComposeLoader(yaml.SafeLoader):
    pass


# The production overlay uses Compose's merge tags (!override, !reset); their value is what replaces the base entry.
_ComposeLoader.add_multi_constructor("!", lambda loader, suffix, node: (
    loader.construct_sequence(node) if isinstance(node, yaml.SequenceNode)
    else loader.construct_mapping(node) if isinstance(node, yaml.MappingNode) else loader.construct_scalar(node)))


def compose_api(name):
    return yaml.load((ROOT / name).read_text(encoding="utf-8"), Loader=_ComposeLoader)["services"]["api"]


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


def production_container():
    """kin-api as `docker inspect` reports the service docker-compose.yml + docker-compose.prod.yml declare: the overlay's
    volume list (its !override) as named volumes of project "kin", and the merged environment with every unset ${...}
    taking its default or a fixture value."""
    base, prod = compose_api("docker-compose.yml"), compose_api("docker-compose.prod.yml")
    good = container()
    good["Mounts"] = []
    for entry in prod["volumes"]:
        source, target, *mode = entry.split(":")
        good["Mounts"].append({"Type": "volume", "Name": "kin_" + source, "Source": "/var/lib/docker/volumes/kin_" + source + "/_data",
                               "Destination": target, "Driver": "local", "Mode": mode[0] if mode else "z",
                               "RW": "ro" not in (mode[0].split(",") if mode else [])})
    def value(text):
        return re.sub(r"\$\{[A-Z0-9_]+(?::-([^}]*)|:\?[^}]*)?\}", lambda m: m.group(1) if m.group(1) is not None else "fixture", str(text))
    good["Config"]["Env"] = [key + "=" + value(text) for key, text in {**base["environment"], **prod["environment"]}.items()]
    return good


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
        # CD-09-P/D: the retention ledger volume of docker-compose.prod.yml beside it, in either order; never alone, as a
        # host path, read-only or twice.
        ledger = {"Type": "volume", "Name": "kin_purpose-ledger", "Destination": deploy.RETENTION_LEDGER, "RW": True}
        for mounts in ([*good["Mounts"], ledger], [ledger, *good["Mounts"]]):
            with_ledger = copy.deepcopy(good); with_ledger["Mounts"] = mounts
            deploy.check_running_api(with_ledger, request()["previous_api_image"], emr=True)
        for mounts in ([ledger], [*good["Mounts"], {**ledger, "Type": "bind"}], [*good["Mounts"], {**ledger, "RW": False}],
                       [*good["Mounts"], ledger, ledger], [*good["Mounts"], ledger, {**ledger, "Destination": "/srv"}]):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts
            with self.subTest(mounts=mounts), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)
        # The ledger mirror (docker-compose.prod.yml): its own read-write named volume beside the ledger's, named by the
        # server's setting. Never without the ledger, as a host path, read-only, twice, unnamed by the setting, or named
        # by a setting with no volume under it.
        mirror = {"Type": "volume", "Name": "kin_ledger-mirror", "Destination": deploy.LEDGER_MIRROR, "RW": True}
        named = ["KIN_LEDGER_MIRROR_DIR=" + deploy.LEDGER_MIRROR]
        for mounts in ([*good["Mounts"], ledger, mirror], [mirror, ledger, *good["Mounts"]]):
            mirrored = copy.deepcopy(good); mirrored["Mounts"] = mounts; mirrored["Config"]["Env"] += named
            deploy.check_running_api(mirrored, request()["previous_api_image"], emr=True)
        for mounts, env in (([*good["Mounts"], mirror], named), ([*good["Mounts"], ledger, {**mirror, "Type": "bind"}], named),
                            ([*good["Mounts"], ledger, {**mirror, "RW": False}], named), ([*good["Mounts"], ledger, mirror, mirror], named),
                            ([*good["Mounts"], ledger, mirror], []), ([*good["Mounts"], ledger], named),
                            ([*good["Mounts"], ledger, mirror], ["KIN_LEDGER_MIRROR_DIR=/var/lib/kin-purpose"])):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts; bad["Config"]["Env"] += env
            with self.subTest(mounts=mounts, env=env), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)
        for env in (["DATABASE_URL=postgresql://kin:fixture@db:5432/kin"], ["POSTGRES_PASSWORD=fixture"],
                    ["KIN_EMR_STATE_DIR=/tmp"], ["DATABASE_URL=not a url::"]):
            bad = copy.deepcopy(good); bad["Config"]["Env"] = good["Config"]["Env"] + env
            with self.subTest(env=env[0].split("=")[0]), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)

    def test_05c_the_production_compose_api_passes_and_orthanc_db_is_read_only_only(self):
        """deploy-checklist-20261106 B: the API docker-compose.prod.yml declares (its EMR state, retention ledger and mirror
        volumes and Orthanc's database read-only for MG-LOADING's frame reads) passes the running-API check, in any order.
        Orthanc's database is allowed read-only and only so; nothing else read-only, no host path, never twice."""
        good = production_container()
        image = request()["previous_api_image"]
        destinations = sorted(m["Destination"] for m in good["Mounts"])
        self.assertEqual(destinations, sorted([deploy.EMR_STATE, deploy.RETENTION_LEDGER, deploy.LEDGER_MIRROR, deploy.ORTHANC_DB]))
        self.assertEqual([m["Destination"] for m in good["Mounts"] if not m["RW"]], [deploy.ORTHANC_DB])
        deploy.check_running_api(good, image, emr=True)
        reordered = copy.deepcopy(good); reordered["Mounts"].reverse()
        deploy.check_running_api(reordered, image, emr=True)
        # A release before MG-LOADING runs without it.
        without = copy.deepcopy(good); without["Mounts"] = [m for m in good["Mounts"] if m["Destination"] != deploy.ORTHANC_DB]
        deploy.check_running_api(without, image, emr=True)
        orthanc = next(m for m in good["Mounts"] if m["Destination"] == deploy.ORTHANC_DB)
        ledger = next(m for m in good["Mounts"] if m["Destination"] == deploy.RETENTION_LEDGER)
        others = [m for m in good["Mounts"] if m is not orthanc]
        for label, mounts in (
                ("orthanc db writable", [*others, {**orthanc, "Mode": "z", "RW": True}]),
                ("orthanc db as a host path", [*others, {**orthanc, "Type": "bind", "Source": "/srv/orthanc"}]),
                ("orthanc db twice", [*good["Mounts"], orthanc]),
                ("orthanc db read-only at another path", [*others, {**orthanc, "Destination": "/srv/orthanc"}]),
                ("orthanc db read-only plus another read-only volume", [*good["Mounts"], {**orthanc, "Destination": "/app/dist"}]),
                ("ledger read-only", [m for m in good["Mounts"] if m is not ledger] + [{**ledger, "Mode": "ro", "RW": False}]),
                ("unknown write mode", [*others, {**orthanc, "RW": None}]),
                ("non-boolean write mode", [*others, {**orthanc, "RW": 0}]),
                ("orthanc db only", [orthanc])):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts
            with self.subTest(label), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, image, emr=True)
        # The API-only path for a release without the EMR storage still refuses any mount.
        with self.assertRaises(RuntimeError):
            deploy.check_running_api(good, image)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
