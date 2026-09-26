# coding: utf-8
"""REQ-S5-U3-PATIENT-TIMELINE -> RISK-S5-U3-NAME-MERGE / ID-ONLY-IDENTITY / TENANT -> TEST-S5-U3-DOM.

The shipped Clinician Home (clinician.html + clinician.js + auth.js), loaded unchanged (or as a named control variant) from
a synthetic origin, against S5-U1b-shaped list and report answers and S5-U3 timeline answers
(GET clinician/studies/:uid/timeline?limit=100[&after=<signed cursor>], shaped like api/src/clinician-policy.ts
clinicianTimeline: uid, patientKey, identity {conflict, birth, sex}, studies[list row + identity {birth, sex}],
serverTime, pagination). The harness's timeline answer groups by the server patient key only and computes the relations
from per-study source values the rows never carry; every assertion below names the expected output literally.

  01  the timeline place exists only for a study whose server patient key another listed study shares (never for a
      keyless study, a same-name patient, or a tele study of another institution with the same original ID), sits after
      Key Images and before the viewer line, and nothing is requested until Show Timeline. Control: the same file with
      the timeline open from the start requests on every selection (what the U2a/U2b harnesses would refuse).
  02  rows are the server's members, newest first, each with study date, modality, description, report status, source
      institution (Tele tagged), displayed name / ID / birth / sex, and View (Viewing for the current study, disabled with
      a Korean reason for a study the list does not hold); external strings stay text.
  03  the identity conflict marker: birth only, sex only, both, not comparable, match; row tags on the studies whose source
      value differs from the selected study. Control: the same file comparing the displayed (overlay) values instead of
      the server's source relation misses a source conflict hidden by an overlay and raises one an overlay made up.
  04  states: loading, failed as sent (404, 409 with code, 403 guard code, 400) with Retry, malformed answers refused
      whole (another anchor, a row of another key, an inconsistent conflict flag, the anchor missing, a relation on one
      study, a row without a relation), empty, no key, Hide / Show, and a 401 that ends the session. Control: the same
      file without the row key check paints another patient's study in the timeline.
  05  paging: limit=100, the signed cursor verbatim, progress text, and pages whose relations disagree refused whole.
  06  A->B->A, a list refresh and a log out while a timeline read is pending: a late answer never paints. Control: the
      same file checking only the selected UID paints the first A answer over the second.
  07  View selects that study (list row, report read, timeline read again for the new anchor, focus on the toggle); once
      opened the timeline follows later selections, closed it does not; keyboard Enter on the toggle.
  08  English controls / state names, Korean explanations and tooltips, no avoided or acknowledgement words, text >= 12px,
      hit targets >= 24px, aria wiring.

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case. The server half is tests/clinician_timeline_live.py (hosted synthetic stack only).
"""
import copy
from pathlib import Path
import re
import time
import unicodedata
import unittest
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ORIGIN = "https://clinician.test"
BASE = "/worklist/hpacs-lite/"
SHIPPED = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "auth.js")}
EMBLEM = (HPACS / "kin-emblem-j1.svg").read_bytes()
INDEX_STAND_IN = ('<!doctype html><html><head><meta charset="utf-8"><title>SYN index stand-in</title></head>'
                  '<body><p id="stand-in">SYN index stand-in</p></body></html>')

INST_A, INST_B = "SYN-INST-A", "SYN-INST-B"
ME = {"sub": "SYN-CLIN-SUB", "actor": "syn-clinician", "roles": ["clinician", "default-roles-kin", "offline_access"],
      "institution": INST_A, "kind": "member", "user": "syn-clinician", "displayName": "SYN Clinician"}
PREFIX = "1.2.826.0.1.3680043.10.5432"


def uid(n):
    return f"{PREFIX}.{n}"


def key(inst, pid):
    return f"{inst}|{pid}"


HOSTILE = '<img src=x onerror="document.body.dataset.pwned=1">'
FINAL = {"final": True, "rs": "A", "action": "approve", "version": 4, "repDoc": "syn-rad", "confirm": "2026-09-20"}
ADDENDUM = {"final": True, "rs": "A", "action": "addendum", "version": 2, "repDoc": "syn-rad", "confirm": "2023-12-01"}
OPEN = {"final": False, "rs": "W"}
PRELIM = {"final": False, "rs": "P"}

A, P1, P2, N, T, T2, K, S, X = (uid(n) for n in range(31, 40))


def study(u, name, pid, patient, date, report, **extra):
    row = {"uid": u, "id": pid, "name": name, "birth": "19800517", "sex": "M", "date": date, "acc": f"SYN-ACC-{u[-2:]}",
           "desc": f"SYN DESC {u[-2:]}", "modality": "CT", "count": 10, "series": 1, "sourcePatientKey": patient,
           "institutionName": "SYN Hospital A", "tele": False, "report": report}
    row.update(extra)
    return row


ROWS = [
    study(A, "SYN KIM", "SYN-P-100", key(INST_A, "SYN-P-100"), "20260320", FINAL),
    study(P1, "SYN KIM", "SYN-P-100", key(INST_A, "SYN-P-100"), "20250101", PRELIM, desc=HOSTILE),
    # The same server key; a technician's overlay changed what is displayed.
    study(P2, "SYN KIM (EDITED)", "SYN-P-100-EDIT", key(INST_A, "SYN-P-100"), "20240101", OPEN, modality="MR"),
    # Same name, another patient of the same institution.
    study(N, "SYN KIM", "SYN-P-200", key(INST_A, "SYN-P-200"), "20260101", OPEN),
    # Tele studies of another institution with the same original PatientID: a key of their own.
    study(T, "SYN KIM", "SYN-P-100", key(INST_B, "SYN-P-100"), "20251115", OPEN, tele=True, institutionName="SYN Hospital B"),
    study(T2, "SYN KIM", "SYN-P-100", key(INST_B, "SYN-P-100"), "20231115", ADDENDUM, tele=True,
          institutionName="SYN Hospital B"),
    study(K, "SYN NOKEY", "", None, "20250601", OPEN),
    study(S, "SYN SOLO", "SYN-P-400", key(INST_A, "SYN-P-400"), "20250301", OPEN),
]
# In the server's timeline for A but not in the loaded list (it arrived after the list was read).
EXTRA = [study(X, "SYN KIM", "SYN-P-100", key(INST_A, "SYN-P-100"), "20220101", OPEN)]

