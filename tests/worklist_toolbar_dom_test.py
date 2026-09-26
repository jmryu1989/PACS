# coding: utf-8
"""TEST-S5-UI2-TOOLBAR-DOM: the worklist toolbar groups (UXR-G-01) in the real markup/CSS, no services.

REQ-S5-UI2-TOOLBAR-GROUPS: the controls above the worklist were about 35 buttons, inputs and texts in three rows at
1366-1680px (143px) and two at 1920px (101px). This unit only regroups them. One row of seven top-level groups stays in
view (Search, Filters, Refresh with its interval menu, View, More, the status texts, and the Search Mode row that
worklist-search.js appends to the toolbar); every other control lives in a native <details> group that opens without
script. Same elements, same ids, same labels, same handlers: the page script is not touched.

RISK-S5-UI2-TOOLBAR: a control lost or duplicated by the move; a control outside the group it is declared in; a label
or attribute changed on the way; the page script changed; the toolbar wrapping to two rows from 1366px up (a long status
text included); an open group covering the list (a <details> panel does not close on an outside click, so a floating panel
would stay over the first rows and the reading bar); the reading layout moving (G-LIVE-GEO measured it with the old
toolbar, which was always 92px in reading mode); a group that cannot be opened or left with the keyboard.

S5-UI2 fix1 (Astra S5-UI2-IMPROVE-R-001, markup and CSS only): a shortened status text (refresh stopped, a setting not
saved, search criteria not applied) must be readable in full by pointer and by keyboard without the toolbar changing
shape (F01); the Account Layout panel nested in View must stay in the View group's flow, so coordinates the shipped
workspace-roaming.js computed while View was closed cannot misplace it (F02); Filters and View are split into ordered
sections with the resets set apart, and the open-group geometry is also checked below 1366, with Account Layout open
and after the reading toolbar was scrolled.

S5-UI2 fix2 (hosted validate 36254174084, same Playwright 1.60.0 / Chromium 148.0.7778.96 as the local runs): the F02
case pinned the coordinates the script writes while View is closed, read right after set_viewport_size(); the resize
events had not reached the page yet on the hosted runner. The case now waits for them and checks the result instead.

The page script is stripped, as in tests/worklist_header_dom_test.py, and every stylesheet main.html links is inlined in
its own position. The one piece of script that changes the toolbar's shape is added back as shipped: KinWorklistSearch
.mount() appends its row to '.userfilter' exactly as the page does. Role gating stays the page script's disabled/hidden,
so no role matrix is built here; the harness only enables and unhides controls to measure the fullest groups.
"""
import hashlib
import json
import os
import re
import subprocess
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'worklist-v0/hpacs-lite'
MAIN = ASSETS / 'main.html'
REL_MAIN = 'worklist-v0/hpacs-lite/main.html'
# Screenshots go outside the checkout when the runner names a directory, so a run leaves no files behind.
OUT = Path(os.environ.get('KIN_EVIDENCE_DIR') or ROOT / 'tmp/s5-ui2/toolbar')

# The commit this unit started from (main after S5-U4a). A shallow CI clone does not have it, so what it held is pinned
# below; where the commit is present the pins are checked against it first.
BASE = '7a35570826072c0da1f79e7951f218df38fd0156'
TOOLBAR_START = '  <!-- 사용자 필터 영역 (6.2)'
TOOLBAR_END = '\n  <div id="err"></div>'
STYLE_START = '\n  <style>\n'
STYLE_END = '\n  </style>\n'
UI2_CSS_START = '    /* ── S5-UI2 툴바 묶음 (UXR-G-01) ──'
UI2_CSS_END = '\n\n    .split { background: var(--kin-bg); }'

# Every id inside the base toolbar, in document order.
BASE_TOOLBAR_IDS = [
    'quick', 'quick-match', 'qf', 'chips', 'active-filter-info', 'active-filter-name', 'active-filter-state',
    'edit-active-filter', 'refresh', 'worklist-refresh', 'worklist-refresh-status', 'layout-toggle', 'layout-reset',
    'reading-appearance-open', 'image-opening-open', 'consultations-open', 'study-access-open', 'worklist-alerts-open',
    'viewer-windows-open', 'workspace-server-menu', 'workspace-server-panel', 'workspace-server-status', 'layout-status',
    'b-monitor', 'savefilter', 'favorite-open', 'favorite-clear', 'study-tag-open', 'study-tag-clear', 'managefilters',
    'body-parts-load', 'body-parts-refresh', 'body-parts-cancel', 'body-parts-status', 'columnsettings', 'clearfilter',
]
# Base toolbar controls that had no id get one here (Stage 3 anchor inventory: ADDED). Each is found in the base by
# this selector, and apart from the new id it is the same element.
GIVEN_IDS = {
    'qf-days-0': '#qf > button[data-days="0"]', 'qf-days-3': '#qf > button[data-days="3"]',
    'qf-days-7': '#qf > button[data-days="7"]', 'qf-days-30': '#qf > button[data-days="30"]',
    'qf-days-60': '#qf > button[data-days="60"]', 'qf-days-all': '#qf > button[data-days="-1"]',
    'workspace-server-summary': '#workspace-server-menu > summary',
    'workspace-server-save': '#workspace-server-panel > [data-action="save"]',
    'workspace-server-load': '#workspace-server-panel > [data-action="load"]',
    'workspace-server-clear': '#workspace-server-panel > [data-action="clear"]',
}
# The new containers; nothing else is new in the toolbar markup.
GROUP_IDS = ['toolbar-search', 'toolbar-filters', 'toolbar-refresh', 'toolbar-refresh-menu', 'toolbar-view',
             'toolbar-more', 'toolbar-status']
# Where every base toolbar id now lives. Primary groups are always in view; menus are <details>.
PRIMARY = {
    'toolbar-search': ['quick', 'quick-match', 'clearfilter'],
    'toolbar-refresh': ['refresh'],
    # Texts only: a button here would be cut off where the group narrows (about 90px at 1366).
    'toolbar-status': ['layout-status', 'worklist-refresh-status', 'body-parts-status'],
}
MENUS = {
    'toolbar-filters': ['qf', 'chips', 'active-filter-info', 'active-filter-name', 'active-filter-state',
                        'edit-active-filter', 'savefilter', 'managefilters', 'favorite-open', 'favorite-clear',
                        'study-tag-open', 'study-tag-clear', 'body-parts-load', 'body-parts-refresh', 'body-parts-cancel'],
    'toolbar-refresh-menu': ['worklist-refresh'],
    'toolbar-view': ['layout-toggle', 'layout-reset', 'workspace-server-menu', 'workspace-server-panel',
                     'workspace-server-status', 'columnsettings', 'reading-appearance-open', 'image-opening-open',
                     'viewer-windows-open', 'b-monitor'],
    'toolbar-more': ['consultations-open', 'study-access-open', 'worklist-alerts-open'],
}
MAX_PRIMARY = 7
# What the base held, pinned (LF-normalized UTF-8, sha256):
#   the <script> blocks in document order joined by '\n\0\n';
#   the file without the head <style> block and without the toolbar slice (header, list, reading panel, dialogs, script);
#   the head <style> block (this unit only inserts one CSS block into it);
#   [start tag without children, whitespace-folded text] of each BASE_TOOLBAR_IDS element and of each GIVEN_IDS element
#   (the latter without its new id), as the browser serializes them.
BASE_SCRIPTS_SHA256 = '2231eefe0bc40ed48d28887043bf5cb9b0828bcefcb20b659be07d58cf1a7349'
BASE_OUTSIDE_SHA256 = '95e8f2a0ca29fadcdbb14064318fd0f86509261fc7ca4bdd9e9c5c1674ba35c8'
BASE_STYLE_SHA256 = '00e22c847a1c7db387ad651bc8fb980046cb521e1054e9725104b14f72117080'
BASE_ELEMENTS_SHA256 = '530d61cc70107006d92628d98e7199a41471ab360dc046c90249059978e4aa99'

# The direct children of the toolbar, in order: the seven groups in view. 'search-row' is worklist-search.js's row.
TOP = ['toolbar-search', 'toolbar-filters', 'toolbar-refresh', 'toolbar-view', 'toolbar-more', 'toolbar-status',
       'search-row']
# The row: one box per top-level group (the <details> groups draw only their summary).
SEARCH_ROW = '.userfilter > span:has(> button[data-search-apply])'
ROW = ['#toolbar-search', '#toolbar-filters > summary', '#refresh', '#toolbar-refresh-menu > summary',
       '#toolbar-view > summary', '#toolbar-more > summary', '#toolbar-status', SEARCH_ROW]
