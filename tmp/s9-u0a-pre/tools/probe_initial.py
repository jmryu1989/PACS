# coding: utf-8
"""Probe (not a test): what the unsplit page offers before boot, and one held split boundary."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import auth_logout_dom_test as h  # noqa: E402
import main_split_harness as sh  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CONTROLS = """() => [...document.querySelectorAll('input, select, textarea, button')].filter(el => {
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return !el.disabled && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[hidden], dialog:not([open]), .modal:not(.show)');
}).map(el => ({ id: el.id, tag: el.localName, type: el.type, text: (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 30) }))"""


def main():
    pages = sh.ScratchPages()
    out = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for count, hold in ((0, None), (45, "report-templates-ui.js")):
            site = h.Site()
            site.held_me = []
            directory, manifest = pages.layout(count)
            context = browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
            context.add_init_script(sh.TRACE_SCRIPT)
            context.route("**/*", lambda route, request, site=site: site.handle(route, request))
            delivery = sh.Delivery(directory, manifest, h.BASE, hold=hold).install(context)
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(h.MAIN_URL, wait_until="commit")
            if hold:
                delivery.wait(page, lambda: delivery.blocked(page), "blocked")
            else:
                delivery.wait(page, lambda: site.held_me, "auth wait")
            page.wait_for_timeout(300)
            controls = page.evaluate(CONTROLS)
            trace = sh.snapshot(page)
            key = f"{count}:{hold}"
            out[key] = {"controls": controls, "registrations": len(trace["registrations"]), "errors": errors,
                        "executed": len(trace["executed"])}
            if hold:
                page.click("#findings")
                page.keyboard.type("x")
                page.wait_for_timeout(200)
                out[key]["after_click"] = {"errors": list(errors), "trace_errors": sh.snapshot(page)["errors"],
                                          "dispatch": [d for d in sh.snapshot(page)["dispatches"] if d.get("target") == "#findings"]}
            context.close()
        browser.close()
    pages.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
