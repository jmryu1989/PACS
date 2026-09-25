"""TEST-S4-U3-GATEWAY-RECEIPT source: stdlib only - no database, network, browser, Node or container.

An independent model of the receipt rule is judged against tests/gateway_receipt_vectors.json, which the
compiled api/src/gateway-receipt.ts also reads in kin-api:ci (tests/gateway_receipt_server_test.cjs).
Named wrong rules must each fail a vector, so the vectors are not decoration. The agent's GatewayError
literals are read by AST (agent.py is never imported: it needs `requests`), and the pins the hosted
runs depend on - route, migration, restore bookkeeping, counts, workflow steps - are checked as text.
"""
import ast
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def text(*parts):
    return ROOT.joinpath(*parts).read_text(encoding="utf-8").replace("\r\n", "\n")


VECTORS = json.loads(text("tests", "gateway_receipt_vectors.json"))
AGENT = text("gateway", "agent", "agent.py")
AGENT_TESTS = text("gateway", "agent", "test_agent.py")
RULE = text("api", "src", "gateway-receipt.ts")
SERVICE = text("api", "src", "pacs.service.ts")
CONTROLLER = text("api", "src", "pacs.controller.ts")
SCHEMA = text("api", "prisma", "schema.prisma")
MIGRATION_NAME = "20260924130000_gateway_receipt"
MIGRATION_PATH = ROOT / "api" / "prisma" / "migrations" / MIGRATION_NAME / "migration.sql"
MIGRATION = text("api", "prisma", "migrations", MIGRATION_NAME, "migration.sql")
MAIN = text("worklist-v0", "hpacs-lite", "main.html")
INVARIANTS = text("tests", "invariants_live.py")
WORKFLOW = text(".github", "workflows", "validate.yml")
OBSERVATION = json.loads(text("tests", "study_observation_vectors.json"))
MAX_SAFE = 2 ** 53 - 1
EPOCH = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
RECEIPT_FIELDS = ("phase", "attempt", "successCount", "localCount", "errorCode")


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


# ── the agent, read by AST ──

def agent_tree():
    return ast.parse(AGENT)


def assigned_literal(tree, name):
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(name)


def error_classes(tree):
    names = {"GatewayError"}
    grew = True
    while grew:
        grew = False
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name not in names and any(
                    isinstance(base, ast.Name) and base.id in names for base in node.bases):
                names.add(node.name)
                grew = True
    return names


def template(call):
    if len(call.args) != 1 or call.keywords:
        return None
    argument = call.args[0]
    if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
        return argument.value
    if isinstance(argument, ast.JoinedStr):
        parts = []
        for value in argument.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                parts.append("{}")
            else:
                return None
        return "".join(parts)
    return None


def constructed(source):
    tree = ast.parse(source)
    names = error_classes(tree)
    return [(node.lineno, template(node)) for node in ast.walk(tree) if isinstance(node, ast.Call) and (
        isinstance(node.func, ast.Name) and node.func.id in names
        or isinstance(node.func, ast.Attribute) and node.func.attr in names)]


AGENT_CODES = assigned_literal(agent_tree(), "GATEWAY_ERROR_CODES")
AGENT_FALLBACK = assigned_literal(agent_tree(), "GATEWAY_ERROR_FALLBACK")
CODES = set(AGENT_CODES.values()) | {AGENT_FALLBACK}


# ── an independent model of the rule, with named wrong rules ──

class Refused(ValueError):
    pass


def is_count(value, wrong=None):
    # JSON has one number type, so the compiled rule sees 3.0 and 3 alike; it never sees a boolean count.
    if isinstance(value, bool):
        return wrong == "booleans are counts" and 0 <= int(value)
    if isinstance(value, float) and not value.is_integer():
        return False
    if not isinstance(value, (int, float)):
        return False
    return value >= 0 and (wrong == "no safe bound" or value <= MAX_SAFE)