# Tab order through the closed toolbar, left to right. The status group is a focus stop of its own (fix1 F01): focus
# there shows its texts in full. It is not a control, so the list of controls in view leaves it out.
TAB_ORDER = ['quick', 'quick-match', 'clearfilter', 'toolbar-filters>summary', 'refresh', 'toolbar-refresh-menu>summary',
             'toolbar-view>summary', 'toolbar-more>summary', 'toolbar-status', '[data-search-mode]', '[data-search-apply]',
             '[data-search-clear]']
CONTROLS_IN_VIEW = [key for key in TAB_ORDER if key != 'toolbar-status']
# fix1: the sections inside Filters and View, in order, by the ids each holds (proposals 2 and 3).
SECTIONS = {
    'toolbar-filters': [['qf'],
                        ['savefilter', 'managefilters', 'favorite-open', 'favorite-clear', 'study-tag-open',
                         'study-tag-clear', 'body-parts-load', 'body-parts-refresh', 'body-parts-cancel'],
                        ['chips', 'active-filter-info']],
    'toolbar-view': [['image-opening-open', 'viewer-windows-open', 'b-monitor'],
                     ['layout-toggle', 'columnsettings', 'reading-appearance-open', 'layout-reset'],
                     ['workspace-server-menu']],
}
VIEW_SECTION_TITLES = ['Images', 'This Browser', 'Account']
# A reset sits at the end of its section, apart from the ordinary settings: 12px on top of the 6px flex gap (layout-reset)
# or of the space between inline buttons (Reset Account Layout).
RESET_GAP = 12
ONE_ROW = [(1366, 768), (1680, 1100), (1920, 1200)]
NARROW = [(1024, 768), (1280, 800)]
MODES = [('normal', False, False), ('reading', True, False), ('portrait', False, True), ('reading-portrait', True, True)]
HEADER_HEIGHT = 52
# 12px padding, one 34px control row, 12px padding and the 1px bottom border.
ROW_HEIGHT = 59
# reading-workspace.css caps the toolbar at 92px in reading mode; the base toolbar always filled it from 1366 up.
READING_HEIGHT = 92

# The longest texts the page writes into the status group and the search row, each pinned to the file that writes it.
# They must shorten, never wrap the toolbar.
STATUS_TEXTS = [
    ('#layout-status', '초기화 저장 안 됨 · 이 창에서만 유지', 'main.html'),
    ('#worklist-refresh-status', '자동 목록 갱신을 멈췄습니다. Refresh로 직접 갱신할 수 있습니다.', 'worklist-refresh.js'),
    ('#body-parts-status', '인증 또는 접근 권한 오류로 부위 정보를 모두 지웠습니다. 계정과 목록을 다시 확인한 뒤 재조회하세요.',
     'worklist-body-parts.js'),
    ('[data-search-status]', '저장된 검색 설정을 확인할 수 없어 기본값을 적용했습니다.', 'worklist-search.js'),
]
# The applied saved search shown in Filters. A saved search name has no length bound (pacs.service.ts saveFilter only
# rejects an empty one), so the fullest Filters group carries a 400-character Hangul name; Edit Search must stay reachable.
HANGUL = '가나다라마바사아자차카타파하'
SAVED_SEARCH_NAME = (HANGUL * 30)[:400]
SAVED_SEARCH_STATE = ('Modified', 'main.html')


def lf(text):
    return text.replace('\r\n', '\n')


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def parts(text):
    """The toolbar slice, the head <style> block, what lies outside both, and the <script> blocks."""
    text = lf(text)
    ts = text.index(TOOLBAR_START)
    te = text.index(TOOLBAR_END, ts)
    ss = text.index(STYLE_START)
    se = text.index(STYLE_END, ss) + len(STYLE_END)
    assert se <= ts, 'the head <style> block must precede the toolbar'
    return {'toolbar': text[ts:te], 'style': text[ss:se], 'outside': text[:ss] + text[se:ts] + text[te:],
            'scripts': re.findall(r'<script\b[^>]*>.*?</script>', text, flags=re.S)}


def split_ui2_css(style):
    """(the S5-UI2 CSS block, the style block without it)."""
    start = style.index(UI2_CSS_START)
    end = style.index(UI2_CSS_END, start) + 2
    return style[start:end], style[:start] + style[end:]


def scripts_digest(blocks):
    return digest('\n\0\n'.join(blocks))


def ids_in(markup):
    return re.findall(r'\bid="([^"$]+)"', markup)


