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
