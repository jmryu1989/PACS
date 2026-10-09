# coding: utf-8
"""A2 before/after: the 42 RELIST re-pointed test files (the 9 fixture-projection files among them), each under
scripts/record-run.py, in the tree given by --root; evidence is written under this unit's tmp/s9-u0a-pre/a2/<phase>/.
LiveStack files are not run (AGENTS 2). Usage: a2_run.py <phase> <root> [targets.json]"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
UNIT = Path(__file__).resolve().parents[1]
phase, root = sys.argv[1], Path(sys.argv[2]).resolve()
out = UNIT / "a2" / phase
out.mkdir(parents=True, exist_ok=False)
env = dict(os.environ)
env["PATH"] = r"C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + env["PATH"]
env["PYTHONPATH"] = str(root / "tests")
env["PLAYWRIGHT_BROWSERS_PATH"] = r"C:\Users\norne\PACS\tmp\pw-browsers-good"
env["PYTHONIOENCODING"] = "utf-8"
env.pop("NODE_PATH", None)  # TypeScript comes from the api/node_modules junction of the tree under test
for key in [k for k in env if k.startswith("KIN_")]:
    env.pop(key)
targets = json.loads(Path(sys.argv[3] if len(sys.argv) > 3 else UNIT / "inputs" / "a2-repoint-list.json").read_text(encoding="utf-8"))["targets"]
inputs = subprocess.check_output(["git", "ls-files", "worklist-v0", "config", "api", ".github/workflows", "tests"],
                                 cwd=root, text=True).splitlines()
HELPERS = ("tests/page_source.cjs", "tests/page_source.py", "tests/main_move_spec.json", "tests/main_move_contract.cjs",
           "tests/main_split_harness.cjs", "tests/main_split_harness.py")


def snapshot():
    return {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in inputs if (root / p).is_file()}


(out / "inputs-before.json").write_text(json.dumps(snapshot(), indent=1), encoding="utf-8")
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
results = []
for target in targets:
    name = target["path"]
    path = root / name
    if name in ("tests/invariants_live.py", "tests/worklist_columns_live.py"):
        results.append({"file": name, "status": "NOT RUN: LiveStack prohibited", "exit": None})
        continue
    run = out / "runs" / path.stem
    if path.suffix == ".cjs":
        command = [r"C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe", "--test", "--test-reporter=tap", name]
    elif "mutants" in path.name:
        command = [sys.executable, "-B", name, "--out", str(out / f"{path.stem}.json")]
    else:
        command = [sys.executable, "-B", name, "-v"]
    record = [sys.executable, "-B", str(root / "scripts" / "record-run.py"), "--run-dir", str(run), "--cwd", str(root),
              "--file", name, "--file", "worklist-v0/hpacs-lite/main.html", "--file", str(Path(__file__)),
              "--file", str(out / "inputs-before.json")]
    for helper in HELPERS:
        if (root / helper).is_file():
            record += ["--file", helper]
    print("START", phase, name, flush=True)
    done = subprocess.run(record + ["--"] + command, cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results.append({"file": name, "exit": done.returncode, "run": str(run)})
    print("END", phase, name, done.returncode, flush=True)
    (out / "results.json").write_text(json.dumps({"head": head, "root": str(root), "results": results},
                                                 ensure_ascii=False, indent=1), encoding="utf-8")
(out / "inputs-after.json").write_text(json.dumps(snapshot(), indent=1), encoding="utf-8")
