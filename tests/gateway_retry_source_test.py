"""TEST-S4-U4-NOW-RETRY source: stdlib only - no database, network, browser, Node or container.

An independent model of the Now Retry rules (closed body, closed poll query, which stored receipt a request
may bind, the D2 pending predicate, the agent's D4 confirm-then-compare-and-set and the one row change a nudge
makes) is judged against tests/gateway_retry_vectors.json, which the compiled api/src/gateway-retry.ts also
reads in kin-api:ci (tests/gateway_retry_server_test.cjs). Named wrong rules must each fail a vector, so the
vectors are not decoration. agent.py is read by AST and never imported (it needs `requests`).

These are source pins and a model, not behaviour: the agent cases (SQLite), the compiled server cases, the DOM
cases, the live route case and the restore probes are hosted-only and prove the behaviour this file only names.
"""
import ast
import hashlib
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def text(*parts):
    return ROOT.joinpath(*parts).read_text(encoding="utf-8").replace("\r\n", "\n")


VECTORS = json.loads(text("tests", "gateway_retry_vectors.json"))
AGENT = text("gateway", "agent", "agent.py")
AGENT_TESTS = text("gateway", "agent", "test_agent.py")
README = text("gateway", "README.md")
RULE = text("api", "src", "gateway-retry.ts")
RECEIPT_RULE = text("api", "src", "gateway-receipt.ts")
SERVICE = text("api", "src", "pacs.service.ts")
CONTROLLER = text("api", "src", "pacs.controller.ts")
SCHEMA = text("api", "prisma", "schema.prisma")
MIGRATION_NAME = "20260924140000_gateway_retry_request"
U3_MIGRATION = "20260924130000_gateway_receipt"
MIGRATION_PATH = ROOT / "api" / "prisma" / "migrations" / MIGRATION_NAME / "migration.sql"
MIGRATION = text("api", "prisma", "migrations", MIGRATION_NAME, "migration.sql")
MAIN = text("worklist-v0", "hpacs-lite", "main.html")
ARRIVALS = text("worklist-v0", "hpacs-lite", "study-arrivals.js")
AUTH = text("worklist-v0", "hpacs-lite", "auth.js")
INVARIANTS = text("tests", "invariants_live.py")
FIXTURE = text("tests", "ops_product_transfer_fixture.py")
WORKFLOW = text(".github", "workflows", "validate.yml")
EPOCH = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
F01 = "같은 바이트로는 성공할 수 없습니다 — 지원 범위 밖(F-01)"
ADVISORY = "pg_advisory_xact_lock(hashtextextended(${'kin.gateway-receipt:' + uid}, 0))"
# U3 surfaces this unit must not touch, as they are at 9152f43 (LF-normalised sha256).
U3_METHOD_SHA256 = "3cf9846a5d1559b9adaf4b9274ac9b61a31b02d54766f94548e95f060755c947"
U3_RULE_SHA256 = "bff24d487a066df554c2dbe70a9ca1dbc28cf52062eebac87f9a537344d27510"
U1B_GATEWAY_LABEL_SHA256 = "4b1b003bebeca107b0769f6eee49247e8f380d153c8269d6276673a1475aad79"


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def between(source, start, end):
    head = source.index(start)
    return source[head:source.index(end, head + len(start))]


def js_function(source, name):
    """Brace scan from `function name(`; quotes are skipped so a brace in a string cannot end it."""
    start = source.index("function " + name + "(")
    depth, quote, escaped = 0, None, False
    for index in range(source.index("{", start), len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


# ── an independent model, with named wrong rules ──

class Refused(ValueError):
    pass


def parse_body(case, wrong=None):
    if case.get("absent") or case["body"] is None:
        return "ok"
    body = case["body"]
    if wrong == "a client epoch or seq is taken" and isinstance(body, dict) and set(body) <= {"epoch", "seq"}:
        return "ok"
    if wrong == "falsy bodies are empty" and not body and not isinstance(body, dict):
        return "ok"
    if wrong == "any empty container is empty" and isinstance(body, list) and not body:
        return "ok"
    if not isinstance(body, dict) or body:
        return "body"
    return "ok"


def parse_poll(query, wrong=None):
    if not isinstance(query, dict):
        return "query"
    keys = list(query)
    if wrong == "extra keys tolerated":
        keys = [key for key in keys if key == "epoch"] or keys
    if keys != ["epoch"]:
        return "query"
    epoch = query["epoch"]
    if wrong == "the first array element is taken" and isinstance(epoch, list) and epoch:
        epoch = epoch[0]
    if wrong == "an object value is read" and isinstance(epoch, dict) and epoch:
        epoch = next(iter(epoch.values()))
    if not isinstance(epoch, str):
        return "epoch"
    candidate = epoch.lower() if wrong == "epoch case-insensitive" else epoch.strip() if wrong == "epoch trimmed" else epoch
    return "ok" if EPOCH.fullmatch(candidate) else "epoch"


def decide(receipt, wrong=None):
    if receipt is None:
        return "eligible" if wrong == "no receipt is eligible" else "not_retry"
    phase = receipt["phase"]
    if phase == "failed":
        return "eligible" if wrong == "failed is eligible" else "unsupported_f01"
    if phase == "complete" and wrong == "complete is eligible":
        return "eligible"
    if wrong == "any error-free phase is eligible" and phase in ("pending", "announcing", "sending"):
        return "eligible"
    return "eligible" if phase == "retry" else "not_retry"


def pending(case, wrong=None):
    request, receipt, me = case["request"], case["receipt"], case["me"]
    if receipt is None:
        return False
    same_epoch = request["epoch"] == receipt["epoch"] or wrong == "the stored epoch is ignored"
    same_seq = request["seq"] == receipt["seq"] or wrong == "the stored seq is ignored"
    retry = receipt["phase"] == "retry" or wrong == "any phase is delivered"
    own_receipt = receipt["institutionId"] == me or wrong == "the receipt institution is ignored"
    own_study = case["study"] == me or wrong == "the study institution is ignored"
    poller = request["epoch"] == case["poll"] or wrong == "the poller's epoch is ignored"
    return same_epoch and same_seq and retry and own_receipt and own_study and poller


def apply(case, wrong=None):
    """D4: the local row must still wait in this retry state, then only an exact duplicate applies."""
    local, answer = case["local"], case["answer"]
    if local != "waiting" and not (wrong == "the local waiting check is skipped" and local == "eligible"):
        return False
    body, ok = answer["body"], 200 <= answer["status"] < 300
    if wrong == "a duplicate-looking body is enough":
        ok = True
    if not ok:
        return False
    if wrong == "stored applies" and body.get("result") == "stored":
        return True
    if wrong == "stale applies" and body.get("result") == "stale":
        return True
    if wrong == "any duplicate applies":
        return body.get("result") == "duplicate"
    return body == {"studyUid": "1.2.3", "result": "duplicate"}


def nudge(row, wrong=None):
    after = dict(row, next_at=0)
    if wrong == "attempt reset":
        after["attempt"] = 0
    if wrong == "seq bumped":
        after["seq"] += 1
    if wrong == "last error cleared":
        after["last_error"] = None
    if wrong == "sent SOPs forgotten":
        after["successful_sops"] = "[]"
    if wrong == "updated_at touched":
        after["updated_at"] += 1
    return after


WRONG = {
    "requestBody": (lambda c, w: parse_body(c, w), lambda c: "ok" if c.get("ok") else c["error"],
                    ["a client epoch or seq is taken", "falsy bodies are empty", "any empty container is empty"]),
    "pollQuery": (lambda c, w: parse_poll(c["query"], w), lambda c: "ok" if c.get("ok") else c["error"],
                  ["extra keys tolerated", "the first array element is taken", "an object value is read",
                   "epoch case-insensitive", "epoch trimmed"]),
    "decide": (lambda c, w: decide(c["receipt"], w), lambda c: c["expect"],
               ["no receipt is eligible", "failed is eligible", "complete is eligible", "any error-free phase is eligible"]),
    "pending": (lambda c, w: pending(c, w), lambda c: c["expect"],
                ["the stored epoch is ignored", "the stored seq is ignored", "any phase is delivered",
                 "the receipt institution is ignored", "the study institution is ignored", "the poller's epoch is ignored"]),
    "apply": (lambda c, w: apply(c, w), lambda c: c["expect"],
              ["the local waiting check is skipped", "a duplicate-looking body is enough", "stored applies",
               "stale applies", "any duplicate applies"]),
}
NUDGE_WRONG = ["attempt reset", "seq bumped", "last error cleared", "sent SOPs forgotten", "updated_at touched"]


class ModelVectors(unittest.TestCase):
    def test_every_vector(self):
        for kind, (model, expected, _wrong) in WRONG.items():
            for case in VECTORS[kind]:
                with self.subTest(kind=kind, case=case["id"]):
                    self.assertEqual(model(case, None), expected(case))
        self.assertEqual(nudge(VECTORS["nudge"]["before"]), VECTORS["nudge"]["after"])

    def test_each_named_wrong_rule_fails_a_vector(self):
        for kind, (model, expected, wrong_rules) in WRONG.items():
            for wrong in wrong_rules:
                with self.subTest(kind=kind, wrong=wrong):
                    self.assertTrue([c["id"] for c in VECTORS[kind] if model(c, wrong) != expected(c)])
        for wrong in NUDGE_WRONG:
            with self.subTest(wrong=wrong):
                self.assertNotEqual(nudge(VECTORS["nudge"]["before"], wrong), VECTORS["nudge"]["after"])

    def test_vectors_cover_the_contract_cases(self):
        ids = " ".join(case["id"] for kind in WRONG for case in VECTORS[kind])
        for needle in ("R6 a repeated key becomes an array", "R6 a bracket key becomes an object", "failed is F-01",
                       "the next receipt (announcing) ends it", "a recreated queue polls with another epoch",
                       "stored: KIN held an older state", "stale: this queue went back in time", "prototype key",
                       "already eligible: no confirmation is sent"):
            self.assertIn(needle, ids)
        self.assertEqual((VECTORS["epoch"], VECTORS["pollLimit"]), ("0a1b2c3d-0000-4000-8000-00000000000a", 100))
        self.assertEqual([k for k, v in VECTORS["nudge"]["before"].items() if VECTORS["nudge"]["after"][k] != v], ["next_at"])


# ── the agent, read by AST ──

def agent_tree():
    return ast.parse(AGENT)


def method(tree, cls, name):
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == cls:
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == name:
                    return item
    raise KeyError(cls + "." + name)


def attributes_of(node, owner):
    """Names used as self.<owner>.<name> inside node."""
    return {n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Attribute)
            and n.value.attr == owner and isinstance(n.value.value, ast.Name) and n.value.value.id == "self"}


