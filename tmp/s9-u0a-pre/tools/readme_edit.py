# coding: utf-8
"""One-off README edit for the S9-U0a-PRE CI registration: one catalog entry and the four run-dir rows."""
from pathlib import Path

path = Path(__file__).resolve().parents[3] / "tests" / "README.md"
raw = path.read_bytes().decode("utf-8")
NL = "\r\n" if "\r\n" in raw else "\n"
text = raw.replace("\r\n", "\n")


def once(old, new):
    global text
    assert text.count(old) == 1, (text.count(old), old[:80])
    text = text.replace(old, new)


once("## 기능별 시험 카탈로그\n\n",
     "## 기능별 시험 카탈로그\n\n"
     "REQ-S9-U0a-PRE-ORDER → RISK-B1-03/05/15/41/42/45/57/58·PRE-X1~X3·PRE-P3(classic script를 18/30/45개로 나눈 페이지의 틈에서 "
     "입력·떠나기·창/세션 사건이 아직 없는 선언을 만남) → TEST-S9-U0a-PRE: `tests/main_early_input_dom_test.py`(설계 이름 "
     "`main_pre_order_dom_test.py`, 하니스 `main_split_harness.py`/`.cjs` = `main_pre_contract.cjs`)가 임시 분할 페이지(0/150 ms, "
     "경계 hold)의 결과를 f1d5406 원본 페이지의 한 시점과 비교하고, 세션 답 대기·답함·실패·실패→Retry마다 (target, event)별 등록이 "
     "원본과 같음을 본다. `tests/main_early_input_mutants.py`는 35개 이동을 하나씩 되돌린 변이와 M36(Retry가 Quick Match 등록 추가)·"
     "M37(받아쓰기 편집 알림을 citation input 뒤로)을 각자의 사례로 죽인다. `node --test tests/main_move_test.cjs`(A1)는 "
     "`tests/main_move_spec.json`(base = 이동 커밋)을, `node tests/main_split_harness.cjs fixture-check`는 report 하니스 시험이 "
     "읽는 f1d5406 문장 목록(`tests/main_split_harness_fixture.json`)을 결속한다. 실스택·네트워크·자격증명 없음.\n\n")

row = "| `measurements` | `tmp/workspace-ui-ci/worklist-toolbar` |"
once(row,
     "| `measurements` | `tmp/workspace-ui-ci/main-move` | `synthetic-workspace-dom-results` | S9-U0a A1 byte move map, loss, duplication and order mutants |\n"
     "| `measurements` | `tmp/workspace-ui-ci/pre-fixture-reference` | `synthetic-workspace-dom-results` | S9-U0a-PRE report harness fixture statements equal the f1d5406 page |\n"
     "| `measurements` | `tmp/workspace-ui-ci/pre-early-input-dom` | `synthetic-workspace-dom-results` | S9-U0a-PRE early input, pagehide and registration order on 18/30/45-part pages against the f1d5406 page |\n"
     "| `measurements` | `tmp/workspace-ui-ci/pre-mutants` | `synthetic-workspace-dom-results` | S9-U0a-PRE 37 mutants killed by their own cases |\n"
     + row)

path.write_bytes(text.replace("\n", NL).encode("utf-8"))
print("README edited")
