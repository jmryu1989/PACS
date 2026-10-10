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
import datetime
from collections import Counter
import hashlib
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

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
    """The logout suite's synthetic origin, with an account model of its own: saved searches and templates the page
    reads (bootstrap, prefs) and writes (POST/DELETE), an optional list of studies, a speech recognizer whose answers
    wait for the case (`dictation`), writes the case can hold, and - for a deterministic run - every request but the
    page's own files waiting until the case releases it (`hold_all`), in arrival order, with a ledger of them."""

    DICTATION = {"available": True, "maxBytes": 1048576, "timeoutMs": 60000, "languagePin": "ko",
                 "enginePin": "SYN-ENGINE", "modelPin": "SYN-MODEL"}

    def __init__(self, filters=(), dictation=False, templates=(), rows=None, assets=None):
        super().__init__()
        self.filters = [dict(f) for f in filters]
        self.templates = [dict(t) for t in templates]
        self.study_list = [tuple(r) for r in rows] if rows else None  # (uid, name, patient id) of the listed studies
        self.assets = Path(assets) if assets else None                # files that replace the page directory's
        self.dictation = dictation
        self.held_dictations, self.dictations = [], []
        self.hold_all, self.waiting, self.ledger = False, [], []
        self.request_rows = {}
        self.hold_writes, self.held_writes = set(), []                # "template-post", "filter-delete"
        self.prefs_answers = []                                       # (status, body) | "not-a-list", in order
        self.template_posts, self.filter_deletes, self.serial_template = [], [], 0

    # ── requests ──
    @staticmethod
    def page_file(path):
        return path.startswith(h.BASE) or path.startswith("/kin-brand/") or path == "/favicon.ico"

    def handle(self, route, request):
        url = urlparse(request.url)
        if not self.page_file(url.path):
            identity = (request.method, url.path, canonical_query(url.query))
            occurrence = 1 + sum(request_key(r)[:3] == identity for r in self.ledger)
            row = {"n": len(self.ledger) + 1, "method": request.method, "path": url.path,
                   "query": url.query, "occurrence": occurrence, "held": self.hold_all,
                   "key": (*identity, occurrence)}
            self.ledger.append(row)
            self.request_rows[request] = row
            if self.hold_all:
                return self.waiting.append((route, request))
        return super().handle(route, request)

    def release(self, index=0):
        route, request = self.waiting.pop(index)
        if hasattr(self, "steps"):
            record = self.request_rows[request]
            record["released_at"] = self.steps.virtual
        return h.Site.handle(self, route, request)

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        if self.study_list:
            body["studies"] = [self.study_row(account, uid, name, patient) for uid, name, patient in self.study_list]
            body["pagination"]["total"] = len(body["studies"])
        return body

    def api(self, route, request, method, path, query):
        if method == "GET" and path == "/api/bootstrap":
            account, refused = self.authenticate(request, strict=True)
            if refused:
                return self.refuse(route, *refused)
            body = {"statesOmitted": True, "me": {"actor": account["actor"], "roles": account["roles"],
                    "institution": h.INSTITUTION, "institutionName": "SYN Hospital A"},
                    "filters": [dict(f) for f in self.filters], "templates": [dict(t) for t in self.templates],
                    "institutions": [{"id": h.INSTITUTION, "name": "SYN Hospital A", "type": "hospital"}],
                    "states": {}, "orders": [], "serverTime": "2026-10-03T00:00:00.000Z"}
            if self.dictation:
                body["dictation"] = dict(self.DICTATION)
            return route.fulfill(json=body)
        if method == "GET" and path == "/api/prefs":
            account, refused = self.authenticate(request, strict=True)
            if refused:
                return self.refuse(route, *refused)
            reply = self.prefs_answers.pop(0) if self.prefs_answers else None
            if reply == "not-a-list":
                return route.fulfill(json={"filters": "SYN not a list", "templates": [dict(t) for t in self.templates]})
            if reply:
                return self.answer(route, *reply)
            return route.fulfill(json={"filters": [dict(f) for f in self.filters],
                                       "templates": [dict(t) for t in self.templates]})
        if method == "POST" and path == "/api/templates":
            self.template_posts.append(request.post_data_json)
            if "template-post" in self.hold_writes:
                return self.held_writes.append(("template-post", route, request.post_data_json))
            return route.fulfill(json=self.store_template(request.post_data_json))
        found = re.fullmatch(r"/api/filters/([^/]+)", path)
        if method == "DELETE" and found:
            self.filter_deletes.append(found.group(1))
            if "filter-delete" in self.hold_writes:
                return self.held_writes.append(("filter-delete", route, found.group(1)))
            self.filters = [f for f in self.filters if f.get("id") != found.group(1)]
            return route.fulfill(json={"ok": True})
        found = re.fullmatch(r"/api/studies/([^/]+)/dictation", path)
        if self.dictation and method == "POST" and found:
            account, refused = self.authenticate(request, strict=True)
            if refused:
                return self.refuse(route, *refused)
            self.dictations.append(found.group(1))
            return self.held_dictations.append(route)
        return super().api(route, request, method, path, query)

    def store_template(self, body):
        """The template as the server keeps it: the whole body replaces the stored one of its id (a new one gets an id)."""
        saved = dict(body)
        if not saved.get("id"):
            self.serial_template += 1
            saved["id"] = f"SYN-TPL-NEW-{self.serial_template}"
        index = next((i for i, t in enumerate(self.templates) if t.get("id") == saved["id"]), None)
        if index is None:
            self.templates.append(saved)
        else:
            self.templates[index] = saved
        return saved

    def finish_write(self):
        kind, route, value = self.held_writes.pop(0)
        if kind == "template-post":
            return route.fulfill(json=self.store_template(value))
        self.filters = [f for f in self.filters if f.get("id") != value]
        return route.fulfill(json={"ok": True})

    def static(self, route, path):
        name = path[len(h.BASE):] if path.startswith(h.BASE) else None
        if name and getattr(self, "historical_file", None):
            return route.fulfill(status=200, content_type=h.TYPES[Path(name).suffix], body=self.historical_file(name))
        if name and self.assets and (self.assets / name).is_file():
            return route.fulfill(status=200, content_type=h.TYPES[Path(name).suffix], body=(self.assets / name).read_bytes())
        # The dictation's AudioWorklet module: a file of the page directory the logout suite's table does not list.
        if path == h.BASE + "dictation-worklet.js":
            return route.fulfill(status=200, content_type="text/javascript; charset=utf-8",
                                 body=(sh.PRODUCT_DIR / "dictation-worklet.js").read_bytes())
        return super().static(route, path)

    def answer_dictation(self, text):
        route = self.held_dictations.pop(0)
        self.answer(route, 200, {"text": text, "seconds": 1.0, "languagePin": "ko", "enginePin": "SYN-ENGINE",
                                 "modelPin": "SYN-MODEL"})


# A deterministic run's clock: installed and paused before the page's first script, at the synthetic fixture's day.
CLOCK_START = datetime.datetime(2026, 10, 3, 0, 30, tzinfo=datetime.timezone.utc)   # 09:30 KST, the fixture's day
# Files that replace the page directory's for the page under test only (a mutant of a page asset; the driver sets it).
ASSETS = os.environ.get("KIN_PRE_ASSETS")
# Storage the case breaks and mends: the whole localStorage of a document (as blocked site data does) or the saved
# search key alone. The switch is a cookie the case owns, so a fault reaches the next document too and ends when the
# case says; __synMendStorage gives a document already loaded its storage back.
STORAGE_FAULT = """(() => {
  const on = name => document.cookie.split('; ').includes(name + '=on');
  if (on('syn-storage-fault')) {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true,
      get() { throw new DOMException('SYN storage blocked', 'SecurityError'); } });
    Object.defineProperty(window, '__synMendStorage', { value: () => {
      if (own) Object.defineProperty(window, 'localStorage', own); else delete window.localStorage; } });
  }
  const get = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    if (String(key) === 'kin-filters' && on('syn-filters-fault'))
      throw new DOMException('SYN saved search key blocked', 'SecurityError');
    return get.call(this, key);
  };
})();"""


class Run:
    """One page of one layout with its own context, synthetic origin and script delivery. Nothing of it is shared with
    another Run: a new context (storage, cookies, clock), a new PreSite (account model, queues, holds) and a new
    delivery each time."""

    def __init__(self, case, layout, hold=None, delay_ms=0, auth="answer", filters=(), local_filters=False,
                 dictation=False, second_study=False, init_scripts=(), permissions=(), cache_headers=True, templates=(),
                 deterministic=False, rows=None, dialogs=(), cookies=()):
        self.case, (directory, self.manifest) = case, layout
        # The ORIGINAL page also gets the baseline's own versions of the page's other scripts.
        self.source_side = self.manifest.get("side", "current")
        self.original = self.source_side == "original"
        assets = Path(ASSETS) if ASSETS and not self.original else None
        others = (lambda name: Pages.blob_file(self.source_side, name)) if self.source_side != "current" else (
            (lambda name: (assets / name).read_bytes() if (assets / name).is_file() else (sh.PRODUCT_DIR / name).read_bytes())
            if assets else None)
        self.site = PreSite(filters, dictation=dictation, templates=templates, rows=rows, assets=assets)
        if self.source_side != "current":
            self.site.historical_file = lambda name: Pages.blob_file(self.source_side, name)
        self.site.second_study = second_study
        if auth != "answer":
            self.site.held_me = []
        self.dialog_answers = list(dialogs)        # (words in the message, accept?) - any other dialog is dismissed
        self.context = case.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.steps = None
        if deterministic:
            self.context.clock.install(time=CLOCK_START)
            self.context.clock.pause_at(CLOCK_START)
        if cookies:
            self.context.add_cookies([{"name": name, "value": value, "url": h.ORIGIN} for name, value in cookies])
        if permissions:
            self.context.grant_permissions(list(permissions), origin=h.ORIGIN)
        self.context.add_init_script(sh.TRACE_SCRIPT)
        if deterministic:
            self.context.add_init_script(sh.LEDGER_SCRIPT)
        self.context.add_init_script(TOAST_RECORDER)
        self.context.add_init_script(h.STORAGE_RECORDER)
        if local_filters:
            self.context.add_init_script(LOCAL_FILTERS)
        for script in init_scripts:
            self.context.add_init_script(script)
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.context.route(PROBE_URL, lambda route: route.fulfill(body="<!doctype html><title>SYN elsewhere</title>",
                                                                  content_type="text/html; charset=utf-8"))
        self.delivery = sh.Delivery(directory, self.manifest, h.BASE, delay_ms=delay_ms, hold=hold, others=others,
                                    cache_headers=cache_headers).install(self.context)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(f"{error.name}: {error.message}"))
        self.page.on("console", self.on_console)
        self.page.on("dialog", self.on_dialog)
        case.runs.append(self)
        if deterministic:
            self.site.hold_all = True
            self.steps = Steps(self)
        self.closed = False
        self.page.goto(h.MAIN_URL, wait_until="commit")

    def on_console(self, message):
        # console.error calls of page code only (browser notices - resource loads, sandboxed frames - are not the
        # page's report); the trace marks them, and the mark survives the document being left.
        if message.type == "error" and message.text.startswith(sh.CONSOLE_MARK):
            self.errors.append("console.error: " + message.text[len(sh.CONSOLE_MARK):].strip())

    def on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        for words, accept in self.dialog_answers:
            if words in dialog.message:
                return dialog.accept() if accept else dialog.dismiss()
        dialog.dismiss()

    def wait(self, predicate, what, timeout=60.0):
        # A bound, not a pace: a fresh browser's first page (an 800 KB inline script) can take tens of seconds on a
        # loaded machine; every wait returns as soon as it is met.
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

    def quiet(self, still_ms=750, limit_s=15.0):
        """Until the trace has recorded nothing new for `still_ms` (a document change counts as new). Used where the
        page runs on its own clock and screens - not traces - are compared; the registration comparisons run on a
        paused clock and end at barriers instead (Steps). Not reached within `limit_s` is a failure, never a pass."""
        end, last, since = time.monotonic() + limit_s, None, time.monotonic()
        while time.monotonic() < end:
            self.delivery.pump()
            try:
                now = (self.page.url, self.page.evaluate("window.__kinTrace ? window.__kinTrace.now() : -1"))
            except PlaywrightError:
                now = None                                    # a document is being replaced
            if now != last or now is None:
                last, since = now, time.monotonic()
            elif time.monotonic() - since >= still_ms / 1000:
                return
            self.page.wait_for_timeout(25)
        raise AssertionError(f"QUIET: the page did not settle for {still_ms} ms within {limit_s:.0f} s")

    def observe(self):
        for attempt in range(3):
            try:
                return self.page.evaluate(OBSERVE)
            except PlaywrightError:
                if attempt == 2:
                    raise
                self.page.wait_for_timeout(500)

    def leave(self):
        self.page.goto(PROBE_URL, wait_until="commit")
        self.page.wait_for_timeout(250)

    def trace(self, since=0):
        return sh.snapshot(self.page, since)

    def screen(self):
        return self.page.evaluate(SCREEN)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.delivery.dispose()
        for route in [*(self.site.held_me or []), *self.site.held_dictations, *(r for r, _ in self.site.waiting),
                      *(w[1] for w in self.site.held_writes)]:
            try:
                route.abort()
            except PlaywrightError:
                pass
        self.site.held_me, self.site.waiting, self.site.held_writes = None, [], []
        try:
            self.context.close()
        except PlaywrightError:
            pass