def single_writer_problems(source):
    """R1: between KIN's poll and the compare-and-set nothing may write the confirmed row. The loop is single
    threaded, and Agent.retry_requests may use only these queue methods (reported writes reported_seq only)."""
    tree, problems = ast.parse(source), []
    retry = method(tree, "Agent", "retry_requests")
    used = attributes_of(retry, "queue")
    if used != {"epoch", "receipt", "waiting", "reported", "retry_now"}:
        problems.append("queue methods " + ",".join(sorted(used)))
    if attributes_of(retry, "cloud") != {"retry_requests", "receipt"}:
        problems.append("cloud methods")
    calls = {n.func.attr for n in ast.walk(retry) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and isinstance(n.func.value, ast.Name) and n.func.value.id == "self"}
    if calls:
        problems.append("self calls " + ",".join(sorted(calls)))
    reported = [n.value for n in ast.walk(method(tree, "Queue", "reported")) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
    if [set(re.findall(r"\b(\w+)\s*=", sql.split("WHERE")[0])) for sql in reported] != [{"reported_seq"}]:
        problems.append("reported writes more than reported_seq")
    imported = {alias.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))
                for alias in (n.names if isinstance(n, ast.Import) else [ast.alias(n.module or "")])}
    if imported & {"threading", "multiprocessing", "asyncio", "concurrent"}:
        problems.append("concurrency import")
    return problems


RETRY_NOW_SQL = "UPDATE studies SET next_at=0 WHERE uid=? AND phase='retry' AND seq=? AND next_at>?"
WAITING_SQL = "SELECT 1 FROM studies WHERE uid=? AND phase='retry' AND seq=? AND next_at>?"


def compare_and_set_problems(source):
    tree, problems = ast.parse(source), []
    for name, sql in (("retry_now", RETRY_NOW_SQL), ("waiting", WAITING_SQL)):
        found = [n.value for n in ast.walk(method(tree, "Queue", name)) if isinstance(n, ast.Constant)
                 and isinstance(n.value, str) and n.value.startswith(sql.split(" ")[0])]
        if found != [sql]:
            problems.append(name)
    node = method(tree, "Queue", "retry_now")
    if "return cursor.rowcount == 1" not in (ast.get_source_segment(source, node) or ""):
        problems.append("retry_now result")
    if {n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute)} & {"pending_now", "retry", "phase", "fail", "complete"}:
        problems.append("retry_now calls another writer")
    return problems


def cadence_problems(source):
    tree, problems = ast.parse(source), []
    constants = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in ("RETRY_POLL_SECONDS", "RETRY_POLL_LIMIT"):
                    try:
                        constants[target.id] = ast.literal_eval(node.value)
                    except ValueError:
                        constants[target.id] = None
    if constants != {"RETRY_POLL_SECONDS": 30.0, "RETRY_POLL_LIMIT": 100}:
        problems.append("constants")
    config = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Config")
    if "RETRY" in ast.get_source_segment(source, config).upper():
        problems.append("configurable")
    # Every environment read in the agent names its variable literally; none may name a retry cadence.
    names = [n.args[0].value for n in ast.walk(tree) if isinstance(n, ast.Call) and n.args and isinstance(n.args[0], ast.Constant)
             and isinstance(n.args[0].value, str) and (isinstance(n.func, ast.Name) and n.func.id == "required"
                                                        or isinstance(n.func, ast.Attribute) and n.func.attr == "get"
                                                        and isinstance(n.func.value, ast.Attribute) and n.func.value.attr == "environ")]
    if not names or any("RETRY" in name.upper() for name in names):
        problems.append("environment")
    init = ast.get_source_segment(source, method(tree, "Agent", "__init__"))
    if "self.retry_poll_at = time.monotonic() + RETRY_POLL_SECONDS" not in init:
        problems.append("first poll")
    body = ast.get_source_segment(source, method(tree, "Agent", "retry_requests"))
    order = ["now = time.monotonic()", "if now < self.retry_poll_at:", "self.retry_poll_at = now + RETRY_POLL_SECONDS",
             "if now < self.receipts_resume_at:", "self.cloud.retry_requests(self.queue.epoch)", "retry_request_uids(response)",
             "self.queue.receipt(uid)", "self.queue.waiting(uid, body[\"seq\"], at)", "self.cloud.receipt(body)",
             "self.queue.reported(uid, body[\"seq\"])", "answer = confirm.json() if confirm.ok else None",
             "if answer != {\"studyUid\": uid, \"result\": \"duplicate\"}:", "self.queue.retry_now(uid, body[\"seq\"], at)"]
    try:
        positions = [body.index(needle) for needle in order]
        if positions != sorted(positions):
            problems.append("order")
    except ValueError as error:
        problems.append("missing " + str(error))
    run = ast.get_source_segment(source, method(tree, "Agent", "run"))
    try:
        if not run.index("self.flush_receipts()") < run.index("self.retry_requests()") < run.index("self.poll_changes()"):
            problems.append("run order")
    except ValueError:
        problems.append("run order")
    return problems