def parse(body, wrong=None):
    keys = VECTORS["keys"]
    if not isinstance(body, dict):
        raise Refused("body")
    extra, missing = set(body) - set(keys), set(keys) - set(body)
    if wrong == "time keys tolerated":
        extra = {key for key in extra if not re.search(r"At$", key)}
    if wrong == "institution tolerated":
        extra -= {"institution", "institutionId"}
    if extra and wrong != "extra keys tolerated" or missing and wrong != "missing keys tolerated":
        raise Refused("keys")
    uid = body.get("studyUid")
    if not isinstance(uid, str) or not re.fullmatch(r"[0-9.]+", uid):
        raise Refused("studyUid")
    phase = body.get("phase")
    if not isinstance(phase, str) or phase not in VECTORS["phases"]:
        raise Refused("phase")
    for key in ("attempt", "successCount", "localCount", "seq"):
        if not is_count(body.get(key), wrong):
            raise Refused(key)
    if body["successCount"] > body["localCount"] and wrong != "M above N":
        raise Refused("successCount")
    if phase == "complete" and body["successCount"] != body["localCount"] and wrong != "complete without M == N":
        raise Refused("complete")
    code = body.get("errorCode")
    if phase in VECTORS["errorPhases"]:
        if code is None:
            if wrong != "error phase without code":
                raise Refused("errorCode")
        elif not isinstance(code, str) or code not in CODES and wrong != "free-text code":
            raise Refused("errorCode")
    elif code is not None and wrong != "code in any phase":
        raise Refused("errorCode")
    epoch = body.get("epoch")
    if not isinstance(epoch, str) or not (
            EPOCH.fullmatch(epoch.lower() if wrong == "epoch case-insensitive" else epoch) or wrong == "any epoch"):
        raise Refused("epoch")
    return {key: body.get(key) for key in keys}


def decide(stored, incoming, wrong=None):
    if stored is None:
        return "first", None
    if stored["epoch"] != incoming["epoch"]:
        if wrong == "other epoch is a first association":
            return "first", None
        if wrong == "higher seq of another epoch replaces" and incoming["seq"] > stored["seq"]:
            return "advance", False
        return "epoch", None
    if incoming["seq"] < stored["seq"]:
        return ("advance", False) if wrong == "lower seq overwrites" else ("stale", None)
    if incoming["seq"] == stored["seq"]:
        same = all(stored[key] == incoming[key] for key in RECEIPT_FIELDS)
        if wrong == "same key is always a replay":
            same = True
        if wrong == "same key overwrites" and not same:
            return "advance", False
        return ("duplicate", None) if same else ("conflict", None)
    if wrong == "every advance audited":
        return "advance", True
    if wrong == "only complete is a transition":
        return "advance", incoming["phase"] != stored["phase"] and incoming["phase"] == "complete"
    if wrong == "a terminal phase is always a transition":
        return "advance", incoming["phase"] in ("complete", "failed")
    return "advance", incoming["phase"] != stored["phase"] and incoming["phase"] in ("complete", "failed")


def parse_body(case):
    if "body" in case:
        return case["body"]
    body = {**VECTORS["valid"], **case.get("set", {})}
    for key in case.get("drop", []):
        del body[key]
    return body


def parse_outcome(case, wrong=None):
    try:
        parse(parse_body(case), wrong)
        return "ok"
    except Refused as error:
        return str(error)


def decide_outcome(case, wrong=None):
    stored = None if "stored" in case and case["stored"] is None else {**VECTORS["stored"], **case.get("storedSet", {})}
    incoming = {**VECTORS["valid"], **case["next"]}
    kind, transition = decide(stored, incoming, wrong)
    return (kind, transition) if kind == "advance" else (kind, None)


def expected_decision(case):
    return case["kind"], case.get("transition") if case["kind"] == "advance" else None


WRONG_PARSE = ["extra keys tolerated", "missing keys tolerated", "time keys tolerated", "institution tolerated",
               "booleans are counts", "no safe bound", "M above N", "complete without M == N", "free-text code",
               "error phase without code", "code in any phase", "epoch case-insensitive", "any epoch"]