class Steps:
    """A deterministic run (Astra fix-2 design §2): the clock is paused before the page's first script; the synthetic
    origin keeps every request waiting. `drive()` answers the waiting requests one at a time in arrival order - each
    one's answer and body taken by the page before the next is answered - and moves virtual time only when nothing is
    waiting or in flight, to the next timer or animation frame that is due. A phase ends at a barrier: its condition, no
    request waiting (other than those the schedule holds), nothing in flight, no answer body held, and nothing over its
    virtual time limit. Past the limit or the host bound the phase fails; the case keeps the raw state first."""

    STEP_MS, HOST_S = 16, 240.0

    def __init__(self, run):
        self.run, self.virtual = run, 0
        self.phases = []
        self.hold_events = []
        self.host_clock = time.monotonic
        self.deadline_hook = None
        run.site.steps = self

    def ledger(self):
        return self.run.page.evaluate("window.__synLedger.state()")

    def pending(self, state, holds):
        waiting = [request for _, request in self.run.site.waiting if not self.is_held(request, holds)]
        flying = [f for f in state["fetches"] if (f["state"] == "pending" and not held_key(request_key(f), holds))
                  or f["body"] == "reading"]
        return waiting, flying

    def is_held(self, request, holds):
        record = self.run.site.request_rows[request]
        return held_key(record["key"], holds)

    def drive(self, condition, what, limit_ms, holds=(), release=None, delivery_only=False):
        """`holds`: exact request keys that stay waiting (the case answers them later); `release(state)`: the schedule's
        own point to let a held body go (returns True when it released one)."""
        run, start, deadline = self.run, self.virtual, self.host_clock() + self.HOST_S
        if self.deadline_hook:
            self.deadline_hook(self, what, deadline)
        while True:
            if self.host_clock() > deadline:
                raise AssertionError(f"PHASE {what}: not reached within {self.HOST_S:.0f} s of host time "
                                     f"(virtual {self.virtual - start} ms)")
            run.delivery.pump()
            if delivery_only:
                if condition():
                    self.phases.append({"phase": what, "virtual": self.virtual, "pending_timers": self.ledger()["timers"]})
                    return self.ledger()
                # Script delivery is host I/O. It must never spend a virtual timer tick merely because the parser
                # has not consumed a script yet (the former 16ms P0 drift).
                run.page.wait_for_timeout(5)
                continue
            index = next((i for i, (_, request) in enumerate(run.site.waiting)
                          if not self.is_held(request, holds)), None)
            if index is not None:
                run.site.release(index)
                continue
            state = self.ledger()
            waiting, flying = self.pending(state, holds)
            if flying:
                run.page.wait_for_timeout(5)
                continue
            if release and release(state):
                continue
            if condition() and not state["held"]:
                self.phases.append({"phase": what, "virtual": self.virtual, "pending_timers": state["timers"]})
                return state
            step = self.STEP_MS if state["nextDue"] is None else max(1, min(1000, state["nextDue"] - state["now"]))
            if self.virtual - start + step > limit_ms:
                raise AssertionError(f"PHASE {what}: condition not met within {limit_ms} virtual ms "
                                     f"(held bodies {state['held']}, timers {state['timers'][:6]})")
            run.page.clock.run_for(step)
            self.virtual += step

    def settled(self, holds=()):
        """Nothing waiting, in flight or held (asserted after every barrier)."""
        state = self.ledger()
        waiting, flying = self.pending(state, holds)
        return {"waiting": [urlparse(r.url).path for r in waiting], "in_flight": [f["path"] for f in flying],
                "held_bodies": state["held"]}

    def rendered(self, what):
        """The app clock and the browser compositor have separate frame queues. An isolated world's native rAF
        observes real render/scroll completion even when a scroll position changed and returned to its old value.
        All product dispatches remain in the main-world trace, including those before selection."""
        self.run.page.clock.run_for(32)
        self.virtual += 32
        self.native_frames()
        self.run.wait(lambda: not self.run.page.evaluate("window.__kinTrace.rendering()"),
                      what + ": browser scroll completion")
        self.drive(lambda: True, what, 5000)

    def native_frames(self):
        if not hasattr(self, "render_cdp"):
            self.render_cdp = self.run.context.new_cdp_session(self.run.page)
            frame = self.render_cdp.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
            self.render_world = self.render_cdp.send("Page.createIsolatedWorld", {
                "frameId": frame, "worldName": "kin-native-render-observer"})["executionContextId"]
        result = self.render_cdp.send("Runtime.evaluate", {"contextId": self.render_world, "awaitPromise": True,
            "returnByValue": True,
            "expression": "new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('native frame timeout')), 10000); "
                          "requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(true); })); })"})
        self.run.case.assertEqual(True, result.get("result", {}).get("value"), "native rendering frames completed")

    def prepare_control(self, locator, what):
        locator.scroll_into_view_if_needed()
        self.rendered(what)

    def click_control(self, locator, what):
        self.prepare_control(locator, what + " visible")
        # Hover uses Playwright's hit testing of the visible clipped area; a wide table row's raw bounding-box
        # centre can lie outside its scroll pane and over a different control.
        locator.hover()
        self.native_frames()
        self.run.page.mouse.down()
        self.native_frames()
        self.run.page.mouse.up()
        self.native_frames()

    def raw(self, phase, status="completed"):
        """Everything of the run at the end of a phase, kept before anything is compared."""
        run = self.run
        return {"phase": phase, "status": status, "virtual_ms": self.virtual, "trace": run.trace(), "ledger": self.ledger(),
                "site": [dict(item) for item in run.site.ledger], "screen": run.observe(), "errors": list(run.errors),
                "dialogs": list(run.dialogs), "phases": list(self.phases), "holds": list(self.hold_events),
                "inbox_badge": run.page.evaluate("document.getElementById('cvr-inbox-badge')?.innerText || null"),
                "source": {"page": run.manifest["source"], "sha256": hashlib.sha256(run.delivery.body("main.html")).hexdigest(),
                    "layout": run.manifest.get("count"), "original": run.original,
                    "side": run.source_side, "kind": run.manifest["kind"], "inputs": run.delivery.expected,
                    "delivered": list(run.delivery.bodies), "manifest": run.manifest, "frozen": Pages.frozen[run.source_side]},
                "schedule": getattr(self, "schedule", None), "fixture": {"filters": run.site.filters}}


class Result:
    def __init__(self, **values):
        self.__dict__.update(values)


