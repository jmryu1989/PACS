# coding: utf-8
"""Pure guards for REQ-SERVER-UPDATE-20260911 candidate selection."""
import os
import contextlib
import io
import json
import copy
import re
import shlex
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
        # S7-U1a: 89 invariants (six CriticalResultInvariantTests) + 15 worklist + 8 flows; S8-CTX: + 2 Tech Note flows;
        # EMR-B1: + the ledger's L01 (emr/units/b.json candidate_cases).
        self.assertEqual(len(selected), 115)
        self.assertEqual([item["case"] for item in selected[-11:]],
            [class_name + "." + method for _, class_name, method, _ in candidate.FLOWS])
        declaration = json.loads((target / "emr/units/b.json").read_text(encoding="utf-8"))
        self.assertEqual(selected[-1:], [{"file": row["file"], "case": row["case"]} for row in declaration["candidate_cases"]])
        for filename, class_name, method, prefix in candidate.FLOWS:
            module = runner.load_module(target / "tests" / filename)
            self.assertTrue(method.startswith(prefix))
            self.assertIn(method, getattr(module, class_name).__dict__)
        # Every runner unit is its own; the earlier e2e flow units keep their names.
        self.assertEqual(len({row[2] for row in rows}), len(rows))
        self.assertEqual(rows[2][2], "candidate-flow-document-session")
        self.assertEqual(rows[-1], ("emr/b/live.py", "EmrBLedgerLive", "candidate-flow-emr-b-live"))
        # Two flows that would share a unit are refused, never run under one plan.
        doubled = candidate.FLOWS + (("emr/b/live.py", "EmrBLedgerLive", "test_b02_business_commit_and_failure_journal", "test_b02_"),)
        with patch.object(candidate, "FLOWS", doubled), self.assertRaisesRegex(RuntimeError, "units must be unique"):
            candidate.exact_selection(target, runner)

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
            self.assertEqual(len(profile["suites"]), 13)
            command, timeout = FakeCi.guarded_profile_run(profile, *profile["suites"][2], 1000)
            self.assertEqual(Path(command[1]), candidate.TOOLS_ROOT / "scripts/run-tests.py")
            self.assertEqual(command[2], "--plan")
            self.assertEqual(timeout, 575)
            env = FakeCi.profile_environment("measurements", out, {"ORTHANC_PASS": "synthetic"})
            self.assertEqual(env["KIN_EVIDENCE_DIR"], str(out / "screens"))
            self.assertEqual(len(selected), 115)

    def assert_candidate_workflow(self, workflow):
        # Limited declaration normalisation, not a GitHub expression engine.
        # Actual PR/dispatch choice: hosted runs 37711559409/37714866220/37711563733.
        # env["X"] is an input contract here, not a claim that GitHub accepts
        # double-quoted strings inside ${{ }} expressions.
        def expression(value):
            match = re.fullmatch(r'\s*\$\{\{(.*?)\}\}\s*', value)
            self.assertIsNotNone(match)
            text = re.sub(r'''\[\s*(['"])([A-Za-z_]\w*)\1\s*\]''', r'.\2', match[1])
            text = re.sub(r'[\s()]', '', text)
            parts = tuple(text.split('||'))
            for part in parts:
                self.assertRegex(part, r'^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$')
            return parts

        def resolve(value, scopes):
            if isinstance(value, tuple):
                return value
            self.assertIsInstance(value, str)
            if '${{' not in value:
                return value
            parts = expression(value)
            if len(parts) == 1 and parts[0].startswith('env.'):
                key = parts[0][4:]
                for index in reversed(range(len(scopes))):
                    if key in scopes[index]:
                        # Declarations read their enclosing scope, including a
                        # same-name override that reuses its parent's value.
                        return resolve(scopes[index][key], scopes[:index])
                self.fail('Undefined SHA variable: ' + key)
            self.assertFalse(any(part.startswith('env.') for part in parts))
            return parts

        triggers = workflow.get('on', workflow.get(True)) # YAML 1.1 spells `on` as a boolean.
        self.assertEqual(set(triggers), {'pull_request', 'workflow_dispatch'})
        self.assertIsNone(triggers['pull_request'])
        self.assertEqual(triggers['workflow_dispatch']['inputs']['candidate_sha']['required'], True)
        job = workflow['jobs']['candidate']
        self.assertEqual(job.get('name', 'candidate'), 'candidate')
        job_env = [workflow.get('env', {}), job.get('env', {})]
        source = expression(job['env']['CANDIDATE_SHA'])
        self.assertEqual(source, ('inputs.candidate_sha', 'github.event.pull_request.head.sha'))
        reference = resolve('${{ env.CANDIDATE_SHA }}', job_env)

        def environment(step):
            return job_env + [step.get('env', {})]

        def command(flag):
            found = [(step, shlex.split(line, comments=True)) for step in job['steps']
                     for line in step.get('run', '').splitlines() if flag in line]
            self.assertEqual(len(found), 1)
            step, argv = found[0]
            self.assertIn(flag, argv)
            self.assertTrue(any(Path(arg).name == 'candidate_ci.py' for arg in argv))
            argument = argv[argv.index(flag) + 1]
            shell = re.fullmatch(r'\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})', argument)
            if shell:
                argument = '${{ env.' + (shell[1] or shell[2]) + ' }}'
            self.assertEqual(resolve(argument, environment(step)), reference, flag)
            return step
        self.assertFalse(workflow['concurrency']['cancel-in-progress'])
        checkouts = {s['with']['path']: s for s in job['steps'] if s.get('uses', '').startswith('actions/checkout@')}
        self.assertEqual(set(checkouts), {'tools', 'target'})
        self.assertEqual(expression(checkouts['tools']['with']['ref']), ('github.sha',))
        for checkout in checkouts.values():
            self.assertEqual(checkout['with']['persist-credentials'], False)
        validation = command('--check-sha')
        command('--candidate-sha')
        self.assertLess(job['steps'].index(validation), job['steps'].index(checkouts['target']))
        artifact = next(s for s in job['steps'] if s.get('uses', '').startswith('actions/upload-artifact@'))
        target = checkouts['target']
        self.assertEqual(resolve(target['with']['ref'], environment(target)), reference)
        self.assertTrue(artifact['with']['name'].startswith('candidate-'))
        self.assertEqual(resolve(artifact['with']['name'][len('candidate-'):], environment(artifact)), reference)
        # Workflow concurrency has no job/step env context.
        group = workflow['concurrency']['group']
        self.assertTrue(group.startswith('candidate-'))
        self.assertEqual(expression(group[len('candidate-'):]), source)
        self.assertEqual(artifact['with']['path'], 'target/tests/e2e/artifacts/candidate-ci/')

    def test_workflow_keeps_tool_and_candidate_checkouts_separate(self):
        import yaml
        workflow = yaml.safe_load((candidate.TOOLS_ROOT / '.github/workflows/candidate.yml').read_text(encoding='utf-8'))
        self.assert_candidate_workflow(workflow)
        for step in workflow['jobs']['candidate']['steps']:
            self.assertNotIn('docker compose', step.get('run', '').lower())

    def test_workflow_accepts_equivalent_sha_references_and_command_spelling(self):
        import yaml
        workflow = yaml.safe_load((candidate.TOOLS_ROOT / '.github/workflows/candidate.yml').read_text(encoding='utf-8'))
        job = workflow['jobs']['candidate']
        job['env']['CANDIDATE_SHA'] = '${{ (inputs.candidate_sha) || (github.event.pull_request.head.sha) }}'
        target = next(s for s in job['steps'] if s.get('with', {}).get('path') == 'target')
        target['with']['ref'] = job['env']['CANDIDATE_SHA']
        validation = next(s for s in job['steps'] if '--check-sha' in s.get('run', ''))
        validation['run'] = 'python3 -u tools/tests/candidate_ci.py --check-sha "${CANDIDATE_SHA}" # verified input\n'
        self.assert_candidate_workflow(workflow)

    def test_workflow_rejects_divergent_sha_consumers_and_unsafe_checkout_order(self):
        import yaml
        original = yaml.safe_load((candidate.TOOLS_ROOT / '.github/workflows/candidate.yml').read_text(encoding='utf-8'))
        for defect in ('source', 'target', 'concurrency', 'artifact', 'artifact-prefix', 'validation-input',
                       'candidate-input', 'validation-order',
                       'tools-credentials', 'target-credentials'):
            with self.subTest(defect=defect):
                workflow = copy.deepcopy(original)
                job = workflow['jobs']['candidate']
                steps = job['steps']
                checkouts = {s['with']['path']: s for s in steps if s.get('uses', '').startswith('actions/checkout@')}
                validation = next(s for s in steps if '--check-sha' in s.get('run', ''))
                artifact = next(s for s in steps if s.get('uses', '').startswith('actions/upload-artifact@'))
                if defect == 'source':
                    job['env']['CANDIDATE_SHA'] = '${{ inputs.candidate_sha || github.sha }}'
                elif defect == 'target':
                    checkouts['target']['with']['ref'] = '${{ github.sha }}'
                elif defect == 'concurrency':
                    workflow['concurrency']['group'] = 'candidate-${{ github.sha }}'
                elif defect == 'artifact':
                    artifact['with']['name'] = 'candidate-${{ github.sha }}'
                elif defect == 'artifact-prefix':
                    artifact['with']['name'] = 'other-${{ env.CANDIDATE_SHA }}'
                elif defect == 'validation-input':
                    validation['run'] = 'python3 tools/tests/candidate_ci.py --check-sha "$GITHUB_SHA"'
                elif defect == 'candidate-input':
                    step = next(s for s in steps if '--candidate-sha' in s.get('run', ''))
                    step['run'] = 'python3 tools/tests/candidate_ci.py --candidate-sha "$GITHUB_SHA"'
                elif defect == 'validation-order':
                    steps.remove(validation)
                    steps.append(validation)
                else:
                    checkouts[defect.split('-')[0]]['with']['persist-credentials'] = True
                with self.assertRaises(AssertionError):
                    self.assert_candidate_workflow(workflow)

    def test_each_sha_consumer_uses_its_effective_environment(self):
        import yaml
        original = yaml.safe_load((candidate.TOOLS_ROOT / '.github/workflows/candidate.yml').read_text(encoding='utf-8'))
        for consumer in ('target', 'artifact', '--check-sha', '--candidate-sha'):
            for same_value in (False, True, 'parent-reference'):
                with self.subTest(consumer=consumer, same_value=same_value):
                    workflow = copy.deepcopy(original)
                    job = workflow['jobs']['candidate']
                    step = next(s for s in job['steps'] if
                                (consumer == 'target' and s.get('with', {}).get('path') == 'target') or
                                (consumer == 'artifact' and s.get('uses', '').startswith('actions/upload-artifact@')) or
                                (consumer.startswith('--') and consumer in s.get('run', '')))
                    step['env'] = {'CANDIDATE_SHA': job['env']['CANDIDATE_SHA'] if same_value else 'd' * 40}
                    if same_value == 'parent-reference':
                        step['env'] = {'CANDIDATE_SHA': "${{ env['CANDIDATE_SHA'] }}"}
                    if same_value:
                        self.assert_candidate_workflow(workflow)
                    else:
                        with self.assertRaises(AssertionError):
                            self.assert_candidate_workflow(workflow)

    def test_equivalent_references_shadowed_and_unused_environment_values_pass(self):
        import yaml
        original = yaml.safe_load((candidate.TOOLS_ROOT / '.github/workflows/candidate.yml').read_text(encoding='utf-8'))
        for reference in ('env.CANDIDATE_SHA', "env['CANDIDATE_SHA']", 'env["CANDIDATE_SHA"]'):
            with self.subTest(reference=reference):
                workflow = copy.deepcopy(original)
                workflow['env'] = {'CANDIDATE_SHA': 'shadowed-value', 'UNUSED': 'workflow'}
                for step in workflow['jobs']['candidate']['steps']:
                    step['env'] = {'UNUSED': "${{ hashFiles('irrelevant.txt') }}"}
                    if step.get('with', {}).get('path') == 'target':
                        step['with']['ref'] = '${{ (' + reference + ') }}'
                    if step.get('uses', '').startswith('actions/upload-artifact@'):
                        step['with']['name'] = 'candidate-${{ ' + reference + ' }}'
                    if '--check-sha' in step.get('run', '') or '--candidate-sha' in step.get('run', ''):
                        step['run'] = step['run'].replace('$CANDIDATE_SHA', '${CANDIDATE_SHA}')
                self.assert_candidate_workflow(workflow)

    def test_candidate_install_is_cached_and_fits_the_job_budget(self):
        import yaml
        workflow = yaml.safe_load((candidate.TOOLS_ROOT / '.github/workflows/candidate.yml').read_text(encoding='utf-8'))
        job = workflow['jobs']['candidate']
        install = next(s for s in job['steps'] if 'playwright install' in s.get('run', ''))
        self.assertEqual(install['timeout-minutes'], 15)
        cache = job['steps'][job['steps'].index(install) - 1]
        self.assertRegex(cache['uses'], r'^actions/cache@[0-9a-f]{40}$')
        self.assertEqual(cache['with']['path'], '~/.cache/pip')
        self.assertEqual(cache['with']['key'], "${{ runner.os }}-pip-${{ hashFiles('target/tests/e2e/requirements.txt', 'target/gateway/agent/requirements.txt') }}")
        run = next(s for s in job['steps'] if '--candidate-sha' in s.get('run', ''))
        self.assertEqual(run['timeout-minutes'], 26)
        self.assertGreater(job['timeout-minutes'], install['timeout-minutes'] + run['timeout-minutes'])

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
                # This redaction probe returns before live admission. Real marker
                # lifecycle coverage belongs to the real-runner driver regression.
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
                    patch.object(ci.gate, 'STATE', root / 'gate-state'), \
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
            self.assertEqual(len(live), len(ci.PROFILES[profile_name]['suites']))
            for artifact in out.rglob('*'):
                if artifact.is_file():
                    self.assertNotIn(secret, artifact.read_text(encoding='utf-8'))
            self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())
            rows = json.loads((out / 'results.json').read_text(encoding='utf-8'))
            self.assertEqual(rows[-1]['name'], 'cleanup')
            if failure:
                modules = {Path(suite).stem for suite, _, _ in ci.PROFILES[profile_name]['suites']}
                failed = [row for row in rows if row['name'] in modules]
                self.assertEqual(len(failed), len(live))
                self.assertTrue(all(row['exit'] == (124 if failure == 'timeout' else 1) for row in failed))

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
