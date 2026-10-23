"""SCN-S9-SWEEP-01 / A11Y-01 -> RISK-D-WORKSPACE-ACCESS/SHORTCUT-CONFLICT.

Exercise the shipped main page and assets through the existing synthetic HTTP
boundary. No page reconstruction, product hooks, or real accounts are used.
Existing model/live suites own key validation and viewer navigation; these cases
cover the remaining page integration: keyboard configuration, modal/IME routing,
focus return, and browser-computed accessible names. This is not a screen-reader
acceptance test, a contrast/size threshold, or a real OHIF/approval test.
The OHIF document request is deliberately aborted at HTTP: workspace settings
remain usable when the image server is unavailable. No successful viewer is
fabricated; the normal viewer controls remain covered by the existing live suite.
"""
import unittest

from playwright.sync_api import expect, sync_playwright

import auth_logout_dom_test as auth
from study_panel_page_dom_test import WorkspaceSite, wait_startup


class S9AccessibilityPage(unittest.TestCase):
    # Preserve every missing name in a failing state for the owner handoff.
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.site = WorkspaceSite()
        self.context = self.browser.new_context()
        self.context.route('**/*', self.site.handle)
        self.context.route('**/ohif/**', lambda route: route.abort())
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(self.page, self.site)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, 'uncaught errors in the served page')
        self.assertEqual([], self.site.violations, 'synthetic HTTP boundary errors')

    def open_shortcuts(self):
        opener = self.page.get_by_role('button', name='Edit Shortcuts', exact=True)
        if not opener.is_visible():
            self.page.locator('#rows tr[data-uid]').first.click()
            expect(self.page.locator('#findings')).to_be_editable()
            self.page.get_by_role('button', name='Reading Workspace', exact=True).click()
            expect(opener).to_be_visible()
        opener.focus()
        opener.press('Enter')
        dialog = self.page.get_by_role('dialog', name='Workspace Shortcuts', exact=True)
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('textbox', name='Worklist 단축키', exact=True)).to_be_focused()
        return dialog, opener

    def test_keyboard_configuration_executes_the_displayed_key_and_returns_focus(self):
        """D575: two named tabs and Ctrl+S; remap through actual page controls."""
        dialog, opener = self.open_shortcuts()
        worklist = dialog.get_by_role('tab', name='Worklist', exact=True)
        viewer = dialog.get_by_role('tab', name='Viewer', exact=True)
        expect(dialog.get_by_role('textbox', name='Finalize (Approve) 단축키', exact=True)).to_have_value('Control+S')
        # Initial focus is the first input; Shift+Tab reaches the active tab.
        self.page.keyboard.press('Shift+Tab')
        expect(worklist).to_be_focused()
        self.page.keyboard.press('ArrowRight')
        expect(viewer).to_be_focused()
        expect(viewer).to_have_attribute('aria-selected', 'true')
        self.page.keyboard.press('Tab')
        expect(dialog.get_by_role('textbox', name='Image 단축키', exact=True)).to_be_focused()
        self.page.keyboard.press('Shift+Tab')
        self.page.keyboard.press('Home')
        expect(worklist).to_be_focused()
        expect(worklist).to_have_attribute('aria-selected', 'true')
        field = dialog.get_by_role('textbox', name='Study Info & Templates 단축키', exact=True)
        field.press('Control+Alt+Q')
        expect(field).to_have_value('Control+Alt+Q')
        dialog.get_by_role('button', name='Apply & Save', exact=True).press('Enter')
        expect(dialog).not_to_be_visible()
        expect(opener).to_be_focused()
        self.page.keyboard.press('Control+Alt+5')
        expect(self.page.locator('#study-panel-open')).to_have_attribute('aria-expanded', 'false')
        self.page.keyboard.press('Control+Alt+Q')
        expect(self.page.locator('#study-panel-open')).to_have_attribute('aria-expanded', 'true')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#study-panel-open')).to_have_attribute('aria-expanded', 'false')
        # Reopen from the keyboard after closing the destination: the displayed
        # binding must be the one the served page actually used.
        dialog, opener = self.open_shortcuts()
        expect(dialog.get_by_role('textbox', name='Study Info & Templates 단축키', exact=True)).to_have_value('Control+Alt+Q')
        self.page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        expect(opener).to_be_focused()

    def test_modal_and_composition_do_not_dispatch_the_background_shortcut(self):
        dialog, opener = self.open_shortcuts()
        field = dialog.get_by_role('textbox', name='Worklist 단축키', exact=True)
        before = field.input_value()
        # Browser IME event flags at the real input boundary, never a replacement
        # dispatcher. Real IME hardware and assistive tools remain U8 evidence.
        field.dispatch_event('keydown', dict(key='q', code='KeyQ', ctrlKey=True,
                                            altKey=True, isComposing=True, bubbles=True))
        expect(field).to_have_value(before)
        field.press('Control+Alt+5')
        expect(field).to_have_value('Control+Alt+5')
        expect(self.page.locator('#study-panel-open')).to_have_attribute('aria-expanded', 'false')
        expect(dialog).to_be_visible()
        self.page.keyboard.press('Escape')
        expect(opener).to_be_focused()
        # A composing event outside the dialog also leaves the destination closed.
        opener.dispatch_event('keydown', dict(key='5', code='Digit5', ctrlKey=True,
                                             altKey=True, isComposing=True, bubbles=True))
        expect(self.page.locator('#study-panel-open')).to_have_attribute('aria-expanded', 'false')
        # Normal control proves the command is available in this same document.
        self.page.keyboard.press('Control+Alt+5')
        expect(self.page.locator('#study-panel-open')).to_have_attribute('aria-expanded', 'true')

    def unnamed_controls(self):
        """Use Chromium's computed accessibility tree, not a label-name parser."""
        session = self.context.new_cdp_session(self.page)
        try:
            nodes = session.send('Accessibility.getFullAXTree')['nodes']
            unnamed = []
            for node in nodes:
                if node.get('ignored') or node.get('role', {}).get('value') not in {
                    'button', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'slider', 'spinbutton', 'link'
                }:
                    continue
                if str(node.get('name', {}).get('value', '')).strip():
                    continue
                element = session.send('DOM.describeNode', {'backendNodeId': node['backendDOMNodeId']})['node']
                attrs = element.get('attributes', [])
                unnamed.append(dict(role=node['role']['value'], tag=element['localName'],
                                    attributes=dict(zip(attrs[::2], attrs[1::2]))))
            return unnamed
        finally:
            session.detach()

    def test_exposed_controls_have_browser_computed_accessible_names(self):
        """Collect all name defects in each state; do not stop at the first one."""
        with self.subTest(state='document-language'):
            self.assertTrue(self.page.locator('html').get_attribute('lang'), 'document language is declared')
        with self.subTest(state='worklist'):
            self.assertEqual([], self.unnamed_controls())
        self.page.locator('#rows tr[data-uid]').first.click()
        expect(self.page.locator('#findings')).to_be_editable()
        with self.subTest(state='report'):
            self.assertEqual([], self.unnamed_controls())
        dialog, _ = self.open_shortcuts()
        for tab in ('Worklist', 'Viewer'):
            dialog.get_by_role('tab', name=tab, exact=True).press('Enter')
            with self.subTest(state='shortcuts-' + tab):
                self.assertEqual([], self.unnamed_controls())
        self.page.keyboard.press('Escape')


if __name__ == '__main__':
    unittest.main()