class Pages:
    """The ORIGINAL page (f1d5406 blobs) and the page under test, as scratch layouts."""
    current = original = approved = previous = derived = None
    blobs, frozen = {}, {}

    @classmethod
    def baseline_file(cls, name):
        """A file of the page directory as the ORIGINAL commit has it (the ORIGINAL page's other scripts)."""
        if name not in cls.blobs:
            cls.blobs[name] = original_blob(Path(ORIGINAL_SPEC["page"]).parent.as_posix() + "/" + name)
        return cls.blobs[name]

    @classmethod
    def blob_file(cls, which, name):
        if which == "original":
            return cls.baseline_file(name)
        sha = cls.commits[which]
        key = (sha, name)
        if key not in cls.blobs:
            cls.blobs[key] = subprocess.check_output(["git", "cat-file", "--filters",
                f"{sha}:worklist-v0/hpacs-lite/{name}"], cwd=ROOT)
        return cls.blobs[key]

    @classmethod
    def layout(cls, which, count=0):
        directory, manifest = getattr(cls, which).layout(count)
        manifest["side"] = which
        return directory, manifest

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
            # AST provenance shared by both pages: each statement's f1d5406 statement.
            cls.frozen = {"original": sh.frozen_indexes(source), "current": sh.frozen_indexes(PAGE)}
            cls.commits = {"approved": json.loads(MOVE_SPEC.read_text(encoding="utf-8"))["base"],
                           "previous": os.environ.get("KIN_SPLIT_PARENT", subprocess.check_output(
                               ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip())}
            for which in ("approved", "previous"):
                source = cls.current.root / (which + "-source") / "main.html"
                source.parent.mkdir(parents=True)
                source.write_bytes(cls.blob_file(which, "main.html"))
                # Previous parts may already be external: materialize their own Git blobs, never today's files.
                for module in json.loads(MOVE_SPEC.read_text(encoding="utf-8"))["modules"]:
                    if f'src="{module["file"]}"' in source.read_text(encoding="utf-8"):
                        (source.parent / module["file"]).write_bytes(cls.blob_file(which, module["file"]))
                setattr(cls, which, sh.ScratchPages(page=source, spec=MOVE_SPEC, root=cls.current.root / which))
                cls.frozen[which] = sh.frozen_indexes(source)
            # Existing callers of ScratchPages.layout also carry their source side.
            for which in ("original", "current", "approved", "previous"):
                getattr(cls, which).side = which

    @classmethod
    def provenance(cls, which, count=0):
        """Frames of that page's `count`-part layout, mapped to what both pages share (sh.Provenance)."""
        return sh.Provenance(cls.layout(which, count)[1], cls.frozen[which])

    @classmethod
    def close(cls):
        if cls.current is not None:
            cls.current.close()
            cls.current = cls.original = cls.approved = cls.previous = None


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
    def early(self, hazard, layout, hold=None, delay_ms=0, trigger=None, auth="answer", gap=None, before_input=None):
        """Give the hazard's inputs at the early moment, let the page boot, and observe both times. With `gap` (timed
        delivery) the inputs must have been given before that part ran, or the case did not reach the gap.
        `before_input(run)` checks the moment itself (a mutant case's precondition)."""
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
        if before_input:
            before_input(run)
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

    def leaving(self, layout, hold=None, auth="answer", before_leave=None):
        """Uncaught errors and console.error calls when the person leaves the page at the early moment."""
        run = Run(self, layout, hold=hold, auth=auth, local_filters=True)
        if hold:
            run.blocked()
        else:
            run.auth_waits()
        if before_leave:
            before_leave(run)
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

    # ── whole-page registration and dispatch, ORIGINAL and page under test through the same schedule ──
    def through(self, layout, outcome, after=None, schedule="default", keep=None, delay_ms=0):
        """A deterministic run (Steps) through the session check and `outcome`, phase by phase:
          P0  every script ran, the first session check waits (unanswered);
          P1  it fails - 503 and the page's own three retries - and one usable Retry button is offered;
          P2  (repeated failure) Retry, the same four 503 answers, a new usable Retry button;
          P3  (answered, or the last Retry) 200, the boot's requests one by one, the worklist, then the inbox's one-second
              watch and its received-view read;
        each phase's raw state is handed to `keep(phase, raw)` as soon as it exists (a failed phase hands over what it
        has). `after(run)` adds P4 and returns data. The Run is closed before this returns."""
        run = Run(self, layout, deterministic=True, filters=(SAVED,), local_filters=True, delay_ms=delay_ms)
        steps, raws = run.steps, {}
        steps.schedule = schedule
        hold = SCHEDULES[schedule]
        keep = keep or (lambda phase, raw: None)

        def phase(name, condition, limit_ms, holds=(), release=None, delivery_only=False):
            try:
                steps.drive(condition, name, limit_ms, holds=holds, release=release, delivery_only=delivery_only)
            except AssertionError:
                keep(name + "-partial", steps.raw(name, status="failed"))
                raise
            left = steps.settled(holds)
            raws[name] = steps.raw(name)
            keep(name, raws[name])
            # The barrier's own guarantee, checked on its own: nothing of the phase is left over.
            self.assertEqual({"waiting": [], "in_flight": [], "held_bodies": []}, left, f"{name}: the barrier left work behind")

        def retry_ready(previous=None):
            buttons = run.page.locator("#err button:not([disabled])")
            if buttons.count() != 1:
                return False
            return previous is None or buttons.evaluate("(b, old) => b !== old", previous)

        def me_asked():
            return sum(1 for item in run.site.ledger if item["path"] == "/api/me")

        try:
            scripts = set(run.delivery.order)
            phase("P0", lambda: any(urlparse(q.url).path == "/api/me" for _, q in run.site.waiting)
                  and scripts <= set(run.page.evaluate("window.__kinTrace.executed")), 10000, holds=(ME_KEY,),
                  delivery_only=True)
            self.assertEqual((0, int(CLOCK_START.timestamp() * 1000)),
                             (steps.virtual, steps.ledger()["now"]), "P0: script delivery spends no virtual time")
            if outcome != "answered":
                run.site.me_answers = [ME_FAIL] * 4
                phase("P1", lambda: me_asked() == 4 and retry_ready(), 20000)
                if outcome == "failed, retried and failed again, then retried":
                    old = run.page.locator("#err button").element_handle()
                    run.site.me_answers = [ME_FAIL] * 4
                    run.page.locator("#err button").click()
                    phase("P2", lambda: me_asked() == 8 and retry_ready(old), 20000)
            if outcome != "failed":
                if outcome != "answered":
                    run.site.me_answers = []
                    run.page.locator("#err button").click()
                held_since, holds = {}, set()
                if hold and hold["kind"] == "body":
                    run.page.evaluate("key => { window.__synBodyHolds = new Map([[key, []]]); }",
                                      json.dumps(hold["key"], separators=(",", ":")))
                if hold and hold["kind"] == "answer":
                    holds.add(hold["key"])

                def release(state):
                    """The schedule's own point: the held body or answer goes once `after_ms` of virtual time passed since
                    the page reached it (every other request and timer goes on meanwhile)."""
                    if not hold or hold["path"] in held_since and hold["key"] not in holds and hold["kind"] == "answer":
                        return False
                    reached = (hold["path"] in state["held"] if hold["kind"] == "body"
                               else any(steps.is_held(q, holds) for _, q in run.site.waiting))
                    if not reached:
                        return False
                    if hold["path"] not in held_since:
                        held_since[hold["path"]] = steps.virtual
                        actual = next(f for f in state["fetches"] if (
                            f["body"] == "held" if hold["kind"] == "body" else
                            f["state"] == "pending" and held_key(request_key(f), holds)))
                        steps.hold_events.append({"event": "held", "key": request_key(actual), "virtual_ms": steps.virtual})
                    if steps.virtual - held_since[hold["path"]] < hold["after_ms"]:
                        return False
                    if hold["kind"] == "answer":
                        holds.discard(hold["key"])
                        steps.hold_events.append({"event": "released", "key": hold["key"], "virtual_ms": steps.virtual})
                        return True
                    return bool(run.page.evaluate("key => window.__synLedger.release(key)",
                                                  json.dumps(hold["key"], separators=(",", ":"))))
                # The default schedule ends with the worklist and the inbox read; a held schedule ends when its hold went
                # and the inbox read is done - what the page made of the delay is the comparison's business.
                phase("P3", lambda: inbox_received(run) and (rows_show(run) if not hold else hold["path"] in held_since
                                                               and hold["key"] not in holds), 30000,
                      holds=holds, release=release)
                if hold:
                    self.assertTrue(held_since, f"{schedule}: the schedule's held {hold['kind']} was reached")
                    if hold["kind"] == "answer":
                        assert_inbox_hold(self, raws["P3"])
                self.assertTrue(rows_show(run), "P3: the completed worklist is shown")
            data = after(run) if after else None
            return raws, data, list(run.errors)
        finally:
            run.close()

    def kept(self, case, schedule, layout):
        """Where a comparison keeps its raw sides: <trace dir>/<case>/<schedule>/<layout>/<phase>/."""
        base = ARTIFACTS / re.sub(r"[^A-Za-z0-9]+", "-", case).strip("-") / schedule / layout

        def keeper(side):
            return lambda phase, raw: sh.keep(base / phase, f"{side}.raw.json", raw)
        return base, keeper

    def compare_phases(self, base, original, candidate, what, dispatches=False):
        """Each phase both sides reached: the whole registration order (and, when asked, the dispatch order) - the raw
        sides are already kept; the comparison is kept beside them before it is asserted."""
        self.assertEqual(sorted(original), sorted(candidate), f"{what}: the phases both runs reached")
        for name in original:
            a, b = original[name]["trace"], candidate[name]["trace"]
            def provenance(raw, default):
                source = raw.get("source")
                return sh.Provenance(source["manifest"], source["frozen"]) if source else Pages.provenance(default)
            original_provenance = provenance(original[name], "original")
            candidate_provenance = provenance(candidate[name], "current")
            comparison = {"phase": name}
            try:
                orders = (sh.full_order(a, original_provenance), sh.full_order(b, candidate_provenance))
                comparison.update(registrations=[len(o) for o in orders], difference=sh.order_difference(*orders))
                if dispatches:
                    sent = (sh.dispatch_order(a, original_provenance),
                            sh.dispatch_order(b, candidate_provenance))
                    comparison.update(dispatches=[len(o) for o in sent], dispatch_difference=sh.order_difference(*sent))
                comparison["requests"] = [[(r["method"], r["path"], r["query"]) for r in side[name]["site"]]
                                          for side in (original, candidate)]
            except sh.TraceInfraFailure as failure:
                comparison["infra"] = str(failure)
                sh.keep(base / name, "comparison.json", comparison)
                raise
            sh.keep(base / name, "comparison.json", comparison)
            for side in ("original", "candidate"):
                self.assertTrue((base / name / f"{side}.raw.json").is_file(),
                                f"{what} {name}: actual raw kept before comparison ({side})")
            self.assertEqual([], comparison["difference"], f"{what} {name}: every registration in order")
            if dispatches:
                self.assertEqual([], comparison["dispatch_difference"], f"{what} {name}: every dispatch in order")
            self.assertEqual(*comparison["requests"], f"{what} {name}: the same requests in the same order")
            self.assertEqual(original[name]["virtual_ms"], candidate[name]["virtual_ms"],
                             f"{what} {name}: the same virtual schedule")


# The deterministic runs' fixed answers and schedules.
ME_FAIL = (503, {"code": "AUTH_IDP_UNAVAILABLE"})
INBOX = "/api/critical-results"


def canonical_query(query):
    return tuple(sorted(parse_qsl(query.lstrip("?"), keep_blank_values=True),
                        key=lambda pair: tuple(s.encode("utf-16-be", errors="surrogatepass") for s in pair)))


def request_key(record):
    return (record["method"], record["path"], canonical_query(record["query"]), record.get("occurrence", 1))


def held_key(key, holds):
    return key in holds


ME_KEY = ("GET", "/api/me", (), 1)
INBOX_KEY = ("GET", INBOX, canonical_query("view=received&state=pending"), 1)
STUDIES_KEY = ("GET", "/api/studies", canonical_query("limit=100"), 1)
# Besides answering in arrival order (default): the inbox read's answer, or the worklist read's body, held for a while of
# virtual time once the page asks for it - every other request and timer goes on meanwhile.
SCHEDULES = {"default": None, "inbox-answer-held": {"kind": "answer", "path": INBOX, "key": INBOX_KEY, "after_ms": 500},
             "studies-body-held": {"kind": "body", "path": "/api/studies", "key": STUDIES_KEY, "after_ms": 1500}}
ARTIFACTS = Path(TRACE_DIR) if TRACE_DIR else Path(tempfile.mkdtemp(prefix="kin-pre-raw-"))


def rows_show(run, text=h.PATIENT):
    return text in (run.page.evaluate("(document.querySelector('#rows') || {}).innerText || ''") or "")


def inbox_received(run):
    return (any(request_key(f) == INBOX_KEY and f["state"] == "answered" and f["body"] == "read"
                for f in run.steps.ledger()["fetches"])
            and run.page.locator("#cvr-inbox-badge").inner_text() == "Load Failed")


def assert_inbox_hold(case, raw):
    fetches = raw["ledger"]["fetches"]
    received = [f for f in fetches if request_key(f) == INBOX_KEY]
    case.assertEqual(1, len(received), "inbox: exactly the first received-view request")
    request = received[0]
    release = next(r for r in raw["site"] if request_key(r) == INBOX_KEY)
    arrived = request["at"] - int(CLOCK_START.timestamp() * 1000)
    case.assertGreaterEqual(release["released_at"] - arrived, 500, "inbox: received-view held for 500 virtual ms")
    case.assertEqual(("answered", 404, "read"), (request["state"], request["status"], request["body"]),
                     "inbox: the released received-view failure was consumed")
    case.assertGreaterEqual(request["consumedAt"], request["at"] + 500, "inbox: consumption follows the hold")
    case.assertEqual(["held", "released"], [r["event"] for r in raw["holds"]], "inbox: hold and release both observed")
    case.assertTrue(all(r["key"] == INBOX_KEY for r in raw["holds"]), "inbox: the observed held request is received-view")
    case.assertEqual("Load Failed", raw["inbox_badge"], "inbox: the consumed failure is shown")
    case.assertFalse(any(t["delay"] == 60000 and t["kind"] == "setTimeout" for t in raw["ledger"]["timers"]),
                     "inbox: response deadline cleared after consumption")


# ── TEST-PRE-REGISTRATION ──
class Registration(PreCase):
    OUTCOMES = ("answered", "failed", "failed then retried", "failed, retried and failed again, then retried")
    RETRIED = ("failed then retried", "failed, retried and failed again, then retried")

    def both(self, case, outcome, after=None, schedule="default", reference="original", count="actual", delay_ms=0):
        base, keeper = self.kept(f"{case}-{outcome}", schedule, f"{reference}-{count}-{delay_ms}ms")
        # The incremental reference must keep the landed parent's external-script boundaries.
        layouts = {"original": Pages.layout(reference, "actual" if reference == "previous" else 0),
                   "candidate": Pages.layout("current", count)}
        reached = {"original": {}, "candidate": {}}
        status = {"original": "not_started", "candidate": "not_started"}

        def save(side):
            def receive(phase, raw):
                keeper(side)(phase, raw)
                canonical = raw["phase"]
                reached[side][canonical] = raw["status"]
                if phase != canonical:
                    keeper(side)(canonical, raw)
                sh.keep(base, "phase-status.json", {"sides": status, "phases": reached})
            return receive

        def once(side, layout):
            status[side] = "running"
            sh.keep(base, "phase-status.json", {"sides": status, "phases": reached})
            def following(run):
                try:
                    return after(run) if after else None
                finally:
                    if after:
                        save(side)("after", run.steps.raw("after"))
            result = self.through(layout, outcome, following if after else None, schedule, keep=save(side),
                                  delay_ms=delay_ms if side == "candidate" else 0)
            status[side] = "completed"
            return result

        try:
            original = once("original", layouts["original"])
            candidate = once("candidate", layouts["candidate"])
        except BaseException as failure:
            # A partial phase is not a successful empty trace. Explain every missing peer at the point of failure.
            for side in status:
                if status[side] == "running":
                    status[side] = "failed"
            for phase in set(reached["original"]) | set(reached["candidate"]):
                for side in ("original", "candidate"):
                    if phase not in reached[side]:
                        manifest = layouts[side][1]
                        keeper(side)(phase, {"status": "not_started", "reason": f"{type(failure).__name__}: {failure}",
                                             "phase": phase, "side": side, "schedule": schedule,
                                             "source_sha256": manifest["inputs"][manifest["page"]]["sha256"],
                                             "source": {"manifest": manifest, "side": manifest["side"]}})
            raise
        finally:
            sh.keep(base, "phase-status.json", {"sides": status, "phases": reached})
        return base, original, candidate

    def test_registrations_match_the_original_page_before_and_after_each_session_outcome(self):
        for outcome in self.OUTCOMES:
            with self.subTest(outcome=outcome):
                base, (original, _, original_errors), (candidate, _, errors) = self.both("registrations", outcome)
                self.assertEqual([], errors, "errors")
                self.compare_phases(base, original, candidate, outcome, dispatches=True)
                # Per (target, event), a reader's view of the same thing.
                for name in original:
                    self.assert_same_registrations(sh.by_target_event(original[name]["trace"]["registrations"]),
                                                   sh.by_target_event(candidate[name]["trace"]["registrations"]),
                                                   f"{outcome} {name}: per (target, event), in order")

    def test_repeated_retry_schedules_complete_and_end_as_on_the_original_page(self):
        """F2-I04: P0-P3 of the repeated failure under each schedule, isolated or inside the full suite alike."""
        for schedule in SCHEDULES:
            with self.subTest(schedule=schedule):
                base, (original, _, _), (candidate, _, errors) = self.both(
                    "repeated-retry", "failed, retried and failed again, then retried", schedule=schedule)
                self.assertEqual([], errors, "errors")
                self.assertEqual(["P0", "P1", "P2", "P3"], sorted(candidate), "the phases of the repeated failure")
                self.compare_phases(base, original, candidate, f"repeated failure, {schedule}", dispatches=True)

    def test_hazard_registrations_do_not_depend_on_the_session_answer_and_retry_adds_none(self):
        keys = {(t, e) for hazard in HAZARDS for (t, e, _) in self.keys(hazard)}
        targets = {t for t, _ in keys}
        expected = sh.by_target_event(self.original_trace()[1], keys)
        for outcome in self.OUTCOMES:
            with self.subTest(outcome=outcome):
                _, _, (raws, _, _) = self.both("hazard-registrations", outcome)
                before, after = raws["P0"]["trace"]["registrations"], raws[max(raws)]["trace"]["registrations"]
                on_targets = {(r["target"], r["type"]) for r in after if r["target"] in targets}
                self.assert_same_registrations(expected, sh.by_target_event(before, keys),
                                               f"{outcome}: the hazard registrations exist before the session answer")
                self.assert_same_registrations(sh.by_target_event(before, on_targets), sh.by_target_event(after, on_targets),
                                               f"{outcome}: the hazard targets gain no registration after the session answer")

    def change_after_retry(self, run):
        """P4: one Quick Match change, then a search; nothing in flight after each."""
        steps = run.steps
        since = run.page.evaluate("window.__kinTrace.now()")
        quick_match(run.page)
        steps.rendered("Quick Match rendered")
        steps.drive(lambda: True, "P4 one Quick Match change", 5000)
        trace = run.trace()
        registrations = {r["seq"]: r for r in trace["registrations"]}
        dispatched = [(d["target"], d["type"], registrations[d["registration"]]["listener"])
                      for d in run.trace(since)["dispatches"] if "registration" in d and d["target"] == "#quick-match"]
        run.page.fill("#quick", "PATIENT")
        steps.rendered("search rendered")
        steps.drive(lambda: True, "P4 a search", 5000)
        return dispatched, run.screen()["worklist"], {**steps.raw("P4"), "since": since}

    def test_after_retry_one_quick_match_change_has_one_effect(self):
        for outcome in self.RETRIED:
            with self.subTest(outcome=outcome):
                base, original, candidate = self.both("quick-match-after-retry", outcome, self.change_after_retry)
                sh.keep(base / "P4", "original.raw.json", original[1][2])
                sh.keep(base / "P4", "candidate.raw.json", candidate[1][2])
                self.assertEqual([], candidate[2], "errors")
                self.assertEqual(original[1][0], candidate[1][0], "the listeners one Quick Match change reaches after Retry")
                self.assertEqual(original[1][1], candidate[1][1], "the list, chips and saved-search state after that change")
                self.compare_phases(base, {"P4": original[1][2]}, {"P4": candidate[1][2]}, f"{outcome} P4", dispatches=True)

    def input_order(self, run):
        steps = run.steps
        row = run.page.locator("#rows tr", has_text=h.PATIENT).first
        steps.click_control(row, "study row")
        steps.drive(lambda: run.page.evaluate("KinWorkContext.selection().uid") == h.UID
                    and run.page.locator("#findings").is_editable(),
                    "a study selected", 5000)
        steps.rendered("selected study rendered")
        since = run.page.evaluate("window.__kinTrace.now()")
        steps.click_control(run.page.locator("#findings"), "report field")
        steps.rendered("report field focused")
        self.assertEqual("findings", run.page.evaluate("document.activeElement.id"), "input: report field focused")
        before = run.page.locator("#findings").input_value()
        caret = run.page.locator("#findings").evaluate("el => [el.selectionStart, el.selectionEnd]")
        run.page.keyboard.down("a")
        steps.native_frames()
        run.page.keyboard.up("a")
        steps.rendered("one focus and keypress rendered")
        self.assertEqual(before[:caret[0]] + "a" + before[caret[1]:], run.page.locator("#findings").input_value(),
                         "input: the typed character and surrounding text")
        self.assertEqual([caret[0] + 1] * 2, run.page.locator("#findings").evaluate("el => [el.selectionStart, el.selectionEnd]"),
                         "input: caret after the typed character")
        trace = run.trace()
        registrations = {r["seq"]: r for r in trace["registrations"]}
        reached = [(d["target"], d["type"], registrations[d["registration"]]["listener"])
                   for d in run.trace(since)["dispatches"] if "registration" in d and d["target"] == "#findings"]
        return reached, {**steps.raw("input"), "since": since}

    def test_a_report_field_input_reaches_its_listeners_in_the_original_order(self):
        base, original, candidate = self.both("input-order", "answered", self.input_order)
        sh.keep(base / "input", "original.raw.json", original[1][1])
        sh.keep(base / "input", "candidate.raw.json", candidate[1][1])
        self.assertEqual([], candidate[2])
        self.assertTrue(any(t == "input" for _, t, _ in original[1][0]), "the original reaches input listeners")
        self.assertEqual(original[1][0], candidate[1][0], "the (target, event, listener) invocation order of one focus/keypress")
        # Each invocation's registration as one object of the whole trace, with the stack that registered it.
        self.compare_phases(base, {"input": original[1][1]}, {"input": candidate[1][1]}, "one focus/keypress",
                            dispatches=True)


# ── the trace itself: what the registration comparisons rely on (Astra fix-2 design §1, F2-I01..I03) ──
# A probe page served by the case, its script in a file of its own (`probe.js`) so frames are real script frames.
PROBE_PAGE = "<!doctype html><title>SYN trace</title><body><div id=static-a></div><script src=/probe.js></script>"


class ActualLayout(PreCase):
    both = Registration.both

    def test_approved_pre_and_actual_layout_keep_registration_dispatch_and_schedule(self):
        for delay in (0, 150):
            for outcome in Registration.OUTCOMES:
                schedules = SCHEDULES if outcome == Registration.OUTCOMES[-1] else ("default",)
                for schedule in schedules:
                    with self.subTest(delay=delay, outcome=outcome, schedule=schedule):
                        base, (before, _, before_errors), (after, _, errors) = self.both(
                            "actual-C3", outcome, schedule=schedule, reference="approved", delay_ms=delay)
                        self.assertEqual([], before_errors)
                        self.assertEqual([], errors)
                        self.compare_phases(base, before, after, "approved PRE to actual", dispatches=True)
                        for name in before:
                            self.assertEqual(before[name]["screen"], after[name]["screen"], "same visible result and storage effects")

    def test_previous_parent_and_actual_layout(self):
        base, (before, _, before_errors), (after, _, errors) = self.both(
            "incremental-C3", "answered", reference="previous")
        self.assertEqual([], before_errors)
        self.assertEqual([], errors)
        for phase in before.values():
            self.assertEqual("actual", phase["source"]["kind"], "previous parent is delivered without resplitting")
        self.compare_phases(base, before, after, "previous parent to actual", dispatches=True)

    def test_actual_held_input_and_leaving_boundaries(self):
        layout = Pages.current.layout("actual")
        for hazard, module in (("B1-03", "report-templates-ui.js"), ("B1-05", "worklist-columns-view.js"),
                               ("B1-05-TAB", "worklist-columns-view.js"), ("B1-05", "related-studies.js")):
            if module in layout[1]["parts"]:
                for delay in (0, 150):
                    with self.subTest(hazard=hazard, hold=module, delay=delay):
                        self.assert_like_original(hazard, self.early(hazard, layout, hold=module, delay_ms=delay))
        for module in ("worklist-view.js", "related-studies.js", "clinical-context-panel.js", "saved-filters.js"):
            if module in layout[1]["parts"]:
                with self.subTest(leaving=module):
                    self.assertEqual([], self.leaving(layout, hold=module), "actual held boundary leaves without error")

    def test_delivered_asset_hash_is_bound_to_the_actual_body(self):
        layout = Pages.current.layout("actual")
        name = layout[1]["parts"][0] if layout[1]["parts"] else layout[1]["scripts"][-1]
        run = Run(self, layout, hold=name)
        try:
            run.blocked()
            body = run.delivery.body
            run.delivery.body = lambda requested: body(requested) + (b' ' if requested == name else b'')
            with self.assertRaisesRegex(AssertionError, "delivered asset hash differs"):
                run.delivery.release()
        finally:
            run.close()

    def test_C6_html_ids_have_no_new_duplicates(self):
        context = self.browser.new_context()
        try:
            page = context.new_page()
            def duplicate_ids(html):
                return page.evaluate("""html => {
                  const doc = new DOMParser().parseFromString(html, 'text/html'), counts = {};
                  for (const element of doc.querySelectorAll('[id]')) counts[element.id] = (counts[element.id] || 0) + 1;
                  return Object.entries(counts).filter(([, n]) => n > 1);
                }""", html)
            self.assertEqual(duplicate_ids(Pages.blob_file("approved", "main.html").decode("utf-8")),
                             duplicate_ids(PAGE.read_text(encoding="utf-8")), "C6 HTML duplicate ids")
        finally:
            context.close()

    def test_actual_part2_script_responses_are_complete(self):
        layout = Pages.current.layout("actual")
        self.assertIn("report-draft-save.js", layout[1]["parts"], "PRECONDITION actual part 2 asset")
        run = Run(self, layout, hold="report-draft-save.js")
        responses, failures = [], []
        run.page.on("response", lambda response: responses.append({"url": response.url, "status": response.status}))
        run.page.on("requestfailed", lambda request: failures.append({"url": request.url, "failure": request.failure}))
        try:
            run.blocked()
            run.delivery.release()
            run.wait("document.readyState === 'complete'", "actual asset load completes")
            raw = {"manifest": layout[1], "delivered": run.delivery.bodies, "responses": responses,
                   "failures": failures, "errors": run.errors, "trace": run.trace()}
            sh.keep(ARTIFACTS / "part2-assets", "actual.raw.json", raw)
            name = "report-draft-save.js"
            self.assertEqual([200], [r["status"] for r in responses if urlparse(r["url"]).path.endswith('/' + name)],
                             "actual report-draft-save.js response must arrive")
            self.assertEqual([], failures, "actual script requests must succeed")
            self.assertEqual([], run.errors, "actual scripts execute without errors")
        finally:
            run.close()


class LoadBudget(PreCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chromium", headless=True)

    def sample(self, layout, context):
        context.unroute_all(behavior="wait")
        site = PreSite()
        site.held_me = []
        context.route("**/*", lambda route, request: site.handle(route, request))
        side = layout[1].get("side", "current")
        if side != "current":
            site.historical_file = lambda name: Pages.blob_file(side, name)
        others = (lambda name: Pages.blob_file(side, name)) if side != "current" else None
        delivery = sh.Delivery(*layout, h.BASE, others=others).install(context)
        page = context.new_page()
        page.clock.set_fixed_time(CLOCK_START)
        errors, console_errors, auth = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("request", lambda request: auth.append(time.perf_counter()) if urlparse(request.url).path == "/api/me" else None)
        started = time.perf_counter()
        try:
            page.goto(h.MAIN_URL, wait_until="commit")
            delivery.wait(page, lambda: bool(site.held_me), "uninstrumented first auth")
            answered = time.perf_counter()
            for route in site.held_me:
                site.answer(route, *site.me(site.account))
            site.held_me = None
            delivery.wait(page, lambda: h.PATIENT in page.locator("#rows").inner_text(), "uninstrumented usable list")
            page.locator("#quick").fill(h.PATIENT)
            delivery.wait(page, lambda: page.locator('#rows tr[data-uid]').count() > 0, "usable search")
            usable = time.perf_counter()
            self.assertEqual([], errors, "load budget page errors")
            entries = page.evaluate("performance.getEntriesByType('resource').map(e => ({name:e.name, transferSize:e.transferSize, encodedBodySize:e.encodedBodySize, duration:e.duration}))")
            return {"navigation_to_auth_ms": (auth[0] - started) * 1000,
                    "auth_to_usable_ms": (usable - answered) * 1000, "resources": entries,
                    "script_requests": [name for _, name in delivery.requests],
                    "non_script_requests": [(r['method'], r['path'], r['query']) for r in site.ledger],
                    "console_errors": console_errors, "page_errors": errors,
                    "inputs": delivery.expected, "delivered": delivery.bodies}
        finally:
            delivery.dispose()
            page.close()

    def test_uninstrumented_paired_load_budget(self):
        layouts = {"baseline": Pages.layout("approved", 0), "candidate": Pages.layout("current", "actual")}
        result = {"cache": "Playwright routing disables HTTP cache; repeat samples are not warm-cache evidence",
                  "warm_status": "not_run: requires hosted HTTP origin", "cold": [], "repeat_cache_disabled": []}
        try:
            for mode in ("cold", "repeat_cache_disabled"):
                contexts = {}
                try:
                    for index in range(5):
                        pair = {}
                        for side in (("baseline", "candidate") if index % 2 == 0 else ("candidate", "baseline")):
                            if mode == "cold" or side not in contexts:
                                contexts[side] = self.browser.new_context(viewport={"width": 1400, "height": 900},
                                    locale="ko-KR", timezone_id="Asia/Seoul")
                            pair[side] = self.sample(layouts[side], contexts[side])
                            if mode == "cold":
                                contexts.pop(side).close()
                        result[mode].append(pair)
                        self.assertEqual(Counter(pair["baseline"]["console_errors"]), Counter(pair["candidate"]["console_errors"]),
                                         "load budget adds no console errors")
                        self.assertEqual(Counter(pair["baseline"]["non_script_requests"]), Counter(pair["candidate"]["non_script_requests"]),
                                         "load budget adds no non-script requests")
                finally:
                    for context in contexts.values():
                        context.close()
            result["budgets"] = {}
            for metric in ("navigation_to_auth_ms", "auth_to_usable_ms"):
                before = [p["baseline"][metric] for p in result["cold"]]
                after = [p["candidate"][metric] for p in result["cold"]]
                limit = max(250, statistics.median(before) * .10)
                delta = statistics.median(after) - statistics.median(before)
                result["budgets"][metric] = {"baseline_median": statistics.median(before), "candidate_median": statistics.median(after),
                    "baseline_max": max(before), "candidate_max": max(after), "delta": delta, "limit": limit}
                self.assertLessEqual(delta, limit, metric + " cold load regression budget")
        finally:
            sh.keep(ARTIFACTS / "load-budget", "samples.json", result)


class TraceOracle(PreCase):
    def probe(self, body, instrument=True, setup="", args=None):
        """Runs `body` (the text of a function of `args`) as probe.js on a page of its own; returns its result and the
        trace."""
        context = self.browser.new_context()
        try:
            script = "window.__probe = (" + body + ")(" + json.dumps(args) + ");"
            context.route("**/probe.js", lambda route: route.fulfill(body=script, content_type="text/javascript"))
            context.route("**/trace.html", lambda route: route.fulfill(body=PROBE_PAGE, content_type="text/html"))
            if instrument:
                context.add_init_script(sh.TRACE_SCRIPT)
            if setup:
                context.add_init_script(setup)
            page = context.new_page()
            page.goto("https://syn.test/trace.html")
            result = page.evaluate("window.__probe")
            trace = sh.snapshot(page) if instrument else None
            return result, trace
        finally:
            context.close()

    # F2-I01 / C01: two objects of one creation site, both made before anything is registered; the registrations of the
    # same helper in one order or the other are different whole orders.
    ORDER = """order => {
      const make = () => { const b = document.createElement('button'); b.id = 'recreated'; document.body.append(b); return b; };
      const first = make(), second = make();
      first.remove();
      const calls = [];
      const callback = function (event) { calls.push(event.currentTarget === first ? 'first' : 'second'); };
      const targets = { first, second };
      const register = target => target.addEventListener('click', callback);
      for (const name of order) register(targets[name]);
      for (const name of order) targets[name].dispatchEvent(new Event('click'));
      return calls;
    }"""

    def test_objects_are_named_by_creation_and_a_swapped_registration_order_differs(self):
        provenance = sh.Provenance({"statements": []}, [])
        runs = [self.probe(self.ORDER, args=order) for order in (["first", "second"], ["first", "second"])]
        reversed_run = self.probe(self.ORDER, args=["second", "first"])
        orders = [sh.full_order(trace, provenance) for _, trace in (*runs, reversed_run)]
        self.assertEqual(["first", "second"], runs[0][0])
        self.assertEqual(orders[0], orders[1], "the same probe gives the same whole order")
        keys = [o[1] for o in orders[0]]
        self.assertEqual(2, len(set(keys)), "two elements with one id from one site are two objects")
        self.assertNotEqual([], sh.order_difference(orders[0], orders[2]), "a swapped registration order is a difference")
        self.assertNotEqual(sh.dispatch_order(runs[0][1], provenance), sh.dispatch_order(reversed_run[1], provenance),
                            "a swapped dispatch order is a difference")

    # F2-I02 / C02: the same object keeps its name through a new id, removal and reinsertion; a clone is another object;
    # a controller's signal belongs to its controller; nothing a page script registers on is left unnamed.
    LIFETIME = """() => {
      const el = document.createElement('div');
      document.body.append(el);
      const out = [];
      el.addEventListener('focus', () => {});
      el.id = 'renamed'; el.remove(); document.body.append(el);
      el.addEventListener('blur', () => {});
      const copy = el.cloneNode(true); copy.addEventListener('focus', () => {});
      const one = new AbortController(), two = new AbortController();
      one.signal.addEventListener('abort', () => out.push('one'));
      two.signal.addEventListener('abort', () => out.push('two'));
      document.getElementById('static-a').addEventListener('click', () => {});
      two.abort();
      return out;
    }"""

    def test_object_lifetime_signals_and_coverage(self):
        provenance = sh.Provenance({"statements": []}, [])
        result, trace = self.probe(self.LIFETIME)
        order = sh.full_order(trace, provenance)
        self.assertEqual(["two"], result, "only the aborted controller's signal listener ran")
        self.assertEqual(order[0][1], order[1][1], "the same element through a new id, removal and reinsertion")
        self.assertNotEqual(order[0][1], order[2][1], "a clone is another object")
        one, two = order[3][1], order[4][1]
        self.assertNotEqual(one, two, "two controllers' signals are two objects")
        self.assertTrue(one[-1] and two[-1] and one[-1] != two[-1] and one[-1][1] == "AbortController",
                        "each signal belongs to its own controller")
        self.assertEqual("parsed", order[5][1][0], "the markup's element is named by the parser order")
        self.assertEqual([], trace["unresolved"])
        # The page's own markup: every element numbered in parser order, the same as the markup itself, in each layout.
        for name, layout in (("original", Pages.original.layout(0)), ("unsplit", Pages.current.layout(0)),
                             ("45 parts", Pages.current.layout(45))):
            with self.subTest(layout=name):
                run = Run(self, layout, filters=(SAVED,), local_filters=True)
                try:
                    run.booted()
                    parsed = run.page.evaluate("window.__kinTrace.parsed()")
                    markup = run.page.evaluate("""async () => {
                      const text = await (await fetch(location.href)).text();
                      const doc = new DOMParser().parseFromString(text, 'text/html');
                      return [...doc.querySelectorAll('*')].filter(e => e.localName !== 'script').map(e => e.localName); }""")
                    self.assertEqual(markup, parsed, "parser order = the markup's elements")
                    self.assertEqual([], run.trace()["unresolved"], "every registration target has a creation record")
                finally:
                    run.close()

    # F2-I03 / C03: the instrument changes nothing the page sees.
    SEMANTICS = """() => {
      const out = [], el = document.createElement('button');
      document.body.append(el);
      const fn = function (event) { out.push(['fn', this === el, event.eventPhase]); };
      const object = { handleEvent(event) { out.push(['object', this === object]); } };
      el.addEventListener('click', fn); el.addEventListener('click', fn);
      el.addEventListener('click', object, { once: true });
      el.addEventListener('click', fn, { capture: true });
      el.addEventListener('wheel', () => out.push(['passive', true]), { passive: true });
      const controller = new AbortController();
      el.addEventListener('click', () => out.push(['signal']), { signal: controller.signal });
      el.dispatchEvent(new Event('click')); el.dispatchEvent(new Event('click'));
      controller.abort(); el.removeEventListener('click', fn);
      el.dispatchEvent(new Event('click'));
      el.removeEventListener('click', fn, true);
      el.dispatchEvent(new Event('click'));
      el.onclick = () => out.push(['on', 1]); el.onclick = () => out.push(['on', 2]);
      el.dispatchEvent(new Event('click'));
      el.onclick = null;
      el.dispatchEvent(new Event('click'));
      el.dispatchEvent(new WheelEvent('wheel'));
      return out;
    }"""

    def test_the_instrument_keeps_listener_semantics(self):
        native, _ = self.probe(self.SEMANTICS, instrument=False)
        traced, trace = self.probe(self.SEMANTICS)
        self.assertEqual(native, traced, "this, handleEvent, removal, repeated registration, once, capture, passive, "
                                         "signal and on* replacement as without the instrument")
        self.assertTrue(native, "the probe ran")


# ── harness self-checks (F2-I05, F2-I06) ──
class HarnessSelfChecks(PreCase):
    SENTINEL = {"id": "SYN-SENTINEL", "name": "SYN Sentinel Search", "quick": "SENTINEL", "days": -1, "mode": "Radiology",
                "cols": {}, "sortKey": None, "sortDir": 0, "isDefault": False}

    def test_request_occurrences_release_the_exact_request_and_canonical_query(self):
        run = Run(self, Pages.current.layout("actual"))
        try:
            run.booted()
            run.site.hold_all = True
            steps = Steps(run)
            # Duplicate values and spelling/order variants share identity, but keep separate occurrences.
            run.page.evaluate("""() => {
              window.__occurrenceAnswers = [];
              for (const [i, query] of ['a=2&a=1&b=', 'b=&a=1&a=2'].entries())
                fetch('/api/prefs?' + query).then(() => window.__occurrenceAnswers.push(i));
            }""")
            run.wait(lambda: len(run.site.waiting) == 2, "two identical request identities held")
            rows = [run.site.request_rows[request] for _, request in run.site.waiting]
            self.assertEqual(rows[0]["key"][:3], rows[1]["key"][:3])
            self.assertEqual([1, 2], [row["occurrence"] for row in rows])
            steps.virtual = 21
            run.site.release(1)
            run.wait(lambda: run.page.evaluate("window.__occurrenceAnswers.length") == 1, "second request answered")
            self.assertNotIn("released_at", rows[0], "occurrence 1 must remain held")
            self.assertEqual(21, rows[1]["released_at"], "occurrence 2 owns its release time")
            steps.virtual = 34
            run.site.release(0)
            run.wait(lambda: run.page.evaluate("window.__occurrenceAnswers.length") == 2, "first request answered")
            self.assertEqual([1, 0], run.page.evaluate("window.__occurrenceAnswers"))
            self.assertEqual([34, 21], [row["released_at"] for row in rows])
        finally:
            run.close()
        observed, _ = TraceOracle.probe(self, """async () => {
          await Promise.all(['a=2&a=1&b=', 'b=&a=1&a=2'].map(q => fetch('data:text/plain,?' + q)));
          return window.__synLedger.state().fetches;
        }""", setup=sh.LEDGER_SCRIPT)
        self.assertEqual([1, 2], [row["occurrence"] for row in observed], "page ledger shares request occurrences")
        self.assertEqual([list(pair) for pair in canonical_query('b=&a=1&a=2')], observed[0]["canonicalQuery"])
        self.assertEqual(observed[0]["canonicalQuery"], observed[1]["canonicalQuery"])

    def render_dispatch_counterexamples(self, event):
        body = TraceOracle.ORDER.replace("'click'", repr(event)).replace(
            "for (const name of order) register(targets[name]);",
            "for (const name of ['first', 'second']) register(targets[name]);")
        records = []
        for order in (["first", "second"], ["first"], ["first", "second", "first"], ["second", "first"]):
            _, trace = TraceOracle.probe(self, body, args=order)
            records.append({"trace": trace, "since": max(d["seq"] for d in trace["dispatches"]),
                            "site": [], "virtual_ms": 0})
        for label, changed in zip(("missing", "extra", "reversed"), records[1:]):
            base, keeper = self.kept(event + "-" + label, "default", "probe")
            for side, raw in zip(("original", "candidate"), (records[0], changed)):
                keeper(side)("input", raw)
            with self.assertRaisesRegex(AssertionError, "every dispatch in order"):
                self.compare_phases(base, {"input": records[0]}, {"input": changed}, event + label, dispatches=True)

    def test_scroll_dispatch_is_compared_before_the_mark(self):
        self.render_dispatch_counterexamples("scroll")

    def test_resize_dispatch_is_compared_before_the_mark(self):
        self.render_dispatch_counterexamples("resize")

    def test_only_the_eleven_motion_crossing_dispatch_types_are_excluded(self):
        included = ["click", "input", "keydown", "focus", "scroll", "resize"]
        _, trace = TraceOracle.probe(self, """types => {
          const target = new EventTarget();
          for (const type of types) target.addEventListener(type, () => {});
          for (const type of types) target.dispatchEvent(new Event(type));
        }""", args=[*sh.NOISY_EVENTS, *included])
        self.assertEqual(list(sh.NOISY_EVENTS), trace["excluded_dispatch_types"], "exact eleven dispatch exclusions")
        self.assertEqual([*sh.NOISY_EVENTS, *included], [r["type"] for r in trace["registrations"]])
        self.assertEqual(included, [d["type"] for d in trace["dispatches"]], "click and render events stay observable")

    def test_each_run_starts_from_its_own_fixture(self):
        """F2-I05 / C05: a run that left an account change, held answers and a held session check behind does not
        reach the next run's start."""
        first = Run(self, Pages.current.layout(0), auth="wait", filters=(SAVED,))
        first.auth_waits()
        first.site.filters.append(dict(self.SENTINEL))
        first.site.hold_writes.add("filter-delete")
        first.site.me_answers = [ME_FAIL] * 9
        first.close()
        second = Run(self, Pages.current.layout(0), filters=(SAVED,))
        try:
            self.assertEqual([SAVED["name"]], [f["name"] for f in second.site.filters], "the second run's account model")
            self.assertEqual((set(), [], []), (second.site.hold_writes, second.site.me_answers, second.site.waiting),
                             "the second run's holds and queues")
            second.booted()
            chips = second.page.evaluate("(document.querySelector('#chips') || {}).textContent || ''")
            self.assertNotIn("Sentinel", chips, "the second page shows nothing of the first run's account")
        finally:
            second.close()

    def test_raw_sides_are_kept_before_a_failed_comparison(self):
        """F2-I06 / C06: a parent runs real failing browser phases/comparisons in a child and inspects disk at failure.
        A hand-written trace cannot prove that through() used its raw keeper."""
        for fault in ("comparison", "original-P0", "original-P3", "candidate-P0", "candidate-P3"):
            with self.subTest(fault=fault):
                with tempfile.TemporaryDirectory(prefix="kin-pre-failure-child-") as directory:
                    environment = dict(os.environ, KIN_PRE_FAILURE_CHILD=fault, KIN_PRE_TRACE_DIR=directory)
                    child = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "FailureChild.test_failure"],
                                           cwd=ROOT, env=environment, capture_output=True, text=True,
                                           encoding="utf-8", errors="replace", timeout=180)
                    checkpoint = Path(directory) / "failure-time-files.json"
                    sh.keep(ARTIFACTS / "failure-children", fault + ".json",
                            {"exit": child.returncode, "stdout": child.stdout, "stderr": child.stderr,
                             "files": {str(p.relative_to(directory)): json.loads(p.read_text(encoding="utf-8"))
                                       for p in Path(directory).rglob("*.json")}})
                    self.assertEqual(1, child.returncode, "failure child must fail, never silently succeed")
                    self.assertTrue(checkpoint.is_file(), "failure child reached the intended phase/comparison")
                    observed = json.loads(checkpoint.read_text(encoding="utf-8"))
                    expected = "every dispatch in order" if fault == "comparison" else "host time"
                    # Missing evidence is a failure of this parent, even when the child rejected it first.
                    self.assertTrue(observed["raw_files"], "actual raw kept before failing child assertion")
                    self.assertIn(expected, observed["failure"], "failure child reached its named assertion")
                    phases = {}
                    for name, record in observed["raw_files"].items():
                        phase, side = Path(name).parent.name, Path(name).name.split(".")[0]
                        phases.setdefault(phase, {})[side] = record
                    wanted = "after" if fault == "comparison" else fault.split("-")[1]
                    self.assertIn(wanted, phases, "actual raw kept before failing child assertion")
                    for phase, sides in phases.items():
                        if phase.endswith("-partial"):
                            self.assertEqual("failed", next(iter(sides.values()))["status"])
                            continue
                        self.assertEqual({"original", "candidate"}, set(sides),
                                         "actual raw kept before failing child assertion: both sides or explicit not_run")
                        for side, raw in sides.items():
                            if raw.get("status") == "not_started":
                                self.assertTrue(raw.get("reason"), "not_run explains the stopping failure")
                                self.assertEqual("candidate", side, "only the unstarted peer is not_run")
                                self.assertEqual(Pages.current.layout("actual")[1]["inputs"][PAGE.name]["sha256"],
                                                 raw["source_sha256"], "unstarted side's own source hash")
                            else:
                                self.assertTrue(raw["trace"]["registrations"], "real browser trace, not a fabricated empty success")
                                self.assertTrue(raw["source"]["sha256"] and raw["source"]["manifest"] and raw["source"]["frozen"])
                                expected_hash = hashlib.sha256(Pages.baseline_file("main.html") if side == "original"
                                                               else PAGE.read_bytes()).hexdigest()
                                self.assertEqual(expected_hash, raw["source"]["sha256"], "each side's own source hash")
                    if fault == "comparison":
                        self.assertTrue(observed["comparisons"], "comparison.json kept before the assertion")
                        self.assertTrue(any(c.get("dispatch_difference") for c in observed["comparisons"].values()))
                    else:
                        failed_side = fault.split("-")[0]
                        self.assertEqual("failed", phases[wanted][failed_side]["status"], "timeout keeps failed canonical phase")
                        peer = "candidate" if failed_side == "original" else "original"
                        self.assertEqual("not_started" if failed_side == "original" else "completed",
                                         phases[wanted][peer]["status"], "completed peer raw is never overwritten")

    def test_saved_rows_preserve_order_duplicates_extras_and_shown_count(self):
        run = Run(self, Pages.current.layout(0), filters=(SEARCH_S,), rows=FILTER_ROWS)
        try:
            run.booted()
            before = apply_chip(run, SEARCH_S["name"])
            self.assertEqual(expected_rows(h.UID, h.UID_B, UID_C), before["rows"], "ordered studies, actual rows and shown count")
            html = run.page.locator("#rows").inner_html()
            count = run.page.locator("#page-status").inner_text()
            mutations = {
                "duplicate": "rows.append(rows.firstElementChild.cloneNode(true));",
                "extra": "const extra=rows.firstElementChild.cloneNode(true); extra.dataset.uid='SYN-EXTRA'; rows.append(extra);",
                "swapped": "rows.prepend(rows.lastElementChild);",
                "shown": "document.getElementById('page-status').textContent='불러온 목록 중 1–4 / 3건 · 1/1페이지';",
                "total": "document.getElementById('page-status').textContent='불러온 목록 중 1–3 / 4건 · 1/1페이지';",
            }
            for name, mutation in mutations.items():
                with self.subTest(mutation=name):
                    run.page.evaluate("html => document.getElementById('rows').innerHTML=html", html)
                    run.page.locator("#page-status").evaluate("(el, text) => el.textContent=text", count)
                    run.page.evaluate("() => { const rows=document.getElementById('rows'); " + mutation + " }")
                    after = saved_state(run)["rows"]
                    if name in ("shown", "total"):
                        other = "total" if name == "shown" else "shown"
                        self.assertEqual(before["rows"][other], after[other], "independent shown/total counterexample")
                    self.assertNotEqual(before["rows"], after,
                                        "ordered studies, actual rows and shown count detect " + name)
        finally:
            run.close()

    def test_full_dispatch_includes_events_before_the_action_mark(self):
        raw = []
        for order in (["first", "second"], ["second", "first"]):
            _, trace = TraceOracle.probe(self, TraceOracle.ORDER.replace(
                "for (const name of order) register(targets[name]);",
                "for (const name of ['first', 'second']) register(targets[name]);"), args=order)
            raw.append({"trace": trace, "since": max(d["seq"] for d in trace["dispatches"]), "site": [], "virtual_ms": 0})
        base, keeper = self.kept("full-dispatch-counterexample", "default", "probe")
        for side, record in zip(("original", "candidate"), raw):
            keeper(side)("input", record)
        with self.assertRaisesRegex(AssertionError, "every dispatch in order"):
            self.compare_phases(base, {"input": raw[0]}, {"input": raw[1]}, "pre-mark event reversal", dispatches=True)


