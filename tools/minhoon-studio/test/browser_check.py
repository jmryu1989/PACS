"""Real-browser check of the studio chat window <-> product window boundary (synthetic data only).

usage: python tools/minhoon-studio/test/browser_check.py --out <folder> [--sha <commit for the sandbox>]

Builds a throwaway synthetic sandbox (deploy/make-sandbox.py), sets a throwaway login, starts the real studio server
on a free local port and drives the served studio.html / product.html in headless Chromium (Python Playwright; node on
PATH). Only test-side observers are added (an iframe load counter in the product window, a click counter in the
product frame, a hook on the chat's EventSource); no product or studio code is replaced. Writes <out>/results.json and
screenshots; exit 1 if any check fails. Adapted from the GPT functional review scripts of 9f4437c.
"""
import argparse, json, pathlib, socket, subprocess, sys, time, traceback, urllib.request
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = pathlib.Path(__file__).resolve().parent
STUDIO = HERE.parent
REPO = STUDIO.parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--sha", default="HEAD")
ap.add_argument("--ohif", help="pinned OHIF build (dev/extract_ohif.py); without it the viewer window shows the 'not installed' page")
ap.add_argument("--dicomweb", help="static DICOMweb samples (dev/build_dicomweb_store.py)")
ap.add_argument("--headed", action="store_true", help="installed Chrome in a real window: also compares the window chrome height of the two tabs")
a = ap.parse_args()
OUT = pathlib.Path(a.out).resolve()
OUT.mkdir(parents=True, exist_ok=True)
SHA = subprocess.check_output(["git", "rev-parse", a.sha], cwd=REPO, text=True).strip()
USER, PASSWORD = "check", "synthetic-check-only"
FIRST_UID = "2.25.202610270001"

checks = []
def record(name, ok, detail=None):
    item = {"name": name, "pass": bool(ok), "detail": detail}
    checks.append(item)
    print(("PASS " if ok else "FAIL ") + name + (" " + json.dumps(detail, ensure_ascii=False) if detail is not None else ""), flush=True)

# ── synthetic environment ──
if not (OUT / "sandbox").exists():
    subprocess.run([sys.executable, str(STUDIO / "deploy/make-sandbox.py"), "--repo", str(REPO), "--sha", SHA, "--out", str(OUT / "sandbox")], check=True, timeout=300)
with socket.socket() as s:
    s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
for folder in ["empty-ohif", "empty-dicomweb", "empty-claude", "data"]: (OUT / folder).mkdir(exist_ok=True)
config = {"listen": {"host": "127.0.0.1", "port": port},
          "paths": {"sandbox": str(OUT / "sandbox"), "sandboxRead": str(OUT / "sandbox-read"), "data": str(OUT / "data"),
                    "knowledge": str(STUDIO / "knowledge-seed"), "ohifDist": a.ohif or str(OUT / "empty-ohif"), "dicomweb": a.dicomweb or str(OUT / "empty-dicomweb")},
          "claude": {"bin": str(OUT / "unavailable-claude"), "account": "synthetic", "configDirs": {"synthetic": str(OUT / "empty-claude")},
                     "python": "python", "shellTool": "PowerShell", "models": {"fast": "stub", "deep": "stub"}, "defaultChoice": "fast"}}
(OUT / "config.json").write_text(json.dumps(config), encoding="utf-8")
server_js = str(STUDIO / "server/server.js")
subprocess.run(["node", server_js, "set-password", USER, "Synthetic check", "--config", str(OUT / "config.json")],
               input=PASSWORD + "\n", text=True, check=True, timeout=60, cwd=REPO)
BASE = f"http://127.0.0.1:{port}"

def frame(page, sel="#product"): return page.locator(sel).element_handle().content_frame()
def rows_ready(page, sel="#product"):
    page.wait_for_function('s => { const f = document.querySelector(s); return f && f.contentDocument && f.contentDocument.querySelector("#rows tr[data-uid]"); }', arg=sel, timeout=20000)
def settle(page, ms=400): page.wait_for_timeout(ms)
def click_at(page, locator):
    r = locator.bounding_box(); page.mouse.click(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); settle(page, 200)
