# coding: utf-8
"""A2 before/after counts from the actual unittest/TAP/mutant outputs (RELIST a2_counts.py, adapted to this unit's
runner); a missing outcome is never success. Usage: a2_counts.py <before-phase> <after-phase> <targets.json> <out-stem>"""
import json
import re
import sys
from pathlib import Path

UNIT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
before_phase, after_phase, targets_file, stem = sys.argv[1:5]
targets = [t["path"] for t in json.loads(Path(targets_file).read_text(encoding="utf-8"))["targets"]]


def read(phase):
    record = json.loads((UNIT / "a2" / phase / "results.json").read_text(encoding="utf-8"))
    runs = {r["file"]: r for r in record["results"]}
    assert set(runs) == set(targets), (phase, "incomplete run list", sorted(set(targets) - set(runs)))
    result = {}
    for name, r in runs.items():
        if r["exit"] is None:
            result[name] = {"status": "미실행: LiveStack 금지", "exit": None}
            continue
        run = Path(r["run"])
        out = (run / "stdout.log").read_text(encoding="utf-8", errors="replace")
        err = (run / "stderr.log").read_text(encoding="utf-8", errors="replace")
        meta = json.loads((run / "run.json").read_text(encoding="utf-8"))
        assert meta["exit_code"] == r["exit"] and meta["git_head_before"] == record["head"], (phase, name)
        if name.endswith(".cjs"):
            v = {k: int(n) for k, n in re.findall(r"^# (tests|pass|fail|skipped|cancelled) (\d+)$", out, re.M)}
            assert "tests" in v, (phase, name, "missing TAP summary")
            value = {"kind": "TAP", "count": v["tests"], "passed": v["pass"], "failed": v["fail"], "errors": 0,
                     "skipped": v["skipped"], "cancelled": v["cancelled"],
                     "cases": re.findall(r"^# Subtest: (.*)$", out, re.M), "failures": re.findall(r"^not ok \d+ - (.*)$", out, re.M)}
        elif "mutants" in name:
            summary = UNIT / "a2" / phase / f"{Path(name).stem}.json"
            data = json.loads(summary.read_text(encoding="utf-8"))
            rows = data["results"]
            baseline = next(x for x in rows if x["id"] == "BASELINE")
            value = {"kind": "mutants", "count": 0, "baseline": baseline["child_exit"], "baseline_tests": baseline.get("tests_ran"),
                     "killed": sum(bool(x.get("killed")) for x in rows), "mutants": len(rows) - 1,
                     "cases": [(x["id"], x.get("case")) for x in rows], "failures": [x["id"] for x in rows if x.get("killed") is False],
                     "outcomes": [{k: x.get(k) for k in ("id", "case", "child_exit", "named_failure", "expect_matched",
                                                         "harness_crash", "killed")} for x in rows]}
        else:
            ran = re.findall(r"^Ran (\d+) tests? in ", err, re.M)
            assert len(ran) == 1, (phase, name, "missing unittest summary", err[-400:])
            count = int(ran[0])
            verdict = re.search(r"^(?:FAILED|OK)\s*(?:\(([^)]+)\))?$", err, re.M)
            assert verdict, (phase, name, "missing unittest verdict")
            f = {k: int(v) for k, v in re.findall(r"(failures|errors|skipped)=(\d+)", verdict[1] or "")}
            failures = re.findall(r"^(?:FAIL|ERROR): (.*)$", err, re.M)
            setup = sum(x.startswith("setUpClass") for x in failures)
            value = {"kind": "unittest", "count": count,
                     "passed": count - f.get("failures", 0) - f.get("errors", 0) + setup - f.get("skipped", 0),
                     "failed": f.get("failures", 0), "errors": f.get("errors", 0), "skipped": f.get("skipped", 0),
                     "cases": re.findall(r"^(test_\w+ \([^)]+\))", err, re.M), "failures": failures}
        value.update(exit=r["exit"], status="통과" if r["exit"] == 0 else "실패")
        result[name] = value
    return record["head"], result


bhead, before = read(before_phase)
ahead, after = read(after_phase)


def cell(r):
    if "count" not in r:
        return r["status"]
    if r["kind"] == "mutants":
        return f'baseline exit={r["baseline"]} ({r.get("baseline_tests", "?")}건); kill {r["killed"]}/{r["mutants"]}'
    return f'{r["count"]}건: pass {r["passed"]}, fail {r["failed"]}, error {r["errors"]}, skip {r["skipped"]}'


lines = [f"# A2 {before_phase} → {after_phase}", "", f"before HEAD `{bhead}`, after HEAD `{ahead}`. 원문은 `a2/<phase>/runs/<stem>/`.", "",
         "| 파일 | 전 | 후 | 같은 사례·결과 |", "|---|---|---|---|"]
equal, unrun = [], []
for name in targets:
    a, b = before[name], after[name]
    keys = (set(a) | set(b)) - {"run"}
    same = all(a.get(k) == b.get(k) for k in keys)
    if a["exit"] is None or b["exit"] is None:
        unrun.append(name)
        verdict = "미실행 — 동등성 미검증"
    else:
        equal.append(same)
        verdict = "동일" if same else "불일치"
    lines.append(f"| `{name}` | {cell(a)} | {cell(b)} | {verdict} |")
totals = {phase: {k: sum(r.get(k, 0) for r in data.values()) for k in ("count", "passed", "failed", "errors", "skipped", "killed")}
          for phase, data in (("before", before), ("after", after))}
failed = {phase: {n: r["failures"] for n, r in data.items() if r["exit"] not in (None, 0)} for phase, data in (("before", before), ("after", after))}
summary = {"before_head": bhead, "after_head": ahead, "totals": totals, "executed_equal": all(equal),
           "all_executed_pass": not any(failed.values()), "unrun": unrun, "failed": failed}
lines += ["", "합계(변이 kill 별도): `" + json.dumps(totals, ensure_ascii=False) + "`", "",
          f"실행분 전후 동등: {summary['executed_equal']}; 실행분 전후 모두 통과: {summary['all_executed_pass']}.", "",
          "실패/미실행(사례 ID):", "```json", json.dumps({"failed": failed, "unrun": unrun}, ensure_ascii=False, indent=2), "```"]
(UNIT / f"{stem}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
(UNIT / f"{stem}.json").write_text(json.dumps({**summary, "before": before, "after": after}, ensure_ascii=False, indent=1) + "\n",
                                   encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False))
