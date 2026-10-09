# coding: utf-8
"""Probe (not a test): which registration (statement, file:line) raised each extra hazard error of the matrix."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import auth_logout_dom_test as h  # noqa: E402
import main_split_harness as sh  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CASES = (
    ("report fields input", 26, lambda p: (p.click("#findings"), p.keyboard.type("a"))),
    ("template View", 19, lambda p: (p.click("#t-mod"), p.locator("#tplrows [data-tpl-preview]").first.click())),
    ("quick input", 38, lambda p: (p.click("#quick"), p.keyboard.type("S"))),
    ("page size", 38, lambda p: p.select_option("#page-size", "100")),
    ("quick match", 38, lambda p: p.select_option("#quick-match", "prefix")),
    ("page next", 38, lambda p: p.click("#page-next")),
)


def main():
    pages = sh.ScratchPages()
    out = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            directory, manifest = pages.layout(45)
            for label, k, act in CASES:
                site = h.Site()
                site.held_me = []
                context = browser.new_context(viewport={"width": 1400, "height": 900})
                context.add_init_script(sh.TRACE_SCRIPT)
                context.route("**/*", lambda route, request, site=site: site.handle(route, request))
                delivery = sh.Delivery(directory, manifest, h.BASE, hold=manifest["parts"][k]).install(context)
                page = context.new_page()
                page.goto(h.MAIN_URL, wait_until="commit")
                delivery.wait(page, lambda: delivery.blocked(page), "blocked")
                since = page.evaluate("window.__kinTrace.now()")
                act(page)
                page.wait_for_timeout(100)
                trace = sh.snapshot(page)
                regs = {r["seq"]: r for r in trace["registrations"]}
                for d in [d for d in trace["dispatches"] if d["seq"] > since and d.get("error")]:
                    r = regs[d["registration"]]
                    inner, owner = sh.attribute(manifest, r)
                    out.append({"case": label, "held_part": manifest["parts"][k], "modules_ran": k, "target": d["target"],
                                "type": d["type"], "error": d["error"], "registered_at": inner and f"{inner[0]}:{inner[1]}",
                                "statement": owner and f"{manifest['modules'][owner['module']]['file']} :: {owner['name']}"})
                delivery.dispose()
                context.close()
            browser.close()
    finally:
        pages.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
