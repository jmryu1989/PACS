# A2 before-extra → after-extra

before HEAD `969581c9eed3dacd9e96e94e5db1b149efb5e7cb`, after HEAD `00bead586153fbae668c18f1d5387a6a2a13e4b0`. 원문은 `a2/<phase>/runs/<stem>/`.

| 파일 | 전 | 후 | 같은 사례·결과 |
|---|---|---|---|
| `tests/auth_entry_dom_test.py` | 43건: pass 43, fail 0, error 0, skip 0 | 43건: pass 43, fail 0, error 0, skip 0 | 동일 |
| `tests/auth_session_service_test.cjs` | 1건: pass 0, fail 1, error 0, skip 0 | 1건: pass 0, fail 1, error 0, skip 0 | 동일 |
| `tests/dictation_host_test.cjs` | 27건: pass 27, fail 0, error 0, skip 0 | 27건: pass 27, fail 0, error 0, skip 0 | 동일 |
| `tests/multi_institution_worklist_dom_test.py` | 22건: pass 22, fail 0, error 0, skip 0 | 22건: pass 22, fail 0, error 0, skip 0 | 동일 |
| `tests/order_reconciliation_dom_test.py` | 6건: pass 6, fail 0, error 0, skip 0 | 6건: pass 6, fail 0, error 0, skip 0 | 동일 |
| `tests/related_layout_dom_test.py` | 17건: pass 17, fail 0, error 0, skip 0 | 17건: pass 17, fail 0, error 0, skip 0 | 동일 |
| `tests/report_session_page_dom_test.py` | 16건: pass 16, fail 0, error 0, skip 0 | 16건: pass 16, fail 0, error 0, skip 0 | 동일 |
| `tests/report_structure_client_test.cjs` | 24건: pass 24, fail 0, error 0, skip 0 | 24건: pass 24, fail 0, error 0, skip 0 | 동일 |
| `tests/report_text_boundaries_dom_test.py` | 83건: pass 83, fail 0, error 0, skip 0 | 83건: pass 83, fail 0, error 0, skip 0 | 동일 |
| `tests/session_modules_dom_test.py` | 16건: pass 16, fail 0, error 0, skip 0 | 16건: pass 16, fail 0, error 0, skip 0 | 동일 |
| `tests/session_work_gate_test.cjs` | 51건: pass 51, fail 0, error 0, skip 0 | 51건: pass 51, fail 0, error 0, skip 0 | 동일 |
| `tests/worklist_narrow_layout_dom_test.py` | 1건: pass 1, fail 0, error 0, skip 0 | 1건: pass 1, fail 0, error 0, skip 0 | 동일 |
| `tests/worklist_search_owner_dom_test.py` | 10건: pass 10, fail 0, error 0, skip 0 | 10건: pass 10, fail 0, error 0, skip 0 | 동일 |
| `tests/main_move_test.cjs` | 5건: pass 5, fail 0, error 0, skip 0 | 5건: pass 5, fail 0, error 0, skip 0 | 동일 |

합계(변이 kill 별도): `{"before": {"count": 322, "passed": 321, "failed": 1, "errors": 0, "skipped": 0, "killed": 0}, "after": {"count": 322, "passed": 321, "failed": 1, "errors": 0, "skipped": 0, "killed": 0}}`

실행분 전후 동등: True; 실행분 전후 모두 통과: False.

실패/미실행(사례 ID):
```json
{
  "failed": {
    "before": {
      "tests/auth_session_service_test.cjs": [
        "tests\\\\auth_session_service_test.cjs"
      ]
    },
    "after": {
      "tests/auth_session_service_test.cjs": [
        "tests\\\\auth_session_service_test.cjs"
      ]
    }
  },
  "unrun": []
}
```
