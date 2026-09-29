# coding: utf-8
"""REQ-S7-U4b-PANEL -> RISK-S7-U4b-STALE-PANEL / RISK-S7-U4b-FAIL-AS-EMPTY -> TEST-S7-U4b-DOM
(contract S7-U4p sections 7, 7.1, 8, 8.1, 10 and 11.4 CC-D01..CC-D10; scenario rows are named per case).

The Clinical Context panel of the reading screen, run as shipped. main.html's markup and stylesheets (scripts stripped, the
eight stylesheets inlined where they are linked) come from a synthetic origin; the shipped auth.js (the real KinAuth, whose
identity comes from an in-test /api/me), study-arrivals.js and clinical-context.js are loaded byte for byte; the page's
own api(), cur(), relatedStudy(), viewed(), viewingUid(), renderClinical() and applyObservation() are handed out by the
browser's parser and run as shipped (every other page name they touch resolves to an inert stand-in, the technique of
tests/critical_result_sender_dom_test.py); and the S7-U4b block is cut out of main.html from its own header line to its own
closing catch line and run as is. An in-test server answers GET /api/studies/{uid}/clinical-context from
tests/clinical_context_vectors.json, whose valid answers the compiled server shape check accepts
(tests/clinical_context_model_test.cjs cm01), so no answer here is one the server could not send.

Late answers are proved on two paths (scenario-table section 5):
  (ga) transport cancel: the in-test server holds an answer; the page's next request aborts the earlier one. This shows the
       cancel happens (the earlier fetch's signal is aborted and the request fails) and is not the defence.
  (na) cancel ignored: a harness fetch wrapper keeps chosen clinical-context calls off the network, ignores their
       AbortSignal and ends them when the case says so with a Response built from a vector (or a TypeError). The shipped
       api() reads that body; the case first asserts that the call was already aborted and that its body was consumed,
       so the late answer did reach the product, and only then asserts what the panel shows.

Cases (each also checks at tearDown: no page error, no request the harness does not answer, no browser dialog):
  cd01 five section states, titles, counts, English labels / Korean sentences, no avoided word in the panel's own text
  cd02 failed, not configured, stale and whole failures are never "No clinical information provided." or None
  cd03 A->B->A, related view and late answers on both paths (L-01..L-04, L-09, L-10, L-12, R-01..R-03, S-09)
  cd04 no order: order keys make the answer malformed and their values never show; the fixed scope sentence; seeded orders
  cd05 provenance and permission basis of every item (owner / tele), the field order of each line, folded report text
  cd06 the section 8.1 stale table through the shipped applyObservation, a failed re-read, marks that stay, no re-read
  cd07 access loss on a re-read (404, 403, 409) clears the items; a busy re-read keeps them as Stale
  cd08 the D8 identity conflict alert and row marks; inconsistent conflict flags are malformed
  cd09 roles: radiologist, admin, clinician+radiologist read; technician, clinician+technician and demo never ask
  cd10 markup in values stays text
  cd11 whole-answer failures with their reasons (OP-1 decided by D172), Retry, disabled controls while a read is out
  cd12 session end (end list, other tab, storage, pagehide, the panel's own 401, another account) on both paths
  cd13 nothing else on the screen changes; open report text survives repaints; storage untouched; the 45% bound
  cd14 the request: its shape, one per change of the viewed study and in that order, none for the same study, none by time
  cd15 every malformed vector and a non-JSON body are Failed with nothing painted
  cd16 offline hides and asks nothing; back online asks once
  cd17 an answer about another study than the request changes nothing (ABA-3, OP-2 decided by D172)

When a request is sent (inside the selection's own call, in a microtask or after a timer) is not asserted: counts, order,
targets, the first frame after an operation and late-answer refusal are (fix1 F04, D73). Only the contract's ids,
data-section / data-state and roles are read from the DOM; texts are the contract's (vectors texts) filled with the page's
local time (YYYY-MM-DD HH:MM:SS, scenario-table section 0) of the context's time zone.

Synthetic data only (SYN-* names, 1.2.826.0.1.3680043.10.* UIDs): no stack, no network, no credentials.
"""
import copy
import json
import re
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


MAIN = lf_text(HPACS / "main.html")
SHIPPED = {name: lf_text(HPACS / name) for name in ("auth.js", "study-arrivals.js", "clinical-context.js")}
VECTORS = json.loads((ROOT / "tests" / "clinical_context_vectors.json").read_text(encoding="utf-8"))
VALID, MALFORMED = VECTORS["answers"]["valid"], VECTORS["answers"]["malformed"]
CONTEXTS, LISTS, TEXTS = VECTORS["request_context"], VECTORS["lists"], VECTORS["texts"]
U = VECTORS["uids"]
A, B, C, R, X, Y, Z = U["A"], U["B"], U["C"], U["related"], U["X"], U["Y"], U["Z"]
ORIGIN = "https://reader.test"
BASE = "/worklist/hpacs-lite/"
SECTIONS = ["priorReports", "history", "requestTags", "techNote"]
TITLES = TEXTS["sectionTitles"]
AVOIDED = re.compile(TEXTS["avoided"], re.IGNORECASE)
KST = timezone(timedelta(hours=9))   # the context runs in Asia/Seoul (no daylight saving since 1988)
INSTITUTION, SUB = "SYN-INST-A", "0b1f6a2e-4c1d-4b8e-9a61-2f3c4d5e6f70"
NAMES = {"syn-rad@kin": "SYN Radiologist", "syn-rad2@kin": "SYN Radiologist Two", "syn-tech@kin": "SYN Technologist"}
KEYWORDS = ("ReasonForStudy", "ReasonForTheRequestedProcedure", "AdditionalPatientHistory", "AdmittingDiagnosesDescription",
            "StudyComments")
SEED_ORDER_TEXTS = ("O-9001", "KIM CHULSOO", "Brain CT without contrast", "PARK MD")


def local(iso):
    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).astimezone(KST).strftime("%Y-%m-%d %H:%M:%S")


def fill(template, **values):
    return re.sub(r"\{(\w+)\}", lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), template)


def row(uid, name, desc, **extra):
    base = {"uid": uid, "name": name, "id": "SYN-P-" + uid.rsplit(".", 1)[1], "date": "20260929", "birth": "19700101", "sex": "F",
            "age": "56", "acc": "SYN-ACC-" + uid.rsplit(".", 1)[1], "count": 10, "series": 2, "ss": "Verified", "matched": "U",
            "ward": "", "tele": False, "sourcePatientKey": "SYN-INST-A|SYN-PID-01", "institutionName": "SYN Hospital A",
            "desc": desc, "modality": "CT", "state": {"rs": "T", "version": 0}}
    base.update(extra)
    return base


STUDIES = [row(A, "SYN ALPHA", "SYN ROW ALPHA", tele=True), row(B, "SYN BRAVO", "SYN ROW BRAVO"),
           row(C, "SYN CHARLIE", "SYN ROW CHARLIE"), row(R, "SYN ROMEO", "SYN ROW ROMEO")]


def me(roles):
    return {"kind": "member", "sub": SUB, "user": "syn-rad@kin", "actor": "syn-rad@kin", "displayName": "SYN Radiologist",
            "roles": roles, "institution": INSTITUTION}


def page_html(text):
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", text, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: "<style>" + (HPACS / m.group(1)).read_text(encoding="utf-8") + "</style>", html)
    return re.sub(r"<link\b[^>]*>", "", html)


HEADER = "    // ── 임상 정보 패널(S7-U4b) ──\n"


def cut_block(text):
    """The S7-U4b block from its own header line to its own closing line - the first top-level catch after the header.
    A missing or doubled header fails the case; no neighbouring unit's marker is used, so a block added later does not move
    the cut."""
    if text.count(HEADER) != 1:
        raise AssertionError(f"the S7-U4b block header occurs {text.count(HEADER)} times in main.html")
    first = text.index(HEADER)
    end = text.index("\n    } catch (_) {", first) + 1
    return text[first:text.index("\n", end) + 1]


PAGE_SCRIPT = "\n".join(re.findall(r"<script>(.*?)</script>", MAIN, flags=re.S))

# Records every fetch the page makes (order, target, headers, signal). With window.synHold set, a clinical-context call
# never reaches the network: its AbortSignal is ignored and the case ends it with synFinish (a Response the shipped api()
# reads) or synFail (a TypeError, a connection that failed).
FETCH_WRAPPER = """(() => {
  const realFetch = window.fetch.bind(window);
  const paths = window.synPaths = [];
  const calls = window.synCalls = [];   // the clinical-context calls, in order; synFinish/synFail take this index
  window.synHold = false;
  window.fetch = function (input, init) {
    const options = init || {};
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    paths.push((options.method || 'GET').toUpperCase() + ' ' + url.pathname);
    if (!/\\/clinical-context$/.test(url.pathname)) return realFetch(input, init);
    const headers = {};
    for (const [key, value] of Object.entries(options.headers || {})) headers[key.toLowerCase()] = value;
    const call = { index: calls.length, method: (options.method || 'GET').toUpperCase(), path: url.pathname, query: url.search,
      headers, body: options.body === undefined ? null : options.body, signal: options.signal || null, held: false,
      abortedAtFinish: null, response: null, rejected: false };
    calls.push(call);
    if (window.synHold) {
      call.held = true;
      return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
    }
    return realFetch(input, init);
  };
  window.synFinish = (index, status, text) => {
    const call = calls[index];
    call.abortedAtFinish = !!(call.signal && call.signal.aborted);
    call.response = new Response(text, { status, headers: { 'content-type': 'application/json' } });
    call.resolve(call.response);
  };
  window.synFail = index => {
    const call = calls[index];
    call.abortedAtFinish = !!(call.signal && call.signal.aborted);
    call.rejected = true;
    call.reject(new TypeError('Failed to fetch'));
  };
  window.synCallView = () => calls.map(c => ({ index: c.index, method: c.method, path: c.path, query: c.query, headers: c.headers,
    body: c.body, held: c.held, aborted: !!(c.signal && c.signal.aborted), abortedAtFinish: c.abortedAtFinish,
    bodyUsed: c.response ? c.response.bodyUsed : null, rejected: c.rejected }));
})();"""

