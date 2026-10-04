#!/usr/bin/env python3
"""필수 시험 목록을 기존 record-run / candidate-ci 원문 결과와 대조한다."""
import argparse
import json
from pathlib import Path
import re
import sys


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def python_results(log, module=None):
    """unittest verbosity=2의 사례 결과와 실행기의 선택 목록만 읽는다."""
    outcomes, selected, pending = {}, [], None
    for line in log.splitlines():
        if line.startswith("EXACT_TESTS "):
            selected.extend(json.loads(line[len("EXACT_TESTS "):]))
        match = re.match(r"^(test\w+) \(([\w.]+)\)(.*)$", line)
        if match:
            method, owner, line = match.groups()
            pending = owner if owner.endswith("." + method) else owner + "." + method
            if module and pending.startswith("__main__."):
                pending = module + pending[len("__main__"):]
            outcomes[pending] = "중단: 사례의 종료 결과 없음"
        if pending:
            result = re.search(r"(?:^|\.\.\. )(ok|FAIL|ERROR|skipped .+|expected failure|unexpected success)$", line)
            if result:
                status = result[1]
                outcomes[pending] = ("PASS" if status == "ok" else
                                     "건너뜀: " + status if status.startswith("skipped") else
                                     "실패: " + status)
                pending = None
    for test in selected:
        outcomes.setdefault(test, "누락: 선택됐으나 사례 결과 없음")
    return outcomes


def run_problem(before, after, sha, status, code, log):
    if before != sha or after not in (None, sha):
        return "다른 SHA: " + str(before) + " / " + str(after)
    if status != "completed" or code is None:
        return "중단: 실행이 완료되지 않음"
    if code == 124 or "CI command deadline" in log:
        return "시간 초과: 실행 제한 시간 도달"
    if code != 0:
        if not re.search(r"^Ran \d+ tests? in |^# tests \d+", log, re.M):
            return "중단: 자식 종료 exit=" + str(code)
        return "실패: 실행 exit=" + str(code)
    if after != sha:
        return "SHA 누락: 실행 후 commit 확인 없음"
    return None


def add_python(found, log, source, problem, module=None):
    outcomes = python_results(log, module)
    complete = re.search(r"^Ran [1-9]\d* tests? in ", log, re.M)
    okay = re.search(r"^OK\s*$", log, re.M)
    for test, reason in outcomes.items():
        # 건너뜀은 runner의 전체 실패 exit보다 구체적인 이유다.
        if problem and not (reason.startswith("건너뜀") and not problem.startswith("다른 SHA")):
            reason = problem
        elif reason == "PASS" and not (complete and okay):
            reason = "미완료: unittest 전체 성공 요약 없음"
        found.setdefault(test, []).append({"reason": reason, "source": str(source)})


