# coding: utf-8
"""FA-066 (Minhoon M-101, 10-05 "#19: selected studies or the search results, in the columns I choose, as a file for
Excel"): Export List in the toolbar's More menu writes the loaded search result or the multi-selection to a CSV (Excel)
or tab-delimited Text file. The committed page and bundle are served; only HTTP answers are synthetic
(worklist_folders_dom_test).

Checked here with real downloads: the button's place (last in More, the existing buttons unchanged), the
default scope (Selected when there is a selection, else All Search Results, the loaded list across pages), the default
columns (the ones the list shows, in its order), a selection across two pages of a sorted list keeping each study's
search-order No, the Text format, and the cell text being what the list shows (RS 'Unread', not 'W').
"""
import os
import sys
import unittest
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import auth_logout_dom_test as auth
from worklist_folders_dom_test import FolderSite


class ExportSite(FolderSite):
    def list_body(self, account, rename=None):
        # 30 rows: UIDs keep the server's ascending order as text (.100 to .129), as the page checks it.
        body = super().list_body(account, rename)
        for i, row in enumerate(body['studies']):
            row['uid'] = auth.UID + '.' + str(100 + i)
        return body


class WorklistExportDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = ExportSite()
        self.site.modalities = ['CT'] * 30
        self.context = self.browser.new_context(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
        self.context.route('**/*', lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def open_export(self):
        more = self.page.locator('#toolbar-more')
        if more.get_attribute('open') is None:
            more.locator(':scope > summary').click()
        self.page.locator('#worklist-export-open').click()

    def download(self):
        with self.page.expect_download() as info:
            self.page.locator('#worklist-export-dialog [data-export-run]').click()
        raw = open(info.value.path(), 'rb').read()
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        return info.value.suggested_filename, raw[3:].decode('utf-8')

    def test_export_list_selection_across_pages_all_results_and_text(self):
        page = self.page
        page.goto(auth.MAIN_URL)
        page.locator('#page-size').select_option('25')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(25)
        # Added after Worklist Alerts in More; the existing buttons keep their names and order (later ones follow).
        self.assertEqual(['consultations-open', 'study-access-open', 'worklist-alerts-open', 'worklist-export-open'],
                         page.locator('#toolbar-more > .toolbar-menu-panel > button').evaluate_all('bs => bs.map(b => b.id)')[:4])
        expect(page.locator('#worklist-export-open')).to_have_text('Export List')
        expect(page.locator('#worklist-export-open')).to_be_enabled()

        keys = page.locator('#heads th').evaluate_all('ths => ths.map(th => th.dataset.key)')
        titles = page.locator('#heads th').evaluate_all('ths => ths.map(th => th.textContent.trim())')
        titles[0] = page.locator('#heads th').first.get_attribute('aria-label')
        id_at = keys.index('id')
        page.locator('#heads th[data-key="id"]').click()
        ids = lambda: page.locator('#rows tr[data-uid]').evaluate_all(f'trs => trs.map(tr => tr.cells[{id_at}].textContent.trim())')
        first_page = ids()
        # String order (SYN-0, SYN-1, SYN-10, ...) differs from the loaded order (SYN-0, SYN-1, SYN-2, ...).
        asc = sorted('SYN-%d' % i for i in range(30))
        self.assertIn(first_page, (asc[:25], asc[::-1][:25]))

        # Ctrl-click the 2nd row on page 1 and the 1st row on page 2: numbers 2 and 26 of the sorted search result.
        page.locator('#rows tr[data-uid]').nth(1).click(modifiers=['Control'])
        page.locator('#page-next').click()
        second_page = ids()
        page.locator('#rows tr[data-uid]').nth(0).click(modifiers=['Control'])
        expect(page.locator('#multi-selection-count')).to_have_text('Selected: 2')

        self.open_export()
        dialog = page.locator('#worklist-export-dialog')
        expect(dialog).to_be_visible()
        expect(dialog.get_by_label('Selected Studies (2)')).to_be_checked()
        expect(dialog.get_by_label('All Search Results (30)')).not_to_be_checked()
        expect(dialog).to_contain_text('현재 불러온 목록의 모든 페이지')
        boxes = dialog.locator('input[type=checkbox]')
        self.assertEqual(keys, boxes.evaluate_all('bs => bs.filter(b => b.checked).map(b => b.value)'))
        for box in boxes.all():
            box.set_checked(box.get_attribute('value') in ('no', 'id', 'name'))
        name, text = self.download()
        self.assertRegex(name, r'^worklist-\d{8}-\d{6}\.csv$')
        order = [k for k in keys if k in ('no', 'id', 'name')]
        header = {'no': 'No', 'id': 'ID', 'name': 'Name'}
        lines = text.split('\r\n')
        self.assertEqual(['' ], lines[3:])
        self.assertEqual(','.join(header[k] for k in order), lines[0])
        for line, (no, sid) in zip(lines[1:3], [(2, first_page[1]), (26, second_page[0])]):
            values = dict(zip(order, line.split(',')))
            self.assertEqual((str(no), sid, 'SYN CT'), (values['no'], values['id'], values['name']))
        expect(dialog).not_to_be_visible()

        # All Search Results, Text: the 30 loaded rows, the shown columns and the list's own words.
        self.open_export()
        dialog.get_by_label('All Search Results (30)').check()
        dialog.locator('[data-export-format]').select_option('txt')
        name, text = self.download()
        self.assertTrue(name.endswith('.txt'))
        lines = text.split('\r\n')
        self.assertEqual(32, len(lines))
        self.assertEqual('\t'.join(titles), lines[0])
        cells = [line.split('\t') for line in lines[1:31]]
        self.assertEqual([str(i) for i in range(1, 31)], [row[keys.index('no')] for row in cells])
        self.assertEqual(first_page, [row[id_at] for row in cells[:25]])
        self.assertEqual({'Unread'}, {row[keys.index('rs')] for row in cells})

    def test_no_selection_defaults_to_all_and_no_columns_blocks_export(self):
        page = self.page
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(30)
        # An empty search result disables Export List; a list again enables it.
        page.evaluate('() => { window.__syn = studies; studies = []; render(); }')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(0)
        expect(page.locator('#worklist-export-open')).to_be_disabled()
        page.evaluate('() => { studies = window.__syn; render(); }')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(30)
        expect(page.locator('#worklist-export-open')).to_be_enabled()
        self.open_export()
        dialog = page.locator('#worklist-export-dialog')
        expect(dialog).to_contain_text('-로 시작하지만 숫자(-3, -0.5 등)가 아닌 값')
        expect(dialog.get_by_label('Selected Studies (0)')).to_be_disabled()
        expect(dialog.get_by_label('All Search Results (30)')).to_be_checked()
        for box in dialog.locator('input[type=checkbox]').all():
            box.uncheck()
        expect(dialog.locator('[data-export-run]')).to_be_disabled()
        dialog.get_by_role('button', name='Cancel').click()
        expect(dialog).not_to_be_visible()
        # The toolbar closes More when the dialog opens; the keyboard comes back to the More menu it was opened from.
        expect(page.locator('#toolbar-more > summary')).to_be_focused()


if __name__ == '__main__':
    unittest.main(verbosity=2)