def base_text():
    """The base main.html when this clone has the commit, else None (shallow CI checkout)."""
    try:
        run = subprocess.run(['git', 'show', f'{BASE}:{REL_MAIN}'], cwd=str(ROOT), capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return run.stdout.decode('utf-8') if run.returncode == 0 else None


def selector_for(key):
    """A CSS selector for a name used in TAB_ORDER and the probes: an id, '<details id>>summary' or '[data-search-*]'."""
    if key.startswith('['):
        return '.userfilter ' + key
    if key.endswith('>summary'):
        return '#' + key[:-len('>summary')] + ' > summary'
    return '#' + key


def page_html(text):
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', text, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: '<style>' + (ASSETS / m.group(1)).read_text(encoding='utf-8') + '</style>', html)
    return re.sub(r'<link\b[^>]*>', '', html)


# worklist-search.js, mounted the way main.html's startup does (host = document.querySelector('.userfilter')).
MOUNT_SEARCH = """()=>{window.__search=KinWorklistSearch.mount({host:document.querySelector('.userfilter'),
  owner:()=>'synthetic-owner',snapshot:()=>({}),render:()=>{}});}"""

ELEMENTS = """([ids, given])=>{
  const fold=s=>s.replace(/\\s+/g,' ').trim();
  const one=e=>[e.cloneNode(false).outerHTML,fold(e.textContent)];
  const out=ids.map(id=>{const e=document.getElementById(id);return e?[id,...one(e)]:[id,null,null]});
  for(const [id,selector] of given){
    const e=document.getElementById(id)||document.querySelector(selector);
    if(!e){out.push([id,null,null]);continue}
    const c=e.cloneNode(false);if(c.id===id)c.removeAttribute('id');out.push([id,c.outerHTML,fold(e.textContent)]);
  }
  return out;
}"""

WHERE = """(ids)=>ids.map(id=>{const e=document.getElementById(id);if(!e)return [id,null,null];
  const menu=e.parentElement&&e.parentElement.closest('.toolbar-menu');
  const primary=['toolbar-search','toolbar-refresh','toolbar-status'].find(g=>{const c=document.getElementById(g);return c&&c.contains(e)});
  return [id,menu?menu.id:null,primary||null]})"""

MEASURE = """(row)=>{
  const box=e=>{const r=e.getBoundingClientRect();return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}};
  const bar=document.querySelector('.userfilter');
  const items=row.map(s=>{const e=document.querySelector(s);return e?{sel:s,...box(e),sw:e.scrollWidth,cw:e.clientWidth}:{sel:s,missing:true}});
  const statuses=['#layout-status','#worklist-refresh-status','#body-parts-status','[data-search-status]'].map(s=>{
    const e=document.querySelector(s),cs=getComputedStyle(e);
    return {sel:s,...box(e),sh:e.scrollHeight,ch:e.clientHeight,font:parseFloat(cs.fontSize),whiteSpace:cs.whiteSpace,
            text:e.textContent,shown:!e.closest('[hidden]')}});
  return {vw:innerWidth,bar:{...box(bar),sw:bar.scrollWidth,cw:bar.clientWidth,st:bar.scrollTop},
          menubar:box(document.querySelector('.menubar')),split:box(document.querySelector('.split')),items,statuses,
          open:[...document.querySelectorAll('.userfilter details')].filter(d=>d.open).map(d=>d.id),
          docSW:document.documentElement.scrollWidth};
}"""

# The controls an open group shows, in order: its own panel, a closed nested <details> by its summary only. Each is
# tagged data-probe=<n> so id-less ones (the saved-search chips) can be reached too.
CONTROLS = """(id)=>{const nested=e=>e.parentElement.closest('details:not(.toolbar-menu)');
  return [...document.querySelectorAll('#'+id+' > .toolbar-menu-panel :is(button,input,select,summary)')]
  .filter(e=>!e.closest('[hidden]')&&getComputedStyle(e).display!=='none'&&(e.tagName==='SUMMARY'||!nested(e)||nested(e).open))
  .map((e,n)=>{e.dataset.probe=id+'-'+n;return [e.dataset.probe,e.id||e.textContent.trim()]})}"""

# Where a control is drawn and whether it is the element a pointer reaches at its centre.
REACH = """(e)=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
  e.focus();return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height,own:!!hit&&(hit===e||e.contains(hit)),
  focused:document.activeElement===e,vw:innerWidth}}"""

# Every control shown and enabled, a dozen saved-search chips, an applied saved search with the longest name, and the
# widest labels the page script writes: the fullest the groups get.
FULLEST = """([name,state])=>{
  for(const e of document.querySelectorAll('.toolbar-menu-panel [hidden]'))e.hidden=false;
  for(const e of document.querySelectorAll('.userfilter [disabled]'))e.disabled=false;
  document.querySelector('#b-monitor').style.display='';
  const chips=document.querySelector('#chips');
  for(let i=0;i<12;i++){const b=document.createElement('button');b.className='chip';b.dataset.i=String(i);
    b.textContent='저장 검색 '+i+' 흉부 CT 추적 ('+(i*37)+')';chips.append(b);}
  document.querySelector('#active-filter-name').textContent=name;
  document.querySelector('#active-filter-state').textContent=state;
  document.querySelector('#layout-toggle').textContent='Layout: Landscape';
  document.querySelector('#study-access-open').textContent='Study Access: Restricted';
}"""
# Whether the closed Filters summary carries its active-filter dot.
DOT = """()=>{const cs=getComputedStyle(document.querySelector('#toolbar-filters > summary'),'::before');
  return {content:cs.content,w:parseFloat(cs.width)||0,h:parseFloat(cs.height)||0}}"""

ACTIVE = """()=>{const e=document.activeElement;if(!e||!e.closest('.userfilter'))return null;
  if(e.id)return e.id;if(e.tagName==='SUMMARY')return e.parentElement.id+'>summary';
  for(const a of ['data-search-mode','data-search-apply','data-search-clear'])if(e.hasAttribute(a))return '['+a+']';
  return e.outerHTML.slice(0,60)}"""
ACTIVE_X = "()=>document.activeElement.getBoundingClientRect().left"

# workspace-roaming.js mounted as shipped, signed out: no request is made, but its place() listeners (toggle, resize,
# scroll) are attached and write the panel's left/top exactly as on the page.
MOUNT_ROAMING = """()=>{KinWorkspaceRoaming.mount({owner:null,read:()=>null,apply:()=>false,generation:()=>0,
  model:{normalize:v=>v},endpoint:'/api/workspace-layout',sessionEndpoint:'/api/me'});
  for(const b of document.querySelectorAll('#workspace-server-panel button'))b.disabled=false;
  window.__clicks={};for(const b of document.querySelectorAll('#workspace-server-panel button'))
    b.addEventListener('click',()=>{window.__clicks[b.id]=(window.__clicks[b.id]||0)+1});}"""

# The status texts as drawn: whether each is cut (scroll size over client size), where it is, and the box that holds
# them (the texts wrapper for the status group, the element itself for the search row). A box shown out of the flow
# must not sit under an ancestor that would clip a fixed box (transform, filter, contain, container queries).
STATUS_VIEW = """()=>{
  const box=e=>{const r=e.getBoundingClientRect();return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}};
  const clipping=e=>{const out=[];for(let a=e.parentElement;a;a=a.parentElement){const cs=getComputedStyle(a);
    if(cs.transform!=='none'||cs.filter!=='none'||!['none',''].includes(cs.contain)||cs.containerType!=='normal'||
       /transform|filter/.test(cs.willChange))out.push(a.tagName+'.'+a.className)}return out};
  const one=(s,hold)=>{const e=document.querySelector(s),h=document.querySelector(hold),cs=getComputedStyle(e);
    return {sel:s,...box(e),sw:e.scrollWidth,cw:e.clientWidth,sh:e.scrollHeight,ch:e.clientHeight,font:parseFloat(cs.fontSize),
      whiteSpace:cs.whiteSpace,text:e.textContent,visible:e.checkVisibility({visibilityProperty:true}),
      holder:{...box(h),position:getComputedStyle(h).position,pointerEvents:getComputedStyle(h).pointerEvents,
              clipping:clipping(h)}}};
  return {vw:innerWidth,vh:innerHeight,
    group:['#layout-status','#worklist-refresh-status','#body-parts-status'].map(s=>one(s,'.toolbar-status-texts')),
    search:one('[data-search-status]','[data-search-status]')};
}"""

# Sections of an open group: for each child of its panel, the listed ids it holds in order, its section title, and the
# title's tooltip.
SECTION_VIEW = """([group,ids])=>[...document.querySelector('#'+group+' > .toolbar-menu-panel').children].map(c=>({
  ids:ids.filter(i=>{const e=document.getElementById(i);return e&&(c===e||c.contains(e))})
    .sort((a,b)=>document.getElementById(a).compareDocumentPosition(document.getElementById(b))&4?-1:1),
  title:c.querySelector(':scope > .toolbar-section-title')?.textContent.trim()||null,
  tip:c.querySelector(':scope > .toolbar-section-title')?.title||null,
  role:c.getAttribute('role'),label:c.getAttribute('aria-label')}))"""

# The Account Layout panel against its summary, the open View panel and the header.
ACCOUNT_VIEW = """()=>{
  const box=e=>{const r=e.getBoundingClientRect();return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}};
  const panel=document.querySelector('#workspace-server-panel');
  const inHeader=[[20,26],[innerWidth/2,26],[innerWidth-40,26]].map(([x,y])=>{const h=document.elementFromPoint(x,y);
    return !!h&&!!h.closest('.menubar')});
  return {panel:box(panel),position:getComputedStyle(panel).position,left:panel.style.left,top:panel.style.top,
    summary:box(document.querySelector('#workspace-server-summary')),
    view:box(document.querySelector('#toolbar-view > .toolbar-menu-panel')),
    viewOpen:document.querySelector('#toolbar-view').open,accountOpen:document.querySelector('#workspace-server-menu').open,
    bar:box(document.querySelector('.userfilter')),split:box(document.querySelector('.split')),inHeader,
    vw:innerWidth,vh:innerHeight};
}"""

# The panel's box under each given inline left/top, the inline values put back afterwards: equal boxes mean those
# coordinates do not place it.
ACCOUNT_UNDER = """(pairs)=>{const p=document.querySelector('#workspace-server-panel'),keep=[p.style.left,p.style.top];
  const out=pairs.map(([l,t])=>{p.style.left=l;p.style.top=t;const r=p.getBoundingClientRect();
    return {left:l,top:t,x:r.left,y:r.top,r:r.right,b:r.bottom}});
  [p.style.left,p.style.top]=keep;return out}"""
# Resize and toggle events reach the page as tasks after the Playwright call returns (fix2: on the hosted runner the
# first read after set_viewport_size() came before any resize event); two frames let the queued ones run.
FRAMES = "()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))"
# place() clamps to 12px and more, so it never writes this; the harness puts it in to see the script overwrite it.
UNWRITTEN = '-1px'


class WorklistToolbarStructureTest(unittest.TestCase):
    """Stdlib side: bytes and ids against the base; the browser side only serializes elements."""

    @classmethod
    def setUpClass(cls):
        cls.text = MAIN.read_text(encoding='utf-8')
        cls.parts = parts(cls.text)
        cls.base = base_text()
        print('base commit', BASE, 'present' if cls.base is not None else 'absent in this clone; pinned values used')

    def test_pins_match_the_base_commit_when_it_is_present(self):
        if self.base is None:
            self.skipTest('base commit not in this clone (shallow checkout); the pins stand for it')
        base = parts(self.base)
        self.assertEqual(BASE_TOOLBAR_IDS, ids_in(base['toolbar']))
        self.assertEqual(BASE_SCRIPTS_SHA256, scripts_digest(base['scripts']))
        self.assertEqual(BASE_OUTSIDE_SHA256, digest(base['outside']))
        self.assertEqual(BASE_STYLE_SHA256, digest(base['style']))

    def test_the_page_script_and_everything_outside_the_toolbar_are_the_base_bytes(self):
        # Header, list, reading panel, dialogs, row menus and the page script: not one byte moved.
        self.assertEqual(BASE_SCRIPTS_SHA256, scripts_digest(self.parts['scripts']))
        self.assertEqual(BASE_OUTSIDE_SHA256, digest(self.parts['outside']))
        # The stylesheet gains one block and nothing else; that block sets no font size or family.
        block, rest = split_ui2_css(self.parts['style'])
        self.assertEqual(BASE_STYLE_SHA256, digest(rest))
        self.assertIsNone(re.search(r'\bfont(-size|-family)?\s*:', block), 'the S5-UI2 CSS changes a font')

    def test_every_base_toolbar_id_is_there_once_and_only_the_named_ids_are_new(self):
        for key in BASE_TOOLBAR_IDS:
            with self.subTest(key):
                self.assertEqual(1, lf(self.text).count(f'id="{key}"'), key)
        toolbar = ids_in(self.parts['toolbar'])
        self.assertEqual(len(toolbar), len(set(toolbar)))
        self.assertEqual(set(BASE_TOOLBAR_IDS) | set(GIVEN_IDS) | set(GROUP_IDS), set(toolbar))
        for key in list(GIVEN_IDS) + GROUP_IDS:
            self.assertEqual(1, lf(self.text).count(f'id="{key}"'), key)
        # The declared groups account for every base id exactly once.
        declared = [i for ids in list(PRIMARY.values()) + list(MENUS.values()) for i in ids]
        self.assertEqual(sorted(BASE_TOOLBAR_IDS), sorted(declared))


class WorklistToolbarDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = page_html(MAIN.read_text(encoding='utf-8'))
        cls.search = (ASSETS / 'worklist-search.js').read_text(encoding='utf-8')
        cls.seen = []
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / 'toolbar-geometry.json').write_text(json.dumps({'toolbar_geometry': cls.seen}, ensure_ascii=False, indent=1),
                                                   encoding='utf-8')

    def open_page(self, width, height, reading=False, portrait=False, html=None, roaming=False):
        page = self.browser.new_page(viewport={'width': width, 'height': height})
        page.set_default_timeout(4000)
        page.route('**/*', lambda route: route.abort())
        page.set_content(html or self.html)
        page.add_script_tag(content=self.search)
        page.evaluate(MOUNT_SEARCH)
        if roaming:
            page.add_script_tag(content=(ASSETS / 'workspace-roaming.js').read_text(encoding='utf-8'))
            page.evaluate(MOUNT_ROAMING)
        page.evaluate('([r,p])=>{document.body.classList.toggle("reading",r);document.body.classList.toggle("portrait",p)}',
                      [reading, portrait])
        return page

    def shot(self, page, name, width, height=260):
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f'toolbar-{name}.png'), clip={'x': 0, 'y': 0, 'width': width, 'height': height})

    # ── (a) structure, as the browser sees it ──

    def test_elements_keep_their_base_tags_and_labels(self):
        page = self.open_page(1366, 768)
        try:
            got = page.evaluate(ELEMENTS, [BASE_TOOLBAR_IDS, list(GIVEN_IDS.items())])
            missing = [row[0] for row in got if row[1] is None]
            self.assertEqual([], missing)
            self.assertEqual(BASE_ELEMENTS_SHA256, digest(json.dumps(got, ensure_ascii=False)),
                             json.dumps(got, ensure_ascii=False)[:2000])
        finally:
            page.close()
        base = base_text()
        if base is not None:
            # The pin stands for the base commit: the same serialization of the base markup gives it.
            page = self.open_page(1366, 768, html=page_html(base))
            try:
                selectors = [[key, selector] for key, selector in GIVEN_IDS.items()]
                expect_base = page.evaluate(ELEMENTS, [BASE_TOOLBAR_IDS, selectors])
                self.assertEqual(BASE_ELEMENTS_SHA256, digest(json.dumps(expect_base, ensure_ascii=False)))
            finally:
                page.close()

    def test_each_control_is_inside_its_declared_group_and_seven_groups_are_in_view(self):
        page = self.open_page(1366, 768)
        try:
            where = {key: (menu, primary) for key, menu, primary in page.evaluate(WHERE, BASE_TOOLBAR_IDS)}
            for group, ids in MENUS.items():
                for key in ids:
                    with self.subTest(key=key):
                        self.assertEqual(group, where[key][0], key)
            for group, ids in PRIMARY.items():
                for key in ids:
                    with self.subTest(key=key):
                        self.assertEqual((None, group), where[key], key)
            # The groups themselves: menus are <details class="toolbar-menu"> sharing one name, so one opens at a time.
            groups = page.evaluate("""()=>[...document.querySelectorAll('.userfilter details.toolbar-menu')]
              .map(d=>[d.id,d.getAttribute('name'),d.querySelector(':scope > summary')?.textContent.trim(),
                       d.querySelector(':scope > .toolbar-menu-panel')?.getAttribute('role'),
                       d.querySelector(':scope > .toolbar-menu-panel')?.getAttribute('aria-label')])""")
            self.assertEqual(['toolbar-filters', 'toolbar-refresh-menu', 'toolbar-view', 'toolbar-more'], [g[0] for g in groups])
            self.assertEqual({'kin-toolbar-menu'}, {g[1] for g in groups})
            self.assertEqual(['Filters▾', '▾', 'View▾', 'More▾'], [g[2] for g in groups])
            self.assertEqual([('group', 'Filters'), ('group', 'Auto Refresh'), ('group', 'View'), ('group', 'More')],
                             [(g[3], g[4]) for g in groups])
            # What is in view: seven top-level groups, and inside them only these controls.
            top = page.evaluate("""()=>[...document.querySelector('.userfilter').children].map(e=>e.id||
              (e.querySelector(':scope > button[data-search-apply]')?'search-row':e.outerHTML.slice(0,60)))""")
            self.assertEqual(TOP, top)
            self.assertLessEqual(len(top), MAX_PRIMARY)
            shown = page.evaluate("""()=>[...document.querySelectorAll('.userfilter :is(button,input,select,summary)')]
              .filter(e=>e.getClientRects().length).map(e=>e.id||(e.tagName==='SUMMARY'?e.parentElement.id+'>summary':
              ['data-search-mode','data-search-apply','data-search-clear'].map(a=>e.hasAttribute(a)?'['+a+']':'').join('')))""")
            self.assertEqual(CONTROLS_IN_VIEW, shown)
        finally:
            page.close()

    # ── (b) geometry ──

    def row_checks(self, m, width, mode, what):
        bar = m['bar']
        self.assertAlmostEqual(HEADER_HEIGHT, m['menubar']['h'], delta=0.5, msg=f'header at {width} {mode} {what}')
        self.assertAlmostEqual(m['menubar']['b'], bar['y'], delta=0.5)
        expected = READING_HEIGHT if mode.startswith('reading') else ROW_HEIGHT
        self.assertAlmostEqual(expected, bar['h'], delta=0.5, msg=f'toolbar is {bar["h"]}px at {width} {mode} {what}')
        self.assertLessEqual(bar['sw'], bar['cw'] + 1, f'toolbar overflows sideways at {width} {mode} {what}')
        self.assertLessEqual(bar['r'], width + 0.5)
        items = m['items']
        for item in items:
            self.assertNotIn('missing', item, item['sel'])
            self.assertGreaterEqual(item['x'], -0.5, item['sel'])
            self.assertLessEqual(item['r'], width + 0.5, item['sel'])
            self.assertGreaterEqual(item['y'], bar['y'] - 0.5, item['sel'])
            self.assertLessEqual(item['b'], bar['b'] + 0.5, item['sel'])
        # One row: every group box shares the controls' vertical centre.
        centres = [(i['y'] + i['b']) / 2 for i in items]
        self.assertLessEqual(max(centres) - min(centres), 1, f'the toolbar broke into rows at {width} {mode} {what}: {items}')
        for i, a in enumerate(items):
            for c in items[i + 1:]:
                ow = min(a['r'], c['r']) - max(a['x'], c['x'])
                oh = min(a['b'], c['b']) - max(a['y'], c['y'])
                self.assertFalse(ow > 1 and oh > 1, f'{a["sel"]} overlaps {c["sel"]} at {width} {mode} {what}')
        for st in m['statuses']:
            if st['shown']:
                self.assertLessEqual(st['sh'], st['ch'] + 1, f'{st["sel"]} runs onto a second line at {width} {mode}')
                self.assertLessEqual(st['h'], 2 * st['font'], f'{st["sel"]} is {st["h"]}px tall at {width} {mode}')
        # The toolbar box never reaches into the list.
        self.assertLessEqual(bar['b'], m['split']['y'] + 0.5)

    def fill_statuses(self, page, texts):
        page.evaluate("(texts)=>{for(const [s,t] of texts)document.querySelector(s).textContent=t;}",
                      [[s, t] for s, t, _ in texts])

    def open_group(self, page, group):
        page.locator(f'#{group} > summary').click()

    def check_open(self, page, width, mode, group, closed, first_in_view=True):
        m = page.evaluate(MEASURE, ROW)
        self.assertEqual([group], [g for g in m['open'] if g in MENUS], f'{group} did not open alone at {width} {mode}')
        bar, split = m['bar'], m['split']
        # The row does not move when a group opens.
        for before, after in zip(closed['items'], m['items']):
            self.assertAlmostEqual(before['x'], after['x'], delta=0.5, msg=f'{after["sel"]} moved when {group} opened')
            self.assertAlmostEqual(before['y'], after['y'] + bar['st'], delta=0.5, msg=f'{after["sel"]} moved')
        panel = page.evaluate("""(g)=>{const r=document.querySelector('#'+g+' > .toolbar-menu-panel').getBoundingClientRect();
          return {x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}}""", group)
        row_bottom = max(i['b'] for i in m['items'])
        self.assertGreaterEqual(panel['y'], row_bottom - 0.5, f'{group} opens over the row at {width} {mode}')
        self.assertGreaterEqual(panel['x'], bar['x'] - 0.5)
        self.assertLessEqual(panel['r'], bar['r'] + 0.5)
        self.assertLessEqual(bar['b'], split['y'] + 0.5, f'{group} reaches into the list at {width} {mode}')
        if mode.startswith('reading'):
            # The reading layout keeps the base 92px toolbar; opening a group moves nothing below it.
            self.assertAlmostEqual(READING_HEIGHT, bar['h'], delta=0.5, msg=f'{group} resized the reading toolbar')
            self.assertAlmostEqual(closed['split']['y'], split['y'], delta=0.5, msg=f'{group} moved the reading layout')
        else:
            # Opened in the flow: the list moves down by what the toolbar gained, and nothing covers it.
            self.assertGreater(bar['h'], closed['bar']['h'])
            self.assertAlmostEqual(split['y'] - closed['split']['y'], bar['h'] - closed['bar']['h'], delta=0.5)
            self.assertLessEqual(panel['b'], split['y'] + 0.5)
        reached = []
        controls = page.evaluate(CONTROLS, group)
        self.assertTrue(controls, group)
        first = True
        for probe, key in controls:
            locator = page.locator(f'[data-probe="{probe}"]')
            if first and first_in_view and mode.startswith('reading'):
                # The first line of an open group is in view without scrolling the 92px toolbar (one-row layouts; below
                # 1366 the closed toolbar may already wrap past 92px, and the group is reached by scrolling it).
                r = locator.bounding_box()
                self.assertGreaterEqual(r['y'], bar['y'] - 0.5, key)
                self.assertLessEqual(r['y'] + r['height'], bar['b'] + 0.5, f'{key} is cut off in the reading toolbar')
            first = False
            locator.scroll_into_view_if_needed()
            reach = locator.evaluate(REACH)
            self.assertGreater(reach['w'], 0, key)
            self.assertGreater(reach['h'], 0, key)
            self.assertGreaterEqual(reach['x'], -0.5, key)
            self.assertLessEqual(reach['r'], width + 0.5, key)
            self.assertTrue(reach['own'], f'{key} in {group} is covered at {width} {mode}')
            self.assertTrue(reach['focused'], f'{key} in {group} cannot take focus at {width} {mode}')
            reached.append(key)
        page.evaluate('()=>document.querySelector(".userfilter").scrollTop=0')
        return reached

    def check_layout(self, width, height, mode, reading, portrait):
        page = self.open_page(width, height, reading, portrait)
        record = {'width': width, 'height': height, 'mode': mode}
        ok = False
        try:
            closed = page.evaluate(MEASURE, ROW)
            self.row_checks(closed, width, mode, 'with empty status texts')
            record['closed'] = {'bar_h': closed['bar']['h'], 'split_y': closed['split']['y'],
                                'row': [[i['sel'], round(i['x'], 1), round(i['w'], 1)] for i in closed['items']]}
            self.shot(page, f'{width}x{height}-{mode}-closed', width)
            # The longest texts the page writes, then a far longer one: the texts shorten, the row stays.
            self.fill_statuses(page, STATUS_TEXTS)
            long = page.evaluate(MEASURE, ROW)
            self.row_checks(long, width, mode, 'with the longest status texts')
            self.fill_statuses(page, [(s, t * 12, None) for s, t, _ in STATUS_TEXTS])
            self.row_checks(page.evaluate(MEASURE, ROW), width, mode, 'with overlong status texts')
            self.shot(page, f'{width}x{height}-{mode}-long-status', width)
            self.fill_statuses(page, [(s, '', None) for s, _, _ in STATUS_TEXTS])
            page.evaluate(FULLEST, [SAVED_SEARCH_NAME, SAVED_SEARCH_STATE[0]])
            base_closed = page.evaluate(MEASURE, ROW)
            record['groups'] = {}
            for group in MENUS:
                self.open_group(page, group)
                record['groups'][group] = self.check_open(page, width, mode, group, base_closed)
                self.shot(page, f'{width}x{height}-{mode}-{group}', width, 340)
                if group == 'toolbar-view':
                    # fix1 F02: with the nested Account Layout open its panel is part of View's flow, so its buttons
                    # are among the controls reached (the CONTROLS probe takes an open nested group's inside).
                    page.locator('#workspace-server-summary').click()
                    reached = self.check_open(page, width, mode, group, base_closed)
                    for key in ('workspace-server-save', 'workspace-server-load', 'workspace-server-clear'):
                        self.assertIn(key, reached)
                    record['groups']['toolbar-view+workspace-server-menu'] = reached
                    self.shot(page, f'{width}x{height}-{mode}-toolbar-view-account-layout', width, 480)
                    page.locator('#workspace-server-summary').click()
                    self.assertFalse(page.evaluate("document.querySelector('#workspace-server-menu').open"))
            # Closing the last one gives the one row back.
            self.open_group(page, list(MENUS)[-1])
            self.assertEqual([], [g for g in page.evaluate(MEASURE, ROW)['open'] if g in MENUS])
            self.row_checks(page.evaluate(MEASURE, ROW), width, mode, 'after closing the groups')
            ok = True
        finally:
            record['passed'] = ok
            self.seen.append(record)
            page.close()

    def test_one_row_from_1366_in_every_layout_and_groups_open_below_it(self):
        for width, height in ONE_ROW:
            for mode, reading, portrait in MODES:
                with self.subTest(width=width, mode=mode):
                    self.check_layout(width, height, mode, reading, portrait)

    def test_narrow_windows_may_wrap_but_keep_every_primary_control_on_screen(self):
        for width, height in NARROW:
            for mode, reading, portrait in MODES[:2]:
                with self.subTest(width=width, mode=mode):
                    page = self.open_page(width, height, reading, portrait)
                    try:
                        m = page.evaluate(MEASURE, ROW)
                        # The toolbar's own box; the page width is not asserted, because with scripts stripped the
                        # template panel (#tpl-filter-clear) reaches 1038px at 1024 on the base commit too
                        # (tests/worklist_header_dom_test.py), outside the toolbar and this unit.
                        self.assertLessEqual(m['bar']['sw'], m['bar']['cw'] + 1)
                        self.assertLessEqual(m['bar']['r'], width + 0.5)
                        for item in m['items']:
                            self.assertGreaterEqual(item['x'], -0.5, item['sel'])
                            self.assertLessEqual(item['r'], width + 0.5, item['sel'])
                        for key in TAB_ORDER:
                            locator = page.locator(selector_for(key))
                            locator.scroll_into_view_if_needed()
                            self.assertTrue(locator.evaluate(REACH)['own'], f'{key} is covered at {width} {mode}')
                        self.shot(page, f'{width}x{height}-{mode}-narrow', width)
                    finally:
                        page.close()

    def test_narrow_windows_open_groups_below_the_wrapped_row_with_every_control_reachable(self):
        # fix1 (proposal 4): below 1366 the closed toolbar may wrap; an open group still goes below the last row, moves
        # the list by what it adds (reading: the 92px toolbar scrolls instead), and every control in it is reachable.
        for width, height in NARROW:
            for mode, reading, portrait in MODES[:2]:
                with self.subTest(width=width, mode=mode):
                    page = self.open_page(width, height, reading, portrait)
                    record = {'width': width, 'height': height, 'mode': mode, 'narrow_open': {}}
                    ok = False
                    try:
                        page.evaluate(FULLEST, [SAVED_SEARCH_NAME, SAVED_SEARCH_STATE[0]])
                        closed = page.evaluate(MEASURE, ROW)
                        for group in MENUS:
                            self.open_group(page, group)
                            record['narrow_open'][group] = self.check_open(page, width, mode, group, closed,
                                                                           first_in_view=False)
                            self.shot(page, f'{width}x{height}-{mode}-narrow-{group}', width, 420)
                            if group == 'toolbar-view':
                                page.locator('#workspace-server-summary').click()
                                reached = self.check_open(page, width, mode, group, closed, first_in_view=False)
                                self.assertIn('workspace-server-clear', reached)
                                page.locator('#workspace-server-summary').click()
                        ok = True
                    finally:
                        record['passed'] = ok
                        self.seen.append(record)
                        page.close()

    # ── (b2) fix1: status texts in full, the nested Account Layout, sections ──

    def status_expanded(self, view, which, width, mode, row_bottom, how):
        """Every non-empty text of the status group ('group') or the search row ('search') is drawn whole, below the row."""
        items = view['group'] if which == 'group' else [view['search']]
        shown = [st for st in items if st['text']]
        self.assertTrue(shown, which)
        for st in shown:
            what = f'{st["sel"]} by {how} at {width} {mode}'
            holder = st['holder']
            self.assertTrue(st['visible'], what)
            self.assertEqual('normal', st['whiteSpace'], what)
            self.assertLessEqual(st['sw'], st['cw'] + 1, f'{what} is still cut sideways: {st}')
            self.assertLessEqual(st['sh'], st['ch'] + 1, f'{what} is still cut: {st}')
            self.assertGreater(st['h'], st['font'] * 0.8, what)
            self.assertGreaterEqual(st['x'], -0.5, what)
            self.assertLessEqual(st['r'], view['vw'] + 0.5, what)
            self.assertLessEqual(st['b'], view['vh'] + 0.5, what)
            # Out of the flow and fixed to its anchor: the reading toolbar's overflow clip cannot cut it, it opens below
            # the row, and it takes no pointer (it closes as soon as the pointer leaves and never blocks the list).
            self.assertEqual('fixed', holder['position'], what)
            self.assertEqual([], holder['clipping'], what)
            self.assertEqual('none', holder['pointerEvents'], what)
            self.assertGreaterEqual(holder['y'], row_bottom - 0.5, f'{what} covers the row')
            self.assertGreaterEqual(holder['x'], -0.5, what)
            self.assertLessEqual(holder['r'], view['vw'] + 0.5, what)

    def status_collapsed(self, view, which, what):
        items = view['group'] if which == 'group' else [view['search']]
        for st in items:
            self.assertNotEqual('fixed', st['holder']['position'], f'{st["sel"]} stays open {what}')
            self.assertNotEqual('absolute', st['holder']['position'], f'{st["sel"]} stays open {what}')

    def same_row(self, page, closed, width, mode, what):
        m = page.evaluate(MEASURE, ROW)
        self.assertAlmostEqual(closed['bar']['h'], m['bar']['h'], delta=0.5, msg=f'toolbar changed height {what}')
        self.assertAlmostEqual(closed['split']['y'], m['split']['y'], delta=0.5, msg=f'the list moved {what}')
        for before, after in zip(closed['items'], m['items']):
            self.assertAlmostEqual(before['x'], after['x'], delta=0.5, msg=f'{after["sel"]} moved {what}')
            self.assertAlmostEqual(before['w'], after['w'], delta=0.5, msg=f'{after["sel"]} resized {what}')
            self.assertAlmostEqual(before['y'], after['y'], delta=0.5, msg=f'{after["sel"]} moved {what}')

    def test_status_texts_read_in_full_by_pointer_and_by_keyboard(self):
        # F01: the status group is about 90px at 1366, so the page's longest texts are cut to a few letters. Pointing at
        # the group or the search row, or keyboard focus inside either, shows the same elements whole below the row;
        # the closed toolbar keeps its one 59px row (92px reading) and nothing moves while a text is shown.
        for width, height in ONE_ROW:
            for mode, reading, portrait in MODES:
                with self.subTest(width=width, mode=mode):
                    page = self.open_page(width, height, reading, portrait)
                    try:
                        page.mouse.move(width / 2, height - 4)
                        # Empty texts: focus on the group shows no empty box.
                        page.locator('#toolbar-status').focus()
                        self.status_collapsed(page.evaluate(STATUS_VIEW), 'group', 'with empty texts')
                        page.locator('#quick').focus()
                        self.fill_statuses(page, STATUS_TEXTS)
                        closed = page.evaluate(MEASURE, ROW)
                        self.row_checks(closed, width, mode, 'with the longest status texts, not pointed at')
                        view = page.evaluate(STATUS_VIEW)
                        self.status_collapsed(view, 'group', 'before pointing')
                        self.status_collapsed(view, 'search', 'before pointing')
                        if width == 1366 and mode == 'normal':
                            # The case is real: at 1366 the texts are cut in the closed row.
                            cut = [st['sel'] for st in view['group'] + [view['search']] if st['sw'] > st['cw'] + 1]
                            self.assertTrue(cut, view)
                        row_bottom = max(i['b'] for i in closed['items'])
                        # (b) pointer: the status group, then the search row's text where it sat in the row.
                        target = page.locator('#toolbar-status').bounding_box()
                        page.mouse.move(target['x'] + target['width'] / 2, target['y'] + target['height'] / 2)
                        view = page.evaluate(STATUS_VIEW)
                        self.status_expanded(view, 'group', width, mode, row_bottom, 'pointer')
                        self.status_collapsed(view, 'search', 'while the group is pointed at')
                        self.same_row(page, closed, width, mode, f'with the status texts shown at {width} {mode}')
                        self.shot(page, f'{width}x{height}-{mode}-status-pointer', width, 360)
                        search = [s for s in closed['items'] if s['sel'] == SEARCH_ROW][0]
                        cut_text = page.evaluate("""()=>{const r=document.querySelector('[data-search-status]')
                          .getBoundingClientRect();return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,w:r.width}}""")
                        if cut_text['w'] > 4:
                            page.mouse.move(cut_text['x'], cut_text['y'])
                        else:
                            page.mouse.move(search['r'] - 4, (search['y'] + search['b']) / 2)
                        view = page.evaluate(STATUS_VIEW)
                        self.status_expanded(view, 'search', width, mode, row_bottom, 'pointer')
                        self.status_collapsed(view, 'group', 'while the search row is pointed at')
                        self.same_row(page, closed, width, mode, f'with the search text shown at {width} {mode}')
                        self.shot(page, f'{width}x{height}-{mode}-search-status-pointer', width, 360)
                        page.mouse.move(width / 2, height - 4)
                        view = page.evaluate(STATUS_VIEW)
                        self.status_collapsed(view, 'group', 'after the pointer left')
                        self.status_collapsed(view, 'search', 'after the pointer left')
                        # (a) keyboard: Tab from More reaches the status group, then the search row.
                        page.locator('#toolbar-more > summary').focus()
                        page.keyboard.press('Tab')
                        self.assertEqual('toolbar-status', page.evaluate(ACTIVE))
                        view = page.evaluate(STATUS_VIEW)
                        self.status_expanded(view, 'group', width, mode, row_bottom, 'keyboard')
                        self.same_row(page, closed, width, mode, f'with the status texts focused at {width} {mode}')
                        self.shot(page, f'{width}x{height}-{mode}-status-keyboard', width, 360)
                        page.keyboard.press('Tab')
                        self.assertEqual('[data-search-mode]', page.evaluate(ACTIVE))
                        view = page.evaluate(STATUS_VIEW)
                        self.status_collapsed(view, 'group', 'after focus left the group')
                        self.status_expanded(view, 'search', width, mode, row_bottom, 'keyboard')
                        page.keyboard.press('Tab')
                        self.assertEqual('[data-search-apply]', page.evaluate(ACTIVE))
                        self.status_expanded(page.evaluate(STATUS_VIEW), 'search', width, mode, row_bottom, 'keyboard')
                        page.locator('#quick').focus()
                        view = page.evaluate(STATUS_VIEW)
                        self.status_collapsed(view, 'search', 'after focus left the search row')
                        self.row_checks(page.evaluate(MEASURE, ROW), width, mode, 'after the texts were read')
                    finally:
                        page.close()

    def test_account_layout_stays_in_view_after_a_resize_while_view_was_closed(self):
        # F02: the shipped workspace-roaming.js computes the panel's left/top from its summary on toggle, resize and
        # scroll. With View closed the summary has no box, so a resize while View is closed writes coordinates from
        # nothing, and reopening View does not recompute. The panel is in View's flow now: whatever left/top the script
        # wrote has no effect, and it opens under its summary, inside View and the window, clear of the header.
        # fix2: the value written is not pinned. Resize events arrive after set_viewport_size() returns, at a time that
        # differs between runners (hosted run 36254174084 read the value written when Account Layout opened), so the
        # harness waits for the events and then checks the result: the script wrote while View was closed, and no
        # inline left/top moves the panel. View is closed by its own summary, not through the shared <details> name.
        for width, height in [(1366, 768), (1920, 1200)]:
            for mode, reading, portrait in MODES[:2]:
                with self.subTest(width=width, mode=mode):
                    page = self.open_page(width, height, reading, portrait, roaming=True)
                    try:
                        page.evaluate("()=>{window.__resizes=0;addEventListener('resize',()=>window.__resizes++)}")
                        page.locator('#toolbar-view > summary').click()
                        page.locator('#workspace-server-summary').click()
                        page.evaluate(FRAMES)
                        before = page.evaluate(ACCOUNT_VIEW)
                        self.assertTrue(before['accountOpen'])
                        self.assertEqual('static', before['position'])
                        # View closes; Account Layout stays open inside the closed View.
                        page.locator('#toolbar-view > summary').click()
                        page.evaluate(FRAMES)
                        hidden = page.evaluate(ACCOUNT_VIEW)
                        self.assertEqual((False, True), (hidden['viewOpen'], hidden['accountOpen']))
                        page.evaluate('(v)=>{const p=document.querySelector("#workspace-server-panel");p.style.left=v;p.style.top=v}',
                                      UNWRITTEN)
                        seen = page.evaluate('window.__resizes')
                        for n, (w, h) in enumerate([(width - 166, height - 68), (width, height)], seen + 1):
                            page.set_viewport_size({'width': w, 'height': h})
                            page.wait_for_function('([w,h,n])=>innerWidth===w&&innerHeight===h&&window.__resizes>=n',
                                                   arg=[w, h, n])
                        page.evaluate(FRAMES)
                        after_resize = page.evaluate(ACCOUNT_VIEW)
                        self.assertEqual((False, True), (after_resize['viewOpen'], after_resize['accountOpen']))
                        # The script did write while View was closed: the case under test happened.
                        for value in (after_resize['left'], after_resize['top']):
                            self.assertNotEqual(UNWRITTEN, value, f'the resize did not reach the script: {after_resize}')
                            self.assertRegex(value, r'^\d+(\.\d+)?px$', after_resize)
                        page.locator('#toolbar-view > summary').click()
                        page.evaluate(FRAMES)
                        m = page.evaluate(ACCOUNT_VIEW)
                        self.assertEqual((True, True), (m['viewOpen'], m['accountOpen']))
                        self.assertEqual('static', m['position'])
                        panel, summary, view = m['panel'], m['summary'], m['view']
                        # No inline left/top places it: the ones the script wrote while View was closed, the ones it
                        # writes when nothing has a box, and far off either way all give the same box.
                        under = page.evaluate(ACCOUNT_UNDER, [[after_resize['left'], after_resize['top']], ['12px', '12px'],
                                                              ['-4000px', '-4000px'], ['4000px', '4000px']])
                        for got in under:
                            for key in ('x', 'y', 'r', 'b'):
                                self.assertAlmostEqual(panel[key], got[key], delta=0.5,
                                                       msg=f'left/top {got["left"]}/{got["top"]} moved the panel: {got} {m}')
                        self.assertGreater(panel['w'], 0)
                        self.assertGreater(panel['h'], 0)
                        self.assertGreaterEqual(panel['y'], summary['b'] - 0.5, f'the panel is not under its summary: {m}')
                        self.assertAlmostEqual(summary['x'], panel['x'], delta=0.5, msg=f'the panel left its summary: {m}')
                        self.assertGreaterEqual(panel['x'], view['x'] - 0.5, m)
                        self.assertLessEqual(panel['r'], view['r'] + 0.5, m)
                        self.assertGreaterEqual(panel['y'], view['y'] - 0.5, m)
                        self.assertLessEqual(panel['b'], view['b'] + 0.5, m)
                        self.assertGreaterEqual(panel['x'], -0.5, f'the panel is left of the window: {m}')
                        self.assertLessEqual(panel['r'], m['vw'] + 0.5, f'the panel is right of the window: {m}')
                        self.assertLessEqual(panel['b'], m['vh'] + 0.5, f'the panel is below the window: {m}')
                        self.assertGreaterEqual(panel['y'], m['bar']['y'] - 0.5, 'the panel reaches over the header')
                        self.assertEqual([True, True, True], m['inHeader'], 'the header is covered')
                        self.assertAlmostEqual(before['panel']['w'], panel['w'], delta=0.5)
                        if not reading:
                            self.assertLessEqual(panel['b'], m['split']['y'] + 0.5, 'the panel covers the list')
                        self.shot(page, f'{width}x{height}-{mode}-account-layout-after-hidden-resize', width, 520)
                        for key in ('workspace-server-save', 'workspace-server-load', 'workspace-server-clear'):
                            locator = page.locator('#' + key)
                            locator.scroll_into_view_if_needed()
                            reach = locator.evaluate(REACH)
                            self.assertTrue(reach['own'], f'{key} is covered at {width} {mode}')
                            self.assertTrue(reach['focused'], f'{key} cannot take focus at {width} {mode}')
                            locator.click()
                        self.assertEqual({'workspace-server-save': 1, 'workspace-server-load': 1,
                                          'workspace-server-clear': 1}, page.evaluate('window.__clicks'))
                    finally:
                        page.close()

    def test_filters_and_view_are_split_into_ordered_sections_with_the_resets_apart(self):
        # Proposals 2 and 3: Filters is study date -> actions -> saved searches and applied state; View is images and
        # windows -> this browser's layout -> account layout. The saved searches take their own last line, so a dozen
        # chips and a 400-character name never push the action buttons down; resets sit apart at their section's end.
        for width, height in [(1366, 768), (1920, 1200)]:
            for mode, reading, portrait in MODES[:2]:
                with self.subTest(width=width, mode=mode):
                    page = self.open_page(width, height, reading, portrait)
                    try:
                        tip = page.evaluate("document.querySelector('#toolbar-filters > summary').title")
                        self.assertIn('점 표시', tip)
                        for group, sections in SECTIONS.items():
                            ids = [i for s in sections for i in s]
                            got = page.evaluate(SECTION_VIEW, [group, ids])
                            self.assertEqual(sections, [c['ids'] for c in got], group)
                        view = page.evaluate(SECTION_VIEW, ['toolbar-view', [i for s in SECTIONS['toolbar-view'] for i in s]])
                        self.assertEqual(VIEW_SECTION_TITLES, [c['title'] for c in view])
                        self.assertEqual(VIEW_SECTION_TITLES, [c['label'] for c in view])
                        for c in view:
                            self.assertEqual('group', c['role'])
                            self.assertRegex(c['tip'] or '', '[가-힣]', c['title'])
                        # No saved search and none applied: the saved-search section draws nothing.
                        self.open_group(page, 'toolbar-filters')
                        self.assertFalse(page.evaluate(
                            "document.querySelector('.toolbar-section-saved').getClientRects().length"))
                        page.evaluate(FULLEST, [SAVED_SEARCH_NAME, SAVED_SEARCH_STATE[0]])
                        boxes = page.evaluate("""(ids)=>Object.fromEntries(ids.map(i=>{const r=document.getElementById(i)
                          .getBoundingClientRect();return [i,{x:r.left,y:r.top,r:r.right,b:r.bottom}]}))""",
                                              [i for s in SECTIONS['toolbar-filters'] for i in s] + ['qf-days-0'])
                        saved_top = page.evaluate("document.querySelector('.toolbar-section-saved').getBoundingClientRect().top")
                        for key in SECTIONS['toolbar-filters'][1]:
                            self.assertLessEqual(boxes[key]['b'], saved_top + 0.5, f'{key} is below the saved searches')
                        self.assertLessEqual(boxes['qf-days-0']['b'], saved_top + 0.5)
                        self.assertGreaterEqual(boxes['chips']['y'], saved_top - 0.5)
                        self.shot(page, f'{width}x{height}-{mode}-filters-sections', width, 420)
                        self.open_group(page, 'toolbar-view')
                        page.locator('#workspace-server-summary').click()
                        gaps = page.evaluate("""()=>{const b=s=>document.querySelector(s).getBoundingClientRect();
                          const pair=(a,c)=>({gap:b(c).left-b(a).right,same:Math.abs(b(a).top-b(c).top)<1});
                          return {layout:pair('#reading-appearance-open','#layout-reset'),
                                  account:pair('#workspace-server-load','#workspace-server-clear'),
                                  plain:pair('#columnsettings','#reading-appearance-open'),
                                  plainAccount:pair('#workspace-server-save','#workspace-server-load')}}""")
                        margins = page.evaluate("""()=>['#layout-reset','#workspace-server-clear']
                          .map(s=>parseFloat(getComputedStyle(document.querySelector(s)).marginLeft))""")
                        self.assertEqual([RESET_GAP, RESET_GAP], margins)
                        # Reset Layout shares the line of the ordinary settings in its section, set apart from them.
                        self.assertTrue(gaps['layout']['same'] and gaps['plain']['same'], gaps)
                        self.assertGreaterEqual(gaps['layout']['gap'], gaps['plain']['gap'] + RESET_GAP - 0.5, gaps)
                        # The 300px Account Layout panel may put each button on its own line (as at the base); where
                        # Reset Account Layout shares a line with Load from Account it is set apart the same way.
                        if gaps['account']['same']:
                            plain_gap = gaps['plainAccount']['gap'] if gaps['plainAccount']['same'] else 0
                            self.assertGreaterEqual(gaps['account']['gap'], plain_gap + RESET_GAP - 0.5, gaps)
                        self.shot(page, f'{width}x{height}-{mode}-view-sections', width, 480)
                    finally:
                        page.close()

    def test_focus_back_to_the_summary_after_the_reading_toolbar_scrolled(self):
        # Proposal 4: in reading mode the 92px toolbar scrolls to reach the lower lines of an open group. Shift+Tab back
        # to the group's summary brings it into view where a pointer reaches it, and closing the group gives the row back.
        for width, height in ONE_ROW:
            for mode, reading, portrait in (MODES[1], MODES[3]):
                with self.subTest(width=width, mode=mode):
                    page = self.open_page(width, height, reading, portrait)
                    try:
                        page.evaluate(FULLEST, [SAVED_SEARCH_NAME, SAVED_SEARCH_STATE[0]])
                        self.open_group(page, 'toolbar-view')
                        page.locator('#workspace-server-summary').click()
                        page.locator('#workspace-server-clear').focus()
                        scrolled = page.evaluate(MEASURE, ROW)['bar']['st']
                        self.assertGreater(scrolled, 0, 'the reading toolbar did not need to scroll')
                        for _ in range(30):
                            if page.evaluate(ACTIVE) == 'toolbar-view>summary':
                                break
                            page.keyboard.press('Shift+Tab')
                        self.assertEqual('toolbar-view>summary', page.evaluate(ACTIVE))
                        bar = page.evaluate(MEASURE, ROW)['bar']
                        self.assertLess(bar['st'], scrolled)
                        summary = page.locator('#toolbar-view > summary').bounding_box()
                        self.assertGreaterEqual(summary['y'], bar['y'] - 0.5, 'the summary is above the toolbar box')
                        self.assertLessEqual(summary['y'] + summary['height'], bar['b'] + 0.5, 'the summary is cut off')
                        self.assertTrue(page.locator('#toolbar-view > summary').evaluate(REACH)['own'])
                        page.keyboard.press('Enter')
                        self.assertFalse(page.evaluate("document.querySelector('#toolbar-view').open"))
                        self.assertEqual('toolbar-view>summary', page.evaluate(ACTIVE))
                        m = page.evaluate(MEASURE, ROW)
                        self.assertEqual(0, m['bar']['st'])
                        self.row_checks(m, width, mode, 'after returning to the summary and closing View')
                    finally:
                        page.close()

    # ── (c) keyboard ──

    def test_tab_follows_the_groups_left_to_right_and_enter_space_open_them(self):
        for width, height in ONE_ROW:
            with self.subTest(width=width):
                page = self.open_page(width, height)
                try:
                    page.locator('#quick').focus()
                    order, xs = [], []
                    for _ in range(40):
                        key = page.evaluate(ACTIVE)
                        if key is None:
                            break
                        order.append(key)
                        xs.append(page.evaluate(ACTIVE_X))
                        page.keyboard.press('Tab')
                    self.assertEqual(TAB_ORDER, order)
                    self.assertEqual(sorted(xs), xs, 'focus order and left-to-right order differ')
                    self.assertEqual(len(set(xs)), len(xs))
                    # Enter on a summary opens its group; the next Tab enters the group, in its own order.
                    page.locator('#toolbar-filters > summary').focus()
                    page.keyboard.press('Enter')
                    self.assertTrue(page.evaluate("document.querySelector('#toolbar-filters').open"))
                    page.keyboard.press('Tab')
                    self.assertEqual('qf-days-0', page.evaluate(ACTIVE))
                    page.keyboard.press('Shift+Tab')
                    self.assertEqual('toolbar-filters>summary', page.evaluate(ACTIVE))
                    # Space on another summary opens that one and the first closes (one name, one open group).
                    page.locator('#toolbar-view > summary').focus()
                    page.keyboard.press('Space')
                    self.assertEqual([False, True], page.evaluate(
                        "['#toolbar-filters','#toolbar-view'].map(s=>document.querySelector(s).open)"))
                    enabled = page.evaluate("""()=>[...document.querySelectorAll('#toolbar-view > .toolbar-menu-panel :is(button,summary)')]
                      .filter(e=>!e.disabled&&e.getClientRects().length).map(e=>e.id||e.parentElement.id+'>summary')""")
                    walked = []
                    for _ in range(len(enabled) + 1):
                        page.keyboard.press('Tab')
                        walked.append(page.evaluate(ACTIVE))
                    self.assertEqual(enabled + ['toolbar-more>summary'], walked)
                    # Enter on an open summary closes it again.
                    page.locator('#toolbar-view > summary').focus()
                    page.keyboard.press('Enter')
                    self.assertFalse(page.evaluate("document.querySelector('#toolbar-view').open"))
                    self.assertEqual('toolbar-view>summary', page.evaluate(ACTIVE))
                finally:
                    page.close()

    def test_filters_summary_marks_an_active_filter(self):
        # The buttons that used to show a filter was on (Clear Favorite Filter, Clear Tag Filter, the saved search name)
        # are inside Filters now; the closed summary shows a dot instead, and the row stays one row.
        page = self.open_page(1366, 768)
        try:
            off = page.evaluate(DOT)
            self.assertEqual('none', off['content'])
            for label, setup, reset in (
                    ('applied saved search', "document.querySelector('#active-filter-info').hidden=false",
                     "document.querySelector('#active-filter-info').hidden=true"),
                    ('favorite list', "document.querySelector('#favorite-clear').hidden=false",
                     "document.querySelector('#favorite-clear').hidden=true"),
                    ('study tag', "document.querySelector('#study-tag-clear').hidden=false",
                     "document.querySelector('#study-tag-clear').hidden=true"),
                    ('study date', "document.querySelectorAll('#qf button').forEach(b=>b.classList.toggle('on',b.dataset.days==='7'))",
                     "document.querySelectorAll('#qf button').forEach(b=>b.classList.toggle('on',b.dataset.days==='-1'))")):
                with self.subTest(label):
                    page.evaluate('()=>{' + setup + '}')
                    on = page.evaluate(DOT)
                    self.assertEqual('""', on['content'], label)
                    self.assertEqual((6, 6), (on['w'], on['h']), label)
                    self.row_checks(page.evaluate(MEASURE, ROW), 1366, 'normal', 'with the Filters dot')
                    page.evaluate('()=>{' + reset + '}')
                    self.assertEqual('none', page.evaluate(DOT)['content'], label)
        finally:
            page.close()

    def test_status_texts_are_the_ones_the_page_writes(self):
        for selector, text, source in STATUS_TEXTS + [('#active-filter-state',) + SAVED_SEARCH_STATE]:
            with self.subTest(selector):
                self.assertIn(text, (ASSETS / source).read_text(encoding='utf-8'), selector)


if __name__ == '__main__':
    unittest.main(verbosity=2)