class AgentPins(unittest.TestCase):
    def test_r1_single_writer_the_retry_path_touches_the_queue_only_through_its_four_methods(self):
        self.assertEqual(single_writer_problems(AGENT), [])
        retry = ast.get_source_segment(AGENT, method(agent_tree(), "Agent", "retry_requests"))
        self.assertIn("Single-writer assumption", retry)
        self.assertIn("Two hosts running copies of one queue.db share an epoch", retry)
        self.assertIn("No exactly-once delivery is claimed", retry)
        call = "            response = self.cloud.retry_requests(self.queue.epoch)\n"
        mutants = {
            "writes the phase": AGENT.replace(call, call + "            self.queue.phase(uid, \"announcing\")\n"),
            "reports through report()": AGENT.replace(call, call + "            self.report(\"1.2.3\")\n"),
            "resets through pending_now": AGENT.replace(call, call + "            self.queue.pending_now(\"1.2.3\", 1, 0)\n"),
            "retries through retry()": AGENT.replace(call, call + "            self.queue.retry(\"1.2.3\", \"x\", 1, 2)\n"),
            "a worker thread": AGENT.replace("import time\n", "import time\nimport threading\n"),
            "reported moves seq": AGENT.replace("UPDATE studies SET reported_seq=? WHERE", "UPDATE studies SET reported_seq=?, seq=seq+1 WHERE"),
        }
        for wrong, source in mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, AGENT)
                self.assertNotEqual(single_writer_problems(source), [])
        self.assertIn("**한 에이전트 프로세스만 자기 epoch을\n쓴다**", README)

    def test_the_nudge_is_one_compare_and_set_on_next_at_only(self):
        self.assertEqual(compare_and_set_problems(AGENT), [])
        mutants = {"no seq guard": AGENT.replace(RETRY_NOW_SQL, RETRY_NOW_SQL.replace(" AND seq=?", "")),
                   "no phase guard": AGENT.replace(RETRY_NOW_SQL, RETRY_NOW_SQL.replace(" AND phase='retry'", "")),
                   "attempt reset": AGENT.replace(RETRY_NOW_SQL, RETRY_NOW_SQL.replace("next_at=0", "next_at=0, attempt=0")),
                   "seq bumped": AGENT.replace(RETRY_NOW_SQL, RETRY_NOW_SQL.replace("next_at=0", "next_at=0, seq=seq+1")),
                   "no already-eligible guard": AGENT.replace(RETRY_NOW_SQL, RETRY_NOW_SQL.replace(" AND next_at>?", ""))}
        for wrong, source in mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, AGENT)
                self.assertNotEqual(compare_and_set_problems(source), [])
        # Not a receipt field: U3's "8 UPDATEs that touch a receipt field" pin is untouched by retry_now.
        self.assertEqual(set(re.findall(r"\b(\w+)\s*=", RETRY_NOW_SQL.split("WHERE")[0])), {"next_at"})
        retry = ast.get_source_segment(AGENT, method(agent_tree(), "Agent", "retry_requests"))
        self.assertNotIn("pending_now", retry)

    def test_the_poll_is_fixed_slow_confirmed_and_ordered(self):
        self.assertEqual(cadence_problems(AGENT), [])
        mutants = {"configurable": AGENT.replace("    backoff_max: float\n", "    backoff_max: float\n    retry_poll: float = 30.0\n"),
                   "from the environment": AGENT.replace("RETRY_POLL_SECONDS = 30.0", "RETRY_POLL_SECONDS = float(os.environ.get(\"RETRY_POLL_SECONDS\", \"30\"))"),
                   "faster": AGENT.replace("RETRY_POLL_SECONDS = 30.0", "RETRY_POLL_SECONDS = 2.0"),
                   "first poll at start": AGENT.replace("self.retry_poll_at = time.monotonic() + RETRY_POLL_SECONDS", "self.retry_poll_at = 0.0"),
                   "no receipt backoff": AGENT.replace("        if now < self.receipts_resume_at:\n            return\n        try:\n            response",
                                                       "        try:\n            response"),
                   "applies on any 2xx": AGENT.replace("if answer != {\"studyUid\": uid, \"result\": \"duplicate\"}:", "if not confirm.ok:"),
                   "polls before the flush": AGENT.replace("            self.flush_receipts()\n", "").replace(
                       "            self.retry_requests()\n", "            self.retry_requests()\n            self.flush_receipts()\n")}
        for wrong, source in mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, AGENT)
                self.assertNotEqual(cadence_problems(source), [])
        self.assertIn('return self.request("GET", "/api/gateway/retry-requests", params={"epoch": epoch})', AGENT)

    def test_the_poll_answer_parser_and_the_logs_carry_uids_codes_and_counts_only(self):
        parser = ast.get_source_segment(AGENT, next(n for n in agent_tree().body if isinstance(n, ast.FunctionDef)
                                                    and n.name == "retry_request_uids"))
        for needle in ('set(payload) != {"studyUids"}', "len(uids) > RETRY_POLL_LIMIT", "RETRY_POLL_UID.fullmatch(uid)",
                       "len(set(uids)) != len(uids)", "if not response.ok:"):
            self.assertIn(needle, parser)
        self.assertIn('RETRY_POLL_UID = re.compile(r"[0-9.]+")', AGENT)
        retry = method(agent_tree(), "Agent", "retry_requests")
        logged = [n for n in ast.walk(retry) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "log"]
        self.assertEqual(sorted({n.args[0].value for n in logged}),
                         ["retry_request.deferred", "retry_request.invalid", "retry_request.unconfirmed", "study.retry_now"])
        self.assertTrue(all({k.arg for k in n.keywords} <= {"uid", "status", "error", "attempt"} for n in logged))

    def test_the_agent_suite_names_t1_to_t6(self):
        cls = next(n for n in ast.parse(AGENT_TESTS).body if isinstance(n, ast.ClassDef) and n.name == "RetryNowTests")
        names = [item.name for item in cls.body if isinstance(item, ast.FunctionDef) and item.name.startswith("test")]
        self.assertEqual([name[:8] for name in names], ["test_t1_", "test_t2_", "test_t3_", "test_t4_", "test_t4_", "test_t5_", "test_t6_"])
        method_text = between(INVARIANTS, "    def test_gateway_agent_queue_and_batch_contract(self) -> None:",
                              "    def test_production_gateway_contract_is_declared")
        self.assertIn('self.assertIn("Ran 25 tests"', method_text)
        self.assertIn("18 -> 25: S4-U4 added RetryNowTests", method_text)


# ── the server ──

