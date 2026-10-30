"""Pure deployment boundaries retained by the EMR-B P1 declaration cut.

Only copied Compose inputs are changed; no Docker, database or credentials are used.
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("emr_compose", ROOT / "scripts/emr-compose.py")
compose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compose)


class ComposeSafetyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="emr-compose-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.base = compose.load_yaml(ROOT / "docker-compose.yml")
        self.prod = compose.load_yaml(ROOT / "docker-compose.prod.yml")

    def check(self):
        for name, body in (("docker-compose.yml", self.base), ("docker-compose.prod.yml", self.prod)):
            (self.root / name).write_text(yaml.safe_dump(body), encoding="utf-8")
        return compose.check(self.root)

    def test_current_deployment(self):
        self.assertEqual(compose.check(ROOT), [])

    def test_additive_migration_does_not_need_a_b_declaration_edit(self):
        declaration = self.root / "emr/units/b.json"
        declaration.parent.mkdir(parents=True)
        original = (ROOT / "emr/units/b.json").read_bytes()
        declaration.write_bytes(original)
        self.assertEqual(self.check(), [])
        migration = self.root / "api/prisma/migrations/20990101000000_other_unit/migration.sql"
        migration.parent.mkdir(parents=True)
        migration.write_text("CREATE TABLE other_unit_example (id integer);\n", encoding="utf-8")
        self.assertEqual(self.check(), [])
        self.assertEqual(declaration.read_bytes(), original)

    def test_installer_role_is_refused(self):
        self.base["services"]["api"]["environment"]["DATABASE_URL"] = "postgresql://kin:synthetic@db:5432/kin"
        self.assertIn("compose-api-not-runtime-role", self.check())

    def test_installer_secret_is_refused_as_key_or_reference(self):
        env = self.base["services"]["api"]["environment"]
        for key, value in (("POSTGRES_PASSWORD", "synthetic"), ("EXTRA_SECRET", "${POSTGRES_PASSWORD}")):
            with self.subTest(key=key):
                env[key] = value
                self.assertIn("compose-api-holds-installer-secret", self.check())
                del env[key]
        self.base["services"]["api"]["environment"] = [f"{key}={value}" for key, value in env.items()] + ["POSTGRES_PASSWORD"]
        self.assertIn("compose-api-holds-installer-secret", self.check())

    def test_production_host_binds_are_refused(self):
        volumes = self.prod["services"]["api"]["volumes"]
        for bind in ("/host:/x", "./host:/x:ro", "C:\\host:/x:ro",
                     {"type": "bind", "source": "/host", "target": "/x", "read_only": True}):
            with self.subTest(bind=bind):
                volumes.append(bind)
                self.assertIn("prod-api-host-bind", self.check())
                volumes.pop()

    def test_startup_requires_successful_migration_and_provision(self):
        for service, dependency, code in (("api", "api-migrate", "compose-api-before-migration"),
                                          ("api-migrate", "emr-provision", "compose-migration-before-provision")):
            condition = self.base["services"][service]["depends_on"][dependency]
            for replacement in ({}, {"condition": "service_started"}):
                with self.subTest(service=service, replacement=replacement):
                    self.base["services"][service]["depends_on"][dependency] = replacement
                    self.assertIn(code, self.check())
            self.base["services"][service]["depends_on"][dependency] = condition

    def test_writable_state_volume_is_required_in_base_and_production(self):
        for config, code in ((self.base, "compose-api-state-volume"), (self.prod, "prod-api-state-volume")):
            api = config["services"]["api"]
            original = api["volumes"]
            for replacement in ([], ["emr-state:/var/lib/kin-emr:ro"],
                                [{"type": "volume", "source": "emr-state", "target": "/var/lib/kin-emr", "read_only": True}]):
                with self.subTest(code=code, replacement=replacement):
                    api["volumes"] = replacement
                    self.assertIn(code, self.check())
            api["volumes"] = original

    def test_production_migration_image_is_required(self):
        del self.prod["services"]["api-migrate"]["build"]["target"]
        self.assertIn("prod-migration-not-production-image", self.check())

    def test_equivalent_volume_and_environment_syntax_and_extra_named_volume(self):
        for config in (self.base, self.prod):
            config.setdefault("volumes", {}).update({"other-unit": {}, "another-unit": {}})
            config["services"]["api"]["volumes"] = [
                {"type": "volume", "source": "emr-state", "target": "/var/lib/kin-emr"},
                {"type": "volume", "source": "other-unit", "target": "/x"},
                "another-unit:/y",
            ]
        api = self.base["services"]["api"]
        api["environment"] = [f"{key}={value}" for key, value in api["environment"].items()]
        self.assertEqual(self.check(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
