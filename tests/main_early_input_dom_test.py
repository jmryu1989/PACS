# coding: utf-8
"""REQ-S9-U0a-PRE-ORDER -> RISK-EARLY-TDZ, RISK-REGISTRATION-ORDER, RISK-REGISTRATION-DUPLICATE
-> TEST-PRE-REGISTRATION, TEST-PRE-EARLY-03, TEST-PRE-EARLY-05, TEST-PRE-EARLY-58 (S9-U0a-PRE, D707).

Splitting main.html's one inline script into ordered classic scripts opens a task gap at every boundary: the parser
waits for the next part while the page already shows its controls. An input in that gap reaches the listeners the
parts so far registered, and a listener that needs a binding declared in a later part fails. The early-input hazards
of the U0a re-list (B1-03 report fields, B1-05 template panel, B1-58 Quick Match), and the ones the phase-1 harness
found beside them (PRE-X1..X3 inputs, B1-15/B1-57/PRE-P3 leaving the page), are reproduced on temporary 18/30/45-part
copies of the page (tests/main_split_harness.*); nothing is written to the product tree.

What is compared is what a browser observes:
  * uncaught errors;
  * the dispatch outcome of every listener the hazard statements register, identified by the listener's source in
    the ORIGINAL page's registration trace (so a registration that moves keeps its identity);
  * the screen (report fields, focus, template panel, Quick Match, chips, list, toasts) and
    KinWorkContext.selection() (the public module contract), right after the early input and after boot.
The original page has two early moments, and each is an original behaviour: before its script ran ("pre": the input
reaches no listener) and while boot waits for the session answer ("post": every listener is registered). An early
input on a split page must end exactly like one of them: never with an error or a partial result.

Registration (green, the reference the product change must keep): every registration the original page makes before
the session answer is, per (target, event) and in order, the same in the page under test; the hazard targets'
registrations do not depend on the session answer (answered, failed, failed then retried) and Retry adds none.
Window and session events (resize, another document in front, a session end told by storage and channel, timers)
at held boundaries raise nothing.

Red marks: the hazard cases fail today on split pages. `red()` turns a failure whose uncaught errors are all the
documented binding into an expected failure and any other failure into an error; KIN_PRE_EXPECT_RED=0 runs the
cases unmarked. Phase 2 removes the marks (OPEN_HAZARDS); no assertion is weakened to pass. The ORIGINAL page is the
git blob of main_move_spec.json `base` - byte identity is this move's requirement (AGENTS 1-B.14). The page under
test is the product file (KIN_PRE_PAGE may name a scratch copy for mutants); it is split along the move spec's runs
re-derived for its own statements (KIN_PRE_SPEC overrides). KIN_PRE_TRACE_DIR receives the reference traces as JSON.
"""
import functools
import json
import os
import re
import subprocess
import sys
import time
import unittest
from pathlib import Path

import auth_logout_dom_test as h
import main_split_harness as sh
from playwright.sync_api import Error as PlaywrightError, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]
MOVE_SPEC = ROOT / "tests" / "main_move_spec.json"
SPEC_PATH = Path(os.environ.get("KIN_PRE_SPEC", MOVE_SPEC))
PAGE = Path(os.environ.get("KIN_PRE_PAGE", sh.PRODUCT_DIR / "main.html"))
ORIGINAL_SPEC = json.loads(MOVE_SPEC.read_text(encoding="utf-8"))
EXPECT_RED = os.environ.get("KIN_PRE_EXPECT_RED", "1") != "0"
TRACE_DIR = os.environ.get("KIN_PRE_TRACE_DIR")
# Phase 2 removes an id when its product change lands (the commander decides which of the found ones PRE fixes).
OPEN_HAZARDS = {"B1-03", "B1-05", "B1-58", "PRE-X1", "PRE-X2", "PRE-X3", "B1-15", "B1-57", "PRE-P3"}

