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
                    "knowledge": str(STUDIO / "knowledge-seed"), "ohifDist": str(OUT / "empty-ohif"), "dicomweb": str(OUT / "empty-dicomweb")},
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

log = (OUT / "server.log").open("w", encoding="utf-8")
server = subprocess.Popen(["node", server_js, "--config", str(OUT / "config.json")], cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
try:
    for _ in range(100):
        try: urllib.request.urlopen(BASE + "/studio/login.html", timeout=1); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1800, "height": 1000})
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
