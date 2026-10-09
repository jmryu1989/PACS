# coding: utf-8
"""Quick check (not the A2 record): the 9 fixture-projection files and the capture test on the working tree."""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
env = dict(os.environ, PYTHONIOENCODING="utf-8", PLAYWRIGHT_BROWSERS_PATH=r"C:\Users\norne\PACS\tmp\pw-browsers-good")
env["PATH"] = r"C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + env["PATH"]
env.pop("NODE_PATH", None)
FILES = sys.argv[1:] or ["report_citation_dom_test.py", "report_cursor_insert_dom_test.py", "report_cursor_insert_mutants.py",
                         "report_dictation_host_dom_test.py", "report_dictation_input_dom_test.py", "report_rebase_dom_test.py",
                         "report_rebase_model_test.cjs", "report_structure_dom_test.py", "report_structure_mutants.py",
                         "report_dictation_capture_dom_test.py"]
out = Path(sys.argv[0]).resolve().parents[1] / "legacy9-quick"
out.mkdir(exist_ok=True)
for name in FILES:
    path = f"tests/{name}"
    if name.endswith(".cjs"):
        command = [r"C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe", "--test", path]
    elif "mutants" in name:
        command = [sys.executable, "-B", path, "--out", str(out / f"{Path(name).stem}.json")]
    else:
        command = [sys.executable, "-B", path, "-v"]
    done = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    text = done.stdout + done.stderr
    (out / f"{Path(name).stem}.log").write_text(text, encoding="utf-8")
    tail = [l for l in text.splitlines() if re.match(r"^(Ran |OK|FAILED|# (pass|fail|tests)|kill|KILL|summary)", l)]
    print(name, "exit", done.returncode, " | ".join(tail[-4:]), flush=True)