def record_results(path, sha, found):
    record = read_json(path)
    log = "\n".join((path.parent / record[key]).read_text(encoding="utf-8", errors="replace")
                    for key in ("stdout", "stderr"))
    problem = run_problem(record["git_head_before"], record["git_head_after"], sha,
                          record["status"], record["exit_code"], log)
    if not problem and record["recorder_exit_code"] != 0:
        problem = "미완료: 실행 기록기 exit=" + str(record["recorder_exit_code"])
    command = record["command"]
    files = [arg.replace("\\", "/") for arg in command if arg.endswith((".py", ".cjs"))]
    module = Path(files[-1]).stem if files else None
    add_python(found, log, path, problem, module)
    # validate.yml의 기존 node --test 파일 명령은 TAP 전체 결과로 대조한다.
    # 필터가 붙은 부분 실행을 전체 파일의 결과로 세지 않는다.
    if "--test" in command:
        tail = command[command.index("--test") + 1:]
        if len(tail) == 1 and tail[0].endswith(".cjs"):
            test = "node:tests/" + Path(tail[0]).name
            counts = {name: int(value) for name, value in
                      re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$", log, re.M)}
            reason = problem
            if not reason and any(arg.startswith(("--test-name-pattern", "--test-skip-pattern",
                                                  "--test-only", "--test-shard")) for arg in command):
                reason = "부분 실행: 필터 없는 파일 전체 결과 필요"
            if not reason or reason.startswith("실패: 실행 exit="):
                if counts.get("skipped", 0) or counts.get("todo", 0):
                    reason = "건너뜀: TAP skipped/todo"
                elif counts.get("cancelled", 0):
                    reason = "중단: TAP cancelled"
                elif reason:
                    pass
                elif (counts.get("tests", 0) > 0 and counts.get("pass") == counts["tests"]
                      and counts.get("fail") == 0 and "1.." in log):
                    reason = "PASS"
                else:
                    reason = "미완료: TAP 전체 성공 요약 없음"
            found.setdefault(test, []).append({"reason": reason, "source": str(path)})


def candidate_results(directory, sha, found):
    """candidate.yml가 게시한 기존 세 파일 종류만 사용한다."""
    provenance = read_json(directory / "candidate-provenance.json")
    results = read_json(directory / "results.json")
    cases = {}
    problems = []
    for row in results:
        if row["exit"] != 0:
            problems.append(row["name"] + ": exit=" + str(row["exit"]))
        log_path = directory / (row["name"] + ".log")
        log = log_path.read_text(encoding="utf-8", errors="replace")
        if "EXACT_TESTS " in log:
            problem = run_problem(provenance["candidate_sha"], provenance["candidate_sha"],
                                  sha, "completed", row["exit"], log)
            if not re.search(r'^PLAN_RESULT .*"status": "passed"', log, re.M) and not problem:
                problem = "미완료: 실행기 PLAN_RESULT 성공 없음"
            add_python(cases, log, log_path, problem)
    required = [Path(row["file"]).stem + "." + row["case"] for row in provenance["sequence"]]
    for test in required:
        reasons = [row["reason"] for row in cases.get(test, [])]
        if not reasons or any(reason != "PASS" for reason in reasons):
            problems.append(test + ": " + (", ".join(reasons) or "누락"))
    if provenance["candidate_sha"] != sha:
        problems.insert(0, "다른 SHA: " + provenance["candidate_sha"])
    if not required or not any(row["name"] == "cleanup" and row["exit"] == 0 for row in results):
        problems.append("미완료: 후보 선택 또는 정리 결과 없음")
    found.setdefault("candidate-ci", []).append({"reason": "; ".join(problems) or "PASS",
                                                "source": str(directory)})


def evaluate(requirements, sha, found, errors):
    rows = []
    for requirement in requirements:
        details, failures = {}, []
        tests = requirement["tests"]
        if not tests or requirement.get("pending"):
            failures.append(requirement.get("pending", "필수 시험 목록 미정"))
        for test in tests:
            entries = found.get(test, [])
            details[test] = entries
            reasons = sorted({entry["reason"] for entry in entries if entry["reason"] != "PASS"})
            if not entries:
                reasons = ["누락: 결과에 시험 없음"]
            if reasons:
                failures.append(test + ": " + "; ".join(reasons))
        rows.append({"id": requirement["id"], "statement": requirement["statement"],
                     "verdict": "FAIL" if failures else "PASS", "reasons": failures, "tests": details})
    return {"commit": sha, "all_pass": bool(rows) and not errors and
            all(row["verdict"] == "PASS" for row in rows), "input_errors": errors, "requirements": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", type=Path, required=True)
    parser.add_argument("--sha", required=True, help="실행한 최종 commit의 40자리 SHA")
    parser.add_argument("--runs", type=Path, action="append", default=[], help="record-run 결과 폴더; 반복 가능")
    parser.add_argument("--candidate", type=Path, help="압축 해제한 candidate-ci artifact 폴더")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("--sha는 40자리 commit SHA여야 합니다")
    found, errors = {}, []
    try:
        requirements = read_json(args.list)["requirements"]
        if not requirements or len({row["id"] for row in requirements}) != len(requirements):
            raise ValueError("요구사항 목록이 비었거나 ID가 중복됨")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    paths = set()
    for directory in args.runs:
        records = list(directory.rglob("run.json"))
        if not records:
            errors.append(str(directory) + ": run.json 없음")
        paths.update(records)
    for path in sorted(paths):
        try:
            record_results(path, args.sha, found)
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(str(path) + ": " + str(error))
    if args.candidate:
        try:
            candidate_results(args.candidate, args.sha, found)
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(str(args.candidate) + ": " + str(error))
    report = evaluate(requirements, args.sha, found, errors)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("요구사항 | 판정 | 이유")
    for row in report["requirements"]:
        reason = row["reasons"][0] if row["reasons"] else row["statement"]
        if len(row["reasons"]) > 1:
            reason += " (외 " + str(len(row["reasons"]) - 1) + "건; JSON 참조)"
        print(row["id"] + " | " + row["verdict"] + " | " + reason)
    for error in errors:
        print("입력 오류: " + error)
    return 0 if report["all_pass"] else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