NOT_FOUND = (404, {"statusCode": 404, "message": "검사를 찾을 수 없습니다", "error": "Not Found"})
CHANGED = (409, {"code": "STUDY_LIST_CHANGED", "message": "검사 목록 또는 판독 상태가 바뀌었습니다. 새로고침하세요."})
ROUTE_DENIED = (403, {"code": "CLINICIAN_ROUTE_DENIED"})
NO_LIMIT = (400, {"statusCode": 400, "message": "타임라인은 limit(1~100)으로 쪽을 나눠 읽습니다", "error": "Bad Request"})
EXPIRED = (401, {"statusCode": 401, "message": "인증 정보가 없습니다"})

# Product wording, verbatim (clinician.js TIMELINE).
HINT = ("지금 목록에 같은 환자 키(기관과 원본 DICOM 환자 ID)의 다른 검사가 {n}건 있습니다. "
        "Show Timeline은 서버가 이 키로 묶은 검사 전부를 출처 기관·검사일과 함께 읽습니다. "
        "이름이나 화면에서 고친 환자 ID로는 묶지 않고, 원본 생년월일·성별이 서로 다르면 표시합니다.")
LOADING = "환자 타임라인을 불러오는 중입니다…"
FAILED = "환자 타임라인을 불러오지 못했습니다."
MALFORMED = "타임라인 응답 형식을 확인할 수 없습니다. 새로고침하세요."
READY = "같은 환자 키의 검사 {n}건을 검사일 최신순으로 표시합니다."
EMPTY = "같은 환자 키의 다른 검사가 없습니다."
NO_KEY = "이 검사에는 서버 환자 키가 없어 다른 검사와 묶지 않습니다."
CONFLICT = "같은 환자 키로 묶인 검사 사이에 원본 DICOM {f}이 서로 다릅니다. 같은 사람의 검사인지 확인한 뒤 비교하세요."
UNKNOWN = "일부 검사는 원본 DICOM {f}이 없거나 형식이 달라 비교하지 못했습니다."
BIRTH_TIP = "원본 DICOM 생년월일이 선택한 검사와 다릅니다."
SEX_TIP = "원본 DICOM 성별이 선택한 검사와 다릅니다."
NOT_LISTED = "이 검사는 지금 목록에 없어 열 수 없습니다. 목록을 새로고침하세요."
TELE_TIP = "원격판독으로 의뢰받은 검사입니다."
CLOSING = "세션을 닫았습니다. 로그인 화면으로 이동하는 중입니다…"

# UXR-SP-34 / UXR-G-18 avoided words and UXR-S5-15 acknowledgement words (as tests/clinician_home_dom_test.py).
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
ACKNOWLEDGED = re.compile(r"\bACK\b|acknowledg|\bsent\b|deliver|수신 확인|열어봄|읽음|전달됨", re.IGNORECASE)

TIMELINE_VIEW = """() => { const s = document.querySelector('#timeline'); if (!s) return null;
  const q = sel => s.querySelector(sel), state = q('#timeline-state'), conflict = q('#timeline-conflict');
  return {uid: s.dataset.uid, toggle: q('#timeline-toggle').textContent, expanded: q('#timeline-toggle').getAttribute('aria-expanded'),
    bodyHidden: q('#timeline-body').hidden, hint: s.querySelector(':scope > p.muted').textContent,
    state: state.dataset.state, text: state.querySelector('.state-text').textContent,
    detail: state.querySelector('.state-detail').textContent, retry: !q('#timeline-retry').hidden,
    conflict: conflict.hidden ? null : [conflict.querySelector('.state-text').textContent, conflict.querySelector('.state-detail').textContent],
    note: q('#timeline-note').hidden ? null : q('#timeline-note').textContent, listHidden: q('#timeline-list').hidden,
    items: [...s.querySelectorAll('#timeline-list > li')].map(li => { const b = li.querySelector('button');
      return {uid: li.dataset.uid, current: li.getAttribute('aria-current'),
        lines: [...li.querySelectorAll(':scope > p')].map(p => p.textContent),
        tags: [...li.querySelectorAll('.tag')].map(t => [t.textContent, t.title]),
        button: [b.textContent, b.disabled, b.title]}; })}; }"""
ITEM_UIDS = "() => [...document.querySelectorAll('#timeline-list > li')].map(li => li.dataset.uid)"
DETAIL_ORDER = """() => [...document.querySelectorAll('#detail > *')].map(e => e.id)
  .filter(id => ['identity', 'report', 'keys', 'timeline', 'viewer-slot', 'compare'].includes(id))"""


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def relation(values):
    """The harness server's rule (clinician-policy.ts clinicianIdentityRelation); outputs are asserted literally below."""
    known = [value for value in values if value]
    if len(set(known)) > 1:
        return "mismatch"
    return "match" if len(values) > 1 and len(known) == len(values) else "not_comparable"


def variant(source, edits, label):
    for old, new in edits:
        found = source.count(old)
        if found != 1:
            raise AssertionError(f"setup: {old!r} occurs {found} times in {label}, expected 1")
        source = source.replace(old, new)
    return source