def chips(chat): return chat.locator("#chips .chip")
def shield_on(page): return page.locator(".pick-shield").is_visible()
def loads(product): return product.evaluate("window.__loads")
def boxes(product): return product.evaluate('() => [...document.querySelectorAll(".pick-box.picked")].map(n => ({ hidden: n.hidden, ...n.getBoundingClientRect().toJSON() }))')
def near(box, rect, tol=2): return box and rect and not box["hidden"] and all(abs(box[k] - rect[j]) <= tol for k, j in [("x", "x"), ("y", "y"), ("width", "width"), ("height", "height")])
def login(page):
    page.goto(BASE + "/studio/login.html"); page.fill("[name=user]", USER); page.fill("[name=password]", PASSWORD)
    page.click("button[type=submit]"); page.wait_for_url("**/studio/studio.html")
def post_api(page, path):
    return page.evaluate('async p => { const r = await fetch("/studio-api/" + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Studio": "1" }, body: "{}" }); return r.status; }', path)
# BarProp.visible is false for a popup (HTML "is popup"); outer-inner height is the window chrome (tab strip, toolbar, bookmarks).
def bars(page):
    return page.evaluate("() => ({ toolbar: window.toolbar.visible, menubar: window.menubar.visible, locationbar: window.locationbar.visible, chrome: window.outerHeight - window.innerHeight, outer: [window.outerWidth, window.outerHeight] })")
def product_path(page): return page.evaluate('document.querySelector("#product").contentWindow.location.pathname')
def on_admin(page): page.wait_for_function('() => { const d = document.querySelector("#product").contentDocument; return d && d.location.pathname.endsWith("admin.html") && d.querySelector("#users td.username"); }', timeout=15000)
def member_row(f, name): return f.locator("#users tr").filter(has_text=name)
def row_action(f, name, label): member_row(f, name).locator("td.actions button", has_text=label).first.click()