MODULE = {m["file"]: i for i, m in enumerate(ORIGINAL_SPEC["modules"])}
PARTS = ORIGINAL_SPEC["parts"]
FIELDS = ("findings", "conclusion", "recommendation")
SAVED = {"id": "SYN-FILTER-1", "name": "SYN Saved Search", "quick": "", "days": 0, "mode": "Radiology", "cols": {},
         "sortKey": None, "sortDir": 0, "isDefault": False}
PROBE_URL = h.ORIGIN + "/syn-elsewhere.html"


# ── the early inputs (what a person can do while the page is still loading) ──
def report_fields(page):
    for k in FIELDS:
        page.click("#" + k)
        page.keyboard.type("a")


def template_panel(page):
    page.click("#t-mod")
    page.select_option("#t-body", "")
    page.fill("#tpl-search", "Brain")
    page.click("#tpl-search-clear")
    page.click("#tpl-filter-clear")
    # View -> close -> View -> Insert (when offered) -> close -> the row menu (edit), each only when the screen offers
    # it: an input the page did not offer is not given, so a failed View shows as a difference, not as a timeout.
    view, close = page.locator("#tplrows [data-tpl-preview]"), page.locator("#tpl-preview-close")
    if not view.count():
        return
    view.first.click()
    if close.is_visible():
        close.click()
    view.first.click()
    insert = page.locator("#tpl-preview-insert")
    if insert.is_visible() and insert.is_enabled():
        insert.click()
    if close.is_visible():
        close.click()
    page.locator("#tplrows tr[data-i]").first.click(button="right")
    page.keyboard.press("Escape")


def quick_match(page):
    page.select_option("#quick-match", "prefix")


def worklist_controls(page):
    page.click("#quick")
    page.keyboard.type("S")
    page.select_option("#page-size", "50")
    for control in ("#page-next", "#page-prev", "#page-current"):
        if page.locator(control).is_enabled():
            page.click(control)


def select_study(page):
    page.locator("#rows tr", has_text=h.PATIENT).first.click()
    page.wait_for_timeout(300)


def search_patient(page):
    page.fill("#quick", "PATIENT")
    page.wait_for_timeout(300)


TEMPLATES = {"registers": ("report-templates.js", "report-templates-ui.js"),
             "targets": ("#t-mod", "#t-body", "#tpl-search", "#tpl-search-clear", "#tpl-filter-clear", "#tplrows",
                         "#tpl-preview", "#tpl-preview-close", "#tpl-preview-insert"),
             "inputs": template_panel, "after": None, "screen": ("templates", "focus", "toasts")}
HAZARDS = {
    "B1-03": {"registers": ("report-dictation.js",), "targets": tuple("#" + k for k in FIELDS),
              "inputs": report_fields, "after": select_study, "screen": ("fields", "focus", "work")},
    "B1-05": TEMPLATES,
    "B1-58": {"registers": ("worklist-controls.js",), "targets": ("#quick-match",),
              "inputs": quick_match, "after": search_patient, "screen": ("worklist", "toasts")},
    # Found by the phase-1 harness beside the re-listed three (not in b1-possible.md):
    "PRE-X1": {"registers": ("report-hold.js",), "targets": tuple("#" + k for k in FIELDS),
               "inputs": report_fields, "after": select_study, "screen": ("fields", "focus", "work")},
    "PRE-X2": TEMPLATES,
    "PRE-X3": {"registers": ("worklist-controls.js",), "targets": ("#quick", "#page-size", "#page-prev", "#page-next",
                                                                   "#page-current"),
               "inputs": worklist_controls, "after": search_patient, "screen": ("worklist", "toasts")},
}

