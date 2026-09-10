"""REQ-D01-APPEARANCE -> RISK-PREFERENCE-LOSS/READABILITY/TARGET -> TEST-D01-APPEARANCE."""
import os, unittest, re
from pathlib import Path
from playwright.sync_api import expect
from test_worklist_columns_roaming import ColumnsRoamingE2E

class AppearanceE2E(ColumnsRoamingE2E):
    def test_appearance_workflow(self):
        f=self.fixture();self.seed_report(f);page=self.login();self.select(page,f)
        page.locator('#findings').fill('Appearance unsaved report')
        expect(page.locator(f'#rows tr[data-uid="{f.uid}"] .rs')).to_have_css('color',re.compile(r'rgb'))
        # Read the currently connected node in one browser turn: selecting a study
        # can replace the row between locator resolution and evaluation.
        status_color=page.evaluate('(uid)=>getComputedStyle(document.querySelector(`[data-uid="${uid}"] .rs`)).color',f.uid)
        self.assertTrue(status_color.startswith('rgb'))
        self.open_columns(page)
        self.column(page,'name').locator('.wc-width').fill('240')
        page.locator('#wc-font').select_option('mono');page.locator('#wc-size').select_option('18');page.locator('#wc-color').select_option('warm')
        self.action(page,'inspect','저장된 열 설정이 없습니다');self.action(page,'save','편집값을 계정에 저장했습니다')
        expect(page.locator('#rows .wc-cell')).to_have_count(0)
        page.locator('#wc-save').click()
        row=page.locator(f'#rows tr[data-uid="{f.uid}"]')
        self.assertEqual(row.locator('.wc-cell').evaluate('e=>e.getBoundingClientRect().width'),240)
        self.assertEqual(row.locator('td').first.evaluate('e=>getComputedStyle(e).fontSize'),'18px')
        self.assertEqual(row.locator('td').first.evaluate('e=>getComputedStyle(e).color'),'rgb(255, 230, 196)')
        self.assertIn('Consolas',row.locator('td').first.evaluate('e=>getComputedStyle(e).fontFamily'))
        self.assertEqual(row.locator('.rs').evaluate('e=>getComputedStyle(e).color'),status_color)
        expect(page.locator('#findings')).to_have_value('Appearance unsaved report')
        self.assertEqual(page.evaluate('selectedUid'),f.uid)
        other=self.login();expect(other.locator('#rows .wc-cell')).to_have_count(0)
        self.open_columns(other);self.action(other,'load','편집창에 불러왔습니다')
        expect(other.locator('#wc-size')).to_have_value('18');expect(other.locator('#rows .wc-cell')).to_have_count(0)
        other.locator('#wc-save').click()
        self.assertEqual(other.locator('#rows .wc-cell').first.evaluate('e=>e.getBoundingClientRect().width'),240)
        other.reload();expect(other.locator('#dbstat')).to_contain_text('DB Connected')
        self.assertEqual(other.locator('#rows .wc-cell').first.evaluate('e=>e.getBoundingClientRect().width'),240)
        other.locator('[data-tab="Technician"]').click();expect(other.locator('#rows .wc-cell')).to_have_count(0)
        other.locator('[data-tab="Radiology"]').click()
        self.open_columns(other);self.column(other,'name').locator('.wc-width').fill('601');other.locator('#wc-save').click()
        expect(other.locator('#wc-status')).to_contain_text('확인할 수 없습니다')
        expect(self.column(other,'name').locator('.wc-width')).to_have_value('601')
        other.once('dialog',lambda d:d.accept());other.locator('#wc-close').click()
        self.open_columns(other);expect(self.column(other,'name').locator('.wc-width')).to_have_value('240')
        other.set_viewport_size({'width':600,'height':700})
        self.assertTrue(other.locator('#column-manager').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
        evidence=Path(os.environ['KIN_EVIDENCE_DIR']);evidence.mkdir(parents=True,exist_ok=True)
        other.screenshot(path=str(evidence/'appearance-editor.png'))
        other.locator('#wc-reset').click();other.locator('#wc-save').click();expect(other.locator('#rows .wc-cell')).to_have_count(0)
        page.screenshot(path=str(evidence/'appearance-worklist.png'))

def load_tests(loader,tests,pattern):
    return unittest.TestSuite([AppearanceE2E('test_appearance_workflow')])
if __name__=='__main__':unittest.main(verbosity=2)
