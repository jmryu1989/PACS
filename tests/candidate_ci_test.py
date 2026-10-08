# coding: utf-8
"""Pure guards for REQ-SERVER-UPDATE-20260911 candidate selection."""
import os
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import candidate_ci as candidate
from live_admin_credential_test import ImportedAdminCredentialTests


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
        # S7-U1a: 89 invariants (six CriticalResultInvariantTests) + 15 worklist + 8 flows; S8-CTX: + 2 Tech Note flows
        self.assertEqual(len(selected), 114)
        self.assertEqual([item["case"] for item in selected[-10:]],
            [class_name + "." + method for _, class_name, method, _ in candidate.FLOWS])
        for filename, class_name, method, prefix in candidate.FLOWS:
            module = runner.load_module(target / "tests" / filename)
            self.assertTrue(method.startswith(prefix))
            self.assertIn(method, getattr(module, class_name).__dict__)

    def test_configuration_uses_target_runner_plans_evidence_and_540_seconds(self):
        class FakeRunner:
            def module_plan(self, filename, unit, mode, timeout, class_name):
                count = 89 if unit == "candidate-invariants" else 15
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
            self.assertEqual(len(profile["suites"]), 12)
            command, timeout = FakeCi.guarded_profile_run(profile, *profile["suites"][2], 1000)
            self.assertEqual(Path(command[1]), candidate.TOOLS_ROOT / "scripts/run-tests.py")
            self.assertEqual(command[2], "--plan")
            self.assertEqual(timeout, 575)
            env = FakeCi.profile_environment("measurements", out, {"ORTHANC_PASS": "synthetic"})
            self.assertEqual(env["KIN_EVIDENCE_DIR"], str(out / "screens"))
            self.assertEqual(len(selected), 114)

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

    def exercise_live_driver(self, ci, profile_name, failure=None):
        """Observe actual child environments/artifacts with Docker and HTTP replaced."""
        secret = "stub-imported-password-never-in-artifacts"
        states, live, events = ["pending", "ready"], [], []

        def ready(url, **kwargs):
            response = MagicMock()
            response.__enter__.return_value.status = 200
            state = states.pop(0) if url.endswith('/api/health') else None
            response.__enter__.return_value.read.return_value = json.dumps({"memberRights": state}).encode()
            events.append(state or "discovery")
            return response

        def supply(url, master_password):
            self.assertEqual(events, ["pending", "ready", "discovery"])
            self.assertEqual(os.environ.get("KIN_SYNTHETIC_REALM"), "1")
            self.assertTrue(master_password)
            self.assertTrue(url.endswith('/auth/admin/realms/kin'))
            events.append("credential")
            return secret

        def run(command, **kwargs):
            self.assertNotIn(secret, " ".join(map(str, command)))
            if any(str(part).endswith('run-tests.py') for part in command):
                self.assertEqual(events[-1], "credential")
                self.assertEqual(kwargs['env'].get('KIN_LIVE_IMPORTED_ADMIN_PASSWORD'), secret)
                live.append(command)
                if failure == 'timeout':
                    raise subprocess.TimeoutExpired(command, 1, output=secret.encode(), stderr=secret.encode())
                if failure == 'exit':
                    return SimpleNamespace(returncode=1, stdout=secret.encode(), stderr=b'')
            return SimpleNamespace(returncode=0, stdout=secret.encode() if "credential" in events else b'', stderr=b'')

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            out = root / 'artifacts'
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                                         'RUNNER_TEMP': str(root)}, clear=True), \
                    patch.object(ci, 'ROOT', root), \
                    patch.dict(ci.PROFILES, {profile_name: {**ci.PROFILES[profile_name], 'out': out}}), \
                    patch.object(ci, 'seed_source'), \
                    patch.object(ci.time, 'sleep', side_effect=[None, RuntimeError('Unexpected readiness retry')]), \
                    patch.object(ci.subprocess, 'check_output', side_effect=[b'', b'', b'unix:///runner.sock']), \
                    patch.object(ci.subprocess, 'run', side_effect=run), \
                    patch.object(ci.ssl, '_create_unverified_context', return_value=None), \
                    patch.object(ci, 'urlopen', side_effect=ready), \
                    patch.object(ci, 'publish_vr_evidence'), \
                    patch.object(ci, 'gateway_unpause'), patch.object(ci, 'gateway_remove', return_value=False), \
                    patch.object(ci, 'ensure_imported_admin_credential', side_effect=supply) as helper, \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                if failure:
                    with self.assertRaisesRegex(RuntimeError, 'failed; see sanitized artifact'):
                        ci.main(profile_name)
                else:
                    ci.main(profile_name)
                helper.assert_called_once()
            self.assertEqual(len(live), 1 if failure else len(ci.PROFILES[profile_name]['suites']))
            for artifact in out.rglob('*'):
                if artifact.is_file():
                    self.assertNotIn(secret, artifact.read_text(encoding='utf-8'))
            self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())
            rows = json.loads((out / 'results.json').read_text(encoding='utf-8'))
            self.assertEqual(rows[-1]['name'], 'cleanup')
            if failure:
                self.assertEqual(rows[-3]['exit'], 124 if failure == 'timeout' else 1)

    def test_every_candidate_live_step_receives_credential_and_redacts_artifacts(self):
        ci = candidate.load(candidate.TOOLS_ROOT / 'tests/measurement_ci.py', 'candidate_delivery_ci')
        runner = candidate.load(candidate.TOOLS_ROOT / 'scripts/run-tests.py', 'candidate_delivery_runner')
        with tempfile.TemporaryDirectory() as folder:
            candidate.configure(candidate.TOOLS_ROOT, ci, runner, Path(folder) / 'plans')
            self.exercise_live_driver(ci, 'measurements')

    def test_every_hosted_profile_receives_credential_and_redacts_artifacts(self):
        ci = candidate.load(candidate.TOOLS_ROOT / 'tests/measurement_ci.py', 'hosted_delivery_ci')
        for profile in ci.PROFILES:
            with self.subTest(profile=profile):
                self.exercise_live_driver(ci, profile)

    def test_failed_and_timed_out_live_output_and_cleanup_remain_redacted(self):
        ci = candidate.load(candidate.TOOLS_ROOT / 'tests/measurement_ci.py', 'failed_delivery_ci')
        for failure in ('exit', 'timeout'):
            with self.subTest(failure=failure):
                self.exercise_live_driver(ci, 'measurements', failure)

    def test_candidate_uses_helper_from_target_source_and_records_its_hash(self):
        ci = SimpleNamespace(main=MagicMock())
        provider = MagicMock()
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            with patch.object(candidate, 'hosted_target', return_value=(candidate.TOOLS_ROOT, 'a' * 40)), \
                    patch.dict(os.environ, {'RUNNER_TEMP': folder}), \
                    patch.object(candidate, 'load', side_effect=[object(),
                        SimpleNamespace(ensure_imported_admin_credential=provider), ci]), \
                    patch.object(candidate, 'configure', return_value=(out, [])):
                candidate.run(candidate.TOOLS_ROOT, 'b' * 40)
            ci.main.assert_called_once_with('measurements', credential_provider=provider)
            provenance = json.loads((out / 'candidate-provenance.json').read_text(encoding='utf-8'))
            self.assertEqual(provenance['source_sha256']['tests/live_admin_credential.py'],
                             candidate.sha256(candidate.TOOLS_ROOT / 'tests/live_admin_credential.py'))


if __name__ == "__main__":
    unittest.main(verbosity=2)
