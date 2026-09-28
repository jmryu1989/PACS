# coding: utf-8
"""TEST-S5-UI3-REPORT-ACTIONS-DOM: the report panel's button rows (UXR-G-08) in the real markup/CSS, no services.

REQ-S5-UI3-REPORT-ACTION-GROUPS: the report panel showed 18 buttons in two rows, and at the 419px report column that
1366px and 1680px give it, each row wrapped to two (52px on top, 55px at the bottom). This unit only regroups them. In
view stay Approve, Save, Prelim and Dictate with one More menu on top, and Prev/Next at the bottom; the other thirteen
live in four sections (Reading, Status, Editor, Print and History) of a native <details> that opens without script.
Same elements, same ids, same labels, same handlers: the page script is not touched. Except and Mark CVR, which had no
id, get one (b-except, b-mark-cvr) and stay disabled placeholders. S7-U1b later wired Mark CVR to the critical result
routes: it stays disabled in the markup and critical-result-send.js turns it on only while the server (#1) says the
reading study can be sent (the last case below; tests/critical_result_sender_dom_test.py covers the reasons).

Dictate stays in view although UXR-G-08 lists it under More, to keep the report fields their room: at 1366x768 an open
More grows the row above the fields from 28px to 130-134px, and with the dictation pane open as well the three fields
reach their minimum heights (the geometry record). Starting dictation should not need that. Kept in view, the flow
needs no menu, and tests/e2e/test_dictation_live.py (G-LIVE-GEO) still presses it where it measured it.

fix1 (Astra S5-UI3-IMPROVE-R-001 proposals 1-3 and 6, D54; markup and CSS only): Dictate, Reset to Unread and Clear
stand 8px further from the buttons before them, so the save actions, the status changes and Copy/Paste are not one
click-slip away; each More section shows its aria-label as a short heading at the start of its own line (CSS content
with empty alternative text, no new element, no new line); the More tooltip says where Structured appears, and Except
and Mark CVR say they are not connected yet. The sections must stay one line each at the 419px column.

RISK-S5-UI3-REPORT-ACTIONS: a button lost, duplicated or changed on the way (tag, attributes, label, disabled); a button
outside the section it is declared in; the page script changed; the top row wrapping from 1366px or growing taller than
one button row; an open More covering the report fields or the dictation pane (a <details> does not close on an
outside click, so a floating panel would stay over them); Dictate covered by the pane; a menu control that cannot be
reached or focused; the More summary that cannot be opened or left with the keyboard.

The page script is stripped, as in tests/worklist_header_dom_test.py and tests/worklist_toolbar_dom_test.py, and every
stylesheet main.html links is inlined in its own position. The one piece of script that puts a button into these rows
(`$("#b-print").before(button)`, the Structured entry when the catalog is not empty) is pinned and replayed as that one
DOM call. Role gating stays the page script's disabled; the keyboard case enables every button to walk the fullest row.

without_ui3() gives main.html back with this unit's three regions (the button-row markup, the footer row and the CSS
block) replaced by the base bytes. The structure case below requires that result to equal the base main.html byte for
byte, and tests/worklist_toolbar_dom_test.py reads it, so S5-UI2's pins over everything outside its toolbar keep
standing for the bytes this unit did not touch.
"""
import hashlib
import json
import os
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'worklist-v0/hpacs-lite'
MAIN = ASSETS / 'main.html'
REL_MAIN = 'worklist-v0/hpacs-lite/main.html'
# Screenshots and the geometry record go outside the checkout when the runner names a directory.
OUT = Path(os.environ.get('KIN_EVIDENCE_DIR') or ROOT / 'tmp/s5-ui3/report-actions')

# The commit this unit started from (S5-UI2 fix1). A shallow CI clone does not have it, so what it held is pinned below;
# where the commit is present the pins are checked against it first.
BASE = 'ae04b19d1b98b57b3ff7de006e5dc38d83ef8e64'
# LF-normalized UTF-8 sha256 of the base main.html, and of its <script> blocks joined by '\n\0\n' (the digest
# tests/worklist_toolbar_dom_test.py pins for S5-UI2's base; neither unit changed a script byte).
BASE_MAIN_SHA256 = 'c32f4026cfa29d54e3ffa0e85d1900d250264c4f860aa3ed09477a70fe98d707'
BASE_SCRIPTS_SHA256 = '2231eefe0bc40ed48d28887043bf5cb9b0828bcefcb20b659be07d58cf1a7349'

# The base rows, verbatim (LF). without_ui3() puts them back.
BASE_RBTNS = '''        <div class="rbtns">
          <button class="approve" id="b-approve">Approve</button>
          <button class="save" id="b-save">Save</button>
          <button id="b-addendum" disabled title="승인된 판독문에 덧붙입니다 (이전 승인본은 그대로 남습니다)">Addendum</button>
          <button id="b-prelim" title="상급 판독의를 지정해 최종 판독을 맡깁니다 (RS: P)">Prelim</button>
          <button id="b-dictate" disabled title="음성 인식기가 연결되지 않았습니다.">Dictate</button>
          <button id="b-transcribe">Transcribe</button>
          <button disabled>Except</button>
          <button disabled>Mark CVR</button>
          <button id="b-print">Print</button>
        </div>'''
BASE_RFOOT = '''        <div class="rfoot2">
          <button id="b-report-template" disabled>Save as Template</button>
          <button id="b-copy">Copy</button>
          <button id="b-paste">Paste</button>
          <button id="b-history" title="판독문 개정 이력">History</button>
          <button id="b-unread">Reset to Unread</button>
          <button id="b-defer">Defer</button>
          <button id="b-clear">Clear</button>
          <button id="b-prev">◀ Prev</button>
          <button id="b-next">Next ▶</button>
        </div>'''
BASE_RBTNS_SHA256 = '8d6a205f93facfa9edf0683fc8d377963995bc3071b10fd414e38399facc78be'
BASE_RFOOT_SHA256 = '28a54c8b76ed43e0aed333eee1c6dbcf63cb332bf2da439391d6c2e143a7e45e'

# This unit's regions at HEAD. The button-row region starts at the unit's comment above the row; a row ends at the first
# line that is exactly eight spaces and '</div>' (the deeper lines of the menu never match it).
MARKUP_START = '        <!-- S5-UI3 (UXR-G-08):'
RBTNS_OPEN = '        <div class="rbtns">'
RFOOT_OPEN = '        <div class="rfoot2">'
ROW_CLOSE = '\n        </div>'
CSS_START = '    /* ── S5-UI3 판독 단추 묶음 (UXR-G-08) ──'
CSS_END = '    /* ── S5-UI3 끝 ── */\n'

