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

S5-UI1-B-R-001: the user and institution text wrapped inside a width cap, so a name of the allowed
length still pushed the header past 52px (F1), and body.portrait's 4px+4px padding plus the 44px tabs
and the 1px border made 53px (F2). The header now shows that text on one line, ellipsized when long,
and the whole text is in a Session details popover opened by a button. The page script is stripped,
so the shipped block that copies the text into that popover is cut out of main.html and run as is.

S5-U6b-X2-F01: the header shares its row with the S5-U6b storage text (#storage), which starts as the markup's
`not_loaded` "Storage Unobservable" and is then rewritten by refreshStorage(). Writing a fixed '1.0GB used' over it
measured a text the product never shows. The shipped refreshStorage() is cut out of main.html and run as is against a
stubbed /statistics answer, so every header here carries a text the page itself produces; the longest one (the largest
byte count it accepts) is the default, and each state it can draw is measured on its own at the one-row widths.
"""
import json
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
# The longest role text applyRoleUi() writes.
ROLES = 'radiologist, technician, admin'
# The longest name the product accepts: admin.service.ts:167-168 take lastName and firstName up to 128 characters
# each (trimmed length), and auth.guard.ts:79 joins them as "<family> <given>" - 257 characters. Hangul syllables
# are among the widest glyphs the header draws.
HANGUL = '가나다라마바사아자차카타파하'
NAME_MAX = (HANGUL * 10)[:128] + ' ' + (HANGUL[::-1] * 10)[:128]
# Without names auth.guard.ts:80 falls back to the e-mail; admin.service.ts:165 accepts up to 254 characters.
EMAIL_MAX = 'w' * 64 + '@' + 'm' * 186 + '.kr'
# Institution.name (schema.prisma:43) is an unbounded String written only by the seed (pacs.service.ts:317), and
# goOnline() prepends it to the roles. No length is safe by construction, so the header must not depend on one.
INSTITUTION_LONG = (HANGUL * 20)[:256]
# The longest session text the screen writes: goOnline() puts "<institution> · <roles>" into #roles.
SESSIONS = {
    'admin': ('류 정모', '한림병원 · ' + ROLES, CONNECTED),
    'long-institution': ('류 정모', '가톨릭대학교 서울성모병원 영상의학과 판독실 · ' + ROLES, CONNECTED),
    'long-offline': ('류 정모', '가톨릭대학교 서울성모병원 영상의학과 판독실 · ' + ROLES, OFFLINE),
    'max-name': (NAME_MAX, INSTITUTION_LONG + ' · ' + ROLES, CONNECTED),
    'max-offline': (NAME_MAX, INSTITUTION_LONG + ' · ' + ROLES, OFFLINE),
    'max-email': (EMAIL_MAX, '한림병원 · ' + ROLES, CONNECTED),
}
READING_SESSIONS = ('admin', 'long-institution', 'long-offline', 'max-name', 'max-offline')
PORTRAIT_SESSIONS = ('admin', 'max-name', 'max-offline')
# Names the header may fold to an icon when narrow; the words stay in the DOM and in the tooltip.
FOLDED = [('.brand', 'KOREA IMAGING NETWORK'), ('.menubar .item', 'Config'), ('.menubar .item', 'Help')]
LABELS_SHOWN_FROM = 1680
# The shipped block that copies #user/#roles into the Session details popover and the button's tooltip.
SESSION_BLOCK_START = '    // 세션 상세(S5-UI1):'
SESSION_BLOCK_END = '\n    function showMembershipState(state) {'
# The shipped refreshStorage() and the counter it reads; it draws #storage and needs only $ and KinStudyArrivals.
STORAGE_BLOCK_START = '    let storageSeq = 0, storageLast = null;'
STORAGE_BLOCK_END = '\n    async function load(options = {}) {'
# Every text #storage can show, as (/statistics answers fed to refreshStorage() in order, data-state, text). None is
# a failed read. not_loaded is the markup before the first read; the failure comes after a good read so the tooltip
# carries the last value as well. The largest TotalDiskSize it accepts is Number.MAX_SAFE_INTEGER, and that draws
# the longest text: 8192.00 TiB.
STORAGE_STATES = {
    'not_loaded': ((), 'not_loaded', 'Storage Unobservable'),
    'failed': ((1610612736, None), 'unobservable', 'Storage Unobservable'),
    'zero': ((0,), 'observed', 'Storage 0 B (Server-wide)'),
    'ordinary': ((1610612736,), 'observed', 'Storage 1.50 GiB (Server-wide)'),
    'max': ((9007199254740991,), 'observed', 'Storage 8192.00 TiB (Server-wide)'),
}
STORAGE_DEFAULT = 'max'
STORAGE_WIDTHS = [v for v in VIEWPORTS if v[0] >= ONE_ROW_FROM]
STORAGE_SESSIONS = ('admin', 'max-offline')


def page_html():
    html = (ASSETS / 'main.html').read_text(encoding='utf-8')
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: '<style>' + (ASSETS / m.group(1)).read_text(encoding='utf-8') + '</style>', html)
    return re.sub(r'<link\b[^>]*>', '', html)


def cut(start_marker, end_marker):
    html = (ASSETS / 'main.html').read_text(encoding='utf-8')
    start = html.find(start_marker)
    end = html.find(end_marker, start)
    return html[start:end] if start >= 0 and end > start else None


def session_block():
    return cut(SESSION_BLOCK_START, SESSION_BLOCK_END)


def storage_block():
    block = cut(STORAGE_BLOCK_START, STORAGE_BLOCK_END)
    # Its own scope, like the page script's; only the function is handed out.
    return block and ('(() => {\n  const $ = s => document.querySelector(s);\n' + block
                      + '\n  window.kinRefreshStorage = refreshStorage;\n})();')


# refreshStorage() reads fetch("/statistics"); each call takes the next answer. None is a network failure.
STORAGE_FEED = """async (answers)=>{
  const calls=[];
  window.fetch=async (url)=>{
    calls.push(String(url));
    const n=answers[calls.length-1];
    if(n===null||n===undefined) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({TotalDiskSize:n}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  for(let i=0;i<answers.length;i++) await window.kinRefreshStorage();
  return calls;
}"""

FILL = """([user, roles, reading, portrait, dbstat])=>{
  document.body.classList.toggle('reading', reading);
  document.body.classList.toggle('portrait', portrait);
  document.querySelector('#m-unassigned').style.display='';
  document.querySelector('#member-link').style.display='';
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
  const who=document.querySelector('#session-who');
  const part=s=>{const e=document.querySelector(s),cs=getComputedStyle(e);
    return {sel:s,box:box(e),sh:e.scrollHeight,ch:e.clientHeight,font:parseFloat(cs.fontSize),
            whiteSpace:cs.whiteSpace,textOverflow:cs.textOverflow,inWho:!!who&&who.contains(e)}};
  return {vw:innerWidth,vh:innerHeight,docSW:document.documentElement.scrollWidth,
          bar:{...box(bar),sw:bar.scrollWidth,cw:bar.clientWidth},items,
          logout:{...box(out),tag:out.tagName,text:out.textContent.trim(),font:parseFloat(getComputedStyle(out).fontSize)},
          who:who&&{...box(who),tag:who.tagName,type:who.type,target:who.getAttribute('popovertarget'),title:who.title},
          parts:['#user','#roles'].map(part),
          storage:(e=>({...box(e),text:e.textContent,state:e.dataset.state,title:e.title,sw:e.scrollWidth,cw:e.clientWidth,
                        sh:e.scrollHeight,ch:e.clientHeight,font:parseFloat(getComputedStyle(e).fontSize),
                        display:getComputedStyle(e).display}))(document.querySelector('#storage'))};
}"""

# The Session details popover as drawn: open or not, its box, whether it scrolls or clips, what it holds, and
# whether its centre is its own (nothing on top of it).
DETAILS = """()=>{
  const d=document.querySelector('#session-details');
  if(!d) return null;
  const r=d.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
  return {open:d.matches(':popover-open'),tag:d.tagName,role:d.getAttribute('role'),popover:d.getAttribute('popover'),
          box:{x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height},
          sw:d.scrollWidth,cw:d.clientWidth,sh:d.scrollHeight,ch:d.clientHeight,
          user:document.querySelector('#session-details-user').textContent,
          roles:document.querySelector('#session-details-roles').textContent,
          font:Math.min(...[...d.querySelectorAll('dt,dd')].map(e=>parseFloat(getComputedStyle(e).fontSize))),
          own:!!hit&&d.contains(hit),barH:document.querySelector('.menubar').getBoundingClientRect().height};
}"""

# Where a name may be folded: the element that carries it, its tooltip, and whether its words are drawn.
FOLD = """(names)=>names.map(([sel, word])=>{
  const el=[...document.querySelectorAll(sel)].find(e=>e.textContent.includes(word));
  if(!el) return {word, found:false};
  const label=[...el.querySelectorAll('span')].find(s=>s.textContent.trim()===word);
  const r=label&&label.getBoundingClientRect();
  return {word, found:true, text:el.textContent, title:el.title, labelShown:!!r&&r.width>1&&r.height>1};
})"""

ACTIVE = "()=>document.activeElement&&document.activeElement.id"


class WorklistHeaderDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = page_html()
        cls.session_block = session_block()
        cls.storage_block = storage_block()
        cls.arrivals = (ASSETS / 'study-arrivals.js').read_text(encoding='utf-8')
        cls.storage_seen = []
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        # What each storage state did to the header: its height and where Log out sat.
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / 'header-storage-states.json').write_text(
            json.dumps({'header_storage_states': cls.storage_seen}, ensure_ascii=False, indent=1), encoding='utf-8')

    def one_row(self, width, bar_height, what):
        if width >= ONE_ROW_FROM:
            # The G-LIVE-GEO premise: one row, so the report column starts where the reading layout expects it.
            self.assertAlmostEqual(ONE_ROW_HEIGHT, bar_height, delta=0.5, msg=f'header is {bar_height}px at {width} {what}')
        else:
            # Narrower windows may wrap; the header only has to hold at least its one-row height.
            self.assertGreaterEqual(bar_height, ONE_ROW_HEIGHT - 0.5)

    def tab_to(self, page, element_id):
        for _ in range(60):
            page.keyboard.press('Tab')
            if page.evaluate(ACTIVE) == element_id:
                return True
        return False

    def check_details(self, page, width, height, user, roles):
        d = page.evaluate(DETAILS)
        self.assertTrue(d['open'], 'Session details did not open')
        self.assertNotEqual('DIALOG', d['tag'])
        self.assertNotEqual('dialog', d['role'])
        # Opening it does not reflow the header.
        self.one_row(width, d['barH'], 'with Session details open')
        # The whole text, not a cut-down copy, and nothing in it scrolled or clipped away.
        self.assertEqual(user, d['user'])
        self.assertEqual(roles, d['roles'])
        self.assertLessEqual(d['sw'], d['cw'] + 1, 'Session details clips its text sideways')
        self.assertLessEqual(d['sh'], d['ch'] + 1, 'Session details hides part of its text')
        self.assertGreaterEqual(d['font'], 12)
        b = d['box']
        self.assertGreater(b['w'], 0)
        self.assertGreaterEqual(b['x'], 0, d)
        self.assertGreaterEqual(b['y'], 0, d)
        self.assertLessEqual(b['r'], width, d)
        self.assertLessEqual(b['b'], height, d)
        self.assertTrue(d['own'], 'something covers Session details')
        return d

    def check(self, width, height, session, reading=False, portrait=False, storage=STORAGE_DEFAULT):
        user, roles, dbstat = SESSIONS[session]
        answers, storage_state, storage_text = STORAGE_STATES[storage]
        self.assertIsNotNone(self.storage_block, 'refreshStorage() was not found in main.html')
        page = self.browser.new_page(viewport={'width': width, 'height': height})
        page.set_default_timeout(4000)
        page.route('**/*', lambda route: route.abort())
        page.set_content(self.html)
        if self.session_block:
            page.add_script_tag(content=self.session_block)
        page.add_script_tag(content=self.arrivals)
        page.add_script_tag(content=self.storage_block)
        page.evaluate(FILL, [user, roles, reading, portrait, dbstat])
        # The shipped refreshStorage() writes #storage, as the page does after its list read.
        self.assertEqual(['/statistics'] * len(answers), page.evaluate(STORAGE_FEED, list(answers)))
        tag = (f'{width}x{height}-{session}' + ('-reading' if reading else '') + ('-portrait' if portrait else '')
               + f'-storage-{storage}')
        m = d = None
        ok = False
        try:
            m = page.evaluate(MEASURE)
            bar = m['bar']
            self.assertEqual(0, bar['y'])
            self.one_row(width, bar['h'], f'with {storage} storage "{m["storage"]["text"]}"')
            # The storage text is the one the page drew, on one line, whole, inside the header and the viewport.
            st = m['storage']
            self.assertEqual(storage_state, st['state'])
            self.assertEqual(storage_text, st['text'])
            self.assertTrue(st['title'], 'the storage text lost its explanation')
            self.assertNotEqual('none', st['display'])
            self.assertGreater(st['w'], 0)
            self.assertGreaterEqual(st['font'], 12)
            self.assertLessEqual(st['sw'], st['cw'] + 1, f'#storage clips "{st["text"]}"')
            self.assertLessEqual(st['sh'], st['ch'] + 1, f'#storage runs onto a second line: "{st["text"]}"')
            self.assertGreaterEqual(st['x'], -0.5)
            self.assertLessEqual(st['r'], width + 0.5)
            self.assertGreaterEqual(st['y'], bar['y'] - 0.5)
            self.assertLessEqual(st['b'], bar['b'] + 0.5)
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
                # No header item is clipped. The user/institution text inside the session button may be ellipsized;
                # that button is the item here, and its whole text is checked in Session details below.
                self.assertLessEqual(item['sw'], item['cw'] + 1, f'{item["name"]} clips "{item["text"]}"')
            boxes = [i for i in m['items'] if i['box']['w'] and i['box']['h']]
            for i, a in enumerate(boxes):
                for c in boxes[i + 1:]:
                    ow = min(a['box']['r'], c['box']['r']) - max(a['box']['x'], c['box']['x'])
                    oh = min(a['box']['b'], c['box']['b']) - max(a['box']['y'], c['box']['y'])
                    self.assertFalse(ow > 1 and oh > 1, f'{a["name"]} overlaps {c["name"]}')
            # The page script still writes the same text into the same elements.
            self.assertEqual(roles, page.locator('#roles').text_content())
            self.assertEqual(user, page.locator('#user').text_content())
            # The user and institution/role text: one line each inside the session button, never wrapped, at least
            # 12px. It may end in an ellipsis; the button's tooltip and Session details carry all of it.
            who = m['who']
            self.assertIsNotNone(who, 'no Session details button (#session-who)')
            self.assertEqual('BUTTON', who['tag'])
            self.assertEqual('button', who['type'])
            self.assertEqual('session-details', who['target'])
            self.assertEqual(user + '\n' + roles, who['title'])
            for part in m['parts']:
                b = part['box']
                self.assertTrue(part['inWho'], part['sel'])
                self.assertEqual('nowrap', part['whiteSpace'], part['sel'])
                self.assertEqual('ellipsis', part['textOverflow'], part['sel'])
                self.assertGreaterEqual(part['font'], 12, part['sel'])
                self.assertLessEqual(part['sh'], part['ch'] + 1, f'{part["sel"]} runs onto a second line')
                self.assertLessEqual(b['h'], 2 * part['font'], f'{part["sel"]} is {b["h"]}px tall, more than one line')
                self.assertGreaterEqual(b['x'], who['x'] - 0.5, part['sel'])
                self.assertLessEqual(b['r'], who['r'] + 0.5, part['sel'])
                self.assertGreaterEqual(b['y'], m['bar']['y'] - 0.5, part['sel'])
                self.assertLessEqual(b['b'], m['bar']['b'] + 0.5, part['sel'])
            logout = page.locator('#logout')
            expect(logout).to_be_visible()
            expect(logout).to_be_in_viewport(ratio=1)
            # Keyboard first, while focus navigation still starts at the top of the document: Tab reaches the
            # session button, Enter opens Session details and Escape closes it again; Tab then reaches Log out
            # and Enter activates it.
            self.assertTrue(self.tab_to(page, 'session-who'), 'Tab never reached the session button')
            page.keyboard.press('Enter')
            d = self.check_details(page, width, height, user, roles)
            OUT.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(OUT / f'header-{tag}-details.png'),
                            clip={'x': 0, 'y': 0, 'width': width, 'height': min(height, max(140, d['box']['b'] + 8))})
            page.keyboard.press('Escape')
            self.assertFalse(page.evaluate(DETAILS)['open'], 'Escape did not close Session details')
            self.assertEqual('session-who', page.evaluate(ACTIVE))
            self.assertTrue(self.tab_to(page, 'logout'), 'Tab never reached Log out')
            page.keyboard.press('Enter')
            self.assertEqual(1, page.evaluate('logoutClicks'))
            # The pointer: a hit-tested click opens it and a second click on the same button closes it.
            session_who = page.locator('#session-who')
            session_who.click()
            self.check_details(page, width, height, user, roles)
            session_who.click()
            self.assertFalse(page.evaluate(DETAILS)['open'], 'a second click did not close Session details')
            logout.click()  # Playwright's hit test: nothing covers the button.
            self.assertEqual(2, page.evaluate('logoutClicks'))
            ok = True
        finally:
            if m:
                st, lo = m['storage'], m['logout']
                self.storage_seen.append({
                    'test': self._testMethodName, 'width': width, 'height': height, 'session': session,
                    'reading': reading, 'portrait': portrait, 'storage': storage, 'data_state': st['state'],
                    'text': st['text'], 'bar_h': m['bar']['h'],
                    'storage_box': {k: st[k] for k in ('x', 'y', 'r', 'b')},
                    'logout': {k: lo[k] for k in ('x', 'y', 'r', 'b')}, 'passed': ok})
            OUT.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(OUT / f'header-{tag}.png'), clip={'x': 0, 'y': 0, 'width': width, 'height': 140})
            print(tag, m and {'bar': m['bar'], 'logout': m['logout'], 'who': m['who'], 'docSW': m['docSW']},
                  d and {'details': d['box']})
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
            for session in READING_SESSIONS:
                with self.subTest(width=width, session=session):
                    self.check(width, height, session, reading=True)

    def test_portrait_layout_keeps_the_same_header(self):
        # Layout: Portrait can be chosen or restored on a wide window, and Auto picks it on a monitor stood on end
        # (applyLayout: innerHeight > innerWidth). From 1366 up the header is the same one 52px row there.
        for width, height in VIEWPORTS:
            for reading in (False, True):
                for session in PORTRAIT_SESSIONS:
                    with self.subTest(width=width, reading=reading, session=session):
                        self.check(width, height, session, reading=reading, portrait=True)

    def test_every_storage_state_keeps_the_one_row_header(self):
        # S5-U6b-X2-F01: each text refreshStorage() can draw, in the real header and CSS, at the widths that must stay
        # one 52px row, in both layouts and modes, with the shortest and the longest session text.
        for width, height in STORAGE_WIDTHS:
            for reading in (False, True):
                for portrait in (False, True):
                    for session in STORAGE_SESSIONS:
                        for storage in STORAGE_STATES:
                            with self.subTest(width=width, reading=reading, portrait=portrait, session=session,
                                              storage=storage):
                                self.check(width, height, session, reading=reading, portrait=portrait,
                                           storage=storage)


if __name__ == '__main__':
    unittest.main(verbosity=2)
