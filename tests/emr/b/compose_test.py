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


class ComposeDumper(yaml.SafeDumper):
    """Writes copies with the !override tag kept, so a copy merges with its base exactly as the original does."""


ComposeDumper.add_representer(compose.Replaced, lambda dumper, value: dumper.represent_sequence("!override", list(value)))

# Every Compose volume form, judged as an entry of the production api. Interpolation precedes parsing, so a '$' in any
# part of an entry is refused; only a plain container path or an exact declared volume name plus one passes.
VOLUME_FORMS = (
    ("short: anonymous container path", "/cache", True),
    ("short: named volume", "other-unit:/x", True),
    ("short: named volume with modes", "other-unit:/x:ro,nocopy", True),
    ("short: one-digit named volume", "1:/x", True),
    ("short: absolute host source", "/host:/x", False),
    ("short: relative host source with mode", "./host:/x:ro", False),
    ("short: home host source", "~/host:/x", False),
    ("short: Windows drive source", "C:\\host:/x:ro", False),
    ("short: Windows drive source, forward slashes", "C:/host:/x", False),
    ("short: single-letter source (a drive to Compose)", "c:/x", False),
    ("short: declared single-letter source (still a drive to Compose)", "a:/x", False),
    ("short: anonymous path with a mode (Compose reads a bind)", "/host:ro", False),
    ("short: variable source", "${PWD}/host:/x", False),
    ("short: defaulted variable source", "${KIN_DATA:-/srv/kin}:/data", False),
    ("short: variable target after a host source", "/host:${TARGET:-/app}", False),
    ("short: variable source and target", "${PWD}/host:${TARGET}", False),
    ("short: named volume with variable target", "other-unit:${TARGET}", False),
    ("short: named volume with variable mode", "other-unit:/x:${MODE}", False),
    ("short: whole entry a variable", "${API_VOLUME}", False),
    ("short: escaped dollar", "/x$$y", False),
    ("short: unknown mode", "other-unit:/x:/y", False),
    ("short: relative target", "other-unit:x", False),
    ("short: undeclared named volume", "undeclared-unit:/x", False),
    ("long: named volume", {"type": "volume", "source": "other-unit", "target": "/x", "read_only": True}, True),
    ("long: one-letter named volume", {"type": "volume", "source": "a", "target": "/x"}, True),
    ("long: anonymous volume", {"type": "volume", "target": "/x"}, True),
    ("long: tmpfs", {"type": "tmpfs", "target": "/x"}, True),
    ("long: bind", {"type": "bind", "source": "/host", "target": "/x", "read_only": True}, False),
    ("long: bind with variable source", {"type": "bind", "source": "${PWD}", "target": "/x"}, False),
    ("long: volume with host-path source", {"type": "volume", "source": "/host", "target": "/x"}, False),
    ("long: volume with variable source", {"type": "volume", "source": "${KIN_DATA}", "target": "/x"}, False),
    ("long: volume with variable target", {"type": "volume", "source": "other-unit", "target": "${TARGET}"}, False),
    ("long: variable type", {"type": "${KIND}", "source": "other-unit", "target": "/x"}, False),
    ("long: missing type", {"source": "other-unit", "target": "/x"}, False),
    ("long: npipe", {"type": "npipe", "source": "\\\\.\\pipe\\docker_engine", "target": "/x"}, False),
    ("long: tmpfs with a source", {"type": "tmpfs", "source": "/host", "target": "/x"}, False),
    ("long: undeclared named volume", {"type": "volume", "source": "undeclared-unit", "target": "/x"}, False),
    ("neither string nor mapping", 7, False),
)

# Top-level declarations of the volume an entry names: the local driver's bind options make a named volume a host path.
DECLARATION_FORMS = (
    ("no options", None, True),
    ("local driver", {"driver": "local"}, True),
    ("local driver bound to a host directory", {"driver_opts": {"type": "none", "o": "bind", "device": "/host"}}, False),
    ("other driver", {"driver": "vieux/sshfs"}, False),
    ("external", {"external": True}, False),
)


class ComposeSafetyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="emr-compose-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.base = compose.load_yaml(ROOT / "docker-compose.yml")
        self.prod = compose.load_yaml(ROOT / "docker-compose.prod.yml")

    def check(self):
        for name, body in (("docker-compose.yml", self.base), ("docker-compose.prod.yml", self.prod)):
            (self.root / name).write_text(yaml.dump(body, Dumper=ComposeDumper), encoding="utf-8")
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

    def test_every_volume_form_in_production(self):
        self.prod.setdefault("volumes", {}).update({"other-unit": None, "a": None, "1": None})
        volumes = self.prod["services"]["api"]["volumes"]
        for form, entry, admitted in VOLUME_FORMS:
            with self.subTest(form=form):
                volumes.append(entry)
                self.assertEqual(self.check(), [] if admitted else ["prod-api-host-bind"])
                volumes.pop()

    def test_every_named_volume_declaration_in_production(self):
        self.prod["services"]["api"]["volumes"].append("other-unit:/x")
        for config in (self.base, self.prod):
            for form, declaration, admitted in DECLARATION_FORMS:
                with self.subTest(file="prod" if config is self.prod else "base", form=form):
                    config.setdefault("volumes", {})["other-unit"] = declaration
                    self.assertEqual(self.check(), [] if admitted else ["prod-api-host-bind"])
                    del config["volumes"]["other-unit"]

    def test_untagged_production_volumes_merge_with_the_base(self):
        api = self.prod["services"]["api"]
        api["volumes"] = list(api["volumes"])
        # The base's development source binds reach production once the override stops replacing the list.
        self.assertEqual(self.check(), ["prod-api-host-bind"])
        del api["volumes"]
        self.assertEqual(self.check(), ["prod-api-host-bind"])
        base_api = self.base["services"]["api"]
        base_api["volumes"] = [v for v in base_api["volumes"] if compose.mount(v)]
        self.assertEqual(self.check(), [])
        # Merged by target, a production read-only entry replaces the base's writable state volume.
        api["volumes"] = ["emr-state:/var/lib/kin-emr:ro"]
        self.assertEqual(self.check(), ["prod-api-state-volume"])

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
                    api["volumes"] = compose.Replaced(replacement)
                    self.assertIn(code, self.check())
            api["volumes"] = original

    def test_reset_production_volumes_drop_their_entries(self):
        # Compose ignores the entries under !reset, so the production api keeps no state volume at all.
        text = (ROOT / "docker-compose.prod.yml").read_text(encoding="utf-8")
        api = text.index("\n  api:\n")
        reset = text[:api] + text[api:].replace("volumes: !override", "volumes: !reset", 1)
        self.assertNotEqual(reset, text)
        (self.root / "docker-compose.yml").write_text(yaml.dump(self.base, Dumper=ComposeDumper), encoding="utf-8")
        (self.root / "docker-compose.prod.yml").write_text(reset, encoding="utf-8")
        self.assertEqual(compose.check(self.root), ["prod-api-state-volume"])

    def test_production_migration_image_is_required(self):
        del self.prod["services"]["api-migrate"]["build"]["target"]
        self.assertIn("prod-migration-not-production-image", self.check())

    def test_equivalent_volume_and_environment_syntax_and_extra_named_volume(self):
        for config in (self.base, self.prod):
            config.setdefault("volumes", {}).update({"other-unit": {}, "another-unit": {}})
            config["services"]["api"]["volumes"] = compose.Replaced([
                {"type": "volume", "source": "emr-state", "target": "/var/lib/kin-emr"},
                {"type": "volume", "source": "other-unit", "target": "/x"},
                "another-unit:/y",
            ])
        api = self.base["services"]["api"]
        api["environment"] = [f"{key}={value}" for key, value in api["environment"].items()]
        self.assertEqual(self.check(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
