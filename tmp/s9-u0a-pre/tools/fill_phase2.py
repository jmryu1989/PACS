# coding: utf-8
"""One-off: fill phase2.md placeholders and bring self-check-classes.md / notes.md up to the follow-up commit."""
import json
from pathlib import Path

UNIT = Path(__file__).resolve().parents[1]


def rw(path, pairs):
    text = path.read_text(encoding="utf-8")
    for old, new in pairs:
        if new in text and old not in text:
            continue  # already filled (re-run)
        assert text.count(old) == 1, (path.name, old[:60])
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8", newline="\n")


kill = (UNIT / "kill-table.md").read_text(encoding="utf-8").strip()
a2 = json.loads((UNIT / "a2-counts.json").read_text(encoding="utf-8"))
ax = json.loads((UNIT / "a2-extra-counts.json").read_text(encoding="utf-8"))


def line(label, c, note):
    b, a = c["totals"]["before"], c["totals"]["after"]
    return (f"| {label} | {b['count']} / pass {b['passed']} / fail {b['failed']} / kill {b['killed']} | "
            f"{a['count']} / pass {a['passed']} / fail {a['failed']} / kill {a['killed']} | {c['executed_equal']} | {note} |")


a2_table = "\n".join([
    "before = merge `969581c` 별도 worktree(TypeScript 같은 junction), after = C `00bead5`의 시험 + 후속 커밋의 투영 규칙.",
    "",
    "| 묶음 | 전 (사례 / 결과) | 후 | 사례·결과 동일 | 비고 |",
    "|---|---|---|---|---|",
    line("지시 42개(9개 포함)", a2, "LiveStack 2개(`invariants_live.py`, `worklist_columns_live.py`) 미실행; 12개 fixture 소비 파일은 `a2/after-fixture`"),
    line("추가 14개(main.html 소비 격리 + A1)", ax, "`auth_session_service_test.cjs`는 전후 모두 fail 1(`/app/node_modules` 필요 — 컨테이너 전용)"),
    "",
    "파일별 표: `a2-counts.md`, `a2-extra-counts.md`; 원문 `a2/<phase>/runs/<stem>/`; 병합 근거 `a2/after-merged/results.json`.",
    "첫 after 실행(`a2/after`)에서 `report_version_citation_dom_test.py`·`_mutants.py`가 깨졌다: 그 시험은 history block을",
    "`reportWriteBlock`의 jsdoc 문자열로 잘랐는데 M06이 그 선언을 앞으로 옮겼다(설계 9개 목록 밖). 같은 fixture projection으로",
    "옮겼고(`HISTORY_BLOCK = historyEpoch..reportWriteBlock`의 f1d5406 문장 11개 = 원래 절단 11개, 단언·사례·변이 불변) 재실행 중 변이 MH5가",
    "살아남아 투영의 끝 규칙을 고쳤다(끝 선언이 옮겨 간 경우에도 run 마지막 문장 바로 뒤의 미대응 문장은 run에 속함). 고친 뒤 12개 fixture",
    "소비 파일 전부를 다시 돌린 것이 `a2/after-fixture`(모두 exit 0, MH5 포함 kill 동일).",
])

