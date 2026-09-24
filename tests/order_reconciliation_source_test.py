# coding: utf-8
"""TEST-S4-U2-ORDER-RECONCILIATION (stdlib only; no browser, container, database or network).

1. An independent model of the order-side rule and of the client display runs the shared vectors
   (tests/order_reconciliation_vectors.json). The shipped TS rule and JS module are judged against the
   SAME file by tests/order_reconciliation_server_test.cjs and tests/order_reconciliation_test.cjs.
2. Vector adequacy: named wrong rules (cross-tenant pairing, tele as own, blank==blank, restricted
   callers seeing unlinked orders, failure clearing the last answer ...) must each fail a vector. A
   vector file that no wrong rule can fail proves nothing about the implementations it judges.
3. Source pins: the server path (tenant filter in the query, order side read before the access
   re-check, accession only from the server-read tag), the additive migration and its image/restore
   bookkeeping, the page hand-off, and the main.html wiring (no localStorage seed, no patient fields).
What this file cannot see: whether the compiled server, the browser and PostgreSQL behave as the
source says. That is the hosted evidence named in the unit report.
"""
import json
import re
import sys
import unittest
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "tests" / "order_reconciliation_vectors.json").read_text(encoding="utf-8"))
OBSERVATION_VECTORS = json.loads((ROOT / "tests" / "study_observation_vectors.json").read_text(encoding="utf-8"))


def text(*parts):
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8").replace("\r\n", "\n")


SERVICE = text("api", "src", "pacs.service.ts")
RULE = text("api", "src", "order-reconciliation.ts")
ORTHANC = text("api", "src", "orthanc.service.ts")
SEED = text("api", "src", "seed.ts")
SCHEMA = text("api", "prisma", "schema.prisma")
MIGRATION_NAME = "20260924120000_order_accession"
MIGRATION = text("api", "prisma", "migrations", MIGRATION_NAME, "migration.sql")
CLIENT = text("worklist-v0", "hpacs-lite", "order-reconciliation.js")
PAGES = text("worklist-v0", "hpacs-lite", "study-pages.js")
MAIN = text("worklist-v0", "hpacs-lite", "main.html")
HARNESS = text("tests", "worklist_arrivals_dom_test.py")
WORKFLOW = text(".github", "workflows", "validate.yml")


# ── 1. Independent model ──────────────────────────────────────────────────────────────────────────

def relation(order, study, bug=None):
    if bug == "no_trim":
        left = order if isinstance(order, str) else ""
        right = study if isinstance(study, str) else ""
    else:
        left = order.strip() if isinstance(order, str) else ""
        right = study.strip() if isinstance(study, str) else ""
    if bug == "case_insensitive":
        left, right = left.lower(), right.lower()
    if bug == "blank_equal":
        return "match" if left == right else ("not_comparable" if not left or not right else "mismatch")
    if not left or not right:
        return "not_comparable"
    return "match" if left == right else "mismatch"


