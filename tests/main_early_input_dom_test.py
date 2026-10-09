# coding: utf-8
"""REQ-S9-U0a-PRE-ORDER -> RISK-EARLY-TDZ, RISK-REGISTRATION-ORDER, RISK-REGISTRATION-DUPLICATE
-> TEST-PRE-REGISTRATION, TEST-PRE-EARLY-03, TEST-PRE-EARLY-05, TEST-PRE-EARLY-58 (S9-U0a-PRE, D707/D714).

Splitting main.html's one inline script into ordered classic scripts opens a task gap at every boundary: the parser
waits for the next part while the page already shows its controls and can be left. An input or a pagehide in that
gap reaches the listeners the parts so far registered, and a listener that needs a binding declared in a later part
fails. PRE moves 35 declarations ahead of their earliest consumer (Astra's pre-review design) and moves no
registration. This file is the browser acceptance of that change on temporary 18/30/45-part copies of the page
(tests/main_split_harness.*; nothing is written to the product tree). The design names this suite
`main_pre_order_dom_test.py` and its helper `main_pre_contract.cjs`; here they are this file and main_split_harness.*.

What is compared is what a browser observes:
  * uncaught errors and console.error calls (studyPriority reports a failed render that way);
  * the dispatch outcome of every listener the hazard statements register, identified by the listener's source in
    the ORIGINAL page's registration trace (so a registration keeps its identity wherever its file is cut);
  * the screen (report fields, focus, template panel, Quick Match, chips, list, toasts) and
    KinWorkContext.selection() (the public module contract), right after the early input and after boot.
The original page has two early moments, and each is an original behaviour: before its script ran ("pre": the input
reaches no listener) and while boot waits for the session answer ("post": every listener is registered). An early
input on a split page must end exactly like one of them: never with an error or a partial result.

Registration: every registration of the page under test equals the ORIGINAL page's per (target, event), in order,
before the session answer and after each outcome (answered, failed, failed then Retry); the hazard targets gain no
registration after the session answer; after Retry one Quick Match change has one effect; a report field input
reaches its listeners in the original order. Window and session events at held boundaries raise nothing.

The ORIGINAL page is pinned: the f1d5406 git blobs of main.html, its other scripts and its move spec (byte identity
is the move's requirement, AGENTS 1-B.14). The page under test is the product file (KIN_PRE_PAGE may name a scratch
copy, e.g. a mutant); it is split along tests/main_move_spec.json, re-derived for its own statements when the spec
describes another page (KIN_PRE_SPEC overrides). KIN_PRE_TRACE_DIR receives the reference traces as JSON.
"""
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
TRACE_DIR = os.environ.get("KIN_PRE_TRACE_DIR")
ORIGINAL_COMMIT = "f1d540626aac03f46de23a9620d69f4c9da66037"   # RELIST = product 2fc7358, before the PRE moves


def original_blob(path):
    return subprocess.check_output(["git", "cat-file", "--filters", f"{ORIGINAL_COMMIT}:{path}"], cwd=ROOT)


ORIGINAL_SPEC = json.loads(original_blob("tests/main_move_spec.json").decode("utf-8"))
MODULE = {m["file"]: i for i, m in enumerate(ORIGINAL_SPEC["modules"])}
PARTS = ORIGINAL_SPEC["parts"]
FIELDS = ("findings", "conclusion", "recommendation")
SAVED = {"id": "SYN-FILTER-1", "name": "SYN Saved Search", "quick": "", "days": 0, "mode": "Radiology", "cols": {},
         "sortKey": None, "sortDir": 0, "isDefault": False}
LOCAL_SAVED = [{"name": "SYN Local Search", "quick": "", "days": -1, "mode": "Radiology", "cols": {}}]
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