# What the screen shows of the affected areas; ids are locators only.
SCREEN = """() => {
  const el = id => document.getElementById(id);
  const shown = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const text = id => { const node = el(id); return node ? node.innerText : null; };
  const active = document.activeElement;
  return {
    focus: active ? (active.id || active.localName) : null,
    fields: Object.fromEntries(['findings', 'conclusion', 'recommendation'].map(id => [id, el(id) ? el(id).value : null])),
    templates: { modality: el('t-mod') && el('t-mod').checked, bodypart: el('t-body') && el('t-body').value,
      search: el('tpl-search') && el('tpl-search').value, rows: text('tplrows'), status: text('tpl-filter-status'),
      preview: shown(el('tpl-preview')) ? text('tpl-preview') : null },
    worklist: { quick: el('quick') && el('quick').value, match: el('quick-match') && el('quick-match').value,
      size: el('page-size') && el('page-size').value, chips: text('chips'),
      saved: shown(el('active-filter-info')) ? text('active-filter-info') : null, rows: text('rows') },
    toasts: (window.__kinToasts || []).slice(),
    work: typeof KinWorkContext === 'object' ? KinWorkContext.selection() : null,
  };
}"""

# Every message the page's toast shows, in order (recorded before any page script).
TOAST_RECORDER = """(() => {
  const shown = [];
  Object.defineProperty(window, '__kinToasts', { value: shown });
  const watch = () => {
    const el = document.getElementById('toast');
    if (!el) return false;
    new MutationObserver(() => {
      const item = el.textContent;
      if (item && /\\bshow\\b/.test(el.className) && shown[shown.length - 1] !== item) shown.push(item);
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
    return true;
  };
  if (!watch()) { const look = new MutationObserver(() => { if (watch()) look.disconnect(); });
    look.observe(document, { childList: true, subtree: true }); }
})();"""


class HazardFailure(AssertionError):
    def __init__(self, message, errors):
        super().__init__(message)
        self.errors = errors


def red(hazard, documented):
    """Expected failure while `hazard` is open - only when every uncaught error is the documented one."""
    def wrap(fn):
        if not EXPECT_RED or hazard not in OPEN_HAZARDS:
            return fn

        @functools.wraps(fn)
        def run(self):
            try:
                fn(self)
            except Exception as error:
                if not (isinstance(error, HazardFailure) and error.errors
                        and all(re.search(documented, item) for item in error.errors)):
                    self._wrong_red = f"{hazard}: expected to fail only on {documented!r}; failed with {error!r}"[:6000]
                raise
        run.__unittest_expecting_failure__ = True
        return run
    return wrap


class PreSite(h.Site):
    """The logout suite's synthetic origin; optionally one saved search in the bootstrap."""

    def __init__(self, filters=()):
        super().__init__()
        self.filters = [dict(f) for f in filters]

    def api(self, route, request, method, path, query):
        if self.filters and method == "GET" and path == "/api/bootstrap":
            account, refused = self.authenticate(request, strict=True)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json={"statesOmitted": True, "me": {"actor": account["actor"], "roles": account["roles"],
                                       "institution": h.INSTITUTION, "institutionName": "SYN Hospital A"},
                                       "filters": self.filters, "templates": [], "institutions": [{"id": h.INSTITUTION,
                                       "name": "SYN Hospital A", "type": "hospital"}], "states": {}, "orders": [],
                                       "serverTime": "2026-10-03T00:00:00.000Z"})
        return super().api(route, request, method, path, query)


