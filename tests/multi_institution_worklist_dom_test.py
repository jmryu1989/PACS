# coding: utf-8
"""REQ-S7-U3b-HOSPITAL-COLUMN / REQ-S7-U3b-FACTORS
-> RISK-S7-U3b-TELE-MISLABEL / RISK-S7-U3b-PREF-BREAK / RISK-S7-U3b-INFERRED-FACTOR
-> TEST-S7-U3b-DOM (browser half of TEST-S7-U3b-COLUMNS as well).

The shipped worklist page (main.html and every script and stylesheet it loads, served as they are from a synthetic origin)
boots through its own boot() against an in-test server. Nothing of the page is cut out or replaced: the Hospital column,
its filter and compound field, the Tele label, the header sort, the Routing Factors legend and the stored column layouts
are all read from what a user sees and what reaches the server. Assertions name visible titles, product sentences,
request bodies and stored values; cells are found by the position of their visible header, never by class, id or data-*
attribute, and no page function or variable is called or read. The expected values are written here from the stub
answers (and tests/worklist_columns_vectors.json), not computed by product code.

  mi01 Hospital cell: owner registry name, Tele only for a row the server marks tele, (미배정) as sent, '—' for no name,
       no added focus target, label size; the demo entry's Orthanc rows (HC-06 below; left out of NEW-1, not run).
  mi02 Hospital filter, AND with other filters, compound rules and the rule editor, the hidden-column note, Manual search.
  mi03 saving a search with Hospital text, compound rule and Hospital sort; applying it again, as default, and the pairs.
  mi04 stored browser layouts from before the unit, account Load/Save answers, two owners, Reset Current Mode.
  mi05 the Routing Factors legend: names, sources, Not Configured, no request or write, nothing inferred from data.
  mi06 Urgency is the server em only; nothing changes with elapsed time (style, text, order compared separately).
  mi07 the Hospital header sorts by name only; mi08 assignment filters keep tele rows; mi09 Technician and ReqHosp.
  mi10 external strings stay text; mi11 refresh, closed or renamed tele rows and a late list answer.
  f1   both boot kinds are clean on this harness (run against the pre-unit page too: KIN_MULTI_INSTITUTION_MAIN).
  f5   the HC-06 check refuses a QIDO 503 (the built-in demo rows) at its QIDO status check and a QIDO 200 with no
       study (an empty list) at 'HC-06 synthetic QIDO rows'.

Request contract (test-plan F-2, F-2b, F-3). Server mode: /api/me, /api/bootstrap?states=omit, /api/colleagues, the paged
/api/studies, /api/worklist-columns, /api/filters and /api/prefs are answered; any other same-origin /api GET (later units'
boot reads) is answered 404 SYN_NOT_STUBBED and kept in the ledger; /statistics and per-study Orthanc reads are 404; a GET
of the Orthanc study list /dicom-web/studies fails the case (the list is read through /api only); a write the case did not
declare, another origin or a static path outside worklist-v0/hpacs-lite fails the case. Demo entry (HC-06): /api and
/auth answer 502, the page's own demo button is pressed, and the one QIDO list GET is answered with synthetic studies.

HC-06 (test-plan mi01 demo part, F-2b), checked by demo_reach() for the synthetic QIDO answer and for the same two
studies in the other order: one QIDO GET answered 200, no /api/me after entering, no built-in demo rows or notice; the
list is exactly SYN-QIDO-01 and SYN-QIDO-02; each Hospital cell is '—' with no Tele label; after a click on the
SYN-QIDO-01 ID cell the visible 'Study UID' is the synthetic UID; in Technician both rows show ReqHosp '(로컬)'.
On the base (663ed5b, the S7-U3a merge) the demo entry reads the QIDO list, but the worklist search view returns no row
for a session without an account owner (worklist-search.js mount().read); that product path is not changed in this unit.
S7-U3b-SPEC-R-001 A안: HC-06의 두 합성 행·UID·Hospital/Tele 단언은 보존한다. NEW-1은 기존 18개 중 17개를 선택한다. HC-06과
그 역순 QIDO 보존 짝은 owner 없는 데모 읽기의 기존 결함 때문에 관문에서 제외되어 not_run이다. F-1/F-5 또는 서버 모드 검사는
HC-06 표시 성공의 대체 증거가 아니다.
The exclusion is NEW-1's -k include list (validate.yml), never a skip here. The follow-up unit S7-DEMO-ROWS (D213, due
before the Stage 9 clean-up) fixes the owner-less demo read; once both QIDO orders pass HC-06 and f5 still refuses the
empty list, the -k list is removed.

KIN_MULTI_INSTITUTION_MAIN (a main.html path) is the only override: the local mutant runs point it at a copy with one
change. Synthetic data only (SYN-* names); no server, no network, no credentials.
"""
import copy
import json
import os
import re
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
MAIN = Path(os.environ.get("KIN_MULTI_INSTITUTION_MAIN") or HPACS / "main.html")
VECTORS = json.loads((ROOT / "tests" / "worklist_columns_vectors.json").read_text(encoding="utf-8"))
V = {v["id"]: v for v in VECTORS["accepted"] + VECTORS["refused"] + VECTORS["idempotent"]}
TITLES = VECTORS["titles"]["Radiology"]
ORIGIN = "https://multi-institution.test"
KST = timezone(timedelta(hours=9))
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json"}

HOSPITAL = "Hospital"
TELE_TIP = "원격판독으로 의뢰받은 검사입니다."
A, B, C = "SYN Hospital A", "SYN Center B", "SYN Clinic C"
SESSION_A = {"sub": "syn-sub-a", "actor": "syn-reader-a@synthetic.test", "user": "syn-reader-a@synthetic.test",
             "displayName": "SYN Reader A", "roles": ["radiologist"], "institution": "hallym", "kind": "member"}
SESSION_B = {**SESSION_A, "sub": "syn-sub-b", "actor": "syn-reader-b@synthetic.test", "user": "syn-reader-b@synthetic.test",
             "displayName": "SYN Reader B"}
COLUMNS_KEY = "kin-worklist-columns:v1:"
DEFAULT_ORDER = V["V01"]["expect"]["modes"]["Radiology"]["order"]
DEFAULT_TITLES = [TITLES[k] for k in DEFAULT_ORDER]
# Words the legend, the Hospital header and the Tele label never carry (IC-09; UXR-SP-34/G-18 and S7-U1p §16.3, written
# here rather than imported).
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.I)
ACKNOWLEDGEMENT = re.compile(r"\bACK\b|acknowledg|\bsent\b|deliver|수신 확인|열어봄|읽음|전달됨", re.I)
FACTORS = ["Hospital", "Modality", "Body Part", "Urgency", "Subspecialty", "SLA", "Credential", "Workload", "Availability"]
NOT_CONFIGURED = ["Subspecialty", "SLA", "Credential", "Workload", "Availability"]
QIDO_QUERY = "includefield=00081030,00201206,00201208"
QIDO_UIDS = ["2.25.300000000000000000000000000000000001", "2.25.300000000000000000000000000000000002"]
QIDO_IDS = ["SYN-QIDO-01", "SYN-QIDO-02"]
SERVED = set()


def has_hangul(text):
    return any("가" <= ch <= "힣" for ch in text)


def layout_key(session):
    return COLUMNS_KEY + json.dumps([session["institution"], session["sub"]], separators=(",", ":"))


def titles_of(document, mode="Radiology"):
    part = document["modes"][mode]
    return [TITLES[k] for k in part["order"] if k not in part["hidden"]]


def row(uid, pid, *, inst=A, tele=False, owner="hallym", tele_to=None, date="20261005", em="N", desc="SYN CT",
        modality="CT", reader=None, rs="W", ss="Verified", name=None, acc=None, omit_name=False):
    """One /api/studies row in the server's shape (pacs.service.ts listStudies)."""
    body = {
        "uid": uid, "techNote": {"version": 0, "present": False},
        "readerAssignment": {"revision": 1 if reader else 0,
                             "reader": {"sub": "sub-" + reader[1], "actor": reader[1], "name": reader[0]} if reader else None},
        "gatewayReceipt": None, "orderIdentity": None, "count": 10, "series": 1,
        "acc": acc or "SYNACC" + pid.replace("-", "")[-6:], "id": pid, "sourcePatientKey": owner + "|" + pid,
        "name": name or "SYN PATIENT " + pid, "birth": "19800101", "date": date, "sex": "M", "modality": modality,
        "desc": desc, "institutionName": inst, "tele": tele,
        "state": {"rs": rs, "ss": ss, "em": em, "ts": "none", "matched": "U", "ward": "", "reqHosp": inst or "",
                  "institutionId": owner, "teleInstitutionId": tele_to, "preDoc": None, "preReviewer": None,
                  "prelimHidden": False, "repDoc": None, "confirm": None, "ov": None, "orig": None, "oid": None,
                  "holder": None, "holdReason": None, "version": 0, "findings": "", "conclusion": "",
                  "recommendation": "", "draft": None}}
    if omit_name:
        del body["institutionName"]
    return body