def template_shortcut(page):
    # A shipped template's shortcut, then Tab: the shortcut listener expands it through the editor's one write path.
    page.click("#findings")
    page.keyboard.type("nbct")
    page.keyboard.press("Tab")


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
    # The template shortcut's indirect path (Tab -> expandShortcut -> editReport), part of B1-05 in the design.
    "B1-05-TAB": {"registers": ("report-templates-ui.js",), "targets": tuple("#" + k for k in FIELDS),
                  "inputs": template_shortcut, "after": select_study, "screen": ("fields", "focus", "work")},
    "B1-58": {"registers": ("worklist-controls.js",), "targets": ("#quick-match",),
              "inputs": quick_match, "after": search_patient, "screen": ("worklist", "toasts")},
    # Found by the phase-1 harness beside the re-listed three:
    "PRE-X1": {"registers": ("report-hold.js",), "targets": tuple("#" + k for k in FIELDS),
               "inputs": report_fields, "after": select_study, "screen": ("fields", "focus", "work")},
    "PRE-X2": TEMPLATES,
    "PRE-X3": {"registers": ("worklist-controls.js",), "targets": ("#quick", "#page-size", "#page-prev", "#page-next",
                                                                   "#page-current"),
               "inputs": worklist_controls, "after": search_patient, "screen": ("worklist", "toasts")},
}
SAVED_SEARCH_INPUTS = (quick_match, worklist_controls)

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

# A saved search this browser kept from a local session, present before any page script (the M25/M27 user result).
LOCAL_FILTERS = "try { localStorage.setItem('kin-filters', %s); } catch (_) {}" % json.dumps(json.dumps(LOCAL_SAVED))