# The page's own variables the block and the page functions read. They hold state only; no product rule is restated here.
PRELUDE = "\nconst synPageScript = " + json.dumps(PAGE_SCRIPT, ensure_ascii=False) + ";" + """
const API = location.origin + '/api';
const $ = selector => document.querySelector(selector);
let sess = KinAuth.session();
let serverMode = !window.synDemo, demoMode = !!window.synDemo, offline = false;
let selectedUid = null, relatedUid = null;
let studies = window.synStudies;
let appState = {};
const toast = (message, kind) => { window.synToasts.push([message, kind]); };
function displayActor(value) { return window.synNames[value] || value; }
let studyObservationModel = KinStudyArrivals.observationStart();
// The page functions, as shipped: the page script is compiled as the body of a function that returns them before its first
// statement runs, and each is rebuilt from its own text so that a name this harness does not define resolves to an inert
// stand-in whose calls, reads and writes do nothing.
const synInert = new Proxy(function () {}, {
  get: (_, key) => key === Symbol.toPrimitive ? () => '' : synInert,
  set: () => true, has: () => false, apply: () => synInert, construct: () => synInert,
});
const synScope = new Proxy({}, {
  has: (_, name) => {
    if (typeof name !== 'string') return false;
    try { (0, eval)(name); return false; } catch (error) { return error instanceof ReferenceError; }
  },
  get: (_, key) => key === Symbol.unscopables ? undefined : synInert,
  set: () => true,
});
const synShipped = new Function('return [api, cur, relatedStudy, viewed, viewingUid, renderClinical, applyObservation];\\n'
  + synPageScript)().map(String);
let api, cur, relatedStudy, viewed, viewingUid, renderClinical, applyObservation;
with (synScope) {
  api = eval('(' + synShipped[0] + ')'); cur = eval('(' + synShipped[1] + ')'); relatedStudy = eval('(' + synShipped[2] + ')');
  viewed = eval('(' + synShipped[3] + ')'); viewingUid = eval('(' + synShipped[4] + ')');
  renderClinical = eval('(' + synShipped[5] + ')'); applyObservation = eval('(' + synShipped[6] + ')');
}
"""

TAIL = """
window.synPick = uid => { selectedUid = uid; relatedUid = null; renderClinical(); };
window.synRelated = uid => { relatedUid = uid; renderClinical(); };
window.synReturn = () => { relatedUid = null; renderClinical(); };
window.synRender = () => renderClinical();
window.synObserve = result => applyObservation(result);
// goOffline() and goOnline() assign exactly these two (main.html); no other combination is made here.
window.synOffline = () => { serverMode = false; offline = true; renderClinical(); };
window.synOnline = () => { serverMode = true; offline = false; renderClinical(); };
// A poll that rebuilt the list without the study and did not call renderClinical (scenario L-09).
window.synDrop = uid => { studies = studies.filter(s => s.uid !== uid); };
window.synEnd = reason => (window.kinOn401 || []).forEach(end => { try { end(reason); } catch (_) {} });
window.synSeen = [];
(() => {
  const root = document.querySelector('#clinical-context');
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.textContent) window.synSeen.push(node.textContent);
    window.synSeen.push(root.textContent);
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
})();
window.synPanel = () => {
  const q = s => document.querySelector(s);
  const root = q('#clinical-context'), status = q('#clinical-context-status'), conflict = q('#clinical-context-conflict');
  const shown = e => !!e && e.getClientRects().length > 0;
  return {
    shown: shown(root), status: status.textContent, statusTitle: status.title,
    conflict: shown(conflict) ? conflict.textContent : null, conflictRole: conflict.getAttribute('role'),
    buttons: [...root.querySelectorAll('button')].filter(shown).map(b => [b.textContent, b.disabled]),
    sections: [...root.querySelectorAll('[data-section]')].map(s => ({ name: s.dataset.section, state: s.dataset.state,
      text: s.innerText, all: s.textContent, titled: [...s.querySelectorAll('[title]')].map(e => [e.textContent, e.title]),
      open: [...s.querySelectorAll('details')].map(d => d.open) })),
    text: shown(root) ? root.innerText : '', all: root.textContent, titles: [...root.querySelectorAll('[title]')].map(e => e.title),
    clinical: q('#clinical').innerText, scope: q('#clinical-context-scope').textContent,
  };
};
// The panel as the first frame after an operation shows it (ABA-4 "at once", scenario S-09).
window.synFrame = (operation, argument) => new Promise(resolve => {
  window[operation](argument);
  requestAnimationFrame(() => resolve(window.synPanel()));
});
"""
SETUP = """(v) => { window.synStudies = v.studies; window.synNames = v.names; window.synToasts = []; window.synDemo = v.demo; }"""


class Stub:
    """The in-test server. Answers per study UID come from a queue (then a default); every request is logged."""

    def __init__(self):
        self.queue, self.default, self.log, self.held, self.logouts = {}, {}, [], [], []
        self.identity = me(["radiologist"])
        self.hold_logout = False

    def body(self, spec):
        if "vector" in spec:
            return 200, json.dumps(VALID[spec["vector"]], ensure_ascii=False)
        if "malformed" in spec:
            return 200, json.dumps(MALFORMED[spec["malformed"]]["answer"], ensure_ascii=False)
        if "context" in spec:
            return 200, json.dumps(CONTEXTS[spec["context"]]["answer"], ensure_ascii=False)
        if "raw" in spec:
            return spec.get("status", 200), spec["raw"]
        return spec["status"], json.dumps(spec.get("json", {}), ensure_ascii=False)


class ClinicalContextDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.block = cut_block(MAIN)
        cls.markup = page_html(MAIN)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.stub = Stub()
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1366, "height": 900}, timezone_id="Asia/Seoul", locale="ko-KR")
        self.context.add_init_script(FETCH_WRAPPER)
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", self.on_dialog)
        self.page.on("requestfinished", lambda request: self.finished.append(request))
        self.page.on("requestfailed", lambda request: self.finished.append(request))

    def tearDown(self):
        xss = None
        try:
            xss = self.page.evaluate("() => window.synXss ?? null")
        except PlaywrightError:
            pass
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")
        self.assertIsNone(xss, "no markup in a value ran")

    def on_dialog(self, dialog):
        self.dialogs.append(f"{dialog.type}: {dialog.message}")
        dialog.dismiss()

    # ── the synthetic origin ──
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
            if name == "main.html":
                route.fulfill(body=self.markup, content_type="text/html; charset=utf-8")
            elif name in SHIPPED:
                route.fulfill(body=SHIPPED[name], content_type="application/javascript; charset=utf-8")
            elif name == "index.html":
                route.fulfill(body="<!doctype html><title>SYN login</title>", content_type="text/html; charset=utf-8")
            else:
                route.fulfill(status=404, body="")   # the emblem the markup names; no repository byte is read
            return
        if path.startswith("/kin-brand/") or path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(status=200, json=self.stub.identity)
            return
        if method == "POST" and path == "/api/auth/logout":
            self.stub.logouts.append(route)
            if not self.stub.hold_logout:
                route.fulfill(status=204, body="")
            return
        found = re.fullmatch(r"/api/studies/([^/]+)/clinical-context", path)
        if method != "GET" or not found:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        uid = unquote(found.group(1))
        queue = self.stub.queue.get(uid) or []
        spec = queue.pop(0) if queue else self.stub.default.get(uid)
        entry = {"uid": uid, "path": path, "query": url.query, "headers": dict(request.headers), "body": request.post_data,
                 "request": request, "route": route, "spec": spec}
        self.stub.log.append(entry)
        if spec is None:
            self.unexpected.append(f"{method} {path} with no answer planned")
            route.abort()
        elif spec.get("hold"):
            self.stub.held.append(entry)
        else:
            self.respond(entry)

    def respond(self, entry):
        spec, route = entry["spec"], entry["route"]
        if spec.get("abort"):
            route.abort("connectionreset")
            return
        status, text = self.stub.body(spec)
        route.fulfill(status=status, body=text, content_type="application/json")

    # ── helpers ──
    def open_reader(self, roles=("radiologist",), demo=False, clock=False, studies=None, storage=None):
        self.stub.identity = me(list(roles))
        self.page.goto(ORIGIN + BASE + "main.html")
        if clock:
            self.page.clock.install()
        if storage:
            self.page.evaluate("items => { for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); }", storage)
        if demo:
            self.page.evaluate("() => sessionStorage.setItem('kin-demo', '1')")
        self.page.evaluate(SETUP, {"studies": studies or STUDIES, "names": NAMES, "demo": demo})
        for name in ("auth.js", "study-arrivals.js", "clinical-context.js"):
            self.page.add_script_tag(url=ORIGIN + BASE + name)
        self.page.evaluate("async () => { await KinAuth.init(); }")
        self.page.add_script_tag(content=PRELUDE + self.block + TAIL)
        self.assertEqual([], self.page.evaluate("() => window.synToasts"), "the block mounted")

    def answer(self, uid, **spec):
        self.stub.queue.setdefault(uid, []).append(spec)

    def js(self, name, argument=None):
        return self.page.evaluate(f"a => window.{name}(a)", argument)

    def pick(self, uid):
        self.js("synPick", uid)

    def frames(self, count=2):
        self.page.evaluate("n => new Promise(r => { const step = k => k ? requestAnimationFrame(() => step(k - 1)) : r(); step(n); })",
                           count)

    def wait_until(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settle(self):
        """Every request the page sent has been answered (held ones aside) and the answers have run; then two frames."""
        self.page.wait_for_timeout(20)
        held = [entry["request"] for entry in self.stub.held]

        def done():
            asked = [entry["request"] for entry in self.stub.log if not any(entry["request"] is h for h in held)]
            return all(any(item is request for item in self.finished) for request in asked)
        self.wait_until(done, "the answered requests reaching the page")
        self.frames(2)

    def show(self, uid, **spec):
        """A first read of `uid`: away from it (nothing viewed, no request), then onto it with one planned answer."""
        self.answer(uid, **spec)
        self.pick(None)
        self.pick(uid)
        self.settle()

    def panel(self):
        return self.page.evaluate("() => window.synPanel()")

    def refresh_button(self):
        return self.page.get_by_role("region", name="Clinical Context").get_by_role("button", name="Refresh")

    def sections(self):
        return {s["name"]: s for s in self.panel()["sections"]}

    def calls(self):
        return self.page.evaluate("() => window.synCallView()")

    def asked(self):
        """The studies of the page's clinical-context requests, in the order the page made them (the fetch record, so a
        request sent after a timer or already cancelled when sent is counted too)."""
        return [unquote(call["path"].split("/")[3]) for call in self.calls()]

    def wait_calls(self, count):
        self.wait_until(lambda: len(self.calls()) >= count, f"{count} clinical-context request(s) made")

    def paths(self):
        """Every fetch the page made, as "METHOD /path"."""
        return self.page.evaluate("() => window.synPaths.slice()")

    def forget_observation(self):
        """Hand the panel a list read before any answer here (same values), so the next answer starts unmarked: every case
        reuses the same answer times, which a real re-read would move past the last list."""
        early = copy.deepcopy(LISTS["L-SAME"])
        early["observation"]["observedAt"] = "2026-09-29T00:00:00.000Z"
        self.js("synObserve", early)

    def seen(self):
        return "\n".join(self.page.evaluate("() => window.synSeen"))

    def take(self, uid=None):
        """The oldest held request (of `uid`)."""
        self.wait_until(lambda: any(uid is None or e["uid"] == uid for e in self.stub.held), f"a held request for {uid}")
        entry = next(e for e in self.stub.held if uid is None or e["uid"] == uid)
        self.stub.held.remove(entry)
        return entry

    def release_late(self, entry):
        """Answer a held request the page has already aborted: nothing may reach it."""
        try:
            self.respond(entry)
        except PlaywrightError:
            pass
        self.page.wait_for_timeout(50)
        self.frames(2)

    def finish(self, index, vector=None, status=200, body=None, raw=None):
        if vector is not None:
            text = json.dumps(VALID[vector], ensure_ascii=False)
        elif raw is not None:
            text = raw
        else:
            text = json.dumps(body if body is not None else {}, ensure_ascii=False)
        self.page.evaluate("([i, s, t]) => window.synFinish(i, s, t)", [index, status, text])
        self.page.wait_for_timeout(20)
        self.frames(2)

    def assert_consumed_late(self, index, aborted=True):
        """Fitness of path (na): the call was already aborted when it ended, and the shipped api() read its answer."""
        call = self.calls()[index]
        self.assertTrue(call["held"], call)
        if aborted:
            self.assertTrue(call["abortedAtFinish"], "the late call had already been cancelled: " + json.dumps(call))
        if call["rejected"]:
            self.assertEqual((call["headers"].get("x-kin-csrf"), call["headers"].get("content-type")), ("1", "application/json"),
                             "the rejected promise was the one api() awaited")
        else:
            self.assertTrue(call["bodyUsed"], "api() consumed the late answer's body: " + json.dumps(call))

    def state_of(self, name):
        return self.sections()[name]["state"]

    def own_text(self, text, answer):
        """The panel's own sentences: its text with every string value of the answer, DICOM keywords and times removed."""
        values = []

        def walk(value):
            if isinstance(value, dict):
                for item in value.values():
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)
            elif isinstance(value, str) and len(value) > 1:
                values.append(value)
        walk(answer)
        values += [NAMES.get(v, v) for v in values] + list(KEYWORDS)
        for value in sorted(set(values), key=len, reverse=True):
            text = text.replace(value, " ")
        return re.sub(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", " ", text)

    # ── cd01 ──
    def test_cd01_every_section_state_has_its_english_name_and_korean_sentence(self):
        self.open_reader()
        self.show(A, vector="A-MIXED")
        region = self.page.get_by_role("region", name="Clinical Context")
        expect(region).to_be_visible()
        expect(region.get_by_role("heading", name="Clinical Context")).to_be_visible()
        expect(region.get_by_role("button", name="Refresh")).to_be_enabled()
        panel = self.panel()
        self.assertEqual([s["name"] for s in panel["sections"]], SECTIONS)
        states = {s["name"]: s["state"] for s in panel["sections"]}
        self.assertEqual(states, {"priorReports": "not_configured", "history": "failed", "requestTags": "present", "techNote": "absent"})
        s = {x["name"]: x for x in panel["sections"]}
        answer = VALID["A-MIXED"]
        # not_configured: its own sentence, never None
        self.assertIn(TITLES["priorReports"], s["priorReports"]["text"])
        self.assertIn(TEXTS["stateLabels"]["not_configured"], s["priorReports"]["text"])
        self.assertIn(TEXTS["notConfigured"]["no_patient_key"], s["priorReports"]["text"])
        self.assertNotIn(TEXTS["stateLabels"]["absent"], s["priorReports"]["text"])
        # failed: Failed, the fixed sentence and a Retry in that section
        self.assertIn(TEXTS["stateLabels"]["failed"], s["history"]["text"])
        self.assertIn(TEXTS["failed"], s["history"]["text"])
        history = region.get_by_role("group", name=TITLES["history"])
        expect(history.get_by_role("button", name="Retry")).to_be_enabled()
        # present: the count in the title and the read time and source label
        self.assertIn(TITLES["requestTags"] + " (2)", s["requestTags"]["text"])
        self.assertIn(fill(TEXTS["present"], observedAt=local(answer["sections"]["requestTags"]["observedAt"]),
                           sourceLabel=TEXTS["sourceLabels"]["requestTags"]), s["requestTags"]["text"])
        # absent: None and its sentence
        self.assertIn(TEXTS["stateLabels"]["absent"], s["techNote"]["text"])
        self.assertIn(fill(TEXTS["absent"], observedAt=local(answer["sections"]["techNote"]["observedAt"])), s["techNote"]["text"])
        self.assertNotIn(TEXTS["noInformation"], panel["status"])
        # stale: a later list observation with a Tech Note version the answer did not have
        self.js("synObserve", LISTS["L-TN-FIRST"])
        self.frames()
        s = self.sections()
        self.assertEqual(s["techNote"]["state"], "stale")
        self.assertIn(TEXTS["stateLabels"]["stale"], s["techNote"]["text"])
        self.assertNotIn(TEXTS["stateLabels"]["absent"], s["techNote"]["text"])
        self.assertIn(fill(TEXTS["stale"], observedAt=local(answer["sections"]["techNote"]["observedAt"]),
                           cause=TEXTS["staleCauses"]["list_changed"]), s["techNote"]["text"])
        own = self.own_text(self.panel()["text"], answer)
        self.assertIsNone(AVOIDED.search(own), own)

    def test_cd01_counts_follow_the_items_and_truncated_adds_a_plus(self):
        self.open_reader()
        self.show(A, vector="A-ONE")
        titles = [s["text"].split("\n")[0] for s in self.panel()["sections"]]
        self.assertEqual(titles, [TITLES[n] + " (1)" for n in SECTIONS])
        self.show(A, vector="A-TRUNC")
        s = self.sections()
        self.assertTrue(s["priorReports"]["text"].startswith(TITLES["priorReports"] + " (10+)"))
        self.assertTrue(s["history"]["text"].startswith(TITLES["history"] + " (200+)"))
        self.assertEqual(len(self.page.get_by_role("group", name=TITLES["history"]).get_by_role("listitem").all()), 200)
        # counterexample input: the same answer with its section keys in another order paints the same
        reordered = copy.deepcopy(VALID["A-MIXED"])
        reordered["sections"] = {name: reordered["sections"][name] for name in reversed(SECTIONS)}
        self.show(A, vector="A-MIXED")
        first = self.panel()
        self.show(A, raw=json.dumps(reordered, ensure_ascii=False), status=200)
        again = self.panel()
        self.assertEqual([(x["name"], x["state"], x["text"]) for x in first["sections"]],
                         [(x["name"], x["state"], x["text"]) for x in again["sections"]])

    def test_cd01_items_keep_the_order_the_server_sent(self):
        """I-01: the server orders items (original StudyDate descending, then UID); the screen does not order them again."""
        self.open_reader()
        self.show(A, vector="A-PRESENT-OWNER")
        region = self.page.get_by_role("region", name="Clinical Context")
        for name in ("priorReports", "history"):
            wanted = [item["study"]["description"] for item in VALID["A-PRESENT-OWNER"]["sections"][name]["items"]]
            lines = region.get_by_role("group", name=TITLES[name]).get_by_role("listitem").all_inner_texts()
            self.assertEqual(len(lines), len(wanted), name)
            for line, description in zip(lines, wanted):
                self.assertIn(description, line, name)
        # the input side: the history in another order is shown in that other order
        other = copy.deepcopy(VALID["A-PRESENT-OWNER"])
        other["sections"]["history"]["items"].reverse()
        self.show(A, raw=json.dumps(other, ensure_ascii=False), status=200)
        lines = region.get_by_role("group", name=TITLES["history"]).get_by_role("listitem").all_inner_texts()
        for line, item in zip(lines, other["sections"]["history"]["items"]):
            self.assertIn(item["study"]["description"], line)

    # ── cd02 ──
    def test_cd02_failed_unread_and_stale_are_never_no_information(self):
        self.open_reader()
        none = TEXTS["stateLabels"]["absent"]
        self.show(A, vector="A-ABSENT4")
        panel = self.panel()
        self.assertEqual(panel["status"], TEXTS["noInformation"])
        self.assertEqual({s["state"] for s in panel["sections"]}, {"absent"})
        # the pair: only requestTags was not read (derived objects only)
        self.show(A, vector="A-TAGS-NC")
        panel = self.panel()
        self.assertNotIn(TEXTS["noInformation"], panel["all"])
        tags = self.sections()["requestTags"]
        self.assertEqual(tags["state"], "not_configured")
        self.assertNotIn(none, tags["text"])
        self.assertNotIn(TEXTS["checkedPrefix"].strip(), tags["all"])
        self.assertIn(TEXTS["notConfigured"]["no_original_instance"], tags["text"])
        for vector, names in (("A-FAILED-PH-UNAVAILABLE", ("priorReports", "history")), ("A-NOKEY", ("priorReports", "history")),
                              ("A-TAGS-FAILED-UNAVAILABLE", ("requestTags",)), ("A-TN-FAILED", ("techNote",))):
            with self.subTest(vector=vector):
                self.show(A, vector=vector)
                self.assertNotIn(TEXTS["noInformation"], self.panel()["all"])
                for name in names:
                    self.assertNotIn(none, self.sections()[name]["text"], name)
        for label, spec in (("busy", {"status": 503, "json": {"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"}}),
                            ("network", {"abort": True}), ("malformed", {"malformed": "M-SCHEMA-2"})):
            with self.subTest(whole=label):
                self.show(A, **spec)
                panel = self.panel()
                self.assertEqual(panel["sections"], [])
                self.assertNotIn(TEXTS["noInformation"], panel["all"])
                self.assertIn(TEXTS["stateLabels"]["failed"], panel["status"])
        # stale: the all-absent answer after a list shows a Tech Note - the sentence and that None go
        self.show(A, vector="A-ABSENT4")
        self.js("synObserve", LISTS["L-TN-FIRST"])
        self.frames()
        panel = self.panel()
        self.assertNotIn(TEXTS["noInformation"], panel["all"])
        self.assertEqual(self.sections()["techNote"]["state"], "stale")
        self.assertNotIn(none, self.sections()["techNote"]["text"])

    # ── cd03 ──
    def test_cd03_path_ga_transport_cancel_happens_and_the_last_request_wins(self):
        self.open_reader()
        # L-01: A held, B answered, A released late
        self.answer(A, vector="A-MARK-1", hold=True)
        self.answer(B, vector="A-B")
        self.pick(A)
        a1 = self.take(A)
        self.pick(B)
        self.settle()
        self.assertIn("SYN-B-MARK", self.panel()["text"])
        self.wait_until(lambda: a1["request"].failure is not None, "the earlier request failing (cancelled)")
        self.assertTrue(self.calls()[0]["aborted"], "the earlier fetch's signal is aborted")
        self.release_late(a1)
        self.assertIn("SYN-B-MARK", self.panel()["text"])
        self.assertNotIn("SYN-MARK-1", self.seen())
        # L-02 / L-03: A1, B2, A3 held; released A3, B2, A1
        self.answer(A, vector="A-MARK-1", hold=True)
        self.answer(B, vector="A-MARK-2", hold=True)
        self.answer(A, vector="A-MARK-3", hold=True)
        self.pick(A)
        first = self.take(A)
        self.pick(B)
        second = self.take(B)
        self.pick(A)
        third = self.take(A)
        self.respond(third)
        self.settle()
        self.assertIn("SYN-MARK-3", self.panel()["text"])
        self.release_late(second)
        self.release_late(first)
        self.assertIn("SYN-MARK-3", self.panel()["text"])
        seen = self.seen()
        self.assertNotIn("SYN-MARK-1", seen)
        self.assertNotIn("SYN-MARK-2", seen)
        # the same inputs in order: A's answer before B is chosen is painted, then replaced (preserving input)
        self.answer(A, vector="A-MARK-1")
        self.answer(B, vector="A-B")
        self.pick(None)
        self.pick(A)
        self.settle()
        self.assertIn("SYN-MARK-1", self.panel()["text"])
        self.pick(B)
        self.settle()
        self.assertIn("SYN-B-MARK", self.panel()["text"])
        self.assertNotIn("SYN-MARK-1", self.panel()["all"])

    def test_cd03_path_na_late_answers_reach_api_and_are_refused_by_generation(self):
        self.open_reader()
        # the markers differ, or the case could not tell the answers apart
        marks = {name: json.dumps(VALID[name]) for name in ("A-MARK-1", "A-MARK-2", "A-MARK-3", "A-B", "A-RELATED")}
        self.assertNotIn("SYN-MARK-1", marks["A-MARK-3"])
        self.assertNotIn("SYN-MARK-3", marks["A-MARK-1"])
        self.page.evaluate("() => { window.synHold = true; }")
        # L-02: A1 -> B -> A3; A3 answers; A1 answers late with a success
        self.pick(A)
        self.pick(B)
        self.pick(A)
        self.wait_calls(3)
        self.assertEqual(self.asked(), [A, B, A])
        self.finish(2, "A-MARK-3")
        self.assertIn("SYN-MARK-3", self.panel()["text"])
        self.finish(0, "A-MARK-1")
        self.assert_consumed_late(0)
        self.assertIn("SYN-MARK-3", self.panel()["text"])
        self.assertNotIn("SYN-MARK-1", self.seen())
        # L-03: B's late answer too
        self.finish(1, "A-MARK-2")
        self.assert_consumed_late(1)
        self.assertIn("SYN-MARK-3", self.panel()["text"])
        self.assertNotIn("SYN-MARK-2", self.seen())
        # L-04: A shown, B asked, back to A, B's answer arrives
        self.pick(B)          # 3
        self.pick(A)          # 4
        self.wait_calls(5)
        self.finish(4, "A-MARK-3")
        self.finish(3, "A-B")
        self.assert_consumed_late(3)
        self.assertNotIn("SYN-B-MARK", self.seen())
        self.assertIn("SYN-MARK-3", self.panel()["text"])
        # L-10: B's late 503 marks nothing on A
        self.pick(B)          # 5
        self.pick(A)          # 6
        self.wait_calls(7)
        self.finish(6, "A-MARK-3")
        self.finish(5, status=503, body={"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"})
        self.assert_consumed_late(5)
        panel = self.panel()
        self.assertEqual({s["state"] for s in panel["sections"]} & {"stale", "failed"}, set())
        self.assertNotIn(TEXTS["stateLabels"]["failed"], panel["status"])
        # R-03: the related study asked, back to the reading target, the related answer arrives
        self.js("synRelated", R)   # 7
        self.js("synReturn")       # 8
        self.wait_calls(9)
        self.finish(8, "A-MARK-3")
        self.finish(7, "A-RELATED")
        self.assert_consumed_late(7)
        self.assertNotIn("SYN-RELATED-MARK", self.seen())

    def test_cd03_path_na_a_late_failure_of_the_same_study_changes_nothing(self):
        """L-12: A1 (cancel ignored) -> B -> A3 painted -> A1 ends 503 / 404 / 409 / a failed connection."""
        self.open_reader()
        self.page.evaluate("() => { window.synHold = true; }")
        for kind in ("503", "404", "409", "network"):
            with self.subTest(kind=kind):
                start = len(self.calls())
                self.pick(A)
                self.pick(B)
                self.pick(A)
                self.wait_calls(start + 3)
                self.finish(start + 2, "A-MARK-3")
                before = self.panel()
                self.assertIn("SYN-MARK-3", before["text"])
                if kind == "network":
                    self.page.evaluate("i => window.synFail(i)", start)
                    self.page.wait_for_timeout(20)
                    self.frames()
                else:
                    self.finish(start, status=int(kind), body={"code": "SYN-" + kind, "message": "SYN late " + kind})
                self.assert_consumed_late(start)
                after = self.panel()
                self.assertEqual(after["sections"], before["sections"])
                self.assertEqual(after["status"], before["status"])
                self.assertNotIn(TEXTS["stateLabels"]["failed"], after["all"])
                self.assertNotIn(TEXTS["stateLabels"]["stale"], after["all"])
                self.finish(start + 1, "A-B")
                self.pick(C)   # leave A so the next round starts from another study
                self.wait_calls(start + 4)
                self.finish(start + 3, "A-MARK-4")

    def test_cd03_first_frame_after_a_change_shows_no_earlier_item_and_the_related_view(self):
        self.open_reader()
        self.show(A, vector="A-PRESENT-OWNER")
        self.assertIn("SYN CT CHEST", self.panel()["text"])
        # S-09: B chosen, B's answer held - the first frame already has none of A's items and says Loading…
        self.answer(B, vector="A-B", hold=True)
        frame = self.page.evaluate("uid => window.synFrame('synPick', uid)", B)
        self.assertTrue(frame["shown"])
        self.assertEqual(frame["status"], TEXTS["controls"]["loading"])
        self.assertEqual(frame["sections"], [])
        for text in ("SYN CT CHEST", "SYN MR BRAIN", "Owner"):
            self.assertNotIn(text, frame["all"])
        self.assertEqual([b for b in frame["buttons"] if not b[1]], [], "Refresh and Retry are off while the read is out")
        self.respond(self.take(B))
        self.settle()
        self.assertIn("SYN-B-MARK", self.panel()["text"])
        # R-01 / R-02: the related study is read in place of the reading target and the reading target is read again after
        self.answer(A, vector="A-PRESENT-OWNER")
        self.pick(A)
        self.settle()
        self.answer(R, vector="A-RELATED", hold=True)
        frame = self.page.evaluate("uid => window.synFrame('synRelated', uid)", R)
        self.assertEqual(frame["status"], TEXTS["controls"]["loading"])
        self.assertNotIn("SYN CT CHEST", frame["all"])
        self.assertIn("관련 검사 정보 · 판독 대상은 바뀌지 않습니다", frame["clinical"])
        self.respond(self.take(R))
        self.settle()
        self.assertIn("SYN-RELATED-MARK", self.panel()["text"])
        self.answer(A, vector="A-MARK-3")
        self.js("synReturn")
        self.settle()
        self.assertIn("SYN-MARK-3", self.panel()["text"])
        self.assertEqual(self.asked()[-3:], [A, R, A], "A is read again, not taken from memory")
        # L-09: the viewed study leaves the list without a repaint; its answer is not painted under nothing
        self.answer(B, vector="A-B", hold=True)
        self.pick(B)
        held = self.take(B)
        self.js("synDrop", B)
        mark = len(self.page.evaluate("() => window.synSeen"))
        self.respond(held)
        self.settle()
        self.assertNotIn("SYN-B-MARK", "\n".join(self.page.evaluate("() => window.synSeen")[mark:]))
        self.assertEqual(self.panel()["status"], TEXTS["controls"]["loading"], "a known limit: Loading… until the next repaint")

    # ── cd04 ──
    def test_cd04_no_order_value_shows_and_order_keys_make_the_answer_malformed(self):
        seed = {"kin-orders": json.dumps([{"oid": "O-9001", "name": "KIM CHULSOO", "descr": "Brain CT without contrast",
                                           "reqDoc": "PARK MD", "ward": "SYN WARD"}])}
        self.open_reader(storage=seed)
        for name in ("M-ORDER-SECTION", "M-WARD-KEY", "M-OV-KEY", "M-ORIG-KEY", "M-MATCHED-KEY", "M-OID-KEY"):
            with self.subTest(name=name):
                self.show(A, malformed=name)
                panel = self.panel()
                self.assertIn(TEXTS["stateLabels"]["failed"], panel["status"])
                self.assertEqual(panel["sections"], [])
                html = self.page.evaluate("() => document.body.outerHTML")
                self.assertNotIn("SYN-ORDER-SENTINEL", html)
                self.assertNotIn(MALFORMED[name]["visible"], panel["all"])
        # the pair: the same answer without the order key is painted
        self.show(A, vector="A-PRESENT-OWNER")
        panel = self.panel()
        self.assertIn("SYN CT CHEST", panel["text"])
        self.assertEqual(panel["scope"], TEXTS["scope"])
        self.assertEqual(self.page.locator("#clinical-context-scope").count(), 1)
        for text in SEED_ORDER_TEXTS + ("SYN WARD",):
            self.assertNotIn(text, panel["all"])
            self.assertNotIn(text, " ".join(panel["titles"]))
        self.assertIsNone(re.search(r"\border\b|오더 행|Not Connected", panel["all"].replace(TEXTS["scope"], "")))
        # the only reads are the session check and the panel's route - never an order, the seeded list or a bootstrap
        self.assertEqual({p for p in self.paths() if not p.endswith("/clinical-context")}, {"GET /api/me"})

    # ── cd05 ──
    def test_cd05_every_item_carries_its_source_times_and_permission_basis(self):
        self.open_reader()
        for vector, access in (("A-PRESENT-OWNER", "owner"), ("A-PRESENT-TELE", "tele")):
            with self.subTest(vector=vector):
                answer = VALID[vector]
                self.show(A, vector=vector)
                badge = TEXTS["access"][access]["label"]
                title = fill(TEXTS["access"][access]["title"], institutionName=answer["anchor"]["institutionName"])
                region = self.page.get_by_role("region", name="Clinical Context")
                for name in SECTIONS:
                    group = region.get_by_role("group", name=TITLES[name])
                    items = group.get_by_role("listitem")
                    count = len(answer["sections"][name]["items"])
                    self.assertEqual(items.count(), count, name)
                    for i in range(count):
                        badges = items.nth(i).get_by_title(title, exact=True)
                        self.assertEqual(badges.count(), 1, (name, i))
                        self.assertEqual(badges.first.inner_text(), badge, (name, i))
                s = self.sections()
                # past report line: {date} {modalities} {description} · Approve v3 · author · recordedAt · Owner
                prior = answer["sections"]["priorReports"]["items"][0]
                line = region.get_by_role("group", name=TITLES["priorReports"]).get_by_role("listitem").first.inner_text()
                order = [prior["study"]["description"], "Approve v3", NAMES[prior["provenance"]["author"]],
                         local(prior["provenance"]["recordedAt"]), badge]
                self.assert_order(line, order)
                self.assertNotIn(prior["report"]["findings"], s["priorReports"]["text"], "report text is folded")
                self.assertIn(prior["report"]["findings"], s["priorReports"]["all"])
                self.assertEqual(s["priorReports"]["open"], [False, False])
                self.assertIn("Addendum v2", s["priorReports"]["text"])
                self.assertIn(TEXTS["sourceLabels"]["priorReports"], s["priorReports"]["text"])
                # history line: {date} {modalities} {description} {accession} · institution · RS · Signed/— · Owner
                x = answer["sections"]["history"]["items"][2]
                line = region.get_by_role("group", name=TITLES["history"]).get_by_role("listitem").nth(2).inner_text()
                self.assert_order(line, [x["study"]["description"], x["study"]["accession"], x["institutionName"], "RS T", "—", badge])
                self.assertIn("Signed", s["history"]["text"])
                self.assertIn(local(x["provenance"]["recordedAt"]), line)
                self.assertIn(local(x["provenance"]["observedAt"]), line)
                # request tag: {keyword} ({gggg,eeee}): {value}; DICOM header · SOP · recorded "-" with its reason · read time
                tag = answer["sections"]["requestTags"]["items"][0]
                line = region.get_by_role("group", name=TITLES["requestTags"]).get_by_role("listitem").first.inner_text()
                self.assert_order(line, ["ReasonForStudy (0032,1030): " + tag["value"], "DICOM header", "SOP " + tag["provenance"]["recordId"],
                                         local(tag["provenance"]["observedAt"]), badge])
                # the header has no recording time: shown as "-" with the reason as its tooltip (contract 5.1)
                self.assertTrue(any(title == TEXTS["recordedAtNone"] and shown.rstrip().endswith("-")
                                    for shown, title in s["requestTags"]["titled"]), s["requestTags"]["titled"])
                self.assertIn(TEXTS["checkedPrefix"], s["requestTags"]["text"])
                # Tech Note: Tech Note v2 · author · recordedAt · Owner (no text, no reason)
                note = answer["sections"]["techNote"]["items"][0]
                line = region.get_by_role("group", name=TITLES["techNote"]).get_by_role("listitem").first.inner_text()
                self.assert_order(line, ["Tech Note v2", NAMES[note["provenance"]["author"]], local(note["provenance"]["recordedAt"]), badge])
                self.assertNotIn(TEXTS["noText"], line)
                # every time shown has the server's ISO value as its tooltip
                self.assertIn(prior["provenance"]["recordedAt"], [t[1] for t in s["priorReports"]["titled"]])
        # the badge comes from the answer, not from the list row (study A's row says tele: true)
        self.show(A, vector="A-PRESENT-OWNER")
        self.assertNotIn("Tele", self.panel()["text"].split())
        self.show(A, vector="A-TN-EMPTY")
        self.assertIn(TEXTS["noText"], self.sections()["techNote"]["text"])
        self.show(A, vector="A-TAG-NOTTEXT")
        self.assertIn("ReasonForStudy (0032,1030): " + TEXTS["tagNotes"]["not_text"], self.sections()["requestTags"]["text"])
        self.show(A, vector="A-TAG-TOOLONG")
        self.assertIn("AdditionalPatientHistory (0010,21B0): " + TEXTS["tagNotes"]["too_long"], self.sections()["requestTags"]["text"])
        self.show(A, vector="A-TAG-MAXLEN")
        self.assertIn(VALID["A-TAG-MAXLEN"]["sections"]["requestTags"]["items"][0]["value"].strip(), self.sections()["requestTags"]["all"])
        self.show(A, malformed="M-ACCESS-MISMATCH")
        self.assertEqual(self.panel()["sections"], [])

    def assert_order(self, text, parts):
        at = -1
        for part in parts:
            found = text.find(part, at + 1)
            self.assertGreater(found, at, f"{part!r} after position {at} in {text!r}")
            at = found

    # ── cd06 ──
    def test_cd06_later_list_observations_mark_sections_stale_and_nothing_reads_again(self):
        self.open_reader()
        for case in VECTORS["stale_cases"]:
            if case["answer"] != "A-PRESENT-OWNER" or case.get("before"):
                continue
            with self.subTest(case=case["id"]):
                self.forget_observation()
                self.show(A, vector="A-PRESENT-OWNER")
                asked = len(self.calls())
                for name in case["observations"]:
                    self.js("synObserve", LISTS[name])
                self.frames()
                s = self.sections()
                for section in SECTIONS:
                    expected = "stale" if case["expect"][section] else VALID["A-PRESENT-OWNER"]["sections"][section]["state"]
                    self.assertEqual(s[section]["state"], expected, section)
                    if case["expect"][section]:
                        self.assertIn(TEXTS["staleCauses"]["list_changed"], s[section]["text"])
                self.assertIn("SYN CT CHEST", self.panel()["text"], "the items stay")
                self.assertEqual(len(self.calls()), asked, "no read of its own")
        for case_id in ("T-08", "T-08-p", "T-09", "T-10", "T-11-early", "T-11-failed", "T-03-absent", "T-06-failed", "T-06-nokey", "T-07"):
            case = next(c for c in VECTORS["stale_cases"] if c["id"] == case_id)
            with self.subTest(case=case_id):
                self.forget_observation()
                self.show(A, vector=case["answer"])
                for name in case["observations"]:
                    self.js("synObserve", LISTS[name])
                self.frames()
                s = self.sections()
                for section in SECTIONS:
                    expected = "stale" if case["expect"][section] else VALID[case["answer"]]["sections"][section]["state"]
                    self.assertEqual(s[section]["state"], expected, section)
                    if case["expect"][section]:
                        self.assertNotIn(TEXTS["stateLabels"]["absent"], s[section]["text"])
                if any(case["expect"].values()):
                    self.assertNotIn(TEXTS["noInformation"], self.panel()["all"])
        # T-14: an observation that arrives while the read is out is compared when the answer is painted
        self.forget_observation()
        self.answer(A, vector="A-PRESENT-OWNER", hold=True)
        self.pick(None)
        self.pick(A)
        held = self.take(A)
        self.js("synObserve", LISTS["L-Y-ADDENDUM"])
        self.respond(held)
        self.settle()
        self.assertEqual((self.state_of("priorReports"), self.state_of("history")), ("stale", "stale"))
        # T-17: an observation that cannot be read changes nothing
        self.forget_observation()
        self.show(A, vector="A-PRESENT-OWNER")
        before = self.panel()
        self.js("synObserve", {"studies": "not rows", "owner": ["SYN-INST-A", SUB], "observation": {"observedAt": "2026-09-29T02:00:00.000Z"}})
        self.frames()
        self.assertEqual(self.panel()["sections"], before["sections"])
        # R-05: in the related view the baseline is the related study's answer
        self.answer(R, vector="A-RELATED")
        self.js("synRelated", R)
        self.settle()
        self.js("synObserve", LISTS["L-X-FIRST-APPROVE"])
        self.frames()
        self.assertEqual(self.state_of("history"), "stale")

    def test_cd06_a_failed_reread_keeps_the_answer_as_stale_and_marks_stay_until_a_new_answer(self):
        self.open_reader(clock=True)
        self.show(A, vector="A-PRESENT-OWNER")
        self.js("synObserve", LISTS["L-Y-ADDENDUM"])
        self.frames()
        self.js("synObserve", LISTS["L-SAME-LATER"])
        self.frames()
        self.assertEqual(self.state_of("history"), "stale", "a later observation back at the old values does not unmark")
        asked = len(self.calls())
        self.page.clock.run_for(10 * 60 * 1000)
        self.frames()
        self.assertEqual(len(self.calls()), asked, "no read by time")
        self.assertEqual(self.state_of("history"), "stale", "no unmark by time")
        # Refresh -> 503: items kept, the read sections Stale with the failed re-read, the status says so
        self.answer(A, status=503, json={"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"})
        self.refresh_button().click()
        self.settle()
        panel = self.panel()
        self.assertIn("SYN CT CHEST", panel["text"])
        self.assertIn(TEXTS["staleCauses"]["refresh_failed"], panel["status"])
        self.assertIn(TEXTS["stateLabels"]["stale"], panel["status"])
        s = self.sections()
        self.assertEqual({n: s[n]["state"] for n in SECTIONS}, {n: "stale" for n in SECTIONS})
        self.assertIn(TEXTS["staleCauses"]["refresh_failed"], s["techNote"]["text"])
        # a new answer clears every mark (F-10 / F-14)
        self.answer(A, vector="A-PRESENT-OWNER-2")
        self.refresh_button().click()
        self.settle()
        s = self.sections()
        self.assertEqual({n: s[n]["state"] for n in SECTIONS}, {n: "present" for n in SECTIONS})
        self.assertIn("SYN reason: refreshed", self.panel()["text"])
        self.assertNotIn(TEXTS["stateLabels"]["stale"], self.panel()["all"])

    # ── cd07 ──
    def test_cd07_access_loss_on_a_reread_clears_the_items(self):
        self.open_reader()
        for status, code in ((404, None), (403, "CLINICAL_CONTEXT_ROLE"), (403, "CLINICIAN_ROUTE_DENIED"),
                             (409, "CLINICAL_CONTEXT_CHANGED"), (409, "STUDY_ACCESS_CHANGED")):
            with self.subTest(status=status, code=code):
                self.show(A, vector="A-PRESENT-OWNER")
                body = {"message": "SYN refused"} if code is None else {"code": code, "message": "SYN refused"}
                self.answer(A, status=status, json=body)
                self.refresh_button().click()
                self.settle()
                panel = self.panel()
                self.assertEqual(panel["sections"], [])
                self.assertNotIn("SYN CT CHEST", panel["all"])
                self.assertIn(TEXTS["stateLabels"]["failed"], panel["status"])
                self.assertIn("HTTP %d" % status, panel["status"])
                if status == 409:
                    self.assertIn(TEXTS["changed"], panel["status"])
                if code:
                    self.assertIn(code, panel["status"])
                expect(self.page.get_by_role("region", name="Clinical Context").get_by_role("button", name="Retry")).to_be_enabled()
        # the pair: a busy re-read keeps the items as Stale
        self.show(A, vector="A-PRESENT-OWNER")
        self.answer(A, status=503, json={"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"})
        self.refresh_button().click()
        self.settle()
        self.assertIn("SYN CT CHEST", self.panel()["text"])
        self.assertEqual(self.state_of("history"), "stale")

    # ── cd08 ──
    def test_cd08_identity_conflict_alert_and_row_marks(self):
        self.open_reader()
        for vector, fields, marks in (("A-CONFLICT-BIRTH", "birth", ["Birth Date Mismatch"]), ("A-CONFLICT-SEX", "sex", ["Sex Mismatch"]),
                                      ("A-CONFLICT-BOTH", "both", ["Birth Date Mismatch", "Sex Mismatch"])):
            with self.subTest(vector=vector):
                self.show(A, vector=vector)
                alert = self.page.get_by_role("alert")
                expect(alert).to_be_visible()
                text = alert.inner_text()
                self.assertIn(TEXTS["conflictTitle"], text)
                self.assertIn(fill(TEXTS["conflict"], fields=TEXTS["conflictFields"][fields]), text)
                history = self.sections()["history"]
                for mark in marks:
                    self.assertIn(mark, history["text"])
                items = self.page.get_by_role("group", name=TITLES["history"]).get_by_role("listitem")
                self.assertEqual(items.count(), 3, "no row is hidden, merged or split")
        self.show(A, vector="A-PRESENT-OWNER")
        self.assertIsNone(self.panel()["conflict"])
        self.assertNotIn("Mismatch", self.panel()["all"])
        for name in ("M-CONFLICT-FALSE", "M-CONFLICT-TRUE"):
            with self.subTest(name=name):
                self.show(A, malformed=name)
                self.assertEqual(self.panel()["sections"], [])
                self.assertIsNone(self.panel()["conflict"])

    # ── cd09 ──
    def test_cd09_only_radiologist_or_admin_sessions_show_and_ask(self):
        for roles, demo, reads in ((["radiologist"], False, True), (["admin"], False, True), (["clinician", "radiologist"], False, True),
                                   (["technician"], False, False), (["clinician", "technician"], False, False), ([], True, False)):
            with self.subTest(roles=roles, demo=demo):
                self.tearDown()
                self.setUp()
                self.open_reader(roles=roles, demo=demo)
                self.stub.default = {A: {"vector": "A-PRESENT-OWNER"}, R: {"vector": "A-RELATED"}}
                region = self.page.get_by_role("region", name="Clinical Context")
                expect(region).to_be_hidden()          # V-07: nothing selected
                self.pick(A)
                self.js("synRelated", R)
                self.js("synReturn")
                self.settle()
                self.page.evaluate("() => document.querySelector('#clinical-context-refresh').click()")
                self.settle()
                if reads:
                    expect(region).to_be_visible()
                    self.assertEqual(self.asked(), [A, R, A, A], "one read per change, one per Refresh")
                else:
                    expect(region).to_be_hidden()
                    self.assertEqual(self.calls(), [])
                    self.assertEqual(self.stub.log, [])

    # ── cd10 ──
    def test_cd10_markup_in_values_stays_text(self):
        self.open_reader()
        self.show(A, vector="A-XSS-PLAIN")
        plain = self.page.evaluate("() => [...document.querySelectorAll('#clinical-context-sections *')].map(e => e.tagName).join(',')")
        self.show(A, vector="A-XSS")
        risky = self.page.evaluate("() => [...document.querySelectorAll('#clinical-context-sections *')].map(e => e.tagName).join(',')")
        self.assertEqual(risky, plain, "the same elements for the same shape")
        panel = self.panel()
        for text in ("<img src=x onerror=window.synXss=1>", "<script>window.synXss=2</script>", "<svg onload=window.synXss=4>",
                     "<img src=x onerror=window.synXss=6>", "<img src=x onerror=window.synXss=7>"):
            self.assertIn(text, panel["all"])
        self.page.locator("#clinical-context-sections details").first.evaluate("d => { d.open = true; }")
        self.frames()
        self.assertIsNone(self.page.evaluate("() => window.synXss ?? null"))
        self.assertEqual(self.page.locator("#clinical-context img, #clinical-context script, #clinical-context svg").count(), 0)

    # ── cd11 ──
    def test_cd11_whole_answer_failures_retry_and_one_read_at_a_time(self):
        self.open_reader()
        reasons = {}
        for label, spec, http in (("busy", {"status": 503, "json": {"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"}}, "HTTP 503"),
                                  ("busy-plain", {"status": 503, "json": {"message": "원본 메타데이터를 읽지 못했습니다"}}, "HTTP 503"),
                                  ("network", {"abort": True}, None),
                                  ("502", {"status": 502, "raw": "<html>bad gateway</html>"}, "HTTP 502"),
                                  ("504", {"status": 504, "raw": "<html>gateway timeout</html>"}, "HTTP 504"),
                                  ("500", {"status": 500, "json": {"message": "SYN error"}}, "HTTP 500"),
                                  ("400", {"status": 400, "json": {"code": "CLINICAL_CONTEXT_INPUT_INVALID", "message": "SYN bad"}}, "HTTP 400")):
            with self.subTest(label=label):
                self.show(A, **spec)
                panel = self.panel()
                self.assertEqual(panel["sections"], [])
                self.assertIn(TEXTS["stateLabels"]["failed"], panel["status"])
                if http:
                    self.assertIn(http, panel["status"])
                if label == "400":
                    self.assertIn("CLINICAL_CONTEXT_INPUT_INVALID", panel["status"])
                expect(self.page.get_by_role("region", name="Clinical Context").get_by_role("button", name="Retry")).to_be_enabled()
                # the reason sentence alone: the HTTP status and the server code the status line adds are taken out
                reasons[label] = " ".join(re.sub(r"HTTP \d{3}|CLINICAL_CONTEXT_[A-Z_]+|[()·]", " ", panel["status"]).split())
        self.assertEqual(reasons["busy"], reasons["busy-plain"])
        self.assertEqual(reasons["network"], reasons["502"])
        self.assertEqual(reasons["502"], reasons["504"])
        self.assertEqual(reasons["504"], reasons["500"])
        self.assertEqual(len({reasons["busy"], reasons["network"], reasons["400"]}), 3, reasons)
        # Retry once = one request; a success paints, another failure shows its reason
        asked = len(self.calls())
        self.answer(A, status=503, json={"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"})
        self.page.get_by_role("region", name="Clinical Context").get_by_role("button", name="Retry").click()
        self.settle()
        self.assertEqual(len(self.calls()), asked + 1)
        self.assertIn(TEXTS["stateLabels"]["failed"], self.panel()["status"])
        self.answer(A, vector="A-PRESENT-OWNER")
        self.page.get_by_role("region", name="Clinical Context").get_by_role("button", name="Retry").click()
        self.settle()
        self.assertEqual(len(self.calls()), asked + 2)
        self.assertIn("SYN CT CHEST", self.panel()["text"])
        self.assertNotIn(TEXTS["stateLabels"]["failed"], self.panel()["status"])
        # F-08: while a read is out, Refresh and Retry are off and pressing them sends nothing
        self.answer(A, vector="A-PRESENT-OWNER", hold=True)
        self.refresh_button().click()
        held = self.take(A)
        asked = len(self.calls())
        self.assertEqual([b for b in self.panel()["buttons"] if not b[1]], [])
        for _ in range(3):
            self.page.evaluate("() => document.querySelectorAll('#clinical-context button').forEach(b => b.click())")
        self.frames()
        self.assertEqual(len(self.calls()), asked)
        # F-09: a read that never answers does not stop the next study
        self.answer(B, vector="A-B")
        self.pick(B)
        self.settle()
        self.assertIn("SYN-B-MARK", self.panel()["text"])
        self.release_late(held)
        # the pair: a first read that fails is Failed; the same failure after a success keeps the items as Stale (cd07)
        self.show(A, status=503, json={"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"})
        self.assertEqual(self.panel()["sections"], [])

    # ── cd12 ──
    def test_cd12_session_end_empties_the_panel_before_anything_else_on_path_ga(self):
        ends = (("end list", "() => window.synEnd()"), ("account changed", "() => window.synEnd('account-changed')"),
                ("other tab", "() => new BroadcastChannel('kin-session').postMessage({ type: 'session-ended' })"),
                ("storage", "() => window.dispatchEvent(new StorageEvent('storage', { key: 'kin-session-ended', newValue: '1' }))"),
                ("pagehide", "() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))"))
        for label, script in ends:
            with self.subTest(end=label):
                self.tearDown()
                self.setUp()
                self.open_reader()
                self.show(A, vector="A-PRESENT-OWNER")
                self.answer(A, vector="A-PRESENT-OWNER-2", hold=True)
                self.refresh_button().click()
                held = self.take(A)
                self.page.evaluate(script)
                self.page.wait_for_timeout(50)
                self.frames()
                region = self.page.get_by_role("region", name="Clinical Context")
                expect(region).to_be_hidden()
                self.assertEqual(self.panel()["sections"], [])
                self.release_late(held)
                self.assertNotIn("SYN reason: refreshed", self.seen())
                expect(region).to_be_hidden()
                self.page.evaluate("() => { window.synEnd(); window.synEnd('account-changed'); }")   # E-08: again, harmless
                self.stub.default = {B: {"vector": "A-B"}}
                self.pick(B)
                self.settle()
                self.assertEqual(self.asked(), [A, A], "no read after the end in this document")
                expect(region).to_be_hidden()
        # the pair: the same held re-read without an end keeps the panel
        self.tearDown()
        self.setUp()
        self.open_reader()
        self.show(A, vector="A-PRESENT-OWNER")
        self.answer(A, vector="A-PRESENT-OWNER-2")
        self.refresh_button().click()
        self.settle()
        self.assertIn("SYN reason: refreshed", self.panel()["text"])

    def test_cd12_the_panels_own_401_ends_it_before_the_logout_answer(self):
        """E-05 / F-15: api() calls the end list, then KinAuth.logout() once; the panel is empty while the logout POST is held."""
        self.open_reader()
        self.show(A, vector="A-PRESENT-OWNER")
        self.stub.hold_logout = True
        self.answer(A, status=401, json={"message": "SYN expired"})
        self.refresh_button().click()
        self.wait_until(lambda: len(self.stub.logouts) == 1, "the one logout POST")
        self.frames()
        panel = self.panel()
        self.assertFalse(panel["shown"])
        self.assertEqual(panel["sections"], [])
        self.assertNotIn(TEXTS["stateLabels"]["failed"], panel["all"])
        self.page.wait_for_timeout(100)
        self.assertEqual(len(self.stub.logouts), 1)
        with self.page.expect_navigation():
            self.stub.logouts[0].fulfill(status=204, body="")

    def test_cd12_path_na_answers_that_arrive_after_the_end_paint_nothing(self):
        """L-07 / L-13 / E-09: the cancel-ignoring call ends after the session end with a success, a 503 or a failed
        connection; api() reads it; the panel stays hidden and empty with no Failed."""
        for label, ending in (("success", ("finish", "A-PRESENT-OWNER-2")), ("503", ("status", 503)), ("network", ("fail", None)),
                              ("owner gone", ("owner", "A-PRESENT-OWNER-2"))):
            with self.subTest(label=label):
                self.tearDown()
                self.setUp()
                self.open_reader()
                self.show(A, vector="A-PRESENT-OWNER")
                self.page.evaluate("() => { window.synHold = true; }")
                index = len(self.calls())
                self.refresh_button().click()
                self.wait_calls(index + 1)
                kind, value = ending
                if kind == "owner":
                    # KinAuth.session() becomes null (clearLocal) in the same task that ends the current call, so the answer
                    # can be read before the other-tab message reaches the panel: the account check refuses it (E-09).
                    self.page.evaluate("([i, t]) => { KinAuth.demo(); window.synFinish(i, 200, t); }",
                                       [index, json.dumps(VALID[value], ensure_ascii=False)])
                    self.page.wait_for_timeout(50)
                    self.frames()
                    self.assert_consumed_late(index, aborted=False)
                else:
                    self.page.evaluate("() => window.synEnd()")
                    if kind == "finish":
                        self.finish(index, value)
                    elif kind == "status":
                        self.finish(index, status=value, body={"code": "CLINICAL_CONTEXT_BUSY", "message": "SYN busy"})
                    else:
                        self.page.evaluate("i => window.synFail(i)", index)
                        self.page.wait_for_timeout(20)
                        self.frames()
                    self.assert_consumed_late(index)
                panel = self.panel()
                self.assertFalse(panel["shown"])
                self.assertNotIn("SYN reason: refreshed", self.seen())
                self.assertNotIn(TEXTS["stateLabels"]["failed"], panel["all"])
                self.assertNotIn("Retry", [b[0] for b in panel["buttons"]])

    # ── cd13 ──
    def test_cd13_the_rest_of_the_screen_is_unchanged_and_nothing_is_stored(self):
        def screen():
            return self.page.evaluate("""() => {
              const q = s => document.querySelector(s), shown = e => !!e && e.getClientRects().length > 0;
              return { clinical: q('#clinical').innerHTML,
                       controls: ['#study-receipt', '#study-identity', '#copy-patient-id', '#sr-open', '#tech-note-open']
                         .map(s => [s, shown(q(s)), !!q(s).disabled]) };
            }""")
        results = {}
        for roles in (["technician"], ["radiologist"]):
            self.tearDown()
            self.setUp()
            self.open_reader(roles=roles)
            self.stub.default = {A: {"vector": "A-PRESENT-OWNER"}, R: {"vector": "A-RELATED"}}
            before = self.page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
            nothing = screen()
            self.pick(A)
            self.settle()
            chosen = screen()
            self.js("synRelated", R)
            self.settle()
            related = screen()
            after = self.page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
            self.assertEqual(before, after, "the panel stores nothing")
            results[roles[0]] = (nothing, chosen, related)
        self.assertEqual(results["technician"], results["radiologist"], "the panel changes nothing else on the screen")
        self.assertIn("관련 검사 정보 · 판독 대상은 바뀌지 않습니다", self.panel()["clinical"])
        self.assertEqual({p for p in self.paths() if not p.endswith("/clinical-context")}, {"GET /api/me"})
        # N-02: an opened report text stays open over a same-study repaint and over a list observation that repaints
        self.js("synReturn")
        self.settle()
        self.page.locator("#clinical-context-sections details").first.evaluate("d => { d.open = true; }")
        asked = len(self.calls())
        self.js("synRender")
        self.js("synRender")
        self.frames()
        self.assertEqual(self.sections()["priorReports"]["open"], [True, False])
        self.assertEqual(len(self.calls()), asked)
        self.js("synObserve", LISTS["L-TN-UP"])
        self.frames()
        self.assertEqual(self.state_of("techNote"), "stale")
        self.assertEqual(self.sections()["priorReports"]["open"], [True, False])

    def test_cd13_a_large_answer_stays_within_the_column_bound(self):
        self.open_reader()
        self.show(A, vector="A-TRUNC")
        box = self.page.evaluate("""() => {
          const panel = document.querySelector('#clinical-context'), column = panel.parentElement, clinical = document.querySelector('#clinical');
          return { panel: panel.getBoundingClientRect().height, column: column.getBoundingClientRect().height,
                   clinical: clinical.getBoundingClientRect().height, scroll: panel.scrollWidth, width: panel.clientWidth,
                   inColumn: column.classList.contains('s-clinical') };
        }""")
        self.assertTrue(box["inColumn"])
        self.assertLessEqual(box["panel"], box["column"] * 0.45 + 0.5, box)
        self.assertGreater(box["clinical"], 0, box)
        self.assertLessEqual(box["scroll"], box["width"], box)

    # ── cd14 ──
    def test_cd14_one_request_per_change_of_the_viewed_study_in_order_and_none_otherwise(self):
        self.open_reader(clock=True)
        self.answer(A, vector="A-MARK-1", hold=True)
        self.answer(B, vector="A-MARK-2", hold=True)
        self.answer(C, vector="A-MARK-4", hold=True)
        frames = []
        for uid in (A, B, C):
            frames.append(self.page.evaluate("uid => window.synFrame('synPick', uid)", uid))
        for frame in frames:
            self.assertEqual(frame["status"], TEXTS["controls"]["loading"])
            self.assertEqual(frame["sections"], [])
        self.wait_until(lambda: [e["uid"] for e in self.stub.log] == [A, B, C], "three reads in the order of the changes")
        self.respond(self.take(C))
        self.settle()
        self.assertEqual(self.asked(), [A, B, C])
        self.assertIn("SYN-MARK-4", self.panel()["text"])
        for entry in list(self.stub.held):
            self.stub.held.remove(entry)
            self.release_late(entry)
        self.assertIn("SYN-MARK-4", self.panel()["text"])
        self.assertNotIn("SYN-MARK-1", self.seen())
        self.assertNotIn("SYN-MARK-2", self.seen())
        for call, uid in zip(self.calls(), (A, B, C)):
            self.assertEqual((call["method"], call["path"], call["query"], call["body"]), ("GET", "/api/studies/%s/clinical-context" % uid, "", None))
            self.assertEqual(call["headers"].get("x-kin-csrf"), "1")
        for entry in self.stub.log:
            self.assertEqual((entry["query"], entry["body"]), ("", None))
        # the same study again: no request, no repaint
        before = self.page.evaluate("() => window.synSeen.length")
        for _ in range(3):
            self.js("synRender")
        # a later list whose rows say what C's answer says (its own row and its one member)
        quiet = copy.deepcopy(LISTS["L-SAME"])
        quiet["studies"] = [dict(r, uid=C) for r in quiet["studies"] if r["uid"] == A] + [r for r in quiet["studies"] if r["uid"] == X]
        quiet["studies"][0]["techNote"] = {"version": 0, "present": False}
        self.js("synObserve", quiet)
        self.page.clock.run_for(10 * 60 * 1000)
        self.frames()
        self.assertEqual(len(self.calls()), 3)
        self.assertEqual(self.page.evaluate("() => window.synSeen.length"), before)
        self.assertEqual({p for p in self.paths() if not p.endswith("/clinical-context")}, {"GET /api/me"})
        # the pair: a change of the viewed study asks once
        self.answer(A, vector="A-MARK-3")
        self.pick(A)
        self.settle()
        self.assertEqual(len(self.calls()), 4)

    # ── cd15 ──
    def test_cd15_every_malformed_answer_is_failed_with_nothing_painted(self):
        self.open_reader()
        self.assertGreaterEqual(len(MALFORMED), 25)
        for name, entry in MALFORMED.items():
            with self.subTest(name=name):
                self.show(A, malformed=name)
                panel = self.panel()
                self.assertEqual(panel["sections"], [], name)
                self.assertIn(TEXTS["stateLabels"]["failed"], panel["status"])
                self.assertNotIn(entry["visible"], panel["all"])
                if entry["marker"]:
                    self.assertNotIn(entry["marker"], panel["all"])
                    self.assertNotIn(entry["marker"], " ".join(panel["titles"]))
        self.show(A, status=200, raw="<html>not json</html>")
        self.assertEqual(self.panel()["sections"], [])
        self.assertIn(TEXTS["stateLabels"]["failed"], self.panel()["status"])
        # the pair: each original is painted
        for name in sorted({entry["derivedFrom"] for entry in MALFORMED.values()}):
            with self.subTest(original=name):
                self.show(A, vector=name)
                self.assertEqual(len(self.panel()["sections"]), 4, name)

    # ── cd16 ──
    def test_cd16_offline_hides_and_asks_nothing_until_back_online(self):
        self.open_reader()
        self.show(A, vector="A-PRESENT-OWNER")
        self.answer(B, vector="A-B", hold=True)
        self.pick(B)
        held = self.take(B)
        self.js("synOffline")
        region = self.page.get_by_role("region", name="Clinical Context")
        expect(region).to_be_hidden()
        self.release_late(held)
        self.assertNotIn("SYN-B-MARK", self.seen())
        asked = len(self.calls())
        self.pick(C)
        self.pick(A)
        self.frames()
        self.assertEqual(len(self.calls()), asked, "no request while offline")
        expect(region).to_be_hidden()
        self.assertEqual(self.panel()["sections"], [])
        self.answer(A, vector="A-PRESENT-OWNER")
        self.js("synOnline")
        self.settle()
        self.assertEqual(len(self.calls()), asked + 1)
        expect(region).to_be_visible()
        self.assertIn("SYN CT CHEST", self.panel()["text"])

    # ── cd17 ──
    def test_cd17_an_answer_about_another_study_changes_nothing(self):
        self.open_reader()
        context = CONTEXTS["C-UID-OTHER"]
        self.assertEqual(context["requestedUid"], A)
        # (a) a first read: Loading… stays as it was; no sentence, no Failed, no Retry
        self.answer(A, context="C-UID-OTHER", hold=True)
        self.pick(A)
        held = self.take(A)
        self.frames()
        before = self.panel()
        self.assertEqual(before["status"], TEXTS["controls"]["loading"])
        self.respond(held)
        self.settle()
        self.assertEqual(self.panel(), before)
        seen = self.seen()
        for text in (TEXTS["noInformation"], TEXTS["stateLabels"]["failed"]):
            self.assertNotIn(text, seen)
        self.assertNotIn("Retry", [b[0] for b in self.panel()["buttons"]])
        self.assertEqual(len(self.calls()), 1)
        # the next change of the viewed study reads again and paints
        self.answer(B, vector="A-B")
        self.pick(B)
        self.settle()
        self.assertIn("SYN-B-MARK", self.panel()["text"])
        # (b) a re-read of A answered with B's answer: A's panel as it was just before (Loading…, A's items, controls off)
        self.show(A, vector="A-PRESENT-OWNER")
        self.answer(A, vector="A-B", hold=True)
        self.refresh_button().click()
        held = self.take(A)
        self.frames()
        before = self.panel()
        self.assertIn("SYN CT CHEST", before["text"])
        mark = len(self.page.evaluate("() => window.synSeen"))
        self.respond(held)
        self.settle()
        self.assertEqual(self.panel(), before)
        later = "\n".join(self.page.evaluate("() => window.synSeen")[mark:])
        self.assertNotIn("SYN-B-MARK", later)
        self.assertNotIn(TEXTS["stateLabels"]["failed"], later)
        # the pairs: the same answer with the requested uid is painted; B's answer to B's request is painted
        self.show(A, vector="A-ABSENT4")
        self.assertEqual(self.panel()["status"], TEXTS["noInformation"])
        self.show(B, vector="A-B")
        self.assertIn("SYN-B-MARK", self.panel()["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
