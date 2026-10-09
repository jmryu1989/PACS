# coding: utf-8
"""From the full mutant runs (mutants.json + each run's stderr), one killing case per mutant and the text of its own
failure that names the moved binding (or the user result) - the table tests/main_early_input_mutants.py uses - and a
markdown record of every kill. Usage: kill_table.py <out.json> <out.md>"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
UNIT = ROOT / "tmp" / "s9-u0a-pre"
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
results = json.loads((UNIT / "mutants.json").read_text(encoding="utf-8"))
import subprocess, tempfile  # noqa: E402
UNITS = json.loads(subprocess.check_output([r"C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe", str(UNIT / "tools" / "apply_moves.cjs"), str(Path(tempfile.gettempdir()) / "kin-pre-kill-table.html")], cwd=ROOT, text=True, encoding="utf-8"))["units"]
NAMES = {u["id"]: u["name"] for u in UNITS}


def blocks(log):
    out = {}
    for block in re.split(r"^={10,}$", log, flags=re.M):
        head = re.search(r"^FAIL: (\S+) \(__main__\.(\w+)\.", block, re.M)
        if head:
            out[f"{head.group(2)}.{head.group(1)}"] = block
    return out


def preference(case):
    order = ("EarlyInputSplit.test_B1_03_45_hold", "EarlyInputSplit.test_B1_05_45_hold", "EarlyInputSplit.test_B1_05_TAB_45_hold",
             "EarlyInputSplit.test_PRE_X2_45_hold", "EarlyInputSplit.test_PRE_X1_45_hold", "EarlyInputSplit.test_B1_58_45_hold",
             "EarlyInputSplit.test_B1_15_45", "EarlyInputSplit.test_B1_41_45", "EarlyInputSplit.test_B1_57_45",
             "EarlyInputSplit.test_PRE_P3_45", "EarlyInputSplit.", "Registration.test_after_retry",
             "Registration.test_a_report_field_input", "Registration.")
    return next((i for i, prefix in enumerate(order) if case.startswith(prefix)), len(order))


table, lines = [], ["| M | 이동 단위 | 실패 사례 수 | 고른 사례 | 그 사례의 실패 문구 |", "|---|---|---:|---|---|"]
for mid in [f"M{i:02d}" for i in range(1, 38)]:
    row = results[mid]
    log = (ROOT / row["run"] / "stderr.log").read_text(encoding="utf-8", errors="replace")
    found = blocks(log)
    # Two choices by hand: M26 is caught deterministically by the unsplit control's chips (its timed case also kills it),
    # M37 by the invocation order of one input (the design's own assertion for it).
    chosen = {"M26": "UnsplitControl.test_B1_58_unsplit",
              "M37": "Registration.test_a_report_field_input_reaches_its_listeners_in_the_original_order"}
    cases = sorted(found, key=lambda c: (c != chosen.get(mid), preference(c), c))
    case = cases[0]
    block = found[case]
    names = re.findall(r"ReferenceError: (\w+) is not defined", block)
    if names:
        expect = f"ReferenceError: {names[0]} is not defined"
    elif "SYN Local Search (0)" in block:
        expect = "'chips': 'SYN Local Search (0)'"
    else:
        message = re.search(r"^AssertionError: .*?: (.+)$", block, re.M) or re.search(r"^AssertionError: (.+)$", block, re.M)
        expect = message.group(1).strip()[-160:] if message else ""
        tail = re.findall(r" : ([^\n]+)$", block, re.M)
        if tail:
            expect = tail[-1].strip()
    table.append({"id": mid, "case": case, "expect": expect, "kills": len(found), "errors": row["errors"]})
    unit = NAMES.get(mid, {"M36": "Retry에 Quick Match closure 추가 등록", "M37": "dictation 편집 알림을 citation input 뒤로"}.get(mid))
    lines.append(f"| {mid} | {unit} | {len(found)} | `{case}` | `{expect}` |")
Path(sys.argv[1]).write_text(json.dumps(table, ensure_ascii=False, indent=1), encoding="utf-8")
Path(sys.argv[2]).write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
