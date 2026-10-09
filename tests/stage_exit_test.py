"""REQ-LEAN-EXIT → RISK-FALSE-PASS → TEST-LEAN-EXIT: 실제 결과를 쓰는 대표 사례.

제품 문자열/DOM 모양을 고정하지 않는다. 합성 unittest/Node 결과와 기존 기록기로
공개 CLI의 판정·JSON·exit를 검사한다. Docker·네트워크·공용 live 원장은 쓰지 않는다.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
RECORDER = ROOT / "scripts/record-run.py"
SCRIPT = ROOT / "scripts/stage-exit.py"
TEST = "lean_fixture.LeanFixture.test_one"


def load_tool(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_test_id(test, runner, workflow):
    """수집만 한다. TestCase.run/setUpClass나 live 실행 허가는 호출하지 않는다."""
    if test == "candidate-ci":
        candidate = load_tool(ROOT / "tests/candidate_ci.py", "lean_exit_candidate")
        _, selected = candidate.exact_selection(ROOT, runner)
        return {"id": test, "kind": "candidate", "collected": len(list(runner.collect({"tests": selected})))}
    if test.startswith("node:"):
        filename = test.removeprefix("node:")
        path = ROOT / filename
        if path.parent != ROOT / "tests" or path.suffix != ".cjs" or not path.is_file():
            raise ValueError("Unresolvable Node file: " + test)
        for job in workflow["jobs"].values():
            for step in job.get("steps", []):
                for line in step.get("run", "").splitlines():
                    # 이 파일을 실행하는 명령만 읽는다. 다른 단계의 셸 here-doc은 대상이 아니다.
                    if filename not in line or "--test" not in line:
                        continue
                    command = shlex.split(line, comments=True)
                    if "--test" not in command:
                        continue
                    tail = command[command.index("--test") + 1:]
                    if (filename not in tail and "/" + filename not in tail or not tail or
                            not all(arg.endswith(".cjs") and not arg.startswith("-") for arg in tail)):
                        continue
                    if any(arg.startswith(("--test-name-pattern", "--test-skip-pattern",
                                           "--test-only", "--test-shard")) for arg in command):
                        continue
                    return {"id": test, "kind": "node-file", "file": filename}
        raise ValueError("No unfiltered whole-file CI execution: " + test)
    parts = test.split(".")
    if len(parts) != 3:
        raise ValueError("Unresolvable Python ID: " + test)
    module, case, method = parts
    paths = list((ROOT / "tests").rglob(module + ".py"))
    if len(paths) != 1:
        raise ValueError("Unresolvable Python module: " + test)
    filename = paths[0].relative_to(ROOT).as_posix()
    try:
        suite = runner.collect({"tests": [{"file": filename, "case": case + "." + method}]})
    except runner.gate.Refused as error:
        raise ValueError("Unresolvable Python case: " + test) from error
    if [item.id() for item in suite] != [test]:
        raise ValueError("Collection differs from requested ID: " + test)
    return {"id": test, "kind": "python-case", "file": filename}


class RequiredTestResolutionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = load_tool(ROOT / "scripts/run-tests.py", "lean_exit_planner")
        cls.workflow = yaml.safe_load((ROOT / ".github/workflows/validate.yml").read_text(encoding="utf-8"))

    def test_stage7_required_ids_resolve_without_running_the_cases(self):
        required = json.loads((ROOT / "tests/stage7-exit.json").read_text(encoding="utf-8"))
        proof = []
        for requirement in required["requirements"]:
            self.assertTrue(requirement["tests"], requirement["id"])
            for test in requirement["tests"]:
                with self.subTest(requirement=requirement["id"], test=test):
                    proof.append({"requirement": requirement["id"],
                                  **resolve_test_id(test, self.runner, self.workflow)})
        directory = ROOT / "tmp/lean-exit-land"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "id-resolution.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")

    def test_unknown_module_class_and_method_fail_collection(self):
        for test in ("no_such_lean_exit_module.Case.test_missing",
                     "stage_exit_test.NoSuchCase.test_missing",
                     "stage_exit_test.StageExitTest.test_missing"):
            with self.subTest(test=test), self.assertRaises(ValueError):
                resolve_test_id(test, self.runner, self.workflow)

    def test_stage8_required_ids_resolve_without_running_the_cases(self):
        required = json.loads((ROOT / "tests/stage8-exit.json").read_text(encoding="utf-8"))
        proof = []
        for requirement in required["requirements"]:
            self.assertTrue(requirement["tests"], requirement["id"])
            for test in requirement["tests"]:
                with self.subTest(requirement=requirement["id"], test=test):
                    proof.append({"requirement": requirement["id"],
                                  **resolve_test_id(test, self.runner, self.workflow)})
        directory = ROOT / "tmp/s8-exit-list"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "id-resolution.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")

    def test_missing_node_file_fails_resolution(self):
        with self.assertRaises(ValueError):
            resolve_test_id("node:tests/no_such_lean_exit_file.cjs", self.runner, self.workflow)

    def test_a_filtered_node_run_does_not_resolve_a_whole_file(self):
        workflow = {"jobs": {"runtime": {"steps": [{"run":
            "node --test-name-pattern=one --test tests/session_work_gate_test.cjs"}]}}}
        with self.assertRaises(ValueError):
            resolve_test_id("node:tests/session_work_gate_test.cjs", self.runner, workflow)

    def test_an_unknown_special_id_fails_resolution(self):
        with self.assertRaises(ValueError):
            resolve_test_id("candidate-ci-missing", self.runner, self.workflow)


class StageExitTest(unittest.TestCase):
    def setUp(self):
        (ROOT / "tmp").mkdir(exist_ok=True)
        # 실패/강제종료의 원문도 작업 폴더 안에 남겨 직접 확인할 수 있게 한다.
        self.directory = Path(tempfile.mkdtemp(prefix="lean-exit-", dir=ROOT / "tmp"))
        self.sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        self.requirements = self.directory / "required.json"
        self.output = self.directory / "verdict.json"

    def fixture(self, body="self.assertEqual(2 + 2, 4)"):
        path = self.directory / "lean_fixture.py"
        path.write_text("import unittest, os, time\nfrom pathlib import Path\n"
                        "class LeanFixture(unittest.TestCase):\n"
                        "    def test_one(self):\n        " + body + "\n"
                        "if __name__ == '__main__':\n"
                        "    unittest.main(module='lean_fixture', verbosity=2)\n", encoding="utf-8")
        return [sys.executable, "-B", str(path)]

    def record(self, command, name="run"):
        return [sys.executable, "-B", str(RECORDER), "--run-dir", str(self.directory / name),
                "--cwd", str(ROOT), "--", *command]

    def run_fixture(self, body="self.assertEqual(2 + 2, 4)"):
        run = subprocess.run(self.record(self.fixture(body)), capture_output=True, timeout=20)
        self.assertEqual(run.returncode, 0, run.stderr)

    def verdict(self, tests=None, sha=None, extra=()):
        self.requirements.write_text(json.dumps({"requirements": [
            {"id": "REQ-LEAN-EXIT", "statement": "모든 필수 시험이 해당 commit에서 통과함",
             "tests": tests if tests is not None else [TEST]}]}), encoding="utf-8")
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--list", str(self.requirements),
                                 "--sha", sha or self.sha, "--runs", str(self.directory / "run"),
                                 "--output", str(self.output), *extra], capture_output=True, timeout=20)
        report = json.loads(self.output.read_text(encoding="utf-8"))
        print(f"{self._testMethodName}: verdict exit={result.returncode}; raw={self.directory}", flush=True)
        return result.returncode, report

    def assert_failure(self, code, report, reason):
        self.assertEqual(code, 1)
        self.assertFalse(report["all_pass"])
        self.assertEqual(report["requirements"][0]["verdict"], "FAIL")
        self.assertIn(reason, " ".join(report["requirements"][0]["reasons"]))

    def test_all_pass(self):
        self.run_fixture()
        # 판정기의 입력 계약은 TAP이다. Node 설치나 실행 없이 같은 원문을 공급한다.
        tap = "1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
        node_run = subprocess.run(self.record([sys.executable, "-c", "print(" + repr(tap) + ")",
                                               "--test", "tests/lean_fixture.cjs"], "node"),
                                  capture_output=True, timeout=20)
        self.assertEqual(node_run.returncode, 0, node_run.stderr)
        # G3가 보존하는 같은 구조. 내용은 위 실제 unittest 실행의 원문이다.
        candidate = self.directory / "candidate"
        candidate.mkdir()
        log = (self.directory / "run/stderr.log").read_text(encoding="utf-8")
        (candidate / "lean_fixture.log").write_text(
            'EXACT_TESTS ' + json.dumps([TEST]) + '\n' + log +
            'PLAN_RESULT {"status": "passed", "exit_code": 0}\n', encoding="utf-8")
        (candidate / "cleanup.log").write_text("")
        (candidate / "results.json").write_text(json.dumps([
            {"name": "lean_fixture", "exit": 0, "seconds": 0},
            {"name": "cleanup", "exit": 0, "seconds": 0}]))
        (candidate / "candidate-provenance.json").write_text(json.dumps({
            "candidate_sha": self.sha, "sequence": [
                {"file": "tests/lean_fixture.py", "case": "LeanFixture.test_one"}]}))
        code, report = self.verdict([TEST, "node:tests/lean_fixture.cjs", "candidate-ci"],
                                    extra=["--runs", str(self.directory / "node"),
                                           "--candidate", str(candidate)])
        self.assertEqual(code, 0)
        self.assertTrue(report["all_pass"])
        self.assertEqual(report["requirements"][0]["verdict"], "PASS")

    def test_one_missing(self):
        self.run_fixture()
        self.assert_failure(*self.verdict([TEST, "lean_fixture.LeanFixture.test_forgotten"]), "누락")

    def test_node_batch_requires_every_case_to_pass_without_filtering(self):
        tests = ["node:tests/lean_fixture.cjs", "node:tests/second_fixture.cjs"]
        for name, counts, extra, expected in (
                ("passed", (2, 0, 0), [], True),
                ("failed", (1, 1, 0), [], False),
                ("skipped", (1, 0, 1), [], False),
                ("filtered", (2, 0, 0), ["--test-name-pattern=one"], False)):
            with self.subTest(name=name):
                passed, failed, skipped = counts
                tap = (f"1..2\n# tests 2\n# pass {passed}\n# fail {failed}\n"
                       f"# cancelled 0\n# skipped {skipped}\n# todo 0\n")
                run = subprocess.run(self.record(
                    [sys.executable, "-c", "print(" + repr(tap) + ")", *extra,
                     "--test", "tests/lean_fixture.cjs", "tests/second_fixture.cjs"], name),
                    capture_output=True, timeout=20)
                self.assertEqual(run.returncode, 0)
                # Test the public CLI with only this batch's record.
                self.requirements.write_text(json.dumps({"requirements": [
                    {"id": "batch", "statement": "whole files", "tests": tests}]}))
                result = subprocess.run([sys.executable, str(SCRIPT), "--list", str(self.requirements),
                    "--sha", self.sha, "--runs", str(self.directory / name),
                    "--output", str(self.output)], capture_output=True, timeout=20)
                report = json.loads(self.output.read_text(encoding="utf-8"))
                self.assertEqual(report["all_pass"], expected)
                self.assertEqual(result.returncode, 0 if expected else 1)
                for test in tests:
                    entries = report["requirements"][0]["tests"][test]
                    self.assertEqual(len(entries), 1)
                    self.assertEqual(entries[0]["reason"] == "PASS", expected)

    def test_interleaved_warning(self):
        self.run_fixture("import warnings; warnings.warn('synthetic child warning', UserWarning)")
        log = (self.directory / "run/stderr.log").read_text(encoding="utf-8")
        self.assertIn("UserWarning: synthetic child warning", log)
        self.assertIn("\nok\n", log)
        code, report = self.verdict()
        self.assertEqual(code, 0)
        self.assertTrue(report["all_pass"])

    def test_one_skipped(self):
        self.run_fixture("self.skipTest('synthetic unavailable fixture')")
        self.assert_failure(*self.verdict(), "건너뜀")

    def test_stray_ok_then_skipped(self):
        self.run_fixture("import sys; print('\\nok', file=sys.stderr, flush=True); "
                         "self.skipTest('synthetic unavailable fixture')")
        self.assert_failure(*self.verdict(), "미완료")

    def test_different_sha(self):
        self.run_fixture()
        other_sha = "0" * 40 if self.sha != "0" * 40 else "1" * 40
        self.assert_failure(*self.verdict(sha=other_sha), "다른 SHA")

    def test_child_really_killed_once(self):
        ready = self.directory / "child.pid"
        command = self.fixture(f"Path({str(ready)!r}).write_text(str(os.getpid())); time.sleep(30)")
        with subprocess.Popen(self.record(command), stdout=subprocess.PIPE, stderr=subprocess.PIPE) as recorder:
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline and recorder.poll() is None:
                time.sleep(.02)
            self.assertTrue(ready.exists(), "실제 시험 자식이 시작되지 않음")
            child_pid = int(ready.read_text())
            os.kill(child_pid, signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
            recorder.communicate(timeout=15)
            self.assertNotEqual(recorder.returncode, 0)
        raw = json.loads((self.directory / "run/run.json").read_text())
        self.assertNotEqual(raw["exit_code"], 0)
        self.assertNotIn("Ran 1 test", (self.directory / "run/stderr.log").read_text())
        print(f"real child killed once: child exit={raw['exit_code']}; recorder exit={recorder.returncode}", flush=True)
        self.assert_failure(*self.verdict(), "중단")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
