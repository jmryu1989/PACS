"""EMR-D hosted regressions (round 5 part (c), I-HOSTED-WRAPPER): the four shared service fixtures in the production API
image of TARGET_SHA, and unit B's contract file on Linux, each in one disposable container.

REQ-EMR-01/03/07, REQ-S5-U4p, REQ-S7-U3a (D1190) -> RISK-D-01..04 -> the fixtures' own cases (tests/finding_input_test.cjs,
tests/clinician_question_service_test.cjs, tests/image_request_service_test.cjs, tests/reader_assignment_scope_test.cjs) and
tests/emr/b/contract_test.cjs, with the case counts emr/units/d.json `hosted` declares.

Runs only through scripts/run-tests.py in live mode: the plans of the units emr-d-r5a2-hosted-regressions (AstraHosted) and
emr-d-r5a2-b-linux (AstraB), whose attempts the runner's ledger keeps. TARGET_SHA must be this checkout's HEAD (the tests
mounted read-only are that commit's) and the API image must be the identity accepted for it (KIN_TEST_API_IMAGE with
KIN_EMR_D_IMAGE_IDENTITY: the live suite's rule, tests/emr/d/live.py verified_image, D5D-03), so the compiled product the
fixtures load is that commit's too. Every container carries this run's label, has no network, a read-only root and a tmpfs
/tmp, mounts only this checkout read-only, and is removed when it ends; its command, image, exit, collected cases and raw
output are kept under tmp/emr-d/runs/hosted. Nothing else is created or touched. Synthetic data only.

`python -B tests/emr/d/astra_hosted_live.py --preflight` checks every precondition without starting a container, so a
missing image, identity or dependency directory never spends an attempt.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
import live_test_gate as gate  # noqa: E402

DECLARATION = json.loads((ROOT / "emr" / "units" / "d.json").read_text(encoding="utf-8"))["hosted"]
B_IMAGE = DECLARATION["b_image"]
KEPT = ROOT / "tmp" / "emr-d" / "runs" / "hosted"
TIMEOUT = 900


def verified_image():
    """The live suite's own identity rule (one rule for both: its verified_image), read from tests/emr/d/live.py."""
    spec = importlib.util.spec_from_file_location("emr_d_live_identity", ROOT / "tests" / "emr" / "d" / "live.py")
    live = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(live)
    image = os.environ.get("KIN_TEST_API_IMAGE")
    if not image:
        raise RuntimeError("KIN_TEST_API_IMAGE names no image: the fixtures load the compiled product of TARGET_SHA from it")
    return live.verified_image(image, os.environ.get("KIN_EMR_D_IMAGE_IDENTITY", str(ROOT / "tmp/emr-d-ci/image-identity.txt")), target())