class Run:
    """One page of one layout with its own context, synthetic origin and script delivery."""

    def __init__(self, case, layout, hold=None, delay_ms=0, auth="answer", filters=()):
        self.case, (directory, self.manifest) = case, layout
        self.site = PreSite(filters)
        if auth != "answer":
            self.site.held_me = []
        self.context = case.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.add_init_script(sh.TRACE_SCRIPT)
        self.context.add_init_script(TOAST_RECORDER)
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.context.route(PROBE_URL, lambda route: route.fulfill(body="<!doctype html><title>SYN elsewhere</title>",
                                                                  content_type="text/html; charset=utf-8"))
        self.delivery = sh.Delivery(directory, self.manifest, h.BASE, delay_ms=delay_ms, hold=hold).install(self.context)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(f"{error.name}: {error.message}"))
        self.page.on("dialog", self.on_dialog)
        case.runs.append(self)
        self.page.goto(h.MAIN_URL, wait_until="commit")

    def on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.dismiss()

    def wait(self, predicate, what, timeout=20.0):
        self.delivery.wait(self.page, predicate, what, timeout)

    def blocked(self):
        self.wait(lambda: self.delivery.blocked(self.page), f"the parser waits for {self.delivery.hold}")

    def ran(self, script):
        self.wait(lambda: self.page.evaluate("f => window.__kinTrace.executed.includes(f)", script), f"{script} ran")

    def auth_waits(self):
        self.wait(lambda: bool(self.site.held_me), "boot waits for the session answer")

    def answer_auth(self, status=200, failures=0):
        held, self.site.held_me = self.site.held_me or [], None
        self.site.me_answers = [(503, {"code": "AUTH_IDP_UNAVAILABLE"})] * failures
        for route in held:
            if status == 200:
                self.site.answer(route, *self.site.me(self.site.account))
            else:
                self.site.answer(route, status, {"code": "AUTH_IDP_UNAVAILABLE"})

    def booted(self):
        self.wait(f"(document.querySelector('#rows') || {{}}).innerText?.includes({json.dumps(h.PATIENT)})",
                  "the booted worklist")
        self.settle()

    def settle(self, ms=250):
        end = time.monotonic() + ms / 1000
        while time.monotonic() < end:
            self.delivery.pump()
            self.page.wait_for_timeout(10)

    def leave(self):
        self.page.goto(PROBE_URL, wait_until="commit")
        self.page.wait_for_timeout(250)

    def trace(self, since=0):
        return sh.snapshot(self.page, since)

    def screen(self):
        return self.page.evaluate(SCREEN)

    def close(self):
        self.delivery.dispose()
        for route in self.site.held_me or []:
            try:
                route.abort()
            except PlaywrightError:
                pass
        self.site.held_me = None
        try:
            self.context.close()
        except PlaywrightError:
            pass


class Result:
    def __init__(self, **values):
        self.__dict__.update(values)


class Pages:
    """The ORIGINAL page (git blob of the move baseline) and the page under test, as scratch layouts."""
    current = original = derived = None

    @classmethod
    def open(cls):
        if cls.current is None:
            cls.current = sh.ScratchPages(page=PAGE)
            spec = SPEC_PATH
            if SPEC_PATH == MOVE_SPEC:
                spec = cls.current.root / "derived-spec.json"
                cls.derived = sh.derive_spec(PAGE, spec)
            cls.current.spec = spec
            blob = subprocess.check_output(["git", "cat-file", "--filters", f"{ORIGINAL_SPEC['base']}:{ORIGINAL_SPEC['page']}"],
                                           cwd=ROOT)
            source = cls.current.root / "original-source" / "main.html"
            source.parent.mkdir(parents=True)
            source.write_bytes(blob)
            cls.original = sh.ScratchPages(page=source, root=cls.current.root / "original")

    @classmethod
    def close(cls):
        if cls.current is not None:
            cls.current.close()
            cls.current = cls.original = None


def setUpModule():
    Pages.open()


def tearDownModule():
    Pages.close()


def registration_difference(expected, observed):
    """The (target, event) keys whose registrations differ, with both sides - readable, unlike a dict diff."""
    keys = sorted(set(expected) | set(observed))
    return [{"key": key, "original": expected.get(key), "observed": observed.get(key)}
            for key in keys if expected.get(key) != observed.get(key)]


