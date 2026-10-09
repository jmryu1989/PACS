# coding: utf-8
"""S9-U0a-PRE phase-1 probe (not a test): which split boundaries turn an early input into a page error.

held  : for every part k of the 18/30/45 layouts, hold part k (modules 0..k-1 have run), then give the page every
        early input of the hazard groups and of the sweep; every uncaught error is attributed to the dispatch
        (target, event) that raised it.
0/150 : no hold, every split boundary delayed 0 or 150 ms; each hazard group is given as soon as the module that
        registers it has run; repeated, so the 0 ms column is a rate.
Writes JSON to the path given as the first argument.
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import auth_logout_dom_test as h  # noqa: E402
import main_split_harness as sh  # noqa: E402
from playwright.sync_api import Error as PlaywrightError, sync_playwright  # noqa: E402

FIELDS = ("findings", "conclusion", "recommendation")


def g03(page):
    for k in FIELDS:
        page.click("#" + k, timeout=3000)
        page.keyboard.type("a")


def g05(page):
    page.click("#t-mod", timeout=3000)
    page.select_option("#t-body", "", timeout=3000)
    page.fill("#tpl-search", "Brain", timeout=3000)
    page.click("#tpl-search-clear", timeout=3000)
    page.click("#tpl-filter-clear", timeout=3000)


def g05_view(page):
    view = page.locator("#tplrows [data-tpl-preview]")
    if not view.count():
        return "no View"
    view.first.click(timeout=3000)
    if page.locator("#tpl-preview-close").is_visible():
        page.click("#tpl-preview-close", timeout=3000)
        view.first.click(timeout=3000)
        if page.locator("#tpl-preview-insert").is_enabled():
            page.click("#tpl-preview-insert", timeout=3000)
        if page.locator("#tpl-preview-close").is_visible():
            page.click("#tpl-preview-close", timeout=3000)
    page.locator("#tplrows tr[data-i]").first.click(button="right", timeout=3000)
    page.keyboard.press("Escape")
    return "View"


def g58(page):
    page.select_option("#quick-match", "prefix", timeout=3000)


SWEEP = """() => [...document.querySelectorAll('input, select, textarea, button')].filter(el => {
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return !el.disabled && r.width > 0 && r.height > 0 && s.visibility !== 'hidden'
    && !el.closest('[hidden], dialog:not([open]), .modal:not(.show)');
}).map(el => el.id).filter(id => id && !['findings','conclusion','recommendation','t-mod','t-body','tpl-search',
  'tpl-search-clear','tpl-filter-clear','quick-match','logout'].includes(id))"""


def idle(page):
    page.wait_for_timeout(1500)  # timers and observers of the modules that ran, with no input at all


PROBE_URL = h.ORIGIN + "/syn-probe.html"
END = {"session": "SYN-SESSION-1", "operation": 9999999999999, "status": "confirmed", "origin": "logout"}


def environment(page):
    """Independent targets: window size, another document in front, a session end told by storage and channel."""
    notes = []
    page.set_viewport_size({"width": 1000, "height": 700})
    page.wait_for_timeout(100)
    page.set_viewport_size({"width": 1400, "height": 900})
    notes.append("resize")
    other = page.context.new_page()
    other.goto(PROBE_URL)
    other.bring_to_front()
    page.wait_for_timeout(100)
    page.bring_to_front()
    page.evaluate("() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); }")
    notes.append("other document in front, focus back")
    other.evaluate("""end => { localStorage.setItem('kin-session-end:' + end.session, JSON.stringify(end));
      new BroadcastChannel('kin-session').postMessage({ type: 'session-ended', ...end }); }""", END)
    page.wait_for_timeout(300)
    notes.append("session end by storage and channel")
    other.close()
    return notes


def pagehide(page):
    page.goto(PROBE_URL, wait_until="commit")
    page.wait_for_timeout(200)
    return "left the page (pagehide)"


def sweep(page):
    done = []
    for ident in page.evaluate(SWEEP):
        sel = "#" + ident
        kind = page.evaluate("s => { const el = document.querySelector(s); return el.localName + ':' + (el.type || ''); }", sel)
        try:
            if kind.startswith("select"):
                values = page.evaluate("s => [...document.querySelector(s).options].map(o => o.value)", sel)
                page.select_option(sel, values[-1], timeout=2000)
            elif kind.startswith("input:text") or kind.startswith("input:search") or kind.startswith("textarea"):
                page.click(sel, timeout=2000)
                page.keyboard.type("SYN")
            else:
                page.click(sel, timeout=2000)
                page.keyboard.press("Escape")
            done.append(ident)
        except PlaywrightError as error:
            done.append(ident + " (not actionable: " + str(error).splitlines()[0][:80] + ")")
        if page.url != h.MAIN_URL:
            done.append("navigated: " + page.url)
            break
    return done


class Probe:
    def __init__(self, browser, pages):
        self.browser, self.pages = browser, pages

    def open(self, count, hold=None, delay_ms=0):
        directory, manifest = self.pages.layout(count)
        site = h.Site()
        site.held_me = []  # boot never starts before the held part anyway; keep auth waiting afterwards
        context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        context.add_init_script(sh.TRACE_SCRIPT)
        context.route("**/*", lambda route, request: site.handle(route, request))
        context.route(PROBE_URL, lambda route: route.fulfill(body="<!doctype html><title>SYN probe</title>",
                                                             content_type="text/html"))
        delivery = sh.Delivery(directory, manifest, h.BASE, delay_ms=delay_ms, hold=hold).install(context)
        page = context.new_page()
        page.set_default_timeout(5000)
        page.on("dialog", lambda d: d.dismiss())
        page.kin_errors = []
        page.on("pageerror", lambda e: page.kin_errors.append(f"{e.name}: {e.message}"))
        page.goto(h.MAIN_URL, wait_until="commit")
        return context, page, delivery, manifest

    @staticmethod
    def errors(page, since):
        if page.url != h.MAIN_URL:  # the document has gone: only the browser's report of its errors is left
            return [{"message": m, "target": None, "type": "(reported while leaving)"} for m in page.kin_errors[since:]]
        trace = sh.snapshot(page, since)
        by_seq = {d["seq"]: d for d in trace["dispatches"] if "registration" in d}
        out = []
        for e in trace["errors"]:
            d = by_seq.get(e["dispatch"])
            out.append({"message": e["message"], "target": d and d["target"], "type": d and d["type"]})
        return out

    def held(self, count):
        result = []
        _, manifest = self.pages.layout(count)
        for k, part in enumerate(manifest["parts"]):
            context, page, delivery, _ = self.open(count, hold=part)
            row = {"count": count, "hold": part, "ran_modules": k, "groups": {}}
            try:
                delivery.wait(page, lambda: delivery.blocked(page), "blocked", timeout=20)
                for name, group in (("idle", idle), ("B1-03", g03), ("B1-05", g05), ("B1-05-view", g05_view), ("B1-58", g58),
                                    ("sweep", sweep), ("environment", environment), ("pagehide", pagehide)):
                    since = page.evaluate("window.__kinTrace.now()") if name != "pagehide" else len(page.kin_errors)
                    try:
                        note = group(page)
                    except PlaywrightError as error:
                        note = "input failed: " + str(error).splitlines()[0][:120]
                    page.wait_for_timeout(30)
                    row["groups"][name] = {"note": note, "errors": self.errors(page, since)}
                    if page.url != h.MAIN_URL and name != "pagehide":
                        row["groups"][name]["note"] = f"{note} -> the page moved to {page.url}"
                        break
            finally:
                delivery.dispose()
                context.close()
            result.append(row)
            print(json.dumps({k2: v for k2, v in row.items() if k2 != "groups"} | {
                g: [e["message"] for e in v["errors"]] for g, v in row["groups"].items()}, ensure_ascii=False), flush=True)
        return result

    def timed(self, count, delay_ms, hazard, module_file, group, repeats):
        rows = []
        for attempt in range(repeats):
            context, page, delivery, manifest = self.open(count, delay_ms=delay_ms)
            row = {"count": count, "delay_ms": delay_ms, "hazard": hazard, "attempt": attempt}
            try:
                trigger = module_file if module_file in manifest["parts"] else "main.html-inline"
                if trigger == "main.html-inline":
                    row["note"] = "registering module is in the remaining inline script: no boundary before its dependents"
                else:
                    delivery.wait(page, lambda: page.evaluate("f => window.__kinTrace.executed.includes(f)", trigger),
                                  "registering module ran", timeout=30)
                    started = time.monotonic()
                    since = page.evaluate("window.__kinTrace.now()")
                    executed_at_input = len(page.evaluate("window.__kinTrace.executed"))
                    try:
                        row["note"] = group(page)
                    except PlaywrightError as error:
                        row["note"] = "input failed: " + str(error).splitlines()[0][:120]
                    row["input_ms"] = round((time.monotonic() - started) * 1000)
                    row["executed_at_input"] = executed_at_input
                    page.wait_for_timeout(30)
                    row["errors"] = self.errors(page, since)
            finally:
                delivery.dispose()
                context.close()
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
        return rows


def main():
    out_path = Path(sys.argv[1])
    pages = sh.ScratchPages()
    report = {"held": [], "timed": []}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            probe = Probe(browser, pages)
            for count in (18, 30, 45):
                report["held"] += probe.held(count)
            timed = (("B1-03", "report-dictation.js", g03), ("B1-05", "report-templates-ui.js", g05),
                     ("B1-58", "worklist-controls.js", g58))
            for count in (18, 30, 45):
                for hazard, module_file, group in timed:
                    for delay_ms, repeats in ((0, 10), (150, 3)):
                        report["timed"] += probe.timed(count, delay_ms, hazard, module_file, group, repeats)
            browser.close()
    finally:
        pages.close()
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