# What a person is left with after a scenario (screen, text, cursor, what is open, what was kept): ids are locators
# only. Storage writes are named by their key family (a key's own suffix - a session or tab id - aside).
OBSERVE = """() => {
  const el = id => document.getElementById(id);
  const shown = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const text = id => { const node = el(id); return node && shown(node) ? node.innerText : null; };
  const value = id => el(id) ? el(id).value : null;
  const active = document.activeElement;
  let signedIn = null, state = null, selection = null;
  try { signedIn = typeof KinAuth === 'undefined' ? null : !!KinAuth.session(); } catch (e) { signedIn = 'threw'; }
  try { state = typeof KinWorkContext === 'undefined' ? null : KinWorkContext.state(); } catch (e) { state = 'threw'; }
  try { selection = typeof KinWorkContext === 'undefined' ? null : KinWorkContext.selection(); } catch (e) { selection = 'threw'; }
  return {
    page: location.pathname.split('/').pop(),
    focus: active && active !== document.body ? (active.id || active.localName) : null,
    caret: active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null,
    fields: { findings: value('findings'), conclusion: value('conclusion'), recommendation: value('recommendation') },
    open: [...document.querySelectorAll('.modal, dialog, [role=dialog]')].filter(shown).map(n => n.id || n.localName),
    preview: text('tpl-preview'), dictation: text('dictation-pane'), err: text('err'), notice: text('msg'),
    worklist: { quick: value('quick'), match: value('quick-match'), size: value('page-size'),
                chips: el('chips') ? el('chips').textContent : null,
                saved: text('active-filter-info'), rows: text('rows') },
    toasts: (window.__kinToasts || []).slice(),
    kept: [...new Set((window.__synWrites || []).map(w => w[0] + ' ' + w[1] + ' ' + w[2].split(':')[0]))].sort(),
    signedIn, state, selection,
  };
}"""