class PreCase(unittest.TestCase):
    references = {}
    hazard_keys = {}

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.runs = []

    def tearDown(self):
        violations = []
        for run in self.runs:
            violations += run.site.violations
            run.close()
        wrong = getattr(self, "_wrong_red", None)
        if wrong:
            self.fail(wrong)
        self.assertEqual([], violations, "requests the synthetic origin does not answer")

    def assert_same_registrations(self, expected, observed, what):
        self.assertEqual([], registration_difference(expected, observed), what)

    # ── the scenario ──
    def early(self, hazard, layout, hold=None, delay_ms=0, trigger=None, auth="answer"):
        """Give the hazard's inputs at the early moment, let the page boot, and observe both times."""
        spec = HAZARDS[hazard]
        run = Run(self, layout, hold=hold, delay_ms=delay_ms, auth=auth,
                  filters=(SAVED,) if spec["inputs"] in (quick_match, worklist_controls) else ())
        if hold:
            run.blocked()
        elif auth == "wait":
            run.auth_waits()
        elif trigger:
            run.ran(trigger)
        since = run.page.evaluate("window.__kinTrace.now()")
        spec["inputs"](run.page)
        run.settle(150)
        early_trace, early_screen = run.trace(since), run.screen()
        run.delivery.release()
        if auth == "wait":
            run.answer_auth()
        run.booted()
        if spec["after"]:
            spec["after"](run.page)
        return Result(errors=list(run.errors), early_screen=early_screen, final_screen=run.screen(),
                      dialogs=list(run.dialogs), dispatches=self.hazard_dispatches(hazard, run, early_trace))

    def reference(self, hazard, moment):
        """The ORIGINAL page's early input: `pre` (its script has not run) or `post` (boot waits for the session)."""
        key = (hazard, moment)
        if key not in PreCase.references:
            layout = Pages.original.layout(0)
            hold = layout[1]["scripts"][-1] if moment == "pre" else None
            PreCase.references[key] = self.early(hazard, layout, hold=hold, auth="wait" if moment == "post" else "answer")
        return PreCase.references[key]

    def leaving(self, layout, hold=None, auth="answer"):
        """Uncaught errors when the person leaves the page at the early moment (pagehide and what it starts)."""
        run = Run(self, layout, hold=hold, auth=auth)
        if hold:
            run.blocked()
        else:
            run.auth_waits()
        run.leave()
        return list(run.errors)

    def original_trace(self):
        """Registrations of the ORIGINAL page before the session answer, attributed to statements."""
        if "trace" not in PreCase.references:
            layout = Pages.original.layout(0)
            run = Run(self, layout, auth="wait")
            run.auth_waits()
            PreCase.references["trace"] = (layout[1], run.trace()["registrations"])
            run.answer_auth()
            run.booted()
        return PreCase.references["trace"]

    def keys(self, hazard):
        """(target, event, listener) of the listeners the hazard statements register in the ORIGINAL page."""
        if hazard not in PreCase.hazard_keys:
            manifest, registrations = self.original_trace()
            spec, found = HAZARDS[hazard], set()
            for item in registrations:
                _, owner = sh.attribute(manifest, item)
                if (item["kind"] == "add" and owner and item["target"] in spec["targets"]
                        and ORIGINAL_SPEC["modules"][owner["module"]]["file"] in spec["registers"]):
                    found.add((item["target"], item["type"], item["listener"]))
            self.assertTrue(found, f"{hazard}: the original page registers its listeners")
            PreCase.hazard_keys[hazard] = found
        return PreCase.hazard_keys[hazard]

    def hazard_dispatches(self, hazard, run, trace):
        keys = self.keys(hazard)
        # A dispatch names its registration; registrations made before the early moment are in the run's full trace.
        registrations = {r["seq"]: r for r in run.trace()["registrations"]}
        out = []
        for item in trace["dispatches"]:
            registration = registrations.get(item.get("registration"))
            if registration and (registration["target"], registration["type"], registration["listener"]) in keys:
                out.append({"target": item["target"], "type": item["type"], "error": item["error"]})
        return out

    def assert_like_original(self, hazard, result):
        """No error, no failed hazard listener, and the same screen as the original moment it corresponds to."""
        if result.errors:
            raise HazardFailure(f"{hazard}: uncaught errors on the early input: {result.errors}", result.errors)
        failed = [d for d in result.dispatches if d["error"]]
        self.assertEqual([], failed, f"{hazard}: hazard listeners that failed")
        moment = "post" if result.dispatches else "pre"
        reference = self.reference(hazard, moment)
        self.assertEqual([], reference.errors, f"{hazard}: the original page itself had errors at the {moment} moment")
        self.assertEqual([(d["target"], d["type"]) for d in reference.dispatches],
                         [(d["target"], d["type"]) for d in result.dispatches],
                         f"{hazard}: the hazard listeners the early input reached (like the original's {moment} moment)")
        for part in HAZARDS[hazard]["screen"]:
            self.assertEqual(reference.early_screen[part], result.early_screen[part],
                             f"{hazard}: '{part}' right after the early input differs from the original's {moment} moment")
            self.assertEqual(reference.final_screen[part], result.final_screen[part],
                             f"{hazard}: '{part}' after boot differs from the original's {moment} moment")
        self.assertEqual(reference.dialogs, result.dialogs, f"{hazard}: dialogs")