OPEN_FLAG = "  let timelineOpen = false;\n"
FRESH = "    return !leaving && mine === timelineSeq && selected === uid;\n"
KEY_CHECK = ("      if ((key === null ? row.uid !== uid : patientKey(row) !== key)\n"
             "          || !mark || typeof mark !== 'object'")
BANNER = "    if (head.conflict) {\n"


class ClinicianTimelineDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        home = SHIPPED["clinician.js"]
        cls.variants = {
            "auto-load": variant(home, [(OPEN_FLAG, "  let timelineOpen = true;\n")], "clinician.js"),
            "uid-only": variant(home, [(FRESH, "    return !leaving && selected === uid;\n")], "clinician.js"),
            "no-key-check": variant(home, [(KEY_CHECK, "      if (!mark || typeof mark !== 'object'")], "clinician.js"),
            "display-compare": variant(home, [(BANNER, "    if (rows.some(other => other.birth !== rows[0].birth"
                                                       " || other.sex !== rows[0].sex)) {\n")], "clinician.js"),
        }
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.rows = copy.deepcopy(ROWS)
        self.extra = copy.deepcopy(EXTRA)
        # Source (original DICOM) birth / sex after the server's comparison rule; '' is not comparable.
        self.source = {}
        self.files = dict(SHIPPED)
        self.list_cursors, self.timeline_cursors = {}, {}
        self.timeline_requests, self.report_requests, self.logouts = [], [], []
        self.timeline_errors, self.timeline_patch = [], None
        self.hold_timeline, self.held_timelines = False, []
        self.held_logouts = None
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 1000})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", self.on_dialog)
        self.page.on("requestfinished", lambda request: self.finished.append(request))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")

    def on_dialog(self, dialog):
        self.dialogs.append(f"{dialog.type}: {dialog.message}")
        dialog.dismiss()

    # ── synthetic origin ──
    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        if method == "GET" and path.startswith(BASE):
            name = path[len(BASE):]
            if name == "index.html":
                route.fulfill(body=INDEX_STAND_IN, content_type="text/html; charset=utf-8")
                return
            if name in self.files:
                kind = "text/html" if name.endswith(".html") else "application/javascript"
                route.fulfill(body=self.files[name], content_type=f"{kind}; charset=utf-8")
                return
            if name == "kin-emblem-j1.svg":
                route.fulfill(body=EMBLEM, content_type="image/svg+xml")
                return
        if path.startswith("/kin-brand/") or path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if path.startswith("/api/") and request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(json=ME)
            return
        query = parse_qs(url.query, keep_blank_values=True)
        if method == "GET" and path == "/api/clinician/studies":
            if set(query) - {"limit", "after"} or query.get("limit") != ["100"] or len(query.get("after", [""])) != 1:
                self.unexpected.append(f"{method} {request.url}")
                route.abort()
                return
            route.fulfill(**self.list_reply(query.get("after", [None])[0]))
            return
        found = re.fullmatch(r"/api/clinician/studies/([^/]+)/report", path)
        if method == "GET" and found and not url.query:
            target = unquote(found.group(1))
            self.report_requests.append(target)
            row = next((row for row in self.rows if row["uid"] == target), None)
            if row is None:
                route.fulfill(status=NOT_FOUND[0], json=NOT_FOUND[1])
                return
            report = {**row["report"], "findings": "SYN findings", "conclusion": "", "recommendation": ""} \
                if row["report"]["final"] else row["report"]
            route.fulfill(json={"uid": target, "report": report, "keys": [] if row["report"]["final"] else None})
            return
        found = re.fullmatch(r"/api/clinician/studies/([^/]+)/timeline", path)
        if method == "GET" and found:
            anchor = unquote(found.group(1))
            if set(query) - {"limit", "after"} or query.get("limit") != ["100"] or len(query.get("after", [""])) != 1:
                self.unexpected.append(f"{method} {request.url}")
                route.abort()
                return
            self.timeline_requests.append((anchor, query))
            if self.hold_timeline:
                self.held_timelines.append((anchor, query, route))
                return
            route.fulfill(**self.timeline_reply(anchor, query))
            return
        if method == "POST" and path == "/api/auth/logout":
            self.logouts.append(request.headers.get("x-kin-csrf"))
            if self.held_logouts is not None:
                self.held_logouts.append(route)
                return
            route.fulfill(status=204, body="")
            return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    def list_reply(self, after):
        # study-page.ts studyPageSlice: UID order, `next` only when rows remain, total = every visible study.
        ordered = sorted(self.rows, key=lambda row: row["uid"])
        if after is not None and after not in self.list_cursors:
            self.unexpected.append(f"unknown list cursor {after!r}")
            return {"status": CHANGED[0], "json": CHANGED[1]}
        start = 0 if after is None else self.list_cursors[after]
        picked = ordered[start:start + 100]
        following = None
        if start + len(picked) < len(ordered):
            following = f"eyJ2IjoxLCJTWU4iOnsibGlzdCI6{start + len(picked)}.SYN-list_{len(self.list_cursors)}-Q"
            self.list_cursors[following] = start + len(picked)
        return {"json": {"studies": copy.deepcopy(picked), "serverTime": "2026-09-26T00:00:00.000Z",
                         "pagination": {"next": following, "total": len(ordered), "offset": start, "limit": 100}}}

    def src(self, row):
        return self.source.get(row["uid"], ("19800517", "M"))

    def timeline_reply(self, anchor, query, patch=None):
        """The server's timeline for one anchor: same server patient key only (name, overlay and birth never group)."""
        if self.timeline_errors:
            status, body = self.timeline_errors.pop(0)
            return {"status": status, "json": body}
        pool = {row["uid"]: row for row in self.rows + self.extra}
        base = pool.get(anchor)
        if base is None:
            return {"status": NOT_FOUND[0], "json": NOT_FOUND[1]}
        after = query.get("after", [None])[0]
        if after is not None and self.timeline_cursors.get(after, (None,))[0] != anchor:
            self.unexpected.append(f"unknown timeline cursor {after!r} for {anchor}")
            return {"status": CHANGED[0], "json": CHANGED[1]}
        patient = base["sourcePatientKey"]
        members = [base] if patient is None else sorted(
            (row for row in pool.values() if row["sourcePatientKey"] == patient), key=lambda row: row["uid"])
        start = 0 if after is None else self.timeline_cursors[after][1]
        picked = members[start:start + 100]
        following = None
        if start + len(picked) < len(members):
            following = f"eyJ2IjoxLCJTWU4iOnsidGltZWxpbmUiOj{start + len(picked)}.SYN-tl_{len(self.timeline_cursors)}-Q"
            self.timeline_cursors[following] = (anchor, start + len(picked))
        birth = relation([self.src(row)[0] for row in members])
        sex = relation([self.src(row)[1] for row in members])
        mine = self.src(base)
        studies = [{**copy.deepcopy(row), "identity": {"birth": relation([mine[0], self.src(row)[0]]),
                                                       "sex": relation([mine[1], self.src(row)[1]])}} for row in picked]
        reply = {"uid": anchor, "patientKey": patient, "identity": {"conflict": "mismatch" in (birth, sex), "birth": birth,
                                                                     "sex": sex},
                 "studies": studies, "serverTime": "2026-09-26T00:00:00.000Z",
                 "pagination": {"next": following, "total": len(members), "offset": start, "limit": 100}}
        for change in [self.timeline_patch, patch]:
            if change:
                change(reply)
        return {"json": reply}

    # ── helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        # Sync-API route handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settle(self):
        self.page.evaluate("() => new Promise(resolve => setTimeout(resolve, 200))")

    def release(self, index, patch=None):
        anchor, query, route = self.held_timelines[index]
        request = route.request
        route.fulfill(**self.timeline_reply(anchor, query, patch))
        self.wait_until(lambda: any(item is request for item in self.finished), "the released answer reaching the page")
        self.settle()

    def open_home(self, script=None):
        # Every load names its file: a control variant never carries over into the next load of the shipped page.
        self.files["clinician.js"] = SHIPPED["clinician.js"] if script is None else script
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        expect(self.page.locator("#studies tr[data-uid]")).to_have_count(len(self.rows))

    def pick(self, u):
        self.page.locator(f'#studies tr[data-uid="{u}"]').click()
        expect(self.page.locator("#detail")).to_have_attribute("data-uid", u)
        expect(self.page.locator("#report-state")).not_to_have_attribute("data-state", "loading")

    def timeline(self):
        return self.page.evaluate(TIMELINE_VIEW)

    def settled_timeline(self, state):
        expect(self.page.locator("#timeline-state")).to_have_attribute("data-state", state)
        return self.timeline()

    def show(self, state="ready"):
        self.page.locator("#timeline-toggle").click()
        if state is None:
            return None
        return self.settled_timeline(state)

    def patch_studies(self, reply, rows):
        reply["studies"] = sorted(rows, key=lambda row: row["uid"])
        reply["pagination"]["total"] = len(reply["studies"])

    def with_identity(self, row, birth="match", sex="match"):
        return {**copy.deepcopy(row), "identity": {"birth": birth, "sex": sex}}

    # ── cases ──
    def test_01_the_place_exists_only_for_same_key_peers_and_nothing_is_read_until_opened(self):
        self.open_home()
        for lone in (S, K, N):
            with self.subTest(study=lone):
                self.pick(lone)
                self.assertIsNone(self.timeline(), "no same-key study in the list: no timeline place")
        self.pick(A)
        seen = self.timeline()
        self.assertEqual((A, "Show Timeline", "false", True, HINT.format(n=2), "idle"),
                         (seen["uid"], seen["toggle"], seen["expanded"], seen["bodyHidden"], seen["hint"], seen["state"]))
        # After Key Images and before the viewer line, so the marker is read before Open Viewer and Compare.
        self.assertEqual(["identity", "report", "keys", "timeline", "viewer-slot", "compare"], self.page.evaluate(DETAIL_ORDER))
        # The tele study has its own key (another institution): its place counts only its own institution's peer.
        self.pick(T)
        self.assertEqual((T, HINT.format(n=1)), (self.timeline()["uid"], self.timeline()["hint"]))
        self.pick(P1)
        self.assertEqual(HINT.format(n=2), self.timeline()["hint"])
        self.settle()
        self.assertEqual([], self.timeline_requests, "selecting studies reads no timeline until Show Timeline")

        seen = self.show()
        self.assertEqual([(P1, {"limit": ["100"]})], self.timeline_requests)
        self.assertEqual(("Hide Timeline", "true", False), (seen["toggle"], seen["expanded"], seen["bodyHidden"]))

        # Control: the same file with the timeline open from the start reads on every selection.
        self.timeline_requests = []
        self.open_home(self.variants["auto-load"])
        self.pick(A)
        self.wait_until(lambda: self.timeline_requests, "control: a timeline read on selection")
        self.assertEqual([(A, {"limit": ["100"]})], self.timeline_requests)
        self.settled_timeline("ready")

    def test_02_rows_are_the_server_members_newest_first_with_source_institution_and_date(self):
        self.open_home()
        self.pick(A)
        seen = self.show()
        self.assertEqual((READY.format(n=4), "", False, None, None, False),
                         (seen["text"], seen["detail"], seen["retry"], seen["conflict"], seen["note"], seen["listHidden"]))
        self.assertEqual([
            {"uid": A, "current": "true", "lines": ["2026-03-20 · CT · SYN DESC 31 Final", "SYN Hospital A",
                                                     "SYN KIM · SYN-P-100 · 1980-05-17 · M"],
             "tags": [], "button": ["Viewing", True, ""]},
            {"uid": P1, "current": None, "lines": [f"2025-01-01 · CT · {HOSTILE} Preliminary", "SYN Hospital A",
                                                    "SYN KIM · SYN-P-100 · 1980-05-17 · M"],
             "tags": [], "button": ["View", False, ""]},
            {"uid": P2, "current": None, "lines": ["2024-01-01 · MR · SYN DESC 33 Awaiting Report", "SYN Hospital A",
                                                    "SYN KIM (EDITED) · SYN-P-100-EDIT · 1980-05-17 · M"],
             "tags": [], "button": ["View", False, ""]},
            {"uid": X, "current": None, "lines": ["2022-01-01 · CT · SYN DESC 39 Awaiting Report", "SYN Hospital A",
                                                   "SYN KIM · SYN-P-100 · 1980-05-17 · M"],
             "tags": [], "button": ["View", True, NOT_LISTED]},
        ], seen["items"])
        # Same name (N) and the other institution's same original ID (T, T2) are not this patient.
        self.assertNotIn(N, self.page.evaluate(ITEM_UIDS))
        self.assertIsNone(self.page.evaluate("() => document.body.dataset.pwned ?? null"))

        # The tele pair: source institution and the Tele tag, report status as the list states it.
        self.pick(T)
        seen = self.settled_timeline("ready")
        self.assertEqual([
            {"uid": T, "current": "true", "lines": ["2025-11-15 · CT · SYN DESC 35 Awaiting Report", "SYN Hospital B Tele",
                                                     "SYN KIM · SYN-P-100 · 1980-05-17 · M"],
             "tags": [["Tele", TELE_TIP]], "button": ["Viewing", True, ""]},
            {"uid": T2, "current": None, "lines": ["2023-11-15 · CT · SYN DESC 36 Final · Addendum", "SYN Hospital B Tele",
                                                    "SYN KIM · SYN-P-100 · 1980-05-17 · M"],
             "tags": [["Tele", TELE_TIP]], "button": ["View", False, ""]},
        ], seen["items"])
        self.assertEqual([(A, {"limit": ["100"]}), (T, {"limit": ["100"]})], self.timeline_requests)

    def test_03_identity_conflict_marker_follows_the_server_source_relation(self):
        both = CONFLICT.format(f="생년월일과 성별")
        scenarios = [
            # name, source values, (conflict, note, tags by uid)
            ("birth", {P2: ("19810517", "M")},
             (["Identity Conflict", CONFLICT.format(f="생년월일")], None, {P2: [["Birth Date Mismatch", BIRTH_TIP]]})),
            ("sex", {X: ("19800517", "F")},
             (["Identity Conflict", CONFLICT.format(f="성별")], None, {X: [["Sex Mismatch", SEX_TIP]]})),
            ("both", {P1: ("19800518", "M"), X: ("19800517", "F")},
             (["Identity Conflict", both], None, {P1: [["Birth Date Mismatch", BIRTH_TIP]], X: [["Sex Mismatch", SEX_TIP]]})),
            ("both-one-study", {P2: ("19790101", "F")},
             (["Identity Conflict", both], None, {P2: [["Birth Date Mismatch", BIRTH_TIP], ["Sex Mismatch", SEX_TIP]]})),
            ("not-comparable", {X: ("", "M"), P2: ("19800517", "")},
             (None, UNKNOWN.format(f="생년월일과 성별"), {})),
            ("conflict-and-unknown", {P1: ("19810101", "M"), X: ("19800517", "")},
             (["Identity Conflict", CONFLICT.format(f="생년월일")], UNKNOWN.format(f="성별"),
              {P1: [["Birth Date Mismatch", BIRTH_TIP]]})),
            ("match", {}, (None, None, {})),
        ]
        for name, source, (conflict, note, tags) in scenarios:
            with self.subTest(scenario=name):
                self.source = source
                self.open_home()
                self.pick(A)
                seen = self.show("conflict" if conflict else "ready")
                self.assertEqual((conflict, note), (seen["conflict"], seen["note"]))
                self.assertEqual(tags, {item["uid"]: item["tags"] for item in seen["items"] if item["tags"]})
                self.assertEqual(READY.format(n=4), seen["text"])

        # The marker is the server's relation on source values, never the displayed (overlay) values:
        #  hidden - P2's source birth date differs while every displayed date is A's (an overlay): shipped marks it;
        #  made   - every source value is A's while P1's overlay displays another date: shipped stays unmarked.
        # Control: the same file comparing displayed values gets both the other way round.
        marked = ["Identity Conflict", CONFLICT.format(f="생년월일")]
        for name, source, p1_birth, shipped, control in (("hidden", {P2: ("19810517", "M")}, None, marked, False),
                                                         ("made", {}, "19800101", None, True)):
            self.source = source
            self.rows = copy.deepcopy(ROWS)
            if p1_birth:
                next(row for row in self.rows if row["uid"] == P1)["birth"] = p1_birth
            for label, script in (("shipped", SHIPPED["clinician.js"]), ("display-compare", self.variants["display-compare"])):
                with self.subTest(case=name, file=label):
                    self.open_home(script)
                    self.pick(A)
                    self.page.locator("#timeline-toggle").click()
                    self.wait_until(lambda: self.timeline()["state"] not in ("loading", "idle"), "the timeline answer")
                    conflict = self.timeline()["conflict"]
                    if label == "shipped":
                        self.assertEqual(shipped, conflict)
                    else:
                        self.assertEqual(control, conflict is not None, "control: displayed values decide the marker")

    def test_04_states_failures_malformed_answers_empty_no_key_and_hide(self):
        self.open_home()
        self.pick(A)
        self.hold_timeline = True
        self.page.locator("#timeline-toggle").click()
        self.wait_until(lambda: self.held_timelines, "the held timeline read")
        seen = self.timeline()
        self.assertEqual(("loading", LOADING, False, True, []), (seen["state"], seen["text"], seen["retry"],
                                                                seen["listHidden"], seen["items"]))
        self.release(0)
        self.hold_timeline = False
        self.assertEqual("ready", self.timeline()["state"])

        failures = [
            (NOT_FOUND, "검사를 찾을 수 없습니다 (HTTP 404)"),
            (CHANGED, "검사 목록 또는 판독 상태가 바뀌었습니다. 새로고침하세요. (HTTP 409 · STUDY_LIST_CHANGED)"),
            (ROUTE_DENIED, "서버가 요청을 거절했습니다. (HTTP 403 · CLINICIAN_ROUTE_DENIED)"),
            (NO_LIMIT, "타임라인은 limit(1~100)으로 쪽을 나눠 읽습니다 (HTTP 400)"),
        ]
        for answer, detail in failures:
            with self.subTest(status=answer[0]):
                self.timeline_errors = [answer]
                self.page.locator("#timeline-toggle").click()
                self.page.locator("#timeline-toggle").click()
                seen = self.settled_timeline("failed")
                self.assertEqual((FAILED, detail, True, [], None), (seen["text"], seen["detail"], seen["retry"], seen["items"],
                                                                    seen["conflict"]))
                self.page.locator("#timeline-retry").click()
                self.assertEqual(4, len(self.settled_timeline("ready")["items"]))

        n_row = next(row for row in self.rows if row["uid"] == N)
        malformed = {
            "another-anchor": lambda r: r.update(uid=P1),
            "row-of-another-key": lambda r: self.patch_studies(r, r["studies"] + [self.with_identity(n_row)]),
            "conflict-flag": lambda r: r["identity"].update(conflict=True),
            "anchor-missing": lambda r: self.patch_studies(r, [row for row in r["studies"] if row["uid"] != A]),
            "relation-on-one-study": lambda r: self.patch_studies(r, [row for row in r["studies"] if row["uid"] == A]),
            "row-without-relation": lambda r: r["studies"][1].pop("identity"),
            "unknown-relation": lambda r: r["identity"].update(birth="same"),
        }
        for name, patch in malformed.items():
            with self.subTest(malformed=name):
                self.timeline_patch = patch
                asked = len(self.timeline_requests)
                self.page.locator("#timeline-retry" if self.timeline()["retry"] else "#timeline-toggle").click()
                if self.timeline()["expanded"] == "false":
                    self.page.locator("#timeline-toggle").click()
                self.wait_until(lambda: len(self.timeline_requests) == asked + 1, "a new timeline read")
                seen = self.settled_timeline("failed")
                self.assertEqual((FAILED, MALFORMED, [], True, None), (seen["text"], seen["detail"], seen["items"],
                                                                        seen["listHidden"], seen["conflict"]))
        self.timeline_patch = None

        # Control: the same file without the row key check paints another patient's study as this patient's.
        self.open_home(self.variants["no-key-check"])
        self.pick(A)
        self.timeline_patch = malformed["row-of-another-key"]
        seen = self.show()
        self.assertIn(N, [item["uid"] for item in seen["items"]], "control: another key's row painted")
        self.timeline_patch = None

        # Empty (the other studies are no longer the caller's to see) and no key (the server has none for the study).
        self.open_home()
        self.pick(A)
        self.timeline_patch = lambda r: (self.patch_studies(r, [row for row in r["studies"] if row["uid"] == A]),
                                         r["identity"].update(conflict=False, birth="not_comparable", sex="not_comparable"))
        seen = self.show("empty")
        self.assertEqual((EMPTY, True, [], None, None), (seen["text"], seen["listHidden"], seen["items"], seen["conflict"],
                                                         seen["note"]))
        self.timeline_patch = lambda r: (self.patch_studies(r, [row for row in r["studies"] if row["uid"] == A]),
                                         r.update(patientKey=None),
                                         r["identity"].update(conflict=False, birth="not_comparable", sex="not_comparable"))
        self.page.locator("#timeline-toggle").click()
        seen = self.show("nokey")
        self.assertEqual((NO_KEY, True, []), (seen["text"], seen["listHidden"], seen["items"]))
        self.timeline_patch = None

        # Hide drops a pending read: its late answer is not painted when the timeline is shown again.
        self.hold_timeline = True
        self.page.locator("#timeline-toggle").click()
        self.page.locator("#timeline-toggle").click()
        self.wait_until(lambda: len(self.held_timelines) == 2, "the held read before Hide")
        self.page.locator("#timeline-toggle").click()
        seen = self.timeline()
        self.assertEqual(("Show Timeline", "false", True), (seen["toggle"], seen["expanded"], seen["bodyHidden"]))
        self.release(1, lambda r: r["studies"][0].update(desc="SYN-LATE-AFTER-HIDE"))
        self.assertEqual(("idle", []), (self.timeline()["state"], self.timeline()["items"]))
        self.page.locator("#timeline-toggle").click()
        self.wait_until(lambda: len(self.held_timelines) == 3, "the read after Show")
        self.release(2)
        self.hold_timeline = False
        self.assertNotIn("SYN-LATE-AFTER-HIDE", str(self.timeline()["items"]))
        self.assertEqual("ready", self.timeline()["state"])

        # A 401 on the timeline read ends the session the way every read here does.
        self.timeline_errors = [EXPIRED]
        self.page.locator("#timeline-toggle").click()
        self.page.locator("#timeline-toggle").click()
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        self.assertEqual(["1"], self.logouts)

    def test_05_pages_pass_the_signed_cursor_verbatim_and_disagreeing_pages_are_refused(self):
        filler = [study(uid(1000 + i), f"SYN FILLER {i:03d}", "SYN-P-100", key(INST_A, "SYN-P-100"),
                        f"2019{1 + i // 28:02d}{1 + i % 28:02d}", OPEN) for i in range(120)]
        self.rows.extend(filler)
        self.open_home()
        self.pick(A)
        self.hold_timeline = True
        self.page.locator("#timeline-toggle").click()
        self.wait_until(lambda: len(self.held_timelines) == 1, "timeline page 1")
        self.release(0)
        self.wait_until(lambda: len(self.held_timelines) == 2, "timeline page 2")
        self.assertEqual((f"{LOADING} (100 / 124)", []), (self.timeline()["text"], self.timeline()["items"]))
        cursor = next(iter(self.timeline_cursors))
        self.assertEqual([(A, {"limit": ["100"]}), (A, {"limit": ["100"], "after": [cursor]})], self.timeline_requests)
        self.release(1)
        self.hold_timeline = False
        seen = self.timeline()
        self.assertEqual(("ready", READY.format(n=124), 124), (seen["state"], seen["text"], len(seen["items"])))
        self.assertEqual([A, P1, P2, X], [item["uid"] for item in seen["items"]][:4])

        # Page 2 with another relation (the group changed between pages) or another anchor: the whole answer goes.
        for name, patch in (("relation", lambda r: r["pagination"]["offset"] and r["identity"].update(conflict=True, birth="mismatch")),
                            ("anchor", lambda r: r["pagination"]["offset"] and r.update(uid=P1))):
            with self.subTest(page_two=name):
                self.timeline_patch = patch
                self.page.locator("#timeline-toggle").click()
                self.page.locator("#timeline-toggle").click()
                seen = self.settled_timeline("failed")
                self.assertEqual((MALFORMED, [], None), (seen["detail"], seen["items"], seen["conflict"]))
        self.timeline_patch = None

    def test_06_a_b_a_refresh_and_log_out_never_paint_a_late_timeline(self):
        for name in ("shipped", "uid-only"):
            with self.subTest(file=name):
                self.timeline_requests, self.held_timelines, self.timeline_cursors = [], [], {}
                self.open_home(SHIPPED["clinician.js"] if name == "shipped" else self.variants[name])
                self.pick(A)
                self.show()
                self.pick(S)
                self.hold_timeline = True
                for target in (A, T, A):
                    self.pick(target)
                self.wait_until(lambda: len(self.held_timelines) == 3, "three held timeline reads")
                self.assertEqual([A, T, A], [anchor for anchor, _, _ in self.held_timelines])
                self.release(0, lambda r: r["studies"][0].update(desc="SYN-A-FIRST-ANSWER"))
                seen = self.timeline()
                if name == "shipped":
                    self.assertEqual(("loading", []), (seen["state"], seen["items"]), "A's first answer is not painted")
                    self.release(1)
                    self.assertEqual(("loading", A), (self.timeline()["state"], self.timeline()["uid"]))
                    self.release(2)
                    seen = self.timeline()
                    self.assertEqual(("ready", A), (seen["state"], seen["uid"]))
                    self.assertNotIn("SYN-A-FIRST-ANSWER", str(seen["items"]))
                else:
                    self.assertIn("SYN-A-FIRST-ANSWER", str(seen["items"]),
                                  "control: with only the UID checked the first A answer paints over the pending second")
                    self.release(1)
                    self.release(2)
                self.hold_timeline = False

        # A list refresh takes the selection down; the read in flight for it is dropped, the re-selected study reads again.
        self.timeline_requests, self.held_timelines = [], []
        self.open_home()
        self.pick(A)
        self.show()
        self.hold_timeline = True
        self.pick(P1)
        self.wait_until(lambda: len(self.held_timelines) == 1, "P1's held read")
        self.page.locator("#refresh").click()
        self.wait_until(lambda: len(self.held_timelines) == 2, "P1 read again after the list")
        self.release(0, lambda r: r["studies"][0].update(desc="SYN-BEFORE-REFRESH"))
        self.assertEqual(("loading", []), (self.timeline()["state"], self.timeline()["items"]))
        self.release(1)
        self.hold_timeline = False
        self.assertEqual(("ready", P1), (self.timeline()["state"], self.timeline()["uid"]))
        self.assertNotIn("SYN-BEFORE-REFRESH", str(self.timeline()["items"]))

        # Log out while a timeline read is pending: the page is cleared first and the late answer never paints.
        self.hold_timeline = True
        self.pick(A)
        self.wait_until(lambda: len(self.held_timelines) == 3, "A's held read")
        self.held_logouts = []
        self.page.locator("#logout").click()
        self.wait_until(lambda: self.held_logouts, "POST /auth/logout")
        self.release(2, lambda r: r["studies"][0].update(desc="SYN-AFTER-LOGOUT"))
        closed = self.page.evaluate("() => ({text: document.body.textContent, timeline: !!document.querySelector('#timeline')})")
        self.assertEqual({"text": CLOSING, "timeline": False}, closed)
        self.held_logouts[0].fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        self.hold_timeline = False

    def test_07_view_selects_that_study_and_an_opened_timeline_follows_the_selection(self):
        self.open_home()
        self.pick(A)
        self.show()
        self.page.locator(f'#timeline-list li[data-uid="{P1}"] button').click()
        expect(self.page.locator("#detail")).to_have_attribute("data-uid", P1)
        expect(self.page.locator(f'#studies tr[data-uid="{P1}"]')).to_have_attribute("aria-current", "true")
        seen = self.settled_timeline("ready")
        self.assertEqual(P1, seen["uid"])
        self.assertEqual([P1], [item["uid"] for item in seen["items"] if item["current"]])
        self.assertEqual(["Viewing", True, ""], next(item["button"] for item in seen["items"] if item["uid"] == P1))
        self.assertEqual("timeline-toggle", self.page.evaluate("() => document.activeElement.id"))
        self.assertEqual([A, P1], [anchor for anchor, _ in self.timeline_requests])
        self.assertEqual([A, P1], self.report_requests)
        # The list keeps one tab stop, now on the selected study.
        self.assertEqual([P1], self.page.evaluate(
            "() => [...document.querySelectorAll('#studies button')].filter(b => b.tabIndex === 0).map(b => b.closest('tr').dataset.uid)"))

        # Opened: a study without peers has no place and no read; a study with peers is read on selection.
        self.pick(S)
        self.assertIsNone(self.timeline())
        self.pick(A)
        self.settled_timeline("ready")
        self.assertEqual([A, P1, A], [anchor for anchor, _ in self.timeline_requests])
        # Closed: the place stays folded on later selections and nothing is read.
        self.page.locator("#timeline-toggle").click()
        self.pick(P2)
        seen = self.timeline()
        self.assertEqual(("Show Timeline", "false", True, "idle"), (seen["toggle"], seen["expanded"], seen["bodyHidden"], seen["state"]))
        self.settle()
        self.assertEqual(3, len(self.timeline_requests))
        # Keyboard: Enter on the toggle opens and reads.
        self.page.locator("#timeline-toggle").focus()
        self.page.keyboard.press("Enter")
        self.assertEqual((P2, "true"), (self.settled_timeline("ready")["uid"], self.timeline()["expanded"]))
        self.page.locator(f'#timeline-list li[data-uid="{A}"] button').focus()
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#detail")).to_have_attribute("data-uid", A)
        self.assertEqual(A, self.settled_timeline("ready")["uid"])

    def test_08_wording_fonts_targets_and_aria(self):
        self.source = {P2: ("19810517", "M"), X: ("19800517", "")}
        self.open_home()
        self.pick(A)
        texts = []
        collect = """() => { const s = document.querySelector('#timeline'), out = [];
          const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) { const n = walker.currentNode, p = n.parentElement, t = n.textContent.trim();
            if (t && p && !p.closest('[hidden]')) out.push({text: t, tag: p.tagName, cls: p.className, size: parseFloat(getComputedStyle(p).fontSize)}); }
          for (const e of s.querySelectorAll('[title], [aria-label]')) for (const a of ['title', 'aria-label'])
            if (e.hasAttribute(a) && e.getAttribute(a)) out.push({text: e.getAttribute(a), tag: e.tagName + '@' + a, cls: '', size: null});
          return out; }"""
        texts += self.page.evaluate(collect)
        self.show("conflict")
        texts += self.page.evaluate(collect)
        labels = self.page.evaluate("""() => { const s = document.querySelector('#timeline');
          return {buttons: [...s.querySelectorAll('button')].map(b => b.textContent), heading: s.querySelector('h3').textContent,
            states: [...s.querySelectorAll('.status, .tag, #timeline-conflict .state-text')].map(e => e.textContent)}; }""")
        self.timeline_errors = [NOT_FOUND]
        self.page.locator("#timeline-toggle").click()
        self.page.locator("#timeline-toggle").click()
        self.settled_timeline("failed")
        texts += self.page.evaluate(collect)

        self.assertEqual("Patient Timeline", labels["heading"])
        self.assertEqual(["Hide Timeline", "Retry", "Viewing", "View", "View", "View"], labels["buttons"])
        self.assertEqual(["Identity Conflict", "Final", "Preliminary", "Awaiting Report", "Birth Date Mismatch",
                          "Awaiting Report"], labels["states"])
        for text in [labels["heading"], *labels["buttons"], *labels["states"]]:
            self.assertFalse(has_hangul(text), text)
        explanations = [item["text"] for item in texts if item["tag"].endswith("@title")
                        or "state-detail" in item["cls"] or (item["tag"] == "P" and "muted" in item["cls"]
                                                             and item["text"].startswith(("지금", "일부")))]
        self.assertTrue(explanations)
        for text in explanations:
            self.assertTrue(has_hangul(text), text)
        for item in texts:
            with self.subTest(text=item["text"][:60], tag=item["tag"]):
                self.assertIsNone(AVOIDED.search(item["text"]))
                self.assertIsNone(ACKNOWLEDGED.search(item["text"]))
                if item["size"] is not None:
                    self.assertGreaterEqual(item["size"], 12)
        self.page.locator("#timeline-retry").click()
        self.settled_timeline("conflict")
        targets = self.page.evaluate("""() => [...document.querySelectorAll('#timeline button')].filter(b => b.offsetParent !== null)
          .map(b => { const r = b.getBoundingClientRect(); return [b.textContent, r.width, r.height]; })""")
        self.assertEqual(5, len(targets))
        for text, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, text)
        aria = self.page.evaluate("""() => ({controls: document.querySelector('#timeline-toggle').getAttribute('aria-controls'),
          labelled: document.querySelector('#timeline').getAttribute('aria-labelledby'),
          state: [document.querySelector('#timeline-state').getAttribute('role'), document.querySelector('#timeline-state').getAttribute('aria-live')],
          conflict: document.querySelector('#timeline-conflict').getAttribute('role')})""")
        self.assertEqual({"controls": "timeline-body", "labelled": "timeline-title", "state": ["status", "polite"],
                          "conflict": "alert"}, aria)
        for needle in ("innerHTML", "insertAdjacentHTML", "outerHTML", "document.write", ".roles"):
            self.assertNotIn(needle, SHIPPED["clinician.js"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