def qido_study(uid, pid, name, acc):
    today = "20261005"
    return {"0020000D": {"vr": "UI", "Value": [uid]}, "00100020": {"vr": "LO", "Value": [pid]},
            "00100010": {"vr": "PN", "Value": [{"Alphabetic": name}]}, "00080050": {"vr": "SH", "Value": [acc]},
            "00080020": {"vr": "DA", "Value": [today]}, "00081030": {"vr": "LO", "Value": ["SYN QIDO CT"]},
            "00080061": {"vr": "CS", "Value": ["CT"]}, "00201206": {"vr": "IS", "Value": [1]},
            "00201208": {"vr": "IS", "Value": [10]}, "00100030": {"vr": "DA", "Value": ["19800101"]},
            "00100040": {"vr": "CS", "Value": ["F"]}}


QIDO = [qido_study(QIDO_UIDS[0], "SYN-QIDO-01", "SYN^QIDO^ONE", "SYNQIDO0001"),
        qido_study(QIDO_UIDS[1], "SYN-QIDO-02", "SYN^QIDO^TWO", "SYNQIDO0002")]


class Server:
    """The in-test server and its request ledger. A route may be held and answered later (late answers)."""

    def __init__(self, *, rows=(), session=SESSION_A, my_name=A, institutions=None, filters=(), columns=None,
                 demo=False, qido=None, qido_status=200, clock=None):
        self.rows, self.session, self.my_name = list(rows), session, my_name
        self.institutions = institutions or [{"id": "hallym", "name": A, "type": "hospital"},
                                             {"id": "kin-center", "name": B, "type": "center"}]
        self.filters, self.columns = [copy.deepcopy(f) for f in filters], columns
        self.demo, self.qido, self.qido_status = demo, QIDO if qido is None else qido, qido_status
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.ledger, self.violations, self.held, self.hold_lists = [], [], [], 0
        self.column_answers, self.filter_posts, self.patches = [], [], []

    def iso(self):
        return self.clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    def list_body(self, rows=None):
        rows = sorted(copy.deepcopy(self.rows if rows is None else rows), key=lambda r: r["uid"])
        return {"studies": rows, "serverTime": self.iso(), "observedAt": self.iso(), "notObserved": [],
                "pagination": {"owner": [self.session["institution"], self.session["sub"]], "limit": 100, "offset": 0,
                               "total": len(rows), "next": None}}

    def bootstrap(self):
        return {"statesOmitted": True, "me": {"actor": self.session["actor"], "roles": self.session["roles"],
                                               "institution": self.session["institution"], "institutionName": self.my_name},
                "filters": copy.deepcopy(self.filters), "templates": [], "institutions": copy.deepcopy(self.institutions),
                "states": {}, "orders": [], "serverTime": self.iso()}

    def columns_body(self):
        if callable(self.columns):
            return self.columns()
        return {"owner": [self.session["institution"], self.session["sub"]], "revision": 0, "columns": None, "updatedAt": None}

    def handle(self, route, request):
        url = urlparse(request.url)
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.violations.append("other origin: " + request.method + " " + request.url)
            return route.abort()
        method, path, query = request.method, url.path, url.query
        body = request.post_data
        entry = {"method": method, "path": path, "query": query, "body": body, "status": None}
        self.ledger.append(entry)

        def answer(status, payload, content_type="application/json"):
            entry["status"] = status
            data = payload if isinstance(payload, (bytes, str)) else json.dumps(payload, ensure_ascii=False)
            return route.fulfill(status=status, content_type=content_type, body=data)

        if self.demo:
            if path.startswith("/api/") or path.startswith("/auth/"):
                return answer(502, {"code": "SYN_SERVER_ABSENT"})
            if method != "GET":
                self.violations.append("demo write: " + method + " " + path)
                return answer(405, {"code": "SYN_NO_WRITE"})
            if path == "/dicom-web/studies":
                if query != QIDO_QUERY:
                    self.violations.append("unexpected QIDO query: " + query)
                return answer(self.qido_status, self.qido if self.qido_status == 200 else {"code": "SYN_ORTHANC"})
            if path == "/statistics" or path.startswith("/dicom-web/") or path.startswith("/instances/"):
                return answer(404, {"code": "SYN_NOT_STUBBED"})
            return self.static(route, path, entry, strict=False)

        if path.startswith("/api/"):
            return self.api(route, method, path, query, body, entry, answer)
        if method != "GET":
            self.violations.append("undeclared write: " + method + " " + path)
            return answer(405, {"code": "SYN_NO_WRITE"})
        if path == "/dicom-web/studies":
            self.violations.append("server mode listed studies through Orthanc: " + path + "?" + query)
            return answer(404, {"code": "SYN_NOT_STUBBED"})
        if path == "/statistics" or path.startswith("/dicom-web/") or path.startswith("/instances/"):
            return answer(404, {"code": "SYN_NOT_STUBBED"})
        return self.static(route, path, entry, strict=True)

    def static(self, route, path, entry, strict):
        if path.startswith("/kin-brand/") or path == "/favicon.ico":
            entry["status"] = 404
            return route.fulfill(status=404, body="")
        target = MAIN if path == "/main.html" else HPACS / path.lstrip("/")
        inside = path == "/main.html" or (target.is_file() and target.resolve().parent == HPACS.resolve())
        if not inside:
            if strict:
                self.violations.append("static path outside the page files: " + path)
            entry["status"] = 404
            return route.fulfill(status=404, body="")
        SERVED.add("worklist-v0/hpacs-lite/" + path.lstrip("/"))
        entry["status"] = 200
        return route.fulfill(status=200, content_type=TYPES.get(target.suffix, "application/octet-stream"),
                             body=target.read_bytes())

    def api(self, route, method, path, query, body, entry, answer):
        if method == "GET" and path == "/api/me":
            return answer(200, self.session)
        if method == "GET" and path == "/api/bootstrap":
            if query != "states=omit":
                self.violations.append("bootstrap query: " + query)
            return answer(200, self.bootstrap())
        if method == "GET" and path == "/api/colleagues":
            return answer(200, [])
        if method == "GET" and path == "/api/studies":
            params = parse_qs(query)
            if params.get("limit") != ["100"] or set(params) - {"limit"}:
                self.violations.append("list query: " + query)
            if self.hold_lists > 0:
                self.hold_lists -= 1
                self.held.append((route, entry))
                return None
            return answer(200, self.list_body())
        if path == "/api/worklist-columns" and method in ("GET", "PUT", "DELETE"):
            self.column_answers.append((method, json.loads(body) if body else None))
            status, payload = (200, self.columns_body()) if method == "GET" or not callable(self.columns) else self.columns(method, body)
            return answer(status, payload)
        if method == "POST" and path == "/api/filters":
            saved = json.loads(body)
            self.filter_posts.append(copy.deepcopy(saved))
            saved = {**saved, "id": 700 + len(self.filter_posts)}
            self.filters = [f for f in self.filters if f["name"] != saved["name"]] + [saved]
            return answer(200, saved)
        if method == "GET" and path == "/api/prefs":
            return answer(200, {"filters": copy.deepcopy(self.filters), "templates": []})
        if method == "PATCH" and re.fullmatch(r"/api/studies/[^/]+", path) and self.patches is not None:
            uid = path.rsplit("/", 1)[1]
            self.patches.append((uid, json.loads(body)))
            state = next(r["state"] for r in self.rows if r["uid"] == uid)
            return answer(200, {**state, **json.loads(body)})
        if method == "GET":
            return answer(404, {"code": "SYN_NOT_STUBBED", "message": "synthetic server: not stubbed"})
        self.violations.append("undeclared write: " + method + " " + path)
        return answer(405, {"code": "SYN_NO_WRITE"})

    def release(self, index, rows):
        route, entry = self.held[index]
        entry["status"] = 200
        try:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(self.list_body(rows)))
            return True
        except PlaywrightError:
            return False  # the page already gave the request up (a newer read aborted it)


# Storage writes the page makes, recorded before any page script runs (the recorder is the test's, not the page's).
STORAGE_RECORDER = """(() => {
  const writes = [];
  Object.defineProperty(window, '__synStorageWrites', { value: writes });
  for (const name of ['setItem', 'removeItem', 'clear']) {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function (...args) {
      let area = 'other';
      try { area = this === window.localStorage ? 'local' : this === window.sessionStorage ? 'session' : 'other'; } catch (_) {}
      writes.push([area, name, ...args.map(String)]);
      return original.apply(this, args);
    };
  }
})();"""
TABLE_VIEW = """t => {
  const clean = s => s.replace(/\\s+/g, ' ').trim();
  const head = [...t.tHead.rows[0].cells].map(c => clean(c.innerText));
  const rows = [...t.tBodies[0].rows].filter(r => r.cells.length === head.length && head.length > 1)
    .map(r => [...r.cells].map(c => clean(c.innerText)));
  return { head, rows };
}"""
STYLE_VIEW = """t => {
  const props = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration-line', 'opacity', 'box-shadow', 'outline'];
  const sig = e => { const s = getComputedStyle(e); return props.map(p => p + ':' + s.getPropertyValue(p)).join(';'); };
  const head = [...t.tHead.rows[0].cells].map(c => c.innerText.replace(/\\s+/g, ' ').trim());
  // One read of texts and styles together, so a redraw can never pair one row's text with another row's style.
  const rows = [...t.tBodies[0].rows].filter(r => r.cells.length === head.length).map(r => ({
    row: sig(r),
    cells: [...r.cells].map(c => {
      const texts = [], walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim()) texts.push(sig(n.parentElement));
      return { cell: sig(c), texts, text: c.innerText.replace(/\\s+/g, ' ').trim() };
    }),
  }));
  return { view: { head, rows: rows.map(r => r.cells.map(c => c.text)) }, styles: rows };
}"""