def member_problems(service):
    body = between(service, "  async requestGatewayRetry(uid: string, body: unknown, c: Caller) {", "\n  }\n")
    problems = []
    order = ["need(c.roles, 'technician', 'Gateway 재시도 요청');", "if (c.kind !== 'member')", "const me = inst(c);",
             "parseGatewayRetryRequestBody(body)", "const s = await this.gate(uid, c);",
             "if (!s || s.institutionId !== me) throw new NotFoundException('검사를 찾을 수 없습니다');",
             "await this.studyAccess.prepare(c, [uid]);", "this.prisma.$transaction(", "SET LOCAL lock_timeout = '3s'", ADVISORY,
             "await this.studyAccess.require(c, [uid], tx);",
             "tx.studyState.findUnique({ where: { uid }, select: { institutionId: true } })",
             "if (!study || study.institutionId !== me) return { kind: 'absent' };",
             "tx.gatewayReceipt.findFirst({ where: { studyUid: uid, institutionId: me } })", "decideGatewayRetryRequest(receipt)",
             "tx.gatewayRetryRequest.findUnique({ where: { studyUid_epoch_seq: key } })",
             "if (existing) return { kind: 'already_requested', requestedAt: existing.requestedAt };",
             "tx.gatewayRetryRequest.create({ data: { ...key, requestedAt } })",
             "action: 'gateway.retry.request', target: uid,", "detail: dump({ epoch: key.epoch, seq: Number(key.seq) })"]
    try:
        positions = [body.index(needle) for needle in order]
        if positions != sorted(positions):
            problems.append("order")
    except ValueError as error:
        problems.append("missing " + str(error)[:60])
    # R2: the role check is need() itself (admin included), never an exact or technician-only test.
    if not body.split("\n", 1)[1].lstrip().startswith("need(c.roles, 'technician', "):
        problems.append("need is not the first statement")
    if "needExact" in body or re.search(r"roles\??\.includes\(\s*['\"]technician", body):
        problems.append("technician-only")
    if body.count("new NotFoundException('검사를 찾을 수 없습니다')") != 2 or body.count("NotFoundException(") != 2:
        problems.append("404 wording")
    if body.count("auditLog.create(") != 1 or body.count("gatewayRetryRequest.create(") != 1:
        problems.append("one write and one audit")
    for banned in ("gatewayReceipt.create", "gatewayReceipt.update", "gatewayReceipt.upsert", "studyState.update",
                   "studyState.create", "this.orthanc", "Date.now"):
        if banned in body:
            problems.append(banned)
    if "isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000" not in body:
        problems.append("transaction options")
    if "throw new ServiceUnavailableException({ code: GATEWAY_RETRY_BUSY });" not in body:
        problems.append("busy")
    return problems


POLL_SQL = ('SELECT q."studyUid" FROM "GatewayRetryRequest" q\n'
            '      JOIN "GatewayReceipt" r ON r."studyUid" = q."studyUid" AND r.epoch = q.epoch AND r.seq = q.seq\n'
            '      JOIN "StudyState" s ON s.uid = q."studyUid"\n'
            "      WHERE q.epoch = ${epoch}::uuid AND r.phase = 'retry' AND r.\"institutionId\" = ${me} AND s.\"institutionId\" = ${me}\n"
            '      ORDER BY q."requestedAt", q."studyUid" LIMIT 100')


def poll_problems(service):
    body = between(service, "  async gatewayRetryRequests(query: unknown, c: Caller) {", "\n  }\n")
    problems = []
    order = ["needExact(c, 'gateway', 'Gateway 재시도 요청 조회');", "const me = inst(c);", "parseGatewayRetryPoll(query)",
             "await this.prisma.$queryRaw`" + POLL_SQL + "`;", "return { studyUids: rows.map(row => row.studyUid) };"]
    try:
        positions = [body.index(needle) for needle in order]
        if positions != sorted(positions):
            problems.append("order")
    except ValueError as error:
        problems.append("missing " + str(error)[:60])
    for banned in ("$transaction", ".create(", ".update(", "auditLog", "audit(", "need(c.roles", "count", ".slice("):
        if banned in body:
            problems.append(banned)
    return problems


