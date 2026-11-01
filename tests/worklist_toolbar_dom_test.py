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

S7-PINS (AGENTS.md 1-B.14): "the page script and everything outside the toolbar are the base bytes, and the toolbar
elements are the base's" is a claim about this refactoring, so it is checked on the two fixed commits that bound it (the
base and the main merge that shipped the unit), never on the live main.html, which later units keep changing. The live
file is held to what the page must still be: every base toolbar id once and in its declared group, no id in the toolbar
that is not declared, the S5-UI2 CSS block setting no font, and everything the browser cases measure.

S7-PINS fix1 (Astra S7-PINS-R-001-F01): the live page is also held to what each date filter button searches - its label
and the number of days the page script applies from it - from an explicit list, which the byte comparison used to cover.

S7-PINS fix1 (Astra S7-COMMAND-R-001-F09): the two fixed commits are read by tests/report_actions_dom_test.py
fixed_file(). A clone without them fetches them from origin; if they still cannot be read, or are not the pinned bytes,
the equivalence cases fail - they never skip.
W2R-05: Folders adds a keyboard-reachable entry beside Filters while the panel starts closed.
The historical regrouping pins stay fixed; current geometry and keyboard order include this new control.
"""
from page_source import read_page_source
import hashlib
import json
import os
import re
import unittest
from pathlib import Path
from module_session_harness import activate
from playwright.sync_api import sync_playwright
from report_actions_dom_test import BASE_MAIN_SHA256 as UI3_BASE_MAIN_SHA256, fixed_file

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'worklist-v0/hpacs-lite'
MAIN = ASSETS / 'main.html'
REL_MAIN = 'worklist-v0/hpacs-lite/main.html'
# Screenshots go outside the checkout when the runner names a directory, so a run leaves no files behind.
OUT = Path(os.environ.get('KIN_EVIDENCE_DIR') or ROOT / 'tmp/s5-ui2/toolbar')

# The commit this unit started from (main after S5-U4a) and the main commit that merged it (PR #99, the branch head
# a669331 with fix2). The refactoring's equivalence is checked on the two, read by fixed_file(): each must be readable
# and be the pinned bytes below, or the case fails.
BASE ='7a35570826072c0da1f79e7951f218df38fd0156'
RESULT = '5ed77ded757e923d8dbed502b2180d5e091928c1'
# The two main.html files (LF-normalized UTF-8 sha256). S5-UI3 started from the merged one
# (tests/report_actions_dom_test.py BASE_MAIN_SHA256).
BASE_MAIN_SHA256 = 'e2782c87bcb93333a559bb911f7d4b16c7f0764d7b8a1cb8e1c02cebeeecfcfe'
RESULT_MAIN_SHA256 = 'c32f4026cfa29d54e3ffa0e85d1900d250264c4f860aa3ed09477a70fe98d707'
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
# The date filter at the head of Filters, in order: each button's label and the days it searches back (-1: no limit).
# The page script applies a clicked button's data-days as the search's days (main.html, the #qf click handler), so the
# label a reader picks and the period searched agree only while each label carries its own number. The page opens with
# no limit, All selected.
DATE_FILTERS = [('Today', 0), ('3 Days', 3), ('Week', 7), ('1 Month', 30), ('2 Months', 60), ('All', -1)]
DATE_FILTER_AT_OPEN = 'All'
# The original regrouping containers plus the explicitly requested W2 folder entry.
FOLDER_ENTRY_IDS = ['worklist-folders-toggle']
# W3 adds a drawer opener and change-only status inside View. The historical
# regrouping byte proof below stays pinned; current IDs still must be unique.
STUDY_PANEL_ENTRY_IDS = ['study-panel-open', 'study-panel-status']
# W-SPACE (Minhoon 2026-10-27 item 9) adds the Panel Settings opener beside them, inside View's This Browser section.
PANEL_SETTINGS_ENTRY_IDS = ['panel-settings-open']
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
TOP = ['toolbar-search', 'worklist-folders-toggle', 'toolbar-filters', 'toolbar-refresh', 'toolbar-view', 'toolbar-more', 'toolbar-status',
       'search-row']
# The row: one box per top-level group (the <details> groups draw only their summary).
SEARCH_ROW = '.userfilter > span:has(> button[data-search-apply])'
ROW = ['#toolbar-search', '#worklist-folders-toggle', '#toolbar-filters > summary', '#m-refresh', '#toolbar-refresh-menu > summary',
       '#toolbar-view > summary', '#toolbar-more > summary', '#toolbar-status', SEARCH_ROW]
# Tab order through the closed toolbar, left to right. The status group is a focus stop of its own (fix1 F01): focus
# there shows its texts in full. It is not a control, so the list of controls in view leaves it out.
TAB_ORDER = ['quick', 'quick-match', 'clearfilter', 'worklist-folders-toggle', 'toolbar-filters>summary', 'refresh', 'toolbar-refresh-menu>summary',
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

# Representative long status payloads stress wrapping independently of product wording.
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


def fixed_pair():
    """(base, result) main.html at the two fixed commits; fixed_file() fails the case when either cannot be read."""
    return fixed_file(BASE, REL_MAIN, BASE_MAIN_SHA256), fixed_file(RESULT, REL_MAIN, RESULT_MAIN_SHA256)


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
    """Historical byte equivalence applies only to the two fixed commits."""
    def test_pins_match_the_fixed_commits(self):
        # The next unit started from this one's merge.
        self.assertEqual(UI3_BASE_MAIN_SHA256, RESULT_MAIN_SHA256)
        # Both files are their pinned LF sha256 (fixed_file()); the base's parts are the pinned ones.
        base = parts(fixed_pair()[0])
        self.assertEqual(BASE_TOOLBAR_IDS, ids_in(base['toolbar']))
        self.assertEqual(BASE_SCRIPTS_SHA256, scripts_digest(base['scripts']))
        self.assertEqual(BASE_OUTSIDE_SHA256, digest(base['outside']))
        self.assertEqual(BASE_STYLE_SHA256, digest(base['style']))

    def test_the_refactoring_left_the_page_script_and_everything_outside_the_toolbar_as_the_base_bytes(self):
        # Base and merge commit: header, list, reading panel, dialogs, row menus and the page script, not one byte moved;
        # the stylesheet gained one block and nothing else.
        base, result = (parts(text) for text in fixed_pair())
        self.assertEqual(base['scripts'], result['scripts'])
        self.assertEqual(base['outside'], result['outside'])
        block, rest = split_ui2_css(result['style'])
        self.assertEqual(base['style'], rest)
        self.assertEqual((BASE_SCRIPTS_SHA256, BASE_OUTSIDE_SHA256, BASE_STYLE_SHA256),
                         (scripts_digest(result['scripts']), digest(result['outside']), digest(rest)))



import worklist_folders_dom_test as studio
from playwright.sync_api import expect


class WorklistToolbarDOMTest(unittest.TestCase):
    """The 11-01 contract moves the live menus into the single top bar."""
    setUpClass = classmethod(studio.StudioWorklistDOM.setUpClass.__func__)
    tearDownClass = classmethod(studio.StudioWorklistDOM.tearDownClass.__func__)
    setUp = studio.StudioWorklistDOM.setUp
    tearDown = studio.StudioWorklistDOM.tearDown
    open = studio.StudioWorklistDOM.open

    def test_each_retained_action_is_reachable_from_top_menus(self):
        self.open()
        groups = {
            'view': ['image-opening-open', 'viewer-windows-open', 'layout-toggle', 'panel-settings-open',
                     'layout-reset', 'columnsettings', 'study-panel-open', 'reading-appearance-open'],
            'more': ['study-access-open', 'worklist-alerts-open', 'toolbar-refresh-menu'],
            'filters': ['savefilter', 'managefilters', 'favorite-open', 'study-tag-open', 'body-parts-load'],
        }
        for name, ids in groups.items():
            self.page.locator('#toolbar-' + name + ' > summary').click()
            for ident in ids:
                control = self.page.locator('#' + ident + (' > summary' if ident == 'toolbar-refresh-menu' else ''))
                control.scroll_into_view_if_needed()
                expect(control).to_be_in_viewport(ratio=1)
                if control.is_enabled():
                    control.click(trial=True)
            self.page.locator('#toolbar-' + name + ' > summary').click()
        expect(self.page.locator('#m-refresh')).to_be_visible()
        expect(self.page.locator('#filterrow .col-clear')).to_be_visible()

    def test_keyboard_opens_each_menu_and_returns_to_summary(self):
        self.open()
        for name in ('view', 'more', 'filters'):
            menu = self.page.locator('#toolbar-' + name)
            summary = menu.locator(':scope > summary')
            summary.focus()
            self.page.keyboard.press('Enter')
            expect(menu).to_have_attribute('open', '')
            self.page.keyboard.press('Tab')
            self.assertTrue(menu.evaluate('el => el.contains(document.activeElement)'))
            summary.focus()
            self.page.keyboard.press('Space')
            expect(menu).not_to_have_attribute('open', '')
            expect(summary).to_be_focused()

    def test_menu_content_stays_reachable_at_supported_window_sizes(self):
        self.open()
        for width in (768, 1024, 1366, 1920):
            self.page.set_viewport_size({'width': width, 'height': 1000})
            for name in ('view', 'more', 'filters'):
                self.page.locator('#toolbar-' + name + ' > summary').click()
                panel = self.page.locator('#toolbar-' + name + ' > .toolbar-menu-panel')
                bounds = panel.bounding_box()
                self.assertGreaterEqual(bounds['x'], 0)
                self.assertLessEqual(bounds['x'] + bounds['width'], width + 1)
                bar = self.page.locator('.menubar').bounding_box()
                self.assertGreaterEqual(bounds['y'], bar['y'] + bar['height'])
                self.page.locator('#toolbar-' + name + ' > summary').click()

    def test_config_opens_panel_settings_and_filters_keep_body_part_help(self):
        self.open()
        self.page.locator('#m-config').click()
        expect(self.page.get_by_role('dialog', name='Panel Settings')).to_be_visible()
        self.page.keyboard.press('Escape')
        self.page.locator('#toolbar-filters > summary').click()
        expect(self.page.locator('#body-parts-load')).to_be_visible()
        self.page.locator('#toolbar-more > summary').click()
        expect(self.page.locator('#body-parts-status')).to_contain_text('부위')


if __name__ == '__main__':
    unittest.main()