PAGES = []   # the page being waited on; its wait_for_timeout lets Playwright deliver routes and events meanwhile


def until(check, timeout=10.0, message="condition"):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = check()
            if last:
                return last
        except (AssertionError, PlaywrightError) as error:
            last = error
        PAGES[-1].wait_for_timeout(50)
    raise AssertionError(f"timed out waiting for {message}: {last!r}")


class Screen:
    """What a user sees on one booted page, found by roles, names and visible text."""

    def __init__(self, case, page, server):
        self.case, self.page, self.server = case, page, server
        self.errors, self.dialogs, self.prompt_answer = [], [], None
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.on("dialog", self._dialog)

    def _dialog(self, dialog):
        self.dialogs.append((dialog.type, dialog.message))
        if dialog.type == "prompt" and self.prompt_answer is not None:
            dialog.accept(self.prompt_answer)
        else:
            dialog.dismiss()

    def table(self):
        # The worklist is the table with the Name column, which no layout can hide (ID and Name are required); the
        # Technician Order List also has Name but is the one with ScheduledDate. A stored layout may hide any other column.
        return self.page.get_by_role("table").filter(
            has=self.page.get_by_role("columnheader", name="Name", exact=True)).filter(
            has_not=self.page.get_by_role("columnheader", name="ScheduledDate", exact=True))

    def view(self):
        return self.table().evaluate(TABLE_VIEW)

    def heads(self):
        return self.view()["head"]

    def column(self, title, view=None):
        view = view or self.view()
        index = view["head"].index(title)
        return [r[index] for r in view["rows"]]

    def cells_by_id(self, title):
        view = self.view()
        return dict(zip(self.column("ID", view), self.column(title, view)))

    def wait_rows(self, ids, timeout=10.0):
        until(lambda: self.column("ID") == list(ids), timeout, f"rows {list(ids)}")

    def filter_box(self, title):
        index = self.heads().index(title)
        return self.table().get_by_role("row").nth(1).get_by_role("columnheader").nth(index).locator("input, select")

    def data_row(self, pid):
        return self.table().get_by_role("row").filter(has=self.page.get_by_role("cell", name=pid, exact=True))

    def menu(self, name, open_=True):
        summary = self.page.locator("summary").filter(has_text=re.compile("^" + re.escape(name) + "▾?$"))
        details = summary.locator("xpath=..")
        if (details.get_attribute("open") is None) == open_:
            summary.click()
        return details

    def refresh(self):
        self.page.get_by_role("group", name="Refresh").get_by_role("button", name="Refresh", exact=True).click()

    def set_manual_refresh(self):
        group = self.page.get_by_role("group", name="Refresh")
        group.locator("summary").click()
        self.page.get_by_role("combobox", name="Auto Refresh").select_option(label="Manual")
        group.locator("summary").click()

    def filter_line(self):
        return self.page.get_by_text(re.compile(r"^(Draft Filter \(not applied\) : |Filter : )")).inner_text()

    def storage_writes(self):
        return self.page.evaluate("() => window.__synStorageWrites.slice()")

    def open_columns(self):
        self.menu("View").get_by_role("button", name="Columns", exact=True).click()
        dialog = self.page.get_by_role("dialog", name=re.compile(r"^Worklist Columns"))
        expect(dialog).to_be_visible()
        return dialog

    def legend(self):
        return self.page.locator("details").filter(has=self.page.locator("summary", has_text=re.compile(r"^Routing Factors$")))

    def finish(self, dialogs=0):
        self.case.assertEqual([], self.server.violations, "unexpected requests")
        self.case.assertEqual([], self.errors, "page errors")
        self.case.assertEqual(dialogs, len(self.dialogs), self.dialogs)
        self.case.assertIsNone(self.page.evaluate("() => window.synXss"), "an external string ran as code")