class ServerPins(unittest.TestCase):
    def test_the_rule_module_is_pure_and_its_constants_are_the_vectors(self):
        for banned in ("import ", "require(", "prisma", "process.env", "Date", "fetch("):
            self.assertNotIn(banned, RULE, banned)
        self.assertIn("export const GATEWAY_RETRY_POLL_LIMIT = 100;", RULE)
        self.assertEqual(VECTORS["pollLimit"], 100)
        epoch = "const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;"
        self.assertEqual((RULE.count(epoch), RECEIPT_RULE.count(epoch)), (1, 1), "a byte-equal copy of the U3 epoch literal")
        decide = between(RULE, "export function decideGatewayRetryRequest(", "\n}\n")
        self.assertLess(decide.index("if (!receipt) return 'not_retry';"), decide.index("if (receipt.phase === 'failed') return 'unsupported_f01';"))
        self.assertIn("return receipt.phase === 'retry' ? 'eligible' : 'not_retry';", decide)
        poll = between(RULE, "export function parseGatewayRetryPoll(", "\n}\n")
        self.assertIn("if (keys.length !== 1 || keys[0] !== 'epoch')", poll)
        self.assertIn("if (typeof epoch !== 'string' || !EPOCH.test(epoch))", poll)
        body = between(RULE, "export function parseGatewayRetryRequestBody(", "\n}\n")
        self.assertIn("if (body === undefined || body === null) return;", body)
        self.assertIn("Array.isArray(body) || Object.keys(body).length !== 0", body)

    def test_the_member_route_checks_in_order_binds_under_the_u3_lock_and_writes_once(self):
        self.assertEqual(member_problems(SERVICE), [])
        method_text = between(SERVICE, "  async requestGatewayRetry(uid: string, body: unknown, c: Caller) {", "\n  }\n")
        mutants = {
            "R2 exact technician": SERVICE.replace("need(c.roles, 'technician', 'Gateway 재시도 요청');",
                                                   "if (!c.roles.includes('technician')) throw new ForbiddenException('x');"),
            "R2 needExact": SERVICE.replace("need(c.roles, 'technician', 'Gateway 재시도 요청');",
                                            "needExact(c, 'technician', 'Gateway 재시도 요청');"),
            "tele-received accepted": SERVICE.replace("if (!s || s.institutionId !== me) throw", "if (!s) throw"),
            "another lock key": SERVICE.replace("${'kin.gateway-receipt:' + uid}, 0))`;\n      await this.studyAccess.require(c, [uid], tx);",
                                                "${'kin.gateway-retry:' + uid}, 0))`;\n      await this.studyAccess.require(c, [uid], tx);"),
            "any institution's receipt": SERVICE.replace("{ where: { studyUid: uid, institutionId: me } }", "{ where: { studyUid: uid } }"),
            "a second audit": SERVICE.replace("      return { kind: 'requested', requestedAt };",
                                              "      await tx.auditLog.create({ data: { actor: 'x', action: 'x', target: uid } });\n      return { kind: 'requested', requestedAt };"),
            "the receipt is touched": SERVICE.replace("      return { kind: 'requested', requestedAt };",
                                                      "      await tx.gatewayReceipt.update({ where: { studyUid: uid }, data: {} });\n      return { kind: 'requested', requestedAt };"),
        }
        for wrong, source in mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, SERVICE)
                self.assertNotEqual(member_problems(source), [])
        self.assertIn("return { studyUid: uid, result: outcome.kind, requestedAt: outcome.requestedAt.toISOString() };", method_text)
        self.assertIn("throw new ConflictException({ code: GATEWAY_RETRY_UNSUPPORTED_F01 });", method_text)
        self.assertIn("throw new ConflictException({ code: GATEWAY_RETRY_NOT_RETRY });", method_text)
        # gate() answers absent-or-foreign with the same sentence; studyAccess.require answers restricted with it too.
        self.assertIn("      throw new NotFoundException('검사를 찾을 수 없습니다');\n    if(s)await this.studyAccess.require(", SERVICE)
        self.assertIn("if(uids.some(uid=>!allowed.has(uid)))throw new NotFoundException('검사를 찾을 수 없습니다');",
                      text("api", "src", "study-access.service.ts"))
        # need() admits admin; the UI's KinAuth.has does the same (auth.js), so admin inclusion is one rule.
        self.assertIn("  if (!roles?.includes(role) && !roles?.includes('admin'))", SERVICE)
        self.assertIn("return session.roles.includes(role) || session.roles.includes('admin');", AUTH)

    def test_the_poll_is_gateway_only_read_only_and_decides_pending_in_sql_before_the_limit(self):
        self.assertEqual(poll_problems(SERVICE), [])
        mutants = {"no seq equality": SERVICE.replace(" AND r.seq = q.seq", ""),
                   "no epoch equality": SERVICE.replace(" AND r.epoch = q.epoch AND", " AND"),
                   "any phase": SERVICE.replace(" AND r.phase = 'retry'", ""),
                   "no receipt institution": SERVICE.replace(" AND r.\"institutionId\" = ${me}", ""),
                   "no study institution": SERVICE.replace(" AND s.\"institutionId\" = ${me}", ""),
                   "no limit": SERVICE.replace(' LIMIT 100`;', '`;'),
                   "member admin allowed": SERVICE.replace("needExact(c, 'gateway', 'Gateway 재시도 요청 조회');",
                                                           "need(c.roles, 'technician', 'Gateway 재시도 요청 조회');"),
                   "a count leaks": SERVICE.replace("return { studyUids: rows.map(row => row.studyUid) };",
                                                    "return { studyUids: rows.map(row => row.studyUid), count: rows.length };")}
        for wrong, source in mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, SERVICE)
                self.assertNotEqual(poll_problems(source), [])
        self.assertIn("LIMIT 100", POLL_SQL)

    def test_request_history_is_append_only_everywhere(self):
        sources = {path.name: path.read_text(encoding="utf-8") for path in (ROOT / "api" / "src").rglob("*.ts")}
        for name, source in sources.items():
            for banned in ("gatewayRetryRequest.update", "gatewayRetryRequest.upsert", "gatewayRetryRequest.delete",
                           "gatewayRetryRequest.deleteMany", "gatewayRetryRequest.updateMany"):
                self.assertNotIn(banned, source, name)
            self.assertIsNone(re.search(r'(UPDATE|DELETE FROM)\s+"GatewayRetryRequest"', source), name)
        self.assertEqual(sum(s.count("'gateway.retry.request'") for s in sources.values()), 1)
        self.assertEqual(sum(s.count("gatewayRetryRequest.create(") for s in sources.values()), 1)

    def test_u3_surfaces_are_untouched(self):
        self.assertEqual(sha(between(SERVICE, "  async gatewayReceipt(body: unknown, c: Caller) {", "\n  }\n")), U3_METHOD_SHA256)
        self.assertEqual(sha(RECEIPT_RULE), U3_RULE_SHA256)
        # 1 -> 2 at S4-F01V: the unchanged projection also serves an absent own study (F01VPins below).
        self.assertEqual(SERVICE.count("projectGatewayReceipt("), 2)
        listing = between(SERVICE, "  async listStudies(c: Caller, query?: any) {", "  private notObserved(")
        bootstrap = between(SERVICE, "  async bootstrap(c: Caller, query?: any) {", "\n  }\n")
        for surface in (listing, bootstrap):
            self.assertNotIn("gatewayRetry", surface)
            self.assertNotIn("GatewayRetry", surface)

    def test_the_controller_routes_and_the_live_route_table(self):
        self.assertIn("  @Get('gateway/retry-requests')\n  @Header('Cache-Control', 'no-store')\n"
                      "  gatewayRetryRequests(@Query() query: any, @Req() req: any) {\n"
                      "    return this.svc.gatewayRetryRequests(query, caller(req));", CONTROLLER)
        self.assertIn("  @Post('studies/:uid/gateway-retry')\n  @HttpCode(200)\n"
                      "  requestGatewayRetry(@Param('uid') uid: string, @Body() body: any, @Req() req: any) {\n"
                      "    return this.svc.requestGatewayRetry(uid, body, caller(req));", CONTROLLER)
        self.assertIn('    ("GET", "gateway/retry-requests"): Route(Kind.TENANT),', INVARIANTS)
        self.assertIn('    ("POST", "studies/:uid/gateway-retry"): Route(Kind.TENANT),', INVARIANTS)
        live = between(INVARIANTS, "    def test_s4u4_gateway_retry_route_rules(self) -> None:", "    def test_gateway_agent_queue_and_batch_contract")
        for needle in ("# L2:", "# L3:", "# L4:", "# L5:", "# L6:", "# L7:", "# L8:", "# L9:", "# L10:", "# L11:",
                       '"?epoch%5Bx%5D=" + epoch_a', 'f"?epoch={epoch_a}&epoch={epoch_a}"', 'ask(uid, "tech"), ask(uid, "jmryu")',
                       'insert_pending(foreign_uid, "hallym", 5)', 'insert_pending(cross_uid, "kin-center", 5)',
                       "self.addCleanup(self.stack.cleanup_fixture, uid)"):
            self.assertIn(needle, live)
        for user in ('"ktech"', '"kdoctor"', '"tech"', '"jmryu"'):
            self.assertIn(user, live)
        self.assertNotIn("create_test_identity", live, "R2: no new live identity")


# ── schema, migration, restore ──

def migration_problems(source):
    body = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("--"))
    problems = []
    if body.count("CREATE TABLE") != 1 or 'CREATE TABLE "GatewayRetryRequest" (' not in body:
        problems.append("one table")
    stripped = body.replace("ON DELETE CASCADE", "").replace("ON UPDATE RESTRICT", "")
    for forbidden in ("ALTER TABLE", "DROP", "UPDATE ", "DELETE ", "INSERT", "TRUNCATE", "DEFAULT", "CREATE INDEX", " IN (",
                      "character varying"):
        if forbidden in stripped:
            problems.append(forbidden)
    for needle in ('"studyUid" TEXT NOT NULL', '"epoch" UUID NOT NULL', '"seq" BIGINT NOT NULL', '"requestedAt" TIMESTAMP(3) NOT NULL',
                   'CONSTRAINT "GatewayRetryRequest_pkey" PRIMARY KEY ("studyUid","epoch","seq")',
                   'CONSTRAINT "GatewayRetryRequest_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "GatewayReceipt"("studyUid") ON DELETE CASCADE ON UPDATE RESTRICT',
                   'CONSTRAINT "GatewayRetryRequest_seq_check" CHECK ("seq" BETWEEN 0 AND 9007199254740991)', "BEGIN;", "COMMIT;"):
        if needle not in body:
            problems.append(needle[:40])
    return problems


