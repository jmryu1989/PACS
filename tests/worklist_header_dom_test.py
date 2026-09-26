# coding: utf-8
"""TEST-S5-UI1-HEADER-DOM: the real worklist header markup/CSS keeps Log out reachable, no services.

D27 (2026-09-26): at 1920x1200 the header ran past the right edge and Log out was off screen;
at 1225 it was cut at "Unmatched Studies". Every stylesheet main.html links is inlined in its
own document position so the cascade (including `body.reading .menubar`) is the shipped one.

G-LIVE-GEO (PR#93 run 36230179463): the first fix let the header wrap, and at 1366x768 it became
two rows (73px). The reading layout's report buttons moved 21px down under the Image Findings
drawer and Dictate stopped owning its centre. tests/e2e/test_dictation_live.py measures that layout
only at VIEWPORTS = ((1680, 1100), (1366, 768)), so from 1366 up the header must stay one 52px row;
below it wrapping stays the fallback that keeps Log out on screen.
"""
import os
import re
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'worklist-v0/hpacs-lite'
# Screenshots go outside the checkout when the runner names a directory, so a run leaves no files behind.
OUT = Path(os.environ.get('KIN_EVIDENCE_DIR') or ROOT / 'tmp/s5-ui1/header')

VIEWPORTS = [(1024, 768), (1225, 900), (1280, 800), (1366, 768), (1680, 1100), (1920, 1200)]
ONE_ROW_FROM = 1366
ONE_ROW_HEIGHT = 52
CONNECTED = '<span style="color:#4ac06a">●</span> DB Connected'
# goOffline() writes this; it is the longest status text the header shows.
OFFLINE = '<span style="color:#ff6b6b">●</span> 서버 연결 끊김 — 저장 불가 (클릭: 재시도)'
# The longest session text the screen writes: goOnline() puts "<institution> · <roles>" into #roles.
SESSIONS = {
    'admin': ('류 정모', '한림병원 · radiologist, technician, admin', CONNECTED),
    'long-institution': ('류 정모', '가톨릭대학교 서울성모병원 영상의학과 판독실 · radiologist, technician, admin', CONNECTED),
    'long-offline': ('류 정모', '가톨릭대학교 서울성모병원 영상의학과 판독실 · radiologist, technician, admin', OFFLINE),
}
# Names the header may fold to an icon when narrow; the words stay in the DOM and in the tooltip.
FOLDED = [('.brand', 'KOREA IMAGING NETWORK'), ('.menubar .item', 'Config'), ('.menubar .item', 'Help')]
LABELS_SHOWN_FROM = 1680


def page_html():
    html = (ASSETS / 'main.html').read_text(encoding='utf-8')
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: '<style>' + (ASSETS / m.group(1)).read_text(encoding='utf-8') + '</style>', html)
    return re.sub(r'<link\b[^>]*>', '', html)


FILL = """([user, roles, reading, dbstat])=>{
  document.body.classList.toggle('reading', reading);
  document.querySelector('#m-unassigned').style.display='';
  document.querySelector('#member-link').style.display='';
  document.querySelector('#storage').textContent='1.0GB used';
  document.querySelector('#dbstat').innerHTML=dbstat;
  document.querySelector('#user').textContent=user;
  document.querySelector('#roles').textContent=roles;
  window.logoutClicks=0;
  document.querySelector('#logout').addEventListener('click',()=>window.logoutClicks++);
}"""

MEASURE = """()=>{
  const box=e=>{const r=e.getBoundingClientRect();return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}};
  const bar=document.querySelector('.menubar');
  const items=[...bar.querySelectorAll('.brand,.tabs>div,.menubar .item,.mright')]
    .filter(e=>getComputedStyle(e).display!=='none')
    .map(e=>({name:e.id||e.className||e.textContent.trim(),text:e.textContent.trim(),box:box(e),
              sw:e.scrollWidth,cw:e.clientWidth}));
  const out=document.querySelector('#logout');
  return {vw:innerWidth,vh:innerHeight,docSW:document.documentElement.scrollWidth,
          bar:{...box(bar),sw:bar.scrollWidth,cw:bar.clientWidth},items,
          logout:{...box(out),tag:out.tagName,text:out.textContent.trim(),font:parseFloat(getComputedStyle(out).fontSize)}};
}"""

# Where a name may be folded: the element that carries it, its tooltip, and whether its words are drawn.
FOLD = """(names)=>names.map(([sel, word])=>{
  const el=[...document.querySelectorAll(sel)].find(e=>e.textContent.includes(word));
  if(!el) return {word, found:false};
  const label=[...el.querySelectorAll('span')].find(s=>s.textContent.trim()===word);
  const r=label&&label.getBoundingClientRect();
  return {word, found:true, text:el.textContent, title:el.title, labelShown:!!r&&r.width>1&&r.height>1};
})"""


class WorklistHeaderDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = page_html()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def check(self, width, height, session, reading=False):
        user, roles, dbstat = SESSIONS[session]
        page = self.browser.new_page(viewport={'width': width, 'height': height})
        page.set_default_timeout(4000)
        page.route('**/*', lambda route: route.abort())
        page.set_content(self.html)
        page.evaluate(FILL, [user, roles, reading, dbstat])
        m = None
        try:
            m = page.evaluate(MEASURE)
            bar = m['bar']
            if width >= ONE_ROW_FROM:
                # The G-LIVE-GEO premise: one row, so the report column starts where the reading layout expects it.
                self.assertEqual(0, bar['y'])
                self.assertAlmostEqual(ONE_ROW_HEIGHT, bar['h'], delta=0.5, msg=f'header is {bar["h"]}px at {width}, not one row')
            else:
                # Narrower windows may wrap; the header only has to hold at least its one-row height.
                self.assertGreaterEqual(bar['h'], ONE_ROW_HEIGHT - 0.5)
            # Folding a name hides its words from the row only: they stay in the DOM and in the tooltip.
            for fold in page.evaluate(FOLD, FOLDED):
                self.assertTrue(fold['found'], fold['word'])
                self.assertIn(fold['word'], fold['text'])
                self.assertTrue(fold['title'].startswith(fold['word']), fold)
                if width >= LABELS_SHOWN_FROM:
                    self.assertTrue(fold['labelShown'], f'{fold["word"]} is folded at {width}')
            lo = m['logout']
            self.assertEqual('BUTTON', lo['tag'], 'Log out must be a native control so Tab and Enter reach it')
            self.assertEqual('Log out', lo['text'])
            self.assertGreaterEqual(lo['font'], 12)
            # The whole button lies inside the viewport, not merely its left edge.
            self.assertGreaterEqual(lo['x'], 0)
            self.assertGreaterEqual(lo['y'], 0)
            self.assertLessEqual(lo['r'], width, f'Log out ends at {lo["r"]} beyond {width}')
            self.assertLessEqual(lo['b'], height)
            self.assertGreater(lo['w'], 0)
            # Nothing in the header is pushed past the edge or scrolled away.
            self.assertLessEqual(m['bar']['sw'], m['bar']['cw'] + 1, 'header content overflows its box')
            # The header box itself stays in the viewport. The page-wide scrollWidth is not asserted: with
            # scripts stripped the template panel (#tpl-filter-clear) already reaches 1038px at 1024 on the
            # base commit, which is outside the header and outside this unit.
            self.assertGreaterEqual(m['bar']['x'], 0)
            self.assertLessEqual(m['bar']['r'], width, 'the header is wider than the viewport')
            for item in m['items']:
                b = item['box']
                self.assertGreaterEqual(b['x'], -0.5, item['name'])
                self.assertLessEqual(b['r'], width + 0.5, item['name'])
                self.assertLessEqual(b['r'], m['bar']['r'] + 0.5, item['name'])
                self.assertGreaterEqual(b['y'], m['bar']['y'] - 0.5, item['name'])
                self.assertLessEqual(b['b'], m['bar']['b'] + 0.5, item['name'])
                # Text is wrapped, never clipped: the full user, role and status strings stay on screen.
                self.assertLessEqual(item['sw'], item['cw'] + 1, f'{item["name"]} clips "{item["text"]}"')
            boxes = [i for i in m['items'] if i['box']['w'] and i['box']['h']]
            for i, a in enumerate(boxes):
                for c in boxes[i + 1:]:
                    ow = min(a['box']['r'], c['box']['r']) - max(a['box']['x'], c['box']['x'])
                    oh = min(a['box']['b'], c['box']['b']) - max(a['box']['y'], c['box']['y'])
                    self.assertFalse(ow > 1 and oh > 1, f'{a["name"]} overlaps {c["name"]}')
            self.assertEqual(roles, page.locator('#roles').text_content())
            self.assertEqual(user, page.locator('#user').text_content())
            logout = page.locator('#logout')
            expect(logout).to_be_visible()
            expect(logout).to_be_in_viewport(ratio=1)
            # Keyboard first, while focus navigation still starts at the top of the document:
            # Tab alone reaches Log out and Enter activates it.
            reached = False
            for _ in range(60):
                page.keyboard.press('Tab')
                if page.evaluate("()=>document.activeElement&&document.activeElement.id==='logout'"):
                    reached = True
                    break
            self.assertTrue(reached, 'Tab never reached Log out')
            page.keyboard.press('Enter')
            self.assertEqual(1, page.evaluate('logoutClicks'))
            logout.click()  # Playwright's hit test: nothing covers the button.
            self.assertEqual(2, page.evaluate('logoutClicks'))
        finally:
            OUT.mkdir(parents=True, exist_ok=True)
            tag = f'{width}x{height}-{session}' + ('-reading' if reading else '')
            page.screenshot(path=str(OUT / f'header-{tag}.png'), clip={'x': 0, 'y': 0, 'width': width, 'height': 140})
            print(tag, m and {'bar': m['bar'], 'logout': m['logout'], 'docSW': m['docSW']})
            page.close()

    def test_log_out_stays_visible_and_reachable_at_every_width(self):
        for width, height in VIEWPORTS:
            for session in SESSIONS:
                with self.subTest(width=width, session=session):
                    self.check(width, height, session)

    def test_reading_workspace_header_keeps_log_out_on_screen(self):
        # reading-workspace.css scrolls the menubar sideways in this mode; a header that fits never needs to.
        # 1366x768 and 1680x1100 are the layouts G-LIVE-GEO measures.
        for width, height in VIEWPORTS:
            for session in ('long-institution', 'long-offline'):
                with self.subTest(width=width, session=session):
                    self.check(width, height, session, reading=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
