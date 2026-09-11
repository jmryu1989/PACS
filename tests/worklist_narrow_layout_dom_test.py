# coding: utf-8
"""Real worklist markup/CSS hit targets under wrapped toolbar pressure, no services."""
import re
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from worklist_image_thumbnails_dom_test import HARNESS, PREVIEW, THUMBNAILS

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'worklist-v0/hpacs-lite'


class WorklistNarrowLayoutDOMTest(unittest.TestCase):
    def test_row_and_images_controls_remain_reachable_after_toolbar_wrap(self):
        html = (ASSETS / 'main.html').read_text(encoding='utf-8')
        html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
        html = re.sub(r'<link\b[^>]*>', '', html)
        html = html.replace('</head>', '<style>' + '\n'.join(
            (ASSETS / name).read_text(encoding='utf-8') for name in
            ['saved-filter-manager.css', 'consultations.css', 'worklist-columns.css', 'reading-workspace.css']) + '</style></head>')
        html = html.replace('<body>', '<body class="portrait">')
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={'width': 390, 'height': 700})
            page.set_default_timeout(4000)
            page.route('**/*', lambda route: route.abort())
            page.set_content(html)
            page.evaluate("""()=>{
              document.querySelector('#heads').innerHTML='<th>Patient</th><th>Study</th>';
              document.querySelector('#rows').innerHTML='<tr tabindex="0"><td>Synthetic Patient</td><td>CT</td></tr>';
              document.querySelector('#rows tr').onclick=()=>window.rowClicked=true;
              document.querySelector('#findings').value='Unchanged editor text';
            }""")
            row = page.locator('#rows tr')
            try:
                row.click()
                self.assertTrue(page.evaluate('rowClicked'))
                harness = re.search(r'<script>(.*)</script>', HARNESS, re.S).group(1)
                page.add_script_tag(content=harness.replace("document.querySelector('#host')", "document.querySelector('#thumbwrap')"))
                page.add_script_tag(content=PREVIEW)
                page.add_script_tag(content=THUMBNAILS)
                page.evaluate('start()')
                expect(page.locator('#thumb-images-status')).to_have_text('12 / 12 images ready')
                for selector in ['#thumb-images-back', '#thumb-images-order', '#thumb-images-retry', '#thumb-images-next', '.thumb-image-open']:
                    control = page.locator(selector).first
                    control.scroll_into_view_if_needed()
                    control.click(trial=True)
                page.locator('.thumb-image-open').first.focus()
                page.locator('.thumb-image-open').first.press('Enter')
                self.assertEqual(1, page.evaluate('previewCalls.length'))
                size = page.locator('#thumb-images-view').evaluate('e=>[e.clientWidth,e.scrollWidth]')
                self.assertLessEqual(size[1], size[0] + 1)
                expect(page.locator('#findings')).to_have_value('Unchanged editor text')
            finally:
                out = ROOT / 'tmp/image-thumbnails/narrow-layout'
                out.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(out / 'latest.png'), full_page=True)
                print(page.evaluate("""()=>Object.fromEntries(['.menubar','.userfilter','.split','.left','.left .grid','.right'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,{x:r.x,y:r.y,w:r.width,h:r.height}]}))"""))
                browser.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