class HazardFailure(AssertionError):
    def __init__(self, message, errors):
        super().__init__(message)
        self.errors = errors


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

    def __init__(self, case, layout, hold=None, delay_ms=0, auth="answer", filters=(), local_filters=False):
        self.case, (directory, self.manifest) = case, layout
        # The ORIGINAL page also gets the baseline's own versions of the page's other scripts.
        others = Pages.baseline_file if Path(directory).is_relative_to(Pages.original.root) else None
        self.site = PreSite(filters)
        if auth != "answer":
            self.site.held_me = []
        self.context = case.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.add_init_script(sh.TRACE_SCRIPT)
        self.context.add_init_script(TOAST_RECORDER)
        if local_filters:
            self.context.add_init_script(LOCAL_FILTERS)
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.context.route(PROBE_URL, lambda route: route.fulfill(body="<!doctype html><title>SYN elsewhere</title>",
                                                                  content_type="text/html; charset=utf-8"))
        self.delivery = sh.Delivery(directory, self.manifest, h.BASE, delay_ms=delay_ms, hold=hold,
                                    others=others).install(self.context)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(f"{error.name}: {error.message}"))
        self.page.on("console", self.on_console)
        self.page.on("dialog", self.on_dialog)
        case.runs.append(self)
        self.page.goto(h.MAIN_URL, wait_until="commit")

    def on_console(self, message):
        # console.error calls of page code only (browser notices - resource loads, sandboxed frames - are not the
        # page's report); the trace marks them, and the mark survives the document being left.
        if message.type == "error" and message.text.startswith(sh.CONSOLE_MARK):
            self.errors.append("console.error: " + message.text[len(sh.CONSOLE_MARK):].strip())

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

    def fail_auth(self):
        """The session check fails for good (503 to every retry): the page offers Retry Session Check."""
        self.answer_auth(status=503, failures=3)
        retry = self.page.locator("#err button")
        self.wait(lambda: retry.count() > 0, "the failed session check offers a retry", timeout=30)
        return retry

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
    """The ORIGINAL page (f1d5406 blobs) and the page under test, as scratch layouts."""
    current = original = derived = None
    blobs = {}

    @classmethod
    def baseline_file(cls, name):
        """A file of the page directory as the ORIGINAL commit has it (the ORIGINAL page's other scripts)."""
        if name not in cls.blobs:
            cls.blobs[name] = original_blob(Path(ORIGINAL_SPEC["page"]).parent.as_posix() + "/" + name)
        return cls.blobs[name]

    @classmethod
    def open(cls):
        if cls.current is None:
            cls.current = sh.ScratchPages(page=PAGE)
            spec = SPEC_PATH
            if SPEC_PATH == MOVE_SPEC:
                # Split along the move spec's runs, re-derived for this page's own statements (the spec itself when it
                # describes this page; a statement moved since the spec's base joins the run it now sits in).
                spec = cls.current.root / "derived-spec.json"
                cls.derived = sh.derive_spec(PAGE, spec)
            cls.current.spec = spec
            source = cls.current.root / "original-source" / "main.html"
            source.parent.mkdir(parents=True)
            source.write_bytes(cls.baseline_file("main.html"))
            original_spec = cls.current.root / "original-source" / "main_move_spec.json"
            original_spec.write_text(json.dumps(ORIGINAL_SPEC), encoding="utf-8")
            cls.original = sh.ScratchPages(page=source, spec=original_spec, root=cls.current.root / "original")

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
        self.assertEqual([], violations, "requests the synthetic origin does not answer")

    def assert_same_registrations(self, expected, observed, what):
        self.assertEqual([], registration_difference(expected, observed), what)

    # ── the scenario ──
    def early(self, hazard, layout, hold=None, delay_ms=0, trigger=None, auth="answer", gap=None):
        """Give the hazard's inputs at the early moment, let the page boot, and observe both times. With `gap` (timed
        delivery) the inputs must have been given before that part ran, or the case did not reach the gap."""
        spec = HAZARDS[hazard]
        saved = spec["inputs"] in SAVED_SEARCH_INPUTS
        run = Run(self, layout, hold=hold, delay_ms=delay_ms, auth=auth, filters=(SAVED,) if saved else (),
                  local_filters=saved)
        if hold:
            run.blocked()
        elif auth == "wait":
            run.auth_waits()
        elif trigger:
            run.ran(trigger)
        since = run.page.evaluate("window.__kinTrace.now()")
        spec["inputs"](run.page)
        if gap and run.page.evaluate("f => window.__kinTrace.executed.includes(f)", gap):
            self.skipTest(f"timing: the inputs ended after {gap} ran, so they did not land in the gap before it")
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
        """Uncaught errors and console.error calls when the person leaves the page at the early moment."""
        run = Run(self, layout, hold=hold, auth=auth, local_filters=True)
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
        """No error, no failed hazard listener, hazard listeners that were reached behave as in the original's `post`
        moment, and the screen (right after the input and after boot) is the original's at one of its two moments.
        Other listeners on the same targets may already be registered or not (a part boundary can fall between
        them); what counts is that the person sees what the original shows at `pre` or at `post`."""
        if result.errors:
            raise HazardFailure(f"{hazard}: uncaught errors on the early input: {result.errors}", result.errors)
        failed = [d for d in result.dispatches if d["error"]]
        self.assertEqual([], failed, f"{hazard}: hazard listeners that failed")
        references = {moment: self.reference(hazard, moment) for moment in ("pre", "post")}
        for moment, reference in references.items():
            self.assertEqual([], reference.errors, f"{hazard}: the original page itself had errors at the {moment} moment")
        if result.dispatches:
            self.assertEqual([(d["target"], d["type"]) for d in references["post"].dispatches],
                             [(d["target"], d["type"]) for d in result.dispatches],
                             f"{hazard}: the hazard listeners the early input reached, as at the original's post moment")
        parts = HAZARDS[hazard]["screen"]
        seen = {"early": {p: result.early_screen[p] for p in parts}, "final": {p: result.final_screen[p] for p in parts},
                "dialogs": result.dialogs}
        like = {moment: {"early": {p: r.early_screen[p] for p in parts}, "final": {p: r.final_screen[p] for p in parts},
                         "dialogs": r.dialogs} for moment, r in references.items()}
        if not any(expected == seen for expected in like.values()):
            nearest = min(like, key=lambda m: sum(like[m][t] != seen[t] for t in seen))
            for when in ("early", "final"):
                for part in parts:
                    self.assertEqual(like[nearest][when][part], seen[when][part],
                                     f"{hazard}: '{part}' ({when}) is neither the original's pre nor its post screen "
                                     f"(compared with the nearer one, {nearest})")
            self.assertEqual(like[nearest]["dialogs"], seen["dialogs"], f"{hazard}: dialogs")

    # ── whole-page registration and dispatch, ORIGINAL and page under test through the same steps ──
    def through(self, layout, outcome, after=None):
        """Registrations before the session answer and after `outcome`; `after(run)` adds steps and returns data."""
        run = Run(self, layout, auth="wait", filters=(SAVED,), local_filters=True)
        run.auth_waits()
        before = run.trace()["registrations"]
        if outcome == "answered":
            run.answer_auth()
            run.booted()
        else:
            retry = run.fail_auth()
            if outcome == "failed then retried":
                retry.click()
                run.booted()
        data = after(run) if after else None
        return before, run.trace()["registrations"], data, run