# ── TEST-PRE-REGISTRATION (green: the reference the product change must keep) ──
class Registration(PreCase):
    def test_registrations_before_the_session_answer_match_the_original_page(self):
        manifest, original = self.original_trace()
        run = Run(self, Pages.current.layout(0), auth="wait")
        run.auth_waits()
        current = run.trace()["registrations"]
        if TRACE_DIR:
            write_trace(Path(TRACE_DIR), "original-before-session-answer", manifest, original)
            write_trace(Path(TRACE_DIR), "current-before-session-answer", Pages.current.layout(0)[1], current)
        self.assert_same_registrations(sh.by_target_event(original), sh.by_target_event(current),
                                       "per (target, event): the same registrations in the same order before the session answer")

    def test_hazard_registrations_do_not_depend_on_the_session_answer_and_retry_adds_none(self):
        keys = {(t, e) for hazard in HAZARDS for (t, e, _) in self.keys(hazard)}
        targets = {t for t, _ in keys}
        expected = sh.by_target_event(self.original_trace()[1], keys)
        observed = {}
        for outcome in ("answered", "failed", "failed then retried"):
            with self.subTest(outcome=outcome):
                run = Run(self, Pages.current.layout(0), auth="wait")
                run.auth_waits()
                before = run.trace()["registrations"]
                if outcome == "answered":
                    run.answer_auth()
                    run.booted()
                else:
                    run.answer_auth(status=503, failures=3)
                    retry = run.page.locator("#err button")
                    run.wait(lambda: retry.count() > 0, "the failed session check offers a retry", timeout=30)
                    if outcome == "failed then retried":
                        retry.click()
                        run.booted()
                after = run.trace()["registrations"]
                observed[outcome] = after
                on_targets = {(r["target"], r["type"]) for r in after if r["target"] in targets}
                self.assert_same_registrations(expected, sh.by_target_event(before, keys),
                                               f"{outcome}: the hazard registrations exist before the session answer")
                self.assert_same_registrations(sh.by_target_event(before, on_targets), sh.by_target_event(after, on_targets),
                                               f"{outcome}: the hazard targets gain no registration after the session answer")
        if TRACE_DIR:
            for outcome, registrations in observed.items():
                write_trace(Path(TRACE_DIR), "current-" + outcome.replace(" ", "-"), Pages.current.layout(0)[1], registrations)


# ── window and session events at held boundaries (green: nothing of them may fail in a gap) ──
class WindowAndSessionEvents(PreCase):
    END = {"session": "SYN-SESSION-1", "operation": 9999999999999, "status": "confirmed", "origin": "logout"}

    def test_window_and_session_events_at_held_boundaries_raise_nothing(self):
        layout = Pages.current.layout(45)
        modules = sorted({MODULE[f] for f in ("report-templates-ui.js", "worklist-columns-view.js", "sr-reader.js",
                                              "report-editor.js", "work-exit.js", "clinical-context-panel.js",
                                              "worklist-controls.js", "saved-filters.js", "page-boot.js")})
        for module in modules:
            with self.subTest(held=layout[1]["parts"][module]):
                run = Run(self, layout, hold=layout[1]["parts"][module])
                run.blocked()
                run.page.wait_for_timeout(1000)                      # timers and observers of what ran
                run.page.set_viewport_size({"width": 1000, "height": 700})
                run.page.wait_for_timeout(100)
                run.page.set_viewport_size({"width": 1400, "height": 900})
                other = self.runs[-1].context.new_page()
                other.goto(PROBE_URL)
                other.bring_to_front()
                run.page.wait_for_timeout(100)
                run.page.bring_to_front()
                other.evaluate("""end => { localStorage.setItem('kin-session-end:' + end.session, JSON.stringify(end));
                  new BroadcastChannel('kin-session').postMessage({ type: 'session-ended', ...end }); }""", self.END)
                run.page.wait_for_timeout(300)
                other.close()
                self.assertEqual([], run.errors)


