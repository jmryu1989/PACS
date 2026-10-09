# coding: utf-8
"""Probe only: run tests/main_early_input_dom_test.py unmarked (KIN_PRE_EXPECT_RED=0) against scratch variants of
main.html made by simulate_fix.cjs, each under scripts/record-run.py.
Usage: run_variants.py <label>=<variant,variant> [...] [-- unittest selectors...]"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PY = sys.executable
SIM = Path(tempfile.gettempdir()) / "kin-pre-sim"


def main():
    argv = sys.argv[1:]
    select = argv[argv.index("--") + 1:] if "--" in argv else []
    labels = argv[:argv.index("--")] if "--" in argv else argv
    SIM.mkdir(exist_ok=True)
    for item in labels:
        name, variants = item.split("=", 1)
        page = SIM / f"{name}.html"
        made = subprocess.run(["node", str(ROOT / "tmp/s9-u0a-pre/tools/simulate_fix.cjs"), variants, str(page)],
                              cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        if made.returncode:
            raise SystemExit(made.stderr)
        (ROOT / "tmp/s9-u0a-pre/runs").mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, KIN_PRE_PAGE=str(page), KIN_PRE_EXPECT_RED="0")
        run_dir = ROOT / "tmp/s9-u0a-pre/runs" / f"sim-{name}"
        command = [PY, "scripts/record-run.py", "--run-dir", str(run_dir), "--cwd", ".",
                   "--file", "worklist-v0/hpacs-lite/main.html", "--file", "tests/main_early_input_dom_test.py",
                   "--file", "tests/main_split_harness.py", "--file", "tests/main_split_harness.cjs",
                   "--file", "tmp/s9-u0a-pre/tools/simulate_fix.cjs", "--file", str(page),
                   "--", PY, "tests/main_early_input_dom_test.py", *select]
        result = subprocess.run(command, cwd=ROOT, env=env)
        (run_dir.parent / f"sim-{name}.variant.json").write_text(made.stdout, encoding="utf-8")
        print(json.dumps({"variant": name, "made": variants, "exit": result.returncode}), flush=True)


if __name__ == "__main__":
    main()