WRONG_DECIDE = ["other epoch is a first association", "higher seq of another epoch replaces", "lower seq overwrites",
                "same key is always a replay", "same key overwrites", "every advance audited",
                "only complete is a transition", "a terminal phase is always a transition"]


class ModelVectors(unittest.TestCase):
    def test_every_parse_vector(self):
        for case in VECTORS["parse"]:
            with self.subTest(case["id"]):
                self.assertEqual(parse_outcome(case), "ok" if case.get("ok") else case["error"])
                self.assertNotEqual(case.get("ok"), "error" in case, "a vector names exactly one outcome")

    def test_every_decide_vector(self):
        for case in VECTORS["decide"]:
            with self.subTest(case["id"]):
                self.assertEqual(decide_outcome(case), expected_decision(case))

    def test_each_named_wrong_rule_fails_a_vector(self):
        for wrong in WRONG_PARSE:
            with self.subTest(wrong=wrong):
                self.assertTrue([c["id"] for c in VECTORS["parse"]
                                 if parse_outcome(c, wrong) != ("ok" if c.get("ok") else c["error"])])
        for wrong in WRONG_DECIDE:
            with self.subTest(wrong=wrong):
                self.assertTrue([c["id"] for c in VECTORS["decide"] if decide_outcome(c, wrong) != expected_decision(c)])

    def test_vectors_cover_the_contract_cases(self):
        ids = " ".join(case["id"] for case in VECTORS["parse"] + VECTORS["decide"])
        for needle in ("reportedAt", "institution", "free reason", "prototype", "another epoch with a higher seq",
                       "lower seq cannot roll", "same epoch, seq and body", "reopened after complete"):
            self.assertIn(needle, ids)
        self.assertEqual(VECTORS["keys"], ["studyUid", "phase", "attempt", "successCount", "localCount", "errorCode",
                                           "epoch", "seq"])
        self.assertEqual(VECTORS["maxSafe"], MAX_SAFE)
        valid = VECTORS["valid"]
        self.assertEqual(parse(valid), valid)
        self.assertEqual(VECTORS["stored"], {key: valid[key] for key in ("epoch", "seq", *RECEIPT_FIELDS)})