# ── window and session events at held boundaries: nothing fails in a gap, and the end is the original's ──
class WindowAndSessionEvents(PreCase):
    END = {"session": "SYN-SESSION-1", "operation": 9999999999999, "status": "confirmed", "origin": "logout"}

    def events_and_end(self, layout, hold=None, auth="answer"):
        """Timers, a resize, another tab in front and back, then that tab ends this browser's session (SYN-SESSION-1
        is the session the page's own check answers with). Afterwards the page finishes loading; what the person is
        left with - closed or not, the screen, the fields, what was kept - is the result."""
        run = Run(self, layout, hold=hold, auth=auth)
        if hold:
            run.blocked()
        else:
            run.auth_waits()
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
        early_errors = list(run.errors)
        run.delivery.release()
        if auth == "wait":
            run.answer_auth()
        run.quiet(still_ms=1500, limit_s=30)                 # the page closes and lands, or enters
        return early_errors, {"result": run.observe(), "errors": list(run.errors), "dialogs": list(run.dialogs),
                              "logouts": len(run.site.logouts)}

    def test_window_and_session_events_at_held_boundaries_end_as_on_the_original_page(self):
        references = {"pre": self.events_and_end(Pages.original.layout(0),
                                                 hold=Pages.original.layout(0)[1]["scripts"][-1])[1],
                      "post": self.events_and_end(Pages.original.layout(0), auth="wait")[1]}
        for moment, reference in references.items():
            self.assertEqual([], reference["errors"], f"the original page at its {moment} moment")
        if TRACE_DIR:
            Path(TRACE_DIR).mkdir(parents=True, exist_ok=True)
            (Path(TRACE_DIR) / "scenario-session-end-at-held-boundaries.json").write_text(
                json.dumps(references, ensure_ascii=False, indent=1), encoding="utf-8")
        layout = Pages.current.layout(45)
        modules = sorted({MODULE[f] for f in ("report-templates-ui.js", "worklist-columns-view.js", "sr-reader.js",
                                              "report-editor.js", "work-exit.js", "clinical-context-panel.js",
                                              "worklist-controls.js", "saved-filters.js", "page-boot.js")})
        for module in modules:
            with self.subTest(held=layout[1]["parts"][module]):
                early_errors, seen = self.events_and_end(layout, hold=layout[1]["parts"][module])
                self.assertEqual([], early_errors, "errors in the gap")
                if seen not in references.values():
                    nearest = min(references, key=lambda m: sum(references[m][k] != seen[k] for k in seen))
                    self.assertEqual(references[nearest], seen,
                                     f"the end is neither the original's at pre nor at post (compared with {nearest})")


