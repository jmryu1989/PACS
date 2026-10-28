"""Real-browser check of the studio chat window <-> product window boundary (synthetic data only).

usage: python tools/minhoon-studio/test/browser_check.py --out <folder> [--sha <commit for the sandbox>]

Builds a throwaway synthetic sandbox (deploy/make-sandbox.py), sets a throwaway login, starts the real studio server
on a free local port and drives the served studio.html / product.html in headless Chromium (Python Playwright; node on
PATH). Only test-side observers are added (an iframe load counter in the product window, a click counter in the
product frame, a hook on the chat's EventSource, load/pointer/key counters in the viewer popup, the admin answers
read off the network, and one chat send answered by the test so its picks can be read without a Claude turn); no
product or studio code is replaced. Writes <out>/results.json and
screenshots; exit 1 if any check fails. Adapted from the GPT functional review scripts of 9f4437c.
"""
import argparse, json, os, pathlib, re, socket, subprocess, sys, time, traceback, urllib.request
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
ap.add_argument("--claude", help="real Claude Code CLI: runs the 먼저 제안하기 checks (real suggestions, preview timing, apply/undo, answers)")
ap.add_argument("--claude-config", help="CLAUDE_CONFIG_DIR of a logged-in account for --claude")
ap.add_argument("--feedback", help="Minhoon's feedback file the suggestions read (default: none)")
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
if a.claude:
    config["claude"].update({"bin": a.claude, "configDirs": {"synthetic": a.claude_config}, "models": {"fast": "sonnet", "deep": "opus"}, "turnTimeoutSec": 900})
if a.feedback:
    config["paths"]["feedback"] = a.feedback
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

LOADS = {}
def count_loads(page):
    # Test-side observer: document loads of a top-level page (the viewer popup reloads its whole page).
    if id(page) not in LOADS:
        LOADS[id(page)] = [0]
        page.on("load", lambda _p, c=LOADS[id(page)]: c.__setitem__(0, c[0] + 1))
    return LOADS[id(page)][0]
def wait_until(page, fn, timeout=15000):
    end = time.time() + timeout / 1000
    while time.time() < end:
        if fn(): return True
        page.wait_for_timeout(100)
    return fn()
def wait_loads(page, n, timeout=15000): return wait_until(page, lambda: count_loads(page) >= n, timeout)