class MigrationPins(unittest.TestCase):
    def test_the_migration_is_one_additive_restore_stable_table(self):
        self.assertTrue(MIGRATION.startswith("--"))
        self.assertEqual(migration_problems(MIGRATION), [])
        self.assertNotIn(b"\r", MIGRATION_PATH.read_bytes())
        for wrong, source in {"a default": MIGRATION.replace('"requestedAt" TIMESTAMP(3) NOT NULL', '"requestedAt" TIMESTAMP(3) NOT NULL DEFAULT now()'),
                              "no PK seq": MIGRATION.replace('("studyUid","epoch","seq")', '("studyUid","epoch")'),
                              "FK to the study": MIGRATION.replace('REFERENCES "GatewayReceipt"("studyUid")', 'REFERENCES "StudyState"("uid")'),
                              "an index": MIGRATION.replace("COMMIT;", 'CREATE INDEX x ON "GatewayRetryRequest"(epoch);\nCOMMIT;'),
                              "no seq bound": MIGRATION.replace(' CHECK ("seq" BETWEEN 0 AND 9007199254740991)', ' CHECK ("seq" >= 0)')}.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, MIGRATION)
                self.assertNotEqual(migration_problems(source), [])

    def test_the_schema_model_matches_the_table(self):
        block = re.search(r"model GatewayRetryRequest \{(.*?)\n\}", SCHEMA, re.S).group(1)
        for needle in ("studyUid    String", "epoch       String   @db.Uuid", "seq         BigInt", "requestedAt DateTime",
                       "receipt GatewayReceipt @relation(fields: [studyUid], references: [studyUid], onDelete: Cascade, onUpdate: Restrict)",
                       "@@id([studyUid, epoch, seq])"):
            self.assertIn(needle, block)
        for banned in ("@default", "@updatedAt", "institution", "actor", "state"):
            self.assertNotIn(banned, block)
        receipt = re.search(r"model GatewayReceipt \{(.*?)\n\}", SCHEMA, re.S).group(1)
        self.assertIn("\n  retryRequests GatewayRetryRequest[]", receipt)
        self.assertNotIn("@default", receipt)

    def test_migration_order_image_and_restore_bookkeeping(self):
        names = sorted(p.name for p in (ROOT / "api" / "prisma" / "migrations").iterdir() if p.is_dir())
        self.assertEqual(names[-2:], [U3_MIGRATION, MIGRATION_NAME], "U3 immediately before U4, and U4 is last")
        self.assertEqual(len(names), 29)
        self.assertIn("'" + MIGRATION_NAME + "'", text("tests", "production_image_test.py"))
        self.assertIn("              'api/prisma/migrations/" + U3_MIGRATION + "/migration.sql',\n"
                      "              'api/prisma/migrations/" + MIGRATION_NAME + "/migration.sql']", FIXTURE)
        self.assertIn("'GatewayReceipt', 'GatewayRetryRequest'])", FIXTURE)          # TABLES
        self.assertIn("'GatewayReceipt', 'GatewayRetryRequest'):", FIXTURE)          # seeding order, after its FK parent
        self.assertIn("rows['GatewayRetryRequest'] = [dict(studyUid=uid, epoch='00000000-0000-4000-8000-000000000c01', seq=7,\n"
                      "        requestedAt=STAMP)]", FIXTURE)
        self.assertIn("epoch='00000000-0000-4000-8000-000000000c01', seq=7, phase='retry',", FIXTURE)   # the bound receipt
        for probe in ("BEGIN UPDATE \"GatewayRetryRequest\" SET seq=-1;\n        RAISE EXCEPTION 'missing gateway retry seq check'; EXCEPTION WHEN check_violation THEN NULL; END;",
                      "BEGIN UPDATE \"GatewayRetryRequest\" SET \"studyUid\"='2.25.0';\n        RAISE EXCEPTION 'missing gateway retry receipt FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;",
                      "BEGIN INSERT INTO \"GatewayRetryRequest\" SELECT * FROM \"GatewayRetryRequest\" LIMIT 1;\n        RAISE EXCEPTION 'missing gateway retry PK'; EXCEPTION WHEN unique_violation THEN NULL; END;"):
            self.assertEqual(FIXTURE.count(probe), 1, probe[:50])
        # R3(a): U3 pins exactly three single-quoted 'GatewayReceipt' tokens; U4 adds none.
        self.assertEqual(FIXTURE.count("'GatewayReceipt'"), 3)
        transfer = text("tests", "ops_product_transfer_test.py")
        self.assertIn("self.assertEqual(len(transfer.MIGRATIONS), 29)", transfer)
        self.assertIn("self.assertEqual(len(transfer.TABLES), 39)", transfer)
        self.assertIn("46 + 1 + 2 + 1 + 1 + 1)", transfer)
        for pinned in ("report_structure_migration_test.py", "order_reconciliation_source_test.py", "gateway_receipt_source_test.py"):
            self.assertIn("self.assertEqual(len(transfer.MIGRATIONS), 29)", text("tests", pinned), pinned)


# ── the client ──

def request_problems(main):
    body = js_function(main, "requestGatewayRetry")
    problems = []
    if body.count("api(") != 1 or 'api("POST", `/studies/${encodeURIComponent(uid)}/gateway-retry`, {})' not in body:
        problems.append("one empty POST")
    guard = "if (button.dataset.request !== token || button.dataset.uid !== uid || button.dataset.key !== key) return;"
    try:
        if not body.index("await api(") < body.index(guard) < body.index("note.textContent = shown.text;"):
            problems.append("written before the stale check")
        if body.index("note.textContent") < body.index("await api("):
            problems.append("text before the answer")
    except ValueError:
        problems.append("guard")
    if "if (!uid || !key || button.hidden || button.dataset.request) return;" not in body:
        problems.append("double request")
    for banned in ("toast(", "localStorage", "sessionStorage", "gatewayReceipt", "innerHTML"):
        if banned in body:
            problems.append(banned)
    return problems


def render_problems(main):
    render = js_function(main, "renderObservation")
    problems = []
    for needle in ('const retryKey = retry?.kind === "now_retry" ? retry.key : "";',
                   'if (retryButton.dataset.uid !== s.uid || retryButton.dataset.key !== retryKey) {',
                   'Object.assign(retryButton.dataset, { uid: s.uid, key: retryKey, request: "", requested: "" });',
                   '|| !(serverMode && !offline && !demoMode && KinAuth.has("technician"));',
                   'if (!retryKey) { retryNote.textContent = retry?.text ?? ""; retryNote.title = retry?.title ?? ""; }'):
        if needle not in render:
            problems.append(needle[:40])
    for banned in ("api(", "fetch(", "toast(", "localStorage", "sessionStorage", "innerHTML"):
        if banned in render:
            problems.append(banned)
    return problems