# The 18 base buttons in base document order: (id at HEAD, the label that finds the two that had no id in the base).
BUTTONS = [('b-approve', None), ('b-save', None), ('b-addendum', None), ('b-prelim', None), ('b-dictate', None),
           ('b-transcribe', None), ('b-except', 'Except'), ('b-mark-cvr', 'Mark CVR'), ('b-print', None),
           ('b-report-template', None), ('b-copy', None), ('b-paste', None), ('b-history', None), ('b-unread', None),
           ('b-defer', None), ('b-clear', None), ('b-prev', None), ('b-next', None)]
BUTTON_IDS = [key for key, _ in BUTTONS]
GIVEN_IDS = {key: label for key, label in BUTTONS if label}
MENU = 'report-more'
# Where each button lives now: in view on the top row or the footer row, or in a section of More.
TOP = ['b-approve', 'b-save', 'b-prelim', 'b-dictate']
FOOT = ['b-prev', 'b-next']
SECTIONS = {
    'report-more-reading': ['b-addendum', 'b-transcribe'],
    'report-more-status': ['b-defer', 'b-except', 'b-mark-cvr', 'b-unread'],
    'report-more-editor': ['b-copy', 'b-paste', 'b-clear', 'b-report-template'],
    'report-more-output': ['b-print', 'b-history'],
}
SECTION_LABELS = {'report-more-reading': 'Reading', 'report-more-status': 'Status', 'report-more-editor': 'Editor',
                  'report-more-output': 'Print and History'}
NEW_IDS = [MENU] + list(SECTIONS)
# In view with More closed: the top row with its summary, then the footer. UXR-G-08 asks for at most six; Dictate is
# the seventh (see the module docstring).
IN_VIEW = TOP + [MENU + '>summary'] + FOOT
MAX_IN_VIEW = 7
DISABLED = ['b-addendum', 'b-dictate', 'b-except', 'b-mark-cvr', 'b-report-template']
# fix1: the one attribute added to base buttons, the Korean tooltip of the Except placeholder (the base had none).
TITLES_ADDED = {
    'b-except': '판독 제외: 아직 연결되지 않은 기능입니다(7/9단계 예정). 권한 때문에 막힌 것이 아닙니다.',
}
# S7-U1b: Mark CVR's markup tooltip is what shows before critical-result-send.js hears the server, which then writes the
# server's answer there (tests/critical_result_sender_dom_test.py SD01). Here only one Korean tooltip is required.
TITLES_KOREAN = ['b-mark-cvr']
# fix1: (button, the one before it) set apart by 8px on top of the 4px gap; every other neighbour pair keeps 4px.
GAP = 4
GAPPED = {'b-dictate': 'b-prelim', 'b-unread': 'b-mark-cvr', 'b-clear': 'b-paste'}
WIDE_GAP = GAP + 8
# The shipped line that puts the Structured entry into these rows (main.html, inside `if (!structureForm.empty)`).
STRUCTURED_LINE = '$("#b-print").before(button);'

ONE_ROW = [(1366, 768), (1680, 1100), (1920, 1200)]
NARROW = [(1024, 768), (1280, 800)]
MODES = [('plain', False, False), ('reading', True, False), ('portrait', False, True), ('reading-portrait', True, True)]
FONT = '11px'


def lf(text):
    return text.replace('\r\n', '\n')


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def scripts_digest(text):
    return digest('\n\0\n'.join(re.findall(r'<script\b[^>]*>.*?</script>', lf(text), flags=re.S)))


def regions(text):
    """[start, end) of this unit's CSS block, button-row region and footer row in `text` (LF)."""
    cs = text.index(CSS_START)
    ce = text.index(CSS_END, cs) + len(CSS_END)
    ms = text.index(MARKUP_START)
    me = text.index(ROW_CLOSE, text.index(RBTNS_OPEN, ms)) + len(ROW_CLOSE)
    fs = text.index(RFOOT_OPEN, me)
    fe = text.index(ROW_CLOSE, fs) + len(ROW_CLOSE)
    assert cs < ce < ms < me < fs < fe, 'the S5-UI3 regions are out of order'
    return (cs, ce), (ms, me), (fs, fe)


def without_ui3(text):
    """main.html with this unit's three regions replaced by the base bytes (LF). Raises if a region is missing."""
    text = lf(text)
    (cs, ce), (ms, me), (fs, fe) = regions(text)
    return text[:cs] + text[ce:ms] + BASE_RBTNS + text[me:fs] + BASE_RFOOT + text[fe:]