# ── after the session answer: the same gestures end as on the ORIGINAL page ──
# The server's templates in the bootstrap (synthetic).
TEMPLATES = ({"title": "SYN Chest Template", "shortcut": "syct", "modality": "CT",
              "findings": "SYN template findings line.", "conclusion": "SYN template conclusion."},)
# Chromium cannot answer an intercepted AudioWorklet module request (addModule fails with "Unable to load a worklet's
# module" whenever the context routes requests), so the module's own bytes - fetched through the same synthetic
# origin - are handed to addModule as a blob. The page's code and the worklet's code are unchanged.
WORKLET_FROM_BLOB = """(() => { if (typeof AudioWorklet === 'undefined') return;
  const add = AudioWorklet.prototype.addModule;
  AudioWorklet.prototype.addModule = async function (url, options) {
    const text = await (await fetch(new URL(url, document.baseURI).href, { cache: 'no-store' })).text();
    return add.call(this, URL.createObjectURL(new Blob([text], { type: 'text/javascript' })), options);
  }; })();"""


class SameGestures(PreCase):
    """One gesture script on the ORIGINAL page and on the page under test - unsplit, and its 45-part copy with every
    part delivered at once - with the same synthetic server state. Each side's result is kept, then checked on its own
    against the requirement (`check`: what a person must see), then compared with the original's."""
    COUNTS = (0, 45, "actual")

    def compare(self, scenario, what, counts=COUNTS, check=None, **options):
        base = ARTIFACTS / "scenarios" / re.sub(r"[^A-Za-z0-9]+", "-", what).strip("-")

        def once(layout, side):
            run = Run(self, layout, **options)
            try:
                result = scenario(run)
            finally:
                run.close()
            sh.keep(base, f"{side}.json", result)
            return result
        original = once(Pages.original.layout(0), "original")
        if check:
            check(original, "the original page")
        for count in counts:
            side = f"{count} parts" if count else "unsplit"
            with self.subTest(layout=side):
                observed = once(Pages.current.layout(count), "candidate-" + side.replace(" ", "-"))
                if check:
                    check(observed, f"the page under test ({side})")
                self.assertEqual(original, observed, f"{what}: as on the original page")
        return original


# Saved searches over a list whose patient search results are fixed in advance: "ALPHA" matches 3 names by Contains,
# 2 by Starts With, 1 by Exact (patient ids never contain it).
UID_C = "1.2.826.0.1.3680043.10.7707.3"
FILTER_ROWS = ((h.UID, "ALPHA", "SYN-P-101"), (h.UID_B, "ALPHA SYN", "SYN-P-102"), (UID_C, h.PATIENT, "SYN-P-103"))
NAMES = {name for _, name, _ in FILTER_ROWS}


def saved_search(identity, name, quick, **more):
    return {"id": identity, "name": name, "quick": quick, "days": -1, "mode": "Radiology", "cols": {}, "sortKey": None,
            "sortDir": 0, "isDefault": False, **more}


SEARCH_S = saved_search("SYN-FILTER-S", "SYN Search S", "ALPHA")
SEARCH_R = saved_search("SYN-FILTER-R", "SYN Search R", "ALPHA SYN")
SEARCH_R2 = saved_search("SYN-FILTER-R2", "SYN Search R2", "SYN PATIENT")       # only in the recovered list
BAD_MODE = saved_search("SYN-FILTER-BM", "SYN Bad Mode", "", mode="Nope")
BAD_COMPOUND = saved_search("SYN-FILTER-BC", "SYN Bad Compound", "", cols={"$compound": {"version": 1, "join": "xor",
                                                                                        "rules": []}})
# The template the edit cases open: every field distinct, findings over several lines and in Korean.
EDITED = {"id": "SYN-TPL-EDIT", "title": "SYN 흉부 상용구", "shortcut": "synchest", "modality": "CT", "bodypart": "CHEST",
          "findings": "SYN 첫 줄 소견.\nSYN 둘째 줄 소견.", "conclusion": "SYN 결론 문장.", "recommendation": "SYN 권고 문장.",
          "ord": 7}
EDIT_TITLE, EDIT_FINDINGS = "SYN 흉부 상용구 수정", "SYN 수정한 첫 줄.\nSYN 수정한 둘째 줄.\nSYN 셋째 줄."
FIELDS_OF_TEMPLATE = (("t", "title"), ("s", "shortcut"), ("m", "modality"), ("b", "bodypart"), ("f", "findings"),
                      ("c", "conclusion"), ("r", "recommendation"))
SAVED_STATE = """() => {
  const el = id => document.getElementById(id);
  const shown = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const info = el('active-filter-info');
  return {
    open: shown(document.querySelector('#toolbar-filters .toolbar-menu-panel')),
    name: shown(info) ? el('active-filter-name').textContent : null,
    state: shown(info) ? el('active-filter-state').textContent : null,
    edit_enabled: shown(info) ? !el('edit-active-filter').disabled : null,
    chips: [...document.querySelectorAll('#chips button[data-i]')].filter(shown).map(b => b.dataset.name),
    quick: el('quick').value, match: el('quick-match').value,
    rows: { uids: [...document.querySelectorAll('#rows tr')].map(tr => tr.dataset.uid || null),
      row_count: document.querySelectorAll('#rows tr').length, shown_text: el('page-status').innerText },
    toasts: (window.__kinToasts || []).slice(),
  };
}"""


def until(run, predicate, timeout=20.0):
    """Waits for `predicate`; False when it did not happen (the scenario records it, the check judges it)."""
    try:
        run.wait(predicate, "scenario step", timeout)
        return True
    except AssertionError:
        return False


def expected_rows(*uids):
    return {"uids": list(uids), "row_count": len(uids), "shown": len(uids), "total": len(uids)}


def saved_state(run):
    state = run.page.evaluate(SAVED_STATE)
    shown = re.search(r"(\d+)–(\d+) / (\d+)건", state["rows"].pop("shown_text"))
    state["rows"]["shown"] = int(shown.group(2)) - int(shown.group(1)) + 1 if shown and int(shown.group(1)) else 0
    state["rows"]["total"] = int(shown.group(3)) if shown else None
    return state


def filters_open(run):
    """The Filters panel open on screen: a person's click on its summary when it is closed."""
    if not run.page.evaluate("() => document.querySelector('#toolbar-filters').open"):
        run.page.locator("#toolbar-filters > summary").click()
    until(run, lambda: run.page.locator("#toolbar-filters .toolbar-menu-panel").is_visible(), 5)


def apply_chip(run, name):
    filters_open(run)
    chip = run.page.locator("#chips button[data-i]", has_text=name)
    if chip.count():                                         # (no such chip: the state shows it, the check judges it)
        chip.first.click()
    run.settle(300)
    filters_open(run)
    return saved_state(run)