# ── TEST-PRE-EARLY-03/05/58 controls on the unsplit page (green) ──
class UnsplitControl(PreCase):
    def check(self, hazard):
        layout = Pages.current.layout(0)
        for moment in ("pre", "post"):
            with self.subTest(moment=moment):
                hold = layout[1]["scripts"][-1] if moment == "pre" else None
                result = self.early(hazard, layout, hold=hold, auth="wait" if moment == "post" else "answer")
                self.assertEqual([], result.errors)
                self.assertEqual(moment == "post", bool(result.dispatches), "the hazard listeners are reached only after the script ran")
                self.assertEqual([], [d for d in result.dispatches if d["error"]])
                reference = self.reference(hazard, moment)
                for part in HAZARDS[hazard]["screen"]:
                    self.assertEqual(reference.early_screen[part], result.early_screen[part], part)
                    self.assertEqual(reference.final_screen[part], result.final_screen[part], part)

    def test_B1_03_unsplit(self):
        self.check("B1-03")

    def test_B1_05_unsplit(self):
        self.check("B1-05")

    def test_B1_58_unsplit(self):
        self.check("B1-58")

    def test_PRE_X1_unsplit(self):
        self.check("PRE-X1")

    def test_PRE_X3_unsplit(self):
        self.check("PRE-X3")

    def test_leaving_unsplit(self):
        layout = Pages.current.layout(0)
        self.assertEqual([], self.leaving(layout, hold=layout[1]["scripts"][-1]), "pre")
        self.assertEqual([], self.leaving(layout, auth="wait"), "post")


# ── TEST-PRE-EARLY-03/05/58 (and the found ones) on split pages: red until phase 2 ──
class EarlyInputSplit(PreCase):
    pass


def case_name(hazard, count, where):
    return f"test_{hazard.replace('-', '_')}_{count}_{re.sub(r'[^A-Za-z0-9]+', '_', where).strip('_')}"


def split_case(hazard, count, documented, hold_module=None, trigger_module=None, delay_ms=0):
    def test(self):
        layout = Pages.current.layout(count)
        manifest = layout[1]
        hold = sh.part_of(manifest, hold_module) if hold_module is not None else None
        trigger = sh.part_of(manifest, trigger_module) if trigger_module is not None else None
        self.assertTrue(hold or trigger, "the case names a boundary of this layout")
        self.assert_like_original(hazard, self.early(hazard, layout, hold=hold, delay_ms=delay_ms, trigger=trigger))
    files = ORIGINAL_SPEC["modules"]
    where = (f"hold {files[hold_module]['file']}" if hold_module is not None
             else f"{delay_ms}ms after {files[trigger_module]['file']}")
    name = case_name(hazard, count, where)
    test.__name__ = name
    test.__doc__ = f"{hazard}: {count}-part page, {where}; documented failure {documented!r}"
    setattr(EarlyInputSplit, name, red(hazard, documented)(test))


def leave_case(hazard, count, documented, hold_module):
    def test(self):
        layout = Pages.current.layout(count)
        errors = self.leaving(layout, hold=sh.part_of(layout[1], hold_module))
        if errors:
            raise HazardFailure(f"{hazard}: uncaught errors while leaving the page at the early moment: {errors}", errors)
        original = Pages.original.layout(0)
        self.assertEqual([], self.leaving(original, auth="wait"), "the original page leaves without errors")
    where = f"leave while holding {ORIGINAL_SPEC['modules'][hold_module]['file']}"
    name = case_name(hazard, count, where)
    test.__name__ = name
    test.__doc__ = f"{hazard}: {count}-part page, {where}; documented failure {documented!r}"
    setattr(EarlyInputSplit, name, red(hazard, documented)(test))