def viewer_checks(viewer, chat, product):
    """The viewer popup: review F1 of 60130f6 (reloads after a chat refresh) and Minhoon's 2026-10-28 request (고르기)."""
    viewer.wait_for_selector("canvas", timeout=30000); viewer.wait_for_selector(".studio-widget", timeout=10000); settle(viewer, 2000)
    count_loads(viewer)
    chat.reload(); chat.wait_for_function('document.querySelector("#link-dot").classList.contains("on")'); settle(chat, 2500)
    n = count_loads(viewer); s = post_api(chat, "mock/reset")
    reloaded = wait_loads(viewer, n + 1); settle(viewer, 2500)
    record("V3 after the chat tab is refreshed a studio reset still reloads the open viewer, once", reloaded and count_loads(viewer) == n + 1,
           {"loads": count_loads(viewer) - n, "status": s})
    second = chat.context.new_page(); second.goto(BASE + "/studio/studio.html")
    second.wait_for_function('document.querySelector("#link-dot").classList.contains("on")'); settle(second, 2500)
    viewer.wait_for_selector("canvas", timeout=30000)
    n = count_loads(viewer); post_api(chat, "mock/reset"); wait_loads(viewer, n + 1); settle(viewer, 3000)
    record("V3 with two chat tabs open one reset reloads the viewer once", count_loads(viewer) == n + 1, {"loads": count_loads(viewer) - n})
    second.close()

    # V4: 고르기 in the viewer. Observers only (test side): OHIF's root counts pointer events, the document counts keys.
    viewer.wait_for_selector("canvas", timeout=30000); settle(viewer, 3000)
    viewer.evaluate('''() => { window.__ohif = { pointer: 0, keys: 0 }; const root = document.getElementById("root");
        for (const t of ["pointerdown", "mousedown", "click", "wheel"]) root.addEventListener(t, () => window.__ohif.pointer++, true);
        document.addEventListener("keydown", () => window.__ohif.keys++, true); }''')
    slice_at = lambda: viewer.evaluate('() => window.services.cornerstoneViewportService.getCornerstoneViewport("default").getCurrentImageIdIndex()')
    # Setup through OHIF's own service: the multi-slice series in the viewport, so a wheel that got through would move it.
    viewer.evaluate('''() => { const s = window.services; const many = s.displaySetService.getActiveDisplaySets().find(d => (d.numImageFrames || d.images?.length || 0) > 1);
        s.viewportGridService.setDisplaySetsForViewport({ viewportId: "default", displaySetInstanceUIDs: [many.displaySetInstanceUID] }); }''')
    settle(viewer, 3000)
    canvas = viewer.locator("canvas").first; c = canvas.bounding_box()
    viewer.mouse.move(c["x"] + c["width"] / 2, c["y"] + c["height"] / 2); before_wheel = slice_at(); viewer.mouse.wheel(0, 400); settle(viewer, 800)
    s0 = slice_at()
    wheel_works = s0 != before_wheel
    viewer.evaluate("window.__ohif = { pointer: 0, keys: 0 }")
    chat.click("#pick")
    viewer.wait_for_selector(".pick-shield", state="visible", timeout=5000)
    click_at(viewer, viewer.locator("#root button:visible").nth(1))
    click_at(viewer, canvas)
    viewer.mouse.move(c["x"] + c["width"] / 2, c["y"] + c["height"] / 2)
    viewer.mouse.wheel(0, 400); viewer.keyboard.press("ArrowDown"); viewer.keyboard.press("PageDown"); settle(viewer, 800)
    ohif = viewer.evaluate("window.__ohif")
    chip_text = chat.inner_text("#chips")
    record("V4 picking in the viewer: two picks reach the chat; no click, wheel or key reaches OHIF; the slice stays",
           wheel_works and chips(chat).count() == 2 and ohif == {"pointer": 0, "keys": 0} and slice_at() == s0 and "영상 창" in chip_text,
           {"chips": chip_text, "ohif": ohif, "wheelOutsidePicking": [before_wheel, s0], "sliceWhilePicking": [s0, slice_at()]})
    viewer.screenshot(path=str(OUT / "v4-viewer-picks.png"))
    n = count_loads(viewer); post_api(chat, "mock/reset"); wait_loads(viewer, n + 1)
    viewer.wait_for_selector("canvas", timeout=30000); settle(viewer, 4000)
    vb = boxes(viewer)
    lost = [chips(chat).nth(i).get_attribute("class") for i in range(chips(chat).count())]
    record("V4 viewer picks survive the viewer's reload and are drawn on the reloaded page", chips(chat).count() == 2 and not any("lost" in (x or "") for x in lost)
           and len(vb) == 2 and not any(b["hidden"] for b in vb), {"chips": lost, "boxes": vb})
    sent = {}
    def on_chat(route):
        sent["body"] = json.loads(route.request.post_data or "{}")
        route.fulfill(status=200, content_type="application/json", body='{"ok": true}')
    chat.route("**/studio-api/chat", on_chat)
    chat.fill("#input", "이거 영상 창에서 확인"); chat.press("#input", "Enter"); settle(chat, 1200)
    chat.unroute("**/studio-api/chat")
    picks = ((sent.get("body") or {}).get("context") or {}).get("picks") or []
    image = picks[1].get("image") if len(picks) == 2 else None
    record("V4 the request carries the viewer picks with their viewport, series and slice",
           bool(image) and image.get("viewportId") == "default" and bool(image.get("seriesInstanceUID")) and bool(re.match(r"^\d+/\d+$", image.get("slice") or ""))
           and all(p.get("page", "").startswith("/ohif/viewer") for p in picks), {"picks": picks})
    settle(viewer, 600)
    record("V4 sending clears the viewer picks", chips(chat).count() == 0 and len(boxes(viewer)) == 0, {"chips": chips(chat).count(), "boxes": boxes(viewer)})
    viewer.keyboard.press("Escape"); settle(viewer, 300)
    esc_off = not shield_on(viewer)
    chat.click("#pick"); settle(chat, 800)
    all_off = not shield_on(product) and not shield_on(viewer) and chat.inner_text("#pick") == "고르기"
    viewer.keyboard.press("Alt+KeyG"); settle(viewer, 300); alt_on = shield_on(viewer)
    viewer.locator(".studio-widget button").click(); settle(viewer, 300)
    record("V4 Esc leaves picking in the viewer; the chat's 고르기 turns every window off; Alt+G and the corner 고르기 work in the viewer",
           esc_off and all_off and alt_on and not shield_on(viewer), {"escOff": esc_off, "allOff": all_off, "altOn": alt_on})

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
        if a.ohif: viewer_checks(viewer, reopen, product)
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
            if a.ohif:
                own.wait_for_selector(".studio-widget", timeout=15000); settle(own, 2500)
                n = count_loads(own); s = post_api(reopen, "mock/reset")
                reloaded = wait_loads(own, n + 1); settle(own, 2500)
                record("V2 the worklist's own viewer popup has 고르기 and reloads once after a studio reset", reloaded and count_loads(own) == n + 1,
                       {"loads": count_loads(own) - n, "status": s})
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
        # A3 (review F2 of 60130f6): a rule the product refuses (reversed dates) is refused here too, and nothing is saved.
        acc.locator("[data-add]").click()
        acc.locator('[data-field="dateFrom"]').last.fill("2026-10-28"); acc.locator('[data-field="dateTo"]').last.fill("2026-10-01")
        acc.locator("[name=reason]").fill("synthetic reversed range"); acc.locator("[data-save]").click(); settle(product, 800)
        refused = acc.locator("[data-status]").inner_text()
        product.once("dialog", lambda d: d.accept())  # Reload asks before dropping the unsaved rule
        acc.locator("[data-reload]").click(); settle(product, 600)
        record("A3 Study Access: a reversed date range is refused as the product refuses it, and Revision 1 stays", "검사 접근 조건 형식을 확인하세요" in refused
               and "Saved" not in refused and "Revision 1" in acc.locator("[data-status]").inner_text() and acc.locator('[data-field="dateFrom"]').count() == 1,
               {"save": refused, "afterReload": acc.locator("[data-status]").inner_text()})
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
        f.locator("main").screenshot(path=str(OUT / "a2-admin-main.png"))  # before A4's 80 rows make it too tall to capture

        # A4 (review F3 of 60130f6): Load More after a change made between the pages repeats no record. More than a
        # page of synthetic records is made through the served mock API; the answers are read off the network (test side).
        change_js = '''async n => { const url = "/api/admin/users/studio-han-tech/study-access";
            for (let i = 0; i < n; i++) { const cur = await (await fetch(url)).json();
              const policy = (cur.revision + i) % 2 ? { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] }
                : { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [{ all: true }] };
              const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedOwner: cur.owner,
                revision: cur.revision, policy, reason: "synthetic page filler", requestId: crypto.randomUUID() }) });
              if (!r.ok) throw new Error("filler " + r.status); } }'''
        f.evaluate(change_js, 30)
        answers = []
        def grab(resp):
            if "/api/admin/audit" in resp.url and resp.request.method == "GET":
                try: answers.append((resp.url, resp.json()))
                except Exception: pass
        product.on("response", grab)
        f.locator("#audit-refresh").click(); wait_until(product, lambda: len(answers) >= 1); settle(product, 500)
        f.evaluate(change_js, 1)
        f.locator("#audit-more").click(); wait_until(product, lambda: len(answers) >= 2); settle(product, 800)
        a1, a2 = answers[0][1], answers[1][1]
        keys = [json.dumps(r, sort_keys=True) for r in a1["rows"] + a2["rows"]]
        record("A4 Audit Load More after a change in between: no repeated record, same total, every row shown",
               len(a1["rows"]) == 25 and len(a2["rows"]) > 0 and len(set(keys)) == len(keys) and a2["total"] == a1["total"]
               and f.locator("#audit-rows tr").count() == len(keys), {"pages": [len(a1["rows"]), len(a2["rows"])], "unique": len(set(keys)),
               "total": [a1["total"], a2["total"]], "shown": f.locator("#audit-rows tr").count()})
        answers.clear()
        f.locator("#access-review-load").click(); wait_until(product, lambda: len(answers) >= 1); settle(product, 500)
        f.evaluate(change_js, 1)
        f.locator("#access-review-more").click(); wait_until(product, lambda: len(answers) >= 2); settle(product, 800)
        ids = [e["eventId"] for _, page in answers[:2] for e in page["rows"]]
        record("A4 Access Review Load More after a change in between: no repeated event, every row shown",
               len(answers[0][1]["rows"]) == 25 and len(ids) > 25 and len(set(ids)) == len(ids) and f.locator("#access-review-rows tr").count() == len(ids),
               {"pages": [len(p["rows"]) for _, p in answers[:2]], "unique": len(set(ids)), "shown": f.locator("#access-review-rows tr").count()})
        product.remove_listener("response", grab)
        reopen.select_option("#role", "radiologist"); rows_ready(product)

        # S: 먼저 제안하기 with the real Claude CLI — prepared while idle in its own copy, one card, hidden while he types
        # or a change runs, previewed in one click (timed), applied as an undoable change, answers remembered, digest.
        if a.claude:
            chat = reopen
            def git_out(*args): return subprocess.check_output(["git", *args], cwd=OUT / "sandbox", text=True, encoding="utf-8").strip()
            def sug(page): return page.evaluate('async () => (await fetch("/studio-api/suggestions")).json()')
            def served(page, rel): return page.evaluate('async u => { const r = await fetch(u, { cache: "no-store" }); return r.ok ? await r.text() : null; }', "/worklist/" + rel[len("worklist-v0/"):])
            def disk(root, rel):
                p = OUT / root / rel
                return p.read_bytes().decode("utf-8") if p.exists() else None
            def card_visible(): return chat.locator("#suggest").is_visible()
            def fake(ev): chat.evaluate('e => window.__sources[0].onmessage({ data: JSON.stringify(e) })', ev)
            def wait_ready(not_ids, timeout_s=900, ask=True):
                deadline, asked = time.time() + timeout_s, 0
                while time.time() < deadline:
                    cur = sug(chat).get("current")
                    if cur and cur["status"] == "ready" and cur["id"] not in not_ids: return cur, asked
                    if not cur and ask and asked < 3:
                        # Nothing open and nothing being prepared (an earlier turn found nothing): ask as he would.
                        chat.click("#showcase"); chat.locator("#panel[open]").wait_for()
                        chat.locator(".card").filter(has=chat.locator("strong", has_text="먼저 제안하기")).click(); asked += 1
                    time.sleep(3)
                return None, asked
            chat.click("#showcase"); chat.locator("#panel[open]").wait_for()
            record("S0 the showcase has the '먼저 제안하기' card", chat.locator(".card strong", has_text="먼저 제안하기").count() == 1)
            chat.click("#panel-close")
            if product.evaluate("typeof window.__loads") != "number":
                product.evaluate('() => { window.__loads = 0; document.querySelector("#product").addEventListener("load", () => window.__loads++); }')
            head0 = git_out("rev-parse", "HEAD")
            t0 = time.time()
            cur, asked = wait_ready(set())
            if not cur:
                record("S1 a suggestion is prepared while idle (real Claude)", False, {"asked": asked, "events": [json.loads(l) for l in (OUT / "data/public/suggestions.jsonl").read_text(encoding="utf-8").splitlines()] if (OUT / "data/public/suggestions.jsonl").exists() else []})
                raise RuntimeError("no suggestion became ready")
            chat.wait_for_selector("#suggest:not([hidden])", timeout=10000)
            record("S1 a grounded suggestion is prepared while idle in its own copy and shown as one card; the studio screen is untouched",
                   len(cur["grounds"]) >= 1 and git_out("rev-parse", "HEAD") == head0 and chat.inner_text("#suggest-title") == cur["title"],
                   {"title": cur["title"], "kind": cur["kind"], "why": cur["why"], "grounds": cur["grounds"], "files": cur["files"], "prepareMs": cur["prepareMs"],
                    "askedViaShowcase": asked, "waitedS": round(time.time() - t0, 1)})
            chat.click("#suggest-why"); chat.screenshot(path=str(OUT / "s1-card.png")); chat.click("#suggest-why")

            chat.fill("#input", "입력 중인 문장"); settle(chat, 300)
            hidden_typing = not card_visible()
            chat.fill("#input", ""); settle(chat, 300)
            fake({"type": "job", "id": "check-run", "mode": "edit", "user": USER, "state": "running"}); settle(chat, 200)
            hidden_running = not card_visible()
            fake({"type": "job", "id": "check-run", "mode": "edit", "user": USER, "state": "done"}); settle(chat, 200)
            f = frame(product)
            f.locator(f'#rows tr[data-uid="{FIRST_UID}"]').click(); settle(product, 700)
            f.locator("textarea:visible").first.focus(); settle(product, 2600)
            hidden_product_typing = not card_visible()
            f.evaluate("() => document.activeElement && document.activeElement.blur()"); settle(product, 2600)
            record("S2 the card stays out of the way while he types (chat or product) or a change runs, and comes back after",
                   hidden_typing and hidden_running and hidden_product_typing and card_visible(),
                   {"hiddenWhileTypingInChat": hidden_typing, "hiddenWhileRunning": hidden_running, "hiddenWhileTypingInProduct": hidden_product_typing, "backAfter": card_visible()})

            files = [x for x in cur["files"] if x.startswith("worklist-v0/")]
            sug_files = sug(chat)["current"]["files"]
            main_text = {x: disk("sandbox", x) for x in files}
            prev_text = {x: disk("sandbox-preview", x) for x in files}
            samples = []
            for i in range(3):
                before = loads(product); started = time.time()
                chat.click("#suggest-preview")
                product.wait_for_function(f"window.__loads > {before}", timeout=30000); rows_ready(product)
                harness_ms = round((time.time() - started) * 1000)
                chat.wait_for_function('document.querySelector("#suggest-note").textContent.includes("초")', timeout=30000)
                s = {"note": chat.inner_text("#suggest-note"), "harnessClickToRowsMs": harness_ms, "banner": product.locator("#preview-banner").is_visible(),
                     "bannerTitle": product.inner_text("#preview-title"), "servedPreview": all(served(product, x) == prev_text[x] for x in files)}
                if i == 0: product.screenshot(path=str(OUT / "s3-preview.png"))
                if i < 2:
                    before = loads(product)
                    chat.click("#suggest-preview")  # 원래대로
                    product.wait_for_function(f"window.__loads > {before}", timeout=30000); rows_ready(product); settle(product, 300)
                    s["afterStopServedMain"] = all(served(product, x) == main_text[x] for x in files)
                    s["bannerAfterStop"] = product.locator("#preview-banner").is_visible()
                samples.append(s)
                settle(chat, 500)
            record("S3 미리보기 shows the pre-built preview in the product window in one click (banner says it is not applied); 원래대로 shows the studio screen again",
                   bool(files) and all(s["banner"] and s["servedPreview"] for s in samples) and all(s.get("afterStopServedMain") and not s.get("bannerAfterStop") for s in samples[:2]),
                   {"files": sug_files, "samples": samples})

            before = loads(product)
            product.click("#preview-apply")
            product.wait_for_function(f"window.__loads > {before}", timeout=60000); rows_ready(product); settle(product, 800)
            sha = git_out("log", "-1", "--format=%H")
            sid = git_out("log", "-1", "--format=%(trailers:key=Studio-Suggestion,valueonly,separator=%x2C)")
            kind = git_out("log", "-1", "--format=%(trailers:key=Studio-Kind,valueonly,separator=%x2C)")
            applied_msg = chat.locator("#messages li.assistant").last
            record("S4 적용 (from the preview banner) lands the change on the studio branch as an ordinary change; the screen shows it without the preview",
                   sid.strip() == cur["id"] and kind.strip() == "change" and all(served(product, x) == prev_text[x] for x in files)
                   and not product.locator("#preview-banner").is_visible() and applied_msg.locator("button", has_text="되돌리기").count() == 1,
                   {"sha": sha, "trailer": sid, "kind": kind, "message": applied_msg.inner_text()[:300]})
            before = loads(product)
            applied_msg.locator("button", has_text="되돌리기").click()
            product.wait_for_function(f"window.__loads > {before}", timeout=60000); rows_ready(product); settle(product, 500)
            record("S4 되돌리기 takes the applied suggestion back out", all(served(product, x) == main_text[x] for x in files), {"head": git_out("log", "-1", "--format=%s")})

            cur2, _ = wait_ready({cur["id"]}, ask=True)
            cur3 = None
            if cur2:
                chat.wait_for_selector("#suggest:not([hidden])", timeout=10000)
                chat.click("#suggest-next")
                settle(chat, 300)
                waiting = chat.locator("#suggest-wait").is_visible()
                cur3, _ = wait_ready({cur["id"], cur2["id"]}, ask=True)
            if cur3:
                chat.wait_for_selector("#suggest:not([hidden])", timeout=10000)
                chat.click("#suggest-no"); settle(chat, 1000)
            titles = [c and c["title"] for c in (cur, cur2, cur3)]
            after = sug(chat).get("current")
            # 됐어요 closes this one; the next one may start preparing at once (he is idle), never the same one again.
            record("S5 다른 제안 and 됐어요 each lead to a different suggestion; none repeats an answered one",
                   bool(cur2 and cur3) and len(set(titles)) == 3 and len({c["id"] for c in (cur, cur2, cur3) if c}) == 3 and not card_visible()
                   and (after is None or (after["status"] == "preparing" and after["id"] not in {cur["id"], cur2["id"], cur3["id"]})),
                   {"titles": titles, "waitingLineShown": cur2 is not None and waiting, "after": after})
            day = chat.evaluate('async () => (await (await fetch("/studio-api/digest", { method: "POST", headers: { "X-Studio": "1" } })).json()).day')
            md = chat.evaluate('async d => (await fetch("/studio-api/digests/" + d)).text()', day)
            (OUT / "s6-digest.md").write_text(md, encoding="utf-8")
            section = md.split("## 스튜디오가 먼저 한 제안과 답", 1)[1].split("\n## ", 1)[0] if "## 스튜디오가 먼저 한 제안과 답" in md else ""
            record("S6 the digest lists each suggestion with its grounds, preview timings and his answer",
                   all(t and t.replace("|", "\\|")[:20] in section for t in titles) and "| 적용 |" in section and "| 다른 제안 |" in section and "| 됐어요 |" in section,
                   {"day": day, "section": section[:3000]})
            events = [json.loads(l) for l in (OUT / "data/public/suggestions.jsonl").read_text(encoding="utf-8").splitlines()]
            (OUT / "suggestion-events.json").write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")

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
    # On Windows the Claude CLI children of the server outlive a plain terminate: end the whole tree.
    if os.name == "nt": subprocess.run(["taskkill", "/T", "/F", "/PID", str(server.pid)], capture_output=True)
    server.terminate()
    try: server.wait(timeout=10)
    except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=10)
    log.close()
    (OUT / "results.json").write_text(json.dumps({"sha": SHA, "checks": checks}, ensure_ascii=False, indent=2), encoding="utf-8")
failed = [c["name"] for c in checks if not c["pass"]]
print(f"{len(checks) - len(failed)}/{len(checks)} passed" + (f"; failed: {failed}" if failed else ""), flush=True)
sys.exit(1 if failed or not checks else 0)