class AfterAuthScenarios(SameGestures):
    """TEST-PRE-EARLY-05 and TEST-PRE-EARLY-58 results after the session answer (Astra fix-2 design §3)."""

    # TEST-PRE-EARLY-05: a template viewed, inserted and viewed again, its preview left open, then Log out.
    def end_with_open_preview(self, run):
        run.booted()
        select_study(run.page)
        page = run.page
        page.click("#findings")
        page.keyboard.type("SYN typed before the template ")
        view = page.locator("#tplrows [data-tpl-preview]")
        run.wait(lambda: view.count() > 0, "the template list offers View")
        view.first.click()
        insert = page.locator("#tpl-preview-insert")
        inserted = insert.is_visible() and insert.is_enabled()
        if inserted:
            insert.click()
        run.settle(300)
        after_insert = run.observe()
        view.first.click()                                   # the preview open again, and left open
        run.settle(300)
        before = run.observe()
        run.site.logout_answers = ["hold"]
        page.evaluate("() => document.querySelector('#logout').click()")
        run.wait(lambda: run.site.held_logouts, "the logout request")
        closed = run.observe()
        route = run.site.held_logouts.pop(0)
        run.site.ended.add(run.site.logouts[-1][1])
        run.site.answer(route, 204, None)
        page.wait_for_url(h.INDEX_URL)
        run.quiet()
        return {"inserted": inserted, "after_insert": after_insert, "before": before, "closed": closed,
                "landing": run.observe(), "drafts": [{k: p.get(k) for k in FIELDS} for p in run.site.puts],
                "stored": run.site.stored(), "logouts": len(run.site.logouts), "errors": list(run.errors),
                "dialogs": list(run.dialogs)}

    def test_template_insert_then_log_out_with_the_preview_open_ends_as_on_the_original_page(self):
        def check(result, side):
            self.assertTrue(result["inserted"], f"{side}: Insert is offered for the viewed template")
            self.assertIn("SYN template findings line.", result["after_insert"]["fields"]["findings"] or "",
                          f"{side}: the inserted template is in the report")
            self.assertIsNotNone(result["before"]["preview"], f"{side}: the preview is open when Log out is pressed")
            for field in FIELDS:
                self.assertNotIn("SYN", result["closed"]["fields"][field] or "", f"{side}: the closed page keeps no report text")
            self.assertEqual("index.html", result["landing"]["page"], f"{side}: the landing")
        self.compare(self.end_with_open_preview, "template insert, preview open, Log out", templates=TEMPLATES, check=check)

    # F2-I07/I08 (C07, C08): the row's own menu opens the editor on the template; an edit is saved once, kept by the
    # server, shown again everywhere, and inserted as edited.
    def edit_template(self, run):
        page, site = run.page, run.site
        run.booted()
        page.locator("#rows tr", has_text=h.PATIENT).first.click()
        until(run, lambda: page.locator("#findings").is_editable(), 10)
        run.settle(300)
        out = {"report_before": run.observe()["fields"]}
        row = page.locator("#tplrows tr", has_text=EDITED["title"])
        until(run, lambda: row.count() == 1, 10)
        row.first.click(button="right")
        menu = page.get_by_role("menuitem", name="수정", exact=True)
        until(run, lambda: menu.is_visible(), 5)
        menu.click()
        editor = page.locator("#tplmodal")
        until(run, lambda: editor.is_visible(), 5)
        read_editor = lambda: {key: page.locator("#tpl-" + short).input_value() for short, key in FIELDS_OF_TEMPLATE}  # noqa: E731
        out["editor"] = {"visible": editor.is_visible(), "fields": read_editor(),
                         "focus": page.evaluate("() => document.activeElement && document.activeElement.id")}
        out["report_after_edit_opened"] = run.observe()["fields"]
        if not out["editor"]["visible"]:
            out["errors"], out["dialogs"] = list(run.errors), list(run.dialogs)
            return out
        # The edit, its save held: the editor keeps it, a second press sends nothing more.
        page.fill("#tpl-t", EDIT_TITLE)
        page.fill("#tpl-f", EDIT_FINDINGS)
        site.hold_writes.add("template-post")
        page.click("#tpl-save")
        until(run, lambda: site.held_writes, 10)
        if editor.is_visible():
            page.locator("#tpl-save").click(force=True)
        run.settle(300)
        out["while_saving"] = {"visible": editor.is_visible(), "fields": read_editor(), "posts": len(site.template_posts)}
        prefs_before = sum(1 for item in site.ledger if item["path"] == "/api/prefs")
        if site.held_writes:
            site.finish_write()
        until(run, lambda: not editor.is_visible(), 10)
        until(run, lambda: sum(1 for item in site.ledger if item["path"] == "/api/prefs") > prefs_before, 10)
        run.settle(300)
        out["posts"] = [dict(body) for body in site.template_posts]
        out["after_save"] = {"visible": editor.is_visible(), "prefs_read": sum(1 for item in site.ledger
                                                                               if item["path"] == "/api/prefs") - prefs_before,
                             "titles": page.locator("#tplrows tr[data-i] td:first-child").all_inner_texts()}
        out["commits"] = len(site.commits)
        edited_row = page.locator("#tplrows tr", has_text=EDIT_TITLE)
        if not edited_row.count():                            # (the check says what is missing)
            out["errors"], out["dialogs"] = list(run.errors), list(run.dialogs)
            return out
        # View shows the edit; the editor opened again holds it and every field it did not touch.
        page.locator("#tplrows tr", has_text=EDIT_TITLE).first.locator("[data-tpl-preview]").click()
        until(run, lambda: page.locator("#tpl-preview").is_visible(), 5)
        out["view"] = page.locator("#tpl-preview").inner_text()
        page.locator("#tpl-preview-close").click()
        page.locator("#tplrows tr", has_text=EDIT_TITLE).first.click(button="right")
        page.get_by_role("menuitem", name="수정", exact=True).click()
        until(run, lambda: editor.is_visible(), 5)
        out["reopened"] = read_editor()
        page.click("#tpl-cancel")
        out["commits"] = len(site.commits)
        # A fresh page: the server's templates again.
        page.reload(wait_until="commit")
        run.booted()
        out["fresh_titles"] = page.locator("#tplrows tr[data-i] td:first-child").all_inner_texts()
        # The edited template inserted where the reader's caret is.
        page.locator("#rows tr", has_text=h.PATIENT).first.click()
        until(run, lambda: page.locator("#findings").is_editable(), 10)
        before_insert = page.locator("#findings").input_value()
        page.click("#findings")
        page.keyboard.press("End")
        page.keyboard.type("SYN 앞 ")
        typed = page.locator("#findings").input_value()
        page.locator("#tplrows tr", has_text=EDIT_TITLE).first.locator("[data-tpl-preview]").click()
        until(run, lambda: page.locator("#tpl-preview-insert").is_visible(), 5)
        page.locator("#tpl-preview-insert").click()
        run.settle(500)
        out["insert"] = {"before": before_insert, "typed": typed, "after": run.observe()["fields"]}
        out["errors"], out["dialogs"] = list(run.errors), list(run.dialogs)
        return out

    def test_template_edit_opens_saves_and_is_used_as_edited(self):
        def check(result, side):
            editor = result["editor"]
            self.assertTrue(editor["visible"], f"{side}: the template editor opens from the row's Edit")
            self.assertEqual({k: str(EDITED[k]) for _, k in FIELDS_OF_TEMPLATE}, editor["fields"],
                             f"{side}: the editor holds the template as stored")
            self.assertEqual("tpl-t", editor["focus"], f"{side}: the title has the focus")
            self.assertEqual(result["report_before"], result["report_after_edit_opened"], f"{side}: Edit leaves the report")
            self.assertEqual(1, len(result["posts"]), f"{side}: one template save request")
            self.assertTrue(result["while_saving"]["visible"], f"{side}: the editor stays open while the save waits")
            self.assertEqual((EDIT_TITLE, EDIT_FINDINGS), (result["while_saving"]["fields"]["title"],
                                                           result["while_saving"]["fields"]["findings"]),
                             f"{side}: the edit is kept while the save waits")
            self.assertEqual({**{k: EDITED[k] for k in ("id", "shortcut", "modality", "bodypart", "conclusion",
                                                         "recommendation", "ord")}, "title": EDIT_TITLE,
                              "findings": EDIT_FINDINGS}, result["posts"][0], f"{side}: the wire body of the save")
            self.assertFalse(result["after_save"]["visible"], f"{side}: the editor closes after the save")
            self.assertEqual(1, result["after_save"]["prefs_read"], f"{side}: the list is read again from the server")
            self.assertEqual([EDIT_TITLE], [t for t in result["after_save"]["titles"] if t.startswith("SYN 흉부")],
                             f"{side}: one row, with the edited title")
            for line in EDIT_FINDINGS.split("\n"):
                self.assertIn(line, result["view"], f"{side}: View shows the edit")
            self.assertEqual({**{k: str(EDITED[k]) for _, k in FIELDS_OF_TEMPLATE}, "title": EDIT_TITLE,
                              "findings": EDIT_FINDINGS}, result["reopened"], f"{side}: Edit again holds the edit and the rest")
            self.assertEqual(0, result["commits"], f"{side}: editing a template commits no report")
            self.assertIn(EDIT_TITLE, result["fresh_titles"], f"{side}: a fresh page lists the edited template")
            after = result["insert"]["after"]["findings"]
            self.assertTrue(after.startswith(result["insert"]["typed"]), f"{side}: the text before the caret stays")
            self.assertEqual(1, after.count(EDIT_FINDINGS), f"{side}: the edited findings inserted once")
            self.assertEqual(1, (result["insert"]["after"]["conclusion"] or "").count(EDITED["conclusion"]),
                             f"{side}: the template's conclusion inserted once")
            self.assertEqual([], result["errors"], f"{side}: errors")
        self.compare(self.edit_template, "template edit", templates=(EDITED,), check=check)

    # F2-I09 (C09): an applied saved search, modified, deleted, then another applied - on the open Filters panel.
    def saved_search_states(self, run):
        page, site = run.page, run.site
        run.booted()
        page.locator("#rows tr", has_text="SYN-P-101").first.click()
        run.settle(300)
        out = {"report": run.observe()["fields"], "selection": run.observe()["selection"]}
        # The three patient search modes on one query (the product leaves a saved search when the mode changes, so
        # they are seen before one is applied).
        states = []
        page.fill("#quick", "ALPHA")
        for mode in ("prefix", "exact", "contains"):
            page.select_option("#quick-match", mode)
            run.settle(300)
            filters_open(run)
            states.append((f"search, {mode}", saved_state(run)))
        states.append(("apply S", apply_chip(run, SEARCH_S["name"])))
        # S's own condition changed by hand: S stays the named search, Modified.
        page.fill("#quick", "alpha")
        run.settle(300)
        filters_open(run)
        states.append(("modified", saved_state(run)))
        site.hold_writes.add("filter-delete")
        filters_open(run)
        page.locator("#chips button[data-i]", has_text=SEARCH_S["name"]).first.click(button="right")
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        until(run, lambda: site.held_writes, 10)
        filters_open(run)
        states.append(("delete waiting", saved_state(run)))
        if site.held_writes:
            site.finish_write()
        until(run, lambda: SEARCH_S["name"] not in page.evaluate("(document.querySelector('#chips') || {}).textContent || ''"), 10)
        run.settle(300)
        filters_open(run)
        states.append(("deleted", saved_state(run)))
        states.append(("apply R", apply_chip(run, SEARCH_R["name"])))
        out.update(states=states, report_after=run.observe()["fields"], selection_after=run.observe()["selection"],
                   deletes=list(site.filter_deletes), filters_kept=[f["name"] for f in site.filters],
                   writes=[(i["method"], i["path"]) for i in site.ledger if i["method"] != "GET"],
                   errors=list(run.errors), dialogs=list(run.dialogs))
        return out

    def test_saved_search_saved_modified_deleted_and_another_applied(self):
        def check(result, side):
            states = dict(result["states"])
            three, two, one = expected_rows(h.UID, h.UID_B, UID_C), expected_rows(h.UID, h.UID_B), expected_rows(h.UID)
            expect = {"search, prefix": (None, None, two), "search, exact": (None, None, one),
                      "search, contains": (None, None, three), "apply S": ("SYN Search S", "Saved", three),
                      "modified": ("SYN Search S", "Modified", three), "delete waiting": ("SYN Search S", "Modified", three),
                      "deleted": ("SYN Search S", "Deleted", three), "apply R": ("SYN Search R", "Saved", expected_rows(h.UID_B))}
            for step, (name, status, rows) in expect.items():
                state = states.get(step)
                self.assertIsNotNone(state, f"{side}: {step} reached")
                self.assertTrue(state["open"], f"{side}: {step}: the Filters panel is open")
                self.assertEqual((name, status, rows), (state["name"], state["state"], state["rows"]),
                                 f"{side}: {step}: the saved search, its state and the list")
            self.assertEqual(["SYN Search R", "SYN Search S"], sorted(states["delete waiting"]["chips"]),
                             f"{side}: S is there while its deletion waits")
            self.assertEqual(["SYN Search R"], states["deleted"]["chips"], f"{side}: S's chip is gone")
            self.assertFalse(states["deleted"]["edit_enabled"], f"{side}: Edit Search is not offered for a deleted search")
            self.assertEqual(("alpha", "contains"), (states["deleted"]["quick"], states["deleted"]["match"]),
                             f"{side}: the conditions stay after the deletion")
            self.assertEqual(["SYN-FILTER-S"], result["deletes"], f"{side}: one deletion, of S")
            self.assertEqual([("DELETE", "/api/filters/SYN-FILTER-S")], result["writes"], f"{side}: no other write")
            self.assertEqual(result["report"], result["report_after"], f"{side}: the report stays")
            self.assertEqual(result["selection"]["uid"], result["selection_after"]["uid"], f"{side}: the selected study stays")
            self.assertTrue(any("삭제할까요" in d for d in result["dialogs"]), f"{side}: the deletion was confirmed")
            self.assertEqual([], result["errors"], f"{side}: errors")
        self.compare(self.saved_search_states, "saved search states", filters=(SEARCH_S, SEARCH_R), rows=FILTER_ROWS,
                     dialogs=(("삭제할까요", True),), check=check)

    # F2-I10 (C10): what the browser kept of saved searches - nothing, one, damaged, wrong values, or the key itself
    # refusing to be read - and inputs while boot waits; after the session answer the server's saved searches are the
    # ones offered, applied and searched with.
    STORAGE = {
        "none": (),
        "a saved search": (LOCAL_FILTERS,),
        "damaged": ("try { localStorage.setItem('kin-filters', '{not json'); } catch (_) {}",),
        "wrong values": ("try { localStorage.setItem('kin-filters', JSON.stringify([{ nope: 1 }, 'x', 7, "
                         "{ name: 'SYN Odd Search', quick: 5, days: 'x' }])); } catch (_) {}",),
        "the key unreadable": (STORAGE_FAULT,),
    }

    def server_searches(self, run):
        page = run.page
        out = {"asked": until(run, lambda: bool(run.site.held_me), 60)}
        out["early"] = run.observe()["worklist"]
        if out["asked"]:
            quick_match(page)
            worklist_controls(page)
            run.settle(300)
            run.answer_auth()
        out["booted"] = until(run, lambda: rows_show(run), 30)
        if out["booted"]:
            run.settle(300)
            filters_open(run)
            out["offered"] = saved_state(run)
            out["applied"] = apply_chip(run, SEARCH_S["name"])
            page.fill("#quick", "ALPHA SYN")
            run.settle(300)
            filters_open(run)
            out["searched"] = saved_state(run)
            if page.context.cookies() and any(c["name"] == "syn-filters-fault" for c in page.context.cookies()):
                # The key reads again; a fresh page offers and applies the server's saved search.
                page.context.add_cookies([{"name": "syn-filters-fault", "value": "off", "url": h.ORIGIN}])
                page.reload(wait_until="commit")
                out["fresh"] = until(run, lambda: rows_show(run), 30) and apply_chip(run, SEARCH_S["name"])
        out["errors"] = list(run.errors)
        return out

    def test_saved_search_storage_and_values_end_as_on_the_original_page(self):
        def check(result, side):
            self.assertTrue(result["asked"], f"{side}: the session is checked")
            self.assertTrue(result["booted"], f"{side}: the page enters")
            self.assertEqual(["SYN Search R", "SYN Search S"], sorted(result["offered"]["chips"]),
                             f"{side}: the server's saved searches are the ones offered")
            applied, searched = result["applied"], result["searched"]
            self.assertEqual(("SYN Search S", "Saved", "ALPHA", expected_rows(h.UID, h.UID_B, UID_C)),
                             (applied["name"], applied["state"], applied["quick"], applied["rows"]), f"{side}: S applied")
            self.assertEqual(("Modified", expected_rows(h.UID_B)), (searched["state"], searched["rows"]), f"{side}: a new search")
            if "fresh" in result:
                self.assertEqual(("SYN Search S", "Saved", expected_rows(h.UID, h.UID_B, UID_C)),
                                 (result["fresh"]["name"], result["fresh"]["state"], result["fresh"]["rows"]),
                                 f"{side}: a fresh page applies S")
            self.assertEqual([], result["errors"], f"{side}: errors")
        for name, scripts in self.STORAGE.items():
            with self.subTest(storage=name):
                cookies = (("syn-filters-fault", "on"),) if scripts == (STORAGE_FAULT,) else ()
                self.compare(self.server_searches, f"saved searches, storage {name}", auth="wait",
                             filters=(SEARCH_S, SEARCH_R), rows=FILTER_ROWS, init_scripts=scripts, cookies=cookies,
                             check=check)

    # F2-I11 (C11): the browser refuses all storage - the landing says so and enters nothing; with storage back, Login
    # returns to the work page and a saved search applies.
    def storage_refused(self, run):
        page, site = run.page, run.site
        until(run, lambda: page.url.endswith("index.html") and page.locator("#signin").count() > 0, 30)
        run.settle(500)
        out = {"landing": run.observe(), "signin": page.locator("#signin").is_enabled() if page.locator("#signin").count() else None,
               "text": page.evaluate("() => document.body.innerText"),
               "asked": sum(1 for i in site.ledger if i["path"] == "/api/me"),
               "writes": [(i["method"], i["path"]) for i in site.ledger if i["method"] not in ("GET", "HEAD")]}
        page.context.add_cookies([{"name": "syn-storage-fault", "value": "off", "url": h.ORIGIN}])
        page.evaluate("() => window.__synMendStorage && window.__synMendStorage()")
        if out["signin"]:
            page.locator("#signin").click()
        out["returned"] = until(run, lambda: page.url == h.MAIN_URL and rows_show(run), 30)
        if out["returned"]:
            run.settle(300)
            out["applied"] = apply_chip(run, SEARCH_S["name"])
        out["errors"] = list(run.errors)
        return out

    def test_storage_refused_lands_explains_and_recovers_through_login(self):
        def check(result, side):
            landing = result["landing"]
            self.assertEqual("index.html", landing["page"], f"{side}: the landing")
            self.assertTrue(landing["notice"] and h.has_hangul(landing["notice"]), f"{side}: the landing explains, in Korean")
            self.assertTrue(result["signin"], f"{side}: Login is offered")
            self.assertEqual(0, result["asked"], f"{side}: no session check without storage")
            self.assertFalse([name for name in NAMES if name in result["text"]], f"{side}: no patient on the landing")
            self.assertEqual([], result["writes"], f"{side}: nothing written")
            self.assertTrue(result["returned"], f"{side}: Login returns to the work page")
            self.assertEqual(("SYN Search S", "Saved", expected_rows(h.UID, h.UID_B, UID_C)),
                             (result["applied"]["name"], result["applied"]["state"], result["applied"]["rows"]),
                             f"{side}: a saved search applies after the return")
            self.assertEqual([], result["errors"], f"{side}: errors")
        self.compare(self.storage_refused, "storage refused", filters=(SEARCH_S, SEARCH_R), rows=FILTER_ROWS,
                     init_scripts=(STORAGE_FAULT,), cookies=(("syn-storage-fault", "on"),), check=check)

    # F2-I12 (C12): saved searches the page cannot apply are refused with the current conditions kept; a failed list
    # read in the saved search manager keeps what the manager shows, and Reload List brings the recovered list.
    def invalid_values_and_reload(self, run):
        page, site = run.page, run.site
        run.booted()
        out = {"S": apply_chip(run, SEARCH_S["name"])}
        for search in (BAD_MODE, BAD_COMPOUND):
            before = len(page.evaluate("window.__kinToasts"))
            state = apply_chip(run, search["name"])
            state["new_toasts"] = state["toasts"][before:]
            out[search["name"]] = state
        out["R"] = apply_chip(run, SEARCH_R["name"])
        page.click("#managefilters")
        manager = page.locator("#saved-filter-manager")
        until(run, lambda: manager.is_visible(), 5)
        names = lambda: page.evaluate("() => [...document.querySelectorAll('#sfm-list button[data-name]')].map(b => b.dataset.name)")  # noqa: E731
        status = lambda: page.locator("#sfm-status").inner_text()  # noqa: E731
        out["manager"] = {"names": names(), "name_field": page.locator("#sfm-name").input_value()}
        failures = []
        for answer in ((500, {"code": "SYN_FAILED", "message": "SYN prefs failed"}), "not-a-list"):
            site.prefs_answers = [answer]
            reads = sum(1 for i in site.ledger if i["path"] == "/api/prefs")
            page.click("#sfm-reload")
            until(run, lambda: sum(1 for i in site.ledger if i["path"] == "/api/prefs") > reads, 10)
            until(run, lambda: bool(status().strip()), 10)
            run.settle(300)
            failures.append({"status": status(), "names": names(), "name_field": page.locator("#sfm-name").input_value()})
        out["failures"] = failures
        site.filters.append(dict(SEARCH_R2))
        site.prefs_answers = []
        page.click("#sfm-reload")
        until(run, lambda: SEARCH_R2["name"] in names(), 10)
        out["recovered"] = {"names": names(), "status": status()}
        if SEARCH_R2["name"] in names():
            page.locator(f"#sfm-list button[data-name='{SEARCH_R2['name']}']").click()
            page.click("#sfm-apply")
            until(run, lambda: not manager.is_visible(), 5)
            run.settle(300)
            filters_open(run)
            out["R2"] = saved_state(run)
        out["errors"] = list(run.errors)
        return out

    def test_saved_search_refusals_and_list_reload_recover(self):
        def check(result, side):
            three = expected_rows(h.UID, h.UID_B, UID_C)
            self.assertEqual(("SYN Search S", "Saved", three), (result["S"]["name"], result["S"]["state"], result["S"]["rows"]),
                             f"{side}: S applied")
            for name in (BAD_MODE["name"], BAD_COMPOUND["name"]):
                state = result[name]
                self.assertTrue(state["new_toasts"] and all(h.has_hangul(t) for t in state["new_toasts"]),
                                f"{side}: {name} is refused with a message")
                self.assertEqual(("SYN Search S", "Saved", "ALPHA", three),
                                 (state["name"], state["state"], state["quick"], state["rows"]),
                                 f"{side}: {name}: the applied search, its conditions and the list stay")
            self.assertEqual(("SYN Search R", "Saved", expected_rows(h.UID_B)), (result["R"]["name"], result["R"]["state"],
                                                                         result["R"]["rows"]), f"{side}: R applied")
            self.assertIn(SEARCH_R2["name"], result["recovered"]["names"], f"{side}: Reload List brings the recovered list")
            for failure in result["failures"]:
                self.assertTrue(failure["status"].strip() and failure["status"] != result["recovered"]["status"],
                                f"{side}: the failed list read is told")
                self.assertEqual(result["manager"]["names"], failure["names"], f"{side}: the list shown stays")
                self.assertEqual(result["manager"]["name_field"], failure["name_field"], f"{side}: the edited values stay")
                self.assertNotIn(SEARCH_R2["name"], failure["names"])
            self.assertIn(SEARCH_R2["name"], result["recovered"]["names"], f"{side}: Reload List brings the recovered list")
            self.assertEqual(("SYN Search R2", "Saved", expected_rows(UID_C)),
                             (result.get("R2", {}).get("name"), result.get("R2", {}).get("state"),
                              result.get("R2", {}).get("rows")), f"{side}: the recovered search applies")
            self.assertEqual([], result["errors"], f"{side}: errors")
        self.compare(self.invalid_values_and_reload, "saved search refusals and reload",
                     filters=(SEARCH_S, SEARCH_R, BAD_MODE, BAD_COMPOUND), rows=FILTER_ROWS, check=check)


