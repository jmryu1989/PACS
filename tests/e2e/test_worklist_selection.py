# coding: utf-8
"""REQ-D01-MULTI-SELECTION: real selection, editor retention and comparison."""
import sys,unittest
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready

class WorklistSelectionE2E(ReadingWorkspaceE2E):
    def mark(self,p,uid):p.locator('#rows tr[data-uid="'+uid+'"]').click(modifiers=['Control'])

    def test_selection_01_details_filter_keyboard_and_unsaved_target(self):
        a,b=self.pair();c=self.ct('SYNTHETIC-other','other','20260802');p=self.login();self.choose(p,a)
        p.locator('#findings').fill('SYNTHETIC MULTI UNSAVED');p.evaluate('clearInterval(poll)');p.locator('#quick').fill('')
        self.mark(p,a.uid);self.mark(p,b.uid)
        expect(p.locator('#multi-selection-count')).to_have_text('Selected: 2')
        self.assertEqual(p.evaluate('selectedUid'),a.uid);expect(p.locator('#findings')).to_have_value('SYNTHETIC MULTI UNSAVED')
        p.locator('#multi-selection-details').click();d=p.locator('#multi-selection-dialog');expect(d).to_be_visible()
        expect(d.locator('tbody tr')).to_have_count(2);expect(d.locator('[data-compare]')).to_be_enabled()
        d.locator('[data-close]').click();self.mark(p,c.uid);p.locator('#multi-selection-details').click()
        expect(d.locator('[data-compare]')).to_be_disabled();d.locator('[data-close]').click()
        p.locator('#quick').fill(a.patient_id)
        expect(p.locator('#multi-selection-count')).to_have_text('Selected: 2')
        p.locator('#multi-selection-clear').click();expect(p.locator('#multi-selection-count')).to_have_text('Selected: 0')
        row=p.locator('#rows tr[data-uid="'+b.uid+'"]');row.focus();row.press('Space')
        expect(row).to_have_attribute('aria-selected','true');self.assertEqual(p.evaluate('selectedUid'),a.uid)
        expect(p.locator('#findings')).to_have_value('SYNTHETIC MULTI UNSAVED')
        p.locator('#rows tr[data-uid="'+a.uid+'"]').click(modifiers=['Shift'])
        expect(p.locator('#multi-selection-count')).to_have_text('Selected: 2');self.assertEqual(p.evaluate('selectedUid'),a.uid)
        p.locator('#multi-selection-page').click();expect(p.locator('#multi-selection-count')).to_have_text('Selected: 2')
        p.locator('#multi-selection-details').click();folder=Path('../tmp/worklist-selection/screens');folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'selection-details.png'))
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close();}")
        expect(d).to_have_count(0);expect(p.locator('#worklist-selection')).not_to_be_visible()

    def test_selection_02_real_comparison_preserves_report_and_originals(self):
        a,b=self.pair();original=self.originals();p=self.login();self.choose(p,a)
        p.locator('#findings').fill('SYNTHETIC COMPARE UNSAVED')
        self.mark(p,a.uid);self.mark(p,b.uid);p.locator('#multi-selection-details').click()
        with p.context.expect_page() as opened:p.locator('#multi-selection-dialog [data-compare]').click()
        popup=opened.value;popup.wait_for_url('**/ohif/viewer?**');canvas_ready(popup,2)
        self.assertEqual(parse_qs(urlsplit(popup.url).query)['StudyInstanceUIDs'],[a.uid+','+b.uid])
        expect(p.locator('#findings')).to_have_value('SYNTHETIC COMPARE UNSAVED');self.assertEqual(p.evaluate('selectedUid'),a.uid)
        popup.close();self.assertEqual(self.originals(),original)

    def test_selection_03_explicit_open_restores_editor_and_keeps_dialog_focus(self):
        a,b=self.pair();p=self.login();self.choose(p,a);p.locator('#findings').fill('SYNTHETIC EXPLICIT OPEN UNSAVED')
        self.mark(p,b.uid);p.locator('#multi-selection-details').click();d=p.locator('#multi-selection-dialog')
        open_study=d.get_by_role('button',name='Open Study',exact=True);open_study.focus();p.evaluate('render()');expect(open_study).to_be_focused()
        folder=Path('../tmp/worklist-selection/screens');folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'selection-open.png'))
        open_study.click();expect(d).not_to_be_visible();self.assertEqual(p.evaluate('selectedUid'),b.uid)
        self.choose(p,a);expect(p.locator('#findings')).to_have_value('SYNTHETIC EXPLICIT OPEN UNSAVED')
        self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(WorklistSelectionE2E(name) for name in WorklistSelectionE2E.__dict__ if name.startswith('test_selection_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
