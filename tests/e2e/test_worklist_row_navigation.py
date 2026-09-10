# coding: utf-8
"""REQ-D01-ROW-KEYBOARD: list traversal, explicit report target and draft return."""
import json,sys,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_reading_workspace import ReadingWorkspaceE2E
from test_prior_selection import canvas_ready

class WorklistRowNavigationE2E(ReadingWorkspaceE2E):
    def setup_rows(self):
        patient='KEYBOARD-'+uuid.uuid4().hex[:12]
        fixtures=[self.ct(patient,'row-'+str(i),'2026080'+str(i+1)) for i in range(3)]
        for f in fixtures:self.seed_report(f,findings='BASE '+f.uid)
        p=self.login();self.choose(p,fixtures[0]);p.locator('#quick').fill(patient)
        expect(p.locator('#rows tr[data-uid]')).to_have_count(3)
        p.wait_for_function('rowNavigation!==null')
        order=p.locator('#rows tr[data-uid]').evaluate_all('(rows)=>rows.map(r=>r.dataset.uid)')
        return p,fixtures,order

    def test_keyboard_01_tab_arrow_multi_selection_enter_and_report_return(self):
        p,fixtures,order=self.setup_rows();first=fixtures[0]
        original=self.originals();p.locator('#findings').fill('KEYBOARD UNSAVED CURRENT')
        # Enter the list through the actual tab order from its last filter control.
        last_filter=p.locator('#filterrow input,#filterrow select').last
        last_filter.focus();expect(last_filter).to_be_focused()
        print(json.dumps({'beforeTab':p.evaluate('({active:document.activeElement.id,rows:[...document.querySelectorAll("#rows tr")].map(r=>({uid:r.dataset.uid,tab:r.tabIndex}))})')}),flush=True)
        p.keyboard.press('Tab')
        print(json.dumps({'afterTab':p.evaluate('({tag:document.activeElement.tagName,id:document.activeElement.id,parent:document.activeElement.parentElement?.id})')}),flush=True)
        self.assertEqual(p.evaluate('document.activeElement.parentElement?.id'),'rows')
        expect(p.locator('#rows tr[tabindex="0"]')).to_have_count(1)
        # Each row's note remains reachable after entering that row.
        entered=p.evaluate('document.activeElement.dataset.uid');p.keyboard.press('Tab')
        expect(p.locator(f'#rows [data-reader-assignment="{entered}"]')).to_be_focused()
        p.keyboard.press('Tab')
        expect(p.locator(f'#rows [data-tech-note="{entered}"]')).to_be_focused()
        p.keyboard.press('Enter');expect(p.locator('#tech-note-dialog')).to_be_visible()
        p.locator('#tech-note-close').click();p.keyboard.press('Shift+Tab');p.keyboard.press('Shift+Tab')
        expect(p.locator(f'#rows tr[data-uid="{entered}"]')).to_be_focused()
        p.keyboard.press('Home');expect(p.locator(f'#rows tr[data-uid="{order[0]}"]')).to_be_focused()
        p.keyboard.press('Space');p.keyboard.press('ArrowDown');p.keyboard.press('Shift+Space')
        expect(p.locator('#multi-selection-count')).to_have_text('Selected: 2')
        self.assertEqual(p.evaluate('selectedUid'),first.uid)
        expect(p.locator('#findings')).to_have_value('KEYBOARD UNSAVED CURRENT')
        target=next(uid for uid in order if uid!=first.uid)
        p.keyboard.press('Home')
        for _ in range(order.index(target)):p.keyboard.press('ArrowDown')
        p.keyboard.press('Enter');expect(p.locator('#findings')).to_be_focused()
        self.assertEqual(p.evaluate('selectedUid'),target)
        expect(p.locator('#findings')).to_have_value('BASE '+target)
        p.locator('#findings').fill('KEYBOARD UNSAVED SECOND')
        p.keyboard.press('Control+Alt+1');expect(p.locator('#quick')).to_be_focused()
        p.locator('#filterrow input,#filterrow select').last.focus();p.keyboard.press('Tab');p.keyboard.press('Home')
        for _ in range(order.index(first.uid)):p.keyboard.press('ArrowDown')
        p.keyboard.press('Enter');expect(p.locator('#findings')).to_be_focused()
        expect(p.locator('#findings')).to_have_value('KEYBOARD UNSAVED CURRENT')
        p.locator('#m-reading').click()
        expect(p.locator('#reading-status')).to_have_text('영상 작업공간 연결됨',timeout=60000)
        frame=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(frame,1)
        p.keyboard.press('Control+Alt+2');expect(p.locator('#reading-frame')).to_be_focused()
        p.keyboard.press('Control+Alt+4');expect(p.locator('#findings')).to_be_focused()
        expect(p.locator('#findings')).to_have_value('KEYBOARD UNSAVED CURRENT')
        p.keyboard.press('Control+Alt+1');expect(p.locator('#quick')).to_be_focused()
        self.assertEqual(self.originals(),original)
        self.assertTrue(all(len(self.versions(f))==1 for f in fixtures))

    def test_keyboard_02_refresh_fallback_and_session_end(self):
        p,fixtures,order=self.setup_rows()
        row=p.locator('#rows tr[tabindex="0"]');row.focus();p.keyboard.press('End')
        last=p.locator(f'#rows tr[data-uid="{order[-1]}"]')
        expect(last).to_be_focused();p.evaluate('load()');expect(last).to_be_focused()
        p.locator('#findings').focus();p.evaluate('render()');expect(p.locator('#findings')).to_be_focused()
        last.focus();p.evaluate('uid=>{studies=studies.filter(s=>s.uid!==uid);render();}',order[-1])
        self.assertNotEqual(p.evaluate('document.activeElement.dataset.uid'),order[-1])
        self.assertEqual(p.evaluate('document.activeElement.parentElement.id'),'rows')
        expect(p.locator('#rows tr[tabindex="0"]')).to_have_count(1)
        p.evaluate('()=>{studies=[];render();}');expect(p.locator('#quick')).to_be_focused()
        p.evaluate('load()');expect(p.locator('#rows tr[tabindex="0"]')).to_have_count(1)
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close();}")
        expect(p.locator('#rows tr[tabindex="0"]')).to_have_count(0)

    def test_keyboard_03_page_boundary_uses_loaded_order(self):
        p,fixtures,order=self.setup_rows()
        # DOM paging fixture only: these are not thirty newly stored DICOM studies.
        p.evaluate('''uid=>{clearInterval(poll);const base=studies.find(s=>s.uid===uid);
          studies=Array.from({length:31},(_,i)=>({...base,uid:'keyboard-dom-'+i}));resultPageSize=25;render();}''',fixtures[0].uid)
        rows=p.locator('#rows tr[data-uid]');expect(rows).to_have_count(25)
        rows.last.evaluate('row=>row.focus({preventScroll:true})')
        p.locator('.left .grid').evaluate('grid=>grid.scrollLeft=20')
        horizontal=p.locator('.left .grid').evaluate('grid=>grid.scrollLeft')
        p.keyboard.press('ArrowDown')
        self.assertEqual(p.locator('.left .grid').evaluate('grid=>grid.scrollLeft'),horizontal)
        self.assertEqual(p.evaluate('resultPage'),1)
        self.assertEqual(p.evaluate('document.activeElement.dataset.uid'),'keyboard-dom-25')
        p.keyboard.press('ArrowUp');self.assertEqual(p.evaluate('resultPage'),0)
        self.assertEqual(p.evaluate('document.activeElement.dataset.uid'),'keyboard-dom-24')
        p.keyboard.press('End');self.assertEqual(p.evaluate('document.activeElement.dataset.uid'),'keyboard-dom-30')
        p.keyboard.press('Home');self.assertEqual(p.evaluate('document.activeElement.dataset.uid'),'keyboard-dom-0')
        # Keep same-page DOM/focus stable and the active row below sticky headers.
        p.evaluate('''()=>{const row=document.querySelector('#rows tr[data-uid="keyboard-dom-10"]'),grid=row.closest('.grid');
          window.__rowNode=row;row.focus({preventScroll:true});
          grid.scrollTop+=row.getBoundingClientRect().top-grid.querySelector('thead').getBoundingClientRect().bottom;}''')
        p.keyboard.press('ArrowUp')
        self.assertTrue(p.evaluate('document.contains(window.__rowNode)'))
        bounds=p.evaluate('''()=>({row:document.activeElement.getBoundingClientRect().top,
          header:document.querySelector('.left .grid thead').getBoundingClientRect().bottom})''')
        self.assertGreaterEqual(bounds['row'],bounds['header']-1)
        vertical=p.locator('.left .grid').evaluate('grid=>grid.scrollTop');p.keyboard.press('Space')
        self.assertEqual(p.locator('.left .grid').evaluate('grid=>grid.scrollTop'),vertical)
        self.assertEqual(p.evaluate('getComputedStyle(document.activeElement).outlineWidth'),'2px')
        folder=Path('../tmp/worklist-row-navigation/screens');folder.mkdir(parents=True,exist_ok=True)
        p.screenshot(path=str(folder/'keyboard-list.png'))
        print(json.dumps({'scope':'31 DOM-only paging rows; no report activation or server data fabricated'}),flush=True)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(WorklistRowNavigationE2E(name) for name in WorklistRowNavigationE2E.__dict__ if name.startswith('test_keyboard_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
