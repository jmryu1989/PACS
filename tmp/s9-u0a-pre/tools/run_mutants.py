# coding: utf-8
"""The 37 mutants of the PRE design (M01-M35: one moved unit back at its late original position; M36: a second Quick
Match closure registered on a real boot Retry; M37: the dictation edit notice registered after the citation input
listener) and M00 (every unit back = the f1d5406 page), each a scratch copy of main.html made by apply_moves.cjs and
run through the whole tests/main_early_input_dom_test.py (KIN_PRE_PAGE) under scripts/record-run.py.
A mutant is killed when at least one case FAILs on an assertion; ERRORs (import, fixture, timeouts) are not kills.
Usage: run_mutants.py [--jobs 4] [ids...]"""
import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
UNIT = ROOT / "tmp" / "s9-u0a-pre"
NODE = r"C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
SCRATCH = Path(tempfile.gettempdir()) / "kin-pre-mutants"
IDS = ["M00"] + [f"M{i:02d}" for i in range(1, 38)]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def make(mid):
    page = SCRATCH / f"{mid}.html"
    if mid == "M00":
        flags = ["--except", ",".join(f"M{i:02d}" for i in range(1, 36))]
    elif mid == "M36":
        flags = ["--m36"]
    elif mid == "M37":
        flags = ["--m37"]
    else:
        flags = ["--except", mid]
    made = subprocess.run([NODE, str(UNIT / "tools" / "apply_moves.cjs"), str(page), *flags], cwd=ROOT,
                          capture_output=True, text=True, encoding="utf-8")
    if made.returncode:
        raise RuntimeError(f"{mid}: {made.stderr}")
    return page, json.loads(made.stdout)


def run(mid):
    page, report = make(mid)
    env = dict(os.environ, KIN_PRE_PAGE=str(page), PYTHONIOENCODING="utf-8",
               PLAYWRIGHT_BROWSERS_PATH=r"C:\Users\norne\PACS\tmp\pw-browsers-good")
    env["PATH"] = str(Path(NODE).parent) + ";" + env["PATH"]
    for key in ("NODE_PATH", "KIN_PRE_SPEC", "KIN_PRE_TRACE_DIR"):
        env.pop(key, None)
    run_dir = UNIT / "runs" / f"mutant-{mid}"
    command = [sys.executable, "-B", "scripts/record-run.py", "--run-dir", str(run_dir), "--cwd", ".",
               "--file", "worklist-v0/hpacs-lite/main.html", "--file", "tests/main_early_input_dom_test.py",
               "--file", "tests/main_split_harness.py", "--file", "tests/main_split_harness.cjs",
               "--file", "tmp/s9-u0a-pre/tools/apply_moves.cjs", "--file", str(page),
               "--", sys.executable, "-B", "tests/main_early_input_dom_test.py"]
    done = subprocess.run(command, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log = (run_dir / "stderr.log").read_text(encoding="utf-8", errors="replace")
    fails = sorted(set(re.findall(r"^FAIL: (\S+) \(__main__\.(\w+)\.", log, re.M)))
    errors = sorted(set(re.findall(r"^ERROR: (\S+) \(__main__\.(\w+)\.", log, re.M)))
    summary = re.findall(r"^(Ran \d+ tests.*|OK.*|FAILED.*)$", log, re.M)
    first = re.search(r"^((?:HazardFailure|AssertionError): .{0,300})", log, re.M)
    return {"id": mid, "exit": done.returncode, "killed": bool(fails), "failed": [f"{c}.{t}" for t, c in fails],
            "errors": [f"{c}.{t}" for t, c in errors], "summary": summary, "first_failure": first and first.group(1),
            "page": str(page), "made": report.get("except") or ("m36" if report.get("m36") else "m37" if report.get("m37") else ""),
            "statements": report["statements"], "run": str(run_dir.relative_to(ROOT))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("ids", nargs="*")
    args = parser.parse_args()
    SCRATCH.mkdir(exist_ok=True)
    ids = args.ids or IDS
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for result in pool.map(run, ids):
            results[result["id"]] = result
            print(json.dumps({k: result[k] for k in ("id", "exit", "killed", "summary")}, ensure_ascii=False), flush=True)
            out = UNIT / "mutants.json"
            previous = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
            previous[result["id"]] = result
            out.write_text(json.dumps(previous, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
