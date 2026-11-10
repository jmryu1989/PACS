# coding: utf-8
"""kin-login theme: the forgot-password link on the Keycloak login page (A3 C-R01-114#5, C-R03-143#12).

The page is the markup Keycloak 26.7.3's base template.ftl + login.ftl render with the keycloak theme's classes
(html.login-pf, header, language button, page title, username, password, hidden password toggle, settings row with the
forgot-password link, Login button, registration link), styled by the shipped login.css and running the scripts
theme.properties lists, as template.ftl loads them in <head>. Texts are the theme's messages_ko.properties. Keycloak's
stylesCommon (PatternFly from the server jar) is not in this repository and is not loaded; login.css sets the link's
size, line height and colour itself.

  01  the link is drawn as its own text: a box with height, Playwright-visible, one accessible name equal to the
      message, no generated duplicate; a click opens the reset page.
  02  keyboard: Tab follows the screen (password -> Login -> forgot-password -> registration); Enter on the link
      opens the reset page.
  03  the link stays where it was drawn: under the Login button, left of the TLS note, above the registration line.

Synthetic data only; no server, no credentials.
"""
from __future__ import annotations

from pathlib import Path
import sys
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
THEME = ROOT / "keycloak" / "themes" / "kin-login" / "login"
ORIGIN = "https://login.test"
RESOURCES = "/auth/resources/kin-login/"
RESET = "/auth/realms/kin/login-actions/reset-credentials"


def properties(path):
    """Keycloak .properties (UTF-8 in this theme): key=value lines."""
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            rows[key.strip()] = value.strip()
    return rows


THEME_PROPERTIES = properties(THEME / "theme.properties")
MSG = properties(THEME / "messages" / "messages_ko.properties")
FORGOT = MSG["doForgotPassword"]
HEAD = "".join(f'<link href="{RESOURCES}{style}" rel="stylesheet">' for style in THEME_PROPERTIES["styles"].split()) + \
    "".join(f'<script src="{RESOURCES}{script}" type="text/javascript"></script>' for script in THEME_PROPERTIES["scripts"].split())
LOGIN = f"""<!doctype html><html class="login-pf" lang="ko" dir="ltr"><head><meta charset="utf-8">
<title>{MSG["loginTitle"]}</title>{HEAD}</head>
<body class="" data-page-id="login-login">
<div class="login-pf-page">
 <div id="kc-header" class="login-pf-page-header"><div id="kc-header-wrapper" class="">KIN</div></div>
 <div class="card-pf">
  <header class="login-pf-header">
   <div class="pf-c-dropdown" id="kc-locale"><div id="kc-locale-wrapper" class="">
    <div id="kc-locale-dropdown" class="menu-button-links ">
     <button tabindex="1" id="kc-current-locale-link" aria-label="languages" aria-haspopup="true" aria-expanded="false" aria-controls="language-switch1">한국어</button>
     <ul role="menu" tabindex="-1" aria-labelledby="kc-current-locale-link" aria-activedescendant="" id="language-switch1" class="pf-c-dropdown__menu pf-m-align-right">
      <li class="" role="none"><a role="menuitem" id="language-1" class="pf-c-dropdown__menu-item" href="?kc_locale=en">English</a></li>
      <li class="" role="none"><a role="menuitem" id="language-2" class="pf-c-dropdown__menu-item" href="?kc_locale=ko">한국어</a></li>
     </ul></div></div></div>
   <h1 id="kc-page-title">{MSG["loginAccountTitle"]}</h1>
  </header>
  <div id="kc-content"><div id="kc-content-wrapper">
   <div id="kc-form"><div id="kc-form-wrapper">
    <form id="kc-form-login" onsubmit="login.disabled = true; return true;" action="/auth/realms/kin/login-actions/authenticate" method="post">
     <div class="form-group"><label for="username" class="pf-c-form__label pf-c-form__label-text">{MSG["usernameOrEmail"]}</label>
      <input tabindex="2" id="username" class="pf-c-form-control" name="username" value="" type="text" autofocus autocomplete="username" aria-invalid="" dir="ltr"></div>
     <div class="form-group"><label for="password" class="pf-c-form__label pf-c-form__label-text">{MSG["password"]}</label>
      <div class="pf-c-input-group" dir="ltr">
       <input tabindex="3" id="password" class="pf-c-form-control" name="password" type="password" autocomplete="current-password" aria-invalid="">
       <button class="pf-c-button pf-m-control" type="button" aria-label="Show password" aria-controls="password" data-password-toggle tabindex="4"><i class="fa fa-eye" aria-hidden="true"></i></button>
      </div></div>
     <div class="form-group login-pf-settings">
      <div id="kc-form-options"></div>
      <div class="">
       <span><a tabindex="6" href="{RESET}">{FORGOT}</a></span>
      </div>
     </div>
     <div id="kc-form-buttons" class="form-group"><input type="hidden" id="id-hidden-input" name="credentialId">
      <input tabindex="7" class="pf-c-button pf-m-primary pf-m-block btn-lg" name="login" id="kc-login" type="submit" value="{MSG["doLogIn"]}"></div>
    </form></div></div>
   <div id="kc-info" class="login-pf-signup"><div id="kc-info-wrapper" class=""><div id="kc-registration-container"><div id="kc-registration">
    <span>{MSG["noAccount"]} <a tabindex="8" href="/auth/realms/kin/login-actions/registration">{MSG["doRegister"]}</a></span>
   </div></div></div></div>
  </div></div>
 </div>
</div></body></html>"""
# Which element has focus, by the name a person would use.
FOCUSED = """() => { const e = document.activeElement;
  return e.id === 'kc-login' ? 'Login' : e.id || e.textContent.trim(); }"""


class LoginThemeDomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.unexpected, self.errors = [], []
        self.context = self.browser.new_context(viewport={"width": 1600, "height": 1050})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(ORIGIN + "/auth/realms/kin/protocol/openid-connect/auth")
        expect(self.page.locator("#kc-login")).to_be_visible()
        self.link = self.page.locator("#kc-form-login .login-pf-settings a")

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")

    def route(self, route):
        url = urlparse(route.request.url)
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(route.request.url)
            return route.abort()
        if url.path == "/auth/realms/kin/protocol/openid-connect/auth":
            return route.fulfill(body=LOGIN, content_type="text/html; charset=utf-8")
        if url.path == RESET:
            return route.fulfill(body="<!doctype html><title>SYN 비밀번호 재설정</title>", content_type="text/html; charset=utf-8")
        if url.path.startswith(RESOURCES):
            local = THEME / "resources" / url.path[len(RESOURCES):]
            if local.is_file():
                kind = "text/css" if local.suffix == ".css" else "application/javascript"
                return route.fulfill(path=str(local), content_type=kind + "; charset=utf-8")
        if url.path.startswith(("/kin-brand/", "/worklist/legal/")) or url.path.endswith((".png", ".jpg", ".svg", ".woff2")):
            return route.fulfill(status=404, body="")
        self.unexpected.append(f"{route.request.method} {url.path}")
        return route.abort()

    def test_01_link_is_drawn_as_its_own_text_and_opens_reset(self):
        box = self.link.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreater(box["width"], 0)
        self.assertGreater(box["height"], 0)
        expect(self.link).to_be_visible()
        expect(self.link).to_have_text(FORGOT)
        # One link with that accessible name, named once.
        expect(self.page.get_by_role("link", name=FORGOT, exact=True)).to_have_count(1)
        self.page.get_by_role("link", name=FORGOT, exact=True).click()
        expect(self.page).to_have_title("SYN 비밀번호 재설정")

    def test_02_tab_follows_the_screen_and_enter_opens_reset(self):
        self.page.locator("#password").focus()
        order = []
        for _ in range(3):
            self.page.keyboard.press("Tab")
            order.append(self.page.evaluate(FOCUSED))
        self.assertEqual(["Login", FORGOT, "가입 신청"], order)
        self.page.locator("#kc-login").focus()
        self.page.keyboard.press("Tab")
        self.assertEqual(FORGOT, self.page.evaluate(FOCUSED))
        self.page.keyboard.press("Enter")
        expect(self.page).to_have_title("SYN 비밀번호 재설정")

    def test_03_link_stays_under_the_login_button(self):
        place = self.page.evaluate("""() => {
          const r = s => document.querySelector(s).getBoundingClientRect();
          const settings = document.querySelector('#kc-form-login .login-pf-settings');
          return {login: r('#kc-login').bottom, link: r('#kc-form-login .login-pf-settings a'),
                  register: r('#kc-registration a').top, settings: settings.getBoundingClientRect(),
                  note: getComputedStyle(settings, '::after').content}; }""")
        self.assertGreater(place["link"]["top"], place["login"])
        self.assertLess(place["link"]["bottom"], place["register"])
        self.assertLess(place["link"]["left"] - place["settings"]["left"], place["settings"]["width"] / 2)
        self.assertIn("TLS", place["note"])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