class ClientPins(unittest.TestCase):
    def test_the_control_is_drawn_only_from_labels_retry_and_the_request_is_separate(self):
        self.assertEqual(render_problems(MAIN), [])
        self.assertEqual(request_problems(MAIN), [])
        mutants = {"no role gate": MAIN.replace(' && KinAuth.has("technician"));', ');'),
                   "no stale check": MAIN.replace("      if (button.dataset.request !== token || button.dataset.uid !== uid || button.dataset.key !== key) return;\n", ""),
                   "a client epoch in the body": MAIN.replace("/gateway-retry`, {});", "/gateway-retry`, { key });"),
                   "a toast": MAIN.replace("      renderObservation();\n    }\n    $(\"#receipt-retry\")", "      renderObservation(); toast(shown.text);\n    }\n    $(\"#receipt-retry\")")}
        for wrong, source in mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, MAIN)
                self.assertNotEqual(render_problems(source) + request_problems(source), [])
        receipt = between(MAIN, '<div id="study-receipt"', "</section>")
        self.assertIn('<button type="button" id="receipt-retry" class="chip" hidden>Now Retry</button> <span id="receipt-retry-note"></span>', receipt)
        self.assertEqual(MAIN.count('$("#receipt-retry").addEventListener("click", requestGatewayRetry);'), 1)
        # U3 client pins keep: the receipt key count and the observation functions stay free of requests.
        # 5 -> 6 at S4-F01V: one `row.gatewayReceipt ?? null` for the Not Observed item (F01VPins below).
        self.assertEqual(MAIN.count("gatewayReceipt"), 6)
        self.assertIn('$("#receipt-gateway").title = labels.gateway.title;\n    }', js_function(MAIN, "renderObservation") + "\n")

    def test_study_observation_inventory_names_exactly_these_additions(self):
        counts = {
            "ids": {key: len(re.findall(r'\bid="' + re.escape(key) + '"', MAIN)) for key in ("receipt-retry", "receipt-retry-note")},
            "functions": {"requestGatewayRetry": len(re.findall(r"^ {4}(?:async )?function requestGatewayRetry\(", MAIN, re.M))},
            "selectors": {key: len(re.findall(r"\$\(\s*[\"']" + re.escape(key) + r"[\"']", MAIN)) for key in ("#receipt-retry", "#receipt-retry-note")},
        }
        # "#receipt-retry-note" 2 -> 1 at S4-F01V: the request writes the note right after the clicked control.
        self.assertEqual(counts, {"ids": {"receipt-retry": 1, "receipt-retry-note": 1}, "functions": {"requestGatewayRetry": 1},
                                  "selectors": {"#receipt-retry": 3, "#receipt-retry-note": 1}})
        observation = text("tests", "study_observation_test.py")
        self.assertIn('    "ids": {"receipt-retry": 1, "receipt-retry-note": 1},\n    "functions": {"requestGatewayRetry": 1},\n'
                      '    "selectors": {"#receipt-retry": 3, "#receipt-retry-note": 1},', observation)

    def test_the_pure_helpers_keep_u1b_and_the_gateway_label(self):
        # R3(c): the U1b needles, BANNED line included, stay byte-identical and exactly once.
        self.assertEqual(ARRIVALS.count("const BANNED=/완료|수신 완료|안정|다 옴|received|complete|stable/i;"), 1)
        gateway = ARRIVALS[ARRIVALS.index("function gatewayLabel("):ARRIVALS.index("\n  }\n", ARRIVALS.index("function gatewayLabel(")) + 4]
        self.assertEqual(sha(gateway), U1B_GATEWAY_LABEL_SHA256, "the Gateway label (phase independent) is untouched")
        self.assertIn("return {assignment:a,observation:o,change,gateway:g.label,needsCheck:reasons.length>0,reasons,retry:gatewayRetryAction(gateway)};", ARRIVALS)
        action = js_function(ARRIVALS, "gatewayRetryAction")
        self.assertLess(action.index("if(!readableReceipt(receipt))return null;"), action.index("if(receipt.phase==='failed')"))
        self.assertIn("return {kind:'now_retry',key:receipt.epoch+'|'+receipt.agentSeq,", action)
        self.assertIn("unsupported:'" + F01 + "'", ARRIVALS)
        self.assertNotIn("||0", ARRIVALS.replace(" ", ""))
        texts = between(ARRIVALS, "const RETRY_TEXT=Object.freeze({", "});")
        self.assertIsNone(re.search(r"완료|수신 완료|안정|다 옴|received|complete|stable|재시도됨|retried", texts, re.I))
        self.assertIn("재시도가 실행됐다는 뜻은 아닙니다", texts)          # R5
        self.assertIn("진행 중인 전송이 있으면 그 전송이 끝난 뒤에 가져갑니다", texts)
        # R3(b): V.receipts keeps its nine entries and the 2*13*9 table; the U4 node case derives by phase substitution.
        observation_vectors = json.loads(text("tests", "study_observation_vectors.json"))
        self.assertEqual(len(observation_vectors["receipts"]), 9)
        node = text("tests", "study_arrivals_test.cjs")
        self.assertIn("assert.equal(rows,2*13*9);", node)
        self.assertIn("const derived=receipt===null?null:{...receipt,phase,errorCode,epoch:EPOCH};", node)
        dom = text("tests", "worklist_arrivals_dom_test.py")
        self.assertIn('RETRY = "async " + extract_function(MAIN, "requestGatewayRetry")', dom)
        for name in ("test_s4u4_now_retry_is_offered_only_for_retry_to_a_technician_online_and_failed_says_f01",
                     "test_s4u4_one_empty_post_nothing_before_the_answer_and_a_stale_answer_is_never_written"):
            self.assertIn("    def " + name + "(self):", dom)

    def test_readme_says_requested_not_retried_and_when(self):
        # R5: latency is the agent's next 30 s poll after any transfer in progress; requested is not retried.
        for needle in ("고정 30초 주기(설정·환경 변수 없음, 시작 30초 뒤 첫 조회)", "전송이 진행 중이면 그 전송이 끝날 때까지 밀리고",
                       "재시도가 실행됐다는 뜻이 아니다", "전달은 한 번만이라고 보장하지\n않으며", "`failed`(F-01"):
            self.assertIn(needle, README)


# ── S4-F01V: the receipt and Now Retry of an own study with no observed image ──

F01V_READ = ("const absentReceipts = notObserved?.length ? await this.prisma.gatewayReceipt.findMany({ where: { studyUid: "
             "{ in: notObserved.map(row => row.uid) }, institutionId: me } }) : [];")
F01V_ATTACH = ("for (const row of notObserved ?? []) { const receipt = absentReceiptByUid.get(row.uid); "
               "if (receipt) Object.assign(row, { gatewayReceipt: projectGatewayReceipt(receipt) }); }")
F01V_COPY = ("rows.push({uid:row.uid,origin:row.origin,createdAt:row.createdAt,"
             "...(row.gatewayReceipt===undefined?{}:{gatewayReceipt:row.gatewayReceipt})});")
F01V_ARROW = "const drawRetry = (s, retry, retryButton, retryNote) => {"
F01V_CHANGED = ["api/src/pacs.service.ts", "worklist-v0/hpacs-lite/study-arrivals.js", "worklist-v0/hpacs-lite/main.html",
                "tests/gateway_retry_source_test.py", "tests/gateway_receipt_source_test.py", "tests/study_identity_source_test.py",
                "tests/study_observation_test.py", "tests/worklist_arrivals_dom_test.py", "tests/gateway_receipt_server_test.cjs",
                "tests/invariants_live.py", "tests/README.md"]