def base_text():
    """The base main.html when this clone has the commit, else None (shallow CI checkout)."""
    try:
        run = subprocess.run(['git', 'show', f'{BASE}:{REL_MAIN}'], cwd=str(ROOT), capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return lf(run.stdout.decode('utf-8')) if run.returncode == 0 else None


def page_html(text):
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', text, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: '<style>' + (ASSETS / m.group(1)).read_text(encoding='utf-8') + '</style>', html)
    return re.sub(r'<link\b[^>]*>', '', html)


# [start tag without children, whitespace-folded label] of each button, found by id, or by label for the two the base
# left without one; the id this unit gave them is taken off before serializing.
ELEMENTS = r"""(buttons)=>{
  const fold=s=>s.replace(/\s+/g,' ').trim();
  const find=(id,label)=>document.getElementById(id)||(label?[...document.querySelectorAll('.report-p button:not([id])')]
    .find(b=>fold(b.textContent)===label):null);
  return buttons.map(([id,label])=>{const e=find(id,label);if(!e)return [id,null,null];
    const c=e.cloneNode(false);if(label&&c.id===id)c.removeAttribute('id');return [id,c.outerHTML,fold(e.textContent)]});
}"""

WHERE = r"""(ids)=>ids.map(id=>{const e=document.getElementById(id);if(!e)return [id,null,null,null];
  const p=e.parentElement,row=p.classList.contains('rbtns')?'rbtns':p.classList.contains('rfoot2')?'rfoot2':null;
  const menu=p.closest('details'),section=e.closest('.toolbar-section');
  return [id,row,menu?menu.id:null,section?section.id:null]})"""

SHOWN = r"""()=>[...document.querySelectorAll('.report-p .rbtns :is(button,summary), .report-p .rfoot2 :is(button,summary)')]
  .filter(e=>e.getClientRects().length).map(e=>e.id||(e.tagName==='SUMMARY'?e.parentElement.id+'>summary':e.outerHTML.slice(0,60)))"""

# The Structured entry as the page script adds it (the pinned STRUCTURED_LINE, after building the same button).
STRUCTURED = r"""()=>{const b=document.createElement('button');b.id='b-structured';b.type='button';b.textContent='Structured';
  b.title='서식에서 고른 값을 판독문 본문에 한 줄로 넣습니다';document.querySelector('#b-print').before(b);}"""

# The dictation pane at its plain cap with a review transcript, as tests/e2e/test_dictation_live.py drives it.
PANE = r"""()=>{const q=s=>document.querySelector(s);q('#dictation-pane').hidden=false;const t=q('#dictation-text');t.hidden=false;
  t.textContent=Array.from({length:12},(_,n)=>'geometry review line '+(n+1)).join('\n');q('#dictation-status').textContent='검토';
  for(const id of ['dictation-insert','dictation-cancel'])q('#'+id).hidden=false;}"""
NO_PANE = r"""()=>{document.querySelector('#dictation-pane').hidden=true;}"""
# In portrait the report panel sits below the fold of a scrolled workspace, and with More and the pane open a short
# window pushes its bottom out: bring the whole panel into view the least way, as a reader scrolling to it would.
SETTLE = r"""()=>{const e=document.querySelector('.report-p'),r=e.getBoundingClientRect();
  if(r.top<0||r.bottom>innerHeight)e.scrollIntoView({block:r.height<=innerHeight?'nearest':'start',inline:'nearest'});}"""

MEASURE = r"""()=>{
  const q=s=>document.querySelector(s);
  const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}};
  const own=e=>{const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;
    const t=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return !!t&&e.contains(t)};
  const key=e=>e.id||(e.tagName==='SUMMARY'?e.parentElement.id+'>summary':e.textContent.trim());
  const one=e=>({key:key(e),...box(e),own:own(e),font:getComputedStyle(e).fontSize,disabled:!!e.disabled});
  const row=q('.report-p .rbtns');
  const top=[...row.children].map(c=>c.tagName==='DETAILS'?c.querySelector(':scope > summary'):c).map(one);
  // Natural heights: the row stretches its items to the tallest, so read each item's own height unstretched.
  const was=row.style.alignItems;row.style.alignItems='flex-start';
  const natural=[...row.children].map(c=>c.tagName==='DETAILS'?c.querySelector(':scope > summary'):c)
    .map(e=>[key(e),e.getBoundingClientRect().height]);
  row.style.alignItems=was;
  const pane=q('#dictation-pane');
  return {vw:innerWidth,vh:innerHeight,open:q('#report-more').open,rbtns:box(row),rfoot:box(q('.report-p .rfoot2')),
    redit:box(q('.report-p .redit')),pane:pane.hidden?null:box(pane),panel:box(q('#report-more > .toolbar-menu-panel')),
    top,natural,foot:[...q('.report-p .rfoot2').children].map(one),menu:[...document.querySelectorAll('#report-more button')].map(one),
    sections:[...document.querySelectorAll('#report-more .toolbar-section')].map(s=>{const h=getComputedStyle(s,'::before');
      return {id:s.id,...box(s),ids:[...s.children].map(c=>c.id),kids:[...s.children].map(c=>({key:c.id,...box(c)})),
        head:{label:s.getAttribute('aria-label'),content:h.content,font:h.fontSize,display:h.display}}}),
    fields:['findings','conclusion','recommendation'].map(i=>({id:i,...box(q('#'+i))}))};
}"""

# Where a control is drawn, whether a pointer reaches it at its centre, and whether it takes focus.
REACH = r"""(e)=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
  e.focus();return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height,own:!!hit&&(hit===e||e.contains(hit)),
  focused:document.activeElement===e}}"""

ACTIVE = r"""()=>{const e=document.activeElement;if(!e||e===document.body)return null;
  if(e.id)return e.id;if(e.tagName==='SUMMARY')return e.parentElement.id+'>summary';return e.outerHTML.slice(0,60)}"""
ENABLE_ALL = r"""()=>{for(const b of document.querySelectorAll('.report-p .rbtns button, .report-p .rfoot2 button'))b.disabled=false}"""


def overlap(a, c):
    return min(a['r'], c['r']) - max(a['x'], c['x']) > 1 and min(a['b'], c['b']) - max(a['y'], c['y']) > 1


def centre_in(a, c):
    x, y = (a['x'] + a['r']) / 2, (a['y'] + a['b']) / 2
    return c['x'] <= x <= c['r'] and c['y'] <= y <= c['b']


class ReportActionsStructureTest(unittest.TestCase):
    """Stdlib side: bytes and ids against the base."""

    @classmethod
    def setUpClass(cls):
        cls.text = lf(MAIN.read_text(encoding='utf-8'))
        # S5-U4c, S5-U4b and S7-U1b (after this unit) added regions outside this unit's three; the byte pins below compare
        # main.html with those taken out: S7-U1b's (tests/critical_result_sender_dom_test.py, which also puts Mark CVR's
        # base tooltip back), S5-U4c's regions and the five shared kinOn401 lines (tests/clinician_request_dom_test.py),
        # then S5-U4b's four (tests/clinician_question_dom_test.py). Imported here because those modules need Playwright
        # and this class does not otherwise.
        from clinician_question_dom_test import without_u4b
        from clinician_request_dom_test import without_u4c_main
        from critical_result_sender_dom_test import without_u1b
        cls.pinned = without_u4b(without_u4c_main(without_u1b(cls.text)))
        cls.base = base_text()
        print('base commit', BASE, 'present' if cls.base is not None else 'absent in this clone; pinned values used')

    def test_pins_match_the_base_commit_when_it_is_present(self):
        self.assertEqual(BASE_RBTNS_SHA256, digest(BASE_RBTNS))
        self.assertEqual(BASE_RFOOT_SHA256, digest(BASE_RFOOT))
        if self.base is None:
            self.skipTest('base commit not in this clone (shallow checkout); the pins stand for it')
        self.assertEqual(BASE_MAIN_SHA256, digest(self.base))
        self.assertEqual(BASE_SCRIPTS_SHA256, scripts_digest(self.base))
        start = self.base.index(RBTNS_OPEN)
        self.assertEqual(BASE_RBTNS, self.base[start:self.base.index(ROW_CLOSE, start) + len(ROW_CLOSE)])
        start = self.base.index(RFOOT_OPEN)
        self.assertEqual(BASE_RFOOT, self.base[start:self.base.index(ROW_CLOSE, start) + len(ROW_CLOSE)])

    def test_everything_outside_the_three_regions_is_the_base_bytes_and_the_script_is_unchanged(self):
        restored = without_ui3(self.pinned)
        self.assertEqual(BASE_MAIN_SHA256, digest(restored), 'a byte outside the S5-UI3 regions moved')
        if self.base is not None:
            self.assertEqual(self.base, restored)
        self.assertEqual(BASE_SCRIPTS_SHA256, scripts_digest(self.pinned))
        (cs, ce), (ms, me), (fs, fe) = regions(self.text)
        for name, (start, end) in (('css', (cs, ce)), ('rows', (ms, me)), ('footer', (fs, fe))):
            self.assertNotIn('<script', self.text[start:end], name)
        # The one line of script that places a button in these rows is still there, once.
        self.assertEqual(1, self.text.count(STRUCTURED_LINE))

    def test_the_css_block_sets_font_size_only_to_the_buttons_size(self):
        (cs, ce), _, _ = regions(self.text)
        block = self.text[cs:ce]
        fonts = [(m.group(1), m.group(2), m.start()) for m in
                 re.finditer(r'\bfont(-size|-family|-weight)?\s*:\s*([^;]+);', block)]
        # Only the two new things that carry text get a size, the one the buttons beside them have (main.html
        # .rbtns button): the More summary and (fix1) the section headings. Nothing else changes a font.
        self.assertEqual([('-size', FONT), ('-size', FONT)], [f[:2] for f in fonts])
        rules = [block[block.rfind('}', 0, at) + 1:at] for _, _, at in fonts]
        self.assertIn('.rbtns > .toolbar-menu > summary', rules[0])
        self.assertIn('.rbtns .toolbar-section::before', rules[1])
        self.assertRegex(self.text, r'\.rbtns button, \.rfoot2 button \{[^}]*font-size: 11px;')

    def test_every_base_button_is_there_once_and_only_the_named_ids_are_new(self):
        for key in BUTTON_IDS + NEW_IDS:
            with self.subTest(key):
                self.assertEqual(1, self.text.count(f'id="{key}"'), key)
        _, (ms, me), (fs, fe) = regions(self.text)
        ids = re.findall(r'\bid="([^"$]+)"', self.text[ms:me] + self.text[fs:fe])
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(BUTTON_IDS) | set(NEW_IDS), set(ids))
        base_ids = re.findall(r'\bid="([^"$]+)"', BASE_RBTNS + BASE_RFOOT)
        self.assertEqual(set(BUTTON_IDS) - set(GIVEN_IDS), set(base_ids))
        # Every base button is declared exactly once: in view, or in one section of More.
        declared = TOP + FOOT + [i for ids in SECTIONS.values() for i in ids]
        self.assertEqual(sorted(BUTTON_IDS), sorted(declared))
        self.assertLessEqual(len(IN_VIEW), MAX_IN_VIEW)


class ReportActionsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.html = page_html(MAIN.read_text(encoding='utf-8'))
        cls.base = base_text()
        cls.seen = []
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / 'report-actions-geometry.json').write_text(
            json.dumps({'report_actions_geometry': cls.seen}, ensure_ascii=False, indent=1), encoding='utf-8')

    def open_page(self, width, height, reading=False, portrait=False, html=None, structured=True):
        page = self.browser.new_page(viewport={'width': width, 'height': height})
        page.set_default_timeout(4000)
        page.route('**/*', lambda route: route.abort())
        page.set_content(html or self.html)
        page.evaluate('([r,p])=>{document.body.classList.toggle("reading",r);document.body.classList.toggle("portrait",p)}',
                      [reading, portrait])
        if structured:
            page.evaluate(STRUCTURED)
        return page

    def shot(self, page, name):
        OUT.mkdir(parents=True, exist_ok=True)
        page.locator('.report-p').screenshot(path=str(OUT / f'report-actions-{name}.png'))

    def measure(self, page):
        page.evaluate(SETTLE)
        return page.evaluate(MEASURE)

    # ── (a) structure, as the browser sees it ──

    def test_buttons_keep_their_base_tags_attributes_and_labels(self):
        page = self.open_page(1366, 768, structured=False)
        try:
            got = page.evaluate(ELEMENTS, BUTTONS)
        finally:
            page.close()
        self.assertEqual([], [row[0] for row in got if row[1] is None])
        disabled = [key for key, tag, _ in got if re.search(r'\sdisabled=""', tag)]
        self.assertEqual(DISABLED, disabled)
        # fix1 added one attribute, a tooltip, to the two placeholders: Except's is there with the pinned text, Mark CVR's
        # (S7-U1b) is one Korean tooltip, and with it taken off the start tag is the base's. Any other difference still
        # fails the comparison below.
        for row in got:
            if row[0] in TITLES_ADDED:
                attribute = f' title="{TITLES_ADDED[row[0]]}"'
                with self.subTest(title=row[0]):
                    self.assertEqual(1, row[1].count(attribute), row[1])
                row[1] = row[1].replace(attribute, '')
            if row[0] in TITLES_KOREAN:
                found = re.findall(r' title="([^"]*)"', row[1])
                with self.subTest(title=row[0]):
                    self.assertEqual(1, len(found), row[1])
                    self.assertRegex(found[0], '[가-힣]')
                row[1] = re.sub(r' title="[^"]*"', '', row[1])
        # The pin stands for the base: the same serialization of the base markup (the literals, or the commit).
        page = self.open_page(1366, 768, html=page_html(self.base) if self.base else
                              page_html(without_ui3(MAIN.read_text(encoding='utf-8'))), structured=False)
        try:
            expected = page.evaluate(ELEMENTS, BUTTONS)
        finally:
            page.close()
        self.assertEqual(expected, got)

    def test_each_button_is_where_it_is_declared_and_seven_controls_are_in_view(self):
        page = self.open_page(1366, 768)
        try:
            where = {key: (row, menu, section) for key, row, menu, section in page.evaluate(WHERE, BUTTON_IDS)}
            for key in TOP:
                self.assertEqual(('rbtns', None, None), where[key], key)
            for key in FOOT:
                self.assertEqual(('rfoot2', None, None), where[key], key)
            for section, ids in SECTIONS.items():
                for key in ids:
                    with self.subTest(key=key):
                        self.assertEqual((None, MENU, section), where[key], key)
                got = page.evaluate("(s)=>[...document.getElementById(s).children].map(c=>c.id)", section)
                expected = ['b-structured'] + ids if section == 'report-more-output' else ids
                self.assertEqual(expected, got, section)
            menu = page.evaluate("""()=>{const d=document.getElementById('report-more'),s=d.querySelector(':scope > summary'),
              p=d.querySelector(':scope > .toolbar-menu-panel');
              return {tag:d.tagName,cls:d.className,name:d.getAttribute('name'),parent:d.parentElement.className,
                last:d.parentElement.lastElementChild===d,summary:s.textContent.trim(),label:s.getAttribute('aria-label'),
                title:s.title,role:p.getAttribute('role'),panelLabel:p.getAttribute('aria-label'),
                sections:[...p.children].map(c=>[c.id,c.className,c.getAttribute('role'),c.getAttribute('aria-label')])}}""")
            self.assertEqual(('DETAILS', 'toolbar-menu', None, 'rbtns', True),
                             (menu['tag'], menu['cls'], menu['name'], menu['parent'], menu['last']))
            # The label is English and the tooltip Korean (AGENTS.md section 4); the accessible name starts with the
            # visible word, and it is not the toolbar's own "More".
            self.assertEqual('More▾', menu['summary'])
            self.assertEqual('More Report Actions', menu['label'])
            self.assertRegex(menu['title'], '[가-힣]')
            # fix1: the tooltip says where the Structured entry appears, by the section's visible heading.
            self.assertIn('Structured', menu['title'])
            self.assertIn('Print and History', menu['title'])
            self.assertEqual(('group', 'More Report Actions'), (menu['role'], menu['panelLabel']))
            self.assertEqual([[s, 'toolbar-section', 'group', SECTION_LABELS[s]] for s in SECTIONS], menu['sections'])
            # In view with More closed: seven controls, in this order.
            self.assertEqual(IN_VIEW, page.evaluate(SHOWN))
            self.assertLessEqual(len(page.evaluate(SHOWN)), MAX_IN_VIEW)
            # Approve stays the one drawn as the primary action.
            looks = page.evaluate("""()=>['#b-approve','#b-save','#b-prelim'].map(s=>getComputedStyle(document.querySelector(s)).backgroundImage)""")
            self.assertIn('gradient', looks[0])
            self.assertEqual(['none', 'none'], looks[1:])
        finally:
            page.close()

    # ── (b) geometry ──

    def closed_checks(self, m, where):
        top = m['top']
        self.assertEqual([k for k in TOP] + [MENU + '>summary'], [t['key'] for t in top], where)
        centres = [(t['y'] + t['b']) / 2 for t in top]
        self.assertLessEqual(max(centres) - min(centres), 1, f'the top row broke into rows {where}: {top}')
        for i, a in enumerate(top):
            self.assertTrue(a['own'], f'{a["key"]} is covered {where}')
            self.assertEqual(FONT, a['font'], a['key'])
            self.assertGreaterEqual(a['x'], m['rbtns']['x'] - 0.5, a['key'])
            self.assertLessEqual(a['r'], min(m['rbtns']['r'], m['vw']) + 0.5, f'{a["key"]} runs off {where}')
            self.assertGreaterEqual(a['y'], m['rbtns']['y'] - 0.5, a['key'])
            self.assertLessEqual(a['b'], m['rbtns']['b'] + 0.5, a['key'])
            for c in top[i + 1:]:
                self.assertFalse(overlap(a, c), f'{a["key"]} overlaps {c["key"]} {where}')
                self.assertLess(a['x'], c['x'])
        # fix1: Dictate stands apart from the save actions; the rest of the row keeps the 4px gap.
        for a, c in zip(top, top[1:]):
            gap = WIDE_GAP if GAPPED.get(c['key']) == a['key'] else GAP
            self.assertAlmostEqual(gap, c['x'] - a['r'], delta=0.5, msg=f'{a["key"]} to {c["key"]} {where}')
        # The summary does not make the row taller than its buttons.
        natural = dict(m['natural'])
        buttons = max(natural[k] for k in TOP)
        self.assertLessEqual(natural[MENU + '>summary'], buttons + 0.5, f'More is taller than the buttons {where}')
        self.assertLessEqual(m['rbtns']['h'], buttons + 8 + 0.5, f'the top row is taller than one button row {where}')
        foot = m['foot']
        self.assertEqual(FOOT, [f['key'] for f in foot])
        self.assertLessEqual(abs((foot[0]['y'] + foot[0]['b']) / 2 - (foot[1]['y'] + foot[1]['b']) / 2), 1, where)
        for f in foot:
            self.assertTrue(f['own'], f'{f["key"]} is covered {where}')
            self.assertEqual(FONT, f['font'], f['key'])
            self.assertLessEqual(f['r'], m['vw'] + 0.5)
        self.assertFalse(m['open'])
        self.assertEqual([], [b['key'] for b in m['menu'] if b['w'] or b['h']], f'a menu control is drawn while closed {where}')

    def open_checks(self, m, closed, where):
        self.assertTrue(m['open'])
        # The top row does not move within the row when More opens (the panel may have been scrolled to, so the row's
        # own top is the reference).
        for before, after in zip(closed['top'], m['top']):
            self.assertAlmostEqual(before['x'], after['x'], delta=0.5, msg=f'{after["key"]} moved {where}')
            self.assertAlmostEqual(before['y'] - closed['rbtns']['y'], after['y'] - m['rbtns']['y'], delta=0.5,
                                   msg=f'{after["key"]} moved {where}')
        panel, rbtns, redit = m['panel'], m['rbtns'], m['redit']
        row_bottom = max(t['b'] for t in m['top'])
        self.assertGreaterEqual(panel['y'], row_bottom - 0.5, f'More opens over the top row {where}')
        self.assertGreaterEqual(panel['x'], rbtns['x'] - 0.5)
        self.assertLessEqual(panel['r'], rbtns['r'] + 0.5)
        self.assertLessEqual(panel['r'], m['vw'] + 0.5)
        # In the flow: the row grows and what is below it moves down; nothing is drawn over it.
        self.assertLessEqual(panel['b'], rbtns['b'] + 0.5)
        self.assertLessEqual(rbtns['b'], redit['y'] + 0.5, f'the open row reaches into the report fields {where}')
        self.assertGreater(rbtns['h'], closed['rbtns']['h'])
        if not m['pane']:
            # With the pane shown in the reading layout the pane gives way first (reading-workspace.css:112), so the
            # fields move by less; without it they move by exactly what the row gained.
            self.assertAlmostEqual(redit['y'] - rbtns['y'] - (closed['redit']['y'] - closed['rbtns']['y']),
                                   rbtns['h'] - closed['rbtns']['h'], delta=0.5)
        # One section per line, in the declared order and content.
        sections = m['sections']
        self.assertEqual(list(SECTIONS), [s['id'] for s in sections])
        for a, c in zip(sections, sections[1:]):
            self.assertGreaterEqual(c['y'], a['b'] - 0.5, f'{c["id"]} is not below {a["id"]} {where}')
        for s in sections:
            expected = ['b-structured'] + SECTIONS[s['id']] if s['id'] == 'report-more-output' else SECTIONS[s['id']]
            self.assertEqual(expected, s['ids'])
            # fix1: each section is still one line at this width (the heading added no wrap and no line), its heading
            # (the aria-label, drawn before the first button at the buttons' size) is there, and only Reset to Unread
            # and Clear stand apart from the button before them.
            kids = s['kids']
            centres = [(k['y'] + k['b']) / 2 for k in kids]
            self.assertLessEqual(max(centres) - min(centres), 1, f'{s["id"]} wraps {where}: {kids}')
            self.assertLessEqual(s['h'], max(k['h'] for k in kids) + 0.5, f'{s["id"]} is taller than a line {where}')
            head = s['head']
            self.assertEqual(SECTION_LABELS[s['id']], head['label'])
            # Chromium resolves attr() in the computed value: the label's text, with the empty alternative text.
            self.assertEqual(f'"{head["label"]}" / ""', head['content'], f'{s["id"]} heading {where}')
            self.assertEqual(FONT, head['font'], s['id'])
            self.assertNotEqual('none', head['display'])
            self.assertGreaterEqual(kids[0]['x'] - s['x'], 20, f'{s["id"]} shows no heading before its buttons {where}')
            for a, c in zip(kids, kids[1:]):
                gap = WIDE_GAP if GAPPED.get(c['key']) == a['key'] else GAP
                self.assertAlmostEqual(gap, c['x'] - a['r'], delta=0.5, msg=f'{a["key"]} to {c["key"]} {where}')
        for b in m['menu']:
            self.assertGreater(b['w'], 0, b['key'])
            self.assertGreater(b['h'], 0, b['key'])
            self.assertTrue(b['own'], f'{b["key"]} in More is covered {where}')
            self.assertEqual(FONT, b['font'], b['key'])
            self.assertGreaterEqual(b['x'], panel['x'] - 0.5, b['key'])
            self.assertLessEqual(b['r'], panel['r'] + 0.5, b['key'])
            self.assertGreaterEqual(b['y'], panel['y'] - 0.5, b['key'])
            self.assertLessEqual(b['b'], panel['b'] + 0.5, b['key'])
            for field in m['fields']:
                self.assertFalse(overlap(b, field), f'{b["key"]} covers #{field["id"]} {where}')
            if m['pane']:
                self.assertFalse(overlap(b, m['pane']), f'{b["key"]} covers the dictation pane {where}')

    def pane_checks(self, m, where):
        pane = m['pane']
        self.assertIsNotNone(pane)
        # G4 and G0 of G-LIVE-GEO, here without the real stack: the pane is below the whole button row, and Dictate
        # keeps its centre outside it and owns it.
        self.assertGreaterEqual(pane['y'], m['rbtns']['b'] - 0.5, f'the pane is not below the button row {where}')
        dictate = next(t for t in m['top'] if t['key'] == 'b-dictate')
        self.assertTrue(dictate['own'], f'Dictate is covered {where}')
        self.assertFalse(centre_in(dictate, pane), f'the dictation pane covers Dictate {where}')
        if m['open']:
            self.assertLessEqual(m['panel']['b'], pane['y'] + 0.5, f'More reaches into the dictation pane {where}')

    def reach_menu(self, page, where):
        """Every control of the open More is drawn, owns its centre and takes focus (disabled ones cannot take focus)."""
        reached = []
        for key in page.evaluate("()=>[...document.querySelectorAll('#report-more button')].map(b=>b.id)"):
            locator = page.locator('#' + key)
            locator.scroll_into_view_if_needed()
            reach = locator.evaluate(REACH)
            self.assertGreater(reach['w'], 0, key)
            self.assertTrue(reach['own'], f'{key} is covered {where}')
            if not page.evaluate('(k)=>document.getElementById(k).disabled', key):
                self.assertTrue(reach['focused'], f'{key} cannot take focus {where}')
            reached.append(key)
        return reached

    def check_layout(self, width, height, mode, reading, portrait):
        page = self.open_page(width, height, reading, portrait)
        where = f'at {width}x{height} {mode}'
        record = {'width': width, 'height': height, 'mode': mode}
        ok = False
        try:
            closed = self.measure(page)
            self.closed_checks(closed, where)
            record['closed'] = {'rbtns_h': closed['rbtns']['h'], 'rfoot_h': closed['rfoot']['h'],
                                'fields_h': [f['h'] for f in closed['fields']]}
            self.shot(page, f'{width}x{height}-{mode}-closed')
            page.evaluate(PANE)
            closed_pane = self.measure(page)
            self.pane_checks(closed_pane, where + ' with the pane')
            page.locator('#report-more > summary').click()
            open_pane = self.measure(page)
            self.pane_checks(open_pane, where + ' with More and the pane open')
            self.open_checks(open_pane, closed_pane, where + ' with the pane')
            # Recorded, not asserted: what an open More costs the report column when the pane is also open (the reason
            # Dictate stays in view).
            record['open_pane'] = {'rbtns_h': open_pane['rbtns']['h'], 'pane_h': open_pane['pane']['h'],
                                   'fields_h': [f['h'] for f in open_pane['fields']],
                                   'report_h_gain': open_pane['rfoot']['b'] - open_pane['rbtns']['y']
                                   - (closed_pane['rfoot']['b'] - closed_pane['rbtns']['y'])}
            self.shot(page, f'{width}x{height}-{mode}-open-pane')
            page.evaluate(NO_PANE)
            opened = self.measure(page)
            self.open_checks(opened, closed, where)
            record['open'] = {'rbtns_h': opened['rbtns']['h'], 'panel_h': opened['panel']['h'], 'lines': len(opened['sections']),
                              'fields_h': [f['h'] for f in opened['fields']]}
            self.shot(page, f'{width}x{height}-{mode}-open')
            record['reached'] = self.reach_menu(page, where)
            self.assertEqual(sorted(record['reached']), sorted(['b-structured'] + [i for ids in SECTIONS.values() for i in ids]))
            # Closing gives the one row back.
            page.locator('#report-more > summary').click()
            again = self.measure(page)
            self.closed_checks(again, where + ' after closing')
            self.assertAlmostEqual(closed['rbtns']['h'], again['rbtns']['h'], delta=0.5)
            ok = True
        finally:
            record['passed'] = ok
            self.seen.append(record)
            page.close()

    def test_one_top_row_from_1366_in_every_layout_and_more_opens_below_it(self):
        for width, height in ONE_ROW:
            for mode, reading, portrait in MODES:
                with self.subTest(width=width, mode=mode):
                    self.check_layout(width, height, mode, reading, portrait)

    def test_narrow_windows_may_wrap_but_keep_every_control_reachable(self):
        for width, height in NARROW:
            for mode, reading, portrait in MODES[:2]:
                with self.subTest(width=width, mode=mode):
                    page = self.open_page(width, height, reading, portrait)
                    where = f'at {width}x{height} {mode}'
                    try:
                        page.evaluate(SETTLE)
                        for key in IN_VIEW:
                            locator = page.locator('#report-more > summary' if key.endswith('>summary') else '#' + key)
                            locator.scroll_into_view_if_needed()
                            reach = locator.evaluate(REACH)
                            self.assertTrue(reach['own'], f'{key} is covered {where}')
                            self.assertGreaterEqual(reach['x'], -0.5, key)
                            self.assertLessEqual(reach['r'], width + 0.5, key)
                        page.locator('#report-more > summary').click()
                        m = self.measure(page)
                        self.assertLessEqual(m['rbtns']['b'], m['redit']['y'] + 0.5, where)
                        self.reach_menu(page, where)
                        self.shot(page, f'{width}x{height}-{mode}-narrow-open')
                    finally:
                        page.close()

    # ── (c) keyboard ──

    def test_tab_walks_the_row_and_enter_space_open_and_close_more(self):
        for width, height, mode, reading in ((1366, 768, 'plain', False), (1366, 768, 'reading', True)):
            with self.subTest(mode=mode):
                page = self.open_page(width, height, reading)
                try:
                    page.evaluate(ENABLE_ALL)
                    page.locator('#b-approve').focus()
                    order = [page.evaluate(ACTIVE)]
                    for _ in range(5):
                        page.keyboard.press('Tab')
                        order.append(page.evaluate(ACTIVE))
                    # More closed: the top row left to right, then the report fields.
                    self.assertEqual(TOP + [MENU + '>summary', 'findings'], order)
                    # Keyboard focus on the summary is drawn.
                    page.locator('#report-more > summary').focus()
                    page.keyboard.press('Shift+Tab')
                    page.keyboard.press('Tab')
                    self.assertEqual(MENU + '>summary', page.evaluate(ACTIVE))
                    self.assertNotEqual('none', page.evaluate(
                        "getComputedStyle(document.querySelector('#report-more > summary')).outlineStyle"))
                    # Enter opens; Tab enters the menu and walks it in its own order, then leaves for the fields.
                    page.keyboard.press('Enter')
                    self.assertTrue(page.evaluate("document.querySelector('#report-more').open"))
                    menu = page.evaluate("()=>[...document.querySelectorAll('#report-more button')].map(b=>b.id)")
                    walked = []
                    for _ in range(len(menu) + 1):
                        page.keyboard.press('Tab')
                        walked.append(page.evaluate(ACTIVE))
                    self.assertEqual(menu + ['findings'], walked)
                    for _ in range(len(menu) + 1):
                        page.keyboard.press('Shift+Tab')
                    self.assertEqual(MENU + '>summary', page.evaluate(ACTIVE))
                    # Space closes it and focus stays on the summary; Space opens it again, Enter closes it.
                    page.keyboard.press('Space')
                    self.assertFalse(page.evaluate("document.querySelector('#report-more').open"))
                    self.assertEqual(MENU + '>summary', page.evaluate(ACTIVE))
                    page.keyboard.press('Space')
                    self.assertTrue(page.evaluate("document.querySelector('#report-more').open"))
                    page.keyboard.press('Enter')
                    self.assertFalse(page.evaluate("document.querySelector('#report-more').open"))
                    # Closed again: Tab leaves the summary for the fields.
                    page.keyboard.press('Tab')
                    self.assertEqual('findings', page.evaluate(ACTIVE))
                finally:
                    page.close()

    # ── (d) fix1, proposal 6: a real pointer and the shipped disabled states ──

    def test_a_real_click_on_more_then_on_each_button_inside_reaches_that_button(self):
        """The summary opened by a pointer click, not by setting `open`; then every enabled control inside it clicked by
        the pointer at its centre (Playwright refuses a click another element would receive) and focused by it."""
        for mode, reading in (('plain', False), ('reading', True)):
            with self.subTest(mode=mode):
                page = self.open_page(1366, 768, reading)
                try:
                    page.evaluate(PANE)
                    page.evaluate(SETTLE)
                    page.evaluate("()=>{window.__hits=[];document.addEventListener('click',e=>{"
                                  "const t=e.target.closest('button,summary');__hits.push(t?(t.id||t.tagName):e.target.tagName)},true)}")
                    page.locator('#report-more > summary').click()
                    self.assertTrue(page.evaluate("document.querySelector('#report-more').open"))
                    # Clicking a button would run its handler; the page script is stripped, so only its state is taken
                    # off here, where the layout does not depend on it.
                    page.evaluate(ENABLE_ALL)
                    menu = page.evaluate("()=>[...document.querySelectorAll('#report-more button')].map(b=>b.id)")
                    self.assertEqual(['b-addendum', 'b-transcribe', 'b-defer', 'b-except', 'b-mark-cvr', 'b-unread',
                                      'b-copy', 'b-paste', 'b-clear', 'b-report-template', 'b-structured', 'b-print',
                                      'b-history'], menu)
                    for key in menu:
                        page.locator('#' + key).click(timeout=2000)
                        self.assertEqual(key, page.evaluate('()=>__hits.at(-1)'), f'{key} at 1366x768 {mode}')
                        self.assertEqual(key, page.evaluate(ACTIVE), f'{key} not focused by the click {mode}')
                        self.assertTrue(page.evaluate("document.querySelector('#report-more').open"), key)
                    # The first click the page saw was the summary's, and each later one the button's.
                    self.assertEqual(['SUMMARY'] + menu, page.evaluate('()=>__hits'))
                finally:
                    page.close()

    def test_keyboard_opens_more_and_lands_on_its_first_enabled_button_with_the_shipped_disabled_states(self):
        """Tab from Approve to the summary (disabled Dictate is skipped), Enter opens More, Tab lands on the first
        enabled button inside it (Addendum is disabled until a report is approved) and walks only enabled ones."""
        for mode, reading in (('plain', False), ('reading', True)):
            with self.subTest(mode=mode):
                page = self.open_page(1366, 768, reading)
                try:
                    page.locator('#b-approve').focus()
                    order = []
                    for _ in range(3):
                        page.keyboard.press('Tab')
                        order.append(page.evaluate(ACTIVE))
                    self.assertEqual(['b-save', 'b-prelim', MENU + '>summary'], order)
                    page.keyboard.press('Enter')
                    self.assertTrue(page.evaluate("document.querySelector('#report-more').open"))
                    enabled = page.evaluate(
                        "()=>[...document.querySelectorAll('#report-more button')].filter(b=>!b.disabled).map(b=>b.id)")
                    self.assertEqual('b-transcribe', enabled[0])
                    walked = []
                    for _ in range(len(enabled) + 1):
                        page.keyboard.press('Tab')
                        walked.append(page.evaluate(ACTIVE))
                    self.assertEqual(enabled + ['findings'], walked)
                    self.assertTrue(set(walked).isdisjoint(DISABLED), walked)
                finally:
                    page.close()

    # ── (e) S7-U1b: Mark CVR follows the server ──

    def test_mark_cvr_is_on_only_while_the_server_says_the_study_can_be_sent(self):
        """Disabled in the markup (no server answer yet). critical-result-send.js, mounted by main.html's shipped S7-U1b
        block, keeps it off with the contract's reason for sendable:false and turns it on only for sendable:true; on, it
        is a keyboard stop in the Status section between Defer and Reset to Unread, and a pointer click on it opens Send
        Critical Result. tests/critical_result_sender_dom_test.py covers every reason, refusal and late answer."""
        from urllib.parse import urlparse
        from playwright.sync_api import expect
        from critical_result_sender_dom_test import (A, BLOCK, HEADS, HOOK_LINES, INSTITUTION, JS_NAME, P, PRELUDE, RAD,
                                                     REASONS, SETUP, SHIPPED_JS, STUDIES, TAIL, me)
        origin, owner = 'https://report.test', [INSTITUTION, RAD['sub']]
        sendable = {'sendable': True, 'reason': None, 'source': {**HEADS[A], 'final': True},
                    'recipients': [{key: P[key] for key in ('sub', 'actor', 'name', 'role')}]}
        answers = [{'sendable': False, 'reason': 'NO_PINNABLE_SOURCE', 'source': None, 'recipients': []}]
        asked = []

        def handle(route):
            path = urlparse(route.request.url).path
            if path == '/worklist/hpacs-lite/main.html':
                route.fulfill(body=self.html, content_type='text/html; charset=utf-8')
            elif path == '/worklist/hpacs-lite/' + JS_NAME:
                route.fulfill(body=SHIPPED_JS, content_type='application/javascript; charset=utf-8')
            elif path == f'/api/studies/{A}/critical-result-recipients':
                asked.append(path)
                route.fulfill(json={'owner': owner, 'uid': A, **(answers.pop(0) if answers else sendable)})
            elif path == '/api/critical-results':
                route.fulfill(json={'owner': owner, 'view': 'sent', 'items': [], 'nextCursor': None, 'pending': 0})
            else:
                route.abort()

        page = self.browser.new_page(viewport={'width': 1366, 'height': 768})
        page.set_default_timeout(4000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/*', handle)
        try:
            page.goto(origin + '/worklist/hpacs-lite/main.html')
            page.evaluate(SETUP, {'session': me(RAD, ['radiologist']), 'studies': STUDIES, 'app': {A: {'version': 3, 'rs': 'A'}},
                                  'names': {}, 'mode': {'serverMode': True, 'offline': False}})
            page.add_script_tag(url=origin + '/worklist/hpacs-lite/' + JS_NAME)
            page.add_script_tag(content=PRELUDE + BLOCK + TAIL.replace('HOOK', '\n'.join(HOOK_LINES)))
            mark = page.locator('#b-mark-cvr')
            expect(mark).to_be_disabled()
            page.evaluate('u => window.synPick(u)', A)
            expect(mark).to_have_attribute('title', REASONS['NO_PINNABLE_SOURCE'])
            expect(mark).to_be_disabled()
            # The report state moves on and the server now says the study can be sent.
            page.evaluate('u => window.synReport(u, 4, "A", true)', A)
            expect(mark).to_be_enabled()
            self.assertEqual(2, len(asked))
            page.locator('#b-approve').focus()
            for _ in range(3):
                page.keyboard.press('Tab')
            self.assertEqual(MENU + '>summary', page.evaluate(ACTIVE))
            page.keyboard.press('Enter')
            enabled = page.evaluate("()=>[...document.querySelectorAll('#report-more button')].filter(b=>!b.disabled).map(b=>b.id)")
            self.assertLess(enabled.index('b-defer'), enabled.index('b-mark-cvr'))
            self.assertLess(enabled.index('b-mark-cvr'), enabled.index('b-unread'))
            walked = []
            for _ in range(len(enabled) + 1):
                page.keyboard.press('Tab')
                walked.append(page.evaluate(ACTIVE))
            self.assertEqual(enabled + ['findings'], walked)
            mark.click(timeout=2000)
            expect(page.locator('#cvr-send')).to_be_visible()
            self.assertEqual([], errors)
        finally:
            page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
