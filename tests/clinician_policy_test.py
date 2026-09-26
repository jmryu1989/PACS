# coding: utf-8
"""S5-U1a clinician role and clinician-only default denial, S5-U1b read allowlist: pure stdlib spec and source check.

REQ-S5-U1a-ROLE-DEFAULT-DENY -> RISK-S5-CLINICIAN-WRITER-LEAK/UNCLASSIFIED-ROUTE/ROLE-LIST-DRIFT
-> TEST-S5-U1a-CLINICIAN-POLICY (this file) and TEST-S5-U1a-CLINICIAN-LIVE (clinician_policy_live.py).
REQ-S5-U1b-CLINICIAN-READ -> RISK-S5-U1b-DRAFT-LEAK/NONFINAL-BODY/WRITER-FIELD/COUNT-LEAK/TENANT-UID
-> this file (allowlist == fixture, declared additions only, source pins), TEST-S5-U1b-PURE
(clinician_read_serializer_test.cjs) and TEST-S5-U1b-LIVE (clinician_read_live.py).

No Node, no Nest, no browser, no stack. Three kinds of evidence and nothing more:
  1. tests/clinician_policy_fixtures.json judged by an independent Python model of the guard rules
     (member state, clinician-only detection, gateway identity closure, route key from Nest metadata,
     allowlist decision). The shipped TypeScript is judged against the same fixtures only by the hosted
     live module; a green run here is a spec check, not runtime proof of the TS.
  2. The current controller decorator inventory (own parser, same decorator shapes as invariants_live)
     compared with the invariants_live ROUTES table read as text, with the 104-row planning baseline,
     and with the policy allowlist: every current non-public route is denied for clinician-only unless
     it is explicitly listed, and nothing listed is missing from the controllers.
  3. Source pins that guard, member console, Keycloak client and realm carry the same role list and that
     the gate sits between the membership check and the CSRF rule in the guard.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api" / "src"
POLICY = API / "clinician-policy.ts"
GUARD = API / "auth.guard.ts"
ADMIN = API / "admin.service.ts"
KEYCLOAK = API / "keycloak.service.ts"
REALM = ROOT / "keycloak" / "kin-realm.json"
MANIFEST = ROOT / "tests" / "invariants_live.py"
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))

APP_ROLES = set(FIXTURES["app_roles"])
LEGACY_ROLES = set(FIXTURES["legacy_roles"])
CLINICIAN = FIXTURES["clinician_role"]
KIN_ROLES = APP_ROLES | {"gateway"}
ALLOWED = set(FIXTURES["session_routes"]) | set(FIXTURES["business_routes"])
PUBLIC = set(FIXTURES["public_routes"])
METHOD_ENUM = {int(k): v for k, v in FIXTURES["request_method_enum"].items()}
BASELINE = set(FIXTURES["baseline_inventory"]["routes"])


# ── independent model of the guard ──

def strip_groups(groups):
    return [g[1:] if g.startswith("/") else g for g in (groups or []) if isinstance(g, str)]


def member_state(groups, roles):
    app = [r for r in (roles if isinstance(roles, list) else []) if r in APP_ROLES]
    if len(groups) == 0:
        return "PENDING"
    if len(groups) == 1 and len(app) >= 1:
        return "APPROVED"
    return "INVALID"


def clinician_only(roles):
    app = [r for r in (roles if isinstance(roles, list) else []) if r in APP_ROLES]
    return len(app) > 0 and all(r == CLINICIAN for r in app)


def gateway_identity(method, azp, groups, roles):
    kin = [r for r in roles if r in KIN_ROLES]
    adjacent = azp.startswith("gw-") or "gateway" in kin
    valid = method == "bearer" and azp.startswith("gw-") and len(groups) == 1 and kin == ["gateway"]
    return adjacent, valid


def segments(value):
    if not isinstance(value, str):
        return None
    return [part for part in value.split("/") if part]


def route_key(method, controller, handler):
    if type(method) is not int:
        return None
    name = METHOD_ENUM.get(method)
    if name is None:
        return None
    prefix, child = segments(controller), segments(handler)
    if prefix is None or child is None:
        return None
    return name + " " + "/".join(prefix + child)


def allowed(key):
    return key is not None and key in ALLOWED


# ── source readers ──

HTTP_DECORATORS = {"All": "ALL", "Get": "GET", "Post": "POST", "Put": "PUT", "Delete": "DELETE",
                   "Patch": "PATCH", "Options": "OPTIONS", "Head": "HEAD", "Search": "SEARCH", "Sse": "GET"}


def controller_inventory():
    """(method, route) -> {'file', 'public'}; raises when a decorator shape cannot be read."""
    names = "|".join(map(re.escape, HTTP_DECORATORS))
    decorator = re.compile(rf"@({names})\(\s*(?:(['\"])(.*?)\2)?\s*\)")
    route_call = re.compile(rf"@({names}|RequestMapping)\s*\(")
    prefix_re = re.compile(r"@Controller\(\s*(?:(['\"])(.*?)\1)?\s*\)")
    found = {}
    for path in sorted(API.rglob("*.controller.ts")):
        source = path.read_text(encoding="utf-8")
        prefix_match = prefix_re.search(source)
        if prefix_match is None:
            raise AssertionError(f"{path.name}: @Controller() not readable")
        prefix = ((prefix_match.group(2) if prefix_match else "") or "").strip("/")
        matches = list(decorator.finditer(source))
        parsed = {m.start() for m in matches}
        unparsed = [m.group(1) for m in route_call.finditer(source) if m.start() not in parsed]
        if unparsed:
            raise AssertionError(f"{path.name}: unreadable HTTP decorators {unparsed}")
        previous_end = prefix_match.end()
        for match in matches:
            child = (match.group(3) or "").strip("/")
            route = "/".join(part for part in (prefix, child) if part)
            block = source[previous_end:match.start()]
            key = (HTTP_DECORATORS[match.group(1)], route)
            if key in found:
                raise AssertionError(f"duplicate route {key}")
            found[key] = {"file": path.name, "public": "@Public()" in block}
            previous_end = match.end()
    return found


def manifest_routes():
    text = MANIFEST.read_text(encoding="utf-8")
    start = text.index("ROUTES: dict[tuple[str, str], Route] = {")
    end = text.index("\n}\n", start)
    rows = re.findall(r'\("([A-Z]+)", "([^"]+)"\): Route\(', text[start:end])
    return {(m, p) for m, p in rows}


def ts_array(source, name):
    match = re.search(rf"export const {re.escape(name)}\b[^=]*=\s*Object\.freeze\(\[(.*?)\]\);", source, re.S)
    if match is None:
        raise AssertionError(f"{name} is not a frozen literal array")
    return re.findall(r"'([^']*)'", match.group(1))


class ClinicianPolicySpec(unittest.TestCase):
    policy = POLICY.read_text(encoding="utf-8")
    guard = GUARD.read_text(encoding="utf-8")
    admin = ADMIN.read_text(encoding="utf-8")
    keycloak = KEYCLOAK.read_text(encoding="utf-8")

    def test_01_policy_constants_are_the_fixture_values(self):
        self.assertEqual(ts_array(self.policy, "LEGACY_APP_ROLES"), FIXTURES["legacy_roles"])
        self.assertRegex(self.policy, r"export const CLINICIAN_ROLE = 'clinician';")
        self.assertRegex(self.policy, r"export const APP_ROLES\b[^=]*=\s*new Set\(\[\.\.\.LEGACY_APP_ROLES, CLINICIAN_ROLE\]\);")
        self.assertEqual(ts_array(self.policy, "CLINICIAN_SESSION_ROUTES"), FIXTURES["session_routes"])
        self.assertEqual(ts_array(self.policy, "CLINICIAN_BUSINESS_ROUTES"), FIXTURES["business_routes"])
        # U1a shipped an empty business allowlist; U1b adds read rows only. The single non-GET row is the viewer's
        # SOP lookup (answers an Orthanc instance id, writes nothing); anything else that is not a GET is a new decision.
        self.assertEqual(len(FIXTURES["business_routes"]), len(set(FIXTURES["business_routes"])))
        self.assertEqual([k for k in FIXTURES["business_routes"] if not k.startswith("GET ")], ["POST dicom/lookup"])
        self.assertTrue({"GET authz/dicom", "POST dicom/lookup"} <= set(FIXTURES["business_routes"]),
                        "the viewer read pair is allowed together or not at all")
        self.assertTrue(set(FIXTURES["must_stay_denied"]).isdisjoint(ALLOWED))
        self.assertRegex(self.policy, r"export const CLINICIAN_ALLOWED_ROUTES\b[^=]*=\s*new Set\(\[\.\.\.CLINICIAN_SESSION_ROUTES, \.\.\.CLINICIAN_BUSINESS_ROUTES\]\);")
        self.assertRegex(self.policy, r"export const CLINICIAN_ROUTE_DENIED = 'CLINICIAN_ROUTE_DENIED';")
        self.assertEqual(FIXTURES["denied_code"], "CLINICIAN_ROUTE_DENIED")
        self.assertEqual(sorted(FIXTURES["session_routes"]), ["GET me", "POST auth/logout"])
        # fail-closed shape: unknown method or non-string paths return null, null is never allowed
        self.assertRegex(self.policy, r"if \(typeof name !== 'string' \|\| !/\^\[A-Z\]\+\$/\.test\(name\)\) return null;")
        self.assertRegex(self.policy, r"if \(prefix === null \|\| child === null\) return null;")
        self.assertRegex(self.policy, r"return key !== null && CLINICIAN_ALLOWED_ROUTES\.has\(key\);")
        self.assertRegex(self.policy, r"return app\.length > 0 && app\.every\(role => role === CLINICIAN_ROLE\);")

    def test_02_token_fixtures_against_the_model(self):
        ids = [t["id"] for t in FIXTURES["tokens"]]
        self.assertEqual(len(ids), len(set(ids)))
        states = set()
        for token in FIXTURES["tokens"]:
            with self.subTest(token=token["id"]):
                groups = strip_groups(token["groups"])
                self.assertEqual(member_state(groups, token["roles"]), token["state"])
                self.assertEqual(clinician_only(token["roles"]), token["clinicianOnly"])
                states.add(token["state"])
        self.assertEqual(states, {"APPROVED", "PENDING", "INVALID"})
        approved = [t for t in FIXTURES["tokens"] if t["state"] == "APPROVED"]
        self.assertTrue(any(t["clinicianOnly"] for t in approved))
        self.assertTrue(any(not t["clinicianOnly"] and CLINICIAN in t["roles"] for t in approved), "mixed-role case present")
        self.assertTrue(any(t["clinicianOnly"] and t["state"] != "APPROVED" for t in FIXTURES["tokens"]),
                        "clinician-only pending/invalid still stops at the membership check")

    def test_03_gateway_identity_closure_rejects_human_roles(self):
        for identity in FIXTURES["gateway_identities"]:
            with self.subTest(identity=identity["id"]):
                adjacent, valid = gateway_identity(identity["method"], identity["azp"], identity["groups"], identity["roles"])
                self.assertTrue(adjacent)
                self.assertEqual(valid, identity["valid"])
        self.assertRegex(self.guard, r"const KIN_ROLES = new Set\(\[\.\.\.APP_ROLES, 'gateway'\]\);")
        self.assertRegex(self.guard, r"kinRoles\.length === 1 && kinRoles\[0\] === 'gateway'")

    def test_04_route_key_from_nest_metadata(self):
        for case in FIXTURES["route_metadata_cases"]:
            with self.subTest(case=case):
                key = route_key(case["method"], case["controller"], case["handler"])
                self.assertEqual(key, case["key"])
                self.assertEqual(allowed(key), case["allowed"])
        # 3 session cases from U1a plus one per U1b business row
        self.assertEqual(sum(1 for c in FIXTURES["route_metadata_cases"] if c["allowed"]), 3 + len(FIXTURES["business_routes"]))
        self.assertEqual({c["key"] for c in FIXTURES["route_metadata_cases"] if c["allowed"]}, ALLOWED)
        self.assertTrue(any(c["key"] is None for c in FIXTURES["route_metadata_cases"]))

    def test_05_every_current_route_is_classified_and_denied_unless_listed(self):
        inventory = controller_inventory()
        keys = {m + " " + p for m, p in inventory}
        public = {m + " " + p for (m, p), meta in inventory.items() if meta["public"]}
        self.assertEqual(public, PUBLIC, "the public four must stay exactly these")
        self.assertEqual(self.guard.count("SetMetadata('public', true)"), 1)
        self.assertEqual(manifest_routes(), set(inventory), "controllers and invariants_live ROUTES disagree")
        self.assertTrue(ALLOWED <= keys, f"allowlisted routes missing from controllers: {sorted(ALLOWED - keys)}")
        self.assertTrue(ALLOWED.isdisjoint(public), "public routes never appear in the clinician allowlist")
        decisions = {}
        for (method, path) in sorted(inventory):
            key = method + " " + path
            if key in PUBLIC:
                continue
            decisions[key] = allowed(key)
        self.assertEqual({k for k, v in decisions.items() if v}, ALLOWED)
        denied = sorted(k for k, v in decisions.items() if not v)
        # structural, not a magic count: everything that is neither public nor listed is denied,
        # and the inventory can only have grown since the 104-row planning baseline
        self.assertEqual(len(denied), len(inventory) - len(PUBLIC) - len(ALLOWED))
        self.assertGreaterEqual(len(inventory), len(BASELINE))
        added = sorted(keys - BASELINE)
        removed = sorted(BASELINE - keys)
        self.assertEqual(removed, [], "a baseline route disappeared; re-check the planning inventory")
        # A route added since the baseline is allowed only when a unit declared it as its own new read row.
        declared = set(FIXTURES["allowed_additions"])
        self.assertTrue(declared <= set(added), f"declared additions are not new routes: {sorted(declared - set(added))}")
        self.assertTrue(declared <= ALLOWED)
        for key in added:
            if key in declared:
                continue
            self.assertFalse(allowed(key), f"route added since the 104 baseline must not be silently allowed: {key}")
        for key in FIXTURES["must_stay_denied"]:
            self.assertIn(key, keys, key)
            self.assertFalse(allowed(key), f"{key} carries drafts, writer fields or non-final bodies")
        print("CLINICIAN_POLICY_INVENTORY " + json.dumps({
            "current_routes": len(inventory), "public": sorted(public), "allowed": sorted(ALLOWED),
            "denied_for_clinician_only": len(denied), "baseline_routes": len(BASELINE),
            "added_since_baseline": added, "removed_since_baseline": removed,
            "allowed_additions": sorted(declared),
        }, ensure_ascii=True, sort_keys=True))

    def test_06_guard_source_pins(self):
        guard = self.guard
        self.assertIn("import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';", guard)
        self.assertRegex(guard, r"import \{\s*APP_ROLES, CLINICIAN_ROUTE_DENIED, clinicianOnly, clinicianRouteAllowed, routeKey,?\s*\} from './clinician-policy';")
        self.assertNotIn("new Set(['radiologist'", guard, "guard must not keep its own role literal")
        self.assertIn("req.roles = ['radiologist', 'technician', 'admin'];", guard, "AUTH_REQUIRED=false dev roles unchanged (no clinician)")
        self.assertIn("const isLogout = req.method === 'POST' && path === '/api/auth/logout';", guard)
        self.assertIn("if (state !== 'APPROVED' && !isLogout)", guard)
        membership = guard.index("code: state === 'PENDING' ? 'INSTITUTION_PENDING' : 'INSTITUTION_INVALID'")
        gate = guard.index("req.clinicianOnly = clinicianOnly(req.roles);")
        csrf = guard.index("req.headers['x-kin-csrf'] !== '1'")
        returned = guard.rindex("return true;")
        self.assertLess(membership, gate)
        self.assertLess(gate, csrf)
        self.assertLess(csrf, returned)
        block = guard[gate:csrf]
        self.assertRegex(block, r"if \(req\.clinicianOnly\) \{")
        self.assertRegex(block, r"routeKey\(\s*this\.reflector\.get\(METHOD_METADATA, ctx\.getHandler\(\)\),\s*this\.reflector\.get\(PATH_METADATA, ctx\.getClass\(\)\),\s*this\.reflector\.get\(PATH_METADATA, ctx\.getHandler\(\)\),\s*\)")
        self.assertRegex(block, r"if \(!clinicianRouteAllowed\(key\)\)\s*throw new ForbiddenException\(\{ code: CLINICIAN_ROUTE_DENIED \}\);")
        self.assertNotIn("originalUrl", block, "the gate reads route metadata, not the request URL")
        gateway_return = guard.index("req.kind = 'gateway';")
        self.assertLess(gateway_return, membership, "gateway identities return before the member checks")

    def test_07_member_console_and_keycloak_client_share_the_role_list(self):
        self.assertIn("import { APP_ROLES } from './clinician-policy';", self.admin)
        self.assertNotIn("new Set(['radiologist'", self.admin)
        self.assertIn("if (roles.some(role => !APP_ROLES.has(role)))", self.admin)
        self.assertIn("const roles = user.roles.filter(role => APP_ROLES.has(role)).sort();", self.admin)
        self.assertIn("import { APP_ROLES as MANAGED_ROLES } from './clinician-policy';", self.keycloak)
        self.assertNotIn("new Set(['radiologist'", self.keycloak)
        self.assertIn("if (roles.some(role => !MANAGED_ROLES.has(role)))", self.keycloak)
        self.assertIn("MANAGED_ROLES.has(role.name) && !wanted.has(role.name)", self.keycloak)
        # colleagues/reviewer candidates stay radiologist-only; a clinician is never a reviewer candidate
        self.assertIn("u.roles.includes('radiologist')", self.keycloak)
        # the self-protection and the admin predicate of the member console are unchanged
        self.assertIn("if (!c.roles?.includes('admin')) throw new ForbiddenException", self.admin)
        self.assertIn("!this.roles(body.roles).includes('admin')", self.admin)

    def test_08_realm_defines_the_role_without_users_or_secrets(self):
        realm = json.loads(REALM.read_text(encoding="utf-8"))
        names = [r["name"] for r in realm["roles"]["realm"]]
        self.assertEqual(names, ["radiologist", "technician", "admin", "clinician", "gateway"])
        clinician = next(r for r in realm["roles"]["realm"] if r["name"] == "clinician")
        self.assertEqual(set(clinician), {"name", "description"})
        for user in realm["users"]:
            self.assertNotIn("clinician", user.get("realmRoles", []), "no imported clinician account; identities are test-owned")
            self.assertNotIn("credentials", user)
        for client in realm["clients"]:
            secret = client.get("secret")
            self.assertTrue(secret is None or secret.startswith("${"), client["clientId"])

    def test_09_u1b_read_rows_are_narrow_scoped_and_final_gated_in_source(self):
        """S5-U1b source pins. Runtime proof is clinician_read_live.py; these catch a narrow path being widened."""
        read = lambda name: (API / name).read_text(encoding="utf-8")  # noqa: E731
        controller, service = read("pacs.controller.ts"), read("pacs.service.ts")
        viewer, preview = read("viewer.controller.ts"), read("report-preview.controller.ts")
        items = read("viewer.service.ts")
        contract = FIXTURES["read_contract"]
        self.assertEqual(ts_array(self.policy, "CLINICIAN_FINAL_ACTIONS"), contract["final_actions"])
        self.assertEqual(ts_array(self.policy, "CLINICIAN_OPEN_STATES"), contract["open_states"])
        self.assertRegex(self.policy, r"return rs === 'A' && typeof action === 'string' && CLINICIAN_FINAL_ACTIONS\.includes\(action\)")
        # both new rows live in the report-preview controller (no-store middleware, StudyAccess interceptor) and go
        # straight to their clinician service method; pacs.controller.ts, whose bytes S4-U5 pins, gains nothing
        for route, call in (("clinician/studies", "this.pacs.clinicianStudies(member(req), query)"),
                            ("clinician/studies/:uid/report", "this.pacs.clinicianReportRead(uid, member(req))")):
            block = re.search(rf"@Get\('{re.escape(route)}'\)\n(.*?)\n  \}}", preview, re.S)
            self.assertIsNotNone(block, route)
            self.assertIn("return " + call + ";", block.group(1))
        self.assertNotIn("clinician", controller)
        # the clinician list IS the worklist enumeration (same tenant/tele/StudyAccess/page/recheck), narrowed after it
        body = re.search(r"\n  async clinicianStudies\(c: Caller, query\?: any\) \{\r?\n(.*?)\r?\n  \}\r?\n", service, re.S).group(1)
        lines = [line.strip() for line in body.splitlines()]
        self.assertEqual(lines[:2], ["this.clinicianCaller(c);", "const list = await this.listStudies(c, query);"])
        self.assertEqual(lines[-1], "return clinicianList(list, current);")
        self.assertIn("if (clinicianListChanged(list.studies, current))", body)
        # S5-U1b-F02: scope and report status (rs, signer, date, Report.version, head action) come from ONE statement —
        # one snapshot — and the rows are projected from it; no second StudyState/Report read is merged in
        self.assertEqual(body.count("$queryRaw"), 1, "one statement reads the whole report status")
        self.assertEqual(body.count("await "), 2, "listStudies and the one snapshot statement are the only reads")
        snapshot = body[body.index("$queryRaw"):]
        for fragment in ('SELECT s.uid, s."institutionId", s."teleInstitutionId", s.rs, s."repDoc", s.confirm,',
                         "COALESCE(r.version, 0) AS version, v.action", 'FROM "StudyState" s',
                         'LEFT JOIN "Report" r ON r.uid = s.uid',
                         'LEFT JOIN "ReportVersion" v ON v.uid = r.uid AND v.version = r.version'):
            self.assertIn(fragment, snapshot, fragment)
        for token in ("findings", "reportDraft", "toClient", "notObserved", "orderReconciliation", "gatewayReceipt",
                      "findMany", "findUnique"):
            self.assertNotIn(token, body, token)
        self.assertEqual(ts_array(self.policy, "CLINICIAN_LIST_PINS"), contract["list_snapshot_pins"])
        self.assertIn("report: clinicianReportStatus(record, record ? { version: record.version, action: record.action } : null),", self.policy)
        self.assertIn("return !state || CLINICIAN_LIST_PINS.some(key => (state[key] ?? null) !== (seen[key] ?? null));", self.policy)
        self.assertNotIn("head.version === state.version", self.policy, "the worklist row's own version never pins a head")
        scope = re.search(r"\n  private async clinicianScope<T>\(.*?\n  \}\r?\n", service, re.S).group(0)
        self.assertIn("need(c.roles, CLINICIAN_ROLE, '임상의 조회');", service)
        self.assertIn("this.clinicianCaller(c);", scope)
        self.assertIn("const state = await this.gate(uid, c, tx);", scope)
        self.assertIn("if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');", scope)
        self.assertIn("where: { uid_version: { uid, version: report.version } },", scope)
        self.assertIn("isolationLevel: 'RepeatableRead'", scope)
        self.assertIn("if (!report.final) return { uid, report, keys: null };", service)
        statistics = service[service.index("if (path === '/statistics') {"):service.index("// /dicom-web/studies/{uid}/")]
        closed = statistics.index("if (clinicianOnly(c.roles)) throw new ForbiddenException(")
        self.assertLess(closed, statistics.index("return;"), "the server-wide count closes for clinician-only before it passes")
        # viewer items: clinician-only branch pinned to ONE signed version (S5-U1b-F01), not a boolean asked twice:
        # gate -> items read in the same statement as the signed head of that version -> gate again, all compared
        self.assertIn("return clinicianOnly(c.roles) ? this.clinicianItems(uid, query, c) : this.svc.list(uid, query, c);", viewer)
        branch = viewer[viewer.index("private async clinicianItems("):]
        branch = branch[:branch.index("\n  }")]
        steps = ("const version = await this.pacs.clinicianViewerHead(uid, c);",
                 "if (version === null) return clinicianViewerWithheld(uid);",
                 "const result = await this.svc.listFinal(uid, continued ? { ...rest, cursor: continued.after } : rest, c, version);",
                 "if (!clinicianViewerPinned(version, result.finalVersion, await this.pacs.clinicianViewerHead(uid, c))) throw changed();",
                 "return clinicianViewerPage(uid, version, result, VIEWER_CURSOR_KEY);")
        positions = [branch.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions), "gate, pinned read, gate+compare, answer — in this order")
        self.assertIn("new ConflictException({ code: CLINICIAN_VIEWER_CHANGED, message });", viewer)
        self.assertEqual(branch.count("clinicianViewerHead(uid, c)"), 2)
        self.assertNotIn("this.svc.list(", branch, "the clinician path never reads items without the signed head")
        for source in (viewer, service):
            self.assertNotIn("clinicianViewerFinal", source, "a boolean gate cannot see reset -> re-approve")
        self.assertIn("clinicianFinal(state.rs, head) ? head.version as number : null", service)
        self.assertRegex(self.policy, r"return Number\.isSafeInteger\(before\) && \(before as number\) > 0 && read === before && after === before;")
        self.assertEqual(re.search(r"export const CLINICIAN_VIEWER_CHANGED = '([A-Z_]+)';", self.policy).group(1),
                         contract["viewer_changed_code"])
        # the signed head and the items are one SQL statement: the head CTE, its column and the item filter
        listed = items[items.index("async listFinal("):items.index("async write(")]
        for fragment in ('SELECT r.version FROM "Report" r',
                         'JOIN "StudyState" s ON s.uid = r.uid',
                         'JOIN "ReportVersion" v ON v.uid = r.uid AND v.version = r.version',
                         "WHERE r.uid = ${uid} AND r.version > 0 AND s.rs = 'A' AND v.action IN (${Prisma.join([...CLINICIAN_FINAL_ACTIONS])})",
                         "Prisma.sql`, final_head AS (${signed})`",
                         "Prisma.sql`(SELECT version FROM final_head) AS \"finalVersion\",`",
                         "Prisma.sql`AND EXISTS(SELECT 1 FROM final_head f WHERE f.version = ${final}::int)`"):
            self.assertIn(fragment, listed, fragment)
        statement = listed[listed.index("const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent})${signedHead}"):]
        statement = statement[:statement.index("AS rows`;") + len("AS rows`;")]
        for fragment in ("${signedHead}", "${signedColumn}", "WHERE (${page.includeHidden} OR NOT i.hidden) ${signedItems}"):
            self.assertIn(fragment, statement, fragment)
        self.assertIn("if (!Number.isSafeInteger(final) || final < 1) denied();", listed)
        self.assertIn("return this.read(uid, query, c, id, null);", items, "the legacy list keeps the unsigned statement")
        # report-preview returns bodies at every RS; clinician-only is refused before any read
        guard_at = preview.index("if (clinicianOnly(caller.roles)) throw new ForbiddenException({ code: CLINICIAN_ROUTE_DENIED });")
        self.assertLess(guard_at, preview.index("this.prisma.studyState.findUnique"))
        # both new rows sit in the REPORT battery of invariants_live (technician, preliminary third party, other tenant)
        manifest = MANIFEST.read_text(encoding="utf-8")
        self.assertIn('("GET", "clinician/studies"): Route(Kind.REPORT, "clinician-studies", "collection"),', manifest)
        self.assertIn('("GET", "clinician/studies/:uid/report"): Route(Kind.REPORT, "clinician-report"),', manifest)

    def test_10_viewer_pages_continue_only_on_the_signed_version_they_started(self):
        """S5-U1b-F04 source pins. Runtime proof is the serializer chain vectors and clinician_read_live test_06b."""
        read = lambda name: (API / name).read_text(encoding="utf-8")  # noqa: E731
        viewer, items = read("viewer.controller.ts"), read("viewer.service.ts")
        # one process-local key, made in the controller module and never read from configuration
        self.assertIn("import { randomBytes } from 'node:crypto';", viewer)
        self.assertEqual(re.findall(r"const VIEWER_CURSOR_KEY = (.*);", viewer), ["randomBytes(32)"])
        self.assertNotIn("process.env", viewer)
        branch = viewer[viewer.index("private async clinicianItems("):]
        branch = branch[:branch.index("\n  }")]
        # the continuation is judged before the gate, and the gate's head is compared with its version before anything
        # is read or withheld; the one version that passes is the pin of listFinal and of the last check
        steps = ("const page = clinicianViewerQuery(query);",
                 "const { cursor, ...rest } = page;",
                 "const continued = cursor === undefined ? null : clinicianViewerContinuation(VIEWER_CURSOR_KEY, uid, cursor);",
                 "if (cursor !== undefined && !continued) throw changed(",
                 "const version = await this.pacs.clinicianViewerHead(uid, c);",
                 "if (!clinicianViewerContinues(continued?.version ?? null, version)) throw changed();",
                 "if (version === null) return clinicianViewerWithheld(uid);",
                 "const result = await this.svc.listFinal(uid, continued ? { ...rest, cursor: continued.after } : rest, c, version);",
                 "if (!clinicianViewerPinned(version, result.finalVersion, await this.pacs.clinicianViewerHead(uid, c))) throw changed();",
                 "return clinicianViewerPage(uid, version, result, VIEWER_CURSOR_KEY);")
        positions = [branch.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions), "verify continuation, gate, compare, withhold, pinned read, recheck, answer")
        # the caller's cursor never reaches the item read; only the verified boundary does, and every answer is signed
        self.assertEqual(branch.count("cursor: continued.after"), 1)
        self.assertNotIn("listFinal(uid, page,", branch)
        self.assertEqual(branch.count("VIEWER_CURSOR_KEY"), 2)
        # policy: signed {v, uid, version, after}; HMAC-SHA256 compared in constant time over canonical base64url; key >= 32 bytes
        for fragment in (
                "import { createHmac, timingSafeEqual } from 'node:crypto';",
                "if (!(key instanceof Uint8Array) || key.length < 32) throw new Error(",
                "return createHmac('sha256', key).update(payload).digest();",
                "const payload = Buffer.from(JSON.stringify({ v: 1, uid, version, after }), 'utf8').toString('base64url');",
                "if (actual.toString('base64url') !== signature || actual.length !== expected.length"
                " || !timingSafeEqual(actual, expected)) return null;",
                "data.v !== 1 || data.uid !== uid || !Number.isSafeInteger(data.version) || data.version < 1",
                "return started === null || (Number.isSafeInteger(head) && (head as number) > 0 && head === started);",
                "if (!Number.isSafeInteger(version) || version < 1) throw new Error('a final viewer page needs its signed report version');",
                "nextCursor: typeof page?.nextCursor === 'string' ? clinicianViewerCursor(key, uid, version, page.nextCursor) : null };"):
            self.assertIn(fragment, self.policy, fragment)
        contract = FIXTURES["read_contract"]
        self.assertEqual(int(re.search(r"export const CLINICIAN_VIEWER_CURSOR_MAX = (\d+);", self.policy).group(1)),
                         contract["viewer_cursor_max"])
        # the final page names its version; the withheld answer keeps exactly its four keys
        self.assertIn("return { uid, final: true, reportVersion: version, items,", self.policy)
        self.assertIn("return { uid, final: false, items: null, nextCursor: null };", self.policy)
        self.assertEqual(sorted(contract["viewer_page_keys"]), sorted(contract["viewer_withheld_keys"] + ["reportVersion"]))
        # the radiologist path is untouched: the unsigned statement and the bare item id as its cursor
        self.assertIn("return clinicianOnly(c.roles) ? this.clinicianItems(uid, query, c) : this.svc.list(uid, query, c);", viewer)
        self.assertIn("return this.read(uid, query, c, id, null);", items)
        self.assertIn("return { items, nextCursor: pageRow.rows.length > page.limit ? items[items.length - 1].id : null,", items)


if __name__ == "__main__":
    unittest.main(verbosity=2)
