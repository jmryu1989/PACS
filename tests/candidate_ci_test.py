# coding: utf-8
"""Pure guards for REQ-SERVER-UPDATE-20260911 candidate selection."""
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import candidate_ci as candidate


class CandidateCiTests(unittest.TestCase):
    def test_sha_and_hosted_checkout_guards_run_before_candidate_code(self):
        for value in ("c434775", "C" * 40, "g" * 40, "0" * 39, None):
            with self.assertRaisesRegex(RuntimeError, "full lowercase"):
                candidate.valid_sha(value)
        target = candidate.TOOLS_ROOT.parent / "separate-target"
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                                     "GITHUB_SHA": "a" * 40}, clear=True), patch.object(candidate, "git") as git:
            git.side_effect = ["a" * 40, "b" * 40]
            with self.assertRaisesRegex(RuntimeError, "requested SHA"):
                candidate.hosted_target(target, "c" * 40)
        for environment in ({}, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted"}):
            with patch.dict(os.environ, environment, clear=True), patch.object(candidate, "git") as git:
                with self.assertRaisesRegex(RuntimeError, "GitHub-hosted"):
                    candidate.hosted_target(target, "c" * 40)
                git.assert_not_called()

    def test_exact_target_selection_is_strict_and_ordered(self):
        target = candidate.TOOLS_ROOT
        import importlib.util, sys
        sys.path.insert(0, str(target / "tests"))
        spec = importlib.util.spec_from_file_location("candidate_test_runner", target / "scripts/run-tests.py")
        runner = importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        rows, selected = candidate.exact_selection(target, runner)
        self.assertEqual([row[2] for row in rows[:2]], ["candidate-invariants", "candidate-worklist"])
        self.assertEqual(len(selected), 90)
        self.assertEqual([item["case"] for item in selected[-7:]],
            [class_name + "." + method for _, class_name, method, _ in candidate.FLOWS])
        for filename, class_name, method, prefix in candidate.FLOWS:
            module = runner.load_module(target / "tests" / filename)
            self.assertTrue(method.startswith(prefix))
            self.assertIn(method, getattr(module, class_name).__dict__)

    def test_configuration_uses_target_runner_plans_evidence_and_540_seconds(self):
        class FakeRunner:
            def module_plan(self, filename, unit, mode, timeout, class_name):
                count = 69 if unit == "candidate-invariants" else 14
                return {"tests": [{"file": filename, "case": "Local.test_" + str(i)} for i in range(count)]}
            def load_module(self, path):
                filename = path.relative_to(candidate.TOOLS_ROOT / "tests").as_posix()
                row = next(x for x in candidate.FLOWS if x[0] == filename)
                method = lambda self: None
                method.__name__ = row[2]
                cls = type(row[1], (), {"__module__": path.stem, row[2]: method})
                return SimpleNamespace(__name__=path.stem, **{row[1]: cls})
        class FakeCi:
            PROFILES = {"measurements": {"out": Path("old"), "suite_timeout": 1, "suites": ()}}
            @staticmethod
            def guarded_profile_run(profile, suite, class_name, unit, remaining):
                return ["base", suite], 575
            @staticmethod
            def profile_environment(profile_name, out, values, evidence_stage=None):
                return {"ORTHANC_PASS": values["ORTHANC_PASS"]}
        with tempfile.TemporaryDirectory() as folder:
            plans = Path(folder) / "plans"
            out, selected = candidate.configure(candidate.TOOLS_ROOT, FakeCi, FakeRunner(), plans)
            profile = FakeCi.PROFILES["measurements"]
            self.assertEqual(profile["suite_timeout"], 540)
            self.assertEqual(len(profile["suites"]), 9)
            command, timeout = FakeCi.guarded_profile_run(profile, *profile["suites"][2], 1000)
            self.assertEqual(Path(command[1]), candidate.TOOLS_ROOT / "scripts/run-tests.py")
            self.assertEqual(command[2], "--plan")
            self.assertEqual(timeout, 575)
            env = FakeCi.profile_environment("measurements", out, {"ORTHANC_PASS": "synthetic"})
            self.assertEqual(env["KIN_EVIDENCE_DIR"], str(out / "screens"))
            self.assertEqual(len(selected), 90)

    def test_workflow_keeps_tool_and_candidate_checkouts_separate(self):
        source = (candidate.TOOLS_ROOT / ".github/workflows/candidate.yml").read_text(encoding="utf-8")
        self.assertIn("candidate_sha:", source)
        self.assertIn("ref: ${{ github.sha }}", source)
        self.assertIn("path: tools", source)
        self.assertIn("ref: ${{ inputs.candidate_sha }}", source)
        self.assertIn("path: target", source)
        self.assertIn("tools/tests/candidate_ci.py", source)
        self.assertIn("target/tests/e2e/artifacts/candidate-ci/", source)
        self.assertNotIn("docker compose", source.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
