# coding: utf-8
"""S5-U1a clinician role and clinician-only default denial, S5-U1b read allowlist: pure stdlib spec and source check.

REQ-S5-U1a-ROLE-DEFAULT-DENY -> RISK-S5-CLINICIAN-WRITER-LEAK/UNCLASSIFIED-ROUTE/ROLE-LIST-DRIFT
-> TEST-S5-U1a-CLINICIAN-POLICY (this file) and TEST-S5-U1a-CLINICIAN-LIVE (clinician_policy_live.py).
REQ-S5-U1b-CLINICIAN-READ -> RISK-S5-U1b-DRAFT-LEAK/NONFINAL-BODY/WRITER-FIELD/COUNT-LEAK/TENANT-UID
-> this file (allowlist == fixture, declared additions only, source pins), TEST-S5-U1b-PURE
(clinician_read_serializer_test.cjs) and TEST-S5-U1b-LIVE (clinician_read_live.py).
REQ-S5-U1c-ROUTE-COMPLETENESS -> RISK-S5-U1c-NEW-ROUTE-LEAK/MIXED-DOWNGRADE -> TEST-S5-U1c-INVENTORY (test_05, test_11-15
here) and TEST-S5-U1c-LIVE-MATRIX (clinician_policy_live.py test_01/test_04/test_05): every controller route has exactly one
route_matrix row, nothing is denied by subtraction, and review notes D3/D5/D6/D8 of S5-U1a are closed by pins.

No Node, no Nest, no browser, no stack. Three kinds of evidence and nothing more:
  1. tests/clinician_policy_fixtures.json judged by an independent Python model of the guard rules
     (member state, clinician-only detection, gateway identity closure, route key from Nest metadata,
     allowlist decision). The shipped TypeScript is judged against the same fixtures only by the hosted
     live module; a green run here is a spec check, not runtime proof of the TS.
  2. The current controller decorator inventory (own parser: decorator runs, so a @Public() belongs to the handler it
     decorates, same decorator table as invariants_live) compared with the invariants_live ROUTES table read as text,
     with the 104-row planning baseline and with the route matrix: every current route is public, a listed session or
     business row, or a denied row with a named basis, and every route added since the baseline has its own row.
  3. Source pins that guard, member console, Keycloak client and realm carry the same role list and that
     the gate sits between the membership check and the CSRF rule in the guard.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from collections import Counter
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
LIVE_MODULE = ROOT / "tests" / "clinician_policy_live.py"
LOCKFILE = ROOT / "api" / "package-lock.json"
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))

APP_ROLES = set(FIXTURES["app_roles"])
LEGACY_ROLES = set(FIXTURES["legacy_roles"])
CLINICIAN = FIXTURES["clinician_role"]
KIN_ROLES = APP_ROLES | {"gateway"}
ALLOWED = set(FIXTURES["session_routes"]) | set(FIXTURES["business_routes"])
PUBLIC = set(FIXTURES["public_routes"])
METHOD_ENUM = {int(k): v for k, v in FIXTURES["request_method_enum"].items()}
BASELINE = set(FIXTURES["baseline_inventory"]["routes"])
SESSION = set(FIXTURES["session_routes"])
BUSINESS = set(FIXTURES["business_routes"])
MATRIX = FIXTURES["route_matrix"]
DENIED_GROUPS = MATRIX["denied"]
DENIED_ROUTES = {route for routes in DENIED_GROUPS.values() for route in routes}


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
ROUTE_NAMES = "|".join(map(re.escape, HTTP_DECORATORS))
ROUTE_TEXT = re.compile(rf"@({ROUTE_NAMES})\(\s*(?:(['\"])(.*?)\2)?\s*\)", re.S)
DECORATOR_START = re.compile(r"@([A-Za-z_]\w*)\(")


def call_end(source, open_paren):
    """Offset just past the ')' that closes source[open_paren]; parentheses inside string literals do not count."""
    depth, quote, index = 0, None, open_paren
    while index < len(source):
        char = source[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    raise AssertionError(f"unbalanced decorator call at offset {open_paren}")


def decorator_runs(source):
    """Decorators separated only by whitespace are one run: {'kind', 'items': [(name, start, end)]}.

    A run right after '(' or ',' decorates a parameter, one followed by `class` decorates the class, any other
    decorates a member. Reading runs, not the text between two route decorators, is what attributes a @Public()
    to the handler it sits on whatever the order (S5-U1c D5).
    """
    runs, cursor = [], 0
    while (first := DECORATOR_START.search(source, cursor)) is not None:
        items, at = [], first.start()
        while (match := DECORATOR_START.match(source, at)) is not None:
            end = call_end(source, match.end() - 1)
            items.append((match.group(1), match.start(), end))
            at = end
            while at < len(source) and source[at].isspace():
                at += 1
        before = source[:first.start()].rstrip()
        after = source[items[-1][2]:].lstrip()
        if before.endswith(("(", ",")):
            kind = "parameter"
        elif re.match(r"(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\b", after):
            kind = "class"
        else:
            kind = "member"
        runs.append({"kind": kind, "items": items})
        cursor = items[-1][2]
    return runs


def controller_handlers(path, source):
    """[(method, child path, public, offset)] per handler; raises on a decorator shape the inventory could misread."""
    handlers = []
    for run in decorator_runs(source):
        names = [name for name, _start, _end in run["items"]]
        routes = [item for item in run["items"] if item[0] in HTTP_DECORATORS]
        publics = [index for index, name in enumerate(names) if name == "Public"]
        if run["kind"] != "member":
            if routes or publics:
                raise AssertionError(f"{path.name}: route or @Public() decorator on a {run['kind']}: {names}")
            continue
        if not routes:
            if publics:
                raise AssertionError(f"{path.name}: @Public() on a member without a route decorator: {names}")
            continue
        if len(routes) != 1 or len(publics) > 1:
            raise AssertionError(f"{path.name}: one handler carries {names}")
        name, start, end = routes[0]
        parsed = ROUTE_TEXT.fullmatch(source, start, end)
        if parsed is None:
            raise AssertionError(f"{path.name}: unreadable route decorator {source[start:end]!r}")
        # the order the four public handlers use; Nest would accept either, the pin keeps one reading of the file
        if publics and publics[0] > names.index(name):
            raise AssertionError(f"{path.name}: @Public() must sit above its route decorator: {names}")
        handlers.append((HTTP_DECORATORS[name], (parsed.group(3) or "").strip("/"), bool(publics), start))
    return handlers


def previous_public_attribution(source):
    """S5-U1a's reading, kept only as the D5 control: a @Public() between two route decorators went to the later one."""
    out, previous = {}, 0
    for match in re.finditer(rf"@({ROUTE_NAMES})\(\s*(?:(['\"])(.*?)\2)?\s*\)", source):
        out[match.group(3) or ""] = "@Public()" in source[previous:match.start()]
        previous = match.end()
    return out