# ── TEST-PRE-REGISTRATION ──
class Registration(PreCase):
    OUTCOMES = ("answered", "failed", "failed then retried")

    def test_registrations_match_the_original_page_before_and_after_each_session_outcome(self):
        manifest = Pages.original.layout(0)[1]
        for outcome in self.OUTCOMES:
            with self.subTest(outcome=outcome):
                original_before, original_after, _, _ = self.through(Pages.original.layout(0), outcome)
                before, after, _, _ = self.through(Pages.current.layout(0), outcome)
                self.assert_same_registrations(sh.by_target_event(original_before), sh.by_target_event(before),
                                               f"{outcome}: per (target, event), in order, before the session answer")
                self.assert_same_registrations(sh.by_target_event(original_after), sh.by_target_event(after),
                                               f"{outcome}: per (target, event), in order, after the outcome")
                if TRACE_DIR:
                    name = outcome.replace(" ", "-")
                    write_trace(Path(TRACE_DIR), f"original-{name}", manifest, original_after)
                    write_trace(Path(TRACE_DIR), f"current-{name}", Pages.current.layout(0)[1], after)
                    if outcome == "answered":
                        write_trace(Path(TRACE_DIR), "original-before-session-answer", manifest, original_before)
                        write_trace(Path(TRACE_DIR), "current-before-session-answer", Pages.current.layout(0)[1], before)

    def test_hazard_registrations_do_not_depend_on_the_session_answer_and_retry_adds_none(self):
        keys = {(t, e) for hazard in HAZARDS for (t, e, _) in self.keys(hazard)}
        targets = {t for t, _ in keys}
        expected = sh.by_target_event(self.original_trace()[1], keys)
        for outcome in self.OUTCOMES:
            with self.subTest(outcome=outcome):
                before, after, _, _ = self.through(Pages.current.layout(0), outcome)
                on_targets = {(r["target"], r["type"]) for r in after if r["target"] in targets}
                self.assert_same_registrations(expected, sh.by_target_event(before, keys),
                                               f"{outcome}: the hazard registrations exist before the session answer")
                self.assert_same_registrations(sh.by_target_event(before, on_targets), sh.by_target_event(after, on_targets),
                                               f"{outcome}: the hazard targets gain no registration after the session answer")

    def change_after_retry(self, run):
        since = run.page.evaluate("window.__kinTrace.now()")
        quick_match(run.page)
        run.settle(300)
        registrations = {r["seq"]: r for r in run.trace()["registrations"]}
        dispatched = [(d["target"], d["type"], registrations[d["registration"]]["listener"])
                      for d in run.trace(since)["dispatches"] if "registration" in d and d["target"] == "#quick-match"]
        search_patient(run.page)
        return dispatched, run.screen()["worklist"], list(run.errors)

    def test_after_retry_one_quick_match_change_has_one_effect(self):
        _, _, original, _ = self.through(Pages.original.layout(0), "failed then retried", self.change_after_retry)
        _, _, current, _ = self.through(Pages.current.layout(0), "failed then retried", self.change_after_retry)
        self.assertEqual([], current[2], "errors")
        self.assertEqual(original[0], current[0], "the listeners one Quick Match change reaches after Retry")
        self.assertEqual(original[1], current[1], "the list, chips and saved-search state after that change")

    def input_order(self, run):
        select_study(run.page)
        since = run.page.evaluate("window.__kinTrace.now()")
        run.page.click("#findings")
        run.page.keyboard.type("a")
        run.settle(300)
        registrations = {r["seq"]: r for r in run.trace()["registrations"]}
        return [(d["target"], d["type"], registrations[d["registration"]]["listener"])
                for d in run.trace(since)["dispatches"] if "registration" in d and d["target"] == "#findings"]

    def test_a_report_field_input_reaches_its_listeners_in_the_original_order(self):
        _, _, original, _ = self.through(Pages.original.layout(0), "answered", self.input_order)
        _, _, current, run = self.through(Pages.current.layout(0), "answered", self.input_order)
        self.assertEqual([], run.errors)
        self.assertTrue(any(t == "input" for _, t, _ in original), "the original reaches input listeners")
        self.assertEqual(original, current, "the (target, event, listener) invocation order of one focus/keypress")


