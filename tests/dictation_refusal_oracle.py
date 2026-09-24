"""S3-ASR-U5: pure oracle for the dictation route's live refusal battery.

REQ-S3-ASR-U5-* -> RISK-U5-* -> TEST-S3-ASR-U5-LIVE / TEST-S3-ASR-U5-ORACLE (tests/README.md).
The live half is eight tests in tests/invariants_live.py (T1-T8: 26 cases on 8 fixtures). What they are
judged by lives here -- the case table, source-pinned expected bodies, the audit expectation, pairing and
problem tags -- so tests/dictation_refusal_oracle_test.py can prove the judge with vectors and tagged
mutants anywhere. Stdlib only, and never imports invariants_live.py: that module loads .env at import.

A 503 DICTATION_NOT_CONFIGURED is only an admission witness (a control; the CI stack sets no KIN_ASR_*).
A refusal counts by its own exact status and body, zero AuditLog rows for the uid, Report*/StudyState
rows equal immediately around the call, and a same-test control that passed -- never by a status < 500.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
import struct
from collections import Counter
from dataclasses import dataclass
from typing import Any

MAX_BYTES = 1_048_576          # api/src/dictation-audio.ts DICTATION_AUDIO_MAX_BYTES
SAMPLE_RATE = 16_000
WAV_SHA256 = "156075e2635b9b2c186258f4db987ed9fbdfb727f49e5eac4b9a126aefbdf727"
WAV_44100_SHA256 = "48f304b4730189540fb9a2b9c8d05d6aba5e55b1375efbd9e2ef28ed544a9743"
AUDIT_ACTION = "dictation.request"
AUDIT_KEYS = frozenset({"bytes", "seconds", "ms", "engine", "outcome"})
NOT_CONFIGURED = "DICTATION_NOT_CONFIGURED"
INVALID = "DICTATION_AUDIO_INVALID"
TOO_LARGE = "DICTATION_AUDIO_TOO_LARGE"
KINDS = ("refusal", "input", "control")

TAGS = (
    "status", "body", "cache-control", "secret",
    "audit-delta", "audit-action", "audit-actor", "audit-keys", "audit-bytes", "audit-seconds",
    "audit-ms", "audit-outcome", "audit-engine",
    "report-rows", "study-state", "probe-rows",
    "unpaired", "precondition", "missing-case", "duplicate-case", "unknown-case",
)
WIRING_TAGS = (
    "wiring-import", "wiring-names", "wiring-keys", "wiring-cases", "wiring-A1", "wiring-A3",
    "wiring-A4", "wiring-A5", "wiring-probe", "wiring-summary",
)
LINE_KEYS = frozenset({
    "test", "id", "kind", "status", "code", "no_store", "secret_in_body", "audit_delta",
    "audit_actions", "report_rows_equal", "state_equal", "problems",
})

# Exact messages at the pin; tests/dictation_refusal_oracle_test.py binds each to its api/src line.
ROLE = "판독문 저장은(는) radiologist 권한이 필요합니다"
NO_CREDENTIAL = "인증 정보가 없습니다"
GATEWAY_PATH = "게이트웨이에 허용되지 않는 경로입니다"
FILMING = "촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다"
NOT_FOUND = "검사를 찾을 수 없습니다"
CSRF = "X-KIN-CSRF 헤더가 필요합니다"
NO_SESSION = "인증 세션이 없습니다"


def _nest(status: int, error: str, message: str) -> dict[str, Any]:
    # Nest 10's body for a string HttpException; a string refusal keeps this shape on this route too.
    return {"message": message, "error": error, "statusCode": status}


def _coded(code: str) -> dict[str, str]:
    return {"code": code, "message": code}   # asr.service.ts dictationError


FIXED_BODIES = {
    "role": _nest(403, "Forbidden", ROLE),
    "no-credential": _nest(401, "Unauthorized", NO_CREDENTIAL),
    # A3: only reachable after validGateway passed; an invalid identity answers {code: GATEWAY_IDENTITY_INVALID}.
    "gateway-path": _nest(403, "Forbidden", GATEWAY_PATH),
    "filming": _nest(409, "Conflict", FILMING),
    "not-found": _nest(404, "Not Found", NOT_FOUND),
    "csrf": _nest(403, "Forbidden", CSRF),
    # A2: authenticateSession's unknown sid (auth.service.ts:252-256), not the expired-session message.
    "no-session": _nest(401, "Unauthorized", NO_SESSION),
    "invalid": _coded(INVALID),
    "too-large": _coded(TOO_LARGE),
    "not-configured": _coded(NOT_CONFIGURED),
}


@dataclass(frozen=True)
class Case:
    id: str
    test: str
    kind: str                                   # refusal | input | control
    caller: str | None                          # logical user owning the one audit row (input/control)
    status: int
    body: str                                   # FIXED_BODIES key, or "held"/"prelim" (context-bound)
    audit: tuple[int, float, str] | None        # (bytes, seconds, outcome) of the one row; None = no row
    pair: str | None = None                     # same-test control this refusal/input is credited against
    probe: bool = False                         # a uid that never had a StudyState row


CONTROL = (46, 1 / SAMPLE_RATE, NOT_CONFIGURED)
CASES = (
    # T1: the guard and the shared report gate answer before the parser's deferred input errors.
    Case("C-W", "T1", "control", "doctor", 503, "not-configured", CONTROL),
    Case("R-ROLE", "T1", "refusal", "tech", 403, "role", None, "C-W"),
    Case("R-ROLE-CT", "T1", "refusal", "tech", 403, "role", None, "C-W"),        # not 400
    Case("R-ROLE-BIG", "T1", "refusal", "tech", 403, "role", None, "C-W"),       # not 413
    Case("R-UNAUTH", "T1", "refusal", None, 401, "no-credential", None, "C-W"),  # not 400
    Case("R-GATEWAY", "T1", "refusal", "gateway", 403, "gateway-path", None, "C-W"),
    # T2: input refusals after the gate are exact, audited once and write nothing else.
    Case("I-CT", "T2", "input", "doctor", 400, "invalid", (0, 0, INVALID), "C-W2"),
    Case("I-ENC", "T2", "input", "doctor", 400, "invalid", (0, 0, INVALID), "C-W2"),
    Case("I-FMT", "T2", "input", "doctor", 400, "invalid", (46, 0, INVALID), "C-W2"),
    Case("I-BIG", "T2", "input", "doctor", 413, "too-large", (0, 0, TOO_LARGE), "C-W2"),
    Case("C-W2", "T2", "control", "doctor", 503, "not-configured", CONTROL),
    # T3: another actor's live hold refuses; the holder and an expired hold are admitted; nobody touches it.
    Case("R-HELD", "T3", "refusal", "doctor2", 409, "held", None, "C-EXPIRED"),
    Case("C-HOLDER", "T3", "control", "doctor", 503, "not-configured", CONTROL),
    Case("C-EXPIRED", "T3", "control", "doctor2", 503, "not-configured", CONTROL),
    # T4: RS=P admits only its author and designated reviewer.
    Case("R-PRELIM", "T4", "refusal", "doctor2", 403, "prelim", None, "C-P-AUTHOR"),
    Case("C-P-AUTHOR", "T4", "control", "doctor", 503, "not-configured", CONTROL),
    Case("C-P-REVIEWER", "T4", "control", "jmryu", 503, "not-configured", CONTROL),
    # T5: filming (Unverified) refuses unless emergency.
    Case("R-UNVERIFIED", "T5", "refusal", "doctor", 409, "filming", None, "C-EMERGENCY"),
    Case("C-EMERGENCY", "T5", "control", "doctor", 503, "not-configured", CONTROL),
    # T6: the institution boundary follows tele visibility; no StudyState row is not a study.
    Case("R-TENANT", "T6", "refusal", "kdoctor", 404, "not-found", None, "C-TELE"),
    Case("C-TELE", "T6", "control", "kdoctor", 503, "not-configured", CONTROL),
    Case("R-NOSTATE", "T6", "refusal", "doctor", 404, "not-found", None, "C-TELE", probe=True),
    # T7: a cookie call needs the CSRF header and a real session.
    Case("R-CSRF", "T7", "refusal", "doctor", 403, "csrf", None, "C-SESSION"),
    Case("R-FORGED", "T7", "refusal", None, 401, "no-session", None, "C-SESSION"),
    Case("C-SESSION", "T7", "control", "doctor", 503, "not-configured", CONTROL),
    # T8: approved (RS=A) admits a draft today, so it admits dictation (parity, not a new rule).
    Case("C-A", "T8", "control", "doctor2", 503, "not-configured", CONTROL),
)
CASE_BY_ID = {case.id: case for case in CASES}
TESTS = {
    "T1": ("LiveInvariantTests", "test_dictation_u5_01_role_guard_and_parser_order"),
    "T2": ("LiveInvariantTests", "test_dictation_u5_02_input_refusals_after_the_gate"),
    "T3": ("LiveInvariantTests", "test_dictation_u5_03_hold_refuses_other_actor_and_is_untouched"),
    "T4": ("LiveInvariantTests", "test_dictation_u5_04_preliminary_third_party_refused"),
    "T5": ("LiveInvariantTests", "test_dictation_u5_05_filming_non_emergency_refused"),
    "T6": ("LiveInvariantTests", "test_dictation_u5_06_institution_follows_tele_visibility"),
    "T7": ("BffInvariantTests", "test_dictation_u5_07_cookie_session_csrf"),
    "T8": ("LiveInvariantTests", "test_dictation_u5_08_approved_report_parity"),
}


def case_ids(test: str) -> list[str]:
    return [case.id for case in CASES if case.test == test]


def wav(rate: int = SAMPLE_RATE) -> bytes:
    """The 46-byte canonical fixture of invariants_live.call_report_route (one PCM16 zero sample).
    rate=44100 changes only the two rate fields, so the validator refuses it after the gate."""
    return (b"RIFF" + struct.pack("<I", 38) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) +
            b"data" + struct.pack("<Ih", 2, 0))


def oversized(max_bytes: int = MAX_BYTES) -> bytes:
    return bytes(max_bytes + 1)   # one over the route cap, far under nginx's 2 MB (A9 stays out)


PIN_RE = re.compile(r"^export const ASR_ENGINE_PIN = '([^'\r\n]+)';\r?$", re.M)


def source_engine_pin(text: str) -> str | None:
    found = PIN_RE.findall(text)
    return found[0] if len(found) == 1 else None


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _number(value: Any, kinds: tuple[type, ...] = (int, float)) -> bool:
    return type(value) in kinds   # bool is not a number here


def _ordered(problems: set[str], order: tuple[str, ...] = TAGS) -> list[str]:
    return [tag for tag in order if tag in problems]


def expected_body(case: Case, context: dict[str, Any]) -> dict[str, Any] | None:
    if case.body == "held":
        holder = context.get("holder")
        return ({"code": "REPORT_HELD", "holder": holder, "message": f"{holder} 님이 판독 중입니다"}
                if _text(holder) else None)
    if case.body == "prelim":
        reviewer = context.get("pre_reviewer")
        return (_nest(403, "Forbidden", f"예비 판독(RS: P) 중입니다. {reviewer}만 이어서 판독할 수 있습니다.")
                if _text(reviewer) else None)
    return FIXED_BODIES.get(case.body)


def _same(before: dict[str, Any], after: dict[str, Any], keys: tuple[str, ...]) -> bool:
    return all(key in before and key in after and before[key] == after[key] for key in keys)


def _audit_row_problems(case: Case, row: Any, context: dict[str, Any]) -> set[str]:
    detail_tags = {"audit-keys", "audit-bytes", "audit-seconds", "audit-ms", "audit-engine", "audit-outcome"}
    if not isinstance(row, dict):
        return {"audit-action", "audit-actor"} | detail_tags
    problems = set()
    if row.get("action") != AUDIT_ACTION:
        problems.add("audit-action")
    actor = (context.get("actors") or {}).get(case.caller)
    if not _text(actor) or row.get("actor") != actor:
        problems.add("audit-actor")
    try:
        detail = json.loads(row.get("detail"))
    except (TypeError, ValueError):
        detail = None
    if not isinstance(detail, dict):
        return problems | detail_tags
    expected_bytes, expected_seconds, expected_outcome = case.audit
    if set(detail) != AUDIT_KEYS:       # exactly metadata: no transcript, no audio, nothing added
        problems.add("audit-keys")
    if not _number(detail.get("bytes"), (int,)) or detail.get("bytes") != expected_bytes:
        problems.add("audit-bytes")
    if not _number(detail.get("seconds")) or detail.get("seconds") != expected_seconds:
        problems.add("audit-seconds")
    if type(detail.get("ms")) is not int or detail["ms"] < 0:
        problems.add("audit-ms")
    engine = context.get("engine_pin")
    if not _text(engine) or detail.get("engine") != engine:
        problems.add("audit-engine")
    if detail.get("outcome") != expected_outcome:
        problems.add("audit-outcome")
    return problems


def case_problems(case_id: str, observed: dict[str, Any], context: dict[str, Any]) -> list[str]:
    """Tags for one recorded call, before pairing. observed = {status, body, text, cache_control,
    before, after}; before/after are the two composite snapshots taken immediately around the call."""
    case = CASE_BY_ID.get(case_id)
    if case is None:
        return ["unknown-case"]
    problems: set[str] = set()
    if observed.get("status") != case.status:
        problems.add("status")
    expected = expected_body(case, context)
    if expected is None or observed.get("body") != expected:
        problems.add("body")
    if observed.get("cache_control") != "no-store":
        problems.add("cache-control")
    before = observed.get("before") if isinstance(observed.get("before"), dict) else {}
    after = observed.get("after") if isinstance(observed.get("after"), dict) else {}
    rows = after.get("audit") if isinstance(after.get("audit"), list) else None
    secret = context.get("secret")
    if _text(secret):
        seen = str(observed.get("text", "")) + json.dumps(observed.get("body"), ensure_ascii=False)
        if secret in seen or secret in json.dumps(rows, ensure_ascii=False):
            problems.add("secret")
    if rows is None:
        problems.add("audit-delta")
    elif case.audit is None:
        if rows:                        # any action at all: a refusal audits nothing
            problems.add("audit-delta")
    elif len(rows) != 1:
        problems.add("audit-delta")
    else:
        problems |= _audit_row_problems(case, rows[0], context)
    if not _same(before, after, ("report", "drafts", "versions")):
        problems.add("report-rows")
    if not _same(before, after, ("state",)):
        problems.add("study-state")
    if case.probe:
        if not (before.get("state") is None and after.get("state") is None
                and before.get("audit_total") == 0 and after.get("audit_total") == 0
                and after.get("report") is None and after.get("drafts") == [] and after.get("versions") == []):
            problems.add("probe-rows")
    elif before.get("state") is None:
        problems.add("study-state")     # a missing fixture row is a setup failure, never a refusal
    return _ordered(problems)


SAFE_ID = re.compile(r"[A-Z0-9-]{1,32}")
SAFE_CODE = re.compile(r"[A-Z][A-Z_]{0,63}")
SAFE_ACTION = re.compile(r"[a-z][a-z.-]{0,63}")


def _line(test: str, case_id: Any, observed: dict[str, Any] | None, problems: list[str],
          context: dict[str, Any]) -> dict[str, Any]:
    """The printable U5-CASE record: ids, status, a code, booleans and counts. Never a body, token,
    secret or audio byte."""
    case = CASE_BY_ID.get(case_id) if isinstance(case_id, str) else None
    safe_id = case_id if isinstance(case_id, str) and SAFE_ID.fullmatch(case_id) else "?"
    if observed is None:
        return {"test": test, "id": safe_id, "kind": case.kind if case else None, "status": None,
                "code": None, "no_store": False, "secret_in_body": False, "audit_delta": None,
                "audit_actions": [], "report_rows_equal": None, "state_equal": None, "problems": problems}
    body = observed.get("body")
    code = body.get("code") if isinstance(body, dict) else None
    before = observed.get("before") if isinstance(observed.get("before"), dict) else {}
    after = observed.get("after") if isinstance(observed.get("after"), dict) else {}
    rows = after.get("audit") if isinstance(after.get("audit"), list) else []
    secret = context.get("secret")
    return {
        "test": test, "id": safe_id, "kind": case.kind if case else None,
        "status": observed.get("status") if type(observed.get("status")) is int else None,
        "code": code if isinstance(code, str) and SAFE_CODE.fullmatch(code) else None,
        "no_store": observed.get("cache_control") == "no-store",
        "secret_in_body": _text(secret) and secret in str(observed.get("text", "")),
        "audit_delta": len(rows),
        "audit_actions": sorted({row["action"] for row in rows if isinstance(row, dict)
                                 and isinstance(row.get("action"), str) and SAFE_ACTION.fullmatch(row["action"])}),
        "report_rows_equal": _same(before, after, ("report", "drafts", "versions")),
        "state_equal": _same(before, after, ("state",)),
        "problems": problems,
    }


def evaluate(test: str, records: list[dict[str, Any]], context: dict[str, Any]) -> list[dict[str, Any]]:
    """One U5-CASE line per recorded call plus one per case that never ran. A refusal or input case is
    credited only when its paired control ran exactly once in the same test and passed."""
    seen = Counter(record.get("id") for record in records)
    results: list[tuple[dict[str, Any], set[str]]] = []
    outcome: dict[Any, list[set[str]]] = {}
    for record in records:
        case_id = record.get("id")
        case = CASE_BY_ID.get(case_id) if isinstance(case_id, str) else None
        problems = set(case_problems(case_id, record, context)) if case and case.test == test else {"unknown-case"}
        if seen[case_id] > 1:
            problems.add("duplicate-case")
        results.append((record, problems))
        outcome.setdefault(case_id, []).append(problems)
    for record, problems in results:
        case = CASE_BY_ID.get(record.get("id")) if isinstance(record.get("id"), str) else None
        if case is not None and case.test == test and case.pair is not None:
            paired = outcome.get(case.pair, [])
            if len(paired) != 1 or paired[0]:
                problems.add("unpaired")
    lines = [_line(test, record.get("id"), record, _ordered(problems), context) for record, problems in results]
    lines += [_line(test, case_id, None, ["missing-case"], context) for case_id in case_ids(test) if not seen[case_id]]
    return lines


def precondition(test: str, capability: Any, source_pin: str | None, wav_bytes: bytes) -> dict[str, Any]:
    """Checked once per test: the shipped entry reports the unconfigured engine and the source pin, and the
    canonical bytes are the pinned 46. Otherwise a 503 would not be an admission witness."""
    cap = capability if isinstance(capability, dict) else {}
    line = {
        "test": test,
        "available": cap.get("available") if type(cap.get("available")) is bool else None,
        "max_bytes": cap.get("maxBytes") if type(cap.get("maxBytes")) is int else None,
        "engine_pin_matches": _text(source_pin) and cap.get("enginePin") == source_pin,
        "wav_matches": hashlib.sha256(wav_bytes).hexdigest() == WAV_SHA256,
    }
    ok = (line["available"] is False and line["max_bytes"] == MAX_BYTES
          and line["engine_pin_matches"] and line["wav_matches"])
    line["problems"] = [] if ok else ["precondition"]
    return line


def summary(lines: list[dict[str, Any]], preconditions: list[dict[str, Any]]) -> dict[str, Any]:
    executed = [line["id"] for line in lines if "missing-case" not in line["problems"]]
    counts = Counter(executed)
    problems = sorted({line["id"] for line in lines if line["problems"]})
    failed = sorted({str(line.get("test")) for line in preconditions if line.get("problems")})
    tested = sorted({str(line.get("test")) for line in preconditions})
    complete = (sorted(executed) == sorted(CASE_BY_ID) and not problems
                and len(preconditions) == len(TESTS) and tested == sorted(TESTS) and not failed)
    return {
        "expected_cases": len(CASES), "executed_cases": len(executed),
        "missing": sorted(set(CASE_BY_ID) - set(executed)),
        "duplicate": sorted(case_id for case_id, count in counts.items() if count > 1),
        "with_problems": problems,
        "kinds": {kind: sum(1 for case_id in counts if case_id in CASE_BY_ID and CASE_BY_ID[case_id].kind == kind)
                  for kind in KINDS},
        "tests": sorted({line["test"] for line in lines}),
        "preconditions": len(preconditions), "preconditions_failed": failed,
        "complete": complete,
    }


def live_wiring_problems(source: str) -> list[str]:
    """Static pins on tests/invariants_live.py, parsed and never imported: the eight tests call exactly
    their table cases in order with matching keys, and the A1/A3/A4/A5 amendments stay in the code."""
    tree = ast.parse(source)
    problems: set[str] = set()
    if not any(isinstance(node, ast.Import) and any(alias.name == "dictation_refusal_oracle" and alias.asname == "u5"
                                                    for alias in node.names) for node in tree.body):
        problems.add("wiring-import")
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}

    def calls(node: ast.AST, name: str) -> list[ast.Call]:
        return [call for call in ast.walk(node) if isinstance(call, ast.Call) and (
            isinstance(call.func, ast.Name) and call.func.id == name
            or isinstance(call.func, ast.Attribute) and call.func.attr == name)]

    snapshot, call = functions.get("u5_snapshot"), functions.get("u5_call")
    if (snapshot is None or call is None or len(calls(snapshot, "psql")) != 1
            or len(calls(call, "u5_snapshot")) != 2 or len(calls(tree, "u5_snapshot")) != 2):
        problems.add("wiring-A1")      # one composite SELECT per snapshot, two snapshots per case
    teardown = functions.get("tearDownModule")
    if teardown is None or "U5-SUMMARY " not in (ast.get_source_segment(source, teardown) or ""):
        problems.add("wiring-summary")
    found = {(cls.name, node.name): node for cls in tree.body if isinstance(cls, ast.ClassDef)
             for node in cls.body if isinstance(node, ast.FunctionDef) and node.name.startswith("test_dictation_u5_")}
    if set(found) != set(TESTS.values()):
        problems.add("wiring-names")
    for key, name in TESTS.items():
        method = found.get(name)
        if method is None:
            continue
        for helper, position in (("u5_precondition", 2), ("u5_emit", 0), ("u5_assert", 1)):
            keys = [hit.args[position].value if len(hit.args) > position and isinstance(hit.args[position], ast.Constant)
                    else None for hit in calls(method, helper)]
            if keys != [key]:
                problems.add("wiring-keys")
        hits = calls(method, "u5_call")
        ids = [hit.args[1].value if len(hit.args) > 1 and isinstance(hit.args[1], ast.Constant) else None for hit in hits]
        if ids != case_ids(key):
            problems.add("wiring-cases")
        if "/health" in (ast.get_source_segment(source, method) or ""):
            problems.add("wiring-A3")   # a public route proves nothing about the caller's token
        if key == "T3":
            backdates = calls(method, "backdate_hold")
            at = {hit.args[1].value: hit.lineno for hit in hits if len(hit.args) > 1 and isinstance(hit.args[1], ast.Constant)}
            if (len(backdates) != 1 or not {"C-HOLDER", "C-EXPIRED"} <= set(at)
                    or not at["C-HOLDER"] < backdates[0].lineno < at["C-EXPIRED"]):
                problems.add("wiring-A4")
        if key == "T7":
            logins = [ast.unparse(hit) for hit in calls(method, "bff_login")]
            if logins != ["self.bff_login('doctor', self.stack.passwords['doctor'])"]:
                problems.add("wiring-A5")
        if key == "T6":
            cleaned = [node for node in ast.walk(method) if isinstance(node, ast.Try) and any(
                ast.unparse(hit) == "self.stack.cleanup_fixture(probe)"
                for part in node.finalbody for hit in calls(part, "cleanup_fixture"))]
            if len(cleaned) != 1:
                problems.add("wiring-probe")
    return _ordered(problems, WIRING_TAGS)