def reconcile(case, bug=None):
    me, restricted, permitted = case["me"], case["restricted"], case["permitted"]

    def allowed(uid):
        if bug == "restricted_ignores_permission" or not restricted:
            return True
        return uid in permitted

    def own_row(s):
        if bug == "no_study_tenant":
            return True
        if bug == "tele_as_own":
            return s["institutionId"] == me or s.get("teleInstitutionId") == me
        return s["institutionId"] == me

    own = {s["uid"]: s for s in case["links"] if own_row(s)}
    observed = case["observed"]
    open_studies = []
    if not restricted or bug == "restricted_lists_unlinked":
        for uid, s in own.items():
            if bug != "candidates_include_unobserved" and uid not in observed:
                continue
            if bug != "candidates_include_linked" and (s["matched"] != "U" or s["orderOid"] is not None):
                continue
            if not allowed(uid):
                continue
            open_studies.append((uid, observed.get(uid, "")))
    out = []
    for o in case["orders"]:
        if bug != "no_order_tenant" and o["institutionId"] != me:
            continue
        if o["matched"] == "U" and o["studyUid"] is None:
            if restricted and bug != "restricted_lists_unlinked":
                continue
            present = isinstance(o["accession"], str) and o["accession"].strip() != ""
            if bug == "blank_equal":
                present = True
            candidates = sorted(uid for uid, acc in open_studies if relation(o["accession"], acc, bug) == "match") if present else []
            out.append({"oid": o["oid"], "link": "unlinked", "accession": "present" if present else "absent", "candidates": candidates})
            continue
        s = own.get(o["studyUid"]) if o["studyUid"] is not None else None
        if not s:
            continue
        if bug != "no_backpointer" and (s["matched"] != "M" or s["orderOid"] != o["oid"]):
            continue
        if not allowed(s["uid"]):
            continue
        seen = s["uid"] in observed or bug == "unobserved_as_observed"
        out.append({"oid": o["oid"], "link": "observed" if seen else "not_observed", "studyUid": s["uid"]})
    return sorted(out, key=lambda row: row["oid"])


