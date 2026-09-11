# coding: utf-8
"""REQ-SERVER-UPDATE-20260911: run an immutable candidate in disposable hosted CI."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys


TOOLS_ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r"[0-9a-f]{40}")
BASE = (
    ("invariants_live.py", None, "candidate-invariants", 69),
    ("e2e/test_worklist.py", None, "candidate-worklist", 14),
)
FLOWS = (
    ("e2e/test_worklist_search.py", "WorklistSearchE2E", "test_search_01_manual_apply_enter_refresh_and_editor", "test_search_01_"),
    ("e2e/test_worklist_body_parts.py", "WorklistBodyPartsE2E", "test_worklist_body_parts_01_actual_metadata_saved_default_and_clear", "test_worklist_body_parts_01_"),
    ("e2e/test_saved_filter_manager.py", "SavedFilterManagerE2E", "test_manager_01_create_edit_default_relogin_apply_delete", "test_manager_01_"),
    ("e2e/test_shared_filters.py", "SharedFiltersE2E", "test_shared_05_browser_publish_copy_relogin_and_report_draft", "test_shared_05_"),
    ("e2e/test_related_keyboard.py", "RelatedKeyboardE2E", "test_related_keyboard_01_preview_compare_and_report_draft", "test_related_keyboard_01_"),
    ("e2e/test_viewer_windows.py", "ViewerWindowsE2E", "test_windows_01_limit_dirty_close_focus_and_slot_reuse", "test_windows_01_"),
    ("e2e/test_frame_coverage.py", "FrameCoverageE2E", "test_coverage_01_real_frames_cancel_close_then_all_shown", "test_coverage_01_"),
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def valid_sha(value):
    require(type(value) is str and SHA.fullmatch(value), "candidate_sha must be full lowercase Git SHA")
    return value


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL).decode().strip()


def hosted_target(target, candidate_sha):
    candidate_sha = valid_sha(candidate_sha)
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "Requires a disposable GitHub-hosted runner")
    github_sha = valid_sha(os.environ.get("GITHUB_SHA"))
    target, tools = Path(target).resolve(), TOOLS_ROOT.resolve()
    require(target != tools and target not in tools.parents and tools not in target.parents,
            "Tools and candidate require separate checkouts")
    require(git(tools, "rev-parse", "HEAD") == github_sha, "Tools checkout differs from github.sha")
    require(git(target, "rev-parse", "HEAD") == candidate_sha, "Candidate checkout differs from requested SHA")
    require(not git(target, "status", "--porcelain"), "Candidate checkout must start clean")
    require((target / "tests/measurement_ci.py").is_file() and (target / "scripts/run-tests.py").is_file(),
            "Candidate CI entry points are missing")
    return target, github_sha


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, "Cannot load candidate module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def exact_selection(target, runner):
    rows, selected = [], []
    for filename, class_name, unit, count in BASE:
        plan = runner.module_plan("tests/" + filename, unit, "live", 540, class_name)
        require(len(plan["tests"]) == count, f"Unexpected {unit} count")
        rows.append((filename, class_name, unit))
        selected.extend(plan["tests"])
    for filename, class_name, method, prefix in FLOWS:
        module = runner.load_module(target / "tests" / filename)
        cls = getattr(module, class_name, None)
        require(isinstance(cls, type) and cls.__module__ == module.__name__, "Flow class must be declared in target source")
        require(method.startswith(prefix) and method in cls.__dict__ and callable(cls.__dict__[method]),
                "Flow method must be the declared target entry point")
        unit = "candidate-flow-" + filename.rsplit("/", 1)[-1].removeprefix("test_").removesuffix(".py").replace("_", "-")
        rows.append((filename, class_name, unit))
        selected.append({"file": "tests/" + filename, "case": class_name + "." + method})
    require(len(selected) == 90 and len({(x["file"], x["case"]) for x in selected}) == 90,
            "Candidate selection must contain 90 unique exact cases")
    return rows, selected


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configure(target, ci, runner, plan_dir):
    rows, selected = exact_selection(target, runner)
    plan_dir.mkdir(mode=0o700)
    plans = {}
    flow_cases = {(filename, class_name): method for filename, class_name, method, _ in FLOWS}
    for filename, class_name, unit in rows:
        method = flow_cases.get((filename, class_name))
        if method:
            path = plan_dir / (unit + ".json")
            path.write_text(json.dumps({"unit": unit, "mode": "live", "tests": [
                {"file": "tests/" + filename, "case": class_name + "." + method}],
                "max_attempts": 3, "timeout_seconds": 540}), encoding="utf-8")
            plans[unit] = path

    out = target / "tests/e2e/artifacts/candidate-ci"
    ci.PROFILES["measurements"] = {**ci.PROFILES["measurements"], "out": out,
        "suite_timeout": 540, "suites": tuple(rows)}
    original_run = ci.guarded_profile_run
    original_environment = ci.profile_environment

    def guarded(profile, suite, class_name, unit, remaining):
        if unit not in plans:
            return original_run(profile, suite, class_name, unit, remaining)
        seconds = min(profile["suite_timeout"], int(remaining) - 35)
        require(seconds >= 1, "Insufficient candidate CI time")
        # Plans use the target's own run-tests.py and exact target source paths.
        return [sys.executable, str(target / "scripts/run-tests.py"), "--plan", str(plans[unit])], seconds + 35

    def environment(profile_name, out_path, values, evidence_stage=None):
        env = original_environment(profile_name, out_path, values, evidence_stage)
        if profile_name == "measurements":
            env["KIN_EVIDENCE_DIR"] = str(out_path / "screens")
        return env

    ci.guarded_profile_run = guarded
    ci.profile_environment = environment
    return out, selected


def run(target, candidate_sha):
    target, github_sha = hosted_target(target, candidate_sha)
    sys.path.insert(0, str(target / "tests"))
    runner = load(target / "scripts/run-tests.py", "candidate_run_tests")
    ci = load(target / "tests/measurement_ci.py", "candidate_measurement_ci")
    runner_temp = os.environ.get("RUNNER_TEMP")
    require(runner_temp and Path(runner_temp).is_absolute(), "RUNNER_TEMP must be absolute")
    plan_dir = Path(runner_temp) / "kin-candidate-exact-plans"
    require(not plan_dir.exists(), "Candidate plan directory already exists")
    out, selected = configure(target, ci, runner, plan_dir)
    sources = sorted({row["file"] for row in selected} | {"tests/measurement_ci.py", "scripts/run-tests.py"})
    provenance = {"schema": 1, "requirement": "REQ-SERVER-UPDATE-20260911",
        "risks": ["RISK-DATA", "RISK-SOURCE", "RISK-ROLLBACK"], "test": "TEST-SERVER-UPDATE",
        "candidate_sha": candidate_sha, "tools_sha": github_sha,
        "sequence": selected, "source_sha256": {name: sha256(target / name) for name in sources},
        "synthetic_only": True, "github_hosted": True}
    try:
        ci.main("measurements")
    finally:
        if out.is_dir():
            (out / "candidate-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-sha")
    parser.add_argument("--target", type=Path)
    parser.add_argument("--candidate-sha")
    args = parser.parse_args()
    if args.check_sha:
        valid_sha(args.check_sha)
        return
    require(args.target is not None and args.candidate_sha is not None, "Target and candidate SHA are required")
    run(args.target, args.candidate_sha)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print("CANDIDATE_CI_REFUSED: " + str(error), file=sys.stderr)
        raise SystemExit(125)