def controller_inventory():
    """(method, route) -> {'file', 'public'}; raises when a decorator shape cannot be read."""
    route_call = re.compile(rf"@({ROUTE_NAMES}|RequestMapping)\s*\(")
    prefix_re = re.compile(r"@Controller\(\s*(?:(['\"])(.*?)\1)?\s*\)")
    found = {}
    for path in sorted(API.rglob("*.controller.ts")):
        source = path.read_text(encoding="utf-8")
        prefixes = list(prefix_re.finditer(source))
        if len(prefixes) != 1:
            raise AssertionError(f"{path.name}: expected one readable @Controller(), found {len(prefixes)}")
        prefix = (prefixes[0].group(2) or "").strip("/")
        handlers = controller_handlers(path, source)
        read = {offset for *_rest, offset in handlers}
        unparsed = [m.group(0) for m in route_call.finditer(source) if m.start() not in read]
        if unparsed:
            raise AssertionError(f"{path.name}: unreadable HTTP decorators {unparsed}")
        for method, child, public, _offset in handlers:
            route = "/".join(part for part in (prefix, child) if part)
            key = (method, route)
            if key in found:
                raise AssertionError(f"duplicate route {key}")
            found[key] = {"file": path.name, "public": public}
    return found


def manifest_rows():
    """The invariants_live ROUTES keys in file order; a repeated key would be collapsed silently by the dict."""
    text = MANIFEST.read_text(encoding="utf-8")
    start = text.index("ROUTES: dict[tuple[str, str], Route] = {")
    end = text.index("\n}\n", start)
    return re.findall(r'\("([A-Z]+)", "([^"]+)"\): Route\(', text[start:end])