def target():
    head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    sha = os.environ.get("TARGET_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or sha != head:
        raise RuntimeError("TARGET_SHA must name this checkout's HEAD %s, not %r" % (head, sha))
    return sha


def dependencies():
    """B's contract reads typescript from api/node_modules under the read-only mount: it must be a directory of this checkout
    (a link or junction cannot be resolved inside the container, r5a3 attempt 1)."""
    path = ROOT / "api" / "node_modules"
    junction = getattr(os.path, "isjunction", lambda _p: False)
    if path.is_symlink() or junction(path) or not (path / "typescript" / "lib" / "typescript.js").is_file():
        raise RuntimeError("api/node_modules must be an installed directory of this checkout (not a link) with typescript")


def tap(text):
    """Top-level cases of node's TAP report and its summary counts; nothing is inferred from a missing summary."""
    cases = [(m.group(1) is None, m.group(2)) for m in re.finditer(r"^(not )?ok \d+ - (.*)$", text, re.M)]
    summary = {key: int(value) for key, value in re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$", text, re.M)}
    return cases, summary


class HostedRun(unittest.TestCase):
    """One labelled container per fixture file; its record is kept whatever its outcome. No test of its own."""

    @classmethod
    def setUpClass(cls):
        gate.require_live_run()
        cls.token = uuid.uuid4().hex[:12]
        cls.label = "kin.emrd.hosted=" + cls.token

    def run_file(self, test_file, image, extra=()):
        declared = DECLARATION["files"][test_file]
        name = "kin-emrd-hosted-%s-%s" % (self.token, re.sub(r"[^a-z0-9]+", "-", Path(test_file).stem.lower()))
        command = ["docker", "run", "--rm", "--name", name, "--label", self.label, "--network", "none", "--read-only", "--tmpfs", "/tmp",
                   "-v", str(ROOT) + ":/src:ro", "-w", "/src", *extra, "--entrypoint", "node", image,
                   "--test", "--test-reporter=tap", test_file]
        image_id = subprocess.run(["docker", "image", "inspect", "-f", "{{.Id}}", image], capture_output=True, text=True).stdout.strip()
        started = time.time()
        try:
            result = subprocess.run(command, capture_output=True, timeout=TIMEOUT)
            code, out, err = result.returncode, result.stdout.decode("utf-8", "replace"), result.stderr.decode("utf-8", "replace")
        except subprocess.TimeoutExpired as expired:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=120)
            code, out = 124, (expired.stdout or b"").decode("utf-8", "replace")
            err = (expired.stderr or b"").decode("utf-8", "replace") + "\nTIMEOUT after %d s; container %s removed" % (TIMEOUT, name)
        cases, summary = tap(out)
        inventory, leftover = self.inventory()
        record = {"token": self.token, "label": self.label, "file": test_file, "image": image, "image_id": image_id, "command": command, "exit": code,
                  "seconds": round(time.time() - started, 1), "declared": declared, "summary": summary,
                  "cases": [{"passed": ok, "name": case} for ok, case in cases], "leftover": leftover, "inventory": inventory,
                  "stdout": out, "stderr": err}
        KEPT.mkdir(parents=True, exist_ok=True)
        (KEPT / ("%s-%s.json" % (self.token, Path(test_file).stem))).write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
        print("EMR_D_HOSTED " + json.dumps({k: record[k] for k in ("file", "image", "image_id", "exit", "declared", "summary", "leftover", "inventory")}),
              flush=True)
        print(out)
        print(err, file=sys.stderr)
        if leftover == "unknown":
            self.fail("the leftover containers of this run could not be observed (docker ps exit %s: %s); cleanup is not shown complete"
                      % (inventory["exit"], inventory["stderr"].strip() or "no output"))
        self.assertEqual(leftover, [], "every container of this run is removed")
        self.assertEqual((code, summary.get("tests"), summary.get("pass"), summary.get("fail"), summary.get("skipped"), summary.get("todo")),
                         (0, declared, declared, 0, 0, 0), test_file + ": exit 0 and exactly the declared cases, all passed, none skipped")
        self.assertEqual(sum(ok for ok, _ in cases), declared, test_file)

    def inventory(self):
        """This run's own containers still present (its label only; nothing else is listed or touched), with the query's
        exit, stdout and stderr. A query that fails or cannot run leaves the inventory "unknown", never an empty list,
        so cleanup is not recorded as complete without an observation (Astra C5R-02)."""
        command = ["docker", "ps", "-aq", "--filter", "label=" + self.label]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as error:
            return {"command": command, "exit": None, "stdout": "", "stderr": "%s: %s" % (type(error).__name__, error)}, "unknown"
        query = {"command": command, "exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
        return query, (result.stdout.split() if result.returncode == 0 else "unknown")


class AstraHosted(HostedRun):
    """The four shared service fixtures against the compiled product of TARGET_SHA (its image's /app/dist)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.image = verified_image()

    def fixture(self, test_file):
        self.run_file(test_file, self.image, ["-e", "NODE_PATH=/app/node_modules"])

    def test_finding_input(self):
        self.fixture("tests/finding_input_test.cjs")

    def test_question_service(self):
        self.fixture("tests/clinician_question_service_test.cjs")

    def test_image_request_service(self):
        self.fixture("tests/image_request_service_test.cjs")

    def test_assignment_scope(self):
        self.fixture("tests/reader_assignment_scope_test.cjs")


class AstraB(HostedRun):
    """Unit B's contract file on Linux (its rename/permission cases are Linux-only), the checkout of TARGET_SHA."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        target()
        dependencies()

    def test_b_contract(self):
        self.run_file("tests/emr/b/contract_test.cjs", B_IMAGE)


def preflight():
    """Every precondition of both units, without a container: TARGET_SHA, the image identity, B's image and dependencies,
    and the declaration against these classes."""
    problems = []
    for check in (target, verified_image, dependencies):
        try:
            check()
        except Exception as error:  # noqa: BLE001 - reported, never swallowed
            problems.append("%s: %s" % (check.__name__, error))
    if subprocess.run(["docker", "image", "inspect", B_IMAGE], capture_output=True).returncode:
        problems.append("the image %s is not present (pull it before the attempt)" % B_IMAGE)
    loader = unittest.defaultTestLoader
    found = {cls.__name__: sorted(loader.getTestCaseNames(cls)) for cls in (AstraHosted, AstraB)}
    declared = {cls: sorted(case.split(".")[1] for cases in DECLARATION["units"].values() for case in cases if case.split(".")[0] == cls)
                for cls in found}
    if found != declared:
        problems.append("the classes %s differ from the declared units %s" % (found, declared))
    print("EMR_D_HOSTED_PREFLIGHT " + json.dumps({"ok": not problems, "problems": problems}))
    return 1 if problems else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--preflight"]:
        sys.exit(preflight())
    raise SystemExit("Run through scripts/run-tests.py --mode live (or --preflight)")