UID = re.compile(r"^\d+(?:\.\d+)+$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def read(value, bug=None):
    if value is None:
        return ("unknown", None)
    if not isinstance(value, dict):
        return ("error", None)
    if bug != "extra_keys_allowed" and sorted(value) != ["orders", "source"]:
        return ("error", None)
    if (bug != "other_source_allowed" and value.get("source") != VECTORS["source"]) or not isinstance(value.get("orders"), list):
        return ("error", None)
    seen, orders = set(), []
    for row in value["orders"]:
        oid = row.get("oid") if isinstance(row, dict) else None
        if not isinstance(oid, str) or not oid or len(oid) > 64 or CONTROL.search(oid) or oid in seen:
            return ("error", None)
        link = row.get("link")
        if link in ("observed", "not_observed"):
            if (bug != "extra_keys_allowed" and sorted(row) != ["link", "oid", "studyUid"]) or not isinstance(row.get("studyUid"), str) or not UID.match(row["studyUid"]):
                return ("error", None)
            orders.append({"oid": oid, "link": link, "studyUid": row["studyUid"]})
        elif link == "unlinked":
            if (bug != "extra_keys_allowed" and sorted(row) != ["accession", "candidates", "link", "oid"]) or row.get("accession") not in ("present", "absent") \
                    or not isinstance(row.get("candidates"), list):
                return ("error", None)
            if bug != "absent_candidates_allowed" and row["accession"] == "absent" and row["candidates"]:
                return ("error", None)
            if any(not isinstance(uid, str) or len(uid) > 64 or not UID.match(uid) for uid in row["candidates"]) or len(set(row["candidates"])) != len(row["candidates"]):
                return ("error", None)
            orders.append({"oid": oid, "link": "unlinked", "accession": row["accession"], "candidates": list(row["candidates"])})
        else:
            return ("error", None)
        seen.add(oid)
    return ("ok", orders)


PHRASE = VECTORS["phrases"]["orderWithoutImages"]
UNAVAILABLE = VECTORS["phrases"]["observationUnavailable"]
MARKER = VECTORS["marker"]


def row_label(row, bug=None):
    missing = "" if bug == "not_observed_without_phrase" else " · " + PHRASE
    if row["link"] == "observed":
        return "observed", row["oid"] + " · Linked · Observed"
    if row["link"] == "not_observed":
        return "not_observed", row["oid"] + " · Linked" + missing
    if row["accession"] == "absent":
        return "unlinked_no_accession", row["oid"] + " · Unlinked · " + PHRASE + " · No Accession"
    if not row["candidates"]:
        return "unlinked_no_match", row["oid"] + " · Unlinked · " + PHRASE + " · No Accession Match"
    return "unlinked_match", row["oid"] + " · Unlinked · Accession Match: " + ", ".join(row["candidates"])


def start():
    return {"owner": None, "observedAt": None, "available": None, "orders": None}


def valid_time(value):
    return isinstance(value, str) and len(value) <= 40 and bool(re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$", value))


def failed(model, bug=None):
    if bug == "failure_clears_rows":
        return {**model, "available": False, "orders": None}
    return {**model, "available": False}


def succeeded(model, result, bug=None):
    owner = result.get("owner")
    observation = result.get("observation")
    if not isinstance(owner, list) or not isinstance(observation, dict) or not valid_time(observation.get("observedAt")):
        return failed(model, bug)
    value = observation.get("orderReconciliation")
    if bug == "absent_answer_as_empty" and "orderReconciliation" not in observation:
        value = {"source": VECTORS["source"], "orders": []}
    state, orders = read(value, bug)
    if state == "error":
        return failed(model, bug)
    return {"owner": json.dumps(owner), "observedAt": observation["observedAt"], "available": True, "orders": orders}


def summary(model, bug=None):
    head = "Order Reconciliation" + ("" if bug == "summary_without_marker" else " · " + MARKER)
    if model["available"] is None:
        return {"key": "not_attempted", "hidden": True, "text": "", "rows": []}
    labels = [row_label(row, bug) for row in (model["orders"] or [])]
    rows = [label for _, label in labels]
    missing = sum(key in ("not_observed", "unlinked_no_accession", "unlinked_no_match") for key, _ in labels)
    if model["available"] is False:
        return {"key": "observation_unavailable", "hidden": False, "rows": rows,
                "text": head + " · " + UNAVAILABLE + (" · 마지막 관측 %s 기준" % model["observedAt"] if model["observedAt"] else "")}
    if model["orders"] is None:
        return {"key": "unknown", "hidden": False, "rows": [], "text": head + " · Unknown · Observed " + model["observedAt"]}
    return {"key": "observed", "hidden": False, "rows": rows,
            "text": head + " · Orders %d" % len(rows) + (" · %s %d" % (PHRASE, missing) if missing else "") + " · Observed " + model["observedAt"]}


READ_BY_NAME = {case["name"]: case["value"] for case in VECTORS["read"]}


def resolve(result):
    result = json.loads(json.dumps(result))
    observation = result.get("observation")
    if isinstance(observation, dict) and isinstance(observation.get("orderReconciliation"), str) \
            and observation["orderReconciliation"].startswith("@"):
        observation["orderReconciliation"] = READ_BY_NAME[observation["orderReconciliation"][1:]]
    return result


def run_transition(case, bug=None):
    model = start()
    for step in case["steps"]:
        model = succeeded(model, resolve(step["result"]), bug) if step["op"] == "succeeded" else failed(model, bug)
    return summary(model, bug)


def failures(bug=None):
    """Every vector a (possibly wrong) model disagrees with, by name."""
    out = []
    for case in VECTORS["accession"]:
        if relation(case["order"], case["study"], bug) != case["expect"]:
            out.append("accession:" + case["name"])
    for case in VECTORS["reconcile"]:
        if reconcile(case, bug) != case["expect"]:
            out.append("reconcile:" + case["name"])
    for case in VECTORS["read"]:
        if read(case["value"], bug)[0] != case["expect"]:
            out.append("read:" + case["name"])
    for case in VECTORS["labels"]:
        if row_label(case["row"], bug) != (case["key"], case["text"]):
            out.append("label:" + case["row"]["oid"])
    for case in VECTORS["transitions"]:
        got = run_transition(case, bug)
        if (got["key"], got["hidden"], got["text"], got["rows"]) != (case["key"], case["hidden"], case["text"], case["rows"]):
            out.append("transition:" + case["name"])
    return out


class IndependentModel(unittest.TestCase):
    def test_every_vector_holds_in_the_independent_model(self):
        self.assertEqual([], failures())

    def test_the_vectors_cover_each_contract_case(self):
        names = {case["name"] for case in VECTORS["reconcile"]}
        for required in ("same_accession_two_institutions_hallym", "same_accession_two_institutions_kin_center",
                         "tele_received_study_never_pairs", "restricted_caller_zero_unlinked_orders",
                         "unrestricted_control_for_the_restricted_case", "seed_orders_are_never_comparable"):
            self.assertIn(required, names)
        by = {case["name"]: case for case in VECTORS["reconcile"]}
        # Contract test 1: the same accession exists in both institutions and only the owner pairs.
        hallym, kin = by["same_accession_two_institutions_hallym"], by["same_accession_two_institutions_kin_center"]
        self.assertEqual(hallym["orders"], kin["orders"])
        self.assertEqual(hallym["expect"][0]["candidates"], [])
        self.assertEqual(kin["expect"][0]["candidates"], ["2.25.202"])
        # Contract test 2: zero unlinked orders AND zero candidates for the restricted caller, while the
        # unrestricted control on the same rows has both.
        restricted = by["restricted_caller_zero_unlinked_orders"]["expect"]
        self.assertFalse([row for row in restricted if row["link"] == "unlinked"])
        control = by["unrestricted_control_for_the_restricted_case"]["expect"]
        self.assertTrue([row for row in control if row["link"] == "unlinked" and row["candidates"]])
        # Contract test 3 (server half): a seed order has no accession and never pairs.
        for row in by["seed_orders_are_never_comparable"]["expect"]:
            self.assertEqual((row["accession"], row["candidates"]), ("absent", []))

    def test_phrases_are_the_study_arrivals_phrases(self):
        self.assertEqual(VECTORS["phrases"]["orderWithoutImages"], OBSERVATION_VECTORS["phrases"]["orderWithoutImages"])
        self.assertEqual(VECTORS["phrases"]["observationUnavailable"], OBSERVATION_VECTORS["phrases"]["observationUnavailable"])
        # IF-W09: a failure is never worded as an order without images, and no label may say done.
        for case in VECTORS["transitions"]:
            if case["key"] == "observation_unavailable":
                self.assertNotIn(PHRASE, case["text"], case["name"])
            self.assertTrue(case["hidden"] or case["text"].startswith("Order Reconciliation · " + MARKER), case["name"])
            for line in [case["text"], *case["rows"]]:
                self.assertIsNone(re.search(r"완료|수신 완료|안정|received|complete|stable|Scheduled|예정", line, re.I), line)


class VectorAdequacy(unittest.TestCase):
    BUGS = {
        "blank_equal": "reconcile:seed_orders_are_never_comparable",
        "no_study_tenant": "reconcile:same_accession_two_institutions_hallym",
        "tele_as_own": "reconcile:tele_received_study_never_pairs",
        "no_order_tenant": "reconcile:same_accession_two_institutions_hallym",
        "restricted_lists_unlinked": "reconcile:restricted_caller_zero_unlinked_orders",
        "restricted_ignores_permission": "reconcile:restricted_caller_zero_unlinked_orders",
        # (Dropping the "observed" condition is an equivalent change: a study's accession exists only in
        # the enumeration row, so an unobserved study compares as blank and cannot pair either way.)
        "candidates_include_linked": "reconcile:linked_or_unobserved_studies_are_not_candidates",
        "no_backpointer": "reconcile:inconsistent_links_are_not_pairs",
        "unobserved_as_observed": "reconcile:linked_orders_observed_and_not_observed",
        "case_insensitive": "accession:case_differs",
        "no_trim": "accession:padded_equal",
        "extra_keys_allowed": "read:unlinked_row_with_patient_field",
        "other_source_allowed": "read:other_source",
        "absent_candidates_allowed": "read:absent_with_candidates",
        "failure_clears_rows": "transition:failure_keeps_the_last_answer",
        "absent_answer_as_empty": "transition:answer_absent_is_unknown_not_empty",
        "summary_without_marker": "transition:observed_full",
        "not_observed_without_phrase": "label:SYN-L2",
    }

    def test_each_named_wrong_rule_fails_its_vector(self):
        for bug, expected in self.BUGS.items():
            with self.subTest(bug=bug):
                self.assertIn(expected, failures(bug))


# ── 3. Source pins ────────────────────────────────────────────────────────────────────────────────

def between(source, start, end):
    head = source.index(start)
    return source[head:source.index(end, head + len(start))]


def js_function(source, name):
    """Brace scan with string skipping, the same shape the DOM harness slices with."""
    start = source.index("function " + name + "(")
    brace = source.index("{", start)
    depth, quote, escaped = 0, None, False
    for index in range(brace, len(source)):
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


class ServerPins(unittest.TestCase):
    def test_list_reads_the_order_side_on_the_completing_page_before_the_access_recheck(self):
        listing = between(SERVICE, "  async listStudies(c: Caller, query?: any) {", "  private notObserved(")
        self.assertIn("const qido = page ? await this.orthanc.studyIdentities(this.studyAccess.needsMetadata(access), true) : await this.orthanc.studies();", listing)
        current = listing.index("if (changedAccess(current)) throw accessConflict();")
        rows = listing.index("const orderRows = !page || window.pagination?.next === null ? await this.orderSide(me) : null;")
        unchanged = listing.index("await this.studyAccess.unchanged(c,access);")
        answer = listing.index("const orderReconciliation = orderRows ? this.orderReconciliation(qido, orderRows, me, access) : undefined;")
        self.assertTrue(current < rows < unchanged < answer)
        self.assertIn("observedAt,\n      ...(notObserved === undefined ? {} : { notObserved }),\n"
                      "      ...(orderReconciliation === undefined ? {} : { orderReconciliation }), ...(page ? { pagination: window.pagination } : {}) };",
                      listing)
        # U1b's absence line is untouched.
        self.assertIn("const notObserved = !page || window.pagination?.next === null ? this.notObserved(qido, states, me, access, observedAt) : undefined;", listing)

    def test_order_side_query_is_tenant_filtered_and_carries_no_patient_field(self):
        side = between(SERVICE, "  private orderSide(me: string) {", "\n  }\n")
        self.assertEqual(2, side.count("where: { institutionId: me }"))
        self.assertIn("select: { oid: true, institutionId: true, accession: true, matched: true, studyUid: true } }", side)
        self.assertIn("select: { uid: true, institutionId: true, matched: true, orderOid: true } }", side)
        for field in ("patientId", "name:", "sched", "birth", "ov", "orig", "teleInstitutionId"):
            self.assertNotIn(field, side)

    def test_the_answer_uses_the_same_successful_enumeration_and_the_server_read_accession(self):
        helper = between(SERVICE, "  private orderReconciliation(", "\n  }\n")
        for needle in ("if (!Array.isArray(qido)) return null;", "if (!uid) return null;",
                       "restricted: access.policy.restricted",
                       "accessionOf: row => OrthancService.tag(row, '00080050')",
                       "permitted: (uid, row) => this.studyAccess.matches(access, uid, row)"):
            self.assertIn(needle, helper)
        for banned in (".ov", ".orig", "parse(", "prisma", "patient"):
            self.assertNotIn(banned, helper)

    def test_the_rule_module_is_pure_and_carries_the_tenant_pins(self):
        self.assertIn("export const ORDER_RECONCILIATION_SOURCE = 'engineering_only' as const;", RULE)
        for needle in ("if (!left || !right) return 'not_comparable';",
                       "for (const s of input.links) if (s.institutionId === me) own.set(s.uid, s);",
                       "if (!input.restricted) for (const [uid, s] of own) {",
                       "if (!row || s.matched !== 'U' || s.orderOid != null || !input.permitted(uid, row)) continue;",
                       "if (o.institutionId !== me) continue;",
                       "if (input.restricted) continue;",
                       "if (!s || s.matched !== 'M' || s.orderOid !== o.oid) continue;",
                       "if (!input.permitted(s.uid, row)) continue;"):
            self.assertEqual(1, RULE.count(needle), needle)
        for banned in ("import ", "require(", "this.", "@prisma", "process.env", "fetch(", "teleInstitutionId", "toLowerCase", "toUpperCase"):
            self.assertNotIn(banned, RULE)

    def test_no_existing_write_or_response_path_gained_the_accession(self):
        for owner in ("  async match(", "  async unmatch(", "  async removeState("):
            body = between(SERVICE, owner, "\n  }\n")
            self.assertNotIn("accession", body, owner)
        bootstrap = between(SERVICE, "  async bootstrap(c: Caller, query?: any) {", "\n  }\n")
        self.assertNotIn("accession", bootstrap)
        # Code (not comment) lines naming the column: the one read and the one server-read DICOM tag.
        code = [line.strip() for line in SERVICE.splitlines()
                if "accession" in line and not line.strip().startswith(("*", "//", "/*"))]
        self.assertEqual(["select: { oid: true, institutionId: true, accession: true, matched: true, studyUid: true } }),",
                          "accessionOf: row => OrthancService.tag(row, '00080050'),"], code)
        self.assertNotIn("accession", SEED, "the product never invents a seed accession")

    def test_identity_enumeration_default_is_unchanged_and_accession_is_opt_in(self):
        self.assertIn("async studyIdentities(accessMetadata = false, accession = false): Promise<any[]> {", ORTHANC)
        self.assertIn("RequestedTags:['StudyInstanceUID','InstitutionName',\n        ...(accessMetadata ? ['PatientID','StudyDate','ModalitiesInStudy'] : []), ...(accession ? ['AccessionNumber'] : [])] });", ORTHANC)
        self.assertIn("Object.assign(source, { '00080050': { Value:[typeof value === 'string' ? value : ''] } });", ORTHANC)
        self.assertEqual(1, SERVICE.count("studyIdentities("))


class MigrationPins(unittest.TestCase):
    def test_the_migration_is_one_nullable_column_and_nothing_else(self):
        self.assertTrue(MIGRATION.startswith("--"))
        self.assertEqual(1, MIGRATION.count("ADD COLUMN"))
        self.assertIn('ALTER TABLE "Order" ADD COLUMN "accession" TEXT;', MIGRATION)
        body = "\n".join(line for line in MIGRATION.splitlines() if not line.startswith("--"))
        for forbidden in ("DEFAULT", "NOT NULL", "UPDATE", "DELETE", "DROP", "INSERT", "TRUNCATE", "INDEX"):
            self.assertNotIn(forbidden, body)
        self.assertIn("BEGIN;", body)
        self.assertIn("COMMIT;", body)

    def test_the_schema_declares_the_column_nullable_without_default(self):
        block = re.search(r"model Order \{(.*?)\n\}", SCHEMA, re.S).group(1)
        self.assertRegex(block, r"\n  accession String\?\n")
        self.assertNotRegex(block, r"accession[^\n]*@default")

    def test_the_image_and_restore_bookkeeping_name_the_migration(self):
        production = text("tests", "production_image_test.py")
        fixture = text("tests", "ops_product_transfer_fixture.py")
        transfer = text("tests", "ops_product_transfer_test.py")
        self.assertIn("'" + MIGRATION_NAME + "'", production)
        # S4-U3's gateway-receipt and then S4-U4's gateway-retry-request migrations follow this one: 29 files.
        # The order is pinned, not a position from the end, so the next additive migration moves only the count.
        self.assertIn("'api/prisma/migrations/" + MIGRATION_NAME + "/migration.sql',", fixture)
        self.assertIn("self.assertEqual(len(transfer.MIGRATIONS), 29)", transfer)
        self.assertIn("accession='SYNTHETIC-ACC-1'", fixture)
        self.assertIn("'ReportDraft', 'Order', 'UserFilter',", fixture)
        names = sorted(p.name for p in (ROOT / "api" / "prisma" / "migrations").iterdir() if p.is_dir())
        later = [MIGRATION_NAME, "20260924130000_gateway_receipt", "20260924140000_gateway_retry_request"]
        self.assertEqual(names[names.index(MIGRATION_NAME):names.index(MIGRATION_NAME) + 3], later)


class ClientPins(unittest.TestCase):
    def test_the_module_has_no_storage_network_dom_or_seed_path(self):
        for banned in ("localStorage", "sessionStorage", "fetch(", "XMLHttpRequest", "document.", "innerHTML",
                       "SEED_ORDERS", "kin-orders", "window.orders"):
            self.assertNotIn(banned, CLIENT, banned)
        # No patient or scheduling field is ever read from a row: an order is its oid and its state.
        self.assertIsNone(re.search(r"\.(sched|name|patientId|birth|sex|desc|descr|ward|reqDoc)\b", CLIENT))
        self.assertIn("const SOURCE='engineering_only',MARKER='Engineering Only';", CLIENT)
        self.assertIn("const ORDER_WITHOUT_IMAGES='영상 없는 주문',OBSERVATION_UNAVAILABLE='관측 불가';", CLIENT)
        self.assertIn("if(row.accession==='absent'&&row.candidates.length)return bad;", CLIENT)
        self.assertIn("function failed(model){return {...usable(model),available:false};}", CLIENT)

    def test_the_page_client_hands_the_answer_over_from_the_completing_page_only(self):
        self.assertIn("if (page.next === null) draft.observation = { observedAt: data.observedAt, notObserved: data.notObserved };", PAGES)
        self.assertIn("if (page.next === null && data.orderReconciliation !== undefined) draft.observation.orderReconciliation = data.orderReconciliation;", PAGES)
        self.assertLess(PAGES.index("draft.observation = {"), PAGES.index("draft.observation.orderReconciliation ="))

    def test_main_wires_the_answer_through_the_observation_and_nothing_else(self):
        self.assertIn('  <script src="study-arrivals.js"></script>\n  <script src="order-reconciliation.js"></script>\n', MAIN)
        self.assertIn("    let orderReconciliationModel = window.KinOrderReconciliation?.start?.() ?? null;", MAIN)
        self.assertEqual(3, MAIN.count("applyOrderReconciliation("))   # definition + observation success + failure
        self.assertEqual(2, MAIN.count("renderOrderReconciliation("))  # definition + apply
        self.assertEqual(2, MAIN.count("orderReconciliationModel ="))  # declaration + apply
        apply = js_function(MAIN, "applyObservation")
        self.assertLess(apply.index("applyOrderReconciliation(next.ok ? result : null);"), apply.index("renderObservation();"))
        failure = js_function(MAIN, "markObservationUnavailable")
        self.assertLess(failure.index("applyOrderReconciliation(null);"), failure.index("renderObservation();"))
        for name in ("applyOrderReconciliation", "renderOrderReconciliation"):
            body = js_function(MAIN, name)
            for banned in ("localStorage", "sessionStorage", "SEED_ORDERS", "kin-orders", "api(", "fetch(", "toast(", "innerHTML", "saveApp("):
                self.assertNotIn(banned, body, name)
            self.assertIsNone(re.search(r"\borders\b", body), name)
        render = js_function(MAIN, "renderOrderReconciliation")
        self.assertIn("item.textContent = row.text; item.title = row.title;", render)
        # The offline seed stays exactly where it was: the Order List only.
        self.assertEqual(2, MAIN.count("SEED_ORDERS"))

    def test_the_order_panel_carries_the_engineering_marker_and_the_box(self):
        panel = between(MAIN, '<div class="panel order-p" style="display:none">', "</div><!-- /workrow -->")
        self.assertIn('<span id="order-source-status" class="rel-title" style="color:#ffb454"', panel)
        self.assertIn(">Engineering Only</span>", panel)
        box = panel.index('<details id="order-reconciliation"')
        self.assertLess(panel.index('<tbody id="orderrows"></tbody>'), box)
        self.assertLess(box, panel.index('<div class="statusbar"><span id="orderhint">'))
        self.assertIn('<summary id="order-reconciliation-summary"></summary><div id="order-reconciliation-list"></div></details>', panel)
        self.assertRegex(panel, r'<details id="order-reconciliation" [^>]*hidden>')
        # The Order List itself is not relabelled: the existing header and columns stay.
        self.assertIn("<div class=\"on\">Order List (RIS)</div>", panel)

    def test_the_poll_harness_supplies_every_product_function_the_observation_now_calls(self):
        top = set(re.findall(r"^ {4}(?:async )?function ([A-Za-z_$][\w$]*)\(", MAIN, re.M))
        called = set()
        for name in ("applyObservation", "markObservationUnavailable", "renderObservation",
                     "applyOrderReconciliation", "renderOrderReconciliation"):
            called |= {m for m in re.findall(r"\b([A-Za-z_$][\w$]*)\s*\(", js_function(MAIN, name)[len("function " + name):]) if m in top}
        # S4-U5 hands the same observation to the DICOM Identity panel; the harness must slice that function too.
        self.assertEqual({"applyOrderReconciliation", "applyStudyIdentity", "renderObservation", "renderOrderReconciliation",
                          "viewed"}, called)
        for name in called - {"viewed"}:
            self.assertIn('"%s"' % name, HARNESS)
        self.assertIn("function viewed(){", HARNESS)
        self.assertIn("let orderReconciliationModel=null;", HARNESS)


class WorkflowPins(unittest.TestCase):
    def test_hosted_steps_select_the_new_tests_with_their_source_hashes(self):
        for needle in (
            "--run-dir tmp/workspace-ui-ci/order-reconciliation-source",
            "-- python3 -B tests/order_reconciliation_source_test.py",
            "--run-dir tmp/workspace-ui-ci/order-reconciliation-dom",
            "-B tests/order_reconciliation_dom_test.py",
            "--run-dir tmp/runtime-ci/order-reconciliation-client",
            "node --test tests/order_reconciliation_test.cjs",
            "--run-dir tmp/runtime-ci/order-reconciliation-server",
            "--entrypoint node kin-api:ci --test /tests/order_reconciliation_server_test.cjs",
        ):
            self.assertEqual(1, WORKFLOW.count(needle), needle)
        self.assertEqual(1, WORKFLOW.count("--file worklist-v0/hpacs-lite/order-reconciliation.js --file tests/worklist_arrivals_dom_test.py"))


class Encoding(unittest.TestCase):
    CHANGED = ["api/src/order-reconciliation.ts", "api/src/pacs.service.ts", "api/src/orthanc.service.ts",
               "api/prisma/schema.prisma", "api/prisma/migrations/%s/migration.sql" % MIGRATION_NAME,
               "worklist-v0/hpacs-lite/order-reconciliation.js", "worklist-v0/hpacs-lite/study-pages.js",
               "worklist-v0/hpacs-lite/main.html", "tests/order_reconciliation_vectors.json",
               "tests/order_reconciliation_source_test.py", "tests/order_reconciliation_test.cjs",
               "tests/order_reconciliation_server_test.cjs", "tests/order_reconciliation_dom_test.py",
               "tests/worklist_arrivals_dom_test.py", "tests/study_observation_test.py", "tests/invariants_live.py"]

    def test_changed_files_are_strict_utf8_without_bom_or_bare_cr(self):
        for path in self.CHANGED:
            with self.subTest(path):
                data = (ROOT / path).read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                self.assertNotIn("\r", data.decode("utf-8").replace("\r\n", "\n"))
        self.assertNotIn(b"\r", (ROOT / "api/prisma/migrations" / MIGRATION_NAME / "migration.sql").read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