# TEST-PRE-EARLY-03: a dictation started on A, its answer late after A -> B -> A (the media stack needs the full
# Chromium with a fake microphone; nothing leaves the synthetic origin).
class LateDictation(SameGestures):
    LATE = "SYN LATE DICTATION FROM THE FIRST VISIT"

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chromium", headless=True,
                                             args=["--use-fake-device-for-media-stream", "--disable-audio-output"])

    def a_b_a(self, run):
        run.booted()
        page = run.page
        select_study(page)
        page.click("#b-dictate")
        stop = page.locator("#dictation-stop")
        run.wait(lambda: stop.is_visible() and stop.is_enabled(), "the dictation records")
        page.wait_for_timeout(800)
        stop.click()
        run.wait(lambda: run.site.held_dictations, "the recognition request")
        during = run.observe()
        page.locator("#rows tr", has_text=h.PATIENT_B).first.click()
        run.settle(300)
        page.locator("#rows tr", has_text=h.PATIENT).first.click()
        run.settle(300)
        moved = run.observe()
        run.site.answer_dictation(self.LATE)
        run.settle(500)
        run.quiet()
        return {"during": during, "moved": moved, "late": run.observe(), "requests": list(run.site.dictations),
                "errors": list(run.errors), "dialogs": list(run.dialogs)}

    def test_a_late_dictation_after_a_b_a_ends_as_on_the_original_page_and_is_not_inserted(self):
        result = self.compare(self.a_b_a, "dictation on A, answer after A -> B -> A", dictation=True, second_study=True,
                              permissions=("microphone",), init_scripts=(WORKLET_FROM_BLOB,))
        self.assertEqual([h.UID], result["requests"], "one recognition request, for A")
        self.assertIn("Stop", result["during"]["dictation"] or "", "the dictation was recording, then uploading")
        self.assertEqual([], [f for f, v in result["late"]["fields"].items() if self.LATE in (v or "")],
                         "the late text is in no report field")
        self.assertNotIn(self.LATE, result["late"]["dictation"] or "", "the late text is not offered for review")


# Native back/forward cache: Playwright launches Chromium with it switched off and its headless shell keeps no page
# in it; this class uses the full Chromium with the cache on, and the page is answered without a cache header, as the
# product's /worklist/ location answers it.
class BackForwardCache(SameGestures):
    # Every pageshow of the tab, kept in its session storage: a page restored from the cache may reload itself.
    SHOWS = """(() => { if (!location.pathname.endsWith('/main.html')) return;
      window.addEventListener('pageshow', event => { try {
        const shows = JSON.parse(sessionStorage.getItem('syn-shows') || '[]');
        shows.push([event.persisted, performance.getEntriesByType('navigation')[0].type]);
        sessionStorage.setItem('syn-shows', JSON.stringify(shows)); } catch (_) {} }); })();"""

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chromium", headless=True,
                                             ignore_default_args=["--disable-back-forward-cache"])

    def leave_and_come_back(self, run):
        run.booted()
        page = run.page
        select_study(page)
        page.fill("#quick", "ALPHA")
        run.settle(300)
        before = run.observe()
        page.goto(PROBE_URL)
        page.go_back(wait_until="commit")                    # a page from the cache fires no load event
        run.settle(1000)
        run.quiet()
        reasons = page.evaluate("""() => { const entry = performance.getEntriesByType('navigation')[0];
          return entry && entry.notRestoredReasons ? JSON.stringify(entry.notRestoredReasons.reasons) : null; }""")
        return {"before": before, "shows": page.evaluate("() => JSON.parse(sessionStorage.getItem('syn-shows') || '[]')"),
                "not_restored": reasons, "after": run.observe(), "errors": list(run.errors), "dialogs": list(run.dialogs)}

    def test_leaving_and_coming_back_from_the_cache_ends_as_on_the_original_page(self):
        result = self.compare(self.leave_and_come_back, "back/forward cache", cache_headers=False,
                              init_scripts=(self.SHOWS,))
        self.assertEqual([False, True], [persisted for persisted, _ in result["shows"][:2]],
                         f"the original page came back from the native cache (not restored: {result['not_restored']})")


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
    where = (f"hold {files[hold_module]['file']}" + (f" {delay_ms}ms apart" if delay_ms else "") if hold_module is not None
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


def held(hazard, count, guarded, hold_module):
    split_case(hazard, count, guarded, hold_module=hold_module)
    # The 18/30 delivery matrix (45 has its timed cases below): the same held boundary with every part before it
    # answered 150 ms after the one before, so the timers and answers of what ran get their turns before the hold.
    if count < 45:
        split_case(hazard, count, guarded, hold_module=hold_module, delay_ms=150)


for count in PARTS:
    last = count - 1
    # B1-03: after the dictation registration and before selectionSeq's original module.
    held("B1-03", count, "selectionSeq", MODULE["report-dictation.js"] + 1)
    held("B1-03", count, "selectionSeq", min(MODULE["report-editor.js"], last))
    # B1-05: before cur's original module (Modality/Bodypart/search/clear), then before RFIELDS' (View).
    held("B1-05", count, "cur", MODULE["report-templates-ui.js"] + 1)
    held("B1-05", count, "cur", MODULE["current-study.js"])
    held("B1-05", count, "RFIELDS", min(MODULE["related-report.js"], last))
    # B1-05 Tab shortcut: before editReport's original module.
    held("B1-05-TAB", count, "editReport", MODULE["report-templates-ui.js"] + 1)
    held("B1-05-TAB", count, "editReport", min(MODULE["report-draft-save.js"], last))
    # B1-58 / PRE-X3: only where saved-filters.js is a part of its own.
    if MODULE["saved-filters.js"] < count:
        held("B1-58", count, "renderChips", MODULE["saved-filters.js"])
        held("PRE-X3", count, "renderChips", MODULE["saved-filters.js"])
    # PRE-X1 / PRE-X2: the report fields' input (report-hold.js) and View, both before reportWriteBlock's module.
    if MODULE["report-toolbar.js"] < count:
        for module in (MODULE["work-exit.js"], MODULE["report-toolbar.js"]):
            held("PRE-X1", count, "reportWriteBlock", module)
        for module in (MODULE["report-editor.js"], MODULE["report-toolbar.js"]):
            held("PRE-X2", count, "reportWriteBlock", module)
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


# ── TEST-PRE-MUTANTS: one case per mutant, bound to the layout the browser is given (main_early_input_mutants.py) ──
# KIN_PRE_BOUNDARY (set by the mutant driver only) lists cases {name, hazard, count, hold, statement, bindings, binding}:
# `hold` is the part the delivered manifest gives the restored statement (`statement`, its index in the page under
# test), so the hazard's input or the leaving happens while that part has not run. The case first checks that moment -
# the held part waits and has not run, the consumer's listeners are registered, each restored binding is `binding`
# ("absent" on the mutant, "present" on the unmutated page) - and only then the hazard, as the suite's own cases do.
BOUNDARY = json.loads(os.environ.get("KIN_PRE_BOUNDARY", "[]"))
# The pagehide consumers of the leaving hazards, by the ORIGINAL page's statements that register them (B1-15
# relatedParts, B1-41/42/45 studyPriority; B1-57 readingWorkspace).
LEAVE_CONSUMERS = {"leave:B1-15/41": ("relatedParts", "ExpressionStatement after listLoadSequence #1"),
                   "leave:B1-57": ("readingWorkspace",)}
# Whether a top-level binding exists yet, evaluated as page script (not a function body: it reads the page's own
# global scope, where a classic script's let/const/function lives once that script ran).
BINDING_STATE = ("(function () { try { %s; return 'present'; } catch (error) {"
                 " return error && error.name === 'ReferenceError' ? 'absent' : 'threw ' + (error && error.name); } })()")


class MutantBoundary(PreCase):
    def consumer(self, hazard):
        if hazard in HAZARDS:
            return self.keys(hazard)
        manifest, registrations = self.original_trace()
        names = LEAVE_CONSUMERS[hazard]
        found = set()
        for item in registrations:
            _, owner = sh.attribute(manifest, item)
            if item["kind"] == "add" and item["target"] == "window" and item["type"] == "pagehide" and owner \
                    and owner["name"] in names:
                found.add((item["target"], item["type"], item["listener"]))
        self.assertEqual(len(names), len(found), f"{hazard}: the original page registers one pagehide listener per consumer")
        return found

    def assert_moment(self, run, config, consumer):
        hold, what = config["hold"], f"PRECONDITION {config['name']}"
        self.assertEqual(hold, run.delivery.hold, what)
        self.assertIn(hold, run.delivery.pending, f"{what}: the held part's request waits")
        self.assertNotIn(hold, run.page.evaluate("window.__kinTrace.executed.slice()"), f"{what}: the held part has not run")
        registered = {(r["target"], r["type"], r["listener"]) for r in run.trace()["registrations"] if r["kind"] == "add"}
        self.assertEqual([], sorted(consumer - registered), f"{what}: the consumer's listeners are registered")
        for name in config["bindings"]:
            self.assertRegex(name, r"^[A-Za-z_$][\w$]*$")
            self.assertEqual(config["binding"], run.page.evaluate(BINDING_STATE % name), f"{what}: the binding {name}")


def boundary_case(config):
    def test(self):
        layout = Pages.current.layout(config["count"])
        manifest = layout[1]
        self.assertIn(config["hold"], manifest["parts"], f"PRECONDITION {config['name']}: a part of this layout")
        if config.get("statement") is not None:
            self.assertEqual(config["hold"], manifest["statements"][config["statement"]]["file"],
                             f"PRECONDITION {config['name']}: the delivered manifest puts the restored statement there")
        consumer = self.consumer(config["hazard"])
        check = lambda run: self.assert_moment(run, config, consumer)  # noqa: E731
        if config["hazard"] in HAZARDS:
            result = self.early(config["hazard"], layout, hold=config["hold"], before_input=check)
            self.assert_like_original(config["hazard"], result)
        else:
            errors = self.leaving(layout, hold=config["hold"], before_leave=check)
            if errors:
                raise HazardFailure(f"{config['hazard']}: errors while leaving the page at the early moment: {errors}",
                                    errors)
    test.__name__ = "test_" + config["name"]
    test.__doc__ = f"{config['hazard']}: {config['count']}-part page, hold {config['hold']} (bindings {config['bindings']} " \
                   f"{config['binding']})"
    setattr(MutantBoundary, test.__name__, test)


for _config in BOUNDARY:
    boundary_case(_config)



# Only the parent self-check enables this intentionally failing child. It exercises the real browser and keeper.
if os.environ.get("KIN_PRE_FAILURE_CHILD"):
    class FailureChild(Registration):
        def test_failure(self):
            fault = os.environ["KIN_PRE_FAILURE_CHILD"]
            drive = Steps.drive

            def fail_phase(steps, condition, what, *args, **kwargs):
                side = "original" if steps.run.original else "candidate"
                if fault == side + "-" + what:
                    steps.run.wait(lambda: steps.run.page.evaluate("!!window.__synLedger && !!window.__kinTrace"),
                                   "child instrumentation ready")
                    def expire(observed, phase, deadline):
                        self.assertEqual(what, phase, "injected deadline reached its phase")
                        observed.deadline_hook = None
                        observed.host_clock = lambda: deadline + 1
                    steps.deadline_hook = expire
                return drive(steps, condition, what, *args, **kwargs)

            def gesture(run):
                if not run.original:
                    run.page.evaluate("window.dispatchEvent(new Event('resize'))")
                return run.steps.raw("after")

            Steps.drive = fail_phase
            try:
                base, original, candidate = self.both("failure-child", "answered", gesture if fault == "comparison" else None)
                if fault != "comparison":
                    self.fail("injected deadline unexpectedly completed")
                self.compare_phases(base, {"after": original[1]}, {"after": candidate[1]}, "known child difference", dispatches=True)
            except AssertionError as failure:
                files = {str(p.relative_to(ARTIFACTS)): json.loads(p.read_text(encoding="utf-8"))
                         for p in ARTIFACTS.rglob("*.json")}
                sh.keep(ARTIFACTS, "failure-time-files.json", {"failure": str(failure),
                    "raw_files": {n: r for n, r in files.items() if n.endswith(".raw.json")},
                    "comparisons": {n: r for n, r in files.items() if n.endswith("comparison.json")}})
                raise
            finally:
                Steps.drive = drive

if __name__ == "__main__":
    unittest.main(verbosity=2)
