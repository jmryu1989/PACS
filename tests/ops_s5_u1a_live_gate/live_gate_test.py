# coding: utf-8
"""Pure checks for the S5-U1a G2 live gate driver and summary (stdlib; no Docker, stack or network)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import run_live  # noqa: E402
import summarize  # noqa: E402

SHA = "88ce2df3b56ca1b63a66e14e0406e04aee5f2f62"
WORKFLOW = ROOT / ".github/workflows/s5-u1a-clinician-live.yml"
CLINICIAN = "kin-test-0123456789ab-clinician@local.test"
MIXED = "kin-test-0123456789ab-clinician-radiologist@local.test"
ADMIN = "kin-test-0123456789ab-jmryu@local.test"
EXACT_IDS = ["clinician_policy_live." + case for case in summarize.CASES]
LAUNCHED = ["/opt/venv/bin/python", "/w/target/scripts/run-tests.py", "--module", summarize.MODULE,
            "--mode", "live", "--unit", summarize.UNIT, "--timeout", "900"]


def audit_line(*actors):
    rows = [json.dumps({"id": index, "actor": actor, "action": "admin.user.update", "target": "x",
                        "detail": None, "at": "2026-09-26T00:00:00"}) for index, actor in enumerate(actors, 1)]
    return summarize.CLEANUP + json.dumps(rows, ensure_ascii=True)


def suite_log(routes=108, denied=102, markers=1, result="OK", ran=4, cleanup=(), plan_status="passed", plan_exit=0):
    stdout = [summarize.EXACT + json.dumps(EXACT_IDS)]
    stdout += [summarize.MARKER + json.dumps({"allowed": ["GET me", "POST auth/logout"], "denied": denied,
                                              "public": ["GET health"], "routes": routes}, sort_keys=True)] * markers
    stdout += list(cleanup)
    stdout.append(summarize.PLAN + json.dumps({"status": plan_status, "exit_code": plan_exit}))
    stderr = ["test_0%d (clinician_policy_live.%s) ... ok" % (n + 1, case) for n, case in enumerate(summarize.CASES)]
    stderr += ["", "-" * 70, "Ran %d tests in 41.203s" % ran, "", result]
    return "\n".join(stdout + stderr) + "\n"


class Recorded:
    """One workflow run's files: the driver's evidence directory and measurement_ci's output directory."""

    def __init__(self, root, log=None, exit_code=0, driver_exit=0, launched=LAUNCHED, checked_out=SHA,
                 attempts=({"status": "passed", "exit_code": 0},)):
        self.out, self.evidence = Path(root) / "out", Path(root) / "u1a-live"
        self.out.mkdir()
        self.evidence.mkdir()
        (self.out / "clinician_policy_live.log").write_text(suite_log() if log is None else log, encoding="utf-8")
        (self.out / "results.json").write_text(json.dumps([
            {"name": "stack", "exit": 0, "seconds": 70.0},
            {"name": "clinician_policy_live", "exit": exit_code, "seconds": 45.0},
            {"name": "cleanup", "exit": 0, "seconds": 9.0}]), encoding="utf-8")
        run_live.write_json(self.evidence / "provenance.json", {"candidate_sha": SHA, "checked_out_sha": checked_out,
                                                                "tools_sha": "f" * 40})
        run_live.write_json(self.evidence / "driver.json", {"exit": driver_exit, "launched_command": launched,
                                                            "error": None})
        (self.evidence / "test-gate").mkdir()
        run_live.write_json(self.evidence / "test-gate" / (summarize.UNIT + ".json"),
                            {"attempts": list(attempts), "max_attempts": 3})

    def summary(self, candidate=SHA):
        return summarize.build_summary(self.out, self.evidence, candidate, "123", "1")


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_expected_run_matches_every_check(self):
        summary = Recorded(self.temp.name, log=suite_log(cleanup=[audit_line(ADMIN, ADMIN)])).summary()
        self.assertTrue(summary["matches_expected"], summary["problems"])
        self.assertEqual((summary["candidate_sha"], summary["exit"], summary["routes"], summary["denied"],
                          summary["audit_rows"], summary["audit_rows_in_test"], summary["run_id"]),
                         (SHA, 0, 108, 102, 0, 0, "123"))
        self.assertEqual(summary["audit_archive_by_logical"], {"jmryu": 2})
        self.assertTrue(summary["marker"].startswith(summarize.MARKER))
        self.assertEqual((summary["tests_ran"], summary["unittest_result"], summary["attempts"]), (4, "OK", 1))
        self.assertEqual(summary["problems"], [])

    def test_route_counts_other_than_expected_fail(self):
        summary = Recorded(self.temp.name, log=suite_log(routes=110, denied=104)).summary()
        self.assertEqual((summary["routes"], summary["denied"]), (110, 104))
        self.assertFalse(summary["checks"]["routes_expected"] or summary["checks"]["denied_expected"])
        self.assertFalse(summary["matches_expected"])

    def test_marker_after_subtest_failures_is_not_a_pass(self):
        # subTest failures do not stop test_01, so the marker still prints its probe count.
        log = suite_log(result="FAILED (failures=3)", plan_status="failed", plan_exit=125)
        summary = Recorded(self.temp.name, log=log, exit_code=125, driver_exit=1).summary()
        self.assertEqual((summary["routes"], summary["denied"], summary["audit_rows_in_test"]), (108, 102, 0))
        self.assertIsNone(summary["audit_rows"], "cleanup is unproven without a clean unittest result")
        for name in ("unittest_ok", "plan_passed", "run_tests_exit_zero", "driver_exit_zero", "audit_rows_zero"):
            self.assertFalse(summary["checks"][name], name)
        self.assertFalse(summary["matches_expected"])

    def test_archived_clinician_rows_are_counted_and_mixed_identities_are_not(self):
        log = suite_log(cleanup=[audit_line(MIXED), audit_line(CLINICIAN, CLINICIAN)])
        summary = Recorded(self.temp.name, log=log).summary()
        self.assertEqual(summary["audit_rows"], 2)
        self.assertEqual(summary["audit_archive_by_logical"], {"clinician": 2, "clinician-radiologist": 1})
        self.assertFalse(summary["checks"]["audit_rows_zero"])
        self.assertFalse(summary["matches_expected"])

    def test_unparsed_cleanup_archive_leaves_the_audit_count_unknown(self):
        summary = Recorded(self.temp.name, log=suite_log(cleanup=[summarize.CLEANUP + "[not json"])).summary()
        self.assertIsNone(summary["audit_rows"])
        self.assertFalse(summary["matches_expected"])

    def test_missing_or_repeated_marker_fails(self):
        for markers in (0, 2):
            with self.subTest(markers=markers), tempfile.TemporaryDirectory() as root:
                summary = Recorded(root, log=suite_log(markers=markers)).summary()
                self.assertEqual(summary["marker_lines"], markers)
                self.assertIsNone(summary["marker"])
                self.assertIsNone(summary["audit_rows_in_test"])
                self.assertFalse(summary["checks"]["single_marker"])
                self.assertFalse(summary["matches_expected"])

    def test_run_identity_and_budget_failures(self):
        cases = {
            "candidate_checked_out": dict(checked_out="0" * 40),
            "single_attempt": dict(attempts=({"status": "failed"}, {"status": "passed"})),
            "launched_exact_command": dict(launched=LAUNCHED[:-1] + ["600"]),
            "exact_cases": dict(log=suite_log().replace(EXACT_IDS[3], EXACT_IDS[3] + "_renamed")),
        }
        for check, arguments in cases.items():
            with self.subTest(check=check), tempfile.TemporaryDirectory() as root:
                summary = Recorded(root, **arguments).summary()
                self.assertFalse(summary["checks"][check])
                self.assertFalse(summary["matches_expected"])
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(Recorded(root).summary(candidate="")["checks"]["candidate_checked_out"])

    def test_nothing_recorded_still_writes_a_failing_summary(self):
        out, evidence = Path(self.temp.name) / "absent", Path(self.temp.name) / "u1a-live"
        evidence.mkdir()
        output = evidence / "u1a-live-summary.json"
        with mock.patch("sys.stdout"):
            code = summarize.main(["write", "--out-dir", str(out), "--evidence", str(evidence), "--candidate-sha", SHA,
                                   "--run-id", "9", "--run-attempt", "1", "--output", str(output)])
        self.assertEqual(code, 0)
        summary = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual({key: summary[key] for key in ("exit", "marker", "routes", "denied", "audit_rows")},
                         dict.fromkeys(("exit", "marker", "routes", "denied", "audit_rows")))
        self.assertIn("results.json missing", summary["problems"])
        self.assertIn("clinician_policy_live.log missing", summary["problems"])
        self.assertFalse(summary["matches_expected"])
        with mock.patch("sys.stdout"):
            self.assertEqual(summarize.main(["check", str(output)]), 1)

    def test_check_exits_zero_only_for_a_matching_summary(self):
        recorded = Recorded(self.temp.name)
        output = recorded.evidence / "u1a-live-summary.json"
        with mock.patch("sys.stdout"):
            self.assertEqual(summarize.main(["write", "--out-dir", str(recorded.out), "--evidence",
                                             str(recorded.evidence), "--candidate-sha", SHA, "--run-id", "9",
                                             "--run-attempt", "1", "--output", str(output)]), 0)
            self.assertEqual(summarize.main(["check", str(output)]), 0)