class AgentPins(unittest.TestCase):
    def test_every_gateway_error_literal_has_a_code_and_the_table_has_no_stale_entry(self):
        found = constructed(AGENT)
        self.assertEqual([(line, t) for line, t in found if t not in AGENT_CODES], [])
        self.assertEqual(set(AGENT_CODES), {t for _line, t in found})
        self.assertEqual(AGENT_FALLBACK, "other")
        for code in CODES:
            self.assertRegex(code, r"^[a-z][a-z_]{0,39}$")

    def test_the_enumeration_catches_an_unmapped_or_non_literal_error(self):
        for added in ('raise GatewayError("new failure nobody mapped")', 'raise PermanentGatewayError(f"x {y}")',
                      'raise GatewayError(reason)', 'raise GatewayError("a %s" % y)', 'e = GatewayError("later")'):
            with self.subTest(added=added):
                probe = AGENT + "\n\ndef _probe(y, reason):\n    " + added + "\n"
                self.assertTrue([t for _line, t in constructed(probe) if t not in AGENT_CODES])

    def test_templates_are_unambiguous(self):
        patterns = {t: re.compile(r"\S+".join(re.escape(part) for part in t.split("{}"))) for t in AGENT_CODES}
        for t in AGENT_CODES:
            sample = t.replace("{}", "X9")
            self.assertEqual([other for other, p in patterns.items() if p.fullmatch(sample)], [t])
        # The agent builds its patterns exactly this way.
        self.assertIn('(re.compile(r"\\S+".join(re.escape(part) for part in template.split("{}"))), code)', AGENT)

    def test_the_receipt_body_is_the_closed_key_set_without_time_institution_or_text(self):
        receipt = between(AGENT, "    def receipt(self, uid: str)", "    def unreported(")
        keys = re.findall(r'^\s+"(\w+)":', receipt, re.M)
        self.assertEqual(keys, VECTORS["keys"])
        for banned in ("last_error", "updated_at", "time.", "institution", "reason"):
            self.assertNotIn(banned, receipt.split('"""', 2)[-1], banned)
        self.assertIn('if not row or not row["announced"] or row["local_count"] is None:', receipt)
        self.assertIn('"errorCode": (row["error_code"] or GATEWAY_ERROR_FALLBACK) if phase in ERROR_PHASES else None,', receipt)
        self.assertIn('return self.request("POST", "/api/gateway/receipt", json=body)', AGENT)

    def test_seq_moves_in_the_same_statement_as_every_receipt_field(self):
        columns = {"phase", "attempt", "local_count", "success_count", "error_code"}
        statements = [node.value for node in ast.walk(agent_tree())
                      if isinstance(node, ast.Constant) and isinstance(node.value, str) and "UPDATE" in node.value]
        touched = 0
        for sql in statements:
            assigned = set(re.findall(r"\b(\w+)\s*=", sql.split("WHERE")[0]))
            if assigned & columns:
                touched += 1
                self.assertIn("seq=seq+1", sql.replace(" ", ""), sql)
        # record_changes (reopen), phase, announced, counts, complete, pending_now, fail, retry. add_successes and
        # reported write no receipt field and so allocate no seq.
        self.assertEqual(touched, 8)

    def test_receipt_delivery_never_reaches_the_transfer(self):
        report = between(AGENT, "    def report(self, uid: str) -> bool:", "    def flush_receipts(")
        self.assertIn("except Exception as error:", report)
        self.assertIn("RECEIPT_FINAL_REFUSALS = (400, 404, 409)", AGENT)
        process = between(AGENT, "    def process(self, row: sqlite3.Row) -> None:", "    def run(self)")
        self.assertEqual(process.count("self.report(uid)"), 2)
        self.assertLess(process.index("self.cloud.announce("), process.index("self.queue.announced("))
        self.assertLess(process.index("self.queue.announced("), process.index("self.report(uid)"))
        run = between(AGENT, "    def run(self) -> None:", "def status(")
        self.assertLess(run.index("self.flush_receipts()"), run.index("self.poll_changes()"))
        self.assertIn("self.queue.fail(uid, reason, error_code(error))", run)
        self.assertIn("self.queue.retry(\n                            uid, reason, self.config.backoff_base, "
                      "self.config.backoff_max, error_code(error),", run)

    def test_the_invariants_agent_count_is_the_suite_as_authored(self):
        tree = ast.parse(AGENT_TESTS)
        count = sum(1 for node in tree.body if isinstance(node, ast.ClassDef)
                    and any(isinstance(b, ast.Attribute) and b.attr == "TestCase" for b in node.bases)
                    for item in node.body if isinstance(item, ast.FunctionDef) and item.name.startswith("test"))
        method = between(INVARIANTS, "    def test_gateway_agent_queue_and_batch_contract(self) -> None:",
                         "    def test_production_gateway_contract_is_declared")
        self.assertEqual(re.findall(r'self\.assertIn\("Ran (\d+) tests"', method), [str(count)])
        # 18 -> 25: S4-U4 RetryNowTests (seven cases); tests/gateway_retry_source_test.py pins that class by name.
        self.assertEqual(count, 25)


