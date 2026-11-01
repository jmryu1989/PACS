# coding: utf-8
"""The E route suite's stack probe (tests/e2e/test_image_route.py asset_catalog_deployed) against the states of the api
service it reads, without a stack.

`docker compose exec -T api <command>` is played by `Api`: a stopped service answers exit 1 with only an error message;
a running one runs the probe's own command here, in the service's environment (with or without the catalog setting).
The contract (GPT review of #324 779ec2b, P3-1): a stack whose catalog is set reads as deployed, one without it as not
deployed, and a failed exec is an error - never "no catalog", which would skip the suite as if the stack had answered.
"""
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / "e2e"), str(HERE)]
import test_image_route as route  # noqa: E402

NAME = "KIN_EMR_IMAGE_ASSET_CATALOG"
EXEC = ["docker", "compose", "exec", "-T", "api"]
REAL_RUN = subprocess.run


class Api:
    def __init__(self, running, setting=None):
        self.running, self.setting, self.calls = running, setting, 0

    def __call__(self, argv, **options):
        self.calls += 1
        if list(argv[:len(EXEC)]) != EXEC:
            raise AssertionError(f"the probe must read the api service through docker compose exec: {argv}")
        if not self.running:
            return subprocess.CompletedProcess(argv, 1, "", 'service "api" is not running\n')
        env = {key: value for key, value in os.environ.items() if key != NAME}
        if self.setting is not None:
            env[NAME] = self.setting
        inner = REAL_RUN(list(argv[len(EXEC):]), env=env, capture_output=True, text=True, encoding="utf-8",
                         errors="replace", timeout=60)
        return subprocess.CompletedProcess(argv, inner.returncode, inner.stdout, inner.stderr)


class AssetCatalogProbe(unittest.TestCase):
    def probe(self, api):
        with mock.patch.object(route.subprocess, "run", api):
            return route.asset_catalog_deployed()

    def test_a_running_api_with_the_catalog_reads_as_deployed(self):
        self.assertIs(self.probe(Api(True, "/run/kin-image-assets/catalog.json")), True)

    def test_a_running_api_without_the_catalog_reads_as_not_deployed(self):
        self.assertIs(self.probe(Api(True)), False)
        self.assertIs(self.probe(Api(True, "")), False)

    def test_a_failed_exec_is_an_error_not_a_missing_catalog(self):
        api = Api(False)
        with self.assertRaises(RuntimeError) as raised:
            self.probe(api)
        self.assertEqual(1, api.calls)
        self.assertIn("not running", str(raised.exception))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