# ── window and session events at held boundaries (nothing of them may fail in a gap) ──
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
                other = run.context.new_page()
                other.goto(PROBE_URL)
                other.bring_to_front()
                run.page.wait_for_timeout(100)
                run.page.bring_to_front()
                other.evaluate("""end => { localStorage.setItem('kin-session-end:' + end.session, JSON.stringify(end));
                  new BroadcastChannel('kin-session').postMessage({ type: 'session-ended', ...end }); }""", self.END)
                run.page.wait_for_timeout(300)
                other.close()
                self.assertEqual([], run.errors)


# ── TEST-PRE-EARLY-03/05/58 controls on the unsplit page ──
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

    def test_B1_05_TAB_unsplit(self):
        self.check("B1-05-TAB")

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


# ── TEST-PRE-EARLY-03/05/58 and the leaving cases on split pages ──
class EarlyInputSplit(PreCase):
    pass


def case_name(hazard, count, where):
    return f"test_{hazard.replace('-', '_')}_{count}_{re.sub(r'[^A-Za-z0-9]+', '_', where).strip('_')}"


def split_case(hazard, count, guarded, hold_module=None, trigger_module=None, delay_ms=0, gap_module=None):
    def test(self):
        layout = Pages.current.layout(count)
        manifest = layout[1]
        hold = sh.part_of(manifest, hold_module) if hold_module is not None else None
        trigger = sh.part_of(manifest, trigger_module) if trigger_module is not None else None
        gap = sh.part_of(manifest, gap_module) if gap_module is not None else None
        self.assertTrue(hold or (trigger and gap), "the case names a boundary of this layout")
        self.assert_like_original(hazard, self.early(hazard, layout, hold=hold, delay_ms=delay_ms, trigger=trigger,
                                                     gap=gap))
    files = ORIGINAL_SPEC["modules"]
    where = (f"hold {files[hold_module]['file']}" if hold_module is not None
             else f"{delay_ms}ms after {files[trigger_module]['file']}")
    name = case_name(hazard, count, where)
    test.__name__ = name
    test.__doc__ = f"{hazard}: {count}-part page, {where} (the original page failed here on {guarded})"
    setattr(EarlyInputSplit, name, test)


def leave_case(hazards, count, guarded, hold_module):
    def test(self):
        layout = Pages.current.layout(count)
        errors = self.leaving(layout, hold=sh.part_of(layout[1], hold_module))
        if errors:
            raise HazardFailure(f"{hazards}: errors while leaving the page at the early moment: {errors}", errors)
        self.assertEqual([], self.leaving(Pages.original.layout(0), auth="wait"), "the original page leaves without errors")
    where = f"leave while holding {ORIGINAL_SPEC['modules'][hold_module]['file']}"
    name = case_name(hazards.split("/")[0], count, where)
    test.__name__ = name
    test.__doc__ = f"{hazards}: {count}-part page, {where} (the original page failed here on {guarded})"
    setattr(EarlyInputSplit, name, test)