def not_defined(*names):
    return r"^ReferenceError: (%s) is not defined$" % "|".join(names)


for count in PARTS:
    last = count - 1
    # B1-03: after the dictation registration and before selectionSeq's module.
    split_case("B1-03", count, not_defined("selectionSeq"), hold_module=MODULE["report-dictation.js"] + 1)
    split_case("B1-03", count, not_defined("selectionSeq"), hold_module=min(MODULE["report-editor.js"], last))
    # B1-05: before cur is ready (Modality/Bodypart/search/clear), then before RFIELDS (View).
    split_case("B1-05", count, not_defined("cur"), hold_module=MODULE["report-templates-ui.js"] + 1)
    split_case("B1-05", count, not_defined("cur"), hold_module=MODULE["current-study.js"])
    split_case("B1-05", count, not_defined("RFIELDS"), hold_module=min(MODULE["related-report.js"], last))
    # B1-58: only where saved-filters.js is a part of its own.
    if MODULE["saved-filters.js"] < count:
        split_case("B1-58", count, not_defined("renderChips"), hold_module=MODULE["saved-filters.js"])
        split_case("PRE-X3", count, not_defined("renderChips"), hold_module=MODULE["saved-filters.js"])
    # PRE-X1 / PRE-X2: the report fields' input (report-hold.js) and View, both before reportWriteBlock's module.
    if MODULE["report-toolbar.js"] < count:
        for module in (MODULE["work-exit.js"], MODULE["report-toolbar.js"]):
            split_case("PRE-X1", count, not_defined("reportWriteBlock"), hold_module=module)
        for module in (MODULE["report-editor.js"], MODULE["report-toolbar.js"]):
            split_case("PRE-X2", count, not_defined("reportWriteBlock"), hold_module=module)
    # Leaving the page: B1-15 (relatedParts -> renderRelated) everywhere; B1-57 (readingWorkspace -> applyLayout) and
    # PRE-P3 (consultations -> clearFilter -> render -> renderChips) where feature-mounts.js is a part of its own.
    leave_case("B1-15", count, not_defined("renderRelated"), MODULE["worklist-view.js"])
    if MODULE["saved-filters.js"] < count:
        leave_case("B1-57", count, not_defined("applyLayout", "renderChips"), MODULE["clinical-context-panel.js"])
        leave_case("PRE-P3", count, not_defined("renderChips"), MODULE["worklist-controls.js"])
split_case("B1-03", 45, not_defined("selectionSeq"), trigger_module=MODULE["report-dictation.js"], delay_ms=150)
split_case("B1-05", 45, not_defined("cur"), trigger_module=MODULE["report-templates-ui.js"], delay_ms=150)
split_case("B1-05", 45, not_defined("RFIELDS"), trigger_module=MODULE["current-study.js"], delay_ms=150)
split_case("B1-58", 45, not_defined("renderChips"), trigger_module=MODULE["worklist-controls.js"], delay_ms=150)


def write_trace(directory, name, manifest, registrations):
    """The reference trace: each registration with the statement that made it, and counts per (target, event)."""
    directory.mkdir(parents=True, exist_ok=True)
    rows, counts = [], {}
    for item in registrations:
        inner, owner = sh.attribute(manifest, item)
        rows.append({**{k: item[k] for k in ("seq", "kind", "target", "type", "capture", "once", "passive", "signal",
                                             "listener", "script", "ready")},
                     "at": inner and f"{inner[0]}:{inner[1]}",
                     "statement": owner and {"module": owner["module"], "file": ORIGINAL_SPEC["modules"][owner["module"]]["file"],
                                             "name": owner["name"]}})
        key = f"{item['target']} {item['type']}"
        counts[key] = counts.get(key, 0) + (1 if item["kind"] in ("add", "property") else 0)
    (directory / f"{name}.json").write_text(json.dumps({"registrations": rows, "counts": counts}, ensure_ascii=False, indent=1),
                                            encoding="utf-8")


if __name__ == "__main__":
    unittest.main(verbosity=2)