def manifest_routes():
    return set(manifest_rows())


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

    def test_05_every_route_has_exactly_one_matrix_row_and_the_counts_reconcile(self):
        """REQ-S5-U1c-ROUTE-COMPLETENESS / RISK-S5-U1c-NEW-ROUTE-LEAK: controllers - rows = {} and rows - controllers = {}."""
        inventory = controller_inventory()
        keys = {m + " " + p for m, p in inventory}
        public = {m + " " + p for (m, p), meta in inventory.items() if meta["public"]}
        self.assertEqual(public, PUBLIC, "the public four must stay exactly these")
        self.assertEqual(self.guard.count("SetMetadata('public', true)"), 1)
        listed = Counter(route for routes in (FIXTURES["public_routes"], FIXTURES["session_routes"],
                                              FIXTURES["business_routes"], *DENIED_GROUPS.values()) for route in routes)
        self.assertEqual(sorted(route for route, n in listed.items() if n > 1), [], "a route has more than one matrix row")
        rows = set(listed)
        self.assertEqual(sorted(keys - rows), [], "controller routes without a route_matrix row: classify each one "
                         "(session/business with a live case, or a denied basis); nothing is denied by subtraction")
        self.assertEqual(sorted(rows - keys), [], "route_matrix rows without a controller route")
        # D8: the same route set in the controllers, the invariants_live ROUTES table and this matrix, in both directions
        manifest = {m + " " + p for m, p in manifest_rows()}
        self.assertEqual(sorted(keys - manifest), [], "controller routes missing from invariants_live ROUTES")
        self.assertEqual(sorted(manifest - keys), [], "invariants_live ROUTES rows without a controller route")
        counts = {"routes": len(inventory), "public": len(PUBLIC), "session": len(SESSION), "business": len(BUSINESS),
                  "denied": len(DENIED_ROUTES)}
        self.assertEqual(counts, MATRIX["counts"], "route_matrix counts are the reconciled numbers of this head")
        self.assertEqual(len(manifest_rows()), counts["routes"])
        self.assertEqual(counts["routes"], counts["public"] + counts["session"] + counts["business"] + counts["denied"])
        self.assertEqual(set(DENIED_GROUPS), set(MATRIX["basis_legend"]), "every denied row names a basis of the legend")
        self.assertTrue(all(DENIED_GROUPS.values()))
        # the model's decision on every row: session and business pass, every denied row is refused
        self.assertTrue(ALLOWED.isdisjoint(PUBLIC) and ALLOWED.isdisjoint(DENIED_ROUTES))
        for key in sorted(keys - PUBLIC):
            self.assertEqual(allowed(key), key in ALLOWED, key)
        # every route added since the 104-row baseline has its own row with decision, unit, commit and basis
        added = sorted(keys - BASELINE)
        removed = sorted(BASELINE - keys)
        self.assertEqual(removed, [], "a baseline route disappeared; re-check the planning inventory")
        post = MATRIX["post_baseline"]
        self.assertEqual(sorted(post), added, "exactly the routes added since the baseline carry a post_baseline row")
        where = {**{r: "public" for r in PUBLIC}, **{r: "session" for r in SESSION}, **{r: "business" for r in BUSINESS},
                 **{r: "denied" for r in DENIED_ROUTES}}
        for key, row in sorted(post.items()):
            with self.subTest(post_baseline=key):
                self.assertEqual(set(row), {"decision", "unit", "commit", "basis"})
                self.assertEqual(row["decision"], where[key], "the post_baseline decision is the row the route sits in")
                self.assertRegex(row["commit"], r"^[0-9a-f]{7,40}$")
                self.assertRegex(row["unit"], r"^S[0-9]-")
                self.assertGreater(len(row["basis"].strip()), 20)
                self.assertEqual(allowed(key), row["decision"] in ("session", "business"))
        declared = set(FIXTURES["allowed_additions"])
        self.assertEqual({k for k, row in post.items() if row["decision"] == "business"}, declared)
        self.assertTrue(declared <= ALLOWED)
        for key in FIXTURES["must_stay_denied"]:
            self.assertIn(key, DENIED_ROUTES, f"{key} carries drafts, writer fields or non-final bodies")
        print("CLINICIAN_POLICY_INVENTORY " + json.dumps({
            "counts": counts, "public": sorted(public), "allowed": sorted(ALLOWED),
            "denied_by_basis": {basis: len(routes) for basis, routes in sorted(DENIED_GROUPS.items())},
            "baseline_routes": len(BASELINE), "removed_since_baseline": removed,
            "newly_classified": {key: post[key]["decision"] for key in added},
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

    def test_11_decorator_runs_attribute_public_to_the_handler_it_decorates(self):
        """S5-U1c D5. The S5-U1a reading gave a @Public() found between two route decorators to the later route."""
        def read(source):
            return [handler[:3] for handler in controller_handlers(Path("sample.controller.ts"), source)]

        above = "@Controller('x')\nexport class A {\n  @Public()\n  @Get('a')\n  a() {}\n\n  @Get('b')\n  b() {}\n}\n"
        self.assertEqual(read(above), [("GET", "a", True), ("GET", "b", False)])
        one_line = ("@Controller()\nexport class A{constructor(private s: S){}\n"
                    "  @Get('a') a(@Req() r:any,@Query() q:any){return this.s.a(r, q);}\n"
                    "  @Post() @HttpCode(200)\n  b(@Body() b:any, @Res({ passthrough: true }) res:any){}\n}\n")
        self.assertEqual(read(one_line), [("GET", "a", False), ("POST", "", False)])
        below = "@Controller()\nexport class A {\n  @Get('a')\n  @Public()\n  a() {}\n\n  @Get('b')\n  b() {}\n}\n"
        # control: the previous reading marks b public and a not — the opposite of what Nest applies
        self.assertEqual(previous_public_attribution(below), {"a": False, "b": True})
        refused = {
            "public below its route": below,
            "public on the class": "@Public()\n@Controller()\nexport class A {\n  @Get('a')\n  a() {}\n}\n",
            "public without a route": "@Controller()\nexport class A {\n  @Public()\n  helper() {}\n}\n",
            "public on a parameter": "@Controller()\nexport class A {\n  @Get('a')\n  a(@Public() x: any) {}\n}\n",
            "two route decorators": "@Controller()\nexport class A {\n  @Get('a')\n  @Post('a')\n  a() {}\n}\n",
            "computed path": "@Controller()\nexport class A {\n  @Get(PATH)\n  a() {}\n}\n",
        }
        for label, source in refused.items():
            with self.subTest(refused=label), self.assertRaises(AssertionError):
                controller_handlers(Path("sample.controller.ts"), source)
        # the real controllers: each public handler's own run is exactly @Public() directly above its route decorator
        found = []
        for path in sorted(API.rglob("*.controller.ts")):
            for run in decorator_runs(path.read_text(encoding="utf-8")):
                names = [name for name, _start, _end in run["items"]]
                if "Public" in names:
                    self.assertEqual((run["kind"], len(names), names[0]), ("member", 2, "Public"), path.name)
                    self.assertIn(names[1], HTTP_DECORATORS, path.name)
                    found.append(path.name)
        self.assertEqual(sorted(found), ["auth.controller.ts"] * 3 + ["pacs.controller.ts"])

    def test_12_inventory_readers_see_every_route_decorator_and_method(self):
        """S5-U1c D6 (RequestMethod members, unreadable decorators) and D8 (the invariants_live reader)."""
        known = set(HTTP_DECORATORS) | set(FIXTURES["controller_decorators"]["non_route"])
        seen = set()
        for path in sorted(API.rglob("*.controller.ts")):
            for run in decorator_runs(path.read_text(encoding="utf-8")):
                seen |= {name for name, _start, _end in run["items"]}
        self.assertEqual(sorted(seen - known), [], "a controller decorator the inventory neither reads nor classifies")
        for path in sorted(API.rglob("*.ts")):
            if path.name.endswith(".controller.ts"):
                continue
            with self.subTest(outside=path.name):
                self.assertIsNone(re.search(rf"@(Controller|RequestMapping|{ROUTE_NAMES})\s*\(", path.read_text(encoding="utf-8")),
                                  "a controller or route outside *.controller.ts is invisible to both inventories")
        # the model knows every method the inventory can produce; a number it does not know fails closed, and the
        # allowlist names only GET and POST, so a member the model lacks can never match a row in model or product
        pin = FIXTURES["request_method_pin"]
        lock = json.loads(LOCKFILE.read_text(encoding="utf-8"))
        self.assertEqual(lock["packages"]["node_modules/" + pin["package"]]["version"], pin["lock_version"],
                         "Nest moved: re-read RequestMethod of the new version, then update request_method_enum and this pin")
        self.assertEqual(sorted(METHOD_ENUM), list(range(len(METHOD_ENUM))))
        self.assertTrue(set(HTTP_DECORATORS.values()) <= set(METHOD_ENUM.values()))
        self.assertEqual({key.split(" ", 1)[0] for key in ALLOWED}, {"GET", "POST"})
        for number in (-1, *range(len(METHOD_ENUM), 64), 2 ** 31):
            with self.subTest(method=number):
                self.assertIsNone(route_key(number, "/", "me"))
                self.assertFalse(allowed(route_key(number, "/", "me")))
        self.assertIn("RequestMethod[method]", self.policy)
        # D8: invariants_live reads the same decorator table from the same files, and its ROUTES keys are unique
        text = MANIFEST.read_text(encoding="utf-8")
        table = re.search(r"\n    http_decorators = \{\n(.*?)\n    \}\n", text, re.S)
        self.assertIsNotNone(table)
        self.assertEqual(dict(re.findall(r'"(\w+)": "([A-Z]+)"', table.group(1))), HTTP_DECORATORS)
        self.assertIn('CONTROLLER_GLOB = "*.controller.ts"', text)
        self.assertIn("for path in sorted(controller_dir.rglob(CONTROLLER_GLOB)):", text)
        rows = manifest_rows()
        self.assertEqual(len(rows), len(set(rows)), "a repeated ROUTES key is collapsed silently by the dict")

    def test_13_role_composition_neither_downgrades_a_mixed_user_nor_widens_a_clinician(self):
        """RISK-S5-U1c-MIXED-DOWNGRADE in the model over every route, and the only narrowing sites in the source."""
        routes = {m + " " + p for m, p in controller_inventory()} - PUBLIC
        kinds, mixed = Counter(), set()
        for token in FIXTURES["tokens"]:
            if token["state"] != "APPROVED":
                continue
            app = {role for role in token["roles"] if role in APP_ROLES}
            only = clinician_only(token["roles"])
            kind = "clinician-only" if only else "mixed" if CLINICIAN in app else "legacy"
            kinds[kind] += 1
            if kind == "mixed":
                mixed |= app & LEGACY_ROLES
            with self.subTest(token=token["id"], kind=kind):
                self.assertEqual(only, app == {CLINICIAN})
                decisions = {key: ("allowed" if allowed(key) else "denied") if only else "legacy" for key in routes}
                if only:
                    self.assertEqual({k for k, d in decisions.items() if d == "allowed"}, ALLOWED)
                    self.assertEqual({k for k, d in decisions.items() if d == "denied"}, DENIED_ROUTES)
                else:
                    self.assertEqual(set(decisions.values()), {"legacy"}, "a legacy role keeps every existing path")
        self.assertEqual(set(kinds), {"clinician-only", "mixed", "legacy"})
        self.assertEqual(mixed, LEGACY_ROLES, "each legacy role is fixed alongside clinician")
        # clinicianOnly() is the one narrowing predicate, at the listed sites; a role-presence test would narrow a mixed user
        sites = {
            "auth.guard.ts": "req.clinicianOnly = clinicianOnly(req.roles);",
            "viewer.controller.ts": "return clinicianOnly(c.roles) ? this.clinicianItems(uid, query, c) : this.svc.list(uid, query, c);",
            "report-preview.controller.ts": "if (clinicianOnly(caller.roles)) throw new ForbiddenException({ code: CLINICIAN_ROUTE_DENIED });",
            "pacs.service.ts": "if (clinicianOnly(c.roles)) throw new ForbiddenException('전체 검사 통계를 열람할 수 없습니다');",
        }
        counted = {}
        for path in sorted(API.rglob("*.ts")):
            if path == POLICY:
                continue
            source = path.read_text(encoding="utf-8")
            calls = len(re.findall(r"\bclinicianOnly\(", source))
            if calls:
                counted[path.name] = calls
            self.assertIsNone(re.search(r"includes\(\s*(?:'clinician'|\"clinician\"|CLINICIAN_ROLE)\s*\)", source), path.name)
        self.assertEqual(counted, FIXTURES["role_composition"]["clinician_only_call_sites"])
        self.assertEqual(set(sites), set(counted))
        for name, line in sites.items():
            self.assertIn(line, (API / name).read_text(encoding="utf-8"), name)
        # the clinician reads admit a mixed user by role; they never require clinician-only
        self.assertIn("need(c.roles, CLINICIAN_ROLE, '임상의 조회');", (API / "pacs.service.ts").read_text(encoding="utf-8"))
        live = LIVE_MODULE.read_text(encoding="utf-8")
        self.assertIn("def " + FIXTURES["role_composition"]["live_test"] + "(self) -> None:", live)
        self.assertIn('"' + FIXTURES["role_composition"]["live_marker"] + ' "', live)

    def test_14_live_matrix_gives_every_allow_row_a_positive_a_wrong_role_and_a_wrong_tenant_case(self):
        """TEST-S5-U1c-LIVE-MATRIX is data here and one loop in clinician_policy_live.py test_05."""
        matrix = FIXTURES["live_matrix"]
        rows = matrix["rows"]
        self.assertEqual(set(rows), ALLOWED, "every allow row, and only the allow rows, has live cases")
        wanted = {"positive": {"allowed"}, "wrong_role": {"denied"}, "wrong_tenant": {"denied", "absent"}}
        exceptions = []
        for route, row in sorted(rows.items()):
            with self.subTest(route=route):
                self.assertEqual(set(row) - {"via"}, set(wanted))
                self.assertEqual(row["positive"]["as"], "clinician", "the positive is the clinician-only member of the study's institution")
                self.assertNotEqual(row["wrong_role"]["as"], "clinician")
                self.assertNotIn(row["wrong_tenant"]["as"], ("clinician", "doctor"))
                for name, expected in wanted.items():
                    case = row[name]
                    self.assertTrue({"as", "expect", "status", "code"} <= set(case), name)
                    self.assertIn(case["as"], matrix["identities"])
                    self.assertNotEqual(case["code"], FIXTURES["denied_code"], "an allow row is never answered by the clinician gate")
                    self.assertIn(case["status"], (200, 204) if case["expect"] in ("allowed", "absent") else (403, 404))
                    if case["expect"] not in expected:
                        exceptions.append((route, name, case["expect"]))
                        self.assertTrue(case.get("basis", "").startswith("by design"), f"{route} {name}")
        self.assertEqual(exceptions, [("POST auth/logout", "wrong_tenant", "allowed")], "the logout exception is the one by-design non-denial")
        for route in ("GET clinician/studies", "GET clinician/studies/:uid/report"):
            self.assertEqual(rows[route]["wrong_role"]["as"], "doctor", "need('clinician') meets the same-institution radiologist")
        # the live module drives these cases from the fixture and creates every identity they name
        live = LIVE_MODULE.read_text(encoding="utf-8")
        self.assertIn("def " + matrix["test"] + "(self) -> None:", live)
        self.assertIn('LIVE_MATRIX = FIXTURES["live_matrix"]', live)
        self.assertIn('"' + matrix["marker"] + ' "', live)
        self.assertIn('cls.stack.create_test_identity("kclinician", ["clinician"], "kin-center")', live)
        self.assertIn('self.create_member("cinvalid", ["clinician"], ["hallym", "kin-center"])', live)
        self.assertIn('self.stack.service_token("gateway")', live)
        # test_01 probes every controller route that is neither public nor allowed, then requires exactly the denied rows
        self.assertIn('DENIED_ROUTES = {route for routes in FIXTURES["route_matrix"]["denied"].values() for route in routes}', live)
        self.assertIn("self.assertEqual(sorted(swept), sorted(DENIED_ROUTES)", live)

    def test_15_invariants_member_summary_reads_the_policy_role_list(self):
        """S5-U1c D3: kc_user_summary compares Keycloak's roles with the product APP_ROLES, not a local literal."""
        text = MANIFEST.read_text(encoding="utf-8")
        function = re.search(r"\ndef policy_app_roles\(\) -> frozenset\[str\]:\n.*?(?=\n\n\n)", text, re.S)
        summary = re.search(r"\n    def kc_user_summary\(self, user_id: str\).*?(?=\n\n    def )", text, re.S)
        self.assertIsNotNone(function)
        self.assertIsNotNone(summary)
        self.assertIn("app = policy_app_roles()", summary.group(0))
        self.assertNotIn("radiologist", summary.group(0), "no local role literal")

        def run(root):
            namespace = {"ROOT": root, "re": re}
            exec(compile(function.group(0), str(MANIFEST), "exec"), namespace)
            return namespace["policy_app_roles"]()

        self.assertEqual(run(ROOT), frozenset(FIXTURES["app_roles"]))
        # controls on a copy: a changed APP_ROLES shape is refused instead of read as a partial set; a new role arrives
        with tempfile.TemporaryDirectory() as scratch:
            copy = Path(scratch) / "api" / "src" / "clinician-policy.ts"
            copy.parent.mkdir(parents=True)
            for label, old, new in (
                    ("clinician dropped from APP_ROLES", "new Set([...LEGACY_APP_ROLES, CLINICIAN_ROLE])", "new Set([...LEGACY_APP_ROLES])"),
                    ("legacy list not frozen", "Object.freeze(['radiologist', 'technician', 'admin'])", "['radiologist', 'technician', 'admin']")):
                self.assertIn(old, self.policy, label)
                copy.write_text(self.policy.replace(old, new), encoding="utf-8")
                with self.subTest(control=label), self.assertRaises(AssertionError):
                    run(Path(scratch))
            copy.write_text(self.policy.replace("'technician', 'admin']", "'technician', 'admin', 'nurse']"), encoding="utf-8")
            self.assertEqual(run(Path(scratch)), frozenset(FIXTURES["app_roles"]) | {"nurse"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
