"""REQ-LEAN-EXIT → RISK-FALSE-PASS → TEST-LEAN-EXIT: 실제 결과를 쓰는 대표 사례.

제품 문자열/DOM 모양을 고정하지 않는다. 합성 unittest/Node 결과와 기존 기록기로
공개 CLI의 판정·JSON·exit를 검사한다. Docker·네트워크·공용 live 원장은 쓰지 않는다.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
RECORDER = ROOT / "scripts/record-run.py"
SCRIPT = ROOT / "scripts/stage-exit.py"
TEST = "lean_fixture.LeanFixture.test_one"


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
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node를 PATH에 추가한 뒤 실행해야 합니다")
        fixture = self.directory / "lean_fixture.cjs"
        fixture.write_text("require('node:test')('works', () => require('node:assert/strict').equal(4, 4));\n")
        node_run = subprocess.run(self.record([node, "--test-reporter=tap", "--test", str(fixture)], "node"),
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