class ServerPins(unittest.TestCase):
    def ts_list(self, name):
        block = re.search(r"export const " + name + r"(?:: [^=]+)? = \[(.*?)\]", RULE, re.S).group(1)
        return re.findall(r"'([^']*)'", block)

    def test_the_rule_constants_are_the_vectors_and_the_agent_table(self):
        self.assertEqual(self.ts_list("GATEWAY_RECEIPT_KEYS"), VECTORS["keys"])
        self.assertEqual(self.ts_list("GATEWAY_PHASES"), VECTORS["phases"])
        self.assertEqual(self.ts_list("GATEWAY_ERROR_PHASES"), VECTORS["errorPhases"])
        codes = self.ts_list("GATEWAY_ERROR_CODES")
        self.assertEqual(len(codes), len(set(codes)))
        self.assertEqual(set(codes), CODES, "the server enum must be exactly the agent table plus other")
        self.assertIn("export const GATEWAY_EPOCH_INCIDENT_WINDOW_MS = 60 * 60 * 1000;", RULE)
        self.assertEqual(VECTORS["incidentWindowMs"], 60 * 60 * 1000)
        self.assertIn("const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;", RULE)
        # The agent's phases are the same six, in the same order.
        self.assertEqual(list(assigned_literal(agent_tree(), "MANAGED_PHASES")), VECTORS["phases"])
        self.assertEqual(list(assigned_literal(agent_tree(), "ERROR_PHASES")), VECTORS["errorPhases"])

    def test_the_rule_module_is_pure(self):
        for banned in ("import ", "require(", "prisma", "process.env", "Date.now", "new Date()", "fetch("):
            self.assertNotIn(banned, RULE, banned)
        decide = between(RULE, "export function decideGatewayReceipt(", "\n}\n")
        self.assertLess(decide.index("if (!stored) return { kind: 'first' };"),
                        decide.index("if (stored.epoch !== next.epoch) return { kind: 'epoch' };"))
        self.assertLess(decide.index("if (stored.epoch !== next.epoch) return { kind: 'epoch' };"),
                        decide.index("if (next.seq < stored.seq) return { kind: 'stale' };"))

    def test_the_route_decides_ownership_first_and_writes_only_forward(self):
        method = between(SERVICE, "  async gatewayReceipt(body: unknown, c: Caller) {", "\n  }\n")
        order = ["needExact(c, 'gateway', '전송 영수증');", "const me = inst(c);", "parseGatewayReceipt(body)",
                 "this.prisma.$transaction(", "pg_advisory_xact_lock(hashtextextended(${'kin.gateway-receipt:' + uid}, 0))",
                 "tx.studyState.findUnique({ where: { uid }, select: { institutionId: true } })",
                 "if (!study || study.institutionId !== me) return { kind: 'absent' as const };",
                 "tx.gatewayReceipt.findUnique(", "decideGatewayReceipt("]
        positions = [method.index(needle) for needle in order]
        self.assertEqual(positions, sorted(positions))
        # One 404 for absent and foreign; the announce ownership 409 is not reused.
        self.assertEqual(method.count("NotFoundException("), 1)
        self.assertIn("throw new NotFoundException({ code: 'GATEWAY_RECEIPT_STUDY_NOT_FOUND' });", method)
        self.assertNotIn("STUDY_OWNERSHIP_CONFLICT", method)
        self.assertEqual(method.count("ConflictException("), 2)
        # The body is handed to the parser and to nothing else: no institution or time is read from it.
        self.assertEqual(re.findall(r"\bbody\b", method), ["body", "body"])
        self.assertIn("receivedAt: new Date() };", method)
        self.assertEqual(method.count("tx.gatewayReceipt.create("), 1)
        self.assertEqual(method.count("tx.gatewayReceipt.update("), 1)
        for banned in ("upsert", ".delete", "deleteMany", "updateMany"):
            self.assertNotIn(banned, method)
        self.assertEqual(sorted(set(re.findall(r"'(gateway\.receipt\.[a-z_]+)'", method))),
                         ["gateway.receipt.epoch_unrecognised", "gateway.receipt.first", "gateway.receipt.transition"])
        self.assertIn("if (decision.transition)", method)
        self.assertIn("where: { action: 'gateway.receipt.epoch_unrecognised', target: uid, at: { gte: since } }", method)

    def test_the_list_carries_only_own_receipts_and_bootstrap_none(self):
        listing = between(SERVICE, "  async listStudies(c: Caller, query?: any) {", "  private notObserved(")
        self.assertIn("const receipts = await this.prisma.gatewayReceipt.findMany({ where: { studyUid: { in: pageUids }, institutionId: me } });", listing)
        self.assertIn("gatewayReceipt: s.institutionId === me ? projectGatewayReceipt(receiptByUid.get(uid)) : null,", listing)
        self.assertLess(listing.index("this.prisma.gatewayReceipt.findMany("), listing.index("await this.studyAccess.unchanged(c,access);"))
        # 1 -> 2 at S4-F01V: the same projection for an absent own study (tests/gateway_retry_source_test.py pins it).
        self.assertEqual(SERVICE.count("projectGatewayReceipt("), 2)
        for owner in ("  async bootstrap(c: Caller, query?: any) {", "function toClient("):
            self.assertNotIn("gatewayReceipt", between(SERVICE, owner, "\n  }\n" if owner.startswith("  async") else "\n}\n"))
        project = between(RULE, "export function projectGatewayReceipt(row: any) {", "\n}\n")
        keys = re.findall(r"(\w+):", between(project, "return {", "};"))
        self.assertEqual(sorted(set(keys)), sorted(OBSERVATION["receipts"]["sending_3_of_12"]),
                         "the projection is the shape S4-U1b's labels already read")

    def test_the_controller_route(self):
        self.assertIn("  @Post('gateway/receipt')\n  @HttpCode(200)\n  gatewayReceipt(@Body() body: any, @Req() req: any) {\n"
                      "    return this.svc.gatewayReceipt(body, caller(req));", CONTROLLER)
        self.assertIn('    ("POST", "gateway/receipt"): Route(Kind.TENANT),', INVARIANTS)
        self.assertIn("    def test_s4u3_gateway_receipt_route_rules(self) -> None:", INVARIANTS)


