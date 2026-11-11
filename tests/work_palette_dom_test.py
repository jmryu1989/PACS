"""A1 FA-153: the default colour scheme on the worklist and the report editor.

Requirement: the dark palette - background #212121, panels and inputs #2D2D2D, main text #E3E3E3, secondary text #B4B4B4,
selection/accent #8AB4C8 - is used consistently on the worklist, the viewer and the report editor; sky blue is for
selected states and accents, not running text. A reader's saved text colour stays theirs.

RISK: a part of the work page (a panel gutter, the report fields, a native control, a dialog opened from the page) is
painted in a colour of its own, so the worklist and the editor do not look like the viewer; or the palette overwrites a
meaning colour (status, warning, error) or the reader's saved text colour.

The real main.html and its assets are served; only HTTP answers are synthetic (study_panel_page_dom_test.WorkspaceSite).
Each case drives public controls and reads computed colours: background, text (own text or a control), each drawn
border side, a drawn outline, box-shadow colours and the accent of checkboxes. A colour is the palette's when its RGB is
one of the five at any alpha; near-black shadows and scrims are neutral. Elements whose colour carries a meaning (MEANING) are
left out of the sweep and their colours are asserted to stay.
"""
import json
import sys
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from study_panel_page_dom_test import RASTER, WorkspaceSite, auth, settle, wait_startup  # noqa: E402

OWNER = json.dumps([auth.INSTITUTION, auth.RAD['sub']], separators=(',', ':'))
rgb = lambda value: 'rgb(%d, %d, %d)' % tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))

# Kept meaning colours (the work page palette's rule): status dots and RS, the draft / citation / notice bars, Held
# Studies, DB status, the row's status edge, image wells, the Related compare mode's frame and source card, engineering-only
# and filter notices, request notes, errors. MEANING covers the element and its contents; MEANING_FRAME the element only.
MEANING = ', '.join([
    '.dot', '.rs', '#rows td.num', '.draftbar', '#m-held', '#dbstat', '.thumbwrap', '#reading-viewer', '#related-mode-source', '#order-source-status',
    '#related-filter-hidden', '.image-request-closed', '.image-request-line', '.question-text', '.sfm-error',
    '.image-request-status[data-state="Requested"]', '.image-request-status[data-state="Accepted"]'])
MEANING_FRAME = '#related-mode'

SWEEP = r'''([roots, visibleOnly, meaning, frame]) => {
  const palette = ['33,33,33', '45,45,45', '227,227,227', '180,180,180', '138,180,200'];
  const parse = s => [...s.matchAll(/rgba?\(([^)]+)\)/g)].map(m => { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return {c: p.slice(0, 3).join(','), a: p.length > 3 ? p[3] : 1}; });
  const dark = c => c.split(',').every(n => Number(n) <= 24);
  const off = (s, neutralBlack) => parse(s).filter(v => v.a !== 0 && !palette.includes(v.c) && !(neutralBlack && dark(v.c)));
  const shown = e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return r.width >= 1 && r.height >= 1 && cs.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].map(c => '.' + c).join('');
  const where = e => { const a = []; for (let n = e; n && n !== document.body && a.length < 3; n = n.parentElement) a.unshift(name(n)); return a.join(' > '); };
  const out = [];
  for (const root of roots.flatMap(q => [...document.querySelectorAll(q)])) for (const e of [root, ...root.querySelectorAll('*')]) {
    if (e.closest('svg, canvas, img, video, iframe, option') || e.closest(meaning) || e.matches(frame) || (visibleOnly && !shown(e))) continue;
    const cs = getComputedStyle(e), check = (prop, value, neutralBlack) => { if (off(value, neutralBlack).length) out.push(where(e) + ' ' + prop + ' ' + value); };
    const box = e.matches('input[type=checkbox], input[type=radio], input[type=range]');
    check('background', cs.backgroundColor, e.matches('.modal'));
    if (!box && (e.matches('input, select, textarea, button') || [...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())))
      check('color', cs.color);
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      if (parseFloat(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none') check('border' + side, cs['border' + side + 'Color']);
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) check('outline', cs.outlineColor);
    if (cs.boxShadow !== 'none') check('boxShadow', cs.boxShadow, true);
    if (box && cs.accentColor !== 'auto') check('accent', cs.accentColor);
    if (box && cs.accentColor === 'auto') out.push(where(e) + ' accent auto (browser blue)');
  }
  return out; }'''