class FakeRunner:
    def __init__(self, cases):
        self.cases, self.calls = cases, []

    def module_plan(self, filename, unit, mode, timeout, class_name=None):
        self.calls.append((filename, unit, mode, timeout, class_name))
        return {"unit": unit, "mode": mode, "tests": [{"file": filename, "case": case} for case in self.cases],
                "max_attempts": 3, "timeout_seconds": timeout}


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_committed_candidate_matches_the_dispatch_default(self):
        self.assertEqual(run_live.resolve_candidate("push", "", HERE / "candidate.txt"), SHA)
        self.assertIn("default: " + SHA + "\n", WORKFLOW.read_text(encoding="utf-8"))

    def test_candidate_resolution_is_strict(self):
        path = Path(self.temp.name) / "candidate.txt"
        for content in (SHA.encode() + b"\n", SHA.encode() + b"\r\n"):
            path.write_bytes(content)
            self.assertEqual(run_live.resolve_candidate("push", "ignored", path), SHA)
        for content in (SHA.encode(), SHA.upper().encode() + b"\n", SHA[:39].encode() + b"\n",
                        SHA.encode() + b"\n\n", b" " + SHA.encode() + b"\n"):
            path.write_bytes(content)
            with self.subTest(content=content), self.assertRaises(RuntimeError):
                run_live.resolve_candidate("push", "", path)
        self.assertEqual(run_live.resolve_candidate("workflow_dispatch", SHA, path), SHA)
        for event, value in (("workflow_dispatch", SHA[:12]), ("workflow_dispatch", ""), ("pull_request", SHA)):
            with self.subTest(event=event, value=value), self.assertRaises(RuntimeError):
                run_live.resolve_candidate(event, value, HERE / "candidate.txt")

    def test_exact_plan_accepts_only_the_four_declared_cases(self):
        runner = FakeRunner(summarize.CASES)
        self.assertEqual([row["case"] for row in run_live.exact_plan(runner)], list(summarize.CASES))
        self.assertEqual(runner.calls, [(summarize.MODULE, summarize.UNIT, "live", 900, None)])
        for cases in (summarize.CASES[:3], summarize.CASES + ("ClinicianPolicyLive.test_05_extra",),
                      tuple(reversed(summarize.CASES))):
            with self.subTest(cases=len(cases)), self.assertRaises(RuntimeError):
                run_live.exact_plan(FakeRunner(cases))

    def test_the_real_profile_runner_yields_the_one_exact_command_once(self):
        # This checkout's measurement_ci is byte-identical to the candidate's (489c326..88ce2df leaves it alone).
        ci = run_live.load(ROOT / "tests/measurement_ci.py", "u1a_test_measurement_ci")
        record = {"launched_command": None}
        profile = run_live.configure(ci, ROOT, record)
        self.assertEqual((profile["suite_timeout"], profile["suites"], profile["out"]),
                         (900, (("clinician_policy_live.py", None, summarize.UNIT),),
                          ROOT / "tests/e2e/artifacts/s5-u1a-clinician-live-ci"))
        self.assertNotIn("suite_budgets", profile)
        command, outer = ci.guarded_profile_run(profile, *profile["suites"][0], 1500 - 70)
        self.assertEqual(command, [sys.executable, str(ROOT / "scripts/run-tests.py"), "--module",
                                   "tests/clinician_policy_live.py", "--mode", "live", "--unit",
                                   "s5-u1a-clinician-live", "--timeout", "900"])
        self.assertEqual((outer, record["launched_command"]), (935, command))
        with self.assertRaisesRegex(RuntimeError, "runs once"):
            ci.guarded_profile_run(profile, *profile["suites"][0], 1500)
        with self.assertRaisesRegex(RuntimeError, "already declares"):
            run_live.configure(ci, ROOT, {"launched_command": None})

    def test_a_shortened_timeout_is_refused_before_launch(self):
        ci = run_live.load(ROOT / "tests/measurement_ci.py", "u1a_test_measurement_ci_short")
        record = {"launched_command": None}
        profile = run_live.configure(ci, ROOT, record)
        with self.assertRaisesRegex(RuntimeError, "Refusing a changed live command"):
            ci.guarded_profile_run(profile, *profile["suites"][0], 934)
        self.assertIsNone(record["launched_command"])

    def test_ledger_copy_keeps_this_unit_and_the_inspection_marker_only(self):
        state, destination = Path(self.temp.name) / "state", Path(self.temp.name) / "copy"
        state.mkdir()
        for name in ("s5-u1a-clinician-live.json", "s5-u1a-clinician-live-attempt-1.json",
                     "s5-u1a-clinician-live.lock", "live.lock", "live-needs-inspection.json", "ci-other.json"):
            (state / name).write_text("{}", encoding="utf-8")
        self.assertEqual(run_live.retain_ledger(state, destination),
                         ["live-needs-inspection.json", "s5-u1a-clinician-live-attempt-1.json",
                          "s5-u1a-clinician-live.json"])
        self.assertEqual(run_live.retain_ledger(Path(self.temp.name) / "absent", destination / "none"), [])

    def test_refusal_outside_hosted_ci_records_the_driver_without_launching(self):
        evidence = Path(self.temp.name) / "u1a-live"
        evidence.mkdir()
        with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), mock.patch("traceback.print_exc"):
            code = run_live.run_recorded(Path(self.temp.name) / "target", SHA, evidence)
        record = json.loads((evidence / "driver.json").read_text(encoding="utf-8"))
        self.assertEqual((code, record["exit"], record["launched_command"]), (125, 125, None))
        self.assertIn("GitHub-hosted", record["error"])
        self.assertEqual(sorted(path.name for path in evidence.iterdir()), ["driver.json"])
        (evidence / "driver.json").unlink()
        (evidence / "stale.json").write_text("{}", encoding="utf-8")
        with mock.patch("traceback.print_exc"):
            self.assertEqual(run_live.run_recorded(Path(self.temp.name) / "target", SHA, evidence), 125)
        self.assertIn("must exist and be empty", json.loads((evidence / "driver.json").read_text("utf-8"))["error"])


class WorkflowTextTests(unittest.TestCase):
    """Text pins only: no YAML parser is assumed on the runner's system Python."""

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_triggers_permissions_and_rerun_refusal(self):
        self.assertIn("  push:\n    branches: [opus/s5-u1a-live-gate-20260926]\n", self.text)
        self.assertIn("  workflow_dispatch:\n", self.text)
        self.assertIn("permissions:\n  contents: read\n", self.text)
        self.assertIn("cancel-in-progress: false", self.text)
        self.assertIn('[ "$RUN_ATTEMPT" = "1" ]', self.text)
        self.assertNotIn("secrets.", self.text)
        self.assertNotIn("continue-on-error", self.text)
        self.assertEqual(self.text.count("persist-credentials: false"), 2)

    def test_the_live_driver_runs_once_and_actions_are_pinned(self):
        self.assertEqual(self.text.count("run_live.py run "), 1)
        self.assertEqual(self.text.count("--timeout"), 1, "only the header comment names the fixed timeout")
        uses = re.findall(r"uses: (\S+)", self.text)
        self.assertTrue(uses)
        for action in uses:
            self.assertRegex(action, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