class ClientPins(unittest.TestCase):
    def test_main_wires_the_server_receipt_through_the_readable_observation_only(self):
        # fromApi (2), applyObservation (2), renderObservation (2: the row and, since S4-F01V, the Not Observed item)
        self.assertEqual(MAIN.count("gatewayReceipt"), 6)
        self.assertIn("        gatewayReceipt: s.gatewayReceipt ?? null,\n      });\n    }", MAIN)
        apply = js_function(MAIN, "applyObservation")
        guarded = apply.index("if (next.ok) {")
        self.assertLess(apply.index("studyObservationModel = next.ok ? next.model"), guarded)
        self.assertLess(guarded, apply.index("row.gatewayReceipt ?? null"))
        self.assertLess(apply.index("study.gatewayReceipt = receipts.get(study.uid);"), apply.index("renderObservation();"))
        render = js_function(MAIN, "renderObservation")
        self.assertIn("gateway: s.gatewayReceipt ?? null });", render)
        for name in ("applyObservation", "markObservationUnavailable", "renderObservation"):
            for banned in ("api(", "fetch(", "localStorage", "toast("):
                self.assertNotIn(banned, js_function(MAIN, name), name)
        self.assertNotIn("gatewayReceipt", js_function(MAIN, "markObservationUnavailable"))


LEGACY_PHASE_CHECK = """CHECK ("phase" IN ('pending','announcing','sending','retry','failed','complete'))"""
LEGACY_ERROR_PHASES = """("phase" IN ('retry','failed'))"""


def closed_check_problems(source):
    """Restore run 35973195956 refused 3955e38: `"phase" IN (...)` on VARCHAR(16) is stored as
    ARRAY['x'::character varying]::text[] and pg_restore re-reads it as ARRAY['x'::character varying::text],
    the drift the hosted findings-migration probe prints for its legacy form. The explicit-text form is the
    one that probe shows unchanged; both closed sets must stay exactly the rule's."""
    body = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("--"))
    problems = []
    if re.search(r'"\w+"\s+IN\s*\(', body):
        problems.append("IN-list")
    if "character varying" in body:
        problems.append("varchar operand")
    for name, end, members in (("GatewayReceipt_phase_check", 'CONSTRAINT "GatewayReceipt_counts_check"', VECTORS["phases"]),
                               ("GatewayReceipt_error_check", "\n);", VECTORS["errorPhases"])):
        check = between(body, 'CONSTRAINT "' + name + '" CHECK (', end)
        found = re.findall(r'"phase"::text = ANY \(ARRAY\[([^\]]*)\]\)', check)
        if found != [",".join("'" + member + "'::text" for member in members)]:
            problems.append(name)
    return problems