for count in PARTS:
    last = count - 1
    # B1-03: after the dictation registration and before selectionSeq's original module.
    split_case("B1-03", count, "selectionSeq", hold_module=MODULE["report-dictation.js"] + 1)
    split_case("B1-03", count, "selectionSeq", hold_module=min(MODULE["report-editor.js"], last))
    # B1-05: before cur's original module (Modality/Bodypart/search/clear), then before RFIELDS' (View).
    split_case("B1-05", count, "cur", hold_module=MODULE["report-templates-ui.js"] + 1)
    split_case("B1-05", count, "cur", hold_module=MODULE["current-study.js"])
    split_case("B1-05", count, "RFIELDS", hold_module=min(MODULE["related-report.js"], last))
    # B1-05 Tab shortcut: before editReport's original module.
    split_case("B1-05-TAB", count, "editReport", hold_module=MODULE["report-templates-ui.js"] + 1)
    split_case("B1-05-TAB", count, "editReport", hold_module=min(MODULE["report-draft-save.js"], last))
    # B1-58 / PRE-X3: only where saved-filters.js is a part of its own.
    if MODULE["saved-filters.js"] < count:
        split_case("B1-58", count, "renderChips", hold_module=MODULE["saved-filters.js"])
        split_case("PRE-X3", count, "renderChips", hold_module=MODULE["saved-filters.js"])
    # PRE-X1 / PRE-X2: the report fields' input (report-hold.js) and View, both before reportWriteBlock's module.
    if MODULE["report-toolbar.js"] < count:
        for module in (MODULE["work-exit.js"], MODULE["report-toolbar.js"]):
            split_case("PRE-X1", count, "reportWriteBlock", hold_module=module)
        for module in (MODULE["report-editor.js"], MODULE["report-toolbar.js"]):
            split_case("PRE-X2", count, "reportWriteBlock", hold_module=module)
    # Leaving the page: relatedParts/studyPriority/feature mounts reach render, renderRelated, updateReportButtons,
    # renderChips and applyLayout from their pagehide (B1-15/41/42/45, B1-57, PRE-P3).
    for module, hazards, guarded in (
            ("worklist-view.js", "B1-15/41/42/45", "renderRelated, render (console.error)"),
            ("related-studies.js", "B1-41/42/45", "renderRelated, renderChips, updateReportButtons (console.error)"),
            ("report-commit.js", "B1-41/45", "renderChips, updateReportButtons (console.error)"),
            ("clinical-context-panel.js", "B1-57/PRE-P3", "applyLayout, renderChips"),
            ("workspace-panels.js", "B1-57/PRE-P3", "applyLayout, renderChips"),
            ("worklist-controls.js", "PRE-P3", "renderChips"),
            ("saved-filters.js", "PRE-P3/B1-41", "renderChips")):
        if MODULE[module] < count:
            leave_case(hazards, count, guarded, MODULE[module])
# 150 ms per boundary, no hold: the inputs as soon as the registering part ran, before the declaring part.
for hazard, guarded, registering, declaring in (
        ("B1-03", "selectionSeq", "report-dictation.js", "report-editor.js"),
        ("B1-05", "cur", "report-templates-ui.js", "current-study.js"),
        ("B1-05", "RFIELDS", "current-study.js", "related-report.js"),
        ("B1-58", "renderChips", "worklist-controls.js", "saved-filters.js")):
    split_case(hazard, 45, guarded, trigger_module=MODULE[registering], delay_ms=150, gap_module=MODULE[declaring])


def write_trace(directory, name, manifest, registrations):
    """A reference trace: each registration with the statement that made it, and counts per (target, event)."""
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