class MultiInstitutionWorklist(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        print("S7-U3b NEW-1 served page files: " + json.dumps(sorted(SERVED)))

    def boot(self, server, *, storage=None, clock_at=None, entry="main", viewport=(1600, 1000)):
        context = self.browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, locale="ko-KR",
                                           timezone_id="Asia/Seoul")
        self.addCleanup(context.close)
        context.add_init_script(STORAGE_RECORDER)
        context.route("**/*", server.handle)
        page = context.new_page()
        PAGES.append(page)
        screen = Screen(self, page, server)
        if clock_at is not None:
            page.clock.install(time=clock_at)
        if storage:
            page.goto(ORIGIN + "/kin-emblem-j1.svg")
            page.evaluate("items => { for (const [k, v] of items) localStorage.setItem(k, v); }", list(storage.items()))
        if entry == "demo":
            page.goto(ORIGIN + "/index.html")
            page.get_by_role("button", name="데모 모드로 둘러보기 (서버 없이)").click()
            page.wait_for_url(ORIGIN + "/main.html")
            until(lambda: any(e["path"] == "/dicom-web/studies" and e["status"] for e in server.ledger), 15, "QIDO read")
            # The QIDO path ends with the storage read; the built-in fallback ends with its notice instead.
            until(lambda: any(e["path"] == "/statistics" for e in server.ledger)
                  or page.get_by_text("데모 모드 — 가짜 데이터 (Orthanc 미연결)").count(), 15, "list drawn")
        else:
            page.goto(ORIGIN + "/main.html")
            until(lambda: sum(1 for e in server.ledger if e["path"] == "/api/studies" and e["status"]) >= 1
                  and any(e["path"] == "/statistics" for e in server.ledger), 15, "first list drawn")
        return screen

    # ── mi01 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    def hospital_rows(self, *, my_name=A, same=False, korean=False, order=("001", "002", "003", "004", "005")):
        tele_name = (A if same else B) if not korean else "KIN 판독센터"
        own_name = A if not korean else "한림병원"
        uids = dict(zip(("own", "tele", "sent", "unknown", "noname"), order))
        return [row("2.25.101" + uids["own"], "SYN-OWN-01", inst=own_name),
                row("2.25.101" + uids["tele"], "SYN-TELE-01", inst=tele_name, tele=True, owner="kin-center", tele_to="hallym"),
                row("2.25.101" + uids["sent"], "SYN-SENT-01", inst=own_name, tele_to="kin-center"),
                row("2.25.101" + uids["unknown"], "SYN-UNREG-01", inst="(미배정)", tele=True, owner="syn-x", tele_to="hallym"),
                row("2.25.101" + uids["noname"], "SYN-NONAME-01", omit_name=True)]

    def check_hospital(self, screen, own, tele):
        self.assertEqual(HOSPITAL, screen.heads()[-1], "Hospital is the last column of the default layout")
        cells = screen.cells_by_id(HOSPITAL)
        self.assertEqual({"SYN-OWN-01": own, "SYN-TELE-01": tele + " Tele", "SYN-SENT-01": own,
                          "SYN-UNREG-01": "(미배정) Tele", "SYN-NONAME-01": "—"}, cells)
        for pid in ("SYN-OWN-01", "SYN-SENT-01", "SYN-NONAME-01"):
            expect(screen.data_row(pid).get_by_title(TELE_TIP)).to_have_count(0)
        label = screen.data_row("SYN-TELE-01").get_by_title(TELE_TIP)
        expect(label).to_have_count(1)
        expect(label).to_have_text("Tele")

    def test_mi01_hospital_cell_owner_name_and_tele(self):
        server = Server(rows=self.hospital_rows())
        screen = self.boot(server)
        self.check_hospital(screen, A, B)
        # The label is not smaller than the row text and at least 12px.
        sizes = screen.data_row("SYN-TELE-01").get_by_title(TELE_TIP).evaluate(
            "e => [parseFloat(getComputedStyle(e).fontSize), parseFloat(getComputedStyle(e.closest('td')).fontSize)]")
        self.assertGreaterEqual(sizes[0], 12)
        self.assertGreaterEqual(sizes[0], sizes[1])
        with_column = self.focus_names(screen, "SYN-TELE-01")
        screen.finish()
        # The cell adds no focus target: the same row with Hospital hidden (a stored layout) has the same Tab order.
        hidden = {"version": 1, "modes": {"Radiology": {"order": list(DEFAULT_ORDER), "hidden": ["institutionName"]},
                                          "Technician": {"order": [], "hidden": []}}}
        screen = self.boot(Server(rows=self.hospital_rows()), storage={layout_key(SESSION_A): json.dumps(hidden)})
        self.assertNotIn(HOSPITAL, screen.heads())
        self.assertEqual(with_column, self.focus_names(screen, "SYN-TELE-01"))
        screen.finish()
        # Preserving: another server order and uids, Korean registry names -> the same rule.
        screen = self.boot(Server(rows=self.hospital_rows(korean=True, order=("009", "005", "007", "001", "003"))))
        self.check_hospital(screen, "한림병원", "KIN 판독센터")
        screen.finish()
        # Pair: my own institution's registry name changes nothing in the cell.
        screen = self.boot(Server(rows=self.hospital_rows(), my_name="SYN Other"))
        self.check_hospital(screen, A, B)
        screen.finish()
        # Pair: two institutions with the same registry name; only the tele row carries Tele.
        screen = self.boot(Server(rows=self.hospital_rows(same=True)))
        self.check_hospital(screen, A, A)
        screen.finish()

    def focus_names(self, screen, pid):
        row_locator = screen.data_row(pid)
        row_locator.get_by_role("button").first.focus()
        names = []
        for _ in range(20):
            if not row_locator.evaluate("r => r.contains(document.activeElement)"):
                break
            names.append(screen.page.evaluate(
                "() => { const e = document.activeElement; return e.getAttribute('aria-label') || e.textContent.trim(); }"))
            screen.page.keyboard.press("Tab")
        self.assertTrue(names)
        return names

    def demo_reach(self, screen):
        """HC-06: the demo entry shows the two synthetic QIDO studies, with nothing filled in from elsewhere."""
        qido = [e for e in screen.server.ledger if e["path"] == "/dicom-web/studies"]
        self.assertEqual([(QIDO_QUERY, 200)], [(e["query"], e["status"]) for e in qido], "HC-06 QIDO list read")
        start = max(i for i, e in enumerate(screen.server.ledger) if e["path"] == "/main.html")
        self.assertNotIn("/api/me", [e["path"] for e in screen.server.ledger[start:]])
        text = screen.page.locator("body").inner_text()
        self.assertNotIn("데모 모드 — 가짜 데이터 (Orthanc 미연결)", text)
        self.assertNotIn("P-1001", text)
        self.assertEqual(HOSPITAL, screen.heads()[-1])
        # The rows are the answer's two studies, as a set: the answer's order is what the preserving pair changes.
        until(lambda: sorted(screen.column("ID")) == QIDO_IDS, 10, "HC-06 synthetic QIDO rows")
        self.assertEqual(QIDO_IDS, sorted(screen.column("ID")), "HC-06 synthetic QIDO rows")
        # A QIDO study carries no institution name and no tele flag.
        self.assertEqual({pid: "—" for pid in QIDO_IDS}, screen.cells_by_id(HOSPITAL))
        for pid in QIDO_IDS:
            expect(screen.data_row(pid).get_by_title(TELE_TIP)).to_have_count(0)
        # The selected study's visible Study UID is the synthetic one, so the rows came from this answer.
        screen.data_row("SYN-QIDO-01").get_by_role("cell", name="SYN-QIDO-01", exact=True).click()
        study_uid = screen.page.get_by_role("row").filter(has=screen.page.get_by_role("cell", name="Study UID", exact=True))
        expect(study_uid.get_by_role("cell")).to_have_text(["Study UID", QIDO_UIDS[0]])
        # Technician keeps the local ReqHosp mark on both rows.
        screen.page.get_by_text("Technician", exact=True).first.click()
        until(lambda: "ReqHosp" in screen.heads(), 10, "Technician columns")
        until(lambda: screen.cells_by_id("ReqHosp") == {pid: "(로컬)" for pid in QIDO_IDS}, 10, "HC-06 Technician ReqHosp")
        self.assertEqual({pid: "(로컬)" for pid in QIDO_IDS}, screen.cells_by_id("ReqHosp"))

    def test_mi01_demo_entry_reads_orthanc_and_fills_no_hospital(self):
        screen = self.boot(Server(demo=True), entry="demo")
        self.demo_reach(screen)
        screen.finish()
        # Preserving: the two synthetic studies in the other order.
        screen = self.boot(Server(demo=True, qido=list(reversed(QIDO))), entry="demo")
        self.demo_reach(screen)
        screen.finish()

    def test_f5_demo_reach_check_fails_on_the_builtin_fallback(self):
        # Harness fitness (F-5 (1)): with the QIDO list answered 503 the page falls back to its built-in demo rows; the
        # HC-06 check must refuse that path at its QIDO status check.
        screen = self.boot(Server(demo=True, qido_status=503), entry="demo")
        with self.assertRaises(AssertionError) as refused:
            self.demo_reach(screen)
        self.assertIn("HC-06 QIDO list read", str(refused.exception))
        print("F-5 QIDO 503 refused: " + str(refused.exception).replace("\n", " | "))
        screen.finish()
        # Counterexample (S7-U3b-SPEC-R-001): a QIDO 200 with no study draws an empty list and no fallback; the check must
        # refuse it at the synthetic rows, not pass on no rows.
        screen = self.boot(Server(demo=True, qido=[]), entry="demo")
        with self.assertRaises(AssertionError) as refused:
            self.demo_reach(screen)
        self.assertIn("HC-06 synthetic QIDO rows", str(refused.exception))
        print("F-5 QIDO 200 empty refused: " + str(refused.exception).replace("\n", " | "))
        screen.finish()

    def test_f1_both_boot_kinds_are_clean(self):
        # Harness fitness (F-1): the pages boot with no page error, dialog, undeclared write or foreign request; the request
        # lists are printed as evidence (run against the pre-unit page with KIN_MULTI_INSTITUTION_MAIN as well). It checks
        # the boot only: the printed row count is an observation, and a demo boot with 0 rows does not pass the HC-06
        # display contract (demo_reach, not run in NEW-1; S7-U3b-SPEC-R-001).
        for kind in ("main", "demo"):
            server = Server(rows=self.hospital_rows(), demo=kind == "demo")
            screen = self.boot(server, entry=kind)
            screen.page.wait_for_timeout(500)
            screen.finish()
            print(f"F-1 {kind} boot requests: " + json.dumps(
                [f"{e['method']} {e['path']}{'?' + e['query'] if e['query'] else ''} {e['status']}" for e in server.ledger
                 if not re.fullmatch(r"/[\w.-]+\.(js|css|svg)", e["path"])]))
            print(f"F-1 {kind} boot: {len(screen.view()['rows'])} worklist rows shown, headers {screen.heads()}")

    # ── mi02 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    FILTER_ROWS = [row("2.25.201", "SYN-A-CT", inst=A, modality="CT"),
                   row("2.25.202", "SYN-A-MR", inst=A, modality="MR", reader=("SYN Reader A", "syn-reader-a")),
                   row("2.25.203", "SYN-B-CT", inst=B, tele=True, owner="kin-center", tele_to="hallym", modality="CT",
                       reader=("SYN Reader A", "syn-reader-a")),
                   row("2.25.204", "SYN-B-MR", inst=B, tele=True, owner="kin-center", tele_to="hallym", modality="MR",
                       reader=("SYN Reader A", "syn-reader-a")),
                   row("2.25.205", "SYN-C-CT", inst=C, tele=True, owner="syn-c", tele_to="hallym", modality="CT",
                       reader=("SYN Reader A", "syn-reader-a")),
                   row("2.25.206", "SYN-N-CT", omit_name=True, reader=("SYN Reader A", "syn-reader-a"))]
    ALL_IDS = ["SYN-A-CT", "SYN-A-MR", "SYN-B-CT", "SYN-B-MR", "SYN-C-CT", "SYN-N-CT"]

    @staticmethod
    def compound(name, join, rules, mode="Radiology", **extra):
        return {"id": 600 + len(name), "name": name, "mode": mode, "days": -1, "quick": "",
                "cols": {"$compound": {"version": 1, "join": join, "rules": rules}, **extra.pop("cols", {})},
                "sortKey": None, "sortDir": 0, "isDefault": False, **extra}

    def type_filter(self, screen, title, value):
        box = screen.filter_box(title)
        box.fill(value)

    def apply_chip(self, screen, name):
        screen.menu("Filters").get_by_role("button", name=re.compile("^" + re.escape(name) + ", ")).click()

    def test_mi02_hospital_filter_compound_and_hidden_column(self):
        filters = [
            self.compound("SYN EQ OR EMPTY", "or", [{"field": "institutionName", "op": "eq", "value": B},
                                                    {"field": "assignedReader", "op": "empty"}]),
            self.compound("SYN NEQ", "and", [{"field": "institutionName", "op": "neq", "value": A}]),
            self.compound("SYN EMPTY", "and", [{"field": "institutionName", "op": "empty"}])]
        server = Server(rows=self.FILTER_ROWS, filters=filters)
        screen = self.boot(server)
        self.type_filter(screen, HOSPITAL, "center b")
        screen.wait_rows(["SYN-B-CT", "SYN-B-MR"])
        self.assertIn("Hospital(center b)", screen.filter_line())
        self.type_filter(screen, HOSPITAL, "CENTER B")   # preserving: case only
        screen.wait_rows(["SYN-B-CT", "SYN-B-MR"])
        self.type_filter(screen, HOSPITAL, "hospital a")
        screen.wait_rows(["SYN-A-CT", "SYN-A-MR"])
        self.type_filter(screen, HOSPITAL, "Tele")      # the label is not a filter value
        screen.wait_rows([])
        self.type_filter(screen, HOSPITAL, "center")
        screen.filter_box("Modality").select_option("CT")
        screen.wait_rows(["SYN-B-CT"])
        screen.filter_box("Modality").select_option("")
        screen.wait_rows(["SYN-B-CT", "SYN-B-MR"])
        # The hidden-column note keeps the condition visible.
        dialog = screen.open_columns()
        dialog.get_by_role("checkbox", name="Show Hospital", exact=True).uncheck()
        dialog.get_by_role("button", name="Apply for This Window", exact=True).click()
        expect(dialog).to_be_hidden()
        self.assertNotIn(HOSPITAL, screen.heads())
        screen.wait_rows(["SYN-B-CT", "SYN-B-MR"])
        self.assertIn("Hospital(center) [숨긴 열]", screen.filter_line())
        screen.page.get_by_role("button", name="Clear", exact=True).click()
        screen.wait_rows(self.ALL_IDS)
        # Compound rules through saved searches.
        self.apply_chip(screen, "SYN EQ OR EMPTY")
        screen.wait_rows(["SYN-A-CT", "SYN-B-CT", "SYN-B-MR"])
        self.assertIn(f"복합 (Hospital 같음 {B} OR Assigned Reader 비어 있음)", screen.filter_line())
        self.apply_chip(screen, "SYN NEQ")
        screen.wait_rows(["SYN-B-CT", "SYN-B-MR", "SYN-C-CT"])
        self.apply_chip(screen, "SYN EMPTY")
        screen.wait_rows(["SYN-N-CT"])
        screen.menu("Filters", open_=False)
        # The rule editor offers Hospital as a field.
        screen.menu("Filters").get_by_role("button", name="Search & Saved Filters", exact=True).click()
        manager = screen.page.get_by_role("dialog", name="Saved Search Manager")
        manager.get_by_role("button", name="Add Rule", exact=True).first.click()
        fields = manager.get_by_role("combobox", name="Field").last.evaluate("s => [...s.options].map(o => o.text)")
        self.assertIn(HOSPITAL, fields)
        manager.get_by_role("button", name="Remove Rule").last.click()
        manager.get_by_role("button", name="Close Saved Search Manager").click()
        screen.finish()

    def test_mi02_manual_search_and_a_name_with_tele(self):
        rows = self.FILTER_ROWS + [row("2.25.207", "SYN-T-CT", inst="SYN Tele Hospital", tele=True, owner="syn-t",
                                       tele_to="hallym")]
        screen = self.boot(Server(rows=rows))
        self.type_filter(screen, HOSPITAL, "Tele")      # pair: the value is the name, so only that name matches
        screen.wait_rows(["SYN-T-CT"])
        self.type_filter(screen, HOSPITAL, "")
        screen.wait_rows(self.ALL_IDS + ["SYN-T-CT"])
        screen.page.get_by_role("combobox", name="Search Mode").select_option("manual")
        self.type_filter(screen, HOSPITAL, "center b")
        until(lambda: "조건 변경 미적용" in screen.page.get_by_text(re.compile("조건 변경 미적용")).first.inner_text())
        screen.wait_rows(self.ALL_IDS + ["SYN-T-CT"])
        screen.page.get_by_role("button", name="Search", exact=True).click()
        screen.wait_rows(["SYN-B-CT", "SYN-B-MR"])
        screen.finish()

    # ── mi03 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    SAVED_ROWS = [row("2.25.301", "SYN-S-A", inst=A),
                  row("2.25.302", "SYN-S-B1", inst=B, tele=True, owner="kin-center", tele_to="hallym"),
                  row("2.25.303", "SYN-S-C", inst=C, tele=True, owner="syn-c", tele_to="hallym"),
                  row("2.25.304", "SYN-S-B2", inst="SYN Center B2", tele=True, owner="syn-b2", tele_to="hallym")]

    def test_mi03_saved_search_keeps_hospital_text_rule_and_sort(self):
        server = Server(rows=self.SAVED_ROWS)
        screen = self.boot(server)
        self.type_filter(screen, HOSPITAL, "center")
        screen.wait_rows(["SYN-S-B1", "SYN-S-B2"])
        header = screen.table().get_by_role("columnheader", name=HOSPITAL, exact=True)
        header.click()
        header.click()   # descending
        screen.wait_rows(["SYN-S-B2", "SYN-S-B1"])
        screen.menu("Filters").get_by_role("button", name="Save Filter", exact=True).click()
        manager = screen.page.get_by_role("dialog", name="Saved Search Manager")
        manager.get_by_role("button", name="Add Rule", exact=True).first.click()
        manager.get_by_role("combobox", name="Field").last.select_option(label=HOSPITAL)
        manager.get_by_role("combobox", name="Operator").last.select_option(label="Does Not Contain")
        manager.get_by_role("textbox", name="Value").last.fill("b2")
        manager.get_by_role("textbox", name="Search Name").fill("SYN MI03")
        manager.get_by_role("button", name="Save", exact=True).click()
        until(lambda: server.filter_posts, 10, "saved search POST")
        posted = server.filter_posts[0]
        self.assertEqual("center", posted["cols"]["institutionName"])
        self.assertEqual({"version": 1, "join": "and", "rules": [{"field": "institutionName", "op": "notContains", "value": "b2"}]},
                         posted["cols"]["$compound"])
        self.assertEqual(("institutionName", -1, "Radiology"), (posted["sortKey"], posted["sortDir"], posted["mode"]))
        manager.get_by_role("button", name="Close Saved Search Manager").click()
        screen.finish()
        saved = {**posted, "id": 701}
        # Boot again with the saved search: the chip gives the same rows in the same order.
        screen = self.boot(Server(rows=self.SAVED_ROWS, filters=[saved]))
        screen.wait_rows(["SYN-S-A", "SYN-S-B1", "SYN-S-C", "SYN-S-B2"])
        self.apply_chip(screen, "SYN MI03")
        screen.wait_rows(["SYN-S-B1"])
        self.assertIn("Hospital(center)", screen.filter_line())
        screen.finish()
        # Default search: applied at boot with the product notice.
        screen = self.boot(Server(rows=self.SAVED_ROWS, filters=[{**saved, "isDefault": True}]))
        screen.wait_rows(["SYN-S-B1"])
        expect(screen.page.get_by_text('기본 필터 "SYN MI03" 적용됨 — Clear를 누르면 풀립니다')).to_be_visible()
        screen.finish()
        # Pair: the server returns the search with another Hospital text -> the server's condition is applied.
        other = {**saved, "cols": {**saved["cols"], "institutionName": "clinic c"}}
        screen = self.boot(Server(rows=self.SAVED_ROWS, filters=[other]))
        self.apply_chip(screen, "SYN MI03")
        screen.wait_rows(["SYN-S-C"])
        screen.finish()
        # Pair: the same search stored for Technician (no Hospital field there) is refused, the list is not changed.
        tech = {**saved, "mode": "Technician", "sortKey": None, "sortDir": 0}
        screen = self.boot(Server(rows=self.SAVED_ROWS, filters=[tech]))
        self.apply_chip(screen, "SYN MI03")
        expect(screen.page.get_by_text("복합 조건을 적용하지 못했습니다: 현재 모드에서 사용할 수 없는 검색 항목입니다.")).to_be_visible()
        screen.wait_rows(["SYN-S-A", "SYN-S-B1", "SYN-S-C", "SYN-S-B2"])
        self.assertIn(HOSPITAL, screen.heads())
        screen.finish()

    # ── mi04 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    def column_rows(self):
        return [row("2.25.401", "SYN-COL-01", inst=A), row("2.25.402", "SYN-COL-02", inst=B, tele=True, owner="kin-center",
                                                            tele_to="hallym")]

    def stored_value(self, screen, key):
        return screen.page.evaluate("k => localStorage.getItem(k)", key)

    def column_writes(self, screen):
        return [w for w in screen.storage_writes() if len(w) > 2 and w[2].startswith(COLUMNS_KEY)]

    def test_mi04_stored_browser_layouts_from_before_the_unit(self):
        key = layout_key(SESSION_A)
        for vector in ("V02", "V03", "V04", "V05"):
            with self.subTest(vector):
                raw = json.dumps(V[vector]["document"])
                screen = self.boot(Server(rows=self.column_rows()), storage={key: raw})
                self.assertEqual(titles_of(V[vector]["expect"]), screen.heads())
                self.assertEqual(raw, self.stored_value(screen, key), "reading does not rewrite the stored value")
                self.assertEqual([], self.column_writes(screen))
                if vector == "V02":
                    dialog = screen.open_columns()
                    expect(dialog.get_by_role("spinbutton", name="Name content width (px)")).to_have_value("240")
                    expect(dialog.get_by_role("spinbutton", name="Hospital content width (px)")).to_have_value("")
                    dialog.get_by_role("button", name="Close", exact=True).click()
                screen.finish()
        # Preserving: another permutation of the stored order is kept, Hospital after it.
        permuted = copy.deepcopy(V["V02"]["document"])
        permuted["modes"]["Radiology"]["order"].reverse()
        screen = self.boot(Server(rows=self.column_rows()), storage={key: json.dumps(permuted)})
        expected = [TITLES[k] for k in permuted["modes"]["Radiology"]["order"]
                    if k not in permuted["modes"]["Radiology"]["hidden"]] + [HOSPITAL]
        self.assertEqual(expected, screen.heads())
        screen.finish()
        # Refused documents: the default columns (Hospital last), the product notice, the stored value untouched.
        for vector in ("R01", "R02", "R03"):
            with self.subTest(vector):
                raw = json.dumps(V[vector]["document"])
                screen = self.boot(Server(rows=self.column_rows()), storage={key: raw})
                self.assertEqual(DEFAULT_TITLES, screen.heads())
                dialog = screen.open_columns()
                expect(dialog.get_by_text("저장 형식이 잘못되어 기본 열을 표시합니다. 기존 저장값은 아직 변경하지 않았습니다.")).to_be_visible()
                dialog.get_by_role("button", name="Close", exact=True).click()
                self.assertEqual(raw, self.stored_value(screen, key))
                self.assertEqual([], self.column_writes(screen))
                screen.finish()

    def test_mi04_two_owners_and_reset(self):
        a_key, b_key = layout_key(SESSION_A), layout_key(SESSION_B)
        storage = {a_key: json.dumps(V["V02"]["document"]), b_key: json.dumps(V["V03"]["document"])}
        screen = self.boot(Server(rows=self.column_rows()), storage=storage)
        self.assertEqual(titles_of(V["V02"]["expect"]), screen.heads())
        screen.finish()
        screen = self.boot(Server(rows=self.column_rows(), session=SESSION_B), storage=storage)
        self.assertEqual(titles_of(V["V03"]["expect"]), screen.heads())
        screen.finish()
        # Pair: B without a stored layout sees the default, not A's order.
        screen = self.boot(Server(rows=self.column_rows(), session=SESSION_B), storage={a_key: storage[a_key]})
        self.assertEqual(DEFAULT_TITLES, screen.heads())
        screen.finish()
        # Hospital hidden and moved, then Reset Current Mode -> the default order with Hospital last and shown.
        moved = copy.deepcopy(V["R06"]["expect"])
        moved["modes"]["Radiology"]["hidden"] = ["institutionName"]
        screen = self.boot(Server(rows=self.column_rows()), storage={a_key: json.dumps(moved)})
        self.assertNotIn(HOSPITAL, screen.heads())
        dialog = screen.open_columns()
        dialog.get_by_role("button", name="Reset Current Mode", exact=True).click()
        dialog.get_by_role("button", name="Apply for This Window", exact=True).click()
        expect(dialog).to_be_hidden()
        self.assertEqual(DEFAULT_TITLES, screen.heads())
        screen.finish()

    def account_columns(self, get_columns, put_status=200):
        state = {"revision": 3}

        def columns(method=None, body=None):
            owner = [SESSION_A["institution"], SESSION_A["sub"]]
            if method in (None, "GET"):
                return {"owner": owner, "revision": state["revision"], "columns": copy.deepcopy(get_columns), "updatedAt": None}
            if put_status != 200:
                return put_status, {"code": "SYN", "message": "열 설정 형식이 잘못되었습니다"}
            state["revision"] += 1
            return 200, {"owner": owner, "revision": state["revision"], "columns": json.loads(body)["columns"], "updatedAt": None}
        return columns

    def test_mi04_account_load_and_save_answers(self):
        key = layout_key(SESSION_A)
        for label, answer in (("new server", V["V02"]["expect"]), ("old server", V["V02"]["document"])):
            with self.subTest(label):
                server = Server(rows=self.column_rows(), columns=self.account_columns(answer))
                screen = self.boot(server)
                dialog = screen.open_columns()
                dialog.get_by_role("button", name="Load Account Settings", exact=True).click()
                expect(dialog.get_by_text("계정 설정을 편집창에 불러왔습니다. 아래 적용 버튼으로 목록에 반영하세요.")).to_be_visible()
                shown = dialog.get_by_role("checkbox", name=re.compile(r"^Show ")).evaluate_all(
                    "boxes => boxes.map(b => b.getAttribute('aria-label').slice(5))")
                self.assertEqual(HOSPITAL, shown[-1])
                dialog.get_by_role("button", name="Apply & Save in Browser", exact=True).click()
                expect(dialog).to_be_hidden()
                self.assertEqual(titles_of(V["V02"]["expect"]), screen.heads())
                self.assertEqual(V["V02"]["expect"], json.loads(self.stored_value(screen, key)))
                screen.finish()
        # An answer naming a column the page does not know is refused; the editor keeps its content.
        bad = copy.deepcopy(V["V02"]["expect"])
        bad["modes"]["Radiology"]["order"].append("patientId")
        screen = self.boot(Server(rows=self.column_rows(), columns=self.account_columns(bad)))
        dialog = screen.open_columns()
        dialog.get_by_role("button", name="Load Account Settings", exact=True).click()
        expect(dialog.get_by_text("서버가 반환한 열 설정 형식을 확인할 수 없습니다. 현재 편집 내용은 유지했습니다.")).to_be_visible()
        self.assertEqual(DEFAULT_TITLES, screen.heads())
        dialog.get_by_role("button", name="Close", exact=True).click()
        screen.finish()
        # A server that refuses the new key (an old build during deploy): 400 keeps the edit; 200 is the save notice.
        for status, sentence in ((400, "서버가 열 설정 형식을 거절했습니다. 편집 내용은 유지했습니다. 기본값 또는 저장값을 확인하세요."),
                                 (200, "편집값을 계정에 저장했습니다. 목록 반영은 아래 적용 버튼을 누르세요.")):
            with self.subTest(status):
                server = Server(rows=self.column_rows(), columns=self.account_columns(V["V01"]["expect"], put_status=status))
                screen = self.boot(server)
                dialog = screen.open_columns()
                dialog.get_by_role("button", name="Check Account Settings", exact=True).click()
                expect(dialog.get_by_text("계정에 저장된 열 설정이 있습니다.")).to_be_visible()
                dialog.get_by_role("button", name="Hospital Up", exact=True).click()
                dialog.get_by_role("button", name="Save Draft to Account", exact=True).click()
                expect(dialog.get_by_text(sentence)).to_be_visible()
                shown = dialog.get_by_role("checkbox", name=re.compile(r"^Show ")).evaluate_all(
                    "boxes => boxes.map(b => b.getAttribute('aria-label').slice(5))")
                self.assertEqual([HOSPITAL, "PreReviewer"], shown[-2:], "the edit is kept")
                put = [body for method, body in server.column_answers if method == "PUT"]
                self.assertEqual(1, len(put))
                self.assertEqual(["preDoc", "institutionName", "preReviewer"], put[0]["columns"]["modes"]["Radiology"]["order"][-3:])
                dialog.get_by_role("button", name="Close", exact=True).click()
                screen.finish(dialogs=1)

    # ── mi05 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    def legend_text(self, screen):
        legend = screen.legend()
        expect(legend).to_have_count(1)
        before_ledger, before_writes = len(screen.server.ledger), len(screen.storage_writes())
        legend.locator("summary").click()
        expect(legend).to_have_attribute("open", "")
        text = legend.inner_text()
        sizes = legend.evaluate("d => [...d.querySelectorAll('*')].filter(e => e.innerText && e.innerText.trim()).map(e => parseFloat(getComputedStyle(e).fontSize))")
        legend.locator("summary").click()
        self.assertEqual(before_ledger, len(screen.server.ledger), "opening the legend sends nothing")
        self.assertEqual(before_writes, len(screen.storage_writes()), "opening the legend stores nothing")
        self.assertTrue(sizes and min(sizes) >= 12, sizes)
        return re.sub(r"\s+", " ", text).strip()

    def check_legend(self, text):
        self.assertTrue(text.startswith("Routing Factors"), text)
        positions = [text.find(name, len("Routing Factors")) for name in FACTORS]
        self.assertTrue(all(p > 0 for p in positions) and positions == sorted(positions), positions)
        parts = {name: text[p + len(name):(positions[i + 1] if i + 1 < len(positions) else len(text))].strip()
                 for i, (name, p) in enumerate(zip(FACTORS, positions))}
        for name in NOT_CONFIGURED:
            self.assertEqual("Not Configured", parts[name], name)
        for name, source in (("Hospital", "Tele"), ("Modality", "Modality"), ("Body Part", "Read Body Parts"), ("Urgency", "EM")):
            self.assertIn(source, parts[name], name)
            self.assertTrue(has_hangul(parts[name]), name)
        self.assertIsNone(AVOIDED.search(text), text)
        self.assertIsNone(ACKNOWLEDGEMENT.search(text), text)

    def test_mi05_routing_factors_legend_infers_nothing(self):
        texts, heads, fields = [], [], []
        for desc, modality in (("NEURO CT", "MR"), ("Chest PA", "CT")):
            rows = [row("2.25.501", "SYN-F-01", inst=A, desc=desc, modality=modality),
                    row("2.25.502", "SYN-F-02", inst=B, tele=True, owner="kin-center", tele_to="hallym", desc=desc,
                        modality=modality)]
            screen = self.boot(Server(rows=rows))
            text = self.legend_text(screen)
            self.check_legend(text)
            texts.append(text)
            heads.append(screen.heads())
            self.assertEqual(DEFAULT_TITLES, heads[-1])
            tip = screen.data_row("SYN-F-02").get_by_title(TELE_TIP)
            for label in (HOSPITAL, tip.inner_text(), tip.get_attribute("title")):
                self.assertIsNone(AVOIDED.search(label), label)
                self.assertIsNone(ACKNOWLEDGEMENT.search(label), label)
            self.assertTrue(has_hangul(tip.get_attribute("title")))
            screen.menu("Filters").get_by_role("button", name="Search & Saved Filters", exact=True).click()
            manager = screen.page.get_by_role("dialog", name="Saved Search Manager")
            manager.get_by_role("button", name="Add Rule", exact=True).first.click()
            options = manager.get_by_role("combobox", name="Field").last.evaluate("s => [...s.options].map(o => o.text)")
            fields.append(options)
            self.assertIn(HOSPITAL, options)
            self.assertFalse(set(NOT_CONFIGURED) & set(options), options)
            manager.get_by_role("button", name="Remove Rule").last.click()
            manager.get_by_role("button", name="Close Saved Search Manager").click()
            self.assertNotIn("/dicom-web/", " ".join(e["path"] for e in screen.server.ledger if e["path"] != "/dicom-web/studies"))
            screen.finish()
        # Pair: data that could suggest a subspecialty changes nothing in the legend, the columns or the fields.
        self.assertEqual(texts[0], texts[1])
        self.assertEqual(heads[0], heads[1])
        self.assertEqual(fields[0], fields[1])

    # ── mi06 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    T0 = datetime(2026, 10, 5, 8, 0, tzinfo=KST)
    MINUTES = [0, 29, 31, 199, 200, 229, 231, 239, 241, 439, 441]

    def mi06_rows(self, boot, minute):
        # Server array = ascending uid (the paged list requires it): R3 first once it exists; B swaps R1 and R2.
        uid = {"A": {"R3": "2.25.6001", "R1": "2.25.6002", "R2": "2.25.6003", "R4": "2.25.6004"},
               "B": {"R3": "2.25.6001", "R2": "2.25.6002", "R1": "2.25.6003", "R4": "2.25.6004"}}[boot]
        today, month_ago = "20261005", "20260905"
        spec = {"R1": (today, "N"), "R2": (month_ago, "N"), "R3": (today, "N"), "R4": (today, "E")}
        names = ["R1", "R2", "R4"] + (["R3"] if minute >= 200 else [])
        return [row(uid[n], "SYN-MI06-" + n, inst=A, date=spec[n][0], em=spec[n][1], desc="SYN MI06 CT",
                    name="SYN MI06 " + n, acc="SYNMI06" + n) for n in names]

    def mi06_order(self, boot, minute):
        first = ["R1", "R2", "R4"] if boot == "A" else ["R2", "R1", "R4"]
        return (["R3"] + first) if minute >= 200 else first

    def observe(self, boot):
        state = {"minute": 0}
        server = Server(rows=self.mi06_rows(boot, 0), clock=lambda: self.T0 + timedelta(minutes=state["minute"]))
        screen = self.boot(server, clock_at=self.T0 - timedelta(minutes=1))
        screen.set_manual_refresh()
        observations = {}
        for minute in self.MINUTES:
            state["minute"] = minute
            server.rows = self.mi06_rows(boot, minute)
            screen.page.clock.pause_at(self.T0 + timedelta(minutes=minute))
            # Harness check: the page's own clock is at the observation minute (a step that did not move would pass (a)).
            self.assertEqual(int((self.T0 + timedelta(minutes=minute)).timestamp() * 1000), screen.page.evaluate("() => Date.now()"))
            count = sum(1 for e in server.ledger if e["path"] == "/api/studies")
            screen.refresh()
            order = ["SYN-MI06-" + n for n in self.mi06_order(boot, minute)]
            # Wait for this answer's rows as a set; their order is assertion (b), not a wait condition.
            until(lambda: sum(1 for e in server.ledger if e["path"] == "/api/studies" and e["status"]) > count
                  and sorted(screen.column("ID")) == sorted(order), 10, f"{boot} {minute} list")
            screen.page.wait_for_timeout(150)   # let every redraw of this answer finish (real time; the page clock is paused)
            captured = screen.table().evaluate(STYLE_VIEW)
            observations[minute] = {"view": captured["view"], "styles": captured["styles"], "order": order}
        screen.finish()
        return observations

    def test_mi06_urgency_is_the_server_em_and_nothing_changes_with_time(self):
        spec = {"R1": ("2026-10-05", ""), "R2": ("2026-09-05", ""), "R3": ("2026-10-05", ""), "R4": ("2026-10-05", "E")}
        seen = {boot: self.observe(boot) for boot in ("A", "B")}
        for boot, observations in seen.items():
            first = {}
            for minute in self.MINUTES:
                obs, head = observations[minute], observations[minute]["view"]["head"]
                no, pid, day, em = (head.index(t) for t in ("No", "ID", "StudyDate", "EM"))
                # (b) order, position and data against the stub.
                self.assertEqual(obs["order"], [r[pid] for r in obs["view"]["rows"]], f"(b) order {boot} {minute}")
                for position, cells in enumerate(obs["view"]["rows"], 1):
                    name = cells[pid].rsplit("-", 1)[1]
                    self.assertEqual(str(position), cells[no], f"(b) No {boot} {minute} {cells[pid]}")
                    self.assertEqual((spec[name][0], spec[name][1]), (cells[day], cells[em]), f"(b) data {boot} {minute} {cells[pid]}")
                # (a) the same row over time: style signature and every text but No.
                for cells, style in zip(obs["view"]["rows"], obs["styles"]):
                    key = cells[pid]
                    data = [c for i, c in enumerate(cells) if i != no]
                    signature = json.dumps([style["row"], [(c["cell"], c["texts"]) for c in style["cells"]]])
                    if key not in first:
                        first[key] = (minute, data, signature, style)
                        continue
                    self.assertEqual(first[key][1], data, f"(a) text {boot} {minute} {key} vs {first[key][0]}")
                    if first[key][2] != signature:
                        old = first[key][3]
                        diff = [(i, a["cell"], b["cell"], a["texts"], b["texts"]) for i, (a, b) in
                                enumerate(zip(old["cells"], style["cells"])) if (a["cell"], a["texts"]) != (b["cell"], b["texts"])]
                        self.fail(f"(a) style {boot} {minute} {key} vs {first[key][0]}: row {old['row']} -> {style['row']}; cells {diff}")
        # (c) the same position in both boots has the same style at 0 and 441 minutes (different rows, different dates).
        for minute in (0, 441):
            a, b = seen["A"][minute]["styles"], seen["B"][minute]["styles"]
            self.assertEqual(len(a), len(b))
            for position, (x, y) in enumerate(zip(a, b), 1):
                self.assertEqual((x["row"], [(c["cell"], c["texts"]) for c in x["cells"]]),
                                 (y["row"], [(c["cell"], c["texts"]) for c in y["cells"]]), f"(c) {minute} position {position}")
        # (d) the signature tells the existing EM emphasis apart from plain text in the same row.
        obs = seen["A"][0]
        head = obs["view"]["head"]
        r4 = obs["styles"][obs["order"].index("SYN-MI06-R4")]
        em_texts, desc_texts = r4["cells"][head.index("EM")]["texts"], r4["cells"][head.index("StudyDesc")]["texts"]
        self.assertEqual(1, len(em_texts))
        self.assertNotEqual(em_texts, desc_texts, "(d) the EM mark is styled apart from plain text")
        self.assertIsNone(re.search(r"지연|초과|overdue|delay", json.dumps(seen["A"][441]["view"], ensure_ascii=False), re.I))

    def test_mi06_urgency_comes_from_em_not_the_description(self):
        rows = [row("2.25.651", "SYN-STAT-N", desc="STAT CT", em="N"), row("2.25.652", "SYN-STAT-E", desc="STAT CT", em="E")]
        screen = self.boot(Server(rows=rows))
        self.assertEqual({"SYN-STAT-N": "", "SYN-STAT-E": "E"}, screen.cells_by_id("EM"))
        screen.finish()

    # ── mi07 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_mi07_hospital_header_sorts_by_name_only(self):
        for tele_name, ascending, descending in ((B, ["SYN-SO-1", "SYN-SO-3", "SYN-SO-2"], ["SYN-SO-2", "SYN-SO-1", "SYN-SO-3"]),
                                                 ("SYN Zeta Center", ["SYN-SO-2", "SYN-SO-1", "SYN-SO-3"],
                                                  ["SYN-SO-1", "SYN-SO-3", "SYN-SO-2"])):
            with self.subTest(tele_name):
                rows = [row("2.25.701", "SYN-SO-1", inst=tele_name, tele=True, owner="kin-center", tele_to="hallym"),
                        row("2.25.702", "SYN-SO-2", inst=A),
                        row("2.25.703", "SYN-SO-3", inst=tele_name, tele=True, owner="kin-center", tele_to="hallym")]
                screen = self.boot(Server(rows=rows))
                server_order = ["SYN-SO-1", "SYN-SO-2", "SYN-SO-3"]
                screen.wait_rows(server_order)
                header = screen.table().get_by_role("columnheader", name=HOSPITAL, exact=True)
                header.click()
                screen.wait_rows(ascending)
                header.click()
                screen.wait_rows(descending)
                header.click()
                screen.wait_rows(server_order)
                screen.finish()

    # ── mi08 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_mi08_assignment_filters_keep_tele_rows(self):
        empty = self.compound("SYN UNASSIGNED", "and", [{"field": "assignedReader", "op": "empty"}])
        for reader, filtered, unassigned in (
                (("SYN Reader K", "syn-reader-k"), ["SYN-AS-T1"], ["SYN-AS-OWN", "SYN-AS-T2"]),
                (None, [], ["SYN-AS-OWN", "SYN-AS-T1", "SYN-AS-T2"])):
            with self.subTest(bool(reader)):
                rows = [row("2.25.801", "SYN-AS-OWN", inst=A),
                        row("2.25.802", "SYN-AS-T1", inst=B, tele=True, owner="kin-center", tele_to="hallym", reader=reader),
                        row("2.25.803", "SYN-AS-T2", inst=B, tele=True, owner="kin-center", tele_to="hallym")]
                screen = self.boot(Server(rows=rows, filters=[empty]))
                cells = screen.cells_by_id("Assigned Reader")
                self.assertEqual("SYN Reader K · syn-reader-k" if reader else "Unassigned", cells["SYN-AS-T1"])
                self.assertEqual("Unassigned", cells["SYN-AS-T2"])
                self.type_filter(screen, "Assigned Reader", "reader k")
                screen.wait_rows(filtered)
                self.type_filter(screen, "Assigned Reader", "")
                self.apply_chip(screen, "SYN UNASSIGNED")
                screen.wait_rows(unassigned)
                screen.finish()

    # ── mi09 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_mi09_technician_mode_and_reqhosp(self):
        session = {**SESSION_A, "roles": ["radiologist", "technician"]}
        rows = [row("2.25.901", "SYN-T-OWN", inst=A), row("2.25.902", "SYN-T-TELE", inst=B, tele=True, owner="kin-center",
                                                            tele_to="hallym")]
        server = Server(rows=rows, session=session)
        screen = self.boot(server)
        expect(screen.legend()).to_be_visible()
        self.type_filter(screen, HOSPITAL, "center")
        screen.wait_rows(["SYN-T-TELE"])
        tabs = screen.page.get_by_text("Technician", exact=True).first
        tabs.click()
        until(lambda: "ReqHosp" in screen.heads(), 10, "Technician columns")
        self.assertNotIn(HOSPITAL, screen.heads())
        screen.wait_rows(["SYN-T-OWN", "SYN-T-TELE"])
        self.assertEqual({"SYN-T-OWN": A, "SYN-T-TELE": B + " ▸원격"}, screen.cells_by_id("ReqHosp"))
        expect(screen.legend()).to_be_hidden()
        screen.page.get_by_text("Radiology", exact=True).first.click()
        until(lambda: HOSPITAL in screen.heads(), 10, "Radiology columns")
        screen.wait_rows(["SYN-T-TELE"])
        expect(screen.legend()).to_be_visible()
        screen.page.get_by_role("button", name="Clear", exact=True).click()
        screen.wait_rows(["SYN-T-OWN", "SYN-T-TELE"])
        # A Hospital sort does not survive the Technician tab (no such column there).
        screen.table().get_by_role("columnheader", name=HOSPITAL, exact=True).click()
        screen.wait_rows(["SYN-T-TELE", "SYN-T-OWN"])   # ascending by name: SYN Center B before SYN Hospital A
        screen.page.get_by_text("Technician", exact=True).first.click()
        until(lambda: "ReqHosp" in screen.heads(), 10, "Technician columns")
        screen.wait_rows(["SYN-T-OWN", "SYN-T-TELE"])
        screen.page.get_by_text("Radiology", exact=True).first.click()
        until(lambda: HOSPITAL in screen.heads(), 10, "Radiology columns")
        screen.wait_rows(["SYN-T-OWN", "SYN-T-TELE"])
        # Switch ReqHosp in Technician changes ReqHosp only; the Hospital cell stays the server's name.
        screen.page.get_by_text("Technician", exact=True).first.click()
        until(lambda: "ReqHosp" in screen.heads(), 10, "Technician columns")
        screen.prompt_answer = "SYN Edited"
        screen.data_row("SYN-T-OWN").get_by_role("cell", name="SYN-T-OWN", exact=True).click(button="right")
        screen.page.get_by_text("Switch ReqHosp", exact=True).click()
        until(lambda: server.patches, 10, "ReqHosp PATCH")
        self.assertEqual(1, len(server.patches))
        self.assertEqual("SYN Edited", server.patches[0][1].get("reqHosp"))
        until(lambda: screen.cells_by_id("ReqHosp")["SYN-T-OWN"] == "SYN Edited", 10, "ReqHosp cell")
        screen.page.get_by_text("Radiology", exact=True).first.click()
        until(lambda: HOSPITAL in screen.heads(), 10, "Radiology columns")
        self.assertEqual(A, screen.cells_by_id(HOSPITAL)["SYN-T-OWN"])
        related = screen.page.get_by_role("table").filter(
            has=screen.page.get_by_role("columnheader", name="Report", exact=True))
        self.assertNotIn(HOSPITAL, related.evaluate("t => [...t.tHead.rows[0].cells].map(c => c.innerText.trim())"))
        screen.finish(dialogs=1)

    # ── mi10 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    ATTACKS = ['<img src=x onerror="window.synXss=1;fetch(\'/__syn_xss__/1\')">', '"><svg onload="alert(2)">', "&amp;", '"',
               "가" * 200]

    def attack_rows(self):
        rows = []
        for i, name in enumerate(self.ATTACKS):
            rows.append(row(f"2.25.10{i}1", f"SYN-X-OWN-{i}", inst=name))
            rows.append(row(f"2.25.10{i}2", f"SYN-X-TELE-{i}", inst=name, tele=True, owner="kin-center", tele_to="hallym"))
        return rows

    def check_attacks(self, screen):
        cells = screen.cells_by_id(HOSPITAL)
        for i, name in enumerate(self.ATTACKS):
            self.assertEqual(name, cells[f"SYN-X-OWN-{i}"], i)
            self.assertEqual(name + " Tele", cells[f"SYN-X-TELE-{i}"], i)
            label = screen.data_row(f"SYN-X-TELE-{i}").get_by_title(TELE_TIP)
            expect(label).to_have_count(1)
            expect(label).to_have_text("Tele")
            expect(screen.data_row(f"SYN-X-OWN-{i}").get_by_title(TELE_TIP)).to_have_count(0)
        screen.page.wait_for_timeout(300)
        self.assertNotIn("/__syn_xss__/1", [e["path"] for e in screen.server.ledger])

    def test_mi10_external_strings_stay_text(self):
        screen = self.boot(Server(rows=self.attack_rows()))
        self.check_attacks(screen)
        screen.finish()
        # Preserving (RF-7): a stored Hospital width wraps the cell content in its width box; the same text and label.
        layout = {"version": 1, "modes": {"Radiology": {"order": list(DEFAULT_ORDER), "hidden": [],
                                                        "appearance": {"widths": {"institutionName": 180}, "font": "default",
                                                                       "size": 13, "color": "default"}},
                                          "Technician": {"order": [], "hidden": []}}}
        screen = self.boot(Server(rows=self.attack_rows()), storage={layout_key(SESSION_A): json.dumps(layout)})
        self.check_attacks(screen)
        screen.finish()

    # ── mi11 ──────────────────────────────────────────────────────────────────────────────────────────────────────
    def test_mi11_refresh_closed_renamed_and_late_answers(self):
        own = row("2.25.1101", "SYN-R-OWN", inst=A)
        tele = lambda name: row("2.25.1102", "SYN-R-TELE", inst=name, tele=True, owner="kin-center", tele_to="hallym")
        server = Server(rows=[own, tele(B)])
        screen = self.boot(server)
        screen.set_manual_refresh()
        screen.wait_rows(["SYN-R-OWN", "SYN-R-TELE"])
        server.rows = [own]                      # the owner closed the tele
        screen.refresh()
        screen.wait_rows(["SYN-R-OWN"])
        server.rows = [own, tele(B)]             # opened again
        screen.refresh()
        screen.wait_rows(["SYN-R-OWN", "SYN-R-TELE"])
        self.assertEqual(B + " Tele", screen.cells_by_id(HOSPITAL)["SYN-R-TELE"])
        server.rows = [own, tele("SYN Center B2")]   # the registry name changed
        screen.refresh()
        until(lambda: screen.cells_by_id(HOSPITAL)["SYN-R-TELE"] == "SYN Center B2 Tele", 10, "renamed")
        # A Hospital filter stays on the new answer.
        self.type_filter(screen, HOSPITAL, "center")
        screen.wait_rows(["SYN-R-TELE"])
        server.rows = [own, tele("SYN Center B3"), row("2.25.1103", "SYN-R-TELE-2", inst=C, tele=True, owner="syn-c",
                                                      tele_to="hallym")]
        screen.refresh()
        until(lambda: screen.cells_by_id(HOSPITAL) == {"SYN-R-TELE": "SYN Center B3 Tele"},
              10, "mi11 refreshed Hospital row under active filter")
        screen.wait_rows(["SYN-R-TELE"])
        self.assertEqual("SYN Center B3 Tele", screen.cells_by_id(HOSPITAL)["SYN-R-TELE"])
        self.type_filter(screen, HOSPITAL, "")
        screen.wait_rows(["SYN-R-OWN", "SYN-R-TELE", "SYN-R-TELE-2"])
        # A late answer to an earlier request never replaces a later one.
        server.hold_lists = 1
        screen.refresh()
        until(lambda: server.held, 10, "held list request")
        server.rows = [own, tele("SYN Center NEW")]
        screen.refresh()
        until(lambda: screen.cells_by_id(HOSPITAL).get("SYN-R-TELE") == "SYN Center NEW Tele", 10, "later answer")
        screen.wait_rows(["SYN-R-OWN", "SYN-R-TELE"])
        server.release(0, [own, tele("SYN Center OLD")])
        screen.page.wait_for_timeout(500)
        self.assertEqual("SYN Center NEW Tele", screen.cells_by_id(HOSPITAL)["SYN-R-TELE"])
        # Pair: answers in order -> the last one is shown.
        server.rows = [own, tele("SYN Center LAST")]
        screen.refresh()
        until(lambda: screen.cells_by_id(HOSPITAL).get("SYN-R-TELE") == "SYN Center LAST Tele", 10, "in-order answer")
        screen.finish()


if __name__ == "__main__":
    unittest.main(verbosity=2)
