# coding: utf-8
"""Probe (not a test): which listener and statement raise the errors seen when the page is left at a held boundary.
The page is first left for real (navigation: the browser's error report with its stack), then, in a fresh page held
at the same boundary, a pagehide event is dispatched to window so the trace names the listener that threw."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import auth_logout_dom_test as h  # noqa: E402
import main_split_harness as sh  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROBE_URL = h.ORIGIN + "/syn-probe.html"


def open_held(browser, directory, manifest, k):
    site = h.Site()
    site.held_me = []
    context = browser.new_context(viewport={"width": 1400, "height": 900})
    context.add_init_script(sh.TRACE_SCRIPT)
    context.route("**/*", lambda route, request: site.handle(route, request))
    context.route(PROBE_URL, lambda route: route.fulfill(body="<!doctype html><title>SYN</title>", content_type="text/html"))
    delivery = sh.Delivery(directory, manifest, h.BASE, hold=manifest["parts"][k]).install(context)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append({"message": f"{e.name}: {e.message}", "stack": (e.stack or "")[:900]}))
    page.goto(h.MAIN_URL, wait_until="commit")
    delivery.wait(page, lambda: delivery.blocked(page), "blocked")
    return context, page, delivery, errors


def main():
    pages = sh.ScratchPages()
    out = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            directory, manifest = pages.layout(45)
            for k in (9, 13, 33, 36, 37, 38):
                context, page, delivery, errors = open_held(browser, directory, manifest, k)
                page.goto(PROBE_URL, wait_until="commit")
                page.wait_for_timeout(200)
                real = list(errors)
                delivery.dispose()
                context.close()
                context, page, delivery, errors = open_held(browser, directory, manifest, k)
                since = page.evaluate("window.__kinTrace.now()")
                page.evaluate("() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))")
                page.wait_for_timeout(100)
                trace = sh.snapshot(page)
                regs = {r["seq"]: r for r in trace["registrations"]}
                thrown = []
                for d in [d for d in trace["dispatches"] if d["seq"] > since and d.get("error")]:
                    r = regs[d["registration"]]
                    inner, owner = sh.attribute(manifest, r)
                    thrown.append({"target": d["target"], "type": d["type"], "error": d["error"],
                                   "registered_at": inner and f"{inner[0]}:{inner[1]}",
                                   "statement": owner and f"{manifest['modules'][owner['module']]['file']} :: {owner['name']}"})
                out.append({"modules_ran": k, "held_part": manifest["parts"][k], "leaving_for_real": real,
                            "synthetic_pagehide": thrown, "synthetic_errors": [e["message"] for e in errors]})
                delivery.dispose()
                context.close()
            browser.close()
    finally:
        pages.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