def f01v_problems(service, main, arrivals):
    """The absent item's receipt is read pinned to the caller's institution between the absence list and the access
    re-check, attached only when one exists, copied only when sent, and drawn and requested by the one U4 drawing."""
    problems = []
    listing = between(service, "  async listStudies(c: Caller, query?: any) {", "  private notObserved(")
    order = ["const orderRows = ", "const notObserved = ", F01V_READ, "await this.studyAccess.unchanged(c,access);",
             "const absentReceiptByUid = new Map(absentReceipts.map(r => [r.studyUid, r]));", F01V_ATTACH,
             "const orderReconciliation = "]
    try:
        positions = [listing.index(needle) for needle in order]
        if positions != sorted(positions):
            problems.append("server order")
        # No origin filter, as for rows: origin is not a transport gate.
        if "origin" in listing[positions[1] + len(order[1]):positions[-1]]:
            problems.append("origin filter")
    except ValueError as error:
        problems.append("server missing " + str(error)[:60])
    if listing.count("this.prisma.gatewayReceipt.findMany(") != 2 or listing.count("projectGatewayReceipt(") != 2:
        problems.append("receipt reads")
    for banned in ("gatewayReceipt.create", "gatewayReceipt.update", "gatewayReceipt.upsert", "gatewayRetry", "GatewayRetry"):
        if banned in listing:
            problems.append(banned)
    if F01V_COPY not in js_function(arrivals, "readNotObserved"):
        problems.append("conditional copy")
    render = js_function(main, "renderObservation")
    try:
        arrow = render[render.index(F01V_ARROW):render.index("\n      };\n", render.index(F01V_ARROW))]
        for needle in ('const retryKey = retry?.kind === "now_retry" ? retry.key : "";',
                       'if (retryButton.dataset.uid !== s.uid || retryButton.dataset.key !== retryKey) {',
                       'Object.assign(retryButton.dataset, { uid: s.uid, key: retryKey, request: "", requested: "" });',
                       '|| !(serverMode && !offline && !demoMode && KinAuth.has("technician"));',
                       'retryButton.disabled = !!retryButton.dataset.request;',
                       'if (!retryKey) { retryNote.textContent = retry?.text ?? ""; retryNote.title = retry?.title ?? ""; }'):
            if needle not in arrow:
                problems.append("drawRetry " + needle[:40])
        if render.index(F01V_ARROW) > render.index('$("#not-observed-list")'):
            problems.append("drawRetry after the list")
    except ValueError:
        problems.append("drawRetry")
    for needle, count in (("drawRetry(row, labels.retry, button, note);", 1),
                          ('drawRetry(s, labels.retry, $("#receipt-retry"), $("#receipt-retry-note"));', 1),
                          ("drawRetry(", 2), ('addEventListener("click", requestGatewayRetry);', 1),
                          ("row.gatewayReceipt ?? null", 1), ('$("#not-observed-list")', 1),
                          ("let item = kept.get(row.uid);", 1), ("item.dataset.uid = row.uid;", 1),
                          ('for (const item of kept.values()) item.querySelector("button").dataset.request = "";', 1),
                          ('item.append(document.createElement("span"), " ", control, " ", document.createElement("span"));', 1),
                          ("text.textContent = `${row.uid} · ${row.origin} · ${KinStudyArrivals.formatTime(row.createdAt)}`\n"
                           '            + (gateway === null ? "" : ` · ${labels.gateway.text}`);', 1)):
        if render.count(needle) != count:
            problems.append("render %s" % needle[:40])
    for banned in ("innerHTML", "api(", "fetch(", "id="):
        if banned in render:
            problems.append("render " + banned)
    if main.count('addEventListener("click", requestGatewayRetry);') != 2:
        problems.append("two listeners")
    request = js_function(main, "requestGatewayRetry")
    if "\n    async function requestGatewayRetry(event) {\n" not in main:
        problems.append("request signature")
    for needle in ('const button = event?.currentTarget ?? $("#receipt-retry"), uid = button.dataset.uid, key = button.dataset.key;',
                   "const note = button.nextElementSibling;"):
        if needle not in request:
            problems.append("request " + needle[:40])
    if '$("#receipt-retry-note")' in request:
        problems.append("request reads the panel note")
    # nextElementSibling is the note only while the panel markup keeps it right after the button.
    if '<button type="button" id="receipt-retry" class="chip" hidden>Now Retry</button> <span id="receipt-retry-note"></span>' not in main:
        problems.append("panel markup")
    return problems


class F01VPins(unittest.TestCase):
    def test_s4f01v_absent_receipts_are_own_read_before_the_recheck_and_drawn_by_u4_rules(self):
        self.assertEqual(f01v_problems(SERVICE, MAIN, ARRIVALS), [])
        read_line, unchanged = "    " + F01V_READ + "\n", "    await this.studyAccess.unchanged(c,access);\n"
        service_mutants = {
            "drop institutionId: me": SERVICE.replace("notObserved.map(row => row.uid) }, institutionId: me } })",
                                                      "notObserved.map(row => row.uid) } } })"),
            "read after unchanged": SERVICE.replace(read_line + unchanged, unchanged + read_line),
            "attach unconditionally": SERVICE.replace("if (receipt) Object.assign(row, {", "Object.assign(row, {"),
        }
        for wrong, source in service_mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, SERVICE)
                self.assertNotEqual(f01v_problems(source, MAIN, ARRIVALS), [])
        with self.subTest(wrong="drop the role gate"):
            source = MAIN.replace(' && KinAuth.has("technician"));', ');')
            self.assertNotEqual(source, MAIN)
            self.assertNotEqual(f01v_problems(SERVICE, source, ARRIVALS), [])
        # U1b: the absence list itself is unchanged, three fields and nothing more are pushed.
        self.assertIn("out.push({ uid: s.uid, origin: s.origin, createdAt });", between(SERVICE, "  private notObserved(", "\n  }\n"))
        # The behaviour is proved hosted: compiled server (T-S), DOM with the A-1 node cases (T-D) and live (T-L).
        server = text("tests", "gateway_receipt_server_test.cjs")
        self.assertIn("test('S4-F01V list: ", server)
        dom = text("tests", "worklist_arrivals_dom_test.py")
        for name in ("test_s4f01v_an_absent_item_draws_its_own_receipt_by_the_u4_rules_and_failed_says_f01",
                     "test_s4f01v_absent_now_retry_keeps_its_item_across_polls_and_drops_answers_that_left_the_list"):
            self.assertIn("    def " + name + "(self):", dom)
        for needle in ("isSameNode", "one POST total"):
            self.assertIn(needle, dom)
        live = between(INVARIANTS, "    def test_gateway_announce_is_idempotent_and_preserves_dicom_origin(self) -> None:",
                       "    def test_gateway_stow_requires_announce_and_matching_uid")
        for needle in ("# S4-F01V", '"instance_exceeds_budget"', '"stow_http"', "GATEWAY_RETRY_UNSUPPORTED_F01",
                       'ask("tech")', "self.addCleanup(self.stack.cleanup_fixture, uid)", "self.stack.cleanup_fixture(uid)"):
            self.assertIn(needle, live)
        self.assertEqual(text("tests", "README.md").count("REQ-S4-F01V-ABSENT-RECEIPT"), 1)
        for path in F01V_CHANGED:
            with self.subTest(path=path):
                data = (ROOT / path).read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                self.assertNotIn("\r", data.decode("utf-8").replace("\r\n", "\n"))


class WorkflowPins(unittest.TestCase):
    def test_hosted_steps_select_the_new_tests_with_their_sources(self):
        for needle in ("--run-dir tmp/workspace-ui-ci/gateway-retry-source", "-- python3 -B tests/gateway_retry_source_test.py",
                       "--run-dir tmp/runtime-ci/gateway-retry-server",
                       "--entrypoint node kin-api:ci --test /tests/gateway_retry_server_test.cjs",
                       "tmp/runtime-ci/gateway-retry-server/"):
            self.assertEqual(1, WORKFLOW.count(needle), needle)
        # The agent, DOM and node cases ride on steps that already exist; no new profile, image or runtime (EG-1).
        self.assertEqual(1, WORKFLOW.count("-B tests/worklist_arrivals_dom_test.py"))
        self.assertEqual(1, WORKFLOW.count("node --test tests/study_arrivals_test.cjs"))
        readme = text("tests", "README.md")
        self.assertEqual(readme.count("REQ-S4-U4-NOW-RETRY"), 1)


class Encoding(unittest.TestCase):
    CHANGED = ["gateway/agent/agent.py", "gateway/agent/test_agent.py", "gateway/README.md", "api/src/gateway-retry.ts",
               "api/src/pacs.service.ts", "api/src/pacs.controller.ts", "api/prisma/schema.prisma",
               "api/prisma/migrations/%s/migration.sql" % MIGRATION_NAME, "worklist-v0/hpacs-lite/main.html",
               "worklist-v0/hpacs-lite/study-arrivals.js", "tests/gateway_retry_vectors.json", "tests/gateway_retry_source_test.py",
               "tests/gateway_retry_server_test.cjs", "tests/invariants_live.py", "tests/worklist_arrivals_dom_test.py",
               "tests/study_arrivals_test.cjs", "tests/ops_product_transfer_fixture.py", "tests/README.md"]

    def test_changed_files_are_strict_utf8_without_bom_or_bare_cr(self):
        for path in self.CHANGED:
            with self.subTest(path):
                data = (ROOT / path).read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                self.assertNotIn("\r", data.decode("utf-8").replace("\r\n", "\n"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