log = (OUT / "server.log").open("w", encoding="utf-8")
server = subprocess.Popen(["node", server_js, "--config", str(OUT / "config.json")], cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
try:
    for _ in range(100):
        try: urllib.request.urlopen(BASE + "/studio/login.html", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=False) if a.headed else p.chromium.launch(headless=True)
        ctx = browser.new_context(no_viewport=True) if a.headed else browser.new_context(viewport={"width": 1800, "height": 1000})
        ctx.add_init_script("(() => { const Native = window.EventSource; window.__sources = []; window.EventSource = class extends Native { constructor(...x) { super(...x); window.__sources.push(this); } }; })()")
        chat = ctx.new_page(); login(chat)

        # F3: the showcase pick card with no product window opens it AND starts picking there.
        chat.locator("#panel[open]").wait_for()
        with ctx.expect_page() as popup:
            chat.locator(".card").filter(has=chat.locator("strong", has_text="가리키고 말하기")).click()
        product = popup.value; product.wait_for_url("**/studio/product.html"); rows_ready(product)
        product.wait_for_selector(".pick-shield", state="visible", timeout=5000)
        chat.wait_for_function('document.querySelector("#pick").classList.contains("on")', timeout=5000)
        record("F3 pick card opens the product window and starts picking", shield_on(product), {"chatPickButton": chat.inner_text("#pick")})
        product.keyboard.press("Escape"); settle(product, 200)
        record("F3 Esc leaves the started pick mode", not shield_on(product))

        # W1: the product window is an ordinary browser tab like the chat (not a popup without tab strip/bookmarks).
        pb, cb = bars(product), bars(chat)
        record("W1 the product window opens as an ordinary tab (toolbar/menubar/locationbar visible, same window chrome as the chat tab)",
               pb["toolbar"] and pb["menubar"] and pb["locationbar"] and (not a.headed or pb["chrome"] == cb["chrome"]),
               {"product": pb, "chat": cb, "headed": a.headed})
        product.screenshot(path=str(OUT / "w1-product-tab.png"))
        pages_before = len(ctx.pages)
        chat.click("#open-product"); settle(chat, 800)
        record("W2 '제품 화면 앞으로' from the opener tab reuses the same product tab", len(ctx.pages) == pages_before
               and sum(pg.url.endswith("product.html") for pg in ctx.pages) == 1, {"pagesBefore": pages_before, "pagesAfter": len(ctx.pages)})

        product.evaluate('() => { window.__loads = 0; document.querySelector("#product").addEventListener("load", () => window.__loads++); }')
        f = frame(product)
        f.locator(f'#rows tr[data-uid="{FIRST_UID}"]').click(); settle(product, 700)

        # F6: a focused product button cannot be pressed from the keyboard while picking.
        f.locator("#b-save").focus()
        f.evaluate('() => { window.__saveClicks = 0; document.querySelector("#b-save").addEventListener("click", () => window.__saveClicks++); }')
        product.keyboard.press("Alt+KeyG"); settle(product, 200)
        product.keyboard.press("Space"); product.keyboard.press("Enter"); settle(product, 300)
        record("F6 Space/Enter on the focused Save while picking do not press it", shield_on(product) and f.evaluate("window.__saveClicks") == 0,
               {"saveClicks": f.evaluate("window.__saveClicks"), "picking": shield_on(product), "focus": product.evaluate("document.activeElement.className")})
        product.keyboard.press("Escape"); settle(product, 200)

        # F9: an edit that arrives while he is typing waits for Apply Now even when picking has taken the keyboard.
        area = f.locator("textarea:visible").first
        sample = "Synthetic unsent typing sample"
        area.fill(sample); area.focus(); settle(product, 150)
        field_id = area.get_attribute("id")
        before = loads(product)
        product.keyboard.press("Alt+KeyG"); settle(product, 200)
        chat.evaluate('e => window.__sources[0].onmessage({ data: JSON.stringify(e) })', {"type": "reload", "reason": "edit", "sha": "check-typing", "jobId": "check-typing", "eventId": "check-typing-1"})
        settle(product, 1000)
        pending = product.locator("#pending").is_visible()
        record("F9 an edit while typing stays deferred when picking has the keyboard", shield_on(product) and pending and loads(product) == before,
               {"field": field_id, "picking": shield_on(product), "pending": pending, "loads": loads(product) - before})
        product.keyboard.press("Escape"); settle(product, 200)
        back = f.evaluate("() => ({ id: document.activeElement && document.activeElement.id, value: document.activeElement && document.activeElement.value })")
        record("F9 leaving pick mode gives the keyboard back to the field with the text", back["id"] == field_id and back["value"] == sample, back)
        product.click("#apply-now"); product.wait_for_function(f"window.__loads > {before}"); rows_ready(product)
        product.wait_for_function('() => document.querySelector("#product").contentDocument.querySelector("#b-save")', timeout=10000); settle(product, 1500)
        record("F9 Apply Now reloads the deferred edit once", loads(product) - before == 1 and not product.locator("#pending").is_visible(), {"loads": loads(product) - before})
        f = frame(product)

        # Pointer picks never reach the product.
        f.evaluate('() => { window.__pointer = 0; for (const t of ["pointerdown", "mousedown", "click"]) document.addEventListener(t, () => window.__pointer++, true); }')
        product.click("#pick"); click_at(product, f.locator("#b-save")); click_at(product, f.locator("#b-approve"))
        record("two pointer picks reach the chat without any product pointer event", chips(chat).count() == 2 and f.evaluate("window.__pointer") == 0,
               {"chips": chips(chat).count(), "pointerEvents": f.evaluate("window.__pointer")})

        # F1: after a reload the outlines rebind to the new document, and clicking Save again removes that pick.
        before = loads(product)
        chat.click("#reload"); product.wait_for_function(f"window.__loads > {before}"); rows_ready(product)
        product.wait_for_function('() => document.querySelector("#product").contentDocument.querySelector("#b-save")', timeout=10000); settle(product, 700)
        f = frame(product)
        b = boxes(product); save_r = f.locator("#b-save").bounding_box(); appr_r = f.locator("#b-approve").bounding_box()
        record("F1 both outlines follow the reloaded Save/Approve", len(b) == 2 and near(b[0], save_r) and near(b[1], appr_r), {"boxes": b, "save": save_r, "approve": appr_r})
        product.screenshot(path=str(OUT / "f1-after-reload.png"))
        click_at(product, f.locator("#b-save")); settle(chat, 300)
        record("F1 clicking the reloaded Save removes its pick", chips(chat).count() == 1 and "Approve" in chat.inner_text("#chips"), {"chips": chat.inner_text("#chips")})
        product.keyboard.press("Escape"); settle(chat, 300)
        record("Esc clears the picks in the chat", chips(chat).count() == 0)

        # F2: a picked worklist cell stays on its study when the list is sorted; a study that is gone shows as lost.
        idx = f.evaluate('() => { const th = document.querySelector("th[data-key=name]"); return [...th.parentElement.children].indexOf(th); }')
        cell = f.locator(f'#rows tr[data-uid="{FIRST_UID}"] > td').nth(idx); cell.scroll_into_view_if_needed()
        picked_text = cell.inner_text()
        product.click("#pick"); click_at(product, cell); product.keyboard.press("Alt+KeyG"); settle(product, 200)
        selector = chips(chat).first.get_attribute("title").split("\n")[0]
        f.locator("th[data-key=name]").click(); f.locator("th[data-key=name]").click(); settle(product, 600)
        order = f.evaluate('() => [...document.querySelectorAll("#rows tr[data-uid]")].map(r => r.dataset.uid)')
        cell = f.locator(f'#rows tr[data-uid="{FIRST_UID}"] > td').nth(idx)
        # E2: after the sort the cell sits below the scrolling list's visible part; its outline must stay inside the list.
        view = f.evaluate(f'''() => {{
            const cell = document.querySelectorAll('#rows tr[data-uid="{FIRST_UID}"] > td')[{idx}];
            let list = cell.parentElement;
            while (list && !/(auto|scroll)/.test(getComputedStyle(list).overflowY)) list = list.parentElement;
            const r = list.getBoundingClientRect();
            return {{ cell: cell.getBoundingClientRect().toJSON(), list: {{ top: r.top + list.clientTop, bottom: r.top + list.clientTop + list.clientHeight }} }};
        }}''')
        off = product.evaluate('() => document.querySelector("#product").getBoundingClientRect().toJSON()')
        b = boxes(product)
        clipped = view["cell"]["bottom"] > view["list"]["bottom"] or view["cell"]["top"] < view["list"]["top"]
        inside = len(b) == 1 and (b[0]["hidden"] or (b[0]["y"] >= off["y"] + view["list"]["top"] - 1 and b[0]["y"] + b[0]["height"] <= off["y"] + view["list"]["bottom"] + 1))
        record("E2 a picked cell scrolled out of the list leaves no outline over the controls below", clipped and inside,
               {"cellOutsideList": clipped, "cellInFrame": view["cell"], "listInFrame": view["list"], "frame": off, "box": b})
        product.screenshot(path=str(OUT / "e2-scrolled-out.png"))
        cell.scroll_into_view_if_needed(); settle(product, 300)
        b = boxes(product); cell_r = cell.bounding_box()
        record("F2 the picked Name cell follows its study after sorting", "data-uid" in selector and order[0] != FIRST_UID and len(b) == 1 and near(b[0], cell_r)
               and "lost" not in (chips(chat).first.get_attribute("class") or ""),
               {"selector": selector, "pickedText": picked_text, "firstRowNow": order[0], "box": b, "cell": cell_r, "chip": chat.inner_text("#chips")})
        product.screenshot(path=str(OUT / "f2-after-sort.png"))
        # A filter or a new list can drop the study: emulated by removing its row in the frame (test-side only).
        f.evaluate(f'() => document.querySelector(\'#rows tr[data-uid="{FIRST_UID}"]\').remove()')
        chat.wait_for_function('() => { const c = document.querySelector("#chips .chip"); return c && c.classList.contains("lost"); }', timeout=5000)
        b = boxes(product)
        record("F2 a pick whose study is gone shows as lost, not on another row", len(b) == 1 and b[0]["hidden"], {"chip": chat.inner_text("#chips"), "box": b})
        chat.click("#picks-clear"); settle(chat, 300)

        # F2: a CT cell picked while the search shows one study stays on that study when other CT studies come back.
        rows = f.evaluate('() => [...document.querySelectorAll("#rows tr[data-uid]")].map(r => ({ uid: r.dataset.uid, cells: [...r.children].map(c => c.innerText.trim()) }))')
        ct = [r for r in rows if "CT" in r["cells"]]
        target = next(r for r in reversed(ct) if sum(x["cells"][idx] == r["cells"][idx] for x in rows) == 1)
        ct_idx = target["cells"].index("CT")
        f.locator("#quick").fill(target["cells"][idx]); f.locator("#quick").press("Enter"); settle(product, 800)
        shown_rows = f.locator("#rows tr[data-uid]").count()
        cell = f.locator(f'#rows tr[data-uid="{target["uid"]}"] > td').nth(ct_idx); cell.scroll_into_view_if_needed()
        product.click("#pick"); click_at(product, cell); product.keyboard.press("Alt+KeyG"); settle(product, 200)
        selector = chips(chat).first.get_attribute("title").split("\n")[0]
        def picked_study():
            # Which study the outline is drawn on: the row under the outline's centre, read in the product frame.
            box = boxes(product)[0]; off = product.evaluate('() => document.querySelector("#product").getBoundingClientRect().toJSON()')
            if box["hidden"]: return None
            return f.evaluate('([x, y]) => { const n = document.elementFromPoint(x, y); const tr = n && n.closest("tr[data-uid]"); return tr ? tr.dataset.uid : n && n.tagName; }',
                              [box["x"] - off["x"] + box["width"] / 2, box["y"] - off["y"] + box["height"] / 2])
        for step, act in [("the search is cleared", lambda: f.locator("#clearfilter").click()), ("the CT folder lists every CT study", lambda: f.get_by_text("CT (4)", exact=True).click())]:
            act(); settle(product, 1800)
            listed = f.locator("#rows tr[data-uid]").count()
            present = f.locator(f'#rows tr[data-uid="{target["uid"]}"]').count() == 1
            if present:
                f.locator(f'#rows tr[data-uid="{target["uid"]}"] > td').nth(ct_idx).scroll_into_view_if_needed(); settle(product, 300)
            on = picked_study(); lost = "lost" in (chips(chat).first.get_attribute("class") or "")
            record(f"F2 a cell picked in a filtered list stays on its study when {step}",
                   shown_rows == 1 and listed > 1 and "data-uid" in selector and (on == target["uid"] if present else (on is None and lost)),
                   {"study": target["uid"], "selector": selector, "rowsWhenPicked": shown_rows, "rowsNow": listed, "outlineOn": on, "lost": lost})
        product.screenshot(path=str(OUT / "f2-filter-cleared-ct-folder.png"))
        chat.click("#picks-clear"); settle(chat, 300)

        # F5 + F7: two chat tabs; screen/role follow the product in both; each reset reloads once.
        chat.select_option("#role", "admin"); rows_ready(product)
        second = ctx.new_page(); second.goto(BASE + "/studio/studio.html"); second.wait_for_function('document.querySelector("#link-dot").classList.contains("on")')
        second.select_option("#screen", "/worklist/hpacs-lite/admin.html")
        product.wait_for_function('document.querySelector("#product").contentWindow.location.pathname.endsWith("admin.html")'); settle(product, 1000)
        values = {"product": frame(product).url, "first": chat.input_value("#screen"), "second": second.input_value("#screen")}
        record("F5 both chat tabs show the screen the product window shows", values["first"] == values["second"] == "/worklist/hpacs-lite/admin.html", values)
        second.select_option("#role", "technician"); settle(product, 1000)
        values = {"first": chat.input_value("#role"), "second": second.input_value("#role")}
        record("F5 both chat tabs show the role the product window uses", values["first"] == values["second"] == "technician", values)
        second.select_option("#screen", "/worklist/hpacs-lite/main.html"); second.select_option("#role", "radiologist"); rows_ready(product); settle(product, 800)
        before = loads(product)
        s1 = post_api(chat, "mock/reset"); product.wait_for_function(f"window.__loads >= {before + 1}", timeout=10000); rows_ready(product); settle(product, 500)
        s2 = post_api(chat, "mock/reset"); product.wait_for_function(f"window.__loads >= {before + 2}", timeout=10000); settle(product, 1500)
        record("F7 two mock resets reload the product twice (once each, two chat tabs open)", loads(product) - before == 2, {"loads": loads(product) - before, "status": [s1, s2]})
        before = loads(product)
        for page in [chat, second]:
            page.evaluate('e => window.__sources[0].onmessage({ data: JSON.stringify(e) })', {"type": "reload", "reason": "edit", "sha": "check-edit", "jobId": "check-job", "eventId": "check-1"})
        settle(product, 1500)
        record("an edit reload relayed by two chat tabs reloads once", loads(product) - before == 1, {"loads": loads(product) - before})
        second.close()

        # E1: Worklist -> clinician -> reload chat -> radiologist returns to the Worklist.
        chat.select_option("#screen", "/worklist/hpacs-lite/main.html"); rows_ready(product)
        chat.select_option("#role", "clinician")
        product.wait_for_function('document.querySelector("#product").contentWindow.location.pathname.endsWith("clinician.html")'); settle(product, 600)
        chat.reload(); chat.wait_for_function('document.querySelector("#link-dot").classList.contains("on")'); settle(chat, 300)
        chat.select_option("#role", "radiologist")
        product.wait_for_function('document.querySelector("#product").contentWindow.location.pathname.endsWith("main.html")', timeout=10000)
        record("E1 role roundtrip after a chat reload returns to the Worklist", chat.input_value("#screen").endswith("main.html"), {"product": frame(product).url, "screen": chat.input_value("#screen")})

        # F4: a chat reopened in a fresh tab brings the connected product forward instead of opening a second one.
        chat.close()
        reopen = ctx.new_page(); reopen.goto(BASE + "/studio/studio.html"); reopen.wait_for_function('document.querySelector("#link-dot").classList.contains("on")')
        pages_before = len(ctx.pages)
        reopen.click("#open-product"); settle(reopen, 1200)
        record("F4 reopened chat reuses the product window", len(ctx.pages) == pages_before and sum(pg.url.endswith("product.html") for pg in ctx.pages) == 1,
               {"pagesBefore": pages_before, "pagesAfter": len(ctx.pages), "linkText": reopen.inner_text("#link-text")})

        # V1: the Viewer choice opens the viewer the way the product does (a sized popup), not inside the product tab.
        shown = product_path(product)
        with ctx.expect_page() as popup:
            reopen.select_option("#screen", "viewer")
        viewer = popup.value; viewer.wait_for_load_state()
        vb = bars(viewer)
        record("V1 the Viewer choice opens a popup viewer window; the product tab keeps its screen",
               "/ohif/viewer" in viewer.url and not vb["toolbar"] and product_path(product) == shown and reopen.input_value("#screen") != "viewer",
               {"url": viewer.url, "viewer": vb, "productScreen": product_path(product), "select": reopen.input_value("#screen")})
        if a.ohif:
            try: viewer.wait_for_selector("canvas", timeout=30000); settle(viewer, 3000)
            except Exception as e: record("V1 viewer renders a canvas", False, {"error": repr(e)})
        viewer.screenshot(path=str(OUT / "v1-viewer-popup.png"))
        pages_before = len(ctx.pages)
        reopen.select_option("#screen", "viewer"); settle(reopen, 800)
        record("V1 choosing Viewer again reuses the open viewer window", len(ctx.pages) == pages_before, {"pagesBefore": pages_before, "pagesAfter": len(ctx.pages)})
        viewer.close()
        # V2: the worklist's own viewer launch (double-click) is the product's popup, unchanged inside the studio.
        reopen.select_option("#screen", "/worklist/hpacs-lite/main.html"); rows_ready(product); settle(product, 800)
        f = frame(product)
        try:
            with ctx.expect_page(timeout=15000) as popup:
                f.locator(f'#rows tr[data-uid="{FIRST_UID}"]').dblclick()
            own = popup.value; own.wait_for_load_state()
            ob = bars(own)
            record("V2 the worklist's double-click opens the product's own viewer popup", not ob["toolbar"], {"url": own.url, "viewer": ob})
            own.close()
        except Exception as e:
            record("V2 the worklist's double-click opens the product's own viewer popup", False, {"error": repr(e)})

        # A1: role 관리자 opens admin.html in the product tab with no redirect; the showcase card does the same.
        reopen.select_option("#role", "admin"); on_admin(product); settle(product, 2000)
        record("A1 role 관리자 opens Admin (no redirect to the worklist) and lists members",
               product_path(product).endswith("admin.html") and reopen.input_value("#screen").endswith("admin.html"),
               {"product": product_path(product), "members": frame(product).locator("#users td.username").count()})
        reopen.select_option("#role", "radiologist")
        product.wait_for_function('document.querySelector("#product").contentWindow.location.pathname.endsWith("main.html")', timeout=10000)
        record("A1 leaving 관리자 returns the product to the worklist", reopen.input_value("#screen").endswith("main.html"), {"product": product_path(product)})
        reopen.click("#showcase"); reopen.locator("#panel[open]").wait_for()
        reopen.locator(".card").filter(has=reopen.locator("strong", has_text="관리자 화면 둘러보기")).click()
        on_admin(product); settle(product, 1500)
        record("A1 the '관리자 화면 둘러보기' card switches the role to 관리자 and opens Admin",
               reopen.input_value("#role") == "admin" and product_path(product).endswith("admin.html"), {"role": reopen.input_value("#role"), "product": product_path(product)})

        # A2: the admin screens work against the studio mock.
        f = frame(product)
        def dialog_text(sel): return f.locator(sel).inner_text()
        row_action(f, "PARK RESIDENT", "Approve")
        form = f.locator("#membership-form"); form.locator("[name=institution]").fill("kin-center")
        form.locator('input[name=role][value=radiologist]').check(); form.locator("button[type=submit]").click(); settle(product, 800)
        refused = f.locator("#message").inner_text()
        row_action(f, "PARK RESIDENT", "Approve")
        form.locator("[name=institution]").fill("kin-center"); form.locator('input[name=role][value=radiologist]').check()
        form.locator("[name=verificationOverride]").check(); form.locator("button[type=submit]").click(); settle(product, 1000)
        record("A2 Approve Member: unverified email refused, in-person override approves", "이메일" in refused and "APPROVED" in member_row(f, "PARK RESIDENT").inner_text(),
               {"refused": refused, "row": member_row(f, "PARK RESIDENT").inner_text()})
        row_action(f, "NEW DOCTOR", "Temp Password"); settle(product, 600)
        temp = dialog_text("#temporary-password")
        record("A2 Temp Password shows a one-time password", f.locator("#password-dialog[open]").count() == 1 and len(temp) >= 12, {"length": len(temp)})
        f.locator("#close-password").click()
        row_action(f, "NEW DOCTOR", "Email Reset Link"); settle(product, 600)
        record("A2 Email Reset Link says the studio has no mail server (no silent success)", "스튜디오 미지원" in f.locator("#message").inner_text(), {"message": f.locator("#message").inner_text()})
        row_action(f, "JUNG LOCUM", "Activate"); settle(product, 800)
        record("A2 Activate a suspended member", "SUSPENDED" not in member_row(f, "JUNG LOCUM").inner_text(), {"row": member_row(f, "JUNG LOCUM").inner_text()})
        row_action(f, "HAN MINSU", "Signing Key")
        key = f.locator("#signing-key-dialog"); key.locator("[data-status]").filter(has_text="No Active Key").wait_for(timeout=5000)
        key.locator("[name=reason]").fill("synthetic check"); key.locator('[data-action="provision"]').click(); settle(product, 800)
        record("A2 Signing Key: create a key for a technician", "Created" in key.locator("[data-status]").inner_text() and key.locator("[data-rows] tr").count() == 1,
               {"status": key.locator("[data-status]").inner_text()})
        key.locator("[name=reason]").fill("synthetic rotate"); key.locator('[data-action="replace"]').click(); settle(product, 800)
        record("A2 Signing Key: rotate keeps the retired key listed", "Rotated" in key.locator("[data-status]").inner_text() and key.locator("[data-rows] tr").count() == 2,
               {"status": key.locator("[data-status]").inner_text()})
        product.screenshot(path=str(OUT / "a2-signing-key.png"))
        key.locator("[data-close]").click()
        row_action(f, "HAN MINSU", "Study Access")
        acc = f.locator("#study-access-dialog"); acc.locator("[data-status]").filter(has_text="Revision 0").wait_for(timeout=5000)
        acc.locator("[name=mode]").select_option("rules"); acc.locator("[data-add]").click()
        acc.locator('[data-field="modalities"]').fill("CT, MR"); acc.locator("[name=reason]").fill("synthetic check"); acc.locator("[data-save]").click(); settle(product, 800)
        record("A2 Study Access: save a Matching Studies rule", "Saved · Revision 1" in acc.locator("[data-status]").inner_text(), {"status": acc.locator("[data-status]").inner_text()})
        acc.locator("[data-reload]").click(); settle(product, 600)
        record("A2 Study Access: Reload shows the saved rule", "Revision 1" in acc.locator("[data-status]").inner_text() and acc.locator('[data-field="modalities"]').input_value() == "CT, MR",
               {"status": acc.locator("[data-status]").inner_text()})
        acc.locator("[data-close]").click()
        f.locator("#gateway-refresh").click(); f.locator("#gateway-rows li").first.wait_for(timeout=10000); settle(product, 400)
        retry = f.locator("#gateway-rows li button:visible", has_text="Now Retry")
        has_retry = retry.count() == 1
        if has_retry: retry.click(); settle(product, 800)
        record("A2 Gateway Status lists the receipts and Now Retry stores a request", f.locator("#gateway-rows li").count() >= 2 and has_retry
               and "Retry Requested" in f.locator("#gateway-rows").inner_text(), {"state": f.locator("#gateway-list-state").inner_text(), "counts": f.locator("#gateway-counts").inner_text()})
        f.locator("#metrics-refresh").click(); f.locator("#metrics-rows tr").first.wait_for(timeout=10000); settle(product, 300)
        metric_states = f.evaluate('() => [...document.querySelectorAll("#metrics-rows tr")].map(r => r.children[1].textContent)')
        record("A2 Operations shows all eleven metrics, none unreadable except the sourceless one", f.locator("#metrics-rows tr").count() == 11
               and f.locator("#metrics-state").inner_text().startswith("Observed") and metric_states.count("Unobservable") == 1, {"states": metric_states})
        f.locator("#audit-refresh").click(); f.locator("#audit-rows tr").first.wait_for(timeout=10000); settle(product, 300)
        audit_text = f.locator("#audit-rows").inner_text()
        record("A2 Audit / Security lists this session's member changes", "admin.user.approve" in audit_text and "study.access" in audit_text
               and f.locator("#audit-state").inner_text().startswith("Loaded"), {"state": f.locator("#audit-state").inner_text(), "counts": f.locator("#audit-counts").inner_text()})
        utc = lambda d: time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + d))
        f.locator("#access-review-from").fill(utc(-86400)); f.locator("#access-review-until").fill(utc(3600)); f.locator("#access-review-load").click()
        f.wait_for_function('() => ["Loaded", "Partial", "No Events", "Query Failed"].includes(document.querySelector("#access-review-state").textContent)', timeout=10000)
        record("A2 Access Review loads the day's access events", f.locator("#access-review-state").inner_text() in ("Loaded", "Partial") and f.locator("#access-review-rows tr").count() >= 3,
               {"state": f.locator("#access-review-state").inner_text(), "rows": f.locator("#access-review-rows tr").count()})
        product.screenshot(path=str(OUT / "a2-admin.png"), full_page=True)
        f.locator("main").screenshot(path=str(OUT / "a2-admin-main.png"))
        reopen.select_option("#role", "radiologist"); rows_ready(product)

        # F8: overlay — a resize while picking keeps "reopen the chat when picking ends".
        product.close(); settle(reopen, 300)
        reopen.select_option("#layout", "overlay"); reopen.wait_for_function('document.body.dataset.layout === "overlay"'); rows_ready(reopen, "#mirror"); settle(reopen, 400)
        opened = reopen.locator("#studio.open").count() == 1
        reopen.click("#pick"); settle(reopen, 250)
        hidden_while_picking = reopen.locator("#studio.open").count() == 0 and shield_on(reopen)
        reopen.set_viewport_size({"width": 1400, "height": 1000}); settle(reopen, 300)
        reopen.keyboard.press("Alt+KeyG"); settle(reopen, 300)
        record("F8 overlay chat comes back after picking with a resize in between",
               opened and hidden_while_picking and reopen.locator("#studio.open").count() == 1 and not shield_on(reopen),
               {"openBefore": opened, "hiddenWhilePicking": hidden_while_picking, "openAfter": reopen.locator("#studio.open").count() == 1})
        reopen.screenshot(path=str(OUT / "f8-overlay-after-resize.png"))
        reopen.evaluate("() => localStorage.setItem('studio-layout', 'two')")
        browser.close()
except Exception as e:
    traceback.print_exc(); checks.append({"name": "harness completion", "pass": False, "error": repr(e)})
finally:
    server.terminate()
    try: server.wait(timeout=10)
    except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=10)
    log.close()
    (OUT / "results.json").write_text(json.dumps({"sha": SHA, "checks": checks}, ensure_ascii=False, indent=2), encoding="utf-8")
failed = [c["name"] for c in checks if not c["pass"]]
print(f"{len(checks) - len(failed)}/{len(checks)} passed" + (f"; failed: {failed}" if failed else ""), flush=True)
sys.exit(1 if failed or not checks else 0)