rw(UNIT / "phase2.md", [
    ("| 후속 | FOLLOWUP_SHA | phase 1의 PRE-P3 k=37 떠나기 사례 복원(이름 그대로) + 문서 |",
     "| 후속 | 이 문서를 담은 커밋(C 다음) | PRE-P3 k=37 떠나기 사례 복원, fixture projection 끝 규칙 수정, report_version_citation 2개 재지정, A2·문서 |"),
    ("| CI | CI_SHA | \"S9-U0a-PRE CI registration\": validate.yml + tests/README.md |",
     "| CI | 브랜치 마지막 커밋 | \"S9-U0a-PRE CI registration\": validate.yml + tests/README.md |"),
    ("| `runs/mutant-driver-1` `tests/main_early_input_mutants.py` | 0 | — | — | — | — | baseline 10건 통과 후 37/37 kill |",
     "| `runs/mutant-driver-1` `tests/main_early_input_mutants.py` | 0 | — | — | — | — | baseline 10건 통과 후 37/37 kill |\n"
     "| `runs/suite-final` (후속 커밋 내용) | 0 | 59 | 59 | 0 | 0 | 943.4 s, k=37 사례 복원 포함 |"),
    ("KILL_TABLE", kill + "\n\n전체 시험 × 38 실행은 C 내용(58건)으로 했다. 후속 커밋은 k=37 사례 1건을 더할 뿐 변이 표·kill 규칙을 바꾸지 않는다."),
    ("A2_TABLE", a2_table),
    ("- merge 커밋 메시지는 기본 문구(Co-Authored-By 줄 없음)로 push됐다.",
     "- merge 커밋 메시지는 기본 문구(Co-Authored-By 줄 없음)로 push됐다.\n"
     "- 설계의 9개 밖: `report_version_citation_dom_test.py`·`report_version_citation_mutants.py`도 M06 때문에 같은 projection으로 재지정(§5).\n"
     "- 파일 이름: 설계의 `tests/main_pre_order_dom_test.py` = `tests/main_early_input_dom_test.py`, `tests/main_pre_contract.cjs` =\n"
     "  `tests/main_split_harness.cjs`(+ `tests/main_split_harness.py`, 변이 드라이버 `tests/main_early_input_mutants.py`)."),
])

rw(UNIT / "self-check-classes.md", [
    ("| B4 범위 축약 | 확인 | 37개 변이 전부를 전체 시험 58건으로 각각 실행(`runs/mutant-M00..M37`).",
     "| B4 범위 축약 | 확인 | 37개 변이 전부를 전체 시험 58건으로 각각 실행(`runs/mutant-M00..M37`; 후속 k=37 복원 뒤 전체 59건 `runs/suite-final`)."),
    ("9개 legacy의 다른 marker 절단·함수 추출은 원본=PRE 동일(`tools/check_other_slices.py`).",
     "9개 legacy의 다른 marker 절단·함수 추출은 원본=PRE 동일(`tools/check_other_slices.py`). 이 조사가 놓친 "
     "`report_version_citation` 2개(끝 marker = 옮겨 간 reportWriteBlock jsdoc)는 A2 after가 잡았고 같은 projection으로 재지정."),
    ("tests/(지시된 9개 + 내 시험/하니스/드라이버/fixture/spec)",
     "tests/(지시된 9개 + report_version_citation 2개 + 내 시험/하니스/드라이버/fixture/spec)"),
])

notes = UNIT / "notes.md"
text = notes.read_text(encoding="utf-8")
if "## phase 2 (요약은" not in text:
    text = text.rstrip("\n") + "\n\n## phase 2 (요약은 `phase2.md`)\n\n" \
        "- 설계 이름 대응: `main_pre_order_dom_test.py` → `tests/main_early_input_dom_test.py`; `main_pre_contract.cjs` → " \
        "`tests/main_split_harness.cjs`(split·deriveSpec·fixtureBlocks·preMutant) + `tests/main_split_harness.py`; 변이 실행 → " \
        "`tests/main_early_input_mutants.py`; f1d5406 문장 목록 → `tests/main_split_harness_fixture.json`.\n" \
        "- 제품 바이트는 `node tmp/s9-u0a-pre/tools/apply_moves.cjs worklist-v0/hpacs-lite/main.html`(f1d5406 blob 입력)의 출력과 같다.\n" \
        "- 변이: `apply_moves.cjs --except Mxx | --m36 | --m37`(전체 시험 × 38), `preMutant`(드라이버, 같은 문장 결과 `tools/check_mutant_equivalence.cjs`).\n"
    notes.write_text(text, encoding="utf-8", newline="\n")
print("filled")