class MigrationPins(unittest.TestCase):
    def test_the_closed_checks_are_the_restore_stable_form_of_the_rule_sets(self):
        self.assertEqual(closed_check_problems(MIGRATION), [])
        self.assertEqual(VECTORS["phases"], ["pending", "announcing", "sending", "retry", "failed", "complete"])
        self.assertEqual(VECTORS["errorPhases"], ["retry", "failed"])
        phase = """CHECK ("phase"::text = ANY (ARRAY['pending'::text,'announcing'::text,'sending'::text,'retry'::text,'failed'::text,'complete'::text]))"""
        error = """("phase"::text = ANY (ARRAY['retry'::text,'failed'::text]))"""
        mutants = {"3955e38 phase IN-list": MIGRATION.replace(phase, LEGACY_PHASE_CHECK),
                   "3955e38 error IN-list": MIGRATION.replace(error, LEGACY_ERROR_PHASES),
                   "a phase dropped": MIGRATION.replace(",'complete'::text]", "]"),
                   "an error phase added": MIGRATION.replace("'failed'::text]))\n", "'failed'::text,'pending'::text]))\n"),
                   "a varchar operand": MIGRATION.replace("ARRAY['retry'::text,", "ARRAY['retry'::character varying,")}
        for wrong, source in mutants.items():
            with self.subTest(wrong=wrong):
                self.assertNotEqual(source, MIGRATION)
                self.assertNotEqual(closed_check_problems(source), [])

    def test_the_migration_is_one_additive_table(self):
        self.assertTrue(MIGRATION.startswith("--"))
        body = "\n".join(line for line in MIGRATION.splitlines() if not line.startswith("--"))
        self.assertEqual(body.count("CREATE TABLE"), 1)
        self.assertIn('CREATE TABLE "GatewayReceipt" (', body)
        for forbidden in ("ALTER TABLE", "DROP", "UPDATE ", "DELETE ", "INSERT", "TRUNCATE", "DEFAULT", "CREATE INDEX"):
            self.assertNotIn(forbidden, body.replace("ON DELETE CASCADE", "").replace("ON UPDATE RESTRICT", ""), forbidden)
        for needle in ('"studyUid" TEXT NOT NULL', '"institutionId" VARCHAR(256) NOT NULL', '"epoch" UUID NOT NULL',
                       '"seq" BIGINT NOT NULL', '"phase" VARCHAR(16) NOT NULL', '"attempt" BIGINT NOT NULL',
                       '"successCount" BIGINT NOT NULL', '"localCount" BIGINT NOT NULL', '"errorCode" VARCHAR(40),',
                       '"receivedAt" TIMESTAMP(3) NOT NULL', 'CONSTRAINT "GatewayReceipt_pkey" PRIMARY KEY ("studyUid")',
                       'CONSTRAINT "GatewayReceipt_studyUid_fkey" FOREIGN KEY ("studyUid") REFERENCES "StudyState"("uid") ON DELETE CASCADE ON UPDATE RESTRICT',
                       """CHECK ("phase"::text = ANY (ARRAY['pending'::text,'announcing'::text,'sending'::text,'retry'::text,'failed'::text,'complete'::text]))""",
                       '"successCount" <= "localCount"', "9007199254740991", """("phase" <> 'complete' OR "successCount" = "localCount")""",
                       """("errorCode" IS NOT NULL) = ("phase"::text = ANY (ARRAY['retry'::text,'failed'::text]))"""):
            self.assertIn(needle, MIGRATION)
        self.assertIn("BEGIN;", body)
        self.assertIn("COMMIT;", body)
        self.assertNotIn(b"\r", MIGRATION_PATH.read_bytes())

    def test_the_schema_model_matches_the_table(self):
        block = re.search(r"model GatewayReceipt \{(.*?)\n\}", SCHEMA, re.S).group(1)
        for needle in ("studyUid      String   @id", "institutionId String   @db.VarChar(256)", "epoch         String   @db.Uuid",
                       "seq           BigInt", "phase         String   @db.VarChar(16)", "attempt       BigInt",
                       "successCount  BigInt", "localCount    BigInt", "errorCode     String?  @db.VarChar(40)",
                       "receivedAt    DateTime",
                       "study StudyState @relation(fields: [studyUid], references: [uid], onDelete: Cascade, onUpdate: Restrict)"):
            self.assertIn(needle, block)
        self.assertNotIn("@default", block)
        self.assertNotIn("@updatedAt", block)
        state = re.search(r"model StudyState \{(.*?)\n\}", SCHEMA, re.S).group(1)
        self.assertIn("\n  gatewayReceipt GatewayReceipt?\n", state)

    def test_image_and_restore_bookkeeping_name_the_migration_and_the_table(self):
        names = sorted(p.name for p in (ROOT / "api" / "prisma" / "migrations").iterdir() if p.is_dir())
        # S4-U4's gateway-retry-request migration is the one directly after this one (its FK needs this table);
        # the order is pinned rather than "last", so a later additive migration moves only the counts.
        self.assertEqual(names[names.index(MIGRATION_NAME) + 1], "20260924140000_gateway_retry_request")
        self.assertIn("'" + MIGRATION_NAME + "'", text("tests", "production_image_test.py"))
        fixture = text("tests", "ops_product_transfer_fixture.py")
        self.assertIn("'api/prisma/migrations/" + MIGRATION_NAME + "/migration.sql',", fixture)
        self.assertEqual(fixture.count("'GatewayReceipt'"), 3)   # TABLES, the seeding order and the synthetic row
        self.assertIn("rows['GatewayReceipt'] = [", fixture)
        transfer = text("tests", "ops_product_transfer_test.py")
        # 28 -> 29 migrations and 38 -> 39 tables: S4-U4 added GatewayRetryRequest (tests/gateway_retry_source_test.py).
        self.assertIn("self.assertEqual(len(transfer.MIGRATIONS), 29)", transfer)
        self.assertIn("self.assertEqual(len(transfer.TABLES), 39)", transfer)
        for pinned in ("report_structure_migration_test.py", "order_reconciliation_source_test.py"):
            self.assertIn("self.assertEqual(len(transfer.MIGRATIONS), 29)", text("tests", pinned), pinned)


