"""Patient-strip layout must preserve keyboard focus across header placement.

The fixture supplies the pinned OHIF header boundary; real Chromium owns focus
and DOM relocation. The served patient-tab suite covers native router teardown.
"""
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = """
<div>
  <div class="kin-patient-tabs"><div role="tablist" aria-label="Patients">
    <button role="tab" aria-selected="true">Patient A</button>
  </div></div>
  <div class="bg-secondary-dark z-20">
    <div style="height:32px;position:relative">
      <span id="kin-viewer-brand">HALO PACS</span>
      <div class="relative flex justify-center"><div><button aria-label="Layout">Layout</button></div></div>
      <div class="absolute right-0"><button aria-label="Settings">Settings</button></div>
    </div>
  </div>
</div>
"""


class ViewerHeaderFocusDOM(unittest.TestCase):
    def test_header_placement_keeps_focused_tab_or_external_control(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width in (900, 1366, 1680):
                for target in ("Patient A", "Settings"):
                    with self.subTest(width=width, focus=target):
                        page = browser.new_page(viewport={"width": width, "height": 900})
                        page.set_content(HTML)
                        page.add_script_tag(content="""
                          const KIN_VIEWER_DEFAULT_TITLE='Viewer', KIN_VIEWER_PRODUCT='Viewer';
                          const kinViewerOnEnd=()=>null, kinViewerToolbarLabels={apply(){}};
                        """)
                        page.add_script_tag(path=str(ROOT / "config/ohif/branding.js"))
                        focused = page.get_by_role("tab" if target == "Patient A" else "button", name=target, exact=True)
                        focused.focus()
                        page.evaluate("""() => KinViewerBrand({React:{
                          useEffect(fn){window.disposeBrand=fn()}, createElement(){return null}
                        }})""")
                        page.wait_for_function("""() => {
                          const tabs=document.querySelector('[role=tablist]').parentElement;
                          const header=document.getElementById('kin-viewer-brand').closest('.bg-secondary-dark');
                          return tabs.getBoundingClientRect().top >= header.getBoundingClientRect().bottom;
                        }""")
                        expect(focused).to_be_focused()
                        page.evaluate("disposeBrand()")
                        page.close()
            browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