# Dialogs opened from this page that had colours of their own, with their opener (a public control).
DIALOGS = [('#reading-appearance-dialog', '#reading-appearance-open', '#reading-appearance-close'),
           ('#favorite-dialog', '#favorite-open', '#favorite-close'), ('#study-tag-dialog', '#study-tag-open', '#study-tag-close'),
           ('#worklist-alerts-dialog', '#worklist-alerts-open', '#alerts-done'),
           ('#tech-note-dialog', '#tech-note-open', '#tech-note-close'), ('#consultations-dialog', '#consultations-open', '#co-close'),
           ('#sr-dialog', '#sr-open', '#sr-close'), ('#viewer-windows-dialog', '#viewer-windows-open', '#viewer-windows-done'),
           ('#image-opening-dialog', '#image-opening-open', '#image-opening-done'),
           # Edit Shortcuts is in the Reading Workspace bar: the loop enters the Reading Workspace for it (last).
           ('#workspace-shortcuts-dialog', '#workspace-shortcuts-edit', '#workspace-shortcuts-cancel')]
# Not opened by this module; their computed colours are swept with the dialog closed.
CLOSED_ONLY = ['#reader-assignment-dialog', '#report-preview']
# Report column panes whose toggles had a focus colour of their own.
TOGGLES = ['#question-toggle', '#image-request-toggle', '#cvr-sent-toggle', '#cvr-inbox-toggle']
SFM_ERROR = 'rgb(255, 183, 169)'   # saved-filter-manager.css .sfm-error: a meaning colour that stays


SAVED_SEARCH = {'name': 'SYN Saved Search', 'mode': 'rad', 'days': 0, 'cols': {}}


class PaletteSite(WorkspaceSite):
    """The Reading Workspace frames the viewer; its document is out of this sweep (iframes are skipped), so it is empty."""

    def handle(self, route, request):
        if request.method == 'GET' and request.url.startswith(auth.ORIGIN + '/ohif/viewer'):
            return route.fulfill(body='<!DOCTYPE html><title>SYN viewer</title>', content_type='text/html; charset=utf-8')
        return super().handle(route, request)

    def api(self, route, request, method, path, query):
        # One saved search, so the Saved Search Manager has a list item to select.
        if method == 'GET' and path == '/api/filter-folders':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json={'owner': [auth.INSTITUTION, account['sub']], 'revision': 1, 'filters': [SAVED_SEARCH],
                                       'folders': [], 'shortcuts': []})
        return super().api(route, request, method, path, query)


class WorkPaletteDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, init=None):
        site = PaletteSite()
        context = self.browser.new_context(viewport={'width': 1920, 'height': 1080})
        context.route('**/*', lambda route, request: site.handle(route, request))
        if init:
            context.add_init_script(init)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        self.addCleanup(lambda: self.assertEqual([], site.violations))
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        auth.show_all_panels(page)
        settle(page)
        return page

    def sweep(self, page, roots=('body',), visible_only=True):
        return page.evaluate(SWEEP, [list(roots), visible_only, MEANING, MEANING_FRAME])

    def keyboard_focus(self, page, control):
        # Focus by the keyboard (Tab away and Shift+Tab back), so :focus-visible draws as it does for a reader.
        control.focus()
        page.keyboard.press('Tab')
        page.keyboard.press('Shift+Tab')
        self.assertTrue(control.evaluate("e => e === document.activeElement && e.matches(':focus-visible')"), 'keyboard focus')
        self.assertNotEqual('none', control.evaluate('e => getComputedStyle(e).outlineStyle'), 'focus is drawn')

    @staticmethod
    def reveal(page, selector):
        # Open each closed toolbar group holding the control, outermost first, by its summary (as a reader does).
        groups = page.locator(selector).first.evaluate('''e => { const out = [];
          for (let d = e.parentElement.closest('details'); d; d = d.parentElement.closest('details')) out.unshift(d);
          return out.map(d => d.id); }''')
        for group in groups:
            menu = page.locator('#' + group)
            if menu.get_attribute('open') is None:
                menu.locator(':scope > summary').click()

    def test_worklist_report_editor_and_reading_workspace_use_the_palette(self):
        page = self.open()
        self.assertEqual([], self.sweep(page), 'first paint')
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        settle(page)
        self.assertEqual([], self.sweep(page), 'a study selected, report editor shown')
        # The writing field stays marked apart from the panel it sits on, and focus is the accent.
        field = page.evaluate('''() => { const s = getComputedStyle(document.querySelector('#findings'));
          return [s.backgroundColor, s.borderTopColor, s.borderTopStyle, getComputedStyle(document.querySelector('.report-p')).backgroundColor]; }''')
        self.assertEqual([rgb('#212121'), rgb('#b4b4b4'), 'solid', rgb('#2d2d2d')], field)
        page.locator('#findings').focus()
        self.assertEqual(rgb('#8ab4c8'), page.locator('#findings').evaluate('e => getComputedStyle(e).borderTopColor'))
        row = page.locator('#rows tr[data-uid]').first
        self.keyboard_focus(page, row)
        self.assertEqual([], self.sweep(page, ['#rows']), 'keyboard focus in the list')
        for toggle in TOGGLES:
            with self.subTest(toggle=toggle):
                self.keyboard_focus(page, page.locator(toggle))
                self.assertEqual([], self.sweep(page, [toggle]), 'keyboard focus on a report column toggle')
        page.locator('#m-reading').click()
        page.wait_for_function("document.body.classList.contains('reading')")
        settle(page)
        self.assertEqual([], self.sweep(page), 'Reading Workspace')
        # Meaning colours stay.
        kept = page.evaluate('''() => [getComputedStyle(document.querySelector('.dot-w')).backgroundColor,
          getComputedStyle(document.querySelector('#rows .rs.W')).color, getComputedStyle(document.querySelector('#citemsg')).color]''')
        self.assertEqual([rgb('#4f8ef7'), rgb('#4f8ef7'), rgb('#d8b24a')], kept)

    def test_dialogs_opened_from_the_page_use_the_palette(self):
        page = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        for dialog, opener, close in DIALOGS:
            with self.subTest(dialog=dialog):
                if dialog == '#workspace-shortcuts-dialog':
                    page.locator('#m-reading').click()
                    page.wait_for_function("document.body.classList.contains('reading')")
                self.reveal(page, opener)
                page.locator(opener).click()
                expect(page.locator(dialog)).to_be_visible()
                try:
                    settle(page)
                    self.assertEqual([], self.sweep(page, [dialog]), 'opened')
                    self.keyboard_focus(page, page.locator(dialog).locator(
                        ':is(button, select):visible:not(:disabled)').first)
                    self.assertEqual([], self.sweep(page, [dialog]), 'a control focused')
                finally:
                    page.locator(close).click()
                    expect(page.locator(dialog)).not_to_be_visible()
        for dialog in CLOSED_ONLY:
            with self.subTest(dialog=dialog):
                expect(page.locator(dialog)).to_have_count(1)
                self.assertEqual([], self.sweep(page, [dialog], visible_only=False), 'closed')

    def test_saved_search_manager_selection_focus_and_error_lines(self):
        # A selected search, its keyboard focus, then an invalid rule: the count and status lines are errors and stay red.
        page = self.open()
        self.reveal(page, '#managefilters')
        page.locator('#managefilters').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        page.locator('#sfm-list button').first.click()
        expect(page.locator('#sfm-list button[aria-pressed=true]')).to_have_count(1)
        self.assertEqual([], self.sweep(page, ['#saved-filter-manager']), 'a saved search selected')
        self.keyboard_focus(page, page.locator('#sfm-list button[aria-pressed=true]'))
        self.assertEqual([], self.sweep(page, ['#saved-filter-manager']), 'the selected search focused')
        page.locator('#sfm-new').click()
        page.locator('#sfm-add-rule').click()
        page.locator('#sfm-preview').click()
        expect(page.locator('#saved-filter-manager .sfm-error')).to_have_count(2)
        self.assertEqual([], self.sweep(page, ['#saved-filter-manager']), 'with error lines')
        self.assertEqual([SFM_ERROR, SFM_ERROR], page.evaluate("() => ['#sfm-count', '#sfm-status'].map(s => getComputedStyle(document.querySelector(s)).color)"))

    def test_saved_report_text_colour_still_wins_and_survives_a_reload(self):
        page = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        self.reveal(page, '#reading-appearance-open')
        page.locator('#reading-appearance-open').click()
        page.locator('#reading-color-current').select_option('warm')
        page.keyboard.press('Escape')
        colours = lambda p: p.locator('#findings').evaluate('e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]')
        self.assertEqual([rgb('#fff1d6'), rgb('#212121')], colours(page))
        self.assertIn('"current":"warm"', page.evaluate('(key) => localStorage.getItem(key)', 'kin-reading-color:v1:' + OWNER))
        page.reload()
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        self.assertEqual([rgb('#fff1d6'), rgb('#212121')], colours(page))


if __name__ == '__main__':
    unittest.main()