class WorkflowPins(unittest.TestCase):
    def test_hosted_steps_select_the_new_tests_with_their_sources(self):
        for needle in ("--run-dir tmp/workspace-ui-ci/gateway-receipt-source", "-- python3 -B tests/gateway_receipt_source_test.py",
                       "--run-dir tmp/runtime-ci/gateway-receipt-server",
                       "--entrypoint node kin-api:ci --test /tests/gateway_receipt_server_test.cjs",
                       "tmp/runtime-ci/gateway-receipt-server/"):
            self.assertEqual(1, WORKFLOW.count(needle), needle)
        self.assertEqual(1, WORKFLOW.count("-r gateway/agent/requirements.txt numpy"), "the invariants interpreter keeps the agent dependency")


class Encoding(unittest.TestCase):
    CHANGED = ["gateway/agent/agent.py", "gateway/agent/test_agent.py", "api/src/gateway-receipt.ts",
               "api/src/pacs.service.ts", "api/src/pacs.controller.ts", "api/prisma/schema.prisma",
               "api/prisma/migrations/%s/migration.sql" % MIGRATION_NAME, "worklist-v0/hpacs-lite/main.html",
               "tests/gateway_receipt_vectors.json", "tests/gateway_receipt_source_test.py",
               "tests/gateway_receipt_server_test.cjs", "tests/invariants_live.py", "tests/worklist_arrivals_dom_test.py"]

    def test_changed_files_are_strict_utf8_without_bom_or_bare_cr(self):
        for path in self.CHANGED:
            with self.subTest(path):
                data = (ROOT / path).read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                self.assertNotIn("\r", data.decode("utf-8").replace("\r\n", "\n"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
